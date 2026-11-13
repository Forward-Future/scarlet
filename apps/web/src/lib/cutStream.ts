import { firstIndex, type TimeRange } from "@scarlet/timeline";
import { api } from "./client";
import { logId, mediaState, playbackLog, playbackLogging, timeRanges } from "./playbackLog";

type Load = (range: TimeRange, signal: AbortSignal) => Promise<ArrayBuffer>;

// Keep compressed fragments for return visits after they leave the decoder's sliding window.
const RECENT_BYTES = 32 * 1024 * 1024;
const RECENT_SECTIONS = 24;
// Native media timestamps may round to either side of a canonical section boundary.
const SECTION_EDGE = 0.001;
// A seek can finish a frame away, or a playing element can already have advanced when WebKit reports it.
const SEEK_LANDING_TOLERANCE = 0.05;

export function playbackLoader(projectId: string, version: string): Load {
  return async (range, signal) => {
    signal.throwIfAborted();
    const url = new URL(api.fileUrl(`/projects/${encodeURIComponent(projectId)}/renders`));
    url.searchParams.set("wait", "1");
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "playback", quality: "preview", version, range }), signal });
    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      throw new Error(body?.error?.message || "Couldn’t load the preview file.");
    }
    const bytes = await response.arrayBuffer();
    signal.throwIfAborted();
    return bytes;
  };
}

