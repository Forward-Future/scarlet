// @vitest-environment happy-dom
import { selectOption } from "../../test/selectOption";
import { act, StrictMode, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Link, MemoryRouter, Outlet } from "react-router-dom";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { fullRenderContext, type Render } from "@scarlet/shared";
import { timelineDuration } from "@scarlet/timeline";
import { MonitorPlayback } from "../components/player/MonitorPlayback";
import { usePictureWait } from "../components/player/usePictureWait";
import { PlayerTimeline, TimelineScrubber } from "../components/review/TimelineScrubber";
import { TimelineWaveform } from "../components/review/TimelineWaveform";
import { ChangeClip } from "../components/review/ChangeClip";
import { FramingPreview } from "../components/review/FramingPreview";
import { OriginalFootage } from "../components/review/OriginalFootage";
import { WindowActions } from "../components/shell/WorkspaceNavigation";
import { api } from "../lib/client";
import { buildDb, mc, PRJ } from "../lib/mock/fixtures";
import { joinClock } from "../lib/joinClock";
import { player } from "../lib/player";
import { scrubFrameUrl } from "../components/review/thumbs";
import { dispatchWsEvent } from "../lib/realtime";
import { useProjectStore, type ProjectData } from "../stores/project";
import { useUiStore } from "../stores/ui";
import { transcriptChunks } from "../components/transcript/useTranscriptWindow";
import { mediaClipsFor } from "../lib/transcriptMap";
import { CutPreview } from "./WatchPage";
import { usePlayerStore } from "../stores/player";
import * as sourcePlayback from "../lib/sourcePlayback";
import * as cutStream from "../lib/cutStream";
import { desktop } from "../lib/desktop";
import { ExportSheet } from "../components/review/ExportVideo";
import { resumeExports, useExports } from "../lib/exportJobs";
import { ExportStarNotice } from "../components/shell/ExportStarNotice";

vi.mock("../components/shell/AppShell", () => ({
  AppShell: () => <Outlet />,
}));
vi.mock("./ProjectsPage", () => ({ ProjectsPage: () => <><Link to="/">Projects</Link><WindowActions /></>, ImportUrlModal: () => null }));
vi.mock("../components/agent/Composer", () => ({ Composer: () => null }));

let root: Root;
let container: HTMLDivElement;
let data: ProjectData;
const initialStore = useProjectStore.getState();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  usePlayerStore.setState({ time: 0, duration: 0, playing: false });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const db = buildDb();
  vi.spyOn(api, "renders").mockResolvedValue({ renders: [] });
  vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings, transcriptionAvailable: true });
  vi.spyOn(api, "waveform").mockImplementation(async (mediaId, from, to) => ({ mediaId, from, to, peaks: [0.2, 0.8] }));
  vi.spyOn(api, "cutReview").mockResolvedValue({ review: null });
  vi.spyOn(api, "cutReviewDraft").mockResolvedValue({});
  const project = db.projects.find((p) => p.id === PRJ)!;
  data = {
    id: PRJ, project, timeline: db.timelines[project.head!]!,
    media: project.media, changes: db.changes, notes: db.notes, renders: db.renders,
    tasks: db.tasks, taskEvents: db.taskEvents, versions: db.versions[PRJ]!,
    fullRenderKeys: { context: fullRenderContext(project), preview: db.renders.find(r => r.kind === "full")!.key, delivery: "current-delivery" },
  };
  vi.spyOn(api, "renders").mockResolvedValue({ renders: [] });
  useProjectStore.setState({
    current: data, status: "ready", load: vi.fn(), refreshHead: vi.fn(), loadTaskEvents: vi.fn().mockResolvedValue(undefined),
    loadChangeDiff: vi.fn().mockRejectedValue(new Error("No diff fixture")),
  });
  localStorage.removeItem("scarlet.exportStarShown");
  useUiStore.setState({ notifications: [], exportStarNotice: "unseen" });
  useExports.setState({ jobs: {} });
  vi.spyOn(desktop, "keepVideoExport").mockResolvedValue();
  vi.spyOn(api, "releaseRender").mockResolvedValue();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useProjectStore.setState(initialStore, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const show = (element: ReactNode) => act(async () => root.render(element));
const click = (element: HTMLElement) => act(async () => element.click());
const labeled = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const exportButton = () => container.querySelector<HTMLButtonElement>('button[form="export-working-cut"]');
const compareButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Before"]')!;
const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

function sizeWaveformLane(width: number) {
  vi.stubGlobal("ResizeObserver", class {
    constructor(private measure: () => void) {}
    observe(el: Element) { Object.defineProperty(el, "clientWidth", { value: width }); this.measure(); }
    disconnect() {}
  });
}

it("shows the loading ripple until the audible clips in this window have their measured peaks", async () => {
  sizeWaveformLane(24); // Ten bars in the headless layout.
  const video = { ...data.media[0]!, id: "wave-video" };
  const mic = { ...data.media[1]!, id: "wave-mic" };
  const tracks = data.timeline!.tracks;
  const timeline = { ...data.timeline!, tracks: [
    { ...tracks[0]!, clips: [mc("screen", video.id, 0, 10, 0)] },
    { ...tracks[1]!, clips: [mc("mic", mic.id, 0, 5, 5)] },
  ] };
  const draw = (ingesting: boolean, mediaPaused = false, duration = 10) => show(<TimelineWaveform
    timeline={timeline} media={[video, { ...mic, status: ingesting ? "ingesting" : "ready" }]} mediaPaused={mediaPaused} start={0} duration={duration} />);
  const ripple = () => container.querySelector('[aria-label="Loading audio waveform"]');
  let finish!: () => void;
  const hold = new Promise<void>(resolve => { finish = resolve; });
  vi.mocked(api.waveform).mockImplementation(async (mediaId, from, to) => {
    if (mediaId === mic.id) await hold;
    return { mediaId, from, to, peaks: [mediaId === mic.id ? .5 : 0] };
  });

  await draw(true, false, 5);
  expect(ripple()).toBeNull(); // The mic is outside this window.
  await draw(true);
  expect(ripple()).toBeTruthy();
  expect(container.querySelector("path")).toBeNull();
  expect(api.waveform).toHaveBeenLastCalledWith(video.id, 0, 10, 1000);
  await draw(true, true);
  expect(ripple()).toBeNull();
  await draw(false);
  expect(ripple()).toBeTruthy();
  await act(async () => finish());
  expect(ripple()).toBeNull();
  const bars = container.querySelector("path")?.getAttribute("d")?.match(/M[\d.]+/g);
  expect(bars).toEqual(["M5.5", "M6.5", "M7.5", "M8.5", "M9.5"]);
});

it("settles a failed waveform read and ignores a late response from a previous source", async () => {
  sizeWaveformLane(24);
  const video = data.media[0]!;
  let finish!: () => void;
  const hold = new Promise<void>(resolve => { finish = resolve; });
  vi.mocked(api.waveform).mockImplementation(async (mediaId, from, to) => {
    if (mediaId === "wave-failed") throw Error("No waveform");
    await hold;
    return { mediaId, from, to, peaks: [1] };
  });
  const draw = (id: string, hasAudio = true) => show(<TimelineWaveform source={{ ...video, id, hasAudio }}
    media={[]} start={0} duration={10} />);
  await draw("wave-slow");
  expect(container.querySelector(".waveform-ripple")).toBeTruthy();
  await draw("wave-silent", false);
  expect(container.querySelector(".waveform-ripple")).toBeNull();
  expect(api.waveform).toHaveBeenCalledTimes(1);
  await draw("wave-failed");
  expect(container.querySelector(".waveform-ripple")).toBeNull();
  await act(async () => finish());
  expect(container.querySelector(".waveform-ripple")).toBeNull();
  expect(container.querySelector("path[d]")?.getAttribute("d")).toBeFalsy();
});

it("keeps decoded stills through cache lookup and slow frame requests until a replacement can be shown", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(84);
  const scrubber = (version: string, duration: number, pending = false) =>
    <TimelineScrubber duration={duration} playhead={0} previewStrip={pending ? null : undefined}
      frameAt={t => `/${version}/frame/${t}`} onSeek={() => {}} />;
  const strip = () => container.querySelector<HTMLElement>(".timeline-filmstrip")!;
  const own = () => [...strip().querySelectorAll<HTMLImageElement>(":scope > div:not(.filmstrip-held) > img")];
  const overlay = () => strip().querySelector(".filmstrip-held");
  const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  vi.useFakeTimers();
  try {
    await show(scrubber("v1", 8));
    const original = own();
    expect(original).toHaveLength(2);
    await act(() => { for (const img of original) img.dispatchEvent(new Event("load")); });

    await show(scrubber("v2", 9, true));
    await tick(1000);
    expect(own()).toEqual([]);
    expect(overlay()?.querySelector("img")).toBe(original[0]);
    expect(overlay()?.hasAttribute("data-leaving")).toBe(false);

    await show(scrubber("v2", 9));
    expect(strip().querySelector(".filmstrip-wait")).toBeNull();
    await tick(4000);
    expect(overlay()?.hasAttribute("data-leaving")).toBe(false);
    await act(() => { own()[0]!.dispatchEvent(new Event("load")); });
    expect(overlay()?.hasAttribute("data-leaving")).toBe(true);
    await tick(650);
    expect(overlay()).toBeNull();
    expect(own()[0]!.hasAttribute("data-loaded")).toBe(true);
  } finally { vi.useRealTimers(); }
});

it("retains the crop of each held preview-sheet cell and releases the old picture when every new frame fails", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(90);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(84);
  const scrubber = (duration: number, cached = false) =>
    <TimelineScrubber duration={duration} playhead={0} pictureAspect={9 / 16} onSeek={() => {}}
      previewStrip={cached ? { id: "portrait", version: "v1", fps: 30 } : undefined} frameAt={t => `/frame/${t}`} />;
  await show(scrubber(8, true));
  const cells = [...container.querySelectorAll(".timeline-sheet-cell")];
  expect(cells).toHaveLength(2);
  await act(() => { cells[0]!.querySelector("img")!.dispatchEvent(new Event("load")); });
  await show(scrubber(9));
  expect(container.querySelector(".filmstrip-held .timeline-sheet-cell:last-child")).toBe(cells[1]);
  expect((cells[1]!.querySelector("img")!).style.left).toBe("-100%");
  await act(() => {
    for (const img of container.querySelectorAll(".timeline-filmstrip > div:not(.filmstrip-held) > img")) {
      img.dispatchEvent(new Event("error"));
    }
  });
  expect(container.querySelector(".filmstrip-held[data-leaving]")).toBeTruthy();
  await show(scrubber(10));
  expect(container.querySelector(".filmstrip-held")).toBeNull();
});

