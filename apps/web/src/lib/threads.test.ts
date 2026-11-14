import { describe, expect, it } from "vitest";
import type { Task, ThreadEdit } from "@scarlet/shared";
import type { Change, Note } from "@scarlet/timeline";
import { appliedPassCuts, buildThreads, firstCutDeliveries, requestTarget, revisionTarget, threadConversation } from "./threads";

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
