/**
 * Desktop bridge. When the UI runs inside the Scarlet desktop app (Tauri 2)
 * this module talks to the Rust side: where the API lives (the bundled engine on
 * a random loopback port), the engine/agent-host status, and
 * a few native helpers. The renderer checks this bridge before loading the editor.
 */
import type { AgentAvailability } from "@scarlet/shared";
import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import { appLog, withoutAddresses } from "./appLog";

export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface EngineStatus {
  url: string | null;
  token?: string;
  userId: string | null;
  state: "starting" | "ready" | "error" | "stopped";
  error: string | null;
  dataDir: string;
  workDir: string;
  logDir: string;
  engine: string | null;
  engineKind: string | null;
  pid: number | null;
  restarts: number;
  version: string;
}

export interface HostStatus {
  hostId: string | null;
  agents: AgentAvailability[];
  running: string[];
  connected: boolean;
  serverUrl: string | null;
  name: string | null;
  error: string | null;
  mcpCommand: string | null;
  configured: boolean;
}

export interface DesktopInfo {
  localUpdates?: boolean;
  customOpenaiModels?: string[];
  customClaudeModels?: string[];
  version: string;
  platform: string;
  arch: string;
  configFile: string;
  dataDir: string;
  workDir: string;
  logDir: string;
}

/** One-click CLI sign-in progress (`agent-login://status`). */
export interface AgentLoginStatus {
  agent: string;
  state: "waiting" | "done" | "failed" | "cancelled";
  /** Sign-in page, in case the browser didn't open on its own. */
  url?: string;
  /** The CLI accepts a pasted authorization code (Claude's manual fallback). */
  acceptsCode: boolean;
  message?: string;
}

type Unlisten = () => void;

/** The same failure of the same command is one line a minute: a status asked for every few seconds can fail all day. */
const REPEAT_MS = 60_000;
const failures = new Map<string, { reason: string; at: number }>();

/**
 * Why a command failed, as the desktop said it, without anything the window passed in (a path, a link, a pasted
 * code) and without any address: those can hold the editor's own words or a sign-in.
 */
function failureReason(error: unknown, args?: Record<string, unknown>) {
  let reason = String(error);
  for (const value of Object.values(args ?? {})) if (typeof value === "string" && value) reason = reason.split(value).join("…");
  return withoutAddresses(reason).slice(0, 200);
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    const result = await nativeInvoke<T>(cmd, args);
    failures.delete(cmd);
    return result;
  } catch (error) {
    // Most callers show a failed command as nothing happening. The log's own command can't report itself.
    if (cmd !== "desktop_log") {
      const reason = failureReason(error, args), now = Date.now(), last = failures.get(cmd);
      if (last?.reason !== reason || now - last.at >= REPEAT_MS) {
        failures.set(cmd, { reason, at: now });
        appLog("error", "desktop", { cmd, error: reason }, { level: "warn" });
      }
    }
    throw error;
  }
}

export interface StorageSize { bytes: number; files: number; estimated: boolean }
export interface DeveloperStorage extends StorageSize { kind: "cargo" | "scratch"; path: string }

/**
 * A build the updater has under way. `done` and `step` are shares of the whole build: what finished before the current
 * part began, and that part's own share, expected to take `stepSeconds` from `stepStarted` (seconds since 1970).
 */
export interface UpdateBuild { revision: string; done: number; step: number; stepStarted: number; stepSeconds: number }
export interface UpdateStatus { ready: string | null; building: UpdateBuild | null }

export const desktop = {
  async onDropFiles(cb: (event: import("@tauri-apps/api/webview").DragDropEvent) => void): Promise<Unlisten> {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().onDragDropEvent(event => cb(event.payload));
  },
  measureProjectStorage: (projects: Pick<import("@scarlet/shared").StorageProject, "id" | "deletedAt" | "segments">[]) =>
    invoke<Record<string, StorageSize>>("measure_project_storage", { projects }),
  developerStorage: () => invoke<DeveloperStorage[]>("developer_storage"),
  engineStatus: () => invoke<EngineStatus>("engine_status"),
  hostStatus: () => invoke<HostStatus>("host_status"),
  hostRefreshAgents: () => invoke<HostStatus>("host_refresh_agents"),
  agentInstall: (agent: "claude" | "codex") => invoke<"installed" | "needsNode">("agent_install", { agent }),
  agentLoginStart: (agent: string) => invoke<AgentLoginStatus>("agent_login_start", { agent }),
  agentLoginCode: (agent: string, code: string) => invoke<void>("agent_login_code", { agent, code }),
  agentLoginCancel: (agent: string) => invoke<void>("agent_login_cancel", { agent }),
  agentLoginStatus: (agent: string) => invoke<AgentLoginStatus | null>("agent_login_status", { agent }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  /** Native Save dialog. The ticket lets the app write only the file the user picked. Null when cancelled. */
  chooseVideoExport: (fileName: string) => invoke<{ ticket: number; path: string } | null>("choose_video_export", { fileName }),
  /** Remember a chosen destination across a restart, until the export is saved or discarded. */
  keepVideoExport: (ticket: number) => invoke<void>("keep_video_export", { ticket }),
  discardVideoExport: (ticket: number) => invoke<void>("discard_video_export", { ticket }),
  finishVideoExport: (ticket: number, url: string) => invoke<string>("finish_video_export", { ticket, url }),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  /** Save the logs and a system report as one .zip the editor picks a place for. Null when cancelled. */
  exportLogs: () => invoke<string | null>("export_logs"),
  pickFile: (title: string) => invoke<string | null>("plugin:dialog|open", { options: { title, multiple: false, directory: false } }),
  pickFolder: (title: string) => invoke<string | null>("plugin:dialog|open", { options: { title, directory: true, multiple: false } }),
  installCrisperModel: (directory: string) => invoke<void>("install_crisper_model", { directory }),
  pickFiles: () => invoke<string[]>("pick_files"),
  info: () => invoke<DesktopInfo>("desktop_info"),
  /** A verified build that installs on restart, and the build the updater has under way. */
  updateStatus: () => invoke<UpdateStatus>("update_status"),
  latestUpdateRevision: () => invoke<string>("latest_update_revision"),
  restartForUpdate: (revision: string) => invoke<void>("restart_for_update", { revision }),
  log: (message: string | string[], level: "info" | "warn" | "error" | "debug" = "info") => invoke<void>("desktop_log", { level, message }).catch(() => undefined),

  async onEngineStatus(cb: (s: EngineStatus) => void): Promise<Unlisten> {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<EngineStatus>("engine://status", (e) => cb(e.payload));
  },
  async onAgentLogin(cb: (s: AgentLoginStatus) => void): Promise<Unlisten> {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<AgentLoginStatus>("agent-login://status", (e) => cb(e.payload));
  },
  async onHostStatus(cb: (s: HostStatus) => void): Promise<Unlisten> {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<HostStatus>("host://status", (e) => cb(e.payload));
  },
};

/** Set on window so support/verification can tell the desktop shell is active. */
export function markDesktop(url: string) {
  if (!isDesktop()) return;
  (window as unknown as { __SCARLET_DESKTOP__?: unknown }).__SCARLET_DESKTOP__ = { url, at: new Date().toISOString() };
}
