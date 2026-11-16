import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import type { Ctx } from "../context.js";
import { ffmpeg } from "./ffmpeg.js";
import { measuredLoudness } from "./loudness.js";

const directory = mkdtempSync(join(tmpdir(), "scarlet-loudness-test-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const ctx = { track: <T>(p: Promise<T>) => p } as unknown as Ctx;

it("measures a file once for as long as it is the same file, and again once it changes", async () => {
  const file = join(directory, "tone.wav");
  await ffmpeg(["-f", "lavfi", "-i", "aevalsrc=0.1*sin(2*PI*440*t):d=1:s=48000", "-c:a", "pcm_s16le", "-y", file]);
  const first = await measuredLoudness(ctx, file, ["one"]);
  expect(first.truePeakDbtp).toBeCloseTo(-20, 0);
  rmSync(file);
  // Gone from disk, but the same file as measured: the figure kept answers.
  expect(await measuredLoudness(ctx, file, ["one"])).toEqual(first);
  // Another identity is another file, measured afresh, and there is nothing there now.
  await expect(measuredLoudness(ctx, file, ["two"])).rejects.toThrow(/ebur128/);
});
