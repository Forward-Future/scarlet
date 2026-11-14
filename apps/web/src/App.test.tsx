// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, Navigate, RouterProvider, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectHome } from "./App";

afterEach(() => vi.unstubAllGlobals());

function Destination() {
  const { pathname, search, hash } = useLocation();
  return <output>{pathname}{search}{hash}</output>;
}

it("opens the project from an older link to a page inside it, and the library from any other old link", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const land = async (link: string) => {
    const router = createMemoryRouter([
      { index: true, element: <Destination /> },
      { path: "/p/:id", children: [{ index: true, element: <Destination /> }, { path: "*", element: <ProjectHome /> }] },
      { path: "*", element: <Navigate to="/" replace /> },
    ], { initialEntries: [link] });
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<RouterProvider router={router} />));
    const text = container.querySelector("output")?.textContent;
    await act(async () => root.unmount());
    return text;
  };
  expect(await land("/p/prj%201/review?note=note_1#later")).toBe("/p/prj%201?note=note_1#later");
  expect(await land("/p/prj_1/media/old")).toBe("/p/prj_1");
  expect(await land("/projects/prj_1/tasks/task_1")).toBe("/");
  expect(await land("/skills/wrap")).toBe("/");
});
