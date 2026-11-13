// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePlayerStore } from "../stores/player";
import { startAppLog, stopAppLog } from "./appLog";
import { pauseForScrub, player } from "./player";
import { joinClock } from "./joinClock";

const FPS = 30;
// After for a cut from 10 to 70 s: two seconds of lead-in, the join, three seconds after it.
const AFTER = { start: 8, end: 73, skips: [{ start: 10, end: 70, removed: true }] };

let video: HTMLVideoElement;
let release: (() => void) | undefined;

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
  usePlayerStore.setState({ time: 0, duration: 120, playing: false, rate: 1, scrubGesture: undefined });
  video = document.createElement("video");
  document.body.append(video);
  player.attach(video);
});

afterEach(() => {
  release?.();
  release = undefined;
  player.detach();
  video.remove();
  vi.restoreAllMocks();
});

/** Let playback reach a point, as a timeupdate while playing. */
function reach(time: number) {
  video.currentTime = time;
  video.dispatchEvent(new Event("timeupdate"));
}

it("plays straight on from where the footage resumes, without pausing, on the reading nearest the cut", () => {
  release = player.audition(AFTER, FPS);
  expect(video.currentTime).toBe(8);
  expect(video.paused).toBe(false);
  reach(9.9);
  reach(9.96);
  expect(video.currentTime).toBe(9.96);
  // Half a reading from the cut: this is the nearest one.
  reach(9.99);
  expect(video.currentTime).toBe(70);
  expect(video.paused).toBe(false);
  expect(usePlayerStore.getState().time).toBe(70);
  // Just after the join the clock can read a hair early. That is not removed footage.
  reach(69.995);
  expect(video.currentTime).toBe(69.995);

  reach(72);
  reach(73.02);
  expect(video.paused).toBe(true);
  expect(usePlayerStore.getState().time).toBe(73);
  // Play again listens from the top.
  player.play();
  expect(video.currentTime).toBe(8);
  expect(video.paused).toBe(false);
});

it.each([false, true])("replays the last cut when native media ends between clock readings (joined: %s)", joined => {
  const duration = 73;
  vi.spyOn(video, "duration", "get").mockReturnValue(joined ? 13 : duration);
  video.dispatchEvent(new Event("loadedmetadata"));
  if (joined) player.setJoins(video, joinClock(AFTER.skips, duration));
  release = player.audition(AFTER, FPS);
  reach(video.duration - 0.15);
  video.pause();
  video.currentTime = video.duration;
  vi.spyOn(video, "ended", "get").mockReturnValue(true);
  video.dispatchEvent(new Event("ended"));
  player.toggle();
  expect(video.currentTime).toBe(AFTER.start);
  expect(video.paused).toBe(false);
});

it.each([false, true])("handles a final reading past the cut preview's stop (sought past it: %s)", soughtPast => {
  vi.spyOn(video, "duration", "get").mockReturnValue(73.15);
  video.dispatchEvent(new Event("loadedmetadata"));
  release = player.audition(AFTER, FPS);
  if (soughtPast) player.seek(73.10, true);
  reach(soughtPast ? 73.12 : 72.95);
  video.pause();
  video.currentTime = video.duration;
  vi.spyOn(video, "ended", "get").mockReturnValue(true);
  video.dispatchEvent(new Event("ended"));
  player.toggle();
  expect(video.currentTime).toBe(soughtPast ? video.duration : AFTER.start);
});

it("does not restart an audition when a fallback section ends before the full video", () => {
  let sourceTime = 72.85;
  const seek = vi.fn();
  player.detach();
  player.attach(video, { duration: 120, sourceTime: () => sourceTime, prepare() {}, seek });
  release = player.audition(AFTER, FPS);
  reach(3.85);
  sourceTime = 73;
  video.pause();
  vi.spyOn(video, "ended", "get").mockReturnValue(true);
  video.dispatchEvent(new Event("ended"));
  seek.mockClear();
  player.toggle();
  expect(seek).not.toHaveBeenCalled();
});

