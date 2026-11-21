/**
 * The motion-graphics tools: drawing a graphic from a web page, the project's style
 * guide and the files the editor attached. Scarlet draws the page (packages/render/src/graphic.ts); these tools carry
 * the page and its files there and report what the drawing measured.
 */
import { basename, dirname, join } from "node:path";
import { z } from "zod/v3";
import type { AgentCapabilities, ProjectDetail, ScarletClient, ScarletToolName, Task } from "@scarlet/shared";
import type { Author } from "@scarlet/timeline";
import { round3 } from "./analysis.js";
import { errorText, json, type ToolResult } from "./tool-result.js";

type ToolRegistrar = <Shape extends z.ZodRawShape>(name: ScarletToolName, description: string, shape: Shape,
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<ToolResult>) => void;

interface GraphicsDeps {
  tool: ToolRegistrar;
  client: ScarletClient;
  projectId: string;
  task?: Task;
  author: Author;
  caps: Pick<AgentCapabilities, "files" | "images" | "shell">;
  /** A file in the task artifact directory. */
  readArtifact(path: string): Promise<Buffer<ArrayBuffer>>;
  /** Write a file there, and say where it went. */
  writeArtifact(path: string, data: Buffer): Promise<string>;
  getProject(): Promise<{ project: Pick<ProjectDetail["project"], "settings"> }>;
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
    `Draw a motion graphic from a web page and add it to the project's media as a graphic with alpha, to place over the picture with timeline_propose (addClip of the returned mediaId on a video track above the footage; its clip can be shorter than the graphic). Send the page as html: a complete HTML document drawn at the project's size (or width/height) on a transparent background, so use viewport units or the frame's pixels. Time: CSS animations, transitions and Web Animations are paused and set to each frame's time, SVG animations too; a page that keeps its own clock defines window.scarletSeek(seconds), called before each frame, which may return a promise. Fonts load from @font-face rules or installed fonts. Link fonts and pictures by absolute path or file URL (an attachment's path works)${deps.caps.files ? " or, with path, by a path relative to the page" : ""}; Scarlet keeps them with the graphic. Scarlet keeps the page with the graphic too: to revise one, read it with graphic_get, change it and render again with basedOn, which carries its files over, then point the clip at the new mediaId (updateClip). Returns the mediaId, the page's path, the box the graphic covers at a few moments (fractions of the frame, left/top/right/bottom), errors the page raised and files it couldn't load${deps.caps.images ? ", and pictures of those moments over the edit at checkAt" : ""}. A page whose text asks for a font that isn't installed or loaded is not added: missingFonts names each, and installedFonts lists common families this machine has. When the editor named the font, in their words or the style guide, ask them with task_question whether they will add its file or which installed font to use; never substitute it yourself. A font only you chose: pick an installed one and render again.`,
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
    "attachment_read",
    `Read a file the editor attached to a request in this project, by its attachment id, or with styleGuide the project's style guide, when the prompt has a Style guide section (a project without one has nothing to read). Text comes back as text; ${deps.caps.images ? "a picture comes back as the picture, and a PDF as pictures of its pages (pages, up to 8 a call; default the first 6) with pageCount when the file says it" : "a picture or a PDF comes back as its name, size and path only"}. A font file comes back as its path, for an @font-face rule.`,
    {
      attachmentId: z.string().optional(),
      styleGuide: z.boolean().optional(),
      pages: z.array(z.number().int().positive()).max(8).optional().describe("PDF pages to read, from 1"),
    },
    async ({ attachmentId, styleGuide, pages }) => {
      if (!attachmentId === !styleGuide) return errorText("Name an attachment or the style guide.");
      const doc = await client.readDocument(deps.projectId,
        { attachmentId, styleGuide, ...(deps.caps.images && pages && { pages }), ...(!deps.caps.images && { pages: [] }) });
      const { text: body, pages: shots, image, ...about } = doc;
      const content: ToolResult["content"] = [{ type: "text", text: JSON.stringify({ ...about, ...(shots && deps.caps.images && { pagesShown: shots.map(p => p.page) }) }) }];
      if (body !== undefined) content.push({ type: "text", text: body });
      if (deps.caps.images && image) content.push({ type: "image", mimeType: image.mime, data: image.data });
      if (deps.caps.images) for (const shot of shots ?? []) content.push({ type: "image", mimeType: "image/jpeg", data: shot.jpeg });
      return { content };
    },
  );
}
