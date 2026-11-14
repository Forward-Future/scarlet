// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";

const { info, loadEditor, log, render } = vi.hoisted(() => ({
  info: vi.fn(),
  loadEditor: vi.fn(),
  log: vi.fn(async () => {}),
  render: vi.fn(),
}));

vi.mock("./lib/desktop", async (original) => ({
  ...await original<typeof import("./lib/desktop")>(),
  desktop: { info, log },
}));
vi.mock("./App", () => { loadEditor(); return { App: () => null }; });
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render }) }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="root"></div>';
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

it("keeps the editor unloaded when a browser opens a project with a legacy launch token", async () => {
  window.history.replaceState({}, "", "/p/prj_demo#token=test-token");
  await import("./main");
  expect(document.body.textContent).toContain("desktop app");
  expect(info).not.toHaveBeenCalled();
  expect(loadEditor).not.toHaveBeenCalled();
  expect(render).not.toHaveBeenCalled();
});

/** Each thing the window was asked to show, in order. */
const shown = () => render.mock.calls.map(([element]) => element as { type?: unknown; props?: Record<string, unknown> } | string);
const startupScreen = async () => (await import("./components/shell/BootSplash")).BootSplash;

it("shows the startup screen while the native handshake is still to come, with the editor unloaded", async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  info.mockReturnValueOnce(new Promise(() => {}));
  await import("./main");
  const Startup = await startupScreen();
  expect(shown().map(element => typeof element === "object" && element.type)).toEqual([Startup]);
  expect(loadEditor).not.toHaveBeenCalled();
});

it("requires a successful native handshake before loading even a demo", async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  info.mockRejectedValueOnce(new Error("Native bridge unavailable"));
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await import("./main");
    await vi.waitFor(() => expect(render).toHaveBeenCalledWith(expect.objectContaining({
      props: expect.objectContaining({ title: "Scarlet couldn’t start", detail: expect.stringContaining("Native bridge unavailable") }),
    })));
    expect(loadEditor).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("startup failed: "), "error");
  } finally {
    consoleError.mockRestore();
  }
});

it("keeps the editor unloaded on unsupported native platforms", async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  info.mockResolvedValueOnce({ platform: "android" });
  await import("./main");
  await vi.waitFor(() => expect(render).toHaveBeenLastCalledWith(expect.stringContaining("desktop app")));
  expect(loadEditor).not.toHaveBeenCalled();
});

it.each(["macos", "windows", "linux"])("opens the editor inside the %s app", async (platform) => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  info.mockResolvedValueOnce({ platform });
  await import("./main");
  // The startup screen first, then the editor in its place.
  await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));
  const Startup = await startupScreen();
  expect(shown().map(element => typeof element === "object" && element.type === Startup)).toEqual([true, false]);
  // A failed start shows two screens too, the startup screen and then the recovery one. Only it logs an error.
  expect(log).not.toHaveBeenCalledWith(expect.anything(), "error");
});

it("loads this installation's custom model lists from the native bridge", async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  const { useHostsStore } = await import("./stores/hosts");
  info.mockResolvedValueOnce({ platform: "windows", customOpenaiModels: ["local-test"], customClaudeModels: ["claude-early-test"] });
  await import("./main");
  await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));
  expect(log).not.toHaveBeenCalledWith(expect.anything(), "error");
  expect(useHostsStore.getState().customOpenaiModels).toEqual(["local-test"]);
  expect(useHostsStore.getState().customClaudeModels).toEqual(["claude-early-test"]);
});
