import { applyOps, emptyTimeline, makeMediaClip, splitJoinOps, type TranscriptWord } from "@scarlet/timeline";
import { describe, expect, it } from "vitest";
import { splitJoinEvidence, splitJoinLabel } from "./split-join.js";

const word = (text: string, start: number, end: number): TranscriptWord => ({ text, start, end });
// The host's question ends at 5.6 s in their recording; a cut took out “Right, so” at 5.9–6.4 s.
const host = [word("Why", 4.8, 5.0), word("now?", 5.1, 5.6), word("Right,", 5.9, 6.1), word("so", 6.2, 6.4)];
// The guest draws breath, then answers at 10.3 s; “Well” at 9.5–9.8 s was cut.
const guest = [word("Well", 9.5, 9.8), word("Because", 10.3, 10.7), word("it", 10.8, 10.9)];
const media = [{ id: "host", kind: "video" as const, hasAudio: true, duration: 30 }, { id: "guest", kind: "video" as const, hasAudio: true, duration: 30 }];

function talk() {
  const tl = emptyTimeline("p");
  tl.tracks[0]!.clips = [makeMediaClip("host", 2, 5.8, 0, { id: "ask" }), makeMediaClip("guest", 10, 14, 3.8, { id: "answer" })];
  return tl;
}
const said = (id: string) => id === "host" ? host : guest;

describe("splitJoinEvidence", () => {
  it("says when each voice comes in and goes out against the picture cut", () => {
    const tl = talk();
    const { ops, joins } = splitJoinOps(tl, media, 25, [{ at: 3.8, shift: -0.2 }]);
    const [j] = splitJoinEvidence(applyOps(tl, ops), joins, said);
    expect(j).toEqual({ at: 3.8, soundAt: 3.6, split: "J", voiceIn: 0.3, voiceOut: -0.2, nowHeard: [], noLongerHeard: [] });
  });

  it("names words a lead brings back from footage a cut took out", () => {
    const tl = talk();
    const { ops, joins } = splitJoinOps(tl, media, 25, [{ at: 3.8, shift: -0.7 }]);
    const [j] = splitJoinEvidence(applyOps(tl, ops), joins, said);
    // The guest's sound now starts at 9.3 s: their cut “Well” plays under the host's picture, and the host's “now?” goes.
    expect(j).toMatchObject({ split: "J", voiceIn: -0.5, nowHeard: ["Well"], noLongerHeard: ["now?"] });
  });

  it("names the words an L cut carries over the next picture, and the ones it takes from the next shot", () => {
    const tl = talk();
    const { ops, joins } = splitJoinOps(tl, media, 25, [{ at: 3.8, shift: 0.7 }]);
    const [j] = splitJoinEvidence(applyOps(tl, ops), joins, said);
    expect(j).toMatchObject({ split: "L", soundAt: 4.5, voiceOut: 0.6, voiceIn: 0.8, nowHeard: ["Right,", "so"], noLongerHeard: ["Because"] });
    expect(splitJoinEvidence(applyOps(tl, ops), joins, () => null)[0]).toEqual({ at: 3.8, soundAt: 4.5, split: "L", nowHeard: [], noLongerHeard: [] });
  });
});

describe("splitJoinLabel", () => {
  it("names the second a split join is at, as the video's clock reads it", () => {
    expect(splitJoinLabel({ at: 2.2, shift: -0.2 })).toBe("J cut at 0:02");
    expect(splitJoinLabel({ at: 75, shift: 0.3 })).toBe("L cut at 1:15");
    // A join at 3 s that earlier ripples left a hair under it (4.6 - 1.6) is still at 0:03.
    expect(splitJoinLabel({ at: 4.6 - 1.6, shift: 0 })).toBe("Sound back on the cut at 0:03");
    // Past an hour, hours and minutes, not 62 minutes.
    expect(splitJoinLabel({ at: 3725, shift: -0.5 })).toBe("J cut at 1:02:05");
  });
});
