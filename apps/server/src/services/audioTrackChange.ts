/**
 * What follows when the editor picks another audio track for a recording in Media. Everything that listens to the
 * recording reads the chosen track (`heardAudio`) and names what it keeps by it, so its waveform, scan pages, loudness
 * and the rest are read again on their next use. What is made ahead of time is made again here: the previews it plays
 * from, and its transcript, which keeps the old track's words only until the new one is saved.
 */
import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { heardAudio, heardAudioKey } from "@scarlet/render";
import type { MediaAsset } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { logId } from "../logText.js";
import type { MediaWithStatus } from "../repo/projects.js";
import { getTranscriptionProvider } from "../transcribe/index.js";
import { errorMessage } from "../util.js";
import { prepareSourceProxies, sourcePreviews } from "./sourcePreviews.js";
import { cancelTask, hasTranscript } from "./tasks.js";
import { startTranscription } from "./transcription.js";

type Media = MediaWithStatus & { projectId: string };

const heardKey = (media: MediaAsset) => JSON.stringify(heardAudioKey(heardAudio(media)));

/** Whether the two hear the same audio of their recording. */
export function hearsSameTrack(a: MediaAsset, b: MediaAsset) {
  return heardKey(a) === heardKey(b);
}

/**
 * Make a video's preview (`proxies/<id>.mp4`) again from the track it hears now. Nothing is published if the track
 * changes again meanwhile: the next change makes its own.
 */
export async function remakeTrackPreview(ctx: Ctx, media: Media) {
  if (media.kind !== "video" || media.previewMode || media.status !== "ready") return;
  const proxy = join(ctx.paths.proxies(media.projectId), `${media.id}.mp4`);
  const temp = `${proxy}.${randomUUID()}.part.mp4`;
  const signal = ctx.mediaSignal(media.projectId);
  const height = Math.min(ctx.settings().render.previewHeight, media.height ?? 720);
  try {
    await ctx.render.makeProxy(join(ctx.paths.media(media.projectId), media.path), temp, { height, audioTrack: media.audioTrack, signal,
      onFallback: stage => ctx.log(`[media] proxy_fallback media=${logId(media.id)} project=${logId(media.projectId)} height=${height} stage=${stage}`) });
    const current = ctx.repos.projects.getMedia(media.id);
    if (!current || !hearsSameTrack(current, media)) return;
    await rename(temp, proxy);
    ctx.bus.publish({ type: "media.previewReady", projectId: media.projectId, mediaId: media.id });
  } catch (error) {
    // A pause or Trash stops it; the preview then plays from parts made on demand, which hear the chosen track too.
    if (!signal.aborted) ctx.log(`[media] ${media.id} couldn’t make its preview of the chosen audio track: ${errorMessage(error)}`);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

/** Make again, from the track `after` hears, what `before` made from the track it heard. */
export async function afterAudioTrackChange(ctx: Ctx, before: Media, after: Media) {
  if (hearsSameTrack(before, after)) return;
  const { projectId } = after;
  ctx.log(`[media] ${after.id} hears audio track ${heardKey(after)} instead of ${heardKey(before)}`);

  // The transcript. A run on the old track stops, and the old track's words are cleared so Scarlet never edits or
  // displays a different track's transcript. If a transcription service is set up, transcribe the new track now.
  const running = ctx.repos.tasks.runningTranscriptions(projectId, after.id);
  const transcribed = running.length > 0 || hasTranscript(ctx, after.id) || !!after.transcriptId;
  for (const task of running) {
    ctx.db.transaction(() => cancelTask(ctx, task), "immediate")();
    await ctx.transcriptions.get(task.id)?.done.catch(() => null);
  }
  const cleared = transcribed ? ctx.db.transaction(() => {
    const current = ctx.repos.projects.getMedia(after.id);
    if (!current || !hearsSameTrack(current, after)) return undefined;
    ctx.db.prepare("DELETE FROM transcripts WHERE media_id = ?").run(after.id);
    ctx.db.prepare("DELETE FROM transcription_work WHERE media_id = ?").run(after.id);
    ctx.db.prepare("DELETE FROM transcription_chunks WHERE media_id = ?").run(after.id);
    const { status, error, projectId: _p, transcriptId: _t, lastTranscription: _l, ...rest } = current;
    const saved = ctx.repos.projects.putMedia(current.projectId, rest, status, error);
    ctx.bus.publish({ type: "media.updated", projectId: current.projectId, media: saved });
    return saved;
  }, "immediate")() : undefined;
  if (transcribed && after.hasAudio !== false && getTranscriptionProvider(ctx)) {
    const { projectId: _p, ...base } = after;
    const { status: _s, error: _e, transcriptId: _t, lastTranscription: _l, ...asset } = cleared ?? base;
    // While the project's media work is paused this waits, as an interrupted transcript does, for Resume.
    const { done } = startTranscription(ctx, projectId, asset, undefined, "interrupt");
    ctx.track(done.catch(() => null), projectId);
  } else if (transcribed) {
    ctx.log(`[transcribe] ${after.id} cleared the transcript of its previous audio track: nothing is set up to transcribe the new track`);
  }

  // The previews. Those made from the old track are this file's alone (a copy of the recording under its hash may hear
  // another track), so they go, and the new track's are made.
  const old = await sourcePreviews.filesOf(ctx, before).catch(() => []);
  await Promise.all(old.map(path => rm(path, { recursive: true, force: true })
    .catch(error => ctx.log(`[media] ${after.id} left ${path} behind: ${errorMessage(error)}`))));
  if (after.kind === "video") {
    ctx.track(remakeTrackPreview(ctx, after), projectId).catch(() => {});
    prepareSourceProxies(ctx, [after.id]);
  }
}
