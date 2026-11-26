import { z } from "zod/v3";
import {
  boundedRippleOps,
  cutScope,
  DEFAULT_RESULT_CHARS,
  rippleDrift,
  selectedRange,
  type AgentCapabilities,
  type ProposeChangeRequest,
  type ScarletClient,
  type Task,
} from "@scarlet/shared";
import {
  applyOps,
  audioCrossfadeOps,
  carriesAudio,
  clipsAt,
  emptyTimeline,
  introducedDoubledSound,
  pictureSyncOps,
  expandSplitJoins,
  type SplitJoinPlaced,
  type ProposedOp,
  timelineDuration,
  timelineToSource,
  Transition,
  WritableTimeline,
  type Change,
  type LouderDoubledSound,
  type Timeline,
  type TimelineOp,
  type TranscriptWord,
} from "@scarlet/timeline";
import { FULL_TIMELINE_DEFAULTS, fullTimelinePage, round3, summarizeTimelinePage } from "./analysis.js";
import { joinAudio } from "./dialogue-join.js";
import { editReasonInput, makeIntentInput, timelineEditsInput } from "./mcp-schema.js";
import { EDGES_IN_SOUND, type MediaSession, type SoundingEdge } from "./media-session.js";
import type { SessionErrorHelpers } from "./media-state.js";
import type { FrameAdjustment, ProposePipeline } from "./propose-pipeline.js";
import { InsetFraming, InsetPresenter, syncPictureOps } from "./sync-layout.js";
import { sourceRangeToTimeline, sourceToTimeline, timelineWords } from "./timeline-perception.js";
import { expandDips, type DipReport } from "./music-dips.js";
import { DOUBLED_SOUND, doubledSoundText, OPS_DOC, validateOps } from "./timeline-validation.js";
import { errorText, formatZodError, json, text, type ToolRegistrar } from "./tool-result.js";
import { splitJoinEvidence, splitJoinLabel } from "./split-join.js";
import { transitionOps } from "./transition.js";
import { registerTimelineGenerateTools } from "./timeline-generate-tools.js";

/** Times one timeline_at call maps; the rest of a longer list come back to ask for. */
const TIMES_AT_ONCE = 50;

export interface TimelineToolsDeps {
  tool: ToolRegistrar;
  client: ScarletClient;
  projectId: string;
  taskId?: string;
  task?: Task;
  authoring: Task["context"] | undefined;
  caps: AgentCapabilities;
  session: MediaSession;
  errors: SessionErrorHelpers;
  proposePipeline: ProposePipeline;
  useStagedCut(): Promise<Error | undefined>;
  readApprovedExample(changeId: string): Promise<Change>;
}

