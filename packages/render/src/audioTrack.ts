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
