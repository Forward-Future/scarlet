import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyOps, createProject, makeMediaClip, planPlaybackSegments, timelineFromKeepRanges } from "@scarlet/timeline";
import type { MediaClip, Project, Timeline } from "@scarlet/timeline";
import * as ffmpeg from "./exec.js";
import {
  atempoFactors,
  assembleSegments,
  buildFilterGraph,
  checkFfmpeg,
  detectMediaKind,
  effectFilters,
  encoderArgs,
  escapeFilterPath,
  extractFrame,
  extractFilmstrip,
  extractWaveform,
  extractWaveformFull,
  ffColor,
  ffmpegVersion,
  hashFile,
  isImagePath,
  keyframeExpr,
  lutFileStamps,
  makeProxy,
  outputSize,
  parseRate,
  planSegments,
  probeMedia,
  probeToAssetFields,
  renderFullCached,
  renderPlaybackSegment,
  renderRange,
  renderTimelineFrame,
  resolveFontFile,
  resolveVideoEncoder,
  runCapture,
  segmentKey,
  snapRange,
  spawnStats,
  usesRevisedProxyClock,
  waveformFromCache,
  wrapText,
} from "./index.js";

let dir: string;
let src: string;
let logo: string;
let still: string;

it("exports picture and sound without source chapters, including when reassembling older audio", async () => {
  const metadata = path.join(dir, "synthetic-chapters.txt");
  await fs.writeFile(metadata, ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=500\ntitle=Fixture chapter\n");
  const source = path.join(dir, "chaptered.mp4");
  await runCapture("ffmpeg", ["-v", "error", "-i", src, "-f", "ffmetadata", "-i", metadata, "-t", "1", "-map", "0:v:0", "-map", "0:a:0", "-map_chapters", "1", "-c", "copy", source]);
  const chapters = async (file: string) => JSON.parse((await runCapture("ffprobe", ["-v", "error", "-show_chapters", "-of", "json", file])).stdout.toString()).chapters;
  expect(await chapters(source)).toHaveLength(1);
  const { project, timeline } = fixture();
  project.media[0]!.path = path.basename(source);
  timeline.tracks = [{ ...timeline.tracks[0]!, clips: [makeMediaClip("m1", 0, 0.5, 0)] }];
  const opts = { mediaRoot: dir, quality: "delivery" as const };
  const cache = path.join(dir, "chapterless-cache");
  const output = path.join(dir, "chapterless.mp4");
  const result = await renderFullCached(project, timeline, cache, output, opts);
  expect(await chapters(output)).toEqual([]);
  for (const file of await fs.readdir(cache)) expect(await chapters(path.join(cache, file))).toEqual([]);
  await assembleSegments(result.segments.map(s => s.file), path.join(dir, "reassembled.mp4"), {
    completedAudio: { file: source, pictureDurations: [0.5], sampleRate: project.settings.sampleRate },
  });
  expect(await chapters(path.join(dir, "reassembled.mp4"))).toEqual([]);
});

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "scarlet-render-test-"));
  src = path.join(dir, "src.mp4");
  logo = path.join(dir, "logo.png");
  still = path.join(dir, "still.png");
  const common = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];
  await runCapture("ffmpeg", [
    ...common,
    "-f", "lavfi", "-i", "testsrc2=duration=10:size=320x180:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=10",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", src,
  ]);
  await runCapture("ffmpeg", [
    ...common, "-f", "lavfi", "-i", "color=c=red@0.5:s=64x64:d=0.1,format=rgba", "-frames:v", "1", "-update", "1", logo,
  ]);
  await runCapture("ffmpeg", [
    ...common, "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=0.1,format=rgb24", "-frames:v", "1", "-update", "1", still,
  ]);
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** 320x180 project with two video tracks, a caption track and the test media. */
function fixture(): { project: Project; timeline: Timeline } {
  const project = createProject("Render test", { width: 320, height: 180, fps: 30, aspect: "custom" });
  project.media.push(
    { id: "m1", kind: "video", name: "src.mp4", path: "src.mp4", duration: 10, fps: 30, width: 320, height: 180, hasAudio: true },
    { id: "logo", kind: "graphic", name: "logo.png", path: "logo.png", hasAlpha: true },
  );
  const timeline: Timeline = {
    version: "draft",
    parent: null,
    projectId: project.id,
    name: "Main",
    background: "#101010",
    markers: [],
    captionStyle: { fontSize: 0.08, backgroundColor: "#00000080" },
    tracks: [
      {
        id: "v1", kind: "video", name: "V1", muted: false, hidden: false,
        clips: [
          makeMediaClip("m1", 0, 3, 0, { id: "c1", videoFadeIn: 0.5, audioFadeIn: 0.5 }),
          makeMediaClip("m1", 5, 8, 3, { id: "c2", speed: 1.5, volume: 0.6, effects: [{ type: "saturation", params: { value: 1.3 }, enabled: true }, { type: "nope", params: {}, enabled: true }] }),
        ],
      },
      {
        id: "v2", kind: "video", name: "V2", muted: false, hidden: false,
        clips: [
          { id: "col", kind: "color", timelineIn: 1, timelineOut: 2.5, color: "#FF8800", opacity: 0.7, enabled: true, transform: { x: 0.25, y: -0.2, scale: 0.4, rotation: 10, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 } },
          makeMediaClip("logo", 0, 2, 2, {
            id: "lg",
            keyframes: [
              { time: 0, transform: { x: -0.3, scale: 0.3 }, ease: "linear" },
              { time: 2, transform: { x: 0.3, scale: 0.5 }, ease: "easeInOut" },
            ],
          }),
        ],
      },
      {
        id: "c", kind: "caption", name: "Captions", muted: false, hidden: false,
        clips: [
          { id: "cap1", kind: "caption", timelineIn: 0.5, timelineOut: 2.5, text: "Hello, world: it's 100% 'fine' [ok]; \\ done", enabled: true },
          { id: "cap2", kind: "caption", timelineIn: 3, timelineOut: 5, text: "second caption", enabled: true, style: { align: "left", color: "#FFD700", outlineWidth: 0.1, outlineColor: "#000000" } },
        ],
      },
    ],
  };
  return { project, timeline };
}

async function probeOut(file: string) {
  const p = await probeMedia(file);
  return { duration: p.duration, width: p.width, height: p.height, hasAudio: p.hasAudio, fps: p.fps };
}

async function longestKeyframeGap(file: string, duration: number) {
  const { stdout } = await runCapture("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_packets",
    "-show_entries", "packet=pts_time,flags", "-of", "json", file]);
  const { packets } = JSON.parse(stdout.toString()) as { packets: { pts_time: string; flags: string }[] };
  const keys = packets.filter(p => p.flags.includes("K")).map(p => Number(p.pts_time));
  expect(keys[0]).toBeCloseTo(0);
  return Math.max(...keys.map((time, i) => (keys[i + 1] ?? duration) - time));
}

it("defaults previews to 540p and honors explicit preview and export heights", () => {
  const { settings } = createProject("HD", { width: 1920, height: 1080 });
  expect(outputSize(settings, "preview")).toEqual({ width: 960, height: 540 });
  expect(outputSize(settings, "preview", 720)).toEqual({ width: 1280, height: 720 });
  expect(outputSize(settings, "preview", undefined, 1080)).toEqual({ width: 1920, height: 1080 });
  expect(outputSize(settings, "delivery")).toEqual({ width: 1920, height: 1080 });
});

it("exports a resized frame range with optional captions and an equally long audio track", async () => {
  const { project, timeline } = fixture();
  const cache = path.join(dir, "export-sheet-cache");
  const options = { mediaRoot: dir, quality: "delivery" as const, hwaccel: "none" as const, exportHeight: 90,
    exportRange: { start: 1, end: 2 }, segmentSeconds: 1 };
  const saved = async (omitCaptions: boolean) => {
    const file = path.join(dir, `export-captions-${omitCaptions}.mp4`);
    await renderFullCached(project, timeline, cache, file, { ...options, omitCaptions });
    const meta = JSON.parse((await runCapture("ffprobe", ["-v", "error", "-show_entries",
      "stream=codec_type,width,height,duration,nb_frames,start_time", "-of", "json", file])).stdout.toString()).streams;
    expect(meta[0]).toMatchObject({ codec_type: "video", width: 160, height: 90, nb_frames: "30" });
    expect(Number(meta[0].start_time)).toBeCloseTo(0, 4);
    expect(meta[1].codec_type).toBe("audio");
    expect(Number(meta[1].duration)).toBeCloseTo(1, 2);
    return (await runCapture("ffmpeg", ["-v", "error", "-ss", "0.5", "-i", file, "-frames:v", "1", "-f", "md5", "-"])).stdout.toString();
  };
  expect(await saved(true)).not.toBe(await saved(false));
});

describe("ffmpeg", () => {
  it("samples distant frames, including the last, identically to one continuous filmstrip decode", async () => {
    const frames = [0, 146, 299];
    const filter = `fps=30:round=near,select='${frames.map(f => `eq(n,${f})`).join("+")}',`
      + "scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2,setsar=1,tile=3x1:padding=1:color=black";
    const { stdout } = await runCapture(ffmpeg.resolveFfmpeg(), ["-v", "error", "-i", src, "-an", "-vf", filter,
      "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "4", "-f", "image2pipe", "-"]);
    expect((await extractFilmstrip(src, frames, 30)).equals(stdout)).toBe(true);
  });

  it("keeps portrait frames upright and unpadded in the completed timeline filmstrip", async () => {
    const portrait = path.join(dir, "portrait-strip.mp4");
    await runCapture(ffmpeg.resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=180x320:r=30:d=1",
      "-c:v", "libx264", "-threads", "1", portrait]);
    const sheet = path.join(dir, "portrait-strip.jpg");
    await fs.writeFile(sheet, await extractFilmstrip(portrait, [0, 10, 20], 30, undefined, "source-aspect"));
    const { width, height } = await probeMedia(sheet);
    expect({ width, height }).toEqual({ width: 3 * 51, height: 90 });
  });

  it("keeps NVENC available for larger renders after a small frame is rejected", async () => {
    const bin = path.join(dir, "size-sensitive-ffmpeg");
    const encoders = vi.spyOn(ffmpeg, "ffmpegEncoders").mockResolvedValue(new Set(["h264_nvenc", "h264_qsv"]));
    const probe = vi.spyOn(ffmpeg, "runCapture").mockImplementation(async (_bin, args) => {
      if (args.includes("h264_nvenc") && args.some(arg => arg.includes("s=128x128"))) {
        throw new Error("Frame dimension below minimum");
      }
      return { code: 0, stdout: Buffer.alloc(0), stderr: "" };
    });
    try {
      const small = { width: 128, height: 128 };
      expect(await resolveVideoEncoder("auto", bin, small)).toBe("h264_qsv");
      expect(await resolveVideoEncoder("auto", bin, { width: 1920, height: 1080 })).toBe("h264_nvenc");
      expect(await resolveVideoEncoder("nvenc", bin, small)).toBe("libx264");
      expect(probe).toHaveBeenCalledTimes(3);
    } finally {
      probe.mockRestore();
      encoders.mockRestore();
    }
  });

  it("uses Windows Media Foundation hardware when no vendor encoder works for the export", async () => {
    const encoders = vi.spyOn(ffmpeg, "ffmpegEncoders").mockResolvedValue(new Set(["h264_mf"]));
    const probe = vi.spyOn(ffmpeg, "runCapture").mockResolvedValue({ code: 0, stdout: Buffer.alloc(0), stderr: "" });
    try {
      const bin = path.join(dir, "mf-ffmpeg");
      expect(await resolveVideoEncoder("nvenc", bin, undefined, undefined, "delivery")).toBe("h264_mf");
      const args = probe.mock.calls[0]![1];
      expect(args[args.indexOf("-hw_encoding") + 1]).toBe("1");
      expect(args[args.indexOf("-pix_fmt") + 1]).toBe("nv12");
      expect(await resolveVideoEncoder("none", bin, undefined, undefined, "delivery")).toBe("libx264");
      expect(probe).toHaveBeenCalledTimes(1);
    } finally {
      probe.mockRestore();
      encoders.mockRestore();
    }
  });

  it("is available", async () => {
    const check = await checkFfmpeg();
    expect(check.ok).toBe(true);
    expect(check.ffmpeg.version).toMatch(/ffmpeg version/);
  });

  it("reports which of the two tools would not start, and offers no encoders without ffmpeg", async () => {
    const missing = path.join(dir, "no-such-tool");
    const neither = await checkFfmpeg({ ffmpegPath: missing, ffprobePath: missing });
    expect(neither.ok).toBe(false);
    expect([neither.ffmpeg.path, neither.ffprobe.path]).toEqual([missing, missing]);
    expect(neither.ffmpeg.error).toMatch(/failed to start/);
    expect(neither.ffprobe.error).toMatch(/failed to start/);
    expect(neither.hwEncoders).toEqual([]);
    const noProbe = await checkFfmpeg({ ffprobePath: missing });
    expect([noProbe.ok, noProbe.ffmpeg.error, noProbe.ffprobe.version]).toEqual([false, undefined, undefined]);
    expect(noProbe.ffmpeg.version).toMatch(/ffmpeg version/);
  });
});

describe("probe", () => {
  it("recognizes a container's separate alpha plane even when ffprobe reports yuv420p", async () => {
    const file = path.join(dir, "tagged-alpha.mkv");
    await runCapture("ffmpeg", ["-v", "error", "-i", src, "-t", "1", "-map", "0:v:0", "-c:v", "copy",
      "-metadata:s:v:0", "alpha_mode=1", file]);
    expect(await probeMedia(file)).toMatchObject({ hasAlpha: true, pixFmt: "yuv420p" });
  });

  it("reuses unchanged media metadata and re-probes a replaced source", async () => {
    const file = path.join(dir, "probe-cache.mp4");
    await fs.copyFile(src, file);
    const before = spawnStats.ffprobe;
    const original = await probeMedia(file);
    original.raw = null;
    const second = await probeMedia(file);
    expect(second.raw).not.toBeNull();
    expect(spawnStats.ffprobe).toBe(before + 1);
    await expect(probeMedia(file, { signal: AbortSignal.abort() })).rejects.toThrow();
    await fs.copyFile(still, file);
    expect((await probeMedia(file)).isStillImage).toBe(true);
    expect(spawnStats.ffprobe).toBe(before + 2);
  });

  it("matches the displayed dimensions of rotated phone footage", async () => {
    const portrait = path.join(dir, "portrait.mp4");
    await runCapture("ffmpeg", ["-v", "error", "-display_rotation", "90", "-i", src, "-c", "copy", portrait]);
    expect(await probeMedia(portrait)).toMatchObject({ width: 180, height: 320, fps: 30 });
  });

  it("rejects media manifests that reference a second local file", async () => {
    const playlist = path.join(dir, "playlist.m3u8");
    await fs.writeFile(playlist, `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n${path.basename(src)}\n#EXT-X-ENDLIST\n`);
    await expect(probeMedia(playlist)).rejects.toThrow();
  });

  it("reads duration, fps, size and audio", async () => {
    const p = await probeMedia(src);
    expect(p.duration).toBeGreaterThan(9.8);
    expect(p.duration).toBeLessThan(10.2);
    expect(p.fps).toBe(30);
    expect(p.width).toBe(320);
    expect(p.height).toBe(180);
    expect(p.hasAudio).toBe(true);
    expect(p.hasAlpha).toBe(false);
    expect(detectMediaKind(p)).toBe("video");
  });

  it("reads a sound file as audio with no picture, and leaves out what a file does not have", async () => {
    const sound = path.join(dir, "sound.wav");
    await runCapture("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5:sample_rate=22050", "-ac", "1", sound]);
    const p = await probeMedia(sound);
    expect([p.hasVideo, p.hasAudio, p.isStillImage, p.hasAlpha, p.fps, p.width, p.height, p.rotation]).toEqual([false, true, false, false, 0, 0, 0, 0]);
    expect([p.sampleRate, p.channels, p.audioCodec]).toEqual([22050, 1, "pcm_s16le"]);
    expect(p.duration).toBeCloseTo(1.5, 2);
    expect(p.previewClock).toBeUndefined();
    expect(detectMediaKind(p)).toBe("audio");
    expect(probeToAssetFields(p)).toEqual({ duration: p.duration, fps: undefined, width: undefined, height: undefined, hasAudio: true, hasAlpha: false });
    await expect(probeMedia(path.join(dir, "not-there.wav"))).rejects.toThrow(/No such file/);
  });

  it("calls a picture with transparency a graphic, moving or still, and goes by the name when a probe cannot tell", () => {
    const base = { path: "clip.mov", duration: 2, fps: 30, width: 64, height: 64, hasVideo: true, hasAudio: false, hasAlpha: false, isStillImage: false, rotation: 0, raw: null };
    expect(detectMediaKind(base)).toBe("video");
    expect(detectMediaKind({ ...base, hasAlpha: true })).toBe("graphic");
    expect(detectMediaKind({ ...base, isStillImage: true })).toBe("image");
    expect(detectMediaKind({ ...base, hasVideo: false, hasAudio: true })).toBe("audio");
    // The name the editor imported it under wins over the stored path.
    expect(detectMediaKind(base, "Poster.JPG")).toBe("image");
    expect(detectMediaKind({ ...base, hasAlpha: true }, "logo.webp")).toBe("graphic");
    expect(["a.PNG", "b.tiff", "c.heic", "/x/y.gif"].map(isImagePath)).toEqual([true, true, true, true]);
    expect(["a.mp4", "png", "c.png.mov", ""].map(isImagePath)).toEqual([false, false, false, false]);
  });

  it("hashes a file as it reads it, and fails on one that is not there or when cancelled", async () => {
    const read: number[] = [];
    const hash = await hashFile(src, bytes => read.push(bytes));
    expect(hash).toBe(createHash("sha256").update(await fs.readFile(src)).digest("hex"));
    expect(read.at(-1)).toBe((await fs.stat(src)).size);
    await expect(hashFile(path.join(dir, "not-there.mp4"))).rejects.toThrow(/ENOENT/);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(hashFile(src, undefined, cancelled.signal)).rejects.toThrow(/abort/i);
  });

  it("classifies stills and hashes files", async () => {
    const a = await probeMedia(logo);
    expect(a.isStillImage).toBe(true);
    expect(a.hasAlpha).toBe(true);
    expect(detectMediaKind(a)).toBe("graphic");
    const b = await probeMedia(still);
    expect(detectMediaKind(b)).toBe("image");
    const hash = await hashFile(src);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

it("keeps a flash and beep aligned when seeking in the original and the completed proxy", async () => {
  const original = path.join(dir, "sync-original.mp4");
  const proxy = path.join(dir, "sync-proxy.mp4");
  const pulses = "between(t,1,1.15)+between(t,4,4.15)";
  await runCapture("ffmpeg", ["-v", "error", "-y",
    "-f", "lavfi", "-i", `color=black:s=128x72:r=30:d=6,drawbox=color=white:t=fill:enable='${pulses}'`,
    "-f", "lavfi", "-i", `aevalsrc='0.8*sin(2*PI*1000*t)*(${pulses})':s=48000:d=6`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "-shortest", original]);
  const gpuProxy = path.join(dir, "sync-proxy-gpu.mp4");
  await makeProxy(original, proxy, { height: 64 });
  // Uses the GPU encoder where one works, and libx264 otherwise.
  await makeProxy(original, gpuProxy, { height: 64, hwaccel: "auto" });
  expect(await longestKeyframeGap(proxy, 6)).toBeLessThanOrEqual(0.5 + 1 / 30);
  expect(await longestKeyframeGap(gpuProxy, 6)).toBeLessThanOrEqual(0.5 + 1 / 30);
  expect((await probeMedia(gpuProxy)).height).toBe(64);
  for (const file of [original, proxy, gpuProxy]) {
    for (const seek of [3.5, 0.5]) {
      const input = ["-v", "error", "-ss", String(seek), "-i", file, "-t", "0.8"];
      const video = await runCapture("ffmpeg", [...input, "-an", "-vf", "scale=2:2,format=gray", "-f", "rawvideo", "-"]);
      const audio = await runCapture("ffmpeg", [...input, "-vn", "-ar", "48000", "-ac", "1", "-f", "s16le", "-"]);
      const flash = video.stdout.findIndex((v, i) => i % 4 === 0 && v > 200) / 4 / 30;
      let beep = -1;
      for (let i = 0; i + 1 < audio.stdout.length; i += 2) {
        if (Math.abs(audio.stdout.readInt16LE(i)) > 4500) { beep = i / 2 / 48000; break; }
      }
      expect(flash).toBeCloseTo(0.5, 2);
      expect(Math.abs(beep - flash)).toBeLessThan(1 / 30);
    }
  }
});

it("keeps a delayed microphone aligned with the picture in a preview and a delivery", async () => {
  const input = path.join(dir, "delayed-microphone.mp4");
  await runCapture("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
    "color=black:s=64x64:r=30:d=1.5,drawbox=color=white:t=fill:enable='gte(t,0.5)'",
    "-itsoffset", "0.5", "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=48000",
    "-c:v", "libx264", "-c:a", "aac", input]);
  const project = createProject("Audio offset", { width: 64, height: 64 });
  project.media.push({ id: "mic", name: "camera", kind: "video", path: input, hasAudio: true });
  const timeline = timelineFromKeepRanges(project.id, "mic", [{ start: 0, end: 1.5 }]);
  for (const quality of ["preview", "delivery"] as const) {
    const output = path.join(dir, `delayed-${quality}.mp4`);
    const range = { start: quality === "preview" ? 0.2 : 0, end: 1.5 };
    if (quality === "delivery") await renderFullCached(project, timeline, path.join(dir, "delayed-cache"), output, { mediaRoot: dir, quality });
    else await renderRange(project, timeline, range, output, { mediaRoot: dir, quality });
    const decode = ["-v", "error", "-i", output];
    const video = await runCapture("ffmpeg", [...decode, "-an", "-vf", "scale=2:2,format=gray", "-f", "rawvideo", "-"]);
    const audio = await runCapture("ffmpeg", [...decode, "-vn", "-ar", "48000", "-ac", "1", "-f", "s16le", "-"]);
    const flash = video.stdout.findIndex((v,i) => i % 4 === 0 && v > 200) / 4 / 30;
    let tone = -1;
    for (let i = 0; i < audio.stdout.length; i += 2) {
      if (Math.abs(audio.stdout.readInt16LE(i)) > 1000) { tone = i / 2 / 48000; break; }
    }
    expect(flash).toBeCloseTo(0.5 - range.start, 2);
    expect(Math.abs(flash - tone)).toBeLessThan(1 / 30);
  }
});

it("reuses the last completed proxy section after interruption and preserves the audio clock", async () => {
  const input = path.join(dir, "long.mp4"), output = path.join(dir, "preview.mp4");
  await runCapture("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=32x32:r=30000/1001:d=32",
    "-f", "lavfi", "-i", "sine=d=32", "-c:v", "libx264", "-c:a", "aac", input]);
  const controller = new AbortController(), checkpointDir = path.join(dir, "parts");
  const part = path.join(checkpointDir, "libx264-32", "0.mp4");
  await expect(makeProxy(input, output, { height: 32, checkpointDir, signal: controller.signal, onProgress: () => {
    if (syncFs.existsSync(part)) controller.abort();
  } })).rejects.toThrow();
  const before = await fs.stat(part);
  const progress: number[] = [];
  await makeProxy(input, output, { height: 32, checkpointDir, onProgress: p => progress.push(p) });
  expect((await fs.stat(part)).mtimeMs).toBe(before.mtimeMs);
  // The final audio and join pass is part of the bar, so it doesn't sit at 100% while it runs.
  expect(progress.slice(0, -1).every(p => p < 1)).toBe(true);
  expect(progress).toEqual([...progress].sort((a, b) => a - b));
  expect(progress.at(-1)).toBe(1);
  const [original, proxy] = await Promise.all([probeMedia(input), probeMedia(output)]);
  expect(proxy.hasAudio).toBe(true);
  expect(proxy.duration).toBeCloseTo(original.duration, 1);
  const count = (file: string) => runCapture("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=nb_frames", "-of", "csv=p=0", file]).then(result => result.stdout.toString().trim());
  expect(await count(output)).toBe(await count(input));
});

function pictureTimes(file: string) {
  return runCapture("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "frame=pts_time", "-of", "csv=p=0", file]).then(result => result.stdout.toString().split("\n").filter(Boolean).map(parseFloat));
}

it("resumes a recording whose frame rate drifts and keeps each picture at its source time", async () => {
  // A phone recording at 29.97 that drops two pictures before it ends: its measured rate no longer matches the declared one.
  const input = path.join(dir, "drifting.mp4"), output = path.join(dir, "drifting-preview.mp4");
  await runCapture("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=32x32:r=30000/1001:d=32",
    "-f", "lavfi", "-i", "sine=d=32", "-vf", "select='not(between(n\\,950\\,951))'", "-fps_mode", "passthrough",
    "-c:v", "libx264", "-c:a", "aac", input]);
  const source = await probeMedia(input);
  expect(source.previewClock).toBeUndefined();
  const controller = new AbortController(), checkpointDir = path.join(dir, "drifting-parts");
  const part = path.join(checkpointDir, "libx264-32", "0.mp4");
  await expect(makeProxy(input, output, { height: 32, checkpointDir, signal: controller.signal, onProgress: () => {
    if (syncFs.existsSync(part)) controller.abort();
  } })).rejects.toThrow();
  const before = await fs.stat(part);
  // An interrupted older encode could leave a later part with a rounded frame offset. Only its first part is reusable.
  await fs.writeFile(path.join(path.dirname(part), "1.mp4"), "superseded VFR checkpoint");
  await makeProxy(input, output, { height: 32, checkpointDir });
  expect((await fs.stat(part)).mtimeMs).toBe(before.mtimeMs);
  // The second part's boundary falls between pictures, so its first one starts a moment in and must stay there.
  const [want, got] = await Promise.all([pictureTimes(input), pictureTimes(output)]);
  expect(got.length).toBe(want.length);
  expect(Math.max(...got.map((t, i) => Math.abs(t - want[i]!)))).toBeLessThan(1e-4);
});

it("keeps every later picture when a screen recording holds one frame across an entire checkpoint", async () => {
  const input = path.join(dir, "sparse-screen.mp4"), output = path.join(dir, "sparse-proxy.mp4");
  await runCapture("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=32x32:r=10:d=72",
    "-f", "lavfi", "-i", "sine=d=72", "-vf", "select='lt(t,1)+gt(t,65)'", "-fps_mode", "passthrough", "-c:v", "libx264", "-c:a", "aac", input]);
  const checkpointDir = path.join(dir, "sparse-parts"), want = await pictureTimes(input);
  expect(want).toHaveLength(79);
  expect(want.at(-1)).toBe(71.9);
  await makeProxy(input, output, { height: 32, checkpointDir });
  expect(await pictureTimes(output)).toEqual(want);
  const last = path.join(checkpointDir, "libx264-32", "pts-2.mp4");
  const stamp = (await fs.stat(last)).mtimeMs;
  await makeProxy(input, output, { height: 32, checkpointDir });
  expect((await fs.stat(last)).mtimeMs).toBe(stamp);
  expect(await pictureTimes(output)).toEqual(want);
});

