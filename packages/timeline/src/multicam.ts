/**
 * Pure multi-camera & multi-audio timeline assembly and sync-preserving camera
 * angle switching. Scarlet measures offsets/drift and builds or switches tracks
 * safely here; editorial taste (when and why to switch) lives in a skill.
 *
 * Layout:
 * - `v1` ("Program"): the active visible video track. Only this track renders,
 *   so transitions, framing, brief-picture checks, thumbnails and direct-picture
 *   export all work at full speed without multi-stream decode.
 * - `mc_1`, `mc_2`, ... (hidden, muted video tracks): one full synced reference
 *   track per camera angle. Global `rippleDelete` (such as `/dialogue-pass`)
 *   cuts every angle track in exact lockstep with Program and Audio, so switching
 *   or re-switching angles remains exact and non-destructive before or after
 *   dialogue cuts.
 * - `a1`, `a2`, ... (dedicated audio tracks): every audible audio layer (separate
 *   microphones, master mix, or an explicitly audible camera) plus optional muted
 *   backup tracks. All video tracks stay silent (`volume: 0`) so camera switches
 *   never interrupt, clip, or double sound.
 */
import { detachedAudioClip, makeMediaClip, makeTrack } from "./builders.js";
import { newId } from "./ids.js";
import { applyOps, splitClip, trimHead, trimTail, type TimelineOp } from "./ops.js";
import { plays } from "./audible.js";
import type { AudioTrackSelection, MediaAsset } from "./mediaSchema.js";
import type { TimeRange } from "./schemaBase.js";
import { Timeline as TimelineSchema, type MediaClip, type Timeline, type Track } from "./timelineSchema.js";
import { carriesAudio, clipEnd, snapToFrame, sourceAt, timelineDuration, uniqueId } from "./time.js";

const EPS = 1e-6;
const MEET = 1e-3;

export interface SyncSegment {
  /** Source start in this recording (seconds; defaults to 0). */
  sourceIn?: number;
  /** Source end in this recording (seconds; defaults to duration). */
  sourceOut?: number;
  /**
   * Reference-clock offset (seconds): `refTime = offset + sourceTime / speed`.
   * Matches `audio_sync`'s `secondaryStartRelativeToReference` (and drift `offsetAtStart`).
   */
  offset: number;
  /** Clock-drift compensation speed (default 1, e.g. `audio_sync`'s `secondarySpeed`). */
  speed?: number;
}

export interface MulticamCameraInput {
  mediaId: string;
  duration: number;
  /** Display name for the angle track (e.g. "Wide", "Host", or file name). */
  name?: string;
  /** Reference-clock offset in seconds (negative = started earlier). Ignored when `segments` is supplied. */
  offset?: number;
  /** Optional clock-drift compensation speed (default 1). Ignored when `segments` is supplied. */
  speed?: number;
  /** Optional multi-part synced placements (for `audio_sync` step fits). */
  segments?: SyncSegment[];
  /** Place this camera's own audio on a dedicated audible audio track (default false when separate audio exists). */
  audible?: boolean;
  /** Linear gain when `audible` is true (default 1). */
  volume?: number;
  audioTrack?: AudioTrackSelection;
  /** Whether this camera asset carries audio (default true). */
  hasAudio?: boolean;
}

export interface MulticamAudioInput {
  mediaId: string;
  duration: number;
  /** Display name for the audio track (e.g. "Host mic", "Guest mic", "Master mix"). */
  name?: string;
  /** Reference-clock offset in seconds (negative = started earlier). */
  offset?: number;
  /** Optional clock-drift compensation speed (default 1). */
  speed?: number;
  /** Optional multi-part synced placements (for `audio_sync` step fits). */
  segments?: SyncSegment[];
  /** Include in the audible mix (default true; false keeps it synced on a muted track). */
  audible?: boolean;
  /** Linear gain (default 1). */
  volume?: number;
  audioTrack?: AudioTrackSelection;
}

export interface MulticamBuildOptions {
  /** Camera `mediaId` placed initially on Program (`v1`). Defaults to the first camera. */
  initialCameraId?: string;
  /** Timeline name (default "Main"). */
  name?: string;
  /**
   * How timeline 0 is anchored relative to the reference clock:
   * - `"reference"` (default): timeline 0 = reference 0; footage before ref 0 is trimmed cleanly.
   * - `"overlap"`: trims head/tail to the common overlap where all cameras and audible audio roll together.
   * - `"earliest"`: timeline 0 = earliest start across all synced layers (keeps full head/tail of every recording).
   */
  align?: "reference" | "overlap" | "earliest";
  /** Optional reference-clock keep ranges to assemble instead of the full recordings. */
  keep?: Array<{ start: number; end: number; label?: string }>;
  /** Optional audio fade in/out in seconds on assembled keep-range audio clips. */
  crossfade?: number;
}

