import { z } from "zod/v3";

/** This reference stays between the editor and its local engine. Only a keyed digest leaves the installation. */
export const EditReviewRequest = z.object({
  changeId: z.string().min(1).max(256),
  spot: z.number().int().nonnegative().safe(),
  decision: z.enum(["keep", "revise", "undo"]),
}).strict();
export type EditReviewRequest = z.infer<typeof EditReviewRequest>;

/** Which build an install runs: a public release package, or anything built from source (dev, local-main, review apps). */
export const TELEMETRY_CHANNELS = ["release", "dev"] as const;
export type TelemetryChannel = (typeof TELEMETRY_CHANNELS)[number];

/**
 * Why a request or an export failed, as a fixed category the engine reads off the failure locally. The failure's own
 * words never leave the installation.
 */
export const FAILURE_REASONS = [
  "agent_not_installed",
  "agent_not_signed_in",
  "rate_limited",
  "model_unavailable",
  "provider_error",
  "tools_unavailable",
  "timeout",
  "interrupted",
  "crashed",
  "transcription_model_missing",
  "media_unreadable",
  "out_of_disk",
  "network",
  "other",
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

/** How long a recording added to a project runs. */
export const MEDIA_DURATION_BUCKETS = ["lt_1m", "1_10m", "10_30m", "30_60m", "gt_60m"] as const;
export type MediaDurationBucket = (typeof MEDIA_DURATION_BUCKETS)[number];

export function mediaDurationBucket(seconds: number): MediaDurationBucket {
  if (seconds < 60) return "lt_1m";
  if (seconds < 600) return "1_10m";
  if (seconds < 1800) return "10_30m";
  if (seconds < 3600) return "30_60m";
  return "gt_60m";
}

/** The ways an edit leaves Scarlet. */
export const EXPORT_ROUTES = ["render", "handoff", "otio", "srt", "vtt"] as const;
export type ExportRoute = (typeof EXPORT_ROUTES)[number];

/**
 * The requests counted as feature use: things an editor (or an agent on their behalf) chose to do. The names are
 * fixed, so no path, id or free text can reach analytics. Polling, host housekeeping and agent tooling are left out,
 * and so is anything with its own event (tasks and exports).
 */
const FEATURES = [
  ["POST", "/projects", "project.create"],
  ["PATCH", "/projects/:id", "project.update"],
  ["DELETE", "/projects/:id", "project.trash"],
  ["POST", "/projects/:id/restore", "project.restore"],
  ["POST", "/projects/:id/threads/:threadId/disposition", "thread.file"],

  ["POST", "/projects/:id/import/otio", "timeline.import_otio"],
  ["GET", "/projects/:id/versions/:v/export.otio", "timeline.export_otio"],
  ["GET", "/projects/:id/versions/:v/export.srt", "timeline.export_srt"],
  ["GET", "/projects/:id/versions/:v/export.vtt", "timeline.export_vtt"],
  ["POST", "/projects/:id/versions/:v/handoff", "timeline.export_handoff"],
  ["POST", "/projects/:id/branches", "branch.create"],
  ["POST", "/projects/:id/versions/:v/restore", "version.restore"],
  ["POST", "/projects/:id/versions/:v/revert", "version.revert"],
  ["POST", "/projects/:id/rejected-edits", "edit.reject"],
  ["POST", "/projects/:id/versions/:v/checkout", "version.checkout"],

  ["POST", "/projects/:id/changes", "change.propose"],
  ["POST", "/projects/:id/dialogue-cuts", "dialogue_cuts.propose"],
  ["POST", "/changes/:changeId/approve", "change.approve"],
  ["POST", "/changes/:changeId/unapprove", "change.unapprove"],
  ["POST", "/changes/:changeId/reject", "change.reject"],
  ["POST", "/changes/:changeId/reopen", "change.reopen"],
  ["POST", "/changes/:changeId/revise", "change.revise"],
  ["PUT", "/changes/:changeId/cut-choices", "change.cut_choices"],
  ["PUT", "/projects/:projectId/changes/:changeId/cut-choices", "change.cut_choices"],
  ["POST", "/changes/:changeId/staged-cuts/:index", "change.revise_cut"],
  ["POST", "/projects/:projectId/changes/:changeId/staged-cuts/:index", "change.revise_cut"],

  ["POST", "/projects/:id/notes", "note.create"],
  ["POST", "/projects/:id/notes/voice", "note.voice"],
  ["PATCH", "/notes/:noteId", "note.update"],
  ["PATCH", "/projects/:projectId/notes/:noteId", "note.update"],
  ["POST", "/speech", "speech.dictate"],

  ["PATCH", "/settings", "settings.update"],
  ["POST", "/storage/cleanup", "storage.cleanup"],

  ["PUT", "/media/:mediaId/voice-roles", "media.voice_roles"],
  ["PUT", "/media/:mediaId/audio-track", "media.audio_track"],
  ["POST", "/projects/:id/media", "media.upload"],
  ["POST", "/projects/:id/media/import", "media.import"],
  ["POST", "/media/:mediaId/transcribe", "media.transcribe"],

  ["POST", "/skills", "skill.create"],
  ["PUT", "/skills/:skillId", "skill.update"],
  ["POST", "/skills/:skillId/edit", "skill.edit"],
  ["DELETE", "/skills/:skillId", "skill.delete"],
  ["POST", "/skills/from-change", "skill.from_change"],
  ["POST", "/projects/:id/tasks/:taskId/skill", "skill.from_task"],
  ["POST", "/projects/:id/tasks/:taskId/skill-edit", "skill.edit_from_task"],

  ["POST", "/tasks/:taskId/cancel", "task.cancel"],
  ["POST", "/tasks/:taskId/retry", "task.retry"],
  ["POST", "/tasks/:taskId/continue-when-ready", "task.continue_when_ready"],
  ["POST", "/tasks/:taskId/answer", "task.answer"],
] as const;

export type Feature = (typeof FEATURES)[number][2];

export const FEATURE_NAMES: readonly Feature[] = [...new Set(FEATURES.map(([, , feature]) => feature))];

const MATCHERS = FEATURES.map(([method, route, feature]) => ({
  method,
  feature,
  path: new RegExp(`^${route.replace(/[.]/g, "\\.").replace(/:[A-Za-z]+/g, "[^/]+")}$`),
}));

/** `path` is the request path below /api. */
export function featureForRequest(method: string, path: string): Feature | undefined {
  return MATCHERS.find(matcher => matcher.method === method && matcher.path.test(path))?.feature;
}
