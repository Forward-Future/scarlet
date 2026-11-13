// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EngineStatus } from "../../lib/desktop";

vi.mock("../../lib/realtime", async importOriginal => ({ ...(await importOriginal<object>()), startRealtime: () => () => {}, reconnectRealtime: () => {} }));
vi.mock("../../lib/dropTargets", async importOriginal => ({ ...(await importOriginal<object>()), listenForFileDrops: () => () => {} }));
// A page whose code never arrives holds the router on what it shows while that code loads.
vi.mock("../../pages/SettingsPage", () => new Promise(() => {}));

let host: HTMLElement;
let root: Root | undefined;
// Each launch starts from nothing: the window, its stores and what it remembers of having started.
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/");
  document.body.innerHTML = '<div id="root"></div>';
  host = document.getElementById("root")!;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The startup screen's line, when the startup screen is all the window shows. */
const startupLine = () => {
  const screens = host.querySelectorAll('main[aria-busy="true"]');
  // Nothing else in the window says anything: no page, and no wait of a page's own.
  return screens.length === 1 && host.textContent === screens[0]!.textContent ? screens[0]!.querySelector('[role="status"]')?.textContent : undefined;
};
/** The engine as the window finds it: still starting, or up. Its project list answers when the test says. */
async function engine(status: "loading" | "ready") {
  const { desktop } = await import("../../lib/desktop");
  vi.spyOn(desktop, "onEngineStatus").mockResolvedValue(() => {});
  vi.spyOn(desktop, "log").mockResolvedValue(undefined);
  const { buildDb } = await import("../../lib/mock/fixtures");
  const { api } = await import("../../lib/client");
  let answer!: () => void;
  const projects = vi.spyOn(api, "projects").mockReturnValue(new Promise(resolve => { answer = () => resolve({ projects: [] }); }));
  vi.spyOn(api, "settings").mockResolvedValue({ settings: buildDb().settings });
  const { useHostsStore } = await import("../../stores/hosts");
  useHostsStore.setState({ load: async () => {} });
  const { useAuthStore } = await import("../../stores/auth");
  useAuthStore.setState({ status, bootstrap: async () => {} });
  return { projects, answer: () => act(async () => answer()), becomes: (next: typeof status) => act(async () => useAuthStore.setState({ status: next })) };
}
async function shell(path: string) {
  const { AppShell } = await import("./AppShell");
  const { ProjectLayout } = await import("./ProjectLayout");
  const router = createMemoryRouter([{ element: <AppShell />, children: [
    { path: "/", element: <p>Project library</p> },
    { path: "/p/:id", element: <ProjectLayout />, children: [{ index: true, element: <p>Project</p> }] },
    { path: "*", element: <p>Another page</p> },
  ] }], { initialEntries: [path] });
  root = createRoot(host);
  await act(async () => root!.render(<RouterProvider router={router} />));
  return router;
}
/** The project Scarlet reopens, read when the test says: its store's state is set by hand. */
async function reopened() {
  const { useProjectStore } = await import("../../stores/project");
  const { buildDb, PRJ } = await import("../../lib/mock/fixtures");
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  const load = vi.fn(async () => {});
  useProjectStore.setState({ load });
  const becomes = (state: Partial<ReturnType<typeof useProjectStore.getState>>) => act(async () => useProjectStore.setState(state));
  const data = { id: PRJ, project, timeline: db.timelines[project.head!]!, media: project.media, changes: [], notes: [], renders: [], tasks: [], taskEvents: {} };
  return { id: PRJ, load, opening: () => becomes({ status: "loading", error: null, current: null }), fails: () => becomes({ status: "error", error: "Project not found" }),
    // The project itself is read first, then the edits made in it.
    opens: (history: "loading" | "read" = "read") => becomes({ status: "ready", current: { ...data, reviewStatus: history === "loading" ? "loading" : undefined } }) };
}

/** Any of the startup screen's own lines. */
const starting = /^(Warming up the engine|Scanning frames|Listening to the audio|Finding the best takes|Lining up the timeline)…$/;

