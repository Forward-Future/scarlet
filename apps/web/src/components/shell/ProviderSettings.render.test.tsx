// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentAvailability } from "@scarlet/shared";
import { desktop, type HostStatus, type ProviderSettingsChange, type ProviderSettingsView } from "../../lib/desktop";
import { useHostsStore } from "../../stores/hosts";
import { ProviderSettings } from "./ProviderSettings";

let root: Root;
let container: HTMLDivElement;
let saved: ProviderSettingsView;
/** What the desktop app reports about this computer's host, as the settings hear it. */
let report: (status: HostStatus) => void;
let save: ReturnType<typeof vi.fn<(change: ProviderSettingsChange) => Promise<HostStatus>>>;
let load: ReturnType<typeof vi.fn<() => Promise<void>>>;

const inDesktop = (on: boolean) => {
  if (on) (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  else delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
};
const claude: AgentAvailability = { id: "claude", installed: true, loggedIn: true };
const host = (agents: AgentAvailability[]): HostStatus => ({
  hostId: "host_1", agents, running: [], connected: true, serverUrl: null, name: "Studio Mac", error: null, mcpCommand: null, configured: true,
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  inDesktop(true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  report = () => {};
  saved = { ollama: { url: null, disabled: false }, lmstudio: { url: "http://gpu:1234", disabled: false }, openrouter: { hasKey: false, keyFromEnv: false, disabled: false } };
  vi.spyOn(desktop, "onHostStatus").mockImplementation(async cb => { report = cb; return () => { report = () => {}; }; });
  vi.spyOn(desktop, "hostStatus").mockResolvedValue(host([
    claude,
    { id: "ollama", installed: true, loggedIn: true, models: ["qwen3:8b"] },
    { id: "lmstudio", installed: false },
  ]));
  vi.spyOn(desktop, "providerSettings").mockImplementation(async () => saved);
  save = vi.fn(async (change: ProviderSettingsChange) => {
    if (change.provider === "openrouter") {
      saved = { ...saved, openrouter: { ...saved.openrouter, ...(change.apiKey !== undefined && { hasKey: !!change.apiKey }), ...(typeof change.disabled === "boolean" && { disabled: change.disabled }) } };
    } else {
      saved = { ...saved, [change.provider]: { ...saved[change.provider], ...(change.url !== undefined && { url: change.url }), ...(typeof change.disabled === "boolean" && { disabled: change.disabled }) } };
    }
    return host([claude, { id: "ollama", installed: true, loggedIn: true, models: ["qwen3:8b", "gpt-oss:20b"] }, { id: "openrouter", installed: true, loggedIn: true, models: ["a/b"] }]);
  });
  vi.spyOn(desktop, "saveProviderSettings").mockImplementation(change => save(change));
  load = vi.fn(async () => {});
  useHostsStore.setState({ load });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  inDesktop(false);
  useHostsStore.setState(useHostsStore.getInitialState(), true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const show = async () => {
  await act(async () => root.render(<ProviderSettings />));
  await act(async () => {});
};
const row = (id: string) => container.querySelector<HTMLElement>(`[data-provider="${id}"]`)!;
const status = (id: string) => row(id).querySelector(".text-muted")?.textContent;
const button = (within: HTMLElement, text: string) => [...within.querySelectorAll("button")].find(b => b.textContent?.trim() === text);
const toggle = (name: string) => container.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="Use ${name}"]`)!;
const field = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
async function typeInto(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const submit = (input: HTMLInputElement) => act(async () => { input.form!.requestSubmit(); });
const alert = () => container.querySelector('[role="alert"]')?.textContent;

it("shows nothing outside the desktop app", async () => {
  inDesktop(false);
  await show();
  expect(container.innerHTML).toBe("");
  expect(desktop.providerSettings).not.toHaveBeenCalled();
});

it("lists Ollama, LM Studio and OpenRouter with where each stands on this computer", async () => {
  await show();
  expect(container.querySelector("#providers-heading")?.textContent).toBe("Other providers");
  expect([...container.querySelectorAll("[data-provider]")].map(r => r.getAttribute("data-provider"))).toEqual(["ollama", "lmstudio", "openrouter"]);
  expect(status("ollama")).toBe("1 model ready");
  expect(status("lmstudio")).toBe("Couldn’t reach LM Studio at http://gpu:1234.");
  expect(status("openrouter")).toBe("Add your OpenRouter key to use its models.");
  expect(button(row("ollama"), "Address")).toBeDefined();
  expect(button(row("openrouter"), "Add key")?.getAttribute("aria-expanded")).toBe("false");
  expect([toggle("Ollama"), toggle("LM Studio"), toggle("OpenRouter")].map(t => t.getAttribute("aria-checked"))).toEqual(["true", "true", "true"]);
  expect(toggle("Ollama").disabled).toBe(false);
});

it("keeps its switches off until it has read the saved settings", async () => {
  vi.mocked(desktop.providerSettings).mockRejectedValue(new Error("no settings"));
  await show();
  expect(toggle("Ollama").disabled).toBe(true);
  expect(status("ollama")).toBe("1 model ready");
});

it("follows the host's live report", async () => {
  await show();
  await act(async () => report(host([claude, { id: "ollama", installed: false }])));
  expect(status("ollama")).toBe("Not running. Start Ollama on this computer.");
});

it("saves an address, shows what the host found with it, and reloads the hosts", async () => {
  await show();
  await act(async () => button(row("ollama"), "Address")!.click());
  const address = field("Ollama address");
  expect(address.placeholder).toBe("http://127.0.0.1:11434");
  expect(row("ollama").textContent).toContain("Leave empty for http://127.0.0.1:11434.");
  // With no saved address there's no default to go back to.
  expect(button(row("ollama"), "Use default")).toBeUndefined();
  await typeInto(address, "  http://gpu:11434  ");
  await submit(address);
  expect(save).toHaveBeenCalledWith({ provider: "ollama", url: "http://gpu:11434" });
  expect(load).toHaveBeenCalledTimes(1);
  expect(container.querySelector("form")).toBeNull();
  expect(status("ollama")).toBe("2 models ready · http://gpu:11434");
  expect(status("openrouter")).toBe("Add your OpenRouter key to use its models.");
});

it("clears an address saved empty, and offers Use default for one that was set", async () => {
  await show();
  await act(async () => button(row("lmstudio"), "Address")!.click());
  const address = field("LM Studio address");
  expect(address.value).toBe("http://gpu:1234");
  await act(async () => button(row("lmstudio"), "Use default")!.click());
  expect(save).toHaveBeenLastCalledWith({ provider: "lmstudio", url: null });
  await act(async () => button(row("lmstudio"), "Address")!.click());
  await typeInto(field("LM Studio address"), "   ");
  await submit(field("LM Studio address"));
  expect(save).toHaveBeenLastCalledWith({ provider: "lmstudio", url: null });
});

it("adds an OpenRouter key, then offers to change or remove it", async () => {
  await show();
  const add = button(row("openrouter"), "Add key")!;
  await act(async () => add.click());
  expect(add.getAttribute("aria-expanded")).toBe("true");
  const key = field("OpenRouter key");
  expect(key.type).toBe("password");
  expect(key.placeholder).toBe("sk-or-…");
  // Save waits for a key, and there's nothing to remove yet.
  expect(button(row("openrouter"), "Save")!.disabled).toBe(true);
  expect(button(row("openrouter"), "Remove key")).toBeUndefined();
  await typeInto(key, " sk-or-123 ");
  expect(button(row("openrouter"), "Save")!.disabled).toBe(false);
  await submit(key);
  expect(save).toHaveBeenCalledWith({ provider: "openrouter", apiKey: "sk-or-123" });
  expect(status("openrouter")).toBe("1 model. Turn on the ones you want in Model selector above.");
  await act(async () => button(row("openrouter"), "Change key")!.click());
  expect(field("OpenRouter key").value).toBe("");
  await act(async () => button(row("openrouter"), "Remove key")!.click());
  expect(save).toHaveBeenLastCalledWith({ provider: "openrouter", apiKey: null });
  expect(button(row("openrouter"), "Add key")).toBeDefined();
});

it("says a key comes from the environment, with no Remove for it", async () => {
  saved = { ...saved, openrouter: { hasKey: true, keyFromEnv: true, disabled: false } };
  await show();
  await act(async () => button(row("openrouter"), "Change key")!.click());
  expect(row("openrouter").textContent).toContain("Using OPENROUTER_API_KEY from your environment until you save one here.");
  expect(button(row("openrouter"), "Remove key")).toBeUndefined();
});

it("turns a provider off and back on, hiding its address while it's off", async () => {
  await show();
  await act(async () => toggle("Ollama").click());
  expect(save).toHaveBeenCalledWith({ provider: "ollama", disabled: true });
  expect(status("ollama")).toBe("Off");
  expect(toggle("Ollama").getAttribute("aria-checked")).toBe("false");
  expect(button(row("ollama"), "Address")).toBeUndefined();
  await act(async () => toggle("Ollama").click());
  expect(save).toHaveBeenLastCalledWith({ provider: "ollama", disabled: false });
  expect(button(row("ollama"), "Address")).toBeDefined();
});

it("says Checking… and keeps everything still while a save is out", async () => {
  let answer!: (status: HostStatus) => void;
  save.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
  await show();
  await act(async () => button(row("ollama"), "Address")!.click());
  await typeInto(field("Ollama address"), "http://gpu:11434");
  await submit(field("Ollama address"));
  expect(button(row("ollama"), "Checking…")!.disabled).toBe(true);
  expect(button(row("ollama"), "Cancel")!.disabled).toBe(true);
  expect(toggle("LM Studio").disabled).toBe(true);
  await act(async () => answer(host([claude])));
  expect(container.querySelector("form")).toBeNull();
  expect(toggle("LM Studio").disabled).toBe(false);
});

it("shows why a save failed and keeps what was typed", async () => {
  save.mockRejectedValueOnce(new Error("Couldn’t reach http://nowhere:1"));
  await show();
  await act(async () => button(row("ollama"), "Address")!.click());
  await typeInto(field("Ollama address"), "http://nowhere:1");
  await submit(field("Ollama address"));
  expect(alert()).toBe("Couldn’t reach http://nowhere:1");
  expect(field("Ollama address").value).toBe("http://nowhere:1");
  expect(load).not.toHaveBeenCalled();
  // Opening another row clears the error.
  await act(async () => button(row("lmstudio"), "Address")!.click());
  expect(alert()).toBeUndefined();
  expect(field("Ollama address")).toBeNull();
});

it("shows a failure that isn't an Error as it came", async () => {
  save.mockRejectedValueOnce("save_provider_settings failed");
  await show();
  await act(async () => toggle("LM Studio").click());
  expect(alert()).toBe("save_provider_settings failed");
});

it("closes the form with Cancel, Esc or its button again, but leaves Esc to an input method", async () => {
  await show();
  const address = () => button(row("ollama"), "Address")!;
  await act(async () => address().click());
  await act(async () => address().click());
  expect(container.querySelector("form")).toBeNull();

  await act(async () => address().click());
  await act(async () => button(row("ollama"), "Cancel")!.click());
  expect(container.querySelector("form")).toBeNull();

  await act(async () => address().click());
  const input = field("Ollama address");
  const esc = (init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init });
    input.dispatchEvent(event);
    return event;
  };
  const outside = vi.fn();
  window.addEventListener("keydown", outside);
  try {
    await act(async () => { esc({ isComposing: true }); });
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(container.querySelector("form")).not.toBeNull();
    let event!: KeyboardEvent;
    await act(async () => { event = esc(); });
    expect(event.defaultPrevented).toBe(true);
    expect(container.querySelector("form")).toBeNull();
    // Settings behind it don't hear the Esc that closed the form.
    expect(outside.mock.calls.map(([e]) => (e as KeyboardEvent).key)).toEqual(["Escape", "Enter"]);
  } finally {
    window.removeEventListener("keydown", outside);
  }
});
