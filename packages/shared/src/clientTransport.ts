/**
 * How a client reaches the engine: the bearer and a task attempt's headers on each request, JSON bodies and errors,
 * and the routes of a project's resources, with the older engines' fallback.
 */
import { requireSecureEngineUrl } from "./engineTransport.js";

/** A query string from the fields that are set. */
const query = (q: Record<string, unknown>) =>
  new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();

export const withQuery = (path: string, q: Record<string, unknown>) => {
  const qs = query(q);
  return qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
};

export const appendFields = (fd: FormData, fields: Record<string, string | undefined>) => {
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) fd.append(k, v);
};

export const isMissingRouteError = (err: unknown, predicate: (message: string) => boolean): boolean =>
  err instanceof ScarletApiError && err.status === 404 && err.code === "not_found" && predicate(err.message);

/** Route IDs are single opaque segments. URL parsers normalize even encoded dot segments. */
export function apiPathId(id: string): string {
  if (!id || id === "." || id === ".." || /[/\\?#%\u0000-\u001f\u007f]/.test(id)) {
    throw new Error("Invalid resource ID");
  }
  return encodeURIComponent(id);
}

export class ScarletApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ScarletApiError";
  }
}

export interface ClientOptions {
  baseUrl: string; // e.g. http://localhost:4000
  token?: string | (() => string | undefined);
  fetch?: typeof fetch;
  /** Let a client trace failures after the response headers arrive. */
  readResponse?: (response: Response) => Promise<string>;
  /** Allow editor thumbnails to sample a source's prepared preview. */
  previewFrames?: boolean;
}

/** A host snapshots this identity when it claims the task. Reconnecting must retain the original start. */
export interface TaskAttempt { taskId: string; startedAt?: string }
export const REQUEST_ID_HEADER = "X-Scarlet-Request-Id";

/** The native webview can use an origin where randomUUID is unavailable. */
export function newRequestId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}
export const TASK_HEADER = "X-Scarlet-Task";
export const ATTEMPT_HEADER = "X-Scarlet-Task-Started-At";

/** The connection to the engine that a client's routes go through. */
export class ClientTransport {
  protected readonly baseUrl: string;
  protected readonly tokenSource?: string | (() => string | undefined);
  protected readonly fetchImpl: typeof fetch;
  protected readonly readResponse: (response: Response) => Promise<string>;
  protected readonly previewFrames: boolean;

  private readonly projectScope?: string;

  constructor(opts: ClientOptions, projectId?: string, protected readonly attempt?: TaskAttempt) {
    this.projectScope = projectId === undefined ? undefined : apiPathId(projectId);
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    if (opts.token) requireSecureEngineUrl(this.baseUrl);
    this.tokenSource = opts.token;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.readResponse = opts.readResponse ?? (response => response.text());
    this.previewFrames = opts.previewFrames ?? false;
  }

  async withResource<T>(collection: "notes" | "media" | "changes" | "renders" | "tasks", id: string, request: (path: string) => Promise<T>): Promise<T> {
    const path = `/${collection}/${apiPathId(id)}`;
    if (!this.projectScope) return request(path);
    const project = `/projects/${this.projectScope}`;
    try {
      return await request(project + path);
    } catch (err) {
      // Standalone MCP can connect to an older engine. Only its explicit missing-route
      // response permits the legacy route, after checking the project's own listing.
      if (!isMissingRouteError(err, message =>
          ["GET", "POST", "PATCH"].some(method => message.startsWith(`no route for ${method} /api${project}${path}`)))) throw err;
    }
    const listed = await this.get<Record<string, { id: string }[]>>(`${project}/${collection}`);
    if (!listed[collection]?.some(row => row.id === id)) {
      throw new ScarletApiError(404, "project_resource_missing", "Resource not found in this project");
    }
    return request(path);
  }

  get token(): string | undefined {
    return typeof this.tokenSource === "function" ? this.tokenSource() : this.tokenSource;
  }

  url(path: string): string {
    return `${this.baseUrl}/api${path}`;
  }

  /** Absolute URL for a media/render file, with the token as a query param for <video src>. */
  fileUrl(path: string, params?: Record<string, unknown>): string {
    const t = this.token;
    return withQuery(`${this.url(path)}${t ? `?token=${encodeURIComponent(t)}` : ""}`, params ?? {});
  }

  wsUrl(): string {
    const http = new URL(this.baseUrl);
    http.protocol = http.protocol === "https:" ? "wss:" : "ws:";
    const t = this.token;
    return `${http.origin}/ws${t ? `?token=${encodeURIComponent(t)}` : ""}`;
  }

  async request<T>(method: string, path: string, body?: unknown, init: RequestInit = {},
    readBinary?: (data: ArrayBuffer) => T): Promise<T> {
    const headers: Record<string, string> = {};
    if (init.headers) new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
    const callerAuthorization = headers.authorization !== undefined;
    if (callerAuthorization) requireSecureEngineUrl(this.baseUrl);
    if (this.attempt) {
      headers[TASK_HEADER] = this.attempt.taskId;
      if (this.attempt.startedAt) headers[ATTEMPT_HEADER] = this.attempt.startedAt;
    }
    const t = this.token;
    if (t) {
      delete headers.authorization;
      headers.Authorization = `Bearer ${t}`;
    }
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      delete headers["content-type"];
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await this.fetchImpl(this.url(path), { ...init, method, headers, body: payload,
      ...((t || callerAuthorization) && { redirect: "error" }) });
    if (res.status === 204) return undefined as T;
    if (readBinary && res.ok && res.headers.get("Content-Type") === "application/octet-stream") {
      return readBinary(await res.arrayBuffer());
    }
    const text = await this.readResponse(res);
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // A reply that claims success without JSON (a proxy's page, another program on the port) reaches the caller as nothing.
      // Say so here, by route alone: the query and the reply can hold what the editor typed.
      if (res.ok) console.warn(`[scarlet] [api] ${method} ${path.split("?")[0]}: ${res.status} reply was not JSON`);
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
      throw new ScarletApiError(res.status, err?.code ?? "http_error", err?.message ?? (text || res.statusText), err?.details);
    }
    return json as T;
  }

  get<T>(path: string) {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body?: unknown) {
    return this.request<T>("POST", path, body);
  }
  patch<T>(path: string, body?: unknown) {
    return this.request<T>("PATCH", path, body);
  }
  put<T>(path: string, body?: unknown) {
    return this.request<T>("PUT", path, body);
  }
  delete<T>(path: string) {
    return this.request<T>("DELETE", path);
  }
}
