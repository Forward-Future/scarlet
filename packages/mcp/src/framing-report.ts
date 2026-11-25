/**
 * What an edit's framing of a recording shows, stretch by stretch, read back from the clips it wrote.
 *
 * timeline_framing places a frame and says what it hides, but a run can frame every demo in one bulk timeline_propose
 * with transforms of its own, and then nothing it reads back says what the viewer sees. A pass did that (2026-11-17):
 * its frame on a demo cropped the page's title and buttons, it moved the picture down for a large cube and back up for
 * the scramble, and when a later save took the move down out, the move back up stayed, starting on a jump cut while
 * the cube was still large. This reports, for each stretch an edit framed, where the frame holds and where it moves,
 * and what of the text the speaker reads aloud there the frame leaves out or a picture over it covers.
 *
 * A save that only turns a screen recording on over the camera, unframed, decides where the screen comes and goes as
 * much as a framing does. A pass showed a post's video only up to the jump cut before the speaker's reaction to it, “I
 * think this looks incredible … I am surprised it's not real”, with the video still playing on the recording and the
 * speaker looking at it (2026-11-20). That save switched clips on and framed none, so it heard nothing of the time
 * beside its stretches. A silent recording shown over the main picture is reported too, where the edit turns it on or
 * moves its edges.
 */
import { SMALL_TEXT_PERCENT } from "@scarlet/shared";
import { clipEnd, sourceToTimeline, type MediaAsset, type MediaClip, type Timeline } from "@scarlet/timeline";
import { pct1, round2 } from "./analysis.js";
import { CORNERS, boxArea, boxInCorner, boxMeet, clipFramingKey, coverOnText, frameShown, pictureBox, type Box, type Corner } from "./framing.js";
import { CUT_SHOWN, cutShareOf, sourceOnScreen, type RecordingCut } from "./brief-pictures.js";
import { readingsAt, type ScreenLine, type ScreenReading } from "./screen-reading.js";
import { DETAIL_COLS, DETAIL_ROWS, SMALL, detailAreas, detailShare, type DetailFrame, type MotionSecond, type MotionSpan } from "./screen-motion.js";

interface Size { width: number; height: number }

export interface FramedStretch {
  mediaId: string; trackId: string;
  /** Timeline seconds the stretch covers, over the clips in a row the edit framed or put on picture over another. */
  from: number; to: number;
  clips: number;
  /** Where the frame stands still: the area of the source picture that fills the video, in percent; empty where the picture doesn't fill the video, as a recording of another shape shown whole doesn't. */
  holds: Array<FrameHold>;
  /** Where it moves from one frame to the next. `onCut` when the move starts on a cut in the picture. `screenChanged` when a gliding move runs across a change to a new screen, page or demo (`screenChangeAt` names that timeline second). `zoom` is how much larger the picture gets, in percent (less than 0 when it gets smaller), and `shift` how far the frame's centre goes, in percent of the frame it leaves. */
  moves: Array<{ from: number; to: number; fromFrame: number[]; toFrame: number[]; onCut?: true; screenChanged?: true; screenChangeAt?: number; zoom?: number; shift?: number }>;
  /** Readings aloud (screen_reading) in the stretch whose lines the frame leaves out or a picture over it covers. */
  readsHidden?: Array<{ from: number; to: number; said: string; box: number[]; outsideFrame?: number; underCover?: number }>;
  /** Areas where the picture keeps changing (screen_motion) in the stretch that the frame leaves out or a picture over it covers. */
  actionHidden?: Array<{ from: number; to: number; box: number[]; outsideFrame?: number; underCover?: number }>;
  /** The video after the stretch, with the recording off picture, while the recording goes on showing what the frame showed last. */
  shownAfter?: ShownBeside;
  /** The video before the stretch, with the recording off picture, while the recording already showed what the frame shows first. */
  shownBefore?: ShownBeside;
}

export interface FrameHold {
  from: number; to: number; frame: number[];
  /** Lines of the recording's text (screen_text) the frame shows that a picture over it, such as a camera inset, sits on while it holds, up to five. */
  underCover?: string[];
  underCoverMore?: number;
  /** With text under a cover: the corners where the covers, at their size and margins, would sit on none of the frame's text. */
  cornersClearOfText?: Corner[];
  /** Things in the recording the frame shows (text, lines, pictures: cells of its picture that aren't flat background, touching) that a picture over it hides while it holds: each one's box in percent of the source, and the percent of it hidden. Up to five, most hidden first. */
  coverHides?: Array<{ box: number[]; hidden: number }>;
  coverHidesMore?: number;
  /** With something hidden: the percent of the picture over it that sits on such things in each corner, at its size and margins, at most while it holds. */
  detailInCorners?: Partial<Record<Corner, number>>;
  /** Lines of the recording's text cut through by an edge of this frame (mid-word at the sides or sliced across top/bottom). */
  clippedText?: { sides: Array<"left" | "right" | "top" | "bottom">; lines: string[]; more?: number };
  /** Text in this frame whose usual line height is below the readability threshold, in percent and pixels of the video height. */
  smallText?: { heightPct: number; heightPx: number; videoHeight: number; lines: number; sample: string[]; readHeightPct?: number; readSaid?: string };
  /** Sub-stretches of this hold where the framed picture shows almost nothing (blank canvas or loading placeholder). */
  blank?: Array<{ from: number; to: number; detailPct: number; showing?: string[] }>;
  /** Video player timestamp controls (such as "0:02 / 0:14") still visible inside the framed picture. */
  playerControls?: string[];
}

/** Time of the video beside a framed stretch, with its recording off picture, while the recording shows what the frame did at that edge. */
export interface ShownBeside {
  /** Timeline seconds. */
  from: number; to: number;
  /** Lines of the recording's text in the frame at the edge that stay for at least half of it, longest first, up to three. */
  showing?: string[];
  /** Nothing in the frame's area of the recording changes over it. */
  unchanged?: true;
  /**
   * Nothing anywhere in the recording's picture changes over it, the pointer included: a page left still, or a capture
   * that stopped while the speaker went on (2026-11-21: a screen recording held one frame for 93 s while the presenter
   * worked a demo it never caught, and the pass asked only whether to show the demo).
   */
  stillEverywhere?: true;
  /** The words heard over it. */
  said?: string;
  /** Passages of the recording's text read aloud over it, word for word, while it is off picture. */
  reads?: Array<{ from: number; to: number; said: string }>;
  /** How far the speaker's eyes look down over it, in the picture of the recording whose sound plays there: 0 level or up, 1 fully down. */
  eyesDown?: number;
  /** Where to see the speaker's face midway through it: that recording, its source second and the area round the face, in percent of its picture. */
  look?: { mediaId: string; at: number; area: number[] };
}

