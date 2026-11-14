import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import type { TimeRange } from "@scarlet/timeline";
import { clockRange, lengthLabel, playbackClock } from "../../lib/format";
import { QueuedImg } from "./QueuedImg";
import { useUiStore } from "../../stores/ui";

/** How near, in pixels, a dragged end comes to the edge of a cut or an edit before it lands on it. */
export const RANGE_SNAP_PX = 7;
/** A press on the ruler that moves less than this is a press, not a range: it moves the playhead as it always did. */
const PRESS_SLOP_PX = 3;
/** A handle held still this long opens the close-up. */
export const HOLD_MS = 350;
const HOLD_SLOP_PX = 4;
/** In the close-up the end moves this many times slower than the pointer, one frame at a time. */
export const PRECISE_SLOWDOWN = 10;
/** A drag that stops this still, for HOLD_MS, goes into the close-up where it is. */
const STILL_SLOP_PX = 2;
/** The close-up's row of pictures: this many, each this many frames after the one before. */
const LOUPE_PICTURES = 9, LOUPE_STEP_FRAMES = 3;

export const toFrame = (time: number, fps: number) => Math.round(time * fps) / fps;

/** The edge within `reach` seconds of `time` that is nearest to it, if there is one. */
export function snapTime(time: number, edges: readonly number[], reach: number) {
  let nearest: number | undefined, distance = reach;
  for (const edge of edges) {
    const delta = Math.abs(edge - time);
    if (delta <= distance) { nearest = edge; distance = delta; }
  }
  return nearest;
}

/** Where a range's end can land: both ends of the open edit's passage and of footage other cuts took out, and each marked edit. */
export function rangeEdges(band: TimeRange | undefined, gaps: readonly TimeRange[] | undefined, marks: readonly { time: number }[] | undefined) {
  const edges = new Set<number>();
  if (band) { edges.add(band.start); edges.add(band.end); }
  for (const gap of gaps ?? []) { edges.add(gap.start); edges.add(gap.end); }
  for (const mark of marks ?? []) edges.add(mark.time);
  return [...edges].sort((a, b) => a - b);
}

/** The two ends in order, at least one frame apart and inside the video. */
export function orderedRange(a: number, b: number, start: number, end: number, fps: number): TimeRange {
  const low = Math.max(start, Math.min(a, b)), high = Math.min(end, Math.max(a, b));
  if (high - low >= 1 / fps) return { start: low, end: high };
  const from = Math.max(start, Math.min(low, end - 1 / fps));
  return { start: from, end: Math.min(end, from + 1 / fps) };
}

interface Gesture {
  id: number;
  /** The end that stays where it is. */
  anchor: number;
  /** Which handle is held, or none for a range drawn on the ruler. */
  edge?: "start" | "end";
  from: number; span: number; left: number; width: number;
  x0: number; x: number;
  moved: boolean;
  /** Where the pointer last stood still, and the timer that opens the close-up once it has stood there long enough. */
  stillX: number;
  still?: number;
  /** Where the moving end is now. */
  at?: number;
  /** The range as last drawn. */
  last?: TimeRange;
  hold?: number;
  /** The close-up: the time and pointer position it opened at, and whether the end has moved in it since. */
  precise?: { time: number; x: number; moved?: boolean };
  paint?: number;
  stop(): void;
}

interface RangeSelect {
  slider: RefObject<HTMLDivElement | null>;
  /** The scrubber's own drag, which the zoom and the markers read to know a pointer is held. */
  drag: RefObject<object | null>;
  from: number; span: number;
  start: number; end: number;
  fps: number;
  edges: readonly number[];
  /** A picture of the video at a time, for the close-up's row of frames. */
  frameAt?(time: number, exact?: boolean): string | undefined;
  pictureAspect?: number;
  range?: TimeRange;
  onRange(range: TimeRange | undefined): void;
  onSeek(time: number): void;
  onScrubStart?(gesture: AbortSignal): (() => void) | undefined;
  /** A press on the ruler that never became a range. It takes off the range there was. */
  onPress(time: number): void;
  beforeGesture(): void;
}

