/**
 * Runner: for each case × (agent, model, effort) × trial, branch from the case's source version, launch the
 * same first-cut request the app sends, wait, score, and write JSON + Markdown outside the repository.
 *
 *   tsx evals/src/run.ts --evaluate-task tsk_… [--case id] [--reference-version v] [--kept-side]
 *   tsx evals/src/run.ts --cases a,b --configs codex:model:medium,claude:model:high --trials 3 --dry-run
 *   tsx evals/src/run.ts --cases a,b --configs … --trials 3 --yes      (launches agent tasks: billed)
 *   tsx evals/src/run.ts --summarize <results/runs/…>
 */
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { cli, isMain, list, main } from "./args.ts";
import { listCases, loadCase, type LoadedCase } from "./case.ts";
import { Engine, type TaskRecord } from "./engine.ts";
import { evaluateCaseOrigin, evaluateTask } from "./evaluate.ts";
import { DEFAULT_EDGE_OPTIONS, KEPT_SIDE_EDGE_OPTIONS } from "./metrics.ts";
import { checkedPath, fileComponent, readJson, resultsDir, timestamp, writeJson, writeText } from "./paths.ts";
import { evaluationMarkdown, runMarkdown, type TrialRow } from "./report.ts";

const USAGE = `Usage:
  run.ts --evaluate-task <taskId> [--case <id>] [--reference-version <v>] [--kept-side] [--refresh] [--engine <url>]
  run.ts --evaluate-case <id> [--kept-side]           (re-score the run a case was built from, offline)
  run.ts (--cases <a,b> | --suite capability|regression) --configs <agent:model:effort,...> [--trials N] [--timeout-min M] (--dry-run | --yes)
  run.ts --summarize <run dir>

Results go to $SCARLET_EVAL_DATA/results (default: Scarlet's application support folder /evals).`;

export interface AgentConfig { agent: string; model?: string; effort?: string }

export function parseConfig(spec: string): AgentConfig {
  const parts = spec.split(":");
  if (parts.length === 1) return { agent: parts[0]! };
  if (parts.length === 2) return { agent: parts[0]!, model: parts[1] || undefined };
  return { agent: parts[0]!, model: parts.slice(1, -1).join(":") || undefined, effort: parts.at(-1) || undefined };
}
export const configLabel = (c: AgentConfig) => [c.agent, c.model ?? "default", c.effort ?? "default"].join(":");
const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-|-$/g, "");

/** The exact request the app's composer sends for a first cut, on a dedicated branch. */
export function taskRequest(loaded: LoadedCase, config: AgentConfig, branch: string, skillIds: string[]) {
  const r = loaded.file.request;
  return {
    kind: "edit", agent: config.agent, ...(config.model && { model: config.model }), ...(config.effort && { effort: config.effort }),
    instruction: r.instruction,
    context: { branch, version: loaded.file.sourceVersion, skillIds, ...(r.mediaId && { mediaId: r.mediaId }), ...(r.time !== undefined && { time: r.time }) },
  };
}

export function branchName(caseId: string, config: AgentConfig, trial: number, stamp: string) {
  return `eval ${caseId} ${configLabel(config)} t${trial} ${stamp}`.slice(0, 80);
}

