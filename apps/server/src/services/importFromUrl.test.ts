import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProject, type MediaAsset, type Project } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import { badRequest } from "../errors.js";
import { downloadImport } from "./importUrl.js";
import { normalizeImportUrl } from "./ingest.js";
import { ensureHead } from "./timeline.js";

// The download itself has its own tests. Here it hands back whatever a server would have answered.
vi.mock("./importUrl.js", () => ({ downloadImport: vi.fn() }));

let directory: string;
let workspace: ScarletApp;
let project: Project;
let lines: string[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-url-import-test-"));
  const said: string[] = lines = [];
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: line => said.push(line) });
  workspace.ctx.speakers.beside = false;
  project = workspace.ctx.repos.projects.insert(createProject("Test"));
  vi.spyOn(workspace.ctx.render, "probeMedia").mockResolvedValue({ duration: 0, hasAudio: false, kind: "image" });
});
afterEach(async () => {
  await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.mocked(downloadImport).mockReset();
});

const bytes = Buffer.from("not really a picture");
function answers(headers: Record<string, string> = {}, body: Iterable<Buffer> | AsyncIterable<Buffer> = [bytes]) {
  const res = Object.assign(Readable.from(body), { statusCode: 200, headers });
  vi.mocked(downloadImport).mockResolvedValueOnce(res as unknown as IncomingMessage);
  return res;
}
async function importUrl(url: string, name?: string, signal?: AbortSignal, importId?: string) {
  const res = await workspace.app.request(`/api/projects/${project.id}/media/import`, { method: "POST", signal, body: JSON.stringify({ url, name, importId }),
    headers: { Authorization: `Bearer ${accessToken(workspace.ctx)}`, "Content-Type": "application/json" } });
  return { status: res.status, body: await res.json() as { media: MediaAsset; error: { code: string; message: string } } };
}
const stored = () => readdirSync(workspace.ctx.paths.media(project.id));

it("adopts the first video's displayed format and publishes it when a URL follows other imports into an empty timeline", async () => {
  const { ctx } = workspace;
  const { head } = ensureHead(ctx, project.id);
  const probe = vi.mocked(ctx.render.probeMedia);
  const wide = { kind: "video" as const, width: 1920, height: 1080, fps: 30, duration: 1, hasAudio: false };
  const tall = { ...wide, width: 720, height: 1280, fps: 24 };
  const headers = { Authorization: `Bearer ${accessToken(ctx)}` };
  probe.mockResolvedValueOnce({ kind: "image", duration: 0, hasAudio: false, width: 800, height: 800 });
  answers();
  await importUrl("https://media.example/title.png");
  // A different batch can resume ahead of the original selection. It leaves that selection's turn intact.
  const native = join(directory, "later.mov");
  writeFileSync(native, bytes);
  probe.mockResolvedValueOnce(wide);
  const deferred = await workspace.app.request(`/api/projects/${project.id}/media/import`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ path: native, deferFormat: true }),
  });
  expect(deferred.status).toBe(201);
  expect(ctx.repos.projects.formatSet(project.id)).toBe(false);
  const events: Project[] = [];
  ctx.bus.on("ws", event => { if (event.type === "project.updated") events.push(event.project); });
  probe.mockResolvedValueOnce(tall);
  answers();
  const added = await importUrl("https://media.example/phone.mov");
  expect(added.status).toBe(201);
  const settings = { ...project.settings, width: 720, height: 1280, fps: 24, aspect: "9:16" };
  expect(ctx.repos.projects.header(project.id)).toMatchObject({ settings, head });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ settings, head, media: expect.arrayContaining([expect.objectContaining({ id: added.body.media.id })]) });
  const body = new FormData();
  body.append("file", new Blob(["studio footage"]), "studio.mp4");
  probe.mockResolvedValueOnce(wide);
  expect((await workspace.app.request(`/api/projects/${project.id}/media`, { method: "POST", headers, body })).status).toBe(201);
  expect(ctx.repos.projects.header(project.id)?.settings).toEqual(settings);
  expect(events).toHaveLength(1);
});

it("honors a format the editor chose explicitly even when it equals the defaults", async () => {
  const headers = { Authorization: `Bearer ${accessToken(workspace.ctx)}`, "Content-Type": "application/json" };
  const request = (method: string, path: string, body: unknown) => workspace.app.request("/api/projects" + path, {
    method, headers, body: JSON.stringify(body),
  });
  const chosen = (await (await request("POST", "", { name: "Landscape delivery", settings: { aspect: "16:9" } })).json()).project as Project;
  await request("PATCH", "/" + project.id, { settings: { fps: 30 } });
  for (const p of [project, chosen]) {
    project = p;
    const settings = { width: 720, height: 1280, fps: 24, aspect: "9:16" };
    vi.mocked(workspace.ctx.render.probeMedia).mockResolvedValueOnce({ kind: "video", width: 720, height: 1280, fps: 24, duration: 1, hasAudio: false });
    answers();
    expect((await importUrl("https://media.example/phone.mov")).status).toBe(201);
    await request("PATCH", "/" + p.id, { settings, expectedFormat: { settings: p.settings, head: null } });
    expect(workspace.ctx.repos.projects.header(p.id)?.settings).toEqual(p.settings);
  }
});

