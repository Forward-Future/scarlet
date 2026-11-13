import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProject, timelineFromKeepRanges, type Change, type Project } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
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
function api(method: string, path: string, body?: unknown) {
  return workspace.app.request("/api" + path, { method, body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { Authorization: `Bearer ${accessToken(workspace.ctx)}`, ...(body !== undefined && { "Content-Type": "application/json" }) } });
}
const marker = [{ op: "addMarker", marker: { id: "marker", time: 0, text: "Start" } }];

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
