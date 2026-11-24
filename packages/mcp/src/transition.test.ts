import { emptyTimeline, makeMediaClip } from "@scarlet/timeline";
import { describe, expect, it } from "vitest";
import { transitionOps } from "./transition.js";

describe("transitionOps", () => {
  it("says the time of a join a few milliseconds before a whole minute as that minute, not 60 seconds", () => {
    const tl = emptyTimeline("p");
    tl.tracks[0]!.clips = [makeMediaClip("cam", 0, 59.996, 0, { id: "a" }), makeMediaClip("cam", 70, 80, 59.996, { id: "b" })];
    expect(transitionOps(tl, [], 30, [{ clipId: "b" }], null).report).toEqual(["1:00.00: straight cut"]);
    expect(() => transitionOps(tl, [], 30, [{ at: 119.997 }], null)).toThrow(`No join on ${tl.tracks[0]!.id} at 2:00.00. The nearest is at 1:00.00 (59.996 s).`);
  });
});
