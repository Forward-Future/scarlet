import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChromeNotFound } from "@scarlet/render";
import { createProject, type MediaAsset, type Project } from "@scarlet/timeline";
import { StyleGuideRecord, type Skill, type Task, type User } from "@scarlet/shared";
import { createApp, type ScarletApp } from "../app.js";
import { actorFor } from "./activity.js";
import type { ProbeResult, RenderAdapter } from "../render/adapter.js";
import { scarletRenderAdapter } from "../render/scarletRender.js";
import { MAX_ATTACHMENT_BYTES } from "./graphics.js";
import {
  builtInStyleSoundWav,
  createStyleGuide,
  createStyleGuideFromGraphic,
  deleteStyleGuide,
  deleteStyleGuideAsset,
  findStyleGuideAsset,
  importStyleGuideDefinition,
  importStyleGuideSoundToProject,
  listStyleGuides,
  readStyleGuideAssetDocument,
  renderStyleGuidePreview,
  resolveActiveStyleGuides,
  resolvePromptStyleGuides,
  saveStyleGuideAsset,
  styleGuideAssetPaths,
  styleGuidePreviewImagePath,
  styleGuidePreviewSource,
  updateStyleGuide,
} from "./styleGuides.js";
import { createSkill } from "./skills.js";
import { createTask, saveTask } from "./tasks.js";

// Drawing a page needs a real headless Chrome: stand in for it so previews are fast and certain.
const still = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@scarlet/render", async importOriginal => ({
  ...await importOriginal<typeof import("@scarlet/render")>(),
  renderGraphicStill: (...args: unknown[]) => still.fn(...args),
}));

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const drawn = (over: Record<string, unknown> = {}) => ({ png: PNG, missingFonts: [], installedFonts: [], problems: [], ...over });

const editor = { id: "usr_1", name: "Editor" } as User;
const frames = vi.fn<RenderAdapter["extractFrame"]>();
const probe = vi.fn<RenderAdapter["probeMedia"]>();
const render: RenderAdapter = {
  ...scarletRenderAdapter,
  extractFrame: (...args) => frames(...args),
  probeMedia: (...args) => probe(...args),
};

let directory: string;
let workspace: ScarletApp;
let project: Project;
let logged: string[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "scarlet-style-guide-service-"));
  const chrome = join(directory, "chrome");
  writeFileSync(chrome, "");
  logged = [];
  frames.mockReset().mockResolvedValue(Buffer.from("JPEG"));
  probe.mockReset().mockImplementation((path, signal) => scarletRenderAdapter.probeMedia(path, signal));
  still.fn.mockReset().mockResolvedValue(drawn());
  workspace = createApp({
    dataDir: join(directory, "data"),
    skillsSeedDir: join(directory, "empty-seed"),
    env: { SCARLET_CHROME: chrome },
    render,
    log: line => { logged.push(line); },
  });
  project = workspace.ctx.repos.projects.insert(createProject("Style Service", { width: 1280, height: 720, fps: 30, aspect: "16:9" }));
});

afterEach(async () => {
  if (!workspace.ctx.shutdown.aborted) await workspace.ctx.close();
  await rm(directory, { recursive: true, force: true });
});

const ctx = () => workspace.ctx;
const guide = (name: string, body: Partial<Parameters<typeof createStyleGuide>[2]> = {}, extra?: Parameters<typeof createStyleGuide>[3]) =>
  createStyleGuide(ctx(), null, { name, ...body }, extra);
async function* bytes(...chunks: Array<string | Uint8Array>) {
  for (const chunk of chunks) yield typeof chunk === "string" ? Buffer.from(chunk) : chunk;
}
const addAsset = async (guideId: string, name: string, data: string | Uint8Array, mime?: string) =>
  (await saveStyleGuideAsset(ctx(), guideId, name, bytes(data), mime));
const status = (promise: Promise<unknown> | (() => unknown)) =>
  typeof promise === "function"
    ? (() => { try { promise(); return "ok"; } catch (error) { return (error as { status?: number }).status; } })()
    : promise.then(() => "ok", (error: { status?: number }) => error.status);

