/**
 * The timeline tools whose ops Scarlet works out itself from what it measured: timeline_framing (a zoom or move on an
 * area of a recording), timeline_first_cut (an assembly from the transcript) and captions_generate (captions from the
 * words heard).
 */
import { z } from "zod/v3";
import {
  ScarletApiError,
  selectedRange,
  type AgentCapabilities,
  type ScarletClient,
  type Task,
} from "@scarlet/shared";
import {
  CaptionStyle,
  captionsFromWords,
  carriesAudio,
  newId,
  timelineFromKeepRanges,
  Transform,
  type CaptionClip,
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
} from "./analysis.js";
import { firstCutRanges } from "./first-cut-ranges.js";
import { boxInCorner, cornerOf, CORNERS, coverOnText, framingOps, MOVE_EASES, type Box, type Corner } from "./framing.js";
import {
  editReasonInput,
  makeIntentInput,
  paceInput,
  percentBox,
  timelineEditsInput,
} from "./mcp-schema.js";
import type { MediaSession, SoundingEdge } from "./media-session.js";
import { requireMediaAsset, type SessionErrorHelpers } from "./media-state.js";
import type { ProposePipeline } from "./propose-pipeline.js";
import { InsetFraming, InsetPresenter } from "./sync-layout.js";
import { errorText, json, noteUnmeasured, type ToolRegistrar, type ToolResult } from "./tool-result.js";

/** Pictures of framings one call returns. */
const FRAMING_PICTURES = 12;

export interface TimelineGenerateToolsDeps {
  tool: ToolRegistrar;
  client: ScarletClient;
  projectId: string;
  taskId?: string;
  task?: Task;
  caps: AgentCapabilities;
  session: MediaSession;
  errors: SessionErrorHelpers;
  proposePipeline: ProposePipeline;
  useStagedCut(): Promise<Error | undefined>;
}

export function registerTimelineGenerateTools(deps: TimelineGenerateToolsDeps) {
  const { tool, client, projectId, taskId, task, caps, session, errors, proposePipeline, useStagedCut } = deps;
  const { getProject, peekTimeline, baseTimeline, headTimelineOrNull, transcriptWords, edgesInSound, edgeInSoundText, planSources, edgeWaitMs } = session;
  const { withoutUnlessPreparing } = errors;
  const { recordingAreas, propose, presetInsetOver, presetInsetText } = proposePipeline;
  const intentInput = makeIntentInput(Boolean(taskId));

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
    "Replace the timeline with SOURCE keeps (for assembly, syncing, or reordering; on an assembled recording, cut dialogue with dialogue_apply_cuts instead). For dialogue, {fromWord,toWord} keeps those inclusive transcript_get word indices and places their edges in measured quiet. Split adjacent words into separate keeps to tighten their pause to `leave`. For picture, reordered jumps, or a boundary that needs review, supply exact source seconds as start/end on the affected keeps. {start,end} alone keeps an exact passage. The first and last source words keep the recording head and tail unless you give those handles. With synced A1 audio or audible layer sound, word indices belong to the recording that is heard. `layer` adds a second recording of the same event (a camera beside a screen capture) on a video track above V1, in sync at the offset audio_sync measured with mediaId as the reference: each keep range plays the same moment of both, wherever the layer has footage, as an inset in the bottom-right corner, placed on the presenter where `faces` finds one face: `presenter` sets how much of them it shows, its shape, size and corners as the editor's skill asks (head and shoulders at a quarter size when omitted), or `framing` sets its transform outright. One recording is heard: mediaId's, or the layer's with `sound`. `audioMediaId` places a separate audio recording on A1 with the same ranges and mutes the video clips; use it only when it shares mediaId's timebase. `crossfade` adds that many seconds of audio fade in/out on each clip. For centered audio joins, leave crossfade unset. After the assembly is applied, timeline_get returns its clip IDs for timeline_crossfade_audio, which keeps this assembly separately reviewable. Each keep edge is measured on the recording that is heard: one that would leave a piece of a sound playing moves onto the quiet that ends it, 0.12 s away at most, and comes back in `movedEdges`; one inside a sounding word saves nothing and is named with what was measured.",
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
        // Each edge's keep is found before any range moves: the ranges place the clips of the timeline as built.
        const keeps = sounding.map(e => e.fragment ? rangeOf(tl, e.clipId) : -1);
        for (const [n, e] of sounding.entries()) {
          const i = keeps[n]!, r = ranges[i];
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
