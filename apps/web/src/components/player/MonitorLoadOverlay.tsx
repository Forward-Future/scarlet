import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { COMPARE_KEY } from "../../lib/hotkeys";
import { usePlayerStore } from "../../stores/player";
import { wavePhase } from "../review/laneLoading";

/** Matches `usePictureWait`'s blink threshold so instant cached switches show nothing extra. */
export const MONITOR_LOAD_GRACE_MS = 180;
/** Total wait before the centered status pill fades in. */
export const MONITOR_LOAD_EXTENDED_MS = 1500;
/** Total wait before the optional Before shortcut hint fades in. */
export const MONITOR_LOAD_HINT_MS = 2500;
/** Duration of the smooth lift once playback is ready. */
export const MONITOR_LOAD_LEAVE_MS = 280;

export type WaitStage = "preparing" | "rendering" | "loading";

export interface WaitProgress {
  done: number;
  total: number;
}

export interface LeadInFrames {
  fast?: string;
  sharp?: string;
}

interface VideoWaitInfo {
  marked: boolean;
  stage?: "rendering" | "loading";
  progress?: WaitProgress;
}

interface DisplaySnapshot {
  stage: WaitStage;
  progress?: WaitProgress;
  extended: boolean;
  showHint: boolean;
}

function parseProgress(raw: string | undefined): WaitProgress | undefined {
  if (!raw) return undefined;
  const parts = raw.split("/");
  if (parts.length !== 2) return undefined;
  const done = Number(parts[0]);
  const total = Number(parts[1]);
  if (!Number.isInteger(done) || !Number.isInteger(total) || total <= 0 || done < 0) return undefined;
  return { done, total };
}

function activeVideos(root: HTMLElement | null): HTMLVideoElement[] {
  if (!root) return [];
  return [...root.querySelectorAll("video")].filter(v => !v.closest("[hidden], [data-parked]"));
}

function readVideoWait(root: HTMLElement | null): VideoWaitInfo {
  const waiting = activeVideos(root).find(v => v.hasAttribute("data-waiting"));
  if (!waiting) return { marked: false };
  const stage = waiting.dataset.waitStage === "rendering" ? "rendering" : "loading";
  return { marked: true, stage, progress: parseProgress(waiting.dataset.waitProgress) };
}

function hasDecodedVideo(root: HTMLElement | null): boolean {
  return activeVideos(root).some(v => v.readyState >= 2 && v.videoWidth > 0);
}

