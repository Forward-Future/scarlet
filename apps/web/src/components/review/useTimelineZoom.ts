import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { usePlayerStore } from "../../stores/player";
import type { TimeRange } from "@scarlet/timeline";

interface TimeWindow { from: number; span: number }

interface ZoomFrame {
  view: TimeWindow;
  samples: TimeWindow;
  target?: TimeWindow;
  blend?: number;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Keep the same scale and turn the page when playback or an external seek leaves the window. */
function follow(view: TimeWindow, time: number, start: number, end: number): TimeWindow {
  if (!view.span || (time >= view.from && time <= view.from + view.span)) return view;
  const page = Math.floor((time - view.from) / view.span);
  return { ...view, from: clamp(view.from + page * view.span, start, end - view.span) };
}

/**
 * `carried` is the stretch the timeline it takes the place of was zoomed to. It starts on the same stretch, within its
 * own length, and stays there until the playhead moves.
 */
export function useTimelineZoom(track: RefObject<HTMLDivElement | null>, start: number, total: number,
  position: number, cueTime: number | undefined, dragging: RefObject<unknown>, previewRequest?: number, passage?: TimeRange, carried?: TimeWindow) {
  const end = start + total;
  const minSpan = Math.min(1, total);
  const [frame, setFrame] = useState<ZoomFrame>(() => {
    if (carried) {
      const span = clamp(carried.span, minSpan, total);
      const view = { from: clamp(carried.from, start, end - span), span };
      return { view, samples: view };
    }
    const span = cueTime === undefined ? total : Math.min(6, total);
    const from = cueTime === undefined ? start : clamp(Math.floor(cueTime - span / 2), start, end - span);
    const view = follow({ from, span }, position, start, end);
    return { view, samples: view };
  });
  const live = useRef(frame);
  const inspecting = useRef(false);
  const animation = useRef<number | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);

  const cancel = useCallback(() => {
    if (animation.current !== undefined) cancelAnimationFrame(animation.current);
    animation.current = undefined;
    clearTimeout(timer.current);
  }, []);

  const paint = useCallback((next: ZoomFrame) => {
    live.current = next;
    setFrame(next);
  }, []);

  const move = useCallback((next: TimeWindow, mode: "snap" | "gesture" | "animate" = "snap") => {
    const current = live.current;
    const origin = current.view;
    if (mode === "animate" && current.target?.from === next.from && current.target.span === next.span) return;
    cancel();
    const settle = () => paint({ view: next, samples: next });
    if (next.from === origin.from && next.span === origin.span) {
      if (current.target || current.samples !== origin) settle();
      return;
    }
    const samples = current.target && (current.blend ?? 0) >= 0.5 ? current.target : current.samples;
    if (mode === "gesture") {
      paint({ view: next, samples });
      timer.current = window.setTimeout(settle, 140);
      return;
    }
    if (mode !== "animate" || !origin.span || !next.span || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      settle();
      return;
    }

    // Interpolate magnification logarithmically so an hour-to-seconds zoom doesn't jump at the end.
    const ratio = next.span / origin.span;
    const duration = Math.min(480, 240 + 32 * Math.abs(Math.log2(ratio)));
    const began = performance.now();
    paint({ view: origin, samples, target: next, blend: 0 });
    function tick(now: number) {
      const t = clamp((now - began) / duration, 0, 1);
      if (t === 1) {
        animation.current = undefined;
        settle();
        return;
      }
      const blend = t * t * (3 - 2 * t);
      const span = origin.span * ratio ** blend;
      // At every scale, keep the zoom anchor in the same place on the ruler.
      const travel = ratio === 1 ? blend : (span - origin.span) / (next.span - origin.span);
      const from = origin.from + (next.from - origin.from) * travel;
      paint({ view: { from, span }, samples, target: next, blend });
      animation.current = requestAnimationFrame(tick);
    }
    animation.current = requestAnimationFrame(tick);
  }, [cancel, paint]);

  const stopZoom = useCallback(() => {
    if (live.current.target) move(live.current.view);
  }, [move]);

  /**
   * The editor moved the view by hand. While the video plays with the playhead out of that view, it stays where they
   * put it, as a fitted range does, instead of going back to the playhead on the next frame.
   */
  function lookAt(view: TimeWindow) {
    const { time, playing } = usePlayerStore.getState();
    inspecting.current = playing && view.span < total && (time < view.from || time > view.from + view.span);
  }