it("finishes an interrupted first-video match from an older library after a timeline read", async () => {
  const { ctx } = workspace;
  ctx.db.prepare("UPDATE projects SET format_set = NULL WHERE id = ?").run(project.id);
  const settings = { width: 720, height: 1280, aspect: "9:16", fps: 24 };
  ctx.repos.projects.putMedia(project.id, { id: "old-phone", name: "phone.mov", path: "phone.mov", kind: "video", ...settings }, "ready");
  ensureHead(ctx, project.id);
  vi.mocked(ctx.render.probeMedia).mockResolvedValueOnce({ kind: "video", width: 1280, height: 720, fps: 60, duration: 1, hasAudio: false });
  answers();
  expect((await importUrl("https://media.example/later.mov")).status).toBe(201);
  expect(ctx.repos.projects.header(project.id)?.settings).toEqual(project.settings);
  const result = await workspace.app.request(`/api/projects/${project.id}`, {
    method: "PATCH", headers: { Authorization: `Bearer ${accessToken(ctx)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expectedFormat: { head: null, settings: project.settings }, settings }),
  });
  expect(result.status).toBe(200);
  expect((await result.json()).project.settings).toMatchObject(settings);
});

it("refuses an oversized declared import before probing and removes its stage", async () => {
  const response = answers({ "content-length": String(64 * 1024 ** 3 + 1) });
  expect(await importUrl("https://media.example/recording")).toMatchObject({ status: 413, body: { error: { code: "download_too_large" } } });
  expect(response.destroyed).toBe(true);
  expect(workspace.ctx.render.probeMedia).not.toHaveBeenCalled();
  expect(stored()).toEqual([]);
});

it("counts actual bytes before writing each chunk even when the declared length is smaller", async () => {
  workspace.ctx.options.env!.SCARLET_URL_IMPORT_MAX_BYTES = "4";
  const response = answers({ "content-length": "3" }, [Buffer.alloc(3), Buffer.alloc(2)]);
  expect(await importUrl("https://media.example/clip")).toMatchObject({ status: 413, body: { error: { code: "download_too_large" } } });
  expect(response.destroyed).toBe(true);
  expect(stored()).toEqual([]);
  expect(workspace.ctx.repos.projects.listMedia(project.id)).toEqual([]);
});

it("keeps the library drive's free-space reserve for a response without a size", async () => {
  workspace.ctx.options.env!.SCARLET_URL_IMPORT_RESERVE_BYTES = String(Number.MAX_SAFE_INTEGER);
  const response = answers();
  expect(await importUrl("https://media.example/clip")).toMatchObject({ status: 507, body: { error: { code: "insufficient_space" } } });
  expect(response.destroyed).toBe(true);
  expect(stored()).toEqual([]);
});

it.each(["deadline", "client"] as const)("discards a partial response when the %s ends the transfer", async cause => {
  const stop = new AbortController();
  if (cause === "deadline") vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(stop.signal);
  const response = answers({}, (async function* () { yield bytes; stop.abort(); yield bytes; })());
  const { status, body } = await importUrl("https://media.example/clip", undefined, cause === "client" ? stop.signal : undefined);
  expect(status).toBe(408);
  expect(body.error.code).toBe(cause === "deadline" ? "download_timed_out" : "download_cancelled");
  expect(response.destroyed).toBe(true);
  expect(stored()).toEqual([]);
});

it("restarts a resumed download when the original window disconnects while both requests are waiting", async () => {
  const stop = new AbortController();
  vi.mocked(downloadImport).mockImplementationOnce((_url, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
  }));
  answers({ "content-disposition": 'attachment; filename="still.png"' });
  const url = "https://media.example/download";
  const importId = crypto.randomUUID();
  const original = importUrl(url, undefined, stop.signal, importId);
  await vi.waitFor(() => expect(downloadImport).toHaveBeenCalledTimes(1));
  const resumed = importUrl(url, undefined, undefined, importId);
  await new Promise(resolve => setImmediate(resolve));
  stop.abort();
  expect((await original).body.error.code).toBe("download_cancelled");
  const { status, body } = await resumed;
  expect(status).toBe(201);
  expect(body.media).toMatchObject({ name: "still.png", importId });
  expect(stored()).toEqual([body.media.path]);
});

it("turns a Google Drive share link into its direct download and leaves any other address alone", () => {
  const direct = "https://drive.google.com/uc?export=download&id=1AbC-d_9&confirm=t";
  expect(normalizeImportUrl("https://drive.google.com/file/d/1AbC-d_9/view?usp=sharing")).toBe(direct);
  expect(normalizeImportUrl("https://drive.google.com/open?id=1AbC-d_9&authuser=0")).toBe(direct);
  expect(normalizeImportUrl("https://media.example/drive.google.com.mp4?id=3")).toBe("https://media.example/drive.google.com.mp4?id=3");
});

it("stores a downloaded file under the name the server gave, with the hash of the bytes received", async () => {
  const res = answers({ "content-disposition": "attachment; filename=\"fallback.png\"; filename*=UTF-8''Caf%C3%A9%20title.PNG" });
  const importId = crypto.randomUUID();
  const url = "https://drive.google.com/file/d/1AbC/view";
  const { status, body } = await importUrl(url, undefined, undefined, importId);
  expect(status).toBe(201);
  expect(vi.mocked(downloadImport).mock.calls[0]![0].href).toBe("https://drive.google.com/uc?export=download&id=1AbC&confirm=t");
  expect(body.media).toMatchObject({ importId, name: "Café title.PNG", kind: "image", status: "ingesting",
    hash: createHash("sha256").update(bytes).digest("hex"), path: `${body.media.id}.png` });
  // Only the finished file is left: the part it was written to is gone, and the connection is closed.
  expect(stored()).toEqual([`${body.media.id}.png`]);
  expect(readFileSync(join(workspace.ctx.paths.media(project.id), body.media.path))).toEqual(bytes);
  expect(res.destroyed).toBe(true);
  expect((await importUrl(url, undefined, undefined, importId)).body.media.id).toBe(body.media.id);
  expect(downloadImport).toHaveBeenCalledTimes(1);
});

it("keeps a server's file name as sent when it isn't percent-encoding", async () => {
  // "100% done.mp4" can't be decoded as a URI component. The name is still the name.
  answers({ "content-disposition": "attachment; filename=\"100% done.png\"" });
  const { status, body } = await importUrl("https://media.example/get?id=7");
  expect(status).toBe(201);
  expect(body.media.name).toBe("100% done.png");
  expect(lines.filter(line => line.startsWith("[error]"))).toEqual([]);
});

it("names a download after the address when the server gives no name, and after the editor's when they chose one", async () => {
  answers();
  expect((await importUrl("https://media.example/clips/intro.final.png?sig=abc")).body.media).toMatchObject({ name: "intro.final.png" });
  answers();
  // No extension in the address: nothing says what kind of file it is.
  const bare = (await importUrl("https://media.example/get")).body.media;
  expect(bare).toMatchObject({ name: "download", path: `${bare.id}.bin` });
  answers({ "content-disposition": "attachment; filename=\"server.png\"" });
  expect((await importUrl("https://media.example/get", "Logo.webp")).body.media).toMatchObject({ name: "Logo.webp" });
});

it("answers 400 with the reason when the address can't be reached, and when it isn't one Scarlet downloads", async () => {
  vi.mocked(downloadImport).mockRejectedValueOnce(Object.assign(new Error("getaddrinfo ENOTFOUND media.example"), { code: "ENOTFOUND" }));
  const unreachable = await importUrl("https://media.example/clip.mp4");
  expect(unreachable.status).toBe(400);
  expect(unreachable.body.error).toEqual({ code: "download_failed", message: "Couldn’t download that URL: getaddrinfo ENOTFOUND media.example" });
  expect(lines.filter(line => line.startsWith("[error]"))).toEqual([]);

  vi.mocked(downloadImport).mockRejectedValueOnce(badRequest("invalid_url", "the media URL must resolve to a public address"));
  const local = await importUrl("http://localhost/clip.mp4");
  expect(local.status).toBe(400);
  expect(local.body.error).toEqual({ code: "invalid_url", message: "the media URL must resolve to a public address" });
  expect(stored()).toEqual([]);
});

it("removes what it had written when a download breaks off part-way", async () => {
  const res = answers({}, (async function* () { yield bytes; throw new Error("socket hang up"); })());
  const { status } = await importUrl("https://media.example/clip.png");
  expect(status).toBeGreaterThanOrEqual(400);
  expect(stored()).toEqual([]);
  expect(res.destroyed).toBe(true);
  expect(workspace.ctx.repos.projects.listMedia(project.id)).toEqual([]);
});

it("removes the copied original and rolls back its library row if saving the import fails", async () => {
  const { projects } = workspace.ctx.repos;
  vi.spyOn(projects, "touch").mockImplementationOnce(() => { throw new Error("database or disk is full"); });
  answers();
  expect((await importUrl("https://media.example/clip.png")).status).toBe(500);
  expect(stored()).toEqual([]);
  expect(projects.listMedia(project.id)).toEqual([]);
  answers();
  expect((await importUrl("https://media.example/clip.png")).status).toBe(201);
  expect(stored()).toHaveLength(1);
});

it("discards downloaded footage if the project moved to Trash before the copy finished", async () => {
  const { projects } = workspace.ctx.repos;
  answers({}, (async function* () {
    yield bytes;
    // Another instance trashed the project before this instance's next change check.
    projects.softDelete(project.id);
  })());
  expect((await importUrl("https://media.example/clip.png")).status).toBe(404);
  expect(stored()).toEqual([]);
  expect(projects.listMedia(project.id)).toEqual([]);
});
