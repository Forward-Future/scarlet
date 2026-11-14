// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { createProject, type MediaAsset, type Project } from "@scarlet/timeline";

const importLocalFile = vi.hoisted(() => vi.fn(async (_projectId: string, path: string) => ({ id: `med_${path.length}`, name: path.split("/").pop()!, kind: "video", path } as unknown as MediaAsset)));
const store = vi.hoisted(() => ({ upsertMedia: vi.fn(), updateProject: vi.fn(async () => {}), current: null as { id: string; project: Project } | null }));
vi.mock("../../lib/upload", () => ({ importLocalFile, uploadMedia: vi.fn() }));
vi.mock("../../stores/project", () => ({ useProjectStore: { getState: () => store } }));

const SAVED = "scarlet.imports.v1";

beforeEach(() => {
  localStorage.clear();
  importLocalFile.mockClear();
  store.upsertMedia.mockClear();
  store.updateProject.mockClear();
  store.current = null;
  vi.resetModules();
});

/** Scarlet quit with `saved` on this computer. The next launch starts from that alone. */
async function relaunch(saved: string) {
  vi.resetModules();
  importLocalFile.mockClear();
  localStorage.setItem(SAVED, saved);
  return import("./UploadDropzone");
}

const video = (name: string, width: number, height: number, fps: number) => ({ id: `med_${name}`, name, kind: "video", path: name, width, height, fps }) as MediaAsset;

/** Queue files, hold the first one mid-copy, and return what a quit at that moment leaves saved. */
async function savedMidImport(projectId: string, paths: string[], firstFiles?: Project) {
  const { enqueueImports } = await import("./UploadDropzone");
  const { matchFirstClip } = await import("../../lib/firstClipFormat");
  let release!: () => void;
  importLocalFile.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ id: "med_held", name: "held" } as unknown as MediaAsset); }));
  const job = enqueueImports(projectId, paths, firstFiles && matchFirstClip(firstFiles));
  await vi.waitFor(() => expect(importLocalFile).toHaveBeenCalledTimes(1));
  const saved = localStorage.getItem(SAVED)!;
  release();
  await job;
  return saved;
}

it("remembers imports until each file is in the project, and carries on with the rest after a quit", async () => {
  const { enqueueImports } = await import("./UploadDropzone");
  const { pendingImports } = await import("../../lib/pendingImports");
  let release!: () => void;
  importLocalFile.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ id: "med_a", name: "a.mov" } as unknown as MediaAsset); }));
  const job = enqueueImports("prj", ["/clips/a.mov", "/clips/b.mov", "https://example.com/c.mp4"]);
  await vi.waitFor(() => expect(importLocalFile).toHaveBeenCalledTimes(1));
  expect(pendingImports("prj").map(i => i.source)).toEqual(["/clips/a.mov", "/clips/b.mov", "https://example.com/c.mp4"]);
  const saved = localStorage.getItem("scarlet.imports.v1")!;
  release();
  await job;
  expect(pendingImports("prj")).toEqual([]);

  // Scarlet quit while the first file was copying. The next launch starts from what was saved.
  vi.resetModules();
  importLocalFile.mockClear();
  // The quit came a little after that snapshot: b.mov's copy had begun as well.
  localStorage.setItem("scarlet.imports.v1", JSON.stringify(JSON.parse(saved).map((i: { source: string }) => i.source === "/clips/b.mov" ? { ...i, started: true } : i)));
  const relaunched = await import("./UploadDropzone");
  const at = JSON.parse(saved)[0].at as string;
  // b.mov reached the project just before the quit, so it isn't added twice.
  await relaunched.resumeImports("prj", [{ id: "med_b", name: "b.mov", kind: "video", path: "med_b.mov", provenance: { by: "human", createdAt: at } } as MediaAsset]);
  expect(importLocalFile.mock.calls.map(call => call[1])).toEqual(["/clips/a.mov", "https://example.com/c.mp4"]);
  expect((await import("../../lib/pendingImports")).pendingImports("prj")).toEqual([]);
  // Reopening the project again finds nothing left to do.
  importLocalFile.mockClear();
  await relaunched.resumeImports("prj", []);
  expect(importLocalFile).not.toHaveBeenCalled();
});

