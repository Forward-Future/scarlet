import { rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { isMultipartRequest, MaxFileSizeExceededError, MaxPartsExceededError, MaxTotalSizeExceededError,
  MultipartParseError, parseMultipartRequest } from "@remix-run/multipart-parser/future";
import { Hono } from "hono";
import { z } from "zod/v3";
import { CreateNoteRequest, ModelTuning, UpdateNoteRequest } from "@scarlet/shared";
import { Author, newId, Note } from "@scarlet/timeline";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { badRequest, HttpError, notFound } from "../errors.js";
import { actorFor } from "../services/activity.js";
import { createNote } from "../services/notes.js";
import { requestAttempt, requireLocalPauseTarget, requireProjectEditAttempt } from "../services/taskAttempt.js";
import { notify } from "../services/notify.js";
import { getTranscriptionProvider, spokenText } from "../transcribe/index.js";
import { formFile, formString, jsonBody, numberParam, requireProjectHeader } from "./util.js";

const NO_SPEECH = "Didn’t catch any words. Try again, or type it.";
const NOT_CONFIGURED = "To use voice, select and configure OpenAI or local whisper.cpp transcription in Settings.";

/** Count the incoming bytes before buffering a voice command or parsing its embedded metadata. */
export async function voiceForm(request: Request, maxBytes = 64 * 1024 * 1024) {
  const fields: Record<string, string | File> = Object.create(null);
  if (!isMultipartRequest(request)) return fields;
  const tooLarge = () => new HttpError(413, "voice_too_large", "The voice recording is too large. Send a shorter recording.");
  if (Number(request.headers.get("content-length")) > maxBytes) throw tooLarge();
  try {
    for await (const part of parseMultipartRequest(request, { maxTotalSize: maxBytes, maxFileSize: maxBytes, maxParts: 32 })) {
      if (part.isFile) {
        if (part.name === "audio") fields.audio = new File([await part.bytes()], part.filename || "voice.webm", { type: part.mediaType });
      } else if (part.name) {
        let size = 0;
        const chunks: Uint8Array[] = [];
        for await (const chunk of part) {
          size += chunk.byteLength;
          if (size > 65536) throw new HttpError(413, "voice_metadata_too_large", "Voice note metadata exceeds 64 KiB.");
          chunks.push(chunk);
        }
        fields[part.name] = Buffer.concat(chunks).toString("utf8");
      }
    }
  } catch (error) {
    if (error instanceof MaxFileSizeExceededError || error instanceof MaxTotalSizeExceededError || error instanceof MaxPartsExceededError) throw tooLarge();
    if (error instanceof MultipartParseError) throw badRequest("bad_voice_form", "Invalid voice recording form.");
    throw error;
  }
  return fields;
}

export function noteRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();

  function requireNote(noteId: string, projectId?: string) {
    const note = ctx.repos.notes.get(noteId);
    if (!note || (projectId !== undefined && note.projectId !== projectId)) throw notFound(`note ${noteId}`);
    return note;
  }

  r.post("/projects/:id/notes", async (c) => {
    const body = await jsonBody(c, CreateNoteRequest);
    const result = await createNote(ctx, c.var.user, c.req.param("id"), body, c.req.raw.signal);
    return c.json(result, 201);
  });

  r.post("/projects/:id/notes/voice", async (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const form = await voiceForm(c.req.raw);
    const audio = formFile(form.audio);
    if (!audio) throw badRequest("missing_audio", "multipart field `audio` is required");
    const time = numberParam(formString(form.time), "time");
    const endRaw = formString(form.end);
    const end = endRaw ? numberParam(endRaw, "end") : undefined;
    const version = formString(form.version);
    const assignTo = formString(form.assignTo);
    const tuning = ModelTuning.safeParse({ effort: formString(form.effort), serviceTier: formString(form.serviceTier) });
    if (!tuning.success) throw badRequest("invalid_model_options", "Invalid model options");
    const changeId = formString(form.changeId);
    let clipIds: string[] | undefined;
    const clipRaw = formString(form.clipIds);
    if (clipRaw) {
      if (clipRaw.trimStart().startsWith("[")) {
        try { clipIds = z.array(z.string()).parse(JSON.parse(clipRaw)); }
        catch { throw badRequest("invalid_clip_ids", "Voice note clip IDs must be a list of strings."); }
      } else clipIds = clipRaw.split(",").map((s) => s.trim()).filter(Boolean);
    }
    ctx.paths.ensureProject(project.id);
    const noteId = newId("note");
    const ext = extname(audio.name || "").toLowerCase() || ".webm";
    const audioPath = `${noteId}${ext}`;
    const abs = join(ctx.paths.notes(project.id), audioPath);
    await writeFile(abs, Buffer.from(await audio.arrayBuffer()));

    let text = "[voice note — transcription not configured]";
    let voiceTranscript: string | undefined;
    // Why there is no transcript, for a recording that was meant as a request.
    let unheard = badRequest("transcription_not_configured", NOT_CONFIGURED);
    const provider = getTranscriptionProvider(ctx);
    if (provider) {
      try {
        const result = await provider.transcribe({ path: abs, tmpDir: ctx.paths.tmp });
        voiceTranscript = spokenText(result.segments);
        if (voiceTranscript) text = voiceTranscript;
      } catch (e) {
        ctx.log(`[voice-note] transcription failed: ${(e as Error).message}`);
        text = `[voice note — transcription failed: ${(e as Error).message}]`;
        // The provider says what went wrong in a sentence of its own.
        unheard = badRequest("transcription_failed", (e as Error).message);
      }
      // A silent recording would send the agent a request with nothing in it.
      if (voiceTranscript === "") {
        await rm(abs, { force: true });
        throw badRequest("no_speech", NO_SPEECH);
      }
    }
    // The placeholder stands in for the words on a note the editor keeps. Sent to an agent it would start a run on
    // a request that says nothing, so a recording with no transcript is refused instead.
    if (voiceTranscript === undefined && assignTo) {
      await rm(abs, { force: true });
      throw unheard;
    }
    let result: Awaited<ReturnType<typeof createNote>>;
    try {
      result = await createNote(ctx, c.var.user, project.id, { version, time, end, clipIds, text, voiceTranscript, audioPath, assignTo, changeId, ...tuning.data }, c.req.raw.signal);
    } catch (error) {
      // No note refers to the recording, so nothing would ever remove it.
      await rm(abs, { force: true });
      throw error;
    }
    return c.json(result, 201);
  });

  /**
   * Speech to text for voice-driven actions (revise a change, answer an agent,
   * give an instruction). The audio is transcribed and discarded.
   */
  r.post("/speech", async (c) => {
    const form = await voiceForm(c.req.raw);
    const audio = formFile(form.audio);
    if (!audio) throw badRequest("missing_audio", "multipart field `audio` is required");
    const provider = getTranscriptionProvider(ctx);
    if (!provider) throw badRequest("transcription_not_configured", NOT_CONFIGURED);
    const ext = extname(audio.name || "").toLowerCase() || ".webm";
    const abs = join(ctx.paths.tmp, `${newId("speech")}${ext}`);
    await writeFile(abs, Buffer.from(await audio.arrayBuffer()));
    try {
      const result = await provider.transcribe({ path: abs, tmpDir: ctx.paths.tmp });
      const text = spokenText(result.segments);
      if (!text) throw badRequest("no_speech", NO_SPEECH);
      return c.json({ text });
    } finally {
      await rm(abs, { force: true });
    }
  });

  r.get("/projects/:id/notes", (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const state = c.req.query("state");
    const notes = state
      ? ctx.repos.notes.select("project_id = ? AND state = ?", [project.id, Note.shape.state.parse(state)], "created_at DESC")
      : ctx.repos.notes.select("project_id = ?", [project.id], "created_at DESC");
    return c.json({ notes });
  });

  r.on("PATCH", ["/notes/:noteId", "/projects/:projectId/notes/:noteId"], async (c) => {
    const body = await jsonBody(c, UpdateNoteRequest);
    const saved = ctx.db.transaction(() => {
      const note = requireNote(c.req.param("noteId"), c.req.param("projectId"));
      requireLocalPauseTarget(requireProjectEditAttempt(ctx, requestAttempt(c.req.raw), note.projectId), note.id);
      return ctx.repos.notes.put({ ...note, ...body, updatedAt: now() });
    }, "immediate")();
    ctx.bus.publish({ type: "note.updated", projectId: saved.projectId, note: saved });
    return c.json({ note: saved });
  });

  // Agent → human reply. It is kept beside the note, under the name of whoever gave it: an agent works through the
  // editor's own sign-in, so the reply says which agent it is. The note's text stays the editor's words, which is
  // what the request it was sent as is matched by.
  r.on("POST", ["/notes/:noteId/reply", "/projects/:projectId/notes/:noteId/reply"], async (c) => {
    const body = await jsonBody(c, z.object({ text: z.string().min(1), author: Author.optional() }));
    const author = body.author ?? actorFor(c.var.user);
    const who = author.name;
    const saved = ctx.db.transaction(() => {
      const note = requireNote(c.req.param("noteId"), c.req.param("projectId"));
      requireLocalPauseTarget(requireProjectEditAttempt(ctx, requestAttempt(c.req.raw), note.projectId), note.id);
      return ctx.repos.notes.put({ ...note, replies: [...(note.replies ?? []), { text: body.text, author, createdAt: now() }], updatedAt: now() });
    }, "immediate")();
    ctx.bus.publish({ type: "note.updated", projectId: saved.projectId, note: saved });
    notify(ctx, `${who} replied to your note`, { body: body.text, projectId: saved.projectId, link: `/p/${encodeURIComponent(saved.projectId)}?note=${encodeURIComponent(saved.id)}` });
    return c.json({ note: saved });
  });

  return r;
}
