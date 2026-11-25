import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createProject, type MediaAsset, type Project } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";

let directory: string;
let workspace: ScarletApp;
let project: Project;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-media-note-test-"));
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: () => {} });
  project = workspace.ctx.repos.projects.insert(createProject("Sponsor"));
});

afterEach(async () => {
  if (!workspace.ctx.shutdown.aborted) await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

function api(method: string, path: string, body?: unknown) {
  return workspace.app.request("/api" + path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: "Bearer " + accessToken(workspace.ctx), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
  });
}

it("saves the editor's note on a file, says when the file was added, and takes the note off when it is emptied", async () => {
  const added = workspace.ctx.repos.projects.putMedia(project.id, { id: "med_sponsor", kind: "video", name: "Integration.mp4", path: "med_sponsor.mp4", duration: 94 }, "ready");
  expect(Date.parse(added.addedAt!)).not.toBeNaN();
  const events: string[] = [];
  workspace.ctx.bus.on("ws", e => { if (e.type === "media.updated") events.push(e.media.editorNote ?? "(none)"); });

  const put = await api("PUT", "/media/med_sponsor/note", { note: "  Finished sponsor read. Insert it whole after the intro.  " });
  expect(put.status).toBe(200);
  const { media } = await put.json() as { media: MediaAsset };
  expect(media.editorNote).toBe("Finished sponsor read. Insert it whole after the intro.");
  // When it was added stays the row's: a save doesn't move it or keep a copy of it in the file's record.
  expect(media.addedAt).toBe(added.addedAt);
  const stored = workspace.ctx.db.prepare("SELECT json FROM media WHERE id = ?").get("med_sponsor") as { json: string };
  expect(JSON.parse(stored.json).addedAt).toBeUndefined();
  expect(workspace.ctx.repos.projects.listMedia(project.id)[0]).toMatchObject({ editorNote: media.editorNote, addedAt: added.addedAt });

  const cleared = await (await api("PUT", "/media/med_sponsor/note", { note: "   " })).json() as { media: MediaAsset };
  expect(cleared.media.editorNote).toBeUndefined();
  expect(events).toEqual(["Finished sponsor read. Insert it whole after the intro.", "(none)"]);

  expect((await api("PUT", "/media/med_sponsor/note", { note: "x".repeat(2001) })).status).toBe(400);
  expect((await api("PUT", "/media/med_missing/note", { note: "Hi" })).status).toBe(404);
});
