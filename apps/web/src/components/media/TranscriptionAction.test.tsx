// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { Task } from "@scarlet/shared";
import { buildDb, MED_MUSIC, PRJ } from "../../lib/mock/fixtures";
import { useProjectStore, type ProjectData } from "../../stores/project";
import { TranscriptionStatus } from "./TranscriptionAction";

const initial = useProjectStore.getState();
afterEach(() => {
  useProjectStore.setState(initial, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("says plainly how a file's transcription stands in the transcript column, on the right file, with nothing to press", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const db = buildDb();
  const project = db.projects.find((p) => p.id === PRJ)!;
  const media = db.media[PRJ]!;
  const music = { ...media.find((m) => m.id === MED_MUSIC)!, status: "ready" as const, transcriptId: undefined };
  const failed: Task = {
    ...db.tasks[0]!, id: "transcription-test", projectId: PRJ, kind: "transcribe", agent: "api",
    context: { mediaId: music.id }, state: "failed", instruction: `Transcribe ${music.name}`,
    error: "The selected transcription model could not be opened.",
  };
  const current: ProjectData = { id: PRJ, project, timeline: null, media: [music], changes: [], notes: [], renders: [], tasks: [], taskEvents: {}, versions: [] };
  useProjectStore.setState({ current });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(() => root.render(<MemoryRouter><TranscriptionStatus asset={music} /></MemoryRouter>));
    expect(container.textContent).toBe("No transcript");
    await act(() => useProjectStore.setState({ current: { ...current, tasks: [failed] } }));
    expect(container.textContent).toBe("Transcription stopped");
    expect(container.querySelector("button, a")).toBeNull();
    // An identically named file must not inherit another asset's progress.
    const other = { ...music, id: "other-asset" };
    await act(() => useProjectStore.setState({ current: { ...current, media: [music, other], tasks: [
      { ...failed, context: { mediaId: other.id }, state: "running", error: undefined, progress: { stage: "transcribing", fraction: 0.5 } },
    ] } }));
    expect(container.textContent).toBe("No transcript");
    await act(() => useProjectStore.setState({ current: { ...current, tasks: [{ ...failed, state: "running", error: undefined, progress: { stage: "queued", fraction: 0 } }] } }));
    expect(container.textContent).toBe("Waiting to transcribe");
  } finally {
    await act(() => root.unmount());
  }
});

it("reads a transcription the pause stopped as paused in the transcript column too", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const db = buildDb();
  const project = { ...db.projects.find((p) => p.id === PRJ)!, mediaPaused: true };
  const media = db.media[PRJ]!;
  const music = { ...media.find((m) => m.id === MED_MUSIC)!, status: "ready" as const };
  const stopped: Task = {
    ...db.tasks[0]!, id: "transcription-stopped", projectId: PRJ, kind: "transcribe", agent: "api",
    context: { mediaId: music.id }, state: "failed", interrupted: true, instruction: `Transcribe ${music.name}`, error: "Transcription was interrupted.",
  };
  const current: ProjectData = { id: PRJ, project, timeline: null, media, changes: [], notes: [], renders: [], tasks: [stopped], taskEvents: {}, versions: [] };
  useProjectStore.setState({ current });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(() => root.render(<MemoryRouter><TranscriptionStatus asset={music} /></MemoryRouter>));
    // Nothing failed: the engine starts no transcription until processing is resumed.
    expect(container.textContent).toBe("Transcription paused");
  } finally {
    await act(() => root.unmount());
  }
});
