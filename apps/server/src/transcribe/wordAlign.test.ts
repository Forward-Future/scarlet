import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as Ort from "onnxruntime-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLASSES, FRAME_SAMPLES, framesFor, SAMPLE_RATE, SEPARATOR } from "./ctcAlign.js";
import { EmissionFile } from "./emissions.js";
import * as uhm from "./uhm.js";
import { runAlignWorker, type AlignRequest } from "./wordAlign.js";

const letters = "ETAONIHSRDLUMWCFGYPBVK'XJQZ";
const id = (ch: string) => ch === "_" ? 0 : ch === "|" ? SEPARATOR : 5 + letters.indexOf(ch);

/**
 * Audio the stand-in model can read: one spike in every 20 ms frame, and its place in the frame is the class that
 * frame holds. `speech` maps a frame to the characters said from it ("_" blank, "|" separator, a letter).
 */
function audio(seconds: number, speech: Record<number, string>) {
  const samples = new Int16Array(seconds * SAMPLE_RATE);
  for (let frame = 0; frame * FRAME_SAMPLES < samples.length; frame++) samples[frame * FRAME_SAMPLES] = 20000;
  for (const [first, said] of Object.entries(speech)) [...said].forEach((ch, i) => {
    const at = (Number(first) + i) * FRAME_SAMPLES;
    samples[at] = 0;
    samples[at + id(ch)] = 20000;
  });
  return samples;
}

