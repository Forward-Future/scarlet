/**
 * Handing a project to another editor: the pieces every timeline file shares. Exact frame rates and frame-counted
 * times, the footage's own timecode, the captions as a SubRip file, and the list of what another editor's app won't
 * show as Scarlet does.
 */
import type { CaptionClip, Clip, MediaAsset, MediaClip, Project, Timeline, Track } from "./schema.js";
import { frames, q, seconds, type Q } from "./rational.js";
import { captionExportHasCues } from "./captions.js";
import { clock } from "./time.js";

/** A frame rate as a fraction: `num / den` frames a second. 29.97 is 30000/1001. */
export interface ExactRate { num: number; den: number }

/** The rates editing apps make timelines at. A rate within a hair of one of these is that rate. */
const STANDARD_RATES: ExactRate[] = [
  { num: 24000, den: 1001 }, { num: 24, den: 1 }, { num: 25, den: 1 }, { num: 30000, den: 1001 }, { num: 30, den: 1 },
  { num: 48000, den: 1001 }, { num: 48, den: 1 }, { num: 50, den: 1 }, { num: 60000, den: 1001 }, { num: 60, den: 1 },
  { num: 100, den: 1 }, { num: 120000, den: 1001 }, { num: 120, den: 1 },
];

/** The standard rate nearest `fps`, and whether `fps` is that rate (a recording at 29.83 is not). */
export function exactRate(fps: number): { rate: ExactRate; standard: boolean } {
  let best = STANDARD_RATES[4]!;
  for (const rate of STANDARD_RATES) {
    if (Math.abs(rate.num / rate.den - fps) < Math.abs(best.num / best.den - fps)) best = rate;
  }
  return { rate: best, standard: Math.abs(best.num / best.den - fps) < 0.01 };
}

/** Drop-frame timecode is counted at 29.97 and 59.94 (and their doubles). */
export function isDropFrameRate(rate: ExactRate): boolean {
  return rate.den === 1001 && rate.num % 30000 === 0;
}

/** The frame number a timecode such as `01:00:00:00` (or `01:00:00;00`, drop-frame) names, at its own rate. */
export function timecodeFrames(timecode: string, rate: ExactRate): number | undefined {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})([:;.,])(\d{2,3})$/.exec(timecode.trim());
  if (!m) return;
  const [h, min, s, f] = [m[1], m[2], m[3], m[5]].map(Number) as [number, number, number, number];
  const nominal = Math.round(rate.num / rate.den);
  if (min > 59 || s > 59 || f >= nominal) return;
  const totalMinutes = h * 60 + min;
  let frames = (totalMinutes * 60 + s) * nominal + f;
  if ((m[4] === ";" || m[4] === ",") && isDropFrameRate(rate)) {
    // Two frame numbers a minute (four at 59.94) are skipped, except every tenth minute.
    const dropped = Math.round(nominal / 15);
    frames -= dropped * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return frames;
}

/** What Scarlet read off a file the hand-off copies, for the timeline files to describe it as the editor's app will. */
export interface HandoffSource {
  /** The copy's absolute `file://` URL. */
  url: string;
  /** The copy's name in the folder's Media folder. */
  fileName: string;
  /** The footage's own first-frame timecode, counted in frames at `rate`. Absent: it starts at zero. */
  timecode?: { frames: number; rate: ExactRate; dropFrame: boolean };
  /** The video's frame rate, when it has video. */
  rate?: ExactRate;
  width?: number;
  height?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  audioChannels?: number;
  audioRate?: number;
  /** Separate audio streams in the file. Scarlet plays the first. */
  audioStreams?: number;
  /** Seconds of footage. */
  duration: number;
  /** A still image. */
  still?: boolean;
}

/** The footage's first frame, exactly: where another editor's app counts its source times from. */
export function sourceStartQ(source: HandoffSource | undefined): Q {
  const tc = source?.timecode;
  return tc ? frames(tc.frames, tc.rate) : q(0);
}

/** The footage's first frame in seconds. */
export function sourceStart(source: HandoffSource | undefined): number {
  return seconds(sourceStartQ(source));
}