async function resolveSkills(engine: Engine, loaded: LoadedCase): Promise<string[]> {
  const skills = await engine.skills();
  const ids = new Set(skills.map(s => s.id));
  const wanted = loaded.file.request;
  const kept = wanted.skillIds.filter(id => ids.has(id));
  for (const name of wanted.skillNames) {
    const found = skills.find(s => s.name === name);
    if (found && !kept.includes(found.id)) kept.push(found.id);
  }
  if (wanted.skillNames.length && !kept.length) throw new Error(`Skills ${wanted.skillNames.join(", ")} are not installed.`);
  return kept;
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

async function runTrial(engine: Engine, loaded: LoadedCase, config: AgentConfig, trial: number, dir: string, timeoutMs: number): Promise<TrialRow> {
  const caseId = loaded.file.id, projectId = loaded.file.projectId;
  const row: TrialRow = { caseId, config: configLabel(config), trial, state: "not started" };
  const busy = (await engine.tasks(projectId)).filter(t => t.kind !== "transcribe" && ACTIVE.has(t.state));
  if (busy.length) throw new Error(`Project ${projectId} has active tasks (${busy.map(t => t.id).join(", ")}). Wait until they finish.`);
  const project = await engine.project(projectId);
  const original = { branch: project.branch ?? "main", head: project.head! };
  const name = branchName(caseId, config, trial, timestamp());
  const skillIds = await resolveSkills(engine, loaded);
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
  writeJson(join(dir, "task.json"), await engine.task(task.id));
  if (task.state !== "done") row.error = task.error ?? `ended ${task.state}`;
  try {
    const evaluation = await evaluateTask(engine, task.id, { loaded });
    writeJson(join(dir, "evaluation.json"), evaluation);
    writeText(join(dir, "summary.md"), evaluationMarkdown(evaluation));
    row.headline = evaluation.score.headline;
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

export async function runCli(argv = process.argv.slice(2)) {
  const { values } = cli({
    "evaluate-task": { type: "string" }, "evaluate-case": { type: "string" }, case: { type: "string" }, cases: { type: "string" }, suite: { type: "string" },
    configs: { type: "string" }, trials: { type: "string" }, "timeout-min": { type: "string" }, "dry-run": { type: "boolean" }, yes: { type: "boolean" },
    "reference-version": { type: "string" }, "kept-side": { type: "boolean" }, refresh: { type: "boolean" }, engine: { type: "string" },
    summarize: { type: "string" },
  }, USAGE, argv);

  if (values.summarize) {
    const rows = summarize(values.summarize, `Run ${values.summarize.split("/").at(-1)}`);
    console.log(runMarkdown("Summary", rows));
    return;
  }

  if (values["evaluate-task"] || values["evaluate-case"]) {
    const edgeOptions = values["kept-side"] ? KEPT_SIDE_EDGE_OPTIONS : DEFAULT_EDGE_OPTIONS;
    const evaluation = values["evaluate-case"]
      ? await evaluateCaseOrigin(loadCase(values["evaluate-case"]), { edgeOptions })
      : await evaluateTask(await Engine.connect({ url: values.engine }), values["evaluate-task"]!, {
        loaded: values.case ? loadCase(values.case) : undefined, referenceVersion: values["reference-version"], edgeOptions, refreshEvidence: values.refresh,
      });
    const dir = join(resultsDir(), "tasks", fileComponent(evaluation.taskId), timestamp() + (values["kept-side"] ? "-kept-side" : ""));
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
  const cases = caseIds.map(loadCase);
  const total = cases.length * configs.length * trials;
  const runDir = join(resultsDir(), "runs", timestamp());

  if (values["dry-run"] || !values.yes) {
    let engine: Engine | undefined;
    try { engine = await Engine.connect({ url: values.engine }); } catch (err) { console.log(`(engine not reachable: ${(err as Error).message})`); }
    console.log(`Dry run: ${total} agent task(s) = ${cases.length} case(s) × ${configs.length} config(s) × ${trials} trial(s). Results → ${runDir}\n`);
    for (const loaded of cases) {
      const project = engine ? await engine.project(loaded.file.projectId).catch(() => undefined) : undefined;
      const skillIds = engine ? await resolveSkills(engine, loaded).catch(err => [`<${(err as Error).message}>`]) : loaded.file.request.skillIds;
      console.log(`Case ${loaded.file.id} (${loaded.file.suite}) · project ${loaded.file.projectId} · source ${loaded.file.sourceVersion}` +
        (project ? ` · editor currently on “${project.branch}” @ ${project.head}` : ""));
      for (const config of configs) for (let t = 1; t <= trials; t++) {
        const name = branchName(loaded.file.id, config, t, "<time>");
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
      rows.push(await runTrial(engine, loaded, config, t, dir, timeoutMs));
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
