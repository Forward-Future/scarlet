// All offsets into the file are local seconds. origin maps local zero to the
// source or version time displayed to the editor (e.g. a rendered segment).
import type { TimeRange } from "@scarlet/timeline";
import { escapeFilterPath } from "./effects.js";
import { LOCAL_MEDIA_INPUT, SOURCE_AUDIO_CLOCK, failureReason, ffSeconds, resolveFfmpeg, runCapture } from "./exec.js";
import { resolveFontFile } from "./fonts.js";
import { isStoredAsShown } from "./probe.js";
import { extractWaveform } from "./waveform.js";

function input(file: string, range: TimeRange, decoder?: SheetOptions["decoder"]) {
  // CUDA frames stay on the GPU until `shrinkFirst` scales them. VideoToolbox frames come back to memory.
  const hardware = decoder === "cuda" ? ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"] : decoder ? ["-hwaccel", decoder] : [];
  return ["-hide_banner", "-nostdin", "-nostats", ...hardware, "-ss", ffSeconds(range.start),
    "-t", String(range.end - range.start), ...LOCAL_MEDIA_INPUT, "-i", file];
}

/**
 * On CUDA, scale on the GPU to the size `filter` reads, then bring only those small frames back to memory. Copying
 * whole 4K frames back and scaling them on the CPU was slower than not using the GPU at all: on a 10 s window of a
 * 4K recording, CPU decoding took 2.5 s and 17 s of CPU, and GPU decoding and scaling 1.4 s and 1.5 s of CPU.
 */
function shrinkFirst(decoder: SheetOptions["decoder"], size: string, filter: string) {
  return decoder === "cuda" ? `scale_cuda=${size}:interp_algo=bicubic:format=yuv420p,hwdownload,format=yuv420p,${filter}` : filter;
}

function frameTimes(log: string) {
  return Array.from(log.matchAll(/\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:([-+.\deE]+)/g), m => Number(m[1]));
}

export function sampleTimes(duration: number, fps: number, count: number, scenes: number[], focus?: number) {
  const last = Math.max(0, duration - 1 / fps);
  if (focus === undefined && scenes.length === 0) {
    const n = Math.max(1, Math.min(count, 1 + Math.round(last * fps)));
    return Array.from({ length: n }, (_, i) => i * last / Math.max(1, n - 1));
  }
  const times = new Set([0, last]);
  if (focus !== undefined) {
    for (const time of [focus - 1 / fps, focus]) times.add(Math.max(0, Math.min(last, time)));
  }
  const capacity = count - times.size;
  for (let i = 0; i < Math.min(capacity, scenes.length); i++) {
    const at = scenes[Math.floor(i * scenes.length / Math.min(capacity, scenes.length))]!;
    if (at > 0 && at < last) times.add(at);
  }
  // Fill the largest uncovered interval first, including in a single long shot.
  while (times.size < count) {
    const sorted = [...times].sort((a, b) => a - b);
    let start = 0, gap = 0;
    for (let i = 1; i < sorted.length; i++) {
      const width = sorted[i]! - sorted[i - 1]!;
      if (width > gap) { gap = width; start = sorted[i - 1]!; }
    }
    if (gap < 1.5 / fps) break;
    times.add(start + gap / 2);
  }
  return [...times].sort((a, b) => a - b);
}

const sheetSize = "w='max(2,trunc(min(320,180*dar)/2)*2)':h='max(2,trunc(min(180,320/dar)/2)*2)'";
export const sheetScale = `scale=${sheetSize}`;
/** A frame counts as changed when any 192x108 grey pixel moves by more than this many levels. */
export const ACTIVITY_THRESHOLD = 24;
/** A 720p preview copy reads thin features one or two grey levels fainter than its 4K original,
 * and its own noise stays under five. Two levels lower keeps copy sheets at least as sensitive. */
export const PREVIEW_COPY_ACTIVITY_THRESHOLD = 22;
export const activityFilterAt = (threshold: number) => `scale=192:108,format=gray,tblend=all_mode=difference,bbox=min_val=${threshold}`;
export const activityFilter = activityFilterAt(ACTIVITY_THRESHOLD);

function tileSheet(count: number) {
  const columns = Math.min(3, count);
  const rows = Math.ceil(count / columns);
  const font = resolveFontFile("Arial");
  const labelFont = font ? `fontfile=${escapeFilterPath(font.file)}` : "font=sans";
  return [sheetScale, "pad=320:204:(ow-iw)/2:(180-ih)/2", "setsar=1",
    `drawtext=${labelFont}:text='%{pts\\:flt} s':fontsize=16:fontcolor=white:x=6:y=183`,
    `tile=${columns}x${rows}:nb_frames=${count}:padding=2:color=black`].join(",");
}