it("lets the timeline scrub anywhere during a listen, closing up the removed footage on After", () => {
  release = player.audition(AFTER, FPS);
  player.pause();
  // Outside the listen: no longer held to the piece that's playing.
  player.seek(2, true);
  expect(video.currentTime).toBe(2);
  expect(usePlayerStore.getState().time).toBe(2);
  player.seek(95, true);
  expect(usePlayerStore.getState().time).toBe(95);

  // A click or drag into the removed footage lands where it resumes.
  usePlayerStore.setState({ scrubGesture: new AbortController().signal });
  player.seek(30, true);
  expect(usePlayerStore.getState().time).toBe(70);
  player.seek(12, true);
  expect(usePlayerStore.getState().time).toBe(70);
  usePlayerStore.setState({ scrubGesture: undefined });
  // A key stepping back from the join lands just before the cut instead of sticking.
  player.seek(69, true);
  expect(usePlayerStore.getState().time).toBe(10);
  player.seek(11, true);
  expect(usePlayerStore.getState().time).toBe(70);
});

it("plays on past the listen's end after a seek beyond it", () => {
  release = player.audition(AFTER, FPS);
  player.seek(80, true);
  reach(80.5);
  reach(81);
  expect(video.paused).toBe(false);
  expect(usePlayerStore.getState().time).toBe(81);
});

/** A press on the timeline at `time`, released without moving. */
function press(time: number) {
  const gesture = new AbortController();
  const finish = pauseForScrub(gesture.signal);
  player.seek(time, true);
  gesture.abort();
  finish();
}

it("plays from a point picked on the timeline after the listen ran to its end", () => {
  release = player.audition(AFTER, FPS);
  reach(72);
  reach(73.02);
  expect(video.paused).toBe(true);
  // The listen stopped by itself. A press elsewhere plays from there, not from the listen's top.
  press(90);
  expect(video.currentTime).toBe(90);
  expect(video.paused).toBe(false);

  // Paused by the editor, a press only moves.
  player.pause();
  press(40);
  expect(usePlayerStore.getState().time).toBe(70);
  expect(video.paused).toBe(true);
});

it("plays from a point picked in an edit's passage after it ran to its end", () => {
  release = player.previewRange({ start: 40, end: 50 }, FPS);
  reach(49);
  reach(50.02);
  expect(video.paused).toBe(true);
  expect(usePlayerStore.getState().time).toBe(50);
  press(44);
  expect(video.currentTime).toBe(44);
  expect(video.paused).toBe(false);

  // A press that leaves it at the end by hand is not a passage that ran out.
  player.pause();
  press(50);
  expect(video.paused).toBe(true);
  press(44);
  expect(video.paused).toBe(true);
});

/**
 * The window's own timing: a play or a pause shows on the video at once, and its event arrives afterwards.
 * The returned function delivers the events still on their way.
 */
function windowTiming() {
  let paused = true;
  const coming: string[] = [];
  vi.spyOn(video, "paused", "get").mockImplementation(() => paused);
  vi.spyOn(video, "play").mockImplementation(async () => { if (paused) { paused = false; coming.push("play"); } });
  vi.spyOn(video, "pause").mockImplementation(() => { if (!paused) { paused = true; coming.push("pause"); } });
  return () => { for (const event of coming.splice(0)) video.dispatchEvent(new Event(event)); };
}

it("pauses for a press on the timeline and plays on from its release, and tells the store of each when the video does", () => {
  const heard = windowTiming();
  player.play();
  expect(video.paused).toBe(false);
  heard();
  expect(usePlayerStore.getState().playing).toBe(true);
  const gesture = new AbortController();
  const finish = pauseForScrub(gesture.signal);
  expect(video.paused).toBe(true);
  // The store's flag is the video's own events' to change. A press outside an open edit's passage reads it at this
  // moment, before the pause has been heard, and so plays on at once from the point pressed.
  expect(usePlayerStore.getState().playing).toBe(true);
  heard();
  expect(usePlayerStore.getState().playing).toBe(false);
  player.seek(40, true);
  gesture.abort();
  finish();
  expect([video.paused, video.currentTime]).toEqual([false, 40]);
  heard();
  expect(usePlayerStore.getState().playing).toBe(true);
});

it("jumps over a long Before's middle as it plays, but plays the middle after a seek into it", () => {
  release = player.audition({ start: 8, end: 72, skips: [{ start: 13, end: 67 }] }, FPS);
  reach(12);
  reach(13.1);
  expect(video.currentTime).toBe(67);
  expect(video.paused).toBe(false);

  player.seek(40, true);
  reach(40.5);
  reach(41);
  expect(usePlayerStore.getState().time).toBe(41);
  expect(video.paused).toBe(false);
});

