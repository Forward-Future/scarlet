/**
 * The picture scorecard: facts about what a cut shows, never a match with one editor's taste, with a ± for luck as
 * the dialogue scorecard has. Nothing here runs a model.
 *
 * - Clear of what you talk about. While you say a sentence you marked (talkedAbout.ts), how much of the main thing you
 *   marked is on screen: not under the camera, not cut off by a zoom or crop. It needn't be exact, so a cut scores by
 *   how close it gets: a zoom that trims a tenth of the box scores 90% on that sentence. Any placement that shows it
 *   all scores 100%, a zoom into it included. The wider view marked round it is also fine to show, so a crop may cut
 *   it and the camera over it is only reported.
 * - Shown while you talk about it. While you say a sentence you marked, the screen is on picture at all.
 * - Kept off when it mustn't show. While you say a sentence you marked "don't show the screen" (notes, a script, a
 *   call), the screen isn't on picture.
 * - No flash shots. No layout (camera, camera over the screen, screen) on for under FLASH_SECONDS between two others.
 *
 *   tsx evals/src/pictureScorecard.ts <run dir>[,<run dir>] [<another side>] [--labels a,b] [--json]
 *   tsx evals/src/pictureScorecard.ts --project <name or id> [--db <scarlet.db>]      (the project's video as it is now)
 *   tsx evals/src/pictureScorecard.ts --timeline <timeline.json>[,...]
 *
 * Marks are looked for in <eval data>/talked-about/<screen recording>.json. A trial is scored from the timeline it
 * applied, which run.ts saves beside its evaluation.json.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { timelineDuration, type Timeline } from "../../packages/timeline/src/index.ts";
import { cli, isMain, list, main } from "./args.ts";
import { pictureAt, shownAt } from "./layout.ts";
import { defaultLibrary } from "./leftovers.ts";
import { dataDir, fileComponent, readJson } from "./paths.ts";
import { layoutOf, type Layout, type Placement } from "./picture.ts";
import { acrossCases, compareFigure, eligibleTrials, rateScore, standardError, stat, type Stat } from "./scorecard.ts";
import type { Box, TalkedFile } from "./talkedAbout.ts";

/** A layout shown for less than this between two others is a flash. */
export const FLASH_SECONDS = 1.5;
/** Flash shots per 10 minutes at which No flash shots is 50%. */
export const FLASH_HALF_LIFE = 2;
/** A sentence counts as off picture when the screen is off for at least this share of the time it plays. */
const MOSTLY = 0.5;
/** How often a sentence is looked at while it plays. */
const STEP = 0.25;
/** The camera over this much of the wider view is reported. */
const WIDER_REPORTED = 0.1;

export type PictureFactorId = "clearOfTalk" | "shownWhileTalked" | "keptOff" | "noFlashes";
export const PICTURE_FACTORS: ReadonlyArray<{ id: PictureFactorId; label: string; means: string }> = [
  { id: "clearOfTalk", label: "Clear of what you talk about", means: "while you say a sentence you marked, how much of the main thing you marked is on screen, on average: not under the camera and not cut off by a zoom or crop" },
  { id: "shownWhileTalked", label: "Shown while you talk about it", means: "while you say a sentence you marked, the screen is on picture" },
  { id: "keptOff", label: "Kept off when it mustn't show", means: "while you say a sentence you marked \"don't show the screen\", the screen isn't on picture" },
  { id: "noFlashes", label: "No flash shots", means: `no layout on screen for under ${FLASH_SECONDS} s between two others (50% at ${FLASH_HALF_LIFE}/10 min)` },
];

export interface FactorValue { pct: number | null; detail: string }
export type PictureFactors = Record<PictureFactorId, FactorValue>;

const r1 = (v: number) => Math.round(v * 10) / 10;
const pct = (share: number) => `${Math.round(100 * share)}%`;
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const area = (b: Box) => Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);
const meet = (a: Box, b: Box): Box => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
const overlap = (a: Box, b: Box) => area(meet(a, b));
const asBox = (r: Placement["rect"]): Box => ({ left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h });
const FRAME: Box = { left: 0, top: 0, right: 1, bottom: 1 };

/** Where a mark on the screen recording lands in the frame, and how much of it the screen's crop keeps. */
export function inFrame(mark: Box, screen: Placement): { box: Box; kept: number } {
  const s = screen.shown, r = screen.rect;
  const kept = area(mark) ? overlap(mark, { left: s.x, top: s.y, right: s.x + s.w, bottom: s.y + s.h }) / area(mark) : 0;
  const x = (v: number) => r.x + (v - s.x) / s.w * r.w, y = (v: number) => r.y + (v - s.y) / s.h * r.h;
  return { box: { left: x(mark.left), top: y(mark.top), right: x(mark.right), bottom: y(mark.bottom) }, kept };
}

