import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createProject } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "./app.js";
import { accessToken } from "./auth.js";
import { purgeTrash } from "./services/trash.js";

let workspace: ScarletApp;
let root: string;
let id: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "scarlet-storage-test-"));
  workspace = createApp({ dataDir: root, log() {} });
  id = workspace.ctx.repos.projects.insert(createProject("Storage test")).id;
  workspace.ctx.paths.ensureProject(id);
  await Promise.all([...workspace.ctx.pending]);
});
afterEach(async () => {
  await workspace.ctx.close();
  rmSync(root, { recursive: true, force: true });
});
function api(method: string, path: string, body?: unknown) {
  return workspace.app.request("/api" + path, { method, headers: { Authorization: "Bearer " + accessToken(workspace.ctx), "Content-Type":"application/json" }, body: JSON.stringify(body) });
}
const clear = () => api("POST", "/storage/cleanup", {kind:"cache",projects:[{id,deletedAt:null}]});
it("allows permanently deleting a trashed project with an unclaimed edit", async () => {
  const created = await api("POST", `/projects/${id}/tasks`, { kind: "edit", agent: "codex", instruction: "Trim the intro" });
  const { task } = await created.json();
  expect(task.state).toBe("queued");
  await api("DELETE", `/projects/${id}`);
  const { projects: [project] } = await (await api("GET", "/storage")).json();
  expect(project.busy).toBe(false);
  expect((await api("POST", "/storage/cleanup", { kind: "trash", projects: [{ id, deletedAt: project.deletedAt }] })).status).toBe(200);
  expect(workspace.ctx.repos.tasks.get(task.id)).toBeNull();
});
it("says when a trashed project goes for good on the storage list, as the Trash's own list does", async () => {
  await api("DELETE", `/projects/${id}`);
  const { projects: [listed] } = await (await api("GET", "/trash")).json();
  const { projects: [stored] } = await (await api("GET", "/storage")).json();
  expect(stored.purgeAt).toBe(listed.purgeAt);
  expect(Date.parse(stored.purgeAt) - Date.parse(stored.deletedAt)).toBe(30 * 24 * 60 * 60 * 1000);
  // A project that isn't in the Trash has no such day.
  await api("POST", `/projects/${id}/restore`);
  expect((await (await api("GET", "/storage")).json()).projects[0]).not.toHaveProperty("purgeAt");
});
it("clears only reusable segments and refuses active projects", async () => {
  const ctx = workspace.ctx, paths = ctx.paths;
  const hash = "a".repeat(64);
  const generated = [hash+".mp4", "mix-"+hash+".m4a","program-"+hash+".m4a"];
  const protectedFiles = [join(paths.media(id),"source.mp4"),join(paths.renders(id),hash+".mp4"),join(paths.segments(id),"export.mp4"),join(paths.segments(id),hash+".part.mp4")];
  for (const file of [...generated.map(f=>join(paths.segments(id),f)),...protectedFiles]) writeFileSync(file,"data");
  const snapshot = await (await api("GET","/storage")).json();
  expect(snapshot.projects[0].segments.sort()).toEqual(generated.sort());
  ctx.db.prepare("INSERT INTO renders VALUES (?,?,?,?,?,?,?,?)").run("render",id,"key","version","full","running","{}","now");
  expect((await clear()).status).toBe(409);
  expect(generated.every(f=>existsSync(join(paths.segments(id),f)))).toBe(true);
  ctx.db.exec("DELETE FROM renders");
  ctx.db.prepare("INSERT INTO media (id,project_id,status,json,created_at) VALUES (?,?,?,?,?)")
    .run("offline", id, "ready", JSON.stringify({ path: "offline.mov" }), "now");
  expect((await clear()).status).toBe(409);
  expect(generated.every(f => existsSync(join(paths.segments(id),f)))).toBe(true);
  writeFileSync(join(paths.media(id),"offline.mov"), "source");
  expect((await clear()).status).toBe(200);
  expect(generated.some(f=>existsSync(join(paths.segments(id),f)))).toBe(false);
  expect(protectedFiles.every(f=>existsSync(f))).toBe(true);
});
it("rejects stale Trash selections and retries interrupted file removal",async()=>{
  const ctx = workspace.ctx;
  ctx.repos.projects.softDelete(id);
  const {deletedAt} = ctx.repos.projects.listDeleted()[0]!;
  const purge = () => api("POST","/storage/cleanup",{kind:"trash", projects:[{id,deletedAt}]});
  ctx.repos.projects.restore(id);
  expect((await purge()).status).toBe(409);
  expect(existsSync(ctx.paths.project(id))).toBe(true);
  ctx.db.prepare("UPDATE projects SET deleted_at=? WHERE id=?").run(deletedAt,id);
  expect((await purge()).status).toBe(200);
  expect(ctx.repos.projects.listDeleted()).toEqual([]);
  expect(existsSync(ctx.paths.project(id))).toBe(false);
  const orphan = "prj_interrupted";
  mkdirSync(ctx.paths.project(orphan));
  ctx.db.prepare("INSERT INTO storage_purges VALUES (?)").run(orphan);
  purgeTrash(ctx);
  expect(existsSync(ctx.paths.project(orphan))).toBe(false);
});
it.skipIf(process.platform === "win32")("does not follow a linked segment directory",async()=>{
  const paths=workspace.ctx.paths, source=join(paths.media(id),"b".repeat(64)+".mp4");
  writeFileSync(source,"keep");
  rmSync(paths.segments(id),{recursive:true});
  symlinkSync(paths.media(id),paths.segments(id));
  expect((await clear()).status).toBe(200);
  expect(existsSync(source)).toBe(true);
});
it("logs what was cleared and what was removed for good, by project", async () => {
  const ctx = workspace.ctx;
  const lines: string[] = [];
  ctx.log = line => lines.push(line);
  const said = () => lines.filter(line => line.startsWith("[storage]") || line.startsWith("[trash]"));
  writeFileSync(join(ctx.paths.segments(id), "a".repeat(64) + ".mp4"), "data");
  expect((await clear()).status).toBe(200);
  expect(said()).toEqual([`[storage] cleared the cached renders of 1 project: ${id}`]);
  // A selection that was refused cleared nothing, and says nothing.
  ctx.db.prepare("INSERT INTO renders VALUES (?,?,?,?,?,?,?,?)").run("render", id, "key", "version", "full", "running", "{}", "now");
  expect((await clear()).status).toBe(409);
  ctx.db.exec("DELETE FROM renders");
  expect(said()).toHaveLength(1);

  lines.length = 0;
  const other = ctx.repos.projects.insert(createProject("Second")).id;
  for (const project of [id, other]) ctx.repos.projects.softDelete(project);
  const trashed = ctx.repos.projects.listDeleted().map(p => ({ id: p.id, deletedAt: p.deletedAt }));
  expect((await api("POST", "/storage/cleanup", { kind: "trash", projects: trashed })).status).toBe(200);
  expect(said()).toEqual([`[trash] removed 2 projects for good: ${trashed.map(p => p.id).join(", ")}`]);
});
it("removes a project that has been in the trash for 30 days, and logs that it did", async () => {
  const ctx = workspace.ctx;
  const lines: string[] = [];
  ctx.log = line => lines.push(line);
  ctx.repos.projects.softDelete(id);
  const day = 24 * 60 * 60 * 1000;
  const deletedAt = Date.parse(ctx.repos.projects.listDeleted()[0]!.deletedAt);
  // Still restorable on the 30th day.
  expect(purgeTrash(ctx, deletedAt + 30 * day - 1000)).toBe(0);
  expect(existsSync(ctx.paths.project(id))).toBe(true);
  expect(lines).toEqual([]);
  expect(purgeTrash(ctx, deletedAt + 30 * day + 1000)).toBe(1);
  expect(existsSync(ctx.paths.project(id))).toBe(false);
  expect(ctx.repos.projects.listDeleted()).toEqual([]);
  expect(lines).toEqual([`[trash] removed 1 project for good after 30 days in the trash: ${id}`]);
  expect(purgeTrash(ctx, deletedAt + 31 * day)).toBe(0);
  expect(lines).toHaveLength(1);
});
