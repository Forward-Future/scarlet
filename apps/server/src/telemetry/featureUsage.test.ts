import { expect, it } from "vitest";
import { FEATURE_NAMES, featureForRequest } from "@scarlet/shared";

it.each([
  ["POST", "/projects", "project.create"],
  ["PATCH", "/projects/p1", "project.update"],
  ["DELETE", "/projects/p1", "project.trash"],
  ["POST", "/projects/p1/versions/3/revert", "version.revert"],
  ["GET", "/projects/p1/versions/3/export.otio", "timeline.export_otio"],
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
