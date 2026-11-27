/**
 * The motion graphics tools: drawing a graphic from a web page, the project's style
 * guide and the files the editor attached. Scarlet draws the page (packages/render/src/graphic.ts); these tools carry
 * the page and its files there and report what the drawing measured.
 */
import { basename, dirname, join } from "node:path";
import { z } from "zod/v3";
import {
  BUILT_IN_STYLE_SOUNDS,
  dbToLinearGain,
  ImportStyleGuideSoundRequest,
  styleGuideEditTarget,
  TaskStyleGuideDraft,
  type AgentCapabilities,
  type AgentId,
  type ScarletClient,
  type StyleGuideRecord,
  type Task,
} from "@scarlet/shared";
import type { Author } from "@scarlet/timeline";
import { round3 } from "./analysis.js";
import { errorText, json, type ToolRegistrar, type ToolResult } from "./tool-result.js";

interface GraphicsDeps {
  tool: ToolRegistrar;
  client: ScarletClient;
  projectId: string;
  taskId?: string;
  agent?: AgentId | string;
  task?: Task;
  author: Author;
  caps: Pick<AgentCapabilities, "files" | "images" | "shell">;
  /** A file in the task artifact directory. */
  readArtifact(path: string): Promise<Buffer<ArrayBuffer>>;
  /** Write a file there, and say where it went. */
  writeArtifact(path: string, data: Buffer): Promise<string>;
}

/**
 * The files a page links to by a path relative to it, each once, as a browser reads the link: percent-decoded, and as
 * written when it isn't valid percent-encoding. Links with a scheme and absolute paths are left out.
 */
