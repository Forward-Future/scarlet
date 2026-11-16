/**
 * Runner: for each case × (agent, model, effort) × trial, branch from the case's source version, launch the
 * same first-cut request the app sends, wait, score, and write JSON + Markdown outside the repository.
 *
 *   tsx evals/src/run.ts --evaluate-task tsk_… [--case id] [--reference-version v] [--kept-side]
 *   tsx evals/src/run.ts --cases a,b --configs codex:model:medium,claude:model:high --trials 3 --dry-run
 *   tsx evals/src/run.ts --cases a,b --configs … --trials 3 --yes      (launches agent tasks: billed)
 *   tsx evals/src/run.ts --summarize <results/runs/…>
 */
import { wordDigest } from "../../packages/mcp/src/transcript-digest.ts";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { cli, isMain, list, main } from "./args.ts";
import { listCases, loadCase, type LoadedCase } from "./case.ts";
import { scoreEntrances } from "./entrances.ts";
import type { Timeline } from "../../packages/timeline/src/index.ts";
import { Engine, type TaskRecord } from "./engine.ts";
import { fetchWords } from "./evidence.ts";
import { publishedGradingInputs } from "./gradingEvidence.ts";
import type { EventLike } from "./metrics.ts";
import { evaluateCaseOrigin, evaluateTask } from "./evaluate.ts";
import { DEFAULT_EDGE_OPTIONS, KEPT_SIDE_EDGE_OPTIONS } from "./metrics.ts";
import { checkedPath, dataDir, fileComponent, readJson, REPO_ROOT, resultsDir, timestamp, writeJson, writeText } from "./paths.ts";
import { evaluationMarkdown, runMarkdown, type TrialRow } from "./report.ts";

const USAGE = `Usage:
  run.ts --evaluate-task <taskId> [--case <id>] [--reference-version <v>] [--kept-side] [--refresh] [--engine <url>]
  run.ts --evaluate-case <id> [--kept-side]           (re-score the run a case was built from, offline)
  run.ts (--cases <a,b> | --suite capability|regression) --configs <agent:model:effort,...> [--trials N] [--skills name,... | --add-skills name,...] [--timeout-min M] (--dry-run | --yes)
  run.ts --summarize <run dir>

Results go to $SCARLET_EVAL_DATA/results (default: Scarlet's application support folder /evals).`;

interface AgentConfig { agent: string; model?: string; effort?: string }

async function transcriptSnapshot(engine: Engine, loaded: LoadedCase) {
  return Promise.all(loaded.file.dialogueMedia.map(async mediaId => {
    const words = await fetchWords(engine, mediaId);
    const frozen = loaded.evidence.get(mediaId)?.words;
    return { mediaId, count: words?.length ?? 0, sha256: words?.length ? wordDigest(words) : null,
      frozenSha256: frozen?.length ? wordDigest(frozen) : null };
  }));
}

type TranscriptSnapshot = Awaited<ReturnType<typeof transcriptSnapshot>>;
export function trialTranscripts(before: TranscriptSnapshot, after: TranscriptSnapshot, events: EventLike[]) {
  const reads = events.flatMap(e => {
    const d = e.data;
    return d?.kind === "eval_transcript" && typeof d.mediaId === "string" && typeof d.sha256 === "string"
      ? [{ mediaId: d.mediaId, sha256: d.sha256, count: d.count, at: e.at }] : [];
  });
  const mismatchedMedia = before.filter((v, i) => {
    const seen = reads.filter(r => r.mediaId === v.mediaId);
    return !v.frozenSha256 || v.sha256 !== v.frozenSha256 || v.sha256 !== after[i]?.sha256 ||
      !seen.length || seen.some(r => r.sha256 !== v.sha256 || r.count !== v.count);
  }).map(v => v.mediaId);
  return { before, reads, after, mismatchedMedia };
}

function parseConfig(spec: string): AgentConfig {
  const parts = spec.split(":");
  if (parts.length === 1) return { agent: parts[0]! };
  if (parts.length === 2) return { agent: parts[0]!, model: parts[1] || undefined };
  return { agent: parts[0]!, model: parts.slice(1, -1).join(":") || undefined, effort: parts.at(-1) || undefined };
}
const configLabel = (c: AgentConfig) => [c.agent, c.model ?? "default", c.effort ?? "default"].join(":");
const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-|-$/g, "");

