import { z } from "zod/v3";

/** This reference stays between the editor and its local engine. Only a keyed digest leaves the installation. */
export const EditReviewRequest = z.object({
  changeId: z.string().min(1).max(256),
  spot: z.number().int().nonnegative().safe(),
  decision: z.enum(["keep", "revise", "undo"]),
}).strict();
export type EditReviewRequest = z.infer<typeof EditReviewRequest>;

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
  ["POST", "/projects/:id/branches", "branch.create"],
  ["POST", "/projects/:id/versions/:v/restore", "version.restore"],
  ["POST", "/projects/:id/versions/:v/revert", "version.revert"],
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
