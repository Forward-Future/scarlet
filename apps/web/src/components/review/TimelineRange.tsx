import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import type { TimeRange } from "@scarlet/timeline";
import { clockRange, lengthLabel, playbackClock } from "../../lib/format";

/** How near, in pixels, a dragged end comes to the edge of a cut or an edit before it lands on it. */
export const RANGE_SNAP_PX = 7;
/** A press on the ruler that moves less than this is a press, not a range: it moves the playhead as it always did. */
const PRESS_SLOP_PX = 3;
/** A handle held still this long opens the close-up. */
export const HOLD_MS = 350;
const HOLD_SLOP_PX = 4;
/** In the close-up the end moves this many times slower than the pointer, one frame at a time. */
export const PRECISE_SLOWDOWN = 10;
/** The close-up shows this many seconds either side of the end it moves. */
const LOUPE_REACH_SECONDS = 1;

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
  /** The range as last drawn. */
  last?: TimeRange;
  hold?: number;
  /** The close-up: the time and pointer position it opened at. */
  precise?: { time: number; x: number };
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
  range?: TimeRange;
  onRange(range: TimeRange | undefined): void;
  onSeek(time: number): void;
  onScrubStart?(gesture: AbortSignal): (() => void) | undefined;
  /** A press on the ruler that never became a range. */
  onPress(time: number): void;
  beforeGesture(): void;
}

/**
 * A stretch of the timeline the editor marks for the message they're writing. A drag along the ruler draws it and the
 * video follows the end that moves. Each end has a handle: dragged, it lands on the edge of a cut or an edit it comes
 * near; held still, it opens a close-up where the end moves a frame at a time.
 */
export function useRangeSelect({ slider, drag, from, span, start, end, fps, edges, range, onRange, onSeek, onScrubStart, onPress, beforeGesture }: RangeSelect) {
  const [live, setLive] = useState<{ range: TimeRange; moving: "start" | "end"; snapped: boolean; precise: boolean }>();
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
    const next = g.last = orderedRange(g.anchor, time, start, end, fps);
    setLive({ range: next, moving: time >= g.anchor ? "end" : "start", snapped, precise: !!g.precise });
    onSeek(time >= g.anchor ? next.end : next.start);
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
    const g: Gesture = { id, anchor, edge, from, span, left: rect.left, width: rect.width, x0: e.clientX, x: e.clientX, moved: false, stop: () => {} };
    const move = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== id) return;
      g.x = event.clientX;
      if (!g.precise && Math.abs(g.x - g.x0) > (edge ? HOLD_SLOP_PX : PRESS_SLOP_PX)) {
        g.moved = true;
        clearTimeout(g.hold);
      }
      if (g.moved || g.precise) g.paint ??= requestAnimationFrame(() => place(g));
    };
    const up = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== id) return;
      const cancelled = event.type === "pointercancel";
      if (!cancelled) g.x = event.clientX;
      const drawn = !cancelled && (g.moved || !!g.precise);
      if (drawn) place(g);
      g.stop();
      setLive(undefined);
      if (drawn && g.last) now.current.onRange(g.last);
      else {
        if (!cancelled && !edge) now.current.onPress(Math.max(now.current.start, Math.min(now.current.end, pressed)));
      }
    };
    g.stop = () => {
      if (gesture.current !== g) return;
      gesture.current = undefined;
      clearTimeout(g.hold);
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
    if (edge && range) {
      g.hold = window.setTimeout(() => {
        if (gesture.current !== g || g.moved) return;
        g.precise = { time: edge === "start" ? range.start : range.end, x: g.x };
        place(g);
      }, HOLD_MS);
    }
    return true;
  };

  const shown = live?.range ?? range;
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
    const edgeTime = live && (live.moving === "start" ? live.range.start : live.range.end);
    layer = <>
      <span aria-hidden="true" className={live ? "timeline-range is-live" : "timeline-range"} style={{ left: `${left}%`, width: `${Math.max(0, right - left)}%` }} />
      {live && !live.precise && <span aria-hidden="true" className="timeline-range-time" style={{ left: `${(left + right) / 2}%` }}>
        {clockRange(live.range.start, live.range.end)} · {lengthLabel(live.range.end - live.range.start)}</span>}
      {handle("start")}{handle("end")}
      {live?.precise && edgeTime !== undefined && <RangeLoupe time={edgeTime} at={percent(edgeTime)} fps={fps} inside={live.moving === "end" ? "before" : "after"}
        snapped={live.snapped} edges={edges} />}
    </>;
  }
  return { begin, layer, marking: !!live };
}

/** The close-up over a held handle: two seconds round the end it moves, a tick for each frame, and the exact time. */
function RangeLoupe({ time, at, fps, inside, snapped, edges }: { time: number; at: number; fps: number; inside: "before" | "after"; snapped: boolean; edges: readonly number[] }) {
  const frames = Math.round(LOUPE_REACH_SECONDS * fps);
  const frame = Math.round(time * fps);
  const ticks = [];
  for (let i = -frames; i <= frames; i++) {
    const tickTime = (frame + i) / fps;
    if (tickTime < 0) continue;
    const second = (frame + i) % Math.round(fps) === 0;
    const edge = snapTime(tickTime, edges, .5 / fps) !== undefined;
    ticks.push(<i key={i} className={`${second ? "is-second" : ""}${edge ? " is-edge" : ""}`} style={{ left: `${50 + i / frames * 50}%` }} />);
  }
  return <span className="timeline-range-loupe" role="status" style={{ left: `clamp(110px, ${at}%, calc(100% - 110px))` }}>
    <span className="timeline-range-loupe-head"><b>{playbackClock(time)}</b><small>{snapped ? "On an edit’s edge" : "Frame steps"}</small></span>
    <span className="timeline-range-loupe-strip" data-inside={inside}>{ticks}<i className="is-now" style={{ left: "50%" }} /></span>
  </span>;
}
