/**
 * Multi-camera & multi-audio-layer MCP tools:
 * - `timeline_sync_multicam`: measure offsets/drift across 2+ cameras and 0+ audio layers and build a lock-stepped timeline
 * - `multicam_analyze`: measure camera faces, speaker turns/crosstalk, mouth/scratch-audio speaker correlation, and sync health
 * - `timeline_switch_cameras`: switch visible Program camera angles over timeline ranges without touching audio or breaking sync
 */
import { z } from "zod/v3";
import {
  DEFAULT_RESULT_CHARS,
  selectedRange,
  type AgentCapabilities,
  type ScarletClient,
  type Task,
} from "@scarlet/shared";
import {
  AudioTrackSelection,
  buildMulticamTimeline,
  carriesAudio,
  switchCameraOps,
  type MediaAsset,
  type MulticamAudioInput,
  type MulticamCameraInput,
  type SyncSegment,
  type Timeline,
  type TranscriptWord,
} from "@scarlet/timeline";
import { round3 } from "./analysis.js";
import { fitSync, matchAudio, syncPoints, syncRate, type SyncFit } from "./audio-sync.js";
import { editReasonInput, makeIntentInput, timelineEditsInput } from "./mcp-schema.js";
import type { MediaSession } from "./media-session.js";
import { requireMediaAsset, type SessionErrorHelpers } from "./media-state.js";
import {
  correlateSpeakersToCameras,
  discoverAudibleSources,
  discoverMulticamCameras,
  mapStretchesToCameraSource,
  multicamDuration,
  selectMouthActivityStretches,
  turnsFromIsolatedMics,
  turnsFromTranscripts,
  type FaceSpanReading,
  type FaceTrackReading,
  type MouthActivityReading,
} from "./multicam-analysis.js";
import type { ProposePipeline } from "./propose-pipeline.js";
import { syncSummary, timelineSync } from "./timeline-sync.js";
import { json, noteUnmeasured, type ToolRegistrar } from "./tool-result.js";

const TURNS_PER_PAGE = 150;
/** Maximum recording duration read in one envelope pass for scratch/mic level analysis (3 hours). */
const MAX_ENVELOPE_SECONDS = 3 * 3600;

export interface MulticamToolsDeps {
  tool: ToolRegistrar;
  client: ScarletClient;
  projectId: string;
  taskId?: string;
  task?: Task;
  caps: AgentCapabilities;
  session: MediaSession;
  errors: SessionErrorHelpers;
  proposePipeline: ProposePipeline;
}

type SyncMeasurement =
  | { kind: "reference"; offset: 0; speed: 1 }
  | { kind: "explicit"; offset: number; speed: number }
  | { kind: "constant"; offset: number; speed: 1; matchedWindows?: number; syncedVia?: string }
  | { kind: "drift"; offset: number; speed: number; msPerMinute: number; syncedVia?: string }
  | { kind: "steps"; segments: SyncSegment[]; parts: Array<{ from: number; to: number; offset: number; points: number }> }
  | { kind: "unclear"; reason: string };

/** Convert `fitSync`'s steady step parts into contiguous source segments covering [0, duration]. */
function stepSegments(parts: Array<{ from: number; to: number; offset: number; points: number }>, duration: number): SyncSegment[] {
  return parts.map((part, i) => {
    const prev = parts[i - 1];
    const next = parts[i + 1];
    const sourceIn = prev ? round3((prev.to + part.from) / 2) : 0;
    const sourceOut = next ? round3((part.to + next.from) / 2) : duration;
    return { sourceIn, sourceOut, offset: part.offset, speed: 1 };
  }).filter(s => (s.sourceOut ?? duration) > (s.sourceIn ?? 0) + 1e-3);
}

