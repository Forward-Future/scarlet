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

it("puts words into a message where the cursor is, with a space either side, and swaps or takes out what they replace", async () => {
  const { spliceDraft } = await import("./ui");
  expect(spliceDraft("", 0, "0:09")).toEqual({ text: "0:09 ", caret: 5 });
  expect(spliceDraft("zoom in here", 7, "0:09")).toEqual({ text: "zoom in 0:09 here", caret: 13 });
  expect(spliceDraft("zoom in", 7, "0:09")).toEqual({ text: "zoom in 0:09 ", caret: 13 });
  // What it replaces is still in the message: the new words take its place, wherever the cursor is.
  expect(spliceDraft("loud 0:04 – 0:10 here", 0, "0:05 – 0:12", "0:04 – 0:10")).toEqual({ text: "loud 0:05 – 0:12 here", caret: 16 });
  // Gone from the message, the new words go where the cursor is instead.
  expect(spliceDraft("loud here", 4, "0:05 – 0:12", "0:04 – 0:10").text).toBe("loud 0:05 – 0:12 here");
  // Empty words take it out, with one of the spaces it stood between.
  expect(spliceDraft("loud 0:04 – 0:10 here", 0, "", "0:04 – 0:10").text).toBe("loud here");
  expect(spliceDraft("loud 0:04 – 0:10 ", 0, "", "0:04 – 0:10").text).toBe("loud ");
  expect(spliceDraft("loud", 2, "", "0:04 – 0:10")).toEqual({ text: "loud", caret: 2 });
});
