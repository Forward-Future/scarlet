// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fullRenderContext, type Learning, type ProjectDetail, type TaskEvent } from "@scarlet/shared";
import { api } from "../lib/client";
import { leaveProject, startRealtime } from "../lib/realtime";
import { buildDb, PRJ } from "../lib/mock/fixtures";
import { selectHeadRender, useProjectStore, type ProjectData } from "./project";

const initial = useProjectStore.getState();
beforeEach(() => {
  vi.spyOn(api, "learnings").mockResolvedValue({ learnings: [] });
  vi.spyOn(api, "projectUsage").mockResolvedValue({ by: "task", groups: [], total: {
    runs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    totalTokens: 0, firstAt: null, lastAt: null,
  } });
});
afterEach(() => {
  useProjectStore.setState(initial, true);
  // Putting the store back closes the project, which drops the store's wait to read it again: no timer reaches the next test.
  const waiting = vi.isFakeTimers() ? vi.getTimerCount() : 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  expect(waiting).toBe(0);
});

it("keeps a committed approval when the updated timeline cannot be loaded", async () => {
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  const prior = db.changes.find(c => c.state === "ready")!;
  useProjectStore.setState({ current: { id: PRJ, project, timeline: db.timelines[project.head!]!,
    media: project.media, changes: [prior], notes: [], tasks: [], renders: [], taskEvents: {} } });
  const approved = { change: { ...prior, state: "approved" as const }, project: { ...project, head: "new-head" }, outcome: "applied" as const };
  vi.spyOn(api, "approveChange").mockResolvedValue(approved);
  vi.spyOn(api, "workspace").mockRejectedValue(new Error("Unable to read workspace"));
  await expect(initial.approve(prior.id)).resolves.toEqual(approved);
  // The timeline that was read stays on screen until the new one is, and the conversation with it.
  expect(useProjectStore.getState().current).toMatchObject({
    project: { head: "new-head" }, changes: [approved.change], timeline: db.timelines[project.head!]!,
  });
  expect(useProjectStore.getState().current).not.toHaveProperty("reviewStatus");
});

it("skips unchanged library refreshes and immediately publishes changed review counts", async () => {
  const summary = buildDb().summaries[PRJ]!;
  const apiList = vi.spyOn(api, "projects").mockResolvedValue({projects: [summary]});
  await initial.loadList();
  const before = useProjectStore.getState();
  apiList.mockResolvedValue({projects: [structuredClone(summary)]});
  await initial.loadList();
  expect(useProjectStore.getState()).toBe(before);
  apiList.mockResolvedValue({projects: [{...summary, pendingChanges: summary.pendingChanges + 1}]});
  await initial.loadList();
  expect(useProjectStore.getState().list[0]!.pendingChanges).toBe(summary.pendingChanges + 1);
});

it("opens the monitor from one snapshot while preserving edits and imports that arrive during loading", async () => {
  const db = buildDb();
  const project = { ...db.projects[0]!, id: PRJ, media: [] };
  const media = { ...db.media[PRJ]![0]!, status: "ready" as const };
  const task = { ...db.tasks[0]!, projectId: PRJ };
  let readSnapshot!: (snapshot: Pick<ProjectDetail, "project" | "timeline">) => void;
  let readTasks!: (response: { tasks: typeof task[] }) => void;
  const snapshot = new Promise<Pick<ProjectDetail, "project" | "timeline">>(resolve => { readSnapshot = resolve; });
  vi.spyOn(api, "workspace").mockReturnValue(snapshot);
  const reread = vi.spyOn(api, "media");
  vi.spyOn(api, "changes").mockResolvedValue({ changes: [] });
  vi.spyOn(api, "notes").mockResolvedValue({ notes: [] });
  vi.spyOn(api, "tasks").mockImplementation(() => new Promise(resolve => { readTasks = resolve; }));
  const done = initial.load(PRJ);
  initial.applyEvent({ type: "media.updated", projectId: PRJ, media });
  initial.upsertMedia(PRJ, { ...media, status: "ingesting" });
  readSnapshot({ project, timeline: null });
  await snapshot;
  expect(useProjectStore.getState().current).toMatchObject({ media: [media], reviewStatus: "loading" });
  initial.applyEvent({ type: "task.updated", projectId: PRJ, task: { ...task, state: "done" } });
  readTasks({ tasks: [{ ...task, state: "running" }] });
  await done;
  expect(useProjectStore.getState().current?.tasks).toMatchObject([{ id: task.id, state: "done" }]);
  expect(reread).not.toHaveBeenCalled();
});

it("resnapshots after subscribing when the socket connects during a first project read", async () => {
  let socket!: TestSocket;
  class TestSocket {
    static OPEN = 1;
    readyState = 0;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    send = vi.fn();
    close = vi.fn();
    constructor() { socket = this; }
  }
  vi.stubGlobal("WebSocket", TestSocket);
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  let finishOld!: (value: { project: typeof project; timeline: null }) => void;
  const read = vi.spyOn(api, "workspace").mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
    .mockResolvedValue({ project: { ...project, name: "After reconnect" }, timeline: null });
  vi.spyOn(api, "changes").mockResolvedValue({ changes: [] });
  vi.spyOn(api, "notes").mockResolvedValue({ notes: [] });
  vi.spyOn(api, "tasks").mockResolvedValue({ tasks: [] });
  const stop = startRealtime();
  try {
    const first = initial.load(PRJ);
    socket.readyState = TestSocket.OPEN;
    socket.onopen!();
    finishOld({ project, timeline: null });
    await first;
    expect(useProjectStore.getState().current).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    socket.onmessage!({ data: JSON.stringify({ type: "project.subscribed", projectId: PRJ, found: true }) });
    await vi.waitFor(() => expect(useProjectStore.getState().current?.project.name).toBe("After reconnect"));
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    leaveProject(PRJ);
    stop();
    vi.unstubAllGlobals();
  }
});

it("keeps the last opened project when an earlier load or head refresh finishes late", async () => {
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  const detail = { project, summary: db.summaries[PRJ]!, timeline: null };
  const other = { ...detail, project: { ...project, id: "prj_other" }, summary: { ...detail.summary, id: "prj_other" } };
  const read = vi.spyOn(api, "workspace").mockResolvedValue(detail);
  vi.spyOn(api, "changes").mockResolvedValue({ changes: [] });
  vi.spyOn(api, "notes").mockResolvedValue({ notes: [] });
  vi.spyOn(api, "renders").mockResolvedValue({ renders: [] });
  vi.spyOn(api, "tasks").mockResolvedValue({ tasks: [] });
  vi.spyOn(api, "versions").mockResolvedValue({ versions: [] });
  vi.spyOn(api, "media").mockResolvedValue({ media: [] });
  await initial.load(PRJ);
  expect(api.versions).not.toHaveBeenCalled();
  expect(api.renders).not.toHaveBeenCalled();
  await initial.refreshFullRenders();
  expect(api.renders).toHaveBeenCalledExactlyOnceWith(PRJ, { kind: "full", version: "head" });
  await initial.loadVersions();
  await initial.loadVersions();
  expect(api.versions).toHaveBeenCalledExactlyOnceWith(PRJ);
  const release: Array<(response: Pick<ProjectDetail, "project" | "timeline">) => void> = [];
  read.mockImplementation(() => new Promise(resolve => release.push(resolve)));
  const refresh = initial.refreshHead();
  const reload = initial.load(PRJ);
  read.mockResolvedValue(other);
  await initial.load(other.project.id);
  for (const resolve of release) resolve(detail);
  await Promise.all([refresh, reload]);
  expect(useProjectStore.getState().current).toMatchObject({ id: other.project.id, project: other.project });
});

it("preserves a ready media event that beats the import response", () => {
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  const media = db.media[PRJ]![0]!;
  useProjectStore.setState({ current: {
    id: PRJ, project, timeline: null, media: [], changes: [], notes: [],
    renders: [], tasks: [], taskEvents: {}, versions: [],
  } });
  initial.applyEvent({ type: "media.updated", projectId: PRJ, media: { ...media, status: "ready" } });
  initial.upsertMedia(PRJ, { ...media, status: "ingesting" });
  expect(useProjectStore.getState().current?.media[0]?.status).toBe("ready");
});

it("removes a finished head render the engine invalidated and keeps concurrent new completions", async () => {
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  const stale = db.renders.find(r => r.kind === "full")!;
  const newer = { ...stale, id: "new-render" };
  const historical = { ...stale, id: "past", version: "past-version" };
  useProjectStore.setState({ current: { id: PRJ, project, timeline: null, media: [], changes: [], notes: [],
    renders: [stale, historical], tasks: [], taskEvents: {} } });
  const keys = { context: fullRenderContext(project), preview: stale.key, delivery: "delivery" };
  vi.spyOn(api, "renders").mockResolvedValue({ renders: [], fullRenderKeys: keys });
  const lookup = initial.refreshFullRenders();
  initial.applyEvent({ type: "render.updated", projectId: PRJ, render: newer });
  await lookup;
  expect(useProjectStore.getState().current?.renders.map(r => r.id)).toEqual(["past", "new-render"]);
});

it("keeps a first-cut task in its initiating project and preserves newer worker events", async () => {
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  const current = { id: PRJ, project, timeline: null, media: [], changes: [], notes: [],
    renders: [], tasks: [], taskEvents: {}, versions: [] };
  const task = { ...db.tasks[0]!, projectId: PRJ, state: "queued" as const };
  const make = () => initial.createTask(PRJ, { kind: "edit", agent: task.agent, instruction: "Make first cut" });
  const send = vi.spyOn(api, "createTask").mockResolvedValue({ task });
  useProjectStore.setState({ current });
  const first = make();
  useProjectStore.setState({ current: { ...current, id: "other-project" } });
  await first;
  expect(useProjectStore.getState().current?.tasks).toEqual([]);

  useProjectStore.setState({ current });
  const second = make();
  initial.applyEvent({ type: "task.updated", projectId: PRJ, task: { ...task, state: "running" } });
  await second;
  expect(send).toHaveBeenCalledTimes(2);
  expect(useProjectStore.getState().current?.tasks).toMatchObject([{ id: task.id, state: "running" }]);
});

