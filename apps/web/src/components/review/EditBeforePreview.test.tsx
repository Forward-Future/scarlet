// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startAppLog, stopAppLog } from "../../lib/appLog";
import * as cutStream from "../../lib/cutStream";
import { buildDb, PRJ } from "../../lib/mock/fixtures";
import { usePlayerStore } from "../../stores/player";
import { useProjectStore } from "../../stores/project";
import { EditBeforePreview, type BeforePlayback, type useEditBefore } from "./EditBeforePreview";

const db = buildDb();
const project = db.projects.find(p => p.id === PRJ)!;
const timeline = db.timelines[project.head!]!;
const change = db.changes.find(c => c.id === "chg_approved_2")!;
const stores = [useProjectStore.getState(), usePlayerStore.getState()] as const;
let root: Root;
let container: HTMLDivElement;
let log: { line: string; level: string }[];
const requestRender = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  requestRender.mockReset().mockReturnValue(new Promise(() => {}));
  useProjectStore.setState({ status: "ready", requestRender, ensureRender: vi.fn(),
    current: { id: PRJ, project, timeline, media: project.media, changes: db.changes, notes: [], renders: [], tasks: [], taskEvents: {} } });
  log = [];
  startAppLog((lines, level) => log.push(...lines.map(line => ({ line, level }))));
});

