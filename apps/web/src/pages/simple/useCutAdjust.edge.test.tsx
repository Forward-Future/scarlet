// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyOps, emptyTimeline, makeMediaClip, makeTrack, splitJoinOps, type Change, type MediaAsset, type TimeRange, type Timeline, type Transcript } from "@scarlet/timeline";
import type { ThreadEdit } from "@scarlet/shared";
import type { CutAdjustOptions } from "../../components/review/TimelineCutTrim";
import type { Call } from "../../lib/passCalls";
import type { Thread } from "../../lib/threads";
import { player } from "../../lib/player";
import { useUndoStore } from "../../lib/undo";
import { useProjectStore } from "../../stores/project";
import type { AppliedCutSide } from "./useAppliedCut";
import type { Listening } from "./types";
import { useCutAdjust } from "./useCutAdjust";

/** The words the transcript window has for what's shown: the editor's recording, read in source time. */
let transcripts: Transcript[] = [];
vi.mock("../../components/transcript/useTranscriptWindow", () => ({ useTranscriptWindow: () => ({ transcripts }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FPS = 30;
const PAD = 1 / FPS;
const withClips = (version: string, extra: Timeline["tracks"] = []): Timeline => {
  const base = emptyTimeline("prj_test");
  return { ...base, version, tracks: [...base.tracks.map(t => t.kind === "video" ? { ...t, clips: [makeMediaClip("med_a", 0, 200, 0, { id: "clip_a" })] } : t), ...extra] };
};
/** The recording whole, before the cut. */
const before = withClips("v1");
/** The working cut: 50–52 s taken out. */
const working: Timeline = { ...applyOps(before, [{ op: "rippleDelete", start: 50, end: 52 }]), version: "v2" };
/** The whole recording with a caption over 10–14 s. */
const captioned = withClips("v3", [{ ...makeTrack("caption", "Captions", "c1"), clips: [{ id: "cap_1", kind: "caption", timelineIn: 10, timelineOut: 14, text: "Hello there", enabled: true }] } as Timeline["tracks"][number]]);

const word = (text: string, start: number, end: number) => ({ text, start, end });
const transcript: Transcript = {
  id: "tr_a", mediaId: "med_a",
  segments: [{ id: "s1", start: 9, end: 53, text: "", words: [
    word("hello", 9.9, 10.3), word("there", 13.6, 14), word("so", 48, 48.4), word("the", 48.5, 48.9),
    word("um", 50.1, 50.4), word("well", 50.6, 50.9), word("you", 51, 51.3), word("know", 51.4, 51.7), word("right", 51.8, 51.95), word("anyway", 52.2, 52.6),
  ] }],
};

const appliedEdit: ThreadEdit = {
  changeId: "chg_cut", spot: 0, label: "Trimmed the pause", range: { start: 50, end: 50 }, at: 50, previous: [],
  beforeCut: { version: "v1", removed: { start: 50, end: 52 } },
} as ThreadEdit;
const captionEdit = { changeId: "chg_cap", spot: 1, label: "Opening caption", range: { start: 10, end: 14 }, kind: "text", previous: [] } as unknown as ThreadEdit;
const thread = { id: "thr_1" } as Thread;

type Inputs = Parameters<typeof useCutAdjust>[0];
let adjust: CutAdjustOptions | undefined;
let container: HTMLDivElement;
let root: Root;

function Harness(props: Partial<Inputs>) {
  adjust = useCutAdjust({
    projectId: "prj_test", head: "v2", timeline: working, media: [], fps: FPS,
    otherCuts: [], stagedAround: [], setCutSide: () => {}, onAppliedRejected: () => {},
    setListening: () => {}, onDecideCall: () => {},
    ...props,
  });
  return null;
}

const render = async (props: Partial<Inputs>) => { await act(async () => { root.render(<Harness {...props} />); }); };
const commit = async (next: TimeRange) => { await act(async () => { adjust!.onCommit(next); await Promise.resolve(); await Promise.resolve(); }); };
const applied = (over: Partial<Inputs> = {}): Partial<Inputs> => ({
  timeline: working, beforeTimeline: before, reviewingEdit: appliedEdit, focusThread: thread, appliedCut: { start: 50, end: 52 }, cutKey: "cut-key", ...over,
});
const editing = (over: Partial<Inputs> = {}): Partial<Inputs> => ({ timeline: captioned, head: "v3", reviewingEdit: captionEdit, focusThread: thread, ...over });

const store = useProjectStore.getState();
const steps = () => useUndoStore.getState().steps;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  adjust = undefined;
  transcripts = [transcript];
  useUndoStore.setState({ steps: [], error: undefined });
  vi.spyOn(player, "pause").mockImplementation(() => {});
  vi.spyOn(player, "play").mockImplementation(() => Promise.resolve() as never);
  vi.spyOn(player, "seek").mockImplementation(() => {});
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useProjectStore.setState({ adjustCut: store.adjustCut, adjustEdit: store.adjustEdit, reviseStagedCut: store.reviseStagedCut });
  vi.restoreAllMocks();
});

describe("an applied cut's edges", () => {
  it("move between the cuts either side of it, a frame short of each", async () => {
    await render(applied({ otherCuts: [{ start: 10, end: 20 }, { start: 40, end: 45 }, { start: 49, end: 53 }], stagedAround: [{ removed: { start: 60, end: 61 } }, { removed: { start: 90, end: 95 } }] }));
    expect(adjust).toMatchObject({ tone: "cut", bandPrefix: "Cut", removeLabel: "Put back" });
    expect(adjust!.bounds.minStart).toBeCloseTo(45 + PAD, 6);
    expect(adjust!.bounds.maxStart).toBe(52);
    expect(adjust!.bounds.minEnd).toBe(50);
    expect(adjust!.bounds.maxEnd).toBeCloseTo(60 - PAD, 6);
  });

  it("move as far as the footage either side allows when no other cut is near", async () => {
    await render(applied());
    expect(adjust!.bounds.minStart).toBeCloseTo(PAD, 6);
    expect(adjust!.bounds.maxEnd).toBeCloseTo(200 - PAD, 6);
  });

  it("don't move for a cut too short to hold, an interior cut mapped onto 0:00, or a join the working cut doesn't have", async () => {
    await render(applied({ reviewingEdit: { ...appliedEdit, beforeCut: { version: "v1", removed: { start: 50, end: 50.01 } } } }));
    expect(adjust).toBeUndefined();
    await render(applied({ reviewingEdit: { ...appliedEdit, at: 0 } }));
    expect(adjust).toBeUndefined();
    await render(applied({ reviewingEdit: { ...appliedEdit, at: 120 } }));
    expect(adjust).toBeUndefined();
    // Hemmed in a frame from the cuts either side, neither edge has anywhere to go.
    await render(applied({ appliedCut: { start: 50, end: 50 }, otherCuts: [{ start: 49, end: 50 - PAD }], stagedAround: [{ removed: { start: 50 + PAD, end: 51 } }] }));
    expect(adjust).toBeUndefined();
  });

  it("don't move for a rejected cut, a marker, one on its way out, or with nothing open", async () => {
    for (const over of [{ reviewingEdit: { ...appliedEdit, rejected: true } }, { reviewingEdit: { ...appliedEdit, marker: true } }, { leaving: true }, { focusThread: undefined }] as Partial<Inputs>[]) {
      await render(applied(over));
      expect(adjust).toBeUndefined();
    }
    await render({});
    expect(adjust).toBeUndefined();
  });

  it("say what a drag puts back or takes out, by the words it crosses", async () => {
    await render(applied());
    const say = adjust!.describeEdge!;
    expect(say("end", 52, 50, { start: 50, end: 50 })).toEqual({ text: "Put back whole cut", tone: "put-back" });
    expect(say("start", 50, 50.01, { start: 50.01, end: 52 })).toEqual({ text: "Cut start", tone: "neutral" });
    expect(say("end", 52, 52.01, { start: 50, end: 52.01 })).toEqual({ text: "Cut end", tone: "neutral" });
    expect(say("start", 50, 51, { start: 51, end: 52 })).toEqual({ text: "Put back “um well”", tone: "put-back", delta: "+1.00 s" });
    expect(say("end", 52, 53, { start: 50, end: 53 })).toEqual({ text: "Cut “anyway”", tone: "take-out", delta: "−1.00 s" });
    expect(say("start", 50, 52, { start: 52, end: 53 })).toEqual({ text: "Put back “um well you know …”", tone: "put-back", delta: "+2.00 s" });
    expect(say("start", 50, 49, { start: 49, end: 52 })).toEqual({ text: "Cut", tone: "take-out", delta: "−1.00 s" });
    expect(say("end", 52, 51.98, { start: 50, end: 51.98 })).toEqual({ text: "Put back", tone: "put-back", delta: "+0.02 s" });
  });

  it("say only the plain change while the transcript hasn't loaded", async () => {
    transcripts = [];
    await render(applied());
    expect(adjust!.describeEdge!("start", 50, 51, { start: 51, end: 52 })).toEqual({ text: "Put back", tone: "put-back", delta: "+1.00 s" });
  });

  it("save a drag on the engine, ready to undo, and play the cut from after it", async () => {
    const adjustCut = vi.fn(async () => ({ version: "v4", rejected: false }));
    useProjectStore.setState({ adjustCut });
    const setCutSide = vi.fn();
    await render(applied({ setCutSide, singleEdit: true, cutName: "Cut 0:50" }));
    await commit({ start: 50.5, end: 52 });
    expect(adjustCut).toHaveBeenCalledWith("thr_1", "v2",
      { changeId: "chg_cut", spot: 0, label: "Trimmed the pause", range: { start: 50, end: 50 }, at: 50, before: appliedEdit.beforeCut },
      { start: 50.5, end: 52 });
    expect(steps()).toEqual([expect.objectContaining({ kind: "revision", word: "Adjust", projectId: "prj_test", version: "v4", threadId: "thr_1", edit: { changeId: "chg_cut", spot: 0, single: true }, name: "Cut 0:50" })]);
    expect(player.pause).toHaveBeenCalled();
    const next = setCutSide.mock.calls[0]![0] as (prev: AppliedCutSide | undefined) => AppliedCutSide;
    expect(next(undefined)).toEqual({ key: "cut-key", side: "after", take: 1 });
    expect(next({ key: "cut-key", side: "after", take: 2 } as AppliedCutSide)).toMatchObject({ take: 3 });
    expect(next({ key: "other", side: "after", take: 5 } as AppliedCutSide)).toMatchObject({ take: 1 });
  });

  it("puts the whole cut back when pulled to nothing, and hands over to the version the engine made when it rejects the cut", async () => {
    const adjustCut = vi.fn(async (..._args: unknown[]) => ({ version: "v5", rejected: true }));
    useProjectStore.setState({ adjustCut });
    const onEngineLeave = vi.fn(), onAppliedRejected = vi.fn();
    await render(applied({ onEngineLeave, onAppliedRejected }));
    await commit({ start: 51, end: 51 });
    expect(adjustCut.mock.calls[0]![3]).toEqual({ start: 51, end: 51 });
    expect(onEngineLeave.mock.calls).toEqual([[true]]);
    expect(onAppliedRejected).toHaveBeenCalledWith("v5");
    expect(steps()).toEqual([expect.objectContaining({ word: "Reject", version: "v5", edit: { changeId: "chg_cut", spot: 0 } })]);
    expect(steps()[0]).not.toHaveProperty("name");
    expect(player.pause).not.toHaveBeenCalled();
  });

  it("says why a drag couldn't be saved and stays on the cut", async () => {
    useProjectStore.setState({ adjustCut: vi.fn(async () => { throw new Error("The project moved on."); }) });
    const onEngineLeave = vi.fn();
    await render(applied({ onEngineLeave }));
    await commit({ start: 51, end: 51 });
    expect(onEngineLeave.mock.calls).toEqual([[true], [false]]);
    expect(useUndoStore.getState().error).toEqual({ projectId: "prj_test", text: "The project moved on." });
    await commit({ start: 50.5, end: 52 });
    expect(onEngineLeave).toHaveBeenCalledTimes(2);
  });

  it("saves one drag at a time, and none without a head or a cut key", async () => {
    const answer = deferred<{ version: string; rejected: boolean }>();
    const adjustCut = vi.fn(() => answer.promise);
    useProjectStore.setState({ adjustCut });
    await render(applied());
    await commit({ start: 50.5, end: 52 });
    await commit({ start: 50.6, end: 52 });
    expect(adjustCut).toHaveBeenCalledTimes(1);
    await act(async () => { answer.resolve({ version: "v4", rejected: false }); });
    await commit({ start: 50.6, end: 52 });
    expect(adjustCut).toHaveBeenCalledTimes(2);

    await render(applied({ head: null }));
    await commit({ start: 50.5, end: 52 });
    await render(applied({ cutKey: undefined }));
    await commit({ start: 50.5, end: 52 });
    expect(adjustCut).toHaveBeenCalledTimes(2);
  });
});

describe("a timed edit's edges", () => {
  it("move a caption, named for its kind, with Remove at nothing", async () => {
    await render(editing());
    expect(adjust).toMatchObject({ tone: "edit", bandPrefix: "Text", removeLabel: "Remove" });
    expect(adjust!.bounds).toMatchObject({ minStart: 0, maxStart: 14, minEnd: 10 });
  });

  it("read the clips the change made or changed, and the whole timeline when it names none", async () => {
    for (const ops of [[{ op: "addClip", trackId: "c1", clip: { id: "cap_1" } }, { op: "updateClip", clipId: "cap_1", patch: {} }], [{ op: "rippleDelete", start: 0, end: 1 }], []]) {
      await render(editing({ shownChange: { id: "chg_cap", ops } as unknown as Change }));
      expect(adjust?.bounds.maxStart).toBe(14);
    }
  });

  it("don't move for a moment, a marked range, an edit at a point, or one Scarlet must rethink", async () => {
    for (const over of [{ selectedMoment: true }, { hasReviewRange: true }, { reviewingEdit: { ...captionEdit, range: { start: 10, end: 10 } } },
      { reviewingEdit: { ...captionEdit, at: 10 } }, { reviewingEdit: { ...captionEdit, kind: "cut" } }, { leaving: true }] as Partial<Inputs>[]) {
      await render(editing(over));
      expect(adjust).toBeUndefined();
    }
  });

  it("say where a dragged edge now starts or ends, and the word it lands on", async () => {
    await render(editing());
    const say = adjust!.describeEdge!;
    expect(say("end", 14, 10, { start: 10, end: 10 })).toEqual({ text: "Remove text", tone: "take-out" });
    expect(say("start", 10, 10.01, { start: 10.01, end: 14 })).toEqual({ text: "Starts here", tone: "neutral" });
    expect(say("end", 14, 14.01, { start: 10, end: 14.01 })).toEqual({ text: "Ends here", tone: "neutral" });
    expect(say("start", 10, 9, { start: 9, end: 14 })).toEqual({ text: "Starts earlier", tone: "put-back", delta: "+1.00 s" });
    expect(say("start", 10, 10.1, { start: 10.1, end: 14 })).toEqual({ text: "Starts later · on “hello”", tone: "neutral", delta: "−0.10 s" });
    expect(say("end", 14, 15, { start: 10, end: 15 })).toEqual({ text: "Ends later", tone: "put-back", delta: "+1.00 s" });
    expect(say("end", 14, 13.8, { start: 10, end: 13.8 })).toEqual({ text: "Ends earlier · on “there”", tone: "neutral", delta: "−0.20 s" });
  });

  it("names an edit of no kind plainly when pulled to nothing", async () => {
    await render(editing({ reviewingEdit: { ...captionEdit, kind: undefined } }));
    expect(adjust).toMatchObject({ bandPrefix: "Edit", removeLabel: "Remove" });
    expect(adjust!.describeEdge!("start", 10, 14, { start: 14, end: 14 })?.text).toBe("Remove edit");
  });

  it("call a split edit pulled to nothing a straight cut", async () => {
    const media = [{ id: "m_main", kind: "video", name: "main.mp4", path: "main.mp4", duration: 20, fps: 30, hasAudio: true }] as MediaAsset[];
    const raw = { ...emptyTimeline("prj_test"), version: "v6", tracks: [{ ...makeTrack("video", "V1", "v1"), clips: [makeMediaClip("m_main", 0, 5, 0, { id: "shot1" }), makeMediaClip("m_main", 8, 16, 5, { id: "shot2" })] }] } as Timeline;
    const split = applyOps(raw, splitJoinOps(raw, media, FPS, [{ at: 5, shift: -0.5 }]).ops);
    await render(editing({ timeline: split, media, reviewingEdit: { ...captionEdit, kind: "split", range: { start: 4.5, end: 5 } } }));
    expect(adjust).toMatchObject({ bandPrefix: "Split edit", removeLabel: "Straight cut" });
    expect(adjust!.describeEdge!("start", 4.5, 5, { start: 5, end: 5 })).toEqual({ text: "Straight cut", tone: "take-out" });
  });

  it("save a drag on the engine and play from a second before the edge that moved", async () => {
    const adjustEdit = vi.fn(async () => ({ version: "v7", rejected: false }));
    useProjectStore.setState({ adjustEdit });
    await render(editing({ cutName: "Edit 0:10" }));
    await commit({ start: 9, end: 14 });
    expect(adjustEdit).toHaveBeenCalledWith("thr_1", "v3", { changeId: "chg_cap", spot: 1, label: "Opening caption", range: { start: 10, end: 14 }, kind: "text" }, { start: 9, end: 14 });
    expect(player.seek).toHaveBeenLastCalledWith(8, true);
    expect(player.play).toHaveBeenCalled();
    expect(steps()).toEqual([expect.objectContaining({ kind: "revision", word: "Adjust", version: "v7", edit: { changeId: "chg_cap", spot: 1 }, name: "Edit 0:10" })]);

    await commit({ start: 10, end: 15 });
    expect(player.seek).toHaveBeenLastCalledWith(14, true);
    await commit({ start: 0.5, end: 14 });
    expect(player.seek).toHaveBeenLastCalledWith(0, true);
  });

  it("leaves out an edit's kind when it has none, and hands over when the engine rejects a removal", async () => {
    const adjustEdit = vi.fn(async (..._args: unknown[]) => ({ version: "v8", rejected: true }));
    useProjectStore.setState({ adjustEdit });
    const onEngineLeave = vi.fn(), onAppliedRejected = vi.fn();
    await render(editing({ reviewingEdit: { ...captionEdit, kind: undefined }, onEngineLeave, onAppliedRejected, singleEdit: true }));
    await commit({ start: 12, end: 12 });
    expect(adjustEdit.mock.calls[0]![2]).toEqual({ changeId: "chg_cap", spot: 1, label: "Opening caption", range: { start: 10, end: 14 } });
    expect(onEngineLeave.mock.calls).toEqual([[true]]);
    expect(onAppliedRejected).toHaveBeenCalledWith("v8");
    expect(steps()).toEqual([expect.objectContaining({ word: "Reject", edit: { changeId: "chg_cap", spot: 1, single: true } })]);
    expect(player.seek).not.toHaveBeenCalled();
  });

  it("says why a drag couldn't be saved, and saves one at a time", async () => {
    const answer = deferred<{ version: string; rejected: boolean }>();
    const adjustEdit = vi.fn(() => answer.promise);
    useProjectStore.setState({ adjustEdit });
    const onEngineLeave = vi.fn();
    await render(editing({ onEngineLeave }));
    await commit({ start: 12, end: 12 });
    await commit({ start: 9, end: 14 });
    expect(adjustEdit).toHaveBeenCalledTimes(1);
    await act(async () => { answer.resolve(Promise.reject(new Error("No such clip.")) as never); });
    expect(onEngineLeave.mock.calls).toEqual([[true], [false]]);
    expect(useUndoStore.getState().error).toEqual({ projectId: "prj_test", text: "No such clip." });

    adjustEdit.mockClear();
    await render(editing({ head: null }));
    await commit({ start: 9, end: 14 });
    expect(adjustEdit).not.toHaveBeenCalled();
  });
});

describe("a waiting call's edges", () => {
  const heard = { start: 105, end: 107 };
  const openCall = { index: 1, start: 105, end: 107, verdict: "ask", reason: "A retake.", summary: "Second take" } as Call;
  const listening: Listening = { changeId: "chg_pass", index: 1, cut: heard, side: "after", take: 0, key: "chg_pass/1" };
  const callView = { timeline: before, cut: heard, duration: 200, toWorking: { toMedia: (t: number) => t + 10 }, shown: [{ removed: { start: 103, end: 104 } }, { removed: { start: 108, end: 109 } }] };
  const calling = (over: Partial<Inputs> = {}): Partial<Inputs> => ({
    timeline: null, pass: { id: "chg_pass", fromVersion: "v0" } as Change, openCall, listening, heard, callTimeline: before,
    passRemovals: [{ start: 100, end: 102 }, heard, { start: 110, end: 112 }], ...over,
  });

  it("stop short of the pass's own cuts and the cuts already shown either side", async () => {
    await render(calling());
    expect(adjust).toMatchObject({ tone: "call", bandPrefix: "Cut", removeLabel: "Put back" });
    expect(adjust!.bounds.minStart).toBeCloseTo(102 + PAD, 6);
    expect(adjust!.bounds.maxEnd).toBeCloseTo(110 - PAD, 6);
    await render(calling({ callView }));
    expect(adjust!.bounds).toEqual({ minStart: expect.closeTo(104 + PAD, 6), maxStart: 107, minEnd: 105, maxEnd: expect.closeTo(108 - PAD, 6) });
  });

  it("move freely past a cut that overlaps the call, and stay put when the nearest cut before it isn't placed", async () => {
    await render(calling({ passRemovals: [{ start: 104, end: 106 }, heard] }));
    expect(adjust!.bounds).toEqual({ minStart: 0, maxStart: 107, minEnd: 105, maxEnd: 200 });
    await render(calling({ passRemovals: [undefined, heard] }));
    expect(adjust).toBeUndefined();
    await render(calling({ openCall: { ...openCall, index: 2 }, passRemovals: [undefined, { start: 100, end: 102 }, heard] }));
    expect(adjust!.bounds.minStart).toBeCloseTo(102 + PAD, 6);
  });

  it("don't move while the call is in conflict, sent back, being decided, or not listened to", async () => {
    for (const over of [{ conflict: true }, { openCallBack: true }, { deciding: true }, { listening: undefined }] as Partial<Inputs>[]) {
      await render(calling(over));
      expect(adjust).toBeUndefined();
    }
  });

  it("revise the staged cut where it sits on the working cut, ready to undo, and listen to it again from after", async () => {
    const reviseStagedCut = vi.fn(async () => ({ change: { id: "chg_rev" } as Change, index: 4 }));
    useProjectStore.setState({ reviseStagedCut });
    const setListening = vi.fn();
    await render(calling({ callView, setListening, cutName: "Cut 1:45" }));
    await commit({ start: 104.5, end: 107 });
    expect(reviseStagedCut).toHaveBeenCalledWith("chg_pass", 1, { start: 114.5, end: 117, version: "v1", reason: "A retake.", summary: "Second take" });
    expect(steps()).toEqual([expect.objectContaining({ kind: "callAdjust", word: "Adjust", projectId: "prj_test", changeId: "chg_rev", replacedId: "chg_pass", index: 4, name: "Cut 1:45" })]);
    expect(player.pause).toHaveBeenCalled();
    const next = setListening.mock.calls[0]![0] as (prev: Listening | undefined) => Listening;
    expect(next(undefined)).toEqual({ changeId: "chg_rev", index: 4, cut: { start: 114.5, end: 117 }, side: "after", take: 1, key: "chg_rev/4" });
    expect(next({ ...listening, take: 2 }).take).toBe(3);
  });

  it("sends the drag as it is without a view to map it, and leaves out a summary the call doesn't have", async () => {
    const reviseStagedCut = vi.fn(async () => ({ change: { id: "chg_rev" } as Change, index: 1 }));
    useProjectStore.setState({ reviseStagedCut });
    await render(calling({ openCall: { ...openCall, summary: undefined } }));
    await commit({ start: 104, end: 107.5 });
    expect(reviseStagedCut).toHaveBeenCalledWith("chg_pass", 1, { start: 104, end: 107.5, version: "v1", reason: "A retake." });
    expect(steps()[0]).not.toHaveProperty("name");
  });

  it("says why a revision couldn't be saved, and saves one at a time", async () => {
    const answer = deferred<{ change: Change; index: number }>();
    const reviseStagedCut = vi.fn(() => answer.promise);
    useProjectStore.setState({ reviseStagedCut });
    await render(calling());
    await commit({ start: 104, end: 107 });
    await commit({ start: 104.5, end: 107 });
    expect(reviseStagedCut).toHaveBeenCalledTimes(1);
    await act(async () => { answer.resolve(Promise.reject(new Error("The pass was applied.")) as never); });
    expect(useUndoStore.getState().error).toEqual({ projectId: "prj_test", text: "The pass was applied." });
    expect(steps()).toEqual([]);
  });
});
