// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  engineStatus: vi.fn(),
  me: vi.fn(),
  connect: vi.fn(),
  exports: vi.fn(),
}));

vi.mock("../lib/desktop", () => ({ desktop: { engineStatus: fixture.engineStatus } }));
vi.mock("../lib/client", () => ({
  IS_MOCK: false,
  serverUrl: "http://127.0.0.1:4000",
  api: { token: "workspace-token", me: fixture.me, exports: fixture.exports },
  connectDesktopEngine: fixture.connect,
  errorMessage: String,
}));

import { startAppLog, stopAppLog } from "../lib/appLog";
import { useAuthStore } from "./auth";

const engine = { state: "ready", url: "http://127.0.0.1:5000", token: "engine-token" };
const user = { id: "local", name: "You", createdAt: "2026-10-30" };
const open = () => useAuthStore.getState().bootstrap();

beforeEach(() => {
  vi.resetAllMocks();
  fixture.engineStatus.mockResolvedValue(engine);
  fixture.me.mockResolvedValue({ user });
  fixture.exports.mockResolvedValue({ renders: [] });
  useAuthStore.setState({ status: "idle", user: null, error: null, failed: false });
});
afterEach(() => stopAppLog());

/** The log's lines from here on, with the clock taken off the front. */
function logged() {
  const lines: string[] = [], levels: string[] = [];
  startAppLog((batch, level) => { for (const line of batch) { lines.push(line.replace(/^(\[\w+\]) \S+ \S+ /, "$1 ")); levels.push(level); } });
  return { lines, levels };
}

it("reconnects to the local engine after a failed session check", async () => {
  fixture.me.mockRejectedValueOnce(new Error("engine restarting"));
  await open();
  expect(useAuthStore.getState().status).toBe("offline");
  await open();
  expect(fixture.connect).toHaveBeenCalledWith(engine.url, engine.token);
  expect(useAuthStore.getState()).toMatchObject({ status: "ready", user });
});

it("ignores a stale native response after a restart", async () => {
  let stopped!: (status: unknown) => void;
  fixture.engineStatus.mockReturnValueOnce(new Promise((resolve) => { stopped = resolve; }));
  const old = open();
  await open();
  stopped({ state: "stopped" });
  await old;
  expect(useAuthStore.getState().status).toBe("ready");
});

it("waits while the engine starts, says why it is away once, and connects when it is ready", async () => {
  const log = logged();
  fixture.engineStatus.mockResolvedValue({ state: "starting", url: null, error: null });
  await open();
  await open();
  expect(useAuthStore.getState()).toMatchObject({ status: "offline", error: "Error: Waiting for the local engine…" });
  expect(fixture.me).not.toHaveBeenCalled();
  fixture.engineStatus.mockResolvedValue({ state: "error", url: null, error: "The engine stopped: port in use" });
  await open();
  await open();
  expect(useAuthStore.getState().error).toBe("Error: The engine stopped: port in use");
  fixture.engineStatus.mockResolvedValue(engine);
  await open();
  expect(useAuthStore.getState()).toMatchObject({ status: "ready", user, error: null });
  stopAppLog();
  // A wait is not a failure. Each reason is written once, however often the window asks.
  expect(log.lines).toEqual([
    '[app] waiting error="Error: Waiting for the local engine…"',
    '[app] offline error="Error: The engine stopped: port in use"',
  ]);
  expect(log.levels).toEqual(["info", "warn"]);
});

it("tells an engine that can't start from one still starting or starting again", async () => {
  fixture.engineStatus.mockResolvedValue({ state: "starting", url: null, error: null });
  await open();
  expect(useAuthStore.getState()).toMatchObject({ status: "offline", failed: false });
  // No engine to run, or no workspace to run it in: the engine has given up, and the window can say so at once.
  fixture.engineStatus.mockResolvedValue({ state: "error", url: null, error: "scarlet-engine sidecar not found" });
  await open();
  expect(useAuthStore.getState()).toMatchObject({ status: "offline", failed: true, error: "Error: scarlet-engine sidecar not found" });
  // An engine that crashed is started again. Until it gives up, that is a wait.
  fixture.engineStatus.mockResolvedValue({ state: "starting", url: null, error: "engine exited with code 1" });
  await open();
  expect(useAuthStore.getState()).toMatchObject({ status: "offline", failed: false });
  fixture.engineStatus.mockResolvedValue({ state: "error", url: null, error: "Could not prepare the Scarlet workspace" });
  await open();
  expect(useAuthStore.getState().failed).toBe(true);
  fixture.engineStatus.mockResolvedValue(engine);
  await open();
  expect(useAuthStore.getState()).toMatchObject({ status: "ready", failed: false, error: null });
});

it("stays as it is when the same engine answers again, and reopens against a replacement", async () => {
  fixture.engineStatus.mockResolvedValue({ state: "ready", url: "http://127.0.0.1:4000", token: "workspace-token" });
  await open();
  expect(fixture.connect).toHaveBeenCalledTimes(1);
  // The engine the window already talks to: nothing to reconnect, and no second session check.
  await open();
  expect(fixture.connect).toHaveBeenCalledTimes(1);
  expect(fixture.me).toHaveBeenCalledTimes(1);
  // A new engine on another port: media and the socket reopen against it.
  const seen: string[] = [];
  const off = useAuthStore.subscribe(state => seen.push(state.status));
  fixture.engineStatus.mockResolvedValue(engine);
  await open();
  off();
  expect(seen).toEqual(["loading", "ready"]);
  expect(fixture.connect).toHaveBeenLastCalledWith(engine.url, engine.token);
});

it("logs it when the exports left over from the last session can't be picked up", async () => {
  // Earlier sessions in this file are still loading the exports' code: let them finish first.
  await import("../lib/exportJobs");
  await new Promise(done => setTimeout(done));
  const log = logged();
  fixture.exports.mockRejectedValue(new Error("engine restarting"));
  await open();
  await vi.waitFor(() => expect(log.lines).toEqual(['[error] resume-exports error="Error: engine restarting"']));
  expect(log.levels).toEqual(["warn"]);
  // The window is ready all the same.
  expect(useAuthStore.getState().status).toBe("ready");
});
