/**
 * The review player's imperative surface. The <video> element registers
 * itself here; hotkeys, the transcript and the timeline strip call these
 * functions. Rendered state (time, playing, rate) lives in stores/player.
 */
import type { TimeRange } from "@scarlet/timeline";
import { usePlayerStore } from "../stores/player";
import type { JoinClock } from "./joinClock";
import { calledBy, logId, playbackLog } from "./playbackLog";

let video: HTMLVideoElement | null = null;
interface StreamControls {
  prepare(): void;
  seek(time: number, previewFrame?: boolean): boolean | void;
  finishSeek?(): void;
  pause?(): void;
  sourceTime?(): number;
  duration?: number;
}
let stream: StreamControls | undefined;
/** The attached media plays a version with footage removed while the transport shows the version before it. */
let clock: JoinClock | undefined;
let raf: number | null = null;

let passage: (TimeRange & { fps: number }) | undefined;
let atOut = false;
/** Playback ran to the passage's end and stopped there. The editor didn't pause it. */
let ranOut = false;

/**
 * A short listen to one spot: play from `start`, step over each skip when playback reaches it,
 * and stop at `end`. Seeks go anywhere, so the timeline can scrub while it plays.
 */
export interface Audition extends TimeRange {
  /** Removed footage is never shown, even after a seek into it. Other skips only shorten the listen. */
  skips: (TimeRange & { removed?: boolean })[];
  /** Where this listen starts, when it isn't `start`. Play at the end still goes back to `start`. */
  from?: number;
}
let audition: (Audition & { fps: number }) | undefined;
/** Playback stopped at the audition's end. Play starts the listen again. */
let finished = false;
/** The clock at the previous reading while playing, to see playback cross a boundary. */
let lastClock: number | undefined;
/**
 * Playback was running when the last passage or listen was let go. The same one taken up again carries on
 * as it was: it plays only if this is set or the video is playing, so a paused video stays paused.
 */
let carry = false;
/**
 * A clip that plays over the monitor has the playhead and says where it is: Before on an edit that isn't a cut.
 * The attached media waits under it, and its clock isn't read: a pause or a seek of its own that lands late would
 * put the playhead back where the media stopped.
 */
let borrower: { pause(): void } | undefined;
const isPlaying = () => !!video && !video.paused && !video.ended;
function letGo() {
  const was = isPlaying();
  player.pause();
  carry = was;
}

function readClock(el: HTMLVideoElement) {
  if (el !== video || el.readyState < 1 || borrower) return;
  const media = stream?.sourceTime?.() ?? el.currentTime;
  const t = clock ? clock.toView(media) : media;
  if (passage && !atOut && t >= passage.end && (!el.paused || el.ended) && !el.seeking) {
    playbackLog("transport passage-end", { t, end: passage.end });
    player.pause();
    player.seek(passage.end, true);
    ranOut = true;
    return;
  }
  if (audition && !el.seeking) {
    // The final reading can arrive already paused. An intermediate fallback chunk also emits ended.
    const frame = 1 / audition.fps;
    const atVideoEnd = el.ended && Math.abs(t - usePlayerStore.getState().duration) <= frame;
    if (atVideoEnd && Math.abs(t - audition.end) <= frame) finished = true;
    else if ((atVideoEnd || (!el.ended && !el.paused)) && auditionStep(t)) return;
  }
  usePlayerStore.getState().setTime(passage ? atOut ? passage.end : Math.max(passage.start, Math.min(passage.end, t)) : t);
}

/**
 * Act on the reading nearest each boundary, so a join lands within half a frame of the cut.
 * A join is a seek on the element that's playing: WebKit resumes a playing element sooner than
 * it starts a paused one or a second element.
 */
