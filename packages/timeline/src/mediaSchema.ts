/** Media in a project: the files it uses, where they came from, and their transcripts. */
import { z } from "zod/v3";
import { Id, Seconds } from "./schemaBase.js";

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export const MediaKind = z.enum(["video", "audio", "image", "graphic"]);
export type MediaKind = z.infer<typeof MediaKind>;

/** Source previews are independently playable MP4s on this fixed time grid. */
export const SOURCE_PREVIEW_SECONDS = 8;

/** Default output height for preview renders and source proxies. */
export const DEFAULT_PREVIEW_HEIGHT = 540;

/** Who or what produced an asset. */
export const Provenance = z.object({
  /** "human" | "agent" | "scarlet" */
  by: z.enum(["human", "agent", "scarlet"]),
  name: z.string().optional(),
  model: z.string().optional(),
  prompt: z.string().optional(),
  /** Change that introduced the asset, if any. */
  changeId: Id.optional(),
  /** The run that added it, set by the engine from the run's own attempt. */
  taskId: Id.optional(),
  createdAt: z.string().datetime().optional(),
});
export type Provenance = z.infer<typeof Provenance>;

/** The part of a picture in use, as fractions of its width and height. */
export const FrameBox = z.object({
  left: z.number().min(0).max(1), top: z.number().min(0).max(1), right: z.number().min(0).max(1), bottom: z.number().min(0).max(1),
}).refine(b => b.right > b.left && b.bottom > b.top, "right and bottom must be past left and top");
export type FrameBox = z.infer<typeof FrameBox>;

/**
 * Where a picture or clip from outside the project came from, such as an article or a post Scarlet framed as B-roll:
 * the page's address, when it was captured, the page as captured and the part of it in the video.
 */
