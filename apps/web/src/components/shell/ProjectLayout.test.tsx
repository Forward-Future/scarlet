// @vitest-environment happy-dom
import * as imports from "../media/UploadDropzone";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { api } from "../../lib/client";
import { useProjectStore } from "../../stores/project";
import { startup } from "./BootSplash";
import { ProjectLayout } from "./ProjectLayout";

vi.mock("../../lib/client", async (original) => {
  const client = await original<typeof import("../../lib/client")>();
  const { MockClient } = await import("../../lib/mock/MockClient");
  return { ...client, api: new MockClient(() => "test") };
});

const initial = useProjectStore.getState();
afterEach(() => {
  useProjectStore.setState(initial, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Destination() {
  const { pathname, search } = useLocation();
  return <output>{pathname}{search}</output>;
}

it("restores a trashed project from a deep link and opens the original destination", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { project } = await api.createProject({ name: "Portrait rough cut" });
  await api.deleteProject(project.id);
  const restore = vi.spyOn(api, "restoreProject").mockRejectedValueOnce(new Error("Engine disconnected"));
  const link = `/p/${project.id}/media?clip=one`;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={[link]}><Routes>
      <Route path="/p/:id" element={<ProjectLayout />}><Route path="media" element={<Destination />} /></Route>
    </Routes></MemoryRouter>));
    await act(async () => vi.waitFor(() => expect(useProjectStore.getState().trashedProject?.id).toBe(project.id)));
    expect(container.textContent).toContain("This project is in Trash");
    expect(container.textContent).toContain(project.name);
    const button = container.querySelector("button")!;
    expect(button.textContent).toBe("Restore project");
    await act(async () => button.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Engine disconnected");
    await act(async () => button.click());
    expect(button.disabled).toBe(true);
    await act(async () => vi.waitFor(() => expect(useProjectStore.getState().current?.id).toBe(project.id)));
    expect(container.querySelector("output")?.textContent).toBe(link);
    expect(restore).toHaveBeenLastCalledWith(project.id);
    expect((await api.trash()).projects.some(p => p.id === project.id)).toBe(false);
  } finally {
    await act(() => root.unmount());
  }
});

it("keeps a missing project distinct from other projects in Trash", async () => {
  const { project } = await api.createProject({ name: "Different project" });
  await api.deleteProject(project.id);
  await initial.load("prj_missing");
  expect(useProjectStore.getState()).toMatchObject({ status: "error", trashedProject: null, current: null });
});

it("carries on with imports kept for the project when it opens, and again each time it is read after the engine came back", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { project } = await api.createProject({ name: "Interview" });
  const resume = vi.spyOn(imports, "resumeImports").mockResolvedValue(undefined);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={[`/p/${project.id}`]}><Routes>
      <Route path="/p/:id" element={<ProjectLayout />} />
    </Routes></MemoryRouter>));
    await act(async () => vi.waitFor(() => expect(useProjectStore.getState().current?.id).toBe(project.id)));
    expect(resume).toHaveBeenCalledWith(project.id, expect.any(Array));
    // The engine restarts under the open project. The window stays up, and reads the project again once it is back:
    // files that were importing when the engine went are waiting, saved, for exactly this.
    resume.mockClear();
    await act(async () => { await useProjectStore.getState().load(project.id); });
    expect(resume).toHaveBeenCalledWith(project.id, useProjectStore.getState().current!.media);
  } finally {
    await act(() => root.unmount());
  }
});

it("waits for the edit history only for a note's link or the history panel", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { project } = await api.createProject({ name: "History wait" });
  const started = startup.done;
  startup.done = true;
  onTestFinished(() => { startup.done = started; });
  const show = async (link: string) => {
    useProjectStore.setState({
      load: vi.fn(async () => {}), status: "ready", trashedProject: null,
      current: { id: project.id, project, timeline: null, media: [], changes: [], notes: [], renders: [], tasks: [], taskEvents: {}, reviewStatus: "loading" },
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<MemoryRouter initialEntries={[link]}><Routes>
      <Route path="/p/:id" element={<ProjectLayout />}><Route index element={<Destination />} /></Route>
    </Routes></MemoryRouter>));
    const text = container.textContent;
    await act(async () => root.unmount());
    return text;
  };
  expect(await show(`/p/${project.id}?note=note_1`)).toContain("Loading edit history…");
  expect(await show(`/p/${project.id}?panel=history`)).toContain("Loading edit history…");
  // Older links named a thread or item that nothing reads any more.
  expect(await show(`/p/${project.id}?thread=chg_1`)).toBe(`/p/${project.id}?thread=chg_1`);
  expect(await show(`/p/${project.id}`)).toBe(`/p/${project.id}`);
});
