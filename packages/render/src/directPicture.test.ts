import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createProject, timelineFromKeepRanges } from "@scarlet/timeline";
import * as ffmpeg from "./exec.js";
import { probeMedia, probeToAssetFields } from "./probe.js";
import { renderRange } from "./render.js";

it("delivers a plain shot directly and recomposites when its decoded frame clock changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-direct-picture-"));
  try {
    const source = join(dir, "clip.mp4"), fps = 30000 / 1001;
    await ffmpeg.runCapture(ffmpeg.resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30000/1001:d=2",
      "-c:v", "libx264", "-g", "30", "-pix_fmt", "yuv420p", source]);
    const probe = await probeMedia(source);
    const project = createProject("Direct", { width: 320, height: 180, fps });
    project.media.push({ id: "cam", name: "clip", kind: "video", path: source, ...probeToAssetFields(probe), previewClock: probe.previewClock });
    const range = { start: 0, end: 15 / fps };
    const timeline = timelineFromKeepRanges(project.id, "cam", [{ start: 17 / fps, end: 32 / fps }]);
    const run = ffmpeg.runFfmpeg;
    const output = join(dir, "section.mp4");
    // Exercise real seeks, frame stats, and FFmpeg output on machines without VideoToolbox.
    const worker = vi.spyOn(ffmpeg, "runFfmpeg").mockImplementation(async (actual, opts) => {
      const args = [...actual];
      const device = args.indexOf("-hwaccel");
      if (device >= 0) args.splice(device, 4);
      const pix = args.indexOf("-pix_fmt");
      args[pix + 1] = "yuv420p";
      args[args.indexOf("-c:v") + 1] = "libx264";
      return run(args, opts);
    });
    try {
      const options = { mediaRoot: dir, quality: "delivery" as const, pictureOnly: true, hwaccel: "videotoolbox" as const,
        videoEncoder: { name: "h264_videotoolbox", cacheKey: "test", args: ["-crf", "0"], pixelFormat: "yuv420p" as const } };
      const direct = await renderRange(project, timeline, range, output, options);
      expect(direct.args).toContain("-hwaccel_output_format");
      expect(direct.args).not.toContain("[vout]");
      const frames = async () => (await ffmpeg.runCapture(ffmpeg.resolveFfmpeg(), ["-v", "error", "-i", output, "-f", "framemd5", "-"])).stdout;
      const expected = await frames();
      const baseline = await renderRange(project, timeline, range, output, { ...options, softwareDecode: true });
      expect(baseline.args).toContain("[vout]");
      expect(await frames()).toEqual(expected);
      const native = worker.getMockImplementation()!;
      worker.mockImplementation(async (args, opts) => {
        const result = await native(args, opts);
        if (args.includes("-stats_enc_pre:v")) {
          const stats = args[args.indexOf("-stats_enc_pre:v") + 1]!;
          const lines = (await readFile(stats, "utf8")).trimEnd().split("\n");
          // Same apparent frame count, with a repeated frame concealing a missing source picture.
          lines[7] = lines[6]!;
          await writeFile(stats, lines.join("\n") + "\n");
        }
        return result;
      });
      const fallback = await renderRange(project, timeline, range, output, options);
      expect(fallback.args).toContain("[vout]");
      expect(await frames()).toEqual(expected);
    } finally { worker.mockRestore(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