it("loads the picture and the sound as one wave, and lands them together when they finish within a beat", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(84);
  const releases: (() => void)[] = [];
  vi.mocked(api.waveform).mockImplementation((mediaId, from, to) =>
    new Promise(resolve => releases.push(() => resolve({ mediaId, from, to, peaks: [.5, .8] }))));
  const nap = (ms: number) => act(() => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const scrubber = (id: string) => <TimelineScrubber duration={8} playhead={0} frameAt={t => `/${id}/frame/${t}`} onSeek={() => {}}
    waveform={{ source: { ...data.media[0]!, id, hasAudio: true }, media: [] }} />;
  const strip = () => container.querySelector<HTMLElement>(".timeline-filmstrip")!;
  const ripple = () => container.querySelector<HTMLElement>(".waveform-ripple");
  const loadStills = () => act(async () => {
    for (const img of strip().querySelectorAll("img")) img.dispatchEvent(new Event("load"));
  });

  await show(scrubber("together"));
  // Both lanes wait under the same wave, each started at the wave's current point.
  expect(strip().classList).toContain("is-loading");
  expect(strip().querySelector(".filmstrip-wait > i")).not.toBeNull();
  expect(strip().style.getPropertyValue("--wave-phase")).toMatch(/^-\d+\.\d{3}s$/);
  expect(ripple()?.style.getPropertyValue("--wave-phase")).toMatch(/^-\d+\.\d{3}s$/);
  // The stills are in, but the sound is moments away: they wait for it.
  await nap(160);
  await loadStills();
  expect(strip().querySelectorAll("img[data-loaded]")).toHaveLength(2);
  expect(strip().classList).toContain("is-loading");
  await act(async () => releases.shift()!());
  expect(strip().classList).not.toContain("is-loading");
  expect(ripple()).toBeNull();
  expect(container.querySelector(".timeline-waveform path")?.getAttribute("d")).toBeTruthy();
  // Both waited in view, the stills through their hold too, so both settle in rather than pop.
  expect(strip().classList).toContain("is-arriving");
  expect(container.querySelector(".timeline-waveform svg")?.classList).toContain("is-arriving");

  // When the sound takes longer, the picture shows on its own and the ripple carries on.
  await show(scrubber("picture-first"));
  await loadStills();
  expect(strip().classList).toContain("is-loading");
  await nap(300);
  expect(strip().classList).not.toContain("is-loading");
  expect(ripple()).not.toBeNull();
  await act(async () => releases.shift()!());
  expect(ripple()).toBeNull();

  // The sound first: the stills keep waiting, and show as soon as they are in.
  await show(scrubber("sound-first"));
  await act(async () => releases.shift()!());
  await nap(300);
  expect(ripple()).toBeNull();
  expect(strip().classList).toContain("is-loading");
  await loadStills();
  expect(strip().classList).not.toContain("is-loading");
});

it("skips 5 seconds with an arrow and 1 second with Shift, once per key repeat", async () => {
  const onSeek = vi.fn();
  await show(<TimelineScrubber duration={60} playhead={20} frameAt={() => undefined} onSeek={onSeek} />);
  const slider = labeled("Position in the video");
  const down = (key: string, shiftKey: boolean, repeat = false) => act(() => {
    slider.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, repeat, bubbles: true }));
  });
  for (const [key, shift, target] of [["ArrowRight", false, 25], ["ArrowLeft", false, 15], ["ArrowRight", true, 21], ["ArrowLeft", true, 19]] as const) {
    await down(key, shift);
    expect(onSeek).toHaveBeenLastCalledWith(target);
  }
  // Held, each repeat from the keyboard is one more skip, and nothing keeps seeking after the key is up.
  vi.useFakeTimers();
  try {
    onSeek.mockClear();
    await down("ArrowRight", true);
    await down("ArrowRight", true, true);
    expect(onSeek).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(500);
    expect(onSeek).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});

it("seeks on one full-video timeline with keyboard steps and endpoints", async () => {
  const onSeek = vi.fn();
  await show(<TimelineScrubber duration={244} frameAt={() => undefined} onSeek={onSeek} playhead={192} />);
  expect(container.querySelectorAll('[role="slider"]')).toHaveLength(1);
  const slider = labeled("Position in the video");
  for (const [key, target] of [["Home", 0], ["ArrowRight", 197], ["End", 244]] as const) {
    await act(() => slider.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
    expect(onSeek).toHaveBeenLastCalledWith(target);
  }
});

it("uses the ruler's visible time window for captions, thumbnail samples and scrubbing", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(720);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(68);
  const caption = { id: "cap", kind: "caption" as const, enabled: true, timelineIn: 442, timelineOut: 445, text: "The watch demo" };
  const timeline = { ...data.timeline!, tracks: [{ ...data.timeline!.tracks[0]!, kind: "caption" as const, clips: [caption] }] };
  const onSeek = vi.fn();
  await show(<TimelineScrubber duration={2227} playhead={443}
    cue={{ time: 443, changeId: "edit", spot: 0, icon: "trim", description: "Edit cue" }} waveform={{ timeline, media: [] }}
    frameAt={t => "/frame/" + t} onSeek={onSeek} />);
  expect(container.querySelector('[aria-label="Timeline settings"]')).toBeNull();
  // The ruler writes a time as the player does, with no zero before the minutes.
  const stamps = () => [...container.querySelectorAll(".timeline-ruler .ruler-major > span")].map(s => s.textContent);
  expect(stamps()).toEqual(["7:20", "7:21", "7:22", "7:23", "7:24", "7:25"]);
  const marker = labeled("Caption marker at 7:22");
  expect(marker).toBeTruthy();
  expect(container.textContent).not.toContain(caption.text);
  await act(() => marker.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
  expect(container.querySelector('[role="tooltip"]')?.textContent).toContain(caption.text);
  await act(() => marker.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body })));
  expect(container.textContent).not.toContain(caption.text);
  await act(() => marker.focus());
  expect(document.getElementById(marker.getAttribute("aria-describedby")!)?.textContent).toContain(caption.text);
  await act(() => marker.blur());
  expect(container.textContent).not.toContain(caption.text);
  await click(marker);
  expect(onSeek).toHaveBeenLastCalledWith(caption.timelineIn);
  expect(document.activeElement).toBe(marker);
  expect(document.getElementById(marker.getAttribute("aria-describedby")!)?.textContent).toContain(caption.text);
  await act(() => marker.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(container.textContent).not.toContain(caption.text);
  expect(container.querySelector(".timeline-playhead")?.getAttribute("style")).toContain("50%");
  const slider = labeled("Position in the video");
  vi.spyOn(slider, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 720, 120));
  Object.defineProperty(slider, "setPointerCapture", { value: vi.fn() });
  await act(() => {
    for (const type of ["pointerdown", "pointerup"]) slider.dispatchEvent(new PointerEvent(type, {
      pointerId: 1, isPrimary: true, button: 0, clientX: 480, bubbles: true,
    }));
  });
  expect(onSeek).toHaveBeenLastCalledWith(444);
  await show(<TimelineScrubber duration={2227} playhead={443} frameAt={() => undefined} onSeek={onSeek} />);
  expect(stamps()).toEqual(["0:00", "5:00", "10:00", "15:00", "20:00", "25:00", "30:00"]);
  // Past an hour it counts the hours, as the player does.
  await show(<TimelineScrubber duration={5400} playhead={443} frameAt={() => undefined} onSeek={onSeek} />);
  expect(stamps()).toEqual(["0:00", "15:00", "30:00", "45:00", "1:00:00", "1:15:00"]);
});

it("zooms from the timeline controls and draws no edit points, zoomed or reviewing", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  vi.spyOn(window, "matchMedia").mockReturnValue(Object.create(reduced, { matches: { value: true } }));
  const source = data.media[0]!.id;
  const timeline = { ...data.timeline!, tracks: [{ ...data.timeline!.tracks[0]!, kind: "video" as const, hidden: false,
    clips: [mc("a", source, 0, 1, 50), mc("b", source, 0, 2, 51)] }] };
  const seek = vi.fn();
  const render = (reviewing = false) => show(<TimelineScrubber duration={200} playhead={150} reviewing={reviewing}
    waveform={{ timeline, media: [] }} frameAt={() => undefined} onSeek={seek} />);
  const rail = () => container.querySelector(".timeline-cuts, .timeline-cut, .timeline-cut-group");
  await render();
  expect(rail()).toBeNull();
  const trigger = labeled("Timeline controls");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(labeled("Zoom in")).toBeNull();
  await click(trigger);
  expect(labeled("Zoom out").disabled).toBe(true);
  expect(button("Show edit points")).toBeUndefined();
  await click(labeled("Zoom in"));
  expect(rail()).toBeNull();
  const zoomIn = labeled("Zoom in");
  await act(() => zoomIn.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true, cancelable: true })));
  expect(container.querySelector(".timeline-zoom-level")?.textContent).toBe("4×");
  await click(labeled("Fit timeline"));
  expect(seek).not.toHaveBeenCalled();
  await act(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(labeled("Zoom in")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await click(trigger);
  await act(() => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await render(true);
  expect(rail()).toBeNull();
  expect(container.textContent).not.toContain("edit points");
});

it("keeps the stretch the editor zoomed to when a new working cut builds the timeline again", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  vi.spyOn(window, "matchMedia").mockReturnValue(Object.create(reduced, { matches: { value: true } }));
  type Extra = Partial<Parameters<typeof TimelineScrubber>[0]>;
  // The working cut as the page hands it over: its version, or none in the moment the head has moved and the new cut is still on its way.
  const render = (version: string | undefined, duration: number, extra: Extra = {}) => show(<TimelineScrubber activeShortcuts duration={duration} playhead={150}
    waveform={{ timeline: version ? { ...data.timeline!, version } : null, media: [] }} frameAt={() => undefined} onSeek={() => {}} {...extra} />);
  const stamps = () => [...container.querySelectorAll(".timeline-ruler .ruler-major > span")].map(s => s.textContent);
  const key = (name: string) => act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));
  await render("ver_a", 200);
  const whole = stamps();
  await key("+");
  await key("+");
  // 4×: fifty seconds around the playhead.
  const zoomed = stamps();
  expect(zoomed).not.toEqual(whole);
  expect([zoomed[0], zoomed.at(-1)]).toEqual([expect.stringMatching(/2:00$/), expect.stringMatching(/2:30$/)]);
  // A revision lands. The head moves first and the new cut arrives a moment later, ten seconds shorter. The timeline is
  // built again each time, on the stretch it showed.
  await render(undefined, 200);
  expect(stamps()).toEqual(zoomed);
  await render("ver_b", 190);
  expect(stamps()).toEqual(zoomed);
  // A stretch that runs past the new end moves back inside it, at the same scale.
  await render("ver_c", 150);
  expect([stamps()[0], stamps().at(-1)]).toEqual([expect.stringMatching(/1:40$/), expect.stringMatching(/2:20$/)]);
  // Zoomed out to the whole video (0), it stays the whole video whatever the new length.
  await key("0");
  await render("ver_d", 180);
  expect([stamps()[0], stamps().at(-1)]).toEqual([expect.stringMatching(/0:00$/), expect.stringMatching(/2:30$/)]);
  // A stretch the editor moved to with the playhead elsewhere stays in view too, until the playhead moves.
  await key("+");
  await key("+");
  const track = container.querySelector<HTMLElement>(".timeline-track")!;
  await act(() => { track.dispatchEvent(new WheelEvent("wheel", { deltaX: -800, bubbles: true, cancelable: true })); });
  const away = stamps();
  const playhead = () => container.querySelector(".timeline-playhead");
  expect(playhead()).toBeNull();
  await render("ver_e", 180);
  expect([stamps(), playhead()]).toEqual([away, null]);
  await render("ver_e", 180, { playhead: 151 });
  expect(playhead()).not.toBeNull();
  // Other footage starts on the whole of it, as before.
  await render("ver_e", 180, { reviewing: true });
  expect([stamps()[0], stamps().at(-1)]).toEqual([expect.stringMatching(/0:00$/), expect.stringMatching(/2:30$/)]);
});

