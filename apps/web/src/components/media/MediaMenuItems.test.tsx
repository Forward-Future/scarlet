// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SourceCacheStatus, Task } from "@scarlet/shared";
import type { MediaAsset } from "@scarlet/timeline";
import { api } from "../../lib/client";
import { buildDb, PRJ } from "../../lib/mock/fixtures";
import { useProjectStore } from "../../stores/project";
import { CachingMenuItem, MediaButton, useVideoCaching } from "./MediaMenuItems";
import { cachePercent, useSourceCaches } from "./sourceCaches";

const initial = useProjectStore.getState();
const db = buildDb();
const project = db.projects.find(p => p.id === PRJ)!;
// The fixture's video was read and already has its transcript.
const video = (id: string, extra: Partial<MediaAsset> = {}): MediaAsset => ({ ...db.media[PRJ]!.find(m => m.kind === "video")!, id, name: `${id}.mov`, ...extra });
const transcription = (mediaId: string, state: Task["state"]): Task => ({
  ...db.tasks[0]!, id: `transcribe-${mediaId}`, projectId: PRJ, kind: "transcribe", agent: "api", context: { mediaId },
  state, instruction: `Transcribe ${mediaId}`,
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(api, "sourceCaches").mockResolvedValue({ caches: [] });
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  useProjectStore.setState(initial, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function show(media: MediaAsset[], tasks: Task[] = [], onOpen = vi.fn(), mediaPaused = false, importing = 0, importFailed = false) {
  // Inside act, so a test can show the rows again with other files or tasks.
  await act(async () => useProjectStore.setState({ current: {
    id: PRJ, project: { ...project, mediaPaused }, timeline: null, media, changes: [], notes: [], renders: [], tasks, taskEvents: {}, versions: [],
  } }));
  await act(async () => root.render(<>
    <MediaButton importing={importing} importFailed={importFailed} onOpen={onOpen} />
    <CachingFigure />
    <CachingMenuItem close={vi.fn()} />
  </>));
  await act(async () => {});
  return container.querySelector<HTMLButtonElement>(".simple-media")!;
}
/** What the ring around the menu's button says on hover while videos cache. */
function CachingFigure() {
  const { label } = useVideoCaching();
  return label ? <span className="caching-figure">{label}</span> : null;
}
/** What the row's mark says, for someone who can't see it. */
const mark = (row: Element) => row.querySelector(".menu-dot")?.getAttribute("aria-label") ?? null;

it("shares cache reads between views and leaves both idle when a poll returns the same statuses", async () => {
  await show([video("cam")]);
  await act(async () => root.render(null));
  const reads = vi.mocked(api.sourceCaches).mockClear().mockImplementation(async () => ({ caches: [{ mediaId: "cam", state: "ready" }] }));
  const paint = vi.fn();
  function View() { useSourceCaches(); paint(); return null; }
  vi.useFakeTimers();
  try {
    await act(async () => root.render(<><View /><View /></>));
    expect(reads).toHaveBeenCalledTimes(1);
    paint.mockClear();
    await act(async () => useProjectStore.setState(s => ({ current: { ...s.current!, taskEvents: { working: [] } } })));
    expect(reads).toHaveBeenCalledTimes(1);
    // With nothing caching, store changes say when to read, so the poll only checks in once a minute.
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(reads).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(50_000));
    expect(reads).toHaveBeenCalledTimes(2);
    expect(paint).not.toHaveBeenCalled();
    await act(async () => useProjectStore.setState(s => ({ current: { ...s.current!, sourcePreviewRevisions: { cam: 1 } } })));
    expect(reads).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => root.render(null));
    vi.useRealTimers();
  }
});

it("is only the word Media, with no mark, while every file was read and has its transcript", async () => {
  // A transcription that failed before the transcript was made is no longer a problem.
  const row = await show([video("cam"), video("mic")], [transcription("mic", "failed")]);
  expect(row.textContent).toBe("Media");
  expect(mark(row)).toBeNull();
  expect(row.getAttribute("aria-description")).toBeNull();
  expect(container.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
});

it("marks the Media button when a file couldn't be read, and names the file", async () => {
  const row = await show([video("cam"), video("broken", { status: "failed" })]);
  expect(row.textContent).toBe("Media");
  expect(mark(row)).toBe("Couldn’t read broken.mov");
  expect(row.getAttribute("aria-description")).toBe("Couldn’t read broken.mov");
});

it("marks the Media button when a transcription stopped and the recording still has no transcript", async () => {
  const row = await show([video("cam", { transcriptId: undefined }), video("mic")], [transcription("cam", "failed")]);
  expect(mark(row)).toBe("Transcription stopped for cam.mov");
});

it("counts the files instead of naming one when several have a problem", async () => {
  const row = await show([video("cam", { transcriptId: undefined }), video("broken", { status: "failed" })], [transcription("cam", "failed")]);
  expect(row.querySelectorAll(".menu-dot")).toHaveLength(1);
  expect(mark(row)).toBe("2 files need attention");
});

it("marks the Media button when a file failed to import, and names a file the project couldn't read ahead of that", async () => {
  // A failed import never became one of the project's files: Media's list of imports is all that says why.
  const row = await show([video("cam")], [], vi.fn(), false, 0, true);
  expect(row.textContent).toBe("Media");
  expect(mark(row)).toBe("Some files need attention");
  expect(row.getAttribute("aria-description")).toBe("Some files need attention");
  expect(mark(await show([video("cam"), video("broken", { status: "failed" })], [], vi.fn(), false, 0, true))).toBe("Couldn’t read broken.mov");
});

it("puts the problem ahead of the caching line on hover, and opens Media on a click", async () => {
  vi.mocked(api.sourceCaches).mockResolvedValue({ caches: [{ mediaId: "cam", state: "ready" }] });
  const onOpen = vi.fn();
  const row = await show([video("cam"), video("broken", { status: "failed" })], [], onOpen);
  expect(row.getAttribute("aria-description")).toBe("Couldn’t read broken.mov. Video cached for playback");
  await act(async () => row.click());
  expect(onOpen).toHaveBeenCalledOnce();
});

it("leaves a transcription the pause stopped unmarked while the project is paused", async () => {
  const media = [video("cam", { transcriptId: undefined })];
  const stopped = { ...transcription("cam", "failed"), interrupted: true };
  // It starts again on resume, so there is nothing for the editor to deal with.
  expect(mark(await show(media, [stopped], vi.fn(), true))).toBeNull();
  // One that failed by itself is still a problem while paused, and so is a cut-off one once the project isn't.
  expect(mark(await show(media, [transcription("cam", "failed")], vi.fn(), true))).toBe("Transcription stopped for cam.mov");
  expect(mark(await show(media, [stopped]))).toBe("Transcription stopped for cam.mov");
});

it("says Paused and offers Resume for as long as the project is paused, whatever its videos are doing", async () => {
  const updateProject = vi.fn().mockResolvedValue(undefined);
  useProjectStore.setState({ updateProject });
  const rows = () => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map(row => row.textContent);
  // Resume stays available while the project is paused, even after every video finishes caching.
  vi.mocked(api.sourceCaches).mockResolvedValue({ caches: [{ mediaId: "cam", state: "ready" }] });
  const row = await show([video("cam")], [], vi.fn(), true);
  // The menu's row says what it resumes: the chat's own Pause and Resume are for editing.
  expect([rows(), row.getAttribute("aria-description")]).toEqual([["Resume media processing"], "Media processing is paused"]);
  await act(async () => container.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
  expect(updateProject).toHaveBeenCalledExactlyOnceWith({ mediaPaused: false }, PRJ);
  // A project with no video is the same, and so is one whose video waits to cache.
  await show([], [], vi.fn(), true);
  expect(rows()).toEqual(["Resume media processing"]);
  vi.mocked(api.sourceCaches).mockResolvedValue({ caches: [{ mediaId: "cam", state: "uncached", queued: true }] });
  await show([video("cam")], [], vi.fn(), true);
  expect(rows()).toEqual(["Resume media processing"]);
  // Not paused, with nothing to cache, there is no row.
  vi.mocked(api.sourceCaches).mockResolvedValue({ caches: [{ mediaId: "mic", state: "ready" }] });
  await show([video("mic")]);
  expect(rows()).toEqual([]);
});

it("counts caching across all the project's videos by their length, so the figure only goes up", async () => {
  const figure = () => container.querySelector(".caching-figure")?.textContent;
  /** The engine's next answer, read as it is when a cache finishes. */
  const then = async (caches: Awaited<ReturnType<typeof api.sourceCaches>>["caches"], revision: number) => {
    vi.mocked(api.sourceCaches).mockResolvedValue({ caches });
    await act(async () => useProjectStore.setState(s => ({ current: { ...s.current!, sourcePreviewRevisions: { cam: revision } } })));
    await act(async () => {});
  };
  // The first of two videos is nearly cached and the second waits its turn: the two are half done between them.
  vi.mocked(api.sourceCaches).mockResolvedValue({ caches: [{ mediaId: "cam", state: "caching", progress: 0.9 }, { mediaId: "screen", state: "uncached", queued: true }] });
  await show([video("cam"), video("screen")]);
  expect(figure()).toBe("Caching 45%");
  // The second starts. The figure was the average of the videos caching at that moment, which dropped to 5% here.
  await then([{ mediaId: "cam", state: "ready" }, { mediaId: "screen", state: "caching", progress: 0.05 }], 1);
  expect(figure()).toBe("Caching 52%");
  // It says 100% only once every video is cached, as Media's rows do. Rounded, 99.6% read 100% beside a row at 99%.
  await then([{ mediaId: "cam", state: "ready" }, { mediaId: "screen", state: "caching", progress: 0.996 }], 2);
  expect(figure()).toBe("Caching 99%");
  await then([{ mediaId: "cam", state: "ready" }, { mediaId: "screen", state: "ready" }], 3);
  expect(figure()).toBeUndefined();

  // A long video counts for more than a short one: ten minutes cached and a fifth of thirty more is 40% of the footage.
  vi.mocked(api.sourceCaches).mockResolvedValue({ caches: [{ mediaId: "short", state: "ready" }, { mediaId: "long", state: "caching", progress: 0.2 }] });
  await show([video("short", { duration: 600 }), video("long", { duration: 1800 })]);
  expect(figure()).toBe("Caching 40%");
  // A video whose length isn't known can't be weighed, so the videos then count alike.
  await show([video("short", { duration: 600 }), video("long", { duration: undefined })]);
  expect(figure()).toBe("Caching 60%");
  // One video reads as its own row in Media does, and has no figure until the engine has one.
  vi.mocked(api.sourceCaches).mockResolvedValue({ caches: [{ mediaId: "only", state: "caching", progress: 0.29 }] });
  await show([video("only", { duration: 3487 })]);
  expect(figure()).toBe(`Caching ${cachePercent({ progress: 0.29 })}`);
  await then([{ mediaId: "only", state: "caching" }], 4);
  expect(figure()).toBe("Caching");
});

it("leaves out a video that failed or isn't to be cached, as the project list does, so the figure can reach the end", async () => {
  const figure = () => container.querySelector(".caching-figure")?.textContent;
  // One video is half cached, one failed and one was never asked for: the project list says 50%, and so does the menu.
  const caches: SourceCacheStatus[] = [{ mediaId: "cam", state: "caching", progress: 0.5 }, { mediaId: "screen", state: "failed" }, { mediaId: "broll", state: "uncached" }];
  vi.mocked(api.sourceCaches).mockResolvedValue({ caches });
  await show([video("cam"), video("screen"), video("broll")]);
  expect(figure()).toBe("Caching 50%");
  // Nearly done, it reads 99% where it would have stopped at a third.
  vi.mocked(api.sourceCaches).mockResolvedValue({ caches: [{ mediaId: "cam", state: "caching", progress: 0.995 }, ...caches.slice(1)] });
  await act(async () => useProjectStore.setState(s => ({ current: { ...s.current!, sourcePreviewRevisions: { cam: 1 } } })));
  await act(async () => {});
  expect(figure()).toBe("Caching 99%");
});

it("says on hover that editing can go on while videos cache, and only then", async () => {
  const card = () => container.querySelector(".media-hover-card")!.textContent;
  vi.mocked(api.sourceCaches).mockResolvedValue({ caches: [{ mediaId: "cam", state: "caching", progress: 0.4 }] });
  await show([video("cam")]);
  expect(card()).toContain("You can edit during caching.");
  // A pause holds the cache: the hover says so, and nothing is under way to edit beside.
  await show([video("cam")], [], vi.fn(), true);
  expect(card()).not.toContain("You can edit");
  // Once the video is cached there is nothing to wait for.
  vi.mocked(api.sourceCaches).mockResolvedValue({ caches: [{ mediaId: "cam", state: "ready" }] });
  await show([video("cam")]);
  await act(async () => useProjectStore.setState(s => ({ current: { ...s.current!, sourcePreviewRevisions: { cam: 1 } } })));
  await act(async () => {});
  expect(card()).not.toContain("You can edit");
});

it("counts a single video as one video, and says how many files are being added", async () => {
  vi.mocked(api.sourceCaches).mockResolvedValue({ caches: [{ mediaId: "cam", state: "uncached" }] });
  expect((await show([video("cam")])).getAttribute("aria-description")).toBe("0 of 1 video cached");
  vi.mocked(api.sourceCaches).mockResolvedValue({ caches: [{ mediaId: "cam", state: "ready" }, { mediaId: "mic", state: "uncached" }] });
  expect((await show([video("cam"), video("mic")])).getAttribute("aria-description")).toBe("1 of 2 videos cached");
  expect((await show([video("cam")], [], vi.fn(), false, 2)).getAttribute("aria-description")).toBe("Adding 2 files");
});

it("pauses and resumes processing from the Media hover card during audio-only transcription", async () => {
  const mic = { ...video("mic", { transcriptId: undefined }), kind: "audio" as const };
  const update = vi.spyOn(api, "updateProject").mockImplementation(async (_id, body) => ({
    project: { ...project, mediaPaused: body.mediaPaused === true },
  }));
  const button = await show([mic], [transcription(mic.id, "running")]);
  const pause = container.querySelector<HTMLButtonElement>(".media-hover-card button")!;
  expect(button.getAttribute("aria-description")).toBe("Transcription in progress");
  expect(pause.textContent).toBe("Pause");
  await act(async () => pause.click());
  expect(update).toHaveBeenNthCalledWith(1, PRJ, { mediaPaused: true });
  expect(pause.textContent).toBe("Resume");
  await act(async () => pause.click());
  expect(update).toHaveBeenNthCalledWith(2, PRJ, { mediaPaused: false });
});

it("omits Pause from the Media hover card and More menu until media processing is working or paused", async () => {
  // Empty project: no hover card and no Pause menu item.
  await show([]);
  expect(container.querySelector(".media-hover-card")).toBeNull();
  expect(container.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
  // Cached video with nothing running: hover card shows status without Pause.
  vi.mocked(api.sourceCaches).mockResolvedValue({ caches: [{ mediaId: "cam", state: "ready" }] });
  await show([video("cam")]);
  expect(container.querySelector(".media-hover-card")?.textContent).toContain("Video cached for playback");
  expect(container.querySelector(".media-hover-card button")).toBeNull();
  expect(container.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
  // A file being read shows Pause in both places, with a status label in the hover card.
  vi.mocked(api.sourceCaches).mockResolvedValue({ caches: [] });
  await show([video("cam", { status: "ingesting", preparation: { stage: "waveform", fraction: 0.2 } })]);
  expect(container.querySelector(".media-hover-card strong")?.textContent).toBe("Preparing media");
  expect(container.querySelector(".media-hover-card button")?.textContent).toBe("Pause");
  // Media's own card says Pause; the menu's row, away from Media, says what it pauses.
  expect([...container.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(["Pause media processing"]);
});

it("shows one progress row per active job in the hover card without listing individual files", async () => {
  vi.mocked(api.sourceCaches).mockResolvedValue({ caches: [{ mediaId: "cam", state: "caching", progress: 0.03 }] });
  const running = { ...transcription("cam", "running"), progress: { stage: "transcribing" as const, fraction: 0.45 } };
  await show([video("cam", { name: "Screen 2026-11-19.mp4", transcriptId: undefined })], [running]);
  const card = container.querySelector(".media-hover-card")!;
  const jobs = [...card.querySelectorAll(".media-hover-job")];
  expect(jobs.map(job => job.querySelector(".media-hover-row")?.textContent)).toEqual(["Caching3%", "Transcribing45%"]);
  expect(card.querySelectorAll("progress")).toHaveLength(2);
  expect(card.querySelector(".media-hover-foot button")?.textContent).toBe("Pause");
  expect(card.textContent).toContain("You can edit during caching.");
  expect(card.textContent).not.toContain("Screen 2026-11-19.mp4");
  expect(card.textContent).not.toContain("Caching for playback");

  // Queued transcription omits its bar and shows Queued beside Caching.
  const queued = { ...transcription("cam", "queued"), progress: { stage: "queued" as const, fraction: 0 } };
  await show([video("cam", { transcriptId: undefined })], [queued]);
  expect(container.querySelectorAll(".media-hover-card progress")).toHaveLength(1);
  expect(container.querySelector(".media-hover-card")?.textContent).toContain("TranscribingQueued");

  // Audio-only transcription shows its percent, progress bar, and inline Pause.
  vi.mocked(api.sourceCaches).mockResolvedValue({ caches: [] });
  const mic = { ...video("mic", { transcriptId: undefined }), kind: "audio" as const };
  const micRunning = { ...transcription(mic.id, "running"), progress: { stage: "transcribing" as const, fraction: 0.62 } };
  await show([mic], [micRunning]);
  expect(container.querySelector(".media-hover-card strong")?.textContent).toBe("Transcribing 62%");
  expect(container.querySelector(".media-hover-card button")?.textContent).toBe("Pause");
  expect(container.querySelector<HTMLProgressElement>(".media-hover-card progress")?.value).toBeCloseTo(0.62);
});

it("lets a keyboard user dismiss the Media hover card with Escape", async () => {
  document.body.append(container);
  try {
    vi.mocked(api.sourceCaches).mockResolvedValue({ caches: [{ mediaId: "cam", state: "caching", progress: 0.4 }] });
    const media = await show([video("cam")]);
    const card = container.querySelector(".media-hover")!;
    const pause = card.querySelector<HTMLButtonElement>(".media-hover-card button")!;
    await act(async () => pause.focus());
    expect(card.hasAttribute("data-escape-owner")).toBe(true);
    await act(async () => pause.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.activeElement).toBe(media);
    expect(card.hasAttribute("data-dismissed")).toBe(true);
    expect(card.hasAttribute("data-escape-owner")).toBe(false);
  } finally {
    container.remove();
  }
});

it("reads the caches once at a time, and once more for a change that came meanwhile", async () => {
  await show([video("cam")]);
  await act(async () => root.render(null));
  let answer: (() => void) | undefined;
  const reads = vi.mocked(api.sourceCaches).mockClear().mockImplementation(() => new Promise(resolve => {
    answer = () => resolve({ caches: [{ mediaId: "cam", state: "ready" }] });
  }));
  function View() { useSourceCaches(); return null; }
  vi.useFakeTimers();
  try {
    await act(async () => root.render(<View />));
    expect(reads).toHaveBeenCalledTimes(1);
    await act(async () => useProjectStore.setState(s => ({ current: { ...s.current!, sourcePreviewRevisions: { cam: 1 } } })));
    await act(async () => useProjectStore.setState(s => ({ current: { ...s.current!, sourcePreviewRevisions: { cam: 2 } } })));
    expect(reads).toHaveBeenCalledTimes(1);
    await act(async () => { answer!(); });
    expect(reads).toHaveBeenCalledTimes(2);
    await act(async () => { answer!(); });
    expect(reads).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.render(null));
    vi.useRealTimers();
  }
});
