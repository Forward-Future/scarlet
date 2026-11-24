import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode, type RefObject } from "react";
import { createStore, useStore } from "zustand";
import type { TimeRange } from "@scarlet/timeline";
import { useUiStore } from "../../stores/ui";
import { ignorePageShortcut, useHotkeys } from "../../lib/hotkeys";
import { playbackLog } from "../../lib/playbackLog";
import type { ScrubRelease } from "../../lib/player";
import type { WaveformMedia } from "./TimelineWaveform";
import { ScrubPreview, type HoverVideo } from "../player/ScrubPreview";
import { TimelineRuler } from "./TimelineRuler";
import { useTimelineZoom } from "./useTimelineZoom";
import { FloatingScrubLoupe, type ScrubLens } from "./FloatingScrubLoupe";
import { LOUPE_PX_PER_FRAME, lastFrameBefore, rangeEdges, useRangeSelect } from "./TimelineRange";
import type { ProgressFocus } from "../player/SimpleProgress";
import { HeldStillsContext, MediaLanes, stripUrl, type FrameAt, type HeldStills, type PreviewStrip } from "./TimelineFilmstrip";
import { bandLabel, dotState, gapAt, gapLabel, isPill, LANDING_PLAYS, layoutMarks, MARK_GAP, nearestMark, ZOOM_STEPS, type MarkLayout, type TimelineDot, type TimelineGap } from "./timelineMarkerLayout";
import { TimelineClock, TimelineSlider } from "./TimelineSlider";

export { gapAt };
export type { TimelineDot, TimelineGap };

/** Hovering a chat row lights its marker without re-rendering the workspace. */
export const EditHoverContext = createContext(createStore<number | undefined>(() => undefined));

interface TimelineScrubberProps {
  activeShortcuts?: boolean;
  /** Sits in the timeline's bottom row, between the clock and the zoom: what ⌘Z takes back. */
  foot?: ReactNode;
  duration: number;
  start?: number;
  playhead?: number;
  waveform?: WaveformMedia;
  pictureAspect?: number;
  previewStrip?: PreviewStrip | null;
  hoverVideo?: HoverVideo;
  frameAt: FrameAt;
  onSeek(time: number): void;
  /** Commit an editor-selected position, independently of playback updates. */
  onSelectTime?(time: number): void;
  /** Suspend playback during a pointer drag. The returned callback runs on release. */
  onScrubStart?(gesture: AbortSignal): ((release?: ScrubRelease) => void) | undefined;
  /** The simple view's highlight: zoom to the change and shade what it touches. */
  highlight?: ProgressFocus;
  /**
   * The simple view's change dots: the edits of the request picked in the chat, or of the one that's open. They are all
   * that view's timeline marks. Hovering one shows only the frame and its time, and names one waiting on the editor.
   */
  marks?: TimelineDot[];
  /** Times mentioned in the unsent message, on this timeline. */
  typedTimes?: number[];
  /** Footage other cuts took out, marked over the version the timeline shows. */
  gaps?: TimelineGap[];
  /** Passages the current playback skips, in this timeline's clock. */
  skippedRanges?: TimeRange[];
  /** A click inside a skipped gap, at the time it points to. It doesn't seek: the caller decides where to play it. */
  onGap?(gap: TimelineGap, time: number): void;
  /** A click inside the highlight's band, at the time it points to. It doesn't seek: the caller decides where to play it. */
  onBand?(time: number): void;
  /** Changes each time the caller asks for the whole timeline, which it then zooms out to. */
  fit?: number;
  /** The stretch the editor marked for the message they're writing, in this timeline's clock. */
  range?: TimeRange;
  /**
   * A drag along the ruler marks a stretch, and its handles adjust it. With this, a press on the ruler that doesn't move
   * still moves the playhead; without it the ruler scrubs like the rest of the timeline.
   */
  onRange?(range: TimeRange | undefined, byKey?: boolean): void;
  /** The video's frame rate: a marked range's ends sit on frames. */
  fps?: number;
}

const noRange = () => {};

export function PlayerTimeline(props: Omit<TimelineScrubberProps, "playhead">) {
  return <TimelineScrubber {...props} />;
}

