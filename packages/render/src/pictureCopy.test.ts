import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createProject, timelineFromKeepRanges, type MediaClip } from "@scarlet/timeline";
import { probeMedia, probeToAssetFields, renderFullCached, resolveFfmpeg, resolveFfprobe, runCapture } from "./index.js";

it("copies every original picture and timestamp while mixing edited audio, and encodes trims and smaller-file exports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-whole-picture-"));
  try {
    const ffmpeg = resolveFfmpeg(), source = join(dir, "original.mp4");
    await runCapture(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=256x144:r=30000/1001",
      "-f", "lavfi", "-i", "sine=frequency=392:sample_rate=48000:d=1", "-frames:v", "30", "-c:v", "libx264",
      "-bf", "0", "-g", "6", "-x264-params", "repeat-headers=1", "-threads", "1", "-c:a", "aac", "-metadata", "title=Camera title",
      "-metadata:s:v:0", "handler_name=Personal camera name", source]);
    const meta = await probeMedia(source), frames = meta.videoFrameCount!, duration = frames / meta.fps;
    const project = createProject("Sound only", { width: meta.width, height: meta.height, fps: meta.fps });
    project.media.push({ id: "cam", name: "Camera", path: source, kind: "video", ...probeToAssetFields(meta) });
    const timeline = timelineFromKeepRanges(project.id, "cam", [{ start: 0, end: duration }]);
    const camera = timeline.tracks[0]!.clips[0] as MediaClip;
    const options = { mediaRoot: dir, hwaccel: "none" as const, quality: "delivery" as const };
    const cache = join(dir, "cache"), output = join(dir, "out.mp4");
    const packets = async (file: string) => (await runCapture(resolveFfprobe(), ["-v", "error", "-select_streams", "v:0", "-show_packets",
      "-show_entries", "packet=data_hash,pts_time,duration_time", "-show_data_hash", "sha256", "-of", "csv=p=0", file])).stdout;
    const audio = async () => (await runCapture(ffmpeg, ["-v", "error", "-i", output, "-map", "0:a:0", "-c:a", "pcm_s16le", "-f", "hash", "-"])).stdout;
    const regular = await renderFullCached(project, timeline, cache, output, options);
    expect(regular.encoder).toBe("copy");
    expect(await packets(output)).toEqual(await packets(source));
    const resultProbe = await probeMedia(output);
    expect(resultProbe).toMatchObject({ fps: meta.fps, videoFrameCount: frames, hasAudio: true, sampleRate: project.settings.sampleRate });
    const container = resultProbe.raw as { format: { tags: { title?: string } }; streams: { tags?: { handler_name?: string } }[] };
    expect(container.format.tags.title).toBeUndefined();
    expect(container.streams[0]?.tags?.handler_name).not.toBe("Personal camera name");
    const configuration = async (file: string) => (await runCapture(resolveFfprobe(), ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=extradata_hash,sample_aspect_ratio", "-show_data_hash", "sha256", "-of", "csv=p=0", file])).stdout.toString();
    expect(await configuration(source)).toMatch(/SHA256:/);
    expect(await configuration(output)).toBe(await configuration(source));
    const originalAudio = await audio();
    camera.volume = 0.3;
    expect((await renderFullCached(project, timeline, cache, output, options)).encoder).toBe("copy");
    expect(await audio()).not.toEqual(originalAudio);
    expect(await packets(output)).toEqual(await packets(source));
    camera.sourceOut -= 1 / meta.fps;
    expect((await renderFullCached(project, timeline, cache, output, options)).encoder).toBe("libx264");
    camera.sourceOut = duration;
    expect((await renderFullCached(project, timeline, cache, output, { ...options, quality: "preview", exportHeight: meta.height })).encoder).toBe("libx264");
    // This one shifted PTS does not change either reported frame rate, the total frame count, or the duration.
    const shifted = join(dir, "irregular.mp4");
    await runCapture(ffmpeg, ["-v", "error", "-i", source, "-map", "0", "-c", "copy",
      "-bsf:v", "setts=pts=PTS+if(eq(N\\,8)\\,DURATION/2\\,0)", shifted]);
    expect(await probeMedia(shifted)).toMatchObject({ fps: meta.fps, videoFrameCount: frames, videoDuration: meta.videoDuration });
    project.media[0]!.path = shifted;
    expect((await renderFullCached(project, timeline, join(dir, "shifted-cache"), output, options)).encoder).toBe("libx264");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