it("downloads a link once however often its project reopens, and again after a quit unless its file had arrived", async () => {
  const { enqueueImports, resumeImports } = await import("./UploadDropzone");
  const { pendingImports } = await import("../../lib/pendingImports");
  const link = "https://example.com/clips/interview.mp4?token=abc";
  let finish!: () => void;
  importLocalFile.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ id: "med_link", name: "interview.mp4" } as unknown as MediaAsset); }));
  const added = enqueueImports("prj", [link]);
  await vi.waitFor(() => expect(importLocalFile).toHaveBeenCalledTimes(1));
  expect(pendingImports("prj").map(i => i.source)).toEqual([link]);
  const saved = localStorage.getItem(SAVED)!;
  // The editor leaves the project and comes back while the link is still downloading.
  await resumeImports("prj", []);
  expect(importLocalFile).toHaveBeenCalledExactlyOnceWith("prj", link, expect.any(Function), JSON.parse(saved)[0].importId, false);
  finish();
  await added;
  expect(store.upsertMedia).toHaveBeenCalledExactlyOnceWith("prj", expect.objectContaining({ id: "med_link" }));
  expect(pendingImports("prj")).toEqual([]);

  // A link that failed isn't tried again when the project reopens.
  importLocalFile.mockRejectedValueOnce(new Error("Unreachable"));
  await enqueueImports("prj", [link]);
  expect(pendingImports("prj")).toEqual([]);
  importLocalFile.mockClear();
  await resumeImports("prj", []);
  expect(importLocalFile).not.toHaveBeenCalled();

  // Scarlet quit mid-download. The next launch starts the link again.
  const relaunched = await relaunch(saved);
  await relaunched.resumeImports("prj", []);
  expect(importLocalFile.mock.calls.map(call => call[1])).toEqual([link]);
  expect((await import("../../lib/pendingImports")).pendingImports("prj")).toEqual([]);

  // The quit came just after the file arrived instead. The engine named it for the link's last part, so it isn't downloaded twice.
  const arrived = await relaunch(saved);
  await arrived.resumeImports("prj", [{ id: "med_link", name: "interview.mp4", kind: "video", path: "med_link.mp4", importId: JSON.parse(saved)[0].importId } as MediaAsset]);
  expect(importLocalFile).not.toHaveBeenCalled();
  expect((await import("../../lib/pendingImports")).pendingImports("prj")).toEqual([]);
});

it("matches a new project's format to its first video after a quit interrupted the import, once", async () => {
  const project = createProject("Interview");
  const saved = await savedMidImport(project.id, ["/clips/a.mov", "/clips/b.mov"], project);
  expect(JSON.parse(saved).map((i: { source: string; setsFormat?: boolean }) => [i.source, i.setsFormat])).toEqual([["/clips/a.mov", true], ["/clips/b.mov", true]]);

  // Scarlet quit while the first file was copying. The project reopens as it was created.
  const relaunched = await relaunch(saved);
  store.current = { id: project.id, project };
  let finishSecond!: () => void;
  importLocalFile.mockResolvedValueOnce(video("a.mov", 720, 1280, 24))
    .mockImplementationOnce(() => new Promise(resolve => { finishSecond = () => resolve(video("b.mov", 3840, 2160, 60)); }));
  const resumed = relaunched.resumeImports(project.id, []);
  await vi.waitFor(() => expect(importLocalFile).toHaveBeenCalledTimes(2));
  expect(importLocalFile.mock.calls.map(call => call[1])).toEqual(["/clips/a.mov", "/clips/b.mov"]);
  expect(store.updateProject).toHaveBeenCalledExactlyOnceWith(
    { settings: { width: 720, height: 1280, aspect: "9:16", fps: 24 }, expectedFormat: { settings: project.settings, head: null } }, project.id);
  // The format is settled, so the file still copying no longer sets it, in this launch or the next.
  const savedAgain = localStorage.getItem(SAVED)!;
  expect(JSON.parse(savedAgain)).toEqual([{ projectId: project.id, source: "/clips/b.mov", at: expect.any(String), started: true, importId: expect.any(String) }]);
  finishSecond();
  await resumed;
  const again = await relaunch(savedAgain);
  importLocalFile.mockResolvedValueOnce(video("b.mov", 3840, 2160, 60));
  await again.resumeImports(project.id, []);
  expect(importLocalFile.mock.calls.map(call => call[1])).toEqual(["/clips/b.mov"]);
  expect(store.updateProject).toHaveBeenCalledTimes(1);
});

