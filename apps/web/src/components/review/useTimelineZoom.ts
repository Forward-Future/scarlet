import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { usePlayerStore } from "../../stores/player";

interface TimeWindow { from: number; span: number }

interface ZoomFrame {
  view: TimeWindow;
  samples: TimeWindow;
  target?: TimeWindow;
  blend?: number;
}

/** How far off the middle the playhead stays after each doubling of a zoom in on it. */
const TOWARD_MIDDLE = .6;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export const timelinePosition = (time: number, start: number, end: number) => Number.isFinite(time) ? clamp(time, start, end) : start;

/** Keep the same scale and turn the page when playback or an external seek leaves the window. */
function follow(view: TimeWindow, time: number, start: number, end: number): TimeWindow {
  if (!view.span || (time >= view.from && time <= view.from + view.span)) return view;
  const page = Math.floor((time - view.from) / view.span);
  return { ...view, from: clamp(view.from + page * view.span, start, end - view.span) };
}

/** Inactivity gap before a wheel pan or zoom gesture resets its locked axis. */
const WHEEL_GESTURE_TIMEOUT_MS = 220;
/** Brief settle window after a pinch so finger-lift wheel drift doesn't pan or zoom. */
const PINCH_COOLDOWN_MS = 160;
/** Minimum horizontal travel (px) to commit a trackpad swipe to panning. */
const PAN_LOCK_PX = 4;
/** Minimum vertical travel (px) to commit a plain wheel gesture to zooming. */
const ZOOM_LOCK_PX = 10;
/** Minimum vertical-to-horizontal ratio required to enter plain-wheel zoom. */
const VERTICAL_LOCK_RATIO = 2.5;
/** Distance (px) at which an ambiguous diagonal swipe defaults to panning instead of zooming. */
const DIAGONAL_PAN_PX = 16;
/** Deliberate pinch scale change (ln ratio, ~8%) required to break out of an active pan. */
const PINCH_BREAKOUT = .08;
/** Deliberate ctrl+wheel travel (px) required to break out of an active pan. */
const CTRL_WHEEL_BREAKOUT_PX = 10;

/**
 * `carried` is the stretch the timeline it takes the place of was zoomed to. It starts on the same stretch, within its
 * own length, and stays there until the playhead moves.
 */
