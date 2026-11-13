import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptSegment } from "@scarlet/timeline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ffmpeg from "../render/ffmpeg.js";
import { AudioLane } from "../services/audioWork.js";
import {
  alignGroup, alignmentGroups, applyTimings, CLASSES, ctcAlign, FRAME_SAMPLES, framesFor, planChunks, SAMPLE_RATE,
  SEPARATOR, stitchChunks, WILDCARD, wordLabels,
} from "./ctcAlign.js";
import { LocalWhisperModel } from "./localModel.js";
import { audioWorker } from "./audioWorker.js";
import { EmissionFile } from "./emissions.js";
import { readAcousticWindow, readCachedAcousticWords } from "./acousticWords.js";
import { alignsLanguage, alignTranscript, alignWords, WordAligner, type AlignmentCheckpoint, type AlignRequest } from "./wordAlign.js";

const letters = "ETAONIHSRDLUMWCFGYPBVK'XJQZ";
const id = (ch: string) => ch === "_" ? 0 : ch === "|" ? SEPARATOR : 5 + letters.indexOf(ch);
const spell = (word: string) => [...word].map(id);

/** One frame per character: "_" blank, "|" separator, a letter. The named class gets `p`, the rest share 1 − p. */
function emissions(frames: string, p = 0.9) {
  const out = new Float32Array(frames.length * CLASSES).fill(Math.log((1 - p) / (CLASSES - 1)));
  [...frames].forEach((ch, t) => { out[t * CLASSES + id(ch)] = Math.log(p); });
  return out;
}

function segment(start: number, end: number, words: Array<[string, number, number]>): TranscriptSegment {
  return { id: `seg-${start}`, start, end, text: words.map(w => w[0]).join(" "), words: words.map(([text, s, e]) => ({ text, start: s, end: e })) };
}

describe("text normalization", () => {
  it("spells words in the model's alphabet and drops punctuation", () => {
    expect(wordLabels(" Don't,")).toEqual(spell("DON'T"));
    expect(wordLabels("'quoted'")).toEqual(spell("QUOTED"));
    expect(wordLabels("Café!")).toEqual(spell("CAFE"));
    expect(wordLabels("well-known")).toEqual(spell("WELL|KNOWN"));
    expect(wordLabels("“Rubik’s")).toEqual(spell("RUBIK'S"));
  });

  it("marks unspellable speech as one wildcard and skips non-speech", () => {
    expect(wordLabels("2024")).toEqual([WILDCARD]);
    expect(wordLabels("30%")).toEqual([WILDCARD]);
    expect(wordLabels("GPT-5")).toEqual([WILDCARD]);
    expect(wordLabels("日本")).toEqual([WILDCARD]);
    expect(wordLabels("...")).toBeNull();
    expect(wordLabels("—")).toBeNull();
    expect(wordLabels("[BLANK_AUDIO]")).toBeNull();
    expect(wordLabels("(laughs)")).toBeNull();
  });

  it("accepts English language codes and names only", () => {
    for (const language of [undefined, "", "en", "english", "EN-us"]) expect(alignsLanguage(language)).toBe(true);
    for (const language of ["de", "german", "es", "zh"]) expect(alignsLanguage(language)).toBe(false);
  });
});

describe("CTC Viterbi", () => {
  it("finds each label's frames on a synthetic emission matrix", () => {
    const lp = emissions("__HH_I__|__YOU_|___");
    expect(ctcAlign(lp, 0, 19, spell("HI|YOU|"))).toEqual([[2, 3], [5, 5], [8, 8], [11, 11], [12, 12], [13, 13], [15, 15]]);
    // A window offset reports global frames.
    expect(ctcAlign(lp, 10, 19, spell("YOU"))).toEqual([[11, 11], [12, 12], [13, 13]]);
  });

  it("separates repeated letters with a blank and rejects windows too short for the labels", () => {
    expect(ctcAlign(emissions("ALLL"), 0, 4, spell("ALL"))).toEqual([[0, 0], [1, 1], [3, 3]]);
    expect(ctcAlign(emissions("ALL"), 0, 3, spell("ALL"))).toBeNull();
    expect(ctcAlign(emissions("A"), 0, 1, [])).toBeNull();
  });

  it("lets a wildcard absorb unspellable speech between spelled neighbors", () => {
    const lp = emissions("_HI_|_TWENTY_|_OK__");
    expect(ctcAlign(lp, 0, 19, [...spell("HI|"), WILDCARD, ...spell("|OK")])).toMatchObject([[1, 1], [2, 2], [4, 4], [6, 11], [13, 13], [15, 15], [16, 16]]);
  });
});

