// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { isConfiguredAgent } from "./hosts";
import { isModelHidden, useModelPreferences } from "./modelPicker";

beforeEach(() => useModelPreferences.setState({ hidden: [], shown: [], favorites: [] }));

it("ignores a local server that has no tool models ready yet", () => {
  expect(isConfiguredAgent({ id: "ollama", installed: true, loggedIn: true, models: [] })).toBe(false);
  expect(isConfiguredAgent({ id: "ollama", installed: true, loggedIn: true, models: ["qwen3:8b"] })).toBe(true);
  expect(isConfiguredAgent({ id: "claude", installed: true, loggedIn: true })).toBe(true);
});

it("keeps OpenRouter's long list out of the selector until a model is shown or starred, and the rest in until hidden", () => {
  const prefs = () => useModelPreferences.getState();
  expect(isModelHidden(prefs(), "openrouter:anthropic/claude-sonnet-4.5")).toBe(true);
  expect(isModelHidden(prefs(), "ollama:qwen3:8b")).toBe(false);
  expect(isModelHidden(prefs(), "claude:opus")).toBe(false);

  prefs().setVisible(["openrouter:anthropic/claude-sonnet-4.5", "ollama:qwen3:8b"], true);
  expect(prefs().shown).toEqual(["openrouter:anthropic/claude-sonnet-4.5"]);
  expect(isModelHidden(prefs(), "openrouter:anthropic/claude-sonnet-4.5")).toBe(false);

  prefs().setVisible(["openrouter:anthropic/claude-sonnet-4.5", "ollama:qwen3:8b"], false);
  expect([prefs().shown, prefs().hidden]).toEqual([[], ["ollama:qwen3:8b"]]);
  expect(isModelHidden(prefs(), "ollama:qwen3:8b")).toBe(true);

  // A star shows a model wherever it is.
  prefs().toggleFavorite("openrouter:google/gemini-3-pro");
  expect(isModelHidden(prefs(), "openrouter:google/gemini-3-pro")).toBe(false);
});