it("zooms to an open change once: a new working cut under it leaves the timeline where the editor put it", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  vi.spyOn(window, "matchMedia").mockReturnValue(Object.create(reduced, { matches: { value: true } }));
  const open = (start: number) => ({ view: { start: start - 5, end: start + 8 }, band: { start, end: start + 3 }, bandLabel: "Zoom", tone: "kept" as const });
  const render = (version: string, highlight?: ReturnType<typeof open>) => show(<TimelineScrubber activeShortcuts duration={200} playhead={150} marks={[]} highlight={highlight}
    waveform={{ timeline: { ...data.timeline!, version }, media: [] }} frameAt={() => undefined} onSeek={() => {}} />);
  const stamps = () => [...container.querySelectorAll(".timeline-ruler .ruler-major > span")].map(s => s.textContent);
  const key = (name: string) => act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));
  // Opening the change zooms to it.
  await render("ver_a");
  await render("ver_a", open(100));
  const fitted = stamps();
  expect(fitted[0]).toMatch(/1:36$/);
  // The editor zooms out to look around. A new working cut lands under the open change: the timeline stays zoomed out.
  await key("0");
  const around = stamps();
  expect(around).not.toEqual(fitted);
  await render("ver_b", open(100));
  expect(stamps()).toEqual(around);
  // Another change opening along with the new cut is zoomed to, as any change is when it opens.
  await render("ver_c", open(40));
  expect(stamps()[0]).toMatch(/0:36$/);
});

it("holds the fitted review window until the playhead changes to the open cut's clock", async () => {
  const highlight = { view: { start: 96, end: 114 }, band: { start: 104.75, end: 105.25 } };
  const render = (time: number) => show(<StrictMode><TimelineScrubber playhead={time} duration={300} highlight={highlight}
    frameAt={() => undefined} onSeek={vi.fn()} /></StrictMode>);
  const band = () => container.querySelector<HTMLElement>(".simple-timeline-band");
  await render(0);
  const fitted = band()?.style.left;
  expect(parseFloat(fitted!)).toBeCloseTo(48.61, 2);
  for (const t of [103, 105.25, 111.5, 113]) {
    await render(t);
    expect(band()?.style.left).toBe(fitted);
    expect(container.querySelector(".timeline-playhead")).not.toBeNull();
  }
});

it("draws crowded edits as one pill, names its first edit on hover, and opens that edit on a press instead of scrubbing", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  const seek = vi.fn(), opened: number[] = [];
  const edit = (time: number, n: number) => ({ time, n, state: "check" as const, title: `Edit ${n} of 6 · ${time}s`, summary: `Summary ${n}`, open: () => { opened.push(n); } });
  // 100 s across 1000 px. Edits 1 to 4 sit a second apart, so their circles would touch. Edit 5 has room.
  await show(<TimelineScrubber duration={100} playhead={0} frameAt={() => undefined} onSeek={seek}
    marks={[edit(10, 1), edit(11, 2), edit(12, 3), edit(13, 4), edit(60, 5)]} />);
  const markers = [...container.querySelectorAll<HTMLElement>(".simple-timeline-mark")];
  expect(markers.map(m => m.textContent)).toEqual(["1–4", "5"]);
  expect(markers.every(m => m.classList.contains("is-numbered") && m.dataset.state === "check")).toBe(true);
  expect(container.querySelector(".simple-timeline-mark.is-tick")).toBeNull();
  const strip = container.querySelector<HTMLElement>(".simple-timeline-hover")!;
  vi.spyOn(strip, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 24));
  const point = (type: string, clientX: number) => act(() => strip.dispatchEvent(new PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, clientX, bubbles: true })));
  // Over the pill, the note names its first edit and counts the rest, and the pointer says a press opens it.
  await point("pointermove", 115);
  expect(strip.classList.contains("is-aimed")).toBe(true);
  const note = container.querySelector(".simple-timeline-tip")!;
  expect(note.textContent).toContain("Edit 1 of 6");
  expect(note.textContent).toContain("and 3 more here");
  expect(note.textContent).not.toContain("Edit 2 of 6");
  await point("pointerdown", 115);
  expect(opened).toEqual([1]);
  expect(seek).not.toHaveBeenCalled();
  // Beside a marker the note still shows, but a press scrubs as before.
  await point("pointermove", 620);
  expect(container.querySelector(".simple-timeline-tip")?.textContent).toContain("Edit 5 of 6");
  expect(strip.classList.contains("is-aimed")).toBe(false);
  await point("pointerdown", 620);
  await point("pointerup", 620);
  expect(opened).toEqual([1]);
  await point("pointerdown", 600);
  expect(opened).toEqual([1, 5]);
});

it("opens a dot's own edit on a press anywhere on the dot, and names it on hover, though a settled cut's tick sits inside the dot", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  const seek = vi.fn(), opened: number[] = [];
  const edit = (time: number, n: number) => ({ time, n, title: `Edit ${n} of 8 · ${time}s`, summary: `Summary ${n}`, open: () => { opened.push(n); } });
  // 100 s across 1000 px, with the pass's list open. Edit 7 asks for a look, and its amber circle spans 91.5 to 108.5 px.
  // Settled edit 8's tick takes no room, so it sits inside the circle, at 103 px.
  await show(<TimelineScrubber duration={100} playhead={0} frameAt={() => undefined} onSeek={seek}
    marks={[{ ...edit(10, 7), state: "check" }, { ...edit(10.3, 8), quiet: true }]} />);
  const markers = [...container.querySelectorAll<HTMLElement>(".simple-timeline-mark")];
  expect(markers.map(m => m.classList.contains("is-quiet") ? "tick" : m.textContent)).toEqual(["7", "tick"]);
  const strip = container.querySelector<HTMLElement>(".simple-timeline-hover")!;
  vi.spyOn(strip, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 24));
  const point = (type: string, clientX: number) => act(() => strip.dispatchEvent(new PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, clientX, bubbles: true })));
  // Right of the circle's centre the tick is the nearer marker, and the press is still on the circle.
  for (const x of [100, 102, 103, 105, 107]) await point("pointerdown", x);
  expect(opened).toEqual([7, 7, 7, 7, 7]);
  expect(seek).not.toHaveBeenCalled();
  // The note and the pointer say the same edit the press opens.
  await point("pointermove", 105);
  expect(strip.classList.contains("is-aimed")).toBe(true);
  const note = container.querySelector(".simple-timeline-tip")!;
  expect(note.textContent).toContain("Edit 7 of 8");
  expect(note.textContent).not.toContain("Edit 8 of 8");
});

it("scrubs on a press at or beside a settled cut's faint tick, which takes no room: only a dot or a pill opens its edit", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  const seek = vi.fn(), opened: number[] = [];
  // A pass's full list is open: 121 settled cuts, a faint tick every 8 px across 1000 px, and one amber dot at 900 px.
  const settled = Array.from({ length: 121 }, (_, i) => ({ time: 0.4 + i * 0.8, n: i + 1, title: `Edit ${i + 1} of 122`, quiet: true, open: () => { opened.push(i + 1); } }));
  await show(<TimelineScrubber duration={100} playhead={0} frameAt={() => undefined} onSeek={seek}
    marks={[...settled, { time: 90, n: 122, state: "check", title: "Edit 122 of 122", open: () => { opened.push(122); } }]} />);
  const slider = labeled("Position in the video");
  vi.spyOn(slider, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 120));
  Object.defineProperty(slider, "setPointerCapture", { value: vi.fn() });
  const strip = container.querySelector<HTMLElement>(".simple-timeline-hover")!;
  vi.spyOn(strip, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 24));
  const point = (type: string, clientX: number) => act(() => strip.dispatchEvent(new PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, clientX, bubbles: true })));
  // Over cut 61's tick, at 484 px, hovering lights its number, and the pointer doesn't say a press opens it.
  await point("pointermove", 484);
  expect(container.querySelector(".simple-timeline-mark.is-hot")?.textContent).toBe("61");
  expect(strip.classList.contains("is-aimed")).toBe(false);
  // A press on the tick, or beside it, scrubs there.
  for (const x of [484, 488]) {
    await point("pointerdown", x);
    await point("pointerup", x);
  }
  expect(opened).toEqual([]);
  expect(seek.mock.calls.map(([t]) => Math.round(t * 10) / 10)).toEqual([48.4, 48.8]);
  // A press on the amber dot still opens its edit.
  await point("pointerdown", 900);
  expect(opened).toEqual([122]);
});