describe("saving, renaming and removing style guides", () => {
  it("keeps one default when a guide is made the default by an update, and refuses a name another guide has", () => {
    const first = guide("first-look", { isDefault: true });
    const second = guide("second-look");
    const updated = updateStyleGuide(ctx(), editor, second, { isDefault: true, description: "  Moody  " });
    expect(updated).toMatchObject({ isDefault: true, description: "Moody" });
    expect(ctx().repos.styleGuides.get(first.id)!.isDefault).toBe(false);
    expect(listStyleGuides(ctx()).map(g => g.name)).toEqual(["second-look", "first-look"]);
    expect(status(() => updateStyleGuide(ctx(), editor, updated, { name: "FIRST-LOOK".toLowerCase() }))).toBe(409);
    // A guide keeps its own name without clashing with itself.
    expect(updateStyleGuide(ctx(), null, updated, { name: "second-look" }).name).toBe("second-look");
  });

  it("clears a color look or caption style with null and keeps them when left out", () => {
    const g = guide("look", { captionStyle: { fontFamily: "Inter" }, colorLook: { name: "Warm", notes: "", adjustments: { exposure: 0, contrast: 1, saturation: 1, warmth: 0.2, tint: 0, shadows: 0, highlights: 0, blacks: 0, whites: 0, gamma: 1 } } });
    const kept = updateStyleGuide(ctx(), null, g, { instructions: "New rules" });
    expect(kept.captionStyle).toEqual({ fontFamily: "Inter" });
    expect(kept.colorLook?.name).toBe("Warm");
    const cleared = updateStyleGuide(ctx(), null, kept, { colorLook: null, captionStyle: null });
    expect(cleared.colorLook).toBeUndefined();
    expect(cleared.captionStyle).toBeUndefined();
    expect(cleared.instructions).toBe("New rules");
  });

  it("deletes a guide without an editor and removes its folder once saved", async () => {
    const g = guide("gone-soon");
    await addAsset(g.id, "notes.txt", "x");
    expect(existsSync(ctx().paths.styleGuideDir(g.id))).toBe(true);
    deleteStyleGuide(ctx(), g);
    expect(ctx().repos.styleGuides.get(g.id)).toBeFalsy();
    await vi.waitFor(() => expect(existsSync(ctx().paths.styleGuideDir(g.id))).toBe(false));
  });
});

