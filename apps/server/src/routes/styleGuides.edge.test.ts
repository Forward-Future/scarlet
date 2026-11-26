import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProject, type Project } from "@scarlet/timeline";
import { ATTEMPT_HEADER, TASK_HEADER, type StyleGuideAsset, type StyleGuideRecord, type Task } from "@scarlet/shared";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import { MAX_ATTACHMENT_BYTES } from "../services/graphics.js";
import { builtInStyleSoundWav } from "../services/styleGuides.js";
import { saveTask } from "../services/tasks.js";

let directory: string;
let workspace: ScarletApp;
let project: Project;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-style-guides-edge-"));
  workspace = createApp({
    dataDir: directory,
    skillsSeedDir: join(directory, "empty-seed"),
    env: {},
    log: () => {},
  });
  project = workspace.ctx.repos.projects.insert(
    createProject("Style Guides Edge", { width: 1280, height: 720, fps: 30, aspect: "16:9" }),
  );
});

afterEach(async () => {
  if (!workspace.ctx.shutdown.aborted) await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

const auth = () => ({ Authorization: `Bearer ${accessToken(workspace.ctx)}` });
function api(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>) {
  return workspace.app.request("/api" + path, {
    method,
    body: body instanceof FormData || body instanceof ArrayBuffer || typeof body === "string" ? body : body !== undefined ? JSON.stringify(body) : undefined,
    headers: {
      ...auth(),
      ...(body !== undefined && !(body instanceof FormData) && !(body instanceof ArrayBuffer) && typeof body !== "string" && { "Content-Type": "application/json" }),
      ...extraHeaders,
    },
  });
}
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
/** A form as bytes, so a refused upload doesn't leave a half-read form stream behind. */
async function encoded(form: FormData) {
  const res = new Response(form);
  return { body: await res.arrayBuffer(), headers: { "Content-Type": res.headers.get("content-type")! } };
}
const createGuide = async (body: Record<string, unknown>) =>
  ((await (await api("POST", "/style-guides", body)).json()) as { styleGuide: StyleGuideRecord }).styleGuide;
const fileForm = (content: string | Uint8Array<ArrayBuffer>, name: string, type = "application/json", field = "file") => {
  const form = new FormData();
  form.append(field, new Blob([content], { type }), name);
  return form;
};

describe("importing a style definition file", () => {
  it("reads a definition from a path on this machine, creating a guide or updating the one named", async () => {
    const file = join(directory, "Studio Kit.style.json");
    writeFileSync(file, JSON.stringify({ description: "From disk", transitions: [{ name: "Push", type: "push" }] }));
    const created = await api("POST", "/style-guides/import-file", { path: file });
    expect(created.status).toBe(201);
    const { styleGuide } = await created.json() as { styleGuide: StyleGuideRecord };
    expect(styleGuide).toMatchObject({ name: "studio-kit", description: "From disk", source: "import" });

    writeFileSync(file, JSON.stringify({ description: "Updated from disk" }));
    const updated = await api("POST", "/style-guides/import-file", { path: file, styleGuideId: styleGuide.id });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ imported: true, styleGuide: { id: styleGuide.id, description: "Updated from disk" } });

    // The query names the guide too.
    const byQuery = await api("POST", `/style-guides/import-file?styleGuideId=${styleGuide.id}`, { path: file });
    expect(byQuery.status).toBe(200);
  });

  it("refuses a relative, missing or folder path, and leaves an oversized file to Scarlet", async () => {
    expect((await api("POST", "/style-guides/import-file", { path: "relative.json" })).status).toBe(404);
    expect((await api("POST", "/style-guides/import-file", { path: join(directory, "missing.json") })).status).toBe(404);
    expect((await api("POST", "/style-guides/import-file", { path: directory })).status).toBe(404);
    const big = join(directory, "big.json");
    writeFileSync(big, "");
    truncateSync(big, 5 * 1024 * 1024 + 1);
    const res = await api("POST", "/style-guides/import-file", { path: big });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ imported: false });
  });

  it("refuses an import for a guide that doesn't exist", async () => {
    const res = await api("POST", "/style-guides/import-file?styleGuideId=sg_missing", fileForm(JSON.stringify({ description: "x" }), "x.json"));
    expect(res.status).toBe(404);
  });

  it("needs a file field, skips other fields, and refuses an upload over 5 MB or a broken one", async () => {
    const noFile = new FormData();
    noFile.append("note", "hello");
    const missing = await api("POST", "/style-guides/import-file", noFile);
    expect(missing.status).toBe(400);
    expect(await errorCode(missing)).toBe("missing_file");

    const withOther = new FormData();
    withOther.append("other", new Blob(["{}"]), "other.json");
    withOther.append("file", new Blob([JSON.stringify({ description: "The file" })]), "real.json");
    const picked = await api("POST", "/style-guides/import-file", withOther);
    expect(picked.status).toBe(201);
    expect(await picked.json()).toMatchObject({ styleGuide: { name: "real", description: "The file" } });

    const huge = await encoded(fileForm(new Uint8Array(5 * 1024 * 1024 + 10), "huge.json"));
    const tooBig = await api("POST", "/style-guides/import-file", huge.body, huge.headers);
    expect(tooBig.status).toBe(413);

    const declaredHuge = await api("POST", "/style-guides/import-file", fileForm("{}", "x.json"), { "Content-Length": String(6 * 1024 * 1024) });
    expect(declaredHuge.status).toBe(200);
    expect(await declaredHuge.json()).toEqual({ imported: false });

    const broken = await api("POST", "/style-guides/import-file", "--zzz\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.json\"\r\n\r\n{", {
      "Content-Type": "multipart/form-data; boundary=zzz",
    });
    expect(broken.status).toBe(400);
  });
});

