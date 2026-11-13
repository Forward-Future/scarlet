import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import type { ThreadEdit } from "@scarlet/shared";
import { isPlayableMedia, timelineDuration, type Change, type MediaAsset, type TimeRange, type Timeline } from "@scarlet/timeline";
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
import { editTargetAt, useUiStore, type AgentContext } from "../stores/ui";
import { Icon } from "../components/ui/primitives";
import { PreferenceSelect } from "../components/ui/PreferenceSelect";
import { CachedVideo } from "../components/player/CachedVideo";
import { MonitorPlayback, PlayerTime } from "../components/player/MonitorPlayback";
import { usePictureWait } from "../components/player/usePictureWait";
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
import { FramingPreview } from "../components/review/FramingPreview";
import { useNotePositions } from "../lib/useNotePositions";
import type { ProgressFocus } from "../components/player/SimpleProgress";
import { editFocus } from "../lib/editKind";
import { editKey } from "../lib/keptEdits";

const noop = () => {};

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
    const decoded = () => !!video && !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - time) < 0.5 / fps;
    if (decoded()) { setNeeded(false); return; }
    // A local file or buffered fragment often wins the race against a JPEG.
    // An unbuffered edit fragment must first render; request its exact still now.
    const buffered = video?.buffered;
    const missingFragment = video?.currentSrc.startsWith("blob:") && buffered &&
      !Array.from({ length: buffered.length }, (_, i) => i).some(i => buffered.start(i) <= time && time < buffered.end(i));
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
  simple: { marks: TimelineDot[]; focus?: ProgressFocus; label?: string; compareHost?: HTMLElement | null; above?: ReactNode;
    gaps?: TimelineGap[]; skippedRanges?: TimeRange[]; onGap?(gap: TimelineGap, time: number): void;
    /** A click inside the shaded passage, when the playing side steps over it. */
    onBand?(time: number): void;
    /** Timeline navigation offers the point to the composer. N attaches it explicitly. */
    onPick?(point: AgentContext, action: "offer" | "attach"): void;
    /** The chosen edit is about to play on another version: don't start its passage on this one meanwhile. */
    holdPassage?: boolean;
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

export function CutPreview({ threadView, workingCache, draftVersion, draft, draftFailed, onRetryDraft, source, autoPlaySource, hasCut, change, spot, cue, approval = false, playChange, playFullCut = false, active,
  onMedia, resumeTime, simple, joined }: PreviewProps) {
  const current = useProjectStore(useShallow(s => {
    if (!s.current) return null;
    const { id, project, media, timeline, notes, versions, renderSettingsRevision } = s.current;
    return { id, project, media, timeline, notes, versions, renderSettingsRevision };
  }))!;
  const pendingImports = useImportCount(current.id);
  const cut = hasCut && !source && !draftVersion;
  const videoDuration = usePlayerStore((s) => s.duration);
  const playing = usePlayerStore((s) => s.playing);
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
  const playable = draftVersion ? !!draft : source ? source.id !== rejectedOriginal || isPlayableMedia(source) : !!head;
  const monitor = useRef<HTMLDivElement>(null);
  // Whichever play button is on the monitor shows that its picture is loading, in place of its icon.
  const loading = usePictureWait(monitor);
  const cacheVersion = draftVersion ?? head ?? undefined;
  const cacheSource = source?.kind === "video" ? source.id : undefined;
  const selectedCache = usePlaybackCache(current.project, { version: draftVersion, mediaId: cacheSource, automatic: !!cacheSource && active, settingsRevision: current.renderSettingsRevision });
  const { cache } = cut ? workingCache : selectedCache;
  const previewStrip = useMemo(() => {
    if (!cacheVersion || cacheSource || IS_MOCK) return undefined;
    if (!cache) return null;
    return cache.renderId ? { id: cache.renderId, version: cacheVersion, fps: current.project.settings.fps } : undefined;
  }, [cacheVersion, cacheSource, cache, current.project.settings.fps]);
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
  const shownBy = fullVideoUrl ? "file" : joined ? "joined-stream" : draftVersion ? draft ? "version-stream" : "version-opening" : "player";
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
  const displayedTimeline = draftVersion ? draft : current.timeline?.version === head ? current.timeline : null;
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
  const [reach, setReach] = useState<{ request: number; range: TimeRange; at: number; playing: boolean }>();
  const reached = reach && threadView?.selected && reach.request === threadView.request ? reach : undefined;
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
      setReach({ request: threadView.request, at, playing: onBefore ? !!beforeClip.current?.playing() : usePlayerStore.getState().playing,
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
    const again = played.current ? played.current.chosen === chosen && played.current.reached === reached : !reached && simple?.heard?.current === chosen;
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
          {fullVideoUrl ? <CachedVideo key={fullVideoUrl} url={fullVideoUrl} label={source?.name ?? (draftVersion ? "Proposed draft" : "The current edit")}
            hidden={false} active={active} autoPlay={!!source && autoPlaySource} joins={joined?.clock} />
          : joined ? <div className="absolute inset-0">
            <CutStream key={joined.version} project={current.project} timeline={joined.timeline} version={joined.version} joins={joined.clock} proposed onStart={noop} />
          </div> : draftVersion ? <div className="absolute inset-0">
            {draft ? <CutStream project={current.project} timeline={draft} version={draftVersion} proposed onStart={noop} />
              : <div className="absolute inset-0 grid place-content-center gap-2 text-sm text-muted" role="status">
                {draftFailed ? <>Couldn’t open this version.<button className="btn-ghost" onClick={onRetryDraft}>Retry</button></> : "Opening the suggestion…"}
              </div>}
          </div> : !source && !cut && !change && (pendingImports > 0 || preparing) ? <ImportPreview projectId={current.id} preparing={preparing} onMedia={onMedia} />
            : <Player key={source ? `source-${source.id}` : head ?? "cut"} source={source} autoPlaySource={autoPlaySource} cut={cut} hidden={false}
            active={active} rejectedOriginal={rejectedOriginal} onRejectOriginal={rejectOriginal} onMedia={onMedia} />}
          {atSelectedFrame && selectedTime !== undefined && selectedFrameUrl &&
            <SelectedCutFrame key={JSON.stringify([fullVideoUrl, selectedFrameUrl])} time={selectedTime} url={selectedFrameUrl} fps={fps} />}
          {simple.label && <div className="simple-on-video" role="status">{simple.label}</div>}
          {playingBefore && originalChange && selectedEdit ? <EditBeforePreview key={threadView?.request}
            change={originalChange} original={original} passage={selectedEdit.range} active={active} aspect={pictureAspect} loading={loading}
            clock={<PlayerTime end={duration} coarse />} playbackRef={beforeClip} />
            : framing && displayedTimeline ? <FramingPreview
            key={JSON.stringify([selection, threadView?.threadId, threadView?.selected?.changeId, threadView?.request])}
            project={current.project} timeline={displayedTimeline} original={original} duration={duration} before={before} loading={loading} coarse onAfter={after} />
            : (source || cut || change || draftVersion) && <MonitorPlayback playing={playing} playable={playable} loading={loading}
            onToggle={() => player.toggle()}>
            <PlayerTime end={duration} coarse />
          </MonitorPlayback>}
          {(source || cut || change || draftVersion) && <div className="monitor-controls">
            {/* Picking a speed hands the keys back to the page, so the arrows go on stepping through edits. */}
            <PreferenceSelect compact label="Playback speed" options={RATES} value={rate} valueLabel={`${rate}×`} disabled={!playable}
              onChange={value => { player.setRate(value); (document.activeElement as HTMLElement | null)?.blur(); }} />
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
            marks={simple.marks} gaps={simple.gaps} skippedRanges={simple.skippedRanges} onGap={simple.onGap} onBand={simple.onBand}
            highlight={simple.focus ?? (selectedEdit ? editFocus(selectedEdit, duration) : undefined)} />
        </div>
      </div>}
    </section>
  );
}
