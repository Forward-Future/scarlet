import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { filmstripBatches } from "@scarlet/timeline";
import { api } from "../../lib/client";
import { TimelineWaveform, type WaveformMedia } from "./TimelineWaveform";
import { QueuedImg, useStillTurn } from "./QueuedImg";
import { timelineFrameUrl } from "./thumbs";
import { useArrival, useLaneHold, wavePhase } from "./laneLoading";

export type FrameAt = (time: number, exact?: boolean) => string | undefined;

export interface PreviewStrip { id: string; version: string; fps: number }

export function stripUrl(preview: PreviewStrip, frames: number[]) {
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

export interface HeldStills { subject: string; built: string; view: string; cells: Element[]; pictured: boolean[] }
/**
 * A new working cut builds the timeline again and every still on it is a new picture from the engine. The lane built in
 * its place keeps showing the old stills, of the same footage, until its own have landed, instead of going blank. It
 * hands on whatever it shows, its own stills and the held ones in the slots its own haven't reached: a pass saves a new
 * cut every few seconds, and on 2026-11-21 no lane finished before the next replaced it, so the timeline stayed empty.
 */
interface Carry { subject: string; built: string; start: number; duration: number; held: RefObject<HeldStills | undefined> }
export const HeldStillsContext = createContext<Carry | null>(null);

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
      const hidden = getComputedStyle(el).visibility === "hidden";
      const width = el.clientWidth;
      const frameWidth = el.clientHeight * pictureAspect;
      // Even very narrow formats get a legible thumbnail.
      const next = width && frameWidth ? Math.max(1, Math.round(width / Math.max(24, frameWidth))) : 0;
      // Full screen hides the widened lane; keep its stills until it is visible again.
      setCount(current => current && hidden ? current : next);
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
    if (!cached) return times.map((time, i) => ({ key: String(i), src: timelineFrameUrl(frameAt(time, true)), span: 1 }));
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
  // Which slots show a picture of the lane's own, in order: a sheet fills several.
  const ownPictured = useMemo(() => stills.flatMap(still => Array<boolean>(still.span).fill(!!still.src && settled.get(still.src) === true)),
    [stills, settled]);
  // Held stills that line up with the lane's slots go one by one as the lane's own cover them, and the rest once every
  // still has settled. Ones that don't line up go together once the lane has a picture.
  const aligned = !!held && held.cells.length === ownPictured.length;
  const reveal = !waiting && (aligned ? complete : hasPicture || complete);
  useLayoutEffect(() => {
    const el = overlay.current;
    if (el && held && held.cells[0]?.parentElement !== el) {
      for (const cell of held.cells) cell.removeAttribute("data-covered");
      el.replaceChildren(...held.cells);
    }
  }, [held]);
  useLayoutEffect(() => {
    if (!held || !aligned) return;
    Array.from(overlay.current?.children ?? []).forEach((cell, i) => cell.toggleAttribute("data-covered", !waiting && !!ownPictured[i]));
  }, [held, aligned, waiting, ownPictured]);
  useLayoutEffect(() => {
    if (!carry) return;
    // The old lane unmounts before the new layout effects run. Move its already-decoded cells across intact:
    // this preserves sheet cropping and avoids an extra round of requests for the previous cut.
    const own = Array.from(strip.current!.querySelectorAll(":scope > div:not(.filmstrip-wait, .filmstrip-held)"));
    // Until every still of its own has settled, a slot its own hasn't reached hands on the held still there.
    const heldSlot = (i: number) => !complete && aligned && held!.cells.length === own.length && !!held!.pictured[i] && !ownPictured[i];
    const cells = own.map((cell, i) => heldSlot(i) ? held!.cells[i]! : cell);
    const pictured = own.map((_, i) => !!ownPictured[i] || heldSlot(i));
    if (pictured.some(Boolean)) {
      carry.held.current = { subject: carry.subject, built: carry.built, view, cells, pictured };
    } else if (complete || (carry.held.current?.built === carry.built && carry.held.current.view === view)) {
      // An empty or failed batch is terminal: once known, the next lane mustn't show footage from an older cut.
      carry.held.current = undefined;
    }
  }, [carry, complete, view, held, aligned, ownPictured]);
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
export function MediaLanes({ start, duration, pictureAspect, frameAt, preview, waveform, visibleStart, visibleSpan }: {
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
