import { newRequestId, REQUEST_ID_HEADER, ScarletClient, ScarletApiError } from "@scarlet/shared";
import type { ScarletApi } from "./api";
import { MockClient } from "./mock/MockClient";
import { isDesktop, markDesktop } from "./desktop";
import { appLog, errorName, logPath, withoutAddresses } from "./appLog";

export const IS_DESKTOP = isDesktop();
export const IS_MOCK = import.meta.env.DEV && import.meta.env.MODE === "desktop-demo" && IS_DESKTOP;
export let serverUrl = window.location.origin;

let mockInstance: MockClient | null = null;
export function mockClient(): MockClient | null {
  return mockInstance;
}

/** A read this slow held something on screen back. */
const SLOW_CALL_MS = 1000;

/**
 * What the editor reads when the window can't reach the engine, as while it restarts or Scarlet quits. The webview's
 * own words for that ("Load failed", "Failed to fetch") name no cause, and an engine shutting down answers with none.
 */
const ENGINE_UNREACHABLE = "Scarlet can’t reach its engine right now.";

/** A request that never got an answer, in the words each webview (and Node) uses for it. */
const unanswered = (err: unknown) => err instanceof TypeError &&
  /^(Load failed|Failed to fetch|NetworkError when attempting to fetch resource\.?|The network connection was lost\.|Could not connect to the server\.|fetch failed)$/.test(err.message);

/** The desktop connection was lost, or the engine stopped accepting requests during shutdown. */
export function engineUnavailable(error: unknown): boolean {
  return error instanceof TypeError && (error.message === ENGINE_UNREACHABLE || unanswered(error))
    || error instanceof ScarletApiError && error.status === 503 && error.code === "http_error";
}

type RequestLog = { method: string; path: string; request: string; started: number; signal?: AbortSignal | null };
const responseRequests = new WeakMap<Response, RequestLog>();
const elapsed = (started: number) => Math.round(performance.now() - started);

/** Record failures in body consumers, which run after fetch has returned the headers. */
export async function readLoggedBody<T>(response: Response, read: () => Promise<T>): Promise<T> {
  const trace = responseRequests.get(response);
  const fields = trace && {
    method: trace.method, path: trace.path, request: trace.request, status: response.status,
  };
  let body: T;
  try {
    body = await read();
  } catch (error) {
    if (trace) {
      const name = errorName(error);
      const stopped = trace.signal?.aborted || name === "AbortError";
      appLog("api", stopped ? "stopped" : "body-failed", { ...fields, ms: elapsed(trace.started), phase: "body", name }, { level: stopped ? "info" : "warn" });
    }
    throw error;
  }
  if (trace && !response.ok) {
    let json: unknown = body;
    if (typeof body === "string" && body.length <= 65536) {
      try { json = JSON.parse(body); } catch { /* The HTTP status is already logged. */ }
    }
    const code = (json as { error?: { code?: unknown } } | null)?.error?.code;
    if (typeof code === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(code)) {
      appLog("api", "error-code", { ...fields, ms: elapsed(trace.started), code }, { level: "warn" });
    }
  }
  return body;
}

/** Writes the engine makes in the course of playback, logged like reads: only when slow or failed. */
const ROUTINE_WRITE = /\/renders(\?|$)/;

/** Changes, failures and slow reads, with an ID the engine can log alongside the same request. */
export const loggedFetch: typeof fetch = async (input, init) => {
  const original = input instanceof Request ? input : undefined;
  const method = (init?.method ?? original?.method ?? "GET").toUpperCase();
  const path = logPath(original?.url ?? String(input));
  const request = newRequestId();
  const started = performance.now();
  const signal = init?.signal ?? original?.signal;
  const headers = new Headers(init?.headers ?? original?.headers);
  headers.set(REQUEST_ID_HEADER, request);
  const fields = { method, path, request };
  const routine = method === "GET" || method === "HEAD" || ROUTINE_WRITE.test(path);
  let response: Response;
  try {
    response = await fetch(input, { ...init, headers });
  } catch (error) {
    const name = errorName(error);
    const stopped = signal?.aborted || name === "AbortError";
    // A seek drops the playback section it no longer needs: nothing went wrong.
    if (!(stopped && routine)) appLog("api", stopped ? "stopped" : "unreachable", { ...fields, ms: elapsed(started), name,
      error: stopped ? undefined : withoutAddresses(String(error)) }, { level: stopped ? "info" : "warn" });
    // Still a TypeError, as a failed fetch is, in words the editor can read wherever it shows.
    throw stopped || !unanswered(error) ? error : new TypeError(ENGINE_UNREACHABLE, { cause: error });
  }
  responseRequests.set(response, { ...fields, started, signal });
  const status = response.status, ms = elapsed(started);
  if (!response.ok) {
    appLog("api", "failed", { ...fields, status, ms }, { level: "warn" });
  } else if (!routine) {
    appLog("api", "did", { ...fields, status, ms, phase: "headers" });
  } else if (ms >= SLOW_CALL_MS) {
    appLog("api", "slow", { ...fields, status, ms, phase: "headers" });
  }
  return response;
};

const clientTransport = {
  fetch: loggedFetch,
  readResponse: (response: Response) => readLoggedBody(response, () => response.text()),
};

export let api: ScarletApi = IS_MOCK
  ? (mockInstance = new MockClient(() => "mock-token", true))
  : new ScarletClient({ baseUrl: serverUrl, previewFrames: true, ...clientTransport });

export function connectDesktopEngine(url: string, token: string) {
  serverUrl = url;
  api = new ScarletClient({ baseUrl: url, token, previewFrames: true, ...clientTransport });
  markDesktop(url);
}

/**
 * What the editor reads when a request failed and the engine gave no reason of its own: a status line ("Internal
 * Server Error"), a page that isn't the engine's, or nothing. The request, its status and its code are in the app log.
 */
export const UNEXPLAINED = "That didn’t work. Try again.";

/** Normalise any thrown value into a user-facing message. */
export function errorMessage(err: unknown): string {
  // A 503 with nothing in it is the engine turning requests away as it shuts down. Its own refusals carry a reason.
  if (err instanceof ScarletApiError) return err.code === "http_error" ? err.status === 503 ? ENGINE_UNREACHABLE : UNEXPLAINED : err.message || UNEXPLAINED;
  if (unanswered(err)) return ENGINE_UNREACHABLE;
  if (err instanceof Error) return err.message;
  return String(err);
}
