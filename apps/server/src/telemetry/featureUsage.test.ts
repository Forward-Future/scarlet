import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FEATURE_NAMES, featureForRequest } from "@scarlet/shared";

it.each([
  ["POST", "/projects", "project.create"],
  ["PATCH", "/projects/p1", "project.update"],
  ["DELETE", "/projects/p1", "project.trash"],
  ["POST", "/projects/p1/versions/3/revert", "version.revert"],
  ["GET", "/projects/p1/versions/3/export.otio", "timeline.export_otio"],
  ["GET", "/projects/p1/versions/3/export.srt", "timeline.export_srt"],
  ["GET", "/projects/p1/versions/3/export.vtt", "timeline.export_vtt"],
  ["POST", "/projects/p1/versions/3/handoff", "timeline.export_handoff"],
  ["POST", "/changes/c1/approve", "change.approve"],
  ["POST", "/projects/p1/media", "media.upload"],
  ["POST", "/projects/p1/media/import", "media.import"],
  ["POST", "/speech", "speech.dictate"],
  ["PATCH", "/settings", "settings.update"],
  ["POST", "/skills", "skill.create"],
  ["POST", "/skills/from-change", "skill.from_change"],
  ["POST", "/skills/s1/edit", "skill.edit"],
  ["POST", "/projects/p1/tasks/t1/skill", "skill.from_task"],
  ["POST", "/projects/p1/tasks/t1/skill-edit", "skill.edit_from_task"],
  ["POST", "/tasks/t1/cancel", "task.cancel"],
  ["POST", "/tasks/t1/continue-when-ready", "task.continue_when_ready"],
  ["POST", "/projects/sample", "project.create_sample"],
  ["POST", "/tasks/t1/hold", "task.hold"],
  ["POST", "/tasks/t1/start-now", "task.start_now"],
  ["POST", "/tasks/t1/reword", "task.reword"],
  ["POST", "/projects/p1/attachments", "message.attach"],
  ["POST", "/projects/p1/stop-editing", "editing.stop"],
  ["POST", "/projects/p1/resume-editing", "editing.resume"],
  ["POST", "/projects/p1/kept-edits", "edit.keep_confident"],
  ["POST", "/projects/p1/kept-edits/undo", "edit.keep_confident_undo"],
  ["POST", "/projects/p1/learnings/l1/approve", "learning.approve"],
  ["PATCH", "/projects/p1/learnings/l1", "learning.revise"],
  ["POST", "/projects/p1/learnings/l1/decline", "learning.decline"],
  ["DELETE", "/projects/p1/media/m1", "media.remove"],
  ["PUT", "/media/m1/note", "media.note"],
  ["POST", "/style-guides", "style_guide.create"],
  ["POST", "/style-guides/from-graphic", "style_guide.from_graphic"],
  ["POST", "/style-guides/import-file", "style_guide.import_file"],
  ["PUT", "/style-guides/g1", "style_guide.update"],
  ["POST", "/style-guides/g1/edit", "style_guide.edit"],
  ["DELETE", "/style-guides/g1", "style_guide.delete"],
  ["POST", "/style-guides/g1/assets", "style_guide.asset_add"],
  ["DELETE", "/style-guides/g1/assets/a1", "style_guide.asset_delete"],
  ["PUT", "/settings/youtube/config", "youtube.configure"],
  ["POST", "/settings/youtube/connect", "youtube.connect"],
  ["POST", "/settings/youtube/disconnect", "youtube.disconnect"],
  ["POST", "/projects/p1/youtube/publish", "youtube.publish"],
  ["POST", "/youtube/uploads/u1/cancel", "youtube.cancel_upload"],
])("counts %s %s as %s", (method, path, feature) => {
  expect(featureForRequest(method, path)).toBe(feature);
});

it.each([
  ["GET", "/projects"],
  ["GET", "/projects/p1"],
  ["GET", "/settings"],
  ["POST", "/projects/p1/tasks"],
  ["POST", "/tasks/t1/complete"],
  ["POST", "/projects/p1/renders"],
  ["POST", "/hosts/register"],
  ["POST", "/projects/p1/media/import-frame"],
  ["POST", "/projects/p1/media/m1/prepare"],
  ["POST", "/projects/p1/picture-activity"],
  ["POST", "/skills/s1/stock"],
  ["PUT", "/projects/p1"],
  ["GET", "/changes/c1/approve"],
])("leaves %s %s out", (method, path) => {
  expect(featureForRequest(method, path)).toBeUndefined();
});

it("matches whole paths only", () => {
  expect(featureForRequest("POST", "/projects/")).toBeUndefined();
  expect(featureForRequest("POST", "/api/projects")).toBeUndefined();
  expect(featureForRequest("PATCH", "/projects/a/b")).toBeUndefined();
  expect(featureForRequest("GET", "/projects/p1/versions/3/exportXotio")).toBeUndefined();
});

