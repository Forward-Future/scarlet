import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findChrome, hasChrome } from "@scarlet/render";
import { createProject, type MediaAsset, type Project } from "@scarlet/timeline";
import { ATTEMPT_HEADER, TASK_HEADER, type StyleGuideAsset, type StyleGuideRecord, type Task, type TaskPrompt } from "@scarlet/shared";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import { saveTask } from "../services/tasks.js";

let directory: string;
let workspace: ScarletApp;
let project: Project;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-style-guides-test-"));
  workspace = createApp({
    dataDir: directory,
    skillsSeedDir: join(directory, "empty-seed"),
    env: hasChrome() ? { SCARLET_CHROME: findChrome() } : {},
    log: () => {},
  });
  project = workspace.ctx.repos.projects.insert(
    createProject("Style Guides Test", { width: 1280, height: 720, fps: 30, aspect: "16:9" }),
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
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
    headers: {
      ...auth(),
      ...(body !== undefined && !(body instanceof FormData) && { "Content-Type": "application/json" }),
      ...extraHeaders,
    },
  });
}

async function prompt(task: Task): Promise<string> {
  const res = await api("GET", `/tasks/${task.id}/prompt`);
  expect(res.status).toBe(200);
  return (await res.json() as TaskPrompt).systemPrompt;
}

describe("style guides CRUD & default semantics", () => {
  it("creates, lists, updates, enforces a single default, rejects duplicates, and cleans up files on delete", async () => {
    const firstRes = await api("POST", "/style-guides", {
      name: "channel-brand",
      description: "Warm cream and terracotta lower thirds.",
      instructions: "Use #F5F2EB panels and #E05A3A accents.",
      isDefault: true,
    });
    expect(firstRes.status).toBe(201);
    const first = (await firstRes.json() as { styleGuide: StyleGuideRecord }).styleGuide;
    expect(first).toMatchObject({ name: "channel-brand", isDefault: true });

    // Invalid uppercase slug is rejected with 400; duplicate slug is rejected with 409.
    const badRes = await api("POST", "/style-guides", { name: "Channel-Brand", description: "Bad", instructions: "" });
    expect(badRes.status).toBe(400);
    const dupRes = await api("POST", "/style-guides", { name: "channel-brand", description: "Dup", instructions: "" });
    expect(dupRes.status).toBe(409);

    // Setting a second style guide as default clears isDefault on the first.
    const secondRes = await api("POST", "/style-guides", {
      name: "tech-brief",
      description: "Dark slate with cyan badges.",
      instructions: "Use #0F172A cards and #38BDF8 highlights.",
      isDefault: true,
    });
    expect(secondRes.status).toBe(201);
    const second = (await secondRes.json() as { styleGuide: StyleGuideRecord }).styleGuide;
    expect(second.isDefault).toBe(true);

    const listRes = await api("GET", "/style-guides");
    const { styleGuides } = await listRes.json() as { styleGuides: StyleGuideRecord[] };
    expect(styleGuides.map(g => [g.name, g.isDefault])).toEqual([
      ["tech-brief", true],
      ["channel-brand", false],
    ]);

    // Upload an asset so the style guide has a folder on disk, then delete it and verify cleanup.
    const form = new FormData();
    form.append("file", new Blob(["hello"], { type: "text/plain" }), "brand.txt");
    const upRes = await api("POST", `/style-guides/${first.id}/assets`, form);
    expect(upRes.status).toBe(201);
    expect(existsSync(workspace.ctx.paths.styleGuideDir(first.id))).toBe(true);

    const delRes = await api("DELETE", `/style-guides/${first.id}`);
    expect(delRes.status).toBe(200);
    expect((await api("GET", `/style-guides/${first.id}`)).status).toBe(404);
    await new Promise(r => setTimeout(r, 30));
    expect(existsSync(workspace.ctx.paths.styleGuideDir(first.id))).toBe(false);
  });
});

