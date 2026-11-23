import { z } from "zod/v3";
import { ScarletApiError, type ScarletClient, type Task } from "@scarlet/shared";
import type { MediaAsset, Project, TimeRange } from "@scarlet/timeline";
import { MediaPreparing, describeError, noteEvidenceMiss, notePreparing, noteUnmeasured, unavailable, unmeasured } from "./tool-result.js";

/** Buckets for a waveform window read at 10 ms a bucket, the engine's own resolution, ten at least. */
export const levelPoints = (from: number, to: number) => Math.max(10, Math.ceil((to - from) * 100));

/** "about 37 min" or "about 3 h 48 min". */
function roughDuration(seconds: number) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes < 90 ? `about ${minutes} min` : `about ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Where a running transcription stands, as evidence: "aligning words, 33% done, about 37 min left". */
export function transcriptionNote(progress: Task["progress"]): string {
  if (!progress) return "still being made";
  if (progress.stage === "queued") return "waiting its turn behind other audio work";
  // A transcript is readable once it has its words, so while those are made the figure is theirs alone.
  const { fraction, remainingSeconds } = progress.stage === "transcribing" && progress.words ? progress.words : progress;
  const left = remainingSeconds !== undefined && fraction < 1 ? `, ${roughDuration(remainingSeconds)} left` : "";
  return `${progress.stage === "aligning" ? "aligning words" : "transcribing"}, ${Math.floor(fraction * 100)}% done${left}`;
}

/** Look up a media asset in a project, throwing the standard guidance error when missing. */
export function requireMediaAsset(project: Pick<Project, "media">, mediaId: string, label = "Media"): MediaAsset {
  const asset = project.media.find(m => m.id === mediaId);
  if (!asset) throw new Error(`${label} ${mediaId} is not in this project. Use project_get for media ids.`);
  return asset;
}

/** The recordings a read was asked of: undefined for one (mediaId), the list for the same range on several (mediaIds). */
export const RecordingList = z.array(z.string().min(1)).min(1).max(8);

export function recordingsAsked(mediaId: string | undefined, mediaIds: string[] | undefined): string[] | undefined {
  if (mediaId !== undefined && mediaIds) throw new Error("Give mediaId for one recording or mediaIds for several, not both.");
  if (!mediaIds) {
    if (mediaId === undefined) throw new Error("Give mediaId, or mediaIds to read the same range on several recordings.");
    return undefined;
  }
  const repeated = mediaIds.find((id, i) => mediaIds.indexOf(id) !== i);
  if (repeated !== undefined) throw new Error(`mediaIds lists ${repeated} twice. List each recording once.`);
  return mediaIds;
}

/** Read each recording at once. One that fails or is still being prepared says so in its place, and the others are read. */
export function eachRecording<T>(mediaIds: string[], read: (mediaId: string) => Promise<T>) {
  return Promise.all(mediaIds.map(async (mediaId): Promise<{ mediaId: string } & ({ read: T } | { preparing: string } | { error: string })> => {
    try {
      return { mediaId, read: await read(mediaId) };
    } catch (err) {
      if (!(err instanceof MediaPreparing)) return { mediaId, error: describeError(err) };
      notePreparing();
      return { mediaId, preparing: err.message };
    }
  }));
}

export interface SessionErrorHelpers {
  without<T>(what: string, fallback: T): (err: unknown) => T;
  unavailableOnce(what: string, err: unknown): void;
  withoutOnce<T>(what: string, fallback: T): (err: unknown) => T;
  withoutUnlessPreparing<T>(what: string, fallback: T): (err: unknown) => T;
  together<T extends unknown[]>(...reads: { [K in keyof T]: () => Promise<T[K]> }): Promise<T>;
}

/** Per-session error-degradation helpers so repeated misses log once and parallel reads report deterministically. */
export function createSessionErrorHelpers(): SessionErrorHelpers {
  const without = <T>(what: string, fallback: T) => (err: unknown) => { unavailable(what, err); noteUnmeasured(what, err); return fallback; };
  const noted = new Set<string>();
  const unavailableOnce = (what: string, err: unknown) => {
    if (err instanceof MediaPreparing) return;
    const line = `${what}: ${describeError(err)}`;
    if (noted.has(line)) {
      noteEvidenceMiss(what);
      return;
    }
    noted.add(line);
    unavailable(what, err);
  };
  const withoutOnce = <T>(what: string, fallback: T) => (err: unknown) => { unavailableOnce(what, err); return fallback; };
  const withoutUnlessPreparing = <T>(what: string, fallback: T) => (err: unknown) => {
    if (err instanceof MediaPreparing) throw err;
    return without(what, fallback)(err);
  };
  async function together<T extends unknown[]>(...reads: { [K in keyof T]: () => Promise<T[K]> }): Promise<T> {
    const notes = reads.map(() => new Map<string, string>());
    const settled = await Promise.allSettled(reads.map((read, i) => unmeasured.run(notes[i]!, read)));
    const missed = unmeasured.getStore();
    settled.forEach((outcome, i) => {
      for (const [what, why] of notes[i]!) missed?.set(what, why);
      if (outcome.status === "rejected") throw outcome.reason;
    });
    return settled.map(outcome => (outcome as PromiseFulfilledResult<unknown>).value) as T;
  }
  return { without, unavailableOnce, withoutOnce, withoutUnlessPreparing, together };
}

export interface CutConflict {
  changeId: string;
  index: number;
  version: string;
  range?: TimeRange;
}

export interface RevisionTracker {
  stagedCut: { changeId: string; index: number } | undefined;
  useStagedCut(): Promise<Error | undefined>;
  namedConflict: { changeId: string; index: number } | undefined;
  cutConflict: CutConflict | undefined;
  conflictAt(id: string, i: number): boolean | undefined;
  revisionVersions: Set<string>;
  cutInspections: Array<{ version: string; range: TimeRange; edges: boolean }>;
  readPassage(version: string, range: TimeRange, edges?: boolean): void;
}

/** Tracks staged-cut revision scope, stale conflicts, and which passages the agent has inspected on immutable versions. */
export function createRevisionTracker(client: ScarletClient, task: Task | undefined): RevisionTracker {
  // A revision of one cut in a pending dialogue pass moves that cut and leaves the rest of the pass alone.
  const stagedCut = (task?.kind === "revise" || task?.kind === "edit") && task.context.changeId && task.context.cutIndex !== undefined
    ? { changeId: task.context.changeId, index: task.context.cutIndex } : undefined;
  async function useStagedCut() {
    if (!stagedCut) return;
    if (task?.stagedCutRevision === false) return;
    if (task?.kind === "edit" && task.stagedCutRevision === undefined) {
      // An ordinary edit can also reference an older change. Only a pending call has a proposal to revise.
      const record = await client.changeRecord(stagedCut.changeId).catch(err => {
        if (err instanceof ScarletApiError && err.status === 404) return undefined;
        throw err;
      });
      if (record?.change.intent !== "suggestion" || (!["ready", "revising"].includes(record.change.state) && !record.change.replacedBy)) return;
    }
    return new Error(`This revises staged cut ${stagedCut.index} of ${stagedCut.changeId}. Save its new range with dialogue_revise_cut. The revised cut goes back to the editor as a call with its reason as the note: what they should listen for belongs there, and nothing else needs saving.`);
  }
  const tracker: RevisionTracker = {
    stagedCut,
    useStagedCut,
    namedConflict: stagedCut,
    cutConflict: stagedCut && task?.cutConflict ? { ...stagedCut, ...task.cutConflict } : undefined,
    conflictAt(id: string, i: number) {
      return tracker.cutConflict && (
        tracker.cutConflict.changeId === id && tracker.cutConflict.index === i ||
        tracker.namedConflict?.changeId === id && tracker.namedConflict.index === i
      );
    },
    revisionVersions: new Set<string>(),
    cutInspections: [],
    readPassage(version: string, range: TimeRange, edges = false) {
      if (stagedCut || version === tracker.cutConflict?.version || tracker.revisionVersions.has(version)) {
        tracker.cutInspections.push({ version, range, edges });
      }
    },
  };
  return tracker;
}