  function zoomBy(factor: number, fraction?: number, continuous = false) {
    if (!total || dragging.current || !(factor > 0)) return;
    const current = (!continuous && live.current.target) || live.current.view;
    const playheadFraction = (position - current.from) / current.span;
    const anchor = fraction ?? (playheadFraction >= 0 && playheadFraction <= 1 ? playheadFraction : .5);
    const span = clamp(current.span / factor, minSpan, total);
    const next = { span, from: clamp(current.from + (current.span - span) * anchor, start, end - span) };
    lookAt(next);
    move(next, continuous ? "gesture" : "animate");
  }

  const fitRange = useCallback((from = start, to = end, animate = true) => {
    const span = clamp(to - from, minSpan, total);
    const left = clamp((from + to - span) / 2, start, end - span);
    const { time, playing } = usePlayerStore.getState();
    inspecting.current = playing && span < total && (time < left || time > left + span);
    move({ from: left, span }, animate ? "animate" : "snap");
  }, [start, end, minSpan, total, move]);

  useLayoutEffect(() => {
    inspecting.current = false;
    if (!previewRequest || !passage) return;
    if (passage.end - passage.start > live.current.view.span) {
      const padding = Math.max(0.5, (passage.end - passage.start) * 0.15);
      fitRange(Math.max(start, passage.start - padding), Math.min(end, passage.end + padding), false);
    } else stopZoom();
  }, [previewRequest, passage?.start, passage?.end, start, end, fitRange, stopZoom]);
  // Opening a review can fit or carry a view before the transport leaves the previous video's time.
  // Re-running the effect at that same time must not page away from the newly centered band.
  const lastPosition = useRef(position);
  useLayoutEffect(() => {
    if (lastPosition.current === position) return;
    lastPosition.current = position;
    const { view, target } = live.current;
    if (dragging.current || target) return;
    if (inspecting.current && usePlayerStore.getState().playing &&
        (position < view.from || position > view.from + view.span)) return;
    inspecting.current = false;
    const next = follow(view, position, start, end);
    if (next !== view) move(next);
  }, [position, start, end, dragging, move]);

  useLayoutEffect(() => {
    const el = track.current!;
    let previousScale = 0;
    function fraction(x: number) {
      const rect = el.getBoundingClientRect();
      return rect.width && Number.isFinite(x) ? clamp((x - rect.left) / rect.width, 0, 1) : .5;
    }
    function wheel(event: WheelEvent) {
      if (!total || dragging.current) return;
      event.preventDefault();
      if (previousScale) return;
      const view = live.current.view;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1;
      const horizontal = !event.ctrlKey && (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY));
      if (horizontal) {
        const delta = (event.deltaX || event.deltaY) * unit / Math.max(1, el.clientWidth) * view.span;
        const next = { ...view, from: clamp(view.from + delta, start, end - view.span) };
        lookAt(next);
        move(next, "gesture");
      } else {
        const sensitivity = event.ctrlKey ? .012 : .006;
        zoomBy(Math.exp(clamp(-event.deltaY * unit * sensitivity, -1, 1)), fraction(event.clientX), true);
      }
    }
    // WKWebView reports trackpad magnification as cumulative gesture scales.
    // WebView2 reports it as Control + wheel, handled above.
    function gesture(event: Event) {
      if (!total || dragging.current) return;
      event.preventDefault();
      const { scale, clientX } = event as Event & { scale: number; clientX: number };
      if (event.type === "gestureend") previousScale = 0;
      else if (event.type === "gesturestart") previousScale = scale || 1;
      else if (previousScale && Number.isFinite(scale) && scale > 0) {
        zoomBy(scale / previousScale, fraction(clientX), true);
        previousScale = scale;
      }
    }
    el.addEventListener("wheel", wheel, { passive: false });
    for (const name of ["gesturestart", "gesturechange", "gestureend"]) el.addEventListener(name, gesture, { passive: false });
    return () => {
      cancel();
      el.removeEventListener("wheel", wheel);
      for (const name of ["gesturestart", "gesturechange", "gestureend"]) el.removeEventListener(name, gesture);
    };
  }, [track, dragging, start, total, end, cancel, move]);

  return { ...frame, minSpan, zoomBy, fitRange, stopZoom };
}
