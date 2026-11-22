import {
  rippleDrift,
  type AgentCapabilities,
  type ProposeChangeRequest,
  type ScarletClient,
  type Task,
  type TaskEvent,
} from "@scarlet/shared";
import {
  applyOps,
  clipById,
  describeDiff,
  diffTimelines,
  frameAligned,
  timelineDuration,
  type Author,
  type MediaAsset,
  type Project,
  type Timeline,
  type TimelineOp,
} from "@scarlet/timeline";
import { pct1, round3 } from "./analysis.js";
import {
  BRIEF_PICTURES_NEXT,
  edgesOntoRecordingCuts,
  flashesOntoCuts,
  MET_CUT_NEXT,
  MET_RECORDING_CUT_NEXT,
  newBriefPictures,
  type MetCut,
  type MetRecordingCut,
} from "./brief-pictures.js";
import {
  BACKGROUND_NEXT,
  INSET_LOOK_NEXT,
  INSET_LOOK_WIDTH,
  UNFRAMED_NEXT,
  backgroundShows,
  insetsToLook,
  unframedBeside,
  type InsetToLook,
} from "./clip-framing.js";
import { BESIDE_MAX, FRAMING_REPORT_NEXT, besideReach as besideReachOf, framingReport, type FramedStretch } from "./framing-report.js";
import type { MediaSession } from "./media-session.js";
import type { SessionErrorHelpers } from "./media-state.js";
import type { registerPerception } from "./perception-tools.js";
import { showAreaFindings, showAreaRefusal, type RecordingAreas } from "./show-area.js";
import { insetStretches, presetInset, type FaceReading, type InsetPresenter, type PresetInset } from "./sync-layout.js";
import { json, noteUnmeasured, type ToolResult } from "./tool-result.js";

/** What to do about an edit another request's change kept off the video. Its own result says what met and where. */
const NOT_APPLIED_NEXT = "Nothing was applied. Another request changed this footage after fromVersion. Read that passage on currentVersion and make the edit again there.";

/**
 * Seconds a save waits for the cuts of a recording it shows that aren't read yet. A recording is read once and kept:
 * 60 s of a 4K screen recording takes about 1.5 s, all 25 minutes of one about 40 s (M-series, 2026-11-18).
 */
const CUTS_WAIT_SECONDS = 45;
/** Pictures of the speaker beside framed stretches a save shows at most, and how wide: a face to read the eyes of, about 100 tokens each. */
const EYE_LOOKS = 12, EYE_LOOK_WIDTH = 320;

/** A ripple removal that went onto whole frames: asked as given, removed where it went, and how much later it moved first. */
export type FrameAdjustment = { asked: [number, number]; removed: [number, number]; movedBy?: number };

export type PerceptionApi = ReturnType<typeof registerPerception>;

export interface ProposePipelineDeps {
  client: ScarletClient;
  projectId: string;
  taskId?: string;
  task?: Task;
  author: Author;
  caps: AgentCapabilities;
  session: MediaSession;
  errors: SessionErrorHelpers;
  waitLeft(margin: number, most?: number): number;
  postEvent(ev: Omit<TaskEvent, "taskId">): Promise<{ posted: boolean; error?: string }>;
  sourceFrame(mediaId: string, t: number, width: number, area?: readonly number[], grid?: boolean): Promise<{ data: string; mimeType: string }>;
  getPerception(): PerceptionApi;
}

