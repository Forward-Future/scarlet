import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProject, timelineFromKeepRanges, type Change, type Project } from "@scarlet/timeline";
import { ATTEMPT_HEADER, TASK_HEADER } from "@scarlet/shared";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken, localUser } from "../auth.js";
import { proposeChange } from "../services/changes.js";
import { createTask } from "../services/tasks.js";
import { storeVersion } from "../services/timeline.js";

let directory: string;
let workspace: ScarletApp;
let project: Project;
let lines: string[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-change-routes-test-"));
  const said: string[] = lines = [];
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: line => said.push(line) });
  project = workspace.ctx.repos.projects.insert(createProject("Test"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

/** `body` goes over the wire as given when it is a string, so a request can carry text that isn't JSON. */
function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return workspace.app.request("/api" + path, { method, body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { Authorization: `Bearer ${accessToken(workspace.ctx)}`, ...(body !== undefined && { "Content-Type": "application/json" }), ...headers } });
}
const marker = [{ op: "addMarker", marker: { id: "marker", time: 0, text: "Start" } }];

it("logs committed call choices and schedule changes without repeating saved decisions or logging their prose", async () => {
  const { ctx } = workspace;
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "/first-cut-dialogue", createdBy: { type: "human", name: "Editor" } });
  const startedAt = new Date().toISOString();
  ctx.repos.tasks.put({ ...task, state: "running", startedAt });
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "Mic", path: "mic.wav", kind: "audio", duration: 20, hasAudio: true }, "ready");
  const base = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: task.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 20 } }] }).change.toVersion;
  const staged = await api("POST", `/projects/${project.id}/dialogue-cuts`, { taskId: task.id, fromVersion: base, description: "Pass",
    cuts: [{ start: 10, end: 11, review: true, reason: "Private reason" }, { start: 14, end: 15, review: true, reason: "Other reason" }] },
    { [TASK_HEADER]: task.id, [ATTEMPT_HEADER]: startedAt });
  expect(staged.status, await staged.clone().text()).toBe(201);
  const { changes: [change] } = await staged.json() as { changes: Change[] };
  const choose = (choices: { index: number; choice: "cut" | "keep" }[], applyWhenDone: boolean) => api("PUT", `/changes/${change!.id}/cut-choices`, {
    fromVersion: change!.fromVersion, toVersion: change!.toVersion, choices, applyWhenDone,
  });
  const choices = [{ index: 0, choice: "cut" }, { index: 1, choice: "keep" }] as const;
  lines.length = 0;
  expect((await choose([...choices], true)).status).toBe(200);
  expect((await choose([...choices], true)).status).toBe(200);
  expect((await choose([choices[1]], false)).status).toBe(200);
  const target = `change=${change!.id} project=${project.id} task=${task.id}`;
  expect(lines.filter(line => line.startsWith("[review] choices") || line.startsWith("[review] schedule"))).toEqual([
    `[review] choices ${target} approved=1 approvedCuts=[0] skipped=1 skippedCuts=[1] cleared=0 clearedCuts=[]`,
    `[review] schedule ${target} outcome=set reason=editor`,
    `[review] choices ${target} approved=0 approvedCuts=[] skipped=0 skippedCuts=[] cleared=1 clearedCuts=[0]`,
    `[review] schedule ${target} outcome=cleared reason=editor`,
  ]);
  expect(lines.join("\n")).not.toContain("Private reason");
  // What the editor's own presses are refused with reads as the chat does: pass, calls, the video.
  const refused = async (response: Promise<Response>) => { const r = await response; return [r.status, (await r.json()).error.message]; };
  expect(await refused(api("PUT", `/changes/${change!.id}/cut-choices`, { fromVersion: "ver_gone", toVersion: change!.toVersion, choices: [...choices] })))
    .toEqual([409, "This pass isn’t waiting on your calls any more."]);
  expect(await refused(api("POST", `/changes/${change!.id}/cut-review?view=draft`, { restoredCuts: [0], ontoVersion: "ver_gone" })))
    .toEqual([409, "The video changed while this cut was open. Open it again."]);
});

