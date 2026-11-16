import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createProject } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { clearSegments, segmentFiles } from "./storage.js";

let workspace: ScarletApp;
let root: string;
let id: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scarlet-storage-claim-test-"));
  workspace = createApp({ dataDir: root, skillsSeedDir: join(root, "empty-seed"), env: {}, log() {} });
  id = workspace.ctx.repos.projects.insert(createProject("Storage claim")).id;
  workspace.ctx.paths.ensureProject(id);
});
afterEach(async () => {
  await workspace.ctx.close();
  rmSync(root, { recursive: true, force: true });
});

it("keeps a cached render made after the clear was decided, and deletes only the ones it claimed", async () => {
  const dir = workspace.ctx.paths.segments(id);
  const segment = "b".repeat(64) + ".mp4";
  writeFileSync(join(dir, segment), "old");
  const files = segmentFiles(workspace.ctx, id);
  // Claimed under another name at once, so a render starting now doesn't find it and reuse it.
  expect(existsSync(join(dir, segment))).toBe(false);
  // A render between the claim and the delete makes its segment again under the same name.
  writeFileSync(join(dir, segment), "new");
  await clearSegments(workspace.ctx, id, files);
  expect(readFileSync(join(dir, segment), "utf8")).toBe("new");
  expect(readdirSync(dir)).toEqual([segment]);
});

it("deletes a claimed render an earlier clear left behind", async () => {
  const dir = workspace.ctx.paths.segments(id);
  writeFileSync(join(dir, ".clearing-" + "c".repeat(64) + ".mp4"), "left");
  writeFileSync(join(dir, "export.mp4"), "not a cached render");
  await clearSegments(workspace.ctx, id, segmentFiles(workspace.ctx, id));
  expect(readdirSync(dir)).toEqual(["export.mp4"]);
});
