import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import type { Render } from "@scarlet/shared";
import { planPlaybackSegments, type Change, type TimeRange, type Timeline } from "@scarlet/timeline";
import { api, errorMessage, IS_MOCK } from "../../lib/client";
import { openCutStream, playbackLoader } from "../../lib/cutStream";
import { playbackLog } from "../../lib/playbackLog";
import { arrowSeekTime, ignorePageShortcut, useHotkeys } from "../../lib/hotkeys";
import { clock, pct } from "../../lib/format";
import { selectRender, useProjectStore } from "../../stores/project";
import { usePlayerStore } from "../../stores/player";
import { editTargetAt, useUiStore } from "../../stores/ui";
import { TimelineScrubber } from "./TimelineScrubber";
import type { TimelineMarker } from "./TimelineMarkers";
import { cutFrameUrl, scrubFrameUrl } from "./thumbs";
import { BeforeToggle } from "./BeforeToggle";
import { OriginalFootage } from "./OriginalFootage";
import { Progress, Spinner } from "../ui/primitives";
import { MonitorPlayback, PlaybackTime } from "../player/MonitorPlayback";
import { FramedVideo } from "../player/FramedVideo";
import { editIcon } from "./EditReferences";

import type { CutAudition } from "./cutReviewDetails";

export const REVIEW_WINDOW_SECONDS = 10;

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

export interface ComparisonPlayback {
  toggle(): void;
  position(): { elapsed: number; playing: boolean };
}
export interface ComparisonPanePlayback extends ComparisonPlayback {
  pause(): void;
  replay(offset: number): void;
  /** Move to `offset` seconds from the clip's start, playing or paused as it was. */
  seek(offset: number): void;
  /**
   * Pause for a drag on a timeline. `carryOn` goes on as it was, once the drag ends. `playing` says whether that is
   * playing, for a drag that ends where this clip has nothing to show.
   */
  scrub(): { playing: boolean; carryOn(): void };
}
export type ComparisonSide = "Before" | "After";

/**
 * The change itself, as a short looping clip of the affected seconds plus a
 * little context. Standalone reviews switch sides. The split monitor pins
 * each instance to one side and gives the selected pane the transport.
 */
