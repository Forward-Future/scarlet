/** Compare the same two spoken occurrences across a verified presenter cut in the published and candidate edits. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { type Timeline } from "../../packages/timeline/src/index.ts";
import { pictureEntranceReader, type PictureEntrance } from "../../packages/mcp/src/picture-entrance.ts";
import { timelineJoins } from "../../packages/mcp/src/timeline-perception.ts";
import { cli, isMain, main } from "./args.ts";
import { loadCase, type LoadedCase } from "./case.ts";
import { publishedGradingInputs } from "./gradingEvidence.ts";
import type { Word } from "./metrics.ts";
import { checkedPath, dataDir, readJson, REPO_ROOT } from "./paths.ts";

interface Segment { finalStart: number; finalEnd: number; rawStart: number; rawEnd: number }
interface AudioJoin { finalTime: number; earliestFinal: number; latestFinal: number; highBandEarliestFinal?: number; highBandLatestFinal?: number; highBandFinal?: number }
interface Reference { segments: Segment[]; joins: AudioJoin[]; frameRate: number }
interface Observation { join: number; publishedFrame: number; publishedTime?: number }
interface Pictures { observations: Observation[]; publishedFrames: number; publishedSha256: string; sourceId: string }
interface EntranceRow {
  join: number; editorPictureAt: number; status: string;
  afterWord?: number; beforeWord?: number; firstWord?: string; editorMs?: number;
  candidate?: PictureEntrance; errorMs?: number;
}

function spoken(w: Word) { return w.end > w.start && /[\p{L}\p{N}]/u.test(w.text) && !/^\s*\[.*\]\s*$/.test(w.text); }

export function entranceRows(words: readonly Word[], reference: Reference, observations: readonly (Observation & { publishedTime: number })[],
                             candidates: readonly PictureEntrance[]) {
  const rows: EntranceRow[] = [];
  const keys = new Map<string, EntranceRow[]>();
  for (const o of observations) {
    const j = reference.joins[o.join];
    if (!j || !Number.isFinite(o.publishedTime) || !Number.isSafeInteger(o.join) ||
        !Number.isSafeInteger(o.publishedFrame) || o.publishedFrame < 0) throw new Error("Invalid verified picture observation.");
    const row: EntranceRow = { join: o.join, editorPictureAt: o.publishedTime, status: "uncertain-editor-word" };
    rows.push(row);
    const old = reference.segments.find(s => Math.abs(s.finalEnd - j.finalTime) < 1e-6);
    const next = reference.segments.find(s => Math.abs(s.finalStart - j.finalTime) < 1e-6);
    if (!old || !next) continue;
    // Map the source onset through the incoming SOUND piece. The verified picture can fall on either side.
    if (!Number.isFinite(reference.frameRate) || reference.frameRate <= 0 ||
        [old, next].some(s => Math.abs(s.finalEnd - s.finalStart - (s.rawEnd - s.rawStart)) > .002))
      throw new Error("Entrance scoring requires a known picture clock and unit-rate audio reference.");
    const uncertainty = 1 / reference.frameRate;
    const earlier = Math.min(j.earliestFinal, j.highBandEarliestFinal ?? j.finalTime, j.highBandFinal ?? j.finalTime) - j.finalTime - uncertainty;
    const later = Math.max(j.latestFinal, j.highBandLatestFinal ?? j.finalTime, j.highBandFinal ?? j.finalTime) - j.finalTime + uncertainty;
    const left = (shift: number) => words.findLastIndex(w => spoken(w) && w.end > old.rawStart && w.start < old.rawEnd + shift);
    const right = (shift: number) => words.findIndex(w => spoken(w) && w.end > next.rawStart + shift && w.start < next.rawEnd);
    const before = right(earlier), after = left(earlier);
    if (after < 0 || before < 0 || after !== left(later) || before !== right(later)) continue;
    const w = words[before]!;
    Object.assign(row, { afterWord: after, beforeWord: before, firstWord: w.text });
    if (w.start < next.rawStart + later || w.end > next.rawEnd) { row.status = "editor-word-at-edge"; continue; }
    row.editorMs = Math.round(1000 * (next.finalStart + w.start - next.rawStart - o.publishedTime));
    const key = after + "/" + before;
    const group = keys.get(key) ?? [];
    group.push(row);
    keys.set(key, group);
  }
  for (const group of keys.values()) for (const row of group) {
    const found = candidates.filter(c => c.previousWordIndex === row.afterWord && c.wordIndex === row.beforeWord);
    if (group.length > 1 || found.length > 1) row.status = "ambiguous-match";
    else if (!found.length) row.status = "no-matching-picture-and-words";
    else {
      row.candidate = found[0];
      row.status = row.candidate!.status;
      if (row.status === "measured") row.errorMs = row.candidate!.gapMs! - row.editorMs!;
    }
  }
  return rows;
}

const mean = (values: number[]) => values.length ? Math.round(values.reduce((a, b) => a + b) / values.length) : null;
export function entranceSummary(rows: EntranceRow[]) {
  const measured = rows.filter(r => r.errorMs !== undefined);
  return { verifiedPictures: rows.length, eligibleEditorEntrances: rows.filter(r => r.editorMs !== undefined).length,
    matched: measured.length, trimmedMatchedWords: rows.filter(r => r.status === "word-trimmed").length,
    matchedOnsetsInFade: rows.filter(r => r.status === "onset-in-fade").length,
    meanEditorMs: mean(measured.map(r => r.editorMs!)), meanCandidateMs: mean(measured.map(r => r.candidate!.gapMs!)),
    meanErrorMs: mean(measured.map(r => r.errorMs!)), meanAbsoluteErrorMs: mean(measured.map(r => Math.abs(r.errorMs!))) };
}

/** The timing comparison is paired on verified editor joins; a changed take stays visible in coverage. */
export function pairedEntrances(baseline: EntranceRow[], candidate: EntranceRow[]) {
  const measured = (rows: EntranceRow[]) => new Map(rows.flatMap(r => r.errorMs === undefined ? [] : [[r.join, Math.abs(r.errorMs)] as const]));
  const before = measured(baseline), after = measured(candidate);
  const shared = [...before.keys()].filter(id => after.has(id));
  return { baselineMatched: before.size, candidateMatched: after.size, shared: shared.length,
    lost: [...before.keys()].filter(id => !after.has(id)), gained: [...after.keys()].filter(id => !before.has(id)),
    baselineErrorMs: mean(shared.map(id => before.get(id)!)), candidateErrorMs: mean(shared.map(id => after.get(id)!)),
    changeMs: mean(shared.map(id => after.get(id)! - before.get(id)!)) };
}

