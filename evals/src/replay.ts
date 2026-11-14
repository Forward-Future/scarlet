/**
 * Replay regression: run a stored dialogue_apply_cuts plan through the CURRENT planning code offline —
 * the same planDialogueCuts (packages/mcp/src/dialogue-plan.ts) the tool calls — and compare edges and decisions with what the run produced, or with an earlier replay.
 *
 *   tsx evals/src/replay.ts --case <id> [--plan plan.json] [--fingerprint <prefix>] [--baseline <replay.json>]
 *
 * The case must be built with --from-task … --with-scan. Scan windows become join evidence through the tool's own
 * dialogueScanPage. Offline there is no live measurement: an edge no scan window covers stays unmeasured.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DialogueEvidence } from "../../packages/mcp/src/dialogue-decisions.ts";
import { dialogueGate, dialogueScanPage, planDialogueCuts, resolveCutRange, type DialogueCutInput, type DialoguePlanSources, type GateLine } from "../../packages/mcp/src/dialogue-plan.ts";
import { gapSound, speakingLevel, type GapLevels } from "../../packages/mcp/src/gap-sound.ts";
import { cutAnchorOn } from "../../packages/shared/src/cutScope.ts";
import { taskDialogueOperation } from "../../packages/shared/src/threads.ts";
import { frameAligned, type Project, type TranscriptWord } from "../../packages/timeline/src/index.ts";
import { cli, isMain, main } from "./args.ts";
import { loadCase, type LoadedCase } from "./case.ts";
import { artifactsFromCase, evaluateCaseOrigin } from "./evaluate.ts";
import { windowKey, type ScanCapture, type ScanWaveforms } from "./evidence.ts";
import { overlap, subtract, type Range } from "./intervals.ts";
import { DEFAULT_EDGE_OPTIONS, classifyEdges, joinEdges, summarizeEdges, type EdgeReport, type EdgeSummary, type Kept, submittedPlans, type SubmittedPlan } from "./metrics.ts";
import { readJson, REPO_ROOT, resultsDir, timestamp, writeJson, writeText } from "./paths.ts";
import { keptSource, sourceSpan, type MediaInfo, type SourceRange } from "./timeline.ts";

const USAGE = `Usage:
  replay.ts --case <id> [--plan <plan.json>] [--fingerprint <prefix>]
            [--drop-quotes] [--parts] [--baseline <replay.json>] [--out <dir>]

--plan replays another { version, cuts[, range, only, crossfadeFrames] } on the case's source instead of the run's own plan.
--fingerprint chooses a saved scan-window set; by default every complete set is tried and the one that
best reproduces the original run is used (the run's own detector settings).
--drop-quotes replays the captured plan without optional quotes for an offline comparison.
--parts replays every part of a pass that saved as it went (the last plan on each version) and totals them.`;

type Tier = "applied" | "review" | "kept";

export interface ReplayedCut {
  index: number;
  kind?: string;
  decision?: string;
  submitted: Range;
  /** What the planner reported for this range (moves, staging and their evidence), when it changed it. */
  gate?: GateLine;
  replay: { tier: Tier; start: number; end: number; reason?: string };
  original?: { tier: Tier; start: number; end: number };
}

export interface ReplayResult {
  schema: 3;
  kind: "replay";
  generatedAt: string;
  caseId: string;
  taskId?: string;
  planVersion: string;
  code: { commit?: string; dirty: string[] };
  crossfadeFrames: number;
  fingerprint: string;
  dropQuotes: boolean;
  /** A disputed quote or repeated join goes back to the model before anything is saved. */
  outcome: "ready" | "preserved" | "needsRevision" | "rejected";
  error?: string;
  disputedEdges?: Array<Range & { reason: string }>;
  /** Share of submitted ranges whose replayed tier and edges (±1 ms) match the run, per scan-window set tried. */
  agreement: Record<string, number>;
  /** Planner changes, as "asked→outcome" per submitted range, plus how many moved an edge. */
  gate: { changed: Record<string, number>; moved: number; unchanged: number };
  transitions: Record<string, number>;
  /** `appliedOnFrames` is the applied tier as the engine saves it, each removal rounded inward to whole frames. */
  edges: { replay: { applied: EdgeSummary; review: EdgeSummary; appliedOnFrames?: EdgeSummary }; original?: { applied: EdgeSummary; review: EdgeSummary } };
  /** Each applied edge, on whole frames, that the recording is at speaking level at: where to listen first. Source seconds. */
  appliedOnSpeech?: EdgeReport[];
  cuts: ReplayedCut[];
}