/** What recordings show while off picture, and what is said, for the time beside each stretch. */
export interface BesideEvidence {
  /** Each recording's text on screen, in source seconds (screen_text), over the framed stretches and beside them. */
  lines: ReadonlyMap<string, readonly ScreenLine[]>;
  /** Each recording's seconds whose picture changed, in source seconds (screen_motion). */
  seconds: ReadonlyMap<string, readonly MotionSecond[]>;
  /** The recordings whose picture's changes are read through over the time asked: only there does no change mean a still picture. */
  motionRead?: ReadonlySet<string>;
  /** Where each recording's picture has something in it, in source seconds (screen_motion's detail). */
  detail?: ReadonlyMap<string, readonly DetailFrame[]>;
  /** Each recording's cuts, in source seconds (`/picture-cuts`): what it shows ends at one that changes enough of the frame. */
  cuts?: ReadonlyMap<string, readonly RecordingCut[]>;
  /** The words heard on the timeline. */
  words: ReadonlyArray<{ text: string; start: number; end: number }>;
  /** Where the speaker's eyes look in each recording whose sound plays beside a stretch, in source seconds (`faces`' spans of its main face). */
  eyes?: ReadonlyMap<string, ReadonlyArray<{ start: number; end: number; eyesDown?: number; box?: readonly number[] }>>;
}

/** Frames are compared this often along a stretch. */
const STEP = 0.1;
/** What a cover sits on is looked at this often along a hold. */
const TEXT_STEP = 0.5;
/** A frame within this of the last, in fractions of the picture, holds. */
const STILL = 0.002;
/** A share of a reading's lines hidden below this goes unreported. */
const HIDDEN = 0.05;
/** A share of a changing area hidden below this goes unreported: the edge of a large change is often a shadow or a border. */
const ACTION_HIDDEN = 0.1;
/** The video beside a stretch is looked along in steps this long, as far as this. */
const BESIDE_STEP = 0.5;
export const BESIDE_MAX = 60;

const pct = (b: readonly number[]) => b.map(pct1);
const r2 = round2;
const framing = clipFramingKey;
const area = boxArea;
/** A silent picture above the main one that covers at least this share of the video is shown in its place, as a screen recording over the camera is; a camera inset isn't. */
const STANDS_IN = 0.5;
const meet = boxMeet;
/** Text that names a waiting/loading placeholder when little else is on screen. */
const LOADING_TEXT = /\b(loading|please wait|initializing|connecting|buffering|starting|preparing)\b/i;
/** Embedded video player timestamp controls ("0:02 / 0:14", "0:54 / 0:54") visible inside a framed screen. */
const PLAYER_CLOCK = /^\s*\d{1,2}:\d{2}\s*\/\s*\d{1,2}:\d{2}\s*$/;

/** Share of cells in `box` (source fractions) whose detail bit differs between two 64×36 detail grids. */
function detailDiffShare(a: Uint8Array, b: Uint8Array, box: readonly number[]): number {
  const c0 = Math.max(0, Math.floor(box[0]! * DETAIL_COLS)), c1 = Math.min(DETAIL_COLS, Math.ceil(box[2]! * DETAIL_COLS));
  const r0 = Math.max(0, Math.floor(box[1]! * DETAIL_ROWS)), r1 = Math.min(DETAIL_ROWS, Math.ceil(box[3]! * DETAIL_ROWS));
  let all = 0, diff = 0;
  for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) {
    all++;
    const i = r * DETAIL_COLS + c;
    if (((a[i >> 3]! >> (i & 7)) & 1) !== ((b[i >> 3]! >> (i & 7)) & 1)) diff++;
  }
  return all ? diff / all : 0;
}

/**
 * Whether a gliding move (`to > from + 0.05`) runs across a moment where the screen itself changes to something new:
 * a recording cut inside a clip during/right before the move, or a clip jump cut in the run across which the recording
 * cut or changed its page/detail. Straight cuts (`over === 0`) are not moves and return undefined.
 */
export function moveCrossesScreenChange(
  run: readonly MediaClip[],
  from: number,
  to: number,
  fromBox: Box,
  toBox: Box,
  evidence?: { cuts?: readonly RecordingCut[]; lines?: readonly ScreenLine[]; detail?: ReadonlyArray<{ at: number; cells: Uint8Array }> },
): { at: number } | undefined {
  if (to - from <= 0.05) return undefined;
  const cuts = evidence?.cuts ?? [];
  const cutHits = (rc: RecordingCut) => Math.max(cutShareOf(rc, fromBox), cutShareOf(rc, toBox)) >= CUT_SHOWN;
  // 1. Recording cut inside a continuous clip during or right before the glide.
  for (const clip of run) {
    for (const rc of cuts) {
      if (rc.at <= clip.sourceIn + 1e-3 || rc.at >= clip.sourceOut - 1e-3) continue;
      const at = sourceToTimeline(clip, rc.at);
      if (at >= from - 0.25 && at <= to + 0.05 && cutHits(rc)) return { at: r2(at) };
    }
  }
  // 2. Clip source jump right before or during the glide across which the screen changed.
  for (let i = 1; i < run.length; i++) {
    const prev = run[i - 1]!, curr = run[i]!;
    if (Math.abs(curr.timelineIn - clipEnd(prev)) > 0.06) continue;
    if (curr.timelineIn < from - 0.35 || curr.timelineIn > to + 0.05) continue;
    if (Math.abs(curr.sourceIn - prev.sourceOut) <= 0.2) continue;
    const lo = Math.min(prev.sourceOut, curr.sourceIn), hi = Math.max(prev.sourceOut, curr.sourceIn);
    if (cuts.some(rc => rc.at >= lo - 0.1 && rc.at <= hi + 0.1 && cutHits(rc))) return { at: r2(curr.timelineIn) };
    if (evidence?.lines?.length) {
      const textsAt = (src: number, box: Box) => new Set(evidence.lines!
        .filter(l => l.start <= src && src <= l.end && area(meet(l.box, box)) > 0 && l.text.trim().length >= 3)
        .map(l => l.text.trim().toLowerCase()));
      const a = textsAt(prev.sourceOut, fromBox), b = textsAt(curr.sourceIn, toBox);
      if (a.size >= 3 && b.size >= 3) {
        const shared = [...a].filter(t => b.has(t)).length;
        if (shared / Math.min(a.size, b.size) < 0.35) return { at: r2(curr.timelineIn) };
      }
    }
    if (evidence?.detail?.length) {
      const c1 = evidence.detail.findLast(d => d.at <= prev.sourceOut + 0.5)?.cells;
      const c2 = evidence.detail.findLast(d => d.at <= curr.sourceIn + 0.5)?.cells;
      if (c1 && c2 && detailDiffShare(c1, c2, toBox) >= 0.25) return { at: r2(curr.timelineIn) };
    }
  }
  return undefined;
}

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/**
 * The stretches `after` frames that `before` framed otherwise: clips of a recording on one track, in a row, that the edit
 * added or whose transform or keyframes it changed, with the stretch they make together.
 */