/** How much of some marks a moment shows: the share on screen, and the shares under the camera and cut off by a zoom or crop. */
export interface Seen { seen: number; underCamera: number; cutOff: number }

/** What a moment shows of marks, by area: undefined when the screen isn't on picture at all. */
export function seenAt(layers: Record<string, Placement>, camera: string, screen: string, marks: readonly Box[]): Seen | undefined {
  const shown = layers[screen];
  if (!shown) return undefined;
  const cam = layers[camera];
  let whole = 0, visible = 0, covered = 0;
  for (const mark of marks) {
    const { box } = inFrame(mark, shown), onScreen = meet(meet(box, asBox(shown.rect)), FRAME);
    const hidden = cam ? overlap(onScreen, asBox(cam.rect)) : 0;
    whole += area(box); visible += area(onScreen) - hidden; covered += hidden;
  }
  if (!whole) return { seen: 1, underCamera: 0, cutOff: 0 };
  return { seen: visible / whole, underCamera: covered / whole, cutOff: 1 - (visible + covered) / whole };
}

export interface SentenceCheck extends Seen {
  from: number; to: number; text: string;
  /** The screen is off picture for most of the sentence. */
  off: boolean;
  /** The moment that shows least of the main thing, or the first one the screen is off. */
  at: number;
  /** The camera sits over the wider view marked round the main thing (reported, not counted against the cut). */
  widerCovered: boolean;
}

/** Each marked sentence the cut plays, and how much of the main thing it shows on average while the screen is up. */
export function checkSentences(tl: Timeline, marks: TalkedFile): SentenceCheck[] {
  const out: SentenceCheck[] = [];
  for (const label of marks.labels) {
    const main = label.boxes.filter(b => !b.wider), wider = label.boxes.filter(b => b.wider);
    if (!main.length) continue;
    const moments: Array<{ t: number; seen?: Seen; wider?: Seen }> = [];
    for (let c = label.from; c <= label.to; c += STEP) {
      const p = pictureAt(tl, marks.camera, c);
      if (p) moments.push({ t: p.t, seen: seenAt(p.layers, marks.camera, marks.screen, main), wider: wider.length ? seenAt(p.layers, marks.camera, marks.screen, wider) : undefined });
    }
    if (!moments.length) continue;
    const up = moments.filter(m => m.seen), off = up.length / moments.length <= 1 - MOSTLY;
    const mean = (f: (s: Seen) => number) => up.length ? up.reduce((a, m) => a + f(m.seen!), 0) / up.length : 0;
    const worst = up.length ? up.reduce((a, m) => m.seen!.seen < a.seen!.seen ? m : a) : moments[0]!;
    out.push({ from: label.from, to: label.to, text: label.text, off, at: (off ? moments.find(m => !m.seen) ?? worst : worst).t,
      seen: mean(s => s.seen), underCamera: mean(s => s.underCamera), cutOff: mean(s => s.cutOff),
      widerCovered: up.some(m => (m.wider?.underCamera ?? 0) >= WIDER_REPORTED) });
  }
  return out;
}

/** Each sentence marked "don't show the screen" that the cut plays, and whether it shows the screen for a good part of it. */
export function checkHidden(tl: Timeline, marks: TalkedFile): Array<{ from: number; text: string; shown: boolean; at: number }> {
  return marks.labels.filter(l => l.hide).flatMap(label => {
    const seen: Array<{ on: boolean; t: number }> = [];
    for (let c = label.from; c <= label.to; c += STEP) {
      const p = pictureAt(tl, marks.camera, c);
      if (p) seen.push({ on: !!p.layers[marks.screen], t: p.t });
    }
    if (!seen.length) return [];
    const shown = seen.filter(s => s.on).length / seen.length >= MOSTLY / 2;
    return [{ from: label.from, text: label.text, shown, at: (seen.find(s => s.on === shown) ?? seen[0]!).t }];
  });
}

/** Each stretch of one layout, in order. */
export function layoutRuns(tl: Timeline, camera: string, step = 0.1): Array<{ start: number; seconds: number; layout: Layout }> {
  const end = timelineDuration(tl), runs: Array<{ start: number; seconds: number; layout: Layout }> = [];
  for (let i = 0; i * step < end; i++) {
    const t = i * step, layout = layoutOf({ t, mediaId: camera, source: 0, layers: shownAt(tl, t) }), last = runs.at(-1);
    if (last?.layout === layout) last.seconds = Math.round((t + step - last.start) * 100) / 100;
    else runs.push({ start: Math.round(t * 100) / 100, seconds: step, layout });
  }
  return runs;
}