describe("word timing", () => {
  const em = (frames: string, origin = 10) => ({ logProbs: emissions(frames), frames: frames.length, origin });

  it("starts a word just before its first letter and ends it with the following separator", () => {
    const words = [{ text: "Hi,", start: 9, end: 9.5 }, { text: "you.", start: 9.5, end: 9.6 }];
    const [hi, you] = alignGroup(em("__HH_I__|__YOU_|___"), words, 10, 10.38);
    expect(hi!.start).toBeCloseTo(10.02);
    expect(hi!.end).toBeCloseTo(10.18);
    expect(hi!.score).toBeCloseTo(0.9);
    expect(you!.start).toBeCloseTo(10.2);
    expect(you!.end).toBeCloseTo(10.32);
  });

  it("never starts a word before the recording does, when speech is under way in its first frame", () => {
    // The lead before a first letter in frame 0 would reach back past zero, and a transcript can't hold a negative time.
    const [hi] = alignGroup(em("HI_|__", 0), [{ text: "Hi", start: 0, end: 0.2 }], 0, 0.12);
    expect(hi!.start).toBe(0);
    expect(hi!.end).toBeCloseTo(0.08);
  });

  it("gives no timing to wildcard and unspoken words, and none to mostly unspellable runs", () => {
    const words = [{ text: "Hi", start: 0, end: 0 }, { text: "-", start: 0, end: 0 }, { text: "20", start: 0, end: 0 }, { text: "ok", start: 0, end: 0 }];
    const timings = alignGroup(em("_HI_|_TWENTY_|_OK_|_", 0), words, 0, 0.4);
    expect(timings.map(t => !!t)).toEqual([true, false, false, true]);
    expect(alignGroup(em("_HI_|_TWENTY_|_", 0), [{ text: "20", start: 0, end: 0 }, { text: "30", start: 0, end: 0 }, { text: "hi", start: 0, end: 0 }], 0, 0.3))
      .toEqual([undefined, undefined, undefined]);
  });

  it("scores words the audio does not contain near zero", () => {
    const [word] = alignGroup(em("__HI__|___", 0), [{ text: "zoo", start: 0, end: 0 }], 0, 0.2);
    expect(word!.score).toBeLessThan(0.01);
  });
});

describe("chunk planning and stitching", () => {
  it("covers every frame once from frame-aligned windows of at most 30 s", () => {
    for (const seconds of [0.01, 5, 30, 30.01, 61, 100, 3600.37]) {
      const samples = Math.round(seconds * SAMPLE_RATE);
      const chunks = planChunks(samples);
      if (samples < 400) { expect(chunks).toEqual([]); continue; }
      let next = 0;
      for (const chunk of chunks) {
        expect(chunk.start % FRAME_SAMPLES).toBe(0);
        expect(chunk.length).toBeLessThanOrEqual(30 * SAMPLE_RATE);
        expect(chunk.start + chunk.length).toBeLessThanOrEqual(samples);
        expect(chunk.keep[0]).toBe(next);
        // Kept frames come from inside the window, at least a second from a shared edge.
        const first = chunk.start / FRAME_SAMPLES, last = first + framesFor(chunk.length);
        expect(chunk.keep[0]).toBeGreaterThanOrEqual(first + (chunk === chunks[0] ? 0 : 49));
        expect(chunk.keep[1]).toBeLessThanOrEqual(last - (chunk === chunks.at(-1) ? 0 : 49));
        next = chunk.keep[1];
      }
      expect(next).toBe(framesFor(samples));
    }
    expect(planChunks(100 * SAMPLE_RATE).map(c => c.start / SAMPLE_RATE)).toEqual([0, 28, 56, 70]);
  });

  it("places each window's frames at their global position", () => {
    const samples = 75 * SAMPLE_RATE + 123;
    const chunks = planChunks(samples);
    const outputs = chunks.map(chunk => {
      const first = chunk.start / FRAME_SAMPLES;
      const out = new Float32Array(framesFor(chunk.length) * CLASSES);
      for (let j = 0; j < framesFor(chunk.length); j++) out.fill(first + j, j * CLASSES, (j + 1) * CLASSES);
      return out;
    });
    const stitched = stitchChunks(chunks, outputs);
    expect(stitched.length).toBe(framesFor(samples) * CLASSES);
    for (let f = 0; f < framesFor(samples); f++) expect(stitched[f * CLASSES + 7]).toBe(f);
  });
});