/**
 * A stretch of the timeline the editor marks for the message they're writing. A drag along the ruler draws it and the
 * video follows the end that moves. Each end has a handle the height of the timeline: dragged, it lands on the edge of a
 * cut or an edit it comes near; held still, it opens a close-up where the end moves a frame at a time. A press held
 * still on the ruler opens the same close-up, to draw a range by frames from there, and so does a drag that stops and
 * holds still: the end it was moving carries on by frames. A click on the ruler takes the range off.
 */
export function useRangeSelect({ slider, drag, from, span, start, end, fps, edges, frameAt, pictureAspect = 16 / 9, range, onRange, onSeek, onScrubStart, onPress, beforeGesture }: RangeSelect) {
  const [live, setLive] = useState<{ range: TimeRange; moving: "start" | "end"; at: number; snapped: boolean; precise: boolean }>();
  const gesture = useRef<Gesture>(undefined);
  const now = useRef({ edges, fps, start, end, onRange, onSeek, onPress });
  useLayoutEffect(() => { now.current = { edges, fps, start, end, onRange, onSeek, onPress }; });
  useEffect(() => () => gesture.current?.stop(), []);

  const place = (g: Gesture) => {
    if (g.paint !== undefined) cancelAnimationFrame(g.paint);
    g.paint = undefined;
    // A frame asked for before the pointer let go draws nothing after it.
    if (gesture.current !== g) return;
    const { edges, fps, start, end, onSeek } = now.current;
    const perPixel = g.width > 0 ? g.span / g.width : 0;
    let time: number, snapped = false;
    if (g.precise) {
      time = toFrame(g.precise.time + (g.x - g.precise.x) * perPixel / PRECISE_SLOWDOWN, fps);
      // The close-up never pulls: a frame beside a cut has to be reachable. It only says when the end is on one.
      snapped = snapTime(time, edges, .5 / fps) !== undefined;
    } else {
      time = g.from + (g.x - g.left) * perPixel;
      const edge = snapTime(time, edges.filter(t => t !== g.anchor), RANGE_SNAP_PX * perPixel);
      snapped = edge !== undefined;
      time = edge ?? toFrame(time, fps);
    }
    time = Math.max(start, Math.min(end, time));
    g.at = time;
    const next = g.last = orderedRange(g.anchor, time, start, end, fps);
    setLive({ range: next, moving: time >= g.anchor ? "end" : "start", at: time, snapped, precise: !!g.precise });
    onSeek(time);
  };

  const begin = (e: PointerEvent<HTMLElement>, edge?: "start" | "end") => {
    const el = slider.current;
    if (!el || drag.current || gesture.current || e.button !== 0 || !e.isPrimary || !(span > 0)) return false;
    const rect = el.getBoundingClientRect();
    beforeGesture();
    const lifetime = new AbortController();
    const finish = onScrubStart?.(lifetime.signal);
    const perPixel = rect.width > 0 ? span / rect.width : 0;
    const pressed = from + (e.clientX - rect.left) * perPixel;
    const anchor = edge && range ? (edge === "start" ? range.end : range.start)
      : snapTime(pressed, edges, RANGE_SNAP_PX * perPixel) ?? toFrame(Math.max(start, Math.min(end, pressed)), fps);
    const id = e.pointerId;
    const g: Gesture = { id, anchor, edge, from, span, left: rect.left, width: rect.width, x0: e.clientX, x: e.clientX, moved: false, stillX: e.clientX, stop: () => {} };
    // A drag that stops and holds still goes into the close-up at the end it was moving, without letting go.
    const holdStill = () => {
      clearTimeout(g.still);
      g.stillX = g.x;
      g.still = window.setTimeout(() => {
        if (gesture.current !== g || g.precise || g.at === undefined) return;
        g.precise = { time: g.at, x: g.x };
        place(g);
      }, HOLD_MS);
    };
    const move = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== id) return;
      g.x = event.clientX;
      if (!g.precise && Math.abs(g.x - g.x0) > (edge ? HOLD_SLOP_PX : PRESS_SLOP_PX)) {
        g.moved = true;
        clearTimeout(g.hold);
      }
      if (g.moved && !g.precise && Math.abs(g.x - g.stillX) > STILL_SLOP_PX) holdStill();
      if (g.precise && g.x !== g.precise.x) g.precise.moved = true;
      if (g.moved || g.precise) g.paint ??= requestAnimationFrame(() => place(g));
    };
    const up = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== id) return;
      const cancelled = event.type === "pointercancel";
      if (!cancelled) g.x = event.clientX;
      // A press held on the ruler and let go without moving draws nothing: the close-up opened, and nothing was chosen.
      const drawn = !cancelled && (g.moved || (!!g.precise && (!!edge || !!g.precise.moved)));
      if (drawn) place(g);
      g.stop();
      setLive(undefined);
      if (drawn && g.last) now.current.onRange(g.last);
      else {
        if (!cancelled && !edge) {
          if (range) now.current.onRange(undefined);
          now.current.onPress(Math.max(now.current.start, Math.min(now.current.end, pressed)));
        }
      }
    };
    g.stop = () => {
      if (gesture.current !== g) return;
      gesture.current = undefined;
      clearTimeout(g.hold);
      clearTimeout(g.still);
      if (g.paint !== undefined) cancelAnimationFrame(g.paint);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
      if (drag.current === held) drag.current = null;
      lifetime.abort();
      finish?.();
    };
    // The scrubber's own drag slot says a pointer is held, so the zoom waits and the markers don't light.
    const held = { id: -1, start: from, span, x: e.clientX, lifetime, finish: undefined };
    drag.current = held;
    gesture.current = g;
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    // Held still, the press opens the close-up: on a handle at that end, on the ruler at the frame pressed.
    g.hold = window.setTimeout(() => {
      if (gesture.current !== g || g.moved) return;
      g.precise = { time: edge && range ? (edge === "start" ? range.start : range.end) : anchor, x: g.x };
      place(g);
    }, HOLD_MS);
    return true;
  };

  const shown = live?.range ?? range;
  const lit = useUiStore(s => s.aimLit);
  const nudge = (edge: "start" | "end", e: KeyboardEvent<HTMLButtonElement>) => {
    if (!range || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onRange(undefined); return; }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    const step = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 10 : 1) / fps;
    const moved = toFrame(Math.max(start, Math.min(end, (edge === "start" ? range.start : range.end) + step)), fps);
    const next = edge === "start" ? { start: Math.min(moved, range.end - 1 / fps), end: range.end } : { start: range.start, end: Math.max(moved, range.start + 1 / fps) };
    onRange(next);
    onSeek(edge === "start" ? next.start : next.end);
  };

  const percent = (t: number) => span ? (t - from) / span * 100 : 0;
  let layer: ReactNode = null;
  if (shown && shown.end > from && shown.start < from + span) {
    const left = Math.max(0, percent(shown.start)), right = Math.min(100, percent(shown.end));
    const handle = (edge: "start" | "end") => {
      const time = edge === "start" ? shown.start : shown.end;
      if (time < from || time > from + span) return null;
      const held = live?.moving === edge;
      return <button key={edge} type="button" className={`timeline-range-handle is-${edge}${held ? " is-held" : ""}${held && live.snapped ? " is-snapped" : ""}`}
        style={{ left: `${percent(time)}%` }}
        aria-label={`${edge === "start" ? "Start" : "End"} of the marked range, ${playbackClock(time)}`}
        title="Drag to adjust · hold for frame steps · ← → one frame"
        onPointerDown={e => { if (begin(e, edge)) { e.stopPropagation(); e.currentTarget.focus({ preventScroll: true }); } }}
        onKeyDown={e => nudge(edge, e)} />;
    };
    // The close-up follows where the moving end is, also the instant a held press opens it with nothing drawn yet.
    const edgeTime = live?.at;
    layer = <>
      <span aria-hidden="true" className={`timeline-range${live ? " is-live" : ""}${lit ? " is-lit" : ""}`} style={{ left: `${left}%`, width: `${Math.max(0, right - left)}%` }} />
      {live && !live.precise && <span aria-hidden="true" className="timeline-range-time" style={{ left: `${(left + right) / 2}%` }}>
        {clockRange(live.range.start, live.range.end)} · {lengthLabel(live.range.end - live.range.start)}</span>}
      {handle("start")}{handle("end")}
      {live?.precise && edgeTime !== undefined && <RangeLoupe time={edgeTime} at={percent(edgeTime)} fps={fps} inside={live.moving === "end" ? "before" : "after"}
        snapped={live.snapped} edges={edges} frameAt={frameAt} pictureAspect={pictureAspect} />}
    </>;
  }
  return { begin, layer, marking: !!live };
}

