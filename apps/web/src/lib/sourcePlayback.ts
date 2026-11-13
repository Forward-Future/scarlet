import { SOURCE_PREVIEW_SECONDS } from "@scarlet/timeline";
import { playbackLog } from "./playbackLog";

/** Keep the editor clock in source seconds while a standalone preview starts at zero. */
export function openSourcePlayback(video: HTMLVideoElement, options: {
  original: string;
  chunkUrl(index: number): string;
  duration: number;
  start: number;
  rate: number;
  onState(state: "ready" | "loading" | "failed"): void;
  onEnd?(): void;
}) {
  const { duration, onState } = options;
  let chunk: number | undefined;
  let pendingTime: number | undefined;
  let wantsPlay = false;
  let rejectedOriginal = false;
  let requestedFrame = false;
  let frameSeek: { time: number; timer: ReturnType<typeof setTimeout> } | undefined;
  let failedChunk: number | undefined;
  let preparing: AbortController | undefined;
  let lookahead: { index: number; request: AbortController } | undefined;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let sample: { time: number; frames: number; dropped: number } | undefined;
  const offset = () => (chunk ?? 0) * SOURCE_PREVIEW_SECONDS;
  const sourceTime = () => frameSeek?.time ?? pendingTime ?? Math.min(duration, offset() + video.currentTime);
  const indexAt = (time: number) => Math.min(Math.floor(time / SOURCE_PREVIEW_SECONDS), Math.ceil(duration / SOURCE_PREVIEW_SECONDS) - 1);

  function clearStall() {
    clearTimeout(stallTimer);
    stallTimer = undefined;
    sample = undefined;
    if (preparing) {
      preparing.abort();
      preparing = undefined;
      onState("ready");
    }
  }
  function cancelFrameSeek() {
    clearTimeout(frameSeek?.timer);
    frameSeek = undefined;
  }
  function cancelLookahead() {
    lookahead?.request.abort();
    lookahead = undefined;
  }
  function playing() {
    clearStall();
    if (!wantsPlay || !rejectedOriginal || chunk === undefined) return;
    const index = chunk + 1;
    if (index * SOURCE_PREVIEW_SECONDS >= duration || lookahead?.index === index) return;
    cancelLookahead();
    const request = new AbortController();
    lookahead = { index, request };
    // The next GET joins the engine's encode if it is still in flight.
    void fetch(options.chunkUrl(index), { method: "HEAD", signal: request.signal }).catch(() => {});
  }
  function previewChunk(time: number) {
    // Dragging across an unsupported original should encode only the section the editor settles on.
    cancelFrameSeek();
    onState("loading");
    frameSeek = { time, timer: setTimeout(() => switchTo(time, indexAt(time)), 90) };
  }
  function switchTo(time: number, index?: number, url?: string) {
    cancelFrameSeek();
    clearStall();
    if (index !== lookahead?.index) cancelLookahead();
    pendingTime = time;
    chunk = index;
    video.defaultPlaybackRate = video.playbackRate;
    onState(index === undefined ? "ready" : "loading");
    video.src = url ?? (index === undefined ? options.original : options.chunkUrl(index));
    if (wantsPlay) void video.play().catch(() => {});
  }
  function requestChunk() {
    const time = sourceTime();
    const index = indexAt(time);
    if (chunk !== undefined || !wantsPlay || time >= duration || failedChunk === index || preparing) return;
    if (rejectedOriginal) { switchTo(time, index); return; }
    // Keep the original visible/playable while the engine encodes. If it recovers
    // or the user seeks away, leave the completed chunk in the cache for next time.
    const url = options.chunkUrl(index);
    const request = new AbortController();
    preparing = request;
    onState("loading");
    void fetch(url, { method: "HEAD", signal: request.signal }).then(response => {
      if (request.signal.aborted) return;
      preparing = undefined;
      if (!response.ok) throw new Error(`Preview unavailable (${response.status})`);
      const now = sourceTime();
      if (wantsPlay && !video.paused && indexAt(now) === index) switchTo(now, index, url);
      else onState("ready");
    }).catch((error: unknown) => {
      if (request.signal.aborted) return;
      // The original plays on as it was: to the editor nothing happened, and the picture still stutters.
      playbackLog("source chunk-failed", { chunk: index, error: String(error) });
      preparing = undefined; failedChunk = index; onState("ready");
    });
  }
  function waiting() {
    if (stallTimer !== undefined || chunk !== undefined || !wantsPlay || video.paused || video.seeking || video.ended) return;
    const at = sourceTime();
    stallTimer = setTimeout(() => {
      stallTimer = undefined;
      if (!video.paused && !video.seeking && sourceTime() - at < 0.15) requestChunk();
    }, 1200);
  }
  // A decoder can drop frames continuously without ever emitting "waiting".
  function measureDrops() {
    if (chunk !== undefined || !wantsPlay || video.paused || video.seeking || !video.getVideoPlaybackQuality) return;
    const quality = video.getVideoPlaybackQuality();
    const time = performance.now();
    if (sample && time - sample.time < 1500) return;
    if (sample) {
      const frames = quality.totalVideoFrames - sample.frames;
      if (frames >= 12 && quality.droppedVideoFrames - sample.dropped >= frames / 4) requestChunk();
    }
    sample = { time, frames: quality.totalVideoFrames, dropped: quality.droppedVideoFrames };
  }
  function metadata() {
    if (pendingTime === undefined) return;
    video.currentTime = Math.max(0, pendingTime - offset());
    pendingTime = undefined;
    video.playbackRate = video.defaultPlaybackRate;
    onState("ready");
  }
  function ended() {
    const next = chunk === undefined ? duration : (chunk + 1) * SOURCE_PREVIEW_SECONDS;
    if (next >= duration) { wantsPlay = false; options.onEnd?.(); return; }
    // Retry full quality past the rough section. An unsupported codec stays on chunks.
    switchTo(next, rejectedOriginal ? indexAt(next) : undefined);
  }
  function error() {
    if (chunk === undefined) {
      clearStall();
      rejectedOriginal = true;
      if (failedChunk === indexAt(sourceTime())) { wantsPlay = false; onState("failed"); }
      else if (wantsPlay) requestChunk();
      else if (requestedFrame) previewChunk(sourceTime());
    } else {
      failedChunk = chunk;
      if (!rejectedOriginal) switchTo(sourceTime());
      else { wantsPlay = false; onState("failed"); }
    }
  }
  const events = { waiting, stalled: waiting, seeking: clearStall, pause: clearStall, playing,
    timeupdate: measureDrops, loadedmetadata: metadata, ended, error };
  for (const [name, fn] of Object.entries(events)) video.addEventListener(name, fn);
  video.playbackRate = options.rate;
  switchTo(Math.min(options.start, duration));

  return {
    sourceTime, duration,
    prepare() {
      wantsPlay = true;
      if (sourceTime() >= duration || video.ended) this.seek(0);
      if (frameSeek) {
        switchTo(frameSeek.time, indexAt(frameSeek.time));
        return;
      }
      if (failedChunk !== undefined) {
        failedChunk = undefined;
        if (rejectedOriginal) switchTo(sourceTime(), indexAt(sourceTime()));
      } else if (rejectedOriginal && chunk === undefined) requestChunk();
    },
    pause() { wantsPlay = false; clearStall(); cancelLookahead(); },
    finishSeek() {
      if (frameSeek) switchTo(frameSeek.time, indexAt(frameSeek.time));
    },
    seek(time: number, previewFrame = false) {
      clearStall();
      if (frameSeek) { cancelFrameSeek(); onState("ready"); }
      requestedFrame = previewFrame;
      const index = indexAt(time);
      if (chunk !== index && lookahead?.index !== index) cancelLookahead();
      if (previewFrame && rejectedOriginal && chunk !== index && !wantsPlay) {
        previewChunk(time);
      } else if (chunk !== undefined && chunk !== index) {
        switchTo(time, rejectedOriginal ? index : undefined);
      } else if (pendingTime !== undefined || video.readyState < 1) {
        pendingTime = time;
      } else video.currentTime = time - offset();
      return true;
    },
    dispose() {
      cancelFrameSeek();
      clearStall();
      cancelLookahead();
      for (const [name, fn] of Object.entries(events)) video.removeEventListener(name, fn);
      video.pause();
      video.removeAttribute("src");
      video.load();
    },
  };
}
