/**
 * Playback diagnostics, written to the app log (see appLog) as `[ui] [playback] …` lines.
 * Every media element in the window reports what it does (load, play, wait, seek, error) and what it fails to do while
 * playing: a clock that stops or jumps, dropped frames, a held-up window. The transport and the segmented stream add
 * what they asked for, so a flicker or a gap in the sound can be read back as who did what, in order.
 * Nothing is logged per frame, and a burst is capped.
 */
import { appLog, appLogging, calledBy, logId, startAppLog, type LogFields } from "./appLog";

export { calledBy, logId };
type Fields = LogFields;

/**
 * One playback line. `key` marks a line that repeats in bursts (a scrub's seeks): the latest replaces the one
 * waiting to be written and the line ends in a count.
 */
export function playbackLog(event: string, fields?: Fields, key?: string) {
  appLog("playback", event, fields, { key, level: event === "error" || event.endsWith("failed") ? "warn" : "info" });
}

export const playbackLogging = appLogging;

/** Buffered or seekable ranges as [[start, end], …]. */
export function timeRanges(ranges: TimeRanges | undefined) {
  const out: [number, number][] = [];
  try {
    for (let i = 0; i < (ranges?.length ?? 0); i++) out.push([ranges!.start(i), ranges!.end(i)]);
  } catch { /* A source buffer taken off its media source throws. */ }
  return out;
}

/** Where the media comes from, without its query: a sign-in token never reaches the log. */
function sourceOf(el: HTMLMediaElement) {
  const src = el.currentSrc || el.src;
  if (!src) return "none";
  if (src.startsWith("blob:")) return "stream";
  try { return new URL(src, location.href).pathname.split("/").slice(-3).join("/"); } catch { return "?"; }
}

type Decoded = HTMLMediaElement & { webkitAudioDecodedByteCount?: number; webkitVideoDecodedByteCount?: number };
/** The element as it is now: clock, readiness, what is buffered, frames dropped and bytes decoded so far. */
export function mediaState(el: HTMLMediaElement): Fields {
  const quality = el instanceof HTMLVideoElement ? el.getVideoPlaybackQuality?.() : undefined;
  const decoded = el as Decoded;
  return {
    t: el.currentTime, ready: el.readyState, net: el.networkState, paused: el.paused, seeking: el.seeking || undefined,
    muted: el.muted || undefined, vol: el.volume === 1 ? undefined : el.volume, rate: el.playbackRate === 1 ? undefined : el.playbackRate,
    buf: timeRanges(el.buffered), frames: quality && `${quality.droppedVideoFrames}/${quality.totalVideoFrames}`,
    adec: decoded.webkitAudioDecodedByteCount, vdec: decoded.webkitVideoDecodedByteCount,
  };
}

const EVENTS = ["loadstart", "loadedmetadata", "loadeddata", "canplay", "play", "playing", "pause", "waiting", "stalled",
  "seeking", "seeked", "ended", "error", "emptied", "abort", "ratechange", "volumechange"];
/** Events that come in bursts while the editor scrubs. */
const BURSTY = new Set(["seeking", "seeked", "canplay", "ratechange", "volumechange"]);

interface Sample { at: number; time: number; sought: boolean; stalledFor: number; stalled: boolean; dropped: number; checkedAt: number; adec?: number; quietFor: number; quiet: boolean }
const playing = new Map<HTMLMediaElement, Sample>();
let frame: number | undefined;
let frameAt = 0;
let watching = false;

