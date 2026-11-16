import { createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode, type RefObject } from "react";
import { createStore, useStore } from "zustand";
import { filmstripBatches, type TimeRange } from "@scarlet/timeline";
import { api } from "../../lib/client";
import { usePlayerStore } from "../../stores/player";
import { useUiStore } from "../../stores/ui";
import { arrowSeekTime, ignorePageShortcut, useHotkeys } from "../../lib/hotkeys";
import { playbackClock } from "../../lib/format";
import { playbackLog } from "../../lib/playbackLog";
import type { ScrubRelease } from "../../lib/player";
import { TimelineWaveform, type WaveformMedia } from "./TimelineWaveform";
import { ScrubPreview, type HoverVideo } from "../player/ScrubPreview";
import { QueuedImg, useStillTurn } from "./QueuedImg";
import { TimelineRuler } from "./TimelineRuler";
import { Icon } from "../ui/primitives";
import { useTimelineZoom } from "./useTimelineZoom";
import { FloatingScrubLoupe, type ScrubLens } from "./FloatingScrubLoupe";
import { LOUPE_PX_PER_FRAME, rangeEdges, useRangeSelect } from "./TimelineRange";
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
  const complete = preview !== null && (duration <= 0 || (count > 0 && wanted.every(src => settled.has(src))));
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
  activeShortcuts?: boolean;
  duration: number;
  start?: number;
  playhead: number;
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
  /** What the hover note calls it while it waits on the editor, as "Cut 23 needs you". Only such a dot has a note. */
  need?: string;
  /** The edit or call that's open. Its marker is lit, at the start of its band while that is on the timeline. */
  current?: boolean;
  /** The applied edit the dot stands for ("changeId/spot"), so it isn't drawn a second time under the dot. */
  edit?: string;
  /** Opens the edit. A press on its marker does this instead of starting a scrub. */
  open?(): void;
  /** The edit was applied a moment ago: its marker arrives with a moment, a cut's red closing up into it first. */
  landed?: "cut" | "edit";
}

