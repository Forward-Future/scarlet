import { FfmpegError, failureReason, ffmpegEncoders, fnum, resolveFfmpeg, runCapture } from "./exec.js";

export type RenderQuality = "preview" | "delivery";
export type HwAccel = "none" | "auto" | "nvenc" | "qsv" | "amf" | "videotoolbox";

interface VideoFormat { width: number; height: number; fps: number }

export interface VideoEncoder {
  name: string;
  args: string[];
  pixelFormat: string;
  /** Stays compatible with older caches for encoders whose settings are unchanged. */
  cacheKey: string;
}

const hardware = {
  nvenc: "h264_nvenc", amf: "h264_amf", qsv: "h264_qsv", videotoolbox: "h264_videotoolbox",
} as const;

const encoderProbe = new Map<string, Promise<VideoEncoder | undefined>>();

function busyEncoder(error: unknown): boolean {
  if (!(error instanceof FfmpegError)) return false;
  return /out of memory|device (?:is )?busy|too many (?:concurrent )?sessions|MFX_WRN_DEVICE_BUSY|-12915\b/i.test(error.stderr) ||
    (error.stderr.includes("-12908") && /hardware encoder may be busy/i.test(error.stderr));
}

/** Probe one frame with the same size, rate and encoder arguments as the job. */
function probeEncoder(name: string, format: VideoFormat, quality: RenderQuality, bin: string, warn?: (reason: string) => void) {
  const dimensions = format.width + "x" + format.height;
  const key = [bin, name, dimensions, format.fps, quality].join("|");
  const pixelFormat = name === "h264_mf" ? "nv12" : "yuv420p";
  let promise = encoderProbe.get(key);
  if (!promise) {
    const test = async (args: string[], cacheKey: string) => {
      await runCapture(bin, ["-hide_banner", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i",
        `color=c=black:s=${dimensions}:r=${fnum(format.fps)}`, "-frames:v", "1",
        "-c:v", name, ...args, "-pix_fmt", pixelFormat, "-f", "null", "-"]);
      return { name, args, cacheKey, pixelFormat };
    };
    promise = test(encoderArgs(name, quality), name).catch((error: unknown) => {
      if (name !== "h264_videotoolbox" || !(error instanceof FfmpegError) || !/qscale not available/i.test(error.stderr)) throw error;
      // Intel VideoToolbox accepts average bitrate instead of constant quality. Scale the
      // target with the output: about 12.4 Mb/s for a 1080p30 delivery, half for a preview.
      const bitrate = Math.max(128_000, Math.round(format.width * format.height * format.fps * (quality === "delivery" ? 0.2 : 0.1)));
      return test(["-allow_sw", "0", "-b:v", String(bitrate)], name + "-" + bitrate);
    }).catch((error: unknown) => {
      // Process-start and session-limit failures can clear before the next job.
      if ((error instanceof FfmpegError && !error.started) || busyEncoder(error)) encoderProbe.delete(key);
      warn?.(`${name} could not encode a ${dimensions} frame (${failureReason(error)}).`);
      return undefined;
    });
    encoderProbe.set(key, promise);
  }
  return promise;
}

export function softwareEncoder(quality: RenderQuality): VideoEncoder {
  return { name: "libx264", cacheKey: "libx264", args: encoderArgs("libx264", quality), pixelFormat: "yuv420p" };
}

export async function resolveEncoding(hwaccel: HwAccel | undefined, ffmpegPath: string | undefined, format: VideoFormat,
  quality: RenderQuality, warn?: (reason: string) => void, exporting = quality === "delivery", failed = new Set<string>()): Promise<VideoEncoder> {
  const policy = hwaccel ?? (exporting ? "auto" : "none");
  if (policy === "none") return softwareEncoder(quality);
  const available = await ffmpegEncoders(ffmpegPath).catch((error: unknown) => {
    warn?.(`Could not list this ffmpeg's encoders (${failureReason(error)}).`);
    return new Set<string>();
  });
  const preferred = policy === "auto" ? [] : [hardware[policy]];
  const candidates = new Set<string>(preferred);
  if (policy === "auto" || exporting) {
    for (const vendor of Object.values(hardware)) candidates.add(vendor);
    // Windows drivers may expose their hardware H.264 encoder only through Media Foundation.
    if (exporting) candidates.add("h264_mf");
  }
  for (const name of candidates) {
    if (!available.has(name) || failed.has(name)) continue;
    const encoding = await probeEncoder(name, format, quality, resolveFfmpeg(ffmpegPath), warn);
    if (encoding) return encoding;
  }
  return softwareEncoder(quality);
}