it("counts both paths to the same action as one feature", () => {
  expect(featureForRequest("PATCH", "/notes/n1")).toBe("note.update");
  expect(featureForRequest("PATCH", "/projects/p1/notes/n1")).toBe("note.update");
  expect(featureForRequest("PUT", "/changes/c1/cut-choices")).toBe("change.cut_choices");
  expect(featureForRequest("PUT", "/projects/p1/changes/c1/cut-choices")).toBe("change.cut_choices");
  expect(featureForRequest("POST", "/changes/c1/staged-cuts/2")).toBe("change.revise_cut");
  expect(featureForRequest("POST", "/projects/p1/changes/c1/staged-cuts/2")).toBe("change.revise_cut");
});

it("names each feature once, as area.action", () => {
  expect(new Set(FEATURE_NAMES).size).toBe(FEATURE_NAMES.length);
  for (const name of FEATURE_NAMES) expect(name).toMatch(/^[a-z_]+\.[a-z_]+$/);
});

/**
 * Requests that change something but aren't an editor's choice: agent tooling, host housekeeping, playback and preview
 * work, and requests with an event of their own (tasks, renders, edit reviews). Everything else that writes is counted.
 */
const NOT_FEATURES = new Set([
  "POST /hosts/register", "POST /hosts/:x/heartbeat", "POST /hosts/:x/claim", "POST /hosts/quota/refresh",
  "POST /projects/:x/tasks", "POST /tasks/:x/complete", "POST /projects/:x/renders", "DELETE /renders/:x/owners/:x",
  "POST /projects/:x/edit-reviews", "POST /projects/:x/thread-edits", "POST /projects/:x/batch-summaries",
  "POST /media/expand-paths", "POST /projects/:x/media/import-frame", "POST /projects/:x/media/:x/prepare",
  "POST /projects/:x/versions/:x/cut-playback-file", "POST /projects/:x/versions/:x/prepare-playback",
  "POST /projects/:x/hand-off", "POST /projects/:x/tasks/:x/learnings", "POST /projects/:x/tasks/:x/style-guide-edit",
  "POST /projects/:x/tasks/:x/repeat-audit", "POST /projects/:x/tasks/:x/tool-diagnostic",
  "POST /projects/:x/contact-sheet", "POST /projects/:x/timeline-pictures", "POST /projects/:x/picture-activity",
  "POST /projects/:x/review-cut", "POST /projects/:x/sound-picture", "POST /projects/:x/source-audio",
  "POST /projects/:x/listen", "POST /projects/:x/documents/read", "POST /projects/:x/edit-flags",
  "POST /projects/:x/dialogue-acoustic-words", "POST /projects/:x/dialogue-checkpoints",
  "POST /projects/:x/dialogue-detections", "POST /projects/:x/dialogue-scan", "POST /projects/:x/dialogue-verbatim",
  "POST /projects/:x/transcripts/fix", "POST /projects/:x/media/:x/realign", "POST /projects/:x/media/:x/mouth-activity",
  "POST /projects/:x/media/:x/other-input", "POST /projects/:x/media/:x/show-area",
  "POST /projects/:x/media/:x/show-area/ask", "POST /projects/:x/media/from-style-sound", "POST /projects/:x/graphics",
  "PUT /projects/:x/style-guide", "DELETE /projects/:x/style-guide", "POST /projects/:x/web-captures",
  "POST /projects/:x/web-videos", "POST /style-guides/:x/assets/:x/read", "POST /style-guides/:x/preview",
  "POST /settings/youtube/cancel", "POST /changes/:x/cut-review", "POST /projects/:x/changes/:x/cut-review",
  "POST /changes/:x/cut-assessments", "POST /projects/:x/changes/:x/cut-assessments", "POST /notes/:x/reply",
  "POST /projects/:x/notes/:x/reply", "POST /tasks/:x/question", "POST /projects/:x/tasks/:x/question",
  "POST /tasks/:x/events", "POST /projects/:x/tasks/:x/events", "POST /tasks/:x/usage", "POST /projects/:x/tasks/:x/usage",
]);

it("counts every request that changes something, unless it is listed as not an editor's choice", () => {
  const routes = new Set<string>();
  const dir = join(import.meta.dirname, "..", "routes");
  for (const file of readdirSync(dir).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
    const source = readFileSync(join(dir, file), "utf8");
    for (const [, method, path] of source.matchAll(/\b\w+\.(post|put|patch|delete)\(\s*"([^"]+)"/g)) routes.add(`${method!.toUpperCase()} ${path}`);
    for (const [, method, paths] of source.matchAll(/\b\w+\.on\(\s*"(POST|PUT|PATCH|DELETE)",\s*\[([^\]]+)\]/g)) {
      for (const [, path] of paths!.matchAll(/"([^"]+)"/g)) routes.add(`${method} ${path}`);
    }
  }
  expect(routes.size).toBeGreaterThan(50);
  const normal = (route: string) => route.replace(/:[A-Za-z]+/g, ":x");
  const uncounted = [...routes].filter(route => {
    const [method, path] = route.split(" ") as [string, string];
    return !featureForRequest(method, path.replace(/:[A-Za-z]+/g, "x1")) && !NOT_FEATURES.has(normal(route));
  });
  expect(uncounted).toEqual([]);
  const stale = [...NOT_FEATURES].filter(route => ![...routes].some(r => normal(r) === route));
  expect(stale).toEqual([]);
});
