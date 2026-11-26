import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProject, timelineFromKeepRanges, type Project } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { storeVersion } from "./timeline.js";
import {
  adoptLinkedFiles, assetPath, checkAttachments, findAttachment, graphicMedia, graphicSource, MAX_ATTACHMENT_BYTES, readDocument, readFileDocument,
  renderProjectGraphic, saveAttachment, saveStyleGuide, styleGuidePath, swapInFolder,
} from "./graphics.js";

// Chrome, FFmpeg and PDFium draw, measure and read pages: the test says what they give back.
const drawing = vi.hoisted(() => ({
  renderGraphic: vi.fn(), graphicCoverage: vi.fn(), graphicOver: vi.fn(), renderTimelineFrame: vi.fn(), renderPdfDocument: vi.fn(),
}));
vi.mock("@scarlet/render", async real => ({ ...await real<typeof import("@scarlet/render")>(), ...drawing }));

let directory: string;
let workspace: ScarletApp;
let project: Project;
let logs: string[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-graphics-edge-test-"));
  logs = [];
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: line => { logs.push(line); } });
  project = workspace.ctx.repos.projects.insert(createProject("Graphics"));
  workspace.ctx.paths.ensureProject(project.id);
  for (const mock of Object.values(drawing)) mock.mockReset();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

async function* chunks(...parts: Array<string | Uint8Array>) {
  for (const part of parts) yield typeof part === "string" ? new TextEncoder().encode(part) : part;
}
/** An attachment folder as the editor's drop leaves it. */
function attach(id: string, files: Record<string, string | Buffer>) {
  const folder = join(workspace.ctx.paths.attachments(project.id), id);
  mkdirSync(folder, { recursive: true });
  for (const [name, data] of Object.entries(files)) writeFileSync(join(folder, name), data);
  return folder;
}
const graphicsFolder = () => existsSync(workspace.ctx.paths.graphics(project.id)) ? readdirSync(workspace.ctx.paths.graphics(project.id)) : [];

describe("attachments", () => {
  it("keeps a dropped file under its own name, counting its size and keeping a type that says something", async () => {
    const saved = await saveAttachment(workspace.ctx, project.id, "../Brand guide.pdf", chunks("%PDF", "-1.7"), "application/pdf");
    expect(saved).toMatchObject({ name: "Brand guide.pdf", size: 8, mime: "application/pdf" });
    expect(saved.id).toMatch(/^att_/);
    expect(await findAttachment(workspace.ctx, project.id, saved.id)).toEqual({
      attachment: { id: saved.id, name: "Brand guide.pdf", size: 8, mime: "application/pdf" },
      path: join(workspace.ctx.paths.attachments(project.id), saved.id, "Brand guide.pdf"),
    });
    const plain = await saveAttachment(workspace.ctx, project.id, "notes.bin", chunks("x"), "application/octet-stream");
    expect(plain.mime).toBeUndefined();
    const long = await saveAttachment(workspace.ctx, project.id, "a.txt", chunks("x"), `text/plain; ${"x".repeat(300)}`);
    expect(long.mime).toHaveLength(200);
    expect((await saveAttachment(workspace.ctx, project.id, "a.txt", chunks())).mime).toBeUndefined();
  });

  it("refuses a file over the limit and leaves nothing of it behind", async () => {
    // A chunk that says it is over the limit is refused before anything is written.
    const huge = { byteLength: MAX_ATTACHMENT_BYTES + 1 } as Uint8Array;
    await expect(saveAttachment(workspace.ctx, project.id, "footage.mov", chunks("ok", huge))).rejects.toMatchObject({ status: 413, code: "attachment_too_large" });
    expect(readdirSync(workspace.ctx.paths.attachments(project.id))).toEqual([]);
  });

  it("finds no attachment by an unsafe id, an empty or hidden-only folder, or one whose entry is a folder", async () => {
    attach("att_hidden", { ".DS_Store": "x" });
    mkdirSync(join(attach("att_dir", {}), "inner"));
    attach("att_empty", {});
    for (const id of ["../att_hidden", "att hidden", "att_hidden", "att_dir", "att_empty", "att_none"]) {
      expect(await findAttachment(workspace.ctx, project.id, id)).toBeNull();
    }
    // A file with no known type has none.
    attach("att_raw", { "data.xyz": "1" });
    expect((await findAttachment(workspace.ctx, project.id, "att_raw"))!.attachment).toEqual({ id: "att_raw", name: "data.xyz", size: 1 });
  });

  it("checks a request's attachments are this project's, and names those that aren't", async () => {
    attach("att_logo", { "logo.png": "png" });
    expect(await checkAttachments(workspace.ctx, project.id, undefined)).toBeUndefined();
    expect(await checkAttachments(workspace.ctx, project.id, [])).toBeUndefined();
    // The type the request gave wins over the one from the name.
    expect(await checkAttachments(workspace.ctx, project.id, [{ id: "att_logo", name: "renamed.png", size: 0, mime: "image/x-custom" }]))
      .toEqual([{ id: "att_logo", name: "logo.png", size: 3, mime: "image/x-custom" }]);
    expect(await checkAttachments(workspace.ctx, project.id, [{ id: "att_logo", name: "logo.png", size: 0 }])).toEqual([{ id: "att_logo", name: "logo.png", size: 3, mime: "image/png" }]);
    await expect(checkAttachments(workspace.ctx, project.id, [{ id: "att_gone", name: "gone.pdf", size: 1 }]))
      .rejects.toMatchObject({ status: 400, code: "unknown_attachment", message: "“gone.pdf” isn't a file attached in this project. Attach it again." });
    await expect(checkAttachments(workspace.ctx, project.id, [{ id: "att_a", name: "a.pdf", size: 1 }, { id: "att_logo", name: "logo.png", size: 1 }, { id: "att_b", name: "b.pdf", size: 1 }]))
      .rejects.toMatchObject({ message: "“a.pdf”, “b.pdf” aren't files attached in this project. Attach them again." });
  });
});