export interface LayerCoverage {
  mediaId: string;
  trackId: string;
  name: string;
  clips: number;
  /** Timeline intervals covered by this layer. */
  ranges: TimeRange[];
  coveredSeconds: number;
  audible: boolean;
  speed?: number;
}

export interface MulticamBuildResult {
  timeline: Timeline;
  programTrackId: string;
  initialCameraId: string;
  align: "reference" | "overlap" | "earliest";
  /** Reference-clock second that lands at timeline 0 (when `keep` is not given). */
  origin: number;
  duration: number;
  cameras: LayerCoverage[];
  audio: LayerCoverage[];
}

interface NormalizedPiece {
  sourceIn: number;
  sourceOut: number;
  /** Start and end on the reference clock. */
  refStart: number;
  refEnd: number;
  offset: number;
  speed: number;
}

function normalizeSegments(duration: number, offset = 0, speed = 1, segments?: SyncSegment[]): NormalizedPiece[] {
  if (!(duration > 0) || !Number.isFinite(duration)) throw new Error("Each synced recording must have a positive duration.");
  const raw: SyncSegment[] = segments?.length ? segments : [{ sourceIn: 0, sourceOut: duration, offset, speed }];
  const pieces: NormalizedPiece[] = [];
  for (const seg of raw) {
    const s = seg.speed ?? 1;
    if (!(s > 0) || !Number.isFinite(s)) throw new Error(`Invalid playback speed ${s}.`);
    if (!Number.isFinite(seg.offset)) throw new Error(`Invalid sync offset ${seg.offset}.`);
    const sIn = Math.max(0, Math.min(duration, seg.sourceIn ?? 0));
    const sOut = Math.max(0, Math.min(duration, seg.sourceOut ?? duration));
    if (sOut <= sIn + EPS) continue;
    let refStart = seg.offset + sIn / s;
    const refEnd = seg.offset + sOut / s;
    let adjIn = sIn;
    // Clamp step-fit transitions so consecutive pieces never overlap on the same track.
    const prev = pieces.at(-1);
    if (prev && refStart < prev.refEnd) {
      const shift = prev.refEnd - refStart;
      refStart = prev.refEnd;
      adjIn = sIn + shift * s;
      if (sOut <= adjIn + EPS) continue;
    }
    pieces.push({ sourceIn: adjIn, sourceOut: sOut, refStart, refEnd, offset: seg.offset, speed: s });
  }
  return pieces;
}

function placePieces(
  mediaId: string,
  pieces: readonly NormalizedPiece[],
  windows: ReadonlyArray<{ start: number; end: number; label?: string }>,
  extra: { volume: number; crossfade?: number; audioTrack?: AudioTrackSelection; label?: string },
): MediaClip[] {
  const clips: MediaClip[] = [];
  const xf = extra.crossfade ?? 0;
  let cursor = 0;
  for (const win of windows) {
    const len = win.end - win.start;
    if (len <= EPS) continue;
    for (const p of pieces) {
      const lo = Math.max(win.start, p.refStart);
      const hi = Math.min(win.end, p.refEnd);
      if (hi - lo <= EPS) continue;
      const sourceIn = p.sourceIn + (lo - p.refStart) * p.speed;
      const sourceOut = p.sourceIn + (hi - p.refStart) * p.speed;
      if (sourceOut - sourceIn <= EPS) continue;
      const timelineIn = cursor + (lo - win.start);
      const dur = (sourceOut - sourceIn) / p.speed;
      const fade = extra.volume > 0 && xf > 0 ? Math.min(xf, dur / 2) : 0;
      clips.push(makeMediaClip(mediaId, sourceIn, sourceOut, timelineIn, {
        speed: p.speed,
        volume: extra.volume,
        audioFadeIn: fade,
        audioFadeOut: fade,
        ...(extra.audioTrack !== undefined && { audioTrack: extra.audioTrack }),
        ...((win.label ?? extra.label) && { label: win.label ?? extra.label }),
      }));
    }
    cursor += len;
  }
  return clips;
}

