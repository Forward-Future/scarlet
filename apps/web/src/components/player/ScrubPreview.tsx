import { interactiveFrameUrl } from "../review/thumbs";
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { playbackClock } from "../../lib/format";

const WIDTH = 320;
// Give a nearby seek a chance to finish while the pointer is moving. Once it
// settles elsewhere, a slow decode for the old position shouldn't hold it up.
const RETARGET_MS = 64;

/** A playable file on the displayed timeline's clock, including its edits. */
export interface HoverVideo { url: string; lastFrame: number }

function unload(video: HTMLVideoElement) {
  if (!video.hasAttribute("src")) return;
  video.removeAttribute("src");
  video.load();
}

/** Seek a paused copy of the playable file. Keep the decoder open between hovers. */
function hoverMovie(video: HTMLVideoElement, lastFrame: number, paint: (frame: HTMLVideoElement) => void, useStill: () => void) {
  let time: number | undefined;
  let requested: number | undefined;
  let drawn: number | undefined;
  let timeout: number | undefined;

  function clearWait() {
    window.clearTimeout(timeout);
    timeout = undefined;
  }
  function fail() {
    if (!video.hasAttribute("src")) return;
    clearWait();
    unload(video);
    if (time !== undefined) useStill();
  }
  function seek() {
    if (time === undefined || !video.hasAttribute("src")) return;
    let ready = false;
    if (video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0) {
      // The MP4's audio can extend past the final picture.
      const at = Math.floor(Math.min(time, lastFrame) * 4) / 4;
      if (at >= video.duration || (video.readyState >= 2 && !video.videoWidth)) { fail(); return; }
      const matches = Math.abs(video.currentTime - at) < 0.001;
      const decoded = !video.seeking && video.readyState >= 2;
      ready = decoded && matches;
      // A completed seek is useful even if the pointer has moved again. Never draw the
      // decoder's empty surface, or a frame left over from a previous hover session.
      if (decoded && (matches || requested === video.currentTime) && drawn !== video.currentTime) {
        paint(video);
        drawn = video.currentTime;
      }
      if (!video.seeking && !ready && requested !== at) {
        requested = at;
        video.currentTime = at;
      }
    }
    if (!ready) timeout ??= window.setTimeout(fail, 500);
    else clearWait();
  }
  function progress() { clearWait(); seek(); }
  video.addEventListener("loadedmetadata", progress);
  video.addEventListener("loadeddata", progress);
  video.addEventListener("seeked", progress);
  video.addEventListener("error", fail);
  return {
    show(at: number) { time = at; seek(); return video.hasAttribute("src"); },
    hide() { time = requested = drawn = undefined; clearWait(); },
    dispose() {
      video.removeEventListener("loadedmetadata", progress);
      video.removeEventListener("loadeddata", progress);
      video.removeEventListener("seeked", progress);
      video.removeEventListener("error", fail);
      clearWait();
    },
  };
}

