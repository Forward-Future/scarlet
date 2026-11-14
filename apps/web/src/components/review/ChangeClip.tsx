import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import type { Render } from "@scarlet/shared";
import { planPlaybackSegments, type Change, type TimeRange, type Timeline } from "@scarlet/timeline";
import { api, errorMessage, IS_MOCK } from "../../lib/client";
import { openCutStream, playbackLoader } from "../../lib/cutStream";
import { playbackLog } from "../../lib/playbackLog";
import { ignorePageShortcut } from "../../lib/hotkeys";
import { pct } from "../../lib/format";
import { selectRender, useProjectStore } from "../../stores/project";
import { usePlayerStore } from "../../stores/player";
import { Progress, Spinner } from "../ui/primitives";
import { MonitorPlayback, PlaybackTime } from "../player/MonitorPlayback";
import { FramedVideo } from "../player/FramedVideo";

const REVIEW_WINDOW_SECONDS = 10;

export function comparisonSides(pair: Change["renders"][number] | undefined, allowSource: boolean) {
  const hasBefore = pair?.beforeRange ? pair.beforeRange.end > pair.beforeRange.start : !!pair?.before;
  const hasAfter = !!pair?.after || !!(pair?.beforeRange && pair.range.end > pair.range.start);
  const sourceBefore = allowSource && !hasBefore && hasAfter;
  return { canShowBefore: hasBefore || sourceBefore, hasAfter, sourceBefore };
}

function Overlay({ render, label, loading, error, retry }: {
  render?: Render; label: string; loading: boolean; error?: string; retry?(): void;
}) {
  if (render?.state === "done") return null;
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/75 text-[12px] text-center p-4">
      {!render && !loading && !error ? (
        <span className="text-muted">The {label.toLowerCase()} clip isn't rendered.</span>
      ) : error || render?.state === "failed" || render?.state === "cancelled" ? (
        <>
          <span className="text-bad font-medium">The {label.toLowerCase()} clip failed to render</span>
          <span className="text-muted max-w-sm break-words">{error ?? render?.error}</span>
          {retry && <button className="btn-ghost" onClick={retry}>Retry preview</button>}
        </>
      ) : (
        <>
          <span className="text-fg inline-flex items-center gap-2">
            <Spinner className="size-3" /> Rendering {label.toLowerCase()} clip… {render && pct(render.progress)}
          </span>
          {render && <Progress value={render.progress} className="w-40" />}
        </>
      )}
    </div>
  );
}

export interface ComparisonPanePlayback {
  position(): { elapsed: number; playing: boolean };
  pause(): void;
  /** Move to `offset` seconds from the clip's start, playing or paused as it was. */
  seek(offset: number): void;
  /**
   * Pause for a drag on a timeline. `carryOn` goes on as it was, once the drag ends. `playing` says whether that is
   * playing, for a drag that ends where this clip has nothing to show.
   */
  scrub(): { playing: boolean; carryOn(): void };
}

/**
 * The footage as it was before an edit: `audition` is the passage in the earlier version, played once in the
 * monitor. A long passage streams from `previewTimeline`; a short one plays as one rendered clip.
 */