/** Stretches shown for under FLASH_SECONDS between two others. Nothing at all on screen isn't a layout a viewer reads. */
export function flashes(tl: Timeline, camera: string) {
  const runs = layoutRuns(tl, camera).filter(r => r.layout !== "other" || r.seconds >= FLASH_SECONDS);
  return runs.filter((r, i) => i > 0 && i < runs.length - 1 && r.seconds < FLASH_SECONDS - 1e-6 && runs[i - 1]!.layout !== r.layout && runs[i + 1]!.layout !== r.layout);
}

/** One cut's figures. Without marks for its screen recording only No flash shots has one. */
export function pictureFactors(tl: Timeline, camera: string, marks?: TalkedFile): PictureFactors & { sentences: SentenceCheck[] } {
  const seconds = timelineDuration(tl), found = flashes(tl, camera);
  const checks = marks ? checkSentences(tl, marks) : [];
  const on = checks.filter(c => !c.off), offAt = checks.filter(c => c.off).slice(0, 3).map(c => clock(c.at)).join(", ");
  const avg = (f: (c: SentenceCheck) => number) => on.reduce((a, c) => a + f(c), 0) / on.length;
  const least = [...on].sort((a, b) => a.seen - b.seen).filter(c => c.seen < 0.995).slice(0, 3).map(c => `${clock(c.at)} ${pct(c.seen)}`).join(", ");
  const widerCovered = on.filter(c => c.widerCovered);
  const hidden = marks ? checkHidden(tl, marks) : [], leaked = hidden.filter(h => h.shown);
  return {
    sentences: checks,
    clearOfTalk: !marks ? { pct: null, detail: "no marks for this screen recording" } : !on.length ? { pct: null, detail: "no marked sentence plays with the screen on picture" }
      : { pct: r1(100 * avg(c => c.seen)), detail: `on average ${pct(avg(c => c.seen))} of the main thing is on screen over ${on.length} marked sentences ` +
        `(the camera hides ${pct(avg(c => c.underCamera))}, zooms and crops cut off ${pct(avg(c => c.cutOff))})` + (least ? `; least at ${least}` : "") +
        (widerCovered.length ? `; the camera sits over the wider view in ${widerCovered.length} (${widerCovered.slice(0, 3).map(c => clock(c.at)).join(", ")}), not counted` : "") },
    shownWhileTalked: !marks ? { pct: null, detail: "no marks for this screen recording" } : !checks.length ? { pct: null, detail: "no marked sentence plays" }
      : { pct: r1(100 * on.length / checks.length), detail: `${on.length} of ${checks.length} marked sentences play with the screen on picture` +
        (checks.length > on.length ? ` (off at ${offAt})` : "") },
    keptOff: !marks ? { pct: null, detail: "no marks for this screen recording" } : !hidden.length ? { pct: null, detail: "no sentence marked \"don't show the screen\" plays" }
      : { pct: r1(100 * (hidden.length - leaked.length) / hidden.length), detail: `${hidden.length - leaked.length} of ${hidden.length} sentences marked "don't show the screen" keep it off` +
        (leaked.length ? ` (shown at ${leaked.slice(0, 3).map(h => clock(h.at)).join(", ")})` : "") },
    noFlashes: seconds > 0
      ? { pct: rateScore(found.length, seconds, FLASH_HALF_LIFE), detail: `${found.length} flash shots (${r1(found.length / (seconds / 600))}/10 min)` +
        (found.length ? `, first at ${found.slice(0, 3).map(f => clock(f.start)).join(", ")}` : "") }
      : { pct: null, detail: "an empty cut" },
  };
}

// -- one side's card -------------------------------------------------------------------------------------------------

export interface PictureTrial { caseId: string; factors: PictureFactors }
export interface PictureCard {
  label: string;
  trials: number;
  cases: string[];
  factors: Record<PictureFactorId, Stat | null>;
  byCase: Record<string, Record<PictureFactorId, Stat | null>>;
  /** Each recording's passes as their Overall: what the ± on that row is read from. */
  overallByCase: Record<string, Stat | null>;
  overall: number | null;
}

const mean = (values: number[]) => values.length ? r1(values.reduce((a, b) => a + b, 0) / values.length) : null;
const overallOf = (pcts: Array<number | null>) => mean(pcts.filter((p): p is number => p !== null));

