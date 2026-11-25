/**
 * Reusable visual style guides: library-wide design direction, fonts/logos/assets, and rendered 16:9 previews
 * referenced automatically (as the Default style) or explicitly via @name in chat and skills.
 */
import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ChromeNotFound, findChrome, renderGraphicStill } from "@scarlet/render";
import {
  StyleGuideRecord,
  isHandOff,
  styleGuideMentions,
  type CreateStyleGuideRequest,
  type Skill,
  type StyleGuideAsset,
  type StyleGuideFromGraphicRequest,
  type StyleGuidePreviewRenderRequest,
  type StyleGuidePreviewRenderResponse,
  type Task,
  type UpdateStyleGuideRequest,
  type User,
} from "@scarlet/shared";
import { newId, type Author } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { conflict, HttpError, notFound } from "../errors.js";
import { actorFor, authorName, logActivity, quote } from "./activity.js";
import {
  adoptLinkedFiles,
  attachmentName,
  graphicMedia,
  MAX_ATTACHMENT_BYTES,
  mimeFor,
  readFileDocument,
  swapInFolder,
  type DocumentRead,
} from "./graphics.js";

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
const PREVIEW_WIDTH = 1920;
const PREVIEW_HEIGHT = 1080;
const PREVIEW_OUTPUT_WIDTH = 1280;

const chrome = (ctx: Ctx) => findChrome(undefined, ctx.options.env ?? process.env);

export function listStyleGuides(ctx: Ctx): StyleGuideRecord[] {
  return ctx.repos.styleGuides.select("1=1", [], "is_default DESC, name COLLATE NOCASE ASC");
}

export function findDuplicateStyleGuide(ctx: Ctx, name: string, excludeId?: string): StyleGuideRecord | undefined {
  return ctx.repos.styleGuides
    .select("LOWER(name) = LOWER(?)", [name])
    .find(guide => guide.id !== excludeId);
}

/** Clear `isDefault` on any other style guide so only one default exists at a time. */
function clearOtherDefaults(ctx: Ctx, keepId?: string) {
  const others = ctx.repos.styleGuides.select("is_default = 1", []);
  for (const other of others) {
    if (other.id === keepId) continue;
    const saved = ctx.repos.styleGuides.put({ ...other, isDefault: false, updatedAt: now() });
    ctx.bus.publish({ type: "style_guide.updated", styleGuide: saved });
  }
}

export function createStyleGuide(
  ctx: Ctx,
  user: User | null,
  body: CreateStyleGuideRequest,
  extra: { source?: string; assets?: StyleGuideAsset[] } = {},
): StyleGuideRecord {
  const dup = findDuplicateStyleGuide(ctx, body.name);
  if (dup) throw conflict("style_guide_exists", `A style guide named "@${body.name}" already exists.`, { styleGuideId: dup.id });
  const ts = now();
  const isDefault = Boolean(body.isDefault);
  if (isDefault) clearOtherDefaults(ctx);
  const guide = StyleGuideRecord.parse({
    id: newId("sg"),
    name: body.name,
    description: body.description?.trim() ?? "",
    instructions: body.instructions ?? "",
    isDefault,
    assets: extra.assets ?? [],
    source: extra.source,
    createdAt: ts,
    updatedAt: ts,
  });
  const saved = ctx.repos.styleGuides.put(guide);
  ctx.bus.publish({ type: "style_guide.updated", styleGuide: saved });
  if (user) {
    logActivity(ctx, {
      projectId: null,
      actor: actorFor(user),
      type: "style_guide.created",
      summary: `${user.name} created the style guide ${quote("@" + saved.name)}`,
      data: { styleGuideId: saved.id },
    });
  }
  return saved;
}