async function sha(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function scoreEntrances(loaded: LoadedCase, timeline: Timeline) {
  const root = dataDir(), file = (name: string) => checkedPath(root, join(root, name));
  const grading = publishedGradingInputs(loaded, root);
  if (!grading?.pictures) return;
  const id = loaded.file.dialogueMedia[0];
  if (!id || timeline.projectId !== loaded.file.projectId) throw new Error("Expected the candidate timeline from the frozen dialogue case.");
  const pictures = readJson<Pictures>(grading.pictures);
  const words = readJson<{ words?: Word[] }>(grading.evidence).words;
  if (!words?.length) throw new Error("Picture entrance grading requires frozen source words.");
  let pts: number[] = [];
  if (pictures.observations.some(o => o.publishedTime === undefined)) {
    const movie = file("media/published.mp4");
    if (await sha(movie) !== pictures.publishedSha256) throw new Error("The published movie differs from the verified pictures.");
    const output = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_packets", "-show_entries", "packet=pts_time",
      "-of", "csv=p=0", movie], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    const origin = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=start_time", "-of", "default=nw=1:nk=1", movie], { encoding: "utf8" }).trim());
    pts = output.split(/\r?\n/).map(l => l.split(",")[0]!.trim()).filter(Boolean).map(v => Number(v) - origin).sort((a, b) => a - b);
    if (pts.length !== pictures.publishedFrames || pts.some((p, i) => !Number.isFinite(p) || i > 0 && p <= pts[i-1]!)) throw new Error("Invalid published picture clock.");
  }
  const obs = pictures.observations.map(o => ({ ...o, publishedTime: o.publishedTime ?? pts[o.publishedFrame]! }));
  if (new Set(obs.map(o => o.join)).size !== obs.length || new Set(obs.map(o => o.publishedFrame)).size !== obs.length ||
      obs.some(o => o.publishedFrame >= pictures.publishedFrames)) throw new Error("Invalid or duplicate verified picture.");
  const read = pictureEntranceReader(timeline, loaded.file.media, loaded.file.fps);
  const candidates = timelineJoins(timeline, loaded.file).flatMap(j => j.tracks.filter(s => s.out.mediaId === id && s.in.mediaId === id).map(s => read(s, words, words)));
  const rows = entranceRows(words, readJson<Reference>(grading.reference), obs, candidates);
  const graderFiles = ["evals/src/entrances.ts", "evals/src/gradingEvidence.ts", "packages/mcp/src/picture-entrance.ts",
    "packages/mcp/src/timeline-perception.ts", "packages/timeline/src/transitions.ts"];
  const graderSha256 = Object.fromEntries(await Promise.all(graderFiles.map(async name => [name, await sha(join(REPO_ROOT, name))])));
  return { schema: 1, case: loaded.file.id, version: timeline.version, graderSha256, gradingEvidenceSha256: grading.evidenceSha256, episodeSha256: await sha(file("episode.lock.json")),
    candidateSha256: createHash("sha256").update(JSON.stringify(timeline)).digest("hex"),
    candidateTrimmedWords: candidates.filter(c => c.status === "word-trimmed").length,
    candidateOnsetsInFade: candidates.filter(c => c.status === "onset-in-fade").length,
    summary: entranceSummary(rows), opening40s: entranceSummary(rows.filter(r => r.editorPictureAt < 40)), rows };
}

