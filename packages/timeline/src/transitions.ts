/**
 * Where each transition plays. A clip's `transitionIn` says how the picture moves from the clip before it on its track.
 *
 * Both clips stay as they are, sound and all; the transition adds what it needs around the join:
 * - a dip fades the outgoing picture to a colour over the half before the join and the incoming one from it after;
 * - the others play both pictures at once across the join, so each clip shows a little more of its own footage there
 *   (the incoming clip's lead-in before the join, the outgoing clip's run-on after it) as a picture-only layer, and
 *   the two move or fade over each other.
 * A transition can only use footage the sources have, so with less than half its length either side it runs shorter
 * there, and with almost none it stays a straight cut. `joins` says what each join got, for the tool to report.
 */
import { clipEnd, JOIN_SLACK, meets } from "./time.js";
import type { Clip, ColorClip, MediaClip, Timeline, Transition, TransitionDirection, TransitionType } from "./schema.js";

/** A clip's movement across one transition, in timeline seconds. */
export interface TransitionMotion {
  start: number;
  end: number;
  type: TransitionType;
  direction: TransitionDirection;
  color: string;
  /** `out` is the picture leaving, `in` the one arriving. */
  role: "out" | "in";
}

/** What one join got. */
export interface TransitionJoin {
  /** The incoming clip. */
  clipId: string;
  trackId: string;
  /** The join, in timeline seconds. */
  at: number;
  transition: Transition;
  /** The span it plays over; equal start and end when it was left a straight cut. */
  start: number;
  end: number;
  /** Why it is shorter than asked, or why it isn't there. */
  note?: string;
}

export interface TransitionPlan {
  /** The timeline with each transition's picture-only layers in place. The same object when there is no transition. */
  timeline: Timeline;
  /** Each clip's movement, by clip id (layers included). */
  motions: Map<string, TransitionMotion[]>;
  /** The layers added for transitions: picture only. */
  layers: Set<string>;
  joins: TransitionJoin[];
}

/** Suffixes of the layers a transition adds. Clip ids never contain them. */
export const LEAD_IN = "~transition-in";
export const RUN_ON = "~transition-out";

const seconds = (n: number) => `${Math.round(n * 100) / 100} s`;

type TransitionSource = { kind: string; duration?: number };

/** How much footage a clip has before its first frame and after its last, in timeline seconds. A colour has no end. */
function footage(clip: MediaClip | ColorClip, asset: TransitionSource | undefined) {
  if (clip.kind === "color") return { before: Infinity, after: Infinity };
  if (!asset || asset.kind === "image" || (asset.kind === "graphic" && !asset.duration)) return { before: Infinity, after: Infinity };
  const speed = clip.speed || 1;
  return { before: clip.sourceIn / speed, after: asset.duration ? Math.max(0, asset.duration - clip.sourceOut) / speed : 0 };
}

/** A picture-only copy of `clip` from `start` for `length` timeline seconds, `offset` seconds after the clip's own start. */
function layer(clip: MediaClip | ColorClip, id: string, start: number, length: number, offset: number): MediaClip | ColorClip {
  if (clip.kind === "color") return { ...clip, id, timelineIn: start, timelineOut: start + length, label: undefined };
  const speed = clip.speed || 1;
  const sourceIn = clip.sourceIn + offset * speed;
  return {
    ...clip, id, timelineIn: start, sourceIn, sourceOut: sourceIn + length * speed, label: undefined,
    volume: 0, audioFadeIn: 0, audioFadeOut: 0, videoFadeIn: 0, videoFadeOut: 0, transitionIn: undefined,
    // Keyframes are in the clip's own time, which the layer starts `offset` seconds into.
    keyframes: clip.keyframes?.map(k => ({ ...k, time: k.time - offset })),
  };
}

