import { createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode, type RefObject } from "react";
import { createStore, useStore } from "zustand";
import { filmstripBatches, type TimeRange } from "@scarlet/timeline";
import { api } from "../../lib/client";
import { usePlayerStore } from "../../stores/player";
import { arrowSeekTime, ignorePageShortcut, useHotkeys } from "../../lib/hotkeys";
import { playbackClock } from "../../lib/format";
import { playbackLog } from "../../lib/playbackLog";
import { TimelineWaveform, type WaveformMedia } from "./TimelineWaveform";
import type { EditCue } from "./EditReferences";
import { ScrubPreview, type HoverVideo } from "../player/ScrubPreview";
import { QueuedImg, useStillTurn } from "./QueuedImg";
import { TimelineMarkers, type TimelineMarker } from "./TimelineMarkers";
import { TimelineRuler } from "./TimelineRuler";
import { Icon } from "../ui/primitives";
import { useTimelineZoom } from "./useTimelineZoom";
import { useArrival, useLaneHold, wavePhase } from "./laneLoading";
import type { ProgressFocus } from "../player/SimpleProgress";

/** Hovering a chat row lights its marker without re-rendering the workspace. */
export const EditHoverContext = createContext(createStore<number | undefined>(() => undefined));

type FrameAt = (time: number, exact?: boolean) => string | undefined;

interface PreviewStrip { id: string; version: string; fps: number }

function stripUrl(preview: PreviewStrip, frames: number[]) {
  const url = new URL(api.fileUrl(`/renders/${encodeURIComponent(preview.id)}/filmstrip`));
  url.searchParams.set("version", preview.version);
  url.searchParams.set("frames", frames.join(","));
  url.searchParams.set("layout", "source-aspect");
  return url.toString();
}

/** One request supplies every cell of this sheet. Crop each frame inside its own time slot. */
function FilmstripSheet({ src, frames, pictureAspect, style, loaded, onLoad, onError }: {
  src: string; frames: number; pictureAspect: number; style: CSSProperties; loaded: boolean;
  onLoad(): void; onError(): void;
}) {
  const [shown, release] = useStillTurn(src);
  return Array.from({ length: frames }, (_, index) => <div key={index} className="timeline-sheet-cell" style={style}>
    <span style={{ aspectRatio: pictureAspect, width: `max(100%, ${100 * pictureAspect}cqh)` }}>
      <img src={shown} alt="" draggable={false} decoding="async" data-loaded={loaded || undefined}
        style={{ width: `${frames * 100}%`, left: `${-index * 100}%` }}
        onLoad={index === 0 ? () => { release(); onLoad(); } : undefined}
        onError={index === 0 ? () => { release(); onError(); } : undefined} />
    </span>
  </div>);
}

/** How long the picture lane waits for its last stills before showing the ones it has. */
const PICTURE_PATIENCE_MS = 3000;
/** How long the stills a rebuilt lane held stay over the new ones: the new ones' left-to-right fade (workspace.css). */
const HELD_FADE_MS = 600;

interface HeldStills { subject: string; built: string; view: string; cells: Element[] }
/**
 * A new working cut builds the timeline again and every still on it is a new picture from the engine. The lane built in
 * its place keeps showing the old stills, of the same footage, until its own have landed, instead of going blank.
 */
interface Carry { subject: string; built: string; start: number; duration: number; held: RefObject<HeldStills | undefined> }
const HeldStillsContext = createContext<Carry | null>(null);

/** Stills shown by the timeline this one was built in place of: not a zoom's other window, which shows another stretch. */
function heldFor(carry: Carry | null, view: string) {
  const held = carry?.held.current;
  return carry && held && held.subject === carry.subject && held.built !== carry.built && held.view === view ? held : undefined;
}

