import { describe, expect, it } from "vitest";
import type { TranscriptSegment, TranscriptWord } from "@scarlet/timeline";
import { CLASSES, CTC_LETTERS, FRAME_SECONDS, SEPARATOR } from "./ctcAlign.js";
import { putBackWords, tidiedRuns, type SaidPage } from "./saidWords.js";

const word = (text: string, start: number, end: number): TranscriptWord => ({ text, start, end });

/**
 * What the aligner's model hears when `parts` are said: each letter for two frames, a word separator after each word,
 * and a number for that many seconds of quiet. Returns the emissions and when each word was said.
 */
function speech(parts: Array<string | number>) {
  const frames: number[] = [];
  const said: TranscriptWord[] = [];
  const quiet = (seconds: number) => { for (let i = 0; i < Math.round(seconds / FRAME_SECONDS); i++) frames.push(0); };
  for (const part of parts) {
    if (typeof part === "number") { quiet(part); continue; }
    for (const text of part.split(" ")) {
      const start = frames.length * FRAME_SECONDS;
      for (const ch of text.toUpperCase().replace(/[^A-Z']/g, "")) frames.push(5 + CTC_LETTERS.indexOf(ch), 5 + CTC_LETTERS.indexOf(ch), 0);
      frames.push(SEPARATOR);
      said.push(word(text, start, frames.length * FRAME_SECONDS));
      quiet(0.06);
    }
  }
  quiet(1);
  const p = 0.9;
  const logProbs = new Float32Array(frames.length * CLASSES).fill(Math.log((1 - p) / (CLASSES - 1)));
  frames.forEach((c, t) => { logProbs[t * CLASSES + c] = Math.log(p); });
  const frameSource = async (start: number, end: number) => {
    const from = Math.max(0, Math.floor(start / FRAME_SECONDS)), to = Math.min(frames.length, Math.ceil(end / FRAME_SECONDS));
    return { logProbs: logProbs.slice(from * CLASSES, to * CLASSES), frames: to - from, origin: from * FRAME_SECONDS };
  };
  return { said, frames: frameSource, seconds: frames.length * FRAME_SECONDS };
}

const segment = (words: TranscriptWord[]): TranscriptSegment =>
  ({ id: "seg" + words[0]!.start, start: words[0]!.start, end: words.at(-1)!.end, text: words.map(w => w.text).join(" "), words });
const page = (seconds: number, words: TranscriptWord[]): SaidPage[] => [{ from: 0, to: seconds, words }];
const text = (segments: TranscriptSegment[]) => segments.flatMap(s => s.words.map(w => w.text)).join(" ");

describe("tidiedRuns", () => {
  it("finds where the reading says more, by the words both have in order", () => {
    const base = ["the", "logo", "the", "Coca-Cola", "logo"].map((t, i) => word(t, i, i + 1));
    const said = ["the", "logo", "the", "Coco", "the", "Coca-Cola", "logo"].map((t, i) => word(t, i, i + 1));
    expect(tidiedRuns(base, said)).toEqual([{ i1: 3, i2: 3, j1: 3, j2: 5 }]);
  });
});

describe("putBackWords", () => {
  // "the logo, the Coco, the Coca-Cola logo here", which the transcript had as one take: its "Coca-Cola" on the first,
  // and a second of "pause" where the second take was (2026-11-18).
  const coca = speech(["so here is the logo the coco", 0.4, "the cocacola logo here and more words after it"]);
  const at = (text: string, nth = 0) => coca.said.filter(w => w.text === text)[nth]!;
  const tidied = [segment([...coca.said.slice(0, 6), word("Coca-Cola", at("coco").start, at("coco").end), ...coca.said.slice(9)])];
  const reading = coca.said.map(w => w.text === "cocacola" ? word("Coca-Cola", w.start, w.end) : w);

  it("puts back the take a transcript tidied away, and moves the words beside it onto their sound", async () => {
    const { segments, found } = await putBackWords(tidied, page(coca.seconds, reading), coca.frames);
    expect(found.map(f => f.words.map(w => w.text).join(" "))).toEqual(["coco the"]);
    expect(text(segments)).toBe("so here is the logo the coco the Coca-Cola logo here and more words after it");
    const cola = segments[0]!.words.find(w => w.text === "Coca-Cola")!;
    expect(cola.start).toBeGreaterThanOrEqual(at("cocacola").start - 0.1);
    expect(tidied[0]!.words.find(w => w.text === "Coca-Cola")!.start).toBe(at("coco").start);
  });

  it("puts a take back once when its segment was split where two readings hand over", async () => {
    // Split at a window's seam, both halves keep the segment's id.
    const halves = [{ ...tidied[0]!, words: tidied[0]!.words.slice(0, 7) }, { ...tidied[0]!, words: tidied[0]!.words.slice(7) }];
    const { segments, found } = await putBackWords(halves, page(coca.seconds, reading), coca.frames);
    expect(found.map(f => f.words.map(w => w.text).join(" "))).toEqual(["coco the"]);
    expect(text(segments)).toBe("so here is the logo the coco the Coca-Cola logo here and more words after it");
  });

  it("keeps the times it placed when a word beside them it couldn't place kept an old time over them", async () => {
    // "so mm… you, when it goes": the transcript's one "When" was timed over the whole restart, and the cut-off first
    // try has too little of the word for the aligner to place it there again.
    const restart = speech(["so mm you when it goes into the next part"]);
    const [so, mm, you, when] = restart.said;
    const transcript = [segment([so!, word("When", mm!.start, when!.end), ...restart.said.slice(4)])];
    const said = [so!, word("when", mm!.start, mm!.end), ...restart.said.slice(2)];
    const { segments, found } = await putBackWords(transcript, page(restart.seconds, said), restart.frames);
    expect(found.map(f => f.words.map(w => w.text).join(" "))).toEqual(["you when"]);
    const words = segments.flatMap(s => s.words);
    expect(words.slice(0, 5).map(w => w.text)).toEqual(["so", "When", "you", "when", "it"]);
    for (const w of words.slice(2, 4)) expect(w.end - w.start).toBeGreaterThan(0.05);
    expect(words[2]!.start).toBeCloseTo(you!.start, 1);
    words.slice(1).forEach((w, k) => expect(w.start).toBeGreaterThanOrEqual(words[k]!.end - 1e-9));
  });

  it("leaves out words the reading wrote over quiet, however many", async () => {
    const quiet = speech(["and so i am going to test it", 3, "with this new model now"]);
    const looped = [...quiet.said.slice(0, 8),
      ...Array.from({ length: 5 }, (_, k) => ["and", "so", "i", "am", "going", "to", "test", "it"].map((t, i) => word(t, 2.5 + k * 0.5 + i * 0.05, 2.55 + k * 0.5 + i * 0.05))).flat(),
      ...quiet.said.slice(8)];
    const { found } = await putBackWords([segment(quiet.said)], page(quiet.seconds, looped), quiet.frames);
    expect(found).toEqual([]);
  });

  it("never takes out a word the aligner places", async () => {
    const heard = speech(["we upgraded to the plan and it ran out"]);
    // The reading has more words than the transcript here, in place of one the recording plainly says.
    const said = heard.said.map(w => w.text === "plan" ? [word("pro", w.start, w.start + 0.1), word("max", w.start + 0.1, w.end)] : [w]).flat();
    const { found } = await putBackWords([segment(heard.said)], page(heard.seconds, said), heard.frames);
    expect(found).toEqual([]);
  });
});