export function registerTimelineTools(deps: TimelineToolsDeps) {
  const { tool, client, projectId, taskId, task, authoring, caps, session, errors, proposePipeline, readApprovedExample } = deps;
  const {
    getProject, getHeader, getTimeline, peekTimeline, cutAnchor, baseTimeline,
    headTimelineOrNull, transcriptWords, joinPages, measureTimeline,
    edgesInSound, edgeInSoundText,
  } = session;
  const { without, withoutUnlessPreparing } = errors;
  const { ripplesOnFrames, propose, presetInsetOver, presetInsetText } = proposePipeline;
  const intentInput = makeIntentInput(Boolean(taskId));

  tool(
    "timeline_get",
    (authoring ? "Read the timeline version approved for the requested skill." : "Read a timeline version (default head).") + ` summary: per track, each clip with id, label, timeline in–out (timecode), source range, speed, volume, fades, framing (scale, x, y, crops), effects and transition in, plus markers. Pass optional from/to (TIMELINE seconds) to read one stretch; long summaries page automatically with a from cursor. full: the Timeline JSON with every clip property (transforms, keyframes, effects, caption styles), taking from/to and paging the same way; ${FULL_TIMELINE_DEFAULTS} Read one stretch in full rather than the whole timeline. Clip ids are what ops reference. A media clip lasts (sourceOut - sourceIn) / speed on the timeline.`,
    { version: z.string().optional().describe(authoring ? "Defaults to the approved version" : "Version id; default head"),
      format: z.enum(["summary", "full"]).default("summary"),
      from: z.number().finite().nonnegative().optional().describe("Optional start in TIMELINE seconds"),
      to: z.number().finite().positive().optional().describe("Optional exclusive end in TIMELINE seconds") },
    async ({ version, format, from, to }) => {
      if (authoring) {
        if (!authoring.changeId || (version && version !== authoring.version)) throw new Error("This skill reads only the approved timeline version.");
        await readApprovedExample(authoring.changeId);
      }
      if (from !== undefined && to !== undefined && to <= from) throw new Error("to must be greater than from.");
      const tl = await getTimeline(authoring?.version ?? version);
      if (format === "full") return text(fullTimelinePage(tl, { from, to, maxChars: caps.resultChars ?? DEFAULT_RESULT_CHARS }));
      const project = await getHeader();
      return text(summarizeTimelinePage(tl, project.project.settings.fps, {
        from,
        to,
        maxChars: caps.resultChars ?? DEFAULT_RESULT_CHARS,
      }));
    },
  );

  tool(
    "timeline_at",
    "Map between timeline and source time so you never compute it by hand. With time (TIMELINE seconds): every clip under that instant with its track and, for media clips, the SOURCE second playing there. With mediaId and sourceTime: every timeline position where that source second plays (none if it was cut). With mediaId and sourceRange: the timeline ranges that play it, split by clip, and the source portions no longer in the edit. times or sourceTimes map a list in one call on one version, each answer in `at`.",
    { time: z.number().min(0).optional().describe("Timeline time, seconds"),
      times: z.array(z.number().min(0)).min(1).optional().describe(`Timeline times, seconds; up to ${TIMES_AT_ONCE} are answered, the rest listed for another call`), mediaId: z.string().optional(),
      sourceTime: z.number().min(0).optional().describe("Source seconds in mediaId"),
      sourceTimes: z.array(z.number().min(0)).min(1).optional().describe(`Source seconds in mediaId; up to ${TIMES_AT_ONCE} are answered, the rest listed for another call`),
      sourceRange: z.object({ start: z.number().min(0), end: z.number().min(0) }).optional().describe("Source seconds in mediaId"),
      version: z.string().optional() },
    async ({ time, times, mediaId, sourceTime, sourceTimes, sourceRange, version }) => {
      const modes = [time, times, sourceTime, sourceTimes, sourceRange].filter(mode => mode !== undefined).length;
      if (modes !== 1) throw new Error("Give exactly one of time, times, sourceTime, sourceTimes or sourceRange.");
      if ((sourceTime !== undefined || sourceTimes || sourceRange) && !mediaId) throw new Error("sourceTime, sourceTimes and sourceRange need the mediaId they belong to.");
      // One read answers a whole list, so every answer is on the same version.
      const tl = await getTimeline(version);
      if (sourceTime !== undefined) return json({ version: tl.version, mediaId, sourceTime, placements: sourceToTimeline(tl, mediaId!, sourceTime) });
      // A long list is answered in part, with the rest to ask for, rather than refused.
      const rest = (list: number[]) => list.length > TIMES_AT_ONCE ? { notAnswered: list.slice(TIMES_AT_ONCE), next: `Ask for notAnswered on version ${tl.version}.` } : {};
      if (sourceTimes) return json({ version: tl.version, mediaId,
        at: sourceTimes.slice(0, TIMES_AT_ONCE).map(s => ({ sourceTime: s, placements: sourceToTimeline(tl, mediaId!, s) })), ...rest(sourceTimes) });
      if (sourceRange) {
        if (sourceRange.end <= sourceRange.start) throw new Error("sourceRange.end must be greater than sourceRange.start.");
        return json({ version: tl.version, mediaId, sourceRange, ...sourceRangeToTimeline(tl, mediaId!, sourceRange.start, sourceRange.end) });
      }
      const under = (t: number) => {
        const clips = clipsAt(tl, t).map(({ track, clip }) => ({
          trackId: track.id, trackKind: track.kind, clipId: clip.id, kind: clip.kind, ...(clip.label && { label: clip.label }), timelineIn: clip.timelineIn,
          ...(clip.kind === "media" ? { mediaId: clip.mediaId, sourceIn: clip.sourceIn, sourceOut: clip.sourceOut, sourceTime: round3(timelineToSource(clip, t)) } : {}),
          ...(clip.kind === "caption" ? { text: clip.text } : {}),
        }));
        return { clips, ...(!clips.length && { note: "Nothing plays at that time (a gap)." }) };
      };
      if (times) return json({ version: tl.version, at: times.slice(0, TIMES_AT_ONCE).map(t => ({ time: t, ...under(t) })), ...rest(times) });
      return json({ time, version: tl.version, ...under(time!) });
    },
  );

  /** Where someone speaks on a timeline: the transcribed words of every recording but `except`, as the edit plays them. */
  const speechOn = async (on: Timeline, except: ReadonlySet<string>) => {
    const { project } = await getProject();
    const transcripts = new Map<string, TranscriptWord[]>();
    for (const id of new Set(on.tracks.flatMap(t => t.clips.flatMap(c => c.kind === "media" && !except.has(c.mediaId) ? [c.mediaId] : [])))) {
      if (!project.media.some(m => m.id === id && carriesAudio(m))) continue;
      const words = await transcriptWords(id, false).catch(() => null);
      if (words?.length) transcripts.set(id, words);
    }
    return timelineWords(on, transcripts).filter(w => w.end > w.start).map(w => ({ start: w.start, end: w.end }));
  };

  tool(
    "timeline_propose",
    `Propose an edit to the timeline. Provide EITHER \`ops\` (a list of operations on the named base version) OR \`timeline\` (a full replacement timeline). Scarlet validates it, stores a new version, makes short before/after previews available when the editor opens the change. Directly requested edits apply automatically, onto the current video when it moved since the base version. An edit that meets footage changed since then is not applied: the result's \`notApplied\` says where, and the current version to make it on. Suggestions and alternatives wait for review. Write \`description\` for the editor in one short, plain sentence about what changed (e.g. "Cut the false start at 1:17 and the 1.4 s pause after it"). Pass \`noteIds\` when the change answers review notes. Every audible clip edge the edit makes is measured on its recording, whichever op makes it: one inside a sounding word, or through a sound it would leave a piece of, refuses the edit and gives the quiet second beside it. Audible clips that play the same moment of one recording in sync add up in the mix: an edit that plays a moment louder that way than its base version played it is refused with the clips, the stretch that got louder and both levels. Make the change it names, which turns down the copy the edit added or changed, and another when that one alone can't, over that stretch alone, or pass \`layeredSound\` when the editor asked to hear it layered. Returns the change id, state, affected timeline ranges, the new version id and a diff.

${OPS_DOC}`,
    {
      ops: z.array(z.record(z.unknown())).optional().describe("Operations to apply to the current head (see op types)"),
      timeline: z.record(z.unknown()).optional().describe("Full replacement Timeline JSON (use for initial assemblies); omit when using ops"),
      description: z.string().min(1).describe("One short sentence for the chat about what the editor will see or hear"),
      batchTitle: z.string().trim().min(1).max(80).optional().describe("When this save makes several similar edits of the same kind (such as multiple cuts, graphics, zooms, or audio fixes), give a short plain-English group title summarizing them together for the edits list (e.g. '3 model title cards', '4 zooms on key moments', '2 cuts: false start & tangent'). Omit for a single edit or unrelated edits."),
      reason: editReasonInput.describe("Why you proposed the whole change. Give this for an unnamed edit or when several edits share one suggestion card."),
      noteIds: z.array(z.string()).optional().describe("Review note ids this change responds to"),
      fromVersion: z.string().optional().describe("Version the ops apply to. Defaults to the version you last read with timeline_get or timeline_at; leave it out unless you mean another version."),
      range: z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive() }).optional().describe("Only when every op in ops is rippleDelete across all tracks (without trackIds or pictureLayout): timeline range on the base version for synchronized ripple removals, including local pauses. Omit range for all other ops (addTrack, addClip, trim, overlays, framing); use timelineEdits to mark where non-ripple edits apply."),
      pictureLayout: z.union([z.object({ screenClipId: z.string(), cameraClipId: z.string(),
        presenter: InsetPresenter.optional(),
        framing: InsetFraming.optional(),
      }), z.literal("asPlaced")]).optional()
        .describe("Optional camera inset during the specified clips’ overlap, in the bottom-right corner, placed on the presenter where `faces` finds one face: `presenter` sets how much of them it shows, its shape, size and corners as the editor's skill asks (head and shoulders at a quarter size when omitted). `framing` (scale, center-relative x/y, optional crop and cornerRadius) sets the transform outright instead. Omit pictureLayout to use the submitted clip transforms."),
      intent: intentInput,
      timelineEdits: timelineEditsInput,
      ...(!taskId && { autoApprove: z.boolean().optional().describe("Apply a standalone edit authored directly by the editor") }),
      skipRender: z.boolean().optional().describe("Skip before/after renders (metadata-only changes like markers)"),
      withdraws: z.array(z.string()).max(20).optional().describe("Change IDs of this request's own suggestions or alternatives, still waiting for the editor, that this one replaces, such as a draft or a test. They leave the editor's review when this one is saved."),
      layeredSound: z.boolean().optional().describe("The editor asked to hear the same moment of a recording on two clips at once. Leave it out otherwise"),
    },
    async ({ ops, timeline, description, batchTitle, reason, noteIds, fromVersion, intent, autoApprove, timelineEdits, skipRender, range, pictureLayout, withdraws, layeredSound }) => {
      // Every clip edge the edit makes is measured on its recording, however the edit makes it: a ripple, a clip added
      // or trimmed, a whole new timeline. One pass built its video from added clips, which nothing measured, and began
      // a clip inside the end of an “uh”; the revision the editor then asked for trimmed that join by one frame, into
      // the first sound of the next word, and said the word now played in full (2026-11-12).
      // A second audible copy of the same moment of a recording doubles that sound in the mix. One edit asked to keep the
      // original audio and played it twice as loud, on the video clip and again on A1 (#18). A directly requested edit
      // applies as it's saved, so the model hears of it first, and an editor who asked for the layering still gets it.
      // It reads no audio, so it runs before any of the edit's edges are measured and refuses sooner.
      const refuseDoubledSound = async (next: Timeline) => {
        if (layeredSound) return;
        const doubled = await getProject()
          .then(({ project }) => introducedDoubledSound(before, next, project.media))
          .catch(without("failed to check the edit for sound it plays louder", [] as LouderDoubledSound[]));
        if (doubled.length) throw new Error(doubled.slice(0, 6).map(d => doubledSoundText(d, next)).join("; ") +
          `${doubled.length > 6 ? `; and ${doubled.length - 6} more` : ""}. ${DOUBLED_SOUND}`);
      };
      const refuseEdgesInSound = async (base: Timeline | null, next: Timeline) => {
        const inside = await edgesInSound(base, next).catch(withoutUnlessPreparing("failed to measure the edit's new clip edges", [] as SoundingEdge[]));
        if (inside.length) throw new Error(inside.slice(0, 12).map(e => edgeInSoundText(e)).join("; ") +
          `${inside.length > 12 ? `; and ${inside.length - 12} more` : ""}. ${EDGES_IN_SOUND}`);
      };
      if (!ops && !timeline) throw new Error("Provide either `ops` or `timeline`.");
      if (ops && timeline) throw new Error("Provide only one of `ops` or `timeline`.");
      const before = fromVersion ? await peekTimeline(fromVersion) : await headTimelineOrNull();
      if (range && (typeof pictureLayout === "object" || !before || !ops || ops.some(o => o.op !== "rippleDelete" || o.trackIds)))
        throw new Error("A bounded ripple edit takes only rippleDelete ops across all tracks on the existing timeline.");
      const body: ProposeChangeRequest = { description, ...(batchTitle && { batchTitle }), reason, noteIds, intent, autoApprove: !taskId && autoApprove === true ? true : undefined, timelineEdits, skipRender,
        ...(withdraws?.length && { withdraws }) };
      const frameChanges: FrameAdjustment[] = [];
      let splitJoins: SplitJoinPlaced[] = [];
      const inset = typeof pictureLayout === "object" ? pictureLayout : undefined;
      let insetNote: string | undefined;
      let dips: DipReport[] = [];
      /** The inset as given, or the preset on the presenter where no framing was. Roles are checked before faces are read. */
      const insetLayout = async (placed: Timeline): Promise<NonNullable<typeof inset>> => {
        if (inset?.presenter && inset.framing) throw new Error("Give pictureLayout presenter or framing, not both.");
        if (!inset || inset.framing) return inset!;
        const { project } = await getProject();
        syncPictureOps(project, placed, inset);
        const clip = placed.tracks.flatMap(t => t.clips).find(c => c.id === inset.cameraClipId);
        const camera = clip?.kind === "media" ? project.media.find(m => m.id === clip.mediaId) : undefined;
        if (clip?.kind !== "media" || !camera) return inset;
        const preset = await presetInsetOver(project, camera, clip.sourceIn, clip.sourceOut, inset.presenter);
        insetNote = presetInsetText(camera.id, preset, inset.presenter);
        return { ...inset, framing: preset.framing };
      };
      if (ops) {
        const checked = validateOps(ops);
        if (!checked.ok) return errorText(checked.error);
        if (!checked.ops.length) throw new Error("ops is empty");
        const expanded = await expandDips(checked.ops, before ?? emptyTimeline(projectId), speechOn);
        dips = expanded.dips;
        const v: { ops: ProposedOp[] } = { ops: expanded.ops };
        if (before && (range || (selectedRange(task?.context) && v.ops.every(o => o.op === "rippleDelete" && !o.trackIds)))) {
          body.range = cutScope(before, await cutAnchor(before), range);
          const aligned = boundedRippleOps(v.ops as TimelineOp[], body.range, (await getHeader()).project.settings.fps, timelineDuration(before));
          const drift = rippleDrift();
          for (const [i, op] of aligned.entries()) {
            const asked = v.ops[i]!;
            if (asked.op !== "rippleDelete") continue;
            const movedBy = round3(drift.place(asked).start - asked.start);
            drift.removed(asked, op);
            if (Math.abs(op.start - asked.start) > 1e-6 || Math.abs(op.end - asked.end) > 1e-6)
              frameChanges.push({ asked: [asked.start, asked.end], removed: [op.start, op.end], ...(movedBy && { movedBy }) });
          }
          v.ops = aligned;
        } else v.ops = await ripplesOnFrames(v.ops as TimelineOp[], before, frameChanges);
        // A splitJoin step becomes the clip ops that move the sound, worked out where it falls among the others.
        if (v.ops.some(o => o.op === "splitJoin")) {
          if (!before) throw new Error("A splitJoin needs a timeline with the join on it.");
          const { project } = await getProject();
          ({ ops: v.ops, joins: splitJoins } = expandSplitJoins(before, project.media, project.settings.fps, v.ops));
          if (!timelineEdits?.length && splitJoins.length === ops.length) body.timelineEdits = splitJoins.map(j => ({
            label: splitJoinLabel(j),
            range: { start: Math.min(j.at, j.at + j.shift), end: Math.max(j.at, j.at + j.shift) },
            ...(reason && { reason }),
          }));
        }
        body.ops = v.ops as TimelineOp[];
        // Dry-run against the pinned base before deriving the picture from the synchronized clips.
        const placed = applyOps(before ?? emptyTimeline(projectId), body.ops);
        await refuseDoubledSound(placed);
        // Dialogue removed here skips the edge placement and checks of dialogue_apply_cuts. Three removals on one pass
        // came this way, and an edge inside a sounding word is the clipped word the editor sends back. Each all-track
        // ripple is measured on the timeline it applies to, in order.
        if (before) {
          const { project } = await getProject();
          let on = before;
          // Every refused edge is named at once: named one at a time, a pass made six calls to learn of six edges (2026-11-15).
          const split: string[] = [];
          for (const [i, op] of body.ops.entries()) {
            if (op.op === "rippleDelete" && !op.trackIds && op.end > op.start) {
              // Only a measured word split refuses the edit. A recording with nothing to measure goes ahead as asked; one
              // still being prepared is measured when the model calls again.
              const inside = await measureTimeline(on, [op.start, op.end])
                .then(() => joinAudio(on, project, op, joinPages(), { onTimeline: true }).filter(e => e.sound === "sound" && e.transcriptSplitsWord))
                .catch(withoutUnlessPreparing(`failed to measure the edges of ripple ${i}`, []));
              // Where the recording is quiet either side, in the timeline seconds the op is given in, and the levels: named
              // only the word, a pass measured the edge again with its own scripts before each new try (2026-11-23).
              const quiet = (e: (typeof inside)[number]) => {
                const at = [e.quietBeforeOnTimeline, e.quietAfterOnTimeline].filter((q): q is number => q !== undefined).map(q => `${q.toFixed(2)} s`);
                return (at.length ? ` (the recording is quiet at ${at.join(" and at ")})` : "") + (e.levels ? ` [dBFS in 20 ms steps: ${e.levels}]` : "");
              };
              split.push(...inside.map(e => `ops[${i}] ${e.edge} at ${(e.edge === "start" ? op.start : op.end).toFixed(2)} s falls inside “${e.transcriptSplitsWord}”, which is sounding there${quiet(e)}`));
            }
            on = applyOps(on, [op]);
          }
          if (split.length) throw new Error(split.join("; ") +
            ". Nothing was saved. Remove dialogue with dialogue_apply_cuts, where a word reference puts each edge in the recording's silence, or move the edge onto quiet (dialogue_check_join measures it).");
        }
        await refuseEdgesInSound(before, placed);
        if (inset) body.ops = [...body.ops, ...syncPictureOps((await getProject()).project, placed, await insetLayout(placed))];
      } else {
        const parsed = WritableTimeline.safeParse({ ...timeline, projectId, version: (timeline as { version?: string })?.version ?? "draft" });
        if (!parsed.success) {
          return errorText(`Invalid timeline:\n${formatZodError(parsed.error)}`);
        }
        body.timeline = parsed.data;
        await refuseDoubledSound(parsed.data);
        await refuseEdgesInSound(before, parsed.data);
        if (inset) body.timeline = applyOps(parsed.data, syncPictureOps((await getProject()).project, parsed.data, await insetLayout(parsed.data)));
      }
      const result = await propose(body, before, frameChanges);
      const notes = [insetNote, dips.length ? `musicDips: ${JSON.stringify(dips)}` : undefined].filter((n): n is string => !!n);
      // Each split join as it will play: when each voice comes in and goes out, and the words it brings in or drops.
      if (splitJoins.length && !result.isError) {
        const said = new Map<string, TranscriptWord[] | null>();
        for (const mediaId of new Set(splitJoins.flatMap(j => [j.left.mediaId, j.right.mediaId])))
          said.set(mediaId, await transcriptWords(mediaId, false).catch(() => null));
        notes.push(`Split joins: ${JSON.stringify(splitJoinEvidence(applyOps(before!, body.ops!), splitJoins, id => said.get(id)))}`);
      }
      return notes.length ? { ...result, content: [...result.content, ...notes.map(text => ({ type: "text" as const, text }))] } : result;
    },
  );

  tool(
    "edit_flag",
    "Flag an edit already in the video, this request's or an earlier one's, for a doubt the editor must settle by looking or listening. The request lists that edit as needing them and shows check on its card until they keep, revise or undo it. Give range for the exact passage they should inspect, even when you identify the edit explicitly with changeId and spot: the few seconds the doubt is about, not the whole edit. The card shows that passage's times on the video as it is then and plays it, so leave times out of check. With range alone on the current version, the applied edit matching that range is flagged and alsoThere names any others; to flag a short passage inside a much longer edit, pass changeId and spot explicitly. For an edit you are saving now, give check in timeline_propose's timelineEdits instead. A problem no edit made has nothing to flag: say so in your reply.",
    {
      check: z.string().trim().min(1).max(120).describe("A few words naming the doubt the editor must settle, as the edit's card shows it, without times"),
      range: z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().nonnegative() }).optional()
        .describe("The passage to inspect in timeline seconds: where the doubt is, a few seconds, not the whole edit. Set start equal to end for one moment."),
      version: z.string().min(1).optional().describe("The timeline version range refers to. Defaults to the version last read, or the current version if none was read. A range without an edit ID must be on the current version."),
      changeId: z.string().min(1).optional().describe("The change that made the edit, as change_get lists it. Give spot with it."),
      spot: z.number().int().nonnegative().optional().describe("Zero-based index of the edit in that change"),
    },
    async ({ check, range, version, changeId, spot }) => {
      if ((changeId === undefined) !== (spot === undefined)) throw new Error("Give changeId and spot together.");
      if (!changeId && !range) throw new Error("Give range or changeId with spot.");
      if (version && !range) throw new Error("Give range with version.");
      return json(await client.flagEdit(projectId, { check, range, version: range ? version ?? session.lastTimeline?.version : undefined,
        changeId, spot, taskId }));
    },
  );

  tool(
    "timeline_crossfade_audio",
    "Propose centered audio-only crossfades between touching dialogue clips on the same audible track. Pass the clip ids on either side of each join. The total overlap is `duration`, from the skill; two project frames when omitted. Uses real source handles and preserves picture timing and manual fades. All joins form one proposal.",
    {
      intent: intentInput,
      joins: z.array(z.object({ leftClipId: z.string(), rightClipId: z.string() })).min(1),
      duration: z.number().finite().positive().optional().describe("Total overlap in seconds"),
      description: z.string().min(1).default("Smooth the selected dialogue joins"),
      batchTitle: z.string().trim().min(1).max(80).optional().describe("Short plain-English group title for the edits list when smoothing multiple joins (e.g. '6 smoothed dialogue joins')"),
      reason: editReasonInput,
      noteIds: z.array(z.string()).optional(),
    },
    async ({ intent, joins, duration, description, batchTitle, reason, noteIds }) => {
      const { project } = await getProject();
      const before = await baseTimeline();
      const ops = audioCrossfadeOps(before, project.media, joins, duration ?? 2 / project.settings.fps);
      return propose({ intent, ops, description, ...(batchTitle && { batchTitle }), reason, noteIds }, before);
    },
  );

  tool(
    "timeline_transition",
    "Put a transition on joins between clips on a video track, or take it off (none). A transition is how the picture moves from one clip to the next, centred on the join: dissolve, dip (through a colour), push, slide or whip (a push with a sideways blur). The sound at the join is not changed. Give its type and duration. By their usual names, unless the editor or a skill gives another length: a swipe is a push of 0.4 s, a whip pan a whip of 0.3 s, a slide 0.4 s, a dissolve 0.5 s, and a dip to black a dip of 0.6 s. Find a join by the clip it leads into (clipId) or by its time on the track (at, timeline seconds; the bottom video track unless trackId). A transition shows a little more footage either side of the join, from each clip's own source; with less footage than half its length on a side it runs shorter, and with none it stays a straight cut: the result says what each join got. All joins form one proposal.",
    {
      intent: intentInput,
      joins: z.array(z.object({ clipId: z.string().optional(), at: z.number().finite().nonnegative().optional(), trackId: z.string().optional() })).min(1),
      type: z.enum(["dissolve", "dip", "push", "slide", "whip"]).optional(),
      duration: z.number().finite().positive().max(10).optional().describe("Seconds, centred on the join"),
      direction: z.enum(["left", "right", "up", "down"]).optional().describe("push, slide and whip: the way the picture travels; left brings the next picture in from the right"),
      color: z.string().optional().describe("dip: the colour it passes through, default black"),
      none: z.boolean().optional().describe("Take the transition off: the join is a straight cut again"),
      description: z.string().min(1).default("Transition between clips"),
      batchTitle: z.string().trim().min(1).max(80).optional().describe("Short plain-English group title for the edits list when adding transitions to multiple joins (e.g. '4 cross dissolves between sections')"),
      reason: editReasonInput,
      noteIds: z.array(z.string()).optional(),
    },
    async ({ intent, joins, type, duration, direction, color, none, description, batchTitle, reason, noteIds }) => {
      const { project } = await getProject();
      const before = await baseTimeline();
      let style: Transition | null = null;
      if (!none) {
        if (!type) throw new Error("Give the transition's type and duration.");
        style = Transition.parse({ type, duration: duration ?? 0.5, ...(direction && { direction }), ...(color && { color }) });
      }
      const { ops, report } = transitionOps(before, project.media, project.settings.fps, joins, style);
      const result = await propose({ intent, ops, description, ...(batchTitle && { batchTitle }), reason, noteIds }, before);
      return { ...result, content: [...result.content, { type: "text" as const, text: `Joins:\n${report.join("\n")}` }] };
    },
  );

  tool(
    "timeline_picture_sync",
    "Put a video's picture in time with its own sound, all through the edit: lip_sync measures how far off they are. Its sound stays where it is, so cuts placed by ear and recordings synced to it by sound stay as they are; its picture plays from `soundLeads` seconds later in the recording (earlier when negative), so a mouth moves with the words. `soundLeads` is set, not added: every clip of the video that plays beside its own sound is put that far from it whatever it was before, so a second call replaces the first and 0 puts the picture back as recorded. A clip that played its own sound hands it to the dialogue track below its own and goes silent, so its picture can move. A clip with none of its own sound beside it moves by the whole amount. Where the recording's picture runs out, a clip is shortened: the result lists each clip moved and any picture lost. One proposal.",
    {
      intent: intentInput,
      mediaId: z.string().describe("The video whose picture to move"),
      soundLeads: z.number().finite().min(-5).max(5).describe("Seconds the recording's sound comes before its picture, as lip_sync gives it: positive moves the picture later in the recording"),
      description: z.string().min(1).default("Put the picture in time with its sound").describe("One short sentence for the chat about what the editor will see"),
      reason: editReasonInput,
      noteIds: z.array(z.string()).optional(),
    },
    async ({ intent, mediaId, soundLeads, description, reason, noteIds }) => {
      const { project } = await getProject();
      const before = await baseTimeline();
      const { ops, report } = pictureSyncOps(before, project.media, mediaId, soundLeads);
      if (!ops.length) return text(`Nothing to change: every clip of ${mediaId} already plays its picture ${soundLeads} s after its sound.`);
      const result = await propose({ intent, ops, description, reason, noteIds }, before);
      const lines = [
        `Moved the picture of ${report.moved.length} clip${report.moved.length === 1 ? "" : "s"}${report.unchanged ? ` (${report.unchanged} already there)` : ""}.`,
        ...(report.soundMoved.length ? [`${report.soundMoved.length} clip${report.soundMoved.length === 1 ? "" : "s"} handed their sound to a dialogue track: ${report.soundMoved.join(", ")}.`] : []),
        ...(report.pictureOnly.length ? [`No sound of the recording plays beside ${report.pictureOnly.join(", ")}: moved by the whole ${soundLeads} s.`] : []),
        ...report.shortened.map(s => `${s.clipId} lost ${s.seconds.toFixed(3)} s of picture at ${s.at.toFixed(3)} s: the recording's picture runs out there.`),
      ];
      return { ...result, content: [...result.content, { type: "text" as const, text: lines.join("\n") }] };
    },
  );

  registerTimelineGenerateTools(deps);
}