/** A WAV file as FFmpeg writes it, with a LIST chunk of odd length before the audio. */
function wav(samples: Int16Array, format: { rate?: number; channels?: number } = {}) {
  const head = Buffer.alloc(12 + 8 + 16 + 8 + 5 + 1 + 8);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(head.length - 8 + samples.byteLength, 4);
  head.write("WAVEfmt ", 8, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(format.channels ?? 1, 22);
  head.writeUInt32LE(format.rate ?? SAMPLE_RATE, 24);
  head.writeUInt32LE((format.rate ?? SAMPLE_RATE) * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("LIST", 36, "ascii");
  head.writeUInt32LE(5, 40);
  head.write("data", 50, "ascii");
  head.writeUInt32LE(samples.byteLength, 54);
  return Buffer.concat([head, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]);
}

type Session = { provider: string; runs: number[]; released: boolean };

/** A runtime whose model names, for each frame, the class the spike in its audio stands for. `wrong` providers hear the next class. */
function runtime(options: { wrong?: string[]; frames?: (samples: number) => number } = {}) {
  const sessions: Session[] = [];
  const ort = {
    Tensor: class { constructor(readonly type: string, readonly data: Float32Array, readonly dims: number[]) {} },
    InferenceSession: { create: async (_model: string, made: Ort.InferenceSession.SessionOptions) => {
      const first = made.executionProviders![0]!;
      const session: Session = { provider: typeof first === "string" ? first : first.name, runs: [], released: false };
      sessions.push(session);
      return {
        async run({ input_values }: { input_values: { data: Float32Array } }) {
          const input = input_values.data;
          session.runs.push(input.length);
          const frames = (options.frames ?? framesFor)(input.length);
          const data = new Float32Array(frames * CLASSES);
          for (let frame = 0; frame < frames; frame++) {
            let heard = 0;
            for (let c = 1; c < CLASSES; c++) if (input[frame * FRAME_SAMPLES + c]! > input[frame * FRAME_SAMPLES + heard]!) heard = c;
            if (options.wrong?.includes(session.provider)) heard = (heard + 1) % CLASSES;
            data[frame * CLASSES + heard] = 10;
          }
          return { logits: { dims: [1, frames, CLASSES], data } };
        },
        async release() { session.released = true; },
      };
    } },
  } as unknown as typeof Ort;
  return { ort, sessions };
}

describe("the aligner in the audio helper", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "scarlet-align-worker-")); });
  afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

  const hiYou = "__HH_I__|__YOU_|___";
  const words = (at: number) => [{ text: "Hi,", start: at, end: at + 0.1 }, { text: "you.", start: at + 0.2, end: at + 0.3 }];
  async function request(groups: AlignRequest["groups"], rest: Omit<AlignRequest, "groups"> = {}) {
    const file = join(dir, `${Math.random()}.json`);
    await writeFile(file, JSON.stringify({ groups, ...rest } satisfies AlignRequest));
    return file;
  }
  async function recording(seconds: number, speech: Record<number, string>, name = "recording.wav") {
    const file = join(dir, name);
    await writeFile(file, wav(audio(seconds, speech)));
    return file;
  }
  /** "Hi, you." said from frame `at`: Hi is frames 2 to 8 of it and you 10 to 15. */
  const expectHiYou = (timings: Array<{ start: number; end: number; score: number } | null>, at: number) => {
    const [hi, you] = timings;
    expect(hi!.start).toBeCloseTo(at + 0.02, 3);
    expect(hi!.end).toBeCloseTo(at + 0.18, 3);
    expect(you!.start).toBeCloseTo(at + 0.2, 3);
    expect(you!.end).toBeCloseTo(at + 0.32, 3);
    expect(hi!.score).toBeGreaterThan(0.9);
  };

  it("times a run's words from the audio around its Whisper times, one pass for runs that nearly touch", async () => {
    const { ort, sessions } = runtime();
    vi.spyOn(uhm, "loadRuntime").mockReturnValue(ort);
    // Said at 2 s, 3 s and 20 s of a 24 s recording. Whisper's times for the last run are a third of a second late.
    const file = await recording(24, { 100: hiYou, 150: hiYou, 1000: hiYou });
    const groups = [
      { start: 20.3, end: 20.8, words: words(20.3) }, { start: 2, end: 2.4, words: words(2) }, { start: 3, end: 3.4, words: words(3) },
      // Past the end of the audio there is nothing to search.
      { start: 30, end: 31, words: words(30) },
    ];
    const progress: number[] = [];
    const out = await runAlignWorker(file, "aligner.onnx", await request(groups), done => progress.push(done));
    expectHiYou(out[0]!, 20);
    expectHiYou(out[1]!, 2);
    expectHiYou(out[2]!, 3);
    expect(out[3]).toEqual([null, null]);
    // 1.5 to 3.9 s in one pass and 19.8 to 21.3 s in another: the pause between them is never inferred.
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.runs).toEqual([2.4 * SAMPLE_RATE, 1.5 * SAMPLE_RATE]);
    expect(sessions[0]!.released).toBe(true);
    expect(progress.at(-1)).toBe(1);
    expect(progress[0]).toBeCloseTo(2.4 / 3.9, 6);
  });

  it("never places a run's words back over the ones the previous request placed", async () => {
    const { ort } = runtime();
    vi.spyOn(uhm, "loadRuntime").mockReturnValue(ort);
    const file = await recording(6, { 100: hiYou });
    const groups = [{ start: 2, end: 2.4, words: words(2) }];
    expectHiYou((await runAlignWorker(file, "aligner.onnx", await request(groups)))[0]!, 2);
    // The request before ended its last confident word at 2.3 s, after these were said.
    const late = (await runAlignWorker(file, "aligner.onnx", await request(groups, { after: 2.3 })))[0]!;
    // Nothing after 2.3 s sounds like them, so they score nothing and keep Whisper's times. A word starts at most a
    // frame and its onset lead before the bound.
    expect(late.map(timing => timing!.score)).toEqual([0, 0]);
    for (const timing of late) expect(timing!.start).toBeGreaterThan(2.25);
  });

  it("opens no audio when the runtime is missing", async () => {
    vi.spyOn(uhm, "loadRuntime").mockImplementation(() => { throw new Error("The installed Scarlet engine is missing its Uhm runtime."); });
    const groups = [{ start: 2, end: 2.4, words: words(2) }];
    await expect(runAlignWorker(join(dir, "never-opened.wav"), "aligner.onnx", await request(groups))).rejects.toThrow("missing its Uhm runtime");
  });

  it("reads only 16 kHz mono audio, and rejects output that isn't the aligner's", async () => {
    const groups = [{ start: 2, end: 2.4, words: words(2) }];
    const samples = audio(6, { 100: hiYou });
    const load = vi.spyOn(uhm, "loadRuntime").mockReturnValue(runtime().ort);
    for (const [name, format] of [["stereo.wav", { channels: 2 }], ["44k.wav", { rate: 44100 }]] as const) {
      await writeFile(join(dir, name), wav(samples, format));
      await expect(runAlignWorker(join(dir, name), "aligner.onnx", await request(groups))).rejects.toThrow("Word alignment requires 16 kHz mono PCM audio.");
    }
    await writeFile(join(dir, "empty.wav"), Buffer.alloc(0));
    await expect(runAlignWorker(join(dir, "empty.wav"), "aligner.onnx", await request(groups))).rejects.toThrow("Word alignment requires 16 kHz mono PCM audio.");
    load.mockReturnValue(runtime({ frames: samples => framesFor(samples) + 1 }).ort);
    await expect(runAlignWorker(await recording(6, { 100: hiYou }), "aligner.onnx", await request(groups))).rejects.toThrow(/^Unexpected aligner output 1×\d+×32\.$/);
  });

  describe("with the recording's emission store", () => {
    // A 70 s recording has three windows: 0-30, 28-58 and 40-70 s. The page starts 30 s into it.
    const store = () => ({ file: join(dir, "emissions.bin"), offset: 30, duration: 30 });
    const page = [{ start: 2, end: 2.4, words: words(2) }];

    it("measures the requested kept audio with no transcript words and reuses it on the recheck", async () => {
      const { ort, sessions } = runtime();
      vi.spyOn(uhm, "loadRuntime").mockReturnValue(ort);
      const recordingPath = await recording(70, { 1600: hiYou });
      const measurement = await request([], { store: store(), measure: [{ start: 31, end: 34 }] });
      await runAlignWorker(recordingPath, "aligner.onnx", measurement);
      const saved = (await EmissionFile.open(store().file))!;
      try { expect(saved.missing(0, saved.frames)).toEqual([0, 2]); } finally { await saved.close(); }
      await runAlignWorker("", "aligner.onnx", measurement);
      expect(sessions.map(s => s.runs)).toEqual([[30 * SAMPLE_RATE]]);
    });

    it("infers the windows the words need once, saves them, and then reads no audio and loads no model", async () => {
      const { ort, sessions } = runtime();
      const load = vi.spyOn(uhm, "loadRuntime").mockReturnValue(ort);
      const file = await recording(70, { 1600: hiYou });
      const progress: number[] = [];
      const first = await runAlignWorker(file, "aligner.onnx", await request(page, { store: store() }), done => progress.push(done));
      // Times come back on the page's clock: said 32 s into the recording, 2 s into the page.
      expectHiYou(first[0]!, 2);
      expect(sessions.map(s => s.runs)).toEqual([[30 * SAMPLE_RATE]]);
      expect(progress).toEqual([1, 1]);
      const saved = (await EmissionFile.open(store().file))!;
      expect(saved.missing(0, saved.frames)).toEqual([0, 2]);
      await saved.close();
      const again = await runAlignWorker("", "aligner.onnx", await request(page, { store: store() }));
      expect(again).toEqual(first);
      expect(load).toHaveBeenCalledTimes(1);
      expect(sessions).toHaveLength(1);
    });

    it("says what is missing when it has no store, or no audio for a window the store lacks", async () => {
      vi.spyOn(uhm, "loadRuntime").mockReturnValue(runtime().ort);
      await expect(runAlignWorker("", "aligner.onnx", await request(page, { store: store() }))).rejects.toThrow("The recording's alignment store is missing.");
      await (await EmissionFile.open(store().file, 70 * SAMPLE_RATE))!.close();
      await expect(runAlignWorker("", "aligner.onnx", await request(page, { store: store() }))).rejects.toThrow("The recording's alignment store lacks audio it was not given.");
    });

    it("uses the GPU once its first window matches the CPU's, and keeps the session for the next request", async () => {
      const { ort, sessions } = runtime();
      vi.spyOn(uhm, "loadRuntime").mockReturnValue(ort);
      vi.spyOn(uhm, "webgpuAvailable").mockReturnValue(true);
      const notes: string[] = [];
      const kept = new uhm.Sessions(note => notes.push(note));
      const file = await recording(70, { 100: hiYou, 1600: hiYou });
      const first = await runAlignWorker(file, "/models/aligner.onnx", await request(page, { store: store() }), undefined, kept);
      expectHiYou(first[0]!, 2);
      expect(sessions.map(s => [s.provider, s.runs.length, s.released])).toEqual([["webgpu", 1, false], ["cpu", 1, true]]);
      expect(kept.verified.has("/models/aligner.onnx")).toBe(true);
      // Another page of the same recording: the GPU's session again, with nothing checked a second time.
      const next = await runAlignWorker(file, "/models/aligner.onnx", await request(page, { store: { ...store(), offset: 0 } }), undefined, kept);
      expectHiYou(next[0]!, 2);
      expect(sessions.map(s => [s.provider, s.runs.length])).toEqual([["webgpu", 2], ["cpu", 1]]);
      expect(notes).toEqual(["aligner.onnx runs on the GPU (webgpu)"]);
    });

    it("gives up a GPU whose output differs from the CPU's, and saves only the CPU's", async () => {
      const { ort, sessions } = runtime({ wrong: ["webgpu"] });
      vi.spyOn(uhm, "loadRuntime").mockReturnValue(ort);
      vi.spyOn(uhm, "webgpuAvailable").mockReturnValue(true);
      const notes: string[] = [];
      const kept = new uhm.Sessions(note => notes.push(note));
      const file = await recording(70, { 1600: hiYou });
      const out = await runAlignWorker(file, "/models/aligner.onnx", await request(page, { store: store() }), undefined, kept);
      expectHiYou(out[0]!, 2);
      // Every frame named another class, 10 away in its logit.
      expect(notes).toEqual(["aligner.onnx left the GPU (webgpu) for the CPU: The GPU's aligner output differs from the CPU's (10.000, 100.0% of frames)."]);
      expect(sessions.find(s => s.provider === "webgpu")!.released).toBe(true);
      expect(kept.verified.size).toBe(0);
      expect(kept.gpuFailed.has("/models/aligner.onnx")).toBe(true);
    });
  });
});
