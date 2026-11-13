// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { parkVideo } from "./parkVideo";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("decodes silently up to the first frame, pauses there and restores the user's media settings on handoff", async () => {
  const video = document.createElement("video");
  video.playbackRate = 1.5;
  vi.spyOn(video, "readyState", "get").mockReturnValue(3);
  const play = vi.spyOn(video, "play").mockResolvedValue();
  const pause = vi.spyOn(video, "pause");
  let frame!: FrameRequestCallback;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
  const seek = vi.fn((time: number) => { video.currentTime = time; });
  const stop = parkVideo(video, 4, 30, seek);
  await Promise.resolve();
  expect(play).toHaveBeenCalledOnce();
  expect([video.muted, video.playbackRate, video.currentTime]).toEqual([true, 1, 3.55]);
  video.currentTime = 4;
  frame(450);
  expect(pause).toHaveBeenCalledOnce();
  stop();
  expect([video.muted, video.playbackRate, video.currentTime]).toEqual([false, 1.5, 4]);
});

it("keeps the queued decoder parked across equivalent cut coordinates", () => {
  const video = document.createElement("video");
  video.currentTime = 3.99;
  vi.spyOn(video, "readyState", "get").mockReturnValue(4);
  const seek = vi.fn();
  const play = vi.spyOn(video, "play");
  const stop = parkVideo(video, 4, 30, seek);
  expect(seek).not.toHaveBeenCalled();
  expect(play).not.toHaveBeenCalled();
  stop();
});

it("gives the visible decoder two frames before seeking the side that just played", () => {
  const video = document.createElement("video");
  const active = document.createElement("video");
  vi.spyOn(video, "readyState", "get").mockReturnValue(4);
  vi.spyOn(video, "play").mockResolvedValue();
  let layout!: FrameRequestCallback;
  let presented!: VideoFrameRequestCallback;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { layout = callback; return 1; });
  active.requestVideoFrameCallback = vi.fn(callback => { presented = callback; return 1; });
  active.cancelVideoFrameCallback = vi.fn();
  const seek = vi.fn();
  const stop = parkVideo(video, 4, 30, seek, () => active);
  layout(0);
  presented(16, {} as VideoFrameCallbackMetadata);
  expect(seek).not.toHaveBeenCalled();
  presented(50, {} as VideoFrameCallbackMetadata);
  expect(seek).toHaveBeenCalledWith(3.55);
  stop();
});

it("cancels a park before metadata arrives without playing or restoring a different mute setting", () => {
  const video = document.createElement("video");
  video.muted = true;
  const play = vi.spyOn(video, "play");
  const seek = vi.fn();
  const stop = parkVideo(video, 2, 30, seek);
  stop();
  video.dispatchEvent(new Event("loadedmetadata"));
  expect(play).not.toHaveBeenCalled();
  expect(seek).not.toHaveBeenCalled();
  expect(video.muted).toBe(true);
});