/** Captures a compact copy of the outgoing frame so cut switches don't snap to black. */
function captureFrame(video: HTMLVideoElement | undefined): HTMLCanvasElement | undefined {
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return undefined;
  const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  try {
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
  } catch {
    return undefined;
  }
  canvas.dataset.ambientSource = "true";
  return canvas;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function waitCopy(stage: WaitStage, progress?: WaitProgress): { label: string; meta?: string } {
  if (stage === "preparing") return { label: "Preparing cut\u2026" };
  if (stage === "rendering") {
    if (progress && progress.total > 1) {
      const current = Math.min(progress.done + 1, progress.total);
      return { label: "Rendering clip", meta: `${current} of ${progress.total}` };
    }
    return { label: "Rendering clip\u2026" };
  }
  return { label: "Loading clip\u2026" };
}

export interface MonitorLoadOverlayProps {
  monitor: RefObject<HTMLDivElement | null>;
  pictureWaiting: boolean;
  openingJoin: boolean;
  disabled?: boolean;
  transitionKey?: string;
  resolveLeadIn: () => LeadInFrames;
  canWatchBefore?: boolean;
}

/**
 * Escalating monitor curtain for slow cut switches and cold renders under heavy CPU load:
 * - 0–180ms: stays invisible on instant switches; briefly holds the outgoing frame during `openingJoin` so cuts don't flash black.
 * - 180ms–1.5s: shows a dimmed lead-in still of the target moment, a warm sheen synced to the timeline's `--wave-phase`, and a bottom hairline bar.
 * - > 1.5s: fades in a frosted centered status pill naming the active stage (`Preparing cut…`, `Rendering clip · X of Y`).
 * - > 2.5s on After of a review cut: adds a quiet hint that `\` switches to Before while After renders.
 * - On ready: lifts cleanly over 280ms directly into playback (instant with reduced motion).
 */
export function MonitorLoadOverlay({
  monitor,
  pictureWaiting,
  openingJoin,
  disabled = false,
  transitionKey,
  resolveLeadIn,
  canWatchBefore = false,
}: MonitorLoadOverlayProps) {
  const [openingReady, setOpeningReady] = useState(false);
  const [videoWait, setVideoWait] = useState<VideoWaitInfo>({ marked: false });
  const [extended, setExtended] = useState(false);
  const [hintReady, setHintReady] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [phase, setPhase] = useState("0s");
  const [stillUrl, setStillUrl] = useState<string>();
  const [stillLoaded, setStillLoaded] = useState(false);
  const [heldVersion, setHeldVersion] = useState(0);

  const wasActive = useRef(false);
  const waitStartedAt = useRef<number | undefined>(undefined);
  const heldCanvas = useRef<HTMLCanvasElement | undefined>(undefined);
  const lastDecodedVideo = useRef<HTMLVideoElement | undefined>(undefined);
  const heldHost = useRef<HTMLDivElement>(null);
  const lastSnapshot = useRef<DisplaySnapshot>({ stage: "loading", extended: false, showHint: false });
  const resolveLeadInRef = useRef(resolveLeadIn);
  resolveLeadInRef.current = resolveLeadIn;
  // A seek while the picture still loads moves the moment the still should show. During a drag only the quick
  // still follows it; the sharp one is fetched once the drag lets go.
  const seeks = usePlayerStore(s => s.seeks);
  const scrubbing = usePlayerStore(s => !!s.scrubGesture);

  // Record when a wait episode begins so heavy CPU stalls still hit the exact 1.5s / 2.5s thresholds.
  if (disabled) {
    waitStartedAt.current = undefined;
  } else if (openingJoin) {
    waitStartedAt.current ??= Date.now();
  } else if (pictureWaiting) {
    waitStartedAt.current ??= Date.now() - MONITOR_LOAD_GRACE_MS;
  }

  // Observe `data-waiting`, `data-wait-stage`, and `data-wait-progress` on active monitor videos,
  // and capture the outgoing video frame on pause/seek/wait so cut switches don't snap to black.
  useEffect(() => {
    const root = monitor.current;
    if (!root) return;
    const syncWait = () => {
      const next = readVideoWait(root);
      setVideoWait(prev =>
        prev.marked === next.marked
        && prev.stage === next.stage
        && prev.progress?.done === next.progress?.done
        && prev.progress?.total === next.progress?.total
          ? prev : next);
    };
    const onDecoded = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLVideoElement) || target.closest("[hidden], [data-parked]")) return;
      if (target.readyState >= 2 && target.videoWidth > 0) lastDecodedVideo.current = target;
      if (event.type === "playing") heldCanvas.current = undefined;
    };
    const onCapture = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLVideoElement) || target.closest("[hidden], [data-parked]")) return;
      const frame = captureFrame(target);
      if (frame) {
        lastDecodedVideo.current = target;
        heldCanvas.current = frame;
        setHeldVersion(n => n + 1);
      }
    };
    syncWait();
    const observer = new MutationObserver(syncWait);
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["hidden", "data-parked", "data-waiting", "data-wait-stage", "data-wait-progress"],
    });
    for (const name of ["loadeddata", "canplay", "playing", "seeked"]) root.addEventListener(name, onDecoded, true);
    for (const name of ["pause", "seeking", "waiting"]) root.addEventListener(name, onCapture, true);
    return () => {
      observer.disconnect();
      for (const name of ["loadeddata", "canplay", "playing", "seeked"]) root.removeEventListener(name, onDecoded, true);
      for (const name of ["pause", "seeking", "waiting"]) root.removeEventListener(name, onCapture, true);
    };
  }, [monitor]);

  // Capture a visible (or recently active) decoded video when stepping to a new cut/selection while paused.
  useLayoutEffect(() => {
    const root = monitor.current;
    if (!root) return;
    const video = activeVideos(root).findLast(v => v.readyState >= 2 && v.videoWidth > 0) ?? lastDecodedVideo.current;
    const frame = captureFrame(video);
    if (frame) {
      heldCanvas.current = frame;
      setHeldVersion(n => n + 1);
    }
  }, [monitor, transitionKey]);

  // Apply the same 180ms grace period to `openingJoin` (`pictureWaiting` already waited 180ms).
  useEffect(() => {
    if (disabled || !openingJoin) {
      setOpeningReady(false);
      return;
    }
    const timer = window.setTimeout(() => setOpeningReady(true), MONITOR_LOAD_GRACE_MS);
    return () => clearTimeout(timer);
  }, [disabled, openingJoin]);

  // Read DOM wait attributes synchronously during handoff so `openingJoin -> CutStream[data-waiting]` never flickers.
  const domWait = !disabled && (wasActive.current || openingJoin || pictureWaiting) ? readVideoWait(monitor.current) : undefined;
  const effectiveVideoWait = domWait?.marked ? domWait : videoWait;

  // Keep an already-active wait episode bridged across the handoff from `openingJoin` to `CutStream[data-waiting]`.
  const active = !disabled && (pictureWaiting || (openingJoin && openingReady) || (wasActive.current && effectiveVideoWait.marked));

  // Manage escalation timers (1.5s pill, 2.5s Before hint) and clean 280ms lift on completion.
  useLayoutEffect(() => {
    const root = monitor.current;
    const latestDomWait = root ? readVideoWait(root) : { marked: false };
    setVideoWait(prev =>
      prev.marked === latestDomWait.marked
      && prev.stage === latestDomWait.stage
      && prev.progress?.done === latestDomWait.progress?.done
      && prev.progress?.total === latestDomWait.progress?.total
        ? prev : latestDomWait);
    const prev = wasActive.current;
    const stillActive = !disabled && (pictureWaiting || (openingJoin && openingReady) || (prev && latestDomWait.marked));
    wasActive.current = stillActive;
    if (stillActive) {
      setLeaving(false);
      if (!prev) {
        setPhase(wavePhase());
        setExtended(false);
        setHintReady(false);
      }
      return;
    }
    if (!openingJoin) waitStartedAt.current = undefined;
    if (prev && !disabled && !prefersReducedMotion()) {
      setLeaving(true);
    } else if (disabled || prefersReducedMotion() || prev) {
      setLeaving(false);
      setExtended(false);
      setHintReady(false);
    }
  }, [active, disabled, monitor, openingJoin, openingReady, pictureWaiting]);

  useEffect(() => {
    if (!active) return;
    const elapsed = Math.max(0, Date.now() - (waitStartedAt.current ?? Date.now() - MONITOR_LOAD_GRACE_MS));
    const toExtended = Math.max(0, MONITOR_LOAD_EXTENDED_MS - elapsed);
    const toHint = Math.max(0, MONITOR_LOAD_HINT_MS - elapsed);
    if (toExtended === 0) setExtended(true);
    if (toHint === 0) setHintReady(true);
    const extendedTimer = toExtended > 0 ? window.setTimeout(() => setExtended(true), toExtended) : undefined;
    const hintTimer = toHint > 0 ? window.setTimeout(() => setHintReady(true), toHint) : undefined;
    return () => {
      clearTimeout(extendedTimer);
      clearTimeout(hintTimer);
    };
  }, [active]);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => {
      setLeaving(false);
      setExtended(false);
      setHintReady(false);
    }, MONITOR_LOAD_LEAVE_MS);
    return () => clearTimeout(timer);
  }, [leaving]);

  // Resolve and load the target moment's lead-in still (`scrubFrameUrl` fast, upgrading to `cutFrameUrl` sharp).
  const needsLeadIn = !disabled && (active || openingJoin);
  useEffect(() => {
    if (!needsLeadIn) {
      if (!leaving) {
        setStillUrl(undefined);
        setStillLoaded(false);
      }
      return;
    }
    const { fast, sharp } = resolveLeadInRef.current();
    const initial = fast ?? sharp;
    if (!initial) {
      setStillUrl(undefined);
      setStillLoaded(false);
      return;
    }
    setStillUrl(prev => {
      if (prev === initial || (sharp && prev === sharp)) return prev;
      setStillLoaded(false);
      return initial;
    });
    if (!sharp || sharp === initial || scrubbing) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      setStillUrl(sharp);
      setStillLoaded(true);
    };
    img.src = sharp;
    return () => {
      cancelled = true;
      img.onload = null;
    };
  }, [needsLeadIn, leaving, transitionKey, seeks, scrubbing]);

  const chromeVisible = active || leaving;
  // The outgoing frame holds until the lead-in still is on screen. A still that loads within the first 180ms isn't
  // shown yet, so letting go of the frame then would leave the monitor black until it is.
  const showHeld = !disabled && (openingJoin || active || leaving) && !(chromeVisible && stillLoaded) && !!heldCanvas.current
    && !hasDecodedVideo(monitor.current);

  useLayoutEffect(() => {
    const host = heldHost.current;
    const canvas = heldCanvas.current;
    if (!host || !canvas || !showHeld) return;
    host.replaceChildren(canvas);
    return () => { canvas.remove(); };
  }, [showHeld, heldVersion]);

  const liveStage: WaitStage = openingJoin ? "preparing" : effectiveVideoWait.stage ?? "loading";
  const liveProgress = liveStage === "rendering" ? effectiveVideoWait.progress : undefined;
  const liveShowHint = extended && hintReady && canWatchBefore;

  if (active) {
    lastSnapshot.current = { stage: liveStage, progress: liveProgress, extended, showHint: liveShowHint };
  }

  // Only show during active wait (>= 180ms), smooth 280ms lift, or brief outgoing-frame hold during `openingJoin` (< 180ms).
  if (!active && !leaving && !showHeld) return null;

  const display = active ? { stage: liveStage, progress: liveProgress, extended, showHint: liveShowHint } : lastSnapshot.current;
  const { label, meta } = waitCopy(display.stage, display.progress);
  const determinate = display.stage === "rendering" && !!display.progress && display.progress.total > 1;
  const percent = determinate
    ? Math.min(100, Math.round(((display.progress!.done + 0.18) / display.progress!.total) * 100))
    : undefined;

  return (
    <div
      className="monitor-load"
      data-active={active || undefined}
      data-leaving={leaving || undefined}
      data-stage={chromeVisible ? display.stage : undefined}
      aria-hidden={!active || undefined}
      style={{ "--wave-phase": phase } as CSSProperties}
    >
      {showHeld && <div ref={heldHost} className="monitor-load-held" data-dimmed={chromeVisible || undefined} aria-hidden="true" />}
      {chromeVisible && stillUrl && (
        <img
          src={stillUrl}
          alt=""
          draggable={false}
          className="monitor-load-still"
          data-loaded={stillLoaded || undefined}
          data-ambient-source={stillLoaded ? "true" : undefined}
          onLoad={() => setStillLoaded(true)}
          onError={() => setStillLoaded(false)}
          aria-hidden="true"
        />
      )}
      {chromeVisible && <div className="monitor-load-scrim" aria-hidden="true" />}
      {chromeVisible && <div className="monitor-load-sheen" aria-hidden="true"><i /></div>}
      {chromeVisible && display.extended && (
        <div className="monitor-load-center">
          <div className="monitor-load-pill" role={active ? "status" : undefined}>
            <span className="monitor-load-ring" aria-hidden="true" />
            <span className="monitor-load-label">{label}</span>
            {meta && <span className="monitor-load-meta">&middot; {meta}</span>}
          </div>
          {display.showHint && (
            <div className="monitor-load-hint">
              Press <kbd>{COMPARE_KEY}</kbd> to watch Before while After renders
            </div>
          )}
        </div>
      )}
      {chromeVisible && (
        <div className="monitor-load-bar" aria-hidden="true">
          <span
            className={determinate ? "monitor-load-bar-fill" : "monitor-load-bar-fill is-indeterminate"}
            style={determinate ? { width: `${percent}%` } : undefined}
          />
        </div>
      )}
    </div>
  );
}
