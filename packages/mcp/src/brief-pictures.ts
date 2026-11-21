import { applyOps, clipEnd, type MediaAsset, type MediaClip, type Timeline, type TimelineOp } from "@scarlet/timeline";
import { pictureBox, type Box } from "./framing.js";

/** Pictures on screen for less than this between two others are reported. How long one should hold is the skill's call. */
export const BRIEF_PICTURE_SECONDS = 1;

/** A picture the edit shows for a moment between two others. Times are seconds on the edited timeline. */
export interface BriefPicture {
  from: number;
  to: number;
  seconds: number;
  /** The clips on screen through it, top first, and the ones before and after it. */
  shows: string[];
  before: string[];
  after: string[];
  /**
   * Ends of it that are cuts in a recording itself rather than clip edges: `at` on the timeline, `source` in the
   * recording's seconds, and `changed`, the share of what the clip shows there that changed at once, in percent.
   */
  recordingCuts?: Array<{ at: number; clip: string; source: number; changed: number }>;
}

/** A cut in a recording's picture, as the engine reads it (`/picture-cuts`): source seconds and the cells it changed. */
export interface RecordingCut { at: number; share: number; cells: string }
/** The grid a recording cut's cells are on, columns by rows, row by row, one bit each. */
export const CUT_GRID = { cols: 64, rows: 36 } as const;
/** A cut in a recording that changes at least this share of what a clip shows of it changes the picture on screen. */
export const CUT_SHOWN = 0.25;

/** The area of its source a clip puts on screen at `local` seconds, as fractions of the source, or null when none is. */
export function sourceOnScreen(clip: MediaClip, local: number, source: { width: number; height: number }, canvas: { width: number; height: number }): Box | null {
  const [l, t, r, b] = pictureBox(clip, local, source, canvas);
  const seen: Box = [Math.max(0, l), Math.max(0, t), Math.min(1, r), Math.min(1, b)];
  if (seen[2] <= seen[0] || seen[3] <= seen[1] || r <= l || b <= t) return null;
  const cl = clip.transform?.cropLeft ?? 0, ct = clip.transform?.cropTop ?? 0;
  const cw = 1 - cl - (clip.transform?.cropRight ?? 0), ch = 1 - ct - (clip.transform?.cropBottom ?? 0);
  return [cl + (seen[0] - l) / (r - l) * cw, ct + (seen[1] - t) / (b - t) * ch, cl + (seen[2] - l) / (r - l) * cw, ct + (seen[3] - t) / (b - t) * ch];
}

/** The share of an area of the source that a recording cut changed: of the grid's cells centred in it, or the one under its middle. */
export function cutShareOf(cut: Pick<RecordingCut, "cells">, area: Box): number {
  const bits = Buffer.from(cut.cells, "base64"), { cols, rows } = CUT_GRID;
  const on = (x: number, y: number) => (bits[(y * cols + x) >> 3]! >> ((y * cols + x) & 7)) & 1;
  let inside = 0, changed = 0;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const cx = (x + 0.5) / cols, cy = (y + 0.5) / rows;
    if (cx < area[0] || cx > area[2] || cy < area[1] || cy > area[3]) continue;
    inside++;
    changed += on(x, y);
  }
  if (inside) return changed / inside;
  const x = Math.min(cols - 1, Math.floor((area[0] + area[2]) / 2 * cols)), y = Math.min(rows - 1, Math.floor((area[1] + area[3]) / 2 * rows));
  return on(x, y);
}

type Layer = { clip: MediaClip; order: number; source: { width: number; height: number } };
type Shown = { clip: MediaClip; box: Box };
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const near = (a: number, b: number, by: number) => Math.abs(a - b) <= by;

/**
 * Where the picture on screen changes and changes again within a moment. A pass ended a screen insert 0.13 s before the
 * dialogue cut where it punched in on the camera, so the wide camera played for four frames between the screen and the
 * tight framing (2026-11-16). The picture is what the viewer sees: each opaque picture from the top track down to the
 * first that fills the video. A cut between two pieces of a recording at the same framing is not a change of picture,
 * and neither is a framing that moves on across a clip edge; a dissolve or fade at either change is left alone.
 *
 * A recording can cut inside a clip too. A pass laid 2.5 s of a screen recording over the camera in which the recording
 * switched to another window and back, so the viewer saw three pictures in two seconds (2026-11-18). With `cuts`, a
 * recording's cuts (by media id) that change enough of what a clip on screen shows of it are changes of picture as well.
 */