/**
 * What a timeline showed, for the one built in its place. A new working cut builds the timeline again: of the same
 * footage (`subject`) and with the same change open (`highlight`), it keeps the stretch the editor had zoomed to.
 * `view` is that stretch; none when it showed the whole video, which the next one then does too.
 */
interface KeptView { subject: string; highlight: string; view?: { from: number; span: number } }

export function TimelineScrubber(props: TimelineScrubberProps) {
  const { start, duration, waveform } = props;
  const subject = [waveform?.source?.id, waveform?.original, start];
  const context = [...subject, waveform?.timeline?.version, duration];
  const key = JSON.stringify(context);
  const kept = useRef<KeptView>(undefined);
  const held = useRef<HeldStills>(undefined);
  const subjectKey = JSON.stringify(subject);
  const carry = useMemo(() => ({ subject: subjectKey, built: key, start: start ?? 0, duration, held }), [subjectKey, key, start, duration]);
  // Building the timeline again reloads every still on it, so say what made it.
  const built = useRef<unknown[]>(undefined);
  useEffect(() => {
    const before = built.current;
    built.current = context;
    if (!before || JSON.stringify(before) === key) return;
    const names = ["source", "original", "start", "version", "duration"];
    const changed = Object.fromEntries(names.flatMap((name, i) =>
      JSON.stringify(before[i]) === JSON.stringify(context[i]) ? [] : [[name, `${String(before[i])}->${String(context[i])}`]]));
    playbackLog("timeline rebuilt", changed);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return <HeldStillsContext.Provider value={carry}>
    <Scrubber key={key} {...props} subject={subjectKey} kept={kept} />
  </HeldStillsContext.Provider>;
}

function Scrubber({ duration, start = 0, playhead, waveform, activeShortcuts, subject, kept, foot,
  pictureAspect = 16 / 9, frameAt, previewStrip, hoverVideo, onSeek, onSelectTime, onScrubStart, highlight, marks, typedTimes, gaps, skippedRanges, onGap, onBand, fit, range, onRange, fps = 30 }:
  TimelineScrubberProps & { subject: string; kept: RefObject<KeptView | undefined> }) {
  const litMark = useStore(useContext(EditHoverContext));
  // The message box's icon is open: the passage the message is about lights up.
  const aimLit = useUiStore(s => s.aimLit);
  const total = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const end = start + total;
  const slider = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = slider.current!;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // The zoom lives in the row under the timeline, so the ruler runs the full width.
  const zoomSpace = 0;
  const track = useRef<HTMLDivElement>(null);
  const [lens, setLens] = useState<ScrubLens>();
  const drag = useRef<{
    id: number; start: number; span: number; lifetime: AbortController; finish?: () => void;
    time?: number; x: number; x0: number; y0: number; paint?: number;
    fine?: { x: number; frame: number };
    /** A dotted cut pressed on Before: a click opens it, a drag promotes to a normal scrub. */
    gap?: TimelineGap;
  } | null>(null);
  const lastFrame = lastFrameBefore(end, fps);
  const firstFrame = Math.min(lastFrame, Math.max(0, Math.ceil(start * fps - 1e-6)));
  useLayoutEffect(() => () => {
    // A new working cut builds the timeline again. A drag held just then ends with the timeline it was on: the video
    // it paused carries on as it was, instead of staying paused under a pointer that no longer moves anything.
    const gesture = drag.current;
    if (!gesture) return;
    drag.current = null;
    if (gesture.paint !== undefined) cancelAnimationFrame(gesture.paint);
    gesture.lifetime.abort();
    gesture.finish?.();
  }, []);
  // Zoom to a highlighted change when it appears, and back out when it goes. The zoom stays free in between.
  const highlightView = highlight && highlight.view.end > highlight.view.start ? highlight.view : undefined;
  const highlightKey = highlightView ? `${highlightView.start}/${highlightView.end}` : "";
  // The timeline this one takes the place of, when all that changed is the working cut under it.
  const [carried] = useState(() => kept.current?.subject === subject && kept.current.highlight === highlightKey ? kept.current : undefined);
  const { view: { from, span }, samples, target, blend, minSpan, zoomBy, fitRange, stopZoom } = useTimelineZoom(track, start, total, playhead, drag, carried?.view);
  const shownFrom = target?.from ?? from, shownSpan = target?.span ?? span;
  // A timeline that doesn't know the video's length yet has shown nothing to keep, and couldn't zoom to its change.
  useLayoutEffect(() => {
    if (total > 0) kept.current = { subject, highlight: highlightKey, view: shownSpan < total ? { from: shownFrom, span: shownSpan } : undefined };
  }, [kept, subject, highlightKey, shownFrom, shownSpan, total]);
  // A carried view was already zoomed to its change, or left it since: it isn't zoomed to it a second time.
  const fittedHighlight = useRef(carried ? highlightKey : undefined);
  useLayoutEffect(() => {
    const previous = fittedHighlight.current;
    fittedHighlight.current = highlightKey;
    if (previous === highlightKey || (previous === undefined && !highlightKey)) return;
    if (highlightView) fitRange(highlightView.start, highlightView.end, previous !== undefined);
    else fitRange();
  }, [highlightKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // The caller asked for the whole timeline. A timeline built since hasn't been asked.
  const fitAsked = useRef(fit);
  useLayoutEffect(() => {
    if (fitAsked.current === fit) return;
    fitAsked.current = fit;
    fitRange();
  }, [fit]); // eslint-disable-line react-hooks/exhaustive-deps
  // Reveal a newly mentioned time even when the ruler is zoomed in. Typing more words, scrubbing, and zooming
  // by hand keep the editor's view. Revealing the marker never seeks the player.
  const previousTimes = useRef<number[] | undefined>(undefined);
  useLayoutEffect(() => {
    const previous = previousTimes.current;
    previousTimes.current = typedTimes;
    const outside = typedTimes?.find(time => !previous?.includes(time) && (time < shownFrom || time > shownFrom + shownSpan));
    if (outside !== undefined) fitRange(outside - shownSpan / 2, outside + shownSpan / 2);
  }, [typedTimes, shownFrom, shownSpan, fitRange]);
  const mediaWindows = target && (target.from !== samples.from || target.span !== samples.span)
    ? [samples, target] : [samples];
  const to = from + span;
  const percent = (t: number) => span ? (t - from) / span * 100 : 0;
  /** The time a press on the slider points to, kept inside `within`. */
  const pressedTimeIn = (clientX: number, within: TimeRange) => {
    const rect = slider.current!.getBoundingClientRect();
    const at = rect.width > 0 ? from + span * (clientX - rect.left) / rect.width : within.start;
    return Math.max(within.start, Math.min(within.end, at));
  };
  const bandText = highlight?.band && highlight.bandLabel
    ? bandLabel(highlight.bandLabel, (Math.min(100, percent(highlight.band.end)) - Math.max(0, percent(highlight.band.start))) * width / 100) : undefined;
  // A zoom on its way works out its runs for where it is going, so its pills don't change on the way there.
  const markLayout = useMemo(() => marks ? layoutMarks(marks, from, span, width, shownSpan) : [], [marks, from, span, width, shownSpan]);
  const [hotMark, setHotMark] = useState<string>();
  // An edit's arrival plays once. Markers are drawn again as the cut's timeline settles, a pill takes in a newer edit
  // or the view moves, and each would start the moment over, so a marker drawn again picks it up where it is, and one
  // drawn after it ended is simply there. The offset is fixed the first time a marker is drawn for a landing, since
  // changing it on a running animation would skip it ahead.
  const landingOffsets = useRef(new Map<string, { offset: number; landedAt: number }>());
  // A pass can mark hundreds of cuts. Rebuild their nodes only when the markers change.
  const markNodes = useMemo(() => {
    const now = Date.now();
    const offsets = landingOffsets.current;
    for (const [id, { landedAt }] of offsets) if (now - landedAt > 10 * LANDING_PLAYS) offsets.delete(id);
    const elapsed = (id: string, landedAt: number) => {
      if (!offsets.has(id)) offsets.set(id, { offset: Math.max(0, now - landedAt), landedAt });
      return offsets.get(id)!.offset;
    };
    const fresh = (dot: TimelineDot) => !!dot.landed && now - (dot.landedAt ?? now) < LANDING_PLAYS;
    const closing = (id: string, left: number, delay: number) =>
      <i key={id} aria-hidden="true" className="simple-timeline-closing" style={{ left: `${left}%`, animationDelay: `${-delay}ms` }} />;
    return <>{markLayout.map(mark => {
      const { key, times, dots, at, label, width: size } = mark;
      const on = dots.some(dot => dot.current);
      const hot = key === hotMark || (litMark !== undefined && times.includes(litMark));
      // Only a marker that is new arrives: one made of edits that all just landed. A pill that was already there takes
      // a newer edit in quietly, its run of numbers widening, and only that cut's red closes up, where it is.
      const arrived = dots.filter(fresh);
      const isNew = arrived.length > 0 && arrived.length === dots.length;
      const landed = !isNew ? undefined : arrived.some(dot => dot.landed === "cut") ? "cut" : "edit";
      const landedAt = Math.max(...arrived.map(dot => dot.landedAt ?? now));
      const delay = isNew ? elapsed(`${key}|${landedAt}`, landedAt) : 0;
      const node = <i key={key} aria-hidden="true" data-state={dotState(dots)} data-landed={landed} data-leaving={dots.length === 1 && dots[0]!.leaving ? "" : undefined}
        className={`simple-timeline-mark ${label ? "is-numbered" : "is-dot"}${isPill(mark) ? " is-pill" : ""}${on ? " is-on" : ""}${hot ? " is-hot" : ""}`}
        style={{ left: `${at}%`, ...label && { width: size, marginLeft: -size / 2 },
          ...landed && delay > 0 && { animationDelay: `${(landed === "cut" ? 260 : 0) - delay}ms` } }}>
        {label && <span className="simple-timeline-number">{label}</span>}
      </i>;
      // A cut just applied: a sliver of its red closes up where the footage came out, then its marker arrives.
      if (landed === "cut") return [closing(`${key}-closing`, at, delay), node];
      const cuts = arrived.filter(dot => dot.landed === "cut" && dot.time >= from && dot.time <= from + span);
      return cuts.length ? [...cuts.map(dot => {
        const id = `${key}-closing-${dot.edit ?? dot.time}`;
        return closing(id, percent(dot.time), elapsed(`${id}|${dot.landedAt}`, dot.landedAt ?? now));
      }), node] : node;
    })}</>;
  }, [markLayout, hotMark, litMark]); // eslint-disable-line react-hooks/exhaustive-deps
  // Hovering a marker shows the frame and its time, as anywhere on the timeline. One holding what waits on the editor
  // says which, and the frame is that one's.
  const hotDots = hotMark === undefined ? undefined : markLayout.find(mark => mark.key === hotMark)?.dots;
  const waiting = hotDots?.find(dot => dot.state === "check" && dot.need);
  const markNote = waiting && <span className="simple-timeline-need">{waiting.need} needs you</span>;
  // Skipped footage can be heard: a press hands it to the caller. On Before, clicking a dotted cut opens its edit.
  const [hotGap, setHotGap] = useState<string>();
  const pressedGap = useRef<TimelineGap | undefined>(undefined);
  const interactiveGaps = useMemo(() => gaps?.filter(g => (g.skipped && !!onGap) || (!g.skipped && !!(g.open || onGap))) ?? [], [gaps, onGap]);
  const gapNodes = useMemo(() => <>{gaps?.map(gap => {
    const left = Math.max(0, percent(gap.start)), right = Math.min(100, percent(gap.end));
    if (right <= 0 || left >= 100) return null;
    const skipped = gap.skipped && !!onGap;
    const clickable = !skipped && !!(gap.open || onGap);
    const key = `${gap.start}/${gap.end}`;
    // Pointer only, like the band: the keyboard reaches Before with \.
    const label = gapLabel(gap, (right - left) * width / 100);
    return <span key={key} aria-hidden="true"
      className={`simple-timeline-gap${gap.call ? " is-call" : ""}${skipped ? " is-skipped" : ""}${clickable ? " is-clickable" : ""}${hotGap === key ? " is-hot" : ""}`}
      style={{ left: `${left}%`, width: `${right - left}%` }}
      onPointerDown={skipped ? e => {
        if (e.button !== 0 || !e.isPrimary || drag.current) return;
        // This side would land past the gap, so a click goes to the caller instead of starting a scrub.
        e.stopPropagation();
        onGap!(gap, pressedTimeIn(e.clientX, gap));
      } : clickable ? e => {
        if (e.button !== 0 || !e.isPrimary || drag.current) return;
        // Record the gap element that received the press, then let the slider decide between a click (open) and a drag (scrub).
        pressedGap.current = gap;
      } : undefined}>
      {label && <span className="simple-timeline-gap-label">{label}</span>}
    </span>;
  })}</>, [gaps, from, span, width, onGap, hotGap]); // eslint-disable-line react-hooks/exhaustive-deps
  // Hovering reaches a marker from further away than a press does, so a press beside one still scrubs.
  const [aimed, setAimed] = useState(false);
  // A pill opens into its edits: a press zooms to its run, where each has its own number, and opens nothing. Zoomed in
  // as far as the timeline goes, it opens its first. A marker of one edit opens it.
  const openMark = (mark: MarkLayout) => {
    const first = mark.dots.find(dot => dot.open)?.open;
    if (!isPill(mark) || span <= minSpan * 1.05) return first;
    const t0 = Math.min(...mark.times), t1 = Math.max(...mark.times);
    const pad = Math.max(.5, (t1 - t0) * .15);
    return () => fitRange(Math.max(start, t0 - pad), Math.min(end, t1 + pad));
  };
  const markUnder = (e: PointerEvent<HTMLElement>): { mark?: MarkLayout; open?: () => void } => {
    const box = e.currentTarget.getBoundingClientRect();
    if (!box.width) return {};
    const at = (e.clientX - box.left) / box.width * 100;
    const press = nearestMark(markLayout, at, box.width);
    const on = !!press && Math.abs(press.at - at) * box.width / 100 <= press.width / 2 + MARK_GAP;
    return on ? { mark: press, open: openMark(press) } : { mark: press };
  };
  const hoverMark = (e: PointerEvent<HTMLElement>) => {
    if (drag.current || e.pointerType === "touch") return;
    const { mark, open } = markUnder(e);
    setHotMark(mark?.key);
    setAimed(!!open);
  };
  // A press on a marker opens its edit, or zooms to a pill's run, instead of starting a scrub.
  const pressMark = (e: PointerEvent<HTMLElement>) => {
    setHotMark(undefined);
    const { open } = markUnder(e);
    if (!open || e.button !== 0 || !e.isPrimary || drag.current) return;
    e.stopPropagation();
    setAimed(false);
    open();
  };
  const zoomPercent = span ? Math.round(total / span * 100) : 100;
  const handleZoomKey = (e: KeyboardEvent) => {
    if (!total || ignorePageShortcut(e, track.current)) return;
    if (e.key === "+" || e.key === "=") zoomBy(2);
    else if (e.key === "-" || e.key === "_") zoomBy(.5);
    else if (e.key === "0") fitRange();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  useHotkeys(e => { if (activeShortcuts) handleZoomKey(e); });
  const seek = () => {
    const gesture = drag.current;
    if (!gesture) return;
    gesture.paint = undefined;
    const rect = slider.current!.getBoundingClientRect();
    if (rect.width <= 0) return;
    let time = gesture.start + gesture.span * Math.max(0, Math.min(1, (gesture.x - rect.left) / rect.width));
    if (gesture.fine) {
      const delta = Math.round((gesture.x - gesture.fine.x) / LOUPE_PX_PER_FRAME);
      const frame = Math.max(firstFrame, Math.min(lastFrame, gesture.fine.frame + delta));
      time = frame / fps;
      const at = Math.max(0, Math.min(100, (time - gesture.start) / gesture.span * 100));
      setLens(previous => previous?.frame === frame && previous.at === at ? previous : { frame, at });
    }
    if (time === gesture.time) return;
    gesture.time = time;
    onSeek(time);
  };
  const finish = (e: PointerEvent<HTMLDivElement>) => {
    const gesture = drag.current;
    if (gesture?.id !== e.pointerId) return;
    if (gesture.gap) {
      const gap = gesture.gap;
      drag.current = null;
      gesture.lifetime.abort();
      if (e.type === "pointerup") {
        setHotGap(undefined);
        if (gap.open) gap.open();
        else onGap?.(gap, pressedTimeIn(e.clientX, gap));
      }
      return;
    }
    if (gesture.paint !== undefined) cancelAnimationFrame(gesture.paint);
    if (e.type === "pointerup") gesture.x = e.clientX;
    seek();
    if (e.type === "pointerup" && gesture.time !== undefined) onSelectTime?.(gesture.time);
    // A click away from the marked range moves the playhead and keeps the range, so the editor can play into it and adjust it.
    drag.current = null;
    if (gesture.fine) setLens(undefined);
    gesture.lifetime.abort();
    gesture.finish?.();
  };
  const select = useRef({ onSeek, onSelectTime });
  useLayoutEffect(() => { select.current = { onSeek, onSelectTime }; }, [onSeek, onSelectTime]);
  const selectPosition = useCallback((target: number) => {
    const time = Math.max(start, Math.min(end, target));
    select.current.onSeek(time);
    select.current.onSelectTime?.(time);
  }, [start, end]);
  // Where a marked range's end lands when it comes near: the edges of the open edit, of footage cuts took out, and each marked edit.
  const edges = useMemo(() => rangeEdges(highlight?.band, gaps, marks), [highlight?.band, gaps, marks]);
  // The close-up's strip loads a run of frames per request from the same cache as the filmstrip.
  const sheet = useMemo(() => previewStrip ? { fps: previewStrip.fps, url: (frames: number[]) => stripUrl(previewStrip, frames) } : undefined, [previewStrip]);
  const marking = useRangeSelect({ slider, drag, from, span, start, end, fps, edges, frameAt, sheet, pictureAspect, range, onRange: onRange ?? noRange, onSeek,
    onScrubStart, onPress: selectPosition, beforeGesture: stopZoom });
  // The slider runs from the whole video, at its left, to the closest zoom, on a log scale so each step looks the same.
  const zoomRange = total > 0 && minSpan < total ? Math.log(total / minSpan) : 0;
  const zoomValue = zoomRange && shownSpan > 0 ? Math.round(Math.max(0, Math.min(1, Math.log(total / shownSpan) / zoomRange)) * ZOOM_STEPS) : 0;
  const zoomFoot = <div className="timeline-foot">
    <TimelineClock playhead={playhead} start={start} end={end} total={total} />
    {foot}
    <div className="timeline-zoom-row" role="group" aria-label="Timeline zoom" title="Scroll or pinch over the timeline to zoom">
      <button type="button" className="timeline-zoom-step" aria-label="Zoom out" aria-keyshortcuts="-" title="Zoom out (−)"
        disabled={shownSpan >= total} onClick={() => zoomBy(.5)}>−</button>
      <input type="range" className="timeline-zoom-slider" aria-label="Zoom" aria-keyshortcuts="0" title="Zoom (0 to fit)"
        min={0} max={ZOOM_STEPS} step={1} value={zoomValue} disabled={!zoomRange} aria-valuetext={`${zoomPercent}%`}
        style={{ "--zoom-at": `${zoomValue / ZOOM_STEPS * 100}%` } as CSSProperties}
        onChange={e => {
          const next = total / Math.exp(Number(e.currentTarget.value) / ZOOM_STEPS * zoomRange);
          if (next > 0 && span > 0) zoomBy(span / next, undefined, true);
        }} />
      <button type="button" className="timeline-zoom-step" aria-label="Zoom in" aria-keyshortcuts="plus =" title="Zoom in (+)"
        disabled={shownSpan <= minSpan} onClick={() => zoomBy(2)}>+</button>
      <output className="timeline-zoom-level" aria-label={`${zoomPercent}% zoom`}>{zoomPercent}%</output>
    </div>
  </div>;

  return <div className="timeline-panel" onKeyDown={e => handleZoomKey(e.nativeEvent)}>
    <div ref={track} className={marking.marking ? "timeline-track is-marking" : "timeline-track"}><ScrubPreview suspended={!!lens} start={from} duration={span} pictureAspect={pictureAspect} frameAt={frameAt} hoverVideo={hoverVideo} note={markNote || undefined} pin={waiting?.time}>
    <TimelineSlider ref={slider} className={hotGap ? "timeline-slider is-gap-aimed" : "timeline-slider"} playhead={playhead} start={start} end={end} from={from} span={span}
      width={width} zoomSpace={zoomSpace} drag={drag} skippedRanges={skippedRanges} loupe={!!lens} fps={fps} selectPosition={selectPosition} tabIndex={total ? 0 : -1} aria-disabled={!total}
      aria-label="Position in the video" aria-description="Drag up from the picture or waveform to scrub one frame at a time."
      onContextMenu={onRange ? marking.onContextMenu : undefined}
      onPointerDown={e => {
        const directGap = pressedGap.current;
        pressedGap.current = undefined;
        if (!total || e.button !== 0 || !e.isPrimary || drag.current) return;
        const box = e.currentTarget.getBoundingClientRect();
        const ruler = e.currentTarget.querySelector<HTMLElement>(".timeline-lanes")?.offsetTop ?? 0;
        const onRuler = !!(e.target as Element).closest(".timeline-range-zone") || (ruler > 0 && box.height > 0 && e.clientY - box.top < ruler);
        if (onRange && onRuler && marking.begin(e)) return;
        const hitGap = !onRuler && interactiveGaps.length
          ? (box.width > 0 ? gapAt(interactiveGaps, from, span, box.width, e.clientX - box.left) : undefined) ?? directGap : undefined;
        if (hitGap?.skipped && onGap) {
          onGap(hitGap, pressedTimeIn(e.clientX, hitGap));
          return;
        }
        if (hitGap && (hitGap.open || onGap)) {
          e.currentTarget.setPointerCapture(e.pointerId);
          const lifetime = new AbortController();
          drag.current = { id: e.pointerId, start: from, span, x: e.clientX, x0: e.clientX, y0: e.clientY, lifetime, gap: hitGap };
          return;
        }
        stopZoom();
        e.currentTarget.setPointerCapture(e.pointerId);
        const lifetime = new AbortController();
        drag.current = { id: e.pointerId, start: from, span, x: e.clientX, x0: e.clientX, y0: e.clientY, lifetime, finish: onScrubStart?.(lifetime.signal) };
        seek();
      }}
      onPointerMove={e => {
        const gesture = drag.current;
        if (!gesture) {
          if (e.pointerType !== "touch" && interactiveGaps.length) {
            const box = e.currentTarget.getBoundingClientRect();
            const ruler = e.currentTarget.querySelector<HTMLElement>(".timeline-lanes")?.offsetTop ?? 0;
            const onRuler = !!(e.target as Element).closest(".timeline-range-zone") || (ruler > 0 && box.height > 0 && e.clientY - box.top < ruler);
            const onLiveBand = !!(e.target as Element).closest(".simple-timeline-band.is-live");
            const hit = !onRuler && !onLiveBand && !aimed && box.width > 0 ? gapAt(interactiveGaps, from, span, box.width, e.clientX - box.left) : undefined;
            const key = hit ? `${hit.start}/${hit.end}` : undefined;
            setHotGap(previous => previous === key ? previous : key);
          } else if (hotGap !== undefined) setHotGap(undefined);
          return;
        }
        if (gesture.id !== e.pointerId) return;
        if (gesture.gap) {
          if (Math.abs(e.clientX - gesture.x0) <= 3 && Math.abs(e.clientY - gesture.y0) <= 3) return;
          gesture.gap = undefined;
          setHotGap(undefined);
          stopZoom();
          gesture.finish = onScrubStart?.(gesture.lifetime.signal);
          gesture.x = e.clientX;
          seek();
        }
        if (!gesture.fine && gesture.y0 - e.clientY >= 24 && gesture.time !== undefined && fps > 0 && Number.isFinite(fps)) {
          // Enter at the last coarse position. Movement from here is relative, independent of the timeline zoom.
          gesture.fine = { x: e.clientX, frame: Math.round(gesture.time * fps) };
        }
        gesture.x = e.clientX;
        gesture.paint ??= requestAnimationFrame(seek);
      }}
      onPointerLeave={() => setHotGap(undefined)}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}>
      <TimelineRuler start={from} duration={span} width={width} endInset={zoomSpace} />
      {onRange && total > 0 && <div aria-hidden="true" className="timeline-range-zone"
        title={range ? "Drag to mark a new range · double-click to clear" : "Drag to mark a range for your message"}
        onDoubleClick={e => {
          if (!range) return;
          e.stopPropagation();
          onRange(undefined);
        }} />}
      <div className="timeline-lanes">
        {mediaWindows.map((sample, i) => {
          const projection = sample.span !== span || sample.from !== from
            ? `translateX(${percent(sample.from)}%) scaleX(${sample.span / span})` : undefined;
          // Crossfade the two filmstrips at their native aspect ratio. Project peaks in time with the ruler.
          return <div key={sample.from + "/" + sample.span} className="timeline-media"
            style={target ? { opacity: i === 1 ? blend : 1 } : { transform: projection }}>
            <MediaLanes start={sample.from} duration={sample.span} pictureAspect={pictureAspect} frameAt={frameAt} preview={previewStrip} waveform={waveform}
              visibleStart={target ? from : sample.from} visibleSpan={target ? span : sample.span} />
          </div>;
        })}
      </div>
      {highlight?.band && (highlight.band.end > highlight.band.start
        // Panned or zoomed out of view, the band draws nothing: clamped to the edge it would leave a sliver that reads as a mark there.
        ? highlight.band.end > from && highlight.band.start < to &&
          // Pointer only: the keyboard reaches Before with \.
          <span aria-hidden="true" className={`simple-timeline-band${highlight.tone ? ` is-${highlight.tone}` : ""}${highlight.undecided ? " is-proposed" : ""}${onBand && !highlight.leaving ? " is-live" : ""}${aimLit ? " is-lit" : ""}${highlight.leaving ? " is-leaving" : ""}`} style={{ left: `${Math.min(100, Math.max(0, percent(highlight.band.start)))}%`,
            width: `${Math.max(0, Math.min(100, percent(highlight.band.end)) - Math.max(0, percent(highlight.band.start)))}%` }}
            onPointerDown={onBand ? e => {
              if (e.button !== 0 || !e.isPrimary || drag.current) return;
              // The playing side steps over this footage, so a click goes to the caller instead of starting a scrub.
              e.stopPropagation();
              onBand(pressedTimeIn(e.clientX, highlight.band!));
            } : undefined}>
            {bandText && <span>{bandText}</span>}</span>
        : highlight.band.start >= from && highlight.band.start <= to &&
          <span aria-hidden="true" className={`simple-timeline-cut${highlight.tone ? ` is-${highlight.tone}` : ""}${highlight.undecided ? " is-proposed" : ""}${highlight.leaving ? " is-leaving" : ""}`} style={{ left: `${percent(highlight.band.start)}%` }}>
            {highlight.bandLabel && <span>{highlight.bandLabel}</span>}</span>)}
      {gapNodes}
      {markLayout.length > 0 && <div aria-hidden="true" className={aimed ? "simple-timeline-hover is-aimed" : "simple-timeline-hover"}
        onPointerMove={hoverMark} onPointerLeave={() => { setHotMark(undefined); setAimed(false); }} onPointerDown={pressMark} />}
      {markNodes}
      {typedTimes?.filter(time => time >= from && time <= to).map(time =>
        <span key={time} className="timeline-message-time" aria-hidden="true" data-time={time} style={{ left: `${percent(time)}%` }} />)}
      {marking.layer}
      {lens && <FloatingScrubLoupe lens={lens} first={firstFrame} last={lastFrame} fps={fps}
        frameAt={frameAt} sheet={sheet} pictureAspect={pictureAspect} />}
    </TimelineSlider>
  </ScrubPreview>
  </div>
  {zoomFoot}
  </div>;
}
