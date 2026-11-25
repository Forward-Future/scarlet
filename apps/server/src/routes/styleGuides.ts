import { parseMultipartRequest } from "@remix-run/multipart-parser/future";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { Hono } from "hono";
import { z } from "zod/v3";
import {
  CreateStyleGuideRequest,
  EditStyleGuideRequest,
  StyleGuideFromGraphicRequest,
  StyleGuidePreviewRenderRequest,
  TaskStyleGuideDraft,
  UpdateStyleGuideRequest,
  styleGuideEditTarget,
  type StyleGuideRecord,
} from "@scarlet/shared";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../errors.js";
import { serveOriginal } from "../files.js";
import { actorFor, agentName, logActivity, quote } from "../services/activity.js";
import { MAX_ATTACHMENT_BYTES, MAX_DOCUMENT_PAGES, mimeFor } from "../services/graphics.js";
import {
  createStyleGuide,
  createStyleGuideFromGraphic,
  deleteStyleGuide,
  findStyleGuideAsset,
  latestStyleGuideEdit,
  listStyleGuides,
  readStyleGuideAssetDocument,
  renderStyleGuidePreview,
  saveStyleGuideAsset,
  styleGuideEdits,
  styleGuidePreviewImagePath,
  styleGuidePreviewSource,
  updateStyleGuide,
} from "../services/styleGuides.js";
import { requestAttempt, requireActiveAttempt } from "../services/taskAttempt.js";
import { createTask, FINISHED_TASK, saveTask } from "../services/tasks.js";
import { jsonBody, multipartError, requireProjectHeader, requireScoped } from "./util.js";