it("anchors wheel and pinch zoom to the pointer and defers new media samples until the gesture settles", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(50);
  const seek = vi.fn();
  const frameAt = vi.fn((t: number) => "/frame/" + t);
  await show(<TimelineScrubber start={10} duration={100} playhead={35} frameAt={frameAt} onSeek={seek} activeShortcuts />);
  const track = container.querySelector<HTMLElement>(".timeline-track")!;
  vi.spyOn(track, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 0, 400, 120));
  const slider = labeled("Position in the video");
  const playheadX = () => slider.querySelector<HTMLElement>(".timeline-playhead")?.style.left;
  await click(labeled("Timeline controls"));
  const level = () => container.querySelector(".timeline-zoom-level")?.textContent;
  vi.useFakeTimers();
  try {
    // x=200 is one quarter of this nonzero-based timeline, directly over its playhead.
    const wheel = (dy: number, ctrlKey = false) => act(() => {
      const event = new WheelEvent("wheel", { deltaY: dy, bubbles: true, cancelable: true });
      // happy-dom's WheelEvent omits inherited MouseEvent fields.
      Object.defineProperties(event, { ctrlKey: { value: ctrlKey }, clientX: { value: 200 } });
      track.dispatchEvent(event);
    });
    frameAt.mockClear();
    await wheel(-50);
    expect(level()).toBe("1.3×");
    await wheel(-50, true);
    expect(level()).toBe("2.5×");
    expect(parseFloat(playheadX()!)).toBeCloseTo(25);
    expect(frameAt).not.toHaveBeenCalled();
    await act(() => { vi.advanceTimersByTime(150); });
    expect(frameAt).toHaveBeenCalled();
    await click(labeled("Fit timeline"));
    await act(() => vi.advanceTimersByTime(550));
    for (const [type, scale] of [["gesturestart", 1], ["gesturechange", 2], ["gesturechange", 3], ["gestureend", 3]] as const) {
      const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), { scale, clientX: 200 });
      await act(() => track.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
    }
    expect(level()).toBe("3×");
    expect(parseFloat(playheadX()!)).toBeCloseTo(25);
    const key = (value: string) => act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: value, cancelable: true })));
    await key("+");
    await act(() => vi.advanceTimersByTime(550));
    expect(level()).toBe("6×");
    await key("-");
    await act(() => vi.advanceTimersByTime(550));
    expect(level()).toBe("3×");
    await key("0");
    await act(() => vi.advanceTimersByTime(550));
    expect(level()).toBe("1×");
    expect(seek).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it("samples the visible range once and seeks between its stills during a captured drag", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(84);
  const frameAt = vi.fn((t: number) => "/frame/" + t);
  const onSeek = vi.fn();
  const onSelectTime = vi.fn();
  const resume = vi.fn();
  const onScrubStart = vi.fn(() => resume);
  const scrubber = (playhead: number) => <TimelineScrubber start={10} duration={8} playhead={playhead}
    frameAt={frameAt} onSeek={onSeek} onSelectTime={onSelectTime} onScrubStart={onScrubStart} />;
  await show(scrubber(10));
  const images = [...container.querySelectorAll(".timeline-filmstrip img")];
  expect(images.map(el => el.getAttribute("src"))).toEqual(["/frame/12", "/frame/16"]);
  const slider = labeled("Position in the video");
  vi.spyOn(slider, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 0, 300, 48));
  Object.defineProperty(slider, "setPointerCapture", { value: vi.fn() });
  const point = (type: string, x: number) => slider.dispatchEvent(new PointerEvent(type, {
    bubbles: true, pointerType: "touch", pointerId: 3, isPrimary: true, clientX: x,
  }));
  point("pointerdown", 175);
  expect(onScrubStart).toHaveBeenCalledOnce();
  expect(onSeek).toHaveBeenLastCalledWith(12);
  for (let x = 200; x <= 250; x++) point("pointermove", x);
  expect(onSeek).toHaveBeenCalledOnce();
  await new Promise(requestAnimationFrame);
  expect(onSeek).toHaveBeenLastCalledWith(14);
  await show(scrubber(14));
  expect(slider.getAttribute("aria-valuenow")).toBe("14");
  expect(container.querySelector<HTMLElement>(".timeline-playhead")?.style.left).toBe("50%");
  expect(frameAt).toHaveBeenCalledTimes(2);
  expect(onSelectTime).not.toHaveBeenCalled();
  point("pointermove", 300);
  point("pointerup", 410);
  await new Promise(requestAnimationFrame);
  expect(onSelectTime).toHaveBeenCalledExactlyOnceWith(18);
  point("lostpointercapture", 410);
  expect(onSeek).toHaveBeenLastCalledWith(18);
  expect(resume).toHaveBeenCalledOnce();
  point("pointermove", 200);
  expect(onSeek).toHaveBeenCalledTimes(3);
});

it("batches nearby thumbnails from the matching preview and falls back to the new cut after an edit", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(84);
  const preview = { id: "ready-preview", version: "cut-1", fps: 30 };
  const strip = (duration: number, version: string, ready?: typeof preview | null, aspect = 16 / 9) =>
    <TimelineScrubber duration={duration} playhead={0} pictureAspect={aspect} previewStrip={ready} frameAt={t => `/${version}/frame/${t}`} onSeek={() => {}} />;
  const images = () => [...container.querySelectorAll<HTMLImageElement>(".timeline-filmstrip img")];
  await show(strip(8, "cut-1", preview));
  expect(images()).toHaveLength(2);
  expect(images()[1]!.src).toBe(images()[0]!.src);
  const sheet = new URL(images()[0]!.src);
  expect(sheet.pathname).toBe("/api/renders/ready-preview/filmstrip");
  expect(sheet.searchParams.get("version")).toBe("cut-1");
  expect(sheet.searchParams.get("frames")).toBe("60,180");
  expect(sheet.searchParams.get("layout")).toBe("source-aspect");
  await show(strip(8, "cut-1", preview, 9 / 16));
  expect(images()).toHaveLength(6);
  expect(new Set(images().map(img => new URL(img.src).searchParams.get("frames")))).toEqual(new Set(["20,60,100,140,180,220"]));
  expect(images().at(-1)?.style.left).toBe("-500%");
  expect(parseFloat(images()[0]!.parentElement!.style.aspectRatio)).toBe(9 / 16);
  await show(strip(120, "cut-1", preview));
  expect(new Set(images().map(img => new URL(img.src).searchParams.get("frames")))).toEqual(new Set(["900,2700"]));
  await show(strip(8, "cut-2", null));
  expect(images()).toHaveLength(0);
  await show(strip(8, "cut-2"));
  expect(images().map(img => img.getAttribute("src"))).toEqual(["/cut-2/frame/2", "/cut-2/frame/6"]);
});

it("fills a wide portrait filmstrip across multiple sheets and keeps the same slots for individual stills", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1404);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(64);
  const preview = { id: "portrait", version: "v1", fps: 30 };
  const frameAt = vi.fn((t: number) => `/still/${t}`);
  await show(<TimelineScrubber duration={8} playhead={0} pictureAspect={9 / 16} previewStrip={preview} frameAt={frameAt} onSeek={() => {}} />);
  const images = () => [...container.querySelectorAll<HTMLImageElement>(".timeline-filmstrip img")];
  const slots = images();
  // At 36 px per portrait, 39 frames fill the strip.
  expect(slots).toHaveLength(39);
  const sheets = [...new Set(slots.map(img => img.src))];
  expect(sheets.map(src => new URL(src).searchParams.get("frames")!.split(",").length)).toEqual([20, 19]);
  expect(slots[20]!.style.left).toBe("0%");
  await act(() => slots[0]!.dispatchEvent(new Event("error")));
  expect(images()).toHaveLength(39);
  // Individual stills share two connections and acquire one as each preceding still finishes.
  const requests = images().flatMap(img => img.getAttribute("src") || []);
  expect(requests).toHaveLength(2);
  expect(requests.every(src => src.startsWith("/still/"))).toBe(true);
});

it("resolves cut thumbnails inside the visible source clip, including trims and speed changes", () => {
  const source = data.media[0]!;
  const clip = mc("trim", source.id, 4.12, 10, 2, { speed: 2 });
  const track = { ...data.timeline!.tracks[0]!, clips: [clip] };
  const hidden = { ...track, hidden: true, clips: [mc("hidden", source.id, 0, 10, 0)] };
  const timeline = { ...data.timeline!, tracks: [track, hidden] };
  const at = (t: number) => scrubFrameUrl(undefined, timeline, [source], t);
  expect(at(0)).toBeUndefined();
  expect(at(2)).toBe(api.frameUrl(source.id, 4.12, 160));
  expect(at(3)).toBe(api.frameUrl(source.id, 6, 160));
  expect(scrubFrameUrl(undefined, timeline, [source], 3, true)).toBe(api.frameUrl(source.id, 183 / 30, 160));
  expect(scrubFrameUrl({ ...source, kind: "audio" }, timeline, [source], 3)).toBeUndefined();
});

it("turns the play button only when a seek is slow, and gives its icon back when the frame is ready", async () => {
  function Monitor() {
    const ref = useRef<HTMLDivElement>(null);
    return <div ref={ref}><video /><MonitorPlayback playing={false} playable loading={usePictureWait(ref)} onToggle={() => {}} /></div>;
  }
  await show(<Monitor />);
  const video = container.querySelector("video")!;
  const spinner = () => container.querySelector(".monitor-playback > button .animate-spin");
  vi.useFakeTimers();
  try {
    const seek = () => video.dispatchEvent(new Event("seeking"));
    const done = () => video.dispatchEvent(new Event("seeked"));
    await act(() => { seek(); vi.advanceTimersByTime(100); done(); vi.advanceTimersByTime(200); });
    expect([spinner(), container.querySelector('[role="status"]')]).toEqual([null, null]);
    await act(() => { seek(); vi.advanceTimersByTime(200); });
    expect(spinner()).not.toBeNull();
    expect(container.querySelector('.monitor-playback > [role="status"]')?.textContent).toContain("Loading this moment");
    await act(() => { done(); });
    expect([spinner(), container.querySelector('[role="status"]')]).toEqual([null, null]);
  } finally { vi.useRealTimers(); }
});

it("shows a reframe's clock in whole seconds in the simple view, as the player's is", async () => {
  usePlayerStore.setState({ time: 5.25 });
  const original = { timeline: undefined, error: undefined, retry: () => {}, duration: 16, map: undefined, range: undefined, unavailable: undefined };
  const framing = (coarse?: boolean) => <FramingPreview project={data.project} timeline={data.timeline!} original={original} duration={16} before={false} coarse={coarse} onAfter={() => {}} />;
  await show(framing(true));
  expect(container.querySelector(".monitor-clock")?.textContent).toBe("0:05 / 0:16");
  await show(framing());
  expect(container.querySelector(".monitor-clock")?.textContent).toBe("0:05.250 / 0:16.000");
});

it("samples the displayed timeline when the monitor is playing a version with a cut removed", async () => {
  const noop = () => {};
  const timeline = data.timeline!;
  const clock = joinClock([{ start: 1, end: 3 }], timelineDuration(timeline));
  await show(<MemoryRouter><CutPreview simple={{ marks: [] }} workingCache={{ cache: { state: "ready", url: "/before.mp4" }, startCache: noop }}
    joined={{ version: "after", timeline, clock, file: "/after.mp4" }} active hasCut spot={0} autoPlaySource={false}
    onRetryDraft={noop} onMedia={noop} /></MemoryRouter>);
  expect(container.querySelector(".watch-monitor video")?.getAttribute("src")).toBe("/after.mp4");
  expect(container.querySelector(".timeline-track video")?.getAttribute("src")).toBe("/before.mp4");
});

