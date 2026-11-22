import { describe, expect, it } from "vitest";
import type { ThreadEdit } from "@scarlet/shared";
import { applyOps, type Timeline } from "@scarlet/timeline";
import { cutViewBase, rebaseCut } from "./cutViewBase";

const clip = (id: string, timelineIn: number, sourceIn: number, sourceOut: number) => ({
  id, kind: "media" as const, mediaId: "med_a", timelineIn, sourceIn, sourceOut, speed: 1, opacity: 1, volume: 1, enabled: true, effects: [],
});
const first = {
  version: "v1", projectId: "prj", name: "Cut", markers: [], background: "#000", createdAt: "2026-11-21T00:00:00.000Z",
  tracks: [
    { id: "v1", kind: "video", name: "V1", muted: false, hidden: false, clips: [clip("a", 0, 100, 200)] },
    { id: "a1", kind: "audio", name: "A1", muted: false, hidden: false, clips: [clip("b", 0, 100, 200)] },
  ],
} as unknown as Timeline;
// An earlier batch took 0.5 s out at 54 s; the next took 4 s out at 50 s, just before it.
const second = { ...applyOps(first, [{ op: "rippleDelete", start: 54, end: 54.5 }]), version: "v2" };

const edit = (changeId: string, version: string, at: number, start: number, end: number) =>
  ({ changeId, spot: 0, label: changeId, range: { start: at - 1.5, end: at + 1.5 }, previous: [], at, beforeCut: { version, removed: { start, end } } }) as unknown as ThreadEdit;
const earlier = edit("chg_earlier", "v1", 50, 54, 54.5);
const later = edit("chg_later", "v2", 50, 50, 54);
const made = (e: ThreadEdit) => e === earlier ? 1 : 2;

describe("cutViewBase", () => {
  it("opens a cut on the version before an earlier batch's cut beside it, so that one shows too", () => {
    expect(cutViewBase(later, [earlier, later], made, "v3")).toBe("v1");
  });

  it("leaves a cut on its own version when nothing earlier is near it, or for the earliest cut itself", () => {
    const far = edit("chg_earlier", "v1", 90, 94, 94.5);
    expect(cutViewBase(later, [far, later], e => e === far ? 1 : 2, "v3")).toBeUndefined();
    expect(cutViewBase(earlier, [earlier, later], made, "v3")).toBeUndefined();
    expect(cutViewBase(later, [{ ...earlier, rejected: true }, later], made, "v3")).toBeUndefined();
  });
});

describe("rebaseCut", () => {
  it("places the cut's footage on the earlier version, where the earlier cut's footage follows it", () => {
    expect(rebaseCut(second, first, { start: 50, end: 54 }, 30)).toEqual({ start: 50, end: 54 });
    // Cut after the earlier one: its footage sits 0.5 s later on the earlier version.
    expect(rebaseCut(second, first, { start: 60, end: 62 }, 30)).toEqual({ start: 60.5, end: 62.5 });
  });

  it("keeps a cut on its own version when an earlier cut fell inside its footage", () => {
    expect(rebaseCut(second, first, { start: 52, end: 57 }, 30)).toBeUndefined();
  });

  it("keeps a cut on its own version when the earlier one differs other than by footage taken out", () => {
    const moved = { ...first, version: "v0", tracks: first.tracks.map(t => ({ ...t, clips: [clip(`${t.id}-moved`, 0, 103, 203)] })) } as unknown as Timeline;
    expect(rebaseCut(second, moved, { start: 50, end: 54 }, 30)).toBeUndefined();
  });
});