it("keeps the first picture on its source tick when sound leads by more than a checkpoint", async () => {
  const input = path.join(dir, "late-camera.mp4"), output = path.join(dir, "late-camera-proxy.mp4");
  await runCapture("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=32x32:r=30000/1001:d=32",
    "-f", "lavfi", "-i", "sine=d=68", "-vf", "setpts=PTS+1057", "-fps_mode", "passthrough",
    "-movie_timescale", "1000000", "-c:v", "libx264", "-c:a", "aac", input]);
  await makeProxy(input, output, { height: 32, checkpointDir: path.join(dir, "late-camera-parts") });
  const [want, got] = await Promise.all([pictureTimes(input), pictureTimes(output)]);
  expect(want[0]).toBeCloseTo(35.268567, 6);
  expect(got).toEqual(want);
});

describe("waveform", () => {
  it("returns N normalized points", async () => {
    const wf = await extractWaveform(src, { from: 0, to: 10, points: 100 });
    expect(wf.peaks.length).toBe(100);
    expect(wf.rms.length).toBe(100);
    for (const v of wf.peaks) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(Math.max(...wf.peaks)).toBeGreaterThan(0.1);
  });

  it("caches a whole file and downsamples", async () => {
    const cache = await extractWaveformFull(src, 10, 50);
    expect(cache.peaks.length).toBe(500);
    const wf = waveformFromCache(cache, 2, 4, 20);
    expect(wf.peaks.length).toBe(20);
    expect(Math.max(...wf.peaks)).toBeGreaterThan(0.1);
  });

  it("streams fractional waveform buckets with identical peaks, RMS and silence after the audio ends", async () => {
    // PCM has no decoder priming offset between a range seek to zero and full-file decoding.
    const pcm = path.join(dir, "waveform.wav");
    await runCapture("ffmpeg", ["-v", "error", "-y", "-i", src, "-vn", "-ac", "1", "-ar", "8000", "-c:a", "pcm_s16le", pcm]);
    const pointsPerSecond = 53;
    const cache = await extractWaveformFull(pcm, 10.137, pointsPerSecond);
    const duration = (await probeMedia(pcm)).duration;
    expect(cache.duration).toBeCloseTo(duration, 4);
    const count = Math.ceil(duration * pointsPerSecond);
    // A whole-second window keeps the reference buckets on the cache's 53 Hz clock past the end of the file.
    const reference = await extractWaveform(pcm, { from: 0, to: 11, points: 11 * pointsPerSecond });
    expect(cache.peaks).toEqual(Float32Array.from(reference.peaks.slice(0, count)));
    expect(cache.rms).toEqual(Float32Array.from(reference.rms.slice(0, count)));
    const tail = waveformFromCache(cache, 10.25, 11, 4);
    expect(tail).toEqual({ peaks: [0, 0, 0, 0], rms: [0, 0, 0, 0] });
  });
});

describe("frame", () => {
  it("extracts a JPEG", async () => {
    const jpg = await extractFrame(src, 1, { width: 160 });
    expect(jpg[0]).toBe(0xff);
    expect(jpg[1]).toBe(0xd8);
    expect(jpg.length).toBeGreaterThan(500);
  });

  it("holds the last source picture when a faster timeline samples between source frames", async () => {
    const { project, timeline } = fixture();
    project.settings.fps = 60;
    timeline.tracks = [{ ...timeline.tracks[0]!, clips: [makeMediaClip("m1", 0, 10, 0)] }];
    const sample = (frame: number) => renderTimelineFrame(project, timeline, { start: frame / 60, end: (frame + 1) / 60 }, dir);
    // The 30 fps source ends at frame 299, shown in both final 60 fps thumbnails.
    const lastSourceFrame = await sample(598);
    expect(lastSourceFrame.length).toBeGreaterThan(1000);
    expect(await sample(599)).toEqual(lastSourceFrame);
  });

  it("samples the same animated frame on both sides of a clip split", async () => {
    const { project } = fixture();
    const timeline = timelineFromKeepRanges(project.id, "m1", [{ start: 0, end: 10 }]);
    const clip = timeline.tracks[0]!.clips[0] as MediaClip;
    clip.keyframes = [{ time: 0, transform: { x: 0 }, ease: "easeInOut" }, { time: 10, transform: { x: 0.5 }, ease: "hold" }];
    const split = applyOps(timeline, [{ op: "splitClip", clipId: clip.id, at: 5 }]);
    for (const frame of [149, 150, 162]) {
      const range = { start: frame / 30, end: (frame + 1) / 30 };
      expect(await renderTimelineFrame(project, split, range, dir)).toEqual(await renderTimelineFrame(project, timeline, range, dir));
    }
  });
});

describe("graph helpers", () => {
  it("formats colours, speeds and keyframes", () => {
    expect(ffColor("random@1")).toBe("random@1");
    expect(ffColor("red@ 0.5")).toBe("red@0.5");
    expect(ffColor("LightBlue@0.8", 0.5)).toBe("lightblue@0.4");
    expect(() => ffColor("red@" + "1".repeat(100_000) + "x")).toThrow(/color/i);
    expect(ffColor("red@0x80")).toBe("red@0.502");
    expect(ffColor("#fff")).toBe("0xFFFFFF");
    expect(ffColor("#00000080")).toBe("0x000000@0.502");
    expect(ffColor("#FF8800", 0.5)).toBe("0xFF8800@0.5");
    expect(atempoFactors(1)).toEqual([]);
    expect(atempoFactors(3)).toEqual([2, 1.5]);
    expect(atempoFactors(0.25)).toEqual([0.5, 0.5]);
    expect(keyframeExpr([{ time: 0, value: 0, ease: "linear" }, { time: 2, value: 1, ease: "linear" }], "t"))
      .toBe("if(lt(t,2),(0+1*clip((t)/2,0,1)),1)");
    expect(wrapText("one two three four", 9)).toBe("one two\nthree\nfour");
  });
});