/** The tool's join evidence for each stored scan window. */
export function scanEvidence(capture: ScanCapture, waveforms: ScanWaveforms): DialogueEvidence {
  const evidence = new DialogueEvidence();
  for (const page of capture.pages) {
    const w = waveforms[windowKey(page.from, page.to)];
    if (!w) continue;
    evidence.scans.push(dialogueScanPage(capture.mediaId, page.from, page.to, capture.audioStream, page.detections.segments,
      { from: w.from, to: w.to, peaks: w.peaks, rms: w.rms, speechActivity: page.detections.speechActivity }));
  }
  return evidence;
}

function gitState() {
  try {
    const commit = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["-C", REPO_ROOT, "status", "--porcelain", "--", "packages/mcp/src", "packages/timeline/src", "packages/shared/src"], { encoding: "utf8" })
      .split("\n").filter(Boolean).map(l => l.slice(3));
    return { commit, dirty };
  } catch {
    return { dirty: [] };
  }
}

const near = (a: Range, b: Range, tol = 0.001) => Math.abs(a.start - b.start) <= tol && Math.abs(a.end - b.end) <= tol;

export interface ReplayOptions {
  plan?: SubmittedPlan;
  fingerprint?: string;
  /** Compare the same plan offline with its optional quotes omitted. */
  dropQuotes?: boolean;
}

