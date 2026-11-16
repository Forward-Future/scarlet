/**
 * Motion graphics: pages Scarlet draws into movies with alpha, templates saved from them, the files an editor attaches
 * to a message, and a project's style guide.
 *
 * A graphic's page and every file it links to are kept in one folder of the project (`graphics/<id>/index.html`), so
 * any later request, by any model, can read and revise it. A template keeps its page and files in a library folder
 * (`templates/<id>/`), so a template saved in one project fills the same way in another.
 */
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, graphicCoverage, graphicOver, renderPdfDocument, renderGraphic, renderGraphicStill, renderTimelineFrame, type MissingFont } from "@scarlet/render";
import { GraphicTemplate, type TransitionStyle, type GraphicRenderRequest, type GraphicRenderResponse, type GraphicTemplateSummary, type SaveStyleGuideRequest, type SaveTemplateRequest, type TaskAttachment, type User } from "@scarlet/shared";
import { newId, type MediaAsset, type Project, type StyleGuide } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { badRequest, conflict, HttpError, notFound } from "../errors.js";
import { actorFor, logActivity, quote } from "./activity.js";
import { ingestMedia } from "./ingest.js";
import { safeFileName } from "./fileName.js";
import { previewPictures } from "./previewPictures.js";
import { resolveTimeline } from "./timeline.js";

/** An attachment is a document, a font or a picture. Footage is imported as media instead. */
export const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;
/** The files a page links to that come with it in one request. */
const MAX_ASSET_BYTES = 100 * 1024 * 1024;
const MAX_ASSETS = 64;
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/** A file name kept as the editor gave it, minus anything that could leave its folder or hide it. */
export function attachmentName(name: string): string {
  const base = safeFileName(basename(name.replace(/\\/g, "/")), "_").replace(/^\.+/, "").trim().slice(0, 200);
  return base || "attachment";
}

