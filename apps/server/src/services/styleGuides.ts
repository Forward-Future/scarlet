/**
 * Reusable visual style guides: library-wide design direction, fonts/logos/assets, and rendered 16:9 previews
 * referenced automatically (as the Default style) or explicitly via @name in chat and skills.
 */
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { ChromeNotFound, findChrome, renderGraphicStill } from "@scarlet/render";
import {
  dbToLinearGain,
  findBuiltInStyleSound,
  parseStyleGuideDefinitionJson,
  slugifyStyleGuideName,
  StyleGuideRecord,
  synthesizeBuiltInSfxWav,
  isAsideTask,
  isHandOff,
  styleGuideMentions,
  type ActiveStyleGuide,
  type CreateStyleGuideRequest,
  type ImportStyleGuideSoundRequest,
  type Skill,
  type StyleGuideAsset,
  type StyleGuideColorLook,
  type StyleGuideFromGraphicRequest,
  type StyleGuidePreviewRenderRequest,
  type StyleGuidePreviewRenderResponse,
  type StyleGuideSound,
  type StyleGuideTransition,
  type Task,
  type UpdateStyleGuideRequest,
  type User,
} from "@scarlet/shared";
import { newId, type Author, type CaptionStyle, type MediaAsset } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { badRequest, conflict, HttpError, notFound } from "../errors.js";
import { clip, humanDuration, throttledPerCtx } from "../logText.js";
import { errorMessage } from "../util.js";
import { actorFor, authorName, logActivity, quote } from "./activity.js";
import { ingestMedia } from "./ingest.js";
import { assistantSkills } from "./skills.js";
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
    ...(body.captionStyle !== undefined && { captionStyle: body.captionStyle }),
    isDefault,
    assets: extra.assets ?? [],
    transitions: body.transitions ?? [],
    sounds: body.sounds ?? [],
    ...(body.colorLook && { colorLook: body.colorLook }),
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
  const nextColorLook = body.colorLook === null
    ? undefined
    : body.colorLook !== undefined
      ? body.colorLook
      : existing.colorLook;
  const nextCaptionStyle = body.captionStyle === null
    ? undefined
    : body.captionStyle !== undefined
      ? body.captionStyle
      : existing.captionStyle;
  const next = StyleGuideRecord.parse({
    ...existing,
    name: nextName,
    description: body.description !== undefined ? body.description.trim() : existing.description,
    instructions: body.instructions !== undefined ? body.instructions : existing.instructions,
    captionStyle: nextCaptionStyle,
    isDefault: nextDefault,
    assets: body.assets !== undefined ? body.assets : existing.assets,
    preview: body.preview !== undefined ? body.preview : existing.preview,
    transitions: body.transitions !== undefined ? body.transitions : existing.transitions,
    sounds: body.sounds !== undefined ? body.sounds : existing.sounds,
    colorLook: nextColorLook,
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

const AUDIO_EXTENSION = /\.(?:wav|mp3|m4a|aac|ogg|flac)$/i;

export async function saveStyleGuideAsset(
  ctx: Ctx,
  guideId: string,
  name: string,
  data: AsyncIterable<Uint8Array>,
  mime?: string,
  signal?: AbortSignal,
): Promise<{ asset: StyleGuideAsset; styleGuide: StyleGuideRecord; duration?: number }> {
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
  let duration: number | undefined;
  if ((detected?.startsWith("audio/") || AUDIO_EXTENSION.test(file)) && size > 0) {
    const probed = await ctx.render.probeMedia(file, signal).catch((error: unknown) => {
      if (!signal?.aborted) ctx.log(`[style-guides] ${guideId}: the length of sound ${id} couldn’t be read, it is saved without one: ${clip(errorMessage(error).split(file).join("<sound>").split(basename(file)).join("<sound>"))}`);
      return null;
    });
    if (probed && probed.duration > 0) duration = Math.round(probed.duration * 1000) / 1000;
  }
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
  return { asset, styleGuide: saved, ...(duration !== undefined && { duration }) };
}

export function deleteStyleGuideAsset(
  ctx: Ctx,
  user: User | null,
  guideId: string,
  assetId: string,
): StyleGuideRecord {
  if (!SAFE_ID.test(guideId) || !SAFE_ID.test(assetId)) throw notFound("style guide asset");
  const existing = ctx.repos.styleGuides.get(guideId);
  if (!existing) throw notFound(`style guide ${guideId}`);
  if (!existing.assets.some(a => a.id === assetId)) throw notFound("style guide asset");
  const removedSoundIds = new Set(existing.sounds.filter(s => s.source === "asset" && s.assetId === assetId).map(s => s.id));
  const nextAssets = existing.assets.filter(a => a.id !== assetId);
  const nextSounds = existing.sounds.filter(s => !(s.source === "asset" && s.assetId === assetId));
  const nextTransitions = removedSoundIds.size
    ? existing.transitions.map(t => (t.soundId && removedSoundIds.has(t.soundId) ? { ...t, soundId: undefined } : t))
    : existing.transitions;
  const nextColorLook = existing.colorLook?.lutAssetId === assetId
    ? { ...existing.colorLook, lutAssetId: undefined, lutName: undefined }
    : existing.colorLook;
  const saved = updateStyleGuide(ctx, user, existing, {
    assets: nextAssets,
    sounds: nextSounds,
    transitions: nextTransitions,
    colorLook: nextColorLook,
  });
  const folder = join(ctx.paths.styleGuideAssets(guideId), assetId);
  ctx.db.afterCommit(() => {
    void rm(folder, { recursive: true, force: true }).catch(() => undefined);
  });
  return saved;
}

const builtInWavCache = new Map<string, Uint8Array>();

export function builtInStyleSoundWav(id: string): Uint8Array | undefined {
  const meta = findBuiltInStyleSound(id);
  if (!meta) return undefined;
  const cached = builtInWavCache.get(meta.id);
  if (cached) return cached;
  const wav = synthesizeBuiltInSfxWav(meta.id);
  if (wav) builtInWavCache.set(meta.id, wav);
  return wav;
}

/**
 * Import a built-in starter SFX or a style guide's sound effect (built-in or attached audio asset)
 * cleanly into a project's media library, deduplicating by SHA-256 so repeated placements reuse one asset.
 */
export async function importStyleGuideSoundToProject(
  ctx: Ctx,
  projectId: string,
  user: User | null,
  body: ImportStyleGuideSoundRequest,
  opts: { signal?: AbortSignal; checkAttempt?: () => void } = {},
): Promise<{
  media: MediaAsset;
  name: string;
  volumeDb: number;
  volume: number;
  duration?: number;
  usageRule: string;
}> {
  const project = ctx.repos.projects.get(projectId);
  if (!project) throw notFound(`project ${projectId}`);

  let soundName = "";
  let fileName = "";
  let volumeDb = -14;
  let usageRule = "";
  let knownDuration: number | undefined;
  let bytes: Uint8Array | undefined;
  let sourcePath: string | undefined;

  const loadBuiltIn = (slug: string, overrides?: Partial<{ name: string; volumeDb: number; usageRule: string }>) => {
    const meta = findBuiltInStyleSound(slug);
    const wav = meta ? builtInStyleSoundWav(meta.id) : undefined;
    if (!meta || !wav) throw notFound(`built-in sound "${slug}"`);
    soundName = overrides?.name || meta.name;
    fileName = `${meta.id}.wav`;
    volumeDb = overrides?.volumeDb ?? meta.defaultVolumeDb;
    usageRule = overrides?.usageRule ?? meta.defaultUsageRule;
    knownDuration = meta.duration;
    bytes = wav;
  };

  if (body.builtInId) {
    loadBuiltIn(body.builtInId);
  } else if (body.styleGuideId) {
    const guide = ctx.repos.styleGuides.get(body.styleGuideId);
    if (!guide) throw notFound(`style guide ${body.styleGuideId}`);
    if (body.soundId) {
      if (body.soundId.startsWith("builtin:")) {
        loadBuiltIn(body.soundId.slice("builtin:".length));
      } else {
        const entry = guide.sounds.find(s => s.id === body.soundId);
        if (!entry) throw notFound(`sound "${body.soundId}" in @${guide.name}`);
        if (entry.source === "builtin") {
          if (!entry.builtInId) throw badRequest("invalid_sound", `Sound "${entry.name}" is missing its built-in id.`);
          loadBuiltIn(entry.builtInId, { name: entry.name, volumeDb: entry.volumeDb, usageRule: entry.usageRule });
        } else {
          if (!entry.assetId) throw badRequest("invalid_sound", `Sound "${entry.name}" is missing its audio file.`);
          const found = await findStyleGuideAsset(ctx, guide.id, entry.assetId);
          if (!found) throw notFound(`audio asset "${entry.assetId}" in @${guide.name}`);
          if (!found.asset.mime?.startsWith("audio/") && !AUDIO_EXTENSION.test(found.asset.name)) {
            throw badRequest("not_audio", `"${found.asset.name}" is not an audio file.`);
          }
          soundName = entry.name;
          fileName = found.asset.name;
          volumeDb = entry.volumeDb;
          usageRule = entry.usageRule;
          knownDuration = entry.duration;
          sourcePath = found.path;
        }
      }
    } else if (body.assetId) {
      const found = await findStyleGuideAsset(ctx, guide.id, body.assetId);
      if (!found) throw notFound(`audio asset "${body.assetId}" in @${guide.name}`);
      if (!found.asset.mime?.startsWith("audio/") && !AUDIO_EXTENSION.test(found.asset.name)) {
        throw badRequest("not_audio", `"${found.asset.name}" is not an audio file.`);
      }
      const linkedEntry = guide.sounds.find(s => s.source === "asset" && s.assetId === body.assetId);
      soundName = linkedEntry?.name ?? found.asset.name.replace(/\.[^.]+$/, "");
      fileName = found.asset.name;
      volumeDb = linkedEntry?.volumeDb ?? -14;
      usageRule = linkedEntry?.usageRule ?? "";
      knownDuration = linkedEntry?.duration;
      sourcePath = found.path;
    }
  } else {
    throw badRequest("missing_sound", "Provide builtInId, or styleGuideId with soundId or assetId.");
  }

  const hash = bytes
    ? createHash("sha256").update(bytes).digest("hex")
    : await ctx.render.hashFile(sourcePath!, undefined, opts.signal);

  const existingMedia = project.media.find(m => m.kind === "audio" && m.hash === hash);
  if (existingMedia) {
    ctx.log(`[style-guides] sound ${body.builtInId || body.soundId?.startsWith("builtin:") ? "built-in" : "from a style guide"} is already ${existingMedia.id} in ${projectId}: reused`);
    return {
      media: existingMedia,
      name: soundName,
      volumeDb,
      volume: dbToLinearGain(volumeDb),
      duration: existingMedia.duration ?? knownDuration,
      usageRule,
    };
  }

  await mkdir(ctx.paths.tmp, { recursive: true, mode: 0o700 });
  const staged = join(ctx.paths.tmp, `sfx-${randomUUID()}${extname(fileName) || ".wav"}`);
  try {
    if (bytes) await writeFile(staged, bytes, { mode: 0o600, signal: opts.signal });
    else await cp(sourcePath!, staged);
    const ingested = await ingestMedia(ctx, project, { type: "upload", path: staged, hash }, {
      name: soundName.endsWith(extname(fileName)) ? soundName : `${soundName}${extname(fileName) || ".wav"}`,
      kind: "audio",
      checkAttempt: opts.checkAttempt,
      transcription: { provider: undefined, revision: 0, signal: opts.signal ?? ctx.shutdown },
      by: { by: "agent", name: "style-guide-sfx", createdAt: now() },
      uploadedBy: user?.id,
    });
    return {
      media: ingested,
      name: soundName,
      volumeDb,
      volume: dbToLinearGain(volumeDb),
      duration: ingested.duration ?? knownDuration,
      usageRule,
    };
  } finally {
    await rm(staged, { force: true }).catch(() => undefined);
  }
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
  const started = Date.now();
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
      ctx.log(`[style-guides] ${guideId}: preview not saved, ${drawn.missingFonts.length} font${drawn.missingFonts.length === 1 ? " is" : "s are"} missing (${humanDuration(Date.now() - started)})`);
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
      .catch((error: unknown) => {
        if (!signal?.aborted) ctx.log(`[style-guides] ${guideId}: the preview's small picture couldn’t be made: ${clip(errorMessage(error))}`);
        return undefined;
      });

    await mkdir(dirname(previewDir), { recursive: true, mode: 0o700 });
    await swapInFolder(staging, previewDir, line => ctx.log(`[style-guides] ${guideId} preview: ${line}`));
    swapped = true;

    const updatedAt = now();
    const saved = ctx.db.transaction(() => {
      const current = ctx.repos.styleGuides.get(guideId);
      if (!current) throw notFound(`style guide ${guideId}`);
      return updateStyleGuide(ctx, null, current, { preview: { updatedAt, width, height } });
    }, "immediate")();
    ctx.log(`[style-guides] ${guideId}: preview saved ${width}x${height} in ${humanDuration(Date.now() - started)}${drawn.problems.length ? `, ${drawn.problems.length} problem${drawn.problems.length === 1 ? "" : "s"} on the page` : ""}`);

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

const previewFailures = throttledPerCtx();

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
    .catch((error: unknown) => {
      // Asked for each time the guide's page opens, so a picture that can't be read is logged once a minute.
      if (!signal?.aborted) previewFailures(ctx)(guideId, `[style-guides] ${guideId}: the saved preview's picture couldn’t be read: ${clip(errorMessage(error))}`);
      return undefined;
    });
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
    // A family list may quote names ("Brand Serif", serif); a quote that runs into markup ends an HTML attribute instead.
    Array.from(html.matchAll(/font-family\s*:\s*((?:"[^"\n<>;{}]*"|'[^'\n<>;{}]*'|[^;}"'\n<>])+)/gi), m => m[1]!.replace(/["']/g, "").trim()),
  )].filter(Boolean).slice(0, 6);
  const lines = [
    `Saved from the project graphic "${name}". Match its visual language across captions, lower thirds, chapter titles, callout boxes, and overlays.`,
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
  const started = Date.now();

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
    const savedLine = `[style-guides] ${updated.id} saved from graphic ${media.id} with ${copiedAssets.length} file${copiedAssets.length === 1 ? "" : "s"}`;
    try {
      const rendered = await renderStyleGuidePreview(ctx, updated.id, { html: rewrittenHtml, width, height, at }, signal);
      if (rendered.styleGuide) {
        ctx.log(`${savedLine} in ${humanDuration(Date.now() - started)}`);
        return rendered.styleGuide;
      }
    } catch (error) {
      // If Chrome isn't installed in a headless environment, keep the saved style guide + assets without failing the save.
      if (!(error instanceof ChromeNotFound)) {
        ctx.log(`[style-guides] initial preview render skipped for ${updated.id}: ${clip(errorMessage(error))}`);
      }
    }
    ctx.log(`${savedLine}, without a preview, in ${humanDuration(Date.now() - started)}`);
    return ctx.repos.styleGuides.get(updated.id) ?? updated;
  } catch (error) {
    ctx.log(`[style-guides] saving ${created.id} from graphic ${media.id} failed after ${humanDuration(Date.now() - started)} and it was removed: ${clip(errorMessage(error))}`);
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
  captionStyle?: Partial<CaptionStyle>;
  reason: "mentioned" | "default";
  assets: Array<{ id: string; name: string; size: number; mime?: string; path: string }>;
  transitions: StyleGuideTransition[];
  sounds: Array<StyleGuideSound & { volumeLinear: number }>;
  colorLook?: StyleGuideColorLook & { lutFile?: string; lutPath?: string };
}

/**
 * Which library style guide(s) apply to a project editing request or hand-off:
 * 1. Any style guide explicitly named via `@slug` in the editor's message (or `context.styleGuideIds`) overrides the default.
 * 2. Otherwise, any style guide referenced via `@slug` in an active skill.
 * 3. Otherwise, the library's Default style guide (if one is set).
 */
export function resolvePromptStyleGuides(ctx: Ctx, task: Task, activeSkills: readonly Skill[]): ResolvedPromptStyleGuide[] {
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
    guides.map(g => {
      const assets = styleGuideAssetPaths(ctx, g);
      const lutAsset = g.colorLook?.lutAssetId ? assets.find(a => a.id === g.colorLook!.lutAssetId) : undefined;
      return {
        id: g.id,
        name: g.name,
        description: g.description,
        instructions: g.instructions,
        ...(g.captionStyle && { captionStyle: g.captionStyle }),
        reason,
        assets,
        transitions: g.transitions,
        sounds: g.sounds.map(s => ({ ...s, volumeLinear: dbToLinearGain(s.volumeDb) })),
        ...(g.colorLook && {
          colorLook: {
            ...g.colorLook,
            ...(lutAsset && {
              lutFile: `${g.id}/assets/${lutAsset.id}/${lutAsset.name}`,
              lutPath: lutAsset.path,
            }),
          },
        }),
      };
    });

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

/**
 * Resolve active style guides for a running task (using the same priority as prompt injection)
 * or return the library Default when called outside a task.
 */
export function resolveActiveStyleGuides(ctx: Ctx, opts: { projectId?: string; taskId?: string } = {}): ActiveStyleGuide[] {
  if (opts.taskId) {
    const task = ctx.repos.tasks.get(opts.taskId);
    if (task && (!opts.projectId || task.projectId === opts.projectId)) {
      const aside = (isAsideTask(task) && !isHandOff(task)) || task.kind === "skill_from_change";
      const activeSkills = aside ? [] : assistantSkills(ctx.repos.skills.select("1=1", [], "name ASC"), task.context.skillIds, true);
      return resolvePromptStyleGuides(ctx, task, activeSkills);
    }
  }
  const fallback = listStyleGuides(ctx).find(g => g.isDefault);
  if (!fallback) return [];
  const assets = styleGuideAssetPaths(ctx, fallback);
  const lutAsset = fallback.colorLook?.lutAssetId ? assets.find(a => a.id === fallback.colorLook!.lutAssetId) : undefined;
  return [{
    id: fallback.id,
    name: fallback.name,
    description: fallback.description,
    instructions: fallback.instructions,
    ...(fallback.captionStyle && { captionStyle: fallback.captionStyle }),
    reason: "default",
    assets,
    transitions: fallback.transitions,
    sounds: fallback.sounds.map(s => ({ ...s, volumeLinear: dbToLinearGain(s.volumeDb) })),
    ...(fallback.colorLook && {
      colorLook: {
        ...fallback.colorLook,
        ...(lutAsset && {
          lutFile: `${fallback.id}/assets/${lutAsset.id}/${lutAsset.name}`,
          lutPath: lutAsset.path,
        }),
      },
    }),
  }];
}

/**
 * Import a portable JSON file defining a Style Guide's settings (graphics rules, caption style,
 * transitions, sound effects, and camera color look). Returns `{ imported: false }` if the file isn't a
 * structured Style Guide definition, so callers can pass it to Scarlet in chat instead.
 */
export function importStyleGuideDefinition(
  ctx: Ctx,
  user: User | null,
  rawText: string,
  fileName: string,
  opts: { styleGuideId?: string } = {},
): { imported: true; styleGuide: StyleGuideRecord } | { imported: false } {
  const existing = opts.styleGuideId ? ctx.repos.styleGuides.get(opts.styleGuideId) : undefined;
  if (opts.styleGuideId && !existing) throw notFound(`style guide ${opts.styleGuideId}`);

  const baseName = fileName.replace(/\.(?:style\.)?json$/i, "");
  const existingAssetIds = new Set(existing?.assets.map(a => a.id) ?? []);
  const parsed = parseStyleGuideDefinitionJson(rawText, { fallbackName: baseName, existingAssetIds });
  if (!parsed) {
    ctx.log(`[style-guides] the file isn't a style guide definition${existing ? ` for ${existing.id}` : ""}: it goes to Scarlet in chat`);
    return { imported: false };
  }

  const styleGuide = ctx.db.transaction(() => {
    if (existing) {
      return updateStyleGuide(ctx, user, existing, {
        ...(parsed.description !== undefined && { description: parsed.description }),
        ...(parsed.instructions !== undefined && { instructions: parsed.instructions }),
        ...(parsed.captionStyle !== undefined && { captionStyle: parsed.captionStyle }),
        ...(parsed.isDefault !== undefined && { isDefault: parsed.isDefault }),
        ...(parsed.transitions !== undefined && { transitions: parsed.transitions }),
        ...(parsed.sounds !== undefined && { sounds: parsed.sounds }),
        ...(parsed.colorLook !== undefined && { colorLook: parsed.colorLook }),
      });
    }
    const baseSlug = parsed.name || slugifyStyleGuideName(baseName) || "imported-style";
    let uniqueName = baseSlug;
    let suffix = 2;
    while (findDuplicateStyleGuide(ctx, uniqueName)) {
      uniqueName = `${baseSlug}-${suffix++}`;
    }
    return createStyleGuide(
      ctx,
      user,
      {
        name: uniqueName,
        description: parsed.description,
        instructions: parsed.instructions,
        ...(parsed.captionStyle ? { captionStyle: parsed.captionStyle } : {}),
        isDefault: parsed.isDefault,
        transitions: parsed.transitions,
        sounds: parsed.sounds,
        ...(parsed.colorLook ? { colorLook: parsed.colorLook } : {}),
      },
      { source: "import" },
    );
  }, "immediate")();

  ctx.log(`[style-guides] definition imported ${existing ? "into" : "as a new guide,"} ${styleGuide.id}`);
  return { imported: true, styleGuide };
}
