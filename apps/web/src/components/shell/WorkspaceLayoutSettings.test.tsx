// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fullRenderContext, Task } from "@scarlet/shared";
import { makeMediaClip, makeTrack } from "@scarlet/timeline";
import { buildDb, PRJ } from "../../lib/mock/fixtures";
import { buildThreads } from "../../lib/threads";
import { api } from "../../lib/client";
import { useProjectStore, type ProjectData } from "../../stores/project";
import { useUiStore } from "../../stores/ui";
import { SimpleWorkspace } from "../../pages/SimpleWorkspace";
import { LINGER_FADE_MS, LINGER_MS } from "../../pages/simple/beta/reviewTabsBeta";
import { WorkspaceLayoutSettings } from "./WorkspaceLayoutSettings";

function stubMedia() {
  Object.defineProperty(HTMLMediaElement.prototype, "pause", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: vi.fn(() => Promise.resolve()) });
  Object.defineProperty(HTMLMediaElement.prototype, "load", { configurable: true, value: vi.fn() });
}

describe("WorkspaceLayoutSettings and beta layout toggle", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const oldUi = useUiStore.getState();
  const oldProject = useProjectStore.getState();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    stubMedia();
    localStorage.clear();
    useUiStore.setState({ ...oldUi, newLayout: false }, true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
    useUiStore.setState(oldUi, true);
    useProjectStore.setState(oldProject, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("defaults to off, toggles on/off in Settings, and persists to localStorage", async () => {
    expect(useUiStore.getState().newLayout).toBe(false);
    await act(async () => root.render(<WorkspaceLayoutSettings />));
    const toggle = container.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(localStorage.getItem("scarlet.newLayout")).toBeNull();

    await act(async () => toggle.click());
    expect(useUiStore.getState().newLayout).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem("scarlet.newLayout")).toBe("1");

    await act(async () => toggle.click());
    expect(useUiStore.getState().newLayout).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(localStorage.getItem("scarlet.newLayout")).toBeNull();
  });

  it("renders the previous two-column workspace by default and switches live to the three-column beta layout", async () => {
    const db = buildDb();
    const project = db.projects.find(p => p.id === PRJ)!;
    const asking = Task.parse({
      id: "task_beta_ask",
      projectId: PRJ,
      kind: "edit",
      agent: "claude",
      instruction: "Tighten the opening",
      state: "waiting_for_user",
      question: "How tight should I cut the intro?",
      questionChoices: ["Keep the setup", "Jump straight in"],
      createdBy: { type: "human", name: "Editor" },
      changeIds: [],
      createdAt: "2026-11-24T10:00:00.000Z",
    });
    const data: ProjectData = {
      id: PRJ,
      project,
      timeline: db.timelines[project.head!]!,
      media: project.media,
      changes: db.changes,
      notes: db.notes,
      renders: db.renders,
      tasks: [...db.tasks.filter(t => t.state !== "waiting_for_user"), asking],
      taskEvents: db.taskEvents,
      versions: db.versions[PRJ]!,
      fullRenderKeys: { context: fullRenderContext(project), preview: db.renders.find(r => r.kind === "full")!.key, delivery: "current-delivery" },
    };
    useProjectStore.setState({ current: data, status: "ready", load: vi.fn(), refreshHead: vi.fn(), loadTaskEvents: vi.fn().mockResolvedValue(undefined) });
    vi.spyOn(api, "renders").mockResolvedValue({ renders: [] });
    vi.spyOn(api, "preparePlayback").mockResolvedValue(undefined);
    vi.spyOn(api, "cutPlaybackFile").mockRejectedValue(new Error("Still streaming"));
    vi.spyOn(api, "sourceCaches").mockResolvedValue({ caches: [] });
    vi.spyOn(api, "recordEditReview").mockResolvedValue(undefined);
    vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings, transcriptionAvailable: true });
    vi.spyOn(api, "skills").mockResolvedValue({ skills: [] });
    vi.spyOn(api, "waveform").mockImplementation(async (mediaId, from, to) => ({ mediaId, from, to, peaks: [0.2, 0.8] }));
    vi.spyOn(api, "cutReview").mockResolvedValue({ review: null });
    vi.spyOn(api, "retakes").mockResolvedValue({ groups: [] } as never);
    vi.spyOn(api, "threadEdits").mockResolvedValue({
      version: project.head!,
      edits: [
        { changeId: db.changes[0]!.id, spot: 0, label: "Cut the false start", range: { start: 0, end: 2 }, previous: [], check: "Check the join." },
        { changeId: db.changes[0]!.id, spot: 1, label: "Quiet music bed", range: { start: 0, end: 10 }, previous: [] },
      ],
    });

    await act(async () => root.render(<MemoryRouter><SimpleWorkspace /></MemoryRouter>));
    await act(async () => {});

    // Default (beta off): two-column legacy layout, no review rail, no data-new-layout attribute.
    expect(container.querySelector("[data-new-layout]")).toBeNull();
    expect(container.querySelector(".review-rail")).toBeNull();
    expect(container.querySelector(".composer-ask")).toBeNull();

    // Flip beta toggle on: switches live to three-column layout with bubbles, question panel, and unified Priority list.
    await act(async () => useUiStore.getState().setNewLayout(true));
    await act(async () => {});
    expect(container.querySelector("[data-new-layout]")).not.toBeNull();
    expect(container.querySelector(".review-rail")).not.toBeNull();
    expect(container.querySelector(".review-rail-head .review-head-keep")).toBeNull();
    expect(container.querySelector(".review-tier-sep .review-tier-label")?.textContent).toBe("Safe edits (1)");
    expect(container.querySelector(".review-tier-sep .review-head-keep")?.textContent).toBe("Keep 1 safe edit");
    // Safe edits start folded under their heading; a press on it unfolds them and another folds them again.
    const safeToggle = container.querySelector<HTMLButtonElement>(".review-tier-toggle")!;
    const safeBody = () => container.querySelector<HTMLElement>('.review-low-body[aria-label="Safe edits"]')!;
    expect(safeToggle.getAttribute("aria-expanded")).toBe("false");
    expect(safeBody().hidden).toBe(true);
    await act(async () => safeToggle.click());
    expect(safeToggle.getAttribute("aria-expanded")).toBe("true");
    expect(safeBody().hidden).toBe(false);
    await act(async () => safeToggle.click());
    expect(safeBody().hidden).toBe(true);
    expect(container.querySelector(".review-filter-bar")).toBeNull();
    expect(container.querySelector(".composer-ask-text")?.textContent).toBe("How tight should I cut the intro?");
    expect([...container.querySelectorAll(".composer-ask-choice")].map(b => b.textContent)).toEqual(["Keep the setup", "Jump straight in"]);
    // Working and Done banners stay visible at the foot even when empty (Working above Done), separated by a divider line, chat doesn't repeat "Needs review N", and every row leads with its time, never a number.
    const footSections = [...container.querySelectorAll<HTMLButtonElement>(".review-rail-foot .review-sec")];
    expect(footSections.map(b => b.textContent)).toEqual(["Working0", "Done0"]);
    expect(footSections.every(b => b.disabled && b.classList.contains("is-none") && b.getAttribute("aria-expanded") === "false")).toBe(true);
    expect(footSections[0]!.matches("[data-new-layout] .review-sec-body + .review-sec")).toBe(false);
    expect(footSections[1]!.matches("[data-new-layout] .review-sec-body + .review-sec")).toBe(true);
    const { readFileSync } = await import("node:fs");
    const betaCss = readFileSync(`${import.meta.dirname}/../../pages/simple/beta/beta.css`, "utf8");
    expect(betaCss).toMatch(/\[data-new-layout\]\s+\.review-sec-body\s*\+\s*\.review-sec\s*\{[^}]*border-top:\s*1px solid var\(--color-line\)/);
    // Keep the amber timestamp pill unclipped inside the composer's overflow-hidden aim line.
    expect(betaCss).toMatch(/\[data-new-layout\]\s+\.composer-aim-row\s+\.simple-pass-time\.is-need\s*\{[^}]*margin:\s*0\b/);
    expect(container.querySelector("#simple-chat .simple-need-link")).toBeNull();
    expect(container.querySelector(".review-rail-list .edit-badge")).toBeNull();
    expect(container.querySelector(".review-rail-list .edit-row-time")?.textContent).toMatch(/^\d+:\d\d$/);
    expect(container.querySelector(".review-low-body .edit-badge")).toBeNull();
    expect(container.querySelector(".review-low-body .edit-row-time")?.textContent).toBe("0:00");
    // Every edit row keeps a consistent word tag on the right (including "Edit" fallback), and clicking a message bubble never turns it violet.
    const rowValues = [...container.querySelectorAll(".review-rail .simple-edit-value")].map(el => el.textContent?.trim());
    expect(rowValues.length).toBeGreaterThan(0);
    expect(rowValues.every(v => !!v && !/^−/.test(v))).toBe(true);
    const bubble = container.querySelector<HTMLElement>("#simple-chat .unit-msg");
    if (bubble) await act(async () => bubble.click());
    expect(container.querySelector("#simple-chat .unit-msg.is-marked")).toBeNull();
    // No pinned overlay sits between the scrollable chat and composer in desktop 3-column mode.
    expect(container.querySelector(".simple-pin")).toBeNull();

    // Flip back off: returns immediately to the previous default layout.
    await act(async () => useUiStore.getState().setNewLayout(false));
    await act(async () => {});
    expect(container.querySelector("[data-new-layout]")).toBeNull();
    expect(container.querySelector(".review-rail")).toBeNull();
  });

  it("covers beta pass polish: kept edit lingers in place before smoothly moving to Done, low-risk auto-unfolds, working card shows Stop, paused queue drops Up next, and question names its edit", async () => {
    const db = buildDb();
    const project = db.projects.find(p => p.id === PRJ)!;
    const change = db.changes.find(c => c.id === "chg_approved_2") ?? db.changes[0]!;
    const ownerThreadId = buildThreads({ changes: db.changes, tasks: db.tasks, notes: db.notes })
      .find(t => t.changes.some(c => c.id === change.id))!.id;
    const revisingTask = Task.parse({
      id: "task_beta_revise",
      projectId: PRJ,
      kind: "edit",
      agent: "claude",
      instruction: "Make captions bigger",
      state: "running",
      createdBy: { type: "human", name: "Editor" },
      changeIds: [],
      context: { changeId: change.id, editIndex: 1, threadId: ownerThreadId },
      createdAt: "2026-11-24T10:01:00.000Z",
    });
    const askingEditTask = Task.parse({
      id: "task_beta_ask_edit",
      projectId: PRJ,
      kind: "edit",
      agent: "claude",
      instruction: "Start it later",
      state: "waiting_for_user",
      question: "Cut after the breath, or before it?",
      createdBy: { type: "human", name: "Editor" },
      changeIds: [],
      context: { changeId: change.id, editIndex: 0, threadId: ownerThreadId },
      createdAt: "2026-11-24T10:02:00.000Z",
    });
    const queuedTask = Task.parse({
      id: "task_beta_queued",
      projectId: PRJ,
      kind: "edit",
      agent: "claude",
      instruction: "Add a title.",
      state: "queued",
      createdBy: { type: "human", name: "Editor" },
      changeIds: [],
      createdAt: "2026-11-24T10:03:00.000Z",
    });
    const data: ProjectData = {
      id: PRJ,
      project: { ...project, editingPaused: true },
      timeline: db.timelines[project.head!]!,
      media: project.media,
      changes: db.changes,
      notes: db.notes,
      renders: db.renders,
      tasks: [...db.tasks.filter(t => t.state !== "waiting_for_user"), revisingTask, askingEditTask, queuedTask],
      taskEvents: db.taskEvents,
      versions: db.versions[PRJ]!,
      fullRenderKeys: { context: fullRenderContext(project), preview: db.renders.find(r => r.kind === "full")!.key, delivery: "current-delivery" },
    };
    const cancelSpy = vi.fn().mockResolvedValue(undefined);
    useUiStore.setState({ ...oldUi, newLayout: true }, true);
    useProjectStore.setState({
      current: data,
      status: "ready",
      load: vi.fn(),
      refreshHead: vi.fn(),
      loadTaskEvents: vi.fn().mockResolvedValue(undefined),
      cancelTask: cancelSpy,
      stopEditing: vi.fn().mockResolvedValue(undefined),
      resumeEditing: vi.fn().mockResolvedValue(undefined),
    });
    vi.spyOn(api, "renders").mockResolvedValue({ renders: [] });
    vi.spyOn(api, "preparePlayback").mockResolvedValue(undefined);
    vi.spyOn(api, "cutPlaybackFile").mockRejectedValue(new Error("Still streaming"));
    vi.spyOn(api, "sourceCaches").mockResolvedValue({ caches: [] });
    vi.spyOn(api, "recordEditReview").mockResolvedValue(undefined);
    vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings, transcriptionAvailable: true });
    vi.spyOn(api, "skills").mockResolvedValue({ skills: [] });
    vi.spyOn(api, "waveform").mockImplementation(async (mediaId, from, to) => ({ mediaId, from, to, peaks: [0.2, 0.8] }));
    vi.spyOn(api, "cutReview").mockResolvedValue({ review: null });
    vi.spyOn(api, "retakes").mockResolvedValue({ groups: [] } as never);
    vi.spyOn(api, "threadEdits").mockImplementation(async (_projectId, threadId) => ({
      version: project.head!,
      edits: threadId === ownerThreadId ? [
        { changeId: change.id, spot: 0, label: "A clean retake.", range: { start: 2, end: 4 }, previous: [], check: "Check the retake." },
        { changeId: change.id, spot: 1, label: "captions", range: { start: 3, end: 8 }, previous: [] },
        { changeId: change.id, spot: 2, label: "music bed", range: { start: 0, end: 10 }, previous: [] },
      ] : [],
    }));

    await act(async () => root.render(<MemoryRouter><SimpleWorkspace /></MemoryRouter>));
    await act(async () => {});

    // #8: Question panel names the specific edit it asks about, and the asking row is highlighted.
    expect(container.querySelector(".composer-ask-label")?.textContent).toContain("Scarlet asks about");
    expect(container.querySelector(".composer-ask-subject")?.textContent).toContain("A clean retake.");
    expect(container.querySelector(".review-rail-list button.is-asking-current")).not.toBeNull();

    // #11: While paused, queued bubbles sit inside .simple-chat and drop "Up next".
    expect(container.querySelector(".simple-chat > .queue-chat")).not.toBeNull();
    expect(container.querySelector(".queue-next")).toBeNull();
    expect(container.querySelector(".queue-paused")?.textContent).toBe("Editing paused");

    // No Pause/Resume button on the timeline or chat bubbles; paused projects can still resume from the chat queue.
    expect(container.querySelector("#simple-chat .unit-pause-edit")).toBeNull();
    expect(container.querySelector(".timeline-working-pause")).toBeNull();
    expect(container.querySelector(".queue-editing-action")?.textContent).toBe("Resume");

    // #13: Clicking the Working edit ("captions") shows no card above the timeline until its new version lands, as in
    // the default layout: its row in Working says what Scarlet is doing with it.
    const workingBtn = [...container.querySelectorAll<HTMLButtonElement>(".review-rail-foot button.simple-edit")]
      .find(b => b.textContent?.includes("captions"))!;
    expect(workingBtn).toBeTruthy();
    await act(async () => workingBtn.click());
    await act(async () => {});
    expect(container.querySelector(".edit-card")).toBeNull();
    expect(container.textContent).not.toContain("Scarlet is revising this");

    // #14 & #3: Safe edits sit directly below flagged edits with no filter bar, and Keep lingers briefly before moving cleanly to Done without duplicating.
    expect(container.querySelector(".review-filter-bar")).toBeNull();
    // They start folded under their heading; a press on it unfolds them.
    expect(container.querySelector(".review-low-body")?.hasAttribute("hidden")).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>(".review-tier-toggle")!.click());
    expect(container.querySelector(".review-low-body")?.hasAttribute("hidden")).toBe(false);
    const musicRow = [...container.querySelectorAll<HTMLButtonElement>(".review-low-body button.simple-edit")]
      .find(b => b.textContent?.includes("music bed"))!;
    await act(async () => musicRow.click());
    await act(async () => {});
    const keepBtn = [...container.querySelectorAll<HTMLButtonElement>(".edit-card button")]
      .find(b => b.textContent?.trim() === "Keep")!;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await act(async () => keepBtn.click());
      await act(async () => {});
      // Immediately after Keep: row stays in Safe edits showing Kept, and is NOT duplicated in Done yet.
      expect(container.querySelector(".review-low-body")?.hasAttribute("hidden")).toBe(false);
      const lingeringMusic = container.querySelector<HTMLElement>(".review-low-body ol > li")!;
      expect(lingeringMusic.textContent).toContain("music bed");
      expect(lingeringMusic.textContent).toContain("Kept");
      expect(lingeringMusic.classList.contains("is-leaving")).toBe(false);
      const doneHead = [...container.querySelectorAll<HTMLButtonElement>(".review-sec")]
        .find(b => b.textContent?.includes("Done"))!;
      expect(doneHead.textContent).toContain("0");
      // After LINGER_MS: row starts fading out alongside the departing Safe edits divider.
      await act(async () => { vi.advanceTimersByTime(LINGER_MS); });
      expect(container.querySelector(".review-low-body ol > li")?.classList.contains("is-leaving")).toBe(true);
      expect(container.querySelector(".review-tier-sep")?.classList.contains("is-leaving")).toBe(true);
      // After LINGER_FADE_MS: row leaves Safe edits and lands in Done.
      await act(async () => { vi.advanceTimersByTime(LINGER_FADE_MS); });
      expect(container.querySelector(".review-low-body")?.hasAttribute("hidden")).toBe(true);
      expect(doneHead.textContent).toContain("1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the Working banner above the Done banner even when no edits are working", async () => {
    const db = buildDb();
    const project = db.projects.find(p => p.id === PRJ)!;
    const change = db.changes.find(c => c.id === "chg_approved_2") ?? db.changes[0]!;
    const ownerThreadId = buildThreads({ changes: db.changes, tasks: db.tasks, notes: db.notes })
      .find(t => t.changes.some(c => c.id === change.id))!.id;
    const data: ProjectData = {
      id: PRJ,
      project,
      timeline: db.timelines[project.head!]!,
      media: project.media,
      changes: db.changes,
      notes: db.notes,
      renders: db.renders,
      tasks: db.tasks.filter(t => t.state !== "waiting_for_user"),
      taskEvents: db.taskEvents,
      versions: db.versions[PRJ]!,
      fullRenderKeys: { context: fullRenderContext(project), preview: db.renders.find(r => r.kind === "full")!.key, delivery: "current-delivery" },
    };
    useUiStore.setState({ ...oldUi, newLayout: true }, true);
    useProjectStore.setState({ current: data, status: "ready", load: vi.fn(), refreshHead: vi.fn(), loadTaskEvents: vi.fn().mockResolvedValue(undefined) });
    vi.spyOn(api, "renders").mockResolvedValue({ renders: [] });
    vi.spyOn(api, "preparePlayback").mockResolvedValue(undefined);
    vi.spyOn(api, "cutPlaybackFile").mockRejectedValue(new Error("Still streaming"));
    vi.spyOn(api, "sourceCaches").mockResolvedValue({ caches: [] });
    vi.spyOn(api, "recordEditReview").mockResolvedValue(undefined);
    vi.spyOn(api, "summarizeBatches").mockResolvedValue({ summaries: {}, pending: [] });
    vi.spyOn(api, "keepEdits").mockResolvedValue(undefined);
    vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings, transcriptionAvailable: true });
    vi.spyOn(api, "skills").mockResolvedValue({ skills: [] });
    vi.spyOn(api, "waveform").mockImplementation(async (mediaId, from, to) => ({ mediaId, from, to, peaks: [0.2, 0.8] }));
    vi.spyOn(api, "cutReview").mockResolvedValue({ review: null });
    vi.spyOn(api, "retakes").mockResolvedValue({ groups: [] } as never);
    vi.spyOn(api, "threadEdits").mockImplementation(async (_projectId, threadId) => ({
      version: project.head!,
      edits: threadId === ownerThreadId ? [
        { changeId: change.id, spot: 0, label: "Cut the false start", range: { start: 0, end: 2 }, previous: [], check: "Check the join." },
        { changeId: change.id, spot: 1, label: "Quiet music bed", range: { start: 2, end: 10 }, previous: [] },
      ] : [],
    }));

    await act(async () => root.render(<MemoryRouter><SimpleWorkspace /></MemoryRouter>));
    await act(async () => {});

    // Keep the flagged edit: it lingers briefly marked Kept in Needs review, then moves to Done while Working stays at 0.
    const row = container.querySelector<HTMLButtonElement>(".review-rail-list button.simple-edit")!;
    await act(async () => row.click());
    await act(async () => {});
    const keepBtn = [...container.querySelectorAll<HTMLButtonElement>(".edit-card button")]
      .find(b => b.textContent?.trim() === "Keep")!;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await act(async () => keepBtn.click());
      await act(async () => {});
      expect(container.querySelector('.review-rail-list ol[aria-label="Edits that need you"] > li')?.textContent).toContain("Kept");
      expect([...container.querySelectorAll<HTMLButtonElement>(".review-rail-foot .review-sec")].map(b => b.textContent)).toEqual(["Working0", "Done0"]);
      await act(async () => { vi.advanceTimersByTime(LINGER_MS + LINGER_FADE_MS); });
    } finally {
      vi.useRealTimers();
    }

    const sections = [...container.querySelectorAll<HTMLButtonElement>(".review-rail-foot .review-sec")];
    expect(sections.map(b => b.textContent)).toEqual(["Working0", "Done1"]);
    expect(sections[0]!.disabled).toBe(true);
    expect(sections[0]!.classList.contains("is-none")).toBe(true);
    expect(sections[0]!.getAttribute("aria-expanded")).toBe("false");
    expect(sections[1]!.disabled).toBe(false);
    expect(sections[1]!.classList.contains("is-none")).toBe(false);

    // Expanding Done shows the kept edit with Unkeep, which moves it back to Needs review without opening it.
    const unkeep = vi.spyOn(api, "unkeepEdits").mockResolvedValue(undefined as never);
    await act(async () => sections[1]!.click());
    await act(async () => {});
    const unkeepBtn = container.querySelector<HTMLButtonElement>('.review-sec-body[aria-label="Done"] .simple-unkeep')!;
    expect(unkeepBtn).not.toBeNull();
    expect(unkeepBtn.textContent).toBe("Unkeep");
    await act(async () => unkeepBtn.click());
    await act(async () => {});
    expect(unkeep).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".review-rail-head .review-rail-count")?.textContent).toBe("1");
    expect(container.querySelector('.review-sec-body[aria-label="Done"] .simple-unkeep')).toBeNull();
  });

  it("lets the middle edits column resize from its right edge, keeps rows single-line, and shows a full-line UI tooltip on hover", async () => {
    const db = buildDb();
    const project = db.projects.find(p => p.id === PRJ)!;
    const longLabel = 'Left a To do where you said "Alex, can you throw that on screen right here?"';
    const data: ProjectData = {
      id: PRJ,
      project,
      timeline: db.timelines[project.head!]!,
      media: project.media,
      changes: db.changes,
      notes: db.notes,
      renders: db.renders,
      tasks: db.tasks.filter(t => t.state !== "waiting_for_user"),
      taskEvents: db.taskEvents,
      versions: db.versions[PRJ]!,
      fullRenderKeys: { context: fullRenderContext(project), preview: db.renders.find(r => r.kind === "full")!.key, delivery: "current-delivery" },
    };
    useUiStore.setState({ ...oldUi, newLayout: true }, true);
    useProjectStore.setState({ current: data, status: "ready", load: vi.fn(), refreshHead: vi.fn(), loadTaskEvents: vi.fn().mockResolvedValue(undefined) });
    vi.spyOn(api, "renders").mockResolvedValue({ renders: [] });
    vi.spyOn(api, "preparePlayback").mockResolvedValue(undefined);
    vi.spyOn(api, "cutPlaybackFile").mockRejectedValue(new Error("Still streaming"));
    vi.spyOn(api, "sourceCaches").mockResolvedValue({ caches: [] });
    vi.spyOn(api, "recordEditReview").mockResolvedValue(undefined);
    vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings, transcriptionAvailable: true });
    vi.spyOn(api, "skills").mockResolvedValue({ skills: [] });
    vi.spyOn(api, "waveform").mockImplementation(async (mediaId, from, to) => ({ mediaId, from, to, peaks: [0.2, 0.8] }));
    vi.spyOn(api, "cutReview").mockResolvedValue({ review: null });
    vi.spyOn(api, "retakes").mockResolvedValue({ groups: [] } as never);
    vi.spyOn(api, "threadEdits").mockResolvedValue({
      version: project.head!,
      edits: [
        { changeId: db.changes[0]!.id, spot: 0, label: longLabel, kind: "cut", range: { start: 4, end: 4 }, beforeCut: { version: "ver_1", removed: { start: 4, end: 5.8 } }, previous: [], check: "Needs graphic from Alex." },
        { changeId: db.changes[0]!.id, spot: 1, label: "Quiet music bed", kind: "audio", range: { start: 2, end: 10 }, previous: [] },
      ],
    });
    const prevInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    const measured = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.id === "simple-chat" || this.id === "simple-review-rail") {
        return { width: parseFloat(this.style.width) || 0, height: 800, top: 0, left: 0, right: parseFloat(this.style.width) || 0, bottom: 800 } as DOMRect;
      }
      return { width: 240, height: 28, top: 140, left: 480, right: 720, bottom: 168 } as DOMRect;
    });
    try {
      await act(async () => root.render(<MemoryRouter><SimpleWorkspace /></MemoryRouter>));
      await act(async () => {});

      // Right-edge resize separator on the middle edits column resizes and persists its width.
      const rail = container.querySelector<HTMLElement>("#simple-review-rail")!;
      const divider = rail.querySelector<HTMLElement>(':scope > [role="separator"]')!;
      expect(divider).not.toBeNull();
      expect(divider.getAttribute("aria-label")).toBe("Resize edits");
      expect(divider.getAttribute("aria-controls")).toBe("simple-review-rail");
      const startWidth = parseFloat(rail.style.width);
      // Before either divider is dragged, the chat and the edits column start at the same width.
      expect(startWidth).toBe(389);
      expect(parseFloat(container.querySelector<HTMLElement>("#simple-chat")!.style.width)).toBe(startWidth);
      divider.setPointerCapture = () => {};
      await act(async () => {
        divider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, isPrimary: true, clientX: 700 }));
      });
      await act(async () => {
        divider.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, button: 0, isPrimary: true, clientX: 840 }));
      });
      await act(async () => {
        divider.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0, isPrimary: true, clientX: 840 }));
      });
      expect(parseFloat(rail.style.width)).toBe(startWidth + 140);
      expect(localStorage.getItem("scarlet.simpleReviewWidth")).toBe(String(startWidth + 140));

      // Rows in the edits rail use Scarlet's own hover tooltip with the full line and a plain-English summary.
      const row = rail.querySelector<HTMLButtonElement>(".review-rail-list button.simple-edit")!;
      expect(row.getAttribute("title")).toBeNull();
      expect(row.dataset.rowTip).toBe(longLabel);
      expect(row.dataset.rowMeta).toBe("Cut · −1.8 s");
      vi.useFakeTimers();
      try {
        await act(async () => {
          row.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
          vi.advanceTimersByTime(220);
        });
        const tip = rail.querySelector<HTMLElement>('[role="tooltip"].review-rail-tip')!;
        expect(tip).not.toBeNull();
        expect(tip.querySelector(".review-rail-tip-title")?.textContent).toBe(longLabel);
        expect(tip.querySelector(".review-rail-tip-meta")?.textContent).toBe("Cut · −1.8 s");
        expect(tip.querySelector(".review-rail-tip-detail")?.textContent).toBe("Needs graphic from Alex.");
        expect(row.getAttribute("aria-describedby")).toBe(tip.id);

        // Moving to a low-risk non-cut row updates the tooltip immediately (warm hover) with its plain-English summary.
        const lowRow = rail.querySelector<HTMLButtonElement>(".review-low-body button.simple-edit")!;
        await act(async () => {
          lowRow.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
        });
        const lowTip = rail.querySelector<HTMLElement>('[role="tooltip"].review-rail-tip')!;
        expect(lowTip.querySelector(".review-rail-tip-title")?.textContent).toBe("Quiet music bed");
        expect(lowTip.querySelector(".review-rail-tip-meta")?.textContent).toContain("Audio");
        expect(lowTip.querySelector(".review-rail-tip-meta")?.textContent).not.toContain("0:02 – 0:10");

        // Leaving the rail dismisses the tooltip cleanly.
        await act(async () => {
          rail.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true, pointerType: "mouse" }));
        });
        expect(rail.querySelector('[role="tooltip"].review-rail-tip')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    } finally {
      measured.mockRestore();
      Object.defineProperty(window, "innerWidth", { configurable: true, value: prevInnerWidth });
      localStorage.removeItem("scarlet.simpleReviewWidth");
    }
  });

  it("always shows full text in beta editor bubbles while keeping Scarlet replies at three lines and default layout unchanged", async () => {
    const db = buildDb(true);
    const project = db.projects.find(p => p.id === PRJ)!;
    const now = new Date().toISOString();
    const baseTask = db.tasks.find(t => t.id === "task_chat_direct")!;
    const answeredTask = {
      ...baseTask,
      id: "task_answered_beta",
      state: "running" as const,
      createdAt: now,
      startedAt: now,
      finishedAt: undefined,
      summary: null,
      changeIds: [],
      question: null,
      instruction: "Always make sure the b-roll suggestions cover a large portion of the part that I am talking about, even when it wraps past two lines.",
      context: { version: project.head! },
    };
    const queuedTask = {
      ...baseTask,
      id: "task_queued_beta",
      state: "queued" as const,
      createdAt: now,
      startedAt: undefined,
      finishedAt: undefined,
      summary: null,
      changeIds: [],
      question: null,
      instruction: "Also add subtle punch-ins whenever a key stat appears on screen and tighten any dead air around those transitions.",
      context: { version: project.head! },
    };
    const data: ProjectData = {
      id: PRJ,
      project,
      timeline: db.timelines[project.head!]!,
      media: project.media,
      changes: db.changes,
      notes: db.notes,
      renders: db.renders,
      tasks: [...db.tasks.filter(t => t.state !== "waiting_for_user"), answeredTask, queuedTask],
      taskEvents: {
        ...db.taskEvents,
        task_answered_beta: [
          { id: "ev_q_beta", taskId: "task_answered_beta", at: now, type: "question", text: "How much coverage?" },
          { id: "ev_a_beta", taskId: "task_answered_beta", at: now, type: "answer", text: "Cover at least two thirds of each spoken passage so the visual stays anchored to the story." },
        ],
      },
      versions: db.versions[PRJ]!,
      fullRenderKeys: { context: fullRenderContext(project), preview: db.renders.find(r => r.kind === "full")!.key, delivery: "current-delivery" },
    };
    useUiStore.setState({ ...oldUi, newLayout: true }, true);
    useProjectStore.setState({ current: data, status: "ready", load: vi.fn(), refreshHead: vi.fn(), loadTaskEvents: vi.fn().mockResolvedValue(undefined) });
    vi.spyOn(api, "renders").mockResolvedValue({ renders: [] });
    vi.spyOn(api, "preparePlayback").mockResolvedValue(undefined);
    vi.spyOn(api, "cutPlaybackFile").mockRejectedValue(new Error("Still streaming"));
    vi.spyOn(api, "sourceCaches").mockResolvedValue({ caches: [] });
    vi.spyOn(api, "recordEditReview").mockResolvedValue(undefined);
    vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings, transcriptionAvailable: true });
    vi.spyOn(api, "skills").mockResolvedValue({ skills: [] });
    vi.spyOn(api, "waveform").mockImplementation(async (mediaId, from, to) => ({ mediaId, from, to, peaks: [0.2, 0.8] }));
    vi.spyOn(api, "cutReview").mockResolvedValue({ review: null });
    vi.spyOn(api, "retakes").mockResolvedValue({ groups: [] } as never);
    vi.spyOn(api, "threadEdits").mockResolvedValue({ version: project.head!, edits: [] });

    const { readFileSync } = await import("node:fs");
    const css = [
      readFileSync(`${import.meta.dirname}/../../simple.css`, "utf8"),
      readFileSync(`${import.meta.dirname}/../../pages/simple/beta/beta.css`, "utf8"),
    ].join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
    const foldsAt = (el: Element) => {
      let best: { lines: number | undefined; weight: number } | undefined;
      for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const match = /-webkit-line-clamp:\s*(\d+|unset|none)/.exec(body!);
        if (!match) continue;
        const lines = /^\d+$/.test(match[1]!) ? Number(match[1]) : undefined;
        for (const selector of selectors!.split(",").map(part => part.trim())) {
          let matches = false;
          try { matches = el.matches(selector); } catch { /* Ignore selectors happy-dom cannot match. */ }
          const weight = (selector.match(/[.#[:]/g) ?? []).length;
          if (matches && (!best || weight >= best.weight)) best = { lines, weight };
        }
      }
      return best?.lines;
    };

    await act(async () => root.render(<MemoryRouter><SimpleWorkspace /></MemoryRouter>));
    await act(async () => {});

    // Both Scarlet reply shapes in the beta chat (.req-say.said and .simple-msg.from-scarlet .said) clamp at 3 lines.
    const scarletClosing = container.querySelector<HTMLElement>(".simple-msg.from-scarlet .said")!;
    const scarletReq = container.querySelector<HTMLElement>(".req-say.said:not(.is-yours)")!;
    expect(scarletClosing).not.toBeNull();
    expect(scarletReq).not.toBeNull();
    expect([foldsAt(scarletClosing), foldsAt(scarletReq)]).toEqual([3, 3]);

    // Every editor text bubble shape in the beta layout shows its full text without clamping (finished, live, collapsed, loose, answer, and queued).
    const requestBubbles = [...container.querySelectorAll<HTMLElement>(".unit-msg .unit-bubble > p")];
    expect(requestBubbles.length).toBeGreaterThan(0);
    for (const bubble of requestBubbles) expect(foldsAt(bubble)).toBeUndefined();
    const firstUnit = container.querySelector<HTMLElement>(".unit")!;
    firstUnit.classList.add("is-collapsed");
    expect(foldsAt(firstUnit.querySelector(".unit-bubble > p")!)).toBeUndefined();
    firstUnit.classList.remove("is-collapsed");
    const looseBubble = container.querySelector<HTMLElement>(".simple-turn > .simple-msg.from-you p")!;
    expect(looseBubble).not.toBeNull();
    expect(foldsAt(looseBubble)).toBeUndefined();
    const answerBubble = container.querySelector<HTMLElement>(".req-say.is-yours")!;
    expect(answerBubble).not.toBeNull();
    expect(foldsAt(answerBubble)).toBeUndefined();
    const queueBubble = container.querySelector<HTMLElement>(".queue-bubble")!;
    expect(queueBubble).not.toBeNull();
    expect(foldsAt(queueBubble)).toBeUndefined();

    // Turning off the beta layout leaves Scarlet's replies and legacy editor bands at their legacy clamp.
    await act(async () => useUiStore.getState().setNewLayout(false));
    await act(async () => {});
    const legacyReply = container.querySelector<HTMLElement>(".simple-msg.from-scarlet .said, .req-say.said:not(.is-yours)")!;
    expect(foldsAt(legacyReply)).toBe(2);
    const legacyUser = container.querySelector<HTMLElement>(".unit > .unit-msg p")!;
    expect(foldsAt(legacyUser)).toBe(2);
    const legacyUnit = legacyUser.closest<HTMLElement>(".unit")!;
    legacyUnit.classList.add("is-collapsed");
    expect(foldsAt(legacyUser)).toBe(1);
    legacyUnit.classList.remove("is-collapsed");
  });

  it("omits the fold arrow in the beta layout and anchors finished token usage stats to the message bubble instead of the top-left corner", async () => {
    const db = buildDb(true);
    const project = db.projects.find(p => p.id === PRJ)!;
    const doneTask = db.tasks.find(t => t.id === "task_chat_direct")!;
    // Even if a request was collapsed in the default layout, the beta layout renders no fold arrow and keeps turns open.
    localStorage.setItem(`scarlet.collapsedRequests.v1:${PRJ}`, JSON.stringify([doneTask.id]));
    const data: ProjectData = {
      id: PRJ,
      project,
      timeline: db.timelines[project.head!]!,
      media: project.media,
      changes: db.changes,
      notes: db.notes,
      renders: db.renders,
      tasks: db.tasks.filter(t => t.state !== "waiting_for_user"),
      taskEvents: db.taskEvents,
      taskUsage: {
        [doneTask.id]: {
          inputTokens: 12000,
          outputTokens: 1800,
          cacheReadTokens: 34000,
          cacheWriteTokens: 400,
          totalTokens: 48200,
          reasoningTokens: 0,
          estimatedApiCostUsd: 0.14,
          runs: 1,
          firstAt: null,
          lastAt: null,
          models: ["claude-opus-4-5"],
        },
      },
      versions: db.versions[PRJ]!,
      fullRenderKeys: { context: fullRenderContext(project), preview: db.renders.find(r => r.kind === "full")!.key, delivery: "current-delivery" },
    };
    useUiStore.setState({ ...oldUi, newLayout: true, showRunTokens: true }, true);
    useProjectStore.setState({ current: data, status: "ready", load: vi.fn(), refreshHead: vi.fn(), loadTaskEvents: vi.fn().mockResolvedValue(undefined) });
    vi.spyOn(api, "renders").mockResolvedValue({ renders: [] });
    vi.spyOn(api, "preparePlayback").mockResolvedValue(undefined);
    vi.spyOn(api, "cutPlaybackFile").mockRejectedValue(new Error("Still streaming"));
    vi.spyOn(api, "sourceCaches").mockResolvedValue({ caches: [] });
    vi.spyOn(api, "recordEditReview").mockResolvedValue(undefined);
    vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings, transcriptionAvailable: true });
    vi.spyOn(api, "skills").mockResolvedValue({ skills: [] });
    vi.spyOn(api, "waveform").mockImplementation(async (mediaId, from, to) => ({ mediaId, from, to, peaks: [0.2, 0.8] }));
    vi.spyOn(api, "cutReview").mockResolvedValue({ review: null });
    vi.spyOn(api, "retakes").mockResolvedValue({ groups: [] } as never);
    vi.spyOn(api, "threadEdits").mockResolvedValue({ version: project.head!, edits: [] });

    await act(async () => root.render(<MemoryRouter><SimpleWorkspace /></MemoryRouter>));
    await act(async () => {});

    // No fold arrows and no collapsed turns in the beta layout.
    expect(container.querySelectorAll("#simple-chat .unit-fold")).toHaveLength(0);
    expect(container.querySelectorAll("#simple-chat .unit.is-collapsed")).toHaveLength(0);

    // Quiet metrics sit inside .unit-bubble (not inside display:none .unit-meta) so hover opens and anchors to the bubble.
    const unit = container.querySelector<HTMLElement>(`.unit[data-run="${doneTask.id}"]`)!;
    const msg = unit.querySelector<HTMLElement>(":scope > .unit-msg")!;
    const bubble = msg.querySelector<HTMLElement>(".unit-bubble")!;
    const quietBtn = bubble.querySelector<HTMLButtonElement>(".run-tokens.is-quiet")!;
    expect(quietBtn).not.toBeNull();
    expect(msg.querySelector(".unit-meta .run-tokens.is-quiet")).toBeNull();

    vi.spyOn(quietBtn, "getBoundingClientRect").mockReturnValue({
      top: 320, bottom: 370, left: 421, right: 421, width: 0, height: 50, x: 421, y: 320, toJSON: () => ({}),
    } as DOMRect);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // Hovering empty space on .unit-msg outside the bubble does not open the stats popover.
      await act(async () => {
        msg.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
        vi.advanceTimersByTime(450);
      });
      expect(document.querySelector(".tokens-tip")).toBeNull();

      // Resting on the bubble opens the stats popover positioned above the bubble, not at (8px, 8px).
      await act(async () => {
        bubble.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
        vi.advanceTimersByTime(450);
      });
      const tip = document.querySelector<HTMLElement>(".tokens-tip")!;
      expect(tip).not.toBeNull();
      expect(tip.textContent).toContain("48,200");
      expect(parseFloat(tip.style.top)).toBeGreaterThan(200);
      expect(parseFloat(tip.style.left)).toBeGreaterThan(200);

      await act(async () => {
        bubble.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
      });
      expect(document.querySelector(".tokens-tip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }

    // Switching back to the default layout keeps its fold arrow intact.
    await act(async () => useUiStore.getState().setNewLayout(false));
    await act(async () => {});
    expect(container.querySelector("#simple-chat .unit-fold")).not.toBeNull();
  });

  it("unifies lists across requests by video time and combines cross-request edits touching the same graphic clip", async () => {
    const db = buildDb();
    const project = db.projects.find(p => p.id === PRJ)!;
    const baseTimeline = structuredClone(db.timelines[project.head!]!);
    baseTimeline.tracks.push({
      ...makeTrack("video", "Graphics", "v2"),
      clips: [
        makeMediaClip("gfx_opus", 0, 5, 18, { id: "model_intro_opus", label: "Opus 5.5 title" }),
        makeMediaClip("gfx_haiku", 0, 3, 119, { id: "model_intro_haiku", label: "Haiku 5.5 title" }),
      ],
    });
    const baseApproved = db.changes.find(c => c.state === "approved") ?? db.changes[0]!;
    const addChange = {
      ...baseApproved,
      id: "chg_add_gfx",
      state: "approved" as const,
      taskId: "task_add_gfx",
      appliedVersion: project.head!,
      appliedReview: undefined,
      approvedSpots: undefined,
      cutChoices: undefined,
      noteIds: [],
      createdAt: "2026-11-24T10:00:00.000Z",
      description: "Added model titles.",
      ops: [
        { op: "addClip", trackId: "v2", clip: baseTimeline.tracks.at(-1)!.clips[0]! },
        { op: "addClip", trackId: "v2", clip: baseTimeline.tracks.at(-1)!.clips[1]! },
      ],
    };
    const moveChange = {
      ...baseApproved,
      id: "chg_move_gfx",
      state: "approved" as const,
      taskId: "task_move_gfx",
      appliedVersion: project.head!,
      appliedReview: undefined,
      approvedSpots: undefined,
      cutChoices: undefined,
      noteIds: [],
      createdAt: "2026-11-24T10:05:00.000Z",
      description: "Moved Opus title and added Fable title.",
      ops: [
        { op: "updateClip", clipId: "model_intro_opus", patch: { transform: { x: -0.56, y: 0.29, scale: 1 } } },
      ],
    };
    const addTask = Task.parse({
      id: "task_add_gfx", projectId: PRJ, kind: "edit", agent: "claude",
      instruction: "Add titles", state: "done", createdBy: { type: "human", name: "Editor" },
      changeIds: [addChange.id], createdAt: "2026-11-24T10:00:00.000Z",
    });
    const moveTask = Task.parse({
      id: "task_move_gfx", projectId: PRJ, kind: "edit", agent: "claude",
      instruction: "Move the Opus title to the bottom left", state: "done", createdBy: { type: "human", name: "Editor" },
      changeIds: [moveChange.id], createdAt: "2026-11-24T10:05:00.000Z",
    });
    const changes = [addChange, moveChange];
    const tasks = [addTask, moveTask];
    const threads = buildThreads({ changes, tasks, notes: [] });
    const addThread = threads.find(t => t.changes.some(c => c.id === addChange.id))!;
    const moveThread = threads.find(t => t.changes.some(c => c.id === moveChange.id))!;
    const data: ProjectData = {
      id: PRJ,
      project,
      timeline: baseTimeline,
      media: [...project.media, { id: "gfx_opus", name: "Opus", path: "/opus.mov", kind: "graphic", duration: 5 } as never],
      changes,
      notes: [],
      renders: db.renders,
      tasks,
      taskEvents: {},
      versions: db.versions[PRJ]!,
      fullRenderKeys: { context: fullRenderContext(project), preview: db.renders.find(r => r.kind === "full")!.key, delivery: "current-delivery" },
    };
    useUiStore.setState({ ...oldUi, newLayout: true }, true);
    useProjectStore.setState({ current: data, status: "ready", load: vi.fn(), refreshHead: vi.fn(), loadTaskEvents: vi.fn().mockResolvedValue(undefined) });
    vi.spyOn(api, "renders").mockResolvedValue({ renders: [] });
    vi.spyOn(api, "preparePlayback").mockResolvedValue(undefined);
    vi.spyOn(api, "cutPlaybackFile").mockRejectedValue(new Error("Still streaming"));
    vi.spyOn(api, "sourceCaches").mockResolvedValue({ caches: [] });
    vi.spyOn(api, "recordEditReview").mockResolvedValue(undefined);
    vi.spyOn(api, "summarizeBatches").mockResolvedValue({ summaries: {}, pending: [] });
    const keepSpy = vi.spyOn(api, "keepEdits").mockResolvedValue(undefined);
    const unkeepSpy = vi.spyOn(api, "unkeepEdits").mockResolvedValue(undefined as never);
    vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings, transcriptionAvailable: true });
    vi.spyOn(api, "skills").mockResolvedValue({ skills: [] });
    vi.spyOn(api, "waveform").mockImplementation(async (mediaId, from, to) => ({ mediaId, from, to, peaks: [0.2, 0.8] }));
    vi.spyOn(api, "cutReview").mockResolvedValue({ review: null });
    vi.spyOn(api, "retakes").mockResolvedValue({ groups: [] } as never);
    vi.spyOn(api, "threadEdits").mockImplementation(async (_projectId, threadId) => ({
      version: project.head!,
      edits: threadId === addThread.id ? [
        { changeId: addChange.id, spot: 0, label: "Opus 5.5 title", range: { start: 18, end: 21 }, kind: "graphic", previous: [] },
        { changeId: addChange.id, spot: 1, label: "Haiku 5.5 title", range: { start: 119, end: 122 }, kind: "graphic", previous: [] },
      ] : threadId === moveThread.id ? [
        { changeId: moveChange.id, spot: 0, label: "Opus 5.5 title", summary: "Moved the Opus 5.5 title to the bottom left.", reason: "Moved to bottom left.", range: { start: 18, end: 23 }, kind: "graphic", previous: [] },
        { changeId: moveChange.id, spot: 1, label: "Fable 5.2 title", range: { start: 62, end: 65 }, kind: "graphic", previous: [] },
      ] : [],
    }));

    await act(async () => root.render(<MemoryRouter><SimpleWorkspace /></MemoryRouter>));
    await act(async () => {});

    // One unified <ol> inside Safe edits, ordered newest request first, combining add+move on Opus AND collapsing
    // moveThread's 2 graphics (Opus + Fable) into one "2 Graphics" batch row while addThread's Haiku stays its own row.
    const lowBody = container.querySelector<HTMLElement>('.review-low-body[aria-label="Safe edits"]')!;
    expect(lowBody.querySelectorAll("ol")).toHaveLength(1);
    const lowRows = [...lowBody.querySelectorAll<HTMLButtonElement>("ol > li > button")];
    expect(lowRows.map(r => [
      r.querySelector(".edit-row-time")?.textContent,
      r.querySelector(".simple-pass-words")?.textContent,
      r.dataset.batchCount ?? null,
      r.querySelector(".simple-edit-value")?.textContent,
    ])).toEqual([
      ["0:18", "2 Graphics: Opus 5.5 title, Fable 5.2 title", "2", "Graphic"],
      ["1:59", "Haiku 5.5 title", null, "Graphic"],
    ]);
    expect(container.querySelector(".review-rail-head .review-rail-total")?.textContent).toBe("3");
    expect(container.querySelector(".review-rail-head .review-head-keep")).toBeNull();
    expect(container.querySelector(".review-tier-sep.is-first .review-tier-label")?.textContent).toBe("Safe edits (3)");
    expect(container.querySelector(".review-tier-sep .review-head-keep")?.textContent).toBe("Keep 3 safe edits");

    // Clicking the "2 Graphics" batch row opens the card with a 1 of 2 stepper and "Keep all 2", keeping all underlying thread edits together.
    await act(async () => lowRows[0]!.click());
    await act(async () => {});
    expect(container.querySelector(".edit-card-step-count")?.textContent).toBe("1 of 2");
    const keepBtn = [...container.querySelectorAll<HTMLButtonElement>(".edit-card button")].find(b => b.textContent?.trim() === "Keep all 2")!;
    expect(keepBtn).toBeTruthy();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await act(async () => keepBtn.click());
      await act(async () => {});
      expect(keepSpy).toHaveBeenCalledTimes(2);
      expect(container.querySelector(".review-rail-head .review-rail-total")?.textContent).toBe("1");
      const doneHead = [...container.querySelectorAll<HTMLButtonElement>(".review-sec")].find(b => b.textContent?.includes("Done"))!;
      // Lingers in Safe edits as Kept before moving cleanly to Done.
      expect(doneHead.textContent).toContain("0");
      await act(async () => { vi.advanceTimersByTime(LINGER_MS + LINGER_FADE_MS); });
      expect(doneHead.textContent).toContain("2");
    } finally {
      vi.useRealTimers();
    }

    // ⌘Z undoes BOTH threads' Keep together so the combined batch returns cleanly to Safe edits.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    expect(unkeepSpy).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".review-rail-head .review-rail-total")?.textContent).toBe("3");
  });

  it("groups repeated safe and kept Done edits inline with +N, lights all batch marks on the timeline, steps via card/hotkeys, and unkeeps Done batches together", async () => {
    const db = buildDb();
    const project = db.projects.find(p => p.id === PRJ)!;
    const baseTimeline = structuredClone(db.timelines[project.head!]!);
    const leadClip = baseTimeline.tracks[0]!.clips[0]!;
    if (leadClip.kind === "media") leadClip.sourceOut = leadClip.sourceIn + 180;
    const baseApproved = db.changes.find(c => c.state === "approved") ?? db.changes[0]!;
    const batchChange = {
      ...baseApproved,
      id: "chg_batch_gfx",
      state: "approved" as const,
      taskId: "task_batch_gfx",
      appliedVersion: project.head!,
      appliedReview: undefined,
      approvedSpots: undefined,
      cutChoices: undefined,
      noteIds: [],
      createdAt: "2026-11-24T10:00:00.000Z",
      description: "Added model titles and audio cleanups.",
      ops: [],
    };
    const batchTask = Task.parse({
      id: "task_batch_gfx", projectId: PRJ, kind: "edit", agent: "claude",
      instruction: "Add titles for every model", state: "done", createdBy: { type: "human", name: "Editor" },
      changeIds: [batchChange.id], createdAt: "2026-11-24T10:00:00.000Z",
    });
    const threads = buildThreads({ changes: [batchChange], tasks: [batchTask], notes: [] });
    const batchThread = threads[0]!;
    const data: ProjectData = {
      id: PRJ,
      project,
      timeline: baseTimeline,
      media: project.media,
      changes: [batchChange],
      notes: [],
      renders: db.renders,
      tasks: [batchTask],
      taskEvents: {},
      versions: db.versions[PRJ]!,
      fullRenderKeys: { context: fullRenderContext(project), preview: db.renders.find(r => r.kind === "full")!.key, delivery: "current-delivery" },
    };
    useUiStore.setState({ ...oldUi, newLayout: true }, true);
    useProjectStore.setState({ current: data, status: "ready", load: vi.fn(), refreshHead: vi.fn(), loadTaskEvents: vi.fn().mockResolvedValue(undefined) });
    vi.spyOn(api, "renders").mockResolvedValue({ renders: [] });
    vi.spyOn(api, "preparePlayback").mockResolvedValue(undefined);
    vi.spyOn(api, "cutPlaybackFile").mockRejectedValue(new Error("Still streaming"));
    vi.spyOn(api, "sourceCaches").mockResolvedValue({ caches: [] });
    vi.spyOn(api, "recordEditReview").mockResolvedValue(undefined);
    vi.spyOn(api, "summarizeBatches").mockResolvedValue({ summaries: {}, pending: [] });
    vi.spyOn(api, "keepEdits").mockResolvedValue(undefined);
    const unkeepSpy = vi.spyOn(api, "unkeepEdits").mockResolvedValue(undefined as never);
    vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings, transcriptionAvailable: true });
    vi.spyOn(api, "skills").mockResolvedValue({ skills: [] });
    vi.spyOn(api, "waveform").mockImplementation(async (mediaId, from, to) => ({ mediaId, from, to, peaks: [0.2, 0.8] }));
    vi.spyOn(api, "cutReview").mockResolvedValue({ review: null });
    vi.spyOn(api, "retakes").mockResolvedValue({ groups: [] } as never);
    vi.spyOn(api, "threadEdits").mockImplementation(async (_projectId, threadId) => ({
      version: project.head!,
      edits: threadId === batchThread.id ? [
        { changeId: batchChange.id, spot: 0, label: "Flagged Opus title", range: { start: 5, end: 8 }, kind: "graphic", previous: [], check: "Check framing." },
        { changeId: batchChange.id, spot: 1, label: "Flagged Fable title", range: { start: 12, end: 15 }, kind: "graphic", previous: [], check: "Check overlap." },
        { changeId: batchChange.id, spot: 2, label: "Haiku 5.5 title", range: { start: 25, end: 28 }, kind: "graphic", previous: [] },
        { changeId: batchChange.id, spot: 3, label: "Sonnet 5.5 title", range: { start: 60, end: 63 }, kind: "graphic", previous: [] },
        { changeId: batchChange.id, spot: 4, label: "Hydrogen title", range: { start: 100, end: 103 }, kind: "graphic", previous: [] },
        { changeId: batchChange.id, spot: 5, label: "Rejected Neon title", range: { start: 130, end: 133 }, kind: "graphic", previous: [], rejected: true },
      ] : [],
    }));

    await act(async () => root.render(<MemoryRouter><SimpleWorkspace /></MemoryRouter>));
    await act(async () => {});

    // Needs you stays individual (2 rows, ungrouped); Safe edits (3 graphics) collapses to 1 "3 Graphics" row.
    const needRows = [...container.querySelectorAll<HTMLButtonElement>('.review-rail-list ol[aria-label="Edits that need you"] > li > button')];
    expect(needRows).toHaveLength(2);
    expect(needRows.every(r => !r.dataset.batchCount)).toBe(true);

    const safeRows = [...container.querySelectorAll<HTMLButtonElement>('.review-low-body[aria-label="Safe edits"] ol > li > button')];
    expect(safeRows).toHaveLength(1);
    expect(safeRows[0]!.querySelector(".simple-pass-words")?.textContent).toBe("3 Graphics: Haiku 5.5 title, Sonnet 5.5 title, Hydrogen title");
    expect(safeRows[0]!.dataset.batchCount).toBe("3");
    expect(safeRows[0]!.querySelector(".edit-batch-plus")).toBeNull();
    expect(safeRows[0]!.querySelector(".simple-edit-value")?.textContent).toBe("Graphic");
    expect(container.querySelector(".review-rail-head .review-head-keep")).toBeNull();
    expect(container.querySelector(".review-tier-sep .review-head-keep")?.textContent).toBe("Keep 3 safe edits");

    // Click the "3 Graphics" row: opens card with stepper 1 of 3, Keep all 3, Reject just this edit, and shows all 3 batch marks on the timeline.
    await act(async () => safeRows[0]!.click());
    await act(async () => {});
    expect(container.querySelector(".edit-card-step-count")?.textContent).toBe("1 of 3");
    const keepAllBtn = [...container.querySelectorAll<HTMLButtonElement>(".edit-card button")].find(b => b.textContent?.trim() === "Keep all 3")!;
    expect(keepAllBtn).toBeTruthy();
    const rejectBtn = container.querySelector<HTMLButtonElement>(".edit-card-reject")!;
    expect(rejectBtn.getAttribute("aria-label")).toBe("Reject just this edit");
    expect(container.querySelectorAll(".simple-timeline-mark").length).toBeGreaterThanOrEqual(3);

    // Step forward with ] hotkey -> 2 of 3, and composer aim row follows edit #2.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    expect(container.querySelector(".edit-card-step-count")?.textContent).toBe("2 of 3");
    expect(container.querySelector(".composer-aim-row")?.textContent).toContain("Sonnet 5.5 title");

    // Click Keep all 3 -> the "3 Graphics" batch lingers in place marked Kept, then moves to Done as one collapsed Kept row beside the individual Rejected row.
    const doneHead = [...container.querySelectorAll<HTMLButtonElement>(".review-sec")].find(b => b.textContent?.includes("Done"))!;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await act(async () => keepAllBtn.click());
      await act(async () => {});
      const lingeringBatch = container.querySelector<HTMLButtonElement>('.review-low-body[aria-label="Safe edits"] ol > li > button')!;
      expect(lingeringBatch.dataset.batchCount).toBe("3");
      expect(lingeringBatch.querySelector(".simple-edit-value")?.textContent).toBe("Kept");
      expect(doneHead.textContent).toContain("1");
      await act(async () => { vi.advanceTimersByTime(LINGER_MS + LINGER_FADE_MS); });
      expect(doneHead.textContent).toContain("4");
    } finally {
      vi.useRealTimers();
    }
    await act(async () => doneHead.click());
    await act(async () => {});

    const doneRows = [...container.querySelectorAll<HTMLButtonElement>('.review-sec-body[aria-label="Done"] ol > li > button')];
    expect(doneRows.map(r => [
      r.querySelector(".simple-pass-words")?.textContent,
      r.dataset.batchCount ?? null,
      r.querySelector(".simple-edit-value")?.textContent,
    ])).toEqual([
      ["3 Graphics: Haiku 5.5 title, Sonnet 5.5 title, Hydrogen title", "3", "Kept"],
      ["Rejected Neon title", null, "Rejected"],
    ]);

    // Clicking the Done "3 Graphics" row opens the stepped card (1 of 3) with "Keep" (not "Keep all 3").
    await act(async () => doneRows[0]!.click());
    await act(async () => {});
    expect(container.querySelector(".edit-card-step-count")?.textContent).toBe("1 of 3");
    expect([...container.querySelectorAll<HTMLButtonElement>(".edit-card button")].some(b => b.textContent?.trim() === "Keep all 3")).toBe(false);
    expect([...container.querySelectorAll<HTMLButtonElement>(".edit-card button")].some(b => b.textContent?.trim() === "Keep")).toBe(true);

    // Clicking Unkeep on the Done "3 Graphics" row unkeeps all 3 at once and restores the "3 Graphics" row to Safe edits.
    const unkeepBtn = container.querySelector<HTMLButtonElement>('.review-sec-body[aria-label="Done"] .simple-unkeep')!;
    expect(unkeepBtn.getAttribute("title")).toBe("Unkeep all 3");
    expect(unkeepBtn.getAttribute("aria-label")).toBe("Unkeep 3 Graphics: Haiku 5.5 title, Sonnet 5.5 title, Hydrogen title");
    await act(async () => unkeepBtn.click());
    await act(async () => {});
    expect(unkeepSpy).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.review-low-body[aria-label="Safe edits"] .simple-pass-words')?.textContent).toBe("3 Graphics: Haiku 5.5 title, Sonnet 5.5 title, Hydrogen title");
    expect(container.querySelector(".review-rail-head .review-head-keep")).toBeNull();
    expect(container.querySelector(".review-tier-sep .review-head-keep")?.textContent).toBe("Keep 3 safe edits");
  });

  it("advances straight to the next edit in line when clicking Reject in the beta layout, including inside grouped batches, and closes on the last", async () => {
    const db = buildDb();
    const project = db.projects.find(p => p.id === PRJ)!;
    const baseTimeline = structuredClone(db.timelines[project.head!]!);
    const leadClip = baseTimeline.tracks[0]!.clips[0]!;
    if (leadClip.kind === "media") leadClip.sourceOut = leadClip.sourceIn + 180;
    const baseApproved = db.changes.find(c => c.state === "approved") ?? db.changes[0]!;
    const batchChange = {
      ...baseApproved,
      id: "chg_batch_reject",
      state: "approved" as const,
      taskId: "task_batch_reject",
      appliedVersion: project.head!,
      appliedReview: undefined,
      approvedSpots: undefined,
      cutChoices: undefined,
      noteIds: [],
      createdAt: "2026-11-24T10:00:00.000Z",
      description: "Added model titles.",
      ops: [],
    };
    const batchTask = Task.parse({
      id: "task_batch_reject", projectId: PRJ, kind: "edit", agent: "claude",
      instruction: "Add titles for every model", state: "done", createdBy: { type: "human", name: "Editor" },
      changeIds: [batchChange.id], createdAt: "2026-11-24T10:00:00.000Z",
    });
    const threads = buildThreads({ changes: [batchChange], tasks: [batchTask], notes: [] });
    const batchThread = threads[0]!;
    let data: ProjectData = {
      id: PRJ,
      project,
      timeline: baseTimeline,
      media: project.media,
      changes: [batchChange],
      notes: [],
      renders: db.renders,
      tasks: [batchTask],
      taskEvents: {},
      versions: db.versions[PRJ]!,
      fullRenderKeys: { context: fullRenderContext(project), preview: db.renders.find(r => r.kind === "full")!.key, delivery: "current-delivery" },
    };
    const rejectedSpots = new Set<number>();
    let ver = 0;
    const rejectEdits = vi.fn(async (_threadId: string, _head: string, edits: { spot: number }[]) => {
      for (const e of edits) rejectedSpots.add(e.spot);
      const nextVer = `ver_beta_reject_${++ver}`;
      data = { ...data, project: { ...data.project, head: nextVer }, timeline: data.timeline && { ...data.timeline, version: nextVer } };
      useProjectStore.setState({ current: data });
      return nextVer;
    });
    useUiStore.setState({ ...oldUi, newLayout: true }, true);
    useProjectStore.setState({
      current: data, status: "ready", load: vi.fn(), refreshHead: vi.fn(), loadTaskEvents: vi.fn().mockResolvedValue(undefined),
      rejectEdits: rejectEdits as never, createTask: vi.fn(),
    });
    vi.spyOn(api, "renders").mockResolvedValue({ renders: [] });
    vi.spyOn(api, "preparePlayback").mockResolvedValue(undefined);
    vi.spyOn(api, "cutPlaybackFile").mockRejectedValue(new Error("Still streaming"));
    vi.spyOn(api, "sourceCaches").mockResolvedValue({ caches: [] });
    vi.spyOn(api, "recordEditReview").mockResolvedValue(undefined);
    vi.spyOn(api, "summarizeBatches").mockResolvedValue({ summaries: {}, pending: [] });
    vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings, transcriptionAvailable: true });
    vi.spyOn(api, "skills").mockResolvedValue({ skills: [] });
    vi.spyOn(api, "waveform").mockImplementation(async (mediaId, from, to) => ({ mediaId, from, to, peaks: [0.2, 0.8] }));
    vi.spyOn(api, "cutReview").mockResolvedValue({ review: null });
    vi.spyOn(api, "retakes").mockResolvedValue({ groups: [] } as never);
    vi.spyOn(api, "timeline").mockImplementation(async (_id, version = "head") => ({ timeline: { ...baseTimeline, version } }));
    vi.spyOn(api, "threadEdits").mockImplementation(async (_projectId, threadId) => ({
      version: data.project.head!,
      edits: threadId !== batchThread.id ? [] : [
        { changeId: batchChange.id, spot: 0, label: "Flagged Opus title", range: { start: 5, end: 8 }, kind: "graphic" as const, previous: [], check: "Check framing.", ...(rejectedSpots.has(0) && { rejected: true as const }) },
        { changeId: batchChange.id, spot: 1, label: "Flagged Fable title", range: { start: 12, end: 15 }, kind: "graphic" as const, previous: [], check: "Check overlap.", ...(rejectedSpots.has(1) && { rejected: true as const }) },
        { changeId: batchChange.id, spot: 2, label: "Haiku 5.5 title", range: { start: 25, end: 28 }, kind: "graphic" as const, previous: [], ...(rejectedSpots.has(2) && { rejected: true as const }) },
        { changeId: batchChange.id, spot: 3, label: "Sonnet 5.5 title", range: { start: 60, end: 63 }, kind: "graphic" as const, previous: [], ...(rejectedSpots.has(3) && { rejected: true as const }) },
        { changeId: batchChange.id, spot: 4, label: "Hydrogen title", range: { start: 100, end: 103 }, kind: "graphic" as const, previous: [], ...(rejectedSpots.has(4) && { rejected: true as const }) },
      ],
    }));

    await act(async () => root.render(<MemoryRouter><SimpleWorkspace /></MemoryRouter>));
    await act(async () => {});

    const aimText = () => container.querySelector(".composer-aim-row")?.textContent ?? "";
    const rejectBtn = () => container.querySelector<HTMLButtonElement>(".edit-card-reject")!;
    const rejectedCardEl = () => container.querySelector('.edit-card[aria-label="Rejected edit"]');

    // Open the first flagged edit and reject it -> moves straight to the second flagged edit.
    const firstNeed = container.querySelector<HTMLButtonElement>('.review-rail-list ol[aria-label="Edits that need you"] > li > button')!;
    await act(async () => firstNeed.click());
    await act(async () => {});
    expect(aimText()).toContain("Flagged Opus title");

    await act(async () => rejectBtn().click());
    await act(async () => {});
    expect([aimText().includes("Flagged Fable title"), rejectedCardEl()]).toEqual([true, null]);

    // Reject the second flagged edit -> flows straight into the safe-edit batch (1 of 3: Haiku 5.5 title).
    await act(async () => rejectBtn().click());
    await act(async () => {});
    expect([aimText().includes("Haiku 5.5 title"), container.querySelector(".edit-card-step-count")?.textContent, rejectedCardEl()]).toEqual([true, "1 of 3", null]);

    // Reject edit 1 of 3 in the batch -> advances to edit 2 ("Sonnet 5.5 title", now 1 of 2).
    await act(async () => rejectBtn().click());
    await act(async () => {});
    expect([aimText().includes("Sonnet 5.5 title"), container.querySelector(".edit-card-step-count")?.textContent, rejectedCardEl()]).toEqual([true, "1 of 2", null]);

    // Reject edit 1 of 2 -> advances to the remaining individual safe edit ("Hydrogen title").
    await act(async () => rejectBtn().click());
    await act(async () => {});
    expect([aimText().includes("Hydrogen title"), container.querySelector(".edit-card-step-count"), rejectedCardEl()]).toEqual([true, null, null]);

    // Reject the last remaining edit -> card closes cleanly.
    await act(async () => rejectBtn().click());
    await act(async () => {});
    expect([container.querySelector(".edit-card"), rejectedCardEl()]).toEqual([null, null]);
  });

  it("upgrades grouped edit rows live with AI-generated batch summaries from HTTP responses and WebSocket events", async () => {
    const db = buildDb();
    const project = db.projects.find(p => p.id === PRJ)!;
    const baseTimeline = structuredClone(db.timelines[project.head!]!);
    const baseApproved = db.changes.find(c => c.state === "approved") ?? db.changes[0]!;
    const batchChange = {
      ...baseApproved,
      id: "chg_ai_summary",
      state: "approved" as const,
      taskId: "task_ai_summary",
      appliedVersion: project.head!,
      appliedReview: undefined,
      approvedSpots: undefined,
      cutChoices: undefined,
      noteIds: [],
      createdAt: "2026-11-24T10:00:00.000Z",
      description: "Added model titles.",
      ops: [],
    };
    const batchTask = Task.parse({
      id: "task_ai_summary", projectId: PRJ, kind: "edit", agent: "claude",
      instruction: "Add titles for every model", state: "done", createdBy: { type: "human", name: "Editor" },
      changeIds: [batchChange.id], createdAt: "2026-11-24T10:00:00.000Z",
    });
    const threads = buildThreads({ changes: [batchChange], tasks: [batchTask], notes: [] });
    const batchThread = threads[0]!;
    const data: ProjectData = {
      id: PRJ,
      project,
      timeline: baseTimeline,
      media: project.media,
      changes: [batchChange],
      notes: [],
      renders: db.renders,
      tasks: [batchTask],
      taskEvents: {},
      versions: db.versions[PRJ]!,
      fullRenderKeys: { context: fullRenderContext(project), preview: db.renders.find(r => r.kind === "full")!.key, delivery: "current-delivery" },
    };
    useUiStore.setState({ ...oldUi, newLayout: true }, true);
    useProjectStore.setState({ current: data, status: "ready", load: vi.fn(), refreshHead: vi.fn(), loadTaskEvents: vi.fn().mockResolvedValue(undefined) });
    vi.spyOn(api, "renders").mockResolvedValue({ renders: [] });
    vi.spyOn(api, "preparePlayback").mockResolvedValue(undefined);
    vi.spyOn(api, "cutPlaybackFile").mockRejectedValue(new Error("Still streaming"));
    vi.spyOn(api, "sourceCaches").mockResolvedValue({ caches: [] });
    vi.spyOn(api, "recordEditReview").mockResolvedValue(undefined);
    vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings, transcriptionAvailable: true });
    vi.spyOn(api, "skills").mockResolvedValue({ skills: [] });
    vi.spyOn(api, "waveform").mockImplementation(async (mediaId, from, to) => ({ mediaId, from, to, peaks: [0.2, 0.8] }));
    vi.spyOn(api, "cutReview").mockResolvedValue({ review: null });
    vi.spyOn(api, "retakes").mockResolvedValue({ groups: [] } as never);
    let requestedKey = "";
    const sumSpy = vi.spyOn(api, "summarizeBatches").mockImplementation(async (_pid, body) => {
      requestedKey = body.batches[0]!.key;
      return { summaries: { [requestedKey]: "3 model title cards" }, pending: [] };
    });
    vi.spyOn(api, "threadEdits").mockImplementation(async (_projectId, threadId) => ({
      version: project.head!,
      edits: threadId === batchThread.id ? [
        { changeId: batchChange.id, spot: 0, label: "Haiku 5.5 title", range: { start: 2, end: 5 }, kind: "graphic", previous: [] },
        { changeId: batchChange.id, spot: 1, label: "Sonnet 5.5 title", range: { start: 6, end: 9 }, kind: "graphic", previous: [] },
        { changeId: batchChange.id, spot: 2, label: "Hydrogen title", range: { start: 10, end: 13 }, kind: "graphic", previous: [] },
      ] : [],
    }));

    await act(async () => root.render(<MemoryRouter><SimpleWorkspace /></MemoryRouter>));
    await act(async () => {});
    // Wait past the 120ms debounce so ReviewRail requests AI batch summaries.
    await act(async () => { await new Promise(r => setTimeout(r, 180)); });
    await act(async () => {});
    expect(sumSpy).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.review-low-body[aria-label="Safe edits"] .simple-pass-words')?.textContent).toBe("3 model title cards");

    // A later batch_summary.updated WebSocket event updates the title live too.
    await act(async () => {
      useProjectStore.getState().applyEvent({ type: "batch_summary.updated", projectId: PRJ, key: requestedKey, title: "Added 3 AI model titles" });
    });
    expect(container.querySelector('.review-low-body[aria-label="Safe edits"] .simple-pass-words')?.textContent).toBe("Added 3 AI model titles");
  });

  it("keeps the middle edits column visible on a newly opened project with no edits yet", async () => {
    const db = buildDb();
    const project = db.projects.find(p => p.id === PRJ)!;
    const data: ProjectData = {
      id: PRJ,
      project,
      timeline: db.timelines[project.head!]!,
      media: project.media,
      changes: [],
      notes: [],
      renders: [],
      tasks: [],
      taskEvents: {},
      versions: db.versions[PRJ]!,
      fullRenderKeys: { context: fullRenderContext(project), preview: "empty-preview", delivery: "empty-delivery" },
    };
    useUiStore.setState({ ...oldUi, newLayout: true }, true);
    useProjectStore.setState({ current: data, status: "ready", load: vi.fn(), refreshHead: vi.fn(), loadTaskEvents: vi.fn().mockResolvedValue(undefined) });
    vi.spyOn(api, "renders").mockResolvedValue({ renders: [] });
    vi.spyOn(api, "preparePlayback").mockResolvedValue(undefined);
    vi.spyOn(api, "cutPlaybackFile").mockRejectedValue(new Error("Still streaming"));
    vi.spyOn(api, "sourceCaches").mockResolvedValue({ caches: [] });
    vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings, transcriptionAvailable: true });
    vi.spyOn(api, "skills").mockResolvedValue({ skills: [] });
    vi.spyOn(api, "waveform").mockImplementation(async (mediaId, from, to) => ({ mediaId, from, to, peaks: [0.2, 0.8] }));
    vi.spyOn(api, "cutReview").mockResolvedValue({ review: null });
    vi.spyOn(api, "retakes").mockResolvedValue({ groups: [] } as never);
    vi.spyOn(api, "threadEdits").mockResolvedValue({ version: project.head!, edits: [] });

    await act(async () => root.render(<MemoryRouter><SimpleWorkspace /></MemoryRouter>));
    await act(async () => {});

    const rail = container.querySelector<HTMLElement>("#simple-review-rail")!;
    expect(rail).not.toBeNull();
    expect(rail.hidden).toBe(false);
    expect(rail.querySelector(".review-rail-head h2")?.textContent).toBe("Needs review");
    expect(rail.querySelector(".simple-review-empty")?.textContent).toBe("No edits yet.");
    expect(rail.querySelector(':scope > [role="separator"]')).not.toBeNull();
    const sections = [...rail.querySelectorAll<HTMLButtonElement>(".review-rail-foot .review-sec")];
    expect(sections.map(b => b.textContent)).toEqual(["Working0", "Done0"]);
    expect(sections.every(b => b.disabled)).toBe(true);
  });

  it("never flashes stale saved edits in the beta rail or default dock while threadEdits loads on project open", async () => {
    const db = buildDb();
    const project = db.projects.find(p => p.id === PRJ)!;
    const data: ProjectData = {
      id: PRJ,
      project,
      timeline: db.timelines[project.head!]!,
      media: project.media,
      changes: db.changes,
      notes: db.notes,
      renders: db.renders,
      tasks: db.tasks.filter(t => t.state !== "waiting_for_user"),
      taskEvents: db.taskEvents,
      versions: db.versions[PRJ]!,
      fullRenderKeys: { context: fullRenderContext(project), preview: db.renders.find(r => r.kind === "full")!.key, delivery: "current-delivery" },
    };
    vi.spyOn(api, "renders").mockResolvedValue({ renders: [] });
    vi.spyOn(api, "preparePlayback").mockResolvedValue(undefined);
    vi.spyOn(api, "cutPlaybackFile").mockRejectedValue(new Error("Still streaming"));
    vi.spyOn(api, "sourceCaches").mockResolvedValue({ caches: [] });
    vi.spyOn(api, "recordEditReview").mockResolvedValue(undefined);
    vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings, transcriptionAvailable: true });
    vi.spyOn(api, "skills").mockResolvedValue({ skills: [] });
    vi.spyOn(api, "waveform").mockImplementation(async (mediaId, from, to) => ({ mediaId, from, to, peaks: [0.2, 0.8] }));
    vi.spyOn(api, "cutReview").mockResolvedValue({ review: null });
    vi.spyOn(api, "retakes").mockResolvedValue({ groups: [] } as never);

    for (const beta of [true, false]) {
      const pending: Array<() => void> = [];
      vi.spyOn(api, "threadEdits").mockImplementation(() => new Promise(resolve => {
        pending.push(() => resolve({ version: project.head!, edits: [] }));
      }));
      useUiStore.setState({ ...oldUi, newLayout: beta }, true);
      useProjectStore.setState({ current: data, status: "ready", load: vi.fn(), refreshHead: vi.fn(), loadTaskEvents: vi.fn().mockResolvedValue(undefined) });

      await act(async () => root.render(<MemoryRouter><SimpleWorkspace /></MemoryRouter>));
      // Engine reads are still in flight: neither layout may flash raw saved edits in the list.
      expect(pending.length).toBeGreaterThan(0);
      expect(container.querySelectorAll(".review-rail-list button.simple-edit, .review-rail-list ol > li > button")).toHaveLength(0);
      expect(container.querySelectorAll(".simple-review-dock .simple-pass-list > li > button")).toHaveLength(0);

      // Once the engine responds with zero live edits, the list stays clean with zero transient rows.
      await act(async () => { pending.forEach(done => done()); });
      expect(container.querySelectorAll(".review-rail-list button.simple-edit, .review-rail-list ol > li > button")).toHaveLength(0);
      expect(container.querySelectorAll(".simple-review-dock .simple-pass-list > li > button")).toHaveLength(0);

      await act(async () => root.unmount());
      root = createRoot(container);
    }
  });

  it("keeps Working and Done headers pinned outside their scrollable bodies in the beta rail", async () => {
    const db = buildDb();
    const project = db.projects.find(p => p.id === PRJ)!;
    const change = db.changes.find(c => c.id === "chg_approved_2") ?? db.changes[0]!;
    const ownerThreadId = buildThreads({ changes: db.changes, tasks: db.tasks, notes: db.notes })
      .find(t => t.changes.some(c => c.id === change.id))!.id;
    const workingTask = Task.parse({
      id: "task_beta_working_sticky",
      projectId: PRJ,
      kind: "edit",
      agent: "claude",
      instruction: "Polish caption timing",
      state: "running",
      createdBy: { type: "human", name: "Editor" },
      changeIds: [],
      context: { changeId: change.id, editIndex: 0, threadId: ownerThreadId },
      createdAt: "2026-11-26T10:00:00.000Z",
    });
    const data: ProjectData = {
      id: PRJ,
      project,
      timeline: db.timelines[project.head!]!,
      media: project.media,
      changes: db.changes,
      notes: db.notes,
      renders: db.renders,
      tasks: [...db.tasks.filter(t => t.state !== "waiting_for_user"), workingTask],
      taskEvents: db.taskEvents,
      versions: db.versions[PRJ]!,
      fullRenderKeys: { context: fullRenderContext(project), preview: db.renders.find(r => r.kind === "full")!.key, delivery: "current-delivery" },
    };
    useUiStore.setState({ ...oldUi, newLayout: true }, true);
    useProjectStore.setState({ current: data, status: "ready", load: vi.fn(), refreshHead: vi.fn(), loadTaskEvents: vi.fn().mockResolvedValue(undefined) });
    vi.spyOn(api, "renders").mockResolvedValue({ renders: [] });
    vi.spyOn(api, "preparePlayback").mockResolvedValue(undefined);
    vi.spyOn(api, "cutPlaybackFile").mockRejectedValue(new Error("Still streaming"));
    vi.spyOn(api, "sourceCaches").mockResolvedValue({ caches: [] });
    vi.spyOn(api, "recordEditReview").mockResolvedValue(undefined);
    vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings, transcriptionAvailable: true });
    vi.spyOn(api, "skills").mockResolvedValue({ skills: [] });
    vi.spyOn(api, "waveform").mockImplementation(async (mediaId, from, to) => ({ mediaId, from, to, peaks: [0.2, 0.8] }));
    vi.spyOn(api, "cutReview").mockResolvedValue({ review: null });
    vi.spyOn(api, "retakes").mockResolvedValue({ groups: [] } as never);
    vi.spyOn(api, "threadEdits").mockImplementation(async (_projectId, threadId) => ({
      version: project.head!,
      edits: threadId === ownerThreadId ? [
        { changeId: change.id, spot: 0, label: "Polish caption timing", range: { start: 1, end: 3 }, previous: [] },
        { changeId: change.id, spot: 1, label: "Rejected outro clip", range: { start: 5, end: 8 }, previous: [], rejected: true as const },
      ] : [],
    }));

    await act(async () => root.render(<MemoryRouter><SimpleWorkspace /></MemoryRouter>));
    await act(async () => {});

    const foot = container.querySelector<HTMLElement>(".review-rail-foot")!;
    const [workingHead, doneHead] = [...foot.querySelectorAll<HTMLButtonElement>(":scope > .review-sec")];
    const [workingBody, doneBody] = [...foot.querySelectorAll<HTMLElement>(":scope > .review-sec-body")];
    expect(workingHead?.textContent).toBe("Working1");
    expect(doneHead?.textContent).toBe("Done1");
    expect(workingHead?.nextElementSibling).toBe(workingBody);
    expect(doneHead?.nextElementSibling).toBe(doneBody);
    expect(workingBody?.hidden).toBe(false);
    expect(doneBody?.hidden).toBe(true);

    // Expanding Done opens both bodies inside the non-scrolling flex column foot.
    await act(async () => doneHead!.click());
    await act(async () => {});
    expect(workingBody?.hidden).toBe(false);
    expect(doneBody?.hidden).toBe(false);

    // CSS keeps the footer non-scrolling, pins both headers (flex: none), and scrolls each section body independently.
    const { readFileSync } = await import("node:fs");
    const betaCss = readFileSync(`${import.meta.dirname}/../../pages/simple/beta/beta.css`, "utf8");
    const footRule = /\[data-new-layout\]\s+\.review-rail-foot\s*\{([^}]*)\}/.exec(betaCss)?.[1] ?? "";
    expect(footRule).toMatch(/display:\s*flex/);
    expect(footRule).toMatch(/flex-direction:\s*column/);
    expect(footRule).toMatch(/overflow:\s*hidden/);
    expect(footRule).not.toMatch(/overflow-y:\s*auto/);
    const secRule = /\[data-new-layout\]\s+\.review-sec\s*\{([^}]*)\}/.exec(betaCss)?.[1] ?? "";
    expect(secRule).toMatch(/flex:\s*none/);
    const bodyRule = /\[data-new-layout\]\s+\.review-sec-body\s*\{([^}]*)\}/.exec(betaCss)?.[1] ?? "";
    expect(bodyRule).toMatch(/overflow-y:\s*auto/);
    expect(bodyRule).toMatch(/min-height:\s*0/);
  });
});
