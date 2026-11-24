// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fullRenderContext, Task } from "@scarlet/shared";
import { buildDb, PRJ } from "../../lib/mock/fixtures";
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

    // Flip beta toggle on: switches live to three-column layout with bubbles, question panel, and Low Risk Edits.
    await act(async () => useUiStore.getState().setNewLayout(true));
    await act(async () => {});
    expect(container.querySelector("[data-new-layout]")).not.toBeNull();
    expect(container.querySelector(".review-rail")).not.toBeNull();
    expect(container.querySelector(".review-low-head")?.textContent).toContain("Low Risk Edits");
    expect(container.querySelector(".review-low-done")).not.toBeNull();
    expect(container.querySelector(".composer-ask-text")?.textContent).toBe("How tight should I cut the intro?");
    expect([...container.querySelectorAll(".composer-ask-choice")].map(b => b.textContent)).toEqual(["Keep the setup", "Jump straight in"]);

    // Flip back off: returns immediately to the previous default layout.
    await act(async () => useUiStore.getState().setNewLayout(false));
    await act(async () => {});
    expect(container.querySelector("[data-new-layout]")).toBeNull();
    expect(container.querySelector(".review-rail")).toBeNull();
  });
});