export function useTimelineZoom(track: RefObject<HTMLDivElement | null>, start: number, total: number,
  playhead: number | undefined, dragging: RefObject<unknown>, carried?: TimeWindow) {
  const end = start + total;
  const position = () => timelinePosition(playhead ?? usePlayerStore.getState().time, start, end);
  const minSpan = Math.min(1, total);
  const [frame, setFrame] = useState<ZoomFrame>(() => {
    if (carried) {
      const span = clamp(carried.span, minSpan, total);
      const view = { from: clamp(carried.from, start, end - span), span };
      return { view, samples: view };
    }
    const view = follow({ from: start, span: total }, position(), start, end);
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
    const playheadFraction = (position() - current.from) / current.span;
    const onPlayhead = fraction === undefined && playheadFraction >= 0 && playheadFraction <= 1;
    const anchor = fraction ?? (onPlayhead ? playheadFraction : .5);
    const span = clamp(current.span / factor, minSpan, total);
    let from = current.from + (current.span - span) * anchor;
    // Zooming in on the playhead brings it part of the way to the middle each time, so it never ends up on an edge.
    if (onPlayhead && span < current.span) from = position() - span * (.5 + (anchor - .5) * TOWARD_MIDDLE ** Math.log2(current.span / span));
    const next = { span, from: clamp(from, start, end - span) };
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

  /**
   * Turn the view, at the same scale, to the page that shows `time`, and say where it went. A drag held past the
   * timeline's edge sends the playhead to the video's start or end, which the view then shows instead of a playhead
   * gone off its side; following playback waits while a pointer is held.
   */
  const reveal = useCallback((time: number) => {
    const { view } = live.current;
    const next = follow(view, time, start, end);
    if (next !== view) move(next);
    return next;
  }, [start, end, move]);

  useLayoutEffect(() => {
    inspecting.current = false;
  }, [start, end, fitRange, stopZoom]);
  // Opening a review can fit or carry a view before the transport leaves the previous video's time.
  // Re-running the effect at that same time must not page away from the newly centered band.
  const lastPosition = useRef(position());
  useLayoutEffect(() => {
    const followPosition = (position: number) => {
      if (lastPosition.current === position) return;
      lastPosition.current = position;
      const { view, target } = live.current;
      if (dragging.current || target) return;
      if (inspecting.current && usePlayerStore.getState().playing &&
          (position < view.from || position > view.from + view.span)) return;
      inspecting.current = false;
      const next = follow(view, position, start, end);
      if (next !== view) move(next);
    };
    followPosition(position());
    if (playhead === undefined) return usePlayerStore.subscribe((state, previous) => {
      if (state.time !== previous.time) followPosition(timelinePosition(state.time, start, end));
    });
  }, [playhead, start, end, dragging, move]);

  useLayoutEffect(() => {
    const el = track.current!;
    type GestureMode = "pending" | "pan" | "zoom" | "pinch";
    let mode: GestureMode | undefined;
    let gestureAt = 0;
    let pendingX = 0;
    let pendingY = 0;
    let previousScale = 0;
    let pendingPinchScale = 0;
    let lastGestureScale = 0;
    let pendingPinchWheel = 0;

    function clearWheelState() {
      mode = undefined;
      pendingX = 0;
      pendingY = 0;
      pendingPinchWheel = 0;
    }

    function expireGesture(now: number) {
      if (!mode || previousScale) return;
      const timeout = mode === "pinch" ? PINCH_COOLDOWN_MS : WHEEL_GESTURE_TIMEOUT_MS;
      if (now - gestureAt > timeout) clearWheelState();
    }

    function fraction(x: number) {
      const rect = el.getBoundingClientRect();
      return rect.width && Number.isFinite(x) ? clamp((x - rect.left) / rect.width, 0, 1) : .5;
    }

    function panBy(deltaPx: number) {
      if (!deltaPx) return;
      const view = live.current.view;
      const delta = deltaPx / Math.max(1, el.clientWidth) * view.span;
      const next = { ...view, from: clamp(view.from + delta, start, end - view.span) };
      lookAt(next);
      move(next, "gesture");
    }

    function zoomWheel(deltaPx: number, clientX: number, pinch: boolean) {
      if (!deltaPx) return;
      const sensitivity = pinch ? .012 : .006;
      zoomBy(Math.exp(clamp(-deltaPx * sensitivity, -1, 1)), fraction(clientX), true);
    }

    function wheel(event: WheelEvent) {
      if (!total || dragging.current) return;
      event.preventDefault();
      if (previousScale) return;
      const now = performance.now();
      expireGesture(now);

      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1;
      const dx = event.deltaX * unit;
      const dy = event.deltaY * unit;

      if (event.ctrlKey) {
        if (mode === "pan") {
          pendingPinchWheel += dy;
          if (Math.abs(pendingPinchWheel) < CTRL_WHEEL_BREAKOUT_PX) return;
          const excess = pendingPinchWheel - Math.sign(pendingPinchWheel) * CTRL_WHEEL_BREAKOUT_PX;
          mode = "pinch";
          pendingPinchWheel = 0;
          gestureAt = now;
          zoomWheel(excess, event.clientX, true);
          return;
        }
        mode = "pinch";
        pendingX = 0;
        pendingY = 0;
        pendingPinchWheel = 0;
        gestureAt = now;
        zoomWheel(dy, event.clientX, true);
        return;
      }

      // Keep plain wheel drift out of a pinch and its brief post-pinch settle window.
      if (mode === "pinch") return;

      if (event.shiftKey) {
        mode = "pan";
        pendingX = 0;
        pendingY = 0;
        pendingPinchWheel = 0;
        const delta = dx || dy;
        if (delta) {
          gestureAt = now;
          if (pendingPinchScale && lastGestureScale) pendingPinchScale = lastGestureScale;
          panBy(delta);
        }
        return;
      }

      if (mode === "pan") {
        if (dx) {
          gestureAt = now;
          pendingPinchWheel = 0;
          if (pendingPinchScale && lastGestureScale) pendingPinchScale = lastGestureScale;
          panBy(dx);
        }
        return;
      }

      if (mode === "zoom") {
        if (dy) {
          gestureAt = now;
          zoomWheel(dy, event.clientX, false);
        }
        return;
      }

      if (!dx && !dy) return;
      mode = "pending";
      gestureAt = now;
      pendingX += dx;
      pendingY += dy;
      const absX = Math.abs(pendingX);
      const absY = Math.abs(pendingY);

      if (absX >= PAN_LOCK_PX && absX >= absY) {
        const delta = pendingX;
        mode = "pan";
        pendingX = 0;
        pendingY = 0;
        panBy(delta);
      } else if (absY >= ZOOM_LOCK_PX && absY >= VERTICAL_LOCK_RATIO * absX) {
        const delta = pendingY;
        mode = "zoom";
        pendingX = 0;
        pendingY = 0;
        zoomWheel(delta, event.clientX, false);
      } else if (Math.hypot(absX, absY) >= DIAGONAL_PAN_PX) {
        const delta = pendingX;
        mode = "pan";
        pendingX = 0;
        pendingY = 0;
        panBy(delta);
      }
    }

    // WKWebView reports trackpad magnification as cumulative gesture scales.
    // WebView2 reports it as Control + wheel, handled above.
    function gesture(event: Event) {
      const now = performance.now();
      // A pinch that ends during a drag has still ended: the wheel answers again after it.
      if (event.type === "gestureend") {
        const wasPinch = previousScale > 0;
        previousScale = 0;
        pendingPinchScale = 0;
        lastGestureScale = 0;
        if (!total || dragging.current) {
          clearWheelState();
          return;
        }
        event.preventDefault();
        if (wasPinch) {
          mode = "pinch";
          gestureAt = now;
        }
        return;
      }
      if (!total || dragging.current) return;
      event.preventDefault();
      expireGesture(now);
      const { scale, clientX } = event as Event & { scale: number; clientX: number };
      if (event.type === "gesturestart") {
        if (mode === "pan") {
          pendingPinchScale = lastGestureScale = scale || 1;
          return;
        }
        mode = "pinch";
        pendingX = 0;
        pendingY = 0;
        pendingPinchScale = 0;
        lastGestureScale = 0;
        pendingPinchWheel = 0;
        previousScale = scale || 1;
        gestureAt = now;
        return;
      }
      if (pendingPinchScale && Number.isFinite(scale) && scale > 0) {
        lastGestureScale = scale;
        if (mode === "pan" && Math.abs(Math.log(scale / pendingPinchScale)) < PINCH_BREAKOUT) return;
        mode = "pinch";
        previousScale = scale;
        pendingPinchScale = 0;
        lastGestureScale = 0;
        pendingPinchWheel = 0;
        gestureAt = now;
        return;
      }
      if (previousScale && Number.isFinite(scale) && scale > 0) {
        mode = "pinch";
        gestureAt = now;
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

  return { ...frame, minSpan, zoomBy, fitRange, stopZoom, reveal };
}