it("releases standby media behind a drawer, a hidden window or paused processing and keeps the selected decoder", async () => {
  const timeline = data.timeline!;
  const clock = joinClock([{ start: 3, end: 4 }], timelineDuration(timeline));
  const joined = { version: "after", timeline, clock, file: "/after.mp4" };
  const draw = (active: boolean) => show(<MemoryRouter><CutPreview simple={{ marks: [], cutPlayback: { key: "cut", start: 1, side: "after" } }}
    workingCache={{ cache: { state: "ready", url: "/before.mp4" }, startCache: () => {} }} joined={joined} active={active}
    hasCut spot={0} autoPlaySource={false} onRetryDraft={() => {}} onMedia={() => {}} /></MemoryRouter>);
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const standby = () => container.querySelector(".watch-monitor [data-parked] video");
  await draw(true);
  const current = player.element();
  expect(current?.getAttribute("src")).toBe("/after.mp4");
  expect(standby()).not.toBeNull();
  await draw(false);
  expect(standby()).toBeNull();
  await draw(true);
  expect(player.element()).toBe(current);
  expect(standby()).not.toBeNull();
  await act(() => { hidden.mockReturnValue(true); document.dispatchEvent(new Event("visibilitychange")); });
  expect(standby()).toBeNull();
  expect(player.element()).toBe(current);
  await act(() => {
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    useProjectStore.setState({ current: { ...data, project: { ...data.project, mediaPaused: true } } });
  });
  expect(standby()).toBeNull();
  expect(player.element()).toBe(current);
});

it("keeps both prepared decoders when opening a historical cut before its live render lookup returns", async () => {
  const timeline = { ...data.timeline!, version: "historical" };
  const cut = { start: 3, end: 4 };
  const clock = joinClock([cut], timelineDuration(timeline));
  const before = { version: timeline.version, timeline, start: 1, file: "/historical.mp4" };
  const after = { version: "after", timeline: { ...timeline, version: "after" }, start: 1, end: 6, file: "/after.mp4", clock };
  const pending = { key: "cut", cut, before, after };
  vi.mocked(api.renders).mockImplementation(() => new Promise(() => {}));
  const draw = (side?: "before" | "after") => show(<MemoryRouter><CutPreview
    simple={{ marks: [], cutPlayback: side ? { key: "cut", start: 1, side } : undefined, nextCutPlayback: side ? undefined : pending }}
    workingCache={{ cache: { state: "ready", url: "/working.mp4" }, startCache: () => {} }}
    hasCut active draftVersion={side ? before.version : undefined} draft={side ? timeline : undefined} joined={side === "after" ? after : undefined}
    spot={0} autoPlaySource={false} onRetryDraft={() => {}} onMedia={() => {}} /></MemoryRouter>);
  await draw();
  const original = container.querySelector('video[src="/historical.mp4"]');
  const edited = container.querySelector('video[src="/after.mp4"]');
  expect(original).not.toBeNull();
  expect(edited).not.toBeNull();
  await draw("after");
  expect(player.element()).toBe(edited);
  await draw("before");
  expect(player.element()).toBe(original);
});

it("keeps the current audition running when a full file completes and uses it on the next listen", async () => {
  const timeline = data.timeline!;
  const clock = joinClock([{ start: 3, end: 4 }], timelineDuration(timeline));
  const draw = (side: "before" | "after", afterFile?: string) => show(<MemoryRouter><CutPreview
    simple={{ marks: [], cutPlayback: { key: "cut", start: 1, side, afterFile, afterWindow: { url: "/window.mp4", start: 0, end: 7 } } }}
    workingCache={{ cache: { state: "ready", url: "/before.mp4" }, startCache: () => {} }}
    joined={side === "after" ? { version: "after", timeline, clock } : undefined}
    active hasCut spot={0} autoPlaySource={false} onRetryDraft={() => {}} onMedia={() => {}} /></MemoryRouter>);
  await draw("after");
  const current = player.element();
  expect(current?.getAttribute("src")).toBe("/window.mp4");
  await draw("after", "/new-full.mp4");
  expect(player.element()).toBe(current);
  await draw("before", "/new-full.mp4");
  const standby = container.querySelector('video[src="/new-full.mp4"]');
  expect(standby?.closest("[data-parked]")).not.toBeNull();
  await draw("after", "/new-full.mp4");
  expect(player.element()).toBe(standby);
});

it("prepares only After for the next decision and promotes that decoder when the editor steps down", async () => {
  const timeline = data.timeline!;
  const clock = joinClock([{ start: 3, end: 4 }], timelineDuration(timeline));
  const cut = (key: string) => ({ key, cut: { start: 3, end: 4 },
    before: { timeline, version: timeline.version, start: 1, file: "/before.mp4" },
    after: { timeline, version: key, start: 1, end: 6, file: `/${key}.mp4`, clock } });
  const first = cut("first"), next = cut("next");
  const draw = (plan: typeof first, queued?: typeof next) => show(<MemoryRouter><CutPreview simple={{ marks: [],
    cutPlayback: { key: plan.key, start: 1, side: "after" }, nextCutPlayback: queued }}
    workingCache={{ cache: { state: "ready", url: "/before.mp4" }, startCache: () => {} }}
    joined={plan.after} active hasCut spot={0} autoPlaySource={false} onRetryDraft={() => {}} onMedia={() => {}} /></MemoryRouter>);
  const queued = () => container.querySelector('.watch-monitor video[src="/next.mp4"]');
  await draw(first, next);
  expect(container.querySelectorAll(".watch-monitor video")).toHaveLength(3);
  expect(queued()?.closest("[data-parked]")).not.toBeNull();
  await act(() => usePlayerStore.setState({ playing: true, playbackReady: false }));
  expect(queued()).toBeNull();
  await act(() => usePlayerStore.setState({ playbackReady: true }));
  const prepared = queued();
  expect(prepared).not.toBeNull();
  await draw(next);
  expect(player.element()).toBe(prepared);
  expect(prepared?.closest("[data-parked]")).toBeNull();
});

it("plays a short cut file on its version clock and hands an out-of-window seek back to the full edit", async () => {
  const timeline = data.timeline!;
  const duration = timelineDuration(timeline);
  const clock = joinClock([{ start: 4, end: 5 }], duration);
  const session = { seek: vi.fn(), finishSeek: vi.fn(), dispose: vi.fn(), sourceTime: () => 0, bufferThrough: vi.fn(async () => {}) };
  const open = vi.spyOn(cutStream, "openCutStream").mockReturnValue(session);
  const file = { url: "/cut-window.mp4", start: 1, end: 6 };
  await show(<MemoryRouter><CutPreview simple={{ marks: [], cutPlayback: { key: "cut", start: 2, side: "after", afterWindow: file } }}
    workingCache={{ cache: { state: "ready", url: "/before.mp4" }, startCache: () => {} }} joined={{ version: timeline.version, timeline, clock }}
    active hasCut spot={0} autoPlaySource={false} onRetryDraft={() => {}} onMedia={() => {}} /></MemoryRouter>);
  const video = player.element()!;
  expect(video.getAttribute("src")).toBe(file.url);
  expect(video.getAttribute("crossorigin")).toBeNull();
  expect(container.querySelector<HTMLVideoElement>('video[src="/before.mp4"]')!.getAttribute("crossorigin")).toBeNull();
  Object.defineProperty(video, "readyState", { configurable: true, value: 4 });
  await act(() => player.seek(5.5));
  expect(video.currentTime).toBe(3.5);
  expect(player.elementTime(5.5)).toBe(3.5);
  await act(() => { video.dispatchEvent(new Event("timeupdate")); });
  expect(usePlayerStore.getState().time).toBe(5.5);
  expect(usePlayerStore.getState().duration).toBe(duration);
  expect(open).not.toHaveBeenCalled();
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  let release!: () => void;
  // A faster playback rate or a late animation frame can reach the physical file end before
  // the pulsing transport checks the audition's planned stop. It must still stop exactly there.
  await act(() => { release = player.audition({ start: 2, end: 6.98, skips: [{ start: 4, end: 5, removed: true }] }, 30); });
  await act(() => { video.dispatchEvent(new Event("ended")); });
  expect(usePlayerStore.getState().time).toBeCloseTo(6.98);
  expect(open).not.toHaveBeenCalled();
  expect(player.element()).toBe(video);
  await act(() => release());
  await act(() => usePlayerStore.setState({ playing: false }));
  await act(() => player.seek(8));
  expect(player.element()).not.toBe(video);
  expect(open).toHaveBeenCalledOnce();
  expect(session.seek).toHaveBeenLastCalledWith(7);
  expect(usePlayerStore.getState().time).toBe(8);
  expect(play.mock.contexts.filter(el => el !== video)).toHaveLength(0);
});

function drawPlayerFormat(source?: ProjectData["media"][number]) {
  const noop = () => {};
  return show(<MemoryRouter><CutPreview simple={{ marks: [] }}
    workingCache={{ cache: { state: "ready", url: "/edit.mp4" }, startCache: noop }} active hasCut source={source} spot={0} autoPlaySource={false}
    onRetryDraft={noop} onMedia={noop} /></MemoryRouter>);
}

it("fills the landscape monitor and fits portrait and square monitors to their pictures", async () => {
  const style = document.createElement("style");
  style.textContent = (await import("../workspace.css?inline")).default;
  document.head.append(style);
  onTestFinished(() => style.remove());

  const examples = [];
  for (const [aspect, width, height] of [["16:9", 1920, 1080], ["9:16", 1080, 1920], ["1:1", 1080, 1080]] as const) {
    const settings = { ...data.project.settings, width, height, aspect };
    await act(() => useProjectStore.setState({ current: { ...data, project: { ...data.project, settings } } }));
    await drawPlayerFormat();
    const size = getComputedStyle(container.querySelector(".watch-monitor")!);
    examples.push({ aspect: width / height, markup: container.innerHTML,
      fillsMonitor: size.width === "100%" && size.height === "100%" });
  }
  if (process.platform === "darwin") {
    const { checkPlayerLayout } = await import("../../test/playerLayout");
    checkPlayerLayout(examples);
  }
  for (const example of examples) {
    expect(example.fillsMonitor, `Full monitor at aspect ${example.aspect}`).toBe(example.aspect > 1);
  }
}, 120_000);

