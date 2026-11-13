import { createHash } from "node:crypto";
import { statSync, type Stats } from "node:fs";
import { readFile } from "node:fs/promises";
import type { MediaAsset } from "@scarlet/timeline";
import type { Task } from "@scarlet/shared";
import type { Ctx } from "../context.js";
import { bundledWhisperModel } from "../transcribe/localModel.js";
import { resolveLocalRuntime, resolvedBinary } from "../transcribe/localRuntime.js";
import type { TranscribeInput, TranscribeResult, TranscriptionProvider } from "../transcribe/index.js";
import { alignmentVersion, type AlignmentCheckpoint } from "../transcribe/wordAlign.js";

export type TranscriptionResume = { interrupted?: Task; stranded?: string };

export async function transcriptionIdentity(ctx: Ctx, asset: MediaAsset, source: Stats | undefined, provider: TranscriptionProvider) {
  const { settings, revision } = ctx.repos.settings.transcriptionPolicy();
  const runtime = provider.name === "whispercpp" ? resolveLocalRuntime(ctx, settings) : undefined;
  // Custom weights or an adapter can be replaced in place while Scarlet is closed. A bundled executable can
  // move or be re-signed on an ordinary app update; its preset and pinned weights identify the model.
  const file = (path?: string) => {
    if (!path) return;
    const info = statSync(path, { throwIfNoEntry: false });
    return [path, info?.size, info?.mtimeMs, info?.ctimeMs];
  };
  const adapter = runtime?.active === "custom" && runtime.binary ? await resolvedBinary(runtime.binary) ?? runtime.binary : undefined;
  // The desktop replaces this small script with the app. Its contents identify the recognizer
  // across a reinstall, even when the installation path or filesystem timestamps change.
  const script = runtime?.script && runtime.script === ctx.crisperAdapter
    ? createHash("sha256").update(await readFile(runtime.script)).digest("hex")
    : file(runtime?.script);
  return JSON.stringify([1, alignmentVersion, asset.path, source?.size, source?.mtimeMs, source?.ctimeMs,
    settings.language, revision, provider.name, provider.localModel, provider.modelLabel,
    file(adapter), file(runtime?.model), script,
    runtime && !runtime.model && !runtime.adapterOwnsModel ? bundledWhisperModel.sha256 : undefined,
    provider.name === "openai" ? settings.openaiModel : undefined]);
}

/** The task claim, the saved prefix and the authority to append to it change hands in the same transaction.
 * A manual re-transcription always gets empty work; only recovery can inherit the interrupted attempt. */
export function claimTranscriptionWork(ctx: Ctx, mediaId: string, task: Task, resume?: TranscriptionResume) {
  if (resume?.interrupted && ctx.db.prepare("UPDATE transcription_work SET task_id = ? WHERE media_id = ? AND task_id = ?")
    .run(task.id, mediaId, resume.interrupted.id).changes) return;
  ctx.db.prepare("DELETE FROM transcription_work WHERE media_id = ?").run(mediaId);
  ctx.db.prepare("INSERT INTO transcription_work (media_id, task_id) VALUES (?, ?)").run(mediaId, task.id);

  // Before private checkpoints existed, a first transcript published all its words as soon as recognition ended.
  // Adopt only the interrupted run's unfinished transcript, or the exact one a transcript read found stranded.
  if (!resume) return;
  const partial = ctx.db.prepare(`SELECT id, json_extract(json, '$.aligning') AS cursor FROM transcripts
    WHERE project_id = ? AND media_id = ? AND json_extract(json, '$.aligning') IS NOT NULL
      AND (json_extract(json, '$.provider') IS NULL OR json_extract(json, '$.provider') = ?)
      AND (json_extract(json, '$.localModel') IS NULL OR json_extract(json, '$.localModel') = ?)
      AND id = coalesce(?, (SELECT json_extract(json, '$.transcriptId') FROM media WHERE id = ?), id)
      AND (? IS NOT NULL OR created_at > ?) ORDER BY created_at DESC LIMIT 1`)
    .get(task.projectId, mediaId, task.context.transcribedWith, task.context.localModel,
      resume.stranded, mediaId, resume.stranded, resume.interrupted?.createdAt) as { id: string; cursor: string } | undefined;
  if (partial) ctx.db.prepare("UPDATE transcription_work SET transcript_id = ?, alignment = ? WHERE task_id = ?")
    .run(partial.id, partial.cursor, task.id);
}

export function openTranscriptionWork(ctx: Ctx, task: Task, identity: string, checkRunning: () => void) {
  const row = ctx.db.prepare("SELECT * FROM transcription_work WHERE task_id = ?").get(task.id) as
    { media_id: string; identity: string | null; alignment: string | null; transcript_id: string | null; result: string | null };
  // A changed source or model needs a fresh reading. Discard its cursor and words together.
  if (row.identity !== identity) {
    if (row.identity !== null) {
      row.alignment = row.result = row.transcript_id = null;
      ctx.db.prepare("DELETE FROM transcription_chunks WHERE media_id = ?").run(row.media_id);
    }
    ctx.db.prepare("UPDATE transcription_work SET identity = ?, alignment = ?, result = ?, transcript_id = ? WHERE task_id = ?")
      .run(identity, row.alignment, row.result, row.transcript_id, task.id);
  }
  const result: TranscribeResult = { segments: [] };
  let through = 0;
  let fraction: number | null = null;
  for (const item of ctx.db.prepare("SELECT through, fraction, result FROM transcription_chunks WHERE media_id = ? ORDER BY through")
    .iterate(row.media_id) as Iterable<{ through: number; fraction: number | null; result: string }>) {
    const chunk = JSON.parse(item.result) as TranscribeResult;
    through = item.through;
    fraction = item.fraction;
    result.language ??= chunk.language;
    result.modelLabel ??= chunk.modelLabel;
    for (const segment of chunk.segments) result.segments.push(segment);
  }
  const recognition: NonNullable<TranscribeInput["checkpoint"]> = { through, result,
    save: ctx.db.transaction((end: number, chunk: TranscribeResult, completed?: number) => {
      checkRunning();
      ctx.db.prepare("INSERT INTO transcription_chunks (media_id, through, fraction, result) VALUES (?, ?, ?, ?)")
        .run(row.media_id, end, completed, JSON.stringify(chunk));
    }, "immediate"),
  };
  const aligned: TranscribeResult | null = row.result ? JSON.parse(row.result)
    : row.transcript_id ? ctx.repos.transcripts.get(row.transcript_id) : null;
  const alignment: AlignmentCheckpoint | undefined = aligned && row.alignment ? JSON.parse(row.alignment) : undefined;
  return { recognition, fraction, aligned, alignment,
    /** Called inside the same transaction that publishes the partial transcript. A rerun stays private. */
    saveAlignment(cursor: AlignmentCheckpoint, snapshot: TranscribeResult, publishedId?: string) {
      ctx.db.prepare("UPDATE transcription_work SET alignment = ?, result = ?, transcript_id = ? WHERE task_id = ?")
        .run(JSON.stringify(cursor), publishedId ? null : JSON.stringify(snapshot), publishedId, task.id);
      ctx.db.prepare("DELETE FROM transcription_chunks WHERE media_id = ?").run(row.media_id);
    },
  };
}
