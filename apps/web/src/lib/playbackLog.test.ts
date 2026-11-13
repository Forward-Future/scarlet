// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appLog, calledBy, logPath, startAppLog, stopAppLog } from "./appLog";
import { logId, mediaState, playbackLog, playbackLogging, startPlaybackLog, stopPlaybackLog, timeRanges } from "./playbackLog";

let lines: string[];
const written = () => { vi.advanceTimersByTime(300); return lines; };
beforeEach(() => {
  vi.useFakeTimers();
  lines = [];
  startPlaybackLog(batch => lines.push(...batch));
  written();
  lines.length = 0;
});
afterEach(() => {
  stopPlaybackLog();
  stopAppLog();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("writes nothing until logging starts", () => {
  stopAppLog();
  playbackLog("stream open", { id: "s1" });
  expect(written()).toEqual([]);
});

it("writes an event with its fields, stamped to the millisecond", () => {
  playbackLog("stream load", { id: "s1", section: 4, range: [12, 18.0004], skipped: undefined, why: "two words" });
  expect(written()).toEqual([expect.stringMatching(/^\[playback\] \d\d:\d\d:\d\d\.\d{3} \+\d+ms stream load id=s1 section=4 range=\[12,18\] why="two words"$/)]);
});

it("keeps a burst of the same line as one line with a count", () => {
  for (let i = 0; i < 5; i++) playbackLog("transport seek", { to: i }, "transport seek");
  playbackLog("transport play");
  expect(written()).toEqual([expect.stringMatching(/transport seek to=4 x5$/), expect.stringMatching(/transport play$/)]);
});

it("caps a runaway burst and says how many lines it left out", () => {
  for (let i = 0; i < 400; i++) playbackLog("stream append", { section: i });
  expect(written()).toHaveLength(160);
  vi.advanceTimersByTime(1000);
  lines.length = 0;
  playbackLog("stream end");
  expect(written()).toEqual([expect.stringMatching(/stream end unlogged=240$/)]);
});

it("logs every media element's events, with its state and without its query", () => {
  const video = document.createElement("video");
  video.setAttribute("aria-label", "The current edit");
  video.src = "http://127.0.0.1:5000/api/files/renders/rnd_1/file?token=sct_secret";
  document.body.append(video);
  video.dispatchEvent(new Event("waiting"));
  video.dispatchEvent(new Event("pause"));
  const [waiting, pause] = written();
  expect(waiting).toContain(`waiting el=${logId(video)} name="The current edit" src=renders/rnd_1/file t=0`);
  expect(waiting).toContain("paused=true");
  expect(waiting).not.toContain("sct_secret");
  expect(pause).toContain(" pause el=");
});

it("caps each tag on its own, so a noisy one doesn't silence the rest", () => {
  for (let i = 0; i < 400; i++) playbackLog("stream append", { section: i });
  appLog("action", "click", { on: "Before" });
  expect(written().at(-1)).toMatch(/^\[action\] .* click on=Before$/);
});

it("writes a warning at once, at its level, after the lines before it", () => {
  const levels: string[] = [];
  startPlaybackLog((batch, level) => { lines.push(...batch); levels.push(level); });
  appLog("nav", "to", { path: "/p/prj_1" });
  appLog("api", "failed", { status: 500 }, { level: "warn" });
  expect(lines.map(line => line.split(" ")[0])).toEqual(["[nav]", "[api]"]);
  expect(levels).toEqual(["info", "warn"]);
});

it("logs a URL as its path and the names of its query fields only", () => {
  expect(logPath("http://127.0.0.1:5000/api/media/med_1/file?token=sct_secret&preview=1")).toBe("/api/media/med_1/file?token&preview");
  expect(logPath("/p/prj_1")).toBe("/p/prj_1");
});

/**
 * A video that plays as the test says: its clock, frames and decoded sound are set by hand, and each frame of the
 * window is drawn by hand at a chosen time.
 */
function playing(extra: { sound?: boolean; frames?: boolean } = {}) {
  let frame: ((now: number) => void) | undefined;
  vi.stubGlobal("requestAnimationFrame", (draw: (now: number) => void) => { frame = draw; return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => { frame = undefined; });
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  const video = document.createElement("video");
  const state = { time: 0, paused: false, seeking: false, muted: false, dropped: 0, total: 0, sound: 0 };
  Object.defineProperties(video, {
    currentTime: { get: () => state.time }, paused: { get: () => state.paused }, seeking: { get: () => state.seeking }, muted: { get: () => state.muted },
    ...(extra.frames && { getVideoPlaybackQuality: { value: () => ({ droppedVideoFrames: state.dropped, totalVideoFrames: state.total }) } }),
    ...(extra.sound && { webkitAudioDecodedByteCount: { get: () => state.sound } }),
  });
  document.body.append(video);
  video.dispatchEvent(new Event("playing"));
  written();
  lines.length = 0;
  /** Draw a frame at `ms`, with the video's clock at `time`. */
  const draw = (ms: number, time = state.time) => { state.time = time; clock.mockReturnValue(ms); const now = frame; frame = undefined; now?.(ms); };
  /** What the watcher wrote, as event and fields. */
  const events = () => written().map(line => line.replace(/^\[playback\] \S+ \S+ /, ""));
  return { video, state, draw, events, id: logId(video), waiting: () => !!frame };
}

it("logs a clock that stops under a playing video, once, and how long it was stopped when it moves again", () => {
  const { state, draw, events, id } = playing();
  draw(16, 0.016);
  draw(32, 0.032);
  // The clock stays where it was: under a fifth of a second is not a stall.
  for (const ms of [80, 130, 180]) draw(ms);
  expect(events()).toEqual([]);
  for (const ms of [240, 340, 440, 540]) draw(ms);
  expect(events()).toEqual([expect.stringMatching(new RegExp(`^stall el=${id} t=0\\.032 ready=\\d+ net=\\d+ paused=false`))]);
  lines.length = 0;
  draw(600, 0.048);
  expect(events()).toEqual([`resumed el=${id} after=508 t=0.048`]);
  // A paused video isn't watched: its clock standing still is what it should do.
  lines.length = 0;
  state.paused = true;
  for (const ms of [700, 800, 900, 1000, 1100]) draw(ms);
  expect(events()).toEqual([]);
});

it("logs a clock that jumps with nobody asking, and not one that was sent there", () => {
  const { video, state, draw, events, id } = playing();
  draw(16, 0.016);
  draw(32, 12);
  expect(events()).toEqual([`jump el=${id} from=0.016 to=12 ms=16`]);
  lines.length = 0;
  // A seek moves the clock on purpose, and the frames while it settles are not stalls.
  video.dispatchEvent(new Event("seeking"));
  state.seeking = true;
  draw(48, 40);
  for (const ms of [100, 200, 300, 400]) draw(ms);
  state.seeking = false;
  draw(416, 40.016);
  // Fast playback covers more than a frame's worth of clock without jumping.
  Object.defineProperty(video, "playbackRate", { value: 2 });
  draw(516, 40.216);
  expect(events().filter(line => !line.startsWith("seeking"))).toEqual([]);
});

it("logs frames the decoder dropped, a second at a time", () => {
  const { state, draw, events, id } = playing({ frames: true });
  const run = (from: number, to: number) => { for (let ms = from; ms <= to; ms += 100) draw(ms, ms / 1000); };
  state.total = 30;
  run(100, 900);
  expect(events()).toEqual([]);
  state.dropped = 12;
  state.total = 60;
  run(1000, 1900);
  expect(events()).toEqual([`dropped el=${id} frames=12 of=60 t=1`]);
  // A second with no more dropped says nothing; the next count is only what was dropped since.
  lines.length = 0;
  run(2000, 2900);
  state.dropped = 15;
  state.total = 120;
  run(3000, 3100);
  expect(events()).toEqual([`dropped el=${id} frames=3 of=120 t=3`]);
});

it("logs the sound going quiet under a moving picture, and coming back", () => {
  const { state, draw, events, id } = playing({ sound: true });
  const run = (from: number, to: number, decoding: boolean) => { for (let ms = from; ms <= to; ms += 100) { if (decoding) state.sound += 800; draw(ms, ms / 1000); } };
  run(100, 2000, true);
  expect(events()).toEqual([]);
  // The picture keeps moving and no more sound is decoded: two seconds of that is a dropout.
  run(2100, 5000, false);
  expect(events()).toEqual([expect.stringMatching(new RegExp(`^audio-idle el=${id} for=2 t=4 `))]);
  lines.length = 0;
  run(5100, 6000, true);
  expect(events()).toEqual([`audio-back el=${id} after=3 t=6`]);
  // Muted, there is no sound to miss.
  lines.length = 0;
  state.muted = true;
  run(6100, 12_000, false);
  expect(events()).toEqual([]);
});

it("logs a held-up window as a late frame, unless the window was hidden", () => {
  const { draw, events } = playing();
  draw(16, 0.016);
  draw(32, 0.032);
  draw(432, 0.432);
  expect(events()).toEqual(["hitch ms=400"]);
  lines.length = 0;
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  draw(2432, 2.432);
  expect(events()).toEqual([]);
});

it("stops watching a video that paused, ended or left the page, and stops drawing when none is left", () => {
  const first = playing();
  first.draw(16, 0.016);
  expect(first.waiting()).toBe(true);
  first.video.remove();
  first.draw(32);
  expect(first.waiting()).toBe(false);
  // The next video to play starts the watch again, with no late frame counted for the gap.
  const second = playing();
  second.draw(5000, 0.016);
  second.draw(5016, 0.032);
  expect(second.events()).toEqual([]);
  second.video.dispatchEvent(new Event("pause"));
  second.draw(5032);
  expect(second.waiting()).toBe(false);
});

it("says the window was hidden or shown", () => {
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  hidden.mockReturnValue(false);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(written().map(line => line.replace(/^\[playback\] \S+ \S+ /, ""))).toEqual(["window hidden=true", "window hidden=false"]);
});

it("logs a media error with its code, as a warning, and folds a scrub's seeks into one line", () => {
  const levels: string[] = [];
  startPlaybackLog((batch, level) => { lines.push(...batch); levels.push(level); });
  const video = document.createElement("video");
  document.body.append(video);
  for (let i = 0; i < 4; i++) video.dispatchEvent(new Event("seeking"));
  Object.defineProperty(video, "error", { value: { code: 3, message: "Decode failed" } });
  video.dispatchEvent(new Event("error"));
  expect(lines).toEqual([
    expect.stringMatching(/ seeking el=v\d+ name=video src=none .* x4$/),
    expect.stringMatching(/ error el=v\d+ name=video src=none .* error=\{"code":3,"message":"Decode failed"\}$/),
  ]);
  expect(levels).toEqual(["info", "warn"]);
});

it("names a stream by what it is and stops listening when stopped", () => {
  const video = document.createElement("video");
  document.body.append(video);
  Object.defineProperty(video, "currentSrc", { value: "blob:http://127.0.0.1/1234" });
  video.dispatchEvent(new Event("loadstart"));
  expect(written()).toEqual([expect.stringContaining(" loadstart el=" + logId(video) + " name=video src=stream ")]);
  lines.length = 0;
  expect(playbackLogging()).toBe(true);
  stopPlaybackLog();
  video.dispatchEvent(new Event("loadstart"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(written()).toEqual([]);
});

it("reads what is buffered as ranges, and nothing from a buffer that was taken away", () => {
  const ranges = (pairs: [number, number][]) => ({ length: pairs.length, start: (i: number) => pairs[i]![0], end: (i: number) => pairs[i]![1] }) as TimeRanges;
  expect(timeRanges(ranges([[0, 4], [10, 12.5]]))).toEqual([[0, 4], [10, 12.5]]);
  expect(timeRanges(undefined)).toEqual([]);
  const gone = { length: 2, start: () => { throw new DOMException("gone", "InvalidStateError"); }, end: () => 0 } as unknown as TimeRanges;
  expect(timeRanges(gone)).toEqual([]);
});

it("describes an element as it is now, leaving out what is at its usual value", () => {
  const video = document.createElement("video");
  Object.defineProperties(video, {
    currentTime: { value: 12.5 }, readyState: { value: 4 }, networkState: { value: 1 }, paused: { value: false }, seeking: { value: false },
    muted: { value: true }, volume: { value: 0.5 }, playbackRate: { value: 1 },
    getVideoPlaybackQuality: { value: () => ({ droppedVideoFrames: 2, totalVideoFrames: 300 }) },
  });
  expect(mediaState(video)).toEqual({ t: 12.5, ready: 4, net: 1, paused: false, seeking: undefined, muted: true, vol: 0.5, rate: undefined, buf: [], frames: "2/300", adec: undefined, vdec: undefined });
});

it("says who asked, as the nearest callers outside the log and the player, and nothing while the log is off", () => {
  function pressedPlay() { return transport(); }
  function transport() { return calledBy(); }
  const who = pressedPlay();
  expect(who).toMatch(/^pressedPlay@?.*playbackLog\.test\.ts:\d+:\d+/);
  expect(who).not.toMatch(/https?:|file:|\?/);
  expect(who!.split(" < ").length).toBeLessThanOrEqual(3);
  expect(calledBy(1)!.split(" < ")).toHaveLength(1);
  stopAppLog();
  expect(calledBy()).toBeUndefined();
  startAppLog(() => {});
});
