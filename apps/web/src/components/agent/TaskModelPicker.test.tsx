// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OnlineAgent } from "../../stores/hosts";
import { useModelPreferences, type ModelChoice } from "../../stores/modelPicker";
import { TaskModelPicker } from "./TaskModelPicker";

let root: Root;
let container: HTMLDivElement;
let oldPrefs: ReturnType<typeof useModelPreferences.getState>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  oldPrefs = useModelPreferences.getState();
  useModelPreferences.setState({ hidden: [], favorites: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useModelPreferences.setState(oldPrefs, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const choice = (agent: "claude" | "gemini" | "codex", model: string, label: string): ModelChoice =>
  ({ key: `${agent}:${model}`, agent, model, name: model, label, profiles: [] });
const choices = [choice("claude", "opus", "Opus 5.5"), choice("claude", "sonnet", "Sonnet 5"), choice("gemini", "gemini-3-pro", "Gemini 3 Pro")];
const agent = (id: OnlineAgent["id"]): OnlineAgent => ({ id, models: [], modelLabels: {}, modelOptions: {}, hostNames: ["Studio Mac"] });
const agents = [agent("claude"), agent("gemini"), agent("codex")];

type Props = Parameters<typeof TaskModelPicker>[0];
function show(props: Partial<Props> = {}) {
  return act(async () => root.render(
    <TaskModelPicker id="task-model-motion" label="Model for Motion graphics" value="same" choices={choices} agents={agents} onChange={() => {}} {...props} />,
  ));
}
const trigger = () => container.querySelector<HTMLButtonElement>("#task-model-motion")!;
const panel = () => container.querySelector<HTMLElement>('[role="dialog"][aria-label="Model selector"]');
const rows = () => [...container.querySelectorAll<HTMLElement>('[aria-label="Models"] [role="radio"]')].map(r => r.getAttribute("aria-label") ?? r.textContent);
const pressed = () => [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Providers"] button[aria-pressed="true"]')].map(b => b.textContent || b.getAttribute("aria-label"));
const open = () => act(async () => trigger().click());
const key = (target: EventTarget, init: KeyboardEventInit) =>
  act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
const byLabel = (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;

it("names the chosen model on its button, with its provider", async () => {
  await show();
  expect(trigger().getAttribute("aria-label")).toBe("Model for Motion graphics: Same as chat");
  expect(trigger().title).toBe("Same as chat");
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  await show({ value: "gemini:gemini-3-pro" });
  expect(trigger().textContent).toBe("Gemini 3 Pro");
  expect(trigger().title).toBe("Gemini · Gemini 3 Pro");
  await show({ value: "codex:gpt-6", missing: { agent: "codex", model: "gpt-6", name: "GPT-6" } });
  expect(trigger().textContent).toBe("GPT-6 (not signed in)");
  expect(trigger().title).toBe("Codex · GPT-6 (not signed in)");
  // A saved model nobody can name is shown as it was saved, with no provider to name.
  await show({ value: "claude:old-model" });
  expect(trigger().textContent).toBe("claude:old-model");
  expect(trigger().title).toBe("claude:old-model");
});

it("opens on every model with Same as chat first, and on the chosen model's provider", async () => {
  await show();
  await open();
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(panel());
  // Only providers with models get a button.
  expect([...container.querySelectorAll('[aria-label="Providers"] button')].map(b => b.textContent || b.getAttribute("aria-label"))).toEqual(["All", "Favorites", "Claude Code", "Gemini"]);
  expect(pressed()).toEqual(["All"]);
  expect(rows()).toEqual(["Same as chatThe chat’s model does it", "Claude Code · Opus 5.5", "Claude Code · Sonnet 5", "Gemini · Gemini 3 Pro"]);
  expect(container.querySelector('[aria-label="Models"] [aria-checked="true"]')!.textContent).toContain("Same as chat");
  await act(async () => trigger().click());
  expect(panel()).toBeNull();

  await show({ value: "claude:sonnet" });
  await open();
  expect(pressed()).toEqual(["Claude Code"]);
  expect(rows()).toEqual(["Same as chatThe chat’s model does it", "Claude Code · Opus 5.5", "Claude Code · Sonnet 5"]);
  expect(container.querySelector('[aria-label="Models"] [aria-checked="true"]')!.getAttribute("aria-label")).toBe("Claude Code · Sonnet 5");
});

it("saves a model picked, Same as chat picked back, and nothing for the one already chosen", async () => {
  const onChange = vi.fn();
  await show({ onChange });
  await open();
  await act(async () => byLabel("Gemini · Gemini 3 Pro").click());
  expect(onChange).toHaveBeenLastCalledWith("gemini:gemini-3-pro");
  expect(panel()).toBeNull();
  expect(document.activeElement).toBe(trigger());
  // Picking what's already chosen closes the selector without a save.
  await open();
  const same = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(r => r.textContent?.startsWith("Same as chat"))!;
  await act(async () => same.click());
  expect(onChange).toHaveBeenCalledTimes(1);
  await show({ value: "claude:opus", onChange });
  await open();
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(r => r.textContent?.startsWith("Same as chat"))!.click());
  expect(onChange).toHaveBeenLastCalledWith("same");
});

it("keeps a saved model that isn't signed in chosen, right under Same as chat", async () => {
  const onChange = vi.fn();
  await show({ value: "codex:gpt-6", missing: { agent: "codex", model: "gpt-6", name: "GPT-6" }, onChange });
  await open();
  expect(rows().slice(0, 2)).toEqual(["Same as chatThe chat’s model does it", "Codex · GPT-6 (not signed in)"]);
  const missing = byLabel("Codex · GPT-6 (not signed in)");
  expect(missing.getAttribute("aria-checked")).toBe("true");
  // It has no star.
  expect(container.querySelector('[aria-label^="Favorite Codex"]')).toBeNull();
  await act(async () => missing.click());
  expect(onChange).not.toHaveBeenCalled();
  expect(panel()).toBeNull();
});

it("shows one provider's models, or the favorites, and says when there are none to show", async () => {
  useModelPreferences.setState({ favorites: ["gemini:gemini-3-pro"] });
  await show();
  await open();
  // Favorites lead the list.
  expect(rows()).toEqual(["Same as chatThe chat’s model does it", "Gemini · Gemini 3 Pro", "Claude Code · Opus 5.5", "Claude Code · Sonnet 5"]);
  await act(async () => byLabel("Gemini").click());
  expect(pressed()).toEqual(["Gemini"]);
  // Within one provider the rows don't repeat its mark.
  expect(container.querySelectorAll('[aria-label="Models"] [role="radio"] svg').length).toBe(1);
  await act(async () => byLabel("Favorites").click());
  expect(rows()).toEqual(["Same as chatThe chat’s model does it", "Gemini · Gemini 3 Pro"]);
  await act(async () => byLabel("Favorite Gemini · Gemini 3 Pro").click());
  expect(rows()).toEqual(["Same as chatThe chat’s model does it"]);
  expect(container.textContent).toContain("Star a model to find it here.");
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Providers"] button')].find(b => b.textContent === "All")!.click());
  expect(rows()).toHaveLength(4);
});

it("types to search across providers, and Esc closes the search before the selector", async () => {
  await show();
  await open();
  // A plain letter typed on the selector opens the search with it.
  await key(panel()!, { key: "g" });
  const search = container.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
  expect(search.value).toBe("g");
  expect(document.activeElement).toBe(search);
  // A search doesn't lead with Same as chat.
  expect(rows()).toEqual(["Gemini · Gemini 3 Pro"]);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "nothing like it");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(rows()).toEqual([]);
  expect(container.textContent).toContain("No matching models.");
  // An input method's Esc is its own.
  await key(search, { key: "Escape", isComposing: true });
  expect(container.querySelector('input[aria-label="Search models"]')).not.toBeNull();
  const behind = vi.fn();
  document.addEventListener("keydown", behind);
  try {
    await key(search, { key: "Escape" });
    expect(container.querySelector('input[aria-label="Search models"]')).toBeNull();
    expect(document.activeElement).toBe(panel());
    expect(rows()).toHaveLength(4);
    await key(panel()!, { key: "Escape" });
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    // Settings behind the selector never hear its Esc.
    expect(behind).not.toHaveBeenCalled();
  } finally {
    document.removeEventListener("keydown", behind);
  }
});

it("leaves modified keys, Space and other keys to the selector's own handling", async () => {
  await show();
  await open();
  for (const init of [{ key: "k", metaKey: true }, { key: "k", ctrlKey: true }, { key: "k", altKey: true }, { key: " " }, { key: "Enter" }]) {
    await key(panel()!, init);
  }
  expect(container.querySelector('input[aria-label="Search models"]')).toBeNull();
  // ↓ from the selector steps into the model list.
  await key(panel()!, { key: "ArrowDown" });
  expect(document.activeElement?.textContent).toContain("Same as chat");
  await key(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Claude Code · Opus 5.5");
  // A letter typed on a row also opens the search.
  await key(document.activeElement!, { key: "s" });
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!.value).toBe("s");
});

it("opens the search from its button and closes it from its ×", async () => {
  await show();
  await open();
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Search models"]')!.click());
  expect(document.activeElement).toBe(container.querySelector('input[aria-label="Search models"]'));
  await act(async () => byLabel("Close search").click());
  expect(container.querySelector('input[aria-label="Search models"]')).toBeNull();
  expect(document.activeElement).toBe(panel());
});

it("closes on a press outside it, but not on one inside", async () => {
  const outside = document.createElement("button");
  document.body.append(outside);
  try {
    await show();
    await open();
    await act(async () => { panel()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(panel()).not.toBeNull();
    await act(async () => { outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(panel()).toBeNull();
  } finally {
    outside.remove();
  }
});

it("offers only Same as chat when no model is signed in, and typing searches nothing", async () => {
  await show({ choices: [] });
  await open();
  expect(container.querySelector('[aria-label="Providers"]')).toBeNull();
  expect(rows()).toEqual(["Same as chatThe chat’s model does it"]);
  await key(panel()!, { key: "o" });
  expect(container.querySelector('input[aria-label="Search models"]')).toBeNull();
});

it("places the selector again when the window resizes or scrolls, and stops once closed", async () => {
  await show();
  await open();
  const menu = panel()!;
  expect(menu.style.top).not.toBe("");
  menu.style.top = "";
  await act(async () => { window.dispatchEvent(new Event("resize")); });
  expect(menu.style.top).not.toBe("");
  menu.style.top = "";
  await act(async () => { document.body.dispatchEvent(new Event("scroll")); });
  expect(menu.style.top).not.toBe("");
  await key(menu, { key: "Escape" });
  menu.style.top = "";
  await act(async () => { window.dispatchEvent(new Event("resize")); });
  expect(menu.style.top).toBe("");
});
