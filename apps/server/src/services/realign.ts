/**
 * Place a saved transcript's words again with the current aligner, without transcribing again.
 *
 * A transcript keeps the word times of the aligner that made it. When the aligner improves, its older transcripts
 * still hide what the new one shows: one placed "now." on 1.3 s of quiet, and no pause showed there (2026-11-15).
 * The words, their order and their indices stay; the saved times are the estimates the search starts from, and the
 * recording's saved emissions make it a search, not an inference. A transcript already on this aligner is left alone.
 */
import { join } from "node:path";
import { heardAudio } from "@scarlet/render";
import { newId } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { clip, humanDuration } from "../logText.js";
import { alignmentVersion, alignsLanguage, alignTranscript } from "../transcribe/wordAlign.js";
import { emissionStore } from "./recordingAudio.js";
import { linkedTranscript } from "./transcriptReader.js";

export type Realigned = { state: "current" | "unavailable"; reason?: string } | { state: "realigned"; transcriptId: string; words: number; moved: number };

export async function realignTranscript(ctx: Ctx, projectId: string, mediaId: string, signal: AbortSignal): Promise<Realigned> {
  const media = ctx.repos.projects.getMedia(mediaId);
  const original = linkedTranscript(ctx, projectId, mediaId, media?.transcriptId);
  if (!media || media.projectId !== projectId || !original) return { state: "unavailable", reason: "This recording has no transcript." };
  if (original.aligning) return { state: "unavailable", reason: "This transcript is still being aligned." };
  if (!original.segments.some(segment => segment.words.length)) return { state: "unavailable", reason: "This transcript has no words to realign." };
  if (!alignsLanguage(original.language)) return { state: "unavailable", reason: "Word alignment doesn’t read this transcript’s language." };
  if (original.alignment === alignmentVersion) return { state: "current" };
  const source = join(ctx.paths.media(projectId), media.path);
  const audio = heardAudio(media);
  const emissions = await emissionStore(ctx, projectId, source, audio).catch(error => {
    ctx.log(`[align] ${mediaId}: couldn't place its transcript's words again, the source recording can't be read: ${clip((error as Error)?.message ?? String(error))}`);
    return undefined;
  });
  signal.throwIfAborted();
  if (!emissions) return { state: "unavailable", reason: "The source recording is unavailable." };
  let failed = false;
  const started = Date.now();
  const segments = await alignTranscript(ctx, { source, audio, language: original.language, segments: original.segments, signal, emissions,
    work: { mediaId, kind: "alignment" }, onFailure: () => { failed = true; } });
  signal.throwIfAborted();
  if (failed) {
    ctx.log(`[align] ${mediaId}: couldn't place its transcript's words again, the aligner failed after ${humanDuration(Date.now() - started)}`);
    return { state: "unavailable", reason: "Scarlet couldn’t realign this transcript. Try again when the source recording and aligner are available." };
  }
  return ctx.db.transaction((): Realigned => {
    // A transcription or a speaker reading that finished meanwhile wrote the transcript this one would replace.
    const current = ctx.repos.projects.getMedia(mediaId);
    if (!current || current.projectId !== projectId || current.path !== media.path || linkedTranscript(ctx, projectId, mediaId, current.transcriptId)?.id !== original.id) {
      ctx.log(`[align] ${mediaId}: its transcript changed while its words were placed again, so the new times weren't saved`);
      return { state: "unavailable", reason: "The transcript changed while it was aligned. Ask again." };
    }
    const before = original.segments.flatMap(s => s.words), after = segments.flatMap(s => s.words);
    const moved = after.filter((w, i) => Math.abs(w.start - before[i]!.start) > 0.02 || Math.abs(w.end - before[i]!.end) > 0.02).length;
    const id = newId("trs");
    ctx.repos.transcripts.put({ ...original, segments, alignment: alignmentVersion, id, projectId, createdAt: new Date().toISOString() });
    const saved = ctx.repos.projects.putMedia(projectId, { ...current, transcriptId: id }, current.status, current.error);
    ctx.bus.publish({ type: "media.updated", projectId, media: saved });
    ctx.log(`[align] ${mediaId}: placed its transcript's words again in ${humanDuration(Date.now() - started)}, ${moved} of ${after.length} moved`);
    return { state: "realigned", transcriptId: id, words: after.length, moved };
  }, "immediate")();
}