const Filmstrip = memo(function Filmstrip({ start, duration, pictureAspect, frameAt, preview, hold, onLoading }: {
  start: number; duration: number; pictureAspect: number; frameAt: FrameAt; preview?: PreviewStrip | null;
  /** Keep the stills back a moment while the sound lane is about to land, so both arrive together. */
  hold?: boolean; onLoading?(loading: boolean): void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);
  const [failed, setFailed] = useState<string>();
  // Stills that have loaded or given up. The lane shows them together once every one has.
  const [settled, setSettled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [impatient, setImpatient] = useState<string>();
  useLayoutEffect(() => {
    const el = strip.current!;
    const measure = () => {
      const width = el.clientWidth;
      const frameWidth = el.clientHeight * pictureAspect;
      // Even very narrow formats get a legible thumbnail.
      setCount(width && frameWidth ? Math.max(1, Math.round(width / Math.max(24, frameWidth))) : 0);
    };
    measure();
    // Wait for panel resizing to settle before requesting a new set of stills.
    let timer: number;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = window.setTimeout(measure, 120);
    });
    observer.observe(el);
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [pictureAspect]);
  const cached = preview && preview.id !== failed ? preview : undefined;
  const drawn = duration > 0 && preview !== null;
  // The lane re-renders while its stills load; sample the range only when it changes.
  const stills = useMemo(() => {
    if (!drawn) return [];
    const times = Array.from({ length: count }, (_, i) => start + duration * (i + 0.5) / count);
    if (!cached) return times.map((time, i) => ({ key: String(i), src: frameAt(time, true), span: 1 }));
    const sheets = filmstripBatches(times.map(t => Math.floor(t * cached.fps + 1e-7)), cached.fps);
    return sheets.map((group, i) => ({ key: `${cached.id}-${i}-${group}`, src: stripUrl(cached, group), span: group.length }));
  }, [drawn, cached, count, start, duration, frameAt]);
  const wanted = stills.flatMap(still => still.src ? [still.src] : []);
  const batch = wanted.join("\n");
  const loading = wanted.some(src => !settled.has(src)) && impatient !== batch;
  useLayoutEffect(() => onLoading?.(loading), [onLoading, loading]);
  useEffect(() => {
    if (!loading) return;
    const timer = window.setTimeout(() => setImpatient(batch), PICTURE_PATIENCE_MS);
    return () => clearTimeout(timer);
  }, [loading, batch]);
  const settle = (src: string, loaded: boolean) => setSettled(done => {
    if (done.get(src) === loaded) return done;
    const next = new Map([...done].filter(([url]) => wanted.includes(url)));
    return next.set(src, loaded);
  });
  const waiting = loading || !!hold;
  const arriving = useArrival(waiting);
  const carry = useContext(HeldStillsContext);
  const view = carry && start === carry.start && duration === carry.duration ? "full" : `${start}/${duration}`;
  const [held, setHeld] = useState(() => heldFor(carry, view));
  const overlay = useRef<HTMLDivElement>(null);
  const measured = drawn && count > 0;
  const complete = measured && wanted.every(src => settled.has(src));
  const hasPicture = wanted.some(src => settled.get(src));
  // A pending cache lookup or an expired patience timer can end the loading wave before any picture is available.
  // An empty or failed batch is terminal too: once known, it must not keep showing footage from an older cut.
  const reveal = !waiting && (hasPicture || complete);
  useLayoutEffect(() => {
    const el = overlay.current;
    if (el && held && held.cells[0]?.parentElement !== el) el.replaceChildren(...held.cells);
  }, [held]);
  useLayoutEffect(() => {
    if (!carry) return;
    if (complete && hasPicture && !waiting) {
      // The old lane unmounts before the new layout effects run. Move its already-decoded cells across intact:
      // this preserves sheet cropping and avoids an extra round of requests for the previous cut.
      const cells = Array.from(strip.current!.querySelectorAll(":scope > div:not(.filmstrip-wait, .filmstrip-held)"));
      carry.held.current = { subject: carry.subject, built: carry.built, view, cells };
    } else if (complete && !hasPicture || (carry.held.current?.built === carry.built && carry.held.current.view === view)) {
      carry.held.current = undefined;
    }
  }, [carry, complete, hasPicture, waiting, view, stills]);
  // Once the lane's own stills are shown, the held ones fade out over them, then go.
  useEffect(() => {
    if (!held || !reveal) return;
    const timer = window.setTimeout(() => setHeld(undefined), HELD_FADE_MS);
    return () => clearTimeout(timer);
  }, [held, reveal]);
  // The glow starts at the shared wave's current point, so it moves with the sound lane's ripple.
  const phase = useMemo(() => waiting ? wavePhase() : undefined, [waiting]);
  return <div ref={strip} className={`timeline-filmstrip${waiting ? " is-loading" : ""}${arriving ? " is-arriving" : ""}`} aria-hidden="true"
    style={{ "--frames": Math.max(1, count), "--wave-phase": phase } as CSSProperties}>
    {drawn && wanted.length > 0 && !held && <div className="filmstrip-wait"><i /></div>}
    {held && <div ref={overlay} className="filmstrip-held" data-leaving={reveal || undefined} />}
    {stills.map((still, i) => {
      // After a wait the stills fade in from left to right.
      const order = { "--at": (stills.length > 1 ? i / (stills.length - 1) : 0).toFixed(3) } as CSSProperties;
      const src = still.src;
      if (cached && src) return <FilmstripSheet key={still.key} src={src} frames={still.span} pictureAspect={pictureAspect}
        style={order} loaded={settled.get(src) === true} onLoad={() => settle(src, true)} onError={() => setFailed(cached.id)} />;
      return <div key={still.key}>{src && <QueuedImg key={src} src={src} alt="" draggable={false} decoding="async"
        data-loaded={settled.get(src) || undefined} style={order} onLoad={() => settle(src, true)}
        onError={e => { e.currentTarget.hidden = true; settle(src, false); }} />}</div>;
    })}
  </div>;
});

