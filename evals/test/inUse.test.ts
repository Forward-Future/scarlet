import { describe, expect, it } from "vitest";
import { Change, timelineFromKeepRanges, type Timeline } from "../../packages/timeline/src/index.ts";
import { Task } from "../../packages/shared/src/api.ts";
import { merge, report, requestStats, reviewOutcomes, summarize, type ProjectData } from "../src/inUse.ts";

const timeline = (version: string): Timeline => ({ ...timelineFromKeepRanges("prj", "interview", [{ start: 0, end: 600 }]), version });
const scarlet = { type: "agent", name: "Scarlet" } as const;
const at = (day: number, seconds = 0) => new Date(Date.UTC(2026, 10, day, 12, 0, seconds)).toISOString();

function task(id: string, fields: Record<string, unknown> = {}): Task {
  return Task.parse({ id, projectId: "prj", kind: "edit", agent: "codex", instruction: "Tighten it", state: "done", createdAt: at(17), createdBy: { type: "human", name: "Editor" },
    model: "gpt-6.2-sol", ...fields, context: { threadId: "req", ...(fields.context as object) } });
}

function project(changes: Change[], tasks: Task[], extra: Partial<ProjectData> = {}): ProjectData {
  const versions = [...new Set(changes.map(c => c.toVersion))];
  return {
    id: "prj", name: "Interview", head: versions.at(-1) ?? null, fps: 30, changes, tasks, notes: [],
    links: versions.map((version, i) => ({ version, parent: versions[i - 1] ?? null, createdAt: changes.find(c => c.toVersion === version)!.createdAt })),
    tokens: new Map(), durations: new Map(), read: timeline, ...extra,
  };
}

describe("what the editor did with Scarlet's edits", () => {
  const batch = Change.parse({ id: "batch", projectId: "prj", threadId: "req", taskId: "req", fromVersion: "v0", toVersion: "v1", state: "approved",
    description: "Tighten the interview", author: scarlet, createdAt: at(17),
    timelineEdits: [
      { label: "Punch in", range: { start: 10, end: 12 }, check: "Look at the headroom" },
      { label: "Caption the name", range: { start: 20, end: 22 }, check: "Check the spelling" },
      { label: "Mute the cough", range: { start: 30, end: 31 } },
      { label: "Hold the chart", range: { start: 40, end: 42 } },
    ],
    kept: [{ spot: 0, threadId: "req", at: at(17, 30) }] });
  const revision = Change.parse({ ...batch, id: "revision", taskId: "rev", fromVersion: "v1", toVersion: "v2", createdAt: at(18), kept: [{ spot: 0, threadId: "req", at: at(18, 30) }],
    timelineEdits: [{ label: "Caption the name, spelled right", range: { start: 20, end: 22 }, replaces: { changeId: "batch", spot: 1 } }] });
  const rejection = Change.parse({ ...batch, id: "rejection", taskId: undefined, kept: undefined, fromVersion: "v2", toVersion: "v3", createdAt: at(19), rejects: true,
    timelineEdits: [{ label: "Mute the cough", range: { start: 30, end: 31 }, replaces: { changeId: "batch", spot: 2 } }] });
  const tasks = [task("req"), task("rev", { createdAt: at(17, 40), instruction: "Spell it Berman", context: { changeId: "batch", editIndex: 1 } })];

  it("counts a flagged edit kept, a flagged edit revised and an unflagged edit rejected, each once", () => {
    const { decisions, revisions } = reviewOutcomes(project([batch, revision, rejection], tasks));
    expect(decisions.map(d => [d.kind, d.flagged, d.outcome])).toEqual([
      ["edit", true, "kept"], ["edit", true, "revised"], ["edit", false, "rejected"], ["edit", false, "waiting"],
    ]);
    expect(revisions.map(r => [r.task, r.of, r.outcome])).toEqual([["rev", "edit", "kept"]]);
    expect(summarize(decisions, revisions)).toEqual({
      forYou: { sent: 2, waiting: 0, decided: 2, changed: 1, kept: 1 },
      missed: { changed: 2, sentFirst: 1 },
      revisions: { asked: 1, kept: 1, again: 0, rejected: 0, waiting: 0, gone: 0 },
    });
  });

  it("calls a second revision of the same edit a revision sent back again", () => {
    const again = task("again", { createdAt: at(18, 40), instruction: "Smaller", context: { changeId: "revision", editIndex: 0 } });
    const second = Change.parse({ ...revision, id: "second", taskId: "again", fromVersion: "v2", toVersion: "v2b", createdAt: at(18, 50), kept: undefined,
      timelineEdits: [{ label: "Caption the name, smaller", range: { start: 20, end: 22 }, replaces: { changeId: "revision", spot: 0 } }] });
    const { revisions } = reviewOutcomes(project([batch, revision, second], [...tasks, again]));
    expect(revisions.map(r => [r.task, r.outcome])).toEqual([["rev", "revised again"], ["again", "waiting"]]);
  });
});

