// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

it("starts and keeps choices for the session when the window's storage can't be read or written", async () => {
  const spies = (["getItem", "setItem", "removeItem"] as const).map(name =>
    vi.spyOn(Storage.prototype, name).mockImplementation(() => { throw new Error("Storage is disabled"); }));
  vi.resetModules();
  const { useUiStore } = await import("./ui");
  const ui = useUiStore.getState();
  expect(ui).toMatchObject({ agent: { agent: "claude" }, showRunTokens: true, savedDrafts: {} });
  ui.setShowRunTokens(true);
  expect(useUiStore.getState().showRunTokens).toBe(true);
  ui.setShowRunTokens(false);
  expect(useUiStore.getState().showRunTokens).toBe(false);
  ui.setAgent({ agent: "codex", model: "gpt-6.1-sol" });
  expect(useUiStore.getState().agent).toEqual({ agent: "codex", model: "gpt-6.1-sol" });
  spies.forEach(spy => spy.mockRestore());
});

it("shows tokens in the chat unless the editor turned them off", async () => {
  localStorage.removeItem("scarlet.runTokens");
  vi.resetModules();
  expect((await import("./ui")).useUiStore.getState().showRunTokens).toBe(true);
  localStorage.setItem("scarlet.runTokens", "hidden");
  vi.resetModules();
  expect((await import("./ui")).useUiStore.getState().showRunTokens).toBe(false);
  localStorage.removeItem("scarlet.runTokens");
});