export async function replayCase(loaded: LoadedCase, opts: ReplayOptions = {}): Promise<ReplayResult> {
  const origin = await artifactsFromCase(loaded, { partial: true });
  const plan = opts.plan ?? origin.plan;
  if (!plan) throw new Error("The run submitted no dialogue_apply_cuts plan. Pass --plan.");
  const tl = loaded.timeline(plan.version);
  if (!tl) throw new Error(`Case ${loaded.file.id} lacks timeline ${plan.version}.`);
  const media: MediaInfo[] = loaded.file.media;
  const project = { id: loaded.file.projectId, name: "eval", settings: { fps: loaded.file.fps }, media } as unknown as Project;
  const context = origin.task.context;
  const localPauses = taskDialogueOperation(origin.task, origin.events.filter(e => e.type === "answer").map(e => e.text)) === "local-pauses";
  const anchorVersion = context.dialogueRange?.version ?? (!context.mediaId && context.time !== undefined ? context.version : undefined);
  const needsMapping = anchorVersion && anchorVersion !== "head" && anchorVersion !== tl.version;
  const originalTimeline = needsMapping ? loaded.timeline(anchorVersion) : undefined;
  if (needsMapping && !originalTimeline) throw new Error(`Case ${loaded.file.id} is missing the selection's timeline ${anchorVersion}. Rebuild it with --force.`);
  const anchor = cutAnchorOn(context, tl, originalTimeline);

  // The run's own outcome per submitted range, on the source clock.
  const original: Array<SourceRange & { tier: Tier }> = [];
  for (const [change, tier] of [[origin.applied, "applied"], [origin.review, "review"]] as const) {
    const from = change && origin.timelines.get(change.fromVersion);
    for (const r of (from && change?.cutReasons) || []) {
      const span = sourceSpan(from!, media, r);
      if (span) original.push({ ...span, tier });
    }
  }
  const toSource = (r: Range) => sourceSpan(tl, media, r);

  const sets = loaded.file.dialogueMedia.map(id => ({ id, captured: loaded.scans(id) })).filter(s => s.captured?.scans.length);
  if (!sets.length) throw new Error(`Case ${loaded.file.id} has no scan windows. Rebuild it with --with-scan.`);
  const candidates = opts.fingerprint
    ? [opts.fingerprint]
    : [...new Set(sets.flatMap(s => s.captured!.scans.filter(c => c.coverage >= 0.9).map(c => c.fingerprint)))];
  if (!candidates.length) candidates.push(sets[0]!.captured!.scans[0]!.fingerprint);

  const run = async (fingerprint: string) => {
    const evidence = new DialogueEvidence();
    // The stored scan windows' levels, for what sounds between two words.
    const levels = new Map<string, GapLevels[]>();
    for (const s of sets) {
      const capture = s.captured!.scans.find(c => c.fingerprint.startsWith(fingerprint)) ?? s.captured!.scans[0]!;
      evidence.scans.push(...scanEvidence(capture, s.captured!.waveforms).scans);
      levels.set(s.id, capture.pages.flatMap(page => { const w = s.captured!.waveforms[windowKey(page.from, page.to)]; return w ? [{ from: w.from, to: w.to, rms: w.rms }] : []; }));
    }
    const sources: DialoguePlanSources = {
      evidence, pages: () => evidence.scans, project: async () => project,
      words: async mediaId => (loaded.evidence.get(mediaId)?.words as TranscriptWord[] | undefined) ?? null,
      measure: async () => {}, crossfadeFrames: plan.crossfadeFrames,
      sound: async (mediaId, range) => {
        const page = levels.get(mediaId)?.find(p => p.from <= range.start && p.to >= range.end);
        return page && gapSound(page, range, speakingLevel(page), 0);
      },
    };
    const cutsIn = plan.cuts.map(c => {
      const { productionQuote, resumeWith, ...rest } = c as typeof c & { resumeWith?: string };
      return { ...rest, reason: c.reason ?? "", ...(!opts.dropQuotes && { productionQuote, resumeWith }) };
    }) as DialogueCutInput[];
    let planned: Awaited<ReturnType<typeof planDialogueCuts>>, error: string | undefined;
    try {
      planned = await planDialogueCuts({ tl, cuts: cutsIn, range: plan.range, only: plan.only as DialogueCutInput["kind"] | undefined, localPauses, anchor }, sources);
    } catch (err) {
      error = (err as Error).message;
      planned = { outcome: "preserved" };
    }
    const ready = planned.outcome === "ready" ? planned : undefined;
    const decisions = ready?.decisions ?? [];
    const gate = ready ? dialogueGate(ready) : { unchangedCuts: 0, decisions: [] };
    const byInput = new Map<number, { tier: Tier; start: number; end: number; reason: string }>();
    ready?.removals.forEach((removal, i) => {
      const c = decisions[i]!;
      byInput.set(removal.input, { tier: c.review ? "review" : "applied", start: c.start, end: c.end, reason: c.reason });
    });
    const cuts: ReplayedCut[] = [];
    for (const [index, c] of cutsIn.entries()) {
      const mine = byInput.get(index);
      // Word and pause references have no submitted seconds. Compare the range the planner placed to the original.
      const range = c.start !== undefined && c.end !== undefined ? { start: c.start, end: c.end }
        : ready?.removals.find(r => r.input === index) ?? await resolveCutRange(tl, c, `cuts[${index}]`, sources).catch(() => undefined);
      if (!range) continue; // An invalid reference is in the planner's rejection and has no range to score.
      const span = toSource(range);
      // The run's record for this range: the one overlapping it most (snaps and narrowing stay inside or within a few frames).
      const theirs = span && original.filter(o => o.mediaId === span.mediaId && overlap(o, span) > 0.001).sort((a, b) => overlap(b, span) - overlap(a, span))[0];
      const replayed = mine && toSource(mine);
      const line = gate.decisions.find(l => l.cut === index);
      cuts.push({
        index, kind: c.kind, decision: c.decision, submitted: { start: range.start, end: range.end }, ...(line && { gate: line }),
        replay: mine && replayed ? { tier: mine.tier, start: replayed.start, end: replayed.end, reason: mine.reason } : { tier: "kept", start: span?.start ?? range.start, end: span?.end ?? range.end },
        original: theirs ? { tier: theirs.tier, start: theirs.start, end: theirs.end } : { tier: "kept", start: span?.start ?? range.start, end: span?.end ?? range.end },
      });
    }
    const same = cuts.filter(c => c.original!.tier === c.replay.tier && (c.replay.tier === "kept" || near(c.original!, c.replay))).length;
    return { planned, error, decisions, gate, cuts, agreement: cuts.length ? same / cuts.length : 0 };
  };

  const tried: Array<{ fp: string; result: Awaited<ReturnType<typeof run>> }> = [];
  for (const fp of candidates) tried.push({ fp, result: await run(fp) });
  const best = [...tried].sort((a, b) => b.result.agreement - a.result.agreement)[0]!;
  const { planned, error, decisions, gate, cuts } = best.result;

  const changed: Record<string, number> = {}, transitions: Record<string, number> = {};
  for (const line of gate.decisions) changed[`${line.asked}→${line.outcome}`] = (changed[`${line.asked}→${line.outcome}`] ?? 0) + 1;
  for (const c of cuts) {
    const moved = c.original!.tier === c.replay.tier && c.replay.tier !== "kept" && !near(c.original!, c.replay) ? " (edges moved)" : "";
    const key = `${c.original!.tier}→${c.replay.tier}${moved}`;
    transitions[key] = (transitions[key] ?? 0) + 1;
  }
  // Edge quality of the replayed outcome, measured like a real run.
  const kS = keptSource(tl, media);
  const without = (kept: Kept, ranges: Range[]) => {
    const out = new Map(kept);
    for (const r of ranges) {
      const s = toSource(r);
      if (s) out.set(s.mediaId, subtract(out.get(s.mediaId) ?? [], [s]));
    }
    return out;
  };
  const kA = without(kS, decisions.filter(d => !d.review));
  // The engine saves each removal on whole frames, rounded inward. The edges that play are those, not the planner's.
  const kF = without(kS, decisions.filter(d => !d.review).map(d => frameAligned(d, loaded.file.fps)));
  const kR = without(kA, decisions.filter(d => d.review));
  const summarize = (before: Kept, after: Kept) => summarizeEdges(classifyEdges(joinEdges(before, after), loaded.evidence, DEFAULT_EDGE_OPTIONS));
  let originalEdges: ReplayResult["edges"]["original"];
  try {
    const scored = (await evaluateCaseOrigin(loaded)).score;
    originalEdges = { applied: scored.applied.edges, review: scored.review?.edges ?? summarize(kA, kA) };
  } catch { /* An origin without changes has no edges to compare. */ }

  return {
    schema: 3, kind: "replay", generatedAt: new Date().toISOString(), caseId: loaded.file.id, taskId: origin.task.id, planVersion: plan.version,
    code: gitState(), crossfadeFrames: plan.crossfadeFrames ?? 0, dropQuotes: !!opts.dropQuotes, fingerprint: best.fp,
    outcome: error ? "rejected" : planned.outcome, ...(error && { error }),
    ...(planned.outcome === "needsRevision" && { disputedEdges: planned.disputedEdges }),
    agreement: Object.fromEntries(tried.map(t => [t.fp.slice(0, 12), Math.round(t.result.agreement * 1000) / 1000])),
    gate: { changed, moved: gate.decisions.filter(l => l.from).length, unchanged: gate.unchangedCuts },
    transitions,
    edges: { replay: { applied: summarize(kS, kA), review: summarize(kA, kR), appliedOnFrames: summarize(kS, kF) }, original: originalEdges },
    appliedOnSpeech: classifyEdges(joinEdges(kS, kF), loaded.evidence, DEFAULT_EDGE_OPTIONS).filter(e => e.class === "speech"),
    cuts,
  };
}