it("matches the format to a first file that reached the project just before the quit", async () => {
  const project = createProject("Interview");
  const saved = await savedMidImport(project.id, ["/clips/a.mov", "/clips/b.mov"], project);
  const relaunched = await relaunch(saved);
  store.current = { id: project.id, project };
  importLocalFile.mockResolvedValueOnce(video("b.mov", 3840, 2160, 60));
  const arrived = { ...video("a.mov", 1080, 1080, 30), importId: JSON.parse(saved)[0].importId };
  await relaunched.resumeImports(project.id, [arrived]);
  expect(importLocalFile.mock.calls.map(call => call[1])).toEqual(["/clips/b.mov"]);
  expect(store.updateProject).toHaveBeenCalledExactlyOnceWith(
    { settings: { width: 1080, height: 1080, aspect: "1:1", fps: 30 }, expectedFormat: { settings: project.settings, head: null } }, project.id);
});

it("keeps the first file recoverable through a second quit while its format is being applied", async () => {
  const project = createProject("Interview");
  const saved = await savedMidImport(project.id, ["/clips/a.mov"], project);
  const { resumeImports } = await relaunch(saved);
  store.current = { id: project.id, project };
  const asset = { ...video("a.mov", 720, 1280, 24), importId: JSON.parse(saved)[0].importId };
  let finish!: () => void;
  store.updateProject.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const resume = resumeImports(project.id, [asset]);
  await vi.waitFor(() => expect(store.updateProject).toHaveBeenCalledOnce());
  const again = localStorage.getItem(SAVED);
  await resumeImports(project.id, [asset]);
  finish();
  await resume;
  expect(again).toBe(saved);
  expect(store.updateProject).toHaveBeenCalledOnce();
  expect(localStorage.getItem(SAVED)).toBeNull();
  const relaunched = await relaunch(again!);
  await relaunched.resumeImports(project.id, [asset]);
  expect(store.updateProject).toHaveBeenCalledTimes(2);
  expect(importLocalFile).not.toHaveBeenCalled();
});

it("imports a file still waiting its turn though one of the same name arrived meanwhile, and not the one whose copy had begun", async () => {
  const project = createProject("Two cameras");
  // The copy of the first clip had begun when Scarlet quit; the second, same name from another folder, was still waiting.
  const saved = await savedMidImport(project.id, ["/camera-a/clip.mov", "/camera-b/clip.mov"]);
  expect(JSON.parse(saved).map((i: { started?: boolean }) => i.started)).toEqual([true, false]);
  const relaunched = await relaunch(saved);
  const arrived = { ...video("clip.mov", 1920, 1080, 30), importId: JSON.parse(saved)[0].importId };
  await relaunched.resumeImports(project.id, [arrived]);
  expect(importLocalFile.mock.calls.map(call => call[1])).toEqual(["/camera-b/clip.mov"]);
  expect(localStorage.getItem(SAVED)).toBeNull();
});

it("copies a path once while it is queued and allows the same path to be added again afterwards", async () => {
  const { enqueueImports } = await import("./UploadDropzone");
  const source = "/camera/clip.mov";
  let finish!: () => void;
  importLocalFile.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(video("clip.mov", 1920, 1080, 30)); }));
  const first = enqueueImports("prj", [source, source]);
  const repeated = enqueueImports("prj", [source]);
  await vi.waitFor(() => expect(importLocalFile).toHaveBeenCalledTimes(1));
  const saved = JSON.parse(localStorage.getItem(SAVED)!);
  finish();
  await Promise.all([first, repeated]);
  expect(saved).toHaveLength(1);
  expect(importLocalFile).toHaveBeenCalledTimes(1);
  await enqueueImports("prj", [source]);
  expect(importLocalFile).toHaveBeenCalledTimes(2);
});

it("resumes camera B when the project already has a different clip with the same name", async () => {
  const saved = await savedMidImport("prj", ["/camera-b/clip.mov"]);
  const { resumeImports } = await relaunch(saved);
  const other = { ...video("clip.mov", 1920, 1080, 30), provenance: { by: "human", createdAt: JSON.parse(saved)[0].at } } as MediaAsset;
  await resumeImports("prj", [other]);
  expect(importLocalFile.mock.calls.map(call => call[1])).toEqual(["/camera-b/clip.mov"]);
});

