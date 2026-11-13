import { flattenWords, indexTranscriptWords, type TranscriptSearchResult } from "@scarlet/shared";
import { Transcript, type DialogueVoiceRoles } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import type { MediaWithStatus } from "../repo/projects.js";
import { savedVoiceLabels } from "./transcriptSources.js";

/** A single committed document. Its source can contain legacy fields and
 * omitted word arrays. Validate the requested segments before exposing them. */
class TranscriptDocument {
  private source: Transcript;
  private validated = false;
  private full?: { roles: DialogueVoiceRoles | undefined; transcript: Transcript };
  readonly bytes: number;

  constructor(json: string) {
    this.source = JSON.parse(json);
    // Allow room for parsed words, their optional role projections, and normalized search tokens.
    this.bytes = 128 + json.length * 5;
  }

  page(from: number | null, to: number | null, omitWords: boolean, roles?: DialogueVoiceRoles): Transcript {
    if (from === null && to === null && !omitWords) {
      if (!this.validated) {
        this.source = Transcript.parse(this.source);
        this.validated = true;
      }
      if (!this.full || this.full.roles?.me !== roles?.me || this.full.roles?.other !== roles?.other) {
        this.full = { roles, transcript: savedVoiceLabels(this.source, roles) };
      }
      return this.full.transcript;
    }
    const selected = (this.source.segments ?? []).filter(s => (from === null || s.end > from) && (to === null || s.start < to));
    const page = { ...this.source, segments: omitWords ? selected.map(s => ({ ...s, words: [] })) : selected };
    return savedVoiceLabels(this.validated ? page : Transcript.parse(page), roles);
  }
}

/** Read the language without loading every timed word for a cut. */
export function transcriptLanguage(ctx: Ctx, projectId: string, media: { id: string; transcriptId?: string }) {
  const select = "SELECT json_extract(json,'$.language') AS language FROM transcripts WHERE project_id = ? AND media_id = ?";
  const row = ctx.db.prepare(select + (media.transcriptId ? " AND id = ?" : " ORDER BY created_at DESC LIMIT 1"))
    .get(projectId, media.id, ...(media.transcriptId ? [media.transcriptId] : [])) as { language?: string } | undefined;
  return row?.language;
}

export function transcriptReader(ctx: Ctx) {
  const documents = new Map<string, { id: string; revision: string | null; doc: TranscriptDocument }>();
  let bytes = 0;
  const budget = 32 * 1024 * 1024;
  const searches = new WeakMap<Transcript, { words: number; find: ReturnType<typeof indexTranscriptWords> }>();
  return {
    read(media: MediaWithStatus & { projectId: string }, from: number | null, to: number | null, omitWords: boolean) {
      const cached = documents.get(media.id);
      // Test the cache and fetch any replacement in the same SQLite snapshot. On a hit, even a
      // multi-megabyte transcript transfers only its id and revision. Peer writes and rollbacks
      // remain visible, including deletion followed by a new transcript with the original id.
      const select = `SELECT t.id, r.revision, CASE WHEN t.id IS ? AND r.revision IS ? THEN NULL ELSE t.json END AS json
        FROM transcripts t LEFT JOIN transcript_revisions r ON r.transcript_id = t.id WHERE t.media_id = ? AND t.project_id = ?`;
      const row = ctx.db.prepare(select + (media.transcriptId ? " AND t.id = ?" : " ORDER BY t.created_at DESC LIMIT 1"))
        .get(cached?.id, cached?.revision, media.id, media.projectId, ...(media.transcriptId ? [media.transcriptId] : [])) as
        { id: string; revision: string | null; json: string | null } | undefined;
      if (cached) {
        documents.delete(media.id);
        bytes -= cached.doc.bytes;
      }
      if (!row) return null;
      const entry = row.json === null ? cached! : { id: row.id, revision: row.revision, doc: new TranscriptDocument(row.json) };
      if (entry.doc.bytes <= budget) {
        documents.set(media.id, entry);
        bytes += entry.doc.bytes;
        for (const [id, old] of documents) {
          if (bytes <= budget) break;
          documents.delete(id);
          bytes -= old.doc.bytes;
        }
      }
      return entry.doc.page(from, to, omitWords, media.voiceRoles);
    },
    search(transcript: Transcript, query: string, contextWords: number): TranscriptSearchResult {
      let index = searches.get(transcript);
      if (!index) {
        const words = flattenWords(transcript);
        index = { words: words.length, find: indexTranscriptWords(words) };
        searches.set(transcript, index);
      }
      return { segmentCount: transcript.segments.length, wordCount: index.words, matches: index.find(query, contextWords) };
    },
  };
}
