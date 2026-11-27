import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ATTEMPT_HEADER, TASK_HEADER } from "@scarlet/shared";
import { applyOps, createProject, timelineFromKeepRanges, type Change, type Project, type Timeline } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import { createTask } from "../services/tasks.js";
import { storeVersion } from "../services/timeline.js";

let directory: string;
let workspace: ScarletApp;
let project: Project;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-timeline-routes-test-"));
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: () => {} });
  project = workspace.ctx.repos.projects.insert(createProject("Weekly interview"));
  workspace.ctx.repos.projects.putMedia(project.id, { id: "camera", name: "interview.mov", kind: "video", path: "camera.mov", duration: 60 }, "ready");
});
afterEach(async () => {
  await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await workspace.app.request("/api" + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `Bearer ${accessToken(workspace.ctx)}`, ...(body !== undefined && { "Content-Type": "application/json" }), ...headers } });
  const text = await res.text();
  let json: any;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  return { status: res.status, json, text, headers: res.headers, code: json?.error?.code as string | undefined };
}
const path = (rest = "") => `/projects/${project.id}${rest}`;
const head = () => workspace.ctx.repos.projects.get(project.id)!.head!;
const branchOf = () => workspace.ctx.repos.projects.get(project.id)!.branch ?? "main";
const activity = (type: string) => workspace.ctx.repos.activity.select("project_id = ? AND type = ?", [project.id, type]);

/** An hour-long camera take, then a version with a pause cut from it, as a pass leaves them. */
function twoVersions() {
  const { ctx } = workspace;
  const first = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 60 }]), { parent: null, description: "Whole take" });
  const cut = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 10 }, { start: 12, end: 60 }]),
    { parent: first.version, changeId: "chg_pass", description: "Trimmed a pause" });
  ctx.repos.projects.update(project.id, { head: cut.version });
  return { first, cut };
}

it("starts a project with no edit on an empty timeline, and reads a version by its name", async () => {
  const empty = await api("GET", path("/timeline"));
  expect(empty.status).toBe(200);
  expect(empty.json.timeline).toMatchObject({ projectId: project.id, tracks: expect.any(Array) });
  expect(head()).toBe(empty.json.timeline.version);
  expect((await api("GET", path("/timeline?version=head"))).json.timeline.version).toBe(head());

  const { first, cut } = twoVersions();
  expect((await api("GET", path("/timeline"))).json.timeline.version).toBe(cut.version);
  expect((await api("GET", path(`/timeline?version=${first.version}`))).json.timeline.version).toBe(first.version);
  expect(await api("GET", path("/timeline?version=nope"))).toMatchObject({ status: 404, code: "not_found" });
  expect(await api("GET", "/projects/prj_missing/timeline")).toMatchObject({ status: 404, code: "not_found" });
});

it("lists the versions with the one in use marked, and the cut's branches", async () => {
  const { first, cut } = twoVersions();
  const { json } = await api("GET", path("/versions"));
  expect(json.versions.map((v: { version: string }) => v.version)).toEqual(expect.arrayContaining([first.version, cut.version]));
  expect(json.versions.find((v: { isHead?: boolean }) => v.isHead)).toMatchObject({ version: cut.version, parent: first.version });
  expect((await api("GET", path("/branches"))).json).toEqual({ branches: [{ name: "main", head: cut.version }] });
  expect(await api("GET", "/projects/prj_missing/versions")).toMatchObject({ status: 404 });
  expect(await api("GET", "/projects/prj_missing/branches")).toMatchObject({ status: 404 });
});

it("makes a branch from a version and switches to it, and switches back to one that exists", async () => {
  const { first, cut } = twoVersions();
  const made = await api("POST", path("/branches"), { name: "  Short cut ", from: first.version, expectedHead: cut.version, expectedBranch: "main" });
  expect(made.status).toBe(200);
  expect(made.json.project).toMatchObject({ branch: "Short cut", head: first.version });
  expect(activity("version.branch")[0]).toMatchObject({ summary: "Created branch “Short cut”",
    data: { branch: "Short cut", version: first.version, fromBranch: "main", fromVersion: cut.version, createdFrom: first.version } });
  expect((await api("GET", path("/branches"))).json.branches).toEqual(expect.arrayContaining([{ name: "Short cut", head: first.version }]));

  const back = await api("POST", path("/branches"), { name: "main", expectedHead: first.version, expectedBranch: "Short cut" });
  expect(back.status).toBe(200);
  expect(back.json.project).toMatchObject({ branch: "main", head: cut.version });
  expect(activity("version.branch").map(a => a.summary)).toContain("Switched to branch “main”");
});