export const WebSource = z.object({
  url: z.string().trim().max(2048).url().refine(u => /^https?:\/\//i.test(u), "a web address"),
  capturedAt: z.string().datetime().optional(),
  /** The page as captured, an image relative to the project's folder. */
  capture: z.string().optional(),
  /** The part of the capture in the video. */
  region: FrameBox.optional(),
});
export type WebSource = z.infer<typeof WebSource>;

/** One-based audio stream ordinals confirmed for this particular recording. */
export const DialogueVoiceRoles = z.object({
  me: z.number().int().min(1).max(3), other: z.number().int().min(1).max(3),
}).refine(v => v.me !== v.other, "Choose two different isolated inputs");
export type DialogueVoiceRoles = z.infer<typeof DialogueVoiceRoles>;

/** Metadata for one audio stream inside a media container (`0:a:index`). */
export const AudioStreamInfo = z.object({
  /** Zero-based index among the file's audio streams (`0:a:index`). */
  index: z.number().int().nonnegative(),
  codec: z.string().optional(),
  channels: z.number().int().positive().optional(),
  sampleRate: z.number().int().positive().optional(),
  language: z.string().optional(),
  title: z.string().optional(),
});
export type AudioStreamInfo = z.infer<typeof AudioStreamInfo>;

/** Which audio stream(s) to read from a multi-track recording: a zero-based stream index or `"all"` to mix every track. */
export const AudioTrackSelection = z.union([z.literal("all"), z.number().int().nonnegative()]);
export type AudioTrackSelection = z.infer<typeof AudioTrackSelection>;

export const MediaAsset = z.object({
  voiceRoles: DialogueVoiceRoles.optional(),
  /** All probed audio streams for recordings with multiple audio tracks (e.g. OBS, podcasts). */
  audioStreams: z.array(AudioStreamInfo).optional(),
  /** Selected audio stream index or `"all"` to mix all streams. Absent means the first audio stream (`0`). */
  audioTrack: AudioTrackSelection.optional(),
  id: Id,
  /** The desktop import that created this asset, retained so retrying that request returns the same file. */
  importId: z.string().uuid().optional(),
  kind: MediaKind,
  /** Human-facing name, usually the original filename. */
  name: z.string(),
  /** Storage key relative to the project's media root. */
  path: z.string(),
  /** Content hash (sha256 hex) so renders can be cached by content. */
  hash: z.string().optional(),
  fingerprintStamp: z.object({ size: z.number().nonnegative(), mtimeMs: z.number(), ctimeMs: z.number() }).optional(),
  /** Source clock needed to place an independently decoded proxy chunk on an exact frame. */
  previewClock: z.object({ frameRate: z.string(), startPts: z.number(), videoStart: z.number().optional() }).optional(),
  /** MIME type and codecs of the probed original, for the native player's canPlayType check. */
  originalPlaybackType: z.string().optional(),
  previewMode: z.literal("on-demand").optional(),
  duration: Seconds.optional(),
  fps: z.number().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  hasAudio: z.boolean().optional(),
  hasAlpha: z.boolean().optional(),
  /**
   * The colour a moving picture's file declares: an HDR transfer, which every picture Scarlet makes from it tone-maps
   * to SDR, a camera Log curve it names, and its colour tags when they aren't BT.709. `{}` for ordinary SDR. Absent on
   * a file imported before Scarlet read colour, until it is read.
   */
  color: z.object({
    hdr: z.enum(["hlg", "pq"]).optional(),
    log: z.string().optional(),
    primaries: z.string().optional(),
    transfer: z.string().optional(),
    bitDepth: z.number().int().positive().optional(),
  }).optional(),
  /** Automatic transcription permitted at import, retained across interrupted preparation. */
  transcriptionOnImport: z.enum(["openai", "whispercpp"]).optional(),
  /** Provider revision when imported. An older import without it needs a new transcription request. */
  transcriptionRevisionOnImport: z.number().int().nonnegative().optional(),
  /** Transcript id for media with speech. */
  transcriptId: Id.optional(),
  /** Last successful transcription, preserved when its words are relabelled or a new attempt fails. */
  lastTranscription: z.object({
    completedAt: z.string().datetime().optional(),
    /** Recorded model name, without local directory paths. */
    model: z.string().optional(),
  }).optional(),
  provenance: Provenance.optional(),
  /** Where it came from on the web, shown on the card of the edit that uses it. */
  source: WebSource.optional(),
  /** A graphic Scarlet drew from a web page: the page it keeps, so a later request can revise it. */
  graphic: z.object({
    /** The page, relative to the project's folder. Files it links to sit beside it. */
    source: z.string(),
    /** Earlier builds filled graphics from saved templates. Kept so those projects still open. */
    templateId: Id.optional(),
    fields: z.record(z.string()).optional(),
  }).optional(),
  /** Authenticated user who uploaded or imported the asset. */
  uploadedBy: Id.optional(),
  /** Server-side ingest state. Absent means ready. */
  status: z.enum(["ingesting", "ready", "failed"]).optional(),
  preparation: z.object({
    stage: z.enum(["preview", "waveform", "fingerprint"]),
    fraction: z.number().min(0).max(1),
    remainingSeconds: z.number().nonnegative().optional(),
  }).optional(),
  error: z.string().optional(),
});
export type MediaAsset = z.infer<typeof MediaAsset>;

/** Waveform extraction starts only after the source audio or finished video proxy is playable. */
export function isPlayableMedia(media: MediaAsset): boolean {
  if (media.kind !== "audio" && media.kind !== "video") return false;
  return (media.status === "ingesting" && media.preparation?.stage === "fingerprint") || media.preparation?.stage === "waveform" || media.status === "ready" || (media.status === undefined && !!media.duration);
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

export const TranscriptWord = z.object({
  /** Recording-local voice number established from the audio. */
  detectedSpeaker: z.number().int().positive().optional(),
  /** Input behind a speaker-role annotation in a saved transcript revision. */
  voiceRoleInput: z.number().int().min(1).max(3).optional(),
  /** Attribution to an isolated input stream, separate from speaker identity. */
  audioSource: z.string().optional(),
  text: z.string(),
  start: Seconds,
  end: Seconds,
  confidence: z.number().min(0).max(1).optional(),
  speaker: z.string().optional(),
});
export type TranscriptWord = z.infer<typeof TranscriptWord>;

export const TranscriptSegment = z.object({
  id: Id,
  start: Seconds,
  end: Seconds,
  text: z.string(),
  speaker: z.string().optional(),
  words: z.array(TranscriptWord).default([]),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegment>;

/**
 * A spelling the editor corrected across a transcript: the words that read `find` read `replace`, with their times.
 * Kept on the transcript so a transcription made again, or its words placed again, reads the same.
 * `from`/`to`: the source seconds the fix was limited to.
 */
export const TranscriptWordFix = z.object({
  find: z.string().min(1),
  replace: z.string().min(1),
  from: Seconds.optional(),
  to: Seconds.optional(),
});
export type TranscriptWordFix = z.infer<typeof TranscriptWordFix>;

export const LocalTranscriptionModel = z.enum(["crisperwhisper", "whispercpp", "custom"]);
export type LocalTranscriptionModel = z.infer<typeof LocalTranscriptionModel>;

export const Transcript = z.object({
  speakerAnalysis: z.object({ version: z.number().int().positive(), count: z.number().int().nonnegative() }).optional(),
  /**
   * Present while word alignment is still under way. Words that end before `through` (source seconds) are placed on
   * the recorded audio and won't move; later words keep the provider's estimates, which can be a few hundred
   * milliseconds off. Word order and indices never change. Absent once every time is final.
   */
  aligning: z.object({ through: Seconds }).optional(),
  /** The version of the aligner that placed these word times. Absent on a transcript aligned before versions were kept. */
  alignment: z.number().int().positive().optional(),
  id: Id,
  mediaId: Id,
  language: z.string().optional(),
  provider: z.string().optional(),
  /** Actual local model that produced the words, including when the selected preset used its fallback. */
  localModel: LocalTranscriptionModel.optional(),
  /** Model or adapter recorded when these words were transcribed, retained on speaker revisions. */
  modelLabel: z.string().optional(),
  segments: z.array(TranscriptSegment).default([]),
  /** Spellings the editor corrected, in the order made. A new transcription of the recording applies them again. */
  wordFixes: z.array(TranscriptWordFix).optional(),
  createdAt: z.string().datetime().optional(),
});
export type Transcript = z.infer<typeof Transcript>;