it("refuses to apply an edit that was rejected in words the editor reads, not the engine's states", async () => {
  const { change } = await (await api("POST", `/projects/${project.id}/changes`, { description: "Add label", ops: marker })).json();
  expect((await api("POST", `/changes/${change.id}/reject`, {})).status).toBe(200);
  const refused = await api("POST", `/changes/${change.id}/approve`);
  expect([refused.status, (await refused.json()).error]).toEqual([409, { code: "invalid_state", message: "This edit was already rejected." }]);
});

/** A reframe in four places: too large to check for separable spots while it is proposed, so the engine's worker does. */
function fourPlaces() {
  const { ctx } = workspace;
  ctx.repos.projects.putMedia(project.id, { id: "camera", name: "Camera", kind: "video", path: "camera.mov" }, "ready");
  const tl = timelineFromKeepRanges(project.id, "camera", Array.from({ length: 80 }, (_, i) => ({ start: i, end: i + 1 })));
  const { version } = storeVersion(ctx, project.id, tl, { parent: null });
  ctx.repos.projects.update(project.id, { head: version });
  return { description: "Reframe four regions", skipRender: true,
    ops: [2, 12, 22, 32].map(i => ({ op: "updateClip", clipId: tl.tracks[0]!.clips[i]!.id, patch: { transform: { scale: 0.8 } } })) };
}

it("answers an approval whose body isn't JSON with 400, and approves with no body at all", async () => {
  const { change } = await (await api("POST", `/projects/${project.id}/changes`, { description: "Add label", ops: marker })).json();
  const garbled = await api("POST", `/changes/${change.id}/approve`, "{\"spots\": [0");
  expect(garbled.status).toBe(400);
  expect((await garbled.json()).error).toEqual({ code: "bad_json", message: "request body is not valid JSON" });
  expect(workspace.ctx.repos.changes.get(change.id)?.state).toBe("ready");
  expect(lines.filter(line => line.startsWith("[error]"))).toEqual([]);

  const both = await api("POST", `/changes/${change.id}/approve`, { spots: [0], restoredCuts: [0] });
  expect(both.status).toBe(400);
  expect((await both.json()).error.code).toBe("validation_error");

  const approved = await api("POST", `/changes/${change.id}/approve`);
  expect(approved.status).toBe(200);
  expect((await approved.json()).outcome).toBe("applied");
});

it("returns a proposal that was saved even when its spots can't be checked", async () => {
  const { ctx } = workspace;
  const check = vi.spyOn(ctx.spotChecks, "get").mockRejectedValue(new Error("the worker exited with code 1"));
  const proposed = await api("POST", `/projects/${project.id}/changes`, fourPlaces());
  // The proposal is committed before its spots are checked. A 500 here made an agent propose it a second time.
  expect(proposed.status).toBe(201);
  const { change } = await proposed.json() as { change: Change };
  expect(change).toMatchObject({ description: "Reframe four regions", state: "ready" });
  expect(change.ranges).toHaveLength(4);
  expect(ctx.repos.changes.select("project_id = ?", [project.id]).map(c => c.id)).toEqual([change.id]);
  expect(lines.filter(line => line.startsWith("[review]"))).toEqual([`[review] Could not check spots for ${change.id}: Error: the worker exited with code 1`]);

  // Reading it back gives the edit and its diff, without the spots, each time the check fails.
  lines.length = 0;
  const read = await api("GET", `/changes/${change.id}`);
  expect(read.status).toBe(200);
  const body = await read.json();
  expect(body.change).toMatchObject({ id: change.id, state: "ready" });
  expect(body.change.spotAssignment).toBeUndefined();
  expect(body.diff.spots).toHaveLength(4);
  expect(lines.filter(line => !line.startsWith("[http]"))).toEqual([`[review] Could not check spots for ${change.id}: Error: the worker exited with code 1`]);

  // Once the check works, the same read saves which spots can be approved on their own.
  check.mockRestore();
  expect((await (await api("GET", `/changes/${change.id}`)).json()).change.spotAssignment).toEqual({ fps: 30, owners: [0, 1, 2, 3] });
});

