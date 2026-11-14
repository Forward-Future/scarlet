// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fullRenderContext, ScarletApiError, type Render } from "@scarlet/shared";
import { startAppLog, stopAppLog } from "./appLog";
import { api } from "./client";
import { desktop } from "./desktop";
import { exportCounting, exportFailureSeen, exportFile, resumeExports, useExports, type ExportFile, type ExportJob } from "./exportJobs";
import { buildDb, PRJ } from "./mock/fixtures";
import { useProjectStore, type ProjectData } from "../stores/project";
import { useUiStore } from "../stores/ui";

const initial = useProjectStore.getState();
const NAME = "My private film.mp4";
const DESTINATION = { ticket: 4, path: `/Users/me/Movies/${NAME}` };
let project: ProjectData;
let render: Render;
let lines: string[], levels: string[];
const job = () => useExports.getState().jobs[PRJ];
const video: ExportFile = { name: NAME, format: "mp4", video: { kind: "export", quality: "delivery" } };
/** Everything the desktop and the engine are asked while an export runs. */
const answers = () => ({
  keep: vi.spyOn(desktop, "keepVideoExport").mockResolvedValue(),
  discard: vi.spyOn(desktop, "discardVideoExport").mockResolvedValue(),
  save: vi.spyOn(desktop, "finishVideoExport").mockResolvedValue(DESTINATION.path),
  release: vi.spyOn(api, "releaseRender").mockResolvedValue(),
  request: vi.spyOn(api, "requestRender").mockImplementation(async () => ({ render })),
});
let asked: ReturnType<typeof answers>;

beforeEach(() => {
  const db = buildDb();
  const found = db.projects.find(p => p.id === PRJ)!;
  project = { id: PRJ, project: found, timeline: db.timelines[found.head!]!, media: found.media, changes: [], notes: [], tasks: [], renders: [], taskEvents: {} };
  render = { ...db.renders[0]!, id: "rnd_export", projectId: PRJ, version: found.head!, kind: "export", quality: "delivery", range: null, state: "running", progress: 0.3, projectSettings: found.settings };
  useProjectStore.setState({ current: project, status: "ready" });
  useExports.setState({ jobs: {} });
  localStorage.clear();
  useUiStore.setState({ exportStarNotice: "unseen" });
  lines = [];
  levels = [];
  startAppLog((batch, level) => { for (const line of batch) { lines.push(line.replace(/^(\[\w+\]) \S+ \S+ /, "$1 ")); levels.push(level); } });
  asked = answers();
  vi.spyOn(desktop, "chooseVideoExport").mockResolvedValue(DESTINATION);
});
afterEach(() => {
  stopAppLog();
  useProjectStore.setState(initial, true);
  vi.restoreAllMocks();
});

it("saves a finished render to the place the editor picked and tells the engine the export is settled", async () => {
  render = { ...render, state: "done", progress: 1 };
  await exportFile(project, video);
  expect(asked.keep).toHaveBeenCalledExactlyOnceWith(4);
  expect(asked.request).toHaveBeenCalledExactlyOnceWith(PRJ, expect.objectContaining({ kind: "export", quality: "delivery", version: project.project.head, export: { name: NAME, ...DESTINATION } }));
  expect(asked.save).toHaveBeenCalledExactlyOnceWith(4, api.renderFileUrl("rnd_export"));
  // The result says which video it is the export of.
  expect(job()).toEqual({ phase: "done", path: DESTINATION.path, context: fullRenderContext(project.project) });
  expect(asked.release).toHaveBeenCalledExactlyOnceWith("rnd_export", asked.request.mock.calls[0]![1].owner);
  // The ticket was used up by the save: there is nothing left to discard, and nothing went wrong to log.
  expect(asked.discard).not.toHaveBeenCalled();
  expect(lines).toEqual([]);
  // The first video saved offers the star, once.
  expect(useUiStore.getState().exportStarNotice).toBe("visible");
});

it("exports under the name the editor gave the file in the save dialog, not the one the dialog opened on", async () => {
  render = { ...render, state: "done", progress: 1 };
  const picked = { ticket: 6, path: "/Users/me/Movies/Renamed in the dialog.mp4" };
  vi.mocked(desktop.chooseVideoExport).mockResolvedValue(picked);
  await exportFile(project, video);
  expect(desktop.chooseVideoExport).toHaveBeenCalledExactlyOnceWith(NAME);
  expect(asked.request).toHaveBeenCalledExactlyOnceWith(PRJ, expect.objectContaining({ export: { name: "Renamed in the dialog.mp4", ...picked } }));
});