export function framingReport(before: Timeline | null, after: Timeline, media: readonly MediaAsset[], canvas: Size,
  readings: readonly ScreenReading[] = [], motion: readonly MotionSpan[] = [], beside?: BesideEvidence, smallTextUnder = SMALL_TEXT_PERCENT): FramedStretch[] {
  const was = new Map(before?.tracks.flatMap(t => t.clips.map(c => [c.id, c] as const)) ?? []);
  const assets = new Map(media.map(m => [m.id, m]));
  const size = (id: string): Size => ({ width: assets.get(id)?.width || canvas.width, height: assets.get(id)?.height || canvas.height });
  const visible = after.tracks.map((track, index) => ({ track, index })).filter(({ track }) => track.kind === "video" && !track.hidden);
  const opaque = (c: MediaClip) => c.enabled !== false && c.opacity > 0 && assets.get(c.mediaId)?.kind !== "graphic";
  const layers = visible.flatMap(({ track, index }) => track.clips.filter((c): c is MediaClip => c.kind === "media" && opaque(c)).map(clip => ({ clip, index })));
  // A clip the edit added, turned on or framed otherwise.
  const changed = (c: MediaClip) => {
    const old = was.get(c.id);
    return old?.kind !== "media" || old.enabled === false || framing(old) !== framing(c);
  };
  // A stretch whose edges the edit moved: trimmed at either end, or the recording turned off right beside it.
  const edgesMoved = (run: readonly MediaClip[], track: Timeline["tracks"][number]) => {
    const first = run[0]!, last = run.at(-1)!, from = first.timelineIn, to = clipEnd(last);
    const a = was.get(first.id), b = was.get(last.id);
    if ((a?.kind === "media" && a.sourceIn !== first.sourceIn) || (b?.kind === "media" && b.sourceOut !== last.sourceOut)) return true;
    return track.clips.some(c => c.kind === "media" && c.mediaId === first.mediaId && c.enabled === false &&
      (Math.abs(c.timelineIn - to) <= 0.05 || Math.abs(clipEnd(c) - from) <= 0.05) && (o => o?.kind === "media" && o.enabled !== false)(was.get(c.id)));
  };
  // The main picture is the lowest video track's. A recording whose sound doesn't play, laid above it and covering most
  // of the video, is shown in its place. The main picture can be silent too, beside a separate recorder's sound.
  const heard = new Set(after.tracks.filter(t => !t.muted).flatMap(t => t.clips.filter(c => c.kind === "media" && c.enabled !== false && c.volume > 0).map(c => (c as MediaClip).mediaId)));
  const main = visible.find(({ track }) => track.clips.some(c => c.kind === "media"))?.index ?? Infinity;
  const standsIn = (c: MediaClip, trackIndex: number) => trackIndex > main && !heard.has(c.mediaId) &&
    area(meet(pictureBox(c, 0, size(c.mediaId), canvas), [0, 0, 1, 1])) >= STANDS_IN;

  const out: FramedStretch[] = [];
  for (const { track, index } of visible) {
    const clips = track.clips.filter((c): c is MediaClip => c.kind === "media" && opaque(c)).sort((a, b) => a.timelineIn - b.timelineIn);
    // Stretches: clips of one recording in a row, framed or shown in place of the main picture, that the edit changed or moved the edges of.
    let run: MediaClip[] = [];
    // A picture over the stretch, such as a camera inset, that the edit added, moved or sized anew changes what of it is seen.
    const coverChanged = (from: number, to: number) => layers.some(l => l.index > index && l.clip.timelineIn < to && clipEnd(l.clip) > from && changed(l.clip));
    const flush = () => {
      const made = run.length && (run.some(changed) || edgesMoved(run, track) || coverChanged(run[0]!.timelineIn, clipEnd(run.at(-1)!))) ? stretch(run, track.id, index) : undefined;
      // A picture that doesn't fill the video, such as a camera inset, has no frame to report, unless it is shown in place of the main picture.
      if (made && ([...made.holds.map(h => h.frame), ...made.moves.map(m => m.toFrame)].some(f => f.length) || run.some(c => standsIn(c, index)))) out.push(made);
      run = [];
    };
    const clipCoveredWhole = (clip: MediaClip) => {
      const a = clip.timelineIn, b = clipEnd(clip);
      return layers.some(l => l.index > index && l.clip.timelineIn <= a + 0.05 && clipEnd(l.clip) >= b - 0.05 &&
        area(meet(pictureBox(l.clip, Math.max(0, (a + b) / 2 - l.clip.timelineIn), size(l.clip.mediaId), canvas), [0, 0, 1, 1])) >= 0.9);
    };
    const clipHasCover = (clip: MediaClip) => {
      const a = clip.timelineIn, b = clipEnd(clip);
      return layers.some(l => l.index > index && l.clip.timelineIn < b - 0.05 && clipEnd(l.clip) > a + 0.05 &&
        area(meet(pictureBox(l.clip, Math.max(0, (a + b) / 2 - l.clip.timelineIn), size(l.clip.mediaId), canvas), [0, 0, 1, 1])) < 0.9);
    };
    for (const clip of clips) {
      const prev = run.at(-1);
      // On a whole-timeline closing check (`before === null`), include unframed screen recordings on the main track
      // too unless a full-screen layer hides the clip, so forgotten unframed stretches are still checked. On the first
      // discovery pass (`beside === undefined`, before `framedOn` fetches screen perception), a silent main-track clip
      // or one with an inset over it stands in so its recording is fetched.
      const unframedScreen = before === null && !clipCoveredWhole(clip) &&
        (beside ? ((beside.lines.get(clip.mediaId)?.length ?? 0) > 0 || (beside.detail?.get(clip.mediaId)?.length ?? 0) > 0)
          : (!heard.has(clip.mediaId) || clipHasCover(clip)));
      const shown = !!clip.transform || !!clip.keyframes?.length || standsIn(clip, index) || unframedScreen;
      if (prev && (!shown || prev.mediaId !== clip.mediaId || clip.timelineIn - clipEnd(prev) > 0.05)) flush();
      if (shown) run.push(clip);
    }
    flush();
  }

  function stretch(run: MediaClip[], trackId: string, trackIndex: number): FramedStretch {
    const source = size(run[0]!.mediaId);
    const from = run[0]!.timelineIn, to = clipEnd(run.at(-1)!);
    const cuts = run.slice(1).map(c => c.timelineIn);
    // The frame along the stretch, sampled.
    const samples: Array<{ t: number; frame: Box | null; source: number }> = [];
    for (const clip of run) {
      const end = clipEnd(clip);
      const at = (t: number) => ({ t, frame: frameShown(clip, Math.max(0, t - clip.timelineIn), source, canvas), source: clip.sourceIn + Math.max(0, t - clip.timelineIn) * (clip.speed ?? 1) });
      for (let t = clip.timelineIn; t < end - 1e-6; t = Math.min(end, t + STEP)) {
        samples.push(at(t));
        if (end - t <= STEP) { samples.push(at(end - 1e-3)); break; }
      }
    }
    const same = (a: Box | null, b: Box | null) => a === b || (!!a && !!b && a.every((n, i) => Math.abs(n - b[i]!) < STILL));
    const frameAt = (n: number) => samples[n]!.frame ? pct(samples[n]!.frame!) : [];
    const crosses = (n: number) => cuts.some(c => samples[n - 1]!.t < c - 1e-6 && samples[n]!.t >= c - 1e-6);
    // An instantaneous `ease: "hold"` keyframe step inside a clip (`over: 0` from timeline_framing) is a straight cut, not a 0.1 s glide.
    const holdJump = (fromT: number, toT: number) => run.some(c => {
      const kfs = c.keyframes;
      if (!kfs?.length) return false;
      for (let i = 1; i < kfs.length; i++) {
        const t = c.timelineIn + kfs[i]!.time;
        if (t > fromT - 1e-6 && t <= toT + 1e-6 && kfs[i - 1]!.ease === "hold") return true;
      }
      return false;
    });
    const holds: FramedStretch["holds"] = [], moves: FramedStretch["moves"] = [];
    if (samples.length === 1) holds.push({ from: r2(from), to: r2(to), frame: frameAt(0) });
    // Between each sample and the next the frame stays or changes; a run of either is a hold or a move.
    for (let a = 1; a < samples.length;) {
      const still = same(samples[a]!.frame, samples[a - 1]!.frame);
      let b = a;
      while (b + 1 < samples.length && same(samples[b + 1]!.frame, samples[b]!.frame) === still) b++;
      const first = samples[a - 1]!, last = samples[b]!;
      if (still) holds.push({ from: r2(first.t), to: r2(b === samples.length - 1 ? to : last.t), frame: frameAt(a - 1) });
      else {
        // A change where every sample step is a clip cut or an instantaneous hold-keyframe step is a cut to another frame, not a move.
        let jump = true;
        for (let k = a; k <= b; k++) {
          if (!crosses(k) && !holdJump(samples[k - 1]!.t, samples[k]!.t)) { jump = false; break; }
        }
        moves.push({ from: r2(first.t), to: r2(jump ? first.t : last.t), fromFrame: frameAt(a - 1), toFrame: frameAt(b),
          ...(!jump && cuts.some(c => Math.abs(c - first.t) <= STEP + 1e-6) && { onCut: true as const }) });
      }
      a = b + 1;
    }
    // A move held for a moment and moved on is one move: keyframes a hair apart read as a stutter of tiny moves otherwise.
    for (let n = moves.length - 1; n > 0; n--) {
      const prev = moves[n - 1]!, next = moves[n]!;
      if (next.from - prev.to > 0.3 || prev.to === prev.from || next.to === next.from) continue;
      prev.to = next.to; prev.toFrame = next.toFrame;
      moves.splice(n, 1);
      const gap = holds.findIndex(h => h.from >= prev.from - 1e-6 && h.to <= prev.to + 1e-6);
      if (gap >= 0) holds.splice(gap, 1);
    }
    for (const move of moves) Object.assign(move, moveSize(move.fromFrame, move.toFrame));

    /** Whether a full-screen opaque clip on a higher track completely hides this stretch at moment `t`. */
    const opaqueAbove = (t: number) => layers.some(l => l.index > trackIndex && l.clip.timelineIn <= t && t < clipEnd(l.clip) &&
      area(meet(pictureBox(l.clip, t - l.clip.timelineIn, size(l.clip.mediaId), canvas), [0, 0, 1, 1])) >= 0.9);
    /** The pictures over the stretch at a moment, such as a camera inset, on the video: one that fills it is shown in its place, not over it. */
    const coversAt = (t: number) => layers.filter(l => l.index > trackIndex && l.clip.timelineIn <= t && t < clipEnd(l.clip))
      .map(l => pictureBox(l.clip, t - l.clip.timelineIn, size(l.clip.mediaId), canvas))
      .map(b => meet(b, [0, 0, 1, 1])).filter(b => area(b) > 0 && area(b) < 0.9);
    // The recording's text, cuts and detail over the stretch.
    const lines = beside?.lines.get(run[0]!.mediaId) ?? [];
    const recCuts = beside?.cuts?.get(run[0]!.mediaId) ?? [];
    const details = (beside?.detail?.get(run[0]!.mediaId) ?? []).map(d => ({ at: d.at, cells: new Uint8Array(Buffer.from(d.cells, "base64")) }));
    if (beside) for (const move of moves) {
      if (move.to - move.from <= 0.05 || move.fromFrame.length !== 4 || move.toFrame.length !== 4) continue;
      if (opaqueAbove((move.from + move.to) / 2)) continue;
      const hit = moveCrossesScreenChange(run, move.from, move.to, move.fromFrame.map(n => n / 100) as Box, move.toFrame.map(n => n / 100) as Box,
        { cuts: recCuts, lines, detail: details });
      if (hit) { move.screenChanged = true; move.screenChangeAt = hit.at; }
    }
    if (lines.length || details.length || readings.length) for (const hold of holds) {
      if (!hold.frame.length) continue;
      const under = new Map<string, ScreenLine>();
      let clear: Set<Corner> | undefined;
      const inCorners = new Map<Corner, number>();
      const hides = new Map<string, { box: number[]; hidden: number; cells: number }>();
      const lrClipped = new Map<string, { side: "left" | "right"; text: string }>();
      const tbClipped = new Map<string, { side: "top" | "bottom"; text: string; hits: number }>();
      const sized = new Map<string, { heightPct: number; text: string }>();
      const playerClocks = new Set<string>();
      const blanks: Array<{ from: number; to: number; maxDetail: number; texts: Set<string> }> = [];
      let openBlank: { from: number; to: number; maxDetail: number; texts: Set<string> } | undefined;
      let visibleSamples = 0;
      let next = -Infinity;
      for (const s of samples) {
        if (s.t < hold.from - 1e-6 || (hold.to > hold.from ? s.t >= hold.to - 1e-6 : s.t > hold.to + 1e-6) || s.t < next || !s.frame) continue;
        next = s.t + TEXT_STEP;
        if (opaqueAbove(s.t)) { openBlank = undefined; continue; }
        visibleSamples++;
        const [fl, ft, fr, fb] = s.frame, fw = fr - fl, fh = fb - ft;
        const covers = coversAt(s.t);
        const cells = details.findLast(d => d.at <= s.source + 0.5)?.cells;
        const activeLines = lines.length ? lines.filter(l => l.start <= s.source && s.source <= l.end) : [];
        // Blank / loading screen check (applies with or without a camera inset).
        if (cells) {
          const ds = detailShare(cells, s.frame);
          const vis = activeLines.filter(l => area(meet(l.box, s.frame!)) > 0 && l.text.trim().length >= 2);
          const isBlank = (ds < 0.015 && vis.length <= 1) || (ds < 0.05 && vis.length >= 1 && vis.length <= 3 && vis.every(l => LOADING_TEXT.test(l.text)));
          if (isBlank) {
            const segEnd = Math.min(hold.to, s.t + TEXT_STEP);
            if (!openBlank) { openBlank = { from: s.t, to: segEnd, maxDetail: ds, texts: new Set() }; blanks.push(openBlank); }
            else { openBlank.to = segEnd; openBlank.maxDetail = Math.max(openBlank.maxDetail, ds); }
            for (const l of vis) openBlank.texts.add(l.text.trim().slice(0, 60));
          } else openBlank = undefined;
        }
        // Text sliced by frame edges, visible player controls, & rendered text height (applies with or without a camera inset).
        if (activeLines.length && fw > 0 && fh > 0) {
          for (const l of activeLines) {
            const txt = l.text.trim();
            if (txt.length < 3) continue;
            const b = l.box, bw = b[2] - b[0], bh = b[3] - b[1];
            if (bw <= 0 || bh <= 0) continue;
            if (PLAYER_CLOCK.test(txt) && area(meet(b, s.frame)) / (bw * bh) >= 0.4 && (!covers.length || !coverOnText(s.frame, covers, [l]))) {
              playerClocks.add(txt);
            }
            const vIn = Math.max(0, Math.min(b[3], fb) - Math.max(b[1], ft)) / bh;
            const hIn = Math.max(0, Math.min(b[2], fr) - Math.max(b[0], fl)) / bw;
            if (vIn >= 0.4) {
              if (fl > 0.005 && b[0] < fl - 0.003 && b[2] > fl + 0.003 && hIn >= 0.05 && hIn <= 0.95)
                lrClipped.set(`L:${txt.slice(0, 40)}`, { side: "left", text: txt });
              if (fr < 0.995 && b[0] < fr - 0.003 && b[2] > fr + 0.003 && hIn >= 0.05 && hIn <= 0.95)
                lrClipped.set(`R:${txt.slice(0, 40)}`, { side: "right", text: txt });
            }
            if (hIn >= 0.4) {
              if (ft > 0.005 && b[1] < ft - 0.002 && b[3] > ft + 0.002 && vIn >= 0.1 && vIn <= 0.85) {
                const k = `T:${txt.slice(0, 40)}`, prev = tbClipped.get(k);
                tbClipped.set(k, { side: "top", text: txt, hits: (prev?.hits ?? 0) + 1 });
              }
              if (fb < 0.995 && b[1] < fb - 0.002 && b[3] > fb + 0.002 && vIn >= 0.1 && vIn <= 0.85) {
                const k = `B:${txt.slice(0, 40)}`, prev = tbClipped.get(k);
                tbClipped.set(k, { side: "bottom", text: txt, hits: (prev?.hits ?? 0) + 1 });
              }
            }
            const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
            if (txt.length >= 4 && cx >= fl && cx <= fr && cy >= ft && cy <= fb && (!covers.length || !coverOnText(s.frame, covers, [l]))) {
              sized.set(`${txt.slice(0, 30)}@${Math.round(b[0] * 100)},${Math.round(b[1] * 100)}`, { heightPct: bh / fh * 100, text: txt });
            }
          }
        }
        if (!covers.length) continue;
        // Detail: the picture in force at this source second, under each cover as placed, and in each corner.
        if (cells) {
          const share = (boxes: readonly Box[]) => {
            const onSource = boxes.map(c => [fl + c[0] * fw, ft + c[1] * fh, fl + c[2] * fw, ft + c[3] * fh]);
            const weights = onSource.map(b => area(b as Box));
            const total = weights.reduce((a, b) => a + b, 0);
            return total ? onSource.reduce((n, b, i) => n + detailShare(cells, b) * weights[i]!, 0) / total : 0;
          };
          for (const corner of CORNERS) inCorners.set(corner, Math.max(inCorners.get(corner) ?? 0, share(covers.map(c => boxInCorner(c, corner)))));
          // Each thing in the frame, and how much of it is under a cover: a cell counts by its middle.
          const onSource = covers.map(c => [fl + c[0] * fw, ft + c[1] * fh, fl + c[2] * fw, ft + c[3] * fh]);
          for (const thing of detailAreas(cells, s.frame)) {
            const underCells = thing.cells.filter(i => {
              const x = (i % DETAIL_COLS + 0.5) / DETAIL_COLS, y = (Math.floor(i / DETAIL_COLS) + 0.5) / DETAIL_ROWS;
              return onSource.some(b => x >= b[0]! && x <= b[2]! && y >= b[1]! && y <= b[3]!);
            }).length;
            if (!underCells) continue;
            const key = thing.box.join(), hidden = underCells / thing.cells.length, was = hides.get(key);
            if (!was || hidden > was.hidden) hides.set(key, { box: pct(thing.box), hidden, cells: underCells });
          }
        }
        const shown = activeLines.filter(l => area(meet(l.box, s.frame!)) > 0);
        const sitsOn = shown.filter(l => coverOnText(s.frame!, covers, [l]));
        if (!sitsOn.length) continue;
        for (const l of sitsOn) under.set(`${l.text}@${l.box.map(n => n.toFixed(2))}`, l);
        const here = CORNERS.filter(corner => !coverOnText(s.frame!, covers.map(c => boxInCorner(c, corner)), shown));
        clear = new Set(clear ? [...clear].filter(c => here.includes(c)) : here);
      }
      if (!visibleSamples) continue;
      if (playerClocks.size) hold.playerControls = [...playerClocks].slice(0, 3);
      const realBlanks = blanks.filter(b => b.to - b.from >= 0.8);
      if (realBlanks.length) {
        hold.blank = realBlanks.map(b => ({ from: r2(b.from), to: r2(b.to), detailPct: Math.round(b.maxDetail * 1000) / 10,
          ...(b.texts.size && { showing: [...b.texts].slice(0, 3) }) }));
      }
      const minTbHits = hold.to - hold.from >= 2 ? 2 : 1;
      const clipped = [...lrClipped.values(), ...[...tbClipped.values()].filter(v => v.hits >= minTbHits)];
      if (clipped.length) {
        const sides = (["left", "right", "top", "bottom"] as const).filter(side => clipped.some(c => c.side === side));
        const clippedTexts = [...new Set(clipped.map(c => c.text.slice(0, 60)))];
        hold.clippedText = { sides, lines: clippedTexts.slice(0, 5), ...(clippedTexts.length > 5 && { more: clippedTexts.length - 5 }) };
      }
      // Small text: either text read aloud on this hold or substantial text on screen below smallTextUnder% of video height.
      const fh = (hold.frame[3]! - hold.frame[1]!) / 100;
      const fBox = hold.frame.map(n => n / 100) as Box;
      let readHeightPct: number | undefined;
      let readSaid: string | undefined;
      if (fh > 0) {
        for (const r of readings) {
          if (r.mediaId !== run[0]!.mediaId || r.to <= hold.from || r.from >= hold.to) continue;
          const rHeights = r.lines
            .filter(l => { const cx = (l.box[0] + l.box[2]) / 2, cy = (l.box[1] + l.box[3]) / 2; return cx >= fBox[0] && cx <= fBox[2] && cy >= fBox[1] && cy <= fBox[3]; })
            .map(l => (l.box[3] - l.box[1]) / fh * 100);
          if (!rHeights.length) continue;
          const med = Math.round(median(rHeights) * 10) / 10;
          if (med < smallTextUnder && (readHeightPct === undefined || med < readHeightPct)) {
            readHeightPct = med;
            readSaid = r.said.length > 80 ? `${r.said.slice(0, 77)}…` : r.said;
          }
        }
      }
      const allSized = [...sized.values()];
      const longCount = allSized.filter(x => x.text.length >= 15).length;
      const usualPct = allSized.length ? Math.round(median(allSized.map(x => x.heightPct)) * 10) / 10 : undefined;
      if (readHeightPct !== undefined || (usualPct !== undefined && hold.to - hold.from >= 2 && (allSized.length >= 10 || longCount >= 5) && usualPct < smallTextUnder)) {
        const shownPct = readHeightPct !== undefined && (usualPct === undefined || readHeightPct < usualPct) ? readHeightPct : (usualPct ?? readHeightPct!);
        const sample = [...new Set([...allSized].sort((a, b) => b.text.length - a.text.length).map(x => x.text.slice(0, 50)))].slice(0, 3);
        hold.smallText = {
          heightPct: shownPct, heightPx: Math.round(shownPct / 100 * canvas.height), videoHeight: canvas.height,
          lines: allSized.length, sample, ...(readHeightPct !== undefined && { readHeightPct, readSaid }),
        };
      }
      if (hides.size) {
        const things = [...hides.values()].sort((a, b) => b.cells - a.cells);
        hold.coverHides = things.slice(0, 5).map(t => ({ box: t.box, hidden: Math.round(t.hidden * 100) }));
        if (things.length > 5) hold.coverHidesMore = things.length - 5;
        hold.detailInCorners = Object.fromEntries(CORNERS.map(c => [c, Math.round((inCorners.get(c) ?? 0) * 100)]));
      }
      if (!under.size) continue;
      // Down the picture, then across, as the lines read.
      const texts = [...new Set([...under.values()].sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]).map(l => l.text.slice(0, 60)))];
      hold.underCover = texts.slice(0, 5);
      if (texts.length > 5) hold.underCoverMore = texts.length - 5;
      hold.cornersClearOfText = [...clear ?? []];
    }

    /** The largest shares of an area of the source, over a stretch of time, that the frame leaves out and that a picture over it covers. */
    const hiddenOf = (box: Box, start: number, end: number) => {
      let out = 0, cover = 0;
      const area0 = area(box);
      if (area0 <= 0) return { out, cover };
      for (const s of samples) {
        if (s.t < start || s.t > end || !s.frame) continue;
        const f = s.frame, fw = f[2] - f[0], fh = f[3] - f[1];
        out = Math.max(out, 1 - area(meet(box, f)) / area0);
        // The area on the video, and the pictures over it there.
        const onVideo: Box = [(box[0] - f[0]) / fw, (box[1] - f[1]) / fh, (box[2] - f[0]) / fw, (box[3] - f[1]) / fh];
        const seen = meet(onVideo, [0, 0, 1, 1]);
        if (area(seen) <= 0) continue;
        cover = Math.max(cover, Math.min(1, coversAt(s.t).reduce((n, c) => n + area(meet(seen, c)), 0) / area(onVideo)));
      }
      return { out, cover };
    };
    const shares = ({ out, cover }: { out: number; cover: number }, least: number) => ({
      ...(out >= least && { outsideFrame: Math.round(out * 100) }), ...(cover >= least && { underCover: Math.round(cover * 100) }) });

    // What of each reading aloud in the stretch the viewer doesn't see.
    const hidden: NonNullable<FramedStretch["readsHidden"]> = [];
    for (const r of readings) {
      if (r.mediaId !== run[0]!.mediaId || r.to <= from || r.from >= to) continue;
      const seen = hiddenOf(r.box as Box, r.from, r.to);
      if (seen.out >= HIDDEN || seen.cover >= HIDDEN) hidden.push({ from: r.from, to: r.to, said: r.said.length > 80 ? `${r.said.slice(0, 77)}…` : r.said, box: pct(r.box), ...shares(seen, HIDDEN) });
    }
    // And of each area where the picture keeps changing.
    const action: NonNullable<FramedStretch["actionHidden"]> = [];
    for (const m of motion) {
      if (m.mediaId !== run[0]!.mediaId || m.to <= from || m.from >= to || m.share < SMALL) continue;
      const seen = hiddenOf(m.box, m.from, m.to);
      if (seen.out < ACTION_HIDDEN && seen.cover < ACTION_HIDDEN) continue;
      const item = { from: m.from, to: m.to, box: pct(m.box), ...shares(seen, ACTION_HIDDEN) };
      // The same area changing again a moment later is one entry: a demo that animates throughout listed its page a dozen times.
      const last = action.at(-1);
      if (last && item.from - last.to <= 3 && last.box.every((n, i) => Math.abs(n - item.box[i]!) <= 5)) {
        last.to = item.to;
        last.box = last.box.map((n, i) => i < 2 ? Math.min(n, item.box[i]!) : Math.max(n, item.box[i]!));
        if (item.outsideFrame) last.outsideFrame = Math.max(last.outsideFrame ?? 0, item.outsideFrame);
        if (item.underCover) last.underCover = Math.max(last.underCover ?? 0, item.underCover);
      } else action.push(item);
    }
    // Beside the stretch, what the recording shows is what the frame held at that edge, or all the picture shows of it.
    const onScreen = (clip: MediaClip, at: number) => sourceOnScreen(clip, Math.max(0, at - clip.timelineIn), source, canvas);
    const shownAfter = beside && besideShown(run, "after", samples.at(-1)?.frame ?? onScreen(run.at(-1)!, to - 1e-3), beside);
    const shownBefore = beside && besideShown(run, "before", samples[0]?.frame ?? onScreen(run[0]!, from), beside);
    return { mediaId: run[0]!.mediaId, trackId, from: r2(from), to: r2(to), clips: run.length, holds, moves, ...(hidden.length && { readsHidden: hidden }), ...(action.length && { actionHidden: action.slice(0, 10) }),
      ...(shownAfter && { shownAfter }), ...(shownBefore && { shownBefore }) };
  }

  /**
   * The video beside a stretch, with its recording off picture, while the recording shows what the frame did at that
   * edge: a line of its text in the frame is still there, or nothing in the frame has changed since, up to a cut in the
   * recording that changes a good part of the frame. A browser's bookmarks bar and tabs stay through every page it
   * shows, so their text alone read as the same picture across a switch to another page (2026-11-20).
   */
  function besideShown(run: MediaClip[], side: "after" | "before", frame: Box | null, evidence: BesideEvidence): ShownBeside | undefined {
    const walk = besideWalk(after, run, side, layers.map(l => l.clip));
    if (!walk || !frame) return undefined;
    const mediaId = run[0]!.mediaId, edge = walk.edge;
    const inFrame = (b: readonly number[]) => area(meet(b as Box, frame)) >= area(b as Box) / 2;
    // The longest lines first: a page's sentences ahead of the labels of the window around them (a bookmarks bar, tabs).
    const lines = (evidence.lines.get(mediaId) ?? []).filter(l => l.start <= edge && l.end >= edge && inFrame(l.box))
      .sort((a, b) => b.text.length - a.text.length || a.box[1] - b.box[1] || a.box[0] - b.box[0]);
    const changes = (evidence.seconds.get(mediaId) ?? []).filter(s => s.areas.some(a => a[4] >= SMALL && area(meet(a.slice(0, 4) as Box, frame)) > 0));
    const cuts = (evidence.cuts?.get(mediaId) ?? []).filter(c => cutShareOf(c, frame) >= CUT_SHOWN);
    const anyChange = (evidence.seconds.get(mediaId) ?? []).filter(s => s.areas.length);
    let last: { t: number; source: number; unchanged: boolean } | undefined;
    for (const { t, source } of walk.steps) {
      const [lo, hi] = side === "after" ? [edge, source] : [source, edge];
      if (cuts.some(c => c.at > lo && c.at <= hi)) break;
      const unchanged = !changes.some(s => s.at + 1 > lo && s.at < hi);
      const still = lines.some(l => side === "after" ? l.end >= source : l.start <= source);
      if (!unchanged && !still) break;
      last = { t, source, unchanged };
    }
    if (!last) return undefined;
    const [a, b] = side === "after" ? [walk.at, last.t + BESIDE_STEP / 2] : [last.t - BESIDE_STEP / 2, walk.at];
    if (b - a < 1) return undefined;
    // The lines there for at least half of it: a post's text can go a moment before the page does, its window's labels not.
    const reach = last.source, half = Math.abs(reach - edge) / 2;
    const [from, to] = side === "after" ? [edge, reach] : [reach, edge];
    const stillEverywhere = last.unchanged && !!evidence.motionRead?.has(mediaId) && !anyChange.some(s => s.at + 1 > from && s.at < to);
    const showing = [...new Set(lines.filter(l => (side === "after" ? Math.min(l.end, reach) - edge : edge - Math.max(l.start, reach)) >= half).map(l => l.text))].slice(0, 3);
    const heard = evidence.words.filter(w => w.start >= a - 0.05 && w.end <= b + 0.05);
    const said = heard.map(w => w.text.trim()).filter(Boolean).join(" ");
    // What of the recording's text is read aloud meanwhile, on its clock beside the stretch: a passage read off a page
    // the video doesn't show (2026-11-20, a live mock read out word for word over 25 s of camera).
    const steps = walk.steps.filter(s => s.t >= a - BESIDE_STEP && s.t <= b + BESIDE_STEP);
    const reads = readingsAt(heard, new Map([[mediaId, evidence.lines.get(mediaId) ?? []]]), t => {
      const near = steps.find(s => Math.abs(s.t - t) <= BESIDE_STEP / 2 + 1e-6);
      return near ? [{ mediaId, source: (x: number) => near.source + (x - near.t), end: b }] : [];
    }).map(r => ({ from: r2(r.from), to: r2(r.to), said: r.said.length > 120 ? `${r.said.slice(0, 117)}…` : r.said }));
    // Where the speaker looks meanwhile: eyes dropped to a laptop below the camera are on the screen the video doesn't
    // show (2026-11-21: the presenter's lids fell while he read the hidden screen, and he spoke to the lens otherwise).
    const eyes = evidence.eyes?.get(walk.clock.mediaId) ?? [];
    const downs = steps.filter(s => s.t >= a && s.t <= b).flatMap(s => {
      const found = eyes.find(e => e.start <= s.clockSource && s.clockSource < e.end)?.eyesDown;
      return found === undefined ? [] : [found];
    });
    const looked = steps.filter(s => s.t >= a && s.t <= b).length;
    const eyesDown = looked && downs.length >= looked / 2 ? r2(downs.reduce((n, d) => n + d, 0) / downs.length) : undefined;
    // The face midway through, to look at: the area round it, as wide as two and a half faces, in the picture's shape.
    const middle = steps.filter(s => s.t >= a && s.t <= b)[Math.floor(looked / 2)];
    const face = middle && eyes.find(e => e.start <= middle.clockSource && middle.clockSource < e.end)?.box;
    let look: ShownBeside["look"];
    if (middle && face) {
      const width = Math.min(1, (face[2]! - face[0]!) * 2.5), height = Math.min(1, width);
      const left = Math.min(1 - width, Math.max(0, (face[0]! + face[2]!) / 2 - width / 2)), top = Math.min(1 - height, Math.max(0, (face[1]! + face[3]!) / 2 - height / 2));
      look = { mediaId: walk.clock.mediaId, at: r2(middle.clockSource), area: pct([left, top, left + width, top + height]) };
    }
    return { from: r2(a), to: r2(b), ...(showing.length && { showing }), ...(last.unchanged && { unchanged: true as const }),
      ...(stillEverywhere && { stillEverywhere: true as const }),
      ...(said && { said: said.length > 200 ? `${said.slice(0, 197)}…` : said }), ...(reads.length && { reads: reads.slice(0, 5) }),
      ...(eyesDown !== undefined && { eyesDown }), ...(look && { look }) };
  }

  return out.sort((a, b) => a.from - b.from);
}

