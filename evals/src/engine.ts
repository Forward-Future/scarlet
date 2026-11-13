/**
 * A small client for the local Scarlet engine. Reads are used everywhere; the only writes
 * (branch switch, task creation, cancel) live behind run.ts's explicit --yes.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { requireSecureEngineUrl } from "../../packages/shared/src/engineTransport.ts";
import type { Change, MediaAsset, Project, Timeline, TimeRange } from "../../packages/timeline/src/index.ts";
import type { Task } from "../../packages/shared/src/api.ts";
import type { EventLike, TaskLike } from "./metrics.ts";
import { appSupportDir } from "./paths.ts";

export interface TaskRecord extends TaskLike {
  projectId: string;
  kind: string;
  instruction: string;
  context: Task["context"];
  changeIds: string[];
  question?: string | null;
  createdBy?: { type: string; name: string };
}

export class EngineError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) { super(message); }
}

export interface EngineOptions { url?: string; token?: string }

export class Engine {
  constructor(readonly url: string, private readonly token: string) { requireSecureEngineUrl(url); }

  static async connect(opts: EngineOptions = {}): Promise<Engine> {
    const url = opts.url ?? process.env.SCARLET_ENGINE_URL;
    const token = opts.token ?? process.env.SCARLET_ACCESS_TOKEN;
    if (!!url !== !!token) throw new Error("An engine override requires both its URL and its own SCARLET_ACCESS_TOKEN.");
    if (opts.url && !opts.token && process.env.SCARLET_ENGINE_URL) {
      const destination = (value: string) => requireSecureEngineUrl(value).href.replace(/\/+$/, "");
      if (destination(opts.url) !== destination(process.env.SCARLET_ENGINE_URL)) {
        throw new Error("The configured evaluation token belongs to a different engine. Set its URL and token together.");
      }
    }
    const engine = url && token ? new Engine(url.replace(/\/+$/, ""), token) : desktopSession();
    const health = await fetch(engine.url + "/health", { redirect: "error" }).catch(() => undefined);
    if (!health?.ok) throw new Error(`No Scarlet engine answered at ${engine.url}. Start Scarlet or configure the engine URL and credential together.`);
    return engine;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.url + "/api" + path, {
      method,
      redirect: "error",
      headers: { Authorization: `Bearer ${this.token}`, ...(body !== undefined && { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const error = (json as { error?: { code?: string; message?: string } }).error;
      throw new EngineError(res.status, error?.code, `${method} ${path}: ${res.status} ${error?.message ?? text.slice(0, 200)}`);
    }
    return json as T;
  }
  get<T>(path: string) { return this.request<T>("GET", path); }
  post<T>(path: string, body?: unknown) { return this.request<T>("POST", path, body ?? {}); }

  // -- reads ----------------------------------------------------------------
  project(id: string) { return this.get<{ project: Project }>(`/projects/${enc(id)}`).then(r => r.project); }
  media(projectId: string) { return this.get<{ media: MediaAsset[] }>(`/projects/${enc(projectId)}/media`).then(r => r.media); }
  timeline(projectId: string, version: string) {
    return this.get<{ timeline: Timeline }>(`/projects/${enc(projectId)}/timeline?version=${enc(version)}`).then(r => r.timeline);
  }
  branches(projectId: string) { return this.get<{ branches: Array<{ name: string; head: string }> }>(`/projects/${enc(projectId)}/branches`).then(r => r.branches); }
  task(taskId: string) { return this.get<{ task: TaskRecord; events: EventLike[] }>(`/tasks/${enc(taskId)}`); }
  /** Token totals for one task (every run, including pauses for questions). Null on engines without usage tracking. */
  async taskUsage(projectId: string, taskId: string): Promise<Record<string, number> | null> {
    try {
      const res = await this.get<{ groups: Array<{ key: string | null } & Record<string, unknown>> }>(`/projects/${enc(projectId)}/usage?by=task`);
      const group = res.groups.find(g => g.key === taskId);
      if (!group) return null;
      return Object.fromEntries(Object.entries(group).filter((e): e is [string, number] => typeof e[1] === "number"));
    } catch { return null; }
  }
  tasks(projectId: string, state?: string) {
    return this.get<{ tasks: TaskRecord[] }>(`/projects/${enc(projectId)}/tasks${state ? `?state=${enc(state)}` : ""}`).then(r => r.tasks);
  }
  change(changeId: string) { return this.get<{ change: Change }>(`/changes/${enc(changeId)}?view=record`).then(r => r.change); }
  skills() { return this.get<{ skills: Array<{ id: string; name: string; version?: number }> }>(`/skills`).then(r => r.skills); }
  async transcript(mediaId: string) {
    try {
      return await this.get<{ segments: Array<{ words?: Array<{ text: string; start: number; end: number }> }> }>(`/media/${enc(mediaId)}/transcript`);
    } catch (err) {
      if (err instanceof EngineError && err.status === 404) return undefined;
      throw err;
    }
  }
  /** Read the prepared waveform only; never starts extraction. */
  waveform(mediaId: string, from: number, to: number, points: number) {
    return this.get<{ from: number; to: number; peaks: number[]; rms: number[] }>(
      `/media/${enc(mediaId)}/waveform?from=${from}&to=${to}&points=${points}&cachedOnly=1`);
  }
  /** Saved dialogue-scan windows for the engine's current detector settings. */
  checkpoints(projectId: string, mediaId: string, from: number, to: number) {
    return this.post<TimeRange[]>(`/projects/${enc(projectId)}/dialogue-checkpoints`, { mediaId, from, to });
  }
  /** Only call for a window listed by checkpoints(): an unsaved window would start transcription. */
  savedDetections(projectId: string, mediaId: string, from: number, to: number) {
    return this.post<unknown>(`/projects/${enc(projectId)}/dialogue-detections`, { mediaId, from, to });
  }
  async reviewDecisions(projectId: string, taskId?: string) {
    try {
      return await this.get<ReviewDecisionExport>(`/projects/${enc(projectId)}/review-decisions${taskId ? `?taskId=${enc(taskId)}` : ""}`);
    } catch (err) {
      if (err instanceof EngineError && err.status === 404 && err.code === "not_found" && /no route/.test(err.message)) return undefined;
      throw err;
    }
  }

  // -- writes (runner only) ---------------------------------------------------
  switchBranch(projectId: string, body: { name: string; from?: string; expectedHead: string; expectedBranch: string }) {
    return this.post<{ project: Project }>(`/projects/${enc(projectId)}/branches`, body).then(r => r.project);
  }
  createTask(projectId: string, body: Record<string, unknown>) {
    return this.post<{ task: TaskRecord }>(`/projects/${enc(projectId)}/tasks`, body).then(r => r.task);
  }
  cancelTask(taskId: string) { return this.post<{ task: TaskRecord }>(`/tasks/${enc(taskId)}/cancel`); }
}