export function briefPictures(timeline: Timeline, media: readonly MediaAsset[], canvas: { width: number; height: number },
  min = BRIEF_PICTURE_SECONDS, cuts?: ReadonlyMap<string, readonly RecordingCut[]>): BriefPicture[] {
  const assets = new Map(media.map(m => [m.id, m]));
  const layers: Layer[] = timeline.tracks.flatMap((track, order) => track.kind !== "video" || track.hidden ? [] :
    track.clips.flatMap(clip => {
      if (clip.kind !== "media" || clip.enabled === false || clip.opacity <= 0) return [];
      const asset = assets.get(clip.mediaId);
      if (!asset || (asset.kind !== "video" && asset.kind !== "image") || asset.hasAlpha) return [];
      return [{ clip, order, source: { width: asset.width || canvas.width, height: asset.height || canvas.height } }];
    }));
  layers.sort((a, b) => b.order - a.order);

  function picture(t: number): Shown[] {
    const shown: Shown[] = [];
    for (const { clip, source } of layers) {
      if (!(clip.timelineIn <= t && t < clipEnd(clip))) continue;
      const box = pictureBox(clip, t - clip.timelineIn, source, canvas);
      if (box[2] <= 0 || box[3] <= 0 || box[0] >= 1 || box[1] >= 1) continue;
      shown.push({ clip, box });
      const fills = box[0] <= 0.004 && box[1] <= 0.004 && box[2] >= 0.996 && box[3] >= 0.996;
      if (fills && clip.opacity >= 1 && !clip.transform?.rotation) break;
    }
    return shown;
  }
  const crop = (c: MediaClip) => [c.transform?.cropLeft ?? 0, c.transform?.cropTop ?? 0, c.transform?.cropRight ?? 0, c.transform?.cropBottom ?? 0];
  const same = (a: Shown[], b: Shown[]) => a.length === b.length && a.every((x, i) => {
    const y = b[i]!;
    return x.clip.mediaId === y.clip.mediaId && x.box.every((v, k) => near(v, y.box[k]!, 0.003)) &&
      crop(x.clip).every((v, k) => near(v, crop(y.clip)[k]!, 0.001));
  });

  const end = Math.max(0, ...layers.map(l => clipEnd(l.clip)));
  // Clip edges within a millisecond of each other are one change, read just before the first and just after the last.
  const times = layers.flatMap(l => [l.clip.timelineIn, clipEnd(l.clip)]).filter(t => t > 0 && t < end).sort((a, b) => a - b);
  const edges: [number, number][] = [];
  for (const t of times) {
    const last = edges.at(-1);
    if (last && t - last[1] < 1e-3) last[1] = t;
    else edges.push([t, t]);
  }
  type Cut = NonNullable<BriefPicture["recordingCuts"]>[number];
  const changes: { at: number; before: Shown[]; after: Shown[]; cut?: Cut }[] = [];
  for (const [first, last] of edges) {
    const before = picture(first - 1e-5), after = picture(last + 1e-5);
    if (!same(before, after)) changes.push({ at: r3(first), before, after });
  }
  // A cut in a recording, inside a clip that shows it, changes the picture there unless it falls on a clip edge.
  if (cuts?.size) for (const { clip, source } of layers) {
    const speed = clip.speed ?? 1;
    for (const cut of cuts.get(clip.mediaId) ?? []) {
      if (cut.at <= clip.sourceIn + 1e-3 || cut.at >= clip.sourceOut - 1e-3) continue;
      const at = clip.timelineIn + (cut.at - clip.sourceIn) / speed;
      if (edges.some(([first, last]) => at >= first - 1e-3 && at <= last + 1e-3)) continue;
      const shown = picture(at);
      if (!shown.some(s => s.clip === clip)) continue;
      const area = sourceOnScreen(clip, at - clip.timelineIn, source, canvas);
      const share = area ? cutShareOf(cut, area) : 0;
      if (share < CUT_SHOWN) continue;
      changes.push({ at: r3(at), before: shown, after: shown, cut: { at: r3(at), clip: clip.id, source: r3(cut.at), changed: Math.round(share * 100) } });
    }
  }
  changes.sort((a, b) => a.at - b.at);
  // A dissolve or fade blends one picture into the next over its length: it is not a hard change to judge here.
  const blended = (c: (typeof changes)[number]) => [...c.before, ...c.after].some(({ clip }) =>
    clip.transitionIn || (clip.videoFadeIn > 0 && near(clip.timelineIn, c.at, 0.002)) || (clip.videoFadeOut > 0 && near(clipEnd(clip), c.at, 0.002)));
  const found: BriefPicture[] = [];
  for (let i = 0; i + 1 < changes.length; i++) {
    const a = changes[i]!, b = changes[i + 1]!;
    if (b.at - a.at >= min - 1e-6 || blended(a) || blended(b)) continue;
    const inRecording = [a.cut, b.cut].filter((c): c is Cut => !!c);
    found.push({ from: a.at, to: b.at, seconds: r3(b.at - a.at), shows: a.after.map(s => s.clip.id),
      before: a.before.map(s => s.clip.id), after: b.after.map(s => s.clip.id), ...(inRecording.length && { recordingCuts: inRecording }) });
  }
  return found;
}