describe("style guide files", () => {
  it("refuses a file for a guide that doesn't exist", async () => {
    expect(await status(saveStyleGuideAsset(ctx(), "sg_missing", "a.txt", bytes("x")))).toBe(404);
  });

  it("refuses a file over the size limit and leaves nothing behind", async () => {
    const g = guide("big-files");
    const huge = new Uint8Array(4);
    Object.defineProperty(huge, "byteLength", { value: MAX_ATTACHMENT_BYTES + 1 });
    expect(await status(saveStyleGuideAsset(ctx(), g.id, "huge.bin", bytes("ok", huge)))).toBe(413);
    expect(readdirSync(ctx().paths.styleGuideAssets(g.id))).toEqual([]);
    expect(ctx().repos.styleGuides.get(g.id)!.assets).toEqual([]);
  });

  it("names the type from the file when the upload says only octet-stream, and keeps a given type", async () => {
    const g = guide("typed-files");
    const { asset: svg } = await addAsset(g.id, "logo.svg", "<svg/>", "application/octet-stream");
    expect(svg.mime).toBe("image/svg+xml");
    const { asset: given, styleGuide } = await addAsset(g.id, "data.bin", "x", "application/x-custom");
    expect(given.mime).toBe("application/x-custom");
    expect(styleGuide.assets.map(a => a.name)).toEqual(["logo.svg", "data.bin"]);
  });

  it("measures an audio file's length to the millisecond, and leaves it out when it can't be read or is empty", async () => {
    const g = guide("audio-files");
    probe.mockResolvedValueOnce({ duration: 1.23456 } as ProbeResult);
    expect((await addAsset(g.id, "hit.wav", "RIFF")).duration).toBe(1.235);
    probe.mockRejectedValueOnce(new Error("not audio"));
    expect((await addAsset(g.id, "broken.mp3", "nope")).duration).toBeUndefined();
    probe.mockResolvedValueOnce({ duration: 0 } as ProbeResult);
    expect((await addAsset(g.id, "silent.ogg", "x", "audio/ogg")).duration).toBeUndefined();
    const calls = probe.mock.calls.length;
    expect((await addAsset(g.id, "empty.wav", "")).duration).toBeUndefined();
    expect(probe.mock.calls.length).toBe(calls);
  });

  it("finds a file on disk only by safe ids and only when it is a regular file", async () => {
    const g = guide("find-files");
    const { asset } = await addAsset(g.id, "brand.txt", "brand");
    expect(await findStyleGuideAsset(ctx(), g.id, asset.id)).toEqual({
      asset: { id: asset.id, name: "brand.txt", size: 5, mime: "text/plain" },
      path: join(ctx().paths.styleGuideAssets(g.id), asset.id, "brand.txt"),
    });
    expect(await findStyleGuideAsset(ctx(), g.id, "../escape")).toBeNull();
    expect(await findStyleGuideAsset(ctx(), "sg/../x", asset.id)).toBeNull();
    expect(await findStyleGuideAsset(ctx(), g.id, "sga_none")).toBeNull();
    mkdirSync(join(ctx().paths.styleGuideAssets(g.id), "sga_dir", "nested"), { recursive: true });
    expect(await findStyleGuideAsset(ctx(), g.id, "sga_dir")).toBeNull();
    mkdirSync(join(ctx().paths.styleGuideAssets(g.id), "sga_hidden"), { recursive: true });
    writeFileSync(join(ctx().paths.styleGuideAssets(g.id), "sga_hidden", ".DS_Store"), "");
    expect(await findStyleGuideAsset(ctx(), g.id, "sga_hidden")).toBeNull();
    expect(await status(readStyleGuideAssetDocument(ctx(), g.id, "sga_none"))).toBe(404);
  });

  it("gives each saved file its path on disk and a type from its name when none was stored", () => {
    const g = guide("paths", {}, { assets: [{ id: "sga_font", name: "Brand.woff2", size: 3 }] });
    expect(styleGuideAssetPaths(ctx(), g)).toEqual([{
      id: "sga_font", name: "Brand.woff2", size: 3, mime: "font/woff2",
      path: join(ctx().paths.styleGuideAssets(g.id), "sga_font", "Brand.woff2"),
    }]);
  });

  it("removes a file with the sounds that play it, unpairs their transitions, and clears a LUT it was", async () => {
    const g = guide("cleanup");
    const { asset: audio } = await addAsset(g.id, "swoosh.wav", "");
    const { asset: lut } = await addAsset(g.id, "Warm.cube", "LUT_3D_SIZE 2");
    const current = updateStyleGuide(ctx(), null, ctx().repos.styleGuides.get(g.id)!, {
      sounds: [
        { id: "sfx_file", name: "Swoosh", source: "asset", assetId: audio.id, volumeDb: -12, usageRule: "" },
        { id: "sfx_pop", name: "Pop", source: "builtin", builtInId: "subtle-pop", volumeDb: -12, usageRule: "" },
      ],
      transitions: [
        { id: "tr_a", name: "Push", type: "push", duration: 0.4, direction: "left", soundId: "sfx_file", usageRule: "", isDefault: true },
        { id: "tr_b", name: "Slide", type: "slide", duration: 0.4, direction: "left", soundId: "sfx_pop", usageRule: "", isDefault: false },
      ],
      colorLook: { name: "Warm", notes: "", lutAssetId: lut.id, lutName: "Warm.cube", adjustments: { exposure: 0, contrast: 1, saturation: 1, warmth: 0, tint: 0, shadows: 0, highlights: 0, blacks: 0, whites: 0, gamma: 1 } },
    });

    const afterAudio = deleteStyleGuideAsset(ctx(), editor, current.id, audio.id);
    expect(afterAudio.sounds.map(s => s.id)).toEqual(["sfx_pop"]);
    expect(afterAudio.transitions.map(t => [t.id, t.soundId])).toEqual([["tr_a", undefined], ["tr_b", "sfx_pop"]]);
    expect(afterAudio.colorLook?.lutAssetId).toBe(lut.id);
    await vi.waitFor(() => expect(existsSync(join(ctx().paths.styleGuideAssets(g.id), audio.id))).toBe(false));

    const afterLut = deleteStyleGuideAsset(ctx(), null, current.id, lut.id);
    expect(afterLut.colorLook).toMatchObject({ name: "Warm" });
    expect(afterLut.colorLook?.lutAssetId).toBeUndefined();
    expect(afterLut.colorLook?.lutName).toBeUndefined();
    expect(afterLut.assets).toEqual([]);
  });

  it("refuses to remove a file by an unsafe id, from a missing guide, or that the guide doesn't have", () => {
    const g = guide("refusals");
    expect(status(() => deleteStyleGuideAsset(ctx(), null, g.id, "../x"))).toBe(404);
    expect(status(() => deleteStyleGuideAsset(ctx(), null, "sg_missing", "sga_1"))).toBe(404);
    expect(status(() => deleteStyleGuideAsset(ctx(), null, g.id, "sga_1"))).toBe(404);
  });

  it("makes each built-in sound's WAV once and knows no sound it doesn't have", () => {
    expect(builtInStyleSoundWav("kazoo")).toBeUndefined();
    const once = builtInStyleSoundWav("builtin:crisp-tick");
    expect(once).toBeInstanceOf(Uint8Array);
    expect(builtInStyleSoundWav("crisp-tick")).toBe(once);
  });
});

