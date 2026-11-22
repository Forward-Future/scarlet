/**
 * Correct a word or phrase across a project's transcripts, keeping word times.
 *
 * The editor says "it's Scarlet, not Scarlett": captions, search, screen matching and every later pass read the
 * stored transcript, so the fix goes there once. Each fix is kept on the transcript (`wordFixes`): placing the words
 * again keeps them, and a transcription made again applies them again as it saves (`transcription.ts`).
 *
 * Nothing primes the recogniser with the editor's spellings: a vocabulary prompt made Whisper loop and drop words
 * (2026-11-18), so a correction is made on the words Whisper gave.
 */
import { applyWordFix, type WordFixPlace } from "@scarlet/shared";
import { newId, type Transcript, type TranscriptWordFix } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { badRequest, notFound } from "../errors.js";

export type TranscriptFixReport =
  | { mediaId: string; name: string; count: number; wordsAdded: number; places: WordFixPlace[] }
  | { mediaId: string; name: string; skipped: string };

/** The transcript a recording reads: the linked one, else its latest. */
function linked(ctx: Ctx, projectId: string, mediaId: string, transcriptId?: string): Transcript | undefined {
  const id = transcriptId ?? (ctx.db.prepare("SELECT id FROM transcripts WHERE media_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(mediaId, projectId) as { id: string } | undefined)?.id;
  return id ? ctx.repos.transcripts.get(id) ?? undefined : undefined;
}

export function fixTranscriptWords(ctx: Ctx, projectId: string, fix: TranscriptWordFix & { mediaIds?: string[] }): { recordings: TranscriptFixReport[] } {
  const { mediaIds, ...rule } = fix;
  if ((rule.from !== undefined || rule.to !== undefined) && mediaIds?.length !== 1) {
    throw badRequest("invalid_range", "from/to are one recording's source seconds: give exactly one mediaId with them, or leave them out to fix every place.");
  }
  if (rule.from !== undefined && rule.to !== undefined && rule.to <= rule.from) throw badRequest("invalid_range", "`to` must be after `from`.");
  return ctx.db.transaction(() => {
    const all = ctx.repos.projects.listMedia(projectId);
    const asked = mediaIds?.map(id => all.find(m => m.id === id) ?? (() => { throw notFound(`media ${id}`); })())
      ?? all.filter(m => m.hasAudio || m.kind === "audio");
    const recordings: TranscriptFixReport[] = [];
    for (const media of asked) {
      const original = linked(ctx, projectId, media.id, media.transcriptId);
      if (!original?.segments.length) {
        if (mediaIds) recordings.push({ mediaId: media.id, name: media.name, skipped: "It has no transcript yet. Fix it once its transcript is saved." });
        continue;
      }
      const { transcript, places, wordsAdded } = applyWordFix(original, rule);
      if (!places.length) {
        recordings.push({ mediaId: media.id, name: media.name, count: 0, wordsAdded: 0, places });
        continue;
      }
      const wordFixes = [...(original.wordFixes ?? []), rule];
      const savedAt = new Date().toISOString();
      if (original.aligning) {
        // The transcription still placing these words rewrites this transcript each turn and applies its fixes as it does.
        ctx.repos.transcripts.put({ ...transcript, wordFixes, projectId });
      } else {
        // A new revision, as placing words again or labelling speakers makes: a realignment under way sees it changed.
        const id = newId("trs");
        ctx.repos.transcripts.put({ ...transcript, wordFixes, id, projectId, createdAt: savedAt });
        const current = ctx.repos.projects.getMedia(media.id)!;
        const saved = ctx.repos.projects.putMedia(projectId, { ...current, transcriptId: id }, current.status, current.error);
        ctx.bus.publish({ type: "media.updated", projectId, media: saved });
      }
      ctx.log(`[transcript] ${media.id}: "${rule.find}" now reads "${rule.replace}" in ${places.length} place(s)`);
      recordings.push({ mediaId: media.id, name: media.name, count: places.length, wordsAdded, places });
    }
    return { recordings };
  }, "immediate")();
}
