/**
 * Place a saved transcript's words again with the current aligner, without transcribing again.
 *
 * A transcript keeps the word times of the aligner that made it. When the aligner improves, its older transcripts
 * still hide what the new one shows: one placed "now." on 1.3 s of quiet, and no pause showed there (2026-11-15).
 * The words, their order and their indices stay; the saved times are the estimates the search starts from, and the
 * recording's saved emissions make it a search, not an inference. A transcript already on this aligner is left alone.
 */
import { join } from "node:path";
import { newId, type Transcript } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { alignmentVersion, alignsLanguage, alignTranscript } from "../transcribe/wordAlign.js";
import { emissionStore } from "./recordingAudio.js";

export type Realigned = { state: "current" | "unavailable"; reason?: string } | { state: "realigned"; transcriptId: string; words: number; moved: number };

/** The transcript a recording reads: the linked one, else its latest. */
function linked(ctx: Ctx, projectId: string, mediaId: string): Transcript | undefined {
  const media = ctx.repos.projects.getMedia(mediaId);
  const id = media?.transcriptId ?? (ctx.db.prepare("SELECT id FROM transcripts WHERE media_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(mediaId, projectId) as { id: string } | undefined)?.id;
  return id ? ctx.repos.transcripts.get(id) ?? undefined : undefined;
}

export async function realignTranscript(ctx: Ctx, projectId: string, mediaId: string, signal: AbortSignal): Promise<Realigned> {
  const media = ctx.repos.projects.getMedia(mediaId);
  const original = linked(ctx, projectId, mediaId);
  if (!media || media.projectId !== projectId || !original) return { state: "unavailable", reason: "This recording has no transcript." };
  if (original.aligning) return { state: "unavailable", reason: "This transcript is still being aligned." };
  if (!alignsLanguage(original.language)) return { state: "unavailable", reason: "Word alignment doesn’t read this transcript’s language." };
  if (original.alignment === alignmentVersion) return { state: "current" };
  const source = join(ctx.paths.media(projectId), media.path);
  const segments = await alignTranscript(ctx, { source, language: original.language, segments: original.segments, signal,
    emissions: await emissionStore(ctx, projectId, source), work: { mediaId, kind: "alignment" } });
  return ctx.db.transaction((): Realigned => {
    // A transcription or a speaker reading that finished meanwhile wrote the transcript this one would replace.
    const current = ctx.repos.projects.getMedia(mediaId);
    if (!current || current.projectId !== projectId || current.path !== media.path || linked(ctx, projectId, mediaId)?.id !== original.id)
      return { state: "unavailable", reason: "The transcript changed while it was aligned. Ask again." };
    const before = original.segments.flatMap(s => s.words), after = segments.flatMap(s => s.words);
    const moved = after.filter((w, i) => Math.abs(w.start - before[i]!.start) > 0.02 || Math.abs(w.end - before[i]!.end) > 0.02).length;
    const id = newId("trs");
    ctx.repos.transcripts.put({ ...original, segments, alignment: alignmentVersion, id, projectId, createdAt: new Date().toISOString() });
    const saved = ctx.repos.projects.putMedia(projectId, { ...current, transcriptId: id }, current.status, current.error);
    ctx.bus.publish({ type: "media.updated", projectId, media: saved });
    ctx.log(`[align] ${mediaId}: placed its transcript's words again, ${moved} of ${after.length} moved`);
    return { state: "realigned", transcriptId: id, words: after.length, moved };
  }, "immediate")();
}
