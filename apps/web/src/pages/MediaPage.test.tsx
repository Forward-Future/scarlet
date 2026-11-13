// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import type { SourceCacheStatus, Task } from "@scarlet/shared";
import type { MediaAsset } from "@scarlet/timeline";
import * as client from "../lib/client";
import { desktop } from "../lib/desktop";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { listenForFileDrops } from "../lib/dropTargets";
import { dispatchWsEvent } from "../lib/realtime";
import { MediaDrawer } from "../components/media/MediaDrawer";
import { Dropzone, useUploader } from "../components/media/UploadDropzone";
import { buildDb, PRJ } from "../lib/mock/fixtures";
import { useProjectStore, type ProjectData } from "../stores/project";
import { MediaPage } from "./MediaPage";

const { api } = client;

it.each(["macos", "windows"] as const)("routes a %s file drop to the innermost target in logical coordinates", async platform => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("devicePixelRatio", 2);
  let deliver!: Parameters<typeof desktop.onDropFiles>[0];
  const off = vi.fn();
  vi.spyOn(desktop, "onDropFiles").mockImplementation(async cb => { deliver = cb; return off; });
  const stop = listenForFileDrops(platform);
  const library = vi.fn(), card = vi.fn(), upload = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Dropzone onPaths={library} onFiles={upload}>
      <Dropzone onPaths={card} onFiles={upload}><span>Project</span></Dropzone>
    </Dropzone>));
    const hit = vi.spyOn(document, "elementFromPoint").mockReturnValue(container.querySelector("span"));
    const position = platform === "windows" ? new PhysicalPosition(200, 120) : new PhysicalPosition(100, 60);
    await act(() => deliver({ type: "over", position }));
    await act(() => deliver({ type: "drop", position, paths: ["/Volumes/Media/interview.mov"] }));
    expect(hit).toHaveBeenCalledWith(100, 60);
    expect(card).toHaveBeenCalledExactlyOnceWith(["/Volumes/Media/interview.mov"]);
    expect(library).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  } finally {
    stop();
    await act(() => root.unmount());
    expect(off).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("accepts dropped files throughout the empty and populated Media drawer", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const previous = useProjectStore.getState();
  const db = buildDb();
  const project = db.projects.find((p) => p.id === PRJ)!;
  const current: ProjectData = {
    id: PRJ, project, timeline: null, media: [],
    changes: [], notes: [], renders: [], tasks: [], taskEvents: {}, versions: [],
  };
  useProjectStore.setState({ current });
  vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings, transcriptionAvailable: true });
  vi.spyOn(api, "sourceCaches").mockResolvedValue({ caches: [] });
  const start = vi.fn(), startPaths = vi.fn();
  let deliver!: Parameters<typeof desktop.onDropFiles>[0];
  vi.spyOn(desktop, "onDropFiles").mockImplementation(async cb => { deliver = cb; return () => {}; });
  const stop = listenForFileDrops("macos");
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter><MediaDrawer onClose={vi.fn()} onPlay={vi.fn()} uploads={{ items: [], start, dismiss: vi.fn(), localImport: null, startPaths }} /></MemoryRouter>));
    await act(async () => { await vi.dynamicImportSettled(); });
    const drop = new DataTransfer();
    drop.items.add(new File(["one"], "first.mp4"));
    drop.items.add(new File(["two"], "second.mp4"));
    // A hit below a short file list lands on the drawer's scrolling body itself.
    const target = container.querySelector<HTMLDivElement>("dialog .overflow-y-auto")!;
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: drop });
    await act(() => { target.dispatchEvent(event); });
    expect(start).toHaveBeenCalledTimes(1);
    expect(Array.from(start.mock.calls[0]![0] as FileList).map((f) => f.name)).toEqual(["first.mp4", "second.mp4"]);

    await act(() => useProjectStore.setState({ current: { ...current, media: db.media[PRJ]! } }));
    const hit = vi.spyOn(document, "elementFromPoint").mockReturnValue(target);
    const position = new PhysicalPosition(10, 10);
    const paths = ["/footage/new clip.mov"];
    await act(() => deliver({ type: "enter", paths, position }));
    expect(container.textContent).toContain("Drop to add files");
    hit.mockReturnValue(container.querySelector("dialog h2"));
    await act(() => deliver({ type: "drop", paths, position }));
    expect(startPaths).toHaveBeenCalledExactlyOnceWith(paths);
    expect(container.textContent).not.toContain("Drop to add files");
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const pick = vi.spyOn(input, "click");
    const add = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Add files")!;
    expect(add.tabIndex).toBe(0);
    await act(() => add.click());
    expect(pick).toHaveBeenCalledTimes(1);

    const fromLink = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Add from a link")!;
    await act(() => fromLink.click());
    const urlField = container.querySelector("#import-url")!;
    hit.mockReturnValue(urlField);
    await act(() => { urlField.dispatchEvent(event); deliver({ type: "drop", paths, position }); });
    expect(startPaths).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  } finally {
    stop();
    await act(() => root.unmount());
    useProjectStore.setState(previous, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("tracks the native selection from the first pending import through media preparation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const previous = useProjectStore.getState();
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  const video = { ...db.media[PRJ]!.find(m => m.kind === "video")!, name: "clip.mov", status: "ingesting" as const };
  useProjectStore.setState({ current: {
    id: PRJ, project, timeline: null, media: [], changes: [],
    notes: [], renders: [], tasks: [], taskEvents: {}, versions: [],
  } });
  vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings, transcriptionAvailable: true });
  vi.spyOn(api, "sourceCaches").mockResolvedValue({ caches: [] });
  vi.spyOn(client, "IS_DESKTOP", "get").mockReturnValue(true);
  vi.spyOn(desktop, "pickFiles").mockResolvedValueOnce([]).mockResolvedValueOnce(["C:/media/bad.mov", "/media/clip.mov"]);
  let rejectFirst!: (error: Error) => void;
  let finishSecond!: () => void;
  const imports = vi.spyOn(api, "importMedia")
    .mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishSecond = () => resolve({ media: video }); }));
  const container = document.createElement("div");
  const root = createRoot(container);
  function Panel() { return <MediaPage uploads={useUploader(PRJ)} onPlay={vi.fn()} />; }
  const choose = () => [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Choose files")!.click();
  try {
    await act(async () => root.render(<MemoryRouter><Panel /></MemoryRouter>));
    await act(async () => choose());
    expect(container.querySelector("progress")).toBeNull();
    await act(async () => choose());
    expect(container.textContent).toContain("File 1 of 2");
    expect(container.querySelector("progress")?.getAttribute("aria-label")).toBe("Import progress for bad.mov");
    expect(container.querySelector("progress")!.hasAttribute("value")).toBe(false);
    const importId = imports.mock.calls[0]![1].importId!;
    await act(() => dispatchWsEvent({ type: "media.import.checking", projectId: PRJ, importId, fraction: 0.42 }));
    expect(container.querySelector("progress")!.value).toBe(0.42);
    expect(container.textContent).toContain("Checking file · 42%");
    await act(async () => rejectFirst(new Error("Unreadable")));
    expect(container.textContent).toContain("File 2 of 2");
    await act(() => dispatchWsEvent({ type: "media.import.checking", projectId: PRJ, importId, fraction: 1 }));
    expect(container.querySelector("progress")!.hasAttribute("value")).toBe(false);
    await act(async () => finishSecond());
    expect(container.querySelector("progress")?.getAttribute("aria-label")).toBe("Preparation progress for clip.mov");
    expect(container.querySelector("progress")!.hasAttribute("value")).toBe(false);
    await act(() => dispatchWsEvent({ type: "media.updated", projectId: PRJ, media: { ...video, preparation: { stage: "preview", fraction: 0.6 } } }));
    expect(container.querySelectorAll("progress")).toHaveLength(1);
    expect(container.querySelector("progress")!.value).toBe(0.6);
    await act(() => dispatchWsEvent({ type: "media.updated", projectId: PRJ, media: { ...video, status: "ready" } }));
    expect(container.querySelector("progress")).toBeNull();
  } finally {
    await act(() => root.unmount());
    useProjectStore.setState(previous, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("adds a link like any file: its dialog closes at once, Media says it is downloading, and a link that failed is a row that says why", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const previous = useProjectStore.getState();
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  const arrived = { ...db.media[PRJ]!.find(m => m.kind === "video")!, id: "med_link", name: "interview.mp4", status: "ingesting" as const };
  useProjectStore.setState({ current: {
    id: PRJ, project, timeline: null, media: db.media[PRJ]!, changes: [], notes: [], renders: [], tasks: [], taskEvents: {}, versions: [],
  } });
  vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings, transcriptionAvailable: true });
  vi.spyOn(api, "sourceCaches").mockResolvedValue({ caches: [] });
  let fail!: () => void;
  let finish!: () => void;
  const imports = vi.spyOn(api, "importMedia")
    .mockImplementationOnce(() => new Promise((_, reject) => { fail = () => reject(new Error("Couldn’t download that URL: 404")); }))
    .mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ media: arrived }); }))
    .mockImplementationOnce(() => new Promise(() => {}));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Panel() { return <MediaPage uploads={useUploader(PRJ)} onPlay={vi.fn()} />; }
  const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === text)!;
  const add = async (link: string) => {
    await act(async () => button("Add from a link").click());
    const field = container.querySelector<HTMLInputElement>("#import-url")!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, link);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { container.querySelector<HTMLFormElement>("#import-link")!.requestSubmit(); });
  };
  /** The file being added, as its card reads: its name, its place in the batch, the step, and whether the bar has a share to show. */
  const adding = () => { const bar = container.querySelector('progress[aria-label^="Import progress"]'); const card = bar?.closest(".card");
    return card && [card.querySelector("span[title]")?.textContent, card.querySelector(".tnum.shrink-0")?.textContent, card.querySelector('[role="status"]')?.textContent, bar!.hasAttribute("value")]; };
  const drive = "https://drive.google.com/file/d/1Qx7mB2kPz9LrT4vN8cYwE6uJ/view?usp=sharing";
  try {
    await act(async () => root.render(<MemoryRouter><Panel /></MemoryRouter>));
    await add(drive);
    // The dialog is gone while the link still downloads. A Drive link has no file name in it, so it goes by the link.
    expect(container.querySelector("dialog")).toBeNull();
    expect(imports).toHaveBeenCalledExactlyOnceWith(PRJ, { url: drive, importId: expect.any(String) });
    expect(adding()).toEqual([drive, "File 1 of 1", "Downloading…", false]);
    // Nothing waits for it. Files can still be chosen, and another link joins the queue behind it. Until its turn
    // the card counts it, as it counts the files of one drop.
    expect(button("Add files").disabled).toBe(false);
    await add("https://example.com/clips/interview.mp4?token=abc");
    expect(container.querySelector("dialog")).toBeNull();
    expect(imports).toHaveBeenCalledOnce();
    expect(adding()).toEqual([drive, "File 1 of 2", "Downloading…", false]);
    // The first link failed. Its row says why, with a × that puts it away, and the next link's turn begins under the file name it ends in.
    await act(async () => fail());
    const failed = [...container.querySelectorAll("ul.mb-3 > li")].find(row => row.textContent?.includes(drive))!;
    expect([failed.querySelector(".truncate")?.textContent, failed.querySelector("span.text-bad")?.textContent, failed.querySelector("div.text-bad")?.textContent, failed.querySelector("button")?.getAttribute("aria-label")])
      .toEqual([drive, "Failed", "Couldn’t download that URL: 404", "Dismiss"]);
    expect(imports.mock.calls[1]).toEqual([PRJ, { url: "https://example.com/clips/interview.mp4?token=abc", importId: expect.any(String) }]);
    expect(adding()).toEqual(["interview.mp4", "File 2 of 2", "Downloading…", false]);
    // Downloaded, it is a file in the list like any other, being prepared.
    await act(async () => finish());
    expect(adding()).toBeFalsy();
    expect([...container.querySelectorAll(".media-row .media-file .truncate")].map(name => name.textContent)).toContain("interview.mp4");
    // The queue emptied, so the next link added is counted from one again.
    await add("https://example.com/clips/broll.mov");
    expect(adding()).toEqual(["broll.mov", "File 1 of 1", "Downloading…", false]);
  } finally {
    await act(() => root.unmount());
    container.remove();
    localStorage.removeItem("scarlet.imports.v1");
    useProjectStore.setState(previous, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("leaves Add files on after files are picked while a link downloads, until one of them is being copied in", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const previous = useProjectStore.getState();
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  const arrived = { ...db.media[PRJ]!.find(m => m.kind === "video")!, id: "med_link", name: "interview.mp4", status: "ingesting" as const };
  // A project of its own: a link an earlier test left downloading would still hold the fixture project's queue.
  const id = "prj_picks";
  useProjectStore.setState({ current: {
    id, project: { ...project, id }, timeline: null, media: db.media[PRJ]!, changes: [], notes: [], renders: [], tasks: [], taskEvents: {}, versions: [],
  } });
  vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings, transcriptionAvailable: true });
  vi.spyOn(api, "sourceCaches").mockResolvedValue({ caches: [] });
  vi.spyOn(client, "IS_DESKTOP", "get").mockReturnValue(true);
  vi.spyOn(desktop, "pickFiles").mockResolvedValue(["/media/clip.mov"]);
  let finish!: () => void;
  vi.spyOn(api, "importMedia")
    .mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ media: arrived }); }))
    .mockImplementation(() => new Promise(() => {}));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Panel() { return <MediaPage uploads={useUploader(id)} onPlay={vi.fn()} />; }
  const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === text)!;
  try {
    await act(async () => root.render(<MemoryRouter><Panel /></MemoryRouter>));
    await act(async () => button("Add from a link").click());
    const field = container.querySelector<HTMLInputElement>("#import-url")!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "https://example.com/clips/interview.mp4");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { container.querySelector<HTMLFormElement>("#import-link")!.requestSubmit(); });
    // Files picked while the link downloads wait behind it, and more can be picked meanwhile.
    await act(async () => button("Add files").click());
    expect(container.textContent).toContain("File 1 of 2");
    expect(button("Add files").disabled).toBe(false);
    // Once the link is in, the picked file is copied in, and that holds the picker until it is in.
    await act(async () => finish());
    expect(container.querySelector("progress")?.getAttribute("aria-label")).toBe("Import progress for clip.mov");
    expect(button("Add files").disabled).toBe(true);
  } finally {
    await act(() => root.unmount());
    container.remove();
    localStorage.removeItem("scarlet.imports.v1");
    useProjectStore.setState(previous, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("shows a video's cache and its transcription the same way, at the right of its row: a word, then a bar and a percent while the job runs", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const previous = useProjectStore.getState();
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  const base = { ...db.media[PRJ]!.find(m => m.kind === "video")!, transcriptId: undefined };
  const media = [{ ...base, id: "first", name: "first.mov" }, { ...base, id: "second", name: "second.mov" }];
  const task = (mediaId: string, progress: Task["progress"]): Task => ({
    ...db.tasks[0]!, id: `transcribe-${mediaId}`, projectId: PRJ, kind: "transcribe", agent: "api", context: { mediaId },
    state: "running", instruction: `Transcribe ${mediaId}`, progress,
  });
  useProjectStore.setState({ current: {
    id: PRJ, project, timeline: null, media, changes: [], notes: [], renders: [], taskEvents: {}, versions: [],
    tasks: [task("first", { stage: "transcribing", fraction: 0.1, remainingSeconds: 88 }), task("second", { stage: "queued", fraction: 0 })],
  } });
  vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings, transcriptionAvailable: true });
  vi.spyOn(api, "sourceCaches").mockResolvedValue({ caches: [
    { mediaId: "first", state: "caching", progress: 0.04, remainingSeconds: 312 }, { mediaId: "second", state: "uncached", queued: true },
  ] });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter><MediaPage onPlay={vi.fn()} uploads={{ items: [], start: vi.fn(), dismiss: vi.fn(), localImport: null, startPaths: vi.fn() }} /></MemoryRouter>));
    await act(async () => {});
    const [first, second] = [...container.querySelectorAll(".media-row")];
    // A job's line is its word, then its bar, then its percent, drawn by the same element for both jobs.
    const lines = (row: Element) => [...row.querySelectorAll(".media-jobs .media-status")].map(line => {
      const bar = line.querySelector("progress");
      return {
        text: [...line.children].map(part => part.textContent).filter(Boolean).join(" | "),
        said: line.querySelector('[role="status"]')!.getAttribute("aria-label"),
        bar: bar ? [bar.className, bar.getAttribute("aria-label"), bar.value] : null,
      };
    });
    expect(lines(first!)).toEqual([
      { text: "Caching | 4%", said: "first.mov: Caching · 4%", bar: ["activity-progress", "Caching first.mov", 0.04] },
      { text: "Transcribing | 10%", said: "first.mov: Transcribing · 10%", bar: ["activity-progress", "Transcribing first.mov", 0.1] },
    ]);
    expect(lines(second!)).toEqual([
      { text: "Waiting to cache", said: "second.mov: Waiting to cache", bar: null },
      { text: "Waiting to transcribe", said: "second.mov: Waiting to transcribe", bar: null },
    ]);
    // The file is at the left: its name, and under it its length. Nothing sits alone at the row's far right, and no time left is given.
    expect([...first!.children].map(part => part.className)).toEqual(["media-thumb-button", "media-file", "media-jobs"]);
    expect([...first!.querySelector(".media-file")!.children].map(part => part.textContent)).toEqual(["first.mov", "0:20"]);
    expect(first!.textContent).not.toMatch(/left|about/);
    expect(container.querySelector(".animate-spin")).toBeNull();

    // The words are saved and linked on the recording a third of the way in, and the job goes on aligning them.
    const aligning = (state: Task["state"]) => act(() => useProjectStore.setState(s => ({ current: { ...s.current!,
      media: [{ ...media[0]!, transcriptId: "trs_first" }, media[1]!],
      tasks: [{ ...task("first", { stage: "aligning", fraction: 0.4, remainingSeconds: 300 }), state }, s.current!.tasks[1]!] } })));
    await aligning("running");
    expect(lines(container.querySelector(".media-row")!)[1]).toEqual(
      { text: "Transcribing | 40%", said: "first.mov: Transcribing · 40%", bar: ["activity-progress", "Transcribing first.mov", 0.4] });
    // Once alignment finishes, the row offers to replace its saved transcript.
    await aligning("done");
    expect(lines(container.querySelector(".media-row")!)[1]).toEqual({ text: "Transcribed", said: "first.mov: Transcribed", bar: null });
  } finally {
    await act(() => root.unmount());
    useProjectStore.setState(previous, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("shows each video's playback cache and starts one on request", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const previous = useProjectStore.getState();
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  const base = db.media[PRJ]!.find(m => m.kind === "video")!;
  const media = [
    { ...base, id: "cached", name: "cached.mov" },
    { ...base, id: "caching", name: "caching.mov" },
    { ...base, id: "cold", name: "cold.mov" },
  ];
  useProjectStore.setState({ current: {
    id: PRJ, project, timeline: null, media, changes: [], notes: [], renders: [], tasks: [], taskEvents: {}, versions: [],
  } });
  vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings, transcriptionAvailable: true });
  const list = vi.spyOn(api, "sourceCaches").mockResolvedValue({ caches: [
    { mediaId: "cached", state: "ready" }, { mediaId: "caching", state: "caching", progress: 0.5 }, { mediaId: "cold", state: "uncached" },
  ] });
  const prepare = vi.spyOn(api, "sourceCache").mockResolvedValue({ state: "caching" });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter><MediaPage onPlay={vi.fn()} uploads={{ items: [], start: vi.fn(), dismiss: vi.fn(), localImport: null, startPaths: vi.fn() }} /></MemoryRouter>));
    await act(async () => {});
    const status = (name: string) => container.querySelector(`[aria-label^="${name}:"]`)?.textContent;
    // Finished jobs stay on the row, each a gray tick and its word.
    const cached = [...container.querySelectorAll('[aria-label^="cached.mov:"]')];
    expect(cached.map(line => [line.textContent, line.className, !!line.querySelector("svg")]))
      .toEqual([["Cached", "media-cache is-done", true], ["Transcribed", "media-cache is-done", true]]);
    expect(status("caching.mov")).toBe("Caching");
    expect(container.querySelector('[aria-label="caching.mov: Caching · 50%"]')?.closest(".media-status")?.querySelector(".media-pct")?.textContent).toBe("50%");
    expect(container.querySelector('progress[aria-label="Caching caching.mov"]')?.getAttribute("value")).toBe("0.5");
    expect(status("cold.mov")).toBe("Not cached");
    // The thumbnail previews the source; a row has no button of its own for it.
    expect([...container.querySelectorAll(".media-row")].map(row => row.querySelector(".media-thumb-button")?.getAttribute("aria-label")))
      .toEqual(["Preview source cached.mov", "Preview source caching.mov", "Preview source cold.mov"]);
    expect(container.querySelector(".media-row .btn-ghost")).toBeNull();
    const reads = list.mock.calls.length;
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Cache now")!.click());
    expect(prepare).toHaveBeenCalledWith("cold", true);
    expect(list.mock.calls.length).toBeGreaterThan(reads);
  } finally {
    await act(() => root.unmount());
    useProjectStore.setState(previous, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

/** Media open on a project with these files, with every cache and setting answered. */
async function showMedia(setup: { media: MediaAsset[]; tasks?: Task[]; caches?: SourceCacheStatus[]; mediaPaused?: boolean },
  check: (container: HTMLDivElement) => Promise<void>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const previous = useProjectStore.getState();
  const db = buildDb();
  const project = { ...db.projects.find(p => p.id === PRJ)!, mediaPaused: !!setup.mediaPaused };
  useProjectStore.setState({ current: {
    id: PRJ, project, timeline: null, media: setup.media, changes: [], notes: [], renders: [], tasks: setup.tasks ?? [], taskEvents: {}, versions: [],
  } });
  if (!vi.isMockFunction(api.settings)) vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings, transcriptionAvailable: true });
  vi.spyOn(api, "sourceCaches").mockResolvedValue({ caches: setup.caches ?? [] });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter><MediaPage onPlay={vi.fn()} uploads={{ items: [], start: vi.fn(), dismiss: vi.fn(), localImport: null, startPaths: vi.fn() }} /></MemoryRouter>));
    await act(async () => {});
    await check(container);
  } finally {
    await act(() => root.unmount());
    useProjectStore.setState(previous, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
}
const fixtureVideo = (extra: Partial<MediaAsset>): MediaAsset => ({ ...buildDb().media[PRJ]!.find(m => m.kind === "video")!, transcriptId: undefined, lastTranscription: undefined, ...extra });
/** A row's jobs as they read: each line's words and tone, and the buttons beside them. */
const jobs = (row: Element) => ({
  lines: [...row.querySelectorAll('.media-status [role="status"]')].map(line => [line.textContent, line.className]),
  actions: [...row.querySelectorAll(".media-jobs button, .media-jobs a")].map(action => action.textContent),
});

it("confirms a saved recording's replacement, shows its progress, and lets a failed job be retried", async () => {
  const video = fixtureVideo({ id: "camera", name: "camera.mov", transcriptId: "saved-transcript" });
  const settings = buildDb().settings;
  vi.spyOn(api, "settings").mockResolvedValue({ settings: { ...settings, transcription: { ...settings.transcription, provider: "openai" } }, transcriptionAvailable: true });
  const task: Task = { ...buildDb().tasks[0]!, id: "replace", projectId: PRJ, kind: "transcribe", agent: "api", state: "running",
    context: { mediaId: video.id }, instruction: "Transcribe camera.mov" };
  let accept!: () => void;
  const submit = vi.spyOn(api, "transcribe").mockImplementationOnce(() => new Promise(resolve => { accept = () => resolve({ task }); }))
    .mockResolvedValueOnce({ task: { ...task, id: "retry", createdAt: "2099-01-01T00:00:00Z", state: "done" } });
  await showMedia({ media: [video] }, async container => {
    const job = () => container.querySelector(".media-row .media-status:last-child")!;
    const action = () => job().querySelector<HTMLButtonElement>("button")!;
    const dialog = () => container.querySelector("dialog");
    const choose = (label: string) => act(async () => [...dialog()!.querySelectorAll("button")].find(b => b.textContent === label)!.click());
    expect(action().getAttribute("aria-label")).toBe("Re-transcribe");
    expect(action().textContent).toBe("");
    await act(async () => action().click());
    expect(dialog()!.querySelector("h2")?.textContent).toBe("Re-transcribe “camera.mov”?");
    expect(dialog()!.textContent).toContain("replace this file’s saved words and timings");
    expect(dialog()!.textContent).toContain("Its audio will be sent to OpenAI.");
    await choose("Cancel");
    expect(submit).not.toHaveBeenCalled();
    expect(job().querySelector('[role="status"]')?.textContent).toBe("Transcribed");

    await act(async () => action().click());
    const confirm = [...dialog()!.querySelectorAll("button")].find(b => b.textContent === "Re-transcribe")!;
    await act(async () => { confirm.click(); confirm.click(); });
    expect(submit).toHaveBeenCalledExactlyOnceWith(video.id);
    expect(dialog()).toBeNull();
    expect(job().textContent).toContain("Transcribing");
    expect(job().querySelector("button")).toBeNull();
    await act(async () => accept());
    expect(job().querySelector("button")).toBeNull();
    await act(() => useProjectStore.setState(s => ({ current: { ...s.current!, tasks: [{ ...task, state: "failed", error: "Model could not be opened." }] } })));
    expect(job().querySelector('[role="status"]')?.textContent).toBe("Model could not be opened.");
    expect(action().textContent).toBe("Retry");
    await act(async () => action().click());
    await choose("Re-transcribe");
    expect(submit.mock.calls).toEqual([[video.id], [video.id]]);
    expect(job().querySelector('[role="status"]')?.textContent).toBe("Transcribed");
    expect(action().getAttribute("aria-label")).toBe("Re-transcribe");
    expect(action().textContent).toBe("");
  });
});

it("describes the saved transcript’s actual model and local completion time on hover and keyboard focus", async () => {
  const completedAt = "2026-02-17T19:43:26.000Z";
  const model = "Whisper large-v3-turbo";
  const saved = fixtureVideo({ id: "camera", transcriptId: "saved", lastTranscription: { completedAt, model } });
  const readWords = vi.spyOn(api, "transcript");
  await showMedia({ media: [saved] }, async container => {
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Re-transcribe"]')!;
    const tip = () => container.querySelector('[role="tooltip"]');
    const pointer = (type: string) => act(() => { button.dispatchEvent(new PointerEvent(type, { pointerType: "mouse", bubbles: true })); });
    const focus = (type: string) => act(() => { button.dispatchEvent(new FocusEvent(type, { bubbles: true })); });
    expect(button.textContent).toBe("");
    expect(button.querySelector("svg")).not.toBeNull();
    expect(tip()).toBeNull();
    await pointer("pointerover");
    expect(tip()?.id).toBe(button.getAttribute("aria-describedby"));
    expect(tip()?.textContent).toContain(model);
    expect(tip()?.querySelector("time")?.dateTime).toBe(completedAt);
    expect(tip()?.querySelector("time")?.textContent).toBe(new Date(completedAt).toLocaleString());
    await pointer("pointerout");
    expect(tip()).toBeNull();

    await focus("focusin");
    expect(tip()?.textContent).toContain(model);
    await act(() => { button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(tip()).toBeNull();
    await focus("focusout");
    await focus("focusin");
    expect(tip()).not.toBeNull();
    await focus("focusout");
    expect(tip()).toBeNull();
    expect(readWords).not.toHaveBeenCalled();
  });
});

it("shows the recorded date and model independently for older transcripts", async () => {
  const completedAt = "2026-02-17T19:43:26.000Z";
  const media = [
    fixtureVideo({ id: "dated", transcriptId: "one", lastTranscription: { completedAt } }),
    fixtureVideo({ id: "modeled", transcriptId: "two", lastTranscription: { model: "Custom local model" } }),
    fixtureVideo({ id: "older", transcriptId: "three" }),
  ];
  await showMedia({ media }, async container => {
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Re-transcribe"]')];
    expect(buttons).toHaveLength(media.length);
    for (const [index, button] of buttons.entries()) {
      await act(() => { button.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
      const tip = container.querySelector('[role="tooltip"]')!;
      expect(tip.textContent).toContain(index === 0 ? new Date(completedAt).toLocaleString() : "Transcription date not recorded");
      expect(tip.textContent).toContain(index === 1 ? "Custom local model" : "Model not recorded");
      await act(() => { button.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    }
  });
});

it("explains a paused or unavailable replacement and never offers it for a silent file", async () => {
  const camera = fixtureVideo({ id: "camera", name: "camera.mov", transcriptId: "saved-transcript" });
  const silent = fixtureVideo({ id: "silent", name: "silent.mov", transcriptId: "old", hasAudio: false });
  const submit = vi.spyOn(api, "transcribe");
  await showMedia({ media: [camera, silent], mediaPaused: true }, async container => {
    const [recording, silentRow] = [...container.querySelectorAll(".media-row")];
    expect(silentRow!.querySelector('[aria-label="Re-transcribe"]')).toBeNull();
    const action = recording!.querySelector<HTMLButtonElement>('button[aria-label="Re-transcribe"]')!;
    expect(action.getAttribute("aria-disabled")).toBe("true");
    expect(recording!.textContent).toContain("Transcribed · caching paused");
    await act(() => action.click());
    expect(container.querySelector("dialog")).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });
  vi.spyOn(api, "settings").mockResolvedValue({ settings: buildDb().settings, transcriptionAvailable: false });
  await showMedia({ media: [camera] }, async container => {
    const job = container.querySelector(".media-row .media-status:last-child")!;
    expect(job.textContent).toContain("Transcribed");
    expect(job.querySelector("a")?.textContent).toBe("Set up transcription");
    expect(job.querySelector("button")).toBeNull();
  });
});

it("reads a transcription the pause stopped as paused, in the gray of its paused cache, with nothing to retry", async () => {
  const stopped: Task = {
    ...buildDb().tasks[0]!, id: "transcribe-cam", projectId: PRJ, kind: "transcribe", agent: "api", context: { mediaId: "cam" },
    state: "failed", interrupted: true, error: "Transcription was interrupted.", instruction: "Transcribe cam.mov",
  };
  const setup = { media: [fixtureVideo({ id: "cam", name: "cam.mov" })], tasks: [stopped], caches: [{ mediaId: "cam", state: "uncached" as const, queued: true }] };
  await showMedia({ ...setup, mediaPaused: true }, async container => {
    expect(jobs(container.querySelector(".media-row")!)).toEqual({
      lines: [["Caching paused", "media-cache is-idle"], ["Transcription paused", "media-cache is-idle"]], actions: [],
    });
    // Not paused, a run still cut off is a failure the editor can retry.
    await act(() => useProjectStore.setState(s => ({ current: { ...s.current!, project: { ...s.current!.project, mediaPaused: false } } })));
    expect(jobs(container.querySelector(".media-row")!)).toMatchObject({
      lines: [["Waiting to cache", "media-cache is-busy"], ["Transcription was interrupted.", "media-cache is-bad"]], actions: ["Retry"],
    });
  });
  // A transcription that failed by itself says so while the project is paused too.
  await showMedia({ ...setup, tasks: [{ ...stopped, interrupted: undefined, error: "The model could not be opened." }], mediaPaused: true }, async container => {
    expect(jobs(container.querySelector(".media-row")!).lines[1]).toEqual(["The model could not be opened.", "media-cache is-bad"]);
  });
});

it("says a file it couldn’t read, and why, in the word and apostrophe every error has", async () => {
  await showMedia({ media: [fixtureVideo({ id: "cam", name: "cam.mov", status: "failed", error: "No video stream." })] }, async container => {
    expect(container.querySelector(".media-meta")?.textContent).toBe("Couldn’t read this file: No video stream.");
  });
});

it("shows a file being read as the first job at its row's right, a step, a bar and a percent, and writes a length as the player does", async () => {
  const reading = fixtureVideo({ id: "cam", name: "cam.mov", duration: 3727, status: "ingesting", preparation: { stage: "fingerprint", fraction: 0.42, remainingSeconds: 185 } });
  const media = [reading, fixtureVideo({ id: "mic", name: "mic.mov", duration: 59.6 })];
  await showMedia({ media, caches: [{ mediaId: "mic", state: "caching", progress: 0.3 }] }, async container => {
    const rows = () => [...container.querySelectorAll(".media-row")];
    const [cam, mic] = rows();
    // Under its name a file has its length, read as a time on the player: 1:02:07, not 1h 2m.
    expect(rows().map(row => [...row.querySelector(".media-file")!.children].map(part => part.textContent))).toEqual([["cam.mov", "1:02:07"], ["mic.mov", "0:59"]]);
    // Reading is a job like the cache and the transcript: its step, then its bar, then its percent, in the same element.
    const line = (row: Element) => { const first = row.querySelector(".media-jobs .media-status")!; const bar = first.querySelector("progress");
      return [first.className, [...first.children].map(part => part.textContent), bar && [bar.className, bar.getAttribute("aria-label"), bar.value]]; };
    expect(line(cam!)).toEqual(["media-status has-bar", ["Checking file", "", "42%"], ["activity-progress", "Preparation progress for cam.mov", 0.42]]);
    expect(line(mic!)).toEqual(["media-status has-bar", ["Caching", "", "30%"], ["activity-progress", "Caching mic.mov", 0.3]]);
    expect(cam!.querySelector('.media-jobs [role="status"]')!.getAttribute("aria-label")).toBe("cam.mov: Checking file · 42%");
    expect(jobs(cam!)).toEqual({ lines: [["Checking file", "media-cache is-busy"]], actions: [] });
    // No bar sits under the name, and nothing guesses how long is left.
    expect(cam!.querySelectorAll("progress")).toHaveLength(1);
    expect(cam!.textContent).not.toMatch(/left|about|Estimating|Finishing/);
    // Until the engine reports a step the bar runs without a value, and once the file is read the job goes.
    await act(() => useProjectStore.setState(s => ({ current: { ...s.current!, media: [{ ...reading, preparation: undefined }, media[1]!] } })));
    expect(line(rows()[0]!)).toEqual(["media-status has-bar", ["Preparing footage…", "", ""], ["activity-progress", "Preparation progress for cam.mov", 0]]);
    expect(rows()[0]!.querySelector("progress")!.hasAttribute("value")).toBe(false);
    await act(() => useProjectStore.setState(s => ({ current: { ...s.current!, media: [{ ...reading, status: "ready" as const, preparation: undefined }, media[1]!] } })));
    expect(jobs(rows()[0]!)).toEqual({ lines: [["No transcript", "media-cache is-idle"]], actions: ["Transcribe"] });
  });
});

it("says a file's read is paused while the project is, in the gray of its paused cache, with no bar or percent", async () => {
  const reading = fixtureVideo({ id: "cam", name: "cam.mov", status: "ingesting", preparation: { stage: "fingerprint", fraction: 0.42 } });
  await showMedia({ media: [reading], caches: [], mediaPaused: true }, async container => {
    const row = () => container.querySelector(".media-row")!;
    // The engine holds the read until resume: a step with a bar and a percent would only stand still.
    expect(jobs(row())).toEqual({ lines: [["Reading paused", "media-cache is-idle"]], actions: [] });
    expect(row().querySelector(".media-jobs .media-status")!.className).toBe("media-status");
    expect(row().querySelector("progress")).toBeNull();
    expect(row().querySelector(".media-jobs")!.textContent).not.toMatch(/%|Checking/);
    // A file added while paused has no step yet, and reads the same.
    await act(() => useProjectStore.setState(s => ({ current: { ...s.current!, media: [{ ...reading, preparation: undefined }] } })));
    expect(jobs(row()).lines[0]).toEqual(["Reading paused", "media-cache is-idle"]);
    expect(row().querySelector("progress")).toBeNull();
    // Resumed, the read is under way again and says its step.
    await act(() => useProjectStore.setState(s => ({ current: { ...s.current!, media: [reading], project: { ...s.current!.project, mediaPaused: false } } })));
    expect(jobs(row()).lines[0]).toEqual(["Checking file", "media-cache is-busy"]);
    expect(row().querySelector("progress")!.value).toBe(0.42);
  });
});

it("offers no transcript for a video with no audio track", async () => {
  const media = [fixtureVideo({ id: "screen", name: "screen.mov", hasAudio: false }), fixtureVideo({ id: "cam", name: "cam.mov" })];
  await showMedia({ media, caches: media.map(m => ({ mediaId: m.id, state: "ready" as const })) }, async container => {
    const [screen, cam] = [...container.querySelectorAll(".media-row")].map(jobs);
    expect(screen).toEqual({ lines: [["Cached", "media-cache is-done"]], actions: [] });
    expect(cam).toEqual({ lines: [["Cached", "media-cache is-done"], ["No transcript", "media-cache is-idle"]], actions: ["Transcribe"] });
  });
});

it("asks before taking a file Scarlet couldn't read out of the project, from a small × on its row, and says in the dialog why the engine won't", async () => {
  const media = [fixtureVideo({ id: "cam", name: "cam.mov" }), fixtureVideo({ id: "broken", name: "broken.mov", status: "failed", error: "moov atom not found" })];
  const refusal = "broken.mov is in the video or its history, so it can’t be removed.";
  let refuse!: () => void;
  const remove = vi.spyOn(api, "removeMedia").mockImplementationOnce(() => new Promise((_, reject) => { refuse = () => reject(new Error(refusal)); })).mockResolvedValueOnce({});
  // An older error stays in the page's line: a removal neither hides behind it nor leaves one of its own there.
  vi.spyOn(api, "sourceCache").mockRejectedValue(new Error("The disk is full."));
  await showMedia({ media, caches: [{ mediaId: "cam", state: "uncached" }] }, async container => {
    const rows = () => [...container.querySelectorAll(".media-row")];
    const x = () => container.querySelector<HTMLButtonElement>(".media-remove")!;
    const dialog = () => container.querySelector("dialog");
    const press = (name: string) => act(async () => [...dialog()!.querySelectorAll("button")].find(b => b.textContent === name)!.click());
    const pageLine = () => [...container.querySelectorAll('[role="alert"]')].filter(line => !dialog()?.contains(line)).map(line => line.textContent);
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".media-jobs button")].find(b => b.textContent === "Cache now")!.click());
    expect(pageLine()).toEqual(["The disk is full."]);
    // Only the file that couldn't be read has it, after its jobs at the row's end. It has no text: hovering names it.
    expect(rows().map(row => row.lastElementChild!.className)).toEqual(["media-jobs", "edit-card-icon media-remove"]);
    expect(rows()[1]!.querySelector(".media-meta")?.textContent).toBe("Couldn’t read this file: moov atom not found");
    expect([x().textContent, x().getAttribute("aria-label"), x().title, x().previousElementSibling?.className]).toEqual(["", "Remove broken.mov", "Remove", "media-jobs"]);

    // The project's copy is deleted with it, so the press asks first, as Move to Trash does. Cancel leaves everything.
    await act(async () => x().click());
    expect(remove).not.toHaveBeenCalled();
    expect([dialog()!.querySelector("h2")?.textContent, dialog()!.querySelector(".text-muted")?.textContent, [...dialog()!.querySelectorAll("button:not([data-close])")].map(b => [b.textContent, b.className])])
      .toEqual(["Remove “broken.mov”?", "Scarlet deletes the project's copy of this file. This cannot be undone.", [["Cancel", "btn-ghost"], ["Remove", "btn-danger"]]]);
    await press("Cancel");
    expect([dialog(), remove.mock.calls.length, rows().length]).toEqual([null, 0, 2]);

    // The engine refuses a file the video or its history still uses. The dialog says why, and the row stays.
    await act(async () => x().click());
    await press("Remove");
    expect([...dialog()!.querySelectorAll<HTMLButtonElement>("button:not([data-close])")].map(b => b.disabled)).toEqual([true, true]);
    await act(async () => refuse());
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toBe(refusal);
    expect(pageLine()).toEqual(["The disk is full."]);
    expect(rows()).toHaveLength(2);
    // The refusal goes with its dialog: asked again, the dialog opens without it, and the page never shows it.
    await press("Cancel");
    await act(async () => x().click());
    expect(dialog()!.querySelector('[role="alert"]')).toBeNull();
    // Once it can go, the dialog closes and the row leaves.
    await press("Remove");
    expect(remove.mock.calls).toEqual([[PRJ, "broken"], [PRJ, "broken"]]);
    expect(dialog()).toBeNull();
    expect(rows().map(row => row.querySelector(".media-file .truncate")?.textContent)).toEqual(["cam.mov"]);
    expect(pageLine()).toEqual(["The disk is full."]);
  });
});

it("takes a still's thumbnail from its first frame and a short clip's from its middle", async () => {
  const still = buildDb().media[PRJ]!.find(m => m.kind === "image")!;
  const media = [fixtureVideo({ id: "long", duration: 20 }), fixtureVideo({ id: "short", duration: 1.2 }), { ...still, id: "still" }];
  vi.spyOn(api, "frameUrl").mockImplementation((id, t, w) => `frame:${id}@${t}s/${w}`);
  await showMedia({ media }, async container => {
    // A still has no frame a second in, and neither has a clip shorter than that.
    expect([...container.querySelectorAll("img.media-thumb")].map(img => img.getAttribute("src")))
      .toEqual(["frame:long@1s/320", "frame:short@0.6s/320", "frame:still@0s/320"]);
  });
});

it("says nothing about where audio goes until the settings answer", async () => {
  const db = buildDb();
  let answer!: (settings: Awaited<ReturnType<typeof api.settings>>) => void;
  vi.spyOn(api, "settings").mockReturnValue(new Promise(resolve => { answer = resolve; }));
  await showMedia({ media: [fixtureVideo({ id: "cam", name: "cam.mov" })] }, async container => {
    // The OpenAI notice would flash here each time Media opens, also for an editor who transcribes on this computer.
    const notice = () => [...container.querySelectorAll("p")].find(p => /transcri/i.test(p.textContent ?? ""));
    expect(notice()).toBeUndefined();
    expect(container.querySelector("#media-file-types")?.textContent).toMatch(/MP4.*WAV.*JPEG/);
    await act(async () => answer({ settings: { ...db.settings, transcription: { ...db.settings.transcription, provider: "openai" } }, transcriptionAvailable: true }));
    expect(notice()?.textContent).toBe("Audio from imported files is sent to OpenAI for transcription.");
  });
});