describe("pure helpers", () => {
  it("reads a frame rate written as a fraction or a number, and garbage as none", () => {
    expect(parseRate("30000/1001")).toBeCloseTo(29.97, 2);
    expect(parseRate("25/1")).toBe(25);
    expect(parseRate("30")).toBe(30);
    expect(parseRate("23.976")).toBe(23.976);
    // ffprobe writes 0/0 for a stream with no rate, such as a still.
    for (const none of ["0/0", "30/0", "abc", "abc/1", "30/abc", "", undefined]) expect(parseRate(none)).toBe(0);
  });

  it("snaps a range to whole frames, keeping at least one and never starting before zero", () => {
    expect(snapRange({ start: 0.49, end: 1.51 }, 10)).toEqual({ start: 0.5, end: 1.5 });
    expect(snapRange({ start: 1 / 30 + 0.004, end: 2 / 30 - 0.004 }, 30)).toEqual({ start: 1 / 30, end: 2 / 30 });
    // An empty or backwards range becomes the one frame at its start.
    expect(snapRange({ start: 0.5, end: 0.5 }, 10)).toEqual({ start: 0.5, end: 0.6 });
    expect(snapRange({ start: 0.5, end: 0.2 }, 10)).toEqual({ start: 0.5, end: 0.6 });
    expect(snapRange({ start: 0.52, end: 0.54 }, 10)).toEqual({ start: 0.5, end: 0.6 });
    expect(snapRange({ start: -0.3, end: 0.2 }, 10)).toEqual({ start: 0, end: 0.2 });
    expect(snapRange({ start: -2, end: -1 }, 10)).toEqual({ start: 0, end: 0.1 });
  });

  it("sizes a preview to an even canvas that keeps the shape and never exceeds the project", () => {
    const portrait = createProject("Portrait", { width: 1080, height: 1920 }).settings;
    expect(outputSize(portrait, "preview")).toEqual({ width: 304, height: 540 });
    expect(outputSize(portrait, "preview", 4000)).toEqual({ width: 1080, height: 1920 });
    expect(outputSize(portrait, "delivery", 100)).toEqual({ width: 1080, height: 1920 });
    expect(outputSize(portrait, "delivery", undefined, 4000)).toEqual({ width: 1080, height: 1920 });
    expect(outputSize(portrait, "preview", 1)).toEqual({ width: 2, height: 2 });
    expect(outputSize(portrait, "preview", 101)).toEqual({ width: 58, height: 102 });
  });

  it("gives every encoder a quicker preview and a finer delivery, and an encoder it does not know the libx264 flags", async () => {
    for (const encoder of ["libx264", "h264_nvenc", "h264_qsv", "h264_amf", "h264_videotoolbox"]) {
      const preview = encoderArgs(encoder, "preview"), delivery = encoderArgs(encoder, "delivery");
      expect(preview).not.toEqual(delivery);
      // Options and values in pairs, ready to follow -c:v.
      for (const args of [preview, delivery]) expect(args.filter((_, i) => i % 2 === 0).every(option => option.startsWith("-"))).toBe(true);
    }
    expect(encoderArgs("libx265", "preview")).toEqual(encoderArgs("libx264", "preview"));
    // The flags are ones ffmpeg takes, and delivery spends more bits on the same picture.
    const bytes = async (quality: "preview" | "delivery") => (await runCapture("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=1",
      "-c:v", "libx264", ...encoderArgs("libx264", quality), "-pix_fmt", "yuv420p", "-f", "h264", "-"])).stdout.length;
    expect(await bytes("delivery")).toBeGreaterThan(await bytes("preview"));
  });

  it("escapes a path for a filter option inside a graph", async () => {
    expect(escapeFilterPath("/fonts/Inter.ttf")).toBe("/fonts/Inter.ttf");
    // Once for the option parser and once for the graph parser: a drive colon ends up behind two backslashes.
    expect(escapeFilterPath(String.raw`C:\Fonts\a.ttf`)).toBe(String.raw`C\\:\\\\Fonts\\\\a.ttf`);
    expect(escapeFilterPath("it's")).toBe(String.raw`it\\\'s`);
    expect(escapeFilterPath("a[1],b;c")).toBe(String.raw`a\[1\]\,b\;c`);
    if (process.platform !== "win32") {
      // ffmpeg opens the very file: here a name with a colon and a backslash in it.
      const mediaRoot = await fs.mkdtemp(path.join(dir, "escape-"));
      const name = String.raw`C:\grade.cube`;
      await fs.writeFile(path.join(mediaRoot, name), "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n");
      const [filter] = effectFilters([{ type: "lut", enabled: true, params: { file: name } }], "video", { mediaRoot, warn: () => {} });
      await runCapture("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=red:s=16x16:d=0.1,${filter}`, "-f", "null", "-"]);
    }
  });

  it("builds effect filters in order, skipping disabled ones and the other kind, and warns once about one it does not know", () => {
    const warnings: string[] = [];
    const ctx = { mediaRoot: dir, warn: (message: string) => { warnings.push(message); } };
    const effects = [
      { type: "blur", params: { sigma: 2 }, enabled: true },
      { type: "denoise", params: {}, enabled: true },
      { type: "brightness", params: { value: 9 }, enabled: true },
      { type: "sharpen", params: {}, enabled: false },
      { type: "glow", params: {}, enabled: true },
      { type: "eq", params: { highpass: 80, bands: [{ frequency: 3000, gain: 99 }, { gain: 3 }] }, enabled: true },
      { type: "lut", params: {}, enabled: true },
    ];
    // Values out of range are clamped: brightness to 1, gain to 40 dB.
    expect(effectFilters(effects, "video", ctx)).toEqual(["gblur=sigma=2", "eq=brightness=1"]);
    expect(warnings).toEqual(['unknown effect type "glow" ignored', 'lut effect without a "file" parameter ignored']);
    warnings.length = 0;
    expect(effectFilters(effects, "audio", ctx)).toEqual(["afftdn=nr=12:nf=-25", "highpass=f=80", "equalizer=f=3000:t=q:w=1:g=40"]);
    expect(warnings).toEqual(['unknown effect type "glow" ignored', "eq band without frequency ignored"]);
    expect(effectFilters(undefined, "video", ctx)).toEqual([]);
    // A number given as text counts, and anything else falls back to the default.
    expect(effectFilters([{ type: "blur", params: { sigma: "3" }, enabled: true }, { type: "blur", params: { sigma: "wide" }, enabled: true }], "video", ctx))
      .toEqual(["gblur=sigma=3", "gblur=sigma=5"]);
    expect(effectFilters([{ type: "compressor", params: { thresholdDb: -20, makeupDb: 6 }, enabled: true }, { type: "limiter", params: { limit: 5 }, enabled: true }], "audio", ctx))
      .toEqual(["acompressor=threshold=0.1:ratio=3:attack=20:release=250:makeup=1.995262:knee=2.8", "alimiter=limit=1:attack=5:release=50:level=false"]);
  });

  it("stamps each LUT a cut uses, so a changed file is a different picture", async () => {
    const mediaRoot = await fs.mkdtemp(path.join(dir, "stamps-"));
    const { timeline } = fixture();
    const clips = timeline.tracks[0]!.clips as MediaClip[];
    expect(lutFileStamps(timeline, mediaRoot)).toEqual([]);
    clips[0]!.effects = [{ type: "lut", params: { file: "warm.cube" }, enabled: true }, { type: "lut", params: { file: "off.cube" }, enabled: false }];
    clips[1]!.effects = [{ type: "lut", params: { path: "cool.cube" }, enabled: true }, { type: "lut", params: { file: "warm.cube" }, enabled: true }, { type: "lut", params: {}, enabled: true }];
    // Named once each, in order, and a file that is not there yet is stamped as missing.
    expect(lutFileStamps(timeline, mediaRoot)).toEqual([["cool.cube", null], ["warm.cube", null]]);
    await fs.writeFile(path.join(mediaRoot, "warm.cube"), "LUT_3D_SIZE 2\n");
    const [, warm] = lutFileStamps(timeline, mediaRoot);
    // Windows may return either the short or long spelling of the same temporary directory.
    const stamp = warm?.[1];
    if (!Array.isArray(stamp) || typeof stamp[0] !== "string") throw new Error("Expected an existing LUT file stamp");
    const stampedFile = stamp[0];
    expect(await fs.realpath(stampedFile)).toBe(await fs.realpath(path.join(mediaRoot, "warm.cube")));
    expect(warm).toEqual(["warm.cube", [stampedFile, 14, expect.any(Number), expect.any(Number)]]);
    await fs.appendFile(path.join(mediaRoot, "warm.cube"), "# graded again\n");
    expect(lutFileStamps(timeline, mediaRoot)[1]).not.toEqual(warm);
    // A disabled clip's LUT is not read at all.
    clips[1]!.enabled = false;
    expect(lutFileStamps(timeline, mediaRoot).map(([name]) => name)).toEqual(["warm.cube"]);
  });
});

