// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import type { ProjectSummary } from "@scarlet/shared";
import { createProject, type MediaAsset, type Project } from "@scarlet/timeline";

const importLocalFile = vi.hoisted(() => vi.fn());
const store = vi.hoisted(() => ({
  upsertMedia: vi.fn(), updateProject: vi.fn(async () => {}),
  current: null as { id: string; project: Project; media: MediaAsset[] } | null,
}));
vi.mock("../../lib/upload", () => ({ importLocalFile, uploadMedia: vi.fn() }));
vi.mock("../../stores/project", () => ({ useProjectStore: { getState: () => store } }));

beforeEach(() => {
  localStorage.clear();
  importLocalFile.mockReset();
  store.updateProject.mockClear();
  store.current = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

const video = (name: string, width: number, height: number, fps: number) => ({ id: `med_${name}`, name, kind: "video", path: name, width, height, fps }) as MediaAsset;
const summary = (project: Project, changes: Partial<ProjectSummary> = {}): ProjectSummary =>
  ({ id: project.id, name: project.name, settings: project.settings, head: project.head ?? null, mediaCount: 0, poster: null, pendingChanges: 0, openNotes: 0, ...changes });

/** The uploader of the project's screen, or of its card when `card` is given. */
async function uploader(projectId: string, card?: ProjectSummary) {
  const { useUploader } = await import("./UploadDropzone");
  let uploads!: ReturnType<typeof useUploader>;
  function Probe() { uploads = useUploader(projectId, card); return null; }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  return { uploads, unmount: () => act(async () => root.unmount()) };
}

/** Add files by path the way the project's screen or its card does, and wait for them to arrive. */
async function addFiles(projectId: string, paths: string[], card?: ProjectSummary) {
  const { uploads, unmount } = await uploader(projectId, card);
  await uploads.startPaths(paths);
  await unmount();
}

it("gives a project created empty the format of the first video added on its screen, once", async () => {
  const project = createProject("Interview");
  store.current = { id: project.id, project, media: [] };
  importLocalFile.mockResolvedValueOnce({ id: "med_voice", name: "voice.wav", kind: "audio", path: "voice.wav" })
    .mockResolvedValueOnce(video("camera.mp4", 3840, 2160, 29.97)).mockResolvedValueOnce(video("phone.mov", 1080, 1920, 60));
  await addFiles(project.id, ["/clips/voice.wav", "/clips/camera.mp4", "/clips/phone.mov"]);
  expect(store.updateProject).toHaveBeenCalledExactlyOnceWith(
    { settings: { width: 3840, height: 2160, aspect: "16:9", fps: 29.97 }, expectedFormat: { settings: project.settings, head: null } }, project.id);
});

it("leaves the format alone when the project already has a video, an edit or a format of its own", async () => {
  const project = createProject("Interview");
  for (const current of [
    { project, media: [video("first.mp4", 1920, 1080, 30)] },
    { project: { ...project, head: "ver_first" }, media: [] },
    { project: { ...project, settings: { ...project.settings, aspect: "9:16" as const, width: 1080, height: 1920 } }, media: [] },
  ]) {
    store.current = { id: project.id, ...current };
    importLocalFile.mockResolvedValueOnce(video("camera.mp4", 3840, 2160, 29.97));
    await addFiles(project.id, ["/clips/camera.mp4"]);
  }
  expect(importLocalFile).toHaveBeenCalledTimes(3);
  expect(store.updateProject).not.toHaveBeenCalled();
});

it("gives a project created empty the format of the first video dropped on its card", async () => {
  const project = createProject("Interview");
  // Another project is on screen.
  const other = createProject("Elsewhere");
  store.current = { id: other.id, project: other, media: [] };
  importLocalFile.mockResolvedValueOnce(video("camera.mp4", 3840, 2160, 29.97));
  await addFiles(project.id, ["/clips/camera.mp4"], summary(project));
  expect(store.updateProject).toHaveBeenCalledExactlyOnceWith(
    { settings: { width: 3840, height: 2160, aspect: "16:9", fps: 29.97 }, expectedFormat: { settings: project.settings, head: null } }, project.id);

  // A card whose project has a video already, or whose engine doesn't name it and has files, keeps its format.
  store.updateProject.mockClear();
  for (const card of [summary(project, { mediaCount: 1, poster: { mediaId: "med_first", time: 2 } }), summary(project, { mediaCount: 1, poster: undefined })]) {
    importLocalFile.mockResolvedValueOnce(video("camera.mp4", 3840, 2160, 29.97));
    await addFiles(project.id, ["/clips/camera.mp4"], card);
  }
  expect(store.updateProject).not.toHaveBeenCalled();
});

it("leaves the match to a new project's first files still waiting, so files added behind them don't set its format", async () => {
  const project = createProject("Interview");
  store.current = { id: project.id, project, media: [] };
  const { enqueueImports } = await import("./UploadDropzone");
  const { matchFirstClip } = await import("../../lib/firstClipFormat");
  let release!: () => void;
  importLocalFile.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(video("wide.mov", 1280, 720, 24)); }))
    .mockResolvedValueOnce(video("tall.mov", 1080, 1920, 60));
  const first = enqueueImports(project.id, ["/clips/wide.mov"], matchFirstClip(project));
  await vi.waitFor(() => expect(importLocalFile).toHaveBeenCalledTimes(1));
  const { uploads, unmount } = await uploader(project.id);
  const later = uploads.startPaths(["/clips/tall.mov"]);
  release();
  await Promise.all([first, later]);
  await unmount();
  expect(store.updateProject).toHaveBeenCalledExactlyOnceWith(
    { settings: { width: 1280, height: 720, aspect: "16:9", fps: 24 }, expectedFormat: { settings: project.settings, head: null } }, project.id);
});
