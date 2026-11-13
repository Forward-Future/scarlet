import type { Task } from "@scarlet/shared";
import type { MediaAsset } from "@scarlet/timeline";
import { pct } from "./format";

type Progress = NonNullable<Task["progress"]>;

/** The transcription running for a media asset, if any. */
export function runningTranscription(tasks: readonly Task[], mediaId: string): Task | undefined {
  return tasks.findLast(t => t.kind === "transcribe" && t.context.mediaId === mediaId && ["queued", "claimed", "running"].includes(t.state));
}

/**
 * "45%", or "waiting its turn" while other audio work runs first. The percent alone, everywhere it shows: Media, the
 * transcript pane and a run waiting on its transcripts. None of them guesses how long is left.
 */
export function transcriptionProgressLabel(progress: Progress | undefined): string | undefined {
  if (!progress) return;
  if (progress.stage === "queued") return "waiting its turn";
  // A job still running would round up to 100%: it says 99% until it is done.
  return pct(progress.fraction < 1 ? Math.min(progress.fraction, 0.99) : 1);
}

/**
 * How far along the transcripts a run is waiting for are, as one figure weighted by recording length.
 * They take turns in the engine's audio lane, so the time left is the sum, known once each has an estimate.
 * The run reads a transcript once its words are saved, a third of the way through the job, so the figure is the
 * words': the whole job's would stop near 33% as each recording stopped being waited for.
 * A recording whose transcript is already saved counts as done, with no time left, whether or not its task still runs.
 * Counted as nothing once its task had ended, or left out, it took its share back out of the figure each time one of
 * several was saved. Whether there is a figure at all is up to the recordings still without a transcript: there is none
 * while none of those is being transcribed, and while all of them wait their turn it says so.
 */
export function transcriptsProgress(tasks: readonly Task[], media: readonly Pick<MediaAsset, "id" | "duration" | "transcriptId">[], mediaIds: readonly string[]): Progress | undefined {
  const parts = mediaIds.map(id => {
    const asset = media.find(m => m.id === id);
    const progress = runningTranscription(tasks, id)?.progress;
    // An engine that doesn't report the words alone saves the transcript only when the whole job is done.
    const words = progress?.words ?? progress;
    return { duration: asset?.duration || 1, saved: !!asset?.transcriptId,
      progress: asset?.transcriptId ? { stage: "aligning" as const, fraction: 1, remainingSeconds: 0 }
        : progress && words && { stage: progress.stage, fraction: words.fraction, remainingSeconds: words.fraction >= 1 ? 0 : words.remainingSeconds } };
  });
  const unsaved = parts.filter(p => !p.saved);
  if (!unsaved.length || unsaved.every(p => !p.progress)) return;
  if (unsaved.every(p => !p.progress || p.progress.stage === "queued")) return { stage: "queued", fraction: 0 };
  const total = parts.reduce((sum, p) => sum + p.duration, 0);
  const fraction = parts.reduce((sum, p) => sum + p.duration * (p.progress?.fraction ?? 0), 0) / total;
  const remaining = parts.every(p => p.progress?.remainingSeconds !== undefined)
    ? parts.reduce((sum, p) => sum + p.progress!.remainingSeconds!, 0) : undefined;
  const stage = parts.some(p => p.progress?.stage === "transcribing") ? "transcribing" : "aligning";
  return { stage, fraction: Math.min(1, fraction), ...(remaining !== undefined && { remainingSeconds: remaining }) };
}

/** A media asset's transcription tasks, including ones from older servers that named it only in the instruction. */
export function transcriptionTasks(tasks: readonly Task[], media: readonly Pick<MediaAsset, "id" | "name">[], asset: Pick<MediaAsset, "id" | "name">): Task[] {
  return tasks.filter(t => {
    if (t.kind !== "transcribe") return false;
    if (t.context.mediaId) return t.context.mediaId === asset.id;
    if (t.instruction === `Transcribe ${asset.id}`) return true;
    return t.instruction === `Transcribe ${asset.name}` && media.filter(m => m.name === asset.name).length === 1;
  });
}

/**
 * A recording's latest transcription was running when the project's media processing was paused. The pause stopped
 * it and resume starts it again, so it hasn't failed and there is nothing to retry.
 */
export function transcriptionPaused(latest: Task | undefined, mediaPaused: boolean | undefined): boolean {
  return !!mediaPaused && latest?.state === "failed" && !!latest.interrupted;
}

/**
 * Media whose problem only shows on the Media page: a file Scarlet couldn't read, or a recording still without a
 * transcript whose last transcription failed or was interrupted. One the pause stopped isn't a problem, and neither
 * is one on a file with no audio track, which Media gives no transcript line.
 */
export interface MediaProblem { asset: MediaAsset; problem: "unreadable" | "transcription" }

export function mediaProblems(tasks: readonly Task[], media: readonly MediaAsset[], mediaPaused = false): MediaProblem[] {
  return media.flatMap((asset): MediaProblem[] => {
    if (asset.status === "failed") return [{ asset, problem: "unreadable" }];
    if ((asset.kind !== "video" && asset.kind !== "audio") || asset.hasAudio === false || asset.transcriptId) return [];
    const latest = transcriptionTasks(tasks, media, asset)
      .reduce<Task | undefined>((a, b) => !a || (b.createdAt ?? "") > (a.createdAt ?? "") ? b : a, undefined);
    return latest?.state === "failed" && !transcriptionPaused(latest, mediaPaused) ? [{ asset, problem: "transcription" }] : [];
  });
}

/** What the Media button says about those problems: the one problem with its file's name, or how many files have one. */
export function mediaWarningLabel(problems: readonly MediaProblem[]): string | undefined {
  if (problems.length > 1) return `${problems.length} files need attention`;
  if (!problems[0]) return;
  const { asset, problem } = problems[0];
  return problem === "unreadable" ? `Couldn’t read ${asset.name}` : `Transcription stopped for ${asset.name}`;
}
