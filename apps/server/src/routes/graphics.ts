import { parseMultipartRequest } from "@remix-run/multipart-parser/future";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { capturePage, findChrome } from "@scarlet/render";
import { Hono } from "hono";
import { z } from "zod/v3";
import { GraphicRenderRequest, SaveStyleGuideRequest } from "@scarlet/shared";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { badRequest, HttpError, notFound } from "../errors.js";
import { serveFile } from "../files.js";
import { requestAttempt, requireLocalPauseTarget, requireProjectEditAttempt } from "../services/taskAttempt.js";
import { assetPath, findAttachment, mimeFor, graphicSource, MAX_ATTACHMENT_BYTES, MAX_DOCUMENT_PAGES, readDocument, removeStyleGuide, renderProjectGraphic,
  saveAttachment, saveStyleGuide } from "../services/graphics.js";
import { jsonBody, multipartError, requireProject, requireProjectHeader } from "./util.js";

const WebCaptureRequest = z.object({
  url: z.string().trim().max(4096),
  width: z.number().int().min(320).max(3840).optional(),
  height: z.number().int().min(240).max(4000).optional(),
  fullPage: z.boolean().optional(),
});

/** Whether an address is the machine itself, its local network or a link-local one, as text or as a resolved IP. */
function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase();
    if (v6 === "::1" || v6 === "::" || v6.startsWith("fe80:") || v6.startsWith("fc") || v6.startsWith("fd")) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    return mapped ? privateAddress(mapped[1]!) : false;
  }
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/** The address as Chrome should open it: http or https, on a host that resolves only to public addresses. */
async function publicWebAddress(raw: string): Promise<string> {
  let url: URL;
  try { url = new URL(raw); } catch { throw badRequest("bad_url", "Give the page's full web address, starting with https://."); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw badRequest("bad_url", "Only pages on the web (http or https) can be captured.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw badRequest("bad_url", "Only public pages on the web can be captured.");
  const addresses = isIP(host) ? [host] : await lookup(host, { all: true }).then(all => all.map(a => a.address), () => {
    throw badRequest("bad_url", `${host} doesn't resolve to an address.`);
  });
  if (addresses.some(privateAddress)) throw badRequest("bad_url", "Only public pages on the web can be captured.");
  return url.href;
}

export function graphicRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();

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
    const type = found.attachment.mime ?? "application/octet-stream";
    const passive = type.startsWith("audio/") || type.startsWith("video/") ||
      ["image/jpeg", "image/png", "image/gif", "image/webp", "image/x-icon"].includes(type);
    const response = serveFile(c.req.raw, found.path, { contentType: passive ? type : "application/octet-stream", cacheControl: "private, no-cache" });
    response.headers.set("Content-Security-Policy", "sandbox; default-src 'none'");
    response.headers.set("X-Content-Type-Options", "nosniff");
    if (!passive) response.headers.set("Content-Disposition", "attachment");
    return response;
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
    const result = await ctx.track(renderProjectGraphic(ctx, project, { options, html, assets, taskId: attempt?.taskId || undefined }, c.var.user, check, signal), project.id);
    return c.json(result, result.media ? 201 : 200);
  });

  // -- pages from the web ----------------------------------------------------

  // A page on the web drawn in Scarlet's own Chrome, outside the agent's sandbox, where Chrome can't start or reach the
  // web. Only public web addresses: the browser is the engine's, so the engine's own address and the machine's network
  // stay out of reach, and so does every file.
  r.post("/projects/:id/web-captures", async (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const body = await jsonBody(c, WebCaptureRequest);
    const url = await publicWebAddress(body.url);
    const signal = AbortSignal.any([ctx.projectSignal(project.id), c.req.raw.signal]);
    const shot = await ctx.track(capturePage({ url, width: body.width ?? 1280, height: body.height ?? 800, fullPage: body.fullPage,
      chromePath: findChrome(undefined, ctx.options.env ?? process.env), signal }), project.id).catch((error: Error) => {
      if (error.name === "AbortError") throw error;
      throw new HttpError(502, "capture_failed", error.message);
    });
    // A redirect to the machine's own network leaves nothing behind.
    await publicWebAddress(shot.url);
    return c.json({ png: shot.png.toString("base64"), title: shot.title, url: shot.url, text: shot.text, width: shot.width, height: shot.height, headings: shot.headings });
  });

  r.get("/projects/:id/graphics/:mediaId", async (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    return c.json(await graphicSource(ctx, project.id, c.req.param("mediaId")));
  });

  return r;
}
