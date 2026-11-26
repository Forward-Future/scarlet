// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyOps, emptyTimeline, makeMediaClip, type Change, type TimeRange, type Timeline } from "@scarlet/timeline";
import type { CutAdjustOptions } from "../../components/review/TimelineCutTrim";
import type { Call } from "../../lib/passCalls";
import { useCutAdjust } from "./useCutAdjust";
import { cutsOnVersion } from "./useCallListen";

vi.mock("../../components/transcript/useTranscriptWindow", () => ({ useTranscriptWindow: () => ({ transcripts: [] }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FPS = 30;
/** The working cut: one recording, 200 s of it. */
const working: Timeline = (() => {
  const base = emptyTimeline("prj_test");
  return { ...base, version: "v2", tracks: base.tracks.map(t => t.kind === "video" ? { ...t, clips: [makeMediaClip("med_a", 0, 200, 0, { id: "clip_a" })] } : t) };
})();
/** The version the pass was staged on: five seconds before 100 s were out, and the working cut put them back. */
const stagedOn: Timeline = { ...applyOps(working, [{ op: "rippleDelete", start: 50, end: 55 }]), version: "v1" };

interface Props { call: Partial<Call>; heard: TimeRange; siblings: readonly (TimeRange | undefined)[] | undefined; onDecideCall(choice: "keep" | "cut"): void }

let container: HTMLDivElement;
let root: Root;
let adjust: CutAdjustOptions | undefined;

function Harness({ call, heard, siblings, onDecideCall }: Props) {
  adjust = useCutAdjust({
    projectId: "prj_test", head: "v2", timeline: working, media: [], fps: FPS,
    otherCuts: [], stagedAround: [], setCutSide: () => {}, onAppliedRejected: () => {},
    pass: { id: "chg_pass", fromVersion: "v1" } as Change,
    openCall: { index: 0, start: heard.start, end: heard.end, verdict: "ask", reason: "A retake.", ...call } as Call,
    listening: { changeId: "chg_pass", index: call.index ?? 0, cut: heard, side: "after", take: 0, key: `chg_pass/${call.index ?? 0}` },
    setListening: () => {},
    heard, callTimeline: working, passRemovals: siblings, onDecideCall,
  });
  return null;
}

const render = async (props: Props) => { await act(async () => root.render(<Harness {...props} />)); };

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  adjust = undefined;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("a waiting call's edges", () => {
  it("keeps the footage when its cut is pulled to nothing, whatever the call proposes", async () => {
    // A call proposes its cut, or, revised, keeping the footage.
    for (const proposes of [undefined, "keep"] as const) {
      const onDecideCall = vi.fn();
      await render({ call: { proposes }, heard: { start: 105, end: 107 }, siblings: [{ start: 105, end: 107 }], onDecideCall });
      expect(adjust?.removeLabel).toBe("Put back");
      expect(adjust?.describeEdge?.("end", 107, 105, { start: 105, end: 105 })?.text).toBe("Put back whole cut");
      act(() => adjust!.onCommit({ start: 105, end: 105 }));
      expect(onDecideCall.mock.calls).toEqual([["keep"]]);
    }
  });

  it("stops short of the pass's next cut where it sits on the working cut, not where it was staged", async () => {
    // Staged on v1: this call at 100–102 and the next cut at 104–106. The working cut put five seconds back before them.
    const placed = cutsOnVersion([{ start: 100, end: 102 }, { start: 104, end: 106 }], stagedOn, working, FPS)!;
    expect(placed).toEqual([{ start: 105, end: 107 }, { start: 109, end: 111 }]);
    await render({ call: {}, heard: placed[0]!, siblings: placed, onDecideCall: vi.fn() });
    expect(adjust?.bounds.maxEnd).toBeCloseTo(109 - 1 / FPS, 6);
  });

  it("don't move while the pass's cuts aren't placed yet, or when the adjacent cut was partly changed", async () => {
    // Unknown where the pass was staged, none of its cuts is placed yet.
    expect(cutsOnVersion([{ start: 100, end: 102 }], undefined, working, FPS)).toBeUndefined();
    await render({ call: {}, heard: { start: 105, end: 107 }, siblings: undefined, onDecideCall: vi.fn() });
    expect(adjust).toBeUndefined();
    // An adjacent cut whose footage was partly altered can't bound the drag, so the edges stay locked.
    await render({ call: {}, heard: { start: 105, end: 107 }, siblings: [{ start: 105, end: 107 }, undefined], onDecideCall: vi.fn() });
    expect(adjust).toBeUndefined();
  });

  it("still moves when a distant cut was altered, or when the next cut was already taken out whole", async () => {
    // Cut 1 bounds the drag at 109 s, so an altered cut 2 further down the timeline cannot be reached and doesn't lock call 0.
    await render({ call: {}, heard: { start: 105, end: 107 }, siblings: [{ start: 105, end: 107 }, { start: 109, end: 111 }, undefined], onDecideCall: vi.fn() });
    expect(adjust?.bounds.maxEnd).toBeCloseTo(109 - 1 / FPS, 6);

    // When another edit already removed the whole next cut (109–111 on working -> join at 109 on afterCut), the join bounds call 0.
    const afterCut: Timeline = { ...applyOps(working, [{ op: "rippleDelete", start: 109, end: 111 }]), version: "v3" };
    const placed = cutsOnVersion([{ start: 105, end: 107 }, { start: 109, end: 111 }], working, afterCut, FPS);
    expect(placed).toEqual([{ start: 105, end: 107 }, { start: 109, end: 109 }]);
  });
});
