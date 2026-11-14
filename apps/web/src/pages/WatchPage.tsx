import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import type { ThreadEdit } from "@scarlet/shared";
import { isPlayableMedia, timelineDuration, type Change, type MediaAsset, type Project, type TimeRange, type Timeline } from "@scarlet/timeline";
import { arrowSeekTime, handleCutArrow, useHotkeys } from "../lib/hotkeys";
import { canPlayOriginal, isPreparingMedia } from "../lib/upload";
import { isLink } from "../lib/pendingImports";
import { useUploader, useImportCount } from "../components/media/UploadDropzone";
import { ImportProgress } from "../components/media/ImportProgress";
import { pauseForScrub, player } from "../lib/player";
import { playbackLog } from "../lib/playbackLog";
import type { JoinClock } from "../lib/joinClock";
import { api, IS_MOCK, loggedFetch } from "../lib/client";
import { usePlayerStore } from "../stores/player";
import { selectRender, useProjectStore } from "../stores/project";
import { editTargetAt, markedRangeOf, useUiStore, type AgentContext, type MarkedRange } from "../stores/ui";
import { Icon } from "../components/ui/primitives";
import { PreferenceSelect } from "../components/ui/PreferenceSelect";
import { CachedVideo } from "../components/player/CachedVideo";
import { MonitorPlayback, PlayerTime } from "../components/player/MonitorPlayback";
import { usePictureWait } from "../components/player/usePictureWait";
import { useCutAudio } from "../components/player/useCutAudio";
import { usePlaybackCache } from "../components/player/usePlaybackCache";
import { CutStream } from "../components/player/CutStream";
import { Player } from "../components/player/Player";
import { AmbientLight } from "../components/player/AmbientLight";
import { cutFrameUrl, scrubFrameUrl } from "../components/review/thumbs";
import { EditBeforePreview, useEditBefore, type BeforePlayback } from "../components/review/EditBeforePreview";
import { useApprovalComparison } from "../components/review/SideBySideComparison";
import type { EditCue } from "../components/review/EditReferences";
import { PlayerTimeline, type TimelineDot, type TimelineGap } from "../components/review/TimelineScrubber";
import { BeforeToggle } from "../components/review/BeforeToggle";
import type { CutPlaybackWindow, PreparedCut } from "../components/review/usePrepareNextCut";
import { FramingPreview } from "../components/review/FramingPreview";
import { useNotePositions } from "../lib/useNotePositions";
import type { ProgressFocus } from "../components/player/SimpleProgress";
import { editFocus } from "../lib/editKind";
import { editKey } from "../lib/keptEdits";

const noop = () => {};
const documentVisible = () => !document.hidden;
const onVisibility = (read: () => void) => {
  document.addEventListener("visibilitychange", read);
  return () => document.removeEventListener("visibilitychange", read);
};

/** The edit or call that's open on the player, and how the page steps to another. */
interface ThreadTimelineView {
  threadId?: string;
  edits: ThreadEdit[];
  selected?: ThreadEdit;
  originalChange?: Change;
  cutReview?: { cuts: ThreadEdit[] };
  framing?: { beforeVersion: string; cue?: number };
  framingFor?(edit: ThreadEdit): ThreadTimelineView["framing"];
  request: number;
  loading?: boolean;
  error?: string;
  retry(): void;
  choose(edit: ThreadEdit): void;
  clear(): void;
}
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(value => ({ value, label: `${value}×` }));