/** The picture and its sound over one window of time. Each loads on its own; see useLaneHold. */
function MediaLanes({ start, duration, pictureAspect, frameAt, preview, waveform, visibleStart, visibleSpan }: {
  start: number; duration: number; pictureAspect: number; frameAt: FrameAt; preview?: PreviewStrip | null; waveform?: WaveformMedia; visibleStart: number; visibleSpan: number;
}) {
  const { report, held } = useLaneHold();
  const picture = useCallback((loading: boolean) => report("picture", loading), [report]);
  const sound = useCallback((loading: boolean) => report("sound", loading), [report]);
  return <>
    <Filmstrip start={start} duration={duration} pictureAspect={pictureAspect} frameAt={frameAt} preview={preview} hold={held === "picture"} onLoading={picture} />
    {waveform && <TimelineWaveform {...waveform} start={start} duration={duration} visibleStart={visibleStart} visibleSpan={visibleSpan}
      hold={held === "sound"} onLoading={sound} />}
  </>;
}

interface TimelineScrubberProps {
  reviewing?: boolean;
  activeShortcuts?: boolean;
  duration: number;
  start?: number;
  playhead: number;
  editMarkers?: TimelineMarker[];
  cue?: EditCue;
  waveform?: WaveformMedia;
  label?: string;
  pictureAspect?: number;
  previewStrip?: PreviewStrip | null;
  hoverVideo?: HoverVideo;
  frameAt: FrameAt;
  onSeek(time: number): void;
  /** Commit an editor-selected position, independently of playback updates. */
  onSelectTime?(time: number): void;
  /** Suspend playback during a pointer drag. The returned callback runs on release. */
  onScrubStart?(gesture: AbortSignal): (() => void) | undefined;
  /** The simple view's highlight: zoom to the change and shade what it touches. */
  highlight?: ProgressFocus;
  /**
   * The simple view's change dots. Hovering one names the edit and sums it up. They are all that view's timeline marks:
   * with them it draws no diamond for a caption clip or an edit.
   */
  marks?: TimelineDot[];
  /** Footage other cuts took out, marked over the version the timeline shows. */
  gaps?: TimelineGap[];
  /** Passages the current playback skips, in this timeline's clock. */
  skippedRanges?: TimeRange[];
  /** A click inside a skipped gap, at the time it points to. It doesn't seek: the caller decides where to play it. */
  onGap?(gap: TimelineGap, time: number): void;
  /** A click inside the highlight's band, at the time it points to. It doesn't seek: the caller decides where to play it. */
  onBand?(time: number): void;
}

/**
 * Footage the timeline shows that the playing side doesn't have: another cut in the same pass took it out.
 * A skipped gap greys out, names its edit on hover, and hands a click to `onGap`. Otherwise it's only outlined.
 */
export interface TimelineGap {
  start: number;
  end: number;
  /** On the gap: "Cut at 2:05". */
  label: string;
  /** On a gap too narrow at this zoom for `label`: "2:05". */
  shortLabel?: string;
  /** The hover note's heading: which cut, and how long. */
  title: string;
  summary?: string;
  skipped: boolean;
}

/** A gap's tag is 10.5 px text with 6 px of padding each side, 3 px in from the gap's edges. */
const gapLabelWidth = (label: string) => label.length * 6 + 18;

/** A short label is narrower per letter than the estimate above allows for, and must not be dropped while it still fits. */
const shortLabelWidth = (label: string) => label.length * 5 + 18;

/**
 * The gap's label if it fits the gap's width in pixels, else its short one, else none: a label cut off mid-word reads as
 * a mistake, and hovering the gap still names its edit. Before the track is measured, the full label.
 */
export function gapLabel(gap: Pick<TimelineGap, "label" | "shortLabel">, px: number) {
  if (!(px > 0) || px >= gapLabelWidth(gap.label) || !gap.shortLabel) return gap.label;
  return px >= shortLabelWidth(gap.shortLabel) ? gap.shortLabel : "";
}

/**
 * The open edit's label on its band, the same way: whole if it fits, else the amount after its "·", else none. A short
 * cut's band is a few dozen pixels wide, and "Rem…" on it says nothing; the card over the timeline says what it is.
 */
export function bandLabel(label: string, px: number) {
  if (!(px > 0) || px >= gapLabelWidth(label)) return label;
  const amount = label.includes(" · ") ? label.slice(label.lastIndexOf(" · ") + 3) : "";
  return amount && px >= shortLabelWidth(amount) ? amount : "";
}

