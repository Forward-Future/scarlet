import { describe, expect, it } from "vitest";
import { taskRunKind, type Task, type TaskEvent, type ThreadEdit } from "@scarlet/shared";
import type { Change, Note } from "@scarlet/timeline";
import { appliedPassCuts, buildThreads, firstCutDeliveries, queueLabel, requestTarget, revisionTarget, threadConversation, type ThreadEntry } from "./threads";
import { groupEditMessages } from "./groupEditMessages";

const t0 = Date.parse("2026-10-30T12:00:00Z");
const at = (min: number) => new Date(t0 + min * 60_000).toISOString();

function change(id: string, state: Change["state"], extra: Partial<Change> = {}): Change {
  return {
    id,
    projectId: "p",
    fromVersion: "v1",
    toVersion: `v_${id}`,
    description: id,
    author: { type: "agent", id: "claude", name: "Claude Code" },
    noteIds: [],
    ranges: [{ start: 1, end: 2 }],
    state,
    renders: [],
    createdAt: at(1),
    updatedAt: at(1),
    ...extra,
  };
}
function task(id: string, state: Task["state"], extra: Partial<Task> = {}): Task {
  return {
    id,
    projectId: "p",
    kind: "edit",
    agent: "claude",
    instruction: id,
    context: {},
    state,
    createdBy: { type: "human", id: "u", name: "Matt" },
    hostId: null,
    changeIds: [],
    question: null,
    summary: null,
    createdAt: at(0),
    ...extra,
  };
}
function note(id: string, extra: Partial<Note> = {}): Note {
  return { id, projectId: "p", version: "v1", time: 1, clipIds: [], text: id, author: { type: "human", id: "u", name: "Matt" }, state: "open", ...extra };
}