it("recognizes a finished download after a restart when the server supplied a different filename", async () => {
  const saved = await savedMidImport("prj", ["https://example.com/download"]);
  const { resumeImports } = await relaunch(saved);
  const { importId } = JSON.parse(saved)[0];
  const downloaded = { ...video("Interview.mov", 1920, 1080, 30), importId };
  await resumeImports("prj", [downloaded]);
  expect(importLocalFile).not.toHaveBeenCalled();
  expect(localStorage.getItem(SAVED)).toBeNull();
});

it.each([
  ["was edited", (project: Project): Project => ({ ...project, head: "ver_first" })],
  ["was given another format", (project: Project): Project => ({ ...project, settings: { ...project.settings, fps: 24 } })],
])("keeps the format of a project that %s before the quit", async (_, change) => {
  const project = createProject("Interview");
  const saved = await savedMidImport(project.id, ["/clips/a.mov", "/clips/b.mov"], project);
  const relaunched = await relaunch(saved);
  store.current = { id: project.id, project: change(project) };
  importLocalFile.mockResolvedValueOnce(video("a.mov", 720, 1280, 24));
  await relaunched.resumeImports(project.id, []);
  expect(importLocalFile.mock.calls.map(call => call[1])).toEqual(["/clips/a.mov", "/clips/b.mov"]);
  expect(store.updateProject).not.toHaveBeenCalled();
});

it("keeps a new project's first files saved while another project is on screen, and matches its format once it opens", async () => {
  const project = createProject("Interview");
  const at = "2026-11-06T20:00:00.000Z";
  const first = ["/clips/voice.wav", "/clips/a.mov"].map(source => ({ projectId: project.id, source, at, setsFormat: true }));
  const { resumeImports } = await relaunch(JSON.stringify([...first, { projectId: project.id, source: "/clips/extra.mov", at }]));
  // voice.wav reached the project just before the quit.
  const voice = { id: "med_voice", name: "voice.wav", kind: "audio", path: "voice.wav", provenance: { by: "human", createdAt: at } } as MediaAsset;
  // Another project has the screen, so nothing shows whether this one is still new. Only the file added later carries on.
  const elsewhere = createProject("Elsewhere");
  store.current = { id: elsewhere.id, project: elsewhere };
  await resumeImports(project.id, [voice]);
  expect(importLocalFile.mock.calls.map(call => call[1])).toEqual(["/clips/extra.mov"]);
  expect(importLocalFile).toHaveBeenCalledWith(project.id, "/clips/extra.mov", expect.any(Function), expect.any(String), true);
  expect(JSON.parse(localStorage.getItem(SAVED)!)).toEqual(first);
  expect(store.updateProject).not.toHaveBeenCalled();

  // The project opens as it was created.
  store.current = { id: project.id, project };
  importLocalFile.mockClear();
  importLocalFile.mockResolvedValueOnce(video("a.mov", 720, 1280, 24));
  await resumeImports(project.id, [voice]);
  expect(importLocalFile.mock.calls.map(call => call[1])).toEqual(["/clips/a.mov"]);
  expect(importLocalFile).toHaveBeenCalledWith(project.id, "/clips/a.mov", expect.any(Function), expect.any(String), false);
  expect(store.updateProject).toHaveBeenCalledExactlyOnceWith(
    { settings: { width: 720, height: 1280, aspect: "9:16", fps: 24 }, expectedFormat: { settings: project.settings, head: null } }, project.id);
  expect(localStorage.getItem(SAVED)).toBeNull();
});

it("still imports first files that waited for their project when it opens no longer new, and keeps its format", async () => {
  const project = createProject("Interview");
  const first = { projectId: project.id, source: "/clips/a.mov", at: "2026-11-06T20:00:00.000Z", setsFormat: true };
  const { resumeImports } = await relaunch(JSON.stringify([first]));
  // No project is on screen yet.
  await resumeImports(project.id, []);
  expect(importLocalFile).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem(SAVED)!)).toEqual([first]);

  // The project opens with an edit made before the quit.
  store.current = { id: project.id, project: { ...project, head: "ver_first" } };
  importLocalFile.mockResolvedValueOnce(video("a.mov", 720, 1280, 24));
  await resumeImports(project.id, []);
  expect(importLocalFile.mock.calls.map(call => call[1])).toEqual(["/clips/a.mov"]);
  expect(store.updateProject).not.toHaveBeenCalled();
  expect(localStorage.getItem(SAVED)).toBeNull();
});

