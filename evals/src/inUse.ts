/**
 * Scarlet in use: how its work fares with the editor, read from their own library. Nothing here runs a model.
 *
 * - For you. Of what Scarlet sent the editor (its calls and the edits it flagged), how much they changed, by revising
 *   or rejecting it, and how much they kept as it was. Of every edit they changed, how much Scarlet had sent them first.
 * - Revisions. Of each revision the editor asked for, whether they kept the result or sent it back again.
 * - Speed and tokens. For each request: how long until it saved something to judge, until it was done, how long
 *   Scarlet worked, and the tokens it used (per minute of footage for a first cut).
 *
 * The library is opened read-only, so it can be read while Scarlet runs. Every figure is worked out again each time,
 * so running it again is all it takes to keep it current. Deleting a project deletes its history from the library, so
 * each run of the editor's own library also saves what it read to `<eval data>/in-use/history.json`, and the report
 * keeps what it saved about projects that are gone.
 *
 *   node_modules/.bin/tsx evals/src/inUse.ts [--db <scarlet.db> [--save]] [--since 2026-11-18] [--project <id or name>] [--json]
 */
import { DatabaseSync } from "node:sqlite";
import { Change, mergeRanges, Note, Timeline, type CutAssessment } from "../../packages/timeline/src/index.ts";
import { Task } from "../../packages/shared/src/api.ts";
import { callNumbers, cutInPass, passRunOver } from "../../packages/shared/src/passCalls.ts";
import { buildThreads, type Thread } from "../../packages/shared/src/threads.ts";
import { isRejectRequest, matchesEdit, REVISED_CHECK, threadTimeline, type EditRef, type ThreadEdit } from "../../packages/shared/src/threadTimeline.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cli, isMain, main } from "./args.ts";
import { defaultLibrary } from "./leftovers.ts";
import { dataDir, readJson, writeJson } from "./paths.ts";

type Link = Parameters<typeof threadTimeline>[2][number];

/** One project as the library holds it. */
export interface ProjectData {
  id: string;
  name: string;
  head: string | null;
  fps: number;
  changes: Change[];
  tasks: Task[];
  notes: Note[];
  links: Link[];
  /** Total tokens per task, across its runs. */
  tokens: Map<string, number>;
  /** Length in seconds of each version, as the library recorded it. */
  durations: Map<string, number>;
  read(version: string): Timeline | undefined;
}

export type Outcome = "kept" | "revised" | "rejected" | "waiting";

/** Something Scarlet made: a call it asked the editor about, or an edit in the video. */
export interface Decision {
  /** The call or edit: its project, and its pass and index or its change and place. */
  id: string;
  project: string;
  thread: string;
  kind: "call" | "edit";
  /** Scarlet sent it to the editor: every call, and an edit it flagged for a look. */
  flagged: boolean;
  outcome: Outcome;
  /** When Scarlet made it. */
  at: string;
  model?: string;
}

export type RevisionOutcome = "kept" | "revised again" | "rejected" | "waiting" | "gone";

/** One revision the editor asked for, of a call or of an edit, and what they did with what came back. */
export interface Revision {
  project: string;
  task: string;
  of: "call" | "edit";
  outcome: RevisionOutcome;
  at: string;
  model?: string;
}

export type RequestKind = "first cut" | "revision" | "rejection" | "edit";

/** One request the editor made, with every attempt of its run (a resume, a Retry) and the checks it started. */
export interface RequestStat {
  project: string;
  task: string;
  kind: RequestKind;
  at: string;
  model?: string;
  effort?: string;
  state: string;
  /** From the request to the first save with an edit in it. */
  firstResultMs?: number;
  /** From the request to the first call ready to play (a first cut's own measure). */
  firstCallMs?: number;
  /** From the request to the end of its last attempt, when it finished. */
  doneMs?: number;
  /** Time Scarlet spent working, without waiting for the editor or its turn. */
  activeMs: number;
  /** Tokens of the request's own runs. */
  tokens: number;
  /** Tokens of the checks it started (picture and learning checks). */
  checkTokens: number;
  /** Minutes of footage a first cut worked through. */
  sourceMinutes?: number;
}

