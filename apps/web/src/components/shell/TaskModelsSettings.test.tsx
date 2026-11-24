// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DEFAULT_TASK_MODELS, TASK_MODELS_MAX, type ServerSettings } from "@scarlet/shared";
import { buildDb } from "../../lib/mock/fixtures";
import { api } from "../../lib/client";
import { useHostsStore } from "../../stores/hosts";
import { useModelPreferences } from "../../stores/modelPicker";
import { TaskModelsSettings } from "./TaskModelsSettings";

async function setup(taskModels: ServerSettings["taskModels"] = DEFAULT_TASK_MODELS) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const oldHosts = useHostsStore.getState();
  const oldPrefs = useModelPreferences.getState();
  const host = buildDb().hosts[0]!;
  useHostsStore.setState({ status: "ready", hosts: [{ ...host, online: true, agents: [
    { id: "claude", installed: true, models: ["opus"], modelLabels: { opus: "Opus 5.5" } },
    { id: "gemini", installed: true, models: ["gemini-3-pro"], modelLabels: { "gemini-3-pro": "Gemini 3 Pro" } },
  ] }] });
  useModelPreferences.setState({ hidden: [], favorites: [] });
  let saved: ServerSettings = { ...buildDb().settings, taskModels };
  vi.spyOn(api, "settings").mockImplementation(async () => ({ settings: saved, transcriptionAvailable: true }));
  const update = vi.spyOn(api, "updateSettings").mockImplementation(async patch => ({ settings: (saved = { ...saved, ...patch }) }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<TaskModelsSettings />));
  await act(async () => {});
  const cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
    useHostsStore.setState(oldHosts, true);
    useModelPreferences.setState(oldPrefs, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  };
  return { container, update, cleanup, saved: () => saved };
}

const names = (c: HTMLElement) => [...c.querySelectorAll<HTMLInputElement>(".task-model-name")].map(i => i.value);
/** Types into a field the way React hears it, then leaves it or presses a key. */
async function typeInto(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const leave = (input: HTMLInputElement) => act(async () => { input.focus(); input.blur(); });

it("lists Cutting and Motion graphics, on the chat's model, and saves a model picked for one", async () => {
  const { container, update, cleanup } = await setup();
  try {
    expect(container.querySelector("h2")?.textContent).toBe("Task models");
    expect(names(container)).toEqual(["Cutting", "Motion graphics"]);
    expect([...container.querySelectorAll<HTMLInputElement>(".task-model-description")].map(i => i.value)).toEqual(DEFAULT_TASK_MODELS.map(t => t.description));
    const pick = container.querySelector<HTMLButtonElement>("#task-model-motion-graphics")!;
    expect(pick.textContent).toContain("Same as chat");
    await act(async () => pick.click());
    expect([...document.querySelectorAll("[role=option]")].map(o => o.textContent)).toEqual(["Same as chat", "Opus 5.5", "Gemini 3 Pro"]);
    await act(async () => [...document.querySelectorAll<HTMLElement>("[role=option]")].find(o => o.textContent === "Gemini 3 Pro")!.click());
    expect(update).toHaveBeenLastCalledWith({ taskModels: [DEFAULT_TASK_MODELS[0], { ...DEFAULT_TASK_MODELS[1], model: "gemini:gemini-3-pro" }] });
    expect(container.querySelector("#task-model-motion-graphics")!.textContent).toContain("Gemini 3 Pro");
  } finally {
    await cleanup();
  }
});

it("adds a task named New task, renames it, describes it, and deletes one", async () => {
  const { container, update, cleanup, saved } = await setup();
  try {
    const add = [...container.querySelectorAll("button")].find(b => b.textContent === "Add task")!;
    await act(async () => add.click());
    expect(names(container)).toEqual(["Cutting", "Motion graphics", "New task"]);
    expect(update).toHaveBeenLastCalledWith({ taskModels: [...DEFAULT_TASK_MODELS, { id: "new-task", name: "New task", description: "", model: "same" }] });
    // The new row's name is ready to type over.
    const name = container.querySelectorAll<HTMLInputElement>(".task-model-name")[2]!;
    expect(document.activeElement).toBe(name);
    await typeInto(name, "  Captions ");
    await act(async () => name.blur());
    expect(saved().taskModels[2]).toEqual({ id: "new-task", name: "Captions", description: "", model: "same" });
    const description = container.querySelector<HTMLInputElement>('[aria-label="What counts as Captions"]')!;
    expect(description.placeholder).toBe("What counts as this work");
    await typeInto(description, "Words on screen for what's said.");
    await act(async () => description.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await leave(description);
    expect(saved().taskModels[2]!.description).toBe("Words on screen for what's said.");
    // An emptied name goes back to what it was, and nothing is saved.
    const calls = update.mock.calls.length;
    const cutting = container.querySelectorAll<HTMLInputElement>(".task-model-name")[0]!;
    await typeInto(cutting, "   ");
    await leave(cutting);
    expect(cutting.value).toBe("Cutting");
    expect(update.mock.calls.length).toBe(calls);
    // Delete takes the row out.
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Delete Motion graphics"]')!.click());
    expect(names(container)).toEqual(["Cutting", "Captions"]);
    expect(saved().taskModels.map(t => t.id)).toEqual(["cutting", "new-task"]);
  } finally {
    await cleanup();
  }
});

it("keeps a model that isn't signed in now, saying so, and offers no Add at the limit", async () => {
  const many = Array.from({ length: TASK_MODELS_MAX }, (_, i) => ({ id: `t${i}`, name: `Task ${i}`, description: "", model: i === 0 ? "codex:gpt-6" : "same" }));
  const { container, cleanup } = await setup(many);
  try {
    expect(container.querySelector("#task-model-t0")!.textContent).toContain("gpt-6 (not signed in)");
    expect([...container.querySelectorAll("button")].some(b => b.textContent === "Add task")).toBe(false);
  } finally {
    await cleanup();
  }
});