describe("what the editor did with a pass's calls", () => {
  const pass = Change.parse({ id: "pass", projectId: "prj", threadId: "req", taskId: "req", intent: "suggestion", fromVersion: "v0", toVersion: "v1",
    state: "ready", description: "Review 3 cuts", author: scarlet, createdAt: at(17),
    cutReasons: [{ start: 10, end: 11, reason: "Restart" }, { start: 20, end: 21, reason: "Pause" }, { start: 30, end: 31, reason: "Filler" }],
    cutAssessments: [
      { index: 0, start: 10, end: 11, verdict: "ask", reason: "Which take?", askOrder: 1 },
      { index: 1, start: 20, end: 21, verdict: "ask", reason: "Does the pause land?", askOrder: 2, revised: true },
      { index: 2, start: 30, end: 31, verdict: "cut", reason: "A clear filler" },
    ],
    cutChoices: [{ index: 0, start: 10, end: 11, choice: "cut" }, { index: 1, start: 20, end: 21, choice: "keep" }] });
  const sentBack = task("back", { createdAt: at(17, 40), instruction: "Leave a breath", context: { changeId: "pass", cutIndex: 1 } });

  it("counts every call as sent to the editor, and a call sent back as revised, with the revision's own outcome", () => {
    const { decisions, revisions } = reviewOutcomes(project([pass], [task("req", { context: { dialogueOperation: "first-cut" } }), sentBack]));
    expect(decisions.map(d => [d.kind, d.flagged, d.outcome])).toEqual([["call", true, "kept"], ["call", true, "revised"]]);
    expect(revisions.map(r => [r.task, r.of, r.outcome])).toEqual([["back", "call", "rejected"]]);
  });
});

describe("speed and tokens", () => {
  it("measures a first cut across its resumed attempt and the checks it started", () => {
    const root = task("req", { kind: "edit", createdAt: at(17), workedMs: 600_000, finishedAt: at(17, 59), state: "failed", context: { dialogueOperation: "first-cut" } });
    const resumed = task("req2", { createdAt: at(17, 30), resumeRootId: "req", workedMs: 300_000, finishedAt: at(18), state: "done", effort: "high",
      context: { dialogueOperation: "first-cut" } });
    const check = task("chk", { kind: "area_check", createdAt: at(17, 20), context: { checksTaskId: "req" } });
    const reject = task("rej", { createdAt: at(18, 10), instruction: "The editor rejected edit 2.", context: { message: "Reject edit", changeId: "set", editIndex: 0 } });
    const setUp = Change.parse({ id: "set", projectId: "prj", threadId: "req", taskId: "req", fromVersion: "v0", toVersion: "v1", state: "approved",
      description: "Set up the recording", author: scarlet, createdAt: at(17, 10) });
    const part = Change.parse({ ...setUp, id: "part", toVersion: "v2", createdAt: at(17, 45), cutReasons: [{ start: 1, end: 2, reason: "Pause" }],
      firstDecisionPreview: { index: 0, renderId: "r", queuedAt: at(17, 46), briefToPlayableMs: 300_000 } });
    const data = project([setUp, part], [root, resumed, check, reject], {
      tokens: new Map([["req", 1_000_000], ["req2", 500_000], ["chk", 100_000]]), durations: new Map([["v1", 1800]]),
    });
    const [cut, rejection] = requestStats(data);
    expect(cut).toMatchObject({ task: "req", kind: "first cut", state: "done", effort: "high", firstResultMs: 45_000, firstCallMs: 300_000,
      doneMs: 24 * 3600_000, activeMs: 900_000, tokens: 1_500_000, checkTokens: 100_000, sourceMinutes: 30 });
    expect(rejection).toMatchObject({ task: "rej", kind: "rejection" });
    const text = report([data], [], [], [cut!, rejection!]);
    expect(text).toContain("Scarlet in use · 1 project · 2 requests");
    expect(text).toMatch(/First cut\s+1\s+0:45\s+24:00:00\s+15:00\s+1\.6M\s+53K/);
  });
});

describe("the saved history", () => {
  const decision = (project: string, id: string) => ({ id, project, thread: "t", kind: "edit" as const, flagged: true, outcome: "kept" as const, at: at(17) });
  it("keeps what it saved about a deleted project, and reads a project still in the library afresh", () => {
    const saved = { projects: [{ id: "old", name: "Deleted" }, { id: "live", name: "Interview" }],
      decisions: [decision("old", "old/a"), decision("live", "live/undone")], revisions: [], requests: [] };
    const now = { projects: [{ id: "live", name: "Interview" }], decisions: [decision("live", "live/b")], revisions: [], requests: [] };
    expect(merge(saved, now)).toEqual({ projects: [{ id: "old", name: "Deleted" }, { id: "live", name: "Interview" }],
      decisions: [decision("old", "old/a"), decision("live", "live/b")], revisions: [], requests: [] });
    expect(merge(undefined, now)).toEqual(now);
  });
});
