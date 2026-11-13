// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProject, timelineFromKeepRanges, type Change, type CutAssessment, type CutReview, type TimeRange } from "@scarlet/timeline";
import type { Render } from "@scarlet/shared";
import { api } from "../../lib/client";
import { player } from "../../lib/player";
import { usePlayerStore } from "../../stores/player";
import { callToPrepare, prepareCut, type PreparedCut, usePrepareReviewCuts, type CutToPrepare } from "./usePrepareNextCut";

const project = createProject("Review");
const original = { ...timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 60 }]), version: "original" };
const proposed = { ...timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 5 }, { start: 10, end: 40 }, { start: 43, end: 60 }]), version: "proposed" };
const cut = { start: 40, end: 43 };
const call: CutAssessment = { ...cut, index: 1, verdict: "ask", reason: "A different take." };
const review: CutReview = { original, proposed, firstCut: false, cuts: [{ removed: { start: 5, end: 10 }, at: 5, beforeClip: 0 }, { removed: cut, at: 35, beforeClip: 1 }] };
const target = { ...callToPrepare({} as Change, call, cut, original, review)!, key: "call-2" };
const drafts = new Map();
const plans = new Map();
function Review({ upcoming = [target], paused = false, opened }: { upcoming?: CutToPrepare[]; paused?: boolean; opened?: { version: string; removed: TimeRange; key?: string } }) {
  const parked = usePrepareReviewCuts({ ...project, mediaPaused: paused }, 0, upcoming, drafts, plans, opened);
  return <output data-next={parked?.key} data-open-file={opened?.key && plans.get(opened.key)?.after.window?.url} />;
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  drafts.clear();
  plans.clear();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  root = createRoot(host);
  usePlayerStore.setState({ playing: false, playbackReady: false });
  vi.spyOn(api, "renders").mockResolvedValue({ renders: [] });
  vi.spyOn(api, "preparePlayback").mockResolvedValue(undefined);
  vi.spyOn(api, "cutPlaybackFile").mockRejectedValue(new Error("No standalone file"));
});
afterEach(async () => {
  await act(() => root.unmount());
  usePlayerStore.setState({ playing: false, playbackReady: false });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("warms the next join on the edited clock first, then the original footage, before the editor opens the first cut", async () => {
  await act(() => root.render(<Review />));
  expect(usePlayerStore.getState().playing).toBe(false);
  expect(vi.mocked(api.preparePlayback).mock.calls.map(([, version, times]) => [version, times])).toEqual([
    ["proposed", [33, 35, 38 - 1 / project.settings.fps]], ["original", [38, 43, 40]],
  ]);
});

it("waits for playable foreground media through a cold Play, buffering and a seek", async () => {
  const video = document.createElement("video");
  const ready = vi.spyOn(video, "readyState", "get").mockReturnValue(1);
  vi.spyOn(video, "paused", "get").mockReturnValue(false);
  player.attach(video);
  try {
    video.dispatchEvent(new Event("play"));
    video.dispatchEvent(new Event("waiting"));
    await act(() => root.render(<Review />));
    await vi.advanceTimersByTimeAsync(500);
    expect(api.preparePlayback).not.toHaveBeenCalled();

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

it("prepares just the next call when a neighboring proposed cut would remove part of its lead-in", async () => {
  const adjacent = { ...review, cuts: [...review.cuts, { at: 34, removed: { start: 38, end: 39 }, beforeClip: 1 }] };
  const next = callToPrepare({ id: "pass" } as Change, call, cut, original, adjacent);
  const draft = { ...timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 40 }, { start: 43, end: 60 }]), version: "single" };
  const request = vi.spyOn(api, "cutReviewDraft").mockResolvedValue({ draft, ontoVersion: original.version, removed: [cut] });
  usePlayerStore.setState({ playing: true, playbackReady: true });
  await act(() => root.render(<Review upcoming={[next!]} />));
  await vi.advanceTimersByTimeAsync(250);
  expect(request).toHaveBeenCalledWith("pass", [0, 2], original.version, expect.any(AbortSignal));
  expect(vi.mocked(api.preparePlayback).mock.calls.map(([, version, times]) => [version, times])).toEqual([
    ["single", [38, 40, 43 - 1 / project.settings.fps]], ["original", [38, 43, 40]],
  ]);
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
  await act(() => root.render(<Review upcoming={[]} opened={{ version: original.version, removed: cut }} />));
  expect(handoff.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(handoff.aborted).toBe(true);
});

it("prepares successive visible calls one at a time and retains work across a change in review order", async () => {
  const second = { ...callToPrepare({} as Change, { ...call, index: 0 }, { start: 5, end: 10 }, original, review)!, key: "call-1" };
  const prepare = vi.mocked(api.preparePlayback);
  let firstReady!: () => void;
  prepare.mockImplementationOnce(async () => { await new Promise<void>(resolve => { firstReady = resolve; }); });
  await act(() => root.render(<Review upcoming={[second, target]} />));
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(prepare.mock.calls[0]?.[2]).toEqual(expect.arrayContaining([3, 5]));
  await act(async () => firstReady());
  expect(prepare.mock.calls.map(([, version]) => version)).toEqual(["proposed", "original", "proposed", "original"]);
  expect(api.renders).toHaveBeenCalledTimes(2);
  expect(plans.get(second.key)?.before.version).toBe(original.version);
  await act(() => root.render(<Review upcoming={[target, second]} />));
  expect(prepare).toHaveBeenCalledTimes(4);
});


it("publishes a streaming plan immediately and upgrades each side only after its own short file is ready", async () => {
  const makeWindow = vi.mocked(api.cutPlaybackFile);
  const complete: (() => void)[] = [];
  makeWindow.mockImplementation(async (_, version, range) => {
    await new Promise<void>(resolve => { complete.push(resolve); });
    return { url: `file/${version}`, ...range };
  });
  const output: PreparedCut[] = [];
  const done = prepareCut(project.id, 30, target, new AbortController().signal, drafts, plan => output.push(plan));
  await vi.advanceTimersByTimeAsync(0);
  expect(output).toHaveLength(1);
  expect(output[0]?.after.window).toBeUndefined();
  expect(makeWindow.mock.calls.map(([, version, range]) => [version, range])).toEqual([
    ["proposed", { start: 976 / 30, end: 1141 / 30 }],
  ]);
  complete.shift()!();
  await vi.advanceTimersByTimeAsync(0);
  expect(output[1]!.after.window?.url).toBe("file/proposed");
  expect(output[1]!.before.window).toBeUndefined();
  expect(makeWindow.mock.calls[1]?.[2]).toEqual({ start: 1126 / 30, end: 1351 / 30 });
  complete.shift()!();
  await done;
  expect(output[2]!.before.window?.url).toBe("file/original");
  expect(api.preparePlayback).not.toHaveBeenCalled();
});

it("uses a completed full file without asking the encoder for either windows or fragments", async () => {
  vi.mocked(api.renders).mockImplementation(async (_, query) => ({ renders: [
    { id: `render-${query?.version}`, key: "full", state: "done" } as Render,
  ], fullRenderKeys: { context: "context", preview: "full", delivery: "delivery" } }));
  await act(() => root.render(<Review />));
  expect(plans.get(target.key)?.after.file).toContain("/renders/render-proposed/file");
  expect(plans.get(target.key)?.before.file).toContain("/renders/render-original/file");
  expect(api.cutPlaybackFile).not.toHaveBeenCalled();
  expect(api.preparePlayback).not.toHaveBeenCalled();
});

it("promotes a full render that finishes after lookup and reuses it for a different cut on the same version", async () => {
  const nextCut = review.cuts[0]!.removed;
  const next = { ...callToPrepare({} as Change, { ...call, index: 0 }, nextCut, original, review)!, key: "call-1" };
  vi.mocked(api.cutPlaybackFile).mockImplementation(async (_, version) => ({
    url: `full/${version}`, full: true, start: 0, end: version === original.version ? 60 : 52,
  }));
  await act(() => root.render(<Review upcoming={[target, next]} />));
  for (const key of [target.key, next.key]) {
    const cut = plans.get(key)!;
    expect([cut.before.file, cut.after.file]).toEqual(["full/original", "full/proposed"]);
    expect([cut.before.window, cut.after.window]).toEqual([undefined, undefined]);
  }
  expect(api.cutPlaybackFile).toHaveBeenCalledTimes(2);
  expect(api.preparePlayback).not.toHaveBeenCalled();
});

it("keeps long Before listens on the timeline stream and clips a file to the actual end frame", async () => {
  const selected = { start: 40, end: 59 };
  const edit = { ...timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 40 }, { start: 59, end: 60 }]), version: "long-cut" };
  const window = vi.mocked(api.cutPlaybackFile).mockImplementation(async (_, version, range) => ({ url: version, ...range }));
  await act(() => root.render(<Review upcoming={[{ key: "long", cut: selected, before: original, applied: true, after: { version: edit, removed: [selected] } }]} />));
  expect(window.mock.calls.map(([, version, range]) => [version, range])).toEqual([
    [edit.version, { start: 1126 / 30, end: 41 }],
  ]);
  expect(vi.mocked(api.preparePlayback).mock.calls.map(([, version]) => version)).toEqual([original.version]);
});