it("refuses a branch with no name, from a cut that moved on, from a version it doesn't have, or one taken or unknown", async () => {
  const { first, cut } = twoVersions();
  const ask = (body: Record<string, unknown>) => api("POST", path("/branches"), { expectedHead: cut.version, expectedBranch: "main", ...body });
  expect(await ask({ name: "   " })).toMatchObject({ status: 400 });
  expect(await ask({ name: "x".repeat(81) })).toMatchObject({ status: 400 });
  expect(await api("POST", path("/branches"), { name: "Alt" })).toMatchObject({ status: 400 });
  expect(await ask({ name: "Alt", expectedHead: first.version })).toMatchObject({ status: 409, code: "cut_changed" });
  expect(await ask({ name: "Alt", expectedBranch: "Other" })).toMatchObject({ status: 409, code: "cut_changed" });
  expect(await ask({ name: "Alt", from: "v_missing" })).toMatchObject({ status: 404, code: "not_found" });
  expect(await ask({ name: "Nowhere" })).toMatchObject({ status: 404, code: "not_found" });
  expect((await ask({ name: "Alt", from: first.version })).status).toBe(200);
  expect(await api("POST", path("/branches"), { name: "Alt", from: cut.version, expectedHead: first.version, expectedBranch: "Alt" }))
    .toMatchObject({ status: 409, code: "branch_exists" });
  expect(branchOf()).toBe("Alt");
});

it("restores an earlier version as a new one on top, and undoes a version's change", async () => {
  const { first, cut } = twoVersions();
  expect(await api("POST", path(`/versions/${first.version}/restore`), { expectedHead: cut.version })).toMatchObject({ status: 400 });
  const restored = await api("POST", path(`/versions/${first.version}/restore`), { expectedHead: cut.version, branch: "main" });
  expect(restored.status).toBe(200);
  expect(restored.json.change).toMatchObject({ description: "Restore · Whole take", fromVersion: cut.version, state: "approved" });
  expect(restored.json.project.head).not.toBe(cut.version);
  expect(await api("POST", path(`/versions/${first.version}/restore`), { expectedHead: cut.version, branch: "main" })).toMatchObject({ status: 409, code: "cut_changed" });

  const undone = await api("POST", path(`/versions/${restored.json.project.head}/revert`), { expectedHead: restored.json.project.head, branch: "main" });
  expect(undone.status).toBe(200);
  expect(undone.json.change).toMatchObject({ revertsVersion: restored.json.project.head });
  expect(await api("POST", path("/versions/v_missing/revert"), { expectedHead: head(), branch: "main" })).toMatchObject({ status: 404 });
});

it("checks out a version, and refuses the one in use and one it doesn't have", async () => {
  const { first, cut } = twoVersions();
  const out = await api("POST", path(`/versions/${first.version}/checkout`));
  expect(out.status).toBe(200);
  expect(head()).toBe(first.version);
  expect(await api("POST", path(`/versions/${first.version}/checkout`))).toMatchObject({ status: 409, code: "already_head" });
  expect(await api("POST", path("/versions/v_missing/checkout"))).toMatchObject({ status: 404 });
  expect((await api("POST", path(`/versions/${cut.version}/checkout`))).status).toBe(200);
});

