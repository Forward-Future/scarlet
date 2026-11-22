import { z } from "zod/v3";
import {
  boundedRippleOps,
  cutScope,
  rippleDrift,
  ScarletApiError,
  selectedRange,
  type AgentCapabilities,
  type ProposeChangeRequest,
  type ScarletClient,
  type Task,
} from "@scarlet/shared";
import {
  applyOps,
  audioCrossfadeOps,
  CaptionStyle,
  EditReason,
  captionsFromWords,
  carriesAudio,
  clipEnd,
  clipsAt,
  dipKeyframes,
  emptyTimeline,
  introducedDoubledSound,
  newId,
  pictureSyncOps,
  timelineDuration,
  timelineFromKeepRanges,
  timelineToSource,
  Transform,
  Transition,
  WritableTimeline,
  type CaptionClip,
  type Change,
  type LouderDoubledSound,
  type Timeline,
  type TimelineOp,
  type Track,
  type TranscriptWord,
} from "@scarlet/timeline";
import {
  captionSourceClips,
  captionWordMapper,
  dedupeWords,
  pct1,
  round2,
  round3,
  summarizeTimeline,
} from "./analysis.js";
import { joinAudio } from "./dialogue-join.js";
import { firstCutRanges } from "./first-cut-ranges.js";
import { boxInCorner, cornerOf, CORNERS, coverOnText, framingOps, MOVE_EASES, type Box, type Corner } from "./framing.js";
import {
  editReasonInput,
  makeIntentInput,
  paceInput,
  percentBox,
  timelineEditsInput,
} from "./mcp-schema.js";
import { EDGES_IN_SOUND, type MediaSession, type SoundingEdge } from "./media-session.js";
import { requireMediaAsset, type SessionErrorHelpers } from "./media-state.js";
import type { FrameAdjustment, ProposePipeline } from "./propose-pipeline.js";
import { InsetFraming, InsetPresenter, syncPictureOps } from "./sync-layout.js";
import { sourceRangeToTimeline, sourceToTimeline, timelineWords } from "./timeline-perception.js";
import { DOUBLED_SOUND, doubledSoundText, OPS_DOC, validateOps } from "./timeline-validation.js";
import { errorText, formatZodError, json, noteUnmeasured, text, type ToolRegistrar, type ToolResult } from "./tool-result.js";
import { transitionOps } from "./transition.js";

