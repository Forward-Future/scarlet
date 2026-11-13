import { describe, expect, it } from "vitest";
import { matchReference, summarizeReference, type MatchWord } from "./reference-match.js";

const VOCAB = "the a of to and we you it this that is was for on with as have but not they from say her she will one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us plan build video camera light sound story begin finish idea market river window paper engine garden pocket silver orange".split(" ");

/** A recording: random words at a random but fixed rhythm, with a pause of 0.9 s every 14th word. */
function recording(seed: number, count: number, at = 0): MatchWord[] {
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  let t = at;
  return Array.from({ length: count }, (_, i) => {
    const length = 0.12 + next() * 0.3;
    const word = { text: VOCAB[Math.floor(next() * VOCAB.length)]!, start: t, end: t + length };
    t += length + (i % 14 === 13 ? 0.9 : 0.02 + next() * 0.08);
    return word;
  });
}

/** Play pieces of recordings one after another. `gap` is the pause before each piece. */
function finished(pieces: Array<{ words: MatchWord[]; from: number; to: number; gap?: number }>): MatchWord[] {
  const out: MatchWord[] = [];
  let t = 1;
  for (const piece of pieces) {
    t += piece.gap ?? 0.1;
    const first = piece.words[piece.from]!.start;
    for (const w of piece.words.slice(piece.from, piece.to + 1)) out.push({ text: w.text, start: t + w.start - first, end: t + w.end - first });
    t = out.at(-1)!.end;
  }
  return out;
}