export function ImportPreview({ projectId, preparing, onMedia }: { projectId: string; preparing?: MediaAsset; onMedia(): void }) {
  const { localImport, items } = useUploader(projectId);
  const path = localImport?.path;
  const [frame, setFrame] = useState<{ path: string; url: string }>();
  useEffect(() => {
    // A link is not a file on this computer: the engine has no frame of it until it has downloaded.
    if (!path || isLink(path) || !/\.(mp4|mov|mkv|webm|m4v|avi|mxf|mts|m2ts|png|jpe?g|webp|gif)$/i.test(path)) return;
    const controller = new AbortController();
    let url: string | undefined;
    void (async () => {
      // Through the logged fetch, like every other request: a frame that never comes is in the log with the engine's reason.
      const response = await loggedFetch(api.url(`/projects/${projectId}/media/import-frame`), {
        method: "POST", signal: controller.signal, body: JSON.stringify({ path }),
        headers: { "Content-Type": "application/json", ...(api.token && { Authorization: `Bearer ${api.token}` }) },
      });
      if (!response.ok) return;
      const image = await response.blob();
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(image);
      setFrame({ path, url });
    })().catch(() => {}); // The import still reports its own errors and prepares compatible footage.
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [path, projectId]);
  const upload = items.find(item => item.state === "uploading" || item.state === "preparing");
  return <div className="absolute inset-0 flex items-end justify-center p-3">
    {frame && frame.path === path && <img src={frame.url} alt="" className="absolute inset-0 w-full h-full object-contain" />}
    <div className="relative w-full max-w-sm rounded-lg border border-white/15 bg-black/85 px-4 py-3 text-fg">
      <ImportProgress localImport={localImport} upload={upload} preparing={preparing} />
      {!localImport && !upload && preparing && <button className="btn-quiet mt-1" onClick={onMedia}>View media</button>}
    </div>
  </div>;
}

function SelectedCutFrame({ url, time, fps }: { url: string; time: number; fps: number }) {
  const [needed, setNeeded] = useState(false);
  useLayoutEffect(() => {
    const video = player.element();
    const target = player.elementTime(time);
    const decoded = () => !!video && !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.5 / fps;
    if (decoded()) { setNeeded(false); return; }
    // A local file or buffered fragment often wins the race against a JPEG.
    // An unbuffered edit fragment must first render; request its exact still now.
    const buffered = video?.buffered;
    const missingFragment = video?.currentSrc.startsWith("blob:") && buffered &&
      !Array.from({ length: buffered.length }, (_, i) => i).some(i => buffered.start(i) <= target && target < buffered.end(i));
    const timer = video?.readyState && !missingFragment ? setTimeout(() => setNeeded(!decoded()), 120) : undefined;
    if (timer === undefined) setNeeded(true);
    const ready = () => {
      if (decoded()) { clearTimeout(timer); setNeeded(false); }
    };
    video?.addEventListener("seeked", ready);
    video?.addEventListener("loadeddata", ready);
    video?.addEventListener("canplay", ready);
    return () => {
      clearTimeout(timer);
      video?.removeEventListener("seeked", ready);
      video?.removeEventListener("loadeddata", ready);
      video?.removeEventListener("canplay", ready);
    };
  }, [url, time, fps]);
  return needed && <img src={url} alt="Selected edit frame" draggable={false}
    className="pointer-events-none absolute inset-0 h-full w-full object-contain opacity-0"
    onLoad={e => { e.currentTarget.style.opacity = "1"; }} />;
}

interface PreviewProps {
  threadView?: ThreadTimelineView;
  playFullCut?: boolean;
  workingCache: ReturnType<typeof usePlaybackCache>;
  draftVersion?: string;
  draft?: Timeline;
  draftFailed?: boolean;
  openingJoin?: boolean;
  onRetryDraft(): void;
  source?: MediaAsset;
  hasCut: boolean;
  autoPlaySource: boolean;
  change?: Change;
  spot: number;
  cue?: EditCue;
  approval?: boolean;
  /**
   * The editor's presses that play the change, counted: the line that opens a suggestion says it plays it, as an edit's
   * row plays its edit. Each press plays it once from where it begins, as soon as its version is up. A change that
   * comes back on screen by itself, after an apply that was refused, stays paused.
   */
  playChange?: number;
  active: boolean;
  onMedia(): void;
  resumeTime?: number;
  /**
   * Experimental simple workspace: the picture, a thin progress line and Before/After only.
   * compareHost puts an applied edit's Before/After in its card's row of controls.
   * It is null while the panel mounts, so the toggle waits for it instead of showing in the old row.
   * `above` sits right on top of the timeline, as the card for the edit on screen.
   * `gaps` marks footage other cuts took out, and `onGap` takes a click into one the playing side can't play.
   */
  simple: { cutPlayback?: { key: string; start: number; side: "before" | "after"; beforeFile?: string; afterFile?: string; beforeWindow?: CutPlaybackWindow; afterWindow?: CutPlaybackWindow };
    nextCutPlayback?: PreparedCut;
    marks: TimelineDot[]; focus?: ProgressFocus; label?: string; compareHost?: HTMLElement | null; above?: ReactNode;
    gaps?: TimelineGap[]; skippedRanges?: TimeRange[]; onGap?(gap: TimelineGap, time: number): void;
    /** A click inside the shaded passage, when the playing side steps over it. */
    onBand?(time: number): void;
    /** Timeline navigation offers the point to the composer. N attaches it explicitly. */
    onPick?(point: AgentContext, action: "offer" | "attach"): void;
    /** A stretch marked on the timeline's ruler for the message being written, or none once it is taken off there. */
    onRange?(range: MarkedRange | undefined): void;
    /** The chosen edit is about to play on another version: don't start its passage on this one meanwhile. */
    holdPassage?: boolean;
    /** A revision was requested from the open card. Its message box is outside the player. */
    writeRequest?: number;
    /**
     * The edit whose listen the editor has started, shared with the page's own listen of a cut. An edit that was a cut
     * until its revision landed, or becomes one, is taken up as it was instead of started again.
     */
    heard?: { current: string | undefined } };
  /**
   * Play this rendered version instead, through `clock`, while everything on screen stays on the version shown.
   * Its joins are inside the rendered media, so a cut sounds exactly as it will. `file` is its saved preview, when
   * it has one; the caller finds that out first, so the player that goes up is the one the listen stays on.
   */
  joined?: { version: string; timeline: Timeline; clock: JoinClock; file?: string; cache?: string };
}

/** How far past a click after an edit's passage the stretched passage plays. */
const REACH_AFTER_SECONDS = 2;

/** Mount the bounded file only before an audition starts or while its side is parked. Seeking
 * outside it hands the same version clock back to the full segmented player at the editor's point. */
function CutSide({ project, timeline, url, window, parkedAt, active, fps, label, joins }: {
  project: Project; timeline: Timeline; url?: string; window?: CutPlaybackWindow; parkedAt?: number;
  active: boolean; fps: number; label: string; joins?: JoinClock;
}) {
  const [outside, setOutside] = useState(false);
  const handoff = useRef<{ time: number; resume: boolean }>(undefined);
  const displayed = useRef<{ active: boolean; url?: string; file?: CutPlaybackWindow }>(undefined);
  const isActive = parkedAt === undefined;
  const current = isActive && displayed.current?.active ? displayed.current : { url, file: url ? undefined : window };
  const { file } = current;
  const fileDuration = useMemo(() => file ? timelineDuration(timeline) : 0, [file, timeline]);
  useLayoutEffect(() => {
    displayed.current = { active: isActive, url: current.url, file };
    if (!isActive) setOutside(false);
  }, [isActive, current.url, file]);
  useLayoutEffect(() => {
    if (!outside || !isActive || !handoff.current) return;
    const { time, resume } = handoff.current;
    handoff.current = undefined;
    player.prepare();
    player.seek(time, true);
    if (resume) player.play();
  }, [outside, isActive, joins]);
  if (current.url || (file && !outside)) {
    const path = current.url ?? file!.url;
    return <CachedVideo key={path} url={path} label={label} fps={fps} active={active} hidden={false} autoPlay={false} joins={joins} parkedAt={parkedAt}
      windowed={file ? { file, duration: fileDuration, outOfRange(time, resume) {
        handoff.current = { time: joins ? joins.toView(time) : time, resume };
        setOutside(true);
      } } : undefined} />;
  }
  return <CutStream project={project} timeline={timeline} version={timeline.version} joins={joins}
    proposed={label === "Proposed draft"} onStart={noop} parkedAt={parkedAt} />;
}

export function CutPreview({ threadView, workingCache, draftVersion, draft, draftFailed, openingJoin, onRetryDraft, source, autoPlaySource, hasCut, change, spot, cue, approval = false, playChange, playFullCut = false, active,
  onMedia, resumeTime, simple, joined }: PreviewProps) {
  const current = useProjectStore(useShallow(s => {
    if (!s.current) return null;
    const { id, project, media, timeline, notes, versions, renderSettingsRevision, headError } = s.current;
    return { id, project, media, timeline, notes, versions, renderSettingsRevision, headError };
  }))!;
  const pendingImports = useImportCount(current.id);
  const cut = hasCut && !source && !draftVersion;
  const videoDuration = usePlayerStore((s) => s.duration);
  const playing = usePlayerStore((s) => s.playing);
  const playbackReady = usePlayerStore((s) => s.playbackReady);
  const rate = usePlayerStore((s) => s.rate);
  const [params] = useSearchParams();
  const { hash } = useLocation();
  const navigate = useNavigate();
  const emptyBase = change && (change.fromVersion === change.toVersion ||
    (current.timeline?.version === change.fromVersion && !hasCut) ||
    current.versions?.some(v => v.version === change.fromVersion && v.duration === 0));
  const approvalChange = useApprovalComparison(approval && !emptyBase ? change : undefined, spot);
  const comparisonChange = approval ? approvalChange : change;
  const pair = (comparisonChange ?? change)?.renders[spot];
  const [rejectedOriginal, rejectOriginal] = useState<string>();
  const head = cut ? current.project.head : null;
  const playable = !openingJoin && (draftVersion ? !!draft : source ? source.id !== rejectedOriginal || isPlayableMedia(source) : !!head);
  const monitor = useRef<HTMLDivElement>(null);
  // Whichever play button is on the monitor shows that its picture is loading, in place of its icon.
  const loading = usePictureWait(monitor);
  const cacheVersion = draftVersion ?? head ?? undefined;
  const cacheSource = source?.kind === "video" ? source.id : undefined;
  const selectedCache = usePlaybackCache(current.project, { version: draftVersion, mediaId: cacheSource, automatic: !!cacheSource && active, settingsRevision: current.renderSettingsRevision });
  const { cache } = cut ? workingCache : selectedCache;
  const displayedTimeline = draftVersion ? draft : current.timeline?.version === head ? current.timeline : null;
  const missingTimeline = !!cacheVersion && !displayedTimeline;
  const timelineFailed = draftVersion ? draftFailed : !!current.headError;
  const previewStrip = useMemo(() => {
    // The new head can arrive before its timeline. Its individual frames are still unknown during that read.
    if (missingTimeline) return timelineFailed ? undefined : null;
    if (!cacheVersion || cacheSource || IS_MOCK) return undefined;
    if (!cache) return null;
    return cache.renderId ? { id: cache.renderId, version: cacheVersion, fps: current.project.settings.fps } : undefined;
  }, [missingTimeline, timelineFailed, cacheVersion, cacheSource, cache, current.project.settings.fps]);
  const readyUrl = joined ? joined.file ?? (IS_MOCK ? api.renderFileUrl(joined.version) : undefined)
    : cache?.url ?? (IS_MOCK && draftVersion && draft ? api.renderFileUrl(draftVersion) : undefined);
  const selection = joined ? `joined:${joined.version}` : source?.id ?? cacheVersion;
  const displayed = useRef<{ selection?: string; url?: string }>(undefined);
  // A cache completing in the background must not replace a running decoder mid-sentence.
  const previous = displayed.current;
  const fullVideoUrl = playing && previous && previous.selection === selection && (cacheSource || !previous.url)
    ? previous.url : readyUrl;
  useLayoutEffect(() => { displayed.current = { selection, url: fullVideoUrl }; }, [selection, fullVideoUrl]);
  // Which player is on screen and why. A change here swaps the video element, which is a flicker if it happens mid-listen.
  const shownBy = openingJoin ? "join-opening" : fullVideoUrl ? "file" : joined ? "joined-stream" : draftVersion ? draft ? "version-stream" : "version-opening" : "player";
  const cacheState = cache?.state, joinedCacheState = joined?.cache;
  useEffect(() => {
    playbackLog("monitor", { shows: shownBy, selection, file: fullVideoUrl?.split("?")[0]?.split("/").slice(-2).join("/"), version: draftVersion, joined: joined?.version,
      cache: cacheState, joinedCache: joinedCacheState, heldFile: fullVideoUrl !== readyUrl || undefined, playing: usePlayerStore.getState().playing, at: usePlayerStore.getState().time });
  }, [shownBy, selection, fullVideoUrl, readyUrl, draftVersion, joined?.version, cacheState, joinedCacheState]);
  const settings = current.project.settings;
  const [decodedSource, setDecodedSource] = useState<{ id: string; aspect: number }>();
  const sourceAspect = source?.width && source.height ? source.width / source.height
    : decodedSource && decodedSource.id === source?.id ? decodedSource.aspect : undefined;
  const pictureAspect = sourceAspect ?? settings.width / settings.height;
  // Older imports may have no stored picture size. Use the selected source's own decoder as soon as it has it.
  const readSourceSize = source?.kind === "video" && (!source.width || !source.height)
    ? (event: React.SyntheticEvent<HTMLDivElement>) => {
      const video = event.target;
      if (video instanceof HTMLVideoElement && video.videoWidth && video.videoHeight) {
        const aspect = video.videoWidth / video.videoHeight;
        setDecodedSource(previous => previous?.id === source.id && previous.aspect === aspect ? previous : { id: source.id, aspect });
      }
    } : undefined;
  const cutDuration = useMemo(() => cut && current.timeline ? timelineDuration(current.timeline) : 0, [cut, current.timeline]);
  const proposedDuration = useMemo(() => draft ? timelineDuration(draft) : 0, [draft]);
  const duration = draftVersion ? proposedDuration : source?.duration || cutDuration || videoDuration;
  const fps = source?.fps || settings.fps;
  const lastFrame = Math.max(0, (Math.ceil(duration * fps - 1e-6) - 1) / fps);
  const reviewCut = !source ? simple.cutPlayback : undefined;
  const visible = useSyncExternalStore(onVisibility, documentVisible);
  const allowStandby = active && visible && !current.project.mediaPaused;
  // Retain the selected cut's edited decoder when switching to its original footage. Only the
  // active side owns the transport. Park the other at the lead-in so a replay needn't seek.
  type EditedSide = { joined: NonNullable<PreviewProps["joined"]>; url?: string };
  const comparison = useRef<{ key: string; revision?: number; before?: PreparedCut["before"]; after?: EditedSide }>(undefined);
  // Before the first call opens the queued preview can warm its decoder without taking the working transport.
  const canWarmNext = allowStandby && !source && (!playing || (!!reviewCut && playbackReady));
  const nextCut = canWarmNext ? simple.nextCutPlayback : undefined;
  useCutAudio(allowStandby && !!(reviewCut || nextCut));
  const pairKey = reviewCut?.key ?? nextCut?.key;
  const revision = current.renderSettingsRevision;
  const upcoming = useRef<{ revision?: number; plan: PreparedCut }>(undefined);
  const nextSelected = nextCut?.key === pairKey ? nextCut : upcoming.current?.plan.key === pairKey &&
    upcoming.current?.revision === revision ? upcoming.current?.plan : undefined;
  useLayoutEffect(() => { upcoming.current = nextCut && { revision, plan: nextCut }; }, [revision, nextCut]);
  const held = comparison.current?.key === pairKey && comparison.current?.revision === revision ? comparison.current : undefined;
  const beforeMedia = nextSelected?.before ?? held?.before;
  const currentAfter = reviewCut && joined ? joined : nextSelected?.after;
  const currentAfterUrl = reviewCut && joined ? reviewCut.afterFile ?? fullVideoUrl : nextSelected?.after.file;
  const editedSide = currentAfter ? { joined: currentAfter, url: currentAfterUrl } : held?.after;
  useLayoutEffect(() => {
    comparison.current = pairKey ? { key: pairKey, revision, before: beforeMedia, after: editedSide } : undefined;
  }, [pairKey, revision, beforeMedia, editedSide?.joined, editedSide?.url]);
  const pairTimeline = beforeMedia?.timeline ?? displayedTimeline;
  const pausedForJoin = !!openingJoin || (reviewCut?.side === "after" && !joined);
  const showBefore = reviewCut?.side === "before" && !pausedForJoin;
  const showAfter = reviewCut?.side === "after" && !pausedForJoin;
  const paired = reviewCut && pairTimeline && (showBefore || showAfter);
  const leadIn = reviewCut?.start ?? nextSelected?.before.start;
  const knownBeforeUrl = reviewCut?.beforeFile ?? beforeMedia?.file;
  const originalUrl = knownBeforeUrl ?? (reviewCut?.side === "before" ? fullVideoUrl : pairTimeline?.version === cacheVersion
    ? cache?.url ?? (IS_MOCK && draftVersion ? api.renderFileUrl(draftVersion) : undefined) : undefined);
  // The normal card opens on After. Keep just that decoder for the next decision while the
  // current comparison is ready. Its keyed layer becomes the selected layer on Down/Approve/Keep.
  const layers = [];
  if (pairKey && pairTimeline && leadIn !== undefined) {
    layers.push({ key: pairKey, before: pairTimeline, beforeUrl: originalUrl, beforeWindow: reviewCut?.beforeWindow ?? beforeMedia?.window,
      edited: editedSide, afterWindow: reviewCut?.afterWindow ?? nextSelected?.after.window, leadIn,
      showBefore, showAfter });
  }
  if (reviewCut && nextCut && nextCut.key !== pairKey) {
    layers.push({ key: nextCut.key, edited: { joined: nextCut.after, url: nextCut.after.file }, afterWindow: nextCut.after.window, leadIn: nextCut.before.start,
      showBefore: false, showAfter: false });
  }
  // A joined audition can play a different file with gaps skipped. Hovering
  // samples the version drawn on the timeline, including footage in those gaps.
  const originalHoverUrl = source?.kind === "video" && source.id !== rejectedOriginal && canPlayOriginal(source)
    ? api.mediaFileUrl(source.id) : undefined;
  const hoverVideoUrl = active && (cacheSource || (!source && displayedTimeline)) ? cache?.url ?? originalHoverUrl : undefined;
  const hoverVideo = hoverVideoUrl ? { url: hoverVideoUrl, lastFrame } : undefined;
  const frameAt = useCallback((t: number, exact?: boolean) => {
    const at = Math.min(t, lastFrame);
    return source ? scrubFrameUrl(source, null, current.media, at, exact)
      : cutFrameUrl(current.project, displayedTimeline, at, exact);
  }, [source, current.project, displayedTimeline, current.media, lastFrame]);
  const beforeRender = useProjectStore(s => selectRender(s.current, pair?.before));
  const applied = change?.state === "approved" && (change.appliedVersion ?? change.toVersion) === current.project.head;
  const missingBefore = !applied && !pair?.beforeRange && !beforeRender ? pair?.before : null;
  useEffect(() => { if (missingBefore) void useProjectStore.getState().ensureRender(missingBefore); }, [missingBefore]);
  const editRange = (!approval && !draftVersion && !applied ? pair?.beforeRange ?? beforeRender?.range : undefined) ?? pair?.range ?? change?.ranges[spot];
  const editStart = playFullCut ? 0 : cue?.time ?? resumeTime ?? (approval ? (approvalChange ?? change)?.ranges[spot]?.start ?? editRange?.start ?? 0 : editRange?.start);
  const beforeShown = useRef(false);
  const beforeClip = useRef<BeforePlayback>(null);
  // A click on the timeline outside the edit's passage stretches the passage to reach it, so the editor can hear
  // a little earlier or later and stay on the edit and its zoomed timeline. Choosing an edit again resets it.
  const [reach, setReach] = useState<{ request: number; range: TimeRange; at: number; playing: boolean; edit: string; spot: number; original: TimeRange }>();
  const selectedForReach = threadView?.selected;
  const reached = reach && selectedForReach && reach.request === threadView.request && reach.edit === selectedForReach.changeId
    && reach.spot === selectedForReach.spot && reach.original.start === selectedForReach.range.start
    && reach.original.end === selectedForReach.range.end ? reach : undefined;
  const shownPassage = useRef<TimeRange>(undefined);
  const seekFull = useCallback((t: number) => {
    const selected = threadView?.selected;
    const range = shownPassage.current;
    const at = Math.min(t, lastFrame);
    // Before plays its own clip, which runs the edit's passage and nothing past it. A point picked inside the passage,
    // on the timeline or by a skip with ← →, moves that clip and the edit stays on Before. Anywhere else, or until the
    // clip has opened, there is nothing of Before to show: the point is on After, which carries on as the clip was.
    // A reframe's Before is a still of the moment the playhead is on, so it stays on the side it was on.
    const onBefore = !!selected && beforeShown.current;
    if (onBefore && beforeClip.current?.seek(at)) return;
    const inside = !!range && at >= range.start && at <= range.end && !onBefore;
    if (selected && range && !inside) {
      if (!threadView.framing) setBeforeOf(undefined);
      setReach({ request: threadView.request, at, edit: selected.changeId, spot: selected.spot, original: selected.range,
        playing: onBefore ? !!beforeClip.current?.playing() : usePlayerStore.getState().playing,
        range: { start: Math.min(range.start, at), end: Math.min(lastFrame, Math.max(range.end, at + REACH_AFTER_SECONDS)) } });
      return;
    }
    // A point inside the passage is a plain seek, so it can be scrubbed. With no passage up there is nothing to
    // stretch: that is a cut still waiting for the version it plays on. The arrows and the timeline are the player's
    // all the same, and only Esc closes the cut, so the point is a plain seek too.
    player.seek(Math.min(t, lastFrame), true);
    if (draft || cut) player.prepare();
  }, [threadView, draft, cut, lastFrame]);
  // A drag on the timeline pauses what is playing until it ends. On Before that is the earlier version's clip. It is
  // held before the player is: the player's pause reaches the clip too, and would leave it stopped.
  const scrubStart = useCallback((gesture: AbortSignal) => {
    const held = beforeShown.current ? beforeClip.current?.scrub() : undefined;
    const release = pauseForScrub(gesture);
    if (!held) return release;
    return () => {
      release();
      // A drag that left the edit's passage ends on After, which goes on as the clip would have: playing if the clip
      // was, or had played to the passage's end and stopped there.
      if (beforeShown.current) held.carryOn();
      else if (held.playing) player.play();
    };
  }, []);
  const [selectedTime, setSelectedTime] = useState<number>();
  const atSelectedFrame = usePlayerStore(s => selectedTime !== undefined && Math.abs(selectedTime - s.time) < 0.5 / fps);
  useLayoutEffect(() => { setSelectedTime(undefined); }, [cacheVersion, source?.id]);
  const selectedFrameUrl = useMemo(() => selectedTime === undefined ? undefined
    : cutFrameUrl(current.project, displayedTimeline, selectedTime, true, true), [current.project, displayedTimeline, selectedTime]);
  const selectTime = (time: number, action: "offer" | "attach" = "offer") => {
    const at = Math.min(time, lastFrame);
    if (!source) setSelectedTime(at);
    // The point is on the timeline the player is on, which is the one before while the edit's new timeline is read.
    const point = editTargetAt(at, draftVersion ?? current.timeline?.version ?? current.project.head ?? undefined, displayedTimeline, source?.id);
    simple.onPick?.(point, action);
  };

  // The stretch marked for the message in the box, drawn while the timeline is the one it was marked on.
  const markedRange = useUiStore(s => markedRangeOf(s.agentContext));
  const rangeVersion = draftVersion ?? current.timeline?.version ?? current.project.head ?? undefined;
  const shownRange = useMemo(() => markedRange && markedRange.version === rangeVersion && markedRange.mediaId === source?.id
    ? { start: markedRange.start, end: markedRange.end } : undefined, [markedRange, rangeVersion, source?.id]);
  const markRange = (range: TimeRange | undefined) => {
    if (!range) return simple.onRange?.(undefined);
    const point = editTargetAt(range.start, rangeVersion, displayedTimeline, source?.id);
    simple.onRange?.({ start: range.start, end: range.end, version: rangeVersion, mediaId: source?.id, clipIds: point.clipIds });
  };

  useEffect(() => { if (!active) player.pause(); }, [active]);

  // The press that last played the change.
  const playedChange = useRef(playChange);
  useLayoutEffect(() => {
    if (editStart === undefined) return;
    player.pause();
    player.seek(editStart, !!cue);
    // A press waits for the change's version to be up, then plays it once. Anything else that brings the change up
    // again finds the press already spent, and leaves it paused.
    if (!playable) return;
    const pressed = playChange !== playedChange.current;
    playedChange.current = playChange;
    if ((playFullCut || pressed) && active) player.play();
  }, [change?.id, spot, editStart, cue, draft?.version, playFullCut, playChange]);

  const passage = simple.holdPassage ? undefined : reached?.range ?? threadView?.selected?.range;
  useLayoutEffect(() => { shownPassage.current = passage; }, [passage]);
  const framing = threadView?.framing;
  const cutReview = threadView?.cutReview;
  const selectedEdit = threadView?.selected;
  const originalChange = threadView?.originalChange;
  const original = useEditBefore(current.id, displayedTimeline, selectedEdit, originalChange, fps, !!framing);
  const cutIndex = cutReview && selectedEdit ? cutReview.cuts.indexOf(selectedEdit) : -1;
  // Before belongs to the edit that's open: it holds while that edit is played again from its top, and the next edit
  // opens on After.
  const selectedKey = selectedEdit && editKey(selectedEdit);
  const [beforeOf, setBeforeOf] = useState<string>();
  const before = !!selectedKey && !original.unavailable && beforeOf === selectedKey;
  useLayoutEffect(() => { setBeforeOf(undefined); }, [selectedKey]);
  // With no edit chosen, a passage stretched by a click outside the last one is gone too.
  // The next edit can carry the same request number, so a stretch left behind would play as its passage.
  useLayoutEffect(() => { if (!selectedEdit) setReach(undefined); }, [selectedEdit]);
  const playingBefore = before && !framing;
  useLayoutEffect(() => { beforeShown.current = playingBefore; }, [playingBefore]);
  const overlay = playingBefore ? "before-clip" : framing ? "framing" : undefined;
  const overlaid = useRef<string>(undefined);
  useEffect(() => {
    // Before and a framing preview play their own clip over the monitor.
    if (overlay !== overlaid.current) playbackLog("monitor overlay", { shows: overlay ?? "none", edit: selectedEdit?.changeId, at: usePlayerStore.getState().time });
    overlaid.current = overlay;
  }, [overlay, selectedEdit?.changeId]);
  const after = useCallback(() => setBeforeOf(undefined), []);
  // An edit that moves nothing (a level, a title, a reframe) keeps the clock, so its Before sound can be drawn
  // on the same timeline. Both sides share one waveform scale.
  const sameClockBefore = selectedEdit && !selectedEdit.beforeCut && !framing && original.timeline && original.duration != null && duration
    && Math.abs(original.duration - duration) < 1 / fps ? original.timeline : undefined;
  function stepCut(delta: number) {
    const next = cutReview?.cuts[cutIndex + delta];
    if (next) threadView?.choose(next);
  }
  const editCompare = <BeforeToggle on={before} shortcutActive={active && !simple.holdPassage} toggle={() => {
    player.pause();
    setBeforeOf(before ? undefined : selectedKey);
  }} />;
  // Choosing an edit plays its passage, and a click outside it carries on as it was. Anything else that sets the
  // passage up again (a panel closing, a new working edit, the video's length arriving) leaves the playhead where
  // it is, and paused if the editor paused it.
  const played = useRef<{ chosen: string; reached?: typeof reached }>(undefined);
  useLayoutEffect(() => {
    // Before plays a clip of its own and a framing preview holds a still frame. Back on After, the passage plays from its top.
    // A framing preview stretched by a skip or a click outside it goes on from that point, as any edit's passage does.
    if (!passage || playingBefore || (framing && !reached)) played.current = undefined;
    if ((playingBefore || (framing && !reached)) && simple?.heard) simple.heard.current = undefined;
    if (!passage || !active || !playable || !duration) return;
    // The clip moves the playhead as it plays. The player under it waits, and takes up from the playhead afterwards.
    if (playingBefore) return player.lendPlayhead({ pause: () => beforeClip.current?.pause() });
    if (framing && !reached) {
      const at = framing.cue ?? usePlayerStore.getState().time;
      return player.previewRange(passage, fps, at >= passage.start && at < passage.end ? at : passage.start);
    }
    // An edit goes by its first version: a revision that lands under it is still the passage the editor chose.
    const first = selectedEdit?.previous[0] ?? selectedEdit;
    const chosen = `${first?.changeId}/${first?.spot}/${threadView?.request}`;
    const again = played.current ? played.current.chosen === chosen && (!reached || played.current.reached === reached) : !reached && simple?.heard?.current === chosen;
    played.current = { chosen, reached };
    if (simple?.heard) simple.heard.current = chosen;
    if (reached) {
      const release = player.previewRange(passage, fps, reached.at, again);
      // A drag holds the video paused until it ends, and its release carries on as it was. The store still says
      // "playing" for the moment after the press paused it, so the stretch must not start it under the held pointer.
      if (!again && reached.playing && !usePlayerStore.getState().scrubGesture) player.play();
      return release;
    }
    return player.previewRange(passage, fps, undefined, again);
  }, [threadView?.request, passage?.start, passage?.end, framing?.beforeVersion, framing?.cue, playingBefore, selectedEdit?.at, active, playable, fps, selection, duration, reached]);

  // Decode the selected edit's paused frame, including effects and overlays.
  const editedVersion = draft?.version ?? head;
  useLayoutEffect(() => {
    if (active && change && editedVersion) player.prepare();
  }, [active, change?.id, editedVersion, spot, cue]);

  const noteId = params.get("note");
  const linkedNotes = useMemo(() => noteId ? current.notes.filter(n => n.id === noteId) : undefined, [noteId, current.notes]);
  const notePosition = useNotePositions(displayedTimeline, linkedNotes, fps);
  const linkedTime = noteId ? notePosition.times.get(noteId) : undefined;
  useEffect(() => {
    const t = noteId ? linkedTime : params.get("t");
    if (t == null || !Number.isFinite(Number(t))) return;
    if (draftVersion && !draft && !draftFailed) return;
    player.seek(Number(t));
    // A stream shows the frame it opened on until it is asked for another: ask for the one at this moment.
    if (draft || cut) player.prepare();
    // The way back from Settings carries the speed the editor was watching at, with their place.
    const speed = Number(params.get("speed"));
    if (RATES.some(rate => rate.value === speed)) player.setRate(speed);
    const next = new URLSearchParams(params);
    next.delete("note");
    next.delete("t");
    next.delete("speed");
    next.delete("resumeSource");
    navigate({ search: next.toString(), hash }, { replace: true });
  }, [params, hash, navigate, noteId, linkedTime, draftVersion, draft, draftFailed, cut]);

  useHotkeys((e) => {
    if (!active || useUiStore.getState().notePopover) return;
    if (cutReview && handleCutArrow(e, stepCut)) return;
    if (e.key === " ") {
      if (playingBefore) return;
      e.preventDefault();
      // Held down, Space is one press: its repeats would flutter between play and pause.
      if (playable && !e.repeat) player.toggle();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      if (!playable || duration <= 0) return;
      const target = Math.max(0, Math.min(lastFrame, arrowSeekTime(usePlayerStore.getState().time, e.key, e.shiftKey)));
      seekFull(target);
      selectTime(target);
    } else if (e.key.toLowerCase() === "n" && simple) {
      e.preventDefault();
      // Held down, N is one press too: it has already picked the moment and asked for the cursor.
      if (e.repeat) return;
      player.pause();
      if (playable && duration > 0) selectTime(usePlayerStore.getState().time, "attach");
      useUiStore.getState().focusComposer();
    }
  });
  const preparing = current.media.find(isPreparingMedia);

  const stage = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const sync = () => setExpanded(document.fullscreenElement === stage.current);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    document.addEventListener("fullscreenchange", sync);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      window.removeEventListener("keydown", escape);
    };
  }, []);
  const lastWriteRequest = useRef(simple.writeRequest);
  useEffect(() => {
    if (simple.writeRequest === lastWriteRequest.current) return;
    lastWriteRequest.current = simple.writeRequest;
    setExpanded(false);
    if (document.fullscreenElement === stage.current) void document.exitFullscreen().catch(() => {});
  }, [simple.writeRequest]);
  // Leave the comparison when its decision returns the editor to the thread list.
  const previousChange = useRef(change?.id);
  useEffect(() => {
    if (previousChange.current && !change && expanded) {
      setExpanded(false);
      if (document.fullscreenElement === stage.current) void document.exitFullscreen().catch(() => {});
    }
    previousChange.current = change?.id;
  }, [change?.id, expanded]);
  async function toggleFullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (expanded) setExpanded(false);
    else if (document.fullscreenEnabled && stage.current?.requestFullscreen) {
      try { await stage.current.requestFullscreen(); } catch { setExpanded(true); }
    } else setExpanded(true);
  }
  const view = draftVersion ? "Proposed edit" : source ? "Source preview" : hasCut ? "Working edit" : "Footage";

  return (
    <section ref={stage} className="cut-preview" aria-label={view} data-expanded={expanded || undefined}>
      <AmbientLight stage={stage} monitor={monitor} />
      <div className="watch-viewport">
        <div ref={monitor} className="watch-monitor" data-landscape={pictureAspect > 1 || undefined}
          style={{ "--picture-aspect": pictureAspect } as CSSProperties}
          onLoadedMetadataCapture={readSourceSize}>
          {layers.map(({ key, before, beforeUrl, beforeWindow, edited, afterWindow, leadIn, showBefore, showAfter }) => <div key={key} className="absolute inset-0"
            inert={!showBefore && !showAfter} data-parked={(!showBefore && !showAfter) || undefined}
            style={{ isolation: "isolate", zIndex: showBefore || showAfter ? 0 : -1 }} aria-hidden={(!showBefore && !showAfter) || undefined}>
            {before && (showBefore || allowStandby) && <div className="absolute inset-0 bg-black" inert={!showBefore} data-parked={!showBefore || undefined}
              style={{ zIndex: showBefore ? 1 : 0 }} aria-hidden={!showBefore || undefined}>
              <CutSide project={current.project} timeline={before} url={beforeUrl} window={beforeWindow}
                label={draftVersion ? "Proposed draft" : "The current edit"} fps={settings.fps} active={active} parkedAt={!showBefore ? leadIn : undefined} />
            </div>}
            {edited && (showAfter || allowStandby) && <div className="absolute inset-0 bg-black" inert={!showAfter} data-parked={!showAfter || undefined}
              style={{ zIndex: showAfter ? 1 : 0 }} aria-hidden={!showAfter || undefined}>
              <CutSide key={edited.joined.version} project={current.project} timeline={edited.joined.timeline} url={edited.url} window={afterWindow}
                joins={edited.joined.clock} label={edited.url ? "The current edit" : "Proposed draft"} fps={settings.fps} active={active}
                parkedAt={!showAfter ? edited.joined.clock.toMedia(leadIn) : undefined} />
            </div>}
            {!showBefore && !showAfter && <div className="absolute inset-0 z-10 bg-black" />}
          </div>)}
          {!paired && (openingJoin || (draftVersion && !draft && !fullVideoUrl && !joined) ? <div className="absolute inset-0 grid place-content-center gap-2 text-sm text-muted" role="status">
            {draftFailed ? <>Couldn’t open this version.<button className="btn-ghost" onClick={onRetryDraft}>Retry</button></>
              : !openingJoin && "Opening the suggestion…"}
          </div> : fullVideoUrl ? <CachedVideo key={fullVideoUrl} url={fullVideoUrl} label={source?.name ?? (draftVersion ? "Proposed draft" : "The current edit")}
            hidden={false} active={active} autoPlay={!!source && autoPlaySource} joins={joined?.clock} />
          : joined ? <div className="absolute inset-0">
            <CutStream key={joined.version} project={current.project} timeline={joined.timeline} version={joined.version} joins={joined.clock} proposed onStart={noop} />
          </div> : draftVersion && draft ? <div className="absolute inset-0">
            <CutStream project={current.project} timeline={draft} version={draftVersion} proposed onStart={noop} />
          </div> : !source && !cut && !change && (pendingImports > 0 || preparing) ? <ImportPreview projectId={current.id} preparing={preparing} onMedia={onMedia} />
            : <Player key={source ? `source-${source.id}` : head ?? "cut"} source={source} autoPlaySource={autoPlaySource} cut={cut} hidden={false}
            active={active} rejectedOriginal={rejectedOriginal} onRejectOriginal={rejectOriginal} onMedia={onMedia} />)}
          {atSelectedFrame && selectedTime !== undefined && selectedFrameUrl &&
            <SelectedCutFrame key={JSON.stringify([fullVideoUrl, selectedFrameUrl])} time={selectedTime} url={selectedFrameUrl} fps={fps} />}
          {simple.label && <div className="simple-on-video" role="status">{simple.label}</div>}
          {playingBefore && originalChange && selectedEdit ? <EditBeforePreview key={threadView?.request}
            change={originalChange} original={original} passage={selectedEdit.range} active={active} aspect={pictureAspect} loading={loading}
            clock={<PlayerTime end={duration} coarse />} playbackRef={beforeClip} />
            : framing && displayedTimeline ? <FramingPreview
            key={JSON.stringify([selection, threadView?.threadId, threadView?.selected?.changeId, threadView?.request])}
            project={current.project} timeline={displayedTimeline} original={original} duration={duration} before={before} loading={loading} coarse onAfter={after} />
            : (source || cut || change || draftVersion) && <MonitorPlayback playing={playing} playable={playable} loading={loading || (!!openingJoin && !draftFailed)}
            onToggle={() => player.toggle()}>
            <PlayerTime end={duration} coarse />
          </MonitorPlayback>}
          {(source || cut || change || draftVersion) && <div className="monitor-controls">
            {/* Picking a speed hands the keys back to the page, so the arrows go on stepping through edits. */}
            <PreferenceSelect compact label="Playback speed" options={RATES} value={rate} valueLabel={`${rate}×`} disabled={!playable}
              onChange={value => player.setRate(value)} onClose={() => (document.activeElement as HTMLElement | null)?.blur()} />
            <button className="btn-icon" onClick={e => { if (e.detail) e.currentTarget.blur(); void toggleFullscreen(); }} aria-label={expanded ? "Exit full screen" : "Full screen"} title={expanded ? "Exit full screen" : "Full screen"}>
              <Icon name="fullscreen" size={15} />
            </button>
          </div>}
        </div>
      </div>
      {(source || cut || change || draftVersion) && <div className="cut-transport">
        {selectedEdit && simple.compareHost && !original.unavailable && createPortal(editCompare, simple.compareHost)}
        {selectedEdit && simple.compareHost === undefined && <div className="thread-review-tools">
          <p className="timeline-edit-description" role="status">{selectedEdit.label}</p>
          {!original.unavailable && editCompare}
        </div>}
        {simple.above}
        <div>
          <PlayerTimeline activeShortcuts={active} duration={duration} pictureAspect={pictureAspect} previewStrip={previewStrip} hoverVideo={hoverVideo}
            waveform={{ media: current.media, mediaPaused: current.project.mediaPaused, source, timeline: displayedTimeline, ...sameClockBefore && {
              audioFrom: playingBefore ? sameClockBefore : undefined, scaleWith: playingBefore ? displayedTimeline : sameClockBefore } }} frameAt={frameAt} onSeek={seekFull} onSelectTime={selectTime} onScrubStart={scrubStart}
            range={simple.onRange ? shownRange : undefined} onRange={simple.onRange ? markRange : undefined} fps={fps}
            marks={simple.marks} gaps={simple.gaps} skippedRanges={simple.skippedRanges} onGap={simple.onGap} onBand={simple.onBand}
            highlight={simple.focus ?? (selectedEdit ? editFocus(selectedEdit, duration) : undefined)} />
        </div>
      </div>}
    </section>
  );
}
