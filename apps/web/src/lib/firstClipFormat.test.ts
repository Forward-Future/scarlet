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

it("waits for every first file, then gives a new project the best format among their videos", async () => {
  const project = createProject("Demo");
  const update = vi.spyOn(api, "updateProject").mockResolvedValue({ project });
  addPendingImports(project.id, ["/clips/voice.wav", "/clips/screen.mp4", "/clips/tall.mov", "/clips/camera.mp4", "/clips/hd.mov"], true);
  // Another new project's first files are waiting too, for a format of its own.
  const other = createProject("Elsewhere");
  addPendingImports(other.id, ["/clips/wide.mov"], true);
  const match = matchFirstClip(project);
  match.add(clip({ kind: "audio" }));
  match.add(clip({ kind: "image", width: 4000, height: 3000 }));
  match.add(clip({ width: 3024, height: 1964, fps: 60 }));
  match.add(clip({ width: 1080, height: 1920, fps: 30 }));
  match.add(clip({ width: 3840, height: 2160, fps: 59.94 }));
  match.add(clip({ width: 1920, height: 1080, fps: 30 }));
  // Nothing is set while files are still coming in.
  expect(update).not.toHaveBeenCalled();
  expect(setsFormat(project)).toEqual([true, true, true, true, true]);
  await match.settle();
  expect(update).toHaveBeenCalledExactlyOnceWith(project.id,
    { settings: { width: 3840, height: 2160, aspect: "16:9", fps: 59.94 }, expectedFormat: { settings: project.settings, head: null } });
  expect(setsFormat(project)).toEqual([false, false, false, false, false]);
  expect(setsFormat(other)).toEqual([true]);
});

it("leaves the format alone when the first files hold no video", async () => {
  const project = createProject("Podcast");
  const update = vi.spyOn(api, "updateProject").mockResolvedValue({ project });
  addPendingImports(project.id, ["/clips/voice.wav"], true);
  const match = matchFirstClip(project);
  match.add(clip({ kind: "audio" }));
  await match.settle();
  expect(update).not.toHaveBeenCalled();
  expect(setsFormat(project)).toEqual([false]);
});

it("chooses the same format whatever order the first videos come in", async () => {
  const videos = [{ width: 3024, height: 1964 }, { width: 3840, height: 2160 }, { width: 1080, height: 1920 }, { width: 1920, height: 1080 },
    { width: 2048, height: 858 }, { width: 1080, height: 1080 }];
  const orders = (list: typeof videos): (typeof videos)[] => list.length < 2 ? [list]
    : list.flatMap((v, i) => orders([...list.slice(0, i), ...list.slice(i + 1)]).map(rest => [v, ...rest]));
  const update = vi.spyOn(api, "updateProject").mockResolvedValue({ project: createProject("Demo") });
  for (const order of orders(videos)) {
    const match = matchFirstClip(createProject("Demo"));
    for (const size of order) match.add(clip(size));
    await match.settle();
    expect(update.mock.lastCall?.[1].settings).toEqual({ width: 3840, height: 2160, aspect: "16:9" });
  }
  expect(update).toHaveBeenCalledTimes(720);
  // Without 16:9, a published shape still beats a screen's or a film's own, and 9:16 comes before 1:1.
  update.mockClear();
  const match = matchFirstClip(createProject("Demo"));
  for (const size of [{ width: 3024, height: 1964 }, { width: 1080, height: 1080 }, { width: 720, height: 1280 }, { width: 2048, height: 858 }]) match.add(clip(size));
  await match.settle();
  expect(update.mock.lastCall?.[1].settings).toEqual({ width: 720, height: 1280, aspect: "9:16" });
});

it("says why a new project's format wasn't set, and says nothing for files resumed after a quit", async () => {
  const project = createProject("Interview");
  const update = vi.spyOn(api, "updateProject").mockRejectedValue(new Error("Engine disconnected"));
  addPendingImports(project.id, ["/clips/wide.mov", "/clips/tall.mov"], true);
  const match = matchFirstClip(project);
  match.add(clip({ width: 1280, height: 720 }));
  await expect(match.settle()).rejects.toThrow("Couldn’t set the project’s format from its videos: Engine disconnected");
  expect(setsFormat(project)).toEqual([false, false]);

  localStorage.clear();
  addPendingImports(project.id, ["/clips/wide.mov", "/clips/tall.mov"], true);
  onScreen(project);
  const resumed = resumeFirstClip(project.id)!;
  resumed.add(clip({ width: 1280, height: 720 }));
  await resumed.settle();
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
  const resumed = resumeFirstClip(project.id)!;
  resumed.add(clip({ width: 3024, height: 1964, fps: 60 }));
  resumed.add(clip({ width: 1280, height: 720, fps: 60 }));
  await resumed.settle();
  expect(update).toHaveBeenCalledExactlyOnceWith(project.id,
    { settings: { width: 1280, height: 720, aspect: "16:9", fps: 60 }, expectedFormat: { settings: project.settings, head: null } });
});

it("resumes the match when the engine saved an empty timeline", async () => {
  const project = createProject("Interview");
  project.head = contentHash(emptyTimeline(project.id), ["version", "parent", "createdAt"]).slice(0, 16);
  onScreen(project);
  addPendingImports(project.id, ["/clips/phone.mov"], true);
  const update = vi.spyOn(api, "updateProject").mockResolvedValue({ project });
  const resumed = resumeFirstClip(project.id)!;
  resumed.add(clip({ width: 720, height: 1280 }));
  await resumed.settle();
  expect(update).toHaveBeenCalledExactlyOnceWith(project.id,
    { settings: { width: 720, height: 1280, aspect: "9:16" }, expectedFormat: { settings: project.settings, head: project.head } });
});
