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
function hoverMovie(video: HTMLVideoElement, lastFrame: number, useStill: () => void) {
  let time: number | undefined;
  let requested: number | undefined;
  let timeout: number | undefined;

  function clearWait() {
    window.clearTimeout(timeout);
    timeout = undefined;
  }
  function fail() {
    if (!video.hasAttribute("src")) return;
    clearWait();
    video.hidden = true;
    unload(video);
    if (time !== undefined) useStill();
  }
  function seek() {
    if (time === undefined || !video.hasAttribute("src")) return;
    if (video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0) {
      // The MP4's audio can extend past the final picture.
      const at = Math.floor(Math.min(time, lastFrame) * 4) / 4;
      if (at >= video.duration || (video.readyState >= 2 && !video.videoWidth)) { fail(); return; }
      const matches = Math.abs(video.currentTime - at) < 0.001;
      video.hidden = video.seeking || !matches || video.readyState < 2;
      // When a seek finishes, go straight to the latest pointer position.
      if (!video.seeking && video.hidden && requested !== at) {
        requested = at;
        video.currentTime = at;
      }
    }
    if (video.hidden) timeout ??= window.setTimeout(fail, 500);
    else clearWait();
  }
  function progress() { clearWait(); seek(); }
  video.addEventListener("loadedmetadata", progress);
  video.addEventListener("loadeddata", progress);
  video.addEventListener("seeked", progress);
  video.addEventListener("error", fail);
  return {
    show(at: number) { time = at; seek(); return video.hasAttribute("src"); },
    hide() { time = undefined; video.hidden = true; clearWait(); },
    dispose() {
      video.removeEventListener("loadedmetadata", progress);
      video.removeEventListener("loadeddata", progress);
      video.removeEventListener("seeked", progress);
      video.removeEventListener("error", fail);
      clearWait();
    },
  };
}

export function ScrubPreview({ start = 0, duration, pictureAspect = 16 / 9, frameAt, hoverVideo, note, children }: {
  start?: number;
  duration: number;
  pictureAspect?: number;
  frameAt(time: number, exact?: boolean): string | undefined;
  hoverVideo?: HoverVideo;
  /** What the pointer is over, shown under the frame in the same card. */
  note?: ReactNode;
  children: ReactNode;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const still = useRef<HTMLImageElement>(null);
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
  useLayoutEffect(() => {
    if (!(duration > 0 && Number.isFinite(duration))) return;
    const track = bar.current!, tip = bubble.current!, img = still.current!, stamp = label.current!;
    let x = 0;
    let dragId: number | undefined;
    let time: number | undefined;
    let wanted: string | undefined;
    let pending: { url: string; controller: AbortController } | undefined;
    let retarget: number | undefined;
    let displayed: { url: string; objectUrl: string; ready: boolean } | undefined;
    let paint = 0;

    // A cache miss decodes a frame on the engine. Keep one request in flight
    // and sample the latest pointer position instead of queuing old positions.
    async function fetchStill(url: string) {
      window.clearTimeout(retarget);
      const request = new AbortController();
      pending = { url, controller: request };
      try {
        const response = await fetch(url, { signal: request.signal });
        if (!response.ok) throw Error("Unavailable preview frame");
        const bytes = await response.blob();
        if (request.signal.aborted || wanted !== url) return;
        if (displayed) URL.revokeObjectURL(displayed.objectUrl);
        displayed = { url, objectUrl: URL.createObjectURL(bytes), ready: false };
        img.src = displayed.objectUrl;
      } catch {
        if (!request.signal.aborted) img.hidden = true;
      } finally {
        if (pending?.controller === request) {
          window.clearTimeout(retarget);
          pending = undefined;
          if (wanted && wanted !== url && wanted !== displayed?.url) void fetchStill(wanted);
        }
      }
    }
    function sample() {
      if (time === undefined) return;
      const url = interactiveFrameUrl(frameSource.current(time, dragId !== undefined), WIDTH * 2);
      if (wanted === url) return;
      wanted = url;
      window.clearTimeout(retarget);
      img.hidden = !displayed?.ready || url !== displayed.url;
      if (!url || displayed?.url === url) {
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
    const movie = video.current && lastFrame !== undefined ? hoverMovie(video.current, lastFrame, sample) : undefined;
    function settled(event: Event) {
      if (displayed) displayed.ready = event.type === "load";
      img.hidden = !displayed?.ready || wanted !== displayed.url;
    }
    function update() {
      paint = 0;
      const rect = track.getBoundingClientRect();
      if (!rect.width) return;
      const offset = Math.max(0, Math.min(rect.width, x - rect.left));
      time = start + duration * (offset / rect.width);
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
      tip.hidden = img.hidden = true;
    }
    function down(event: PointerEvent) {
      if (!event.isPrimary || event.button !== 0) return;
      hide();
      dragId = event.pointerId;
      move(event);
    }
    function leave() { if (dragId === undefined) hide(); }
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
    img.addEventListener("load", settled);
    img.addEventListener("error", settled);
    return () => {
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
      img.removeEventListener("load", settled);
      img.removeEventListener("error", settled);
      img.removeAttribute("src");
      if (displayed) URL.revokeObjectURL(displayed.objectUrl);
    };
  }, [start, duration, file, lastFrame]);

  return <div ref={bar} className="relative">
    {children}
    <div ref={bubble} hidden aria-hidden="true" style={{ "--scrub-picture-width": pictureWidth, width: note ? WIDTH : undefined } as CSSProperties}
      className="scrub-preview pointer-events-none absolute bottom-full left-0 z-10 max-w-full overflow-hidden rounded-md border border-line bg-panel text-center shadow-lg">
      {file && <video ref={video} hidden muted playsInline preload="metadata" style={{ aspectRatio: pictureAspect }} className="mx-auto max-w-full bg-black object-contain" />}
      <img ref={still} hidden alt="" decoding="async" style={{ aspectRatio: pictureAspect }} className="mx-auto max-w-full bg-black object-contain" />
      <span ref={label} className="block py-0.5 font-mono text-xs tnum" />
      {note}
    </div>
  </div>;
}