/** Times one timeline_at call maps; the rest of a longer list come back to ask for. */
const TIMES_AT_ONCE = 50;
/** Pictures of framings one call returns. */
const FRAMING_PICTURES = 12;

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
  const { tool, client, projectId, taskId, task, authoring, caps, session, errors, proposePipeline, useStagedCut, readApprovedExample } = deps;
  const {
    getProject, getHeader, getTimeline, peekTimeline, cutAnchor, baseTimeline,
    headTimelineOrNull, transcriptWords, joinPages, measureTimeline,
    edgesInSound, edgeInSoundText, planSources, edgeWaitMs,
  } = session;
  const { without, withoutUnlessPreparing } = errors;
  const { ripplesOnFrames, recordingAreas, propose, presetInsetOver, presetInsetText } = proposePipeline;
  const intentInput = makeIntentInput(Boolean(taskId));

  tool(
    "timeline_get",
    (authoring ? "Read the timeline version approved for the requested skill." : "Read a timeline version (default head).") + " summary: per track, each clip with id, label, timeline in–out (timecode), source range, speed, volume and fades, plus markers. full: the complete Timeline JSON with every clip property (transforms, effects, caption styles). Clip ids are what ops reference. A media clip lasts (sourceOut - sourceIn) / speed on the timeline.",
    { version: z.string().optional().describe(authoring ? "Defaults to the approved version" : "Version id; default head"), format: z.enum(["summary", "full"]).default("summary") },
    async ({ version, format }) => {
      if (authoring) {
        if (!authoring.changeId || (version && version !== authoring.version)) throw new Error("This skill reads only the approved timeline version.");
        await readApprovedExample(authoring.changeId);
      }
      const tl = await getTimeline(authoring?.version ?? version);
      if (format === "full") return json(tl);
      const project = await getHeader();
      return text(summarizeTimeline(tl, project.project.settings.fps));
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

  tool(
    "timeline_propose",
    `Propose an edit to the timeline. Provide EITHER \`ops\` (a list of operations on the named base version) OR \`timeline\` (a full replacement timeline). Scarlet validates it, stores a new version, makes short before/after previews available when the editor opens the change. Directly requested edits apply automatically, onto the current video when it moved since the base version. An edit that meets footage changed since then is not applied: the result's \`notApplied\` says where, and the current version to make it on. Suggestions and alternatives wait for review. Write \`description\` for the editor in one short, plain sentence about what changed (e.g. "Cut the false start at 1:17 and the 1.4 s pause after it"). Pass \`noteIds\` when the change answers review notes. Every audible clip edge the edit makes is measured on its recording, whichever op makes it: one inside a sounding word, or through a sound it would leave a piece of, refuses the edit and gives the quiet second beside it. Audible clips that play the same moment of one recording in sync add up in the mix: an edit that plays a moment louder that way than its base version played it is refused with the clips, the stretch that got louder and both levels. Make the change it names, which turns down the copy the edit added or changed, and another when that one alone can't, over that stretch alone, or pass \`layeredSound\` when the editor asked to hear it layered. Returns the change id, state, affected timeline ranges, the new version id and a diff.

${OPS_DOC}`,
    {
      ops: z.array(z.record(z.unknown())).optional().describe("Operations to apply to the current head (see op types)"),
      timeline: z.record(z.unknown()).optional().describe("Full replacement Timeline JSON (use for initial assemblies); omit when using ops"),
      description: z.string().min(1).describe("One short sentence for the chat about what the editor will see or hear"),
      reason: editReasonInput.describe("Why you proposed the whole change. Give this for an unnamed edit or when several edits share one suggestion card."),
      noteIds: z.array(z.string()).optional().describe("Review note ids this change responds to"),
      fromVersion: z.string().optional().describe("Version the ops apply to. Defaults to the version you last read with timeline_get or timeline_at; leave it out unless you mean another version."),
      range: z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive() }).optional().describe("Timeline range on the base version for synchronized ripple removals across all tracks, including local pauses."),
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
    async ({ ops, timeline, description, reason, noteIds, fromVersion, intent, autoApprove, timelineEdits, skipRender, range, pictureLayout, withdraws, layeredSound }) => {
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
      const body: ProposeChangeRequest = { description, reason, noteIds, intent, autoApprove: !taskId && autoApprove === true ? true : undefined, timelineEdits, skipRender,
        ...(withdraws?.length && { withdraws }) };
      const frameChanges: FrameAdjustment[] = [];
      const inset = typeof pictureLayout === "object" ? pictureLayout : undefined;
      let insetNote: string | undefined;
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
        const v = validateOps(ops);
        if (!v.ok) return errorText(v.error);
        if (!v.ops.length) throw new Error("ops is empty");
        if (before && (range || (selectedRange(task?.context) && v.ops.every(o => o.op === "rippleDelete" && !o.trackIds)))) {
          body.range = cutScope(before, await cutAnchor(before), range);
          const aligned = boundedRippleOps(v.ops, body.range, (await getHeader()).project.settings.fps, timelineDuration(before));
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
        } else v.ops = await ripplesOnFrames(v.ops, before, frameChanges);
        body.ops = v.ops;
        // Dry-run against the pinned base before deriving the picture from the synchronized clips.
        const placed = applyOps(before ?? emptyTimeline(projectId), v.ops);
        await refuseDoubledSound(placed);
        // Dialogue removed here skips the edge placement and checks of dialogue_apply_cuts. Three removals on one pass
        // came this way, and an edge inside a sounding word is the clipped word the editor sends back. Each all-track
        // ripple is measured on the timeline it applies to, in order.
        if (before) {
          const { project } = await getProject();
          let on = before;
          // Every refused edge is named at once: named one at a time, a pass made six calls to learn of six edges (2026-11-15).
          const split: string[] = [];
          for (const [i, op] of v.ops.entries()) {
            if (op.op === "rippleDelete" && !op.trackIds && op.end > op.start) {
              // Only a measured word split refuses the edit. A recording with nothing to measure goes ahead as asked; one
              // still being prepared is measured when the model calls again.
              const inside = await measureTimeline(on, [op.start, op.end])
                .then(() => joinAudio(on, project, op, joinPages()).filter(e => e.sound === "sound" && e.transcriptSplitsWord))
                .catch(withoutUnlessPreparing(`failed to measure the edges of ripple ${i}`, []));
              split.push(...inside.map(e => `ops[${i}] ${e.edge} at ${(e.edge === "start" ? op.start : op.end).toFixed(2)} s falls inside “${e.transcriptSplitsWord}”, which is sounding there`));
            }
            on = applyOps(on, [op]);
          }
          if (split.length) throw new Error(split.join("; ") +
            ". Nothing was saved. Remove dialogue with dialogue_apply_cuts, where a word reference puts each edge in the recording's silence, or move the edge onto quiet (dialogue_check_join measures it).");
        }
        await refuseEdgesInSound(before, placed);
        if (inset) body.ops = [...v.ops, ...syncPictureOps((await getProject()).project, placed, await insetLayout(placed))];
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
      return insetNote ? { ...result, content: [...result.content, { type: "text" as const, text: insetNote }] } : result;
    },
  );

  tool(
    "edit_flag",
    "Flag an edit already in the video, this request's or an earlier one's, for a doubt the editor must settle by looking or listening. The request lists that edit as needing them and shows check on its card until they keep, revise or undo it. Give range for the exact passage they should inspect, even when you identify the edit explicitly with changeId and spot: the few seconds the doubt is about, not the whole edit. The card shows that passage's times on the video as it is then and plays it, so leave times out of check. With range alone on the current version, the edit covering most of the range is flagged and alsoThere names the others. For an edit you are saving now, give check in timeline_propose's timelineEdits instead. A problem no edit made has nothing to flag: say so in your reply.",
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
      reason: editReasonInput,
      noteIds: z.array(z.string()).optional(),
    },
    async ({ intent, joins, duration, description, reason, noteIds }) => {
      const { project } = await getProject();
      const before = await baseTimeline();
      const ops = audioCrossfadeOps(before, project.media, joins, duration ?? 2 / project.settings.fps);
      return propose({ intent, ops, description, reason, noteIds }, before);
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
      reason: editReasonInput,
      noteIds: z.array(z.string()).optional(),
    },
    async ({ intent, joins, type, duration, direction, color, none, description, reason, noteIds }) => {
      const { project } = await getProject();
      const before = await baseTimeline();
      let style: Transition | null = null;
      if (!none) {
        if (!type) throw new Error("Give the transition's type and duration.");
        style = Transition.parse({ type, duration: duration ?? 0.5, ...(direction && { direction }), ...(color && { color }) });
      }
      const { ops, report } = transitionOps(before, project.media, project.settings.fps, joins, style);
      const result = await propose({ intent, ops, description, reason, noteIds }, before);
      return { ...result, content: [...result.content, { type: "text" as const, text: `Joins:\n${report.join("\n")}` }] };
    },
  );

  tool(
    "timeline_duck",
    "Dip clips, such as music, under speech. Volume keyframes do it: each dip goes down over `down` seconds to reach `depth` dB under the clip's own level as its stretch starts, holds, and comes back up over `up` seconds once it ends, easing in and out. Give the stretches as [start, end] timeline seconds (`stretches`), or leave them out to dip under the speech transcribed on every other audible clip: words closer than `swellIn` seconds share a dip, and the level comes back up in longer pauses. Stretches closer than `down` + `up` share one dip, since the level couldn't come back up between them. The dips take the place of the clips' earlier volume keyframes inside `within` ([start, end] timeline seconds), or of all of them without it. Name the clips by `clipIds`, or every clip of a recording by `mediaId`. The result lists each dip as placed, the pauses where the level comes back up (`swells`), and the transcribed speech still playing over the clips at their full level (`speechNotUnder`). One proposal.",
    {
      intent: intentInput,
      clipIds: z.array(z.string()).optional().describe("The clips to dip"),
      mediaId: z.string().optional().describe("Dip every clip of this recording instead"),
      stretches: z.array(z.array(z.number())).optional()
        .describe("Timeline seconds to dip under. Leave out to dip under the transcribed speech"),
      depth: z.number().optional().describe("dB under the clip's own level while a stretch plays, -60 to 0. Your skill says which; -18 when omitted"),
      down: z.number().optional().describe("Seconds the level takes to go down before a stretch. Your skill says which; 0.3 when omitted"),
      up: z.number().optional().describe("Seconds the level takes to come back up after a stretch. Your skill says which; 0.8 when omitted"),
      swellIn: z.number().optional().describe("With speech: the shortest pause the level comes back up in. Your skill says which; 2 when omitted"),
      within: z.array(z.number()).optional()
        .describe("Only place dips here, keeping the clips' volume keyframes outside it"),
      description: z.string().optional().describe("One short sentence for the chat about what the editor will hear"),
      reason: EditReason.describe("Why, for the edit's card: the footage cue or the editor's request"),
    },
    async ({ intent, clipIds: named, mediaId, stretches: pairs, depth, down, up, swellIn, within: span_, description: said, reason }) => {
      const clipIds = named?.length ? named : undefined, description = said?.trim() || "Dip the music under speech";
      if (!clipIds === !mediaId) throw new Error("Give clipIds or mediaId.");
      const range = (pair: number[], name: string) => {
        if (pair.length !== 2 || !(pair[0]! >= 0 && pair[1]! >= pair[0]! && Number.isFinite(pair[1]))) throw new Error(`${name} must be [start, end] in timeline seconds.`);
        return { start: pair[0]!, end: pair[1]! };
      };
      const stretches = pairs?.map(p => range(p, "Each stretch")), within = span_ && range(span_, "within");
      const finite = (v: number | undefined, lo: number, hi: number, name: string) => {
        if (v !== undefined && !(Number.isFinite(v) && v >= lo && v <= hi)) throw new Error(`${name} must be between ${lo} and ${hi}.`);
      };
      finite(depth, -60, 0, "depth"); finite(down, 0, 5, "down"); finite(up, 0, 10, "up"); finite(swellIn, 0, 30, "swellIn");
      const [{ project }, before] = await Promise.all([getProject(), baseTimeline()]);
      const shape = { depth: depth ?? -18, down: down ?? 0.3, up: up ?? 0.8 };
      const gap = swellIn ?? 2;
      const placed = before.tracks.flatMap(track => track.clips.flatMap(clip => clip.kind === "media" &&
        (clipIds ? clipIds.includes(clip.id) : clip.mediaId === mediaId) ? [{ clip, track }] : []));
      const missing = clipIds?.filter(id => !placed.some(p => p.clip.id === id)) ?? [];
      if (missing.length) throw new Error(`No media clip ${missing.join(", ")} on version ${before.version}.`);
      if (!placed.length) throw new Error(`No clip of ${mediaId} on version ${before.version}.`);
      // The speech is every other recording's transcribed words, as the edit plays them: a song's own lyrics aren't it.
      const ducked = new Set(placed.map(p => p.clip.kind === "media" ? p.clip.mediaId : ""));
      const transcripts = new Map<string, TranscriptWord[]>();
      for (const id of new Set(before.tracks.flatMap(t => t.clips.flatMap(c => c.kind === "media" && !ducked.has(c.mediaId) ? [c.mediaId] : [])))) {
        if (!project.media.some(m => m.id === id && carriesAudio(m))) continue;
        const words = await transcriptWords(id, false).catch(() => null);
        if (words?.length) transcripts.set(id, words);
      }
      const spoken = timelineWords(before, transcripts).filter(w => w.end > w.start);
      if (!stretches && !spoken.length) throw new Error("No transcribed speech plays on the other clips: give the stretches to dip under.");
      const inside = (s: { start: number; end: number }) => !within || (s.end > within.start && s.start < within.end);
      const speech = spoken.reduce<{ start: number; end: number }[]>((runs, w) => {
        const last = runs.at(-1);
        if (last && w.start - last.end < gap) last.end = Math.max(last.end, w.end);
        else runs.push({ start: w.start, end: w.end });
        return runs;
      }, []);
      const under = (stretches ?? speech).filter(s => s.end > s.start && inside(s))
        .map(s => within ? { start: Math.max(s.start, within.start), end: Math.min(s.end, within.end) } : s);
      const ops: TimelineOp[] = [];
      const report = placed.map(({ clip }) => {
        if (clip.kind !== "media") throw new Error(`${clip.id} is not a media clip.`);
        const { keys, dips } = dipKeyframes(clip, under, shape, within);
        ops.push({ op: "updateClip", clipId: clip.id, patch: { volumeKeyframes: keys } });
        const start = clip.timelineIn, end = clipEnd(clip);
        const swells = dips.slice(1).map((d, i) => ({ start: round3(dips[i]!.end), end: round3(d.start) }));
        // Speech over the clip that plays with no dip under it: evidence for the model, which decides what to do.
        const open = speech.filter(s => s.end > start && s.start < end && inside(s)).flatMap(s => {
          let parts = [{ start: Math.max(s.start, start), end: Math.min(s.end, end) }];
          for (const d of dips) parts = parts.flatMap(p => d.end <= p.start || d.start >= p.end ? [p]
            : [{ start: p.start, end: d.start }, { start: d.end, end: p.end }].filter(q => q.end - q.start > 0.05));
          return parts;
        });
        return { clipId: clip.id, from: round3(start), to: round3(end), keyframes: keys.length,
          dips: dips.map(d => ({ start: round3(d.start), end: round3(d.end), depth: d.depth })),
          ...(swells.length && { swells: swells.slice(0, 40), ...(swells.length > 40 && { moreSwells: swells.length - 40 }) }),
          ...(open.length && { speechNotUnder: open.slice(0, 20).map(s => ({ start: round3(s.start), end: round3(s.end) })),
            ...(open.length > 20 && { moreSpeechNotUnder: open.length - 20 }) }) };
      });
      const summary = { shape: { ...shape, ...(!stretches && { swellIn: gap }) }, under: stretches ? "stretches" : "speech", clips: report };
      const span = { start: Math.min(...placed.map(p => p.clip.timelineIn)), end: Math.max(...placed.map(p => clipEnd(p.clip))) };
      // One edit, over the clips it dips: Reject takes the dips back off them alone.
      const result = await propose({ intent, ops, description, reason,
        timelineEdits: [{ label: description, range: span, reason }] }, before);
      return { ...result, content: [...result.content, { type: "text" as const, text: JSON.stringify(summary) }] };
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

  /** The framings this run has saved and that are in the video: a later one over the same stretch takes the earlier one's place in the editor's list. */
  let framed: Array<{ changeId: string; mediaId: string; trackId?: string; from: number; to: number }> = [];
  tool(
    "timeline_framing",
    "Frame a recording's picture on an area of it over a stretch of the edit: a zoom in on a pane, a move from one subject to the next, a pull back out. Each framing names the area that must be seen (`show`) from a timeline second (`at`), as [left, top, right, bottom] in percent of the SOURCE picture: the units of screen_text's boxes" + (caps.images ? " and media_frame's grid" : "") + ". Scarlet places the tightest frame of the video's shape around it, so the picture always fills the video with no background beside it, and keeps the area clear of any picture laid over the recording, such as a camera inset. `within` is the area the frame may show, one window for example: the frame grows into it and goes past it only when it has to. The same `show`, `within` and inset place the same frame again, so a framing you resend unchanged stays as it was while you change others. `inset` moves the picture laid over the recording to another corner of the video from that framing on, at the size and margins it has, travelling with the frame's move; it stays there through `to` unless a later framing moves it again. `inset` as `clear` leaves the choice of corner to what is on screen: the picture's own corner when it sits on none of the frame's text there, else a corner where it sits on none, and the result says which (`inset`) or that no corner is clear (`noCornerClearOfText`). The picture moves to each frame over `over` seconds (default 1; 0 is a straight cut), eased as `ease` says (in and out by default), and holds until the next framing or `to`; a move runs on across the cuts that split the footage into clips. The first framing moves from the frame already there when the footage plays on from before it, and otherwise starts on its frame. Clips of the recording outside the stretch keep their framing. The result gives each frame as placed: `frame` in percent of the source, `zoom`, `sourcePixels` (source pixels per pixel of the video; under 1 the picture is enlarged past its own detail), `holds` seconds, `hidden` (percent of `show` that a cover or the frame's edge hides), `beyondWithin` (percent of the frame past `within`, by side) with `insideWithin` (the largest frame that stays inside it, and the percent of `show` that one hides), `covers` (other pictures over the video there, in percent of the video), `notOnPicture` when another picture fills the video there, and `text` where the recording's text has been read (screen_text reads it): the lines in `show`, their smallest and usual height in pixels of the video, any a cover sits on (`underCover`), and the corners where the cover would sit on none (`cornersClearOfText`); `textUnderCover` lists the framings that have such lines." + (caps.images ? ` With a picture of the video at each frame's settled moment, ${FRAMING_PICTURES} a call starting at \`picturesFrom\`.` : "") + " `preview` works all of this out and shows it without saving. A framing saved over a stretch this request already framed takes that edit's place in the editor's list, unless you give `timelineEdits`. For a crop with the background showing, an inset or a rotation, use timeline_propose's updateClip.",
    {
      intent: intentInput,
      mediaId: z.string().describe("The recording whose picture to frame"),
      trackId: z.string().optional().describe("Only its clips on this track"),
      framings: z.array(z.object({
        at: z.number().finite().nonnegative().describe("Timeline seconds where the picture starts moving to this frame"),
        show: percentBox.describe("The area that must be seen: [left, top, right, bottom] in percent of the source picture"),
        within: percentBox.optional().describe("The area the frame may show, in the same units"),
        over: z.number().finite().min(0).max(30).default(1).describe("Seconds the move takes; 0 cuts straight to the frame"),
        ease: z.enum(MOVE_EASES).optional().describe("How the move speeds up and settles: easeInOut (the default) starts and settles gently, easeOut starts quickly and settles, easeIn starts gently and arrives quickly, linear moves at one speed"),
        inset: z.enum([...CORNERS, "clear"]).optional().describe("Move the picture laid over the recording to this corner of the video from here on, or `clear` for a corner where it sits on none of the frame's text"),
      })).min(1).max(300).describe("In time order"),
      to: z.number().finite().positive().optional().describe("Timeline seconds where the last frame stops holding. Defaults to the end of the recording's last clip."),
      preview: z.boolean().optional().describe("Work out the frames and show them without saving"),
      ...(caps.images && { picturesFrom: z.number().int().nonnegative().optional().describe("Index of the first framing to picture") }),
      description: z.string().min(1).default("Framed the picture on what is being shown").describe("One short sentence for the chat about what the editor will see"),
      reason: editReasonInput,
      timelineEdits: timelineEditsInput,
      noteIds: z.array(z.string()).optional(),
      fromVersion: z.string().optional().describe("Version the framing applies to. Defaults to the version you last read."),
    },
    async ({ intent, mediaId, trackId, framings, to, preview, description, reason, timelineEdits, noteIds, fromVersion, ...rest }) => {
      const picturesFrom = (rest as { picturesFrom?: number }).picturesFrom ?? 0;
      const { project } = await getProject();
      const before = fromVersion ? await peekTimeline(fromVersion) : await baseTimeline();
      if (before.version === "draft") throw new Error("There is no saved timeline to frame yet.");
      const fraction = (box: readonly number[]) => box.map(n => n / 100) as Box;
      const percent = (box: readonly number[]) => box.map(pct1);
      // Where each framing puts the inset: the corner it names, or for `clear` the one worked out below.
      const corners: Array<Corner | undefined> = framings.map(f => f.inset === "clear" ? undefined : f.inset);
      // A framing with no `within` takes the area viewers may see at its footage, where one is on record (screen_area).
      let withinOnRecord: Array<Box | undefined> = [];
      const place = () => framingOps(before, project.media, project.settings,
        framings.map((f, i) => ({ at: f.at, show: fraction(f.show), within: f.within ? fraction(f.within) : withinOnRecord[i], over: f.over, ...(f.ease && { ease: f.ease }), inset: corners[i] })), { mediaId, trackId, to });
      let plan = place();
      const areasOnRecord = await recordingAreas(mediaId, 5).catch(() => undefined);
      if (areasOnRecord?.done && areasOnRecord.areas.length) {
        withinOnRecord = framings.map((f, i) => {
          const at = plan.frames[i]?.sourceTime;
          return f.within || at === undefined ? undefined : areasOnRecord.areas.find(a => a.holds.some(([from, to]) => at >= from - 1e-6 && at < to + 1e-6))?.area;
        });
        if (withinOnRecord.some(Boolean)) plan = place();
      }

      // What the recording's text says about each frame, where it has been read. A frame whose inset is to sit clear of
      // text waits a little for a reading; nothing else here waits for one.
      const lines = await Promise.all(plan.frames.map(async (f, i) => {
        if (f.notOnPicture) return undefined;
        try {
          const read = await client.get<{ done: boolean; spans: Array<{ text: string; box: [number, number, number, number] }> }>(
            `/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(mediaId)}/screen-text?from=${f.sourceTime}&to=${f.sourceTime + 1}&wait=${framings[i]!.inset === "clear" ? 20 : 2}`);
          return read.done ? read.spans : undefined;
        } catch { return undefined; }
      }));
      // `clear`: the inset's own corner when no text of the frame is under it there, else the corner it is in, else
      // another with none. Moving it moves the frame that keeps `show` clear of it, so each choice is checked again
      // on the frames it makes.
      const home = plan.frames.map(f => f.covers[0] && cornerOf(f.covers[0]));
      const noneClear = new Set<number>();
      if (framings.some(f => f.inset === "clear")) for (let pass = 0; pass < 3; pass++) {
        let moved = false;
        noneClear.clear();
        framings.forEach((f, i) => {
          const frame = plan.frames[i]!, spans = lines[i];
          if (f.inset !== "clear" || !spans || frame.notOnPicture || !frame.covers.length) return;
          const here = cornerOf(frame.covers[0]!);
          const chosen = [...new Set([home[i] ?? here, here, ...CORNERS])].find(corner => !coverOnText(frame.frame, frame.covers.map(c => boxInCorner(c, corner)), spans));
          if (!chosen) noneClear.add(i);
          else if (chosen !== here) { corners[i] = chosen; moved = true; }
        });
        if (!moved) break;
        plan = place();
      }
      const report = plan.frames.map((f, i) => {
        const show = fraction(framings[i]!.show);
        const [, ft, , fb] = f.frame, fh = fb - ft;
        const inside = (box: readonly number[], x: number, y: number) => x >= box[0]! && x <= box[2]! && y >= box[1]! && y <= box[3]!;
        const spans = lines[i]?.map(s => ({ ...s, x: (s.box[0] + s.box[2]) / 2, y: (s.box[1] + s.box[3]) / 2 }));
        const shown = spans?.filter(s => inside(show, s.x, s.y));
        const heights = shown?.map(s => Math.round((s.box[3] - s.box[1]) / fh * project.settings.height)).sort((a, b) => a - b);
        const under = spans?.filter(s => coverOnText(f.frame, f.covers, [s]));
        // The corners the covers could sit in with no line of the frame's text under them.
        const clear = !under?.length ? undefined : CORNERS.filter(corner => !coverOnText(f.frame, f.covers.map(c => boxInCorner(c, corner)), spans!));
        return {
          at: f.at, arrives: f.arrives, settles: f.settles, holds: f.holds, frame: percent(f.frame), zoom: round2(f.zoom), sourcePixels: round2(f.sourcePixels),
          ...(f.hidden >= 0.005 && { hidden: Math.round(f.hidden * 100) }),
          ...(f.beyondWithin && { beyondWithin: Object.fromEntries(Object.entries(f.beyondWithin).map(([side, share]) => [side, Math.round(share * 100)])) }),
          ...(f.insideWithin && { insideWithin: { frame: percent(f.insideWithin.frame), hidden: Math.round(f.insideWithin.hidden * 100) } }),
          ...(f.covers.length && { covers: f.covers.map(percent) }),
          ...(framings[i]!.inset && f.covers.length && { inset: cornerOf(f.covers[0]!) }),
          ...(noneClear.has(i) && { noCornerClearOfText: true }),
          ...(f.notOnPicture && { notOnPicture: true }),
          ...(heights && { text: heights.length
            ? { lines: heights.length, smallest: heights[0], usual: heights[Math.floor(heights.length / 2)],
              ...(under?.length && { underCover: under.slice(0, 5).map(s => s.text.slice(0, 60)), ...(under.length > 5 && { underCoverMore: under.length - 5 }), cornersClearOfText: clear }) }
            : { lines: 0 } }),
        };
      });

      const unread = plan.frames.filter((f, i) => !f.notOnPicture && !lines[i]).length;
      const covered = report.flatMap((f, i) => typeof f.text === "object" && "underCover" in f.text && f.text.underCover ? [i] : []);
      // One edit for the stretch, in the model's own words, unless it listed its own. A run looks at a framing once it
      // is saved and frames the stretch again: 16 saves for 11 demos on one run (2026-11-16), each a row in the editor's
      // list. A save over a stretch an earlier one of this run framed revises that row.
      const stretch = { start: framings[0]!.at, end: Math.min(to ?? Infinity, Math.max(...plan.frames.map(f => f.settles + f.holds))) };
      // Of the earlier framings this one covers, the longest is the row it revises.
      const earlier = !taskId ? [] : framed.filter(f => f.mediaId === mediaId && f.trackId === trackId && stretch.start <= f.from + 0.05 && stretch.end >= f.to - 0.05)
        .sort((a, b) => (b.to - b.from) - (a.to - a.from));
      const edits = timelineEdits ?? (reason && stretch.end > stretch.start
        ? [{ label: description.slice(0, 180), range: stretch, reason, ...(earlier.length && { replaces: { changeId: earlier[0]!.changeId, spot: 0 } }) }] : undefined);
      const save = (timelineEdits: typeof edits) => propose({ intent, ops: plan.ops, description, reason, noteIds, timelineEdits }, before);
      // An earlier framing the editor has since undone, or another request changed, is no longer this run's to revise: the framing is saved as its own edit.
      const saved = preview ? undefined : await save(edits).catch(error => {
        if (!(error instanceof ScarletApiError && error.code === "invalid_replacement") || timelineEdits) throw error;
        return save(edits?.map(({ replaces: _replaces, ...edit }) => edit));
      });
      if (saved && !saved.isError) {
        const change = JSON.parse((saved.content[0] as { text: string }).text) as { changeId: string; state: string; notApplied?: unknown };
        if (change.state === "approved" && !change.notApplied) {
          framed = [...framed.filter(f => f !== earlier[0]), { changeId: change.changeId, mediaId, trackId, from: stretch.start, to: stretch.end }];
        }
      }
      const content: ToolResult["content"] = [...(saved?.content ?? []),
        { type: "text", text: JSON.stringify({ ...(preview && { preview: true, saved: false }), mediaId, clips: plan.clips, ...(plan.insetClips && { insetClips: plan.insetClips }),
          // Named once ahead of the list: among a hundred framings, the few with text under a cover were read past.
          ...(covered.length && { textUnderCover: covered }), video: `${project.settings.width}x${project.settings.height}`, framings: report,
          ...(unread && { textUnread: `The recording's text at ${unread} of these frames isn't read yet. It is being read now: a later call, or a preview, reports it.` }) }) }];
      if (caps.images && !saved?.isError) {
        const shown = plan.frames.map((f, index) => ({ f, index })).slice(picturesFrom, picturesFrom + FRAMING_PICTURES);
        // The picture a moment after the frame settles, and before it gives way to the next.
        const times = shown.map(({ f }) => f.settles + Math.min(0.1, f.holds / 2));
        try {
          const { pictures } = shown.length ? await client.timelinePictures(projectId, { version: before.version, ops: plan.ops as Array<Record<string, unknown>>, times }) : { pictures: [] };
          pictures.forEach((picture, n) => content.push(
            { type: "text", text: `framings[${shown[n]!.index}] at ${picture.time.toFixed(2)} s, as the video plays it:` },
            { type: "image", mimeType: "image/jpeg", data: picture.jpeg }));
          const next = picturesFrom + shown.length;
          if (next < plan.frames.length) content.push({ type: "text", text: `Pictures of framings ${picturesFrom}–${next - 1}. picturesFrom ${next} with preview shows the next ${Math.min(FRAMING_PICTURES, plan.frames.length - next)}.` });
        } catch (error) {
          noteUnmeasured("pictures of the framed video", error);
        }
      }
      return { content };
    },
  );

  tool(
    "timeline_first_cut",
    "Replace the whole timeline with SOURCE keeps in the supplied playback order. For dialogue, {fromWord,toWord} keeps those inclusive transcript_get word indices and places their edges in measured quiet. Split adjacent words into separate keeps to tighten their pause to `leave`. For picture, reordered jumps, or a boundary that needs review, supply exact source seconds as start/end on the affected keeps. {start,end} alone keeps an exact passage. The first and last source words keep the recording head and tail unless you give those handles. With synced A1 audio or audible layer sound, word indices belong to the recording that is heard. `layer` adds a second recording of the same event (a camera beside a screen capture) on a video track above V1, in sync at the offset audio_sync measured with mediaId as the reference: each keep range plays the same moment of both, wherever the layer has footage, as an inset in the bottom-right corner, placed on the presenter where `faces` finds one face: `presenter` sets how much of them it shows, its shape, size and corners as the editor's skill asks (head and shoulders at a quarter size when omitted), or `framing` sets its transform outright. One recording is heard: mediaId's, or the layer's with `sound`. `audioMediaId` places a separate audio recording on A1 with the same ranges and mutes the video clips; use it only when it shares mediaId's timebase. `crossfade` adds that many seconds of audio fade in/out on each clip. For centered audio joins, leave crossfade unset. After the assembly is applied, timeline_get returns its clip IDs for timeline_crossfade_audio, which keeps this assembly separately reviewable. Each keep edge is measured on the recording that is heard: one that would leave a piece of a sound playing moves onto the quiet that ends it, 0.12 s away at most, and comes back in `movedEdges`; one inside a sounding word saves nothing and is named with what was measured.",
    {
      intent: intentInput,
      mediaId: z.string().describe("Video (or audio-only) media to cut from"),
      keep: z
        .array(z.object({
          fromWord: z.number().int().nonnegative().optional(), toWord: z.number().int().nonnegative().optional(),
          start: z.number().finite().nonnegative().optional(), end: z.number().finite().nonnegative().optional(), label: z.string().optional(),
        }).refine(r => r.fromWord !== undefined || r.toWord !== undefined ? r.fromWord !== undefined && r.toWord !== undefined
          : r.start !== undefined && r.end !== undefined, "Give both kept word indices, or both source seconds."))
        .min(1)
        .describe("Ordered keeps from the same source. start/end on an indexed keep fix just those source handles."),
      layer: z.object({
        mediaId: z.string().describe("The second video recording"),
        offset: z.number().finite().describe("Seconds it starts after mediaId (negative = earlier): audio_sync's offset with mediaId as referenceId"),
        sound: z.boolean().optional().describe("Hear this recording instead of mediaId's"),
        presenter: InsetPresenter.optional().describe("How the inset holds the presenter, from the editor's skill"),
        framing: InsetFraming.optional().describe("Scale and center-relative x/y of its picture, with optional crop and cornerRadius, in place of the inset placed on the presenter"),
      }).optional().describe("A second simultaneous recording, inset above the first"),
      audioMediaId: z.string().optional().describe("Separate audio recording synced to the video (same source timebase)"),
      crossfade: z.number().min(0).max(2).optional().describe("Audio fade in/out per clip, seconds"),
      pace: paceInput,
      leave: z.number().finite().min(0.05).max(10).optional().describe("Seconds the pause between two adjacent keeps still plays, word to word, as the editor hears it. Omitted: pace's after and before together."),
      description: z.string().min(1).describe("Description for the reviewer"),
      reason: editReasonInput,
      noteIds: z.array(z.string()).optional(),
    },
    async ({ intent, mediaId, keep, layer, audioMediaId, crossfade, pace, leave, description, reason, noteIds }) => {
      const detail = session.lastTimeline ? { ...await getProject(), timeline: session.lastTimeline } : await client.workspace(projectId);
      const before = detail.timeline ?? await headTimelineOrNull();
      const media = requireMediaAsset(detail.project, mediaId);
      const audio = audioMediaId ? requireMediaAsset(detail.project, audioMediaId, "Audio media") : media;
      const second = layer ? requireMediaAsset(detail.project, layer.mediaId, "Layer media") : undefined;
      if (layer && second) {
        if (second.kind !== "video" || second.id === mediaId) throw new Error("The layer is a second video recording, not mediaId itself or a sound recording. A separate sound recording goes in audioMediaId.");
        if (!second.duration) throw new Error(`The length of ${layer.mediaId} isn't known yet, so it can't be placed in sync. Try again once it has been read.`);
        if (layer.sound && audioMediaId) throw new Error("Choose one sound: the layer's (sound) or the separate recording (audioMediaId).");
        if (layer.presenter && layer.framing) throw new Error("Give the layer presenter or framing, not both.");
      }
      const anchor = task?.context;
      if (before?.tracks.some(t => t.clips.length) && selectedRange(anchor))
        throw new Error("A whole-timeline replacement exceeds the scoped selection. Submit the local removals on the existing timeline.");
      const staged = keep.some(r => r.fromWord !== undefined) && await useStagedCut();
      if (staged) throw staged;
      const indexedLayer = layer?.sound && second && keep.some(r => r.fromWord !== undefined);
      const offset = indexedLayer ? layer!.offset : 0;
      const handles = offset ? keep.map(r => ({
        ...r, start: r.start === undefined ? undefined : r.start - offset,
        end: r.end === undefined ? undefined : r.end - offset,
      })) : keep;
      const placed = await firstCutRanges(handles, projectId, indexedLayer ? second! : audio, { ...planSources, pace }, leave);
      const ranges = offset ? placed.ranges.map(r => ({ ...r, start: r.start + offset, end: r.end + offset })) : placed.ranges;
      const placement = placed.evidence;
      if (anchor?.mediaId && anchor.time !== undefined && anchor.end !== undefined &&
          (mediaId !== anchor.mediaId || ranges.some(r => r.start < anchor.time! || r.end > anchor.end!)))
        throw new Error("Keep ranges must be inside the selected source passage.");
      const problems: string[] = [];
      ranges.forEach((r, i) => {
        if (r.end <= r.start) problems.push(`keep[${i}]: end (${r.end}) must be greater than start (${r.start})`);
        if (media.duration !== undefined && r.end > media.duration + 0.01) {
          problems.push(`keep[${i}]: end ${r.end} exceeds media duration ${media.duration}`);
        }
      });
      if (problems.length) return errorText(`Invalid keep ranges:\n${problems.map((p) => `- ${p}`).join("\n")}`);
      // The layer plays the source seconds of the keeps, `offset` later in its own recording.
      const preset = layer && second && !layer.framing ? await presetInsetOver(detail.project, second,
        Math.max(0, Math.min(...ranges.map(r => r.start)) - layer.offset), Math.min(second.duration!, Math.max(...ranges.map(r => r.end)) - layer.offset), layer.presenter) : undefined;
      const build = () => timelineFromKeepRanges(projectId, mediaId, ranges, { audioMediaId, crossfade,
        layer: layer && second ? { mediaId: second.id, offset: layer.offset, duration: second.duration!, sound: layer.sound,
          transform: Transform.parse(layer.framing ?? preset!.framing) } : undefined });
      // Check the audible picture and audio edges of the assembled timeline, including the edges supplied in seconds. One that
      // leaves a piece of a sound playing goes onto the quiet that ends the piece, a fragment's length away at most,
      // and is reported. One inside a sounding word is the model's to move: which side of the word it meant is its call.
      const movedEdges: Array<{ keep: number; edge: "start" | "end"; from: number; to: number; evidence: string }> = [];
      const measure = (timeline: Timeline) => edgesInSound(null, timeline).catch(withoutUnlessPreparing("failed to measure the first cut's edges", [] as SoundingEdge[]));
      /** Which keep range a clip of the built timeline plays: they lie end to end in the order given. */
      const rangeOf = (timeline: Timeline, clipId: string) => {
        const clip = timeline.tracks.flatMap(t => t.clips).find(c => c.id === clipId);
        let cursor = 0;
        for (const [i, r] of ranges.entries()) {
          if (clip && clip.timelineIn >= cursor - 1e-6 && clip.timelineIn < cursor + (r.end - r.start) - 1e-6) return i;
          cursor += r.end - r.start;
        }
        return -1;
      };
      let tl = build();
      let sounding = await measure(tl);
      if (sounding.some(e => e.fragment)) {
        for (const e of sounding) {
          const i = e.fragment ? rangeOf(tl, e.clipId) : -1, r = ranges[i];
          if (!r || !e.fragment) continue;
          const edge = e.side === "in" ? "start" : "end", to = round3(r[edge] + e.fragment.quietAt - e.source);
          if (e.side === "in" ? to >= r.end - .05 : to <= r.start + .05) continue;
          movedEdges.push({ keep: i, edge, from: r[edge], to, evidence: `${Math.round(e.fragment.seconds * 1000)} ms of ${e.word ? `“${e.word}”` : "a sound the transcript has no word for"} played at ${e.fragment.db} dBFS; quiet there is ${e.fragment.quietDb} dBFS` });
          r[edge] = to;
        }
        tl = build();
        sounding = await measure(tl);
      }
      if (sounding.length) throw new Error(sounding.slice(0, 12).map(e => {
        const i = rangeOf(tl, e.clipId);
        return edgeInSoundText(e, i < 0 ? `clip ${e.clipId}` : `keep[${i}]`);
      }).join("; ") + `${sounding.length > 12 ? `; and ${sounding.length - 12} more` : ""}. Nothing was saved. Move each edge onto quiet: source seconds here are those of the recording that is heard.`);
      const result = await propose({ intent, timeline: tl, firstCut: true, description, reason, noteIds }, before);
      const total = ranges.reduce((acc, r) => acc + (r.end - r.start), 0);
      // What the layer covers is evidence: a wrong offset or a short recording shows here, before anything is cut.
      const inset = tl.tracks.find(t => t.id === "v2")?.clips ?? [];
      const covered = inset.reduce((acc, c) => acc + (c.kind === "media" ? c.sourceOut - c.sourceIn : 0), 0);
      return {
        ...result,
        content: [
          { type: "text", text: `First edit: ${ranges.length} clip(s), ${total.toFixed(2)} s total${media.duration ? ` from ${media.duration.toFixed(2)} s of source` : ""}.` +
            (layer ? ` Layer ${layer.mediaId}: ${covered.toFixed(2)} s of the ${total.toFixed(2)} s inset on V2 in ${inset.length} clip(s)${total - covered > 0.01 ? `; it has no footage for the other ${(total - covered).toFixed(2)} s, where ${mediaId} plays alone` : ""}.` : "") },
          ...(preset ? [{ type: "text" as const, text: presetInsetText(second!.id, preset, layer?.presenter) }] : []),
          ...(movedEdges.length ? [{ type: "text" as const, text: JSON.stringify({ movedEdges }) }] : []),
          ...(placement.length ? [{ type: "text" as const, text: placement.join("\n") }] : []),
          ...result.content,
        ],
      };
    },
  );

  tool(
    "captions_generate",
    "Generate a caption track from the transcript, mapped through the CURRENT edit: for audible clips by default (or all enabled placements of an explicitly named mediaId) the words inside its kept source range are placed at the matching timeline time; words that were cut out are dropped. Groups words into caption clips of at most `maxWords` words / `maxChars` characters with per-word timings (karaoke highlighting possible). The result gives each caption's reading rate: the median and the five fastest, in characters a second, with their timeline times. Choose a destination when caption tracks already exist. Replacing one track preserves the others. `style` is a partial CaptionStyle: fontFamily, fontSize (fraction of canvas height, e.g. 0.05), color, backgroundColor, outlineColor, outlineWidth, y (0..1 from top, 0.85 = lower third), align, maxWidth, uppercase, highlightColor.",
    {
      mediaId: z.string().optional(),
      intent: intentInput,
      maxWords: z.number().int().positive().default(5).describe("Most words in one caption (5 when omitted). The skill's caption size sets it."),
      maxChars: z.number().int().positive().default(32).describe("Most characters in one caption, all its lines together (32 when omitted, about one short line); the style's maxWidth wraps it into lines. The skill's caption size sets it."),
      readingRate: z.number().finite().min(5).max(40).optional().describe("Characters a second a viewer reads: each caption stays up until it can be read at this rate, past its last word if need be, and never into the next caption. Omitted, a caption ends with its last word."),
      sentences: z.boolean().optional().describe("End each caption with its sentence, so none carries the end of one into the start of the next."),
      style: CaptionStyle.partial().optional(),
      maxGap: z.number().finite().nonnegative().optional().describe("Longest inter-word gap within a cue, in seconds (default 0.8)."),
      destination: z.union([z.literal("new"), z.object({ replaceTrackId: z.string().min(1) })]).optional().describe("Create a new caption track or replace the cues of one named caption track."),
      trackName: z.string().optional(),
      description: z.string().min(1).default("Generate captions from the transcript"),
      reason: editReasonInput,
    },
    async ({ intent, mediaId, maxWords, maxChars, maxGap, readingRate, sentences, style, destination, trackName, description, reason }) => {
      const detail = await client.workspace(projectId);
      const head = detail.timeline;
      if (!head) throw new Error("The project has no timeline yet; assemble an edit before generating captions.");
      const tracks = head.tracks.filter(t => t.kind === "caption");
      if (!destination && tracks.length) return json({ version: head.version, needsDestination: true,
        captionTracks: tracks.map(t => ({ id: t.id, name: t.name, cues: t.clips.length })),
        next: "Choose destination new or supply replaceTrackId. No tracks were changed." });
      const target = typeof destination === "object" ? tracks.find(t => t.id === destination.replaceTrackId) : undefined;
      if (typeof destination === "object" && !target) throw new Error("Choose a caption track on the current version.");
      const sources = new Set(detail.project.media.filter(carriesAudio).map(m => m.id));
      const clips = captionSourceClips(head, id => sources.has(id), mediaId);
      const mediaIds = new Set(clips.map(c => c.mediaId));
      const mappers = new Map<string, ReturnType<typeof captionWordMapper>>();
      // A cue keeps the word times it is saved with, and nothing places them again. So the words must be where the
      // recording has them through the last second captioned: a transcript still being aligned says how far it has
      // come, and the captions are made on a later call. One wait covers every recording.
      const waitUntil = Date.now() + edgeWaitMs;
      for (const id of mediaIds) {
        const last = Math.max(...clips.filter(c => c.mediaId === id).map(c => c.sourceOut));
        const words = await transcriptWords(id, true, last + 1, Math.max(0, waitUntil - Date.now()));
        if (words) mappers.set(id, captionWordMapper(words));
      }
      if (!clips.length) {
        throw new Error(
          mediaId
            ? `no clips of media ${mediaId} with a transcript on the timeline`
            : `no clips of transcribed media on the timeline (name a mediaId from project_get to include its muted placements)`,
        );
      }
      const mapped: TranscriptWord[] = [];
      const skipped: string[] = [];
      for (const clip of clips) {
        const map = mappers.get(clip.mediaId);
        if (map) for (const word of map(clip)) mapped.push(word);
      }
      for (const id of mediaIds) if (!mappers.has(id)) skipped.push(id);
      const words = dedupeWords(mapped);
      if (!words.length) throw new Error(`No transcript words land on the current edit${skipped.length ? ` (no transcript for: ${skipped.join(", ")})` : ""}.`);
      const groups = captionsFromWords(words, { maxWords, maxChars, maxGap, minDuration: 0.1, readingRate, sentences });
      const captionClips: CaptionClip[] = groups.map((g) => ({
        id: newId("cap"),
        kind: "caption",
        timelineIn: g.start,
        timelineOut: g.end,
        text: g.text,
        words: g.words.map((w) => ({ text: w.text, start: w.start, end: Math.min(w.end, g.end) })),
        enabled: true,
      }));
      const ops: TimelineOp[] = [];
      if (target) ops.push({ op: "removeTrack", trackId: target.id });
      const track: Track = {
        id: target?.id ?? newId("cap"), kind: "caption", name: trackName ?? target?.name ?? "Captions",
        muted: target?.muted ?? false, hidden: target?.hidden ?? false,
        captionStyle: style ? { ...target?.captionStyle, ...style } : target?.captionStyle,
        clips: captionClips,
      };
      ops.push({ op: "addTrack", track, ...(target && { index: head.tracks.indexOf(target) }) });
      // The engine validates and applies these generated ops transactionally
      // against this base. Replaying the whole caption track here duplicates it.
      const result = await propose({ intent, ops, description, reason }, head);
      // How fast each caption asks to be read, in characters a second: a measurement for the model to judge, not a limit.
      const rates = captionClips.map(c => ({ at: c.timelineIn, cps: c.text.replace(/\s+/g, " ").trim().length / Math.max(c.timelineOut - c.timelineIn, 1e-3), text: c.text }));
      const sortedRates = rates.map(r => r.cps).sort((a, b) => a - b);
      const median = sortedRates.length ? sortedRates[Math.floor(sortedRates.length / 2)]! : 0;
      const fastest = [...rates].sort((a, b) => b.cps - a.cps).slice(0, 5)
        .map(r => `${r.at.toFixed(2)} s ${r.cps.toFixed(1)}/s "${r.text.replace(/\s+/g, " ").trim()}"`);
      return {
        ...result,
        content: [
          {
            type: "text",
            text: `${captionClips.length} caption clip(s) from ${words.length} words across ${clips.length} media clip(s)${skipped.length ? `; skipped media without transcript: ${skipped.join(", ")}` : ""}.` +
              (rates.length ? `\nReading rate in characters a second (timeline seconds): median ${median.toFixed(1)}; fastest ${fastest.join("; ")}.` : ""),
          },
          ...result.content,
        ],
      };
    },
  );
}
