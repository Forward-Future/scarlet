// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildThreads, threadEditList, type VersionSummary } from "@scarlet/shared";
import { api } from "../../lib/client";
import { buildDb, PRJ } from "../../lib/mock/fixtures";
import { useProjectStore, type ProjectData } from "../../stores/project";
import { NO_AGENT_REASON } from "../agent/AgentChip";
import { useHostsStore } from "../../stores/hosts";
import { ThreadAction, UndoEdit, undoInstruction } from "./ThreadEdits";

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

it("words the request to undo one edit by its number and name, and by neither when it has none", () => {
  expect(undoInstruction({ editNumber: 2, label: "captions" })).toBe("Undo edit 2, “captions”. Put back exactly what this edit changed and leave every other edit as it is.");
  expect(undoInstruction({ label: "captions" })).toMatch(/^Undo “captions”\. /);
  expect(undoInstruction({ editNumber: 3 })).toMatch(/^Undo edit 3\. /);
  expect(undoInstruction({})).toMatch(/^Undo this edit\. /);
});

it("says why Undo edit can't be sent when no agent can take it, and sends nothing", async () => {
  const hosts = useHostsStore.getState();
  useHostsStore.setState({ hosts: [] });
  const createTask = vi.fn();
  useProjectStore.setState({ current: data, status: "ready", createTask });
  const thread = buildThreads(data).find(t => t.changes.some(c => c.id === "chg_approved_2"))!;
  const onSent = vi.fn();
  await act(async () => root.render(<UndoEdit projectId={PRJ} thread={thread} onSent={onSent}
    target={{ changeId: "chg_approved_2", editIndex: 1, editNumber: 2, time: 0.2, end: 2.4, clipIds: [], label: "captions" }} />));
  const undo = container.querySelector("button")!;
  // A small icon, named for screen readers and, with its key, on hover.
  expect([undo.textContent, undo.getAttribute("aria-label"), undo.title, undo.getAttribute("aria-keyshortcuts")]).toEqual(["", "Undo edit", "Undo edit (U)", "U"]);
  expect(undo.querySelector("svg")).not.toBeNull();
  await click(undo);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(NO_AGENT_REASON);
  expect(createTask).not.toHaveBeenCalled();
  expect(onSent).not.toHaveBeenCalled();
  expect(undo.disabled).toBe(false);
  await act(async () => useHostsStore.setState(hosts, true));
});