export interface TimelineDot {
  time: number;
  /** "Edit 3 of 5 · 0:42" */
  title: string;
  summary?: string;
  /** Where it runs and for how long, or how much came out. */
  detail?: string;
  /** The request or change the edit came from. */
  context?: string;
  /** An applied edit's number, as in the chat. Numbered dots show it, filled once kept and amber while it asks for a look. */
  n?: number;
  /**
   * Whose numbers the dot's are. Dots of different groups never share a marker: a call's number and an edit's are
   * counted apart, and one pill can't say both. Edits have none.
   */
  group?: string;
  state?: "kept" | "check";
  /** A settled edit, drawn as a faint tick only while its list is open in the chat. */
  quiet?: boolean;
  /** The edit or call that's open. Its marker is lit, and while its band is on the timeline the band stands in for it. */
  current?: boolean;
  /** Opens the edit. A press on its marker does this instead of starting a scrub. */
  open?(): void;
  /** The edit was applied a moment ago: its marker arrives with a moment, a cut's red closing up into it first. */
  landed?: "cut" | "edit";
}

/** A marker shows its edit's number. Edits that share a marker show their run of numbers ("12–13"), or the lowest and a plus when they skip. */
function dotLabel(count: number, numbered: number, first: number, last: number) {
  if (!numbered) return undefined;
  if (count === 1) return String(first);
  return numbered === count && last - first === count - 1 ? `${first}–${last}` : `${first}+`;
}

/** A numbered marker is a 17 px circle, which holds two digits. A longer label is a pill sized to its text (about
 *  6.6 px a character) with room either side. A plain dot is 8 px. */
const markWidth = (label?: string) => !label ? 8 : label.length <= 2 ? 17 : Math.round(label.length * 6.6 + 11);
const MARK_GAP = 3;
/** A move of the playhead this far, in seconds or as a share of what the timeline shows, is a jump it glides through. */
const GLIDE_FROM_SECONDS = 0.75;
const GLIDE_FROM_SHARE = 0.03;
/** How long a glide takes, in ms: the same as the playhead's transition in workspace.css. */
const GLIDE_MS = 260;
/** How far from a marker, in pixels, hovering the strip still picks it. */
export const MARK_SNAP = 24;
/** A marker's hover note lists up to this many edits. A pill that stands for more names its first and counts the rest. */
const MOST_NOTES = 3;

export interface MarkLayout {
  /** Names the marker: its group and its first edit's time. */
  key: string;
  /** The first edit's time. */
  time: number;
  /** Every time the marker stands for. */
  times: number[];
  dots: TimelineDot[];
  at: number;
  label?: string;
  width: number;
  /** A settled edit: a faint tick, not a circle. */
  quiet: boolean;
}

/** Each edit draws as its numbered circle. Circles that would touch at this zoom share one pill with their run of
 *  numbers, so there are never more markers than fit and none hides another. Only circles of one group share: a call's
 *  and an edit's each keep their own. A settled edit stays a faint tick: it joins no pill and takes no room. Before the
 *  track is measured, nothing is shared. */
export function layoutMarks(marks: TimelineDot[], from: number, span: number, width: number) {
  if (span <= 0) return [];
  // Dots of different groups at one time are different markers, so they're gathered apart from the start.
  const byTime = new Map<string, TimelineDot[]>();
  for (const mark of marks) {
    if (!(mark.time >= from && mark.time <= from + span)) continue;
    const key = `${mark.group ?? ""}@${mark.time}`;
    const dots = byTime.get(key);
    if (dots) dots.push(mark); else byTime.set(key, [mark]);
  }
  const position = (time: number) => (time - from) / span * 100;
  const marker = (key: string, time: number, dots: TimelineDot[]) => {
    const numbers = new Set<number>();
    let first = Infinity, last = -Infinity;
    for (const { n } of dots) if (n !== undefined) {
      numbers.add(n); first = Math.min(first, n); last = Math.max(last, n);
    }
    const label = dotLabel(dots.length, numbers.size, first, last);
    const layout: MarkLayout = { key, time, times: [time], dots, at: position(time), label, width: markWidth(label), quiet: dots.every(d => d.quiet) };
    return { layout, numbers, first, last };
  };
  const fits = (a: MarkLayout, b: MarkLayout) => (b.at - a.at) * width / 100 >= a.width / 2 + b.width / 2 + MARK_GAP;
  const ticks: MarkLayout[] = [], circles = new Map<string, ReturnType<typeof marker>[]>();
  for (const [key, dots] of [...byTime].sort((a, b) => a[1][0]!.time - b[1][0]!.time)) {
    const time = dots[0]!.time;
    let next = marker(key, time, dots);
    if (next.layout.quiet) { ticks.push(next.layout); continue; }
    const row = circles.get(dots[0]!.group ?? "") ?? [];
    circles.set(dots[0]!.group ?? "", row);
    // Sharing widens the pill and moves it, so it can reach the marker before it too.
    for (let before = row.at(-1); width > 0 && before && !fits(before.layout, next.layout); before = row.at(-1)) {
      row.pop();
      const group = before.layout;
      for (const t of next.layout.times) group.times.push(t);
      for (const dot of next.layout.dots) group.dots.push(dot);
      for (const n of next.numbers) before.numbers.add(n);
      before.first = Math.min(before.first, next.first);
      before.last = Math.max(before.last, next.last);
      group.at = (position(group.time) + position(time)) / 2;
      group.label = dotLabel(group.dots.length, before.numbers.size, before.first, before.last);
      group.width = markWidth(group.label);
      next = before;
    }
    row.push(next);
  }
  return [...ticks, ...[...circles.values()].flatMap(row => row.map(group => group.layout))].sort((a, b) => a.at - b.at);
}

