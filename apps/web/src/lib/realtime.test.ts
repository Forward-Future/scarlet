// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildDb, PRJ } from "./mock/fixtures";
import { api } from "./client";
import { useHostsStore } from "../stores/hosts";
import { useProjectStore } from "../stores/project";
import { useSkillsStore } from "../stores/skills";
import { useUiStore } from "../stores/ui";
import { startAppLog, stopAppLog } from "./appLog";
import { dispatchWsEvent, leaveProject, reconnectRealtime, startRealtime, subscribeProject } from "./realtime";
import { importLocalFile } from "./upload";

/** A socket the test opens and drops by hand. */
class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: (e: { code: number; reason: string; wasClean: boolean }) => void;
  onerror?: () => void;
  onmessage?: (e: { data: string }) => void;
  sent: unknown[] = [];
  constructor(readonly url: string) { FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  hear(message: unknown) { this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) }); }
  close() { this.drop(); }
  open() { this.readyState = 1; this.onopen?.(); }
  drop() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code: 1006, reason: "", wasClean: false }); }
}
const status = () => useUiStore.getState().wsStatus;
const latest = () => FakeSocket.all.at(-1)!;
let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  stop?.();
  stop = undefined;
  stopAppLog();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("says reconnecting through the waits between tries, and offline only after it has failed for a while", () => {
  stop = startRealtime();
  latest().open();
  expect(status()).toBe("open");
  // The engine goes away. Scarlet is already set to try again, so the wait reads as reconnecting, not offline.
  latest().drop();
  expect(status()).toBe("connecting");
  for (let failed = 1; failed < 4; failed++) {
    vi.advanceTimersByTime(40_000);
    expect(FakeSocket.all).toHaveLength(failed + 1);
    expect(status()).toBe("connecting");
    latest().drop();
    expect(status()).toBe("connecting");
  }
  // About fifteen seconds of failures: now it says offline, and a new try doesn't blink back to reconnecting.
  vi.advanceTimersByTime(40_000);
  latest().drop();
  expect(status()).toBe("closed");
  vi.advanceTimersByTime(40_000);
  expect(FakeSocket.all).toHaveLength(6);
  expect(status()).toBe("closed");
  latest().open();
  expect(status()).toBe("open");
});

it("connects at once when the engine says it is back, instead of waiting out the backoff", () => {
  stop = startRealtime();
  latest().open();
  latest().drop();
  for (let i = 0; i < 5; i++) { vi.advanceTimersByTime(40_000); latest().drop(); }
  const before = FakeSocket.all.length;
  // The next try is up to half a minute away. The engine reports ready: no wait.
  reconnectRealtime();
  expect(FakeSocket.all).toHaveLength(before + 1);
  latest().open();
  expect(status()).toBe("open");
  // With a live socket there is nothing to do.
  reconnectRealtime();
  expect(FakeSocket.all).toHaveLength(before + 1);
});

/** The log's lines, with the clock taken off the front. */
function logged() {
  const lines: string[] = [], levels: string[] = [];
  startAppLog((batch, level) => { for (const line of batch) { lines.push(line.replace(/^(\[\w+\]) \S+ \S+ /, "$1 ")); levels.push(level); } });
  return { lines, levels, written: () => { vi.advanceTimersByTime(300); return lines; } };
}

it("writes a run's stream of steps as one line with a count, and none of what a step said", () => {
  const log = logged();
  const step = (taskId: string, id: string) => dispatchWsEvent({ type: "task.event", projectId: "prj_1", taskId, event: { id, type: "log", text: "the words of the cut" } });
  step("tsk_1", "evt_1");
  step("tsk_1", "evt_2");
  step("tsk_1", "evt_3");
  step("tsk_2", "evt_4");
  expect(log.written()).toEqual([
    "[realtime] task.event project=prj_1 task=tsk_1 event=evt_3 x3",
    "[realtime] task.event project=prj_1 task=tsk_2 event=evt_4",
  ]);
});

