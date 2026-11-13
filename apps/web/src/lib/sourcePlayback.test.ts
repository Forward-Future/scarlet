// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { startAppLog, stopAppLog } from "./appLog";
import { openSourcePlayback } from "./sourcePlayback";

function open() {
  const video = document.createElement("video");
  let paused = true;
  vi.spyOn(video, "paused", "get").mockImplementation(() => paused);
  vi.spyOn(video, "readyState", "get").mockReturnValue(4);
  vi.spyOn(video, "play").mockImplementation(async () => { paused = false; });
  vi.spyOn(video, "pause").mockImplementation(() => { paused = true; });
  const chunkUrl = vi.fn((index: number) => "/chunk/" + index);
  const event = (name: string) => video.dispatchEvent(new Event(name));
  const onState = vi.fn();
  const session = openSourcePlayback(video, { original: "/original", chunkUrl, start: 44, duration: 67, rate: 1.5, onState });
  event("loadedmetadata");
  return { video, session, event, chunkUrl, onState };
}
afterEach(() => { stopAppLog(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("uses only the original for smooth playback, short waits, pauses and seeks", async () => {
  vi.useFakeTimers();
  const { video, session, event, chunkUrl } = open();
  session.prepare(); await video.play();
  event("waiting");
  vi.advanceTimersByTime(300);
  event("playing");
  vi.advanceTimersByTime(2000);
  event("stalled"); session.seek(61); vi.advanceTimersByTime(2000);
  event("waiting"); session.pause(); vi.advanceTimersByTime(2000);
  expect(chunkUrl).not.toHaveBeenCalled();
  expect(video.getAttribute("src")).toBe("/original");
  session.dispose();
});

it("switches just the stalled window, preserves the source clock and rate, then retries the original", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response()));
  const { video, session, event, chunkUrl } = open();
  session.prepare(); await video.play();
  event("waiting"); event("stalled");
  await vi.advanceTimersByTimeAsync(1500);
  expect(chunkUrl.mock.calls).toEqual([[5]]);
  expect(session.sourceTime()).toBe(44);
  event("loadedmetadata");
  expect(video.currentTime).toBe(4);
  expect(video.playbackRate).toBe(1.5);
  session.seek(45);
  expect(video.currentTime).toBe(5);
  event("ended"); event("loadedmetadata");
  expect(video.getAttribute("src")).toBe("/original");
  expect(session.sourceTime()).toBe(48);
  session.dispose();
});

it("keeps the original running during a slow encode and ignores its result after a seek", async () => {
  vi.useFakeTimers();
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  const { video, session, event, chunkUrl } = open();
  session.prepare(); await video.play();
  event("waiting"); vi.advanceTimersByTime(1500);
  expect(chunkUrl).toHaveBeenCalledTimes(1);
  expect(video.getAttribute("src")).toBe("/original");
  session.seek(57);
  finish(new Response()); await Promise.resolve();
  expect(video.getAttribute("src")).toBe("/original");
  expect(session.sourceTime()).toBe(57);
  session.dispose();
});

it("waits for Play after a codec error, follows a distant seek and stops at the final chunk", () => {
  const { session, event, chunkUrl } = open();
  event("error");
  expect(chunkUrl).not.toHaveBeenCalled();
  session.prepare(); event("loadedmetadata");
  session.seek(65); event("loadedmetadata"); event("ended");
  expect(session.sourceTime()).toBe(65);
  expect(chunkUrl.mock.calls).toEqual([[5], [8]]);
  session.dispose();
});

it("prepares one upcoming compatibility chunk while playing and drops stale lookahead on seek", async () => {
  const fetchChunk = vi.fn<typeof fetch>().mockResolvedValue(new Response());
  vi.stubGlobal("fetch", fetchChunk);
  const { video, session, event } = open();
  event("error");
  session.prepare();
  await video.play();
  event("loadedmetadata");
  event("playing"); event("playing");
  expect(fetchChunk).toHaveBeenCalledExactlyOnceWith("/chunk/6", expect.objectContaining({ method: "HEAD" }));
  expect(video.getAttribute("src")).toBe("/chunk/5");
  const request = fetchChunk.mock.calls[0]![1]!.signal!;
  session.seek(65); event("loadedmetadata"); event("playing");
  expect(request.aborted).toBe(true);
  expect(fetchChunk).toHaveBeenCalledTimes(1);
  session.dispose();
});

it.each(["before", "after"])("shows a paused seek when the original decoder fails %s the drag", (order) => {
  vi.useFakeTimers();
  const { video, session, event, chunkUrl } = open();
  if (order === "before") event("error");
  session.seek(21, true);
  session.seek(58.125, true);
  if (order === "after") event("error");
  expect(session.sourceTime()).toBe(58.125);
  expect(chunkUrl).not.toHaveBeenCalled();
  if (order === "before") session.finishSeek();
  else vi.advanceTimersByTime(100);
  expect(chunkUrl.mock.calls).toEqual([[7]]);
  event("loadedmetadata");
  expect(video.currentTime).toBe(2.125);
  expect(session.sourceTime()).toBe(58.125);
  expect(video.play).not.toHaveBeenCalled();
  session.dispose();
});

it("detects sustained dropped frames even when the media clock keeps advancing", async () => {
  const { video, session, event, chunkUrl } = open();
  let frames = 100;
  const quality = () => ({ totalVideoFrames: frames, droppedVideoFrames: Math.max(0, frames - 130) });
  Object.defineProperty(video, "getVideoPlaybackQuality", { value: quality });
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response()));
  session.prepare(); await video.play(); event("timeupdate");
  frames += 45; clock.mockReturnValue(1600); event("timeupdate");
  await Promise.resolve();
  expect(chunkUrl.mock.calls).toEqual([[5]]);
  session.dispose();
});

it.each([
  ["the engine can't make it", () => Promise.resolve(new Response(null, { status: 503 })), "Error: Preview unavailable (503)"],
  ["the engine can't be reached", () => Promise.reject(new TypeError("Load failed")), "TypeError: Load failed"],
])("stays on the original when %s, logs it, and doesn't ask for that stretch again", async (_why, answer, reason) => {
  vi.useFakeTimers();
  const lines: string[] = [], levels: string[] = [];
  startAppLog((batch, level) => { lines.push(...batch); levels.push(level); });
  const fetchChunk = vi.fn<typeof fetch>(answer);
  vi.stubGlobal("fetch", fetchChunk);
  const { video, session, event, onState } = open();
  session.prepare(); await video.play();
  event("waiting");
  await vi.advanceTimersByTimeAsync(1500);
  expect(fetchChunk).toHaveBeenCalledExactlyOnceWith("/chunk/5", expect.objectContaining({ method: "HEAD" }));
  expect(video.getAttribute("src")).toBe("/original");
  expect(onState.mock.calls.map(call => call[0]).slice(-2)).toEqual(["loading", "ready"]);
  expect(lines).toEqual([expect.stringMatching(new RegExp(`^\\[playback\\] .* source chunk-failed chunk=5 error="${reason.replace(/[()]/g, "\\$&")}"$`))]);
  expect(levels).toEqual(["warn"]);
  // Another stall in the same stretch: the original is all there is.
  event("playing"); event("waiting");
  await vi.advanceTimersByTimeAsync(1500);
  expect(fetchChunk).toHaveBeenCalledTimes(1);
  session.dispose();
});