describe("bringing a style guide's sound into a project", () => {
  const audioMedia = (p: string) => ctx().repos.projects.get(p)!.media.filter(m => m.kind === "audio");

  it("refuses a missing project, an unknown built-in, a missing guide, or a request that names nothing", async () => {
    const g = guide("sounds");
    expect(await status(importStyleGuideSoundToProject(ctx(), "prj_missing", null, { builtInId: "soft-whoosh" }))).toBe(404);
    expect(await status(importStyleGuideSoundToProject(ctx(), project.id, null, { builtInId: "kazoo" }))).toBe(404);
    expect(await status(importStyleGuideSoundToProject(ctx(), project.id, null, { styleGuideId: "sg_missing", soundId: "sfx_1" }))).toBe(404);
    expect(await status(importStyleGuideSoundToProject(ctx(), project.id, null, { styleGuideId: g.id, soundId: "builtin:kazoo" }))).toBe(404);
    expect(await status(importStyleGuideSoundToProject(ctx(), project.id, null, {} as never))).toBe(400);
  });

  it("refuses a guide's sound that isn't there, lacks its built-in id or file, or isn't audio", async () => {
    const g = guide("broken-sounds");
    const { asset: doc } = await addAsset(g.id, "notes.txt", "words");
    ctx().repos.styleGuides.put(StyleGuideRecord.parse({
      ...ctx().repos.styleGuides.get(g.id)!,
      sounds: [
        { id: "sfx_nobuiltin", name: "No slug", source: "builtin" },
        { id: "sfx_nofile", name: "No file", source: "asset" },
        { id: "sfx_lost", name: "Lost file", source: "asset", assetId: "sga_lost" },
        { id: "sfx_doc", name: "Doc", source: "asset", assetId: doc.id },
      ],
    }));
    const tryIt = (body: object) => status(importStyleGuideSoundToProject(ctx(), project.id, null, { styleGuideId: g.id, ...body }));
    expect(await tryIt({ soundId: "sfx_unknown" })).toBe(404);
    expect(await tryIt({ soundId: "sfx_nobuiltin" })).toBe(400);
    expect(await tryIt({ soundId: "sfx_nofile" })).toBe(400);
    expect(await tryIt({ soundId: "sfx_lost" })).toBe(404);
    expect(await tryIt({ soundId: "sfx_doc" })).toBe(400);
    expect(await tryIt({ assetId: "sga_lost" })).toBe(404);
    expect(await tryIt({ assetId: doc.id })).toBe(400);
    expect(audioMedia(project.id)).toEqual([]);
  });

  it("brings in a guide's custom sound once, and reuses the same audio for a built-in with the same bytes", async () => {
    const g = guide("custom-sounds");
    const wav = builtInStyleSoundWav("subtle-pop")!;
    const { asset } = await addAsset(g.id, "my-pop.wav", wav, "audio/wav");
    updateStyleGuide(ctx(), null, ctx().repos.styleGuides.get(g.id)!, {
      sounds: [{ id: "sfx_mine", name: "My pop", source: "asset", assetId: asset.id, volumeDb: -6, duration: 0.2, usageRule: "On badges" }],
    });

    const first = await importStyleGuideSoundToProject(ctx(), project.id, editor, { styleGuideId: g.id, soundId: "sfx_mine" });
    expect(first).toMatchObject({ name: "My pop", volumeDb: -6, usageRule: "On badges" });
    expect(first.volume).toBeCloseTo(0.501, 3);
    expect(first.media).toMatchObject({ kind: "audio", name: "My pop.wav" });

    const byAsset = await importStyleGuideSoundToProject(ctx(), project.id, editor, { styleGuideId: g.id, assetId: asset.id });
    expect(byAsset).toMatchObject({ name: "My pop", volumeDb: -6, usageRule: "On badges" });
    expect(byAsset.media.id).toBe(first.media.id);

    const builtIn = await importStyleGuideSoundToProject(ctx(), project.id, editor, { styleGuideId: g.id, soundId: "builtin:subtle-pop" });
    expect(builtIn).toMatchObject({ name: "Subtle pop", volumeDb: -12, usageRule: "When a stat callout or badge appears" });
    expect(builtIn.media.id).toBe(first.media.id);
    expect(audioMedia(project.id)).toHaveLength(1);
  });

  it("names an unlisted audio file after itself at the usual level, and a built-in entry by its own name and level", async () => {
    const g = guide("loose-audio");
    const { asset } = await addAsset(g.id, "Room Tone.wav", builtInStyleSoundWav("crisp-tick")!, "audio/wav");
    const loose = await importStyleGuideSoundToProject(ctx(), project.id, null, { styleGuideId: g.id, assetId: asset.id });
    expect(loose).toMatchObject({ name: "Room Tone", volumeDb: -14, usageRule: "" });
    expect(loose.media.name).toBe("Room Tone.wav");

    updateStyleGuide(ctx(), null, ctx().repos.styleGuides.get(g.id)!, {
      sounds: [{ id: "sfx_chime", name: "Brand chime", source: "builtin", builtInId: "clean-chime", volumeDb: -20, usageRule: "Titles" }],
    });
    const chime = await importStyleGuideSoundToProject(ctx(), project.id, null, { styleGuideId: g.id, soundId: "sfx_chime" });
    expect(chime).toMatchObject({ name: "Brand chime", volumeDb: -20, usageRule: "Titles" });
    expect(chime.media.name).toBe("Brand chime.wav");
  });
});

