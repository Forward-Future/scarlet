// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { isConfiguredAgent } from "./hosts";
import { isChoiceHidden, isModelHidden, useModelPreferences } from "./modelPicker";

beforeEach(() => useModelPreferences.setState({ hidden: [], shown: [], favorites: [] }));

it("ignores a local server that has no tool models ready yet", () => {
  expect(isConfiguredAgent({ id: "ollama", installed: true, loggedIn: true, models: [] })).toBe(false);
  expect(isConfiguredAgent({ id: "ollama", installed: true, loggedIn: true, models: ["qwen3:8b"] })).toBe(true);
  expect(isConfiguredAgent({ id: "claude", installed: true, loggedIn: true })).toBe(true);
});

it("keeps OpenRouter's long list out of the selector until a model is shown or starred, and local models in until hidden", () => {
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

it("only enables the recommended frontier models by default for Claude Code, Codex, and Gemini", () => {
  const prefs = () => useModelPreferences.getState();
  // Recommended frontier models are enabled by default.
  expect(isModelHidden(prefs(), "claude:opus")).toBe(false);
  expect(isModelHidden(prefs(), "claude:fable")).toBe(false);
  expect(isModelHidden(prefs(), "claude:fable[1m]")).toBe(false);
  expect(isModelHidden(prefs(), "claude:")).toBe(false);
  expect(isModelHidden(prefs(), "codex:gpt-6.2-sol")).toBe(false);
  expect(isModelHidden(prefs(), "codex:gpt-6.2-astra")).toBe(false);
  expect(isModelHidden(prefs(), "gemini:gemini-4-neon")).toBe(false);

  // Non-recommended models stay disabled until explicitly enabled or starred.
  expect(isModelHidden(prefs(), "claude:sonnet")).toBe(true);
  expect(isModelHidden(prefs(), "claude:haiku")).toBe(true);
  expect(isModelHidden(prefs(), "claude:claude-opus-5")).toBe(true);
  expect(isModelHidden(prefs(), "codex:gpt-6.1-sol")).toBe(true);
  expect(isModelHidden(prefs(), "codex:gpt-6-luna")).toBe(true);
  expect(isModelHidden(prefs(), "gemini:gemini-4-carbon")).toBe(true);
  expect(isModelHidden(prefs(), "gemini:gemini-3.8-flash")).toBe(true);

  // Turning a non-recommended model on adds it to `shown`; turning it off hides it again.
  prefs().setVisible(["claude:sonnet", "codex:gpt-6.1-sol"], true);
  expect(isModelHidden(prefs(), "claude:sonnet")).toBe(false);
  expect(isModelHidden(prefs(), "codex:gpt-6.1-sol")).toBe(false);
  prefs().setVisible(["claude:sonnet"], false);
  expect(isModelHidden(prefs(), "claude:sonnet")).toBe(true);

  // Turning a recommended model off hides it; turning it back on restores it.
  prefs().setVisible(["gemini:gemini-4-neon"], false);
  expect(isModelHidden(prefs(), "gemini:gemini-4-neon")).toBe(true);
  prefs().setVisible(["gemini:gemini-4-neon"], true);
  expect(isModelHidden(prefs(), "gemini:gemini-4-neon")).toBe(false);

  // Custom models and providers whose catalog lacks any recommended model stay visible by default.
  const catalog = [
    { agent: "codex" as const, key: "codex:gpt-6.2-sol" },
    { agent: "codex" as const, key: "codex:studio-model", custom: true },
    { agent: "gemini" as const, key: "gemini:gemini-3-pro" },
  ];
  expect(isChoiceHidden(prefs(), catalog[1]!, catalog)).toBe(false);
  expect(isChoiceHidden(prefs(), catalog[2]!, catalog)).toBe(false);
});