describe("buildThreads", () => {
  it.each(["/dialogue-pass", "/first-cut-dialogue"])("keeps a saved %s result tied to its pass across a resume and an unrelated follow-up", command => {
    const context = { threadId: "thread", message: command, version: "input" };
    const tasks = [task("pass", "failed", { context, changeIds: ["setup"] }),
      task("resume", "done", { context, resumeRootId: "pass", changeIds: ["applied", "draft"], createdAt: at(2) }),
      task("captions", "done", { context: { threadId: "thread", message: "Add captions" }, changeIds: ["later"], createdAt: at(5) })];
    const changes = [change("setup", "approved"), change("draft", "ready", { createdAt: at(3) }),
      change("applied", "approved", { createdAt: at(3) }), change("later", "approved", { createdAt: at(6) })];
    const [thread] = buildThreads({ tasks, changes, notes: [] });
    const deliveries = firstCutDeliveries(thread!);
    expect(deliveries.get("pass")).toBe(deliveries.get("resume"));
    expect(deliveries.get("resume")).toMatchObject({ state: "ready", version: "v_draft", change: { state: "ready" } });
    expect(deliveries.has("captions")).toBe(false);
  });

  it("uses the saved input when a pass keeps all footage and leaves local pause reviews alone", () => {
    const input = task("pass", "done", { context: { message: "/dialogue-pass", version: "original" } });
    const [thread] = buildThreads({ tasks: [input], changes: [], notes: [] });
    expect(firstCutDeliveries(thread!).get(input.id)).toMatchObject({ version: "original", state: "ready" });
    input.context.message = "/tighten-pauses-here";
    input.context.skillIds = ["same-dialogue-skill"];
    expect(firstCutDeliveries(thread!).size).toBe(0);
    input.context.message = "/dialogue-pass";
    input.context.dialogueOperation = "none";
    expect(firstCutDeliveries(thread!).size).toBe(0);
    input.context.dialogueOperation = "first-cut";
    expect(firstCutDeliveries(thread!).get(input.id)?.state).toBe("ready");
  });

  it("groups a request, its attempts and the feedback between them into one thread", () => {
    const tasks = [
      task("ask", "done", { instruction: "Tighten the pause", changeIds: ["c1"], summary: "Cut 0.8 s" }),
      task("redo", "done", { kind: "revise", instruction: "Keep half a second", context: { changeId: "c1", noteIds: ["fb"] }, changeIds: ["c2"], createdAt: at(3) }),
    ];
    const changes = [change("c1", "rejected", { taskId: "ask" }), change("c2", "ready", { taskId: "redo", noteIds: ["fb"], createdAt: at(4) })];
    const notes = [note("fb", { changeId: "c1", text: "Keep half a second", createdAt: at(2) })];
    const threads = buildThreads({ tasks, changes, notes });
    expect(threads).toHaveLength(1);
    const th = threads[0]!;
    expect(th.title).toBe("Tighten the pause");
    expect(th.changes.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(th.status).toBe("needs_you");
    expect(th.needs).toBe("decision");
    const kinds = threadConversation(th, notes).entries.map((e) => e.kind);
    expect(kinds).toContain("request");
    expect(kinds).not.toContain("agent"); // Each saved edit already has a result row.
    expect(kinds.filter((k) => k === "change")).toHaveLength(2);
  });

  it("hides the automatic first-cut request but keeps the editor’s own instructions", () => {
    const instruction = "Make a first cut from this project’s footage and send it to me for review.";
    const first = task("first", "running", { instruction, context: { message: "Make first cut" } });
    const thread = () => buildThreads({ tasks: [first], changes: [], notes: [] })[0]!;
    expect(thread().title).toBe("First edit");
    expect(threadConversation(thread(), []).entries).toEqual([]);
    first.instruction += "\n\nKeep the sponsor read.";
    expect(threadConversation(thread(), []).entries).toMatchObject([{ kind: "request", text: "Keep the sponsor read." }]);
  });

  it("shows a reply to a note once, as Scarlet's, and never as a second message from the editor", () => {
    const tasks = [
      task("ask", "done", { instruction: "Tighten the pause", changeIds: ["c1"], summary: "Cut 0.8 s" }),
      task("redo", "done", { kind: "revise", instruction: "Cut a bit more", context: { changeId: "c1", noteIds: ["fb"] }, changeIds: ["c2"], createdAt: at(3) }),
    ];
    const changes = [change("c1", "rejected", { taskId: "ask" }), change("c2", "ready", { taskId: "redo", noteIds: ["fb"], createdAt: at(4) })];
    const said = (notes: Note[]) => {
      const { entries } = threadConversation(buildThreads({ tasks, changes, notes })[0]!, notes);
      return entries.filter(e => e.kind === "request" || e.kind === "agent").map(e => [e.kind, e.taskId, (e as { text: string }).text, e.kind === "agent" ? e.author.name : ""]);
    };
    // The agent replied to the note the revision was sent as. The reply is kept beside the note, under the agent's name.
    const replied = note("fb", { changeId: "c1", text: "Cut a bit more", createdAt: at(2),
      replies: [{ text: "Extended this cut by 0.6 s.", author: { type: "agent", id: "claude", name: "claude" }, createdAt: at(3.5) }] });
    expect(said([replied])).toEqual([["request", "ask", "Tighten the pause", ""], ["request", "redo", "Cut a bit more", ""], ["agent", "redo", "Extended this cut by 0.6 s.", "claude"]]);
    // A note saved by an earlier build has the reply inside its text, signed with the editor's name. It reads the same.
    const older = note("fb", { changeId: "c1", createdAt: at(2), updatedAt: at(3.5), text: "Cut a bit more\n\n— Matt: Extended this cut by 0.6 s." });
    expect(said([older])).toEqual([["request", "ask", "Tighten the pause", ""], ["request", "redo", "Cut a bit more", ""], ["agent", "redo", "Extended this cut by 0.6 s.", "claude"]]);
  });

  it("joins legacy attempts linked only by feedback and ignores unrelated notes", () => {
    const changes = [
      change("first", "rejected"),
      change("other", "approved"),
      change("redo", "ready", { noteIds: ["ordinary", "feedback", "missing"], createdAt: at(3) }),
    ];
    const notes = [note("ordinary"), note("feedback", { changeId: "first" }), note("unrelated", { changeId: "other" })];
    const threads = buildThreads({ changes, tasks: [], notes });
    expect(threads.map(t => t.changes.map(c => c.id))).toEqual([["first", "redo"], ["other"]]);
  });

  it("joins explicit thread ids and shows what the person said, not the expanded instruction", () => {
    const tasks = [
      task("t1", "done", { context: { threadId: "t1" }, instruction: "First cut" }),
      task("t2", "running", { context: { threadId: "t1", message: "Tighten the end" }, instruction: "This continues…\nNow: Tighten the end", createdAt: at(5) }),
    ];
    const [th] = buildThreads({ tasks, changes: [], notes: [] });
    expect(th!.id).toBe("t1");
    expect(th!.status).toBe("working");
    expect(threadConversation(th!, []).entries.filter((e) => e.kind === "request").map((e) => (e as { text: string }).text)).toEqual(["First cut", "Tighten the end"]);
  });

  it("says a question and a ready change need the editor while a running request works", () => {
    const threads = buildThreads({
      tasks: [task("q", "waiting_for_user", { question: "Purple or white?", createdAt: at(10) }), task("w", "running")],
      changes: [change("r", "ready", { createdAt: at(-5), updatedAt: at(-5) })],
      notes: [],
    });
    const status = Object.fromEntries(threads.map(t => [t.id, [t.status, t.needs]]));
    expect(status.q).toEqual(["needs_you", "question"]);
    expect(status.r?.[0]).toBe("needs_you");
    expect(status.w?.[0]).toBe("working");
    expect(threads.find(t => t.id === "r")?.latest?.id).toBe("r");
  });

  it("treats a sent-back change as working until the redo arrives, and says why in Scarlet's words under the request that made it", () => {
    const redo = (state: Task["state"], extra: Partial<Task> = {}) => task("redo", state, { kind: "revise", createdBy: { type: "scarlet", name: "Scarlet" },
      context: { changeId: "c", threadId: "c", message: "Redo on the current edit" }, ...extra });
    const asked = task("asked", "done", { changeIds: ["c"], context: { threadId: "c", message: "Zoom in on the demo" } });
    const sentBack = change("c", "revising", { threadId: "c", taskId: "asked", error: "Sent back: overlaps" });
    const said = (tasks: Task[], changes = [sentBack]) => threadConversation(buildThreads({ tasks, changes, notes: [] })[0]!, []).entries
      .flatMap(e => e.kind === "agent" || e.kind === "system" ? [[e.kind, e.taskId, e.text]] : []);
    const [th] = buildThreads({ tasks: [asked, redo("running")], changes: [sentBack], notes: [] });
    expect(th!.status).toBe("working");
    // One line, Scarlet's, in the request that made the suggestion: not the engine's reason, its name for the task, or
    // "the agent". It says what is true of the redo: waiting its turn, then under way.
    const waits = "The video changed while this suggestion was waiting. I’ll redo it on the video as it is now.";
    const redoing = "The video changed while this suggestion was waiting. I’m redoing it on the video as it is now.";
    expect(said([asked, redo("queued")])).toEqual([["agent", "asked", waits]]);
    expect(said([asked, redo("running")])).toEqual([["agent", "asked", redoing]]);
    // In line again after Scarlet began it, after a question, it is still under way.
    expect(said([asked, redo("queued", { startedAt: at(3) })])).toEqual([["agent", "asked", redoing]]);
    // A suggestion no request made says it too, as a line that belongs to no request.
    expect(said([redo("queued")], [{ ...sentBack, taskId: undefined }])).toEqual([["agent", undefined, waits]]);
    // Once the redo has ended the line is no longer true, and what the redo made or how it stopped says the rest.
    expect(said([asked, redo("done")]).filter(([, , text]) => /redo|Redo on|Sent back/.test(text!))).toEqual([]);
    expect(said([asked, redo("cancelled")]).filter(([, , text]) => /redo|Redo on|Sent back/.test(text!))).toEqual([]);
  });
});

it("puts failed requests without a proposal in Needs you and removes Retry after it starts", () => {
  const failed = task("failed", "failed", { context: { threadId: "failed" } });
  const [thread] = buildThreads({ tasks: [failed], changes: [], notes: [] });
  expect(thread).toMatchObject({ status: "needs_you", needs: "task_failed" });
  expect(threadConversation(thread!, []).entries).toContainEqual(expect.objectContaining({ action: { taskId: failed.id, label: "Retry edit" } }));
  const retry = task("retry", "queued", { createdAt: at(2), context: { threadId: failed.id } });
  const [running] = buildThreads({ tasks: [{ ...failed, retryTaskId: retry.id }, retry], changes: [], notes: [] });
  expect(running!.status).toBe("working");
  expect(threadConversation(running!, []).entries.some(e => e.kind === "system" && e.action)).toBe(false);
});

it("explains Claude's sandbox startup failure without replaying CLI instructions", () => {
  const failed = task("failed", "failed", { error: "Sandbox required but unavailable: the Windows sandbox is not active on this session (feature gate off). Set sandbox.failIfUnavailable=false to allow unsandboxed execution." });
  const [thread] = buildThreads({ tasks: [failed], changes: [], notes: [] });
  expect(threadConversation(thread!, []).entries).toContainEqual(expect.objectContaining({
    kind: "system", text: "Claude Code couldn’t start because its required shell sandbox was unavailable.",
    action: { taskId: failed.id, label: "Retry edit" },
  }));
});

it("says why the host stopped a run and offers Resume, keeping what it saved", () => {
  const notice = (t: Task) => {
    const saved = change(`${t.id}_cut`, "approved", { taskId: t.id });
    const [thread] = buildThreads({ tasks: [{ ...t, changeIds: [saved.id] }], changes: [saved], notes: [] });
    return threadConversation(thread!, []).entries.find(e => e.kind === "system");
  };
  const stalled = task("stalled", "failed", { interrupted: true, error: "stalled: the agent wrote nothing for 10 minutes" });
  expect(notice(stalled)).toMatchObject({ tone: "warn", action: { taskId: stalled.id, label: "Resume agent" },
    text: "Scarlet went quiet for 10 minutes, so the edit was stopped. What it saved is kept." });
  const capped = task("capped", "failed", { interrupted: true, error: "timed out after 90 minutes, the limit for one agent run" });
  expect(notice(capped)).toMatchObject({ text: "The edit reached its 90-minute limit. What it saved is kept.", action: { label: "Resume agent" } });
  // Hosts used to stop every run at 45 minutes and record only "timed out". Those runs resume too.
  const legacy = task("legacy", "failed", { error: "timed out" });
  expect(notice(legacy)).toMatchObject({ tone: "warn", text: "The edit ran out of time. What it saved is kept.", action: { taskId: legacy.id, label: "Resume agent" } });
});

it("keeps a pending proposal reviewable alongside Resume, then shows a single continued conversation", () => {
  const original = task("original", "failed", { interrupted: true, changeIds: ["draft"] });
  const draft = change("draft", "ready", { taskId: original.id });
  const [before] = buildThreads({ tasks: [original], changes: [draft], notes: [] });
  expect(before!.needs).toBe("decision");
  expect(threadConversation(before!, []).entries).toContainEqual(expect.objectContaining({ action: { taskId: original.id, label: "Resume agent" } }));
  const resumed = task("resumed", "running", { resumeRootId: original.id, createdAt: at(3), context: { threadId: original.id, message: original.instruction } });
  const threads = buildThreads({ tasks: [{ ...original, retryTaskId: resumed.id }, resumed], changes: [draft], notes: [] });
  expect(threads).toHaveLength(1);
  expect(threads[0]!.active?.id).toBe(resumed.id);
  const { entries } = threadConversation(threads[0]!, []);
  expect(entries.filter(e => e.kind === "request")).toHaveLength(1);
  expect(entries.some(e => e.kind === "system" && e.action)).toBe(false);
});

it("keeps the interruption notice without offering Resume after a manual follow-up finishes", () => {
  const context = { threadId: "dialogue" };
  const original = task("scan", "failed", { context, interrupted: true, changeIds: ["cut"] });
  const followUp = task("continue", "done", { context, createdAt: at(2), summary: "Reviewed the dialogue cuts." });
  const cut = change("cut", "approved", { taskId: original.id });
  const [thread] = buildThreads({ tasks: [original, followUp], changes: [cut], notes: [] });
  const { entries } = threadConversation(thread!, []);
  expect(entries).toContainEqual(expect.objectContaining({ kind: "system", text: "Scarlet was interrupted after saving changes." }));
  expect(entries.some(e => e.kind === "system" && e.action)).toBe(false);
});

it("says an alternative the editor didn't choose wasn't applied, with the engine's reason, and never that they skipped or rejected it", () => {
  // Scarlet offered two alternatives and the editor applied the first. The engine puts the other away as the editor's
  // decision, with its reason (approveChange in apps/server/src/services/changes.ts).
  const asked = task("ask", "done", { changeIds: ["a", "b"] });
  const editor = { type: "human" as const, id: "u", name: "Matt" };
  const lines = (rejectReason?: string) => {
    const [thread] = buildThreads({ tasks: [asked], notes: [], changes: [
      change("a", "approved", { taskId: asked.id, intent: "alternative", decidedBy: editor }),
      change("b", "rejected", { taskId: asked.id, intent: "alternative", decidedBy: editor, rejectReason })] });
    return threadConversation(thread!, []).entries.filter(e => e.kind === "system").map(e => e.text);
  };
  expect(lines("Another alternative was chosen")).toEqual(["Not applied: Another alternative was chosen"]);
  // A suggestion put away with no reason, as an earlier build could, reads the same way.
  expect(lines()).toEqual(["Not applied."]);
});

it("keeps a standalone edit's name and identity when its first task is a revision", () => {
  const original = change("cleanup", "revising", { description: "Remove the room noise" });
  const reply = task("followup", "running", { kind: "revise", instruction: "Leave a little room tone",
    createdAt: at(3), context: { changeId: original.id } });
  const second = change("v2", "ready", { createdAt: at(4), taskId: reply.id });
  for (const changes of [[original], [second, original]]) {
    const [edit] = buildThreads({ changes, tasks: [reply], notes: [] });
    expect(edit).toMatchObject({ id: original.id, title: original.description });
  }
});

it("keeps late results with the request that produced them when a follow-up was queued", () => {
  const dialogue = task("Dialogue", "done", { context: { threadId: "dialogue-thread" }, changeIds: ["sync", "cuts"] });
  const framing = task("Crop the camera", "done", { createdAt: at(2), context: dialogue.context, changeIds: ["crop"] });
  const changes = [
    change("sync", "approved", { taskId: dialogue.id, description: "Synced the recordings." }),
    change("cuts", "approved", { taskId: dialogue.id, updatedAt: at(3), description: "Removed seven cuts." }),
    change("crop", "approved", { taskId: framing.id, updatedAt: at(4), description: "Tightened the framing." }),
  ];
  const [thread] = buildThreads({ tasks: [dialogue, framing], changes, notes: [] });
  const { entries } = threadConversation(thread!, [], {}, undefined, []);
  expect(entries.map(e => "text" in e && e.text)).toEqual([
    "Dialogue", "Synced the recordings.", "Removed seven cuts.", "Crop the camera", "Tightened the framing.",
  ]);
});

it("shows the saved first-cut reply and leaves a clean playback recheck out of the chat", () => {
  const reply = "First cut saved. Review the flagged demo holds.";
  const allClear = "The playback audio check found no repeats. No edits were needed.";
  const saved = change("assembly", "approved", { taskId: "pass" });
  const said = (summary: string, over: Partial<Task> = {}) => {
    const pass = task("pass", "done", { instruction: "/dialogue-pass", changeIds: [saved.id], reply, summary,
      repeatAudit: { version: saved.toVersion, returns: 1, remaining: 0 }, ...over });
    const [thread] = buildThreads({ tasks: [pass], changes: [saved], notes: [] });
    return threadConversation(thread!, []).entries.flatMap(e => e.kind === "agent" ? [e.text] : []);
  };
  expect(said(allClear)).toEqual([reply]);
  expect(said(allClear, { instruction: "Check the playback for repeats.", reply: undefined,
    repeatAudit: { version: saved.toVersion, returns: 0, remaining: 0 } })).toEqual([allClear]);
  const finding = "I kept the repeated phrase for emphasis.";
  expect(said(finding)).toEqual([reply, finding]);
  const joinNote = allClear + " Review the clipped word at the join.";
  expect(said(joinNote)).toEqual([reply, joinNote]);
});

it("leaves out a dialogue part's review that the next part of the same pass took over", () => {
  const id = (n: string, kind: string) => `chg_${n.repeat(64)}_${kind}`;
  const pass = task("Dialogue", "done", { changeIds: [id("a", "applied"), id("a", "review"), id("b", "applied"), id("b", "review")] });
  const changes = [
    change(id("a", "applied"), "approved", { taskId: pass.id, description: "Part one", ops: [{ op: "rippleDelete", start: 1, end: 3 }] }),
    change(id("a", "review"), "rejected", { taskId: pass.id, intent: "suggestion", rejectReason: "Carried into a later part of the same dialogue pass.",
      replacedBy: id("b", "review") }),
    change(id("b", "applied"), "approved", { taskId: pass.id, updatedAt: at(2), description: "Part two", ops: [{ op: "rippleDelete", start: 5, end: 6 }] }),
    change(id("b", "review"), "ready", { taskId: pass.id, intent: "suggestion", updatedAt: at(2) }),
  ];
  const [thread] = buildThreads({ tasks: [pass], changes, notes: [] });
  const { entries } = threadConversation(thread!, []);
  expect(entries.flatMap(e => e.kind === "change" ? [e.change.id] : []).sort()).toEqual([id("a", "applied"), id("b", "applied"), id("b", "review")].sort());
  expect(entries.map(e => "text" in e && e.text)).toContain("Dialogue cuts are pending review.");
});

it("shows a revised edit once and keeps its reports, excerpt and original receipt in details", () => {
  const range = { start: 2, end: 4 };
  const original = change("first", "approved", { taskId: "crop", description: "First crop.", timelineEdits: [{ label: "Face framing", range }] });
  const updated = change("second", "approved", { taskId: "crop", description: "Kept the inset width.", createdAt: at(2), updatedAt: at(2),
    timelineEdits: [{ label: "Face framing", range, replaces: { changeId: original.id, spot: 0 } }] });
  const separate = change("third", "approved", { taskId: "crop", description: "Framed a different shot.", timelineEdits: [{ label: "Face framing", range }] });
  const t = task("crop", "done", { changeIds: [original.id, updated.id, separate.id] });
  const [thread] = buildThreads({ tasks: [t], changes: [original, updated, separate], notes: [] });
  const edit = (c: Change, previous: ThreadEdit["previous"] = []): ThreadEdit => ({ changeId: c.id, spot: 0, label: "Face framing", range, previous });
  const event: TaskEvent = { type: "log", at: at(2), text: "Checked the inset.", data: { kind: "editor_progress",
    edits: [{ phrase: "inset", changeId: original.id, spot: 0 }], excerpt: "The original shot." } };
  const { entries } = threadConversation(thread!, [], { crop: [event, event] }, undefined, [
    edit(updated, [{ changeId: original.id, spot: 0 }]), edit(separate),
  ]);
  const saved = entries.filter(e => e.kind === "change");
  expect(saved.map(e => e.change.id).sort()).toEqual(["second", "third"]);
  expect(saved.find(e => e.change.id === updated.id)?.text).toBe("Kept the inset width.");
  expect(saved.find(e => e.change.id === updated.id)?.details?.map(d => d.text).sort()).toEqual(["Checked the inset.", "First crop."]);
  expect(saved.find(e => e.change.id === updated.id)?.details?.find(d => d.text === event.text)?.excerpt).toBe("The original shot.");
  expect(entries.some(e => e.kind === "progress")).toBe(false);
});

it("keeps each request's result in place when a later request replaces its timeline spot", () => {
  const range = { start: 2, end: 4 };
  const first = change("first", "approved", { taskId: "frame", timelineEdits: [{ label: "Face framing", range }] });
  const second = change("second", "approved", { taskId: "widen", createdAt: at(4), updatedAt: at(4),
    timelineEdits: [{ label: "Wider framing", range, replaces: { changeId: first.id, spot: 0 } }] });
  const context = { threadId: "camera" };
  const summary = "Matched the width. Kept the height. Checked the opening. The last shot keeps its own crop.";
  const tasks = [task("frame", "done", { context, changeIds: [first.id] }),
    task("widen", "done", { context, createdAt: at(3), finishedAt: at(5), summary, changeIds: [second.id] })];
  const notes = [note("exposure", { changeId: first.id, createdAt: at(2) }), note("position", { changeId: first.id, createdAt: at(2.5) })];
  const [thread] = buildThreads({ changes: [first, second], tasks, notes });
  const report: TaskEvent = { type: "log", at: at(1), text: "Checked the first frame.", data: {
    kind: "editor_progress", edits: [{ phrase: "first frame", changeId: first.id, spot: 0 }],
  } };
  const { entries } = threadConversation(thread!, notes, { frame: [report] }, undefined, [
    { changeId: second.id, spot: 0, label: "Wider framing", range, previous: [{ changeId: first.id, spot: 0 }] },
  ]);
  expect(entries.map(e => "text" in e ? e.text : e.kind)).toEqual(["frame", "first.", "exposure", "position", "widen", summary]);
  const results = entries.filter(e => e.kind === "change");
  expect(results[0]?.details?.map(d => d.text)).toContain(report.text);
  expect(results[1]?.text).toBe(summary);
});

it("keeps the rest of a batch when one spot is revised and preserves every link in a shared explanation", () => {
  const range = { start: 2, end: 4 };
  const batch = change("batch", "approved", { taskId: "edit", timelineEdits: [{ label: "Intro", range }, { label: "Outro", range }] });
  const intro = change("intro", "approved", { taskId: "edit", timelineEdits: [{ label: "New intro", range, replaces: { changeId: "batch", spot: 0 } }] });
  const t = task("edit", "done", { changeIds: [batch.id, intro.id] });
  const [thread] = buildThreads({ tasks: [t], changes: [batch, intro], notes: [] });
  const refs = [{ phrase: "intro", changeId: batch.id, spot: 0 }, { phrase: "outro", changeId: batch.id, spot: 1 }];
  const { entries } = threadConversation(thread!, [], { edit: [{ type: "log", text: "Checked intro and outro.", data: { kind: "editor_progress", edits: refs } }] },
    undefined, [{ changeId: intro.id, spot: 0, range, label: "New intro", previous: [{ changeId: batch.id, spot: 0 }] }]);
  expect(entries.filter(e => e.kind === "change")).toHaveLength(2);
  const explanations = entries.flatMap(e => e.kind === "change" ? e.details ?? [] : []).filter(n => n.edits);
  expect(explanations).toHaveLength(1);
  expect(explanations[0]?.edits?.map(ref => [ref.change.id, ref.spot])).toEqual([["batch", 0], ["batch", 1]]);
});

it("names what a sent message revised, in the words the box showed", () => {
  const pass = change("pass", "revising", { intent: "suggestion", cutReasons: [{ start: 149.49, end: 151.67, reason: "Keep the finished sentence." }] });
  const edit = change("edit", "approved");
  const sent = (context: Task["context"]) => ({ context } as Task);
  expect(revisionTarget(sent({ changeId: "pass", cutIndex: 3, time: 149.49, end: 151.67 }), [pass])).toBe("the cut at 2:29");
  expect(revisionTarget(sent({ changeId: "pass", time: 0 }), [pass])).toBe("the whole dialogue pass");
  expect(revisionTarget(sent({ changeId: "edit", editIndex: 1, time: 65 }), [edit])).toBe("the edit at 1:05");
  // With the request's list at hand, an applied edit reads as its row does: at the time the row shows, not where the
  // passage around it starts, and as a cut when it took footage out.
  const row = { changeId: "edit", spot: 1, label: "A stumble", range: { start: 65, end: 68 }, previous: [] };
  expect(revisionTarget(sent({ changeId: "edit", editIndex: 1, time: 65 }), [edit], [{ ...row, at: 66.5, beforeCut: { version: "v0", removed: { start: 300, end: 306 } } }])).toBe("the cut at 1:06");
  expect(revisionTarget(sent({ changeId: "edit", editIndex: 1, time: 65 }), [edit], [row])).toBe("the edit at 1:05");
  expect(revisionTarget(sent({ changeId: "edit", editIndex: 1, time: 65 }), [edit], [{ ...row, spot: 0 }])).toBe("the edit at 1:05");
  expect(revisionTarget(sent({ changeId: "edit", time: 0 }), [edit])).toBe("the whole edit");
  expect(revisionTarget(sent({ time: 12 }), [edit])).toBeUndefined();
});

it("names the recordings a live wait for transcripts is waiting on, until they're ready", () => {
  const pass = task("pass", "running", { startedAt: at(1) });
  const [thread] = buildThreads({ tasks: [pass], changes: [], notes: [] });
  const wait = (mediaId: string, done?: boolean): TaskEvent => ({ type: "log", at: at(2), text: done ? "Ready: the transcript" : "Waiting for the transcript",
    data: { kind: "media_wait", wait: "transcript", mediaId, ...(done && { done }) } });
  expect(threadConversation(thread!, [], { pass: [wait("cam"), wait("mic")] }).live).toMatchObject({ text: "Waiting for the transcript", transcripts: ["cam", "mic"] });
  expect(threadConversation(thread!, [], { pass: [wait("cam"), wait("mic"), wait("cam", true)] }).live?.transcripts).toEqual(["mic"]);
  expect(threadConversation(thread!, [], { pass: [wait("cam"), wait("mic"), wait("cam", true), wait("mic", true)] }).live?.transcripts).toBeUndefined();
});

it("gives the live line to a run picked up again while an older request in its thread still waits", () => {
  const context = { threadId: "zoom" };
  // The run was interrupted. A follow-up in its thread was sent before it was picked up again, and waits its turn.
  // The attempt that carries the run on is a later task than that request, and starts ahead of it.
  const original = task("zoom", "failed", { context, interrupted: true, retryTaskId: "resumed" });
  const followUp = task("follow", "queued", { context, createdAt: at(1) });
  const resumed = task("resumed", "running", { context, resumeRootId: "zoom", createdAt: at(2), startedAt: at(2) });
  const [thread] = buildThreads({ tasks: [original, followUp, resumed], changes: [], notes: [] });
  // The thread's first request in line is still the one that waits.
  expect(thread!.active?.id).toBe("follow");
  const reading: TaskEvent = { type: "tool", at: at(3), text: "timeline_get", data: { tool: "timeline_get", input: {} } };
  expect(threadConversation(thread!, [], { resumed: [reading] }).live).toMatchObject({ text: "Reading timeline", entry: { taskId: "resumed" } });
});

describe("requestTarget", () => {
  const cuts = (...ranges: [number, number, string][]) => ranges.map(([start, end, reason]) => ({ start, end, reason }));
  const applied = (changeId: string, spot: number, start: number, end: number) =>
    ({ changeId, spot, label: "Cut", range: { start, end: start }, previous: [], beforeCut: { version: "v1", removed: { start, end } } });
  // A pass asked about three cuts. The editor sent the second back twice; the last version was applied without the third.
  const pass = change("pass", "rejected", { replacedBy: "rev1", cutReasons: cuts([10, 12, "Repeat"], [40, 46, "Stumble"], [70, 71, "Um"]) });
  const rev1 = change("rev1", "rejected", { replacedBy: "rev2", cutReasons: cuts([10, 12, "Repeat"], [39.9, 46, "Starts two frames earlier"], [70, 71, "Um"]) });
  const rev2 = change("rev2", "approved", { cutReasons: cuts([10, 12, "Repeat"], [39.9, 45, "Ends a second earlier"], [70, 71, "Um"]) });
  const edits = [applied("rev2", 0, 10, 12), applied("rev2", 1, 39.9, 45)];
  const revise = (id: string, context: Partial<Task["context"]>) => task(id, "done", { kind: "revise", context: { changeId: "pass", ...context } as Task["context"] });

  it("finds a revised cut where it stands now, with what that revision said about it", () => {
    const first = requestTarget(revise("t1", { cutIndex: 1 }), rev1, [pass, rev1, rev2], edits);
    expect(first).toEqual({ note: "Starts two frames earlier", edit: edits[1] });
    const second = requestTarget(revise("t2", { changeId: "rev1", cutIndex: 1 }), rev2, [pass, rev1, rev2], edits);
    expect(second).toEqual({ note: "Ends a second earlier", edit: edits[1] });
  });

  it("names the call while the pass still waits, and a cut left out has nothing to open", () => {
    expect(requestTarget(revise("t1", { cutIndex: 1 }), rev1, [pass, { ...rev1, replacedBy: undefined }], []))
      .toEqual({ note: "Starts two frames earlier", changeId: "rev1", call: 1 });
    expect(requestTarget(revise("t3", { cutIndex: 2 }), rev1, [pass, rev1, rev2], edits)).toEqual({ note: "Um", changeId: "rev2", call: 2 });
  });

  it("follows a cut through a revision of another cut sent from that cut's card, which leaves the pass it revised marked as revising", () => {
    // The third cut was sent back from its card. The pass it revised stays marked as revising, and nothing on it names the pass that revision made.
    const waited = change("pass", "revising", { cutReasons: cuts([10, 12, "Repeat"], [40, 46, "Stumble"], [70, 71, "Um"]) });
    const made = change("made", "ready", { taskId: "t2", cutReasons: cuts([10, 12, "Repeat"], [40, 46, "Stumble"], [70.5, 71, "Starts after the breath"]) });
    const card = revise("t2", { cutIndex: 2 });
    // A request about the first cut, stopped before that revision, is about the same cut in the pass that waits now.
    const stopped = task("t1", "cancelled", { kind: "revise", context: { changeId: "pass", cutIndex: 0 } as Task["context"] });
    expect(requestTarget(stopped, undefined, [waited, made], [], [stopped, card])).toEqual({ note: undefined, changeId: "made", call: 0 });
    // Without the thread's requests there is nothing to follow it by.
    expect(requestTarget(stopped, undefined, [waited, made], [])).toEqual({ note: undefined, changeId: "pass", call: 0 });
    // The pass a revision made isn't taken for one made from itself.
    expect(requestTarget(card, made, [waited, made], [], [stopped, card])).toEqual({ note: "Starts after the breath", changeId: "made", call: 2 });
  });

  it("follows a cut named in one part of a running pass into the pass that carried it on", () => {
    const part = change("part", "rejected", { replacedBy: "whole", cutReasons: cuts([40, 46, "Stumble"]) });
    const whole = change("whole", "approved", { cutReasons: cuts([10, 12, "Repeat"], [40, 46, "Stumble"]) });
    const made = [applied("whole", 0, 10, 12), applied("whole", 1, 40, 46)];
    expect(requestTarget(revise("t1", { changeId: "part", cutIndex: 0 }), undefined, [part, whole], made)).toEqual({ note: undefined, edit: made[1] });
  });

  it("counts a pass's cuts as its review does, where staged cuts that touch are one cut", () => {
    // Two staged cuts meet at 12 s, so the review lists them as one cut, and the stumble after them is its second.
    const pair = cuts([10, 12, "An um"], [12, 14, "A false start"]);
    const staged = change("staged", "rejected", { replacedBy: "moved", cutReasons: [...pair, ...cuts([40, 46, "Stumble"], [70, 71, "Um"])] });
    const moved = change("moved", "ready", { cutReasons: [...pair, ...cuts([39.9, 46, "Starts two frames earlier"], [70, 71, "Um"])] });
    const asked = revise("t1", { changeId: "staged", cutIndex: 1 });
    // While the pass waits, the request is about the cut it revised: that cut's note, and its number in the review.
    expect(requestTarget(asked, moved, [staged, moved], [])).toEqual({ note: "Starts two frames earlier", changeId: "moved", call: 1 });
    // Applied, it is the edit that took that cut out, not the one that took out the pair before it.
    const made = [applied("moved", 0, 10, 14), applied("moved", 1, 39.9, 46), applied("moved", 2, 70, 71)];
    expect(requestTarget(asked, moved, [staged, { ...moved, state: "approved" }], made)).toEqual({ note: "Starts two frames earlier", edit: made[1] });
    // A cut named in one part of the pass has the review's number in the pass that carried it on.
    const part = change("part", "rejected", { replacedBy: "moved", cutReasons: cuts([39.9, 46, "Stumble"]) });
    expect(requestTarget(revise("t2", { changeId: "part", cutIndex: 0 }), undefined, [part, moved], [])).toEqual({ note: undefined, changeId: "moved", call: 1 });
    // A request about the pair reads both of its notes, as its call does.
    expect(requestTarget(revise("t3", { changeId: "staged", cutIndex: 0 }), moved, [staged, moved], [])).toEqual({ note: "An um A false start", changeId: "moved", call: 0 });
    // The pass's next part can stage a cut that touches one named in the part before it. The review then lists the two
    // as one cut, and the request is about that cut, under its number there: a cough staged ahead moves it one on.
    const early = change("early", "rejected", { replacedBy: "later", cutReasons: cuts([8, 9, "Um"], [12, 13, "Repeat"]) });
    const later = change("later", "ready", { cutReasons: cuts([2, 3, "Cough"], [8, 9, "Um"], [12, 13, "Repeat"], [13, 14, "Restart"]) });
    const named = revise("t4", { changeId: "early", cutIndex: 1 });
    expect(requestTarget(named, undefined, [early, later], [])).toEqual({ note: undefined, changeId: "later", call: 2 });
    const took = [applied("later", 0, 2, 3), applied("later", 1, 8, 9), applied("later", 2, 12, 14)];
    expect(requestTarget(named, undefined, [early, { ...later, state: "approved" }], took)).toEqual({ note: undefined, edit: took[2] });
    // A part after that can stage one more against the two, and the request still follows its cut.
    const last = change("last", "ready", { cutReasons: cuts([0, 1, "Slate"], [2, 3, "Cough"], [8, 9, "Um"], [12, 13, "Repeat"], [13, 14, "Restart"], [14, 15, "Breath"]) });
    expect(requestTarget(named, undefined, [early, { ...later, state: "rejected", replacedBy: "last" }, last], [])).toEqual({ note: undefined, changeId: "last", call: 3 });
    // So it does when that part stages the two again as one cut.
    const again = change("again", "ready", { cutReasons: cuts([0, 1, "Slate"], [2, 3, "Cough"], [8, 9, "Um"], [12, 14, "Repeat and restart"], [14, 15, "Breath"]) });
    expect(requestTarget(named, undefined, [early, { ...later, state: "rejected", replacedBy: "again" }, again], [])).toEqual({ note: undefined, changeId: "again", call: 3 });
  });

  it("finds a revised edit by its place in the thread, through later revisions", () => {
    const zoom = { changeId: "c2", spot: 0, label: "Tighter camera", range: { start: 5, end: 9 }, previous: [{ changeId: "c1", spot: 3 }] };
    expect(requestTarget(revise("t1", { changeId: "c1", editIndex: 3 }), undefined, [], [zoom])).toEqual({ edit: zoom });
    expect(requestTarget(revise("t2", { changeId: "c1", editIndex: 1 }), undefined, [], [zoom])).toBeUndefined();
    expect(requestTarget(task("t3", "done"), undefined, [], [zoom])).toBeUndefined();
  });
});

it("stops saying it is scanning once the scan has reached the end of the dialogue, give or take a frame", () => {
  const second = (s: number) => new Date(t0 + s * 1000).toISOString();
  const running = task("pass", "running", { instruction: "/dialogue-pass", startedAt: second(1) });
  const page = (s: number, from: number, to: number | undefined, end = 120): TaskEvent => ({ id: `e${s}`, at: second(s), type: "log", text: "Dialogue scan · a.mp4",
    data: { kind: "editor_progress", scanPage: { mediaId: "med_1", from, end, ...(to !== undefined && { to }) } } });
  const [thread] = buildThreads({ tasks: [running], changes: [], notes: [] });
  const live = (events: TaskEvent[]) => threadConversation(thread!, [], { pass: events }).live;
  expect(live([page(2, 0, undefined), page(3, 0, 60)])).toMatchObject({ text: "Scanning dialogue", entry: { scan: { seconds: 60, total: 120 } } });
  // The last page ends on the recording's last word, a little short of its length. The run's steps call that done.
  expect(live([page(2, 0, undefined), page(3, 0, 60), page(4, 58, 119.7)])).toMatchObject({ text: "Preparing edits…", entry: { scan: { seconds: 119.7 } } });
  expect(live([page(2, 0, undefined), page(3, 0, 60), page(4, 58, 119)])?.text).toBe("Scanning dialogue");
});

describe("queueLabel", () => {
  const isPass = (t: Task) => taskRunKind(t) === "pass";
  const queued = task("mine", "queued", { createdAt: at(5) });

  it("says nothing for a request that isn't waiting its turn", () => {
    expect(queueLabel(task("mine", "running"), [], [], isPass)).toBeUndefined();
    expect(queueLabel(queued, [queued], [], isPass)).toBeUndefined();
    // A transcription runs beside the edits, and another project's work is not in this one's way.
    const others = [task("transcribing", "running", { kind: "transcribe" }), task("elsewhere", "running", { projectId: "other" })];
    expect(queueLabel(queued, [...others, queued], [], isPass)).toBeUndefined();
  });

  it("names what is running ahead of it: the dialogue pass, or the current edit", () => {
    expect(queueLabel(queued, [task("pass", "running", { instruction: "/dialogue-pass" }), queued], [], isPass)).toBe("Queued · After the dialogue pass");
    expect(queueLabel(queued, [task("zoom", "claimed"), queued], [], isPass)).toBe("Queued · After the current edit");
  });

  it("says it waits for the editor's answer when an earlier request asked a question", () => {
    expect(queueLabel(queued, [task("asking", "waiting_for_user", { question: "Which take?" }), queued], [], isPass))
      .toBe("Queued · Waiting for your answer on the earlier edit");
  });

  it("counts the requests asked before it, and not the ones asked after", () => {
    const earlier = task("first", "queued", { createdAt: at(1) }), second = task("second", "queued", { createdAt: at(2) }), later = task("later", "queued", { createdAt: at(9) });
    expect(queueLabel(queued, [earlier, queued, later], [], isPass)).toBe("Queued · 1 request ahead");
    expect(queueLabel(queued, [earlier, second, queued, later], [], isPass)).toBe("Queued · 2 requests ahead");
    expect(queueLabel(earlier, [earlier, second, queued, later], [], isPass)).toBeUndefined();
  });

  it("is plain Queued behind a dialogue pass whose calls the editor hasn't made, unless it is about that pass", () => {
    const pass = change("pass-cuts", "ready", { intent: "suggestion", threadId: "pass-thread", cutReasons: [{ start: 1, end: 2, reason: "pause" }] } as Partial<Change>);
    expect(queueLabel(queued, [queued], [pass], isPass)).toBe("Queued");
    // A revision of one of the pass's cuts, or a reply in its thread, works on the pass and isn't held by it.
    expect(queueLabel({ ...queued, context: { changeId: "pass-cuts" } }, [queued], [pass], isPass)).toBeUndefined();
    expect(queueLabel({ ...queued, context: { threadId: "pass-thread" } }, [queued], [pass], isPass)).toBeUndefined();
    // Once the calls are made, nothing holds it.
    expect(queueLabel(queued, [queued], [{ ...pass, state: "approved" }], isPass)).toBeUndefined();
  });
});

it("lists the cuts a dialogue pass applied, through later revisions of them, and nothing that isn't a cut", () => {
  const delivery = { task: task("pass", "done"), appliedChangeIds: ["pass-a", "pass-b"], state: "ready" as const };
  const cut = (changeId: string, extra: Partial<ThreadEdit> = {}): ThreadEdit => ({ changeId, spot: 0, label: changeId, range: { start: 1, end: 2 }, previous: [],
    beforeCut: { removed: { start: 1, end: 2 } } as ThreadEdit["beforeCut"], ...extra });
  const edits = [
    cut("pass-a"),
    // Revised since: the cut now belongs to the revision, and is still the pass's.
    cut("revision", { previous: [{ changeId: "pass-b", spot: 3 }] as ThreadEdit["previous"] }),
    cut("another-request"),
    // The pass's own edit that removed nothing.
    cut("pass-a", { label: "level the audio", beforeCut: undefined }),
  ];
  expect(appliedPassCuts(delivery, edits).map(e => e.label)).toEqual(["pass-a", "revision"]);
  expect(appliedPassCuts({ ...delivery, appliedChangeIds: [] }, edits)).toEqual([]);
});

describe("groupEditMessages", () => {
  const saved = (c: Change, text: string, taskId?: string): ThreadEntry => ({ kind: "change", at: c.createdAt ?? at(1), change: c, attempt: 1, text, taskId });

  it("puts a finished request's updates under its result, and shows a first cut's delivery on its change", () => {
    const done = task("req", "done", { changeIds: ["made"] });
    const made = change("made", "approved", { taskId: "req" });
    const [thread] = buildThreads({ tasks: [done], changes: [made], notes: [] });
    const update: ThreadEntry = { kind: "progress", taskId: "req", at: at(1), text: "Checked the join" };
    const delivery = { task: done, appliedChangeIds: ["made"], state: "ready" as const, version: "v_made", change: made };
    const entries: ThreadEntry[] = [
      { kind: "request", taskId: "req", at: at(0), text: "Trim the start", author: done.createdBy },
      update,
      saved(made, "Trimmed the start", "req"),
      { kind: "firstCut", at: at(2), delivery },
    ];
    const rows = groupEditMessages(entries, thread!, []);
    expect(rows.map(r => r.kind)).toEqual(["request", "change"]);
    expect(rows[1]).toMatchObject({ kind: "change", text: "Trimmed the start", activity: [update], delivery });
  });

  it("leaves an update where it is while its request still runs, and a first cut that isn't ready as its own row", () => {
    const running = task("req", "running");
    const [thread] = buildThreads({ tasks: [running], changes: [], notes: [] });
    const update: ThreadEntry = { kind: "progress", taskId: "req", at: at(1), text: "Reading the transcript" };
    const preparing: ThreadEntry = { kind: "firstCut", at: at(2), delivery: { task: running, appliedChangeIds: [], state: "preparing" } };
    expect(groupEditMessages([update, preparing], thread!, [])).toEqual([update, preparing]);
  });

  it("explains a result with Scarlet's reply to it, once, and keeps a different explanation as a detail", () => {
    const done = task("req", "done", { changeIds: ["made"] });
    const made = change("made", "approved", { taskId: "req", description: "Removed the false start." });
    const [thread] = buildThreads({ tasks: [done], changes: [made], notes: [] });
    const reply = (text: string): ThreadEntry => ({ kind: "agent", taskId: "req", at: at(2), text, author: made.author, change: made });
    const rows = groupEditMessages([saved(made, "Removed the false start", "req"), reply("I cut the false start and kept the breath."), reply("I cut the false start and kept the breath.")], thread!, []);
    expect(rows).toHaveLength(1);
    // The reply is the row's words. What the change saved, said differently, is kept once behind it.
    expect(rows[0]).toMatchObject({ kind: "change", text: "I cut the false start and kept the breath." });
    const details = (rows[0] as Extract<ThreadEntry, { kind: "change" }>).details!.map(d => d.text);
    expect(details).toEqual(["Removed the false start"]);
  });
});
