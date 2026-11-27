/**
 * dialogue_check_repeats' reading of a version: the engine's repeat check, with whether recordings of the same event
 * stay in line and what the picture does, and the pairs it heard, which dialogue_apply_cuts removes by id.
 */
import type { RepeatEvidence, ScarletClient, Task } from "@scarlet/shared";
import { BRIEF_PICTURE_SECONDS, briefPictures } from "./brief-pictures.js";
import type { MediaSession } from "./media-session.js";
import type { SessionErrorHelpers } from "./media-state.js";
import { pictureFindings } from "./picture-check.js";
import type { PerceptionApi, ProposePipeline } from "./propose-pipeline.js";
import { syncSummary, timelineSync, type PairSync } from "./timeline-sync.js";
import { syncRate } from "./audio-sync.js";

export interface DialogueRepeatCheckDeps {
  client: ScarletClient;
  projectId: string;
  taskId?: string;
  task?: Task;
  session: MediaSession;
  errors: SessionErrorHelpers;
  proposePipeline: ProposePipeline;
  getPerception(): PerceptionApi;
}

export function createDialogueRepeatCheck(deps: DialogueRepeatCheckDeps) {
  const { client, projectId, taskId, task, session, errors, proposePipeline, getPerception } = deps;
  const { getProject, peekTimeline, readPrepared } = session;
  const { without } = errors;
  const { framedOn } = proposePipeline;

  let checkedVersion: string | undefined;
  const checkedRepeats = new Map<string, RepeatEvidence>();
  const syncChecks = new Map<string, Promise<{ pairs: Array<PairSync & { outOfLineCount?: number }>; summary?: string } | undefined>>();
  /** Whether recordings of the same event stay in line through this version: placements, then their sound at a few spots. */
  const syncLevels = new Map<string, Promise<number[]>>();
  function checkSync(version: string) {
    let job = syncChecks.get(version);
    if (!job) {
      job = (async () => {
        const [{ project }, timeline] = await Promise.all([getProject(), peekTimeline(version)]);
        // Each new version is checked again; the recordings' levels don't change, so they are read once.
        const levels = (mediaId: string, from: number, to: number) => {
          const key = `${mediaId}/${from}/${to}`;
          let read = syncLevels.get(key);
          if (!read) {
            read = readPrepared(mediaId, "waveform", () => client.waveform(mediaId, from, to, Math.round((to - from) * syncRate), true)).then(w => w.peaks);
            read.catch(() => syncLevels.delete(key));
            syncLevels.set(key, read);
          }
          return read;
        };
        const fps = project.settings.fps;
        const pairs = await timelineSync(timeline, project.media, fps, levels);
        if (!pairs.length) return undefined;
        const summary = syncSummary(pairs, new Map(project.media.map(m => [m.id, m.name])), fps);
        // A badly placed track can be out of line at every cut: the first 20 stretches say enough to fix it.
        return { pairs: pairs.map(p => p.outOfLine.length > 20 ? { ...p, outOfLine: p.outOfLine.slice(0, 20), outOfLineCount: p.outOfLine.length } : p), summary };
      })();
      // Only an answer is kept: a read that failed (a waveform still being prepared) is made again at the next check.
      const made = job;
      made.catch(() => { if (syncChecks.get(version) === made) syncChecks.delete(version); });
      syncChecks.set(version, job);
    }
    return job.catch(without("the sync check", undefined));
  }

  // The silence, piece and text-size bars the model last asked the check for: the checks Scarlet runs after a save count by them too.
  let silencesAsked: number | undefined, piecesAsked: number | undefined, smallTextAsked: number | undefined;
  /**
   * What the picture does on a version, for the closing check: brief pictures, off-picture stretches, glides across
   * screen changes, clipped text, content under an inset, small unreadable text, and blank/loading screens.
   */
  const pictureChecks = new Map<string, Promise<{ version: string; findings: ReturnType<typeof pictureFindings>; unread?: string[] } | undefined>>();
  function checkPictures(version: string, smallTextUnder?: number) {
    const key = `${version}@${smallTextUnder ?? ""}`;
    let job = pictureChecks.get(key);
    if (!job) {
      job = (async () => {
        const [{ project }, tl] = await Promise.all([getProject(), peekTimeline(version)]);
        const [framed, cuts] = await Promise.all([framedOn(null, tl, smallTextUnder),
          getPerception().cutsOn(tl, project, { wait: 0 }).catch(without("where the recordings cut", undefined))]);
        const brief = briefPictures(tl, project.media, project.settings, BRIEF_PICTURE_SECONDS, cuts?.cuts);
        const unread = [...new Set([...framed.unread, ...cuts?.unread ?? []])];
        return { version: tl.version, findings: pictureFindings(tl, brief, framed.framed, framed.words), ...(unread.length && { unread }) };
      })();
      // "head" names a different version after each save: only a named one is kept, and only an answer, so a read
      // that failed or had unread screen perception is made again at the next check.
      const made = job;
      made.then(res => { if (res?.unread?.length && pictureChecks.get(key) === made) pictureChecks.delete(key); })
        .catch(() => { if (pictureChecks.get(key) === made) pictureChecks.delete(key); });
      if (version !== "head") pictureChecks.set(key, job);
    }
    return job.catch(without("what the picture does", undefined));
  }

  async function checkRepeats(version: string, keep?: Array<{ id: string; reason: string }>, offset?: number, asked?: number, piecesUnderAsked?: number, smallTextUnderAsked?: number) {
    if (asked !== undefined) silencesAsked = asked;
    if (piecesUnderAsked !== undefined) piecesAsked = piecesUnderAsked;
    if (smallTextUnderAsked !== undefined) smallTextAsked = smallTextUnderAsked;
    const silencesFrom = silencesAsked, piecesUnder = piecesAsked, smallTextUnder = smallTextAsked;
    if (!taskId) throw new Error("Check repeated dialogue from an editing task.");
    // The check reads the edit as it is now unless it keeps something heard on the version named: the picture too.
    const pictures = await checkPictures(keep?.length ? version : "head", smallTextUnder);
    const found = await client.checkDialogueRepeats(projectId, taskId, { version: !keep?.length && pictures ? pictures.version : version,
      keep, offset, silencesFrom, piecesUnder, startedAt: task?.startedAt, ...(pictures && { pictures: { version: pictures.version, findings: pictures.findings } }) });
    const sync = offset ? undefined : await checkSync(found.version);
    const result = { ...found, ...(sync && { sync }), ...(pictures?.unread?.length && { pictureUnread: pictures.unread }) };
    if (checkedVersion !== result.version) checkedRepeats.clear();
    checkedVersion = result.version;
    for (const k of keep ?? []) checkedRepeats.delete(k.id);
    return { ...result, repeats: result.repeats.map(r => {
      checkedRepeats.set(r.id, r);
      const { occurrences, ...words } = r;
      return { ...words, removable: Object.keys(occurrences) };
    }) };
  }

  return {
    checkRepeats,
    /** The pairs the last check heard, by id, on `checkedVersion()`. */
    checkedRepeats,
    checkedVersion: () => checkedVersion,
    /** The silence length the model last asked the check for. */
    silencesAsked: () => silencesAsked,
    /** The short-piece length the model last asked the check for. */
    piecesAsked: () => piecesAsked,
  };
}
