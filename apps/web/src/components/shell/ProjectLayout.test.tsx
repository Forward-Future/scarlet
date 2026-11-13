// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../lib/client";
import { useProjectStore } from "../../stores/project";
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
