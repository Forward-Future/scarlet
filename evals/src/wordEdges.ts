/** Replay the published editor's word selection through Scarlet's join placement and review gate, one join at a time. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DialogueEvidence } from "../../packages/mcp/src/dialogue-decisions.ts";
import { joinEvidence } from "../../packages/mcp/src/dialogue-join.ts";
import { planDialogueCuts, type DialoguePlanSources } from "../../packages/mcp/src/dialogue-plan.ts";
import { frameAligned, timelineToSource, type Project } from "../../packages/timeline/src/index.ts";
import { cli, isMain, main } from "./args.ts";
import { loadCase } from "./case.ts";
import { Engine } from "./engine.ts";
import { round } from "./metrics.ts";
import { cacheDir, readJson, resultsDir, timestamp, writeJson } from "./paths.ts";
import { audibleClips } from "./timeline.ts";

type Reading = Parameters<typeof joinEvidence>[1];
interface AudioJoin {
  rawOut: number; rawIn: number; finalTime: number; earliestFinal: number; latestFinal: number;
  highBandFinal?: number; highBandEarliestFinal?: number; highBandLatestFinal?: number;
}
interface AudioMap { rawDuration: number; frameRate: number; joins: AudioJoin[] }
interface Placement { start: number; end: number; spacingErrorMs: number; wrongWords: number }
interface Row {
  index: number;
  outcome: "backward" | "uncertain" | "pause" | "terminal" | "outside" | "needsRevision" | "applied" | "review";
  fromWord?: number; toWord?: number; placement?: Placement; frameAligned?: Placement;
}
interface Result { caseId: string; inputs: string; rows: Row[] }

export function wordSelection(midpoints: number[], j: AudioJoin, frame: number) {
  if (j.rawIn <= j.rawOut) return "backward";
  const earliest = Math.min(j.earliestFinal, j.highBandEarliestFinal ?? j.finalTime, j.highBandFinal ?? j.finalTime) - j.finalTime - frame;
  const latest = Math.max(j.latestFinal, j.highBandLatestFinal ?? j.finalTime, j.highBandFinal ?? j.finalTime) - j.finalTime + frame;
  if ([j.rawOut, j.rawIn].some(at => midpoints.some(w => at + earliest <= w && w <= at + latest))) return "uncertain";
  const fromWord = midpoints.findIndex(t => j.rawOut <= t && t < j.rawIn);
  if (fromWord < 0) return "pause";
  const toWord = midpoints.findLastIndex(t => j.rawOut <= t && t < j.rawIn);
  return fromWord === 0 || toWord === midpoints.length - 1 ? "terminal" : { fromWord, toWord };
}

function summarize(rows: Row[]) {
  const counts = (outcome: Row["outcome"]) => rows.filter(r => r.outcome === outcome).length;
  const scored = rows.filter(r => r.frameAligned);
  const scores = (key: "placement" | "frameAligned") => {
    const placements = scored.map(r => r[key]!);
    return { mismatchedJoins: placements.filter(p => p.wrongWords).length,
      meanAbsoluteSpacingErrorMs: placements.length ? round(placements.reduce((s, p) => s + Math.abs(p.spacingErrorMs), 0) / placements.length, 1) : null };
  };
  return { referenceJoins: rows.length, eligible: scored.length + counts("needsRevision"),
    backward: counts("backward"), uncertain: counts("uncertain"), pauseOnly: counts("pause"), terminal: counts("terminal"), outside: counts("outside"),
    applied: counts("applied"), review: counts("review"), needsRevision: counts("needsRevision"),
    proposed: scores("placement"), frameAligned: scores("frameAligned") };
}

/** The same RMS, peaks and voice activity that Scarlet reads at a word edge. Keep both variants on identical inputs. */
async function readWaveforms(id: string, duration: number, path: string, engineUrl?: string) {
  if (existsSync(path)) return readJson<Reading[]>(path);
  const engine = await Engine.connect({ url: engineUrl });
  const pages: Reading[] = [];
  for (let from = 0; from < duration; from += 28) {
    const to = Math.min(duration, from + 32), points = Math.max(10, Math.ceil((to - from) * 50));
    pages.push(await engine.get<Reading>(`/media/${encodeURIComponent(id)}/waveform?from=${from}&to=${to}&points=${points}&speechActivity=1`));
  }
  writeJson(path, pages);
  return pages;
}

const USAGE = "wordEdges.ts --case ID --reference-map match_audio.json [--waveforms cached.json] [--engine URL] [--baseline previous.json] [--out result.json]";