/** The engine's /review-decisions export (apps/server/src/routes/evalExport.ts), also computed locally for older engines. */
export interface ReviewDecisionExport {
  projectId: string;
  changes: ReviewChangeExport[];
}
export interface ReviewChangeExport {
  id: string;
  taskId?: string;
  intent?: string;
  state: string;
  fromVersion: string;
  toVersion: string;
  appliedVersion?: string;
  restoredCuts?: number[];
  decidedBy?: { type: string; name: string };
  updatedAt?: string;
  firstCut: boolean;
  cuts: ReviewCutExport[];
}
export type EditorDecision = "approved" | "skipped" | "pending" | "unknown";
export interface ReviewCutExport {
  index: number;
  /** Timeline seconds on the review's original version. */
  removed: TimeRange;
  sources: Array<TimeRange & { mediaId: string }>;
  reasons: string[];
  assessment?: { verdict: "cut" | "keep" | "ask"; reason: string; inspected?: boolean };
  decision: EditorDecision;
}

const enc = encodeURIComponent;

function desktopSession(): Engine {
  const path = join(appSupportDir(), "data", "desktop-session.json");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 1024 || info.nlink !== 1 ||
        (process.platform !== "win32" && ((info.mode & 0o077) || info.uid !== process.getuid?.()))) {
      throw new Error("Invalid private Scarlet desktop session file");
    }
    const { port, token } = JSON.parse(readFileSync(fd, "utf8"));
    if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== "string" || !/^sct_[a-f0-9]{64}$/.test(token)) {
      throw new Error("Invalid Scarlet desktop session");
    }
    return new Engine(`http://127.0.0.1:${port}`, token);
  } finally { closeSync(fd); }
}