describe("the style guide", () => {
  it("refuses a guide from an attachment that isn't there, and keeps one of words alone with no file", async () => {
    await expect(saveStyleGuide(workspace.ctx, project.id, { name: "House", attachmentId: "att_none" }, null)).rejects.toMatchObject({ status: 400, code: "unknown_attachment" });
    const guide = await saveStyleGuide(workspace.ctx, project.id, { name: "House", text: "Use bold sans titles." }, null);
    expect(guide).toMatchObject({ name: "House", text: "Use bold sans titles." });
    expect(guide.file).toBeUndefined();
    // Blank words are none.
    expect((await saveStyleGuide(workspace.ctx, project.id, { name: "Bare", text: "   " }, null)).text).toBeUndefined();
  });

  it("finds a guide's file only inside the project", () => {
    const { ctx } = workspace;
    expect(styleGuidePath(ctx, project.id, undefined)).toBeUndefined();
    expect(styleGuidePath(ctx, project.id, { name: "Words", savedAt: "2026-01-01T00:00:00.000Z" })).toBeUndefined();
    expect(styleGuidePath(ctx, project.id, { name: "Out", file: "../../etc/passwd", savedAt: "2026-01-01T00:00:00.000Z" })).toBeUndefined();
    expect(styleGuidePath(ctx, project.id, { name: "In", file: "style-guide/guide.pdf", savedAt: "2026-01-01T00:00:00.000Z" }))
      .toBe(join(ctx.paths.project(project.id), "style-guide", "guide.pdf"));
  });

  it("refuses to swap a folder in where its parent isn't a folder", async () => {
    writeFileSync(join(directory, "plain"), "file");
    mkdirSync(join(directory, "staging"));
    await expect(swapInFolder(join(directory, "staging"), join(directory, "plain", "guide"))).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(existsSync(join(directory, "staging"))).toBe(true);
  });

  it("reads the guide's words when it has no file, its file when it has one, and says when there is none", async () => {
    const { ctx } = workspace;
    await expect(readDocument(ctx, project.id, { styleGuide: true })).rejects.toMatchObject({ status: 404 });
    await saveStyleGuide(ctx, project.id, { name: "House", text: "Titles in white." }, null);
    expect(await readDocument(ctx, project.id, { styleGuide: true })).toEqual({ name: "House", path: "", size: 16, mime: "text/plain", text: "Titles in white." });
    await saveStyleGuide(ctx, project.id, { name: "Empty" }, null);
    expect(await readDocument(ctx, project.id, { styleGuide: true })).toEqual({ name: "Empty", path: "", size: 0, mime: "text/plain", text: "" });
    attach("att_guide", { "guide.md": "# Brand" });
    await saveStyleGuide(ctx, project.id, { name: "Brand", attachmentId: "att_guide" }, null);
    expect(await readDocument(ctx, project.id, { styleGuide: true })).toMatchObject({ name: "guide.md", mime: "text/markdown", text: "# Brand" });
  });
});

