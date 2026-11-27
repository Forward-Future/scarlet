import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { TranscriptSegment } from "@scarlet/timeline";
import { SAMPLE_RATE } from "./ctcAlign.js";
import { filterDictationText, isSilenceHallucination } from "./dictation.js";

const seg = (text: string, start = 0, end = 1): TranscriptSegment => ({
  id: "seg_1",
  start,
  end,
  text,
  words: text.split(/\s+/).filter(Boolean).map((w, i, all) => ({
    text: w,
    start: start + (end - start) * (i / all.length),
    end: start + (end - start) * ((i + 1) / all.length),
  })),
});

/** Write a 16 kHz mono 16-bit PCM WAV from a sample generator `sample(i) => -1..1`. */
async function writeWav(path: string, seconds: number, sample: (i: number) => number) {
  const count = Math.round(seconds * SAMPLE_RATE);
  const data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    const v = Math.max(-1, Math.min(1, sample(i)));
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  await writeFile(path, Buffer.concat([header, data]));
}

/** Deterministic pseudo-noise for steady room hiss / fan noise. */
function roomNoise(amplitude: number) {
  let state = 0x12345678;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return ((state / 0xffffffff) * 2 - 1) * amplitude;
  };
}

/** Voice-like harmonic signal modulated at syllable rate (~4 Hz) so WebRTC VAD detects speech. */
function speechLike(amplitude = 0.25) {
  return (i: number) => {
    const t = i / SAMPLE_RATE;
    const envelope = t >= 0.2 && t <= 1.2 ? 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t) : 0;
    const f0 = 150 + 25 * Math.sin(2 * Math.PI * 1.5 * t);
    const wave = 0.5 * Math.sin(2 * Math.PI * f0 * t)
      + 0.3 * Math.sin(2 * Math.PI * f0 * 2 * t)
      + 0.2 * Math.sin(2 * Math.PI * f0 * 3 * t);
    return wave * envelope * amplitude;
  };
}

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "scarlet-dictation-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it("recognizes common Whisper silence hallucinations regardless of punctuation or casing", () => {
  expect(isSilenceHallucination("Thank you.")).toBe(true);
  expect(isSilenceHallucination("  thank you! ")).toBe(true);
  expect(isSilenceHallucination("Thanks for watching.")).toBe(true);
  expect(isSilenceHallucination("Subtitles by Amara.org")).toBe(true);
  expect(isSilenceHallucination("Trim the intro")).toBe(false);
  expect(isSilenceHallucination("Okay")).toBe(false);
});

it("drops Whisper hallucinations such as \"Thank you.\" when dictation audio is silent or quiet room tone", async () => {
  const silent = join(dir, "silent.wav");
  await writeWav(silent, 1.5, () => 0);
  expect(await filterDictationText({ audioPath: silent, wavPath: silent, segments: [seg("Thank you.", 0, 1.5)], tmpDir: dir })).toBe("");
  expect(await filterDictationText({ audioPath: silent, wavPath: silent, segments: [{ id: "s1", start: 0, end: 1.5, text: "Thank you.", words: [] }], tmpDir: dir })).toBe("");

  // Quiet room tone (~-50 dBFS) with no speech should also stay empty.
  const quiet = join(dir, "quiet.wav");
  await writeWav(quiet, 1.5, roomNoise(0.005));
  expect(await filterDictationText({ audioPath: quiet, wavPath: quiet, segments: [seg("Thank you.", 0, 1.5)], tmpDir: dir })).toBe("");

  // Louder steady background hiss (~-35 dBFS) with no voice activity still drops a Whisper silence hallucination.
  const hiss = join(dir, "hiss.wav");
  await writeWav(hiss, 1.5, roomNoise(0.03));
  expect(await filterDictationText({ audioPath: hiss, wavPath: hiss, segments: [seg("Thank you.", 0, 1.5)], tmpDir: dir })).toBe("");
});

it("keeps genuinely spoken words, including \"Thank you\" when voice is actually present", async () => {
  const spoken = join(dir, "spoken.wav");
  await writeWav(spoken, 1.5, speechLike(0.25));
  expect(await filterDictationText({ audioPath: spoken, wavPath: spoken, segments: [seg("Trim the intro.", 0.2, 1.2)], tmpDir: dir })).toBe("Trim the intro.");
  expect(await filterDictationText({ audioPath: spoken, wavPath: spoken, segments: [seg("Thank you.", 0.2, 1.2)], tmpDir: dir })).toBe("Thank you.");
});