export function planTransitions(timeline: Timeline, media: ReadonlyMap<string, TransitionSource>, fps: number): TransitionPlan {
  const motions = new Map<string, TransitionMotion[]>();
  const layers = new Set<string>();
  const joins: TransitionJoin[] = [];
  const move = (id: string, m: TransitionMotion) => motions.set(id, [...motions.get(id) ?? [], m]);
  let changed = false;
  const tracks = timeline.tracks.map(track => {
    if (track.kind !== "video" || !track.clips.some(c => c.kind === "media" && c.transitionIn && c.enabled !== false)) return track;
    const before = new Map<string, Clip>();
    const after = new Map<string, Clip>();
    const clips = track.clips.filter(c => c.enabled !== false);
    // The clip a transition moves from is the picture that ends at its join, wherever it is stored: footage or a colour.
    const pictures = clips.map((c, i) => ({ c, i, end: clipEnd(c) })).filter(p => p.c.kind !== "caption").sort((a, b) => a.end - b.end);
    const endingAt = (at: number, clip: Clip) => {
      let lo = 0, hi = pictures.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (pictures[mid]!.end < at - JOIN_SLACK) lo = mid + 1; else hi = mid; }
      let found: { c: Clip; i: number } | undefined;
      for (let k = lo; k < pictures.length && meets(pictures[k]!.end, at); k++) {
        const p = pictures[k]!;
        // Of two that end there, the one drawn on top, which is the one seen.
        if (p.c !== clip && p.c.timelineIn < at - JOIN_SLACK && (!found || p.i > found.i)) found = p;
      }
      return found?.c as MediaClip | ColorClip | undefined;
    };
    for (const clip of clips) {
      if (clip.kind !== "media" || !clip.transitionIn) continue;
      const t = clip.transitionIn;
      const at = clip.timelineIn;
      const color = t.color ?? "#000000";
      const direction = t.direction ?? "left";
      const outgoing = endingAt(at, clip);
      const join = { clipId: clip.id, trackId: track.id, at, transition: t };
      const half = t.duration / 2;
      if (t.type === "dip") {
        // A dip needs no footage beyond the clips: each half fades within its own clip.
        const down = outgoing ? Math.min(half, at - outgoing.timelineIn) : 0;
        const up = Math.min(half, clipEnd(clip) - at);
        if (outgoing && down > 0) move(outgoing.id, { start: at - down, end: at, type: "dip", direction, color, role: "out" });
        if (up > 0) move(clip.id, { start: at, end: at + up, type: "dip", direction, color, role: "in" });
        joins.push({ ...join, start: at - down, end: at + up,
          note: !outgoing ? "Nothing comes before it on its track, so it only fades up from the colour." :
            down + up < t.duration - 1e-6 ? `A clip either side is shorter than half the dip, so it runs ${seconds(down + up)}.` : undefined });
        continue;
      }
      if (!outgoing) {
        joins.push({ ...join, start: at, end: at, note: "Nothing comes before it on its track to move from, so it stays a straight cut." });
        continue;
      }
      const incoming = footage(clip, media.get(clip.mediaId));
      const leaving = footage(outgoing, outgoing.kind === "media" ? media.get(outgoing.mediaId) : undefined);
      // The incoming picture starts early by its own lead-in, the outgoing one runs on with its own footage.
      const lead = Math.max(0, Math.min(half, incoming.before, at - outgoing.timelineIn));
      const run = Math.max(0, Math.min(half, leaving.after, clipEnd(clip) - at));
      if (lead + run < 2 / fps) {
        joins.push({ ...join, start: at, end: at, note: "Neither clip has footage to spare at this join, so it stays a straight cut." });
        continue;
      }
      const start = at - lead, end = at + run;
      if (lead > 0) {
        const pre = layer(clip, clip.id + LEAD_IN, start, lead, -lead);
        before.set(clip.id, pre);
        layers.add(pre.id);
        move(pre.id, { start, end, type: t.type, direction, color, role: "in" });
      }
      if (run > 0) {
        const post = layer(outgoing, outgoing.id + RUN_ON, at, run, at - outgoing.timelineIn);
        after.set(outgoing.id, post);
        layers.add(post.id);
        move(post.id, { start, end, type: t.type, direction, color, role: "out" });
      }
      move(outgoing.id, { start, end, type: t.type, direction, color, role: "out" });
      move(clip.id, { start, end, type: t.type, direction, color, role: "in" });
      const short = lead + run < t.duration - 1e-6;
      joins.push({ ...join, start, end, note: short
        ? `Only ${seconds(lead)} of the next clip's footage before the join and ${seconds(run)} of the last one's after it, so it runs ${seconds(lead + run)}.`
        : undefined });
    }
    if (!before.size && !after.size) return track;
    changed = true;
    // Bottom first: the outgoing clip, its run-on, then the incoming clip's lead-in and the clip, so the arriving
    // picture is drawn over the leaving one.
    return { ...track, clips: track.clips.flatMap(c => [before.get(c.id), c, after.get(c.id)].filter((x): x is NonNullable<typeof x> => !!x)) };
  });
  return { timeline: changed ? { ...timeline, tracks } : timeline, motions, layers, joins };
}