describe("grouping and fallback", () => {
  it("joins segments into runs of at most 30 s and splits longer segments between words", () => {
    const segments = [
      segment(0, 10, [["a", 1, 2]]), segment(10, 20, [["b", 11, 12]]), segment(20, 30, [["c", 21, 22]]),
      segment(30, 40, [["d", 31, 32]]), segment(40, 41, []),
      segment(50, 120, Array.from({ length: 14 }, (_, i) => [`w${i}`, 50 + 5 * i, 52 + 5 * i] as [string, number, number])),
    ];
    const groups = alignmentGroups(segments);
    expect(groups.map(g => [g.start, g.end, g.index.length])).toEqual([[0, 30, 3], [30, 40, 1], [50, 77, 6], [80, 107, 6], [110, 120, 2]]);
    expect(groups.flatMap(g => g.index)).toEqual(Array.from({ length: 18 }, (_, i) => i));
  });

  it("replaces confident times and fits the rest between aligned neighbors", () => {
    const segments = [segment(0.3, 3, [["a", 0.3, 1], ["b", 1, 2], ["c", 2, 3]]), segment(3, 6, [["d", 3, 4], ["e", 4.5, 5], ["f", 5, 6]])];
    const out = applyTimings(segments, [
      { start: 0.1, end: 0.5, score: 0.9 }, { start: 0.6, end: 0.9, score: 0.05 }, { start: 2.2, end: 2.6, score: 0.95 },
      { start: 3.1, end: 3.5, score: 0.9 }, undefined, { start: 4.2, end: 4.6, score: 0.8 },
    ]);
    // a/c/d/f aligned; b keeps Whisper's 1–2 s, inside its gap; e (4.5–5) overlaps f, so it keeps its part inside the gap.
    expect(out[0]!.words.map(w => [w.start, w.end])).toEqual([[0.1, 0.5], [1, 2], [2.2, 2.6]]);
    expect(out[1]!.words.map(w => [w.start, w.end])).toEqual([[3.1, 3.5], [3.5, 4.2], [4.2, 4.6]]);
    expect(out[0]).toMatchObject({ start: 0.1, end: 3, text: "a b c" });
    expect(out[1]).toMatchObject({ start: 3, end: 6 });
    expect(out[1]!.words[1]).toEqual(expect.objectContaining({ text: "e" }));
  });

  it("keeps a transcript untouched when nothing aligned, and clips runs at its open ends", () => {
    const segments = [segment(0, 3, [["a", 0, 1], ["b", 1, 2], ["c", 2, 3]])];
    expect(applyTimings(segments, [undefined, null, { start: 2, end: 2.5, score: 0.1 }])).toEqual(segments);
    const out = applyTimings(segments, [{ start: 1.5, end: 1.8, score: 0.9 }, undefined, undefined]);
    expect(out[0]!.words.map(w => [w.start, w.end])).toEqual([[1.5, 1.8], [1.8, 2], [2, 3]]);
  });
});

