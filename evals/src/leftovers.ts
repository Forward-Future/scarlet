/**
 * What the editor's own edits play now, by the kinds of dialogue mistake he has reported again and again: a free sweep
 * of a Scarlet library, with no engine and no model.
 *
 * A report names one spot. This says how many spots of the same kind his projects play, so a fix is judged on the
 * class (evals/DIALOGUE.md step 2): the ledger entry records the family's count before the fix, and `ledger.ts check`
 * prints every family's count now, so a fix that moves only its own spot shows as a flat line.
 *
 * Each family is read from the saved transcripts and the pieces each project's current edit plays. Transcript timing is
 * a few frames off at times and tidies some words away, so every figure is a flag to listen to, not a count of
 * mistakes: a phrase said twice is often deliberate ("it was short, it was concise"), and a sentence a join divides may
 * still read as one. Read the lists, and compare counts over time on the same scale (per 10 minutes of edit).
 *
 *   node_modules/.bin/tsx evals/src/leftovers.ts [--db <scarlet.db>] [--project <id or name>] [--family <name>] [--json]
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { closesSentence, joinFragment, type SaidWord } from "../../packages/shared/src/joinFragments.ts";
import { findRestarts } from "../../packages/shared/src/restarts.ts";
import { normalizeTranscriptToken } from "../../packages/shared/src/transcriptSearch.ts";
import { appSupportDir } from "./paths.ts";

/** The kinds of mistake a sweep can count, each with what it flags. */
export const FAMILIES = {
  restart: "a phrase the edit plays twice within a moment (the closing check's finder, cut-off words included)",
  deadAir: `a stretch of ${1.5} s or more with no word playing`,
  lateCut: `a join that plays more than ${0.3} s after the last word before it (the cut starts too late)`,
  lateVoice: `a join that plays more than ${0.3} s before the first word after it (the voice comes in late)`,
  edgeInWord: `a join whose edge lands more than ${0.03} s inside a word, by the transcript's timing`,
  brokenSentence: "a join that took words out of a sentence and leaves part of it playing (joinFragment)",
  doubledAtJoin: "the same word either side of a join (“who ‖ who”)",
  shortNumber: `a number timed under ${0.1} s, too short to say: the transcript's timing, which cuts are placed by`,
} as const;
export type Family = keyof typeof FAMILIES;

const DEAD_AIR = 1.5, LATE = 0.3, IN_WORD = 0.03, SHORT_NUMBER = 0.1;

interface Word { text: string; start: number; end: number; endsSentence?: boolean }
interface Clip { mediaId?: string; sourceIn: number; sourceOut: number; timelineIn: number; speed?: number; enabled?: boolean; volume?: number }
interface Played { text: string; start: number; end: number; source: number; sourceEnd: number; mediaId: string; piece: number }
export interface Flag { family: Family; at: number; source: number; mediaId: string; text: string; cutOffOnly?: boolean }
export interface ProjectLeftovers { id: string; name: string; head: string; minutes: number; flags: Flag[]; pass?: { taskId: string; kept: string[] } }
export interface FamilyTotal { count: number; perTenMin: number }
export interface SweepTotals { edits: number; minutes: number; families: Record<Family, FamilyTotal> }

/** The words each recording's longest saved transcript has, keyed by media, with where its sentences end. */
function transcripts(db: DatabaseSync) {
  const best = new Map<string, Word[]>();
  for (const row of db.prepare("select media_id, json from transcripts").all() as { media_id: string; json: string }[]) {
    const t = JSON.parse(row.json) as { segments?: { words?: Word[] }[] };
    const words = (t.segments ?? []).flatMap(s => (s.words ?? []).filter(w => w.end > w.start).map((w, i, all) =>
      ({ text: w.text, start: w.start, end: w.end, endsSentence: closesSentence(w.text) || i === all.length - 1 })));
    if (words.length > (best.get(row.media_id)?.length ?? 0)) best.set(row.media_id, words.sort((a, b) => a.start + a.end - b.start - b.end));
  }
  return best;
}

/** The sounding dialogue pieces of an edit in playback order, and the words each plays (a word whose middle it plays). */
function pieces(tracks: { kind?: string; clips: Clip[] }[], words: Map<string, Word[]>) {
  const clips = tracks.filter(t => t.kind === "audio").flatMap(t => t.clips)
    .filter(c => c.enabled !== false && c.volume !== 0 && c.mediaId && words.has(c.mediaId)).sort((a, b) => a.timelineIn - b.timelineIn);
  const said: Played[] = [], seen = new Set<string>();
  clips.forEach((c, piece) => {
    const speed = c.speed ?? 1;
    for (const w of words.get(c.mediaId!)!) {
      const middle = (w.start + w.end) / 2, key = `${c.mediaId}:${w.start}`;
      if (middle < c.sourceIn || middle >= c.sourceOut || seen.has(key)) continue;
      seen.add(key);
      said.push({ text: w.text, start: c.timelineIn + (w.start - c.sourceIn) / speed, end: c.timelineIn + (w.end - c.sourceIn) / speed,
        source: w.start, sourceEnd: w.end, mediaId: c.mediaId!, piece });
    }
  });
  return { clips, said: said.sort((a, b) => a.start - b.start) };
}