describe("a style guide's live preview", () => {
  const html = "<!doctype html><html><body>Sheet</body></html>";
  const previewDir = (id: string) => ctx().paths.styleGuidePreview(id);
  const leftovers = (id: string) => readdirSync(join(previewDir(id), "..")).filter(n => n.startsWith("preview."));

  it("refuses a guide that doesn't exist", async () => {
    expect(await status(renderStyleGuidePreview(ctx(), "sg_missing", { html }))).toBe(404);
    expect(await status(styleGuidePreviewSource(ctx(), "sg_missing"))).toBe(404);
  });

  it("keeps the old preview when a font is missing, naming installed fonts only when there are some", async () => {
    const g = guide("fonts");
    still.fn.mockResolvedValueOnce(drawn({ missingFonts: [{ family: "Brand", sample: "Aa" }], installedFonts: ["Inter"], problems: ["slow"] }));
    expect(await renderStyleGuidePreview(ctx(), g.id, { html })).toEqual({
      missingFonts: [{ family: "Brand", sample: "Aa" }], installedFonts: ["Inter"], problems: ["slow"], width: 1920, height: 1080,
    });
    still.fn.mockResolvedValueOnce(drawn({ missingFonts: [{ family: "Brand", sample: "Aa" }] }));
    expect(await renderStyleGuidePreview(ctx(), g.id, { html, width: 640, height: 360 })).toEqual({
      missingFonts: [{ family: "Brand", sample: "Aa" }], problems: [], width: 640, height: 360,
    });
    expect(existsSync(styleGuidePreviewImagePath(ctx(), g.id))).toBe(false);
    expect(ctx().repos.styleGuides.get(g.id)!.preview).toBeUndefined();
    expect(leftovers(g.id)).toEqual([]);
  });

  it("saves the drawn sheet with its page, draws it at the given moment, and carries linked files into the next version", async () => {
    const g = guide("sheet");
    const { asset } = await addAsset(g.id, "logo.svg", "<svg/>");
    const logo = join(ctx().paths.styleGuideAssets(g.id), asset.id, "logo.svg");
    const first = await renderStyleGuidePreview(ctx(), g.id, { html: `<img src="${logo}">`, width: 3840, height: 2160, at: 2 });
    expect(first).toMatchObject({ missingFonts: [], problems: [], width: 3840, height: 2160, jpeg: Buffer.from("JPEG").toString("base64") });
    expect(first.styleGuide?.preview).toMatchObject({ width: 3840, height: 2160 });
    expect(still.fn).toHaveBeenLastCalledWith(expect.objectContaining({ width: 3840, height: 2160, time: 2, outputWidth: 1280, chromePath: join(directory, "chrome") }));
    expect(readFileSync(styleGuidePreviewImagePath(ctx(), g.id))).toEqual(PNG);
    const linked = readdirSync(join(previewDir(g.id), "linked"));
    expect(linked).toEqual([expect.stringMatching(/^[0-9a-f]{8}-logo\.svg$/)]);
    expect(readFileSync(join(previewDir(g.id), "index.html"), "utf8")).toContain(`linked/${linked[0]}`);

    frames.mockRejectedValueOnce(new Error("no ffmpeg"));
    const second = await renderStyleGuidePreview(ctx(), g.id, { html: `<img src="linked/${linked[0]}">` });
    expect(second.jpeg).toBeUndefined();
    expect(second.styleGuide?.preview).toMatchObject({ width: 1920, height: 1080 });
    expect(still.fn).toHaveBeenLastCalledWith(expect.objectContaining({ time: 0.5 }));
    expect(readdirSync(join(previewDir(g.id), "linked"))).toEqual(linked);
    expect(leftovers(g.id)).toEqual([]);
  });

  it("cleans up its working folder when drawing fails", async () => {
    const g = guide("fails");
    still.fn.mockRejectedValueOnce(new Error("Chrome crashed"));
    await expect(renderStyleGuidePreview(ctx(), g.id, { html })).rejects.toThrow("Chrome crashed");
    expect(leftovers(g.id)).toEqual([]);
    expect(existsSync(previewDir(g.id))).toBe(false);
  });

  it("reads back the saved page with its picture, and sizes a page saved without preview details as 1920×1080", async () => {
    const g = guide("source");
    expect(await status(styleGuidePreviewSource(ctx(), g.id))).toBe(404);
    await renderStyleGuidePreview(ctx(), g.id, { html, width: 800, height: 450 });
    const saved = ctx().repos.styleGuides.get(g.id)!;
    expect(await styleGuidePreviewSource(ctx(), g.id)).toEqual({
      html, width: 800, height: 450, updatedAt: saved.preview!.updatedAt, jpeg: Buffer.from("JPEG").toString("base64"),
    });

    const bare = guide("bare-source");
    mkdirSync(previewDir(bare.id), { recursive: true });
    writeFileSync(join(previewDir(bare.id), "index.html"), "<p>hand made</p>");
    frames.mockRejectedValueOnce(new Error("no picture"));
    expect(await styleGuidePreviewSource(ctx(), bare.id)).toEqual({ html: "<p>hand made</p>", width: 1920, height: 1080, updatedAt: bare.updatedAt });
  });
});