it("rejects unchanged content while accepting a rename on the same footage", async () => {
  const path = `/projects/${project.id}/changes`;
  const { timeline } = await (await api("GET", `/projects/${project.id}/timeline`)).json();
  const unchanged = await api("POST", path, { timeline: { ...timeline, version: "draft", parent: null }, description: "Same edit" });
  expect((await unchanged.json()).error.code).toBe("no_change");
  const renamed = await api("POST", path, { timeline: { ...timeline, name: "Interview" }, description: "Rename" });
  expect((await renamed.json()).timeline.name).toBe("Interview");
});

it("records kept edits whose summary exceeds 180 characters or whose marker note exceeds 120", async () => {
  const { ctx } = workspace;
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "/dialogue-pass", createdBy: { type: "human", name: "Editor" } });
  const startedAt = new Date().toISOString();
  ctx.repos.tasks.put({ ...task, state: "running", startedAt });
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "Mic", path: "mic.wav", kind: "audio", duration: 20, hasAudio: true }, "ready");
  const base = proposeChange(ctx, localUser(ctx), project.id, { autoApprove: true, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 20 } }] }).change.toVersion;
  const attempt = { [TASK_HEADER]: task.id, [ATTEMPT_HEADER]: startedAt };
  const longSummary = "Cut the aside quoting the speaker's note to the editor: " + "a".repeat(180);
  const longTodo = "Add the benchmark chart screenshot and highlight the bottom rows: " + "b".repeat(100);
  const cuts = await api("POST", `/projects/${project.id}/dialogue-cuts`, { taskId: task.id, fromVersion: base, description: "Pass",
    cuts: [
      { start: 2, end: 3, review: false, kind: "coaching", reason: "Aside to editor.", summary: longSummary, check: "Confirm the join stays clean." },
      { start: 6, end: 7, review: false, kind: "pause", reason: "Long pause.", summary: "Shortened the pause." },
    ] }, attempt);
  expect(cuts.status, await cuts.clone().text()).toBe(201);
  const todo = await api("POST", `/projects/${project.id}/changes?summary=true`, { taskId: task.id, intent: "requested",
    description: "Mark chart spot", skipRender: true,
    ops: [{ op: "addMarker", marker: { id: "m1", time: 10, kind: "todo", text: longTodo } }],
    timelineEdits: [{ label: "Add chart", range: { start: 10, end: 10 } }] }, attempt);
  expect(todo.status, await todo.clone().text()).toBe(201);

  const listed = await api("GET", `/projects/${project.id}/threads/${task.id}/edits`);
  expect(listed.status).toBe(200);
  const { version, edits } = await listed.json() as { version: string; edits: Array<{ changeId: string; spot: number; label: string; check?: string; range: { start: number; end: number } }> };
  expect(edits).toHaveLength(3);

  const kept = await api("POST", `/projects/${project.id}/kept-edits`, {
    threadId: task.id,
    version,
    edits: edits.map(({ changeId, spot, label, check, range }) => ({ changeId, spot, label, ...(check && { check }), range })),
  });
  expect(kept.status, await kept.clone().text()).toBe(204);

  const heard = await (await api("GET", `/projects/${project.id}/kept-edits?thread=${task.id}`)).json() as { kept: Array<{ label: string; check?: string }> };
  expect(heard.kept).toHaveLength(3);
  expect(heard.kept[0]).toMatchObject({ label: longSummary.slice(0, 180), check: "Confirm the join stays clean." });
  expect(heard.kept[1]).toMatchObject({ label: "Shortened the pause." });
  expect(heard.kept[2]).toMatchObject({ label: "Add chart", check: longTodo.slice(0, 120) });
});