it("uses the full monitor for landscape and fits the picture to the project or selected source", async () => {
  vi.spyOn(api, "sourceCache").mockResolvedValue({ state: "ready", fileKey: "source" });
  const expectMonitor = (aspect: number, landscape: boolean) => {
    const monitor = container.querySelector<HTMLElement>(".watch-monitor")!;
    expect(Number(monitor.style.getPropertyValue("--picture-aspect"))).toBe(aspect);
    expect(monitor.hasAttribute("data-landscape")).toBe(landscape);
  };
  const frame = () => new URL(container.querySelector<HTMLImageElement>('img[alt="Selected edit frame"]')!.src).searchParams;
  await drawPlayerFormat();
  expectMonitor(16 / 9, true);
  await act(() => labeled("Position in the video").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(frame().get("format")).toBe("1920x1080@30");
  const selected = frame().get("frame");
  const settings = { ...data.project.settings, width: 1080, height: 1920, aspect: "9:16" as const };
  await act(() => useProjectStore.setState({ current: { ...data, project: { ...data.project, settings } } }));
  expectMonitor(9 / 16, false);
  expect([frame().get("format"), frame().get("frame")]).toEqual(["1080x1920@30", selected]);

  await drawPlayerFormat({ ...data.media[0]!, width: 1000, height: 1000 });
  expectMonitor(1, false);
  await drawPlayerFormat({ ...data.media[0]!, width: undefined, height: undefined });
  const video = container.querySelector<HTMLVideoElement>(".watch-monitor video")!;
  Object.defineProperties(video, { videoWidth: { value: 1280 }, videoHeight: { value: 720 }, duration: { value: 60 } });
  await act(() => video.dispatchEvent(new Event("loadedmetadata")));
  expectMonitor(16 / 9, true);
  await drawPlayerFormat();
  expectMonitor(9 / 16, false);
});

it("moves the clock and the timeline as the video plays", async () => {
  const noop = () => {};
  await show(<MemoryRouter><CutPreview simple={{ marks: [] }} workingCache={{ cache: undefined, startCache: noop }} active hasCut spot={0} autoPlaySource={false}
    onRetryDraft={noop} onMedia={noop} /></MemoryRouter>);
  for (let i = 1; i <= 60; i++) await act(() => usePlayerStore.getState().setTime(i / 60));
  expect(container.querySelector('[role="slider"]')?.getAttribute("aria-valuenow")).toBe("1");
  expect(container.querySelector(".monitor-clock strong")?.textContent).toBe("0:01");
});

it("leaves static timeline markers alone as the playhead advances", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(720);
  const mark = vi.fn(() => 2);
  const editMarkers = [{ id: "edit", kind: "edit" as const, icon: "trim" as const, description: "Edit", get time() { return mark(); } }];
  await show(<PlayerTimeline duration={10} editMarkers={editMarkers} frameAt={() => undefined} onSeek={() => {}} />);
  expect(mark).toHaveBeenCalled();
  mark.mockClear();
  for (let i = 1; i <= 10; i++) await act(() => usePlayerStore.getState().setTime(i / 10));
  expect(mark).not.toHaveBeenCalled();
  expect(container.querySelector('[role="slider"]')?.getAttribute("aria-valuenow")).toBe("1");
});

it("uses a newly finished source proxy as soon as the engine publishes it", async () => {
  const source = data.media[0]!;
  const cache = vi.spyOn(api, "sourceCache").mockResolvedValueOnce({ state: "caching" })
    .mockResolvedValue({ state: "ready", fileKey: "finished" });
  const noop = () => {};
  vi.useFakeTimers();
  try {
    await show(<MemoryRouter><CutPreview simple={{ marks: [] }} workingCache={{ cache: undefined, startCache: noop }}
      active source={source} autoPlaySource={false} hasCut={false} spot={0}
      onRetryDraft={noop} onMedia={noop} /></MemoryRouter>);
    await act(() => dispatchWsEvent({ type: "media.previewReady", projectId: data.id, mediaId: source.id }));
    expect(cache).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLVideoElement>(".timeline-track video")?.src).toBe(api.sourceCacheUrl(source.id, "finished"));
    expect(container.querySelector<HTMLVideoElement>("video")?.src).toBe(api.sourceCacheUrl(source.id, "finished"));
  } finally { vi.useRealTimers(); }
});

it("keeps a playing source on its file while preparing the newly selected preview resolution", async () => {
  const source = data.media[0]!;
  const cache = vi.spyOn(api, "sourceCache")
    .mockResolvedValueOnce({ state: "ready", fileKey: "old" })
    .mockResolvedValueOnce({ state: "caching" })
    .mockResolvedValueOnce({ state: "caching" })
    .mockResolvedValueOnce({ state: "uncached" })
    .mockResolvedValueOnce({ state: "ready", fileKey: "new" });
  const noop = () => {};
  vi.useFakeTimers();
  try {
    await show(<MemoryRouter><CutPreview simple={{ marks: [] }} workingCache={{ cache: undefined, startCache: noop }}
      active source={source} autoPlaySource={false} hasCut={false} spot={0}
      onRetryDraft={noop} onMedia={noop} /></MemoryRouter>);
    const video = () => container.querySelector<HTMLVideoElement>("video")!;
    const first = video();
    expect(first.src).toBe(api.sourceCacheUrl(source.id, "old"));
    await act(async () => { first.dispatchEvent(new Event("play")); });
    await act(async () => { dispatchWsEvent({ type: "render.settings.updated" }); });
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(cache.mock.calls).toEqual([false, false, true, false, true].map(prepare => [source.id, prepare]));
    expect(video()).toBe(first);
    await act(async () => { first.dispatchEvent(new Event("pause")); });
    expect(video().src).toBe(api.sourceCacheUrl(source.id, "new"));
    await show(null);
  } finally { vi.useRealTimers(); }
});

it("reuses the source decoder across edit points into the same recording", async () => {
  const asset = { ...data.media[0]!, duration: 120 };
  const timeline = { ...data.timeline!, tracks: [{ ...data.timeline!.tracks[0]!, clips: [
    mc("first", asset.id, 10, 15, 0), mc("next", asset.id, 30, 40, 5, { speed: 2 }),
  ] }] };
  const open = vi.spyOn(sourcePlayback, "openSourcePlayback");
  const noop = () => {};
  const view = (time: number) => <OriginalFootage onVideo={noop} onToggle={noop} onPlaybackChange={noop} timeline={timeline}
    target={{ time }} end={10} media={[{ ...asset }]} autoPlay={false} onPosition={noop} onAdvance={noop} failedTimeline={false} onRetryTimeline={noop} />;
  await show(view(1));
  const video = container.querySelector("video")!;
  vi.spyOn(video, "readyState", "get").mockReturnValue(4);
  await act(() => video.dispatchEvent(new Event("loadedmetadata")));
  await show(view(5));
  expect(open).toHaveBeenCalledTimes(1);
  expect(video.currentTime).toBe(30);
  expect(video.playbackRate).toBe(2);
});

it("compares a multi-source first cut with the visible original at its source time", async () => {
  const base = data.timeline!;
  const camera = data.media[0]!;
  const screen = { ...camera, id: "screen", name: "Screen.mp4", duration: 120 };
  const track = base.tracks[0]!;
  const timeline = { ...base, tracks: [
    { ...track, clips: [mc("camera", camera.id, 0, 20, 0)] },
    { ...track, id: "screen-track", clips: [mc("screen", screen.id, 40, 80, 0, { speed: 2 })] },
  ] };
  const change = { ...data.changes[0]!, renders: [{ before: null, after: null, beforeRange: { start: 0, end: 0 }, range: { start: 3, end: 18 } }] };
  const read = vi.spyOn(api, "timeline").mockResolvedValue({ timeline });
  const playback = vi.spyOn(sourcePlayback, "openSourcePlayback");
  useProjectStore.setState({ current: { ...data, media: [camera, screen] }, requestRender: vi.fn().mockResolvedValue(data.renders[0]) });
  await show(<ChangeClip change={change} aspect={1} />);
  const scrub = (key: string, shiftKey = false) => act(() => {
    container.querySelector('[role="slider"]')!.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
  });
  await scrub("ArrowRight", true);
  await click(compareButton());
  expect(read).toHaveBeenCalledWith(change.projectId, change.toVersion);
  expect(playback).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ start: 48, duration: 120 }));
  expect(container.querySelector('[aria-label="Original footage"]')).toBeTruthy();
  expect(container.textContent).toContain(screen.name);
  await click(compareButton());
  expect(container.querySelector('[aria-label="Original footage"]')).toBeNull();
  expect(container.querySelector('[aria-label="Previous preview section"]')).toBeNull();
});

it.each(["Before", "After"] as const)("disables the comparison when a saved clip has only %s", async side => {
  useProjectStore.setState({ current: { ...data, media: [] } });
  const id = data.renders[0]!.id;
  const change = { ...data.changes[0]!, renders: [{
    range: { start: 0, end: 5 }, before: side === "Before" ? id : null, after: side === "After" ? id : null,
  }] };
  await show(<ChangeClip change={change} aspect={1} />);
  const toggle = compareButton();
  expect(toggle.disabled).toBe(true);
  expect(toggle.getAttribute("aria-pressed")).toBe(String(side === "Before"));
  const key = new KeyboardEvent("keydown", { key: "\\", bubbles: true, cancelable: true });
  await act(() => { toggle.dispatchEvent(key); });
  expect(key.defaultPrevented).toBe(false);
  expect(toggle.getAttribute("aria-pressed")).toBe(String(side === "Before"));
});