it("describes what changed between two versions, naming clips by id when asked", async () => {
  const { first, cut } = twoVersions();
  const named = await api("GET", path(`/versions/${first.version}/diff/${cut.version}`));
  expect(named.status).toBe(200);
  expect(named.json.diff.ranges.length).toBeGreaterThan(0);
  expect(named.json.description).toContain("Duration 60.00 → 58.00");
  // A labelled clip goes by its label, or by its id with the label beside it.
  const clip = cut.tracks[0]!.clips[1]!;
  const labelled = storeVersion(workspace.ctx, project.id, applyOps(cut, [{ op: "updateClip", clipId: clip.id, patch: { label: "Answer", sourceOut: 50 } }]), { parent: cut.version });
  const byLabel = await api("GET", path(`/versions/${cut.version}/diff/${labelled.version}`));
  const byId = await api("GET", path(`/versions/${cut.version}/diff/${labelled.version}?clipNames=id`));
  expect(byId.json.diff).toEqual(byLabel.json.diff);
  expect(byLabel.json.description.join("\n")).toContain("Answer");
  expect(byLabel.json.description.join("\n")).not.toContain(clip.id);
  expect(byId.json.description.join("\n")).toContain(`${clip.id} “Answer”`);
  expect(await api("GET", path(`/versions/${first.version}/diff/v_missing`))).toMatchObject({ status: 404 });
  expect(await api("GET", `/projects/prj_missing/versions/${first.version}/diff/${cut.version}`)).toMatchObject({ status: 404 });
});

it("refuses a Reject that names no edit, an empty label, a range that runs backwards, or too many edits", async () => {
  twoVersions();
  const edit = { changeId: "chg_pass", spot: 0, label: "Cut pause", range: { start: 8, end: 11 } };
  const reject = (edits: unknown[]) => api("POST", path("/rejected-edits"), { expectedHead: head(), branch: "main", threadId: "thread", edits });
  expect(await reject([])).toMatchObject({ status: 400 });
  expect(await reject([{ ...edit, label: "  " }])).toMatchObject({ status: 400 });
  expect(await reject([{ ...edit, range: { start: 11, end: 8 } }])).toMatchObject({ status: 400 });
  expect(await reject([{ ...edit, spot: 1.5 }])).toMatchObject({ status: 400 });
  expect(await reject([{ ...edit, at: 10, before: { version: "v", removed: { start: 10, end: 10 } } }])).toMatchObject({ status: 400 });
  expect(await reject(Array.from({ length: 33 }, (_, spot) => ({ ...edit, spot })))).toMatchObject({ status: 400 });
  // Well formed, but for a change it doesn't know: Scarlet is asked instead.
  expect(await reject([edit])).toMatchObject({ status: 409, code: "needs_scarlet" });
  expect(await api("POST", path("/rejected-edits"), { expectedHead: "v_old", branch: "main", threadId: "thread", edits: [edit] })).toMatchObject({ status: 409, code: "cut_changed" });
});

it("takes out a request whose only edit is rejected", async () => {
  const { ctx } = workspace;
  const first = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 60 }]), { parent: null });
  const ops = [{ op: "addMarker" as const, marker: { id: "mark", time: 5, text: "Title here", kind: "note" as const, resolved: false } }];
  const marked = storeVersion(ctx, project.id, applyOps(first, ops), { parent: first.version, changeId: "chg_title" });
  const at = new Date().toISOString();
  ctx.repos.changes.put({ id: "chg_title", projectId: project.id, description: "Marked a title", author: { type: "agent", id: "codex", name: "codex" }, state: "approved",
    noteIds: [], renders: [], ranges: [], fromVersion: first.version, toVersion: marked.version, appliedOnto: first.version, appliedVersion: marked.version, ops,
    timelineEdits: [{ label: "Title", range: { start: 5, end: 5 } }], createdAt: at, updatedAt: at });
  ctx.repos.projects.update(project.id, { head: marked.version });
  const rejected = await api("POST", path("/rejected-edits"), { expectedHead: marked.version, branch: "main", threadId: "thread",
    edits: [{ changeId: "chg_title", spot: 0, label: "Title", range: { start: 5, end: 5 }, marker: true, revised: false }] });
  expect(rejected.status).toBe(200);
  expect(rejected.json.change).toMatchObject({ rejects: true, description: "Rejected · Title" });
  expect(ctx.repos.versions.get(project.id, head())!.timeline.markers).toEqual([]);
});