/**
 * The close-up over a held end, as precise seeking shows it: the frame the end is on, and under it a row of the video's
 * pictures either side, a few frames apart. The row moves on only when the end passes one of its pictures, so its
 * pictures load once; a line over it shows where between them the end is. A tick marks each frame, and a red one the
 * edge of a cut or an edit.
 */
function RangeLoupe({ time, at, fps, inside, snapped, edges, frameAt, pictureAspect }: { time: number; at: number; fps: number; inside: "before" | "after";
  snapped: boolean; edges: readonly number[]; frameAt?(time: number, exact?: boolean): string | undefined; pictureAspect: number }) {
  const frame = Math.round(time * fps);
  const first = (Math.floor(frame / LOUPE_STEP_FRAMES) - Math.floor(LOUPE_PICTURES / 2)) * LOUPE_STEP_FRAMES;
  const count = LOUPE_PICTURES * LOUPE_STEP_FRAMES;
  const share = (f: number) => (f - first) / count * 100;
  const ticks = [];
  for (let f = Math.max(0, first); f < first + count; f++) {
    const edge = snapTime(f / fps, edges, .5 / fps) !== undefined;
    ticks.push(<i key={f} className={`${f % Math.round(fps) === 0 ? "is-second" : ""}${edge ? " is-edge" : ""}`} style={{ left: `${share(f)}%` }} />);
  }
  const pictures = Array.from({ length: LOUPE_PICTURES }, (_, i) => first + i * LOUPE_STEP_FRAMES);
  const now = share(frame);
  return <span className="timeline-range-loupe" role="status" style={{ left: `clamp(var(--loupe-half), ${at}%, calc(100% - var(--loupe-half)))` }}>
    <span className="timeline-range-loupe-frame" style={{ aspectRatio: pictureAspect }}>
      {frameAt && <img key={frame} src={frameAt(frame / fps, true)} alt="" draggable={false} decoding="async" />}
    </span>
    <span className="timeline-range-loupe-head"><b>{playbackClock(time)}</b><small>{snapped ? "On an edit’s edge" : "Frame steps"}</small></span>
    <span className="timeline-range-loupe-row" data-inside={inside} style={{ "--now": `${now}%` } as CSSProperties}>
      {pictures.map(f => <span key={f} className="timeline-range-loupe-picture" style={{ aspectRatio: pictureAspect }}>
        {frameAt && f >= 0 && <QueuedImg src={frameAt(f / fps, true)} alt="" draggable={false} decoding="async" />}
      </span>)}
      <span className="timeline-range-loupe-ticks">{ticks}</span>
      <i className="timeline-range-loupe-now" style={{ left: `${now}%` }} />
    </span>
  </span>;
}
