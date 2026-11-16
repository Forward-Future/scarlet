/**
 * The motion-graphics tools: drawing a graphic from a web page, the editor's library of templates, the project's style
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
  caps: Pick<AgentCapabilities, "files" | "images">;
  /** A file in the task artifact directory. */
  readArtifact(path: string): Promise<Buffer<ArrayBuffer>>;
  getProject(): Promise<ProjectDetail>;
}

/**
 * The files a page links to by a path relative to it, each once, as a browser reads the link: percent-decoded, and as
 * written when it isn't valid percent-encoding. Links with a scheme and absolute paths are left out.
 */
export function relativeLinks(html: string): string[] {
  const links = new Set<string>();
  for (const match of html.matchAll(/(?:\b(?:src|href)\s*=\s*["']|url\(\s*["']?)([^"')\s>#?]+)/gi)) {
    let link = match[1]!;
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
    `Draw a motion graphic from a web page and add it to the project's media as a graphic with alpha, to place over the picture with timeline_propose (addClip of the returned mediaId on a video track above the footage; its clip can be shorter than the graphic). Send the page as html: a complete HTML document drawn at the project's size (or width/height) on a transparent background, so use viewport units or the frame's pixels. Or fill a saved template with template and fields. Time: CSS animations, transitions and Web Animations are paused and set to each frame's time, SVG animations too; a page that keeps its own clock defines window.scarletSeek(seconds), called before each frame, which may return a promise. Fonts load from @font-face rules or installed fonts. Link fonts and pictures by absolute path or file URL (an attachment's path works)${deps.caps.files ? " or, with path, by a path relative to the page" : ""}; Scarlet keeps them with the graphic. Scarlet keeps the page with the graphic too: to revise one, read it with graphic_get, change it and render again with basedOn, which carries its files and template over, then point the clip at the new mediaId (updateClip). Returns the mediaId, the page's path, the box the graphic covers at a few moments (fractions of the frame, left/top/right/bottom), errors the page raised and files it couldn't load${deps.caps.images ? ", and pictures of those moments over the edit at checkAt" : ""}. A page whose text asks for a font that isn't installed or loaded is not added: missingFonts names each, and installedFonts lists common families this machine has. When the editor named the font, in their words or the style guide, ask them with task_question whether they will add its file or which installed font to use; never substitute it yourself. A font only you chose: pick an installed one and render again.`,
    {
      html: z.string().min(1).max(500_000).optional().describe("The page, a complete HTML document"),
      ...(deps.caps.files ? { path: z.string().optional().describe("Or an HTML file in the task artifact directory") } : {}),
      template: z.string().min(1).optional().describe("Fill this saved template instead: its id or name"),
      fields: z.record(z.string()).optional().describe("The template's field values, by field name"),
      basedOn: z.string().optional().describe("mediaId of the graphic this revises"),
      duration: z.number().positive().max(600).optional().describe("Seconds; default the template's, or the revised graphic's"),
      width: z.number().int().positive().max(8192).optional(),
      height: z.number().int().positive().max(8192).optional(),
      fps: z.number().positive().max(120).optional(),
      name: z.string().trim().min(1).max(200).optional().describe("How the media list names it"),
      checkAt: z.number().nonnegative().optional().describe("Timeline seconds where the graphic will start, on the head version; default the editor's playhead"),
      checkTimes: z.array(z.number().nonnegative()).max(6).optional().describe("Seconds into the graphic to check; default three spread through it"),
    },
    async (args) => {
      const { html, template, fields, basedOn, duration, width, height, fps, name, checkAt, checkTimes } = args;
      const path = (args as { path?: string }).path;
      if ([html, path, template].filter(v => v !== undefined).length > 1) return errorText("Send one of html, path or template.");
      const page = path ? await pageFromArtifact(path) : undefined;
      const context = deps.task?.context;
      const playhead = context && !context.mediaId ? context.time : undefined;
      const fd = new FormData();
      fd.append("options", JSON.stringify({
        template, fields, basedOn, duration, width, height, fps, name, checkTimes,
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
    "Read a graphic Scarlet drew: its page as it was drawn, where the page is, the files kept beside it (linked by those relative paths), its size, fps and duration, and the template and field values it was filled from. Revise it by changing the page and calling graphic_render with basedOn.",
    { mediaId: z.string().min(1) },
    async ({ mediaId }) => json(await client.graphic(deps.projectId, mediaId)),
  );

  tool(
    "template_list",
    "List the templates saved in the editor's library, for every project: id, kind, name (what the editor types after $), title and description, with a graphic's fields and a transition's movement. template_get reads one; timeline_transition puts a transition on joins.",
    {},
    async () => {
      const { templates } = await client.listTemplates();
      return json(templates.map(t => ({ id: t.id, kind: t.kind, name: t.name, title: t.title, description: t.description,
        ...(t.kind === "transition" ? { transition: t.transition } : { fields: t.fields }) })));
    },
  );

  tool(
    "template_get",
    "Read a saved template by id or name. A transition's is how it moves (timeline_transition puts it on joins). A graphic's is its page with a {{Field}} placeholder wherever a field's value goes, its fields, the sample values its preview shows, the frame it was designed in, its usual duration and the moment its preview shows. graphic_render with template and fields draws it.",
    { template: z.string().min(1).describe("Id or name") },
    async ({ template }) => {
      return json((await client.template(template)).template);
    },
  );

  tool(
    "template_save",
    `Save a graphic or a transition as a template in the editor's library, for every project, or replace the template with the same name. A transition sends transition (how the picture moves, as timeline_transition takes it) and no page or fields. A graphic's page has a {{Field}} placeholder wherever a field's value goes (the values are put in as text); fields lists them in the order the editor reads them, and sample gives each a value for the template's preview, which Scarlet draws at previewAt. basedOn names a graphic of this project whose files (fonts, pictures) the page links to, and absolute links to files of this project are kept with the template. The editor picks a template by typing $ and its name. Returns the template's id${deps.caps.images ? " and its preview" : ""}, and any font the preview couldn't find.`,
    {
      name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(64).describe("Lowercase words joined by hyphens, e.g. lower-third"),
      title: z.string().trim().min(1).max(120),
      description: z.string().max(2000).default("").describe("When to use it, in a line"),
      fields: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
      html: z.string().min(1).max(500_000).optional(),
      ...(deps.caps.files ? { path: z.string().optional().describe("Or an HTML file in the task artifact directory") } : {}),
      sample: z.record(z.string()).default({}),
      transition: z.object({
        type: z.enum(["dissolve", "dip", "push", "slide", "whip"]),
        duration: z.number().finite().positive().max(10).describe("Seconds, centred on the join"),
        direction: z.enum(["left", "right", "up", "down"]).default("left"),
        color: z.string().optional().describe("dip: the colour it passes through"),
      }).optional(),
      basedOn: z.string().optional().describe("mediaId of the graphic it was made from"),
      duration: z.number().positive().max(600).optional().describe("Seconds a use lasts by default"),
      previewAt: z.number().nonnegative().optional().describe("Seconds into the graphic the preview shows; default halfway"),
    },
    async (args) => {
      if (args.transition) {
        if (args.html || (args as { path?: string }).path) return errorText("A transition template has no page: send transition alone.");
        const { template } = await client.saveTemplate({ name: args.name, title: args.title, description: args.description, fields: [], sample: {},
          transition: args.transition, projectId: deps.projectId });
        return json({ templateId: template.id, name: template.name, kind: template.kind, transition: template.transition });
      }
      const path = (args as { path?: string }).path;
      if (!args.html === !path) return errorText("Send the page as html or path.");
      const html = path ? (await deps.readArtifact(path)).toString("utf8") : args.html!;
      const project = await deps.getProject();
      const { template, missingFonts = [], problems = [], preview } = await client.saveTemplate({
        name: args.name, title: args.title, description: args.description, fields: args.fields, html, sample: args.sample,
        projectId: deps.projectId, basedOn: args.basedOn, duration: args.duration, previewAt: args.previewAt,
        width: project.project.settings.width, height: project.project.settings.height,
      });
      const content: ToolResult["content"] = [{ type: "text", text: JSON.stringify({ templateId: template.id, name: template.name, fields: template.fields,
        ...(missingFonts.length && { missingFonts }), ...(problems.length && { problems }) }) }];
      if (deps.caps.images && preview) content.push({ type: "image", mimeType: "image/png", data: preview });
      return { content };
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