describe("transcript alignment", () => {
  let dir: string;
  const log = vi.fn();
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "scarlet-align-"));
    vi.spyOn(LocalWhisperModel.prototype, "get").mockResolvedValue("model.onnx");
  });
  afterEach(async () => { vi.restoreAllMocks(); log.mockReset(); await rm(dir, { recursive: true, force: true }); });
  const ctx = () => ({ paths: { root: dir, tmp: dir }, log });
  const signal = new AbortController().signal;

  it("aligns in bounded worker turns and carries placed words into the next turn", async () => {
    const segments = Array.from({ length: 24 }, (_, k) => segment(30 * k, 30 * k + 25, [["hello", 30 * k + 1, 30 * k + 2], ["2024", 30 * k + 2, 30 * k + 3]]));
    const requests: AlignRequest[] = [];
    const worker = vi.spyOn(audioWorker, "request").mockImplementation(async message => {
      expect(message).toMatchObject({ kind: "align", wav: join(dir, "decoded.wav"), model: "model.onnx" });
      const request: AlignRequest = JSON.parse(readFileSync((message as { request: string }).request, "utf8"));
      requests.push(request);
      return request.groups.map(g => [{ start: g.words[0]!.start + 0.25, end: g.words[0]!.start + 0.5, score: 0.9 }, null]) as never;
    });
    const out = await alignTranscript(ctx(), { source: "source.mov", wav: join(dir, "decoded.wav"), language: "en", segments, signal });
    expect(worker).toHaveBeenCalledTimes(3);
    expect(requests.map(r => [r.groups.length, r.after])).toEqual([[10, undefined], [10, 271.5], [4, 571.5]]);
    expect(out[3]!.words).toEqual([{ text: "hello", start: 91.25, end: 91.5 }, { text: "2024", start: 92, end: 93 }]);
    expect((await readdir(dir)).filter(f => f.endsWith(".json"))).toEqual([]);
    // One line for the whole transcript, once its last turn is done: each "hello" was placed and no "2024".
    expect(log.mock.calls).toEqual([[expect.stringMatching(/^\[align\] source\.mov: placed 24 of 48 words in \d+(ms|s)$/)]]);
  });

  it("reports how far into the speech it has reached, and hands over each turn's words but the last", async () => {
    const segments = Array.from({ length: 24 }, (_, k) => segment(30 * k, 30 * k + 25, [["hello", 30 * k + 1, 30 * k + 2], ["2024", 30 * k + 2, 30 * k + 3]]));
    vi.spyOn(audioWorker, "request").mockImplementation(async (message, options) => {
      const request: AlignRequest = JSON.parse(readFileSync((message as { request: string }).request, "utf8"));
      // The helper reports each window it finishes. A figure outside 0 to 1 is not a share of the turn.
      for (const done of [-1, 0.5, 2, 1]) options?.onProgress?.(done);
      return request.groups.map(g => [{ start: g.words[0]!.start + 0.25, end: g.words[0]!.start + 0.5, score: 0.9 }, null]) as never;
    });
    const progress: number[] = [];
    const turns: Array<{ through: number; moved: number }> = [];
    const moved = (soFar: TranscriptSegment[]) => soFar.filter((s, i) => s.words[0] !== segments[i]!.words[0]).length;
    const hold = vi.fn();
    const out = await alignWords(ctx(), join(dir, "decoded.wav"), segments, { language: "en", signal, hold,
      onProgress: fraction => progress.push(fraction),
      onTurn: (soFar, through) => turns.push({ through, moved: moved(soFar) }) });
    // The speech spans 0 to 715 s in three turns, which start at 0, 300 and 600 s. Each is halfway, then done.
    const expected = [150, 300, 450, 600, 657.5, 715].map(seconds => seconds / 715);
    expect(progress).toHaveLength(expected.length);
    progress.forEach((fraction, i) => expect(fraction).toBeCloseTo(expected[i]!, 6));
    // Words that end before `through` are final: it is where the turn's last confident word ends.
    expect(turns).toEqual([{ through: 271.5, moved: 10 }, { through: 571.5, moved: 20 }]);
    expect(moved(out)).toBe(24);
    expect(hold).toHaveBeenCalledTimes(3);
  });

  it("resumes across repeated interruptions, including a turn without confident words", async () => {
    const segments = [segment(0, 860, Array.from({ length: 24 }, (_, k) =>
      ["word", k * 36, k * 36 + 1] as [string, number, number]))];
    const requests: AlignRequest[] = [];
    vi.spyOn(audioWorker, "request").mockImplementation(async message => {
      const request: AlignRequest = JSON.parse(readFileSync((message as { request: string }).request, "utf8"));
      requests.push(request);
      return request.groups.map(g => g.words.map(w => w.start < 324 ? null : { start: w.start + 0.1, end: w.end + 0.1, score: 1 })) as never;
    });
    const wav = join(dir, "decoded.wav");
    let saved = segments;
    let resume: AlignmentCheckpoint | undefined;
    const progress: number[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const stop = new AbortController();
      await expect(alignTranscript(ctx(), { source: "talk.mov", wav, segments: saved, resume, signal: stop.signal,
        onProgress: p => progress.push(p),
        onTurn: (soFar, _through, checkpoint) => {
          resume = checkpoint;
          saved = soFar;
          stop.abort(new Error("quit"));
        } })).rejects.toThrow("quit");
      expect(resume).toEqual(attempt === 0 ? { nextWord: 9, through: 0, fraction: 324 / 860 }
        : { nextWord: 18, through: 613.1, fraction: 648 / 860 });
    }
    const final = await alignTranscript(ctx(), { source: "talk.mov", wav, segments: saved, resume, signal, onProgress: p => progress.push(p) });
    expect(requests.map(r => [r.groups[0]!.start, r.after])).toEqual([[0, undefined], [324, undefined], [648, 613.1]]);
    expect(progress).toEqual([324 / 860, 324 / 860, 648 / 860, 648 / 860, 1]);
    expect(requests.flatMap(r => r.groups.flatMap(g => g.words.map(w => w.start)))).toEqual(segments[0]!.words.map(w => w.start));
    expect(final[0]!.words.map(w => w.start)).toEqual(segments[0]!.words.map(w => w.start < 324 ? w.start : w.start + 0.1));
  });

  it("recovers an older time-only checkpoint inside a segment, leaving the confident prefix in place", async () => {
    const segments = [segment(0, 20, [["done", 1, 1.5], ["through", 2, 2.5], ["next", 2.5, 2.5], ["last", 18, 19]])];
    const requests: AlignRequest[] = [];
    vi.spyOn(audioWorker, "request").mockImplementation(async message => {
      const request: AlignRequest = JSON.parse(readFileSync((message as { request: string }).request, "utf8"));
      requests.push(request);
      return request.groups.map(g => g.words.map(w => ({ start: w.start + 0.1, end: w.end + 0.2, score: 1 }))) as never;
    });
    const progress: number[] = [];
    const final = await alignTranscript(ctx(), { source: "talk.mov", wav: join(dir, "decoded.wav"), segments, signal,
      resume: { through: 2.5 }, onProgress: p => progress.push(p) });
    expect(requests.map(r => [r.after, r.groups.flatMap(g => g.words.map(w => w.text))])).toEqual([[2.5, ["next", "last"]]]);
    expect(final[0]!.words.slice(0, 2)).toEqual(segments[0]!.words.slice(0, 2));
    expect(progress).toEqual([2.5 / 20, 1]);
  });

  it("takes its turns in the engine's audio lane, and shorter ones once a dialogue pass reads the recording", async () => {
    const segments = Array.from({ length: 24 }, (_, k) => segment(30 * k, 30 * k + 25, [["hello", 30 * k + 1, 30 * k + 2]]));
    const lane = new AudioLane();
    const turns: number[] = [];
    let release: (() => void) | undefined;
    vi.spyOn(audioWorker, "request").mockImplementation(async message => {
      const request: AlignRequest = JSON.parse(readFileSync((message as { request: string }).request, "utf8"));
      turns.push(request.groups.length);
      // A pass starts reading the recording while its first five minutes are aligned.
      release ??= lane.focus("media-1");
      return request.groups.map(g => g.words.map(() => null)) as never;
    });
    const aligner = new WordAligner(join(dir, "models"));
    await aligner.align(join(dir, "decoded.wav"), segments, { language: "en", signal, lane: { lane, work: { mediaId: "media-1", kind: "alignment" } } });
    // Five minutes, then two-minute turns a scan page can run between.
    expect(turns).toEqual([10, 4, 4, 4, 2]);
    release!();
    turns.length = 0;
    await aligner.align(join(dir, "decoded.wav"), segments, { language: "en", signal, lane: { lane, work: { mediaId: "media-1", kind: "alignment" } } });
    expect(turns).toEqual([10, 10, 4]);
  });

  it("asks nothing of the aligner for words it can't spell, and stops before a turn once cancelled", async () => {
    const worker = vi.spyOn(audioWorker, "request").mockImplementation(async message => {
      const request: AlignRequest = JSON.parse(readFileSync((message as { request: string }).request, "utf8"));
      return request.groups.map(g => g.words.map(() => null)) as never;
    });
    const numbers = [segment(0, 2, [["2024", 0, 1], ["30%", 1, 2]])];
    expect(await alignWords(ctx(), join(dir, "a.wav"), numbers, { language: "en", signal })).toBe(numbers);
    expect(await alignWords(ctx(), join(dir, "a.wav"), [], { language: "en", signal })).toEqual([]);
    expect(worker).not.toHaveBeenCalled();
    // Cancelled while it waits for something to finish first: the turn never starts.
    const stop = new AbortController();
    const hold = async () => { stop.abort(new Error("cancelled")); };
    await expect(alignWords(ctx(), join(dir, "a.wav"), [segment(0, 2, [["hello", 0, 1]])], { language: "en", signal: stop.signal, hold })).rejects.toThrow("cancelled");
    expect(worker).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it("keeps the words placed so far when the aligner fails part way, and decodes the source itself when given no audio", async () => {
    const segments = Array.from({ length: 24 }, (_, k) => segment(30 * k, 30 * k + 25, [["hello", 30 * k + 1, 30 * k + 2]]));
    const decoded: string[] = [];
    vi.spyOn(ffmpeg, "extractWav").mockImplementation(async (_source, output) => { decoded.push(output); });
    let turn = 0;
    vi.spyOn(audioWorker, "request").mockImplementation(async message => {
      if (++turn === 2) throw new Error("The audio helper stopped before it answered.");
      const request: AlignRequest = JSON.parse(readFileSync((message as { request: string }).request, "utf8"));
      expect((message as { wav: string }).wav).toBe(decoded[0]);
      return request.groups.map(g => [{ start: g.words[0]!.start + 0.25, end: g.words[0]!.start + 0.5, score: 0.9 }]) as never;
    });
    const seen: number[] = [];
    const out = await alignTranscript(ctx(), { source: join(dir, "talk.mov"), language: "en", segments, signal, onTurn: (_soFar, through) => seen.push(through) });
    expect(seen).toEqual([271.5]);
    // The first turn's ten words moved. The rest keep the provider's times.
    expect(out.map(s => s.words[0]!.start)).toEqual(segments.map((s, k) => s.words[0]!.start + (k < 10 ? 0.25 : 0)));
    expect(log.mock.calls).toEqual([["[align] talk.mov: The audio helper stopped before it answered."]]);
    expect(decoded).toHaveLength(1);
  });

  it("reads a recording's saved emissions, and decodes it only for windows the store lacks", async () => {
    const file = join(dir, "emissions.bin");
    // A 70 s recording has three windows: 0-30, 28-58 and 40-70 s.
    const samples = 70 * SAMPLE_RATE;
    const store = (await EmissionFile.open(file, samples))!;
    await store.write(0, new Float32Array((store.chunks[0]!.keep[1] - store.chunks[0]!.keep[0]) * CLASSES));
    await store.close();
    const decode = vi.fn(async () => join(dir, "whole.wav"));
    const sent: Array<{ wav: string; store: AlignRequest["store"] }> = [];
    vi.spyOn(audioWorker, "request").mockImplementation(async message => {
      const request: AlignRequest = JSON.parse(readFileSync((message as { request: string }).request, "utf8"));
      sent.push({ wav: (message as { wav: string }).wav, store: request.store });
      return request.groups.map(g => g.words.map(() => null)) as never;
    });
    const emissions = { file, offset: 2, duration: 60, wav: decode };
    // Words at 3-13 s of the recording sit inside the saved window: nothing is decoded.
    await alignWords(ctx(), "page.wav", [segment(1, 11, [["hello", 1, 2], ["there", 10, 11]])], { language: "en", signal, emissions });
    expect(decode).not.toHaveBeenCalled();
    expect(sent).toEqual([{ wav: "", store: { file, offset: 2, duration: 60 } }]);
    // Words at 42-52 s need the second window, so the worker gets the whole recording to infer it from.
    await alignWords(ctx(), "page.wav", [segment(40, 50, [["again", 40, 41], ["later", 49, 50]])], { language: "en", signal, emissions });
    expect(decode).toHaveBeenCalledTimes(1);
    expect(sent[1]).toEqual({ wav: join(dir, "whole.wav"), store: { file, offset: 2, duration: 60 } });
    expect((await readdir(dir)).filter(f => f.endsWith(".part"))).toEqual([]);
  });

  it("keeps the provider's times for other languages and when the aligner fails", async () => {
    const segments = [segment(0, 2, [["hola", 0, 1], ["amigo", 1, 2]])];
    const worker = vi.spyOn(audioWorker, "request").mockRejectedValue(new Error("worker crashed"));
    const decode = vi.spyOn(ffmpeg, "extractWav").mockResolvedValue();
    expect(await alignTranscript(ctx(), { source: "a.mov", language: "es", segments, signal })).toBe(segments);
    expect(worker).not.toHaveBeenCalled();
    expect(await alignTranscript(ctx(), { source: "a.mov", language: "english", segments, signal })).toBe(segments);
    expect(decode).toHaveBeenCalledTimes(1);
    // The failure is the only line: nothing says words were placed.
    expect(log.mock.calls).toEqual([["[align] a.mov: worker crashed"]]);
  });

  it("stops when the transcription is cancelled", async () => {
    const abort = new AbortController();
    vi.spyOn(audioWorker, "request").mockImplementation(async () => { abort.abort(new Error("cancelled")); throw new Error("killed"); });
    const segments = [segment(0, 2, [["hello", 0, 1]])];
    await expect(alignTranscript(ctx(), { source: "a.mov", wav: join(dir, "a.wav"), segments, signal: abort.signal })).rejects.toThrow("cancelled");
  });
});

