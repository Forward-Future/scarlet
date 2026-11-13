// @vitest-environment happy-dom
import { openOptions, selectOption } from "../../../test/selectOption";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, Route, Routes, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../../lib/client";
import { desktop } from "../../lib/desktop";
import * as realtime from "../../lib/realtime";
import { invalidateStorageScan } from "../../lib/storage";
import { buildDb, PRJ } from "../../lib/mock/fixtures";
import { useUiStore } from "../../stores/ui";
import { useAuthStore } from "../../stores/auth";
import { useHostsStore } from "../../stores/hosts";
import { useSkillsStore } from "../../stores/skills";
import { useProjectStore } from "../../stores/project";
import { SettingsPage } from "../../pages/SettingsPage";
import { SkillsPage } from "../../pages/SkillsPage";
import { SkillEditorPage } from "../../pages/SkillEditorPage";
import { AppShell } from "./AppShell";
import { ProjectSettingsDrawer } from "./ProjectSettingsDrawer";
import { TrashButton } from "./TrashButton";
import { ShortcutsModal } from "./ShortcutsModal";

let el: HTMLDivElement;
let root: Root;
const resets = [
  () => useUiStore.setState(useUiStore.getInitialState()),
  () => useSkillsStore.setState(useSkillsStore.getInitialState()),
  () => useProjectStore.setState(useProjectStore.getInitialState()),
  () => useAuthStore.setState(useAuthStore.getInitialState()),
  () => useHostsStore.setState(useHostsStore.getInitialState()),
];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  for (const reset of resets) reset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
// A data router, as the app has: Settings asks before leaving with unsaved changes, which only one can do.
const mount = (component: ReactNode, path = "/") => act(async () => root.render(
  <RouterProvider router={createMemoryRouter([{ path: "*", element: component }], { initialEntries: [path] })} />));
const click = (button: HTMLElement) => act(async () => button.click());
const named = (label: string) => el.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;

it("opens shortcut help from Settings and dismisses its modal", async () => {
  await mount(<><SettingsPage /><ShortcutsModal /></>, "/settings/skills");
  expect(named("Projects").getAttribute("href")).toBe("/");
  expect(el.querySelector(".studio-topbar")).toBeNull();
  await click([...el.querySelectorAll("button")].find(b => b.textContent === "Keyboard shortcuts")!);
  const dialog = el.querySelector("dialog")!;
  expect(dialog.open).toBe(true);
  expect(dialog.textContent).toContain("Apply the suggestion");
  await click(dialog.querySelector('[aria-label="Close"]')!);
  expect(el.querySelector("dialog")).toBeNull();
});

it("opens the shortcut list with ? and closes it with ? again, once however long the key is held", async () => {
  useAuthStore.setState({ status: "ready", bootstrap: async () => {} });
  useHostsStore.setState({ load: async () => {} });
  vi.spyOn(realtime, "startRealtime").mockReturnValue(() => {});
  vi.spyOn(api, "settings").mockResolvedValue({ settings: buildDb().settings });
  await act(async () => root.render(<RouterProvider router={createMemoryRouter(
    [{ element: <AppShell />, children: [{ path: "*", element: <p>Page</p> }] }], { initialEntries: ["/settings"] })} />));
  const press = (key: string, repeat = false) => act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key, repeat, bubbles: true, cancelable: true }));
  });
  /** The key held down: it repeats until it is let go. */
  const hold = async (key: string) => { for (let i = 0; i < 3; i++) await press(key, true); };
  await press("?");
  expect(el.querySelector("dialog")?.textContent).toContain("Keyboard shortcuts");
  // Held, the key that opened the list doesn't shut it again.
  await hold("?");
  expect(el.querySelector("dialog")).not.toBeNull();
  // Another key isn't the list's.
  await press("k");
  expect(el.querySelector("dialog")).not.toBeNull();
  // Page shortcuts stop while a dialog is open. The list still closes on its own key, and opens on it again.
  await press("?");
  expect(el.querySelector("dialog")).toBeNull();
  // Held, the key that closed the list doesn't open it again.
  await hold("?");
  expect(el.querySelector("dialog")).toBeNull();
  await press("?");
  expect(el.querySelector("dialog")).not.toBeNull();
});

