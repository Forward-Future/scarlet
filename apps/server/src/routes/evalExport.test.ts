import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createProject, timelineFromKeepRanges, type Change, type Project } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";

let directory: string;
let workspace: ScarletApp;
let project: Project;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-eval-export-test-"));
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: () => {} });
  project = workspace.ctx.repos.projects.insert(createProject("Interview"));
  workspace.ctx.repos.projects.putMedia(project.id, { id: "camera", kind: "video", name: "Interview", path: "a.mp4", duration: 15 }, "ready");
});
afterEach(async () => {
  await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

async function api<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await workspace.app.request("/api" + path, { method, body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${accessToken(workspace.ctx)}`, ...(body !== undefined && { "Content-Type": "application/json" }) } });
  return { status: res.status, body: await res.json() as T };
}
/** A first cut of the interview that takes out 2–4 s and 7–10 s, waiting for the editor. */
async function firstCut(extra: object = {}) {
  const timeline = timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 2 }, { start: 4, end: 7 }, { start: 10, end: 15 }]);
  const { status, body } = await api<{ change: Change }>("POST", `/projects/${project.id}/changes`, { description: "First cut", timeline, intent: "suggestion", ...extra });
  expect(status).toBe(201);
  return body.change;
}
const exported = async (query = "") => (await api("GET", `/projects/${project.id}/review-decisions${query}`)).body.changes as Array<Record<string, any>>;
const decisions = (change: Record<string, any>) => change.cuts.map((cut: { decision: string }) => cut.decision);

it("exports each cut of a dialogue pass with what it removed from the source and where the editor's call stands", async () => {
  const change = await firstCut();
  const [pending, ...none] = await exported();
  expect(none).toEqual([]);
  expect(pending).toMatchObject({ id: change.id, intent: "suggestion", state: "ready", fromVersion: change.fromVersion, toVersion: change.toVersion, firstCut: true });
  // A cut with no reason of its own carries the pass's description.
  expect(pending!.cuts).toEqual([
    { index: 0, removed: { start: 2, end: 4 }, sources: [{ mediaId: "camera", start: 2, end: 4 }], reasons: ["First cut"], decision: "pending" },
    { index: 1, removed: { start: 7, end: 10 }, sources: [{ mediaId: "camera", start: 7, end: 10 }], reasons: ["First cut"], decision: "pending" },
  ]);

  // Scarlet's second look at a cut travels with it.
  const assessed = await api("POST", `/changes/${change.id}/cut-assessments`, { fromVersion: change.fromVersion, toVersion: change.toVersion,
    assessments: [{ index: 1, start: 7, end: 10, verdict: "keep", inspected: true, reason: "The retake is cleaner." }] });
  expect(assessed.status).toBe(200);
  expect((await exported())[0]!.cuts.map((cut: { assessment?: object }) => cut.assessment)).toEqual([undefined, { verdict: "keep", reason: "The retake is cleaner.", inspected: true }]);

  // The editor puts the first cut back and takes the second.
  expect((await api("POST", `/changes/${change.id}/approve`, { restoredCuts: [0] })).status).toBe(200);
  const [decided] = await exported();
  expect(decided).toMatchObject({ state: "approved", restoredCuts: [0], appliedVersion: expect.any(String), decidedBy: expect.objectContaining({ name: expect.any(String) }) });
  expect(decisions(decided!)).toEqual(["skipped", "approved"]);
});

it("counts a rejected pass as every cut skipped, and one approved whole as every cut taken", async () => {
  const rejected = await firstCut();
  await api("POST", `/changes/${rejected.id}/reject`, { reason: "Start over" });
  expect(decisions((await exported())[0]!)).toEqual(["skipped", "skipped"]);
  const taken = await firstCut({ description: "Second try" });
  expect((await api("POST", `/changes/${taken.id}/approve`, {})).status).toBe(200);
  const all = await exported();
  expect(all.map(c => c.id)).toEqual([rejected.id, taken.id]);
  expect(decisions(all[1]!)).toEqual(["approved", "approved"]);
  // Approved by spot, before cuts could be called one by one: which cuts went in isn't recorded.
  workspace.ctx.repos.changes.put({ ...workspace.ctx.repos.changes.get(taken.id)!, restoredCuts: undefined, approvedSpots: [0] });
  expect(decisions((await exported())[1]!)).toEqual(["unknown", "unknown"]);
});

it("hears nothing from a source with no sound, and leaves out edits that aren't a pass to review", async () => {
  workspace.ctx.repos.projects.putMedia(project.id, { id: "camera", kind: "video", name: "Screen", path: "a.mp4", duration: 15, hasAudio: false }, "ready");
  const silent = await firstCut();
  expect((await exported())[0]!.cuts.map((cut: { sources: unknown[] }) => cut.sources)).toEqual([[], []]);
  // An edit that only adds a marker removes nothing, and one the editor asked for directly isn't a suggestion.
  await api("POST", `/projects/${project.id}/changes`, { description: "Label", intent: "suggestion", ops: [{ op: "addMarker", marker: { id: "m", time: 0, text: "Start" } }] });
  expect((await exported()).map(c => c.id)).toEqual([silent.id]);
  // A pass whose versions are gone can't be laid out again, and is left out instead of failing the export.
  workspace.ctx.db.prepare("DELETE FROM timeline_versions WHERE project_id = ? AND version = ?").run(project.id, silent.toVersion);
  expect(await exported()).toEqual([]);
});

it("exports one run's passes when asked for it, and answers 404 for a project that isn't there", async () => {
  const mine = await firstCut();
  workspace.ctx.repos.changes.put({ ...workspace.ctx.repos.changes.get(mine.id)!, taskId: "tsk_mine" });
  const other = await firstCut({ description: "Another run" });
  expect((await exported()).map(c => c.id)).toEqual([mine.id, other.id]);
  expect(await exported("?taskId=tsk_mine")).toMatchObject([{ id: mine.id, taskId: "tsk_mine" }]);
  expect(await exported("?taskId=tsk_nobody")).toEqual([]);
  const missing = await api("GET", "/projects/prj_gone/review-decisions");
  expect([missing.status, missing.body.error.code]).toEqual([404, "not_found"]);
});