/** Measure how `secondary` aligns against `reference` using shared 50 Hz waveform envelopes. */
function measureEnvelopePair(reference: Float64Array, secondary: Float64Array, secondaryDuration: number): SyncMeasurement {
  if (!reference.length || !secondary.length) {
    return { kind: "unclear", reason: "One of the recordings has no audio to match." };
  }
  const match = matchAudio(reference, secondary);
  if (match) {
    return { kind: "constant", offset: round3(match.secondaryStartRelativeToReference), speed: 1, matchedWindows: match.matchedWindows };
  }
  const points = syncPoints(reference, secondary);
  const fit: SyncFit & { mismatched?: number } = fitSync(points);
  if (fit.kind === "constant") {
    return { kind: "constant", offset: fit.offset, speed: 1 };
  }
  if (fit.kind === "drift") {
    return { kind: "drift", offset: fit.offsetAtStart, speed: fit.secondarySpeed, msPerMinute: fit.msPerMinute };
  }
  if (fit.kind === "steps") {
    return { kind: "steps", segments: stepSegments(fit.parts, secondaryDuration), parts: fit.parts };
  }
  return { kind: "unclear", reason: fit.reason };
}

export function registerMulticamTools(deps: MulticamToolsDeps) {
  const { tool, client, projectId, taskId, task, caps, session, errors, proposePipeline } = deps;
  const { getProject, peekTimeline, baseTimeline, headTimelineOrNull, readPrepared, transcriptWords } = session;
  const { withoutOnce } = errors;
  const { propose } = proposePipeline;
  const intentInput = makeIntentInput(Boolean(taskId));

  /** Read a recording's full 50 Hz peak envelope (cached per call). */
  async function readEnvelope(asset: MediaAsset): Promise<Float64Array> {
    const count = Math.floor(Math.min(asset.duration ?? 0, MAX_ENVELOPE_SECONDS) * syncRate);
    if (!carriesAudio(asset) || !(count > 0)) return new Float64Array();
    const values = new Float64Array(count);
    for (let start = 0; start < count; start += 10_000) {
      const end = Math.min(start + 10_000, count);
      const wave = await readPrepared(asset.id, "waveform", () => client.waveformPeaks(asset.id, start / syncRate, end / syncRate, end - start));
      if (wave.peaks.length !== end - start) {
        throw new Error(`The waveform of ${asset.id} covered ${wave.peaks.length} of ${end - start} samples from ${(start / syncRate).toFixed(1)} s. Retry or supply an explicit offset.`);
      }
      values.set(wave.peaks, start);
    }
    return values;
  }

  /** Helper to run `timelineSync` reusing an in-memory map of 50 Hz envelopes. */
  function levelsFromMap(envelopes: Map<string, Float64Array>, assets: Map<string, MediaAsset>) {
    return async (mediaId: string, from: number, to: number): Promise<number[]> => {
      let env = envelopes.get(mediaId);
      if (!env) {
        const asset = assets.get(mediaId);
        env = asset ? await readEnvelope(asset).catch(() => new Float64Array()) : new Float64Array();
        envelopes.set(mediaId, env);
      }
      const lo = Math.max(0, Math.round(from * syncRate));
      const hi = Math.min(env.length, Math.round(to * syncRate));
      return Array.from(env.subarray(lo, hi));
    };
  }

  // -------------------------------------------------------------------------
  // 1. timeline_sync_multicam
  // -------------------------------------------------------------------------
  tool(
    "timeline_sync_multicam",
    "Sync multiple camera angles and separate audio tracks onto aligned tracks. " +
      "Any camera or audio layer without an explicit `offset` is measured automatically against `referenceId` from shared audio (constant offset, steady clock drift with speed compensation, or multi-part step jumps, with transitive hub fallback through another synced recording when isolated microphones share audio with a room camera). " +
      "Builds `v1` (Program, showing `initialCameraId` full-screen), one hidden synced reference track per camera (`mc_1`, `mc_2`, ...) so `timeline_switch_cameras` and dialogue cuts (`dialogue_apply_cuts` / `rippleDelete`) keep every angle lock-stepped, and dedicated audio tracks (`a1`, `a2`, ...) for every audible audio source while muting camera scratch audio (`volume: 0` on all video tracks). " +
      "Verifies sync alignment across all synced pairs and returns measured offsets, drift compensation speeds, track coverage, and sync verification.",
    {
      intent: intentInput,
      referenceId: z.string().optional().describe("Reference mediaId whose clock all offsets are measured against. Defaults to the first audio layer if supplied, otherwise the first camera."),
      cameras: z.array(z.object({
        mediaId: z.string().describe("Video recording for this camera angle"),
        name: z.string().optional().describe("Short angle label (e.g. 'Wide', 'Host', 'Guest'); defaults to the asset filename"),
        offset: z.number().finite().optional().describe("Seconds this camera starts after referenceId (negative = earlier). Omit to measure automatically from shared audio."),
        speed: z.number().finite().positive().optional().describe("Clock-drift compensation speed (default 1, e.g. audio_sync's secondarySpeed). Measured automatically when offset is omitted and drift is detected."),
        audible: z.boolean().optional().describe("Hear this camera's own audio on a dedicated audio track. Defaults to false when separate audio layers exist; otherwise the first audible camera defaults to true and other cameras' scratch audio is muted."),
        volume: z.number().finite().min(0).max(4).optional().describe("Linear gain when audible (default 1)"),
        audioTrack: AudioTrackSelection.optional().describe("Optional audio stream index or 'all' on a multi-track camera recording"),
      })).min(1).max(12).describe("Camera video recordings to sync"),
      audio: z.array(z.object({
        mediaId: z.string().describe("Separate audio/mic recording"),
        name: z.string().optional().describe("Short track label (e.g. 'Host mic', 'Guest mic', 'Master mix'); defaults to the asset filename"),
        offset: z.number().finite().optional().describe("Seconds this recording starts after referenceId (negative = earlier). Omit to measure automatically from shared audio."),
        speed: z.number().finite().positive().optional().describe("Clock-drift compensation speed (default 1). Measured automatically when offset is omitted and drift is detected."),
        audible: z.boolean().optional().describe("Include in the audible mix (default true; false keeps it synced on a muted backup track)"),
        volume: z.number().finite().min(0).max(4).optional().describe("Linear gain (default 1)"),
        audioTrack: AudioTrackSelection.optional().describe("Optional audio stream index or 'all' on a multi-track audio recording"),
      })).max(12).optional().describe("Optional separate audio/mic recordings to sync alongside the cameras"),
      initialCameraId: z.string().optional().describe("Camera mediaId shown initially on Program (v1). Defaults to the first camera."),
      align: z.enum(["reference", "overlap", "earliest"]).default("reference").describe("How timeline 0 is anchored: 'reference' aligns timeline 0 to referenceId's start (default), 'overlap' trims head/tail to the common overlap where all cameras and audible audio roll together, 'earliest' preserves the full head of the earliest-starting recording."),
      keep: z.array(z.object({
        start: z.number().finite().nonnegative().describe("Reference-clock start second"),
        end: z.number().finite().positive().describe("Reference-clock end second"),
        label: z.string().optional(),
      })).min(1).optional().describe("Optional reference-clock source ranges to assemble instead of the full recordings"),
      crossfade: z.number().min(0).max(2).optional().describe("Optional audio fade in/out in seconds on assembled keep-range audio clips"),
      description: z.string().min(1).default("Sync multi-camera angles and audio tracks").describe("One short sentence for the chat about what changed"),
      reason: editReasonInput,
      noteIds: z.array(z.string()).optional(),
    },
    async ({ intent, referenceId, cameras, audio = [], initialCameraId, align, keep, crossfade, description, reason, noteIds }) => {
      const detail = session.lastTimeline ? { ...await getProject(), timeline: session.lastTimeline } : await client.workspace(projectId);
      const before = detail.timeline ?? await headTimelineOrNull();
      const anchor = task?.context;
      if (before?.tracks.some(t => t.clips.length) && selectedRange(anchor)) {
        throw new Error("Syncing a multi-camera timeline replaces the whole timeline and exceeds the scoped selection.");
      }
      if (cameras.length + audio.length < 2) {
        throw new Error("Provide at least two recordings to sync (2+ cameras, or 1+ camera with 1+ separate audio layers).");
      }

      const assets = new Map(detail.project.media.map(m => [m.id, m]));
      for (const cam of cameras) {
        const asset = requireMediaAsset(detail.project, cam.mediaId, "Camera media");
        if (asset.kind !== "video") throw new Error(`Camera ${cam.mediaId} is ${asset.kind}: cameras must be video recordings.`);
        if (!asset.duration) throw new Error(`The duration of ${cam.mediaId} isn't known yet. Retry once import finishes.`);
      }
      for (const aud of audio) {
        const asset = requireMediaAsset(detail.project, aud.mediaId, "Audio media");
        if (!carriesAudio(asset)) throw new Error(`Audio layer ${aud.mediaId} has no audio.`);
        if (!asset.duration) throw new Error(`The duration of ${aud.mediaId} isn't known yet. Retry once import finishes.`);
      }

      const refId = referenceId ?? audio[0]?.mediaId ?? cameras[0]!.mediaId;
      const refAsset = requireMediaAsset(detail.project, refId, "Reference media");
      if (!refAsset.duration) throw new Error(`The duration of reference ${refId} isn't known yet. Retry once import finishes.`);

      const allItems = [
        ...cameras.map(c => ({ role: "camera" as const, item: c })),
        ...audio.map(a => ({ role: "audio" as const, item: a })),
      ];
      const needMeasure = allItems.filter(({ item }) => item.offset === undefined && item.mediaId !== refId);

      // Load envelopes in parallel only for recordings that need automatic sync measurement.
      const envelopes = new Map<string, Float64Array>();
      if (needMeasure.length) {
        const toRead = new Set<string>([refId, ...allItems.map(x => x.item.mediaId)]);
        await Promise.all([...toRead].map(async id => {
          const asset = assets.get(id);
          if (asset && carriesAudio(asset)) envelopes.set(id, await readEnvelope(asset));
          else envelopes.set(id, new Float64Array());
        }));
      }

      const measurements = new Map<string, SyncMeasurement>();
      measurements.set(refId, { kind: "reference", offset: 0, speed: 1 });

      // Pass 1: apply explicit offsets and measure remaining recordings directly against `refId`.
      for (const { item } of allItems) {
        if (item.offset !== undefined) {
          measurements.set(item.mediaId, { kind: "explicit", offset: round3(item.offset), speed: item.speed ?? 1 });
          continue;
        }
        if (item.mediaId === refId) continue;
        const asset = assets.get(item.mediaId)!;
        const measured = measureEnvelopePair(envelopes.get(refId) ?? new Float64Array(), envelopes.get(item.mediaId) ?? new Float64Array(), asset.duration!);
        measurements.set(item.mediaId, measured);
      }

      // Pass 2: transitive hub fallback for isolated microphones or recordings that share audio
      // with an already-synced room camera/mix rather than directly with `refId`.
      let progressed = true;
      while (progressed) {
        progressed = false;
        const hubs = [...measurements.entries()].filter(([id, m]) =>
          id !== refId && (m.kind === "constant" || m.kind === "drift" || m.kind === "explicit") && (envelopes.get(id)?.length ?? 0) > 0,
        ) as Array<[string, { kind: "constant" | "drift" | "explicit"; offset: number; speed: number }]>;
        if (!hubs.length) break;
        for (const { item } of allItems) {
          const cur = measurements.get(item.mediaId);
          if (!cur || cur.kind !== "unclear") continue;
          const secEnv = envelopes.get(item.mediaId);
          if (!secEnv?.length) continue;
          const asset = assets.get(item.mediaId)!;
          for (const [hubId, hub] of hubs) {
            const rel = measureEnvelopePair(envelopes.get(hubId)!, secEnv, asset.duration!);
            if (rel.kind === "constant") {
              measurements.set(item.mediaId, {
                kind: "constant",
                offset: round3(hub.offset + rel.offset / hub.speed),
                speed: 1,
                ...(rel.matchedWindows !== undefined && { matchedWindows: rel.matchedWindows }),
                syncedVia: hubId,
              });
              progressed = true;
              break;
            }
            if (rel.kind === "drift") {
              measurements.set(item.mediaId, {
                kind: "drift",
                offset: round3(hub.offset + rel.offset / hub.speed),
                speed: Math.round(hub.speed * rel.speed * 1e6) / 1e6,
                msPerMinute: rel.msPerMinute,
                syncedVia: hubId,
              });
              progressed = true;
              break;
            }
          }
        }
      }

      const unresolved = allItems.filter(({ item }) => measurements.get(item.mediaId)?.kind === "unclear");
      if (unresolved.length) {
        const resolvedSummary = [...measurements.entries()]
          .filter((entry): entry is [string, Exclude<SyncMeasurement, { kind: "unclear" }>] => entry[1].kind !== "unclear")
          .map(([id, m]) => `${id}: ${m.kind === "steps" ? `${m.parts.length} parts` : `offset ${m.offset} s${m.speed !== 1 ? ` (speed ${m.speed})` : ""}`}`);
        const failed = unresolved.map(({ item }) => {
          const m = measurements.get(item.mediaId) as { kind: "unclear"; reason: string };
          return `${item.mediaId} (${assets.get(item.mediaId)?.name ?? item.mediaId}): ${m.reason}`;
        });
        throw new Error(
          `Could not measure sync automatically for: ${failed.join("; ")}.` +
          (resolvedSummary.length ? ` Measured so far against ${refId}: ${resolvedSummary.join(", ")}.` : "") +
          " Supply an explicit `offset` (seconds relative to referenceId) for any silent or ambiguous recording, or inspect it with audio_sync.",
        );
      }

      const placementFor = (mediaId: string, explicitSpeed?: number): { offset?: number; speed?: number; segments?: SyncSegment[] } => {
        const m = measurements.get(mediaId)!;
        if (m.kind === "steps") return { segments: m.segments };
        if (m.kind === "unclear") throw new Error(`Unresolved sync for ${mediaId}.`);
        return { offset: m.offset, speed: explicitSpeed ?? m.speed };
      };

      const cameraInputs: MulticamCameraInput[] = cameras.map(c => {
        const asset = assets.get(c.mediaId)!;
        return {
          mediaId: c.mediaId,
          duration: asset.duration!,
          name: c.name ?? asset.name,
          ...placementFor(c.mediaId, c.speed),
          ...(c.audible !== undefined && { audible: c.audible }),
          ...(c.volume !== undefined && { volume: c.volume }),
          ...(c.audioTrack !== undefined && { audioTrack: c.audioTrack }),
          hasAudio: asset.hasAudio !== false,
        };
      });

      const audioInputs: MulticamAudioInput[] = audio.map(a => {
        const asset = assets.get(a.mediaId)!;
        return {
          mediaId: a.mediaId,
          duration: asset.duration!,
          name: a.name ?? asset.name,
          ...placementFor(a.mediaId, a.speed),
          ...(a.audible !== undefined && { audible: a.audible }),
          ...(a.volume !== undefined && { volume: a.volume }),
          ...(a.audioTrack !== undefined && { audioTrack: a.audioTrack }),
        };
      });

      const built = buildMulticamTimeline(projectId, cameraInputs, audioInputs, {
        initialCameraId,
        align,
        keep,
        crossfade,
      });

      const firstCut = !before || !before.tracks.some(t => t.clips.length);
      const saved = await propose({ intent, timeline: built.timeline, firstCut, description, reason, noteIds }, before);

      // Verify sync on the built timeline reusing already-loaded envelopes.
      const syncPairs = await timelineSync(built.timeline, detail.project.media, detail.project.settings.fps, levelsFromMap(envelopes, assets))
        .catch(() => []);
      const names = new Map(detail.project.media.map(m => [m.id, m.name]));
      const syncText = syncSummary(syncPairs, names, detail.project.settings.fps);

      const report = {
        referenceId: refId,
        align: built.align,
        origin: built.origin,
        duration: built.duration,
        programTrackId: built.programTrackId,
        initialCameraId: built.initialCameraId,
        measurements: Object.fromEntries(measurements),
        cameras: built.cameras,
        audio: built.audio,
        ...(syncPairs.length && { sync: { pairs: syncPairs, ...(syncText && { summary: syncText }) } }),
      };

      return {
        ...saved,
        content: [
          ...saved.content,
          { type: "text", text: JSON.stringify(report) },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // 2. multicam_analyze (read-only measurement tool)
  // -------------------------------------------------------------------------
  tool(
    "multicam_analyze",
    "Measure camera faces, speaker turns, crosstalk, and speaker-to-camera match evidence. " +
      "Returns: (1) `cameras`: each camera angle's track, timeline coverage, prominent face count/positions/framing sizes (`faces`), and objective `speakerEvidence` per speaker combining per-face mouth movement during solo turns (`mouthActivity`: own vs other mean motion, ratio, correlation), camera scratch-audio level advantage (`scratchAudio`), and direct-mic match; " +
      "(2) `speakers`: speaking seconds, turn count, and share per detected speaker or isolated mic; " +
      "(3) `turns` and `crosstalk`: timeline-ordered speaker turns and overlapping-speech stretches (paged with `from`/`to`/`offset`); " +
      "(4) `sync`: alignment check across all synced camera and audio pairs on this version. " +
      "Evidence only: use your skill and optional frame looks (`media_frame` / `frame_contact_sheet`) to decide when and which camera to cut to.",
    {
      version: z.string().optional().describe("Timeline version to inspect (default head)"),
      from: z.number().finite().nonnegative().optional().describe("Optional start in TIMELINE seconds"),
      to: z.number().finite().positive().optional().describe("Optional end in TIMELINE seconds"),
      offset: z.number().int().min(0).default(0).describe("Turn pagination offset"),
      includeMouthActivity: z.boolean().default(true).describe("Measure per-face mouth movement over representative solo speaking stretches to correlate visible faces with speakers"),
    },
    async ({ version, from, to, offset, includeMouthActivity }) => {
      if (from !== undefined && to !== undefined && to <= from) throw new Error("`to` must be greater than `from`.");
      const [tl, { project }] = await Promise.all([peekTimeline(version ?? "head"), getProject()]);
      const duration = multicamDuration(tl);
      const range = from !== undefined || to !== undefined ? { start: from ?? 0, end: Math.min(to ?? duration, duration) } : undefined;
      const assets = new Map(project.media.map(m => [m.id, m]));
      const cameras = discoverMulticamCameras(tl, project.media);
      const audible = discoverAudibleSources(tl, project.media);

      if (!cameras.length) {
        return json({ version: tl.version, duration, cameras: [], speakers: [], turns: [], crosstalk: [], note: "No video camera clips on this timeline yet." });
      }

      // 1. Gather transcripts for audible sources (non-blocking read for ready transcripts; prepare if single audible source has none).
      const transcripts = new Map<string, TranscriptWord[]>();
      const audibleIds = [...new Set(audible.map(a => a.mediaId))];
      await Promise.all(audibleIds.map(async id => {
        const words = await transcriptWords(id, false).catch(() => null);
        if (words?.length) transcripts.set(id, words);
      }));
      if (!transcripts.size && audibleIds.length === 1) {
        const words = await transcriptWords(audibleIds[0]!, true).catch(() => null);
        if (words?.length) transcripts.set(audibleIds[0]!, words);
      }

      // 2. Load 50 Hz envelopes for audible mics (when 2+ distinct mics) and cameras carrying audio (for scratch-audio evidence & sync verification).
      const envelopes = new Map<string, Float64Array>();
      const waveIds = new Set<string>([
        ...(audibleIds.length >= 2 ? audibleIds : []),
        ...cameras.map(c => c.mediaId),
        ...audibleIds,
      ]);
      await Promise.all([...waveIds].map(async id => {
        const asset = assets.get(id);
        if (!asset || !carriesAudio(asset) || !asset.duration) return;
        const env = await readEnvelope(asset).catch(() => null);
        if (env?.length) envelopes.set(id, env);
      }));

      // 3. Build speaker turns & crosstalk:
      //    - When 2+ distinct audible mic tracks exist and transcripts are absent (or only 1 mic is transcribed),
      //      derive turns directly from isolated mic levels; when transcripts exist across mics or on a diarized mix,
      //      use transcript turns (enriching multi-mic crosstalk from levels if transcripts miss overlaps).
      const levelsMap = new Map<string, { peaks: ArrayLike<number>; sampleRate: number }>();
      for (const [id, env] of envelopes) levelsMap.set(id, { peaks: env, sampleRate: syncRate });

      let turnData = transcripts.size
        ? turnsFromTranscripts(tl, transcripts, audible, { range })
        : { turns: [], crosstalk: [], speakers: [] };
      const micData = audible.length >= 2
        ? turnsFromIsolatedMics(audible, levelsMap, { range })
        : { turns: [], crosstalk: [], speakers: [] };

      let turnSource: "transcript" | "isolated_mics" | "none" = "none";
      if (audible.length >= 2 && (turnData.speakers.length < 2 || !turnData.turns.length) && micData.turns.length) {
        turnData = micData;
        turnSource = "isolated_mics";
      } else if (turnData.turns.length) {
        turnSource = "transcript";
        // If isolated mics also detected crosstalk that a tidied transcript missed, include it.
        if (micData.crosstalk.length && !turnData.crosstalk.length) {
          turnData = { ...turnData, crosstalk: micData.crosstalk };
        }
      }

      // 4. Read `faces` for every camera angle in parallel (bounded wait so unread cameras still return fast).
      const readingNotes: string[] = [];
      const facesByCamera = new Map<string, { tracks: FaceTrackReading[]; spans: FaceSpanReading[] }>();
      await Promise.all(cameras.map(async cam => {
        const srcMin = Math.max(0, Math.floor(Math.min(...cam.clips.map(c => c.sourceIn))));
        const srcMax = Math.ceil(Math.max(...cam.clips.map(c => c.sourceOut)));
        try {
          const read = await client.get<{
            from: number; to: number; readSeconds: number; done: boolean; error?: string;
            tracks: FaceTrackReading[]; spans: FaceSpanReading[];
          }>(`/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(cam.mediaId)}/faces?from=${srcMin}&to=${srcMax}&wait=10`);
          facesByCamera.set(cam.mediaId, { tracks: read.tracks ?? [], spans: read.spans ?? [] });
          if (!read.done) {
            readingNotes.push(`${cam.mediaId}: ${read.readSeconds.toFixed(0)} of ${(read.to - read.from).toFixed(0)} s of faces read so far${read.error ? `, stopped: ${read.error}` : ", still reading: call again for the rest"}`);
          }
        } catch (err) {
          noteUnmeasured(`faces of ${cam.mediaId}`, err);
        }
      }));

      // 5. Measure per-face mouth movement over representative solo-turn stretches when requested and >= 2 speakers exist.
      const mouthByCamera = new Map<string, MouthActivityReading>();
      if (includeMouthActivity && turnData.speakers.length >= 2 && turnData.turns.length) {
        const stretches = selectMouthActivityStretches(turnData.turns, turnData.crosstalk, duration);
        if (stretches.length) {
          await Promise.all(cameras.map(async cam => {
            const sourceStretches = mapStretchesToCameraSource(cam, stretches);
            if (!sourceStretches.length) return;
            try {
              const res = await client.post<MouthActivityReading>(
                `/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(cam.mediaId)}/mouth-activity?wait=15`,
                { stretches: sourceStretches },
              );
              if (res?.faces) mouthByCamera.set(cam.mediaId, res);
              if (res && !res.done) {
                readingNotes.push(`${cam.mediaId}: mouth movement analysis still reading; call again for complete readings`);
              }
            } catch (err) {
              withoutOnce(`mouth movement on ${cam.mediaId}`, undefined)(err);
            }
          }));
        }
      }

      // 6. Correlate speakers with camera angles using face counts/boxes, mouth movement, scratch audio, and direct audio ownership.
      const cameraReports = correlateSpeakersToCameras({
        cameras,
        speakers: turnData.speakers,
        turns: turnData.turns,
        crosstalk: turnData.crosstalk,
        facesByCamera,
        mouthByCamera,
        scratchLevelsByCamera: levelsMap,
      });

      // 7. Run timeline sync verification reusing the loaded envelopes.
      const syncPairs = await timelineSync(tl, project.media, project.settings.fps, levelsFromMap(envelopes, assets))
        .catch(() => []);
      const names = new Map(project.media.map(m => [m.id, m.name]));
      const syncText = syncSummary(syncPairs, names, project.settings.fps);

      // Page turns cleanly within `resultChars`.
      const budget = caps.resultChars ?? DEFAULT_RESULT_CHARS;
      const pageAll = turnData.turns.slice(offset, offset + TURNS_PER_PAGE);
      const buildResponse = (turnLimit: number) => {
        const shown = pageAll.slice(0, turnLimit);
        const left = turnData.turns.length - offset - shown.length;
        return {
          version: tl.version,
          duration,
          ...(range && { range: [round3(range.start), round3(range.end)] }),
          turnSource,
          cameras: cameraReports,
          audibleTracks: audible.map(a => ({ trackId: a.trackId, name: a.trackName, mediaId: a.mediaId, coveredSeconds: a.coveredSeconds })),
          speakers: turnData.speakers,
          turnCount: turnData.turns.length,
          turns: shown,
          ...(turnData.crosstalk.length && { crosstalk: turnData.crosstalk.slice(0, 60) }),
          ...(syncPairs.length && { sync: { pairs: syncPairs, ...(syncText && { summary: syncText }) } }),
          ...(readingNotes.length && { reading: readingNotes }),
          ...(left > 0 && { next: `Call again with offset=${offset + shown.length} for the next ${Math.min(TURNS_PER_PAGE, left)} turn(s).` }),
        };
      };
      let count = pageAll.length;
      while (count > 5 && JSON.stringify(buildResponse(count)).length > budget) count = Math.floor(count * 0.75);
      return json(buildResponse(count));
    },
  );

  // -------------------------------------------------------------------------
  // 3. timeline_switch_cameras
  // -------------------------------------------------------------------------
  tool(
    "timeline_switch_cameras",
    "Switch the active camera angle over timeline ranges without touching audio or sync. " +
      "Each switch pulls the exact synced, drift-compensated footage (including any internal dialogue cuts) from that camera's synced angle track on the current version, snaps edges within half a frame of an existing cut (or onto project frames), and refuses any stretch where the chosen camera has no footage instead of leaving black gaps. " +
      "Because audio runs continuously on dedicated audio tracks underneath, placing a switch slightly before or after a speaker turn naturally creates an L-cut or J-cut without touching audio. " +
      "Re-calling this tool on any stretch cleanly switches that stretch to another angle non-destructively.",
    {
      intent: intentInput,
      switches: z.array(z.object({
        from: z.number().finite().nonnegative().describe("Timeline start seconds for this camera angle"),
        to: z.number().finite().positive().describe("Timeline end seconds for this camera angle"),
        mediaId: z.string().describe("Camera video mediaId to show during [from, to]"),
        label: z.string().optional().describe("Short label for the placed clip (e.g. 'Host', 'Guest', 'Wide')"),
        reason: z.string().trim().min(1).max(400).optional().describe("Optional plain-English reason for this specific switch"),
      })).min(1).max(500).describe("Non-overlapping timeline intervals to switch to the chosen camera angle"),
      programTrackId: z.string().optional().describe("Video track to switch angles on. Defaults to the first visible video track (v1)."),
      fromVersion: z.string().optional().describe("Version the switches apply to. Defaults to the version you last read."),
      description: z.string().min(1).default("Switch camera angles").describe("One short sentence for the chat about what changed"),
      batchTitle: z.string().trim().min(1).max(80).optional().describe("Short plain-English group title for the edits list when making multiple camera switches (e.g. '14 multi-cam angle switches')"),
      reason: editReasonInput,
      timelineEdits: timelineEditsInput,
      noteIds: z.array(z.string()).optional(),
    },
    async ({ intent, switches, programTrackId, fromVersion, description, batchTitle, reason, timelineEdits, noteIds }) => {
      const { project } = await getProject();
      const before = fromVersion ? await peekTimeline(fromVersion) : await baseTimeline();
      if (before.version === "draft") throw new Error("There is no saved timeline to switch cameras on yet. Sync cameras first with timeline_sync_multicam.");

      const { ops, report } = switchCameraOps(before, project.media, project.settings.fps, switches, { programTrackId });
      const names = new Map(project.media.map(m => [m.id, m.name]));

      // Auto-populate individual review spots for each switch when the caller didn't supply explicit `timelineEdits`
      // and a reason is available, so the editor's list groups them cleanly under `batchTitle`.
      const autoEdits = !timelineEdits && switches.length <= 100 && switches.every(s => s.reason || reason)
        ? [...switches]
          .sort((a, b) => a.from - b.from)
          .map(s => ({
            label: (s.label ? `Cut to ${s.label}` : `Cut to ${names.get(s.mediaId) ?? s.mediaId}`).slice(0, 50),
            range: { start: round3(s.from), end: round3(s.to) },
            reason: s.reason ?? reason!,
          }))
        : timelineEdits;

      const defaultBatchTitle = !batchTitle && switches.length > 1
        ? `${switches.length} camera angle switches`
        : batchTitle;

      const saved = await propose({
        intent,
        ops,
        description,
        ...(defaultBatchTitle && { batchTitle: defaultBatchTitle }),
        reason,
        timelineEdits: autoEdits,
        noteIds,
      }, before);

      return {
        ...saved,
        content: [
          ...saved.content,
          { type: "text", text: JSON.stringify(report) },
        ],
      };
    },
  );
}