/** One native media clock for the entire cut, including seeks into unrendered sections. */
export function openCutStream(video: HTMLVideoElement, segments: TimeRange[], start: number, load: Load, fail: (error: unknown) => void, loop?: TimeRange) {
  // Keep the engine's canonical segment boundaries so review and full playback share the cache.
  const ranges = loop ? segments.filter(range => range.end > loop.start && range.start < loop.end) : segments;
  const duration = Math.min(ranges.at(-1)?.end ?? 0, loop?.end ?? Infinity);
  if (!duration) throw new Error("This video is empty.");
  const type = typeof MediaSource === "undefined" ? undefined : ["fLaC", "flac"]
    .map(codec => `video/mp4; codecs="avc1.640028,${codec}"`)
    .find(mime => MediaSource.isTypeSupported(mime));
  if (!type) throw new Error("This device cannot play segmented previews.");
  const source = new MediaSource();
  const url = URL.createObjectURL(source);
  let buffer: SourceBuffer | undefined;
  let wanted = start >= duration ? loop?.start ?? 0 : start;
  let seekState: "pending" | "restoring" | "landed" = "pending";
  let disposed = false;
  const loading = new Map<number, AbortController>();
  const staged = new Map<number, ArrayBuffer>();
  let appended = -1;
  let seekTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let settledAt = -1;
  const failedSections = new Set<number>();
  const ready = new Set<number>();
  const recent = new Map<number, ArrayBuffer>();
  let recentBytes = 0;
  const ahead = loop ? 2 : 4;
  const ends = ranges.map(range => range.end);
  const indexAt = (time: number) => Math.min(ends.length - 1, firstIndex(ends, end => time < end));
  const position = () => seekState === "landed" && video.readyState >= 1 ? video.currentTime : wanted;
  const id = logId(source, "s");
  playbackLog("stream open", { id, el: logId(video), sections: ranges.length, duration, start: wanted, loop: loop && [loop.start, loop.end], type });
  /** Which sections the stream holds and waits for, by number. */
  const held = () => ({ at: indexAt(position()), ready: [...ready].sort((a, b) => a - b), appending: appended < 0 ? undefined : appended,
    staged: [...staged.keys()], loading: [...loading.keys()] });
  /**
   * Sections that sit side by side must play as one. A hole between two of them is a break in the sound and a held
   * frame every time playback crosses it, so say where it is and how wide.
   */
  function reportHoles() {
    const buffered = timeRanges(buffer?.buffered);
    for (let i = 1; i < buffered.length; i++) {
      const from = buffered[i - 1]![1], to = buffered[i]![0];
      const before = indexAt(from - 1e-3), after = indexAt(to + 1e-3);
      if (ready.has(before) && ready.has(after) && after - before <= 1) playbackLog("stream hole", { id, from, to, ms: (to - from) * 1000, between: [before, after] });
    }
  }

  function stop(error: unknown) {
    if (disposed) return;
    playbackLog("stream failed", { id, error: String(error), ...held(), ...mediaState(video) });
    dispose();
    fail(error);
  }

  function remember(index: number, bytes: ArrayBuffer) {
    if (bytes.byteLength > RECENT_BYTES) return;
    recentBytes -= recent.get(index)?.byteLength ?? 0;
    recent.delete(index);
    recent.set(index, bytes);
    recentBytes += bytes.byteLength;
    while (recent.size > RECENT_SECTIONS || recentBytes > RECENT_BYTES) {
      const oldest = recent.keys().next().value!;
      recentBytes -= recent.get(oldest)!.byteLength;
      recent.delete(oldest);
    }
  }

  function request(index: number, current: number, neededThrough: number) {
    if (ready.has(index) || index === appended || staged.has(index) || recent.has(index) || loading.has(index) ||
        (failedSections.has(index) && (index < current || index > neededThrough))) return;
    const abort = new AbortController();
    loading.set(index, abort);
    const asked = performance.now();
    playbackLog("stream load", { id, section: index, range: [ranges[index]!.start, ranges[index]!.end], at: current });
    void load(ranges[index]!, abort.signal).then(bytes => {
      if (abort.signal.aborted) return;
      playbackLog("stream loaded", { id, section: index, ms: performance.now() - asked, bytes: bytes.byteLength, t: position() });
      loading.delete(index);
      failedSections.delete(index);
      staged.set(index, bytes);
      pump();
    }, error => {
      if (abort.signal.aborted) return;
      playbackLog("stream load-failed", { id, section: index, ms: performance.now() - asked, error: String(error) });
      loading.delete(index);
      const time = position();
      if (failedSections.has(index) && index >= indexAt(time) && index <= indexAt(time + SECTION_EDGE)) stop(error);
      else { failedSections.add(index); pump(); }
    }).catch(stop);
  }

  function pump() {
    if (!buffer || disposed || seekTimer !== undefined) return;
    try {
      const time = position();
      const current = indexAt(time);
      // A seek just before a seam can wait for the first frame on its far side.
      const neededThrough = indexAt(time + SECTION_EDGE);
      // WebKit can finish the previous seek while the next cut is loading. Keep feeding the requested
      // destination until it can play, then correct a stale landing with a seek into buffered media.
      if (seekState !== "landed" && video.readyState >= 1 && ready.has(current) && ready.has(neededThrough)) {
        if (Math.abs(video.currentTime - time) <= SEEK_LANDING_TOLERANCE) {
          if (!video.seeking) seekState = "landed";
        } else if (seekState === "pending" || !video.seeking) {
          seekState = "restoring";
          playbackLog("stream restore-seek", { id, from: video.currentTime, to: time });
          video.currentTime = time;
        }
      }
      let last = current;
      const playing = !video.paused;
      if (playing) {
        // Queue the seek target first, then its neighbor while the first encoder is busy.
        // Waiting for the first frame here leaves only a partial section to play.
        last += ready.has(current) ? ahead : 1;
      } else if (ready.has(current) && current + 1 < ranges.length && !document.hidden && !video.closest("[hidden]")) {
        if (settledAt === current) last++;
        else idleTimer ??= setTimeout(() => { idleTimer = undefined; settledAt = current; pump(); }, 450);
      }
      last = Math.max(neededThrough, Math.min(last, ranges.length - 1));
      // Encoders may finish out of order. Keep native appends ordered and let fetching
      // overlap both the previous append and eviction after a long jump.
      for (let i = current; i <= last && loading.size < 2; i++) request(i, current, neededThrough);
      if (buffer.updating || appended >= 0) return;
      // Removing buffered media during a seek can strand WebKit at a cut even after the next section arrives.
      // Keep appending the destination and let seeked resume eviction in both directions.
      if (seekState === "landed" && !video.seeking) {
        for (const index of ready) {
          if ((index >= current - 1 && index <= current + ahead) || (loop && index === 0)) continue;
          ready.delete(index);
          const range = ranges[index]!;
          playbackLog("stream evict", { id, section: index, at: current, t: position() });
          // Removing through the seam can erase the next keyframe and every frame depending on it.
          const margin = Math.min(SECTION_EDGE, (range.end - range.start) / 2);
          buffer.remove(range.start, range.end - margin);
          return;
        }
      }
      let index = current;
      while (ready.has(index)) index++;
      if (index === ranges.length && loop && !ready.has(0) && playing) {
        index = 0;
        if (loading.size < 2) request(0, current, neededThrough);
      }
      if (index === ranges.length) {
        if (current === ranges.length - 1 && source.readyState === "open") { playbackLog("stream end", { id }); source.endOfStream(); }
        return;
      }
      if (index > last) return;
      const range = ranges[index]!;
      const bytes = staged.get(index) ?? recent.get(index);
      if (!bytes) return;
      staged.delete(index);
      remember(index, bytes);
      buffer.timestampOffset = range.start;
      appended = index;
      playbackLog("stream append", { id, section: index, offset: range.start, bytes: bytes.byteLength, t: position(), playing });
      buffer.appendBuffer(bytes);
    } catch (error) { stop(error); }
  }
  function updated() {
    if (appended >= 0) {
      ready.add(appended);
      if (playbackLogging()) {
        playbackLog("stream appended", { id, section: appended, buf: timeRanges(buffer?.buffered), t: position() });
        reportHoles();
      }
    }
    appended = -1;
    pump();
  }
  function open() {
    try {
      buffer = source.addSourceBuffer(type!);
      buffer.addEventListener("updateend", updated);
      buffer.addEventListener("error", decodeError);
      source.duration = duration;
      if (loop) buffer.appendWindowEnd = duration;
      video.currentTime = wanted;
      pump();
    } catch (error) { stop(error); }
  }
  function decodeError() { stop(new Error("Couldn’t decode this section of the video.")); }
  function seek(time: number) {
    const target = indexAt(time);
    playbackLog("stream seek", { id, to: time, section: target, have: ready.has(target) || recent.has(target), playing: !video.paused }, `${id}:seek`);
    wanted = time;
    seekState = "pending";
    clearTimeout(idleTimer);
    idleTimer = undefined;
    settledAt = -1;
    if (video.readyState < 1) video.currentTime = time;
    for (const [index, abort] of loading) {
      if (index === target || (index === target + 1 && ready.has(target))) continue;
      abort.abort();
      loading.delete(index);
    }
    for (const [index, bytes] of staged) {
      if (index === target) continue;
      remember(index, bytes);
      staged.delete(index);
    }
    failedSections.clear();
    clearTimeout(seekTimer);
    seekTimer = setTimeout(finishSeek, ready.has(target) || recent.has(target) ? 0 : 70);
  }
  function finishSeek() {
    if (seekTimer === undefined) return;
    clearTimeout(seekTimer);
    seekTimer = undefined;
    pump();
  }
  /** Playback ran out of media: say what the stream had on hand and what it was still fetching. */
  function starved() { playbackLog("stream waiting", { id, ...held(), buf: timeRanges(buffer?.buffered), t: video.currentTime }); }
  function dispose() {
    if (disposed) return;
    disposed = true;
    playbackLog("stream close", { id, t: position(), playing: !video.paused });
    video.removeEventListener("waiting", starved);
    clearTimeout(seekTimer);
    clearTimeout(idleTimer);
    for (const abort of loading.values()) abort.abort();
    staged.clear();
    recent.clear();
    source.removeEventListener("sourceopen", open);
    buffer?.removeEventListener("updateend", updated);
    buffer?.removeEventListener("error", decodeError);
    video.removeEventListener("error", decodeError);
    for (const event of events) video.removeEventListener(event, pump);
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
  const events = ["timeupdate", "seeking", "seeked", "play", "waiting"];
  for (const event of events) video.addEventListener(event, pump);
  video.addEventListener("error", decodeError);
  video.addEventListener("waiting", starved);
  source.addEventListener("sourceopen", open, { once: true });
  video.src = url;
  return { seek, finishSeek, sourceTime: position, dispose };
}