describe("saving a project graphic as a style guide", () => {
  function graphic(mediaId: string, files: Record<string, string>, media: Partial<MediaAsset> = {}) {
    const folder = join(ctx().paths.project(project.id), "graphics", mediaId);
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(folder, rel, ".."), { recursive: true });
      writeFileSync(join(folder, rel), content);
    }
    ctx().repos.projects.putMedia(project.id, {
      id: mediaId, name: "Title Card.mov", kind: "video", path: `graphics/${mediaId}/graphic.mov`,
      duration: 4, width: 1280, height: 720, fps: 30, hasAudio: false,
      graphic: { source: `graphics/${mediaId}/index.html` }, ...media,
    }, "ready");
    return folder;
  }
  const save = (mediaId: string, name: string, extra: object = {}) =>
    createStyleGuideFromGraphic(ctx(), editor, { projectId: project.id, mediaId, name, ...extra });

  it("refuses a graphic whose page is gone or a name already taken, creating nothing", async () => {
    graphic("med_nopage", {});
    expect(await status(save("med_nopage", "no-page"))).toBe(404);
    graphic("med_taken", { "index.html": "<p>x</p>" });
    guide("taken");
    expect(await status(save("med_taken", "taken"))).toBe(409);
    expect(listStyleGuides(ctx()).map(g => g.name)).toEqual(["taken"]);
  });

  it("copies nested files but not the page, its template, hidden files or old previews, and draws the preview at its held moment", async () => {
    graphic("med_full", {
      "index.html": `<style>h1{font-family: Brand Serif, serif; color:#ABCDEF}</style><img src="img/logo.svg"><img src="./img/logo.svg">`,
      "template.html": "<p>template</p>",
      ".hidden": "x",
      "preview-0.jpg": "old",
      "img/logo.svg": "<svg/>",
      "notes.xyz": "?",
    }, { duration: 1 });
    const g = await save("med_full", "full-look", { description: "  Bold titles ", isDefault: true });
    expect(g).toMatchObject({ name: "full-look", description: "Bold titles", isDefault: true, source: "graphic:med_full" });
    expect(g.assets.map(a => a.name).sort()).toEqual(["logo.svg", "notes.xyz"]);
    expect(g.instructions).toContain("## Typography\n- Brand Serif, serif");
    expect(g.instructions).toContain("## Palette\n- #ABCDEF");
    expect(g.instructions).toContain("- notes.xyz (file)");
    const logo = join(ctx().paths.styleGuideAssets(g.id), g.assets.find(a => a.name === "logo.svg")!.id, "logo.svg");
    expect(g.instructions.match(new RegExp(logo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(2);
    expect(still.fn).toHaveBeenCalledWith(expect.objectContaining({ width: 1280, height: 720, time: 0.5 }));
    expect(g.preview).toMatchObject({ width: 1280, height: 720 });
  });

  it("keeps the saved guide without a preview when no Chrome is found, and logs other drawing failures", async () => {
    graphic("med_plain", { "index.html": "<p>Plain</p>" }, { width: undefined, height: undefined, duration: undefined });
    still.fn.mockRejectedValueOnce(new ChromeNotFound(["/nowhere"]));
    const noChrome = await save("med_plain", "no-chrome");
    expect(noChrome.preview).toBeUndefined();
    expect(noChrome.instructions).not.toContain("## Typography");
    expect(noChrome.instructions).not.toContain("## Palette");
    expect(noChrome.instructions).not.toContain("## Attached assets");
    expect(still.fn).toHaveBeenLastCalledWith(expect.objectContaining({ width: 1920, height: 1080, time: 0.5 }));
    expect(logged.filter(l => l.includes("[style-guides]"))).toEqual([]);

    still.fn.mockRejectedValueOnce(new Error("page crashed"));
    const crashed = await save("med_plain", "crashed");
    expect(crashed.preview).toBeUndefined();
    expect(logged).toContain(`[style-guides] initial preview render skipped for ${crashed.id}: page crashed`);

    still.fn.mockResolvedValueOnce(drawn({ missingFonts: [{ family: "X", sample: "x" }] }));
    const missingFont = await save("med_plain", "missing-font");
    expect(missingFont.preview).toBeUndefined();
    expect(ctx().repos.styleGuides.get(missingFont.id)).toBeTruthy();
  });

  it("lists a quoted font family under the guide's typography", async () => {
    graphic("med_quoted", { "index.html": `<style>h1{font-family: "Brand Serif", serif}</style><h1>Hi</h1>` });
    const g = await save("med_quoted", "quoted-font");
    expect(g.instructions).toContain("## Typography\n- Brand Serif, serif");
  });

  it("reads a font set in a tag's style attribute without the markup after it", async () => {
    graphic("med_inline", { "index.html": `<h1 style="font-family: Inter">Hi</h1><p style="font-family: 'Brand Sans', sans-serif">x</p>` });
    const g = await save("med_inline", "inline-font");
    expect(g.instructions).toContain("## Typography\n- Inter\n- Brand Sans, sans-serif");
  });

  it("cuts a very long page short in the guide's reference", async () => {
    graphic("med_long", { "index.html": `<p>${"a".repeat(30_000)}</p>` });
    const g = await save("med_long", "long-page");
    expect(g.instructions).toContain("<!-- truncated -->");
    expect(g.instructions.length).toBeLessThan(26_000);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("takes the new guide back out when one of the graphic's files can't be copied", async () => {
    const folder = graphic("med_locked", { "index.html": "<p>x</p>", "secret.png": "png" });
    chmodSync(join(folder, "secret.png"), 0o000);
    try {
      await expect(save("med_locked", "locked")).rejects.toThrow();
    } finally {
      chmodSync(join(folder, "secret.png"), 0o600);
    }
    expect(listStyleGuides(ctx())).toEqual([]);
  });
});

describe("which style guides a request uses", () => {
  const skill = (content: string) => ({ id: `skl_${content.length}`, name: "s", content } as Skill);
  const baseTask = (over: Partial<Task> = {}) =>
    createTask(ctx(), { projectId: project.id, kind: "edit", agent: "claude", instruction: "Add a title", createdBy: actorFor(editor), ...over } as Parameters<typeof createTask>[1]);

  it("uses none when the library has no guides", () => {
    expect(resolvePromptStyleGuides(ctx(), baseTask(), [])).toEqual([]);
    expect(resolveActiveStyleGuides(ctx())).toEqual([]);
  });

  it("gives a hand-off the guides its request named, by @mention or by id", () => {
    guide("default-look", { isDefault: true });
    const named = guide("named-look");
    const byId = guide("by-id-look");
    const parent = baseTask({ instruction: "Titles in @named-look", context: { styleGuideIds: [byId.id] } } as Partial<Task>);
    const handOff = { ...parent, id: "tsk_hand", kind: "hand_off", instruction: "Make the titles", context: { checksTaskId: parent.id } } as Task;
    expect(resolvePromptStyleGuides(ctx(), handOff, []).map(g => [g.name, g.reason])).toEqual([["by-id-look", "mentioned"], ["named-look", "mentioned"]]);
    const orphan = { ...handOff, context: { checksTaskId: "tsk_missing" } } as Task;
    expect(resolvePromptStyleGuides(ctx(), orphan, []).map(g => [g.name, g.reason])).toEqual([["default-look", "default"]]);
  });

  it("takes each guide a skill names once, and falls back to none without a default", () => {
    guide("skill-look");
    const task = baseTask();
    expect(resolvePromptStyleGuides(ctx(), task, [skill("Use @skill-look and @unknown-look."), skill("Again @skill-look")]).map(g => g.name)).toEqual(["skill-look"]);
    expect(resolvePromptStyleGuides(ctx(), task, [])).toEqual([]);
  });

  it("gives a guide's sounds as linear levels and its LUT's file and path", async () => {
    const g = guide("graded", { isDefault: true });
    const { asset: lut } = await addAsset(g.id, "Grade.cube", "LUT_3D_SIZE 2");
    updateStyleGuide(ctx(), null, ctx().repos.styleGuides.get(g.id)!, {
      captionStyle: { fontFamily: "Inter" },
      sounds: [{ id: "sfx_1", name: "Pop", source: "builtin", builtInId: "subtle-pop", volumeDb: 0, usageRule: "" }],
      colorLook: { name: "Grade", notes: "", lutAssetId: lut.id, lutName: "Grade.cube", adjustments: { exposure: 0, contrast: 1, saturation: 1, warmth: 0, tint: 0, shadows: 0, highlights: 0, blacks: 0, whites: 0, gamma: 1 } },
    });
    const lutPath = join(ctx().paths.styleGuideAssets(g.id), lut.id, "Grade.cube");
    const expected = {
      name: "graded", reason: "default", captionStyle: { fontFamily: "Inter" },
      sounds: [expect.objectContaining({ id: "sfx_1", volumeLinear: 1 })],
      colorLook: expect.objectContaining({ lutFile: `${g.id}/assets/${lut.id}/Grade.cube`, lutPath }),
    };
    expect(resolveActiveStyleGuides(ctx())).toEqual([expect.objectContaining(expected)]);
    expect(resolvePromptStyleGuides(ctx(), baseTask(), [])).toEqual([expect.objectContaining(expected)]);

    // A LUT id with no such file gives the look without a file.
    updateStyleGuide(ctx(), null, ctx().repos.styleGuides.get(g.id)!, { assets: [] });
    expect(resolveActiveStyleGuides(ctx())[0]!.colorLook).not.toHaveProperty("lutFile");
    expect(resolvePromptStyleGuides(ctx(), baseTask(), [])[0]!.colorLook).not.toHaveProperty("lutPath");
  });

  it("uses a task's own guides only within its project, and skips skills for a run beside a request", () => {
    guide("default-look", { isDefault: true });
    guide("skill-look");
    const task = baseTask({ instruction: "Plain request" });
    const skillRow = createSkill(ctx(), editor, { name: "brand-titles", content: "Draw titles in @skill-look." });
    const withSkill = saveTask(ctx(), { ...task, context: { ...task.context, skillIds: [skillRow.id] } });
    expect(resolveActiveStyleGuides(ctx(), { projectId: project.id, taskId: withSkill.id }).map(g => g.name)).toEqual(["skill-look"]);
    expect(resolveActiveStyleGuides(ctx(), { projectId: "prj_other", taskId: withSkill.id }).map(g => [g.name, g.reason])).toEqual([["default-look", "default"]]);
    expect(resolveActiveStyleGuides(ctx(), { taskId: "tsk_missing" }).map(g => g.name)).toEqual(["default-look"]);
    const aside = saveTask(ctx(), { ...withSkill, kind: "skill_from_change" });
    expect(resolveActiveStyleGuides(ctx(), { taskId: aside.id }).map(g => g.name)).toEqual(["default-look"]);
  });
});

describe("importing a style definition file", () => {
  it("refuses a guide that doesn't exist and leaves files that aren't definitions to Scarlet", () => {
    expect(status(() => importStyleGuideDefinition(ctx(), null, "{}", "x.json", { styleGuideId: "sg_missing" }))).toBe(404);
    expect(importStyleGuideDefinition(ctx(), null, JSON.stringify({ colors: ["#fff"] }), "tokens.json")).toEqual({ imported: false });
    expect(listStyleGuides(ctx())).toEqual([]);
  });

  it("names a new guide after the file, numbering it past names in use, or calls it imported-style", () => {
    const file = JSON.stringify({ description: "From a file", captionStyle: { fontFamily: "Inter" }, colorLook: null, isDefault: true });
    const first = importStyleGuideDefinition(ctx(), editor, file, "Brand Kit.style.json");
    const second = importStyleGuideDefinition(ctx(), editor, file, "brand kit.json");
    const third = importStyleGuideDefinition(ctx(), null, file, "brand-kit.JSON");
    const unnamed = importStyleGuideDefinition(ctx(), null, JSON.stringify({ description: "x" }), "!!!.json");
    const names = [first, second, third, unnamed].map(r => r.imported && r.styleGuide.name);
    expect(names).toEqual(["brand-kit", "brand-kit-2", "brand-kit-3", "imported-style"]);
    const saved = first.imported && first.styleGuide;
    expect(saved).toMatchObject({ description: "From a file", captionStyle: { fontFamily: "Inter" }, source: "import" });
    expect(saved && saved.colorLook).toBeUndefined();
    // Each import that asks to be the default takes it over.
    expect(listStyleGuides(ctx()).filter(g => g.isDefault).map(g => g.name)).toEqual(["brand-kit-3"]);
  });

  it("updates a guide in place, keeping sounds and LUTs whose files it already has and sections the file leaves out", async () => {
    const g = guide("in-place", { instructions: "KEEP", captionStyle: { fontFamily: "Inter" } });
    const { asset: audio } = await addAsset(g.id, "hit.wav", "");
    const { asset: lut } = await addAsset(g.id, "Look.cube", "LUT");
    const file = JSON.stringify({
      name: "ignored-rename",
      captionStyle: null,
      sounds: [{ name: "Hit", source: "asset", assetId: audio.id }, { name: "Gone", source: "asset", assetId: "sga_gone" }],
      transitions: [{ name: "Cut in", type: "push", sound: "Hit" }],
      colorLook: { name: "Look", lutAssetId: lut.id, lutName: "Look.cube" },
      isDefault: true,
    });
    const result = importStyleGuideDefinition(ctx(), editor, file, "update.json", { styleGuideId: g.id });
    expect(result.imported).toBe(true);
    const updated = result.imported ? result.styleGuide : undefined;
    expect(updated).toMatchObject({ id: g.id, name: "in-place", instructions: "KEEP", isDefault: true });
    expect(updated!.captionStyle).toBeUndefined();
    expect(updated!.sounds).toEqual([expect.objectContaining({ name: "Hit", source: "asset", assetId: audio.id })]);
    expect(updated!.transitions[0]!.soundId).toBe(updated!.sounds[0]!.id);
    expect(updated!.colorLook).toMatchObject({ lutAssetId: lut.id, lutName: "Look.cube" });
  });
});