it("lists Settings once, with the key of the computer it is on, and the keys of the project library", async () => {
  const keysFor = (what: string) => [...el.querySelectorAll("dialog tr")].filter(row => row.children[1]!.textContent === what)
    .map(row => [...row.querySelectorAll("kbd")].map(key => key.textContent).join(" "));
  const computer = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
  useUiStore.setState({ shortcutsOpen: true });
  await mount(<ShortcutsModal />);
  expect(keysFor("Open Settings")).toEqual(["Ctrl ,"]);
  expect(keysFor("Select all projects")).toEqual(["Ctrl A"]);
  expect(keysFor("Clear the selection")).toEqual(["Esc"]);
  // The same rows name ⌘ on a Mac.
  computer.mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15");
  await act(async () => useUiStore.setState({ shortcutsOpen: false }));
  await act(async () => useUiStore.setState({ shortcutsOpen: true }));
  expect(keysFor("Open Settings")).toEqual(["⌘ ,"]);
  expect(keysFor("Select all projects")).toEqual(["⌘ A"]);
  // No row is for another computer.
  expect(el.querySelector("dialog")!.textContent).not.toMatch(/macOS|Ctrl/);
});

it("searches skills across projects and agents even from an old project-filtered link", async () => {
  const fixture = buildDb().skills[0]!;
  useSkillsStore.setState({
    skills: [{ ...fixture, id: "qa-a", name: "one-skill", description: "Trim dialogue", agents: ["claude"] },
      { ...fixture, id: "qa-b", name: "two-skill", description: "Balance audio", agents: ["codex"] }],
    status: "ready", load: vi.fn().mockResolvedValue(undefined),
  });
  await mount(<Routes><Route path="/settings" element={<SettingsPage />}>
    <Route path="skills" element={<SkillsPage />} />
  </Route></Routes>, "/settings/skills?project=a");
  expect(el.querySelector('nav[aria-label="Settings sections"] a[aria-current="true"]')?.textContent).toBe("Tools & skills");
  const secondSkill = () => el.querySelector('a[href="/settings/skills/qa-b"]');
  expect(secondSkill()?.textContent).toContain("two-skill");
  expect(el.querySelector('[aria-label="Agent filter"]')).toBeNull();
  expect(el.querySelector('[aria-label="Project filter"]')).toBeNull();
  expect(el.querySelector('a[href="/settings/skills/qa-a"]')).toBeTruthy();
  const search = el.querySelector<HTMLInputElement>('[aria-label="Search skills"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "AUDIO");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(el.querySelector('a[href="/settings/skills/qa-a"]')).toBeNull();
  expect(secondSkill()?.textContent).toContain("two-skill");
});

it("reviews cache cleanup separately from permanent project deletion", async () => {
  invalidateStorageScan();
  const live = { id: "prj_live", name: "Working cut", busy: false, missingSource: false, segments: ["a.mp4"], deletedAt: null };
  const deletedAt = new Date(Date.now() - 49 * 3_600_000).toISOString();
  const trashed = { ...live, id: "prj_old", name: "Retired cut", deletedAt, purgeAt: new Date(Date.parse(deletedAt) + 30 * 86_400_000).toISOString() };
  const catalog = vi.spyOn(api, "storage").mockResolvedValue({ projects: [live, trashed] });
  vi.spyOn(desktop, "measureProjectStorage").mockResolvedValue({
    prj_live: { bytes: 4096, files: 1, estimated: false }, prj_old: { bytes: 8192, files: 2, estimated: false },
  });
  const clean = vi.spyOn(api, "cleanStorage").mockResolvedValue({ projects: 1 });
  const button = (text: string) => [...document.querySelectorAll("button")].find(b => b.textContent === text)!;
  await mount(<SettingsPage />, "/settings#storage");
  expect(el.querySelector('nav a[aria-current="true"]')?.textContent).toBe("Usage");
  // The figure at the top is what cleaning up gives back, and is titled for that.
  expect(el.querySelector('[aria-label="Storage overview"]')?.textContent).toContain("Space you can free");
  expect(el.querySelector('[aria-label="Storage overview"]')?.textContent).toContain("12 KB");
  // The Trash has one name, and a project in it reads as it does in the Trash opened from the project list.
  const trash = el.querySelector('section[aria-label="Trash"]')!;
  expect(trash.querySelector("h3")?.textContent).toBe("Trash");
  expect(trash.textContent).toContain("Deleted 2d ago · gone for good in 28 days");
  await click(button("Clear cache"));
  expect(document.querySelector("dialog")?.textContent).toContain("Working cut");
  await click(button("Cancel"));
  expect(clean).not.toHaveBeenCalled();
  await click(button("Empty Trash"));
  expect(document.querySelector("dialog h2")?.textContent).toBe("Empty Trash?");
  expect(document.querySelector("dialog")?.textContent).toContain("Permanently delete Retired cut? This frees 8 KB and cannot be undone.");
  catalog.mockResolvedValue({ projects: [live] });
  await click(button("Delete permanently"));
  expect(clean).toHaveBeenCalledWith({ kind: "trash", projects: [{ id: trashed.id, deletedAt: trashed.deletedAt }] });
  expect(el.textContent).toContain("Trash is empty.");
  invalidateStorageScan();
});

it("chooses a preference with the keyboard and saves it", async () => {
  const { settings } = buildDb();
  expect(settings.transcription.provider).toBe("whispercpp");
  vi.spyOn(api, "settings").mockResolvedValue({ settings, transcriptionAvailable: true });
  const save = vi.spyOn(api, "updateSettings").mockResolvedValue({ settings });
  await mount(<SettingsPage />, "/settings");
  const trigger = el.querySelector<HTMLButtonElement>('#tr-provider[role="combobox"]')!;
  const options = await openOptions(trigger);
  expect(options.find(o => o.getAttribute("aria-selected") === "true")?.textContent).toBe(trigger.textContent);
  for (const key of ["End", "Enter"]) {
    await act(() => { trigger.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
  }
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  // The choice is saved as it is made: this tab has no Save.
  expect(save).toHaveBeenCalledExactlyOnceWith({ transcription: expect.objectContaining({ provider: "openai" }) });
  expect(el.querySelector('button[type="submit"]')).toBeNull();
});

it("shows the desktop build version and telemetry disclosure under About", async () => {
  vi.spyOn(api, "settings").mockResolvedValue({ settings: buildDb().settings });
  await mount(<SettingsPage />, "/settings/skills");
  await click(el.querySelector('a[href="/settings#about"]')!);
  const about = el.querySelector('section[aria-label="About Scarlet"]')!;
  expect(about.querySelector("dd")?.textContent).toBe(__SCARLET_VERSION__);
  if (__SCARLET_REVISION__) expect(about.textContent).toContain(__SCARLET_REVISION__.slice(0, 7));
  const telemetry = about.querySelector('section[aria-labelledby="telemetry-heading"]')!;
  expect(telemetry.textContent).toContain("PostHog in the US");
  for (const text of ["keep an applied edit", "send a revision", "request Undo edit", "installation-specific code", "revision text", "change.approve", "media.import"])
    expect(telemetry.textContent).toContain(text);
  expect(telemetry.querySelector("code")?.textContent).toBe("SCARLET_TELEMETRY_ENABLED=false");
  const check = about.querySelector("button")!;
  expect(check.textContent).toBe("Check for updates");
  const latest = vi.spyOn(desktop, "latestUpdateRevision").mockRejectedValueOnce("Connection failed.");
  await click(check);
  expect(about.querySelector('[role="status"]')?.textContent).toBe("Connection failed.");
  if (__SCARLET_REVISION__) {
    latest.mockResolvedValueOnce(__SCARLET_REVISION__).mockResolvedValueOnce("0".repeat(40));
    await click(check);
    expect(about.textContent).toContain("Scarlet is up to date.");
    await click(check);
    expect(about.textContent).toContain("An update is available.");
  }
});

it("saves just the changed preference on the Tools tab", async () => {
  const { settings } = buildDb();
  vi.spyOn(api, "settings").mockResolvedValue({ settings, transcriptionAvailable: true });
  const save = vi.spyOn(api, "updateSettings").mockImplementation(async patch => ({
    settings: { ...settings, editingTools: { ...settings.editingTools, ...patch.editingTools } },
  }));
  await mount(<SettingsPage />, "/settings#tools");
  // The tools are Scarlet's, and nothing describes a way to save a skill that no control offers.
  expect(el.querySelector(".tools-subheading p")?.textContent).toBe("Scarlet can use these from its next request.");
  expect(el.querySelector(".tool-inventory")!.textContent).not.toMatch(/Saving a skill|assistant/);
  expect(named("Frame inspection").getAttribute("aria-checked")).toBe("true");
  await click(named("Frame inspection"));
  expect(save).toHaveBeenCalledWith({ editingTools: { pictures: false } });
  expect(named("Frame inspection").getAttribute("aria-checked")).toBe("false");
  const restore = [...el.querySelectorAll("button")].find(b => b.textContent === "Restore tool defaults")!;
  await click(restore);
  expect(named("Frame inspection").getAttribute("aria-checked")).toBe("true");
});

it("previews an older skill version, restores it into the draft, and protects unsaved work", async () => {
  const db = buildDb();
  const skill = db.skills.find(s => s.version > 1)!;
  vi.spyOn(api, "skill").mockResolvedValue({ skill, versions: db.skillVersions[skill.id]! });
  const router = createMemoryRouter([
    { path: "/settings/skills/:skillId", element: <SkillEditorPage /> },
    { path: "/settings/skills", element: <p>Skill library</p> },
  ], { initialEntries: [`/settings/skills/${skill.id}`] });
  await act(async () => root.render(<RouterProvider router={router} />));
  const editor = el.querySelector<HTMLTextAreaElement>('[aria-label="Skill markdown"]')!;
  await selectOption(named("Version history"), /^v1 ·/);
  expect(editor.readOnly).toBe(true);
  const olderBody = editor.value;
  expect(olderBody).toContain("(v1)");
  const button = (label: string) => [...el.querySelectorAll("button")].find(b => b.textContent?.trim() === label)!;
  await click(button("Restore v1"));
  expect(editor.readOnly).toBe(false);
  expect(editor.value).toBe(olderBody);
  expect(button("Save").disabled).toBe(false);
  await click(button("← Skill library"));
  expect(el.querySelector("dialog")?.textContent).toContain("Save your skill changes?");
  await click(button("Stay"));
  expect(editor.value).toBe(olderBody);
  await click(button("← Skill library"));
  await click(button("Discard changes"));
  expect(el.textContent).toBe("Skill library");
  router.dispose();
});

it("sends only the name for a rename and includes format for a frame rate or aspect change", async () => {
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  const updateProject = vi.fn().mockResolvedValue(undefined);
  useProjectStore.setState({ current: {
    id: PRJ, project, timeline: db.timelines[project.head!]!,
    media: project.media, changes: db.changes, notes: db.notes, renders: db.renders,
    tasks: db.tasks, taskEvents: db.taskEvents, versions: db.versions[PRJ]!,
  }, updateProject });
  useUiStore.setState({ projectSettingsOpen: true });
  await mount(<ProjectSettingsDrawer onDeleted={vi.fn()} />);
  // The project's own settings and nothing else: the model is the same for every project, and is picked in the menu.
  expect([...el.querySelectorAll(".label")].map(label => label.textContent)).toEqual(["Name", "Frame rate", "Aspect"]);
  const name = el.querySelector<HTMLInputElement>("#ps-name")!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Renamed cut");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(() => { el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(updateProject).toHaveBeenLastCalledWith({ name: "Renamed cut" });
  await act(() => { useUiStore.setState({ projectSettingsOpen: true }); });
  // The first clip's format is matched while the drawer is open: the untouched fields show it, nothing warns of a
  // re-render, and a Save that only renames doesn't put the old format back.
  await act(() => { useProjectStore.setState(s => ({ current: { ...s.current!, project: { ...project, settings: { ...project.settings, fps: 23.976 } } } })); });
  expect(el.querySelector("#ps-fps")!.textContent).toContain("23.976 fps");
  expect(el.textContent).not.toContain("invalidates existing renders");
  await act(() => { el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(updateProject).toHaveBeenLastCalledWith({ name: project.name });
  await act(() => { useProjectStore.setState(s => ({ current: { ...s.current!, project } })); useUiStore.setState({ projectSettingsOpen: true }); });
  await selectOption(el.querySelector("#ps-aspect")!, /^9:16 vertical/);
  await selectOption(el.querySelector("#ps-fps")!, "24 fps");
  expect(el.textContent).toContain("invalidates existing renders");
  await act(async () => { el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(updateProject).toHaveBeenCalledWith(expect.objectContaining({
    settings: expect.objectContaining({ fps: 24, aspect: "9:16", width: 1080, height: 1920 }),
  }));
  expect(useUiStore.getState().projectSettingsOpen).toBe(false);
});

it("lists a project matched to NTSC footage at its own rate once, in place of the preset that reads the same", async () => {
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  const ntsc = { ...project, settings: { ...project.settings, fps: 30000 / 1001 } };
  useProjectStore.setState({ current: {
    id: PRJ, project: ntsc, timeline: db.timelines[project.head!]!,
    media: project.media, changes: db.changes, notes: db.notes, renders: db.renders,
    tasks: db.tasks, taskEvents: db.taskEvents, versions: db.versions[PRJ]!,
  } });
  useUiStore.setState({ projectSettingsOpen: true });
  await mount(<ProjectSettingsDrawer onDeleted={vi.fn()} />);
  const trigger = el.querySelector<HTMLElement>("#ps-fps")!;
  const options = await openOptions(trigger);
  const twins = options.filter(o => o.textContent === "29.97 fps");
  expect(twins).toHaveLength(1);
  expect(twins[0]!.getAttribute("aria-selected")).toBe("true");
  await click(twins[0]!);
  expect(el.textContent).not.toContain("invalidates existing renders");
});

it("takes a rate picked while the first clip's format lands as the footage's rate when they read the same", async () => {
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  const data = {
    id: PRJ, project: { ...project, settings: { ...project.settings, fps: 30 } }, timeline: db.timelines[project.head!]!,
    media: project.media, changes: db.changes, notes: db.notes, renders: db.renders,
    tasks: db.tasks, taskEvents: db.taskEvents, versions: db.versions[PRJ]!,
  };
  useProjectStore.setState({ current: data });
  useUiStore.setState({ projectSettingsOpen: true });
  await mount(<ProjectSettingsDrawer onDeleted={vi.fn()} />);
  const trigger = el.querySelector<HTMLElement>("#ps-fps")!;
  await click((await openOptions(trigger)).find(o => o.textContent === "29.97 fps")!);
  // The first clip matches the project to its 29.97 footage while the drawer is still open.
  await act(async () => useProjectStore.setState({ current: { ...data, project: { ...data.project, settings: { ...data.project.settings, fps: 30000 / 1001 } } } }));
  expect([trigger.textContent, el.textContent?.includes("invalidates existing renders")]).toEqual(["29.97 fps", false]);
});

it("keeps what was typed in Project settings, with the reason, when the save fails", async () => {
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  useProjectStore.setState({ current: {
    id: PRJ, project, timeline: db.timelines[project.head!]!,
    media: project.media, changes: db.changes, notes: db.notes, renders: db.renders,
    tasks: db.tasks, taskEvents: db.taskEvents, versions: db.versions[PRJ]!,
  } });
  vi.spyOn(api, "updateProject").mockRejectedValue(new Error("Engine disconnected"));
  useUiStore.setState({ projectSettingsOpen: true });
  await mount(<ProjectSettingsDrawer onDeleted={vi.fn()} />);
  const name = el.querySelector<HTMLInputElement>("#ps-name")!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Renamed cut");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await selectOption(el.querySelector("#ps-fps")!, "24 fps");
  await act(async () => { el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  // The store put the project's own name back. The form still holds the editor's.
  expect(useProjectStore.getState().current?.project.name).toBe(project.name);
  expect(el.querySelector<HTMLInputElement>("#ps-name")!.value).toBe("Renamed cut");
  expect(el.querySelector("#ps-fps")?.textContent).toContain("24 fps");
  expect(el.textContent).toContain("Engine disconnected");
  expect(useUiStore.getState().projectSettingsOpen).toBe(true);
});

it("keeps Project settings open until its save settles, so a failed save is said", async () => {
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  useProjectStore.setState({ current: {
    id: PRJ, project, timeline: db.timelines[project.head!]!,
    media: project.media, changes: db.changes, notes: db.notes, renders: db.renders,
    tasks: db.tasks, taskEvents: db.taskEvents, versions: db.versions[PRJ]!,
  } });
  let fail!: (error: Error) => void;
  vi.spyOn(api, "updateProject").mockReturnValue(new Promise((_, reject) => { fail = reject; }));
  useUiStore.setState({ projectSettingsOpen: true });
  await mount(<ProjectSettingsDrawer onDeleted={vi.fn()} />);
  const name = el.querySelector<HTMLInputElement>("#ps-name")!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Renamed cut");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  // While the save runs, the ×, Esc and Cancel leave the drawer where it is.
  const cancel = [...el.querySelectorAll("button")].find(b => b.textContent === "Cancel")!;
  await click(named("Close"));
  expect(useUiStore.getState().projectSettingsOpen).toBe(true);
  await act(async () => { el.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })); });
  expect(useUiStore.getState().projectSettingsOpen).toBe(true);
  expect(cancel.disabled).toBe(true);
  await act(async () => fail(new Error("Engine disconnected")));
  expect(el.textContent).toContain("Engine disconnected");
  expect(el.querySelector<HTMLInputElement>("#ps-name")!.value).toBe("Renamed cut");
  expect(cancel.disabled).toBe(false);
});

it("restores one project from Trash at a time and never says a project is gone in 0 days", async () => {
  const deletedAt = new Date(Date.now() - 31 * 86_400_000).toISOString();
  const trashed = [
    { id: "prj_a", name: "Interview", deletedAt, purgeAt: new Date(Date.now() - 3_600_000).toISOString() },
    { id: "prj_b", name: "Launch film", deletedAt, purgeAt: new Date(Date.now() + 2 * 86_400_000).toISOString() },
  ];
  vi.spyOn(api, "trash").mockResolvedValue({ projects: trashed } as Awaited<ReturnType<typeof api.trash>>);
  vi.spyOn(desktop, "measureProjectStorage").mockResolvedValue({});
  vi.spyOn(api, "restoreProject").mockReturnValue(new Promise(() => {}));
  await mount(<TrashButton />);
  await click([...el.querySelectorAll("button")].find(b => b.textContent?.includes("Trash (2)"))!);
  expect(el.textContent).toContain("gone for good today");
  expect(el.textContent).toContain("gone for good in 2 days");
  expect(el.textContent).not.toContain("0 days");
  const restore = () => [...el.querySelectorAll<HTMLButtonElement>("button")].filter(b => b.textContent?.trim() === "Restore");
  await click(restore()[0]!);
  // The first restore is still under way: the second can't start and take its spinner away.
  expect(restore().map(b => b.disabled)).toEqual([true, true]);
  expect(restore()[0]!.querySelector('[role="status"]')).not.toBeNull();
  expect(restore()[1]!.querySelector('[role="status"]')).toBeNull();
});

it("opens Trash with the keyboard on the dialog, not on the first project's Restore", async () => {
  const deletedAt = new Date(Date.now() - 3_600_000).toISOString();
  const purgeAt = new Date(Date.now() + 29 * 86_400_000).toISOString();
  vi.spyOn(api, "trash").mockResolvedValue({ projects: [
    { id: "prj_a", name: "Interview", deletedAt, purgeAt }, { id: "prj_b", name: "Launch film", deletedAt, purgeAt },
  ] });
  vi.spyOn(desktop, "measureProjectStorage").mockResolvedValue({});
  await mount(<TrashButton />);
  await click([...el.querySelectorAll("button")].find(b => b.textContent?.includes("Trash (2)"))!);
  // Enter presses the button that has focus. It used to be the first Restore, so Enter put back a project nobody picked.
  const dialog = el.querySelector("dialog")!;
  expect(document.activeElement).toBe(dialog);
  expect(dialog.tabIndex).toBe(-1);
});