function watch(now: number) {
  frame = undefined;
  // A held-up window shows as a late frame: the picture freezes even though the decoder kept going.
  if (frameAt && now - frameAt > 150 && !document.hidden) playbackLog("hitch", { ms: now - frameAt });
  frameAt = now;
  for (const [el, s] of playing) {
    if (!el.isConnected || el.paused || el.ended) { playing.delete(el); continue; }
    const wall = (now - s.at) / 1000, moved = el.currentTime - s.time;
    const id = logId(el);
    if (el.seeking || s.sought) {
      s.stalledFor = 0;
    } else if (wall > 0) {
      // The clock went somewhere playback couldn't have taken it, and nobody asked for a seek.
      if (Math.abs(moved - wall * el.playbackRate) > 0.25 && wall < 1) playbackLog("jump", { el: id, from: s.time, to: el.currentTime, ms: wall * 1000 });
      if (Math.abs(moved) < 1e-4) {
        s.stalledFor += wall * 1000;
        if (!s.stalled && s.stalledFor >= 200) { s.stalled = true; playbackLog("stall", { el: id, ...mediaState(el) }); }
      } else {
        if (s.stalled) playbackLog("resumed", { el: id, after: s.stalledFor, t: el.currentTime });
        s.stalled = false;
        s.stalledFor = 0;
      }
    }
    s.sought = false;
    s.at = now;
    s.time = el.currentTime;
    if (now - s.checkedAt >= 1000) {
      const seconds = (now - s.checkedAt) / 1000;
      s.checkedAt = now;
      const quality = el instanceof HTMLVideoElement ? el.getVideoPlaybackQuality?.() : undefined;
      if (quality && quality.droppedVideoFrames > s.dropped) {
        playbackLog("dropped", { el: id, frames: quality.droppedVideoFrames - s.dropped, of: quality.totalVideoFrames, t: el.currentTime });
      }
      if (quality) s.dropped = quality.droppedVideoFrames;
      // The picture moves and no sound is being decoded: the audio dropped out under a playing video.
      const adec = (el as Decoded).webkitAudioDecodedByteCount;
      if (adec !== undefined && s.adec !== undefined && !el.muted && !s.stalled) {
        if (adec === s.adec) {
          s.quietFor += seconds;
          if (!s.quiet && s.quietFor >= 2) { s.quiet = true; playbackLog("audio-idle", { el: id, for: s.quietFor, ...mediaState(el) }); }
        } else {
          if (s.quiet) playbackLog("audio-back", { el: id, after: s.quietFor, t: el.currentTime });
          s.quiet = false;
          s.quietFor = 0;
        }
      }
      s.adec = adec;
    }
  }
  if (playing.size) frame = requestAnimationFrame(watch);
  else frameAt = 0;
}

function onMedia(e: Event) {
  const el = e.target;
  if (!(el instanceof HTMLMediaElement)) return;
  const id = logId(el);
  const name = el.getAttribute("aria-label") ?? el.tagName.toLowerCase();
  const sample = playing.get(el);
  if (e.type === "seeking" && sample) sample.sought = true;
  if (e.type === "playing" && !sample) {
    const quality = el instanceof HTMLVideoElement ? el.getVideoPlaybackQuality?.() : undefined;
    playing.set(el, { at: performance.now(), time: el.currentTime, sought: false, stalledFor: 0, stalled: false,
      dropped: quality?.droppedVideoFrames ?? 0, checkedAt: performance.now(), adec: (el as Decoded).webkitAudioDecodedByteCount, quietFor: 0, quiet: false });
    frame ??= requestAnimationFrame(watch);
  }
  if (e.type === "pause" || e.type === "ended" || e.type === "emptied") playing.delete(el);
  const error = e.type === "error" && el.error ? { code: el.error.code, message: el.error.message } : undefined;
  playbackLog(e.type, { el: id, name, src: sourceOf(el), ...mediaState(el), error },
    BURSTY.has(e.type) ? `${id}:${e.type}` : undefined);
}

function onVisibility() { playbackLog("window", { hidden: document.hidden }); }

/**
 * Start watching. Media events don't bubble, so they are caught on their way down from the document: every element
 * is covered, including ones mounted later, with nothing to wire up in the players. Given a writer, it also starts
 * the log itself; otherwise the lines go wherever the app log already writes.
 */
export function startPlaybackLog(to?: Parameters<typeof startAppLog>[0]) {
  stopPlaybackLog();
  if (to) startAppLog(to);
  watching = true;
  for (const name of EVENTS) document.addEventListener(name, onMedia, true);
  document.addEventListener("visibilitychange", onVisibility);
}

export function stopPlaybackLog() {
  if (!watching) return;
  watching = false;
  for (const name of EVENTS) document.removeEventListener(name, onMedia, true);
  document.removeEventListener("visibilitychange", onVisibility);
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = undefined;
  frameAt = 0;
  playing.clear();
}