export function updateStyleGuide(
  ctx: Ctx,
  user: User | null,
  existing: StyleGuideRecord,
  body: UpdateStyleGuideRequest & { assets?: StyleGuideAsset[]; preview?: StyleGuideRecord["preview"] },
  extra: { author?: Author } = {},
): StyleGuideRecord {
  const nextName = body.name ?? existing.name;
  const dup = findDuplicateStyleGuide(ctx, nextName, existing.id);
  if (dup) throw conflict("style_guide_exists", `A style guide named "@${nextName}" already exists.`, { styleGuideId: dup.id });
  const nextDefault = body.isDefault ?? existing.isDefault;
  if (nextDefault && !existing.isDefault) clearOtherDefaults(ctx, existing.id);
  const next = StyleGuideRecord.parse({
    ...existing,
    name: nextName,
    description: body.description !== undefined ? body.description.trim() : existing.description,
    instructions: body.instructions !== undefined ? body.instructions : existing.instructions,
    isDefault: nextDefault,
    assets: body.assets !== undefined ? body.assets : existing.assets,
    preview: body.preview !== undefined ? body.preview : existing.preview,
    updatedAt: now(),
  });
  const saved = ctx.repos.styleGuides.put(next);
  ctx.bus.publish({ type: "style_guide.updated", styleGuide: saved });
  if (user) {
    logActivity(ctx, {
      projectId: null,
      actor: extra.author ?? actorFor(user),
      type: "style_guide.updated",
      summary: extra.author
        ? `${authorName(extra.author)} updated the style guide ${quote("@" + saved.name)} as ${user.name} asked`
        : `${user.name} updated the style guide ${quote("@" + saved.name)}`,
      data: { styleGuideId: saved.id },
    });
  }
  return saved;
}

export function deleteStyleGuide(ctx: Ctx, guide: StyleGuideRecord, user?: User | null) {
  if (user) {
    logActivity(ctx, {
      projectId: null,
      actor: actorFor(user),
      type: "style_guide.deleted",
      summary: `${user.name} deleted the style guide ${quote("@" + guide.name)}`,
      data: { styleGuideId: guide.id },
    });
  }
  ctx.repos.styleGuides.remove(guide.id);
  ctx.bus.publish({ type: "style_guide.deleted", styleGuideId: guide.id });
  const folder = ctx.paths.styleGuideDir(guide.id);
  ctx.db.afterCommit(() => {
    void rm(folder, { recursive: true, force: true }).catch(() => undefined);
  });
}

// ---------------------------------------------------------------------------
// Assets (fonts, logos, screenshots, brand docs attached in chat or saved from a graphic)
// ---------------------------------------------------------------------------

