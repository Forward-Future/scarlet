// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fullRenderContext, Task } from "@scarlet/shared";
import { buildDb, PRJ } from "../../lib/mock/fixtures";
import { buildThreads } from "../../lib/threads";
import { api } from "../../lib/client";
import { useProjectStore, type ProjectData } from "../../stores/project";
import { useUiStore } from "../../stores/ui";
import { SimpleWorkspace } from "../../pages/SimpleWorkspace";
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

    // Flip beta toggle on: switches live to three-column layout with bubbles, question panel, and Low risk.
    await act(async () => useUiStore.getState().setNewLayout(true));
    await act(async () => {});
    expect(container.querySelector("[data-new-layout]")).not.toBeNull();
    expect(container.querySelector(".review-rail")).not.toBeNull();
    expect(container.querySelector(".review-low-head")?.textContent).toContain("Low risk");
    expect(container.querySelector(".review-low-done")?.textContent).toBe("Keep all");
    expect(container.querySelector(".composer-ask-text")?.textContent).toBe("How tight should I cut the intro?");
    expect([...container.querySelectorAll(".composer-ask-choice")].map(b => b.textContent)).toEqual(["Keep the setup", "Jump straight in"]);
    // Working and Done banners stay visible at the foot even when empty (Working above Done), chat doesn't repeat "For you N", and every row leads with its time, never a number.
    const footSections = [...container.querySelectorAll<HTMLButtonElement>(".review-rail-foot .review-sec")];
    expect(footSections.map(b => b.textContent)).toEqual(["Working0", "Done0"]);
    expect(footSections.every(b => b.disabled && b.classList.contains("is-none") && b.getAttribute("aria-expanded") === "false")).toBe(true);
    expect(container.querySelector("#simple-chat .simple-need-link")).toBeNull();
    expect(container.querySelector(".review-rail-list .edit-badge")).toBeNull();
    expect(container.querySelector(".review-rail-list .edit-row-time")?.textContent).toMatch(/^\d+:\d\d$/);
    expect(container.querySelector(".review-low-body .edit-badge")).toBeNull();
    expect(container.querySelector(".review-low-body .edit-row-time")?.textContent).toBe("0:00");
    // Generic fallback "Edit" word is omitted from row ends, and clicking a message bubble never turns it violet.
    const rowValues = [...container.querySelectorAll(".review-rail .simple-edit-value")].map(el => el.textContent?.trim());
    expect(rowValues).not.toContain("Edit");
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

  it("covers beta pass polish: kept edit moves straight to Done, low-risk auto-unfolds, working card shows Stop, paused queue drops Up next, and question names its edit", async () => {
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

    // #12: Pause/Resume lives under the timeline (not on chat bubbles).
    expect(container.querySelector("#simple-chat .unit-pause-edit")).toBeNull();
    expect(container.querySelector(".timeline-working-pause.is-resume")?.textContent).toBe("Resume");

    // #13: Clicking the Working edit ("captions") shows the slim Working card with Stop.
    const workingBtn = [...container.querySelectorAll<HTMLButtonElement>(".review-rail-foot button.simple-edit")]
      .find(b => b.textContent?.includes("captions"))!;
    expect(workingBtn).toBeTruthy();
    await act(async () => workingBtn.click());
    await act(async () => {});
    const workingCard = container.querySelector(".edit-card.is-working")!;
    expect(workingCard).not.toBeNull();
    expect(workingCard.textContent).toContain("captions");
    expect(workingCard.textContent).toContain("Scarlet is revising this");
    const stopBtn = workingCard.querySelector<HTMLButtonElement>(".working-card-btn")!;
    expect(stopBtn.textContent).toBe("Stop");
    await act(async () => stopBtn.click());
    expect(cancelSpy).toHaveBeenCalledWith("task_beta_revise");

    // #14 & #3: Fold Low risk, open the low-risk edit via Keep/click flow, confirm Low risk auto-unfolds and Keep moves straight to Done (not duplicated).
    const lowHead = container.querySelector<HTMLButtonElement>(".review-low-head")!;
    await act(async () => lowHead.click());
    expect(lowHead.getAttribute("aria-expanded")).toBe("false");
    const musicRow = [...container.querySelectorAll<HTMLButtonElement>(".review-low-body button.simple-edit")]
      .find(b => b.textContent?.includes("music bed"))!;
    await act(async () => musicRow.click());
    await act(async () => {});
    expect(lowHead.getAttribute("aria-expanded")).toBe("true");
    // Keep music bed -> moves straight to Done without lingering in Low risk.
    const keepBtn = [...container.querySelectorAll<HTMLButtonElement>(".edit-card button")]
      .find(b => b.textContent?.trim() === "Keep")!;
    await act(async () => keepBtn.click());
    await act(async () => {});
    expect(container.querySelector(".review-low")?.hasAttribute("hidden")).toBe(true);
    const doneHead = [...container.querySelectorAll<HTMLButtonElement>(".review-sec")]
      .find(b => b.textContent?.includes("Done"))!;
    expect(doneHead.textContent).toContain("1");
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

    // Keep the flagged edit so Done has 1 edit while Working stays at 0.
    const row = container.querySelector<HTMLButtonElement>(".review-rail-list button.simple-edit")!;
    await act(async () => row.click());
    await act(async () => {});
    const keepBtn = [...container.querySelectorAll<HTMLButtonElement>(".edit-card button")]
      .find(b => b.textContent?.trim() === "Keep")!;
    await act(async () => keepBtn.click());
    await act(async () => {});

    const sections = [...container.querySelectorAll<HTMLButtonElement>(".review-rail-foot .review-sec")];
    expect(sections.map(b => b.textContent)).toEqual(["Working0", "Done1"]);
    expect(sections[0]!.disabled).toBe(true);
    expect(sections[0]!.classList.contains("is-none")).toBe(true);
    expect(sections[0]!.getAttribute("aria-expanded")).toBe("false");
    expect(sections[1]!.disabled).toBe(false);
    expect(sections[1]!.classList.contains("is-none")).toBe(false);
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
        { changeId: db.changes[0]!.id, spot: 0, label: longLabel, range: { start: 0, end: 2 }, previous: [], check: "Needs graphic from Alex." },
        { changeId: db.changes[0]!.id, spot: 1, label: "Quiet music bed", range: { start: 2, end: 10 }, previous: [] },
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

      // Rows in the edits rail use Scarlet's own hover tooltip with the full line instead of a browser title tooltip.
      const row = rail.querySelector<HTMLButtonElement>(".review-rail-list button.simple-edit")!;
      expect(row.getAttribute("title")).toBeNull();
      expect(row.dataset.rowTip).toBe(longLabel);
      vi.useFakeTimers();
      try {
        await act(async () => {
          row.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
          vi.advanceTimersByTime(220);
        });
        const tip = rail.querySelector<HTMLElement>('[role="tooltip"].review-rail-tip')!;
        expect(tip).not.toBeNull();
        expect(tip.textContent).toContain(longLabel);
        expect(tip.textContent).toContain("Needs graphic from Alex.");
        expect(row.getAttribute("aria-describedby")).toBe(tip.id);

        // Moving to a low-risk row updates the tooltip immediately (warm hover) and shows its full line too.
        const lowRow = rail.querySelector<HTMLButtonElement>(".review-low-body button.simple-edit")!;
        await act(async () => {
          lowRow.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
        });
        expect(rail.querySelector<HTMLElement>('[role="tooltip"].review-rail-tip')?.textContent).toBe("Quiet music bed");

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
});