export function ScrubPreview({ start = 0, duration, pictureAspect = 16 / 9, frameAt, hoverVideo, suspended, note, pin, children }: {
  start?: number;
  duration: number;
  pictureAspect?: number;
  frameAt(time: number, exact?: boolean): string | undefined;
  hoverVideo?: HoverVideo;
  suspended?: boolean;
  /** What the pointer is over, shown under the frame in the same card. */
  note?: ReactNode;
  /** A time to show instead of the one under the pointer, as a marker's own while the pointer is on it. */
  pin?: number;
  children: ReactNode;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const file = hoverVideo?.url, lastFrame = hoverVideo?.lastFrame;

  // Match the picture's long side to the usual preview width. Leave room above the timeline in short windows.
  const pictureWidth = `min(${Math.min(WIDTH, WIDTH * pictureAspect)}px, ${40 * pictureAspect}dvh)`;

  // Read the file's seek index as soon as the timeline has a playable file.
  // Pointer movement, playhead updates and zoom all share that one decoder.
  useLayoutEffect(() => {
    const el = video.current;
    if (!el || !file) return;
    el.src = file;
    return () => unload(el);
  }, [file]);

  // The page builds `frameAt` again whenever the project or its media change, which they do while videos cache or
  // Scarlet works. The bubble reads the latest one without being set up again: that would drop a drag in progress.
  const frameSource = useRef(frameAt);
  useLayoutEffect(() => { frameSource.current = frameAt; }, [frameAt]);
  // The bubble shows a pinned time from the next paint, without being set up again.
  const pinned = useRef(pin);
  const repaint = useRef<() => void>(undefined);
  useLayoutEffect(() => { pinned.current = pin; repaint.current?.(); }, [pin]);
  useLayoutEffect(() => {
    if (suspended || !(duration > 0 && Number.isFinite(duration))) return;
    const track = bar.current!, tip = bubble.current!, canvas = picture.current!, stamp = label.current!;
    let x = 0;
    let dragId: number | undefined;
    let time: number | undefined;
    let wanted: string | undefined;
    let pending: { url: string; controller: AbortController } | undefined;
    let retarget: number | undefined;
    let displayed: string | undefined;
    const context = canvas.getContext("2d");
    // Keep the last decoded pixels on screen while either source seeks the next frame.
    function draw(frame: HTMLVideoElement | HTMLImageElement) {
      const width = frame instanceof HTMLVideoElement ? frame.videoWidth : frame.naturalWidth;
      const height = frame instanceof HTMLVideoElement ? frame.videoHeight : frame.naturalHeight;
      if (!context || !width || !height) return;
      const scale = Math.min(1, WIDTH * 2 / Math.max(width, height));
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      context.drawImage(frame, 0, 0, w, h);
      canvas.hidden = false;
    }
    let paint = 0;

    // A cache miss decodes a frame on the engine. Keep one request in flight
    // and sample the latest pointer position instead of queuing old positions.
    async function fetchStill(url: string) {
      window.clearTimeout(retarget);
      const request = new AbortController();
      pending = { url, controller: request };
      let objectUrl: string | undefined;
      try {
        const response = await fetch(url, { signal: request.signal });
        if (!response.ok) throw Error("Unavailable preview frame");
        const bytes = await response.blob();
        if (request.signal.aborted) return;
        objectUrl = URL.createObjectURL(bytes);
        const image = new Image();
        image.src = objectUrl;
        await image.decode();
        if (request.signal.aborted || (dragId !== undefined && wanted !== url)) return;
        draw(image);
        displayed = url;
      } catch {
        if (!request.signal.aborted && wanted === url) {
          canvas.hidden = true;
          displayed = undefined;
        }
      } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        if (pending?.controller === request) {
          window.clearTimeout(retarget);
          pending = undefined;
          if (wanted && wanted !== url && wanted !== displayed) void fetchStill(wanted);
        }
      }
    }
    function sample() {
      if (time === undefined) return;
      const url = interactiveFrameUrl(frameSource.current(time, dragId !== undefined), WIDTH * 2);
      if (!url) {
        canvas.hidden = true;
        displayed = undefined;
      }
      if (wanted === url) return;
      wanted = url;
      window.clearTimeout(retarget);
      if (!url || displayed === url) {
        pending?.controller.abort();
        pending = undefined;
      } else if (!pending) void fetchStill(url);
      else if (pending.url !== url) {
        retarget = window.setTimeout(() => {
          pending?.controller.abort();
          void fetchStill(url);
        }, RETARGET_MS);
      }
    }
    const movie = video.current && lastFrame !== undefined ? hoverMovie(video.current, lastFrame, draw, sample) : undefined;
    function update() {
      paint = 0;
      const rect = track.getBoundingClientRect();
      if (!rect.width) return;
      const offset = Math.max(0, Math.min(rect.width, x - rect.left));
      time = dragId === undefined && pinned.current !== undefined ? pinned.current : start + duration * (offset / rect.width);
      const text = playbackClock(time);
      if (stamp.textContent !== text) stamp.textContent = text;
      tip.hidden = false;
      const width = tip.offsetWidth;
      const left = Math.max(0, Math.min(rect.width - width, offset - width / 2));
      tip.style.transform = `translateX(${left}px)`;
      if (dragId === undefined && movie?.show(time)) return;
      sample();
    }
    function move(event: PointerEvent) {
      if (dragId !== undefined ? event.pointerId !== dragId : event.pointerType === "touch" || event.buttons) return;
      x = event.clientX;
      if (!paint) paint = requestAnimationFrame(update);
    }
    function hide() {
      cancelAnimationFrame(paint);
      paint = 0;
      // A released drag no longer needs its bubble. Free the engine decoder
      // immediately for the exact, full-size monitor frame at the release point.
      window.clearTimeout(retarget);
      pending?.controller.abort();
      pending = undefined;
      time = wanted = undefined;
      movie?.hide();
      displayed = undefined;
      tip.hidden = canvas.hidden = true;
    }
    function down(event: PointerEvent) {
      if (!event.isPrimary || event.button !== 0) return;
      hide();
      dragId = event.pointerId;
      move(event);
    }
    function leave() { if (dragId === undefined) hide(); }
    // Only while the bubble is up: a pin that comes or goes then shows at once.
    repaint.current = () => { if (!tip.hidden && !paint) paint = requestAnimationFrame(update); };
    function finish(event: PointerEvent) {
      if (event.pointerId !== dragId) return;
      dragId = undefined;
      hide();
    }
    track.addEventListener("pointermove", move);
    track.addEventListener("pointerenter", move);
    track.addEventListener("pointerdown", down);
    track.addEventListener("pointerleave", leave);
    track.addEventListener("pointercancel", finish);
    track.addEventListener("pointerup", finish);
    track.addEventListener("lostpointercapture", finish);
    // A press that plays a cut's passage, in the red band or a grey gap, never captures the pointer. Let go off the
    // timeline, it would leave the drag on: the bubble would stay up and ask for an exact frame on every move.
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      repaint.current = undefined;
      hide();
      movie?.dispose();
      track.removeEventListener("pointermove", move);
      track.removeEventListener("pointerenter", move);
      track.removeEventListener("pointerdown", down);
      track.removeEventListener("pointerleave", leave);
      track.removeEventListener("pointercancel", finish);
      track.removeEventListener("pointerup", finish);
      track.removeEventListener("lostpointercapture", finish);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [start, duration, file, lastFrame, suspended]);

  return <div ref={bar} className="relative">
    {children}
    <div ref={bubble} hidden aria-hidden="true" style={{ "--scrub-picture-width": pictureWidth, width: note ? WIDTH : undefined } as CSSProperties}
      className="scrub-preview pointer-events-none absolute bottom-full left-0 z-10 max-w-full overflow-hidden rounded-md border border-line bg-panel text-center shadow-lg">
      {file && <video ref={video} hidden muted playsInline preload="metadata" />}
      <canvas ref={picture} hidden style={{ aspectRatio: pictureAspect }} className="mx-auto max-w-full bg-black object-contain" />
      <span ref={label} className="block py-0.5 font-mono text-xs tnum" />
      {note}
    </div>
  </div>;
}
