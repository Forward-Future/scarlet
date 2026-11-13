// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { Task } from "@scarlet/shared";
import { api } from "../../lib/client";
import { buildDb, MED_MUSIC, PRJ } from "../../lib/mock/fixtures";
import { useProjectStore, type ProjectData } from "../../stores/project";
import { TranscriptionAction } from "./TranscriptionAction";

const initial = useProjectStore.getState();
afterEach(() => {
  useProjectStore.setState(initial, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps an unavailable provider actionable and reports a failed 202 task on the right file", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const db = buildDb();
  const project = db.projects.find((p) => p.id === PRJ)!;
  const media = db.media[PRJ]!;
  const music = media.find((m) => m.id === MED_MUSIC)!;
  const current: ProjectData = {
    id: PRJ, project, timeline: null, media,
    changes: [], notes: [], renders: [], tasks: [], taskEvents: {}, versions: [],
  };
  useProjectStore.setState({ current });
  const failed: Task = {
    ...db.tasks[0]!, id: "transcription-test", projectId: PRJ, kind: "transcribe", agent: "api",
    context: { mediaId: music.id }, state: "failed", instruction: `Transcribe ${music.name}`,
    error: "The selected transcription model could not be opened.",
  };
  const request = vi.spyOn(api, "transcribe").mockResolvedValue({ task: failed });
  const container = document.createElement("div");
  const root = createRoot(container);
  const show = (available: boolean) => act(() => root.render(
    <MemoryRouter><TranscriptionAction asset={music} available={available} /></MemoryRouter>,
  ));
  try {
    await show(false);
    expect(container.querySelector("a")?.textContent).toBe("Set up transcription");
    expect(container.querySelector("button")).toBeNull();

    await show(true);
    await act(async () => { container.querySelector("button")!.click(); });
    expect(request).toHaveBeenCalledWith(music.id);
    expect(container.textContent).toContain(failed.error);
    expect(container.querySelector("button")?.textContent).toBe("Retry transcription");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(failed.error);

    // An identically named file must not inherit another asset's progress.
    const other = { ...music, id: "other-asset" };
    await act(() => useProjectStore.setState({ current: { ...current, media: [music, other], tasks: [
      { ...failed, context: { mediaId: other.id }, state: "running", error: undefined },
    ] } }));
    expect(container.querySelector("button")?.textContent).toBe("Transcribe");
  } finally {
    await act(() => root.unmount());
  }
});
