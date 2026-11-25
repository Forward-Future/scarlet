// @vitest-environment happy-dom
import { clock } from "../../lib/format";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildThreads, threadEditList, type VersionSummary } from "@scarlet/shared";
import { api } from "../../lib/client";
import { buildDb, PRJ } from "../../lib/mock/fixtures";
import { useProjectStore, type ProjectData } from "../../stores/project";
import { addInstruction, rejectInstruction, ThreadAction, ThreadEdits } from "./ThreadEdits";
import { revisionWord, useThreadEdits } from "./threadEditState";
import type { Thread, ThreadEdit } from "@scarlet/shared";

let root: Root;
let container: HTMLDivElement;
let data: ProjectData;
const initialStore = useProjectStore.getState();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  data = {
    id: PRJ, project, timeline: db.timelines[project.head!]!, media: project.media, changes: db.changes, notes: db.notes,
    renders: [], tasks: db.tasks, taskEvents: db.taskEvents, versions: db.versions[PRJ]!,
  };
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useProjectStore.setState(initialStore, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const click = (element: Element) => act(async () => (element as HTMLElement).click());
const menuItems = () => [...container.querySelectorAll('[role="menuitem"]')].map(item => item.textContent?.trim());

it("asks for the versions again when the head moved while they were on their way, so Undo these edits comes back", async () => {
  const thread = buildThreads(data).find(t => t.changes.some(c => c.id === "chg_approved_2"))!;
  // The working cut after an undo elsewhere: a new head on top of this thread's version.
  const moved = { ...data.project, head: "ver_4" };
  const after: VersionSummary[] = [...data.versions!.map(v => ({ ...v, isHead: false })),
    { version: "ver_4", parent: "ver_3", name: "Main", changeId: null, description: "Undo · Trim the pause", duration: 16, isHead: true, createdAt: new Date().toISOString() }];
  let deliver!: (list: { versions: VersionSummary[] }) => void;
  const asked = vi.spyOn(api, "versions").mockImplementationOnce(() => new Promise(resolve => { deliver = resolve; }))
    .mockResolvedValue({ versions: after });
  vi.spyOn(api, "workspace").mockResolvedValue({ project: moved, timeline: { ...data.timeline!, version: "ver_4" } });
  // The list isn't loaded yet, so the menu's lookup is on its way when the head moves.
  useProjectStore.setState({ current: { ...data, versions: undefined }, status: "ready" });
  await act(async () => root.render(<ThreadAction projectId={PRJ} thread={thread} edits={threadEditList(thread)} onPlay={() => {}} />));
  expect(asked).toHaveBeenCalledTimes(1);
  await act(() => useProjectStore.getState().refreshHead(PRJ));
  // The store drops the list that was asked for under the old head, and leaves it unset.
  await act(async () => deliver({ versions: data.versions! }));
  expect(asked).toHaveBeenCalledTimes(2);
  expect(useProjectStore.getState().current!.versions).toEqual(after);
  await click(container.querySelector('[aria-label="More for this thread"]')!);
  expect(menuItems()).toEqual(["Undo these edits", "File this thread"]);
});

it("undoes every applied change in the thread from its menu, newest first, and files the thread", async () => {
  const thread = buildThreads(data).find(t => t.changes.some(c => c.id === "chg_approved_2"))!;
  const historyEdit = vi.fn().mockResolvedValue(undefined), setThreadDone = vi.fn().mockResolvedValue(undefined);
  useProjectStore.setState({ current: data, status: "ready", historyEdit, setThreadDone });
  await act(async () => root.render(<ThreadAction projectId={PRJ} thread={thread} edits={threadEditList(thread)} onPlay={() => {}} />));
  const item = (text: string) => [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(i => i.textContent?.trim() === text)!;
  await click(container.querySelector('[aria-label="More for this thread"]')!);
  await click(item("Undo these edits"));
  const applied = thread.changes.filter(c => c.state === "approved").map(c => c.appliedVersion ?? c.toVersion).reverse();
  expect(historyEdit.mock.calls).toEqual(applied.map(version => [version, "revert"]));
  await click(container.querySelector('[aria-label="More for this thread"]')!);
  await click(item("File this thread"));
  expect(setThreadDone).toHaveBeenCalledWith(thread.id, true, expect.any(String));
});

it("leaves the menu out where it is turned off, and still says what it reported", async () => {
  const thread = buildThreads(data).find(t => t.changes.some(c => c.id === "chg_approved_2"))!;
  useProjectStore.setState({ current: data, status: "ready" });
  await act(async () => root.render(<ThreadAction projectId={PRJ} thread={thread} edits={threadEditList(thread)} onPlay={() => {}} menuOnly menu={false} />));
  // With nothing to report there is nothing at all.
  expect(container.innerHTML).toBe("");
  // A thread filed earlier still says so.
  const filed = { ...data, project: { ...data.project, completedThreads: { [thread.id]: JSON.stringify([thread.tasks.at(-1)?.id, thread.changes.at(-1)?.id, thread.updatedAt]) } } };
  await act(async () => { useProjectStore.setState({ current: filed }); });
  expect(container.textContent).toBe("Filed");
});

it("reads a request's edits again for a new working cut only while they are needed, and keeps the last ones meanwhile", async () => {
  const thread = buildThreads(data).find(t => t.changes.some(c => c.id === "chg_approved_2"))!;
  const [first, ...rest] = threadEditList(thread) as ThreadEdit[];
  expect(rest.length).toBeGreaterThan(0);
  const read = vi.spyOn(api, "threadEdits").mockImplementation(async () =>
    ({ version: useProjectStore.getState().current!.project.head!, edits: useProjectStore.getState().current!.project.head === "ver_4" ? [first!, ...rest] : [first!] }));
  let shown: number[] = [];
  let current = false;
  function Probe({ thread, needed }: { thread: Thread; needed: boolean }) {
    const { listed, located } = useThreadEdits(PRJ, thread, needed);
    shown.push(listed.length);
    current = !!located;
    return null;
  }
  useProjectStore.setState({ current: data, status: "ready" });
  // Out of view from the start, the list is still read once.
  await act(async () => root.render(<Probe thread={thread} needed={false} />));
  expect(read).toHaveBeenCalledOnce();
  expect(shown.at(-1)).toBe(1);
  // A new working cut: out of view, nothing is read, and the list it had stays.
  shown = [];
  await act(async () => { useProjectStore.setState({ current: { ...data, project: { ...data.project, head: "ver_4" } } }); });
  expect(read).toHaveBeenCalledOnce();
  expect(shown).not.toContain(0);
  expect(shown.at(-1)).toBe(1);
  // The list it kept isn't the engine's for this working cut, so nothing on the timeline is placed from it.
  expect(current).toBe(false);
  // Back in view, it is read for the working cut it is on.
  await act(async () => root.render(<Probe thread={thread} needed />));
  expect(read).toHaveBeenCalledTimes(2);
  expect(shown.at(-1)).toBe(1 + rest.length);
  expect(current).toBe(true);
  // In view, each new working cut is read at once.
  await act(async () => { useProjectStore.setState({ current: { ...data, project: { ...data.project, head: "ver_5" } } }); });
  expect(read).toHaveBeenCalledTimes(3);
  // Out of view again, a change to the request's own edits is still read: only a new working cut is waited out.
  await act(async () => root.render(<Probe thread={thread} needed={false} />));
  expect(read).toHaveBeenCalledTimes(3);
  const changed = { ...thread, changes: thread.changes.map((c, i) => i ? c : { ...c, appliedVersion: "ver_5" }) };
  await act(async () => root.render(<Probe thread={changed} needed={false} />));
  expect(read).toHaveBeenCalledTimes(4);
});

it("words the request to reject one edit by its time and name", () => {
  expect(rejectInstruction({ time: 62, label: "captions" })).toBe("The editor rejected the edit at 1:02, “captions”. Put back exactly what it changed and leave every other edit as it is.");
  expect(rejectInstruction({ label: "captions" })).toMatch(/^The editor rejected “captions”\. /);
  expect(rejectInstruction({})).toMatch(/^The editor rejected this edit\. /);
});

it("labels queued revisions Up next when next in line, Queued otherwise, and Revising…/Rejecting… once active", () => {
  expect(revisionWord(undefined)).toBeUndefined();
  expect(revisionWord({ id: "t1", state: "queued" }, { nextQueuedId: "t1" })).toBe("Up next");
  expect(revisionWord({ id: "t2", state: "queued" }, { nextQueuedId: "t1" })).toBe("Queued");
  expect(revisionWord({ id: "t1", state: "queued" })).toBe("Queued");
  expect(revisionWord({ id: "t1", state: "queued" }, { rejecting: true, nextQueuedId: "t1" })).toBe("Up next");
  expect(revisionWord({ id: "t1", state: "claimed" }, { nextQueuedId: "t1" })).toBe("Revising…");
  expect(revisionWord({ id: "t1", state: "running" })).toBe("Revising…");
  expect(revisionWord({ id: "t1", state: "running" }, { rejecting: true })).toBe("Rejecting…");
  expect(revisionWord({ id: "t1", state: "running" }, { adding: true })).toBe("Adding…");
  expect(revisionWord({ id: "t1", state: "queued" }, { adding: true })).toBe("Queued");
});

it("says Needs your answer, not Revising…, while the request about a cut or edit waits on the editor's answer", () => {
  expect(revisionWord({ id: "t1", state: "waiting_for_user" })).toBe("Needs your answer");
  // Whatever the request was, it is the editor's turn; answered, Scarlet is on it again.
  expect(revisionWord({ id: "t1", state: "waiting_for_user" }, { rejecting: true, nextQueuedId: "t1" })).toBe("Needs your answer");
  expect(revisionWord({ id: "t1", state: "running" })).toBe("Revising…");
});

it("ends an edit's row on Needs your answer in amber, its time amber and still, while its revision asks the editor something", async () => {
  const base = buildThreads(data).find(t => t.changes.some(c => c.id === "chg_approved_2"))!;
  const edits = threadEditList(base) as ThreadEdit[];
  const asked = (state: "running" | "waiting_for_user") => ({ ...base, tasks: [...base.tasks,
    { ...data.tasks[0]!, id: "task_ask", state, context: { changeId: edits[1]!.changeId, editIndex: edits[1]!.spot, threadId: base.id } }] }) as Thread;
  useProjectStore.setState({ current: data, status: "ready" });
  const row = () => container.querySelectorAll<HTMLElement>(".simple-edit")[1]!;
  const reads = () => [row().querySelector(".edit-row-time")!.className, row().querySelector(".simple-edit-check")!.textContent, row().querySelector(".simple-edit-check")!.className, row().getAttribute("aria-label")];
  await act(async () => root.render(<ThreadEdits projectId={PRJ} thread={asked("running")} edits={edits} onPlay={() => {}} />));
  expect(reads()).toEqual(["edit-row-time simple-pass-time", "Revising…", "simple-edit-check is-kept working-text", expect.stringMatching(/, revising$/)]);
  await act(async () => root.render(<ThreadEdits projectId={PRJ} thread={asked("waiting_for_user")} edits={edits} onPlay={() => {}} />));
  expect(reads()).toEqual(["edit-row-time simple-pass-time is-need", "Needs your answer", "simple-edit-check", expect.stringMatching(/, needs your answer$/)]);
});

it("leads every row with its time, never a number, and keeps a rejected row where it was, with a ×", async () => {
  const thread = buildThreads(data).find(t => t.changes.some(c => c.id === "chg_approved_2"))!;
  const [first, second, third] = threadEditList(thread) as ThreadEdit[];
  useProjectStore.setState({ current: data, status: "ready" });
  const reads = () => [...container.querySelectorAll(".simple-edit")].map(row => [row.querySelector(".edit-row-time")?.textContent ?? "×", row.querySelector(".simple-edit-title")!.textContent]);
  const [one, two, three] = [first!, second!, third!].map(edit => clock(edit.range.start));
  await act(async () => root.render(<ThreadEdits projectId={PRJ} thread={thread} edits={[first!, second!, third!]} onPlay={() => {}} />));
  expect(reads()).toEqual([[one, first!.label], [two, second!.label], [three, third!.label]]);
  expect(container.querySelector(".simple-edits .edit-badge:not(.is-rejected)")).toBeNull();
  // The engine's put-back stands where the edit was: a new change's row, which replaced the edit it took out.
  const gone = (edit: ThreadEdit): ThreadEdit => ({ ...edit, changeId: "chg_back", spot: 0, previous: [{ changeId: edit.changeId, spot: edit.spot }], rejected: true });
  await act(async () => root.render(<ThreadEdits projectId={PRJ} thread={thread} edits={[first!, third!]} rejected={[gone(second!)]} onPlay={() => {}} />));
  expect(reads()).toEqual([[one, first!.label], ["×", second!.label], [three, third!.label]]);
  // The first one rejected, at the very time the second starts or not: the others keep their times.
  await act(async () => root.render(<ThreadEdits projectId={PRJ} thread={thread} edits={[second!, third!]} rejected={[gone({ ...first!, range: second!.range })]} onPlay={() => {}} />));
  expect(reads()).toEqual([["×", first!.label], [two, second!.label], [three, third!.label]]);
  // The last one rejected leaves the rest as they were, and its row at the end.
  await act(async () => root.render(<ThreadEdits projectId={PRJ} thread={thread} edits={[first!, second!]} rejected={[gone(third!)]} onPlay={() => {}} />));
  expect(reads()).toEqual([[one, first!.label], [two, second!.label], ["×", third!.label]]);
});

it("words the request to add a to-do with what it asks for", () => {
  expect(addInstruction("Add the other boat renders")).toBe("The editor asked you to add what this to-do asks for: “Add the other boat renders”. Make or find it, put it in the video at this spot, and mark the to-do resolved.");
  expect(addInstruction()).toMatch(/^The editor asked you to add what this to-do asks for\. /);
});

it("scrolls the selected edit row into view across stepping, tab switches, and rejected rows", async () => {
  const thread = buildThreads(data).find(t => t.changes.some(c => c.id === "chg_approved_2"))!;
  const base = threadEditList(thread) as ThreadEdit[];
  const edits: ThreadEdit[] = base.map((e, i) => i === 1 ? { ...e, check: "Check the pacing." } : e);
  const rejected: ThreadEdit[] = [{ ...edits[0]!, spot: 99, label: "removed cut", range: { start: 10, end: 11 }, rejected: true, wasCheck: true }];
  useProjectStore.setState({ current: data, status: "ready" });
  const scrolled: Element[] = [];
  const orig = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
  try {
    await act(async () => root.render(<ThreadEdits projectId={PRJ} thread={thread} edits={edits} rejected={rejected} showing={edits[1]} only={e => !!e.check || !!e.wasCheck} onPlay={() => {}} />));
    expect(scrolled).toHaveLength(1);
    expect(scrolled.at(-1)?.textContent).toContain(edits[1]!.label);

    // Switching from For you to See all with the same edit selected scrolls it back into view in the full list.
    await act(async () => root.render(<ThreadEdits projectId={PRJ} thread={thread} edits={edits} rejected={rejected} showing={edits[1]} onPlay={() => {}} />));
    expect(scrolled).toHaveLength(2);
    expect(scrolled.at(-1)?.textContent).toContain(edits[1]!.label);

    // Selecting a rejected row also scrolls that row into view.
    await act(async () => root.render(<ThreadEdits projectId={PRJ} thread={thread} edits={edits} rejected={rejected} showing={rejected[0]} onPlay={() => {}} />));
    expect(scrolled).toHaveLength(3);
    expect(scrolled.at(-1)?.textContent).toContain("removed cut");
  } finally {
    if (orig) Object.defineProperty(Element.prototype, "scrollIntoView", orig);
    else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
});
