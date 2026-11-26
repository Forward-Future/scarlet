import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { timelineDuration } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";

let directory: string;
let workspace: ScarletApp;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-sample-project-test-"));
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: () => {} });
});

afterEach(async () => {
  await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

function api(method: string, path: string, body?: unknown) {
  return workspace.app.request("/api" + path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${accessToken(workspace.ctx)}`,
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
  });
}

it("creates a ready-to-explore sample project with video, transcript, finished cuts, and punch-in", async () => {
  const res = await api("POST", "/projects/sample", {});
  expect(res.status, await res.clone().text()).toBe(201);
  const { project } = await res.json();
  expect(project.name).toBe("Sample project");
  expect(project.head).toBeTruthy();
  expect(project.media).toHaveLength(1);

  const media = project.media[0];
  expect(media.kind).toBe("video");
  expect(media.hasAudio).toBe(true);
  expect(media.transcriptId).toBeTruthy();
  expect(existsSync(join(workspace.ctx.paths.media(project.id), media.path))).toBe(true);

  const transcript = workspace.ctx.repos.transcripts.get(media.transcriptId);
  expect(transcript?.segments).toHaveLength(4);
  expect(transcript?.segments[1]?.text).toContain("Wait");

  // Original version and edited head both exist so Before/After comparison works immediately.
  const versions = workspace.ctx.repos.versions.links(project.id);
  expect(versions.length).toBeGreaterThanOrEqual(3);
  const head = workspace.ctx.repos.versions.get(project.id, project.head)?.timeline;
  expect(head).toBeTruthy();
  expect(timelineDuration(head!)).toBeCloseTo(8.3, 1);

  // Main takeaway clip received the 1.15x punch-in zoom.
  const clips = head!.tracks.find(t => t.kind === "video")?.clips ?? [];
  expect(clips.some(c => c.kind === "media" && c.transform?.scale === 1.15)).toBe(true);

  // Completed pass and approved changes with named edits (one flagged to check) exist.
  const tasks = workspace.ctx.repos.tasks.select("project_id = ?", [project.id]);
  expect(tasks).toHaveLength(1);
  expect(tasks[0]?.state).toBe("done");

  const changes = workspace.ctx.repos.changes.select("project_id = ?", [project.id]);
  expect(changes).toHaveLength(2);
  expect(changes.every(c => c.state === "approved")).toBe(true);
  expect(changes.some(c => c.timelineEdits?.some(e => Boolean(e.check)))).toBe(true);

  // Creating a second sample project picks a unique name instead of colliding.
  const second = await api("POST", "/projects/sample", {});
  expect(second.status).toBe(201);
  expect((await second.json()).project.name).toBe("Sample project 2");
});
