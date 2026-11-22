import { AREA_SLACK, areaAt, type AreaBox, type AreaSide, type HeldArea } from "@scarlet/shared";
import { clipEnd, Transform as TransformSchema, type MediaAsset, type MediaClip, type Timeline } from "@scarlet/timeline";
import { pct1, round3 } from "./analysis.js";
import { clipFramingKey, isClipFramed, pictureBox, type Box } from "./framing.js";

/** What the engine knows of a recording's areas (`GET …/show-area`). */
export interface RecordingAreas { done: boolean; areas: HeldArea[]; unset: Array<[number, number]> }

/** Clips in a row that this edit framed so they show past the area viewers may see. */
export interface ShownOutside {
  mediaId: string;
  /** Timeline seconds, over the clips in a row with the same finding. */
  from: number; to: number;
  clipId: string; clips: number;
  /** The source second it was read at, the area that holds there and what the clip shows, in percent of the source. */
  source: number; area: number[]; shows: number[];
  /** How far past the area the clip shows, by side, in percent of the source. */
  beyond: Partial<Record<AreaSide, number>>;
}
/** Footage this edit framed on part of its picture where no area says what may show. */
export interface NoAreaSet {
  mediaId: string;
  /** Source seconds with no area, each stretch with a second to look at, and the timeline second it first plays. */
  from: number; to: number; look: number; at: number;
}
export interface ShowAreaFindings { outside: ShownOutside[]; noArea: NoAreaSet[]; notRead: string[] }

const SIDES: readonly AreaSide[] = ["left", "top", "right", "bottom"];
const pct = pct1;
const r3 = round3;
const framed = isClipFramed;
const framing = clipFramingKey;

/** The part of its source a clip puts on the video at `local` seconds from its start, as fractions of the source; null when none shows or it is turned. */
export function sourceShown(clip: MediaClip, local: number, source: { width: number; height: number }, canvas: { width: number; height: number }): Box | null {
  const base = TransformSchema.parse(clip.transform ?? {});
  if (base.rotation) return null;
  const [l, t, r, b] = pictureBox(clip, local, source, canvas);
  const x0 = Math.max(0, l), y0 = Math.max(0, t), x1 = Math.min(1, r), y1 = Math.min(1, b);
  if (x1 <= x0 || y1 <= y0) return null;
  const cl = base.cropLeft, ct = base.cropTop, cw = Math.max(0.01, 1 - base.cropLeft - base.cropRight), ch = Math.max(0.01, 1 - base.cropTop - base.cropBottom);
  const across = (at: number) => cl + (at - l) / (r - l) * cw, down = (at: number) => ct + (at - t) / (b - t) * ch;
  return [across(x0), down(y0), across(x1), down(y1)];
}

/**
 * Where the clips an edit framed show past the area viewers may see, and where they show part of a picture no area has
 * been given for. Read from each video clip the edit added framed or whose framing it changed, at its start, middle,
 * end and keyframes, unless another picture fills the video over it there. A clip that shows its whole picture needs
 * no area; one that shows a part does, since choosing the part is choosing what viewers see.
 */