it("keeps late checkout, note, and optimistic rollback results in the original project", async () => {
  const db = buildDb();
  const [a, b] = db.projects;
  const data = (project: NonNullable<typeof a>): ProjectData => ({
    id: project.id, project, timeline: null, media: project.media,
    changes: [], notes: [], renders: [], tasks: [], taskEvents: {}, versions: [],
  });
  const other = data(b!);
  useProjectStore.setState({ current: data(a!) });
  vi.spyOn(api, "checkout").mockResolvedValue({ project: { ...a!, head: "restored" } });
  vi.spyOn(api, "changes").mockResolvedValue({ changes: db.changes });
  const readHead = vi.spyOn(api, "workspace");
  vi.spyOn(api, "createNote").mockResolvedValue({ note: db.notes[0]! });
  vi.spyOn(api, "updateProject").mockRejectedValue(new Error("rename failed"));

  const checkout = initial.checkout("restored");
  const note = initial.createNote(PRJ, { time: 0, text: "A only" });
  const failed = initial.updateProject({ name: "Pending" });
  useProjectStore.setState({ current: other });
  await Promise.all([checkout, note, expect(failed).rejects.toThrow("rename failed")]);

  expect(readHead).not.toHaveBeenCalled();
  expect(useProjectStore.getState().current).toBe(other);
});

it("keeps a transcription's place in line when the socket is ahead of the request that started it", async () => {
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  const created = { ...db.tasks.find(t => t.kind === "transcribe") ?? db.tasks[0]!, id: "task_transcribe_new", kind: "transcribe" as const,
    state: "running" as const, finishedAt: undefined, progress: undefined };
  // The engine has already said this one waits behind another recording.
  const waiting = { ...created, progress: { stage: "queued" as const, fraction: 0 } };
  useProjectStore.setState({ current: { id: PRJ, project, timeline: db.timelines[project.head!]!,
    media: project.media, changes: [], notes: [], tasks: [waiting], renders: [], taskEvents: {} } });
  vi.spyOn(api, "transcribe").mockResolvedValue({ task: created });
  await expect(initial.transcribe("media_1")).resolves.toBe(waiting);
  expect(useProjectStore.getState().current!.tasks).toEqual([waiting]);
});

it("doesn't put a request back in line when the answer's reply arrives after Scarlet picked it up", async () => {
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  const asked = { ...db.tasks.find(t => t.kind !== "transcribe")!, id: "task_asking", state: "waiting_for_user" as const, question: "Smaller by how much?", finishedAt: undefined };
  // The socket has already said the answered request is running again.
  const running = { ...asked, state: "running" as const, question: null };
  useProjectStore.setState({ current: { id: PRJ, project, timeline: db.timelines[project.head!]!,
    media: project.media, changes: [], notes: [], tasks: [running], renders: [], taskEvents: {} } });
  vi.spyOn(api, "answerTask").mockResolvedValue({ task: { ...asked, state: "queued", question: null } });
  await initial.answerTask("task_asking", "By half.");
  expect(useProjectStore.getState().current!.tasks).toEqual([running]);
  // With the socket not there yet, the reply is what the store has.
  useProjectStore.setState({ current: { ...useProjectStore.getState().current!, tasks: [asked] } });
  await initial.answerTask("task_asking", "By half.");
  expect(useProjectStore.getState().current!.tasks[0]).toMatchObject({ state: "queued", question: null });
});

it("keeps a queued request's hold, new words and early start as the engine answers, unless the socket has it running", async () => {
  const { db } = open();
  const queued = { ...db.tasks.find(t => t.kind !== "transcribe")!, id: "task_queued", projectId: PRJ, state: "queued" as const };
  const running = { ...queued, state: "running" as const };
  const held = { ...queued, heldForRewording: true } as typeof queued;
  vi.spyOn(api, "holdForRewording").mockResolvedValue({ task: held });
  vi.spyOn(api, "rewordTask").mockResolvedValue({ task: { ...queued, instruction: "Shorter" } });
  vi.spyOn(api, "startBeforeCalls").mockResolvedValue({ task: queued });
  open({ tasks: [queued] });
  await initial.holdForRewording(queued.id, true);
  expect(store().tasks).toEqual([held]);
  await initial.rewordTask(queued.id, "Shorter", ["skl_dialogue"]);
  expect(api.rewordTask).toHaveBeenCalledExactlyOnceWith(queued.id, "Shorter", ["skl_dialogue"]);
  expect(store().tasks[0]!.instruction).toBe("Shorter");
  // Scarlet picked it up before the answer came back: the answer doesn't put it back in line.
  open({ tasks: [running] });
  await initial.startBeforeCalls(queued.id);
  await initial.holdForRewording(queued.id, false);
  expect(store().tasks).toEqual([running]);
});

it("keeps a learning the editor revised or declined as the engine answers, and sends nothing with no project open", async () => {
  const { db } = open();
  const rule: Learning = { id: "lrn_1", projectId: PRJ, rule: "Leave the breath.", said: "Keep the breath.", taskId: db.tasks[0]!.id,
    skillId: "skl_dialogue", state: "suggested" };
  open({ learnings: [rule] });
  vi.spyOn(api, "reviseLearning").mockResolvedValue({ learning: { ...rule, rule: "Leave the breath before a punchline." } });
  vi.spyOn(api, "declineLearning").mockResolvedValue({ learning: { ...rule, state: "declined" } as Learning });
  await initial.reviseLearning(rule.id, "Leave the breath before a punchline.");
  expect(api.reviseLearning).toHaveBeenCalledExactlyOnceWith(PRJ, rule.id, { rule: "Leave the breath before a punchline." });
  expect(store().learnings).toEqual([{ ...rule, rule: "Leave the breath before a punchline." }]);
  await initial.declineLearning(rule.id);
  expect(api.declineLearning).toHaveBeenCalledExactlyOnceWith(PRJ, rule.id);
  expect(store().learnings).toEqual([{ ...rule, state: "declined" }]);
  useProjectStore.setState({ current: null });
  await initial.reviseLearning(rule.id, "Again");
  await initial.declineLearning(rule.id);
  expect(api.reviseLearning).toHaveBeenCalledTimes(1);
  expect(api.declineLearning).toHaveBeenCalledTimes(1);
});

/** The sample project open in the store, as a page would have it. */
function open(extra: Partial<ProjectData> = {}) {
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  const current: ProjectData = { id: PRJ, project, timeline: db.timelines[project.head!]!, media: project.media,
    changes: [], notes: [], tasks: [], renders: [], taskEvents: {}, ...extra };
  useProjectStore.setState({ current, status: "ready" });
  return { db, project, current };
}
const said = (id: string, second: number, text = id): TaskEvent => ({ id, type: "log", text, at: new Date(Date.UTC(2026, 9, 30, 12, 0, second)).toISOString() });
const store = () => useProjectStore.getState().current!;

it("doesn't put a new request back in line when the reply that made it arrives after Scarlet picked it up", async () => {
  const { db, project, current } = open();
  const queued = { ...db.tasks.find(t => t.kind !== "transcribe")!, id: "task_new", projectId: PRJ, state: "queued" as const, finishedAt: undefined };
  // The engine tells the socket before it answers: by then Scarlet has the request.
  const claimed = { ...queued, state: "claimed" as const };
  const note = { ...db.notes[0]!, id: "note_new", projectId: PRJ };
  const change = { ...db.changes.find(c => c.state === "ready")!, projectId: PRJ };
  vi.spyOn(api, "createNote").mockResolvedValue({ note, task: queued });
  vi.spyOn(api, "createVoiceNote").mockResolvedValue({ note, task: queued });
  // An approval that overlaps a newer edit is sent back to Scarlet, as a request of its own.
  vi.spyOn(api, "approveChange").mockResolvedValue({ change, project, outcome: "sent_back", task: queued });
  vi.spyOn(api, "workspace").mockResolvedValue({ project, timeline: current.timeline });
  const typed = () => initial.createNote(PRJ, { time: 3, text: "Tighten this" });
  const spoken = () => initial.createVoiceNote(PRJ, new Blob(["voice"]), { time: 3 } as never);
  const approved = () => initial.approve(change.id);
  open({ changes: [change], tasks: [claimed] });
  await typed();
  expect(store().tasks).toEqual([claimed]);
  await spoken();
  expect(store().tasks).toEqual([claimed]);
  await approved();
  expect(store().tasks).toEqual([claimed]);
  // With the socket not there yet, the reply is what the store has.
  for (const send of [typed, spoken, approved]) {
    open({ changes: [change] });
    await send();
    expect(store().tasks).toEqual([queued]);
  }
});

it("keeps a project update received while a rename is failing", async () => {
  const { project } = open();
  let fail!: (err: Error) => void;
  vi.spyOn(api, "updateProject").mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  const renaming = initial.updateProject({ name: "Pending name" });
  expect(store().project.name).toBe("Pending name");
  const newer = { ...project, mediaPaused: true, name: "Name from the engine" };
  initial.applyEvent({ type: "project.updated", projectId: PRJ, project: newer });
  fail(new Error("Rename failed"));
  await expect(renaming).rejects.toThrow("Rename failed");
  expect(store().project).toBe(newer);
});

