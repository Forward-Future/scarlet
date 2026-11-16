import { parseMultipartRequest } from "@remix-run/multipart-parser/future";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { Hono } from "hono";
import { z } from "zod/v3";
import { GraphicRenderRequest, SaveStyleGuideRequest, SaveTemplateRequest } from "@scarlet/shared";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { badRequest, HttpError, notFound } from "../errors.js";
import { serveFile } from "../files.js";
import { requestAttempt, requireLocalPauseTarget, requireProjectEditAttempt } from "../services/taskAttempt.js";
import { assetPath, deleteTemplate, findAttachment, findTemplate, mimeFor, graphicSource, MAX_ATTACHMENT_BYTES, MAX_DOCUMENT_PAGES, readDocument, removeStyleGuide, renderProjectGraphic,
  saveAttachment, saveStyleGuide, saveTemplate, templatePreviewPath, templateSummary } from "../services/graphics.js";
import { jsonBody, multipartError, requireProject, requireProjectHeader } from "./util.js";

export function graphicRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();

  function requireTemplate(idOrName: string) {
    const template = findTemplate(ctx, idOrName);
    if (!template) throw notFound(`template ${idOrName}`);
    return template;
  }

  // -- templates (library-wide) ----------------------------------------------

  r.get("/templates", (c) => c.json({ templates: ctx.repos.templates.select("1=1", [], "name ASC").map(templateSummary) }));

  r.get("/templates/:templateId", (c) => c.json({ template: requireTemplate(c.req.param("templateId")) }));

  r.get("/templates/:templateId/preview", (c) => {
    const template = requireTemplate(c.req.param("templateId"));
    // The address changes with previewVersion, so the image can be kept as long as the client likes.
    return serveFile(c.req.raw, templatePreviewPath(ctx, template), { contentType: "image/png", cacheControl: "private, max-age=31536000, immutable" });
  });

  /** A run may change the library's templates only while it is live and allowed to change its project. */
  function requireTemplateAttempt(request: Request) {
    const attempt = requestAttempt(request);
    if (!attempt) return undefined;
    const task = ctx.repos.tasks.get(attempt.taskId);
    if (!task) throw badRequest("invalid_task", "Unknown task.");
    return requireProjectEditAttempt(ctx, attempt, task.projectId);
  }

  r.post("/templates", async (c) => {
    const body = await jsonBody(c, SaveTemplateRequest, 4 * 1024 * 1024);
    const task = requireTemplateAttempt(c.req.raw);
    if (task && body.projectId && body.projectId !== task.projectId) throw badRequest("invalid_task", "Task must belong to this project.");
    const saved = await saveTemplate(ctx, body, c.var.user, c.req.raw.signal);
    return c.json(saved, 201);
  });

  r.delete("/templates/:templateId", async (c) => {
    const template = requireTemplate(c.req.param("templateId"));
    requireTemplateAttempt(c.req.raw);
    await deleteTemplate(ctx, template, c.var.user);
    return c.json({});
  });

  // -- attachments ----------------------------------------------------------

  r.post("/projects/:id/attachments", async (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    requireProjectEditAttempt(ctx, requestAttempt(c.req.raw), project.id);
    ctx.paths.ensureProject(project.id);
    const tooLarge = () => new HttpError(413, "attachment_too_large", `An attachment can be up to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
    // The desktop app's own drops arrive as paths, as /media/import's do: the engine copies the file in.
    if (c.req.header("content-type")?.startsWith("application/json")) {
      const { path } = await jsonBody(c, z.object({ path: z.string().min(1).max(4096) }));
      const info = isAbsolute(path) ? await stat(path).catch(() => null) : null;
      if (!info?.isFile()) throw notFound("file");
      if (info.size > MAX_ATTACHMENT_BYTES) throw tooLarge();
      const attachment = await saveAttachment(ctx, project.id, basename(path), createReadStream(path), mimeFor(path), c.req.raw.signal);
      return c.json({ attachment }, 201);
    }
    if (Number(c.req.header("content-length")) > MAX_ATTACHMENT_BYTES + 64 * 1024) throw tooLarge();
    try {
      for await (const part of parseMultipartRequest(c.req.raw, { maxFileSize: MAX_ATTACHMENT_BYTES, maxParts: 8 })) {
        if (part.name !== "file" || !part.isFile) continue;
        const attachment = await saveAttachment(ctx, project.id, part.filename || "attachment", part, part.mediaType, c.req.raw.signal);
        return c.json({ attachment }, 201);
      }
    } catch (error) {
      multipartError(error, { tooLarge, invalid: () => badRequest("bad_upload", "Incomplete or invalid upload. Please try again.") });
    }
    throw badRequest("missing_file", "multipart field `file` is required");
  });

  r.get("/projects/:id/attachments/:attachmentId", async (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const found = await findAttachment(ctx, project.id, c.req.param("attachmentId"));
    if (!found) throw notFound("attachment");
    return serveFile(c.req.raw, found.path, { contentType: found.attachment.mime ?? "application/octet-stream", cacheControl: "private, no-cache" });
  });

  r.post("/projects/:id/documents/read", async (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const body = await jsonBody(c, z.object({ attachmentId: z.string().optional(), styleGuide: z.boolean().optional(),
      pages: z.array(z.number().int().positive()).max(MAX_DOCUMENT_PAGES).optional() }).refine(b => !!b.attachmentId !== !!b.styleGuide, "Name an attachment or the style guide."));
    return c.json(await readDocument(ctx, project.id, body, AbortSignal.any([ctx.projectSignal(project.id), c.req.raw.signal])));
  });

  // -- style guide ----------------------------------------------------------

  r.put("/projects/:id/style-guide", async (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    requireProjectEditAttempt(ctx, requestAttempt(c.req.raw), project.id);
    const body = await jsonBody(c, SaveStyleGuideRequest, 1024 * 1024);
    return c.json({ styleGuide: await saveStyleGuide(ctx, project.id, body, c.var.user) });
  });

  r.delete("/projects/:id/style-guide", async (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    requireProjectEditAttempt(ctx, requestAttempt(c.req.raw), project.id);
    await removeStyleGuide(ctx, project.id, c.var.user);
    return c.json({});
  });

  // -- graphics -------------------------------------------------------------

  r.post("/projects/:id/graphics", async (c) => {
    const project = requireProject(ctx, c.req.param("id"));
    const attempt = requestAttempt(c.req.raw);
    const check = () => requireLocalPauseTarget(requireProjectEditAttempt(ctx, attempt, project.id));
    check();
    let options: GraphicRenderRequest | undefined;
    let html: string | undefined;
    const assets = new Map<string, Buffer>();
    try {
      for await (const part of parseMultipartRequest(c.req.raw, { maxFileSize: 100 * 1024 * 1024, maxTotalSize: 110 * 1024 * 1024, maxParts: 80 })) {
        if (part.name === "options" && !part.isFile) {
          try { options = GraphicRenderRequest.parse(JSON.parse(await part.text())); }
          catch (error) { throw badRequest("bad_options", `Invalid graphic options: ${(error as Error).message.slice(0, 400)}`); }
        } else if (part.name === "html") {
          html = await part.text();
        } else if (part.name === "asset" && part.isFile) {
          assets.set(assetPath(part.filename || ""), Buffer.from(await part.bytes()));
        }
      }
    } catch (error) {
      multipartError(error, { tooLarge: () => new HttpError(413, "assets_too_large", "The graphic's files are too large together."),
        invalid: () => badRequest("bad_upload", "Incomplete or invalid upload.") });
    }
    if (!options) throw badRequest("missing_options", "multipart field `options` is required");
    const signal = AbortSignal.any([ctx.projectSignal(project.id), c.req.raw.signal]);
    const result = await ctx.track(renderProjectGraphic(ctx, project, { options, html, assets }, c.var.user, check, signal));
    return c.json(result, result.media ? 201 : 200);
  });

  r.get("/projects/:id/graphics/:mediaId", async (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    return c.json(await graphicSource(ctx, project.id, c.req.param("mediaId")));
  });

  return r;
}