export function pictureCard(label: string, trials: readonly PictureTrial[]): PictureCard {
  const groups = new Map<string, PictureTrial[]>();
  for (const t of trials) groups.set(t.caseId, [...groups.get(t.caseId) ?? [], t]);
  const byCase: PictureCard["byCase"] = {}, overallByCase: PictureCard["overallByCase"] = {};
  for (const [id, ts] of groups) {
    byCase[id] = Object.fromEntries(PICTURE_FACTORS.map(f => [f.id, ts.every(t => t.factors[f.id].pct !== null) ? stat(ts.map(t => t.factors[f.id].pct!)) : null])) as Record<PictureFactorId, Stat | null>;
    overallByCase[id] = stat(ts.flatMap(t => { const o = overallOf(PICTURE_FACTORS.map(f => t.factors[f.id].pct)); return o === null ? [] : [o]; }));
  }
  const factors = Object.fromEntries(PICTURE_FACTORS.map(f => [f.id, acrossCases(Object.values(byCase).map(c => c[f.id]))])) as Record<PictureFactorId, Stat | null>;
  return { label, trials: trials.length, cases: [...groups.keys()], factors, byCase, overallByCase,
    overall: overallOf(PICTURE_FACTORS.map(f => factors[f.id]?.mean ?? null)) };
}

const cell = (value: number | null, perCase: Record<string, Stat | null>) => {
  if (value === null) return "–";
  const se = standardError(Object.values(perCase));
  return `${value}%${se === null ? "" : ` ±${r1(2 * se)}`}`;
};

export function pictureMarkdown(cards: readonly PictureCard[], details?: PictureFactors): string {
  const two = cards.length === 2;
  const lines = ["# Picture scorecard", "", cards.map(c => `**${c.label}**: ${c.trials} cut${c.trials === 1 ? "" : "s"} of ${c.cases.join(", ")}`).join(" · "), "",
    `| Factor | ${cards.map(c => c.label).join(" | ")} |${two ? " Change |" : ""} 100% means |`, `|---|${cards.map(() => "---").join("|")}|${two ? "---|" : ""}---|`];
  const row = (name: string, values: Array<number | null>, cases: Array<Record<string, Stat | null>>, means: string) => {
    const change = two ? ` ${compareFigure(cases[0]!, cases[1]!, values[0] !== null && values[1] !== null ? values[1]! - values[0]! : null).text} |` : "";
    lines.push(`| ${name} | ${values.map((v, i) => cell(v, cases[i]!)).join(" | ")} |${change} ${means} |`);
  };
  row("**Overall**", cards.map(c => c.overall), cards.map(c => c.overallByCase), "the mean of the factors below");
  for (const f of PICTURE_FACTORS) {
    row(f.label, cards.map(c => c.factors[f.id]?.mean ?? null), cards.map(c => Object.fromEntries(Object.entries(c.byCase).map(([id, s]) => [id, s[f.id]]))), f.means);
  }
  if (!cards.some(c => Object.values(c.overallByCase).some(s => (s?.n ?? 0) > 1))) lines.push("", "No ±: it needs two cuts or more of a recording.");
  if (details) lines.push("", "## What each figure is made of", "", ...PICTURE_FACTORS.map(f => `- **${f.label}:** ${details[f.id].detail}.`));
  return lines.join("\n") + "\n";
}

// -- reading cuts ----------------------------------------------------------------------------------------------------

/** The marks made on a screen recording, if any. */
export function marksFor(screen: string): TalkedFile | undefined {
  const path = join(dataDir(), "talked-about", fileComponent(screen) + ".json");
  return existsSync(path) ? readJson<TalkedFile>(path) : undefined;
}

/** A cut's marks: those made against the camera it plays, whether or not it shows their screen recording. */
function marksIn(tl: Timeline): TalkedFile | undefined {
  const ids = new Set(tl.tracks.flatMap(t => t.clips).flatMap(c => "mediaId" in c && typeof c.mediaId === "string" ? [c.mediaId] : []));
  const dir = join(dataDir(), "talked-about");
  if (!existsSync(dir)) return;
  const all = readdirSync(dir).filter(f => f.endsWith(".json")).map(f => readJson<TalkedFile>(join(dir, f)));
  return all.find(m => ids.has(m.camera) && ids.has(m.screen)) ?? all.find(m => ids.has(m.camera));
}