/** Store a file the editor attached to a message under the project's folder. */
export async function saveAttachment(ctx: Ctx, projectId: string, name: string, data: AsyncIterable<Uint8Array>, mime?: string, signal?: AbortSignal): Promise<TaskAttachment> {
  const id = newId("att");
  const folder = join(ctx.paths.attachments(projectId), id);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const file = join(folder, attachmentName(name));
  let size = 0;
  try {
    async function* counted() {
      for await (const chunk of data) {
        size += chunk.byteLength;
        if (size > MAX_ATTACHMENT_BYTES) throw new HttpError(413, "attachment_too_large", `An attachment can be up to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB. Add footage to the project as media instead.`);
        yield chunk;
      }
    }
    await writeFile(file, counted(), { flag: "wx", mode: 0o600, signal });
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
  return { id, name: basename(file), size, ...(mime && mime !== "application/octet-stream" && { mime: mime.slice(0, 200) }) };
}

/** An attachment of this project and where it is, or null. */
export async function findAttachment(ctx: Ctx, projectId: string, id: string): Promise<{ attachment: TaskAttachment; path: string } | null> {
  if (!SAFE_ID.test(id)) return null;
  const folder = join(ctx.paths.attachments(projectId), id);
  const names = await readdir(folder).catch(() => [] as string[]);
  const name = names.find(n => !n.startsWith("."));
  if (!name) return null;
  const path = join(folder, name);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return null;
  return { attachment: { id, name, size: info.size, ...(mimeFor(name) && { mime: mimeFor(name) }) }, path };
}

/** The attachments a request names, as they are stored: each must be a file attached in this project. */
export async function checkAttachments(ctx: Ctx, projectId: string, attachments: TaskAttachment[] | undefined): Promise<TaskAttachment[] | undefined> {
  if (!attachments?.length) return undefined;
  const found = await Promise.all(attachments.map(a => findAttachment(ctx, projectId, a.id)));
  const missing = attachments.filter((_, i) => !found[i]);
  if (missing.length) throw badRequest("unknown_attachment", `${missing.map(a => quote(a.name)).join(", ")} ${missing.length === 1 ? "isn't a file" : "aren't files"} attached in this project. Attach ${missing.length === 1 ? "it" : "them"} again.`);
  return found.map((f, i) => ({ ...f!.attachment, ...(attachments[i]!.mime && { mime: attachments[i]!.mime }) }));
}

const MIME: Record<string, string> = {
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".html": "text/html", ".htm": "text/html", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2",
};
export const mimeFor = (name: string): string | undefined => MIME[extname(name).toLowerCase()];

// ---------------------------------------------------------------------------
// Style guide
// ---------------------------------------------------------------------------

/** Save the project's one style guide, replacing any before it. A file is copied out of its attachment, so it outlives it. */
export async function saveStyleGuide(ctx: Ctx, projectId: string, body: SaveStyleGuideRequest, user: User | null): Promise<StyleGuide> {
  const folder = ctx.paths.styleGuides(projectId);
  let file: string | undefined;
  if (body.attachmentId) {
    const found = await findAttachment(ctx, projectId, body.attachmentId);
    if (!found) throw badRequest("unknown_attachment", "That attachment isn't in this project. Ask the editor to attach the guide again.");
    const staging = `${folder}.${randomUUID()}`;
    try {
      await mkdir(staging, { recursive: true, mode: 0o700 });
      await cp(found.path, join(staging, found.attachment.name));
      await swapInFolder(staging, folder);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    file = relative(ctx.paths.project(projectId), join(folder, found.attachment.name)).split(sep).join("/");
  } else await rm(folder, { recursive: true, force: true });
  const guide: StyleGuide = { name: body.name, ...(body.text?.trim() && { text: body.text }), ...(file && { file }), savedAt: now() };
  ctx.repos.projects.saveStyleGuide(projectId, guide);
  const project = ctx.repos.projects.get(projectId);
  if (project) ctx.bus.publish({ type: "project.updated", projectId, project });
  logActivity(ctx, { projectId, actor: actorFor(user), type: "project.style_guide", summary: `The style guide is now ${quote(guide.name)}`, data: { name: guide.name } });
  return guide;
}

export async function removeStyleGuide(ctx: Ctx, projectId: string, user: User | null) {
  await rm(ctx.paths.styleGuides(projectId), { recursive: true, force: true });
  ctx.repos.projects.saveStyleGuide(projectId, undefined);
  const project = ctx.repos.projects.get(projectId);
  if (project) ctx.bus.publish({ type: "project.updated", projectId, project });
  logActivity(ctx, { projectId, actor: actorFor(user), type: "project.style_guide", summary: "The style guide was removed" });
}

/**
 * Put a folder made beside `folder` in its place. The folder there before is moved aside first and put back if the new
 * one can't go in, so `folder` is never left missing while the database points at it. The one aside is then removed.
 */
export async function swapInFolder(staging: string, folder: string) {
  const aside = `${folder}.old-${randomUUID()}`;
  const hadOld = await rename(folder, aside).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  try {
    await rename(staging, folder);
  } catch (error) {
    if (hadOld) await rename(aside, folder).catch(() => undefined);
    throw error;
  }
  if (hadOld) await rm(aside, { recursive: true, force: true }).catch(() => undefined);
}

/** Where the guide's file is, when it is a file. */
export function styleGuidePath(ctx: Ctx, projectId: string, guide: StyleGuide | undefined): string | undefined {
  if (!guide?.file) return undefined;
  const path = resolve(ctx.paths.project(projectId), guide.file);
  return inside(ctx.paths.project(projectId), path) ? path : undefined;
}

// ---------------------------------------------------------------------------
// Pages and the files they link to
// ---------------------------------------------------------------------------

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

/** A relative path a page links to, checked so it stays in the page's folder. */
export function assetPath(name: string): string {
  const parts = name.replace(/\\/g, "/").split("/").filter(p => p && p !== ".");
  if (!parts.length || parts.some(p => p === ".." || p.startsWith(".") || /[\u0000-\u001f:]/.test(p)) || name.startsWith("/")) {
    throw badRequest("bad_asset", `${quote(name)} isn't a path inside the graphic's folder. Link files by a path relative to the page.`);
  }
  if (parts.join("/") === "index.html") throw badRequest("bad_asset", "index.html is the page itself.");
  return parts.join("/");
}

/** A link in a page: a quoted attribute or `url()` up to its closing quote (spaces and all), or an unquoted one. */
const LINKS = /(\b(?:src|href)\s*=\s*|url\(\s*)(?:"([^"]*)"|'([^']*)'|([^"')\s>]+))/gi;

/** The file a link names, when it names one by absolute path or file URL. A file URL is decoded by its parser. */
function linkedFile(link: string): string | undefined {
  try {
    if (/^file:/i.test(link)) return resolve(fileURLToPath(link));
  } catch { return undefined; }
  if (!isAbsolute(link) || link.startsWith("//")) return undefined;
  // The page reads a plain path as a URL, so `%20` is a space. A `%` that isn't an escape (`100%.png`) stays as written.
  try { return resolve(decodeURIComponent(link)); } catch { return resolve(link); }
}

/**
 * Bring the files of this library that a page links to by absolute path or file URL (an attachment, a style guide's
 * font, another graphic's picture) into its folder, and link them there. A graphic keeps working when the attachment
 * or the project it came from is gone.
 */
export async function adoptLinkedFiles(html: string, folder: string, roots: string[]): Promise<string> {
  const copies = new Map<string, string>();
  for (const match of html.matchAll(LINKS)) {
    const link = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (!link || copies.has(link)) continue;
    let file = linkedFile(link);
    // A path with a literal `%` that decoding read as an escape is the file as written.
    if (file && !(await stat(file).catch(() => null))?.isFile() && !/^file:/i.test(link) && resolve(link) !== file) file = resolve(link);
    if (!file || !roots.some(root => inside(root, file!))) continue;
    if (!(await stat(file).catch(() => null))?.isFile()) continue;
    const name = `${createHash("sha256").update(file).digest("hex").slice(0, 8)}-${basename(file)}`;
    await mkdir(join(folder, "linked"), { recursive: true });
    await cp(file, join(folder, "linked", name));
    copies.set(link, `linked/${encodeURIComponent(name)}`);
  }
  if (!copies.size) return html;
  return html.replace(LINKS, (all, lead: string, double?: string, single?: string, bare?: string) => {
    const copy = copies.get((double ?? single ?? bare ?? "").trim());
    if (!copy) return all;
    return lead + (double !== undefined ? `"${copy}"` : single !== undefined ? `'${copy}'` : copy);
  });
}

/** Copy a folder's files, except its page, into another. */
async function copyFiles(from: string, to: string) {
  const entries = await readdir(from, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === "index.html" || entry.name === "template.html" || entry.name.startsWith(".") || entry.name.startsWith("preview-")) continue;
    await cp(join(from, entry.name), join(to, entry.name), { recursive: true });
  }
}

async function writeAssets(folder: string, assets: Map<string, Buffer>) {
  if (assets.size > MAX_ASSETS) throw badRequest("too_many_assets", `A graphic can bring up to ${MAX_ASSETS} files.`);
  let total = 0;
  for (const [name, data] of assets) {
    total += data.length;
    if (total > MAX_ASSET_BYTES) throw new HttpError(413, "assets_too_large", "The graphic's files are too large together.");
    const path = join(folder, assetPath(name));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** The `{{Field}}` placeholders in a page, as written. */
export function placeholders(html: string): string[] {
  return [...new Set([...html.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(m => m[1]!))];
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The page with each field's value in place of its placeholder, as text. */
export function fillTemplate(template: Pick<GraphicTemplate, "html" | "fields" | "name">, values: Record<string, string>): string {
  const unknown = Object.keys(values).filter(k => !template.fields.includes(k));
  const missing = template.fields.filter(f => values[f] === undefined);
  if (unknown.length || missing.length) {
    throw badRequest("template_fields", `$${template.name} has the fields ${template.fields.map(f => quote(f)).join(", ")}.` +
      (missing.length ? ` Give a value for ${missing.map(f => quote(f)).join(", ")} (an empty one leaves it blank).` : "") +
      (unknown.length ? ` It has no ${unknown.map(f => quote(f)).join(", ")}.` : ""));
  }
  return template.html.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (all, field: string) => values[field] !== undefined ? escapeHtml(values[field]!) : all);
}

export function templateSummary(t: GraphicTemplate): GraphicTemplateSummary {
  const { html: _h, sample: _s, width: _w, height: _ht, duration: _d, previewAt: _p, ...summary } = t;
  return summary;
}

/** A template by id, or by the name the editor types after $. */
export function findTemplate(ctx: Ctx, idOrName: string): GraphicTemplate | null {
  const name = idOrName.replace(/^\$/, "");
  return ctx.repos.templates.get(idOrName) ?? ctx.repos.templates.select("name = ?", [name])[0] ?? null;
}

export function templatePreviewPath(ctx: Ctx, t: GraphicTemplate) {
  return join(ctx.paths.template(t.id), `preview-${t.previewVersion}.png`);
}

/** Preview images are this wide; their height follows the template's frame. */
export const TEMPLATE_PREVIEW_WIDTH = 640;

/**
 * Save a template, or replace the one with the same name. Its page and the files it links to go in its library folder,
 * and its preview is drawn with the sample values.
 */
export async function saveTemplate(ctx: Ctx, body: SaveTemplateRequest, user: User | null, signal?: AbortSignal): Promise<{ template: GraphicTemplate; missingFonts: MissingFont[]; problems: string[]; preview?: string }> {
  if (body.transition) {
    if (body.html !== undefined) throw badRequest("page_or_transition", "A template is a graphic's page or a transition, not both.");
    return { template: await saveTransitionTemplate(ctx, { ...body, transition: body.transition }, user), missingFonts: [], problems: [] };
  }
  if (body.html === undefined) throw badRequest("missing_page", "Send the graphic's page as html, or a transition.");
  const fields = [...new Set(body.fields)];
  const found = placeholders(body.html);
  const unused = fields.filter(f => !found.includes(f));
  const undeclared = found.filter(f => !fields.includes(f));
  if (unused.length || undeclared.length) {
    throw badRequest("template_fields", [unused.length && `The page has no {{${unused[0]}}} placeholder for ${unused.map(f => quote(f)).join(", ")}.`,
      undeclared.length && `The page has placeholders that aren't fields: ${undeclared.map(f => `{{${f}}}`).join(", ")}.`].filter(Boolean).join(" "));
  }
  const missingSample = fields.filter(f => body.sample[f] === undefined);
  if (missingSample.length) throw badRequest("template_sample", `Give a sample value for ${missingSample.map(f => quote(f)).join(", ")}: the preview is drawn with them.`);
  const existing = ctx.repos.templates.select("name = ?", [body.name])[0];
  const project = body.projectId ? ctx.repos.projects.get(body.projectId) : null;
  if (body.projectId && !project) throw notFound(`project ${body.projectId}`);
  const based = body.basedOn ? graphicMedia(ctx, body.projectId ?? "", body.basedOn) : undefined;
  const id = existing?.id ?? newId("tpl");
  const folder = ctx.paths.template(id);
  const staging = `${folder}.${randomUUID()}`;
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    if (based) await copyFiles(dirname(based.page), staging);
    else if (existing) await copyFiles(folder, staging);
    const roots = [ctx.paths.templates, ...(project ? [ctx.paths.project(project.id)] : [])];
    const html = await adoptLinkedFiles(body.html, staging, roots);
    const width = body.width ?? project?.settings.width ?? 1920, height = body.height ?? project?.settings.height ?? 1080;
    const duration = body.duration ?? 5, previewAt = Math.min(body.previewAt ?? duration / 2, duration);
    await writeFile(join(staging, "template.html"), html);
    // The preview is drawn from a filled copy beside the template's files.
    const filled = join(staging, ".preview.html");
    await writeFile(filled, fillTemplate({ html, fields, name: body.name }, body.sample));
    const previewVersion = randomUUID().slice(0, 8);
    const still = await renderGraphicStill({ htmlFile: filled, width, height, time: previewAt, outputWidth: TEMPLATE_PREVIEW_WIDTH, chromePath: chrome(ctx), signal });
    await rm(filled, { force: true });
    await writeFile(join(staging, `preview-${previewVersion}.png`), still.png);
    const stamp = now();
    const template = GraphicTemplate.parse({
      id, name: body.name, title: body.title, description: body.description, fields, previewVersion,
      createdAt: existing?.createdAt ?? stamp, updatedAt: stamp, html, sample: body.sample, width, height, duration, previewAt,
    });
    await swapInFolder(staging, folder);
    ctx.repos.templates.put(template);
    logActivity(ctx, { projectId: body.projectId ?? null, actor: actorFor(user), type: "template.saved",
      summary: `${existing ? "Replaced" : "Saved"} the graphic template $${template.name}`, data: { templateId: template.id } });
    return { template, missingFonts: still.missingFonts, problems: still.problems, preview: still.png.toString("base64") };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

type TransitionTemplateRequest = SaveTemplateRequest & { transition: TransitionStyle };

/** A transition template has no page: what it is, is how the picture moves. */
async function saveTransitionTemplate(ctx: Ctx, body: TransitionTemplateRequest, user: User | null): Promise<GraphicTemplate> {
  if (body.fields.length) throw badRequest("template_fields", "A transition has no fields.");
  const existing = ctx.repos.templates.select("name = ?", [body.name])[0];
  // A graphic of the same name kept its page in the library folder; the transition that replaces it has none.
  if (existing) await rm(ctx.paths.template(existing.id), { recursive: true, force: true });
  const template = putTransitionTemplate(ctx, body, existing);
  logActivity(ctx, { projectId: body.projectId ?? null, actor: actorFor(user), type: "template.saved",
    summary: `${existing ? "Replaced" : "Saved"} the transition template $${template.name}`, data: { templateId: template.id } });
  return template;
}

function putTransitionTemplate(ctx: Ctx, body: TransitionTemplateRequest, existing?: GraphicTemplate) {
  const stamp = now();
  const template = GraphicTemplate.parse({
    id: existing?.id ?? newId("tpl"), kind: "transition", transition: body.transition, name: body.name, title: body.title, description: body.description,
    fields: [], previewVersion: randomUUID().slice(0, 8), createdAt: existing?.createdAt ?? stamp, updatedAt: stamp,
    html: "", sample: {}, width: 1920, height: 1080, duration: body.transition.duration, previewAt: 0,
  });
  ctx.repos.templates.put(template);
  return template;
}

/** Transitions every library starts with. One the editor deletes stays deleted. */
export const STOCK_TRANSITIONS: TransitionTemplateRequest[] = ([
  { name: "swipe", title: "Swipe", description: "The next picture pushes the last one off to the left.", transition: { type: "push", duration: 0.4, direction: "left" } },
  { name: "whip-pan", title: "Whip pan", description: "A fast push with a sideways blur, like a whip of the camera.", transition: { type: "whip", duration: 0.3, direction: "left" } },
  { name: "slide", title: "Slide", description: "The next picture slides in from the right over the last one.", transition: { type: "slide", duration: 0.4, direction: "left" } },
  { name: "dissolve", title: "Dissolve", description: "One picture fades into the next.", transition: { type: "dissolve", duration: 0.5, direction: "left" } },
  { name: "dip-to-black", title: "Dip to black", description: "Fades down to black and up into the next picture.", transition: { type: "dip", duration: 0.6, direction: "left", color: "#000000" } },
] satisfies Omit<TransitionTemplateRequest, "fields" | "sample">[]).map(t => ({ ...t, fields: [], sample: {} }));

export function seedStockTransitions(ctx: Ctx): number {
  let seeded = 0;
  for (const stock of STOCK_TRANSITIONS) {
    if (ctx.repos.templates.select("name = ?", [stock.name])[0]) continue;
    const deleted = ctx.db.prepare("SELECT 1 FROM activity WHERE type = 'template.deleted' AND json_extract(json, '$.data.name') = ? LIMIT 1").get(stock.name);
    if (deleted) continue;
    putTransitionTemplate(ctx, stock);
    seeded++;
  }
  return seeded;
}

export async function deleteTemplate(ctx: Ctx, template: GraphicTemplate, user: User | null) {
  ctx.repos.templates.remove(template.id);
  await rm(ctx.paths.template(template.id), { recursive: true, force: true });
  // The name stays in the record, so a transition Scarlet comes with isn't brought back once the editor deletes it.
  logActivity(ctx, { projectId: null, actor: actorFor(user), type: "template.deleted", summary: `Deleted the ${template.kind === "transition" ? "transition" : "graphic"} template $${template.name}`,
    data: { templateId: template.id, name: template.name } });
}

// ---------------------------------------------------------------------------
// Rendering a graphic
// ---------------------------------------------------------------------------

const chrome = (ctx: Ctx) => findChrome(undefined, ctx.options.env ?? process.env);

/** A graphic Scarlet drew in this project, and its page. */
export function graphicMedia(ctx: Ctx, projectId: string, mediaId: string): { media: MediaAsset; page: string } {
  const media = ctx.repos.projects.getMedia(mediaId);
  if (!media || media.projectId !== projectId) throw notFound(`media ${mediaId}`);
  if (!media.graphic) throw badRequest("not_a_drawn_graphic", `${quote(media.name)} wasn't drawn by Scarlet from a page, so it has none to revise.`);
  const page = resolve(ctx.paths.project(projectId), media.graphic.source);
  if (!inside(ctx.paths.project(projectId), page)) throw notFound("graphic page");
  return { media, page };
}

/** Moments spread through a graphic to check: as it comes in, held, and as it goes. */
export function defaultCheckTimes(duration: number, fps: number) {
  return [0.15, 0.5, 0.85].map(f => Math.round(duration * f * fps) / fps);
}

export interface GraphicInput {
  options: GraphicRenderRequest;
  html?: string;
  assets: Map<string, Buffer>;
}

/**
 * Draw a graphic and add it to the project's media as a graphic with alpha. A graphic whose page asks for a font that
 * isn't there is drawn for the checks and not added: the editor decides between adding the font and a fallback.
 */
export async function renderProjectGraphic(ctx: Ctx, project: Project, input: GraphicInput, user: User | null, checkAttempt: () => void, signal: AbortSignal): Promise<GraphicRenderResponse> {
  const o = input.options;
  const based = o.basedOn ? graphicMedia(ctx, project.id, o.basedOn) : undefined;
  const templateRef = o.template ?? (input.html === undefined ? based?.media.graphic?.templateId : undefined);
  const template = templateRef ? findTemplate(ctx, templateRef) : null;
  if (templateRef && !template) throw notFound(`template ${templateRef}`);
  if (template?.kind === "transition") throw badRequest("transition_template", `$${template.name} is a transition: put it on a join with timeline_transition.`);
  if (input.html !== undefined && o.template) throw badRequest("page_or_template", "Send a page or name a template, not both.");
  if (input.html === undefined && !template) throw badRequest("missing_page", "Send the graphic's page as html, or name a template to fill.");
  const fields = template ? (o.fields ?? (based?.media.graphic?.templateId === template.id ? based.media.graphic.fields : undefined) ?? {}) : undefined;

  const fps = o.fps ?? project.settings.fps;
  const width = o.width ?? project.settings.width, height = o.height ?? project.settings.height;
  const duration = o.duration ?? template?.duration ?? based?.media.duration;
  if (!duration) throw badRequest("missing_duration", "Say how many seconds the graphic lasts.");

  ctx.paths.ensureProject(project.id);
  const sourceId = newId("gfx");
  const folder = join(ctx.paths.graphics(project.id), sourceId);
  const work = join(ctx.paths.tmp, `graphic-${randomUUID()}`);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await mkdir(work, { recursive: true, mode: 0o700 });
  let kept = false;
  try {
    if (based) await copyFiles(dirname(based.page), folder);
    if (template) await copyFiles(ctx.paths.template(template.id), folder);
    await writeAssets(folder, input.assets);
    const roots = [ctx.paths.project(project.id), ctx.paths.templates];
    const html = await adoptLinkedFiles(template ? fillTemplate(template, fields!) : input.html!, folder, roots);
    const page = join(folder, "index.html");
    await writeFile(page, html);

    const movie = join(work, "graphic.mov");
    const drawn = await renderGraphic({ htmlFile: page, width, height, fps, duration, output: movie, chromePath: chrome(ctx), signal });
    const checkTimes = (o.checkTimes?.length ? o.checkTimes : defaultCheckTimes(duration, fps)).map(t => Math.min(t, Math.max(0, duration - 1 / fps)));
    const coverage = await graphicCoverage(movie, checkTimes, { width, height }, { signal });
    let checkAt: number | undefined;
    let pictures: Array<Buffer | undefined> = [];
    if (o.pictures) {
      const timeline = project.head ? resolveTimeline(ctx, project, "head") : null;
      checkAt = timeline && o.checkAt !== undefined ? o.checkAt : undefined;
      const size = { width: 960, height: Math.round(960 * height / width) };
      pictures = await Promise.all(checkTimes.map(async t => {
        let background: Buffer | null = null;
        if (timeline && checkAt !== undefined) {
          const at = checkAt + t;
          const range = { start: at, end: at + 1 / project.settings.fps };
          const root = ctx.paths.media(project.id);
          background = await renderTimelineFrame(project, timeline, range, root, signal, 960, { pictureSource: previewPictures(root, { signal }) })
            .catch(() => renderTimelineFrame(project, timeline, range, root, signal, 960)).catch(() => null);
        }
        return graphicOver(movie, t, background, size, { signal }).catch(() => undefined);
      }));
    }
    const checks = coverage.map((c, i) => ({ ...c, ...(pictures[i] && { jpeg: pictures[i]!.toString("base64") }) }));
    const base = { missingFonts: drawn.missingFonts, ...(drawn.installedFonts.length && { installedFonts: drawn.installedFonts }), problems: drawn.problems, checks, ...(checkAt !== undefined && { checkAt }),
      width, height, fps, duration, renderMs: drawn.elapsedMs };
    if (drawn.missingFonts.length) return base;

    const source = relative(ctx.paths.project(project.id), page).split(sep).join("/");
    const name = o.name ?? (template ? `${template.title}${fields && Object.values(fields).find(Boolean) ? ` – ${Object.values(fields).find(Boolean)}` : ""}` : "Graphic");
    const hash = await ctx.render.hashFile(movie, undefined, signal);
    const media = await ingestMedia(ctx, project, { type: "upload", path: movie, hash }, {
      name: `${name}.mov`.replace(/\.mov\.mov$/, ".mov"), kind: "graphic", checkAttempt,
      transcription: { provider: undefined, revision: 0, signal },
      by: { by: "agent", name: o.provenance?.name ?? user?.name, model: o.provenance?.model, prompt: o.provenance?.prompt, createdAt: now() },
      uploadedBy: user?.id,
    });
    const graphic = { source, ...(template && { templateId: template.id, fields }) };
    const saved = ctx.db.transaction(() => {
      const current = ctx.repos.projects.getMedia(media.id);
      if (!current) throw conflict("graphic_removed", "The graphic was removed while it was being added.");
      const { projectId: _p, status, error, ...asset } = current;
      const stored = ctx.repos.projects.putMedia(project.id, { ...asset, graphic }, status, error);
      ctx.bus.publish({ type: "media.updated", projectId: project.id, media: stored });
      return stored;
    }, "immediate")();
    kept = true;
    return { ...base, media: await ready(ctx, saved.id) ?? saved, source: page };
  } finally {
    if (!kept) await rm(folder, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
}

/** The media once its import has finished, which for a graphic takes a moment. */
async function ready(ctx: Ctx, mediaId: string) {
  for (let i = 0; i < 100; i++) {
    const media = ctx.repos.projects.getMedia(mediaId);
    if (!media || media.status !== "ingesting") return media ?? undefined;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return ctx.repos.projects.getMedia(mediaId) ?? undefined;
}

/** A graphic's page, to read or revise. */
export async function graphicSource(ctx: Ctx, projectId: string, mediaId: string) {
  const { media, page } = graphicMedia(ctx, projectId, mediaId);
  const html = await readFile(page, "utf8").catch(() => { throw notFound("graphic page"); });
  const template = media.graphic?.templateId ? ctx.repos.templates.get(media.graphic.templateId) : null;
  const files = (await listFiles(dirname(page))).filter(f => f !== "index.html");
  return {
    mediaId, name: media.name, html, source: page, files, duration: media.duration, width: media.width, height: media.height, fps: media.fps,
    ...(template && { template: { id: template.id, name: template.name, title: template.title } }),
    ...(media.graphic?.fields && { fields: media.graphic.fields }),
  };
}

async function listFiles(folder: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory()) out.push(...await listFiles(join(folder, e.name), `${prefix}${e.name}/`));
    else out.push(prefix + e.name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading an attachment or the style guide
// ---------------------------------------------------------------------------

const TEXT_TYPES = /^text\/|json|svg/;
const IMAGE_TYPES = /^image\/(png|jpeg|webp|gif)$/;
/** Pages drawn in one read. */
export const MAX_DOCUMENT_PAGES = 8;

export interface DocumentRead {
  name: string;
  /** Where it is on disk, for a harness that reads files. */
  path: string;
  size: number;
  mime?: string;
  text?: string;
  /** For a PDF: how many pages it has, when that can be read, and pictures of the pages asked for. */
  pageCount?: number;
  pages?: Array<{ page: number; jpeg: string }>;
  image?: { mime: string; data: string };
}

/** An attachment, or the project's style guide, as something a model can read: its text, its pages or its picture. */
export async function readDocument(ctx: Ctx, projectId: string, ref: { attachmentId?: string; styleGuide?: boolean; pages?: number[] }, signal?: AbortSignal): Promise<DocumentRead> {
  let path: string, name: string;
  if (ref.styleGuide) {
    const guide = ctx.repos.projects.header(projectId)?.styleGuide;
    if (!guide) throw notFound("style guide");
    const file = styleGuidePath(ctx, projectId, guide);
    if (!file) return { name: guide.name, path: "", size: guide.text?.length ?? 0, mime: "text/plain", text: guide.text ?? "" };
    path = file; name = basename(file);
  } else {
    const found = ref.attachmentId ? await findAttachment(ctx, projectId, ref.attachmentId) : null;
    if (!found) throw notFound("attachment");
    path = found.path; name = found.attachment.name;
  }
  const info = await stat(path);
  const mime = mimeFor(name);
  const base: DocumentRead = { name, path, size: info.size, ...(mime && { mime }) };
  if (mime && TEXT_TYPES.test(mime)) return { ...base, text: (await readFile(path, "utf8")).slice(0, 200_000) };
  if (mime && IMAGE_TYPES.test(mime)) {
    if (info.size <= 4 * 1024 * 1024) return { ...base, image: { mime, data: (await readFile(path)).toString("base64") } };
    const jpeg = await ctx.render.extractFrame(path, 0, { width: 1600, signal });
    return { ...base, image: { mime: "image/jpeg", data: jpeg.toString("base64") } };
  }
  if (mime === "application/pdf") {
    const wanted = ref.pages?.length ? ref.pages.filter(n => Number.isInteger(n) && n >= 1).slice(0, MAX_DOCUMENT_PAGES) : [1, 2, 3, 4, 5, 6];
    const { pageCount, pages } = await renderPdfDocument(path, wanted, { signal });
    return { ...base, pageCount, pages: pages.map(({ page, jpeg }) => ({ page, jpeg: jpeg.toString("base64") })) };
  }
  return base;
}
