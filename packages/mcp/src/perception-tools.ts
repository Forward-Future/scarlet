/**
 * Read-only tools that let any model verify an edit from measurements: the edited transcript in
 * playback order, a deterministic audit of each join, version diffs and a per-media profile.
 */
import { z } from "zod/v3";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ScarletApiError, type ProjectDetail, type ScarletClient, type ScarletToolName, type WaveformResponse } from "@scarlet/shared";
import { timelineDuration, type Project, type Timeline, type TimeRange, type TranscriptWord } from "@scarlet/timeline";
import { auditJoin, formatTimelineTranscript, heardOnlyVerbatim, joinTook, newJoins, timelineJoins, timelineWords, type HeardOnly, type JoinAudit, type TimelineJoin, type TimelineWord } from "./timeline-perception.js";
import { pictureEntranceReader } from "./picture-entrance.js";
import { levelProfile, pauseStats, retakeGroups } from "./media-profile.js";
import { json, noteEvidenceMiss, text } from "./tool-result.js";
import { OTHER_INPUT } from "./analysis.js";
import { screenReadings, type ScreenLine } from "./screen-reading.js";
import { motionSpans, type DetailFrame, type MotionSecond } from "./screen-motion.js";
import type { RecordingCut } from "./brief-pictures.js";

type ToolRegistrar = <Shape extends z.ZodRawShape>(name: ScarletToolName, description: string, shape: Shape,
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<CallToolResult>) => void;

interface PerceptionDeps {
  tool: ToolRegistrar;
  client: ScarletClient;
  projectId: string;
  /**
   * A version read to measure or compare, which leaves the base of the agent's next edit alone. Every read here is one:
   * only timeline_get, timeline_at and project_get move that base.
   */
  peekTimeline(version: string): Promise<Timeline>;
  /** The portion of an edited transcript actually returned to the agent. */
  readPassage(version: string, range: { start: number; end: number }): void;
  getProject(): Promise<Pick<ProjectDetail, "project">>;
  /**
   * A media's words in transcript_get order (index = stable word index), or null without a transcript.
   * With `through`, only words whose times are final up to that source second: it rejects while alignment hasn't reached it.
   */
  transcriptWords(mediaId: string, prepareMissing?: boolean, through?: number): Promise<TranscriptWord[] | null>;
  /** Of these words of a recording (transcript index, source seconds), the ones heard only on the input its dialogue isn't on. */
  otherInputWords?(mediaId: string, words: Array<{ index: number; start: number; end: number }>): Promise<Set<number>>;
  /** Note the list a tool showed the model word indices from, so a reference read from it resolves against the same list. */
  showWords?(mediaId: string, words: readonly TranscriptWord[]): void;
  /** The source second up to which a media's word times, as last read, are final. Infinity once they all are, and for a media with no transcript. */
  settledThrough(mediaId: string): number;
  /** 20 ms levels with voice activity for a source window. */
  readLevels(mediaId: string, from: number, to: number): Promise<WaveformResponse>;
  /** Levels without voice activity, at any resolution, preparing a missing waveform. */
  readWaveform(mediaId: string, from: number, to: number, points: number): Promise<WaveformResponse>;
  /** Note on stderr a read that failed and was answered without. Media still being prepared is not one. */
  unavailable(what: string, err: unknown): void;
  /** Whether this run has the frame tools: its harness shows the model images and the editor left them on. */
  seesFrames: boolean;
}

/** Outgoing side: what was heard before the join and what was removed after it. */
const OUT_WINDOW = [1, .3] as const;
const IN_WINDOW = [.3, 1] as const;
const MAX_AUDITS = 40;