/** The marker nearest the pointer, if it's within reach. A circle or pill drawn under the pointer comes first: a settled
 *  edit's tick takes no room, so one can sit inside it, nearer the pointer than the circle's own centre. */
export function nearestMark(layout: MarkLayout[], percent: number, width: number) {
  let nearest: MarkLayout | undefined, circle: MarkLayout | undefined;
  let distance = Infinity, circleDistance = Infinity;
  for (const mark of layout) {
    const delta = Math.abs(mark.at - percent);
    if (delta < distance) { nearest = mark; distance = delta; }
    if (!mark.quiet && delta * width / 100 <= mark.width / 2 && delta < circleDistance) { circle = mark; circleDistance = delta; }
  }
  return circle ?? (nearest && distance * width / 100 <= Math.max(MARK_SNAP, nearest.width / 2) ? nearest : undefined);
}

function dotState(dots: TimelineDot[]) {
  if (dots.some(d => d.state === "check")) return "check";
  const numbered = dots.filter(d => d.n !== undefined);
  return numbered.length && numbered.every(d => d.state === "kept") ? "kept" : undefined;
}

function ZoomPopover({ children, onKey }: { children: ReactNode; onKey(event: KeyboardEvent): void }) {
  const id = useId();
  const controls = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: Event) => {
      if (!controls.current?.contains(event.target as Node)) setOpen(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("focusin", dismissOutside);
    document.addEventListener("keydown", dismissOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("focusin", dismissOutside);
      document.removeEventListener("keydown", dismissOnEscape, true);
    };
  }, [open]);
  return <div ref={controls} className="timeline-view-controls" onKeyDown={e => {
    if (open) { onKey(e.nativeEvent); e.stopPropagation(); }
  }}>
    <button ref={trigger} type="button" className="timeline-view-trigger" aria-label="Timeline controls"
      title="Timeline controls · scroll or pinch to zoom" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={e => { e.currentTarget.focus({ preventScroll: true }); setOpen(value => !value); }}>
      <Icon name="zoom" size={15} />
    </button>
    {open && <div id={id} className="timeline-tools" data-escape-owner>{children}</div>}
  </div>;
}

export function PlayerTimeline(props: Omit<TimelineScrubberProps, "playhead">) {
  const playhead = usePlayerStore(s => s.time);
  return <TimelineScrubber {...props} playhead={playhead} />;
}

/**
 * What a timeline showed, for the one built in its place. A new working cut builds the timeline again: of the same
 * footage (`subject`) and with the same change open (`highlight`), it keeps the stretch the editor had zoomed to.
 * `view` is that stretch; none when it showed the whole video, which the next one then does too.
 */
interface KeptView { subject: string; highlight: string; view?: { from: number; span: number } }

export function TimelineScrubber(props: TimelineScrubberProps) {
  const { start, duration, cue, waveform } = props;
  const subject = [waveform?.source?.id, waveform?.original, start, cue?.changeId, cue?.spot, cue?.time, props.reviewing];
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
    const names = ["source", "original", "start", "change", "spot", "cue", "reviewing", "version", "duration"];
    const changed = Object.fromEntries(names.flatMap((name, i) =>
      JSON.stringify(before[i]) === JSON.stringify(context[i]) ? [] : [[name, `${String(before[i])}->${String(context[i])}`]]));
    playbackLog("timeline rebuilt", changed);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return <HeldStillsContext.Provider value={carry}>
    <Scrubber key={key} {...props} subject={subjectKey} kept={kept} />
  </HeldStillsContext.Provider>;
}

