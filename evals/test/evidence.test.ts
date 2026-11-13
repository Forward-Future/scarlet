import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Engine } from "../src/engine.ts";
import { ffmpegPath, fullBandLevels, mediaEvidence } from "../src/evidence.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "scarlet-eval-audio-")); });
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

it("measures a late microphone at its time in the recording, including its last partial bucket", async () => {
  const file = join(root, "late-mic.mkv");
  execFileSync(ffmpegPath(), ["-v", "error", "-f", "lavfi", "-i", "color=s=32x32:r=20:d=1",
    "-itsoffset", "0.25", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=16000:duration=0.305",
    "-c:v", "ffv1", "-c:a", "pcm_s16le", file]);
  const { db } = await fullBandLevels(file);
  expect(db.slice(0, 25).every(level => level < -100)).toBe(true);
  expect(db).toHaveLength(56);
  expect(db.slice(25).every(level => level > -30)).toBe(true);
});

it("uses the engine waveform when the local decoder cannot start", async () => {
  vi.stubEnv("SCARLET_APP_SUPPORT", root);
  vi.stubEnv("SCARLET_EVAL_DATA", join(root, "evals"));
  vi.stubEnv("SCARLET_FFMPEG", join(root, "missing-ffmpeg"));
  const folder = join(root, "data", "projects", "prj_test", "media");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "mic.wav"), "");
  const engine = new Engine("http://127.0.0.1", "fixture");
  vi.spyOn(engine, "transcript").mockResolvedValue(undefined);
  vi.spyOn(engine, "waveform").mockResolvedValue({ from: 0, to: 0.04, peaks: [0.1, 1], rms: [0.1, 1] });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const evidence = await mediaEvidence(engine, "prj_test", { id: "med_test", kind: "audio", path: "mic.wav", duration: 0.04 });
  expect(evidence.levels?.db).toEqual([-20, 0]);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("using the engine"));
});
