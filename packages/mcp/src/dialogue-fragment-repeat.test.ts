import { describe, expect, it } from "vitest";
import { partialRepeatAtJoin, type FragmentSide } from "./dialogue-fragment-repeat.js";

const cut = { start: 2, end: 5 };
const make = (edge: number, scan: FragmentSide["scan"], heard: FragmentSide["heard"]): FragmentSide =>
  ({ mediaId: "voice", audioStream: 0, trackId: "main", clipId: "take", speed: 1, edge,
    bounds: { start: 0, end: 9 }, scan, heard });
// The nominal outgoing edge is before the word. One frame of fade brings its first sound back in.
const out = make(2.04, [[1.1, 1.89, "Place"], [2.005, 2.20, "it"], [2.22, 2.4, "on"]],
  [[1.16, 1.82, "place"], [2.02, 2.04, "i"]]);
const incoming = make(4.96, [[5.03, 5.23, "it"], [5.25, 5.62, "there"]],
  [[5.06, 5.18, "it"], [5.28, 5.56, "there"]]);
const read = (a = out, b = incoming) => partialRepeatAtJoin(cut, a, b);

describe("partial word repeated across a dialogue join", () => {
  it("finds a clipped onset in the fade that a reading at the nominal cut misses", () => {
    const r = read();
    expect(r).toMatchObject({ side: "start", word: "it", heard: "i", fragment: { start: 2.02, end: 2.04 },
      splitWord: { start: 2.005, end: 2.20 }, complete: { start: 5.06, end: 5.18 } });
    expect(read({ ...out, edge: 2, heard: [out.heard[0]!] })).toBeUndefined();
  });

  it("detects a terminal fragment on the incoming side", () => {
    const left = make(2.04, [[1.7, 1.92, "zone"]], [[1.72, 1.86, "zone"]]);
    const right = make(4.96, [[4.72, 5.02, "zone"], [5.17, 5.4, "four"]],
      [[4.96, 5.00, "ne"], [5.20, 5.36, "four"]]);
    expect(read(left, right)).toMatchObject({ side: "end", word: "zone", heard: "ne" });
    expect(read(left, { ...right, heard: [[4.96, 5.00, "zo"], right.heard[1]!] })).toBeUndefined();
  });

  it("recognizes a short full emission physically truncated while the same word is still sounding", () => {
    expect(read({ ...out, heard: [out.heard[0]!, [2.01, 2.04, "it"]] })).toMatchObject({ word: "it", heard: "it" });
    expect(read({ ...out, heard: [out.heard[0]!, [2.01, 2.035, "it"]] })).toBeUndefined();
    expect(read({ ...out, scan: [out.scan[0]!, [1.84, 2.02, "it"]], heard: [out.heard[0]!, [1.92, 2.02, "it"]] })).toBeUndefined();
  });

  it("requires the fragment to belong to the word actually split, and a complete instance on the other side", () => {
    expect(read({ ...out, scan: [out.scan[0]!, [2.005, 2.20, "in"]] })).toBeUndefined();
    expect(read({ ...out, heard: [out.heard[0]!, [2.02, 2.04, "t"]] })).toBeUndefined();
    expect(read({ ...out, heard: [out.heard[0]!, [1.72, 1.84, "i"]] })).toBeUndefined();
    expect(read(out, { ...incoming, scan: [[4.9, 5.10, "it"], incoming.scan[1]!] })).toBeUndefined();
    expect(read(out, { ...incoming, heard: [[5.06, 5.18, "i"], incoming.heard[1]!] })).toBeUndefined();
    expect(read(out, { ...incoming, heard: [[5.01, 5.02, "I"], ...incoming.heard] })).toBeUndefined();
    expect(read(out, { ...incoming, bounds: { start: 4.96, end: 5.19 } })).toBeUndefined();
  });

  it("keeps tracks, streams and occurrences distinct, including two placements of the same source", () => {
    expect(read(out, { ...incoming, audioStream: 1 })).toBeUndefined();
    expect(read(out, { ...incoming, audioStream: undefined })).toBeUndefined();
    expect(read({ ...out, audioStream: undefined }, { ...incoming, audioStream: undefined })).toMatchObject({ word: "it" });
    expect(read(out, { ...incoming, trackId: "other" })).toBeUndefined();
    expect(read(out, { ...incoming, mediaId: "other" })).toBeUndefined();
    const clip = { ...incoming, clipId: "duplicate" };
    expect(read(out, clip)).toBeUndefined();
    expect(read({ ...out, sourceAtEdge: 10.04 }, { ...clip, sourceAtEdge: 9.96 })).toBeUndefined();
    expect(read({ ...out, sourceAtEdge: 10.04 }, { ...clip, sourceAtEdge: 20 })).toMatchObject({ word: "it" });
  });
});
