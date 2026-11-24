import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveFfmpeg, runCapture, spawnStats } from "./exec.js";
import { probeMedia, probeToAssetFields } from "./probe.js";

it("reads the length of a recording whose container leaves it out, once for as long as the file is the same", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-probe-"));
  try {
    // A browser's recorder writes WebM as it goes, with no length in the file; FFmpeg does the same writing to a pipe.
    const record = async (name: string, inputs: string[]) => {
      const { stdout } = await runCapture(resolveFfmpeg(), ["-v", "error", ...inputs, "-c:v", "libvpx", "-c:a", "libopus", "-f", "webm", "pipe:1"]);
      const file = join(dir, name);
      await writeFile(file, stdout);
      return file;
    };
    const screen = await record("screen.webm", ["-f", "lavfi", "-i", "testsrc=size=160x120:rate=25:duration=3.2", "-f", "lavfi", "-i", "sine=duration=3.2"]);
    const voice = await record("voice.webm", ["-f", "lavfi", "-i", "sine=duration=2.5"]);
    for (const [file, seconds] of [[screen, 3.2], [voice, 2.5]] as const) {
      const probe = await probeMedia(file);
      expect((probe.raw as { format?: { duration?: string } }).format?.duration).toBeUndefined();
      expect(probe.duration).toBeCloseTo(seconds, 1);
      expect(probeToAssetFields(probe).duration).toBeCloseTo(seconds, 1);
      const spawned = spawnStats.ffmpeg + spawnStats.ffprobe;
      expect((await probeMedia(file)).duration).toBe(probe.duration);
      expect(spawnStats.ffmpeg + spawnStats.ffprobe).toBe(spawned);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