if (isMain(import.meta.url)) void main(async () => {
  const { values } = cli({ case: { type: "string" }, timeline: { type: "string" }, version: { type: "string" }, baseline: { type: "string" } },
    "entrances.ts --case ID (--version SAVED_VERSION | --timeline TIMELINE_JSON) [--baseline TIMELINE_OR_SCORE_JSON]");
  if (!values.case || !!values.version === !!values.timeline) throw new Error("Supply a case and one candidate timeline or saved version.");
  const loaded = loadCase(values.case);
  const tl = values.timeline ? readJson<Timeline>(values.timeline) : loaded.timeline(values.version!);
  if (!tl) throw new Error("Candidate timeline unavailable.");
  const score = await scoreEntrances(loaded, tl);
  if (!score) throw new Error("Episode has no verified pictures.");
  if (!values.baseline) { console.log(JSON.stringify(score, null, 2)); return; }
  const input = readJson<Timeline | typeof score>(values.baseline);
  const before = "tracks" in input ? await scoreEntrances(loaded, input) : input;
  if (!before || before.schema !== score.schema || before.episodeSha256 !== score.episodeSha256 ||
      before.gradingEvidenceSha256 !== score.gradingEvidenceSha256 ||
      Object.entries(score.graderSha256).some(([name, hash]) => before.graderSha256?.[name] !== hash)) {
    throw new Error("Re-score the baseline with the same frozen episode, grading words and grader.");
  }
  const opening = (rows: EntranceRow[]) => rows.filter(r => r.editorPictureAt < 40);
  console.log(JSON.stringify({ ...score, baselineSha256: before.candidateSha256, paired: pairedEntrances(before.rows, score.rows),
    pairedOpening40s: pairedEntrances(opening(before.rows), opening(score.rows)) }, null, 2));
});