const DAY = 86_400_000;

// -- reading the library ---------------------------------------------------------------------------------------------

/** Read the library's projects and hand them to `use`. Versions are read as they are needed, so the library stays open until it returns. */
export function withLibrary<T>(use: (projects: ProjectData[]) => T, dbPath = defaultLibrary(), only?: string): T {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT id, name, head, settings FROM projects WHERE deleted_at IS NULL ORDER BY created_at").all() as
      Array<{ id: string; name: string; head: string | null; settings: string }>;
    const parsed = <T>(schema: { parse(v: unknown): T }, sql: string, id: string) =>
      (db.prepare(sql).all(id) as Array<{ json: string }>).flatMap(r => {
        try { return [schema.parse(JSON.parse(r.json))]; } catch { return []; }
      });
    const timeline = db.prepare("SELECT json FROM timeline_versions WHERE project_id = ? AND version = ?");
    return use(rows.filter(p => !only || p.id === only || p.name === only).map(p => {
      const versions = new Map<string, Timeline | undefined>();
      const tokens = new Map((db.prepare(`SELECT task_id AS task, SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS total
        FROM task_usage WHERE project_id = ? GROUP BY task_id`).all(p.id) as Array<{ task: string; total: number }>).map(r => [r.task, r.total]));
      const durations = new Map((db.prepare("SELECT version, duration FROM timeline_versions WHERE project_id = ? AND duration IS NOT NULL")
        .all(p.id) as Array<{ version: string; duration: number }>).map(r => [r.version, r.duration]));
      return {
        id: p.id, name: p.name, head: p.head, fps: (JSON.parse(p.settings) as { fps?: number }).fps ?? 30,
        changes: parsed(Change, "SELECT json FROM changes WHERE project_id = ?", p.id),
        tasks: parsed(Task, "SELECT json FROM tasks WHERE project_id = ? AND kind != 'transcribe'", p.id),
        notes: parsed(Note, "SELECT json FROM notes WHERE project_id = ? AND json_extract(json, '$.changeId') IS NOT NULL", p.id),
        links: db.prepare(`SELECT v.version, v.parent, v.change_id AS changeId, v.description, v.created_at AS createdAt,
          json_extract(c.json, '$.revertsVersion') AS revertsVersion
          FROM timeline_versions v LEFT JOIN changes c ON c.id = v.change_id WHERE v.project_id = ?`).all(p.id) as unknown as Link[],
        tokens, durations,
        read(version: string) {
          if (!versions.has(version)) {
            const row = timeline.get(p.id, version) as { json: string } | undefined;
            versions.set(version, row ? Timeline.parse(JSON.parse(row.json)) : undefined);
          }
          return versions.get(version);
        },
      };
    }));
  } finally {
    db.close();
  }
}

// -- review outcomes -------------------------------------------------------------------------------------------------

/** The edit asks the editor for a look for a reason of Scarlet's own, not only because the editor had it revised. */
const flaggedEdit = (edit: ThreadEdit) => !!edit.onlyCheck || (!!edit.check && edit.check !== REVISED_CHECK);

/** A Keep is recorded on the edit, or on the later edit whose reason to look it carries. */
function isKept(changes: ReadonlyMap<string, Change>, edit: ThreadEdit) {
  return [edit, edit.reviewRef].some(ref => !!ref && changes.get(ref.changeId)?.kept?.some(k => k.spot === ref.spot));
}

/** The first attempt of each run, so a resumed or retried request counts once. */
function firstAttempts(tasks: readonly Task[]): Task[] {
  const retried = new Set(tasks.flatMap(t => t.retryTaskId ? [t.retryTaskId] : []));
  return tasks.filter(t => (!t.resumeRootId || t.resumeRootId === t.id) && !retried.has(t.id));
}