describe("style guide assets", () => {
  it("stores multipart and path uploads, sandboxes active SVGs on download, and reads text documents", async () => {
    const created = (await (await api("POST", "/style-guides", { name: "brand-assets" })).json() as { styleGuide: StyleGuideRecord }).styleGuide;

    // Multipart SVG upload
    const form = new FormData();
    form.append("file", new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'], { type: "image/svg+xml" }), "logo.svg");
    const svgUp = await api("POST", `/style-guides/${created.id}/assets`, form);
    expect(svgUp.status).toBe(201);
    const { asset: svgAsset } = await svgUp.json() as { asset: StyleGuideAsset };

    const svgDownload = await api("GET", `/style-guides/${created.id}/assets/${svgAsset.id}`);
    expect(svgDownload.status).toBe(200);
    expect(svgDownload.headers.get("content-security-policy")).toBe("sandbox");
    expect(svgDownload.headers.get("content-disposition")).toContain("attachment");

    // Local path upload + read
    const tmpFile = join(directory, "rules.md");
    writeFileSync(tmpFile, "# Brand Guide\nAlways use matte black.");
    const pathUp = await api("POST", `/style-guides/${created.id}/assets`, { path: tmpFile });
    expect(pathUp.status).toBe(201);
    const { asset: mdAsset } = await pathUp.json() as { asset: StyleGuideAsset };

    const readRes = await api("POST", `/style-guides/${created.id}/assets/${mdAsset.id}/read`, {});
    expect(readRes.status).toBe(200);
    const doc = await readRes.json() as { text: string };
    expect(doc.text).toContain("Always use matte black.");
  });
});

describe("1-click save as style from graphic", () => {
  it("copies graphic HTML and linked files into a reusable style guide with clean names", async () => {
    const mediaId = "med_gfx_save";
    const gfxDir = join(workspace.ctx.paths.project(project.id), "graphics", mediaId);
    const linkedDir = join(gfxDir, "linked");
    mkdirSync(linkedDir, { recursive: true });
    writeFileSync(join(linkedDir, "a1b2c3d4-logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    writeFileSync(
      join(gfxDir, "index.html"),
      `<!doctype html><html><head><style>body{background:#121316;color:#f5f2eb;font-family:Inter,sans-serif;}</style></head><body><img src="linked/a1b2c3d4-logo.svg"></body></html>`,
    );

    const media: MediaAsset = {
      id: mediaId,
      name: "Lower Third.mov",
      kind: "video",
      path: `graphics/${mediaId}/graphic.mov`,
      duration: 4,
      width: 1280,
      height: 720,
      fps: 30,
      hasAudio: false,
      graphic: {
        source: `graphics/${mediaId}/index.html`,
      },
    };
    workspace.ctx.repos.projects.putMedia(project.id, media, "ready");

    const res = await api("POST", "/style-guides/from-graphic", {
      projectId: project.id,
      mediaId,
      name: "lower-third-look",
    });
    expect(res.status).toBe(201);
    const { styleGuide } = await res.json() as { styleGuide: StyleGuideRecord };
    expect(styleGuide.name).toBe("lower-third-look");
    expect(styleGuide.description).toBe("Saved from Lower Third");
    expect(styleGuide.instructions).toContain("#121316");
    expect(styleGuide.instructions).toContain("Inter,sans-serif");
    // Dedupe hash prefix stripped from linked asset name
    expect(styleGuide.assets).toHaveLength(1);
    expect(styleGuide.assets[0]!.name).toBe("logo.svg");
    const copiedPath = join(workspace.ctx.paths.styleGuideAssets(styleGuide.id), styleGuide.assets[0]!.id, "logo.svg");
    expect(readFileSync(copiedPath, "utf8")).toContain("<svg");
  });
});

describe("style_guide_edit authoring flow and project isolation", () => {
  it("runs style_guide_edit outside project tasks, builds its prompt, accepts authorized saves, and blocks project edits", async () => {
    const guide = (await (await api("POST", "/style-guides", { name: "editorial-look" })).json() as { styleGuide: StyleGuideRecord }).styleGuide;

    // Direct style_guide_edit creation on project tasks route is rejected.
    const direct = await api("POST", `/projects/${project.id}/tasks`, {
      kind: "style_guide_edit",
      agent: "claude",
      instruction: "nope",
    });
    expect(direct.status).toBe(400);

    // Start an authoring task via the style guide edit route.
    const editRes = await api("POST", `/style-guides/${guide.id}/edit`, {
      prompt: "Make it warm cream and editorial serif.",
      agent: "claude",
    });
    expect(editRes.status).toBe(201);
    const { task } = await editRes.json() as { task: Task };
    expect(task.kind).toBe("style_guide_edit");

    // Excluded from project conversation task list.
    const projectTasks = (await (await api("GET", `/projects/${project.id}/tasks`)).json() as { tasks: Task[] }).tasks;
    expect(projectTasks.some(t => t.id === task.id)).toBe(false);

    // Prompt describes style guide authoring mode and tools.
    const text = await prompt(task);
    expect(text).toContain("@editorial-look");
    expect(text).toContain("style_guide_preview_render");
    expect(text).toContain("style_guide_update");

    // Claim and mark task running so active attempt checks pass.
    const startedAt = "2026-11-24T12:00:00.000Z";
    saveTask(workspace.ctx, { ...task, state: "running", hostId: "host_1", startedAt });

    // Authorized save succeeds and sets resultStyleGuideId.
    const saveRes = await api(
      "POST",
      `/projects/${project.id}/tasks/${task.id}/style-guide-edit`,
      {
        styleGuideId: guide.id,
        hostId: "host_1",
        description: "Editorial serif on warm cream.",
        instructions: "Use warm cream #F5F2EB and Playfair Display.",
      },
      { [TASK_HEADER]: task.id, [ATTEMPT_HEADER]: startedAt },
    );
    expect(saveRes.status).toBe(200);
    const { styleGuide: updated } = await saveRes.json() as { styleGuide: StyleGuideRecord };
    expect(updated.description).toBe("Editorial serif on warm cream.");
    expect(workspace.ctx.repos.tasks.get(task.id)?.resultStyleGuideId).toBe(guide.id);

    // Wrong hostId is rejected with 403.
    const wrongHost = await api(
      "POST",
      `/projects/${project.id}/tasks/${task.id}/style-guide-edit`,
      {
        styleGuideId: guide.id,
        hostId: "host_other",
        instructions: "hijack",
      },
      { [TASK_HEADER]: task.id, [ATTEMPT_HEADER]: startedAt },
    );
    expect(wrongHost.status).toBe(403);

    // Style guide tasks cannot modify the borrowed project.
    const projectWrite = await api(
      "PUT",
      `/projects/${project.id}/style-guide`,
      { text: "should fail" },
      { [TASK_HEADER]: task.id, [ATTEMPT_HEADER]: startedAt },
    );
    expect(projectWrite.status).toBe(403);
  });
});

describe("prompt resolution priority (chat @mention > skill @mention > default)", () => {
  it("stays off until Style guides (Beta) is enabled, then applies default and @mention overrides", async () => {
    const defGuide = (await (await api("POST", "/style-guides", {
      name: "channel-default",
      description: "Default cream look",
      instructions: "DEFAULT_CREAM_RULE",
      isDefault: true,
    })).json() as { styleGuide: StyleGuideRecord }).styleGuide;
    const altGuide = (await (await api("POST", "/style-guides", {
      name: "neon-dark",
      description: "Neon cyberpunk look",
      instructions: "NEON_DARK_RULE",
    })).json() as { styleGuide: StyleGuideRecord }).styleGuide;

    // 0. While Style guides (Beta) is off (default), no style guide is injected into prompts.
    const tOff = (await (await api("POST", `/projects/${project.id}/tasks`, {
      agent: "claude",
      instruction: "Add a chapter card in @neon-dark",
      context: { styleGuideIds: [altGuide.id] },
    })).json() as { task: Task }).task;
    const pOff = await prompt(tOff);
    expect(pOff).not.toContain("DEFAULT_CREAM_RULE");
    expect(pOff).not.toContain("NEON_DARK_RULE");

    // Enable Style guides (Beta) in settings.
    const enableRes = await api("PATCH", "/settings", { styleGuidesBeta: true });
    expect(enableRes.status).toBe(200);

    // 1. Plain request with no @mention gets the default style automatically.
    const t1 = (await (await api("POST", `/projects/${project.id}/tasks`, {
      agent: "claude",
      instruction: "Add a chapter card at 0:10",
    })).json() as { task: Task }).task;
    const p1 = await prompt(t1);
    expect(p1).toContain("@channel-default");
    expect(p1).toContain("DEFAULT_CREAM_RULE");
    expect(p1).not.toContain("NEON_DARK_RULE");

    // 2. Chat @mention overrides default.
    const t2 = (await (await api("POST", `/projects/${project.id}/tasks`, {
      agent: "claude",
      instruction: "Add a chapter card in @neon-dark",
      context: { styleGuideIds: [altGuide.id] },
    })).json() as { task: Task }).task;
    const p2 = await prompt(t2);
    expect(p2).toContain("@neon-dark");
    expect(p2).toContain("NEON_DARK_RULE");
    expect(p2).not.toContain("DEFAULT_CREAM_RULE");

    // 3. Skill mentioning @neon-dark overrides default when chat has no @mention.
    const skillRes = await api("POST", "/skills", {
      name: "chapter-cards",
      description: "Builds chapter cards",
      content: "Always draw chapter cards matching @neon-dark.",
    });
    expect(skillRes.status).toBe(201);
    const { skill } = await skillRes.json() as { skill: { id: string } };
    const t3 = (await (await api("POST", `/projects/${project.id}/tasks`, {
      agent: "claude",
      instruction: "Run /chapter-cards",
      context: { skillIds: [skill.id] },
    })).json() as { task: Task }).task;
    const p3 = await prompt(t3);
    expect(p3).toContain("@neon-dark");
    expect(p3).toContain("NEON_DARK_RULE");
    expect(p3).not.toContain("DEFAULT_CREAM_RULE");
    expect(defGuide.id).not.toBe(altGuide.id);
  });
});

describe("live preview rendering", () => {
  it.skipIf(!hasChrome())("renders a 16:9 PNG preview and returns its HTML source", async () => {
    const guide = (await (await api("POST", "/style-guides", { name: "live-preview-test" })).json() as { styleGuide: StyleGuideRecord }).styleGuide;
    const html = `<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;font:700 48px sans-serif;}</style></head><body>STYLE SHEET</body></html>`;

    const renderRes = await api("POST", `/style-guides/${guide.id}/preview`, { html, width: 640, height: 360 });
    expect(renderRes.status).toBe(200);
    const rendered = await renderRes.json() as { styleGuide?: StyleGuideRecord; missingFonts: string[] };
    expect(rendered.missingFonts).toEqual([]);
    expect(rendered.styleGuide?.preview).toMatchObject({ width: 640, height: 360 });

    const imgRes = await api("GET", `/style-guides/${guide.id}/preview`);
    expect(imgRes.status).toBe(200);
    expect(imgRes.headers.get("content-type")).toBe("image/png");
    const png = Buffer.from(await imgRes.arrayBuffer());
    expect(png.subarray(1, 4).toString()).toBe("PNG");

    const srcRes = await api("GET", `/style-guides/${guide.id}/preview/source`);
    expect(srcRes.status).toBe(200);
    const src = await srcRes.json() as { html: string; width: number; height: number };
    expect(src.html).toContain("STYLE SHEET");
    expect([src.width, src.height]).toEqual([640, 360]);
  });
});