export function showAreaFindings(before: Timeline | null, after: Timeline, media: readonly MediaAsset[], canvas: { width: number; height: number },
  areasFor: (mediaId: string) => RecordingAreas | undefined): ShowAreaFindings {
  const was = new Map(before?.tracks.flatMap(t => t.clips.map(c => [c.id, c] as const)) ?? []);
  const assets = new Map(media.map(m => [m.id, m]));
  const tracks = after.tracks.filter(track => track.kind === "video" && !track.hidden);
  const layers = tracks.map(track => track.clips.filter((c): c is MediaClip => c.kind === "media" && c.enabled !== false && c.opacity > 0 && assets.get(c.mediaId)?.kind === "video"));
  const size = (clip: MediaClip) => ({ width: assets.get(clip.mediaId)!.width || canvas.width, height: assets.get(clip.mediaId)!.height || canvas.height });
  const findings: ShowAreaFindings = { outside: [], noArea: [], notRead: [] };
  const noArea = new Map<string, NoAreaSet>();
  layers.forEach((clips, layer) => {
    let last: ShownOutside | undefined;
    for (const clip of [...clips].sort((a, b) => a.timelineIn - b.timelineIn)) {
      const old = was.get(clip.id);
      if (!framed(clip) || (old?.kind === "media" && framing(old) === framing(clip))) continue;
      const known = areasFor(clip.mediaId);
      const length = clipEnd(clip) - clip.timelineIn, speed = clip.speed ?? 1, edge = Math.min(0.05, length / 4);
      const locals = [...new Set([edge, length / 2, length - edge, ...(clip.keyframes ?? []).map(k => k.time).filter(k => k > 0 && k < length)])];
      let worst: ShownOutside | undefined;
      for (const local of locals) {
        const at = clip.timelineIn + local;
        // A picture over this one that fills the video hides it there.
        if (layers.slice(layer + 1).some(above => above.some(c => c.timelineIn <= at && at < clipEnd(c) && (() => { const [l, t, r, b] = pictureBox(c, at - c.timelineIn, size(c), canvas); return l <= 0.01 && t <= 0.01 && r >= 0.99 && b >= 0.99; })()))) continue;
        const shows = sourceShown(clip, local, size(clip), canvas);
        if (!shows) continue;
        const source = clip.sourceIn + local * speed;
        const part = shows[0] > 0.01 || shows[1] > 0.01 || shows[2] < 0.99 || shows[3] < 0.99;
        if (!known?.done) { if (part && known && !findings.notRead.includes(clip.mediaId)) findings.notRead.push(clip.mediaId); continue; }
        const held = areaAt(known.areas, source);
        if (!held) {
          if (!part) continue;
          const stretch = known.unset.find(([from, to]) => source >= from - 1e-6 && source < to + 1e-6) ?? [0, assets.get(clip.mediaId)?.duration ?? source];
          // One look for every five minutes of a long stretch: a recording with no area yet is one stretch, and its windows change.
          const key = `${clip.mediaId}:${stretch[0]}:${Math.floor(source / 300)}`;
          if (!noArea.has(key)) noArea.set(key, { mediaId: clip.mediaId, from: r3(stretch[0]), to: r3(stretch[1]), look: r3(source), at: r3(at) });
          continue;
        }
        const area: AreaBox = held.area;
        const over = [area[0] - shows[0], area[1] - shows[1], shows[2] - area[2], shows[3] - area[3]];
        const beyond: Partial<Record<AreaSide, number>> = {};
        SIDES.forEach((side, i) => { if (over[i]! > AREA_SLACK) beyond[side] = pct(over[i]!); });
        const most = Math.max(0, ...Object.values(beyond));
        if (most && (!worst || most > Math.max(...Object.values(worst.beyond)))) {
          worst = { mediaId: clip.mediaId, from: r3(clip.timelineIn), to: r3(clipEnd(clip)), clipId: clip.id, clips: 1, source: r3(source), area: area.map(pct), shows: shows.map(pct), beyond };
        }
      }
      if (!worst) { last = undefined; continue; }
      if (last && last.mediaId === worst.mediaId && Math.abs(last.to - worst.from) < 0.05 && JSON.stringify(last.area) === JSON.stringify(worst.area) && JSON.stringify(Object.keys(last.beyond)) === JSON.stringify(Object.keys(worst.beyond))) {
        last.to = worst.to; last.clips++;
        if (Math.max(...Object.values(worst.beyond)) > Math.max(...Object.values(last.beyond))) Object.assign(last, { source: worst.source, shows: worst.shows, beyond: worst.beyond });
      } else findings.outside.push(last = worst);
    }
  });
  findings.outside.sort((a, b) => a.from - b.from);
  findings.noArea = [...noArea.values()].sort((a, b) => a.at - b.at);
  return findings;
}

/** The refusal an edit gets when it shows past an area or frames footage with none. Names everything at once. */
export function showAreaRefusal(found: ShowAreaFindings): string | undefined {
  if (!found.outside.length && !found.noArea.length) return undefined;
  const parts: string[] = ["Not saved."];
  if (found.outside.length) {
    const rows = found.outside.slice(0, 20).map(o => `${o.from}-${o.to} s (${o.clips} clip${o.clips === 1 ? "" : "s"} from ${o.clipId}, ${o.mediaId} at source ${o.source} s): shows [${o.shows.join(", ")}], area [${o.area.join(", ")}], past it ${Object.entries(o.beyond).map(([side, n]) => `${side} ${n}%`).join(", ")}`);
    parts.push(`This edit frames footage so it shows past the area of the recording viewers may see (screen_area), in percent of the source as [left, top, right, bottom]:\n${rows.join("\n")}${found.outside.length > 20 ? `\n…and ${found.outside.length - 20} more stretches.` : ""}\nFrame each inside its area: timeline_framing keeps a frame inside it when it can. If the area is wrong for that footage, give the right one with screen_area and save again.`);
  }
  if (found.noArea.length) {
    const rows = found.noArea.slice(0, 20).map(n => `${n.mediaId} source ${n.from}-${n.to} s (plays from ${n.at} s; look at source ${n.look} s)`);
    parts.push(`This edit frames footage on part of its picture where no area says what viewers may see:\n${rows.join("\n")}${found.noArea.length > 20 ? `\n…and ${found.noArea.length - 20} more stretches.` : ""}\nLook at a frame of each stretch and give its area with screen_area (the whole picture, [0, 0, 100, 100], when all of it may show), then save again. One area holds for as long as that window stays where it is.`);
  }
  return parts.join("\n\n");
}