it("retains the next review candidate while the currently open cut gets its own file, dropping a superseded response", async () => {
  const files = vi.mocked(api.cutPlaybackFile);
  let arrive!: () => void;
  files.mockImplementationOnce(async (_, version, range) => {
    await new Promise<void>(finish => { arrive = finish; });
    return { url: version, ...range };
  }).mockImplementation(async (_, version, range) => ({ url: version, ...range }));
  const other = { ...target, key: "another" };
  await act(() => root.render(<Review upcoming={[target, other]} opened={{ key: target.key, version: original.version, removed: cut }} />));
  expect(files).toHaveBeenCalledTimes(1);
  expect(plans.get(target.key).after.window).toBeUndefined();
  await act(() => root.render(<Review upcoming={[other]} />));
  expect(files.mock.calls[0]?.[3].aborted).toBe(true);
  await act(async () => arrive());
  expect(plans.get(target.key).after.window).toBeUndefined();
  expect(plans.get(other.key).after.window.url).toBe(proposed.version);
});

it("updates an open cut with its completed file and makes the next cut available under a distinct key", async () => {
  vi.mocked(api.cutPlaybackFile).mockImplementation(async (_, version, range) => ({ url: version, ...range }));
  const next = { ...target, key: "next" };
  await act(() => root.render(<Review upcoming={[target, next]} opened={{ key: target.key, version: original.version, removed: cut }} />));
  expect(host.querySelector("output")?.dataset).toMatchObject({ next: "next", openFile: "proposed" });
  expect(api.cutPlaybackFile).toHaveBeenCalledTimes(2); // These two decisions reuse the same version, range and file.
});