/** Every attempt of a request's run: its resumes, and the Retries the editor pressed with theirs. */
function attempts(root: Task, tasks: readonly Task[]): Task[] {
  const out: Task[] = [];
  let run: Task | undefined = root;
  for (let hops = 0; run && hops < 50; hops++) {
    const id: string = run.id;
    out.push(...tasks.filter(t => t.id === id || t.resumeRootId === id));
    run = run.retryTaskId ? tasks.find(t => t.id === run!.retryTaskId) : undefined;
  }
  return [...new Map(out.map(t => [t.id, t])).values()];
}

/** When a request was made. Every stored request has the time; an empty one sorts first and falls before any date. */
const madeAt = (t: Task) => t.createdAt ?? "";

/** A request about one call or one edit, as opposed to the whole video. */
const aboutOne = (t: Task) => !!t.context.changeId && (t.context.cutIndex !== undefined || t.context.editIndex !== undefined);

/** A revision the editor asked for: a request about one call or edit that isn't the × on its card. */
const isRevision = (t: Task) => (t.kind === "edit" || t.kind === "revise") && aboutOne(t) && !isRejectRequest(t);

/** The dialogue pass a request's calls are in: its latest proposal that nothing replaced or turned down. */
function finalPass(thread: Thread): Change | undefined {
  return thread.changes.filter(c => c.intent === "suggestion" && c.cutReasons?.length && !c.replacedBy && c.state !== "rejected")
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "")).at(-1);
}

/** The review index of each of an applied pass's joins, by its place or else by the range it took out. */
function joinIndexes(change: Change): Array<number | undefined> {
  const key = (r: { start: number; end: number }) => `${r.start.toFixed(3)}-${r.end.toFixed(3)}`;
  const byRange = new Map(change.cutAssessments?.map(a => [key(a), a.index]));
  return change.appliedReview?.joins.map(j => j.reviewIndex ?? byRange.get(key(j.removed))) ?? [];
}

/** The version that was the working cut at a moment: the latest on the way to today's that existed then. */
function headAt(project: ProjectData, at: string): string | undefined {
  const byVersion = new Map(project.links.map(l => [l.version, l]));
  for (let v = project.head ?? undefined, hops = 0; v && hops < 100_000; hops++) {
    const link = byVersion.get(v);
    if (!link) return;
    if ((link.createdAt ?? "") <= at) return v;
    v = link.parent ?? undefined;
  }
}

/** A request's list of edits as it stood at a moment, as the editor saw it then. */
function editsAt(project: ProjectData, thread: Thread, at: string): ThreadEdit[] | undefined {
  const version = headAt(project, at);
  const head = version && project.read(version);
  if (!head) return;
  const before = <T extends { createdAt?: string }>(items: readonly T[]) => items.filter(i => (i.createdAt ?? "") < at);
  try {
    return threadTimeline({ ...thread, changes: before(thread.changes), tasks: before(thread.tasks), flagged: thread.flagged && before(thread.flagged) },
      head, project.links, project.read, project.fps);
  } catch {
    return;
  }
}

