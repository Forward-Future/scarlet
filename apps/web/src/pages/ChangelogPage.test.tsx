// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VersionSummary } from "@scarlet/shared";
import type { Change } from "@scarlet/timeline";
import { api } from "../lib/client";
import { buildDb, PRJ } from "../lib/mock/fixtures";
import { useProjectStore, type ProjectData } from "../stores/project";
import { ChangelogPage } from "./ChangelogPage";

let root: Root;
let container: HTMLDivElement;
let data: ProjectData;
const initialStore = useProjectStore.getState();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  data = {
    id: PRJ, project, timeline: db.timelines[project.head!]!, media: project.media, changes: db.changes, notes: db.notes,
    renders: [], tasks: db.tasks, taskEvents: db.taskEvents, versions: db.versions[PRJ]!,
  };
  useProjectStore.setState({ current: data, status: "ready" });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useProjectStore.setState(initialStore, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const show = () => act(async () => root.render(<ChangelogPage />));
const click = (element: Element) => act(async () => (element as HTMLElement).click());
const row = (version: string) => container.querySelector<HTMLElement>(`li[data-version="${version}"]`)!;
const shownVersions = () => [...container.querySelectorAll<HTMLElement>("li[data-version]")].map(li => li.dataset.version);
const opener = (version: string) => row(version).querySelector<HTMLButtonElement>("button.version-row");
const count = (version: string) => row(version).querySelector(".version-edits-head")?.textContent;
/** Each listed edit of an open version: its time, its name, and what it says on the right. */
const listed = (version: string) => [...row(version).querySelectorAll(".version-edits li")].map(li => [
  li.querySelector(".version-edit-time")?.textContent, li.querySelector(".version-edit-label")?.firstChild?.textContent,
  li.querySelector(".version-edit-value")?.textContent]);
const revisionNotes = (version: string) => [...row(version).querySelectorAll(".version-edit-label small")].map(note => note.textContent);

/** The version an applied change leaves on top of `parent`. */
function versionOf(change: Change, parent: string, more: Partial<VersionSummary> = {}): VersionSummary {
  return { version: change.toVersion, parent, name: "Main", author: change.author, changeId: change.id, description: change.description,
    duration: 16, isHead: true, createdAt: change.createdAt, ...more };
}

/** Apply a change on top of the head, newer than every version so far: its version joins the list and becomes the head. */
function apply(id: string, version: string, more: Partial<Change>) {
  const head = data.project.head!;
  const at = new Date(Date.now() + data.versions!.length * 1000).toISOString();
  const change: Change = { ...data.changes.find(c => c.id === "chg_approved_2")!, id, fromVersion: head, toVersion: version, description: id,
    timelineEdits: undefined, taskId: undefined, createdAt: at, updatedAt: at, ...more };
  data = { ...data, project: { ...data.project, head: version }, changes: [...data.changes, change],
    versions: [...data.versions!, versionOf(change, head, change.revertsVersion ? { revertsVersion: change.revertsVersion } : {})] };
  useProjectStore.setState({ current: data });
  return change;
}

it("counts an edit made in several places as one edit with its count of places, as the chat does", async () => {
  apply("chg_places", "ver_4", { timelineEdits: [
    { label: "Camera full screen", range: { start: 0, end: 2 } }, { label: "Zoom in on the chart", range: { start: 3, end: 4 } },
    { label: "Camera full screen", range: { start: 5, end: 6 } }, { label: "Camera full screen", range: { start: 8, end: 9 } },
  ] });
  await show();
  await click(opener("ver_4")!);
  expect(count("ver_4")).toBe("2 edits");
  expect(listed("ver_4")).toEqual([["0:00", "Camera full screen", "3 places"], ["0:03", "Zoom in on the chart", undefined]]);
});

it("names the edit a revision replaced by its place in the change, not by where it falls in time", async () => {
  // The earlier change's first edit is the later one in time, so the list in time order starts with the other.
  apply("chg_framing", "ver_4", { threadId: "thr_framing", timelineEdits: [
    { label: "Late edit", range: { start: 10, end: 12 } }, { label: "Early edit", range: { start: 1, end: 2 } },
  ] });
  apply("chg_revision", "ver_5", { threadId: "thr_framing", timelineEdits: [
    { label: "Late edit, tighter", range: { start: 10, end: 11.5 }, replaces: { changeId: "chg_framing", spot: 0 } },
  ] });
  await show();
  await click(opener("ver_5")!);
  expect(count("ver_5")).toBe("1 edit");
  expect(revisionNotes("ver_5")).toEqual(["Revises “Late edit”"]);
  await click(opener("ver_4")!);
  expect(listed("ver_4").map(([, label]) => label)).toEqual(["Early edit", "Late edit"]);
  expect(revisionNotes("ver_4")).toEqual(["Revised later: “Late edit, tighter”"]);
});

it("makes a version a button only when it has edits to list", async () => {
  // Under the fixture's versions sits the empty timeline the project began with, and on top an undo of the newest.
  data = { ...data, versions: [...data.versions!.map(v => v.version === "ver_1" ? { ...v, parent: "ver_0" } : v),
    { version: "ver_0", parent: null, name: "Main", changeId: null, description: "Empty timeline", duration: 0, isHead: false, createdAt: new Date(0).toISOString() }] };
  // The undo put back three places, as the undo of a dialogue pass does.
  apply("chg_undo", "ver_4", { description: "Undo · Tighten the wrap", revertsVersion: "ver_3", ranges: [{ start: 0, end: 2 }, { start: 5, end: 6 }, { start: 11.5, end: 16.5 }] });
  await show();
  expect(shownVersions()).toEqual(["ver_4", "ver_3", "ver_2", "ver_1", "ver_0"]);
  // An undo, a lone edit nobody revised, the import and the empty timeline say all they have: text, with nothing to press.
  for (const version of ["ver_4", "ver_2", "ver_1", "ver_0"]) {
    expect(row(version).querySelector("button, [aria-expanded]"), version).toBeNull();
    expect(row(version).querySelector("[class*='underline']"), version).toBeNull();
    await click(row(version).querySelector("div")!);
    expect(row(version).querySelector(".mt-3, .version-edits"), version).toBeNull();
  }
  expect(row("ver_4").textContent).toContain("Undo · Tighten the wrap");
  expect(row("ver_3").textContent).toContain("Undone");
  // The version that made three edits opens into them, and folds again.
  expect(opener("ver_3")!.getAttribute("aria-expanded")).toBe("false");
  expect(opener("ver_3")!.querySelector("[class*='underline']")).not.toBeNull();
  await click(opener("ver_3")!);
  expect(opener("ver_3")!.getAttribute("aria-expanded")).toBe("true");
  expect(count("ver_3")).toBe("3 edits");
  await click(opener("ver_3")!);
  expect(row("ver_3").querySelector(".version-edits")).toBeNull();
});

it("keeps the versions on screen while an applied edit's list is on its way", async () => {
  const before = data.versions!;
  const applied = { ...data.changes.find(c => c.id === "chg_approved_2")!, id: "chg_next", fromVersion: "ver_3", toVersion: "ver_4",
    description: "Lift the intro music", timelineEdits: undefined, taskId: undefined, createdAt: new Date().toISOString() };
  const project = { ...data.project, head: "ver_4" };
  let workspace!: (detail: Awaited<ReturnType<typeof api.workspace>>) => void;
  let versions!: (list: { versions: VersionSummary[] }) => void;
  vi.spyOn(api, "workspace").mockImplementation(() => new Promise(resolve => { workspace = resolve; }));
  const asked = vi.spyOn(api, "versions").mockImplementation(() => new Promise(resolve => { versions = resolve; }));
  await show();
  expect(shownVersions()).toEqual(["ver_3", "ver_2", "ver_1"]);
  const stillListed = () => {
    expect(shownVersions()).toEqual(["ver_3", "ver_2", "ver_1"]);
    expect(container.textContent).not.toContain("Loading versions…");
  };

  // The engine says the head moved. The list in hand doesn't hold the new head yet.
  await act(async () => useProjectStore.getState().applyEvent({ type: "project.updated", projectId: PRJ, project }));
  stillListed();
  // The store then drops its list and History asks for the new one.
  await act(async () => workspace({ project, timeline: { ...data.timeline!, version: "ver_4" } }));
  expect(useProjectStore.getState().current!.versions).toBeUndefined();
  expect(asked).toHaveBeenCalledTimes(1);
  stillListed();
  // It arrives: the new version leads, as the one the video is on.
  await act(async () => versions({ versions: [...before.map(v => ({ ...v, isHead: false })), versionOf(applied, "ver_3")] }));
  expect(shownVersions()).toEqual(["ver_4", "ver_3", "ver_2", "ver_1"]);
  expect(row("ver_4").querySelector(".chip")?.textContent).toBe("Current");
  expect(row("ver_3").querySelector(".chip")).toBeNull();
});

it("says who made a version by the name the interface uses, with no id, and lists every edit it made", async () => {
  // The engine records the agent by its id and the model by an alias.
  apply("chg_many", "3e65a3c7be22d063", { author: { type: "agent", id: "claude", name: "claude", model: "opus" },
    timelineEdits: Array.from({ length: 12 }, (_, i) => ({ label: `Edit ${i + 1}`, range: { start: i, end: i + 0.5 } })) });
  await show();
  const made = row("3e65a3c7be22d063");
  expect(made.querySelector(".text-muted")!.textContent).toMatch(/^Claude Code · .+ · 0:16 long$/);
  expect(made.textContent).not.toMatch(/opus|3e65a3c7/);
  expect(container.querySelector("code")).toBeNull();
  // Every edit is listed when the version opens: nothing is folded behind a count.
  await click(opener("3e65a3c7be22d063")!);
  expect(count("3e65a3c7be22d063")).toBe("12 edits");
  expect(listed("3e65a3c7be22d063")).toHaveLength(12);
  expect([...made.querySelectorAll("button")].map(b => b.className)).toEqual(["version-row w-full text-left group"]);
});

it("offers Retry when the versions didn't load", async () => {
  const read = vi.spyOn(api, "versions").mockRejectedValueOnce(new Error("The engine is restarting")).mockResolvedValue({ versions: data.versions! });
  data = { ...data, versions: undefined };
  useProjectStore.setState({ current: data });
  await show();
  const status = container.querySelector('li[role="status"]')!;
  expect(status.textContent).toBe("The engine is restarting Retry");
  await click(status.querySelector("button")!);
  expect(read).toHaveBeenCalledTimes(2);
  expect(shownVersions()).toEqual(["ver_3", "ver_2", "ver_1"]);
});