it("does nothing for a project with no edit yet, or when the editor closes the save dialog", async () => {
  await exportFile({ ...project, project: { ...project.project, head: null } }, video);
  expect(desktop.chooseVideoExport).not.toHaveBeenCalled();
  vi.mocked(desktop.chooseVideoExport).mockResolvedValue(null);
  await exportFile(project, video);
  expect(job()).toBeUndefined();
  expect(asked.request).not.toHaveBeenCalled();
  expect(lines).toEqual([]);
});

it("saves a timeline file straight from the engine, with no render", async () => {
  vi.mocked(desktop.chooseVideoExport).mockResolvedValue({ ticket: 12, path: "/Users/me/cut.otio" });
  await exportFile(project, { name: "cut.otio", format: "otio", video: { kind: "export", quality: "delivery" } });
  expect(asked.request).not.toHaveBeenCalled();
  expect(asked.save).toHaveBeenCalledExactlyOnceWith(12, api.otioUrl(PRJ, project.project.head!));
  expect(job()).toMatchObject({ phase: "done" });
  // Only a video export offers the star.
  expect(useUiStore.getState().exportStarNotice).toBe("unseen");
});

it.each([
  ["failed", "ffmpeg ran out of disk", "ffmpeg ran out of disk"],
  ["failed", undefined, "The render stopped."],
  ["cancelled", undefined, "The render stopped."],
] as const)("fails the export when its render %s, with the engine's reason when it gave one", async (state, error, shown) => {
  render = { ...render, state, error };
  await exportFile(project, video);
  expect(job()).toMatchObject({ phase: "failed", error: shown, file: video });
  expect(asked.save).not.toHaveBeenCalled();
  // The picked place is let go once the engine knows.
  expect(asked.release).toHaveBeenCalledTimes(1);
  expect(asked.discard).toHaveBeenCalledExactlyOnceWith(4);
  expect(lines).toEqual([`[error] export phase=rendering format=mp4 error=${JSON.stringify(shown)}`]);
  expect(levels).toEqual(["warn"]);
});

it("fails when the edit changed while the save dialog was open, before anything is rendered", async () => {
  vi.mocked(desktop.chooseVideoExport).mockImplementation(async () => {
    useProjectStore.setState({ current: { ...project, project: { ...project.project, head: "another-version" } } });
    return DESTINATION;
  });
  await exportFile(project, video);
  expect(job()).toMatchObject({ phase: "failed", error: "The video changed. Export again to use the latest version." });
  expect(asked.request).not.toHaveBeenCalled();
  expect(asked.discard).toHaveBeenCalledExactlyOnceWith(4);
  expect(lines).toEqual(['[error] export phase=choosing format=mp4 error="The video changed. Export again to use the latest version."']);
});

it("fails when the engine hands back a render for something other than what was asked", async () => {
  render = { ...render, state: "done", version: "another-version" };
  await exportFile(project, video);
  expect(job()).toMatchObject({ phase: "failed", error: "The export no longer matches the video." });
  expect(asked.save).not.toHaveBeenCalled();
});

it("keeps the file's name and its folder out of the log when the save fails", async () => {
  render = { ...render, state: "done" };
  asked.save.mockRejectedValue(new Error(`Could not write ${DESTINATION.path}: disk full`));
  await exportFile(project, video);
  expect(job()).toMatchObject({ phase: "failed", error: `Could not write ${DESTINATION.path}: disk full` });
  expect(lines).toEqual(['[error] export phase=saving format=mp4 error="Could not write …: disk full"']);
  // The save's ticket was not used up, so it is discarded.
  expect(asked.discard).toHaveBeenCalledExactlyOnceWith(4);
});