describe("built-in starter sounds", () => {
  const total = builtInStyleSoundWav("crisp-tick")!.byteLength;

  it("serves an open-ended range, or the whole file for a range it can't serve", async () => {
    const open = await api("GET", "/style-guides/sounds/builtin/builtin:crisp-tick", undefined, { Range: "bytes=40-" });
    expect(open.status).toBe(206);
    expect(open.headers.get("content-range")).toBe(`bytes 40-${total - 1}/${total}`);
    expect(open.headers.get("content-length")).toBe(String(total - 40));

    for (const range of [`bytes=${total + 10}-`, "items=0-1", "bytes=50-10"]) {
      const whole = await api("GET", "/style-guides/sounds/builtin/crisp-tick", undefined, { Range: range });
      expect(whole.status).toBe(200);
      expect(whole.headers.get("content-length")).toBe(String(total));
    }
  });

  // Bug: a suffix range "bytes=-N" takes N as the end byte too (routes/styleGuides.ts:151), so start > end and the whole file is sent.
  it.fails("serves the last bytes for a suffix range", async () => {
    const suffix = await api("GET", "/style-guides/sounds/builtin/crisp-tick", undefined, { Range: "bytes=-100" });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe(`bytes ${total - 100}-${total - 1}/${total}`);
    expect((await suffix.arrayBuffer()).byteLength).toBe(100);
  });

  it("doesn't know a sound that isn't built in", async () => {
    expect((await api("GET", "/style-guides/sounds/builtin/kazoo")).status).toBe(404);
  });
});

describe("guides the editor's request uses", () => {
  it("gives the library default without a task, and nothing when there is no default", async () => {
    expect(await (await api("GET", "/style-guides/active")).json()).toEqual({ styleGuides: [] });
    await createGuide({ name: "house-look", isDefault: true });
    const res = await api("GET", "/style-guides/active?projectId=&taskId=");
    expect(await res.json()).toEqual({ styleGuides: [expect.objectContaining({ name: "house-look", reason: "default" })] });
  });
});

