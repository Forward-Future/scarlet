// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProject, timelineFromKeepRanges, type Change, type CutAssessment, type CutReview, type TimeRange } from "@scarlet/timeline";
import { api } from "../../lib/client";
import { player } from "../../lib/player";
import { usePlayerStore } from "../../stores/player";
import { callToPrepare, usePrepareNextCut } from "./usePrepareNextCut";

const project = createProject("Review");
const original = { ...timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 60 }]), version: "original" };
const proposed = { ...timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 5 }, { start: 10, end: 40 }, { start: 43, end: 60 }]), version: "proposed" };
const cut = { start: 40, end: 43 };
const call: CutAssessment = { ...cut, index: 1, verdict: "ask", reason: "A different take." };
const review: CutReview = { original, proposed, firstCut: false, cuts: [{ removed: { start: 5, end: 10 }, at: 5, beforeClip: 0 }, { removed: cut, at: 35, beforeClip: 1 }] };
const target = callToPrepare({} as Change, call, cut, original, review);
function Review({ upcoming = target, paused = false, opened }: { upcoming?: typeof target | null; paused?: boolean; opened?: { version: string; removed: TimeRange } }) {
  usePrepareNextCut({ ...project, mediaPaused: paused }, 0, upcoming ?? undefined, opened);
  return null;
}

let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
  usePlayerStore.getState().setPlaying(false);
  vi.spyOn(api, "preparePlayback").mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(() => root.unmount());
  usePlayerStore.getState().setPlaying(false);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("warms the next join on the edited clock first, then the original footage, when playback starts", async () => {
  await act(() => root.render(<Review />));
  await vi.advanceTimersByTimeAsync(500);
  expect(api.preparePlayback).not.toHaveBeenCalled();
  usePlayerStore.setState({ playing: true, playbackReady: true });
  await vi.advanceTimersByTimeAsync(250);
  expect(vi.mocked(api.preparePlayback).mock.calls.map(([, version, times]) => [version, times])).toEqual([
    ["proposed", [33, 35]], ["original", [38, 43, 40]],
  ]);
});

it("waits for playable foreground media through a cold Play, buffering and a seek", async () => {
  const video = document.createElement("video");
  const ready = vi.spyOn(video, "readyState", "get").mockReturnValue(1);
  vi.spyOn(video, "paused", "get").mockReturnValue(false);
  player.attach(video);
  try {
    await act(() => root.render(<Review />));
    video.dispatchEvent(new Event("play"));
    video.dispatchEvent(new Event("waiting"));
    await vi.advanceTimersByTimeAsync(500);
    expect(api.preparePlayback).not.toHaveBeenCalled();

    ready.mockReturnValue(3);
    video.dispatchEvent(new Event("playing"));
    await vi.advanceTimersByTimeAsync(100);
    video.dispatchEvent(new Event("seeking"));
    ready.mockReturnValue(2);
    video.dispatchEvent(new Event("seeked"));
    await vi.advanceTimersByTimeAsync(500);
    expect(api.preparePlayback).not.toHaveBeenCalled();

    ready.mockReturnValue(4);
    video.dispatchEvent(new Event("playing"));
    await vi.advanceTimersByTimeAsync(250);
    expect(api.preparePlayback).toHaveBeenCalledTimes(2);
  } finally {
    player.detach();
  }
});

it("uses the original when another proposed cut would change the next call's lead-in", async () => {
  const adjacent = { ...review, cuts: [...review.cuts, { at: 34, removed: { start: 38, end: 39 }, beforeClip: 1 }] };
  const next = callToPrepare({} as Change, call, cut, original, adjacent);
  usePlayerStore.setState({ playing: true, playbackReady: true });
  await act(() => root.render(<Review upcoming={next} />));
  await vi.advanceTimersByTimeAsync(250);
  expect(vi.mocked(api.preparePlayback).mock.calls.map(([, version]) => version)).toEqual(["original"]);
});

it("cancels on pause of media processing, but allows a real viewer to take over an unfinished render", async () => {
  vi.mocked(api.preparePlayback).mockImplementation(() => new Promise(() => {}));
  usePlayerStore.setState({ playing: true, playbackReady: true });
  await act(() => root.render(<Review />));
  await vi.advanceTimersByTimeAsync(250);
  const signal = vi.mocked(api.preparePlayback).mock.calls[0]![3];
  await act(() => root.render(<Review paused />));
  expect(signal.aborted).toBe(true);
  await act(() => root.render(<Review />));
  await vi.advanceTimersByTimeAsync(250);
  const handoff = vi.mocked(api.preparePlayback).mock.calls[1]![3];
  await act(() => root.render(<Review upcoming={null} opened={{ version: original.version, removed: cut }} />));
  expect(handoff.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(handoff.aborted).toBe(true);
});
