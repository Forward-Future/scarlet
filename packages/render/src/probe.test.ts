import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveFfmpeg, runCapture, spawnStats } from "./exec.js";
import { hevcRowParallel, hexDump, probeMedia, probeToAssetFields } from "./probe.js";

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

it("tells an HEVC configuration whose pictures decode across their rows from one whose don't", () => {
  // An MP4 `hvcC` record: 22 header bytes, then one array holding one PPS NAL unit (type 34).
  const record = (pps: number[]) => Uint8Array.from([1, ...new Array(21).fill(0), 1, 0xa2, 0, 1, 0, pps.length, ...pps]);
  // A 4K camera's PPS, with wavefront rows (entropy_coding_sync_enabled_flag), and x265's with no-wpp.
  const camera = [0x44, 0x01, 0xc0, 0x2c, 0x60, 0xa6, 0x48];
  const noWpp = [0x44, 0x01, 0xc1, 0x72, 0xb4, 0x22, 0x40];
  expect(hevcRowParallel(record(camera))).toBe(true);
  expect(hevcRowParallel(record(noWpp))).toBe(false);
  // No PPS, a record cut short and an Annex B configuration keep the decoder's frame threads.
  expect(hevcRowParallel(Uint8Array.from([1, ...new Array(21).fill(0), 0]))).toBe(false);
  expect(hevcRowParallel(record(camera).subarray(0, 28))).toBe(false);
  expect(hevcRowParallel(Uint8Array.from([0, 0, 0, 1, ...record(camera).subarray(4)]))).toBe(false);
  // ffprobe's -show_data dump: an offset, 16 bytes over 40 columns, then the text.
  const dump = "\n00000000: 0101 6000 0000 b000 0000 0000 b7f0 00fc  ..`.............\n00000010: fdf8                                     ..\n";
  expect([...hexDump(dump)!]).toEqual([1, 1, 0x60, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 0xb7, 0xf0, 0, 0xfc, 0xfd, 0xf8]);
  expect(hexDump(undefined)).toBeUndefined();
});