export interface PartsResult {
  schema: 3;
  kind: "replay-parts";
  caseId: string;
  parts: ReplayResult[];
  /** Plans the case can't replay: it stores no timeline for the version they were submitted on. */
  skipped: Array<{ version: string; cuts: number }>;
}

/**
 * Replay every part of a pass that saved as it went: the last plan submitted on each version, each on its own
 * version's timeline. One plan is a few removals of a pass's hundreds, so this is the replay that covers the pass.
 */
export async function replayParts(loaded: LoadedCase, opts: Omit<ReplayOptions, "plan"> = {}): Promise<PartsResult> {
  const origin = await artifactsFromCase(loaded, { partial: true });
  const last = new Map<string, SubmittedPlan>();
  for (const plan of submittedPlans(origin.events)) if (plan.cuts.length) last.set(plan.version, plan);
  const parts: ReplayResult[] = [], skipped: PartsResult["skipped"] = [];
  for (const plan of last.values()) {
    if (loaded.timeline(plan.version)) parts.push(await replayCase(loaded, { ...opts, plan }));
    else skipped.push({ version: plan.version, cuts: plan.cuts.length });
  }
  return { schema: 3, kind: "replay-parts", caseId: loaded.file.id, parts, skipped };
}

const addEdges = (list: EdgeSummary[]) => ({
  total: list.reduce((n, e) => n + e.total, 0), speech: list.reduce((n, e) => n + e.speech, 0), silence: list.reduce((n, e) => n + e.silence, 0),
});

