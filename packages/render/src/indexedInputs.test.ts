import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createProject, timelineFromKeepRanges } from "@scarlet/timeline";
import { buildFilterGraph, extractFrame, probeMedia, probeToAssetFields, renderRange, resolveFfmpeg, runCapture } from "./index.js";

it("seeks AVC and AAC from MP4 indices with the same pixels, timestamps and samples, including a delayed rotated stream", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-index-seek-"));
  const ffmpeg = resolveFfmpeg();
  try {
    const file = join(dir, "camera.mp4"), rotated = join(dir, "rotated.mp4");
    await runCapture(ffmpeg, ["-v", "error", "-itsoffset", "0.217", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30000/1001:d=3",
      "-f", "lavfi", "-i", "sine=sample_rate=48000:d=3.5", "-fps_mode", "passthrough", "-enc_time_base:v", "1:90000",
      "-c:v", "libx264", "-threads", "1", "-c:a", "aac", file]);
    await runCapture(ffmpeg, ["-v", "error", "-display_rotation", "90", "-i", file, "-map", "0:v:0", "-map", "0:a:0", "-map", "0:a:0", "-c", "copy", rotated]);
    for (const time of [0, .216, .234, .435, 2.13]) {
      expect(await extractFrame(rotated, time, { width: 160, indexedMp4: true })).toEqual(await extractFrame(rotated, time, { width: 160 }));
    }
    const meta = await probeMedia(rotated), project = createProject("Input index", { width: 320, height: 180, fps: meta.fps });
    project.media.push({ id: "cam", path: rotated, name: "Cam", kind: "video", ...probeToAssetFields(meta),
      originalPlaybackType: 'video/mp4; codecs="avc1,mp4a.40.2"', previewClock: meta.previewClock });
    const timeline = timelineFromKeepRanges(project.id, "cam", [{ start: .42, end: 1.02 }, { start: 1.56, end: 2.16 }]);
    const range = { start: 0, end: 1.2 };
    async function decoded(indexedInputs: boolean, pictureOnly: boolean) {
      const g = await buildFilterGraph(project, timeline, range, { mediaRoot: dir, indexedInputs, pictureOnly });
      try {
        expect(g.args.includes("-nofind_stream_info")).toBe(indexedInputs && pictureOnly);
        // A mixed PCM stream can be divided into different sized packets by FFmpeg's
        // scheduler. Hash the continuous samples, and check per-frame PTS on picture.
        const muxer = pictureOnly ? ["-f", "framemd5"] : ["-f", "streamhash", "-hash", "sha256"];
        return (await runCapture(ffmpeg, ["-v", "error", ...g.args, "-c:v", "rawvideo", "-c:a", "pcm_s16le", ...muxer, "-"])).stdout;
      } finally { await g.cleanup(); }
    }
    for (const pictureOnly of [true, false]) {
      expect(await decoded(true, pictureOnly)).toEqual(await decoded(false, pictureOnly));
    }
    const renamed = join(dir, "wrong-type.mp4");
    await runCapture(ffmpeg, ["-v", "error", "-i", file, "-c", "copy", "-f", "matroska", renamed]);
    expect(await extractFrame(renamed, 1, { indexedMp4: true })).toEqual(await extractFrame(renamed, 1));
    project.media[0]!.path = renamed;
    const rerender = await renderRange(project, timeline, range, join(dir, "retried.mp4"), { mediaRoot: dir, height: 90, pictureOnly: true });
    expect(rerender.args).not.toContain("-nofind_stream_info");
    const variable = join(dir, "variable.mp4");
    await runCapture(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=1",
      "-vf", "select=not(eq(mod(n\\,3)\\,1))", "-fps_mode", "vfr", "-c:v", "libx264", "-threads", "1", variable]);
    for (const input of [rotated, variable]) {
      const probed = await probeMedia(input);
      project.media[0] = { ...project.media[0]!, ...probeToAssetFields(probed), path: input, previewClock: undefined };
      const still = await buildFilterGraph(project, timeline, { start: 0, end: 1 / meta.fps }, {
        mediaRoot: dir, singleFrame: true, indexedInputs: true,
      });
      try { expect(still.args).not.toContain("-nofind_stream_info"); }
      finally { await still.cleanup(); }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("shares nearby frame-aligned picture reads without changing decoded frames or effect timing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-shared-gop-"));
  const ffmpeg = resolveFfmpeg(), fps = 30000 / 1001;
  try {
    const file = join(dir, "source.mp4");
    await runCapture(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30000/1001:d=6",
      "-c:v", "libx264", "-preset", "ultrafast", "-threads", "2", "-g", "150", "-pix_fmt", "yuv420p", file]);
    const meta = await probeMedia(file), project = createProject("Shared reads", { width: 640, height: 360, fps });
    project.media.push({ id: "cam", path: file, name: "Camera", kind: "video", ...probeToAssetFields(meta),
      originalPlaybackType: 'video/mp4; codecs="avc1"', previewClock: meta.previewClock });
    const frames = [[2, 24], [29, 51], [64, 86], [90, 112]];
    const cut = timelineFromKeepRanges(project.id, "cam", frames.map(([a, b]) => ({ start: a! / fps, end: b! / fps })));
    const clip = cut.tracks[0]!.clips[1]!;
    if (clip.kind === "media") {
      clip.videoFadeIn = .23;
      clip.effects.push({ type: "saturation", params: { value: 0.1 }, enabled: true });
    }
    const range = { start: 5 / fps, end: 83 / fps };
    async function pictures(indexedInputs: boolean, expectedInputs: number) {
      const g = await buildFilterGraph(project, cut, range, { mediaRoot: dir, pictureOnly: true, indexedInputs });
      try {
        expect(g.inputs).toHaveLength(expectedInputs);
        return (await runCapture(ffmpeg, ["-v", "error", ...g.args, "-c:v", "rawvideo", "-f", "framemd5", "-"])).stdout;
      } finally { await g.cleanup(); }
    }
    expect(await pictures(true, 1)).toEqual(await pictures(false, 4));
    // An older catalog can establish its missing clock from the actual file.
    project.media[0]!.previewClock = undefined;
    expect(await pictures(true, 1)).toEqual(await pictures(false, 4));
    const stillRange = { start: 17 / fps, end: 18 / fps };
    async function still(indexedInputs: boolean, probe = meta) {
      const graph = await buildFilterGraph(project, cut, stillRange, {
        mediaRoot: dir, indexedInputs, singleFrame: true, probes: new Map([["cam", probe]]),
      });
      try {
        const pixels = await runCapture(ffmpeg, ["-v", "error", ...graph.args, "-frames:v", "1", "-c:v", "rawvideo", "-f", "framemd5", "-"]);
        return { usedIndex: graph.args.includes("-nofind_stream_info"), pixels: pixels.stdout };
      } finally { await graph.cleanup(); }
    }
    const ordinary = await still(false);
    expect(await still(true)).toEqual({ usedIndex: true, pixels: ordinary.pixels });
    for (const patch of [{ rotation: 90 }, { videoStreamCount: 2 }, { videoStart: .1 }, { previewClock: undefined },
      { pixFmt: "yuva420p" }, { fps: 25 }, { formatName: "matroska,webm" }]) {
      expect((await still(true, { ...meta, ...patch })).usedIndex).toBe(false);
    }
    project.media[0]!.fps = 25;
    expect(await pictures(true, 4)).toEqual(await pictures(false, 4));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
