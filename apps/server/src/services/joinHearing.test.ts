import { describe, expect, it } from "vitest";
import { hearJoin, joinSides, type JoinSide } from "./dialogueRepeatAudit.js";

const side = (over: Partial<JoinSide>): JoinSide => ({ mediaId: "mic", clipId: "a", trackId: "A1", timelineStart: 0, timelineEnd: 10,
  source: { start: 0, end: 10 }, heard: [], said: [], ...over });

describe("hearing a join", () => {
  it("hears a kept word the cut goes through", () => {
    // “…subscription” cut at 9.2 s while the word runs to 9.5 s: the sound up to the edge reads “subscrip”.
    const out = side({ source: { start: 0, end: 9.2 }, timelineEnd: 9.2,
      said: [{ text: "my", start: 8.3, end: 8.5 }, { text: "subscription.", start: 8.6, end: 9.5 }],
      heard: [{ text: "my", start: 8.3, end: 8.48 }, { text: "subscrip", start: 8.6, end: 9.2 }] });
    const inn = side({ clipId: "b", timelineStart: 9.2, source: { start: 12, end: 20 },
      said: [{ text: "I", start: 12.2, end: 12.3 }], heard: [{ text: "i", start: 12.2, end: 12.3 }] });
    expect(hearJoin(out, inn)).toEqual([{ at: 9.2, mediaId: "mic", side: "out", issue: "clipped", heard: "subscrip", expected: "subscription.", source: 8.6 }]);
  });

  it("hears a leftover of the removed take the transcript has no word for", () => {
    const out = side({ source: { start: 0, end: 9.7 }, timelineEnd: 9.7,
      said: [{ text: "subscription.", start: 8.6, end: 9.4 }],
      heard: [{ text: "subscription", start: 8.6, end: 9.4 }, { text: "k", start: 9.55, end: 9.68 }] });
    const inn = side({ clipId: "b", timelineStart: 9.7, source: { start: 12, end: 20 },
      said: [{ text: "I", start: 12.2, end: 12.3 }], heard: [{ text: "i", start: 12.2, end: 12.3 }] });
    expect(hearJoin(out, inn)).toMatchObject([{ side: "out", issue: "fragment", heard: "k", expected: "subscription." }]);
  });

  it("passes a clean join, and a word the reader spells a little differently", () => {
    const out = side({ source: { start: 0, end: 9.6 }, timelineEnd: 9.6, said: [{ text: "Kimi", start: 8.6, end: 9.4 }], heard: [{ text: "kimmy", start: 8.6, end: 9.4 }] });
    const inn = side({ clipId: "b", timelineStart: 9.6, source: { start: 12, end: 20 },
      said: [{ text: "downloaded", start: 12.1, end: 12.6 }], heard: [{ text: "downlowded", start: 12.1, end: 12.6 }] });
    expect(hearJoin(out, inn)).toEqual([]);
  });

  it("pairs the parts that meet on a track, not a split that plays on", () => {
    const a = side({ timelineEnd: 5, source: { start: 0, end: 5 } });
    const b = side({ clipId: "b", timelineStart: 5, timelineEnd: 8, source: { start: 7, end: 10 } });
    const split = side({ clipId: "c", timelineStart: 8, timelineEnd: 9, source: { start: 10, end: 11 } });
    expect(joinSides([split, b, a]).map(([x, y]) => [x.clipId, y.clipId])).toEqual([["a", "b"]]);
  });
});