function summarizeCoverage(mediaId: string, trackId: string, name: string, clips: readonly MediaClip[], audible: boolean): LayerCoverage {
  const ranges: TimeRange[] = [];
  let coveredSeconds = 0;
  for (const c of clips) {
    const start = round3(c.timelineIn);
    const end = round3(clipEnd(c));
    coveredSeconds += clipEnd(c) - c.timelineIn;
    const prev = ranges.at(-1);
    if (prev && Math.abs(prev.end - start) <= MEET) prev.end = end;
    else ranges.push({ start, end });
  }
  const speed = clips[0]?.speed !== undefined && Math.abs(clips[0].speed - 1) > 1e-6 ? clips[0].speed : undefined;
  return { mediaId, trackId, name, clips: clips.length, ranges, coveredSeconds: round3(coveredSeconds), audible, ...(speed !== undefined && { speed }) };
}

/**
 * Build a synced multi-camera & multi-audio timeline.
 * Video cameras go on hidden synced angle tracks (`mc_1`, `mc_2`, ...) with `v1` ("Program")
 * showing `initialCameraId`; audible sources (separate audio layers and/or explicitly audible
 * cameras) go on dedicated audio tracks (`a1`, `a2`, ...) so switching angles never breaks audio.
 */
export function buildMulticamTimeline(
  projectId: string,
  cameras: readonly MulticamCameraInput[],
  audio: readonly MulticamAudioInput[] = [],
  opts: MulticamBuildOptions = {},
): MulticamBuildResult {
  if (!cameras.length) throw new Error("Provide at least one camera video recording.");
  if (cameras.length + audio.length < 2) throw new Error("Provide at least two recordings to sync (cameras and/or separate audio layers).");
  const seenCam = new Set<string>();
  for (const c of cameras) {
    if (seenCam.has(c.mediaId)) throw new Error(`Camera ${c.mediaId} is listed more than once.`);
    seenCam.add(c.mediaId);
  }
  const seenAudio = new Set<string>();
  for (const a of audio) {
    if (seenAudio.has(a.mediaId)) throw new Error(`Audio layer ${a.mediaId} is listed more than once.`);
    seenAudio.add(a.mediaId);
  }

  const initialCameraId = opts.initialCameraId ?? cameras[0]!.mediaId;
  if (!cameras.some(c => c.mediaId === initialCameraId)) {
    throw new Error(`initialCameraId ${initialCameraId} must be one of the cameras.`);
  }

  const cameraPieces = cameras.map(c => ({ input: c, pieces: normalizeSegments(c.duration, c.offset, c.speed, c.segments) }));
  const audioPieces = audio.map(a => ({ input: a, pieces: normalizeSegments(a.duration, a.offset, a.speed, a.segments) }));

  // Decide which audio sources are audible:
  // - Separate audio layers default to audible unless explicitly muted (`audible: false`).
  // - Cameras default to muted scratch audio (`audible: false`), EXCEPT when there are no audible
  //   separate audio layers and no camera explicitly set `audible: true`: then the first camera
  //   carrying audio defaults to audible so the synced edit isn't accidentally silent.
  const hasExplicitAudibleAudio = audio.some(a => a.audible !== false);
  const hasExplicitAudibleCamera = cameras.some(c => c.audible === true);
  const fallbackAudibleCamId = !hasExplicitAudibleAudio && !hasExplicitAudibleCamera
    ? cameras.find(c => c.hasAudio !== false && c.audible !== false)?.mediaId
    : undefined;
  const cameraAudible = (c: MulticamCameraInput) => c.audible === true || c.mediaId === fallbackAudibleCamId;

  const align = opts.align ?? "reference";
  let windows: Array<{ start: number; end: number; label?: string }>;
  let origin = 0;

  if (opts.keep?.length) {
    for (const [i, k] of opts.keep.entries()) {
      if (!(k.end > k.start)) throw new Error(`keep[${i}]: end (${k.end}) must be greater than start (${k.start}).`);
    }
    windows = opts.keep;
    origin = opts.keep[0]!.start;
  } else {
    const allSpans = [
      ...cameraPieces.filter(x => x.pieces.length).map(x => ({ start: x.pieces[0]!.refStart, end: x.pieces.at(-1)!.refEnd, required: true })),
      ...audioPieces.filter(x => x.pieces.length).map(x => ({ start: x.pieces[0]!.refStart, end: x.pieces.at(-1)!.refEnd, required: x.input.audible !== false })),
    ];
    if (!allSpans.length) throw new Error("None of the synced recordings have positive duration.");
    const earliest = Math.min(...allSpans.map(s => s.start));
    const latest = Math.max(...allSpans.map(s => s.end));
    if (align === "earliest") {
      origin = earliest;
      windows = [{ start: earliest, end: latest }];
    } else if (align === "overlap") {
      const required = allSpans.filter(s => s.required);
      const start = Math.max(...required.map(s => s.start));
      const end = Math.min(...required.map(s => s.end));
      if (!(end > start + EPS)) {
        throw new Error("The synced cameras and audible audio tracks have no common overlap window. Use align 'reference' or 'earliest' instead.");
      }
      origin = start;
      windows = [{ start, end }];
    } else {
      // "reference": timeline 0 is reference source 0.
      origin = 0;
      if (!(latest > EPS)) throw new Error("All synced recordings end before reference 0. Use align 'earliest' instead.");
      windows = [{ start: 0, end: latest }];
    }
  }

  const tracks: Track[] = [];
  const program = makeTrack("video", "Program", "v1");
  const initialCam = cameraPieces.find(c => c.input.mediaId === initialCameraId)!;
  program.clips = placePieces(initialCam.input.mediaId, initialCam.pieces, windows, {
    volume: 0,
    label: initialCam.input.name,
  });
  tracks.push(program);

  const cameraCoverage: LayerCoverage[] = [];
  for (const [i, { input, pieces }] of cameraPieces.entries()) {
    const trackId = `mc_${i + 1}`;
    const label = input.name?.trim() || `Camera ${i + 1}`;
    const track: Track = {
      ...makeTrack("video", `Angle ${i + 1}: ${label}`, trackId),
      hidden: true,
      muted: true,
      clips: placePieces(input.mediaId, pieces, windows, { volume: 0, label }),
    };
    tracks.push(track);
    cameraCoverage.push(summarizeCoverage(input.mediaId, trackId, label, track.clips as MediaClip[], cameraAudible(input)));
  }

  const audioCoverage: LayerCoverage[] = [];
  let audioIndex = 1;
  // Separate audio layers first (in the order supplied).
  for (const { input, pieces } of audioPieces) {
    const isAudible = input.audible !== false;
    const trackId = `a${audioIndex++}`;
    const label = input.name?.trim() || `Audio ${audioIndex - 1}`;
    const track: Track = {
      ...makeTrack("audio", label, trackId),
      muted: !isAudible,
      clips: placePieces(input.mediaId, pieces, windows, {
        volume: input.volume ?? 1,
        crossfade: opts.crossfade,
        audioTrack: input.audioTrack,
        label,
      }),
    };
    tracks.push(track);
    audioCoverage.push(summarizeCoverage(input.mediaId, trackId, label, track.clips as MediaClip[], isAudible));
  }
  // Explicitly audible cameras (or the fallback audible camera) also get a dedicated audio track
  // so camera switches on `v1` never interrupt or silence dialogue.
  for (const { input, pieces } of cameraPieces) {
    if (!cameraAudible(input)) continue;
    // Skip if this exact mediaId was already placed as an audio layer above.
    if (seenAudio.has(input.mediaId)) continue;
    const trackId = `a${audioIndex++}`;
    const label = `${input.name?.trim() || input.mediaId} audio`;
    const track: Track = {
      ...makeTrack("audio", label, trackId),
      muted: false,
      clips: placePieces(input.mediaId, pieces, windows, {
        volume: input.volume ?? 1,
        crossfade: opts.crossfade,
        audioTrack: input.audioTrack,
        label,
      }),
    };
    tracks.push(track);
    audioCoverage.push(summarizeCoverage(input.mediaId, trackId, label, track.clips as MediaClip[], true));
  }

  // Always include at least one audio track (`a1`) to match Scarlet's standard timeline shape.
  if (audioIndex === 1) tracks.push(makeTrack("audio", "A1", "a1"));

  const timeline = TimelineSchema.parse({
    version: "draft",
    parent: null,
    projectId,
    name: opts.name ?? "Main",
    tracks,
    markers: [],
  });

  return {
    timeline,
    programTrackId: program.id,
    initialCameraId,
    align,
    origin: round3(origin),
    duration: round3(timelineDuration(timeline)),
    cameras: cameraCoverage,
    audio: audioCoverage,
  };
}

