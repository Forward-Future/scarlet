import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasChrome } from "@scarlet/render";
import { createProject, type Project } from "@scarlet/timeline";
import type { GraphicRenderResponse, GraphicTemplate, GraphicTemplateSummary, Task, TaskAttachment, TaskPrompt } from "@scarlet/shared";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import { createTask } from "../services/tasks.js";
import { purgeTrash } from "../services/trash.js";

let directory: string;
let workspace: ScarletApp;
let project: Project;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-graphics-routes-test-"));
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: () => {} });
  project = workspace.ctx.repos.projects.insert(createProject("Graphics", { width: 320, height: 180, fps: 10, aspect: "custom" }));
});
afterEach(async () => {
  if (!workspace.ctx.shutdown.aborted) await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

const auth = () => ({ Authorization: `Bearer ${accessToken(workspace.ctx)}` });
function api(method: string, path: string, body?: unknown) {
  return workspace.app.request("/api" + path, { method, body: body instanceof FormData ? body : JSON.stringify(body),
    headers: { ...auth(), ...(body !== undefined && !(body instanceof FormData) && { "Content-Type": "application/json" }) } });
}
async function attach(name: string, content: string, type = "text/plain") {
  const form = new FormData();
  form.append("file", new Blob([content], { type }), name);
  const res = await api("POST", `/projects/${project.id}/attachments`, form);
  expect(res.status).toBe(201);
  return (await res.json() as { attachment: TaskAttachment }).attachment;
}
async function prompt(task: Task) {
  return (await (await api("GET", `/tasks/${task.id}/prompt`)).json() as TaskPrompt).systemPrompt;
}

const LOWER_THIRD = `<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;background:transparent}
.lt{position:absolute;left:8%;bottom:12%;padding:2% 3%;background:#c81e3c;color:#fff;font:bold 14px sans-serif;animation:in .4s both}
@keyframes in{from{opacity:0;transform:translateY(40%)}}</style></head><body><div class="lt">{{Name}}<br><small>{{Title}}</small></div></body></html>`;

describe("attachments", () => {
  it("copies in a file the desktop app names by its path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "att-"));
    const source = join(dir, "Style Guide.txt");
    writeFileSync(source, "Teal is the one accent.");
    const res = await api("POST", `/projects/${project.id}/attachments`, { path: source });
    expect(res.status).toBe(201);
    const { attachment } = await res.json();
    expect(attachment).toMatchObject({ name: "Style Guide.txt", size: 23 });
    expect(readFileSync(join(workspace.ctx.paths.attachments(project.id), attachment.id, "Style Guide.txt"), "utf8")).toBe("Teal is the one accent.");
    expect((await api("POST", `/projects/${project.id}/attachments`, { path: "relative.txt" })).status).toBe(404);
  });
  it("keeps a file in the project's folder, gives a request its path and refuses one from another project", async () => {
    const guide = await attach("Brand Guide.md", "# Our style\nUse red.", "text/markdown");
    expect(guide).toMatchObject({ name: "Brand Guide.md", size: 20, mime: "text/markdown" });
    const stored = join(workspace.ctx.paths.attachments(project.id), guide.id, "Brand Guide.md");
    expect(readFileSync(stored, "utf8")).toBe("# Our style\nUse red.");

    const created = await api("POST", `/projects/${project.id}/tasks`, { agent: "claude", instruction: "this is our style guide", context: { attachments: [{ ...guide, size: 1 }] } });
    expect(created.status).toBe(201);
    const { task } = await created.json() as { task: Task };
    expect(task.context.attachments).toEqual([guide]);
    expect(await prompt(task)).toContain(`- File the editor attached: "Brand Guide.md" (text, 1 KB), attachment ${guide.id}, at ${stored}`);

    const other = workspace.ctx.repos.projects.insert(createProject("Other"));
    const refused = await api("POST", `/projects/${other.id}/tasks`, { agent: "claude", instruction: "use it", context: { attachments: [guide] } });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("attached in this project");
  });

  it("reads a text attachment back, and goes when its project is removed for good", async () => {
    const note = await attach("notes.txt", "Accent #E11D48");
    const read = await api("POST", `/projects/${project.id}/documents/read`, { attachmentId: note.id });
    expect(await read.json()).toMatchObject({ name: "notes.txt", text: "Accent #E11D48", mime: "text/plain" });
    expect((await api("DELETE", `/projects/${project.id}`)).status).toBe(200);
    purgeTrash(workspace.ctx, Date.now() + 31 * 24 * 60 * 60 * 1000);
    while (workspace.ctx.pending.size) await Promise.allSettled([...workspace.ctx.pending]);
    expect(existsSync(workspace.ctx.paths.attachments(project.id))).toBe(false);
  });
});

describe("the style guide", () => {
  it("is one per project, comes back with the project and goes in every request's prompt there", async () => {
    const pasted = await api("PUT", `/projects/${project.id}/style-guide`, { name: "House style", text: "Titles in Inter Bold, white on #111." });
    expect(pasted.status).toBe(200);
    let detail = await (await api("GET", `/projects/${project.id}`)).json() as { project: Project };
    expect(detail.project.styleGuide).toMatchObject({ name: "House style", text: "Titles in Inter Bold, white on #111." });
    const task = createTask(workspace.ctx, { projectId: project.id, kind: "edit", agent: "claude", instruction: "add a title", createdBy: { type: "human", name: "Ed" } });
    expect(await prompt(task)).toContain("# Style guide\n\nThe editor gave this project a style guide, \"House style\", for every graphic made in it.\n\nTitles in Inter Bold, white on #111.");

    // A file replaces the pasted guide: it is copied out of its attachment and the agent is told where it is.
    const pdf = await attach("Brand.pdf", "%PDF-1.4 fixture", "application/pdf");
    expect((await api("PUT", `/projects/${project.id}/style-guide`, { name: "Brand.pdf", attachmentId: pdf.id })).status).toBe(200);
    detail = await (await api("GET", `/projects/${project.id}`)).json() as { project: Project };
    expect(detail.project.styleGuide).toMatchObject({ name: "Brand.pdf", file: "style-guide/Brand.pdf" });
    expect(detail.project.styleGuide?.text).toBeUndefined();
    const file = join(workspace.ctx.paths.project(project.id), "style-guide", "Brand.pdf");
    expect(readFileSync(file, "utf8")).toBe("%PDF-1.4 fixture");
    expect(await prompt(task)).toContain(`"Brand.pdf", for every graphic made in it.\n\nIt is in the PDF at ${file}.`);

    // The list of projects stays light.
    const list = await (await api("GET", "/projects")).json() as { projects: Array<Record<string, unknown>> };
    expect(list.projects[0]!.styleGuide).toBeUndefined();

    expect((await api("DELETE", `/projects/${project.id}/style-guide`)).status).toBe(200);
    detail = await (await api("GET", `/projects/${project.id}`)).json() as { project: Project };
    expect(detail.project.styleGuide).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    expect(await prompt(task)).not.toContain("# Style guide");
  });
});

describe.skipIf(!hasChrome())("graphics and templates", () => {
  async function render(options: Record<string, unknown>, html?: string) {
    const form = new FormData();
    form.append("options", JSON.stringify(options));
    if (html) form.append("html", new Blob([html], { type: "text/html" }), "index.html");
    const res = await api("POST", `/projects/${project.id}/graphics`, form);
    return { status: res.status, body: await res.json() as GraphicRenderResponse & { media?: { id: string; kind: string; hasAlpha: boolean; graphic?: { source: string } } } };
  }

  it("draws a page into a graphic with alpha, keeps its page beside it and reads it back", async () => {
    const page = LOWER_THIRD.replace("{{Name}}", "Daniel").replace("{{Title}}", "Host");
    const { status, body } = await render({ duration: 1, name: "Lower third", pictures: true }, page);
    expect(status).toBe(201);
    expect(body.media).toMatchObject({ kind: "graphic", hasAlpha: true, name: "Lower third.mov", graphic: { source: expect.stringMatching(/^graphics\/gfx_\w+\/index\.html$/) } });
    expect(body.missingFonts).toEqual([]);
    expect(body.checks).toHaveLength(3);
    expect(body.checks[1]!.box).toMatchObject({ left: expect.closeTo(0.08, 1) });
    expect(body.checks[1]!.jpeg).toBeTruthy();
    expect(readFileSync(body.source!, "utf8")).toBe(page);
    const source = await (await api("GET", `/projects/${project.id}/graphics/${body.media!.id}`)).json() as { html: string; duration: number };
    expect(source).toMatchObject({ html: page, duration: expect.closeTo(1, 1) });
  });

  it("keeps a linked attachment with the graphic, and a revision carries it over", async () => {
    const svg = await attach("logo.svg", `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#0f0"/></svg>`, "image/svg+xml");
    const linked = join(workspace.ctx.paths.attachments(project.id), svg.id, "logo.svg");
    const first = await render({ duration: 0.5 }, `<img src="file://${linked}" style="position:absolute;left:0;top:0">`);
    expect(first.status).toBe(201);
    const html = readFileSync(first.body.source!, "utf8");
    const copy = /src="(linked\/[^"]+)"/.exec(html)![1]!;
    expect(readFileSync(join(first.body.source!, "..", copy), "utf8")).toContain("#0f0");
    expect(first.body.checks[0]!.box).toMatchObject({ left: 0, top: 0, right: expect.closeTo(0.125, 2) });

    const revised = await render({ basedOn: first.body.media!.id, duration: 0.5 }, `<img src="${copy}" style="position:absolute;right:0;bottom:0">`);
    expect(revised.status).toBe(201);
    expect(revised.body.problems).toEqual([]);
    expect(revised.body.checks[0]!.box).toMatchObject({ right: 1, bottom: 1 });
    expect(revised.body.media!.id).not.toBe(first.body.media!.id);
  });

  it("doesn't add a graphic whose font is missing", async () => {
    const { status, body } = await render({ duration: 0.5 }, `<div style="font-family:'Nope Sans Pro';color:#fff">Hi</div>`);
    expect(status).toBe(200);
    expect(body.media).toBeUndefined();
    expect(body.missingFonts).toEqual([{ family: "Nope Sans Pro", sample: "Hi" }]);
    expect(workspace.ctx.repos.projects.listMedia(project.id)).toEqual([]);
    expect(existsSync(workspace.ctx.paths.graphics(project.id)) ? (await import("node:fs")).readdirSync(workspace.ctx.paths.graphics(project.id)) : []).toEqual([]);
  });

  it("saves a template with a preview, fills it by name and names the template a request picks with $", async () => {
    const saved = await api("POST", "/templates", { name: "lower-third", title: "Lower third", description: "A name and a role", fields: ["Name", "Title"],
      html: LOWER_THIRD, sample: { Name: "Ada Lovelace", Title: "Guest" }, projectId: project.id, width: 320, height: 180, duration: 1 });
    expect(saved.status).toBe(201);
    const { template } = await saved.json() as { template: GraphicTemplate };
    const list = await (await api("GET", "/templates")).json() as { templates: GraphicTemplateSummary[] };
    expect(list.templates).toEqual([expect.objectContaining({ id: template.id, name: "lower-third", fields: ["Name", "Title"], previewVersion: template.previewVersion })]);
    expect(list.templates[0]).not.toHaveProperty("html");
    const preview = await api("GET", `/templates/${template.id}/preview`);
    expect(preview.headers.get("content-type")).toBe("image/png");
    const png = Buffer.from(await preview.arrayBuffer());
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([640, 360]);

    // A placeholder that isn't a field is refused.
    const bad = await api("POST", "/templates", { name: "broken", title: "Broken", fields: ["Name"], html: "<p>{{Name}} {{Role}}</p>", sample: { Name: "x" } });
    expect(bad.status).toBe(400);

    const { status, body } = await render({ template: "lower-third", fields: { Name: "Daniel <Reyes>", Title: "Head of Product" } });
    expect(status).toBe(201);
    expect(readFileSync(body.source!, "utf8")).toContain("Daniel &lt;Reyes&gt;<br><small>Head of Product</small>");
    expect(body.media).toMatchObject({ name: "Lower third – Daniel <Reyes>.mov", graphic: { templateId: template.id, fields: { Name: "Daniel <Reyes>", Title: "Head of Product" } } });
    expect((await render({ template: "lower-third", fields: { Name: "x" } })).status).toBe(400);

    const task = createTask(workspace.ctx, { projectId: project.id, kind: "edit", agent: "claude", instruction: "$lower-third for Daniel, and $nothing-here", createdBy: { type: "human", name: "Ed" } });
    const text = await prompt(task);
    expect(text).toContain(`- The editor picked the graphic template $lower-third: "Lower third" (template ${template.id}), with the fields "Name", "Title".`);
    expect(text).not.toContain("$nothing-here:");

    // Saving the name again replaces it, keeping its id and drawing a new preview.
    const again = await (await api("POST", "/templates", { name: "lower-third", title: "Lower third v2", fields: ["Name"], html: "<b style='color:#fff'>{{Name}}</b>", sample: { Name: "Ada" } })).json() as { template: GraphicTemplate };
    expect(again.template.id).toBe(template.id);
    expect(again.template.previewVersion).not.toBe(template.previewVersion);
    expect((await (await api("GET", "/templates")).json() as { templates: unknown[] }).templates).toHaveLength(1);

    expect((await api("DELETE", `/templates/${template.id}`)).status).toBe(200);
    expect((await api("GET", `/templates/${template.id}/preview`)).status).toBe(404);
    expect(existsSync(workspace.ctx.paths.template(template.id))).toBe(false);
  });
});