/**
 * The steps along the video beside a run of a recording's clips, after its end or before its start, while the recording
 * is off picture, with its source second at each. Its clock there is the clock of another recording that plays at the
 * edge and on beside it, heard ones first, as a camera's sound is, at the offset the two have at the edge, read along
 * the clock's own track. Of two clips of it that overlap at the edge, as a crossfade at a dialogue cut makes them, the
 * one that plays on into the stretch keeps the time: the other is footage from the far side of the cut, and taken as
 * the clock it put a screen a minute off what it showed (2026-11-20). Undefined when nothing else plays there.
 */
function besideWalk(tl: Timeline, run: readonly MediaClip[], side: "after" | "before", pictures?: readonly MediaClip[]) {
  const mediaId = run[0]!.mediaId;
  const edgeClip = side === "after" ? run.at(-1)! : run[0]!;
  const at = side === "after" ? clipEnd(edgeClip) : edgeClip.timelineIn;
  const inside = side === "after" ? at - 1e-3 : at + 1e-3;
  const sourceAt = (c: MediaClip, t: number) => c.sourceIn + (t - c.timelineIn) * (c.speed ?? 1);
  const edge = sourceAt(edgeClip, inside);
  const media = tl.tracks.flatMap(t => t.clips.filter((c): c is MediaClip => c.kind === "media" && c.enabled !== false).map(clip => ({ clip, trackId: t.id })));
  const others = media.filter(({ clip: c }) => c.mediaId !== mediaId && (c.speed ?? 1) === 1);
  const playing = (id: string, trackId: string, t: number) =>
    others.find(({ clip: c, trackId: k }) => k === trackId && c.mediaId === id && c.timelineIn <= t + 1e-6 && t < clipEnd(c) - 1e-6)?.clip;
  const step = side === "after" ? BESIDE_STEP : -BESIDE_STEP;
  // How far a clip at the edge plays on into the stretch.
  const into = (c: MediaClip) => side === "after" ? at - c.timelineIn : clipEnd(c) - at;
  const clock = others.filter(({ clip: c, trackId }) => c.timelineIn <= inside && inside < clipEnd(c) && playing(c.mediaId, trackId, at + step / 2))
    .sort((a, b) => Number(b.clip.volume > 0) - Number(a.clip.volume > 0) || into(b.clip) - into(a.clip))[0];
  if (!clock) return undefined;
  const offset = edge - sourceAt(clock.clip, inside);
  const own = (pictures ?? tl.tracks.filter(t => t.kind === "video" && !t.hidden).flatMap(t => t.clips.filter((c): c is MediaClip => c.kind === "media" && c.enabled !== false)))
    .filter(c => c.mediaId === mediaId);
  // Each step's source second of the recording, and of the clock.
  const steps: Array<{ t: number; source: number; clockSource: number }> = [];
  for (let t = at + step / 2; Math.abs(t - at) < BESIDE_MAX && t >= 0; t += step) {
    if (own.some(c => c.timelineIn <= t && t < clipEnd(c))) break;
    const c = playing(clock.clip.mediaId, clock.trackId, t);
    if (!c) break;
    steps.push({ t, source: sourceAt(c, t) + offset, clockSource: sourceAt(c, t) });
  }
  return { at, edge, steps, clock: { mediaId: clock.clip.mediaId } };
}