it("logs the connection coming up, dropping and coming back, with how many tries it took", () => {
  const log = logged();
  stop = startRealtime();
  latest().open();
  latest().drop();
  vi.advanceTimersByTime(40_000);
  latest().drop();
  vi.advanceTimersByTime(40_000);
  latest().open();
  expect(log.written()).toEqual([
    "[realtime] connected",
    "[realtime] disconnected code=1006 clean=false",
    "[realtime] disconnected code=1006 clean=false",
    '[realtime] connected after="2 tries"',
  ]);
  expect(log.levels).toEqual(["info", "warn", "warn", "info"]);
  // Stopping on purpose is not a dropped connection.
  log.lines.length = 0;
  stop();
  stop = undefined;
  expect(log.written()).toEqual([]);
  expect(status()).toBe("closed");
});

it("starts over as reconnecting after it was stopped while offline", () => {
  const log = logged();
  stop = startRealtime();
  latest().open();
  latest().drop();
  for (let i = 0; i < 5; i++) { vi.advanceTimersByTime(40_000); latest().drop(); }
  expect(status()).toBe("closed");
  stop();
  // The engine was replaced and the window connects to the new one: a fresh start, not five tries in.
  stop = startRealtime();
  expect(status()).toBe("connecting");
  log.written();
  log.lines.length = 0;
  latest().open();
  expect(log.written()).toEqual(["[realtime] connected"]);
});

it("tries again when a socket can't even be made, and gives up trying once stopped", () => {
  stop = startRealtime();
  latest().open();
  vi.stubGlobal("WebSocket", Object.assign(function () { throw new Error("blocked"); }, { OPEN: 1 }));
  latest().drop();
  vi.advanceTimersByTime(2000);
  // The try threw. It still reads as reconnecting, and another try is on its way.
  expect(status()).toBe("connecting");
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.advanceTimersByTime(4000);
  expect(FakeSocket.all).toHaveLength(2);
  stop();
  stop = undefined;
  vi.advanceTimersByTime(120_000);
  expect(FakeSocket.all).toHaveLength(2);
});

it("pings the engine while connected, and stops when the connection drops", () => {
  stop = startRealtime();
  latest().open();
  vi.advanceTimersByTime(50_000);
  expect(latest().sent).toEqual([{ type: "ping" }, { type: "ping" }]);
  const first = latest();
  first.drop();
  vi.advanceTimersByTime(25_000);
  expect(first.sent).toHaveLength(2);
});