it("prepares only the visible side and ten-second section of a long change", async () => {
  const change = { ...data.changes[0]!, renders: [{ range: { start: 3, end: 105 }, beforeRange: { start: 5, end: 27 }, before: null, after: null }] };
  const requestRender = vi.fn().mockResolvedValue({ ...data.renders[0]!, state: "running" });
  useProjectStore.setState({ requestRender });
  await show(<ChangeClip change={change} aspect={1} active={false} />);
  expect(requestRender).not.toHaveBeenCalled();
  await show(<ChangeClip change={change} aspect={1} active />);
  expect(requestRender).toHaveBeenCalledExactlyOnceWith({ kind: "segment", version: change.toVersion, quality: "preview", range: { start: 3, end: 13 } });
  const skip = async () => {
    for (let i = 0; i < 10; i++) await act(() => {
      container.querySelector('[role="slider"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }));
    });
  };
  await skip();
  await vi.waitFor(() => expect(requestRender.mock.lastCall?.[0]).toMatchObject({ version: change.toVersion, range: { start: 13, end: 23 } }));
  await click(compareButton());
  await vi.waitFor(() => expect(requestRender.mock.lastCall?.[0]).toMatchObject({ version: change.fromVersion, range: { start: 15, end: 25 } }));
  await skip();
  await vi.waitFor(() => expect(requestRender.mock.lastCall?.[0]).toMatchObject({ version: change.fromVersion, range: { start: 25, end: 27 } }));
  expect(compareButton().getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector('[aria-label="Next preview section"]')).toBeNull();
  expect(requestRender).toHaveBeenCalledTimes(4);
});

it("keeps one decoder and an absolute timeline clock across long cut-review sections", async () => {
  const change = data.changes[0]!;
  const original = data.timeline!;
  const cut = { original, before: { range: { start: 3, end: 38 } }, removed: { start: 5, end: 36 },
    after: { range: { start: 2, end: 6 } }, at: 4 };
  const session = { seek: vi.fn(), finishSeek: vi.fn(), bufferThrough: vi.fn(async () => {}), dispose: vi.fn(), sourceTime: vi.fn<() => number>() };
  const open = vi.spyOn(cutStream, "openCutStream").mockImplementation(video => {
    session.sourceTime.mockImplementation(() => video.currentTime);
    return session;
  });
  const requestRender = vi.fn().mockResolvedValue(data.renders[0]);
  useProjectStore.setState({ requestRender });
  const view = (after?: typeof cut.after) => <ChangeClip inMonitor change={change} aspect={1} cut={{ ...cut, after }} timelineHost={container} />;
  await show(view());
  const video = container.querySelector("video")!;
  expect(open).toHaveBeenCalledWith(video, expect.any(Array), 3, expect.any(Function), expect.any(Function), cut.before.range);
  vi.spyOn(video, "readyState", "get").mockReturnValue(4);
  const slider = container.querySelector('[role="slider"]')!;
  for (const time of [13.2, 23.7, 34.1]) {
    await act(() => { video.currentTime = time; video.dispatchEvent(new Event("timeupdate")); });
    expect(container.querySelector("video")).toBe(video);
    expect(Number(slider.getAttribute("aria-valuenow"))).toBeCloseTo(time);
  }
  await act(() => slider.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
  expect(video.currentTime).toBe(3);
  expect(session.seek).toHaveBeenCalledWith(3);
  session.sourceTime.mockReturnValue(3);
  await act(() => { video.currentTime = 34.1; video.dispatchEvent(new Event("timeupdate")); });
  expect(Number(slider.getAttribute("aria-valuenow"))).toBe(3);
  expect(open).toHaveBeenCalledTimes(1);
  expect(requestRender).not.toHaveBeenCalled();
  await click(compareButton());
  expect(session.dispose).toHaveBeenCalledTimes(1);
  expect(compareButton().getAttribute("aria-busy")).toBe("true");
  expect(compareButton().getAttribute("aria-pressed")).toBe("false");
  expect(container.querySelector("video")).toBeNull();
  expect(requestRender).not.toHaveBeenCalled();
  await show(view(cut.after));
  expect(requestRender).toHaveBeenCalledWith(expect.objectContaining({ version: change.toVersion, range: cut.after.range }));
});

it("seeks to an exact time in a distant window and plays into the next window without paging", async () => {
  const change = { ...data.changes[0]!, renders: [{ range: { start: 3, end: 45 }, beforeRange: { start: 5, end: 47 }, before: null, after: null }] };
  const requestRender = vi.fn(async ({ range }: { range: { start: number; end: number } }) => ({
    ...data.renders[0]!, id: `preview-${range.start}`, state: "done" as const, range,
  }));
  useProjectStore.setState({ requestRender });
  await show(<ChangeClip change={change} aspect={1} previewTimeline={data.timeline!} />);
  const seek = (key: string, shiftKey = false) => act(() => {
    container.querySelector('[role="slider"]')!.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
  });
  for (let i = 0; i < 22; i++) await seek("ArrowRight", true);
  await vi.waitFor(() => expect(container.querySelector("video")?.src).toContain("preview-23"));
  const el = container.querySelector("video")!;
  Object.defineProperty(el, "duration", { configurable: true, value: 10 });
  await act(() => el.dispatchEvent(new Event("loadedmetadata")));
  expect(el.currentTime).toBe(2);
  expect(container.querySelector('[role="slider"]')?.getAttribute("aria-valuenow")).toBe("25");
  await vi.waitFor(() => expect(requestRender).toHaveBeenCalledWith(expect.objectContaining({ range: { start: 33, end: 43 } })));
  await act(() => el.dispatchEvent(new Event("ended")));
  expect(container.querySelector("video")?.src).toContain("preview-33");
  expect(requestRender.mock.calls.filter(([body]) => body.range.start === 33)).toHaveLength(1);
  expect(container.querySelector('[role="slider"]')?.getAttribute("aria-valuenow")).toBe("33");
});

it("shows an export again after a reload or restart, saves it to the destination chosen before, and releases it", async () => {
  const owner = "5b0f0c52-6d0f-4f0e-9a52-3f1f7a1f0c11";
  const kept: Render = { ...data.renders[0]!, id: "kept-export", version: data.project.head!, kind: "export", quality: "preview", range: { start: 0, end: 4 },
    exportOptions: { height: 480 }, projectSettings: data.project.settings, state: "running", progress: 0.42,
    export: { owner, name: "Interview final.mp4", ticket: 31, path: "/chosen/Interview final.mp4" } };
  vi.spyOn(api, "exports").mockResolvedValue({ renders: [kept] });
  const request = vi.spyOn(api, "requestRender");
  const choose = vi.spyOn(desktop, "chooseVideoExport");
  let state: Render = kept;
  vi.spyOn(api, "render").mockImplementation(async () => {
    if (state.state === "queued") throw new TypeError("Failed to fetch");
    return { render: state };
  });
  const release = vi.spyOn(api, "releaseRender").mockResolvedValue();
  const discard = vi.spyOn(desktop, "discardVideoExport").mockResolvedValue();
  const save = vi.spyOn(desktop, "finishVideoExport").mockResolvedValue("/chosen/Interview final.mp4");
  await act(() => resumeExports());
  await act(() => resumeExports());
  await show(<ExportSheet hasCut onClose={() => {}} />);
  expect(container.textContent).toContain("Exporting · 42%");
  expect(container.querySelector("progress")!.getAttribute("aria-label")).toBe("Export progress for Interview final.mp4");
  expect(container.querySelector("#export-resolution")!.textContent).toMatch(/ × 480$/);
  expect(button("Cancel export")).toBeDefined();
  // The engine restarting mid-export is not a failure.
  state = { ...kept, state: "queued" };
  await act(() => new Promise(resolve => setTimeout(resolve, 900)));
  expect(container.textContent).toContain("Exporting · 42%");
  state = { ...kept, state: "done", progress: 1, path: "kept-export.mp4" };
  await act(async () => { await vi.waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith(31, api.renderFileUrl(kept.id)), { timeout: 2500 }); });
  await act(async () => { await vi.waitFor(() => expect(release).toHaveBeenCalledExactlyOnceWith(kept.id, owner)); });
  expect(button("Show in folder")).toBeDefined();
  expect(useUiStore.getState().notifications[0]).toMatchObject({ title: "Export finished", body: "Interview final.mp4", projectId: PRJ });
  expect(request).not.toHaveBeenCalled();
  expect(choose).not.toHaveBeenCalled();
  expect(desktop.keepVideoExport).not.toHaveBeenCalled();
  expect(discard).not.toHaveBeenCalledWith(31);
});

it("chooses the MP4 destination before requesting a current-format render, then automatically saves that exact version", async () => {
  const render: Render = { ...data.renders[0]!, id: "final", version: data.project.head!, kind: "full", quality: "delivery", range: null, state: "running" };
  const choose = vi.spyOn(desktop, "chooseVideoExport").mockResolvedValue(null);
  const start = vi.spyOn(api, "requestRender").mockResolvedValue({ render });
  const keep = vi.mocked(desktop.keepVideoExport);
  const poll = vi.spyOn(api, "render").mockResolvedValue({ render: { ...render, state: "done" } });
  let finishSave!: (path: string) => void;
  const save = vi.spyOn(desktop, "finishVideoExport").mockImplementation(() => new Promise(resolve => { finishSave = resolve; }));
  const openUrl = vi.spyOn(desktop, "openUrl").mockResolvedValue();
  vi.spyOn(desktop, "discardVideoExport").mockResolvedValue();
  await show(<><ExportSheet hasCut onClose={() => {}} /><ExportStarNotice /></>);
  await click(exportButton()!);
  expect(choose).toHaveBeenCalledWith(expect.stringMatching(/\.mp4$/));
  expect(start).not.toHaveBeenCalled();
  expect(button("Star on GitHub")).toBeUndefined();
  choose.mockResolvedValue({ ticket: 17, path: "/chosen/cut.mp4" });
  await click(exportButton()!);
  expect(start).toHaveBeenCalledWith(PRJ, { version: data.project.head, kind: "full", quality: "delivery", owner: expect.any(String),
    export: { name: expect.stringMatching(/\.mp4$/), ticket: 17, path: "/chosen/cut.mp4" } });
  expect(keep).toHaveBeenCalledExactlyOnceWith(17);
  expect(save).not.toHaveBeenCalled();
  const nextProject = { ...data, id: "other", project: { ...data.project, id: "other", head: "other-cut" } };
  await act(() => useProjectStore.setState({ current: nextProject }));
  expect(exportButton()).not.toBeNull();
  await act(async () => { await vi.waitFor(() => expect(save).toHaveBeenCalledWith(17, api.renderFileUrl(render.id)), { timeout: 1500 }); });
  expect(poll).toHaveBeenCalledWith(render.id);
  expect(button("Star on GitHub")).toBeUndefined();
  await act(async () => finishSave("/chosen/cut.mp4"));
  expect(button("Star on GitHub")).toBeDefined();
  expect(openUrl).not.toHaveBeenCalled();
  await click(button("Star on GitHub")!);
  expect(openUrl).toHaveBeenCalledExactlyOnceWith("https://github.com/Forward-Future/scarlet");
  expect(button("Star on GitHub")).toBeUndefined();
  expect(button("Show in folder")).toBeUndefined();
  await act(() => useProjectStore.setState({ current: data }));
  const reveal = vi.spyOn(desktop, "revealPath").mockResolvedValue();
  await click(button("Show in folder")!);
  expect(reveal).toHaveBeenCalledWith("/chosen/cut.mp4");
});

it("offers a star after a successful save and remembers the invitation across exports and restarts", async () => {
  const render: Render = { ...data.renders[0]!, version: data.project.head!, kind: "full", quality: "delivery", range: null, state: "done" };
  vi.spyOn(desktop, "chooseVideoExport").mockResolvedValue({ ticket: 8, path: "/chosen/cut.mp4" });
  vi.spyOn(api, "requestRender").mockResolvedValue({ render });
  vi.spyOn(desktop, "discardVideoExport").mockResolvedValue();
  vi.spyOn(desktop, "finishVideoExport").mockRejectedValueOnce(new Error("Save failed")).mockResolvedValue("/chosen/cut.mp4");
  await show(<><ExportSheet hasCut onClose={() => {}} /><ExportStarNotice /></>);
  await click(exportButton()!);
  expect(container.textContent).toContain("Save failed");
  expect(button("Star on GitHub")).toBeUndefined();
  await click(button("Retry")!);
  await click(labeled("Dismiss GitHub invitation"));
  await click(exportButton()!);
  expect(button("Star on GitHub")).toBeUndefined();
  await act(() => useUiStore.setState({ exportStarNotice: "unseen" }));
  await click(exportButton()!);
  expect(button("Star on GitHub")).toBeUndefined();
});

it("discards the chosen destination on failure or cancellation, and retries from the current edit", async () => {
  const choose = vi.spyOn(desktop, "chooseVideoExport").mockResolvedValueOnce({ ticket: 8, path: "/chosen/cut.mp4" }).mockResolvedValueOnce({ ticket: 9, path: "/chosen/cut.mp4" });
  const render: Render = { ...data.renders[0]!, id: "final", version: data.project.head!, kind: "full", quality: "delivery", range: null, state: "failed", error: "Disk full" };
  const request = vi.spyOn(api, "requestRender").mockResolvedValueOnce({ render }).mockResolvedValueOnce({ render: { ...render, state: "running" } });
  const release = vi.spyOn(api, "releaseRender").mockResolvedValue();
  const discard = vi.spyOn(desktop, "discardVideoExport").mockResolvedValue();
  const save = vi.spyOn(desktop, "finishVideoExport");
  await show(<><ExportSheet hasCut onClose={() => {}} /><ExportStarNotice /></>);
  await click(exportButton()!);
  expect(container.textContent).toContain("Disk full");
  expect(discard).toHaveBeenCalledWith(8);
  await click(button("Retry")!);
  await click(button("Cancel export")!);
  expect(release).toHaveBeenCalledWith(render.id, request.mock.calls[1]![1].owner);
  await act(async () => { await vi.waitFor(() => expect(discard).toHaveBeenCalledWith(9), { timeout: 1500 }); });
  expect(request).toHaveBeenCalledTimes(2);
  expect(choose).toHaveBeenCalledTimes(2);
  expect(save).not.toHaveBeenCalled();
  expect(button("Star on GitHub")).toBeUndefined();
});

it("keeps the destination untouched if the cut changes while choosing where to export", async () => {
  vi.spyOn(desktop, "chooseVideoExport").mockImplementation(async () => {
    useProjectStore.setState({ current: { ...data, project: { ...data.project, head: "restored" } } });
    return { ticket: 12, path: "/chosen/cut.mp4" };
  });
  const discard = vi.spyOn(desktop, "discardVideoExport").mockResolvedValue();
  const request = vi.spyOn(api, "requestRender");
  await show(<ExportSheet hasCut onClose={() => {}} />);
  await click(exportButton()!);
  expect(request).not.toHaveBeenCalled();
  expect(discard).toHaveBeenCalledWith(12);
});

it("follows the video when an edit lands while Export is open, and drops the last export's line once the video has changed", async () => {
  vi.spyOn(desktop, "chooseVideoExport").mockResolvedValue({ ticket: 8, path: "/chosen/cut.mp4" });
  vi.spyOn(desktop, "discardVideoExport").mockResolvedValue();
  vi.spyOn(desktop, "finishVideoExport").mockResolvedValue("/chosen/cut.mp4");
  const request = vi.spyOn(api, "requestRender").mockImplementation(async (_id, body) => ({ render: {
    ...data.renders[0]!, id: "final", version: body.version!, kind: "full", quality: "delivery", range: null, state: "done" } }));
  await show(<ExportSheet hasCut onClose={() => {}} />);
  await click(exportButton()!);
  await act(async () => { await vi.waitFor(() => expect(button("Show in folder")).toBeDefined()); });
  expect(button("Close")).toBeDefined();
  // Scarlet applies an edit: the video is a newer version, and shorter. The saved file is the earlier video, so its
  // line goes, and the sheet doesn't ask to be reopened.
  const earlier = buildDb().timelines.ver_2!;
  expect(timelineDuration(earlier)).not.toBe(timelineDuration(data.timeline!));
  const edited = { ...data, project: { ...data.project, head: "ver_4" }, timeline: { ...earlier, version: "ver_4" } };
  await act(async () => useProjectStore.setState({ current: edited }));
  expect(button("Show in folder")).toBeUndefined();
  expect(button("Close")).toBeUndefined();
  expect(button("Cancel")).toBeDefined();
  expect(container.querySelector('[role="alert"]')?.textContent ?? "").toBe("");
  // A range picked from here starts as the whole of the video as it is now.
  await selectOption(container.querySelector<HTMLButtonElement>("#export-range")!, "Custom range");
  expect(Number(container.querySelector<HTMLInputElement>("#export-end")!.value.split(":")[1])).toBeCloseTo(timelineDuration(earlier), 1);
  await selectOption(container.querySelector<HTMLButtonElement>("#export-range")!, /^Whole/);
  // Export is live and takes the newest version.
  expect(exportButton()!.disabled).toBe(false);
  await click(exportButton()!);
  expect(request).toHaveBeenLastCalledWith(PRJ, expect.objectContaining({ version: "ver_4" }));
  await act(async () => { await vi.waitFor(() => expect(button("Show in folder")).toBeDefined()); });
  // Back on the version exported first, the newest export is of another video.
  await act(async () => useProjectStore.setState({ current: data }));
  expect(button("Show in folder")).toBeUndefined();
});

it("asks for the file's name once, in the system's Save dialog, which opens on the project's name", async () => {
  const picked = { ticket: 5, path: "/Users/me/Movies/What's next? <final> | v2.mp4" };
  const choose = vi.spyOn(desktop, "chooseVideoExport").mockResolvedValue(picked);
  vi.spyOn(desktop, "discardVideoExport").mockResolvedValue();
  const render: Render = { ...data.renders[0]!, id: "final", version: data.project.head!, kind: "full", quality: "delivery", range: null, state: "done" };
  const request = vi.spyOn(api, "requestRender").mockResolvedValue({ render });
  vi.spyOn(desktop, "finishVideoExport").mockRejectedValue(new Error("Disk full"));
  await show(<ExportSheet hasCut onClose={() => {}} />);
  // The sheet has no box for the name and no row for the folder: what to export, the video's options, and one button.
  expect([...container.querySelectorAll("form label")].filter(label => !label.closest("details")).map(label => label.textContent)).toEqual(["Format", "Range"]);
  // The range starts on the whole video, by that name.
  expect(container.querySelector("#export-range")!.textContent).toBe("Whole video");
  expect(container.querySelector("form input, #export-folder")).toBeNull();
  expect(exportButton()!.textContent).toBe("Export");
  await click(exportButton()!);
  // The dialog opens on the project's name, with nothing of the version in it.
  expect(choose).toHaveBeenCalledExactlyOnceWith(`${data.project.name}.mp4`);
  // The name given there is the file's, whatever characters the system allowed in it.
  expect(request).toHaveBeenCalledWith(PRJ, expect.objectContaining({ export: { name: "What's next? <final> | v2.mp4", ...picked } }));
  // The export failed. The button retries, and the dialog asks where to save again.
  expect(container.textContent).toContain("Disk full");
  expect(exportButton()!.textContent).toBe("Retry");
  expect(exportButton()!.disabled).toBe(false);
  await selectOption(container.querySelector<HTMLButtonElement>("#export-format")!, /\.otio/);
  await click(exportButton()!);
  expect(choose).toHaveBeenLastCalledWith(`${data.project.name}.otio`);
});

it("says an export is waiting to start or finishing, with no percent that would sit still", async () => {
  vi.spyOn(desktop, "chooseVideoExport").mockResolvedValue({ ticket: 9, path: "/chosen/cut.mp4" });
  vi.spyOn(desktop, "discardVideoExport").mockResolvedValue();
  let state: Render = { ...data.renders[0]!, id: "behind-others", version: data.project.head!, kind: "full", quality: "delivery", range: null, state: "queued", progress: 0 };
  vi.spyOn(api, "requestRender").mockImplementation(async () => ({ render: state }));
  vi.spyOn(api, "render").mockImplementation(async () => ({ render: state }));
  await show(<ExportSheet hasCut onClose={() => {}} />);
  await click(exportButton()!);
  const bar = () => container.querySelector<HTMLProgressElement>("progress.activity-progress")!;
  const line = () => container.querySelector(".activity-progress + [role='status']")?.textContent;
  const reads = (text: string) => act(async () => { await vi.waitFor(() => expect(line()).toBe(text), { timeout: 2500 }); });
  // Behind other renders there is nothing to count: no "0%", and a bar with no value.
  expect(line()).toBe("Waiting to start");
  expect(bar().hasAttribute("value")).toBe(false);
  state = { ...state, state: "running", progress: 0.42 };
  await reads("Exporting · 42%");
  expect(bar().position).toBe(0.42);
  // The engine counts the picture, which ends at 97%. The audio mix and the final join report nothing.
  state = { ...state, progress: 0.97 };
  await reads("Finishing…");
  expect(bar().hasAttribute("value")).toBe(false);
  await click(button("Cancel export")!);
});

it("maps a visible cut minute onto only the needed trimmed source chunks", () => {
  const source = data.media.find(m => m.transcriptId)!;
  const base = mediaClipsFor(data.timeline!)[0]!.clip;
  const clip = { ...base, mediaId: source.id, timelineIn: 60, sourceIn: 180, sourceOut: 420, speed: 2 };
  const clips = [{ trackId: "video", clip }, { trackId: "audio", clip }, { trackId: "video", clip: { ...clip, timelineIn: 480 } }];
  expect(transcriptChunks(undefined, [source], clips, 60, 120).map(c => [c.mediaId, c.from, c.to]))
    .toEqual([[source.id, 180, 240], [source.id, 240, 300]]);
  expect(transcriptChunks(undefined, [source], clips, 240, 300)).toEqual([]);
});

it("adds a second zoom step to the one under way, and turns a zoom back from where it has got to", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
  let now = 0, id = 0;
  const pending = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { pending.set(++id, fn); return id; });
  vi.stubGlobal("cancelAnimationFrame", (token: number) => pending.delete(token));
  const advance = (ms: number) => act(() => {
    now += ms;
    const callbacks = [...pending.values()];
    pending.clear();
    callbacks.forEach(fn => fn(now));
  });
  const seek = vi.fn();
  const render = (time: number) => show(<TimelineScrubber duration={3468} playhead={time} onSeek={seek} frameAt={() => undefined} />);
  usePlayerStore.setState({ time: 50, playing: true });
  await render(50);
  const slider = container.querySelector(".timeline-slider");
  const level = () => container.querySelector(".timeline-zoom-level")?.textContent;
  await click(labeled("Timeline controls"));
  await click(labeled("Zoom in"));
  expect(level()).toBe("1×");
  await advance(130);
  const halfway = parseFloat(level()!);
  expect(halfway).toBeGreaterThan(1);
  await render(51); // An unrelated playback tick must not pull the view back.
  expect(container.querySelector(".timeline-slider")).toBe(slider);
  await click(labeled("Zoom in")); // A second step compounds the pending destination.
  await advance(500);
  expect(level()).toBe("4×");
  await click(labeled("Zoom out"));
  await advance(60);
  await click(labeled("Fit timeline")); // Reverse an in-flight zoom from its current pose.
  await advance(500);
  expect(level()).toBe("1×");
  expect(seek).not.toHaveBeenCalled();
});