it("leaves the format alone when the files waiting weren't a new project's first", async () => {
  const project = createProject("Interview");
  const saved = await savedMidImport(project.id, ["/clips/extra.mov"]);
  const relaunched = await relaunch(saved);
  // The project is still as it was created, so its format would follow a first file.
  store.current = { id: project.id, project };
  importLocalFile.mockResolvedValueOnce(video("extra.mov", 720, 1280, 24));
  await relaunched.resumeImports(project.id, []);
  expect(importLocalFile.mock.calls.map(call => call[1])).toEqual(["/clips/extra.mov"]);
  expect(store.updateProject).not.toHaveBeenCalled();
});

it("lets only a new project's first files set its format, not one added behind them", async () => {
  const project = createProject("Interview");
  const { enqueueImports } = await import("./UploadDropzone");
  const { matchFirstClip } = await import("../../lib/firstClipFormat");
  let release!: () => void;
  importLocalFile.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ id: "med_held", name: "held" } as unknown as MediaAsset); }));
  const first = enqueueImports(project.id, ["/clips/voice.wav"], matchFirstClip(project));
  const later = enqueueImports(project.id, ["/clips/extra.mov"]);
  await vi.waitFor(() => expect(importLocalFile).toHaveBeenCalledTimes(1));
  const saved = localStorage.getItem(SAVED)!;
  release();
  await Promise.all([first, later]);

  const relaunched = await relaunch(saved);
  store.current = { id: project.id, project };
  const voice = { id: "med_voice", name: "voice.wav", kind: "audio", path: "voice.wav" } as MediaAsset;
  importLocalFile.mockResolvedValueOnce(voice).mockResolvedValueOnce(video("extra.mov", 720, 1280, 24));
  await relaunched.resumeImports(project.id, []);
  expect(importLocalFile.mock.calls.map(call => call[1])).toEqual(["/clips/voice.wav", "/clips/extra.mov"]);
  // The first selection only had audio, so the next file can now supply the first video.
  expect(importLocalFile).toHaveBeenCalledWith(project.id, "/clips/extra.mov", expect.any(Function), expect.any(String), false);
  expect(store.updateProject).not.toHaveBeenCalled();

  // The file added later can also have reached the project before the quit, with the first one still to come.
  const again = await relaunch(JSON.stringify(JSON.parse(saved).map((i: { source: string }) => i.source === "/clips/extra.mov" ? { ...i, started: true } : i)));
  importLocalFile.mockResolvedValueOnce(voice);
  const arrived = { ...video("extra.mov", 720, 1280, 24), provenance: { by: "human", createdAt: JSON.parse(saved)[1].at as string } } as MediaAsset;
  await again.resumeImports(project.id, [arrived]);
  expect(importLocalFile.mock.calls.map(call => call[1])).toEqual(["/clips/voice.wav"]);
  expect(store.updateProject).not.toHaveBeenCalled();
});

it("carries on with a list saved before first files were marked", async () => {
  const at = "2026-11-06T20:00:00.000Z";
  localStorage.setItem(SAVED, JSON.stringify([
    { projectId: "prj", source: "/clips/a.mov", at }, { projectId: "other", source: "/clips/z.mov", at }, { projectId: "prj", source: "https://example.com/c.mp4", at },
  ]));
  const { resumeImports } = await import("./UploadDropzone");
  const { pendingImports } = await import("../../lib/pendingImports");
  expect(pendingImports("prj")).toEqual([{ projectId: "prj", source: "/clips/a.mov", at }, { projectId: "prj", source: "https://example.com/c.mp4", at }]);
  await resumeImports("prj", []);
  expect(importLocalFile.mock.calls.map(call => call[1])).toEqual(["/clips/a.mov", "https://example.com/c.mp4"]);
  expect(pendingImports("prj")).toEqual([]);
  expect(pendingImports("other")).toEqual([{ projectId: "other", source: "/clips/z.mov", at }]);
});