function auditionStep(t: number) {
  const a = audition!;
  const prev = lastClock;
  lastClock = t;
  const reach = prev !== undefined && t > prev && t - prev < 0.25 ? t + (t - prev) / 2 : t;
  const crossed = (at: number) => prev !== undefined && prev < at && reach >= at;
  // Playback just after a join can read a hair before the resume point. That is the join, not removed footage.
  // Under a join clock the removed footage isn't in the media at all, so playback runs through the join untouched.
  const skip = a.skips.find(s => s.removed ? !clock?.removed.some(r => r.start <= s.start + 1e-6 && r.end >= s.end - 1e-6)
    && reach >= s.start && t < s.end - 0.5 / a.fps : crossed(s.start));
  if (skip && skip.end < a.end) {
    // A join made by seeking the playing element: the sound and picture break here until the seek lands.
    playbackLog("transport step-over", { t, from: skip.start, to: skip.end, removed: skip.removed, joined: !!clock });
    player.seek(skip.end, true);
  } else if (skip || crossed(a.end)) {
    playbackLog("transport listen-end", { t, end: a.end });
    player.pause();
    player.seek(a.end, true);
    finished = true;
  } else return false;
  return true;
}

/**
 * A press on the timeline pauses while the pointer is down, then carries on as it was. A listen or passage that
 * played to its end and stopped there was still being played: the editor didn't pause it, so it plays from the
 * point they pick.
 */
export function pauseForScrub(gesture: AbortSignal) {
  const resume = usePlayerStore.getState().playing || (!!audition && finished) || (!!passage && ranOut);
  usePlayerStore.setState({ scrubGesture: gesture });
  gesture.addEventListener("abort", () => {
    if (usePlayerStore.getState().scrubGesture === gesture) usePlayerStore.setState({ scrubGesture: undefined });
  }, { once: true });
  player.pause();
  return () => {
    stream?.finishSeek?.();
    if (resume) player.play();
  };
}

function tick() {
  const v = video;
  if (!v) return;
  readClock(v);
  if (!v.paused && !v.ended) raf = requestAnimationFrame(tick);
  else raf = null;
}

