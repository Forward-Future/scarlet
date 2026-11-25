/**
 * Picture colour a file declares: HDR, which every picture Scarlet makes from it tone-maps to ordinary SDR, and camera
 * Log, which is reported and left as shot. HDR on a normal screen is a matter of correctness, so code does it; how a
 * flat Log picture should look is taste, so that stays the model's choice (the `lut` effect).
 */
import { ffmpegFilters } from "./exec.js";

/** HDR transfers: HLG (iPhone, most phones and broadcast) and PQ (HDR10, Dolby Vision's base layer). */
export type HdrTransfer = "hlg" | "pq";

/** What a file says about its picture's colour. Absent fields: the file doesn't say, or says ordinary BT.709. */
export interface PictureColor {
  /** An HDR transfer. Scarlet tone-maps it to BT.709 SDR wherever it makes a picture from the file. */
  hdr?: HdrTransfer;
  /** A camera Log curve the file names, as named ("Apple Log", "S-Log3"). The picture is flat until a look is applied. */
  log?: string;
  /** The file's colour tags as ffprobe names them, when they aren't BT.709 or unset. */
  primaries?: string;
  transfer?: string;
  /** Bits per sample, when above 8. */
  bitDepth?: number;
}

interface ColorStream {
  color_primaries?: string;
  color_transfer?: string;
  pix_fmt?: string;
  bits_per_raw_sample?: string;
  tags?: Record<string, string | undefined>;
  side_data_list?: Array<{ side_data_type?: string }>;
}

const PLAIN = new Set(["bt709", "unknown", "unspecified", "reserved", ""]);

/** Camera Log curves by the names their files use, written together or with a hyphen or underscore ("S-Log3", "SLog3"). */
const LOG_NAMES: Array<[RegExp, string]> = [
  [/\bapple[\s_-]?log\b/i, "Apple Log"],
  [/\bs[_-]?log[_-]?3\b/i, "S-Log3"],
  [/\bs[_-]?log[_-]?2\b/i, "S-Log2"],
  [/\bs[_-]?log\b/i, "S-Log"],
  // A separator is needed here: "vlog" alone is also the word for a video blog, as in a downloaded clip's title.
  [/\bv[_-]log\b/i, "V-Log"],
  [/\bc[_-]?log[_-]?3\b/i, "C-Log3"],
  [/\bc[_-]?log[_-]?2\b/i, "C-Log2"],
  [/\bc[_-]?log\b/i, "C-Log"],
  [/\bn[_-]?log\b/i, "N-Log"],
  [/\bf[_-]?log[_-]?2\b/i, "F-Log2"],
  [/\bf[_-]?log\b/i, "F-Log"],
  [/\blog[_-]?c[_-]?4\b/i, "LogC4"],
  [/\blog[_-]?c\b/i, "LogC"],
  [/\bd[_-]?log\b/i, "D-Log"],
  [/\bred[_-]?log(?:3g10|film)?\b/i, "RED Log"],
];

function logName(texts: string[]): string | undefined {
  for (const text of texts) for (const [pattern, name] of LOG_NAMES) if (pattern.test(text)) return name;
  return undefined;
}

/**
 * The colour a video stream declares, from its ffprobe tags. `undefined` for a picture with nothing to report: BT.709
 * or untagged, 8-bit, no Log. HDR comes only from the transfer tag (HLG `arib-std-b67`, PQ `smpte2084`); Log from the
 * transfer (`log100`, `log316`) or a camera's name for its curve in the stream's or the file's metadata, where ffprobe
 * shows it. A camera that writes its curve only in a sidecar or its own XML box isn't seen.
 */
export function pictureColorOf(stream: ColorStream | undefined, formatTags?: Record<string, string | undefined>): PictureColor | undefined {
  if (!stream) return undefined;
  const transfer = stream.color_transfer ?? "";
  const primaries = stream.color_primaries ?? "";
  const hdr: HdrTransfer | undefined = transfer === "arib-std-b67" ? "hlg" : transfer === "smpte2084" ? "pq" : undefined;
  const tagText = [stream.tags, formatTags].flatMap(tags => Object.entries(tags ?? {}).map(([k, v]) => `${k} ${v ?? ""}`));
  // FFmpeg 8 names Panasonic's curve as a transfer ("vlog"); its generic log curves are "log100" and "log316".
  const log = (transfer === "vlog" ? "V-Log" : logName([transfer, ...tagText])) ?? (/^log(100|316)$/.test(transfer) ? `Log (${transfer})` : undefined);
  const bits = Number(stream.bits_per_raw_sample) || Number(/p(\d{2})(?:le|be)$/.exec(stream.pix_fmt ?? "")?.[1]) || 8;
  const color: PictureColor = {
    ...(hdr && { hdr }),
    ...(log && { log }),
    ...(!PLAIN.has(primaries) && { primaries }),
    ...(!PLAIN.has(transfer) && { transfer }),
    ...(bits > 8 && { bitDepth: bits }),
  };
  return Object.keys(color).length ? color : undefined;
}

/** Bumped when the tone-mapping changes, so pictures cached from an HDR file are made again. */
export const TONE_MAP_REVISION = 1;

/**
 * Filters that turn an HDR picture into BT.709 SDR for a normal screen: to linear light with SDR's 100-nit white at 1.0,
 * onto BT.709 primaries, Möbius tone-mapping, which keeps the picture's middle as it is and rolls everything brighter
 * (HDR's 203-nit reference white and the highlights above it) into range, then BT.709's curve in limited-range 4:2:0.
 * On test footage it came closest to the SDR picture the HDR was made from, of Hable, Reinhard and Möbius at 100 and
 * 203 nits: average and peak levels within 4%, where the untreated HLG read as BT.709 kept a third of the saturation.
 * zimg (`zscale`) does the colour maths on the CPU. The bundled builds have no GPU tone-mapper (no libplacebo, and no
 * VideoToolbox or CUDA one), so hardware decoding still runs first where it is in use and hands the frames over. A
 * build without zscale gets FFmpeg's own `colorspace`, which converts BT.2020's matrix to BT.709 but can't read an HDR
 * curve, so the picture stays flat. Nothing for an SDR picture, which reaches the graph exactly as before.
 */
export async function toneMapFilters(hdr: HdrTransfer | undefined, ffmpegPath?: string): Promise<string[]> {
  if (!hdr) return [];
  return toneMapChain(hdr, await canZscale(ffmpegPath));
}

/** `toneMapFilters` once it is known whether this build has zscale and tonemap. */
export function toneMapChain(hdr: HdrTransfer | undefined, zscale: boolean): string[] {
  if (!hdr) return [];
  if (!zscale) return ["colorspace=all=bt709:iall=bt2020:range=tv:format=yuv420p:fast=1"];
  const transfer = hdr === "hlg" ? "arib-std-b67" : "smpte2084";
  return [
    `zscale=tin=${transfer}:pin=bt2020:min=bt2020nc:t=linear:npl=100`,
    "format=gbrpf32le",
    "zscale=p=bt709",
    "tonemap=tonemap=mobius:desat=0",
    "zscale=t=bt709:m=bt709:r=tv",
    "format=yuv420p",
  ];
}

/** Whether this ffmpeg has zimg's `zscale` and `tonemap`. A build that can't be asked counts as having them. */
export async function canZscale(ffmpegPath?: string): Promise<boolean> {
  try {
    const filters = await ffmpegFilters(ffmpegPath);
    return filters.size === 0 || (filters.has("zscale") && filters.has("tonemap"));
  } catch { return true; }
}