export function ChangeClip({ change, active = true, loading, clock: pageClock, previewTimeline, playbackRef, onElapsed, audition }: {
  change: Change;
  active?: boolean;
  /** The monitor's picture is still loading: this clip's play button shows it. */
  loading?: boolean;
  /** The page's clock, shown beside the play button in place of this clip's own when the page's playhead goes with the clip. */
  clock?: ReactNode;
  /** Where the clip is, in seconds from its start: whenever it moves, and on every frame while it plays. */
  onElapsed?(elapsed: number): void;
  previewTimeline: Timeline;
  playbackRef?: Ref<ComparisonPanePlayback>;
  audition: TimeRange & { beforeVersion: string };
}) {
  const current = useProjectStore((s) => s.current);
  const requestRender = useProjectStore((s) => s.requestRender);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; render?: Render; error?: string }>();
  const video = useRef<HTMLVideoElement | null>(null);
  const rate = usePlayerStore(s => s.rate);
  const wantPlay = useRef(true);
  const [elapsed, setElapsed] = useState(0);
  const cursor = useRef(elapsed);
  const [playing, setPlaying] = useState(false);
  const [hasVideo, setHasVideo] = useState(false);
  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    if (!el) video.current?.pause();
    video.current = el;
    setHasVideo(!!el);
    setPlaying(!!el && !el.paused);
  }, []);
  useLayoutEffect(() => { if (video.current) video.current.playbackRate = rate; }, [rate, hasVideo]);
  const version = audition.beforeVersion;
  const rangeStart = audition.start;
  const length = Math.max(0, audition.end - rangeStart);
  const frame = 1 / (current?.project.settings.fps || 30);
  const lastFrame = Math.max(0, length - frame);
  const offset = Math.min(elapsed, lastFrame);
  const rangeEnd = rangeStart + length;
  const streamKey = JSON.stringify([change.projectId, version, rangeStart, rangeEnd]);
  useLayoutEffect(() => {
    cursor.current = Math.min(cursor.current, lastFrame);
    setElapsed(cursor.current);
  }, [lastFrame]);
  const [failedStream, setFailedStream] = useState<string>();
  const streamTimeline = length > REVIEW_WINDOW_SECONDS && !IS_MOCK && streamKey !== failedStream ? previewTimeline : undefined;
  const settings = current?.project.settings;
  // From the frame rate alone, so a project update that leaves it as it was doesn't reopen the stream.
  const streamRanges = useMemo(() => {
    if (!streamTimeline || !settings) return;
    try { return planPlaybackSegments({ settings }, streamTimeline); }
    catch { return undefined; } // A legacy version outside the playback budget can still be reviewed in a short window.
  }, [streamTimeline, settings?.fps]); // eslint-disable-line react-hooks/exhaustive-deps
  const streaming = !!streamRanges?.length;
  const stream = useRef<ReturnType<typeof openCutStream> | null>(null);
  const [buffering, setBuffering] = useState(false);
  useLayoutEffect(() => {
    const el = video.current;
    if (!active || !el || !streamRanges?.length) return;
    setBuffering(true);
    try {
      stream.current = openCutStream(el, streamRanges, rangeStart + cursor.current, playbackLoader(change.projectId, version),
        () => setFailedStream(streamKey), { start: rangeStart, end: rangeEnd });
    } catch (reason) {
      // A stream logs its own failures. One that couldn't open has no stream to say so.
      playbackLog("stream open-failed", { version, sections: streamRanges.length, error: String(reason) });
      setFailedStream(streamKey);
    }
    return () => { stream.current?.dispose(); stream.current = null; };
  }, [active, streamRanges, rangeStart, rangeEnd, change.projectId, version, streamKey]);
  const key = JSON.stringify([change.projectId, version, rangeStart, rangeEnd, attempt]);
  const loaded = result?.key === key ? result : undefined;
  const render = selectRender(current, loaded?.render?.id) ?? loaded?.render;

  useEffect(() => {
    if (!active || streaming || result?.key === key) return;
    if (rangeEnd <= rangeStart) return;
    let selected = true;
    requestRender({ kind: "segment", quality: "preview", version, range: { start: rangeStart, end: rangeEnd } }).then(
      render => { if (selected) setResult({ key, render }); },
      error => { if (selected) setResult({ key, error: errorMessage(error) }); },
    );
    return () => { selected = false; };
  }, [active, streaming, rangeStart, rangeEnd, version, key, requestRender, result?.key]);
  const src = render?.state === "done" ? api.renderFileUrl(render.id) : undefined;

  function move(next: number) {
    cursor.current = Math.min(lastFrame, Math.max(0, next));
    setElapsed(cursor.current);
  }
  function seek(at: number) {
    move(at - rangeStart);
    if (streaming) {
      const target = rangeStart + cursor.current;
      stream.current?.seek(target);
      if (video.current && video.current.readyState >= 1) video.current.currentTime = target;
      return;
    }
    const local = cursor.current;
    if (video.current && local >= 0 && local < rangeEnd - rangeStart && video.current.readyState >= 1) video.current.currentTime = local;
  }
  function play(el: HTMLVideoElement) {
    void el.play().catch(() => {
      if (video.current !== el || !el.paused) return;
      wantPlay.current = false;
      setPlaying(false);
    });
  }
  function hold() {
    // A listen that played to its end and stopped there was still being played: the editor didn't pause it, so it
    // plays from the point they pick, as the player does.
    const resume = video.current && !video.current.paused ? true : wantPlay.current;
    wantPlay.current = false;
    video.current?.pause();
    return { playing: resume, carryOn() {
      stream.current?.finishSeek();
      if (resume) {
        wantPlay.current = true;
        if (video.current) play(video.current);
      }
    } };
  }
  function toggle() {
    const el = video.current;
    if (!el || !active) return;
    wantPlay.current = el.paused;
    if (el.paused) {
      if (cursor.current >= lastFrame) seek(rangeStart);
      play(el);
    } else el.pause();
  }
  function position() {
    const el = video.current;
    const at = el && el.readyState >= 1
      ? (stream.current?.sourceTime() ?? el.currentTime) + (streaming ? -rangeStart : 0)
      : cursor.current;
    const resume = el && el.readyState >= 1 ? !el.paused && !el.ended : wantPlay.current;
    return { elapsed: Math.min(at, lastFrame), playing: resume };
  }
  // A playhead that goes with this clip hears where it is whenever it moves. While it plays that is every frame: the
  // video reports its own time only a few times a second, and the playhead would move in steps.
  useLayoutEffect(() => { onElapsed?.(offset); }, [offset, onElapsed]);
  const where = useRef(position);
  where.current = position;
  useEffect(() => {
    if (!onElapsed || !playing) return;
    let frame = requestAnimationFrame(function tick() {
      onElapsed(where.current().elapsed);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [onElapsed, playing]);
  useImperativeHandle(playbackRef, () => ({
    position,
    pause() {
      wantPlay.current = false;
      video.current?.pause();
    },
    seek(offset) { seek(rangeStart + offset); },
    scrub: hold,
  }));

  useEffect(() => {
    if (!active) {
      video.current?.pause();
      wantPlay.current = false;
      return;
    }
    const down = (e: KeyboardEvent) => {
      if (ignorePageShortcut(e, video.current)) return;
      if (e.key === " ") {
        e.preventDefault();
        if (!e.repeat) toggle();
      }
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [active, audition]);

  return (
    <div className="absolute inset-0">
      <div className="absolute inset-0 bg-black">
        {/* A stream short of its section is marked on the video. The monitor's play button shows the wait, in place of its icon. */}
        {(streaming || src) && <FramedVideo key={streaming ? streamKey : key + src} ref={attachVideo} src={streaming ? undefined : src}
          playsInline preload="auto"
          data-waiting={(streaming && active && buffering) || undefined}
          aria-label="Before" onClick={toggle}
          onLoadedMetadata={e => {
            const el = e.currentTarget;
            el.playbackRate = rate;
            if (!streaming) el.currentTime = Math.max(0, Math.min(el.duration, cursor.current));
            if (active && wantPlay.current) play(el);
          }}
          onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
          onWaiting={streaming ? () => setBuffering(true) : undefined}
          onCanPlay={streaming ? () => setBuffering(false) : undefined}
          onPlaying={streaming ? () => setBuffering(false) : undefined}
          onTimeUpdate={e => {
            const el = e.currentTarget;
            if (streaming) {
              if (el.readyState >= 1) move((stream.current?.sourceTime() ?? el.currentTime) - rangeStart);
              return;
            }
            // Encoded clips may include a fraction of a frame past their requested range.
            if (el.currentTime >= rangeEnd - rangeStart && wantPlay.current) { el.pause(); move(lastFrame); }
            else move(el.currentTime);
          }}
          onEnded={() => { move(lastFrame); setPlaying(false); }} />}
        {!streaming && <Overlay render={render} label="Before" loading={rangeEnd > rangeStart} retry={() => setAttempt(n => n + 1)}
          error={loaded?.error} />}

      </div>
      <MonitorPlayback playing={playing} playable={active && hasVideo} loading={loading} onToggle={toggle}>
        {pageClock ?? <PlaybackTime time={rangeStart + offset} end={rangeStart + length} />}</MonitorPlayback>
    </div>
  );
}