it("holds a project's first read until the engine confirms it is listening, or a second has passed", async () => {
  const log = logged();
  vi.spyOn(useProjectStore.getState(), "load").mockResolvedValue();
  stop = startRealtime();
  // With no connection there is nothing to wait for.
  expect(subscribeProject("prj_1")).toBeUndefined();
  latest().open();
  const waiting = subscribeProject("prj_1");
  expect(latest().sent).toEqual([{ type: "subscribe", projectId: "prj_1" }]);
  // Asked again while waiting, it is the same wait and no second message.
  expect(subscribeProject("prj_1")).toBe(waiting);
  expect(latest().sent).toHaveLength(1);
  let ready = false;
  void waiting!.then(() => { ready = true; });
  await vi.advanceTimersByTimeAsync(500);
  expect(ready).toBe(false);
  latest().hear({ type: "project.subscribed", projectId: "prj_1", found: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(ready).toBe(true);
  // Confirmed: nothing more to ask.
  expect(subscribeProject("prj_1")).toBeUndefined();

  // Another project takes its place. The engine never answers, so the read goes ahead after a second and the log says so.
  const second = subscribeProject("prj_2");
  expect(latest().sent.slice(1)).toEqual([{ type: "unsubscribe", projectId: "prj_1" }, { type: "subscribe", projectId: "prj_2" }]);
  let gaveUp = false;
  void second!.then(() => { gaveUp = true; });
  await vi.advanceTimersByTimeAsync(999);
  expect(gaveUp).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(gaveUp).toBe(true);
  expect(log.written()).toEqual([
    "[realtime] connected project=prj_1",
    "[realtime] subscribe project=prj_1",
    "[realtime] subscribe project=prj_2",
    "[realtime] subscribe-unconfirmed project=prj_2",
  ]);
  expect(log.levels.at(-1)).toBe("warn");
  leaveProject("prj_2");
  expect(latest().sent.at(-1)).toEqual({ type: "unsubscribe", projectId: "prj_2" });
  // Leaving a project that isn't the open one changes nothing.
  leaveProject("prj_1");
  expect(latest().sent).toHaveLength(4);
});

it("lets a wait for one project go when another is opened, and says when the engine doesn't know the project", async () => {
  const log = logged();
  stop = startRealtime();
  latest().open();
  let released = false;
  void subscribeProject("prj_1")!.then(() => { released = true; });
  void subscribeProject("prj_2");
  await vi.advanceTimersByTimeAsync(0);
  expect(released).toBe(true);
  // An answer about the project that was left is not about this one.
  latest().hear({ type: "project.subscribed", projectId: "prj_1", found: true });
  expect(subscribeProject("prj_2")).toBeInstanceOf(Promise);
  latest().hear({ type: "project.subscribed", projectId: "prj_2", found: false });
  expect(log.written().at(-1)).toBe("[realtime] project-unknown project=prj_2");
  expect(log.levels.at(-1)).toBe("warn");
  // Unknown is not confirmed: the next open asks again.
  expect(subscribeProject("prj_2")).toBeInstanceOf(Promise);
  leaveProject("prj_2");
});

it("reads the open project again when the connection comes back", () => {
  const load = vi.spyOn(useProjectStore.getState(), "load").mockResolvedValue();
  stop = startRealtime();
  latest().open();
  expect(load).not.toHaveBeenCalled();
  void subscribeProject("prj_1");
  latest().drop();
  vi.advanceTimersByTime(2000);
  latest().open();
  expect(load).toHaveBeenCalledExactlyOnceWith("prj_1");
  leaveProject("prj_1");
});

it("drops a message it can't read, and logs each kind of one once a connection", () => {
  const log = logged();
  const applied = vi.spyOn(useProjectStore.getState(), "applyEvent");
  stop = startRealtime();
  latest().open();
  latest().hear("not json {");
  latest().hear("still not json");
  latest().hear({ type: "render.exploded", projectId: "prj_1" });
  latest().hear({ type: "render.exploded", projectId: "prj_1" });
  latest().hear({ type: "task.usage", projectId: "prj_1", taskId: "tsk_1" });
  latest().hear({ type: "pong" });
  latest().hear(null);
  expect(applied).not.toHaveBeenCalled();
  expect(log.written().slice(1)).toEqual([
    '[realtime] unreadable reason="not JSON"',
    "[realtime] unreadable type=render.exploded at=type",
    "[realtime] unreadable type=task.usage at=usage",
    "[realtime] unreadable",
  ]);
  expect(log.levels.slice(1)).toEqual(["warn", "warn", "warn", "warn"]);
  // A new connection says it again, once.
  latest().drop();
  vi.advanceTimersByTime(2000);
  latest().open();
  log.written();
  log.lines.length = 0;
  latest().hear("not json {");
  latest().hear({ type: "render.settings.updated" });
  expect(log.written()).toEqual(['[realtime] unreadable reason="not JSON"', "[realtime] render.settings.updated"]);
  expect(applied).toHaveBeenCalledExactlyOnceWith({ type: "render.settings.updated" });
});

it("ignores a socket that was replaced", () => {
  const applied = vi.spyOn(useProjectStore.getState(), "applyEvent");
  stop = startRealtime();
  const old = latest();
  old.open();
  old.drop();
  vi.advanceTimersByTime(2000);
  latest().open();
  old.hear({ type: "render.settings.updated" });
  old.hear("not json {");
  old.onopen?.();
  expect(applied).not.toHaveBeenCalled();
  expect(status()).toBe("open");
});

it("sends each kind of event to the part of the window it is about", async () => {
  const log = logged();
  const db = buildDb();
  const applied = vi.spyOn(useProjectStore.getState(), "applyEvent").mockReturnValue();
  const host = { id: "host_1", name: "This Mac", agents: [], state: "online" } as never;
  const skill = { ...db.skills[0]!, id: "skl_new", name: "aaa-first" };
  dispatchWsEvent({ type: "host.updated", host });
  dispatchWsEvent({ type: "skill.updated", skill });
  dispatchWsEvent({ type: "notification", title: "Export finished", body: "a file the editor named", projectId: PRJ, link: "/p/x" });
  const task = db.tasks[0]!;
  dispatchWsEvent({ type: "task.updated", projectId: PRJ, task });
  expect(useHostsStore.getState().hosts).toContainEqual(host);
  expect(useSkillsStore.getState().skills[0]).toEqual(skill);
  expect(useUiStore.getState().notifications.at(0)).toMatchObject({ title: "Export finished", projectId: PRJ, link: "/p/x" });
  expect(applied).toHaveBeenCalledExactlyOnceWith({ type: "task.updated", projectId: PRJ, task });

  // A local import's copy reports how far it has been checked to whoever started it, and to nobody afterwards.
  const checks: number[] = [];
  let finish!: (answer: { media: never }) => void;
  vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");
  const sent = vi.spyOn(api, "importMedia").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const importing = importLocalFile(PRJ, "/Volumes/Cards/A001.mov", fraction => checks.push(fraction));
  dispatchWsEvent({ type: "media.import.checking", projectId: PRJ, importId: "11111111-1111-4111-8111-111111111111", fraction: 0.5 });
  dispatchWsEvent({ type: "media.import.checking", projectId: PRJ, importId: "22222222-2222-4222-8222-222222222222", fraction: 0.9 });
  finish({ media: { id: "med_new" } as never });
  await expect(importing).resolves.toEqual({ id: "med_new" });
  dispatchWsEvent({ type: "media.import.checking", projectId: PRJ, importId: "11111111-1111-4111-8111-111111111111", fraction: 1 });
  expect(checks).toEqual([0.5]);
  expect(sent).toHaveBeenCalledExactlyOnceWith(PRJ, { path: "/Volumes/Cards/A001.mov", importId: "11111111-1111-4111-8111-111111111111" });
  expect(applied).toHaveBeenCalledTimes(1);

  // Each is one line by kind and id: with its state where it has one, and never a title, a body or a path.
  const lines = log.written();
  expect(lines).toEqual([
    "[realtime] host.updated host=host_1:online",
    "[realtime] skill.updated skill=skl_new",
    `[realtime] notification project=${PRJ}`,
    `[realtime] task.updated project=${PRJ} task=${task.id}:${task.state}`,
    `[realtime] media.import.checking project=${PRJ} import=11111111-1111-4111-8111-111111111111`,
    `[realtime] media.import.checking project=${PRJ} import=22222222-2222-4222-8222-222222222222`,
    `[realtime] media.import.checking project=${PRJ} import=11111111-1111-4111-8111-111111111111`,
  ]);
  expect(lines.join()).not.toMatch(/the editor named|A001/);
});

it("imports a link as a download, without the progress a local copy reports", async () => {
  const sent = vi.spyOn(api, "importMedia").mockResolvedValue({ media: { id: "med_link" } as never });
  await importLocalFile(PRJ, "HTTPS://example.com/clip.mp4", () => {});
  expect(sent).toHaveBeenCalledExactlyOnceWith(PRJ, { url: "HTTPS://example.com/clip.mp4", importId: expect.any(String) });
});