// ---------------------------------------------------------------------------
// Sync-preserving camera switching
// ---------------------------------------------------------------------------

export interface CameraSwitchInput {
  from: number;
  to: number;
  mediaId: string;
  label?: string;
}

export interface SwitchCameraOptions {
  /** Video track to switch angles on. Defaults to the first visible video track. */
  programTrackId?: string;
}

export interface SnappedEdge {
  index: number;
  side: "from" | "to";
  asked: number;
  placed: number;
}

export interface SwitchCameraResult {
  ops: TimelineOp[];
  report: {
    programTrackId: string;
    switchesApplied: number;
    clipsAdded: number;
    camerasUsed: string[];
    snapped: SnappedEdge[];
    detachedAudio: string[];
    hiddenAngleTracks: string[];
  };
}

/**
 * Find the synced angle source clips for `mediaId` on `timeline`.
 * Prefers hidden video angle tracks (`mc_*`), then falls back to other video tracks,
 * and finally the program track itself (if the camera is only on `v1`).
 */
export function findAngleSourceTrack(timeline: Timeline, mediaId: string, programTrackId: string): Track | undefined {
  const hidden = timeline.tracks.find(t => t.kind === "video" && t.hidden && t.clips.some(c => c.kind === "media" && c.enabled !== false && c.mediaId === mediaId));
  if (hidden) return hidden;
  const other = timeline.tracks.find(t => t.kind === "video" && t.id !== programTrackId && t.clips.some(c => c.kind === "media" && c.enabled !== false && c.mediaId === mediaId));
  if (other) return other;
  return timeline.tracks.find(t => t.id === programTrackId && t.clips.some(c => c.kind === "media" && c.enabled !== false && c.mediaId === mediaId));
}