it("ends the listen on release, and a thread preview takes over the transport", () => {
  release = player.audition(AFTER, FPS);
  release();
  release = undefined;
  expect(video.paused).toBe(true);
  player.seek(30, true);
  expect(usePlayerStore.getState().time).toBe(30);

  release = player.audition(AFTER, FPS);
  const preview = player.previewRange({ start: 40, end: 50 }, FPS);
  player.seek(60, true);
  expect(usePlayerStore.getState().time).toBe(50);
  preview();
});

it("plays After from media with the cut already out, running through the join without a seek", () => {
  // The media is the version the cut made: 10–70 s is gone, so its 10 s is the join. The transport keeps the version before.
  player.setJoins(video, joinClock([{ start: 10, end: 70 }], 120));
  expect(usePlayerStore.getState().duration).toBe(120);
  release = player.audition(AFTER, FPS);
  expect(video.currentTime).toBe(8);
  expect(usePlayerStore.getState().time).toBe(8);
  // Half a reading from the cut, where a listen on the uncut media would seek: here nothing moves the media.
  reach(9.96);
  reach(9.99);
  expect(video.currentTime).toBe(9.99);
  expect(usePlayerStore.getState().time).toBe(9.99);
  // Playback crosses the join inside the rendered media, and the playhead moves to where the footage resumes.
  reach(10.02);
  expect(video.currentTime).toBe(10.02);
  expect(video.paused).toBe(false);
  expect(usePlayerStore.getState().time).toBeCloseTo(70.02, 6);
  reach(12.9);
  reach(13.02);
  expect(video.paused).toBe(true);
  expect(usePlayerStore.getState().time).toBe(73);

  // Seeks are in the transport's clock. A point inside the removed footage lands on the join.
  usePlayerStore.setState({ scrubGesture: new AbortController().signal });
  player.seek(30, true);
  usePlayerStore.setState({ scrubGesture: undefined });
  expect(usePlayerStore.getState().time).toBe(70);
  expect(video.currentTime).toBe(10);
  player.seek(95, true);
  expect(video.currentTime).toBe(35);
  expect(player.mediaTime(95)).toBe(35);

  // A new element plays its own clock until it's given one.
  player.detach();
  player.attach(video);
  expect(player.mediaTime(95)).toBe(95);
});

it("takes up the same listen again where it is, and leaves it paused if the editor paused it", () => {
  release = player.audition(AFTER, FPS);
  reach(9);
  player.pause();
  // The working cut changed under the open edit: the listen is set up again, not chosen again.
  release();
  release = player.audition({ ...AFTER }, FPS, true);
  expect(video.paused).toBe(true);
  expect(usePlayerStore.getState().time).toBe(9);
  // Chosen again by the editor, it plays from its top.
  release();
  release = player.audition(AFTER, FPS);
  expect(video.paused).toBe(false);
  expect(video.currentTime).toBe(8);
});

it("carries on playing a listen that was playing when it was set up again", () => {
  release = player.audition(AFTER, FPS);
  reach(9);
  release();
  expect(video.paused).toBe(true);
  release = player.audition({ ...AFTER }, FPS, true);
  expect(video.paused).toBe(false);
  expect(video.currentTime).toBe(9);
  // A pause in between is the editor's, and it holds.
  release();
  player.pause();
  release = player.audition({ ...AFTER }, FPS, true);
  expect(video.paused).toBe(true);
});

it("keeps a finished listen finished when it is set up again, so Play starts it over", () => {
  release = player.audition(AFTER, FPS);
  reach(72);
  reach(73.02);
  release();
  release = player.audition({ ...AFTER }, FPS, true);
  expect(video.paused).toBe(true);
  player.play();
  expect(video.currentTime).toBe(8);
});

it("takes up an edit's passage again without replaying it", () => {
  let preview = player.previewRange({ start: 40, end: 50 }, FPS);
  expect(video.paused).toBe(false);
  reach(44);
  player.pause();
  preview();
  preview = player.previewRange({ start: 40, end: 50 }, FPS, undefined, true);
  expect(video.paused).toBe(true);
  expect(usePlayerStore.getState().time).toBe(44);
  preview();
});

