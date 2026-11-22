import { stat } from "node:fs/promises";
import { fileInDirectoryAsync } from "@scarlet/render";
import { taskRunKind, type Task } from "@scarlet/shared";
import type { MediaAsset } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { measuredLoudness } from "../render/loudness.js";
import { sharedDialogueDetector } from "./dialogueDetections.js";
import { transcribeForDialogue } from "./transcription.js";
import { editsDialogue } from "./tasks.js";
import { resolveTimeline } from "./timeline.js";

/**
 * The recordings a dialogue pass reads: those the edit plays with their sound on (an unmuted track, a clip that is on
 * and above zero volume), in the order the edit first plays them. A recording whose finished transcript holds no
 * speech, such as a music bed, isn't one. On the editor's libraries a pass scanned exactly these: of two cameras with
 * the same sound, the one the edit plays it from.
 */
export function passRecordings(ctx: Ctx, projectId: string): MediaAsset[] {
  const project = ctx.repos.projects.get(projectId);
  if (!project) return [];
  const timeline = resolveTimeline(ctx, project);
  const first = new Map<string, number>();
  for (const track of timeline.tracks) {
    if (track.kind === "caption" || track.muted) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "media" || clip.enabled === false || !((clip.volume ?? 1) > 0)) continue;
      first.set(clip.mediaId, Math.min(first.get(clip.mediaId) ?? Infinity, clip.timelineIn));
    }
  }
  const speechless = ctx.db.prepare(`SELECT 1 FROM transcripts t WHERE t.id = ? AND json_extract(t.json, '$.aligning') IS NULL
    AND NOT EXISTS (SELECT 1 FROM json_each(t.json, '$.segments') s WHERE json_array_length(s.value, '$.words') > 0)`);
  return [...first].sort((a, b) => a[1] - b[1]).flatMap(([mediaId]) => {
    const media = project.media.find(m => m.id === mediaId);
    if (!media?.duration || media.kind === "image" || (media.kind !== "audio" && !media.hasAudio)) return [];
    if (media.transcriptId && speechless.get(media.transcriptId)) return [];
    return [media];
  });
}

/**
 * Read a project's dialogue pages before any pass asks: the recordings its edit plays with their sound on, or, before
 * there is an edit, every recording whose finished transcript holds speech. One at a time, in the order a pass reads
 * them (`scanAhead` in dialogueDetections.ts).
 */
export function scanAheadOfPasses(ctx: Ctx, projectId: string): void {
  const project = ctx.repos.projects.get(projectId);
  if (!project || project.mediaPaused) return;
  let recordings = passRecordings(ctx, projectId);
  if (!recordings.length) {
    const spoken = ctx.db.prepare(`SELECT 1 FROM transcripts t WHERE t.id = ? AND json_extract(t.json, '$.aligning') IS NULL
      AND EXISTS (SELECT 1 FROM json_each(t.json, '$.segments') s WHERE json_array_length(s.value, '$.words') > 0)`);
    recordings = project.media.filter(m => !!m.duration && m.kind !== "image" && (m.kind === "audio" || m.hasAudio) && !!m.transcriptId && !!spoken.get(m.transcriptId));
  }
  if (!recordings.length) return;
  const detector = sharedDialogueDetector(ctx);
  void ctx.track((async () => {
    for (const media of recordings) await detector.scanAhead(projectId, media);
  })().catch(err => {
    if (!ctx.mediaSignal(projectId).aborted) ctx.log(`[dialogue-scan] ${projectId}: reading ahead of any pass stopped: ${(err as Error).message}`);
  }), projectId);
}

/**
 * Start what a first dialogue pass reads as soon as a host claims it: the dialogue scan its first `dialogue_scan`
 * call would start, each recording's transcript if it has none, and the loudness `media_profile` reports. The pass's
 * own calls join this work rather than repeat it. The scan stops with the pass, like the one the pass starts.
 */
export function prefetchDialoguePass(ctx: Ctx, task: Task): void {
  if (!editsDialogue(task.kind) || task.context.dialogueOperation !== "first-cut" || taskRunKind(task) !== "pass" || task.changeIds.length) return;
  if (task.state !== "claimed" && task.state !== "running") return;
  const recordings = passRecordings(ctx, task.projectId);
  if (!recordings.length) return;
  ctx.log(`[dialogue-scan] ${task.id}: reading ${recordings.map(m => m.id).join(", ")} ahead of the pass`);
  const stop = ctx.projectSignal(task.projectId);
  for (const media of recordings) {
    try { transcribeForDialogue(ctx, task.projectId, media); } catch (err) {
      ctx.log(`[transcribe] ${media.id}: couldn’t start ahead of the pass: ${(err as Error).message}`);
    }
    // The same measurement, under the same key, as the loudness route `media_profile` reads.
    void ctx.track((async () => {
      const file = await fileInDirectoryAsync(ctx.paths.media(task.projectId), media.path);
      if (!file) return;
      const info = await stat(file);
      await measuredLoudness(ctx, file, [media.hash, info.size, info.ctimeMs, info.mtimeMs], { projectId: task.projectId, stop });
    })().catch(err => {
      if (!stop.aborted) ctx.log(`[media] ${media.id}: loudness ahead of the pass: ${(err as Error).message}`);
    }), task.projectId);
  }
  void ctx.track(sharedDialogueDetector(ctx).prefetch(task.projectId, recordings, task.id, task.startedAt).catch(err => {
    ctx.log(`[dialogue-scan] ${task.id}: reading ahead stopped: ${(err as Error).message}`);
  }), task.projectId);
}