describe("a recording's emission store", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "scarlet-emissions-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("reads complete words in each measured run, keeping audible fragments for join checks", async () => {
    const file = join(dir, "emissions.bin");
    expect(await readCachedAcousticWords(file, 0, 70)).toEqual([]);
    const store = (await EmissionFile.open(file, 70 * SAMPLE_RATE))!;
    try {
      const [first, , last] = store.chunks;
      const beforeGap = "BACK|GO|FOR".padEnd(first!.keep[1] - first!.keep[0], "_");
      const afterGap = "WARD|END".padEnd(last!.keep[1] - last!.keep[0], "_");
      await store.write(0, emissions(beforeGap));
      await store.write(2, emissions(afterGap));
    } finally { await store.close(); }
    const runs = await readCachedAcousticWords(file, 0, 70);
    expect(runs.map(run => run.map(w => w.text))).toEqual([["back", "go"], ["end"]]);
    expect(runs[1]![0]!.start).toBeGreaterThan(40);
    expect((await readCachedAcousticWords(file, .02, .2))[0]!.map(w => w.text)).toEqual(["go"]);
    expect((await readAcousticWindow(file, .02, .2))!.map(w => w.text)).toEqual(["ack", "go", "fo"]);
  });

  it("saves each window's frames once and serves them to any reader", async () => {
    const file = join(dir, "emissions.bin");
    expect(await EmissionFile.open(file)).toBeNull();
    const samples = 70 * SAMPLE_RATE;
    const store = (await EmissionFile.open(file, samples))!;
    expect(store.chunks.map(c => c.start / SAMPLE_RATE)).toEqual([0, 28, 40]);
    expect(store.frames).toBe(framesFor(samples));
    // 20 ms frames: 10 s to 35 s is frames 500 to 1750, which the first two windows hold.
    expect(store.frameRange(10, 35)).toEqual([500, 1750]);
    expect(store.missing(500, 1750)).toEqual([0, 1]);
    const rows = (index: number) => {
      const [from, to] = store.chunks[index]!.keep;
      const out = new Float32Array((to - from) * CLASSES);
      for (let f = from; f < to; f++) out.fill(f, (f - from) * CLASSES, (f - from + 1) * CLASSES);
      return out;
    };
    await store.write(1, rows(1));
    expect(store.missing(500, 1750)).toEqual([0]);
    await expect(store.read(500, 1750)).rejects.toThrow("before they were saved");
    await expect(store.write(0, new Float32Array(CLASSES))).rejects.toThrow("wrong number of frames");
    await store.write(0, rows(0));
    await store.close();
    // Another reader, such as a scan page after the transcript's alignment, finds both windows.
    const again = (await EmissionFile.open(file))!;
    expect(again.missing(0, again.frames)).toEqual([2]);
    const read = await again.read(500, 1750);
    expect(read.length).toBe(1250 * CLASSES);
    for (const frame of [500, 1449, 1450, 1749]) expect(read[(frame - 500) * CLASSES + 3]).toBe(frame);
    await again.close();
  });

  it("starts empty when the recording's length has changed", async () => {
    const file = join(dir, "emissions.bin");
    const store = (await EmissionFile.open(file, 40 * SAMPLE_RATE))!;
    await store.write(0, new Float32Array((store.chunks[0]!.keep[1] - store.chunks[0]!.keep[0]) * CLASSES));
    await store.close();
    const same = (await EmissionFile.open(file, 40 * SAMPLE_RATE))!;
    expect(same.missing(0, 100)).toEqual([]);
    await same.close();
    const changed = (await EmissionFile.open(file, 50 * SAMPLE_RATE))!;
    expect(changed.missing(0, 100)).toEqual([0]);
    await changed.close();
  });
});