it("leaves the playhead to a clip playing over the monitor, stops that clip with the video, and takes up from where the clip got to", () => {
  player.play();
  reach(13);
  expect(usePlayerStore.getState().time).toBe(13);
  const clip = { pause: vi.fn() };
  const takeBack = player.lendPlayhead(clip);
  expect(video.paused).toBe(true);
  expect(clip.pause).not.toHaveBeenCalled();
  // The clip starts at the top of its passage. The media's own pause and seek land late, and its clock still reads
  // where it stopped: none of them puts the playhead back there.
  usePlayerStore.getState().setTime(11.5);
  video.dispatchEvent(new Event("pause"));
  video.dispatchEvent(new Event("seeked"));
  reach(13.2);
  expect(usePlayerStore.getState().time).toBe(11.5);
  // Whatever stops the video stops the clip, a press on the timeline included.
  player.pause();
  expect(clip.pause).toHaveBeenCalledTimes(1);
  press(11.5);
  expect(clip.pause).toHaveBeenCalledTimes(2);
  // Handed back, the media goes to where the clip got to, its clock is read again, and a pause is its own.
  usePlayerStore.getState().setTime(14);
  takeBack();
  expect(video.currentTime).toBe(14);
  reach(15);
  expect(usePlayerStore.getState().time).toBe(15);
  player.pause();
  expect(clip.pause).toHaveBeenCalledTimes(2);
  // A clip that took the playhead since keeps it when an earlier one lets go late.
  const next = { pause: vi.fn() };
  const nextBack = player.lendPlayhead(next);
  takeBack();
  usePlayerStore.getState().setTime(3);
  reach(15.5);
  expect(usePlayerStore.getState().time).toBe(3);
  nextBack();
});

it("logs a play the window refused as a failure, and one a pause cut short as nothing more than that", async () => {
  const lines: string[] = [], levels: string[] = [];
  startAppLog((batch, level) => { for (const line of batch) { lines.push(line.replace(/^\[playback\] \S+ \S+ /, "")); levels.push(level); } });
  try {
    const play = vi.spyOn(video, "play").mockRejectedValue(new DOMException("The request is not allowed by the user agent", "NotAllowedError"));
    player.play();
    await Promise.resolve();
    expect(lines.at(-1)).toBe('transport play-failed error="NotAllowedError: The request is not allowed by the user agent"');
    expect(levels.at(-1)).toBe("warn");
    play.mockRejectedValue(new DOMException("The play() request was interrupted by a call to pause()", "AbortError"));
    player.play();
    await Promise.resolve();
    stopAppLog();
    expect(lines.at(-1)).toMatch(/^transport play-interrupted error="AbortError: /);
    expect(levels.filter(level => level === "warn")).toHaveLength(1);
  } finally {
    stopAppLog();
  }
});

it("steps back past a cut that is already out of the media, instead of landing on its join again", () => {
  // Two cuts are out of this media. The listen is for the first; the second is another cut of the same pass.
  player.setJoins(video, joinClock([{ start: 10, end: 70 }, { start: 80, end: 90 }], 120));
  release = player.audition(AFTER, FPS);
  video.pause();
  // ← from a moment: a seek five seconds back, then the element's own reading of where it is.
  const back = (from: number) => {
    player.seek(from, true);
    video.dispatchEvent(new Event("seeked"));
    player.seek(usePlayerStore.getState().time - 5, true);
    video.dispatchEvent(new Event("seeked"));
    return usePlayerStore.getState().time;
  };
  // A second past the cut, five back is inside it. It lands a frame before the cut, not back at 70 where it resumes.
  expect(back(71)).toBeCloseTo(10 - 1 / FPS, 6);
  expect(video.currentTime).toBeCloseTo(10 - 1 / FPS, 6);
  // And goes on back from there.
  expect(back(usePlayerStore.getState().time)).toBeCloseTo(5 - 1 / FPS, 6);
  expect(back(usePlayerStore.getState().time)).toBe(0);
  // The same at the other cut, which this listen doesn't step over itself.
  expect(back(91)).toBeCloseTo(80 - 1 / FPS, 6);
  // Five back from exactly where the footage resumes is inside the cut as well.
  expect(back(70)).toBeCloseTo(10 - 1 / FPS, 6);
  // Forward, and a scrub, still land where the footage resumes.
  player.seek(9, true);
  player.seek(14, true);
  video.dispatchEvent(new Event("seeked"));
  expect(usePlayerStore.getState().time).toBe(70);
});

it("gives a new element the speed the editor picked, so a source set on it later doesn't drop it to 1×", () => {
  usePlayerStore.setState({ rate: 1.5 });
  const next = document.createElement("video");
  document.body.append(next);
  player.attach(next);
  expect([next.playbackRate, next.defaultPlaybackRate]).toEqual([1.5, 1.5]);
  expect(usePlayerStore.getState().rate).toBe(1.5);
  player.attach(video);
  next.remove();
});