describe("reading a document", () => {
  it("reads text as text, a small picture as itself, and something else as where it is", async () => {
    const folder = attach("att_docs", {});
    writeFileSync(join(folder, "notes.json"), '{"a":1}');
    const read = (name: string) => readFileDocument(workspace.ctx, join(folder, name), name);
    expect(await read("notes.json")).toEqual({ name: "notes.json", path: join(folder, "notes.json"), size: 7, mime: "application/json", text: '{"a":1}' });
    writeFileSync(join(folder, "logo.png"), Buffer.from([1, 2, 3]));
    expect((await read("logo.png")).image).toEqual({ mime: "image/png", data: "AQID" });
    writeFileSync(join(folder, "font.woff2"), "font");
    expect(await read("font.woff2")).toEqual({ name: "font.woff2", path: join(folder, "font.woff2"), size: 4, mime: "font/woff2" });
    writeFileSync(join(folder, "model.bin"), "?");
    expect(await read("model.bin")).toEqual({ name: "model.bin", path: join(folder, "model.bin"), size: 1 });
  });

  it("shrinks a large picture to a JPEG before handing it over", async () => {
    const folder = attach("att_big", { "poster.webp": Buffer.alloc(4 * 1024 * 1024 + 1) });
    const extract = vi.spyOn(workspace.ctx.render, "extractFrame").mockResolvedValue(Buffer.from("jpeg"));
    const read = await readFileDocument(workspace.ctx, join(folder, "poster.webp"), "poster.webp");
    expect(read.image).toEqual({ mime: "image/jpeg", data: Buffer.from("jpeg").toString("base64") });
    expect(extract).toHaveBeenCalledWith(join(folder, "poster.webp"), 0, expect.objectContaining({ width: 1600 }));
  });

  it("draws a PDF's first six pages, or the whole-numbered pages asked for, up to eight", async () => {
    attach("att_pdf", { "deck.pdf": "%PDF" });
    drawing.renderPdfDocument.mockImplementation(async (_file: string, pages: number[]) => ({ pageCount: 12, pages: pages.map(page => ({ page, jpeg: Buffer.from(`p${page}`) })) }));
    const whole = await readDocument(workspace.ctx, project.id, { attachmentId: "att_pdf" });
    expect(whole).toMatchObject({ name: "deck.pdf", mime: "application/pdf", pageCount: 12 });
    expect(whole.pages!.map(p => p.page)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(whole.pages![0]!.jpeg).toBe(Buffer.from("p1").toString("base64"));
    await readDocument(workspace.ctx, project.id, { attachmentId: "att_pdf", pages: [0, 2, 2.5, -1, 3, 4, 5, 6, 7, 8, 9, 10, 11] });
    expect(drawing.renderPdfDocument.mock.calls[1]![1]).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    await readDocument(workspace.ctx, project.id, { attachmentId: "att_pdf", pages: [] });
    expect(drawing.renderPdfDocument.mock.calls[2]![1]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("says an attachment isn't there when none is named or it is gone", async () => {
    await expect(readDocument(workspace.ctx, project.id, {})).rejects.toMatchObject({ status: 404 });
    await expect(readDocument(workspace.ctx, project.id, { attachmentId: "att_gone" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("a graphic's page and files", () => {
  it("keeps every linked path inside the graphic's folder, and the page as the page", () => {
    expect(assetPath("img\\logo.png")).toBe("img/logo.png");
    expect(assetPath("./fonts//Brand.woff2")).toBe("fonts/Brand.woff2");
    for (const bad of ["", "/", "/etc/passwd", "../secret.png", "img/../../x", ".env", "img/.hidden", "C:/logo.png", "a\u0001b.png"]) {
      expect(() => assetPath(bad), bad).toThrow(expect.objectContaining({ status: 400, code: "bad_asset" }));
    }
    expect(() => assetPath("./index.html")).toThrow("index.html is the page itself.");
  });

  it("brings each linked file in once, leaves links outside the library and folders alone, and reads a bad file URL as no file", async () => {
    const root = workspace.ctx.paths.project(project.id);
    const files = attach("att_page", { "logo.png": "logo" });
    mkdirSync(join(files, "folder.png"));
    const folder = join(directory, "page");
    mkdirSync(folder);
    const outside = join(directory, "outside.png");
    writeFileSync(outside, "outside");
    const logo = join(files, "logo.png");
    const html = [
      `<img src="${logo}">`, `<img src=${logo}>`, `<img src="${join(files, "folder.png")}">`, `<img src="${outside}">`,
      `<img src="file://elsewhere/share/logo.png">`, `<img src="//cdn.example.com/logo.png">`, `<img src="">`,
    ].join("\n");
    const out = await adoptLinkedFiles(html, folder, [root]);
    expect(readdirSync(join(folder, "linked"))).toHaveLength(1);
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^<img src="linked\/[0-9a-f]{8}-logo\.png">$/);
    expect(lines[1]).toMatch(/^<img src=linked\/[0-9a-f]{8}-logo\.png>$/);
    expect(lines.slice(2)).toEqual(html.split("\n").slice(2));
  });

  it("names a drawn graphic's page, and refuses media of another project, not drawn by Scarlet, or with a page outside it", () => {
    const { ctx } = workspace;
    ctx.repos.projects.putMedia(project.id, { id: "gfx", name: "Title.mov", path: "title.mov", kind: "graphic", duration: 4, graphic: { source: "graphics/gfx_1/index.html" } }, "ready");
    ctx.repos.projects.putMedia(project.id, { id: "clip", name: "Clip.mov", path: "clip.mov", kind: "video" }, "ready");
    ctx.repos.projects.putMedia(project.id, { id: "escaped", name: "Escaped.mov", path: "e.mov", kind: "graphic", graphic: { source: "../../outside/index.html" } }, "ready");
    expect(graphicMedia(ctx, project.id, "gfx").page).toBe(join(ctx.paths.project(project.id), "graphics", "gfx_1", "index.html"));
    expect(() => graphicMedia(ctx, project.id, "nothing")).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => graphicMedia(ctx, "prj_other", "gfx")).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => graphicMedia(ctx, project.id, "clip")).toThrow(expect.objectContaining({ status: 400, code: "not_a_drawn_graphic" }));
    expect(() => graphicMedia(ctx, project.id, "escaped")).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("reads a graphic's page and lists its files, nested ones too and hidden ones not", async () => {
    const { ctx } = workspace;
    ctx.repos.projects.putMedia(project.id, { id: "gfx", name: "Title.mov", path: "title.mov", kind: "graphic", duration: 4, width: 1920, height: 1080, fps: 30,
      graphic: { source: "graphics/gfx_1/index.html" } }, "ready");
    await expect(graphicSource(ctx, project.id, "gfx")).rejects.toMatchObject({ status: 404 });
    const folder = join(ctx.paths.graphics(project.id), "gfx_1");
    mkdirSync(join(folder, "fonts"), { recursive: true });
    writeFileSync(join(folder, "index.html"), "<h1>Hi</h1>");
    writeFileSync(join(folder, "logo.png"), "png");
    writeFileSync(join(folder, ".DS_Store"), "x");
    writeFileSync(join(folder, "fonts", "Brand.woff2"), "font");
    const source = await graphicSource(ctx, project.id, "gfx");
    expect(source).toMatchObject({ mediaId: "gfx", name: "Title.mov", html: "<h1>Hi</h1>", source: join(folder, "index.html"), duration: 4, width: 1920, height: 1080, fps: 30 });
    expect(source.files.sort()).toEqual(["fonts/Brand.woff2", "logo.png"]);
  });
});

describe("drawing a graphic", () => {
  const signal = () => new AbortController().signal;
  const draw = (input: Partial<Parameters<typeof renderProjectGraphic>[2]>, over: Partial<Project> = {}, stop = signal()) =>
    renderProjectGraphic(workspace.ctx, { ...workspace.ctx.repos.projects.get(project.id)!, ...over }, { options: {}, html: "<h1>Title</h1>", assets: new Map(), ...input }, null, () => {}, stop);
  /** Chrome draws the page, but a font it asks for isn't there, so the graphic is checked and not added. */
  function missingFont() {
    drawing.renderGraphic.mockImplementation(async (opts: { htmlFile: string }) => ({ output: "", frames: 1, missingFonts: [{ family: "Brand Sans", sample: "Title" }], installedFonts: ["Helvetica"],
      problems: [], elapsedMs: 12, page: readFileSync(opts.htmlFile, "utf8") }));
    drawing.graphicCoverage.mockImplementation(async (_movie: string, times: number[]) => times.map(time => ({ time, box: { left: 0.1, top: 0.7, right: 0.6, bottom: 0.9 } })));
  }

  it("asks for the page and how long it lasts before drawing anything", async () => {
    await expect(draw({ html: undefined, options: { duration: 4 } })).rejects.toMatchObject({ status: 400, code: "missing_page" });
    await expect(draw({})).rejects.toMatchObject({ status: 400, code: "missing_duration" });
    expect(drawing.renderGraphic).not.toHaveBeenCalled();
  });

  it("refuses too many files, files too large together, or a file outside its folder, and keeps no folder", async () => {
    const many = new Map(Array.from({ length: 65 }, (_, i) => [`f${i}.png`, Buffer.from("x")] as const));
    await expect(draw({ options: { duration: 2 }, assets: many })).rejects.toMatchObject({ status: 400, code: "too_many_assets" });
    const big = new Map([["a.png", Buffer.from("a")], ["b.png", { length: 100 * 1024 * 1024 } as Buffer]]);
    await expect(draw({ options: { duration: 2 }, assets: big })).rejects.toMatchObject({ status: 413, code: "assets_too_large" });
    await expect(draw({ options: { duration: 2 }, assets: new Map([["../x.png", Buffer.from("x")]]) })).rejects.toMatchObject({ status: 400, code: "bad_asset" });
    expect(graphicsFolder()).toEqual([]);
    expect(drawing.renderGraphic).not.toHaveBeenCalled();
  });

  it("checks a graphic whose font is missing at three moments, at the project's size, and doesn't add it", async () => {
    missingFont();
    const result = await draw({ options: { duration: 3 } });
    expect(result).toEqual({ missingFonts: [{ family: "Brand Sans", sample: "Title" }], installedFonts: ["Helvetica"], problems: [],
      checks: [0.43, 1.5, 2.57].map(time => ({ time: expect.closeTo(time, 2), box: { left: 0.1, top: 0.7, right: 0.6, bottom: 0.9 } })),
      width: 1920, height: 1080, fps: 30, duration: 3, renderMs: 12 });
    expect(drawing.renderGraphic.mock.calls[0]![0]).toMatchObject({ width: 1920, height: 1080, fps: 30, duration: 3 });
    expect(drawing.graphicOver).not.toHaveBeenCalled();
    expect(graphicsFolder()).toEqual([]);
    expect(workspace.ctx.repos.projects.get(project.id)!.media).toEqual([]);
  });

  it("checks the moments asked for, never past the last frame, at the size asked for", async () => {
    missingFont();
    drawing.renderGraphic.mockResolvedValue({ output: "", frames: 1, missingFonts: [{ family: "Brand Sans", sample: "T" }], installedFonts: [], problems: ["404 logo.png"], elapsedMs: 3 });
    const result = await draw({ options: { duration: 2, fps: 25, width: 1080, height: 1920, checkTimes: [0, 1, 5] } });
    expect(drawing.graphicCoverage.mock.calls[0]![1]).toEqual([0, 1, 1.96]);
    expect(drawing.graphicCoverage.mock.calls[0]![2]).toEqual({ width: 1080, height: 1920 });
    expect(result).toMatchObject({ problems: ["404 logo.png"], width: 1080, height: 1920, fps: 25 });
    expect(result).not.toHaveProperty("installedFonts");
  });

  it("lays each check picture over the edit at the time asked, falling back from the preview pictures to the source", async () => {
    missingFont();
    const { ctx } = workspace;
    ctx.repos.projects.putMedia(project.id, { id: "camera", name: "camera.mov", path: "camera.mov", kind: "video", duration: 60 }, "ready");
    const v = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 60 }]), { parent: null });
    ctx.repos.projects.update(project.id, { head: v.version });
    drawing.renderTimelineFrame.mockImplementation(async (_p: Project, _t: unknown, _r: unknown, _root: string, _s: AbortSignal, _w: number, inputs: { pictureSource?: unknown }) => {
      if (inputs.pictureSource) throw new Error("no preview yet");
      return Buffer.from("frame");
    });
    drawing.graphicOver.mockResolvedValue(Buffer.from("over"));
    const result = await draw({ options: { duration: 2, checkTimes: [0.5], checkAt: 10, pictures: true } });
    expect(result).toMatchObject({ checkAt: 10, checks: [{ time: 0.5, jpeg: Buffer.from("over").toString("base64") }] });
    expect(drawing.renderTimelineFrame).toHaveBeenCalledTimes(2);
    expect(drawing.renderTimelineFrame.mock.calls[0]![2]).toEqual({ start: 10.5, end: 10.5 + 1 / 30 });
    expect(drawing.graphicOver.mock.calls[0]!.slice(1, 4)).toEqual([0.5, Buffer.from("frame"), { width: 960, height: 540 }]);
  });

  it("goes on without a check picture it couldn't make, saying why, and quietly once the caller has gone", async () => {
    missingFont();
    const { ctx } = workspace;
    ctx.repos.projects.putMedia(project.id, { id: "camera", name: "camera.mov", path: "camera.mov", kind: "video", duration: 60 }, "ready");
    const v = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 60 }]), { parent: null });
    ctx.repos.projects.update(project.id, { head: v.version });
    drawing.renderTimelineFrame.mockRejectedValue(new Error("decoder failed"));
    drawing.graphicOver.mockRejectedValue(new Error("overlay failed"));
    const result = await draw({ taskId: "tsk_abcdefghijkl", options: { duration: 2, checkTimes: [1], checkAt: 0, pictures: true } });
    expect(result.checks).toEqual([{ time: 1, box: expect.any(Object) }]);
    expect(logs).toContain(`[graphics] check-picture-failed stage=background task=tsk_abcdefghijkl project=${project.id} at=1.00 decoder failed`);
    expect(logs).toContain(`[graphics] check-picture-failed stage=overlay task=tsk_abcdefghijkl project=${project.id} at=1.00 overlay failed`);
    // With no edit to lay it over, a picture is drawn over grey; without a task, the log says none.
    logs.length = 0;
    ctx.repos.projects.update(project.id, { head: undefined as never });
    await draw({ options: { duration: 2, checkTimes: [1], checkAt: 3, pictures: true } }, { head: undefined });
    expect(drawing.graphicOver.mock.calls.at(-1)![2]).toBeNull();
    expect(logs.filter(l => l.includes("check-picture-failed"))).toEqual([`[graphics] check-picture-failed stage=overlay task=none project=${project.id} at=1.00 overlay failed`]);
    logs.length = 0;
    const gone = new AbortController();
    gone.abort();
    await draw({ options: { duration: 2, checkTimes: [1], checkAt: 0, pictures: true } }, {}, gone.signal);
    expect(logs.filter(l => l.includes("check-picture-failed"))).toEqual([]);
  });

  it("brings the files of the graphic it revises, but not its page, previews or hidden files, and lasts as long by default", async () => {
    missingFont();
    const { ctx } = workspace;
    const old = join(ctx.paths.graphics(project.id), "gfx_old");
    mkdirSync(join(old, "img"), { recursive: true });
    for (const name of ["index.html", "template.html", ".hidden", "preview-1.png", "logo.png", "img/bg.png"]) writeFileSync(join(old, name), name);
    ctx.repos.projects.putMedia(project.id, { id: "gfx", name: "Title.mov", path: "title.mov", kind: "graphic", duration: 5, graphic: { source: "graphics/gfx_old/index.html" } }, "ready");
    let copied: string[] = [];
    drawing.renderGraphic.mockImplementation(async (opts: { htmlFile: string }) => {
      const folder = join(opts.htmlFile, "..");
      copied = readdirSync(folder, { recursive: true }).map(String).sort();
      return { output: "", frames: 1, missingFonts: [{ family: "Brand Sans", sample: "T" }], installedFonts: [], problems: [], elapsedMs: 1 };
    });
    const result = await draw({ options: { basedOn: "gfx" }, assets: new Map([["fonts/new.woff2", Buffer.from("font")]]) });
    expect(result.duration).toBe(5);
    expect(copied).toEqual(["fonts", "fonts/new.woff2", "img", "img/bg.png", "index.html", "logo.png"]);
    // The revised graphic's own folder is untouched.
    expect(statSync(join(old, "index.html")).isFile()).toBe(true);
  });
});
