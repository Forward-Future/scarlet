import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import type { TimeRange } from "@scarlet/timeline";
import { playbackClock } from "../../lib/format";
import { appLog } from "../../lib/appLog";
import type { ScrubRelease } from "../../lib/player";
import { DimMs } from "../ui/primitives";
import { HOLD_MS, LOUPE_PX_PER_FRAME, RangeLoupe, lastFrameBefore, type LoupeSheet } from "./TimelineRange";

/** How far the pointer must move off an edge handle before a press becomes a drag (matches TimelineRange). */
const HOLD_SLOP_PX = 4;
const STILL_SLOP_PX = 2;

export interface CutEdgeReadout {
  /** Plain-language summary of what this move changes (e.g. “Put back “really””, “Take out “felt””, “Put back whole cut”). */
  text: string;
  /** Semantic tone for the readout text. */
  tone: "put-back" | "take-out" | "neutral";
  /** Signed length change label, e.g. "+0.43 s" or "−0.20 s". */
  delta?: string;
}

export interface CutAdjustOptions {
  /** Legal bounds for the open edit's start and end edges, in the timeline's displayed clock. */
  bounds: { minStart: number; maxStart: number; minEnd: number; maxEnd: number };
  /** Visual tone matching the open band: coral for an applied cut, amber for a waiting call, light for a timed edit. */
  tone?: "cut" | "call" | "edit";
  /** Prefix for the live band duration pill while dragging ("Took out", "Takes out", or the edit kind like "Text" / "Zoom"). */
  bandPrefix?: string;
  /** Live band label when both edges are pulled together to zero (default "Put back"). */
  removeLabel?: string;
  /** Describe the frame/words affected between the original edge and the live edge. */
  describeEdge?(edge: "start" | "end", oldTime: number, newTime: number, nextRange: TimeRange): CutEdgeReadout | undefined;
  /** Commit the adjusted range (in the timeline's displayed clock) on drag release or keyboard nudge. */
  onCommit(next: TimeRange): void;
}

interface CutTrimInputs {
  slider: RefObject<HTMLDivElement | null>;
  drag: RefObject<object | null>;
  from: number;
  span: number;
  start: number;
  end: number;
  fps: number;
  band?: TimeRange;
  leaving?: boolean;
  cutAdjust?: CutAdjustOptions;
  edges: readonly number[];
  frameAt?(time: number, exact?: boolean): string | undefined;
  sheet?: LoupeSheet;
  pictureAspect?: number;
  onSeek(time: number): void;
  onScrubStart?(gesture: AbortSignal): ((release?: ScrubRelease) => void) | undefined;
  beforeGesture(): void;
}

interface Gesture {
  id: number;
  edge: "start" | "end";
  orig: TimeRange;
  from: number;
  span: number;
  left: number;
  width: number;
  x0: number;
  x: number;
  moved: boolean;
  stillX: number;
  still?: number;
  hold?: number;
  at: number;
  last: TimeRange;
  precise?: { time: number; x: number; at: number };
  paint?: number;
  stop(): void;
}

const toFrame = (time: number, fps: number) => Math.round(time * fps) / fps;
const clampTime = (time: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, time));

/**
 * Quiet, hover-only edge handles on an open cut's band. Invisible at rest; hovering either edge reveals a slim grip
 * to pull clipped footage back in or trim further. Dragging seeks the player to the exact edge frame, shows a compact
 * word/time readout, and holding still opens Scarlet's frame-step close-up (`RangeLoupe`). Releasing commits once.
 */