/** A pass's parts as one table: what each plan asked, what the planner did with it and where its edges landed. */
export function partsMarkdown(r: PartsResult, baseline?: PartsResult): string {
  const tiers = (p: ReplayResult) => {
    const n = { applied: 0, review: 0, kept: 0 };
    for (const c of p.cuts) n[c.replay.tier]++;
    return n;
  };
  const lines = [`# Replay of every part · case ${r.caseId}`, "",
    "| Part | Removals | Applied | Held for review | Not cut | Edges moved | Applied edges on speech | Outcome |", "|---|---|---|---|---|---|---|---|"];
  const total = { cuts: 0, applied: 0, review: 0, kept: 0, moved: 0 };
  for (const [i, p] of r.parts.entries()) {
    const t = tiers(p), e = p.edges.replay.applied;
    total.cuts += p.cuts.length; total.applied += t.applied; total.review += t.review; total.kept += t.kept; total.moved += p.gate.moved;
    lines.push(`| ${i + 1} (${p.planVersion.slice(0, 6)}) | ${p.cuts.length} | ${t.applied} | ${t.review} | ${t.kept} | ${p.gate.moved} | ${e.speech}/${e.total} | ${p.outcome}${p.error ? `: ${p.error.slice(0, 80)}` : ""} |`);
  }
  const applied = addEdges(r.parts.map(p => p.edges.replay.applied)), review = addEdges(r.parts.map(p => p.edges.replay.review));
  const frames = addEdges(r.parts.flatMap(p => p.edges.replay.appliedOnFrames ?? []));
  lines.push(`| **All** | ${total.cuts} | ${total.applied} | ${total.review} | ${total.kept} | ${total.moved} | ${applied.speech}/${applied.total} | |`, "",
    `Applied edges: ${applied.speech}/${applied.total} on speech, ${applied.silence} silent. Review edges: ${review.speech}/${review.total} on speech, ${review.silence} silent.`,
    `Applied edges as saved, on whole frames: ${frames.speech}/${frames.total} on speech, ${frames.silence} silent.`);
  if (r.skipped.length) lines.push("", `Not replayed (the case stores no timeline for the version): ${r.skipped.map(s => `${s.version.slice(0, 6)} (${s.cuts} removals)`).join(", ")}.`);
  if (baseline) {
    const changes = r.parts.flatMap(p => {
      const before = baseline.parts.find(b => b.planVersion === p.planVersion);
      return before ? compareReplays(before, p).map(d => ({ ...d, version: p.planVersion })) : [];
    });
    lines.push("", "## Against the baseline", "", changes.length ? `${changes.length} submitted ranges changed:` : "No submitted range changed.");
    for (const d of changes.slice(0, 80)) lines.push(`- ${d.version.slice(0, 6)} #${d.index} ${d.kind}: ${d.before.tier} ${d.before.start.toFixed(3)}–${d.before.end.toFixed(3)} → ${d.after.tier} ${d.after.start.toFixed(3)}–${d.after.end.toFixed(3)}`);
  }
  return lines.join("\n") + "\n";
}

/** Per-range differences between two replays of the same plan (e.g. before and after a code edit). */
export function compareReplays(before: ReplayResult, after: ReplayResult) {
  const changes: Array<{ index: number; kind?: string; before: ReplayedCut["replay"]; after: ReplayedCut["replay"] }> = [];
  for (const a of after.cuts) {
    const b = before.cuts.find(c => c.index === a.index);
    if (b && (b.replay.tier !== a.replay.tier || !near(b.replay, a.replay))) changes.push({ index: a.index, kind: a.kind, before: b.replay, after: a.replay });
  }
  return changes;
}

const fmt = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ") || "none";