/** What the editor did with each call and edit Scarlet made, and with each revision they asked for. */
export function reviewOutcomes(project: ProjectData): { decisions: Decision[]; revisions: Revision[] } {
  const decisions: Decision[] = [], revisions: Revision[] = [];
  const head = project.head ? project.read(project.head) : undefined;
  if (!head) return { decisions, revisions };
  const changes = new Map(project.changes.map(c => [c.id, c]));
  const tasks = new Map(project.tasks.map(t => [t.id, t]));
  const modelOf = (taskId?: string) => (taskId && tasks.get(taskId)?.model) || undefined;
  const asked = firstAttempts(project.tasks).filter(isRevision).sort((a, b) => madeAt(a).localeCompare(madeAt(b)));
  const threads = buildThreads({ changes: project.changes, tasks: project.tasks, notes: project.notes });
  const seen = new Set<string>();

  for (const thread of threads) {
    if (!thread.changes.some(c => c.state === "approved" || c.state === "ready" || c.state === "revising")) continue;
    const pass = finalPass(thread);

    // Calls: the editor's to decide whatever they are, so each one was sent to them.
    const calls = new Set<number>();
    if (pass) {
      const over = passRunOver(pass, project.changes, project.tasks);
      for (const index of callNumbers(pass, mergeRanges(pass.cutReasons ?? []).length, over).keys()) calls.add(index);
      const sentBack = new Map<number, Task[]>();
      for (const t of asked) {
        if (t.context.cutIndex === undefined) continue;
        const index = cutInPass(pass, t.context, project.changes, project.tasks);
        if (index !== undefined) sentBack.set(index, [...sentBack.get(index) ?? [], t]);
      }
      for (const index of calls) {
        const assessment: CutAssessment | undefined = pass.cutAssessments?.find(a => a.index === index);
        const choice = pass.cutChoices?.find(c => c.index === index)?.choice;
        const proposed = assessment?.proposes === "keep" ? "keep" : "cut";
        const decided: "kept" | "rejected" | "waiting" = !choice ? "waiting" : choice === proposed ? "kept" : "rejected";
        const back = sentBack.get(index) ?? [];
        const revised = back.length > 0 || !!assessment?.revised;
        decisions.push({ id: `${project.id}/${pass.id}/call ${index}`, project: project.id, thread: thread.id, kind: "call", flagged: true,
          outcome: revised ? "revised" : decided, at: pass.createdAt ?? thread.createdAt, model: modelOf(pass.taskId) });
        back.forEach((t, i) => revisions.push({ project: project.id, task: t.id, of: "call", outcome: i < back.length - 1 ? "revised again" : decided,
          at: madeAt(t), model: t.model }));
      }
    }

    // Edits in the video, each once, as its own request lists it. A call the editor kept is in the video too, and
    // counts as the call.
    let edits: ThreadEdit[];
    try {
      edits = threadTimeline(thread, head, project.links, project.read, project.fps);
    } catch {
      continue;
    }
    const passJoins = pass?.appliedReview ? joinIndexes(pass) : [];
    for (const edit of edits) {
      if (edit.elsewhere || edit.marker) continue;
      const key = `${edit.changeId}#${edit.spot}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (pass && edit.changeId === pass.id && calls.has(passJoins[edit.spot] ?? -1)) continue;
      const made = changes.get(edit.previous[0]?.changeId ?? edit.changeId);
      const base = { id: `${project.id}/${key}`, project: project.id, thread: thread.id, kind: "edit" as const,
        at: made?.createdAt ?? thread.createdAt, model: modelOf(made?.taskId) };
      const back = asked.filter(t => t.context.editIndex !== undefined && matchesEdit(edit, { changeId: t.context.changeId!, spot: t.context.editIndex }));
      // A doubt another request raised about this edit lists it there.
      const doubted = threads.some(other => other !== thread && other.flagged?.some(c => c.id === edit.changeId &&
        c.flags?.some(f => f.spot === edit.spot)));
      if (!back.length) {
        const outcome: Outcome = edit.rejected ? "rejected" : isKept(changes, edit) ? "kept" : "waiting";
        decisions.push({ ...base, flagged: flaggedEdit(edit) || !!doubted, outcome });
        continue;
      }
      // Revised: whether it was sent to the editor is read from the list as it stood when they asked.
      const first = back[0]!;
      const then = editsAt(project, thread, madeAt(first))?.find(e => matchesEdit(e, { changeId: first.context.changeId!, spot: first.context.editIndex! }));
      decisions.push({ ...base, flagged: then ? flaggedEdit(then) : flaggedEdit(edit) || !!doubted, outcome: "revised" });
      const now: RevisionOutcome = edit.rejected ? "rejected" : isKept(changes, edit) ? "kept" : "waiting";
      back.forEach((t, i) => revisions.push({ project: project.id, task: t.id, of: "edit", outcome: i < back.length - 1 ? "revised again" : now,
        at: madeAt(t), model: t.model }));
    }
  }

  // A revision whose edit is no longer in the video, such as one an undo took out, is still a revision asked for.
  const counted = new Set(revisions.map(r => r.task));
  for (const t of asked) {
    if (!counted.has(t.id)) revisions.push({ project: project.id, task: t.id, of: t.context.cutIndex !== undefined ? "call" : "edit", outcome: "gone",
      at: madeAt(t), model: t.model });
  }
  return { decisions, revisions };
}

// -- speed and tokens ------------------------------------------------------------------------------------------------

const ms = (from: string, to?: string) => from && to ? Math.max(0, Date.parse(to) - Date.parse(from)) : undefined;

/** Each request the editor made, with how fast it got to something they could judge and what it cost. */
export function requestStats(project: ProjectData): RequestStat[] {
  const all = project.tasks;
  return firstAttempts(all).filter(t => t.kind === "edit" || t.kind === "revise").map(root => {
    const run = attempts(root, all);
    const ids = new Set(run.map(t => t.id));
    const last = run.reduce((a, b) => madeAt(a) > madeAt(b) ? a : b);
    const saves = project.changes.filter(c => c.taskId && ids.has(c.taskId)).sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
    const firstEdit = saves.find(c => c.cutReasons?.length || c.timelineEdits?.length || c.appliedReview);
    const playable = saves.flatMap(c => c.firstDecisionPreview?.briefToPlayableMs ?? []);
    const checks = all.filter(t => t.context.checksTaskId && ids.has(t.context.checksTaskId));
    const kind: RequestKind = root.context.dialogueOperation === "first-cut" ? "first cut" : isRejectRequest(root) ? "rejection" : aboutOne(root) ? "revision" : "edit";
    const longest = Math.max(0, ...saves.map(c => project.durations.get(c.toVersion) ?? 0));
    return {
      project: project.id, task: root.id, kind, at: madeAt(root), model: last.model ?? root.model, effort: last.effort ?? root.effort, state: last.state,
      firstResultMs: firstEdit && ms(madeAt(root), firstEdit.createdAt),
      firstCallMs: playable.length ? Math.min(...playable) : undefined,
      doneMs: last.state === "done" ? ms(madeAt(root), last.finishedAt) : undefined,
      activeMs: run.reduce((n, t) => n + (t.workedMs ?? 0), 0),
      tokens: run.reduce((n, t) => n + (project.tokens.get(t.id) ?? 0), 0),
      checkTokens: checks.reduce((n, t) => n + (project.tokens.get(t.id) ?? 0), 0),
      ...(kind === "first cut" && longest > 0 && { sourceMinutes: longest / 60 }),
    };
  });
}

// -- what earlier runs saved -----------------------------------------------------------------------------------------

export interface History {
  projects: Array<{ id: string; name: string }>;
  decisions: Decision[];
  revisions: Revision[];
  requests: RequestStat[];
}

export const historyPath = () => join(dataDir(), "in-use", "history.json");

/**
 * What the library holds now, with what an earlier run saved about projects the library no longer has. A project
 * still in the library is read afresh, so an edit since undone or a decision taken back leaves its figures too.
 */
export function merge(saved: History | undefined, now: History): History {
  const live = new Set(now.projects.map(p => p.id));
  const gone = <T extends { project: string }>(items: readonly T[] = []) => items.filter(i => !live.has(i.project));
  return {
    projects: [...gone((saved?.projects ?? []).map(p => ({ ...p, project: p.id }))).map(({ id, name }) => ({ id, name })), ...now.projects],
    decisions: [...gone(saved?.decisions), ...now.decisions],
    revisions: [...gone(saved?.revisions), ...now.revisions],
    requests: [...gone(saved?.requests), ...now.requests],
  };
}

// -- the report ------------------------------------------------------------------------------------------------------

export interface Summary {
  forYou: { sent: number; waiting: number; decided: number; changed: number; kept: number };
  missed: { changed: number; sentFirst: number };
  revisions: { asked: number; kept: number; again: number; rejected: number; waiting: number; gone: number };
}

export function summarize(decisions: readonly Decision[], revisions: readonly Revision[]): Summary {
  const sent = decisions.filter(d => d.flagged);
  const changed = (d: Decision) => d.outcome === "revised" || d.outcome === "rejected";
  const count = (o: RevisionOutcome) => revisions.filter(r => r.outcome === o).length;
  return {
    forYou: { sent: sent.length, waiting: sent.filter(d => d.outcome === "waiting").length, decided: sent.filter(d => d.outcome !== "waiting").length,
      changed: sent.filter(changed).length, kept: sent.filter(d => d.outcome === "kept").length },
    missed: { changed: decisions.filter(changed).length, sentFirst: sent.filter(changed).length },
    revisions: { asked: revisions.length, kept: count("kept"), again: count("revised again"), rejected: count("rejected"), waiting: count("waiting"), gone: count("gone") },
  };
}

const median = (values: readonly number[]) => {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const pct = (n: number, d: number) => d ? `${Math.round(100 * n / d)}%` : "–";
const share = (n: number, d: number) => d ? `${n} of ${d}`.padEnd(10) + pct(n, d).padStart(5) : "none yet";
const clock = (t?: number) => {
  if (t === undefined) return "–";
  const s = Math.round(t / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const tok = (n?: number) => n === undefined ? "–" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(Math.round(n));
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
/** Monday of the week a moment falls in, in UTC. */
const weekOf = (iso: string) => {
  const d = new Date(iso.slice(0, 10) + "T00:00:00Z");
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
};
const table = (rows: string[][]) => {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map(r => r[i]!.length)));
  return rows.map(r => "  " + r.map((c, i) => i ? c.padStart(widths[i]!) : c.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n");
};

function speedRows(requests: readonly RequestStat[], label: (r: RequestStat) => string): string[][] {
  const groups = new Map<string, RequestStat[]>();
  for (const r of requests) groups.set(label(r), [...groups.get(label(r)) ?? [], r]);
  const rows = [["", "n", "first result", "done", "worked", "tokens", "per footage min"]];
  for (const [name, group] of groups) {
    const perMinute = group.flatMap(r => r.sourceMinutes ? [(r.tokens + r.checkTokens) / r.sourceMinutes] : []);
    rows.push([name, String(group.length), clock(median(group.flatMap(r => r.firstResultMs ?? []))), clock(median(group.flatMap(r => r.doneMs ?? []))),
      clock(median(group.map(r => r.activeMs))), tok(median(group.map(r => r.tokens + r.checkTokens))), perMinute.length ? tok(median(perMinute)) : ""]);
  }
  return rows;
}

export function report(projects: ReadonlyArray<{ id: string }>, decisions: readonly Decision[], revisions: readonly Revision[], requests: readonly RequestStat[]): string {
  const dates = requests.map(r => r.at).sort();
  const s = summarize(decisions, revisions);
  const out: string[] = [];
  out.push(`Scarlet in use · ${projects.length} project${projects.length === 1 ? "" : "s"} · ${requests.length} requests` +
    (dates.length ? ` · ${day(dates[0]!)} – ${day(dates.at(-1)!)}` : ""));
  out.push("", "For you: what Scarlet sent you (calls and flagged edits)");
  out.push(`  Sent to you         ${s.forYou.sent}${s.forYou.waiting ? ` (${s.forYou.waiting} still waiting)` : ""}`);
  out.push(`  Worth your look     ${share(s.forYou.changed, s.forYou.decided)}  you revised or rejected it`);
  out.push(`  Kept as it was      ${share(s.forYou.kept, s.forYou.decided)}`);
  out.push(`  Edits you changed   ${s.missed.changed}`);
  out.push(`  Sent to you first   ${share(s.missed.sentFirst, s.missed.changed)}  the rest Scarlet missed`);
  out.push("", "Revisions you asked for");
  const settled = s.revisions.kept + s.revisions.again + s.revisions.rejected;
  if (!s.revisions.asked) out.push("  none yet");
  else if (settled) {
    out.push(`  Kept first time     ${share(s.revisions.kept, settled)}`);
    out.push(`  Revised again       ${share(s.revisions.again, settled)}`);
    out.push(`  Rejected after      ${share(s.revisions.rejected, settled)}`);
  }
  if (s.revisions.waiting || s.revisions.gone) {
    out.push(`  Not settled         ${s.revisions.waiting} waiting${s.revisions.gone ? `, ${s.revisions.gone} no longer in the video` : ""}`);
  }
  out.push("", "Speed and tokens, median per request");
  const order: RequestKind[] = ["first cut", "revision", "rejection", "edit"];
  if (!requests.length) out.push("  none yet");
  else out.push(table(speedRows([...requests].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)), r => r.kind[0]!.toUpperCase() + r.kind.slice(1))));
  const firstCuts = requests.filter(r => r.kind === "first cut");
  if (new Set(firstCuts.map(r => r.model)).size > 1) {
    out.push("", "First cuts by model");
    out.push(table(speedRows(firstCuts, r => [r.model ?? "unknown", r.effort].filter(Boolean).join(" "))));
  }
  const weeks = [...new Set([...decisions.map(d => d.at), ...revisions.map(r => r.at), ...requests.map(r => r.at)].map(weekOf))].sort();
  if (weeks.length > 1) {
    out.push("", "By week");
    const rows = [["week of", "worth your look", "sent first", "kept first time", "first cut result", "first cut tokens"]];
    for (const week of weeks) {
      const w = summarize(decisions.filter(d => weekOf(d.at) === week), revisions.filter(r => weekOf(r.at) === week));
      const cuts = firstCuts.filter(r => weekOf(r.at) === week);
      const firm = w.revisions.kept + w.revisions.again + w.revisions.rejected;
      rows.push([day(week), pct(w.forYou.changed, w.forYou.decided), pct(w.missed.sentFirst, w.missed.changed), pct(w.revisions.kept, firm),
        clock(median(cuts.flatMap(r => r.firstResultMs ?? []))), cuts.length ? tok(median(cuts.map(r => r.tokens + r.checkTokens))) : "–"]);
    }
    out.push(table(rows));
  }
  return out.join("\n");
}

if (isMain(import.meta.url)) {
  const usage = "usage: tsx evals/src/inUse.ts [--db <scarlet.db> [--save]] [--since <date>] [--project <id or name>] [--json]\n\n" +
    "Reads your own library unless --db names another, and saves what it read so a deleted project's history stays.\n" +
    "--save also saves from the --db library, such as a copy of your own taken before projects were deleted.";
  const { values } = cli({ db: { type: "string" }, save: { type: "boolean" }, since: { type: "string" }, project: { type: "string" },
    json: { type: "boolean" } }, usage);
  main(async () => {
    if (values.since && Number.isNaN(Date.parse(values.since))) throw new Error(`--since ${values.since} isn't a date`);
    const since = values.since ? new Date(values.since).toISOString() : "";
    const now = withLibrary(projects => ({
      projects: projects.map(p => ({ id: p.id, name: p.name })),
      ...(projects.map(p => ({ ...reviewOutcomes(p), requests: requestStats(p) })).reduce((all, r) => ({
        decisions: [...all.decisions, ...r.decisions], revisions: [...all.revisions, ...r.revisions], requests: [...all.requests, ...r.requests],
      }), { decisions: [] as Decision[], revisions: [] as Revision[], requests: [] as RequestStat[] })),
    }), values.db, values.project);
    // One project is a look at that project, not the record of the library.
    const saving = !values.project && (!values.db || values.save);
    const saved = existsSync(historyPath()) ? readJson<History>(historyPath()) : undefined;
    const all = values.project ? now : merge(saved, now);
    if (saving) writeJson(historyPath(), all);
    const recent = <T extends { at: string }>(items: T[]) => items.filter(i => i.at >= since);
    const decisions = recent(all.decisions), revisions = recent(all.revisions), requests = recent(all.requests);
    const shown = all.projects.filter(p => requests.some(r => r.project === p.id) || decisions.some(d => d.project === p.id));
    console.log(values.json
      ? JSON.stringify({ summary: summarize(decisions, revisions), decisions, revisions, requests }, null, 2)
      : report(shown, decisions, revisions, requests));
  });
}