function Scrubber({ duration, start = 0, playhead, editMarkers, cue, waveform, activeShortcuts, subject, kept,
  label = "Position in the video", pictureAspect = 16 / 9, frameAt, previewStrip, hoverVideo, onSeek, onSelectTime, onScrubStart, highlight, marks, gaps, skippedRanges, onGap, onBand }:
  TimelineScrubberProps & { subject: string; kept: RefObject<KeptView | undefined> }) {
  const litMark = useStore(useContext(EditHoverContext));
  const total = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const end = start + total;
  const position = Number.isFinite(playhead) ? Math.min(end, Math.max(start, playhead)) : start;
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
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; start: number; span: number; lifetime: AbortController; finish?: () => void; time?: number; x: number; paint?: number } | null>(null);
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
  const { view: { from, span }, samples, target, blend, minSpan, zoomBy, fitRange, stopZoom } = useTimelineZoom(track, start, total, position, cue?.time, drag, undefined, undefined, carried?.view);
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
  const mediaWindows = target && (target.from !== samples.from || target.span !== samples.span)
    ? [samples, target] : [samples];
  const to = from + span;
  const percent = (t: number) => span ? (t - from) / span * 100 : 0;
  // Navigation can glide. At a cut, even a glide already in flight must land with the first frame after the join.
  const motion = useRef({ position, glideUntil: 0 });
  const previous = motion.current.position;
  const now = Date.now();
  const jump = Math.abs(position - previous) > Math.max(GLIDE_FROM_SECONDS, span * GLIDE_FROM_SHARE);
  let glideUntil = jump ? now + GLIDE_MS : motion.current.glideUntil;
  if (glideUntil > now && position !== previous) {
    const low = Math.min(previous, position), high = Math.max(previous, position);
    if (drag.current || skippedRanges?.some(range => low < range.end && range.start < high)) glideUntil = 0;
  }
  useLayoutEffect(() => { motion.current = { position, glideUntil }; }, [position, glideUntil]);
  const gliding = glideUntil > now;
  const bandText = highlight?.band && highlight.bandLabel
    ? bandLabel(highlight.bandLabel, (Math.min(100, percent(highlight.band.end)) - Math.max(0, percent(highlight.band.start))) * width / 100) : undefined;
  // The open edit's band says where it is, so its own marker isn't drawn over it. The others in view still are.
  const banded = !!highlight?.band;
  const markLayout = useMemo(() => marks ? layoutMarks(banded ? marks.filter(mark => !mark.current) : marks, from, span, width) : [], [banded, marks, from, span, width]);
  const [hotMark, setHotMark] = useState<string>();
  // The playhead re-renders the strip every frame. A pass can mark hundreds of cuts, so build them only when they change.
  const markNodes = useMemo(() => <>{markLayout.map(({ key, times, dots, at, label, width: size, quiet }) => {
    const on = dots.some(dot => dot.current);
    const hot = key === hotMark || (litMark !== undefined && times.includes(litMark));
    const landed = quiet ? undefined : dots.some(dot => dot.landed === "cut") ? "cut" : dots.some(dot => dot.landed) ? "edit" : undefined;
    const mark = <i key={key} aria-hidden="true" data-state={dotState(dots)} data-landed={landed}
      className={`simple-timeline-mark ${quiet ? "is-tick is-quiet" : label ? "is-numbered" : "is-dot"}${on ? " is-on" : ""}${hot ? " is-hot" : ""}`}
      style={{ left: `${at}%`, ...!quiet && label && { width: size, marginLeft: -size / 2 } }}>
      {label && (!quiet || on || hot) && <span className="simple-timeline-number">{label}</span>}
    </i>;
    // A cut just applied: a sliver of its red closes up where the footage came out, then its marker arrives.
    return landed === "cut" ? [<i key={`${key}-closing`} aria-hidden="true" className="simple-timeline-closing" style={{ left: `${at}%` }} />, mark] : mark;
  })}</>, [markLayout, hotMark, litMark]);
  // The hovered marker's note rides in the scrub preview, under its frame, so hovering shows one card.
  const hotDots = hotMark === undefined ? undefined : markLayout.find(mark => mark.key === hotMark)?.dots;
  const markNote = hotDots && <span className="simple-timeline-tip is-joined">
    {(hotDots.length > MOST_NOTES ? hotDots.slice(0, 1) : hotDots).map((dot, i) => <span key={i}>
      <b>{dot.title}</b>
      {dot.summary && <span className="simple-timeline-tip-summary">{dot.summary}</span>}
      {dot.detail && <small>{dot.detail}</small>}
      {dot.context && dot.context !== dot.summary && <em>{dot.context}</em>}
    </span>)}
    {hotDots.length > MOST_NOTES && <span><small>and {hotDots.length - 1} more here</small></span>}
  </span>;
  // Skipped footage names its edit the same way.
  const [hotGap, setHotGap] = useState<TimelineGap>();
  const gapNodes = useMemo(() => <>{gaps?.map(gap => {
    const left = Math.max(0, percent(gap.start)), right = Math.min(100, percent(gap.end));
    if (right <= 0 || left >= 100) return null;
    const skipped = gap.skipped && !!onGap;
    // Pointer only, like the band: the keyboard reaches Before with \.
    const label = gapLabel(gap, (right - left) * width / 100);
    return <span key={`${gap.start}/${gap.end}`} aria-hidden="true" className={skipped ? "simple-timeline-gap is-skipped" : "simple-timeline-gap"}
      style={{ left: `${left}%`, width: `${right - left}%` }}
      onPointerEnter={skipped ? () => setHotGap(gap) : undefined} onPointerLeave={skipped ? () => setHotGap(undefined) : undefined}
      onPointerDown={skipped ? e => {
        if (e.button !== 0 || !e.isPrimary || drag.current) return;
        // This side would land past the gap, so a click goes to the caller instead of starting a scrub.
        e.stopPropagation();
        // The press switches sides, and this gap stops listening for the pointer leaving it: its note goes now.
        setHotGap(undefined);
        const rect = slider.current!.getBoundingClientRect();
        const at = rect.width > 0 ? from + span * (e.clientX - rect.left) / rect.width : gap.start;
        onGap!(gap, Math.max(gap.start, Math.min(gap.end, at)));
      } : undefined}>
      {label && <span className="simple-timeline-gap-label">{label}</span>}
    </span>;
  })}</>, [gaps, from, span, width, onGap]); // eslint-disable-line react-hooks/exhaustive-deps
  const liveGap = hotGap && onGap && gaps?.find(gap => gap.skipped && gap.start === hotGap.start && gap.end === hotGap.end);
  const gapNote = liveGap && <span className="simple-timeline-tip is-joined">
    <span>
      <b>{liveGap.title}</b>
      {liveGap.summary && <span className="simple-timeline-tip-summary">{liveGap.summary}</span>}
    </span>
  </span>;
  // Hovering reaches a marker from further away than a press does, so a press beside one still scrubs. A settled cut's
  // faint tick takes no room for a press either: only a dot or a pill opens its edit, and a press anywhere else scrubs.
  // Hovering a tick still lights its number.
  const [aimed, setAimed] = useState(false);
  const pressable = useMemo(() => markLayout.filter(mark => !mark.quiet), [markLayout]);
  const markUnder = (e: PointerEvent<HTMLElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (!box.width) return {};
    const at = (e.clientX - box.left) / box.width * 100;
    const press = nearestMark(pressable, at, box.width);
    const on = !!press && Math.abs(press.at - at) * box.width / 100 <= press.width / 2 + MARK_GAP;
    // The note names what a press would open.
    return { mark: on ? press : nearestMark(markLayout, at, box.width), open: on ? press.dots.find(dot => dot.open)?.open : undefined };
  };
  const hoverMark = (e: PointerEvent<HTMLElement>) => {
    if (drag.current || e.pointerType === "touch") return;
    const { mark, open } = markUnder(e);
    setHotMark(mark?.key);
    setAimed(!!open);
  };
  // A press on a marker opens its edit, or the first edit of a pill, instead of starting a scrub.
  const pressMark = (e: PointerEvent<HTMLElement>) => {
    setHotMark(undefined);
    const { open } = markUnder(e);
    if (!open || e.button !== 0 || !e.isPrimary || drag.current) return;
    e.stopPropagation();
    setAimed(false);
    open();
  };
  const timeline = !waveform?.source && !waveform?.original ? waveform?.timeline : undefined;
  const intendedSpan = target?.span ?? span;
  const zoom = span ? total / span : 1;
  const handleZoomKey = (e: KeyboardEvent) => {
    if (!total || ignorePageShortcut(e, track.current)) return;
    if (e.key === "+" || e.key === "=") zoomBy(2);
    else if (e.key === "-") zoomBy(.5);
    else if (e.key === "0") fitRange();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  useHotkeys(e => { if (activeShortcuts) handleZoomKey(e); });
  const markers = useMemo(() => {
    const captions = timeline?.tracks.filter(t => t.kind === "caption" && !t.hidden)
      .flatMap(track => track.clips.flatMap(clip => clip.kind === "caption" && clip.enabled && clip.text
        ? [{ id: clip.id, kind: "caption" as const, time: clip.timelineIn, description: clip.text, icon: "captions" as const }] : []));
    return [...(editMarkers ?? []), ...(captions ?? [])];
  }, [editMarkers, timeline]);
  const seek = () => {
    const gesture = drag.current;
    if (!gesture) return;
    gesture.paint = undefined;
    const rect = slider.current!.getBoundingClientRect();
    if (rect.width <= 0) return;
    const time = gesture.start + gesture.span * Math.max(0, Math.min(1, (gesture.x - rect.left) / rect.width));
    if (time === gesture.time) return;
    gesture.time = time;
    onSeek(time);
  };
  const finish = (e: PointerEvent<HTMLDivElement>) => {
    const gesture = drag.current;
    if (gesture?.id !== e.pointerId) return;
    if (gesture.paint !== undefined) cancelAnimationFrame(gesture.paint);
    if (e.type === "pointerup") gesture.x = e.clientX;
    seek();
    if (e.type === "pointerup" && gesture.time !== undefined) onSelectTime?.(gesture.time);
    drag.current = null;
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
  const zoomControls = <div className="timeline-zoom-row" role="group" aria-label="Timeline zoom">
    <button type="button" className="timeline-zoom-step" aria-label="Zoom out" title="Zoom out (−)" disabled={intendedSpan >= total} onClick={() => zoomBy(.5)}>−</button>
    <span className="timeline-zoom-level">{Number(zoom.toFixed(1))}×</span>
    <button type="button" className="timeline-zoom-step" aria-label="Zoom in" title="Zoom in (+)" disabled={intendedSpan <= minSpan} onClick={() => zoomBy(2)}>+</button>
    <button type="button" className="timeline-fit" aria-label="Fit timeline" title="Show full timeline (0)" disabled={intendedSpan >= total} onClick={() => fitRange()}>Fit</button>
  </div>;
  return <div className="timeline-panel" onKeyDown={e => handleZoomKey(e.nativeEvent)}>
    <div ref={track} className="timeline-track"><ScrubPreview start={from} duration={span} pictureAspect={pictureAspect} frameAt={frameAt} hoverVideo={hoverVideo} note={markNote || gapNote}>
    <div ref={slider} className="timeline-slider" role="slider" tabIndex={total ? 0 : -1} aria-disabled={!total}
      aria-label={label} aria-valuemin={start} aria-valuemax={end} aria-valuenow={position} aria-valuetext={playbackClock(position)}
      onPointerDown={e => {
        if (!total || e.button !== 0 || !e.isPrimary || drag.current) return;
        stopZoom();
        e.currentTarget.setPointerCapture(e.pointerId);
        const lifetime = new AbortController();
        drag.current = { id: e.pointerId, start: from, span, x: e.clientX, lifetime, finish: onScrubStart?.(lifetime.signal) };
        seek();
      }}
      onPointerMove={e => {
        const gesture = drag.current;
        if (gesture?.id !== e.pointerId) return;
        gesture.x = e.clientX;
        gesture.paint ??= requestAnimationFrame(seek);
      }}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
      onKeyDown={e => {
        // With ⌘, Ctrl or Alt held the key isn't the timeline's, as it isn't the page's.
        if (!total || e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          e.stopPropagation();
          selectPosition(arrowSeekTime(position, e.key, e.shiftKey));
          return;
        }
        const target = { Home: start, End: end, PageDown: position + span, PageUp: position - span }[e.key];
        if (target === undefined) return;
        e.preventDefault();
        e.stopPropagation();
        selectPosition(target);
      }}>
      <TimelineRuler start={from} duration={span} width={width} />
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
          <span aria-hidden="true" className={`simple-timeline-band${highlight.tone ? ` is-${highlight.tone}` : ""}${onBand ? " is-live" : ""}`} style={{ left: `${Math.min(100, Math.max(0, percent(highlight.band.start)))}%`,
            width: `${Math.max(0, Math.min(100, percent(highlight.band.end)) - Math.max(0, percent(highlight.band.start)))}%` }}
            onPointerDown={onBand ? e => {
              if (e.button !== 0 || !e.isPrimary || drag.current) return;
              // The playing side steps over this footage, so a click goes to the caller instead of starting a scrub.
              e.stopPropagation();
              const rect = slider.current!.getBoundingClientRect(), band = highlight.band!;
              const at = rect.width > 0 ? from + span * (e.clientX - rect.left) / rect.width : band.start;
              onBand(Math.max(band.start, Math.min(band.end, at)));
            } : undefined}>
            {bandText && <span>{bandText}</span>}</span>
        : highlight.band.start >= from && highlight.band.start <= to &&
          <span aria-hidden="true" className="simple-timeline-cut" style={{ left: `${percent(highlight.band.start)}%` }}>
            {highlight.bandLabel && <span>{highlight.bandLabel}</span>}</span>)}
      {gapNodes}
      {markLayout.length > 0 && <div aria-hidden="true" className={aimed ? "simple-timeline-hover is-aimed" : "simple-timeline-hover"}
        onPointerMove={hoverMark} onPointerLeave={() => { setHotMark(undefined); setAimed(false); }} onPointerDown={pressMark} />}
      {markNodes}
      {position >= from && position <= to && <>
        <span aria-hidden="true" className={gliding ? "timeline-playhead-time is-gliding" : "timeline-playhead-time"}
          style={{ left: `min(${percent(position)}%, calc(100% - var(--timeline-tools-space)))`, transform: `translateX(-${percent(position)}%)` }}>{playbackClock(position)}</span>
        <div aria-hidden="true" className={gliding ? "timeline-playhead is-gliding" : "timeline-playhead"} style={{ left: `${percent(position)}%` }} />
      </>}
    </div>
  </ScrubPreview>
    {!marks && <TimelineMarkers markers={markers} from={from} to={to} width={width} onChoose={selectPosition} />}
  </div>
  <ZoomPopover onKey={handleZoomKey}>{zoomControls}</ZoomPopover>
  </div>;
}