/** The presenter's recording of a cut: its marks' camera, or the recording its sound mostly plays. */
function cameraOf(tl: Timeline, marks?: TalkedFile): string {
  if (marks) return marks.camera;
  const seconds = new Map<string, number>();
  for (const t of tl.tracks) if (t.kind === "audio") for (const c of t.clips) if ("mediaId" in c && typeof c.mediaId === "string") {
    seconds.set(c.mediaId, (seconds.get(c.mediaId) ?? 0) + (c.sourceOut - c.sourceIn));
  }
  return [...seconds].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

function scoreTimeline(caseId: string, tl: Timeline): PictureTrial & { sentences: SentenceCheck[] } {
  const marks = marksIn(tl);
  const { sentences, ...factors } = pictureFactors(tl, cameraOf(tl, marks), marks);
  return { caseId, factors, sentences };
}

/** The trials under a run (or a configuration's folder in it) that saved the timeline they applied. */
function trialsAt(path: string): { trials: PictureTrial[]; skipped: number } {
  const selected = resolve(path);
  if (!existsSync(selected) || !statSync(selected).isDirectory()) throw new Error(`No such run folder: ${path}`);
  let run = selected;
  while (!existsSync(join(run, "trials.json")) && dirname(run) !== run) run = dirname(run);
  if (!existsSync(join(run, "trials.json"))) throw new Error(`${path} isn't in a run folder with trials.json.`);
  let skipped = 0;
  const trials = eligibleTrials(run).filter(({ file }) => { const rel = relative(selected, file); return rel !== ".." && !rel.startsWith(".." + sep); })
    .flatMap(({ file, row }) => {
      const timeline = join(dirname(file), "applied-timeline.json");
      if (!existsSync(timeline)) { skipped++; return []; }
      return [scoreTimeline(row.caseId, readJson<Timeline>(timeline))];
    });
  return { trials, skipped };
}

/** A project's video as it is now, read-only from the library. */
function projectTimeline(dbPath: string, wanted: string): { name: string; timeline: Timeline } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const p = db.prepare("SELECT id, name, head FROM projects WHERE deleted_at IS NULL AND (id = ? OR name = ?)").get(wanted, wanted) as { id: string; name: string; head: string | null } | undefined;
    if (!p?.head) throw new Error(`No project “${wanted}” with a video in ${dbPath}.`);
    const row = db.prepare("SELECT json FROM timeline_versions WHERE project_id = ? AND version = ?").get(p.id, p.head) as { json: string };
    return { name: p.name, timeline: JSON.parse(row.json) as Timeline };
  } finally {
    db.close();
  }
}

if (isMain(import.meta.url)) {
  const usage = "usage: tsx evals/src/pictureScorecard.ts <run dir>[,...] [<another side>] [--labels a,b] [--json]\n" +
    "       tsx evals/src/pictureScorecard.ts --project <name or id> [--db <scarlet.db>]\n" +
    "       tsx evals/src/pictureScorecard.ts --timeline <file>[,...]";
  const { values, positionals } = cli({ labels: { type: "string" }, json: { type: "boolean" }, project: { type: "string" }, db: { type: "string" },
    timeline: { type: "string" } }, usage);
  main(async () => {
    const labels = list(values.labels);
    const sides: Array<{ label: string; trials: Array<PictureTrial & { sentences?: SentenceCheck[] }>; skipped: number }> = [];
    if (values.project) {
      const { name, timeline } = projectTimeline(values.db ?? defaultLibrary(), values.project);
      sides.push({ label: labels[0] ?? name, trials: [scoreTimeline(name, timeline)], skipped: 0 });
    } else if (values.timeline) {
      sides.push({ label: labels[0] ?? "These cuts", trials: list(values.timeline).map(f => scoreTimeline("timeline", readJson<Timeline>(resolve(f)))), skipped: 0 });
    } else {
      if (!positionals.length) throw new Error(usage);
      positionals.forEach((p, i) => {
        const read = p.split(",").map(trialsAt);
        sides.push({ label: labels[i] ?? (positionals.length === 1 ? "This run" : p.replace(/\/+$/, "").split("/").at(-1)!),
          trials: read.flatMap(r => r.trials), skipped: read.reduce((n, r) => n + r.skipped, 0) });
      });
    }
    for (const s of sides) {
      if (s.skipped) console.error(`${s.label}: ${s.skipped} passes saved no timeline, so they aren't scored.`);
      if (!s.trials.length) throw new Error(`${s.label}: nothing to score.`);
    }
    const cards = sides.map(s => pictureCard(s.label, s.trials));
    const one = sides.length === 1 && sides[0]!.trials.length === 1 ? sides[0]!.trials[0]! : undefined;
    console.log(values.json ? JSON.stringify({ cards, ...(one && { details: one.factors, sentences: one.sentences }) }, null, 2) : pictureMarkdown(cards, one?.factors));
  });
}