async function run() {
  const { values } = cli({ case: { type: "string" }, "reference-map": { type: "string" }, waveforms: { type: "string" },
    engine: { type: "string" }, baseline: { type: "string" }, out: { type: "string" } }, USAGE);
  if (!values.case || !values["reference-map"]) throw new Error(USAGE);
  const loaded = loadCase(values.case), c = loaded.file;
  const tl = loaded.timeline(c.sourceVersion);
  if (!tl) throw new Error("The case lacks its source timeline. Rebuild it from the raw assembly.");
  const clips = audibleClips(tl, c.media);
  if (clips.length !== 1 || clips[0]!.speed !== 1) throw new Error("This single-recording audio map needs one audible source clip at normal speed. Build the case from its raw recording.");
  const clip = clips[0]!, id = clip.mediaId, asset = c.media.find(m => m.id === id)!;
  const words = loaded.evidence.get(id)?.words;
  if (!words?.length || !asset.duration) throw new Error("Build the case after its dialogue words and duration are available.");
  const map = readJson<AudioMap>(values["reference-map"]);
  if (!Array.isArray(map.joins) || !Number.isFinite(map.frameRate) || map.frameRate <= 0 || !(Math.abs(map.rawDuration - asset.duration) < .1)) throw new Error("The reference audio map must match the case recording's duration.");
  if (asset.audioStream && asset.audioStream !== 0) throw new Error("The waveform API measures audio stream zero. Select a case whose dialogue is on that stream.");
  const waveformPath = values.waveforms ?? join(cacheDir(), "word-edges-v1", `${id}-${asset.hash ?? asset.duration}.json`);
  const readings = await readWaveforms(id, asset.duration, waveformPath, values.engine);
  const evidence = new DialogueEvidence();
  for (const wf of readings) {
    if ("mediaId" in wf && wf.mediaId !== id) throw new Error("The waveform cache belongs to another recording.");
    const local = words.filter(w => w.end > wf.from && w.start < wf.to);
    const edges = joinEvidence(local, wf);
    if (!edges) throw new Error("The saved waveform lacks 20 ms RMS levels, peaks or voice activity. Refresh its cache.");
    evidence.scans.push({ mediaId: id, audioStream: 0, start: wf.from, end: wf.to, edges, segments: [] });
  }
  const spans = readings.map(r => [r.from, r.to] as const).sort((a, b) => a[0] - b[0]);
  let through = 0;
  for (const [start, end] of spans) {
    if (start > through + .001) throw new Error("The waveform cache has a missing interval. Refresh it.");
    through = Math.max(through, end);
  }
  if (through < asset.duration - .001) throw new Error("The waveform cache ends before the recording. Refresh it.");
  const project = { id: c.projectId, media: c.media, settings: { fps: c.fps } } as Project;
  const sources: DialoguePlanSources = { pages: () => evidence.scans, evidence, project: async () => project,
    words: async mediaId => mediaId === id ? words : null, measure: async () => {} };
  const midpoints = words.map(w => (w.start + w.end) / 2);
  const rows: Row[] = [];
  for (const [index, j] of map.joins.entries()) {
    if (![j.rawOut, j.rawIn, j.earliestFinal, j.finalTime, j.latestFinal].every(Number.isFinite) ||
      j.earliestFinal > j.finalTime + .001 || j.latestFinal < j.finalTime - .001) throw new Error(`Invalid timing or uncertainty at join ${index + 1}.`);
    const picked = wordSelection(midpoints, j, 1 / map.frameRate);
    if (typeof picked === "string") { rows.push({ index, outcome: picked }); continue; }
    if (j.rawOut < clip.sourceIn || j.rawIn > clip.sourceOut) { rows.push({ index, outcome: "outside" }); continue; }
    const result = await planDialogueCuts({ tl, localPauses: false, cuts: [{ mediaId: id, ...picked, kind: "retake", decision: "cut", reason: "Published word selection." }] }, sources);
    if (result.outcome === "needsRevision") { rows.push({ index, ...picked, outcome: "needsRevision" }); continue; }
    if (result.outcome !== "ready" || result.decisions.length !== 1) throw new Error(`No placement returned for reference join ${index + 1}.`);
    const d = result.decisions[0]!;
    const measure = (range: { start: number; end: number }): Placement => {
      const start = timelineToSource(clip, range.start), end = timelineToSource(clip, range.end);
      const wrongWords = midpoints.filter((w, i) => (start <= w && w < end) !== (picked.fromWord <= i && i <= picked.toWord)).length;
      // Holding the outer words fixed, each second of extra removal shortens the gap those words play by one second.
      return { start, end, spacingErrorMs: round(((j.rawIn - j.rawOut) - (end - start)) * 1000, 3), wrongWords };
    };
    rows.push({ index, ...picked, outcome: d.review ? "review" : "applied", placement: measure(d), frameAligned: measure(frameAligned(d, c.fps)) });
  }
  const inputs = createHash("sha256").update(JSON.stringify([map, tl, c.fps, words, readings])).digest("hex");
  const result: Result = { caseId: c.id, inputs, rows };
  const summary = summarize(rows);
  const previous = values.baseline ? readJson<Result>(values.baseline) : undefined;
  if (previous && (previous.inputs !== inputs || previous.caseId !== c.id || previous.rows.length !== rows.length ||
    previous.rows.some((r, i) => r.index !== rows[i]!.index || r.fromWord !== rows[i]!.fromWord || r.toWord !== rows[i]!.toWord))) {
    throw new Error("Baseline case, reference, eligible word labels, timeline, transcript and waveforms must match for a paired comparison.");
  }
  const shared = previous && rows.filter((r, i) => r.frameAligned && previous.rows[i]?.frameAligned).map(r => r.index);
  const paired = previous && shared && { shared: shared.length, baseline: summarize(shared.map(i => previous.rows[i]!)), candidate: summarize(shared.map(i => rows[i]!)) };
  const out = values.out ?? join(resultsDir(), "word-edges", c.id, timestamp() + ".json");
  writeJson(out, { ...result, summary, paired });
  console.log(JSON.stringify({ case: c.id, summary, paired, out }, null, 2));
}

if (isMain(import.meta.url)) void main(run);