it("adjusts an applied cut's edges, and refuses a cut with no footage before or edges that run backwards", async () => {
  const { ctx } = workspace;
  const first = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 60 }]), { parent: null });
  const cut = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 10 }, { start: 12, end: 60 }]), { parent: first.version, changeId: "chg_pass" });
  const at = new Date().toISOString();
  ctx.repos.changes.put({ id: "chg_pass", projectId: project.id, description: "Trimmed a pause", author: { type: "agent", id: "claude", name: "Claude" }, state: "approved",
    threadId: "thread", fromVersion: first.version, toVersion: cut.version, appliedOnto: first.version, appliedVersion: cut.version,
    timelineEdits: [{ label: "Cut pause", range: { start: 10, end: 10 } }], leftOut: { version: first.version, joins: [{ at: 10, removed: { start: 10, end: 12 } }] },
    noteIds: [], renders: [], ranges: [], createdAt: at, updatedAt: at });
  ctx.repos.projects.update(project.id, { head: cut.version });
  const target = { changeId: "chg_pass", spot: 0, label: "Cut pause", range: { start: 8.5, end: 11.5 }, at: 10, before: { version: first.version, removed: { start: 10, end: 12 } } };
  const adjust = (body: Record<string, unknown>) => api("POST", path("/adjusted-cut"), { expectedHead: cut.version, branch: "main", threadId: "thread", cut: target, removed: { start: 10.5, end: 12 }, ...body });
  expect(await adjust({ removed: { start: 12, end: 10.5 } })).toMatchObject({ status: 400 });
  expect(await adjust({ cut: { ...target, before: { version: first.version, removed: { start: 10, end: 10 } } } })).toMatchObject({ status: 400 });
  expect(await adjust({ cut: { ...target, at: -1 } })).toMatchObject({ status: 400 });
  expect(await adjust({ cut: { ...target, before: { version: "v_missing", removed: { start: 10, end: 12 } } } })).toMatchObject({ status: 409, code: "needs_scarlet" });

  const adjusted = await adjust({});
  expect(adjusted.status).toBe(200);
  expect(adjusted.json.change).toMatchObject({ state: "approved", threadId: "thread", description: "Adjusted · Cut pause" });
  const clips = (ctx.repos.versions.get(project.id, head())!.timeline as Timeline).tracks[0]!.clips;
  expect(clips.map(c => c.kind === "media" && [c.timelineIn, c.sourceIn, c.sourceOut])).toEqual([[0, 0, 10.5], [10.5, 12, 60]]);
});

it("moves an applied caption's edges, and refuses an edit with no length", async () => {
  const { ctx } = workspace;
  const base = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 20 }]), { parent: null });
  const clip = { id: "cap_1", kind: "caption" as const, timelineIn: 1, timelineOut: 3, text: "Welcome", enabled: true };
  const withCap = storeVersion(ctx, project.id, { ...base, tracks: [...base.tracks, { id: "c1", kind: "caption", name: "Captions", muted: false, hidden: false, clips: [clip] }] },
    { parent: base.version, changeId: "chg_cap" });
  const at = new Date().toISOString();
  const change: Change = { id: "chg_cap", projectId: project.id, description: "Add opening caption", author: { type: "agent", id: "claude", name: "Claude" }, state: "approved",
    threadId: "thr_cap", fromVersion: base.version, toVersion: withCap.version, appliedOnto: base.version, appliedVersion: withCap.version,
    ops: [{ op: "addClip", trackId: "c1", clip }], timelineEdits: [{ label: "Opening caption", range: { start: 1, end: 3 } }],
    noteIds: [], renders: [], ranges: [{ start: 1, end: 3 }], createdAt: at, updatedAt: at };
  ctx.repos.changes.put(change);
  ctx.repos.projects.update(project.id, { head: withCap.version });
  const target = { changeId: "chg_cap", spot: 0, label: "Opening caption", range: { start: 1, end: 3 }, kind: "text" };
  const adjust = (body: Record<string, unknown>) => api("POST", path("/adjusted-edit"), { expectedHead: withCap.version, branch: "main", threadId: "thr_cap", edit: target, nextRange: { start: 0.5, end: 4.5 }, ...body });
  expect(await adjust({ edit: { ...target, range: { start: 2, end: 2 } } })).toMatchObject({ status: 400 });
  expect(await adjust({ nextRange: { start: 4.5, end: 0.5 } })).toMatchObject({ status: 400 });
  expect(await adjust({ expectedHead: base.version })).toMatchObject({ status: 409, code: "cut_changed" });
  const moved = await adjust({});
  expect(moved.status).toBe(200);
  expect(moved.json.change).toMatchObject({ description: "Adjusted · Opening caption" });
  const caption = ctx.repos.versions.get(project.id, head())!.timeline.tracks.find(t => t.id === "c1")!.clips[0]!;
  expect([caption.timelineIn, caption.kind === "caption" && caption.timelineOut]).toEqual([0.5, 4.5]);
});