describe("matching a finished video to its recordings", () => {
  const a = recording(7, 400);
  const b = recording(99, 300);

  it("gives a line said twice to the take that plays, when the cut runs from one take's start to the next's", () => {
    const before = recording(7, 50);
    // The second take is a little slower, so its words drift from the first take's by 0.03 s each.
    const take = (at: number, drift: number) => ["so", "i", "asked", "it"].map((text, k) => ({ text, start: at + k * (0.3 + drift), end: at + k * (0.3 + drift) + 0.2 }));
    const first = before.at(-1)!.end + 0.4, second = first + 1.6;
    const rec = [...before, ...take(first, 0), ...take(second, 0.03), ...recording(99, 80, second + 1.4)];
    // Cut from the first take's first word to the second's: the second take plays exactly where the first would have.
    const final = finished([{ words: rec, from: 0, to: 49 }, { words: rec, from: 54, to: rec.length - 1, gap: 0.4 }]);
    const m = matchReference(final, [{ mediaId: "a", words: rec }]);
    expect(m.stretches.map(s => s.sourceWords)).toEqual([[0, 49], [54, rec.length - 1]]);
    expect(m.joins[0]).toMatchObject({ kind: "forward", removedWords: 4 });
  });

  it("finds each piece, what was left out between pieces, and what was never used", () => {
    // Words 20–119, then 123–200 (three words taken out), then 260–330 (a passage), then all of b's first 50.
    const final = finished([{ words: a, from: 20, to: 119 }, { words: a, from: 123, to: 200 }, { words: a, from: 260, to: 330, gap: 0.2 }, { words: b, from: 0, to: 49 }]);
    const m = matchReference(final, [{ mediaId: "a", words: a }, { mediaId: "b", words: b }]);
    expect(m.rate).toBe(1);
    expect(m.stretches.map(s => [s.mediaId, ...s.sourceWords])).toEqual([["a", 20, 119], ["a", 123, 200], ["a", 260, 330], ["b", 0, 49]]);
    expect(m.joins.map(j => [j.kind, j.removedWords])).toEqual([["forward", 3], ["forward", 59], ["switch", undefined]]);
    expect(m.joins[0]!.removedText).toBe(a.slice(120, 123).map(w => w.text).join(" "));
    expect(m.joins[0]!.removedSeconds).toBeCloseTo(a[123]!.start - a[119]!.end - 0.1, 2);
    expect(m.matchedWords).toBe(final.length);
    expect(m.unmatched).toEqual([]);
    expect(m.unused.map(u => [u.mediaId, ...u.sourceWords])).toEqual([["a", 0, 19], ["a", 120, 122], ["a", 201, 259], ["a", 331, 399], ["b", 50, 299]]);
    const summary = summarizeReference(m, final, [{ mediaId: "a", words: a }, { mediaId: "b", words: b }]);
    expect(summary.joins).toMatchObject({ total: 3, forward: 2, switch: 1, back: 0 });
    expect(summary.joins.removedWords["3-15"].count).toBe(1);
    expect(summary.recordings[1]).toMatchObject({ mediaId: "b", usedPieces: 1, unusedPassages: 1 });
  });

  it("reports a shortened pause as a join with no words removed", () => {
    // Word 13 is followed by a 0.9 s pause. The finished video plays 0.25 s of it.
    const final = finished([{ words: a, from: 0, to: 13 }, { words: a, from: 14, to: 60, gap: 0.25 }]);
    const m = matchReference(final, [{ mediaId: "a", words: a }]);
    expect(m.joins).toHaveLength(1);
    expect(m.joins[0]).toMatchObject({ kind: "forward", removedWords: 0 });
    expect(m.joins[0]!.removedSeconds).toBeCloseTo(0.65, 2);
    expect(m.joins[0]!.finalIn - m.joins[0]!.finalOut).toBeCloseTo(0.25, 2);
    const summary = summarizeReference(m, final, [{ mediaId: "a", words: a }]);
    expect(summary.joins.pauseOnly.count).toBe(1);
    expect(summary.pauses.keptAsRecorded?.count).toBe(3);
  });

  it("tells the take that was used from the same line said again", () => {
    // The same 12 words twice with a different rhythm, then the recording carries on.
    const line = recording(5, 12);
    const retake = recording(1234, 12).map((w, i) => ({ ...w, text: line[i]!.text }));
    const place = (words: MatchWord[], at: number) => words.map(w => ({ ...w, start: w.start - words[0]!.start + at, end: w.end - words[0]!.start + at }));
    const intro = recording(3, 40);
    const first = place(line, intro.at(-1)!.end + 0.3);
    const second = place(retake, first.at(-1)!.end + 1.2);
    const rest = place(recording(8, 60), second.at(-1)!.end + 0.1);
    const source = [...intro, ...first, ...second, ...rest];
    // The editor kept the first take and cut the second.
    const keptFirst = matchReference(finished([{ words: source, from: 0, to: 51 }, { words: source, from: 64, to: 123 }]), [{ mediaId: "s", words: source }]);
    expect(keptFirst.stretches.map(s => s.sourceWords)).toEqual([[0, 51], [64, 123]]);
    // The editor cut the first take and kept the second.
    const keptSecond = matchReference(finished([{ words: source, from: 0, to: 39 }, { words: source, from: 52, to: 123 }]), [{ mediaId: "s", words: source }]);
    expect(keptSecond.stretches.map(s => s.sourceWords)).toEqual([[0, 39], [52, 123]]);
  });

  it("matches through words the two transcripts heard differently, and measures a retimed video", () => {
    const heard = finished([{ words: a, from: 10, to: 150 }]).map((w, i) => i === 40 || i === 41 ? { ...w, text: "zzz" } : w);
    const m = matchReference(heard, [{ mediaId: "a", words: a }]);
    expect(m.stretches.map(s => s.sourceWords)).toEqual([[10, 150]]);
    expect(m.joins).toEqual([]);
    const fast = finished([{ words: a, from: 0, to: 300 }]).map(w => ({ ...w, start: w.start / 1.25, end: w.end / 1.25 }));
    const retimed = matchReference(fast, [{ mediaId: "a", words: a }]);
    expect(retimed.rate).toBeCloseTo(1.25, 2);
    expect(retimed.stretches.map(s => s.sourceWords)).toEqual([[0, 300]]);
  });

  it("lists speech no recording has", () => {
    const narration = recording(4242, 30, 500).map(w => ({ ...w, text: `x${w.text}` }));
    const final = [...finished([{ words: a, from: 0, to: 50 }]), ...narration];
    const m = matchReference(final, [{ mediaId: "a", words: a }]);
    expect(m.unmatched.map(u => u.finalWords)).toEqual([[51, 80]]);
    expect(m.stretches).toHaveLength(1);
  });

  it.each([1, 1.12])("distinguishes frequent pause cuts from a playback rate of %s", rate => {
    const raw = recording(125, 120).map((word, i) => {
      const pause = Math.floor(i / 8) * 0.9;
      return { ...word, start: word.start + pause, end: word.end + pause };
    });
    const pieces = Array.from({ length: 15 }, (_, i) => ({ words: raw, from: i * 8, to: i * 8 + 7 }));
    const final = finished(pieces).map(w => ({ ...w, start: w.start / rate, end: w.end / rate }));
    expect(matchReference(final, [{ mediaId: "camera", words: raw }]).rate).toBeCloseTo(rate, 2);
  });
});
