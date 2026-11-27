// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startAppLog, stopAppLog } from "./appLog";
import { desktop } from "./desktop";

const eventListen = vi.hoisted(() => vi.fn());
const dragDrop = vi.hoisted(() => vi.fn());
const command = vi.hoisted(() => vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>());
vi.mock("@tauri-apps/api/core", () => ({ invoke: command }));
vi.mock("@tauri-apps/api/event", () => ({ listen: eventListen }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onDragDropEvent: dragDrop }) }));

let lines: string[];
beforeEach(() => {
  vi.useFakeTimers();
  lines = [];
  command.mockReset();
  command.mockResolvedValue("answer");
  eventListen.mockReset();
  dragDrop.mockReset();
  startAppLog(batch => { for (const line of batch) lines.push(line.replace(/^(\[\w+\]) \S+ \S+ /, "$1 ")); });
});
afterEach(() => {
  stopAppLog();
  vi.useRealTimers();
});

it("names each command and passes its arguments as the desktop expects them", async () => {
  const report = { description: "The export froze", about: "Export failed", page: "editor", onScreen: ["Export failed"] };
  const pick = { agent: "codex", model: "gpt-5", effort: "high" } as const;
  const calls: [Promise<unknown>, string, Record<string, unknown> | undefined][] = [
    [desktop.measureProjectStorage([{ id: "prj_1", segments: [] } as never]), "measure_project_storage", { projects: [{ id: "prj_1", segments: [] }] }],
    [desktop.developerStorage(), "developer_storage", undefined],
    [desktop.engineStatus(), "engine_status", undefined],
    [desktop.hostStatus(), "host_status", undefined],
    [desktop.hostRefreshAgents(), "host_refresh_agents", undefined],
    [desktop.hostRefreshQuota(), "host_refresh_quota", { force: false }],
    [desktop.hostRefreshQuota(true), "host_refresh_quota", { force: true }],
    [desktop.providerSettings(), "provider_settings", undefined],
    [desktop.saveProviderSettings({ provider: "ollama", url: null, disabled: true }), "save_provider_settings", { provider: "ollama", url: null, disabled: true }],
    [desktop.agentInstall("gemini"), "agent_install", { agent: "gemini" }],
    [desktop.agentUpdate("claude"), "agent_update", { agent: "claude" }],
    [desktop.ffmpegStatus(), "ffmpeg_status", undefined],
    [desktop.ffmpegInstall(), "ffmpeg_install", undefined],
    [desktop.agentLoginStart("claude"), "agent_login_start", { agent: "claude" }],
    [desktop.agentLoginCancel("claude"), "agent_login_cancel", { agent: "claude" }],
    [desktop.agentLoginStatus("gemini"), "agent_login_status", { agent: "gemini" }],
    [desktop.openUrl("https://scarlet.example/help"), "open_url", { url: "https://scarlet.example/help" }],
    [desktop.keepVideoExport(3), "keep_video_export", { ticket: 3 }],
    [desktop.discardVideoExport(3), "discard_video_export", { ticket: 3 }],
    [desktop.finishVideoExport(3, "/render/out.mp4"), "finish_video_export", { ticket: 3, url: "/render/out.mp4" }],
    [desktop.finishFolderExport(4, []), "finish_folder_export", { ticket: 4, files: [] }],
    [desktop.revealPath("/Users/me/Movies"), "reveal_path", { path: "/Users/me/Movies" }],
    [desktop.exportLogs(), "export_logs", undefined],
    [desktop.sendProblemReport(report), "send_problem_report", { report }],
    [desktop.sendProblemDetails({ reportId: "rep_1", description: "More" }), "send_problem_details", { details: { reportId: "rep_1", description: "More" } }],
    [desktop.saveProblemReport(report), "save_problem_report", { report }],
    [desktop.pickFile("Choose a model"), "plugin:dialog|open", { options: { title: "Choose a model", multiple: false, directory: false } }],
    [desktop.pickFolder("Choose a folder"), "plugin:dialog|open", { options: { title: "Choose a folder", directory: true, multiple: false } }],
    [desktop.installCrisperModel("/models"), "install_crisper_model", { directory: "/models" }],
    [desktop.pickFiles(), "pick_files", undefined],
    [desktop.saveEditorModel(pick), "save_editor_model", { selection: pick }],
    [desktop.checkForRelease(), "check_for_release", undefined],
    [desktop.latestUpdateRevision(), "latest_update_revision", undefined],
    [desktop.updateChangelog("abc"), "update_changelog", { revision: "abc" }],
    [desktop.log(["[ui] a", "[ui] b"], "error"), "desktop_log", { level: "error", message: ["[ui] a", "[ui] b"] }],
  ];
  const answers = await Promise.all(calls.map(([call]) => call));
  expect(answers.every(a => a === "answer")).toBe(true);
  expect(command.mock.calls).toEqual(calls.map(([, cmd, args]) => [cmd, args]));
});

it("hands each desktop event's payload to its listener, and a menu press with nothing", async () => {
  const unlisten = vi.fn();
  const handlers = new Map<string, (e: { payload: unknown }) => void>();
  eventListen.mockImplementation(async (event: string, handler: (e: { payload: unknown }) => void) => { handlers.set(event, handler); return unlisten; });
  const engine = vi.fn(), login = vi.fn(), host = vi.fn(), report = vi.fn();
  await expect(desktop.onEngineStatus(engine)).resolves.toBe(unlisten);
  await desktop.onAgentLogin(login);
  await desktop.onHostStatus(host);
  await desktop.onReportProblem(report);
  expect([...handlers.keys()]).toEqual(["engine://status", "agent-login://status", "host://status", "report-problem://open"]);
  handlers.get("engine://status")!({ payload: { state: "ready" } });
  handlers.get("agent-login://status")!({ payload: { agent: "claude", state: "done" } });
  handlers.get("host://status")!({ payload: { connected: true } });
  handlers.get("report-problem://open")!({ payload: "ignored" });
  expect(engine).toHaveBeenCalledWith({ state: "ready" });
  expect(login).toHaveBeenCalledWith({ agent: "claude", state: "done" });
  expect(host).toHaveBeenCalledWith({ connected: true });
  expect(report).toHaveBeenCalledWith();
});

it("hands files dropped on the window to the listener, and records a drop listener that couldn't register", async () => {
  const unlisten = vi.fn();
  let handler!: (e: { payload: unknown }) => void;
  dragDrop.mockImplementation(async (cb: typeof handler) => { handler = cb; return unlisten; });
  const dropped = vi.fn();
  await expect(desktop.onDropFiles(dropped)).resolves.toBe(unlisten);
  handler({ payload: { type: "drop", paths: ["/a.mov"] } });
  expect(dropped).toHaveBeenCalledWith({ type: "drop", paths: ["/a.mov"] });

  dragDrop.mockRejectedValueOnce(new Error("no window"));
  await expect(desktop.onDropFiles(dropped)).rejects.toThrow("no window");
  expect(lines).toEqual(['[error] desktop-listen event=file-drop name=Error error="Error: no window"']);
});

it("writes the log at info unless told otherwise", async () => {
  await desktop.log("[ui] hello");
  expect(command).toHaveBeenCalledExactlyOnceWith("desktop_log", { level: "info", message: "[ui] hello" });
});

it("leaves an empty argument in the failure's line, since it can't hide anything", async () => {
  command.mockRejectedValue("nothing to open at ");
  await desktop.openPath("").catch(() => {});
  expect(lines).toEqual(['[error] desktop cmd=open_path error="nothing to open at "']);
});