afterEach(async () => {
  await act(async () => root.unmount());
  stopAppLog();
  container.remove();
  useProjectStore.setState(stores[0], true);
  usePlayerStore.setState(stores[1], true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Before = ReturnType<typeof useEditBefore>;
const before = (over: Partial<Before>): Before => ({ timeline: undefined, error: undefined, retry: vi.fn(), duration: 16, map: undefined, range: undefined, unavailable: undefined, ...over }) as Before;
/** The edit's passage on the page's timeline: where its Before runs, unless the test says the edit moved it. */
const show = (original: Before, passage = original.range ?? { start: 0, end: 0 }, playbackRef?: { current: BeforePlayback | null }) =>
  act(async () => root.render(<EditBeforePreview change={change} original={original} passage={passage} active aspect={16 / 9}
    clock={<b>0:02 / 0:16</b>} playbackRef={playbackRef} />));

it("says Before is opening until the earlier version is in, and offers to ask again when it couldn't be read", async () => {
  await show(before({}));
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Opening Before…");
  expect(container.querySelector("button, video")).toBeNull();
  const retry = vi.fn();
  await show(before({ error: "The engine is restarting.", retry }));
  const again = container.querySelector("button")!;
  expect(again.textContent).toBe("Retry Before");
  await act(async () => again.click());
  expect(retry).toHaveBeenCalledTimes(1);
  expect(requestRender).not.toHaveBeenCalled();
});

it("plays a short passage of the earlier version as one prepared section", async () => {
  const open = vi.spyOn(cutStream, "openCutStream");
  await show(before({ timeline, range: { start: 2, end: 6 } }));
  expect(open).not.toHaveBeenCalled();
  expect(requestRender).toHaveBeenCalledWith(expect.objectContaining({ kind: "segment", version: timeline.version, range: { start: 2, end: 6 } }));
});

it("streams a long passage, and when the stream can't open logs why once and prepares the passage as a section instead", async () => {
  const open = vi.spyOn(cutStream, "openCutStream").mockImplementation(() => { throw new Error("This device cannot play segmented previews."); });
  await show(before({ timeline, range: { start: 1, end: 14 } }));
  expect(open).toHaveBeenCalledTimes(1);
  expect(open.mock.calls[0]![2]).toBe(1);
  expect(open.mock.calls[0]![5]).toEqual({ start: 1, end: 14 });
  const failures = log.filter(l => l.line.includes(" stream "));
  expect(failures.map(l => [l.level, l.line.replace(/^\[playback\] \S+ \+\d+ms /, "")])).toEqual([
    ["warn", `stream open-failed version=${timeline.version} sections=${open.mock.calls[0]![1].length} error="Error: This device cannot play segmented previews."`]]);
  // The passage still plays: as one prepared section, with no second try at a stream that can't open.
  expect(requestRender).toHaveBeenCalledWith(expect.objectContaining({ kind: "segment", version: timeline.version, range: { start: 1, end: 14 } }));
  await show(before({ timeline, range: { start: 1, end: 14 } }));
  expect(open).toHaveBeenCalledTimes(1);
});

/** The clip's prepared section is in, and its video has played to `seconds` from the section's start. */
const playedTo = (seconds: number) => act(async () => {
  const video = container.querySelector("video")!;
  Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: seconds });
  video.dispatchEvent(new Event("timeupdate"));
});

it("moves the page's playhead with the clip across the edit's passage, and shows the page's clock beside the play button", async () => {
  requestRender.mockResolvedValue({ ...db.renders[0]!, id: "rnd_before", kind: "segment", state: "done" });
  usePlayerStore.setState({ time: 4.5 });
  await show(before({ timeline, range: { start: 2, end: 6 } }));
  // The clip starts at its top, and the playhead with it at the passage's start.
  expect(usePlayerStore.getState().time).toBe(2);
  await playedTo(1.5);
  expect(usePlayerStore.getState().time).toBe(3.5);
  // The clock is the page's own, as on After: the clip's range clock, to the millisecond, isn't shown.
  expect(container.querySelector(".monitor-clock")?.textContent).toBe("0:02 / 0:16");
  // An edit that halved the passage's length: the clip's eight seconds cross its four on the page.
  await show(before({ timeline, range: { start: 2, end: 10 } }), { start: 2, end: 6 });
  await playedTo(3);
  expect(usePlayerStore.getState().time).toBe(3.5);
});

it("moves the clip to a point picked inside the passage on the page's timeline, and says it has nothing to show outside it or before it has opened", async () => {
  requestRender.mockResolvedValue({ ...db.renders[0]!, id: "rnd_before", kind: "segment", state: "done" });
  const playback = { current: null as BeforePlayback | null };
  await show(before({ timeline, range: { start: 2, end: 6 } }), undefined, playback);
  const at = () => Math.round(usePlayerStore.getState().time * 1000) / 1000;
  let moved: boolean | undefined;
  await act(async () => { moved = playback.current!.seek(5); });
  expect([moved, at()]).toEqual([true, 5]);
  // The passage's end is its last frame, at the project's 30 frames a second.
  await act(async () => { moved = playback.current!.seek(6); });
  expect([moved, at()]).toEqual([true, 5.967]);
  // Past either end there is nothing of Before: the clip stays where it is, and the page goes to After.
  await act(async () => { moved = playback.current!.seek(9); });
  expect([moved, at()]).toEqual([false, 5.967]);
  await act(async () => { moved = playback.current!.seek(0.5); });
  expect([moved, at()]).toEqual([false, 5.967]);
  // Until the earlier version is in there is no clip to move, or to pause.
  await show(before({}), { start: 2, end: 6 }, playback);
  expect([playback.current!.seek(3), playback.current!.playing()]).toEqual([false, false]);
  expect(() => { playback.current!.pause(); playback.current!.scrub(); }).not.toThrow();
});

/** The clip's prepared section is in, and it plays by itself. */
const sectionIn = (length: number) => act(async () => {
  const video = container.querySelector("video")!;
  Object.defineProperty(video, "readyState", { configurable: true, value: 4 });
  Object.defineProperty(video, "duration", { configurable: true, value: length });
  video.dispatchEvent(new Event("loadedmetadata"));
});

it("pauses the clip for a drag on the page's timeline, and carries on when the drag ends only if it was playing", async () => {
  requestRender.mockResolvedValue({ ...db.renders[0]!, id: "rnd_before", kind: "segment", state: "done" });
  const playback = { current: null as BeforePlayback | null };
  await show(before({ timeline, range: { start: 2, end: 6 } }), undefined, playback);
  const video = container.querySelector("video")!;
  // It will play as soon as its section is in, and then does.
  expect(playback.current!.playing()).toBe(true);
  await sectionIn(4);
  expect([video.paused, playback.current!.playing()]).toEqual([false, true]);
  let held: ReturnType<BeforePlayback["scrub"]>;
  await act(async () => { held = playback.current!.scrub(); });
  expect([video.paused, playback.current!.playing(), held!.playing]).toEqual([true, false, true]);
  await act(async () => held!.carryOn());
  expect(video.paused).toBe(false);
  // One the page stopped stays stopped through the drag.
  await act(async () => playback.current!.pause());
  expect([video.paused, playback.current!.playing()]).toEqual([true, false]);
  await act(async () => { held = playback.current!.scrub(); });
  expect(held!.playing).toBe(false);
  await act(async () => held!.carryOn());
  expect(video.paused).toBe(true);
});

it("plays from the point picked after the clip ran to its end, since the editor didn't pause it", async () => {
  requestRender.mockResolvedValue({ ...db.renders[0]!, id: "rnd_before", kind: "segment", state: "done" });
  const playback = { current: null as BeforePlayback | null };
  await show(before({ timeline, range: { start: 2, end: 6 } }), undefined, playback);
  const video = container.querySelector("video")!;
  await sectionIn(4);
  // It plays to the passage's end and stops there.
  await playedTo(4);
  expect([video.paused, playback.current!.playing()]).toEqual([true, false]);
  // A press on the page's timeline: held while the pointer is down, then playing from the point picked. The clip says
  // so, for a press that lands outside the passage, where the page plays on After.
  let held: ReturnType<BeforePlayback["scrub"]>;
  await act(async () => { held = playback.current!.scrub(); playback.current!.seek(3); });
  expect([video.paused, held!.playing]).toEqual([true, true]);
  await act(async () => held!.carryOn());
  expect([video.paused, video.currentTime]).toEqual([false, 1]);
});
