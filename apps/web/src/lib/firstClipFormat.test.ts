// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { contentHash, createProject, emptyTimeline, type MediaAsset, type Project } from "@scarlet/timeline";
import { api } from "./client";
import { canResumeFirstClip, matchFirstClip, resumeFirstClip } from "./firstClipFormat";
import { addPendingImports, pendingImports } from "./pendingImports";
import { useProjectStore } from "../stores/project";

const initial = useProjectStore.getState();
afterEach(() => {
  useProjectStore.setState(initial, true);
  localStorage.clear();
  vi.restoreAllMocks();
});

const clip = (changes: Partial<MediaAsset>) => ({ id: "med_clip", name: "clip.mov", path: "clip.mov", kind: "video", ...changes }) as MediaAsset;
const onScreen = (project: Project) => useProjectStore.setState({ current: {
  id: project.id, project, timeline: null, media: [], changes: [], notes: [], renders: [], tasks: [], taskEvents: {},
} });
const setsFormat = (project: Project) => pendingImports(project.id).map(i => !!i.setsFormat);

it("gives a new project the format of its first video and leaves later files out of it", async () => {
  const project = createProject("Interview");
  const update = vi.spyOn(api, "updateProject").mockResolvedValue({ project });
  addPendingImports(project.id, ["/clips/voice.wav", "/clips/scope.mov", "/clips/tall.mov"], true);
  // Another new project's first files are waiting too, for a format of its own.
  const other = createProject("Elsewhere");
  addPendingImports(other.id, ["/clips/wide.mov"], true);
  const match = matchFirstClip(project);
  await match(clip({ kind: "audio" }));
  await match(clip({ kind: "image", width: 4000, height: 3000 }));
  expect(update).not.toHaveBeenCalled();
  expect(setsFormat(project)).toEqual([true, true, true]);
  await match(clip({ width: 2048, height: 858, fps: 23.976 }));
  expect(update).toHaveBeenCalledExactlyOnceWith(project.id,
    { settings: { width: 2048, height: 858, aspect: "custom", fps: 23.976 }, expectedFormat: { settings: project.settings, head: null } });
  expect(setsFormat(project)).toEqual([false, false, false]);
  expect(setsFormat(other)).toEqual([true]);
  await match(clip({ width: 1080, height: 1920, fps: 60 }));
  expect(update).toHaveBeenCalledTimes(1);
});

it("says why a new project's format wasn't matched, and says nothing for a file resumed after a quit", async () => {
  const project = createProject("Interview");
  const update = vi.spyOn(api, "updateProject").mockRejectedValue(new Error("Engine disconnected"));
  addPendingImports(project.id, ["/clips/wide.mov", "/clips/tall.mov"], true);
  await expect(matchFirstClip(project)(clip({ width: 1280, height: 720 }))).rejects.toThrow("Couldn’t match the first clip’s format: Engine disconnected");
  expect(setsFormat(project)).toEqual([false, false]);

  localStorage.clear();
  addPendingImports(project.id, ["/clips/wide.mov", "/clips/tall.mov"], true);
  onScreen(project);
  await resumeFirstClip(project.id)!(clip({ width: 1280, height: 720 }));
  expect(update).toHaveBeenCalledTimes(2);
  expect(setsFormat(project)).toEqual([false, false]);
});

it("resumes the match only for a project that is still as it was created", async () => {
  const project = createProject("Interview");
  const update = vi.spyOn(api, "updateProject").mockResolvedValue({ project });
  addPendingImports(project.id, ["/clips/wide.mov"], true);
  // Another project is on screen, so there is nothing to compare: the file keeps its mark and has to wait.
  onScreen(createProject("Elsewhere"));
  expect(canResumeFirstClip(project.id)).toBe(false);
  expect(resumeFirstClip(project.id)).toBeUndefined();
  expect(setsFormat(project)).toEqual([true]);

  for (const changed of [
    { ...project, head: "ver_first" },
    { ...project, settings: { ...project.settings, fps: 24 } },
    { ...project, settings: { ...project.settings, aspect: "9:16" as const, width: 1080, height: 1920 } },
  ]) {
    localStorage.clear();
    addPendingImports(project.id, ["/clips/wide.mov"], true);
    onScreen(changed);
    // Its format stands, so the file has nothing to wait for.
    expect(canResumeFirstClip(project.id)).toBe(true);
    expect(resumeFirstClip(project.id)).toBeUndefined();
    expect(setsFormat(project)).toEqual([false]);
  }
  expect(update).not.toHaveBeenCalled();

  localStorage.clear();
  addPendingImports(project.id, ["/clips/wide.mov"], true);
  onScreen(project);
  await resumeFirstClip(project.id)!(clip({ width: 1280, height: 720, fps: 60 }));
  expect(update).toHaveBeenCalledExactlyOnceWith(project.id,
    { settings: { width: 1280, height: 720, aspect: "16:9", fps: 60 }, expectedFormat: { settings: project.settings, head: null } });
});

it("resumes the first video's format when the engine saved an empty timeline", async () => {
  const project = createProject("Interview");
  project.head = contentHash(emptyTimeline(project.id), ["version", "parent", "createdAt"]).slice(0, 16);
  onScreen(project);
  addPendingImports(project.id, ["/clips/phone.mov"], true);
  const update = vi.spyOn(api, "updateProject").mockResolvedValue({ project });
  await resumeFirstClip(project.id)!(clip({ width: 720, height: 1280 }));
  expect(update).toHaveBeenCalledExactlyOnceWith(project.id,
    { settings: { width: 720, height: 1280, aspect: "9:16" }, expectedFormat: { settings: project.settings, head: project.head } });
});