it("opens completed conversations in the task snapshot and retains steps received over the socket", async () => {
  const db = buildDb();
  const project = { ...db.projects[0]!, id: "batch-project" };
  const task = { ...db.tasks.find(t => t.kind !== "transcribe")!, projectId: project.id };
  vi.spyOn(api, "workspace").mockResolvedValue({ project, timeline: null });
  vi.spyOn(api, "changes").mockResolvedValue({ changes: [] });
  vi.spyOn(api, "notes").mockResolvedValue({ notes: [] });
  vi.spyOn(api, "tasks").mockImplementation(async () => {
    initial.applyEvent({ type: "task.event", projectId: project.id, taskId: task.id, event: said("live", 2) });
    return { tasks: [task], conversation: { [task.id]: [said("saved", 1)] } };
  });
  const read = vi.spyOn(api, "task").mockResolvedValue({ task: structuredClone(task), events: [said("tool", 0), said("saved", 1)] });
  await initial.load(project.id);
  await initial.loadTaskEvents(task.id, "conversation");
  expect(read).not.toHaveBeenCalled();
  expect(store().taskEvents[task.id]?.map(e => e.id)).toEqual(["saved", "live"]);
  const tasks = store().tasks;
  await initial.loadTaskEvents(task.id, "all");
  expect(read).toHaveBeenCalledExactlyOnceWith(task.id, "all");
  expect(store().tasks).toBe(tasks);
  expect(store().taskEvents[task.id]?.map(e => e.id)).toEqual(["tool", "saved", "live"]);
});

it("reads a run's steps again after the connection comes back, so what Scarlet did meanwhile shows", async () => {
  const { db, project } = open();
  const task = { ...db.tasks.find(t => t.kind !== "transcribe")!, id: "task_run", state: "running" as const };
  open({ tasks: [task] });
  vi.spyOn(api, "workspace").mockResolvedValue({ project, timeline: null });
  vi.spyOn(api, "changes").mockResolvedValue({ changes: [] });
  vi.spyOn(api, "notes").mockResolvedValue({ notes: [] });
  vi.spyOn(api, "tasks").mockResolvedValue({ tasks: [task] });
  const read = vi.spyOn(api, "task").mockResolvedValue({ task, events: [said("e1", 1)] });
  await initial.loadTaskEvents("task_run", "conversation");
  await initial.loadTaskEvents("task_run", "all");
  expect(store().taskEvents.task_run?.map(e => e.id)).toEqual(["e1"]);
  // While the socket was down Scarlet took two more steps. Nothing but a fresh read can deliver them.
  read.mockClear();
  read.mockResolvedValue({ task, events: [said("e1", 1), said("e2", 2), said("e3", 3)] });
  await initial.load(PRJ);
  await vi.waitFor(() => expect(store().taskEvents.task_run?.map(e => e.id)).toEqual(["e1", "e2", "e3"]));
  // One read, of everything the page had asked for.
  expect(read).toHaveBeenCalledExactlyOnceWith("task_run", "all");
  expect(store().taskEventScopes).toEqual({ task_run: "all" });
});

it("takes the engine's list of learnings after the connection comes back, so a rule it saved or sent back meanwhile doesn't stay on Saving", async () => {
  // A reconnect remembers task history by project. Keep this fixture separate from the task-history tests.
  const projectId = "prj_learnings";
  const db = buildDb();
  const project = { ...db.projects.find(p => p.id === PRJ)!, id: projectId };
  const rule = (id: string, extra: Partial<Learning> = {}): Learning => ({ id, projectId, rule: "Leave the breath before a punchline.",
    said: "Keep the breath before the punchline.", taskId: db.tasks[0]!.id, skillId: "skl_dialogue", state: "saving", ...extra });
  open({ id: projectId, project, learnings: [rule("lrn_saved"), rule("lrn_back"), rule("lrn_waiting", { state: "suggested" })] });
  vi.spyOn(api, "workspace").mockResolvedValue({ project, timeline: null });
  vi.spyOn(api, "changes").mockResolvedValue({ changes: [] });
  vi.spyOn(api, "notes").mockResolvedValue({ notes: [] });
  vi.spyOn(api, "tasks").mockResolvedValue({ tasks: [] });
  let answer!: (response: { learnings: Learning[] }) => void;
  vi.spyOn(api, "learnings").mockImplementation(() => new Promise(resolve => { answer = resolve; }));
  await initial.load(projectId);
  // Until the engine's list arrives the rules read as they did.
  expect(store().learnings?.map(l => [l.id, l.state])).toEqual([["lrn_saved", "saving"], ["lrn_back", "saving"], ["lrn_waiting", "suggested"]]);
  // What happens here while the list is read is newer than the list: the editor approves a rule, and Scarlet offers another.
  initial.applyEvent({ type: "learning.updated", projectId, learning: rule("lrn_waiting") });
  initial.applyEvent({ type: "learning.updated", projectId, learning: rule("lrn_new", { state: "suggested" }) });
  // While the socket was down Scarlet saved one rule, which it no longer lists, and sent one back. No event said so.
  answer({ learnings: [rule("lrn_back", { state: "suggested", error: "It already says that." }), rule("lrn_waiting", { state: "suggested" })] });
  await vi.waitFor(() => expect(store().learnings?.map(l => [l.id, l.state, l.error])).toEqual([
    ["lrn_back", "suggested", "It already says that."], ["lrn_waiting", "saving", undefined], ["lrn_new", "suggested", undefined]]));
});

it("reads a run's steps again when the project reloaded while they were still being read", async () => {
  const { db, project } = open();
  const task = { ...db.tasks.find(t => t.kind !== "transcribe")!, id: "task_run", state: "running" as const };
  open({ tasks: [task] });
  vi.spyOn(api, "workspace").mockResolvedValue({ project, timeline: null });
  vi.spyOn(api, "changes").mockResolvedValue({ changes: [] });
  vi.spyOn(api, "notes").mockResolvedValue({ notes: [] });
  const finished = { ...task, state: "done" as const };
  vi.spyOn(api, "tasks").mockResolvedValue({ tasks: [finished] });
  const answers: ((response: { task: typeof finished | typeof task; events: TaskEvent[] }) => void)[] = [];
  const read = vi.spyOn(api, "task").mockImplementation(() => new Promise(resolve => { answers.push(resolve); }));
  const lookup = initial.loadTaskEvents("task_run", "all");
  // The socket opens and the project is read again before the steps arrive. The page won't ask twice.
  await initial.load(PRJ);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  initial.applyEvent({ type: "task.event", projectId: PRJ, taskId: "task_run", event: said("e3", 3) });
  // The read from before the reload is out of date, down to its copy of the request.
  answers[0]!({ task, events: [said("e1", 1)] });
  await lookup;
  expect(store().taskEvents.task_run?.map(e => e.id)).toEqual(["e3"]);
  answers[1]!({ task: finished, events: [said("e1", 1), said("e2", 2)] });
  await vi.waitFor(() => expect(store().taskEvents.task_run?.map(e => e.id)).toEqual(["e1", "e2", "e3"]));
  expect(store().taskEventScopes).toEqual({ task_run: "all" });
  expect(store().tasks).toMatchObject([{ id: "task_run", state: "done" }]);
});

it("doesn't read another project's steps when a project is opened, only when the same one is read again", async () => {
  const { db, project } = open();
  const task = { ...db.tasks.find(t => t.kind !== "transcribe")!, id: "task_run", state: "running" as const };
  open({ tasks: [task] });
  const other = { ...project, id: "prj_other" };
  vi.spyOn(api, "workspace").mockImplementation(async id => ({ project: id === PRJ ? project : other, timeline: null }));
  vi.spyOn(api, "changes").mockResolvedValue({ changes: [] });
  vi.spyOn(api, "notes").mockResolvedValue({ notes: [] });
  vi.spyOn(api, "tasks").mockResolvedValue({ tasks: [] });
  const read = vi.spyOn(api, "task").mockResolvedValue({ task, events: [said("e1", 1)] });
  await initial.loadTaskEvents("task_run");
  await initial.load("prj_other");
  await initial.load("prj_other");
  await initial.load(PRJ);
  await new Promise(done => setTimeout(done));
  expect(read).toHaveBeenCalledTimes(1);
});

it("drops the closed project's requests for steps even when the same project opens again", async () => {
  const { db, project } = open();
  const task = db.tasks.find(t => t.kind !== "transcribe")!;
  answering(project);
  let finish!: (response: { task: typeof task; events: TaskEvent[] }) => void;
  const read = vi.spyOn(api, "task").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue({ task, events: [said("new", 2)] });
  const old = initial.loadTaskEvents(task.id);
  useProjectStore.setState(initial, true);
  open();
  await initial.load(PRJ);
  expect(read).toHaveBeenCalledTimes(1);
  await initial.loadTaskEvents(task.id);
  finish({ task, events: [said("old", 1)] });
  await old;
  expect(store().taskEvents[task.id]?.map(event => event.id)).toEqual(["new"]);
});