/** A marker shows its edit's number. Edits that share a marker show their run of numbers ("12–13"), or the lowest and a plus when they skip. */
function dotLabel(dots: readonly { n?: number }[], numbered: number, first: number, last: number) {
  const count = dots.length;
  if (!numbered) return undefined;
  // Places of one edit made in several places share its one number.
  if (count === 1 || (first === last && dots.every(d => d.n !== undefined))) return String(first);
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
const MARK_SNAP = 24;
/** A pill's run reaches at most this many pixels along the track, so a dense pass reads as several runs ("1–14",
 *  "15–27") that each zoom to a stretch worth seeing, not as one pill for all of it. */
const RUN_REACH = 104;

interface MarkLayout {
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
}

/** Each edit draws as its numbered circle. Circles that would touch at this zoom share one pill with their run of
 *  numbers, so there are never more markers than fit and none hides another. A run reaches at most RUN_REACH: the next
 *  edit starts a run of its own, moved along just clear of the one before if it would touch it. The open edit keeps its
 *  own circle the same way. Only circles of one
 *  group share: a call's and an edit's each keep their own. Before the track is measured, nothing is shared.
 *  `groupSpan` is the stretch the runs are worked out for, which a zoom on its way gives so its pills don't change on
 *  the way there; positions are always for `span`. */
export function layoutMarks(marks: TimelineDot[], from: number, span: number, width: number, groupSpan = span) {
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
  // How far apart two times are, in pixels, at the zoom the runs are for.
  const px = (a: number, b: number) => groupSpan > 0 ? (b - a) / groupSpan * width : 0;
  const marker = (key: string, time: number, dots: TimelineDot[]) => {
    const numbers = new Set<number>();
    let first = Infinity, last = -Infinity;
    for (const { n } of dots) if (n !== undefined) {
      numbers.add(n); first = Math.min(first, n); last = Math.max(last, n);
    }
    const label = dotLabel(dots, numbers.size, first, last);
    const layout: MarkLayout = { key, time, times: [time], dots, at: position(time), label, width: markWidth(label) };
    return { layout, numbers, first, last };
  };
  // The distance between two markers' centres, in pixels at the zoom the runs are for, counting a run moved along.
  const centreGap = (a: MarkLayout, b: MarkLayout) => px(mid(a), mid(b)) + (shift.get(b) ?? 0) - (shift.get(a) ?? 0);
  const mid = (m: MarkLayout) => (m.times[0]! + m.times.at(-1)!) / 2;
  const shift = new Map<MarkLayout, number>();
  const circles = new Map<string, ReturnType<typeof marker>[]>();
  for (const [key, dots] of [...byTime].sort((a, b) => a[1][0]!.time - b[1][0]!.time)) {
    const time = dots[0]!.time;
    let next = marker(key, time, dots);
    const row = circles.get(dots[0]!.group ?? "") ?? [];
    circles.set(dots[0]!.group ?? "", row);
    // A marker joins the run before it when its first edit's circle would touch that run's last, or the two markers
    // would touch, as long as the run doesn't reach too far.
    const crowded = (a: MarkLayout, b: MarkLayout) => px(a.times.at(-1)!, b.times[0]!) < markWidth("1") + MARK_GAP
      || centreGap(a, b) < a.width / 2 + b.width / 2 + MARK_GAP;
    for (let before = row.at(-1); width > 0 && before && crowded(before.layout, next.layout); before = row.at(-1)) {
      // A run that would reach too far stays apart, moved along just clear of the one before if it would touch it. So
      // does the edit that's open: its own number is lit at the start of its band, in no pill.
      const open = (m: MarkLayout) => m.dots.some(dot => dot.current);
      if (px(before.layout.times[0]!, next.layout.times.at(-1)!) > RUN_REACH || open(before.layout) || open(next.layout)) {
        const clear = before.layout.width / 2 + next.layout.width / 2 + MARK_GAP;
        if (centreGap(before.layout, next.layout) < clear) shift.set(next.layout, (shift.get(before.layout) ?? 0) - px(mid(before.layout), mid(next.layout)) + clear);
        break;
      }
      // Sharing widens the pill and moves it, so it can reach the marker before it too.
      row.pop();
      const group = before.layout;
      for (const t of next.layout.times) group.times.push(t);
      for (const dot of next.layout.dots) group.dots.push(dot);
      for (const n of next.numbers) before.numbers.add(n);
      before.first = Math.min(before.first, next.first);
      before.last = Math.max(before.last, next.last);
      group.label = dotLabel(group.dots, before.numbers.size, before.first, before.last);
      group.width = markWidth(group.label);
      // Its middle has moved: whether it still needs moving along is worked out again against the run before it.
      shift.delete(next.layout);
      shift.delete(group);
      next = before;
    }
    row.push(next);
  }
  // A marker sits at the middle of its run, moved along if it had to be, and never past the track's ends.
  const half = (m: MarkLayout) => width > 0 ? m.width / 2 / width * 100 : 0;
  return [...circles.values()].flatMap(row => row.map(({ layout }) => {
    const at = position(mid(layout)) + (width > 0 ? (shift.get(layout) ?? 0) / width * 100 : 0);
    return { ...layout, at: layout.times.length > 1 || shift.has(layout) ? Math.max(half(layout), Math.min(100 - half(layout), at)) : at };
  })).sort((a, b) => a.at - b.at);
}

/** The marker nearest the pointer, if it's within reach. A circle or pill drawn under the pointer comes first. */
export function nearestMark(layout: MarkLayout[], percent: number, width: number) {
  let nearest: MarkLayout | undefined, circle: MarkLayout | undefined;
  let distance = Infinity, circleDistance = Infinity;
  for (const mark of layout) {
    const delta = Math.abs(mark.at - percent);
    if (delta < distance) { nearest = mark; distance = delta; }
    if (delta * width / 100 <= mark.width / 2 && delta < circleDistance) { circle = mark; circleDistance = delta; }
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

const noRange = () => {};

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

function Scrubber({ duration, start = 0, playhead, waveform, activeShortcuts, subject, kept,
  pictureAspect = 16 / 9, frameAt, previewStrip, hoverVideo, onSeek, onSelectTime, onScrubStart, highlight, marks, typedTimes, gaps, skippedRanges, onGap, onBand, fit, range, onRange, fps = 30 }:
  TimelineScrubberProps & { subject: string; kept: RefObject<KeptView | undefined> }) {
  const litMark = useStore(useContext(EditHoverContext));
  // The message box's icon is open: the passage the message is about lights up.
  const aimLit = useUiStore(s => s.aimLit);
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
  const [lens, setLens] = useState<ScrubLens>();
  const drag = useRef<{
    id: number; start: number; span: number; lifetime: AbortController; finish?: () => void;
    time?: number; x: number; x0: number; y0: number; paint?: number;
    fine?: { x: number; frame: number };
  } | null>(null);
  const lastFrame = Math.max(0, Math.ceil(end * fps - 1e-6) - 1);
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
  const { view: { from, span }, samples, target, blend, minSpan, zoomBy, fitRange, stopZoom } = useTimelineZoom(track, start, total, position, drag, undefined, undefined, carried?.view);
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
  // A zoom on its way works out its runs for where it is going, so its pills don't change on the way there.
  const groupSpan = target?.span ?? span;
  const markLayout = useMemo(() => marks ? layoutMarks(marks, from, span, width, groupSpan) : [], [marks, from, span, width, groupSpan]);
  const [hotMark, setHotMark] = useState<string>();
  // The playhead re-renders the strip every frame. A pass can mark hundreds of cuts, so build them only when they change.
  const markNodes = useMemo(() => <>{markLayout.map(({ key, times, dots, at, label, width: size }) => {
    const on = dots.some(dot => dot.current);
    const hot = key === hotMark || (litMark !== undefined && times.includes(litMark));
    const landed = dots.some(dot => dot.landed === "cut") ? "cut" : dots.some(dot => dot.landed) ? "edit" : undefined;
    const mark = <i key={key} aria-hidden="true" data-state={dotState(dots)} data-landed={landed}
      className={`simple-timeline-mark ${label ? "is-numbered" : "is-dot"}${on ? " is-on" : ""}${hot ? " is-hot" : ""}`}
      style={{ left: `${at}%`, ...label && { width: size, marginLeft: -size / 2 } }}>
      {label && <span className="simple-timeline-number">{label}</span>}
    </i>;
    // A cut just applied: a sliver of its red closes up where the footage came out, then its marker arrives.
    return landed === "cut" ? [<i key={`${key}-closing`} aria-hidden="true" className="simple-timeline-closing" style={{ left: `${at}%` }} />, mark] : mark;
  })}</>, [markLayout, hotMark, litMark]);
  // Hovering a marker shows the frame and its time, as anywhere on the timeline. One holding what waits on the editor
  // says which, and the frame is that one's.
  const hotDots = hotMark === undefined ? undefined : markLayout.find(mark => mark.key === hotMark)?.dots;
  const waiting = hotDots?.find(dot => dot.state === "check" && dot.need);
  const markNote = waiting && <span className="simple-timeline-need">{waiting.need} needs you</span>;
  // Skipped footage can be heard: a press hands it to the caller. Its label says which cut took it out.
  const gapNodes = useMemo(() => <>{gaps?.map(gap => {
    const left = Math.max(0, percent(gap.start)), right = Math.min(100, percent(gap.end));
    if (right <= 0 || left >= 100) return null;
    const skipped = gap.skipped && !!onGap;
    // Pointer only, like the band: the keyboard reaches Before with \.
    const label = gapLabel(gap, (right - left) * width / 100);
    return <span key={`${gap.start}/${gap.end}`} aria-hidden="true" className={skipped ? "simple-timeline-gap is-skipped" : "simple-timeline-gap"}
      style={{ left: `${left}%`, width: `${right - left}%` }}
      onPointerDown={skipped ? e => {
        if (e.button !== 0 || !e.isPrimary || drag.current) return;
        // This side would land past the gap, so a click goes to the caller instead of starting a scrub.
        e.stopPropagation();
        const rect = slider.current!.getBoundingClientRect();
        const at = rect.width > 0 ? from + span * (e.clientX - rect.left) / rect.width : gap.start;
        onGap!(gap, Math.max(gap.start, Math.min(gap.end, at)));
      } : undefined}>
      {label && <span className="simple-timeline-gap-label">{label}</span>}
    </span>;
  })}</>, [gaps, from, span, width, onGap]); // eslint-disable-line react-hooks/exhaustive-deps
  // Hovering reaches a marker from further away than a press does, so a press beside one still scrubs.
  const [aimed, setAimed] = useState(false);
  // A pill opens into its edits: a press zooms to its run, where each has its own number, and opens nothing. Zoomed in
  // as far as the timeline goes, it opens its first. A marker of one edit opens it.
  const openMark = (mark: MarkLayout) => {
    const one = new Set(mark.dots.map(dot => dot.n ?? dot.time)).size === 1;
    const first = mark.dots.find(dot => dot.open)?.open;
    if (one || span <= minSpan * 1.05) return first;
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
    if (gesture.paint !== undefined) cancelAnimationFrame(gesture.paint);
    if (e.type === "pointerup") gesture.x = e.clientX;
    seek();
    if (e.type === "pointerup" && gesture.time !== undefined) onSelectTime?.(gesture.time);
    // A click away from the marked range, not a scrub, takes it off.
    if (e.type === "pointerup" && !gesture.fine && range && onRange && gesture.time !== undefined && Math.abs(gesture.x - gesture.x0) <= 3
      && (gesture.time < range.start || gesture.time > range.end)) onRange(undefined);
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
  const zoomControls = <div className="timeline-zoom-row" role="group" aria-label="Timeline zoom">
    <button type="button" className="timeline-zoom-step" aria-label="Zoom out" title="Zoom out (−)" disabled={intendedSpan >= total} onClick={() => zoomBy(.5)}>−</button>
    <span className="timeline-zoom-level">{Number(zoom.toFixed(1))}×</span>
    <button type="button" className="timeline-zoom-step" aria-label="Zoom in" title="Zoom in (+)" disabled={intendedSpan <= minSpan} onClick={() => zoomBy(2)}>+</button>
    <button type="button" className="timeline-fit" aria-label="Fit timeline" title="Show full timeline (0)" disabled={intendedSpan >= total} onClick={() => fitRange()}>Fit</button>
  </div>;
  return <div className="timeline-panel" onKeyDown={e => handleZoomKey(e.nativeEvent)}>
    <div ref={track} className={marking.marking ? "timeline-track is-marking" : "timeline-track"}><ScrubPreview suspended={!!lens} start={from} duration={span} pictureAspect={pictureAspect} frameAt={frameAt} hoverVideo={hoverVideo} note={markNote || undefined} pin={waiting?.time}>
    <div ref={slider} className="timeline-slider" role="slider" tabIndex={total ? 0 : -1} aria-disabled={!total}
      aria-label="Position in the video" aria-description="Drag up from the picture or waveform to scrub one frame at a time." aria-valuemin={start} aria-valuemax={end} aria-valuenow={position} aria-valuetext={playbackClock(position)}
      onPointerDown={e => {
        if (!total || e.button !== 0 || !e.isPrimary || drag.current) return;
        if (onRange) {
          // The ruler marks a range. The strip that picks a marker lies over its lower edge, so go by where the press is.
          const box = e.currentTarget.getBoundingClientRect();
          const ruler = e.currentTarget.querySelector<HTMLElement>(".timeline-lanes")?.offsetTop ?? 0;
          const onRuler = !!(e.target as Element).closest(".timeline-range-zone") || (box.height > 0 && e.clientY - box.top < ruler);
          if (onRuler && marking.begin(e)) return;
        }
        stopZoom();
        e.currentTarget.setPointerCapture(e.pointerId);
        const lifetime = new AbortController();
        drag.current = { id: e.pointerId, start: from, span, x: e.clientX, x0: e.clientX, y0: e.clientY, lifetime, finish: onScrubStart?.(lifetime.signal) };
        seek();
      }}
      onPointerMove={e => {
        const gesture = drag.current;
        if (gesture?.id !== e.pointerId) return;
        if (!gesture.fine && gesture.y0 - e.clientY >= 24 && gesture.time !== undefined && fps > 0 && Number.isFinite(fps)) {
          // Enter at the last coarse position. Movement from here is relative, independent of the timeline zoom.
          gesture.fine = { x: e.clientX, frame: Math.round(gesture.time * fps) };
        }
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
      {onRange && total > 0 && <div aria-hidden="true" className="timeline-range-zone" title="Drag to mark a range for your message" />}
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
          <span aria-hidden="true" className={`simple-timeline-band${highlight.tone ? ` is-${highlight.tone}` : ""}${onBand ? " is-live" : ""}${aimLit ? " is-lit" : ""}`} style={{ left: `${Math.min(100, Math.max(0, percent(highlight.band.start)))}%`,
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
      {typedTimes?.filter(time => time >= from && time <= to).map(time =>
        <span key={time} className="timeline-message-time" aria-hidden="true" data-time={time} style={{ left: `${percent(time)}%` }} />)}
      {marking.layer}
      {lens && <FloatingScrubLoupe lens={lens} first={firstFrame} last={lastFrame} fps={fps}
        frameAt={frameAt} sheet={sheet} pictureAspect={pictureAspect} />}
      {position >= from && position <= to && <>
        {!lens && <span aria-hidden="true" className={gliding ? "timeline-playhead-time is-gliding" : "timeline-playhead-time"}
          style={{ left: `min(${percent(position)}%, calc(100% - var(--timeline-tools-space)))`, transform: `translateX(-${percent(position)}%)` }}>{playbackClock(position)}</span>}
        <div aria-hidden="true" className={gliding ? "timeline-playhead is-gliding" : "timeline-playhead"} style={{ left: `${percent(position)}%` }} />
      </>}
    </div>
  </ScrubPreview>
  </div>
  <ZoomPopover onKey={handleZoomKey}>{zoomControls}</ZoomPopover>
  </div>;
}
