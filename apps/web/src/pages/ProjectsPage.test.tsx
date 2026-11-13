// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { expect, it, vi } from "vitest";
import * as client from "../lib/client";
import { api } from "../lib/client";
import { desktop } from "../lib/desktop";
import { dropTargets } from "../lib/dropTargets";
import { pendingImports } from "../lib/pendingImports";
import * as upload from "../lib/upload";
import { createProject } from "@scarlet/timeline";
import type { ProjectSummary } from "@scarlet/shared";
import { buildDb, PRJ } from "../lib/mock/fixtures";
import { useProjectStore } from "../stores/project";
import { useUiStore } from "../stores/ui";
import { ImportUrlModal, ProjectsPage } from "./ProjectsPage";
import { UploadList, useUploader } from "../components/media/UploadDropzone";

it.each(["empty", "populated"])("can start a project from the %s library guide and creates it only on submit", async (library) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const previous = useProjectStore.getState();
  const previousUi = useUiStore.getState();
  const db = buildDb();
  const create = vi.fn().mockResolvedValue(db.projects.find(p => p.id === PRJ)!);
  const projects = library === "empty" ? [] : [{ ...db.summaries[PRJ]!, poster: null }];
  vi.spyOn(api, "projects").mockResolvedValue({ projects });
  useProjectStore.setState({ list: projects, listStatus: "ready", createProject: create });
  vi.spyOn(api, "trash").mockResolvedValue({ projects: [] });
  vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings });
  const picker = vi.spyOn(HTMLInputElement.prototype, "click");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (text: string, within: ParentNode = container) => [...within.querySelectorAll("button")].find(b => b.textContent?.trim() === text)!;
  try {
    await act(async () => root.render(<MemoryRouter><Routes>
      <Route path="/" element={<ProjectsPage />} /><Route path="/p/:id" element={<p>Project workspace</p>} />
    </Routes></MemoryRouter>));
    expect(container.querySelector(".library-first-edit") !== null).toBe(library === "empty");
    expect(container.querySelector(".first-edit-steps")).toBeNull();
    await act(() => button("Quick start").click());
    const guide = container.querySelector("dialog[open]")!;
    expect(guide.querySelector("h2")?.textContent).toBe("Quick start");
    expect([...guide.querySelectorAll("li h3")].map(el => el.textContent)).toEqual(["Add your footage", "Ask for an edit", "Play it back"]);
    const skills = guide.querySelector("details")!;
    expect(skills.open).toBe(false);
    expect(skills.querySelector("summary")?.textContent?.trim()).toBe("Teach Scarlet your editing style");
    await act(() => skills.querySelector("summary")!.click());
    expect(skills.open).toBe(true);
    expect(guide.textContent).toMatch(/Create a skill.*More → Learnings.*Approve/);
    await act(() => button("New project", guide).click());
    expect(container.querySelectorAll("dialog[open]")).toHaveLength(1);
    const name = container.querySelector<HTMLInputElement>("#np-name")!;
    expect(document.activeElement).toBe(name);
    expect(picker).not.toHaveBeenCalled();
    expect(button("Create project").disabled).toBe(true);
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Interview");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(container.querySelector("#np-file-types")?.textContent).toMatch(/MP4.*WAV.*JPEG/);
    await act(() => button("Choose files…").click());
    expect(picker.mock.instances).toEqual([input]);
    const files = new DataTransfer();
    files.items.add(new File(["video"], "take-one.mov"));
    await act(() => {
      input.files = files.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(() => button("Change selection…").click());
    await act(() => { input.dispatchEvent(new Event("cancel", { bubbles: true })); });
    expect(name.value).toBe("Interview");
    expect(container.querySelector('[aria-label="Selected files"]')?.textContent).toBe("take-one.mov");
    expect(create).not.toHaveBeenCalled();
    await act(() => button("Clear").click());
    await act(async () => button("Create project").click());
    expect(create).toHaveBeenCalledExactlyOnceWith({ name: "Interview" });
    expect(container.textContent).toContain("Project workspace");
    expect(useUiStore.getState().firstEditHint).toBe(library === "empty" ? PRJ : null);
  } finally {
    await act(() => root.unmount());
    container.remove();
    useProjectStore.setState(previous, true);
    useUiStore.setState(previousUi, true);
    localStorage.removeItem("scarlet.firstEditHint");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("offers New project in an empty library, names the project for the first video chosen, and takes videos dropped on the dialog", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const previous = useProjectStore.getState();
  const db = buildDb();
  useProjectStore.setState({ list: [], listStatus: "ready", createProject: vi.fn(), loadList: vi.fn() });
  vi.spyOn(api, "trash").mockResolvedValue({ projects: [] });
  vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings });
  vi.spyOn(client, "IS_DESKTOP", "get").mockReturnValue(true);
  const picked = vi.spyOn(desktop, "pickFiles").mockResolvedValue(["/clips/Sam interview.mov", "/clips/b-roll.mov"]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const buttons = (text: string) => [...container.querySelectorAll("button")].filter(b => b.textContent?.trim() === text);
  const chosen = () => [...container.querySelectorAll('[aria-label="Selected files"] li')].map(li => li.textContent);
  try {
    await act(async () => root.render(<MemoryRouter><ProjectsPage /></MemoryRouter>));
    const welcome = container.querySelector(".library-first-edit")!;
    expect(welcome.textContent).toContain("Drop your footage here");
    expect(buttons("New project")).toEqual([welcome.querySelector(".btn-primary")]);
    await act(() => buttons("New project")[0]!.click());
    const name = container.querySelector<HTMLInputElement>("#np-name")!;
    expect(buttons("Create project")[0]!.disabled).toBe(true);
    // Choosing videos with no name typed names the project for the first, as dropping them on the library does.
    await act(async () => buttons("Choose files…")[0]!.click());
    expect(name.value).toBe("Sam interview");
    expect(buttons("Create and import")[0]!.disabled).toBe(false);
    // Until the editor names it, the project follows the selection: another first video renames it.
    picked.mockResolvedValue(["/clips/Dana interview.mov"]);
    await act(async () => buttons("Change selection…")[0]!.click());
    expect(name.value).toBe("Dana interview");
    // A name the editor typed is theirs: another selection leaves it.
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Episode 12");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    picked.mockResolvedValue(["/clips/wide.mov"]);
    await act(async () => buttons("Change selection…")[0]!.click());
    expect(name.value).toBe("Episode 12");
    expect(chosen()).toEqual(["wide.mov"]);
    // Videos dropped on the dialog join the ones chosen, once each.
    const zone = container.querySelector("dialog [data-file-drop]")!;
    await act(() => dropTargets.get(zone)!.drop(["/clips/cutaway.mov", "/clips/wide.mov"]));
    expect(chosen()).toEqual(["wide.mov", "cutaway.mov"]);
    expect(name.value).toBe("Episode 12");
  } finally {
    await act(() => root.unmount());
    container.remove();
    useProjectStore.setState(previous, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("creates a named project from a drop, handles a bad file, and matches the first successfully probed video", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const previous = useProjectStore.getState();
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  const create = vi.fn().mockResolvedValue(project);
  useProjectStore.setState({ list: [], listStatus: "ready", createProject: create, loadList: vi.fn() });
  vi.spyOn(api, "trash").mockResolvedValue({ projects: [] });
  vi.spyOn(api, "settings").mockResolvedValue({ settings: { ...db.settings, transcription: { ...db.settings.transcription, provider: "openai" } }, transcriptionAvailable: true });
  const format = vi.spyOn(api, "updateProject").mockResolvedValue({ project });
  const video = { ...db.media[PRJ]!.find(m => m.kind === "video")!, width: 720, height: 1280, fps: 24 };
  let finishImport!: (media: typeof video) => void;
  const transfer = vi.spyOn(upload, "uploadMedia").mockImplementation((_id, file) => ({
    promise: file.name === "bad.mov" ? Promise.reject(new Error("Unreadable")) : new Promise(resolve => { finishImport = resolve; }),
    abort: vi.fn(),
  }));
  function Workspace() {
    const { items, dismiss } = useUploader(PRJ);
    const { search } = useLocation();
    return <><p>Project workspace{search}</p><UploadList items={items} onDismiss={dismiss} /></>;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter><Routes>
      <Route path="/" element={<ProjectsPage />} /><Route path="/p/:id" element={<Workspace />} />
    </Routes></MemoryRouter>));
    expect(container.textContent).toContain("Make your first edit");
    expect(container.textContent).not.toContain("sent to OpenAI");
    const files = new DataTransfer();
    files.items.add(new File(["x"], "bad.mov"));
    files.items.add(new File(["y"], "portrait.mp4"));
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: files });
    await act(() => { container.querySelector("main")!.dispatchEvent(drop); });
    const name = container.querySelector<HTMLInputElement>("#np-name")!;
    expect(name.value).toBe("bad");
    expect(container.querySelector("dialog")?.textContent).toContain("sent to OpenAI");
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "First interview");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(create).not.toHaveBeenCalled();
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Create and import"))!.click());
    expect(create).toHaveBeenCalledExactlyOnceWith({ name: "First interview" });
    expect(transfer).toHaveBeenCalledTimes(2);
    expect(format).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Project workspace?panel=media");
    expect(container.textContent).toContain("Unreadable");
    await act(async () => finishImport(video));
    expect(format).toHaveBeenCalledExactlyOnceWith(PRJ, { settings: { width: 720, height: 1280, fps: 24, aspect: "9:16" }, expectedFormat: { settings: project.settings, head: project.head } });
    await act(() => container.querySelectorAll<HTMLButtonElement>('[aria-label="Dismiss"]').forEach(button => button.click()));
  } finally {
    await act(() => root.unmount());
    container.remove();
    useProjectStore.setState(previous, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("remembers a new project's chosen files as the ones that set its format, until the first video has", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const previous = useProjectStore.getState();
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  useProjectStore.setState({ list: [], listStatus: "ready", createProject: vi.fn().mockResolvedValue(project), loadList: vi.fn() });
  vi.spyOn(api, "trash").mockResolvedValue({ projects: [] });
  vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings });
  vi.spyOn(client, "IS_DESKTOP", "get").mockReturnValue(true);
  vi.spyOn(desktop, "pickFiles").mockResolvedValue(["/clips/take-one.mov", "/clips/take-two.mov"]);
  const format = vi.spyOn(api, "updateProject").mockResolvedValue({ project });
  const video = { ...db.media[PRJ]!.find(m => m.kind === "video")!, width: 720, height: 1280, fps: 24 };
  const finish: (() => void)[] = [];
  const imports = vi.spyOn(api, "importMedia").mockImplementation(() => new Promise(resolve => { finish.push(() => resolve({ media: video })); }));
  // What a quit at this moment would leave saved for the next launch.
  const saved = () => pendingImports(PRJ).map(i => [i.source, !!i.setsFormat]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === text)!;
  try {
    await act(async () => root.render(<MemoryRouter><Routes>
      <Route path="/" element={<ProjectsPage />} /><Route path="/p/:id" element={<p>Project workspace</p>} />
    </Routes></MemoryRouter>));
    await act(() => button("New project").click());
    const name = container.querySelector<HTMLInputElement>("#np-name")!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Interview");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Choose files…").click());
    await act(async () => button("Create and import").click());
    expect(container.textContent).toContain("Project workspace");
    expect(imports.mock.calls.map(call => call[1].path)).toEqual(["/clips/take-one.mov"]);
    expect(saved()).toEqual([["/clips/take-one.mov", true], ["/clips/take-two.mov", true]]);
    await act(async () => {
      finish[0]!();
      await vi.waitFor(() => expect(finish).toHaveLength(2));
    });
    expect(format).toHaveBeenCalledExactlyOnceWith(PRJ, { settings: { width: 720, height: 1280, fps: 24, aspect: "9:16" }, expectedFormat: { settings: project.settings, head: project.head } });
    expect(saved()).toEqual([["/clips/take-two.mov", false]]);
    await act(async () => {
      finish[1]!();
      await vi.waitFor(() => expect(saved()).toEqual([]));
    });
    expect(format).toHaveBeenCalledTimes(1);
  } finally {
    await act(() => root.unmount());
    container.remove();
    localStorage.removeItem("scarlet.imports.v1");
    useProjectStore.setState(previous, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("manages a project from either library layout", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const previous = useProjectStore.getState();
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  const summary = { ...db.summaries[PRJ]!, name: "Interview" };
  vi.spyOn(api, "projects").mockResolvedValue({ projects: [summary] });
  useProjectStore.setState({ list: [summary], listStatus: "ready", current: null });
  vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings });
  const trash = vi.spyOn(api, "trash").mockResolvedValue({ projects: [] });
  const update = vi.spyOn(api, "updateProject").mockImplementation(async (_id, patch) => ({
    project: { ...project, name: summary.name, ...patch },
  }));
  const remove = vi.spyOn(api, "deleteProject").mockResolvedValue({});
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const tap = (button: Element | null | undefined) => act(async () => {
    expect(button).toBeTruthy();
    (button as HTMLButtonElement).click();
  });
  const textButton = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === text);
  const actions = () => tap(container.querySelector('[aria-label="Actions for Interview"]'));
  try {
    await act(async () => root.render(<MemoryRouter><ProjectsPage /></MemoryRouter>));
    expect(container.querySelector(".library-count")).toBeNull();
    await tap(container.querySelector('[aria-label="Grid view"]'));
    await actions(); await tap(textButton("Archive"));
    expect(update).toHaveBeenLastCalledWith(PRJ, { archived: true });
    expect(container.querySelector(".project-link")).toBeNull();
    await tap(textButton("Archived"));
    await tap(container.querySelector('[aria-label="List view"]'));
    await actions(); await tap(textButton("Unarchive"));
    await tap(textButton("Active"));
    await actions(); await tap(textButton("Rename"));
    expect(container.querySelector<HTMLInputElement>('dialog input')?.value).toBe("Interview");
    await tap(textButton("Cancel"));
    await actions(); await tap(textButton("Move to Trash"));
    expect(remove).not.toHaveBeenCalled();
    trash.mockResolvedValue({ projects: [{ id: PRJ, name: summary.name, deletedAt: new Date().toISOString(), purgeAt: new Date().toISOString() }] });
    await tap(textButton("Move to Trash"));
    expect(remove).toHaveBeenCalledWith(PRJ);
    expect(container.querySelector(".project-link")).toBeNull();
    expect(textButton("Trash (1)")).toBeTruthy();
    const deletedAt = (await api.trash()).projects[0]!.deletedAt;
    const clean = vi.spyOn(api, "cleanStorage").mockResolvedValue({ projects: 1 });
    const measure = vi.spyOn(desktop, "measureProjectStorage").mockResolvedValue({ [PRJ]: { bytes: 3 * 1024 ** 3, files: 4, estimated: false } });
    await tap(textButton("Trash (1)")); await tap(textButton("Empty Trash"));
    expect(measure).toHaveBeenCalledWith([{ id: PRJ, deletedAt, segments: [] }]);
    expect(document.querySelector("dialog[open]")?.textContent).toContain("This frees 3.00 GB and cannot be undone.");
    expect(clean).not.toHaveBeenCalled();
    await tap(textButton("Cancel"));
    expect(textButton("Restore")).toBeTruthy();
    await tap(textButton("Empty Trash"));
    trash.mockResolvedValue({ projects: [] });
    await tap(textButton("Delete permanently"));
    expect(clean).toHaveBeenCalledWith({ kind: "trash", projects: [{ id: PRJ, deletedAt }] });
    expect(textButton("Trash (1)")).toBeFalsy();
  } finally {
    await act(() => root.unmount());
    container.remove();
    localStorage.removeItem("scarlet.projectView");
    useProjectStore.setState(previous, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("selects visible projects across layouts and retries only failed bulk actions", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const previous = useProjectStore.getState();
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  let library = ["A", "B", "C", "D", "E"].map(name => ({
    ...db.summaries[PRJ]!, id: name, name, archived: name === "E", poster: null,
  }));
  vi.spyOn(api, "projects").mockImplementation(async () => ({ projects: library }));
  vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings });
  vi.spyOn(api, "trash").mockResolvedValue({ projects: [] });
  const archive: typeof api.updateProject = async (id, patch) => {
    library = library.map(p => p.id === id ? { ...p, archived: !!patch.archived } : p);
    return { project: { ...project, id, name: id, ...patch } };
  };
  const update = vi.spyOn(api, "updateProject").mockImplementation(archive);
  const remove = vi.spyOn(api, "deleteProject").mockImplementation(async id => {
    library = library.filter(p => p.id !== id);
    return {};
  });
  useProjectStore.setState({ list: library, listStatus: "ready", current: null });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const check = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const button = (text: string, scope: ParentNode = container) =>
    [...scope.querySelectorAll("button")].find(b => b.textContent?.trim() === text)!;
  const click = (element: HTMLElement, modifiers: MouseEventInit = {}) => act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...modifiers }));
  });
  const row = (id: string) => check(`Select ${id}`).closest(".project-entry")!.querySelector<HTMLElement>(".project-link")!;
  const selected = () => [...container.querySelectorAll<HTMLInputElement>(".project-selector input:checked")].map(el => el.id);
  const shortcut = (key: string, options: KeyboardEventInit = {}) => act(() => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
  });
  try {
    await act(async () => root.render(<MemoryRouter><Routes>
      <Route path="/" element={<ProjectsPage />} /><Route path="/p/:id" element={<p>Project workspace</p>} />
    </Routes></MemoryRouter>));
    // No row is kept for selecting: the box for every project is in the list's heading row, and the bar isn't there
    // until something is selected.
    const bar = () => container.querySelector(".library-selection-bar");
    expect(bar()).toBeNull();
    const everyBox = check("Select all visible projects");
    expect(everyBox.closest(".project-columns")).toBeTruthy();
    expect(container.textContent).not.toContain("Select all");
    await click(row("A"), { metaKey: true });
    await click(row("C"), { shiftKey: true });
    expect(selected()).toEqual(["project-select-A", "project-select-B", "project-select-C"]);
    expect(check("Select all visible projects").indeterminate).toBe(true);
    expect(bar()?.textContent).toContain("3 selected");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("3 selected");
    // The one bar comes in on the heading row, beside the box that was there, and not as a row of its own above the
    // projects, which would move them from under the pointer.
    expect(container.querySelectorAll(".library-selection-bar")).toHaveLength(1);
    expect(bar()?.parentElement).toBe(everyBox.closest(".project-columns"));
    expect(check("Select all visible projects")).toBe(everyBox);
    // The grid has no heading row, so its box sits beside the layout switch, and knows what is selected. Its bar is in
    // the page's top row too, straight after the title it lies over.
    await click(container.querySelector('[aria-label="Grid view"]')!);
    expect(container.querySelectorAll('input[aria-label="Select all visible projects"]')).toHaveLength(1);
    expect(check("Select all visible projects").closest(".library-heading")).toBeTruthy();
    expect(check("Select all visible projects").indeterminate).toBe(true);
    expect(container.querySelectorAll(".library-selection-bar")).toHaveLength(1);
    expect(bar()?.closest(".library-heading")).toBeTruthy();
    expect(bar()?.parentElement?.previousElementSibling?.textContent).toBe("Projects");
    await click(row("B"));
    expect(selected()).toEqual(["project-select-A", "project-select-C"]);
    // While the batch runs, the bar's buttons and the box are off there as they are in the list.
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    update.mockImplementationOnce(async (...args) => { await held; return archive(...args); });
    await click(button("Archive"));
    expect([...bar()!.querySelectorAll("button")].map(b => b.disabled)).toEqual([true, true, true]);
    expect(check("Select all visible projects").disabled).toBe(true);
    await act(async () => { finish(); await vi.waitFor(() => expect(bar()).toBeNull()); });
    expect(update.mock.calls).toEqual([["A", { archived: true }], ["C", { archived: true }]]);
    expect(selected()).toEqual([]);

    await click(check("Select B"));
    await click(button("Archived"));
    expect(selected()).toEqual([]);
    await shortcut("a", { ctrlKey: true });
    expect(selected()).toEqual(["project-select-A", "project-select-C", "project-select-E"]);
    await click(check("Select E"));
    await click(button("Unarchive"));
    expect(update.mock.calls.slice(2)).toEqual([["A", { archived: false }], ["C", { archived: false }]]);

    await click(button("Active"));
    await click(check("Select all visible projects"));
    expect(check("Select all visible projects").checked).toBe(true);
    await shortcut("Escape");
    expect(selected()).toEqual([]);
    await click(check("Select C"));
    await click(check("Select A"), { shiftKey: true });
    await click(button("Move to Trash"));
    expect(container.querySelector("dialog")?.textContent).toContain("Move 3 projects to Trash?");
    await shortcut("a", { metaKey: true });
    await click(button("Cancel"));
    expect(remove).not.toHaveBeenCalled();
    expect(selected()).toHaveLength(3);

    remove.mockRejectedValueOnce(new Error("Project is busy"));
    await click(button("Move to Trash"));
    await click(button("Move to Trash", container.querySelector("dialog")!));
    expect(remove.mock.calls.flat()).toEqual(["A", "B", "C"]);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("A: Project is busy");
    expect(selected()).toEqual(["project-select-A"]);
    await click(button("Move to Trash"));
    await click(button("Move to Trash", container.querySelector("dialog")!));
    expect(remove.mock.calls.flat()).toEqual(["A", "B", "C", "A"]);
    expect(library.map(p => p.id)).toEqual(["D", "E"]);
    await click(row("D"));
    expect(container.textContent).toContain("Project workspace");
  } finally {
    await act(() => root.unmount());
    container.remove();
    localStorage.removeItem("scarlet.projectView");
    useProjectStore.setState(previous, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("shows the welcome only after the engine confirms an empty library and keeps it through refreshes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const previous = useProjectStore.getState();
  const db = buildDb();
  let answer!: (value: { projects: [] }) => void;
  const projects = vi.spyOn(api, "projects").mockReturnValue(new Promise(resolve => { answer = resolve; }));
  vi.spyOn(api, "trash").mockResolvedValue({ projects: [] });
  vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings });
  // The window opens behind another one: the library still loads.
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  useProjectStore.setState({ list: [], listStatus: "idle", listError: null });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter><ProjectsPage /></MemoryRouter>));
    expect(projects).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("Make your first edit");
    await act(async () => answer({ projects: [] }));
    expect(container.querySelector("section h2")?.textContent).toBe("Make your first edit");
    expect(container.querySelector(".first-edit-steps")).toBeNull();
    // A refresh of an empty library doesn't swap that for a spinner.
    hidden.mockReturnValue(false);
    projects.mockReturnValue(new Promise(() => {}));
    await act(async () => { void useProjectStore.getState().loadList(); });
    expect(useProjectStore.getState().listStatus).toBe("ready");
    expect(container.textContent).toContain("Make your first edit");
  } finally {
    await act(() => root.unmount());
    container.remove();
    useProjectStore.setState(previous, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("says a project's length, then its files, with its frame's size only when it isn't 16:9, and rewords Last edited as time passes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2030-01-10T12:00:00Z"));
  const previous = useProjectStore.getState();
  const db = buildDb();
  const base = db.projects.find(p => p.id === PRJ)!;
  const summary = { id: base.id, name: base.name, head: base.head, createdAt: base.createdAt, updatedAt: new Date(Date.now() - 10_000).toISOString(),
    settings: { ...base.settings, aspect: "custom" as const, width: 2560, height: 1600 }, mediaCount: 0, poster: null, pendingChanges: 0, openNotes: 0 };
  const wide = { ...base.settings, aspect: "16:9" as const, width: 1920, height: 1080 };
  const library = [summary, { ...summary, id: "prj_cut", settings: wide, duration: 1002, mediaCount: 3 },
    { ...summary, id: "prj_tall", settings: { ...wide, aspect: "9:16" as const, width: 1080, height: 1920 }, duration: 4000, mediaCount: 1 },
    // A frame given as a size is still 16:9, and a project with no video yet has no length.
    { ...summary, id: "prj_new", settings: { ...wide, aspect: "custom" as const, width: 3840, height: 2160 }, duration: 0, mediaCount: 2 }];
  vi.spyOn(api, "projects").mockResolvedValue({ projects: library });
  vi.spyOn(api, "trash").mockResolvedValue({ projects: [] });
  vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings });
  useProjectStore.setState({ list: library, listStatus: "ready", listError: null });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter><ProjectsPage /></MemoryRouter>));
    // The frame reads as its size: "9:16" after a length would read as a second time.
    expect([...container.querySelectorAll(".project-caption p")].map(el => el.textContent)).toEqual(["2560×1600·0 files", "16:42·3 files", "1:06:40·1080×1920·1 file", "2 files"]);
    expect(container.querySelector(".project-date")?.textContent).toBe("just now");
    // The library is unchanged, so nothing else redraws the row.
    await act(async () => { vi.advanceTimersByTime(3 * 60_000); });
    expect(container.querySelector(".project-date")?.textContent).toBe("3m ago");
  } finally {
    await act(() => root.unmount());
    container.remove();
    useProjectStore.setState(previous, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

it("says what waits on the editor in the chat's words, with no heading over that column", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const previous = useProjectStore.getState();
  const db = buildDb();
  const library = [5, 1, 0].map((pendingChanges, i) => ({ ...db.summaries[PRJ]!, id: `prj_${i}`, name: `Project ${i}`, pendingChanges, poster: null }));
  vi.spyOn(api, "projects").mockResolvedValue({ projects: library });
  vi.spyOn(api, "trash").mockResolvedValue({ projects: [] });
  vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings });
  useProjectStore.setState({ list: library, listStatus: "ready", listError: null });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter><ProjectsPage /></MemoryRouter>));
    // The engine counts as the project's chat does, so the row reads as the chat's "N need you".
    expect([...container.querySelectorAll(".project-review")].map(el => el.textContent)).toEqual(["5 need you", "1 needs you", "Nothing needs you"]);
    expect(container.querySelectorAll(".review-badge")).toHaveLength(2);
    expect([...container.querySelectorAll(".project-columns span")].map(el => el.textContent)).toEqual(["Project", "", "Last edited"]);
    expect(container.textContent).not.toContain("to review");
  } finally {
    await act(() => root.unmount());
    container.remove();
    useProjectStore.setState(previous, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("says under a project's details what Scarlet is doing in it, and nothing while it is idle", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const previous = useProjectStore.getState();
  const db = buildDb();
  const activities: Array<ProjectSummary["activity"]> = [
    [{ kind: "editing", count: 1 }, { kind: "transcribing", count: 2, fraction: 0.425 }],
    [{ kind: "importing", count: 2 }, { kind: "caching", count: 1 }],
    [{ kind: "caching", count: 1, fraction: 0.999, paused: true }],
    undefined,
  ];
  const library = activities.map((activity, i) => ({ ...db.summaries[PRJ]!, id: `prj_${i}`, name: `Project ${i}`, poster: null, ...(activity && { activity }) }));
  vi.spyOn(api, "projects").mockResolvedValue({ projects: library });
  vi.spyOn(api, "trash").mockResolvedValue({ projects: [] });
  vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings });
  useProjectStore.setState({ list: library, listStatus: "ready", listError: null });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter><ProjectsPage /></MemoryRouter>));
    const rows = [...container.querySelectorAll(".project-card")];
    // A job under way gives its figure once the engine has one, never 100%; a paused one says so and its ring stands still.
    expect(rows.map(row => row.querySelector(".project-activity")?.textContent ?? null))
      .toEqual(["Editing·Transcribing 42%", "Importing 2 files·Caching", "Caching paused", null]);
    expect(rows.slice(0, 3).map(row => row.querySelector(".project-activity-mark")?.getAttribute("data-state"))).toEqual(["working", "working", "paused"]);
    // The row's link reads the status with its details.
    expect(rows[0]!.querySelector(".project-link")!.getAttribute("aria-describedby")).toBe("project-meta-prj_0 project-activity-prj_0 project-review-prj_0");
    expect(rows[3]!.querySelector(".project-link")!.getAttribute("aria-describedby")).toBe("project-meta-prj_3 project-review-prj_3");
  } finally {
    await act(() => root.unmount());
    container.remove();
    useProjectStore.setState(previous, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("queues a link on Enter and closes its dialog at once, while the link still downloads", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const previous = useProjectStore.getState();
  const video = buildDb().media[PRJ]!.find(m => m.kind === "video")!;
  const link = "https://example.com/a.mp4";
  let finish!: () => void;
  const imports = vi.spyOn(api, "importMedia").mockImplementation(() => new Promise(resolve => { finish = () => resolve({ media: video }); }));
  const upsert = vi.fn();
  // The project on screen is still as it was created, with no video yet.
  const fresh = { ...createProject("Interview"), id: PRJ };
  const updateProject = vi.fn(async () => {});
  useProjectStore.setState({ upsertMedia: upsert, updateProject, current: { id: PRJ, project: fresh, media: [] } as never });
  const onClose = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === text)!;
  const enter = () => act(async () => { container.querySelector<HTMLFormElement>("#import-link")!.requestSubmit(); });
  try {
    await act(async () => root.render(<ImportUrlModal projectId={PRJ} open notice="" onClose={onClose} />));
    // The dialog is named for the button that opens it, and its own button for what it does.
    expect(container.querySelector("dialog h2")?.textContent).toBe("Add from a link");
    expect(button("Add")).toBeDefined();
    const field = container.querySelector<HTMLInputElement>("#import-url")!;
    // Enter with nothing typed imports nothing.
    await enter();
    expect(imports).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, ` ${link} `);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await enter();
    // The link joined the project's queue, remembered like a file until it is in. The dialog didn't wait for it:
    // it closed with the field empty, and nothing in it spins or is switched off.
    expect(imports).toHaveBeenCalledExactlyOnceWith(PRJ, { url: link, importId: pendingImports(PRJ)[0]?.importId });
    expect(pendingImports(PRJ).map(i => i.source)).toEqual([link]);
    expect(onClose).toHaveBeenCalledOnce();
    expect(field.value).toBe("");
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(button("Cancel").disabled).toBe(false);
    // Cancel, the × and Esc put the dialog away at any time.
    await act(async () => button("Cancel").click());
    await act(async () => container.querySelector<HTMLButtonElement>("[data-close]")!.click());
    await act(async () => { container.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })); });
    expect(onClose).toHaveBeenCalledTimes(4);
    expect(imports).toHaveBeenCalledOnce();
    await act(async () => finish());
    expect(upsert).toHaveBeenCalledExactlyOnceWith(PRJ, video);
    expect(pendingImports(PRJ)).toEqual([]);
    // As a file does, the first video added to a project that is still new gives it its format.
    expect(updateProject).toHaveBeenCalledExactlyOnceWith({ settings: expect.objectContaining({ width: video.width, height: video.height }),
      expectedFormat: { settings: fresh.settings, head: fresh.head } }, PRJ);
  } finally {
    await act(() => root.unmount());
    container.remove();
    localStorage.removeItem("scarlet.imports.v1");
    useProjectStore.setState(previous, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("shows one window-wide update on Projects while building and when ready", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const previous = useProjectStore.getState();
  const db = buildDb();
  // A library with a project in it: an empty one has its New project in its card, not in the heading.
  const library = [{ ...db.summaries[PRJ]!, poster: null }];
  vi.spyOn(api, "projects").mockResolvedValue({ projects: library });
  useProjectStore.setState({ list: library, listStatus: "ready" });
  vi.spyOn(api, "trash").mockResolvedValue({ projects: [] });
  vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings });
  const status = vi.spyOn(desktop, "updateStatus").mockResolvedValue({ ready: null, building: null });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const { enableUpdateStatus, refreshUpdateStatus } = await import("../lib/updateStatus");
  const { UpdateButton } = await import("../components/shell/UpdateButton");
  enableUpdateStatus();
  try {
    await act(async () => root.render(<><UpdateButton /><MemoryRouter><ProjectsPage /></MemoryRouter></>));
    const controls = () => container.querySelectorAll('[aria-label="Scarlet update"]');
    expect(controls()).toHaveLength(0);
    const revision = "d".repeat(40);
    status.mockResolvedValue({ ready: null, building: { revision, done: 0.6, step: 0, stepStarted: 0, stepSeconds: 1 } });
    await act(async () => refreshUpdateStatus());
    expect(controls()).toHaveLength(1);
    expect(controls()[0]!.querySelector("[role=status]")?.textContent).toBe("Updating60%");
    status.mockResolvedValue({ ready: revision, building: null });
    await act(async () => refreshUpdateStatus());
    expect(controls()).toHaveLength(1);
    expect(controls()[0]!.querySelector("button")?.textContent).toBe("Restart to update");
  } finally {
    await act(() => root.unmount());
    container.remove();
    useProjectStore.setState(previous, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
