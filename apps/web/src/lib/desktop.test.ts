// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startAppLog, stopAppLog } from "./appLog";
import { desktop, isDesktop, markDesktop } from "./desktop";

const command = vi.hoisted(() => vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>());
vi.mock("@tauri-apps/api/core", () => ({ invoke: command }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

let lines: string[], levels: string[];
beforeEach(() => {
  vi.useFakeTimers();
  lines = [];
  levels = [];
  command.mockReset();
  startAppLog((batch, level) => { for (const line of batch) { lines.push(line.replace(/^(\[\w+\]) \S+ \S+ /, "$1 ")); levels.push(level); } });
});
afterEach(() => {
  stopAppLog();
  vi.useRealTimers();
});

it("passes a command to the desktop with its arguments and hands back the answer, leaving no line when it works", async () => {
  command.mockResolvedValue({ ticket: 7, path: "/Users/me/Movies/Cut.mp4" });
  await expect(desktop.chooseVideoExport("Cut.mp4")).resolves.toEqual({ ticket: 7, path: "/Users/me/Movies/Cut.mp4" });
  expect(command).toHaveBeenCalledExactlyOnceWith("choose_video_export", { fileName: "Cut.mp4" });
  vi.advanceTimersByTime(300);
  expect(lines).toEqual([]);
});

it("logs a command the desktop refused, as a warning, and still fails the caller", async () => {
  command.mockRejectedValue("This update is no longer ready. Scarlet will check again.");
  await expect(desktop.restartForUpdate("abc123")).rejects.toBe("This update is no longer ready. Scarlet will check again.");
  expect(lines).toEqual(['[error] desktop cmd=restart_for_update error="This update is no longer ready. Scarlet will check again."']);
  expect(levels).toEqual(["warn"]);
});

it("keeps what the window passed in, and any address, out of the failure's line", async () => {
  command.mockImplementation(async (cmd, args) => {
    if (cmd === "open_path") throw `Failed to open ${String(args?.path)}: no application`;
    if (cmd === "agent_login_code") throw new Error(`code ${String(args?.code)} was refused, see https://auth.example.com/authorize?state=sk-secret for a new one`);
    throw "x".repeat(500);
  });
  await desktop.openPath("/Users/me/Movies/My private film.mp4").catch(() => {});
  await desktop.agentLoginCode("claude", "pasted-secret-code").catch(() => {});
  await desktop.info().catch(() => {});
  expect(lines).toEqual([
    '[error] desktop cmd=open_path error="Failed to open …: no application"',
    '[error] desktop cmd=agent_login_code error="Error: code … was refused, see … for a new one"',
    `[error] desktop cmd=desktop_info error=${"x".repeat(200)}`,
  ]);
});

it("writes a status that keeps failing the same way once a minute, and again as soon as the reason changes or it recovers", async () => {
  command.mockRejectedValue("updater not running");
  const ask = () => desktop.updateStatus().catch(() => {});
  // Asked every five seconds for a minute: one line at the start and one as the minute comes round.
  for (let i = 0; i <= 12; i++) { await ask(); vi.advanceTimersByTime(5000); }
  expect(lines).toEqual(Array(2).fill('[error] desktop cmd=update_status error="updater not running"'));
  command.mockRejectedValue("updater busy");
  await ask();
  expect(lines.at(-1)).toBe('[error] desktop cmd=update_status error="updater busy"');
  // Another command's failure is its own line.
  await desktop.hostStatus().catch(() => {});
  expect(lines).toHaveLength(4);
  command.mockResolvedValueOnce({ ready: null, building: null });
  await ask();
  await ask();
  expect(lines).toHaveLength(5);
});

it("never logs a failure to write the log itself", async () => {
  command.mockRejectedValue("log file is gone");
  await expect(desktop.log("[ui] something")).resolves.toBeUndefined();
  expect(command).toHaveBeenCalledExactlyOnceWith("desktop_log", { level: "info", message: "[ui] something" });
  expect(lines).toEqual([]);
});

it("flushes a burst of UI log records with one native call and keeps their order", async () => {
  const { appLog } = await import("./appLog");
  startAppLog();
  for (let i = 0; i < 40; i++) appLog("playback", "seek", { frame: i });
  await vi.advanceTimersByTimeAsync(250);
  expect(command).toHaveBeenCalledExactlyOnceWith("desktop_log", { level: "info",
    message: Array.from({ length: 40 }, (_, i) => expect.stringMatching(new RegExp(` seek frame=${i}$`))) });
});

it("knows it is in the desktop app only when the shell is there, and marks the window for support", () => {
  expect(isDesktop()).toBe(false);
  markDesktop("http://127.0.0.1:5000");
  expect("__SCARLET_DESKTOP__" in window).toBe(false);
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  try {
    expect(isDesktop()).toBe(true);
    markDesktop("http://127.0.0.1:5000");
    expect((window as unknown as { __SCARLET_DESKTOP__: { url: string } }).__SCARLET_DESKTOP__.url).toBe("http://127.0.0.1:5000");
  } finally {
    vi.unstubAllGlobals();
  }
});
