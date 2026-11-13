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

/** The transcripts a run waits on before it can read its dialogue, as one stage of its progress. */
export interface TranscriptStage {
  /** How much is done, weighted by recording length. */
  fraction: number;
  /** About how long until all of them are done, once one has an estimate. */
  remainingSeconds?: number;
  /** Seconds of recording they cover. */
  total: number;
  /** None has started: other audio work runs first. */
  queued: boolean;
  done: boolean;
  /** The transcription tasks counted, in the recordings' order. One that starts again is a new task, so the key changes with it. */
  key: string;
}

/**
 * The transcripts of a run's recordings that were still being made after the run started. A dialogue pass can't read until
 * their words are saved, which on long recordings is most of the wait. Word alignment goes on after that while the pass
 * reads, so a transcript counts as done here once it has its words. They take turns in the engine's audio lane, so one
 * still waiting its turn is counted at the pace of the one running.
 */
export function runTranscripts(tasks: readonly Task[], media: readonly Pick<MediaAsset, "id" | "duration">[],
  mediaIds: readonly string[], since: string | null | undefined): TranscriptStage | undefined {
  const start = Date.parse(since ?? "");
  if (!start) return;
  const parts = mediaIds.flatMap(id => {
    // The newest counts, by when it was asked for. The list's order doesn't say: tasks loaded with the project come newest first, and ones created since follow them.
    const task = tasks.filter(t => t.kind === "transcribe" && t.context.mediaId === id &&
      (["queued", "claimed", "running"].includes(t.state) || (t.state === "done" && Date.parse(t.finishedAt ?? "") >= start)))
      .reduce<Task | undefined>((latest, t) => !latest || (t.createdAt ?? "") >= (latest.createdAt ?? "") ? t : latest, undefined);
    if (!task) return [];
    const duration = media.find(m => m.id === id)?.duration || 1;
    if (task.state === "done") return [{ taskId: task.id, duration, fraction: 1, remaining: 0 as number | undefined, started: true, done: true }];
    const started = !!task.progress && task.progress.stage !== "queued";
    // An engine that doesn't report the words alone saves the transcript only when the whole job is done.
    const words = task.progress?.words ?? task.progress;
    if (started && task.progress!.words && words!.fraction >= 1) return [{ taskId: task.id, duration, fraction: 1, remaining: 0 as number | undefined, started: true, done: true }];
    return [{ taskId: task.id, duration, fraction: started ? words!.fraction : 0, remaining: started ? words!.remainingSeconds : undefined, started, done: false }];
  });
  if (!parts.length) return;
  const total = parts.reduce((sum, p) => sum + p.duration, 0);
  const fraction = Math.min(1, parts.reduce((sum, p) => sum + p.duration * p.fraction, 0) / total);
  // Seconds of work per second of recording still to transcribe, from the transcripts that have an estimate.
  const timed = parts.filter(p => !p.done && p.remaining !== undefined && p.fraction < 1);
  const pace = timed.length ? timed.reduce((sum, p) => sum + p.remaining! / ((1 - p.fraction) * p.duration), 0) / timed.length : undefined;
  const remaining = pace === undefined ? undefined : parts.reduce((sum, p) => sum + (p.remaining ?? pace * (1 - p.fraction) * p.duration), 0);
  return { fraction, total, queued: parts.every(p => !p.started), done: parts.every(p => p.done), key: parts.map(p => p.taskId).join(),
    ...(remaining !== undefined && !parts.every(p => p.done) && { remainingSeconds: remaining }) };
}

/**
 * A figure between its reports. Whisper reports in 5% steps and word alignment once per five minutes of speech, so a
 * long transcript's bar would sit still for minutes while the work goes on. In between, it moves at the pace its own
 * time left implies, for at most `horizon` seconds after the last report and never past 99%.
 */
export function projectedFraction(fraction: number, remainingSeconds: number | undefined, secondsSinceReport: number, horizon = 240) {
  if (!remainingSeconds || remainingSeconds <= 0 || fraction >= 1) return fraction;
  const seconds = Math.min(horizon, Math.max(0, secondsSinceReport));
  return Math.max(fraction, Math.min(0.99, fraction + (1 - fraction) * seconds / remainingSeconds));
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