export async function packSheet(frames: Buffer[], timestamps: number[], raw: boolean, signal?: AbortSignal) {
  const input = raw ? ["-f", "rawvideo", "-pixel_format", "yuv420p", "-video_size", "320x180"] : ["-f", "image2pipe", "-c:v", "mjpeg"];
  const pts = timestamps.map((t, i) => `eq(N,${i})*${Math.round(t * 1e6)}`).join("+");
  const { stdout } = await runCapture(resolveFfmpeg(), ["-nostdin", "-v", "error", ...input, "-i", "pipe:0",
    "-vf", `settb=AVTB,setpts='${pts}',${tileSheet(frames.length)}`, "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "4", "-f", "image2pipe", "pipe:1"],
    { stdin: Buffer.concat(frames), signal, maxStdout: 2 * 1024 * 1024 });
  if (!stdout.length) throw new Error("No contact sheet produced.");
  return { timestamps, columns: Math.min(3, frames.length), jpeg: stdout.toString("base64") };
}

interface SheetOptions {
  origin: number; fps: number; count: number; mode: "uniform" | "scene" | "activity"; focus?: number; signal?: AbortSignal;
  sourceWidth?: number;
  /** For reading a preview copy instead of the original. */
  activityThreshold?: number;
  /**
   * Decode on the GPU. VideoToolbox frames come back to memory for the same filters; CUDA frames are scaled on the
   * GPU first. Falls back to the CPU when the driver can't decode the stream, and CUDA is skipped for a file whose
   * frames need turning (`storedAsShown`).
   */
  decoder?: "cuda" | "videotoolbox";
  /** Hears why the window was read the slower way: the GPU could not decode it, or its pictures could not be kept from one read. */
  onFallback?: (reason: string) => void;
}

const cpuFallback = (decoder: string, error: unknown) => `${decoder} could not decode this window (${failureReason(error)}); decoded it on the CPU.`;

export async function contactSheet(file: string, range: TimeRange, opts: SheetOptions) {
  // CUDA frames stay on the GPU, where a clip stored sideways is not turned, so that clip decodes on the CPU.
  // VideoToolbox frames come back to memory and are turned as usual.
  if (opts.decoder && (opts.decoder !== "cuda" || await isStoredAsShown(file, { signal: opts.signal }))) {
    try { return await sheetFrom(file, range, opts); }
    catch (error) { // A driver can list a decoder it cannot run for this stream.
      opts.signal?.throwIfAborted();
      opts.onFallback?.(cpuFallback(opts.decoder, error));
    }
  }
  return sheetFrom(file, range, { ...opts, decoder: undefined });
}

async function sheetFrom(file: string, range: TimeRange, opts: SheetOptions) {
  const duration = range.end - range.start;
  if ((opts.sourceWidth ?? 0) >= 1280 && opts.mode !== "uniform" && duration <= 12 && duration * opts.fps <= 540) {
    try { return await readSheet(file, range, opts, true); }
    catch (error) { // A dense VFR window or unsupported pixel format can use two source reads.
      opts.signal?.throwIfAborted();
      opts.onFallback?.(`This window's pictures could not be kept from one read (${failureReason(error)}); read it twice.`);
    }
  }
  return readSheet(file, range, opts, false);
}

async function readSheet(file: string, range: TimeRange, opts: SheetOptions, retainPictures: boolean) {
  const args = input(file, range, opts.decoder);
  const duration = range.end - range.start;
  const origin = opts.origin + range.start;
  const bin = resolveFfmpeg();
  const optsIO = { signal: opts.signal, maxStdout: 2 * 1024 * 1024 };
  // Measure motion at the original decode cadence. For a short high-resolution
  // window, keep lossless sheet-size frames and their original variable PTS in
  // a bounded NUT stream, avoiding a second decode of the original GOPs.
  let changes: number[] | undefined;
  let scenes: number[] = [];
  let pictures: Buffer | undefined;
  if (opts.mode !== "uniform") {
    const activity = opts.mode === "activity";
    const filter = activity
      ? shrinkFirst(opts.decoder, "192:108", activityFilterAt(opts.activityThreshold ?? ACTIVITY_THRESHOLD) + ",metadata=print:key=lavfi.bbox.w:file='pipe\\:2'")
      : shrinkFirst(opts.decoder, "160:-2", "scale=160:-2,select='gt(scene,0.22)',showinfo=checksum=0");
    const tiles = retainPictures ? ["-map", "0:v:0", "-an", "-vf",
      shrinkFirst(opts.decoder, sheetSize, sheetScale + ":out_range=pc,format=yuv420p|yuv422p|yuv444p"), "-fps_mode", "passthrough",
      "-enc_time_base", "demux", "-threads", "1", "-c:v", "rawvideo", "-f", "nut", "pipe:1"] : [];
    const scan = await runCapture(bin, [...args, ...(activity ? ["-map", "0:v:0"] : []), "-an", "-vf", filter,
      "-f", "null", "-", ...tiles], { ...optsIO, maxStdout: 48 * 1024 * 1024 });
    if (activity) changes = Array.from(scan.stderr.matchAll(/^frame:.*?pts_time:([-+.\deE]+)/gm), m => Number(m[1]));
    else scenes = frameTimes(scan.stderr);
    if (retainPictures) pictures = scan.stdout;
  }
  const times = sampleTimes(duration, opts.fps, opts.count, changes ?? scenes,
    opts.focus === undefined ? undefined : opts.focus - origin);
  // Select the first displayed frame crossing each target and report its actual PTS.
  const select = ["isnan(prev_t)", ...times.slice(1).map(t => {
    const threshold = Math.max(0, t - 0.00001).toFixed(6);
    return `lt(prev_t,${threshold})*gte(t,${threshold})`;
  })].join("+");
  const columns = Math.min(3, times.length);
  const graph = [`trim=duration=${duration}`, `select='${select}'`, "settb=AVTB",
    `setpts=PTS+${origin}/TB`, "showinfo=checksum=0", tileSheet(times.length)].join(",");
  const selectedInput = pictures
    ? ["-hide_banner", "-nostdin", "-nostats", "-copyts", "-color_range", "pc", "-f", "nut", "-i", "pipe:0"] : args;
  const { stdout, stderr } = await runCapture(bin, [...selectedInput, "-map", "0:v:0", "-an", "-vf", pictures ? graph : shrinkFirst(opts.decoder, sheetSize, graph),
    "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "4", "-f", "image2pipe", "-"], { ...optsIO, stdin: pictures });
  const timestamps = frameTimes(stderr);
  if (!stdout.length || !timestamps.length) throw new Error("No video frame decoded in this window.");
  return { timestamps, columns, changedFrames: changes?.length, jpeg: stdout.toString("base64") };
}

/** Where and when a picture changes over a window: what an activity sheet looks for, as numbers. */
export interface PictureActivity {
  /** Frames that differ from the one before, of about `frames` in the window. */
  changedFrames: number;
  frames: number;
  /** Share of the frame (0 to 1) inside the changed region, for the largest change and for the median one. */
  largestArea?: number;
  typicalArea?: number;
  /** Seconds, on the clock `origin` sets, of the largest change and of the last one. */
  largestAt?: number;
  lastChangeAt?: number;
}

interface ActivityOptions {
  origin: number; fps: number; signal?: AbortSignal;
  maxFrames?: number;
  /** For reading a preview copy instead of the original. */
  threshold?: number;
  decoder?: SheetOptions["decoder"];
  /** Hears why the window was decoded on the CPU when the GPU was asked for. */
  onFallback?: (reason: string) => void;
}

/** Measure a window's frame-to-frame changes without drawing a sheet. It reads the same 192x108 grey frames an activity sheet does. */
export async function pictureActivity(file: string, range: TimeRange, opts: ActivityOptions): Promise<PictureActivity> {
  if (opts.decoder && (opts.decoder !== "cuda" || await isStoredAsShown(file, { signal: opts.signal }))) {
    try { return await activityFrom(file, range, opts); }
    catch (error) { // A driver can list a decoder it cannot run for this stream.
      opts.signal?.throwIfAborted();
      opts.onFallback?.(cpuFallback(opts.decoder, error));
    }
  }
  return activityFrom(file, range, { ...opts, decoder: undefined });
}

async function activityFrom(file: string, range: TimeRange, opts: ActivityOptions): Promise<PictureActivity> {
  // Ignore metadata carried in by the recording. The marker emits one record per measured frame, even when
  // no box was found, so a static high-frame-rate window consumes the same frame budget as moving footage.
  const filter = shrinkFirst(opts.decoder, "192:108", "metadata=mode=delete," + activityFilterAt(opts.threshold ?? ACTIVITY_THRESHOLD) +
    ",metadata=mode=add:key=scarlet.activity:value=1,metadata=print:file='pipe\\:2'");
  const origin = opts.origin + range.start;
  const bins = new Uint32Array(192 * 108 + 1);
  const maxFrames = Math.min(8192, opts.maxFrames ?? 8192);
  let measured = 0, changed = 0, largest = 0, largestAt = 0, last = 0;
  let at = NaN, width = 0, height = 0;
  const record = () => {
    const area = width * height;
    if (!Number.isFinite(at) || !area || area >= bins.length) return;
    bins[area] = bins[area]! + 1;
    changed++;
    last = origin + at;
    if (area > largest) { largest = area; largestAt = last; }
  };
  await runCapture(resolveFfmpeg(), [...input(file, range, opts.decoder), "-loglevel", "error", "-map", "0:v:0", "-an", "-vf", filter, "-f", "null", "-"], {
    signal: opts.signal, maxStdout: 1024 * 1024, maxStderr: 4 * 1024 * 1024,
    onStderrLine(line) {
      if (line.startsWith("frame:")) {
        record();
        if (++measured > maxFrames) throw new Error("Too many pictures to analyze in one window. Choose a shorter range.");
        at = Number(line.match(/\bpts_time:\s*([-+.\deE]+)/)?.[1]);
        width = height = 0;
      } else if (line.startsWith("lavfi.bbox.w=")) width = Number(line.slice("lavfi.bbox.w=".length));
      else if (line.startsWith("lavfi.bbox.h=")) height = Number(line.slice("lavfi.bbox.h=".length));
    },
  });
  record();
  const frames = Math.max(1, Math.round((range.end - range.start) * opts.fps));
  if (!changed) return { changedFrames: 0, frames };
  let median = 1, count = 0;
  for (; median <= largest; median++) {
    count += bins[median]!;
    if (count > Math.floor(changed / 2)) break;
  }
  const share = (pixels: number) => Math.round(pixels / (192 * 108) * 10000) / 10000;
  return { changedFrames: changed, frames: Math.max(frames, changed), largestArea: share(largest), typicalArea: share(median),
    largestAt: Math.round(largestAt * 1000) / 1000, lastChangeAt: Math.round(last * 1000) / 1000 };
}

export interface InspectionEvent extends TimeRange {
  kind: "black" | "freeze" | "level-rise" | "level-drop";
  deltaDb?: number;
}

export async function qualityEvents(file: string, range: TimeRange, origin: number, signal?: AbortSignal): Promise<InspectionEvent[]> {
  const duration = range.end - range.start;
  const start = origin + range.start;
  const { stderr } = await runCapture(resolveFfmpeg(), [...input(file, range), "-map", "0:v:0", "-an",
    "-vf", `trim=duration=${duration},scale=320:-2,blackdetect=d=0,freezedetect=n=-55dB:d=0.4,metadata=print:key=lavfi.black_start,metadata=print:key=lavfi.black_end`,
    "-f", "null", "-"], { signal });
  const events: InspectionEvent[] = [];
  // An interval reaching EOF has no closing metadata frame.
  for (const kind of ["black", "freeze"] as const) {
    const pattern = kind === "black" ? /lavfi\.black_(start|end)=([\d.e+-]+)/gi
      : /lavfi\.freezedetect\.freeze_(start|end):\s*([\d.e+-]+)/gi;
    let onset: number | undefined;
    for (const m of stderr.matchAll(pattern)) {
      if (m[1] === "start") onset = Number(m[2]);
      else if (onset !== undefined) {
        events.push({ kind, start: start + onset, end: start + Number(m[2]) });
        onset = undefined;
      }
    }
    if (onset !== undefined) events.push({ kind, start: start + onset, end: start + duration });
  }
  // Compare adjacent ~80 ms RMS windows on the rendered mix. Silence is floored
  // at -60 dBFS so tiny changes in dither do not produce warnings.
  const points = Math.max(1, Math.round(duration / 0.08));
  const { rms } = await extractWaveform(file, { from: range.start, to: range.end, points, signal });
  const db = rms.map(v => 20 * Math.log10(Math.max(0.001, v)));
  for (let i = 1; i < points; i++) {
    const delta = db[i]! - db[i - 1]!;
    if (Math.abs(delta) < 12 || Math.max(db[i]!, db[i - 1]!) < -40) continue;
    const at = start + i * duration / points;
    events.push({ kind: delta > 0 ? "level-rise" : "level-drop", start: at, end: at, deltaDb: Math.round(delta) });
  }
  return events;
}

export async function audition(file: string, range: TimeRange, signal?: AbortSignal, stream = 0) {
  // A window wholly before the microphone starts or after it ends still plays for the requested duration.
  const { stdout } = await runCapture(resolveFfmpeg(), [...input(file, range), "-vn", "-map", `0:a:${stream}`,
    "-af", `${SOURCE_AUDIO_CLOCK},apad=whole_dur=${range.end - range.start}`, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], { signal, maxStdout: 1024 * 1024 });
  // Write the true length. FFmpeg cannot finalize a WAV header on a pipe.
  const h = Buffer.alloc(44);
  h.write("RIFF"); h.writeUInt32LE(36 + stdout.length, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(stdout.length, 40);
  return Buffer.concat([h, stdout]).toString("base64");
}