/** The exact request the app's composer sends for a first cut, on a dedicated branch. */
function taskRequest(loaded: LoadedCase, config: AgentConfig, branch: string, skillIds: string[]) {
  const r = loaded.file.request;
  return {
    kind: "edit", agent: config.agent, ...(config.model && { model: config.model }), ...(config.effort && { effort: config.effort }),
    instruction: r.instruction,
    context: { branch, version: loaded.file.sourceVersion, skillIds, recordTranscriptDigests: true,
      ...(r.mediaId && { mediaId: r.mediaId }), ...(r.time !== undefined && { time: r.time }) },
  };
}

export function branchName(caseId: string, config: AgentConfig, trial: number, stamp: string) {
  const label = `eval ${caseId} ${configLabel(config)}`;
  const id = createHash("sha256").update(JSON.stringify([caseId, configLabel(config), trial, stamp])).digest("hex").slice(0, 12);
  const suffix = ` t${trial} ${stamp} ${id}`;
  return label.slice(0, 80 - suffix.length) + suffix;
}

interface SkillSelection { add: string[]; exact?: string[] }

export function selectTrialSkills(skills: Awaited<ReturnType<Engine["skills"]>>, wanted: LoadedCase["file"]["request"], selection: SkillSelection) {
  const available = skills.filter(s => s.enabled !== false);
  const selected = new Map<string, (typeof available)[number]>();
  const add = (skill: (typeof available)[number]) => selected.set(skill.id, skill);
  const addByName = (name: string) => {
    const match = available.find(s => s.name === name);
    if (!match) throw new Error(`Requested evaluation skill ${name} is unavailable.`);
    add(match);
  };
  if (!selection.exact) {
    // Captured IDs survive a rename. Fall back to the original name only when its ID is absent.
    const { skillIds, skillNames } = wanted;
    for (const [i, id] of skillIds.entries()) {
      const local = skills.find(s => s.id === id);
      if (local?.enabled === false) throw new Error(`Requested evaluation skill ${local.name} is disabled.`);
      if (local) add(local);
      else if (skillNames.length === skillIds.length) addByName(skillNames[i]!);
      else throw new Error(`Captured evaluation skill ${id} is unavailable. Choose its replacement with --skills.`);
    }
    if (!skillIds.length) skillNames.forEach(addByName);
  }
  (selection.exact ?? selection.add).forEach(addByName);
  return [...selected.values()].map(({ id, name, version }) => ({ id, name, version }));
}

const ACTIVE = new Set(["queued", "claimed", "running", "waiting_for_user"]);

async function waitForTask(engine: Engine, taskId: string, timeoutMs: number, log: (s: string) => void): Promise<TaskRecord> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    const { task } = await engine.task(taskId);
    if (task.state !== last) log(`  ${taskId}: ${task.state}`);
    last = task.state;
    if (!ACTIVE.has(task.state)) return task;
    if (task.state === "waiting_for_user" || Date.now() > deadline) {
      // A question is a failure for an unattended first cut; record it and stop the run.
      log(`  ${taskId}: ${task.state === "waiting_for_user" ? `asked “${String(task.question ?? "").slice(0, 120)}”` : "timed out"}; cancelling`);
      await engine.cancelTask(taskId).catch(() => undefined);
      for (let i = 0; i < 30; i++) {
        const { task: t } = await engine.task(taskId);
        if (!ACTIVE.has(t.state)) return t;
        await delay(2000);
      }
      return (await engine.task(taskId)).task;
    }
    await delay(10_000);
  }
}

async function reportEntrances(loaded: LoadedCase, timeline: Timeline, dir: string, headline: Record<string, number | null>) {
  const score = await scoreEntrances(loaded, timeline);
  if (!score) return;
  writeJson(join(dir, "picture-entrances.json"), score);
  Object.assign(headline, { verifiedPictureCuts: score.summary.verifiedPictures, eligibleEditorEntrances: score.summary.eligibleEditorEntrances,
    matchedPictureEntrances: score.summary.matched, pictureEntranceErrorMs: score.summary.meanAbsoluteErrorMs,
    pictureEntranceBiasMs: score.summary.meanErrorMs, candidateTrimmedEntrances: score.candidateTrimmedWords,
    candidateEntrancesInFade: score.candidateOnsetsInFade });
}