export function relativeLinks(html: string): string[] {
  const links = new Set<string>();
  for (const match of html.matchAll(/(?:\b(?:src|href)\s*=\s*|url\(\s*)(?:"([^"]*)"|'([^']*)'|([^"')\s>]+))/gi)) {
    let link = (match[1] ?? match[2] ?? match[3] ?? "").trim().split(/[?#]/, 1)[0]!;
    if (!link) continue;
    try { link = decodeURIComponent(link); } catch { /* A stray % is part of the file's name. */ }
    if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith("/") || link.startsWith("\\")) continue;
    links.add(link);
  }
  return [...links];
}

export function registerGraphics(deps: GraphicsDeps) {
  const { tool, client } = deps;

  /** The page a harness with file tools wrote, and the files it links to by relative path. */
  async function pageFromArtifact(path: string): Promise<{ html: string; assets: Array<{ name: string; data: Buffer<ArrayBuffer> }> }> {
    const html = (await deps.readArtifact(path)).toString("utf8");
    const folder = dirname(path);
    const assets: Array<{ name: string; data: Buffer<ArrayBuffer> }> = [];
    for (const link of relativeLinks(html)) {
      const data = await deps.readArtifact(join(folder, link)).catch(() => undefined);
      if (data) assets.push({ name: link, data });
    }
    return { html, assets };
  }

  const checkPictures = (checks: Array<{ time: number; jpeg?: string }>): ToolResult["content"] =>
    checks.filter(c => c.jpeg).map(c => ({ type: "image" as const, mimeType: "image/jpeg", data: c.jpeg! }));

  tool(
    "graphic_render",
    `Draw a motion graphic from a web page and add it to the project's media as a graphic with alpha, to place over the picture with timeline_propose (addClip of the returned mediaId on a video track above the footage; its clip can be shorter than the graphic). Send the page as html: a complete HTML document drawn at the project's size (or width/height) — keep the background transparent for overlays over A-cam footage, or use an opaque background for full-screen graphics — using viewport units or the frame's pixels. Time: CSS animations, transitions and Web Animations are paused and set to each frame's time, SVG animations too; a page that keeps its own clock defines window.scarletSeek(seconds), called before each frame, which may return a promise. Fonts load from @font-face rules or installed fonts. Link fonts and pictures by absolute path or file URL (an attachment's path works)${deps.caps.files ? " or, with path, by a path relative to the page" : ""}; Scarlet keeps them with the graphic. Scarlet keeps the page with the graphic too: to revise one, read it with graphic_get, change it and render again with basedOn, which carries its files over, then point the clip at the new mediaId (updateClip). Returns the mediaId, the page's path, the box the graphic covers at a few moments (fractions of the frame, left/top/right/bottom), errors the page raised and files it couldn't load${deps.caps.images ? ", and pictures of those moments over the edit at checkAt" : ""}. A page whose text asks for a font that isn't installed or loaded is not added: missingFonts names each, and installedFonts lists common families this machine has. When the editor named the font, in their words or the style guide, ask them with task_question whether they will add its file or which installed font to use; never substitute it yourself. A font only you chose: pick an installed one and render again.`,
    {
      html: z.string().min(1).max(500_000).optional().describe("The page, a complete HTML document"),
      ...(deps.caps.files ? { path: z.string().optional().describe("Or an HTML file in the task artifact directory") } : {}),
      basedOn: z.string().optional().describe("mediaId of the graphic this revises"),
      duration: z.number().positive().max(600).optional().describe("Seconds; default the revised graphic's"),
      width: z.number().int().positive().max(8192).optional(),
      height: z.number().int().positive().max(8192).optional(),
      fps: z.number().positive().max(120).optional(),
      name: z.string().trim().min(1).max(200).optional().describe("How the media list names it"),
      checkAt: z.number().nonnegative().optional().describe("Timeline seconds where the graphic will start, on the head version; default the editor's playhead"),
      checkTimes: z.array(z.number().nonnegative()).max(6).optional().describe("Seconds into the graphic to check; default three spread through it"),
    },
    async (args) => {
      const { html, basedOn, duration, width, height, fps, name, checkAt, checkTimes } = args;
      const path = (args as { path?: string }).path;
      if (html !== undefined && path !== undefined) return errorText("Send html or path, not both.");
      const page = path ? await pageFromArtifact(path) : undefined;
      const context = deps.task?.context;
      const playhead = context && !context.mediaId ? context.time : undefined;
      const fd = new FormData();
      fd.append("options", JSON.stringify({
        basedOn, duration, width, height, fps, name, checkTimes,
        checkAt: checkAt ?? playhead ?? 0, pictures: deps.caps.images,
        provenance: { name: deps.author.name, model: deps.author.model },
      }));
      const source = page?.html ?? html;
      // As a file, so its line breaks arrive as written.
      if (source !== undefined) fd.append("html", new Blob([source], { type: "text/html" }), "index.html");
      for (const asset of page?.assets ?? []) fd.append("asset", new Blob([asset.data]), asset.name);
      const result = await client.renderGraphic(deps.projectId, fd);
      const checks = result.checks.map(({ jpeg: _jpeg, ...c }) => c);
      const summary = {
        ...(result.media ? { mediaId: result.media.id, name: result.media.name, source: result.source } : { added: false }),
        duration: result.duration, width: result.width, height: result.height, fps: result.fps,
        ...(result.missingFonts.length && { missingFonts: result.missingFonts, ...(result.installedFonts && { installedFonts: result.installedFonts }),
          next: "Not added. A font the editor named: ask them whether they will add its file or which installed font to use. A font you chose: use an installed one." }),
        ...(result.problems.length && { problems: result.problems }),
        checks, ...(result.checkAt !== undefined && { checkAt: result.checkAt }), renderSeconds: round3(result.renderMs / 1000),
      };
      return { content: [{ type: "text", text: JSON.stringify(summary) }, ...checkPictures(result.checks)] };
    },
  );

  tool(
    "graphic_get",
    "Read a graphic Scarlet drew: its page as it was drawn, where the page is, the files kept beside it (linked by those relative paths), and its size, fps and duration. Revise it by changing the page and calling graphic_render with basedOn.",
    { mediaId: z.string().min(1) },
    async ({ mediaId }) => json(await client.graphic(deps.projectId, mediaId)),
  );

  // A run launched with its harness's own tools, as every request is, captures pages into its task folder.
  if (deps.caps.shell) tool(
    "web_capture",
    "Open a page on the web in Scarlet's own headless Chrome and save its picture in the task artifact directory: the browser window (width × height in CSS pixels, default 1280 × 800) or, with fullPage, the whole page down to its end (up to 12,000 pixels). The page gets a moment after it loads for what it draws late. Use it for B-roll of an article, a post or a site: frame the picture any way you like (a page for graphic_render that links the file, ffmpeg, your own tools), then bring the result in with asset_add, with source { url, capture: this file, region: the part you used }, so the editor sees where it came from. Only public http and https pages. Returns the file's path and size, the page's title and address after any redirect, its headings with where each sits in the picture (fractions of it), and its words (the first 20,000 characters).",
    {
      url: z.string().describe("The page's web address"),
      width: z.number().int().min(320).max(3840).optional().describe("Browser width in CSS pixels; default 1280"),
      height: z.number().int().min(240).max(4000).optional().describe("Browser height in CSS pixels; default 800"),
      fullPage: z.boolean().optional().describe("The whole page down to its end, not the window alone"),
      path: z.string().optional().describe("Where to save it in the task artifact directory; default capture-<host>-<time>.png"),
    },
    async ({ url, width, height, fullPage, path }) => {
      const shot = await deps.client.post<{ png: string; title: string; url: string; text: string; width: number; height: number;
        headings: Array<{ text: string; box: { left: number; top: number; right: number; bottom: number } }> }>(
        `/projects/${deps.projectId}/web-captures`, { url, width, height, fullPage });
      let host = "page";
      try { host = new URL(shot.url).hostname.replace(/^www\./, "").replace(/[^a-z0-9.-]/gi, "") || host; } catch { /* the default name */ }
      const saved = await deps.writeArtifact(path ?? `capture-${host}-${Date.now()}.png`, Buffer.from(shot.png, "base64"));
      return json({ path: saved, width: shot.width, height: shot.height, title: shot.title, url: shot.url,
        headings: shot.headings.map(h => ({ text: h.text, box: { left: round3(h.box.left), top: round3(h.box.top), right: round3(h.box.right), bottom: round3(h.box.bottom) } })),
        text: shot.text });
    },
  );

  // The engine reads and downloads it, as it captures a page: the part asked for lands in the task folder.
  if (deps.caps.shell) tool(
    "web_video",
    "A video on the web (YouTube and most video sites), by the address of its page. Without from and to it downloads nothing and says what the video is: its title, channel, length in seconds, license, chapters and description, then its captions as lines of `seconds words`, from captionsFrom on (20,000 characters a call; captionsNext is where to read on). With from and to, in seconds of that video (up to 10 minutes a call), it saves that part in the task artifact directory, cut on those seconds, as an MP4 up to `height` pixels tall (default 1080), with a picture from its middle beside it. Use it for B-roll from a video: look at the part with your own tools, then bring it in with asset_add and the `source` this returns, so the editor sees where it came from. Only public videos: none that needs a sign-in, none still live. The first call on a machine fetches the downloader, about 40 MB.",
    {
      url: z.string().describe("The address of the video's page"),
      from: z.number().min(0).optional().describe("Where the part to save starts, in seconds of the video"),
      to: z.number().min(0).optional().describe("Where it ends"),
      height: z.number().int().min(144).max(4320).optional().describe("The tallest picture to save, in pixels; default 1080"),
      captionsFrom: z.number().min(0).optional().describe("Read the captions from this second on; default 0"),
      path: z.string().optional().describe("Where to save the part in the task artifact directory; default video-<host>-<time>.mp4"),
    },
    async ({ url, from, to, height, captionsFrom, path }) => {
      type About = { url: string; title: string; channel?: string; duration?: number; uploaded?: string; license?: string; width?: number; height?: number;
        chapters?: Array<{ start: number; end: number; title: string }>; description?: string };
      const read = await deps.client.post<{ video: About; captions?: { language: string; automatic: boolean; text: string; next?: number };
        part?: { id: string; from: number; to: number; duration: number; width?: number; height?: number; size: number; poster?: string } }>(
        `/projects/${deps.projectId}/web-videos`, { url, from, to, height, captionsFrom });
      const { video, captions, part } = read;
      if (!part) {
        const about = { ...video, ...(captions ? { captions: { language: captions.language, automatic: captions.automatic, ...(captions.next !== undefined && { captionsNext: captions.next }) } }
          : { captions: "This video has no captions." }) };
        return { content: [{ type: "text" as const, text: JSON.stringify(about) }, ...(captions?.text ? [{ type: "text" as const, text: captions.text }] : [])] };
      }
      const data = await deps.client.request<Buffer>("GET", `/projects/${deps.projectId}/web-videos/${encodeURIComponent(part.id)}`, undefined, {}, bytes => Buffer.from(bytes));
      let host = "web";
      try { host = new URL(video.url).hostname.replace(/^www\./, "").replace(/[^a-z0-9.-]/gi, "") || host; } catch { /* the default name */ }
      const saved = await deps.writeArtifact(path ?? `video-${host}-${Date.now()}.mp4`, data);
      const poster = part.poster ? await deps.writeArtifact(saved.replace(/\.[^./\\]+$/, "") + ".jpg", Buffer.from(part.poster, "base64")) : undefined;
      return json({ path: saved, ...(poster && { picture: poster }), from: part.from, to: part.to, duration: part.duration, width: part.width, height: part.height,
        title: video.title, channel: video.channel, license: video.license,
        source: { url: video.url, ...(poster && { capture: poster }), clip: { start: part.from, end: part.to } } });
    },
  );

  tool(
    "style_guide_save",
    `Save the project's style guide, which the editor gives once for the project: from then on every request in this project is given it. It replaces any guide before it. Give it a name (the file's name, or the guide's own title) and the text the editor pasted, or the attachment it is in${deps.caps.files ? ", or a file in the task artifact directory" : ""}, or both.`,
    {
      name: z.string().trim().min(1).max(200),
      text: z.string().max(200_000).optional(),
      attachmentId: z.string().optional().describe("An attachment of this request"),
      ...(deps.caps.files ? { path: z.string().optional().describe("Or a file in the task artifact directory") } : {}),
    },
    async (args) => {
      const path = (args as { path?: string }).path;
      let attachmentId = args.attachmentId;
      if (path) {
        attachmentId = (await client.uploadAttachment(deps.projectId, new Blob([await deps.readArtifact(path)]), basename(path))).attachment.id;
      }
      if (!args.text?.trim() && !attachmentId) return errorText("Give the guide's text or the attachment it is in.");
      const { styleGuide } = await client.saveStyleGuide(deps.projectId, { name: args.name, text: args.text, attachmentId });
      return json(styleGuide);
    },
  );

  tool(
    "style_guide_get",
    "Read the editor's library style guides (visual graphics rules, preferred transitions, sound effects with mix levels, and saved camera color look / LUT) plus the built-in starter sound effects catalog. Pass styleGuideId or name (without @) to inspect one guide in full, or omit both to list all guides and starter sounds.",
    {
      styleGuideId: z.string().optional().describe("Style guide id to read in full"),
      name: z.string().optional().describe("Style guide slug (with or without leading @) to read in full"),
    },
    async ({ styleGuideId, name }) => {
      const formatGuide = (g: StyleGuideRecord) => {
        const lutAsset = g.colorLook?.lutAssetId ? g.assets.find(a => a.id === g.colorLook!.lutAssetId) : undefined;
        return {
          id: g.id,
          name: g.name,
          description: g.description,
          isDefault: g.isDefault,
          instructions: g.instructions,
          transitions: g.transitions,
          sounds: g.sounds.map(s => ({ ...s, volume: dbToLinearGain(s.volumeDb) })),
          ...(g.colorLook && {
            colorLook: {
              ...g.colorLook,
              ...(lutAsset && { lutFile: `${g.id}/assets/${lutAsset.id}/${lutAsset.name}` }),
            },
          }),
          assets: g.assets,
        };
      };
      if (styleGuideId) {
        const { styleGuide } = await client.styleGuide(styleGuideId);
        return json({ styleGuide: formatGuide(styleGuide), builtInSounds: BUILT_IN_STYLE_SOUNDS.map(({ waveform: _w, ...s }) => s) });
      }
      const { styleGuides } = await client.styleGuides();
      if (name) {
        const needle = name.replace(/^@+/, "").toLowerCase();
        const found = styleGuides.find(g => g.name.toLowerCase() === needle);
        if (!found) return errorText(`No style guide named "@${needle}" was found.`);
        return json({ styleGuide: formatGuide(found), builtInSounds: BUILT_IN_STYLE_SOUNDS.map(({ waveform: _w, ...s }) => s) });
      }
      return json({
        styleGuides: styleGuides.map(g => ({
          id: g.id,
          name: g.name,
          description: g.description,
          isDefault: g.isDefault,
          transitionsCount: g.transitions.length,
          soundsCount: g.sounds.length,
          hasColorLook: Boolean(g.colorLook),
        })),
        builtInSounds: BUILT_IN_STYLE_SOUNDS.map(({ waveform: _w, ...s }) => s),
      });
    },
  );

  tool(
    "style_guide_sound_import",
    "Import a sound effect from a style guide (either a saved sound entry or attached audio asset) or a built-in starter sound (soft-whoosh, subtle-pop, airy-slide, subtle-riser, clean-chime, crisp-tick) into this project's media library so it can be placed on an audio track with timeline_propose (addClip). Deduplicates automatically if the same sound is already in the project. Returns mediaId, duration, volumeDb, linear volume (ready for addClip.volume), and usageRule.",
    {
      styleGuideId: z.string().optional().describe("Style guide id owning the sound or audio asset"),
      soundId: z.string().optional().describe("Sound entry id from the style guide's sounds list (or builtin:<slug>)"),
      builtInId: z.string().optional().describe("Built-in starter sound slug (soft-whoosh, subtle-pop, airy-slide, subtle-riser, clean-chime, crisp-tick)"),
      assetId: z.string().optional().describe("Custom audio asset id attached to styleGuideId"),
    },
    async (args) => {
      const normalized = args.soundId?.startsWith("builtin:") && !args.builtInId
        ? { ...args, builtInId: args.soundId.slice("builtin:".length), soundId: undefined }
        : args;
      const parsed = ImportStyleGuideSoundRequest.safeParse(normalized);
      if (!parsed.success) return errorText("Provide builtInId, or styleGuideId with soundId or assetId.");
      const res = await client.importStyleGuideSound(deps.projectId, parsed.data);
      return json({
        mediaId: res.media.id,
        name: res.name,
        duration: res.duration ?? res.media.duration,
        volumeDb: res.volumeDb,
        volume: res.volume,
        usageRule: res.usageRule,
      });
    },
  );

  tool(
    "attachment_read",
    `Read a file the editor attached to a request in this project (attachmentId), a file attached to a library style guide (styleGuideId + assetId), or with styleGuide the project's style guide. Text comes back as text; ${deps.caps.images ? "a picture comes back as the picture, and a PDF as pictures of its pages (pages, up to 8 a call; default the first 6) with pageCount when the file says it" : "a picture or a PDF comes back as its name, size and path only"}. A font file comes back as its path, for an @font-face rule.`,
    {
      attachmentId: z.string().optional(),
      styleGuide: z.boolean().optional(),
      styleGuideId: z.string().optional().describe("Library style guide id containing assetId"),
      assetId: z.string().optional().describe("Asset id inside a library style guide"),
      pages: z.array(z.number().int().positive()).max(8).optional().describe("PDF pages to read, from 1"),
    },
    async ({ attachmentId, styleGuide, styleGuideId, assetId, pages }) => {
      const targetGuideId = styleGuideId ?? (assetId ? deps.task?.context.styleGuideId : undefined);
      const readingStyleAsset = Boolean(assetId && targetGuideId);
      const modes = Number(Boolean(attachmentId)) + Number(Boolean(styleGuide)) + Number(readingStyleAsset);
      if (modes !== 1) return errorText("Name an attachmentId, styleGuide, or styleGuideId + assetId.");
      const requestedPages = deps.caps.images ? pages : [];
      const doc = readingStyleAsset
        ? await client.readStyleGuideAsset(targetGuideId!, assetId!, requestedPages)
        : await client.readDocument(deps.projectId, {
            attachmentId,
            styleGuide,
            ...(deps.caps.images && pages && { pages }),
            ...(!deps.caps.images && { pages: [] }),
          });
      const { text: body, pages: shots, image, ...about } = doc;
      const content: ToolResult["content"] = [{ type: "text", text: JSON.stringify({ ...about, ...(shots && deps.caps.images && { pagesShown: shots.map(p => p.page) }) }) }];
      if (body !== undefined) content.push({ type: "text", text: body });
      if (deps.caps.images && image) content.push({ type: "image", mimeType: image.mime, data: image.data });
      if (deps.caps.images) for (const shot of shots ?? []) content.push({ type: "image", mimeType: "image/jpeg", data: shot.jpeg });
      return { content };
    },
  );

  // -- library style guide authoring (only inside style_guide_edit tasks) ---

  const editingGuide = deps.task && deps.task.id === deps.taskId && (!deps.agent || deps.task.agent === deps.agent)
    ? styleGuideEditTarget(deps.task, deps.projectId)
    : undefined;
  if (deps.task && editingGuide) {
    const taskId = deps.task.id;
    tool(
      "style_guide_update",
      "Save updates to this style guide: its one-line description, visual graphics rules (instructions), optional structured captionStyle, preferred transitions (with optional paired soundId), sound effects (built-in starters or attached audio assets with volumeDb and usageRule), and/or saved camera colorLook (adjustments and/or attached .cube/.3dl lutAssetId). Omitted sections stay as they are; pass colorLook: null to clear the saved color look.",
      TaskStyleGuideDraft.shape,
      async ({ description, instructions, captionStyle, transitions, sounds, colorLook }) => {
        if (description === undefined && instructions === undefined && captionStyle === undefined && transitions === undefined && sounds === undefined && colorLook === undefined) {
          return errorText("Provide at least one field to update (description, instructions, captionStyle, transitions, sounds, or colorLook).");
        }
        const { styleGuide } = await client.saveTaskStyleGuideEdit(deps.projectId, taskId, {
          styleGuideId: editingGuide.styleGuideId,
          hostId: editingGuide.hostId,
          ...(description !== undefined && { description }),
          ...(instructions !== undefined && { instructions }),
          ...(captionStyle !== undefined && { captionStyle }),
          ...(transitions !== undefined && { transitions }),
          ...(sounds !== undefined && { sounds }),
          ...(colorLook !== undefined && { colorLook }),
        });
        return json({
          styleGuideId: styleGuide.id,
          name: styleGuide.name,
          description: styleGuide.description,
          ...(styleGuide.captionStyle && { captionStyle: styleGuide.captionStyle }),
          transitionsCount: styleGuide.transitions.length,
          soundsCount: styleGuide.sounds.length,
          hasColorLook: Boolean(styleGuide.colorLook),
        });
      },
    );

    tool(
      "style_guide_preview_render",
      "Draw a 16:9 visual style sheet preview (default 1920x1080) from a complete HTML/CSS page and save it as this style guide's live preview. Link attached fonts and logos by their exact absolute paths from the prompt. Returns missingFonts and installedFonts if any font failed to load (leaving the previous preview intact).",
      {
        html: z.string().min(1).max(512 * 1024).describe("Complete HTML document for the 16:9 style sheet preview"),
        width: z.number().int().positive().max(3840).optional().describe("Default 1920"),
        height: z.number().int().positive().max(2160).optional().describe("Default 1080"),
        at: z.number().nonnegative().max(60).optional().describe("Seconds into any animation to capture; default 0.5"),
      },
      async ({ html, width, height, at }) => {
        const res = await client.renderStyleGuidePreview(editingGuide.styleGuideId, { html, width, height, at });
        const summary = {
          saved: !res.missingFonts.length,
          width: res.width,
          height: res.height,
          ...(res.styleGuide?.preview && { updatedAt: res.styleGuide.preview.updatedAt }),
          ...(res.missingFonts.length && {
            missingFonts: res.missingFonts,
            ...(res.installedFonts && { installedFonts: res.installedFonts }),
            next: "Preview not updated. Use an installed font or ask the editor for the custom font file.",
          }),
          ...(res.problems.length && { problems: res.problems }),
        };
        const content: ToolResult["content"] = [{ type: "text", text: JSON.stringify(summary) }];
        if (deps.caps.images && res.jpeg) content.push({ type: "image", mimeType: "image/jpeg", data: res.jpeg });
        return { content };
      },
    );

    tool(
      "style_guide_preview_get",
      "Read this style guide's current preview HTML (and preview picture when supported) so you can revise it without losing elements the editor already likes.",
      {},
      async () => {
        const src = await client.styleGuidePreviewSource(editingGuide.styleGuideId);
        const content: ToolResult["content"] = [
          { type: "text", text: JSON.stringify({ width: src.width, height: src.height, updatedAt: src.updatedAt }) },
          { type: "text", text: src.html },
        ];
        if (deps.caps.images && src.jpeg) content.push({ type: "image", mimeType: "image/jpeg", data: src.jpeg });
        return { content };
      },
    );
  }
}