export function replayMarkdown(r: ReplayResult, diff?: ReturnType<typeof compareReplays>, baseline?: string): string {
  const e = (s: EdgeSummary) => `${s.speech}/${s.total} on speech, ${s.silence} silent, ${s.onGrid["1s+0.48"] ?? 0} on the 0.48 grid`;
  const lines = [
    `# Replay · case ${r.caseId}${r.taskId ? ` · ${r.taskId}` : ""}`, "",
    `Code ${r.code.commit ?? "?"}${r.code.dirty.length ? ` + ${r.code.dirty.length} uncommitted files in packages/` : ""} · plan on ${r.planVersion} · ` +
      `scan windows ${r.fingerprint.slice(0, 12)}${r.dropQuotes ? " · optional quotes dropped" : ""} · crossfade ${r.crossfadeFrames} frames · ${r.generatedAt}`, "",
    `Outcome: **${r.outcome}**${r.error ? ` (${r.error})` : ""}${r.disputedEdges ? ` — ${r.disputedEdges.length} disputed edge${r.disputedEdges.length === 1 ? "" : "s"}` : ""}.`, "",
    `Agreement with the original run (tier and edges ±1 ms) by scan-window set: ${Object.entries(r.agreement).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(", ")}.`, "",
    `- Planner changes (gate): ${fmt(r.gate.changed)}; ${r.gate.moved} moved an edge; ${r.gate.unchanged} removals unchanged`,
    `- Original → replay: ${fmt(r.transitions)}`,
    `- Replayed edges: applied ${e(r.edges.replay.applied)}; review ${e(r.edges.replay.review)}`,
    ...(r.edges.original ? [`- Original edges: applied ${e(r.edges.original.applied)}; review ${e(r.edges.original.review)}`] : []),
  ];
  if (r.disputedEdges?.length) {
    lines.push("", "## Disputed edges", "");
    for (const d of r.disputedEdges.slice(0, 30)) lines.push(`- ${d.start.toFixed(2)}–${d.end.toFixed(2)}: ${d.reason}`);
  }
  if (diff) {
    lines.push("", `## Against ${baseline}`, "", diff.length ? `${diff.length} submitted ranges changed:` : "No submitted range changed.");
    for (const d of diff.slice(0, 60)) lines.push(`- #${d.index} ${d.kind}: ${d.before.tier} ${d.before.start.toFixed(3)}–${d.before.end.toFixed(3)} → ${d.after.tier} ${d.after.start.toFixed(3)}–${d.after.end.toFixed(3)}`);
  }
  const moved = r.cuts.filter(c => c.original && (c.original.tier !== c.replay.tier || (c.replay.tier !== "kept" && !near(c.original, c.replay))));
  if (moved.length) {
    lines.push("", `## Differences from the original run (${moved.length})`, "");
    for (const c of moved.slice(0, 60)) lines.push(`- #${c.index} ${c.kind}/${c.decision}: ${c.original!.tier} ${c.original!.start.toFixed(3)}–${c.original!.end.toFixed(3)} → ` +
      `${c.replay.tier} ${c.replay.start.toFixed(3)}–${c.replay.end.toFixed(3)}${c.gate?.evidence ? ` — ${String(c.gate.evidence).slice(0, 160)}` : ""}`);
  }
  return lines.join("\n") + "\n";
}

export async function replayCli(argv = process.argv.slice(2)) {
  const { values } = cli({ case: { type: "string" }, plan: { type: "string" }, fingerprint: { type: "string" }, baseline: { type: "string" }, out: { type: "string" },
    "drop-quotes": { type: "boolean" }, parts: { type: "boolean" } }, USAGE, argv);
  if (!values.case) throw new Error(USAGE);
  const loaded = loadCase(values.case);
  if (values.parts) {
    const result = await replayParts(loaded, { fingerprint: values.fingerprint, dropQuotes: values["drop-quotes"] });
    const baseline = values.baseline && existsSync(values.baseline) ? readJson<PartsResult>(values.baseline) : undefined;
    const dir = values.out ?? join(resultsDir(), "replays", loaded.file.id), stamp = `${timestamp()}-parts`;
    writeJson(join(dir, `${stamp}.json`), result, values.out);
    const md = partsMarkdown(result, baseline);
    writeText(join(dir, `${stamp}.md`), md, values.out);
    console.log(md);
    console.log(`Wrote ${join(dir, stamp)}.{json,md}`);
    return;
  }
  const result = await replayCase(loaded, { plan: values.plan ? readJson<SubmittedPlan>(values.plan) : undefined, fingerprint: values.fingerprint,
    dropQuotes: values["drop-quotes"] });
  const baseline = values.baseline && existsSync(values.baseline) ? readJson<ReplayResult>(values.baseline) : undefined;
  const diff = baseline ? compareReplays(baseline, result) : undefined;
  const dir = values.out ?? join(resultsDir(), "replays", loaded.file.id);
  const stamp = timestamp();
  writeJson(join(dir, `${stamp}.json`), result, values.out);
  const md = replayMarkdown(result, diff, values.baseline);
  writeText(join(dir, `${stamp}.md`), md, values.out);
  console.log(md.split("\n## Differences")[0]);
  console.log(`Wrote ${join(dir, stamp)}.{json,md}`);
}

if (isMain(import.meta.url)) void main(() => replayCli());