describe("render", () => {
  it("re-renders only the sections that use a LUT when its file changes, though the cut list did not", async () => {
    const mediaRoot = await fs.mkdtemp(path.join(dir, "lut-cache-"));
    await fs.copyFile(src, path.join(mediaRoot, "src.mp4"));
    const cube = (red: number) => `LUT_3D_SIZE 2\n0 0 0\n${red} 0 0\n0 1 0\n${red} 1 0\n0 0 1\n${red} 0 1\n0 1 1\n${red} 1 1\n`;
    await fs.writeFile(path.join(mediaRoot, "look.cube"), cube(1));
    const { project, timeline } = fixture();
    project.media[0]!.hash = await hashFile(src);
    timeline.tracks = [{ ...timeline.tracks[0]!, clips: [makeMediaClip("m1", 0, 2, 0), makeMediaClip("m1", 5, 8, 2, { effects: [{ type: "lut", params: { file: "look.cube" }, enabled: true }] })] }];
    const render = () => renderFullCached(project, timeline, path.join(mediaRoot, "cache"), path.join(mediaRoot, "out.mp4"), { mediaRoot, height: 90, segmentSeconds: 2 });
    const first = await render();
    expect(first.segments.map(segment => segment.range)).toEqual([{ start: 0, end: 2 }, { start: 2, end: 5 }]);
    expect([first.rendered, first.reused]).toEqual([2, 0]);
    expect([(await render()).rendered, (await render()).reused]).toEqual([0, 2]);
    await fs.writeFile(path.join(mediaRoot, "look.cube"), cube(0.5) + "# graded again\n");
    const regraded = await render();
    expect([regraded.rendered, regraded.reused]).toEqual([1, 1]);
    expect(regraded.segments.map(segment => segment.key === first.segments.find(s => s.range.start === segment.range.start)!.key)).toEqual([true, false]);
  });

  it("rejects graph syntax in raw timelines and cleans up failed graph builds", async () => {
    const tempDir = await fs.mkdtemp(path.join(dir, "invalid-"));
    const { project, timeline } = fixture();
    const options = { mediaRoot: dir, tempDir };
    const range = { start: 1, end: 2 };
    await expect(buildFilterGraph(project, { ...timeline, background: "red,negate" }, range, options)).rejects.toThrow(/color/i);
    const caption = { ...timeline, captionStyle: { backgroundColor: "black@1;null" } };
    await expect(buildFilterGraph(project, caption, range, options)).rejects.toThrow(/color/i);
    const clip = timeline.tracks[1]!.clips[0]!;
    if (clip.kind !== "color") throw new Error("fixture color missing");
    clip.color = "red@1,negate";
    await expect(buildFilterGraph(project, timeline, range, options)).rejects.toThrow(/color/i);
    expect(await fs.readdir(tempDir)).toEqual([]);
  });

  it("renders a project LUT with a quoted filename and rejects untrusted LUT options", async () => {
    const mediaRoot = await fs.mkdtemp(path.join(dir, "lut-"));
    const name = "Editor's [1];,look.cube";
    const lut = path.join(mediaRoot, name);
    await fs.writeFile(lut, "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n");
    const filter = (params: Record<string, unknown>) => effectFilters([{ type: "lut", enabled: true, params }], "video", { mediaRoot, warn: () => {} })[0];
    for (const params of [{ file: name }, { path: lut, interp: "trilinear" }]) {
      const { stdout } = await runCapture("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=red:s=16x16:d=0.1,${filter(params)}`, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]);
      expect(stdout[0]).toBeGreaterThan(245);
      expect(stdout[1]).toBeLessThan(5);
    }
    expect(() => filter({ path: lut, interp: "nearest,negate" })).toThrow(/interpolation/);
    const realpath = vi.spyOn(syncFs, "realpathSync");
    try {
      expect(() => filter({ file: src })).toThrow(/project media/);
      expect(realpath).not.toHaveBeenCalled();
    } finally {
      realpath.mockRestore();
    }
    if (process.platform !== "win32") {
      await fs.symlink(src, path.join(mediaRoot, "external.cube"));
      expect(() => filter({ file: "external.cube" })).toThrow(/project media/);
      const literal = String.raw`..\alternate.cube`;
      await fs.copyFile(lut, path.join(mediaRoot, literal));
      await runCapture("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=red:s=16x16:d=0.1,${filter({ file: literal })}`, "-f", "null", "-"]);
    }
  });

  it("only resolves timeline font paths within configured font directories", async () => {
    const fontDir = await fs.mkdtemp(path.join(dir, "fonts-"));
    const inside = path.join(fontDir, "custom.ttf");
    const outside = path.join(dir, "outside.ttf");
    await fs.writeFile(inside, "");
    await fs.writeFile(outside, "");
    if (process.platform !== "win32") {
      await fs.symlink(outside, path.join(fontDir, "linked.ttf"));
      expect(resolveFontFile("linked", { fontDirs: [fontDir] })?.exact).not.toBe(true);
    }
    const resolved = resolveFontFile(inside, { fontDirs: [fontDir] });
    expect(resolved?.exact).toBe(true);
    expect(await fs.realpath(resolved!.file)).toBe(await fs.realpath(inside));
    const fallback = resolveFontFile(outside, { fontDirs: [fontDir] });
    expect(fallback?.exact).not.toBe(true);
    if (fallback) expect(await fs.realpath(fallback.file)).not.toBe(await fs.realpath(outside));
    expect(resolveFontFile("Inter", { fontFile: outside })).toEqual({ file: outside, exact: true });
  });

  it("uses the probed playback codec for hardware decoding older imports", async () => {
    const { project, timeline } = fixture();
    const asset = project.media[0]!;
    for (const [codec, accelerated] of [["avc1", true], ["hvc1", true], ["av01", false]] as const) {
      asset.originalPlaybackType = `video/mp4; codecs="${codec},mp4a.40.2"`;
      const graph = await buildFilterGraph(project, timeline, { start: .5, end: 1.5 }, { mediaRoot: dir, decoder: "videotoolbox" });
      try {
        expect(graph.args.includes("-hwaccel")).toBe(accelerated);
        expect(graph.inputs).toHaveLength(1);
      } finally { await graph.cleanup(); }
      const threaded = await buildFilterGraph(project, timeline, { start: .5, end: 1.5 }, { mediaRoot: dir, decoder: "videotoolbox-hevc" });
      try { expect(threaded.args.includes("-hwaccel")).toBe(codec === "hvc1"); }
      finally { await threaded.cleanup(); }
    }
  });

  it("downscales plain opaque preview layers on the GPU and keeps effects on the original pixels", async () => {
    const { project, timeline } = fixture();
    Object.assign(project.media[0]!, { hasAlpha: false, originalPlaybackType: 'video/mp4; codecs="avc1,mp4a.40.2"' });
    for (const [start, accelerated] of [[0, true], [3, false]] as const) {
      const graph = await buildFilterGraph(project, timeline, { start, end: start + 1 },
        { mediaRoot: dir, width: 160, height: 90, decoder: "cuda" });
      try {
        expect(graph.graph.includes("scale_cuda=")).toBe(accelerated);
        expect(graph.args.includes("-hwaccel_output_format")).toBe(accelerated);
        expect(graph.hasAudio).toBe(true);
      } finally { await graph.cleanup(); }
    }
  });

  it("keeps a clip stored sideways off the GPU downscale, which would not turn it", async () => {
    const { project, timeline } = fixture();
    // A phone's portrait video: the same landscape stream, with a note to show it turned.
    await runCapture("ffmpeg", ["-v", "error", "-display_rotation", "90", "-i", src, "-c", "copy", path.join(dir, "sideways.mp4")]);
    Object.assign(project.media[0]!, { path: "sideways.mp4", width: 180, height: 320, hasAlpha: false, originalPlaybackType: 'video/mp4; codecs="avc1,mp4a.40.2"' });
    // The portrait canvas matches the turned picture, so everything but the rotation asks for the GPU.
    const graph = await buildFilterGraph(project, timeline, { start: 0, end: 1 }, { mediaRoot: dir, width: 90, height: 160, decoder: "cuda" });
    try {
      expect(graph.graph.includes("scale_cuda=")).toBe(false);
      expect(graph.args.includes("-hwaccel_output_format")).toBe(false);
    } finally { await graph.cleanup(); }
  });

  it("skips the pictures of layers an opaque full-frame clip hides, keeping their sound", async () => {
    await fs.copyFile(src, path.join(dir, "copy.mp4"));
    const project = createProject("Cover", { width: 320, height: 180, fps: 30, aspect: "custom" });
    project.media.push(
      { id: "a", kind: "video", name: "src.mp4", path: "src.mp4", duration: 10, fps: 30, width: 320, height: 180, hasAudio: true, hasAlpha: false },
      { id: "b", kind: "video", name: "copy.mp4", path: "copy.mp4", duration: 10, fps: 30, width: 320, height: 180, hasAudio: true, hasAlpha: false },
    );
    const cut = (top: Partial<MediaClip> = {}, start = 0): Timeline => ({
      version: "draft", parent: null, projectId: project.id, name: "Main", background: "#000000", markers: [],
      tracks: [
        { id: "v1", kind: "video", name: "V1", muted: false, hidden: false, clips: [makeMediaClip("a", 0, 4, 0, { id: "under" })] },
        { id: "v2", kind: "video", name: "V2", muted: false, hidden: false, clips: [makeMediaClip("b", 2, 6 - start, start, { id: "over", ...top })] },
      ],
    });
    const layers = async (timeline: Timeline, range = { start: 0, end: 2 }) => {
      const graph = await buildFilterGraph(project, timeline, range, { mediaRoot: dir, width: 160, height: 90 });
      try {
        return { pictures: graph.graph.match(/overlay=/g)?.length ?? 0, sounds: graph.graph.match(/\[\d+:a\]/g)?.length ?? 0 };
      } finally { await graph.cleanup(); }
    };
    expect(await layers(cut())).toEqual({ pictures: 1, sounds: 2 });
    expect(await layers(cut({ transform: { x: 0, y: 0, scale: 1.2, rotation: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 } }))).toEqual({ pictures: 1, sounds: 2 });
    // A finished fade-in no longer reveals the layer below.
    expect(await layers(cut({ videoFadeIn: 0.5 }), { start: 1, end: 2 })).toEqual({ pictures: 1, sounds: 2 });
    for (const visible of [
      cut({ opacity: 0.9 }),
      cut({ videoFadeIn: 0.5 }),
      cut({ videoFadeOut: 3.5 }),
      cut({ transform: { x: 0, y: 0, scale: 0.9, rotation: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 } }),
      cut({ transform: { x: 0, y: 0, scale: 1, rotation: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0, cornerRadius: 0.1 } }),
      cut({ transform: { x: 0.1, y: 0, scale: 1, rotation: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 } }),
      cut({ effects: [{ type: "saturation", params: { value: 1.3 }, enabled: true }] }),
      cut({ keyframes: [{ time: 0, transform: { scale: 1 }, ease: "linear" }, { time: 1, transform: { scale: 1.1 }, ease: "linear" }] }),
      cut({}, 0.5),
    ]) {
      expect(await layers(visible)).toEqual({ pictures: 2, sounds: 2 });
    }
    // An asset not known to be opaque, or a source shorter than the clip, keeps both layers.
    project.media[1]!.hasAlpha = undefined;
    expect(await layers(cut())).toEqual({ pictures: 2, sounds: 2 });
    project.media[1]!.hasAlpha = false;
    project.media[1]!.duration = 3;
    expect(await layers(cut())).toEqual({ pictures: 2, sounds: 2 });
    project.media[1]!.duration = 10;

    const out = path.join(dir, "covered.mp4");
    await renderRange(project, cut(), { start: 0, end: 2 }, out, { mediaRoot: dir, quality: "preview", height: 90 });
    expect(await probeOut(out)).toMatchObject({ width: 160, height: 90, hasAudio: true });
  });

  it("reveals the underlying picture when the upper video stream ends before its audio", async () => {
    const source = path.join(dir, "trailing-audio.mp4");
    await runCapture("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:s=64x64:r=30:d=1",
      "-f", "lavfi", "-i", "anullsrc=r=48000:d=2", "-c:v", "libx264", "-c:a", "aac", source]);
    const project = createProject("Layers", { width: 64, height: 64 });
    project.media.push({ id: "top", kind: "video", name: "top", path: source, duration: 2,
      width: 64, height: 64, fps: 30, hasAudio: true, hasAlpha: false });
    const timeline = timelineFromKeepRanges(project.id, "top", [{ start: 0, end: 2 }]);
    timeline.tracks.unshift({ id: "under", name: "Under", kind: "video", hidden: false, muted: false,
      clips: [{ kind: "color", id: "card", enabled: true, color: "blue", opacity: 1, timelineIn: 0, timelineOut: 2 }] });
    const output = path.join(dir, "trailing-audio-delivery.mp4");
    await renderFullCached(project, timeline, path.join(dir, "trailing-audio-cache"), output, { mediaRoot: dir, quality: "delivery" });
    const pixel = async (time: number) => (await runCapture("ffmpeg", ["-v", "error", "-ss", String(time), "-i", output,
      "-an", "-frames:v", "1", "-vf", "scale=1:1,format=rgb24", "-f", "rawvideo", "-"])).stdout;
    expect((await pixel(0.5))[0]).toBeGreaterThan(240);
    expect((await pixel(1.5))[2]).toBeGreaterThan(240);
  });

  it("shows a delayed camera only during its picture stream and preserves the earlier sound", async () => {
    const source = path.join(dir, "delayed-camera.mp4");
    await runCapture("ffmpeg", ["-v", "error", "-itsoffset", "0.5", "-f", "lavfi", "-i", "color=red:s=64x64:r=30:d=1",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:d=1.5", "-fps_mode:v", "passthrough", "-c:v", "libx264", "-c:a", "aac", source]);
    const project = createProject("Camera offset", { width: 64, height: 64 });
    project.media.push({ id: "top", kind: "video", name: "top", path: source, duration: 1.5,
      width: 64, height: 64, fps: 30, hasAudio: true, hasAlpha: false });
    const timeline = timelineFromKeepRanges(project.id, "top", [{ start: 0, end: 1.5 }]);
    timeline.tracks.unshift({ id: "under", name: "Under", kind: "video", hidden: false, muted: false,
      clips: [{ kind: "color", id: "card", enabled: true, color: "blue", opacity: 1, timelineIn: 0, timelineOut: 1.5 }] });
    for (const start of [0, 0.2]) {
      const output = path.join(dir, `delayed-camera-${start}.mp4`);
      await renderRange(project, timeline, { start, end: 1.5 }, output, { mediaRoot: dir, quality: "preview" });
      const decode = ["-v", "error", "-i", output];
      const { stdout } = await runCapture("ffmpeg", [...decode, "-an", "-vf", "scale=1:1,format=rgb24", "-f", "rawvideo", "-"]);
      const pixel = (t: number, channel: number) => stdout[Math.round((t - start) * 30) * 3 + channel];
      expect(pixel(start + 0.1, 2)).toBeGreaterThan(240);
      expect(pixel(0.6, 0)).toBeGreaterThan(240);
      expect(pixel(1.25, 0)).toBeGreaterThan(240);
      const sound = await runCapture("ffmpeg", [...decode, "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "-"]);
      const firstTone = new Int16Array(sound.stdout.buffer, sound.stdout.byteOffset, sound.stdout.length / 2)
        .findIndex(sample => Math.abs(sample) > 1000);
      expect(firstTone).toBeGreaterThanOrEqual(0);
      expect(firstTone / 48000).toBeLessThan(0.02);
    }
  });

  it("encodes adjacent preview sections from one decode exactly as if each were rendered alone", async () => {
    const { project, timeline } = fixture();
    const cacheDir = path.join(dir, "run-cache");
    const before = spawnStats.ffmpeg;
    const run = await renderFullCached(project, timeline, cacheDir, path.join(dir, "run.mp4"), { mediaRoot: dir, height: 180, segmentSeconds: 1 });
    expect(run.segments.length).toBeGreaterThan(2);
    expect(run.rendered).toBe(run.segments.length);
    // One encode for every section, plus the concat.
    expect(spawnStats.ffmpeg - before).toBe(2);
    const frames = async (file: string) => Number((await runCapture("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0",
      "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file])).stdout.toString().trim());
    const samples = async (file: string) =>
      (await runCapture("ffmpeg", ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "-"])).stdout.length / 2;
    for (const [k, segment] of run.segments.entries()) {
      const alone = path.join(dir, `alone-${k}.mp4`);
      await renderRange(project, timeline, segment.range, alone, { mediaRoot: dir, quality: "preview", height: 180 });
      expect(await frames(segment.file)).toBe(await frames(alone));
      // Same pictures in the same order. Only an animated position exactly on a pixel
      // boundary may round differently, because the shared clock reads t a few ulps off.
      const { stdout } = await runCapture("ffmpeg", ["-v", "error", "-i", segment.file, "-i", alone, "-lavfi", "[0:v][1:v]psnr=stats_file=-", "-f", "null", "-"]);
      const psnr = stdout.toString().split("\n").filter(Boolean).map(line => Number(/psnr_avg:(\S+)/.exec(line)![1]!.replace("inf", "Infinity")));
      expect(Math.min(...psnr)).toBeGreaterThan(35);
      const [a, b] = await Promise.all([samples(segment.file), samples(alone)]);
      expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
    }
  });

  it("builds a graph ffmpeg accepts and renders a 1 s preview", async () => {
    const { project, timeline } = fixture();
    const graph = await buildFilterGraph(project, timeline, { start: 0.5, end: 1.5 }, { mediaRoot: dir });
    try {
      expect(graph.inputs.length).toBe(1); // only c1 is visible in 0.5..1.5 (colour + caption are sources)
      // ffmpeg 7+ reads the graph file with -/filter_complex; older builds (Ubuntu's 6.x) need the script flag.
      expect(graph.args.some((a) => a === "-/filter_complex" || a === "-filter_complex_script")).toBe(true);
      expect(graph.graph).toContain("drawtext=");
      expect(graph.graph).toContain("overlay=");
      expect(graph.graph).toContain("fade=t=in");
      expect(graph.hasAudio).toBe(true);
    } finally {
      await graph.cleanup();
    }

    const out = path.join(dir, "range.mp4");
    const progress: number[] = [];
    const r = await renderRange(project, timeline, { start: 0.5, end: 1.5 }, out, {
      mediaRoot: dir,
      quality: "preview",
      height: 180,
      onProgress: (p) => progress.push(p),
    });
    expect(r.encoder).toBe("libx264");
    expect(progress.at(-1)).toBe(1);
    const p = await probeOut(out);
    expect(Math.abs(p.duration - 1)).toBeLessThan(0.06);
    expect(p.width).toBe(320);
    expect(p.height).toBe(180);
    expect(p.fps).toBe(30);
    expect(p.hasAudio).toBe(true);
    expect(await longestKeyframeGap(out, 1)).toBeLessThanOrEqual(0.5 + 1 / 30);
  });

  it("renders a range with the keyframed graphic, speed change and unknown effect", async () => {
    const { project, timeline } = fixture();
    const out = path.join(dir, "range2.mp4");
    const r = await renderRange(project, timeline, { start: 2.5, end: 4 }, out, { mediaRoot: dir, height: 90 });
    expect(r.warnings.some((w) => w.includes('unknown effect type "nope"'))).toBe(true);
    const p = await probeOut(out);
    expect(Math.abs(p.duration - 1.5)).toBeLessThan(0.06);
    expect(p.width).toBe(160);
    expect(p.height).toBe(90);
  });

  describe("frame edges", () => {
    const common = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];
    const size = 64 * 64 * 3;
    const stills = createProject("Edges", { width: 64, height: 64, fps: 30, aspect: "custom" });
    const track = (clips: Timeline["tracks"][number]["clips"], kind: "video" | "caption" = "video") =>
      ({ id: kind, kind, name: kind, muted: false, hidden: false, clips });
    const edit = (...tracks: Timeline["tracks"]): Timeline =>
      ({ version: "draft", parent: null, projectId: stills.id, name: "Main", background: "#000000", markers: [], tracks });
    /** Every frame of the range as raw RGB, composited as a render composites it. */
    async function pictures(project: Project, timeline: Timeline, range: { start: number; end: number }, inputLoops?: boolean) {
      const graph = await buildFilterGraph(project, timeline, range, { mediaRoot: dir, pictureOnly: true });
      try {
        if (inputLoops !== undefined) expect(graph.args.includes("-loop")).toBe(inputLoops);
        const { stdout } = await runCapture("ffmpeg", ["-v", "error", ...graph.args, "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]);
        expect(stdout.length).toBe(Math.round((range.end - range.start) * project.settings.fps) * size);
        return Array.from({ length: stdout.length / size }, (_, frame) => stdout.subarray(frame * size, (frame + 1) * size));
      } finally { await graph.cleanup(); }
    }
    /** One letter a frame: r or b for a red or blue centre, a dot for the black background. */
    const centres = (frames: Buffer[]) => frames.map(frame => {
      const [r, , b] = frame.subarray((32 * 64 + 32) * 3);
      return r! > 200 && b! < 60 ? "r" : b! > 200 && r! < 60 ? "b" : r! < 30 && b! < 30 ? "." : "?";
    }).join("");

    beforeAll(async () => {
      for (const colour of ["red", "blue"]) {
        await runCapture("ffmpeg", [...common, "-f", "lavfi", "-i", `color=c=${colour}:s=64x64:r=30:d=4`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path.join(dir, `${colour}.mp4`)]);
      }
      // The GIF turns blue after its first picture, and a still shows only the first.
      await runCapture("ffmpeg", [...common, "-f", "lavfi", "-i", "color=c=red:s=64x64:r=10:d=0.1", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=10:d=0.9",
        "-filter_complex", "[0][1]concat=n=2", path.join(dir, "blink.gif")]);
      await runCapture("ffmpeg", [...common, "-i", path.join(dir, "red.mp4"), "-frames:v", "1", "-c", "copy", path.join(dir, "one.mp4")]);
      await runCapture("ffmpeg", [...common, "-f", "lavfi", "-i", "color=c=red:s=64x64:d=0.1,format=rgb24", "-frames:v", "1", "-update", "1", path.join(dir, "red.png")]);
    });

    it("shows no background between two clips, whichever frame the cut is on", async () => {
      const movie = (id: string) => ({ id, kind: "video" as const, name: id, path: `${id}.mp4`, duration: 4, fps: 30, width: 64, height: 64, hasAudio: false, hasAlpha: false });
      stills.media = [movie("red"), movie("blue")];
      // 20/30 and 41/30 s are written a hair late at six decimals (0.666667), 61/30 and 82/30 a hair early (2.033333).
      const cuts = [0, 20, 41, 61, 82, 90];
      const clips = cuts.slice(0, -1).map((cut, i) => makeMediaClip(i % 2 ? "blue" : "red", 1, 1 + (cuts[i + 1]! - cut) / 30, cut / 30));
      expect(centres(await pictures(stills, edit(track(clips)), { start: 0, end: 3 })))
        .toBe("r".repeat(20) + "b".repeat(21) + "r".repeat(20) + "b".repeat(21) + "r".repeat(8));
    });

    it("rounds the cropped inset and preserves source transparency and clip opacity", async () => {
      stills.media = [{ id: "camera", kind: "graphic", name: "camera", path: "logo.png", hasAlpha: true }];
      // Crop the 64 × 64 half-transparent red source to 32 × 48, then fit it in the bottom right.
      const inset = makeMediaClip("camera", 0, 1, 0, { opacity: 0.8, transform: {
        x: 0.25, y: 0.125, scale: 0.75, rotation: 0, cropLeft: 0.25, cropRight: 0.25, cropTop: 0.25, cropBottom: 0, cornerRadius: 0.25,
      } });
      const timeline = edit(track([inset]));
      timeline.background = "#00FF00";
      const [frame] = await pictures(stills, timeline, { start: 0, end: 1 / 30 });
      const pixel = (x: number, y: number) => frame!.subarray((y * 64 + x) * 3, (y * 64 + x) * 3 + 3);
      for (const [x, y] of [[32, 16], [63, 16], [32, 63], [63, 63]] as const) {
        expect(pixel(x, y)[1]).toBeGreaterThan(240);
      }
      // Inside the frame the 50% source alpha and 80% clip opacity give 40% red.
      expect(pixel(48, 40)[0]).toBeCloseTo(102, -1);
      expect(pixel(48, 40)[1]).toBeCloseTo(153, -1);
      // Two pixels in from either edge falls partly inside the eight-pixel arc.
      const luma = (rgb: Buffer) => rgb[0]! * 0.299 + rgb[1]! * 0.587 + rgb[2]! * 0.114;
      expect(luma(pixel(34, 18))).toBeGreaterThan(luma(pixel(48, 40)) + 4);
      expect(luma(pixel(34, 18))).toBeLessThan(luma(pixel(32, 16)) - 4);
    });

    it("holds a still for exactly its clip: a PNG, a GIF's first picture, a one-picture movie and a colour", async () => {
      for (const [name, inputLoops] of [["red.png", true], ["blink.gif", false], ["one.mp4", false]] as const) {
        // Import calls each of them a still. A GIF's palette can hold transparency, which makes it a graphic.
        const kind = detectMediaKind(await probeMedia(path.join(dir, name)));
        expect(kind).toBe(name === "blink.gif" ? "graphic" : "image");
        stills.media = [{ id: "still", kind, name, path: name, hasAlpha: kind === "graphic" }];
        // Twenty frames from frame 1 (written a hair early, 0.033333) and from frame 2 (a hair late, 0.066667).
        for (const first of [1, 2]) {
          const timeline = edit(track([makeMediaClip("still", 0, 20 / 30, first / 30)]));
          expect([name, first, centres(await pictures(stills, timeline, { start: 0, end: 1 }, inputLoops))])
            .toEqual([name, first, ".".repeat(first) + "r".repeat(20) + ".".repeat(10 - first)]);
          // The same clip from its sixth frame on.
          expect([name, first, centres(await pictures(stills, timeline, { start: (first + 5) / 30, end: 0.9 }, inputLoops))])
            .toEqual([name, first, "r".repeat(15) + ".".repeat(7 - first)]);
        }
      }
      for (const first of [1, 2]) {
        const colour = { id: "colour", kind: "color" as const, timelineIn: first / 30, timelineOut: (first + 20) / 30, color: "#FF0000", opacity: 1, enabled: true };
        expect([first, centres(await pictures(stills, edit(track([colour])), { start: 0, end: 1 }))])
          .toEqual([first, ".".repeat(first) + "r".repeat(20) + ".".repeat(10 - first)]);
      }
    });

    it("draws a caption on its own frames only, so two in a row never share one", async () => {
      const caption = (id: string, from: number, to: number, y: number) =>
        ({ id, kind: "caption" as const, timelineIn: from / 30, timelineOut: to / 30, text: "MMMM", enabled: true, style: { y, fontSize: 0.3, color: "#FFFFFF" } });
      // The upper caption is on frames 5 to 14 and the lower on 15 to 19: 5/30 and 20/30 s are written a hair late.
      const frames = await pictures(stills, edit(track([caption("upper", 5, 15, 0.25), caption("lower", 15, 20, 0.75)], "caption")), { start: 0, end: 1 });
      const lit = (frame: Buffer, half: 0 | 1) => frame.subarray(half * size / 2, (half + 1) * size / 2).some(value => value > 128);
      expect(frames.map(frame => (lit(frame, 0) ? "u" : "") + (lit(frame, 1) ? "l" : "") || ".").join(""))
        .toBe(".".repeat(5) + "u".repeat(10) + "l".repeat(5) + ".".repeat(10));
    });

    it("renders a cut on whole frames, of footage at the project's rate, from the graph and under the keys it had", async () => {
      const movie = (id: string, hash?: string) => ({ id, kind: "video" as const, name: id, path: `${id}.mp4`, hash, duration: 4, fps: 30, width: 64, height: 64, hasAudio: true, hasAlpha: false });
      stills.media = [movie("red", "red-fixture"), movie("blue"), { id: "still", kind: "image", name: "red.png", path: "red.png", hasAlpha: false }];
      // 20/30 and 41/30 s are written a hair late at six decimals, 61/30 and 82/30 a hair early.
      const cuts = [0, 20, 41, 61, 82, 120];
      const main = cuts.slice(0, -1).map((cut, i) => makeMediaClip(i % 2 ? "blue" : "red", 1, 1 + (cuts[i + 1]! - cut) / 30, cut / 30));
      const upper = [
        { id: "colour", kind: "color" as const, timelineIn: 5 / 30, timelineOut: 15 / 30, color: "#00FF00", opacity: 0.5, enabled: true },
        makeMediaClip("still", 0, 10 / 30, 25 / 30),
        // B-roll that fades out before a gap.
        makeMediaClip("red", 2, 2 + 10 / 30, 95 / 30, { videoFadeOut: 0.1, volume: 0.5 }),
      ];
      const words = { id: "words", kind: "caption" as const, timelineIn: 10 / 30, timelineOut: 70 / 30, text: "MMMM", enabled: true };
      const timeline = edit(track(main), track(upper), track([words], "caption"));
      const sections = planSegments(stills, timeline, 1);
      expect(sections.map(range => [Math.round(range.start * 30), Math.round(range.end * 30)])).toEqual([[0, 25], [25, 41], [41, 70], [70, 95], [95, 120]]);
      const preview = { quality: "preview" as const, height: 64, encoder: "libx264" };
      const keys = (format: Parameters<typeof segmentKey>[3]) => sections.map(range => segmentKey(stills, timeline, range, format));
      /** What a graph reads and how it composites it, without the folders this machine keeps things in. */
      const built = async (range: { start: number; end: number }, pictureOnly: boolean) => {
        const graph = await buildFilterGraph(stills, { ...timeline, tracks: timeline.tracks.slice(0, 2) }, range, { mediaRoot: dir, pictureOnly });
        try {
          const reads = graph.args.slice(0, graph.args.indexOf("-map"))
            .filter((arg, i, all) => /^-(ss|t|loop|framerate|i)$/.test(arg) || /^-(ss|t|loop|framerate|i)$/.test(all[i - 1] ?? "")).map(arg => path.basename(arg)).join(" ");
          return { reads, graph: graph.graph };
        } finally { await graph.cleanup(); }
      };
      const fit = "scale=w='max(2,trunc(iw*min(64/iw,64/ih)*1/2)*2)':h='max(2,trunc(ih*min(64/iw,64/ih)*1/2)*2)':flags=bicubic,format=yuva420p";
      const over = "overlay=x='(W-w)/2':y='(H-h)/2':eof_action=pass";
      const sound = (seconds: string) => `aresample=first_pts=0,atrim=start=0:duration=${seconds},asetpts=PTS-STARTPTS`;
      const stereo = "aformat=sample_rates=48000:channel_layouts=stereo";
      // Every value below is what the renderer made of this cut before a clip's sliver was placed or a layer's frames were filled.
      const unchanged = async () => {
        expect(keys(preview)).toEqual([
          "1a0f1984583dcc0501cf73bdc65b53af60c78123e3a7652233a24dc9c2a6c009",
          "a7a1d26c11ae48ee6a65b83eee8b11824b61410ab11e57664fa24fa444a13228",
          "961ae46d1bd87e5e699524bcfb105d5ca6c1ef8d3333bf7bacdfa7257a97ee9f",
          "eb76a82ff401c7e405b84ebaf59cb45dd12eace567a11464ffc2183844d5e73d",
          "090274254ed0a0288462118528f57e04cf6c2f23a5bc7d9e4a31110b82e2bc16",
        ]);
        expect(keys({ ...preview, quality: "delivery", pictureOnly: true })).toEqual([
          "98a06e811bedd04e52ceceb78290e7f8b002aa19ce06e37dd86bdb949e1d1cb4",
          "363e4b3723057e0c4aa320d517a6eb383d1f0885cfc284f732c5e04e00fec50c",
          "12caeafc9eadb02aab7486f84551b0f0fe20c161ddc51013e2999870ecb337f3",
          "7455d1ddd218675c5c738a4a11dfae7107bf8e1c627f0f96a704cd8a5446281c",
          "697b6852a16b5e90869209a90e59c98ccdc96ad297c7ab62af43ab48fc2c7c99",
        ]);
        expect(await built({ start: 0, end: 4 }, false)).toEqual({
          reads: "-ss 1 -t 0.666667 -i red.mp4 -ss 1 -t 0.7 -i blue.mp4 -ss 1 -t 1.266667 -i red.mp4 -loop 1 -framerate 30 -t 0.333333 -i red.png -ss 2 -t 0.333333 -i red.mp4",
          graph: [
            "color=c=0x000000:s=64x64:r=30:d=4[base]",
            `[0:v]trim=duration=0.666667,setpts=(PTS-STARTPTS),${fit}[v0]`,
            `[base][v0]${over}:enable='between(t,-0.001,0.666667)'[s1]`,
            `[0:a]${sound("0.666667")},${stereo}[a2]`,
            `[1:v]trim=duration=0.7,setpts=(PTS-STARTPTS),${fit},setpts=PTS+0.666667/TB[v3]`,
            `[s1][v3]${over}:enable='between(t,0.665667,1.366667)'[s4]`,
            `[1:a]${sound("0.7")},${stereo},adelay=32000S:all=1[a5]`,
            `[0:v]trim=duration=0.666667,setpts=(PTS-STARTPTS),${fit},setpts=PTS+1.366667/TB[v6]`,
            `[s4][v6]${over}:enable='between(t,1.365667,2.033333)'[s7]`,
            `[0:a]${sound("0.666667")},${stereo},adelay=65600S:all=1[a8]`,
            `[1:v]trim=duration=0.7,setpts=(PTS-STARTPTS),${fit},setpts=PTS+2.033333/TB[v9]`,
            `[s7][v9]${over}:enable='between(t,2.032333,2.733333)'[s10]`,
            `[1:a]${sound("0.7")},${stereo},adelay=97600S:all=1[a11]`,
            `[2:v]trim=duration=1.266667,setpts=(PTS-STARTPTS),${fit},setpts=PTS+2.733333/TB[v12]`,
            `[s10][v12]${over}:enable='between(t,2.732333,4)'[s13]`,
            `[2:a]${sound("1.266667")},${stereo},adelay=131200S:all=1[a14]`,
            `color=c=0x00FF00@0.5:s=64x64:r=30:d=0.333333,format=yuva420p,${fit},setpts=PTS+round(0.166667/TB)[c15]`,
            `[s13][c15]${over}:enable='between(t,0.165667,0.5)'[s16]`,
            `[3:v]trim=duration=0.333333,setpts=(PTS-STARTPTS),${fit},setpts=PTS+round(0.833333/TB)[v17]`,
            `[s16][v17]${over}:enable='between(t,0.832333,1.166667)'[s18]`,
            `[4:v]trim=duration=0.333333,setpts=(PTS-STARTPTS),${fit},fade=t=out:st=0.233333:d=0.1:alpha=1,setpts=PTS+3.166667/TB[v19]`,
            `[s18][v19]${over}:enable='between(t,3.165667,3.5)'[s20]`,
            `[4:a]${sound("0.333333")},volume=0.5,${stereo},adelay=152000S:all=1[a21]`,
            "[s20]trim=duration=4,setpts=PTS-STARTPTS,format=yuv420p[vout]",
            "[a2][a5][a8][a11][a14][a21]amix=inputs=6:normalize=0:duration=longest:dropout_transition=0,apad=whole_dur=4,atrim=duration=4,asetpts=PTS-STARTPTS[aout]",
          ].join(";\n") + "\n",
        });
        // Each section's own graph, which starts inside a clip as often as on a cut: what it reads, and its text by its hash.
        const parts = await Promise.all(sections.map(range => built(range, true)));
        expect(parts.map(part => part.reads)).toEqual([
          "-ss 1 -t 0.666667 -i red.mp4 -ss 1 -t 0.166667 -i blue.mp4",
          "-ss 1.166667 -t 0.533333 -i blue.mp4 -loop 1 -framerate 30 -t 0.333333 -i red.png",
          "-ss 1 -t 0.666667 -i red.mp4 -ss 1 -t 0.3 -i blue.mp4",
          "-ss 1.3 -t 0.4 -i blue.mp4 -ss 1 -t 0.433333 -i red.mp4",
          "-ss 1.433333 -t 0.833333 -i red.mp4 -ss 2 -t 0.333333 -i red.mp4",
        ]);
        expect(parts.map(part => createHash("sha256").update(part.graph).digest("hex"))).toEqual([
          "0b94856d087400bf6d21b90262fbdab08022f6832a51d80b59dc923ca63d9cb1",
          "510df81b7f8742b83ad0fb3280b831075ab83d918d2a9170ba7f8e0176fa47fb",
          "c2d256ea011e4dc18a85f73bafedecdcc6ba7729312210ce6261f6dc460115c8",
          "b44a0faf80122faa6adfcb822c0fcac29dec65e0e4d1e946da072b2c44f9613b",
          "712a2c404e74223e07c1af309159916382d5ee9cd1cf9ac2dcaa15a26e3ec6eb",
        ]);
      };
      await unchanged();
      // With preview copies allowed the key also holds each file's rate, so it has values of its own.
      expect(keys({ ...preview, allowProxy: true })).toEqual([
        "823b1fa5e099cbc28bdfb93cdad4917793cd2fc692f08e5a9cc18458703ab426",
        "f6b10885467a4c8d5fadc34d0ad4cd53b9c0f7b9df2f5b0771618949477db5e4",
        "cea820651e1042826446b964a9098f6a73410635e9b0f16e61773f507962ec6c",
        "20c46dcce82060902e99a1787d5d2c401484f3d201a60ea16b33c15e983866a7",
        "5bcb4840aab84003b0954f034141f2f68c9efa084f78d8566a7c306a0e5c8fae",
      ]);
      // The caption ends where the third section does, and is drawn up to its last frame there.
      const captioned = await buildFilterGraph(stills, timeline, sections[2]!, { mediaRoot: dir, pictureOnly: true });
      try { expect(/drawtext=.*(enable='[^']*')/.exec(captioned.graph)?.[1]).toBe("enable='between(t,-0.001,0.965667)'"); }
      finally { await captioned.cleanup(); }
      // An older import has no rate on record. Nothing says its footage is off the project's frames, so it renders as it did too.
      for (const asset of stills.media) asset.fps = undefined;
      await unchanged();
    });

    it("shows the take before a cut on the first frame of a section that starts a fraction of a frame before the cut", async () => {
      const movie = (id: string) => ({ id, kind: "video" as const, name: id, path: `${id}.mp4`, duration: 4, fps: 30, width: 64, height: 64, hasAudio: false, hasAlpha: false });
      stills.media = [movie("red"), movie("blue")];
      const colour = (color: string, from: number, to: number) => ({ id: color, kind: "color" as const, timelineIn: from, timelineOut: to, color, opacity: 1, enabled: true });
      // A split between frames 105 and 106. The section after it starts on frame 105, where the first take still has a third of a frame to run.
      const join = 105.35 / 30;
      const takes = edit(track([makeMediaClip("red", 0, join, 0), makeMediaClip("blue", 0, 7 - join, join)]));
      const cards = edit(track([colour("#FF0000", 0, join), colour("#0000FF", join, 7)]));
      const sections = [{ start: 0, end: 3.5 }, { start: 3.5, end: 7 }];
      // One graph over the whole cut shows the first take on frame 105.
      const whole = "r".repeat(106) + "b".repeat(104);
      for (const timeline of [takes, cards]) {
        expect(planPlaybackSegments(stills, timeline)).toEqual(sections);
        expect(centres(await pictures(stills, timeline, { start: 0, end: 7 }))).toBe(whole);
        const parts: string[] = [];
        for (const range of sections) parts.push(centres(await pictures(stills, timeline, range)));
        expect(parts).toEqual([whole.slice(0, 105), whole.slice(105)]);
      }
      // An export is put together from the same two sections.
      const output = path.join(dir, "between-frames.mp4");
      const exported = await renderFullCached(stills, takes, path.join(dir, "between-frames-cache"), output, { mediaRoot: dir, quality: "delivery", segmentSeconds: 4 });
      expect(exported.segments.map(segment => segment.range)).toEqual(sections);
      const { stdout } = await runCapture("ffmpeg", ["-v", "error", "-i", output, "-an", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]);
      expect(centres(Array.from({ length: stdout.length / size }, (_, frame) => stdout.subarray(frame * size, (frame + 1) * size)))).toBe(whole);
      // The one frame the timeline shows at the cut is the first take's as well.
      const frame = { start: 3.5, end: 3.5 + 1 / 30 };
      expect(await renderTimelineFrame(stills, takes, frame, dir)).toEqual(await renderTimelineFrame(stills, edit(track([makeMediaClip("red", 0, 4, 0)])), frame, dir));
    });

    it("draws a caption on its last frame when a section starts on that frame", async () => {
      // The caption ends a third of the way into frame 105, so that frame is its last, in whichever section the frame falls.
      const caption = { id: "words", kind: "caption" as const, timelineIn: 95 / 30, timelineOut: 105.35 / 30, text: "MMMM", enabled: true, style: { y: 0.5, fontSize: 0.3, color: "#FFFFFF" } };
      const timeline = edit(track([caption], "caption"));
      const lit = async (range: { start: number; end: number }) =>
        (await pictures(stills, timeline, range)).map(frame => frame.some(value => value > 128) ? "u" : ".").join("");
      const whole = await lit({ start: 3, end: 4 });
      expect(whole).toBe(".".repeat(5) + "u".repeat(11) + ".".repeat(14));
      expect([await lit({ start: 3, end: 3.5 }), await lit({ start: 3.5, end: 4 })]).toEqual([whole.slice(0, 15), whole.slice(15)]);
    });

    it("ends a still on its last whole frame, in whichever section the frame after it falls", async () => {
      const take = { id: "blue", kind: "video" as const, name: "blue", path: "blue.mp4", duration: 4, fps: 30, width: 64, height: 64, hasAudio: false, hasAlpha: false };
      const sections = [{ start: 3, end: 3.5 }, { start: 3.5, end: 4 }];
      for (const name of ["red.png", "blink.gif", "one.mp4"]) {
        const kind = name === "blink.gif" ? "graphic" : "image";
        stills.media = [take, { id: "still", kind, name, path: name, hasAlpha: kind === "graphic" }];
        // A still's length is counted in whole frames: from frame 95 to a third of the way into frame 105 is ten, and frame 105 is the take's.
        const timeline = edit(track([makeMediaClip("blue", 0, 4, 0)]), track([makeMediaClip("still", 0, 10.35 / 30, 95 / 30)]));
        const whole = centres(await pictures(stills, timeline, { start: 3, end: 4 }));
        expect([name, whole]).toEqual([name, "b".repeat(5) + "r".repeat(10) + "b".repeat(15)]);
        const parts: string[] = [];
        for (const range of sections) parts.push(centres(await pictures(stills, timeline, range)));
        expect([name, parts]).toEqual([name, [whole.slice(0, 15), whole.slice(15)]]);
        // The section from frame 105 has nothing of the still to show, so it does not read it.
        const graph = await buildFilterGraph(stills, timeline, sections[1]!, { mediaRoot: dir, pictureOnly: true });
        try { expect([name, graph.inputs.map(input => path.basename(input))]).toEqual([name, ["blue.mp4"]]); }
        finally { await graph.cleanup(); }
      }
    });

    it("keeps each take's sound up to a cut between two frames, on both sides of a section's edge", async () => {
      const { project } = fixture();
      /** The milliseconds of a range's mixed sound that are silent. The source is a steady tone. */
      const silent = async (timeline: Timeline, range: { start: number; end: number }) => {
        const graph = await buildFilterGraph(project, timeline, range, { mediaRoot: dir });
        try {
          const { stdout } = await runCapture("ffmpeg", ["-v", "error", ...graph.args.slice(0, graph.args.indexOf("-map")),
            "-map", "[vout]", "-f", "null", "-", "-map", "[aout]", "-ac", "1", "-f", "s16le", "pipe:1"]);
          expect(stdout.length).toBe(Math.round((range.end - range.start) * 48000) * 2);
          const quiet: number[] = [];
          for (let ms = 0; (ms + 1) * 96 <= stdout.length; ms++) {
            let peak = 0;
            for (let i = ms * 96; i < (ms + 1) * 96; i += 2) peak = Math.max(peak, Math.abs(stdout.readInt16LE(i)));
            if (peak < 500) quiet.push(ms);
          }
          return quiet;
        } finally { await graph.cleanup(); }
      };
      // Frame 105.35 leaves the first take's last 12 ms at the start of the second section, and 104.65 the second take's first 12 ms at the end of the first.
      for (const frame of [105.35, 104.65]) {
        const join = frame / 30;
        const timeline = edit(track([makeMediaClip("m1", 1, 1 + join, 0), makeMediaClip("m1", 5, 12 - join, join)]));
        const sections = planPlaybackSegments(project, timeline);
        expect(sections).toEqual([{ start: 0, end: 3.5 }, { start: 3.5, end: 7 }]);
        expect([frame, await silent(timeline, { start: 0, end: 7 })]).toEqual([frame, []]);
        expect([frame, await silent(timeline, sections[0]!), await silent(timeline, sections[1]!)]).toEqual([frame, [], []]);
      }
    });

    it("plays none of a take in the next section when less than a sample of its sound falls there", async () => {
      const { project } = fixture();
      /** How many milliseconds of a range's mixed sound are not silent. The source is a steady tone. */
      const heard = async (timeline: Timeline, range: { start: number; end: number }) => {
        const graph = await buildFilterGraph(project, timeline, range, { mediaRoot: dir });
        try {
          const { stdout } = await runCapture("ffmpeg", ["-v", "error", ...graph.args.slice(0, graph.args.indexOf("-map")),
            "-map", "[vout]", "-f", "null", "-", "-map", "[aout]", "-ac", "1", "-f", "s16le", "pipe:1"]);
          expect(stdout.length).toBe(Math.round((range.end - range.start) * 48000) * 2);
          let loud = 0;
          for (let ms = 0; (ms + 1) * 96 <= stdout.length; ms++) {
            let peak = 0;
            for (let i = ms * 96; i < (ms + 1) * 96; i += 2) peak = Math.max(peak, Math.abs(stdout.readInt16LE(i)));
            if (peak >= 500) loud++;
          }
          return loud;
        } finally { await graph.cleanup(); }
      };
      // 10.45 µs is over half a sample and is written as 0.00001 s, under one. A quarter-speed take 25 µs past the edge reads 6 µs of its file.
      for (const [kind, speed, past] of [["video", 1, 0.00001045], ["video", 0.25, 0.000025], ["audio", 1, 0.00001045]] as const) {
        const timeline = edit({ ...track([makeMediaClip("m1", 1, 1 + (3.5 + past) * speed, 0, { speed })]), kind });
        expect([kind, speed, await heard(timeline, { start: 3.5, end: 4.5 })]).toEqual([kind, speed, 0]);
      }
    });

    it("shows footage at another rate, or played at another speed, on exactly its clip's frames", async () => {
      const movie = (id: string, fps: number) => ({ id, kind: "video" as const, name: id, path: `${id}.mp4`, duration: 4, fps, width: 64, height: 64, hasAudio: false, hasAlpha: false });
      for (const rate of [60, 24]) {
        await runCapture("ffmpeg", [...common, "-f", "lavfi", "-i", `color=c=red:s=64x64:r=${rate}:d=4`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path.join(dir, `red${rate}.mp4`)]);
      }
      // Slower footage has fewer pictures than the cut has frames: 30 fps footage in a 60 fps project, three 20-frame clips and then nothing.
      const fast = createProject("Fast edges", { width: 64, height: 64, fps: 60, aspect: "custom" });
      fast.media = [movie("red", 30), movie("blue", 30)];
      const thirds = [0, 20, 40].map((at, i) => makeMediaClip(i % 2 ? "blue" : "red", 1, 1 + 20 / 60, at / 60));
      const slower = centres(await pictures(fast, edit(track(thirds)), { start: 0, end: 70 / 60 }));
      // So has a clip played at half speed: 10 pictures over 20 frames, and then the next clip.
      stills.media = [movie("red", 30), movie("blue", 30), movie("red60", 60), movie("red24", 24)];
      const halfSpeed = [makeMediaClip("red", 1, 1 + 10 / 30, 0, { speed: 0.5 }), makeMediaClip("blue", 1, 1 + 10 / 30, 20 / 30)];
      const slowed = centres(await pictures(stills, edit(track(halfSpeed)), { start: 0, end: 1 }));
      // Faster footage, and footage whose pictures fall between the project's frames, stop with their clip where nothing follows it.
      const threeFrames = async (id: string) => centres(await pictures(stills, edit(track([makeMediaClip(id, 1, 1 + 3 / 30, 0)])), { start: 0, end: 10 / 30 }));
      expect({ slower, slowed, faster: await threeFrames("red60"), between: await threeFrames("red24") }).toEqual({
        slower: "r".repeat(20) + "b".repeat(20) + "r".repeat(20) + ".".repeat(10),
        slowed: "r".repeat(20) + "b".repeat(10),
        faster: "rrr.......",
        between: "rrr.......",
      });
    });
  });

  describe("what a render fell back from", () => {
    it("says when a preview copy could not be read and the range came from the originals", async () => {
      const { project, timeline } = fixture();
      let asked = 0;
      const result = await renderRange(project, timeline, { start: 0.5, end: 1.5 }, path.join(dir, "no-copy.mp4"), {
        mediaRoot: dir, height: 90,
        pictureSource: async () => { asked++; return { file: path.join(dir, "missing-copy.mp4"), start: 0 }; },
      });
      expect(asked).toBe(1);
      expect(result.warnings.filter(warning => warning.includes("preview copy")))
        .toEqual([expect.stringMatching(/^A preview copy could not be read for this range \(.*No such file or directory.*\); rendered from the original files\.$/)]);
      expect(result.args.join(" ")).not.toContain("missing-copy.mp4");
      expect((await probeOut(result.output)).duration).toBeCloseTo(1, 1);
    });

    it("says when a movie's index could not be used, for a range and for a single frame", async () => {
      // A Matroska file filed as an indexed MP4: the header-only read fails, and a packet scan reads it.
      await runCapture("ffmpeg", ["-v", "error", "-y", "-i", src, "-c", "copy", path.join(dir, "filed-as-mp4.mkv")]);
      const { project } = fixture();
      project.media = [{ id: "m1", kind: "video", name: "filed-as-mp4.mkv", path: "filed-as-mp4.mkv", duration: 10, fps: 30, width: 320, height: 180,
        hasAudio: true, hasAlpha: false, originalPlaybackType: 'video/mp4; codecs="avc1.64000d,mp4a.40.2"', previewClock: { frameRate: "30/1", startPts: 0, videoStart: 0 } }];
      const timeline = timelineFromKeepRanges(project.id, "m1", [{ start: 1, end: 2 }]);
      const said = /^(A|The) movie's index could not be used.* \(.+\); scanned the file instead\.$/;
      const result = await renderRange(project, timeline, { start: 0, end: 1 }, path.join(dir, "scanned.mp4"), { mediaRoot: dir, height: 90, pictureOnly: true });
      expect(result.warnings).toEqual([expect.stringMatching(said)]);
      expect(result.args).not.toContain("-nofind_stream_info");
      expect((await probeOut(result.output)).duration).toBeCloseTo(1, 1);

      const reasons: string[] = [];
      const frame = await renderTimelineFrame(project, timeline, { start: 0.5, end: 0.5 + 1 / 30 }, dir, undefined, 160, { onFallback: reason => reasons.push(reason) });
      expect(frame.length).toBeGreaterThan(500);
      expect(reasons).toEqual([expect.stringMatching(said)]);
      expect((await extractFrame(path.join(dir, "filed-as-mp4.mkv"), 1.5, { width: 160, indexedMp4: true, onFallback: reason => reasons.push(reason) }))
        .equals(await extractFrame(path.join(dir, "filed-as-mp4.mkv"), 1.5, { width: 160 }))).toBe(true);
      expect(reasons).toEqual([expect.stringMatching(said), expect.stringMatching(said)]);
    });

    it("says why adjacent sections were encoded one at a time after their shared encode failed", async () => {
      const { project, timeline } = fixture();
      const run = ffmpeg.runFfmpeg;
      // As ffmpeg writes it: the cause, then what came of it. The address differs from run to run.
      const refused = (address: string) => `[h264_nvenc @ ${address}] OpenEncodeSessionEx failed: out of memory (10)\n[vost#0:0/h264_nvenc @ ${address}] Error while opening encoder\nConversion failed!\n`;
      let failures = 0;
      // Only the encode that writes several sections maps a second part.
      const encode = vi.spyOn(ffmpeg, "runFfmpeg").mockImplementation((args, opts) => args.includes("[sv1]")
        ? Promise.reject(new ffmpeg.FfmpegError("ffmpeg exited with code 1", "ffmpeg", args, 1, refused(`0x${(++failures).toString(16)}f00`)))
        : run(args, opts));
      try {
        const result = await renderFullCached(project, timeline, path.join(dir, "one-at-a-time"), path.join(dir, "one-at-a-time.mp4"), { mediaRoot: dir, height: 90, segmentSeconds: 1 });
        expect(result.segments.length).toBeGreaterThan(2);
        expect(result.rendered).toBe(result.segments.length);
        expect(result.warnings.filter(warning => warning.includes("one at a time")))
          .toEqual([`${result.segments.length} sections could not be encoded in one pass ([h264_nvenc] OpenEncodeSessionEx failed: out of memory (10); Conversion failed!); encoded them one at a time.`]);
        expect((await probeOut(result.output)).duration).toBeCloseTo(5, 1);
      } finally { encode.mockRestore(); }
    });

    it("hands a playback section's warnings back, and none for a section already cached", async () => {
      const { project, timeline } = fixture();
      const render = () => renderPlaybackSegment(project, timeline, { start: 3, end: 5 }, path.join(dir, "playback-warnings"), path.join(dir, "playback-warnings.mp4"), { mediaRoot: dir, height: 90 });
      expect((await render())?.warnings).toContain('unknown effect type "nope" ignored');
      expect(await render()).toEqual({ warnings: [] });
    });

    it("says once why a listed hardware encoder was passed over, and tests it again only if the test never started", async () => {
      const bin = path.join(dir, "reasons-ffmpeg");
      const encoders = vi.spyOn(ffmpeg, "ffmpegEncoders").mockResolvedValue(new Set(["h264_nvenc"]));
      const probe = vi.spyOn(ffmpeg, "runCapture")
        .mockRejectedValueOnce(new ffmpeg.FfmpegError(`failed to start ${bin}: spawn EAGAIN`, bin, [], null, "", false))
        .mockRejectedValueOnce(new ffmpeg.FfmpegError("ffmpeg exited with code 1", bin, [], 1, "Cannot load nvcuda.dll\n"));
      const reasons: string[] = [];
      const resolve = () => resolveVideoEncoder("nvenc", bin, { width: 640, height: 360 }, reason => reasons.push(reason));
      try {
        for (let i = 0; i < 3; i++) expect(await resolve()).toBe("libx264");
        // The first test never ran, so the second call tested again. Its answer was kept, and the third said nothing.
        expect(probe).toHaveBeenCalledTimes(2);
        expect(reasons).toEqual([
          `h264_nvenc could not encode a 640x360 frame (failed to start ${bin}: spawn EAGAIN).`,
          "h264_nvenc could not encode a 640x360 frame (Cannot load nvcuda.dll).",
        ]);
        // A test that a signal ended has no exit code either, but it ran: its answer is kept like any other.
        probe.mockRejectedValueOnce(new ffmpeg.FfmpegError("ffmpeg exited with code null", bin, [], null, ""));
        for (let i = 0; i < 3; i++) expect(await resolveVideoEncoder("nvenc", bin, { width: 320, height: 180 }, reason => reasons.push(reason))).toBe("libx264");
        expect(probe).toHaveBeenCalledTimes(3);
        expect(reasons.slice(2)).toEqual(["h264_nvenc could not encode a 320x180 frame (ffmpeg exited with code null)."]);
        encoders.mockRejectedValueOnce(new Error("spawn EAGAIN"));
        expect(await resolve()).toBe("libx264");
        expect(reasons.at(-1)).toBe("Could not list this ffmpeg's encoders (spawn EAGAIN).");
        expect(await resolveVideoEncoder("none", bin, undefined, reason => reasons.push(reason))).toBe("libx264");
        expect(reasons).toHaveLength(4);
        // Session exhaustion is temporary. A later export can use the same GPU and format.
        probe.mockRejectedValueOnce(new ffmpeg.FfmpegError("busy", bin, [], 1, "OpenEncodeSessionEx failed: out of memory (10)"))
          .mockResolvedValueOnce({ code: 0, stdout: Buffer.alloc(0), stderr: "" });
        const exportEncoder = () => resolveVideoEncoder("nvenc", bin, { width: 1920, height: 1080 }, undefined, "delivery");
        expect(await exportEncoder()).toBe("libx264");
        expect(await exportEncoder()).toBe("h264_nvenc");
      } finally {
        probe.mockRestore();
        encoders.mockRestore();
      }
    });

    it("exports with bitrate control when VideoToolbox can encode but cannot use qscale", async () => {
      const { project, timeline } = fixture();
      const bin = path.join(dir, "qscale-ffmpeg");
      const encoders = vi.spyOn(ffmpeg, "ffmpegEncoders").mockResolvedValue(new Set(["h264_videotoolbox"]));
      const probe = vi.spyOn(ffmpeg, "runCapture").mockImplementation(async (_bin, args) => {
        if (args.includes("-q:v")) throw new ffmpeg.FfmpegError("ffmpeg exited with code 1", bin, args, 1,
          "Error: -q:v qscale not available for encoder. Use -b:v bitrate instead.");
        return { code: 0, stdout: Buffer.alloc(0), stderr: "" };
      });
      const encode = vi.spyOn(ffmpeg, "runFfmpeg").mockResolvedValue({ stderr: "" });
      try {
        for (const [quality, fps] of [["preview", 30], ["delivery", 60]] as const) {
          project.settings.fps = fps;
          const options = { quality, ffmpegPath: bin, exportHeight: 180, mediaRoot: dir, softwareDecode: true };
          const result = await renderRange(project, timeline, { start: 0, end: 1 }, path.join(dir, "bitrate.mp4"), options);
          expect(result.encoder).toBe("h264_videotoolbox");
          expect(result.args).not.toContain("-q:v");
          const bitrate = result.args[result.args.indexOf("-b:v") + 1];
          expect(Number(bitrate)).toBeGreaterThan(0);
          expect(probe.mock.calls.some(([, args]) => args.includes("-b:v") && args.includes(bitrate!))).toBe(true);
          expect(result.warnings).not.toContainEqual(expect.stringContaining("could not encode"));
          await renderRange(project, timeline, { start: 0, end: 1 }, path.join(dir, "bitrate-again.mp4"), options);
        }
        expect(probe.mock.calls.filter(([, args]) => args.includes("-frames:v"))).toHaveLength(4);
        expect(encode).toHaveBeenCalledTimes(4);
      } finally {
        encode.mockRestore();
        probe.mockRestore();
        encoders.mockRestore();
      }
    });

    it("rechecks VideoToolbox when a later export can acquire a previously unavailable encoder", async () => {
      const bin = path.join(dir, "vt-busy-ffmpeg");
      const encoders = vi.spyOn(ffmpeg, "ffmpegEncoders").mockResolvedValue(new Set(["h264_videotoolbox"]));
      const probe = vi.spyOn(ffmpeg, "runCapture")
        .mockRejectedValueOnce(new ffmpeg.FfmpegError("unavailable", bin, [], 1,
          "Error: cannot create compression session: -12908\nTry -allow_sw 1. The hardware encoder may be busy, or not supported."))
        .mockResolvedValueOnce({ code: 0, stdout: Buffer.alloc(0), stderr: "" });
      try {
        expect(await resolveVideoEncoder("auto", bin, undefined, undefined, "delivery")).toBe("libx264");
        expect(await resolveVideoEncoder("auto", bin, undefined, undefined, "delivery")).toBe("h264_videotoolbox");
        expect(await resolveVideoEncoder("auto", bin, undefined, undefined, "delivery")).toBe("h264_videotoolbox");
        expect(probe).toHaveBeenCalledTimes(2);
      } finally {
        probe.mockRestore();
        encoders.mockRestore();
      }
    });

    it("retries an export on the next GPU under its own cache key when an encoder fails on footage", async () => {
      const { project, timeline } = fixture();
      const bin = path.join(dir, "driver-ffmpeg");
      const encoders = vi.spyOn(ffmpeg, "ffmpegEncoders").mockResolvedValue(new Set(["h264_qsv", "h264_nvenc"]));
      const capture = ffmpeg.runCapture, run = ffmpeg.runFfmpeg;
      const probe = vi.spyOn(ffmpeg, "runCapture").mockImplementation((binary, args, opts) => binary === bin && args.includes("-frames:v")
        ? Promise.resolve({ code: 0, stdout: Buffer.alloc(0), stderr: "" }) : capture(binary === bin ? "ffmpeg" : binary, args, opts));
      const actual: string[] = [];
      let qsvCalls = 0, deviceBusy = false;
      const encode = vi.spyOn(ffmpeg, "runFfmpeg").mockImplementation((args, opts) => {
        const pos = args.indexOf("-c:v");
        if (pos < 0) return run(args, { ...opts, ffmpegPath: "ffmpeg" });
        const name = args[pos + 1]!;
        actual.push(name);
        if (name === "h264_qsv") {
          qsvCalls++;
          if (deviceBusy || qsvCalls === 2) return Promise.reject(new ffmpeg.FfmpegError("failed", bin, args, 1,
            deviceBusy ? "[h264_qsv @ 0x123] device is busy" : "[h264_qsv @ 0x123] Error initializing the MFX video session"));
        }
        // Use the local software encoder to produce valid fixture bytes for the simulated NVIDIA driver.
        const rewritten = [...args];
        rewritten.splice(pos, args.indexOf("-pix_fmt", pos) - pos, "-c:v", "libx264");
        return run(rewritten, { ...opts, ffmpegPath: "ffmpeg" });
      });
      try {
        const options = { quality: "delivery" as const, hwaccel: "qsv" as const, ffmpegPath: bin,
          mediaRoot: dir, softwareDecode: true, segmentSeconds: 1, exportRange: { start: 0, end: 2 } };
        const exportFile = (name: string, hwaccel: "qsv" | "nvenc" | "none", concurrency = 1) => renderFullCached(project, timeline,
          path.join(dir, "driver-cache"), path.join(dir, name + ".mp4"), { ...options, hwaccel, concurrency });
        const switched = await exportFile("switched", "qsv");
        expect(switched.encoder).toBe("h264_nvenc");
        expect(actual).toEqual(["h264_qsv", "h264_qsv", ...Array(switched.rendered).fill("h264_nvenc")]);
        expect(switched.warnings).toContainEqual(expect.stringMatching(/h264_qsv.*h264_nvenc/));
        const cached = await exportFile("cached", "nvenc");
        expect(cached.rendered).toBe(0);
        expect(cached.segments.map(s => s.key)).toEqual(switched.segments.map(s => s.key));
        expect((await probeOut(cached.output)).duration).toBeCloseTo(2);
        // Preserve the first GPU's successfully published part under its own key.
        const restored = await exportFile("recovered", "qsv");
        expect(restored.reused).toBe(1);
        expect(restored.encoder).toBe("h264_qsv");
        expect(restored.segments.map(s => s.key)).not.toEqual(switched.segments.map(s => s.key));
        // A serial retry on a busy GPU can still fall back if it refuses a single session.
        await fs.rm(restored.segments[0]!.file);
        deviceBusy = true;
        const retried = await exportFile("busy", "qsv", 2);
        expect(retried.encoder).toBe("h264_nvenc");
        expect(retried.warnings).toContainEqual(expect.stringContaining("one section at a time"));
        encoders.mockResolvedValue(new Set(["h264_qsv"]));
        const software = await exportFile("software", "qsv");
        expect(software.encoder).toBe("libx264");
        expect(software.rendered).toBe(switched.rendered);
        expect((await exportFile("explicit-cpu", "none")).rendered).toBe(0);
      } finally {
        encode.mockRestore();
        probe.mockRestore();
        encoders.mockRestore();
      }
    });

    it.skipIf(process.platform === "win32")("tests an encoder that crashes ffmpeg once, not on every render", async () => {
      // A stand-in for a driver that brings ffmpeg down: the one-frame test is ended by a signal.
      const bin = path.join(dir, "crashing-ffmpeg");
      await fs.writeFile(bin, "#!/bin/sh\nkill -KILL $$\n");
      await fs.chmod(bin, 0o755);
      const encoders = vi.spyOn(ffmpeg, "ffmpegEncoders").mockResolvedValue(new Set(["h264_videotoolbox"]));
      const reasons: string[] = [];
      try {
        const before = spawnStats.ffmpeg;
        for (let i = 0; i < 4; i++) expect(await resolveVideoEncoder("videotoolbox", bin, { width: 640, height: 360 }, reason => reasons.push(reason))).toBe("libx264");
        expect(spawnStats.ffmpeg).toBe(before + 1);
        expect(reasons).toEqual([`h264_videotoolbox could not encode a 640x360 frame (${bin} exited with code null:).`]);
      } finally { encoders.mockRestore(); }
    });

    it("makes a preview copy on the CPU when the hardware encoder gives up, and says why", async () => {
      const capture = ffmpeg.runCapture, run = ffmpeg.runFfmpeg;
      const encoders = vi.spyOn(ffmpeg, "ffmpegEncoders").mockResolvedValue(new Set(["h264_nvenc"]));
      // The one-frame test passes, as a driver that fails only on real footage would let it.
      const probe = vi.spyOn(ffmpeg, "runCapture").mockImplementation((bin, args, opts) => args.includes("h264_nvenc")
        ? Promise.resolve({ code: 0, stdout: Buffer.alloc(0), stderr: "" }) : capture(bin, args, opts));
      const encode = vi.spyOn(ffmpeg, "runFfmpeg").mockImplementation((args, opts) => args.includes("h264_nvenc")
        ? Promise.reject(new ffmpeg.FfmpegError("ffmpeg exited with code 1", "ffmpeg", args, 1, "No capable devices found\n")) : run(args, opts));
      try {
        const output = path.join(dir, "cpu-copy.mp4");
        const result = await makeProxy(src, output, { height: 90, hwaccel: "nvenc" });
        expect(result.encoder).toBe("libx264");
        expect(result.warnings).toEqual(["h264_nvenc could not make this preview copy (No capable devices found); used libx264."]);
        expect((await probeOut(output)).height).toBe(90);
        expect((await makeProxy(src, output, { height: 90 })).warnings).toEqual([]);
      } finally {
        encode.mockRestore();
        probe.mockRestore();
        encoders.mockRestore();
      }
    });
  });

  it("publishes complete shared segments when two versions export concurrently", async () => {
    const { project, timeline } = fixture();
    const cache = path.join(dir, "concurrent");
    const marked = { ...timeline, version: "reviewed", markers: [{ id: "note", time: 1, text: "Checked", kind: "note" as const, resolved: true }] };
    const options = { mediaRoot: dir, height: 90 };
    const results = await Promise.all([timeline, marked].map((tl, i) =>
      renderFullCached(project, tl, cache, path.join(dir, `concurrent-${i}.mp4`), options)));
    expect(results.reduce((sum, result) => sum + result.rendered, 0)).toBe(results[0]!.segments.length);
    expect(results[0]!.segments.map((s) => s.key)).toEqual(results[1]!.segments.map((s) => s.key));
    expect(await fs.readdir(cache)).toEqual(results[0]!.segments.map((s) => path.basename(s.file)));
    for (const result of results) expect((await probeOut(result.output)).duration).toBeCloseTo(5, 1);
  });

  it("keeps a shared picture encode running when one playback request leaves", async () => {
    const { project, timeline } = fixture();
    const cache = path.join(dir, "shared-playback");
    const range = { start: 0, end: 2 };
    const first = new AbortController();
    const options = { mediaRoot: dir, height: 90 };
    await ffmpegVersion();
    const before = spawnStats.ffmpeg;
    const results = await Promise.allSettled([
      renderPlaybackSegment(project, timeline, range, cache, path.join(dir, "leaving.mp4"), { ...options, signal: first.signal }),
      renderPlaybackSegment(project, timeline, range, cache, path.join(dir, "watching.mp4"), { ...options, onProgress: () => first.abort() }),
    ]);
    expect(results.map(r => r.status)).toEqual(["rejected", "fulfilled"]);
    expect(spawnStats.ffmpeg - before).toBe(2); // One picture encode and the remaining viewer's remux.
  });

  it("waits for its last shared segment writer to remove the partial file on cancellation", async () => {
    const { project, timeline } = fixture();
    const cache = path.join(dir, "cancelled-last-subscriber");
    const signal = new AbortController();
    let release!: () => void, cleanupEntered!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const entering = new Promise<void>(resolve => { cleanupEntered = resolve; });
    const remove = fs.rm.bind(fs);
    const guard = vi.spyOn(fs, "rm").mockImplementation(async (file, opts) => {
      if (String(file).startsWith(cache + path.sep) && String(file).endsWith(".part.mp4")) {
        cleanupEntered();
        await hold;
      }
      return remove(file, opts);
    });
    let settled = false;
    try {
      const result = renderPlaybackSegment(project, timeline, {start:0,end:2}, cache, path.join(dir,"cancelled-last.mp4"), {
        mediaRoot: dir, height: 90, signal: signal.signal, onProgress: () => signal.abort(),
      }).catch(e => e).finally(() => { settled = true; });
      await entering;
      await new Promise<void>(resolve => setImmediate(resolve));
      const settledBeforeCleanup = settled;
      release();
      await result;
      expect(settledBeforeCleanup).toBe(false);
      expect((await fs.readdir(cache)).filter(name => name.endsWith(".part.mp4"))).toEqual([]);
    } finally {
      release();
      guard.mockRestore();
    }
  });

  it("does not return from an interrupted parallel export while a sibling still owns a cache writer", async () => {
    const { project, timeline } = fixture();
    const cache=path.join(dir,"cancel-parallel-cleanup");
    const stop=new AbortController();
    let release!:()=>void, observed!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const both=new Promise<void>(resolve=>{observed=resolve;});
    const remove=fs.rm.bind(fs);
    let arrivals=0, settled=false;
    const guard=vi.spyOn(fs,"rm").mockImplementation(async(file,opts)=>{
      if(String(file).startsWith(cache+path.sep) && String(file).endsWith(".part.mp4")){
        arrivals++;
        if(arrivals===1)await gate;
        if(arrivals===2){stop.abort();observed();}
      }
      return remove(file,opts);
    });
    try{
      const exportJob=renderFullCached(project,timeline,cache,path.join(dir,"stopped-parallel.mp4"),
        {mediaRoot:dir,height:90,segmentSeconds:2,concurrency:2,signal:stop.signal}).then(()=>false,()=>true)
        .finally(()=>{settled=true;});
      await both;
      await new Promise<void>(resolve=>setImmediate(resolve));
      const returnedEarly=settled;
      release();
      expect(await exportJob).toBe(true);
      expect(returnedEarly).toBe(false);
    }finally{release();guard.mockRestore();}
  });

  it("recovers from a locked cache destination only if another export published the segment", async () => {
    const { project, timeline } = fixture();
    const cache = path.join(dir, "locked-cache");
    const output = path.join(dir, "locked-cache-output.mp4");
    const render = () => renderFullCached(project, timeline, cache, output, { mediaRoot: dir, height: 90 });
    const locked = Object.assign(new Error("Destination is locked"), { code: "EPERM" });
    const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(locked).mockImplementationOnce(async (from, to) => {
      await fs.copyFile(from, to); // A competing export published the same completed segment.
      throw locked;
    });
    try {
      await expect(render()).rejects.toBe(locked);
      expect(await fs.readdir(cache)).toEqual([]);
      const result = await render();
      expect(await fs.readdir(cache)).toEqual(result.segments.map((s) => path.basename(s.file)));
      expect((await probeOut(output)).duration).toBeCloseTo(5, 1);
    } finally {
      rename.mockRestore();
    }
  });

  it("plays across minute 18 of a half-hour cut with only two cached segments", async () => {
    const { project, timeline } = fixture();
    const clips = Array.from({ length: 225 }, (_, i) => makeMediaClip("m1", 1, 9, i * 8));
    // Trim a second from the start of the take at 18:00 and ripple the remaining clips.
    clips[135]!.sourceIn = 2;
    for (const clip of clips.slice(136)) clip.timelineIn -= 1;
    timeline.tracks = [{ ...timeline.tracks[0]!, clips }];
    const plan = planSegments(project, timeline);
    const index = plan.findIndex(range => range.start <= 1078 && range.end > 1078);
    const cache = path.join(dir, "playback-cache");
    const options = { mediaRoot: dir, quality: "preview" as const, height: 90 };
    const edges: Buffer[] = [];
    for (const range of plan.slice(index, index + 2)) {
      const file = path.join(dir, `play-${range.start}.mp4`);
      await renderPlaybackSegment(project, timeline, range, cache, file, options);
      expect((await fs.readFile(file)).includes(Buffer.from("moof"))).toBe(true);
      for (const stream of ["a", "v"]) {
        const { stdout } = await runCapture("ffprobe", ["-v", "error", "-select_streams", stream,
          "-show_entries", "frame=pts_time,nb_samples", "-of", "json", file]);
        const { frames } = JSON.parse(stdout.toString()) as { frames: { pts_time: string; nb_samples: number }[] };
        const starts = frames.map(frame => Number(frame.pts_time));
        // Older ffprobe versions omit packet durations in fragmented MP4. Measure the decoded frames instead.
        const ends = frames.map(frame => Number(frame.pts_time) + (stream === "a"
          ? frame.nb_samples / project.settings.sampleRate : 1 / project.settings.fps));
        expect(Math.min(...starts)).toBeCloseTo(0, 4);
        expect(Math.max(...ends)).toBeCloseTo(range.end - range.start, 4);
      }
      const { stdout: pcm } = await runCapture("ffmpeg", ["-loglevel", "error", "-i", file, "-vn", "-ac", "1", "-f", "s16le", "-"]);
      expect(pcm.byteLength).toBe(Math.round((range.end - range.start) * project.settings.sampleRate) * 2);
      edges.push(range === plan[index] ? pcm.subarray(-960) : pcm.subarray(0, 960));
      // A different version with the same pixels/audio reuses the expensive video encode.
      const before = spawnStats.ffmpeg;
      await renderPlaybackSegment(project, { ...timeline, version: "next" }, range, cache, file, options);
      expect(spawnStats.ffmpeg - before).toBe(1);
    }
    expect(await fs.readdir(cache)).toHaveLength(2);
    // The source is a steady tone. Check every millisecond on either side of the join
    // for the silent lead-in produced when independently encoded AAC loses its priming.
    for (const edge of edges) {
      for (let offset = 0; offset < edge.length; offset += 96) {
        let peak = 0;
        for (let i = offset; i < offset + 96; i += 2) peak = Math.max(peak, Math.abs(edge.readInt16LE(i)));
        expect(peak).toBeGreaterThan(500);
      }
    }
  });

  it("retires cached pictures and audio mixes made before stream offsets were respected", () => {
    const project = createProject("ClockKeys", { width: 1920, height: 1080 });
    project.media.push({ id: "camera", name: "Video", kind: "video", path: "clip.mp4", hash: "fixture", hasAlpha: false,
      hasAudio: true, height: 2160, width: 3840, fps: 30000 / 1001, previewClock: { frameRate: "30000/1001", startPts: 0 } });
    const timeline = timelineFromKeepRanges(project.id, "camera", [{ start: 24, end: 28 }]);
    const preview = { quality: "preview" as const, height: 480, encoder: "libx264" }, range = { start: 0, end: 4 };
    const key = (format: Parameters<typeof segmentKey>[3]) => segmentKey(project, timeline, range, format);
    // Filenames emitted by the previous renderer for this cut.
    expect(key({ ...preview, allowProxy: true })).not.toBe("7d34089ca92c8b1625ebb0cc458c9c432e91840ba7a3321e87301ba31e016670");
    expect(key(preview)).not.toBe("3cc0b60fdbe8b4ff2a9fa3cb1bdb98ace85fdc82d2d0c1706b6d8b0212b1f41f");
    expect(key({ ...preview, quality: "delivery", height: 1080, pictureOnly: true })).not.toBe("09e733644e0965a2555cff8b32f3eec0dda050ee830957e3136ea6cdb084cf64");
    expect(key({ ...preview, height: 1080, allowProxy: true })).not.toBe("094b0fed02287e9c089ee38d0ca409d7df6649366f77de4b8e76932fd40313d0");
    const asset = project.media[0]!;
    asset.previewClock!.videoStart = 0;
    expect(usesRevisedProxyClock(project, timeline, range, 540)).toBe(false);
    expect(usesRevisedProxyClock(project, timeline, range, 480)).toBe(true);
    asset.fps = 30;
    asset.previewClock!.frameRate = "30/1";
    expect(usesRevisedProxyClock(project, timeline, range, 480)).toBe(false);
  });

  it("retires pictures cached while a cut could show a frame of background", () => {
    const project = createProject("EdgeKeys", { width: 1920, height: 1080, fps: 30 });
    project.media.push({ id: "camera", name: "Video", kind: "video", path: "clip.mp4", hash: "fixture", hasAlpha: false, hasAudio: true, height: 1080, width: 1920, fps: 30 });
    // The second take starts on frame 20 of the section, which the previous renderer left to the background.
    const timeline = timelineFromKeepRanges(project.id, "camera", [{ start: 1, end: 1 + 20 / 30 }, { start: 3, end: 5 }]);
    const key = (format: Parameters<typeof segmentKey>[3]) => segmentKey(project, timeline, { start: 0, end: 2 }, format);
    // Filenames emitted by the previous renderer for this cut.
    expect(key({ quality: "preview", height: 540, encoder: "libx264" })).not.toBe("01a6b8a3c5d7a159fe4fc3f3b89b7e47173adea440e3afd23d4d49dc85046865");
    expect(key({ quality: "delivery", height: 1080, encoder: "libx264", pictureOnly: true })).not.toBe("3e249c4a03189b2808db877eb64f487cddc98ddc5ef7e11668949893906fd960");
  });

  it("retires only the sections cached without the fraction of a frame a take has at their edge", () => {
    const project = createProject("SliverKeys", { width: 1920, height: 1080, fps: 30 });
    project.media.push({ id: "camera", name: "Video", kind: "video", path: "clip.mp4", hash: "fixture", hasAlpha: false, hasAudio: true, height: 1080, width: 1920, fps: 30 });
    const preview = { quality: "preview" as const, height: 540, encoder: "libx264" };
    const delivery = { quality: "delivery" as const, height: 1080, encoder: "libx264", pictureOnly: true };
    const sections = [{ start: 0, end: 3.5 }, { start: 3.5, end: 7 }];
    const takes = (frame: number) => timelineFromKeepRanges(project.id, "camera", [{ start: 1, end: 1 + frame / 30 }, { start: 5, end: 12 - frame / 30 }]);
    /** Two takes joined at `frame`, and which of the previous renderer's files for the two sections, preview then delivery, still stand. */
    const kept = (frame: number, previous: string[]) => {
      const keys = sections.flatMap(range => [segmentKey(project, takes(frame), range, preview), segmentKey(project, takes(frame), range, delivery)]);
      return keys.map((key, i) => key === previous[i]);
    };
    // The first take runs a third of a frame into the second section, which was cached without that frame and its 12 ms of sound.
    expect(kept(105.35, [
      "b98abf05041e7d37172f4f0e70aec99ca99ccdbbd42c21d92993f6d706bb75e0", "d07ed4281f37e7e2fb7d8e7698e254b41183e65f959dbbf6419744d41dc57135",
      "def556dd36be0679e409257a522faedd6d74510f8c5e62f036de21bd157ed124", "47cc7f6948511b186958c5e748cc091638cbd555a898919218d137d001dbc5c5",
    ])).toEqual([true, true, false, false]);
    // The second take starts a third of a frame before the first section ends: 12 ms of its sound were missing there, and no picture.
    expect(kept(104.65, [
      "7581608083df699e4d45d1ac999f16e78e4f7f1fb252969b5ea5f76721728c4c", "aa01c6e80213cd6fa176d4261b0bce8fd2bf0eb0572b59ab7da043155e931bda",
      "607a77217ed1613fbfa7a33cc11a987b5651e20e17bec332151448150ce31207", "3896eac4a3c86d6c95bb7411a217acceaaac35d04235898129130eacbd2443b5",
    ])).toEqual([false, true, true, true]);
    // That take has no frame in the first section. It is there for its sound, and where that isn't heard it is not there at all.
    const firstKey = (volume: number, both: boolean) => {
      const timeline = takes(104.65);
      (timeline.tracks[0]!.clips[1] as MediaClip).volume = volume;
      if (!both) timeline.tracks[0]!.clips.pop();
      return segmentKey(project, timeline, sections[0]!, preview);
    };
    expect(firstKey(1, true)).not.toBe(firstKey(1, false));
    expect(firstKey(0, true)).toBe(firstKey(0, false));
  });

  it("keeps the files of sections where the sliver at their edge has no frame to draw and no sample to play", () => {
    const project = createProject("SliverKeys", { width: 1920, height: 1080, fps: 30 });
    const footage = (id: string, hasAudio: boolean) => ({ id, name: id, kind: "video" as const, path: `${id}.mp4`, hash: id, hasAlpha: false, hasAudio, height: 1080, width: 1920, fps: 30 });
    project.media.push(footage("camera", true), footage("silent", false),
      { id: "still", name: "still", kind: "image", path: "still.png", hash: "still" },
      { id: "gif", name: "gif", kind: "graphic", path: "logo.gif", hash: "gif", hasAlpha: true });
    const preview = { quality: "preview" as const, height: 540, encoder: "libx264" };
    const delivery = { quality: "delivery" as const, height: 1080, encoder: "libx264", pictureOnly: true };
    const sections = [{ start: 0, end: 3.5 }, { start: 3.5, end: 7 }];
    /** Two clips joined at `frame`: one of `first`, then one of `second`. */
    const takes = (frame: number, first: string, second: string) => {
      const timeline = timelineFromKeepRanges(project.id, "camera", [{ start: 1, end: 1 + frame / 30 }, { start: 5, end: 12 - frame / 30 }]);
      timeline.tracks[0]!.clips.forEach((clip, i) => { (clip as MediaClip).mediaId = i ? second : first; });
      return timeline;
    };
    /** A still that runs a third of a frame into the second section, and which of the previous renderer's files for the two sections, preview then delivery, still stand. */
    const kept = (still: string, previous: string[]) => {
      const timeline = takes(105.35, still, "camera");
      return sections.flatMap(range => [segmentKey(project, timeline, range, preview), segmentKey(project, timeline, range, delivery)]).map((key, i) => key === previous[i]);
    };
    // A still is drawn for whole frames, and a third of one is none.
    expect(kept("still", [
      "1d272101f9d2a7b5fc126e9a725677ac9a3595a4b23afc2916ed97eb61eaccaa", "0dfa1926cc3814b26bebdd52365f33b68ad6c6d7e0f98cd33277c8482efc02c1",
      "f0b3868246fa6e4a88657dfc99ece3f5a447a385e29088053e685898e7e7ea87", "4486a5a644bf6c20968e62cbd3bb40f3b82a1876e298349c0a4508d170e2b4bc",
    ])).toEqual([true, true, true, true]);
    expect(kept("gif", [
      "2daed0664cb1a80cbd2b21fc83dd775389105469ceee016b0abcc7a0d0aea151", "d061457157a07d202d35d7943fbf6c9610f25b07ed59bd84ec0b4c7d81d333a8",
      "f0b3868246fa6e4a88657dfc99ece3f5a447a385e29088053e685898e7e7ea87", "4486a5a644bf6c20968e62cbd3bb40f3b82a1876e298349c0a4508d170e2b4bc",
    ])).toEqual([true, true, true, true]);
    // A clip that starts a fraction of a frame before the first section ends has no frame there. A silent take or a still has no sound
    // either, and nor has 10 µs of a take, which is written as less than a sample: the section is as it was without them.
    const firstKey = (frame: number, second: string, both: boolean) => {
      const timeline = takes(frame, "camera", second);
      if (!both) timeline.tracks[0]!.clips.pop();
      return segmentKey(project, timeline, sections[0]!, preview);
    };
    for (const [frame, second] of [[104.65, "silent"], [104.65, "still"], [105 - 0.00001045 * 30, "camera"]] as const) {
      expect([second, firstKey(frame, second, true)]).toEqual([second, firstKey(frame, second, false)]);
    }
  });

  it("retires only the sections cached of footage that is off the project's frames, by its rate or its speed", () => {
    const project = createProject("RateKeys", { width: 1920, height: 1080, fps: 30 });
    const footage = (id: string, fps?: number) => ({ id, name: id, kind: "video" as const, path: `${id}.mp4`, hash: id, hasAlpha: false, hasAudio: true, height: 1080, width: 1920, fps });
    project.media.push(footage("camera", 30), footage("screen", 60), footage("older"), { id: "still", name: "still", kind: "image", path: "still.png", hash: "still" });
    const preview = { quality: "preview" as const, height: 540, encoder: "libx264" };
    const delivery = { quality: "delivery" as const, height: 1080, encoder: "libx264", pictureOnly: true };
    /** One two-second clip, and which of the previous renderer's files for it, preview then delivery, still stand. */
    const kept = (mediaId: string, speed: number, previous: string[], track: Partial<Timeline["tracks"][number]> = {}) => {
      const timeline = timelineFromKeepRanges(project.id, mediaId, [{ start: 1, end: 1 + 2 * speed }]);
      Object.assign(timeline.tracks[0]!, track);
      (timeline.tracks[0]!.clips[0] as MediaClip).speed = speed;
      return [preview, delivery].map((format, i) => segmentKey(project, timeline, { start: 0, end: 2 }, format) === previous[i]);
    };
    // Footage at the project's rate and speed renders as it did.
    expect(kept("camera", 1, ["ba9eb0e57f023b58371ebff71b55454c17e13a32325d4667bb1192550c98656b", "9eeb0ecbf01c395312d7789a64572cd64e3148f73c390de91d0e953adc6d634e"])).toEqual([true, true]);
    // Slowed footage ended a frame early, and footage at twice the project's rate a frame late.
    expect(kept("camera", 0.5, ["86a38b6aff9455ebe118ae881ee01b854b3fcb972a7684d762cccd0783f8c752", "2eabc5c285cfbde6e75848a29e15a3e81b31c7c42e09d9541a08ad155958eaf8"])).toEqual([false, false]);
    expect(kept("screen", 1, ["8c7816e0725f36d6391225474df09db28e96794a21d914e68f7b9c67c782921d", "54c3f3393b144b1089691ced1b350d4b2afce9c635a75299db4f7be559eb465f"])).toEqual([false, false]);
    // An import with no rate on record and a still are left as they were, and so is slowed footage that is only heard or is hidden.
    expect(kept("older", 1, ["e133123f456d9f21af40791410358692075ac1d044172986bf448e76766105c0", "958237023dcc341b4b84fabbf851bd5d6b51ea4e4d141acfe706d89fdc609e1a"])).toEqual([true, true]);
    expect(kept("still", 0.5, ["07f0d8f8e04582caee8b936339458b8a0a02aa0640e3cd5d8b6e6e9873b018d3", "227157f4ee88dbe400c29b8a28cce09ca1c4bcd9bd3ccff97c903e4ccf9e94fa"])).toEqual([true, true]);
    expect(kept("camera", 0.5, ["95f9f57bf779fe803ca6a66ebd8c429b62cf6caaf53cad583b5c3102bbaf8635", "530bea1422ce6e18ec1cabc96d79eceed7eb9c0167448f0501fc6cb1eb67deed"], { kind: "audio" })).toEqual([true, true]);
    expect(kept("camera", 0.5, ["b92469603e9e79e8cf282862f206cdf3abf0d3ff5adf73c21e6d5188c74af852", "6bfbe292adc1cd99998141c221d4a844616d7161eb0625467f521844307125d0"], { hidden: true })).toEqual([true, true]);
  });

  it("keeps equivalent segment keys after frame-aligned ripples at 29.97 fps", () => {
    const { project } = fixture();
    const fps = 30000 / 1001;
    project.settings.fps = fps;
    project.media[0]!.hash = "test-fingerprint";
    const keep = Array.from({ length: 30 }, (_, i) => ({ start: i * 310 / fps, end: (i * 310 + 240) / fps }));
    const before = timelineFromKeepRanges(project.id, "m1", keep);
    const after = structuredClone(before);
    after.tracks[0]!.clips.shift();
    for (const clip of after.tracks[0]!.clips) clip.timelineIn -= 240 / fps;
    const keys = (tl: Timeline) => planSegments(project, tl).map(range => segmentKey(project, tl, range, "preview"));
    expect(keys(after)).toEqual(keys(before).slice(1));
  });

  it("re-renders only the playback sections around a whole-frame cut, wherever the edit's earlier joins fall", () => {
    const { project } = fixture();
    const fps = 30000 / 1001;
    project.settings.fps = fps;
    project.media[0]!.hash = "test-fingerprint";
    project.media[0]!.duration = 600;
    // Earlier cuts left joins between frames, as most of a real pass's do.
    const keep = [{ start: 0, end: 61.237 }, { start: 63.5, end: 250.111 }, { start: 251, end: 600 }];
    const before = timelineFromKeepRanges(project.id, "m1", keep);
    const keyed = (tl: Timeline) => planPlaybackSegments(project, tl).map(range => ({ range, key: segmentKey(project, tl, range, "preview") }));
    const cached = new Set(keyed(before).map(s => s.key));
    const rerendered = (start: number, end: number) => keyed(applyOps(before, [{ op: "rippleDelete", start: start / fps, end: end / fps }]))
      .filter(s => !cached.has(s.key)).reduce((n, s) => n + s.range.end - s.range.start, 0);
    for (const [start, end] of [[300, 345], [3000, 3012], [9000, 9090]]) expect(rerendered(start, end)).toBeLessThan(10);
  });

  it("reuses unaffected segments after a trim and a ripple, including the decoded picture and sound", async () => {
    const { project, timeline } = fixture();
    project.media[0]!.hash = await hashFile(src);
    timeline.tracks = [timeline.tracks[0]!];
    const track = timeline.tracks[0]!;
    const clip = makeMediaClip("m1", 1, 7, 0, { audioFadeOut: 0.4, videoFadeOut: 0.4 });
    track.clips = [clip];
    const cache = path.join(dir, "local-segment-keys");
    const out = path.join(dir, "trimmed.mp4");
    // Lossless H.264 lets us compare the exact pictures across independent encodes.
    const opts = { mediaRoot: dir, height: 90, segmentSeconds: 2, extraArgs: ["-crf", "0"] };
    await renderFullCached(project, timeline, cache, out, opts);
    clip.sourceOut -= 0.2;
    const onCachedRanges = vi.fn();
    const trimmed = await renderFullCached(project, timeline, cache, out, { ...opts, onCachedRanges });
    expect(trimmed.segments.map(s => s.cached)).toEqual([true, true, false]);
    expect(onCachedRanges.mock.calls.map(([ranges]) => ranges)).toEqual([
      [{ start: 0, end: 4 }], [{ start: 0, end: trimmed.duration }],
    ]);

    track.clips = [0, 1, 2].map(i => makeMediaClip("m1", 3*i, 3*i + 2, 2*i));
    await renderFullCached(project, timeline, cache, out, opts);
    track.clips.shift();
    track.clips.forEach(c => { c.timelineIn -= 2; });
    const ripple = await renderFullCached(project, timeline, cache, out, opts);
    expect(ripple.segments.map(s => s.cached)).toEqual([true, true]);
    const clean = path.join(dir, "fresh-ripple.mp4");
    await renderFullCached(project, timeline, path.join(dir, "fresh-ripple"), clean, opts);
    const decoded = async (file: string) => (await runCapture("ffmpeg", [
      "-v", "error", "-i", file, "-map", "0:v", "-map", "0:a", "-f", "framemd5", "-",
    ])).stdout;
    expect(await decoded(out)).toEqual(await decoded(clean));
    // Removing the head of one continuous clip also changes its sourceIn and
    // clip-local clock. An ordinary kept source window should still match.
    track.clips = [makeMediaClip("m1", 0, 8, 0)];
    const kept = segmentKey(project, timeline, { start: 4, end: 6 }, "preview");
    track.clips = [makeMediaClip("m1", 4, 8, 0)];
    const key = () => segmentKey(project, timeline, { start: 0, end: 2 }, "preview");
    expect(key()).toBe(kept);
    const beforeFade = key();
    const first = track.clips[0]!;
    if (first.kind !== "media") throw new Error("expected media");
    first.audioFadeOut = 1;
    expect(key()).not.toBe(beforeFade);
  });

  it("reuses cached segments on the second full render", async () => {
    const { project, timeline } = fixture();
    const cacheDir = path.join(dir, "cache");
    // 5 s timeline, 2 s segments: [0,2] cut at the clip boundary at 2, then the
    // remaining 3 s is one segment because the tail after 4 would be too short.
    const plan = planSegments(project, timeline, 2);
    expect(plan).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 5 },
    ]);

    const key1 = segmentKey(project, timeline, plan[0]!, "preview");
    const key2 = segmentKey(project, timeline, plan[1]!, "preview");
    expect(key1).not.toBe(key2);
    expect(segmentKey(project, timeline, plan[0]!, "delivery")).not.toBe(key1);

    const out1 = path.join(dir, "full1.mp4");
    const first = await renderFullCached(project, timeline, cacheDir, out1, { mediaRoot: dir, height: 180, segmentSeconds: 2 });
    expect(first.rendered).toBe(2);
    expect(first.reused).toBe(0);
    for (const segment of first.segments) {
      expect(segment.key).toBe(segmentKey(project, timeline, segment.range, { quality: "preview", height: 180, encoder: first.encoder }));
    }

    const before = spawnStats.ffmpeg;
    const out2 = path.join(dir, "full2.mp4");
    const second = await renderFullCached(project, timeline, cacheDir, out2, { mediaRoot: dir, height: 180, segmentSeconds: 2 });
    expect(second.rendered).toBe(0);
    expect(second.reused).toBe(2);
    // Only the concat ran.
    expect(spawnStats.ffmpeg - before).toBe(1);

    const p = await probeOut(out2);
    expect(Math.abs(p.duration - 5)).toBeLessThan(0.1);
    expect(p.width).toBe(320);
    expect(p.hasAudio).toBe(true);
    // Every presented frame must sit on the editor's grid, including after
    // the second section begins. AAC priming precedes picture time zero.
    const { stdout } = await runCapture("ffprobe", ["-v", "error", "-show_packets",
      "-show_entries", "packet=stream_index,pts_time:packet_side_data=skip_samples", "-of", "json", out2]);
    const { packets } = JSON.parse(stdout.toString()) as { packets: { stream_index: number; pts_time: string; side_data_list?: { skip_samples: number }[] }[] };
    const pictures = packets.filter(packet => packet.stream_index === 0).map(packet => Number(packet.pts_time)).sort((a, b) => a - b);
    expect(pictures).toHaveLength(5 * project.settings.fps);
    expect(pictures.every((pts, i) => Math.abs(pts - i / project.settings.fps) < 1e-6)).toBe(true);
    expect(packets.find(packet => packet.stream_index === 1)?.side_data_list?.[0]?.skip_samples).toBe(1024);

    // Editing one clip (c2 spans 3..5) only invalidates the segment it touches.
    const edited = structuredClone(timeline);
    (edited.tracks[0]!.clips[1]! as { volume: number }).volume = 0.3;
    const out3 = path.join(dir, "full3.mp4");
    const third = await renderFullCached(project, edited, cacheDir, out3, { mediaRoot: dir, height: 180, segmentSeconds: 2 });
    expect(third.reused).toBe(1);
    expect(third.rendered).toBe(1);
  });

  it("keeps the original movie's sound after exporting the same source as a still", async () => {
    const { project } = fixture();
    const movie = project.media[0]!;
    movie.hash = await hashFile(src);
    project.media.push({ ...movie, id: "freeze", kind: "image" });
    const cache = path.join(dir, "still-and-movie-cache");
    const output = path.join(dir, "still-and-movie.mp4");
    const exportAudio = async (mediaId: string) => {
      const timeline = timelineFromKeepRanges(project.id, mediaId, [{ start: 0, end: 0.5 }]);
      await renderFullCached(project, timeline, cache, output, { quality: "delivery", mediaRoot: dir });
      const { stdout } = await runCapture("ffmpeg", ["-v", "error", "-i", output, "-map", "0:a",
        "-ac", "1", "-f", "s16le", "-"]);
      let peak = 0;
      for (let i = 0; i < stdout.length; i += 2) peak = Math.max(peak, Math.abs(stdout.readInt16LE(i)));
      return peak;
    };
    expect(await exportAudio("freeze")).toBe(0);
    expect(await exportAudio(movie.id)).toBeGreaterThan(500);
  });

  it("reuses video-only delivery segments after a sound edit and preserves the new mix", async () => {
    const { project, timeline } = fixture();
    project.media[0]!.hash = await hashFile(src);
    const camera = makeMediaClip("m1", 0, 6, 0);
    timeline.tracks = [{ ...timeline.tracks[0]!, clips: [camera] }];
    const cache = path.join(dir, "delivery-picture-cache");
    const options = { quality: "delivery" as const, segmentSeconds: 2, mediaRoot: dir };
    const output = path.join(dir, "delivery-picture.mp4");
    const streamHash = async (stream: string) => (await runCapture("ffmpeg", [
      "-v", "error", "-i", output, "-map", "0:" + stream, "-c", "copy", "-f", "streamhash", "-hash", "sha256", "-",
    ])).stdout.toString();
    const before = await renderFullCached(project, timeline, cache, output, options);
    expect((await probeMedia(before.segments[0]!.file)).hasAudio).toBe(false);
    // Only the delivered movie needs a front-loaded index. Private segments go straight to the final remux.
    for (const file of [before.segments[0]!.file, output]) {
      const bytes = await fs.readFile(file);
      const atoms: string[] = [];
      for (let i = 0; i < bytes.length; i += bytes.readUInt32BE(i)) {
        expect(bytes.readUInt32BE(i)).toBeGreaterThanOrEqual(8);
        atoms.push(bytes.toString("ascii", i + 4, i + 8));
      }
      expect(atoms).toEqual(expect.arrayContaining(["moov", "mdat"]));
      expect(atoms.indexOf("moov") < atoms.indexOf("mdat")).toBe(file === output);
    }
    const picture = await streamHash("v"), sound = await streamHash("a");
    camera.volume = 0.3;
    camera.audioFadeIn = 0.2;
    camera.effects.push({ type: "limiter", params: {}, enabled: true });
    timeline.tracks.push({ ...timeline.tracks[0]!, id: "mic", kind: "audio", clips: [makeMediaClip("m1", 1, 3, 1.5)] });
    const changed = await renderFullCached(project, timeline, cache, output, options);
    expect(changed.rendered).toBe(0);
    expect(changed.segments.map(s => s.key)).toEqual(before.segments.map(s => s.key));
    expect(await streamHash("v")).toBe(picture);
    expect(await streamHash("a")).not.toBe(sound);
    camera.opacity = 0.5;
    expect((await renderFullCached(project, timeline, cache, output, options)).reused).toBe(0);
    expect(await streamHash("v")).not.toBe(picture);
  });
  it("keeps a longer audio-only cut aligned at a fractional frame rate across lossless mix segments", async () => {
    const { project, timeline } = fixture();
    const fps = 30000 / 1001;
    project.settings.fps = fps;
    project.media[0]!.hash = await hashFile(src);
    const audio = { ...timeline.tracks[0]!, kind: "audio" as const };
    audio.clips = Array.from({ length: 20 }, (_, i) => makeMediaClip("m1", 0, 0.5, i));
    timeline.tracks = [audio];
    const output = path.join(dir, "audio-only-delivery.mp4");
    const cache = path.join(dir, "audio-only-delivery-cache");
    const render = await renderFullCached(project, timeline, cache, output, { mediaRoot: dir, quality: "delivery" });
    const streams = JSON.parse((await runCapture("ffprobe", ["-v", "error", "-of", "json", "-show_entries",
      "stream=codec_type,start_time,duration_ts,time_base", output])).stdout.toString()).streams;
    expect(streams.find((stream: { codec_type: string }) => stream.codec_type === "audio")).toMatchObject({
      start_time: "0.000000", time_base: "1/48000", duration_ts: Math.round(render.duration * 48000),
    });
    const mixes = (await fs.readdir(cache)).filter(file => file.startsWith("mix-"));
    expect(mixes).toHaveLength(2);
    const audioHash = async () => (await runCapture("ffmpeg", ["-v", "error", "-i", output,
      "-map", "0:a", "-c", "copy", "-f", "hash", "-"])).stdout.toString();
    const expected = await audioHash();
    // The delivered AAC is complete even if the intermediate lossless sections were cleaned up.
    await Promise.all(mixes.map(file => fs.rm(path.join(cache, file))));
    await renderFullCached(project, timeline, cache, output, { mediaRoot: dir, quality: "delivery" });
    expect((await fs.readdir(cache)).filter(file => file.startsWith("mix-"))).toEqual([]);
    expect(await audioHash()).toBe(expected);
  });
});

it("expands quiet dialogue downward while leaving a loud passage at unity", async () => {
  const filters = effectFilters([{ type: "expander", enabled: true, params: { thresholdDb: -30, rangeDb: -12, ratio: 3 } }],
    "audio", { mediaRoot: dir, warn: message => { throw new Error(message); } });
  const { stdout } = await runCapture("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
    "aevalsrc='if(lt(t,1),0.001,0.5)':s=48000:d=2", "-af", filters.join(","), "-f", "f32le", "-"]);
  expect(stdout.readFloatLE(24000 * 4)).toBeCloseTo(0.001 * 10 ** (-12 / 20), 5);
  expect(stdout.readFloatLE(72000 * 4)).toBeCloseTo(0.5, 4);
});