/**
 * Compute the timeline ops to switch the visible camera angle on the Program track
 * across one or more non-overlapping `[from, to]` intervals.
 *
 * Guarantees:
 * - Audio tracks, captions, and overlays above Program are untouched.
 * - If Program clips currently play their own audio (e.g. a manually stacked timeline),
 *   their audio is first detached onto a dedicated dialogue track and muted on Program so
 *   switching angles never drops audio or introduces doubled sound.
 * - Synced angle clips are sliced directly from each camera's reference track at the exact
 *   timeline positions, preserving drift-compensated speeds and every dialogue cut (`rippleDelete`).
 * - Refuses switches where the chosen camera has no synced footage covering `[from, to]`,
 *   reporting that camera's available timeline coverage instead of leaving black gaps.
 */
export function switchCameraOps(
  timeline: Timeline,
  media: readonly Pick<MediaAsset, "id" | "kind" | "name" | "hasAudio">[],
  fps: number,
  switches: readonly CameraSwitchInput[],
  opts: SwitchCameraOptions = {},
): SwitchCameraResult {
  if (!switches.length) throw new Error("Provide at least one camera switch range.");
  const program = opts.programTrackId
    ? timeline.tracks.find(t => t.id === opts.programTrackId && t.kind === "video")
    : timeline.tracks.find(t => t.kind === "video" && !t.hidden) ?? timeline.tracks.find(t => t.kind === "video");
  if (!program) {
    throw new Error(opts.programTrackId ? `Video track ${opts.programTrackId} not found.` : "This timeline has no video track to switch cameras on.");
  }

  const assets = new Map(media.map(m => [m.id, m]));
  const totalDur = timelineDuration(timeline);

  // Collect existing clip edges on Program and synced angle tracks so switch points within half a frame
  // of a dialogue cut snap cleanly to that exact cut instead of creating a sub-frame sliver.
  const existingEdges: number[] = [];
  for (const t of timeline.tracks) {
    if (t.kind !== "video") continue;
    for (const c of t.clips) {
      if (c.kind === "media" && c.enabled !== false) existingEdges.push(c.timelineIn, clipEnd(c));
    }
  }
  const halfFrame = 0.5 / Math.max(1, fps);
  const snapEdge = (t: number) => {
    let nearest: number | undefined;
    let bestDist = halfFrame + 1e-6;
    for (const edge of existingEdges) {
      const dist = Math.abs(edge - t);
      if (dist < bestDist) { bestDist = dist; nearest = edge; }
    }
    return nearest !== undefined ? nearest : snapToFrame(t, fps);
  };

  // Validate and snap switch ranges.
  const snapped: SnappedEdge[] = [];
  const normalized = switches.map((sw, index) => {
    const asset = assets.get(sw.mediaId);
    if (!asset) throw new Error(`switches[${index}]: media ${sw.mediaId} is not in this project.`);
    if (asset.kind !== "video") throw new Error(`switches[${index}]: ${sw.mediaId} is ${asset.kind}; choose a video camera angle.`);
    if (!(sw.to > sw.from)) throw new Error(`switches[${index}]: to (${sw.to}) must be greater than from (${sw.from}).`);
    if (sw.from < -EPS || sw.to > totalDur + halfFrame + EPS) {
      throw new Error(`switches[${index}]: range ${sw.from.toFixed(2)}–${sw.to.toFixed(2)} s falls outside timeline duration ${totalDur.toFixed(2)} s.`);
    }
    const from = Math.max(0, Math.min(totalDur, snapEdge(sw.from)));
    const to = Math.max(0, Math.min(totalDur, snapEdge(sw.to)));
    if (!(to > from + EPS)) throw new Error(`switches[${index}]: snapped range [${from.toFixed(3)}, ${to.toFixed(3)}] is empty.`);
    if (Math.abs(from - sw.from) > 1e-4) snapped.push({ index, side: "from", asked: round3(sw.from), placed: round3(from) });
    if (Math.abs(to - sw.to) > 1e-4) snapped.push({ index, side: "to", asked: round3(sw.to), placed: round3(to) });
    return { index, from, to, mediaId: sw.mediaId, label: sw.label };
  });

  const sorted = [...normalized].sort((a, b) => a.from - b.from || a.to - b.to);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!, cur = sorted[i]!;
    if (cur.from < prev.to - EPS) {
      throw new Error(`switches[${prev.index}] (${prev.from.toFixed(2)}–${prev.to.toFixed(2)} s) overlaps switches[${cur.index}] (${cur.from.toFixed(2)}–${cur.to.toFixed(2)} s). Provide non-overlapping switch ranges.`);
    }
  }

  // Resolve source tracks for every requested camera BEFORE mutating `program`, and snapshot
  // any manually-stacked camera tracks into hidden reference tracks so switching is non-destructive.
  const ops: TimelineOp[] = [];
  const usedIds = new Set(timeline.tracks.flatMap(t => t.clips.map(c => c.id)));
  const usedTrackIds = new Set(timeline.tracks.map(t => t.id));
  const nextClipId = (prefix: string) => {
    const id = uniqueId(prefix, usedIds);
    usedIds.add(id);
    return id;
  };
  const nextTrackId = (prefix: string) => {
    const id = uniqueId(prefix, usedTrackIds);
    usedTrackIds.add(id);
    return id;
  };

  const sourceClipsByMedia = new Map<string, MediaClip[]>();
  const hiddenAngleTracks: string[] = [];
  const tracksToHide = new Set<string>();

  for (const mediaId of new Set(sorted.map(s => s.mediaId))) {
    const srcTrack = findAngleSourceTrack(timeline, mediaId, program.id);
    if (!srcTrack) {
      throw new Error(`Camera ${mediaId} has no synced clips on this timeline. Sync cameras first with timeline_sync_multicam.`);
    }
    const clips = srcTrack.clips
      .filter((c): c is MediaClip => c.kind === "media" && c.enabled !== false && c.mediaId === mediaId)
      .sort((a, b) => a.timelineIn - b.timelineIn);
    sourceClipsByMedia.set(mediaId, clips);
    // If the user stacked visible camera tracks manually above Program, hide those tracks
    // once switched onto Program so they don't cover Program or decode twice.
    if (srcTrack.id !== program.id && !srcTrack.hidden) tracksToHide.add(srcTrack.id);
  }

  // If Program contains camera footage whose mediaId does not yet have a hidden reference track,
  // snapshot each such camera into a hidden reference track so re-switching back is always possible.
  const programMediaIds = new Set(
    program.clips
      .filter((c): c is MediaClip => c.kind === "media" && c.enabled !== false)
      .map(c => c.mediaId),
  );
  for (const mediaId of programMediaIds) {
    const hasRef = timeline.tracks.some(t => t.kind === "video" && t.id !== program.id && t.clips.some(c => c.kind === "media" && c.enabled !== false && c.mediaId === mediaId));
    if (hasRef) continue;
    const baseClips = program.clips
      .filter((c): c is MediaClip => c.kind === "media" && c.enabled !== false && c.mediaId === mediaId)
      .map(c => ({ ...structuredClone(c), id: nextClipId(`${c.id}_ref`), volume: 0, audioFadeIn: 0, audioFadeOut: 0, transitionIn: undefined }));
    if (!baseClips.length) continue;
    const refTrackId = nextTrackId("mc_ref");
    const assetName = assets.get(mediaId)?.name ?? mediaId;
    ops.push({
      op: "addTrack",
      track: { ...makeTrack("video", `Angle: ${assetName}`, refTrackId), hidden: true, muted: true, clips: baseClips },
    });
  }

  // Detach any audible sound on Program (or on visible angle tracks being hidden) onto a dedicated
  // dialogue audio track before modifying Program so switching picture never silences audio.
  const detachedAudio: string[] = [];
  const detachFromTracks = [program, ...timeline.tracks.filter(t => tracksToHide.has(t.id))];
  const placedAudio = new Map<string, TimeRange[]>();
  const addedAudioTracks = new Set<string>();
  const audioTrackFor = (srcTrack: Track, start: number, end: number) => {
    for (let id = `${srcTrack.id}_dialogue`; ; id += "_") {
      const found = timeline.tracks.find(t => t.id === id);
      if (found && (found.kind !== "audio" || found.muted)) continue;
      const busy = [...(found?.clips ?? []).map(c => ({ start: c.timelineIn, end: clipEnd(c) })), ...(placedAudio.get(id) ?? [])];
      if (busy.some(b => b.start < end - EPS && b.end > start + EPS)) continue;
      if (!found && !addedAudioTracks.has(id)) {
        addedAudioTracks.add(id);
        usedTrackIds.add(id);
        ops.push({ op: "addTrack", track: makeTrack("audio", `${srcTrack.name} dialogue`, id) });
      }
      placedAudio.set(id, [...(placedAudio.get(id) ?? []), { start, end }]);
      return id;
    }
  };
  for (const tr of detachFromTracks) {
    for (const c of tr.clips) {
      if (c.kind !== "media" || !plays(tr, c)) continue;
      const asset = assets.get(c.mediaId);
      if (asset && !carriesAudio(asset)) continue;
      const trackId = audioTrackFor(tr, c.timelineIn, clipEnd(c));
      const audioClipId = nextClipId(`${c.id}_audio`);
      ops.push(
        { op: "addClip", trackId, clip: detachedAudioClip(c, audioClipId) },
        { op: "updateClip", clipId: c.id, patch: { volume: 0 } },
      );
      detachedAudio.push(c.id);
    }
  }

  for (const trackId of tracksToHide) {
    ops.push({ op: "updateTrack", trackId, patch: { hidden: true, muted: true } });
    hiddenAngleTracks.push(trackId);
  }

  // Validate coverage for every switch and slice the exact synced clips from each camera's track.
  const frameTolerance = 1 / Math.max(1, fps) + 1e-4;
  const newClipsPerSwitch: Array<{ sw: (typeof sorted)[number]; clips: MediaClip[] }> = [];
  for (const sw of sorted) {
    const srcClips = sourceClipsByMedia.get(sw.mediaId)!;
    const sliced: MediaClip[] = [];
    for (const c of srcClips) {
      const cStart = c.timelineIn;
      const cEnd = clipEnd(c);
      if (cEnd <= sw.from + EPS || cStart >= sw.to - EPS) continue;
      const lo = Math.max(sw.from, cStart);
      const hi = Math.min(sw.to, cEnd);
      if (hi - lo <= EPS) continue;
      const speed = c.speed ?? 1;
      const sIn = sourceAt(c, lo);
      const sOut = sourceAt(c, hi);
      sliced.push(makeMediaClip(sw.mediaId, sIn, sOut, lo, {
        id: nextClipId(newId("clip")),
        speed,
        volume: 0,
        ...(sw.label ? { label: sw.label } : c.label ? { label: c.label } : {}),
      }));
    }
    // Verify the chosen camera covers the entire requested switch range (within one frame).
    const covered: TimeRange[] = [];
    for (const c of sliced) {
      const prev = covered.at(-1);
      if (prev && c.timelineIn <= prev.end + MEET) prev.end = Math.max(prev.end, clipEnd(c));
      else covered.push({ start: c.timelineIn, end: clipEnd(c) });
    }
    const gaps: TimeRange[] = [];
    let cursor = sw.from;
    for (const r of covered) {
      if (r.start > cursor + frameTolerance) gaps.push({ start: round3(cursor), end: round3(r.start) });
      cursor = Math.max(cursor, r.end);
    }
    if (sw.to > cursor + frameTolerance) gaps.push({ start: round3(cursor), end: round3(sw.to) });
    if (gaps.length) {
      const avail = srcClips.map(c => `${c.timelineIn.toFixed(2)}–${clipEnd(c).toFixed(2)} s`).join(", ");
      const missing = gaps.map(g => `${g.start.toFixed(2)}–${g.end.toFixed(2)} s`).join(", ");
      throw new Error(`switches[${sw.index}]: camera ${sw.mediaId} has no synced footage for ${missing} (available on this timeline: ${avail || "none"}). Choose an angle that covers that stretch.`);
    }
    newClipsPerSwitch.push({ sw, clips: sliced });
  }

  // Work out the exact Program track edits against the state after audio detachment.
  const afterDetach = ops.length ? applyOps(timeline, ops) : timeline;
  const programAfter = afterDetach.tracks.find(t => t.id === program.id)!;

  // Apply each switch interval to Program clips cleanly, preserving untouched parts outside switch ranges.
  let workingClips = programAfter.clips.map(c => structuredClone(c));
  const touchedOriginalIds = new Set<string>();
  const originalById = new Map(programAfter.clips.map(c => [c.id, c]));

  for (const { sw, clips: incoming } of newClipsPerSwitch) {
    const nextClips: typeof workingClips = [];
    for (const clip of workingClips) {
      const cStart = clip.timelineIn;
      const cEnd = clipEnd(clip);
      if (cEnd <= sw.from + EPS || cStart >= sw.to - EPS) {
        nextClips.push(clip);
      } else if (cStart >= sw.from - EPS && cEnd <= sw.to + EPS) {
        touchedOriginalIds.add(clip.id);
      } else if (cStart < sw.from - EPS && cEnd > sw.to + EPS) {
        touchedOriginalIds.add(clip.id);
        const [left, midAndRight] = splitClip(clip, sw.from, nextClipId(`${clip.id}_r`));
        const [, right] = splitClip(midAndRight, sw.to, nextClipId(`${clip.id}_t`));
        nextClips.push(left, right);
      } else if (cStart < sw.from - EPS) {
        touchedOriginalIds.add(clip.id);
        nextClips.push(trimTail(clip, sw.from));
      } else {
        touchedOriginalIds.add(clip.id);
        const trimmed = trimHead(clip, sw.to);
        if (trimmed.kind === "media") delete trimmed.transitionIn;
        nextClips.push(trimmed);
      }
    }
    nextClips.push(...incoming);
    nextClips.sort((a, b) => a.timelineIn - b.timelineIn);
    workingClips = nextClips;
  }

  // Coalesce adjacent seamless pieces of the same camera on Program when their framing/effects match,
  // so re-switching back to an adjacent camera leaves one clean continuous clip.
  const coalesced: typeof workingClips = [];
  for (const clip of workingClips) {
    const prev = coalesced.at(-1);
    if (
      prev && prev.kind === "media" && clip.kind === "media" &&
      prev.mediaId === clip.mediaId &&
      prev.enabled === clip.enabled &&
      Math.abs((prev.speed ?? 1) - (clip.speed ?? 1)) < 1e-9 &&
      Math.abs(clipEnd(prev) - clip.timelineIn) <= MEET &&
      Math.abs(prev.sourceOut - clip.sourceIn) <= MEET * (prev.speed ?? 1) &&
      !clip.transitionIn &&
      !prev.videoFadeOut && !clip.videoFadeIn &&
      JSON.stringify(prev.transform ?? null) === JSON.stringify(clip.transform ?? null) &&
      !prev.keyframes?.length && !clip.keyframes?.length &&
      JSON.stringify(prev.effects) === JSON.stringify(clip.effects)
    ) {
      touchedOriginalIds.add(prev.id);
      touchedOriginalIds.add(clip.id);
      coalesced[coalesced.length - 1] = { ...prev, sourceOut: clip.sourceOut, videoFadeOut: clip.videoFadeOut };
    } else {
      coalesced.push(clip);
    }
  }

  // Emit minimal TimelineOps for Program track differences: remove replaced/split originals, add new/modified pieces.
  const survivingById = new Map(coalesced.map(c => [c.id, c]));
  for (const orig of programAfter.clips) {
    if (!survivingById.has(orig.id)) {
      ops.push({ op: "removeClip", clipId: orig.id });
    } else if (touchedOriginalIds.has(orig.id)) {
      const updated = survivingById.get(orig.id)!;
      if (JSON.stringify(updated) !== JSON.stringify(orig)) {
        const { id: _id, kind: _kind, ...patch } = updated;
        ops.push({ op: "updateClip", clipId: orig.id, patch: { ...patch, ...(orig.kind === "media" && orig.transitionIn && updated.kind === "media" && !updated.transitionIn ? { transitionIn: null } : {}) } });
      }
    }
  }
  let clipsAdded = 0;
  for (const clip of coalesced) {
    if (!originalById.has(clip.id)) {
      ops.push({ op: "addClip", trackId: program.id, clip });
      clipsAdded++;
    }
  }

  return {
    ops,
    report: {
      programTrackId: program.id,
      switchesApplied: sorted.length,
      clipsAdded,
      camerasUsed: [...new Set(sorted.map(s => s.mediaId))],
      snapped,
      detachedAudio,
      hiddenAngleTracks,
    },
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