describe("guides that aren't there", () => {
  it("answers 404 for reading, changing, deleting or editing one", async () => {
    expect((await api("GET", "/style-guides/sg_missing")).status).toBe(404);
    expect((await api("PUT", "/style-guides/sg_missing", { description: "x" })).status).toBe(404);
    expect((await api("DELETE", "/style-guides/sg_missing")).status).toBe(404);
    expect((await api("POST", "/style-guides/sg_missing/edit", { prompt: "Warmer" })).status).toBe(404);
    expect((await api("POST", "/style-guides/sg_missing/assets", fileForm("x", "a.txt"))).status).toBe(404);
    expect((await api("GET", "/style-guides/sg_missing/preview")).status).toBe(404);
    expect((await api("GET", "/style-guides/sg_missing/preview/source")).status).toBe(404);
  });

  it("refuses to bring a sound into a project that isn't there", async () => {
    expect((await api("POST", "/projects/prj_missing/media/from-style-sound", { builtInId: "soft-whoosh" })).status).toBe(404);
  });
});

describe("asking Scarlet to edit a style guide", () => {
  it("runs on the library's default agent when none is chosen, and needs a project to run from", async () => {
    const guide = await createGuide({ name: "agentless" });
    const res = await api("POST", `/style-guides/${guide.id}/edit`, { prompt: "Make it calmer." });
    expect(res.status).toBe(201);
    const { task } = await res.json() as { task: Task };
    expect(task.agent).toBe(workspace.ctx.settings().defaultAgent);

    const other = await createGuide({ name: "homeless" });
    expect((await api("DELETE", `/projects/${project.id}`)).status).toBeLessThan(300);
    const noHome = await api("POST", `/style-guides/${other.id}/edit`, { prompt: "Make it calmer.", agent: "claude" });
    expect(noHome.status).toBe(409);
    expect(await errorCode(noHome)).toBe("no_project");
  });
});

describe("a style_guide_edit task saving its guide", () => {
  async function runningEdit(name: string) {
    const guide = await createGuide({ name });
    const { task } = await (await api("POST", `/style-guides/${guide.id}/edit`, { prompt: "Add sounds", agent: "claude" })).json() as { task: Task };
    const startedAt = "2026-11-26T09:00:00.000Z";
    saveTask(workspace.ctx, { ...task, state: "running", hostId: "host_1", startedAt });
    const save = (body: Record<string, unknown>, taskId = task.id, projectId = project.id) =>
      api("POST", `/projects/${projectId}/tasks/${taskId}/style-guide-edit`, { styleGuideId: guide.id, hostId: "host_1", ...body }, { [TASK_HEADER]: task.id, [ATTEMPT_HEADER]: startedAt });
    return { guide, task, save };
  }

  it("refuses a save with nothing in it", async () => {
    const { save } = await runningEdit("empty-save");
    const res = await save({});
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("empty_update");
  });

  it("saves sounds alone", async () => {
    const { save, guide } = await runningEdit("sound-save");
    const res = await save({ sounds: [{ id: "sfx_1", name: "Pop", source: "builtin", builtInId: "subtle-pop" }] });
    expect(res.status).toBe(200);
    expect((await res.json() as { styleGuide: StyleGuideRecord }).styleGuide.sounds).toEqual([
      { id: "sfx_1", name: "Pop", source: "builtin", builtInId: "subtle-pop", volumeDb: -14, usageRule: "" },
    ]);
    expect(workspace.ctx.repos.styleGuides.get(guide.id)!.sounds).toHaveLength(1);
  });

  it("refuses a task that isn't there, belongs to another project, or isn't editing a style guide", async () => {
    const { save, task } = await runningEdit("refused-save");
    expect((await save({ description: "x" }, "tsk_missing")).status).toBe(404);
    const elsewhere = workspace.ctx.repos.projects.insert(createProject("Elsewhere"));
    expect((await save({ description: "x" }, task.id, elsewhere.id)).status).toBe(404);
    saveTask(workspace.ctx, { ...workspace.ctx.repos.tasks.get(task.id)!, context: {} });
    expect((await save({ description: "x" })).status).toBe(403);
  });
});