/**
 * The source seconds of each recording that the framed stretches and the video beside them reach, to read what it shows
 * there, and of each recording whose sound plays beside them, to read where the speaker looks (`clocks`).
 */
export function besideReach(tl: Timeline, framed: readonly FramedStretch[]) {
  const clocks = new Map<string, { from: number; to: number }>();
  for (const f of framed) {
    const run = (tl.tracks.find(t => t.id === f.trackId)?.clips ?? [])
      .filter((c): c is MediaClip => c.kind === "media" && c.mediaId === f.mediaId && c.enabled !== false && c.timelineIn >= f.from - 0.01 && clipEnd(c) <= f.to + 0.01)
      .sort((a, b) => a.timelineIn - b.timelineIn);
    if (!run.length) continue;
    for (const side of ["after", "before"] as const) {
      const walk = besideWalk(tl, run, side);
      if (!walk?.steps.length) continue;
      const seconds = walk.steps.map(s => s.clockSource), was = clocks.get(walk.clock.mediaId);
      clocks.set(walk.clock.mediaId, { from: Math.min(was?.from ?? Infinity, ...seconds), to: Math.max(was?.to ?? -Infinity, ...seconds) });
    }
  }
  return { sources: besideSources(tl, framed),
    clocks: [...clocks].map(([id, r]) => ({ id, from: Math.max(0, Math.floor(r.from) - 1), to: Math.ceil(r.to) + 1 })) };
}