/** The encoder available for this output. A named device is preferred first for delivery. */
export async function resolveVideoEncoder(hwaccel?: HwAccel, ffmpegPath?: string, size = { width: 1280, height: 720 },
  warn?: (reason: string) => void, quality: RenderQuality = "preview"): Promise<string> {
  return (await resolveEncoding(hwaccel, ffmpegPath, { ...size, fps: 30 }, quality, warn)).name;
}

/** An encoder's own diagnostic, scoped to an invocation actually encoding video. */
export function hardwareEncoderFailure(error: unknown, encoder: string): boolean {
  if (!(error instanceof FfmpegError) || !error.started || !error.args.includes(encoder) || encoder === "libx264") return false;
  return error.stderr.includes("[" + encoder + " @") ||
    error.stderr.split("\n").some(line => line.includes("/" + encoder + " @") &&
      /error while opening encoder|could not open encoder|error submitting a frame to the encoder|error encoding a frame/i.test(line)) ||
    /No capable devices found|OpenEncodeSessionEx failed/i.test(error.stderr);
}

interface RenderEncoderOptions {
  hwaccel?: HwAccel;
  ffmpegPath?: string;
  quality?: RenderQuality;
  exportHeight?: number;
  signal?: AbortSignal;
  concurrency?: number;
  onProgress?: (fraction: number) => void;
}

/** Retry an export as a whole so remuxing can never mix segments from different encoders. */
export async function withRenderEncoder<O extends RenderEncoderOptions, R extends { warnings: string[] }>(
  format: VideoFormat, opts: O, render: (attempt: O & { videoEncoder: VideoEncoder }) => Promise<R>,
): Promise<R> {
  const quality = opts.quality ?? "preview";
  const exporting = quality === "delivery" || opts.exportHeight !== undefined;
  const failed = new Set<string>();
  const warnings: string[] = [];
  const warn = (reason: string) => warnings.push(reason);
  const select = () => resolveEncoding(opts.hwaccel, opts.ffmpegPath, format, quality, warn, exporting, failed);
  opts.signal?.throwIfAborted();
  let encoding = await select();
  let concurrency = opts.concurrency;
  let progress = 0;
  const onProgress = opts.onProgress && ((fraction: number) => {
    progress = Math.max(progress, fraction);
    opts.onProgress!(progress);
  });
  for (;;) {
    opts.signal?.throwIfAborted();
    try {
      const result = await render({ ...opts, videoEncoder: encoding, concurrency, onProgress });
      result.warnings = [...warnings, ...result.warnings];
      return result;
    } catch (error) {
      if (!exporting || opts.signal?.aborted || !hardwareEncoderFailure(error, encoding.name)) throw error;
      if ((concurrency ?? 1) > 1 && busyEncoder(error)) {
        concurrency = 1;
        warn(`${encoding.name} could not open parallel sessions (${failureReason(error)}); retried the export one section at a time.`);
      } else {
        const previous = encoding.name;
        failed.add(previous);
        encoding = await select();
        concurrency = opts.concurrency;
        warn(`${previous} could not encode this export (${failureReason(error)}); retried with ${encoding.name}.`);
      }
    }
  }
}

/** Encoder-specific quality flags. */
export function encoderArgs(encoder: string, quality: RenderQuality): string[] {
  const preview = quality === "preview";
  switch (encoder) {
    case "h264_nvenc":
      return preview
        // Low-latency tuning drops B-frames and lookahead: ~30% faster, same picture at preview quality.
        ? ["-preset", "p2", "-tune", "ll", "-rc", "vbr", "-cq", "28", "-b:v", "0"]
        : ["-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", "19", "-b:v", "0", "-profile:v", "high"];
    case "h264_qsv":
      return preview ? ["-preset", "veryfast", "-global_quality", "28"] : ["-preset", "slow", "-global_quality", "20"];
    case "h264_amf":
      return preview
        ? ["-quality", "speed", "-rc", "cqp", "-qp_i", "26", "-qp_p", "26"]
        : ["-quality", "quality", "-rc", "cqp", "-qp_i", "18", "-qp_p", "18"];
    case "h264_mf":
      return ["-hw_encoding", "1", "-rate_control", "quality", "-quality", preview ? "55" : "80"];
    case "h264_videotoolbox":
      return ["-allow_sw", "0", "-q:v", preview ? "55" : "72"];
    default:
      return preview ? ["-preset", "veryfast", "-crf", "23"] : ["-preset", "slow", "-crf", "18"];
  }
}