/** The reasons the project's latest pass that ran the closing repeat check gave for the repeats it kept. */
function keptByLatestPass(db: DatabaseSync, projectId: string) {
  const tasks = db.prepare("select id from tasks where project_id = ? and kind = 'edit' order by created_at desc").all(projectId) as { id: string }[];
  for (const { id } of tasks) {
    let checked = false;
    const kept = new Map<string, string>();
    for (const row of db.prepare("select json from task_events where task_id = ? order by id").all(id) as { json: string }[]) {
      const e = JSON.parse(row.json) as { type?: string; data?: { tool?: string; input?: { keep?: { id: string; reason: string }[] } } };
      if (e.type !== "tool" || !e.data?.tool?.endsWith("dialogue_check_repeats")) continue;
      checked = true;
      for (const k of e.data.input?.keep ?? []) kept.set(k.id, k.reason);
    }
    if (checked) return { taskId: id, kept: [...kept.values()] };
  }
  return undefined;
}

const round = (t: number) => Math.round(t * 100) / 100;

/** Every flag one edit plays. */
export function flagsOf(tracks: { kind?: string; clips: Clip[] }[], words: Map<string, Word[]>): { flags: Flag[]; minutes: number } {
  const { clips, said } = pieces(tracks, words);
  const flags: Flag[] = [];
  const flag = (family: Family, w: { start: number; source: number; mediaId: string }, text: string, extra: Partial<Flag> = {}) =>
    flags.push({ family, at: round(w.start), source: round(w.source), mediaId: w.mediaId, text, ...extra });
  const text = (from: number, to: number) => said.slice(Math.max(0, from), Math.max(0, to)).map(w => w.text.trim()).join(" ");

  const tokens = said.map(w => normalizeTranscriptToken(w.text)), starts = said.map(w => w.start), ends = said.map(w => w.end);
  const exact = new Set(findRestarts(tokens, starts, ends).map(r => r.next));
  for (const r of findRestarts(tokens, starts, ends, { cutOffWords: true }))
    flag("restart", said[r.at]!, `${text(r.at - 4, r.at)} [${text(r.at, r.next)}] ${text(r.next, r.next + 6)}`, { cutOffOnly: !exact.has(r.next) });

  for (let i = 1; i < said.length; i++) {
    const a = said[i - 1]!, b = said[i]!;
    if (b.start - a.end >= DEAD_AIR) flag("deadAir", a, `${round(b.start - a.end)} s after “${text(i - 3, i)}”, before “${text(i, i + 3)}”`);
    if (/\d/.test(b.text) && b.sourceEnd - b.source < SHORT_NUMBER) flag("shortNumber", b, `“${b.text.trim()}” timed ${round(b.sourceEnd - b.source)} s in “${text(i - 3, i + 4)}”`);
  }

  // Joins: one piece of a recording followed by a later piece of the same recording, as versionJoins reads them.
  for (let p = 1; p < clips.length; p++) {
    const a = clips[p - 1]!, b = clips[p]!;
    const aEnd = a.timelineIn + (a.sourceOut - a.sourceIn) / (a.speed ?? 1);
    if (a.mediaId !== b.mediaId || Math.abs(b.timelineIn - aEnd) > 0.2 || b.sourceIn - a.sourceOut < 1e-3) continue;
    const all = words.get(a.mediaId!)!;
    const last = said.findLast(w => w.piece === p - 1), firstIndex = said.findIndex(w => w.piece === p), first = said[firstIndex];
    if (!last || !first) continue;
    const at = { start: aEnd, source: a.sourceOut, mediaId: a.mediaId! };
    const join = `“${text(firstIndex - 4, firstIndex)} ‖ ${text(firstIndex, firstIndex + 4)}”`;
    if (a.sourceOut - last.sourceEnd > LATE) flag("lateCut", at, `${round(a.sourceOut - last.sourceEnd)} s after the last word: ${join}`);
    if (first.source - b.sourceIn > LATE) flag("lateVoice", at, `${round(first.source - b.sourceIn)} s before the voice: ${join}`);
    const inWord = all.find(w => (w.start < a.sourceOut - IN_WORD && w.end > a.sourceOut + IN_WORD) || (w.start < b.sourceIn - IN_WORD && w.end > b.sourceIn + IN_WORD));
    if (inWord) flag("edgeInWord", at, `inside “${inWord.text.trim()}”: ${join}`);
    if (normalizeTranscriptToken(last.text) && normalizeTranscriptToken(last.text) === normalizeTranscriptToken(first.text)) flag("doubledAtJoin", at, join);
    const fragment = joinFragment(all as SaidWord[], a.sourceOut, b.sourceIn, a.sourceIn, b.sourceOut);
    if (fragment) flag("brokenSentence", at, `“${fragment.before.split(" ").slice(-5).join(" ")} ‖ ${fragment.after.split(" ").slice(0, 5).join(" ")}” (took “${fragment.removedStart.split(" ").slice(0, 6).join(" ")}…”)`);
  }
  const minutes = clips.length ? (Math.max(...clips.map(c => c.timelineIn + (c.sourceOut - c.sourceIn) / (c.speed ?? 1))) - Math.min(...clips.map(c => c.timelineIn))) / 60 : 0;
  return { flags: flags.sort((x, y) => x.at - y.at), minutes };
}