/** The source seconds of each recording that the framed stretches and the video beside them reach, to read what it shows there. */
function besideSources(tl: Timeline, framed: readonly FramedStretch[]): Array<{ id: string; from: number; to: number }> {
  const reach = new Map<string, { from: number; to: number }>();
  const add = (id: string, seconds: number[]) => {
    const was = reach.get(id);
    reach.set(id, { from: Math.min(was?.from ?? Infinity, ...seconds), to: Math.max(was?.to ?? -Infinity, ...seconds) });
  };
  for (const f of framed) {
    const run = (tl.tracks.find(t => t.id === f.trackId)?.clips ?? [])
      .filter((c): c is MediaClip => c.kind === "media" && c.mediaId === f.mediaId && c.enabled !== false && c.timelineIn >= f.from - 0.01 && clipEnd(c) <= f.to + 0.01)
      .sort((a, b) => a.timelineIn - b.timelineIn);
    if (!run.length) continue;
    // The stretch's own text: what a picture over it sits on.
    add(f.mediaId, run.flatMap(c => [c.sourceIn, c.sourceOut]));
    for (const side of ["after", "before"] as const) {
      const walk = besideWalk(tl, run, side);
      if (walk?.steps.length) add(f.mediaId, [walk.edge, ...walk.steps.map(s => s.source)]);
    }
  }
  return [...reach].map(([id, r]) => ({ id, from: Math.max(0, Math.floor(r.from) - 1), to: Math.ceil(r.to) + 1 }));
}