it("plays the editing animation under one line read out, and carries it on when a later wait draws it again", async () => {
  vi.useFakeTimers();
  const { BootSplash } = await import("./BootSplash");
  root = createRoot(host);
  await act(async () => root!.render(<BootSplash />));
  expect(startupLine()).toBe("Warming up the engine…");
  // The line is the only thing read out: the wordmark and the timeline are decoration.
  const stage = host.querySelector(".boot-stage")!;
  expect([...stage.children].map(child => child.getAttribute("aria-hidden") ?? child.getAttribute("role"))).toEqual(["true", "true", "status"]);
  expect(host.querySelectorAll(".boot-clip.is-cut")).toHaveLength(2);
  await act(async () => { vi.advanceTimersByTime(1800); });
  expect(startupLine()).toBe("Scanning frames…");
  // The next part of the window that waits draws the screen again: it picks up where it was, with no fade-in.
  await act(async () => root!.render(<p />));
  await act(async () => { vi.advanceTimersByTime(2000); });
  await act(async () => root!.render(<BootSplash />));
  const screen = host.querySelector<HTMLElement>(".boot-splash")!;
  expect(screen.classList.contains("is-continued")).toBe(true);
  expect(screen.style.getPropertyValue("--since")).toBe("-3.800s");
  expect(startupLine()).toBe("Listening to the audio…");
  expect(host.querySelector(".boot-line-text.is-held")).not.toBeNull();
});

it("says a line it is given instead, and keeps it", async () => {
  vi.useFakeTimers();
  const { BootSplash } = await import("./BootSplash");
  root = createRoot(host);
  await act(async () => root!.render(<BootSplash line="Reconnecting to Scarlet…" />));
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(startupLine()).toBe("Reconnecting to Scarlet…");
});

it("is what the window shows while its first page's code loads", async () => {
  await engine("loading");
  window.history.replaceState(null, "", "/settings");
  const { App } = await import("../../App");
  root = createRoot(host);
  await act(async () => root!.render(<App platform="macos" />));
  expect(startupLine()).toMatch(starting);
});

it("stays as it is while the engine starts and the library's projects load, and names a later reconnect", async () => {
  const { projects, answer, becomes } = await engine("loading");
  await shell("/");
  expect(startupLine()).toMatch(starting);
  // The engine is up. The library isn't whole until its projects are here, so the screen stays.
  await becomes("ready");
  expect(projects).toHaveBeenCalledTimes(1);
  expect(startupLine()).toMatch(starting);
  await answer();
  expect(host.textContent).toBe("Project library");
  // An engine replaced later takes the window for a moment. Scarlet isn't starting then.
  await becomes("loading");
  expect(startupLine()).toBe("Reconnecting to Scarlet…");
  await becomes("ready");
  expect(host.textContent).toBe("Project library");
});

it("gives way at once to what went wrong when the engine can't start, and goes on when it comes up", async () => {
  const { answer, becomes } = await engine("loading");
  const { useAuthStore } = await import("../../stores/auth");
  await shell("/");
  // Away while it starts is a wait: the startup screen stays.
  await act(async () => useAuthStore.setState({ status: "offline", error: "Error: Waiting for the local engine…", failed: false }));
  expect(startupLine()).toMatch(starting);
  // The engine has given up. The window says why straight away, not after the slow-start wait.
  await act(async () => useAuthStore.setState({ status: "offline", error: "Error: scarlet-engine sidecar not found", failed: true }));
  expect(host.querySelector('main[aria-busy="true"]')).toBeNull();
  expect(host.querySelector("h1")?.textContent).toBe("Scarlet couldn’t start");
  expect(host.textContent).toContain("Error: scarlet-engine sidecar not found");
  expect([...host.querySelectorAll("button")].map(b => b.textContent)).toEqual(["Open logs", "Copy diagnostics"]);
  // An engine started again later, by a rebuild or a fix, still brings the window up.
  await becomes("ready");
  await answer();
  expect(host.textContent).toBe("Project library");
});

