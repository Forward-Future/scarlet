import type { AudioTrackSelection } from "@scarlet/timeline";

export type ResolvedAudioTrack =
  | { mode: "single"; stream: number }
  | { mode: "mix"; count: number };

/**
 * Resolve an asset or clip `audioTrack` selection against the source's audio stream count.
 * - `"all"` with more than one stream mixes every audio stream (`0:a:0`..`0:a:N-1`).
 * - A numeric index clamps into `0..streamCount-1` when the stream count is known.
 * - Absent defaults to stream `0`.
 */
export function resolveAudioTrack(
  selection: AudioTrackSelection | undefined,
  streamCount?: number,
): ResolvedAudioTrack {
  const count = streamCount && streamCount > 0 ? Math.floor(streamCount) : 1;
  if (selection === "all" && count > 1) return { mode: "mix", count };
  if (typeof selection === "number" && Number.isInteger(selection) && selection >= 0) {
    const stream = streamCount && streamCount > 0 ? Math.min(selection, count - 1) : selection;
    return { mode: "single", stream };
  }
  return { mode: "single", stream: 0 };
}

/**
 * Build an FFmpeg filter expression that mixes `count` audio streams from `inputIndex`
 * into `[outLabel]` without dividing volume by N (`normalize=0`).
 */
export function audioMixStreamsFilter(
  inputIndex: number,
  count: number,
  opts: { sampleRate?: number; channelLayout?: string; outLabel?: string; prefix?: string } = {},
): string {
  const outLabel = opts.outLabel ?? "amix_out";
  const prefix = opts.prefix ?? `asrc${inputIndex}_`;
  const aformatParts = [
    opts.sampleRate ? `sample_rates=${opts.sampleRate}` : "",
    opts.channelLayout ? `channel_layouts=${opts.channelLayout}` : "",
  ].filter(Boolean);
  const norm = [
    opts.sampleRate ? `aresample=${opts.sampleRate}:first_pts=0` : "aresample=first_pts=0",
    ...(aformatParts.length ? [`aformat=${aformatParts.join(":")}`] : []),
  ].join(",");
  const parts: string[] = [];
  const labels: string[] = [];
  for (let i = 0; i < count; i++) {
    const lbl = `[${prefix}${i}]`;
    parts.push(`[${inputIndex}:a:${i}]${norm}${lbl}`);
    labels.push(lbl);
  }
  parts.push(`${labels.join("")}amix=inputs=${count}:normalize=0:duration=longest:dropout_transition=0[${outLabel}]`);
  return parts.join(";");
}

/**
 * The audio Scarlet hears from a file: the track picked for it in Media (`audioTrack`), or every track mixed. Anything
 * that listens to a recording reads it through `audioMapArgs`, so nothing reads the first track by accident.
 */
export interface HeardAudio {
  audioTrack?: AudioTrackSelection;
  /** How many audio streams the file has, needed to mix them all. */
  audioStreamCount?: number;
}

/** What a media file's analysis hears: its chosen track, or its first. */
export function heardAudio(asset: { audioTrack?: AudioTrackSelection; audioStreams?: readonly unknown[] } | undefined): HeardAudio {
  return { audioTrack: asset?.audioTrack, audioStreamCount: asset?.audioStreams?.length };
}

/**
 * What a cache of anything heard from the file is named by. The first stream is `null`, so what was measured before a
 * track could be picked still matches; another track is its number, and every track mixed is `"all"`.
 */
export function heardAudioKey(audio: HeardAudio | undefined): number | "all" | null {
  const resolved = resolveAudioTrack(audio?.audioTrack, audio?.audioStreamCount);
  return resolved.mode === "mix" ? "all" : resolved.stream === 0 ? null : resolved.stream;
}

/**
 * FFmpeg arguments, placed after the inputs, that read input `input`'s heard audio as one stream with `filters` (an
 * `-af` chain) applied. One track is mapped by its number: left to itself FFmpeg takes the stream with the most
 * channels, which need not be the one Media calls Track 1. Every track mixed is a filter graph labelled `label`.
 */
export function audioMapArgs(audio: HeardAudio | undefined, opts: {
  input?: number; filters?: string; sampleRate?: number; channelLayout?: string; label?: string;
} = {}): string[] {
  const input = opts.input ?? 0;
  const resolved = resolveAudioTrack(audio?.audioTrack, audio?.audioStreamCount);
  if (resolved.mode === "single") return ["-map", `${input}:a:${resolved.stream}`, ...(opts.filters ? ["-af", opts.filters] : [])];
  const label = opts.label ?? "heard";
  const mixed = opts.filters ? `${label}_mix` : label;
  const mix = audioMixStreamsFilter(input, resolved.count, { sampleRate: opts.sampleRate, channelLayout: opts.channelLayout, outLabel: mixed, prefix: `${label}_` });
  return ["-filter_complex", opts.filters ? `${mix};[${mixed}]${opts.filters}[${label}]` : mix, "-map", `[${label}]`];
}
