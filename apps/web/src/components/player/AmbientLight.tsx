import { useEffect, useRef, type RefObject } from "react";

/** Canvas pixels per screen pixel: the glow is soft, so a coarse copy of the picture is all it needs. */
const SCALE = 1 / 8;
/** How often the glow looks at the picture, in ms. */
const TICK = 120;
/** How much of the frame goes into the glow each TICK, so it eases from one shot to the next instead of flickering. */
const EASE = 0.3;
/** How long the glow keeps easing after the picture last changed, until it has settled on it, in ms. */
const SETTLE = 1700;
/** The glow reaches this far past the picture on each side, as a share of the picture's size. */
const SPREAD = 0.12;
/** The blur's passes, each a spread of nine copies this many canvas pixels apart: together about 50 screen pixels. */
const BLUR = [2, 4, 6];

/** The picture's place in a video element that letterboxes it (`object-fit: contain`). */
export function pictureRect(box: { width: number; height: number }, video: { videoWidth: number; videoHeight: number }) {
  const { width, height } = box;
  if (!video.videoWidth || !video.videoHeight || !width || !height) return { x: 0, y: 0, width, height };
  const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
  const w = video.videoWidth * scale, h = video.videoHeight * scale;
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
}

/** The picture on top in the monitor: a clip that plays over the video is later in it than the video it covers. */
export function shownVideo(monitor: HTMLElement) {
  const videos = [...monitor.querySelectorAll("video")].filter(v => !v.closest("[data-parked]") && v.readyState >= 2 && v.videoWidth > 0
    && v.getClientRects().length > 0 && getComputedStyle(v).visibility !== "hidden");
  return videos.at(-1);
}

const canvas2d = () => {
  const el = document.createElement("canvas");
  return { el, context: el.getContext("2d", { alpha: true }) };
};

/** Blur `from` into `to` by averaging nine copies of it, `r` pixels apart. */
function spread(from: HTMLCanvasElement, to: CanvasRenderingContext2D, r: number) {
  to.clearRect(0, 0, from.width, from.height);
  to.globalCompositeOperation = "lighter";
  to.globalAlpha = 1 / 9;
  for (const dx of [-r, 0, r]) for (const dy of [-r, 0, r]) to.drawImage(from, dx, dy);
  to.globalCompositeOperation = "source-over";
  to.globalAlpha = 1;
}

/**
 * The footage's own colours, glowing softly into the dark around the player and under the timeline, as a room lit by
 * its screen. It follows the picture as it plays and eases between shots. With motion reduced it holds still while the
 * picture plays and is set at once when it rests. It asks nothing of the video: it copies the frame on screen into a
 * small canvas behind the stage and blurs it there.
 *
 * The blur is the canvas's own. WebKit has no canvas filter, and a CSS blur on a canvas that changes repaints only the
 * part that was drawn on, so the light round the picture kept showing the frame before.
 */
export function AmbientLight({ stage, monitor }: { stage: RefObject<HTMLElement | null>; monitor: RefObject<HTMLElement | null> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current, area = stage.current;
    const context = el?.getContext("2d", { alpha: true });
    // The latest frame, the glow easing toward it, and two canvases the blur passes between.
    const frame = canvas2d(), glow = canvas2d(), passes = [canvas2d(), canvas2d()];
    if (!el || !area || !context || !frame.context || !glow.context || passes.some(p => !p.context)) return;
    const latest = frame.context, easing = glow.context;
    const all = [el, frame.el, glow.el, ...passes.map(p => p.el)];
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let shown: HTMLVideoElement | undefined, seen = "", settleUntil = 0, lastLook = 0, lit = false, blank = true;
    const fit = () => {
      const width = Math.max(1, Math.round(area.clientWidth * SCALE)), height = Math.max(1, Math.round(area.clientHeight * SCALE));
      if (el.width === width && el.height === height) return;
      for (const c of all) { c.width = width; c.height = height; }
      seen = ""; blank = true;
    };
    const light = (on: boolean) => { if (lit !== on) { lit = on; el.dataset.lit = on ? "true" : "false"; } };
    const look = () => {
      if (document.hidden || !monitor.current) return;
      fit();
      const video = shownVideo(monitor.current);
      if (!video) {
        if (lit) { context.clearRect(0, 0, el.width, el.height); easing.clearRect(0, 0, glow.el.width, glow.el.height); light(false); shown = undefined; blank = true; }
        return;
      }
      const still = reduceMotion.matches;
      // With motion reduced, a glow already drawn holds as it is while the picture plays.
      if (still && !blank && !video.paused && !video.ended) return;
      const box = video.getBoundingClientRect(), origin = area.getBoundingClientRect();
      const picture = pictureRect(box, video);
      const at = `${video.currentTime}|${box.left - origin.left}|${box.top - origin.top}|${picture.width}|${picture.height}`;
      const fresh = video !== shown, now = Date.now();
      if (fresh || blank || at !== seen) settleUntil = now + SETTLE;
      if (now > settleUntil) return;
      // A window out of sight runs its timers less often: the step follows the time since the last look, not the count.
      const step = 1 - (1 - EASE) ** Math.min(10, Math.max(0, now - lastLook) / TICK);
      lastLook = now;
      shown = video;
      seen = at;
      const x = (box.left - origin.left + area.scrollLeft + picture.x - picture.width * SPREAD) * SCALE;
      const y = (box.top - origin.top + area.scrollTop + picture.y - picture.height * SPREAD) * SCALE;
      const width = picture.width * (1 + 2 * SPREAD) * SCALE, height = picture.height * (1 + 2 * SPREAD) * SCALE;
      try {
        // The first look at a picture fills the glow at once. After that each look moves the whole glow a step toward
        // the frame, so light from a picture of another shape, or from before a resize, fades out too. With motion reduced
        // every look sets the glow at once.
        if (fresh || blank || still) {
          easing.clearRect(0, 0, glow.el.width, glow.el.height);
          easing.drawImage(video, x, y, width, height);
        } else {
          latest.clearRect(0, 0, frame.el.width, frame.el.height);
          latest.drawImage(video, x, y, width, height);
          easing.globalAlpha = step;
          easing.globalCompositeOperation = "destination-out";
          easing.fillRect(0, 0, glow.el.width, glow.el.height);
          easing.globalCompositeOperation = "lighter";
          easing.drawImage(frame.el, 0, 0);
          easing.globalCompositeOperation = "source-over";
          easing.globalAlpha = 1;
        }
        // Blur it pass by pass, the last pass straight onto the canvas on screen.
        let from = glow.el;
        BLUR.forEach((r, i) => {
          const to = i === BLUR.length - 1 ? { el, context } : passes[i % 2]!;
          spread(from, to.context!, r);
          from = to.el;
        });
        blank = false;
        light(true);
      } catch {
        // A frame that can't be drawn yet leaves the glow as it was.
      }
    };
    look();
    const timer = window.setInterval(look, TICK);
    return () => window.clearInterval(timer);
  }, [stage, monitor]);
  return <canvas ref={canvas} className="ambient-light" aria-hidden="true" data-lit="false" />;
}