export const defaultLibrary = () => join(appSupportDir(), "data", "scarlet.db");

export function leftovers(dbPath = defaultLibrary(), only?: string): ProjectLeftovers[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const words = transcripts(db);
    const found: ProjectLeftovers[] = [];
    for (const p of db.prepare("select id, name, head from projects").all() as { id: string; name: string; head: string | null }[]) {
      if (!p.head || (only && only !== p.id && only !== p.name)) continue;
      const row = db.prepare("select json from timeline_versions where project_id = ? and version = ?").get(p.id, p.head) as { json: string } | undefined;
      if (!row) continue;
      const { flags, minutes } = flagsOf((JSON.parse(row.json) as { tracks: { kind?: string; clips: Clip[] }[] }).tracks, words);
      // An edit with under a minute of dialogue is a test or a short, not a pass to judge by.
      if (minutes < 1) continue;
      found.push({ id: p.id, name: p.name, head: p.head, minutes: round(minutes), flags, pass: keptByLatestPass(db, p.id) });
    }
    return found;
  } finally { db.close(); }
}

/** Each family's count over every edit, and per 10 minutes of edit so libraries of different sizes compare. */
export function totals(projects: readonly ProjectLeftovers[]): SweepTotals {
  const minutes = projects.reduce((n, p) => n + p.minutes, 0);
  const families = Object.fromEntries((Object.keys(FAMILIES) as Family[]).map(f => {
    const count = projects.reduce((n, p) => n + p.flags.filter(x => x.family === f).length, 0);
    return [f, { count, perTenMin: minutes ? round(count / minutes * 10) : 0 }];
  })) as Record<Family, FamilyTotal>;
  return { edits: projects.length, minutes: round(minutes), families };
}

/** The sweep of the editor's library, or undefined where this machine has none (CI, another computer). */
export function sweepLibrary(dbPath = defaultLibrary()): SweepTotals | undefined {
  return existsSync(dbPath) ? totals(leftovers(dbPath)) : undefined;
}

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };

if (import.meta.url === `file://${process.argv[1]}`) {
  const family = arg("family") as Family | undefined;
  if (family && !(family in FAMILIES)) throw new Error(`No family ${family}: ${Object.keys(FAMILIES).join(", ")}`);
  const projects = leftovers(arg("db") ?? defaultLibrary(), arg("project"));
  if (process.argv.includes("--json")) console.log(JSON.stringify({ totals: totals(projects), projects }, null, 1));
  else {
    for (const p of projects) {
      const shown = p.flags.filter(f => !family || f.family === family);
      console.log(`\n## ${p.name} (${p.id}, head ${p.head}, ${p.minutes} min)` + (p.pass ? `: its pass ${p.pass.taskId} kept ${p.pass.kept.length} repeats silently` : ""));
      for (const f of shown) console.log(`  ${clock(f.at)} ${f.family}${f.cutOffOnly ? " (cut-off word)" : ""}: ${f.text}  (src ${f.source})`);
    }
    const t = totals(projects);
    console.log(`\n${t.edits} edits, ${t.minutes} min. Flags per family (count, per 10 min), each one to listen to, not a mistake count:`);
    for (const [f, v] of Object.entries(t.families)) if (!family || f === family) console.log(`  ${f.padEnd(15)} ${String(v.count).padStart(4)}  ${v.perTenMin.toFixed(1).padStart(5)}  ${FAMILIES[f as Family]}`);
  }
}