it("keeps a place picked in the save dialog out of the log too: the name the editor gave the file there, and its folder", async () => {
  render = { ...render, state: "done" };
  const picked = { ticket: 4, path: "/Users/me/Client work/Renamed secret.mp4" };
  vi.mocked(desktop.chooseVideoExport).mockResolvedValue(picked);
  asked.save.mockRejectedValue(new Error(`Could not write ${picked.path}: disk full`));
  await exportFile(project, video);
  expect(job()).toMatchObject({ phase: "failed", error: `Could not write ${picked.path}: disk full` });
  // A failure that names another file beside it (the partial save), with the address it was read from.
  useExports.setState({ jobs: {} });
  asked.save.mockRejectedValue(`Permission denied (os error 13) at path /Users/me/Client work/.tmpAbC123 from http://127.0.0.1:4100/api/renders/rnd_export/file?token=s3cret ${"x".repeat(400)}`);
  await exportFile(project, video);
  expect(lines).toEqual([
    '[error] export phase=saving format=mp4 error="Could not write …: disk full"',
    expect.stringMatching(/^\[error\] export phase=saving format=mp4 error="Permission denied \(os error 13\) at path …\/\.tmpAbC123 from … x+…"$/),
  ]);
  expect(lines[1]!.length).toBeLessThan(360);
});

it("keeps a left-over export's place out of the log when its save fails", async () => {
  const kept: Render = { ...render, id: "rnd_kept", state: "done", export: { owner: "11111111-1111-4111-8111-111111111111", name: NAME, ticket: 7, path: "/Users/me/Client work/Renamed secret.mp4" } };
  vi.spyOn(api, "exports").mockResolvedValue({ renders: [kept] });
  asked.save.mockRejectedValue("Could not write /Users/me/Client work/Renamed secret.mp4: disk full");
  await resumeExports();
  await vi.waitFor(() => expect(asked.release).toHaveBeenCalledTimes(1));
  expect(lines).toEqual(['[error] export phase=saving format=mp4 resumed=true error="Could not write …: disk full"']);
});

it("leaves the picked place for the next launch when the engine can't be told the export is settled", async () => {
  render = { ...render, state: "failed" };
  asked.release.mockRejectedValue(new TypeError("Load failed"));
  await exportFile(project, video);
  expect(job()).toMatchObject({ phase: "failed" });
  expect(asked.discard).not.toHaveBeenCalled();
});

it("skips the render when cancelled while the desktop is keeping its destination", async () => {
  let kept!: () => void;
  asked.keep.mockImplementation(() => new Promise<void>(resolve => { kept = resolve; }));
  const running = exportFile(project, video);
  await vi.waitFor(() => expect(asked.keep).toHaveBeenCalledWith(DESTINATION.ticket));
  (job() as ExportJob).cancel();
  kept();
  await running;
  expect(asked.request).not.toHaveBeenCalled();
  expect(asked.discard).toHaveBeenCalledExactlyOnceWith(DESTINATION.ticket);
  expect(job()).toBeUndefined();
});

