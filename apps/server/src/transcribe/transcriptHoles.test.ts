import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { TranscriptSegment } from "@scarlet/timeline";
import { fillTranscriptHoles, heardInHoles, transcriptHoles, wavLevels, withHoleWords, writeHoleAudio } from "./transcriptHoles.js";

const RATE = 16000;
const seg = (...words: Array<[string, number, number]>): TranscriptSegment => ({ id: "s" + words[0]![1], start: words[0]![1], end: words.at(-1)![2],
  text: words.map(w => w[0]).join(" "), words: words.map(([text, start, end]) => ({ text, start, end })) });

/** A 16 kHz mono WAV: a tone wherever `loud` says someone speaks, near silence elsewhere. */
async function recording(path: string, seconds: number, loud: Array<[number, number]>) {
  const data = Buffer.alloc(seconds * RATE * 2);
  for (let i = 0; i < seconds * RATE; i++) {
    const t = i / RATE, on = loud.some(([a, b]) => t >= a && t < b);
    data.writeInt16LE(Math.round(Math.sin(i * .2) * (on ? 6000 : 6)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii"); header.writeUInt32LE(data.length, 40);
  await writeFile(path, Buffer.concat([header, data]));
}

// Someone speaks 1–3 s, again 5–6.5 s with no words for it, and 9–11 s. A quiet wait runs 12–20 s before the last words.
const spoke: Array<[number, number]> = [[1, 3], [5, 6.5], [9, 11], [20, 21]];
const transcript = [seg(["it", 1, 1.5], ["uses", 1.6, 2.2], ["Blender", 2.3, 3]), seg(["that", 9, 9.6], ["matters", 9.7, 11]), seg(["next", 20, 21])];

it("finds the sound at speaking level a transcript has no word for, and leaves a quiet wait alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-holes-"));
  try {
    await recording(join(dir, "a.wav"), 22, spoke);
    const levels = await wavLevels(join(dir, "a.wav"));
    expect(levels.rms).toHaveLength(22 * 50);
    const holes = transcriptHoles(transcript, levels);
    expect(holes).toHaveLength(1);
    expect(holes[0]!.start).toBeCloseTo(4.7, 1);
    expect(holes[0]!.end).toBeCloseTo(6.8, 1);
    // The same sound with words on it is no hole.
    expect(transcriptHoles([...transcript, seg(["which", 5, 5.6], ["includes", 5.7, 6.5])], levels)).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("lays the holes end to end and puts each word heard back where it was said", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-holes-"));
  try {
    await recording(join(dir, "a.wav"), 22, spoke);
    const pieces = await writeHoleAudio(join(dir, "a.wav"), [{ start: 4.7, end: 6.8 }, { start: 14, end: 15 }], join(dir, "laid.wav"));
    expect(pieces).toEqual([{ source: 4.7, at: 1, length: expect.closeTo(2.1, 3) }, { source: 14, at: expect.closeTo(4.1, 3), length: 1 }]);
    expect((await wavLevels(join(dir, "laid.wav"))).to).toBeCloseTo(6.1, 1);
    // Whisper's times are in the laid-out audio. A sound it only labels is no word, and "matters" again beside
    // the kept “matters” is that word's own onset.
    const read = [seg(["which", 1.3, 1.9], ["includes", 2, 2.8], ["matters", 2.9, 3.05]), seg(["[BLANK_AUDIO]", 4.2, 5]), seg(["far", 9, 9.4])];
    const found = heardInHoles(read, [{ source: 4.7, at: 1, length: 2.1 }, { source: 14, at: 4.1, length: 1 }], [seg(["Blender", 2.3, 3]), seg(["matters", 6.9, 8])]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ text: "which includes", start: expect.closeTo(5, 3), end: expect.closeTo(6.5, 3) });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("adds found words inside the segment they interrupt and as their own segment between two", () => {
  const between = withHoleWords(transcript, [seg(["which", 5, 5.6], ["includes", 5.7, 6.5])]);
  expect(between.map(s => s.text)).toEqual(["it uses Blender", "which includes", "that matters", "next"]);
  const inside = withHoleWords([seg(["it", 1, 1.5], ["matters", 9.7, 11])], [seg(["which", 5, 5.6])]);
  expect(inside).toHaveLength(1);
  expect(inside[0]).toMatchObject({ text: "it which matters", words: [{ text: "it" }, { text: "which" }, { text: "matters" }] });
});

it("reads the holes once, places what it heard, and returns the transcript unchanged when they held no speech", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-holes-"));
  try {
    await recording(join(dir, "a.wav"), 22, spoke);
    const log: string[] = [];
    const base = { wav: join(dir, "a.wav"), segments: transcript, tmpDir: dir, signal: new AbortController().signal, log: (m: string) => log.push(m) };
    let reads = 0;
    const filled = await fillTranscriptHoles({ ...base, read: async () => { reads++; return [seg(["which", 1.3, 1.9], ["includes", 2, 2.8])]; },
      align: async found => found.map(s => ({ ...s, words: s.words.map(w => ({ ...w, start: w.start + .01 })) })) });
    expect(reads).toBe(1);
    expect(filled.map(s => s.text)).toEqual(["it uses Blender", "which includes", "that matters", "next"]);
    expect(filled[1]!.words[0]!.start).toBeCloseTo(5.01, 2);
    expect(log.at(-1)).toContain("found 2 words");
    expect(await fillTranscriptHoles({ ...base, read: async () => [seg(["(coughs)", 1.3, 1.9])], align: async f => f })).toBe(transcript);
    // A transcript with a word on every sound never runs Whisper again.
    const whole = [...transcript, seg(["which", 5, 5.6], ["includes", 5.7, 6.5])];
    expect(await fillTranscriptHoles({ ...base, segments: whole, read: async () => { throw new Error("not read"); }, align: async f => f })).toBe(whole);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