export function reportPublishedWords(inputs: NonNullable<ReturnType<typeof publishedGradingInputs>>, loaded: LoadedCase, applied: Timeline,
                             dir: string, headline: Record<string, number | null>) {
  const timeline = join(dir, "applied-timeline.json");
  writeJson(timeline, applied);
  const published = JSON.parse(execFileSync("python3", ["-B", join(REPO_ROOT, "evals/score_audio_reference.py"),
    "--reference", inputs.reference, "--case-dir", loaded.dir, "--evidence", inputs.evidence, "--timeline", timeline, "--verified-keeps", "--matched-joins"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })) as
    { referenceSha256: string; gradingEvidenceSha256: string; verifiedPublishedWords: number; missingVerifiedWords: number; verifiedWordRecall: number | null;
      cutWordDistance: { labeledWords: number; differingWords: number; differingFraction: number | null; retainedSkippedWords: number };
      spacing?: { editorWordRemovingCuts: number; recoveredWordRemovingCuts: number; sharedJoins: number; meanAbsErrorMs: number | null } };
  if (published.referenceSha256 !== inputs.referenceSha256 || published.gradingEvidenceSha256 !== inputs.evidenceSha256) {
    throw new Error("The scored reference or grading evidence differs from its frozen digest.");
  }
  writeJson(join(dir, "published-words.json"), published);
  Object.assign(headline, { verifiedPublishedWords: published.verifiedPublishedWords,
    missingVerifiedWords: published.missingVerifiedWords, verifiedWordRecall: published.verifiedWordRecall,
    labeledSourceWords: published.cutWordDistance.labeledWords, retainedSkippedWords: published.cutWordDistance.retainedSkippedWords,
    differingLabeledWords: published.cutWordDistance.differingWords, differingWordFraction: published.cutWordDistance.differingFraction,
    ...(published.spacing && { editorWordRemovingCuts: published.spacing.editorWordRemovingCuts,
      recoveredWordRemovingCuts: published.spacing.recoveredWordRemovingCuts, matchedAudioJoins: published.spacing.sharedJoins,
      matchedPauseErrorMs: published.spacing.meanAbsErrorMs }) });
}

async function runTrial(engine: Engine, loaded: LoadedCase, config: AgentConfig, trial: number, runId: string, dir: string, timeoutMs: number, selection: SkillSelection): Promise<TrialRow> {
  const grading = publishedGradingInputs(loaded);
  const caseId = loaded.file.id, projectId = loaded.file.projectId;
  const row: TrialRow = { caseId, config: configLabel(config), trial, state: "not started" };
  const busy = (await engine.tasks(projectId)).filter(t => t.kind !== "transcribe" && ACTIVE.has(t.state));
  if (busy.length) throw new Error(`Project ${projectId} has active tasks (${busy.map(t => t.id).join(", ")}). Wait until they finish.`);
  const project = await engine.project(projectId);
  const bound = loaded.file.gradingEvidence;
  if (bound && !project.media.some(m => m.id === bound.mediaId && m.hash === bound.sourceSha256)) {
    throw new Error("The engine project does not contain the frozen grading recording.");
  }
  const original = { branch: project.branch ?? "main", head: project.head! };
  const name = branchName(caseId, config, trial, runId);
  const skills = selectTrialSkills(await engine.skills(), loaded.file.request, selection);
  const skillIds = skills.map(s => s.id);
  writeJson(join(dir, "skills.json"), skills);
  const before = await transcriptSnapshot(engine, loaded);
  writeJson(join(dir, "transcripts.json"), { before });
  if (bound && before.some(s => !s.frozenSha256 || s.sha256 !== s.frozenSha256)) {
    throw new Error("The engine transcript differs from the frozen candidate evidence.");
  }
  await engine.switchBranch(projectId, { name, from: loaded.file.sourceVersion, expectedHead: original.head, expectedBranch: original.branch });
  let task: TaskRecord | undefined;
  try {
    task = await engine.createTask(projectId, taskRequest(loaded, config, name, skillIds));
    row.taskId = task.id;
    console.log(`  branch “${name}”, task ${task.id}`);
    task = await waitForTask(engine, task.id, timeoutMs, console.log);
  } finally {
    // Put the editor back on the branch they were using.
    const now = await engine.project(projectId);
    if (now.branch === name) await engine.switchBranch(projectId, { name: original.branch, expectedHead: now.head!, expectedBranch: name });
  }
  row.state = task.state;
  const completed = await engine.task(task.id);
  writeJson(join(dir, "task.json"), completed);
  if (task.state !== "done") row.error = task.error ?? `ended ${task.state}`;
  try {
    const after = await transcriptSnapshot(engine, loaded);
    const transcripts = trialTranscripts(before, after, completed.events);
    writeJson(join(dir, "transcripts.json"), transcripts);
    const evaluation = await evaluateTask(engine, task.id, { loaded });
    if (grading) {
      const applied = await engine.timeline(projectId, evaluation.score.versions.applied);
      await reportEntrances(loaded, applied, dir, evaluation.score.headline);
      reportPublishedWords(grading, loaded, applied, dir, evaluation.score.headline);
    }
    writeJson(join(dir, "evaluation.json"), evaluation);
    writeText(join(dir, "summary.md"), evaluationMarkdown(evaluation));
    if (transcripts.mismatchedMedia.length) row.error = [row.error, "missing or mismatched transcript read for " + transcripts.mismatchedMedia.join(", ")].filter(Boolean).join("; ");
    else row.headline = evaluation.score.headline;
  } catch (err) {
    row.error = [row.error, `evaluation: ${(err as Error).message}`].filter(Boolean).join("; ");
  }
  return row;
}