/**
 * The brief pictures an edit makes: those it leaves as they were (the same recordings for the same time) aren't news.
 * `fresh` names recordings whose cuts weren't known when the run last saved: a brief picture at one of their cuts is
 * news, as it wasn't reported then.
 */
export function newBriefPictures(before: Timeline | null, after: Timeline, media: readonly MediaAsset[], canvas: { width: number; height: number },
  cuts?: ReadonlyMap<string, readonly RecordingCut[]>, fresh: ReadonlySet<string> = new Set()) {
  const sig = (tl: Timeline, f: BriefPicture) => {
    const clips = new Map(tl.tracks.flatMap(t => t.clips.map(c => [c.id, c] as const)));
    return `${f.seconds}|${f.shows.map(id => { const c = clips.get(id); return c?.kind === "media" ? c.mediaId : id; }).join(",")}`;
  };
  const mediaOf = new Map(after.tracks.flatMap(t => t.clips.map(c => [c.id, c.kind === "media" ? c.mediaId : ""] as const)));
  const had = new Set(before ? briefPictures(before, media, canvas, BRIEF_PICTURE_SECONDS, cuts).map(f => sig(before, f)) : []);
  return briefPictures(after, media, canvas, BRIEF_PICTURE_SECONDS, cuts)
    .filter(f => !had.has(sig(after, f)) || f.recordingCuts?.some(c => fresh.has(mediaOf.get(c.clip) ?? "")));
}

export const BRIEF_PICTURES_NEXT = `Each stretch in briefPictures shows that picture for under ${BRIEF_PICTURE_SECONDS} s between two others, from \`from\` to \`to\` in seconds of the edit. ` +
  "If it shouldn't play that briefly, run the shot before or after over it, or move the change onto the same cut. " +
  "An end listed in recordingCuts is a cut in the recording itself, at `source` seconds of it, such as a switch to another window or page, " +
  "and `changed` is how much of what the clip shows changed there, in percent: to keep it off screen, end or start the clip on that cut, " +
  "or take the picture from a stretch of the recording that holds.";

/** A picture this short between two others is a flash: no one means it, so its edge goes onto the cut beside it. */
export const FLASH_SECONDS = 0.1;

/** A flash an edit made that Scarlet closed: `clips` had their edges at `from` and now meet the cut at `to`. */
export interface MetCut { from: number; to: number; seconds: number; clips: string[] }

/**
 * The ops that move each flash the edit makes onto the cut beside it. At 0:55 of one pass the screen insert ended two
 * frames before the camera cut to the next take, so the camera showed full frame, still looking at the screen, then cut
 * again (2026-11-17); briefPictures reported it and the run left it. The edges that move are those of pictures laid
 * over the edit, when the cut is in the bottom picture and they are silent: the bottom track holds the dialogue's cut
 * and the sound stays as it was. `stable` names the clips an op can reach on the engine (those already in the video and
 * those the edit names by id). A flash that can't be closed that way stays in briefPictures for the run.
 */