describe("style guide files over HTTP", () => {
  it("refuses a relative, missing or oversized path and an upload declared too large", async () => {
    const guide = await createGuide({ name: "file-limits" });
    expect((await api("POST", `/style-guides/${guide.id}/assets`, { path: "logo.png" })).status).toBe(404);
    expect((await api("POST", `/style-guides/${guide.id}/assets`, { path: join(directory, "nope.png") })).status).toBe(404);
    const big = join(directory, "big.mov");
    writeFileSync(big, "");
    truncateSync(big, MAX_ATTACHMENT_BYTES + 1);
    const oversized = await api("POST", `/style-guides/${guide.id}/assets`, { path: big });
    expect(oversized.status).toBe(413);
    expect(await errorCode(oversized)).toBe("attachment_too_large");

    const declared = await api("POST", `/style-guides/${guide.id}/assets`, fileForm("x", "a.txt", "text/plain"), { "Content-Length": String(MAX_ATTACHMENT_BYTES + 128 * 1024) });
    expect(declared.status).toBe(413);
  });

  it("needs a file field, skips other fields, and refuses a broken upload", async () => {
    const guide = await createGuide({ name: "file-fields" });
    const noFile = new FormData();
    noFile.append("note", "hello");
    const missing = await api("POST", `/style-guides/${guide.id}/assets`, noFile);
    expect(missing.status).toBe(400);
    expect(await errorCode(missing)).toBe("missing_file");

    const mixed = new FormData();
    mixed.append("note", "hello");
    mixed.append("file", new Blob(["brand"], { type: "text/plain" }), "brand.txt");
    const saved = await api("POST", `/style-guides/${guide.id}/assets`, mixed);
    expect(saved.status).toBe(201);
    expect((await saved.json() as { asset: StyleGuideAsset }).asset.name).toBe("brand.txt");

    const broken = await api("POST", `/style-guides/${guide.id}/assets`, "--zzz\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.txt\"\r\n\r\nabc", {
      "Content-Type": "multipart/form-data; boundary=zzz",
    });
    expect(broken.status).toBe(400);
  });

  it("serves a picture inline, other files as plain downloads, and 404 for a file it doesn't have", async () => {
    const guide = await createGuide({ name: "file-serving" });
    const { asset: png } = await (await api("POST", `/style-guides/${guide.id}/assets`, fileForm(new Uint8Array([137, 80, 78, 71]), "logo.png", "image/png"))).json() as { asset: StyleGuideAsset };
    const inline = await api("GET", `/style-guides/${guide.id}/assets/${png.id}`);
    expect(inline.status).toBe(200);
    expect(inline.headers.get("content-type")).toBe("image/png");
    expect(inline.headers.get("content-disposition")).toBeNull();
    expect(new Uint8Array(await inline.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));

    const { asset: text } = await (await api("POST", `/style-guides/${guide.id}/assets`, fileForm("brand", "brand.txt", "text/plain"))).json() as { asset: StyleGuideAsset };
    const download = await api("GET", `/style-guides/${guide.id}/assets/${text.id}`);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toBe("attachment");

    const unknownFolder = join(workspace.ctx.paths.styleGuideAssets(guide.id), "sga_raw");
    mkdirSync(unknownFolder, { recursive: true });
    writeFileSync(join(unknownFolder, "blob.zzqq"), "raw");
    const raw = await api("GET", `/style-guides/${guide.id}/assets/sga_raw`);
    expect(raw.headers.get("content-type")).toBe("application/octet-stream");

    expect((await api("GET", `/style-guides/${guide.id}/assets/sga_none`)).status).toBe(404);
    expect((await api("DELETE", `/style-guides/${guide.id}/assets/sga_none`)).status).toBe(404);
    expect((await api("POST", `/style-guides/${guide.id}/assets/sga_none/read`, {})).status).toBe(404);
  });

  it("has no preview picture before one is drawn", async () => {
    const guide = await createGuide({ name: "no-preview" });
    expect((await api("GET", `/style-guides/${guide.id}/preview`)).status).toBe(404);
    expect((await api("GET", `/style-guides/${guide.id}/preview/source`)).status).toBe(404);
  });
});
