// pnpm exec tsx packages/render/bench/filmstrip.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { filmstripBatches } from "@scarlet/timeline";
import { extractFilmstrip } from "../src/frame.js";
import { resolveFfmpeg, runCapture } from "../src/exec.js";

const scratch = await mkdtemp(join(tmpdir(), "scarlet-filmstrip-"));
try {
  const source = fileURLToPath(new URL("../../../apps/web/public/sample.mp4", import.meta.url));
  const preview = join(scratch, "preview.mp4");
  const long = join(scratch, "long.mp4");
  const ffmpeg = resolveFfmpeg();
  await runCapture(ffmpeg, ["-v", "error", "-i", source, "-an", "-vf", "scale=960:540", "-threads", "2",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-g", "15", preview]);
  await runCapture(ffmpeg, ["-v", "error", "-stream_loop", "5", "-i", preview, "-c", "copy", long]);

  for (const seconds of [6, 55, 120]) {
    const frames = Array.from({ length: 8 }, (_, i) => Math.floor((i + 0.5) * seconds * 30 / 8));
    const runs: number[][] = [[], []];
    for (let rep = 0; rep < 8; rep++) {
      for (const mode of [rep % 2, 1 - rep % 2]) {
        const groups = mode ? filmstripBatches(frames, 30) : seconds <= 60 ? [frames] : frames.map(f => [f]);
        const queue = groups.values();
        const start = performance.now();
        // The engine admits two simultaneous image requests.
        const decode = async () => {
          for (const group of queue) await extractFilmstrip(long, group, 30);
        };
        await Promise.all([decode(), decode()]);
        runs[mode]!.push(performance.now() - start);
      }
    }
    const median = runs.map(samples => {
      samples.sort((a, b) => a - b);
      return ((samples[3]! + samples[4]!) / 2).toFixed(1);
    });
    console.log(`${seconds}s view, eight stills, wall ms: original grouping ${median[0]}, current grouping ${median[1]}`);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