export function flashesOntoCuts(before: Timeline | null, after: Timeline, media: readonly MediaAsset[], canvas: { width: number; height: number },
  stable: (clipId: string) => boolean): { ops: TimelineOp[]; met: MetCut[] } {
  const assets = new Map(media.map(m => [m.id, m]));
  const tracks = after.tracks.map((track, order) => ({ track, order })).filter(({ track }) => track.kind === "video" && !track.hidden);
  const ops: TimelineOp[] = [], met: MetCut[] = [];
  let tl = after;
  for (const flash of newBriefPictures(before, after, media, canvas).filter(f => f.seconds <= FLASH_SECONDS + 1e-3)) {
    // The clip edges at each end of the flash, and whether one of them is the bottom picture's.
    const edgesAt = (t: number) => tracks.flatMap(({ track, order }) => track.clips.flatMap(clip => clip.kind !== "media" ? [] :
      ([["start", clip.timelineIn], ["end", clipEnd(clip)]] as const).filter(([, at]) => near(at, t, 0.002)).map(([side, at]) => ({ clip, side, order, at }))));
    const bottom = Math.min(...tracks.filter(({ track }) => track.clips.some(c => c.timelineIn <= flash.from + 0.002 && clipEnd(c) >= flash.to - 0.002)).map(t => t.order));
    const atFrom = edgesAt(flash.from), atTo = edgesAt(flash.to);
    // The flash's times are rounded: the moved edges go to the bottom picture's cut itself.
    const [moving, cut] = atTo.some(e => e.order === bottom) && atFrom.length && atFrom.every(e => e.order !== bottom) ? [atFrom, atTo]
      : atFrom.some(e => e.order === bottom) && atTo.length && atTo.every(e => e.order !== bottom) ? [atTo, atFrom] : [[], []];
    const to = cut.find(e => e.order === bottom)?.at;
    if (!moving.length || to === undefined) continue;
    const patches: TimelineOp[] = [];
    for (const { clip, side } of moving) {
      const asset = assets.get(clip.mediaId), speed = clip.speed ?? 1;
      if (!stable(clip.id) || (clip.volume > 0 && asset?.hasAudio !== false)) { patches.length = 0; break; }
      const delta = to - (side === "start" ? clip.timelineIn : clipEnd(clip));
      const sourceIn = side === "start" ? clip.sourceIn + delta * speed : clip.sourceIn;
      const sourceOut = side === "end" ? clip.sourceOut + delta * speed : clip.sourceOut;
      // The recording has to have the footage the moved edge shows.
      if (sourceIn < 0 || sourceOut <= sourceIn || (asset?.duration && sourceOut > asset.duration + 1e-6)) { patches.length = 0; break; }
      const patch = side === "start"
        ? { timelineIn: to, sourceIn, ...(clip.keyframes?.length && { keyframes: clip.keyframes.map(k => ({ ...k, time: k.time - delta })) }) }
        : { sourceOut };
      patches.push({ op: "updateClip", clipId: clip.id, patch } as TimelineOp);
    }
    if (!patches.length) continue;
    let next: Timeline;
    try { next = applyOps(tl, patches); } catch { continue; }
    // Kept only if no moved clip now overlaps another on its track and the flash is gone. Audio joins overlap on purpose.
    const moved = new Set(moving.map(e => e.clip.id));
    const overlaps = next.tracks.some(track => track.clips.some((c, i) => i > 0 && (moved.has(c.id) || moved.has(track.clips[i - 1]!.id)) &&
      c.timelineIn < clipEnd(track.clips[i - 1]!) - 1e-6));
    if (overlaps || briefPictures(next, media, canvas, FLASH_SECONDS + 1e-3).some(f => near(f.from, flash.from, 0.002) || near(f.to, flash.to, 0.002))) continue;
    tl = next;
    ops.push(...patches);
    met.push({ from: flash.from, to: flash.to, seconds: flash.seconds, clips: moving.map(e => e.clip.id) });
  }
  return { ops, met };
}

export const MET_CUT_NEXT = `Each stretch in metCut showed a picture for ${FLASH_SECONDS} s or less between two others: Scarlet moved the listed ` +
  "clips' edges onto the cut beside it, so the shot over it now changes on that cut.";

/** An insert's edge Scarlet moved onto a cut in its recording: it was at `from` and is now at `to`, on `source` seconds of the recording. */
export interface MetRecordingCut { from: number; to: number; seconds: number; clips: string[]; source: number }