it("keeps the last timeline and the conversation when the edit moved on and its new timeline can't be read, reads it again by itself, and says so only if it keeps failing", async () => {
  vi.useFakeTimers();
  const { db, project } = open();
  const last = store().timeline;
  const failed = vi.fn();
  process.on("unhandledRejection", failed);
  try {
    const read = vi.spyOn(api, "workspace").mockRejectedValue(new Error("Unable to read workspace"));
    initial.applyEvent({ type: "project.updated", projectId: PRJ, project: { ...project, head: "moved-on" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    // One failed read takes nothing off screen and says nothing yet: the timeline that was read stays, as it does while
    // any new one is on its way, and the conversation isn't swapped for an error.
    expect(store()).toMatchObject({ project: { head: "moved-on" }, timeline: last });
    expect([store().reviewStatus, store().headError]).toEqual([undefined, undefined]);
    // It is read again after 1, 2, 4 and 8 seconds. Only when that last try fails too is it said, beside the conversation.
    for (const [wait, reads] of [[1000, 2], [2000, 3], [4000, 4], [8000, 5]] as const) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(read).toHaveBeenCalledTimes(reads - 1);
      expect(store().headError).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(read).toHaveBeenCalledTimes(reads);
    }
    expect(store()).toMatchObject({ timeline: last, headError: "Couldn’t load the updated timeline: Unable to read workspace" });
    expect(store().reviewStatus).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    // The next edit's timeline is read: what was said goes with the old timeline.
    const next = { ...db.timelines[project.head!]!, version: "next" };
    read.mockResolvedValue({ project: { ...project, head: "next" }, timeline: next });
    initial.applyEvent({ type: "project.updated", projectId: PRJ, project: { ...project, head: "next" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(store()).toMatchObject({ timeline: next });
    expect(store().headError).toBeUndefined();

    // A read that fails once and then works brings the new timeline in by itself, with nothing said.
    read.mockRejectedValueOnce(new Error("Unable to read workspace"));
    const after = { ...next, version: "after" };
    read.mockResolvedValue({ project: { ...project, head: "after" }, timeline: after });
    initial.applyEvent({ type: "project.updated", projectId: PRJ, project: { ...project, head: "after" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(store().timeline).toBe(next);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store().timeline).toEqual(after);
    expect([store().headError, vi.getTimerCount()]).toEqual([undefined, 0]);

    // A try waiting when the socket comes back gives way to its reload, which reads the timeline too.
    read.mockRejectedValueOnce(new Error("Unable to read workspace"));
    initial.applyEvent({ type: "project.updated", projectId: PRJ, project: { ...project, head: "later" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    const later = { ...next, version: "later" };
    read.mockResolvedValue({ project: { ...project, head: "later" }, timeline: later });
    answering({ ...project, head: "later" }).snapshot.mockResolvedValue({ project: { ...project, head: "later" }, timeline: later });
    await initial.load(PRJ);
    expect(vi.getTimerCount()).toBe(0);
    expect(store().timeline).toEqual(later);
    expect(failed).not.toHaveBeenCalled();
  } finally {
    process.off("unhandledRejection", failed);
  }
});

it("picks the newest finished render of the working edit, and one without a date last", () => {
  const { db, project } = open();
  const full = db.renders.find(r => r.kind === "full")!;
  const render = (id: string, createdAt?: string) => ({ ...full, id, projectId: PRJ, version: project.head!, state: "done" as const, range: null, key: "k", createdAt });
  const keys = { context: fullRenderContext(project), preview: "k", delivery: "other" };
  const renders = [render("undated"), render("old", "2026-10-01T00:00:00.000Z"), render("new", "2026-10-02T00:00:00.000Z")];
  expect(selectHeadRender({ ...store(), fullRenderKeys: keys, renders })?.id).toBe("new");
  expect(selectHeadRender({ ...store(), fullRenderKeys: keys, renders: [renders[2]!, renders[0]!, renders[1]!] })?.id).toBe("new");
});

it("reads a run's steps once, merges them with the ones the socket already delivered, and keeps the fuller read", async () => {
  const { db } = open();
  const task = { ...db.tasks.find(t => t.kind !== "transcribe")!, id: "task_run", state: "running" as const };
  open({ tasks: [task], taskEvents: { task_run: [said("e3", 3), said("live-only", 4)] } });
  let answer!: (response: { task: typeof task; events: TaskEvent[] }) => void;
  const read = vi.spyOn(api, "task").mockImplementation(() => new Promise(resolve => { answer = resolve; }));
  const first = initial.loadTaskEvents("task_run", "conversation");
  // Asked again before the answer, it is the same read.
  const again = initial.loadTaskEvents("task_run", "conversation");
  expect(read).toHaveBeenCalledExactlyOnceWith("task_run", "conversation");
  answer({ task: { ...task, summary: "From the read" }, events: [said("e1", 1), said("e3", 3)] });
  await Promise.all([first, again]);
  // History and live steps in the order they happened, each once. The request itself is the read's copy.
  expect(store().taskEvents.task_run?.map(e => e.id)).toEqual(["e1", "e3", "live-only"]);
  expect(store().taskEventScopes).toEqual({ task_run: "conversation" });
  expect(store().tasks[0]!.summary).toBe("From the read");

  // The conversation is already there: nothing to read. Every step is more, so it reads again.
  await initial.loadTaskEvents("task_run", "conversation");
  expect(read).toHaveBeenCalledTimes(1);
  read.mockResolvedValue({ task, events: [said("e1", 1), said("e2", 2), said("e3", 3)] });
  await initial.loadTaskEvents("task_run");
  expect(read).toHaveBeenLastCalledWith("task_run", "all");
  expect(store().taskEvents.task_run?.map(e => e.id)).toEqual(["e1", "e2", "e3", "live-only"]);
  expect(store().taskEventScopes).toEqual({ task_run: "all" });
  // With every step read, neither kind of read is made again.
  await initial.loadTaskEvents("task_run", "conversation");
  await initial.loadTaskEvents("task_run", "all");
  expect(read).toHaveBeenCalledTimes(2);
});

it("doesn't let a slower read of the conversation replace every step, or a read's copy of a request replace a newer one", async () => {
  const { db } = open();
  const task = { ...db.tasks.find(t => t.kind !== "transcribe")!, id: "task_run", state: "running" as const };
  open({ tasks: [task] });
  const answers: Record<string, (response: { task: typeof task; events: TaskEvent[] }) => void> = {};
  vi.spyOn(api, "task").mockImplementation((_id, scope = "all") => new Promise(resolve => { answers[scope] = resolve; }));
  const conversation = initial.loadTaskEvents("task_run", "conversation");
  const all = initial.loadTaskEvents("task_run", "all");
  // The socket says the request finished while both reads are out.
  const finished = { ...task, state: "done" as const };
  initial.applyEvent({ type: "task.updated", projectId: PRJ, task: finished });
  answers.all!({ task, events: [said("e1", 1), said("tool", 2), said("e3", 3)] });
  await all;
  answers.conversation!({ task, events: [said("e1", 1), said("e3", 3)] });
  await conversation;
  expect(store().taskEvents.task_run?.map(e => e.id)).toEqual(["e1", "tool", "e3"]);
  expect(store().taskEventScopes).toEqual({ task_run: "all" });
  expect(store().tasks).toEqual([finished]);
});

it("reads nothing with no project open, and drops steps that arrive after another project was opened", async () => {
  useProjectStore.setState({ current: null });
  const read = vi.spyOn(api, "task");
  await initial.loadTaskEvents("task_run");
  expect(read).not.toHaveBeenCalled();
  const { current } = open();
  let answer!: (response: never) => void;
  read.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
  const lookup = initial.loadTaskEvents("task_run");
  const other = { ...current, id: "prj_other" };
  useProjectStore.setState({ current: other });
  answer({ task: { id: "task_run" }, events: [said("e1", 1)] } as never);
  await lookup;
  expect(useProjectStore.getState().current).toBe(other);
});

it("adds each step the socket sends once, in the order it happened", () => {
  open({ taskEvents: { other_run: [said("o1", 1)] } });
  const step = (event: TaskEvent) => initial.applyEvent({ type: "task.event", projectId: PRJ, taskId: "task_run", event });
  step(said("e1", 1));
  step(said("e3", 3));
  // Sent twice across a reconnect: once is enough.
  step(said("e3", 3));
  // One that was held up arrives after a later one.
  step(said("e2", 2));
  // A step with no id or time can't be told from another: it is kept, at the end.
  step({ type: "log", text: "no id" });
  step({ type: "log", text: "no id" });
  expect(store().taskEvents.task_run?.map(e => e.id ?? e.text)).toEqual(["e1", "e2", "e3", "no id", "no id"]);
  expect(store().taskEvents.other_run).toHaveLength(1);
});

it("applies what the socket says about the open project, and nothing about another", () => {
  const { db, project } = open({ activity: [] });
  const note = { ...db.notes[0]!, projectId: PRJ };
  const change = { ...db.changes[0]!, projectId: PRJ };
  const entry = { id: "act_1", projectId: PRJ, actor: note.author, type: "change.approved", summary: "Approved", data: {}, createdAt: "2026-10-30T12:00:00.000Z" };
  const usage = { runs: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 15, firstAt: null, lastAt: null };
  const preview = { ...db.renders[0]!, id: "rnd_preview", projectId: PRJ, kind: "preview" as const };
  const task = { ...db.tasks[0]!, id: "task_new", projectId: PRJ };
  initial.applyEvent({ type: "note.updated", projectId: PRJ, note });
  initial.applyEvent({ type: "note.updated", projectId: PRJ, note: { ...note, text: "Edited" } });
  initial.applyEvent({ type: "change.updated", projectId: PRJ, change });
  initial.applyEvent({ type: "activity.added", projectId: PRJ, entry });
  initial.applyEvent({ type: "activity.added", projectId: PRJ, entry });
  initial.applyEvent({ type: "activity.added", projectId: PRJ, entry: { ...entry, id: "act_2" } });
  initial.applyEvent({ type: "task.usage", projectId: PRJ, taskId: "task_new", usage });
  initial.applyEvent({ type: "media.previewReady", projectId: PRJ, mediaId: "med_1" });
  initial.applyEvent({ type: "media.previewReady", projectId: PRJ, mediaId: "med_1" });
  initial.applyEvent({ type: "render.updated", projectId: PRJ, render: preview });
  // The stream's own fragments and a request to revise a skill are not the project's to show.
  initial.applyEvent({ type: "render.updated", projectId: PRJ, render: { ...preview, id: "rnd_stream", kind: "playback" } });
  initial.applyEvent({ type: "task.updated", projectId: PRJ, task });
  initial.applyEvent({ type: "task.updated", projectId: PRJ, task: { ...task, id: "task_skill", kind: "skill_edit" } });
  initial.applyEvent({ type: "project.updated", projectId: PRJ, project: { ...project, name: "Renamed" } });
  expect(store()).toMatchObject({
    notes: [{ id: note.id, text: "Edited" }], changes: [change], taskUsage: { task_new: usage }, sourcePreviewRevisions: { med_1: 2 },
    renders: [preview], tasks: [task], project: { name: "Renamed" },
  });
  // Newest first, each entry once.
  expect(store().activity?.map(a => a.id)).toEqual(["act_2", "act_1"]);
  const before = store();
  initial.applyEvent({ type: "note.updated", projectId: "prj_other", note: { ...note, id: "note_other" } });
  initial.applyEvent({ type: "host.updated", host: {} as never });
  expect(store()).toBe(before);
});

it("leaves the activity log alone until it has been opened", () => {
  const { db } = open();
  const entry = { id: "act_1", projectId: PRJ, actor: db.notes[0]!.author, type: "change.approved", summary: "Approved", data: {}, createdAt: "2026-10-30T12:00:00.000Z" };
  initial.applyEvent({ type: "activity.added", projectId: PRJ, entry });
  expect(store().activity).toBeUndefined();
});

it("keeps a speaker's progress as it was when the engine repeats it, so its clock isn't restarted", () => {
  open();
  vi.spyOn(Date, "now").mockReturnValue(1000);
  initial.applyEvent({ type: "media.speakerProgress", projectId: PRJ, active: { med_1: { phase: "segmenting", percent: 40 }, med_2: { phase: "audio" } } });
  const first = store().speakerProgress!;
  expect(first).toEqual({ med_1: { phase: "segmenting", percent: 40, updatedAt: 1000 }, med_2: { phase: "audio", updatedAt: 1000 } });
  vi.mocked(Date.now).mockReturnValue(5000);
  initial.applyEvent({ type: "media.speakerProgress", projectId: PRJ, active: { med_1: { phase: "segmenting", percent: 40 }, med_2: { phase: "models" } } });
  expect(store().speakerProgress!.med_1).toBe(first.med_1);
  expect(store().speakerProgress!.med_2).toEqual({ phase: "models", updatedAt: 5000 });
  // A recording that is done is no longer listed.
  initial.applyEvent({ type: "media.speakerProgress", projectId: PRJ, active: {} });
  expect(store().speakerProgress).toEqual({});
});

it("forgets the list of versions when an edit makes a new one, and keeps it for a change that doesn't", () => {
  const { db } = open();
  const change = { ...db.changes[0]!, projectId: PRJ, toVersion: "v_first" };
  open({ changes: [change], versions: [], historyRevision: 3 });
  initial.applyEvent({ type: "change.updated", projectId: PRJ, change: { ...change, description: "Reworded" } });
  expect(store()).toMatchObject({ versions: [], historyRevision: 3, changes: [{ description: "Reworded" }] });
  initial.applyEvent({ type: "change.updated", projectId: PRJ, change: { ...change, toVersion: "v_second" } });
  expect(store().versions).toBeUndefined();
  expect(store().historyRevision).toBe(4);
});

it("asks for the full renders again when the render settings change", async () => {
  const { project } = open({ renderSettingsRevision: 1 });
  const keys = { context: fullRenderContext(project), preview: "p", delivery: "d" };
  const read = vi.spyOn(api, "renders").mockResolvedValue({ renders: [], fullRenderKeys: keys });
  initial.applyEvent({ type: "render.settings.updated" });
  expect(store().renderSettingsRevision).toBe(2);
  // Until the engine answers, no render is known to match the new settings.
  expect(store().fullRenderKeys).toBeUndefined();
  await vi.waitFor(() => expect(store().fullRenderKeys).toEqual(keys));
  expect(read).toHaveBeenCalledExactlyOnceWith(PRJ, { kind: "full", version: "head" });
});

it("keeps the renders it had when the full renders can't be read, or belong to other settings", async () => {
  const { db, project } = open();
  const full = { ...db.renders.find(r => r.kind === "full")!, projectId: PRJ, version: project.head! };
  open({ renders: [full] });
  const read = vi.spyOn(api, "renders").mockRejectedValue(new Error("engine away"));
  await initial.refreshFullRenders();
  expect(store()).toMatchObject({ renders: [full], fullRenderKeys: undefined });
  read.mockResolvedValue({ renders: [], fullRenderKeys: { context: "another format", preview: "p", delivery: "d" } });
  await initial.refreshFullRenders();
  expect(store()).toMatchObject({ renders: [full], fullRenderKeys: undefined });
  // With no edit yet there is nothing to ask about.
  open({ project: { ...project, head: null } });
  await initial.refreshFullRenders();
  expect(read).toHaveBeenCalledTimes(2);
});

it("picks the render of the working edit that matches the format, done before running, and none when the format changed", () => {
  const { db, project } = open();
  const full = db.renders.find(r => r.kind === "full")!;
  const render = (id: string, extra: Partial<typeof full>) => ({ ...full, id, projectId: PRJ, version: project.head!, range: null, key: "preview-key", state: "done" as const, createdAt: "2026-10-01T00:00:00.000Z", ...extra });
  const keys = { context: fullRenderContext(project), preview: "preview-key", delivery: "delivery-key" };
  const renders = [
    render("running", { state: "running", createdAt: "2026-10-03T00:00:00.000Z" }),
    render("failed", { state: "failed", createdAt: "2026-10-04T00:00:00.000Z" }),
    render("cancelled", { state: "cancelled", createdAt: "2026-10-05T00:00:00.000Z" }),
    render("done", {}),
    render("delivery", { key: "delivery-key", state: "queued" }),
    render("part", { range: { start: 0, end: 4 } }),
    render("old-version", { version: "v_old" }),
    render("other-format", { key: "stale-key" }),
    render("other-project", { projectId: "prj_other" }),
    render("segment", { kind: "segment" }),
  ];
  const data = { ...store(), renders, fullRenderKeys: keys };
  expect(selectHeadRender(data)?.id).toBe("done");
  expect(selectHeadRender(data, "delivery")?.id).toBe("delivery");
  expect(selectHeadRender({ ...data, renders: renders.filter(r => r.id !== "done") }, "preview")?.id).toBe("running");
  expect(selectHeadRender({ ...data, renders: renders.filter(r => !["done", "running"].includes(r.id)) }, "preview")?.id).toBe("failed");
  // The keys are for another format, not read yet, or there is no edit: nothing matches.
  expect(selectHeadRender({ ...data, fullRenderKeys: { ...keys, context: "another format" } })).toBeUndefined();
  expect(selectHeadRender({ ...data, fullRenderKeys: undefined })).toBeUndefined();
  expect(selectHeadRender({ ...data, project: { ...project, head: null } })).toBeUndefined();
  expect(selectHeadRender(null)).toBeUndefined();
});

it("looks up a render it doesn't have once, and leaves a missing one out", async () => {
  const { db } = open();
  const render = { ...db.renders[0]!, id: "rnd_wanted", projectId: PRJ };
  let answer!: (response: { render: typeof render }) => void;
  const read = vi.spyOn(api, "render").mockImplementation(() => new Promise(resolve => { answer = resolve; }));
  const first = initial.ensureRender("rnd_wanted");
  await initial.ensureRender("rnd_wanted");
  expect(read).toHaveBeenCalledExactlyOnceWith("rnd_wanted");
  // The socket delivers a newer copy while the lookup is out: that one stays.
  const newer = { ...render, progress: 0.9 };
  initial.applyEvent({ type: "render.updated", projectId: PRJ, render: newer });
  answer({ render });
  await first;
  expect(store().renders).toEqual([newer]);
  // Already here: not asked for again.
  await initial.ensureRender("rnd_wanted");
  expect(read).toHaveBeenCalledTimes(1);
  read.mockRejectedValue(new Error("no such render"));
  await expect(initial.ensureRender("rnd_gone")).resolves.toBeUndefined();
  expect(store().renders).toEqual([newer]);
  // It can be asked for again later.
  read.mockResolvedValue({ render: { ...render, id: "rnd_gone" } });
  await initial.ensureRender("rnd_gone");
  expect(store().renders.map(r => r.id)).toEqual(["rnd_wanted", "rnd_gone"]);
});

it("keeps a render the socket updated over the answer to the request that started it", async () => {
  const { db } = open();
  const queued = { ...db.renders[0]!, id: "rnd_new", projectId: PRJ, state: "queued" as const };
  const running = { ...queued, state: "running" as const };
  vi.spyOn(api, "requestRender").mockImplementation(async () => {
    initial.applyEvent({ type: "render.updated", projectId: PRJ, render: running });
    return { render: queued };
  });
  await expect(initial.requestRender({ kind: "full" })).resolves.toBe(queued);
  expect(store().renders).toEqual([running]);
  useProjectStore.setState({ current: null });
  await expect(initial.requestRender({ kind: "full" })).rejects.toThrow("No project loaded");
});

it("loads the activity log a page at a time, from the last entry it has", async () => {
  const { db } = open();
  const entry = (n: number) => ({ id: `act_${n}`, projectId: PRJ, actor: db.notes[0]!.author, type: "change.approved", summary: "Approved", data: {}, createdAt: new Date(Date.UTC(2026, 9, 30, 12, 0, 300 - n)).toISOString() });
  const page = Array.from({ length: 200 }, (_, n) => entry(n));
  const read = vi.spyOn(api, "activity").mockResolvedValueOnce({ activity: page }).mockResolvedValueOnce({ activity: [entry(200), entry(201)] });
  await initial.loadActivity();
  expect(read).toHaveBeenLastCalledWith(PRJ, { before: undefined, beforeId: undefined, limit: 200 });
  // A full page means there may be more.
  expect(store()).toMatchObject({ activityComplete: false });
  await initial.loadActivity(true);
  expect(read).toHaveBeenLastCalledWith(PRJ, { before: page[199]!.createdAt, beforeId: "act_199", limit: 200 });
  expect(store().activity).toHaveLength(202);
  expect(store().activity!.at(-1)!.id).toBe("act_201");
  expect(store().activityComplete).toBe(true);
  // Opened again, it starts from the top.
  read.mockResolvedValueOnce({ activity: [entry(0)] });
  await initial.loadActivity();
  expect(store().activity).toEqual([entry(0)]);
});

it("moves to another branch, an earlier version or a restored one, and reads the timeline it now has", async () => {
  const { db, project } = open({ versions: [] });
  const change = { ...db.changes[0]!, projectId: PRJ, toVersion: "v_restored" };
  const moved = { ...project, head: "v_branch", branch: "alt" };
  vi.spyOn(api, "switchBranch").mockResolvedValue({ project: moved });
  const readHead = vi.spyOn(api, "workspace").mockImplementation(async () => ({ project: useProjectStore.getState().current!.project, timeline: null }));
  await initial.switchBranch("alt", "v1");
  expect(api.switchBranch).toHaveBeenCalledExactlyOnceWith(PRJ, "alt", project.head, project.branch ?? "main", "v1");
  expect(store()).toMatchObject({ project: moved, timeline: null, versions: undefined });
  expect(readHead).toHaveBeenCalledTimes(1);

  const restored = { ...moved, head: "v_restored" };
  vi.spyOn(api, "historyEdit").mockResolvedValue({ project: restored, change });
  await initial.historyEdit("v_old", "restore");
  expect(api.historyEdit).toHaveBeenCalledExactlyOnceWith(PRJ, "v_old", "restore", "v_branch", "alt");
  expect(store()).toMatchObject({ project: restored, changes: [change] });

  vi.spyOn(api, "unapproveChange").mockResolvedValue({ change: { ...change, state: "ready" }, project: { ...restored, head: "v_branch" } });
  await initial.unapprove(change.id);
  expect(store()).toMatchObject({ project: { head: "v_branch" }, changes: [{ id: change.id, state: "ready" }] });
  expect(readHead).toHaveBeenCalledTimes(3);

  // With no edit yet there is no version to move from.
  open({ project: { ...project, head: null } });
  await initial.switchBranch("alt");
  await initial.historyEdit("v_old", "revert");
  expect(api.switchBranch).toHaveBeenCalledTimes(1);
  expect(api.historyEdit).toHaveBeenCalledTimes(1);
});

it("shows a rejection at once and takes it back if the engine refuses", async () => {
  const { db } = open();
  const change = { ...db.changes.find(c => c.state === "ready")!, projectId: PRJ };
  open({ changes: [change] });
  let refuse!: (error: Error) => void;
  const send = vi.spyOn(api, "rejectChange").mockImplementation(() => new Promise((_resolve, reject) => { refuse = reject; }));
  const rejecting = initial.reject(change.id, "Too tight");
  expect(store().changes[0]!.state).toBe("rejected");
  refuse(new Error("engine away"));
  await expect(rejecting).rejects.toThrow("engine away");
  expect(store().changes).toEqual([change]);
  const rejected = { ...change, state: "rejected" as const, updatedAt: "2026-10-30T13:00:00.000Z" };
  send.mockResolvedValue({ change: rejected });
  await initial.reject(change.id);
  expect(store().changes).toEqual([rejected]);
  // A change that isn't here is not sent.
  await initial.reject("chg_unknown");
  expect(send).toHaveBeenCalledTimes(2);

  vi.spyOn(api, "reopenChange").mockResolvedValue({ change });
  await initial.reopen(change.id);
  expect(store().changes).toEqual([change]);
});

it("takes an approval back when the engine refuses it, and does nothing for a change it doesn't have", async () => {
  const { db } = open();
  const change = { ...db.changes.find(c => c.state === "ready")!, projectId: PRJ };
  open({ changes: [change] });
  const send = vi.spyOn(api, "approveChange").mockRejectedValue(new Error("The edit moved on"));
  await expect(initial.approve(change.id)).rejects.toThrow("The edit moved on");
  expect(store().changes).toEqual([change]);
  await expect(initial.approve("chg_unknown")).resolves.toBeUndefined();
  expect(send).toHaveBeenCalledTimes(1);
  // Putting cuts back shows nothing until the engine answers.
  let answer!: (response: never) => void;
  send.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
  const restoring = initial.approve(change.id, undefined, [2]);
  expect(store().changes).toEqual([change]);
  const followUp = { ...db.tasks[0]!, id: "task_follow", projectId: PRJ };
  vi.spyOn(api, "workspace").mockResolvedValue({ project: store().project, timeline: store().timeline });
  answer({ change: { ...change, state: "approved" }, project: store().project, task: followUp, outcome: "applied" } as never);
  await restoring;
  expect(store()).toMatchObject({ changes: [{ state: "approved" }], tasks: [followUp] });
});

it("puts a revision's note and request beside the change it revises", async () => {
  const { db } = open();
  const change = { ...db.changes[0]!, projectId: PRJ };
  const note = { ...db.notes[0]!, id: "note_feedback", projectId: PRJ };
  const task = { ...db.tasks[0]!, id: "task_revise", projectId: PRJ, state: "queued" as const };
  open({ changes: [change] });
  const revised = { ...change, state: "revising" as const };
  vi.spyOn(api, "reviseChange").mockResolvedValue({ change: revised, note, task });
  await expect(initial.revise(change.id, { text: "Leave the breath in" })).resolves.toBe(task);
  expect(store()).toMatchObject({ changes: [revised], notes: [note], tasks: [task] });
  // A revision that needs no new run brings none.
  vi.mocked(api.reviseChange).mockResolvedValue({ change: revised, note: { ...note, id: "note_second" } });
  await expect(initial.revise(change.id, { text: "And the next" })).resolves.toBeUndefined();
  expect(store().tasks).toEqual([task]);

  vi.spyOn(api, "change").mockResolvedValue({ change: { ...revised, description: "With its diff" }, diff: { ranges: [] } } as never);
  await expect(initial.loadChangeDiff(change.id)).resolves.toEqual({ ranges: [] });
  expect(store().changes[0]!.description).toBe("With its diff");

  vi.spyOn(api, "importOtio").mockResolvedValue({ change: { ...change, id: "chg_import" } } as never);
  await expect(initial.importFromDavinci({ OTIO_SCHEMA: "Timeline.1" })).resolves.toMatchObject({ id: "chg_import" });
  expect(store().changes.map(c => c.id)).toEqual([change.id, "chg_import"]);
  useProjectStore.setState({ current: null });
  await expect(initial.importFromDavinci({})).rejects.toThrow("No project loaded");
});

it("shows a note's edit at once, takes it back if it fails, and adds replies and voice notes", async () => {
  const { db } = open();
  const note = { ...db.notes[0]!, projectId: PRJ, state: "open" as const };
  open({ notes: [note] });
  let refuse!: (error: Error) => void;
  const send = vi.spyOn(api, "updateNote").mockImplementation(() => new Promise((_resolve, reject) => { refuse = reject; }));
  const updating = initial.updateNote(note.id, { state: "resolved" });
  expect(store().notes[0]).toMatchObject({ state: "resolved", assignedTo: note.assignedTo });
  refuse(new Error("engine away"));
  await expect(updating).rejects.toThrow("engine away");
  expect(store().notes).toEqual([note]);
  send.mockResolvedValue({ note: { ...note, state: "resolved", updatedAt: "2026-10-30T13:00:00.000Z" } });
  await initial.updateNote(note.id, { state: "resolved" });
  expect(store().notes[0]).toMatchObject({ state: "resolved", updatedAt: "2026-10-30T13:00:00.000Z" });
  await initial.updateNote("note_unknown", { state: "resolved" });
  expect(send).toHaveBeenCalledTimes(2);

  vi.spyOn(api, "replyNote").mockResolvedValue({ note: { ...note, text: "With a reply" } });
  await initial.replyNote(note.id, "Agreed");
  expect(store().notes[0]!.text).toBe("With a reply");

  const spoken = { ...note, id: "note_voice" };
  const task = { ...db.tasks[0]!, id: "task_voice", projectId: PRJ };
  vi.spyOn(api, "createVoiceNote").mockResolvedValue({ note: spoken, task });
  await expect(initial.createVoiceNote(PRJ, new Blob(["voice"]), { time: 3 } as never)).resolves.toEqual({ note: spoken, task });
  expect(store()).toMatchObject({ notes: [{ id: note.id }, spoken], tasks: [task] });
});

it("follows a request through stop, retry and finishing when its transcripts are ready", async () => {
  const { db } = open();
  const task = { ...db.tasks.find(t => t.kind !== "transcribe")!, id: "task_run", projectId: PRJ, state: "running" as const };
  open({ tasks: [task] });
  const stopped = { ...task, state: "cancelled" as const };
  vi.spyOn(api, "cancelTask").mockResolvedValue({ task: stopped });
  await initial.cancelTask(task.id);
  expect(store().tasks).toEqual([stopped]);

  // A retry is a new request, and the one it retries points at it.
  const again = { ...task, id: "task_again", state: "queued" as const };
  vi.spyOn(api, "retryTask").mockResolvedValue({ task: again });
  await initial.retryTask(task.id);
  expect(store().tasks).toEqual([{ ...stopped, retryTaskId: "task_again" }, again]);
  // The socket had the new attempt first, already running: it is not added twice or put back in line.
  const running = { ...again, state: "running" as const };
  useProjectStore.setState({ current: { ...store(), tasks: [stopped, running] } });
  await initial.retryTask(task.id);
  expect(store().tasks).toEqual([{ ...stopped, retryTaskId: "task_again" }, running]);

  const waiting = { ...stopped, continueWhenReady: true } as typeof stopped;
  const resumed = { ...task, id: "task_resumed", state: "queued" as const };
  const send = vi.spyOn(api, "continueWhenReady").mockResolvedValue({ task: waiting });
  await initial.continueWhenReady(task.id, true);
  expect(store().tasks[0]).toBe(waiting);
  send.mockResolvedValue({ task: waiting, resumed });
  await initial.continueWhenReady(task.id, true);
  expect(store().tasks.map(t => t.id)).toEqual(["task_run", "task_again", "task_resumed"]);

  // In another project by the time the answer comes: nothing here changes.
  const elsewhere = { ...store(), id: "prj_other" };
  useProjectStore.setState({ current: elsewhere });
  await initial.retryTask(task.id);
  await initial.cancelTask(task.id);
  expect(useProjectStore.getState().current).toBe(elsewhere);
});

it("marks a thread filed or open again as the engine has it", async () => {
  const { project } = open();
  const send = vi.spyOn(api, "setThreadDone").mockResolvedValue({ completedThreads: { thread_a: "rev_1" } } as never);
  await initial.setThreadDone("thread_a", true, "rev_1");
  expect(send).toHaveBeenCalledExactlyOnceWith(PRJ, "thread_a", true, "rev_1");
  expect(store().project.completedThreads).toEqual({ ...project.completedThreads, thread_a: "rev_1" });
  send.mockResolvedValue({ completedThreads: {} } as never);
  await initial.setThreadDone("thread_a", false, "rev_1");
  expect(store().project.completedThreads).toEqual(project.completedThreads ?? {});
  useProjectStore.setState({ current: null });
  await initial.setThreadDone("thread_a", true, "rev_1");
  expect(send).toHaveBeenCalledTimes(2);
});

it("puts a new project first in the library, keeps a renamed one in its place, moves one whose video changed first, and takes a deleted one out", async () => {
  const { db, project } = open();
  const summary = db.summaries[PRJ]!;
  useProjectStore.setState({ list: [summary], listStatus: "ready" });
  const made = { ...project, id: "prj_new", name: "New film" };
  vi.spyOn(api, "createProject").mockResolvedValue({ project: made });
  await expect(initial.createProject({ name: "New film" })).resolves.toBe(made);
  expect(useProjectStore.getState().list.map(p => p.id)).toEqual(["prj_new", PRJ]);
  expect(useProjectStore.getState().list[0]).toMatchObject({ name: "New film", mediaCount: 0, pendingChanges: 0, openNotes: 0, poster: null });

  const renamed = { ...project, name: "Final cut" };
  let answer!: (response: { project: typeof project }) => void;
  vi.spyOn(api, "updateProject").mockImplementation(() => new Promise(resolve => { answer = resolve; }));
  const renaming = initial.updateProject({ name: "Final cut" });
  // The new name shows before the engine answers.
  expect(store().project.name).toBe("Final cut");
  answer({ project: renamed });
  await renaming;
  // A new name isn't an edit: the engine leaves Last edited alone, and the row keeps its time and its place.
  expect(useProjectStore.getState().list).toMatchObject([{ id: "prj_new" }, { id: PRJ, name: "Final cut", updatedAt: summary.updatedAt }]);
  expect(store().project).toBe(renamed);
  // A setting that changes the video is one. The library lists the latest edit first, so the row is there at once
  // and doesn't jump when the list is next read.
  const reframed = { ...renamed, settings: { ...renamed.settings, fps: 24 }, updatedAt: "2026-10-30T13:00:00.000Z" };
  const reframing = initial.updateProject({ settings: { fps: 24 } });
  answer({ project: reframed });
  await reframing;
  expect(useProjectStore.getState().list).toMatchObject([{ id: PRJ, updatedAt: reframed.updatedAt, settings: { fps: 24 } }, { id: "prj_new" }]);

  vi.spyOn(api, "deleteProject").mockResolvedValue(undefined as never);
  await initial.deleteProject("prj_new");
  expect(useProjectStore.getState().list.map(p => p.id)).toEqual([PRJ]);
  expect(useProjectStore.getState().current).not.toBeNull();
  await initial.deleteProject(PRJ);
  expect(useProjectStore.getState()).toMatchObject({ list: [], current: null, status: "idle" });
  // With no project open there is nothing to update.
  await initial.updateProject({ name: "Nobody" });
  expect(api.updateProject).toHaveBeenCalledTimes(2);
});

it("says the library couldn't be loaded, shows loading only when asked to try again, and shares one read", async () => {
  useProjectStore.setState({ list: [], listStatus: "idle", listError: null });
  let refuse!: (error: Error) => void;
  const read = vi.spyOn(api, "projects").mockImplementation(() => new Promise((_resolve, reject) => { refuse = reject; }));
  const loading = initial.loadList();
  expect(useProjectStore.getState().listStatus).toBe("loading");
  expect(initial.loadList()).toBe(loading);
  expect(read).toHaveBeenCalledTimes(1);
  refuse(new Error("engine away"));
  await loading;
  expect(useProjectStore.getState()).toMatchObject({ listStatus: "error", listError: "engine away" });
  // A background refresh after a failure keeps the error on screen; the editor asking again shows loading.
  let answer!: (response: { projects: never[] }) => void;
  read.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
  const refresh = initial.loadList();
  expect(useProjectStore.getState().listStatus).toBe("error");
  void initial.loadList(true);
  expect(useProjectStore.getState().listStatus).toBe("loading");
  expect(read).toHaveBeenCalledTimes(2);
  answer({ projects: [] });
  await refresh;
  expect(useProjectStore.getState()).toMatchObject({ listStatus: "ready", listError: null, list: [] });
});

it("reads the library again when a project was made while a read was out, so the stale answer isn't shown", async () => {
  const { db, project } = open();
  const summary = db.summaries[PRJ]!;
  useProjectStore.setState({ list: [], listStatus: "idle", listError: null });
  let answer!: (response: { projects: typeof summary[] }) => void;
  const made = { ...project, id: "prj_new", name: "New film" };
  const read = vi.spyOn(api, "projects").mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }))
    .mockResolvedValue({ projects: [{ ...summary, id: "prj_new", name: "New film" }, summary] });
  vi.spyOn(api, "createProject").mockResolvedValue({ project: made });
  const loading = initial.loadList();
  await initial.createProject({ name: "New film" });
  // The read that was out answers without the new project.
  answer({ projects: [summary] });
  await loading;
  expect(read).toHaveBeenCalledTimes(2);
  expect(useProjectStore.getState().list.map(p => p.id)).toEqual(["prj_new", PRJ]);
});

it("says a project is in the trash when it can't be opened because it was deleted", async () => {
  useProjectStore.setState({ current: null, status: "idle" });
  const { ScarletApiError } = await import("@scarlet/shared");
  vi.spyOn(api, "workspace").mockRejectedValue(new ScarletApiError(404, "not_found", "No such project"));
  const trashed = { id: PRJ, name: "Old film", deletedAt: "2026-10-01T00:00:00.000Z", purgeAt: "2026-10-31T00:00:00.000Z" };
  const trash = vi.spyOn(api, "trash").mockResolvedValue({ projects: [trashed] } as never);
  await initial.load(PRJ);
  expect(useProjectStore.getState()).toMatchObject({ status: "error", error: "No such project", trashedProject: trashed, current: null });
  // Not in the trash either, or the trash can't be read: it is just an error.
  trash.mockRejectedValue(new Error("engine away"));
  await initial.load(PRJ);
  expect(useProjectStore.getState()).toMatchObject({ status: "error", trashedProject: null });
  // Any other failure doesn't look in the trash.
  vi.mocked(api.workspace).mockRejectedValue(new Error("engine away"));
  await initial.load(PRJ);
  expect(trash).toHaveBeenCalledTimes(2);
  expect(useProjectStore.getState()).toMatchObject({ status: "error", error: "engine away" });
});

it("keeps the open project on screen when reading it again fails, with what the socket said meanwhile", async () => {
  const { db, project } = open({ reviewStatus: "loading" });
  let refuse!: (error: Error) => void;
  vi.spyOn(api, "workspace").mockImplementation(() => new Promise((_resolve, reject) => { refuse = reject; }));
  const reloading = initial.load(PRJ);
  const media = { ...db.media[PRJ]![0]!, id: "med_during", status: "ready" as const };
  initial.applyEvent({ type: "project.updated", projectId: PRJ, project: { ...project, name: "Renamed meanwhile" } });
  initial.upsertMedia(PRJ, media);
  refuse(new Error("engine away"));
  await reloading;
  expect(useProjectStore.getState()).toMatchObject({ status: "error", error: "engine away" });
  expect(store()).toMatchObject({ project: { name: "Renamed meanwhile" }, reviewStatus: "error", reviewError: "engine away" });
  expect(store().media.map(m => m.id)).toContain("med_during");
});

/** The engine answering every read of the sample project. A test makes the read it is about fail. */
function answering(project: ProjectData["project"]) {
  const snapshot = vi.spyOn(api, "workspace").mockResolvedValue({ project, timeline: null });
  vi.spyOn(api, "changes").mockResolvedValue({ changes: [] });
  vi.spyOn(api, "notes").mockResolvedValue({ notes: [] });
  const requests = vi.spyOn(api, "tasks").mockResolvedValue({ tasks: [] });
  return { snapshot, requests };
}

it("reads the open project again by itself when reading it anew failed with nothing on screen to say so, a few times and then no more", async () => {
  vi.useFakeTimers();
  const { db, project } = open();
  const task = { ...db.tasks.find(t => t.kind !== "transcribe")!, id: "task_run", projectId: PRJ, state: "running" as const };
  open({ tasks: [task] });
  const { snapshot, requests } = answering(project);
  // The socket is back before the engine answers: the requests can't be read, and the run finished while it was away.
  requests.mockRejectedValue(new Error("engine away"));
  await initial.load(PRJ);
  // The project is on screen as it was, with no error and no Retry to press.
  expect(store().reviewStatus).toBeUndefined();
  expect(store().tasks).toMatchObject([{ id: "task_run", state: "running" }]);
  requests.mockResolvedValue({ tasks: [{ ...task, state: "done" }] });
  await vi.advanceTimersByTimeAsync(999);
  expect(snapshot).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(store().tasks).toMatchObject([{ id: "task_run", state: "done" }]);
  expect(snapshot).toHaveBeenCalledTimes(2);
  // Read whole: there is nothing left to try.
  expect(vi.getTimerCount()).toBe(0);

  // An engine that stays away is asked again after 1, 2, 4 and 8 seconds, and then left alone.
  requests.mockRejectedValue(new Error("engine away"));
  snapshot.mockClear();
  await initial.load(PRJ);
  for (const [wait, reads] of [[1000, 2], [2000, 3], [4000, 4], [8000, 5]] as const) {
    await vi.advanceTimersByTimeAsync(wait - 1);
    expect(snapshot).toHaveBeenCalledTimes(reads - 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(snapshot).toHaveBeenCalledTimes(reads);
  }
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(snapshot).toHaveBeenCalledTimes(5);

  // A project that can't be read at all stays on screen the same way, and is read again the same way.
  snapshot.mockRejectedValueOnce(new Error("engine away"));
  requests.mockResolvedValue({ tasks: [{ ...task, state: "done" }] });
  await initial.load(PRJ);
  expect(useProjectStore.getState()).toMatchObject({ status: "error", error: "engine away" });
  expect(store().reviewStatus).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1000);
  expect(useProjectStore.getState()).toMatchObject({ status: "ready", error: null });
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps one try at reading the project again waiting at most, and drops it when anything else reads the project, another opens or it closes", async () => {
  vi.useFakeTimers();
  const { project } = open();
  const { snapshot, requests } = answering(project);
  requests.mockRejectedValue(new Error("engine away"));
  await initial.load(PRJ);
  expect(vi.getTimerCount()).toBe(1);
  // The socket comes back once more: its read drops the wait as it starts, and when it fails too it leaves its own.
  const again = initial.load(PRJ);
  expect(vi.getTimerCount()).toBe(0);
  await again;
  expect(vi.getTimerCount()).toBe(1);
  // A read that fails after a later one began is out of date: the later read's wait stays as it is, and its try goes ahead.
  let refuse!: (error: Error) => void;
  requests.mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject; }));
  const earlier = initial.load(PRJ);
  await vi.advanceTimersByTimeAsync(0);
  await initial.load(PRJ);
  refuse(new Error("engine away"));
  await earlier;
  expect(vi.getTimerCount()).toBe(1);
  snapshot.mockClear();
  await vi.advanceTimersByTimeAsync(1000);
  expect(snapshot).toHaveBeenCalledTimes(1);

  // Another project is opened: the first is not read again.
  requests.mockResolvedValue({ tasks: [] });
  await initial.load("prj_other");
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(snapshot).toHaveBeenLastCalledWith("prj_other");

  // The project is closed.
  requests.mockRejectedValue(new Error("engine away"));
  open();
  await initial.load(PRJ);
  expect(vi.getTimerCount()).toBe(1);
  vi.spyOn(api, "deleteProject").mockResolvedValue(undefined as never);
  await initial.deleteProject(PRJ);
  expect(vi.getTimerCount()).toBe(0);

  // A failure that is on screen has Retry beside it: trying again is the editor's.
  open({ reviewStatus: "error", reviewError: "history unavailable" });
  await initial.load(PRJ);
  expect(store().reviewStatus).toBe("error");
  expect(vi.getTimerCount()).toBe(0);
  useProjectStore.setState({ current: null, status: "idle" });
  await initial.load(PRJ);
  expect(store().reviewStatus).toBe("error");
  expect(vi.getTimerCount()).toBe(0);

  // Putting the store back, as after every test here, closes the project: no wait is left for the next test.
  open();
  await initial.load(PRJ);
  expect(vi.getTimerCount()).toBe(1);
  useProjectStore.setState(initial, true);
  expect(vi.getTimerCount()).toBe(0);
});

it("doesn't follow a project again by reading it again, so one the editor has left stays left", async () => {
  vi.useFakeTimers();
  let socket!: TestSocket;
  class TestSocket {
    static OPEN = 1;
    readyState = 0;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    send = vi.fn();
    close = vi.fn();
    constructor() { socket = this; }
  }
  vi.stubGlobal("WebSocket", TestSocket);
  const { project } = open();
  const { snapshot, requests } = answering(project);
  requests.mockRejectedValue(new Error("engine away"));
  const stop = startRealtime();
  try {
    socket.readyState = TestSocket.OPEN;
    socket.onopen!();
    const reading = initial.load(PRJ);
    socket.onmessage!({ data: JSON.stringify({ type: "project.subscribed", projectId: PRJ, found: true }) });
    await reading;
    expect(socket.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: "subscribe", projectId: PRJ }));
    // The editor goes back to the library while a try is waiting. The store isn't told, so the tries go on,
    // and none of them asks the engine for the project's events again.
    leaveProject(PRJ);
    socket.send.mockClear();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(socket.send).not.toHaveBeenCalled();
    expect(snapshot).toHaveBeenCalledTimes(5);
  } finally {
    leaveProject(PRJ);
    stop();
    vi.unstubAllGlobals();
  }
});

it("opens with the history marked unread when it can't be read, and fills in token counts when they arrive", async () => {
  useProjectStore.setState({ current: null, status: "idle" });
  const { project } = open();
  useProjectStore.setState({ current: null });
  vi.spyOn(api, "workspace").mockResolvedValue({ project, timeline: null });
  vi.spyOn(api, "changes").mockRejectedValue(new Error("history unavailable"));
  vi.spyOn(api, "notes").mockResolvedValue({ notes: [] });
  vi.spyOn(api, "tasks").mockResolvedValue({ tasks: [] });
  const totals = { runs: 2, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 15, firstAt: null, lastAt: null };
  vi.spyOn(api, "projectUsage").mockImplementation(async () => {
    // The socket reports a newer total for one request while the totals are read.
    initial.applyEvent({ type: "task.usage", projectId: PRJ, taskId: "task_live", usage: { ...totals, runs: 9 } });
    return { groups: [{ key: "task_a", ...totals }, { key: "task_live", ...totals }, { key: "", ...totals }] } as never;
  });
  await initial.load(PRJ);
  expect(useProjectStore.getState().status).toBe("ready");
  expect(store()).toMatchObject({ reviewStatus: "error", reviewError: "history unavailable" });
  await vi.waitFor(() => expect(store().taskUsage).toEqual({ task_a: totals, task_live: { ...totals, runs: 9 } }));
});

it("reads the versions once, and not into a project whose edit moved on meanwhile", async () => {
  const { project } = open();
  let answer!: (response: { versions: never[] }) => void;
  const read = vi.spyOn(api, "versions").mockImplementation(() => new Promise(resolve => { answer = resolve; }));
  const first = initial.loadVersions();
  const again = initial.loadVersions();
  expect(read).toHaveBeenCalledTimes(1);
  useProjectStore.setState({ current: { ...store(), project: { ...project, head: "moved-on" } } });
  answer({ versions: [] });
  await Promise.all([first, again]);
  expect(store().versions).toBeUndefined();
  read.mockResolvedValue({ versions: [] });
  await initial.loadVersions();
  expect(store().versions).toEqual([]);
  // Already read: not asked for again.
  await initial.loadVersions();
  expect(read).toHaveBeenCalledTimes(2);
});

it("drops a file that was taken out of the project, on the engine's answer and when the engine says so by itself", async () => {
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  const [first, second, third] = db.media[PRJ]!.map(m => m.id);
  useProjectStore.setState({ current: { id: PRJ, project, timeline: null, media: db.media[PRJ]!, changes: [], notes: [], tasks: [], renders: [], taskEvents: {} } });
  const files = () => useProjectStore.getState().current!.media.map(m => m.id);
  initial.applyEvent({ type: "media.removed", projectId: PRJ, mediaId: first! });
  expect(files()).toEqual([second, third]);
  // Refused, the file stays and the reason goes to whoever asked.
  const remove = vi.spyOn(api, "removeMedia").mockRejectedValueOnce(new Error("It is in the video."));
  await expect(initial.removeMedia(second!)).rejects.toThrow("It is in the video.");
  expect(files()).toEqual([second, third]);
  remove.mockResolvedValueOnce({});
  await initial.removeMedia(second!);
  expect(remove).toHaveBeenLastCalledWith(PRJ, second);
  expect(files()).toEqual([third]);
});

it("keeps the timeline it has when the project is read again and the video hasn't changed, so the player doesn't reopen its stream", async () => {
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  const timeline = db.timelines[project.head!]!;
  useProjectStore.setState({ status: "ready", current: { id: PRJ, project, timeline,
    media: project.media, changes: [], notes: [], tasks: [], renders: [], taskEvents: {} } });
  vi.spyOn(api, "changes").mockResolvedValue({ changes: [] });
  vi.spyOn(api, "notes").mockResolvedValue({ notes: [] });
  vi.spyOn(api, "tasks").mockResolvedValue({ tasks: [] });
  // A reconnect reads the same version again: the same content, as a new object.
  const read = vi.spyOn(api, "workspace").mockResolvedValue({ project, timeline: structuredClone(timeline) });
  await initial.load(PRJ);
  expect(useProjectStore.getState().current!.timeline).toBe(timeline);
  await initial.refreshHead(PRJ);
  expect(useProjectStore.getState().current!.timeline).toBe(timeline);
  // A new version takes its place.
  const moved = { ...structuredClone(timeline), version: "moved-on" };
  read.mockResolvedValue({ project: { ...project, head: "moved-on" }, timeline: moved });
  await initial.load(PRJ);
  expect(useProjectStore.getState().current!.timeline).toBe(moved);
});