export async function saveStyleGuideAsset(
  ctx: Ctx,
  guideId: string,
  name: string,
  data: AsyncIterable<Uint8Array>,
  mime?: string,
  signal?: AbortSignal,
): Promise<{ asset: StyleGuideAsset; styleGuide: StyleGuideRecord }> {
  const existing = ctx.repos.styleGuides.get(guideId);
  if (!existing) throw notFound(`style guide ${guideId}`);
  const id = newId("sga");
  const folder = join(ctx.paths.styleGuideAssets(guideId), id);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const file = join(folder, attachmentName(name));
  let size = 0;
  try {
    async function* counted() {
      for await (const chunk of data) {
        size += chunk.byteLength;
        if (size > MAX_ATTACHMENT_BYTES) {
          throw new HttpError(413, "attachment_too_large", `A file can be up to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
        }
        yield chunk;
      }
    }
    await writeFile(file, counted(), { flag: "wx", mode: 0o600, signal });
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
  const detected = mime && mime !== "application/octet-stream" ? mime.slice(0, 200) : mimeFor(basename(file));
  const asset: StyleGuideAsset = {
    id,
    name: basename(file),
    size,
    ...(detected && { mime: detected }),
    createdAt: now(),
  };
  const saved = ctx.db.transaction(() => {
    const current = ctx.repos.styleGuides.get(guideId);
    if (!current) throw notFound(`style guide ${guideId}`);
    return updateStyleGuide(ctx, null, current, { assets: [...current.assets, asset] });
  }, "immediate")();
  return { asset, styleGuide: saved };
}

export async function findStyleGuideAsset(
  ctx: Ctx,
  guideId: string,
  assetId: string,
): Promise<{ asset: StyleGuideAsset; path: string } | null> {
  if (!SAFE_ID.test(guideId) || !SAFE_ID.test(assetId)) return null;
  const folder = join(ctx.paths.styleGuideAssets(guideId), assetId);
  const names = await readdir(folder).catch(() => [] as string[]);
  const name = names.find(n => !n.startsWith("."));
  if (!name) return null;
  const path = join(folder, name);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return null;
  const mime = mimeFor(name);
  return { asset: { id: assetId, name, size: info.size, ...(mime && { mime }) }, path };
}

/** Disk paths for every asset on a style guide. */
export function styleGuideAssetPaths(ctx: Ctx, guide: StyleGuideRecord): Array<StyleGuideAsset & { path: string }> {
  return guide.assets.map(asset => ({
    ...asset,
    mime: asset.mime ?? mimeFor(asset.name),
    path: join(ctx.paths.styleGuideAssets(guide.id), asset.id, asset.name),
  }));
}

export async function readStyleGuideAssetDocument(
  ctx: Ctx,
  guideId: string,
  assetId: string,
  pages?: number[],
  signal?: AbortSignal,
): Promise<DocumentRead> {
  const found = await findStyleGuideAsset(ctx, guideId, assetId);
  if (!found) throw notFound("style guide asset");
  return readFileDocument(ctx, found.path, found.asset.name, pages, signal);
}

// ---------------------------------------------------------------------------
// Visual preview rendering (16:9 PNG style sheet)
// ---------------------------------------------------------------------------

export function styleGuidePreviewImagePath(ctx: Ctx, guideId: string): string {
  return join(ctx.paths.styleGuidePreview(guideId), "preview.png");
}

export async function renderStyleGuidePreview(
  ctx: Ctx,
  guideId: string,
  body: StyleGuidePreviewRenderRequest,
  signal?: AbortSignal,
): Promise<StyleGuidePreviewRenderResponse> {
  const existing = ctx.repos.styleGuides.get(guideId);
  if (!existing) throw notFound(`style guide ${guideId}`);

  const width = body.width ?? PREVIEW_WIDTH;
  const height = body.height ?? PREVIEW_HEIGHT;
  const at = body.at ?? 0.5;
  const previewDir = ctx.paths.styleGuidePreview(guideId);
  const staging = `${previewDir}.${randomUUID()}`;
  await mkdir(staging, { recursive: true, mode: 0o700 });

  let swapped = false;
  try {
    // Carry forward any previously linked files in case the updated HTML references relative `linked/...` paths.
    const prevLinked = join(previewDir, "linked");
    if ((await stat(prevLinked).catch(() => null))?.isDirectory()) {
      await cp(prevLinked, join(staging, "linked"), { recursive: true });
    }
    const html = await adoptLinkedFiles(body.html, staging, [ctx.paths.styleGuidesLibrary]);
    const page = join(staging, "index.html");
    await writeFile(page, html, "utf8");

    const drawn = await renderGraphicStill({
      htmlFile: page,
      width,
      height,
      time: at,
      outputWidth: Math.min(width, PREVIEW_OUTPUT_WIDTH),
      chromePath: chrome(ctx),
      signal,
    });
    if (drawn.missingFonts.length) {
      return {
        missingFonts: drawn.missingFonts,
        ...(drawn.installedFonts.length && { installedFonts: drawn.installedFonts }),
        problems: drawn.problems,
        width,
        height,
      };
    }

    const pngPath = join(staging, "preview.png");
    await writeFile(pngPath, drawn.png, { mode: 0o600 });
    const jpeg = await ctx.render
      .extractFrame(pngPath, 0, { width: 960, signal })
      .then(buf => buf.toString("base64"))
      .catch(() => undefined);

    await mkdir(dirname(previewDir), { recursive: true, mode: 0o700 });
    await swapInFolder(staging, previewDir);
    swapped = true;

    const updatedAt = now();
    const saved = ctx.db.transaction(() => {
      const current = ctx.repos.styleGuides.get(guideId);
      if (!current) throw notFound(`style guide ${guideId}`);
      return updateStyleGuide(ctx, null, current, { preview: { updatedAt, width, height } });
    }, "immediate")();

    return {
      styleGuide: saved,
      missingFonts: [],
      problems: drawn.problems,
      width,
      height,
      ...(jpeg && { jpeg }),
    };
  } finally {
    if (!swapped) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function styleGuidePreviewSource(ctx: Ctx, guideId: string, signal?: AbortSignal) {
  const guide = ctx.repos.styleGuides.get(guideId);
  if (!guide) throw notFound(`style guide ${guideId}`);
  const previewDir = ctx.paths.styleGuidePreview(guideId);
  const page = join(previewDir, "index.html");
  const html = await readFile(page, "utf8").catch(() => {
    throw notFound("style guide preview");
  });
  const pngPath = styleGuidePreviewImagePath(ctx, guideId);
  const jpeg = await ctx.render
    .extractFrame(pngPath, 0, { width: 960, signal })
    .then(buf => buf.toString("base64"))
    .catch(() => undefined);
  return {
    html,
    width: guide.preview?.width ?? PREVIEW_WIDTH,
    height: guide.preview?.height ?? PREVIEW_HEIGHT,
    updatedAt: guide.preview?.updatedAt ?? guide.updatedAt ?? now(),
    ...(jpeg && { jpeg }),
  };
}

// ---------------------------------------------------------------------------
// 1-click "Save as style" from a rendered project graphic
// ---------------------------------------------------------------------------

async function collectFiles(folder: string, prefix = ""): Promise<Array<{ rel: string; full: string }>> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const out: Array<{ rel: string; full: string }> = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "index.html" || entry.name === "template.html" || entry.name.startsWith("preview-")) continue;
    const full = join(folder, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await collectFiles(full, rel));
    else if (entry.isFile()) out.push({ rel, full });
  }
  return out;
}

/**
 * Replace whole relative links with their new paths in one pass. A target only matches between URL
 * delimiters (quotes, parentheses, `=`, whitespace, `?`, `#`), longest first, so `bg.png` never
 * matches inside `hero-bg.png` and a path already put in is never scanned again.
 */
function rewriteLinks(html: string, targets: Map<string, string>): string {
  if (!targets.size) return html;
  const pattern = [...targets.keys()]
    .sort((a, b) => b.length - a.length)
    .map(target => target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return html.replace(new RegExp(`(?<=^|["'\`(=,\\s])(?:${pattern})(?=$|["'\`)?>#,\\s])`, "g"), match => targets.get(match) ?? match);
}

/** Strip the 8-hex-char dedupe prefix added by `adoptLinkedFiles` so saved asset names stay clean. */
function cleanLinkedName(rel: string): string {
  const base = basename(rel);
  return rel.startsWith("linked/") ? base.replace(/^[0-9a-f]{8}-/i, "") || base : base;
}

/** Build structured initial instructions from a saved graphic's HTML/CSS and assets. */
function summarizeGraphicStyle(name: string, html: string, assets: StyleGuideAsset[]): string {
  const colors = [...new Set(html.match(/#(?:[0-9a-f]{3,8})\b|rgba?\([^)]+\)/gi) ?? [])].slice(0, 12);
  const fonts = [...new Set(
    Array.from(html.matchAll(/font-family\s*:\s*([^;}"'\n]+)/gi), m => m[1]!.trim()),
  )].slice(0, 6);
  const lines = [
    `Saved from the project graphic "${name}". Match its visual language across lower thirds, chapter titles, callouts, and overlays.`,
  ];
  if (fonts.length) lines.push("", "## Typography", ...fonts.map(f => `- ${f}`));
  if (colors.length) lines.push("", "## Palette", `- ${colors.join(", ")}`);
  if (assets.length) lines.push("", "## Attached assets", ...assets.map(a => `- ${a.name} (${a.mime ?? "file"})`));
  const trimmed = html.length > 24_000 ? `${html.slice(0, 24_000)}\n<!-- truncated -->` : html;
  lines.push("", "## Reference HTML", "```html", trimmed.trim(), "```");
  return lines.join("\n");
}

export async function createStyleGuideFromGraphic(
  ctx: Ctx,
  user: User | null,
  body: StyleGuideFromGraphicRequest,
  signal?: AbortSignal,
): Promise<StyleGuideRecord> {
  const { media, page } = graphicMedia(ctx, body.projectId, body.mediaId);
  const rawHtml = await readFile(page, "utf8").catch(() => {
    throw notFound("graphic page");
  });
  const dup = findDuplicateStyleGuide(ctx, body.name);
  if (dup) throw conflict("style_guide_exists", `A style guide named "@${body.name}" already exists.`, { styleGuideId: dup.id });

  const cleanTitle = media.name.replace(/\.mov$/i, "");
  const description = body.description?.trim() || `Saved from ${cleanTitle}`;

  // Create the guide first so its directory ID is reserved, then copy assets and render the preview.
  const created = ctx.db.transaction(
    () => createStyleGuide(ctx, user, { name: body.name, description, instructions: "", isDefault: body.isDefault }, { source: `graphic:${media.id}` }),
    "immediate",
  )();

  try {
    const folder = dirname(page);
    const files = await collectFiles(folder);
    const copiedAssets: StyleGuideAsset[] = [];
    const linkTargets = new Map<string, string>();

    for (const file of files) {
      const assetId = newId("sga");
      const assetFolder = join(ctx.paths.styleGuideAssets(created.id), assetId);
      const safeName = attachmentName(cleanLinkedName(file.rel));
      const dest = join(assetFolder, safeName);
      await mkdir(assetFolder, { recursive: true, mode: 0o700 });
      await cp(file.full, dest);
      const info = await stat(dest);
      const mime = mimeFor(safeName);
      copiedAssets.push({ id: assetId, name: safeName, size: info.size, ...(mime && { mime }), createdAt: now() });

      // Rewrite relative links (encoded or raw) to absolute paths inside the style guide's asset folder
      // so both `renderStyleGuidePreview` and future project graphics can adopt them cleanly.
      const encodedRel = file.rel.split("/").map(encodeURIComponent).join("/");
      for (const target of [file.rel, `./${file.rel}`, encodedRel, `./${encodedRel}`]) {
        if (!linkTargets.has(target)) linkTargets.set(target, dest);
      }
    }
    const rewrittenHtml = rewriteLinks(rawHtml, linkTargets);

    const instructions = summarizeGraphicStyle(cleanTitle, rewrittenHtml, copiedAssets);
    const updated = ctx.db.transaction(() => {
      const current = ctx.repos.styleGuides.get(created.id);
      if (!current) throw notFound(`style guide ${created.id}`);
      return updateStyleGuide(ctx, null, current, { assets: copiedAssets, instructions });
    }, "immediate")();

    // Render the initial 16:9 preview from the graphic's held middle moment so the card has a live preview immediately.
    const width = media.width && media.width > 0 ? media.width : PREVIEW_WIDTH;
    const height = media.height && media.height > 0 ? media.height : PREVIEW_HEIGHT;
    const at = media.duration ? Math.min(media.duration * 0.5, 1.5) : 0.5;
    try {
      const rendered = await renderStyleGuidePreview(ctx, updated.id, { html: rewrittenHtml, width, height, at }, signal);
      if (rendered.styleGuide) return rendered.styleGuide;
    } catch (error) {
      // If Chrome isn't installed in a headless environment, keep the saved style guide + assets without failing the save.
      if (!(error instanceof ChromeNotFound)) {
        ctx.log(`[style-guides] initial preview render skipped for ${updated.id}: ${(error as Error).message}`);
      }
    }
    return ctx.repos.styleGuides.get(updated.id) ?? updated;
  } catch (error) {
    ctx.db.transaction(() => {
      const current = ctx.repos.styleGuides.get(created.id);
      if (current) deleteStyleGuide(ctx, current, null);
    }, "immediate")();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Editing history & prompt resolution
// ---------------------------------------------------------------------------

/** The latest request to revise this style guide with a prompt, whatever state it is in. */
export function latestStyleGuideEdit(ctx: Ctx, styleGuideId: string) {
  return ctx.repos.tasks.select(
    "kind = 'style_guide_edit' AND json_extract(json, '$.context.styleGuideId') = ?",
    [styleGuideId],
    "created_at DESC, rowid DESC LIMIT 1",
  )[0];
}

/** Every request to design or revise this style guide in chat, oldest first. */
export function styleGuideEdits(ctx: Ctx, styleGuideId: string) {
  return ctx.repos.tasks.select(
    "kind = 'style_guide_edit' AND json_extract(json, '$.context.styleGuideId') = ?",
    [styleGuideId],
    "created_at ASC, rowid ASC",
  );
}

export interface ResolvedPromptStyleGuide {
  id: string;
  name: string;
  description: string;
  instructions: string;
  reason: "mentioned" | "default";
  assets: Array<{ id: string; name: string; size: number; mime?: string; path: string }>;
}

/**
 * Which library style guide(s) apply to a project editing request or hand-off:
 * 1. Any style guide explicitly named via `@slug` in the editor's message (or `context.styleGuideIds`) overrides the default.
 * 2. Otherwise, any style guide referenced via `@slug` in an active skill.
 * 3. Otherwise, the library's Default style guide (if one is set).
 */
export function resolvePromptStyleGuides(ctx: Ctx, task: Task, activeSkills: readonly Skill[]): ResolvedPromptStyleGuide[] {
  if (!ctx.settings().styleGuidesBeta) return [];
  const all = listStyleGuides(ctx);
  if (!all.length) return [];

  const byId = new Map(all.map(g => [g.id, g]));
  const byName = new Map(all.map(g => [g.name.toLowerCase(), g]));

  // A hand-off inherits the parent request's text/mentions too in case the parent wasn't updated before dispatch.
  const parent = isHandOff(task) && task.context.checksTaskId ? ctx.repos.tasks.get(task.context.checksTaskId) : null;
  const messageText = [
    task.context.message ?? task.instruction,
    parent ? (parent.context.message ?? parent.instruction) : "",
  ].filter(Boolean).join("\n");

  const explicitIds = [...(task.context.styleGuideIds ?? []), ...(parent?.context.styleGuideIds ?? [])];
  const fromMessage: StyleGuideRecord[] = [];
  const seenMessage = new Set<string>();
  const addMessage = (g: StyleGuideRecord | undefined) => {
    if (!g || seenMessage.has(g.id)) return;
    seenMessage.add(g.id);
    fromMessage.push(g);
  };
  for (const id of explicitIds) addMessage(byId.get(id));
  for (const slug of styleGuideMentions(messageText)) addMessage(byName.get(slug));

  const format = (guides: StyleGuideRecord[], reason: "mentioned" | "default"): ResolvedPromptStyleGuide[] =>
    guides.map(g => ({
      id: g.id,
      name: g.name,
      description: g.description,
      instructions: g.instructions,
      reason,
      assets: styleGuideAssetPaths(ctx, g),
    }));

  if (fromMessage.length) return format(fromMessage, "mentioned");

  const fromSkills: StyleGuideRecord[] = [];
  const seenSkills = new Set<string>();
  for (const skill of activeSkills) {
    for (const slug of styleGuideMentions(skill.content)) {
      const found = byName.get(slug);
      if (found && !seenSkills.has(found.id)) {
        seenSkills.add(found.id);
        fromSkills.push(found);
      }
    }
  }
  if (fromSkills.length) return format(fromSkills, "mentioned");

  const fallback = all.find(g => g.isDefault);
  return fallback ? format([fallback], "default") : [];
}