export function registerPerception(deps: PerceptionDeps) {
  const { tool, client } = deps;
  const without = <T>(what: string, fallback: T) => (err: unknown) => { deps.unavailable(what, err); return fallback; };

  async function wordsFor(tl: Timeline, project: Project) {
    const ids = new Set<string>();
    for (const t of tl.tracks) for (const c of t.clips) if (c.kind === "media") ids.add(c.mediaId);
    const spoken = [...ids].filter(id => {
      const m = project.media.find(x => x.id === id);
      return m && (m.kind === "audio" || m.hasAudio);
    });
    const map = new Map<string, TranscriptWord[]>();
    for (const id of spoken) {
      const words = await deps.transcriptWords(id, false);
      if (words) map.set(id, words);
    }
    // Nothing transcribed yet: prepare the sources the edit plays.
    if (!map.size) for (const id of spoken) {
      const words = await deps.transcriptWords(id, true);
      if (words) map.set(id, words);
    }
    return map;
  }

  /**
   * The recordings whose picture plays in a range of a timeline and their source seconds there: `mediaId`, or by default
   * every one whose sound isn't heard (the screen beside a camera), else every one.
   */
  function pictureSources(tl: Timeline, project: Project, range: { start: number; end: number }, heardFrom: ReadonlySet<string>, mediaId?: string) {
    const pictures = new Map<string, Array<{ sourceIn: number; sourceOut: number }>>();
    for (const track of tl.tracks) if (track.kind === "video" && !track.hidden) for (const c of track.clips) {
      if (c.kind !== "media" || c.enabled === false || project.media.find(m => m.id === c.mediaId)?.kind !== "video") continue;
      if (c.timelineIn > range.end || c.timelineIn + (c.sourceOut - c.sourceIn) / (c.speed ?? 1) < range.start) continue;
      pictures.set(c.mediaId, [...pictures.get(c.mediaId) ?? [], c]);
    }
    if (mediaId && !pictures.has(mediaId)) throw new Error(`${mediaId}'s picture doesn't play in ${range.start.toFixed(1)}-${range.end.toFixed(1)} s of version ${tl.version}.`);
    const shown = mediaId ? [mediaId] : [...pictures.keys()].filter(id => !heardFrom.has(id));
    return (shown.length ? shown : [...pictures.keys()]).map(id => {
      const clips = pictures.get(id)!;
      return { id, from: Math.max(0, Math.min(...clips.map(c => c.sourceIn)) - 1), to: Math.max(...clips.map(c => c.sourceOut)) + 1 };
    });
  }

  /** A picture reading of each recording (`screen-text`, `screen-motion`, `picture-cuts`), waiting up to `wait` seconds for what isn't read yet. */
  async function readPictures<T>(kind: "screen-text" | "screen-motion" | "picture-cuts", sources: Array<{ id: string; from: number; to: number }>, wait: number) {
    const reads = await Promise.all(sources.map(async ({ id, from, to }) => ({ id,
      read: await client.get<{ from: number; to: number; readSeconds: number; done: boolean; error?: string } & T>(
        `/projects/${encodeURIComponent(deps.projectId)}/media/${encodeURIComponent(id)}/${kind}?from=${from}&to=${to}&wait=${wait}`) })));
    const what = kind === "screen-text" ? "its text" : kind === "picture-cuts" ? "its cuts" : "its picture's changes";
    const unread = reads.filter(({ read }) => !read.done).map(({ id, read }) =>
      `${id}: ${read.readSeconds.toFixed(0)} of ${(read.to - read.from).toFixed(0)} s of ${what} read so far${read.error ? `, stopped: ${read.error}` : ", still reading: call again for the rest"}`);
    return { reads, unread };
  }

  /**
   * The readings aloud from the screen on a timeline (screen_reading), with how far each recording's text is read.
   * `wait` is how many seconds a text not read yet may hold the answer. Undefined when the timeline plays no transcribed speech.
   */
  async function readingsOn(tl: Timeline, project: Project, range: { start: number; end: number }, opts: { mediaId?: string; wait: number }) {
    const transcripts = await wordsFor(tl, project);
    if (!transcripts.size) return undefined;
    const heard = timelineWords(tl, transcripts, range);
    const sources = pictureSources(tl, project, range, new Set(heard.map(w => w.mediaId)), opts.mediaId);
    const { reads, unread } = await readPictures<{ spans: ScreenLine[] }>("screen-text", sources, opts.wait);
    const readings = screenReadings(tl, heard, new Map(reads.map(({ id, read }) => [id, read.spans])))
      .filter(r => r.to >= range.start && r.from <= range.end);
    return { readings, ids: sources.map(s => s.id), unread };
  }

  /** Where the picture of each screen recording changes on a timeline (screen_motion), with how far each is read. */
  async function motionOn(tl: Timeline, project: Project, range: { start: number; end: number }, opts: { mediaId?: string; wait: number }) {
    const transcripts = await wordsFor(tl, project).catch(() => new Map<string, TranscriptWord[]>());
    const heard = new Set(transcripts.size ? timelineWords(tl, transcripts, range).map(w => w.mediaId) : []);
    const sources = pictureSources(tl, project, range, heard, opts.mediaId);
    const { reads, unread } = await readPictures<{ seconds: MotionSecond[] }>("screen-motion", sources, opts.wait);
    return { spans: motionSpans(tl, new Map(reads.map(({ id, read }) => [id, read.seconds])), range), ids: sources.map(s => s.id), unread };
  }

  /**
   * What recordings show over ranges of their source seconds, whether or not their picture plays there (their text and
   * where their picture changes), with the words heard over a range of the timeline: the evidence for the video beside a
   * framed stretch.
   */
  async function besideOn(tl: Timeline, project: Project, sources: Array<{ id: string; from: number; to: number }>, range: { start: number; end: number }, wait: number,
    clocks: Array<{ id: string; from: number; to: number }> = []) {
    const videos = new Set(project.media.filter(m => m.kind === "video").map(m => m.id));
    const [text, motion, cuts, transcripts, eyes] = await Promise.all([
      readPictures<{ spans: ScreenLine[] }>("screen-text", sources, wait),
      readPictures<{ seconds: MotionSecond[]; detail?: DetailFrame[] }>("screen-motion", sources, wait),
      readPictures<{ cuts: RecordingCut[] }>("picture-cuts", sources, wait),
      wordsFor(tl, project).catch(() => new Map<string, TranscriptWord[]>()),
      // Where the speaker looks, in the picture of the recording heard beside each stretch: its face seen longest there.
      Promise.all(clocks.filter(c => videos.has(c.id)).map(async ({ id, from, to }) => {
        const read = await client.get<{ from: number; to: number; readSeconds: number; done: boolean; error?: string;
          tracks: Array<{ track: number; seconds: number }>; spans: Array<{ track: number; start: number; end: number; eyesDown?: number; box: number[] }> }>(
          `/projects/${encodeURIComponent(deps.projectId)}/media/${encodeURIComponent(id)}/faces?from=${from}&to=${to}&wait=${wait}`);
        const main = [...read.tracks].sort((a, b) => b.seconds - a.seconds)[0]?.track;
        return { id, spans: read.spans.filter(s => s.track === main),
          unread: read.done ? undefined : `${id}: ${read.readSeconds.toFixed(0)} of ${(read.to - read.from).toFixed(0)} s of its faces read so far${read.error ? `, stopped: ${read.error}` : ", still reading: call again for the rest"}` };
      })).catch(() => []),
    ]);
    return {
      evidence: {
        lines: new Map(text.reads.map(({ id, read }) => [id, read.spans])),
        seconds: new Map(motion.reads.map(({ id, read }) => [id, read.seconds])),
        detail: new Map(motion.reads.map(({ id, read }) => [id, read.detail ?? []])),
        cuts: new Map(cuts.reads.map(({ id, read }) => [id, read.cuts])),
        words: transcripts.size ? timelineWords(tl, transcripts, range) : [],
        eyes: new Map(eyes.map(e => [e.id, e.spans])),
      },
      unread: [...text.unread, ...motion.unread, ...cuts.unread, ...eyes.flatMap(e => e.unread ? [e.unread] : [])],
    };
  }

  /**
   * The cuts in each recording whose picture plays on a timeline and whose sound isn't the one heard (the screen beside
   * a camera, a clip laid over it), by media id, with the recordings not read through yet. `wait` seconds for those.
   */
  async function cutsOn(tl: Timeline, project: Project, opts: { wait: number }) {
    const transcripts = await wordsFor(tl, project).catch(() => new Map<string, TranscriptWord[]>());
    const heard = new Set(transcripts.size ? timelineWords(tl, transcripts).map(w => w.mediaId) : []);
    const sources = pictureSources(tl, project, { start: 0, end: timelineDuration(tl) }, heard).filter(s => !heard.has(s.id));
    const { reads, unread } = await readPictures<{ cuts: RecordingCut[] }>("picture-cuts", sources, opts.wait);
    return { cuts: new Map(reads.map(({ id, read }) => [id, read.cuts])), unread, unreadIds: reads.filter(({ read }) => !read.done).map(({ id }) => id) };
  }

  /** Audit the given joins of `tl`. Missing measurements make the audit say so instead of guessing. */
  async function auditJoins(tl: Timeline, project: Project, joins: TimelineJoin[], all = timelineJoins(tl, project)): Promise<JoinAudit[]> {
    const duration = (id: string) => project.media.find(m => m.id === id)?.duration ?? Infinity;
    const readings = new Map<string, Promise<WaveformResponse | undefined>>();
    const read = (mediaId: string, from: number, to: number) => {
      const lo = Math.max(0, from), hi = Math.min(duration(mediaId), to);
      const key = JSON.stringify([mediaId, lo, hi]);
      if (!readings.has(key)) readings.set(key, hi > lo ? deps.readLevels(mediaId, lo, hi).catch(without(`failed to read the levels of ${mediaId} for a join audit`, undefined)) : Promise.resolve(undefined));
      return readings.get(key)!;
    };
    const entrance = pictureEntranceReader(tl, project.media, project.settings.fps);
    const audits: JoinAudit[] = [];
    for (const join of joins) {
      const number = all.findIndex(j => Math.abs(j.at - join.at) < 1e-3) + 1;
      for (const side of join.tracks) {
        const [out, inn, outWords, inWords] = await Promise.all([
          read(side.out.mediaId, side.out.source - OUT_WINDOW[0], side.out.source + OUT_WINDOW[1]),
          read(side.in.mediaId, side.in.source - IN_WINDOW[0], side.in.source + IN_WINDOW[1]),
          // Words still waiting for alignment would misplace speech around the join; the levels speak alone until then.
          deps.transcriptWords(side.out.mediaId, false, side.out.source + 2).catch(without(`failed to read the words of ${side.out.mediaId} for a join audit`, null)),
          deps.transcriptWords(side.in.mediaId, false, side.in.source + 2).catch(without(`failed to read the words of ${side.in.mediaId} for a join audit`, null)),
        ]);
        const pictureEntrance = entrance(side, inWords, outWords, deps.settledThrough(side.in.mediaId));
        if (!out || !inn) {
          audits.push({ join: number, at: join.at, pictureEntrance, trackId: side.trackId,
            out: { mediaId: side.out.mediaId, source: side.out.source }, in: { mediaId: side.in.mediaId, source: side.in.source },
            levels: "", verdict: "check: no level reading for this join (waveform unavailable)" });
          continue;
        }
        const near = (list: TranscriptWord[] | null, t: number) => list?.filter(w => w.end > t - 2 && w.start < t + 2);
        audits.push({ ...auditJoin(number, join.at, side, out, inn, { out: outWords ?? undefined, in: near(inWords, side.in.source) }), pictureEntrance });
      }
    }
    return audits;
  }

  /**
   * What the scan's saved verbatim words play in these words' stretch that the transcript doesn't have. A recording
   * with no saved pages there, or a read that fails, adds nothing: the scan reads no more for this.
   */
  async function heardOnly(tl: Timeline, transcripts: Map<string, TranscriptWord[]>, shown: TimelineWord[]) {
    if (!shown.length) return [];
    const range = { start: shown[0]!.start, end: shown.at(-1)!.end };
    const verbatim = new Map<string, TranscriptWord[]>();
    await Promise.all([...new Set(shown.map(w => w.mediaId))].map(async mediaId => {
      const source = shown.filter(w => w.mediaId === mediaId).map(w => transcripts.get(mediaId)![w.index]!);
      const from = Math.max(0, Math.min(...source.map(w => w.start)) - 2), to = Math.max(...source.map(w => w.end)) + 2;
      const saved = await client.dialogueVerbatimWords(deps.projectId, { mediaId, from, to }).catch(() => undefined);
      if (saved?.words.length) verbatim.set(mediaId, saved.words);
    }));
    if (!verbatim.size) return [];
    const heard = timelineWords(tl, verbatim, range);
    return heardOnlyVerbatim(shown, heard, w => verbatim.get(w.mediaId)![w.index]!);
  }

  async function readTranscript({ version, from, to, detail }: { version?: string; from?: number; to?: number; detail: "lines" | "words" }) {
    const [tl, { project }] = await Promise.all([deps.peekTimeline(version ?? "head"), deps.getProject()]);
    const duration = timelineDuration(tl);
    const range = { start: from ?? 0, end: to ?? duration };
    const transcripts = await wordsFor(tl, project);
    if (!transcripts.size) return text(`Version ${tl.version} plays no transcribed speech.`);
    const words = timelineWords(tl, transcripts, range);
    for (const [id, list] of transcripts) deps.showWords?.(id, list);
    // A join is numbered among all the edit's joins, as timeline_join_audit numbers it.
    const all = timelineJoins(tl, project);
    const joins = all.filter(j => j.at >= range.start - 1e-3 && j.at <= range.end + 1e-3);
    const limit = detail === "words" ? 600 : 3000;
    let shown = words.slice(0, limit);
    // A word from the input the dialogue isn't on (a producer on a call) is marked, as transcript_get marks it.
    if (deps.otherInputWords && shown.length) {
      const marked = new Map<string, Set<number>>();
      for (const mediaId of new Set(shown.map(w => w.mediaId))) {
        const source = transcripts.get(mediaId)!;
        const asked = [...new Set(shown.filter(w => w.mediaId === mediaId).map(w => w.index))].map(index => ({ index, start: source[index]!.start, end: source[index]!.end }));
        marked.set(mediaId, await deps.otherInputWords(mediaId, asked).catch(() => new Set<number>()));
      }
      shown = shown.map(w => marked.get(w.mediaId)?.has(w.index) ? { ...w, text: `${OTHER_INPUT} ${w.text}` } : w);
    }
    if (shown.length) deps.readPassage(tl.version, { start: Math.max(0, range.start),
      end: shown.length < words.length ? shown.at(-1)!.end : Math.min(duration, range.end) });
    const body = formatTimelineTranscript(shown, joins.filter(j => !shown.length || j.at <= shown.at(-1)!.end + 1e-3 || shown.length === words.length),
      { detail, fps: project.settings.fps, all, removed: join => joinTook(join, transcripts), heard: await heardOnly(tl, transcripts, shown) });
    const more = words.length > limit ? `\nShowing ${limit} of ${words.length} words; continue with from=${(shown.at(-1)!.end + 0.001).toFixed(3)}.` : "";
    return text(`Version ${tl.version}, ${range.start.toFixed(2)}–${range.end.toFixed(2)} of ${duration.toFixed(2)} s timeline: ${words.length} words, ${joins.length} joins.\n${body}${more}`);
  }

  tool("timeline_transcript",
    "What the audience hears on a timeline version (default head): transcript words in playback order with TIMELINE seconds, and a ‖ line at every join between kept source ranges showing the source jump, the words either side and the words the join took out of the recording (took). Each mediaId line identifies the source of the #indices that follow. Use this mediaId and those transcript_get indices in dialogue_check_join or dialogue_apply_cuts. lines groups words between pauses and joins (`time #firstIndex text`); words lists `start-end #index word` for exact edges. Read it after an edit to check that sentences still read naturally across each join. A word heard only on the input a recording's dialogue isn't on (a producer on a call, playback) reads " + OTHER_INPUT + ": it is not the speaker. The transcript tidies a restart or a stutter away, and a `+ heard` line is where the dialogue scan's saved verbatim reading hears words it left out: their TIMELINE seconds, mediaId and source seconds, and the words around them as heard. They play like any other: cut them by those timeline seconds, or by removeRepeat when dialogue_check_repeats lists them.",
    { version: z.string().optional(), from: z.number().min(0).optional().describe("Timeline seconds"), to: z.number().min(0).optional().describe("Timeline seconds"),
      detail: z.enum(["lines", "words"]).default("lines") }, readTranscript);

  tool("timeline_join_audit",
    "Measure joins on a changeId's saved version, or a version (default head) with optional at (join times) or from/to. Each audible track reports out.lastWord and its aligned source end, out.wordEndToJoin (timeline seconds from that word to the cut, at the center of a crossfade), voice activity, clipped words, and a verdict. pictureEntrance.gapMs measures from the first displayed frame of the incoming take to its first aligned spoken word. Positive means a wait, negative means the voice leads the picture. A trimmed word or an unverified picture has no score. Use this with the brief and the sound at the edge when deciding whether to shorten a wait. airAfter/airBefore count quiet at each handle that voice detection also calls quiet. voiceOnCut marks an incoming edge on the first sound after a silence in its recording: the word plays whole with no air before it. removed is the seconds of one recording taken out at the join: across a long one the speaker's position and energy can differ either side. levelQuiet counts low-level sound at those handles independently. The RMS strip gives dBFS in 20 ms steps either side with the level jump in dB.",
    { changeId: z.string().optional(), version: z.string().optional(), at: z.array(z.number().min(0)).max(MAX_AUDITS).optional(),
      from: z.number().min(0).optional(), to: z.number().min(0).optional() },
    async ({ changeId, version, at, from, to }) => {
      if (changeId && version) throw new Error("Give changeId or version, not both.");
      const { project } = await deps.getProject();
      let tl: Timeline, joins: TimelineJoin[];
      if (changeId) {
        const { change } = await client.changeRecord(changeId);
        if (change.projectId !== deps.projectId) throw new Error(`Change ${changeId} is not in this project.`);
        const [before, after] = await Promise.all([deps.peekTimeline(change.fromVersion), deps.peekTimeline(change.toVersion)]);
        tl = after;
        joins = newJoins(before, after, project);
      } else {
        tl = await deps.peekTimeline(version ?? "head");
        joins = timelineJoins(tl, project);
      }
      const all = timelineJoins(tl, project);
      if (at) joins = joins.filter(j => at.some(t => Math.abs(t - j.at) < .002));
      if (from !== undefined || to !== undefined) joins = joins.filter(j => j.at >= (from ?? 0) - 1e-3 && j.at <= (to ?? Infinity) + 1e-3);
      if (!joins.length) return text(`No ${changeId ? "new " : ""}joins on version ${tl.version}${at ? " at those times" : ""}.`);
      const page = joins.slice(0, MAX_AUDITS);
      const audits = await auditJoins(tl, project, page, all);
      const clean = audits.filter(a => a.verdict === "clean").length;
      return json({ version: tl.version, ...(changeId && { changeId }), joins: joins.length, clean, audits,
        // `from` takes a join up to a millisecond before it, so the next page starts two past the last one audited.
        ...(joins.length > page.length && { next: `Call again with from=${page.at(-1)!.at + .002}` }) });
    });

  tool("timeline_diff",
    "Summarize what changed between two timeline versions: duration, the edits in plain lines, the affected ranges, and how many joins were added or removed.",
    { from: z.string().describe("Earlier version"), to: z.string().optional().describe("Later version; default head") },
    async ({ from, to }) => {
      const after = await deps.peekTimeline(to ?? "head");
      const [{ diff, description }, before, { project }] = await Promise.all([
        client.diff(deps.projectId, from, after.version, "id"), deps.peekTimeline(from), deps.getProject()]);
      const added = newJoins(before, after, project).length, removed = newJoins(after, before, project).length;
      const delta = diff.durationAfter - diff.durationBefore;
      return text([`${from} → ${after.version}: ${diff.durationBefore.toFixed(2)} → ${diff.durationAfter.toFixed(2)} s (${delta >= 0 ? "+" : ""}${delta.toFixed(2)} s), joins +${added}/−${removed}.`,
        ...description.map(l => `- ${l}`),
        diff.ranges.length ? `Affected (timeline s, ${after.version}): ${diff.ranges.map(r => `${r.start.toFixed(2)}–${r.end.toFixed(2)}`).join(", ")}` : ""]
        .filter(Boolean).join("\n"));
    });

  tool("media_profile",
    "Whole-recording measurements of one media asset, optionally for a source range: roomToneDbfs (the room floor between words) and speechDbfs, integrated loudness (EBU R128: LUFS, loudness range LU, true peak dBTP), pause statistics per speaker (median and 90th percentile of pauses from 0.15 to 3 s, and how many run longer), and retake candidates: nearby clauses whose words closely repeat, with a 0..1 similarity score and transcript_get word ranges. Retake groups are evidence only; deliberate repetition looks the same.",
    { mediaId: z.string(), from: z.number().min(0).optional(), to: z.number().min(0).optional() },
    async ({ mediaId, from, to }) => {
      const { project } = await deps.getProject();
      const asset = project.media.find(m => m.id === mediaId);
      if (!asset) throw new Error(`Media ${mediaId} is not in this project. Use project_get for media ids.`);
      if (asset.kind !== "audio" && !asset.hasAudio) throw new Error(`Media ${mediaId} has no audio to profile.`);
      if (!asset.duration) throw new Error(`Media ${mediaId} has no duration yet; it may still be importing. Retry after project_get shows it.`);
      const lo = from ?? 0, hi = Math.min(to ?? asset.duration, asset.duration);
      if (hi <= lo) throw new Error(`Choose from < to inside 0–${asset.duration.toFixed(2)} s.`);
      const points = Math.min(20000, Math.max(10, Math.ceil((hi - lo) * 10)));
      const qs = new URLSearchParams({ ...(from !== undefined && { from: String(lo) }), ...(to !== undefined && { to: String(hi) }) }).toString();
      const [wf, all, loudness] = await Promise.all([
        deps.readWaveform(mediaId, lo, hi, points),
        deps.transcriptWords(mediaId, false, hi).catch(without(`failed to read the words of ${mediaId} for its profile`, null)),
        client.get<Record<string, unknown>>(`/projects/${encodeURIComponent(deps.projectId)}/media/${encodeURIComponent(mediaId)}/loudness${qs ? `?${qs}` : ""}`)
          .catch((err: unknown) => {
            noteEvidenceMiss("loudness");
            return { unavailable: err instanceof ScarletApiError ? err.message : String(err) };
          }),
      ]);
      const words = all?.map((w, index) => ({ ...w, index })).filter(w => w.end > lo && w.start < hi) ?? null;
      // A transcript saved and still being aligned has its words, but pauses and retakes are measured from their times,
      // which are final only so far. That is not a recording without a transcript, and the profile says which it is.
      const settled = Math.floor(deps.settledThrough(mediaId));
      const { mediaId: _id, from: _f, to: _t, ...measuredLoudness } = loudness as Record<string, unknown>;
      return json({ mediaId, range: [lo, hi], ...levelProfile({ from: wf.from, to: wf.to, rms: wf.rms ?? wf.peaks }, words),
        loudness: measuredLoudness,
        ...(words ? { words: words.length, pauses: pauseStats(words),
          // retakeGroups numbers words within this range; report transcript_get indices.
          retakes: retakeGroups(words).map(g => ({ ...g, takes: g.takes.map(t => ({ ...t, words: t.words.map(p => words[p]!.index) })) })) }
          : { transcript: Number.isFinite(settled)
            ? `words are still being placed on the audio: times final up to ${settled} s; call again${settled > lo ? `, or give \`to\` below ${settled}` : ""}`
            : "none yet; transcript_get prepares it" }) });
    });

  tool("screen_text",
    "The words shown on screen in a video, read from its picture: one line per line of text, `start-end` in SOURCE seconds while it stays on screen, its box as percent of the frame from the left and from the top, and the words. Frames are looked at once a second and read again only when the picture changes, so text shown for under a second can be missed; the words are read by a text recognizer and can be misspelt, but the box and the times are where it is. With `query`, only lines holding those words (case, punctuation and spacing ignored), across the whole video unless from/to narrow it. A video is read once and kept: a range not read yet is read now, and the answer says how much was read when it returns; call again for the rest. timeline_at maps source seconds to the edit. Lines are listed in time order, 200 at a time; `offset` pages on." +
      (deps.seesFrames ? " The reading says where; the picture says what it looks like: media_frame at a line's start second shows that frame, and frame_contact_sheet the window around it, so a search leads to the one or two frames worth looking at." : ""),
    { mediaId: z.string(), from: z.number().min(0).optional(), to: z.number().min(0).optional(),
      query: z.string().min(1).max(200).optional().describe("Words to find on screen"),
      offset: z.number().int().min(0).default(0) },
    async ({ mediaId, from, to, query, offset }) => {
      const { project } = await deps.getProject();
      const asset = project.media.find(m => m.id === mediaId);
      if (!asset) throw new Error(`Media ${mediaId} is not in this project. Use project_get for media ids.`);
      if (asset.kind !== "video") throw new Error(`Media ${mediaId} is ${asset.kind}: only a video has a picture to read.`);
      const qs = new URLSearchParams({ ...(from !== undefined && { from: String(from) }), ...(to !== undefined && { to: String(to) }), ...(query && { q: query }) }).toString();
      const read = await client.get<{ from: number; to: number; readSeconds: number; done: boolean; error?: string;
        spans: Array<{ start: number; end: number; text: string; box: [number, number, number, number] }> }>(
        `/projects/${encodeURIComponent(deps.projectId)}/media/${encodeURIComponent(mediaId)}/screen-text${qs ? `?${qs}` : ""}`);
      const pct = (n: number) => Math.round(n * 100);
      const page = read.spans.slice(offset, offset + 200);
      const range = `${read.from.toFixed(1)}-${read.to.toFixed(1)} s`;
      const head = `${mediaId} ${range}${query ? `, lines with “${query}”` : ""}: ${read.spans.length} line${read.spans.length === 1 ? "" : "s"}` +
        (read.done ? "." : `; ${read.readSeconds.toFixed(0)} of ${(read.to - read.from).toFixed(0)} s read so far${read.error ? `, stopped: ${read.error}` : ", still reading: call again for the rest"}.`);
      const lines = page.map(s => `${s.start.toFixed(1)}-${s.end.toFixed(1)} [${pct(s.box[0])}-${pct(s.box[2])}% x, ${pct(s.box[1])}-${pct(s.box[3])}% y] ${s.text}`);
      const more = offset + page.length < read.spans.length ? [`offset ${offset + page.length} for the next ${Math.min(200, read.spans.length - offset - page.length)}.`] : [];
      return text([head, ...lines, ...more].join("\n"));
    });

  tool("screen_reading",
    "Where the speaker reads aloud from the screen, on a version of the edit (default head): each reading is a run of the words heard that is found, in the same order, in the text on screen of a recording whose picture plays as they are said. `from`-`to` are TIMELINE seconds of the words, `source` the recording's seconds, `said` the words heard, `matched` how many of them were found on screen, `lines` the lines they were found on, and `box` the area those lines cover as [left, top, right, bottom] in percent of the SOURCE picture: the units of screen_text, and of timeline_framing's `show`. A stretch with no reading is one where the speaker says nothing that is on screen: a demo, a comment, or text read too loosely to match. The text on screen is read by a text recognizer, so a misread word can split a reading in two, and a number read aloud as words doesn't match its digits. `mediaId` chooses the recording whose text to match; by default every recording whose picture plays and whose sound isn't the one heard. A recording's text is read once and kept: while it is still being read, the answer says how far it has got; call again for the rest. Readings are listed in time order, 100 at a time; `offset` pages on.",
    { version: z.string().optional(), from: z.number().min(0).optional().describe("Timeline seconds"), to: z.number().min(0).optional().describe("Timeline seconds"),
      mediaId: z.string().optional().describe("The recording whose text on screen to match"),
      offset: z.number().int().min(0).default(0) },
    async ({ version, from, to, mediaId, offset }) => {
      const [tl, { project }] = await Promise.all([deps.peekTimeline(version ?? "head"), deps.getProject()]);
      const range = { start: from ?? 0, end: to ?? timelineDuration(tl) };
      const found = await readingsOn(tl, project, range, { mediaId, wait: 20 });
      if (!found) return text(`Version ${tl.version} plays no transcribed speech.`);
      const { readings, ids, unread } = found;
      const pct = (box: readonly number[]) => box.map(n => Math.round(n * 1000) / 10);
      const page = readings.slice(offset, offset + 100), left = readings.length - offset - page.length;
      return json({ version: tl.version, range: [range.start, range.end], recordings: ids, readings: readings.length,
        ...(unread.length && { reading: unread }),
        list: page.map(r => ({ from: r.from, to: r.to, mediaId: r.mediaId, source: r.source, said: r.said.length > 160 ? `${r.said.slice(0, 157)}…` : r.said,
          matched: r.matched, box: pct(r.box),
          lines: r.lines.slice(0, 8).map(l => ({ text: l.text.slice(0, 80), box: pct(l.box) })), ...(r.lines.length > 8 && { moreLines: r.lines.length - 8 }) })),
        ...(left > 0 && { next: `offset ${offset + page.length} for the next ${Math.min(100, left)}` }) });
    });

  tool("screen_motion",
    "Where the picture of a recording changes, on a version of the edit (default head): the area a game plays in, a page that scrolls, a result that appears, the pointer moving. The recording is compared four times a second; each span is a run of seconds in which the same area keeps changing, `from`-`to` in TIMELINE seconds, `box` the area over the span as [left, top, right, bottom] in percent of the SOURCE picture (the units of screen_text and of timeline_framing's `show`), `share` the most of the picture that changed in one second, in percent, and `small` where changes the size of a pointer were away from that area, as [x, y] percent. A span whose box is small and whose share is a fraction of a percent is the pointer or a cursor alone. A stretch with no span holds still. It measures change, not meaning: a video playing in a corner changes as much as the thing being shown. `mediaId` chooses the recording; by default every recording whose picture plays and whose sound isn't the one heard. A recording is read once and kept: while it is still being read, the answer says how far it has got; call again for the rest. Spans are listed in time order, 150 at a time; `offset` pages on.",
    { version: z.string().optional(), from: z.number().min(0).optional().describe("Timeline seconds"), to: z.number().min(0).optional().describe("Timeline seconds"),
      mediaId: z.string().optional().describe("The recording whose picture to follow"),
      offset: z.number().int().min(0).default(0) },
    async ({ version, from, to, mediaId, offset }) => {
      const [tl, { project }] = await Promise.all([deps.peekTimeline(version ?? "head"), deps.getProject()]);
      const range = { start: from ?? 0, end: to ?? timelineDuration(tl) };
      const { spans, ids, unread } = await motionOn(tl, project, range, { mediaId, wait: 20 });
      const pct = (n: number) => Math.round(n * 1000) / 10;
      const page = spans.slice(offset, offset + 150), left = spans.length - offset - page.length;
      return json({ version: tl.version, range: [range.start, range.end], recordings: ids, spans: spans.length,
        ...(unread.length && { reading: unread }),
        list: page.map(m => ({ from: m.from, to: m.to, mediaId: m.mediaId, box: m.box.map(pct), share: pct(m.share), ...(m.small && { small: m.small.map(p => p.map(pct)) }) })),
        ...(left > 0 && { next: `offset ${offset + page.length} for the next ${Math.min(150, left)}` }) });
    });

  tool("faces",
    "Where the faces are in a video's frame over time, found from its picture. Each face is followed as a track, numbered by when it first appears: a track follows position from frame to frame, not who it is, so two people who swap places swap tracks, and a face that leaves and comes back over the same place keeps its number. `spans` split each track's time where its face moves or turns, or its eyes look down or back up: `start`-`end` in SOURCE seconds; `box` [left, top, right, bottom] as fractions of the frame, holding the face throughout the span (the detector's box runs from about the hairline to just under the chin, inside the ears: the hair above and the shoulders below are outside it); `eyes` [x, y], the point midway between the eyes as fractions of the frame, where it usually is through the span; `yaw`, roughly where it looks, in degrees from facing the camera, positive toward the frame's right, to the nearest 5; `eyesDown`, how far the eyes usually look down through the span, 0 level or up to 1 fully down (a presenter reading a laptop below the camera reads about 0.5 or more, at the lens about 0.1), left out where the face is too small to read its eyes; and the detector's `confidence` (0..1). `tracks` gives each track's first and last second in the range, its seconds on screen, its usual box and eyes and the detector's usual confidence (a face in a picture or a pattern on a shelf can be found too, usually less surely), and `frame` the video's width and height in pixels, for a box's shape; `track` lists one track's spans. Frames are looked at twice a second, and four times where faces move; a face under about 2% of the frame's width, turned past profile or seen only for a moment can be missed. A video is read once and kept: a range not read yet is read now, and the answer says how much was read when it returns, while track numbers can still change; call again for the rest. Spans are listed in time order, 200 at a time; `offset` pages on. timeline_at maps source seconds to the edit." +
      (deps.seesFrames ? " media_frame at a span's start second shows the frame its box was measured on." : ""),
    { mediaId: z.string(), from: z.number().min(0).optional(), to: z.number().min(0).optional(),
      track: z.number().int().min(1).optional().describe("Only this track's spans"),
      offset: z.number().int().min(0).default(0) },
    async ({ mediaId, from, to, track, offset }) => {
      const { project } = await deps.getProject();
      const asset = project.media.find(m => m.id === mediaId);
      if (!asset) throw new Error(`Media ${mediaId} is not in this project. Use project_get for media ids.`);
      if (asset.kind !== "video") throw new Error(`Media ${mediaId} is ${asset.kind}: only a video has faces to find.`);
      const qs = new URLSearchParams({ ...(from !== undefined && { from: String(from) }), ...(to !== undefined && { to: String(to) }) }).toString();
      const read = await client.get<{ from: number; to: number; width?: number; height?: number; readSeconds: number; done: boolean; error?: string;
        tracks: Array<{ track: number }>; spans: Array<{ track: number }> }>(
        `/projects/${encodeURIComponent(deps.projectId)}/media/${encodeURIComponent(mediaId)}/faces${qs ? `?${qs}` : ""}`);
      if (track !== undefined && read.done && !read.tracks.some(t => t.track === track)) {
        throw new Error(`No track ${track} in ${read.from.toFixed(1)}-${read.to.toFixed(1)} s; this range has ${read.tracks.length ? `tracks ${read.tracks.map(t => t.track).join(", ")}` : "no faces"}.`);
      }
      const spans = track === undefined ? read.spans : read.spans.filter(s => s.track === track);
      const page = spans.slice(offset, offset + 200), left = spans.length - offset - page.length;
      return json({ mediaId, from: read.from, to: read.to, ...(read.width && read.height && { frame: [read.width, read.height] }),
        ...(!read.done && { reading: `${read.readSeconds.toFixed(0)} of ${(read.to - read.from).toFixed(0)} s read so far${read.error ? `, stopped: ${read.error}` : ", still reading: call again for the rest"}` }),
        tracks: read.tracks, spanCount: spans.length, spans: page,
        ...(left > 0 && { next: `offset ${offset + page.length} for the next ${Math.min(200, left)}` }) });
    });

  tool("lip_sync",
    "Whether a video's sound keeps time with its own picture, measured from the face talking in it. A few stretches spread across the range (6 of 30 s by default, or `count` of `seconds`) are each measured on their own: how much the mouth moves from frame to frame against how loud the sound is, at every shift up to 1.5 s either way. Each gives `soundLeads`, the seconds the sound comes before the picture (positive: heard before the mouth moves; negative: after), `match`, how closely the mouth follows the sound at that shift (a correlation, -1..1), and `matchInSync`, the same as the recording plays now, with the face measured (the mouth's area as fractions of the frame, roughly where it looks and its seconds in frame). The mouth opens a little before the sound it makes, and loudness follows it loosely, so a recording in time reads within about 0.15 s of 0 with `match` hardly above `matchInSync`; an offset is plain when `match` is well above `matchInSync`. One stretch can wander a few tenths of a second where the speaker moves their head or pauses: `together` reads the measured stretches as one (their match at each shift averaged), which settles on the shift they share. One offset across the recording is a steady one; offsets that grow steadily from start to end are a drift, which one shift doesn't fix. A low `match` says the stretch had little to go on: a face turned away, a hand over the mouth, little speech, or sound that isn't the speaker. A stretch with no face in frame for most of it isn't measured and says why. `frameSeconds` is one frame. Measured once and kept; a stretch still being measured (`done` false) carries on: call again for it. timeline_picture_sync moves the picture to match.",
    { mediaId: z.string(), from: z.number().min(0).optional().describe("Source seconds"), to: z.number().min(0).optional(),
      count: z.number().int().min(1).max(20).optional().describe("Stretches to measure, default 6"),
      seconds: z.number().min(5).max(120).optional().describe("Length of each stretch, default 30") },
    async ({ mediaId, from, to, count, seconds }) => {
      const { project } = await deps.getProject();
      const asset = project.media.find(m => m.id === mediaId);
      if (!asset) throw new Error(`Media ${mediaId} is not in this project. Use project_get for media ids.`);
      if (asset.kind !== "video") throw new Error(`Media ${mediaId} is ${asset.kind}: only a video has a picture to keep time with its sound.`);
      const qs = new URLSearchParams({ ...(from !== undefined && { from: String(from) }), ...(to !== undefined && { to: String(to) }),
        ...(count !== undefined && { count: String(count) }), ...(seconds !== undefined && { seconds: String(seconds) }) }).toString();
      return json(await client.get<object>(`/projects/${encodeURIComponent(deps.projectId)}/media/${encodeURIComponent(mediaId)}/lip-sync${qs ? `?${qs}` : ""}`));
    });

  return {
    readTranscript,
    readingsOn,
    motionOn,
    besideOn,
    cutsOn,
    /** Words the scan's saved word-for-word reading plays on `tl` in `range` that the transcript doesn't have. */
    async heardOnlyOn(tl: Timeline, range: TimeRange): Promise<HeardOnly[]> {
      const { project } = await deps.getProject();
      const transcripts = await wordsFor(tl, project);
      return transcripts.size ? heardOnly(tl, transcripts, timelineWords(tl, transcripts, range)) : [];
    },
    /**
     * Audit the join a cut left at timeline time `at` on a version (e.g. a staged cut's join on its
     * toVersion). A crossfade counts when `at` falls inside its overlap. Without a join, `noJoin` says
     * why: a head or tail trim, or a removal that left no discontinuity on an audible track.
     */
    async auditAt(version: string, at: number): Promise<{ audits: JoinAudit[]; noJoin?: string }> {
      const [tl, { project }] = await Promise.all([deps.peekTimeline(version), deps.getProject()]);
      const all = timelineJoins(tl, project);
      const near = all.filter(j => Math.abs(at - j.at) <= Math.max(0, ...j.tracks.map(t => (t.overlap ?? 0) / 2)) + .002);
      if (near.length) return { audits: await auditJoins(tl, project, near, all) };
      const duration = timelineDuration(tl);
      return { audits: [], noJoin: at <= .002 ? "head trim: nothing plays before this cut"
        : at >= duration - .002 ? "tail trim: nothing plays after this cut"
        : `no audible join at ${at.toFixed(2)} s: the removal left no discontinuity on an audible track` };
    },
  };
}