export function ChangeClip({ change, slot = 0, aspect, active = true, pane, inMonitor = !!pane, loading, clock: pageClock, timelineHost, clockHost, previewTimeline,
  autoPlay = true, initialOffset, startProposed = false, playbackRef, onTransportChange, onPassageStart, onElapsed, standby, muted, onToggle, onSideChange, onLeave, cut, audition }: {
  change: Change;
  slot?: number;
  aspect: number;
  active?: boolean;
  pane?: ComparisonSide;
  inMonitor?: boolean;
  /** The monitor's picture is still loading: this clip's play button shows it. */
  loading?: boolean;
  /** The page's clock, shown beside the play button in place of this clip's own when the page's playhead goes with the clip. */
  clock?: ReactNode;
  /** Where the clip is, in seconds from its start: whenever it moves, and on every frame while it plays. */
  onElapsed?(elapsed: number): void;
  standby?: boolean;
  muted?: boolean;
  onToggle?(): void;
  onPassageStart?(offset: number): void;
  onSideChange?(side: ComparisonSide): void;
  timelineHost?: HTMLElement | null;
  clockHost?: HTMLElement | null;
  previewTimeline?: Timeline;
  autoPlay?: boolean;
  initialOffset?: number;
  onLeave?(elapsed: number, side: ComparisonSide): void;
  startProposed?: boolean;
  playbackRef?: Ref<ComparisonPanePlayback>;
  onTransportChange?(state: { playable: boolean; playing: boolean }): void;
  audition?: TimeRange & { at: number; description: string; markers?: TimelineMarker[]; beforeVersion?: string }; // Play this window once around the applied edit.
  cut?: { original: Timeline; removed: TimeRange; at: number; retained?: boolean; proposedVersion?: string; proposedError?: string; prepareProposed?(): void; selectSide?(side: ComparisonSide): void;
    before: CutAudition; after?: CutAudition };
}) {
  const current = useProjectStore((s) => s.current);
  const requestRender = useProjectStore((s) => s.requestRender);
  const ensureRender = useProjectStore((s) => s.ensureRender);
  const waitingForProposed = !!cut && !cut.after;
  const pair = cut ? { beforeRange: cut.before.range, range: cut.after?.range ?? { start: 0, end: 0 }, before: null, after: null } : change.renders[slot];
  const onDemand = !!audition || !!pair?.beforeRange;
  const { canShowBefore, hasAfter, sourceBefore } = comparisonSides(pair, !cut && !!current?.media.length);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; render?: Render; error?: string }>();
  const [prefetched, setPrefetched] = useState<typeof result>();
  const video = useRef<HTMLVideoElement | null>(null);
  const rate = usePlayerStore(s => audition?.beforeVersion ? s.rate : 1);
  const wantPlay = useRef(autoPlay);
  const [side, setSide] = useState<ComparisonSide>(inMonitor && !startProposed ? "Before" : "After");
  const visible = audition ? (audition.beforeVersion ? "Before" : "After") : pane ?? (canShowBefore && (side === "Before" || (!hasAfter && !waitingForProposed)) ? "Before" : "After");
  const sideLabel = cut ? (visible === "Before" ? "Original" : "Proposed") : visible;
  const awaitingCut = waitingForProposed && visible === "After";
  const selectedCut = visible === "Before" ? cut?.before : cut?.after;
  const cueOffset = selectedCut?.excerpt ? selectedCut.excerpt.start - selectedCut.range.start : 0;
  const [elapsed, setElapsed] = useState(initialOffset ?? cueOffset);
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
  useLayoutEffect(() => {
    onTransportChange?.({ playable: active && hasVideo, playing });
  }, [active, hasVideo, playing, onTransportChange]);
  const [originalAt, setOriginalAt] = useState<{ time: number }>({ time: (pair?.range.start ?? 0) + (initialOffset ?? 0) });
  useLayoutEffect(() => { onSideChange?.(visible); }, [visible, onSideChange]);
  const version = visible === "Before" ? audition?.beforeVersion ?? cut?.original.version ?? change.fromVersion : cut?.proposedVersion ?? change.toVersion;
  const raw = !audition && visible === "Before" && sourceBefore;
  const legacyId = visible === "Before" ? pair?.before : pair?.after;
  const legacy = selectRender(current, legacyId);
  const range = audition ?? (visible === "Before" && !raw ? pair?.beforeRange : pair?.range) ?? legacy?.range ?? pair?.range ?? change.ranges[slot];
  const rangeStart = range?.start ?? 0;
  const length = Math.max(0, (range?.end ?? rangeStart) - rangeStart);
  const frame = 1 / (current?.project.settings.fps || 30);
  const lastFrame = Math.max(0, length - frame);
  const offset = Math.min(elapsed, lastFrame);
  const rangeEnd = rangeStart + length;
  const streamKey = JSON.stringify([change.projectId, version, rangeStart, rangeEnd]);
  const cutKey = cut && (visible + streamKey);
  const previousCut = useRef(cutKey);
  const resumeWhenReady = useRef(awaitingCut);
  useLayoutEffect(() => {
    if (cutKey && previousCut.current !== cutKey) {
      cursor.current = resumeWhenReady.current && visible === "After" ? initialOffset ?? cueOffset : cueOffset;
      resumeWhenReady.current = false;
    }
    previousCut.current = cutKey;
    cursor.current = Math.min(cursor.current, lastFrame);
    setElapsed(cursor.current);
  }, [cutKey, cueOffset, initialOffset, lastFrame, visible]);
  const [failedStream, setFailedStream] = useState<string>();
  const streamTimeline = (cut || audition?.beforeVersion) && length > REVIEW_WINDOW_SECONDS && !IS_MOCK && streamKey !== failedStream
    ? (visible === "Before" ? cut?.original ?? previewTimeline : previewTimeline) : undefined;
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
  }, [active, streamRanges, rangeStart, rangeEnd, change.projectId, version, streamKey, cutKey]);
  const windowed = onDemand && !audition && !streaming;
  const windowOffset = windowed ? Math.floor(offset / REVIEW_WINDOW_SECONDS) * REVIEW_WINDOW_SECONDS : 0;
  const start = rangeStart + windowOffset;
  const end = Math.min(rangeEnd, windowed ? start + REVIEW_WINDOW_SECONDS : Infinity);
  const key = JSON.stringify([change.projectId, version, start, end, attempt]);
  const prepared = prefetched?.key === key ? prefetched : undefined;
  const loaded = result?.key === key ? result : prepared;
  const render = onDemand ? selectRender(current, loaded?.render?.id) ?? loaded?.render : legacy;

  const missingLegacy = !onDemand && !render ? legacyId : undefined;
  useEffect(() => { if (active && missingLegacy) void ensureRender(missingLegacy); }, [active, missingLegacy, ensureRender]);

  useEffect(() => {
    if (!active || !onDemand || raw || streaming || result?.key === key) return;
    if (end <= start) return;
    if (prepared) { setResult(prepared); return; }
    let selected = true;
    // A drag can cross many render windows. Only prepare the one it settles on.
    const load = () => {
      requestRender({ kind: "segment", quality: "preview", version, range: { start, end } }).then(
        render => { if (selected) setResult({ key, render }); },
        error => { if (selected) setResult({ key, error: errorMessage(error) }); },
      );
    };
    const timer = windowOffset ? window.setTimeout(load, 80) : undefined;
    if (timer === undefined) load();
    return () => { selected = false; clearTimeout(timer); };
  }, [active, onDemand, raw, streaming, start, end, version, key, windowOffset, requestRender, result?.key, prepared]);
  const src = !raw && render?.state === "done" ? api.renderFileUrl(render.id) : undefined;
  // Prepare the next standalone MP4 while the current one plays.
  useEffect(() => {
    if (!active || !windowed || !playing || video.current?.paused || !src || length <= REVIEW_WINDOW_SECONDS) return;
    const nextOffset = end < rangeEnd ? windowOffset + REVIEW_WINDOW_SECONDS : Math.floor(cueOffset / REVIEW_WINDOW_SECONDS) * REVIEW_WINDOW_SECONDS;
    const from = rangeStart + nextOffset;
    const to = Math.min(rangeEnd, from + REVIEW_WINDOW_SECONDS);
    const nextKey = JSON.stringify([change.projectId, version, from, to, attempt]);
    if (nextKey === key || prefetched?.key === nextKey) return;
    let live = true;
    void requestRender({ kind: "segment", quality: "preview", version, range: { start: from, end: to } })
      .then(render => { if (live) setPrefetched({ key: nextKey, render }); }, () => {});
    return () => { live = false; };
  }, [active, windowed, playing, src, length, rangeStart, rangeEnd, windowOffset, end, cueOffset, change.projectId, version, attempt, key, requestRender, prefetched?.key]);

  function move(next: number) {
    cursor.current = Math.min(lastFrame, Math.max(0, next));
    setElapsed(cursor.current);
  }
  function seek(at: number) {
    move(at - rangeStart);
    if (raw) {
      setOriginalAt({ time: rangeStart + cursor.current });
      return;
    }
    if (streaming) {
      const target = rangeStart + cursor.current;
      stream.current?.seek(target);
      if (video.current && video.current.readyState >= 1) video.current.currentTime = target;
      return;
    }
    const local = cursor.current - windowOffset;
    if (video.current && local >= 0 && local < end - start && video.current.readyState >= 1) video.current.currentTime = local;
  }
  function seekPassage(at: number) {
    seek(at);
    onPassageStart?.(cursor.current);
  }
  useHotkeys(e => {
    if (!active || !pane || standby || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    seekPassage(arrowSeekTime(rangeStart + cursor.current, e.key, e.shiftKey));
  });
  const captureOriginal = useCallback(() => {
    if (pair) setOriginalAt({ time: pair.range.start + Math.min(cursor.current, Math.max(0, pair.range.end - pair.range.start - frame)) });
  }, [pair?.range, frame]);
  function play(el: HTMLVideoElement) {
    void el.play().catch(() => {
      if (video.current !== el || !el.paused) return;
      wantPlay.current = false;
      setPlaying(false);
    });
  }
  function playCutFromCue() {
    wantPlay.current = true;
    seek(rangeStart + cueOffset);
    const el = video.current;
    if (el && el.readyState >= 1 && (streaming || (cueOffset >= windowOffset && cueOffset < end - rangeStart))) play(el);
  }
  function hold() {
    // A listen that played to its end and stopped there was still being played: the editor didn't pause it, so it
    // plays from the point they pick, as the player does.
    const resume = video.current && !(audition && video.current.paused) ? !video.current.paused : wantPlay.current;
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
  const holdForScrub = () => hold().carryOn;
  function selectSide(next: ComparisonSide) {
    if (cut) {
      resumeWhenReady.current = false;
      if (active) wantPlay.current = true;
      if (next === "After") cut.prepareProposed?.();
      cut.selectSide?.(next);
    } else if (next === "Before" && sourceBefore && !raw) captureOriginal();
    setSide(next);
  }
  function toggle() {
    const el = video.current;
    if (!el || !active || standby) return;
    wantPlay.current = el.paused;
    if (el.paused) {
      onPassageStart?.(position().elapsed);
      if (audition && cursor.current >= lastFrame) seek(rangeStart);
      play(el);
    } else el.pause();
  }
  function position() {
    const el = video.current;
    const at = !raw && el && el.readyState >= 1
      ? (stream.current?.sourceTime() ?? el.currentTime) + (streaming ? -rangeStart : windowOffset)
      : cursor.current;
    const resume = el && el.readyState >= 1 ? !el.paused && !el.ended : wantPlay.current;
    return { elapsed: Math.min(at, lastFrame), playing: resume };
  }
  const remember = useRef<() => void>(undefined);
  remember.current = () => onLeave?.(position().elapsed, visible);
  useLayoutEffect(() => () => remember.current?.(), []);
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
    toggle, position,
    pause() {
      wantPlay.current = false;
      video.current?.pause();
    },
    replay(offset) {
      if (!active) return;
      wantPlay.current = true;
      seek(rangeStart + offset);
      const el = video.current;
      if (el && (raw || (el.readyState >= 1 && cursor.current >= windowOffset && cursor.current < end - rangeStart))) play(el);
    },
    seek(offset) { seekPassage(rangeStart + offset); },
    scrub: hold,
  }));

  useEffect(() => {
    if (!active) {
      video.current?.pause();
      wantPlay.current = false;
      return;
    }
    if (standby) return;
    const down = (e: KeyboardEvent) => {
      if (ignorePageShortcut(e, video.current)) return;
      if (e.key === " ") {
        e.preventDefault();
        if (!e.repeat) toggle();
      }
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [active, canShowBefore, sourceBefore, raw, pane, standby, captureOriginal, audition]);

  const versionForFrames = raw ? change.toVersion : version;
  const [otherTimeline, setOtherTimeline] = useState<{ version: string; timeline: Timeline }>();
  const [failedTimeline, setFailedTimeline] = useState<string>();
  const [timelineAttempt, setTimelineAttempt] = useState(0);
  const knownTimeline = [previewTimeline, cut?.original, current?.timeline].find(t => t?.version === versionForFrames)
    ?? (otherTimeline?.version === versionForFrames ? otherTimeline.timeline : undefined);
  useEffect(() => {
    if (!active || cut || (standby && !raw) || knownTimeline || !versionForFrames) return;
    let live = true;
    setFailedTimeline(undefined);
    void api.timeline(change.projectId, versionForFrames).then(({ timeline }) => { if (live) setOtherTimeline({ version: versionForFrames, timeline }); }).catch(() => { if (live) setFailedTimeline(versionForFrames); });
    return () => { live = false; };
  }, [active, cut, standby, raw, knownTimeline, change.projectId, versionForFrames, timelineAttempt]);
  const project = current?.project;
  const media = current?.media;
  const frameAt = useCallback((at: number, exact?: boolean) => {
    const t = Math.min(at, rangeStart + lastFrame);
    return raw ? scrubFrameUrl(undefined, knownTimeline ?? null, media ?? [], t, exact)
      : project && cutFrameUrl(project, knownTimeline, t, exact);
  }, [raw, knownTimeline, project, media, rangeStart, lastFrame]);
  const cutMarkers = useMemo(() => audition ? audition.markers ?? [{
    id: "applied", kind: "edit" as const, time: audition.at, description: audition.description, icon: editIcon(change, change.description),
  }] : cut && (cut.retained ? [{ time: visible === "Before" ? cut.removed.start : cut.at, description: "Retained passage" }] : visible === "Before" ? [
    { time: cut.removed.start, description: "Proposed trim starts here" },
    { time: cut.removed.end, description: "Original footage resumes here" },
  ] : [{ time: cut.at, description: "Proposed edit joins here" }]).map(mark => ({
    ...mark, id: mark.description, kind: "edit" as const, icon: "trim" as const,
  })), [audition, change, cut, visible]);
  const time = rangeStart + offset;
  const endTime = rangeStart + length;
  const clockDisplay = <PlaybackTime time={time} end={endTime} loop={!audition} />;
  const timeline = !standby && length > 0 && <TimelineScrubber reviewing activeShortcuts={active}
      start={rangeStart} duration={length} playhead={time} pictureAspect={aspect} editMarkers={cutMarkers} frameAt={frameAt} onSeek={seekPassage}
      waveform={media ? { media, mediaPaused: project?.mediaPaused, timeline: knownTimeline, original: raw } : undefined}
      label={pane ? `Position in change loop, ${clock(rangeStart)} to ${clock(rangeStart + length)}` : undefined}
      onSelectTime={pane ? at => useUiStore.getState().setAgentContext(editTargetAt(Math.min(at, rangeStart + lastFrame), versionForFrames, knownTimeline)) : undefined}
      onScrubStart={holdForScrub} />;
  const tall = aspect < 1;
  const standaloneSize = { "--picture-aspect": aspect, aspectRatio: aspect,
    width: tall ? `min(100%, ${aspect * 60}vh, ${aspect * 560}px)` : `min(100%, ${aspect * 47}dvh)` } as CSSProperties;
  return (
    <>
      <div className={inMonitor ? "absolute inset-0" : "clip-monitor relative flex justify-center"}>
        <div className={inMonitor ? "absolute inset-0 bg-black" : "relative rounded-md overflow-hidden bg-black"} style={inMonitor ? undefined : standaloneSize}>
          {/* A stream short of its section is marked on the video. The monitor's play button shows the wait, in place of its icon. */}
          {(streaming || src) && <FramedVideo key={(streaming ? streamKey : key + src) + (cut ? visible : "")} ref={attachVideo} src={streaming ? undefined : src} muted={muted}
            loop={!streaming && !audition && !standby && (!windowed || length <= REVIEW_WINDOW_SECONDS)} playsInline preload="auto"
            data-waiting={(streaming && active && buffering) || undefined}
            aria-label={sideLabel} onClick={onToggle ?? toggle}
            onLoadedMetadata={e => {
              const el = e.currentTarget;
              el.playbackRate = rate;
              if (!streaming) el.currentTime = Math.max(0, Math.min(el.duration, cursor.current - windowOffset));
              if (active && !standby && wantPlay.current) play(el);
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
              if (standby) return;
              // Encoded clips may include a fraction of a frame past their requested range.
              if (el.currentTime >= end - start && wantPlay.current) {
                if (audition) { el.pause(); move(lastFrame); }
                else if (cut && end >= rangeEnd) playCutFromCue();
                else if (end >= rangeStart + length) { el.currentTime = 0; move(0); }
                else move(windowOffset + REVIEW_WINDOW_SECONDS);
              } else move(windowOffset + el.currentTime);
            }}
            onEnded={() => { if (cut && end >= rangeEnd && active && wantPlay.current) playCutFromCue();
              else if (audition) { move(lastFrame); setPlaying(false); }
              else if (!standby && wantPlay.current) move(end < rangeEnd ? windowOffset + REVIEW_WINDOW_SECONDS : 0); }} />}
          {raw && active && current && <OriginalFootage onVideo={attachVideo} muted={muted} onToggle={onToggle ?? toggle} onPlaybackChange={setPlaying}
            target={originalAt} timeline={knownTimeline ?? undefined} media={current.media}
            autoPlay={wantPlay.current} end={rangeStart + length} onPosition={at => move(at - rangeStart)}
            onAdvance={at => seek(at >= rangeStart + length ? rangeStart : at)}
            failedTimeline={failedTimeline === versionForFrames} onRetryTimeline={() => setTimelineAttempt(n => n + 1)} />}
          {!raw && !streaming && <Overlay render={render} label={sideLabel} loading={onDemand && (end > start || awaitingCut)}
            error={awaitingCut ? cut?.proposedError : loaded?.error} retry={onDemand && !awaitingCut ? () => setAttempt(n => n + 1) : undefined} />}

        </div>
        {!pane && <MonitorPlayback playing={playing} playable={active && hasVideo} loading={loading} onToggle={toggle} controls={!audition &&
          <BeforeToggle on={visible === "Before"} toggle={() => selectSide(visible === "Before" ? "After" : "Before")}
            shortcutActive={active && !standby} autoFocus={inMonitor && !cut} disabled={!canShowBefore || (!hasAfter && !waitingForProposed)}
            busy={awaitingCut && !cut?.proposedError} />}>{pageClock ?? clockDisplay}</MonitorPlayback>}
      </div>
      {(pane || audition || cut) ? timelineHost && createPortal(timeline, timelineHost) : timeline}
      {clockHost && createPortal(clockDisplay, clockHost)}
    </>
  );
}