export function useCutTrim({
  slider, drag, from, span, start, end, fps, band, leaving, cutAdjust, edges, frameAt, sheet, pictureAspect = 16 / 9,
  onSeek, onScrubStart, beforeGesture,
}: CutTrimInputs) {
  const [live, setLive] = useState<{
    edge: "start" | "end";
    orig: TimeRange;
    range: TimeRange;
    at: number;
    precise?: number;
  }>();
  const gesture = useRef<Gesture>(undefined);
  const now = useRef({ band, cutAdjust, fps, start, end, onSeek });
  useLayoutEffect(() => { now.current = { band, cutAdjust, fps, start, end, onSeek }; });
  useEffect(() => () => gesture.current?.stop(), []);
  // Cancel an active drag if the cut closes or leaves under the pointer.
  useEffect(() => {
    if (!band || !cutAdjust || leaving) {
      gesture.current?.stop();
      setLive(undefined);
    }
  }, [!band, !cutAdjust, !!leaving]); // eslint-disable-line react-hooks/exhaustive-deps

  const clampEdge = (edge: "start" | "end", raw: number, orig: TimeRange, bounds: CutAdjustOptions["bounds"], rate: number, lo: number, hi: number) => {
    const snapped = toFrame(raw, rate);
    if (edge === "start") {
      const min = Math.max(lo, bounds.minStart);
      const max = Math.min(hi, bounds.maxStart, orig.end);
      return clampTime(snapped, min, Math.max(min, max));
    }
    const min = Math.max(lo, bounds.minEnd, orig.start);
    const max = Math.min(hi, bounds.maxEnd);
    return clampTime(snapped, Math.min(min, max), max);
  };

  const place = (g: Gesture) => {
    if (g.paint !== undefined) cancelAnimationFrame(g.paint);
    g.paint = undefined;
    if (gesture.current !== g) return;
    const { cutAdjust: adj, fps: rate, start: lo, end: hi, onSeek: seek } = now.current;
    if (!adj) return;
    const perPixel = g.width > 0 ? g.span / g.width : 0;
    const raw = g.precise
      ? g.precise.time + (g.x - g.precise.x) / LOUPE_PX_PER_FRAME / rate
      : g.from + (g.x - g.left) * perPixel;
    const at = clampEdge(g.edge, raw, g.orig, adj.bounds, rate, lo, hi);
    g.at = at;
    const next: TimeRange = g.edge === "start" ? { start: at, end: g.orig.end } : { start: g.orig.start, end: at };
    g.last = next;
    setLive({ edge: g.edge, orig: g.orig, range: next, at, precise: g.precise?.at });
    seek(at);
  };

  const begin = (e: PointerEvent<HTMLElement>, edge: "start" | "end") => {
    const el = slider.current;
    if (!el || !band || !cutAdjust || leaving || drag.current || gesture.current || e.button !== 0 || !e.isPrimary || !(span > 0)) return false;
    const rect = el.getBoundingClientRect();
    beforeGesture();
    const lifetime = new AbortController();
    const finish = onScrubStart?.(lifetime.signal);
    const id = e.pointerId;
    const orig = { start: band.start, end: band.end };
    const startAt = edge === "start" ? orig.start : orig.end;
    const g: Gesture = {
      id, edge, orig, from, span, left: rect.left, width: rect.width, x0: e.clientX, x: e.clientX,
      moved: false, stillX: e.clientX, at: startAt, last: orig, stop: () => {},
    };

    const holdStill = () => {
      clearTimeout(g.still);
      g.stillX = g.x;
      g.still = window.setTimeout(() => {
        if (gesture.current !== g || g.precise) return;
        g.precise = { time: g.at, x: g.x, at: (g.at - g.from) / g.span * 100 };
        place(g);
      }, HOLD_MS);
    };

    const move = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== id) return;
      g.x = event.clientX;
      if (!g.precise && Math.abs(g.x - g.x0) > HOLD_SLOP_PX) {
        g.moved = true;
        clearTimeout(g.hold);
      }
      if (g.moved && !g.precise && Math.abs(g.x - g.stillX) > STILL_SLOP_PX) holdStill();
      if (g.moved || g.precise) g.paint ??= requestAnimationFrame(() => place(g));
    };

    const finishDrag = (cancelled: boolean, clientX?: number) => {
      if (!cancelled && clientX !== undefined) g.x = clientX;
      if (!cancelled && (g.moved || g.precise)) place(g);
      const next = g.last;
      const changed = !cancelled && (
        Math.abs(next.start - g.orig.start) >= 0.5 / now.current.fps ||
        Math.abs(next.end - g.orig.end) >= 0.5 / now.current.fps
      );
      g.stop();
      setLive(undefined);
      if (changed) {
        appLog("timeline", "cut-edge-adjusted", { edge, from: edge === "start" ? g.orig.start : g.orig.end, to: edge === "start" ? next.start : next.end });
        now.current.cutAdjust?.onCommit(next);
      }
    };

    const up = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== id) return;
      finishDrag(event.type === "pointercancel", event.clientX);
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      finishDrag(true);
    };
    const lost = () => finishDrag(true);

    g.stop = () => {
      if (gesture.current !== g) return;
      gesture.current = undefined;
      el.removeAttribute("data-escape-owner");
      clearTimeout(g.hold);
      clearTimeout(g.still);
      if (g.paint !== undefined) cancelAnimationFrame(g.paint);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", lost);
      if (drag.current === held) drag.current = null;
      lifetime.abort();
      // Adjusting an edge does not pick a point to play from: play on only if the video was playing.
      finish?.({ marked: true });
    };

    const held = { id: -2, start: from, span, x: e.clientX, lifetime, finish: undefined };
    drag.current = held;
    gesture.current = g;
    // Claim Esc for the whole gesture so earlier card/page capture listeners don't close the card before `key` runs.
    el.setAttribute("data-escape-owner", "");
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", lost);

    g.hold = window.setTimeout(() => {
      if (gesture.current !== g || g.moved) return;
      g.precise = { time: startAt, x: g.x, at: (startAt - g.from) / g.span * 100 };
      place(g);
    }, HOLD_MS);
    return true;
  };

  const nudge = (edge: "start" | "end", e: KeyboardEvent<HTMLButtonElement>) => {
    if (!band || !cutAdjust || leaving || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    const step = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 10 : 1) / fps;
    const base = edge === "start" ? band.start : band.end;
    const at = clampEdge(edge, base + step, band, cutAdjust.bounds, fps, start, end);
    if (Math.abs(at - base) < 0.5 / fps) return;
    const next: TimeRange = edge === "start" ? { start: at, end: band.end } : { start: band.start, end: at };
    onSeek(at);
    cutAdjust.onCommit(next);
  };

  const shown = live?.range ?? band;
  const percent = (t: number) => span ? (t - from) / span * 100 : 0;
  let layer: ReactNode = null;
  if (shown && cutAdjust && !leaving && span > 0 && shown.end > from && shown.start < from + span) {
    const halfFrame = 0.5 / fps;
    const canMoveStart = cutAdjust.bounds.minStart < (live?.orig.start ?? shown.start) - halfFrame
      || cutAdjust.bounds.maxStart > (live?.orig.start ?? shown.start) + halfFrame;
    const canMoveEnd = cutAdjust.bounds.minEnd < (live?.orig.end ?? shown.end) - halfFrame
      || cutAdjust.bounds.maxEnd > (live?.orig.end ?? shown.end) + halfFrame;
    const toneClass = cutAdjust.tone === "call" ? " is-call" : cutAdjust.tone === "edit" ? " is-edit" : "";
    const subject = cutAdjust.tone === "edit" ? "edit" : "cut";
    const visEps = Math.max(1e-6, span * 1e-6);
    const handle = (edge: "start" | "end") => {
      if (edge === "start" ? !canMoveStart : !canMoveEnd) return null;
      const time = edge === "start" ? shown.start : shown.end;
      if (time < from - visEps || time > from + span + visEps) return null;
      const held = live?.edge === edge;
      return (
        <button
          key={edge}
          type="button"
          className={`timeline-cut-handle is-${edge}${toneClass}${held ? " is-held" : ""}`}
          style={{ left: `${Math.max(0, Math.min(100, percent(time)))}%` }}
          aria-label={`Adjust ${edge === "start" ? "start" : "end"} of ${subject}, ${playbackClock(time)}`}
          title={`Drag edge to adjust ${subject} · hold for frame steps · ← → one frame`}
          data-cut-handle={edge}
          data-no-scrub-preview=""
          onPointerDown={e => {
            if (begin(e, edge)) {
              e.stopPropagation();
              e.currentTarget.focus({ preventScroll: true });
            }
          }}
          onKeyDown={e => nudge(edge, e)}
        />
      );
    };

    const readout = live && live.precise === undefined
      ? cutAdjust.describeEdge?.(live.edge, live.edge === "start" ? live.orig.start : live.orig.end, live.at, live.range)
      : undefined;
    const origEdge = live ? (live.edge === "start" ? live.orig.start : live.orig.end) : undefined;
    const readoutAt = live ? Math.max(0, Math.min(100, percent(live.at))) : 50;

    layer = (
      <>
        {origEdge !== undefined && origEdge >= from && origEdge <= from + span && (
          <i aria-hidden="true" className="timeline-cut-origin" style={{ left: `${percent(origEdge)}%` }} />
        )}
        {handle("start")}
        {handle("end")}
        {live && live.precise === undefined && (
          <span
            aria-live="polite"
            className={`timeline-cut-readout${toneClass}`}
            style={{ left: `${readoutAt}%`, transform: `translateX(${-readoutAt}%)` }}
          >
            <b className="timeline-cut-readout-time"><DimMs text={playbackClock(live.at)} /></b>
            {readout?.text && <span className={`timeline-cut-readout-text is-${readout.tone}`}>{readout.text}</span>}
            {readout?.delta && <span className="timeline-cut-readout-delta">{readout.delta}</span>}
          </span>
        )}
        {live?.precise !== undefined && (
          <RangeLoupe
            time={live.at}
            at={live.precise}
            fps={fps}
            last={lastFrameBefore(end, fps)}
            inside={live.edge === "end" ? "before" : "after"}
            snapped={false}
            edges={edges}
            frameAt={frameAt}
            sheet={sheet}
            pictureAspect={pictureAspect}
          />
        )}
      </>
    );
  }

  return {
    layer,
    liveBand: live?.range,
    active: !!live,
  };
}
