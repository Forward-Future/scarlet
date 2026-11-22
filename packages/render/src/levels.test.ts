import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProject, emptyTimeline, makeMediaClip, type Effect, type Project, type Timeline, type VolumeKeyframe } from "@scarlet/timeline";
import { audioEffectDelay, effectFilters } from "./effects.js";
import { runCapture, runFfmpeg } from "./exec.js";
import { buildFilterGraph, levelFilters } from "./graph.js";
import { voiceModelFile, voiceModelText } from "./voiceModel.js";
import { VOICE_MODEL_SHA256 } from "./voiceModelData.js";

const dip: VolumeKeyframe[] = [
  { time: 1.7, db: 0, ease: "easeInOut" }, { time: 2, db: -18, ease: "linear" }, { time: 4, db: -18, ease: "easeInOut" }, { time: 4.8, db: 0, ease: "linear" }];

describe("the level filters", () => {
  it("leave a clip at full level alone and fold a level that doesn't move into one volume", () => {
    expect(levelFilters({ volume: 1 }, 0)).toEqual([]);
    expect(levelFilters({ volume: 0.5 }, 0)).toEqual(["volume=0.5"]);
    expect(levelFilters({ volume: 1, volumeKeyframes: [{ time: 0, db: -20, ease: "linear" }] }, 0)).toEqual(["volume=0.1"]);
  });

  it("move the level in dB on the clip's own clock, in short steps", () => {
    const [steps, volume] = levelFilters({ volume: 0.5, volumeKeyframes: dip }, 1.5);
    expect(steps).toBe("asetnsamples=n=256:p=0");
    expect(volume).toMatch(/^volume='0\.5\*pow\(10,\(if\(lt\(\(t\+1\.5\),2\),/);
    expect(volume).toMatch(/':eval=frame$/);
  });
});

describe("voice cleanup", () => {
  it("runs the bundled speech model, unchanged since it was published, and says how late it plays the sound", () => {
    expect(createHash("sha256").update(voiceModelText()).digest("hex")).toBe(VOICE_MODEL_SHA256);
    const effects: Effect[] = [{ type: "voiceCleanup", params: {}, enabled: true }];
    const ctx = { mediaRoot: os.tmpdir(), warn: () => {} };
    expect(effectFilters(effects, "audio", ctx)).toEqual([`arnndn=m=${voiceModelFile().replace(/[\\':]/g, "\\$&").replace(/[\\'[\],;]/g, "\\$&")}`]);
    expect(effectFilters([{ type: "voiceCleanup", params: { mix: 0.4 }, enabled: true }], "audio", ctx)[0]).toMatch(/:mix=0\.4$/);
    expect(effectFilters(effects, "video", ctx)).toEqual([]);
    expect(audioEffectDelay(effects)).toBeCloseTo(0.01, 9);
    expect(audioEffectDelay([{ ...effects[0]!, enabled: false }])).toBe(0);
  });
});

describe("rendering moving levels and a cleaned voice", () => {
  let dir: string;
  beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "scarlet-levels-")); });
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  /** Mono 48 kHz samples of what the timeline plays from `start` to `end`. */
  async function rendered(project: Project, timeline: Timeline, start: number, end: number): Promise<Int16Array> {
    const graph = await buildFilterGraph(project, timeline, { start, end }, { mediaRoot: dir, audioOnly: true, pictureOnly: false,
      audioSamples: Math.round((end - start) * 48000) });
    const out = path.join(dir, `mix-${Math.random().toString(36).slice(2)}.wav`);
    try {
      await runFfmpeg(["-y", ...graph.args, "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "1", out]);
    } finally { await graph.cleanup(); }
    const { stdout } = await runCapture("ffmpeg", ["-v", "error", "-i", out, "-f", "s16le", "-ac", "1", "-ar", "48000", "-"]);
    return new Int16Array(stdout.buffer, stdout.byteOffset, stdout.byteLength / 2);
  }
  const rms = (s: Int16Array, from: number, to: number) => {
    let sum = 0;
    const a = Math.round(from * 48000), b = Math.round(to * 48000);
    for (let i = a; i < b; i++) sum += (s[i]! / 32768) ** 2;
    return 10 * Math.log10(sum / (b - a));
  };

  it("dips a music bed by the keys' depth where they hold it down, and leaves it as it was either side", async () => {
    const music = path.join(dir, "music.wav");
    await runCapture("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:d=8", "-ac", "1", music]);
    const project = createProject("Levels");
    project.media.push({ id: "music", kind: "audio", name: "music.wav", path: music, duration: 8, hasAudio: true });
    const timeline = emptyTimeline(project.id);
    timeline.tracks[1]!.clips = [makeMediaClip("music", 0, 8, 0, { volumeKeyframes: dip })];
    const whole = await rendered(project, timeline, 0, 8);
    const open = rms(whole, 0.5, 1.5), down = rms(whole, 2.5, 3.5), after = rms(whole, 5.5, 7);
    expect(open - down).toBeCloseTo(18, 0);
    expect(after).toBeCloseTo(open, 1);
    // A section that starts inside the clip plays the same level there: the keys run on the clip's clock.
    const section = await rendered(project, timeline, 2.5, 6);
    expect(rms(section, 0, 1)).toBeCloseTo(down, 1);
  });

  it("cleans the room out of the pauses of a voice and keeps it where the picture has it", async () => {
    // A voice-like buzz from 1 s to 2 s over steady noise.
    const voice = path.join(dir, "voice.wav");
    await runCapture("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.03:r=48000:d=3:seed=7",
      "-f", "lavfi", "-i", "aevalsrc='0.5*between(t,1,2)*sin(2*PI*140*t)*(1+0.6*sin(2*PI*5*t))*(0.6+0.4*sin(2*PI*700*t))':s=48000:d=3",
      "-filter_complex", "amix=inputs=2:normalize=0", "-ac", "1", voice]);
    const project = createProject("Voice");
    project.media.push({ id: "voice", kind: "audio", name: "voice.wav", path: voice, duration: 3, hasAudio: true });
    const plain = emptyTimeline(project.id);
    plain.tracks[1]!.clips = [makeMediaClip("voice", 0, 3, 0)];
    const cleaned = structuredClone(plain);
    (cleaned.tracks[1]!.clips[0] as { effects: Effect[] }).effects = [{ type: "voiceCleanup", params: {}, enabled: true }];
    const before = await rendered(project, plain, 0, 3), after = await rendered(project, cleaned, 0, 3);
    expect(after.length).toBe(before.length);
    expect(rms(before, 0.2, 0.9) - rms(after, 0.2, 0.9)).toBeGreaterThan(10);
    // With none of the cleaned sound mixed in, what plays is the recording, sample for sample where it was.
    const passed = structuredClone(plain);
    (passed.tracks[1]!.clips[0] as { effects: Effect[] }).effects = [{ type: "voiceCleanup", params: { mix: 0 }, enabled: true }];
    const through = await rendered(project, passed, 0, 3);
    let worst = 0;
    for (let i = 48000; i < 2 * 48000; i++) worst = Math.max(worst, Math.abs(through[i]! - before[i]!));
    expect(worst).toBeLessThan(40);
  });
});
