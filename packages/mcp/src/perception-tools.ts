/**
 * Read-only tools that let any model verify an edit from measurements: the edited transcript in
 * playback order, a deterministic audit of each join, version diffs and a per-media profile.
 */
import { z } from "zod/v3";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ScarletApiError, type ProjectDetail, type ScarletClient, type ScarletToolName, type WaveformResponse } from "@scarlet/shared";
import { timelineDuration, type Project, type Timeline, type TranscriptWord } from "@scarlet/timeline";
import { auditJoin, formatTimelineTranscript, newJoins, timelineJoins, timelineWords, type JoinAudit, type TimelineJoin } from "./timeline-perception.js";
import { levelProfile, pauseStats, retakeGroups } from "./media-profile.js";

export type ToolRegistrar = <Shape extends z.ZodRawShape>(name: ScarletToolName, description: string, shape: Shape,
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<CallToolResult>) => void;

export interface PerceptionDeps {
  tool: ToolRegistrar;
  client: ScarletClient;
  projectId: string;
  /** The agent's own read of a version: edits it proposes next are based on it. */
  getTimeline(version?: string): Promise<Timeline>;
  /** A version read to measure or compare, which leaves the base of the agent's next edit alone. */
  peekTimeline(version: string): Promise<Timeline>;
  /** The portion of an edited transcript actually returned to the agent. */
  readPassage(version: string, range: { start: number; end: number }): void;
  getProject(): Promise<ProjectDetail>;
  /** A media's words in transcript_get order (index = stable word index), or null without a transcript. */
  /** With `through`, only words whose times are final up to that source second: it rejects while alignment hasn't reached it. */
  transcriptWords(mediaId: string, prepareMissing?: boolean, through?: number): Promise<TranscriptWord[] | null>;
  /** The source second up to which a media's word times, as last read, are final. Infinity once they all are, and for a media with no transcript. */
  settledThrough(mediaId: string): number;
  /** 20 ms levels with voice activity for a source window. */
  readLevels(mediaId: string, from: number, to: number): Promise<WaveformResponse>;
  /** Levels without voice activity, at any resolution, preparing a missing waveform. */
  readWaveform(mediaId: string, from: number, to: number, points: number): Promise<WaveformResponse>;
  /** Note on stderr a read that failed and was answered without. Media still being prepared is not one. */
  unavailable(what: string, err: unknown): void;
}

const text = (s: string): CallToolResult => ({ content: [{ type: "text", text: s }] });
const json = (v: unknown): CallToolResult => text(JSON.stringify(v));
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
        if (!out || !inn) {
          audits.push({ join: number, at: join.at, trackId: side.trackId,
            out: { mediaId: side.out.mediaId, source: side.out.source }, in: { mediaId: side.in.mediaId, source: side.in.source },
            levels: "", verdict: "check: no level reading for this join (waveform unavailable)" });
          continue;
        }
        const near = (list: TranscriptWord[] | null, t: number) => list?.filter(w => w.end > t - 2 && w.start < t + 2);
        audits.push(auditJoin(number, join.at, side, out, inn, { out: outWords ?? undefined, in: near(inWords, side.in.source) }));
      }
    }
    return audits;
  }

  async function readTranscript({ version, from, to, detail }: { version?: string; from?: number; to?: number; detail: "lines" | "words" }) {
    const [tl, { project }] = await Promise.all([deps.getTimeline(version), deps.getProject()]);
    const duration = timelineDuration(tl);
    const range = { start: from ?? 0, end: to ?? duration };
    const transcripts = await wordsFor(tl, project);
    if (!transcripts.size) return text(`Version ${tl.version} plays no transcribed speech.`);
    const words = timelineWords(tl, transcripts, range);
    // A join is numbered among all the edit's joins, as timeline_join_audit numbers it.
    const all = timelineJoins(tl, project);
    const joins = all.filter(j => j.at >= range.start - 1e-3 && j.at <= range.end + 1e-3);
    const limit = detail === "words" ? 600 : 3000;
    const shown = words.slice(0, limit);
    if (shown.length) deps.readPassage(tl.version, { start: Math.max(0, range.start),
      end: shown.length < words.length ? shown.at(-1)!.end : Math.min(duration, range.end) });
    const body = formatTimelineTranscript(shown, joins.filter(j => !shown.length || j.at <= shown.at(-1)!.end + 1e-3 || shown.length === words.length),
      { detail, fps: project.settings.fps, all });
    const more = words.length > limit ? `\nShowing ${limit} of ${words.length} words; continue with from=${shown.at(-1)!.end.toFixed(2)}.` : "";
    return text(`Version ${tl.version}, ${range.start.toFixed(2)}–${range.end.toFixed(2)} of ${duration.toFixed(2)} s timeline: ${words.length} words, ${joins.length} joins.\n${body}${more}`);
  }

  tool("timeline_transcript",
    "What the audience hears on a timeline version (default head): transcript words in playback order with TIMELINE seconds, and a ‖ line at every join between kept source ranges showing the source jump and the words either side. #index is the word's transcript_get index in its media, usable as a word reference. lines groups words between pauses and joins (`time #firstIndex text`); words lists `start-end #index word` for exact edges. Read it after an edit to check that sentences still read naturally across each join.",
    { version: z.string().optional(), from: z.number().min(0).optional().describe("Timeline seconds"), to: z.number().min(0).optional().describe("Timeline seconds"),
      detail: z.enum(["lines", "words"]).default("lines") }, readTranscript);

  tool("timeline_join_audit",
    "Measure joins on a changeId's saved version, or a version (default head) with optional at (join times) or from/to. Each audible track reports out.lastWord and its aligned source end, out.wordEndToJoin (timeline seconds from that word to the cut, at the center of a crossfade), voice activity, clipped words, and a verdict. For pacing use wordEndToJoin. airAfter/airBefore count quiet at each handle that voice detection also calls quiet. levelQuiet counts low-level sound at those handles independently. The RMS strip gives dBFS in 20 ms steps either side with the level jump in dB.",
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
        tl = await deps.getTimeline(version);
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
      const after = await deps.getTimeline(to);
      const [{ diff, description }, before, { project }] = await Promise.all([
        client.diff(deps.projectId, from, after.version), deps.peekTimeline(from), deps.getProject()]);
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
          .catch((err: unknown) => ({ unavailable: err instanceof ScarletApiError ? err.message : String(err) })),
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

  return {
    readTranscript,
    /** Audit the joins at timeline times `at` on a version (e.g. a staged cut's join on its toVersion). */
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

export type Perception = ReturnType<typeof registerPerception>;
