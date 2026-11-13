import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createProject, timelineFromKeepRanges } from "@scarlet/timeline";
import * as ffmpegExec from "./exec.js";
import { probeMedia, probeToAssetFields, renderFullCached, renderRange, resolveFfmpeg, resolveFfprobe, runCapture } from "./index.js";

it("keeps the export canvas when the source changes dimensions halfway through a constant-rate AVC stream", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-changing-avc-"));
  try {
    const ffmpeg = resolveFfmpeg(), fps = 5;
    const picture = async (size: string) => (await runCapture(ffmpeg, ["-v", "error", "-f", "lavfi", "-i",
      `testsrc2=s=${size}:r=${fps}:d=1`, "-c:v", "libx264", "-bf", "0", "-threads", "1", "-f", "h264", "pipe:1"])).stdout;
    const source = join(dir, "changing.mp4");
    await runCapture(ffmpeg, ["-v", "error", "-r", String(fps), "-f", "h264", "-i", "pipe:0", "-c:v", "copy", source],
      { stdin: Buffer.concat([await picture("320x180"), await picture("256x144")]) });
    const frameSizes = async (file: string): Promise<number[][]> => {
      const { stdout } = await runCapture(resolveFfprobe(), ["-v", "error", "-select_streams", "v:0", "-show_frames",
        "-show_entries", "frame=width,height", "-of", "json", file]);
      const result = JSON.parse(stdout.toString()) as { frames: { width: number; height: number }[] };
      return result.frames.map(frame => [frame.width, frame.height]);
    };
    const meta = await probeMedia(source);
    expect(meta).toMatchObject({ width: 320, height: 180, fps, videoFrameCount: 10, videoDuration: 2, videoBFrames: 0 });
    expect(await frameSizes(source)).toEqual([...Array(5).fill([320, 180]), ...Array(5).fill([256, 144])]);
    const project = createProject("Changing camera format", { width: 320, height: 180, fps });
    project.media.push({ id: "cam", name: "Recording", kind: "video", path: source, ...probeToAssetFields(meta) });
    const timeline = timelineFromKeepRanges(project.id, "cam", [{ start: 0, end: 2 }]);
    const output = join(dir, "out.mp4");
    const result = await renderFullCached(project, timeline, join(dir, "cache"), output,
      { mediaRoot: dir, quality: "delivery", hwaccel: "none", segmentSeconds: 1 });
    expect(result.encoder).toBe("libx264");
    expect(await frameSizes(output)).toEqual(Array(10).fill([320, 180]));

    // Run the real FFmpeg driver-neutral checks on machines with no hardware encoder.
    const run = ffmpegExec.runFfmpeg;
    const worker = vi.spyOn(ffmpegExec, "runFfmpeg").mockImplementation((actual, options) => {
      const args = [...actual];
      const device = args.indexOf("-hwaccel");
      if (device >= 0) args.splice(device, 4);
      args[args.indexOf("-c:v") + 1] = "libx264";
      args[args.indexOf("-pix_fmt") + 1] = "yuv420p";
      return run(args, options);
    });
    try {
      const direct = await renderRange(project, timeline, { start: 1, end: 2 }, output, {
        mediaRoot: dir, quality: "delivery", pictureOnly: true, hwaccel: "videotoolbox",
        videoEncoder: { name: "h264_videotoolbox", cacheKey: "test", args: ["-crf", "0"], pixelFormat: "yuv420p" },
      });
      expect(worker.mock.calls.some(([args]) => args.includes("-hwaccel_output_format"))).toBe(true);
      expect(direct.args).toContain("[vout]");
      expect(await frameSizes(output)).toEqual(Array(5).fill([320, 180]));
    } finally { worker.mockRestore(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