/** Names Windows keeps for devices, whatever extension follows them. */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/** As a file system compares names: without case, and on macOS without regard to how the letters are composed. */
const fileNameKey = (name: string): string => name.normalize("NFC").toLowerCase();

/** File names that are safe on macOS and Windows, unique within the folder. */
export function handoffFileNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map(raw => {
    // Windows drops trailing dots and spaces, so a name ending in them would not be the one the timeline names.
    let clean = raw.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").replace(/[. ]+$/, "") || "Media";
    const first = clean.indexOf(".");
    const base = first > 0 ? clean.slice(0, first) : clean;
    if (RESERVED.test(base.trim())) clean = `${base.trim()}_${first > 0 ? clean.slice(first) : ""}`;
    const dot = clean.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ""];
    let name = clean;
    for (let n = 2; used.has(fileNameKey(name)); n++) name = `${stem} ${n}${ext}`;
    used.add(fileNameKey(name));
    return name;
  });
}

/** Media the timeline plays, in the order it first appears. */
export function usedMedia(project: Project, timeline: Timeline): MediaAsset[] {
  const byId = new Map(project.media.map(m => [m.id, m]));
  const seen = new Map<string, MediaAsset>();
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== "media" || seen.has(clip.mediaId)) continue;
      const asset = byId.get(clip.mediaId);
      if (asset) seen.set(clip.mediaId, asset);
    }
  }
  return [...seen.values()];
}

/** Caption tracks with something to say, as the editor sees them. */
export function captionTracks(timeline: Timeline): Array<{ track: Track; cues: CaptionClip[] }> {
  return timeline.tracks.filter(t => t.kind === "caption" && !t.hidden).map(track => ({
    track,
    cues: track.clips
      .filter((c): c is CaptionClip => c.kind === "caption" && c.enabled !== false && !!c.text.trim())
      .sort((a, b) => a.timelineIn - b.timelineIn),
  })).filter(t => t.cues.length && captionExportHasCues(timeline, { trackId: t.track.id }));
}

/** Something another editor's app won't show as Scarlet does, and where. */
export interface HandoffLoss { at?: number; what: string }

const EFFECT_NAMES: Record<string, string> = {
  blur: "Blur", brightness: "Brightness", contrast: "Contrast", saturation: "Saturation", color: "Color adjustment",
  sharpen: "Sharpen", lut: "LUT", denoise: "Noise reduction", expander: "Expander", eq: "EQ", compressor: "Compressor",
  limiter: "Limiter", loudnorm: "Loudness",
};

function clipName(clip: MediaClip, media: Map<string, MediaAsset>) {
  return clip.label || media.get(clip.mediaId)?.name || "a clip";
}

/**
 * What the timeline files can't carry: transitions, effects, rounded corners, eased zooms, caption styling and
 * recordings with several audio streams. The editor reads this before they finish the edit.
 */
