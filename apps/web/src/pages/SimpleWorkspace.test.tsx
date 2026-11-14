// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fullRenderContext, REVISED_CHECK, ScarletApiError, type Learning, type Skill, type SourceCacheStatus } from "@scarlet/shared";
import { applyOps, makeMediaClip, makeTimeMap, makeTrack, planCutReview, timelineDuration, timelineFromKeepRanges, type MediaClip, type TimeMap } from "@scarlet/timeline";
import { api } from "../lib/client";
import { desktop } from "../lib/desktop";
import { startAppLog, stopAppLog } from "../lib/appLog";
import { useExports, type ExportJob } from "../lib/exportJobs";
import { keepEdits } from "../lib/keptEdits";
import { buildDb, buildTranscript, PRJ } from "../lib/mock/fixtures";
import { buildThreads } from "../lib/threads";
import { player } from "../lib/player";
import { captureProjectPlace } from "../lib/updatePlace";
import { useHostsStore } from "../stores/hosts";
import { usePlayerStore } from "../stores/player";
import { useProjectStore, type ProjectData } from "../stores/project";
import { useSkillsStore } from "../stores/skills";
import { useUiStore } from "../stores/ui";
import { cutAudition, cutOnWorkingCut, lengthLabel, SimpleWorkspace } from "./SimpleWorkspace";
import * as watch from "./WatchPage";
import { madeSentence, sentenceText } from "../lib/madeSentence";
import { QueueTray } from "../components/chat/QueueTray";
import { cutSource } from "../components/review/retakeLookup";
import { enqueueImports } from "../components/media/UploadDropzone";

import { ChangelogPage } from "./ChangelogPage";
import { selectOption } from "../../test/selectOption";

/** The message box has its own tests. Here it records what the workspace hands it, and draws the tray it is given. */
type BoxProps = { onCreated?(task: { id: string }): void; onSent?(): void; tray?: React.ReactNode; targetTag?: string; targetIsPoint?: boolean; onClearTarget?(): void;
  editHere?: { time: string; onSelect(): void };
  rewording?: { id: string; text: string; onChange(text: string): void; onSave(text: string, skillIds?: string[]): Promise<void>; onCancel(): void } };
const composer = vi.hoisted(() => ({ props: undefined as BoxProps | undefined }));
vi.mock("../components/agent/Composer", () => ({ Composer: (props: BoxProps) => { composer.props = props; return props.tray ?? null; } }));
vi.mock("../components/agent/AgentChip", async importOriginal => ({
  ...await importOriginal<typeof import("../components/agent/AgentChip")>(),
  useAgentAvailability: () => ({ effective: { agent: "claude", model: "opus" }, none: false, unavailableReason: "" }),
}));

/** A request's words in its heading, without the tag before them that says which cut or edit it was about. */
const wordsOf = (p: Element | null | undefined) => p ? [...p.childNodes].filter(n => !(n instanceof Element && n.classList.contains("simple-revising"))).map(n => n.textContent).join("") : undefined;
/** The tag before a request's words: the cut or edit it was about, in the words the message box showed. */
const tagIn = (el: Element | null | undefined) => el?.querySelector(":is(.unit-msg, .subunit-msg) .simple-revising")?.textContent ?? undefined;

let root: Root;
let container: HTMLDivElement;
let data: ProjectData;
const initialStore = useProjectStore.getState();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  usePlayerStore.setState({ time: 0, duration: 0, playing: false });
  // Each test starts with an empty message box, nothing saved for any request and no dialog left open over the keys.
  useUiStore.setState({ agentDraft: "", agentContext: null, savedDrafts: {}, draftOwner: null, notePopover: null, speaking: false });
  useExports.setState({ jobs: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const db = buildDb();
  vi.spyOn(api, "renders").mockResolvedValue({ renders: [] });
  vi.spyOn(api, "preparePlayback").mockResolvedValue(undefined);
  // Exercises projects that stream while their short standalone file is unavailable.
  vi.spyOn(api, "cutPlaybackFile").mockRejectedValue(new Error("Still streaming"));
  vi.spyOn(api, "sourceCaches").mockResolvedValue({ caches: [] });
  vi.spyOn(api, "recordEditReview").mockResolvedValue(undefined);
  vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings, transcriptionAvailable: true });
  // The workspace reads the skill library as it opens. A test that needs a skill puts it in the store or answers the read.
  vi.spyOn(api, "skills").mockResolvedValue({ skills: [] });
  vi.spyOn(api, "waveform").mockImplementation(async (mediaId, from, to) => ({ mediaId, from, to, peaks: [0.2, 0.8] }));
  vi.spyOn(api, "cutReview").mockResolvedValue({ review: null });
  vi.spyOn(api, "retakes").mockResolvedValue({ groups: [] } as never);
  // Without the engine's list a thread shows its saved edits. Tests that need the working cut's list mock it.
  vi.spyOn(api, "threadEdits").mockRejectedValue(new Error("No engine in this test"));
  const project = db.projects.find(p => p.id === PRJ)!;
  data = {
    id: PRJ, project, timeline: db.timelines[project.head!]!,
    media: project.media, changes: db.changes, notes: db.notes, renders: db.renders,
    tasks: db.tasks, taskEvents: db.taskEvents, versions: db.versions[PRJ]!,
    fullRenderKeys: { context: fullRenderContext(project), preview: db.renders.find(r => r.kind === "full")!.key, delivery: "current-delivery" },
  };
  useProjectStore.setState({ current: data, status: "ready", load: vi.fn(), refreshHead: vi.fn(), loadTaskEvents: vi.fn().mockResolvedValue(undefined) });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useProjectStore.setState(initialStore, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const click = (element: Element) => act(async () => (element as HTMLElement).click());
/** Most tests work on the rows. Expand list disclosures without previewing a finished request's single edit. */
const openEdits = async () => {
  for (const toggle of container.querySelectorAll<HTMLElement>('[aria-label="Edits"] .simple-pass-toggle[aria-expanded="false"]')) await click(toggle);
};
const showFolded = () => act(async () => root.render(<MemoryRouter><SimpleWorkspace /></MemoryRouter>));
const show = async () => { await showFolded(); await openEdits(); };
const turns = () => [...container.querySelectorAll<HTMLElement>("section.simple-turn")];
const threadWith = (changeId: string) => buildThreads(data).find(t => t.changes.some(c => c.id === changeId))!;
const turnFor = (changeId: string) => turns().find(s => s.getAttribute("aria-label") === threadWith(changeId).title)!;
const buttonIn = (scope: Element, text: string) => [...scope.querySelectorAll("button")].find(b => b.textContent?.trim() === text);
/** A suggestion's line in its request's block. Pressed, it plays the suggestion. */
const suggestion = (changeId: string) => turnFor(changeId).querySelector<HTMLButtonElement>(".simple-suggest")!;
/** Every request's block, in the chat or in the fixed spot above the message box. */
const units = () => [...container.querySelectorAll<HTMLElement>(".simple-chat .unit, .simple-pin .unit")];
/**
 * Runs `see` with the simple view's stylesheet in the page. A test lays nothing out, but it does work out which rules
 * apply to an element, so what keeps a layout at real sizes can be read as the chat draws it.
 */
const withSimpleSheet = async (see: () => Promise<void>) => {
  const { readFileSync } = await import("node:fs");
  const sheet = document.createElement("style");
  sheet.textContent = readFileSync(`${import.meta.dirname}/../simple.css`, "utf8");
  document.head.append(sheet);
  try { await see(); } finally { sheet.remove(); }
};
/** What the stylesheet sets for `el`, property by property. */
const styled = (el: Element, ...properties: string[]) => { const style = getComputedStyle(el); return properties.map(property => style.getPropertyValue(property)); };
/** The open cut's or edit's card on top of the timeline. It holds the link to a cut's words, and Undo edit on an applied edit. */
const openHead = () => container.querySelector<HTMLElement>(".cut-transport > .edit-card");
/** The icon on a cut's card that opens its words. It has no text: its name is what hovering says. */
const transcriptLink = () => openHead()!.querySelector<HTMLButtonElement>(".edit-card-words")!;
const transcriptName = () => [transcriptLink().textContent, transcriptLink().getAttribute("aria-label"), transcriptLink().getAttribute("title")];
/** The icon on a cut's card that plays it with the cut footage: whether it's lit, and what hovering says. */
const compareButton = (scope: Element) => scope.querySelector<HTMLButtonElement>('button[aria-label="Before"]')!;
const beforeIcon = (card: Element) => { const b = compareButton(card); return b && [b.textContent, b.getAttribute("aria-label"), b.getAttribute("aria-pressed"), b.getAttribute("title")]; };
/** Undo edit on an applied edit's card: a small icon ahead of Revise, named on hover. */
const undoIcon = () => openHead()!.querySelector<HTMLButtonElement>(".edit-card-acts > .edit-card-undo:first-child")!;
/** The tag in the message box: what the next message revises or answers. None is a new edit. */
const boxTag = () => composer.props!.targetTag;
/** A request in the editor's words, as its heading says it. */
const requestTextFor = (taskId: string) => { const t = data.tasks.find(t => t.id === taskId)!; return t.context.message ?? t.instruction; };

it("shows every request as one chat, oldest first", async () => {
  await show();
  const expected = buildThreads(data).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).map(t => t.title);
  expect(turns().map(s => s.getAttribute("aria-label"))).toEqual(expected);
  expect(container.querySelector('[aria-label="Suggestion"]')).toBeNull();
  // The simple player keeps the picture, the classic timeline (stills, waveform, ruler), Before/After and speed. The header stays out.
  expect(container.querySelector(".timeline-panel .timeline-filmstrip")).not.toBeNull();
  expect(container.querySelector('.watch-monitor > .monitor-controls [aria-label="Playback speed"]')?.textContent).toBe("1×");
  expect(container.querySelector(".cut-heading")).toBeNull();
});

it("draws no diamond for a caption on the timeline, which marks only what needs the editor", async () => {
  // The timeline places its marks once it has a width, which a test has to give it.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("timeline-slider") ? 800 : 0; });
  expect(data.timeline!.tracks.find(t => t.kind === "caption")?.clips).toHaveLength(2);
  await show();
  await act(async () => {});
  expect(container.querySelector(".timeline-ruler")?.textContent).not.toBe("");
  expect(container.querySelector(".timeline-markers, .timeline-marker")).toBeNull();
  // Nothing in the timeline but the timeline itself takes the keyboard's focus.
  expect([...container.querySelectorAll(".timeline-track button")]).toEqual([]);
});

it("loads full steps only for live requests and upgrades a queued request when work begins", async () => {
  const queued = { ...data.tasks[0]!, id: "waiting-in-tray", state: "queued" as const, startedAt: undefined, changeIds: [] };
  data = { ...data, tasks: [...data.tasks, queued], taskEventScopes: { task_done: "conversation" } };
  useProjectStore.setState({ current: data });
  const load = vi.mocked(useProjectStore.getState().loadTaskEvents);
  await showFolded();
  expect(load).toHaveBeenCalledWith("task_running", "all");
  expect(load.mock.calls.map(([id]) => id)).not.toContain("task_done");
  expect(load.mock.calls.map(([id]) => id)).not.toContain(queued.id);
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === queued.id ? { ...t, state: "running", startedAt: new Date().toISOString() } : t) }));
  expect(load).toHaveBeenCalledWith(queued.id, "all");
});

it("offers playback speeds at the monitor's bottom right, and gives the keys back once one is picked", async () => {
  await show();
  const speed = container.querySelector<HTMLButtonElement>('.monitor-controls [aria-label="Playback speed"]')!;
  await click(speed);
  const choices = [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')];
  expect(choices.map(c => c.textContent)).toEqual(["0.5×", "0.75×", "1×", "1.25×", "1.5×", "1.75×", "2×"]);
  await click(choices[4]!);
  expect(usePlayerStore.getState().rate).toBe(1.5);
  expect(speed.textContent).toBe("1.5×");
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  expect(document.activeElement).not.toBe(speed);
  await act(async () => usePlayerStore.getState().setRate(1));
});

it("turns the play button while the picture loads, in place of its icon, with nothing drawn under it", async () => {
  await show();
  const monitor = container.querySelector(".watch-monitor")!;
  const play = () => monitor.querySelector(".monitor-playback > button")!;
  const holds = () => [play().getAttribute("aria-label"), play().querySelector("svg") ? "icon" : play().querySelector(".animate-spin") ? "spinner" : "empty"];
  expect(holds()).toEqual(["Play", "icon"]);
  // The video on screen is short of a frame for longer than a blink.
  const video = monitor.querySelector("video")!;
  Object.defineProperty(video, "readyState", { configurable: true, value: 1 });
  vi.useFakeTimers();
  try {
    await act(async () => { video.dispatchEvent(new Event("waiting")); vi.advanceTimersByTime(180); });
    expect(holds()).toEqual(["Play", "spinner"]);
    expect(monitor.querySelector('.monitor-playback > [role="status"]')?.textContent).toBe("Loading this moment…");
    // The controls go when the pointer leaves the player. They are marked to stay while the button says the picture loads.
    expect(monitor.querySelector(".monitor-playback")!.hasAttribute("data-loading")).toBe(true);
    // The play button sits at the monitor's bottom left and the speed at its bottom right: a spinner of the monitor's
    // own in either corner would be under them.
    expect([...monitor.querySelectorAll(".animate-spin")].every(spinner => spinner.closest(".monitor-playback > button"))).toBe(true);
    await act(async () => { video.dispatchEvent(new Event("canplay")); });
    expect(holds()).toEqual(["Play", "icon"]);
    expect(monitor.querySelector(".monitor-playback")!.hasAttribute("data-loading")).toBe(false);
    expect(monitor.querySelector('[role="status"]:not(.simple-on-video)')).toBeNull();
  } finally { vi.useRealTimers(); }
});

it("turns the Before clip's play button while its stream waits for a section, and a reframe's while the video plays into footage that isn't in", async () => {
  appliedEdits();
  // The version before the edit has the same footage. "music bed" runs the whole video, longer than one prepared
  // section, so its Before plays as a stream.
  vi.spyOn(api, "timeline").mockImplementation(async (_, version = "head") => ({ timeline: { ...data.timeline!, version } }));
  vi.spyOn(await import("../lib/cutStream"), "openCutStream").mockReturnValue({ seek() {}, finishSeek() {}, dispose() {}, sourceTime: () => 0, bufferThrough: async () => {} });
  await show();
  const monitor = container.querySelector(".watch-monitor")!;
  const play = () => monitor.querySelector(".monitor-playback > button")!;
  const holds = () => [play().getAttribute("aria-label"), play().querySelector("svg") ? "icon" : play().querySelector(".animate-spin") ? "spinner" : "empty"];
  const rows = () => [...turnFor("chg_approved_2").querySelectorAll<HTMLElement>(".simple-edits .simple-edit")];
  await click(rows()[0]!);
  await act(async () => {});
  vi.useFakeTimers();
  try {
    await click(compareButton(editPanel()!));
    const clip = monitor.querySelector<HTMLVideoElement>('video[aria-label="Before"]')!;
    // The stream's first section is on its way: the clip says so, and its play button turns once that has lasted.
    expect(clip.hasAttribute("data-waiting")).toBe(true);
    expect(holds()).toEqual(["Play", "icon"]);
    await act(async () => { vi.advanceTimersByTime(180); });
    expect(holds()).toEqual(["Play", "spinner"]);
    // Nothing is drawn in the monitor's corners, where the play button and the speed would cover it.
    expect([...monitor.querySelectorAll(".animate-spin")].every(spinner => spinner.closest(".monitor-playback > button"))).toBe(true);
    await act(async () => { clip.dispatchEvent(new Event("canplay")); });
    expect([clip.hasAttribute("data-waiting"), ...holds()]).toEqual([false, "Play", "icon"]);
    // It stalls on the next section, and says so again.
    await act(async () => { clip.dispatchEvent(new Event("waiting")); vi.advanceTimersByTime(180); });
    expect(holds()).toEqual(["Play", "spinner"]);
    await act(async () => { clip.dispatchEvent(new Event("playing")); });
    expect(holds()).toEqual(["Play", "icon"]);
  } finally { vi.useRealTimers(); }

  // A reframe compares still frames while paused, and plays the video as it runs now. Its play button is its own.
  await act(async () => root.render(null));
  data = { ...data, changes: data.changes.map(c => c.id === "chg_approved_2"
    ? { ...c, ops: [{ op: "updateClip" as const, clipId: "clip_a", patch: { transform: { x: 0, y: 0, scale: 1.2 } } }] } : c) };
  useProjectStore.setState({ current: data });
  await show();
  await click(rows()[2]!);
  await act(async () => {});
  expect(container.querySelector('[alt="Frame after the framing edit"]')).not.toBeNull();
  const reframed = container.querySelector(".watch-monitor")!;
  const button = () => reframed.querySelector(".monitor-playback > button")!;
  const shows = () => [button().getAttribute("aria-label"), button().querySelector("svg") ? "icon" : button().querySelector(".animate-spin") ? "spinner" : "empty"];
  const video = reframed.querySelector<HTMLVideoElement>('video[aria-label="The current edit"]')!;
  Object.defineProperty(video, "readyState", { configurable: true, value: 1 });
  vi.useFakeTimers();
  try {
    // Paused, the frame on screen says for itself when it is loading: the button keeps its icon.
    await act(async () => { video.dispatchEvent(new Event("waiting")); vi.advanceTimersByTime(180); });
    expect(shows()).toEqual(["Play", "icon"]);
    // Playing, it runs into footage that isn't in yet: the button turns until the picture is back.
    await click(button());
    expect(shows()).toEqual(["Pause", "icon"]);
    await act(async () => { video.dispatchEvent(new Event("waiting")); vi.advanceTimersByTime(180); });
    expect(shows()).toEqual(["Pause", "spinner"]);
    await act(async () => { video.dispatchEvent(new Event("playing")); });
    expect(shows()).toEqual(["Pause", "icon"]);
  } finally { vi.useRealTimers(); }
});

const CHECK = "The last word may be clipped";
/** Scarlet's sentence on what the flagged edit did: all its card says. */
const SUMMARY = "Tightened the wrap, which may clip its last word";
/** The applied change's named edits, with a reason to check the last one, as the chat and the player see them. */
const appliedEdits = () => {
  data = { ...data, changes: data.changes.map(c => c.id === "chg_approved_2"
    ? { ...c, timelineEdits: c.timelineEdits!.map((e, i) => i === 2 ? { ...e, check: CHECK, summary: SUMMARY } : e) } : c) };
  useProjectStore.setState({ current: data });
  return markers();
};
/** The engine lists these edits for the request that made them, and none for any other. */
const markers = () => vi.spyOn(api, "threadEdits").mockImplementation(async (_project, threadId) => ({ version: data.project.head!,
  edits: threadId !== threadWith("chg_approved_2").id ? [] : [
    { changeId: "chg_approved_2", spot: 0, label: "music bed", range: { start: 0, end: 16 }, previous: [] },
    { changeId: "chg_approved_2", spot: 1, label: "captions", range: { start: 0.2, end: 2.4 }, previous: [] },
    { changeId: "chg_approved_2", spot: 2, label: "wrap", range: { start: 11.5, end: 16 }, previous: [], check: CHECK, summary: SUMMARY },
  ] }));
/** The open edit's card on top of the timeline: what it changed and its decisions. Its chat row stays one line. */
const editPanel = () => container.querySelector<HTMLElement>('[aria-label="Applied edit"]');
const openTitle = () => container.querySelector('.simple-edit[aria-current="true"] .simple-edit-title')?.textContent;
const press = (key: string) => act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
/** Zooms settle at once, as they do with reduced motion, so a test knows what the timeline shows when it reads it. */
const zoomAtOnce = () => { const reduced = window.matchMedia("(prefers-reduced-motion: reduce)"); vi.spyOn(window, "matchMedia").mockReturnValue(Object.create(reduced, { matches: { value: true } })); };

it("sets the sentence on what a request made in the type of Scarlet's replies, no larger", async () => {
  // A test lays nothing out, so the two sizes are read from the simple view's stylesheet, a rule to a line.
  const { readFileSync } = await import("node:fs");
  const rules = readFileSync(`${import.meta.dirname}/../simple.css`, "utf8").split("\n");
  const size = (selector: string) => rules.find(rule => rule.startsWith(`${selector} {`))?.match(/font-size: ([\d.]+px)/)?.[1];
  expect([size(".simple-made-line"), size(".req-say")]).toEqual(["13px", "13px"]);
});

it("lists a thread's edits once, numbered, and opens one with its decisions under the player", async () => {
  const edits = appliedEdits();
  await showFolded();
  const turn = turnFor("chg_approved_2");
  // The block says what the request changed in one sentence, its figures in bold. The list stays behind the link under it.
  expect(turn.querySelector(".simple-made")?.textContent).toBe("Made 3 edits: music bed, captions, wrap.");
  expect([...turn.querySelectorAll(".simple-made b")].map(b => b.textContent)).toEqual(["3"]);
  expect([turn.querySelector(".simple-pass-toggle")?.textContent, turn.querySelector(".simple-pass-toggle")?.getAttribute("aria-expanded")]).toEqual(["See all", "false"]);
  // The link is on the sentence's own line, right after it.
  expect(turn.querySelector(".simple-made-line > .simple-made + .simple-pass-toggle")).not.toBeNull();
  expect(turn.querySelector(".simple-pass-line .simple-pass-toggle")).toBeNull();
  expect(turn.querySelector(".simple-edits")).toBeNull();
  await openEdits();
  const rows = () => [...turn.querySelectorAll<HTMLButtonElement>(".simple-edits .simple-edit")];
  // The reply carries no Play, Revise or Undo of its own. The thread's edits are listed once, at its end, numbered as on the timeline.
  expect(rows().map(r => r.querySelector(".simple-edit-title")?.textContent)).toEqual(["music bed", "captions", "wrap"]);
  expect(rows().map(r => r.querySelector(".edit-badge")?.textContent)).toEqual(["1", "2", "3"]);
  expect(turn.querySelector(".simple-suggest")).toBeNull();
  // Only the edit Scarlet flagged waits for a look.
  expect(turn.querySelector(".simple-pass-need")?.textContent).toBe("1 needs you");

  await click(rows()[1]!);
  await act(async () => {});
  expect(edits).toHaveBeenCalledWith(PRJ, threadWith("chg_approved_2").id);
  expect(rows()[1]!.getAttribute("aria-current")).toBe("true");
  // The row stays one line in the chat. A card right on top of the timeline carries Before/After and the two decisions, Revise (R)
  // and Keep (K). The strip under the player is gone while it's open.
  const panel = editPanel()!;
  expect(panel.closest(".cut-transport > .edit-card")).toBe(panel);
  expect(panel.nextElementSibling?.querySelector(".timeline-panel")).not.toBeNull();
  expect(container.querySelector(".simple-stage > .player-review")).toBeNull();
  expect(panel.closest(".simple-edits")).toBeNull();
  expect(turn.querySelector(".simple-edits .review-actions, .simple-edits .edit-card-before")).toBeNull();
  expect(openTitle()).toBe("captions");
  // One line: Scarlet's note as the caption, Before/After, Revise and Keep. The card has no picker, and an edit with
  // nothing to check has no count.
  expect(panel.firstElementChild?.matches(".edit-card-bar")).toBe(true);
  expect(panel.querySelector(".edit-card-bar > .edit-card-title:first-child")?.textContent).toBe("captions");
  expect(panel.querySelector(".edit-card-nav, .preference-select")).toBeNull();
  expect(beforeIcon(panel)).toEqual(["", "Before", "false", "Play Before (\\)"]);
  expect(panel.querySelectorAll(".edit-card-side button")).toHaveLength(1);
  expect(compareButton(panel).querySelector("svg")).not.toBeNull();
  expect(panel.querySelector(".edit-card-count")).toBeNull();
  // The conversation stays as it was: every request is still there, and nothing sits over the message box, which is
  // tagged with the edit it now revises. Undo edit is on the card, before its decisions. This edit isn't a cut, so
  // it has no transcript link.
  expect(turns().some(t => t.hidden)).toBe(false);
  expect(container.querySelector(".simple-open")).toBeNull();
  // Undo edit is a small icon, named with its key on hover like Revise and Keep.
  expect([...panel.querySelectorAll(".edit-card-acts button")].map(b => [b.textContent, b.getAttribute("aria-keyshortcuts"), b.getAttribute("title")]))
    .toEqual([["", "U", "Undo edit (U)"], ["Revise", "R", "Revise (R)"], ["Keep", "K", "Keep (K)"]]);
  expect(undoIcon().getAttribute("aria-label")).toBe("Undo edit");
  expect(panel.querySelector(".thread-transcript")).toBeNull();
  expect(boxTag()).toBe("Edit at 0:00");
  // No Close button: Esc and the open row close it.
  expect(panel.querySelector(".review-close")).toBeNull();
  // Nothing to read, so it's the row alone: no status word, no time.
  expect(panel.children).toHaveLength(1);
  expect(panel.querySelector(".edit-card-bar .review-actions")).not.toBeNull();
  expect(panel.textContent).not.toMatch(/Applied|at \d/);
  // The keys show on hover, not in boxes.
  expect([...panel.querySelectorAll(".review-actions button")].map(b => [b.textContent, b.getAttribute("aria-keyshortcuts"), b.getAttribute("title")]))
    .toEqual([["Revise", "R", "Revise (R)"], ["Keep", "K", "Keep (K)"]]);
  expect(panel.querySelector(".simple-key")).toBeNull();
  expect(container.querySelector(".simple-on-video")?.textContent).toBe("Showing “captions” at 0:00");
  expect(container.querySelector(".simple-timeline-band")).not.toBeNull();

  // A note that fits is plain text: nothing to click.
  const note = () => editPanel()!.querySelector<HTMLElement>(".edit-card-title")!;
  expect([note().className, note().getAttribute("aria-expanded")]).toEqual(["edit-card-title", null]);

  // ↓ steps to the next edit, which opens in its place. A flagged edit's note is Scarlet's summary of it, like any other's.
  // A note longer than two lines opens in full on a click and folds on the next. There's no button, only the pointer.
  const tooLong = vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(900);
  await press("ArrowDown");
  tooLong.mockRestore();
  expect(openTitle()).toBe("wrap");
  // A flagged edit says its place among the ones still to check.
  expect(editPanel()!.querySelector(".edit-card-count")?.textContent).toBe("1 of 1");
  expect([note().className, note().getAttribute("aria-expanded"), note().title]).toEqual(["edit-card-title is-clipped", "false", SUMMARY]);
  await click(note());
  expect([note().className, note().getAttribute("aria-expanded")]).toEqual(["edit-card-title is-open", "true"]);
  expect(editPanel()!.querySelector("button.edit-card-title, .edit-card-title button")).toBeNull();
  await click(note());
  expect(note().classList.contains("is-open")).toBe(false);
  // The note is the summary and nothing else: no amber, no second part, no line above it and no label for the flag.
  expect(note().textContent).toBe(SUMMARY);
  expect(note().children).toHaveLength(0);
  expect([...editPanel()!.children].map(c => c.className)).toEqual(["edit-card-bar"]);
  expect(editPanel()!.querySelector(".edit-card-bar")!.textContent).not.toContain("Check");
  expect(rows()[2]!.querySelector(".edit-badge")?.classList.contains("is-check")).toBe(true);

  // Keep records the review and moves on to the next flagged edit that hasn't been kept. That was the only one.
  await click(buttonIn(editPanel()!, "Keep")!);
  expect(editPanel()).toBeNull();
  expect(rows()[2]!.querySelector(".edit-badge")?.classList.contains("is-kept")).toBe(true);
  expect(rows()[2]!.querySelector(".edit-badge svg")).not.toBeNull();
  expect(rows()[2]!.querySelector(".edit-badge")?.textContent).toBe("3");
  expect(turn.querySelector(".simple-pass-need")).toBeNull();

  // Clicking the open row plays it again and leaves it open, with the timeline still on it. Esc closes it and goes
  // back to the whole timeline.
  await click(rows()[0]!);
  expect(openTitle()).toBe("music bed");
  const zoomed = container.querySelector(".simple-timeline-band")?.getAttribute("style");
  await click(rows()[0]!);
  expect(openTitle()).toBe("music bed");
  expect(rows()[0]!.getAttribute("aria-current")).toBe("true");
  expect(container.querySelector(".simple-timeline-band")?.getAttribute("style")).toBe(zoomed);
  await press("Escape");
  expect(editPanel()).toBeNull();
  expect(container.querySelector(".simple-timeline-band")).toBeNull();
  expect(container.querySelector(".simple-on-video")).toBeNull();
  // An earlier request's settled edits leave the timeline: it marks what needs the editor and the request they're on.
  expect(container.querySelector(".simple-timeline-mark")).toBeNull();
  const thread = threadWith("chg_approved_2");
  data = { ...data, changes: thread.changes, tasks: thread.tasks, notes: [] };
  await act(async () => useProjectStore.setState({ current: data }));
  // The latest request's edits are marked. Each dot names its edit by number, sums it up, and says where it runs on hover.
  // The note joins the scrub preview's card, under the frame, instead of opening a second popup below the track.
  const strip = container.querySelector<HTMLElement>(".simple-timeline-hover")!;
  strip.getBoundingClientRect = () => ({ left: 0, width: 1000 }) as DOMRect;
  const tips: Element[] = [];
  for (const mark of container.querySelectorAll<HTMLElement>(".simple-timeline-mark")) {
    await act(async () => { strip.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: parseFloat(mark.style.left) * 10 })); });
    expect(mark.classList.contains("is-hot")).toBe(true);
    expect(mark.querySelector(".simple-timeline-tip")).toBeNull();
    tips.push(...[...container.querySelectorAll(".timeline-track .simple-timeline-tip.is-joined > span")].map(tip => tip.cloneNode(true) as Element));
  }
  await act(async () => { strip.dispatchEvent(new PointerEvent("pointerout", { bubbles: true })); });
  expect(container.querySelector(".simple-timeline-tip")).toBeNull();
  expect(tips.map(tip => tip.querySelector("b")?.textContent)).toEqual(["Edit 1 of 3 · 0:00", "Edit 2 of 3 · 0:00", "Edit 3 of 3 · 0:11"]);
  expect(tips.map(tip => tip.querySelector(".simple-timeline-tip-summary")?.textContent)).toEqual(["music bed", "captions", "wrap"]);
  expect(tips.map(tip => tip.querySelector("small")?.textContent)).toEqual(["0:00–0:16 · 16 s", "0:00–0:02 · 2.2 s", "0:11–0:16 · 4.5 s"]);
  // Each dot carries its edit's number, as in the chat: filled once kept, amber while it asks for a look.
  const dots = [...container.querySelectorAll<HTMLElement>(".simple-timeline-mark.is-numbered")];
  expect(dots.map(d => d.querySelector(".simple-timeline-number")?.textContent)).toEqual(["1", "2", "3"]);
  expect(dots.map(d => d.dataset.state)).toEqual([undefined, undefined, "kept"]);
  // A press on a dot opens its edit in the card, as its row in the chat does, instead of scrubbing.
  expect(editPanel()).toBeNull();
  zoomAtOnce();
  await act(async () => { strip.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, button: 0, pointerId: 1, clientX: parseFloat(dots[2]!.style.left) * 10 })); });
  await act(async () => {});
  expect(openTitle()).toBe("wrap");
  // The open edit's band says where it is, so its own dot goes. The timeline is zoomed to it, with the request's other
  // edits out of view. Zoomed out to the whole video (0) they keep their dots, there to see and to press.
  const numbers = () => [...container.querySelectorAll(".simple-timeline-mark.is-numbered .simple-timeline-number")].map(n => n.textContent);
  expect(container.querySelector(".simple-timeline-band")).not.toBeNull();
  expect(numbers()).toEqual([]);
  await press("0");
  expect(container.querySelector(".simple-timeline-band")).not.toBeNull();
  expect(numbers()).toEqual(["1", "2"]);
  // An edit that runs most of the video has no band to draw: its dot stays, lit, among the others.
  await click(turn.querySelector<HTMLElement>(".simple-edits .simple-edit")!);
  await act(async () => {});
  expect([openTitle(), container.querySelector(".simple-timeline-band")]).toEqual(["music bed", null]);
  expect(numbers()).toEqual(["1", "2", "3"]);
  expect([...container.querySelectorAll(".simple-timeline-mark.is-numbered")].map(d => d.classList.contains("is-on"))).toEqual([true, false, false]);
  // No row of edit points is drawn, with an edit open or closed.
  expect(container.querySelector(".timeline-cuts")).toBeNull();
});

it("steps between a request's edits with the arrow keys, sideways or up and down, and keeps K and Esc", async () => {
  appliedEdits();
  await show();
  const turn = turnFor("chg_approved_2");
  const rows = () => [...turn.querySelectorAll<HTMLButtonElement>(".simple-edits .simple-edit")];
  await click(rows()[0]!);
  await act(async () => {});
  expect(openTitle()).toBe("music bed");
  // ↑ and ↓ step. ← and → are the player's, so they leave the open edit where it is.
  await press("ArrowDown");
  expect(openTitle()).toBe("captions");
  await press("ArrowRight");
  expect(openTitle()).toBe("captions");
  await press("ArrowDown");
  expect(openTitle()).toBe("wrap");
  await press("ArrowUp");
  expect(openTitle()).toBe("captions");
  await press("ArrowLeft");
  expect(openTitle()).toBe("captions");
  await press("ArrowUp");
  expect(openTitle()).toBe("music bed");
  // The request's "needs you" lists just the flagged edit, with the number it has in the whole list, and opens it.
  const need = () => turn.querySelector<HTMLElement>(".simple-pass-need");
  await click(need()!);
  await act(async () => {});
  expect(openTitle()).toBe("wrap");
  expect([need()!.getAttribute("aria-pressed"), turn.querySelector(".simple-edits")?.getAttribute("aria-label")]).toEqual(["true", "Edits that need you"]);
  expect(rows().map(r => [r.querySelector(".edit-badge")?.textContent, r.querySelector(".simple-edit-title")?.textContent])).toEqual([["3", "wrap"]]);
  // The link beside it still lists every edit, and "needs you" brings back just the one.
  await click(turn.querySelector(".simple-pass-toggle")!);
  expect([rows().length, need()!.getAttribute("aria-pressed")]).toEqual([3, "false"]);
  await click(need()!);
  expect(rows().length).toBe(1);
  // K keeps the edit on screen. That was the only one to check, so the card closes, the list of what needed the
  // editor goes with it, and nothing is left to press.
  await press("k");
  expect(editPanel()).toBeNull();
  expect([need(), turn.querySelector(".simple-edits")]).toEqual([null, null]);
  // In the whole list it is ticked.
  await click(turn.querySelector(".simple-pass-toggle")!);
  expect(rows()[2]!.querySelector(".edit-badge")?.classList.contains("is-kept")).toBe(true);
  // Esc closes the card.
  await click(rows()[1]!);
  await act(async () => {});
  expect(openTitle()).toBe("captions");
  await press("Escape");
  expect(editPanel()).toBeNull();
});

it("keeps a reframe's card open, on the side it was on, when → or a press on the timeline leaves its passage", async () => {
  // A reframe only moves the picture inside its clip: its change is nothing but transforms, at 0:02–0:04.
  data = { ...data, changes: data.changes.map(c => c.id === "chg_approved_2" ? { ...c, timelineEdits: [{ label: "Camera full screen", range: { start: 2, end: 4 } }],
    ops: [{ op: "updateClip", clipId: "clip_a", patch: { transform: { scale: 1.4 } } }] } : c) };
  useProjectStore.setState({ current: data });
  vi.spyOn(api, "threadEdits").mockImplementation(async (_project, threadId) => ({ version: data.project.head!,
    edits: threadId !== threadWith("chg_approved_2").id ? [] : [
      { changeId: "chg_approved_2", spot: 0, label: "Camera full screen", kind: "reframe" as const, range: { start: 2, end: 4 }, previous: [] }] }));
  vi.spyOn(api, "timeline").mockImplementation(async (_, version = "head") => ({ timeline: { ...data.timeline!, version } }));
  await show();
  await click(buttonIn(turnFor("chg_approved_2"), "See edit")!);
  await act(async () => {});
  expect(openTitle()).toBe("Camera full screen");
  // Before holds the frame as it was framed before the edit.
  await click(compareButton(editPanel()!));
  expect([sideShown(), usePlayerStore.getState().time]).toEqual(["Before", 2]);
  // → skips 5 seconds, past the end of the passage. The card stays up on Before and the timeline stays on the edit.
  await press("ArrowRight");
  expect([openTitle(), sideShown(), usePlayerStore.getState().time]).toEqual(["Camera full screen", "Before", 7]);
  expect(container.querySelector(".simple-timeline-band")).not.toBeNull();
  // So does a press on the timeline ahead of the passage, at the left edge of the zoomed view.
  const slider = container.querySelector<HTMLElement>(".timeline-slider")!;
  slider.getBoundingClientRect = () => ({ left: 0, width: 1000 }) as DOMRect;
  for (const type of ["pointerdown", "pointerup"]) await act(async () => {
    slider.dispatchEvent(new PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, bubbles: true, clientX: 0 })); });
  expect([openTitle(), sideShown(), usePlayerStore.getState().time]).toEqual(["Camera full screen", "Before", 0]);
  expect(container.querySelector(".simple-timeline-band")).not.toBeNull();
  // Only Esc closes it.
  await press("Escape");
  expect(editPanel()).toBeNull();
  expect(container.querySelector(".simple-timeline-band")).toBeNull();
});

/**
 * Before on an edit that isn't a cut plays a clip of the version before it. Here that version has the same footage,
 * its passage comes back prepared, and "captions" runs from 0:04 to 0:10, long enough to skip inside.
 */
const beforeClipReady = () => {
  appliedEdits().mockImplementation(async (_project, threadId) => ({ version: data.project.head!, edits: threadId !== threadWith("chg_approved_2").id ? [] : [
    { changeId: "chg_approved_2", spot: 0, label: "music bed", range: { start: 0, end: 16 }, previous: [] },
    { changeId: "chg_approved_2", spot: 1, label: "captions", range: { start: 4, end: 10 }, previous: [] },
    { changeId: "chg_approved_2", spot: 2, label: "wrap", range: { start: 11.5, end: 16 }, previous: [], check: CHECK, summary: SUMMARY }] }));
  vi.spyOn(api, "timeline").mockImplementation(async (_, version = "head") => ({ timeline: { ...data.timeline!, version } }));
  useProjectStore.setState({ requestRender: vi.fn().mockResolvedValue({ ...data.renders[0]!, id: "rnd_before", kind: "segment", state: "done" }) });
};
const appliedRows = () => [...turnFor("chg_approved_2").querySelectorAll<HTMLButtonElement>(".simple-edits .simple-edit")];
/** Which side the open edit's switch shows. */
const sideShown = () => compareButton(editPanel()!).getAttribute("aria-pressed") === "true" ? "Before" : "After";
const beforeClip = () => container.querySelector<HTMLVideoElement>('.watch-monitor video[aria-label="Before"]')!;
const playhead = () => Math.round(usePlayerStore.getState().time * 100) / 100;
const monitorClock = () => container.querySelector(".watch-monitor .monitor-clock")?.textContent;
/** Open "captions" and press Before. Its clip's section comes in, and it plays by itself from the passage's top. */
const captionsOnBefore = async () => {
  await click(appliedRows()[1]!);
  await act(async () => {});
  await click(compareButton(editPanel()!));
  await act(async () => {});
  await beforeStarts();
};
const beforeStarts = () => act(async () => {
  Object.defineProperty(beforeClip(), "readyState", { configurable: true, value: 4 });
  Object.defineProperty(beforeClip(), "duration", { configurable: true, value: 6 });
  beforeClip().dispatchEvent(new Event("loadedmetadata"));
});
/** The Before clip has played on to `seconds` from its top. */
const beforePlayedTo = (seconds: number) => act(async () => {
  beforeClip().currentTime = seconds;
  beforeClip().dispatchEvent(new Event("timeupdate"));
});
/** A press on the timeline at a time on screen: the pointer goes down, `held` runs, and it comes up where it went down. */
const pressTimeline = async (time: number, held?: () => void) => {
  const slider = container.querySelector<HTMLElement>(".timeline-slider")!;
  // The open edit's band says where the zoomed timeline puts its passage, from 0:04 to 0:10.
  const band = container.querySelector<HTMLElement>(".simple-timeline-band")!;
  const x = parseFloat(band.style.left) + (time - 4) / 6 * parseFloat(band.style.width);
  slider.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 }) as DOMRect;
  slider.setPointerCapture = vi.fn();
  const pointer = (type: string) => new PointerEvent(type, { bubbles: true, button: 0, isPrimary: true, pointerId: 1, clientX: x });
  await act(async () => { slider.dispatchEvent(pointer("pointerdown")); });
  held?.();
  await act(async () => { slider.dispatchEvent(pointer("pointerup")); });
};
const skipKey = (key: "ArrowLeft" | "ArrowRight", shiftKey = false) => act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true })); });

it("keeps an edit that isn't a cut on Before through a skip or a press inside its passage and its row pressed again, and moves the playhead and the clock with it", async () => {
  beforeClipReady();
  await show();
  await click(appliedRows()[1]!);
  await act(async () => {});
  expect([sideShown(), monitorClock()]).toEqual(["After", "0:04 / 0:16"]);
  await click(compareButton(editPanel()!));
  await act(async () => {});
  await beforeStarts();
  expect([sideShown(), playhead(), beforeClip().paused]).toEqual(["Before", 4, false]);
  // As the Before clip plays, the playhead crosses the edit's passage with it, and the clock stays the video's own,
  // in whole seconds: not the clip's range to the millisecond.
  await beforePlayedTo(0.5);
  expect([playhead(), monitorClock()]).toEqual([4.5, "0:04 / 0:16"]);
  // → skips 5 seconds on in the clip and ← 5 back, or 1 second with Shift. The edit stays on Before and plays on.
  await skipKey("ArrowRight");
  expect([sideShown(), playhead(), monitorClock(), beforeClip().paused]).toEqual(["Before", 9.5, "0:09 / 0:16", false]);
  await skipKey("ArrowLeft");
  expect([sideShown(), playhead()]).toEqual(["Before", 4.5]);
  await skipKey("ArrowRight", true);
  expect([sideShown(), playhead(), beforeClip().paused]).toEqual(["Before", 5.5, false]);
  // A press on the timeline inside the passage holds the clip while the pointer is down, then it plays on from there.
  let held: boolean | undefined;
  await pressTimeline(8, () => { held = beforeClip().paused; });
  expect([held, sideShown(), playhead(), beforeClip().paused]).toEqual([true, "Before", 8, false]);
  // One the editor paused stays paused through a skip and a press.
  await press(" ");
  expect(beforeClip().paused).toBe(true);
  await skipKey("ArrowLeft", true);
  await pressTimeline(6);
  expect([sideShown(), playhead(), beforeClip().paused]).toEqual(["Before", 6, true]);
  // The open row pressed again plays the edit again from its top, on the side it was on.
  const played = beforeClip();
  await click(appliedRows()[1]!);
  await act(async () => {});
  expect([sideShown(), playhead(), beforeClip() === played]).toEqual(["Before", 4, false]);
  // The same icon returns to After. The shortcut switches back to Before.
  await click(compareButton(editPanel()!));
  expect([sideShown(), beforeClip()]).toEqual(["After", null]);
  await press("\\");
  expect(beforeIcon(editPanel()!)).toEqual(["", "Before", "true", "Back to After (\\)"]);
  // The next edit opens on After, and so does this one when the editor comes back to it.
  await press("ArrowDown");
  expect([openTitle(), sideShown()]).toEqual(["wrap", "After"]);
  await press("ArrowUp");
  expect([openTitle(), sideShown()]).toEqual(["captions", "After"]);
});

it("goes to After at a point picked outside the passage on Before, where Before has nothing to show, and carries on as Before was", async () => {
  beforeClipReady();
  await show();
  await captionsOnBefore();
  const video = container.querySelector<HTMLVideoElement>('.watch-monitor video[aria-label="The current edit"]')!;
  // A press on the timeline just before the passage, while Before plays: the edit stays open, on After, and the
  // video plays from there once the pointer is up.
  let down: unknown;
  await pressTimeline(3.5, () => { down = [sideShown(), video.paused]; });
  expect(down).toEqual(["After", true]);
  expect([openTitle(), sideShown(), playhead(), video.paused]).toEqual(["captions", "After", 3.5, false]);
  expect(beforeClip()).toBeNull();
  // Before has played to 0:06.5. → lands at 0:11.5, past the passage's end: After again, playing on from that point.
  await click(compareButton(editPanel()!));
  await act(async () => {});
  await beforeStarts();
  await beforePlayedTo(2.5);
  await skipKey("ArrowRight");
  expect([openTitle(), sideShown(), playhead(), video.paused]).toEqual(["captions", "After", 11.5, false]);
  // Paused on Before, a skip out of the passage leaves After paused at that point.
  await click(compareButton(editPanel()!));
  await act(async () => {});
  await beforeStarts();
  await press(" ");
  await skipKey("ArrowLeft");
  expect([sideShown(), playhead(), video.paused]).toEqual(["After", 0, true]);
  // And a press on the timeline outside it, once the pointer is up.
  await click(compareButton(editPanel()!));
  await act(async () => {});
  await beforeStarts();
  await press(" ");
  await pressTimeline(3);
  expect([sideShown(), playhead(), video.paused]).toEqual(["After", 3, true]);
  // A clip that played to the passage's end and stopped there wasn't paused by the editor: a press outside the
  // passage plays After from the point picked, as the same press does once After has run to the passage's end.
  await click(compareButton(editPanel()!));
  await act(async () => {});
  await beforeStarts();
  await beforePlayedTo(6);
  expect([sideShown(), beforeClip().paused, playhead()]).toEqual(["Before", true, 9.97]);
  await pressTimeline(3, () => { down = [sideShown(), video.paused]; });
  expect(down).toEqual(["After", true]);
  expect([openTitle(), sideShown(), playhead(), video.paused]).toEqual(["captions", "After", 3, false]);
});

it("offers Edit here on Before and After once the editor has taken the revision tag off", async () => {
  beforeClipReady();
  await show();
  await captionsOnBefore();
  // The box talks to the edit that's open, and a pick doesn't move it.
  await pressTimeline(8);
  expect([sideShown(), playhead(), pointTag()]).toEqual(["Before", 8, ["Edit at 0:04", false]]);
  expect(offeredTime()).toBeUndefined();
  await press(" ");
  await act(async () => composer.props!.onClearTarget!());
  await pressTimeline(8.5);
  expect([sideShown(), playhead(), offeredTime(), boxTag()]).toEqual(["Before", 8.5, "0:08", undefined]);
  await skipKey("ArrowLeft", true);
  expect([sideShown(), playhead(), offeredTime(), boxTag()]).toEqual(["Before", 7.5, "0:07", undefined]);
  await click(compareButton(editPanel()!));
  await act(async () => {});
  await press(" ");
  await skipKey("ArrowRight", true);
  expect([sideShown(), playhead(), offeredTime(), boxTag()]).toEqual(["After", 5, "0:05", undefined]);
  await chooseEditHere();
  expect(pointTag()).toEqual(["At 0:05", true]);
});

it("goes to After at the point picked while Before is still opening, since there is no clip to move", async () => {
  beforeClipReady();
  // The version before the edit never arrives.
  vi.spyOn(api, "timeline").mockReturnValue(new Promise(() => {}));
  await show();
  await click(appliedRows()[1]!);
  await act(async () => {});
  await click(compareButton(editPanel()!));
  await act(async () => {});
  expect([sideShown(), container.querySelector('.watch-monitor [role="status"]:not(.simple-on-video)')?.textContent]).toEqual(["Before", "Opening Before…"]);
  await skipKey("ArrowRight");
  expect([openTitle(), sideShown(), playhead()]).toEqual(["captions", "After", 9]);
});

it("leaves the playhead to the Before clip while it shows, stops it with the video, and takes the video to where it got to", async () => {
  beforeClipReady();
  await show();
  await click(appliedRows()[1]!);
  await act(async () => {});
  // After has played to 0:07.
  const video = container.querySelector<HTMLVideoElement>('.watch-monitor video[aria-label="The current edit"]')!;
  Object.defineProperty(video, "readyState", { configurable: true, value: 4 });
  const videoAt = (seconds: number, event: string) => act(async () => { video.currentTime = seconds; video.dispatchEvent(new Event(event)); });
  await videoAt(7, "timeupdate");
  expect(playhead()).toBe(7);
  // Before starts at the passage's top. The video under it stopped at 0:07, and says so a moment later: the playhead
  // and the clock stay with the clip.
  await click(compareButton(editPanel()!));
  await act(async () => {});
  await videoAt(7.1, "pause");
  await videoAt(7.1, "seeked");
  expect([sideShown(), playhead(), monitorClock()]).toEqual(["Before", 4, "0:04 / 0:16"]);
  // So does the open row pressed again.
  await beforeStarts();
  await beforePlayedTo(2);
  await click(appliedRows()[1]!);
  await act(async () => {});
  await videoAt(6, "seeked");
  expect([sideShown(), playhead()]).toEqual(["Before", 4]);
  // Revise and N stop the video for the editor to write: on Before that is the clip.
  await beforeStarts();
  expect(beforeClip().paused).toBe(false);
  await press("r");
  expect(beforeClip().paused).toBe(true);
  await press(" ");
  expect(beforeClip().paused).toBe(false);
  await press("n");
  expect(beforeClip().paused).toBe(true);
  // A clip that played to its end and stopped there wasn't paused by the editor: a press on the timeline plays from
  // the point picked, as on After.
  await press(" ");
  await beforePlayedTo(6);
  expect([beforeClip().paused, playhead()]).toEqual([true, 9.97]);
  await pressTimeline(5);
  expect([sideShown(), playhead(), beforeClip().paused]).toEqual(["Before", 5, false]);
  // Esc closes the edit where Before got to, and the video under it goes there.
  await beforePlayedTo(3);
  const went = vi.spyOn(player, "seek");
  await press("Escape");
  expect(editPanel()).toBeNull();
  expect(went.mock.calls.at(-1)).toEqual([7, true]);
  expect(playhead()).toBe(7);
  // The video's own clock is read again.
  await videoAt(7.5, "timeupdate");
  expect(playhead()).toBe(7.5);
});

/** Two of the request's three edits ask for a look: the first and the last, with a settled one between them. */
const twoFlagged = () => appliedEdits().mockImplementation(async (_project, threadId) => ({ version: data.project.head!,
  edits: threadId !== threadWith("chg_approved_2").id ? [] : [
    { changeId: "chg_approved_2", spot: 0, label: "music bed", range: { start: 0, end: 16 }, previous: [], check: "The bed may sit too loud under the intro" },
    { changeId: "chg_approved_2", spot: 1, label: "captions", range: { start: 0.2, end: 2.4 }, previous: [] },
    { changeId: "chg_approved_2", spot: 2, label: "wrap", range: { start: 11.5, end: 16 }, previous: [], check: CHECK, summary: SUMMARY },
  ] }));
const cardCount = () => editPanel()?.querySelector(".edit-card-count")?.textContent;

it("steps ↑ and ↓ among the flagged edits from one that still waits, and through every edit while the chat lists them all", async () => {
  twoFlagged();
  await showFolded();
  const turn = turnFor("chg_approved_2");
  // "2 need you" lists just the two and opens the first: its card leads with its place among them.
  await click(turn.querySelector(".simple-pass-need")!);
  await act(async () => {});
  expect([openTitle(), cardCount(), turn.querySelector(".simple-edits")?.getAttribute("aria-label")]).toEqual(["music bed", "1 of 2", "Edits that need you"]);
  // ↓ goes to the next one that still waits, over the settled edit between them, and the list keeps a row lit.
  await press("ArrowDown");
  expect([openTitle(), cardCount()]).toEqual(["wrap", "2 of 2"]);
  // That is the last of them: ↓ stays, and ↑ goes back.
  await press("ArrowDown");
  expect([openTitle(), cardCount()]).toEqual(["wrap", "2 of 2"]);
  await press("ArrowUp");
  expect([openTitle(), cardCount()]).toEqual(["music bed", "1 of 2"]);
  // With every edit listed the arrows step through them all, the settled one too.
  await click(turn.querySelector(".simple-pass-toggle")!);
  expect(turn.querySelector(".simple-edits")?.getAttribute("aria-label")).toBe("Edits in this thread");
  await press("ArrowDown");
  expect([openTitle(), cardCount()]).toEqual(["captions", undefined]);
  await press("ArrowDown");
  expect([openTitle(), cardCount()]).toEqual(["wrap", "2 of 2"]);
  await press("ArrowUp");
  expect(openTitle()).toBe("captions");
});

it("counts and steps through a flagged edit made in several places as one edit, as its list does, and keeps it in all of them", async () => {
  // The captions went on in two places, and Scarlet flagged both. The wrap asks for a look too.
  appliedEdits().mockImplementation(async (_project, threadId) => ({ version: data.project.head!,
    edits: threadId !== threadWith("chg_approved_2").id ? [] : [
      { changeId: "chg_approved_2", spot: 0, label: "captions", range: { start: 0.2, end: 2.4 }, previous: [], check: "The first line runs long" },
      { changeId: "chg_approved_2", spot: 1, label: "music bed", range: { start: 3, end: 9 }, previous: [] },
      { changeId: "chg_approved_2", spot: 2, label: "captions", range: { start: 9.5, end: 11 }, previous: [], check: "The second line runs long" },
      { changeId: "chg_approved_2", spot: 3, label: "wrap", range: { start: 11.5, end: 16 }, previous: [], check: CHECK, summary: SUMMARY },
    ] }));
  await showFolded();
  const turn = turnFor("chg_approved_2");
  const need = () => turn.querySelector(".simple-pass-need")?.textContent;
  // Two edits need the editor, on two rows: the captions, in both places, and the wrap.
  expect(need()).toBe("2 need you");
  await click(turn.querySelector(".simple-pass-need")!);
  await act(async () => {});
  expect([...turn.querySelectorAll(".simple-edits .simple-edit-title")].map(t => t.textContent)).toEqual(["captions", "wrap"]);
  expect([openTitle(), cardCount()]).toEqual(["captions", "1 of 2"]);
  // ↓ goes to the next edit, not to the captions' other place, and ↑ comes back.
  await press("ArrowDown");
  expect([openTitle(), cardCount()]).toEqual(["wrap", "2 of 2"]);
  await press("ArrowUp");
  expect([openTitle(), cardCount()]).toEqual(["captions", "1 of 2"]);
  // Keep keeps the captions in both places and moves on to the wrap, the one edit still waiting.
  expect(api.recordEditReview).not.toHaveBeenCalled();
  await press("k");
  expect(vi.mocked(api.recordEditReview).mock.calls).toEqual([[PRJ, { changeId: "chg_approved_2", spot: 0, decision: "keep" }]]);
  await act(async () => {});
  expect([openTitle(), cardCount(), need()]).toEqual(["wrap", "1 of 1", "1 needs you"]);
});

it("steps ↓ from a flagged edit sent back for revision to the next one that waits, not to the settled edit beside it", async () => {
  twoFlagged();
  await showFolded();
  await click(turnFor("chg_approved_2").querySelector(".simple-pass-need")!);
  await act(async () => {});
  expect([openTitle(), cardCount()]).toEqual(["music bed", "1 of 2"]);
  // The editor sends the first one back. It stays open with no card, and its row stays in the list of what needs them.
  const base = buildDb().tasks.find(t => t.id === "task_done")!;
  const now = new Date().toISOString();
  await event(d => ({ ...d, tasks: [...d.tasks, { ...base, id: "task_revise_bed", state: "running" as const, createdAt: now, startedAt: now, finishedAt: undefined, summary: null, changeIds: [],
    context: { changeId: "chg_approved_2", editIndex: 0, threadId: threadWith("chg_approved_2").id, message: "Lower the bed" } }] }));
  await act(async () => {});
  expect(editPanel()).toBeNull();
  // ↓ goes on to the other one that waits, over the settled edit between them.
  await press("ArrowDown");
  expect([openTitle(), cardCount()]).toEqual(["wrap", "1 of 1"]);
});

it("steps among a pass's flagged cuts with its lists closed, where the timeline marks only those", async () => {
  twoFlagged();
  data = { ...data, tasks: [...data.tasks, { ...data.tasks.find(t => t.id === "task_done")!, id: "task_pass", kind: "edit" as const,
    instruction: "/dialogue-pass", context: { message: "/dialogue-pass" }, changeIds: ["chg_approved_2"] }] };
  useProjectStore.setState({ current: data });
  await showFolded();
  await act(async () => {});
  const pass = turnFor("chg_approved_2").querySelector<HTMLElement>(".simple-pass")!;
  const need = () => pass.querySelector<HTMLElement>(".simple-pass-need")!;
  await click(need());
  await act(async () => {});
  expect([openTitle(), cardCount()]).toEqual([undefined, "1 of 2"]);
  expect(pass.querySelector(".simple-pass-list [aria-current='true'] .simple-pass-label")?.textContent).toBe("music bed");
  await press("ArrowDown");
  expect(pass.querySelector(".simple-pass-list [aria-current='true'] .simple-pass-label")?.textContent).toBe("wrap");
  expect(cardCount()).toBe("2 of 2");
  // The list put away, the cut stays open and the arrows still go to the other one that waits.
  await click(need());
  expect(pass.querySelector(".simple-pass-list")).toBeNull();
  await press("ArrowUp");
  expect([editPanel()?.querySelector(".edit-card-title")?.textContent, cardCount()]).toEqual(["music bed. The bed may sit too loud under the intro", "1 of 2"]);
  // Every edit listed: the arrows go through them all.
  await click(pass.querySelector(".simple-pass-toggle")!);
  await act(async () => {});
  await press("ArrowDown");
  expect([pass.querySelector(".simple-pass-list [aria-current='true'] .simple-pass-label")?.textContent, cardCount()]).toEqual(["captions", undefined]);
});

it("lists what needs the editor for a flagged edit opened from the timeline, so ↓ goes on to the next one that waits, and every edit for any other", async () => {
  twoFlagged();
  // The latest request's edits are the ones marked on the timeline.
  const thread = threadWith("chg_approved_2");
  data = { ...data, changes: thread.changes, tasks: thread.tasks, notes: [] };
  useProjectStore.setState({ current: data });
  await showFolded();
  await act(async () => {});
  const turn = turnFor("chg_approved_2");
  const listed = () => turn.querySelector(".simple-edits")?.getAttribute("aria-label");
  /** A press on the dot that carries this number. */
  const pressDot = async (n: string) => {
    const strip = container.querySelector<HTMLElement>(".simple-timeline-hover")!;
    strip.getBoundingClientRect = () => ({ left: 0, width: 1000 }) as DOMRect;
    const dot = [...container.querySelectorAll<HTMLElement>(".simple-timeline-mark")].find(mark => mark.textContent === n)!;
    await act(async () => { strip.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, button: 0, pointerId: 1, clientX: parseFloat(dot.style.left) * 10 })); });
    await act(async () => {});
  };
  // No list is open. The first flagged edit's amber dot opens it, and the list that opens with it is the one
  // "2 need you" opens: its card leads with "1 of 2", so the arrows stay among those two.
  expect(listed()).toBeUndefined();
  await pressDot("1");
  expect([openTitle(), cardCount(), listed(), turn.querySelector(".simple-pass-need")?.getAttribute("aria-pressed")]).toEqual(["music bed", "1 of 2", "Edits that need you", "true"]);
  await press("ArrowDown");
  expect([openTitle(), cardCount()]).toEqual(["wrap", "2 of 2"]);
  // That list put away and the card closed, an edit that needs nothing opens with every edit listed, as before.
  await click(turn.querySelector(".simple-pass-need")!);
  await press("Escape");
  expect([editPanel(), listed()]).toEqual([null, undefined]);
  await pressDot("2");
  expect([openTitle(), cardCount(), listed()]).toEqual(["captions", undefined, "Edits in this thread"]);
});

it("keeps the edit open and zoomed when the timeline is clicked outside the passage it plays", async () => {
  appliedEdits();
  await show();
  const turn = turnFor("chg_approved_2");
  await click(turn.querySelectorAll(".simple-edits .simple-edit")[2]!);
  await act(async () => {});
  expect(openTitle()).toBe("wrap");
  const band = () => container.querySelector(".simple-timeline-band");
  expect(band()).not.toBeNull();
  // Home goes to the start of the zoomed view, before the passage: the passage stretches back to it instead of closing the edit.
  const slider = container.querySelector<HTMLElement>('[aria-label="Position in the video"]')!;
  await act(async () => { slider.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })); });
  expect(openTitle()).toBe("wrap");
  // The timeline turned back a page to follow the playhead, so the edit's band is out of view. It draws nothing there:
  // clamped to the edge it left a sliver that read as a mark at that time.
  expect(band()).toBeNull();
  expect(usePlayerStore.getState().time).toBeLessThan(11.5);
  // Closed, the stretch goes with it: the next edit opened plays its own passage, not the stretched one.
  await press("Escape");
  const played = vi.spyOn(player, "previewRange");
  await click(turn.querySelectorAll(".simple-edits .simple-edit")[1]!);
  await act(async () => {});
  expect(openTitle()).toBe("captions");
  expect(played).toHaveBeenCalled();
  expect((played.mock.calls.at(-1)![0] as { end: number }).end).toBeLessThan(6);
});

it("keeps a flagged edit's row to its amber number and its name: the reason is on its card, and on the row on hover", async () => {
  appliedEdits();
  await show();
  await act(async () => {});
  const turn = turnFor("chg_approved_2");
  const row = () => [...turn.querySelectorAll<HTMLButtonElement>(".simple-edits .simple-edit")][2]!;
  // No line under the row says why it asks for a look. Hovering the row does, as on a pass's row.
  expect([row().querySelector(".edit-badge")?.className, row().textContent, row().title]).toEqual(["edit-badge is-check", "3wrap", CHECK]);
  expect(turn.querySelector(".simple-edits")!.textContent).not.toContain(CHECK);
  // Its card says it, inside Scarlet's sentence.
  await click(row());
  await act(async () => {});
  expect(editPanel()!.querySelector(".edit-card-title")?.textContent).toBe(SUMMARY);
  // Kept, the badge fills, and the row is still one line.
  await press("k");
  expect([row().querySelector(".edit-badge")?.className, row().textContent, row().title]).toEqual(["edit-badge is-kept", "3wrap", CHECK]);
});

it("reviews only the edits Scarlet flagged, then leaves nothing to press", async () => {
  appliedEdits();
  await show();
  const turn = turnFor("chg_approved_2");
  await click(turn.querySelector(".simple-pass-need")!);
  await act(async () => {});
  expect(openTitle()).toBe("wrap");
  await click(buttonIn(editPanel()!, "Keep")!);
  expect(editPanel()).toBeNull();
  expect(turn.querySelector(".simple-pass-need")).toBeNull();
  expect(buttonIn(turn, "Done")).toBeUndefined();
});

it("gives the timeline to the latest request when its edit lands, though the editor looked at an earlier one while Scarlet worked", async () => {
  earlierRequestOnly();
  const later = laterRequest("task_later");
  const landed = later.lists.task_later!;
  later.lists.task_later = [];
  await show();
  await act(async () => {});
  // The editor sends a request. Scarlet starts on it, and it has no edits yet.
  const base = buildDb().tasks.find(t => t.id === "task_done")!;
  const now = new Date().toISOString();
  await event(d => ({ ...d, tasks: [...d.tasks, { ...base, id: "task_later", state: "running" as const, createdAt: now, startedAt: now, finishedAt: undefined,
    summary: null, changeIds: [], question: null, instruction: "Fade the outro", context: { message: "Fade the outro" } }] }));
  await act(async () => {});
  expect(numbered()).toEqual([]);
  // While it works they look at the earlier request's flagged edit and close it without keeping it.
  await click(turnFor("chg_approved_2").querySelector(".simple-pass-need")!);
  await act(async () => {});
  expect(openTitle()).toBe("wrap");
  await press("Escape");
  expect(numbered()).toEqual([["3", "check"]]);
  // The request proposes its edit. Nothing is applied yet, so the timeline stays where the editor was.
  await event(d => ({ ...d, changes: [...d.changes, { ...later.change, taskId: "task_later", state: "ready" as const }] }));
  await act(async () => {});
  expect(numbered()).toEqual([["3", "check"]]);
  // The edit is applied, flagged, and the timeline is on it.
  later.lists.task_later = landed;
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_later" ? { ...later.change, taskId: "task_later" } : c),
    tasks: d.tasks.map(t => t.id === "task_later" ? { ...t, state: "done" as const, finishedAt: new Date().toISOString(), changeIds: ["chg_later"] } : t) }));
  await act(async () => {});
  expect(turnFor("chg_later").querySelector(".simple-pass-need")?.textContent).toBe("1 needs you");
  expect(numbered()).toEqual([["1", "check"]]);
});

it("brings the open edit back when its request's markers load again, and only then lets a newer request have the timeline", async () => {
  earlierRequestOnly();
  const later = laterRequest();
  await show();
  await act(async () => {});
  await click(editRows("chg_approved_2")[1]!);
  await act(async () => {});
  expect(openTitle()).toBe("captions");
  // A newer request arrives while the edit is open. The timeline stays with the open edit.
  await event(d => ({ ...d, changes: [...d.changes, later.change] }));
  await act(async () => {});
  expect(openTitle()).toBe("captions");
  // The working cut moves on, so the open edit's markers are asked for again. While they load the edit stays open on
  // the marks it had, and nothing else is marked: the newer request doesn't take the timeline.
  const marked = numbered();
  later.hold(later.earlier);
  await headMoves("ver_moved");
  expect(editPanel()).not.toBeNull();
  expect(openTitle()).toBe("captions");
  expect(numbered()).toEqual(marked);
  expect(numbered()).not.toEqual([["1", "check"]]);
  await later.release();
  expect(openTitle()).toBe("captions");
  expect(editPanel()).not.toBeNull();
  // Closed, the newer request takes the timeline.
  await press("Escape");
  expect(numbered()).toEqual([["1", "check"]]);
});

it("lets go of an open edit that is no longer in its request's list, and goes back to the latest request", async () => {
  earlierRequestOnly(false);
  const later = laterRequest("chg_later", false);
  data = { ...data, changes: [...data.changes, later.change] };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  await click(editRows("chg_approved_2")[1]!);
  await act(async () => {});
  expect(openTitle()).toBe("captions");
  // While "music bed" is open in an earlier request, only that edit is marked.
  await press("ArrowUp");
  expect(openTitle()).toBe("music bed");
  expect(numbered()).toEqual([["1", undefined]]);
  // The edit is undone. Its request no longer lists it.
  later.lists[later.earlier] = (later.lists[later.earlier] as object[]).slice(1);
  await headMoves("ver_undone");
  await act(async () => {});
  expect(editPanel()).toBeNull();
  expect(numbered()).toEqual([["1", "check"]]);
  // It doesn't come back half open if the list has it again later.
  later.lists[later.earlier] = [{ changeId: "chg_approved_2", spot: 0, label: "music bed", range: { start: 0, end: 16 }, previous: [] }, ...(later.lists[later.earlier] as object[])];
  await headMoves("ver_redone");
  await act(async () => {});
  expect(editPanel()).toBeNull();
  expect(container.querySelector(".simple-timeline-band")).toBeNull();
  expect(numbered()).toEqual([["1", "check"]]);
});

it("doesn't bring an edit back half open when the latest request lists it again", async () => {
  earlierRequestOnly(false);
  const only = laterRequest("chg_later", false);
  await show();
  await act(async () => {});
  await click(editRows("chg_approved_2")[1]!);
  await act(async () => {});
  expect(openTitle()).toBe("captions");
  // The edit is undone while it is open, then put back.
  const all = only.lists[only.earlier] as object[];
  only.lists[only.earlier] = [all[0]!, all[2]!];
  await headMoves("ver_undone");
  await act(async () => {});
  expect(editPanel()).toBeNull();
  only.lists[only.earlier] = all;
  await headMoves("ver_redone");
  await act(async () => {});
  // It is listed again, and closed: no card, no passage on the timeline, nothing playing it.
  expect(editPanel()).toBeNull();
  expect(container.querySelector(".simple-timeline-band")).toBeNull();
  expect(container.querySelector(".thread-review-tools")).toBeNull();
  expect(numbered()).toEqual([["1", undefined], ["2", undefined], ["3", undefined]]);
});

it("stays with an earlier request that has an edit to check through a reload of its markers, until that edit is sent back", async () => {
  earlierRequestOnly();
  const later = laterRequest();
  data = { ...data, changes: [...data.changes, later.change] };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  // The later request arrived with nothing open, so it has the timeline. Looking at the earlier one's edit moves the timeline there.
  expect(numbered()).toEqual([["1", "check"]]);
  await click(editRows("chg_approved_2")[1]!);
  await act(async () => {});
  await press("Escape");
  expect(numbered()).toEqual([["3", "check"]]);
  // Its markers load again, and fail once on the way. Neither says the edit was looked at.
  later.hold(later.earlier);
  await headMoves("ver_moved");
  await later.release();
  expect(numbered()).toEqual([["3", "check"]]);
  const good = later.lists[later.earlier]!;
  later.lists[later.earlier] = new Error("Engine unreachable");
  await headMoves("ver_failed");
  await act(async () => {});
  expect(numbered()).toEqual([]);
  later.lists[later.earlier] = good;
  await headMoves("ver_back");
  await act(async () => {});
  expect(numbered()).toEqual([["3", "check"]]);
  // The editor sends "wrap" back for revision. It no longer waits on them, so the timeline is back on the latest request.
  const base = buildDb().tasks.find(t => t.id === "task_done")!;
  await event(d => ({ ...d, tasks: [...d.tasks, { ...base, id: "task_revise_wrap", state: "queued" as const, createdAt: new Date().toISOString(),
    startedAt: undefined, finishedAt: undefined, summary: null, changeIds: [],
    context: { changeId: "chg_approved_2", editIndex: 2, threadId: later.earlier, message: "Keep the last word" } }] }));
  await act(async () => {});
  expect(numbered()).toEqual([["1", "check"]]);
});

it("stays with an earlier request's flagged edit after a look at it, when the later request arrived before the look", async () => {
  earlierRequestOnly();
  const later = laterRequest();
  await show();
  await act(async () => {});
  // A later request arrives with nothing open, and has the timeline.
  await event(d => ({ ...d, changes: [...d.changes, later.change] }));
  await act(async () => {});
  expect(numbered()).toEqual([["1", "check"]]);
  // The editor then looks at an edit of the earlier request, which still has "wrap" to check.
  await click(editRows("chg_approved_2")[1]!);
  await act(async () => {});
  await press("Escape");
  expect(numbered()).toEqual([["3", "check"]]);
});

it("keeps an open edit through markers that fail to load, unless a newer request arrived meanwhile", async () => {
  earlierRequestOnly(false);
  const later = laterRequest("chg_later", false);
  await show();
  await act(async () => {});
  await click(editRows("chg_approved_2")[1]!);
  await act(async () => {});
  expect(openTitle()).toBe("captions");
  // The working cut moves on and the markers fail to load. The card goes, and comes back on the same edit when they load.
  const good = later.lists[later.earlier]!;
  later.lists[later.earlier] = new Error("Engine unreachable");
  await headMoves("ver_failed");
  await act(async () => {});
  expect(editPanel()).toBeNull();
  expect(numbered()).toEqual([]);
  later.lists[later.earlier] = good;
  await headMoves("ver_back");
  await act(async () => {});
  expect(openTitle()).toBe("captions");
  // They fail again, and this time a newer request arrives meanwhile. It takes the timeline, and the edit stays closed.
  later.lists[later.earlier] = new Error("Engine unreachable");
  await headMoves("ver_failed_again");
  await act(async () => {});
  await event(d => ({ ...d, changes: [...d.changes, later.change] }));
  await act(async () => {});
  expect(numbered()).toEqual([["1", "check"]]);
  later.lists[later.earlier] = good;
  await headMoves("ver_back_again");
  await act(async () => {});
  expect(editPanel()).toBeNull();
  expect(numbered()).toEqual([["1", "check"]]);
});

it("lets go of an earlier request whose markers never loaded", async () => {
  earlierRequestOnly();
  const later = laterRequest();
  data = { ...data, changes: [...data.changes, later.change] };
  useProjectStore.setState({ current: data });
  later.lists[later.earlier] = new Error("Engine unreachable");
  await show();
  await act(async () => {});
  expect(numbered()).toEqual([["1", "check"]]);
  // The editor asks to review the earlier request's flagged edit, and its markers can't be had. The timeline stays on the latest request.
  await click(turnFor("chg_approved_2").querySelector(".simple-pass-need")!);
  await act(async () => {});
  expect(editPanel()).toBeNull();
  expect(numbered()).toEqual([["1", "check"]]);
});

it("asks again for markers that failed to load when the editor opens an edit there", async () => {
  earlierRequestOnly();
  const later = laterRequest();
  const good = later.lists[later.earlier]!;
  later.lists[later.earlier] = new Error("Engine unreachable");
  await show();
  await act(async () => {});
  expect(numbered()).toEqual([]);
  later.lists[later.earlier] = good;
  await click(turnFor("chg_approved_2").querySelector(".simple-pass-need")!);
  await act(async () => {});
  expect(openTitle()).toBe("wrap");
  await press("Escape");
  expect(numbered()).toEqual([["1", undefined], ["2", undefined], ["3", "check"]]);
  // With the markers in, opening an edit there doesn't ask the engine again. "Needs you" listed just the flagged
  // edit, so the whole list is opened for another.
  const asked = vi.mocked(api.threadEdits).mock.calls.length;
  await click(turnFor("chg_approved_2").querySelector(".simple-pass-toggle")!);
  await click(editRows("chg_approved_2")[1]!);
  await act(async () => {});
  expect(openTitle()).toBe("captions");
  expect(vi.mocked(api.threadEdits)).toHaveBeenCalledTimes(asked);
  // Nor does opening one while they are still on their way: the request that's out is the one that answers.
  await press("Escape");
  later.hold(later.earlier);
  await headMoves("ver_next");
  const asking = vi.mocked(api.threadEdits).mock.calls.length;
  await click(editRows("chg_approved_2")[1]!);
  await act(async () => {});
  expect(vi.mocked(api.threadEdits)).toHaveBeenCalledTimes(asking);
  await later.release();
  expect(openTitle()).toBe("captions");
});

it("stops asking for a look at a flagged edit once its revision is queued", async () => {
  appliedEdits();
  const thread = threadWith("chg_approved_2");
  const base = data.tasks.find(t => t.kind === "edit") ?? data.tasks[0]!;
  // The editor watched "wrap" and asked for a revision, which waits in the queue. This is the latest request, so its edits are on the timeline.
  data = { ...data, changes: thread.changes, notes: [], tasks: [{ ...base, id: "task_revise_wrap", state: "queued", createdAt: "2030-01-01T00:00:00.000Z",
    startedAt: undefined, finishedAt: undefined, summary: null, changeIds: [],
    context: { ...base.context, changeId: "chg_approved_2", editIndex: 2, threadId: thread.id, message: "Keep the last word" } }] };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  const turn = turnFor("chg_approved_2");
  const wrap = turn.querySelectorAll<HTMLElement>(".simple-edits .simple-edit")[2]!;
  expect(wrap.querySelector(".edit-badge")?.classList.contains("is-check")).toBe(false);
  expect(wrap.querySelector(".simple-edit-check")?.textContent).toBe("Revising…");
  expect(wrap.getAttribute("aria-label")).toBe("Edit 3: wrap, revising");
  expect(turn.querySelector(".simple-pass-need")).toBeNull();
  const dots = [...container.querySelectorAll<HTMLElement>(".simple-timeline-mark.is-numbered")];
  expect(dots).toHaveLength(3);
  expect(dots.every(d => d.dataset.state !== "check")).toBe(true);
});

it("says Revising… on the row of an edit the editor had kept while Scarlet revises it", async () => {
  earlierRequestOnly();
  const thread = threadWith("chg_approved_2");
  // The editor kept "wrap" when it played, then opened it again and sent it back for revision.
  keepEdits(PRJ, thread.id, [{ changeId: "chg_approved_2", spot: 2 }]);
  const base = buildDb().tasks.find(t => t.id === "task_done")!;
  const now = new Date().toISOString();
  data = { ...data, tasks: [...data.tasks, { ...base, id: "task_revise_wrap", state: "running" as const, createdAt: now, startedAt: now, finishedAt: undefined,
    summary: null, changeIds: [], context: { changeId: "chg_approved_2", editIndex: 2, threadId: thread.id, message: "Keep the last word" } }] };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  // The version they kept is on its way out: its row says so, as any edit's does while it is revised (2026-11-10: a kept
  // edit's row went on reading as kept, with its amount, while Scarlet revised it).
  const wrap = [...container.querySelectorAll<HTMLElement>(".simple-edits .simple-edit")].find(r => r.getAttribute("aria-label")?.startsWith("Edit 3: wrap"))!;
  expect([wrap.getAttribute("aria-label"), wrap.querySelector(".simple-edit-check")?.textContent]).toEqual(["Edit 3: wrap, revising", "Revising…"]);
});

it("takes the card off an edit sent back for revision until its new version lands, which asks for a look again", async () => {
  earlierRequestOnly();
  await show();
  await act(async () => {});
  // The request's block is in the chat, and above the message box while Scarlet is on its edit.
  const wrap = () => [...container.querySelectorAll<HTMLElement>(".simple-edits .simple-edit")].find(r => r.getAttribute("aria-label")?.startsWith("Edit 3: wrap"))!;
  await click(wrap());
  await act(async () => {});
  expect(editPanel()!.querySelector(".edit-card-title")?.textContent).toBe(SUMMARY);
  expect(editPanel()!.querySelector(".edit-card-count")?.textContent).toBe("1 of 1");
  const tag = boxTag();
  // The editor sends it back. Its note and decisions are about the version on its way out, so the card goes; the edit
  // stays open, with the message box still aimed at it, and its row says Scarlet is on it.
  const base = buildDb().tasks.find(t => t.id === "task_done")!;
  const thread = threadWith("chg_approved_2");
  await event(d => ({ ...d, tasks: [...d.tasks, { ...base, id: "task_revise_wrap", state: "running" as const, createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(), finishedAt: undefined, summary: null, changeIds: [],
    context: { changeId: "chg_approved_2", editIndex: 2, threadId: thread.id, message: "Keep the last word" } }] }));
  await act(async () => {});
  await openEdits();
  expect(editPanel()).toBeNull();
  expect(container.querySelector(".cut-transport > .edit-card")).toBeNull();
  expect(boxTag()).toBe(tag);
  expect(wrap().getAttribute("aria-current")).toBe("true");
  expect(wrap().querySelector(".simple-edit-check")?.textContent).toBe("Revising…");
  // Keep has nothing to keep meanwhile.
  await press("k");
  expect(wrap().getAttribute("aria-label")).toBe("Edit 3: wrap, revising");
  // The new version lands in the edit's place. Scarlet gave it no reason of its own, and it is still the editor's to
  // check: the card is back on it with its note, its place among the ones waiting and Keep.
  const old = data.changes.find(c => c.id === "chg_approved_2")!;
  const revised = { ...old, id: "chg_revised_wrap", taskId: "task_revise_wrap", fromVersion: old.toVersion, toVersion: "ver_revised_wrap", appliedVersion: "ver_revised_wrap",
    createdAt: new Date().toISOString(), timelineEdits: [{ label: "wrap", range: { start: 11.5, end: 16 }, summary: "Kept the wrap's last word", replaces: { changeId: "chg_approved_2", spot: 2 } }] };
  vi.mocked(api.threadEdits).mockImplementation(async () => ({ version: data.project.head!, edits: [
    { changeId: "chg_approved_2", spot: 0, label: "music bed", range: { start: 0, end: 16 }, previous: [] },
    { changeId: "chg_approved_2", spot: 1, label: "captions", range: { start: 0.2, end: 2.4 }, previous: [] },
    { changeId: "chg_revised_wrap", spot: 0, label: "wrap", range: { start: 11.5, end: 16 }, previous: [{ changeId: "chg_approved_2", spot: 2 }],
      check: REVISED_CHECK, summary: "Kept the wrap's last word" },
  ] }));
  await event(d => ({ ...d, changes: [...d.changes, revised], project: { ...d.project, head: "ver_revised_wrap" }, timeline: { ...d.timeline!, version: "ver_revised_wrap" },
    tasks: d.tasks.map(t => t.id === "task_revise_wrap" ? { ...t, state: "done" as const, finishedAt: new Date().toISOString(), changeIds: [revised.id] } : t) }));
  await act(async () => {});
  await act(async () => {});
  expect(editPanel()!.querySelector(".edit-card-title")?.textContent).toBe("Kept the wrap's last word");
  expect(editPanel()!.querySelector(".edit-card-count")?.textContent).toBe("1 of 1");
  expect(container.querySelector(".simple-pass-need")?.textContent).toBe("1 needs you");
  // Its row is amber again, as v2, and says it came back revised.
  expect([wrap().getAttribute("aria-label"), wrap().querySelector(".simple-edit-title small")?.textContent, wrap().querySelector(".simple-edit-check")?.textContent])
    .toEqual(["Edit 3: wrap, check", "v2", "Revised"]);
  await click(buttonIn(editPanel()!, "Keep")!);
  expect(container.querySelector(".simple-pass-need")).toBeNull();
});

/** The timeline's numbered dots, each with its state. */
const numbered = () => [...container.querySelectorAll<HTMLElement>(".simple-timeline-mark.is-numbered")]
  .map(d => [d.querySelector(".simple-timeline-number")?.textContent, d.dataset.state]);

it("marks the latest request's edits from the start, amber where one asks for a look", async () => {
  appliedEdits();
  // An earlier request is in the project too. Its settled edits draw nothing.
  data = { ...data, changes: data.changes.filter(c => c.id === "chg_approved_1" || c.id === "chg_approved_2"), tasks: [], notes: [] };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  expect(turns().map(t => t.getAttribute("aria-label")).at(-1)).toBe(threadWith("chg_approved_2").title);
  // Nothing has been opened. The timeline is already on the latest request, numbered as its list in the chat.
  expect(editPanel()).toBeNull();
  expect(turnFor("chg_approved_2").querySelector(".simple-pass-need")?.textContent).toBe("1 needs you");
  expect(numbered()).toEqual([["1", undefined], ["2", undefined], ["3", "check"]]);
});

it("lands an edit applied while the editor watches with a moment, and leaves the ones applied before it opened quiet", async () => {
  appliedEdits();
  data = { ...data, changes: data.changes.filter(c => c.id === "chg_approved_1" || c.id === "chg_approved_2"), tasks: [], notes: [] };
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  // Edits applied before the project opened are simply there.
  expect(numbered()).toHaveLength(3);
  expect(container.querySelector("[data-landed], .simple-timeline-closing")).toBeNull();
  // One seen waiting and then applied while the editor watches arrives with a moment.
  const waiting = { ...data, changes: data.changes.map(c => c.id === "chg_approved_2" ? { ...c, state: "proposed" as const } : c) };
  await act(async () => { useProjectStore.setState({ current: waiting }); });
  await act(async () => {});
  now += 1000;
  await act(async () => { useProjectStore.setState({ current: data }); });
  await act(async () => {});
  await act(async () => {});
  const landed = [...container.querySelectorAll<HTMLElement>(".simple-timeline-mark.is-numbered")].map(d => d.dataset.landed);
  expect(landed).toHaveLength(3);
  expect(landed.every(Boolean)).toBe(true);
  // A moment later it is an ordinary marker again.
  now += 5000;
  await act(async () => { useProjectStore.setState({ current: { ...data, changes: [...data.changes] } }); });
  expect(container.querySelector("[data-landed]")).toBeNull();
});

it("marks only the flagged cut of a dialogue pass that is the latest request, from the start", async () => {
  appliedEdits();
  data = { ...data, tasks: [...data.tasks, { ...data.tasks.find(t => t.id === "task_done")!, id: "task_pass", kind: "edit" as const,
    instruction: "/dialogue-pass", context: { message: "/dialogue-pass" }, changeIds: ["chg_approved_2"] }] };
  const thread = threadWith("chg_approved_2");
  data = { ...data, changes: thread.changes, tasks: thread.tasks, notes: [] };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  expect(turnFor("chg_approved_2").querySelector(".simple-pass")).not.toBeNull();
  // A pass can leave hundreds of settled cuts. Only the one that asks for a look is marked.
  expect([...container.querySelectorAll<HTMLElement>(".simple-timeline-mark")].map(m => m.dataset.state)).toEqual(["check"]);
});

/**
 * A later request Scarlet applied, with one edit that asks for a look, beside the earlier one with its three. The engine
 * lists each request's edits for that request only. `lists` can be changed mid-test, set to an error, or held back.
 */
const laterRequest = (request = "chg_later", flagged = true) => {
  const made = data.changes.find(c => c.id === "chg_approved_2")!;
  const outro = { changeId: "chg_later", spot: 0, label: "outro fade", range: { start: 13, end: 15 }, previous: [], check: "The fade may clip the last word" };
  const earlier = threadWith("chg_approved_2").id;
  const lists: Record<string, object[] | Error> = { [request]: [outro], [earlier]: [
    { changeId: "chg_approved_2", spot: 0, label: "music bed", range: { start: 0, end: 16 }, previous: [] },
    { changeId: "chg_approved_2", spot: 1, label: "captions", range: { start: 0.2, end: 2.4 }, previous: [] },
    { changeId: "chg_approved_2", spot: 2, label: "wrap", range: { start: 11.5, end: 16 }, previous: [], ...(flagged && { check: CHECK }) },
  ] };
  let held: string | undefined;
  let arrive = () => {};
  vi.spyOn(api, "threadEdits").mockImplementation(async (_project, threadId) => {
    if (threadId === held) await new Promise<void>(resolve => { arrive = resolve; });
    const list = lists[threadId];
    if (list instanceof Error) throw list;
    return { version: useProjectStore.getState().current!.project.head!, edits: (list ?? []) as never };
  });
  const change = { ...made, id: "chg_later", taskId: undefined, threadId: undefined, noteIds: [], description: "Fade the outro",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    timelineEdits: [{ label: outro.label, range: outro.range, check: outro.check }] };
  return { change, lists, earlier, hold: (id: string) => { held = id; }, release: () => act(async () => { held = undefined; arrive(); }) };
};
/** The working cut moves on, as when a revision lands: every request's markers are asked for again. */
const headMoves = (version: string) => event(d => ({ ...d, project: { ...d.project, head: version }, timeline: { ...d.timeline!, version } }));
/** Only the earlier request, with "wrap" asking for a look unless told otherwise. */
const earlierRequestOnly = (flagged = true) => {
  appliedEdits();
  const thread = threadWith("chg_approved_2");
  data = { ...data, changes: thread.changes, tasks: thread.tasks, notes: [] };
  if (!flagged) data = { ...data, changes: data.changes.map(c => c.id !== "chg_approved_2" ? c : { ...c, timelineEdits: c.timelineEdits!.map(({ check: _check, ...e }) => e) }) };
  useProjectStore.setState({ current: data });
};
const editRows = (changeId: string) => [...turnFor(changeId).querySelectorAll<HTMLElement>(".simple-edits .simple-edit")];

it("waits for a request's final applied edit before flagging it, while an earlier request's flag stays available", async () => {
  const { change, lists, hold, release } = laterRequest("task_fade");
  const earlier = data.changes.find(c => c.id === "chg_approved_2")!;
  const task = { ...data.tasks.find(t => t.id === "task_done")!, id: "task_fade", kind: "edit" as const,
    instruction: "Fade the outro", context: { threadId: "task_fade", message: "Fade the outro" },
    state: "running" as const, finishedAt: undefined, changeIds: [change.id] };
  data = { ...data, changes: [earlier, { ...change, taskId: task.id }], tasks: [task], notes: [] };
  useProjectStore.setState({ current: data });
  await showFolded();
  const fade = () => container.querySelector<HTMLElement>('.unit[data-run="task_fade"]')!;
  const flag = () => fade().querySelector(".simple-pass-need")?.textContent;
  expect(turnFor(earlier.id).querySelector(".simple-pass-need")?.textContent).toBe("1 needs you");
  expect(flag()).toBeUndefined();
  // It is already on the timeline and can be played from the full list.
  await click(fade().querySelector(".simple-pass-toggle")!);
  expect(fade().querySelector(".simple-edit-title")?.textContent).toBe("outro fade");
  expect(fade().querySelector(".edit-badge.is-check")).toBeNull();
  expect(numbered()).toEqual([["1", undefined]]);
  const replaces = { changeId: change.id, spot: 0 };
  const final = { ...change, id: "chg_final_fade", taskId: task.id, threadId: task.id, toVersion: "ver_final_fade",
    timelineEdits: [{ label: "shorter fade", check: "Listen to the last beat", range: { start: 14, end: 15 }, replaces }] };
  hold(task.id);
  lists[task.id] = [{ ...final.timelineEdits[0], changeId: final.id, spot: 0, previous: [replaces] }];
  await event(d => ({ ...d, changes: [...d.changes, final], project: { ...d.project, head: final.toVersion },
    timeline: { ...d.timeline!, version: final.toVersion }, tasks: d.tasks.map(t => ({ ...t, changeIds: [...t.changeIds, final.id] })) }));
  expect(flag()).toBeUndefined();
  // Finishing can arrive before the current timeline's edit list does. The older loaded flag must stay hidden.
  await event(d => ({ ...d, tasks: d.tasks.map(t => ({ ...t, state: "done", finishedAt: new Date().toISOString() })) }));
  expect(flag()).toBeUndefined();
  expect(numbered()).toEqual([["1", undefined]]);
  await release();
  expect(flag()).toBe("1 needs you");
  expect(numbered()).toEqual([["1", "check"]]);
  await click(fade().querySelector(".simple-pass-need")!);
  expect(fade().querySelector(".simple-edit-title")?.textContent).toBe("shorter fadev2");
  expect(fade().querySelector(".edit-badge.is-check")).not.toBeNull();
});

it("holds the applied flags from an earlier attempt until its resumed request ends", async () => {
  const { change, lists } = laterRequest("task_fade");
  const first = { ...data.tasks.find(t => t.id === "task_done")!, id: "task_fade", kind: "edit" as const,
    instruction: "Fade the outro", state: "failed" as const, context: { threadId: "task_fade" }, changeIds: [change.id] };
  const resumed = { ...first, id: "task_resumed", resumeRootId: first.id, state: "running" as const,
    finishedAt: undefined, changeIds: [], createdAt: new Date().toISOString() };
  // The engine merged the flag onto an existing edit. The change that supplied it is linked only from its task.
  const prior = { ...change, id: "chg_prior_fade", threadId: first.id, timelineEdits: [{ label: "outro fade", range: { start: 13, end: 15 } }] };
  lists[first.id] = [{ ...change.timelineEdits[0], changeId: prior.id, reviewChangeId: change.id, spot: 0, previous: [] }];
  data = { ...data, changes: [prior, change], tasks: [first, resumed], notes: [] };
  useProjectStore.setState({ current: data });
  await showFolded();
  expect(container.querySelector(".simple-pass-need")).toBeNull();
  expect(numbered()).toEqual([["1", undefined]]);
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === resumed.id ? { ...t, state: "cancelled" } : t) }));
  expect(container.querySelector(".simple-pass-need")?.textContent).toBe("1 needs you");
  expect(numbered()).toEqual([["1", "check"]]);
});

it("shares the initial edit-list request between the chat and timeline and refreshes both after the head moves", async () => {
  earlierRequestOnly();
  const read = vi.mocked(api.threadEdits);
  await showFolded();
  expect(read).toHaveBeenCalledExactlyOnceWith(PRJ, threadWith("chg_approved_2").id);
  await headMoves("updated-head");
  expect(read).toHaveBeenCalledTimes(2);
});

it("marks a new request's edits when it arrives, wherever the editor had been before", async () => {
  appliedEdits();
  const thread = threadWith("chg_approved_2");
  data = { ...data, changes: thread.changes, tasks: thread.tasks, notes: [] };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  // The editor looks at one edit and closes it. That request still has an edit to check, so the timeline stays with it.
  await click(turnFor("chg_approved_2").querySelectorAll(".simple-edits .simple-edit")[1]!);
  await act(async () => {});
  expect(openTitle()).toBe("captions");
  await press("Escape");
  expect(numbered()).toEqual([["1", undefined], ["2", undefined], ["3", "check"]]);
  // They ask for something else, and Scarlet applies it with a reason to check. The timeline is on the new request.
  const later = laterRequest().change;
  await act(async () => { data = { ...data, changes: [...data.changes, later] }; useProjectStore.setState({ current: data }); });
  await act(async () => {});
  expect(turnFor("chg_later").querySelector(".simple-pass-need")?.textContent).toBe("1 needs you");
  expect(numbered()).toEqual([["1", "check"]]);
});

it("goes back to the latest request once the request the editor went to has nothing left to check", async () => {
  appliedEdits();
  const thread = threadWith("chg_approved_2");
  data = { ...data, changes: thread.changes, tasks: thread.tasks, notes: [] };
  data = { ...data, changes: [...data.changes, laterRequest().change] };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  expect(numbered()).toEqual([["1", "check"]]);
  // Looking at an edit of the earlier request brings that request onto the timeline. It still has "wrap" to check,
  // so its flag stays marked after the edit closes.
  const earlier = turnFor("chg_approved_2");
  await click(earlier.querySelectorAll(".simple-edits .simple-edit")[1]!);
  await act(async () => {});
  await press("Escape");
  expect(numbered()).toEqual([["3", "check"]]);
  // Once "wrap" is kept nothing there waits for the editor, and the timeline is back on the latest request.
  await click(earlier.querySelector(".simple-pass-need")!);
  await act(async () => {});
  expect(openTitle()).toBe("wrap");
  await click(buttonIn(editPanel()!, "Keep")!);
  await act(async () => {});
  expect(editPanel()).toBeNull();
  expect(numbered()).toEqual([["1", "check"]]);
});

it("keeps the message box aimed at an edit while Scarlet works in that request, until the message is sent", async () => {
  appliedEdits();
  await show();
  await click(turnFor("chg_approved_2").querySelectorAll(".simple-edits .simple-edit")[1]!);
  await act(async () => {});
  await click(buttonIn(editPanel()!, "Revise")!);
  const target = () => container.querySelector(".simple-target")?.textContent;
  expect(target()).toContain("Revising “captions” at 0:00");
  await act(async () => useUiStore.getState().setAgentDraft("Make the captions smaller"));
  // Scarlet picks this request's run up again as a new attempt while the editor is still typing. The box stays aimed
  // at the edit, with what was typed.
  const base = data.tasks.find(t => t.kind !== "transcribe")!;
  data = { ...data, tasks: [...data.tasks, { ...base, id: "task_resumed", state: "queued", createdAt: new Date().toISOString(), startedAt: undefined,
    finishedAt: undefined, summary: null, changeIds: [], question: null, context: { changeId: "chg_approved_2", message: "Carry on" } }] };
  await act(async () => useProjectStore.setState({ current: data }));
  expect(threadWith("chg_approved_2").tasks.map(t => t.id)).toContain("task_resumed");
  expect(target()).toContain("Revising “captions” at 0:00");
  expect(useUiStore.getState().agentDraft).toBe("Make the captions smaller");
  // The same when Scarlet asks a question in that request.
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_resumed" ? { ...t, state: "waiting_for_user" as const,
    question: "Smaller by how much?" } : t) }));
  expect(threadWith("chg_approved_2").question?.id).toBe("task_resumed");
  expect(target()).toContain("Revising “captions” at 0:00");
  expect(useUiStore.getState().agentDraft).toBe("Make the captions smaller");
  // Once the message is sent, the box follows what's open again: the edit still is, so it stays aimed at it.
  await act(async () => { useUiStore.getState().setAgentDraft(""); composer.props!.onSent!(); });
  expect(target()).toContain("Revising “captions” at 0:00");
  // Closing the edit leaves the question Scarlet asked first as what the next message answers.
  await press("Escape");
  expect(target()).toContain("Answering");
  expect(boxTag()).toBe("Answer");
  // The request is stopped while the answer is written: there is no question left to answer and nothing is open, so
  // the words start a new edit, as the box does then. No tag says they reply to that request.
  await act(async () => useUiStore.getState().setAgentDraft("About 20% smaller"));
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.state === "waiting_for_user" ? { ...t, state: "cancelled" as const, question: null, finishedAt: new Date().toISOString() } : t) }));
  expect(boxTag()).toBeUndefined();
  expect([useUiStore.getState().agentDraft, useUiStore.getState().agentContext]).toEqual(["About 20% smaller", "whole"]);
});

it("keeps the box on Answer when a revision sent before it lands", async () => {
  appliedEdits();
  const base = data.tasks.find(t => t.kind !== "transcribe")!;
  const now = new Date().toISOString();
  data = { ...data, tasks: [...data.tasks, { ...base, id: "task_asking", state: "waiting_for_user" as const, createdAt: now, startedAt: now, finishedAt: undefined,
    summary: null, changeIds: [], question: "Smaller by how much?", context: { changeId: "chg_approved_2", message: "Carry on" } }] };
  useProjectStore.setState({ current: data });
  await show();
  await click(turnFor("chg_approved_2").querySelectorAll(".simple-edits .simple-edit")[1]!);
  await act(async () => {});
  await click(buttonIn(editPanel()!, "Revise")!);
  const target = () => container.querySelector(".simple-target")?.textContent;
  expect(target()).toContain("Revising “captions” at 0:00");
  // The revision is on its way when the editor turns to Scarlet's question in the same request.
  const landed = composer.props!.onSent!;
  await click(buttonIn(turnFor("chg_approved_2"), "Answer")!);
  expect(target()).toContain("Answering");
  // The answer goes to the question: the box no longer carries the edit, which would make it a revision of that edit.
  expect(useUiStore.getState().agentContext).toBeNull();
  await act(async () => landed());
  expect(target()).toContain("Answering");
  // The answer itself, sent from there, lets the box follow the chat again: the edit that's still open.
  await act(async () => composer.props!.onSent!());
  expect(target()).toContain("Revising “captions” at 0:00");
});

it("answers Scarlet's question with the next message when nothing is open, until the tag is taken off the box", async () => {
  appliedEdits();
  // The only question in the project.
  data = { ...data, tasks: data.tasks.filter(t => t.state !== "waiting_for_user") };
  const base = data.tasks.find(t => t.kind !== "transcribe")!;
  const now = new Date().toISOString();
  data = { ...data, tasks: [...data.tasks, { ...base, id: "task_asking", state: "waiting_for_user" as const, createdAt: now, startedAt: now, finishedAt: undefined,
    summary: null, changeIds: [], question: "Smaller by how much?", context: { changeId: "chg_approved_2", message: "Carry on" } }] };
  useProjectStore.setState({ current: data });
  await show();
  const answer = () => buttonIn(container, "Answer")!;
  const target = () => container.querySelector(".simple-target")?.textContent;
  // With no cut or edit open, the box is already on the question, and its tag says so.
  expect(target()).toBe("Answering “" + threadWith("chg_approved_2").title + "”");
  expect(boxTag()).toBe("Answer");
  expect(useUiStore.getState().draftOwner).toBe(JSON.stringify([PRJ, threadWith("chg_approved_2").id]));
  // The conversation is whole: nothing is hidden to show the question.
  expect(turns().some(t => t.hidden)).toBe(false);
  // Answer on the question means the same, and the box stays there through a message landing while the question stands.
  await click(answer());
  await act(async () => composer.props!.onSent!());
  expect(target()).toContain("Answering");
  // Taking the tag off makes the next message a new edit. The line above the box then says so and offers the way back.
  useUiStore.setState({ composerFocus: 0 });
  await act(async () => composer.props!.onClearTarget!());
  expect(boxTag()).toBeUndefined();
  expect(target()).toContain("Starting a new edit");
  expect(useUiStore.getState().draftOwner).toBe(JSON.stringify([PRJ, null]));
  // The box is built again for its new aim. The caret goes back into it, so what is typed next is the message and
  // not A, S, R or K on whatever card is open.
  expect(useUiStore.getState().composerFocus).toBe(1);
  await click(buttonIn(container.querySelector(".simple-target")!, "Move here")!);
  expect(boxTag()).toBe("Answer");
  expect(useUiStore.getState().composerFocus).toBe(2);
});

it("keeps the editor's answer and a note of theirs to two lines, with the whole of it in the title", async () => {
  appliedEdits();
  const base = data.tasks.find(t => t.kind !== "transcribe")!;
  const now = new Date().toISOString();
  const ANSWER = "Smaller by about a third, and keep them clear of the speaker's face whenever the camera is close, as it is through the intro and again in the wrap.";
  const NOTE = "The captions sit too low over the lower third in the middle section, and the music swells over the last line of the wrap, which needs to land clean.";
  data = { ...data,
    tasks: [...data.tasks, { ...base, id: "task_answered", state: "running" as const, createdAt: now, startedAt: now, finishedAt: undefined, summary: null, changeIds: [], question: null,
      context: { threadId: threadWith("chg_approved_2").id, message: "Make the captions smaller." } }],
    taskEvents: { ...data.taskEvents, task_answered: [{ type: "question" as const, at: now, text: "Smaller by how much?" }, { type: "answer" as const, at: now, text: ANSWER }] },
    // A note left on the change whose words no request was sent as.
    notes: [...data.notes, { ...data.notes[0]!, id: "note_loose", changeId: "chg_approved_2", text: NOTE, voiceTranscript: undefined, replies: undefined }] };
  useProjectStore.setState({ current: data });
  // A test lays nothing out, so how many lines each folds at is read from the simple view's stylesheet: of the rules
  // that match, the most specific, and of two as specific, the later.
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(`${import.meta.dirname}/../simple.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const foldsAt = (el: Element) => {
    let best: { lines: number; weight: number } | undefined;
    for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const lines = /-webkit-line-clamp:\s*(\d+)/.exec(body!)?.[1];
      if (!lines) continue;
      for (const selector of selectors!.split(",").map(part => part.trim())) {
        let matches = false;
        try { matches = el.matches(selector); } catch { /* A selector this page can't read is about something else. */ }
        const weight = (selector.match(/[.#[:]/g) ?? []).length;
        if (matches && (!best || weight >= best.weight)) best = { lines: Number(lines), weight };
      }
    }
    return best?.lines;
  };
  await show();
  await act(async () => {});
  // A long message keeps to two lines everywhere, and the whole message is in its title (2026-11-10: an answer and a
  // loose note showed in full, however long, with no title).
  const answer = container.querySelector<HTMLElement>(".req-say.is-yours")!;
  expect([answer.textContent, answer.getAttribute("title"), foldsAt(answer)]).toEqual([ANSWER, ANSWER, 2]);
  const note = [...container.querySelectorAll<HTMLElement>(".simple-turn > .simple-msg.from-you")].find(m => m.textContent?.includes(NOTE))!;
  expect([note.getAttribute("title"), foldsAt(note.querySelector("p")!)]).toEqual([NOTE, 2]);
});

it("stops aiming the message box at a request that is no longer in the project", async () => {
  appliedEdits();
  await show();
  await click(turnFor("chg_approved_2").querySelectorAll(".simple-edits .simple-edit")[1]!);
  await act(async () => {});
  await click(buttonIn(editPanel()!, "Revise")!);
  expect(container.querySelector(".simple-target")?.textContent).toContain("Revising “captions” at 0:00");
  const gone = threadWith("chg_approved_2");
  expect(useUiStore.getState().draftOwner).toBe(JSON.stringify([PRJ, gone.id]));
  await event(d => ({ ...d, changes: d.changes.filter(c => !gone.changes.includes(c)), tasks: d.tasks.filter(t => !gone.tasks.includes(t)) }));
  // The box moves on to what's next, Scarlet's question in another request, not a draft kept for a request that isn't there.
  expect(container.querySelector(".simple-target")?.textContent).toContain("Answering");
  expect(useUiStore.getState().draftOwner).not.toBe(JSON.stringify([PRJ, gone.id]));
  expect(boxTag()).toBe("Answer");
});

it("leaves the message box where it is now aimed when an earlier message lands", async () => {
  appliedEdits();
  flagged();
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  await click(turnFor("chg_approved_2").querySelectorAll(".simple-edits .simple-edit")[1]!);
  await act(async () => {});
  await click(buttonIn(editPanel()!, "Revise")!);
  const target = () => container.querySelector(".simple-target")?.textContent;
  expect(target()).toContain("Revising “captions” at 0:00");
  // That message is on its way when the editor aims the box at a call of the pass.
  const landed = composer.props!.onSent!;
  await reviewCalls();
  await press("r");
  expect(target()).toContain("Revising the cut at 3:50");
  await act(async () => landed());
  expect(target()).toContain("Revising the cut at 3:50");
  expect(useUiStore.getState().agentContext).toMatchObject({ changeId: "chg_ready", cutIndex: 1 });
});

it("undoes one applied edit by asking Scarlet to put back just that edit", async () => {
  appliedEdits();
  const createTask = vi.fn().mockResolvedValue({ id: "task_undo" });
  useProjectStore.setState({ createTask });
  await show();
  await click(turnFor("chg_approved_2").querySelectorAll(".simple-edits .simple-edit")[1]!);
  await act(async () => {});
  // The box is on the edit as soon as it opens, and Undo edit sits over the box while the edit is open.
  expect(container.querySelector(".simple-target")!.textContent).toContain("Revising “captions” at 0:00");
  await click(undoIcon());
  expect(createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    kind: "edit", agent: "claude", model: "opus",
    instruction: "Undo edit 2, “captions”. Put back exactly what this edit changed and leave every other edit as it is.",
    // The editor's own words for it are "Undo": the instruction is what Scarlet is told.
    context: expect.objectContaining({ changeId: "chg_approved_2", editIndex: 1, editNumber: 2, threadId: threadWith("chg_approved_2").id, message: "Undo" }),
  }));
  // Sent: the box is no longer aimed at the edit, and the player goes back to the whole timeline.
  expect(boxTag()).not.toBe("Edit at 0:00");
  expect(editPanel()).toBeNull();
});

it("undoes the open edit with U, once however long the key is held", async () => {
  appliedEdits();
  let sent!: () => void;
  const createTask = vi.fn(() => new Promise(resolve => { sent = () => resolve({ id: "task_undo" }); }));
  useProjectStore.setState({ createTask: createTask as never });
  await show();
  await click(turnFor("chg_approved_2").querySelectorAll(".simple-edits .simple-edit")[1]!);
  await act(async () => {});
  await press("u");
  // The request is on its way: the icon says so, and another press or a held key sends nothing more.
  expect(undoIcon().disabled).toBe(true);
  expect(undoIcon().getAttribute("title")).toBe("Undoing…");
  await press("u");
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "u", repeat: true, bubbles: true })); });
  expect(createTask).toHaveBeenCalledTimes(1);
  expect(createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    instruction: "Undo edit 2, “captions”. Put back exactly what this edit changed and leave every other edit as it is." }));
  await act(async () => { sent(); });
  expect(editPanel()).toBeNull();
});

it("leaves the edit the editor stepped to open, with its own Undo edit, when an undo sent from the edit before lands", async () => {
  appliedEdits();
  const landing: (() => void)[] = [];
  const createTask = vi.fn(() => new Promise(resolve => { landing.push(() => resolve({ id: "task_undo" })); }));
  useProjectStore.setState({ createTask: createTask as never });
  await show();
  await click(turnFor("chg_approved_2").querySelectorAll(".simple-edits .simple-edit")[1]!);
  await act(async () => {});
  await press("u");
  expect(undoIcon().disabled).toBe(true);
  // ↓ goes on to the next edit while the request is on its way. That edit's Undo edit is its own: ready, not "Undoing…".
  await press("ArrowDown");
  expect(openTitle()).toBe("wrap");
  expect([undoIcon().disabled, undoIcon().getAttribute("title")]).toEqual([false, "Undo edit (U)"]);
  // The request lands. It undid "captions", so the edit that's open now stays open.
  await act(async () => { landing[0]!(); });
  expect(openTitle()).toBe("wrap");
  expect([undoIcon().disabled, undoIcon().getAttribute("title")]).toEqual([false, "Undo edit (U)"]);
  // U here undoes this edit, and its own request closes it.
  await press("u");
  expect(createTask).toHaveBeenCalledTimes(2);
  expect(createTask).toHaveBeenLastCalledWith(PRJ, expect.objectContaining({
    instruction: "Undo edit 3, “wrap”. Put back exactly what this edit changed and leave every other edit as it is." }));
  await act(async () => { landing[1]!(); });
  expect(editPanel()).toBeNull();
});

it("has no menu on a request for now: Undo these edits and File this thread aren't in the chat", async () => {
  appliedEdits();
  await show();
  const turn = turnFor("chg_approved_2");
  expect(turn.querySelector('[aria-label="More for this thread"], .simple-action-more')).toBeNull();
  // Nothing takes the menu's place at the end of the row either.
  expect(turn.querySelector(".simple-pass-line .req-right")?.textContent).toBe("");
});

it("numbers the chat's edits from the working cut, leaving out what it no longer contains", async () => {
  appliedEdits();
  // The engine's list for the working cut: "wrap" was undone, and the rest are in timeline order.
  vi.spyOn(api, "threadEdits").mockResolvedValue({ version: data.project.head!, edits: [
    { changeId: "chg_approved_2", spot: 1, label: "captions", range: { start: 0.2, end: 2.4 }, previous: [] },
    { changeId: "chg_approved_2", spot: 0, label: "music bed", range: { start: 3, end: 16 }, previous: [] },
  ] });
  await show();
  await act(async () => {});
  const turn = turnFor("chg_approved_2");
  expect([...turn.querySelectorAll(".simple-edits .simple-edit-title")].map(t => t.textContent)).toEqual(["captions", "music bed"]);
  expect(turn.querySelector(".simple-pass-need")).toBeNull();
});

it("counts an edit decided cut by cut as reviewed, in a long list", async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ changeId: "chg_approved_2", spot: i, label: `cut ${i + 1}`,
    range: { start: i, end: i }, at: i, previous: [] }));
  data = { ...data, changes: data.changes.map(c => c.id === "chg_approved_2" ? { ...c, approvedSpots: many.map((_, i) => i) } : c) };
  useProjectStore.setState({ current: data });
  vi.spyOn(api, "threadEdits").mockResolvedValue({ version: data.project.head!, edits: many });
  await show();
  await act(async () => {});
  const turn = turnFor("chg_approved_2");
  expect(turn.querySelectorAll(".simple-edits .simple-edit")).toHaveLength(12);
  expect([...turn.querySelectorAll(".simple-edits .edit-badge")].every(b => b.classList.contains("is-kept"))).toBe(true);
  expect(turn.querySelector(".simple-pass-need")).toBeNull();
});

it("lists every edit of a long list from its one link, with no second link to the rest", async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ changeId: "chg_approved_2", spot: i, label: `cut ${i + 1}`,
    range: { start: i, end: i }, at: i, previous: [] }));
  vi.spyOn(api, "threadEdits").mockResolvedValue({ version: data.project.head!, edits: many });
  await showFolded();
  await act(async () => {});
  const turn = turnFor("chg_approved_2");
  const rows = () => [...turn.querySelectorAll<HTMLButtonElement>(".simple-edits .simple-edit")];
  // "See all" opens all twelve: the list is its rows and nothing else, with no fold after the first few.
  expect(turn.querySelector(".simple-pass-toggle")?.textContent).toBe("See all");
  await click(turn.querySelector(".simple-pass-toggle")!);
  expect(rows().map(r => r.querySelector(".edit-badge")?.textContent)).toEqual(many.map((_, i) => String(i + 1)));
  expect(turn.querySelectorAll(".simple-edits > *")).toHaveLength(12);
  expect([buttonIn(turn, "Show all 12"), buttonIn(turn, "Show fewer")]).toEqual([undefined, undefined]);
  // The last one opens from its own row, and the list stays whole.
  await click(rows().at(-1)!);
  await act(async () => {});
  expect([rows().length, rows().at(-1)?.getAttribute("aria-label"), rows().at(-1)?.getAttribute("aria-current")]).toEqual([12, "Edit 12: cut 12", "true"]);
});

it("opens a suggestion in the card on top of the timeline, with Before and After, Revise and Apply", async () => {
  vi.spyOn(api, "timeline").mockImplementation(async (_, version = "head") => ({ timeline: { ...data.timeline!, version } }));
  const approve = vi.fn().mockResolvedValue({ outcome: "applied" });
  useProjectStore.setState({ approve });
  await show();
  await click(suggestion("chg_ready"));
  await act(async () => {});
  const decide = container.querySelector('[aria-label="Suggestion"]')!;
  expect(decide.classList.contains("edit-card")).toBe(true);
  expect(container.querySelector(".simple-stage > .player-review")).toBeNull();
  // One row, as an edit's: Scarlet's words for it, Before/After, Revise and Apply. No Close button: Esc closes it.
  expect(decide.querySelector(".edit-card-title")?.textContent).toBe(data.changes.find(c => c.id === "chg_ready")!.description);
  expect(buttonIn(decide, "Close")).toBeUndefined();
  // The suggestion's own line plays it: there is no Play link under it, and the line stays pressed while it shows.
  expect([buttonIn(turnFor("chg_ready"), "Play"), suggestion("chg_ready").getAttribute("aria-pressed")]).toEqual([undefined, "true"]);
  expect(beforeIcon(decide)).toEqual(["", "Before", "false", "Play Before (\\)"]);
  expect(decide.querySelectorAll(".edit-card-side button")).toHaveLength(1);
  await click(compareButton(decide));
  expect(compareButton(container.querySelector('[aria-label="Suggestion"]')!)?.getAttribute("aria-pressed")).toBe("true");
  await click(buttonIn(container.querySelector('[aria-label="Suggestion"]')!, "Apply")!);
  expect(approve).toHaveBeenCalledWith("chg_ready", undefined, undefined);
});

it("carries a playing suggestion over a switch of sides, and stays paused once the editor paused it", async () => {
  // The window's media timing: a play or a pause shows on the video at once, and its event arrives afterwards.
  const paused = new WeakMap<HTMLMediaElement, boolean>(), opened = new WeakSet<HTMLMediaElement>();
  let coming: { video: HTMLMediaElement; name: string }[] = [];
  const isPaused = (video: HTMLMediaElement) => paused.get(video) ?? true;
  vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (this: HTMLMediaElement) { return isPaused(this); });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async function (this: HTMLMediaElement) {
    if (isPaused(this)) { paused.set(this, false); coming.push({ video: this, name: "play" }); }
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    if (!isPaused(this)) { paused.set(this, true); coming.push({ video: this, name: "pause" }); }
  });
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockImplementation(function (this: HTMLMediaElement) { return opened.has(this) ? 4 : 0; });
  const heard = () => act(async () => { for (const { video, name } of coming.splice(0)) video.dispatchEvent(new Event(name)); });
  // Each side has a saved preview file, as in the installed app.
  const full = data.renders.find(r => r.kind === "full")!;
  vi.spyOn(api, "renders").mockImplementation(async (_id, q) => ({
    renders: q?.version ? [{ ...full, id: `r_${q.version}`, version: q.version, key: "preview", state: "done" as const }] : [],
    fullRenderKeys: { context: "c", preview: "preview", delivery: "d" } }) as never);
  vi.spyOn(api, "sourceCache").mockResolvedValue({ state: "ready", fileKey: "k" } as never);
  vi.spyOn(api, "timeline").mockImplementation(async (_, version = "head") => ({ timeline: { ...data.timeline!, version } }));
  const monitor = () => container.querySelector<HTMLVideoElement>(".watch-monitor video")!;
  const shown = async () => {
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    const video = monitor();
    if (!opened.has(video)) {
      opened.add(video);
      Object.defineProperty(video, "duration", { configurable: true, value: 600 });
      await act(async () => { video.dispatchEvent(new Event("loadedmetadata")); });
    }
    await heard();
    return { file: video.getAttribute("src")?.split("?")[0]?.split("/").slice(-3).join("/"), playing: !isPaused(video) };
  };
  const decide = () => container.querySelector('[aria-label="Suggestion"]')!;
  await show();
  // Its line plays it.
  await click(suggestion("chg_ready"));
  expect(await shown()).toEqual({ file: "renders/r_ver_4/file", playing: true });
  // The other side takes over from the video playing, and plays on.
  await click(compareButton(decide()));
  expect(await shown()).toEqual({ file: "renders/r_ver_3/file", playing: true });
  await click(compareButton(decide()));
  expect(await shown()).toEqual({ file: "renders/r_ver_4/file", playing: true });
  // Pausing with the player carries over to the other side.
  await press(" ");
  expect(await shown()).toEqual({ file: "renders/r_ver_4/file", playing: false });
  await click(compareButton(decide()));
  expect(await shown()).toEqual({ file: "renders/r_ver_3/file", playing: false });
});

/** One suggestion in several places of the 16 s video. */
const suggestionIn = (places: Array<{ start: number; end: number }>) => {
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready"
    ? { ...c, ranges: places, renders: places.map(range => ({ range, beforeRange: range, before: null, after: null })) } : c) };
  useProjectStore.setState({ current: data });
  vi.spyOn(api, "timeline").mockImplementation(async (_, version = "head") => ({ timeline: { ...data.timeline!, version } }));
  // The timeline's zoom lands at once, as it does with motion reduced.
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  vi.spyOn(window, "matchMedia").mockReturnValue(Object.create(reduced, { matches: { value: true } }));
};
/** The timeline is 1000 px wide for a press or a hover, so a point's x is ten times its percent. */
const timelineStrip = () => {
  const strip = container.querySelector<HTMLElement>(".simple-timeline-hover")!, slider = container.querySelector<HTMLElement>(".timeline-slider")!;
  strip.getBoundingClientRect = slider.getBoundingClientRect = () => ({ left: 0, width: 1000 }) as DOMRect;
  slider.setPointerCapture = () => {};
  return strip;
};
const pressStrip = (x: number) => act(async () => {
  timelineStrip().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, button: 0, pointerId: 1, clientX: x })); });
const tenths = (percent: string) => Math.round(parseFloat(percent) * 10) / 10;

it("marks every place a suggestion changes: its band on the one the player is on, a dot on each of the others", async () => {
  suggestionIn([{ start: 2, end: 3 }, { start: 7, end: 8 }, { start: 12, end: 13 }]);
  const seek = vi.spyOn(player, "seek");
  await show();
  await click(suggestion("chg_ready"));
  await act(async () => {});
  const band = () => { const { left, width } = container.querySelector<HTMLElement>(".simple-timeline-band")!.style; return [tenths(left), tenths(width)]; };
  const dots = () => [...container.querySelectorAll<HTMLElement>(".simple-timeline-mark")];
  // The suggestion opens on its first place, zoomed to it as one in a single place is: 0:02–0:03 with five seconds
  // either side, so 0:00–0:08. The place at 0:07 is in view there, as a plain dot beside the band. The one at 0:12 is
  // past the edge.
  expect(band()).toEqual([25, 12.5]);
  expect(dots().map(d => [d.className, d.style.left])).toEqual([["simple-timeline-mark is-dot", "87.5%"]]);
  // Zoomed out to the whole video, each of the other places has its dot.
  await press("0");
  expect(band()).toEqual([12.5, 6.3]);
  expect(dots().map(d => d.style.left)).toEqual(["43.75%", "75%"]);
  // A dot names its place as the suggestion's on hover.
  await act(async () => { timelineStrip().dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 437.5 })); });
  const note = container.querySelector(".timeline-track .simple-timeline-tip.is-joined > span")!;
  expect([note.querySelector("b")?.textContent, note.querySelector("small")?.textContent]).toEqual(["Suggestion · 0:07", "0:07–0:08 · 1.0 s"]);
  // A press on a dot moves the player and the band to that place, and the timeline zooms to it as it does to an edit
  // that opens: 0:07–0:16. Of the other two places, the one at 0:07 is in view there, as a dot.
  seek.mockClear();
  await pressStrip(750);
  expect(band()).toEqual([55.6, 11.1]);
  expect(dots().map(d => d.style.left)).toEqual(["0%"]);
  expect(seek).toHaveBeenCalledWith(12, false);
  // Before plays the working cut from a second ahead of that place.
  seek.mockClear();
  await click(compareButton(container.querySelector('[aria-label="Suggestion"]')!));
  expect(seek).toHaveBeenCalledWith(11, true);
  // Revise is about the place on screen.
  await click(buttonIn(container.querySelector('[aria-label="Suggestion"]')!, "Revise")!);
  expect(useUiStore.getState().agentContext).toMatchObject({ changeId: "chg_ready", time: 12, end: 13, label: "Suggestion" });
  // Opened again, the suggestion starts on its first place.
  await press("Escape");
  await click(suggestion("chg_ready"));
  await act(async () => {});
  expect(band()).toEqual([25, 12.5]);
});

it("scrubs on a press on the dot of the place on screen, and moves the band on a press on another place's", async () => {
  // The first place runs over most of the video, so it has no band: both places are dots on the whole timeline.
  suggestionIn([{ start: 0, end: 14 }, { start: 15, end: 16 }]);
  const seek = vi.spyOn(player, "seek");
  await show();
  await click(suggestion("chg_ready"));
  await act(async () => {});
  const dots = () => [...container.querySelectorAll<HTMLElement>(".simple-timeline-mark")].map(d => d.style.left);
  expect([container.querySelector(".simple-timeline-band"), dots()]).toEqual([null, ["0%", "93.75%"]]);
  // The suggestion is on the place at 0:00 already, so its dot opens nothing: the pointer turns to a hand only over
  // the other place's.
  const hand = async (x: number) => {
    await act(async () => { timelineStrip().dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x })); });
    return container.querySelector(".simple-timeline-hover")!.classList.contains("is-aimed");
  };
  expect([await hand(0), await hand(937.5)]).toEqual([false, true]);
  // The player is at 0:09. A press on the dot at 0:00 goes there, as a press anywhere on the timeline does.
  await act(async () => usePlayerStore.setState({ time: 9 }));
  seek.mockClear();
  await pressStrip(0);
  expect(seek).toHaveBeenLastCalledWith(0, true);
  await act(async () => { container.querySelector(".timeline-slider")!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, isPrimary: true, button: 0, pointerId: 1, clientX: 0 })); });
  expect([container.querySelector(".simple-timeline-band"), dots()]).toEqual([null, ["0%", "93.75%"]]);
  // A press on the other place's dot moves the player and the band there: 0:15–0:16, in a timeline zoomed to 0:10–0:16.
  seek.mockClear();
  await pressStrip(937.5);
  const band = container.querySelector<HTMLElement>(".simple-timeline-band")!.style;
  expect([tenths(band.left), tenths(band.width)]).toEqual([83.3, 16.7]);
  expect(seek).toHaveBeenCalledWith(15, false);
});

it("leaves a suggestion in one place as it was: a band, zoomed to it, and no dot", async () => {
  vi.spyOn(api, "timeline").mockImplementation(async (_, version = "head") => ({ timeline: { ...data.timeline!, version } }));
  await show();
  await click(suggestion("chg_ready"));
  await act(async () => {});
  // 0:05 to 0:06.2 of the 16 s video, with five seconds either side: the timeline shows 0:00–0:11.2.
  const band = container.querySelector<HTMLElement>(".simple-timeline-band")!.style;
  expect([Math.round(parseFloat(band.left) * 10) / 10, Math.round(parseFloat(band.width) * 10) / 10]).toEqual([44.6, 10.7]);
  expect(container.querySelector(".simple-timeline-mark, .simple-timeline-hover")).toBeNull();
});

function savedCalls(id: string, body: Parameters<typeof api.saveCutChoices>[1]) {
  const change = useProjectStore.getState().current!.changes.find(c => c.id === id)!;
  return { change: { ...change, cutChoices: body.choices.map(({ index, choice }) => {
    const { start, end } = change.cutAssessments?.find(a => a.index === index) ?? change.cutReasons?.[index] ?? { start: index, end: index + 1 };
    return { index, choice, start, end };
  }), applyWhenDone: body.applyWhenDone ? { userId: "usr_editor", at: new Date().toISOString() } : undefined } };
}

const flagged = () => {
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, cutAssessments: [
    { index: 0, start: 0, end: 220, verdict: "cut" as const, reason: "A clean retake." },
    { index: 1, start: 230, end: 233, verdict: "ask" as const, reason: "Breath before the price." },
    { index: 2, start: 598, end: 602.5, verdict: "ask" as const, reason: "The corrected image-input take belongs here." },
  ] } : c) };
  vi.spyOn(api, "cutReview").mockResolvedValue({ review: { cuts: [0, 1, 2].map(i => ({ at: i, removed: { start: i, end: i + 1 }, beforeClip: 0 })),
    original: data.timeline!, proposed: data.timeline!, firstCut: false } });
  return vi.spyOn(api, "saveCutChoices").mockImplementation(async (id, body) => savedCalls(id, body));
};
const passCard = () => turnFor("chg_ready").querySelector<HTMLElement>(".simple-pass")!;
/** The rows of the pass's list. A request about one of them sits under its row, with buttons of its own that aren't rows. */
const passRows = () => [...passCard().querySelectorAll<HTMLButtonElement>(".simple-pass-list > li > button")];
/** "N need you" opens the list to just the calls; the first one still waiting plays. A call being revised can't be opened from the list. */
/** "N need you" lists the calls and opens the first that waits. With none waiting to open, the first row that can be opened is. */
const reviewCalls = async () => {
  await click(passCard().querySelector(".simple-pass-need")!);
  if (!passRows().some(r => r.getAttribute("aria-current"))) await click(passRows().find(r => !r.disabled)!);
};
/** A call's row in the pass's list, by Scarlet's note on it. */
const passRow = (note: string) => passRows().find(r => r.querySelector(".simple-pass-label")?.textContent?.includes(note))!;
const call = () => container.querySelector<HTMLElement>('[aria-label="Call"]')!;

it("sums a dialogue pass up on one card, and makes its calls in the card on the timeline", async () => {
  const save = flagged();
  const approve = vi.fn().mockResolvedValue({ outcome: "applied" });
  useProjectStore.setState({ current: data, approve });
  await show();
  await act(async () => {});
  // While the calls wait they are the block, listed without a click: no sentence yet, nothing to open, and no strip
  // under the player. "2 need you" is the heading's.
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("2 need you");
  expect(passCard().querySelector(".simple-made, .simple-pass-toggle")).toBeNull();
  // The third cut is Scarlet's own pick. It goes in with the last call, and no line under the pass counts it.
  expect(passCard().textContent).not.toMatch(/more cuts? appl|Apply adds|proposed/);
  expect(container.querySelector('[aria-label="Suggestion"]')).toBeNull();
  expect(container.querySelector(".simple-on-video")).toBeNull();
  // The short list is a call's number, amber while it waits, and Scarlet's note: no time, mark, version or amount.
  expect([passCard().querySelector(".simple-pass-list")!.className, passCard().querySelector(".simple-pass-list")!.getAttribute("aria-label")])
    .toEqual(["simple-pass-list is-short", "Calls that need you"]);
  expect(passRows().map(r => [r.querySelector(".edit-badge")?.textContent, r.querySelector(".edit-badge")?.classList.contains("is-check"), r.querySelector(".simple-pass-label")?.textContent]))
    .toEqual([["1", true, "Breath before the price."], ["2", true, "The corrected image-input take belongs here."]]);
  expect(passCard().querySelector(".simple-pass-list :is(.simple-pass-time, .simple-pass-tick, .simple-pass-value, small)")).toBeNull();
  expect(passRows().map(r => r.getAttribute("aria-current"))).toEqual([null, null]);
  // "2 need you" opens the first of them: one click reaches the cut. Its row is lit.
  await click(passCard().querySelector(".simple-pass-need")!);
  expect(passRows().map(r => r.getAttribute("aria-current"))).toEqual(["true", null]);
  // The call opens in the same card an applied edit uses, right on top of the timeline.
  expect(call().closest(".cut-transport > .edit-card")).toBe(call());
  expect(container.querySelector(".simple-on-video")?.textContent).toBe("Showing cut at 3:50 · 1 of 2 · After");
  // Like an applied edit, a call is one row: its number, the same as on its line in the chat, then Scarlet's reason.
  // How many still wait is on hover. It has no picker and no script.
  expect([...call().querySelectorAll(".edit-card-bar > .edit-card-count, .edit-card-bar > .edit-card-title")].map(e => e.textContent))
    .toEqual(["Cut 1", "Breath before the price."]);
  expect(call().querySelector(".edit-card-count")?.getAttribute("title")).toBe("1 of 2 still waiting for you");
  expect(call().children.length).toBe(1);
  expect(call().querySelector(".edit-card-nav, .preference-select, .edit-card-script, .review-step, .edit-passage")).toBeNull();
  // The conversation stays whole and the message box is tagged with this cut. The icon for the cut's words is
  // on the card, before the one for Before, folded: the chat is for what's said and done, not the dialogue.
  expect(turns().some(t => t.hidden)).toBe(false);
  expect(boxTag()).toBe("Cut 1");
  expect(container.querySelector(".simple-open")).toBeNull();
  expect(call().querySelector(".edit-card-side > :first-child")).toBe(transcriptLink());
  expect([...transcriptName(), transcriptLink().getAttribute("aria-expanded")]).toEqual(["", "Show transcript", "Show transcript", "false"]);
  expect(openHead()!.querySelector(".edit-passage")).toBeNull();
  // Opened, the mark where the cut would join says how long it runs, in amber: it hasn't come out yet. The icon folds it away again.
  await click(transcriptLink());
  expect([...transcriptName(), transcriptLink().getAttribute("aria-expanded")]).toEqual(["", "Hide transcript", "Hide transcript", "true"]);
  // The words open under the card's row, as the card's second row.
  expect(call().children.length).toBe(2);
  expect(call().querySelector(":scope > .thread-passage.is-call .edit-passage-cut")?.textContent).toBe("3.0 s");
  await click(transcriptLink());
  expect(openHead()!.querySelector(".edit-passage")).toBeNull();
  // A cut has no Before/After switch: one icon plays it with the cut footage, and names itself and its key on hover.
  expect(call().querySelector(".compare-switch")).toBeNull();
  expect(call().querySelector(".edit-card-side > :last-child")).toBe(call().querySelector(".edit-card-before"));
  expect(beforeIcon(call())).toEqual(["", "Before", "false", "Play Before (\\)"]);
  expect(call().querySelector(".edit-card-before")?.getAttribute("aria-keyshortcuts")).toBe("\\");
  expect(call().querySelector(".simple-key")).toBeNull();
  expect(call().querySelector(".review-close")).toBeNull();
  expect([...call().querySelectorAll(".review-actions button")].map(b => [b.textContent, b.getAttribute("aria-keyshortcuts"), b.getAttribute("title")]))
    .toEqual([["Revise", "R", "Revise (R)"], ["Approve", "A", "Approve (A)"], ["", "S", "Skip (S)"]]);
  // Skip is a small × after Approve, named on hover.
  expect(call().querySelector(".review-actions > .edit-card-skip:last-child svg")).not.toBeNull();
  expect(passRows()[0]!.getAttribute("aria-current")).toBe("true");

  // A approves it and plays the next call. The call is saved on the proposal right away; nothing applies yet.
  await press("a");
  expect(save).toHaveBeenLastCalledWith("chg_ready", expect.objectContaining({ choices: [{ index: 1, choice: "cut" }], applyWhenDone: false }));
  expect(container.querySelector(".simple-on-video")?.textContent).toBe("Showing cut at 9:58 · 2 of 2 · After");
  // The next call is the only one still waiting, and the box is tagged with it. Its transcript opens folded again.
  expect(call().querySelector(".edit-card-count")?.textContent).toBe("Cut 2");
  expect(boxTag()).toBe("Cut 2");
  expect(transcriptLink().getAttribute("aria-expanded")).toBe("false");
  // The count goes down. The decided call keeps its place while the list is open, ticked, with how it was decided.
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("1 needs you");
  expect(passRows().map(r => [r.querySelector(".edit-badge")?.textContent, r.querySelector(".edit-badge")?.classList.contains("is-check"), r.querySelector(".simple-pass-value")?.textContent]))
    .toEqual([["1", false, "Approved"], ["2", true, undefined]]);
  expect(approve).not.toHaveBeenCalled();
  // "1 needs you" leaves the call that's open where it is. A decided call's row opens it again.
  await click(passCard().querySelector(".simple-pass-need")!);
  expect(passRows().map(r => r.getAttribute("aria-current"))).toEqual([null, "true"]);
  await click(passRows()[0]!);
  expect(container.querySelector(".simple-on-video")?.textContent).toBe("Showing cut at 3:50 · 1 of 2 · After");
  expect(buttonIn(call(), "Approve")?.getAttribute("aria-pressed")).toBe("true");
  await press("ArrowDown");
  await press("\\");
  expect(container.querySelector(".simple-on-video")?.textContent).toBe("Showing cut at 9:58 · 2 of 2 · Before");

  // The last call applies the pass: Scarlet's pick for the cut it was sure of, and the footage this one skips.
  await click(call().querySelector('[aria-label="Skip"]')!);
  await act(async () => {});
  expect(save).toHaveBeenLastCalledWith("chg_ready", expect.objectContaining({ choices: [{ index: 1, choice: "cut" }, { index: 2, choice: "keep" }] }));
  expect(approve).toHaveBeenCalledWith("chg_ready", undefined, [2]);
  expect(container.querySelector('[aria-label="Call"]')).toBeNull();
});

it("says nothing under a pass's stages while it works and asks about no cut, and applies it once it is done", async () => {
  // A dialogue pass has just started, in a project that was open when it began. It has proposed nothing yet.
  const ready = data.changes.find(c => c.id === "chg_ready")!;
  data = { ...data, changes: data.changes.filter(c => c.id !== "chg_ready"),
    tasks: data.tasks.map(t => t.id === "task_done" ? { ...t, state: "running" as const, finishedAt: undefined, summary: null, changeIds: [],
      instruction: "/dialogue-pass", context: { ...t.context, message: "/dialogue-pass" } } : t) };
  const approve = vi.fn().mockResolvedValue({ outcome: "applied" });
  useProjectStore.setState({ current: data, approve });
  vi.spyOn(api, "cutReview").mockResolvedValue({ review: { original: data.timeline!, proposed: data.timeline!, firstCut: false,
    cuts: STAGED.map((r, at) => ({ at, removed: { start: r.start, end: r.end }, beforeClip: 0 })) } });
  await show();
  await act(async () => {});
  expect(container.querySelector('[aria-label="Dialogue pass"]')).toBeNull();
  // Its first part stages three cuts. Scarlet hasn't checked them, so none is a call yet. Nothing needs the editor, so
  // the block is the pass's stages: no count of the staged cuts under them, and nothing to apply or schedule.
  await act(async () => {
    data = { ...data, changes: [...data.changes, { ...ready, intent: "suggestion" as const, cutReasons: STAGED }],
      tasks: data.tasks.map(t => t.id === "task_done" ? { ...t, changeIds: ["chg_ready"] } : t) };
    useProjectStore.setState({ current: data });
  });
  await act(async () => {});
  const says = () => [passCard().querySelector(".simple-made")?.textContent, [...passCard().querySelectorAll("button")].map(b => b.textContent)];
  expect(says()).toEqual([undefined, []]);
  // Scarlet checks them and is sure of each. It still asks about none, and is still at work.
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_ready" ? { ...c, cutAssessments: askAll(STAGED).map(a => ({ ...a, verdict: "cut" as const })) } : c) }));
  expect(says()).toEqual([undefined, []]);
  // Done, with no call for the editor to make: nothing is left to decide, so the pass goes in by itself. There is no
  // Apply to press.
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_done" ? { ...t, state: "done" as const, finishedAt: new Date().toISOString() } : t) }));
  expect(approve).toHaveBeenCalledWith("chg_ready", undefined, []);
  expect(approve).toHaveBeenCalledTimes(1);
  expect(buttonIn(passCard(), "Apply")).toBeFalsy();
});

it("hands the editor the cuts a finished pass never checked, as calls, instead of Apply", async () => {
  // The pass finished, and Scarlet checked one of its three staged cuts: it is sure of it. Nobody looked at the other two.
  const ready = data.changes.find(c => c.id === "chg_ready")!;
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...ready, intent: "suggestion" as const, cutReasons: STAGED,
      cutAssessments: askAll(STAGED).slice(0, 1).map(a => ({ ...a, verdict: "cut" as const })) } : c),
    tasks: data.tasks.map(t => t.id === "task_done" ? { ...t, changeIds: ["chg_ready"], instruction: "/dialogue-pass", context: { ...t.context, message: "/dialogue-pass" } } : t) };
  useProjectStore.setState({ current: data });
  vi.spyOn(api, "cutReview").mockResolvedValue({ review: { original: data.timeline!, proposed: data.timeline!, firstCut: false,
    cuts: STAGED.map((r, at) => ({ at, removed: { start: r.start, end: r.end }, beforeClip: 0 })) } });
  await show();
  await act(async () => {});
  // Those two are the editor's calls, listed as a stopped pass's would be: nothing applies them unseen.
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("2 need you");
  expect(buttonIn(passCard(), "Apply")).toBeUndefined();
  expect(passRows().map(r => r.querySelector(".simple-pass-label")?.textContent)).toEqual(["Breath before the price.", "Repeated aside."]);
  await reviewCalls();
  expect(call().querySelector(".edit-card-title")?.textContent).toBe("Not checked yet. Breath before the price.");
});

it("marks only what needs the editor once a pass is applied, and its settled cuts while its list is open", async () => {
  appliedEdits();
  data = { ...data, tasks: [...data.tasks, { ...data.tasks.find(t => t.id === "task_done")!, id: "task_pass", kind: "edit" as const,
    instruction: "/dialogue-pass", context: { message: "/dialogue-pass" }, changeIds: ["chg_approved_2"] }] };
  // An earlier request with one edit of its own.
  const made = data.changes.find(c => c.id === "chg_approved_2")!;
  const before = new Date(Date.parse(made.createdAt!) - 3_600_000).toISOString();
  const title = { changeId: "chg_title", spot: 0, label: "title card", range: { start: 1, end: 2 }, previous: [] };
  data = { ...data, changes: [{ ...made, id: "chg_title", taskId: undefined, threadId: undefined, noteIds: [], description: "Add a title card",
    createdAt: before, updatedAt: before, timelineEdits: [{ label: title.label, range: title.range }] }, ...data.changes] };
  const cuts = (await api.threadEdits(PRJ, threadWith("chg_approved_2").id)).edits;
  vi.spyOn(api, "threadEdits").mockImplementation(async (_project, threadId) => ({ version: data.project.head!,
    edits: threadId === "chg_title" ? [title] : threadId === threadWith("chg_approved_2").id ? cuts : [] }));
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  const pass = turnFor("chg_approved_2").querySelector<HTMLElement>(".simple-pass")!;
  const marks = () => [...container.querySelectorAll<HTMLElement>(".simple-timeline-mark")];
  expect(marks()).toEqual([]);
  // Its open list brings the pass's cuts onto the timeline: settled ones faint, the flagged one amber.
  await click(pass.querySelector(".simple-pass-toggle")!);
  await act(async () => {});
  expect(marks().map(m => m.classList.contains("is-quiet"))).toEqual([true, true, false]);
  expect(marks()[2]!.dataset.state).toBe("check");
  // The row under the pointer lights its tick and shows its number.
  const row = pass.querySelector(".simple-pass-list button")!;
  await act(async () => { row.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })); });
  expect(marks()[0]!.classList.contains("is-hot")).toBe(true);
  expect(marks()[0]!.querySelector(".simple-timeline-number")?.textContent).toBe("1");
  await act(async () => { row.dispatchEvent(new PointerEvent("pointerout", { bubbles: true })); });
  expect(marks()[0]!.classList.contains("is-hot")).toBe(false);
  // With the list still open, an edit of another request opens in the card, and closing it brings the pass's cuts back.
  await click(buttonIn(turnFor("chg_title"), "See edit")!);
  await act(async () => {});
  expect(openTitle()).toBe("title card");
  expect(editPanel()).not.toBeNull();
  await press("Escape");
  await act(async () => {});
  expect(marks().map(m => m.classList.contains("is-quiet"))).toEqual([true, true, false]);
  // Closed, only the edit that asks for a look stays marked.
  await click(pass.querySelector(".simple-pass-toggle")!);
  expect(marks().map(m => m.dataset.state)).toEqual(["check"]);
});

it("lists just an applied pass's flagged cut from need you, and shows its settled cuts on the timeline once every edit is listed", async () => {
  appliedEdits();
  data = { ...data, tasks: [...data.tasks, { ...data.tasks.find(t => t.id === "task_done")!, id: "task_pass", kind: "edit" as const,
    instruction: "/dialogue-pass", context: { message: "/dialogue-pass" }, changeIds: ["chg_approved_2"] }] };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  const pass = turnFor("chg_approved_2").querySelector<HTMLElement>(".simple-pass")!;
  const list = () => pass.querySelector(".simple-pass-list");
  const marks = () => [...container.querySelectorAll<HTMLElement>(".simple-timeline-mark")];
  // The pass is one sentence and a link. "1 needs you" lists just the flagged cut, in the full list's own rows, and
  // opens it. Pressed again it puts the list away; the cut stays open.
  expect([pass.querySelector(".simple-made")?.textContent, pass.querySelector(".simple-pass-toggle")?.textContent]).toEqual(["Made 3 edits: music bed, captions, wrap.", "See all"]);
  expect(list()).toBeNull();
  const need = () => pass.querySelector<HTMLElement>(".simple-pass-need")!;
  await click(need());
  await act(async () => {});
  expect([list()?.getAttribute("aria-label"), list()?.className, list()?.querySelectorAll("li").length, need().getAttribute("aria-pressed")]).toEqual(["Edits that need you", "simple-pass-list", 1, "true"]);
  // The row that needs the editor has its time in amber, and no dot before its words.
  expect([list()?.querySelector(".simple-pass-label")?.textContent, list()?.querySelector(".simple-pass-time")?.className, list()?.querySelector("button")?.getAttribute("aria-current")]).toEqual(["wrap", "simple-pass-time is-need", "true"]);
  expect(editPanel()).not.toBeNull();
  // The settled cuts aren't on the timeline for this list: only the whole list puts them there.
  expect(marks().filter(m => m.classList.contains("is-quiet"))).toEqual([]);
  await click(need());
  expect([list(), need().getAttribute("aria-pressed"), !!editPanel()]).toEqual([null, "false", true]);
  await click(need());
  expect(list()?.querySelectorAll("li").length).toBe(1);
  // Kept, nothing waits on the editor, so that list goes. The link lists every edit, and the timeline shows them too:
  // settled cuts as faint ticks.
  await press("k");
  await act(async () => {});
  expect(editPanel()).toBeNull();
  expect([pass.querySelector(".simple-pass-need"), list()]).toEqual([null, null]);
  await click(pass.querySelector(".simple-pass-toggle")!);
  await act(async () => {});
  expect(list()?.getAttribute("aria-label")).toBe("Every edit");
  expect(list()?.querySelectorAll("li")).toHaveLength(3);
  expect(marks().map(m => m.classList.contains("is-quiet"))).toEqual([true, true, true]);
  // The row under the pointer lights its tick.
  await act(async () => { list()!.querySelector("button")!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })); });
  expect(marks()[0]!.classList.contains("is-hot")).toBe(true);
  // The link, which now says Hide, closes the list, and the ticks go with it.
  expect([pass.querySelector(".simple-pass-toggle")?.textContent, pass.querySelector(".simple-pass-toggle")?.getAttribute("aria-expanded")]).toEqual(["Hide", "true"]);
  await click(pass.querySelector(".simple-pass-toggle")!);
  expect(list()).toBeNull();
  expect(marks()).toEqual([]);
});

/** The request's one edit is the flagged one, so the link that opens every edit would list what "1 needs you" does. */
const onlyFlagged = () => {
  appliedEdits().mockImplementation(async (_project, threadId) => ({ version: data.project.head!,
    edits: threadId !== threadWith("chg_approved_2").id ? [] : [
      { changeId: "chg_approved_2", spot: 2, label: "wrap", range: { start: 11.5, end: 16 }, previous: [], check: CHECK, summary: SUMMARY }] }));
};

it("leaves out the link that opens every edit while each of them needs the editor", async () => {
  onlyFlagged();
  await showFolded();
  await act(async () => {});
  const turn = turnFor("chg_approved_2");
  const need = () => turn.querySelector<HTMLElement>(".simple-pass-need");
  const rows = () => [...turn.querySelectorAll<HTMLButtonElement>(".simple-edits .simple-edit")];
  // "1 needs you" is the one way in: it lists the edit and opens it.
  expect([need()?.textContent, turn.querySelector(".simple-pass-toggle")]).toEqual(["1 needs you", null]);
  await click(need()!);
  await act(async () => {});
  expect([rows().length, need()!.getAttribute("aria-pressed"), !!editPanel(), turn.querySelector(".simple-pass-toggle")]).toEqual([1, "true", true, null]);
  // Kept, nothing needs the editor, and the link is how the edit is reached again.
  await press("k");
  await act(async () => {});
  const see = buttonIn(turn, "See edit")!;
  expect([need(), rows().length, see.hasAttribute("aria-expanded")]).toEqual([null, 0, false]);
  await click(see);
  expect(editPanel()?.querySelector(".edit-card-title")?.textContent).toBe(SUMMARY);
  expect([rows()[0]?.getAttribute("aria-current"), buttonIn(turn, "Close edit")?.getAttribute("aria-current")]).toEqual(["true", "true"]);
  await click(buttonIn(turn, "Close edit")!);
  expect([editPanel(), rows().length, !!buttonIn(turn, "See edit")]).toEqual([null, 0, true]);
});

it("opens the list of what needs the editor, not every edit, for an edit opened while each of them needs the editor", async () => {
  onlyFlagged();
  // The latest request's edits are the ones marked on the timeline.
  const thread = threadWith("chg_approved_2");
  data = { ...data, changes: thread.changes, tasks: thread.tasks, notes: [] };
  useProjectStore.setState({ current: data });
  await showFolded();
  await act(async () => {});
  const turn = turnFor("chg_approved_2");
  // Opened from the timeline, the edit shows in its list: the one "1 needs you" opens, so that is the link lit.
  const strip = container.querySelector<HTMLElement>(".simple-timeline-hover")!;
  strip.getBoundingClientRect = () => ({ left: 0, width: 1000 }) as DOMRect;
  const dot = container.querySelector<HTMLElement>(".simple-timeline-mark")!;
  await act(async () => { strip.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, button: 0, pointerId: 1, clientX: parseFloat(dot.style.left) * 10 })); });
  await act(async () => {});
  expect(editPanel()).not.toBeNull();
  expect([turn.querySelector(".simple-edits")?.getAttribute("aria-label"), turn.querySelector(".simple-pass-need")?.getAttribute("aria-pressed"), turn.querySelector(".simple-pass-toggle")])
    .toEqual(["Edits that need you", "true", null]);
});

it("leaves out a pass's link too while each of its edits needs the editor", async () => {
  onlyFlagged();
  data = { ...data, tasks: [...data.tasks, { ...data.tasks.find(t => t.id === "task_done")!, id: "task_pass", kind: "edit" as const,
    instruction: "/dialogue-pass", context: { message: "/dialogue-pass" }, changeIds: ["chg_approved_2"] }] };
  useProjectStore.setState({ current: data });
  await showFolded();
  await act(async () => {});
  const pass = turnFor("chg_approved_2").querySelector<HTMLElement>(".simple-pass")!;
  expect([pass.querySelector(".simple-pass-need")?.textContent, pass.querySelector(".simple-pass-toggle")]).toEqual(["1 needs you", null]);
  await click(pass.querySelector(".simple-pass-need")!);
  await act(async () => {});
  expect([pass.querySelector(".simple-pass-list")?.querySelectorAll("li").length, pass.querySelector(".simple-pass-toggle")]).toEqual([1, null]);
  await press("k");
  await act(async () => {});
  expect([pass.querySelector(".simple-pass-need"), pass.querySelector(".simple-pass-list")]).toEqual([null, null]);
  await click(buttonIn(pass, "See edit")!);
  expect(editPanel()?.querySelector(".edit-card-title")?.textContent).toBe(SUMMARY);
  expect(pass.querySelector('.simple-pass-list [aria-current="true"] .simple-pass-words')?.textContent).toBe("wrap");
  expect(buttonIn(pass, "Close edit")?.getAttribute("aria-current")).toBe("true");
  await press("Escape");
  expect([editPanel(), pass.querySelector(".simple-pass-list"), !!buttonIn(pass, "See edit")]).toEqual([null, null, true]);
});

it("closes the selected edit in one click when only that edit remains in an expanded list", async () => {
  const { lists, earlier } = laterRequest("chg_later", false);
  await showFolded();
  const turn = turnFor("chg_approved_2");
  await click(buttonIn(turn, "See all")!);
  await click(editRows("chg_approved_2")[1]!);
  expect(openTitle()).toBe("captions");
  lists[earlier] = (lists[earlier] as object[]).slice(1, 2);
  await headMoves("ver_only_captions");
  expect(openTitle()).toBe("captions");
  await click(buttonIn(turn, "Close edit")!);
  expect([editPanel(), turn.querySelector(".simple-edits"), !!buttonIn(turn, "See edit")]).toEqual([null, null, true]);
});

/** An applied pass that is not the latest request, with or without a cut that asks for a look, beside a later request with one flagged edit. */
const appliedPass = (flagged: boolean) => {
  earlierRequestOnly(flagged);
  data = { ...data, tasks: [...data.tasks, { ...buildDb().tasks.find(t => t.id === "task_done")!, id: "task_pass", kind: "edit" as const,
    instruction: "/dialogue-pass", context: { message: "/dialogue-pass" }, changeIds: ["chg_approved_2"] }] };
  const later = laterRequest("chg_later", flagged);
  later.lists[threadWith("chg_approved_2").id] = later.lists[later.earlier]!;
  useProjectStore.setState({ current: data });
  return later;
};
const passToggle = () => turnFor("chg_approved_2").querySelector<HTMLElement>(".simple-pass .simple-pass-toggle")!;
const ticks = () => [...container.querySelectorAll<HTMLElement>(".simple-timeline-mark")].map(m => m.classList.contains("is-quiet") ? "tick" : m.dataset.state ?? "dot");

it("shows a settled pass's cuts as faint ticks while its full list is open, and gives a request that arrives meanwhile the timeline once it closes", async () => {
  const later = appliedPass(false);
  await show();
  await act(async () => {});
  expect(ticks()).toEqual([]);
  // Nothing in the pass needs the editor. Its cuts are on the timeline only while its list is open.
  await click(passToggle());
  await act(async () => {});
  expect(ticks()).toEqual(["tick", "tick", "tick"]);
  // A request arrives while the list is open. The list keeps the timeline until it closes.
  await event(d => ({ ...d, changes: [...d.changes, later.change] }));
  await act(async () => {});
  expect(ticks()).toEqual(["tick", "tick", "tick"]);
  await click(passToggle());
  await act(async () => {});
  expect(numbered()).toEqual([["1", "check"]]);
});

it("widens the times of a pass's list once one of its rows is past an hour, so a time never runs into its words", async () => {
  const later = appliedPass(true);
  // A long interview: one of the pass's edits is past the first hour.
  Object.assign((later.lists[later.earlier] as object[])[0]!, { range: { start: 3727, end: 3743 } });
  await withSimpleSheet(async () => {
    await show();
    await act(async () => {});
    await click(passToggle());
    await act(async () => {});
    const list = () => turnFor("chg_approved_2").querySelector<HTMLElement>(".simple-pass-list")!;
    const rows = () => [...list().querySelectorAll<HTMLElement>(":scope > li > button")];
    expect(rows().map(row => row.querySelector(".simple-pass-time")!.firstChild!.textContent)).toEqual(["0:00", "0:11", "1:02:07"]);
    // "1:02:07" is two characters longer than "12:34", about 48px of the time's type against 34px. Every row of the list
    // takes the wider column, so that time, and its amber tint on a row that needs the editor, stay clear of the words,
    // and the words keep one edge down the list.
    expect([list().className, ...rows().map(row => styled(row, "grid-template-columns")[0])])
      .toEqual(["simple-pass-list has-hours", ...Array(3).fill("52px minmax(0, 1fr) auto")]);
    // The list of just the edit that needs the editor has no time past the hour, and keeps the narrow column.
    await click(passToggle());
    await click(turnFor("chg_approved_2").querySelector(".simple-pass-need")!);
    await act(async () => {});
    expect([list().className, rows().length, styled(rows()[0]!, "grid-template-columns")[0]]).toEqual(["simple-pass-list", 1, "38px minmax(0, 1fr) auto"]);
  });
});

it("gives the timeline back to a pass's open list when another request's edit closes, and to the latest request when the list closes", async () => {
  const later = appliedPass(true);
  data = { ...data, changes: [...data.changes, later.change] };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  await click(passToggle());
  await act(async () => {});
  expect(ticks()).toEqual(["tick", "tick", "check"]);
  // The other request has an edit to check of its own. With the pass's list still open, its cuts come back all the same.
  await click(turnFor("chg_later").querySelector(".simple-pass-need")!);
  await act(async () => {});
  expect(openTitle()).toBe("outro fade");
  await press("Escape");
  await act(async () => {});
  expect(ticks()).toEqual(["tick", "tick", "check"]);
  // A third request's edit lands while the list is open. When the list closes the timeline is on it.
  const third = { ...later.change, id: "chg_third", description: "Lower the music", createdAt: new Date(Date.now() + 1000).toISOString() };
  later.lists.chg_third = [{ changeId: "chg_third", spot: 0, label: "music level", range: { start: 5, end: 9 }, previous: [], check: "It may be too quiet now" }];
  await event(d => ({ ...d, changes: [...d.changes, third] }));
  await act(async () => {});
  expect(ticks()).toEqual(["tick", "tick", "check"]);
  await click(passToggle());
  await act(async () => {});
  expect(numbered()).toEqual([["1", "check"]]);
  expect(container.querySelector(".simple-timeline-mark.is-numbered")?.getAttribute("style")).toContain("31.25%");
});

it("waits for the pass's cut list before applying it, so skipped footage stays in", async () => {
  flagged();
  // Both calls were made in an earlier session, so the pass goes in by itself, but not before its cut list arrives.
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, cutChoices: [
    { index: 1, start: 230, end: 233, choice: "cut" as const }, { index: 2, start: 598, end: 602.5, choice: "keep" as const }] } : c) };
  let loaded!: () => void;
  const review = { cuts: [0, 1, 2].map(i => ({ at: i, removed: { start: i, end: i + 1 }, beforeClip: 0 })),
    original: data.timeline!, proposed: data.timeline!, firstCut: false };
  vi.spyOn(api, "cutReview").mockReturnValue(new Promise(resolve => { loaded = () => resolve({ review }); }));
  const approve = vi.fn().mockResolvedValue({ outcome: "applied" });
  useProjectStore.setState({ current: data, approve });
  await show();
  await act(async () => {});
  expect(approve).not.toHaveBeenCalled();
  expect(passCard().querySelector('[role="alert"]')).toBeNull();
  await act(async () => loaded());
  await act(async () => {});
  expect(approve.mock.calls).toEqual([["chg_ready", undefined, [2]]]);
});

it("applies a pass once its calls are all made, though a cut it already applied still asks for a look", async () => {
  flagged();
  // The pass applied the part it was sure of, and one cut there asks for a look. Both its calls were made in an earlier
  // session, and it hasn't been applied.
  const ready = { ...data.changes.find(c => c.id === "chg_ready")!, intent: "suggestion" as const, taskId: "task_done", cutChoices: [
    { index: 1, start: 230, end: 233, choice: "cut" as const }, { index: 2, start: 598, end: 602.5, choice: "keep" as const }] };
  const part = { ...ready, id: "chg_part", intent: "requested" as const, state: "approved" as const, cutAssessments: undefined, cutChoices: undefined,
    cutReasons: [{ start: 4, end: 5, reason: "An um." }], createdAt: new Date(Date.parse(ready.createdAt!) - 60_000).toISOString() };
  data = { ...data, changes: data.changes.flatMap(c => c.id === "chg_ready" ? [part, ready] : [c]),
    tasks: data.tasks.map(t => t.id === "task_done" ? { ...t, instruction: "/dialogue-pass", context: { message: "/dialogue-pass" }, changeIds: [part.id, ...t.changeIds] } : t) };
  const approve = vi.fn().mockResolvedValue({ outcome: "applied" });
  useProjectStore.setState({ current: data, approve });
  const passThread = threadWith("chg_ready").id;
  vi.spyOn(api, "threadEdits").mockImplementation(async (_project, threadId) => ({ version: data.project.head!, edits: threadId !== passThread ? []
    : [{ changeId: "chg_part", spot: 0, label: "An um.", range: { start: 4, end: 5 }, previous: [], check: CHECK }] }));
  await show();
  await act(async () => {});
  // The applied cut is what needs the editor. The calls are made, so the pass goes in by itself: only its calls hold it.
  expect(approve.mock.calls).toEqual([["chg_ready", undefined, [2]]]);
});

it("holds back the cuts a running pass hasn't checked, and applies the calls it asked for the moment it finishes", async () => {
  const save = flagged();
  // Scarlet has checked one cut so far and asks about it. The other two are staged but not checked yet. They are still
  // Scarlet's to check, and it settles most itself, so they aren't calls: listed now, they would be gone a moment later.
  data = { ...data,
    changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, intent: "suggestion" as const, taskId: "task_done",
      cutReasons: [0, 1, 2].map(i => ({ start: i, end: i + 1, reason: ["A clean retake.", "Breath before the price.", "Repeated aside."][i]! })),
      cutAssessments: [{ index: 1, start: 230, end: 233, verdict: "ask" as const, reason: "Breath before the price." }],
      cutChoices: [{ index: 0, start: 0, end: 1, choice: "cut" as const }] } : c),
    tasks: data.tasks.map(t => t.id === "task_done" ? { ...t, state: "running" as const, finishedAt: undefined,
      startedAt: new Date(Date.now() - 60_000).toISOString(), expectedSeconds: 660 } : t) };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("1 needs you");
  await reviewCalls();
  expect(container.querySelector(".simple-on-video")?.textContent).toBe("Showing cut at 3:50 · 1 of 1 · After");
  expect(call().querySelector(".edit-card-title")?.textContent).toBe("Breath before the price.");
  // Scarlet is still checking, so the last call schedules the pass to apply the moment it finishes.
  await press("a");
  expect(save).toHaveBeenLastCalledWith("chg_ready", expect.objectContaining({
    choices: [{ index: 0, choice: "cut" }, { index: 1, choice: "cut" }], applyWhenDone: true }));
  expect(container.querySelector('[aria-label="Call"]')).toBeNull();
  // It says so, with no guess at how long that will be: the chat carries no time. It is a status, not a button: there
  // is nothing to press and no way to hold the pass back.
  expect(passCard().querySelector(".simple-pass-ok")?.textContent).toBe("Goes in when Scarlet finishes");
  expect(passCard().querySelector(".simple-pass-line")?.querySelectorAll("button").length).toBe(0);
  // Going back to change that call keeps the schedule: the pass still goes in when Scarlet finishes, with the new call.
  await click(passRows().find(r => r.textContent?.includes("Breath before the price."))!);
  await press("s");
  expect(save).toHaveBeenLastCalledWith("chg_ready", expect.objectContaining({
    choices: [{ index: 0, choice: "cut" }, { index: 1, choice: "keep" }], applyWhenDone: true }));
  expect(passCard().textContent).toContain("Goes in when Scarlet finishes");
  // Scarlet then asks about another cut. The engine takes the schedule back, and the line follows it: the pass waits
  // for the editor again instead of going on saying it applies by itself.
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_ready" ? { ...c, applyWhenDone: undefined, cutAssessments: [...c.cutAssessments!,
    { index: 2, start: 598, end: 602.5, verdict: "ask" as const, reason: "The corrected image-input take belongs here." }] } : c) }));
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("1 needs you");
  expect(passCard().textContent).not.toContain("Goes in when Scarlet finishes");
});

it("doesn't send a pass's old schedule along with a call once its run has stopped", async () => {
  const save = flagged();
  // The pass was set to apply when Scarlet finished. Its run was then stopped, so its calls are the editor's to make.
  data = { ...data,
    changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, intent: "suggestion" as const, taskId: "task_done",
      applyWhenDone: { userId: "usr_editor", at: new Date().toISOString() } } : c),
    tasks: data.tasks.map(t => t.id === "task_done" ? { ...t, state: "cancelled" as const } : t) };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  await reviewCalls();
  await press("a");
  // The first of two calls: saved, with no schedule that would apply the pass over the second.
  expect(save).toHaveBeenLastCalledWith("chg_ready", expect.objectContaining({ applyWhenDone: false }));
  expect(call()).not.toBeNull();
});

it("keeps a call whose save is still on its way when an earlier save fails, and says the save failed", async () => {
  flagged();
  // Three calls, so two can be made without the last one applying the pass.
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, cutAssessments: c.cutAssessments!.map(a => ({ ...a, verdict: "ask" as const })) } : c) };
  useProjectStore.setState({ current: data });
  const saves: { land(): void; fail(reason: string): void }[] = [];
  vi.spyOn(api, "saveCutChoices").mockImplementation((id, body) => new Promise((resolve, reject) => saves.push({
    land: () => resolve(savedCalls(id, body)), fail: reason => reject(new Error(reason)) })));
  await show();
  await act(async () => {});
  const need = () => passCard().querySelector(".simple-pass-need")?.textContent;
  expect(need()).toBe("3 need you");
  await reviewCalls();
  await press("a");
  await press("a");
  expect(saves).toHaveLength(2);
  expect(need()).toBe("1 needs you");
  // The first save fails after the second went out. The second carries both calls and may still land: they stay made.
  await act(async () => saves[0]!.fail("The engine is busy."));
  expect(need()).toBe("1 needs you");
  // The failure is said on the pass's line and on the open call's card.
  expect(passCard().querySelector(".simple-error")?.textContent).toBe("The engine is busy.");
  expect(call().querySelector('[role="alert"]')?.textContent).toBe("The engine is busy.");
  // A save that fails with none sent since gives its calls back to the editor: nothing was saved.
  await act(async () => saves[1]!.fail("Still busy."));
  expect(need()).toBe("3 need you");
  expect(passCard().querySelector(".simple-error")?.textContent).toBe("Still busy.");
  // Made again, the first save fails once more, and this time the second lands with both calls. Nothing was lost,
  // so the line that said a save failed goes.
  await press("a");
  await press("a");
  expect(saves).toHaveLength(4);
  await act(async () => saves[2]!.fail("Busy again."));
  expect(passCard().querySelector(".simple-error")?.textContent).toBe("Busy again.");
  await act(async () => saves[3]!.land());
  expect(need()).toBe("1 needs you");
  expect(passCard().querySelector(".simple-error")).toBeNull();
  expect(call().querySelector('[role="alert"]')).toBeNull();
});

type Staged = { start: number; end: number; reason: string };
const ripples = (cuts: readonly Staged[]) => [...cuts].reverse().map(r => ({ op: "rippleDelete" as const, start: r.start, end: r.end }));
const STAGED: Staged[] = [{ start: 2, end: 3, reason: "A clean retake." }, { start: 6, end: 7, reason: "Breath before the price." }, { start: 11, end: 12, reason: "Repeated aside." }];
/** Scarlet's note on every cut a pass lists, each one a call: it has checked them and asks the editor about each. */
const askAll = (cuts: readonly Staged[]) => {
  const listed: Staged[] = [];
  for (const cut of [...cuts].sort((x, y) => x.start - y.start)) {
    const last = listed.at(-1);
    if (last && cut.start <= last.end) { last.end = Math.max(last.end, cut.end); last.reason += ` ${cut.reason}`; }
    else listed.push({ ...cut });
  }
  return listed.map((cut, index) => ({ index, start: cut.start, end: cut.end, verdict: "ask" as const, reason: cut.reason }));
};
/**
 * A pass still running that Scarlet has checked so far, with its staged cuts as the engine saves and lists them, each
 * one a call. The cut list comes from the engine's own planner, so staged cuts that touch are one cut there. `hold`
 * keeps a proposal's list from arriving until `release`.
 */
const runningPass = (cuts: Staged[] = STAGED) => {
  data = { ...data,
    changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, intent: "suggestion" as const, taskId: "task_done", cutReasons: cuts,
      cutAssessments: askAll(cuts) } : c),
    tasks: data.tasks.map(t => t.id === "task_done" ? { ...t, state: "running" as const, finishedAt: undefined,
      startedAt: new Date(Date.now() - 60_000).toISOString() } : t) };
  useProjectStore.setState({ current: data });
  const stored = (id: string) => useProjectStore.getState().current!.changes.find(c => c.id === id)!;
  const initial = data.timeline!;
  vi.spyOn(api, "cutReviewDraft").mockImplementation(async (id, restored, head) => {
    const change = stored(id), current = useProjectStore.getState().current!, working = current.timeline!;
    const cuts = askAll(change.cutReasons!);
    const call = cuts.find(c => !restored.includes(c.index))!;
    const onto = change.fromVersion !== head && head !== initial.version
      ? { map: makeTimeMap(initial, working, current.project.settings.fps), timeline: working } : undefined;
    const range = cutOnWorkingCut(call, onto, current.project.settings.fps)!;
    const draft = { ...applyOps(working, [{ op: "rippleDelete", start: range.start, end: range.end }]), version: `only-${id}-${call.index}-${head}` };
    return { draft, ontoVersion: head, removed: [{ start: range.start, end: range.end }] };
  });
  let held: string | undefined;
  let arrive = () => {};
  vi.spyOn(api, "cutReview").mockImplementation(async id => {
    if (id === held) await new Promise<void>(resolve => { arrive = resolve; });
    const change = stored(id), base = useProjectStore.getState().current!.timeline!;
    const ops = ripples(change.cutReasons!);
    return { review: planCutReview(base, { ...applyOps(base, ops), version: change.toVersion }, data.media, ops) };
  });
  return { save: vi.spyOn(api, "saveCutChoices").mockImplementation(async (id, body) => savedCalls(id, body)),
    hold: (id: string) => { held = id; }, release: () => act(async () => { held = undefined; arrive(); }) };
};
/**
 * The pass saves its next part, one event at a time as the engine reports it. Confident cuts apply first and move the
 * edit on. Then the new proposal arrives, at first without the notes carried onto it. Last, the proposal it takes the
 * place of is marked.
 */
const event = (apply: (d: ProjectData) => ProjectData) => act(async () => { data = apply(useProjectStore.getState().current!); useProjectStore.setState({ current: data }); });
const nextPart = async (over: Partial<ProjectData["changes"][number]>, applied?: Staged[]) => {
  const old = data.changes.find(c => c.id === "chg_ready")!;
  if (applied) {
    const part = { ...old, id: "chg_part2_applied", intent: "requested" as const, appliedOnto: old.fromVersion, toVersion: "ver_part2", appliedVersion: "ver_part2",
      cutReasons: applied, cutAssessments: undefined, createdAt: new Date().toISOString() };
    await event(d => ({ ...d, changes: [...d.changes, part] }));
    await event(d => ({ ...d, changes: d.changes.map(c => c.id === part.id ? { ...part, state: "approved" as const } : c) }));
    await event(d => ({ ...d, project: { ...d.project, head: "ver_part2" } }));
  }
  // Scarlet's notes carry onto the new proposal, and it asks about the cuts this part staged too, unless the test says otherwise.
  const next = { ...old, id: "chg_ready_part2", toVersion: "ver_part2_review", createdAt: new Date().toISOString(), ...(applied && { fromVersion: "ver_part2" }),
    ...(over.cutReasons && { cutAssessments: askAll(over.cutReasons) }), ...over };
  await event(d => ({ ...d, changes: [...d.changes, { ...next, cutAssessments: undefined }],
    tasks: d.tasks.map(t => t.id === "task_done" ? { ...t, changeIds: [...t.changeIds, next.id] } : t) }));
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === next.id ? next : c) }));
  await event(d => ({ ...d, changes: d.changes.map(c => c.id !== old.id ? c : { ...old, state: "rejected" as const, rejectedFrom: "ready" as const,
    rejectReason: "Carried into a later part of the same dialogue pass.", replacedBy: next.id }) }));
  // The window fetches the working cut once it hears the head moved, so the new timeline arrives after the events.
  if (applied) await event(d => ({ ...d, timeline: { ...applyOps(d.timeline!, ripples(applied)), version: "ver_part2" } }));
};
/** Two staged cuts that share an edge. The pass lists them as one cut. */
const PAIR: Staged[] = [{ start: 2, end: 3, reason: "An um." }, { start: 3, end: 4, reason: "A false start." }];
/** Open one call by Scarlet's note on it, from the pass's full list: "N need you" would open the first call that waits. */
const openCall = async (reason: string) => {
  if (!passCard().querySelector(".simple-pass-list")) await click(passCard().querySelector(".simple-pass-toggle")!);
  await click(passRows().find(r => r.textContent?.includes(reason))!);
};
const onVideo = () => container.querySelector(".simple-on-video")?.textContent;

it("appends published calls while holding back provisional notes and keeps the open row through a new proposal", async () => {
  const { save } = runningPass();
  const [early, middle, late] = askAll(STAGED);
  const provisional = { ...early!, reason: "Edges still being checked.", provisional: true as const };
  const update = (cutAssessments: NonNullable<ProjectData["changes"][number]["cutAssessments"]>) =>
    event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_ready" ? { ...c, cutAssessments } : c) }));
  await update([provisional, { ...middle!, verdict: "keep" }]);
  await showFolded();
  expect(passRows()).toHaveLength(0);
  expect(container.querySelector(".simple-timeline-mark.is-numbered")).toBeNull();
  expect(passCard().querySelector(".simple-pass-need")).toBeNull();
  expect(buttonIn(passCard(), "Apply when Scarlet finishes")).toBeUndefined();
  await press("ArrowDown");
  expect(call()).toBeNull();

  await update([provisional, { ...late!, askOrder: 1 }]);
  expect(container.querySelectorAll(".simple-timeline-mark.is-numbered")).toHaveLength(1);
  await reviewCalls();
  const card = call(), first = passRows()[0];
  expect(first?.textContent).toBe(`1${late!.reason}`);
  await update([{ ...early!, verdict: "keep" }, { ...middle!, askOrder: 2 }, { ...late!, askOrder: 1 }]);
  expect(passRows().map(r => r.textContent)).toEqual([`1${late!.reason}`, `2${middle!.reason}`]);
  expect(passRows()[0]).toBe(first);
  expect(call()).toBe(card);
  expect(passCard().textContent).not.toContain(provisional.reason);

  // This part follows an ordinary timeline change. Its earlier clock cannot be found by adding up dialogue cuts.
  const changed = STAGED.slice(1).map(r => ({ ...r, start: r.start - 1, end: r.end - 1 }));
  const [second, carried] = askAll(changed);
  await nextPart({ fromVersion: "changed_by_an_ordinary_edit", cutReasons: changed,
    cutAssessments: [{ ...second!, askOrder: 2 }, { ...carried!, askOrder: 1 }] });
  expect(passRows()[0]).toBe(first);
  expect(call()).toBe(card);
  expect(call().querySelector(".edit-card-count")?.textContent).toBe("Cut 1");
  await press("s");
  expect(save).toHaveBeenLastCalledWith("chg_ready_part2", expect.objectContaining({ choices: [{ index: 1, choice: "keep" }] }));
  expect(call().querySelector(".edit-card-title")?.textContent).toBe(middle!.reason);
  // The returned cut can be settled by a scoped revision. Keep its row, number and decision when its verdict follows.
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_ready_part2" ? { ...c,
    cutAssessments: c.cutAssessments!.map(a => a.index === 1 ? { ...a, verdict: "keep" } : a) } : c) }));
  expect(passRows()[0]).toBe(first);
  expect(passRows().map(r => r.textContent)).toEqual([`1${late!.reason}Skipped`, `2${middle!.reason}`]);
  expect(call().querySelector(".edit-card-count")?.textContent).toBe("Cut 2");
});

it("keeps a newly published call when an earlier decision's HTTP response arrives after the project event", async () => {
  const { save } = runningPass();
  const asks = askAll(STAGED).map((ask, index) => ({ ...ask, askOrder: index + 1 }));
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_ready" ? { ...c, cutAssessments: asks.slice(0, 2) } : c) }));
  let respond!: () => void;
  let saved!: ReturnType<typeof savedCalls>;
  save.mockImplementationOnce((id, body) => {
    saved = savedCalls(id, body);
    return new Promise(resolve => { respond = () => resolve(saved); });
  });
  await showFolded();
  await reviewCalls();
  await press("s");
  // The decision reached the engine. Its next assessment event includes that decision and a third published call;
  // assessment writes on older engines keep the last decision's timestamp.
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === saved.change.id ? { ...saved.change, cutAssessments: asks } : c) }));
  const third = passRows()[2];
  const card = call();
  expect(third?.textContent).toBe(`3${asks[2]!.reason}`);
  await act(async () => respond());
  expect(passRows()[2]).toBe(third);
  expect(call()).toBe(card);
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("2 need you");
  expect(passRows()[0]?.textContent).toBe(`1${asks[0]!.reason}Skipped`);
});

it.each(["done", "failed", "cancelled"] as const)("hands provisional and unchecked cuts to the editor when the producer is %s", async state => {
  runningPass();
  const [early, , late] = askAll(STAGED);
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_ready"
    ? { ...c, cutAssessments: [{ ...early!, provisional: true }, { ...late!, askOrder: 1 }] } : c) }));
  await showFolded();
  expect(passRows().map(r => r.textContent)).toEqual([`1${late!.reason}`]);
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_done" ? { ...t, state } : t) }));
  expect(passRows().map(r => r.textContent)).toEqual([`1${late!.reason}`, `2${early!.reason}`, `3${STAGED[1]!.reason}`]);
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("3 need you");
  await click(passRows()[1]!);
  expect(call().querySelector(".edit-card-title")?.textContent).toBe(`Not checked yet. ${early!.reason}`);
  expect(buttonIn(passCard(), "Apply")).toBeUndefined();
});

it.each(["saved", "another call", "unchecked part", "failed"] as const)("uses the last call's save before applying a pass (%s)", async outcome => {
  const { save } = runningPass([STAGED[2]!]);
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_done" ? { ...t, state: "done" as const } : t) }));
  const approve = vi.fn().mockResolvedValue({ outcome: "applied" });
  useProjectStore.setState({ approve });
  let finish!: (result: Awaited<ReturnType<typeof api.saveCutChoices>>) => void;
  let fail!: (error: Error) => void;
  save.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  await show();
  await reviewCalls();
  await press("s");
  expect(save).toHaveBeenCalledWith("chg_ready", expect.objectContaining({ choices: [{ index: 0, choice: "keep" }] }));
  expect(approve).not.toHaveBeenCalled();
  if (outcome === "failed") {
    await act(async () => fail(new Error("Couldn’t save this call.")));
    expect(approve).not.toHaveBeenCalled();
    expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("1 needs you");
    expect(passCard().querySelector('[role="alert"]')?.textContent).toBe("Couldn’t save this call.");
    return;
  }
  // The call just skipped is now the third. The engine also preserved a different skip on the first cut.
  await nextPart({ cutReasons: STAGED, ...(outcome === "unchecked part" && { cutAssessments: askAll(STAGED).filter(a => a.index !== 1) }) });
  const choices = [{ index: 0, choice: "keep" as const }, { index: 2, choice: "keep" as const }];
  const decided = outcome === "saved" ? [...choices, { index: 1, choice: "cut" as const }] : choices;
  await act(async () => finish(savedCalls("chg_ready_part2", { choices: decided, fromVersion: "ver_base", toVersion: "ver_part2_review" })));
  if (outcome !== "saved") {
    expect(approve).not.toHaveBeenCalled();
    if (outcome === "unchecked part")
      await event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_ready_part2" ? { ...c, cutAssessments: askAll(STAGED) } : c) }));
    expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("1 needs you");
    await reviewCalls();
    expect(call().querySelector(".edit-card-title")?.textContent).toBe(STAGED[1]!.reason);
  } else {
    expect(approve.mock.calls).toEqual([["chg_ready_part2", undefined, [0, 2]]]);
  }
});

it("keeps the call on screen on its cut when the pass saves its next part", async () => {
  const { save, hold, release } = runningPass();
  const listen = vi.spyOn(player, "audition");
  await show();
  await act(async () => {});
  await openCall("Repeated aside.");
  expect(onVideo()).toBe("Showing cut at 0:11 · 3 of 3 · After");
  expect(listen).toHaveBeenLastCalledWith({ start: 9, end: 15, skips: [{ start: 11, end: 12, removed: true }] }, expect.any(Number));
  const listens = listen.mock.calls.length;
  // The editor opens the call's transcript in the chat to read the passage.
  const card = call();
  const script = () => transcriptLink();
  await click(script());
  expect(script().getAttribute("aria-expanded")).toBe("true");
  // The next part stages one more cut ahead of it and comes back as a new proposal. The card stays on its cut, now the
  // fourth, before the new proposal's cut list has even arrived, and the listen isn't started again.
  hold("chg_ready_part2");
  await nextPart({ cutReasons: [STAGED[0]!, STAGED[1]!, { start: 8.5, end: 9.5, reason: "A second try at the line." }, STAGED[2]!] });
  expect(call().querySelector(".edit-card-title")?.textContent).toBe("Repeated aside.");
  expect(onVideo()).toBe("Showing cut at 0:11 · 4 of 4 · After");
  await release();
  expect(onVideo()).toBe("Showing cut at 0:11 · 4 of 4 · After");
  expect(listen).toHaveBeenCalledTimes(listens);
  // It is the same card throughout, and its transcript is still open on the passage.
  expect(call()).toBe(card);
  expect(script().getAttribute("aria-expanded")).toBe("true");
  expect(openHead()!.querySelector(".edit-passage")).not.toBeNull();
  // Revise, Skip and Approve still mean that cut, in the proposal that's waiting now.
  await press("r");
  expect(container.querySelector(".simple-target")?.textContent).toContain("Revising the cut at 0:11");
  expect(useUiStore.getState().agentContext).toMatchObject({ changeId: "chg_ready_part2", cutIndex: 3, time: 11, end: 12 });
  await press("s");
  expect(save).toHaveBeenLastCalledWith("chg_ready_part2", expect.objectContaining({ choices: [{ index: 3, choice: "keep" }] }));
  // The next call opens folded again.
  expect(onVideo()).toBe("Showing cut at 0:02 · 1 of 4 · After");
  expect(script().getAttribute("aria-expanded")).toBe("false");
  expect(openHead()!.querySelector(".edit-passage")).toBeNull();
});

it("makes a call while the new proposal's cut list is still on its way", async () => {
  const { save, hold } = runningPass();
  await show();
  await act(async () => {});
  await openCall("Repeated aside.");
  hold("chg_ready_part2");
  await nextPart({ cutReasons: [STAGED[0]!, STAGED[1]!, { start: 8.5, end: 9.5, reason: "A second try at the line." }, STAGED[2]!] });
  expect([passCard().querySelector(".simple-pass-need")?.textContent, passRows().length]).toEqual(["4 need you", 4]);
  await press("s");
  expect(save).toHaveBeenLastCalledWith("chg_ready_part2", expect.objectContaining({ choices: [{ index: 3, choice: "keep" }] }));
  expect(onVideo()).toBe("Showing cut at 0:02 · 1 of 4 · After");
});

it("counts a pass's cuts as its review will while the cut list is still on its way", async () => {
  const { hold, release } = runningPass([...PAIR, STAGED[2]!]);
  hold("chg_ready");
  await show();
  await act(async () => {});
  // Three staged cuts, two of which touch: two cuts, before the list says so and after.
  expect([passCard().querySelector(".simple-pass-need")?.textContent, passRows().length]).toEqual(["2 need you", 2]);
  await release();
  expect([passCard().querySelector(".simple-pass-need")?.textContent, passRows().length]).toEqual(["2 need you", 2]);
});

it("holds After until the pass's cut list is in or has failed, and plays Before meanwhile", async () => {
  runningPass();
  const listen = vi.spyOn(player, "audition");
  let fail = (_: Error) => {};
  vi.spyOn(api, "cutReview").mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  await show();
  await act(async () => {});
  await openCall("Repeated aside.");
  // After would change players once the list arrives, so it waits. Before needs nothing from the list.
  expect(listen).not.toHaveBeenCalled();
  await press("\\");
  expect(listen).toHaveBeenLastCalledWith({ start: 9, end: 14, skips: [] }, expect.any(Number));
  await press("\\");
  expect(listen).toHaveBeenCalledTimes(1);
  // The list can't be had. After plays by stepping over the cut.
  await act(async () => fail(new Error("Engine unreachable")));
  expect(listen).toHaveBeenLastCalledWith({ start: 9, end: 15, skips: [{ start: 11, end: 12, removed: true }] }, expect.any(Number));
});

it("plays a call of a pass that has no cut list of its own", async () => {
  runningPass();
  const listen = vi.spyOn(player, "audition");
  vi.spyOn(api, "cutReview").mockResolvedValue({ review: null });
  await show();
  await act(async () => {});
  // Without a list only the cut Scarlet asked about is a call.
  await openCall("Breath before the price.");
  expect(listen).toHaveBeenLastCalledWith({ start: 4, end: 10, skips: [{ start: 6, end: 7, removed: true }] }, expect.any(Number));
});

it("keeps the other calls' dots on the timeline while a call is open, so one press reaches the next", async () => {
  runningPass();
  zoomAtOnce();
  await show();
  await act(async () => {});
  const dots = () => [...container.querySelectorAll<HTMLElement>(".simple-timeline-mark.is-numbered")];
  const numbers = () => dots().map(d => d.querySelector(".simple-timeline-number")?.textContent);
  expect(numbers()).toEqual(["1", "2", "3"]);
  // The open call's band says where it is, so its own dot goes. The calls still waiting that are in view keep theirs.
  await openCall("Breath before the price.");
  expect(container.querySelector(".simple-timeline-band")).not.toBeNull();
  expect(numbers()).toEqual(["1", "3"]);
  expect(dots().map(d => d.dataset.state)).toEqual(["check", "check"]);
  // A press on one opens that call in the card, and the timeline zooms to it.
  const strip = container.querySelector<HTMLElement>(".simple-timeline-hover")!;
  strip.getBoundingClientRect = () => ({ left: 0, width: 1000 }) as DOMRect;
  await act(async () => { strip.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, button: 0, pointerId: 1, clientX: parseFloat(dots()[1]!.style.left) * 10 })); });
  await act(async () => {});
  expect(onVideo()).toBe("Showing cut at 0:11 · 3 of 3 · After");
  expect(numbers()).toEqual(["2"]);
  // Zoomed out to the whole video (0), the other calls are there to see and to press without closing this one.
  await press("0");
  expect(call()).not.toBeNull();
  expect(numbers()).toEqual(["1", "2"]);
});

it("plays a call's cut footage from a click inside its passage on the timeline", async () => {
  runningPass();
  const listen = vi.spyOn(player, "audition");
  vi.spyOn(api, "cutReview").mockResolvedValue({ review: null });
  await show();
  await act(async () => {});
  await openCall("Breath before the price.");
  const band = () => container.querySelector<HTMLElement>(".simple-timeline-band")!;
  // After steps over the cut, so its passage takes a click.
  expect(beforeIcon(call())).toEqual(["", "Before", "false", "Play Before (\\)"]);
  expect(band().classList.contains("is-live")).toBe(true);
  // Without layout the click lands on the passage's first frame. Before plays from there, and its icon lights with a flash.
  await act(async () => { band().dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, isPrimary: true, button: 0, bubbles: true })); });
  expect(listen).toHaveBeenLastCalledWith({ start: 4, end: 9, skips: [], from: 6 }, expect.any(Number));
  expect(usePlayerStore.getState().scrubGesture).toBeUndefined();
  expect(beforeIcon(call())).toEqual(["", "Before", "true", "Back to After (\\)"]);
  expect(call().querySelector(".edit-card-before.is-flash")).not.toBeNull();
  // On Before the passage plays, and scrubs as any footage.
  expect(band().classList.contains("is-live")).toBe(false);
  // The icon goes back to how the video would run, from the top of the listen.
  await click(call().querySelector(".edit-card-before")!);
  expect(listen).toHaveBeenLastCalledWith({ start: 4, end: 10, skips: [{ start: 6, end: 7, removed: true }] }, expect.any(Number));
  expect(beforeIcon(call())).toEqual(["", "Before", "false", "Play Before (\\)"]);
  expect(call().querySelector(".edit-card-before.is-flash")).toBeNull();
  // Lit again by a click in the passage, then its row in the chat pressed again: the card stays, and the cut plays from
  // the top as the video runs, unlit.
  await act(async () => { band().dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, isPrimary: true, button: 0, bubbles: true })); });
  expect(beforeIcon(call())?.[2]).toBe("true");
  const listens = listen.mock.calls.length;
  await click(passRows().find(r => r.textContent?.includes("Breath before the price."))!);
  expect(beforeIcon(call())).toEqual(["", "Before", "false", "Play Before (\\)"]);
  expect(listen.mock.calls.length).toBe(listens + 1);
  expect(listen).toHaveBeenLastCalledWith({ start: 4, end: 10, skips: [{ start: 6, end: 7, removed: true }] }, expect.any(Number));
});

it("plays just the selected call when another is within earshot and keeps playing when the pass saves a part", async () => {
  const cuts = [STAGED[0]!, STAGED[1]!, { start: 8.5, end: 9.5, reason: "A second try at the line." }, STAGED[2]!];
  const { hold, release } = runningPass(cuts);
  const listen = vi.spyOn(player, "audition");
  const ended = vi.fn();
  listen.mockImplementation(() => ended);
  await show();
  await act(async () => {});
  await openCall("Breath before the price.");
  expect(listen).toHaveBeenLastCalledWith({ start: 4, end: 10, skips: [{ start: 6, end: 7, removed: true }] }, expect.any(Number));
  expect(listen).toHaveBeenCalledTimes(1);
  expect(api.cutReviewDraft).toHaveBeenCalledWith("chg_ready", [0, 2, 3], data.timeline!.version, expect.any(AbortSignal));
  expect(player.mediaTime(6.5)).toBe(6);
  expect(player.mediaTime(9.5)).toBe(8.5);
  hold("chg_ready_part2");
  await nextPart({ cutReasons: [...cuts, { start: 14, end: 15, reason: "A cough." }] });
  await release();
  expect(onVideo()).toBe("Showing cut at 0:06 · 2 of 5 · After");
  expect(listen).toHaveBeenCalledTimes(1);
  expect(ended).not.toHaveBeenCalled();
});

it("numbers a call as the pass's cut list does when staged cuts touch", async () => {
  // Two of the four staged ranges share an edge, so the pass lists three cuts.
  const { save, hold, release } = runningPass([...PAIR, STAGED[1]!, STAGED[2]!]);
  await show();
  await act(async () => {});
  await openCall("Repeated aside.");
  expect(onVideo()).toBe("Showing cut at 0:11 · 3 of 3 · After");
  hold("chg_ready_part2");
  await nextPart({ cutReasons: [...PAIR, STAGED[1]!, { start: 8.5, end: 9.5, reason: "A second try at the line." }, STAGED[2]!] });
  // The card is still on the aside, the fourth cut of four, before the new cut list arrives and after.
  expect(call().querySelector(".edit-card-title")?.textContent).toBe("Repeated aside.");
  expect(onVideo()).toBe("Showing cut at 0:11 · 4 of 4 · After");
  await release();
  expect(call().querySelector(".edit-card-title")?.textContent).toBe("Repeated aside.");
  expect(onVideo()).toBe("Showing cut at 0:11 · 4 of 4 · After");
  // Approve approves that cut and no other.
  await press("a");
  expect(save).toHaveBeenLastCalledWith("chg_ready_part2", expect.objectContaining({ choices: [{ index: 3, choice: "cut" }] }));
});

it("keeps staged cuts a frame apart as two cuts while the cut list is on its way", async () => {
  const frame = 1 / data.project.settings.fps;
  const { hold } = runningPass([{ start: 2, end: 3, reason: "An um." }, { start: 3 + frame, end: 4, reason: "A false start." }, STAGED[1]!, STAGED[2]!]);
  hold("chg_ready");
  await show();
  await act(async () => {});
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("4 need you");
});

it("follows the call's cut, and a revision aimed at it, when the next part's confident cuts move it earlier", async () => {
  const { save, hold, release } = runningPass();
  const listen = vi.spyOn(player, "audition");
  await show();
  await act(async () => {});
  await openCall("Repeated aside.");
  await press("r");
  expect(container.querySelector(".simple-target")?.textContent).toContain("Revising the cut at 0:11");
  const aimedBefore = useUiStore.getState().agentContext;
  const listens = listen.mock.calls.length;
  // The next part applies a 1.5 s cut ahead of the call and another after it. On the new version the staged cuts
  // past the first sit 1.5 s earlier; the cut after the call doesn't move it.
  hold("chg_ready_part2");
  await nextPart({ cutReasons: [STAGED[0]!, { ...STAGED[1]!, start: 4.5, end: 5.5 }, { ...STAGED[2]!, start: 9.5, end: 10.5 }] },
    [{ start: 4, end: 5.5, reason: "Dead air." }, { start: 13, end: 14, reason: "A cough." }]);
  expect(call().querySelector(".edit-card-title")?.textContent).toBe("Repeated aside.");
  expect(onVideo()).toBe("Showing cut at 0:09 · 3 of 3 · After");
  // The listen waits for the new cut list and then starts once, on the cut where it is now.
  expect(listen).toHaveBeenCalledTimes(listens);
  await release();
  expect(listen).toHaveBeenCalledTimes(listens + 1);
  // The editor didn't choose it again: it is taken up where it is, and stays paused if they paused it.
  expect(listen).toHaveBeenLastCalledWith({ start: 7.5, end: 13.5, skips: [{ start: 9.5, end: 10.5, removed: true }] }, expect.any(Number), true);
  // The message box is still aimed at that cut, where it is now.
  expect(container.querySelector(".simple-target")?.textContent).toContain("Revising the cut at 0:09");
  expect(useUiStore.getState().agentContext).toMatchObject({ changeId: "chg_ready_part2", version: "ver_part2", cutIndex: 2, time: 9.5, end: 10.5 });
  // A message that was already on its way with the target as it was still clears it when it lands.
  const box = useUiStore.getState();
  await act(async () => box.clearSentDraft(box.draftOwner, { agentDraft: box.agentDraft, agentContext: aimedBefore }));
  expect(useUiStore.getState().agentContext).toBeNull();
  await press("a");
  expect(save).toHaveBeenLastCalledWith("chg_ready_part2", expect.objectContaining({ fromVersion: "ver_part2", choices: [{ index: 2, choice: "cut" }] }));
});

it("moves a Before listen once, onto the new working cut, when a part applies a cut ahead of the call", async () => {
  runningPass();
  const listen = vi.spyOn(player, "audition");
  await show();
  await act(async () => {});
  await openCall("Repeated aside.");
  await press("\\");
  expect(listen).toHaveBeenLastCalledWith({ start: 9, end: 14, skips: [] }, expect.any(Number));
  // The editor is a second into the listen.
  await act(async () => usePlayerStore.getState().setTime(10));
  const listens = listen.mock.calls.length;
  // The cut sits 1.5 s earlier on the new version. The listen waits for that working cut instead of playing the old one at the new place.
  await nextPart({ cutReasons: [STAGED[0]!, { ...STAGED[1]!, start: 4.5, end: 5.5 }, { ...STAGED[2]!, start: 9.5, end: 10.5 }] }, [{ start: 4, end: 5.5, reason: "Dead air." }]);
  await act(async () => {});
  expect(onVideo()).toBe("Showing cut at 0:09 · 3 of 3 · Before");
  expect(listen).toHaveBeenCalledTimes(listens + 1);
  expect(listen).toHaveBeenLastCalledWith({ start: 7.5, end: 12.5, skips: [] }, expect.any(Number), true);
  // The playhead is on the footage it was on, which sits 1.5 s earlier too.
  expect(usePlayerStore.getState().time).toBe(8.5);
});

/** Where each waiting call's dot sits on the timeline, in seconds of the working cut. */
const callDots = () => {
  const duration = timelineDuration(useProjectStore.getState().current!.timeline!);
  return [...container.querySelectorAll<HTMLElement>('.simple-timeline-mark[data-state="check"]')].map(d => Math.round(parseFloat(d.style.left) * duration) / 100);
};
/** A request in the pass's own thread (an undo, a revision of an applied cut) changes the edit while the pass's calls wait. The pass stays on its version. */
const workingCutMoves = (start: number, end: number) => event(d => ({ ...d, project: { ...d.project, head: "ver_moved" },
  timeline: { ...applyOps(d.timeline!, [{ op: "rippleDelete" as const, start, end }]), version: "ver_moved" } }));
/**
 * Opens the open call's transcript, and says which footage its words are read from: the recording and the stretch of
 * it that the passage asks other takes for. Nothing when the row only waits, with no timeline to read on.
 */
const callWords = async () => {
  vi.mocked(api.retakes).mockClear();
  await click(call().querySelector(".edit-card-words")!);
  if (!call().querySelector('[aria-label="Words this cut removes"]')) return undefined;
  const [, mediaId, start, end] = vi.mocked(api.retakes).mock.lastCall!;
  return { mediaId, start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 };
};
/** The footage a cut staged on `timeline` takes out, as callWords reports it. */
const footage = (timeline: ProjectData["timeline"], cut: Staged) => {
  const source = cutSource(timeline!, data.media, cut)!;
  return { mediaId: source.mediaId, start: Math.round(source.start * 1000) / 1000, end: Math.round(source.end * 1000) / 1000 };
};
const clickBand = () => act(async () => { container.querySelector<HTMLElement>(".simple-timeline-band")!
  .dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, isPrimary: true, button: 0, bubbles: true })); });

it("places a staged cut on the working cut by its footage, as the engine carries it, or not at all", () => {
  const cut = { start: 6, end: 7 };
  const onto = (map: TimeMap) => ({ map, timeline: data.timeline! });
  // The working cut is the pass's version: the cut is where it was staged.
  expect(cutOnWorkingCut(cut, undefined, 30)).toBe(cut);
  // Its start is read as the footage that begins there and its end as the footage that ends there.
  expect(cutOnWorkingCut(cut, onto((t, side) => t === 6 && side === "right" ? 5 : t === 7 && side === "left" ? 6 : null), 30)).toEqual({ start: 5, end: 6 });
  // An edge whose footage is gone.
  expect(cutOnWorkingCut(cut, onto(t => t === 6 ? null : t), 30)).toBeUndefined();
  expect(cutOnWorkingCut(cut, onto(t => t === 7 ? null : t), 30)).toBeUndefined();
  // Both edges are there and what lies between them isn't what was staged: some of it came out, or footage went back in.
  expect(cutOnWorkingCut(cut, onto(t => t > 6.5 ? t - 0.6 : t), 30)).toBeUndefined();
  expect(cutOnWorkingCut(cut, onto(t => t > 6.5 ? t + 2 : t), 30)).toBeUndefined();
  // The engine takes a cut whose length is off by up to a frame and a hundredth of a second, and no more.
  expect(cutOnWorkingCut(cut, onto(t => t > 6.5 ? t + 0.04 : t), 30)).toEqual({ start: 6, end: 7.04 });
  expect(cutOnWorkingCut(cut, onto(t => t > 6.5 ? t + 0.05 : t), 30)).toBeUndefined();
});

it("prepares waiting calls before the first click and skips a call the editor already decided", async () => {
  const prepare = vi.mocked(api.preparePlayback);
  const listen = vi.spyOn(player, "audition");
  runningPass();
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_ready"
    ? { ...c, cutChoices: [{ index: 1, start: STAGED[1]!.start, end: STAGED[1]!.end, choice: "keep" }] } : c) }));
  await show();
  expect(call()).toBeNull();
  expect(listen).not.toHaveBeenCalled();
  const warmed = prepare.mock.calls.filter(([, version]) => version === data.timeline!.version).map(([, , positions]) => positions[0]);
  expect(warmed).toEqual([0, 9]);
  await reviewCalls();
  expect(call().querySelector(".edit-card-count")?.textContent).toBe("Cut 1");
  const listens = listen.mock.calls.length;
  await act(async () => usePlayerStore.setState({ playing: true, playbackReady: true }));
  // Cut 2 has a decision. While Cut 1 plays, prepare the uncut lead-in to Cut 3, which starts at eleven seconds.
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledWith(PRJ, data.timeline!.version, expect.arrayContaining([9]), expect.any(AbortSignal)));
  expect(listen).toHaveBeenCalledTimes(listens);
  expect(call().querySelector(".edit-card-count")?.textContent).toBe("Cut 1");
  await press("s");
  expect(call().querySelector(".edit-card-count")?.textContent).toBe("Cut 3");
});

it("marks, shades and plays a waiting call where its footage sits once the working cut has moved on from the pass's version", async () => {
  finishedPass();
  const listen = vi.spyOn(player, "audition");
  const stagedOn = data.timeline!;
  await show();
  await act(async () => {});
  expect(callDots()).toEqual([2, 6, 11]);
  // A second comes out ahead of every call. The calls are still staged on the version before that.
  await workingCutMoves(0.2, 1.2);
  await act(async () => {});
  const staged = useProjectStore.getState().current!.changes.find(c => c.id === "chg_ready")!.fromVersion;
  expect(staged).not.toBe("ver_moved");
  // Each dot is on the footage its call would take out, a second earlier than the pass's own clock says.
  expect(callDots()).toEqual([1, 5, 10]);
  // Both the splice and the uncut source are prepared on the new head before the first click.
  const draft = vi.mocked(api.cutReviewDraft);
  const warmRequestCount = draft.mock.calls.length;
  expect(draft).toHaveBeenCalledWith("chg_ready", [0, 1], "ver_moved", expect.any(AbortSignal));
  expect(api.preparePlayback).toHaveBeenCalledWith(PRJ, "only-chg_ready-2-ver_moved", expect.arrayContaining([8]), expect.any(AbortSignal));
  // Cut 3 isn't parked. Its verified plan still starts it synchronously while the next cache lookup is pending.
  const readFiles = vi.spyOn(api, "renders").mockImplementation(async () => new Promise(() => {}));
  await openCall("Repeated aside.");
  expect(draft.mock.calls.length).toBe(warmRequestCount);
  readFiles.mockResolvedValue({ renders: [] });
  expect(call().querySelector(".edit-card-count")?.textContent).toBe("Cut 3");
  expect(onVideo()).toBe("Showing cut at 0:10 · 3 of 3 · After");
  expect(listen).toHaveBeenLastCalledWith({ start: 8, end: 14, skips: [{ start: 10, end: 11, removed: true }] }, expect.any(Number));
  expect(api.cutReviewDraft).toHaveBeenCalledWith("chg_ready", [0, 1], "ver_moved", expect.any(AbortSignal));
  expect(player.mediaTime(10.5)).toBe(10);
  expect(player.mediaTime(12)).toBe(11);
  // So is its shaded passage: a click inside it plays the cut footage from the passage's first frame.
  await clickBand();
  expect(listen).toHaveBeenLastCalledWith({ start: 8, end: 13, skips: [], from: 10 }, expect.any(Number));
  await press("\\");
  expect(listen).toHaveBeenLastCalledWith({ start: 8, end: 14, skips: [{ start: 10, end: 11, removed: true }] }, expect.any(Number));
  // Its words are the cut's own footage, read where that sits on the working cut.
  expect(await callWords()).toEqual(footage(stagedOn, STAGED[2]!));
  // A revision is aimed as before, at the cut as it is staged on the pass's version. The line over the box names the
  // cut as the label on the video and its dot do.
  await press("r");
  expect(container.querySelector(".simple-target")?.textContent).toContain("Revising the cut at 0:10");
  expect(useUiStore.getState().agentContext).toMatchObject({ changeId: "chg_ready", cutIndex: 2, version: staged, time: 11, end: 12 });
});

it("starts a streamed audition on first opening a call under StrictMode", async () => {
  runningPass();
  const open = vi.spyOn(await import("../lib/cutStream"), "openCutStream").mockImplementation(() => ({
    seek: vi.fn(), finishSeek: vi.fn(), dispose: vi.fn(), sourceTime: () => 0, bufferThrough: vi.fn(async () => {}),
  }));
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  await act(async () => root.render(<StrictMode><MemoryRouter><SimpleWorkspace /></MemoryRouter></StrictMode>));
  await openEdits();
  await openCall("Repeated aside.");
  // StrictMode may dispose an idle preparation and the parked Before can open its own
  // decoder. The transport must start the live After on the visible element exactly once.
  const visible = player.element();
  expect(visible?.closest("[data-parked]")).toBeNull();
  const sessions = open.mock.calls.flatMap(([element], i) => element === visible ? [open.mock.results[i]!.value!] : []);
  const live = sessions.filter(session => !vi.mocked(session.dispose).mock.calls.length);
  expect(live).toHaveLength(1);
  expect(live[0]!.bufferThrough).toHaveBeenCalledTimes(1);
  expect(play.mock.contexts.filter(el => el === visible)).toHaveLength(1);
});

it("holds After for a single-call preview, lets Before play, and retries a failed preview", async () => {
  runningPass();
  await event(d => ({ ...d, project: { ...d.project, mediaPaused: true } }));
  await show();
  await workingCutMoves(0.2, 1.2);
  const listen = vi.spyOn(player, "audition");
  let finish!: () => void;
  const draft = vi.mocked(api.cutReviewDraft);
  draft.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve; }); return {}; });
  await openCall("Repeated aside.");
  expect(listen).not.toHaveBeenCalled();
  await press("\\");
  expect(listen).toHaveBeenCalledTimes(1);
  expect(player.mediaTime(10.5)).toBe(10.5);
  await act(async () => finish());
  expect(listen).toHaveBeenCalledTimes(1);
  draft.mockRejectedValueOnce(new Error("Preview unavailable"));
  await press("\\");
  expect(listen).toHaveBeenCalledTimes(1);
  const monitor = container.querySelector(".watch-monitor")!;
  expect(monitor.textContent).toContain("Couldn’t open this version.");
  await click(buttonIn(monitor, "Retry")!);
  expect(listen).toHaveBeenCalledTimes(2);
  expect(player.mediaTime(10.5)).toBe(10);
});

it("keeps an open call's listen on its footage when the working cut moves under it", async () => {
  finishedPass();
  const listen = vi.spyOn(player, "audition");
  await show();
  await act(async () => {});
  await openCall("Repeated aside.");
  expect(listen).toHaveBeenLastCalledWith({ start: 9, end: 15, skips: [{ start: 11, end: 12, removed: true }] }, expect.any(Number));
  // The editor is a second and a half into the listen, and has aimed a revision at the cut.
  await act(async () => usePlayerStore.getState().setTime(10.5));
  await press("r");
  expect(container.querySelector(".simple-target")?.textContent).toContain("Revising the cut at 0:11");
  const listens = listen.mock.calls.length;
  // The head moves first. Until the new working cut arrives the call is where it was.
  await event(d => ({ ...d, project: { ...d.project, head: "ver_moved" } }));
  expect(listen).toHaveBeenCalledTimes(listens);
  expect(onVideo()).toBe("Showing cut at 0:11 · 3 of 3 · After");
  // Then the working cut, a second shorter ahead of the call. The listen is taken up where the cut is now, not started
  // again, and the playhead goes with the footage it was on.
  await event(d => ({ ...d, timeline: { ...applyOps(d.timeline!, [{ op: "rippleDelete" as const, start: 0.2, end: 1.2 }]), version: "ver_moved" } }));
  await act(async () => {});
  expect(listen).toHaveBeenCalledTimes(listens + 1);
  expect(listen).toHaveBeenLastCalledWith({ start: 8, end: 14, skips: [{ start: 10, end: 11, removed: true }] }, expect.any(Number), true);
  expect(usePlayerStore.getState().time).toBe(9.5);
  expect(onVideo()).toBe("Showing cut at 0:10 · 3 of 3 · After");
  // The line over the box follows the cut as well, though the box was aimed before it moved.
  expect(container.querySelector(".simple-target")?.textContent).toContain("Revising the cut at 0:10");
});

it("leaves the playhead where the editor scrubbed it, away from an open call's listen, when the working cut moves", async () => {
  finishedPass();
  await show();
  await act(async () => {});
  await openCall("Repeated aside.");
  // The listen runs from 0:09. The editor has scrubbed back to 0:03, as they can while a call is open.
  await act(async () => usePlayerStore.getState().setTime(3));
  await workingCutMoves(0.2, 1.2);
  await act(async () => {});
  expect(onVideo()).toBe("Showing cut at 0:10 · 3 of 3 · After");
  expect(usePlayerStore.getState().time).toBe(3);
});

it("leaves a waiting call unmarked and unplayed once footage inside it is gone from the working cut", async () => {
  finishedPass();
  const listen = vi.spyOn(player, "audition");
  const stagedOn = data.timeline!;
  await show();
  await act(async () => {});
  // The edit changes inside the second call's footage, 6–7 s. The other two keep theirs.
  await workingCutMoves(5.5, 6.5);
  await act(async () => {});
  expect(callDots()).toEqual([2, 10]);
  const listens = listen.mock.calls.length;
  await openCall("Breath before the price.");
  // Its card is up. Nothing is shaded or played in its place, and nothing on the video says it is.
  expect(call().querySelector(".edit-card-count")?.textContent).toBe("Cut 2");
  expect(container.querySelector(".simple-timeline-band")).toBeNull();
  expect(onVideo()).toBeUndefined();
  // There is nothing to play it on, so its icon is off and \ does nothing.
  expect(call().querySelector<HTMLButtonElement>(".edit-card-before")!.disabled).toBe(true);
  await press("\\");
  expect(beforeIcon(call())).toEqual(["", "Before", "false", "Play Before (\\)"]);
  expect(listen).toHaveBeenCalledTimes(listens);
  // Its words are read on the pass's own version, which still has its footage.
  expect(await callWords()).toEqual(footage(stagedOn, STAGED[1]!));
});

it("leaves a waiting call unmarked when footage came out of its middle, both its edges still there", async () => {
  finishedPass();
  await show();
  await act(async () => {});
  await workingCutMoves(6.2, 6.8);
  await act(async () => {});
  // The second call would no longer take out what it was staged to. The third is 0.6 s earlier.
  expect(callDots()).toEqual([2, 10.4]);
});

it("keeps the pass's calls in their order when one of them can't be placed on the working cut, and lights no dot for it", async () => {
  finishedPass();
  await show();
  await act(async () => {});
  // All of the second call's footage comes out, and the third call's now sits before where the second was staged.
  await workingCutMoves(5.5, 10.9);
  await act(async () => {});
  expect(callDots()).toEqual([2, 5.6]);
  if (!passCard().querySelector(".simple-pass-list")) await click(passCard().querySelector(".simple-pass-toggle")!);
  expect(passRows().map(r => r.textContent)).toEqual([expect.stringContaining("A clean retake."), expect.stringContaining("Breath before the price."),
    expect.stringContaining("Repeated aside.")]);
  // A row under the pointer lights its own dot. The second call has none, so its row lights nothing: not the first call's dot either.
  const lit = () => [...container.querySelectorAll('.simple-timeline-mark[data-state="check"]')].map(m => m.classList.contains("is-hot"));
  const hover = (row: Element, type: "pointerover" | "pointerout") => act(async () => { row.dispatchEvent(new PointerEvent(type, { bubbles: true })); });
  await hover(passRows()[0]!, "pointerover");
  expect(lit()).toEqual([true, false]);
  await hover(passRows()[0]!, "pointerout");
  await hover(passRows()[1]!, "pointerover");
  expect(lit()).toEqual([false, false]);
  await hover(passRows()[1]!, "pointerout");
  await hover(passRows()[2]!, "pointerover");
  expect(lit()).toEqual([false, true]);
});

/** A waiting pass whose cut list is of no help: it couldn't be loaded, or the pass has none of its own. */
const placedFromOwnVersion = async (review: "failed" | "none") => {
  finishedPass();
  const stagedOn = data.timeline!;
  if (review === "failed") vi.spyOn(api, "cutReview").mockRejectedValue(new Error("The engine is restarting."));
  else vi.spyOn(api, "cutReview").mockResolvedValue({ review: null });
  const version = vi.spyOn(api, "timeline").mockResolvedValue({ timeline: stagedOn } as never);
  const listen = vi.spyOn(player, "audition");
  await show();
  await act(async () => {});
  // While the working cut is the pass's version, its cuts are where they were staged, and nothing more is asked for.
  expect(callDots()).toEqual([2, 6, 11]);
  expect(version).not.toHaveBeenCalled();
  await workingCutMoves(0.2, 1.2);
  await act(async () => {});
  // The pass's own version is asked for by itself, and its calls are placed by it.
  expect(version).toHaveBeenCalledWith(PRJ, stagedOn.version);
  expect(callDots()).toEqual([1, 5, 10]);
  await openCall("Repeated aside.");
  await press("\\");
  expect(listen).toHaveBeenLastCalledWith({ start: 8, end: 13, skips: [] }, expect.any(Number));
};

it("places a pass's calls from the pass's own version when its cut list couldn't be loaded", () => placedFromOwnVersion("failed"));

it("places a pass's calls from the pass's own version when the pass has no cut list of its own", () => placedFromOwnVersion("none"));

it("places no call by the pass's own clock while the pass's version can't be loaded, and asks for it again from an open call", async () => {
  finishedPass();
  const stagedOn = data.timeline!;
  vi.spyOn(api, "cutReview").mockRejectedValue(new Error("The engine is restarting."));
  let arrive = () => {};
  const version = vi.spyOn(api, "timeline").mockRejectedValueOnce(new Error("The engine is restarting.")).mockImplementation(async () => {
    await new Promise<void>(resolve => { arrive = resolve; });
    return { timeline: stagedOn } as never;
  });
  const listen = vi.spyOn(player, "audition");
  await show();
  await act(async () => {});
  await workingCutMoves(0.2, 1.2);
  await act(async () => {});
  // Nothing says where the calls sit now, so none is marked.
  expect(version).toHaveBeenCalledTimes(1);
  expect(callDots()).toEqual([]);
  const listens = listen.mock.calls.length;
  await openCall("Repeated aside.");
  // The card is up, with nothing shaded or played. Opening it asked for the pass's version again, once.
  expect(call().querySelector(".edit-card-count")?.textContent).toBe("Cut 3");
  expect(container.querySelector(".simple-timeline-band")).toBeNull();
  expect(listen).toHaveBeenCalledTimes(listens);
  expect(version).toHaveBeenCalledTimes(2);
  await act(async () => { arrive(); });
  await act(async () => {});
  expect(listen).toHaveBeenLastCalledWith({ start: 8, end: 14, skips: [{ start: 10, end: 11, removed: true }] }, expect.any(Number));
  await press("Escape");
  expect(callDots()).toEqual([1, 5, 10]);
});

it("asks for the pass's version again, once, for a call that was open when the pass fell behind and the version couldn't be loaded", async () => {
  finishedPass();
  const stagedOn = data.timeline!;
  vi.spyOn(api, "cutReview").mockRejectedValue(new Error("The engine is restarting."));
  const version = vi.spyOn(api, "timeline").mockRejectedValueOnce(new Error("The engine is restarting.")).mockResolvedValue({ timeline: stagedOn } as never);
  const listen = vi.spyOn(player, "audition");
  await show();
  await act(async () => {});
  // The pass is on the working cut, so its call opens and plays where it is staged.
  await openCall("Repeated aside.");
  await press("\\");
  expect(listen).toHaveBeenLastCalledWith({ start: 9, end: 14, skips: [] }, expect.any(Number));
  await workingCutMoves(0.2, 1.2);
  await act(async () => {});
  await act(async () => {});
  // The first try failed and the open call asked again: the listen is taken up where the cut is now.
  expect(version).toHaveBeenCalledTimes(2);
  expect(listen).toHaveBeenLastCalledWith({ start: 8, end: 13, skips: [] }, expect.any(Number), true);
});

it("asks twice for a pass's version that keeps failing, for one open call, and once more for the next call opened", async () => {
  finishedPass();
  vi.spyOn(api, "cutReview").mockRejectedValue(new Error("The engine is restarting."));
  const version = vi.spyOn(api, "timeline").mockRejectedValue(new Error("The engine is restarting."));
  await show();
  await act(async () => {});
  await openCall("Repeated aside.");
  await workingCutMoves(0.2, 1.2);
  for (let i = 0; i < 4; i++) await act(async () => {});
  // The try made as the pass fell behind, and the one the open call asked for. Not a loop.
  expect(version).toHaveBeenCalledTimes(2);
  expect(container.querySelector(".simple-timeline-band")).toBeNull();
  await openCall("A clean retake.");
  for (let i = 0; i < 4; i++) await act(async () => {});
  expect(version).toHaveBeenCalledTimes(3);
});

it("offers Retry transcript on a call's words when the pass's version can't be loaded, instead of loading without end", async () => {
  finishedPass();
  const stagedOn = data.timeline!;
  vi.spyOn(api, "cutReview").mockRejectedValue(new Error("The engine is restarting."));
  // The pass's version can't be read as the pass falls behind, nor when the open call asks again.
  const version = vi.spyOn(api, "timeline").mockRejectedValueOnce(new Error("The engine is restarting.")).mockRejectedValueOnce(new Error("The engine is restarting."))
    .mockResolvedValue({ timeline: stagedOn } as never);
  await show();
  await act(async () => {});
  await openCall("Repeated aside.");
  await workingCutMoves(0.2, 1.2);
  for (let i = 0; i < 4; i++) await act(async () => {});
  expect(version).toHaveBeenCalledTimes(2);
  await click(call().querySelector(".edit-card-words")!);
  const passage = () => call().querySelector<HTMLElement>(":scope > .thread-passage.is-call")!;
  // There is nothing to read the words on. The passage says so with the control a cut's words have, and why on hover.
  expect([passage().querySelector(".edit-passage-wait"), buttonIn(passage(), "Retry transcript")?.title]).toEqual([null, "The engine is restarting."]);
  // Asking again brings the version in: the words are read, and the call is marked where its footage sits.
  await click(buttonIn(passage(), "Retry transcript")!);
  for (let i = 0; i < 4; i++) await act(async () => {});
  expect(version).toHaveBeenCalledTimes(3);
  expect([passage().querySelector('[title="The engine is restarting."]'), !!passage().querySelector('[aria-label="Words this cut removes"]')]).toEqual([null, true]);
  expect(container.querySelector(".simple-timeline-band")).not.toBeNull();
});

it("closes a call when the next part decides its range again", async () => {
  runningPass();
  await show();
  await act(async () => {});
  await openCall("Repeated aside.");
  expect(call()).not.toBeNull();
  // The part plans a cut over that range, which takes the staged one's place. The old card closes; the new cut waits in the list.
  await nextPart({ cutReasons: [STAGED[0]!, STAGED[1]!, { start: 11.4, end: 12.5, reason: "Only the second half of the aside." }] });
  await act(async () => {});
  expect(call()).toBeNull();
  expect(onVideo()).toBeUndefined();
  expect(container.querySelector(".simple-timeline-band")).toBeNull();
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("3 need you");
});

it("closes a call when its pass is applied", async () => {
  runningPass();
  await show();
  await act(async () => {});
  await openCall("Repeated aside.");
  expect(container.querySelector(".simple-timeline-band")).not.toBeNull();
  await act(async () => {
    data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, state: "approved" as const, appliedVersion: c.toVersion } : c),
      tasks: data.tasks.map(t => t.id === "task_done" ? { ...t, state: "done" as const, finishedAt: new Date().toISOString() } : t) };
    useProjectStore.setState({ current: data });
  });
  expect(call()).toBeNull();
  expect(onVideo()).toBeUndefined();
  expect(container.querySelector(".simple-timeline-band")).toBeNull();
});

it("closes a call rather than moving it onto another request's pass", async () => {
  runningPass();
  // An earlier request's pass still waits too, staged over the same footage.
  const ready = data.changes.find(c => c.id === "chg_ready")!;
  const earlier = new Date(Date.parse(ready.createdAt!) - 3_600_000).toISOString();
  data = { ...data, changes: [{ ...ready, id: "chg_other_pass", taskId: undefined, noteIds: [], description: "An earlier pass", createdAt: earlier, updatedAt: earlier,
    cutReasons: [STAGED[2]!], cutAssessments: [{ index: 0, start: 11, end: 12, verdict: "ask" as const, reason: "The same words, in an earlier pass." }] }, ...data.changes] };
  // Two requests wait in the queue: one about the aside in the pass on screen, one about the same words in the earlier pass.
  data = { ...data, tasks: [...data.tasks, callRequest("task_queued_revision", 2, { kind: "edit" as const, instruction: "Keep the aside." }),
    { ...callRequest("task_other_revision", 0, { kind: "edit" as const, instruction: "Keep these words." }),
      context: { threadId: "chg_other_pass", changeId: "chg_other_pass", cutIndex: 0, time: 11, end: 12, message: "Keep these words." } }] };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  // Each request marks its own pass's call. The one about the earlier pass leaves the pass on screen alone.
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("2 need you");
  await event(d => ({ ...d, tasks: d.tasks.filter(t => t.id !== "task_queued_revision") }));
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("3 need you");
  await openCall("Repeated aside.");
  expect(onVideo()).toBe("Showing cut at 0:11 · 3 of 3 · After");
  // The pass on screen is applied, and the earlier one is the pass that waits now. The card doesn't move onto its cut.
  await act(async () => {
    data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, state: "approved" as const, appliedVersion: c.toVersion } : c),
      tasks: data.tasks.map(t => t.id === "task_done" ? { ...t, state: "done" as const, finishedAt: new Date().toISOString() } : t) };
    useProjectStore.setState({ current: data });
  });
  await act(async () => {});
  // The earlier pass's one call was sent back by its own request, and by no other.
  expect(turnFor("chg_other_pass").querySelector(".simple-pass-need")).toBeNull();
  await event(d => ({ ...d, tasks: d.tasks.filter(t => t.id !== "task_other_revision") }));
  expect(turnFor("chg_other_pass").querySelector(".simple-pass-need")?.textContent).toBe("1 needs you");
  expect(call()).toBeNull();
  expect(onVideo()).toBeUndefined();
});

it("marks the right call Revising… when its revision named an earlier part whose staged cuts touch", async () => {
  runningPass([...PAIR, STAGED[1]!, STAGED[2]!]);
  // The aside is the third cut of the pass: two of its four staged ranges touch.
  data = { ...data, tasks: [...data.tasks, callRequest("task_queued_revision", 2, { kind: "edit" as const, instruction: "Keep the aside." })] };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  await nextPart({ cutReasons: [...PAIR, STAGED[1]!, STAGED[2]!, { start: 14, end: 15, reason: "A cough." }] });
  await act(async () => {});
  await click(passCard().querySelector(".simple-pass-need")!);
  expect(passRows().find(r => r.textContent?.includes("Repeated aside."))!.querySelector(".simple-pass-value")?.textContent).toBe("Revising…");
  expect(passRows().find(r => r.textContent?.includes("Breath before the price."))!.querySelector(".simple-pass-value")).toBeNull();
});

it("leaves a revision aimed at an applied pass's cut where it is when the request stages another pass", async () => {
  runningPass();
  await show();
  await act(async () => {});
  await openCall("Repeated aside.");
  await press("r");
  const target = () => container.querySelector(".simple-target")?.textContent;
  expect(target()).toContain("Revising the cut at 0:11");
  // The editor is partway through the note.
  await act(async () => useUiStore.getState().setAgentDraft("Start it"));
  // The pass is applied with the editor's calls. Its list doesn't say which staged cuts came out, so nothing says
  // where that footage sits on the version it made.
  const ready = data.changes.find(c => c.id === "chg_ready")!;
  await act(async () => {
    data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, state: "approved" as const, appliedOnto: c.fromVersion, toVersion: "ver_applied", appliedVersion: "ver_applied" } : c) };
    useProjectStore.setState({ current: data });
  });
  // The same request then stages a cut two seconds earlier, on that version. The message stays aimed where the editor put it.
  await act(async () => {
    data = { ...data, changes: [...data.changes, { ...ready, id: "chg_second_pass", fromVersion: "ver_applied", toVersion: "ver_second", createdAt: new Date().toISOString(),
      cutReasons: [{ start: 9, end: 10, reason: "A cough." }], cutAssessments: [{ index: 0, start: 9, end: 10, verdict: "ask" as const, reason: "A cough." }] }] };
    useProjectStore.setState({ current: data });
  });
  await act(async () => {});
  expect(turnFor("chg_second_pass").querySelector(".simple-pass-need")?.textContent).toBe("1 needs you");
  expect(target()).toContain("Revising the cut at 0:11");
  expect(useUiStore.getState().agentContext).toMatchObject({ changeId: "chg_ready", cutIndex: 2, time: 11, end: 12 });
});

it("follows the call's cut when the next part applies a cut that ends exactly where it starts", async () => {
  const { save } = runningPass();
  await show();
  await act(async () => {});
  await openCall("Repeated aside.");
  await nextPart({ cutReasons: [STAGED[0]!, STAGED[1]!, { ...STAGED[2]!, start: 10, end: 11 }] }, [{ start: 10, end: 11, reason: "Dead air." }]);
  await act(async () => {});
  expect(onVideo()).toBe("Showing cut at 0:10 · 3 of 3 · After");
  await press("a");
  expect(save).toHaveBeenLastCalledWith("chg_ready_part2", expect.objectContaining({ choices: [{ index: 2, choice: "cut" }] }));
});

it("closes a call when the next part applies that very cut and stages the line after it", async () => {
  const { save } = runningPass();
  await show();
  await act(async () => {});
  await openCall("Repeated aside.");
  // Scarlet is sure of the aside now and takes it out. The second after it is staged, and on the new version it sits
  // where the aside was, just as long. It is another cut: the card closes instead of taking it for the aside.
  await nextPart({ cutReasons: [STAGED[0]!, STAGED[1]!, { start: 11, end: 12, reason: "The line after it." }] }, [{ start: 11, end: 12, reason: "Repeated aside." }]);
  await act(async () => {});
  expect(call()).toBeNull();
  expect(onVideo()).toBeUndefined();
  await press("a");
  expect(save).not.toHaveBeenCalled();
});

it("stays on its own cut among cuts a frame long and two frames apart", async () => {
  const frame = (n: number) => n / 60;
  const cuts: Staged[] = [{ start: frame(600), end: frame(601), reason: "A click." }, { start: frame(602), end: frame(603), reason: "A pop." }, STAGED[2]!];
  const { save } = runningPass(cuts);
  await show();
  await act(async () => {});
  await openCall("A pop.");
  await nextPart({ cutReasons: [...cuts, { start: 14, end: 15, reason: "A cough." }] });
  await act(async () => {});
  expect(call().querySelector(".edit-card-title")?.textContent).toBe("A pop.");
  await press("a");
  expect(save).toHaveBeenLastCalledWith("chg_ready_part2", expect.objectContaining({ choices: [{ index: 1, choice: "cut" }] }));
});

it("doesn't move a revision aimed at an applied pass's cut onto another request's pass", async () => {
  runningPass();
  const ready = data.changes.find(c => c.id === "chg_ready")!;
  const earlier = new Date(Date.parse(ready.createdAt!) - 3_600_000).toISOString();
  data = { ...data, changes: [{ ...ready, id: "chg_other_pass", taskId: undefined, noteIds: [], description: "An earlier pass", createdAt: earlier, updatedAt: earlier,
    cutReasons: [STAGED[2]!], cutAssessments: [{ index: 0, start: 11, end: 12, verdict: "ask" as const, reason: "The same words, in an earlier pass." }] }, ...data.changes] };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  await openCall("Repeated aside.");
  await press("r");
  expect(container.querySelector(".simple-target")?.textContent).toContain("Revising the cut at 0:11");
  await act(async () => useUiStore.getState().setAgentDraft("Start it"));
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_ready" ? { ...c, state: "approved" as const, appliedVersion: c.toVersion } : c),
    tasks: d.tasks.map(t => t.id === "task_done" ? { ...t, state: "done" as const, finishedAt: new Date().toISOString() } : t) }));
  await act(async () => {});
  expect(useUiStore.getState().agentContext).toMatchObject({ changeId: "chg_ready", cutIndex: 2 });
});

/** A pass that finished, with Scarlet's note on every cut. */
const finishedPass = (cuts: Staged[] = STAGED) => {
  const { hold, release, save } = runningPass(cuts);
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready"
      ? { ...c, cutAssessments: cuts.map((r, index) => ({ index, start: r.start, end: r.end, verdict: "ask" as const, reason: r.reason })) } : c),
    tasks: data.tasks.map(t => t.id === "task_done" ? { ...t, state: "done" as const, finishedAt: new Date().toISOString() } : t) };
  useProjectStore.setState({ current: data });
  return { hold, release, save };
};
/** A request about one call of the pass, as the message box sends it. Scarlet revises one cut at a time, so a second one waits in the queue. */
const callRequest = (id: string, index: number, over: Partial<ProjectData["tasks"][number]>) => {
  const base = data.tasks.find(t => t.id === "task_done")!, cut = STAGED[index]!;
  return { ...base, id, state: "queued" as const, startedAt: undefined, finishedAt: undefined, summary: null, changeIds: [], instruction: "Start it later.",
    createdAt: new Date().toISOString(), context: { threadId: threadWith("chg_ready").id, changeId: "chg_ready", cutIndex: index, time: cut.start, end: cut.end, message: "Start it later." }, ...over };
};

it("lists the queue in the order it will run while one call is revised, and says the calls hold a request once it is next", async () => {
  finishedPass();
  idle();
  // Scarlet is revising the first call. Asked since: a new edit, then a note on the second call.
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  const revising = callRequest("task_revise", 0, { kind: "revise" as const, state: "running" as const, createdAt: at(0), startedAt: at(0) });
  const base = data.tasks.find(t => t.id === "task_done")!;
  const lower = { ...base, id: "task_lower", kind: "edit" as const, state: "queued" as const, instruction: "Add a lower third with my name.", changeIds: [], summary: null,
    context: { threadId: "task_lower", message: "Add a lower third with my name." }, createdAt: at(1000), startedAt: undefined, finishedAt: undefined };
  const asked = callRequest("task_note", 1, { kind: "edit" as const, instruction: "Keep the breath.", createdAt: at(2000) });
  const note = { ...asked, context: { ...asked.context, message: "Keep the breath." } };
  data = { ...data, tasks: [...data.tasks, revising, lower, note], changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, state: "revising" as const } : c) };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  const tray = () => container.querySelector<HTMLElement>('[aria-label="Queued requests"]')!;
  // The note on the call runs next, though the new edit was asked first: a new edit waits until the calls are made.
  expect(tray().querySelector(".queue-head")?.textContent).toBe("NextCut 2Keep the breath.2 queued");
  expect(tray().getAttribute("title")).toBe("Starts when Scarlet finishes what it’s on");
  // Opened, the rows read in that order. Every row starts at the same place: only the first carries a word, and the
  // new edit says what holds it once it is next.
  await click(tray().querySelector(".queue-head")!);
  expect(tray().querySelector(".queue-head")?.textContent).toBe("2 queued");
  expect([...tray().querySelectorAll(".queue-row")].map(r => [r.querySelector(".queue-next")?.textContent, r.querySelector(".queue-next")?.classList.contains("is-waiting"),
    r.querySelector(".queue-target")?.textContent, r.querySelector(".queue-text")?.textContent]))
    .toEqual([["Next", false, "Cut 2", "Keep the breath."], ["", false, undefined, "Add a lower third with my name."]]);
  // The revision ends with the cut as it was, and Scarlet starts on the note. Only the new edit is queued, and its line
  // says what it waits for while the note still runs: it won't start when that ends.
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_ready" ? { ...c, state: "ready" as const } : c),
    tasks: d.tasks.map(t => t.id === "task_revise" ? { ...t, state: "done" as const, finishedAt: at(3000) } : t.id === "task_note" ? { ...t, state: "running" as const, startedAt: at(3000) } : t) }));
  const line = () => [tray().textContent, tray().getAttribute("title")];
  const held = ["Waits for your callsAdd a lower third with my name.", "Starts once you’ve made your calls on the dialogue pass"];
  expect(line()).toEqual(held);
  // The note saves its cut, so the pass comes back under the note's own run. It waits on the editor as it did before:
  // the line doesn't turn to Next for as long as the note still runs (2026-11-09).
  await revisedCut("task_note", "chg_ready", 1, { start: 6.2, end: 7 }, "Starts after the breath.");
  expect(line()).toEqual(held);
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_note" ? { ...t, state: "done" as const, finishedAt: at(4000) } : t) }));
  expect(line()).toEqual(held);
});

/**
 * A pass that finished and waits on its three calls. After staging them it proposed one more change of its own, a
 * reframing, and left it as a suggestion. Two requests wait behind the calls, and nothing else runs in the project.
 */
const passLeftSuggestion = () => {
  const { save } = finishedPass();
  const pass = data.changes.find(c => c.id === "chg_ready")!, run = data.tasks.find(t => t.id === "task_done")!;
  const reframe = { ...pass, id: "chg_reframe", description: "Show the host camera full-frame for the intro.", cutReasons: undefined, cutAssessments: undefined,
    ops: [{ op: "updateClip", clipId: "clip_a", patch: { transform: { x: 0, y: 0, scale: 1 } } }], toVersion: "ver_reframe", ranges: [{ start: 0, end: 1 }],
    createdAt: new Date(Date.now() + 1000).toISOString() };
  const next = { ...run, id: "task_next", instruction: "/frame-screen", context: { threadId: "task_next", message: "/frame-screen" }, state: "queued" as const,
    changeIds: [], summary: null, createdAt: new Date(Date.now() + 2000).toISOString(), startedAt: undefined, finishedAt: undefined };
  const after = { ...next, id: "task_after", instruction: "Add a lower third with my name.", context: { threadId: "task_after", message: "Add a lower third with my name." },
    createdAt: new Date(Date.now() + 3000).toISOString() };
  data = { ...data, changes: [...data.changes, reframe],
    // Nothing else runs in this project: only the calls hold the request back.
    tasks: [...data.tasks.map(t => t.id !== "task_done" ? ["queued", "claimed", "running", "waiting_for_user"].includes(t.state) ? { ...t, state: "done" as const } : t
      : { ...t, instruction: "/dialogue-pass", context: { ...t.context, message: "/dialogue-pass" }, changeIds: [...t.changeIds, reframe.id] }), next, after] };
  useProjectStore.setState({ current: data });
  vi.spyOn(api, "timeline").mockImplementation(async (_, version = "head") => ({ timeline: { ...data.timeline!, version } }));
  return { save };
};

it("starts the request the calls hold back from its row in the tray, without the calls", async () => {
  passLeftSuggestion();
  const start = vi.spyOn(api, "startBeforeCalls").mockImplementation(async id => {
    const task = { ...data.tasks.find(t => t.id === id)!, startsBeforeCalls: true };
    return { task };
  });
  await show();
  await act(async () => {});
  const tray = () => container.querySelector<HTMLElement>('[aria-label="Queued requests"]')!;
  // Only the request that is next has the mark: the one behind it waits for that one.
  await click(tray().querySelector(".queue-head")!);
  const marks = () => [...tray().querySelectorAll(".queue-row")].map(r => r.querySelector(".queue-start")?.getAttribute("title"));
  expect(marks()).toEqual(["Start now, before your calls", undefined]);
  await click(tray().querySelector(".queue-start")!);
  expect(start).toHaveBeenCalledWith("task_next");
  // It no longer waits on the editor: it is Next, and has nothing left to waive.
  expect(tray().querySelector(".queue-head")?.textContent).toBe("2 queued");
  expect(marks()).toEqual([undefined, undefined]);
});

it("shows a pass's calls, and the suggestion its run left after them, while they hold the next request", async () => {
  // The engine holds the next request until the calls are made (2026-11-08: the calls weren't shown, so it never started).
  passLeftSuggestion();
  await show();
  await act(async () => {});
  // With nothing else running, the pass waits above the message box. Its calls are on its line and on the timeline,
  // and the queued request says what it waits for.
  const unit = () => container.querySelector<HTMLElement>(".simple-pin .unit")!;
  const passCard = () => unit().querySelector<HTMLElement>(".simple-pass")!;
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("3 need you");
  expect(container.querySelectorAll('.simple-timeline-mark[data-state="check"]').length).toBe(3);
  const tray = container.querySelector<HTMLElement>('[aria-label="Queued requests"]')!;
  expect(tray.getAttribute("title")).toBe("Starts once you’ve made your calls on the dialogue pass");
  // The tray's line says so where Next would be: the request doesn't start until the calls are made.
  expect(tray.querySelector(".queue-head")?.textContent).toBe("Waits for your calls/frame-screen2 queued");
  expect(tray.querySelector(".queue-next")?.classList.contains("is-waiting")).toBe(true);
  // Opened, the heading says it and the rows read in running order, as they always do.
  await click(tray.querySelector(".queue-head")!);
  expect(tray.querySelector(".queue-head")?.textContent).toBe("2 queued · Waits for your calls");
  expect([...tray.querySelectorAll(".queue-row")].map(r => r.textContent)).toEqual(["Next/frame-screen", "Add a lower third with my name."]);
  await click(tray.querySelector(".queue-head")!);
  // "3 need you" reaches the first call.
  await click(passCard().querySelector(".simple-pass-need")!);
  expect(call().textContent).toContain("A clean retake.");
  await press("Escape");
  // The suggestion is in the chat with its way to play it, and playing it leaves the calls where they were.
  expect(unit().querySelector(".req-said")?.textContent).toContain("Show the host camera full-frame for the intro.");
  await click(unit().querySelector(".simple-suggest")!);
  expect(container.querySelector('.edit-card[aria-label="Suggestion"]')).not.toBeNull();
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("3 need you");
  await press("Escape");
  expect(container.querySelector('[aria-label="Suggestion"]')).toBeNull();
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("3 need you");
});

it("scrolls a pinned pass's calls below its heading and above the message box", async () => {
  passLeftSuggestion();
  await withSimpleSheet(async () => {
    await show();
    await act(async () => {});
    const pin = container.querySelector<HTMLElement>(".simple-pin")!;
    const list = pin.querySelector<HTMLElement>(".simple-pass-list")!;
    expect([list.getAttribute("aria-label"), list.children.length]).toEqual(["Calls that need you", 3]);
    expect(styled(pin, "display", "flex-direction")).toEqual(["flex", "column"]);
    expect(styled(list, "max-height", "overflow-y")).toEqual(["none", "auto"]);
  });
});

it("leaves a waiting pass its calls and its place above the message box while a suggestion plays, and keeps the keys on its card", async () => {
  const { save } = passLeftSuggestion();
  const approve = vi.fn().mockResolvedValue({ outcome: "applied" });
  useProjectStore.setState({ approve });
  await show();
  await act(async () => {});
  const unit = () => container.querySelector<HTMLElement>(".simple-pin .unit");
  const need = () => unit()?.querySelector(".simple-pass-need")?.textContent;
  const callRows = () => [...unit()!.querySelectorAll<HTMLButtonElement>(".simple-pass-list > li > button")];
  const play = async () => { await click(unit()!.querySelector(".simple-suggest")!); await act(async () => {}); };
  const strip = () => container.querySelector<HTMLElement>('[aria-label="Suggestion"]');
  const callDots = () => container.querySelectorAll('.simple-timeline-mark[data-state="check"]').length;
  expect([need(), callDots()]).toEqual(["3 need you", 3]);

  // The suggestion plays in the card on top of the timeline. The pass is where it was: above the message box, saying
  // "3 need you", with its three calls listed. Its suggestion's line is lit.
  await play();
  expect(strip()?.querySelector(".edit-card-title")?.textContent).toBe("Show the host camera full-frame for the intro.");
  expect(need()).toBe("3 need you");
  expect(callRows().map(r => [r.querySelector(".edit-badge")?.textContent, r.querySelector(".simple-pass-label")?.textContent]))
    .toEqual([["1", "A clean retake."], ["2", "Breath before the price."], ["3", "Repeated aside."]]);
  expect(unit()!.querySelector(".simple-suggest")?.getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector('[aria-label="Queued requests"] .queue-head')?.textContent).toBe("Waits for your calls/frame-screen2 queued");
  // The timeline is the suggestion's while it plays, as it is a call's while that is open: its passage, and no call's dot.
  expect([container.querySelector(".simple-timeline-band") !== null, callDots()]).toEqual([true, 0]);
  // The keys act on what is in the player. ↓ steps to no call and S skips none: no call is on screen.
  await press("ArrowDown");
  await press("s");
  expect([call(), strip() !== null, save.mock.calls.length]).toEqual([null, true, 0]);

  // A call opened from the list takes the player: the suggestion closes and the call's card opens. Esc closes the card.
  await click(callRows()[1]!);
  expect([strip(), call()?.textContent?.includes("Breath before the price."), callRows()[1]!.getAttribute("aria-current")]).toEqual([null, true, "true"]);
  await press("Escape");
  expect(call()).toBeNull();
  // Esc closes the suggestion, and the calls' dots are back on the timeline.
  await play();
  await press("Escape");
  expect([strip(), need(), callDots()]).toEqual([null, "3 need you", 3]);
  // Apply (A) on its card applies the suggestion and never the pass, whose calls still wait.
  await play();
  await press("a");
  expect(approve.mock.calls).toEqual([["chg_reframe", undefined, undefined]]);
  expect([strip(), need()]).toEqual([null, "3 need you"]);
});

it("plays another request's suggestion over a waiting pass: Revise is the suggestion's, and “N need you” goes back to the calls", async () => {
  finishedPass();
  // An earlier request left a suggestion that was never applied. The pass ran after it and waits on its three calls.
  const run = data.tasks.find(t => t.id === "task_done")!, pass = data.changes.find(c => c.id === "chg_ready")!;
  const early = new Date(Date.parse(run.createdAt!) - 60_000).toISOString();
  const asked = { ...run, id: "task_third", instruction: "Add a lower third with my name.", context: { threadId: "task_third", message: "Add a lower third with my name." },
    state: "done" as const, changeIds: ["chg_third"], summary: null, createdAt: early, startedAt: early, finishedAt: early };
  const third = { ...pass, id: "chg_third", taskId: "task_third", noteIds: [], description: "A lower third with your name over the intro.", cutReasons: undefined, cutAssessments: undefined,
    toVersion: "ver_third", ranges: [{ start: 0, end: 3 }], createdAt: early, updatedAt: early };
  data = { ...data, changes: [...data.changes, third],
    tasks: [...data.tasks.map(t => t.id !== "task_done" && ["queued", "claimed", "running", "waiting_for_user"].includes(t.state) ? { ...t, state: "done" as const } : t), asked] };
  useProjectStore.setState({ current: data });
  vi.spyOn(api, "timeline").mockImplementation(async (_, version = "head") => ({ timeline: { ...data.timeline!, version } }));
  await show();
  await act(async () => {});
  const need = () => container.querySelector<HTMLElement>(".simple-pin .unit .simple-pass-need");
  const strip = () => container.querySelector<HTMLElement>('[aria-label="Suggestion"]');
  expect(threadWith("chg_third").id).not.toBe(threadWith("chg_ready").id);
  await click(suggestion("chg_third"));
  await act(async () => {});
  // The suggestion plays, and the pass still holds the place above the message box with its count.
  expect([strip()?.querySelector(".edit-card-title")?.textContent, need()?.textContent]).toEqual(["A lower third with your name over the intro.", "3 need you"]);
  // Revise (R) is about what is in the player: the message box turns to the suggestion, in the request that left it.
  await press("r");
  expect(useUiStore.getState().agentContext).toMatchObject({ changeId: "chg_third", label: "Suggestion" });
  expect(useUiStore.getState().draftOwner).toBe(JSON.stringify([PRJ, threadWith("chg_third").id]));
  // "3 need you" reaches the first call, as it does with nothing playing: the suggestion closes and the call's card opens.
  await click(need()!);
  expect([strip(), call()?.textContent?.includes("A clean retake.")]).toEqual([null, true]);
});

it("keeps a second call Revising… when the first revised cut comes back, and doesn't apply the pass over it", async () => {
  finishedPass();
  const approve = vi.fn().mockResolvedValue({ outcome: "applied" });
  useProjectStore.setState({ approve });
  await show();
  await act(async () => {});
  // The editor sends the first cut back: Scarlet starts revising it, and the pass waits as "revising".
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_revise", 0, { kind: "revise" as const, state: "running" as const, startedAt: new Date().toISOString() })] }));
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_ready" ? { ...c, state: "revising" as const } : c) }));
  // They send the aside back too. That request waits in the queue and names the pass it saw.
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_queued_revision", 2, { kind: "edit" as const, instruction: "Keep the aside." })] }));
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("1 needs you");
  // The first cut comes back revised, as a new proposal. The pass it replaces stays "revising" and is never marked replaced.
  const old = data.changes.find(c => c.id === "chg_ready")!;
  const revised = { ...old, id: "chg_revised", state: "ready" as const, taskId: "task_revise", toVersion: "ver_revised", createdAt: new Date().toISOString(),
    cutReasons: [{ start: 1.5, end: 3, reason: "Starts in the pause." }, STAGED[1]!, STAGED[2]!],
    cutAssessments: old.cutAssessments!.map(a => a.index === 0 ? { index: 0, start: 1.5, end: 3, verdict: "ask" as const, reason: "Starts in the pause." } : a) };
  await event(d => ({ ...d, changes: [...d.changes, { ...revised, cutAssessments: undefined }] }));
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_revise" ? { ...t, changeIds: [revised.id] } : t) }));
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === revised.id ? revised : c) }));
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_revise" ? { ...t, state: "done" as const, finishedAt: new Date().toISOString() } : t) }));
  await act(async () => {});
  // The aside still waits on Scarlet: no amber dot, and it can't be opened.
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("2 need you");
  await click(passCard().querySelector(".simple-pass-need")!);
  const aside = passRows().find(r => r.textContent?.includes("Repeated aside."))!;
  expect(aside.querySelector(".simple-pass-value")?.textContent).toBe("Revising…");
  expect(aside.querySelector(".simple-pass-time.is-need")).toBeNull();
  expect(aside.disabled).toBe(true);
  // The editor makes the two calls that are theirs. The pass still waits for the aside's revision before it applies.
  await click(passRows().find(r => !r.disabled)!);
  await press("a");
  await press("a");
  await act(async () => {});
  expect(approve).not.toHaveBeenCalled();
});

it("keeps a call Revising… when it comes back revised while a second note on it still waits", async () => {
  finishedPass();
  const approve = vi.fn().mockResolvedValue({ outcome: "applied" });
  useProjectStore.setState({ approve });
  await show();
  await act(async () => {});
  // The editor sends the first cut back, then sends a second thought about the same cut, which waits in the queue.
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_revise", 0, { kind: "revise" as const, state: "running" as const, startedAt: new Date().toISOString() })] }));
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_ready" ? { ...c, state: "revising" as const } : c) }));
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_second_note", 0, { kind: "edit" as const, instruction: "And keep the breath." })] }));
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("2 need you");
  // The cut comes back revised, somewhere else. The second note is about it still.
  const old = data.changes.find(c => c.id === "chg_ready")!;
  const revised = { ...old, id: "chg_revised", state: "ready" as const, taskId: "task_revise", toVersion: "ver_revised", createdAt: new Date().toISOString(),
    cutReasons: [{ start: 1.5, end: 3, reason: "Starts in the pause." }, STAGED[1]!, STAGED[2]!],
    cutAssessments: old.cutAssessments!.map(a => a.index === 0 ? { index: 0, start: 1.5, end: 3, verdict: "ask" as const, reason: "Starts in the pause." } : a) };
  await event(d => ({ ...d, changes: [...d.changes, revised], tasks: d.tasks.map(t => t.id === "task_revise" ? { ...t, state: "done" as const, finishedAt: new Date().toISOString(), changeIds: [revised.id] } : t) }));
  await act(async () => {});
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("2 need you");
  await click(passCard().querySelector(".simple-pass-need")!);
  const row = passRows().find(r => r.textContent?.includes("Starts in the pause."))!;
  expect(row.querySelector(".simple-pass-value")?.textContent).toBe("Revising…");
  expect(row.disabled).toBe(true);
  // The two calls that are the editor's don't apply the pass over it.
  await click(passRows().find(r => !r.disabled)!);
  await press("a");
  await press("a");
  await act(async () => {});
  expect(approve).not.toHaveBeenCalled();
});

/**
 * A cut comes back revised, in the engine's order: the new proposal, the pass it replaces marked (when that was still
 * waiting, as it is for a request that wasn't started as a revision), then the notes carried onto the new one.
 */
const revisedCut = async (taskId: string, from: string, index: number, range: { start: number; end: number }, reason: string) => {
  const old = useProjectStore.getState().current!.changes.find(c => c.id === from)!;
  const next = { ...old, id: "chg_revised", state: "ready" as const, taskId, toVersion: "ver_revised", createdAt: new Date().toISOString(),
    cutReasons: old.cutReasons!.map((r, i) => i === index ? { ...range, reason } : r),
    cutAssessments: old.cutAssessments!.map(a => a.index === index ? { index, ...range, verdict: "ask" as const, reason } : a) };
  await event(d => ({ ...d, changes: [...d.changes, { ...next, cutAssessments: undefined }] }));
  if (old.state === "ready") await event(d => ({ ...d, changes: d.changes.map(c => c.id !== from ? c : { ...c, state: "rejected" as const, rejectedFrom: "ready" as const,
    rejectReason: "Replaced by a later revision of the same cut.", replacedBy: next.id }) }));
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === next.id ? next : c) }));
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === taskId ? { ...t, changeIds: [...t.changeIds, next.id] } : t) }));
  await act(async () => {});
};
/** Scarlet finishes the pass with a note on every cut, and the next run in line starts. */
const passEnds = async (proposal: string, cuts: Staged[], starts: string) => {
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === proposal
    ? { ...c, cutAssessments: cuts.map((r, index) => ({ index, start: r.start, end: r.end, verdict: "ask" as const, reason: r.reason })) } : c) }));
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_done" ? { ...t, state: "done" as const, finishedAt: new Date().toISOString() }
    : t.id === starts ? { ...t, state: "running" as const, startedAt: new Date().toISOString() } : t) }));
};
const runPasses = (from: string, to: string) => event(d => ({ ...d, tasks: d.tasks.map(t => t.id === from ? { ...t, state: "done" as const, finishedAt: new Date().toISOString() }
  : t.id === to ? { ...t, state: "running" as const, startedAt: new Date().toISOString() } : t) }));
const laterNote = { kind: "edit" as const, instruction: "And keep the breath.", createdAt: new Date(Date.now() + 5).toISOString() };

it("keeps a call Revising… when a request that waited its turn revised it and a second note on it still waits", async () => {
  runningPass();
  const approve = vi.fn().mockResolvedValue({ outcome: "applied" });
  useProjectStore.setState({ approve });
  await show();
  await act(async () => {});
  // Two notes on the cut at 0:02, sent while the pass still runs: each waits in the queue as a request about that cut.
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_note1", 0, { kind: "edit" as const }), callRequest("task_note2", 0, laterNote)] }));
  // The pass finishes. The first request starts and moves the cut, under its own run. The pass it revised is marked replaced.
  await passEnds("chg_ready", STAGED, "task_note1");
  await revisedCut("task_note1", "chg_ready", 0, { start: 1.5, end: 3 }, "Starts in the pause.");
  await runPasses("task_note1", "task_note2");
  await act(async () => {});
  // The second note is about that cut still: it waits on Scarlet, and the pass doesn't apply over it.
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("2 need you");
  await click(passCard().querySelector(".simple-pass-need")!);
  const row = passRows().find(r => r.textContent?.includes("Starts in the pause."))!;
  expect(row.querySelector(".simple-pass-value")?.textContent).toBe("Revising…");
  expect(row.disabled).toBe(true);
  await click(passRows().find(r => !r.disabled)!);
  await press("a");
  await press("a");
  await act(async () => {});
  expect(approve).not.toHaveBeenCalled();
});

it("keeps the right call Revising… when a part gave it a new number before a waiting request revised it", async () => {
  runningPass();
  await show();
  await act(async () => {});
  // Two notes on the aside at 0:11, the third cut of the proposal on screen.
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_note1", 2, { kind: "edit" as const }), callRequest("task_note2", 2, laterNote)] }));
  // The next part stages one more cut ahead of it, so the aside is the fourth cut when the first request revises it.
  const cuts = [STAGED[0]!, STAGED[1]!, { start: 8.5, end: 9.5, reason: "A second try at the line." }, STAGED[2]!];
  await nextPart({ cutReasons: cuts });
  await act(async () => {});
  await passEnds("chg_ready_part2", cuts, "task_note1");
  await revisedCut("task_note1", "chg_ready_part2", 3, { start: 11.2, end: 12 }, "The aside, from the breath.");
  await runPasses("task_note1", "task_note2");
  await act(async () => {});
  await click(passCard().querySelector(".simple-pass-need")!);
  const aside = passRows().find(r => r.textContent?.includes("The aside, from the breath."))!;
  const other = passRows().find(r => r.textContent?.includes("A second try at the line."))!;
  expect([aside.querySelector(".simple-pass-value")?.textContent, aside.disabled]).toEqual(["Revising…", true]);
  expect([other.querySelector(".simple-pass-value")?.textContent ?? null, other.disabled]).toEqual([null, false]);
});

it("keeps a request about a cut on the cut that takes in most of its footage when a part decides that footage again", async () => {
  runningPass();
  const approve = vi.fn().mockResolvedValue({ outcome: "applied" });
  useProjectStore.setState({ approve });
  await show();
  await act(async () => {});
  // A note on the aside at 0:11 waits in the queue.
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_note1", 2, { kind: "edit" as const })] }));
  // The next part decides that second again, as three cuts with a word left between each.
  const cuts = [STAGED[0]!, STAGED[1]!, { start: 11, end: 11.1, reason: "The breath." }, { start: 11.2, end: 11.7, reason: "Only the aside itself." },
    { start: 11.8, end: 12, reason: "The click after it." }];
  await nextPart({ cutReasons: cuts });
  await act(async () => {});
  await passEnds("chg_ready_part2", cuts, "task_note1");
  await click(passCard().querySelector(".simple-pass-need")!);
  const marked = (reason: string) => { const row = passRows().find(r => r.textContent?.includes(reason))!; return [row.querySelector(".simple-pass-value")?.textContent ?? null, row.disabled]; };
  expect(marked("Only the aside itself.")).toEqual(["Revising…", true]);
  expect(marked("The breath.")).toEqual([null, false]);
  expect(marked("The click after it.")).toEqual([null, false]);
  // The calls that are the editor's don't apply the pass over the note.
  await click(passRows().find(r => !r.disabled)!);
  for (let n = 0; n < 4; n++) await press("a");
  await act(async () => {});
  expect(approve).not.toHaveBeenCalled();
});

it("finds the footage a waiting request named where it sits after a part applied a cut ahead of it", async () => {
  runningPass();
  await show();
  await act(async () => {});
  // A note on the breath at 0:06 waits in the queue.
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_note1", 1, { kind: "edit" as const })] }));
  // The next part takes a second and a half out ahead of it, so the breath sits at 0:04 now. It decides the breath again,
  // tighter, and stages another line where the breath used to sit.
  const cuts = [STAGED[0]!, { start: 4.6, end: 5.3, reason: "Only the breath itself." }, { start: 6, end: 7, reason: "A line that came in late." },
    { ...STAGED[2]!, start: 9.5, end: 10.5 }];
  await nextPart({ cutReasons: cuts }, [{ start: 4, end: 5.5, reason: "Dead air." }]);
  await act(async () => {});
  await passEnds("chg_ready_part2", cuts, "task_note1");
  await click(passCard().querySelector(".simple-pass-need")!);
  const marked = (reason: string) => { const row = passRows().find(r => r.textContent?.includes(reason))!; return [row.querySelector(".simple-pass-value")?.textContent ?? null, row.disabled]; };
  expect(marked("Only the breath itself.")).toEqual(["Revising…", true]);
  expect(marked("A line that came in late.")).toEqual([null, false]);
});

it("marks no call for a request about footage the pass no longer stages, though a staged cut starts right where it ended", async () => {
  runningPass();
  await show();
  await act(async () => {});
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_note1", 0, { kind: "edit" as const })] }));
  // The next part leaves the retake at 0:02 in, and stages the breath right after it.
  const cuts = [{ start: 3, end: 3.5, reason: "A breath after the retake." }, STAGED[1]!, STAGED[2]!];
  await nextPart({ cutReasons: cuts });
  await act(async () => {});
  await passEnds("chg_ready_part2", cuts, "task_note1");
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("3 need you");
  await click(passCard().querySelector(".simple-pass-need")!);
  expect(passRows().map(r => [r.querySelector(".simple-pass-value")?.textContent ?? null, r.disabled])).toEqual([[null, false], [null, false], [null, false]]);
});

it("moves a second thought still in the box onto the revised cut, whichever kind of run revised it", async () => {
  runningPass();
  await show();
  await act(async () => {});
  // The editor presses Revise on the call at 0:02 and sends a note. The box stays aimed at the cut for a second thought.
  await openCall("A clean retake.");
  await act(async () => usePlayerStore.getState().setTime(1));
  await press("r");
  expect(container.querySelector(".simple-target")?.textContent).toContain("Revising the cut at 0:02");
  // The second thought is being written when the first note's revision comes back.
  await act(async () => useUiStore.getState().setAgentDraft("And"));
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_note1", 0, { kind: "edit" as const })] }));
  await passEnds("chg_ready", STAGED, "task_note1");
  await revisedCut("task_note1", "chg_ready", 0, { start: 1.5, end: 3 }, "Starts in the pause.");
  expect(container.querySelector(".simple-target")?.textContent).toContain("Revising the cut at 0:02");
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_note1" ? { ...t, state: "done" as const } : t) }));
  expect(useUiStore.getState().agentContext).toMatchObject({ changeId: "chg_revised", cutIndex: 0, time: 1.5, end: 3 });
  expect(container.querySelector(".simple-target")?.textContent).toContain("Revising the cut at 0:01");
  // The revised cut starts earlier on the same working cut. No footage moved, so the playhead stays where it was.
  expect(usePlayerStore.getState().time).toBe(1);
});

it("reads a revised call's earlier version by the pass's cut list when staged cuts touch", async () => {
  const cuts = [...PAIR, STAGED[1]!, STAGED[2]!];
  runningPass(cuts);
  const first = data.changes.find(c => c.id === "chg_ready")!;
  // The aside is the third cut of four staged ranges. It was sent back and came back shorter, with Scarlet's note.
  const revised = { ...first, id: "chg_revised", taskId: "task_revise", toVersion: "ver_revised", createdAt: new Date().toISOString(),
    cutReasons: [...PAIR, STAGED[1]!, { start: 11.2, end: 12, reason: "The aside, from the breath." }],
    cutAssessments: [{ index: 2, start: 11.2, end: 12, verdict: "ask" as const, reason: "The aside, from the breath." }] };
  data = { ...data, changes: [...data.changes.map(c => c.id === "chg_ready" ? { ...first, state: "revising" as const, cutAssessments: undefined } : c), revised],
    tasks: [...data.tasks.map(t => t.id === "task_done" ? { ...t, state: "done" as const, finishedAt: new Date().toISOString() } : t),
      callRequest("task_revise", 2, { kind: "revise" as const, state: "done" as const, finishedAt: new Date().toISOString(), changeIds: ["chg_revised"] })] };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  await openCall("The aside, from the breath.");
  expect(call().querySelector(".edit-version")?.getAttribute("title")).toBe("v1: Repeated aside.\nYou: “Start it later.”");
});

it("keeps a call Revising… when its revision named an earlier part and a later part moved the cut", async () => {
  runningPass();
  const threadId = threadWith("chg_ready").id;
  // The editor sent the aside back while the pass ran, so the request waits in the queue and names the part it saw.
  const base = data.tasks.find(t => t.id === "task_done")!;
  data = { ...data, tasks: [...data.tasks, { ...base, id: "task_queued_revision", kind: "edit" as const, state: "queued" as const,
    startedAt: undefined, finishedAt: undefined, summary: null, changeIds: [], instruction: "Keep the aside.", createdAt: new Date().toISOString(),
    context: { threadId, changeId: "chg_ready", cutIndex: 2, time: 11, end: 12, message: "Keep the aside." } }] };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("2 need you");
  await nextPart({ cutReasons: [STAGED[0]!, { ...STAGED[1]!, start: 4.5, end: 5.5 }, { ...STAGED[2]!, start: 9.5, end: 10.5 }] }, [{ start: 4, end: 5.5, reason: "Dead air." }]);
  await act(async () => {});
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("2 need you");
  await click(passCard().querySelector(".simple-pass-need")!);
  const row = passRows().find(r => r.textContent?.includes("Repeated aside."))!;
  expect(row.querySelector(".simple-pass-value")?.textContent).toBe("Revising…");
  expect(row.querySelector(".simple-pass-time.is-need")).toBeNull();
});

/**
 * Scarlet's own edit between two parts of the pass: crossfades on the video's joins. Each join's sound is copied onto a
 * dialogue track of its own, run a quarter of a second into the clip on the other side and faded, and the video's own
 * sound is turned down. Clips' times change, the video's footage stays where it was, and the edit stages no cuts.
 */
const crossfadesBetweenParts = async () => {
  const old = data.changes.find(c => c.id === "chg_ready")!;
  const video = data.timeline!.tracks.find(t => t.kind === "video")!.clips as MediaClip[];
  const track = makeTrack("audio", "Dialogue", "trk_fades");
  const ops = [{ op: "addTrack" as const, track }, ...video.flatMap((clip, i) => {
    const pre = i > 0 ? 0.25 : 0, post = i < video.length - 1 ? 0.25 : 0;
    return [{ op: "addClip" as const, trackId: track.id, clip: makeMediaClip(clip.mediaId, clip.sourceIn - pre, clip.sourceOut + post, clip.timelineIn - pre,
      { id: `fade_${clip.id}`, audioFadeIn: pre && 0.5, audioFadeOut: post && 0.5 }) }, { op: "updateClip" as const, clipId: clip.id, patch: { volume: 0 } }];
  })];
  const fades = { ...old, id: "chg_fades", intent: "requested" as const, state: "approved" as const, description: "Crossfades on the joins.",
    appliedOnto: old.fromVersion, toVersion: "ver_fades", appliedVersion: "ver_fades", ops, ranges: [], cutReasons: undefined, cutAssessments: undefined,
    cutChoices: undefined, createdAt: new Date().toISOString() };
  await event(d => ({ ...d, changes: [...d.changes, fades], project: { ...d.project, head: "ver_fades" } }));
  await event(d => ({ ...d, timeline: { ...applyOps(d.timeline!, ops), version: "ver_fades" } }));
};
/** The next part, read on the video after the crossfades, stages one more cut ahead of the aside at 0:11. */
const partAfterCrossfades = () => nextPart({ fromVersion: "ver_fades",
  cutReasons: [STAGED[0]!, STAGED[1]!, { start: 8.5, end: 9.5, reason: "A second try at the line." }, STAGED[2]!] });

it("keeps the call on screen on its cut when the pass saves its next part after crossfades of Scarlet's own", async () => {
  const { save } = runningPass();
  await show();
  await act(async () => {});
  await openCall("Repeated aside.");
  expect(onVideo()).toBe("Showing cut at 0:11 · 3 of 3 · After");
  const card = call();
  await crossfadesBetweenParts();
  await partAfterCrossfades();
  await act(async () => {});
  // The card stays open on the same cut, now the fourth, and Skip still means it.
  expect(call()).toBe(card);
  expect(call().querySelector(".edit-card-title")?.textContent).toBe("Repeated aside.");
  expect(onVideo()).toBe("Showing cut at 0:11 · 4 of 4 · After");
  await press("s");
  expect(save).toHaveBeenLastCalledWith("chg_ready_part2", expect.objectContaining({ fromVersion: "ver_fades", choices: [{ index: 3, choice: "keep" }] }));
});

it("keeps a call Revising… and its number when its revision named the part before Scarlet's own crossfades", async () => {
  runningPass();
  const threadId = threadWith("chg_ready").id;
  // The editor sent the aside back while the pass ran, so the request waits in the queue and names the part it saw.
  const base = data.tasks.find(t => t.id === "task_done")!;
  data = { ...data, tasks: [...data.tasks, { ...base, id: "task_queued_revision", kind: "edit" as const, state: "queued" as const,
    startedAt: undefined, finishedAt: undefined, summary: null, changeIds: [], instruction: "Keep the aside.", createdAt: new Date().toISOString(),
    context: { threadId, changeId: "chg_ready", cutIndex: 2, time: 11, end: 12, message: "Keep the aside." } }] };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  const tag = () => [...container.querySelectorAll<HTMLElement>(".queue-row, .queue-head")].find(r => r.textContent?.includes("Keep the aside."))
    ?.querySelector(".queue-target")?.textContent;
  expect(tag()).toBe("Cut 3");
  await crossfadesBetweenParts();
  await partAfterCrossfades();
  await act(async () => {});
  // The aside is the fourth call now. It still waits on Scarlet, not the editor, and can't be opened from the list.
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("3 need you");
  expect(tag()).toBe("Cut 4");
  await click(passCard().querySelector(".simple-pass-need")!);
  const row = passRows().find(r => r.textContent?.includes("Repeated aside."))!;
  expect([row.querySelector(".simple-pass-value")?.textContent, row.disabled]).toEqual(["Revising…", true]);
});

it("marks a call Revising… in the need-you list once its revision is queued behind the running pass", async () => {
  flagged();
  const threadId = threadWith("chg_ready").id;
  data = { ...data,
    changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, intent: "suggestion" as const, taskId: "task_done",
      cutReasons: [0, 1, 2].map(i => ({ start: i, end: i + 1, reason: ["A clean retake.", "Breath before the price.", "Repeated aside."][i]! })),
      cutAssessments: [{ index: 1, start: 230, end: 233, verdict: "ask" as const, reason: "Breath before the price." },
        { index: 2, start: 2, end: 3, verdict: "ask" as const, reason: "Repeated aside." }],
      cutChoices: [{ index: 0, start: 0, end: 1, choice: "cut" as const }] } : c),
    tasks: data.tasks.map(t => t.id === "task_done" ? { ...t, state: "running" as const, finishedAt: undefined,
      startedAt: new Date(Date.now() - 60_000).toISOString(), expectedSeconds: 660 } : t) };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("2 need you");
  // The editor revises the call at 3:50 while the pass still runs, so the request waits in the queue.
  const base = data.tasks.find(t => t.id === "task_done")!;
  data = { ...data, tasks: [...data.tasks, { ...base, id: "task_queued_revision", kind: "edit" as const, state: "queued" as const,
    startedAt: undefined, finishedAt: undefined, summary: null, changeIds: [], instruction: "Keep the breath.", createdAt: new Date().toISOString(),
    context: { threadId, changeId: "chg_ready", cutIndex: 1, time: 230, end: 233, message: "Keep the breath." } }] };
  await act(async () => { useProjectStore.setState({ current: data }); });
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("1 needs you");
  // It stays in the "need you" list, marked Revising…, beside the call that still waits.
  await click(passCard().querySelector(".simple-pass-need")!);
  expect(passRows().map(r => r.querySelector(".simple-pass-label")?.textContent).sort()).toEqual(["Breath before the price.", "Repeated aside."].sort());
  const row = passRows().find(r => r.textContent?.includes("Breath before the price."))!;
  expect(row.querySelector(".simple-pass-value")?.textContent).toBe("Revising…");
  // Its number is no longer amber: it waits on Scarlet now. The call that still waits keeps its amber number.
  expect(passRows().map(r => r.querySelector(".edit-badge")?.classList.contains("is-check"))).toEqual(passRows().map(r => r !== row));
  expect(row.disabled).toBe(true);
});

it("changes a queued revision's words in the message box, holding it from starting while they're there", async () => {
  runningPass();
  // The editor sent the aside back while the pass ran, so the revision waits in the queue.
  data = { ...data, tasks: [...data.tasks, callRequest("task_queued_revision", 2, { kind: "edit" as const, instruction: "Keep the aside.",
    context: { ...callRequest("task_queued_revision", 2, {}).context, message: "Keep the aside." } })] };
  const holdForRewording = vi.fn().mockResolvedValue(undefined);
  const rewordTask = vi.fn().mockResolvedValue(undefined);
  const cancelTask = vi.fn().mockResolvedValue(undefined);
  useProjectStore.setState({ current: data, holdForRewording, rewordTask, cancelTask });
  await show();
  await act(async () => {});
  const tray = () => container.querySelector<HTMLElement>('[aria-label="Queued requests"]')!;
  const pencil = () => tray().querySelector<HTMLButtonElement>(".queue-reword")!;
  // Its row has a pencil beside its ×. It puts the words in the message box, which they have to themselves.
  expect([pencil().getAttribute("title"), pencil().getAttribute("aria-pressed")]).toEqual(["Reword", "false"]);
  expect(composer.props?.rewording).toBeUndefined();
  await click(pencil());
  expect(composer.props?.rewording).toMatchObject({ id: "task_queued_revision", text: "Keep the aside." });
  expect(composer.props?.rewording).not.toHaveProperty("tag");
  // Scarlet doesn't start it while they're there. Its row is lit to say which request the box holds, and its pencil
  // is lit as the way back.
  expect(holdForRewording).toHaveBeenCalledWith("task_queued_revision", true);
  expect(tray().querySelector(".queue-row.is-rewording")).not.toBeNull();
  expect([pencil().getAttribute("title"), pencil().getAttribute("aria-pressed")]).toEqual(["Leave as it was (Esc)", "true"]);
  // Sending the new words saves them. The request keeps its place in the queue, and the box lets them go.
  await act(async () => composer.props!.rewording!.onChange("Keep the aside, but trim the breath before it."));
  expect(composer.props?.rewording?.text).toBe("Keep the aside, but trim the breath before it.");
  // The skills the new words name go with them, as they would with a send.
  await act(async () => composer.props!.rewording!.onSave("Keep the aside, but trim the breath before it.", ["skl_tighten"]));
  expect(rewordTask).toHaveBeenCalledWith("task_queued_revision", "Keep the aside, but trim the breath before it.", ["skl_tighten"]);
  expect(composer.props?.rewording).toBeUndefined();
  expect(holdForRewording).toHaveBeenLastCalledWith("task_queued_revision", false);
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_queued_revision"
    ? { ...t, instruction: "Keep the aside, but trim the breath before it.", context: { ...t.context, message: "Keep the aside, but trim the breath before it." } } : t) }));
  expect(tray().querySelector(".queue-text")?.textContent).toBe("Keep the aside, but trim the breath before it.");
  // A click on the words brings them back. Leaving them, or saving them unchanged, sends nothing.
  await click(tray().querySelector(".queue-text")!);
  expect(composer.props?.rewording?.text).toBe("Keep the aside, but trim the breath before it.");
  await act(async () => composer.props!.rewording!.onCancel());
  expect(composer.props?.rewording).toBeUndefined();
  await click(pencil());
  await act(async () => composer.props!.rewording!.onSave("Keep the aside, but trim the breath before it."));
  expect(rewordTask).toHaveBeenCalledTimes(1);
  // The lit pencil puts them back as they were, too.
  await click(pencil());
  await act(async () => composer.props!.rewording!.onChange("Never mind."));
  await click(pencil());
  expect(composer.props?.rewording).toBeUndefined();
  expect(rewordTask).toHaveBeenCalledTimes(1);
  expect(holdForRewording).toHaveBeenLastCalledWith("task_queued_revision", false);
  // Taken out of the queue while its words are in the box, it lets go of them.
  await click(tray().querySelector(".queue-reword")!);
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_queued_revision" ? { ...t, state: "cancelled" as const, finishedAt: new Date().toISOString() } : t) }));
  expect(composer.props?.rewording).toBeUndefined();
});

it("keeps a queued request's new words when holding it fails for another reason, and asks for the hold again", async () => {
  runningPass();
  data = { ...data, tasks: [...data.tasks, callRequest("task_queued_revision", 2, { kind: "edit" as const, instruction: "Keep the aside.",
    context: { ...callRequest("task_queued_revision", 2, {}).context, message: "Keep the aside." } })] };
  // The engine restarts as the editor starts rewording: the first hold fails, and the one after it is taken.
  const holdForRewording = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(undefined);
  useProjectStore.setState({ current: data, holdForRewording, rewordTask: vi.fn() });
  await show();
  await act(async () => {});
  vi.useFakeTimers();
  try {
    await click(container.querySelector('[aria-label="Queued requests"] .queue-reword')!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(holdForRewording).toHaveBeenCalledTimes(1);
    // The words stay in the box, and the editor goes on changing them.
    expect(composer.props?.rewording).toMatchObject({ id: "task_queued_revision", text: "Keep the aside." });
    await act(async () => composer.props!.rewording!.onChange("Keep the aside, but trim the breath before it."));
    expect(composer.props?.rewording).toMatchObject({ id: "task_queued_revision", text: "Keep the aside, but trim the breath before it." });
    // The hold is asked for again shortly, well before the engine would let go of one it had.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(holdForRewording.mock.calls).toEqual([["task_queued_revision", true], ["task_queued_revision", true]]);
    expect(composer.props?.rewording?.text).toBe("Keep the aside, but trim the breath before it.");
  } finally { vi.useRealTimers(); }
});

it("offers no way to fold the queue while one of several queued requests has its words in the box", async () => {
  runningPass();
  const queued = (id: string, index: number, words: string) => {
    const asked = callRequest(id, index, { kind: "edit" as const, instruction: words });
    return { ...asked, context: { ...asked.context, message: words } };
  };
  data = { ...data, tasks: [...data.tasks, queued("task_aside", 2, "Keep the aside."), queued("task_breath", 1, "Keep the breath.")] };
  useProjectStore.setState({ current: data, holdForRewording: vi.fn().mockResolvedValue(undefined), rewordTask: vi.fn() });
  await show();
  await act(async () => {});
  const tray = () => container.querySelector<HTMLElement>('[aria-label="Queued requests"]')!;
  const heading = () => tray().querySelector<HTMLElement>(".queue-head")!;
  await click(heading());
  const row = () => [...tray().querySelectorAll<HTMLElement>(".queue-row")].find(r => r.textContent?.includes("Keep the aside."))!;
  await click(row().querySelector(".queue-reword")!);
  expect(composer.props?.rewording?.id).toBe("task_aside");
  // The reworded row stays in view, so the heading only counts: it isn't a button and has no chevron.
  expect([heading().tagName, heading().textContent, heading().querySelector(".queue-chevron"), row().classList.contains("is-rewording")])
    .toEqual(["DIV", "2 queued", null, true]);
  // With the words left as they were, the heading folds the list again.
  await act(async () => composer.props!.rewording!.onCancel());
  expect([heading().tagName, heading().getAttribute("aria-expanded"), !!heading().querySelector(".queue-chevron")]).toEqual(["BUTTON", "true", true]);
  await click(heading());
  expect(tray().querySelector(".queue-list")).toBeNull();
});

it("keeps newer wording in the box when an earlier save finishes", async () => {
  runningPass();
  data = { ...data, tasks: [...data.tasks, callRequest("task_queued_revision", 2, { kind: "edit" as const })] };
  let finish!: () => void;
  const rewordTask = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  useProjectStore.setState({ current: data, holdForRewording: vi.fn().mockResolvedValue(undefined), rewordTask });
  await show();
  await click(container.querySelector('[aria-label="Queued requests"] .queue-reword')!);
  await act(async () => { void composer.props!.rewording!.onSave("Use the shorter aside."); });
  await act(async () => composer.props!.rewording!.onChange("Keep the breath after it."));
  await act(async () => finish());
  expect(composer.props?.rewording?.text).toBe("Keep the breath after it.");
});

it("lets go of a queued request's words when Scarlet began it before they reached the box", async () => {
  runningPass();
  data = { ...data, tasks: [...data.tasks, callRequest("task_queued_revision", 2, { kind: "edit" as const })] };
  const holdForRewording = vi.fn().mockRejectedValue(new ScarletApiError(409, "already_started", "Scarlet has already started on this request."));
  useProjectStore.setState({ current: data, holdForRewording, rewordTask: vi.fn() });
  await show();
  await act(async () => {});
  await click(container.querySelector('[aria-label="Queued requests"] .queue-reword')!);
  await act(async () => {});
  expect(composer.props?.rewording).toBeUndefined();
  expect(container.querySelector(".simple-banner")?.textContent).toContain("Scarlet has already started on this request.");
  // A request Scarlet queued itself, such as a redo of a change that no longer fits, has no pencil: only its ×.
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_queued_revision" ? { ...t, createdBy: { type: "scarlet" as const, name: "Scarlet" } } : t) }));
  const row = container.querySelector('[aria-label="Queued requests"] .queue-row')!;
  expect(row.querySelector(".queue-reword")).toBeNull();
  expect(row.querySelector(".queue-text")?.classList.contains("is-rewordable")).toBe(false);
  expect(row.querySelector(".queue-remove")).not.toBeNull();
});

it("hands an interrupted pass's unchecked cuts to the editor, and takes them back when a run resumes it with a revision queued on an earlier part", async () => {
  flagged();
  const threadId = threadWith("chg_ready").id;
  const ready = data.changes.find(c => c.id === "chg_ready")!;
  // Footage stays between the staged cuts, so the pass lists each as a cut of its own.
  const cutReasons = [0, 1, 2].map(i => ({ start: i * 2, end: i * 2 + 1, reason: ["A clean retake.", "Breath before the price.", "Repeated aside."][i]! }));
  vi.spyOn(api, "cutReview").mockResolvedValue({ review: { original: data.timeline!, proposed: data.timeline!, firstCut: false,
    cuts: cutReasons.map((r, at) => ({ at, removed: { start: r.start, end: r.end }, beforeClip: 0 })) } });
  // Scarlet quit mid-pass: one cut checked, one decided by the editor, one staged and never checked.
  data = { ...data,
    changes: [{ ...ready, id: "chg_part", state: "rejected" as const, intent: "suggestion" as const, taskId: "task_done", replacedBy: "chg_ready",
        cutReasons: cutReasons.slice(0, 2), createdAt: new Date(Date.parse(ready.createdAt ?? "") - 1000).toISOString() },
      ...data.changes.map(c => c.id === "chg_ready" ? { ...c, intent: "suggestion" as const, taskId: "task_done", cutReasons,
        cutAssessments: [{ index: 1, start: 230, end: 233, verdict: "ask" as const, reason: "Breath before the price." }],
        cutChoices: [{ index: 0, start: 0, end: 1, choice: "cut" as const }] } : c)],
    tasks: data.tasks.map(t => t.id === "task_done" ? { ...t, state: "failed" as const, interrupted: true, error: "The agent was interrupted after saving changes." } : t) };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  // The calls it had before the quit are still the editor's, and nothing offers to apply the unchecked cuts.
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("2 need you");
  expect(buttonIn(passCard(), "Apply")).toBeFalsy();
  // The pass carries on under a new run. A revision sent before the quit named an earlier part of the pass.
  const base = data.tasks.find(t => t.id === "task_done")!;
  const queued = { ...base, state: "queued" as const, interrupted: undefined, error: undefined, startedAt: undefined, finishedAt: undefined, summary: null, changeIds: [] };
  data = { ...data, tasks: [...data.tasks.map(t => t.id === "task_done" ? { ...t, retryTaskId: "task_resumed" } : t),
    { ...queued, id: "task_queued_revision", instruction: "Keep the breath.", createdAt: new Date(Date.now() - 1000).toISOString(),
      context: { threadId, changeId: "chg_part", cutIndex: 1, time: 230, end: 233, message: "Keep the breath." } },
    { ...queued, id: "task_resumed", resumeRootId: "task_done", createdAt: new Date().toISOString(), context: { ...base.context, threadId } }] };
  await act(async () => { useProjectStore.setState({ current: data }); });
  // Scarlet is on the pass again and will check the cut it never reached, so that one is no longer a call. The call
  // sent back is with Scarlet too: nothing waits on the editor.
  expect(passCard().querySelector(".simple-pass-need")).toBeNull();
  const row = passRows().find(r => r.textContent?.includes("Breath before the price."))!;
  expect(row.querySelector(".simple-pass-value")?.textContent).toBe("Revising…");
  expect(passRows().some(r => r.textContent?.includes("Repeated aside."))).toBe(false);
});

it("keeps a pass's other calls open while Scarlet revises one of them, and waits for it before applying", async () => {
  const save = flagged();
  const approve = vi.fn().mockResolvedValue({ outcome: "applied" });
  const threadId = threadWith("chg_ready").id;
  const base = data.tasks.find(t => t.id === "task_done")!;
  const revision = { ...base, id: "task_revise", kind: "revise" as const, state: "running" as const, finishedAt: undefined, changeIds: [],
    instruction: "The words don't line up.", createdAt: new Date().toISOString(), startedAt: new Date().toISOString(),
    context: { threadId, changeId: "chg_ready", cutIndex: 1, time: 230, end: 233, message: "The words don't line up." } };
  data = { ...data, tasks: [...data.tasks, revision], changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, state: "revising" as const,
    intent: "suggestion" as const, cutReasons: [0, 1, 2].map(i => ({ start: i, end: i + 1, reason: `Cut ${i + 1}.` })) } : c) };
  useProjectStore.setState({ current: data, approve });
  await show();
  await act(async () => {});
  // The cut under revision leaves the calls. The other one stays open.
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("1 needs you");
  // The revision sits directly under the call it revises, named by that call's number among the pass's calls, with
  // the editor's words and Scarlet at work on it. It is no block of its own in the conversation.
  const under = passRows()[0]!.closest("li")!.querySelector<HTMLElement>(".subunit")!;
  expect([under.getAttribute("data-run"), tagIn(under), wordsOf(under.querySelector(".subunit-msg p"))])
    .toEqual(["task_revise", "Cut 1", "The words don't line up."]);
  expect(under.querySelector('[aria-label="Scarlet’s work"]')).not.toBeNull();
  expect(units().map(u => u.dataset.run)).not.toContain("task_revise");
  // Its row's word moves while Scarlet is on it.
  expect([passRows()[0]!.querySelector(".simple-pass-value")?.textContent, passRows()[0]!.querySelector(".simple-pass-value")?.classList.contains("working-text")]).toEqual(["Revising…", true]);
  expect(passCard().querySelector(".simple-pass-quiet")).toBeNull();
  await reviewCalls();
  // It is numbered among all the pass's calls, the one with Scarlet included, as its row in the list is.
  expect(container.querySelector(".simple-on-video")?.textContent).toBe("Showing cut at 9:58 · 2 of 2 · After");
  await press("a");
  expect(save).toHaveBeenLastCalledWith("chg_ready", expect.objectContaining({ choices: [{ index: 2, choice: "cut" }] }));
  // That was the last open call, but the revised cut comes back as a new one, so nothing applies yet.
  expect(approve).not.toHaveBeenCalled();
  expect(passCard().querySelector(".simple-pass-need")).toBeNull();
  expect(buttonIn(passCard(), "Apply")).toBeUndefined();
});

it("marks a revised call v2 in the list and in its card, with the earlier version on hover", async () => {
  flagged();
  const threadId = threadWith("chg_ready").id;
  const base = data.tasks.find(t => t.id === "task_done")!;
  // The editor sent the call at 9:58 back once. Its revision is the pass waiting now.
  const revision = { ...base, id: "task_revise", kind: "revise" as const, state: "done" as const, changeIds: ["chg_revised"],
    instruction: "The words don't line up.", context: { threadId, changeId: "chg_ready", cutIndex: 2, time: 598, end: 602.5, message: "The words don't line up." } };
  const first = data.changes.find(c => c.id === "chg_ready")!;
  const revised = { ...first, id: "chg_revised", taskId: "task_revise", threadId, createdAt: new Date().toISOString(),
    cutAssessments: first.cutAssessments!.map(a => a.index === 2 ? { ...a, reason: "The cut now starts in the pause." } : a) };
  data = { ...data, tasks: [...data.tasks, revision],
    changes: [...data.changes.map(c => c.id === "chg_ready" ? { ...c, state: "revising" as const } : c), revised] };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  // Among the calls, a revised one ends in its version; the note itself carries no mark.
  await click(passCard().querySelector(".simple-pass-need")!);
  expect(passCard().querySelector(".simple-pass-label small")).toBeNull();
  expect(passRows().map(r => r.querySelector(".simple-pass-value")?.textContent ?? "")).toEqual(["", "v2"]);
  await click(passRows()[1]!);
  // On the card it is the mark an edit's row has after its words, here before the note.
  const version = call().querySelector(".edit-version")!;
  expect([version.tagName, version.className, version.textContent, version.nextElementSibling?.classList.contains("edit-card-title")]).toEqual(["SMALL", "edit-version", "v2", true]);
  expect(version.getAttribute("title")).toBe("v1: The corrected image-input take belongs here.\nYou: “The words don't line up.”");
});

it("waits for a staged revision to finish while the editor decides the other calls", async () => {
  const { save } = finishedPass();
  const approve = vi.fn().mockResolvedValue({ outcome: "applied" });
  useProjectStore.setState({ approve });
  await show();
  await act(async () => {});
  // The editor sends the first call back. Its revision stages the new cut and is still at work: it checks the cut and
  // says what it found after that (2026-11-09: the last call applied the pass over it, and the engine refused
  // Scarlet's verdict on the cut as stale).
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_revise", 0, { kind: "revise" as const, state: "running" as const, startedAt: new Date().toISOString(), expectedSeconds: undefined })] }));
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_ready" ? { ...c, state: "revising" as const } : c) }));
  await revisedCut("task_revise", "chg_ready", 0, { start: 1.5, end: 3 }, "Starts in the pause.");
  await act(async () => {});
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("2 need you");
  await click(passCard().querySelector(".simple-pass-need")!);
  await press("a");
  await press("a");
  expect(save).toHaveBeenLastCalledWith("chg_revised", expect.objectContaining({ applyWhenDone: false,
    choices: [1, 2].map(index => ({ index, choice: "cut" })) }));
  expect(approve).not.toHaveBeenCalled();
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_revise" ? { ...t, state: "done" as const } : t) }));
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("1 needs you");
  await reviewCalls();
  expect(call().querySelector(".edit-card-title")?.textContent).toBe("Starts in the pause.");
  await press("a");
  expect(approve).toHaveBeenCalledWith("chg_revised", undefined, []);
});

it("draws a pass's rows and any other request's rows as one row, and a revised edit's version as one mark", async () => {
  // An applied pass and a later request, each with an edit that has been revised once and says what it did.
  const later = appliedPass(false);
  for (const list of [later.lists[later.earlier], later.lists.chg_later])
    Object.assign((list as object[]).at(-1)!, { previous: [{ changeId: "chg_old", spot: 0 }], kind: "audio", check: undefined });
  data = { ...data, changes: [...data.changes, later.change] };
  useProjectStore.setState({ current: data });
  // A test lays nothing out, but it does work out which rules apply to an element. With the simple view's stylesheet in
  // the page and its palette named, a row's type and box and a mark's look read as the chat draws them.
  const { readFileSync } = await import("node:fs");
  const sheet = document.createElement("style");
  sheet.textContent = `:root { --color-fg: white; --color-muted: silver; --color-dim: gray; --color-raised: black; }\n${readFileSync(`${import.meta.dirname}/../simple.css`, "utf8")}`;
  document.head.append(sheet);
  try {
    await show();
    await act(async () => {});
    await click(passToggle());
    await act(async () => {});
    await click(buttonIn(turnFor("chg_later"), "See edit")!);
    const pass = turnFor("chg_approved_2").querySelector<HTMLElement>(".simple-pass-list")!, edits = turnFor("chg_later").querySelector<HTMLElement>(".simple-edits")!;
    // Both are lists, a row to an item.
    expect([pass.tagName, edits.tagName]).toEqual(["OL", "OL"]);
    const drawn = (el: Element, ...properties: string[]) => { const style = getComputedStyle(el); return properties.map(property => style.getPropertyValue(property)).join(" / "); };
    // One mark for a version: small plain text after the row's words, as the row's figure is, with no box around it.
    const marks = [pass.querySelector(".simple-pass-label > .edit-version")!, edits.querySelector(".simple-edit-title > .edit-version")!];
    expect(marks.map(mark => [mark.tagName, mark.textContent, drawn(mark, "font-size", "color", "margin-left", "border", "padding")]))
      .toEqual(Array(2).fill(["SMALL", "v2", "12px / silver / 7px /  / "]));
    // One row: the same type and box, and the same figure at its end.
    const rows = marks.map(mark => mark.closest<HTMLElement>("li > button")!);
    expect(rows.map(row => [row.parentElement!.parentElement!.className, drawn(row, "font-size", "padding", "border-radius", "color")]))
      .toEqual([["simple-pass-list", "12.5px / 6px 8px / 6px / white"], ["simple-edits", "12.5px / 6px 8px / 6px / white"]]);
    expect([".simple-pass-value", ".simple-edit-value"].map((value, i) => [rows[i]!.querySelector(value)!.textContent, drawn(rows[i]!.querySelector(value)!, "font-size", "color")]))
      .toEqual(Array(2).fill(["Audio", "12px / silver"]));
  } finally {
    sheet.remove();
  }
});

it("says on a pass's row when its cut is being revised, kept or not, and that it came back revised until it is kept", async () => {
  const later = appliedPass(true);
  const thread = threadWith("chg_approved_2");
  // The editor kept "captions", and has sent it back for revision since. "wrap" came back revised with no reason of its own.
  keepEdits(PRJ, thread.id, [{ changeId: "chg_approved_2", spot: 1 }]);
  const list = later.lists[later.earlier] as object[];
  Object.assign(list[1]!, { kind: "audio" });
  Object.assign(list[2]!, { kind: "audio", previous: [{ changeId: "chg_old", spot: 0 }], check: REVISED_CHECK });
  const base = buildDb().tasks.find(t => t.id === "task_done")!;
  const now = new Date().toISOString();
  data = { ...data, tasks: [...data.tasks, { ...base, id: "task_revise_captions", state: "running" as const, createdAt: now, startedAt: now, finishedAt: undefined,
    summary: null, changeIds: [], context: { changeId: "chg_approved_2", editIndex: 1, threadId: thread.id, message: "Make them bigger" } }] };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  // Scarlet is on a request in the pass's block, so the block is fixed above the message box.
  const pass = () => container.querySelector<HTMLElement>(".simple-pin .simple-pass")!;
  await click(pass().querySelector(".simple-pass-toggle")!);
  await act(async () => {});
  const row = (label: string) => [...pass().querySelectorAll<HTMLElement>(".simple-pass-list > li > button")]
    .find(b => b.querySelector(".simple-pass-label")?.textContent?.startsWith(label))!;
  // The row of the cut being revised says so, though the editor had kept it. The one that came back revised says it
  // did, as a row in any other request's list does, until the editor keeps it (2026-11-10: the pass's rows said neither).
  // Each keeps the figure at its end, and the word follows it, as in that list.
  const stands = (label: string) => [...row(label).children].slice(-2).map(el => [el.className, el.textContent]);
  expect(stands("captions")).toEqual([["simple-pass-value", "Audio"], ["simple-pass-check is-kept working-text", "Revising…"]]);
  expect(stands("wrap")).toEqual([["simple-pass-value", "Audio"], ["simple-pass-check", "Revised"]]);
  expect(row("wrap").querySelector(".simple-pass-label small")?.textContent).toBe("v2");
  expect(row("music bed").querySelector(".simple-pass-check")).toBeNull();
});

it("marks a call v2 when the request that revised it waited its turn behind the running pass", async () => {
  runningPass();
  await show();
  await act(async () => {});
  // The editor sends the call at 0:02 back while the pass still runs, so the request waits in the queue as an edit of
  // its own, not as a revision started from the pass. It runs once the pass ends, and the engine marks the pass it replaced.
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_note1", 0, { kind: "edit" as const })] }));
  await passEnds("chg_ready", STAGED, "task_note1");
  await revisedCut("task_note1", "chg_ready", 0, { start: 1.5, end: 3 }, "Starts in the pause.");
  await runPasses("task_note1", "");
  // The cut is a call again, and says it is its second version, in the list and on its card, with what it was and the
  // note that sent it back on hover: the same as a call revised from its card once the pass had finished.
  const row = passRow("Starts in the pause.");
  expect(row.querySelector(".simple-pass-value")?.textContent).toBe("v2");
  expect(passRows().filter(r => r !== row).map(r => r.querySelector(".simple-pass-value")?.textContent ?? "")).toEqual(["", ""]);
  await click(row);
  const version = call().querySelector(".edit-version")!;
  expect([version.textContent, version.getAttribute("title")]).toEqual(["v2", "v1: A clean retake.\nYou: “Start it later.”"]);
});

it("takes a finished revision out of the conversation: what it did is on its cut, in the list and on the card", async () => {
  flagged();
  const threadId = threadWith("chg_ready").id;
  const base = data.tasks.find(t => t.id === "task_done")!;
  const revision = { ...base, id: "task_revise", kind: "revise" as const, state: "done" as const, changeIds: ["chg_revised"],
    instruction: "The words don't line up.", context: { threadId, changeId: "chg_ready", cutIndex: 2, time: 598, end: 602.5, message: "The words don't line up." } };
  // A pass saves why it proposed each cut. The revision moved the third cut's start and said so, and that pass was applied.
  const reasons = data.changes.find(c => c.id === "chg_ready")!.cutAssessments!.map(({ start, end, reason }) => ({ start, end, reason }));
  const first = { ...data.changes.find(c => c.id === "chg_ready")!, cutReasons: reasons };
  const revised = { ...first, id: "chg_revised", taskId: "task_revise", threadId, createdAt: new Date().toISOString(), state: "approved" as const,
    cutReasons: reasons.map((r, i) => i === 2 ? { ...r, start: 598.2, reason: "The cut now starts in the pause." } : r) };
  data = { ...data, tasks: [...data.tasks, revision],
    changes: [...data.changes.map(c => c.id === "chg_ready" ? { ...first, state: "rejected" as const, replacedBy: "chg_revised" } : c), revised] };
  useProjectStore.setState({ current: data });
  vi.spyOn(api, "threadEdits").mockResolvedValue({ version: data.project.head!, edits: revised.cutReasons.map((r, spot) => (
    { changeId: "chg_revised", spot, label: r.reason, range: { start: spot * 10, end: spot * 10 + 3 }, at: spot * 10 + 1.5,
      beforeCut: { version: "v_before", removed: { start: r.start, end: r.end } }, previous: [] })) });
  vi.spyOn(api, "timeline").mockResolvedValue({ timeline: { ...data.timeline!, version: "v_before" } } as never);
  await show();
  await act(async () => {});
  // The revision is done, so it has left the conversation: what it did is on its cut, in the request's list and on the card.
  expect(container.querySelector('.unit[data-run="task_revise"]')).toBeNull();
  expect(container.textContent).not.toContain("The words don't line up.");
  expect(units().map(u => u.dataset.run)).toContain("task_done");
  const listed = () => [...container.querySelectorAll<HTMLButtonElement>('.unit[data-run="task_done"] .simple-edit')];
  expect(listed()[2]!.querySelector(".simple-edit-title")?.textContent).toBe("The cut now starts in the pause.");
  await click(listed()[2]!);
  await act(async () => {});
  expect(editPanel()?.textContent).toContain("The cut now starts in the pause.");
  expect(listed()[2]!.getAttribute("aria-current")).toBe("true");
  // Scarlet's note is on the card, and nowhere in the chat as a message.
  expect(openHead()?.querySelector(".simple-msg")).toBeNull();
  await press("Escape");
  expect(editPanel()).toBeNull();
});

it("runs one request at a time: what Scarlet is on stays pinned above the message box, and queued requests wait in its tray", async () => {
  const now = new Date().toISOString();
  const pass = { ...data.tasks.find(t => t.id === "task_done")!, id: "task_pass", kind: "edit" as const, instruction: "/dialogue-pass",
    context: { threadId: "task_pass", message: "/dialogue-pass" }, state: "running" as const, changeIds: [], createdAt: now, startedAt: now, finishedAt: undefined };
  const later = (id: string, message: string, ms: number) => ({ ...pass, id, instruction: message, context: { threadId: id, message }, state: "queued" as const,
    createdAt: new Date(Date.now() + ms).toISOString(), startedAt: undefined });
  const zoom = later("task_zoom", "Zoom into the browser window during the demo.", 1000);
  const title = later("task_title", "Add a lower third with my name.", 2000);
  const cancelTask = vi.fn().mockResolvedValue(undefined);
  // Only the pass is running in this project.
  data = { ...data, tasks: [...data.tasks.map(t => ["queued", "claimed", "running", "waiting_for_user"].includes(t.state) ? { ...t, state: "done" as const } : t), pass, title, zoom] };
  useProjectStore.setState({ current: data, cancelTask });
  await show();
  // The request Scarlet is on is pinned above the message box: its message joined to its card.
  const pinned = container.querySelector<HTMLElement>(".simple-pin .unit")!;
  expect(pinned.querySelector(".unit-msg")?.textContent).toContain("/dialogue-pass");
  // Under it, one line says what Scarlet is doing this moment, and nothing else: no stages.
  expect(pinned.querySelector(".req-now .working-text")).not.toBeNull();
  expect(pinned.querySelector(".req-stage, .req-stages")).toBeNull();
  // Queued requests aren't in the chat. They wait in the tray, in running order, and the first is marked Next.
  expect(turns().some(t => t.textContent?.includes("Zoom into the browser window"))).toBe(false);
  const tray = container.querySelector<HTMLElement>('[aria-label="Queued requests"]')!;
  expect(tray.querySelector(".queue-head")?.textContent).toBe("NextZoom into the browser window during the demo.2 queued");
  expect(tray.getAttribute("title")).toBe("Starts when Scarlet finishes what it’s on");
  // It opens into every queued request, each with a way to take it out of the queue.
  await click(tray.querySelector(".queue-head")!);
  expect([...tray.querySelectorAll(".queue-row")].map(r => r.textContent)).toEqual(["NextZoom into the browser window during the demo.", "Add a lower third with my name."]);
  await click(tray.querySelectorAll<HTMLButtonElement>(".queue-remove")[1]!);
  expect(cancelTask).toHaveBeenCalledWith("task_title");
  // The engine cancels it before it ever started. It never ran, so it leaves the tray without joining the chat as a
  // stopped request with a Resume and a run time.
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_title" ? { ...t, state: "cancelled" as const, hostId: null, finishedAt: new Date().toISOString() } : t) }));
  expect(container.querySelector('[aria-label="Queued requests"]')?.textContent).toBe("NextZoom into the browser window during the demo.");
  expect(container.querySelector(".simple-thread")?.textContent).not.toContain("Add a lower third with my name.");
  expect([...container.querySelectorAll(".simple-thread button")].some(b => b.textContent === "Resume")).toBe(false);
  // A request stopped after Scarlet began it is another matter: it stays, with its Resume.
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_pass" ? { ...t, state: "cancelled" as const, finishedAt: new Date().toISOString() } : t) }));
  expect(turns().some(t => t.textContent?.includes("/dialogue-pass") && t.textContent.includes("Stopped"))).toBe(true);
  expect(container.textContent).not.toContain("Start in new thread");
  expect(container.querySelector(".simple-wait-hint")).toBeNull();
});

it("shows the recorded local pause operation after a restart without loading the skill library", async () => {
  // After a relaunch nothing has read the library: no "/" typed, and Learnings never opened.
  const library = useSkillsStore.getState();
  useSkillsStore.setState({ skills: [], status: "idle", error: null });
  const read = vi.spyOn(api, "skills").mockResolvedValue({ skills: [skillNamed("skl_dialogue", "dialogue-pass")] });
  const now = new Date().toISOString();
  const pass = { ...data.tasks.find(t => t.id === "task_done")!, id: "task_pass", kind: "edit" as const, instruction: "/tighten-pauses-here",
    context: { threadId: "task_pass", message: "/tighten-pauses-here", dialogueOperation: "local-pauses" as const, skillIds: ["skl_dialogue"] }, state: "running" as const, changeIds: [], createdAt: now, startedAt: now, finishedAt: undefined };
  data = { ...data, tasks: [...data.tasks.map(t => ["queued", "claimed", "running", "waiting_for_user"].includes(t.state) ? { ...t, state: "done" as const } : t), pass] };
  useProjectStore.setState({ current: data });
  try {
    await show();
    // Once the workspace has opened it shows the pass at work, as one asked for as /dialogue-pass does.
    const pinned = container.querySelector<HTMLElement>(".simple-pin .unit")!;
    expect(pinned.querySelector(".unit-msg")?.textContent).toContain("/tighten-pauses-here");
    expect(pinned.querySelector(".req-now .working-text")).not.toBeNull();
    // Rendering the saved operation never depends on the current guide library.
    await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_pass" ? { ...t, expectedSeconds: 600 } : t) }));
    expect(read).not.toHaveBeenCalled();
  } finally { await act(async () => useSkillsStore.setState(library, true)); }
});

it("steps through a pass's calls with ↑ and ↓, and Esc closes the call", async () => {
  flagged();
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  // ↓ starts on the first call, and steps on from there. ↑ steps back.
  await press("ArrowDown");
  expect(container.querySelector(".simple-on-video")?.textContent).toBe("Showing cut at 3:50 · 1 of 2 · After");
  await press("ArrowDown");
  expect(container.querySelector(".simple-on-video")?.textContent).toBe("Showing cut at 9:58 · 2 of 2 · After");
  await press("ArrowUp");
  expect(container.querySelector(".simple-on-video")?.textContent).toBe("Showing cut at 3:50 · 1 of 2 · After");
  await press("Escape");
  expect(container.querySelector('[aria-label="Call"]')).toBeNull();
  expect(container.querySelector(".simple-on-video")).toBeNull();
  expect(container.querySelector('[aria-label="Suggestion"]')).toBeNull();
});

it("starts ↓ on the first call still waiting when nothing is open, and ↑ on the last, as need you does", async () => {
  flagged();
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  // The first call is approved, which opens the second. Esc closes it.
  await press("ArrowDown");
  await press("a");
  expect(onVideo()).toBe("Showing cut at 9:58 · 2 of 2 · After");
  await press("Escape");
  expect(container.querySelector('[aria-label="Call"]')).toBeNull();
  // ↓ goes to the call that still waits, not back to the one already decided.
  await press("ArrowDown");
  expect(onVideo()).toBe("Showing cut at 9:58 · 2 of 2 · After");
  expect(call().querySelector(".edit-card-count")?.textContent).toBe("Cut 2");
  // From a call, the arrows still reach the one beside it, decided or not.
  await press("ArrowUp");
  expect(onVideo()).toBe("Showing cut at 3:50 · 1 of 2 · After");
  expect(buttonIn(call(), "Approve")?.getAttribute("aria-pressed")).toBe("true");
  // ↑ from nothing starts on the last call still waiting.
  await press("Escape");
  await press("ArrowUp");
  expect(onVideo()).toBe("Showing cut at 9:58 · 2 of 2 · After");
});

it("starts ↓ on the first call when every call is made and the pass hasn't applied yet", async () => {
  flagged();
  // Both calls were made in an earlier visit, and the pass waits for Apply.
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, cutChoices: [
    { index: 1, start: 230, end: 233, choice: "cut" as const }, { index: 2, start: 598, end: 602.5, choice: "keep" as const }] } : c) };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  await press("ArrowDown");
  expect(onVideo()).toBe("Showing cut at 3:50 · 1 of 2 · After");
  await press("Escape");
  await press("ArrowUp");
  expect(onVideo()).toBe("Showing cut at 9:58 · 2 of 2 · After");
});

it("labels a length in seconds under a minute, as minutes and seconds above and with its hours from an hour, carrying a rounded 60", () => {
  expect(lengthLabel(4.25)).toBe("4.3 s");
  expect(lengthLabel(42.4)).toBe("42 s");
  expect(lengthLabel(75)).toBe("1:15");
  expect(lengthLabel(119.6)).toBe("2:00");
  expect(lengthLabel(59.4)).toBe("59 s");
  expect(lengthLabel(59.7)).toBe("1:00");
  // From an hour a length reads as every clock in the app does, "1:12:15" and not "72:15". A rounded 60 minutes carries
  // to the hour.
  expect(lengthLabel(3599.4)).toBe("59:59");
  expect(lengthLabel(3599.7)).toBe("1:00:00");
  expect(lengthLabel(4335)).toBe("1:12:15");
  // So does the sentence that sums a long pass's cuts.
  const cut = (start: number, end: number) => ({ label: "A stumble", beforeCut: { version: "ver_1", removed: { start, end } } });
  expect(sentenceText(madeSentence([cut(0, 3600), cut(4000, 4735)], lengthLabel))).toBe("Took out 1:12:15 in 2 cuts.");
});

it("plans each cut's listen on the uncut video: After closes the cut up, a long Before skips its middle", () => {
  expect(cutAudition({ start: 10, end: 70 }, "after", 600)).toEqual({ start: 8, end: 73, skips: [{ start: 10, end: 70, removed: true }] });
  expect(cutAudition({ start: 10, end: 15 }, "before", 600)).toEqual({ start: 8, end: 17, skips: [] });
  expect(cutAudition({ start: 10, end: 70 }, "before", 600)).toEqual({ start: 8, end: 72, skips: [{ start: 13, end: 67 }] });
  // Near the ends of the video the context is what there is.
  expect(cutAudition({ start: 1, end: 599 }, "after", 600)).toEqual({ start: 0, end: 600, skips: [{ start: 1, end: 599, removed: true }] });
  // After also steps over other cuts that came out nearby, in order. Before plays the original through.
  const others = [{ start: 30, end: 31 }, { start: 8.5, end: 9 }, { start: 16, end: 17 }];
  expect(cutAudition({ start: 10, end: 15 }, "after", 600, { others })).toEqual({ start: 8, end: 19,
    skips: [{ start: 8.5, end: 9, removed: true }, { start: 10, end: 15, removed: true }, { start: 16, end: 17, removed: true }] });
  expect(cutAudition({ start: 10, end: 15 }, "before", 600, { others })).toEqual({ start: 8, end: 17, skips: [] });
  // An applied cut's Before plays a long passage whole.
  expect(cutAudition({ start: 10, end: 70 }, "before", 600, { whole: true })).toEqual({ start: 8, end: 72, skips: [] });
});

it("plays three seconds of kept footage after a cut through overlapping and consecutive removals", () => {
  const cut = { start: 10, end: 15 };
  const others = [{ start: 23, end: 24 }, { start: 19, end: 22 }, { start: 25, end: 26 }, { start: 16, end: 20 }];
  const listen = cutAudition(cut, "after", 30, { others });
  expect(listen).toEqual({ start: 8, end: 25, skips: [
    { ...cut, removed: true }, { start: 16, end: 22, removed: true }, { start: 23, end: 24, removed: true },
  ] });
  expect(cutAudition(cut, "after", 24.5, { others }).end).toBe(24.5);
  // Switching back to After at another cut needs three kept seconds from that join, too.
  expect(cutAudition(cut, "after", 30, { others, tailFrom: 22 }).end).toBe(27);
  expect(cutAudition(cut, "before", 30, { others, tailFrom: 22 }).end).toBe(25);
  // Adding fractional source times can put the stop a few ulps inside the next removal.
  const fractional = cutAudition({ start: 6.8, end: 9.8 }, "after", 20, {
    others: [{ start: 10.8, end: 11.8 }, { start: 13.5, end: 16.6 }, { start: 16.9, end: 17 }],
  });
  expect(fractional.end).toBeCloseTo(16.9, 9);
  expect(fractional.skips).toHaveLength(3);
});

it("revises the one call that's playing, and says so", async () => {
  flagged();
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  await reviewCalls();
  await press("r");
  expect(container.querySelector(".simple-target")?.textContent).toContain("Revising the cut at 3:50");
  expect(useUiStore.getState().agentContext).toMatchObject({ changeId: "chg_ready", cutIndex: 1, time: 230, end: 233 });
});

it("plays changed footage while the editor answers the question about that cut", async () => {
  finishedPass();
  const measured = data.timeline!;
  vi.spyOn(api, "timeline").mockResolvedValue({ timeline: measured });
  vi.spyOn(api, "transcript").mockResolvedValue(buildTranscript());
  const question = callRequest("task_pickup", 1, { kind: "revise", state: "waiting_for_user", question: "Keep the new pickup?",
    cutConflict: { version: data.project.head!, range: { start: 8, end: 10 } } });
  data = { ...data, tasks: [...data.tasks.filter(t => t.state !== "waiting_for_user"), question],
    changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, state: "revising" as const } : c) };
  useProjectStore.setState({ current: data });
  const listen = vi.spyOn(player, "audition");
  await show();
  await click(buttonIn(container, "Answer")!);
  expect(call().textContent).toContain("Needs your answer");
  expect(onVideo()).toBe("Current passage at 0:08");
  expect(listen).toHaveBeenLastCalledWith({ start: 6, end: 12, skips: [] }, expect.any(Number));
  expect(boxTag()).toBe("Answer");
  expect(useUiStore.getState().agentContext).toBeNull();
  await click(transcriptLink());
  const words = call().querySelector('[aria-label="Words in the current passage"]')!;
  expect(words.textContent?.trim()).not.toBe("");
  expect(words.querySelector("del, .edit-passage-cut")).toBeNull();
  // A later trim moves the passage during the question. Answer on the open card plays the new location.
  const shifted = { ...applyOps(measured, [{ op: "rippleDelete", start: 2, end: 3 }]), version: "newer" };
  await event(d => ({ ...d, project: { ...d.project, head: shifted.version }, timeline: shifted }));
  await click(call().querySelector('button[aria-label="Answer"]')!);
  expect(listen).toHaveBeenLastCalledWith({ start: 5, end: 11, skips: [] }, expect.any(Number));
  expect(onVideo()).toBe("Current passage at 0:07");
  expect(boxTag()).toBe("Answer");
  // When Scarlet has no unique passage, the same card can still take the editor's answer without seeking.
  listen.mockClear();
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === question.id ? { ...t, cutConflict: { version: shifted.version } } : t) }));
  await click(call().querySelector('button[aria-label="Answer"]')!);
  expect(listen).not.toHaveBeenCalled();
  expect(onVideo()).toBeFalsy();
  expect(container.querySelector(".simple-timeline-band")).toBeNull();
  expect(boxTag()).toBe("Answer");
});

it("uses the reviewed footage and preview for a call revised on a newer timeline", async () => {
  finishedPass();
  vi.spyOn(api, "transcript").mockResolvedValue({ ...buildTranscript(), segments: [] });
  const before = data.timeline!;
  const range = { start: 8, end: 10 };
  const preview = { ...applyOps(before, [{ op: "rippleDelete", ...range }]), version: "pickup-preview" };
  const load = vi.spyOn(api, "timeline").mockImplementation(async (_, version) => ({ timeline: version === preview.version ? preview : before }));
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, fromVersion: "old-pass",
    cutEdits: [{ index: 0, version: before.version, range, previewVersion: preview.version }] } : c) };
  useProjectStore.setState({ current: data });
  const listen = vi.spyOn(player, "audition");
  await show();
  await reviewCalls();
  await click(passRow(STAGED[0]!.reason));
  expect(load.mock.calls.filter(([project, version]) => project === PRJ && version === preview.version)).toHaveLength(1);
  expect(onVideo()).toBe("Showing cut at 0:08 · 1 of 3 · After");
  expect(listen).toHaveBeenLastCalledWith({ start: 6, end: 13, skips: [{ ...range, removed: true }] }, expect.any(Number));
  expect(useUiStore.getState().agentContext).toMatchObject({ cutIndex: 0, version: before.version, time: 8, end: 10 });
  await click(call().querySelector(".edit-card-before")!);
  expect(listen).toHaveBeenLastCalledWith({ start: 6, end: 12, skips: [] }, expect.any(Number));
  await click(transcriptLink());
  expect(call().querySelector(".edit-passage-cut")?.textContent).toBe("2.0 s");
  await event(d => ({ ...d, project: { ...d.project, head: "newer" }, timeline: { ...d.timeline!, version: "newer" } }));
  expect(load).toHaveBeenCalledWith(PRJ, before.version);
  expect(onVideo()).toBe("Showing cut at 0:08 · 1 of 3 · Before · As reviewed");
});

it.each([false, true])("answers the carried cut after another part moved and renumbered it (saved current index: %s)", async savedIndex => {
  runningPass();
  const request = callRequest("task_queued_revision", 1, { kind: "revise" });
  data = { ...data, tasks: [...data.tasks.filter(t => t.state !== "waiting_for_user"), request] };
  useProjectStore.setState({ current: data });
  const listen = vi.spyOn(player, "audition");
  await show();
  // The run takes out one second before the call and stages a new cut ahead of it. Its second call is now third.
  const cuts = STAGED.map(c => ({ ...c, start: c.start - 1, end: c.end - 1 }));
  cuts.splice(1, 0, { start: 3, end: 4, reason: "Another pause." });
  await nextPart({ cutReasons: cuts }, [{ start: 0, end: 1, reason: "Opening pause." }]);
  const currentPass = "chg_ready_part2";
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === currentPass
    ? { ...c, state: "revising" as const, revisionFrom: { state: "ready" as const, taskId: request.id } }
    // A timeline operation without a saved removal list needs the engine's resolved cut index.
    : savedIndex && c.id === "chg_part2_applied" ? { ...c, cutReasons: undefined } : c),
    tasks: d.tasks.map(t => t.id === request.id ? { ...t, state: "waiting_for_user" as const, question: "Keep the pickup?",
      cutConflict: { version: d.project.head!, range: { start: 8, end: 10 }, ...(savedIndex && { changeId: currentPass, index: 2 }) } }
      : t.id === "task_done" ? { ...t, state: "done" as const } : t) }));
  await click(buttonIn(container, "Answer")!);
  expect(call().querySelector(".edit-card-count")?.textContent).toBe("Cut 3");
  expect(call().textContent).toContain(STAGED[1]!.reason);
  expect(onVideo()).toBe("Current passage at 0:08");
  expect(boxTag()).toBe("Answer");
  await click(call().querySelector('button[aria-label="Answer"]')!);
  expect(listen).toHaveBeenLastCalledWith({ start: 6, end: 12, skips: [] }, expect.any(Number));
  expect(useUiStore.getState().agentContext).toBeNull();
});

it("revises just the applied edit that's showing, even with a pass waiting, and marks where its cut came out", async () => {
  flagged();
  useProjectStore.setState({ current: data });
  vi.spyOn(api, "threadEdits").mockResolvedValue({ version: data.project.head!, edits: [
    { changeId: "chg_approved_2", spot: 0, label: "Keep the image test", range: { start: 8, end: 12 }, at: 10,
      beforeCut: { version: "v_before", removed: { start: 10, end: 12.4 } }, previous: [] },
  ] });
  // This case opens the passage while its transcript request is still in flight.
  vi.spyOn(api, "transcript").mockReturnValue(new Promise(() => {}));
  const beforeTimeline = vi.spyOn(api, "timeline").mockResolvedValue({ timeline: { ...data.timeline!, version: "v_before" } } as never);
  const audition = vi.spyOn(player, "audition");
  await show();
  await click(buttonIn(turnFor("chg_approved_2"), "See edit")!);
  await act(async () => {});
  // The edit on screen hides the pass that's waiting. Its chat row says how much came out, and so does the timeline.
  expect(container.querySelector('[aria-label="Suggestion"]')).toBeNull();
  const bar = editPanel()!;
  expect(buttonIn(bar, "Apply")).toBeUndefined();
  expect(turnFor("chg_approved_2").querySelector(".simple-edit.is-on .simple-edit-value")?.textContent).toBe("−2.4 s");
  expect(container.textContent).toContain("Removed · 2.4 s");
  // It quotes what the cut took out, struck through, and plays on the version before it: the timeline shades what came out
  // and After steps over it.
  expect(beforeTimeline).toHaveBeenCalledWith(PRJ, "v_before");
  expect(container.querySelector(".simple-timeline-band")?.textContent).toBe("Removed · 2.4 s");
  // The timeline is on the version before the cut, where the waiting pass's times don't hold: its calls draw no dot here.
  expect(container.querySelector(".simple-timeline-mark")).toBeNull();
  expect(container.querySelector(".simple-on-video")?.textContent).toBe("Showing “Keep the image test” · After");
  // A cut has no Before/After switch. One icon plays it with the cut footage: unlit while it plays as the video runs.
  expect(bar.querySelector(".compare-switch")).toBeNull();
  expect(beforeIcon(bar)).toEqual(["", "Before", "false", "Play Before (\\)"]);
  // Hovering it names its key. Nothing is drawn between the card and the band.
  expect(bar.querySelector(".edit-card-before")?.getAttribute("aria-keyshortcuts")).toBe("\\");
  // The card is one row. The cut's words are folded behind a small icon.
  expect(bar.querySelector(".edit-card-script, .review-step, .edit-passage")).toBeNull();
  const script = transcriptLink();
  expect([...transcriptName(), script.getAttribute("aria-expanded")]).toEqual(["", "Show transcript", "Show transcript", "false"]);
  expect(openHead()!.querySelector(".edit-passage")).toBeNull();
  // Opened, the mark where the cut joins says how much came out, in red: it is applied. The icon folds it away again.
  await click(script);
  expect([...transcriptName(), transcriptLink().getAttribute("aria-expanded")]).toEqual(["", "Hide transcript", "Hide transcript", "true"]);
  expect(openHead()!.querySelector(".thread-passage:not(.is-call) .edit-passage-cut")?.textContent).toBe("2.4 s");
  // The words around it are still on their way, and the passage says so.
  expect(openHead()!.querySelector(".edit-passage-wait")?.textContent).toBe("Loading the words…");
  await click(transcriptLink());
  expect(openHead()!.querySelector(".edit-passage")).toBeNull();
  expect(container.querySelector(".simple-timeline-bracket")).toBeNull();
  expect(audition).toHaveBeenLastCalledWith({ start: 8, end: 15.4, skips: [{ start: 10, end: 12.4, removed: true }] }, expect.any(Number));
  // After steps over the shaded passage, so a click inside it plays it in Before from that point, and the icon lights
  // by itself, with a flash. Without layout the click lands on the passage's first frame.
  const band = () => container.querySelector<HTMLElement>(".simple-timeline-band")!;
  expect(band().classList.contains("is-live")).toBe(true);
  await act(async () => { band().dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, isPrimary: true, button: 0, bubbles: true })); });
  expect(audition).toHaveBeenLastCalledWith({ start: 8, end: 14.4, skips: [], from: 10 }, expect.any(Number));
  expect(usePlayerStore.getState().scrubGesture).toBeUndefined();
  expect(beforeIcon(bar)).toEqual(["", "Before", "true", "Back to After (\\)"]);
  expect(bar.querySelector(".edit-card-before.is-flash")).not.toBeNull();
  // It is this cut's own footage, so nothing above the card's row says whose it is.
  expect(container.querySelector(".edit-card-switched")).toBeNull();
  // On Before the passage plays, and scrubs as any footage.
  expect(band().classList.contains("is-live")).toBe(false);
  // \\ goes back, and plays the join from the top.
  await press("\\");
  expect(beforeIcon(bar)).toEqual(["", "Before", "false", "Play Before (\\)"]);
  expect(bar.querySelector(".edit-card-before.is-flash")).toBeNull();
  expect(audition).toHaveBeenLastCalledWith({ start: 8, end: 15.4, skips: [{ start: 10, end: 12.4, removed: true }] }, expect.any(Number));
  // \\ switches to Before, which plays straight through the cut.
  await press("\\");
  expect(beforeIcon(bar)).toEqual(["", "Before", "true", "Back to After (\\)"]);
  expect(container.querySelector(".simple-on-video")?.textContent).toBe("Showing “Keep the image test” · Before");
  expect(audition).toHaveBeenLastCalledWith({ start: 8, end: 14.4, skips: [] }, expect.any(Number));

  await click(buttonIn(bar, "Revise")!);
  expect(container.querySelector(".simple-target")?.textContent).toContain("Revising “Keep the image test” at 0:10");
  expect(useUiStore.getState().agentContext).toMatchObject({ changeId: "chg_approved_2" });

  // The pass that's waiting is still counted on its card in the chat.
  await press("Escape");
  expect(editPanel()).toBeNull();
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("2 need you");
});

it("lists each edit a version made in History, which only shows versions and changes nothing", async () => {
  await act(async () => root.render(<MemoryRouter><ChangelogPage /></MemoryRouter>));
  await act(async () => {});
  await click([...container.querySelectorAll(".version-row")].find(r => r.textContent?.includes("Tighten the wrap"))!);
  const edits = container.querySelector('[aria-label="Edits in this version"]')!;
  expect(edits.querySelector(".version-edits-head")?.textContent).toBe("3 edits");
  expect([...edits.querySelectorAll(".version-edit-label")].map(l => l.firstChild?.textContent).sort()).toEqual(["captions", "music bed", "wrap"]);
  // An open version lists what it did. It has no player, and the only buttons are the two tabs and the version rows.
  expect(container.querySelector("video, .clip-monitor, .edit-card-before, select, input, [role='combobox']")).toBeNull();
  const buttons = [...container.querySelectorAll("button")];
  expect(buttons.filter(b => !b.classList.contains("version-row")).map(b => b.textContent)).toEqual(["Edit versions", "Full history"]);
});

const menuItems = () => [...container.querySelectorAll('[role="menuitem"]')].map(i => i.textContent?.trim());
const menuItem = (text: string) => [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(i => i.textContent?.trim() === text)!;

it("drags the divider to resize the chat against the player, and remembers the width", async () => {
  vi.stubGlobal("innerWidth", 2000);
  localStorage.removeItem("scarlet.simpleChatWidth");
  try {
    await show();
    const divider = () => container.querySelector<HTMLElement>('[role="separator"][aria-label="Resize chat"]')!;
    const rail = container.querySelector<HTMLElement>("#simple-chat")!;
    expect(divider().getAttribute("aria-controls")).toBe("simple-chat");
    expect(rail.style.width).toBe("480px");
    divider().setPointerCapture = vi.fn();
    const pointer = (type: string, clientX: number) => new PointerEvent(type, { bubbles: true, button: 0, isPrimary: true, pointerId: 1, clientX });
    await act(() => divider().dispatchEvent(pointer("pointerdown", 480)));
    await act(() => divider().dispatchEvent(pointer("pointermove", 580)));
    expect(rail.style.width).toBe("580px");
    // It stops where the chat still has room for its words.
    await act(() => divider().dispatchEvent(pointer("pointermove", 100)));
    expect([rail.style.width, divider().getAttribute("aria-valuemin")]).toEqual(["320px", "320"]);
    await act(() => divider().dispatchEvent(pointer("pointerup", 800)));
    expect(localStorage.getItem("scarlet.simpleChatWidth")).toBe("800");
    await act(async () => root.render(null));
    await show();
    expect(container.querySelector<HTMLElement>("#simple-chat")!.style.width).toBe("800px");
  } finally { localStorage.removeItem("scarlet.simpleChatWidth"); }
});

const openMenu = () => click(container.querySelector('[aria-label="More"]')!);
const moreButton = () => container.querySelector<HTMLElement>('[aria-label="More"]')!;
/** A row of the menu by its name, whatever status or mark follows the name. */
const menuRow = (name: string) => [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(i => i.textContent?.trim().startsWith(name))!;
/** The ring around the menu's button while videos cache, and how much of it is drawn, out of 100. */
const cachingRing = () => moreButton().querySelector<SVGElement>(".simple-more-ring");
const ringDrawn = (ring = cachingRing()) => Math.round(100 - Number(ring?.querySelector("circle + circle")?.getAttribute("stroke-dashoffset")));
const exportButton = () => buttonIn(container.querySelector(".simple-tools")!, "Export")!;
/** What hovering the menu's button says. */
const moreTitle = () => moreButton().querySelector<HTMLElement>(".simple-more")!.title;

it("opens Media and Export from the header and keeps project tools in the menu", async () => {
  await show();
  const back = container.querySelector<HTMLAnchorElement>('a[href="/"]');
  expect(back?.getAttribute("aria-label")).toBe("All projects");
  const tools = container.querySelector(".simple-tools")!;
  for (const [name, field] of [["Media", "#media-file-types"], ["Export", "#export-format"]] as const) {
    await click(buttonIn(tools, name)!);
    await act(async () => { await vi.dynamicImportSettled(); });
    const dialog = container.querySelector("dialog[open]")!;
    expect(dialog.querySelector(field)).not.toBeNull();
    await click(dialog.querySelector('button[aria-label="Close"]')!);
  }
  expect(moreButton().querySelector(".needs-you")).toBeNull();
  expect(moreButton().getAttribute("aria-description")).toBeNull();
  await openMenu();
  expect(menuItems().filter(name => !name?.startsWith("Model") && name !== "Set up a model")).toEqual(["Learnings", "Media", "History", "Transcript", "Export", "Project settings", "App settings"]);
  expect(container.querySelector('[role="menu"] .menu-dot')).toBeNull();
  await click(menuItem("Project settings"));
  expect(useUiStore.getState().projectSettingsOpen).toBe(true);
  useUiStore.getState().setProjectSettingsOpen(false);
  await openMenu();
  await click(menuItem("History"));
  expect(document.querySelector("dialog[open]")?.textContent).toContain("History");
});

/** The Transcript from the menu, once its pane and the words have loaded. */
const openTranscript = async () => {
  vi.spyOn(api, "transcript").mockImplementation(async mediaId => buildDb().transcripts[mediaId]!);
  await openMenu();
  await click(menuItem("Transcript"));
  await act(async () => { await vi.dynamicImportSettled(); });
  await vi.waitFor(() => expect(container.querySelector(".simple-transcript [data-w]")).not.toBeNull());
};

it("heads the Transcript with one row: its name once, its figures and help mark, and the way back", async () => {
  await show();
  await openTranscript();
  const head = container.querySelector<HTMLElement>(".simple-subhead")!;
  expect([...head.children].map(c => c.textContent || c.querySelector("[aria-label]")?.getAttribute("aria-label")))
    .toEqual(["Transcript", "0:00–0:16 · 35 words", "Back to chat"]);
  // The figures and the help mark are the pane's, drawn on the heading. The pane has no title of its own.
  expect([...head.querySelectorAll(".simple-subhead-tools > *")].map(e => e.textContent || e.getAttribute("aria-label"))).toEqual(["0:00–0:16 · 35 words", "Keyboard shortcuts"]);
  const pane = container.querySelector<HTMLElement>(".simple-transcript")!;
  expect(pane.querySelector(".reading-toolbar, .reading-title, h2")).toBeNull();
  expect((head.textContent! + pane.textContent!).match(/Transcript|Current edit/g)).toEqual(["Transcript"]);
  // The help mark still opens the keys, under the heading.
  await click(head.querySelector('[aria-label="Keyboard shortcuts"]')!);
  expect(pane.querySelector(".reading-keys")?.textContent).toContain("Play from word");
  await click(buttonIn(head, "Back to chat")!);
  expect(container.querySelector(".simple-subhead, .simple-transcript")).toBeNull();
});

it("keeps what Scarlet is on above the message box while the Transcript is open, and goes back to the chat on Esc or a sent message", async () => {
  appliedEdits();
  // Scarlet has asked a question, and nothing else is running.
  const base = data.tasks.find(t => t.kind !== "transcribe")!;
  const now = new Date().toISOString();
  data = { ...data, tasks: [...data.tasks.map(t => ["queued", "claimed", "running", "waiting_for_user"].includes(t.state) ? { ...t, state: "done" as const, question: null } : t),
    { ...base, id: "task_asking", state: "waiting_for_user" as const, createdAt: now, startedAt: now, finishedAt: undefined, summary: null, changeIds: [],
      question: "Smaller by how much?", instruction: "Make the logo smaller.", context: { threadId: "task_asking", message: "Make the logo smaller." } }] };
  useProjectStore.setState({ current: data });
  await show();
  const chat = () => container.querySelector<HTMLElement>(".simple-chat")!;
  const pin = () => container.querySelector<HTMLElement>(".simple-pin")!;
  const transcript = () => container.querySelector(".simple-transcript");
  await openTranscript();
  // The transcript takes the chat's side. The request Scarlet is on keeps its place: its Stop, its question and Answer
  // are still there, so the message box doesn't say Answer with no question on screen.
  expect(chat().hidden).toBe(true);
  expect(pin().hidden).toBe(false);
  expect(pin().querySelector(".unit-msg")?.textContent).toContain("Make the logo smaller.");
  expect(buttonIn(pin(), "Stop")).toBeTruthy();
  expect(pin().querySelector(".req-say")?.textContent).toBe("Smaller by how much?Answer");
  expect(boxTag()).toBe("Answer");
  // Esc goes back to the chat.
  await press("Escape");
  expect(transcript()).toBeNull();
  expect(chat().hidden).toBe(false);
  // So does a message that was sent: the chat is where it went.
  await openTranscript();
  await act(async () => composer.props!.onSent!());
  expect(transcript()).toBeNull();
  // An edit that's open takes Esc first, then the Transcript.
  await click(turnFor("chg_approved_2").querySelectorAll<HTMLElement>(".simple-edits .simple-edit")[1]!);
  await act(async () => {});
  expect(editPanel()).not.toBeNull();
  await openTranscript();
  await press("Escape");
  expect([!!editPanel(), !!transcript()]).toEqual([false, true]);
  await press("Escape");
  expect(transcript()).toBeNull();
});

it("caches the edit without a ring on the picture or a word on the menu's Media row, which is about the videos", async () => {
  const caching = { ...data.renders.find(r => r.kind === "full")!, id: "rnd_caching", state: "running" as const, progress: 0.42 };
  vi.spyOn(api, "renders").mockResolvedValue({ renders: [caching], fullRenderKeys: data.fullRenderKeys });
  await show();
  await act(async () => {});
  expect(container.querySelector(".simple-cache")).toBeNull();
  expect(cachingRing()).toBeNull();
  await openMenu();
  expect(menuRow("Media").textContent).toBe("Media");
  expect(menuItems()).not.toContain("Pause caching");
});

it("marks the menu and its Media row when a file couldn't be read or a transcription stopped, and not otherwise", async () => {
  await show();
  await act(async () => {});
  expect(moreButton().querySelector(".needs-you")).toBeNull();
  // A file that couldn't be read is explained only in Media, so the menu that leads there says so.
  const [broken, silent] = data.media.filter(m => m.kind === "video" || m.kind === "audio");
  data = { ...data, media: data.media.map(m => m.id === broken!.id ? { ...m, status: "failed" as const, error: "moov atom not found" } : m) };
  await act(async () => useProjectStore.setState({ current: data }));
  expect(moreButton().querySelector(".needs-you")).not.toBeNull();
  expect(moreButton().getAttribute("aria-description")).toBe(`Couldn’t read ${broken!.name}`);
  await openMenu();
  expect(menuRow("Media").querySelector(".menu-dot")?.getAttribute("aria-label")).toBe(`Couldn’t read ${broken!.name}`);
  expect(menuRow("Media").title).toContain(`Couldn’t read ${broken!.name}`);
  expect(menuRow("Learnings").querySelector(".menu-dot")).toBeNull();
  // So is a recording whose transcription stopped before it had a transcript.
  const stopped = { ...data.tasks[0]!, id: "task_transcribe_stopped", kind: "transcribe" as const, agent: "api" as const, state: "failed" as const, interrupted: true,
    error: "Transcription was interrupted.", instruction: `Transcribe ${silent!.name}`, context: { mediaId: silent!.id }, changeIds: [], createdAt: new Date().toISOString() };
  data = { ...data, media: data.media.map(m => m.id === silent!.id ? { ...m, transcriptId: undefined } : m), tasks: [...data.tasks, stopped] };
  await act(async () => useProjectStore.setState({ current: data }));
  expect(moreButton().getAttribute("aria-description")).toBe("2 files need attention");
});

it("marks the menu and its Media row when a file failed to import, until Media's list of imports lets it go", async () => {
  vi.spyOn(api, "importMedia").mockRejectedValue(new Error("Scarlet couldn’t read this file."));
  await show();
  await act(async () => { await enqueueImports(PRJ, ["/Users/me/Movies/drone.mov"]); });
  expect(moreButton().querySelector(".needs-you")).not.toBeNull();
  expect(moreButton().getAttribute("aria-description")).toBe("Some files need attention");
  await openMenu();
  // The row the mark is about carries it, and says the same on hover.
  expect([...container.querySelectorAll('[role="menu"] .menu-dot')]).toEqual([menuRow("Media").querySelector(".menu-dot")]);
  expect(menuRow("Media").querySelector(".menu-dot")?.getAttribute("aria-label")).toBe("Some files need attention");
  expect(menuRow("Media").title).toBe("Some files need attention");
  // Media lists the file with why it failed. Dismissed there, nothing is marked.
  await click(menuRow("Media"));
  await act(async () => { await vi.dynamicImportSettled(); });
  await vi.waitFor(() => expect(document.querySelector('dialog[open] [aria-label="Dismiss"]')).not.toBeNull());
  expect(document.querySelector("dialog[open]")?.textContent).toContain("Scarlet couldn’t read this file.");
  await click(document.querySelector('dialog[open] [aria-label="Dismiss"]')!);
  expect(moreButton().querySelector(".needs-you")).toBeNull();
  expect(container.querySelector(".simple-banner")).toBeNull();
});

it("opens the model selector beside the menu, level with its row, and keeps the arrow keys in it", async () => {
  const hosts = useHostsStore.getState();
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 780);
  try {
    useHostsStore.setState({ hosts: buildDb().hosts, status: "ready" });
    await show();
    await openMenu();
    const row = menuRow("Model");
    expect(row.querySelector(".menu-value")?.textContent).toBe("Opus 5.5");
    // The menu hangs from ⋯ at the chat's right edge. The selector is 352px wide and 250px tall.
    vi.spyOn(container.querySelector('[role="menu"]')!, "getBoundingClientRect").mockReturnValue(new DOMRect(130, 50, 240, 312));
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(new DOMRect(134, 246, 232, 32));
    const selectorSize = (size: number) => function (this: HTMLElement) { return this.getAttribute("aria-label") === "Model selector" ? size : 0; };
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(selectorSize(352));
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(selectorSize(250));
    const key = (name: string) => act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); });
    const focused = () => document.activeElement?.getAttribute("aria-label");
    // With the selector closed, the arrows step through the menu's rows.
    row.focus();
    await key("ArrowDown");
    expect(document.activeElement?.textContent).toBe("Project settings");
    await click(row);
    const selector = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Model selector"]')!;
    // It opens clear of the menu's right edge and level with the Model row, so Project settings and App settings under
    // that row stay in view.
    expect([selector.style.left, selector.style.top]).toEqual(["376px", "246px"]);
    // ↓ from the search goes into the models and stays there: the menu's own rows aren't stepped through behind it.
    expect(focused()).toBe("Search models");
    await key("ArrowDown");
    expect(focused()).toBe("Claude Code · Opus 5.5");
    await key("ArrowDown");
    expect(focused()).toBe("Claude Code · Sonnet 5.5");
    await key("ArrowUp");
    await key("ArrowUp");
    expect(focused()).toBe("Claude Code · Fable 5.1");
    for (const name of ["Home", "End"]) { await key(name); expect(focused()).toBe("Claude Code · Fable 5.1"); }
  } finally {
    await act(async () => { useHostsStore.setState(hosts, true); });
  }
});

it("opens the model selector under its row when the window has no room beside the menu", async () => {
  const hosts = useHostsStore.getState();
  vi.stubGlobal("innerWidth", 560);
  vi.stubGlobal("innerHeight", 780);
  try {
    useHostsStore.setState({ hosts: buildDb().hosts, status: "ready" });
    await show();
    await openMenu();
    const row = menuRow("Model");
    vi.spyOn(container.querySelector('[role="menu"]')!, "getBoundingClientRect").mockReturnValue(new DOMRect(130, 50, 240, 312));
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(new DOMRect(134, 246, 232, 32));
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) { return this.getAttribute("aria-label") === "Model selector" ? 352 : 0; });
    await click(row);
    const selector = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Model selector"]')!;
    expect([selector.style.left, selector.style.top]).toEqual(["14px", "284px"]);
  } finally {
    await act(async () => { useHostsStore.setState(hosts, true); });
  }
});

it("keeps the menu's Model row while no model is ready, and marks it only once waiting won't bring one", async () => {
  const hosts = useHostsStore.getState();
  try {
    // The list of hosts hasn't arrived yet. That passes by itself: the row says so and nothing is marked.
    useHostsStore.setState({ hosts: [], status: "loading" });
    await show();
    await openMenu();
    expect(menuRow("Model").textContent).toBe("ModelConnecting…");
    expect(container.querySelector('[role="menu"] .menu-dot')).toBeNull();
    expect(moreButton().querySelector(".needs-you")).toBeNull();
    // A host that was signed in is offline: no request can run until the editor looks into it.
    await act(async () => useHostsStore.setState({ hosts: buildDb().hosts.map(h => ({ ...h, online: false })), status: "ready" }));
    expect(menuRow("Model").textContent).toBe("ModelOffline");
    expect([...container.querySelectorAll('[role="menu"] .menu-dot')]).toEqual([menuRow("Model").querySelector(".menu-dot")]);
    expect(moreButton().querySelector(".needs-you")).not.toBeNull();
    expect(moreButton().getAttribute("aria-description")).toBe("No model is ready");
    // The row opens the sign-in, which says what is wrong with the host.
    await click(menuRow("Model"));
    expect(useUiStore.getState().agentSetupOpen).toBe(true);
    // Back online, the row names the model in use and the mark goes.
    await act(async () => useHostsStore.setState({ hosts: buildDb().hosts }));
    expect(menuRow("Model").querySelector(".menu-value")?.textContent).toBe("Opus 5.5");
    expect(container.querySelector('[role="menu"] .menu-dot')).toBeNull();
    expect(moreButton().querySelector(".needs-you")).toBeNull();
  } finally {
    await act(async () => { useHostsStore.setState(hosts, true); useUiStore.getState().setAgentSetupOpen(false); });
  }
});

it("says how far a video's cache has got on the menu's Media row, with Pause under it", async () => {
  const [first, ...rest] = data.media.filter(m => m.kind === "video");
  vi.spyOn(api, "sourceCaches").mockResolvedValue({ caches: [
    { mediaId: first!.id, state: "caching", progress: 0.3 }, ...rest.map(m => ({ mediaId: m.id, state: "ready" as const })),
  ] });
  const updateProject = vi.fn().mockResolvedValue(undefined);
  useProjectStore.setState({ updateProject });
  await show();
  await act(async () => {});
  // Caching needs nothing from the editor, so the menu isn't marked for it. Media is inside the menu, so its button
  // shows the caching instead: a ring drawn as far as the cache has got, named on hover in the Media row's words.
  expect(moreButton().querySelector(".needs-you")).toBeNull();
  expect(ringDrawn()).toBe(30);
  expect(cachingRing()!.classList.contains("is-unknown")).toBe(false);
  expect(moreTitle()).toBe("Caching 30%");
  expect(moreButton().getAttribute("aria-description")).toBe("Caching 30%");
  // The menu button draws the ring without repeating its status in text.
  expect(moreButton().textContent).toBe("");
  await openMenu();
  expect(menuRow("Media").querySelector(".menu-value")?.textContent).toBe("Caching 30%");
  expect(menuRow("Media").title).toBe(rest.length ? `${rest.length} of ${rest.length + 1} videos cached` : "Caching for playback");
  await click(menuItem("Pause caching"));
  expect(updateProject).toHaveBeenCalledWith({ mediaPaused: true });
  expect(container.querySelector('[role="menu"]')).toBeNull();
});

it("draws a ring around the menu's button only while videos cache, under the mark for what needs the editor", async () => {
  const [first, ...rest] = data.media.filter(m => m.kind === "video");
  const others = rest.map(m => ({ mediaId: m.id, state: "ready" as const }));
  const caches = vi.spyOn(api, "sourceCaches").mockResolvedValue({ caches: [{ mediaId: first!.id, state: "ready" }, ...others] });
  /** The engine's next answer, read as it is when footage or a cache changes. */
  const cachesBecome = async (cache: Omit<SourceCacheStatus, "mediaId">, change: Partial<typeof data> = {}) => {
    caches.mockResolvedValue({ caches: [{ mediaId: first!.id, ...cache }, ...others] });
    data = { ...data, ...change, sourcePreviewRevisions: { ...data.sourcePreviewRevisions, [first!.id]: (data.sourcePreviewRevisions?.[first!.id] ?? 0) + 1 } };
    await act(async () => useProjectStore.setState({ current: data }));
    await act(async () => {});
  };
  await show();
  await act(async () => {});
  // Every video cached: the button is as it always is.
  expect(cachingRing()).toBeNull();
  expect(moreTitle()).toBe("More");
  expect(moreButton().getAttribute("aria-description")).toBeNull();
  // A cache starts and the engine has no figure yet: a quarter of the ring, which turns.
  await cachesBecome({ state: "caching" });
  expect(cachingRing()!.classList.contains("is-unknown")).toBe(true);
  expect(ringDrawn()).toBe(25);
  expect(moreTitle()).toBe("Caching");
  await cachesBecome({ state: "caching", progress: 0.71 });
  expect(cachingRing()!.classList.contains("is-unknown")).toBe(false);
  expect(ringDrawn()).toBe(71);
  expect(moreTitle()).toBe("Caching 71%");
  // A file that needs the editor still marks the button, and is said first.
  const broken = rest[0] ?? first!;
  await cachesBecome({ state: "caching", progress: 0.71 }, { media: data.media.map(m => m.id === broken.id ? { ...m, status: "failed" as const, error: "moov atom not found" } : m) });
  expect(moreButton().querySelector(".needs-you")).not.toBeNull();
  expect(cachingRing()).not.toBeNull();
  expect(moreTitle()).toBe(`Couldn’t read ${broken.name}. Caching 71%`);
  await cachesBecome({ state: "caching", progress: 0.71 }, { media: data.media.map(m => m.id === broken.id ? { ...m, status: "ready" as const, error: undefined } : m) });
  // Paused, nothing is caching: the ring is gone, and nothing under the header says so. The menu's Media row does.
  await cachesBecome({ state: "uncached", queued: true }, { project: { ...data.project, mediaPaused: true } });
  expect(cachingRing()).toBeNull();
  expect(container.querySelector(".simple-banner")).toBeNull();
  // Cached: the ring goes.
  await cachesBecome({ state: "caching", progress: 0.9 }, { project: { ...data.project, mediaPaused: false } });
  expect(ringDrawn()).toBe(90);
  await cachesBecome({ state: "ready" });
  expect(cachingRing()).toBeNull();
  expect(moreTitle()).toBe("More");
});

it("says that caching is paused once, on the menu's Media row with Resume under it, and in no banner", async () => {
  data = { ...data, project: { ...data.project, mediaPaused: true } };
  const [video] = data.media.filter(m => m.kind === "video");
  vi.spyOn(api, "sourceCaches").mockResolvedValue({ caches: [{ mediaId: video!.id, state: "uncached", queued: true }] });
  const updateProject = vi.fn().mockResolvedValue(undefined);
  useProjectStore.setState({ current: data, updateProject });
  await show();
  await act(async () => {});
  // The editor paused it, so nothing under the header says so, and nothing is amber or marked for it.
  expect(container.querySelector(".simple-banner")).toBeNull();
  expect(container.querySelector("#simple-chat")!.textContent).not.toMatch(/paused|Resume/i);
  expect(moreButton().querySelector(".needs-you")).toBeNull();
  await openMenu();
  expect(menuRow("Media").querySelector(".menu-value")?.textContent).toBe("Paused");
  expect(menuRow("Media").title).toBe("Caching is paused");
  await click(menuItem("Resume caching"));
  expect(updateProject).toHaveBeenCalledExactlyOnceWith({ mediaPaused: false });
});

it("says how an export is going on the menu's Export row, and marks the menu for one that stopped until Export has shown why", async () => {
  const file = { name: "Interview.mp4", format: "mp4" as const, video: { kind: "full" as const, quality: "delivery" as const } };
  const context = fullRenderContext(data.project);
  const running: ExportJob = { file, context, version: data.project.head!, phase: "rendering", progress: 0.42, cancel: () => {} };
  const exports = (job: ReturnType<typeof useExports.getState>["jobs"][string]) => act(async () => useExports.setState({ jobs: { [PRJ]: job } }));
  await show();
  await openMenu();
  const row = () => menuRow("Export");
  const says = () => [row().querySelector(".menu-value")?.textContent, row().querySelector(".menu-dot")?.getAttribute("aria-label")];
  expect(row().textContent).toBe("Export");
  // A percent while its count moves, and the word alone while it waits to start or finishes: no figure that sits still.
  await exports(running);
  expect(says()).toEqual(["Exporting 42%", undefined]);
  await exports({ ...running, waiting: true, progress: 0 });
  expect(says()).toEqual(["Exporting", undefined]);
  await exports({ ...running, progress: 0.97 });
  expect(says()).toEqual(["Exporting", undefined]);
  await exports({ ...running, phase: "saving", progress: 1 });
  expect(says()).toEqual(["Exporting", undefined]);
  // An export under way needs nothing from the editor, so the menu isn't marked.
  expect(moreButton().querySelector(".needs-you")).toBeNull();
  await click(row());
  const saving = container.querySelector("dialog[open]")!;
  expect(saving.textContent).toContain("Saving file…");
  expect(buttonIn(saving, "Cancel export")).toBeUndefined();
  await click(buttonIn(saving, "Continue editing")!);
  expect(container.querySelector("dialog[open]")).toBeNull();
  await openMenu();
  // Done: the row says so, with the file's name on hover, for as long as the video is the one that was exported.
  await exports({ phase: "done", path: "/Users/me/Movies/Interview.mp4", context });
  expect([...says(), row().title]).toEqual(["Exported", undefined, "Interview.mp4"]);
  expect(moreButton().querySelector(".needs-you")).toBeNull();
  await exports({ phase: "done", path: "/Users/me/Movies/Interview.mp4", context: "an earlier video" });
  expect(row().textContent).toBe("Export");
  // One that stopped marks the row and the menu's button, with no count.
  await exports({ phase: "failed", error: "Disk full", file, context });
  expect(says()).toEqual([undefined, "The export didn’t finish"]);
  expect(moreButton().querySelector(".needs-you")).not.toBeNull();
  expect(moreButton().getAttribute("aria-description")).toBe("The export didn’t finish");
  // The row opens Export, which says why and offers Retry. With that in front of the editor the mark goes.
  await click(row());
  const sheet = document.querySelector("dialog[open]")!;
  expect(sheet.textContent).toContain("Disk full");
  expect(buttonIn(sheet, "Retry")).toBeDefined();
  expect(moreButton().querySelector(".needs-you")).toBeNull();
  await click(buttonIn(sheet, "Cancel")!);
  await openMenu();
  expect(row().textContent).toBe("Export");
});

it("continues editing during an export and reopens the original range, quality and resolution from the header", async () => {
  const choose = vi.spyOn(desktop, "chooseVideoExport").mockResolvedValue({ ticket: 9, path: "/chosen/cut.mp4" });
  vi.spyOn(desktop, "keepVideoExport").mockResolvedValue();
  vi.spyOn(desktop, "discardVideoExport").mockResolvedValue();
  const release = vi.spyOn(api, "releaseRender").mockResolvedValue();
  const request = vi.spyOn(api, "requestRender").mockImplementation(async (_id, body) => ({ render: {
    ...data.renders[0]!, id: "custom-export", kind: body.kind!, version: body.version!, quality: body.quality,
    range: body.range!, exportOptions: body.exportOptions, state: "running", progress: 0.42,
  } }));
  await show();
  const sheet = () => container.querySelector<HTMLDialogElement>("dialog[open]")!;
  const field = (id: string) => sheet().querySelector<HTMLButtonElement>(id)!;
  await click(exportButton());
  await selectOption(field("#export-range"), "Custom range");
  await click(sheet().querySelector("summary")!);
  expect(field("#export-captions")).toBeNull();
  await selectOption(field("#export-quality"), "Smaller file");
  await selectOption(field("#export-resolution"), / × 480$/);
  const resolution = field("#export-resolution").textContent;
  const end = sheet().querySelector<HTMLInputElement>("#export-end")!.value;
  await click(buttonIn(sheet(), "Export")!);
  expect(request).toHaveBeenCalledWith(PRJ, expect.objectContaining({ kind: "export", quality: "preview",
    exportOptions: { height: 480 }, range: { start: 0, end: timelineDuration(data.timeline!) } }));
  await click(buttonIn(sheet(), "Continue editing")!);
  expect(sheet()).toBeNull();
  expect(release).not.toHaveBeenCalled();

  await click(buttonIn(container.querySelector(".simple-tools")!, "Media")!);
  await act(async () => { await vi.dynamicImportSettled(); });
  expect(sheet().querySelector("#media-file-types")).not.toBeNull();
  await click(sheet().querySelector('button[aria-label="Close"]')!);
  const edited = buildDb().timelines.ver_4!;
  const settings = { ...data.project.settings, width: 1080, height: 1920, fps: 24 };
  await act(async () => useProjectStore.setState({ current: { ...data, project: { ...data.project, head: edited.version, settings }, timeline: edited } }));
  await click(exportButton());
  expect(sheet().textContent).toContain("Exporting an earlier version · 42%");
  expect(sheet().querySelector<HTMLProgressElement>("progress")?.position).toBe(0.42);
  expect(field("#export-resolution").textContent).toBe(resolution);
  expect(sheet().querySelector("summary")!.textContent).toContain(`${data.project.settings.fps} fps`);
  expect(field("#export-quality").textContent).toBe("Smaller file");
  expect(field("#export-range").textContent).toBe("Custom range");
  expect(sheet().querySelector<HTMLInputElement>("#export-end")!.value).toBe(end);
  expect(sheet().querySelector('[role="alert"]')?.textContent ?? "").toBe("");
  expect(choose).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(1);
  await click(buttonIn(sheet(), "Cancel export")!);
  expect(sheet().querySelector("progress")).toBeNull();
  expect(release).toHaveBeenCalledWith("custom-export", request.mock.calls[0]![1].owner);
  expect(exportButton().querySelector("svg")).toBeNull();
});

it("updates the Export button as the job advances without drawing the player or chat again", async () => {
  const file = { name: "Interview.mp4", format: "mp4" as const, video: { kind: "full" as const, quality: "delivery" as const } };
  const context = fullRenderContext(data.project);
  const running: ExportJob = { file, context, version: data.project.head!, phase: "rendering", progress: 0.42, cancel: () => {} };
  const exports = (job: ReturnType<typeof useExports.getState>["jobs"][string]) => act(async () => useExports.setState({ jobs: { [PRJ]: job } }));
  const preview = vi.spyOn(watch, "CutPreview");
  await show();
  expect(preview).toHaveBeenCalled();
  preview.mockClear();
  const chat = composer.props;
  expect(chat).toBeDefined();
  const ring = () => exportButton().querySelector<SVGElement>("svg");
  const status = () => [exportButton().title, exportButton().getAttribute("aria-description")];
  expect(ring()).toBeNull();
  await exports({ ...running, phase: "choosing" });
  expect(ring()).toBeNull();
  await exports(running);
  expect(ring()?.getAttribute("aria-hidden")).toBe("true");
  expect(ringDrawn(ring())).toBe(42);
  expect(status()).toEqual(["Exporting 42%", "Exporting 42%"]);
  await exports({ ...running, progress: 0.5 });
  expect(ringDrawn(ring())).toBe(50);
  for (const job of [{ ...running, progress: 0 }, { ...running, progress: 0, waiting: true },
    { ...running, progress: 0.97 }, { ...running, phase: "saving" as const, progress: 1 }]) {
    await exports(job);
    expect(ring()?.classList.contains("is-unknown")).toBe(true);
    expect(status()).toEqual(["Exporting", "Exporting"]);
  }
  await exports({ phase: "done", path: file.name, context });
  expect(ring()).toBeNull();
  expect(preview).not.toHaveBeenCalled();
  expect(composer.props).toBe(chat);
  await exports({ phase: "failed", error: "Disk full", file, context });
  expect(ring()).toBeNull();
  expect(moreButton().querySelector(".needs-you")).not.toBeNull();
});

const learning = (id: string, extra: Partial<Learning> = {}): Learning => ({
  id, projectId: PRJ, rule: "Leave the breath before a punchline.", said: "Keep the breath before the punchline.", taskId: data.tasks[0]!.id,
  skillId: "skl_dialogue", state: "suggested", ...extra,
});
const skillNamed = (id: string, name: string): Skill => ({ ...buildDb().skills[0]!, id, name, enabled: true });

it("marks the menu while a rule waits in Learnings, and lists each with its skill, Approve and a × that declines", async () => {
  useSkillsStore.setState({ skills: [skillNamed("skl_dialogue", "dialogue-pass"), skillNamed("skl_frame", "frame-screen")], status: "ready", error: null });
  const approveLearning = vi.fn().mockResolvedValue(undefined);
  const declineLearning = vi.fn().mockResolvedValue(undefined);
  data = { ...data, learnings: [learning("lrn_a", { replaces: ["Cut a breath to its first beat.", "Keep every pause short."] }),
    learning("lrn_b", { rule: "Keep a laugh in.", said: "Don’t cut the laugh.", skillId: "skl_frame" }),
    // One the editor has settled isn't listed and marks nothing.
    learning("lrn_c", { state: "declined" }), learning("lrn_d", { state: "saved" })] };
  useProjectStore.setState({ current: data, approveLearning, declineLearning });
  await show();
  expect(moreButton().querySelector(".needs-you")).not.toBeNull();
  expect(moreButton().getAttribute("aria-description")).toBe("2 rules to review in Learnings");
  // Nothing about it is in the chat or the message box.
  expect(container.querySelector(".simple-thread")!.textContent).not.toMatch(/punchline|Learn/);
  await openMenu();
  expect(menuRow("Learnings").querySelector(".menu-dot")?.getAttribute("aria-label")).toBe("2 rules to review");
  await click(menuRow("Learnings"));
  const panel = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Learnings"]')!;
  const rows = [...panel.querySelectorAll<HTMLElement>(".learn-item")];
  expect(rows.map(r => [r.querySelector(".learn-rule")!.textContent, r.querySelector(".learn-said")!.textContent, r.querySelector('[role="combobox"]')!.textContent]))
    .toEqual([["Leave the breath before a punchline.", "You said: “Keep the breath before the punchline.”", "dialogue-pass"],
      ["Keep a laugh in.", "You said: “Don’t cut the laugh.”", "frame-screen"]]);
  // What the skill already says that a rule would change is under the words it came from, in the skill's words.
  const replaces = rows[0]!.querySelector<HTMLElement>(".learn-said + .learn-replaces")!;
  expect(replaces.textContent).toBe("Replaces “Cut a breath to its first beat.” and “Keep every pause short.”");
  expect(replaces.querySelector(".learn-replaces-label")?.textContent).toBe("Replaces");
  expect(replaces.title).toBe(replaces.textContent);
  expect(rows[1]!.querySelector(".learn-replaces")).toBeNull();
  // The decision is the row's one button, after Revise in plain text; declining is the small × after it, as on a call's card.
  expect([...rows[0]!.querySelectorAll(".learn-actions button:not([role=combobox])")].map(b => [b.textContent || b.getAttribute("aria-label"), b.className]))
    .toEqual([["Revise", "btn-quiet learn-revise"], ["Approve", "btn-primary"], ["Decline", "edit-card-icon"]]);
  await click(buttonIn(rows[0]!, "Approve")!);
  // It is saved by the model chosen now, whichever one the request ran on.
  expect(approveLearning).toHaveBeenCalledWith("lrn_a", "skl_dialogue", { agent: "claude", model: "opus" });
  await click(rows[1]!.querySelector('[aria-label="Decline"]')!);
  expect(declineLearning).toHaveBeenCalledWith("lrn_b");
  // The editor can send a rule to another skill.
  await click(rows[1]!.querySelector('[role="combobox"]')!);
  await click([...document.querySelectorAll<HTMLElement>('[role="option"]')].find(o => o.textContent === "dialogue-pass")!);
  await click(buttonIn(rows[1]!, "Approve")!);
  expect(approveLearning).toHaveBeenLastCalledWith("lrn_b", "skl_dialogue", { agent: "claude", model: "opus" });
  // Those passages are in the skill the rule was offered for. Sent to another, it replaces none of them.
  await click(rows[0]!.querySelector('[role="combobox"]')!);
  await click([...document.querySelectorAll<HTMLElement>('[role="option"]')].find(o => o.textContent === "frame-screen")!);
  expect(rows[0]!.querySelector(".learn-replaces")).toBeNull();
  await click(rows[0]!.querySelector('[role="combobox"]')!);
  await click([...document.querySelectorAll<HTMLElement>('[role="option"]')].find(o => o.textContent === "dialogue-pass")!);
  expect(rows[0]!.querySelector(".learn-replaces")).not.toBeNull();
  // Esc closes the list and leaves the rest as it was.
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(container.querySelector('[role="dialog"][aria-label="Learnings"]')).toBeNull();
});

it("names a rule's skill in full on hover, and moves the decisions under it together where the panel is too narrow for both", async () => {
  useSkillsStore.setState({ skills: [skillNamed("skl_dialogue", "dialogue-pass")], status: "ready", error: null });
  data = { ...data, learnings: [learning("lrn_a")] };
  useProjectStore.setState({ current: data });
  await withSimpleSheet(async () => {
    await show();
    await openMenu();
    await click(menuRow("Learnings"));
    const actions = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Learnings"] .learn-actions')!;
    const picker = actions.querySelector<HTMLElement>('[role="combobox"]')!;
    // A narrow chat can clip the name. The hover title always shows it in full.
    expect([picker.textContent, picker.title]).toEqual(["dialogue-pass", "dialogue-pass"]);
    // "Save to", Revise, Approve and × take about 250px, nearly all a 320px chat leaves the panel. The picker takes the
    // room left, up to its whole name, and with less than 6em of it the row wraps: the decisions go under it together, at
    // the right, rather than leave the name nothing.
    expect([...actions.children].map(part => part.className)).toEqual(["learn-to", "preference-select compact", "learn-decide"]);
    expect([...actions.querySelector(".learn-decide")!.children].map(button => button.textContent || button.getAttribute("aria-label"))).toEqual(["Revise", "Approve", "Decline"]);
    expect([...styled(actions, "flex-wrap"), ...styled(picker, "flex-grow", "flex-basis", "min-width", "max-width"), ...styled(actions.querySelector(".learn-decide")!, "margin-left")])
      .toEqual(["wrap", "1", "6em", "0", "max-content", "auto"]);
  });
});

it("lets the editor reword a rule in place: Esc puts it back, Enter keeps it, and Approve saves the wording they wrote", async () => {
  useSkillsStore.setState({ skills: [skillNamed("skl_dialogue", "dialogue-pass")], status: "ready", error: null });
  const order: string[] = [];
  const saves: Array<() => Promise<void>> = [];
  const reviseLearning = vi.fn((id: string, rule: string) => new Promise<void>(resolve => saves.push(async () => {
    order.push(`revised: ${rule}`);
    data = { ...data, learnings: data.learnings!.map(l => l.id === id ? { ...l, rule, error: undefined } : l) };
    useProjectStore.setState({ current: data });
    resolve();
  })));
  const approveLearning = vi.fn(async (id: string) => { order.push(`approved ${id}`); });
  data = { ...data, learnings: [learning("lrn_a", { error: "It already says that." })] };
  useProjectStore.setState({ current: data, reviseLearning, approveLearning });
  await show();
  await openMenu();
  await click(menuRow("Learnings"));
  const panel = () => container.querySelector<HTMLElement>('[role="dialog"][aria-label="Learnings"]');
  const row = () => panel()!.querySelector<HTMLElement>(".learn-item")!;
  const field = () => row().querySelector<HTMLTextAreaElement>("textarea.learn-rule-edit");
  const rule = () => row().querySelector("p.learn-rule")?.textContent;
  const write = (text: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field()!, text);
    field()!.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // Revise turns the rule into a line with the keyboard in it, and stays lit while it is.
  await click(buttonIn(row(), "Revise")!);
  expect([field()?.value, document.activeElement === field(), buttonIn(row(), "Revise")!.getAttribute("aria-pressed")])
    .toEqual(["Leave the breath before a punchline.", true, "true"]);
  // Esc puts it back as it was, and the list stays open.
  await write("Keep every breath.");
  await press("Escape");
  expect([field(), rule(), panel() !== null, buttonIn(row(), "Revise")!.getAttribute("aria-pressed")]).toEqual([null, "Leave the breath before a punchline.", true, "false"]);
  expect(reviseLearning).not.toHaveBeenCalled();

  // Enter keeps the new wording, on one line however it was pasted, and it shows at once.
  await click(buttonIn(row(), "Revise")!);
  await write("Keep the breath\nbefore every punchline.");
  await act(async () => { field()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect([field(), rule()]).toEqual([null, "Keep the breath before every punchline."]);
  expect(reviseLearning).toHaveBeenLastCalledWith("lrn_a", "Keep the breath before every punchline.");
  await act(async () => saves.shift()!());
  // The reason it wasn't saved was about the old wording.
  expect(row().querySelector(".learn-problem")).toBeNull();

  // Approve pressed straight from the line keeps what was written and waits for it to be saved.
  await click(buttonIn(row(), "Revise")!);
  await write("Never cut the breath before a punchline.");
  const approve = buttonIn(row(), "Approve")!;
  await act(async () => approve.focus());
  await click(approve);
  expect(approveLearning).not.toHaveBeenCalled();
  await act(async () => saves.shift()!());
  expect(order).toEqual(["revised: Keep the breath before every punchline.", "revised: Never cut the breath before a punchline.", "approved lrn_a"]);
  expect(reviseLearning).toHaveBeenCalledTimes(2);
  // With no rule being reworded any more, Esc is the list's again and closes it. The row gave it back each time: one
  // that kept it would take every later Esc and leave the list open.
  await press("Escape");
  expect(panel()).toBeNull();
});

it("says Saving while Scarlet works an approved rule into its skill, why one wasn't saved, and when nothing waits", async () => {
  useSkillsStore.setState({ skills: [skillNamed("skl_dialogue", "dialogue-pass")], status: "ready", error: null });
  data = { ...data, learnings: [learning("lrn_a", { state: "saving" }), learning("lrn_b", { rule: "Keep a laugh in.", error: "It already says that." })] };
  useProjectStore.setState({ current: data });
  await show();
  // One being saved needs nothing more from the editor: only the other one counts.
  expect(moreButton().getAttribute("aria-description")).toBe("1 rule to review in Learnings");
  await openMenu();
  await click(menuRow("Learnings"));
  const [saving, back] = [...container.querySelectorAll<HTMLElement>(".learn-item")];
  expect(saving!.querySelector('[role="status"]')?.textContent).toBe("Saving…");
  expect(buttonIn(saving!, "Approve")).toBeUndefined();
  expect(saving!.querySelector<HTMLButtonElement>('[role="combobox"]')!.disabled).toBe(true);
  expect(back!.querySelector(".learn-problem")?.textContent).toBe("Not saved. It already says that.");
  expect(buttonIn(back!, "Approve")).toBeDefined();
  // With nothing waiting the menu is unmarked, and the list says so.
  data = { ...data, learnings: [] };
  await act(async () => useProjectStore.setState({ current: data }));
  expect(moreButton().querySelector(".needs-you")).toBeNull();
  expect(container.querySelector(".learn-empty")?.textContent).toContain("Nothing to learn yet.");
});

it("leaves a rule's skill list open, with the keyboard on its picker, when the workspace draws again under Learnings", async () => {
  const library = useSkillsStore.getState();
  useSkillsStore.setState({ skills: [skillNamed("skl_dialogue", "dialogue-pass"), skillNamed("skl_frame", "frame-screen")], status: "ready", error: null });
  data = { ...data, learnings: [learning("lrn_a")] };
  useProjectStore.setState({ current: data });
  try {
    await show();
    await openMenu();
    await click(menuRow("Learnings"));
    const panel = () => container.querySelector<HTMLElement>('[role="dialog"][aria-label="Learnings"]');
    // Learnings takes the keyboard as it opens, and only then.
    expect(document.activeElement).toBe(panel());
    const picker = panel()!.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    await click(picker);
    const pickerOpen = () => [document.querySelectorAll('[role="listbox"] [role="option"]').length, picker.getAttribute("aria-expanded"), document.activeElement === picker];
    expect(pickerOpen()).toEqual([2, "true", true]);
    // Scarlet works on, or a file transcribes or caches: each of the engine's events draws the workspace again.
    await event(d => ({ ...d, tasks: [...d.tasks] }));
    expect(pickerOpen()).toEqual([2, "true", true]);
    // Esc still closes the skill list first, and then Learnings.
    await act(async () => { picker.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect([document.querySelector('[role="listbox"]'), panel() !== null]).toEqual([null, true]);
    await press("Escape");
    expect(panel()).toBeNull();
  } finally { await act(async () => useSkillsStore.setState(library, true)); }
});

it("asks for the skills again when Learnings opens after a read of them failed, so a rule still has a skill to be saved to", async () => {
  // The skills couldn't be read earlier, while the engine restarted, and nothing asks for them again by itself.
  const library = useSkillsStore.getState();
  useSkillsStore.setState({ skills: [], status: "error", error: "Engine is restarting" });
  const read = vi.spyOn(api, "skills").mockRejectedValueOnce(new Error("Engine is restarting"))
    .mockResolvedValue({ skills: [skillNamed("skl_dialogue", "dialogue-pass")] });
  data = { ...data, learnings: [learning("lrn_a")] };
  useProjectStore.setState({ current: data });
  const openPanel = async () => { await openMenu(); await click(menuRow("Learnings")); };
  const saveTo = () => {
    const row = container.querySelector<HTMLElement>(".learn-item")!;
    const picker = row.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    return [picker.textContent, picker.disabled, buttonIn(row, "Approve")!.disabled];
  };
  try {
    await show();
    // Opening the list asks once. The engine is still away, so the rule has no skill yet.
    await openPanel();
    expect(read).toHaveBeenCalledTimes(1);
    // Opened again once the engine is back, it asks again: the picker names the skill Scarlet picked, and the rule can be approved.
    await press("Escape");
    await openPanel();
    expect(saveTo()).toEqual(["dialogue-pass", false, false]);
    expect(read).toHaveBeenCalledTimes(2);
  } finally { await act(async () => useSkillsStore.setState(library, true)); }
});

it("says why a rule has no skill to be saved to while the skills can't be read, with Retry", async () => {
  const library = useSkillsStore.getState();
  // The skills couldn't be read earlier, while the engine restarted, and opening Learnings can't read them either.
  useSkillsStore.setState({ skills: [], status: "error", error: "Engine is restarting" });
  const read = vi.spyOn(api, "skills").mockRejectedValueOnce(new Error("Engine is restarting"))
    .mockResolvedValue({ skills: [skillNamed("skl_dialogue", "dialogue-pass")] });
  data = { ...data, learnings: [learning("lrn_a")] };
  useProjectStore.setState({ current: data });
  const panel = () => container.querySelector<HTMLElement>('[role="dialog"][aria-label="Learnings"]')!;
  const said = () => panel().querySelector('[role="alert"]')?.textContent;
  try {
    await show();
    await openMenu();
    await click(menuRow("Learnings"));
    // The rule's picker and Approve are off, and the list says why.
    expect(said()).toBe("Couldn’t load skills. Engine is restarting Retry");
    // Retry asks again without leaving Learnings. Once the skills are in, the rule can be saved, and the reason goes.
    await click(buttonIn(panel(), "Retry")!);
    expect(read).toHaveBeenCalledTimes(2);
    const row = panel().querySelector<HTMLElement>(".learn-item")!;
    expect([row.querySelector('[role="combobox"]')!.textContent, buttonIn(row, "Approve")!.disabled, said()])
      .toEqual(["dialogue-pass", false, undefined]);
  } finally { await act(async () => useSkillsStore.setState(library, true)); }
});

/** Stop on a request Scarlet has: in its heading, at the heading's right. */
const stopOf = (taskId: string) => runOf(taskId).closest(".unit, .subunit")!.querySelector<HTMLButtonElement>(":scope > :is(.unit-msg, .subunit-msg) > .unit-stop")!;
const runOf = (taskId: string) => {
  const thread = buildThreads(data).find(t => t.tasks.some(task => task.id === taskId))!;
  const task = thread.tasks.find(t => t.id === taskId)!;
  // The request Scarlet is on draws above the message box, not in its thread.
  return container.querySelector<HTMLElement>(`.unit[data-run="${task.resumeRootId ?? task.id}"] .req`)!;
};

it("shows a working run as one line of what it's doing and Stop, no clock, bar or steps", async () => {
  const cancelTask = vi.fn().mockResolvedValue(undefined);
  useProjectStore.setState({ cancelTask });
  await show();
  const run = runOf("task_running");
  // It's fixed above the message box. One row: what it's doing now, in words that shimmer. Stop is the heading's last
  // word, and no row under the heading has another.
  expect(run.closest(".simple-pin")).not.toBeNull();
  expect(run.querySelector(".req-now .working-text")).not.toBeNull();
  expect(run.querySelector('[role="timer"], [role=progressbar], .req-bar')).toBeNull();
  expect(stopOf("task_running").textContent).toBe("Stop");
  expect(run.closest(".unit")!.querySelector(".unit-msg")!.lastElementChild).toBe(stopOf("task_running"));
  expect(run.querySelector(".req-now .req-right")).toBeNull();
  expect(run.closest(".unit")!.querySelector(".unit-ring")).toBeNull();
  // It is the only line: what Scarlet did before this moment isn't listed under it, and steps carry no clock time.
  expect(run.querySelectorAll(".req-row").length).toBe(1);
  expect(run.querySelector(".run-row, .req-toggle, .simple-time")).toBeNull();
  await click(stopOf("task_running"));
  expect(cancelTask).toHaveBeenCalledWith("task_running");
});

it("says what a run picked up again is doing while a request sent in its thread before that still waits", async () => {
  idle();
  const base = data.tasks.find(t => t.id === "task_done")!;
  const asked = new Date(Date.now() - 60_000).toISOString(), now = new Date().toISOString();
  // The run was interrupted. A follow-up in its thread was sent before it was picked up again, and waits its turn.
  const interrupted = { ...base, id: "task_zoom", kind: "edit" as const, state: "failed" as const, interrupted: true, summary: null, changeIds: [], retryTaskId: "task_zoom_again",
    instruction: "Zoom into the browser window.", createdAt: asked, startedAt: asked, finishedAt: asked, context: { message: "Zoom into the browser window." } };
  const followUp = { ...interrupted, id: "task_follow", state: "queued" as const, interrupted: undefined, retryTaskId: undefined, startedAt: undefined, finishedAt: undefined,
    instruction: "Hold on it for a beat.", createdAt: new Date(Date.now() - 30_000).toISOString(), context: { threadId: "task_zoom", message: "Hold on it for a beat." } };
  // The attempt that carries the run on is a later task than that request, and starts ahead of it.
  const resumed = { ...interrupted, id: "task_zoom_again", state: "running" as const, interrupted: undefined, retryTaskId: undefined, resumeRootId: "task_zoom",
    createdAt: now, startedAt: now, finishedAt: undefined, context: { threadId: "task_zoom", message: "Zoom into the browser window." } };
  data = { ...data, tasks: [...data.tasks, interrupted, followUp, resumed],
    taskEvents: { ...data.taskEvents, task_zoom_again: [{ type: "tool" as const, at: now, text: "timeline_get", data: { tool: "timeline_get", input: {} } }] } };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  // Its row names what Scarlet is doing this moment, as any working run's does.
  expect(runOf("task_zoom_again").querySelector('.req-now [role="status"]')?.textContent).toBe("Looking at the timeline");
});

it("leaves a finished request as its heading and what it made: no time on it, and no steps to open", async () => {
  await show();
  const run = runOf("task_done");
  const unit = run.closest<HTMLElement>(".unit")!;
  // The heading is the editor's words, with no name or number: "Edit 14" anywhere is an edit Scarlet made.
  expect(unit.querySelector(".unit-msg > :not(.simple-who, p, .unit-state, .unit-stop)")).toBeNull();
  const words = unit.querySelector(".unit-msg p")!;
  expect(words.lastChild?.textContent).toBe(requestTextFor("task_done"));
  // It was sent about a moment on the timeline. The box said which while it was written; the heading doesn't.
  expect(words.querySelector(".simple-revising")).toBeNull();
  expect(unit.querySelector(".unit-msg")?.getAttribute("title")).toBe(requestTextFor("task_done"));
  expect(unit.querySelector(".simple-msg.from-you")).toBeNull();
  expect(run.querySelector(".req-time, .run-list, .req-steps, .simple-pass-chevron, .run-chevron")).toBeNull();
  // Diagnostic lines with clip ids stay out of the editor's view.
  expect(run.textContent).not.toContain("clip_b");
});

it("keeps edits saved mid-run inside the run until it finishes", async () => {
  const running = data.tasks.find(t => t.id === "task_running")!;
  const assembled = { ...data.changes.find(c => c.state === "approved")!, id: "chg_mid_run", taskId: running.id, createdAt: running.startedAt, updatedAt: running.startedAt };
  data = { ...data, changes: [...data.changes, assembled], tasks: data.tasks.map(t => t.id === running.id ? { ...t, changeIds: [assembled.id] } : t) };
  useProjectStore.setState({ current: data });
  await show();
  const unit = runOf("task_running").closest(".unit")!;
  expect([...unit.querySelectorAll(".simple-msg.from-scarlet")].some(m => buttonIn(m, "Revise"))).toBe(false);
});

it("plays an applied cut's After from the version the cut made, so the join sounds exactly as it does in the edit", async () => {
  // A dialogue cut that took 10–12.4 s out of v_before and made the working cut.
  const cut = { op: "rippleDelete" as const, start: 10, end: 12.4 };
  const before = { ...data.timeline!, version: "v_before" };
  const working = { ...applyOps(before, [cut]), version: data.project.head! };
  data = { ...data, timeline: working, changes: data.changes.map(c => c.id === "chg_approved_2"
    ? { ...c, ops: [cut], fromVersion: "v_before", toVersion: working.version, appliedVersion: working.version,
      timelineEdits: undefined, approvedSpots: undefined, appliedReview: undefined, cutReasons: [{ ...cut, reason: "Keep the image test" }] } : c) };
  useProjectStore.setState({ current: data });
  vi.spyOn(api, "threadEdits").mockResolvedValue({ version: working.version, edits: [
    { changeId: "chg_approved_2", spot: 0, label: "Keep the image test", range: { start: 8.5, end: 11.5 }, at: 10,
      beforeCut: { version: "v_before", removed: { start: 10, end: 12.4 } }, previous: [] },
  ] });
  vi.spyOn(api, "timeline").mockImplementation(async (_, version) => ({ timeline: version === "v_before" ? before : working }));
  const audition = vi.spyOn(player, "audition");
  await show();
  await click(buttonIn(turnFor("chg_approved_2"), "See edit")!);
  await act(async () => {});
  // The timeline stays on the version before, shading what came out, and the listen is in its clock.
  expect(container.querySelector(".simple-timeline-band")?.textContent).toBe("Removed · 2.4 s");
  expect(audition).toHaveBeenLastCalledWith({ start: 8, end: 15.4, skips: [{ start: 10, end: 12.4, removed: true }] }, expect.any(Number));
  // The picture and sound come from the working cut, where the join is inside the rendered media.
  expect(player.mediaTime(9)).toBe(9);
  expect(player.mediaTime(13)).toBeCloseTo(10.6, 6);
  expect(player.mediaTime(11)).toBe(10);
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
  const frame = (seconds: number) => act(async () => {
    const video = player.element()!;
    video.currentTime = seconds;
    video.dispatchEvent(new Event("timeupdate"));
  });
  await frame(9.98);
  expect(playhead()).toBe(9.98);
  await frame(10.02);
  expect(playhead()).toBe(12.42);
  expect(container.querySelector(".timeline-playhead.is-gliding, .timeline-playhead-time.is-gliding")).toBeNull();
  // Before plays the version before, straight through.
  await press("\\");
  expect(audition).toHaveBeenLastCalledWith({ start: 8, end: 14.4, skips: [] }, expect.any(Number));
  expect(player.mediaTime(13)).toBe(13);
  await frame(11);
  expect(playhead()).toBe(11);
});

it("warms and opens the actual saved After for a named removal alongside restored footage elsewhere", async () => {
  const make = (version: string, spans: number[][]) => ({ ...timelineFromKeepRanges(PRJ, "camera", spans.map(([start, end]) => ({ start: start!, end: end! }))), version });
  // Camera 4–6 was missing on Before. The editor restored it while removing camera 12–14.
  const before = make("before", [[0, 4], [6, 30]]);
  const after = make(data.project.head!, [[0, 12], [14, 30]]);
  const id = "chg_approved_2";
  data = { ...data, timeline: after, changes: data.changes.filter(c => c.id === id).map(c => ({
    ...c, fromVersion: before.version, toVersion: after.version, appliedVersion: after.version,
    ops: undefined, timelineEdits: [{ label: "Take out the aside", range: { start: 12, end: 12 } }],
  })), tasks: data.tasks.filter(t => t.changeIds.includes(id)), notes: [] };
  useProjectStore.setState({ current: data });
  vi.spyOn(api, "threadEdits").mockResolvedValue({ version: after.version, edits: [{ changeId: id, spot: 0, previous: [],
    label: "Take out the aside", at: 12, range: { start: 12, end: 12 }, beforeCut: { version: before.version, removed: { start: 10, end: 12 } } }] });
  vi.spyOn(api, "timeline").mockImplementation(async (_, version) => ({ timeline: version === before.version ? before : after }));
  await show();
  expect(api.preparePlayback).toHaveBeenCalledWith(PRJ, after.version, [10, 12, 15 - 1 / data.project.settings.fps], expect.any(AbortSignal));
  await click(buttonIn(turnFor(id), "See edit")!);
  expect([player.mediaTime(8), player.mediaTime(11), player.mediaTime(13)]).toEqual([10, 12, 13]);
  await press("\\");
  expect(player.mediaTime(11)).toBe(11);
});

it("keeps the selected cut centered and its playhead in view through the whole After audition", async () => {
  const cut = { start: 45.75, end: 46.25 };
  const next = { start: 47.75, end: 51.5 };
  const outside = { start: 80, end: 82 };
  const before = { ...data.timeline!, version: "v_before", tracks: [
    { ...makeTrack("video", "Video"), clips: [makeMediaClip(data.media.find(m => m.kind === "video")!.id, 0, 120, 0)] },
  ] };
  const ops = [outside, next, cut].map(range => ({ op: "rippleDelete" as const, ...range }));
  const working = { ...applyOps(before, ops), version: data.project.head! };
  const edits = [cut, next, outside].map((removed, spot) => ({
    changeId: "chg_approved_2", spot, label: `Trim pause ${spot + 1}`, beforeCut: { version: before.version, removed },
    range: removed, at: removed.start - [0, 0.5, 4.25][spot]!, previous: [],
  }));
  data = { ...data, timeline: working, changes: data.changes.map(c => c.id === "chg_approved_2"
    ? { ...c, ops, fromVersion: before.version, toVersion: working.version, appliedVersion: working.version,
      timelineEdits: undefined, approvedSpots: undefined, appliedReview: undefined, cutReasons: undefined } : c) };
  useProjectStore.setState({ current: data });
  vi.spyOn(api, "timeline").mockImplementation(async (_, version) => ({ timeline: version === before.version ? before : working }));
  vi.spyOn(api, "threadEdits").mockResolvedValue({ version: working.version, edits });
  // The cut belongs to the selected timeline request, and is the first visible row before a card opens.
  await event(d => ({ ...d, changes: d.changes.filter(c => c.id === "chg_approved_2"),
    tasks: d.tasks.filter(t => t.changeIds.includes("chg_approved_2")), notes: [] }));
  await show();
  expect(api.preparePlayback).toHaveBeenCalledWith(PRJ, working.version, expect.arrayContaining([43.75]), expect.any(AbortSignal));
  expect(api.preparePlayback).toHaveBeenCalledWith(PRJ, before.version, expect.arrayContaining([43.75]), expect.any(AbortSignal));
  await click(appliedRows()[0]!);
  // Deliberately hovering a different settled row prepares its own cut without moving or replaying this one.
  const audition = vi.spyOn(player, "audition"), currentRow = appliedRows()[0]!;
  await act(async () => usePlayerStore.setState({ playing: true, playbackReady: true }));
  expect(api.preparePlayback).not.toHaveBeenCalledWith(PRJ, before.version, expect.arrayContaining([78]), expect.any(AbortSignal));
  await act(async () => appliedRows()[2]!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
  expect(api.preparePlayback).toHaveBeenCalledWith(PRJ, before.version, expect.arrayContaining([78]), expect.any(AbortSignal));
  expect(currentRow.getAttribute("aria-current")).toBe("true");
  expect(audition).not.toHaveBeenCalled();
  const band = () => container.querySelector<HTMLElement>(".simple-timeline-band");
  const initial = band()!.getAttribute("style");
  expect(parseFloat(band()!.style.left) + parseFloat(band()!.style.width) / 2).toBeCloseTo(50);
  // The three seconds of kept audio run from 46.25 to 53 on the source clock, across the second removal.
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
  for (const time of [45.7, 46.3, 47.7, 51.6, 52.96, 53.02]) {
    await act(async () => {
      const video = player.element()!;
      video.currentTime = player.mediaTime(time);
      video.dispatchEvent(new Event("timeupdate"));
    });
    expect(band()?.getAttribute("style")).toBe(initial);
    expect(container.querySelector(".timeline-playhead")).not.toBeNull();
  }
  expect(playhead()).toBe(53);
  expect(player.element()!.paused).toBe(true);
  await press("\\");
  expect(band()?.getAttribute("style")).toBe(initial);
});

it("starts an applied cut's After once, on the player it stays on, and plays nothing on the working edit meanwhile", async () => {
  const cut = { op: "rippleDelete" as const, start: 10, end: 12.4 };
  const before = { ...data.timeline!, version: "v_before" };
  const working = { ...applyOps(before, [cut]), version: data.project.head! };
  data = { ...data, timeline: working, changes: data.changes.map(c => c.id === "chg_approved_2"
    ? { ...c, ops: [cut], fromVersion: "v_before", toVersion: working.version, appliedVersion: working.version,
      timelineEdits: undefined, approvedSpots: undefined, appliedReview: undefined, cutReasons: [{ ...cut, reason: "Keep the image test" }] } : c) };
  useProjectStore.setState({ current: data });
  vi.spyOn(api, "threadEdits").mockResolvedValue({ version: working.version, edits: [
    { changeId: "chg_approved_2", spot: 0, label: "Keep the image test", range: { start: 8.5, end: 11.5 }, at: 10,
      beforeCut: { version: "v_before", removed: { start: 10, end: 12.4 } }, previous: [] },
  ] });
  // The version before the cut, and whether the version it made has a saved file, each take a moment to arrive.
  let arrive = { before() {}, files() {} };
  vi.spyOn(api, "timeline").mockImplementation(async (_, version) => {
    if (version === "v_before") await new Promise<void>(done => { arrive.before = done; });
    return { timeline: version === "v_before" ? before : working };
  });
  await show();
  const waiting: (() => void)[] = [];
  arrive.files = () => waiting.splice(0).forEach(done => done());
  vi.spyOn(api, "renders").mockImplementation(async () => { await new Promise<void>(done => waiting.push(done)); return { renders: [] }; });
  const audition = vi.spyOn(player, "audition"), passage = vi.spyOn(player, "previewRange"), play = vi.spyOn(player, "play");
  await click(buttonIn(turnFor("chg_approved_2"), "See edit")!);
  await act(async () => {});
  // The working edit doesn't start on the passage while the cut's own version loads: that was a flash of the wrong
  // picture and a clipped sound before the listen.
  expect(passage).not.toHaveBeenCalled();
  expect(play).not.toHaveBeenCalled();
  await act(async () => arrive.before());
  // Not on the stream either, only to change to the saved file partway.
  expect(audition).not.toHaveBeenCalled();
  await act(async () => arrive.files());
  expect(audition).toHaveBeenCalledTimes(1);
  expect(audition).toHaveBeenLastCalledWith({ start: 8, end: 15.4, skips: [{ start: 10, end: 12.4, removed: true }] }, expect.any(Number));
  expect(player.mediaTime(13)).toBeCloseTo(10.6, 6);
  expect(passage).not.toHaveBeenCalled();
});

it("greys out the pass's other cuts on After, and a click into one plays it in Before from there", async () => {
  // Two cuts from one pass on v_before: this one at 10–12.4 s, and the cut at 0:06, at 6–7 s, which After doesn't have either.
  const cut = { op: "rippleDelete" as const, start: 10, end: 12.4 };
  const before = { ...data.timeline!, version: "v_before" };
  const working = { ...applyOps(before, [cut]), version: data.project.head! };
  data = { ...data, timeline: working, changes: data.changes.map(c => c.id === "chg_approved_2"
    ? { ...c, ops: [cut], fromVersion: "v_before", toVersion: working.version, appliedVersion: working.version,
      timelineEdits: undefined, approvedSpots: undefined, appliedReview: undefined, cutReasons: [{ ...cut, reason: "Keep the image test" }] } : c) };
  useProjectStore.setState({ current: data });
  vi.spyOn(api, "threadEdits").mockResolvedValue({ version: working.version, edits: [
    { changeId: "chg_approved_2", spot: 0, label: "Keep the image test", range: { start: 8.5, end: 11.5 }, at: 10,
      beforeCut: { version: "v_before", removed: { start: 10, end: 12.4 } }, previous: [] },
    { changeId: "chg_approved_2", spot: 1, label: "Drop the false start", range: { start: 5, end: 7 }, at: 6,
      beforeCut: { version: "v_before", removed: { start: 6, end: 7 } }, previous: [] },
  ] });
  vi.spyOn(api, "timeline").mockImplementation(async (_, version) => ({ timeline: version === "v_before" ? before : working }));
  const audition = vi.spyOn(player, "audition");
  await show();
  await click(turnFor("chg_approved_2").querySelector(".simple-edits .simple-edit")!);
  await act(async () => {});
  const gap = () => container.querySelector<HTMLElement>(".simple-timeline-gap")!;
  expect(gap().classList.contains("is-skipped")).toBe(true);
  // It goes by its time, as its row in the pass's list and its tag in the message box do, not by a number of its own.
  expect(gap().querySelector(".simple-timeline-gap-label")?.textContent).toBe("Cut at 0:06");
  // Hovered, its note joins the scrub preview's card like a marker's.
  expect(container.querySelector(".simple-timeline-tip")).toBeNull();
  await act(async () => { gap().dispatchEvent(new PointerEvent("pointerover", { bubbles: true })); });
  const gapNote = container.querySelector(".timeline-track .simple-timeline-tip.is-joined")!;
  expect(gap().querySelector(".simple-timeline-tip")).toBeNull();
  expect(gapNote.querySelector("b")?.textContent).toBe("Cut at 0:06 · 1.0 s");
  expect(gapNote.textContent).toContain("Drop the false start");
  expect(gapNote.querySelector("em")).toBeNull();
  // The grey and the tag already say After skips it: the note doesn't repeat that.
  expect(gapNote.querySelector("small")).toBeNull();
  expect(container.querySelector(".edit-card-switched")).toBeNull();

  // Without layout the click lands on the gap's first frame. It plays Before from there instead of seeking past the gap.
  await act(async () => { gap().dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, isPrimary: true, button: 0, bubbles: true })); });
  expect(audition).toHaveBeenLastCalledWith({ start: 8, end: 14.4, skips: [], from: 6 }, expect.any(Number));
  expect(usePlayerStore.getState().scrubGesture).toBeUndefined();
  // The card says whose footage is playing, and only that: the lit icon under it is the way back and names its key,
  // so the line has no button and no key box of its own.
  const notice = container.querySelector(".edit-card-switched")!;
  expect([...notice.children].map(part => part.textContent)).toEqual(["Before", "The cut at 0:06 took this part out."]);
  expect(notice.querySelector("button, kbd")).toBeNull();
  expect(beforeIcon(editPanel()!)).toEqual(["", "Before", "true", "Back to After (\\)"]);
  expect(container.querySelector(".edit-card-before.is-flash[aria-pressed='true']")).not.toBeNull();
  expect(container.querySelector(".simple-on-video")?.textContent).toBe("Showing what the cut at 0:06 took out · Before");
  // On Before the footage plays, so it's only outlined.
  expect(gap().classList.contains("is-skipped")).toBe(false);
  expect(gap().textContent).toBe("Cut at 0:06");

  // The lit icon goes back to After, which picks up where that cut's footage ends, as the edit plays it.
  await click(container.querySelector(".edit-card-before")!);
  expect(audition).toHaveBeenLastCalledWith({ start: 8, end: 15.4, skips: [{ start: 10, end: 12.4, removed: true }], from: 7 }, expect.any(Number));
  expect(container.querySelector(".edit-card-switched")).toBeNull();
  expect(gap().classList.contains("is-skipped")).toBe(true);
});

it("shades and steps over what a later batch of the pass took out, since the video as it runs now doesn't have it either", async () => {
  // This cut, 10–12.4 s, came out in the pass's first batch; a later batch took out 8.5–9.5 s of the same footage.
  const cut = { op: "rippleDelete" as const, start: 10, end: 12.4 };
  const later = { op: "rippleDelete" as const, start: 8.5, end: 9.5 };
  const before = { ...data.timeline!, version: "v_before" };
  const batch = { ...applyOps(before, [cut]), version: "v_batch" };
  const working = { ...applyOps(batch, [later]), version: data.project.head! };
  data = { ...data, timeline: working, changes: data.changes.map(c => c.id === "chg_approved_2"
    ? { ...c, ops: [cut], fromVersion: "v_before", toVersion: batch.version, appliedVersion: batch.version,
      timelineEdits: undefined, approvedSpots: undefined, appliedReview: undefined, cutReasons: [{ ...cut, reason: "Keep the image test" }] } : c) };
  useProjectStore.setState({ current: data });
  vi.spyOn(api, "threadEdits").mockResolvedValue({ version: working.version, edits: [
    { changeId: "chg_approved_2", spot: 0, label: "Keep the image test", range: { start: 8.5, end: 8.5 }, at: 8.5,
      beforeCut: { version: "v_before", removed: { start: 10, end: 12.4 } }, previous: [] },
    { changeId: "chg_approved_2", spot: 1, label: "Drop the long pause", range: { start: 8.5, end: 8.5 }, at: 8.5,
      beforeCut: { version: "v_batch", removed: { start: 8.5, end: 9.5 } }, previous: [] },
  ] });
  vi.spyOn(api, "timeline").mockImplementation(async (_, version) => ({ timeline: version === "v_before" ? before : version === "v_batch" ? batch : working }));
  const audition = vi.spyOn(player, "audition");
  await show();
  await click(turnFor("chg_approved_2").querySelector(".simple-edits .simple-edit")!);
  await act(async () => {});
  const gap = container.querySelector<HTMLElement>(".simple-timeline-gap")!;
  expect(gap.classList.contains("is-skipped")).toBe(true);
  expect(gap.querySelector(".simple-timeline-gap-label")?.textContent).toBe("Cut at 0:08");
  // After plays as the video runs now: over the later cut as well as this one, on the working edit's own media.
  expect(audition).toHaveBeenLastCalledWith({ start: 8, end: 15.4, skips: [{ start: 8.5, end: 9.5, removed: true }, { start: 10, end: 12.4, removed: true }] }, expect.any(Number));
  expect(player.mediaTime(13)).toBeCloseTo(9.6, 6);
});

it("keeps an edit that left its request's list closed when it is listed again, in a request that still has an edit to check", async () => {
  earlierRequestOnly();
  const later = laterRequest();
  data = { ...data, changes: [...data.changes, later.change] };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  await click(editRows("chg_approved_2")[1]!);
  await act(async () => {});
  expect(openTitle()).toBe("captions");
  // "captions" is undone while it is open. Its request still has "wrap" to check, so it keeps the timeline.
  const all = later.lists[later.earlier] as object[];
  later.lists[later.earlier] = [all[0]!, all[2]!];
  await headMoves("ver_undone");
  await act(async () => {});
  expect(editPanel()).toBeNull();
  expect(numbered()).toEqual([["2", "check"]]);
  // Put back, it stays closed.
  later.lists[later.earlier] = all;
  await headMoves("ver_redone");
  await act(async () => {});
  expect(editPanel()).toBeNull();
  expect(numbered()).toEqual([["3", "check"]]);
});

it("gives the timeline to a request that arrived while an earlier request's edit was open, when that edit's markers then fail", async () => {
  earlierRequestOnly();
  const later = laterRequest();
  await show();
  await act(async () => {});
  await click(editRows("chg_approved_2")[1]!);
  await act(async () => {});
  expect(openTitle()).toBe("captions");
  await event(d => ({ ...d, changes: [...d.changes, later.change] }));
  await act(async () => {});
  expect(openTitle()).toBe("captions");
  // The working cut moves on with the new edit, and the open edit's markers fail to load. Its request has "wrap" to check.
  later.lists[later.earlier] = new Error("Engine unreachable");
  await headMoves("ver_failed");
  await act(async () => {});
  expect(editPanel()).toBeNull();
  expect(numbered()).toEqual([["1", "check"]]);
});

it("gives the timeline to a request that arrived under a pass's open list once the list closes, though the editor looked at its edit meanwhile", async () => {
  const later = appliedPass(true);
  await show();
  await act(async () => {});
  await click(passToggle());
  await act(async () => {});
  expect(ticks()).toEqual(["tick", "tick", "check"]);
  // A request's flagged edit lands while the list is open. The editor looks at it and closes it without keeping it.
  await event(d => ({ ...d, changes: [...d.changes, later.change] }));
  await act(async () => {});
  await click(turnFor("chg_later").querySelector(".simple-pass-need")!);
  await act(async () => {});
  expect(openTitle()).toBe("outro fade");
  await press("Escape");
  await act(async () => {});
  expect(ticks()).toEqual(["tick", "tick", "check"]);
  // The list closes. The new request has the timeline, as it would without the look.
  await click(passToggle());
  await act(async () => {});
  expect(turnFor("chg_later").querySelector(".simple-pass-need")?.textContent).toBe("1 needs you");
  expect(numbered()).toEqual([["1", "check"]]);
  expect(container.querySelector(".simple-timeline-mark.is-numbered")?.getAttribute("style")).toContain("81.25%");
});

it("stays with an earlier request's flagged edit after a look at it, though a later request arrived while another request's edit was open", async () => {
  earlierRequestOnly();
  const later = laterRequest();
  // A second earlier request with one flagged edit of its own.
  const q = { ...later.change, id: "chg_q", description: "Lower the music", createdAt: new Date(Date.now() - 60_000).toISOString(), updatedAt: new Date(Date.now() - 60_000).toISOString() };
  later.lists.chg_q = [{ changeId: "chg_q", spot: 0, label: "music level", range: { start: 5, end: 9 }, previous: [], check: "It may be too quiet now" }];
  data = { ...data, changes: [...data.changes, q] };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  await click(editRows("chg_approved_2")[1]!);
  await act(async () => {});
  expect(openTitle()).toBe("captions");
  // A later request arrives while "captions" is open.
  await event(d => ({ ...d, changes: [...d.changes, later.change] }));
  await act(async () => {});
  // The editor goes straight to the other request's flagged edit, and closes it without keeping it. They went there after the arrival, so the timeline stays.
  await click(turnFor("chg_q").querySelector(".simple-pass-need")!);
  await act(async () => {});
  expect(openTitle()).toBe("music level");
  await press("Escape");
  await act(async () => {});
  expect(numbered()).toEqual([["1", "check"]]);
  expect(container.querySelector(".simple-timeline-mark.is-numbered")?.getAttribute("style")).toContain("31.25%");
});

it("keeps every request in one conversation, and starts a new edit when nothing is open or asked", async () => {
  appliedEdits();
  // Scarlet isn't on anything in this project, and hasn't asked anything.
  data = { ...data, tasks: data.tasks.map(t => ["queued", "claimed", "running", "waiting_for_user"].includes(t.state) ? { ...t, state: "done" as const, question: null } : t) };
  useProjectStore.setState({ current: data });
  await show();
  // There is no list of edits beside the chat: one column with every request in it, oldest first, none hidden.
  expect(container.querySelector('nav[aria-label="Edit list"], .edits-col')).toBeNull();
  const titles = buildThreads(data).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).map(t => t.title);
  expect(turns().map(t => [t.getAttribute("aria-label"), t.hidden])).toEqual(titles.map(title => [title, false]));
  expect(units().some(u => u.hidden)).toBe(false);
  // Nothing is in flight, so nothing is fixed above the box. The box starts a new edit: no tag in it, no line over it.
  expect(container.querySelector(".simple-pin .unit")).toBeNull();
  expect(container.querySelector(".simple-target")).toBeNull();
  expect(boxTag()).toBeUndefined();
  expect(useUiStore.getState().draftOwner).toBe(JSON.stringify([PRJ, null]));
});

/** Scarlet is on a dialogue pass and a second request waits behind it, in a project with nothing else in flight. */
const passThenZoom = () => {
  const now = new Date().toISOString();
  const pass = { ...data.tasks.find(t => t.id === "task_done")!, id: "task_pass", kind: "edit" as const, instruction: "/dialogue-pass", expectedSeconds: undefined,
    context: { threadId: "task_pass", message: "/dialogue-pass" }, state: "running" as const, changeIds: [], createdAt: now, startedAt: now, finishedAt: undefined };
  const zoom = { ...pass, id: "task_zoom", instruction: "Zoom into the browser window.", context: { threadId: "task_zoom", message: "Zoom into the browser window." },
    state: "queued" as const, createdAt: new Date(Date.now() + 1000).toISOString(), startedAt: undefined };
  data = { ...data, tasks: [...data.tasks.map(t => ["queued", "claimed", "running", "waiting_for_user"].includes(t.state) ? { ...t, state: "done" as const, question: null } : t), pass, zoom] };
  useProjectStore.setState({ current: data });
};

it("fixes the request Scarlet is on above the message box, moves it into the conversation when it's done, and keeps a waiting one in the tray", async () => {
  passThenZoom();
  await show();
  const unit = (id: string) => container.querySelector<HTMLElement>(`.unit[data-run="${id}"]`);
  // What Scarlet is on is fixed above the box. The request behind it isn't in the conversation: it waits in the tray.
  expect(unit("task_pass")!.closest(".simple-pin")).not.toBeNull();
  expect(unit("task_zoom")).toBeNull();
  expect(container.querySelector(".queue-tray")?.textContent).toContain("Zoom into the browser window.");
  // What it's doing shimmers, with Stop in the heading. No time and no bar, with or without an estimate of how long it takes.
  expect(unit("task_pass")!.querySelector(".req-now .working-text")).not.toBeNull();
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_pass" ? { ...t, expectedSeconds: 600 } : t) }));
  expect(unit("task_pass")!.querySelector('[role="timer"], [role=progressbar], .req-bar')).toBeNull();
  expect(buttonIn(unit("task_pass")!, "Stop")).toBeDefined();
  // Once Scarlet finishes, the request joins the conversation and the next one takes the fixed spot, at work.
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_pass" ? { ...t, state: "done" as const, finishedAt: new Date().toISOString() }
    : t.id === "task_zoom" ? { ...t, state: "running" as const, startedAt: new Date().toISOString() } : t) }));
  expect(unit("task_pass")!.closest(".simple-chat")).not.toBeNull();
  expect(unit("task_zoom")!.closest(".simple-pin")).not.toBeNull();
  expect(unit("task_zoom")!.querySelector(".unit-msg p")?.textContent).toBe("Zoom into the browser window.");
  expect(unit("task_zoom")!.querySelector('.req-now [role="status"]')).not.toBeNull();
  expect(buttonIn(unit("task_zoom")!, "Stop")).toBeDefined();
  expect(container.querySelector(".queue-tray")).toBeNull();
  // A request asked meanwhile leaves the box as it was, starting a new edit.
  const asked = { ...data.tasks.find(t => t.id === "task_zoom")!, id: "task_asked", instruction: "Add captions.", state: "queued" as const,
    context: { message: "Add captions." }, createdAt: new Date(Date.now() + 2000).toISOString(), startedAt: undefined };
  await act(async () => { composer.props!.onCreated!(asked); });
  await event(d => ({ ...d, tasks: [...d.tasks, asked] }));
  expect(useUiStore.getState().draftOwner).toBe(JSON.stringify([PRJ, null]));
  expect(unit("task_asked")).toBeNull();
  // A request that stopped short says so, in the conversation.
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_zoom" ? { ...t, state: "failed" as const, finishedAt: new Date().toISOString() } : t) }));
  expect(unit("task_zoom")!.closest(".simple-chat")).not.toBeNull();
  expect(unit("task_zoom")!.querySelector(".unit-msg .unit-state")?.textContent).toBe("Couldn’t finish");
  expect(unit("task_zoom")!.querySelector(".req-state")).toBeNull();
});

it("opens a call that's with Scarlet: its card says so, and its revision is at work, tagged with the cut", async () => {
  flagged();
  const threadId = threadWith("chg_ready").id;
  const base = data.tasks.find(t => t.id === "task_done")!;
  const revision = { ...base, id: "task_revise", kind: "revise" as const, state: "running" as const, finishedAt: undefined, changeIds: [], expectedSeconds: undefined,
    instruction: "The words don't line up.", createdAt: new Date().toISOString(), startedAt: new Date().toISOString(),
    context: { threadId, changeId: "chg_ready", cutIndex: 1, time: 230, end: 233, message: "The words don't line up." } };
  data = { ...data, tasks: [...data.tasks, revision], changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, state: "revising" as const,
    intent: "suggestion" as const, cutReasons: [0, 1, 2].map(i => ({ start: i, end: i + 1, reason: `Cut ${i + 1}.` })) } : c) };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  // The pass counts only what still waits on the editor. Its list keeps the cut being revised, marked Revising….
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("1 needs you");
  await click(passCard().querySelector(".simple-pass-need")!);
  expect(passRows().map(r => [r.querySelector(".edit-badge")?.textContent, r.querySelector(".edit-badge")?.classList.contains("is-check"), r.querySelector(".simple-pass-value")?.textContent]))
    .toEqual([["1", false, "Revising…"], ["2", true, undefined]]);
  // ↑ steps to it from the call beside it. The card keeps Scarlet's note and Before/After, and says Revising… where the
  // decisions were. It isn't waiting on the editor, so it has no place among the ones that are.
  // "1 needs you" opened the one call still waiting.
  expect(passRow("The corrected image-input take belongs here.").getAttribute("aria-current")).toBe("true");
  await press("ArrowUp");
  expect(container.querySelector(".simple-on-video")?.textContent).toBe("Showing cut at 3:50 · 1 of 2 · After");
  expect(call().querySelector(".edit-card-title")?.textContent).toBe("Breath before the price.");
  expect(call().querySelector(".edit-card-status")?.textContent).toBe("Revising…");
  expect(call().querySelector(".review-actions")).toBeNull();
  // It keeps its number, the same as on its line in the list and on the revision at work on it.
  expect(call().querySelector(".edit-card-count")?.textContent).toBe("Cut 1");
  expect(beforeIcon(call())).toEqual(["", "Before", "false", "Play Before (\\)"]);
  // The editor's revision is at work directly under that call's row, tagged once with the cut it revises.
  const unit = container.querySelector<HTMLElement>('.subunit[data-run="task_revise"]')!;
  expect(unit.closest("li")).toBe(passRow("Breath before the price.").closest("li"));
  expect([...unit.querySelectorAll(".simple-revising")].map(t => t.textContent)).toEqual(["Cut 1"]);
  expect(wordsOf(unit.querySelector(".subunit-msg p"))).toBe("The words don't line up.");
  expect(unit.querySelector(".req")?.getAttribute("data-state")).toBe("working");
  expect(transcriptLink().getAttribute("aria-label")).toBe("Show transcript");
  // The message box is on that cut, so a second note goes to it.
  expect(container.querySelector(".simple-target")?.textContent).toContain("Revising the cut at 3:50");
  expect(boxTag()).toBe("Cut 1");
  // A and S do nothing on it: the decision waits for the new version.
  const save = vi.mocked(api.saveCutChoices);
  save.mockClear();
  await press("a");
  expect(save).not.toHaveBeenCalled();
  // The other call still has its decisions, the only one waiting.
  await press("ArrowDown");
  expect(buttonIn(call(), "Approve")).toBeDefined();
  expect([call().querySelector(".edit-card-count")?.textContent, call().querySelector(".edit-card-count")?.getAttribute("title")]).toEqual(["Cut 2", "1 of 1 still waiting for you"]);
});

it("aims the message box at the cut that's open, and lets go of it when the cut closes", async () => {
  flagged();
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  await reviewCalls();
  expect(useUiStore.getState().agentContext).toMatchObject({ changeId: "chg_ready", cutIndex: 1 });
  // The tag is the call's number, as on its card and its line in the list.
  expect(boxTag()).toBe("Cut 1");
  // Esc puts the cut away, and a message no longer goes to it.
  await press("Escape");
  expect(container.querySelector('[aria-label="Call"]')).toBeNull();
  expect(useUiStore.getState().agentContext).toBeNull();
  expect(boxTag()).not.toBe("Cut 1");
});

/** The line above the message box: what it says, whether it's only for screen readers, and the button it offers. */
const aimLine = () => {
  const line = container.querySelector<HTMLElement>(".simple-target");
  return line ? [line.querySelector("span")?.textContent, line.classList.contains("is-quiet"), line.querySelector("button")?.textContent] : null;
};
const boxNow = () => { const ui = useUiStore.getState(); return [ui.agentDraft, ui.agentContext, ui.draftOwner]; };

it("leaves a message being written aimed where it was, says where, and brings it along when asked", async () => {
  appliedEdits();
  // Scarlet hasn't asked anything, so with nothing open the box starts a new edit.
  data = { ...data, tasks: data.tasks.map(t => t.state === "waiting_for_user" ? { ...t, state: "done" as const, question: null } : t) };
  useProjectStore.setState({ current: data });
  await show();
  const edits = () => turnFor("chg_approved_2").querySelectorAll<HTMLElement>(".simple-edits .simple-edit");
  await click(edits()[1]!);
  await act(async () => {});
  // The box is on the edit that's open, and its tag says so, so the line that names it is for screen readers.
  expect(aimLine()).toEqual(["Revising “captions” at 0:00", true, undefined]);
  expect(boxTag()).toBe("Edit at 0:00");
  await act(async () => useUiStore.getState().setAgentDraft("Make the captions smaller"));
  // Esc closes the edit, but the message is still about the captions. Now the line shows, and offers to start a new
  // edit with the message instead.
  await press("Escape");
  expect(editPanel()).toBeNull();
  expect(aimLine()).toEqual(["Revising “captions” at 0:00", false, "New edit instead"]);
  expect(useUiStore.getState().agentContext).toMatchObject({ changeId: "chg_approved_2", editIndex: 1 });
  await click(container.querySelector(".simple-target button")!);
  // A message made a new edit is about the whole video: typing on doesn't pin it to the playhead.
  expect(boxNow()).toEqual(["Make the captions smaller", "whole", JSON.stringify([PRJ, null])]);
  expect(aimLine()).toBeNull();
  expect(boxTag()).toBeUndefined();
  // With another edit open the message still starts a new edit, and the line offers to move it there. It comes whole,
  // and nothing of it is left behind.
  await click(edits()[2]!);
  await act(async () => {});
  expect(aimLine()).toEqual(["Starting a new edit", false, "Move here"]);
  await click(container.querySelector(".simple-target button")!);
  expect(boxNow()).toMatchObject(["Make the captions smaller", { changeId: "chg_approved_2", editIndex: 2 }, JSON.stringify([PRJ, threadWith("chg_approved_2").id])]);
  expect(aimLine()?.slice(1)).toEqual([true, undefined]);
  expect(boxTag()).toBe("Edit at 0:11");
  expect(Object.keys(useUiStore.getState().savedDrafts)).toEqual([]);
  // The × on the tag does the reverse: the message becomes a new edit, with the edit still open.
  await act(async () => composer.props!.onClearTarget!());
  expect(boxNow()).toEqual(["Make the captions smaller", "whole", JSON.stringify([PRJ, null])]);
  expect(aimLine()).toEqual(["Starting a new edit", false, "Move here"]);
  expect(boxTag()).toBeUndefined();
  expect(editPanel()).not.toBeNull();
});

it("keeps the box where it was while the editor speaks into it, and follows what opened once the message is sent", async () => {
  appliedEdits();
  // Scarlet hasn't asked anything, so with nothing open the box starts a new edit.
  data = { ...data, tasks: data.tasks.map(t => t.state === "waiting_for_user" ? { ...t, state: "done" as const, question: null } : t) };
  useProjectStore.setState({ current: data });
  await show();
  const newEdit = JSON.stringify([PRJ, null]);
  expect([boxTag(), useUiStore.getState().draftOwner]).toEqual([undefined, newEdit]);
  // The editor starts talking, with nothing typed. Scarlet asks a question while they speak. Aiming the box at it would
  // build the box again, dropping the recording, or send the rest of what they say as the answer.
  await act(async () => useUiStore.getState().setSpeaking(true));
  const base = data.tasks.find(t => t.kind !== "transcribe")!;
  const now = new Date().toISOString();
  await event(d => ({ ...d, tasks: [...d.tasks, { ...base, id: "task_asking", state: "waiting_for_user" as const, createdAt: now, startedAt: now,
    finishedAt: undefined, summary: null, changeIds: [], question: "Smaller by how much?", context: { changeId: "chg_approved_2", message: "Carry on" } }] }));
  expect(threadWith("chg_approved_2").question?.id).toBe("task_asking");
  expect([boxTag(), useUiStore.getState().draftOwner]).toEqual([undefined, newEdit]);
  expect(aimLine()).toEqual(["Starting a new edit", false, "Move here"]);
  // Opening an edit while they speak leaves it there too, as it does a message being typed.
  await click(turnFor("chg_approved_2").querySelectorAll(".simple-edits .simple-edit")[1]!);
  await act(async () => {});
  expect(editPanel()).not.toBeNull();
  expect([boxTag(), useUiStore.getState().draftOwner]).toEqual([undefined, newEdit]);
  // Once what they said has gone out, or was dropped, the box follows what's open: the edit.
  await act(async () => useUiStore.getState().setSpeaking(false));
  expect(boxTag()).toBe("Edit at 0:00");
  expect(useUiStore.getState().draftOwner).toBe(JSON.stringify([PRJ, threadWith("chg_approved_2").id]));
  // Spoken again with the edit open, the box stays on the edit when it closes, and goes to the question after.
  await act(async () => useUiStore.getState().setSpeaking(true));
  await press("Escape");
  expect(editPanel()).toBeNull();
  expect(boxTag()).toBe("Edit at 0:00");
  await act(async () => useUiStore.getState().setSpeaking(false));
  expect(boxTag()).toBe("Answer");
});

it("leaves a spoken message where it was said: Move here, the tag's × and words typed and sent meanwhile wait until it is out", async () => {
  appliedEdits();
  // Scarlet hasn't asked anything, so with nothing open the box starts a new edit.
  data = { ...data, tasks: data.tasks.map(t => t.state === "waiting_for_user" ? { ...t, state: "done" as const, question: null } : t) };
  useProjectStore.setState({ current: data });
  await show();
  const onEdit = JSON.stringify([PRJ, threadWith("chg_approved_2").id]), newEdit = JSON.stringify([PRJ, null]);
  await click(turnFor("chg_approved_2").querySelectorAll(".simple-edits .simple-edit")[1]!);
  await act(async () => {});
  expect([boxTag(), useUiStore.getState().draftOwner]).toEqual(["Edit at 0:00", onEdit]);
  // The editor speaks into the box about the edit, and closes it meanwhile. The box stays on the edit.
  await act(async () => useUiStore.getState().setSpeaking(true));
  await press("Escape");
  expect(editPanel()).toBeNull();
  expect([boxTag(), useUiStore.getState().draftOwner]).toEqual(["Edit at 0:00", onEdit]);
  // The line still says where the message goes, but its button can't bring a recording along: building the box again
  // would drop it. The tag's × can't take the box elsewhere either.
  expect(aimLine()).toEqual(["Revising “captions” at 0:00", false, "New edit instead"]);
  expect(container.querySelector<HTMLButtonElement>(".simple-target button")!.disabled).toBe(true);
  await act(async () => composer.props!.onClearTarget!());
  expect([boxTag(), useUiStore.getState().draftOwner]).toEqual(["Edit at 0:00", onEdit]);
  // Words typed and sent while it records don't free the box: the recording is still in it.
  await act(async () => composer.props!.onSent!());
  expect([boxTag(), useUiStore.getState().draftOwner]).toEqual(["Edit at 0:00", onEdit]);
  // Once the spoken message is out, the box follows the chat: nothing is open or asked, so it starts a new edit.
  await act(async () => useUiStore.getState().setSpeaking(false));
  expect([boxTag(), useUiStore.getState().draftOwner, useUiStore.getState().agentContext]).toEqual([undefined, newEdit, null]);
  expect(aimLine()).toBeNull();
});

it("takes the box off a suggestion when its card closes after Revise, as off a cut or an edit", async () => {
  vi.spyOn(api, "timeline").mockImplementation(async (_, version = "head") => ({ timeline: { ...data.timeline!, version } }));
  await show();
  // Scarlet's question waits, so with nothing open the box answers it.
  expect(boxTag()).toBe("Answer");
  await click(suggestion("chg_ready"));
  await act(async () => {});
  // Revise (R) aims the box at the suggestion on the card. That is what's open, so the line naming it is for screen readers.
  await press("r");
  expect([boxTag(), useUiStore.getState().agentContext]).toMatchObject(["Whole edit", { changeId: "chg_ready", label: "Suggestion" }]);
  expect(aimLine()).toEqual(["Revising this suggestion", true, undefined]);
  // Esc closes the card, and the empty box goes back to Scarlet's question.
  await press("Escape");
  expect(container.querySelector('[aria-label="Suggestion"]')).toBeNull();
  expect([boxTag(), useUiStore.getState().agentContext]).toEqual(["Answer", null]);
  expect(aimLine()?.slice(1)).toEqual([true, undefined]);
  // A message written to the suggestion stays aimed at it when the card closes, and the line offers to bring it along.
  await click(suggestion("chg_ready"));
  await act(async () => {});
  await press("r");
  await act(async () => useUiStore.getState().setAgentDraft("Make it shorter"));
  await press("Escape");
  expect(container.querySelector('[aria-label="Suggestion"]')).toBeNull();
  expect([boxTag(), useUiStore.getState().agentContext]).toMatchObject(["Whole edit", { changeId: "chg_ready", label: "Suggestion" }]);
  expect(aimLine()).toEqual(["Revising this suggestion", false, "Move here"]);
});

it("lets a box that holds only a space follow the edit that opens, as an empty box does", async () => {
  appliedEdits();
  await show();
  const edits = () => turnFor("chg_approved_2").querySelectorAll<HTMLElement>(".simple-edits .simple-edit");
  await click(edits()[1]!);
  await act(async () => {});
  expect(boxTag()).toBe("Edit at 0:00");
  // Space landed in the box. Nothing is written, so there is no message to keep aimed at the captions.
  await act(async () => useUiStore.getState().setAgentDraft(" "));
  await click(edits()[2]!);
  await act(async () => {});
  expect(openTitle()).toBe("wrap");
  // The box is on the edit that's open now: its tag says so, and no line offers to move anything.
  expect(boxTag()).toBe("Edit at 0:11");
  expect(useUiStore.getState().agentContext).toMatchObject({ changeId: "chg_approved_2", editIndex: 2 });
  expect(aimLine()).toEqual(["Revising “wrap” at 0:11", true, undefined]);
});

it("keeps the message box and Undo edit on an edit that's opened again while it's open", async () => {
  appliedEdits();
  await show();
  const need = () => turnFor("chg_approved_2").querySelector<HTMLElement>(".simple-pass-need")!;
  await click(need());
  await act(async () => {});
  const aimed = aimLine();
  expect(aimed?.[0]).toContain("Revising “wrap”");
  expect(boxTag()).toBe("Edit at 0:11");
  // Its own row pressed again, as a press on its dot on the timeline is: the edit stays open and the box stays on it.
  await click(turnFor("chg_approved_2").querySelector('.simple-edit[aria-current="true"]')!);
  await act(async () => {});
  expect(editPanel()).not.toBeNull();
  expect(aimLine()).toEqual(aimed);
  expect(useUiStore.getState().agentContext).toMatchObject({ changeId: "chg_approved_2", editIndex: 2 });
  expect(boxTag()).toBe("Edit at 0:11");
  expect(undoIcon()).not.toBeNull();
});

it("brings a message kept for a request back aimed as it was, not at what's open now", async () => {
  appliedEdits();
  flagged();
  const createTask = vi.fn().mockResolvedValue({ id: "task_undo" });
  useProjectStore.setState({ current: data, createTask });
  await show();
  await act(async () => {});
  const edits = () => turnFor("chg_approved_2").querySelectorAll<HTMLElement>(".simple-edits .simple-edit");
  await click(edits()[1]!);
  await act(async () => {});
  await act(async () => useUiStore.getState().setAgentDraft("Make the captions smaller"));
  // Revise on a call takes the box to that cut. The message about the captions is kept for its own request.
  await reviewCalls();
  await press("r");
  expect(boxNow()).toMatchObject(["", { changeId: "chg_ready", cutIndex: 1 }, JSON.stringify([PRJ, threadWith("chg_ready").id])]);
  // Another edit of the first request brings the message back. It is still about the captions, and the line says so.
  await click(edits()[2]!);
  await act(async () => {});
  expect(boxNow()).toMatchObject(["Make the captions smaller", { changeId: "chg_approved_2", editIndex: 1 }, JSON.stringify([PRJ, threadWith("chg_approved_2").id])]);
  expect(aimLine()).toEqual(["Revising “captions”", false, "Move here"]);
  // Undo edit is about the edit that's open, so it undoes that edit, not the one the message is about.
  // The message keeps its aim through it.
  await click(undoIcon());
  expect(createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    instruction: "Undo edit 3, “wrap”. Put back exactly what this edit changed and leave every other edit as it is.",
    context: expect.objectContaining({ changeId: "chg_approved_2", editIndex: 2, threadId: threadWith("chg_approved_2").id }) }));
  expect(editPanel()).toBeNull();
  expect(boxNow()).toMatchObject(["Make the captions smaller", { changeId: "chg_approved_2", editIndex: 1 }, JSON.stringify([PRJ, threadWith("chg_approved_2").id])]);
});

it("says Queued on the card of a cut sent back until Scarlet starts on it, and steps through it with the arrows", async () => {
  finishedPass();
  await show();
  await act(async () => {});
  const started = new Date().toISOString();
  // The first cut is being revised. A note on the aside, sent as a new request, waits its turn.
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_first", 0, { kind: "revise" as const, state: "running" as const, startedAt: started, expectedSeconds: undefined })] }));
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_ready" ? { ...c, state: "revising" as const } : c) }));
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_second", 2, { kind: "edit" as const, instruction: "Keep the aside.", expectedSeconds: undefined })] }));
  // Only the second cut still waits on the editor. The other two are with Scarlet.
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("1 needs you");
  await click(passCard().querySelector(".simple-pass-need")!);
  expect(passRows().map(r => [r.querySelector(".simple-pass-label")?.textContent, r.querySelector(".simple-pass-value")?.textContent]))
    .toEqual([["A clean retake.", "Revising…"], ["Breath before the price.", undefined], ["Repeated aside.", "Revising…"]]);
  // Each call has its number among all three, amber only on the one that still waits.
  expect(passRows().map(r => [r.querySelector(".edit-badge")?.textContent, r.querySelector(".edit-badge")?.classList.contains("is-check")])).toEqual([["1", false], ["2", true], ["3", false]]);
  // ↓ steps from the call still waiting to the one that waits its turn. Its card says it's queued, and its number is
  // its place among all three.
  // "1 needs you" opened the call still waiting.
  expect(passRow("Breath before the price.").getAttribute("aria-current")).toBe("true");
  await press("ArrowDown");
  expect([onVideo(), call().querySelector(".edit-card-status")?.textContent]).toEqual(["Showing cut at 0:11 · 3 of 3 · After", "Queued"]);
  // ↑ steps back through every call, the one Scarlet is revising too.
  await press("ArrowUp");
  expect([onVideo(), !!buttonIn(call(), "Approve")]).toEqual(["Showing cut at 0:06 · 2 of 3 · After", true]);
  await press("ArrowUp");
  expect([onVideo(), call().querySelector(".edit-card-status")?.textContent]).toEqual(["Showing cut at 0:02 · 1 of 3 · After", "Revising…"]);
  // Scarlet starts on the note about the aside. It wasn't sent as a revision, but its card says Scarlet is on it.
  await press("ArrowDown");
  await press("ArrowDown");
  expect(call().querySelector(".edit-card-status")?.textContent).toBe("Queued");
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_second" ? { ...t, state: "running" as const, startedAt: started } : t) }));
  expect(call().querySelector(".edit-card-status")?.textContent).toBe("Revising…");
});

/**
 * A completed request in the waiting pass's thread applied an edit Scarlet flagged, so "N need you" counts it
 * with the pass's calls even while the pass runs. It sits after the last staged cut.
 */
const flaggedPart = () => {
  const pass = data.tasks.find(t => t.id === "task_done")!;
  const part = { ...data.changes.find(c => c.id === "chg_approved_2")!, id: "chg_part", taskId: "task_wrap", threadId: undefined, noteIds: [],
    timelineEdits: [{ label: "wrap", range: { start: 13, end: 16 }, check: CHECK, summary: SUMMARY }] };
  const wrap = { ...pass, id: part.taskId, state: "done" as const, changeIds: [part.id],
    context: { changeId: "chg_ready" }, instruction: "Tighten the wrap", createdAt: part.createdAt, finishedAt: part.updatedAt };
  data = { ...data, changes: [...data.changes, part], tasks: [...data.tasks, wrap] };
  useProjectStore.setState({ current: data });
  const request = threadWith("chg_ready").id;
  vi.spyOn(api, "threadEdits").mockImplementation(async (_project, threadId) => ({ version: useProjectStore.getState().current!.project.head!,
    edits: threadId !== request ? [] : [{ changeId: "chg_part", spot: 0, label: "wrap", range: { start: 13, end: 16 }, previous: [], check: CHECK, summary: SUMMARY }] }));
};
const needYou = () => passCard().querySelector(".simple-pass-need")?.textContent;

it("opens the request's flagged edit after its last call, where need you still counts it", async () => {
  const { save } = runningPass();
  flaggedPart();
  await show();
  await act(async () => {});
  // Three calls and one flagged edit wait. "4 need you" opens the first of them, a call.
  expect(needYou()).toBe("4 need you");
  await reviewCalls();
  await press("a");
  await press("a");
  expect([call().querySelector(".edit-card-count")?.textContent, needYou()]).toEqual(["Cut 3", "2 need you"]);
  // The last call schedules the pass, since Scarlet is still on it. The flagged edit still waits, so it opens in the
  // call's place: the card doesn't close on "1 needs you".
  await press("a");
  await act(async () => {});
  expect(save).toHaveBeenLastCalledWith("chg_ready", expect.objectContaining({ applyWhenDone: true }));
  expect(container.querySelector('[aria-label="Call"]')).toBeNull();
  // It has the number it has among the calls, after them: the card and the box say it as its line in the chat does.
  expect([editPanel()?.querySelector(".edit-card-title")?.textContent, cardCount(), needYou()]).toEqual([SUMMARY, "Edit 4", "1 needs you"]);
  expect(boxTag()).toBe("Edit 4");
  // Kept, nothing of the request waits and the card closes.
  await press("k");
  expect([editPanel(), needYou()]).toEqual([null, undefined]);
});

it("says what Scarlet said as the pass finished, and what it applied so far, above the calls still waiting", async () => {
  finishedPass();
  flaggedPart();
  const said = "Review the flagged directions. The sponsor pickup remains after the outro.";
  data = { ...data, tasks: data.tasks.map(t => t.id === "task_done" ? { ...t, reply: said } : t) };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  const note = passCard().closest(".unit")!.querySelector<HTMLElement>(".req-say")!;
  const made = passCard().querySelector<HTMLElement>(".simple-made")!;
  const list = passCard().querySelector<HTMLElement>(".simple-pass-list")!;
  expect([note?.textContent, made?.textContent, list?.getAttribute("aria-label")]).toEqual([said, `${SUMMARY}.`, "Calls that need you"]);
  // Scarlet's words, then the sentence (the one edit applied so far says what it did), then the calls and the
  // flagged edit, one run of numbers.
  expect([note.compareDocumentPosition(made), made.compareDocumentPosition(list)].map(p => !!(p & Node.DOCUMENT_POSITION_FOLLOWING))).toEqual([true, true]);
  expect(passRows().map(r => r.querySelector(".edit-badge")?.textContent)).toEqual(["1", "2", "3", "4"]);
});

it("opens the request's first waiting call after its last flagged edit is kept", async () => {
  runningPass();
  flaggedPart();
  await show();
  await act(async () => {});
  // The editor starts on the flagged edit, from its row among the calls.
  await click(passRow("wrap"));
  await act(async () => {});
  expect([editPanel()?.querySelector(".edit-card-title")?.textContent, cardCount()]).toEqual([SUMMARY, "Edit 4"]);
  // K keeps it. Three calls of the same request still wait, so the first of them opens.
  await press("k");
  expect(editPanel()).toBeNull();
  expect([call().querySelector(".edit-card-count")?.textContent, needYou(), boxTag()]).toEqual(["Cut 1", "3 need you", "Cut 1"]);
});

it("keeps the waiting pass's flagged edit on the timeline, numbered after its calls, with a call open and with a request behind the pass", async () => {
  runningPass();
  flaggedPart();
  zoomAtOnce();
  await show();
  await act(async () => {});
  const marks = () => [...container.querySelectorAll<HTMLElement>(".simple-timeline-mark")].map(m => m.classList.contains("is-numbered") ? m.textContent : `${m.dataset.state} dot`);
  // The three calls have their numbers, and the flagged edit has the next: "4 need you" is one run of numbers, the
  // same as the list's.
  expect(marks()).toEqual(["1", "2", "3", "4"]);
  expect(passRows().map(r => r.querySelector(".edit-badge")?.textContent)).toEqual(["1", "2", "3", "4"]);
  const strip = () => { const el = container.querySelector<HTMLElement>(".simple-timeline-hover")!; el.getBoundingClientRect = () => ({ left: 0, width: 1000 }) as DOMRect; return el; };
  const dot = [...container.querySelectorAll<HTMLElement>(".simple-timeline-mark")].find(m => m.textContent === "4")!;
  await act(async () => { strip().dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: parseFloat(dot.style.left) * 10 })); });
  expect(container.querySelector(".simple-timeline-tip b")?.textContent).toBe("Edit 4 · 0:13");
  await act(async () => { strip().dispatchEvent(new PointerEvent("pointerleave", { bubbles: true, pointerId: 1 })); });
  // With a call open and the whole video in view, the flagged edit still has its dot: "4 need you" still counts it.
  await openCall("Breath before the price.");
  await press("0");
  expect(call()).not.toBeNull();
  expect([marks(), needYou()]).toEqual([["1", "3", "4"], "4 need you"]);
  await press("Escape");
  // A request waits behind the pass. It is the latest, so the timeline goes to it: the window asks for its edits, as
  // only the timeline does for a request that has applied none.
  const base = data.tasks.find(t => t.id === "task_done")!;
  const asked = vi.mocked(api.threadEdits);
  asked.mockClear();
  await event(d => ({ ...d, tasks: [...d.tasks, { ...base, id: "task_next", state: "queued" as const, startedAt: undefined, finishedAt: undefined, summary: null,
    changeIds: [], instruction: "Add a lower third with my name.", createdAt: new Date(Date.now() + 1000).toISOString(), context: { message: "Add a lower third with my name." } }] }));
  await act(async () => {});
  const next = buildThreads(data).find(t => t.tasks.some(task => task.id === "task_next"))!.id;
  expect(asked.mock.calls.map(([, threadId]) => threadId)).toContain(next);
  // The pass's calls and its flagged edit are still marked.
  expect(marks()).toEqual(["1", "2", "3", "4"]);
});

it("keeps the number a call or a flagged edit was shown under when another call arrives, which takes the next", async () => {
  runningPass();
  flaggedPart();
  // Scarlet has asked about two of the three staged cuts so far.
  const asked = (n: number) => askAll(STAGED).slice(0, n).map((a, i) => ({ ...a, askOrder: i + 1 }));
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, cutAssessments: asked(2) } : c) };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  const numbers = () => passRows().map(r => [r.querySelector(".edit-badge")?.textContent, r.querySelector(".simple-pass-label")?.textContent]);
  expect(numbers()).toEqual([["1", "A clean retake."], ["2", "Breath before the price."], ["3", "wrap"]]);
  // It asks about the third. Until 2026-11-11 that call took 3 and the edit moved up to 4, so on a pass still at work
  // every number after a new call changed under the editor. The edit is still 3, and the new call is 4.
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_ready" ? { ...c, cutAssessments: asked(3) } : c) }));
  expect([needYou(), numbers()]).toEqual(["4 need you", [["1", "A clean retake."], ["2", "Breath before the price."], ["3", "wrap"], ["4", "Repeated aside."]]]);
  const marks = () => [...container.querySelectorAll<HTMLElement>(".simple-timeline-mark")].map(m => m.textContent);
  expect(marks()).toEqual(["1", "2", "4", "3"]);
  // Its number is past the calls' own run, so its dot says the number alone, not "Cut 4 of 3".
  const strip = () => { const el = container.querySelector<HTMLElement>(".simple-timeline-hover")!; el.getBoundingClientRect = () => ({ left: 0, width: 1000 }) as DOMRect; return el; };
  const tip = async (n: string) => {
    const dot = [...container.querySelectorAll<HTMLElement>(".simple-timeline-mark")].find(m => m.textContent === n)!;
    await act(async () => { strip().dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: parseFloat(dot.style.left) * 10 })); });
    return container.querySelector(".simple-timeline-tip b")?.textContent;
  };
  expect([await tip("2"), await tip("4"), await tip("3")]).toEqual(["Cut 2 of 3 · 0:06", "Cut 4 · 0:11", "Edit 3 · 0:13"]);
  // Opened again, the project shows the numbers the editor has seen.
  await act(async () => root.unmount());
  root = createRoot(container);
  await show();
  await act(async () => {});
  expect(numbers().map(([n]) => n)).toEqual(["1", "2", "3", "4"]);
});

it("keeps a revised call's number on its card and on the note about it that waits its turn", async () => {
  finishedPass();
  // Scarlet asked about the cut at 0:11 first, then about 0:06, then about 0:02: the cut at 0:02 is Cut 3.
  const order: Record<number, number> = { 2: 1, 1: 2, 0: 3 };
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, cutAssessments: askAll(STAGED).map(a => ({ ...a, askOrder: order[a.index] })) } : c) };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  // Two notes on Cut 3. Scarlet is on the first; the second waits its turn, tagged with the call.
  const now = new Date().toISOString();
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_note1", 0, { kind: "edit" as const, state: "running" as const, startedAt: now }), callRequest("task_note2", 0, laterNote)] }));
  const tag = () => [...container.querySelectorAll<HTMLElement>(".queue-row, .queue-head")].find(r => r.textContent?.includes("Start it later."))
    ?.querySelector(".queue-target")?.textContent;
  expect(tag()).toBe("Cut 3");
  // The first moves the cut. The engine keeps the call's place among the calls, and the tag stays.
  await revisedCut("task_note1", "chg_ready", 0, { start: 1.5, end: 3 }, "Starts in the pause.");
  await event(d => ({ ...d, changes: d.changes.map(c => c.id !== "chg_revised" ? c
    : { ...c, cutAssessments: c.cutAssessments!.map(a => a.index === 0 ? { ...a, revised: true, askOrder: 3 } : a) }),
    tasks: d.tasks.map(t => t.id === "task_note1" ? { ...t, state: "done" as const, finishedAt: new Date().toISOString() } : t) }));
  await act(async () => {});
  expect(tag()).toBe("Cut 3");
  // The editor takes the second note out of the queue, and opens the revised call: its card says Cut 3 too.
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_note2" ? { ...t, state: "cancelled" as const } : t) }));
  await click(passRow("Starts in the pause."));
  expect(call().querySelector(".edit-card-count")?.textContent).toBe("Cut 3");
});

it("leaves the flagged edit open and playing when the last call applies the pass under it", async () => {
  finishedPass();
  flaggedPart();
  let applied!: () => void;
  const approve = vi.fn(() => new Promise(resolve => { applied = () => resolve({ outcome: "applied" }); }));
  useProjectStore.setState({ approve: approve as never });
  await show();
  await act(async () => {});
  await reviewCalls();
  await press("a");
  await press("a");
  // The pass has finished, so its last call applies it. The flagged edit opens at once, while the pass applies.
  await press("a");
  await act(async () => {});
  expect(approve).toHaveBeenCalledWith("chg_ready", undefined, []);
  expect([editPanel()?.querySelector(".edit-card-title")?.textContent, cardCount()]).toEqual([SUMMARY, "Edit 4"]);
  // Applied, the edit is still open and nothing pauses it.
  const pause = vi.spyOn(player, "pause");
  await act(async () => applied());
  expect(pause).not.toHaveBeenCalled();
  expect(editPanel()?.querySelector(".edit-card-title")?.textContent).toBe(SUMMARY);
});

it("keeps a previously unnumbered call in place when the engine publishes an earlier cut and backfills its order", async () => {
  runningPass();
  const [early, , later] = askAll(STAGED);
  const update = (cutAssessments: NonNullable<ProjectData["changes"][number]["cutAssessments"]>) =>
    event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_ready" ? { ...c, cutAssessments } : c) }));
  await update([later!]);
  await showFolded();
  await reviewCalls();
  const first = passRows()[0], card = call();
  expect(first?.textContent).toBe(`1${later!.reason}`);
  await update([{ ...early!, askOrder: 2 }, { ...later!, askOrder: 1 }]);
  expect(passRows().map(r => r.textContent)).toEqual([`1${later!.reason}`, `2${early!.reason}`]);
  expect(passRows()[0]).toBe(first);
  expect(call()).toBe(card);
  expect(card.querySelector(".edit-card-count")?.textContent).toBe("Cut 1");
});

it("numbers each call in the order it reached the editor, so an ask earlier in the video doesn't renumber the calls before it", async () => {
  runningPass();
  // Scarlet has asked about the cut at 0:11 first, then about the one at 0:06. The cut at 0:02 it hasn't checked yet.
  const asks = askAll(STAGED);
  const asked = (order: Record<number, number>) => asks.flatMap(a => order[a.index] ? [{ ...a, askOrder: order[a.index] }] : []);
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, cutAssessments: asked({ 2: 1, 1: 2 }) } : c) };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  const badges = () => passRows().map(r => [r.querySelector(".edit-badge")?.textContent, r.querySelector(".simple-pass-label")?.textContent]);
  const dots = () => [...container.querySelectorAll<HTMLElement>(".simple-timeline-mark.is-numbered")].map(d => d.textContent);
  // The short list follows publication order. The dots sit where the footage is.
  expect(badges()).toEqual([["1", STAGED[2]!.reason], ["2", STAGED[1]!.reason]]);
  expect(dots()).toEqual(["2", "1"]);
  // A note on the cut at 0:11 waits its turn: it is tagged with that call's number.
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_about", 2, { kind: "edit" as const, expectedSeconds: undefined })] }));
  const tag = () => [...container.querySelectorAll<HTMLElement>(".queue-row, .queue-head")].find(r => r.textContent?.includes("Start it later."))
    ?.querySelector(".queue-target")?.textContent;
  expect(tag()).toBe("Cut 1");
  // Scarlet then asks about the cut at 0:02, earlier in the video. It is the third call, and the others keep theirs.
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_ready" ? { ...c, cutAssessments: asked({ 2: 1, 1: 2, 0: 3 }) } : c) }));
  await act(async () => {});
  expect(badges()).toEqual([["1", STAGED[2]!.reason], ["2", STAGED[1]!.reason], ["3", STAGED[0]!.reason]]);
  expect(tag()).toBe("Cut 1");
  await click(passRow(STAGED[1]!.reason));
  expect(call().querySelector(".edit-card-count")?.textContent).toBe("Cut 2");
});

it("numbers the cuts a pass never checked after its asks, in timeline order, once it hands them over", async () => {
  finishedPass();
  // Scarlet asked about the cuts at 0:06 and 0:11 and stopped before it checked the one at 0:02.
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, cutAssessments: askAll(STAGED).slice(1).map((a, i) => ({ ...a, askOrder: i + 1 })) } : c) };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  // The two asks keep their numbers. The cut no one checked is the editor's call now, and comes after them.
  expect(passRows().map(r => [r.querySelector(".edit-badge")?.textContent, r.querySelector(".simple-pass-label")?.textContent]))
    .toEqual([["1", STAGED[1]!.reason], ["2", STAGED[2]!.reason], ["3", STAGED[0]!.reason]]);
  await click(passRow(STAGED[0]!.reason));
  expect([call().querySelector(".edit-card-count")?.textContent, call().querySelector(".edit-card-title")?.textContent?.startsWith("Not checked yet.")]).toEqual(["Cut 3", true]);
});

it("heads each request with the editor's words alone, and tags a request about one call with its cut", async () => {
  finishedPass();
  await show();
  await act(async () => {});
  const names = () => units().map(u => u.querySelector(".unit-msg p")?.textContent);
  // Every request in the conversation asked for an edit of its own: its heading is the editor's words, with no number
  // or tag before them. "Edit N" is only ever an edit Scarlet made.
  const before = names();
  expect(before.length).toBeGreaterThan(1);
  expect(units().map(u => [u.querySelector(".unit-msg .simple-revising"), u.querySelector(".unit-msg")!.textContent!.startsWith("You")])).toEqual(before.map(() => [null, true]));
  // Each call still waiting has an amber dot on the timeline with its number, the one it has in the pass's list.
  const dots = () => [...container.querySelectorAll<HTMLElement>(".simple-timeline-mark.is-numbered")].map(d => [d.querySelector(".simple-timeline-number")?.textContent, d.dataset.state]);
  expect(dots()).toEqual([["1", "check"], ["2", "check"], ["3", "check"]]);
  expect(container.querySelector(".simple-timeline-mark.is-dot")).toBeNull();
  // A note on the third call waits its turn. In the tray it is tagged with the call's number, and it takes no number
  // of its own: the chat's blocks stay as they are.
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_about", 2, { kind: "edit" as const, expectedSeconds: undefined })] }));
  const queued = [...container.querySelectorAll<HTMLElement>(".queue-row, .queue-head")].find(r => r.textContent?.includes("Start it later."));
  expect(queued?.querySelector(".queue-target")?.textContent).toBe("Cut 3");
  expect(names()).toEqual(before);
  // Scarlet starts on it. It is tagged with its cut, as the box and the tray tagged it.
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_about" ? { ...t, state: "running" as const, startedAt: new Date().toISOString() } : t) }));
  const about = container.querySelector<HTMLElement>('.subunit[data-run="task_about"]')!;
  expect([tagIn(about), wordsOf(about.querySelector(".subunit-msg p"))]).toEqual(["Cut 3", "Start it later."]);
  // It is inside the pass's block, under its call, so the conversation has no new block, and the pass's has no tag.
  expect(about.closest(".unit")?.querySelector(":scope > .unit-msg .simple-revising")).toBeNull();
  expect(names()).toEqual(before);
  // That call waits on Scarlet now, so its dot is gone.
  expect(dots()).toEqual([["1", "check"], ["2", "check"]]);
});

it("keeps a request about one cut in the conversation while it's stopped early, and takes it out once it's done", async () => {
  finishedPass();
  // The pass saves why it proposed each cut, which is how a request about one of them finds it again.
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, cutReasons: STAGED.map(r => ({ start: r.start, end: r.end, reason: r.reason })) } : c) };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  const now = new Date().toISOString();
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_about", 0, { kind: "revise" as const, state: "cancelled" as const, startedAt: now, finishedAt: now })] }));
  // Stopped: it stays under its call, headed with its cut, and says so at the right of the editor's words, as a
  // block's heading does. It saved nothing, so that is one row of words with its one action after them: no second
  // "Stopped" row, and nothing to open on the timeline.
  const about = () => container.querySelector<HTMLElement>('.subunit[data-run="task_about"]');
  expect([tagIn(about()), about()?.querySelector(".subunit-msg > .unit-state")?.textContent]).toEqual(["Cut 1", "Stopped"]);
  expect(about()?.querySelector(".req-state, .req-status")).toBeNull();
  expect([...about()!.querySelectorAll(".req-row")].map(row => [row.className, row.textContent, row.querySelector("button")?.textContent])).toEqual([["req-row req-result", "Nothing savedResume", "Resume"]]);
  expect(about()?.closest("li")?.querySelector(":scope > button .simple-pass-label")?.textContent).toBe(STAGED[0]!.reason);
  // Done without changing anything: it stays, since Scarlet's words are the only place that says why.
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_about" ? { ...t, state: "done" as const, summary: "That breath is the join; cutting more clips the next word." } : t) }));
  expect(tagIn(about())).toBe("Cut 1");
  // Done with the cut revised: the pass comes back with it, and the request leaves the conversation.
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_about" ? { ...t, changeIds: ["chg_revised"] } : t),
    changes: [...d.changes.map(c => c.id === "chg_ready" ? { ...c, state: "rejected" as const, replacedBy: "chg_revised" } : c),
      { ...d.changes.find(c => c.id === "chg_ready")!, id: "chg_revised", taskId: "task_about", createdAt: new Date().toISOString() }] }));
  expect(about()).toBeNull();
  expect(container.textContent).not.toContain("Start it later.");
});

it("keeps a request about one cut in the conversation while it's paused for a transcript, with or without its cut revised", async () => {
  finishedPass();
  await show();
  await act(async () => {});
  // The request ended without a transcript it waited for, having said nothing and saved nothing.
  const waited = data.media.find(m => m.kind === "audio" && !m.transcriptId)!;
  const now = new Date().toISOString();
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_about", 0, { kind: "revise" as const, state: "done" as const, startedAt: now, finishedAt: now, needsTranscripts: [waited.id] })] }));
  // Paused is stopped early: it stays under its call, says so at the right of the editor's words, and has its one action.
  // No transcript is being made for it, so that action is the one that starts it.
  const about = () => container.querySelector<HTMLElement>('.subunit[data-run="task_about"]');
  const stands = () => [about()?.closest("li")?.querySelector(":scope > button .simple-pass-label")?.textContent,
    about()?.querySelector(".subunit-msg > .unit-state")?.textContent, about()?.querySelector(".run-wait button")?.textContent];
  expect(stands()).toEqual([STAGED[0]!.reason, "Paused", "Transcribe"]);
  // Paused with the cut already revised: the pass comes back with it, and the request is still there to finish.
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_about" ? { ...t, changeIds: ["chg_revised"] } : t),
    changes: [...d.changes.map(c => c.id === "chg_ready" ? { ...c, state: "rejected" as const, replacedBy: "chg_revised" } : c),
      { ...d.changes.find(c => c.id === "chg_ready")!, id: "chg_revised", taskId: "task_about", createdAt: new Date().toISOString() }] }));
  expect(stands()).toEqual([STAGED[0]!.reason, "Paused", "Transcribe"]);
});

it("keeps a stopped request about one call under its cut, with Resume once the pass is idle again, until that cut is asked about again", async () => {
  finishedPass();
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, cutReasons: STAGED.map(r => ({ start: r.start, end: r.end, reason: r.reason })) } : c) };
  const retryTask = vi.fn().mockResolvedValue(undefined);
  useProjectStore.setState({ current: data, retryTask });
  await show();
  await act(async () => {});
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_about", 0, { kind: "revise" as const, state: "cancelled" as const, startedAt: at(0), finishedAt: at(0) })] }));
  const about = () => container.querySelector<HTMLElement>('.subunit[data-run="task_about"]');
  /** The row it sits under, by Scarlet's note, and the rows of its work with their one action. */
  const stands = () => [about()?.closest("li")?.querySelector(":scope > button .simple-pass-label")?.textContent, about()?.querySelector(".subunit-msg > .unit-state")?.textContent,
    ...[...about()?.querySelectorAll(".req-row") ?? []].map(row => row.textContent)];
  const stopped = [STAGED[0]!.reason, "Stopped", "Nothing savedResume"];
  expect(stands()).toEqual(stopped);
  // The third call is sent back from its card. While Scarlet is on it the stopped request stays under its cut and offers
  // nothing: a revision picked up behind another one would revise the pass as it stood before that one.
  const other = callRequest("task_other", 2, { kind: "revise" as const, state: "running" as const, instruction: "Keep the breath.", createdAt: at(1000), startedAt: at(1000) });
  await event(d => ({ ...d, tasks: [...d.tasks, { ...other, context: { ...other.context, message: "Keep the breath." } }],
    changes: d.changes.map(c => c.id === "chg_ready" ? { ...c, state: "revising" as const } : c) }));
  expect(stands()).toEqual([STAGED[0]!.reason, "Stopped", "Nothing saved"]);
  // That revision lands. A revision sent from a card leaves the pass it revised marked as revising, and the pass comes
  // back as a new one. The stopped request is still under its cut there, not in a block of its own, and it has its
  // Resume back, though it is no longer the last thing asked in the pass.
  await revisedCut("task_other", "chg_ready", 2, { start: 11.2, end: 12 }, "Starts after the breath.");
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_other" ? { ...t, state: "done" as const, finishedAt: at(2000) } : t) }));
  expect(container.querySelector('[data-run="task_other"]')).toBeNull();
  expect(stands()).toEqual(stopped);
  expect(container.querySelector('.unit[data-run="task_about"]')).toBeNull();
  const version = (reason: string) => passRows().find(r => r.textContent?.includes(reason))?.querySelector(".simple-pass-value")?.textContent;
  expect(version("Starts after the breath.")).toBe("v2");
  // The same words about another cut, asked later and done, are another request: they don't take its Resume.
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_same", 1, { kind: "edit" as const, state: "done" as const, createdAt: at(3000), startedAt: at(3000), finishedAt: at(4000) })] }));
  expect(stands()).toEqual(stopped);
  await click(buttonIn(about()!, "Resume")!);
  expect(retryTask).toHaveBeenCalledWith("task_about", { agent: "claude", model: "opus" });
  // A later request about the same cut waits its turn: nothing is offered meanwhile. Once Scarlet begins it, it takes
  // the stopped one's place under the row.
  const later = callRequest("task_later", 0, { kind: "edit" as const, instruction: "Start it two frames later.", createdAt: at(5000) });
  await event(d => ({ ...d, tasks: [...d.tasks, { ...later, context: { ...later.context, message: "Start it two frames later." } }] }));
  expect(stands()).toEqual([STAGED[0]!.reason, "Stopped", "Nothing saved"]);
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_later" ? { ...t, state: "running" as const, startedAt: at(6000) } : t) }));
  expect(about()).toBeNull();
  expect(container.querySelector('.subunit[data-run="task_later"]')?.closest("li")?.querySelector(":scope > button .simple-pass-label")?.textContent).toBe(STAGED[0]!.reason);
  expect(container.querySelector(".simple-thread")!.textContent).not.toContain("Start it later.");
});

it("says Scarlet's note on a revised cut once, on its call's row, when the revision stopped after saving the cut", async () => {
  finishedPass();
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, cutReasons: STAGED.map(r => ({ start: r.start, end: r.end, reason: r.reason })) } : c) };
  useProjectStore.setState({ current: data, retryTask: vi.fn().mockResolvedValue(undefined) });
  await show();
  await act(async () => {});
  const now = new Date().toISOString();
  // The editor sends the first call back. Scarlet saves the revised cut, and the editor stops the request before it ends.
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_about", 0, { kind: "revise" as const, state: "running" as const, startedAt: now })] }));
  await revisedCut("task_about", "chg_ready", 0, { start: 2.2, end: 3 }, "A cleaner retake, from its first word.");
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_about" ? { ...t, state: "cancelled" as const, finishedAt: new Date().toISOString() } : t) }));
  const about = () => container.querySelector<HTMLElement>('.subunit[data-run="task_about"]')!;
  // It stays under its call's row, which has the revised cut and Scarlet's note on it. Under the row, the request has its
  // word and its one action, and doesn't say the note a second time (2026-11-10).
  expect(about().closest("li")?.querySelector(":scope > button .simple-pass-label")?.textContent).toBe("A cleaner retake, from its first word.");
  expect([about().querySelector(".subunit-msg > .unit-state")?.textContent, ...[...about().querySelectorAll(".req-row")].map(row => row.textContent)]).toEqual(["Stopped", "Resume"]);
  expect(about().textContent).not.toContain("A cleaner retake");
});

it("keeps another cut's revision in the pass's history when a stopped revision is picked up after it and lands", async () => {
  finishedPass();
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, cutReasons: STAGED.map(r => ({ start: r.start, end: r.end, reason: r.reason })) } : c) };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  // The first call's revision is stopped. The third call is then revised from its card: the pass comes back as a new one.
  const other = callRequest("task_other", 2, { kind: "revise" as const, state: "running" as const, createdAt: at(1000), startedAt: at(1000) });
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_about", 0, { kind: "revise" as const, state: "cancelled" as const, startedAt: at(0), finishedAt: at(0) }), other],
    changes: d.changes.map(c => c.id === "chg_ready" ? { ...c, state: "revising" as const } : c) }));
  await revisedCut("task_other", "chg_ready", 2, { start: 11.2, end: 12 }, "Starts after the breath.");
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_other" ? { ...t, state: "done" as const, finishedAt: at(2000) } : t) }));
  // Resumed, the stopped revision still names the pass it was sent about. The engine has it revise the pass that waits
  // now, and marks that one as replaced by the pass the revision made.
  const again = { ...callRequest("task_again", 0, { kind: "revise" as const, state: "done" as const, createdAt: at(3000), startedAt: at(3000), finishedAt: at(4000), changeIds: ["chg_again"] }),
    resumeRootId: "task_about" };
  const waited = useProjectStore.getState().current!.changes.find(c => c.id === "chg_revised")!;
  const made = { ...waited, id: "chg_again", taskId: "task_again", toVersion: "ver_again", createdAt: at(4000),
    cutReasons: waited.cutReasons!.map((r, i) => i === 0 ? { start: 2.4, end: 3, reason: "Starts on the breath." } : r),
    cutAssessments: waited.cutAssessments!.map(a => a.index === 0 ? { ...a, start: 2.4, end: 3, reason: "Starts on the breath." } : a) };
  await event(d => ({ ...d, tasks: [...d.tasks.map(t => t.id === "task_about" ? { ...t, retryTaskId: "task_again" } : t), again],
    changes: [...d.changes.map(c => c.id === "chg_revised" ? { ...c, state: "rejected" as const, rejectedFrom: "ready" as const, replacedBy: "chg_again" } : c), made] }));
  await act(async () => {});
  // Both cuts read as revised: the one the resumed request moved, and the one revised before it.
  const version = (reason: string) => passRows().find(r => r.textContent?.includes(reason))?.querySelector(".simple-pass-value")?.textContent;
  expect([version("Starts on the breath."), version("Starts after the breath.")]).toEqual(["v2", "v2"]);
  expect(container.querySelector('[data-run="task_about"]')).toBeNull();
});

it("keeps a request about one call that couldn't finish under its cut, whatever call is on that cut, until the pass is applied", async () => {
  finishedPass();
  // The editor approved the second cut, then sent it back with a note.
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, cutReasons: STAGED.map(r => ({ start: r.start, end: r.end, reason: r.reason })),
    cutChoices: [{ index: 1, start: STAGED[1]!.start, end: STAGED[1]!.end, choice: "cut" as const }] } : c) };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  const now = new Date().toISOString();
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_about", 1, { kind: "revise" as const, state: "failed" as const, error: "The model refused the request.", startedAt: now, finishedAt: now })] }));
  const about = () => container.querySelector<HTMLElement>('.subunit[data-run="task_about"]');
  /** What the row it sits under says, where it stands, and its one action. */
  const stands = () => [passRow(STAGED[1]!.reason).querySelector(".simple-pass-value")?.textContent, about()?.closest("li")?.querySelector(":scope > button .simple-pass-label")?.textContent,
    about()?.querySelector(".subunit-msg > .unit-state")?.textContent, about() && buttonIn(about()!, "Retry")?.textContent];
  // The revision couldn't finish, so the cut is as the editor approved it. The request doesn't leave with the call that
  // was already on the cut: the chat says it couldn't finish, under its cut, with Retry (2026-11-09: it left at once,
  // and the row read Approved as if nothing had been asked).
  expect(stands()).toEqual(["Approved", STAGED[1]!.reason, "Couldn’t finish", "Retry"]);
  // A call made since leaves it there too: nothing says which call came after the request.
  await click(passRow(STAGED[1]!.reason));
  expect(call().querySelector(".edit-card-count")?.textContent).toBe("Cut 2");
  await press("s");
  await act(async () => {});
  expect(stands()).toEqual(["Skipped", STAGED[1]!.reason, "Couldn’t finish", "Retry"]);
  // The pass is applied: every call is made, and the request leaves with them.
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_ready" ? { ...c, state: "approved" as const, appliedVersion: c.toVersion } : c) }));
  await act(async () => {});
  expect(container.querySelector('[data-run="task_about"]')).toBeNull();
  expect(container.querySelector(".simple-thread")!.textContent).not.toContain("Start it later.");
});

it("reads a cut that one revision saved twice as revised once, from the cut the editor sent back", async () => {
  finishedPass();
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, cutReasons: STAGED.map(r => ({ start: r.start, end: r.end, reason: r.reason })) } : c) };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  // The second call is sent back from its card.
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_revise", 1, { kind: "revise" as const, state: "running" as const, createdAt: at(0), startedAt: at(0) })],
    changes: d.changes.map(c => c.id === "chg_ready" ? { ...c, state: "revising" as const } : c) }));
  // Scarlet saves the cut, looks again and saves it a second time in the same run. The engine puts the first attempt
  // away as replaced by the second, so one pass waits.
  await revisedCut("task_revise", "chg_ready", 1, { start: 6.2, end: 7 }, "Starts after the breath.");
  const first = useProjectStore.getState().current!.changes.find(c => c.id === "chg_revised")!;
  const second = { ...first, id: "chg_again", toVersion: "ver_again", createdAt: at(1000),
    cutReasons: first.cutReasons!.map((r, i) => i === 1 ? { start: 6.4, end: 7, reason: "Starts on the next word." } : r),
    cutAssessments: first.cutAssessments!.map(a => a.index === 1 ? { ...a, start: 6.4, end: 7, reason: "Starts on the next word." } : a) };
  await event(d => ({ ...d, changes: [...d.changes.map(c => c.id === "chg_revised" ? { ...c, state: "rejected" as const, rejectedFrom: "ready" as const, replacedBy: "chg_again" } : c), second],
    tasks: d.tasks.map(t => t.id === "task_revise" ? { ...t, state: "done" as const, finishedAt: at(2000), changeIds: ["chg_revised", "chg_again"] } : t) }));
  await act(async () => {});
  // The editor sent it back once. Its row says v2, and its card gives the cut they sent back as the earlier version,
  // not Scarlet's own first attempt (2026-11-09: v3, with that attempt as v2).
  const row = passRow("Starts on the next word.");
  expect(row.querySelector(".simple-pass-value")?.textContent).toBe("v2");
  await click(row);
  const version = call().querySelector(".edit-version");
  expect([version?.textContent, version?.getAttribute("title")]).toEqual(["v2", `v1: ${STAGED[1]!.reason}\nYou: “Start it later.”`]);
});

it("shows a request about one cut as its work while Scarlet is on it, without what Scarlet wrote about it", async () => {
  finishedPass();
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, cutReasons: STAGED.map(r => ({ start: r.start, end: r.end, reason: r.reason })) } : c) };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  const now = new Date().toISOString();
  // The revision was sent as a note on the pass. Scarlet answers the note when it saves the cut, and then works on.
  const wrote = "The join left 0.14 s of dead air. The cut now starts 0.03 s earlier.";
  const asked = callRequest("task_about", 0, { kind: "revise" as const, state: "running" as const, startedAt: now });
  const note = { id: "note_about", projectId: data.project.id, version: "v1", time: STAGED[0]!.start, clipIds: [], text: "Start it later.", changeId: "chg_ready", state: "open" as const,
    author: { type: "human" as const, id: "u", name: "Matt" }, createdAt: now,
    replies: [{ text: wrote, author: { type: "agent" as const, id: "claude", name: "claude" }, createdAt: now }] };
  await event(d => ({ ...d, tasks: [...d.tasks, { ...asked, context: { ...asked.context, noteIds: ["note_about"] } }], notes: [...d.notes, note] }));
  const about = () => container.querySelector<HTMLElement>('.subunit[data-run="task_about"]')!;
  // Under its call: the editor's words with Stop after them, and Scarlet's work. Its reply isn't there.
  expect([wordsOf(about().querySelector(".subunit-msg p")), about().querySelector(".subunit-msg")!.lastElementChild?.textContent]).toEqual(["Start it later.", "Stop"]);
  expect(about().querySelector('[aria-label="Scarlet’s work"]')).not.toBeNull();
  // While Scarlet works on it, one line says what it is doing this moment, as for any request: no stages.
  const doing = () => about().querySelector('.req-now [role="status"]')?.textContent;
  expect(about().querySelector(".req-stage, .req-stages")).toBeNull();
  const toolCall = (name: string, input: object = {}) => ({ type: "tool" as const, at: new Date().toISOString(), text: name, data: { tool: name, input } });
  const scan = { type: "log" as const, at: new Date().toISOString(), text: "Dialogue scan", data: { kind: "editor_progress", scanPage: { mediaId: "med_1", from: 0, end: 60, to: 30 } } };
  await event(d => ({ ...d, taskEvents: { ...d.taskEvents, task_about: [toolCall("dialogue_review_inspect", { index: 0 }), toolCall("dialogue_scan", { from: 12 }), scan] } }));
  expect(doing()).toBe("Reading the dialogue at 0:12");
  await event(d => ({ ...d, taskEvents: { ...d.taskEvents, task_about: [...d.taskEvents.task_about!, toolCall("dialogue_revise_cut")] } }));
  expect(doing()).toBe("Moving the cut");
  expect(about().querySelector(".req-say")).toBeNull();
  expect(container.textContent).not.toContain(wrote);
  // Done without changing the cut: it stays, and Scarlet's words are then the only place that says why.
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_about" ? { ...t, state: "done" as const, finishedAt: new Date().toISOString() } : t) }));
  expect([...about().querySelectorAll(".req-say")].map(el => el.textContent)).toEqual([wrote]);
  // Scarlet then closes the request with a message that says the same again. That message is the one reply, and no row
  // under it starts it a third time.
  const closing = "That cut already starts in the pause, so I left it as it was. The join still has 0.14 s of dead air.";
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_about" ? { ...t, summary: closing } : t) }));
  expect([...about().querySelectorAll(".req-say")].map(el => el.textContent)).toEqual([closing]);
  expect(about().querySelector(".req-row")).toBeNull();
  expect(container.textContent).not.toContain(wrote);
});

it("keeps a call open on its new version when its revision lands", async () => {
  finishedPass();
  const windows = vi.mocked(api.cutPlaybackFile).mockImplementation(async (_, version, range) => ({ ...range, url: `file/${version}` }));
  await show();
  await act(async () => {});
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_revise", 0, { kind: "revise" as const, state: "running" as const, startedAt: new Date().toISOString(), expectedSeconds: undefined })] }));
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_ready" ? { ...c, state: "revising" as const } : c) }));
  // ↑ from the first call still waiting steps to the one being revised.
  await reviewCalls();
  await press("ArrowUp");
  expect(call().querySelector(".edit-card-status")?.textContent).toBe("Revising…");
  // Scarlet saves a draft revision, then changes it again. The row keeps the note the editor sent back while the
  // other two calls remain available, until Scarlet finishes the requested revision.
  windows.mockClear();
  vi.mocked(api.cutReview).mockClear();
  await revisedCut("task_revise", "chg_ready", 0, { start: 1.5, end: 3 }, "Starts in the pause.");
  await act(async () => usePlayerStore.setState({ playing: false, playbackReady: true }));
  // The card still plays the original proposal while a sibling is prepared from the live one.
  expect(api.cutReview).toHaveBeenCalledWith("chg_ready");
  expect(windows.mock.calls.map(([, version, range]) => [version, range.start])).toEqual(expect.arrayContaining([["ver_revised", expect.any(Number)]]));
  expect(windows.mock.calls.some(([, version, range]) => version === "ver_revised" && range.start === 0)).toBe(false);
  expect(passRows().map(r => r.querySelector(".simple-pass-label")?.textContent)).toEqual(STAGED.map(r => r.reason));
  expect(call().querySelector(".edit-card-title")?.textContent).toBe(STAGED[0]!.reason);
  expect(call().querySelector(".edit-card-status")?.textContent).toBe("Revising…");
  expect(buttonIn(call(), "Approve")).toBeUndefined();
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_revised"
    ? { ...c, cutAssessments: c.cutAssessments!.map(a => a.index === 0 ? { ...a, reason: "Keeps the first breath." } : a) } : c) }));
  expect(passRows()[0]?.textContent).not.toContain("Keeps the first breath.");
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_revise" ? { ...t, state: "done" as const, finishedAt: new Date().toISOString() } : t) }));
  await act(async () => {});
  expect(call().querySelector(".edit-card-title")?.textContent).toBe("Keeps the first breath.");
  expect(buttonIn(call(), "Approve")).toBeDefined();
  expect(call().querySelector(".edit-version")?.textContent).toBe("v2");
  // The finished revision has joined the conversation.
  expect(container.querySelector('.unit[data-run="task_revise"]')?.closest(".simple-chat")).not.toBeNull();
});

it("asks the engine for a request's edits once", async () => {
  const asked = markers();
  await show();
  await act(async () => {});
  const times = new Map<string, number>();
  for (const [, threadId] of asked.mock.calls) times.set(threadId, (times.get(threadId) ?? 0) + 1);
  expect([...times.values()].filter(n => n > 1)).toEqual([]);
});

it("opens a finished request's edits from its result line, with no chevron, time or steps beside it", async () => {
  markers();
  // The request that made the edits, finished two minutes after it started, with one update along the way.
  const started = new Date(Date.now() - 180_000).toISOString();
  const task = { ...data.tasks.find(t => t.id === "task_done")!, id: "task_made", kind: "edit" as const, state: "done" as const, instruction: "Add music and captions",
    summary: "Added the music bed and captions.", changeIds: ["chg_approved_2"], context: { message: "Add music and captions" }, question: null,
    createdAt: started, startedAt: started, finishedAt: new Date(Date.now() - 60_000).toISOString() };
  data = { ...data, tasks: [...data.tasks, task], taskEvents: { ...data.taskEvents, task_made: [{ type: "log" as const, at: started, text: "Laying the music under the whole edit." }] } };
  useProjectStore.setState({ current: data });
  await showFolded();
  await act(async () => {});
  const turn = turnFor("chg_approved_2");
  const line = () => turn.querySelector<HTMLButtonElement>(".simple-pass-toggle")!;
  const listOpen = () => !!turn.querySelector(".simple-edits, .simple-pass-list, [aria-label=\"Edits\"] ol");
  // What the request made is its line, and the line is what opens its edits: there is no chevron beside it.
  expect([listOpen(), line().getAttribute("aria-expanded"), line().getAttribute("title")]).toEqual([false, "false", expect.stringContaining("Show the edits")]);
  expect(turn.querySelector(".simple-pass-chevron, .run-chevron")).toBeNull();
  // A finished request has no time on it and no steps behind it: Scarlet's updates along the way aren't kept in the chat.
  expect(turn.querySelector(".req-time, .req-step, .req-steps")).toBeNull();
  expect(turn.textContent).not.toContain("Laying the music under the whole edit.");
  await click(line());
  expect([listOpen(), line().getAttribute("aria-expanded"), line().getAttribute("title")]).toEqual([true, "true", expect.stringContaining("Hide the edits")]);
  await click(line());
  expect(listOpen()).toBe(false);
});

/** What was scrolled into view while `during` ran. */
const scrolledIntoView = async (during: (scrolled: Element[]) => Promise<void>) => {
  const scrolled: Element[] = [];
  const scroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
  try { await during(scrolled); } finally {
    if (scroll) Object.defineProperty(Element.prototype, "scrollIntoView", scroll);
    else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
};

it("brings a list the editor opens into view: at the end of a long conversation it would open under the message box", async () => {
  madeRequest();
  await scrolledIntoView(async scrolled => {
    await showFolded();
    await act(async () => {});
    const turn = turnFor("chg_approved_2");
    const line = () => turn.querySelector<HTMLButtonElement>(".simple-pass-toggle")!;
    // Nothing moves until the editor asks: the chat opens at its latest message.
    expect(scrolled).toEqual([]);
    await click(line());
    const first = turn.querySelector(".simple-edits .simple-edit")!;
    expect(scrolled).toEqual([first]);
    // Putting the list away moves nothing.
    await click(line());
    expect(scrolled).toEqual([first]);
  });
});

it("brings a pass's list into view when the editor opens it, and not when its block only moves", async () => {
  appliedPass(false);
  await scrolledIntoView(async scrolled => {
    await showFolded();
    await act(async () => {});
    expect(scrolled).toEqual([]);
    await click(passToggle());
    await act(async () => {});
    const first = turnFor("chg_approved_2").querySelector(".simple-pass-list > li > button")!;
    expect(scrolled).toEqual([first]);
    // The list is open when another request starts and this block is drawn again: nothing is scrolled for that.
    const base = buildDb().tasks.find(t => t.id === "task_done")!;
    await event(d => ({ ...d, tasks: [...d.tasks, { ...base, id: "task_next", kind: "edit" as const, state: "running" as const, instruction: "Add captions.", summary: null, changeIds: [],
      context: { threadId: "task_next", message: "Add captions." }, createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: undefined }] }));
    expect(scrolled).toEqual([first]);
  });
});

it("keeps the chat anchored while scrolling a pass's edits, including when a revision pins the request", async () => {
  const { lists } = appliedPass(true);
  lists[threadWith("chg_approved_2").id] = Array.from({ length: 20 }, (_, spot) => ({
    changeId: "chg_approved_2", spot, label: `Edit ${spot + 1}`, range: { start: spot, end: spot + 1 },
    previous: [], check: CHECK,
  }));
  await withSimpleSheet(async () => {
    await showFolded();
    const pass = turnFor("chg_approved_2").querySelector(".simple-pass")!;
    await click(pass.querySelector(".simple-pass-need")!);
    const list = pass.querySelector(".simple-pass-list")!;
    const label = list.querySelector("li:last-child .simple-pass-time > span")!;
    expect(list.children).toHaveLength(20);
    expect(label.textContent).toContain("needs you");
    expect(styled(label, "position")).toEqual(["absolute"]);
    expect(styled(list, "position", "overflow-y")).toEqual(["relative", "auto"]);

    // Sending a revision moves the request to the pinned pane. Its heading and summary stay above the scrolling rows.
    const base = data.tasks.find(t => t.id === "task_pass")!;
    const now = new Date().toISOString();
    await event(d => ({ ...d, tasks: [...d.tasks, { ...base, id: "task_fix", state: "running", instruction: "Trim this cut.",
      summary: null, changeIds: [], createdAt: now, startedAt: now, finishedAt: undefined,
      context: { threadId: threadWith("chg_approved_2").id, changeId: "chg_approved_2", editIndex: 0, time: 0, message: "Trim this cut." } }] }));
    const pin = container.querySelector(".simple-pin")!;
    const pinnedList = pin.querySelector(".simple-pass-list")!;
    expect(pinnedList.querySelector('.subunit[data-run="task_fix"]')).not.toBeNull();
    expect(pin.querySelector(".simple-made-line")).not.toBeNull();
    for (const section of [pin, pin.querySelector(".unit")!, pin.querySelector(".unit > .req")!, pin.querySelector(".simple-pass")!]) {
      expect(styled(section, "display", "flex-direction", "min-height")).toEqual(["flex", "column", "0"]);
    }
    expect(styled(pinnedList, "max-height", "overflow-y")).toEqual(["none", "auto"]);
  });
});

it("moves on to the next edit when one Scarlet didn't flag is kept, and closes after the last", async () => {
  laterRequest("chg_later", false);
  await show();
  await act(async () => {});
  const turn = turnFor("chg_approved_2");
  await click(turn.querySelector(".simple-edit")!);
  expect(openTitle()).toBe("music bed");
  await press("k");
  expect(openTitle()).toBe("captions");
  await press("k");
  expect(openTitle()).toBe("wrap");
  await press("k");
  expect(editPanel()).toBeNull();
});

it("keeps the open cut's row in view while the arrows step through a pass's list", async () => {
  flagged();
  useProjectStore.setState({ current: data });
  const scrolled: string[] = [];
  const scroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.querySelector(".edit-badge")?.textContent ?? ""); };
  try {
    await show();
    await act(async () => {});
    await click(passCard().querySelector(".simple-pass-need")!);
    expect(scrolled.at(-1)).toBe("1");
    await press("ArrowDown");
    expect(passRows().map(r => r.getAttribute("aria-current"))).toEqual([null, "true"]);
    expect(scrolled.at(-1)).toBe("2");
  } finally {
    if (scroll) Object.defineProperty(Element.prototype, "scrollIntoView", scroll);
    else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
});

it("keeps a request's line as it was while the list for a change that just landed loads", async () => {
  // The engine lists two edits where the saved change names three: one of them is gone from the working cut.
  const later = laterRequest("chg_later", false);
  later.lists[later.earlier] = (later.lists[later.earlier] as object[]).slice(0, 2);
  await showFolded();
  await act(async () => {});
  const line = () => [turnFor("chg_approved_2").querySelector(".simple-made b")?.textContent, turnFor("chg_approved_2").querySelector(".simple-pass-toggle")?.textContent].join(" · ");
  expect(line()).toBe("2 · See both");
  // The change is saved again and the list is asked for again. Until it arrives, the line doesn't fall back to the
  // saved three and then return to two.
  later.hold(later.earlier);
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_approved_2" ? { ...c, appliedVersion: "ver_3" } : c) }));
  expect(line()).toBe("2 · See both");
  await later.release();
  expect(line()).toBe("2 · See both");
});

it("doesn't offer Resume on a stopped request that was asked again and finished", async () => {
  const base = data.tasks.find(t => t.id === "task_done")!;
  const stopped = { ...base, id: "task_stopped", kind: "edit" as const, state: "cancelled" as const, instruction: "/dialogue-pass", summary: null, changeIds: [],
    context: { threadId: "task_stopped", message: "/dialogue-pass" }, createdAt: new Date(Date.now() - 60_000).toISOString(), startedAt: new Date(Date.now() - 60_000).toISOString(),
    finishedAt: new Date(Date.now() - 50_000).toISOString() };
  data = { ...data, tasks: [...data.tasks, stopped] };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  const unit = () => units().find(u => u.dataset.run === "task_stopped")!;
  expect(buttonIn(unit(), "Resume")).toBeDefined();
  // The same request, asked again and done: picking the stopped one up would do the work twice.
  await act(async () => useProjectStore.setState(s => ({ current: { ...s.current!, tasks: [...s.current!.tasks,
    { ...stopped, id: "task_again", state: "done" as const, context: { threadId: "task_again", message: "/dialogue-pass" }, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() }] } })));
  expect(unit().textContent).toContain("Stopped");
  expect(buttonIn(unit(), "Resume")).toBeUndefined();
});

it("keeps Resume on a stopped request about one cut when the same words finish on another request's edit", async () => {
  finishedPass();
  await show();
  await act(async () => {});
  const sent = new Date(Date.now() - 60_000).toISOString();
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_about", 0, { kind: "revise" as const, state: "cancelled" as const, createdAt: sent, startedAt: sent, finishedAt: sent })] }));
  const about = () => container.querySelector<HTMLElement>('.subunit[data-run="task_about"]')!;
  expect(buttonIn(about(), "Resume")).toBeDefined();
  // The same words, sent later about an edit of another request, and done. That work was on the other edit: this
  // cut's revision was never done, so it can still be picked up.
  const now = new Date().toISOString();
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_elsewhere", 0, { kind: "edit" as const, state: "done" as const, startedAt: now, finishedAt: now,
    context: { threadId: threadWith("chg_approved_2").id, changeId: "chg_approved_2", editIndex: 1, message: "Start it later." } })] }));
  expect(about().querySelector(".subunit-msg > .unit-state")?.textContent).toBe("Stopped");
  expect(buttonIn(about(), "Resume")).toBeDefined();
});

it("ends a finished dialogue pass on its calls, without Scarlet's closing message under it", async () => {
  finishedPass();
  const closing = "The first dialogue pass is saved: the recording now runs 27:12.\n\n- **Applied:** the mic check.\n- **Staged, not applied:** three cuts.";
  data = { ...data, taskEvents: { ...data.taskEvents, task_done: [...(data.taskEvents.task_done ?? []), { type: "log" as const, at: new Date().toISOString(), text: closing }] } };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  // The pass ends on what needs the editor: its calls. Scarlet's closing message isn't under it.
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toMatch(/^\d+ need you$/);
  expect(passRows().length).toBeGreaterThan(0);
  expect(container.querySelector(".req-report")).toBeNull();
  expect(container.textContent).not.toContain("The first dialogue pass is saved");
});

it("leaves ← and → to the player, and ↑ and ↓ too while a pass has no call to step to", async () => {
  // Scarlet has asked about nothing: every staged cut is its own pick.
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, cutAssessments: [
    { index: 0, start: 0, end: 220, verdict: "cut" as const, reason: "A clean retake." }] } : c) };
  vi.spyOn(api, "cutReview").mockResolvedValue({ review: { cuts: [{ at: 0, removed: { start: 0, end: 1 }, beforeClip: 0 }],
    original: data.timeline!, proposed: data.timeline!, firstCut: false } });
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  // The workspace's capture listener runs first. It must not take ← or →, or the player never skips.
  let taken: boolean | undefined;
  const after = (e: KeyboardEvent) => { taken = e.defaultPrevented; };
  const arrow = async (key: string) => {
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
    return taken;
  };
  window.addEventListener("keydown", after, true);
  try {
    expect([await arrow("ArrowRight"), await arrow("ArrowDown")]).toEqual([false, false]);
    expect(container.querySelector('[aria-label="Call"]')).toBeNull();
    // With calls waiting, ↑ and ↓ step between them. ← and → still go to the player, so watching never opens a call.
    flagged();
    await event(d => ({ ...d, changes: data.changes }));
    await act(async () => {});
    expect([await arrow("ArrowRight"), await arrow("ArrowLeft")]).toEqual([false, false]);
    expect(container.querySelector('[aria-label="Call"]')).toBeNull();
    expect(await arrow("ArrowDown")).toBe(true);
    expect(container.querySelector('[aria-label="Call"]')).not.toBeNull();
    // And with a call open, ← and → leave it open.
    expect(await arrow("ArrowRight")).toBe(false);
    expect(container.querySelector('[aria-label="Call"]')).not.toBeNull();
  } finally { window.removeEventListener("keydown", after, true); }
});

it("opens a clip from Media at its start, without the cut's marks, and returns the cut to where it was", async () => {
  // Two calls wait, at 0:02 and 0:06 of the cut.
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, cutAssessments: [
    { index: 0, start: 2, end: 3, verdict: "ask" as const, reason: "A clean retake." },
    { index: 1, start: 6, end: 7, verdict: "ask" as const, reason: "Breath before the price." }] } : c) };
  vi.spyOn(api, "cutReview").mockResolvedValue({ review: { cuts: [0, 1].map(i => ({ at: i, removed: { start: i, end: i + 1 }, beforeClip: 0 })),
    original: data.timeline!, proposed: data.timeline!, firstCut: false } });
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  expect(container.querySelectorAll(".simple-timeline-mark").length).toBeGreaterThan(0);
  usePlayerStore.setState({ time: 12.5 });
  await openMenu();
  await click(menuRow("Media"));
  await act(async () => { await vi.dynamicImportSettled(); });
  const play = await vi.waitFor(() => { const b = container.querySelector<HTMLButtonElement>('button[aria-label^="Preview source"]'); if (!b) throw new Error("no Media row yet"); return b; });
  await click(play);
  expect(container.querySelector('[aria-label="Source preview"]')).not.toBeNull();
  // The clip starts at its own beginning, and the pass's amber dots aren't drawn on its timeline.
  expect(usePlayerStore.getState().time).toBe(0);
  expect(container.querySelectorAll(".simple-timeline-mark").length).toBe(0);
  usePlayerStore.setState({ time: 3 });
  await click(buttonIn(container, "Back to the video")!);
  expect(usePlayerStore.getState().time).toBe(12.5);
  expect(container.querySelectorAll(".simple-timeline-mark").length).toBeGreaterThan(0);
});

it("returns the cut to an open cut's join when a clip from Media was played over it", async () => {
  // The cut's footage sat at 0:10 on the version before it, where its card plays. An earlier cut of the same pass took
  // 4 s out ahead of it, so in the video as it runs now the join is at 0:06.
  vi.spyOn(api, "threadEdits").mockImplementation(async (_project, threadId) => ({ version: data.project.head!,
    edits: threadId !== threadWith("chg_approved_2").id ? [] : [
      { changeId: "chg_approved_2", spot: 0, label: "Keep the image test", range: { start: 4, end: 8 }, at: 6,
        beforeCut: { version: "v_before", removed: { start: 10, end: 12.4 } }, previous: [] }] }));
  vi.spyOn(api, "timeline").mockImplementation(async (_, version = "head") => ({ timeline: { ...data.timeline!, version } }));
  await show();
  await click(buttonIn(turnFor("chg_approved_2"), "See edit")!);
  await act(async () => {});
  expect(container.querySelector(".simple-on-video")?.textContent).toBe("Showing “Keep the image test” · After");
  // The editor is inside the cut's passage, on that earlier version's clock.
  await act(async () => usePlayerStore.setState({ time: 11 }));
  await openMenu();
  await click(menuRow("Media"));
  await act(async () => { await vi.dynamicImportSettled(); });
  const play = await vi.waitFor(() => { const b = container.querySelector<HTMLButtonElement>('button[aria-label^="Preview source"]'); if (!b) throw new Error("no Media row yet"); return b; });
  await click(play);
  expect(container.querySelector('[aria-label="Source preview"]')).not.toBeNull();
  expect(usePlayerStore.getState().time).toBe(0);
  await act(async () => usePlayerStore.setState({ time: 3 }));
  // Back on the video the playhead is where closing the cut leaves it, at its join: 0:11 was a time on a version that no longer plays.
  await click(buttonIn(container, "Back to the video")!);
  expect(usePlayerStore.getState().time).toBe(6);
  expect(editPanel()).toBeNull();
});

it("tells Settings and a restart to update where the video is, and opens there on the way back", async () => {
  // Both ask the project's page, before it goes, to add where the editor is to the address they come back to.
  const { captureProjectPlace } = await import("../lib/updatePlace");
  await show();
  await act(async () => usePlayerStore.setState({ time: 9.5 }));
  expect(captureProjectPlace({ pathname: `/p/${PRJ}`, search: "", hash: "" })).toBe(`/p/${PRJ}?t=9.5`);
  // The page goes, and the playhead with it.
  await act(async () => root.unmount());
  usePlayerStore.setState({ time: 0 });
  // Back at that address the video is where it was.
  root = createRoot(container);
  await act(async () => root.render(<MemoryRouter initialEntries={[`/p/${PRJ}?t=9.5`]}><SimpleWorkspace /></MemoryRouter>));
  expect(usePlayerStore.getState().time).toBe(9.5);
});

it("bookmarks a place in the video itself while a suggestion, an open cut or a clip from Media has the player", async () => {
  const { captureProjectPlace } = await import("../lib/updatePlace");
  const place = () => captureProjectPlace({ pathname: `/p/${PRJ}`, search: "", hash: "" });
  // A cut whose join is at 0:06 in the video. Its footage sat at 0:10 on the version before it, where its card plays.
  vi.spyOn(api, "threadEdits").mockImplementation(async (_project, threadId) => ({ version: data.project.head!,
    edits: threadId !== threadWith("chg_approved_2").id ? [] : [
      { changeId: "chg_approved_2", spot: 0, label: "Keep the image test", range: { start: 4, end: 8 }, at: 6,
        beforeCut: { version: "v_before", removed: { start: 10, end: 12.4 } }, previous: [] }] }));
  vi.spyOn(api, "timeline").mockImplementation(async (_, version = "head") => ({ timeline: { ...data.timeline!, version } }));
  await show();
  // A suggestion's After plays a version that isn't the video yet, so there is no time in the video to give.
  await click(suggestion("chg_ready"));
  await act(async () => {});
  await act(async () => usePlayerStore.setState({ time: 5.5 }));
  expect(place()).toBe(`/p/${PRJ}`);
  // Its Before is the video.
  await click(compareButton(container.querySelector('[aria-label="Suggestion"]')!));
  await act(async () => usePlayerStore.setState({ time: 4.5 }));
  expect(place()).toBe(`/p/${PRJ}?t=4.5`);
  await press("Escape");
  expect(container.querySelector('[aria-label="Suggestion"]')).toBeNull();
  // An open cut plays on the version before it. Its place is its join, where closing it goes.
  await click(buttonIn(turnFor("chg_approved_2"), "See edit")!);
  await act(async () => {});
  expect(container.querySelector(".simple-on-video")?.textContent).toBe("Showing “Keep the image test” · After");
  await act(async () => usePlayerStore.setState({ time: 11 }));
  expect(place()).toBe(`/p/${PRJ}?t=6`);
  await press("Escape");
  expect(editPanel()).toBeNull();
  // Behind a clip from Media, it is where the video was left.
  await act(async () => usePlayerStore.setState({ time: 12.5 }));
  await openMenu();
  await click(menuRow("Media"));
  await act(async () => { await vi.dynamicImportSettled(); });
  const play = await vi.waitFor(() => { const b = container.querySelector<HTMLButtonElement>('button[aria-label^="Preview source"]'); if (!b) throw new Error("no Media row yet"); return b; });
  await click(play);
  expect(container.querySelector('[aria-label="Source preview"]')).not.toBeNull();
  await act(async () => usePlayerStore.setState({ time: 3 }));
  expect(place()).toBe(`/p/${PRJ}?t=12.5`);
});

/** The Transcript's heading row, part by part, and the pane under it. */
const transcriptHeading = () => {
  const head = container.querySelector<HTMLElement>(".simple-subhead")!, pane = container.querySelector<HTMLElement>(".simple-transcript")!;
  return { row: [...head.children].map(c => c.textContent), pane, said: (head.textContent! + pane.textContent!).match(/Transcript|interview-take2\.mp4/g) };
};

it("names a clip from Media once on the Transcript's heading, and keeps Mark unused words on a row under it", async () => {
  await show();
  await act(async () => {});
  await openMenu();
  await click(menuRow("Media"));
  await act(async () => { await vi.dynamicImportSettled(); });
  const play = await vi.waitFor(() => { const b = container.querySelector<HTMLButtonElement>('button[aria-label^="Preview source"]'); if (!b) throw new Error("no Media row yet"); return b; });
  await click(play);
  await openTranscript();
  // The clip's name is on the heading with the clip's own figures, and the pane has no title to say it again.
  const { row, pane, said } = transcriptHeading();
  expect(row).toEqual(["Transcript · interview-take2.mp4", "0:00–0:20 · 44 words", "Back to chat"]);
  expect(said).toEqual(["Transcript", "interview-take2.mp4"]);
  // What else the pane's toolbar held for a clip stays in the pane, on a row under the heading.
  expect(pane.querySelector(".reading-tools")?.textContent).toBe("Mark unused words");
});

it("names the footage on the Transcript's heading before the first cut, where the pane's title did", async () => {
  data = { ...data, project: { ...data.project, head: null }, timeline: null, tasks: [], changes: [], notes: [] };
  useProjectStore.setState({ current: data });
  await show();
  await openTranscript();
  const { row, pane, said } = transcriptHeading();
  expect(row).toEqual(["Transcript · interview-take2.mp4", "0:00–0:20 · 44 words", "Back to chat"]);
  expect(said).toEqual(["Transcript", "interview-take2.mp4"]);
  // With no cut there are no unused words to mark, so nothing sits under the heading.
  expect(pane.querySelector(".reading-tools")).toBeNull();
});

it("writes a time past the first hour with its hour, over the player as on the line that names the box's aim", async () => {
  const save = flagged();
  // Scarlet is sure of the other two cuts: the one it asks about is the pass's only call.
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, cutAssessments: [
    { index: 0, start: 0, end: 220, verdict: "cut" as const, reason: "A clean retake." },
    { index: 1, start: 3727, end: 3730, verdict: "ask" as const, reason: "Breath before the price." },
    { index: 2, start: 3800, end: 3802, verdict: "cut" as const, reason: "A clean retake." }] } : c) };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  await reviewCalls();
  expect(save).not.toHaveBeenCalled();
  expect(container.querySelector(".simple-on-video")?.textContent).toBe("Showing cut at 1:02:07 · 1 of 1 · After");
  // The call goes by its number in the box; the line that names the aim says where it is.
  expect(boxTag()).toBe("Cut 1");
  expect(container.querySelector(".simple-target")?.textContent).toContain("Revising the cut at 1:02:07");
});

it("opens Media for a project that was just made without footage, and draws no banner when caching is paused", async () => {
  // The library sends a new, empty project here with ?panel=media.
  await act(async () => root.render(<MemoryRouter initialEntries={["/p/x?panel=media"]}><SimpleWorkspace /></MemoryRouter>));
  await act(async () => { await vi.dynamicImportSettled(); });
  // The drawer has the name of the menu row that opens it.
  await vi.waitFor(() => expect(container.querySelector("dialog[open] h2")?.textContent).toBe("Media"));
  // Pausing changes nothing under the header: Media's rows and the menu say it.
  await event(d => ({ ...d, project: { ...d.project, mediaPaused: true } }));
  expect(container.querySelector(".simple-banner")).toBeNull();
});

it("takes a queued revision's words out of the chat with it when it is removed from the queue", async () => {
  // The editor sent a suggestion back while Scarlet was busy, then took that request out of the tray. Its words were
  // saved as a note on the suggestion.
  const base = data.tasks.find(t => t.id === "task_done")!;
  const words = { ...data.notes[0]!, id: "note_feedback", changeId: "chg_ready", text: "Make the intro shorter still.", state: "open" as const, createdAt: new Date().toISOString() };
  const removed = { ...base, id: "task_removed", kind: "revise" as const, state: "cancelled" as const, startedAt: undefined, hostId: null, summary: null, changeIds: [],
    instruction: words.text, createdAt: words.createdAt, finishedAt: words.createdAt,
    context: { ...base.context, changeId: "chg_ready", threadId: threadWith("chg_ready").id, noteIds: [words.id], message: words.text } };
  data = { ...data, notes: [...data.notes, words], tasks: [...data.tasks, removed] };
  useProjectStore.setState({ current: data });
  await show();
  expect(container.querySelector(".simple-thread")?.textContent).not.toContain("Make the intro shorter still.");
});

it("keeps a request in the conversation once its question is answered, instead of moving it to the queue", async () => {
  const base = data.tasks.find(t => t.kind !== "transcribe")!;
  const now = new Date().toISOString();
  // Scarlet asked a question in this request. Nothing else is running.
  data = { ...data, tasks: [...data.tasks.map(t => ["queued", "claimed", "running", "waiting_for_user"].includes(t.state) ? { ...t, state: "done" as const } : t),
    { ...base, id: "task_asking", state: "waiting_for_user" as const, createdAt: now, startedAt: now, finishedAt: undefined, summary: null, changeIds: [],
      question: "Smaller by how much?", instruction: "Make the logo smaller.", context: { threadId: "task_asking", message: "Make the logo smaller." } }] };
  useProjectStore.setState({ current: data });
  await show();
  const pinned = () => container.querySelector<HTMLElement>(".simple-pin .unit");
  expect(pinned()?.textContent).toContain("Make the logo smaller.");
  // The editor answers. The engine puts the request back in line until Scarlet picks it up again.
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_asking" ? { ...t, state: "queued" as const, question: null, hostId: null } : t) }));
  // It is still the request Scarlet is on: in its place, not a new entry in the tray with a × to remove it.
  expect(pinned()?.textContent).toContain("Make the logo smaller.");
  expect(container.querySelector('[aria-label="Queued requests"]')).toBeNull();
});

it("keeps a stopped pass's unchecked cuts as calls, and the pass in its place, after one of its cuts is revised", async () => {
  flagged();
  const threadId = threadWith("chg_ready").id;
  const ready = data.changes.find(c => c.id === "chg_ready")!;
  const cutReasons = [0, 1, 2].map(i => ({ start: i * 2, end: i * 2 + 1, reason: ["A clean retake.", "Breath before the price.", "Repeated aside."][i]! }));
  vi.spyOn(api, "cutReview").mockResolvedValue({ review: { original: data.timeline!, proposed: data.timeline!, firstCut: false,
    cuts: cutReasons.map((r, at) => ({ at, removed: { start: r.start, end: r.end }, beforeClip: 0 })) } });
  // The pass stopped early: one cut it asks about, one the editor called, one staged and never checked.
  const staged = { ...ready, intent: "suggestion" as const, taskId: "task_done", cutReasons,
    cutAssessments: [{ index: 1, start: 230, end: 233, verdict: "ask" as const, reason: "Breath before the price." }],
    cutChoices: [{ index: 0, start: 0, end: 1, choice: "cut" as const }] };
  // Nothing else is running in this project.
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? staged : c),
    tasks: data.tasks.map(t => t.id === "task_done" ? { ...t, state: "cancelled" as const }
      : ["queued", "claimed", "running", "waiting_for_user"].includes(t.state) ? { ...t, state: "done" as const } : t) };
  useProjectStore.setState({ current: data });
  await showFolded();
  await act(async () => {});
  expect(container.querySelector(".simple-pass-need")?.textContent).toBe("2 need you");
  const asked = units().find(u => u.querySelector(".simple-pass"))!.querySelector(".unit-msg")!.textContent;
  // The editor sends the asked cut back, and its revision lands as a new pass made by that request.
  const base = data.tasks.find(t => t.id === "task_done")!;
  const revision = { ...base, id: "task_revise", kind: "revise" as const, state: "done" as const, instruction: "Start it a beat later.",
    createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), changeIds: ["chg_revised"],
    context: { threadId, changeId: "chg_ready", cutIndex: 1, time: 230, end: 233, message: "Start it a beat later." } };
  await event(d => ({ ...d, tasks: [...d.tasks, revision],
    changes: [...d.changes.map(c => c.id === "chg_ready" ? { ...c, state: "rejected" as const, replacedBy: "chg_revised" } : c),
      { ...staged, id: "chg_revised", taskId: "task_revise", threadId: ready.threadId ?? threadId, cutChoices: [{ index: 0, start: 0, end: 1, choice: "cut" as const }],
        createdAt: new Date().toISOString() }] }));
  await act(async () => {});
  // The cut Scarlet never checked is still the editor's call: the pass stopped, whichever request made this version.
  expect(container.querySelector(".simple-pass-need")?.textContent).toBe("2 need you");
  // And the pass, waiting on those calls, still holds the place above the message box.
  const pinned = container.querySelector<HTMLElement>(".simple-pin .unit")!;
  expect(pinned.querySelector(".unit-msg")?.textContent).toBe(asked);
  expect(pinned.querySelector(".simple-pass")).not.toBeNull();
});

/** Nothing is running and Scarlet has asked nothing, so the message box starts a new edit. */
const idle = () => {
  data = { ...data, tasks: data.tasks.map(t => ["queued", "claimed", "running", "waiting_for_user"].includes(t.state) ? { ...t, state: "done" as const, question: null } : t) };
  useProjectStore.setState({ current: data });
};
const pointTag = () => [composer.props!.targetTag, composer.props!.targetIsPoint];
const offeredTime = () => composer.props!.editHere?.time;
const chooseEditHere = () => act(async () => composer.props!.editHere!.onSelect());

it("offers the latest manual seek for a new request and attaches it only when Edit here is chosen", async () => {
  idle();
  await show();
  expect([offeredTime(), boxTag(), useUiStore.getState().agentContext]).toEqual([undefined, undefined, null]);
  await press("ArrowRight");
  expect([offeredTime(), boxTag(), useUiStore.getState().agentContext]).toEqual(["0:05", undefined, null]);
  const slider = container.querySelector<HTMLElement>(".timeline-slider")!;
  await act(async () => { slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); });
  expect([offeredTime(), boxTag()]).toEqual(["0:10", undefined]);
  // Playback and a subsequent pause offer no timestamp of their own.
  await act(async () => usePlayerStore.setState({ playing: true }));
  expect(offeredTime()).toBeUndefined();
  await act(async () => usePlayerStore.setState({ playing: false, time: 14 }));
  expect([offeredTime(), boxTag()]).toEqual([undefined, undefined]);
  // On a drag, the offered time is where the editor let go.
  slider.getBoundingClientRect = () => ({ left: 0, width: Number(slider.getAttribute("aria-valuemax")) }) as DOMRect;
  slider.setPointerCapture = vi.fn();
  const pointer = (type: string, x: number) => new PointerEvent(type, { bubbles: true, button: 0, isPrimary: true, pointerId: 1, clientX: x });
  await act(async () => {
    slider.dispatchEvent(pointer("pointerdown", 3));
    slider.dispatchEvent(pointer("pointermove", 8));
    slider.dispatchEvent(pointer("pointerup", 9));
  });
  expect([offeredTime(), boxTag(), useUiStore.getState().agentContext]).toEqual(["0:09", undefined, null]);
  await chooseEditHere();
  expect(pointTag()).toEqual(["At 0:09", true]);
  expect(useUiStore.getState().agentContext).toMatchObject({ time: 9 });
  expect(offeredTime()).toBeUndefined();
  await act(async () => useUiStore.getState().setAgentDraft("Zoom in here"));
  await act(async () => usePlayerStore.setState({ playing: true, time: 12 }));
  expect(pointTag()).toEqual(["At 0:09", true]);
  // Browsing while writing keeps the chosen point with the message.
  await act(async () => usePlayerStore.setState({ playing: false }));
  await press("ArrowRight");
  expect(pointTag()).toEqual(["At 0:09", true]);
  await act(async () => composer.props!.onClearTarget!());
  expect(boxNow()).toEqual(["Zoom in here", "whole", JSON.stringify([PRJ, null])]);
  await press("ArrowLeft");
  expect(boxTag()).toBeUndefined();
  expect(useUiStore.getState().agentContext).toBe("whole");
});

it("releases an empty box's attached point on a seek or playback, and offers the new point only on a manual seek", async () => {
  idle();
  await show();
  await press("n");
  expect(pointTag()).toEqual(["At 0:00", true]);
  await press("ArrowRight");
  expect([boxTag(), offeredTime(), useUiStore.getState().agentContext]).toEqual([undefined, "0:05", null]);
  await chooseEditHere();
  expect(pointTag()).toEqual(["At 0:05", true]);
  await act(async () => usePlayerStore.setState({ playing: true }));
  await act(async () => usePlayerStore.setState({ playing: false, time: 0 }));
  expect([boxTag(), offeredTime(), useUiStore.getState().agentContext]).toEqual([undefined, undefined, null]);
});

it("drops an empty box's timestamp when the working cut changes at the same clock time", async () => {
  idle();
  await show();
  await press("n");
  expect(useUiStore.getState().agentContext).toMatchObject({ time: 0, version: data.project.head });
  await event(d => ({ ...d, project: { ...d.project, head: "ver_new_cut" }, timeline: { ...d.timeline!, version: "ver_new_cut" } }));
  expect([playhead(), boxTag(), offeredTime(), useUiStore.getState().agentContext]).toEqual([0, undefined, undefined, null]);
});

it("gives the message box the cursor on N, about the moment the playhead is on, and opens no second box to write in", async () => {
  idle();
  await show();
  // How many times the box has been asked to take the cursor. The box stands in here, so it never takes it.
  useUiStore.setState({ composerFocus: 0 });
  const cursor = () => useUiStore.getState().composerFocus;
  await act(async () => usePlayerStore.setState({ time: 5, playing: true }));
  const paused = vi.spyOn(player, "pause");
  expect([cursor(), boxTag()]).toEqual([0, undefined]);
  // N stops the video on the moment, tags the box with it before anything is typed, and puts the cursor there.
  await press("n");
  await act(async () => usePlayerStore.setState({ playing: false }));
  expect(paused).toHaveBeenCalled();
  expect([cursor(), pointTag()]).toEqual([1, ["At 0:05", true]]);
  expect(useUiStore.getState().notePopover).toBeNull();
  // A message already being written about a moment keeps it: N only brings the cursor back.
  await act(async () => useUiStore.getState().setAgentDraft("Zoom in here"));
  await act(async () => usePlayerStore.setState({ time: 12 }));
  await press("N");
  expect([cursor(), pointTag()]).toEqual([2, ["At 0:05", true]]);
  // Sent or cleared, the next N is about where the playhead is then.
  await act(async () => useUiStore.getState().setAgentDraft(""));
  await press("n");
  expect([cursor(), pointTag()]).toEqual([3, ["At 0:12", true]]);
  // With an edit open the box revises that edit, and N gives it the cursor as it is.
  appliedEdits();
  await act(async () => root.render(null));
  await show();
  await click(turnFor("chg_approved_2").querySelectorAll<HTMLElement>(".simple-edits .simple-edit")[1]!);
  await act(async () => {});
  await press("n");
  expect([cursor(), boxTag()]).toEqual([4, "Edit at 0:00"]);
  expect(useUiStore.getState().agentContext).toMatchObject({ changeId: "chg_approved_2", editIndex: 1 });
});

it("leaves a box aimed at an edit or at Scarlet's question as it is when a point is picked", async () => {
  // Scarlet has asked a question: the box answers it, and skipping through the video doesn't change that.
  await show();
  expect(boxTag()).toBe("Answer");
  await press("ArrowRight");
  expect([boxTag(), useUiStore.getState().agentContext, offeredTime()]).toEqual(["Answer", null, undefined]);
  // With an edit open the box revises that edit, wherever the playhead goes.
  appliedEdits();
  await show();
  await click(turnFor("chg_approved_2").querySelectorAll<HTMLElement>(".simple-edits .simple-edit")[1]!);
  await act(async () => {});
  expect(boxTag()).toBe("Edit at 0:00");
  await press("ArrowRight");
  expect([boxTag(), offeredTime()]).toEqual(["Edit at 0:00", undefined]);
  expect(useUiStore.getState().agentContext).toMatchObject({ changeId: "chg_approved_2", editIndex: 1 });
});

it("doesn't bring back a point picked in an earlier visit on an empty box, and keeps one with its message", async () => {
  idle();
  const owner = JSON.stringify([PRJ, null]);
  useUiStore.setState({ savedDrafts: { [owner]: { agentDraft: "", agentContext: { time: 7, clipIds: [] } } } });
  await show();
  expect([useUiStore.getState().agentContext, boxTag()]).toEqual([null, undefined]);
  await act(async () => root.unmount());
  root = createRoot(container);
  useUiStore.setState({ agentDraft: "", agentContext: null, draftOwner: null, savedDrafts: { [owner]: { agentDraft: "Cut this", agentContext: { time: 7, clipIds: [] } } } });
  await show();
  expect(boxTag()).toBe("At 0:07");
});

/** Words chosen in the transcript, as its "Ask about this" aims the message box at them. Nothing in the box names them. */
const chosenWords = () => ({ version: data.project.head!, time: 4.2, end: 6.8, clipIds: [], label: "“three things”" });

it("keeps explicitly chosen transcript words through timeline seeks before and while writing", async () => {
  idle();
  await show();
  await act(async () => useUiStore.getState().setAgentContext(chosenWords()));
  expect([pointTag(), aimLine()]).toEqual([[undefined, false], null]);
  await press("ArrowRight");
  expect(useUiStore.getState().agentContext).toEqual(chosenWords());
  expect(boxTag()).toBeUndefined();
  await act(async () => useUiStore.getState().setAgentDraft("Tighten this"));
  await press("ArrowRight");
  expect(boxNow()).toEqual(["Tighten this", chosenWords(), JSON.stringify([PRJ, null])]);
  await act(async () => useUiStore.getState().setAgentDraft(""));
  await press("n");
  expect(pointTag()).toEqual(["At 0:10", true]);
  await act(async () => composer.props!.onClearTarget!());
  expect(boxTag()).toBeUndefined();
});

/** Words chosen in the Transcript by a double click on one, then asked about. */
const askAboutWord = async (index: number) => {
  const word = container.querySelector<HTMLElement>(`.simple-transcript [data-w="${index}"]`)!;
  await act(async () => { word.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  await click(buttonIn(container.querySelector(".simple-transcript")!, "Ask about this")!);
};

it("aims words chosen in the transcript with a call open at that call when they're in its passage, and at a new edit when not", async () => {
  runningPass();
  idle();
  await show();
  await act(async () => {});
  // "N need you" opens the first call: Scarlet's cut from 2 s to 3 s.
  await click(container.querySelector('[aria-label="Dialogue pass"] .simple-pass-need')!);
  expect(call().querySelector(".edit-card-title")?.textContent).toBe("A clean retake.");
  expect(boxTag()).toBe("Cut 1");
  await openTranscript();
  // "I", from 2.3 s to 2.5 s, is inside the open call's cut. The message is about that call, and says where the editor
  // was looking. A message being written comes along.
  await act(async () => useUiStore.getState().setAgentDraft("Keep this word"));
  await askAboutWord(4);
  expect(boxTag()).toBe("Cut 1");
  expect(useUiStore.getState().agentContext).toMatchObject({ changeId: "chg_ready", cutIndex: 0, version: data.project.head, time: expect.closeTo(2.3, 1), end: expect.closeTo(2.5, 1), label: "“I”" });
  expect(useUiStore.getState().agentDraft).toBe("Keep this word");
  expect(aimLine()).toEqual(["Revising the cut at 0:02", true, undefined]);
  // "is", at 14.2 s, is in no cut: the words start a new edit, as they do with nothing open, and the message comes along.
  await askAboutWord(30);
  expect(boxTag()).toBeUndefined();
  expect(boxNow()).toEqual(["Keep this word", { version: data.project.head, time: expect.closeTo(14.2, 1), end: expect.closeTo(14.5, 1), clipIds: expect.any(Array), label: "“is”" }, JSON.stringify([PRJ, null])]);
  expect(aimLine()).toEqual(["Starting a new edit", false, "Move here"]);
  // So do words in another call's cut: "useful" is in the second call's, 6 s to 7 s.
  await askAboutWord(13);
  expect(boxTag()).toBeUndefined();
  expect(useUiStore.getState().agentContext).toMatchObject({ time: expect.closeTo(6, 1), end: expect.closeTo(6.5, 1), label: "“useful”" });
  expect(useUiStore.getState().agentContext).not.toHaveProperty("changeId");
  // The call is still open, and Move here brings the message back to it.
  expect(call().querySelector(".edit-card-title")?.textContent).toBe("A clean retake.");
  await click(buttonIn(container.querySelector(".simple-target")!, "Move here")!);
  expect(boxTag()).toBe("Cut 1");
  expect(useUiStore.getState().agentDraft).toBe("Keep this word");
});

it("keeps words chosen in the transcript with a call open on an empty box, for the message typed next", async () => {
  runningPass();
  idle();
  await show();
  await act(async () => {});
  await click(container.querySelector('[aria-label="Dialogue pass"] .simple-pass-need')!);
  expect(boxTag()).toBe("Cut 1");
  await openTranscript();
  // Words outside the call, with nothing typed: the box leaves the call for a new edit about those words, and keeps them
  // through the move, as an empty box with nothing open does.
  await askAboutWord(30);
  expect(boxTag()).toBeUndefined();
  expect(boxNow()).toEqual(["", { version: data.project.head, time: expect.closeTo(14.2, 1), end: expect.closeTo(14.5, 1), clipIds: expect.any(Array), label: "“is”" }, JSON.stringify([PRJ, null])]);
  await act(async () => {});
  await act(async () => useUiStore.getState().setAgentDraft("Cut this"));
  expect(boxNow()).toEqual(["Cut this", expect.objectContaining({ label: "“is”", time: expect.closeTo(14.2, 1) }), JSON.stringify([PRJ, null])]);
  // Words inside the call, with nothing typed: the box is that call's, about those words, never the whole pass.
  await act(async () => useUiStore.getState().setAgentDraft(""));
  await click(buttonIn(container.querySelector(".simple-target")!, "Move here")!);
  await askAboutWord(4);
  expect(boxTag()).toBe("Cut 1");
  expect(useUiStore.getState().agentContext).toMatchObject({ changeId: "chg_ready", cutIndex: 0, label: "“I”", time: expect.closeTo(2.3, 1) });
});

it("doesn't bring back words chosen in an earlier visit on an empty box, and keeps them with their message", async () => {
  idle();
  const owner = JSON.stringify([PRJ, null]);
  useUiStore.setState({ savedDrafts: { [owner]: { agentDraft: "", agentContext: chosenWords() } } });
  await show();
  expect(boxNow()).toEqual(["", null, owner]);
  await act(async () => root.unmount());
  root = createRoot(container);
  useUiStore.setState({ agentDraft: "", agentContext: null, draftOwner: null, savedDrafts: { [owner]: { agentDraft: "Tighten this", agentContext: chosenWords() } } });
  await show();
  expect(boxNow()).toEqual(["Tighten this", chosenWords(), owner]);
});

it("leaves the point's tag off the request in the queue and in the chat", async () => {
  const base = data.tasks.find(t => t.id === "task_done")!;
  const now = new Date().toISOString();
  const asked = (id: string, state: "queued" | "done", text: string, time: number) => ({ ...base, id, kind: "note" as const, state, createdAt: now,
    startedAt: state === "done" ? now : undefined, finishedAt: state === "done" ? now : undefined, hostId: null, summary: null, changeIds: [],
    instruction: text, context: { version: data.project.head!, time, clipIds: [], threadId: id, message: text } });
  data = { ...data, tasks: [...data.tasks, asked("task_point_done", "done", "Zoom in on the abstract.", 9), asked("task_point_queued", "queued", "Hold on the chart.", 12)] };
  useProjectStore.setState({ current: data });
  await show();
  const said = [...container.querySelectorAll<HTMLElement>(".simple-chat .unit-msg")].find(m => m.textContent?.includes("Zoom in on the abstract."));
  expect([said?.textContent?.includes("Zoom in on the abstract."), said?.querySelector(".simple-revising")]).toEqual([true, null]);
  const queued = [...container.querySelectorAll<HTMLElement>(".queue-row, .queue-head")].find(r => r.textContent?.includes("Hold on the chart."));
  expect([queued?.textContent?.includes("Hold on the chart."), queued?.querySelector(".queue-target")]).toEqual([true, null]);
});

it("tags a queued request about an edit at the edit's own time, before and after the request's list of edits arrives", async () => {
  earlierRequestOnly();
  const later = laterRequest();
  later.hold(later.earlier);
  // Sent while Scarlet was busy, about the third edit. The request's own time is where the passage around it starts.
  const base = buildDb().tasks.find(t => t.id === "task_done")!;
  data = { ...data, tasks: [...data.tasks, { ...base, id: "task_about_wrap", state: "queued" as const, startedAt: undefined, finishedAt: undefined, hostId: null, summary: null,
    changeIds: [], instruction: "Hold the last word.", createdAt: new Date().toISOString(),
    context: { threadId: later.earlier, changeId: "chg_approved_2", editIndex: 2, time: 10, end: 16, message: "Hold the last word." } }] };
  useProjectStore.setState({ current: data });
  await show();
  const tag = () => container.querySelector('[aria-label="Queued requests"] .queue-target')?.textContent;
  // Until the engine's list is in, the request's own saved list says where the edit is: the tag doesn't read
  // "Edit at 0:10", where the passage starts, and then change.
  expect(tag()).toBe("Edit at 0:11");
  // The list arrives with no task or change behind it. The tag reads as the edit's row does.
  await later.release();
  await act(async () => {});
  expect(tag()).toBe("Edit at 0:11");
});

/** A press with the mouse: unlike a key or `click()`, it carries a click count, and in WebView2 it leaves the button focused. */
const pointerClick = (element: HTMLElement) => act(async () => {
  element.focus();
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
});
/**
 * Space, pressed wherever the focus is, with the video paused: while it plays, Space pauses from anywhere. True when
 * the page took it, so the browser doesn't press a focused button with it.
 */
const spaceWhilePaused = async () => {
  await act(async () => usePlayerStore.setState({ playing: false }));
  const key = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
  await act(async () => { (document.activeElement ?? document.body).dispatchEvent(key); });
  return key.defaultPrevented;
};

it("gives Space back to the player after a decision is clicked, so it can't press Approve or Skip on the next call", async () => {
  const save = flagged();
  // Four calls, so three can be made with the card still up.
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, cutAssessments: [...c.cutAssessments!.map(a => ({ ...a, verdict: "ask" as const })),
    { index: 3, start: 700, end: 705, verdict: "ask" as const, reason: "A long pause." }] } : c) };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  await reviewCalls();
  // Approve stays on the card for the next call. Pressed with the keyboard it keeps the focus: Tab goes on from there.
  const approve = buttonIn(call(), "Approve")!;
  approve.focus();
  await act(async () => { approve.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 })); });
  expect(save).toHaveBeenCalledTimes(1);
  expect(buttonIn(call(), "Approve")).toBe(approve);
  expect(document.activeElement).toBe(approve);
  // Clicked, it lets go of the focus, so Space is the player's while the video is paused, where a focused button
  // would have been pressed again by it.
  await pointerClick(approve);
  expect(save).toHaveBeenCalledTimes(2);
  expect(document.activeElement).not.toBe(approve);
  expect(await spaceWhilePaused()).toBe(true);
  // Skip is the same.
  const skip = call().querySelector<HTMLButtonElement>('[aria-label="Skip"]')!;
  await pointerClick(skip);
  expect(save).toHaveBeenCalledTimes(3);
  expect(call().querySelector('[aria-label="Skip"]')).toBe(skip);
  expect(document.activeElement).not.toBe(skip);
  expect(await spaceWhilePaused()).toBe(true);
  // Space decided nothing: the last call still waits.
  expect(save).toHaveBeenCalledTimes(3);
  expect(passCard().querySelector(".simple-pass-need")?.textContent).toBe("1 needs you");
});

it("gives Space back to the player after Keep is clicked on an applied edit", async () => {
  appliedEdits();
  // Two edits ask for a look, so the card stays up, on the second, after the first is kept.
  data = { ...data, changes: data.changes.map(c => c.id === "chg_approved_2"
    ? { ...c, timelineEdits: c.timelineEdits!.map((e, i) => i === 1 ? { ...e, check: "The caption may run long" } : e) } : c) };
  useProjectStore.setState({ current: data });
  const listed = (await api.threadEdits(PRJ, threadWith("chg_approved_2").id)).edits;
  vi.spyOn(api, "threadEdits").mockImplementation(async (_project, threadId) => ({ version: data.project.head!,
    edits: threadId !== threadWith("chg_approved_2").id ? [] : listed.map((e, i) => i === 1 ? { ...e, check: "The caption may run long" } : e) }));
  await show();
  await click(turnFor("chg_approved_2").querySelector(".simple-pass-need")!);
  await act(async () => {});
  expect(openTitle()).toBe("captions");
  const keep = buttonIn(editPanel()!, "Keep")!;
  await pointerClick(keep);
  expect(openTitle()).toBe("wrap");
  expect(buttonIn(editPanel()!, "Keep")).toBe(keep);
  expect(document.activeElement).not.toBe(keep);
  expect(await spaceWhilePaused()).toBe(true);
  expect(openTitle()).toBe("wrap");
});

/** A browser hands focus back to whatever had it when a dialog opened. The test's page doesn't, so this does it. */
const dialogsGiveFocusBack = () => {
  const openers = new WeakMap<HTMLDialogElement, Element | null>();
  vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) {
    openers.set(this, document.activeElement);
    this.setAttribute("open", "");
  });
  vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    const opener = openers.get(this);
    if (opener instanceof HTMLElement && opener.isConnected && opener !== document.body) opener.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
  });
};

it("gives Space back to the player after a row of the menu is clicked, and after what the row opened is closed", async () => {
  dialogsGiveFocusBack();
  await show();
  const more = moreButton();
  // A row that changes the page in place: the menu closes and lets go of the focus, so Space is the player's, where
  // it would have pressed ⋯ and opened the menu again.
  await pointerClick(more);
  await pointerClick(menuItem("Transcript"));
  expect(container.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(document.body);
  expect(await spaceWhilePaused()).toBe(true);
  // A row that opens a drawer: closed again, the drawer hands focus back to what had it, which isn't ⋯ either.
  await pointerClick(more);
  await pointerClick(menuItem("History"));
  const drawer = document.querySelector<HTMLElement>("dialog[open]")!;
  expect(drawer.textContent).toContain("History");
  await pointerClick(drawer.querySelector<HTMLElement>('[aria-label="Close"]')!);
  expect(document.querySelector("dialog[open]")).toBeNull();
  expect(document.activeElement).toBe(document.body);
  expect(await spaceWhilePaused()).toBe(true);
  // Chosen with the keyboard, a row hands focus back to ⋯, and Tab goes on from there. Esc on the open menu does too.
  await click(more);
  await click(menuItem("Hide transcript"));
  expect(document.activeElement).toBe(more);
  await click(more);
  await press("Escape");
  expect(container.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(more);
});

it("keeps a pass's calls where they are, the made ones in their place, when Scarlet starts revising one of them inside it", async () => {
  flagged();
  // Three calls: one to make, one to send back, one left waiting.
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, intent: "suggestion" as const, taskId: "task_done",
    cutAssessments: c.cutAssessments!.map(a => ({ ...a, verdict: "ask" as const })),
    cutReasons: [0, 1, 2].map(i => ({ start: i, end: i + 1, reason: `Cut ${i + 1}.` })) } : c) };
  idle();
  await show();
  await act(async () => {});
  // Nothing runs, so the pass waiting on its calls holds the place above the message box.
  const pass = () => container.querySelector<HTMLElement>('[aria-label="Dialogue pass"]')!;
  const inPin = () => !!pass().closest(".simple-pin");
  expect(inPin()).toBe(true);
  await click(pass().querySelector(".simple-pass-need")!);
  await press("a");
  // A call is its number, amber while it waits, and a word once it's decided or sent back.
  const rows = () => [...pass().querySelectorAll(".simple-pass-list > li > button")].map(r => [r.querySelector(".edit-badge")?.textContent,
    r.querySelector(".edit-badge")?.classList.contains("is-check"), r.querySelector(".simple-pass-value")?.textContent]);
  expect(pass().querySelector(".simple-pass-list")?.getAttribute("aria-label")).toBe("Calls that need you");
  expect(rows()).toEqual([["1", false, "Approved"], ["2", true, undefined], ["3", true, undefined]]);
  // The editor sends the last call back. Scarlet starts on it inside the pass's block, under that call's row, so the
  // pass keeps the place above the box and no new block joins the conversation.
  const base = data.tasks.find(t => t.id === "task_done")!;
  const revision = { ...base, id: "task_revise", kind: "revise" as const, state: "running" as const, finishedAt: undefined, changeIds: [], expectedSeconds: undefined,
    instruction: "Start it later.", createdAt: new Date().toISOString(), startedAt: new Date().toISOString(),
    context: { threadId: threadWith("chg_ready").id, changeId: "chg_ready", cutIndex: 2, time: 598, end: 602.5, message: "Start it later." } };
  await event(d => ({ ...d, tasks: [...d.tasks, revision], changes: d.changes.map(c => c.id === "chg_ready" ? { ...c, state: "revising" as const } : c) }));
  expect(inPin()).toBe(true);
  expect(container.querySelector('.unit[data-run="task_revise"]')).toBeNull();
  const revising = container.querySelector<HTMLElement>('.simple-pin .subunit[data-run="task_revise"]')!;
  expect(revising.closest("li")?.querySelector(":scope > button .edit-badge")?.textContent).toBe("3");
  // The calls are as they were: the same ones, the decided one in its place.
  expect(pass().querySelector(".simple-pass-list")?.getAttribute("aria-label")).toBe("Calls that need you");
  expect(rows()).toEqual([["1", false, "Approved"], ["2", true, undefined], ["3", false, "Revising…"]]);
  expect(pass().querySelector(".simple-pass-need")?.textContent).toBe("1 needs you");
});

it("lists a pass staged again by its calls, with none of them open, after the pass before it was thrown away", async () => {
  flagged();
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, intent: "suggestion" as const, taskId: "task_done" } : c) };
  idle();
  await show();
  await act(async () => {});
  const pass = () => container.querySelector<HTMLElement>('[aria-label="Dialogue pass"]');
  await click(pass()!.querySelector(".simple-pass-need")!);
  expect(pass()!.querySelector(".simple-pass-list")).not.toBeNull();
  // The pass is thrown away: its line goes, and the list with it.
  const ready = data.changes.find(c => c.id === "chg_ready")!;
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_ready" ? { ...c, state: "rejected" as const, rejectedFrom: "ready" as const } : c) }));
  expect(pass()).toBeNull();
  // Staged again in the same request, the new pass lists its own calls, and none is open until the editor opens one.
  await event(d => ({ ...d, changes: [...d.changes, { ...ready, id: "chg_again", createdAt: new Date().toISOString() }],
    tasks: d.tasks.map(t => t.id === "task_done" ? { ...t, changeIds: [...t.changeIds, "chg_again"] } : t) }));
  await act(async () => {});
  expect(pass()!.querySelector(".simple-pass-need")?.textContent).toBe("2 need you");
  expect([pass()!.querySelector(".simple-pass-list")?.getAttribute("aria-label"), pass()!.querySelectorAll(".simple-pass-list > li").length,
    pass()!.querySelector('.simple-pass-list [aria-current="true"]')]).toEqual(["Calls that need you", 2, null]);
});

it("opens the edits so far and keeps the selected cut open when a running pass saves another part", async () => {
  // The pass has applied a part and is still at work. Scarlet is sure of every cut it staged since, so nothing is a call.
  const ready = { ...data.changes.find(c => c.id === "chg_ready")!, intent: "suggestion" as const, taskId: "task_done",
    cutAssessments: [{ index: 0, start: 0, end: 220, verdict: "cut" as const, reason: "A clean retake." }] };
  const part = { ...ready, id: "chg_part", fromVersion: "ver_2", toVersion: data.project.head!, intent: "requested" as const, state: "approved" as const, cutAssessments: undefined, cutReasons: [{ start: 4, end: 5, reason: "An um." }],
    createdAt: new Date(Date.parse(ready.createdAt!) - 60_000).toISOString() };
  data = { ...data, changes: data.changes.flatMap(c => c.id === "chg_ready" ? [part, ready] : [c]),
    tasks: data.tasks.map(t => t.id === "task_done" ? { ...t, state: "running" as const, finishedAt: undefined, summary: null,
      instruction: "/dialogue-pass", context: { message: "/dialogue-pass" }, changeIds: [part.id, ...t.changeIds] } : t) };
  const approve = vi.fn().mockResolvedValue({ outcome: "applied" });
  useProjectStore.setState({ current: data, approve });
  vi.spyOn(api, "cutReview").mockResolvedValue({ review: { cuts: [{ at: 0, removed: { start: 0, end: 1 }, beforeClip: 0 }], original: data.timeline!, proposed: data.timeline!, firstCut: false } });
  vi.spyOn(api, "timeline").mockImplementation(async (_, version = "head") => ({ timeline: { ...data.timeline!, version } }));
  const passThread = threadWith("chg_ready").id;
  vi.spyOn(api, "threadEdits").mockImplementation(async (_project, threadId) => ({ version: data.project.head!, edits: threadId === passThread
    ? data.changes.filter(c => c.taskId === "task_done" && c.state === "approved").flatMap(c => (c.cutReasons ?? []).map(({ start, end, reason }, spot) => ({
      changeId: c.id, spot, label: reason, at: start, range: { start, end }, beforeCut: { version: c.fromVersion, removed: { start, end } }, previous: [],
    }))) : [] }));
  await show();
  await act(async () => {});
  const pass = () => container.querySelector<HTMLElement>('[aria-label="Dialogue pass"]')!;
  const link = () => pass().querySelector<HTMLButtonElement>(".simple-pass-toggle")!;
  // No sentence sums the pass up yet, so the link alone says what it opens, and counts it.
  expect(pass().querySelector(".simple-made")).toBeNull();
  expect([link().textContent, link().title]).toEqual(["See 1 edit so far", "Show the edits Scarlet has made so far, in order"]);
  await click(link());
  await act(async () => {});
  expect([pass().querySelector(".simple-pass-list")?.getAttribute("aria-label"), pass().querySelectorAll(".simple-pass-list > li").length, link().textContent])
    .toEqual(["Every edit", 1, "Hide"]);
  await click(passRow("An um."));
  expect(editPanel()?.querySelector(".edit-card-title")?.textContent).toBe("An um.");

  const secondCut = { start: 8, end: 9, reason: "A false start." };
  const secondPart = { ...part, id: "chg_second_part", fromVersion: part.toVersion, toVersion: "ver_second_part",
    cutReasons: [secondCut], createdAt: new Date().toISOString() };
  await event(d => ({ ...d, project: { ...d.project, head: secondPart.toVersion },
    timeline: { ...applyOps(d.timeline!, [{ op: "rippleDelete", start: secondCut.start, end: secondCut.end }]), version: secondPart.toVersion, parent: secondPart.fromVersion },
    changes: [...d.changes, secondPart], tasks: d.tasks.map(t => t.id === "task_done" ? { ...t, changeIds: [...t.changeIds, secondPart.id] } : t) }));
  expect(passRows().map(row => [row.querySelector(".simple-pass-words")?.textContent, row.getAttribute("aria-current")]))
    .toEqual([["An um.", "true"], ["A false start.", null]]);
  expect(editPanel()?.querySelector(".edit-card-title")?.textContent).toBe("An um.");
  await click(link());
  expect(link().textContent).toBe("See 2 edits so far");
  expect(approve).not.toHaveBeenCalled();
  // Done: the sentence says what the pass made, and the link after it no longer says "so far".
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_done" ? { ...t, state: "done" as const, finishedAt: new Date().toISOString() } : t) }));
  expect(link().textContent).not.toMatch(/so far/);
});

it("wraps the line of a pass scheduled while Scarlet still works, so its link and its status never run over each other", async () => {
  flagged();
  // The pass has applied a part and is still at work. It asked about one cut, and the editor's call on it scheduled the
  // pass to apply when Scarlet finishes.
  const ready = { ...data.changes.find(c => c.id === "chg_ready")!, intent: "suggestion" as const, taskId: "task_done",
    cutReasons: [0, 1, 2].map(i => ({ start: i, end: i + 1, reason: ["A clean retake.", "Breath before the price.", "Repeated aside."][i]! })),
    cutAssessments: [{ index: 1, start: 230, end: 233, verdict: "ask" as const, reason: "Breath before the price." }],
    cutChoices: [{ index: 0, start: 0, end: 1, choice: "cut" as const }, { index: 1, start: 230, end: 233, choice: "cut" as const }],
    applyWhenDone: { userId: "usr_editor", at: new Date().toISOString() } };
  const part = { ...ready, id: "chg_part", intent: "requested" as const, state: "approved" as const, cutAssessments: undefined, cutChoices: undefined, applyWhenDone: undefined,
    cutReasons: [{ start: 4, end: 5, reason: "An um." }], createdAt: new Date(Date.parse(ready.createdAt!) - 60_000).toISOString() };
  data = { ...data, changes: data.changes.flatMap(c => c.id === "chg_ready" ? [part, ready] : [c]),
    tasks: data.tasks.map(t => t.id === "task_done" ? { ...t, state: "running" as const, finishedAt: undefined, summary: null, startedAt: new Date(Date.now() - 60_000).toISOString(),
      instruction: "/dialogue-pass", context: { message: "/dialogue-pass" }, changeIds: [part.id, ...t.changeIds] } : t) };
  useProjectStore.setState({ current: data });
  const passThread = threadWith("chg_ready").id;
  vi.spyOn(api, "threadEdits").mockImplementation(async (_project, threadId) => ({ version: data.project.head!, edits: threadId === passThread
    ? [{ changeId: "chg_part", spot: 0, label: "An um.", range: { start: 4, end: 5 }, previous: [] }] : [] }));
  await withSimpleSheet(async () => {
    await show();
    await act(async () => {});
    const line = container.querySelector<HTMLElement>('[aria-label="Dialogue pass"] .simple-pass-line')!;
    // "See 2 edits so far" and "Goes in when Scarlet finishes" can be wider than a chat at its 320px least, inside its
    // margins. What doesn't fit goes to the next line. The schedule is a status: there is no link to take it back.
    expect([...line.children].map(part => part.textContent)).toEqual(["See 2 edits so far", "Goes in when Scarlet finishes", ""]);
    expect(styled(line, "flex-wrap")).toEqual(["wrap"]);
  });
});

it("leaves another request's edit open when a pass with its full list open leaves the place above the message box", async () => {
  flagged();
  // The pass has applied the part it was sure of and still waits on its calls. Another request has edits of its own.
  const ready = { ...data.changes.find(c => c.id === "chg_ready")!, intent: "suggestion" as const, taskId: "task_done" };
  const part = { ...ready, id: "chg_part", intent: "requested" as const, state: "approved" as const, cutAssessments: undefined, cutReasons: [{ start: 4, end: 5, reason: "An um." }],
    createdAt: new Date(Date.parse(ready.createdAt!) - 60_000).toISOString() };
  data = { ...data, changes: data.changes.flatMap(c => c.id === "chg_ready" ? [part, ready] : [c]),
    tasks: data.tasks.map(t => t.id === "task_done" ? { ...t, instruction: "/dialogue-pass", context: { message: "/dialogue-pass" }, changeIds: [part.id, ...t.changeIds] } : t) };
  idle();
  const passThread = threadWith("chg_ready").id, other = threadWith("chg_approved_2").id;
  vi.spyOn(api, "threadEdits").mockImplementation(async (_project, threadId) => ({ version: data.project.head!, edits: threadId === passThread
    ? [{ changeId: "chg_part", spot: 0, label: "An um.", range: { start: 4, end: 5 }, previous: [] }]
    : threadId === other ? [{ changeId: "chg_approved_2", spot: 0, label: "music bed", range: { start: 0, end: 16 }, previous: [] }] : [] }));
  await show();
  await act(async () => {});
  const pass = () => container.querySelector<HTMLElement>('[aria-label="Dialogue pass"]')!;
  const list = () => pass().querySelector(".simple-pass-list")?.getAttribute("aria-label");
  expect(pass().closest(".simple-pin")).not.toBeNull();
  // The link is worded for the rows it opens: the applied cut and the pass's two calls, which are listed among its
  // edits. So it isn't "See it".
  expect(pass().querySelector(".simple-pass-toggle")?.textContent).toBe("See all");
  // Its full list is open, so its applied edit is on the timeline as a faint tick.
  await click(pass().querySelector(".simple-pass-toggle")!);
  await act(async () => {});
  expect(list()).toBe("Every edit");
  expect(pass().querySelectorAll(".simple-pass-list > li")).toHaveLength(3);
  expect(ticks()).toEqual(["tick"]);
  // The editor opens an edit of the other request, with the list still open.
  await click(buttonIn(turnFor("chg_approved_2"), "See edit")!);
  await act(async () => {});
  expect(openTitle()).toBe("music bed");
  // Scarlet starts on a call sent back earlier, and that request takes the place above the box. The pass's line is
  // mounted anew in the conversation with its list still open: the same list, so the open edit stays open.
  const base = data.tasks.find(t => t.id === "task_done")!;
  const revision = { ...base, id: "task_revise", kind: "revise" as const, state: "running" as const, finishedAt: undefined, changeIds: [], expectedSeconds: undefined,
    instruction: "Start it later.", createdAt: new Date().toISOString(), startedAt: new Date().toISOString(),
    context: { threadId: passThread, changeId: "chg_ready", cutIndex: 2, time: 598, end: 602.5, message: "Start it later." } };
  await event(d => ({ ...d, tasks: [...d.tasks, revision], changes: d.changes.map(c => c.id === "chg_ready" ? { ...c, state: "revising" as const } : c) }));
  await act(async () => {});
  expect(pass().closest(".simple-pin")).toBeNull();
  expect(list()).toBe("Every edit");
  expect(openTitle()).toBe("music bed");
  expect(editPanel()).not.toBeNull();
  // Closed, the timeline goes back to the pass's open list.
  await press("Escape");
  await act(async () => {});
  expect(editPanel()).toBeNull();
  expect(ticks()).toEqual(["tick"]);
});

it("says a stopped pass's cut wasn't checked, lists a skipped call as Skipped, and says why the pass couldn't apply", async () => {
  const save = flagged();
  const ready = data.changes.find(c => c.id === "chg_ready")!;
  const cutReasons = [0, 1, 2].map(i => ({ start: i * 2, end: i * 2 + 1, reason: ["A clean retake.", "Breath before the price.", "Repeated aside."][i]! }));
  vi.spyOn(api, "cutReview").mockResolvedValue({ review: { original: data.timeline!, proposed: data.timeline!, firstCut: false,
    cuts: cutReasons.map((r, at) => ({ at, removed: { start: r.start, end: r.end }, beforeClip: 0 })) } });
  // The pass stopped early: one cut it asks about, one the editor called, one staged and never checked.
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...ready, intent: "suggestion" as const, taskId: "task_done", cutReasons,
      cutAssessments: [{ index: 1, start: 230, end: 233, verdict: "ask" as const, reason: "Breath before the price." }],
      cutChoices: [{ index: 0, start: 0, end: 1, choice: "cut" as const }] } : c),
    tasks: data.tasks.map(t => t.id === "task_done" ? { ...t, state: "cancelled" as const } : t) };
  // What the engine answers when the video moved on under one of a pass's cuts: it refuses, and keeps the calls.
  const MOVED = "This pass wasn’t applied because the footage under Cut 1 changed since Scarlet made it: skip Cut 1 to apply the rest.";
  const approve = vi.fn().mockRejectedValueOnce(new Error(MOVED)).mockRejectedValueOnce(new Error("The engine stopped."))
    .mockResolvedValueOnce({ outcome: "conflict" }).mockResolvedValue({ outcome: "applied" });
  useProjectStore.setState({ current: data, approve });
  await show();
  await act(async () => {});
  const note = () => call().querySelector<HTMLElement>(".edit-card-title")!;
  // "2 need you" opens the first of them on the timeline: the cut Scarlet never got to. Its card says so before the note.
  await reviewCalls();
  expect(note().querySelector(".edit-card-unchecked")?.textContent).toBe("Not checked yet. ");
  expect(note().textContent).toBe("Not checked yet. Repeated aside.");
  expect(note().title).toBe("Repeated aside.");
  // S skips it, and the next call opens. Scarlet asked about this one, so it reads as its note alone.
  await press("s");
  expect(save).toHaveBeenLastCalledWith("chg_ready", expect.objectContaining({ choices: [{ index: 0, choice: "cut" }, { index: 2, choice: "keep" }], applyWhenDone: false }));
  expect(note().textContent).toBe("Breath before the price.");
  expect(note().querySelector(".edit-card-unchecked")).toBeNull();
  // Every call of the pass is listed, in timeline order, the one made before the pass stopped included. The skipped
  // call keeps its place, its number no longer amber, and says how it was decided. A call's number is its place among
  // all three of the pass's calls.
  expect(passCard().querySelector(".simple-pass-list")?.getAttribute("aria-label")).toBe("Calls that need you");
  expect(passRows().map(r => [r.querySelector(".edit-badge")?.textContent, r.querySelector(".edit-badge")?.classList.contains("is-check"),
    r.querySelector(".simple-pass-label")?.textContent, r.querySelector(".simple-pass-value")?.textContent]))
    .toEqual([["1", false, "A clean retake.", "Approved"], ["3", false, "Repeated aside.", "Skipped"], ["2", true, "Breath before the price.", undefined]]);
  expect(call().querySelector(".edit-card-count")?.textContent).toBe("Cut 2");
  expect(buttonIn(call(), "Approve")?.getAttribute("aria-pressed")).toBe("false");
  // The last call applies the pass, leaving in what was skipped. The working cut had moved on, so the engine refused
  // it: the card closes and the pass's line says why.
  const said = () => passCard().querySelector('.simple-error[role="alert"]')?.textContent;
  await press("s");
  await act(async () => {});
  expect(approve).toHaveBeenLastCalledWith("chg_ready", undefined, [1, 2]);
  expect(container.querySelector('[aria-label="Call"]')).toBeNull();
  expect(said()).toBe(MOVED);
  // Every call is made, so the pass would go in by itself, but an apply that failed isn't tried again unasked: the line
  // offers Retry. A failure there says the engine's reason, in place of the last one.
  expect(approve).toHaveBeenCalledTimes(1);
  expect(buttonIn(passCard(), "Apply")).toBeFalsy();
  await click(buttonIn(passCard(), "Retry")!);
  expect(said()).toBe("The engine stopped.");
  await click(buttonIn(passCard(), "Retry")!);
  expect(said()).toBe("The video changed while this was waiting. Scarlet is redoing it on the video as it is now.");
  // Once it applies, nothing is left to say.
  await click(buttonIn(passCard(), "Retry")!);
  expect(approve).toHaveBeenCalledTimes(4);
  expect(said()).toBeUndefined();
});

it("says under a request why Stop or Resume failed, until the same press works", async () => {
  const base = data.tasks.find(t => t.id === "task_done")!;
  const stopped = { ...base, id: "task_stopped", kind: "edit" as const, state: "cancelled" as const, instruction: "Tighten the outro.", summary: null, changeIds: [],
    context: { threadId: "task_stopped", message: "Tighten the outro." }, createdAt: new Date(Date.now() - 60_000).toISOString(), startedAt: new Date(Date.now() - 60_000).toISOString(),
    finishedAt: new Date(Date.now() - 50_000).toISOString() };
  data = { ...data, tasks: [...data.tasks, stopped] };
  const cancelTask = vi.fn().mockRejectedValueOnce(new Error("The engine isn’t answering.")).mockResolvedValue(undefined);
  const retryTask = vi.fn().mockRejectedValueOnce(new Error("That request is already running.")).mockResolvedValue(undefined);
  useProjectStore.setState({ current: data, cancelTask, retryTask });
  await show();
  await act(async () => {});
  // The line is the request's own: the last thing in its block, and nowhere else. The request Scarlet is on is fixed
  // above the message box, and the line is there with it, not left in the conversation under the request before it.
  const said = () => [...container.querySelectorAll<HTMLElement>('.simple-error[role="alert"]')].map(e => [e.closest<HTMLElement>(".unit")?.dataset.run, e.textContent]);
  expect(said()).toEqual([]);
  await click(stopOf("task_running"));
  expect(cancelTask).toHaveBeenCalledWith("task_running");
  expect(said()).toEqual([["task_running", "The engine isn’t answering."]]);
  const line = container.querySelector<HTMLElement>('.simple-error[role="alert"]')!;
  expect([!!line.closest(".simple-pin"), line.parentElement!.lastElementChild === line, !!container.querySelector(".simple-chat .simple-error")]).toEqual([true, true, false]);
  await click(stopOf("task_running"));
  expect(cancelTask).toHaveBeenCalledTimes(2);
  expect(said()).toEqual([]);
  const resume = () => buttonIn(units().find(u => u.dataset.run === "task_stopped")!, "Resume")!;
  await click(resume());
  // It runs on the model picked now.
  expect(retryTask).toHaveBeenCalledWith("task_stopped", { agent: "claude", model: "opus" });
  expect(said()).toEqual([["task_stopped", "That request is already running."]]);
  await click(resume());
  expect(said()).toEqual([]);
});

it("says on the edit's card why Undo edit couldn't be sent, and leaves the edit open", async () => {
  appliedEdits();
  const createTask = vi.fn().mockRejectedValueOnce(new Error("Scarlet can’t take requests right now.")).mockResolvedValue({ id: "task_undo" });
  useProjectStore.setState({ createTask });
  await show();
  await click(turnFor("chg_approved_2").querySelectorAll(".simple-edits .simple-edit")[1]!);
  await act(async () => {});
  // Undo edit is the small icon ahead of Revise. Once a reason is said it sits before the icon, so the icon is found by its name.
  const undo = () => openHead()!.querySelector<HTMLButtonElement>('.edit-card-acts > .edit-card-undo[aria-label="Undo edit"]')!;
  expect(undo()).toBe(undoIcon());
  await click(undo());
  expect(createTask).toHaveBeenCalledTimes(1);
  // Nothing was sent: the edit stays open with its decisions, the icon is ready again, and the reason sits beside it.
  expect(openTitle()).toBe("captions");
  expect(buttonIn(editPanel()!, "Keep")).not.toBeUndefined();
  expect(openHead()!.querySelector('.edit-card-acts .simple-error[role="alert"]')?.textContent).toBe("Scarlet can’t take requests right now.");
  expect([undo().disabled, undo().title]).toEqual([false, "Undo edit (U)"]);
  // The next press sends it, and the reason goes with the card.
  await click(undo());
  expect(createTask).toHaveBeenCalledTimes(2);
  expect(editPanel()).toBeNull();
  expect(container.querySelector(".simple-error")).toBeNull();
});

it("says in the banner why a queued request couldn't be taken out, until one is", async () => {
  const base = data.tasks.find(t => t.id === "task_done")!;
  const queued = { ...base, id: "task_waiting", kind: "edit" as const, state: "queued" as const, startedAt: undefined, finishedAt: undefined, hostId: null, summary: null, changeIds: [],
    instruction: "Add a lower third with my name.", createdAt: new Date(Date.now() + 1000).toISOString(), context: { threadId: "task_waiting", message: "Add a lower third with my name." } };
  data = { ...data, tasks: [...data.tasks, queued] };
  const cancelTask = vi.fn().mockRejectedValueOnce(new Error("Scarlet has already started on it.")).mockResolvedValue(undefined);
  useProjectStore.setState({ current: data, cancelTask });
  await show();
  const remove = () => [...container.querySelectorAll<HTMLElement>('[aria-label="Queued requests"] .queue-row')]
    .find(r => r.textContent?.includes("Add a lower third with my name."))!.querySelector<HTMLButtonElement>(".queue-remove")!;
  const banner = () => container.querySelector('.simple-banner[role="status"]')?.textContent;
  if (!container.querySelector('[aria-label="Queued requests"] .queue-list, [aria-label="Queued requests"] > .queue-row')) await click(container.querySelector(".queue-head")!);
  expect(banner()).toBeUndefined();
  await click(remove());
  expect(cancelTask).toHaveBeenCalledWith("task_waiting");
  // The request is still in the tray, and the banner under the header says why.
  expect(banner()).toBe("Scarlet has already started on it.");
  await click(remove());
  expect(cancelTask).toHaveBeenCalledTimes(2);
  expect(banner()).toBeUndefined();
});

/** What the app log says the editor did while `during` runs, without each line's clock: `[action] keep-edit …`. */
const loggedActions = async (during: () => Promise<void>) => {
  const lines: string[] = [];
  startAppLog(written => lines.push(...written));
  try { await during(); } finally { stopAppLog(); }
  return lines.filter(line => line.startsWith("[action] ")).map(line => line.replace(/ \d\d:\d\d:\d\d\.\d{3} \+\d+ms/, ""));
};

it("logs which edit a shortcut kept or stepped to, where the key alone says only that it was pressed", async () => {
  appliedEdits();
  await show();
  await click(turnFor("chg_approved_2").querySelectorAll(".simple-edits .simple-edit")[0]!);
  await act(async () => {});
  const lines = await loggedActions(async () => {
    await press("ArrowDown");
    await press("ArrowDown");
    // Past the last edit there is nowhere to step, and nothing to log.
    await press("ArrowDown");
    await press("k");
  });
  expect(lines).toEqual([
    "[action] step to=edit edit=2 of=3 change=chg_approved_2",
    "[action] step to=edit edit=3 of=3 change=chg_approved_2",
    "[action] keep-edit edit=3 of=3 change=chg_approved_2 flagged=true",
  ]);
});

it("logs which call a shortcut decided or stepped to, by its number and time, never by Scarlet's note or the footage's words", async () => {
  flagged();
  useProjectStore.setState({ current: data, approve: vi.fn().mockResolvedValue({ outcome: "applied" }) });
  await show();
  await act(async () => {});
  const lines = await loggedActions(async () => {
    await press("ArrowDown");
    await press("ArrowDown");
    await press("ArrowUp");
    await press("a");
    await press("s");
    await act(async () => {});
  });
  expect(lines).toEqual([
    "[action] step to=call call=1 of=2 change=chg_ready cut=1",
    "[action] step to=call call=2 of=2 change=chg_ready cut=2",
    "[action] step to=call call=1 of=2 change=chg_ready cut=1",
    "[action] approve-call change=chg_ready cut=1 at=230 left=1",
    "[action] skip-call change=chg_ready cut=2 at=598 left=0",
  ]);
  expect(lines.join("\n")).not.toMatch(/Breath|image-input/);
});

it("says the pass's cuts couldn't be loaded instead of applying without them, and asks for them again", async () => {
  flagged();
  // Both calls were made in an earlier session, so the pass goes in by itself once its cut list is in.
  data = { ...data, changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, cutChoices: [
    { index: 1, start: 230, end: 233, choice: "cut" as const }, { index: 2, start: 598, end: 602.5, choice: "keep" as const }] } : c) };
  const review = { cuts: [0, 1, 2].map(i => ({ at: i, removed: { start: i, end: i + 1 }, beforeClip: 0 })),
    original: data.timeline!, proposed: data.timeline!, firstCut: false };
  const cuts = vi.spyOn(api, "cutReview").mockRejectedValueOnce(new Error("The engine is restarting.")).mockResolvedValue({ review });
  const approve = vi.fn().mockResolvedValue({ outcome: "applied" });
  useProjectStore.setState({ current: data, approve });
  await show();
  await act(async () => {});
  await act(async () => {});
  // Without the list nothing would be put back, so the skipped cut would apply with the rest. It says why it didn't
  // apply, and asks for the list again, so Retry works.
  expect(approve).not.toHaveBeenCalled();
  expect(passCard().querySelector('[role="alert"]')?.textContent).toBe("Couldn’t load this pass’s cuts: The engine is restarting.");
  expect(cuts).toHaveBeenCalledTimes(2);
  await click(buttonIn(passCard(), "Retry")!);
  expect(approve).toHaveBeenCalledWith("chg_ready", undefined, [2]);
});

it("says under a suggestion's decisions why it couldn't be applied, and leaves it open to try again", async () => {
  vi.spyOn(api, "timeline").mockImplementation(async (_, version = "head") => ({ timeline: { ...data.timeline!, version } }));
  let fail!: (reason: Error) => void;
  const approve = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; })).mockResolvedValueOnce({ outcome: "conflict" })
    .mockResolvedValue({ outcome: "applied" });
  useProjectStore.setState({ approve });
  await show();
  await click(suggestion("chg_ready"));
  await act(async () => {});
  const decide = () => container.querySelector('[aria-label="Suggestion"]');
  const said = () => decide()?.querySelector('[role="alert"]')?.textContent;
  await click(buttonIn(decide()!, "Apply")!);
  // While it applies, the button says so and nothing can be pressed twice.
  const applying = buttonIn(decide()!, "Applying…")!;
  expect([applying.disabled, buttonIn(decide()!, "Revise")!.disabled]).toEqual([true, true]);
  await press("a");
  expect(approve).toHaveBeenCalledTimes(1);
  // Esc closes the card, but not while it applies: the card stays up until the apply lands.
  await press("Escape");
  expect(buttonIn(decide()!, "Applying…")).toBeDefined();
  await act(async () => fail(new Error("The engine stopped.")));
  expect(said()).toBe("The engine stopped.");
  expect(buttonIn(decide()!, "Apply")?.disabled).toBe(false);
  // The working cut moved on while it waited: Scarlet redoes it, and the strip says so in place of the last reason.
  await press("a");
  expect(said()).toBe("The video changed while this was waiting. Scarlet is redoing it on the video as it is now.");
  await click(buttonIn(decide()!, "Apply")!);
  expect(approve).toHaveBeenCalledTimes(3);
  expect(decide()).toBeNull();
});

/** Scarlet's line under a suggestion it is to make again: while the redo waits its turn, then once Scarlet is on it. */
const REDO_WAITS = "The video changed while this suggestion was waiting. I’ll redo it on the video as it is now.";
const REDOING = "The video changed while this suggestion was waiting. I’m redoing it on the video as it is now.";
/** The engine's own task for a suggestion it sent back, as `sendBack` makes it: authored by Scarlet, and about the suggestion alone. */
const redoTask = (changeId: string, over: Partial<ProjectData["tasks"][number]> = {}) => ({ ...data.tasks.find(t => t.id === "task_done")!, id: "task_redo", kind: "revise" as const,
  state: "queued" as const, createdBy: { type: "scarlet" as const, name: "Scarlet" }, changeIds: [], summary: null, question: null,
  instruction: "Redo this change on the current edit. It was approved, but the timeline changed while you worked and the edit no longer fits.",
  context: { changeId, threadId: threadWith(changeId).id, message: "Redo on the current edit" }, createdAt: new Date().toISOString(), startedAt: undefined, finishedAt: undefined, ...over });
/** What the engine answers when the video moved on under a suggestion: the suggestion is with Scarlet again, and the redo is asked for. */
const sendsBack = (changeId: string, redo: ProjectData["tasks"][number]) => vi.spyOn(api, "approveChange").mockImplementation(async () => ({ outcome: "sent_back",
  reason: "it overlaps with a change approved since (around 5.0 s)", task: redo, project: data.project,
  change: { ...useProjectStore.getState().current!.changes.find(c => c.id === changeId)!, state: "revising", revisionFrom: { state: "ready", taskId: redo.id },
    error: "Sent back: it overlaps with a change approved since (around 5.0 s)" } }) as never);
/** The queue's lines, each as what it says before the request's words, its tag and the words. */
const queueLines = () => [...container.querySelectorAll('[aria-label="Queued requests"] .queue-row, [aria-label="Queued requests"] .queue-head')]
  .map(row => [...row.querySelectorAll(".queue-next, .queue-target, .queue-text")].map(part => part.textContent));

it("says in a suggestion's request why the video moved on from it, queues the redo under the request's words, and runs it under the request's heading", async () => {
  vi.spyOn(api, "timeline").mockImplementation(async (_, version = "head") => ({ timeline: { ...data.timeline!, version } }));
  // Nothing else runs in this project, and the store's own apply does: only the engine's answer is staged. The video
  // changed while the suggestion waited, so the engine takes it back and asks for it again under a task of its own.
  data = { ...data, tasks: data.tasks.map(t => ["queued", "claimed", "running", "waiting_for_user"].includes(t.state) ? { ...t, state: "done" as const } : t),
    changes: data.changes.map(c => c.id === "chg_ready" ? { ...c, intent: "suggestion" as const } : c) };
  const ready = data.changes.find(c => c.id === "chg_ready")!;
  const approveChange = sendsBack("chg_ready", redoTask("chg_ready"));
  useProjectStore.setState({ current: data, refreshHead: vi.fn().mockResolvedValue(undefined) });
  await show();
  await click(suggestion("chg_ready"));
  await act(async () => {});
  await click(buttonIn(container.querySelector('[aria-label="Suggestion"]')!, "Apply")!);
  await act(async () => {});
  expect(approveChange).toHaveBeenCalledTimes(1);
  // The strip closes without a line of its own: the request it came from says why, as Scarlet's line. The request
  // isn't at work yet, so it has no Stop and no row that says it waits: the redo waits its turn in the tray.
  expect(container.querySelector('[aria-label="Suggestion"]')).toBeNull();
  const unit = () => container.querySelector<HTMLElement>('.simple-chat .unit[data-run="task_done"], .simple-pin .unit[data-run="task_done"]')!;
  const said = () => [...unit().querySelectorAll(".req-say")].map(p => p.textContent);
  expect(said().at(-1)).toBe(REDO_WAITS);
  expect([unit().querySelector(".unit-msg > p")?.textContent, unit().querySelector(".unit-stop"), unit().querySelector(".req-status")])
    .toEqual([requestTextFor("task_done"), null, null]);
  // In the tray it is the request's own words, tagged as its suggestion: not the engine's name for the task.
  expect(queueLines()).toEqual([["Next", "Suggestion", requestTextFor("task_done")]]);
  expect(units().filter(u => u.dataset.run === "task_redo")).toEqual([]);
  expect(container.querySelector(".simple-thread")!.textContent).not.toMatch(/Redo on the current edit|Sent back|The agent/);
  // Scarlet starts on it. It is the same request at work again, as on Retry: it leaves the tray for its own block,
  // which keeps its heading, carries Stop and holds the place above the message box.
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_redo" ? { ...t, state: "running" as const, startedAt: new Date().toISOString() } : t) }));
  expect(queueLines()).toEqual([]);
  expect(unit().closest(".simple-pin")).not.toBeNull();
  expect(units().filter(u => u.dataset.run === "task_redo")).toEqual([]);
  expect([unit().querySelector(".unit-msg > p")?.textContent, unit().querySelector(".unit-stop")?.textContent]).toEqual([requestTextFor("task_done"), "Stop"]);
  expect(said().at(-1)).toBe(REDOING);
  // The suggestion comes back made again: the line gives way to it, and it plays from the same block.
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_redo" ? { ...t, state: "done" as const, finishedAt: new Date().toISOString(), changeIds: ["chg_redone"],
      summary: "Trimmed the pause where it sits now." } : t),
    changes: [...d.changes, { ...ready, id: "chg_redone", taskId: "task_redo", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] }));
  expect(unit().closest(".simple-chat")).not.toBeNull();
  expect(unit().querySelector(".unit-state")?.textContent).toBe("Suggestion");
  expect(unit().querySelector(".simple-suggest")?.textContent).toBe("Trimmed the pause where it sits now.");
  expect(unit().textContent).not.toMatch(/The video changed|Redo on the current edit|Sent back/);
  // Nothing opened by itself along the way.
  expect(container.querySelector('[aria-label="Suggestion"]')).toBeNull();
});

/**
 * A finished pass waiting on its calls that left a suggestion besides them, with nothing else running in the project.
 * The store's own apply runs: a test stages only what the engine answers.
 */
const passLeftSuggestionAlone = () => {
  finishedPass();
  const pass = data.changes.find(c => c.id === "chg_ready")!;
  const reframe = { ...pass, id: "chg_reframe", description: "Show the host camera full-frame for the intro.", cutReasons: undefined, cutAssessments: undefined,
    ops: [{ op: "updateClip", clipId: "clip_a", patch: { transform: { x: 0, y: 0, scale: 1 } } }], toVersion: "ver_reframe", ranges: [{ start: 0, end: 1 }],
    createdAt: new Date(Date.now() + 1000).toISOString() };
  data = { ...data, changes: [...data.changes, reframe],
    tasks: data.tasks.map(t => t.id !== "task_done" ? ["queued", "claimed", "running", "waiting_for_user"].includes(t.state) ? { ...t, state: "done" as const } : t
      : { ...t, instruction: "/dialogue-pass", context: { ...t.context, message: "/dialogue-pass" }, changeIds: [...t.changeIds, reframe.id] }) };
  useProjectStore.setState({ current: data, refreshHead: vi.fn().mockResolvedValue(undefined) });
  vi.spyOn(api, "timeline").mockImplementation(async (_, version = "head") => ({ timeline: { ...data.timeline!, version } }));
  return reframe;
};

it("redoes a suggestion a pass left under the pass's own request, as any request's work and not as a pass", async () => {
  const reframe = passLeftSuggestionAlone();
  const redo = { ...data.tasks.find(t => t.id === "task_done")!, id: "task_redo", kind: "revise" as const, state: "running" as const, createdBy: { type: "scarlet" as const, name: "Scarlet" },
    changeIds: [], summary: null, instruction: "Redo this change on the current edit.", context: { changeId: reframe.id, threadId: threadWith("chg_ready").id, message: "Redo on the current edit" },
    createdAt: new Date(Date.now() + 2000).toISOString(), startedAt: new Date(Date.now() + 2000).toISOString(), finishedAt: undefined };
  vi.spyOn(api, "approveChange").mockResolvedValue({ outcome: "sent_back", reason: "clip clip_a no longer exists in the current version", task: redo, project: data.project,
    change: { ...reframe, state: "revising", revisionFrom: { state: "ready", taskId: redo.id }, error: "Sent back: clip clip_a no longer exists in the current version" } } as never);
  await show();
  await act(async () => {});
  const unit = () => container.querySelector<HTMLElement>(".simple-pin .unit")!;
  await click(unit().querySelector(".simple-suggest")!);
  await act(async () => {});
  await click(buttonIn(container.querySelector('[aria-label="Suggestion"]')!, "Apply")!);
  await act(async () => {});
  // The pass's request is at work again, with Stop after what still needs the editor. It lists no stages of a pass:
  // the redo reads no dialogue. Its calls stay where they were.
  expect([unit().dataset.run, unit().querySelector(".unit-stop")?.textContent]).toEqual(["task_done", "Stop"]);
  expect(units().filter(u => u.dataset.run === "task_redo")).toEqual([]);
  expect(unit().querySelector('.req-stages[aria-label="Stages"]')).toBeNull();
  expect([...unit().querySelectorAll(".req-say")].map(p => p.textContent)).toEqual(["The video changed while this suggestion was waiting. I’m redoing it on the video as it is now."]);
  expect(unit().querySelector(".simple-pass-need")?.textContent).toBe("3 need you");
  expect(container.querySelector(".simple-thread")!.textContent).not.toMatch(/Redo on the current edit|Sent back/);
});

it("plays a suggestion a pass left before it saved its calls, as it does one left after them", async () => {
  finishedPass();
  // The pass proposed a reframing of its own, then saved the part that staged its three calls.
  const pass = data.changes.find(c => c.id === "chg_ready")!;
  const reframe = { ...pass, id: "chg_reframe", description: "Show the host camera full-frame for the intro.", cutReasons: undefined, cutAssessments: undefined,
    ops: [{ op: "updateClip", clipId: "clip_a", patch: { transform: { x: 0, y: 0, scale: 1 } } }], toVersion: "ver_reframe", ranges: [{ start: 0, end: 1 }],
    createdAt: new Date(Date.parse(pass.createdAt!) - 60_000).toISOString() };
  data = { ...data, changes: [...data.changes, reframe],
    tasks: data.tasks.map(t => t.id !== "task_done" ? ["queued", "claimed", "running", "waiting_for_user"].includes(t.state) ? { ...t, state: "done" as const } : t
      : { ...t, instruction: "/dialogue-pass", context: { ...t.context, message: "/dialogue-pass" }, changeIds: [reframe.id, ...t.changeIds] }) };
  useProjectStore.setState({ current: data, refreshHead: vi.fn().mockResolvedValue(undefined) });
  vi.spyOn(api, "timeline").mockImplementation(async (_, version = "head") => ({ timeline: { ...data.timeline!, version } }));
  await show();
  await act(async () => {});
  const unit = () => container.querySelector<HTMLElement>(".simple-pin .unit")!;
  // Its calls wait. The suggestion is in the pass's block with its play mark, and its heading says one waits to be
  // played (2026-11-10: it read as plain words until the pass was applied).
  expect(unit().querySelector(".simple-pass-need")?.textContent).toBe("3 need you");
  expect([unit().querySelector(".unit-state")?.textContent, unit().querySelector(".simple-suggest")?.textContent])
    .toEqual(["Suggestion", "Show the host camera full-frame for the intro."]);
  // The line plays it, and the calls stay where they were.
  await click(unit().querySelector(".simple-suggest")!);
  expect(container.querySelector('.edit-card[aria-label="Suggestion"] .edit-card-title')?.textContent).toBe("Show the host camera full-frame for the intro.");
  expect(unit().querySelector(".simple-pass-need")?.textContent).toBe("3 need you");
  await press("Escape");
  // The editor sends the first call back, and Scarlet makes the pass again with that cut revised, under the revision's
  // own request. The suggestion is still the pass's, and still plays.
  await event(d => ({ ...d, tasks: [...d.tasks, callRequest("task_revise", 0, { kind: "revise" as const, state: "running" as const, startedAt: new Date().toISOString() })] }));
  await revisedCut("task_revise", "chg_ready", 0, { start: 2.2, end: 3 }, "A cleaner retake, from its first word.");
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_revise" ? { ...t, state: "done" as const, finishedAt: new Date().toISOString() } : t) }));
  expect(container.querySelector('.edit-card[aria-label="Suggestion"]')).toBeNull();
  expect([unit().querySelector(".unit-state")?.textContent, unit().querySelector(".simple-suggest")?.textContent])
    .toEqual(["Suggestion", "Show the host camera full-frame for the intro."]);
  await click(unit().querySelector(".simple-suggest")!);
  expect(container.querySelector('.edit-card[aria-label="Suggestion"] .edit-card-title')?.textContent).toBe("Show the host camera full-frame for the intro.");
});

it("keeps a request about one edit under that edit's row while Scarlet makes its suggestion again, with the line that says why", async () => {
  appliedEdits();
  idle();
  vi.spyOn(api, "timeline").mockImplementation(async (_, version = "head") => ({ timeline: { ...data.timeline!, version } }));
  const base = data.tasks.find(t => t.id === "task_done")!;
  data = { ...data, tasks: [...data.tasks, { ...base, id: "task_made", kind: "edit" as const, instruction: "Tighten the wrap, add music and captions.",
    context: { message: "Tighten the wrap, add music and captions." }, changeIds: ["chg_approved_2"] }] };
  const thread = threadWith("chg_approved_2");
  const now = new Date().toISOString();
  // A revision of one of the request's edits ended with a suggestion to play, so it stayed under that edit's row.
  const bigger = { ...data.changes.find(c => c.id === "chg_ready")!, id: "chg_bigger", taskId: "task_fix", threadId: thread.id, intent: "suggestion" as const, noteIds: [],
    description: "Captions at 120% from 0:00 to 0:02", createdAt: now, updatedAt: now };
  const revision = { ...base, id: "task_fix", kind: "edit" as const, state: "done" as const, summary: "Captions at 120% from 0:00 to 0:02.", changeIds: ["chg_bigger"],
    instruction: "Make the captions bigger.", createdAt: now, startedAt: now, finishedAt: now,
    context: { threadId: thread.id, changeId: "chg_approved_2", editIndex: 1, time: 0.2, end: 2.4, message: "Make the captions bigger." } };
  data = { ...data, tasks: [...data.tasks, revision], changes: [...data.changes, bigger] };
  sendsBack("chg_bigger", redoTask("chg_bigger"));
  useProjectStore.setState({ current: data, refreshHead: vi.fn().mockResolvedValue(undefined) });
  await show();
  await act(async () => {});
  const sub = () => container.querySelector<HTMLElement>('.subunit[data-run="task_fix"]');
  const row = () => sub()!.previousElementSibling?.querySelector(".simple-edit-title")?.textContent;
  const said = () => [...sub()!.querySelectorAll(".req-say, .said")].map(p => p.textContent);
  expect([row(), sub()!.querySelector(".unit-state")?.textContent]).toEqual(["captions", "Suggestion"]);
  // The suggestion is one line, the one that plays it: no second row names it and opens the edit above instead.
  expect(sub()!.querySelector(".req-result")).toBeNull();
  await click(sub()!.querySelector(".simple-suggest")!);
  await act(async () => {});
  await click(buttonIn(container.querySelector('[aria-label="Suggestion"]')!, "Apply")!);
  await act(async () => {});
  // The video had moved on, so the suggestion is with Scarlet again. Its request stays where it was, under its edit's
  // row, and says why. The redo waits its turn in the tray under the request's own words.
  expect([row(), sub()!.querySelector(".unit-stop")]).toEqual(["captions", null]);
  expect(said().at(-1)).toBe(REDO_WAITS);
  expect(queueLines()).toEqual([["Next", "Suggestion", "Make the captions bigger."]]);
  // Scarlet starts on it: the request is at work again in the same place, with Stop, and the line still says why.
  // The redo names no edit of its own, and takes no block for itself.
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_redo" ? { ...t, state: "running" as const, startedAt: new Date().toISOString() } : t) }));
  expect([row(), sub()!.querySelector(".subunit-msg")!.lastElementChild?.textContent]).toEqual(["captions", "Stop"]);
  expect(said().at(-1)).toBe(REDOING);
  expect(container.querySelector('.unit[data-run="task_fix"], [data-run="task_redo"]')).toBeNull();
  expect(queueLines()).toEqual([]);
  // The suggestion comes back made again, to play from the same row.
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_redo" ? { ...t, state: "done" as const, finishedAt: new Date().toISOString(), changeIds: ["chg_bigger_2"],
      summary: "Captions at 120%, where they sit now." } : t),
    changes: [...d.changes, { ...bigger, id: "chg_bigger_2", taskId: "task_redo", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] }));
  expect([row(), sub()!.querySelector(".unit-state")?.textContent, sub()!.querySelector(".simple-suggest")?.textContent]).toEqual(["captions", "Suggestion", "Captions at 120%, where they sit now."]);
  expect(sub()!.textContent).not.toMatch(/The video changed/);
  // Applied, what it did is on its edit: the request leaves the chat, as any request about one edit does.
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_bigger_2" ? { ...c, state: "approved" as const, appliedVersion: c.toVersion } : c) }));
  expect(container.querySelector('[data-run="task_fix"]')).toBeNull();
});

it("keeps a redo the engine holds in the tray, which says what it waits for, and lists the request queued behind it after it", async () => {
  finishedPass();
  vi.spyOn(api, "timeline").mockImplementation(async (_, version = "head") => ({ timeline: { ...data.timeline!, version } }));
  // An earlier request left a suggestion. Since then a dialogue pass has run, and waits on the editor's calls.
  const base = data.tasks.find(t => t.id === "task_done")!, long = new Date(Date.now() - 3_600_000).toISOString();
  const zoom = { ...base, id: "task_zoom", kind: "edit" as const, state: "done" as const, instruction: "Zoom in on the demo.", summary: "Zoom to 130% from 0:05 to 0:09.", changeIds: ["chg_zoom"],
    context: { threadId: "task_zoom", message: "Zoom in on the demo." }, createdAt: long, startedAt: long, finishedAt: long };
  const zoomed = { ...data.changes.find(c => c.id === "chg_ready")!, id: "chg_zoom", taskId: "task_zoom", threadId: "task_zoom", intent: "suggestion" as const, noteIds: [],
    cutReasons: undefined, cutAssessments: undefined, description: "Zoom to 130% from 0:05 to 0:09", toVersion: "ver_zoom", createdAt: long, updatedAt: long };
  data = { ...data, changes: [...data.changes, zoomed],
    tasks: [...data.tasks.map(t => t.id !== "task_done" && ["queued", "claimed", "running", "waiting_for_user"].includes(t.state) ? { ...t, state: "done" as const } : t), zoom] };
  sendsBack("chg_zoom", redoTask("chg_zoom"));
  useProjectStore.setState({ current: data, refreshHead: vi.fn().mockResolvedValue(undefined) });
  await show();
  await act(async () => {});
  const unit = () => container.querySelector<HTMLElement>('.unit[data-run="task_zoom"]')!;
  await click(unit().querySelector(".simple-suggest")!);
  await act(async () => {});
  await click(buttonIn(container.querySelector('[aria-label="Suggestion"]')!, "Apply")!);
  await act(async () => {});
  // The engine holds the redo until the pass's calls are made. The tray says so on its line, where Next would be, and
  // the request's block doesn't say it is being redone, or that it waits to start: Scarlet isn't on it.
  const tray = () => container.querySelector<HTMLElement>('[aria-label="Queued requests"]')!;
  expect(queueLines()).toEqual([["Waits for your calls", "Suggestion", "Zoom in on the demo."]]);
  expect(tray().querySelector(".queue-next")?.classList.contains("is-waiting")).toBe(true);
  expect([...unit().querySelectorAll(".req-say")].map(p => p.textContent).at(-1)).toBe(REDO_WAITS);
  expect([unit().querySelector(".unit-stop"), unit().querySelector(".req-status")]).toEqual([null, null]);
  // A request sent now runs after it: the tray lists them in running order, and the redo is the one marked Next.
  await event(d => ({ ...d, tasks: [...d.tasks, { ...base, id: "task_after", kind: "edit" as const, state: "queued" as const, instruction: "Add a lower third with my name.", summary: null,
    changeIds: [], context: { threadId: "task_after", message: "Add a lower third with my name." }, createdAt: new Date(Date.now() + 1000).toISOString(), startedAt: undefined, finishedAt: undefined }] }));
  expect(tray().querySelector(".queue-head")?.textContent).toBe("Waits for your callsSuggestionZoom in on the demo.2 queued");
  await click(tray().querySelector(".queue-head")!);
  expect([...tray().querySelectorAll(".queue-row")].map(r => r.textContent)).toEqual(["NextSuggestionZoom in on the demo.", "Add a lower third with my name."]);
});

it("lets the tag and the words on the tray's line give way together, so beside what the request waits for the words keep a share and the controls stay in", async () => {
  // "Waits for your answer" (about 126px), "Cut at 1:02:07" (91px), "3 queued" (55px), the chevron and the gaps take about
  // 326px, nearly all of the 335px a tray has at the chat's usual 380px, and more than its 275px at the 320px least.
  const items = [{ id: "a", text: "Make it shorter, and keep the laugh.", target: "Cut at 1:02:07" }, { id: "b", text: "Add a lower third." }, { id: "c", text: "Fade the outro." }];
  await withSimpleSheet(async () => {
    for (const queued of [items, items.slice(0, 1)]) {
      await act(async () => root.render(<QueueTray items={queued} waits="Waits for your answer" onRemove={() => {}} onReword={() => {}} />));
      const line = container.querySelector<HTMLElement>(".queue-head, .queue-row")!;
      // The tag and the words share what is left, each cut short with an ellipsis. What the request waits for and the
      // line's controls keep their size, so the line never runs out of the tray.
      expect([...line.children].map(part => [part.classList[0], ...styled(part, "flex-grow", "flex-shrink", "flex-basis", "min-width", "text-overflow")])).toEqual([
        ["queue-next", "0", "0", "auto", "", ""],
        ["queue-target", "0", "1", "auto", "0", "ellipsis"],
        ["queue-text", "1", "1", "6em", "0", "ellipsis"],
        ...queued.length > 1 ? [["queue-count", "0", "0", "auto", "", ""], ["queue-chevron", "0", "0", "auto", "", ""]]
          : [["queue-reword", "0", "0", "auto", "", ""], ["queue-remove", "0", "0", "auto", "", ""]],
      ]);
    }
  });
});

it("says a suggestion no request made is being made again in Scarlet's words, queues it under its own, and gives its work no heading", async () => {
  vi.spyOn(api, "timeline").mockImplementation(async (_, version = "head") => ({ timeline: { ...data.timeline!, version } }));
  // No task lists this suggestion: nothing the editor asked for made it, so no request's heading can carry its redo.
  data = { ...data, tasks: data.tasks.map(t => ["queued", "claimed", "running", "waiting_for_user"].includes(t.state) ? { ...t, state: "done" as const, question: null } : t),
    changes: data.changes.map(c => c.id === "chg_fillers" ? { ...c, intent: "suggestion" as const } : c) };
  expect(data.tasks.some(t => t.changeIds.includes("chg_fillers"))).toBe(false);
  sendsBack("chg_fillers", redoTask("chg_fillers"));
  useProjectStore.setState({ current: data, refreshHead: vi.fn().mockResolvedValue(undefined) });
  await show();
  const blocks = () => units().map(u => u.dataset.run);
  const before = blocks();
  const turn = () => turnFor("chg_fillers");
  await click(suggestion("chg_fillers"));
  await act(async () => {});
  await click(buttonIn(container.querySelector('[aria-label="Suggestion"]')!, "Apply")!);
  await act(async () => {});
  // The chat says it at once, as Scarlet's line under the suggestion, and the tray lists the redo under the
  // suggestion's own words: nothing here is the engine's name for the task.
  expect([...turn().querySelectorAll(".said")].map(p => p.textContent)).toEqual(["Cut 6 filler words (um, uh, you know).", REDO_WAITS]);
  expect(queueLines()).toEqual([["Next", "Suggestion", "Cut 6 filler words (um, uh, you know)"]]);
  expect(container.querySelector(".simple-thread")!.textContent).not.toMatch(/Redo on the current edit|Sent back|The agent/);
  // Scarlet starts on it. Its work has no heading, since no request is behind it, and every request keeps its block.
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_redo" ? { ...t, state: "running" as const, startedAt: new Date().toISOString() } : t) }));
  const work = container.querySelector<HTMLElement>('.simple-pin .unit[data-run="task_redo"]')!;
  expect([work.querySelector(".unit-msg"), work.querySelector(".run-stop")?.textContent]).toEqual([null, "Stop"]);
  expect(blocks().filter(run => run !== "task_redo")).toEqual(before);
  expect([...turn().querySelectorAll(".said")].map(p => p.textContent).at(-1)).toBe(REDOING);
  expect(container.querySelector(".simple-thread")!.textContent).not.toMatch(/Redo on the current edit|Sent back|The agent/);
});

it("closes only the suggestion it applied when the apply lands: a call opened meanwhile is left as it was, open and not paused", async () => {
  finishedPass();
  // The pass left a suggestion besides its calls, and nothing else runs in the project.
  const pass = data.changes.find(c => c.id === "chg_ready")!;
  const reframe = { ...pass, id: "chg_reframe", description: "Show the host camera full-frame for the intro.", cutReasons: undefined, cutAssessments: undefined,
    ops: [{ op: "updateClip", clipId: "clip_a", patch: { transform: { x: 0, y: 0, scale: 1 } } }], toVersion: "ver_reframe", ranges: [{ start: 0, end: 1 }],
    createdAt: new Date(Date.now() + 1000).toISOString() };
  data = { ...data, changes: [...data.changes, reframe],
    tasks: data.tasks.map(t => t.id !== "task_done" ? ["queued", "claimed", "running", "waiting_for_user"].includes(t.state) ? { ...t, state: "done" as const } : t
      : { ...t, instruction: "/dialogue-pass", context: { ...t.context, message: "/dialogue-pass" }, changeIds: [...t.changeIds, reframe.id] }) };
  // The store's own apply: it marks the suggestion applied at the press, and the engine answers later.
  let land!: (answer: unknown) => void;
  vi.spyOn(api, "approveChange").mockImplementation(() => new Promise(resolve => { land = resolve; }) as never);
  useProjectStore.setState({ current: data, refreshHead: vi.fn().mockResolvedValue(undefined) });
  vi.spyOn(api, "timeline").mockImplementation(async (_, version = "head") => ({ timeline: { ...data.timeline!, version } }));
  await show();
  await act(async () => {});
  await click(container.querySelector(".simple-pin .unit .simple-suggest")!);
  await act(async () => {});
  await click(buttonIn(container.querySelector('[aria-label="Suggestion"]')!, "Apply")!);
  expect(container.querySelector('[aria-label="Suggestion"]')).toBeNull();
  // While the engine works, ↓ opens the pass's first call. It can't be decided until the apply has landed.
  await press("ArrowDown");
  expect(call().textContent).toContain("A clean retake.");
  expect(buttonIn(call(), "Approve")!.disabled).toBe(true);
  const pause = vi.spyOn(player, "pause");
  await act(async () => land({ change: { ...reframe, state: "approved" }, project: data.project, outcome: "applied" }));
  expect(call().textContent).toContain("A clean retake.");
  expect(buttonIn(call(), "Approve")!.disabled).toBe(false);
  expect(pause).not.toHaveBeenCalled();
});

it("leaves a clip the editor started from Media playing when a suggestion's apply lands", async () => {
  vi.spyOn(api, "timeline").mockImplementation(async (_, version = "head") => ({ timeline: { ...data.timeline!, version } }));
  // The store marks the suggestion applied at the press, and the engine answers later.
  let land!: (answer: unknown) => void;
  vi.spyOn(api, "approveChange").mockImplementation(() => new Promise(resolve => { land = resolve; }) as never);
  useProjectStore.setState({ refreshHead: vi.fn().mockResolvedValue(undefined) });
  await show();
  await click(suggestion("chg_ready"));
  await act(async () => {});
  await click(buttonIn(container.querySelector('[aria-label="Suggestion"]')!, "Apply")!);
  expect(container.querySelector('[aria-label="Suggestion"]')).toBeNull();
  // While the engine works, the editor plays a clip from Media. Nothing they review is on screen then.
  await openMenu();
  await click(menuRow("Media"));
  await act(async () => { await vi.dynamicImportSettled(); });
  await click(await vi.waitFor(() => { const b = container.querySelector<HTMLButtonElement>('button[aria-label^="Preview source"]'); if (!b) throw new Error("no Media row yet"); return b; }));
  expect(container.querySelector('[aria-label="Source preview"]')).not.toBeNull();
  const pause = vi.spyOn(player, "pause");
  await act(async () => land({ change: { ...data.changes.find(c => c.id === "chg_ready")!, state: "approved" }, project: data.project, outcome: "applied" }));
  // The clip isn't the change that was applied: the landing leaves it up and doesn't pause it.
  expect(container.querySelector('[aria-label="Source preview"]')).not.toBeNull();
  expect(pause).not.toHaveBeenCalled();
});

it("heads each request with a band that says where it stands: Stop at work, a dot and Stop for a question, a word once it stopped or left a suggestion", async () => {
  await show();
  const state = (id: string) => container.querySelector<HTMLElement>(`.unit[data-run="${id}"] > .unit-msg > .unit-state`)!;
  // At work: Stop, and no ring or word before it. Asking: a dot, which isn't read out, then Stop.
  expect([state("task_running").innerHTML, state("task_running").nextElementSibling?.textContent]).toEqual(["", "Stop"]);
  expect([state("task_waiting").querySelector(".unit-dot")?.getAttribute("aria-hidden"), state("task_waiting").textContent, state("task_waiting").nextElementSibling?.textContent]).toEqual(["true", "", "Stop"]);
  // A question is that dot, the question and Answer: no row under the heading says "Needs your answer" over it.
  const asking = container.querySelector<HTMLElement>('.unit[data-run="task_waiting"] .req')!;
  expect(asking.querySelector(".req-status")).toBeNull();
  expect([...asking.querySelectorAll(".req-say")].map(p => p.textContent)).toEqual([`${data.tasks.find(t => t.id === "task_waiting")!.question}Answer`]);
  // A suggestion waiting to be played says so, and its line under the band plays it.
  expect(state("task_done").textContent).toBe("Suggestion");
  expect(container.querySelector('.unit[data-run="task_done"] .simple-suggest')).not.toBeNull();
  // Stopped early: the band says so, and the one action is under what the run left, not beside a second "Stopped".
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_running" ? { ...t, state: "cancelled" as const, finishedAt: new Date().toISOString() } : t) }));
  const stopped = container.querySelector<HTMLElement>('.unit[data-run="task_running"]')!;
  expect(state("task_running").textContent).toBe("Stopped");
  expect(stopped.querySelector(".req-state, .unit-stop")).toBeNull();
  expect(stopped.querySelector(".req")!.getAttribute("data-state")).toBe("stopped");
  // A finished request that left nothing to play has nothing there: no tick and no menu.
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_ready" ? { ...c, state: "approved" as const } : c) }));
  expect(state("task_done").innerHTML).toBe("");
  expect(container.querySelector('.unit[data-run="task_done"] .simple-action-more')).toBeNull();
});

it("keeps where a request stands on the first line of its band's words, level with \"N need you\", however many lines they take", async () => {
  await withSimpleSheet(async () => {
    await show();
    const band = (id: string) => container.querySelector<HTMLElement>(`.unit[data-run="${id}"] > .unit-msg`)!;
    // "N need you" is placed on the band's first line. Stop and a word stand on the words' first baseline beside it,
    // not in the middle of two lines of words, about 9px lower.
    expect([band("task_running").querySelector(".unit-stop")!, band("task_done").querySelector(".unit-state")!].map(el => [el.textContent, ...styled(el, "align-self")]))
      .toEqual([["Stop", "baseline"], ["Suggestion", "baseline"]]);
    // A dot has no baseline. It is centred on that first line, the words' 19px, beside the Stop after it.
    const dot = band("task_waiting").querySelector(".unit-state")!;
    expect([!!dot.querySelector(".unit-dot"), ...styled(dot, "align-self", "height"), ...styled(band("task_waiting").querySelector(".unit-stop")!, "align-self")])
      .toEqual([true, "flex-start", "19px", "baseline"]);
  });
});

it("underlines the chat actions, makes edit result links stand out, and keeps amber for what needs the editor", async () => {
  appliedEdits();
  // A test lays nothing out, but it does work out which rules apply to an element. With the simple view's stylesheet in
  // the page and its palette named, a link's colour and the rule under it read as the chat draws them.
  const { readFileSync } = await import("node:fs");
  const sheet = document.createElement("style");
  sheet.textContent = `:root { --color-fg: white; --color-muted: silver; --color-dim: gray; --color-warn: orange; }\n${readFileSync(`${import.meta.dirname}/../simple.css`, "utf8")}`;
  document.head.append(sheet);
  try {
    await showFolded();
    await act(async () => {});
    const look = (text: string) => {
      const style = getComputedStyle(buttonIn(container.querySelector(".simple-thread")!, text)!);
      // A rule with no colour of its own takes the link's.
      return [style.color, style.textDecoration, style.textDecorationColor.replace(/^(currentColor)?$/, style.color)].join(" ");
    };
    // A request at work, one that made edits, and one paused for its transcripts while one is being made.
    await event(d => ({ ...d, tasks: [...d.tasks, { ...d.tasks.find(t => t.id === "task_done")!, id: "task_paused", changeIds: [], needsTranscripts: ["cam"],
      context: { threadId: "task_paused", message: "Cut the pauses." }, createdAt: new Date().toISOString() },
      { ...d.tasks.find(t => t.id === "task_done")!, id: "task_transcribing", kind: "transcribe" as const, agent: "api" as const, state: "running" as const, changeIds: [], summary: null,
        instruction: "Transcribe cam", context: { mediaId: "cam" }, createdAt: new Date().toISOString(), finishedAt: undefined }] }));
    expect(["Stop", "Finish when ready"].map(look)).toEqual(Array(2).fill("silver underline gray"));
    expect(look("See all")).toBe("white underline white");
    expect(getComputedStyle(buttonIn(turnFor("chg_approved_2"), "See all")!).fontWeight).toBe("600");
    // What needs the editor is amber, rule and all: an edit to check, and Scarlet's question.
    expect(["1 needs you", "Answer"].map(look)).toEqual(Array(2).fill("orange underline orange"));
    // The one action of a request that stopped early is a link like the rest, not white.
    await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_running" ? { ...t, state: "cancelled" as const, finishedAt: new Date().toISOString() } : t) }));
    expect(look("Resume")).toBe("silver underline gray");
  } finally {
    sheet.remove();
  }
});

it("draws a revision of one applied edit under that edit's row, at work, and under the sentence while the list is closed", async () => {
  appliedEdits();
  idle();
  const base = data.tasks.find(t => t.id === "task_done")!;
  // The request that made the edits, then a revision of one of them.
  data = { ...data, tasks: [...data.tasks, { ...base, id: "task_made", kind: "edit" as const, instruction: "Tighten the wrap, add music and captions.",
    context: { message: "Tighten the wrap, add music and captions." }, changeIds: ["chg_approved_2"] }] };
  const thread = threadWith("chg_approved_2");
  const now = new Date().toISOString();
  const revision = { ...base, id: "task_fix", kind: "edit" as const, state: "running" as const, summary: null, changeIds: [], instruction: "Make the captions bigger.",
    createdAt: now, startedAt: now, finishedAt: undefined, expectedSeconds: undefined,
    context: { threadId: thread.id, changeId: "chg_approved_2", editIndex: 1, time: 0.2, end: 2.4, message: "Make the captions bigger." } };
  data = { ...data, tasks: [...data.tasks, revision] };
  useProjectStore.setState({ current: data });
  await showFolded();
  await act(async () => {});
  const sub = () => container.querySelector<HTMLElement>('.subunit[data-run="task_fix"]')!;
  const owner = () => sub().closest<HTMLElement>(".unit")!;
  // It is no block of its own: it is inside the request that made the edit, which holds the place above the message
  // box while Scarlet is on it.
  expect(container.querySelector('.unit[data-run="task_fix"]')).toBeNull();
  expect(owner().closest(".simple-pin")).not.toBeNull();
  expect(owner().querySelector(":scope > .unit-msg .simple-revising")).toBeNull();
  // With the list closed it sits under what the request made: named for its edit, with the editor's words and Scarlet at work.
  expect(owner().querySelector(".simple-edits")).toBeNull();
  expect(sub().parentElement?.classList.contains("simple-pass")).toBe(true);
  expect([tagIn(sub()), wordsOf(sub().querySelector(".subunit-msg p"))]).toEqual(["Edit at 0:00", "Make the captions bigger."]);
  expect(sub().querySelector('[aria-label="Scarlet’s work"] .working-text')).not.toBeNull();
  // Its Stop is its own heading's last word, and the request that holds it has none: Scarlet isn't on that one.
  expect(sub().querySelector(".subunit-msg")!.lastElementChild?.textContent).toBe("Stop");
  expect(owner().querySelector(":scope > .unit-msg > .unit-stop")).toBeNull();
  // Opened, the list has it directly under the row it revises, and that row's word moves while Scarlet works.
  await click(owner().querySelector(".simple-pass-toggle")!);
  const row = sub().previousElementSibling as HTMLElement;
  expect([row.className, row.querySelector(".simple-edit-title")?.textContent]).toEqual(["simple-edit", "captions"]);
  expect([row.querySelector(".simple-edit-check")?.textContent, row.querySelector(".simple-edit-check")?.classList.contains("working-text")]).toEqual(["Revising…", true]);
  expect(owner().querySelectorAll(".subunit").length).toBe(1);
  // Done, with the edit revised: it leaves, and the request has the fixed place no longer.
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_fix" ? { ...t, state: "done" as const, finishedAt: new Date().toISOString(), changeIds: ["chg_fixed"] } : t),
    changes: [...d.changes, { ...d.changes.find(c => c.id === "chg_approved_2")!, id: "chg_fixed", taskId: "task_fix", threadId: thread.id, createdAt: new Date().toISOString(),
      timelineEdits: [{ label: "captions", range: { start: 0.2, end: 2.4 } }] }] }));
  expect(container.querySelector('[data-run="task_fix"]')).toBeNull();
  expect(container.querySelector(".simple-pin .unit")).toBeNull();
});

it("keeps the list of what needs the editor, and only that, once one of its edits is sent back for revision", async () => {
  const edits = appliedEdits();
  idle();
  const base = data.tasks.find(t => t.id === "task_done")!;
  data = { ...data, tasks: [...data.tasks, { ...base, id: "task_made", kind: "edit" as const, instruction: "Tighten the wrap, add music and captions.",
    context: { message: "Tighten the wrap, add music and captions." }, changeIds: ["chg_approved_2"] }] };
  const thread = threadWith("chg_approved_2");
  useProjectStore.setState({ current: data });
  await showFolded();
  await act(async () => {});
  const owner = () => container.querySelector<HTMLElement>('.unit[data-run="task_made"]')!;
  const list = () => owner().querySelector<HTMLElement>(".simple-edits");
  const rows = () => [...owner().querySelectorAll<HTMLElement>(".simple-edits .simple-edit")].map(r => [r.querySelector(".simple-edit-title")?.textContent, r.querySelector(".simple-edit-check")?.textContent]);
  // "1 needs you" lists the flagged edit alone and opens it. Its row has no line under it: the reason is on its card.
  await click(owner().querySelector(".simple-pass-need")!);
  await act(async () => {});
  expect([list()?.getAttribute("aria-label"), rows(), openTitle()]).toEqual(["Edits that need you", [["wrap", undefined]], "wrap"]);
  // The editor sends a revision of it. Scarlet takes it up, so the request moves above the message box, mounted anew.
  const now = new Date().toISOString();
  await event(d => ({ ...d, tasks: [...d.tasks, { ...base, id: "task_fix", kind: "edit" as const, state: "running" as const, summary: null, changeIds: [], instruction: "Keep the last word.",
    createdAt: now, startedAt: now, finishedAt: undefined, expectedSeconds: undefined,
    context: { threadId: thread.id, changeId: "chg_approved_2", editIndex: 2, time: 11.5, end: 16, message: "Keep the last word." } }] }));
  await act(async () => {});
  expect(owner().closest(".simple-pin")).not.toBeNull();
  // The list is still just that edit, now Revising…, with the request directly under its row. Nothing waits on the
  // editor, and the link beside the sentence still opens every edit.
  expect([list()?.getAttribute("aria-label"), rows()]).toEqual(["Edits that need you", [["wrap", "Revising…"]]]);
  expect(container.querySelector('.subunit[data-run="task_fix"]')!.previousElementSibling?.querySelector(".simple-edit-title")?.textContent).toBe("wrap");
  expect([owner().querySelector(".simple-pass-need"), owner().querySelector(".simple-pass-toggle")?.textContent]).toEqual([null, "See all"]);
  // The revision lands with nothing to check, and the edit is still open on its card. The list goes: the request,
  // back in the conversation, doesn't open the list of every edit by itself.
  edits.mockImplementation(async (_project, threadId) => ({ version: data.project.head!, edits: threadId !== thread.id ? [] : [
    { changeId: "chg_approved_2", spot: 0, label: "music bed", range: { start: 0, end: 16 }, previous: [] },
    { changeId: "chg_approved_2", spot: 1, label: "captions", range: { start: 0.2, end: 2.4 }, previous: [] },
    { changeId: "chg_fixed", spot: 0, label: "wrap", range: { start: 11.5, end: 16 }, previous: [{ changeId: "chg_approved_2", spot: 2 }] },
  ] as never }));
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_fix" ? { ...t, state: "done" as const, finishedAt: new Date().toISOString(), changeIds: ["chg_fixed"] } : t),
    changes: [...d.changes, { ...d.changes.find(c => c.id === "chg_approved_2")!, id: "chg_fixed", taskId: "task_fix", threadId: thread.id, createdAt: new Date().toISOString(),
      timelineEdits: [{ label: "wrap", range: { start: 11.5, end: 16 } }] }] }));
  await act(async () => {});
  expect(container.querySelector(".simple-pin .unit")).toBeNull();
  expect([list(), owner().querySelector(".simple-pass-toggle")?.getAttribute("aria-expanded"), container.querySelector('[data-run="task_fix"]')]).toEqual([null, "false", null]);
});

it("draws a request about one place of an edit made in several once, under that edit's row, while only what needs the editor is listed", async () => {
  const { base, thread } = madeRequest();
  // The captions went on in two places. Scarlet flagged the second, and the editor sent the first back.
  vi.spyOn(api, "threadEdits").mockImplementation(async (_project, threadId) => ({ version: data.project.head!,
    edits: threadId !== thread.id ? [] : [
      { changeId: "chg_approved_2", spot: 0, label: "music bed", range: { start: 0, end: 16 }, previous: [] },
      { changeId: "chg_approved_2", spot: 1, label: "captions", range: { start: 0.2, end: 2.4 }, previous: [] },
      { changeId: "chg_approved_2", spot: 2, label: "captions", range: { start: 11.5, end: 16 }, previous: [], check: "The second line runs long" },
    ] }));
  data = { ...data, tasks: [...data.tasks, captionFix(base, thread.id)] };
  useProjectStore.setState({ current: data });
  await showFolded();
  await act(async () => {});
  const block = () => container.querySelector<HTMLElement>('.unit[data-run="task_made"]')!;
  expect(block().querySelector(".simple-pass-need")?.textContent).toBe("1 needs you");
  // "1 needs you" lists that edit as one row for both its places.
  await click(block().querySelector(".simple-pass-need")!);
  await act(async () => {});
  expect([...block().querySelectorAll(".simple-edits .simple-edit")].map(row => [row.querySelector(".simple-edit-title")?.textContent, row.querySelector(".simple-edit-value")?.textContent]))
    .toEqual([["captions", "2 places"]]);
  // The request about the place that wasn't flagged is directly under that row, and not a second time under the list.
  const under = [...block().querySelectorAll<HTMLElement>(".subunit[data-run]")];
  expect(under.map(sub => sub.getAttribute("data-run"))).toEqual(["task_fix"]);
  expect(under[0]!.previousElementSibling?.classList.contains("simple-edit")).toBe(true);
});

it("keeps a request about an edit that isn't among the ones that need the editor under their list", async () => {
  const { base, thread } = madeRequest();
  // Only the wrap asks for a look, and the editor sent the captions back.
  data = { ...data, tasks: [...data.tasks, captionFix(base, thread.id)] };
  useProjectStore.setState({ current: data });
  await showFolded();
  await act(async () => {});
  const block = () => container.querySelector<HTMLElement>('.unit[data-run="task_made"]')!;
  await click(block().querySelector(".simple-pass-need")!);
  await act(async () => {});
  expect([...block().querySelectorAll(".simple-edits .simple-edit-title")].map(title => title.textContent)).toEqual(["wrap"]);
  // The captions have no row in that list, so the request about them follows it.
  const under = [...block().querySelectorAll<HTMLElement>(".subunit[data-run]")];
  expect(under.map(sub => sub.getAttribute("data-run"))).toEqual(["task_fix"]);
  expect(under[0]!.previousElementSibling?.classList.contains("simple-edits")).toBe(true);
});

it("keeps Scarlet's reply to two lines however long it is, and opens it in full on a click", async () => {
  // A reply that runs past its two lines, as the window measures it.
  const tooLong = vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(900);
  await show();
  const reply = () => container.querySelector<HTMLElement>(".simple-chat .said")!;
  const words = reply().textContent;
  expect(words!.length).toBeGreaterThan(0);
  // Folded, it says there is more to it only by its ellipsis and the pointer: there is no button.
  expect([reply().classList.contains("is-clipped"), reply().getAttribute("aria-expanded"), reply().title]).toEqual([true, "false", "Show all of it"]);
  expect(reply().closest(".unit, .simple-turn")!.querySelector(".said button, .said + button")).toBeNull();
  // A click opens the whole reply, and the next folds it again. The words are the same either way.
  await click(reply());
  expect([reply().classList.contains("is-open"), reply().getAttribute("aria-expanded"), reply().title, reply().textContent]).toEqual([true, "true", "", words]);
  await click(reply());
  expect([reply().classList.contains("is-open"), reply().getAttribute("aria-expanded")]).toEqual([false, "false"]);
  // A reply that fits is plain words: nothing to open.
  tooLong.mockRestore();
  await act(async () => root.unmount());
  root = createRoot(container);
  await show();
  expect([reply().className.includes("is-clipped"), reply().getAttribute("aria-expanded"), reply().onclick]).toEqual([false, null, null]);
});

it("keeps an edit in the need-you list where it was once it's kept, until that list closes", async () => {
  appliedEdits();
  // Two of the request's three edits ask for a look.
  vi.spyOn(api, "threadEdits").mockImplementation(async (_project, threadId) => ({ version: data.project.head!,
    edits: threadId !== threadWith("chg_approved_2").id ? [] : [
      { changeId: "chg_approved_2", spot: 0, label: "music bed", range: { start: 0, end: 16 }, previous: [] },
      { changeId: "chg_approved_2", spot: 1, label: "captions", range: { start: 0.2, end: 2.4 }, previous: [], check: "The second line runs long" },
      { changeId: "chg_approved_2", spot: 2, label: "wrap", range: { start: 11.5, end: 16 }, previous: [], check: CHECK, summary: SUMMARY },
    ] }));
  await showFolded();
  await act(async () => {});
  const turn = turnFor("chg_approved_2");
  const need = () => turn.querySelector<HTMLElement>(".simple-pass-need");
  const rows = () => [...turn.querySelectorAll<HTMLButtonElement>(".simple-edits .simple-edit")].map(r =>
    [r.querySelector(".edit-badge")?.textContent?.trim(), r.querySelector(".simple-edit-title")?.textContent, r.querySelector(".edit-badge")?.classList.contains("is-kept")]);
  expect([need()?.textContent, turn.querySelector(".simple-edits")]).toEqual(["2 need you", null]);
  // "2 need you" lists just those two, numbered as in the whole list, and opens the first.
  await click(need()!);
  await act(async () => {});
  expect(rows()).toEqual([["2", "captions", false], ["3", "wrap", false]]);
  expect(openTitle()).toBe("captions");
  // Kept, it stays in its place, filled, while the count goes down and the next one opens.
  await press("k");
  await act(async () => {});
  expect([need()?.textContent, openTitle()]).toEqual(["1 needs you", "wrap"]);
  expect(rows()).toEqual([["2", "captions", true], ["3", "wrap", false]]);
  // The last one kept, nothing needs the editor: the list goes with the link.
  await press("k");
  await act(async () => {});
  expect([need(), turn.querySelector(".simple-edits"), editPanel()]).toEqual([null, null, null]);
});

it("leaves a flagged edit that's open where it is when need you is pressed, as a pass does", async () => {
  appliedEdits();
  // Two of the request's three edits ask for a look.
  vi.spyOn(api, "threadEdits").mockImplementation(async (_project, threadId) => ({ version: data.project.head!,
    edits: threadId !== threadWith("chg_approved_2").id ? [] : [
      { changeId: "chg_approved_2", spot: 0, label: "music bed", range: { start: 0, end: 16 }, previous: [] },
      { changeId: "chg_approved_2", spot: 1, label: "captions", range: { start: 0.2, end: 2.4 }, previous: [], check: "The second line runs long" },
      { changeId: "chg_approved_2", spot: 2, label: "wrap", range: { start: 11.5, end: 16 }, previous: [], check: CHECK, summary: SUMMARY },
    ] }));
  await show();
  await act(async () => {});
  const turn = turnFor("chg_approved_2");
  const rows = () => [...turn.querySelectorAll<HTMLButtonElement>(".simple-edits .simple-edit")];
  const need = () => turn.querySelector<HTMLElement>(".simple-pass-need")!;
  // The editor opens the second of the flagged edits from the whole list, then asks for just the ones that need them.
  await click(rows()[2]!);
  await act(async () => {});
  expect(openTitle()).toBe("wrap");
  await click(need());
  await act(async () => {});
  // The list is those two, and the edit they had open is still the one open: it doesn't jump back to the first.
  expect(rows().map(r => r.querySelector(".simple-edit-title")?.textContent)).toEqual(["captions", "wrap"]);
  expect(openTitle()).toBe("wrap");
  // With an edit open that asks for nothing, it opens the first that does.
  await click(turn.querySelector(".simple-pass-toggle")!);
  await click(rows()[0]!);
  await act(async () => {});
  expect(openTitle()).toBe("music bed");
  await click(need());
  await act(async () => {});
  expect(openTitle()).toBe("captions");
});

it("opens the next edit when one Scarlet didn't flag is kept, with a flagged edit further on", async () => {
  // music bed, captions, and wrap, which Scarlet flagged.
  appliedEdits();
  await show();
  await act(async () => {});
  await click(turnFor("chg_approved_2").querySelector(".simple-edit")!);
  expect(openTitle()).toBe("music bed");
  // The editor is going through them one by one: captions is next, not the flagged wrap two rows down.
  await press("k");
  expect(openTitle()).toBe("captions");
  await press("k");
  expect(openTitle()).toBe("wrap");
  // Kept on the flagged one, with no other flagged edit waiting, the card closes.
  await press("k");
  expect(editPanel()).toBeNull();
});

/** One applied cut, 10–12.4 s on the version before it, as its request's only edit. */
const oneAppliedCut = () => {
  flagged();
  useProjectStore.setState({ current: data });
  vi.spyOn(api, "threadEdits").mockResolvedValue({ version: data.project.head!, edits: [
    { changeId: "chg_approved_2", spot: 0, label: "Keep the image test", range: { start: 8, end: 12 }, at: 10,
      beforeCut: { version: "v_before", removed: { start: 10, end: 12.4 } }, previous: [] },
  ] });
};
const cutRow = () => turnFor("chg_approved_2").querySelector<HTMLElement>(".simple-edits .simple-edit")!;

it("opens a cut unlit with its words folded when it is opened again, after Before and its transcript were left on, and starts it over unlit when its open row is pressed again", async () => {
  oneAppliedCut();
  vi.spyOn(api, "timeline").mockResolvedValue({ timeline: { ...data.timeline!, version: "v_before" } } as never);
  const audition = vi.spyOn(player, "audition");
  await show();
  await click(buttonIn(turnFor("chg_approved_2"), "See edit")!);
  await act(async () => {});
  await press("\\");
  await click(transcriptLink());
  expect(beforeIcon(editPanel()!)?.[2]).toBe("true");
  expect(transcriptLink().getAttribute("aria-expanded")).toBe("true");
  // Closed with Esc and opened again from its row: it plays as the video runs, and its words are folded.
  await press("Escape");
  expect(editPanel()).toBeNull();
  await click(buttonIn(turnFor("chg_approved_2"), "See edit")!);
  await act(async () => {});
  expect(beforeIcon(editPanel()!)).toEqual(["", "Before", "false", "Play Before (\\)"]);
  expect(container.querySelector(".simple-on-video")?.textContent).toBe("Showing “Keep the image test” · After");
  expect(transcriptLink().getAttribute("aria-expanded")).toBe("false");
  expect(openHead()!.querySelector(".edit-passage")).toBeNull();
  expect(audition).toHaveBeenLastCalledWith({ start: 8, end: 15.4, skips: [{ start: 10, end: 12.4, removed: true }] }, expect.any(Number));
  // A click in the red leaves it on Before from that point. Its open row pressed again starts it over as the video
  // runs, unlit: the card stays up, with the timeline still on the cut.
  await act(async () => { container.querySelector<HTMLElement>(".simple-timeline-band")!.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, isPrimary: true, button: 0, bubbles: true })); });
  expect(editPanel()!.querySelector(".edit-card-before.is-flash")).not.toBeNull();
  const plays = audition.mock.calls.length, band = container.querySelector(".simple-timeline-band")?.getAttribute("style");
  await click(cutRow());
  await act(async () => {});
  expect(beforeIcon(editPanel()!)).toEqual(["", "Before", "false", "Play Before (\\)"]);
  expect(audition.mock.calls.length).toBe(plays + 1);
  // After, from the top of the listen: it steps over the cut again.
  expect(audition.mock.lastCall?.[0]).toEqual({ start: 8, end: 15.4, skips: [{ start: 10, end: 12.4, removed: true }] });
  expect(container.querySelector(".simple-timeline-band")?.getAttribute("style")).toBe(band);
  // Closed with Esc and opened again: no flash and no clicked point.
  await press("Escape");
  await click(buttonIn(turnFor("chg_approved_2"), "See edit")!);
  await act(async () => {});
  expect(beforeIcon(editPanel()!)?.[2]).toBe("false");
  expect(editPanel()!.querySelector(".edit-card-before.is-flash")).toBeNull();
});

it("plays a cut again from the top when the line of the request that made it is pressed again: unlit, its words still open", async () => {
  idle();
  // A request made an edit. A follow-up in the same conversation, about no one cut or edit, then took a cut out.
  const base = data.tasks.find(t => t.id === "task_done")!;
  const now = new Date().toISOString();
  const asked = (id: string, text: string, changeId: string, at = base.createdAt) => ({ ...base, id, kind: "edit" as const, summary: null, instruction: text,
    createdAt: at, startedAt: at, finishedAt: at, context: { threadId: "task_made", message: text }, changeIds: [changeId] });
  data = { ...data, tasks: [...data.tasks, asked("task_made", "Add a music bed.", "chg_approved_2"), asked("task_follow", "Take out the false start too.", "chg_follow", now)],
    changes: [...data.changes, { ...data.changes.find(c => c.id === "chg_approved_2")!, id: "chg_follow", taskId: "task_follow", threadId: "task_made",
      description: "Cut the false start", timelineEdits: [{ label: "The false start", range: { start: 8, end: 12 } }], createdAt: now, updatedAt: now }] };
  useProjectStore.setState({ current: data });
  vi.spyOn(api, "threadEdits").mockImplementation(async (_project, threadId) => ({ version: data.project.head!, edits: threadId !== "task_made" ? [] : [
    { changeId: "chg_approved_2", spot: 0, label: "music bed", range: { start: 0, end: 16 }, previous: [] },
    { changeId: "chg_follow", spot: 0, label: "The false start", range: { start: 8, end: 12 }, at: 10,
      beforeCut: { version: "v_before", removed: { start: 10, end: 12.4 } }, previous: [] },
  ] }));
  vi.spyOn(api, "timeline").mockResolvedValue({ timeline: { ...data.timeline!, version: "v_before" } } as never);
  const audition = vi.spyOn(player, "audition");
  await show();
  await act(async () => {});
  // The follow-up has no list of its own: its line opens the cut it made.
  const line = () => container.querySelector<HTMLButtonElement>('.unit[data-run="task_follow"] .req-result button')!;
  expect([line().textContent, line().title]).toEqual(["The false start", "Show on the timeline"]);
  await click(line());
  await act(async () => {});
  expect(container.querySelector(".simple-on-video")?.textContent).toBe("Showing “The false start” · After");
  expect(boxTag()).toBe("Cut at 0:10");
  await press("\\");
  await click(transcriptLink());
  expect([beforeIcon(editPanel()!)?.[2], transcriptLink().getAttribute("aria-expanded")]).toEqual(["true", "true"]);
  const plays = audition.mock.calls.length, band = container.querySelector(".simple-timeline-band")?.getAttribute("style");
  // Pressed again, the line plays the cut again from the top as its row would: as the video runs, unlit, with its
  // words still open, the timeline still on the cut and the message box still on it.
  await click(line());
  await act(async () => {});
  expect([beforeIcon(editPanel()!)?.[2], transcriptLink().getAttribute("aria-expanded")]).toEqual(["false", "true"]);
  expect(audition.mock.calls.length).toBe(plays + 1);
  expect(audition.mock.lastCall?.[0]).toEqual({ start: 8, end: 15.4, skips: [{ start: 10, end: 12.4, removed: true }] });
  expect(container.querySelector(".simple-timeline-band")?.getAttribute("style")).toBe(band);
  expect(boxTag()).toBe("Cut at 0:10");
  // Every press of the line aims an empty box at its cut, as the first did: a tag taken off the box is back.
  await act(async () => composer.props!.onClearTarget!());
  expect(boxTag()).toBeUndefined();
  await click(line());
  await act(async () => {});
  expect([boxTag(), beforeIcon(editPanel()!)?.[2]]).toEqual(["Cut at 0:10", "false"]);
  // Esc is what closes it. Opened again from the line, it plays as the video runs, with its words folded.
  await press("Escape");
  expect(editPanel()).toBeNull();
  await click(line());
  await act(async () => {});
  expect([beforeIcon(editPanel()!)?.[2], transcriptLink().getAttribute("aria-expanded")]).toEqual(["false", "false"]);
});

it("folds a call's words again when the call is opened again", async () => {
  flagged();
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  await reviewCalls();
  const words = () => call().querySelector<HTMLButtonElement>(".edit-card-words")!;
  await click(words());
  expect(words().getAttribute("aria-expanded")).toBe("true");
  await press("Escape");
  await reviewCalls();
  expect(words().getAttribute("aria-expanded")).toBe("false");
});

it("plays a call again when its open row is pressed again, and leaves it open with its words and the timeline where they are", async () => {
  finishedPass();
  const audition = vi.spyOn(player, "audition");
  await show();
  await act(async () => {});
  await reviewCalls();
  const row = () => passRows().find(r => r.getAttribute("aria-current"))!;
  const words = () => call().querySelector<HTMLButtonElement>(".edit-card-words")!;
  await click(words());
  const plays = audition.mock.calls.length, band = container.querySelector(".simple-timeline-band")?.getAttribute("style");
  expect(plays).toBeGreaterThan(0);
  await click(row());
  await act(async () => {});
  expect(container.querySelector('[aria-label="Call"]')).not.toBeNull();
  expect(row()).toBeDefined();
  expect(words().getAttribute("aria-expanded")).toBe("true");
  // The same listen, started over.
  expect(audition.mock.calls.length).toBe(plays + 1);
  expect(audition.mock.lastCall).toEqual([audition.mock.calls[plays - 1]![0], expect.any(Number)]);
  expect(container.querySelector(".simple-timeline-band")?.getAttribute("style")).toBe(band);
  // Esc is what closes it.
  await press("Escape");
  expect(container.querySelector('[aria-label="Call"]')).toBeNull();
});

it("gives Space back to the player after a cut's row or one of its card's icons is clicked", async () => {
  oneAppliedCut();
  vi.spyOn(api, "timeline").mockResolvedValue({ timeline: { ...data.timeline!, version: "v_before" } } as never);
  await show();
  // The row stays on screen while its cut is open. Pressed again it would play the cut from the top again.
  await click(buttonIn(turnFor("chg_approved_2"), "See edit")!);
  await pointerClick(cutRow());
  await act(async () => {});
  expect(document.activeElement).not.toBe(cutRow());
  expect(await spaceWhilePaused()).toBe(true);
  expect(editPanel()).not.toBeNull();
  // The words fold and Before flips back if Space presses their icons.
  await pointerClick(transcriptLink());
  expect(document.activeElement).not.toBe(transcriptLink());
  expect(await spaceWhilePaused()).toBe(true);
  expect(transcriptLink().getAttribute("aria-expanded")).toBe("true");
  const before = () => editPanel()!.querySelector<HTMLButtonElement>(".edit-card-before")!;
  await pointerClick(before());
  expect(document.activeElement).not.toBe(before());
  expect(await spaceWhilePaused()).toBe(true);
  expect(before().getAttribute("aria-pressed")).toBe("true");
  // Pressed with the keyboard, an icon keeps the focus, so Tab goes on from it.
  before().focus();
  await act(async () => { before().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 })); });
  expect(document.activeElement).toBe(before());
});

it("leaves the Before key alone until the version before a cut has arrived", async () => {
  oneAppliedCut();
  let arrive = () => {};
  vi.spyOn(api, "timeline").mockImplementation(() => new Promise(resolve => { arrive = () => resolve({ timeline: { ...data.timeline!, version: "v_before" } } as never); }));
  const audition = vi.spyOn(player, "audition");
  await show();
  await click(buttonIn(turnFor("chg_approved_2"), "See edit")!);
  await act(async () => {});
  // Nothing to play Before on yet: the key does what the disabled icon does, nothing.
  const shown = container.querySelector(".watch-monitor")!.textContent;
  await press("\\");
  expect(container.querySelector(".watch-monitor")!.textContent).toBe(shown);
  expect(container.textContent).not.toContain("Opening Before");
  await act(async () => arrive());
  await act(async () => {});
  expect(beforeIcon(editPanel()!)?.[2]).toBe("false");
  expect(audition).toHaveBeenLastCalledWith({ start: 8, end: 15.4, skips: [{ start: 10, end: 12.4, removed: true }] }, expect.any(Number));
});

it("keeps a cut's card open while the version before it loads: ← → and the timeline are the player's, and only Esc closes it", async () => {
  oneAppliedCut();
  let arrive = () => {};
  vi.spyOn(api, "timeline").mockImplementation((_, version = "head") => new Promise(resolve => {
    const answer = () => resolve({ timeline: { ...data.timeline!, version } } as never);
    if (version === "v_before") arrive = answer; else answer();
  }));
  const seek = vi.spyOn(player, "seek");
  const audition = vi.spyOn(player, "audition");
  await show();
  await click(buttonIn(turnFor("chg_approved_2"), "See edit")!);
  await act(async () => {});
  expect(editPanel()).not.toBeNull();
  expect(audition).not.toHaveBeenCalled();
  // → skips five seconds while the version before the cut is on its way. The card stays open.
  seek.mockClear();
  await press("ArrowRight");
  expect(seek).toHaveBeenCalledWith(5, true);
  expect(editPanel()).not.toBeNull();
  // A press on the timeline moves the player, and the card stays open too.
  seek.mockClear();
  const slider = container.querySelector<HTMLElement>(".timeline-slider")!;
  slider.getBoundingClientRect = () => ({ left: 0, width: 1000 }) as DOMRect;
  slider.setPointerCapture = () => {};
  for (const type of ["pointerdown", "pointerup"]) {
    await act(async () => { slider.dispatchEvent(new PointerEvent(type, { bubbles: true, isPrimary: true, button: 0, pointerId: 1, clientX: 250 })); });
  }
  expect(seek).toHaveBeenCalledWith(expect.any(Number), true);
  expect(editPanel()).not.toBeNull();
  // Once the version arrives, the cut plays on it as it does when it opens.
  await act(async () => arrive());
  for (let i = 0; i < 4; i++) await act(async () => {});
  expect(audition).toHaveBeenLastCalledWith({ start: 8, end: 15.4, skips: [{ start: 10, end: 12.4, removed: true }] }, expect.any(Number));
  // Esc is what closes it.
  await press("Escape");
  expect(editPanel()).toBeNull();
});

it("says so in a cut's words when the version before it can't be loaded, offers Retry transcript, and gives its card no Before/After", async () => {
  oneAppliedCut();
  // Two people speak around the join, which would tag the words with their names.
  vi.spyOn(api, "transcript").mockImplementation(async mediaId => {
    const transcript = buildDb().transcripts[mediaId]!;
    return { ...transcript, segments: transcript.segments.map(s => ({ ...s, words: s.words.map((w, i) => ({ ...w, speaker: i % 2 ? "Guest" : "Matt" })) })) };
  });
  let failing = true;
  const version = vi.spyOn(api, "timeline").mockImplementation(async (_, v = "head") => {
    if (v === "v_before" && failing) throw new Error("The engine is restarting.");
    return { timeline: { ...data.timeline!, version: v } } as never;
  });
  const audition = vi.spyOn(player, "audition");
  await show();
  await click(buttonIn(turnFor("chg_approved_2"), "See edit")!);
  for (let i = 0; i < 4; i++) await act(async () => {});
  expect(version.mock.calls.filter(([, v]) => v === "v_before").length).toBeGreaterThan(0);
  // A cut's card has no Before/After switch: its one icon waits for a version to play it on, as while that loads,
  // and \ plays no Before of anyone else's meanwhile.
  const card = editPanel()!;
  expect(card.querySelector(".compare-switch")).toBeNull();
  expect(beforeIcon(card)).toEqual(["", "Before", "false", "Play Before (\\)"]);
  expect(card.querySelector<HTMLButtonElement>(".edit-card-before")!.disabled).toBe(true);
  await press("\\");
  for (let i = 0; i < 4; i++) await act(async () => {});
  expect(container.textContent).not.toMatch(/Opening Before…|Retry Before/);
  expect(audition).not.toHaveBeenCalled();
  // Its words say there is nothing to read them on, with why on hover, and ask again, as a call's do. Nothing is
  // read on the video as it runs now meanwhile: no speaker tags and no second join mark.
  await click(transcriptLink());
  for (let i = 0; i < 4; i++) await act(async () => {});
  const passage = () => editPanel()!.querySelector<HTMLElement>(".thread-passage")!;
  expect([passage().querySelector(".edit-passage-cut")?.textContent, passage().querySelector(".edit-passage-wait"),
    buttonIn(passage(), "Retry transcript")?.title]).toEqual(["2.4 s", null, "The engine is restarting."]);
  expect(passage().querySelector(".review-voice, .review-join, .review-passage")).toBeNull();
  // Asked again, the version comes in: the cut plays on it and its icon works.
  failing = false;
  await click(buttonIn(passage(), "Retry transcript")!);
  for (let i = 0; i < 4; i++) await act(async () => {});
  expect(buttonIn(passage(), "Retry transcript")).toBeUndefined();
  expect(editPanel()!.querySelector<HTMLButtonElement>(".edit-card-before")!.disabled).toBe(false);
  expect(audition).toHaveBeenLastCalledWith({ start: 8, end: 15.4, skips: [{ start: 10, end: 12.4, removed: true }] }, expect.any(Number));
});

it("reads nothing of a cut's words on the video as it runs now while the version before it loads", async () => {
  oneAppliedCut();
  // Two people speak around the join, which would tag the words with their names.
  vi.spyOn(api, "transcript").mockImplementation(async mediaId => {
    const transcript = buildDb().transcripts[mediaId]!;
    return { ...transcript, segments: transcript.segments.map(s => ({ ...s, words: s.words.map((w, i) => ({ ...w, speaker: i % 2 ? "Guest" : "Matt" })) })) };
  });
  vi.spyOn(api, "timeline").mockImplementation((_, version = "head") => version === "v_before" ? new Promise(() => {})
    : Promise.resolve({ timeline: { ...data.timeline!, version } } as never));
  await show();
  await click(buttonIn(turnFor("chg_approved_2"), "See edit")!);
  await act(async () => {});
  await click(transcriptLink());
  for (let i = 0; i < 6; i++) await act(async () => {});
  // The mark stands alone and says the words are on their way: no words, speaker tags or join mark of the working cut.
  const passage = editPanel()!.querySelector<HTMLElement>(".thread-passage")!;
  expect([passage.querySelector(".edit-passage-cut")?.textContent, passage.querySelector(".edit-passage-wait")?.textContent]).toEqual(["2.4 s", "Loading the words…"]);
  expect(passage.querySelector(".review-voice, .review-join, .review-passage")).toBeNull();
});

it("says a cut's length the same way in its row, its mark and on the timeline", async () => {
  flagged();
  useProjectStore.setState({ current: data });
  vi.spyOn(api, "threadEdits").mockResolvedValue({ version: data.project.head!, edits: [
    { changeId: "chg_approved_2", spot: 0, label: "A pause", range: { start: 0, end: 4 }, at: 2,
      beforeCut: { version: "v_before", removed: { start: 2, end: 11.97 } }, previous: [] },
    { changeId: "chg_approved_2", spot: 1, label: "The long tangent", range: { start: 8, end: 12 }, at: 10,
      beforeCut: { version: "v_before", removed: { start: 300, end: 521 } }, previous: [] },
  ] });
  vi.spyOn(api, "timeline").mockResolvedValue({ timeline: { ...data.timeline!, version: "v_before" } } as never);
  await show();
  const rows = () => [...turnFor("chg_approved_2").querySelectorAll<HTMLElement>(".simple-edits .simple-edit")];
  // A cut of 9.97 s is "10 s" in its row, and one of 3:41 isn't "221 s" there while its mark says 3:41.
  expect(rows().map(r => r.querySelector(".simple-edit-value")?.textContent)).toEqual(["−10 s", "−3:41"]);
  await click(rows()[0]!);
  await act(async () => {});
  expect(container.querySelector(".simple-timeline-band")?.textContent).toBe("Removed · 10 s");
  await click(transcriptLink());
  expect(openHead()!.querySelector(".edit-passage-cut")?.textContent).toBe("10 s");
});

it("works the suggestion's card as an edit's: it plays as it opens, its keys are named on hover, and \\ switches Before and After", async () => {
  vi.spyOn(api, "timeline").mockImplementation(async (_, version = "head") => ({ timeline: { ...data.timeline!, version } }));
  const play = vi.spyOn(player, "play");
  await show();
  // The line says "Play this suggestion", and it does, as an edit's row plays its edit: once the suggested version is up.
  expect(suggestion("chg_ready").title).toBe("Play this suggestion");
  await click(suggestion("chg_ready"));
  await act(async () => {});
  expect(play).toHaveBeenCalledTimes(1);
  const strip = container.querySelector<HTMLElement>('[aria-label="Suggestion"]')!;
  // No key is drawn on the card and there is no Close: Esc closes it, and Revise and Apply name their keys on hover.
  expect(buttonIn(strip, "Close")).toBeUndefined();
  expect(strip.querySelector(".simple-key, kbd")).toBeNull();
  expect([...strip.querySelectorAll(".review-actions button")].map(b => [b.textContent, b.getAttribute("aria-keyshortcuts"), b.getAttribute("title")]))
    .toEqual([["Revise", "R", "Revise (R)"], ["Apply", "A", "Apply (A)"]]);
  expect(compareButton(strip).getAttribute("aria-keyshortcuts")).toBe("\\");
  expect(beforeIcon(strip)).toEqual(["", "Before", "false", "Play Before (\\)"]);
  await press("\\");
  expect(beforeIcon(strip)).toEqual(["", "Before", "true", "Back to After (\\)"]);
  await press("\\");
  await act(async () => {});
  expect(beforeIcon(strip)).toEqual(["", "Before", "false", "Play Before (\\)"]);
  // Only the press on the line played it: a switch of sides is no press to play.
  expect(play).toHaveBeenCalledTimes(1);
});

it("plays a suggestion only on the editor's press on its line: its card comes back paused after an apply the engine refused", async () => {
  vi.spyOn(api, "timeline").mockImplementation(async (_, version = "head") => ({ timeline: { ...data.timeline!, version } }));
  // The store's own apply runs: it takes the suggestion off the screen at the press, and puts it back when the engine refuses.
  let refuse!: (reason: Error) => void;
  vi.spyOn(api, "approveChange").mockImplementation(() => new Promise((_resolve, reject) => { refuse = reject; }) as never);
  const play = vi.spyOn(player, "play");
  await show();
  await click(suggestion("chg_ready"));
  await act(async () => {});
  expect(play).toHaveBeenCalledTimes(1);
  const strip = () => container.querySelector<HTMLElement>('[aria-label="Suggestion"]');
  await click(buttonIn(strip()!, "Apply")!);
  expect(strip()).toBeNull();
  await act(async () => refuse(new Error("The engine stopped.")));
  await act(async () => {});
  // The strip is back with the reason. Nobody pressed play, so it waits where it begins.
  expect(strip()?.querySelector('[role="alert"]')?.textContent).toBe("The engine stopped.");
  expect(play).toHaveBeenCalledTimes(1);
  // A revision that changes nothing brings it back the same way: the suggestion leaves while Scarlet has it and
  // returns as it was, paused.
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_ready" ? { ...c, state: "revising" as const } : c) }));
  expect(strip()).toBeNull();
  await event(d => ({ ...d, changes: d.changes.map(c => c.id === "chg_ready" ? { ...c, state: "ready" as const } : c) }));
  await act(async () => {});
  expect(strip()).not.toBeNull();
  expect(play).toHaveBeenCalledTimes(1);
  // Its line puts it away, and pressed again plays it from where it begins.
  await click(suggestion("chg_ready"));
  expect(strip()).toBeNull();
  await click(suggestion("chg_ready"));
  await act(async () => {});
  expect(play).toHaveBeenCalledTimes(2);
});

it("starts a clip played from Media once: once it plays, nothing tells its player to start again", async () => {
  await show();
  await act(async () => {});
  await openMenu();
  await click(menuRow("Media"));
  await act(async () => { await vi.dynamicImportSettled(); });
  const row = await vi.waitFor(() => { const b = container.querySelector<HTMLButtonElement>('button[aria-label^="Preview source"]'); if (!b) throw new Error("no Media row yet"); return b; });
  await click(row);
  const clip = () => container.querySelector<HTMLVideoElement>(".watch-monitor video")!;
  expect(container.querySelector('[aria-label="Source preview"]')).not.toBeNull();
  // Its player is told to start by itself.
  expect(clip().autoplay).toBe(true);
  // The clip plays. From here a pause is the editor's: a saved file taking over from the stream, or Media, History
  // or Export opening and closing over it, finds no standing order to play.
  await act(async () => usePlayerStore.setState({ playing: true }));
  expect(clip().autoplay).toBe(false);
  await act(async () => usePlayerStore.setState({ playing: false }));
  expect(clip().autoplay).toBe(false);
  // Played again from Media, it starts again.
  await openMenu();
  await click(menuRow("Media"));
  await act(async () => { await vi.dynamicImportSettled(); });
  await click(await vi.waitFor(() => { const b = container.querySelector<HTMLButtonElement>('button[aria-label^="Preview source"]'); if (!b) throw new Error("no Media row yet"); return b; }));
  expect(clip().autoplay).toBe(true);
});

it("keeps an open edit's card up, paused, while its markers load again for a new working cut", async () => {
  earlierRequestOnly(false);
  const later = laterRequest("chg_later", false);
  await show();
  await act(async () => {});
  await click(editRows("chg_approved_2")[1]!);
  await act(async () => {});
  expect(openTitle()).toBe("captions");
  // The editor paused it. Another request's edit then lands, and every request's markers are asked for again.
  await act(async () => usePlayerStore.setState({ playing: false }));
  const play = vi.spyOn(player, "play");
  const passage = vi.spyOn(player, "previewRange");
  later.hold(later.earlier);
  await headMoves("ver_next");
  // While they load the card stays where it is: it doesn't blink out and come back.
  expect(editPanel()).not.toBeNull();
  expect(openTitle()).toBe("captions");
  await later.release();
  await act(async () => {});
  expect(openTitle()).toBe("captions");
  // And the edit isn't played again from its top.
  expect(play).not.toHaveBeenCalled();
  expect(passage.mock.calls.filter(call => call[2] !== undefined)).toEqual([]);
});

/**
 * An applied cut that is open, and what the engine lists once a revision of it lands: `revised` takes its place, linked
 * to it through `previous`, and the edit moves on to the version the revision made.
 */
const openCutThenRevise = async () => {
  const cut = { op: "rippleDelete" as const, start: 10, end: 12.4 };
  const before = { ...data.timeline!, version: "v_before" };
  const working = { ...applyOps(before, [cut]), version: data.project.head! };
  data = { ...data, timeline: working, changes: data.changes.map(c => c.id === "chg_approved_2"
    ? { ...c, ops: [cut], fromVersion: "v_before", toVersion: working.version, appliedVersion: working.version,
      timelineEdits: undefined, approvedSpots: undefined, appliedReview: undefined, cutReasons: [{ ...cut, reason: "Keep the image test" }] } : c) };
  useProjectStore.setState({ current: data });
  let listed: object[] = [{ changeId: "chg_approved_2", spot: 0, label: "Keep the image test", range: { start: 8.5, end: 11.5 }, at: 10,
    beforeCut: { version: "v_before", removed: { start: 10, end: 12.4 } }, previous: [] }];
  vi.spyOn(api, "threadEdits").mockImplementation(async () => ({ version: useProjectStore.getState().current!.project.head!, edits: listed as never }));
  vi.spyOn(api, "timeline").mockImplementation(async (_, version) => ({ timeline: version === "v_before" ? before : { ...working, version: version! } }));
  const spies = { audition: vi.spyOn(player, "audition"), passage: vi.spyOn(player, "previewRange"), play: vi.spyOn(player, "play") };
  await show();
  await click(buttonIn(turnFor("chg_approved_2"), "See edit")!);
  await act(async () => {});
  // Opening it played it once. The editor then paused it and sent a note on it.
  expect(spies.play).toHaveBeenCalledTimes(1);
  spies.play.mockClear();
  const lands = async (revised: object) => {
    listed = [{ label: "Keep the image test", ...revised, changeId: "chg_revised", spot: 0, previous: [{ changeId: "chg_approved_2", spot: 0 }] }];
    await headMoves("ver_revised");
    await act(async () => {});
    await act(async () => {});
  };
  return { ...spies, lands, was: working.version };
};

it("takes up an open cut as it was when its revision lands, and doesn't play it again", async () => {
  const { audition, play, lands, was } = await openCutThenRevise();
  // The revised cut takes out less, on the version the edit was on before the revision. Both take a moment to arrive.
  await lands({ range: { start: 8.9, end: 11.9 }, at: 10.4, beforeCut: { version: was, removed: { start: 10.4, end: 10.8 } } });
  expect([openTitle(), turnFor("chg_approved_2").querySelector(".simple-edit.is-on small")?.textContent]).toEqual(["Keep the image testv2", "v2"]);
  // It is the listen the editor started: the new cut is taken up where the playhead was, and nothing tells it to play.
  expect(play).not.toHaveBeenCalled();
  expect(audition).toHaveBeenLastCalledWith(expect.objectContaining({ start: 8.4, skips: [{ start: 10.4, end: 10.8, removed: true }] }), expect.any(Number), true);
  // The side the editor was on stays theirs too, and pressing the row again plays the cut from its top.
  expect(beforeIcon(editPanel()!)).toEqual(["", "Before", "false", "Play Before (\\)"]);
  await click(turnFor("chg_approved_2").querySelector(".simple-edits .simple-edit")!);
  expect(play).toHaveBeenCalledTimes(1);
  expect(audition.mock.calls.at(-1)).toHaveLength(2);
});

it("takes up an open cut as it was when its revision puts footage back, so it is no longer a cut", async () => {
  const { audition, passage, play, lands } = await openCutThenRevise();
  const listens = audition.mock.calls.length;
  await lands({ range: { start: 9.6, end: 10.8 }, kind: "restore" });
  // The card is an edit's now, with Before/After, and the player has its passage. It was started as a cut's listen,
  // and isn't started again.
  expect(editPanel()!.querySelector(".edit-card-length.is-added")?.textContent).toBe("Added");
  expect(editPanel()!.querySelector(".edit-card-words")).toBeNull();
  expect(beforeIcon(editPanel()!)).toEqual(["", "Before", "false", "Play Before (\\)"]);
  expect(audition).toHaveBeenCalledTimes(listens);
  expect(passage).toHaveBeenLastCalledWith({ start: 9.6, end: 10.8 }, expect.any(Number), undefined, true);
  expect(play).not.toHaveBeenCalled();
  // Its row pressed again plays the passage from its top, as any edit's does.
  await click(turnFor("chg_approved_2").querySelector(".simple-edits .simple-edit")!);
  expect(passage).toHaveBeenLastCalledWith({ start: 9.6, end: 10.8 }, expect.any(Number), undefined, false);
  expect(play).toHaveBeenCalledTimes(1);
});

it("takes up an open edit that isn't a cut as it was when its revision moves its passage", async () => {
  const edits = appliedEdits();
  const passage = vi.spyOn(player, "previewRange"), play = vi.spyOn(player, "play");
  await show();
  await click(editRows("chg_approved_2")[1]!);
  await act(async () => {});
  expect(openTitle()).toBe("captions");
  expect(passage).toHaveBeenLastCalledWith({ start: 0.2, end: 2.4 }, expect.any(Number), undefined, false);
  play.mockClear();
  // The revision starts the captions later. The engine lists it in the edit's place, linked to the version it replaces.
  edits.mockImplementation(async (_project, threadId) => ({ version: useProjectStore.getState().current!.project.head!,
    edits: threadId !== threadWith("chg_approved_2").id ? [] : [
      { changeId: "chg_approved_2", spot: 0, label: "music bed", range: { start: 0, end: 16 }, previous: [] },
      { changeId: "chg_revised", spot: 0, label: "captions", range: { start: 0.6, end: 2.4 }, previous: [{ changeId: "chg_approved_2", spot: 1 }] },
      { changeId: "chg_approved_2", spot: 2, label: "wrap", range: { start: 11.5, end: 16 }, previous: [], check: CHECK, summary: SUMMARY },
    ] }));
  await headMoves("ver_revised");
  await act(async () => {});
  expect(openTitle()).toBe("captionsv2");
  expect(passage).toHaveBeenLastCalledWith({ start: 0.6, end: 2.4 }, expect.any(Number), undefined, true);
  expect(play).not.toHaveBeenCalled();
  // Closed and opened again, it plays from its top.
  await press("Escape");
  await click(editRows("chg_approved_2")[1]!);
  await act(async () => {});
  expect(passage).toHaveBeenLastCalledWith({ start: 0.6, end: 2.4 }, expect.any(Number), undefined, false);
  expect(play).toHaveBeenCalledTimes(1);
});

/** A request that made the three edits, with Scarlet's closing words, and nothing running. */
const madeRequest = () => {
  appliedEdits();
  idle();
  const base = data.tasks.find(t => t.id === "task_done")!;
  data = { ...data, tasks: [...data.tasks, { ...base, id: "task_made", kind: "edit" as const, instruction: "Tighten the wrap, add music and captions.",
    summary: "Check edit 3 to hear how the ending lands.", context: { message: "Tighten the wrap, add music and captions." }, changeIds: ["chg_approved_2"] }] };
  useProjectStore.setState({ current: data });
  return { base, thread: threadWith("chg_approved_2") };
};
/** A revision of the request's second edit, as a task in its thread. */
const captionFix = (base: ProjectData["tasks"][number], threadId: string, over: Partial<ProjectData["tasks"][number]> = {}) => {
  const now = new Date().toISOString();
  return { ...base, id: "task_fix", kind: "edit" as const, state: "running" as const, summary: null, changeIds: [], instruction: "Make the captions bigger.",
    createdAt: now, startedAt: now, finishedAt: undefined, expectedSeconds: undefined,
    context: { threadId, changeId: "chg_approved_2", editIndex: 1, time: 0.2, end: 2.4, message: "Make the captions bigger." }, ...over };
};

it("reads an undo as Undo in the chat and in the queue, and keeps the instruction for Scarlet", async () => {
  madeRequest();
  // The engine saves each request as the app sent it, with the words the app gave for the editor.
  const sent: ProjectData["tasks"][number][] = [];
  const createTask = vi.fn(async (_project: string, body: Partial<ProjectData["tasks"][number]>) => {
    const task = { ...data.tasks.find(t => t.id === "task_made")!, ...body, id: `task_undo_${sent.length}`, state: "queued" as const, changeIds: [], summary: null,
      createdAt: new Date(Date.now() + sent.length).toISOString(), startedAt: undefined, finishedAt: undefined } as ProjectData["tasks"][number];
    sent.push(task);
    return task;
  });
  useProjectStore.setState({ createTask: createTask as never });
  await show();
  await act(async () => {});
  // Undo edit on the captions, then on the wrap. Scarlet starts on the first and the second waits its turn.
  for (const row of [1, 2]) {
    await click(editRows("chg_approved_2")[row]!);
    await act(async () => {});
    await click(undoIcon());
  }
  expect(vi.mocked(api.recordEditReview).mock.calls).toEqual(sent.map(task => [PRJ, { changeId: task.context.changeId, spot: task.context.editIndex, decision: "undo" }]));
  expect(sent.every(task => !("reviewRef" in task.context))).toBe(true);
  expect(sent.map(t => [t.instruction.slice(0, 12), t.context.message])).toEqual([["Undo edit 2,", "Undo"], ["Undo edit 3,", "Undo"]]);
  await event(d => ({ ...d, tasks: [...d.tasks, { ...sent[0]!, state: "running" as const, startedAt: new Date().toISOString() }, sent[1]!] }));
  await act(async () => {});
  // Under its edit's row the request is one word. The editor pressed Undo and wrote nothing, so nothing longer is theirs.
  const under = container.querySelector<HTMLElement>('.subunit[data-run="task_undo_0"]')!;
  expect(wordsOf(under.querySelector(".subunit-msg p"))).toBe("Undo");
  expect(under.previousElementSibling?.querySelector(".simple-edit-title")?.textContent).toBe("captions");
  // In the queue it carries its edit's tag and the same word.
  const queued = container.querySelector<HTMLElement>('[aria-label="Queued requests"] .queue-row')!;
  expect([queued.querySelector(".queue-target")?.textContent, queued.querySelector(".queue-text")?.textContent]).toEqual(["Edit at 0:11", "Undo"]);
  expect(container.querySelector(".simple-thread")!.textContent).not.toContain("Put back exactly");
});

it("takes Scarlet's closing words out of the chat with a revision that has left, and keeps the request's own under its block", async () => {
  const { base, thread } = madeRequest();
  data = { ...data, tasks: [...data.tasks, captionFix(base, thread.id)] };
  useProjectStore.setState({ current: data });
  await showFolded();
  await act(async () => {});
  // The revision lands with a sentence of its own. What it did is on its edit; nothing of it stays in the chat.
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_fix" ? { ...t, state: "done" as const, finishedAt: new Date().toISOString(), changeIds: ["chg_fixed"],
      summary: "The captions are 20% bigger now and still clear of the lower third." } : t),
    changes: [...d.changes, { ...d.changes.find(c => c.id === "chg_approved_2")!, id: "chg_fixed", taskId: "task_fix", threadId: thread.id, createdAt: new Date().toISOString(),
      timelineEdits: [{ label: "captions", range: { start: 0.2, end: 2.4 } }] }] }));
  await act(async () => {});
  expect(container.querySelector('[data-run="task_fix"]')).toBeNull();
  expect(container.querySelector(".simple-thread")!.textContent).not.toContain("20% bigger");
  // The request that made the edits keeps its reply, right after its block.
  const block = container.querySelector<HTMLElement>('.unit[data-run="task_made"]')!;
  expect(block.nextElementSibling?.className).toContain("simple-msg from-scarlet");
  expect(block.nextElementSibling?.textContent).toContain("Check edit 3 to hear how the ending lands.");
});

it("gives a request's list the place of Scarlet's reply while it's open, and brings the reply back on Hide", async () => {
  madeRequest();
  await showFolded();
  await act(async () => {});
  const block = () => container.querySelector<HTMLElement>('.unit[data-run="task_made"]')!;
  const reply = () => block().nextElementSibling?.classList.contains("from-scarlet") ? block().nextElementSibling!.querySelector(".said")?.textContent : undefined;
  const link = () => block().querySelector<HTMLButtonElement>(".simple-pass-toggle")!;
  // Folded, the request says what it made, and Scarlet's reply follows it.
  expect([link().textContent, reply()]).toEqual(["See all", "Check edit 3 to hear how the ending lands."]);
  const drawn = block();
  // Opened, the list has the reply's place. It is the same block, not drawn anew.
  await click(link());
  expect([link().textContent, !!block().querySelector(".simple-edits"), reply()]).toEqual(["Hide", true, undefined]);
  expect(block()).toBe(drawn);
  // Hide puts the list away, and the reply is back.
  await click(link());
  expect([link().textContent, block().querySelector(".simple-edits"), reply()]).toEqual(["See all", null, "Check edit 3 to hear how the ending lands."]);
});

it("keeps a revision whose new version couldn't be prepared, since nothing else would say it came to nothing", async () => {
  const { base, thread } = madeRequest();
  data = { ...data, tasks: [...data.tasks, captionFix(base, thread.id)] };
  useProjectStore.setState({ current: data });
  await showFolded();
  await act(async () => {});
  // The revision finishes, and the version it made failed to render: the edit is as it was, and no row or card says so.
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_fix" ? { ...t, state: "done" as const, finishedAt: new Date().toISOString(), changeIds: ["chg_fixed"] } : t),
    changes: [...d.changes, { ...d.changes.find(c => c.id === "chg_approved_2")!, id: "chg_fixed", taskId: "task_fix", threadId: thread.id, state: "failed" as const,
      createdAt: new Date().toISOString(), timelineEdits: [{ label: "captions", range: { start: 0.2, end: 2.4 } }] }] }));
  await act(async () => {});
  const fix = container.querySelector<HTMLElement>('[data-run="task_fix"]');
  expect(fix?.textContent).toContain("Make the captions bigger.");
  // Scarlet's words are all it has: no row under them names the edit again or offers to open a version that isn't there.
  expect([...fix!.querySelectorAll(".req > *")].map(row => row.className)).toEqual(["req-said"]);
  expect(fix!.querySelector(".req-said .said")?.textContent).toBe("I couldn’t prepare the preview for this edit.");
});

it("moves a request's closing words with its block to the place above the message box, and back", async () => {
  const { base, thread } = madeRequest();
  await showFolded();
  await act(async () => {});
  const block = () => container.querySelector<HTMLElement>('.unit[data-run="task_made"]')!;
  expect(block().closest(".simple-chat")).not.toBeNull();
  // Scarlet starts on a revision of one of its edits: the block holds the place above the box, its words with it.
  await event(d => ({ ...d, tasks: [...d.tasks, captionFix(base, thread.id)] }));
  await act(async () => {});
  expect(block().closest(".simple-pin")).not.toBeNull();
  expect(block().nextElementSibling?.textContent).toContain("Check edit 3 to hear how the ending lands.");
  expect(container.querySelector(".simple-chat")!.textContent).not.toContain("Check edit 3 to hear how the ending lands.");
});

it("keeps a list the editor opened on a request open when a revision of one of its edits starts and when it lands", async () => {
  const { base, thread } = madeRequest();
  await showFolded();
  await act(async () => {});
  const block = () => container.querySelector<HTMLElement>('.unit[data-run="task_made"]')!;
  await click(block().querySelector(".simple-pass-toggle")!);
  expect(block().querySelectorAll(".simple-edits .simple-edit").length).toBe(3);
  // The block moves above the message box while Scarlet revises, and is mounted anew there: the list stays open.
  await event(d => ({ ...d, tasks: [...d.tasks, captionFix(base, thread.id)] }));
  await act(async () => {});
  expect(block().closest(".simple-pin")).not.toBeNull();
  expect(block().querySelectorAll(".simple-edits .simple-edit").length).toBe(3);
  expect(block().querySelector(".simple-pass-toggle")?.textContent).toBe("Hide");
  // And back in the conversation once the revision is done.
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_fix" ? { ...t, state: "done" as const, finishedAt: new Date().toISOString(), changeIds: ["chg_fixed"] } : t),
    changes: [...d.changes, { ...d.changes.find(c => c.id === "chg_approved_2")!, id: "chg_fixed", taskId: "task_fix", threadId: thread.id, createdAt: new Date().toISOString(),
      timelineEdits: [{ label: "captions", range: { start: 0.2, end: 2.4 } }] }] }));
  await act(async () => {});
  expect(block().closest(".simple-chat")).not.toBeNull();
  expect(block().querySelectorAll(".simple-edits .simple-edit").length).toBe(3);
});

it("keeps a request that is tried again in its one block, and out of the queue", async () => {
  idle();
  const base = data.tasks.find(t => t.id === "task_done")!;
  const asked = new Date().toISOString();
  // It failed before saving anything, and wasn't interrupted: Retry tries it again from the start, as a new task.
  const failed = { ...base, id: "task_zoom", kind: "edit" as const, state: "failed" as const, error: "The model refused the request.", summary: null, changeIds: [],
    instruction: "Zoom into the browser window.", createdAt: asked, startedAt: asked, finishedAt: asked, context: { message: "Zoom into the browser window." } };
  data = { ...data, tasks: [...data.tasks, failed] };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  const blocks = () => units().filter(u => u.querySelector(".unit-msg p")?.textContent === "Zoom into the browser window.");
  expect(blocks().map(b => b.querySelector(".unit-state")?.textContent)).toEqual(["Couldn’t finish"]);
  // The retry waits its turn behind another request.
  const busy = { ...failed, id: "task_busy", state: "running" as const, error: undefined, instruction: "Add captions.", context: { message: "Add captions." }, finishedAt: undefined };
  const retry = { ...failed, id: "task_zoom_again", state: "queued" as const, error: undefined, startedAt: undefined, finishedAt: undefined,
    createdAt: new Date(Date.now() + 1000).toISOString(), context: { threadId: "task_zoom", message: "Zoom into the browser window." } };
  await event(d => ({ ...d, tasks: [...d.tasks.map(t => t.id === "task_zoom" ? { ...t, retryTaskId: "task_zoom_again" } : t), busy, retry] }));
  await act(async () => {});
  // One block, now in line again: it says Queued, as a cut's card and the tray do. It isn't a second request in the tray.
  expect(blocks().length).toBe(1);
  expect(blocks()[0]!.getAttribute("data-run")).toBe("task_zoom");
  expect(blocks()[0]!.querySelector('.req-status [role="status"]')?.textContent).toBe("Queued");
  expect(container.querySelector(".queue-tray")).toBeNull();
  // Once Scarlet is on it, the same block holds the place above the message box.
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_busy" ? { ...t, state: "done" as const, finishedAt: new Date().toISOString() }
    : t.id === "task_zoom_again" ? { ...t, state: "running" as const, startedAt: new Date().toISOString() } : t) }));
  await act(async () => {});
  expect(blocks().length).toBe(1);
  expect(blocks()[0]!.closest(".simple-pin")).not.toBeNull();
});

it("names a queued request about an edit the same way with the timeline on its request and after it moves to a later one", async () => {
  earlierRequestOnly();
  const later = laterRequest();
  // Sent while Scarlet was busy, about the earlier request's third edit. Its own time is where the passage around it starts.
  const base = buildDb().tasks.find(t => t.id === "task_done")!;
  data = { ...data, changes: [...data.changes, later.change], tasks: [...data.tasks, { ...base, id: "task_about_wrap", state: "queued" as const, startedAt: undefined,
    finishedAt: undefined, hostId: null, summary: null, changeIds: [], instruction: "Hold the last word.", createdAt: new Date().toISOString(),
    context: { threadId: later.earlier, changeId: "chg_approved_2", editIndex: 2, time: 10, end: 16, message: "Hold the last word." } }] };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  const tag = () => container.querySelector('[aria-label="Queued requests"] .queue-target')?.textContent;
  // With the edit open, its request has the timeline, and the tag reads as the edit's row does.
  await click(editRows("chg_approved_2")[2]!);
  await act(async () => {});
  expect(openTitle()).toBe("wrap");
  expect(tag()).toBe("Edit at 0:11");
  // Closed, the timeline is the later request's. The queue says the same words, not "Edit at 0:10".
  await press("Escape");
  await act(async () => {});
  expect(editPanel()).toBeNull();
  expect(tag()).toBe("Edit at 0:11");
});

it("shows all of Scarlet's reply to a request that changed nothing, kept to two lines until it's opened", async () => {
  idle();
  const base = data.tasks.find(t => t.id === "task_done")!;
  const asked = new Date().toISOString();
  const reply = ["I left both pauses in.", "The one at 2:05 is <1 s, so cutting it would clip the breath.", "The one at 2:31 runs 1.4 s.",
    "It sits before a new thought.", "Cutting it would run the two ideas together.", "Say the word and I’ll trim either one."];
  data = { ...data, tasks: [...data.tasks, { ...base, id: "task_asked", kind: "edit" as const, state: "done" as const, summary: reply.join(" "), changeIds: [],
    instruction: "Should the pauses in the intro go?", createdAt: asked, startedAt: asked, finishedAt: asked, context: { message: "Should the pauses in the intro go?" } }] };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  const block = units().find(u => u.querySelector(".unit-msg p")?.textContent === "Should the pauses in the intro go?")!;
  // Every sentence is there to open, the one with "<1 s" in it too.
  expect(block.querySelector(".req-say")?.textContent).toBe(reply.join(" "));
});

it("leaves full screen on the first Esc and keeps the open edit, which the next Esc closes", async () => {
  appliedEdits();
  await show();
  await act(async () => {});
  await click(turnFor("chg_approved_2").querySelector(".simple-edit")!);
  expect(editPanel()).not.toBeNull();
  // This window has no full screen of its own, so the page stands in for it.
  await click(container.querySelector('button[aria-label="Full screen"]')!);
  await act(async () => {});
  expect(container.querySelector(".cut-preview")!.hasAttribute("data-expanded")).toBe(true);
  await press("Escape");
  expect(container.querySelector(".cut-preview")!.hasAttribute("data-expanded")).toBe(false);
  expect(editPanel()).not.toBeNull();
  await press("Escape");
  expect(editPanel()).toBeNull();
});

function Address() {
  const { pathname, search } = useLocation();
  return <output id="address">{pathname}{search}</output>;
}

/** Settings opening, or a restart for an update, bookmarks the project's page. The page adds where the editor is. */
const bookmark = () => captureProjectPlace({ pathname: `/p/${PRJ}`, search: "", hash: "" })!;
/** The project's view closes, which puts the player back at the start at 1×, and opens again at the bookmark. */
const reopen = async (at: string) => {
  await act(async () => root.unmount());
  usePlayerStore.setState({ time: 0, duration: 0, playing: false, rate: 1 });
  root = createRoot(container);
  await act(async () => root.render(<MemoryRouter initialEntries={[at]}><SimpleWorkspace /><Address /></MemoryRouter>));
};

it("comes back from Settings or a restart to update at the speed the editor was watching at, on the frame they left", async () => {
  idle();
  await show();
  await act(async () => { usePlayerStore.setState({ time: 12.5 }); player.setRate(1.5); });
  const place = bookmark();
  expect(place).toBe(`/p/${PRJ}?t=12.5&speed=1.5`);
  // A video that still plays as a stream shows the frame it opened on until it is asked for another. Coming back,
  // it is asked for the one at the bookmark, so the picture is the moment the clock and the playhead say.
  const asked: number[] = [];
  vi.spyOn(player, "prepare").mockImplementation(() => { asked.push(usePlayerStore.getState().time); });
  await reopen(place);
  expect(asked).toEqual([12.5]);
  expect([usePlayerStore.getState().time, usePlayerStore.getState().rate]).toEqual([12.5, 1.5]);
  expect(container.querySelector('.monitor-controls [aria-label="Playback speed"]')?.textContent).toBe("1.5×");
  // The place is used once: the address is the project's own again.
  expect(container.querySelector("#address")?.textContent).toBe(`/p/${PRJ}`);
  // At the ordinary speed the way back says only where.
  await act(async () => { usePlayerStore.setState({ time: 3 }); player.setRate(1); });
  expect(bookmark()).toBe(`/p/${PRJ}?t=3`);
  // A speed the picker doesn't offer is left alone.
  await reopen(`/p/${PRJ}?t=4&speed=9`);
  expect([usePlayerStore.getState().time, usePlayerStore.getState().rate]).toEqual([4, 1]);
});

it("keeps the conversation and the cut on screen when the edit moves on and its new timeline can't be read, and says so after them only if it keeps failing", async () => {
  const loader = vi.spyOn(await import("../lib/cutStream"), "playbackLoader");
  vi.spyOn(await import("../lib/cutStream"), "openCutStream").mockReturnValue({ seek() {}, finishSeek() {}, dispose() {}, sourceTime: () => 0, bufferThrough: async () => {} });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => new Promise(() => {}));
  // The editor can start a new request while the new timeline is loading.
  idle();
  await show();
  const before = units().length;
  expect(before).toBeGreaterThan(0);
  const shown = data.timeline!.version;
  const video = () => container.querySelector('.watch-monitor video[aria-label="The current edit"]');
  expect(video()).not.toBeNull();
  // The engine moves the edit on, and every read of its new timeline fails.
  useProjectStore.setState({ refreshHead: initialStore.refreshHead });
  const read = vi.spyOn(api, "workspace").mockRejectedValue(new Error("The engine is busy."));
  vi.useFakeTimers();
  try {
    await act(async () => useProjectStore.getState().applyEvent({ type: "project.updated", projectId: PRJ, project: { ...data.project, head: "ver_moved_on" } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(read).toHaveBeenCalledTimes(1);
    // Nothing is taken off screen for it: the requests, their Stop and questions, and the cut as it was before.
    expect([units().length, container.querySelector('.simple-chat [role="alert"]'), !!video()]).toEqual([before, null, true]);
    // The player plays that cut as itself, not the new version's footage at its places.
    await act(async () => player.play());
    expect(loader).toHaveBeenLastCalledWith(PRJ, shown);
    // Edit here attaches a point on the timeline the editor can see while the new one is loading.
    await act(async () => player.pause());
    const slider = container.querySelector<HTMLElement>(".timeline-slider")!;
    slider.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 }) as DOMRect;
    slider.setPointerCapture = vi.fn();
    const pointer = (type: string) => new PointerEvent(type, { bubbles: true, button: 0, isPrimary: true, pointerId: 1, clientX: 50 });
    await act(async () => { slider.dispatchEvent(pointer("pointerdown")); slider.dispatchEvent(pointer("pointerup")); });
    expect(useUiStore.getState().agentContext).toBeNull();
    await chooseEditHere();
    expect(useUiStore.getState().agentContext).toMatchObject({ version: shown });
    // The store reads it again by itself, and only once that has kept failing is it said after the conversation,
    // which stays, with Retry.
    await act(async () => { await vi.advanceTimersByTimeAsync(14_000); });
    expect(read).toHaveBeenCalledTimes(4);
    expect(container.querySelector('.simple-chat [role="alert"]')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(read).toHaveBeenCalledTimes(5);
  } finally { vi.useRealTimers(); }
  const alert = container.querySelector<HTMLElement>('.simple-chat [role="alert"]')!;
  expect([units().length, alert.firstChild?.textContent, alert === container.querySelector(".simple-chat")!.lastElementChild, !!video()])
    .toEqual([before, "Couldn’t load the updated timeline: The engine is busy.", true, true]);
  await click(buttonIn(alert, "Retry")!);
  expect(useProjectStore.getState().load).toHaveBeenCalledWith(PRJ);
});

it("aims an emptied box at the edit that's open now, not the one its deleted message was about", async () => {
  appliedEdits();
  data = { ...data, tasks: data.tasks.map(t => t.state === "waiting_for_user" ? { ...t, state: "done" as const, question: null } : t) };
  useProjectStore.setState({ current: data });
  await show();
  const rows = () => turnFor("chg_approved_2").querySelectorAll(".simple-edits .simple-edit");
  await click(rows()[1]!);
  await act(async () => {});
  const first = boxTag();
  expect(first).toBe("Edit at 0:00");
  // A note is begun on this edit, and the editor steps to the next one: the note stays aimed where it was written.
  await act(async () => useUiStore.getState().setAgentDraft("Make them smaller"));
  await press("ArrowDown");
  await act(async () => {});
  expect(rows()[2]!.getAttribute("aria-current")).toBe("true");
  expect([boxTag(), aimLine()?.[2]]).toEqual([first, "Move here"]);
  // They delete it instead. Nothing is being written any more, so the box talks to the edit on screen: the next note
  // typed must not revise the edit they left.
  await act(async () => useUiStore.getState().setAgentDraft(""));
  expect(boxTag()).not.toBe(first);
  expect(aimLine()?.slice(1)).toEqual([true, undefined]);
});

it("leaves the box where it is on Revise and Answer while a message is being spoken into it", async () => {
  vi.spyOn(api, "timeline").mockImplementation(async (_, version = "head") => ({ timeline: { ...data.timeline!, version } }));
  await show();
  expect(boxTag()).toBe("Answer");
  await click(suggestion("chg_ready"));
  await act(async () => {});
  const before = boxNow();
  // Aiming the box builds it again, which would drop the recording without a word. R waits until it is out.
  await act(async () => useUiStore.getState().setSpeaking(true));
  await press("r");
  expect([boxTag(), boxNow()]).toEqual(["Answer", before]);
  await act(async () => useUiStore.getState().setSpeaking(false));
  await press("r");
  expect(boxTag()).toBe("Whole edit");
});

it("keeps the queue's tray open when the message box is aimed somewhere else", async () => {
  finishedPass();
  idle();
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  const base = data.tasks.find(t => t.id === "task_done")!;
  const waiting = (id: string, words: string, ms: number) => ({ ...base, id, kind: "edit" as const, state: "queued" as const, instruction: words, changeIds: [], summary: null,
    context: { threadId: id, message: words }, createdAt: at(ms), startedAt: undefined, finishedAt: undefined });
  data = { ...data, tasks: [...data.tasks, waiting("task_lower", "Add a lower third with my name.", 1000), waiting("task_music", "Lower the music.", 2000)] };
  useProjectStore.setState({ current: data });
  await show();
  await act(async () => {});
  const tray = () => container.querySelector<HTMLElement>('[aria-label="Queued requests"]')!;
  await click(tray().querySelector(".queue-head")!);
  expect(tray().querySelectorAll(".queue-row").length).toBe(2);
  // Opening a call aims the box at it, which builds the box and the tray on it again. The tray the editor opened stays open.
  const owner = useUiStore.getState().draftOwner;
  await press("ArrowDown");
  await act(async () => {});
  expect(useUiStore.getState().draftOwner).not.toBe(owner);
  expect(tray().querySelectorAll(".queue-row").length).toBe(2);
});

it("keeps the call the editor is on, and the list of calls, when another call's revision lands with more still queued", async () => {
  finishedPass();
  await show();
  await act(async () => {});
  // The editor sent the first and the last call back. Scarlet is on the first; the last waits its turn.
  await event(d => ({ ...d, tasks: [...d.tasks,
    callRequest("task_note1", 0, { kind: "edit" as const, state: "running" as const, startedAt: new Date().toISOString() }),
    callRequest("task_note2", 2, laterNote)] }));
  // They open the one call still theirs, to listen before sending it back too.
  await reviewCalls();
  expect(call().querySelector(".edit-card-title")?.textContent).toContain("Breath before the price.");
  // The first call comes back revised, as a new proposal that takes the pass's place. The engine announces it once,
  // with its notes on it, and then marks the pass it replaces: the card and the list stay as they are at each step.
  const old = data.changes.find(c => c.id === "chg_ready")!;
  const revised = { ...old, id: "chg_revised", taskId: "task_note1", toVersion: "ver_revised", createdAt: new Date().toISOString(),
    cutReasons: old.cutReasons!.map((r, i) => i === 0 ? { start: 1.5, end: 3, reason: "Starts in the pause." } : r),
    cutAssessments: old.cutAssessments!.map(a => a.index === 0 ? { index: 0, start: 1.5, end: 3, verdict: "ask" as const, reason: "Starts in the pause." } : a) };
  const asItWas = () => {
    expect(call()?.querySelector(".edit-card-title")?.textContent).toContain("Breath before the price.");
    expect(buttonIn(call(), "Approve")).toBeDefined();
    expect(passRows().map(r => r.querySelector(".simple-pass-label")?.textContent)).toEqual(STAGED.map(c => c.reason));
  };
  await event(d => ({ ...d, changes: [...d.changes, revised] }));
  asItWas();
  await event(d => ({ ...d, changes: d.changes.map(c => c.id !== "chg_ready" ? c : { ...c, state: "rejected" as const, rejectedFrom: "ready" as const,
    rejectReason: "Replaced by a later revision of the same cut.", replacedBy: revised.id }) }));
  asItWas();
  await event(d => ({ ...d, tasks: d.tasks.map(t => t.id === "task_note1" ? { ...t, changeIds: [revised.id] } : t) }));
  await act(async () => {});
  asItWas();
  // Scarlet moves on to the last call. Nothing changes for the one that's open.
  await runPasses("task_note1", "task_note2");
  await act(async () => {});
  expect(call()?.querySelector(".edit-card-title")?.textContent).toContain("Breath before the price.");
  expect(passRows().map(r => r.querySelector(".simple-pass-label")?.textContent)).toEqual(["Starts in the pause.", "Breath before the price.", "Repeated aside."]);
});