it("carries on with files saved with a garbled mark, and doesn't let them set the format", async () => {
  const project = createProject("Interview");
  const at = "2026-11-06T20:00:00.000Z";
  const { resumeImports } = await relaunch(JSON.stringify([
    { projectId: project.id, source: "/clips/a.mov", at, setsFormat: "true" }, { projectId: project.id, source: "/clips/b.mov", at, setsFormat: null },
  ]));
  const { pendingImports } = await import("../../lib/pendingImports");
  expect(pendingImports(project.id)).toEqual([{ projectId: project.id, source: "/clips/a.mov", at }, { projectId: project.id, source: "/clips/b.mov", at }]);
  // The project is still as it was created, so its format would follow a first file.
  store.current = { id: project.id, project };
  importLocalFile.mockResolvedValueOnce(video("a.mov", 720, 1280, 24));
  await resumeImports(project.id, []);
  expect(importLocalFile.mock.calls.map(call => call[1])).toEqual(["/clips/a.mov", "/clips/b.mov"]);
  expect(store.updateProject).not.toHaveBeenCalled();
  expect(pendingImports(project.id)).toEqual([]);
});

it("keeps interrupted files and links across a restart, with the same import ID and one retry", async () => {
  const { enqueueImports } = await import("./UploadDropzone");
  const { pendingImports } = await import("../../lib/pendingImports");
  const { ScarletApiError } = await import("@scarlet/shared");
  const path = "/clips/a.mov";
  const link = "https://example.com/b.mov";
  importLocalFile.mockRejectedValueOnce(new ScarletApiError(503, "http_error", ""));
  await enqueueImports("prj", [path, link]);
  expect(importLocalFile.mock.calls.map(call => call[1])).toEqual([path]);
  const [first, next] = pendingImports("prj");
  expect(first).toMatchObject({ source: path, interrupted: true, importId: expect.any(String) });
  expect(next).toMatchObject({ source: link, started: false });

  const resumed = await relaunch(localStorage.getItem(SAVED)!);
  importLocalFile.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  await resumed.resumeImports("prj", []);
  expect(importLocalFile).toHaveBeenCalledExactlyOnceWith("prj", path, expect.any(Function), first!.importId, false);
  expect(pendingImports("prj").map(i => i.source)).toEqual([link]);
  await resumed.resumeImports("prj", []);
  expect(importLocalFile.mock.calls.at(-1)?.[1]).toBe(link);
  expect(pendingImports("prj")).toEqual([]);
});

it("resumes when the new project's read arrives before the old import reports the disconnect", async () => {
  const { enqueueImports, resumeImports } = await import("./UploadDropzone");
  const { api } = await import("../../lib/client");
  vi.spyOn(api, "media").mockResolvedValue({ media: [] });
  let reject!: (reason: Error) => void;
  importLocalFile.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  const job = enqueueImports("prj", ["/a.mov", "/b.mov"]);
  await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
  await resumeImports("prj", []);
  reject(new TypeError("Failed to fetch"));
  await job;
  await vi.waitFor(() => expect(importLocalFile.mock.calls.map(call => call[1])).toEqual(["/a.mov", "/a.mov", "/b.mov"]));
  expect((await import("../../lib/pendingImports")).pendingImports("prj")).toEqual([]);
});

it("keeps the retry for the next engine when a project read preceded the outage", async () => {
  const { enqueueImports, resumeImports } = await import("./UploadDropzone");
  const { pendingImports } = await import("../../lib/pendingImports");
  const { api } = await import("../../lib/client");
  const offline = new TypeError("Failed to fetch");
  vi.spyOn(api, "media").mockRejectedValue(offline);
  let disconnect!: (reason: Error) => void;
  let online = false;
  importLocalFile.mockImplementationOnce(() => new Promise((_resolve, reject) => { disconnect = reject; }))
    .mockImplementationOnce(async () => {
      if (!online) throw offline;
      return video("a.mov", 1920, 1080, 24);
    });
  const job = enqueueImports("prj", ["/a.mov"]);
  await vi.waitFor(() => expect(disconnect).toBeTypeOf("function"));
  const importId = pendingImports("prj")[0]!.importId;
  // Reopening the project during the copy can finish long before the engine goes down.
  await resumeImports("prj", []);
  disconnect(offline);
  await job;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(importLocalFile).toHaveBeenCalledTimes(1);
  expect(pendingImports("prj")).toMatchObject([{ source: "/a.mov", importId, interrupted: true }]);

  online = true;
  await resumeImports("prj", []);
  expect(importLocalFile).toHaveBeenLastCalledWith("prj", "/a.mov", expect.any(Function), importId, false);
  expect(importLocalFile).toHaveBeenCalledTimes(2);
  expect(pendingImports("prj")).toEqual([]);
});
