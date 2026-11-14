// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

it("starts and keeps choices for the session when the window's storage can't be read or written", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage is disabled"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage is disabled"); });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("Storage is disabled"); });
  vi.resetModules();
  const { useUiStore } = await import("./ui");
  const ui = useUiStore.getState();
  expect(ui).toMatchObject({ agent: { agent: "claude" }, showRunTokens: false, savedDrafts: {} });
  ui.setShowRunTokens(true);
  expect(useUiStore.getState().showRunTokens).toBe(true);
  ui.setShowRunTokens(false);
  expect(useUiStore.getState().showRunTokens).toBe(false);
  ui.setAgent({ agent: "codex", model: "gpt-6.1-sol" });
  expect(useUiStore.getState().agent).toEqual({ agent: "codex", model: "gpt-6.1-sol" });
});
