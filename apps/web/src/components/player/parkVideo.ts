import { CUT_DECODER_PREROLL_SECONDS } from "@scarlet/timeline";

export const decoderLeadIn = (target: number) => Math.max(0, target - CUT_DECODER_PREROLL_SECONDS);

/** Decode up to the start of the listen while the standby layer is covered and muted.
 * Pausing a running decoder at the requested frame keeps that frame ready for handoff. */
export function parkVideo(video: HTMLVideoElement, target: number, fps: number, seek: (time: number) => void,
  playingSide?: () => HTMLVideoElement | null) {
  const rate = video.playbackRate;
  const muted = video.muted;
  video.muted = true;
  let stopped = false;
  let tick = 0;
  let other: HTMLVideoElement | null = null;
  let presented = 0;
  let deadline: ReturnType<typeof setTimeout>;
  const start = decoderLeadIn(target);
  const check = () => {
    if (stopped) return;
    if (!video.seeking && video.currentTime >= target - 0.5 / fps) video.pause();
    else tick = requestAnimationFrame(check);
  };
  function decode() {
    if (stopped || video.seeking || video.readyState < 1) return;
    video.removeEventListener("seeked", decode);
    if (target - start < 1 / fps || video.currentTime >= target - 0.5 / fps) return;
    void video.play().then(() => { if (!stopped) check(); }).catch(() => {
      if (!stopped) seek(target);
    });
  }
  function position() {
    if (stopped) return;
    if (video.paused && !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.5 / fps) return;
    video.addEventListener("seeked", decode);
    seek(start);
    if (!video.seeking) decode();
  }
  function startParking() {
    clearTimeout(deadline);
    if (presented) other?.cancelVideoFrameCallback(presented);
    if (stopped) return;
    if (video.readyState >= 1) position();
    else video.addEventListener("loadedmetadata", position, { once: true });
  }
  if (!video.paused) video.pause();
  if (rate !== 1) video.playbackRate = 1;
  if (playingSide) {
    // Let the newly visible decoder present its first moving frames before the outgoing decoder seeks.
    // A paused transport or a cold render can produce no frames at all.
    tick = requestAnimationFrame(() => {
      other = playingSide();
      if (!other || other === video || !other.requestVideoFrameCallback) { startParking(); return; }
      presented = other.requestVideoFrameCallback(() => { presented = other!.requestVideoFrameCallback(startParking); });
      deadline = setTimeout(startParking, 500);
    });
  } else startParking();
  return () => {
    stopped = true;
    clearTimeout(deadline);
    if (presented) other?.cancelVideoFrameCallback(presented);
    video.removeEventListener("loadedmetadata", position);
    video.removeEventListener("seeked", decode);
    cancelAnimationFrame(tick);
    if (!video.paused) video.pause();
    if (video.playbackRate !== rate) video.playbackRate = rate;
    if (video.muted !== muted) video.muted = muted;
  };
}