/** How much a move changes what fills the video: the picture's growth in percent, and how far the centre goes in percent of the frame it leaves. */
export function moveSize(from: number[], to: number[]): { zoom?: number; shift?: number } {
  if (from.length !== 4 || to.length !== 4) return {};
  const fw = from[2]! - from[0]!, fh = from[3]! - from[1]!, tw = to[2]! - to[0]!, th = to[3]! - to[1]!;
  if (fw <= 0 || fh <= 0 || tw <= 0 || th <= 0) return {};
  const dx = Math.abs((to[0]! + to[2]!) - (from[0]! + from[2]!)) / 2 / fw, dy = Math.abs((to[1]! + to[3]!) - (from[1]! + from[3]!)) / 2 / fh;
  return { zoom: Math.round((fw / tw - 1) * 1000) / 10, shift: Math.round(Math.max(dx, dy) * 1000) / 10 };
}

export const FRAMING_REPORT_NEXT = "hiddenUnderCover names the holds, in timeline seconds, where a picture over the recording hides something on it, and readOffPicture the passages, in timeline seconds, where the speaker reads aloud text the recording shows while it is off picture (each stretch's shownAfter and shownBefore reads). framed lists each stretch this edit framed, put on picture over another, moved the edges of or moved a picture over (a camera inset): where the frame holds and where it moves, as the area of the source picture that fills the video ([left, top, right, bottom] in percent, empty where the picture doesn't fill it), with each hold's underCover, the lines of the recording's text (screen_text) in the frame that a picture over it sits on, and cornersClearOfText, the corners where that picture would sit on none, coverHides, the things in the recording the frame shows (text, lines, pictures: anything that isn't flat background) that the picture over it hides, with each one's box and the percent of it hidden, and detailInCorners, how much of that picture would sit on such things in each corner, in percent (timeline_framing places a frame clear of it, or moves it), clippedText where a frame edge slices through lines of text, smallText where the text's usual height is small at the video's size (in percent and pixels of the video height), and blank where the framed picture shows almost nothing (such as a loading screen); readsHidden, the passages the speaker reads aloud there (screen_reading) whose lines the frame leaves out (outsideFrame) or a picture over it covers (underCover), in percent of those lines; actionHidden, the areas where the picture keeps changing (screen_motion) that it leaves out or covers, in percent of each area; and shownAfter and shownBefore, the video just after the stretch ends or just before it starts, with the recording off picture, while the recording still shows what the frame showed at that edge, up to a cut in the recording: lines of its text still there (showing, longest first), or nothing in the frame changed (unchanged), and stillEverywhere when nothing anywhere in the recording's picture changes, the pointer included, as a page left still or a capture that stopped leaves it, with the words heard over it (said), the passages of its text read aloud word for word (reads) and how far the speaker's eyes look down meanwhile (eyesDown: 0 level or up, 1 fully down; at a laptop below the camera they read about 0.5 or more, at the lens about 0.1), with where to see their face midway (look: the recording, its source second and the area in percent, for media_frame). A move marked onCut starts on a cut in the picture, and one marked screenChanged glides across a switch to a new screen, page or demo (`screenChangeAt`, where a straight cut with over: 0 fits); each move's zoom says how much larger the picture gets, in percent (negative when it gets smaller), and shift how far the frame's centre goes, in percent of the frame it leaves. frame_contact_sheet on the new version shows any of it as it plays.";