/**
 * The ops that move an insert's edge onto a cut in its recording when what it shows between them plays under a second. A pass laid a
 * screen insert that started on the game's menu and switched to the game 0.45 s later, and others that ended a moment
 * after the recording switched to a search page or scrolled, so the viewer saw a picture for a moment between two
 * others (2026-11-18). briefPictures told the run with the cut's time, and its next pass left five of them: it frames
 * from a few frames and never sees the switch. The editor: "it should never do that". No one lays a picture of the
 * recording that plays under a second before it changes, so the edge goes onto the cut, and every picture's edge at
 * that time goes with it (the camera inset beside the screen, the next insert, the camera's change of framing), so the
 * change of picture is then the recording's own cut. A run of brief pictures at the edge goes with it, as at 1:20 of
 * that pass, where the reply showed, then another window for 0.87 s, then the reply for 0.33 s: the insert ends where
 * the recording first switched. The sound stays as it was: an audible clip's edge doesn't move, and a picture of a
 * recording that is heard (the camera, or its inset) moves only where it plays straight on into the clip beside it or
 * gives up time with no clip after it to fill in, since the speaker's lips would otherwise show words cut from the
 * sound. Only the insert's tail goes: one that would lose as much as it keeps is mostly brief pictures (a game whose
 * view swings round reads as cuts too), and what plays there is the run's call. An edge that can't move, or whose move
 * would leave a brief picture or the empty background where it lands, stays in briefPictures for the run.
 */