it("stops quietly when the editor cancels: the render is released, the place let go, and nothing is logged as a failure", async () => {
  vi.useFakeTimers();
  try {
    const running = exportFile(project, video);
    await vi.advanceTimersByTimeAsync(0);
    expect(job()).toMatchObject({ phase: "rendering", progress: 0.3, waiting: false });
    (job() as ExportJob).cancel();
    expect(job()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    await running;
    expect(asked.release).toHaveBeenCalledWith("rnd_export", expect.any(String));
    expect(asked.discard).toHaveBeenCalledExactlyOnceWith(4);
    expect(asked.save).not.toHaveBeenCalled();
    expect(job()).toBeUndefined();
    expect(lines).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it("follows the render to the end, waiting through an engine that is away and failing on one that says no", async () => {
  vi.useFakeTimers();
  try {
    const polls: (() => Promise<{ render: Render }>)[] = [
      async () => { throw new TypeError("Load failed"); },
      async () => { throw new ScarletApiError(503, "unavailable", "Engine restarting"); },
      async () => ({ render: { ...render, state: "queued", progress: 0.3 } }),
      async () => ({ render: { ...render, progress: 0.8 } }),
      async () => { throw new ScarletApiError(404, "not_found", "No such render"); },
    ];
    const seen: unknown[] = [];
    vi.spyOn(api, "render").mockImplementation(() => polls.shift()!());
    const running = exportFile(project, video);
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(750);
      const now = job();
      seen.push(now && "progress" in now ? [now.progress, !!now.waiting] : now?.phase);
    }
    await running;
    // Away twice: still rendering. Then queued behind another, then moving, then gone.
    expect(seen).toEqual([[0.3, false], [0.3, false], [0.3, true], [0.8, false], "failed"]);
    expect(job()).toMatchObject({ phase: "failed", error: "No such render" });
  } finally {
    vi.useRealTimers();
  }
});

it("takes the finished render from the socket without waiting to ask", async () => {
  vi.useFakeTimers();
  try {
    const poll = vi.spyOn(api, "render");
    const running = exportFile(project, video);
    await vi.advanceTimersByTimeAsync(100);
    initial.applyEvent({ type: "render.updated", projectId: PRJ, render: { ...render, state: "done", progress: 1 } });
    await vi.advanceTimersByTimeAsync(0);
    await running;
    expect(poll).not.toHaveBeenCalled();
    expect(job()).toEqual({ phase: "done", path: DESTINATION.path, context: fullRenderContext(project.project) });
  } finally {
    vi.useRealTimers();
  }
});

it("runs one export for a project at a time", async () => {
  vi.useFakeTimers();
  try {
    const first = exportFile(project, video);
    await vi.advanceTimersByTimeAsync(0);
    await exportFile(project, { ...video, name: "second.mp4" });
    expect(desktop.chooseVideoExport).toHaveBeenCalledTimes(1);
    (job() as ExportJob).cancel();
    await vi.advanceTimersByTimeAsync(1000);
    await first;
  } finally {
    vi.useRealTimers();
  }
});

it("picks up an export left over from the last session, and tells the editor how it ended", async () => {
  const owner = "11111111-1111-4111-8111-111111111111";
  const kept: Render = { ...render, id: "rnd_kept", state: "failed", error: "The encoder crashed", range: { start: 0, end: 4 }, exportOptions: { height: 480 },
    export: { owner, name: NAME, ...DESTINATION } };
  // One the window already tracks, and a render that isn't an export, are left alone.
  vi.spyOn(api, "exports").mockResolvedValue({ renders: [kept, { ...render, id: "rnd_plain" }] });
  await resumeExports();
  await vi.waitFor(() => expect(job()).toMatchObject({ phase: "failed", error: "The encoder crashed" }));
  expect(job()).toMatchObject({ file: { name: NAME, format: "mp4", video: { kind: "export", quality: "delivery", range: { start: 0, end: 4 }, exportOptions: { height: 480 } } },
    context: fullRenderContext({ id: PRJ, head: kept.version, settings: kept.projectSettings! }) });
  expect(desktop.chooseVideoExport).not.toHaveBeenCalled();
  expect(asked.request).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(asked.release).toHaveBeenCalledExactlyOnceWith("rnd_kept", owner));
  expect(lines).toEqual(['[error] export phase=rendering format=mp4 resumed=true error="The encoder crashed"']);
});

it("treats a left-over export whose destination is gone as already settled, without a failure", async () => {
  const kept: Render = { ...render, id: "rnd_kept", state: "done", export: { owner: "11111111-1111-4111-8111-111111111111", name: NAME, ...DESTINATION } };
  vi.spyOn(api, "exports").mockResolvedValue({ renders: [kept] });
  asked.save.mockRejectedValue("Export destination expired");
  await resumeExports();
  await vi.waitFor(() => expect(asked.release).toHaveBeenCalledTimes(1));
  expect(job()).toBeUndefined();
  expect(lines).toEqual([]);
});

it("counts an export's percent only while it moves", () => {
  const job: ExportJob = { file: video, context: "c", version: "v", phase: "rendering", progress: 0.42, cancel: () => {} };
  expect(exportCounting(job)).toBe(true);
  // Not before the render starts, not once the picture is done, and not while the file is saved.
  expect([{ ...job, waiting: true }, { ...job, progress: 0.966 }, { ...job, phase: "saving" as const }, { ...job, phase: "choosing" as const }].map(exportCounting))
    .toEqual([false, false, false, false]);
});

it("records that a failure was shown, once, and leaves any other state alone", async () => {
  render = { ...render, state: "failed", error: "Disk full" };
  await exportFile(project, video);
  expect(job()).toMatchObject({ phase: "failed", error: "Disk full" });
  expect(job()).not.toHaveProperty("seen");
  exportFailureSeen(PRJ);
  expect(job()).toMatchObject({ phase: "failed", error: "Disk full", seen: true });
  const shown = job();
  exportFailureSeen(PRJ);
  expect(job()).toBe(shown);
  // A finished export has nothing to mark as seen.
  useExports.setState({ jobs: { [PRJ]: { phase: "done", path: DESTINATION.path, context: "c" } } });
  exportFailureSeen(PRJ);
  expect(job()).toEqual({ phase: "done", path: DESTINATION.path, context: "c" });
});
