import { MaxFileSizeExceededError, MaxPartsExceededError, MaxTotalSizeExceededError, MultipartParseError } from "@remix-run/multipart-parser/future";
import type { Context } from "hono";
import type { ZodTypeAny, z } from "zod/v3";
import type { Project } from "@scarlet/timeline";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { badRequest, HttpError, notFound } from "../errors.js";

/**
 * Rethrow what went wrong reading a multipart form as the caller's answer: over its size limit is `tooLarge()`, a broken
 * form or one with too many parts is `invalid()` (or `tooManyParts()` when given). Errors already meant for the caller
 * pass through, and anything else is rethrown as it was.
 */
export function multipartError(error: unknown, answers: { tooLarge: () => HttpError; invalid: () => HttpError; tooManyParts?: () => HttpError }): never {
  if (error instanceof MaxFileSizeExceededError || error instanceof MaxTotalSizeExceededError) throw answers.tooLarge();
  if (error instanceof MaxPartsExceededError) throw (answers.tooManyParts ?? answers.invalid)();
  if (error instanceof MultipartParseError) throw answers.invalid();
  throw error;
}

/** Whole timeline replacements and OTIO imports carry clips, keyframes and per-clip metadata. */
export const TIMELINE_JSON_BYTES = 32 * 1024 * 1024;

/** Count actual bytes even when a client supplies a length. Media uploads use their own streaming reader. */
export async function jsonBody<S extends ZodTypeAny>(c: Context<AppEnv>, schema: S, maxBytes = 2 * 1024 * 1024): Promise<z.output<S>> {
  const tooLarge = () => new HttpError(413, "json_too_large", `JSON request exceeds the ${maxBytes}-byte limit.`);
  if (Number(c.req.header("content-length")) > maxBytes) throw tooLarge();
  const reader = c.req.raw.body?.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = "";
  if (reader) {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          void reader.cancel().catch(() => {});
          throw tooLarge();
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
  let raw: unknown;
  if (!text.trim()) raw = {};
  else {
    try {
      raw = JSON.parse(text);
    } catch {
      throw badRequest("bad_json", "request body is not valid JSON");
    }
  }
  return schema.parse(raw);
}

/** Load a project (404 when missing). */
export function requireProject(ctx: Ctx, projectId: string): Project {
  const project = ctx.repos.projects.get(projectId);
  if (!project) throw notFound(`project ${projectId}`);
  return project;
}

/** Load a source in a live project (404 when missing, trashed or in another project). */
export function requireMedia(ctx: Ctx, mediaId: string, projectId?: string) {
  const media = ctx.repos.projects.getMedia(mediaId);
  if (!media || (projectId !== undefined && media.projectId !== projectId) ||
    !ctx.db.prepare("SELECT 1 FROM projects WHERE id = ? AND deleted_at IS NULL").get(media.projectId)) throw notFound(`media ${mediaId}`);
  return media;
}

/** List and metadata routes only need the header, regardless of how much footage is in the project. */
export function requireProjectHeader(ctx: Ctx, projectId: string): Omit<Project, "media"> {
  const project = ctx.repos.projects.header(projectId);
  if (!project) throw notFound(`project ${projectId}`);
  return project;
}

export function numberParam(value: string | undefined, name: string, fallback?: number): number {
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw badRequest("missing_param", `query parameter "${name}" is required`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest("bad_param", `query parameter "${name}" must be a number`);
  return n;
}

/** A number the caller may leave out. One given empty is refused, as a required one is. */
export function optionalNumberParam(value: string | undefined, name: string): number | undefined {
  return value === undefined ? undefined : numberParam(value, name);
}

export function formString(v: string | File | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function formFile(v: string | File | undefined): File | undefined {
  return v instanceof File ? v : undefined;
}