function summarize(runDir: string, title: string): TrialRow[] {
  const rows = readJson<TrialRow[]>(checkedPath(runDir, join(runDir, "trials.json")));
  writeText(join(runDir, "summary.md"), runMarkdown(title, rows), runDir);
  return rows;
}

/** A count or a limit from the command line. One that isn't a number would run no trials, or never time out. */
export function positiveNumber(flag: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} takes a number above zero, not “${value}”.`);
  return n;
}

async function runCli(argv = process.argv.slice(2)) {
  const { values } = cli({
    "evaluate-task": { type: "string" }, "evaluate-case": { type: "string" }, case: { type: "string" }, cases: { type: "string" }, suite: { type: "string" },
    configs: { type: "string" }, trials: { type: "string" }, "timeout-min": { type: "string" }, "dry-run": { type: "boolean" }, yes: { type: "boolean" },
    "reference-version": { type: "string" }, "kept-side": { type: "boolean" }, refresh: { type: "boolean" }, engine: { type: "string" },
    summarize: { type: "string" }, skills: { type: "string" }, "add-skills": { type: "string" },
  }, USAGE, argv);

  if (values.summarize) {
    const rows = summarize(values.summarize, `Run ${values.summarize.split("/").at(-1)}`);
    console.log(runMarkdown("Summary", rows));
    return;
  }

  if (values["evaluate-task"] || values["evaluate-case"]) {
    const edgeOptions = values["kept-side"] ? KEPT_SIDE_EDGE_OPTIONS : DEFAULT_EDGE_OPTIONS;
    const caseId = values["evaluate-case"] ?? values.case;
    const loaded = caseId ? loadCase(caseId) : undefined;
    const grading = loaded && publishedGradingInputs(loaded);
    const engine = values["evaluate-case"] ? undefined : await Engine.connect({ url: values.engine });
    const evaluation = values["evaluate-case"]
      ? await evaluateCaseOrigin(loaded!, { edgeOptions })
      : await evaluateTask(engine!, values["evaluate-task"]!, {
        loaded, referenceVersion: values["reference-version"], edgeOptions, refreshEvidence: values.refresh,
      });
    const dir = join(resultsDir(), "tasks", fileComponent(evaluation.taskId), timestamp() + (values["kept-side"] ? "-kept-side" : ""));
    if (loaded && (grading || existsSync(checkedPath(dataDir(), join(dataDir(), "pictures.json"))))) {
      const version = evaluation.score.versions.applied;
      const tl = loaded.timeline(version) ?? await engine?.timeline(loaded.file.projectId, version);
      if (!tl) throw new Error("The evaluated timeline is absent from the frozen case.");
      await reportEntrances(loaded, tl, dir, evaluation.score.headline);
      if (grading) reportPublishedWords(grading, loaded, tl, dir, evaluation.score.headline);
    }
    writeJson(join(dir, "evaluation.json"), evaluation);
    const md = evaluationMarkdown(evaluation);
    writeText(join(dir, "summary.md"), md);
    console.log(md.split("\n## Edges on speech")[0]);
    console.log(`Wrote ${dir}`);
    return;
  }

  const caseIds = values.cases ? list(values.cases) : values.suite ? listCases().filter(c => c.suite === values.suite).map(c => c.id) : [];
  const configs = list(values.configs).map(parseConfig);
  const trials = Math.max(1, Math.floor(positiveNumber("--trials", values.trials, 3)));
  const timeoutMs = positiveNumber("--timeout-min", values["timeout-min"], 120) * 60_000;
  if (!caseIds.length || !configs.length) throw new Error("Choose --cases or --suite, and --configs.\n\n" + USAGE);
  if (values.skills !== undefined && values["add-skills"] !== undefined) throw new Error("Choose --skills or --add-skills.");
  const selection: SkillSelection = { add: list(values["add-skills"]), exact: values.skills === undefined ? undefined : list(values.skills) };
  if (selection.exact && !selection.exact.length) throw new Error("--skills needs at least one installed skill name.");
  const cases = caseIds.map(loadCase);
  const total = cases.length * configs.length * trials;
  if (new Set(caseIds).size !== cases.length || new Set(configs.map(c => slug(configLabel(c)))).size !== configs.length) {
    throw new Error("Choose distinct cases and configurations so each trial has its own result directory.");
  }
  const runId = timestamp() + "-" + randomUUID().slice(0, 8);
  const runDir = join(resultsDir(), "runs", runId);

  if (values["dry-run"] || !values.yes) {
    let engine: Engine | undefined;
    try { engine = await Engine.connect({ url: values.engine }); } catch (err) { console.log(`(engine not reachable: ${(err as Error).message})`); }
    console.log(`Dry run: ${total} agent task(s) = ${cases.length} case(s) × ${configs.length} config(s) × ${trials} trial(s). Results → ${runDir}\n`);
    for (const loaded of cases) {
      publishedGradingInputs(loaded);
      const project = engine ? await engine.project(loaded.file.projectId).catch(() => undefined) : undefined;
      const skills = engine ? selectTrialSkills(await engine.skills(), loaded.file.request, selection) : undefined;
      const skillIds = skills?.map(s => s.id) ?? (selection.exact ? [] : loaded.file.request.skillIds);
      const names = skills?.map(s => s.name) ?? selection.exact ?? [...loaded.file.request.skillNames, ...selection.add];
      if (names.length) console.log(`  Skills: ${names.join(", ")}${skills ? "" : " (IDs resolved when connected)"}`);
      console.log(`Case ${loaded.file.id} (${loaded.file.suite}) · project ${loaded.file.projectId} · source ${loaded.file.sourceVersion}` +
        (project ? ` · editor currently on “${project.branch}” @ ${project.head}` : ""));
      for (const config of configs) for (let t = 1; t <= trials; t++) {
        const name = branchName(loaded.file.id, config, t, runId);
        console.log(`  ${configLabel(config)} trial ${t}:`);
        console.log(`    POST /projects/${loaded.file.projectId}/branches ${JSON.stringify({ name, from: loaded.file.sourceVersion, expectedHead: project?.head ?? "<head>", expectedBranch: project?.branch ?? "<branch>" })}`);
        console.log(`    POST /projects/${loaded.file.projectId}/tasks ${JSON.stringify(taskRequest(loaded, config, name, skillIds))}`);
        console.log(`    wait (≤ ${values["timeout-min"] ?? 120} min, cancel on a question) → switch back to “${project?.branch ?? "<branch>"}” → score → ${join(runDir, loaded.file.id, slug(configLabel(config)), `trial-${t}`)}`);
      }
    }
    if (!values["dry-run"]) console.log(`\nNothing launched. Add --yes to run ${total} billed agent task(s); trials run one at a time and switch the project's branch while they run.`);
    return;
  }

  const engine = await Engine.connect({ url: values.engine });
  const rows: TrialRow[] = [];
  for (const loaded of cases) for (const config of configs) for (let t = 1; t <= trials; t++) {
    const dir = join(runDir, loaded.file.id, slug(configLabel(config)), `trial-${t}`);
    console.log(`${loaded.file.id} · ${configLabel(config)} · trial ${t}/${trials}`);
    try {
      rows.push(await runTrial(engine, loaded, config, t, runId, dir, timeoutMs, selection));
    } catch (err) {
      rows.push({ caseId: loaded.file.id, config: configLabel(config), trial: t, state: "error", error: (err as Error).message });
      console.error(`  ${(err as Error).message}`);
      if (/active tasks|cut_changed/.test((err as Error).message)) break;
    }
    writeJson(join(runDir, "trials.json"), rows);
  }
  writeJson(join(runDir, "trials.json"), rows);
  summarize(runDir, `Run ${runDir.split("/").at(-1)}`);
  console.log(runMarkdown("Summary", rows));
  console.log(`Wrote ${runDir}`);
}

if (isMain(import.meta.url)) void main(() => runCli());