export const player = {
  attach(el: HTMLVideoElement | null, controls?: StreamControls) {
    if (video && video !== el) this.detach();
    video = el;
    stream = controls;
    clock = undefined;
    if (!el) return;
    playbackLog("transport attach", { el: logId(el), name: el.getAttribute("aria-label"), streamed: !!controls, at: usePlayerStore.getState().time });
    const st = usePlayerStore.getState();
    // The speed the editor picked is this element's own from the start. A source set on it later puts its speed back
    // to the element's default, which on a new element is 1×: the video and the picker would both drop to it.
    if (st.rate > 0) el.defaultPlaybackRate = el.playbackRate = st.rate;
    const onPlay = () => {
      st.setPlaying(true);
      if (raf === null) raf = requestAnimationFrame(tick);
    };
    const onPause = () => {
      st.setPlaying(false);
      readClock(el);
    };
    const onMeta = () => st.setDuration(clock?.duration ?? stream?.duration ?? (Number.isFinite(el.duration) ? el.duration : 0));
    const onRate = () => st.setRate(el.playbackRate);
    const onSeek = () => readClock(el);
    const refreshReadiness = () => {
      const playbackReady = !el.paused && !el.ended && !el.seeking && el.readyState >= 3;
      if (usePlayerStore.getState().playbackReady !== playbackReady) usePlayerStore.setState({ playbackReady });
    };
    const clearReadiness = () => {
      if (usePlayerStore.getState().playbackReady) usePlayerStore.setState({ playbackReady: false });
    };
    el.addEventListener("playing", refreshReadiness);
    el.addEventListener("seeked", refreshReadiness);
    el.addEventListener("seeking", clearReadiness);
    el.addEventListener("waiting", clearReadiness);
    el.addEventListener("emptied", clearReadiness);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onPause);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("durationchange", onMeta);
    el.addEventListener("ratechange", onRate);
    el.addEventListener("seeking", onSeek);
    el.addEventListener("seeked", onSeek);
    el.addEventListener("timeupdate", onSeek);
    detachFn = () => {
      el.removeEventListener("playing", refreshReadiness);
      el.removeEventListener("seeked", refreshReadiness);
      el.removeEventListener("seeking", clearReadiness);
      el.removeEventListener("waiting", clearReadiness);
      el.removeEventListener("emptied", clearReadiness);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onPause);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("durationchange", onMeta);
      el.removeEventListener("ratechange", onRate);
      el.removeEventListener("seeking", onSeek);
      el.removeEventListener("seeked", onSeek);
      el.removeEventListener("timeupdate", onSeek);
    };
    if (stream?.duration || Number.isFinite(el.duration)) onMeta();
  },
  detach() {
    if (video) playbackLog("transport detach", { el: logId(video), playing: isPlaying(), at: usePlayerStore.getState().time });
    detachFn?.();
    detachFn = null;
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
    video = null;
    stream = undefined;
    clock = undefined;
    usePlayerStore.getState().setDuration(0);
    usePlayerStore.getState().setPlaying(false);
  },
  /**
   * A thread selection owns the bounded transport until its view releases it. `again` takes up the passage the
   * editor is already on, after something around it changed: it stays where it is, and plays only if it was playing.
   */
  previewRange(range: TimeRange, fps: number, stillAt?: number, again = false) {
    const resume = again && (carry || isPlaying());
    playbackLog("transport passage", { start: range.start, end: range.end, stillAt, again, resume, at: usePlayerStore.getState().time, by: calledBy(2) });
    this.pause();
    audition = undefined;
    const owned = { ...range, fps };
    passage = owned;
    ranOut = false;
    this.seek(again ? usePlayerStore.getState().time : stillAt ?? owned.start, true);
    if (again ? resume : stillAt === undefined) this.play();
    return () => {
      if (passage !== owned) return;
      letGo();
      passage = undefined;
      atOut = false;
      ranOut = false;
    };
  },
  /**
   * Play one spot with its skips. The returned callback ends the audition. `again` takes up the listen the editor
   * is already on, after something around it changed: it stays where it is, and plays only if it was playing.
   */
  audition(next: Audition, fps: number, again = false) {
    const resume = again && (carry || isPlaying());
    playbackLog("transport listen", { start: next.start, end: next.end, from: next.from, skips: next.skips.map(s => [s.start, s.end, s.removed ? "removed" : "skip"]),
      again, resume, joined: !!clock, at: usePlayerStore.getState().time, by: calledBy(2) });
    this.pause();
    passage = undefined;
    atOut = false;
    ranOut = false;
    const owned = { ...next, fps };
    audition = owned;
    const time = usePlayerStore.getState().time;
    this.seek(again ? time : owned.from ?? owned.start, true);
    // A listen that had played to its end still starts over on Play.
    finished = again && Math.abs(time - owned.end) < 0.5 / fps;
    if (again ? resume : true) this.play();
    return () => {
      if (audition !== owned) return;
      letGo();
      audition = undefined;
      finished = false;
      lastClock = undefined;
    };
  },
  seek(t: number, previewFrame = false) {
    const st = usePlayerStore.getState();
    const max = st.duration > 0 ? st.duration : Infinity;
    let target = passage ? Math.max(passage.start, Math.min(t, passage.end)) : t;
    if (audition) {
      // Removed footage closes up on After. A point inside it lands where the footage resumes,
      // or just before the cut when a key or reverse play steps back into it.
      const removed = audition.skips.find(s => s.removed && target > s.start && target < s.end);
      if (removed) target = !st.scrubGesture && t < st.time ? removed.start : removed.end;
      finished = false;
      lastClock = undefined;
    }
    // Media with its joins inside has no frame for footage that was cut, and reads a join as where the footage
    // resumes. A key that stepped back onto a cut would land there again, and never get past it. It lands a frame
    // before the cut, so the next step goes on back.
    if (clock && !st.scrubGesture && t < st.time) {
      const gone = clock.removed.find(r => target >= r.start && target < r.end);
      if (gone) target = Math.max(passage?.start ?? 0, gone.start - 1 / (audition?.fps ?? passage?.fps ?? 30));
    }
    atOut = !!passage && target >= passage.end;
    ranOut = false;
    const clamped = Math.max(0, Math.min(max, atOut && passage
      ? Math.max(passage.start, (Math.ceil(passage.end * passage.fps - 1e-6) - 1) / passage.fps) : target));
    const media = clock ? clock.toMedia(clamped) : clamped;
    const handled = stream?.seek(media, previewFrame);
    if (!handled && video && video.readyState >= 1) video.currentTime = media;
    playbackLog("transport seek", { to: clamped, media: clock ? media : undefined, asked: t === clamped ? undefined : t, playing: isPlaying(),
      scrub: !!st.scrubGesture || undefined, ready: video?.readyState }, "transport seek");
    st.setTime(atOut && passage ? passage.end : clamped);
    // Keyboard steps and edit links are committed positions. Only a moving
    // pointer needs the decoder's debounce before preparing a missing frame.
    if (previewFrame && !st.scrubGesture) stream?.finishSeek?.();
  },
  prepare() { stream?.prepare(); },
  play() {
    if (passage && atOut) this.seek(passage.start, true);
    if (audition && finished) this.seek(audition.start, true);
    this.prepare();
    playbackLog("transport play", { at: usePlayerStore.getState().time, el: video ? logId(video) : "none", ready: video?.readyState, by: calledBy() });
    // A pause or a new source before playback began ends the attempt, which is ordinary. Anything else is a refusal.
    if (video) void video.play().catch(error => playbackLog(error instanceof DOMException && error.name === "AbortError"
      ? "transport play-interrupted" : "transport play-failed", { error: String(error) }));
  },
  pause() {
    if (isPlaying()) playbackLog("transport pause", { at: usePlayerStore.getState().time, by: calledBy() });
    carry = false;
    stream?.pause?.();
    video?.pause();
    // Whatever stops the video stops what is on screen: a clip playing over the monitor too.
    borrower?.pause();
  },
  /**
   * Hand the playhead to a clip that plays over the monitor. The attached media pauses, and its clock isn't read
   * until the returned callback takes the playhead back, when the media goes to where the clip left it.
   */
  lendPlayhead(to: { pause(): void }) {
    this.pause();
    borrower = to;
    return () => {
      if (borrower !== to) return;
      borrower = undefined;
      this.seek(usePlayerStore.getState().time, true);
    };
  },
  toggle() {
    if (!video) return;
    if (video.paused || video.ended) this.play();
    else this.pause();
  },
  setRate(rate: number) {
    if (video) {
      video.defaultPlaybackRate = rate;
      video.playbackRate = rate;
    }
    usePlayerStore.getState().setRate(rate);
  },
  element() {
    return video;
  },
  /**
   * Map element `el`'s media clock onto the transport's, when the media is a version with footage removed and the
   * transport shows the version before it. Undefined plays the media's own clock.
   */
  setJoins(el: HTMLVideoElement | null, joins: JoinClock | undefined) {
    if (!el || el !== video || clock === joins) return;
    clock = joins;
    playbackLog("transport joins", { el: logId(el), removed: joins?.removed.map(r => [r.start, r.end]), duration: joins?.duration });
    const st = usePlayerStore.getState();
    st.setDuration(clock?.duration ?? stream?.duration ?? (Number.isFinite(el.duration) ? el.duration : 0));
  },
  /** Where the attached media should be for transport time `t`. */
  mediaTime(t: number) {
    return clock ? clock.toMedia(t) : t;
  },
};

let detachFn: (() => void) | null = null;
