// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startAppLog, stopAppLog } from "../../lib/appLog";
import * as cutStream from "../../lib/cutStream";
import { buildDb, PRJ } from "../../lib/mock/fixtures";
import { joinClock } from "../../lib/joinClock";
import { player } from "../../lib/player";
import { usePlayerStore } from "../../stores/player";
import { CutStream } from "./CutStream";

const db = buildDb();
const project = db.projects.find(p => p.id === PRJ)!;
const timeline = db.timelines[project.head!]!;
let root: Root;
let container: HTMLDivElement;
let log: { line: string; level: string }[];
const initial = usePlayerStore.getState();
const onStart = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  usePlayerStore.setState({ time: 4, rate: 1, playing: false });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  onStart.mockClear();
  log = [];
  // An element with nothing to play yet doesn't report that it is playing; the test's own events say when it does.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => new Promise(() => {}));
  startAppLog((lines, level) => log.push(...lines.map(line => ({ line, level }))));
});

afterEach(async () => {
  await act(async () => root.unmount());
  stopAppLog();
  container.remove();
  usePlayerStore.setState(initial, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const show = (draft = false) => act(async () => root.render(<CutStream project={project} timeline={timeline} version={project.head!} onStart={onStart} draft={draft} />));
const video = () => container.querySelector("video")!;
const alert = () => container.querySelector('[role="alert"]')?.textContent;
/** Whether the player marks its video as waiting for a section. The monitor's play button shows that, in place of its icon. */
const waiting = () => video().hasAttribute("data-waiting");
const button = () => container.querySelector("button");

it("keeps the player mounted and reports the playback budget for an older timeline", async () => {
  const old = structuredClone(timeline);
  old.tracks[0]!.clips[0]!.timelineIn = 86_401;
  const open = vi.spyOn(cutStream, "openCutStream");
  await act(async () => root.render(<CutStream project={project} timeline={old} version={project.head!} onStart={onStart} />));
  expect(alert()).toMatch(/24 hours/);
  expect(video()).toBeTruthy();
  await act(async () => player.play());
  expect(open).not.toHaveBeenCalled();
});
/** The stream's lines in the log, without their clock. */
const streamLines = () => log.filter(l => l.line.includes(" stream ")).map(l => [l.level, l.line.replace(/^\[playback\] \S+ \+\d+ms /, "")]);
type Opened = { start: number; fail(reason: unknown): void; session: ReturnType<typeof cutStream.openCutStream> };
/** The engine's stream, standing in: it opens, and can be told to fail later. */
const streams = () => {
  const opened: Opened[] = [];
  const open = vi.spyOn(cutStream, "openCutStream").mockImplementation((video, _ranges, start, _load, fail) => {
    const session = { bufferThrough: vi.fn(async () => {}), seek: vi.fn(), finishSeek: vi.fn(), dispose: vi.fn(), sourceTime: () => video.currentTime };
    opened.push({ start, fail, session });
    return session;
  });
  return { open, opened };
};

it("opens the stream on the first play, from where the editor is, and says a section is on its way", async () => {
  const { open, opened } = streams();
  await show();
  expect(video().getAttribute("aria-label")).toBe("The current edit");
  // Nothing is asked of the engine until the editor plays.
  expect(open).not.toHaveBeenCalled();
  expect([waiting(), button()]).toEqual([false, null]);
  await act(async () => player.play());
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(opened.map(o => o.start)).toEqual([4]);
  // It draws nothing of its own over the picture: the play button would cover it.
  expect([waiting(), container.querySelector('[role="status"]')]).toEqual([true, null]);
  // Playing again while it is open doesn't open a second stream.
  await act(async () => player.play());
  expect(open).toHaveBeenCalledTimes(1);
  await act(async () => { video().dispatchEvent(new Event("playing")); });
  expect(waiting()).toBe(false);
  // A section that isn't in yet says so again, and goes once it can play.
  await act(async () => { video().dispatchEvent(new Event("waiting")); });
  expect(waiting()).toBe(true);
  await act(async () => { video().dispatchEvent(new Event("canplay")); });
  expect(waiting()).toBe(false);
  // Seeks go to the stream that is open, and it is closed with the player.
  await act(async () => player.seek(9));
  expect(opened[0]!.session.seek).toHaveBeenCalledWith(9);
  vi.spyOn(opened[0]!.session, "sourceTime").mockReturnValue(9);
  vi.spyOn(video(), "readyState", "get").mockReturnValue(1);
  await act(async () => { video().currentTime = 4; video().dispatchEvent(new Event("seeked")); });
  expect(usePlayerStore.getState().time).toBe(9);
  await act(async () => root.render(null));
  expect(opened[0]!.session.dispose).toHaveBeenCalledTimes(1);
});

it.each([false, true])("marks the joined audition as loading through its last required fragment (cancel: %s)", async cancel => {
  const { opened } = streams();
  const cut = { start: 5, end: 7 };
  await act(async () => root.render(<CutStream project={project} timeline={timeline} version={project.head!} onStart={onStart}
    joins={joinClock([cut], 30)} />));
  await act(async () => player.prepare());
  const session = opened[0]!.session;
  let finish!: () => void;
  vi.spyOn(session, "bufferThrough").mockImplementation((_start, _end, signal) => new Promise<void>((resolve, reject) => {
    finish = resolve;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  let release!: () => void;
  try {
    await act(async () => { release = player.audition({ start: 3, end: 10, skips: [{ ...cut, removed: true }] }, 30); });
    await act(async () => {
      video().dispatchEvent(new Event("loadeddata"));
      video().dispatchEvent(new Event("canplay"));
    });
    expect(waiting()).toBe(true);
    await act(async () => { if (cancel) player.toggle(); else finish(); });
    expect(waiting()).toBe(false);
    expect(video().play).toHaveBeenCalledTimes(cancel ? 0 : 1);
  } finally { await act(async () => release?.()); }
});

it("says why a stream that couldn't open didn't, logs it as a failure, and opens one again on Retry playback", async () => {
  const open = vi.spyOn(cutStream, "openCutStream").mockImplementation(() => { throw new Error("This device cannot play segmented previews."); });
  await show();
  await act(async () => player.play());
  expect(alert()).toBe("This device cannot play segmented previews.");
  expect(button()?.textContent?.trim()).toBe("Retry playback");
  // The stream never existed to log its own failure, so the player does: once, at a level a search for failures finds.
  expect(streamLines()).toEqual([["warn", `stream open-failed version=${project.head} sections=${open.mock.calls[0]![1].length} error="Error: This device cannot play segmented previews."`]]);
  // Retry is play: it asks for a stream again.
  const { opened } = streams();
  await act(async () => button()!.click());
  expect(opened).toHaveLength(1);
  expect(alert()).toBeUndefined();
  expect(waiting()).toBe(true);
  expect(streamLines()).toHaveLength(1);
});

it("says why a stream that failed part-way did, without logging what the stream already logged, and retries with a new one", async () => {
  const { opened } = streams();
  await show();
  await act(async () => player.play());
  await act(async () => opened[0]!.fail(new Error("Couldn’t load the preview file.")));
  expect(alert()).toBe("Couldn’t load the preview file.");
  expect(button()?.textContent?.trim()).toBe("Retry playback");
  expect(streamLines()).toEqual([]);
  await act(async () => button()!.click());
  expect(opened).toHaveLength(2);
  expect(alert()).toBeUndefined();
});

it("starts a proposed draft by itself, from its top, wherever the editor was in the edit", async () => {
  const { opened } = streams();
  usePlayerStore.setState({ time: 7 });
  await show(true);
  expect(video().getAttribute("aria-label")).toBe("Proposed draft");
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(opened.map(o => o.start)).toEqual([0]);
  expect(waiting()).toBe(true);
  await act(async () => { video().dispatchEvent(new Event("loadeddata")); });
  expect([waiting(), button()]).toEqual([false, null]);
});

it("keeps the open stream through a project update that leaves the frame rate as it was", async () => {
  const { open, opened } = streams();
  await show();
  await act(async () => player.play());
  expect(open).toHaveBeenCalledTimes(1);
  // Media processing paused, or the socket reconnected: the project and its settings are new objects, nothing else is.
  await act(async () => root.render(<CutStream project={{ ...project, settings: { ...project.settings }, mediaPaused: true }} timeline={timeline} version={project.head!} onStart={onStart} />));
  expect(opened[0]!.session.dispose).not.toHaveBeenCalled();
  await act(async () => player.play());
  expect(open).toHaveBeenCalledTimes(1);
  // A new frame rate plans the stream again.
  await act(async () => root.render(<CutStream project={{ ...project, settings: { ...project.settings, fps: 25 } }} timeline={timeline} version={project.head!} onStart={onStart} />));
  expect(opened[0]!.session.dispose).toHaveBeenCalledTimes(1);
});

it("promotes the parked stream when the cut opens from another copy of its timeline", async () => {
  const { open, opened } = streams();
  await act(async () => root.render(<CutStream project={project} timeline={timeline} version={project.head!} onStart={onStart} parkedAt={4} />));
  const parked = video();
  expect(player.element()).not.toBe(parked);
  expect(open).toHaveBeenCalledOnce();
  await act(async () => root.render(<CutStream project={project} timeline={structuredClone(timeline)} version={project.head!} onStart={onStart} />));
  expect(player.element()).toBe(parked);
  await act(async () => player.prepare());
  expect(open).toHaveBeenCalledOnce();
  expect(opened[0]!.session.dispose).not.toHaveBeenCalled();
});