export function handoffLosses(project: Project, timeline: Timeline, sources?: Map<string, HandoffSource>): HandoffLoss[] {
  const media = new Map(project.media.map(m => [m.id, m]));
  const losses: HandoffLoss[] = [];
  const clips: Array<{ track: Track; clip: Clip }> = timeline.tracks.flatMap(track => track.clips.map(clip => ({ track, clip })));
  for (const { track, clip } of clips) {
    if (clip.kind !== "media" || clip.enabled === false) continue;
    const name = clipName(clip, media);
    // Neither timeline file carries Scarlet's transitions: each join comes in as a straight cut.
    if (clip.transitionIn && track.kind === "video" && !track.hidden) {
      losses.push({ at: clip.timelineIn, what: `The ${clip.transitionIn.type} into “${name}” (it comes in as a straight cut)` });
    }
    for (const effect of clip.effects.filter(e => e.enabled !== false)) {
      losses.push({ at: clip.timelineIn, what: `${EFFECT_NAMES[effect.type] ?? effect.type} on “${name}”` });
    }
    if (clip.transform?.cornerRadius) losses.push({ at: clip.timelineIn, what: `Rounded corners on “${name}”` });
    if (clip.keyframes?.some(k => k.ease !== "linear")) {
      losses.push({ at: clip.timelineIn, what: `The easing of the move on “${name}” (it moves at an even pace)` });
    }
  }
  if (captionTracks(timeline).length) {
    const styled = timeline.captionStyle || timeline.tracks.some(t => t.kind === "caption" && (t.captionStyle ||
      t.clips.some(c => c.kind === "caption" && (c.style || c.words?.length))));
    losses.push({ what: `How the captions look${styled ? ", and their word highlighting" : ""}: they come in as plain text` });
  }
  for (const asset of usedMedia(project, timeline)) {
    const streams = sources?.get(asset.id)?.audioStreams ?? 0;
    if (streams > 1) losses.push({ what: `“${asset.name}” has ${streams} audio streams. Scarlet plays the first; check which are on` });
  }
  if (!/^#?0{6}(ff)?$|^black$/i.test(timeline.background)) losses.push({ what: `The ${timeline.background} background behind the picture` });
  return losses.sort((a, b) => (a.at ?? -1) - (b.at ?? -1));
}

/** Frame-rate trouble worth saying: a project or recording at a rate no editing app makes timelines at. */
export function handoffRateWarnings(project: Project, timeline: Timeline, sources: Map<string, HandoffSource>): string[] {
  const warnings: string[] = [];
  const project_ = exactRate(project.settings.fps);
  if (!project_.standard) {
    const r = project_.rate;
    warnings.push(`The project runs at ${Number(project.settings.fps.toFixed(3))} fps. The timeline is made at ${Number((r.num / r.den).toFixed(3))} fps, the nearest standard rate.`);
  }
  for (const asset of usedMedia(project, timeline)) {
    if (asset.kind !== "video" || !asset.fps) continue;
    if (!exactRate(asset.fps).standard) {
      warnings.push(`“${sources.get(asset.id)?.fileName ?? asset.name}” plays at ${Number(asset.fps.toFixed(3))} fps, which suggests a variable frame rate (phones and screen recordings). If its sound drifts out of sync, convert it to a constant frame rate.`);
    }
  }
  return warnings;
}

export interface ReadMeInput {
  projectName: string;
  timelineFiles: { fcpxml: string; otio: string };
  captionFiles: string[];
  losses: HandoffLoss[];
  warnings: string[];
}

/** The folder's Read me: how to open it in each app, and what didn't carry over. */
export function handoffReadMe(input: ReadMeInput): string {
  const lines = [
    `${input.projectName}`,
    "Exported from Scarlet to finish the edit in another app.",
    "",
    "DaVinci Resolve",
    `  File > Import > Timeline…, then choose ${input.timelineFiles.fcpxml}.`,
    "  Leave “Automatically import source clips into media pool” on.",
    `  If anything comes in wrong, try ${input.timelineFiles.otio} the same way.`,
    ...(input.captionFiles.length ? ["  Captions: in the Media Pool, right-click > Import Subtitle…, then drag the file onto the timeline."] : []),
    "",
    "Final Cut Pro",
    `  File > Import > XML…, then choose ${input.timelineFiles.fcpxml}.`,
    "",
    "Premiere Pro (26.5 or later)",
    `  File > Import…, then choose ${input.timelineFiles.otio}. Premiere brings in the cuts, tracks and speed changes, not the zooms or volume.`,
    ...(input.captionFiles.length ? ["  Captions: File > Import… the .srt file, then drag it onto the timeline."] : []),
    "",
    "The footage is in the Media folder. If you move this folder and an app can't find a clip, relink it to the Media folder: the files keep their names.",
  ];
  if (input.captionFiles.length) lines.push("", `Captions: ${input.captionFiles.join(", ")}`);
  if (input.warnings.length) lines.push("", "Check", ...input.warnings.map(w => `  ${w}`));
  if (input.losses.length) {
    lines.push("", "What doesn't carry over", ...input.losses.map(l => `  ${l.at !== undefined ? `${clock(l.at)}  ` : ""}${l.what}`));
  }
  return `${lines.join("\n")}\n`;
}