export function styleGuideRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();

  const requireStyleGuide = (styleGuideId: string): StyleGuideRecord =>
    requireScoped(ctx.repos.styleGuides, "style guide", styleGuideId);

  r.get("/style-guides", (c) => {
    return c.json({ styleGuides: listStyleGuides(ctx) });
  });

  r.post("/style-guides", async (c) => {
    const body = await jsonBody(c, CreateStyleGuideRequest);
    const styleGuide = ctx.db.transaction(() => createStyleGuide(ctx, c.var.user, body), "immediate")();
    return c.json({ styleGuide }, 201);
  });

  r.post("/style-guides/from-graphic", async (c) => {
    const body = await jsonBody(c, StyleGuideFromGraphicRequest);
    requireProjectHeader(ctx, body.projectId);
    const styleGuide = await createStyleGuideFromGraphic(
      ctx,
      c.var.user,
      body,
      AbortSignal.any([ctx.shutdown, c.req.raw.signal]),
    );
    return c.json({ styleGuide }, 201);
  });

  r.get("/style-guides/:styleGuideId", (c) => {
    const styleGuide = requireStyleGuide(c.req.param("styleGuideId"));
    return c.json({ styleGuide, edits: styleGuideEdits(ctx, styleGuide.id) });
  });

  r.put("/style-guides/:styleGuideId", async (c) => {
    const id = c.req.param("styleGuideId");
    requireStyleGuide(id);
    const body = await jsonBody(c, UpdateStyleGuideRequest);
    const styleGuide = ctx.db.transaction(
      () => updateStyleGuide(ctx, c.var.user, requireStyleGuide(id), body),
      "immediate",
    )();
    return c.json({ styleGuide });
  });

  r.delete("/style-guides/:styleGuideId", (c) => {
    const id = c.req.param("styleGuideId");
    ctx.db.transaction(() => deleteStyleGuide(ctx, requireStyleGuide(id), c.var.user), "immediate")();
    return c.json({});
  });

  // Design or update a style guide in chat. Like skill edits, borrows the most recent live project to run on a host
  // while staying completely out of that project's conversation and queue.
  r.post("/style-guides/:styleGuideId/edit", async (c) => {
    const id = c.req.param("styleGuideId");
    const body = await jsonBody(c, EditStyleGuideRequest);
    const user = c.var.user;
    const task = ctx.db.transaction(() => {
      const guide = requireStyleGuide(id);
      const running = latestStyleGuideEdit(ctx, guide.id);
      if (running && !FINISHED_TASK.has(running.state)) {
        throw conflict("style_guide_edit_running", "Scarlet is already updating this style guide.");
      }
      const home = ctx.db
        .prepare("SELECT id FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1")
        .get() as { id: string } | undefined;
      if (!home) throw conflict("no_project", "Create a project first. Scarlet runs its requests from one.");
      const known = new Set(guide.assets.map(a => a.id));
      const attachments = body.attachments?.filter(a => known.has(a.id));
      if (!body.prompt && !attachments?.length) {
        throw badRequest("empty_prompt", "Describe a look or attach a file.");
      }
      const task = createTask(ctx, {
        projectId: home.id,
        kind: "style_guide_edit",
        agent: body.agent ?? ctx.settings().defaultAgent,
        model: body.model,
        effort: body.effort,
        fast: body.fast,
        serviceTier: body.serviceTier,
        instruction: body.prompt,
        context: {
          styleGuideId: guide.id,
          ...(attachments?.length && { attachments }),
        },
        createdBy: actorFor(user),
      });
      const detail = body.prompt
        ? quote(body.prompt, 120)
        : quote(attachments!.map(a => a.name).join(", "), 120);
      logActivity(ctx, {
        projectId: null,
        actor: actorFor(user),
        type: "style_guide.edit_requested",
        summary: `${user.name} asked ${agentName(task.agent)} to update @${guide.name}: ${detail}`,
        data: { styleGuideId: guide.id, taskId: task.id },
      });
      return task;
    }, "immediate")();
    return c.json({ task }, 201);
  });

  // Save updated description/instructions from an authorized style_guide_edit task.
  r.post("/projects/:id/tasks/:taskId/style-guide-edit", async (c) => {
    const body = await jsonBody(c, TaskStyleGuideDraft.extend({ styleGuideId: z.string(), hostId: z.string() }).strict());
    const projectId = c.req.param("id");
    const styleGuide = ctx.db.transaction(() => {
      const task = ctx.repos.tasks.get(c.req.param("taskId"));
      if (!task || task.projectId !== projectId) throw notFound("style guide task");
      const target = styleGuideEditTarget(task, projectId);
      if (!target || task.createdBy.id !== c.var.user.id || target.styleGuideId !== body.styleGuideId || target.hostId !== body.hostId) {
        throw forbidden("This task is not authorized to change this style guide.");
      }
      requireActiveAttempt(ctx, requestAttempt(c.req.raw), projectId, task.id);
      const guide = requireStyleGuide(target.styleGuideId);
      const saved = updateStyleGuide(
        ctx,
        c.var.user,
        guide,
        {
          ...(body.description !== undefined && { description: body.description }),
          instructions: body.instructions,
        },
        { author: { type: "agent", id: task.agent, name: task.agent, model: task.model } },
      );
      saveTask(ctx, { ...task, resultStyleGuideId: saved.id });
      return saved;
    }, "immediate")();
    return c.json({ styleGuide });
  });

  // -- assets ---------------------------------------------------------------

  r.post("/style-guides/:styleGuideId/assets", async (c) => {
    const id = c.req.param("styleGuideId");
    requireStyleGuide(id);
    const tooLarge = () => new HttpError(413, "attachment_too_large", `A file can be up to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
    if (c.req.header("content-type")?.startsWith("application/json")) {
      const { path } = await jsonBody(c, z.object({ path: z.string().min(1).max(4096) }));
      const info = isAbsolute(path) ? await stat(path).catch(() => null) : null;
      if (!info?.isFile()) throw notFound("file");
      if (info.size > MAX_ATTACHMENT_BYTES) throw tooLarge();
      const saved = await saveStyleGuideAsset(ctx, id, basename(path), createReadStream(path), mimeFor(path), c.req.raw.signal);
      return c.json(saved, 201);
    }
    if (Number(c.req.header("content-length")) > MAX_ATTACHMENT_BYTES + 64 * 1024) throw tooLarge();
    try {
      for await (const part of parseMultipartRequest(c.req.raw, { maxFileSize: MAX_ATTACHMENT_BYTES, maxParts: 8 })) {
        if (part.name !== "file" || !part.isFile) continue;
        const saved = await saveStyleGuideAsset(ctx, id, part.filename || "asset", part, part.mediaType, c.req.raw.signal);
        return c.json(saved, 201);
      }
    } catch (error) {
      multipartError(error, { tooLarge, invalid: () => badRequest("bad_upload", "Incomplete or invalid upload. Please try again.") });
    }
    throw badRequest("missing_file", "multipart field `file` is required");
  });

  r.get("/style-guides/:styleGuideId/assets/:assetId", async (c) => {
    const id = c.req.param("styleGuideId");
    requireStyleGuide(id);
    const found = await findStyleGuideAsset(ctx, id, c.req.param("assetId"));
    if (!found) throw notFound("style guide asset");
    const contentType = found.asset.mime ?? "application/octet-stream";
    const active = /^image\/svg\+xml|^text\/html/i.test(contentType);
    const res = await serveOriginal(c.req.raw, found.path, {
      contentType,
      cacheControl: "private, no-cache",
      ...(active && { downloadName: found.asset.name }),
    });
    if (active) res.headers.set("Content-Security-Policy", "sandbox");
    return res;
  });

  r.post("/style-guides/:styleGuideId/assets/:assetId/read", async (c) => {
    const id = c.req.param("styleGuideId");
    requireStyleGuide(id);
    const body = await jsonBody(c, z.object({ pages: z.array(z.number().int().positive()).max(MAX_DOCUMENT_PAGES).optional() }));
    const doc = await readStyleGuideAssetDocument(
      ctx,
      id,
      c.req.param("assetId"),
      body.pages,
      AbortSignal.any([ctx.shutdown, c.req.raw.signal]),
    );
    return c.json(doc);
  });

  // -- live 16:9 visual preview --------------------------------------------

  r.post("/style-guides/:styleGuideId/preview", async (c) => {
    const id = c.req.param("styleGuideId");
    requireStyleGuide(id);
    const body = await jsonBody(c, StyleGuidePreviewRenderRequest, 1024 * 1024);
    const result = await renderStyleGuidePreview(
      ctx,
      id,
      body,
      AbortSignal.any([ctx.shutdown, c.req.raw.signal]),
    );
    return c.json(result);
  });

  r.get("/style-guides/:styleGuideId/preview", async (c) => {
    const id = c.req.param("styleGuideId");
    requireStyleGuide(id);
    const path = styleGuidePreviewImagePath(ctx, id);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw notFound("style guide preview");
    return serveOriginal(c.req.raw, path, {
      contentType: "image/png",
      cacheControl: "private, no-cache",
    });
  });

  r.get("/style-guides/:styleGuideId/preview/source", async (c) => {
    const id = c.req.param("styleGuideId");
    return c.json(await styleGuidePreviewSource(ctx, id, AbortSignal.any([ctx.shutdown, c.req.raw.signal])));
  });

  return r;
}