export function edgesOntoRecordingCuts(before: Timeline | null, after: Timeline, media: readonly MediaAsset[], canvas: { width: number; height: number },
  cuts: ReadonlyMap<string, readonly RecordingCut[]>, stable: (clipId: string) => boolean, fresh: ReadonlySet<string> = new Set()): { ops: TimelineOp[]; met: MetRecordingCut[] } {
  const assets = new Map(media.map(m => [m.id, m]));
  const ops: TimelineOp[] = [], met: MetRecordingCut[] = [];
  const heard = new Set(after.tracks.flatMap(track => track.clips.flatMap(c => c.kind === "media" && c.volume > 0 && !track.muted &&
    (track.kind === "audio" || assets.get(c.mediaId)?.hasAudio !== false) ? [c.mediaId] : [])));
  let tl = after;
  const flashes = newBriefPictures(before, after, media, canvas, cuts, fresh).filter(f => f.recordingCuts?.length);
  const isCut = (t: number) => flashes.some(f => f.recordingCuts!.some(c => near(c.at, t, 0.002)));
  const done: number[] = [];
  for (const flash of flashes) {
    // The flash's clip edge, at one end, with a cut in the recording at the other.
    const side = !isCut(flash.to) && isCut(flash.from) ? "end" : !isCut(flash.from) && isCut(flash.to) ? "start" : undefined;
    if (!side) continue;
    const edge = side === "end" ? flash.to : flash.from;
    if (done.some(t => near(t, edge, 0.002))) continue;
    // Brief pictures in a row from the edge inward, each from one cut in the recording to the next.
    const targets: number[] = [side === "end" ? flash.from : flash.to];
    for (;;) {
      const last = targets.at(-1)!;
      const next = flashes.find(f => side === "end" ? near(f.to, last, 0.002) && isCut(f.from) : near(f.from, last, 0.002) && isCut(f.to));
      const at = next && (side === "end" ? next.from : next.to);
      if (at === undefined || targets.some(t => near(t, at, 0.002))) break;
      targets.push(at);
    }
    const edges = tl.tracks.flatMap(track => track.kind !== "video" || track.hidden ? [] : track.clips.flatMap(clip => clip.kind !== "media" ? [] :
      ([["start", clip.timelineIn], ["end", clipEnd(clip)]] as const).filter(([, at]) => near(at, edge, 0.002)).map(([end]) => ({ clip, end, track: track.id }))));
    const playsOn = (e: (typeof edges)[number]) => edges.some(o => o.track === e.track && o.end !== e.end && o.clip.mediaId === e.clip.mediaId &&
      (o.clip.speed ?? 1) === (e.clip.speed ?? 1) && near(e.end === "end" ? e.clip.sourceOut : e.clip.sourceIn, o.end === "end" ? o.clip.sourceOut : o.clip.sourceIn, 0.002));
    const mated = (e: (typeof edges)[number]) => edges.some(o => o.track === e.track && o.end !== e.end);
    for (const to of targets.reverse()) {
      // A heard recording's picture keeps its edge unless it plays straight on, or only gives up time with nothing to fill in after it.
      const moving = edges.filter(e => !heard.has(e.clip.mediaId) || playsOn(e) || (!mated(e) && (e.end === "end" ? to < edge : to > edge)));
      const holder = moving.find(e => e.clip.id === flash.recordingCuts![0]!.clip);
      if (!holder) continue;
      // Only a tail: an insert that would lose as much as it keeps is mostly brief pictures, and what to show there is the run's call.
      const kept = holder.end === "end" ? to - holder.clip.timelineIn : clipEnd(holder.clip) - to;
      if (Math.abs(edge - to) >= kept) continue;
      const patches: TimelineOp[] = [];
      for (const { clip, end } of moving) {
        const asset = assets.get(clip.mediaId), speed = clip.speed ?? 1;
        if (!stable(clip.id) || (clip.volume > 0 && asset?.hasAudio !== false)) { patches.length = 0; break; }
        const delta = to - (end === "start" ? clip.timelineIn : clipEnd(clip));
        const sourceIn = end === "start" ? clip.sourceIn + delta * speed : clip.sourceIn;
        const sourceOut = end === "end" ? clip.sourceOut + delta * speed : clip.sourceOut;
        if (sourceIn < 0 || sourceOut <= sourceIn || (asset?.duration && sourceOut > asset.duration + 1e-6)) { patches.length = 0; break; }
        patches.push({ op: "updateClip", clipId: clip.id, patch: end === "start"
          ? { timelineIn: to, sourceIn, ...(clip.keyframes?.length && { keyframes: clip.keyframes.map(k => ({ ...k, time: k.time - delta })) }) }
          : { sourceOut } } as TimelineOp);
      }
      if (!patches.length) continue;
      let next: Timeline;
      try { next = applyOps(tl, patches); } catch { continue; }
      const moved = new Set(moving.map(e => e.clip.id));
      const overlaps = next.tracks.some(track => track.clips.some((c, i) => i > 0 && (moved.has(c.id) || moved.has(track.clips[i - 1]!.id)) &&
        c.timelineIn < clipEnd(track.clips[i - 1]!) - 1e-6));
      if (overlaps || !fillsFrame(next, media, canvas, (edge + to) / 2) ||
        briefPictures(next, media, canvas, BRIEF_PICTURE_SECONDS, cuts).some(f => near(f.from, to, 0.002) || near(f.to, to, 0.002))) continue;
      tl = next;
      ops.push(...patches);
      done.push(edge);
      const cut = flashes.flatMap(f => f.recordingCuts!).find(c => near(c.at, to, 0.002))!;
      met.push({ from: r3(edge), to: r3(to), seconds: r3(Math.abs(edge - to)), clips: moving.map(e => e.clip.id), source: cut.source });
      break;
    }
  }
  return { ops, met };
}

/** Whether an opaque picture fills the whole video at `t`, so no empty background shows. */
function fillsFrame(tl: Timeline, media: readonly MediaAsset[], canvas: { width: number; height: number }, t: number) {
  const assets = new Map(media.map(m => [m.id, m]));
  return tl.tracks.some(track => track.kind === "video" && !track.hidden && track.clips.some(clip => {
    if (clip.kind !== "media" || clip.enabled === false || clip.opacity < 1 || !(clip.timelineIn <= t && t < clipEnd(clip))) return false;
    const asset = assets.get(clip.mediaId);
    if (!asset || (asset.kind !== "video" && asset.kind !== "image") || asset.hasAlpha || clip.transform?.rotation) return false;
    const box = pictureBox(clip, t - clip.timelineIn, { width: asset.width || canvas.width, height: asset.height || canvas.height }, canvas);
    return box[0] <= 0.004 && box[1] <= 0.004 && box[2] >= 0.996 && box[3] >= 0.996;
  }));
}

export const MET_RECORDING_CUT_NEXT = "Each edge in metRecordingCut ran past a cut in its recording by pictures that each played under a second, " +
  "so the viewer saw them for a moment before the picture changed again: Scarlet moved the listed clips' edges from `from` to `to`, onto the recording's cut " +
  "at `source` seconds of it, so the picture now changes there.";