it("exports the timeline as OTIO named after the project and version, and logs the export", async () => {
  const { cut } = twoVersions();
  const res = await api("GET", path(`/versions/${cut.version}/export.otio`));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(res.headers.get("content-disposition")).toBe(`attachment; filename="Weekly_interview-${cut.version}.otio"`);
  expect(res.json.OTIO_SCHEMA).toBe("Timeline.1");
  expect(activity("export.completed")[0]).toMatchObject({ summary: expect.stringContaining("exported timeline (.otio)"), data: { format: "otio", version: cut.version, duration: 58 } });
  expect(await api("GET", path("/versions/v_missing/export.otio"))).toMatchObject({ status: 404 });
  expect(await api("GET", "/projects/prj_missing/versions/head/export.otio")).toMatchObject({ status: 404 });
});

it("lets only a run at work in this project export, and logs a caption export's range and track", async () => {
  twoVersions();
  expect(await api("GET", path("/versions/head/export.otio"), undefined, { [TASK_HEADER]: "tsk_none" })).toMatchObject({ status: 400, code: "invalid_task" });
  const queued = createTask(workspace.ctx, { projectId: project.id, kind: "edit", agent: "claude", instruction: "Export", context: {}, createdBy: { type: "human", name: "Editor" } });
  const stale = { [TASK_HEADER]: queued.id, [ATTEMPT_HEADER]: "2026-01-01T00:00:00.000Z" };
  expect(await api("GET", path("/versions/head/export.otio"), undefined, stale)).toMatchObject({ status: 409, code: "inactive_task_attempt" });
  expect(await api("GET", path("/versions/head/export.srt"), undefined, stale)).toMatchObject({ status: 409, code: "inactive_task_attempt" });
  expect(await api("POST", path("/versions/head/handoff"), { folder: directory }, stale)).toMatchObject({ status: 409, code: "inactive_task_attempt" });

  await api("POST", path("/changes"), { description: "Captions", skipRender: true, autoApprove: true, ops: [
    { op: "addTrack", track: { id: "cap", kind: "caption", name: "Captions" } },
    { op: "addClip", trackId: "cap", clip: { id: "c1", kind: "caption", timelineIn: 1, timelineOut: 3, text: "Hello", enabled: true } },
  ] });
  const srt = await api("GET", path("/versions/head/export.srt?start=0&end=5&trackId=cap"));
  expect(srt.status).toBe(200);
  expect(srt.text).toContain("Hello");
  expect(activity("export.completed").find(a => a.data?.format === "srt")).toMatchObject({ data: { range: { start: 0, end: 5 }, trackId: "cap" } });
  expect(await api("GET", path("/versions/head/export.vtt?start=soon"))).toMatchObject({ status: 400, code: "bad_param" });
});

it("refuses a handoff without a folder", async () => {
  twoVersions();
  expect(await api("POST", path("/versions/head/handoff"), {})).toMatchObject({ status: 400 });
  expect(await api("POST", path("/versions/head/handoff"), { folder: "" })).toMatchObject({ status: 400 });
  expect(await api("POST", path("/versions/head/handoff"), { folder: "x".repeat(4097) })).toMatchObject({ status: 400 });
});

it("lists the handoff folder for the version and logs the export", async () => {
  twoVersions();
  workspace.ctx.paths.ensureProject(project.id);
  writeFileSync(join(workspace.ctx.paths.media(project.id), "camera.mov"), "take");
  const folder = join(directory, "Exports", "Weekly interview");
  const res = await api("POST", path("/versions/head/handoff"), { folder });
  expect(res.status).toBe(200);
  expect(res.json.files.map((f: { path: string }) => f.path)).toEqual(expect.arrayContaining(["Weekly interview.otio", "Read me.txt", "Media/interview.mov"]));
  expect(activity("export.completed")[0]).toMatchObject({ data: { format: "folder", version: head(), duration: 58 } });
});