it("says Scarlet lost its engine when it crashes, that it couldn't start when it keeps failing, and comes back when it is up", async () => {
  const { desktop } = await import("../../lib/desktop");
  const { ScarletClient } = await import("@scarlet/shared");
  const { buildDb } = await import("../../lib/mock/fixtures");
  const up = { state: "ready", url: "http://127.0.0.1:4100", token: "sct_engine", userId: "local", error: null, restarts: 0 } as unknown as EngineStatus;
  let now = up;
  let tell!: (status: EngineStatus) => void;
  vi.spyOn(desktop, "onEngineStatus").mockImplementation(async listener => { tell = listener; return () => {}; });
  vi.spyOn(desktop, "engineStatus").mockImplementation(async () => now);
  vi.spyOn(desktop, "log").mockResolvedValue(undefined);
  vi.spyOn(ScarletClient.prototype, "me").mockResolvedValue({ user: { id: "local", name: "You", createdAt: "2026-11-10" } } as never);
  vi.spyOn(ScarletClient.prototype, "projects").mockResolvedValue({ projects: [] });
  vi.spyOn(ScarletClient.prototype, "settings").mockResolvedValue({ settings: buildDb().settings });
  // Each time the window connects it picks up the exports left from before.
  const exports = vi.spyOn(ScarletClient.prototype, "exports").mockResolvedValue({ renders: [] });
  const { useHostsStore } = await import("../../stores/hosts");
  useHostsStore.setState({ load: async () => {} });
  const engine = (status: Partial<EngineStatus>) => act(async () => { now = { ...up, ...status }; tell(now); });
  await shell("/");
  await vi.waitFor(() => expect(host.textContent).toBe("Project library"));

  // The engine crashes. The window says Scarlet is reconnecting, and why, rather than failing each action without a word.
  await engine({ state: "starting", url: null, token: undefined, restarts: 1, error: "Scarlet’s engine stopped unexpectedly (exit code 1). Starting it again…" });
  await vi.waitFor(() => expect(host.querySelector("h1")?.textContent).toBe("Reconnecting to Scarlet…"));
  expect(host.textContent).toContain("Scarlet’s engine stopped unexpectedly (exit code 1). Starting it again…");
  expect([...host.querySelectorAll("button")].map(b => b.textContent)).toEqual(["Open logs", "Copy diagnostics"]);
  // It fails to start again and again: Scarlet couldn't start, and why.
  await engine({ state: "error", url: null, token: undefined, restarts: 4, error: "engine exited before reporting ready (see log for its output)" });
  await vi.waitFor(() => expect(host.querySelector("h1")?.textContent).toBe("Scarlet couldn’t start"));
  expect(host.textContent).toContain("engine exited before reporting ready (see log for its output)");
  // A start gets through, and the window is back where it was.
  await engine({ restarts: 4 });
  await vi.waitFor(() => expect(host.textContent).toBe("Project library"));

  // A restart Scarlet asked for, to load a dev rebuild, is over in a moment: the window carries on through it.
  await engine({ state: "starting", url: null, token: undefined });
  expect(host.textContent).toBe("Project library");
  await vi.waitFor(() => expect(exports).toHaveBeenCalledTimes(2));
});

it("leaves for a page other than the library as soon as the engine is up, and asks for the projects for the way back", async () => {
  const { projects, becomes } = await engine("loading");
  await shell("/settings");
  expect(startupLine()).toMatch(starting);
  await becomes("ready");
  expect(host.textContent).toBe("Another page");
  expect(projects).toHaveBeenCalledTimes(1);
});

it("stays as it is while the project Scarlet reopens is opening, and leaves a project opened later to its own line", async () => {
  const { becomes } = await engine("loading");
  const project = await reopened();
  // Restart to update brings Scarlet back where it was. With History open, the page needs the project's edits too.
  const router = await shell(`/p/${project.id}?panel=history`);
  expect(startupLine()).toMatch(starting);
  // The engine is up and the project is being read. That wait is the startup screen's too, with no spinner after it.
  await becomes("ready");
  expect(project.load).toHaveBeenCalledWith(project.id);
  await project.opening();
  expect(startupLine()).toMatch(starting);
  await project.opens("loading");
  expect(startupLine()).toMatch(starting);
  await project.opens();
  expect(host.textContent).toBe("Project");
  // The window has started. The library shows though its list hasn't answered, and a project opened from it says
  // what it waits for.
  await act(async () => { await router.navigate("/"); });
  expect(host.textContent).toBe("Project library");
  await project.opening();
  await act(async () => { await router.navigate(`/p/${project.id}`); });
  expect(host.querySelector('main[aria-busy="true"]')).toBeNull();
  expect(host.textContent).toContain("Opening project…");
});

it("gives way to the project's own word when the project Scarlet reopens can't open", async () => {
  await engine("ready");
  const project = await reopened();
  await shell(`/p/${project.id}`);
  expect(startupLine()).toMatch(starting);
  await project.fails();
  expect(host.querySelector('main[aria-busy="true"]')).toBeNull();
  expect(host.textContent).toContain("Couldn’t open the project");
  // Asked again, it waits under its own line: Scarlet isn't starting any more.
  await project.opening();
  expect(host.querySelector('main[aria-busy="true"]')).toBeNull();
  expect(host.textContent).toContain("Opening project…");
});