export function createProposePipeline(deps: ProposePipelineDeps) {
  const { client, projectId, taskId, task, author, caps, session, errors, waitLeft, postEvent, sourceFrame, getPerception } = deps;
  const { getProject, getHeader, moveBase } = session;
  const { withoutOnce } = errors;

  /**
   * Ripple removals go on whole frames, as dialogue cuts do: one that ends between two frames leaves a black frame at
   * its join. Each one that moved is reported with the range that was removed. Ops run in order, each written on the
   * edit the earlier ones leave as asked, so a later one first moves by what the earlier rounding left in (rippleDrift),
   * which `movedBy` reports.
   */
  async function ripplesOnFrames(ops: TimelineOp[], before: Timeline | null, onWholeFrames: FrameAdjustment[]): Promise<TimelineOp[]> {
    if (!ops.some(op => op.op === "rippleDelete")) return ops;
    const fps = (await getHeader()).project.settings.fps;
    const base = before ? timelineDuration(before) : Infinity;
    // Each removal across every track brings the end of the edit earlier for the ones after it. Once any other op has
    // run, where the edit ends is not known here, and the base's end stands. It stands for a task's edit throughout:
    // the engine puts a task's removals on whole frames itself, by the base's end, and would make a move left out here
    // without reporting it.
    let ends = base, known = !taskId;
    const drift = rippleDrift();
    return ops.map(op => {
      if (op.op !== "rippleDelete" || typeof op.start !== "number" || typeof op.end !== "number") {
        known = false;
        ends = base;
        return op;
      }
      const placed = drift.place(op);
      // A removal that runs to the end of the edit keeps its end, which need not be on a frame.
      const runsToEnd = placed.end >= ends - 1e-6;
      const aligned = { start: frameAligned(placed, fps).start, end: runsToEnd ? (Math.abs(placed.end - ends) < 1e-6 ? ends : placed.end) : frameAligned(placed, fps).end };
      if (Math.abs(aligned.start - op.start) > 1e-6 || Math.abs(aligned.end - op.end) > 1e-6) {
        const movedBy = round3(placed.start - op.start);
        onWholeFrames.push({ asked: [op.start, op.end], removed: [round3(aligned.start), round3(aligned.end)], ...(movedBy && { movedBy }) });
      }
      if (!op.trackIds) drift.removed(op, aligned);
      if (known && !op.trackIds && aligned.start < ends) ends = Math.max(aligned.start, ends - (aligned.end - aligned.start));
      return { ...op, ...aligned };
    });
  }

  /** A recording's areas viewers may see and where each holds. A first ask reads the recording's edges, within one tool call where it can. */
  const recordingAreas = (mediaId: string, waitSeconds = waitLeft(20)) =>
    client.get<RecordingAreas & { error?: string }>(`/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(mediaId)}/show-area?wait=${waitSeconds}`);

  /**
   * Every save an agent makes goes through here: one that frames footage past the area viewers may see, or on part of a
   * picture no area was given for, is refused with each place named. A pass framed 399 screen clips in one save and
   * showed another app beside the demo for a third of their time (2026-11-16); asked for the window on a frame, the
   * same model boxed it to a fifth of a percent.
   */
  async function insideShowAreas(before: Timeline | null, laid: Timeline) {
    const { project } = await getProject();
    const ids = new Set<string>();
    showAreaFindings(before, laid, project.media, project.settings, id => { ids.add(id); return undefined; });
    if (!ids.size) return;
    const known = new Map<string, RecordingAreas>();
    await Promise.all([...ids].map(async id => { const areas = await recordingAreas(id).catch(() => undefined); if (areas) known.set(id, areas); }));
    let found = showAreaFindings(before, laid, project.media, project.settings, id => known.get(id));
    // Footage with no area on record is looked at now, a frame for each stretch, by short runs beside this one. An
    // area can end inside a stretch where the window moves, so what is still unset is asked about again, within the
    // time one tool call has.
    const deadline = Date.now() + waitLeft(30) * 1000;
    // A frame is asked about once per save: its answer doesn't change, and asking again cost a run each time (2026-11-18).
    const looked = new Set<string>();
    for (let round = 0; taskId && task?.kind !== "area_check" && found.noArea.length && round < 4 && Date.now() < deadline - 20_000; round++) {
      const bySource = new Map<string, number[]>();
      for (const n of found.noArea) {
        if (looked.has(`${n.mediaId}@${n.look}`)) continue;
        looked.add(`${n.mediaId}@${n.look}`);
        bySource.set(n.mediaId, [...(bySource.get(n.mediaId) ?? []), n.look]);
      }
      if (!bySource.size) break;
      const wait = Math.round((deadline - Date.now()) / 1000);
      const answers = await Promise.all([...bySource].map(async ([id, seconds]) => {
        const state = await client.post<RecordingAreas & { asked: number; answered: number }>(
          `/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(id)}/show-area/ask?wait=${wait}`, { seconds, taskId }).catch(() => undefined);
        if (state) known.set(id, state);
        return state?.answered ?? 0;
      }));
      if (!answers.some(Boolean)) break;
      found = showAreaFindings(before, laid, project.media, project.settings, id => known.get(id));
    }
    const refusal = showAreaRefusal(found);
    if (refusal) throw new Error(refusal);
  }

  /**
   * What an edit's framing shows, stretch by stretch, with the passages read aloud there that it leaves out or covers.
   * Text not read yet doesn't hold the save up: the report says how far it has got.
   */
  async function framedOn(before: Timeline | null, made: Timeline) {
    const { project } = await getProject();
    const framed = framingReport(before, made, project.media, project.settings);
    if (!framed.length) return { framed, covered: [], readOff: [] as Array<readonly [number, number]>, unread: [] as string[], words: [] };
    const range = { start: Math.min(...framed.map(f => f.from)), end: Math.max(...framed.map(f => f.to)) };
    const besideReach = besideReachOf(made, framed);
    const perception = getPerception();
    const [found, moving, beside] = await Promise.all([
      perception.readingsOn(made, project, range, { wait: 0 }).catch(error => { noteUnmeasured("the passages read aloud from the screen", error); return undefined; }),
      perception.motionOn(made, project, range, { wait: 0 }).catch(error => { noteUnmeasured("where the picture changes", error); return undefined; }),
      besideReach.sources.length ? perception.besideOn(made, project, besideReach.sources, { start: range.start - BESIDE_MAX, end: range.end + BESIDE_MAX }, 0, besideReach.clocks)
        .catch(error => { noteUnmeasured("what the screen shows beside the framed stretches", error); return undefined; }) : undefined,
    ]);
    const evidence = !!found?.readings.length || !!moving?.spans.length || !!beside;
    const report = evidence ? framingReport(before, made, project.media, project.settings, found?.readings, moving?.spans, beside?.evidence) : framed;
    // The holds where a picture over the recording, such as a camera inset, hides its text or anything else on it, in timeline seconds.
    const covered = report.flatMap(f => f.holds.filter(h => h.underCover || h.coverHides).map(h => [h.from, h.to]));
    // The passages read aloud off a recording beside a stretch while it is off picture, once each: the time between two
    // stretches is the one's after and the other's before.
    const readOff = [...new Map(report.flatMap(f => [...f.shownBefore?.reads ?? [], ...f.shownAfter?.reads ?? []])
      .map(r => [`${r.from}-${r.to}`, [r.from, r.to]] as const)).values()].sort((x, y) => x[0]! - y[0]!);
    return { framed: report, covered, readOff, words: beside?.evidence.words ?? [],
      unread: [...new Set([...found?.unread ?? [], ...moving?.unread ?? [], ...beside?.unread ?? []])] };
  }

  /** Recordings whose cuts weren't read through when this run last saved: brief pictures at their cuts weren't reported then. */
  const cutsUnread = new Set<string>();
  /**
   * The pictures an edit leaves on screen briefly, with those that a cut in the recording itself brings about. A
   * recording's cuts are read once and kept, so only the first save that shows a recording waits for them.
   */
  async function cutsRead(made: Timeline) {
    const { project } = await getProject();
    const read = await getPerception().cutsOn(made, project, { wait: waitLeft(10, CUTS_WAIT_SECONDS) })
      .catch(error => { noteUnmeasured("where the recordings cut", error); return undefined; });
    const fresh = new Set([...cutsUnread].filter(id => read?.cuts.has(id) && !read.unreadIds.includes(id)));
    for (const id of fresh) cutsUnread.delete(id);
    for (const id of read?.unreadIds ?? []) cutsUnread.add(id);
    return { read, fresh };
  }

  /** `early` is the read of the recordings' cuts taken before the save, when there was one. */
  async function briefOn(before: Timeline | null, made: Timeline, early?: Awaited<ReturnType<typeof cutsRead>>) {
    const { project } = await getProject();
    const { read, fresh } = early?.read && !early.read.unreadIds.length ? early : await cutsRead(made);
    const freshToo = new Set([...fresh, ...early?.fresh ?? []]);
    return { brief: newBriefPictures(before, made, project.media, project.settings, read?.cuts, freshToo), unread: read?.unread ?? [] };
  }

  /**
   * The speaker's face midway through the video beside each framed stretch while its recording is off picture, labelled:
   * where they look says whether they are on the screen the video doesn't show (2026-11-21). Small, and EYE_LOOKS at most.
   */
  async function eyeLooks(framed: readonly FramedStretch[]): Promise<ToolResult["content"]> {
    const seen = new Set<string>();
    const wanted = framed.flatMap(f => (["shownBefore", "shownAfter"] as const).flatMap(side => {
      const beside = f[side];
      if (!beside?.look || seen.has(`${beside.from}-${beside.to}`)) return [];
      seen.add(`${beside.from}-${beside.to}`);
      return [{ beside, look: beside.look }];
    })).sort((a, b) => a.beside.from - b.beside.from).slice(0, EYE_LOOKS);
    const looks = await Promise.all(wanted.map(w => sourceFrame(w.look.mediaId, w.look.at, EYE_LOOK_WIDTH, w.look.area)
      .catch(error => { noteUnmeasured("pictures of the speaker beside the framed stretches", error); return undefined; })));
    return wanted.flatMap((w, i) => looks[i] ? [
      { type: "text" as const, text: `The speaker at ${w.beside.from.toFixed(2)}-${w.beside.to.toFixed(2)} s of the video, its screen off picture${w.beside.eyesDown !== undefined ? ` (eyesDown ${w.beside.eyesDown})` : ""}: ${w.look.mediaId} at ${w.look.at} s.` },
      { type: "image" as const, data: looks[i]!.data, mimeType: looks[i]!.mimeType }] : []);
  }
  /** Close pictures of what each inset an edit set shows of its recording, labelled. */
  async function insetLooks(before: Timeline | null, made: Timeline): Promise<{ insets: InsetToLook[]; content: ToolResult["content"] }> {
    const { project } = await getProject();
    const insets = insetsToLook(before, made, project.media, project.settings);
    const content: ToolResult["content"] = [];
    const looks = await Promise.all(insets.flatMap((inset, i) => inset.at.map(t =>
      sourceFrame(inset.mediaId, t, INSET_LOOK_WIDTH, inset.crop.map(pct1)).then(frame => ({ i, t, frame }))
        .catch(error => { noteUnmeasured("pictures of the inset", error); return undefined; }))));
    for (const look of looks) {
      if (!look) continue;
      content.push({ type: "text", text: `insetLook[${look.i}] at ${look.t.toFixed(2)} s of ${insets[look.i]!.mediaId}, all the inset shows:` },
        { type: "image", data: look.frame.data, mimeType: look.frame.mimeType });
    }
    return { insets, content };
  }

  async function propose(body: ProposeChangeRequest, before: Timeline | null, onWholeFrames: FrameAdjustment[] = []): Promise<ToolResult> {
    if (author.type === "agent") {
      const edits = body.timelineEdits ?? [];
      const missing = edits.flatMap((edit, i) => edit.reason ? [] : [`timelineEdits[${i}].reason`]);
      if (missing.length) throw new Error(`Give ${missing.length > 1 ? `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}` : missing[0]} so the editor can see why you made ${missing.length > 1 ? "each" : "that"} edit.`);
      const proposedTogether = body.intent !== "requested" || task?.context.reviewAllCuts;
      if (!body.reason && (!edits.length || (proposedTogether && edits.length > 1))) {
        throw new Error("Give reason for the change so the editor can see why you made it.");
      }
    }
    // A picture the edit leaves on screen for a flash between two others goes onto the cut beside it, reported as metCut.
    let metCut: MetCut[] = [];
    let metRecordingCut: MetRecordingCut[] = [];
    let early: Awaited<ReturnType<typeof cutsRead>> | undefined;
    if (author.type === "agent" && before && (body.timeline || body.ops)) {
      const asked = body.timeline ?? (() => { try { return applyOps(before, body.ops!); } catch { return undefined; } })();
      if (asked) {
        const had = new Set(before.tracks.flatMap(t => t.clips.map(c => c.id)));
        const named = new Set((body.ops ?? []).flatMap(op => op.op === "addClip" && op.clip.id ? [op.clip.id] : []));
        const { project } = await getProject();
        const stable = (id: string) => !!body.timeline || had.has(id) || named.has(id);
        const closed = flashesOntoCuts(before, asked, project.media, project.settings, stable);
        if (closed.ops.length) {
          body = body.timeline ? { ...body, timeline: applyOps(body.timeline, closed.ops) } : { ...body, ops: [...body.ops!, ...closed.ops] };
          metCut = closed.met;
        }
        // An insert's edge that runs under a second past a cut in its recording goes onto that cut, reported as metRecordingCut.
        const laid = closed.ops.length ? applyOps(asked, closed.ops) : asked;
        early = await cutsRead(laid).catch(() => undefined);
        if (early?.read?.cuts.size) {
          const onCuts = edgesOntoRecordingCuts(before, laid, project.media, project.settings, early.read.cuts, stable, early.fresh);
          if (onCuts.ops.length) {
            body = body.timeline ? { ...body, timeline: applyOps(body.timeline, onCuts.ops) } : { ...body, ops: [...body.ops!, ...onCuts.ops] };
            metRecordingCut = onCuts.met;
          }
        }
      }
    }
    // The summary leaves the saved timeline out, so the edit is laid on its base here, once, for the checks before and after saving.
    const made = body.timeline ?? (body.ops && before ? (() => { try { return applyOps(before, body.ops!); } catch { return undefined; } })() : undefined);
    if (author.type === "agent" && made) await insideShowAreas(before, made);
    const req: ProposeChangeRequest = {
      ...body,
      fromVersion: before && before.version !== "draft" ? before.version : undefined,
      author,
      ...(taskId ? { taskId } : {}),
    };
    const { change, timeline, diffDescription, duration, onWholeFrames: placed, notApplied } = await client.proposeChangeSummary(projectId, req);
    if (placed?.length) onWholeFrames.push(...placed);
    // The video moved on, with this edit or under it: the next read is of the video as it is now.
    if (change.state === "approved" || notApplied) moveBase(undefined);
    const action = change.state === "approved" ? "Applied" : "Proposed";
    const lines = diffDescription ?? (before && timeline ? describeDiff(diffTimelines(before, timeline), undefined, clipById) : []);
    const unframed = made && !notApplied ? unframedBeside(before, made) : [];
    const bare = made && !notApplied ? await getProject().then(({ project }) => backgroundShows(before, made, project.media, project.settings)).catch(() => []) : [];
    const briefNow = made && !notApplied ? await briefOn(before, made, early).catch(error => { noteUnmeasured("the pictures this edit shows briefly", error); return undefined; }) : undefined;
    const brief = briefNow?.brief ?? [];
    const framedNow = made && !notApplied ? await framedOn(before, made).catch(error => { noteUnmeasured("the framing this edit made", error); return undefined; }) : undefined;
    const insetNow = caps.images && made && !notApplied ? await insetLooks(before, made).catch(error => { noteUnmeasured("pictures of the inset", error); return undefined; }) : undefined;
    const eyesNow = caps.images && framedNow ? await eyeLooks(framedNow.framed) : [];
    await postEvent({
      type: "change",
      text: `${action} change ${change.id}: ${change.description}`,
      data: { changeId: change.id, toVersion: change.toVersion, ranges: change.ranges, state: change.state },
    });
    const result = {
      changeId: change.id,
      state: change.state,
      fromVersion: change.fromVersion,
      toVersion: change.toVersion,
      affectedRanges: change.ranges,
      timelineEdits: change.timelineEdits,
      reason: change.reason,
      duration: duration ?? (timeline ? timelineDuration(timeline) : undefined),
      diff: lines,
      ...(onWholeFrames.length && { onWholeFrames }),
      ...(notApplied && { notApplied: { ...notApplied, next: NOT_APPLIED_NEXT } }),
      ...(unframed.length && { unframedBeside: unframed, next: UNFRAMED_NEXT }),
      ...(bare.length && { backgroundShows: bare, backgroundNext: BACKGROUND_NEXT }),
      ...(brief.length && { briefPictures: brief.slice(0, 20), briefNext: BRIEF_PICTURES_NEXT }),
      ...(briefNow?.unread.length && { recordingCutsUnread: briefNow.unread }),
      ...(metCut.length && { metCut: metCut.slice(0, 20), metCutNext: MET_CUT_NEXT }),
      ...(metRecordingCut.length && { metRecordingCut: metRecordingCut.slice(0, 20), metRecordingCutNext: MET_RECORDING_CUT_NEXT }),
      // Named once ahead of the list, as timeline_framing does: among a hundred framings, the few with text under a cover were read past.
      ...(framedNow?.covered.length && { hiddenUnderCover: framedNow.covered.slice(0, 20) }),
      ...(framedNow?.readOff.length && { readOffPicture: framedNow.readOff.slice(0, 20) }),
      ...(framedNow?.framed.length && { framed: framedNow.framed.slice(0, 40), framedNext: FRAMING_REPORT_NEXT, ...(framedNow.unread.length && { framedTextUnread: framedNow.unread }) }),
      ...(insetNow?.content.length && { insetLook: insetNow.insets.map(i => ({ mediaId: i.mediaId, trackId: i.trackId, clips: i.clips,
        crop: i.crop.map(pct1), at: i.at })), insetLookNext: INSET_LOOK_NEXT }),
    };
    const saved = json(result);
    const pictures = [...insetNow?.content ?? [], ...eyesNow];
    return pictures.length ? { ...saved, content: [...saved.content, ...pictures] } : saved;
  }

  /**
   * The preset inset over the source seconds a camera plays, from where `faces` finds the presenter in a few stretches
   * spread across them. Faces not read in time leave the whole picture, said so: the save doesn't wait on a reading.
   */
  const presetInsetOver = async (project: Project, camera: MediaAsset, from: number, to: number, want?: InsetPresenter): Promise<PresetInset> => {
    if (!(to > from)) return presetInset(project, camera, [], want);
    const wait = waitLeft(25, 20);
    const readings = await Promise.all(insetStretches(from, to).map(s => client.get<FaceReading>(
      `/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(camera.id)}/faces?from=${s.from.toFixed(3)}&to=${s.to.toFixed(3)}&wait=${wait}`)
      .catch(withoutOnce(`failed to find the presenter's face in ${camera.id} for the inset`, null))));
    const read = readings.filter((r): r is FaceReading => r !== null);
    const preset = presetInset(project, camera, read, want);
    return read.length || !preset.whole ? preset : { ...preset, whole: "the faces in the camera's picture couldn't be read" };
  };

  /** What a preset inset shows, for the save's result. */
  const presetInsetText = (camera: string, preset: PresetInset, want?: InsetPresenter) => {
    const f = preset.framing;
    const area = `[${[f.cropLeft ?? 0, f.cropTop ?? 0, 1 - (f.cropRight ?? 0), 1 - (f.cropBottom ?? 0)].map(pct1).join(", ")}] percent of its picture`;
    const shown = `${area}, at scale ${f.scale}${f.cornerRadius ? ` with corners rounded ${f.cornerRadius}` : ""}`;
    return preset.whole
      ? `The inset isn't placed on the presenter: ${preset.whole}. It shows ${camera}'s ${shown}. Give framing to set it yourself.`
      : `The inset holds the presenter (${want?.show ?? "shoulders"}): ${camera} shows ${shown}, around the face found in ${preset.presenter!.seconds} s of it. Change presenter, or give framing, to set it otherwise.`;
  };

  return {
    ripplesOnFrames,
    recordingAreas,
    insideShowAreas,
    framedOn,
    cutsRead,
    briefOn,
    insetLooks,
    propose,
    presetInsetOver,
    presetInsetText,
  };
}

export type ProposePipeline = ReturnType<typeof createProposePipeline>;
