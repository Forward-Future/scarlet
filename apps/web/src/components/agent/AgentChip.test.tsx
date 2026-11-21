// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { expect, it, onTestFinished, vi } from "vitest";
import type { AgentHost } from "@scarlet/shared";
import { api } from "../../lib/client";
import { buildDb, PRJ } from "../../lib/mock/fixtures";
import { desktop, type AgentLoginStatus, type HostStatus } from "../../lib/desktop";
import { ProjectLayout } from "../shell/ProjectLayout";
import { usePlayerStore } from "../../stores/player";
import { useProjectStore } from "../../stores/project";
import { SettingsPage } from "../../pages/SettingsPage";
import { useHostsStore } from "../../stores/hosts";
import { useModelPreferences } from "../../stores/modelPicker";
import { useUiStore } from "../../stores/ui";
import { AgentChip } from "./AgentChip";
import { Dropdown } from "../shell/WorkspaceNavigation";
import { ModelSettings } from "../shell/ModelSettings";

function modelHost(models: string[]): AgentHost {
  return { ...buildDb().hosts[0]!, online: true, agents: [{
    id: "codex", installed: true, loggedIn: true, models,
    modelOptions: { "gpt-6.1-sol": { efforts: [{ id: "high" }], speeds: [{ id: "priority" }] } },
  }] };
}

function setupModelRefresh(initial: AgentHost) {
  const oldHosts = useHostsStore.getState();
  const oldUi = useUiStore.getState();
  const oldPrefs = useModelPreferences.getState();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  const hostStatus: HostStatus = { hostId: initial.id, agents: initial.agents, connected: true, configured: true,
    name: initial.name, running: [], serverUrl: null, error: null, mcpCommand: null };
  vi.spyOn(desktop, "hostStatus").mockResolvedValue(hostStatus);
  vi.spyOn(desktop, "onHostStatus").mockResolvedValue(() => {});
  vi.spyOn(desktop, "info").mockResolvedValue({ version: "test", platform: "macos", arch: "arm64",
    configFile: "", dataDir: "", workDir: "", logDir: "", customOpenaiModels: ["studio-model"] });
  const discover = vi.spyOn(desktop, "hostRefreshAgents").mockResolvedValue(hostStatus);
  const readHosts = vi.spyOn(api, "hosts").mockResolvedValue({ hosts: [initial] });
  useHostsStore.setState({ hosts: [initial], status: "ready", error: null, customOpenaiModels: [], customClaudeModels: [] });
  useUiStore.setState({ agentSetupOpen: false, agent: { agent: "codex", model: "gpt-6.1-sol", effort: "high", serviceTier: "priority" } });
  useModelPreferences.setState({ hidden: ["codex:gpt-6-luna"], favorites: ["codex:gpt-6.1-sol"] });
  const container = document.createElement("div");
  const root = createRoot(container);
  onTestFinished(async () => {
    await act(() => root.unmount());
    useHostsStore.setState(oldHosts, true);
    useUiStore.setState(oldUi, true);
    useModelPreferences.setState(oldPrefs, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  return { container, root, hostStatus, discover, readHosts };
}

function refreshButton(container: Element) {
  const button = [...container.querySelectorAll("button")].find(b => b.textContent === "Refresh models");
  expect(button).toBeDefined();
  return button!;
}

it("refreshes the open picker and shares one discovery with Settings while preserving model preferences", async () => {
  const oldModels = ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"];
  const { container, root, hostStatus, discover, readHosts } = setupModelRefresh(modelHost(oldModels));
  readHosts.mockResolvedValue({ hosts: [modelHost(["gpt-6.1-sol", "gpt-6-luna", "gpt-6.2-sol", "studio-model"])] });
  let finishDiscovery!: (value: HostStatus) => void;
  discover.mockReturnValueOnce(new Promise(resolve => { finishDiscovery = resolve; }));
  await act(() => root.render(<MemoryRouter><AgentChip /><ModelSettings /></MemoryRouter>));
  const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
  await act(() => trigger.click());
  const picker = container.querySelector('[aria-label="Model selector"]')!;
  const refreshPicker = refreshButton(picker);
  const refreshSettings = refreshButton(container.querySelector("section")!);
  try {
    await act(() => { refreshPicker.click(); refreshPicker.click(); refreshSettings.click(); });
    expect(discover).toHaveBeenCalledTimes(1);
    expect(readHosts).not.toHaveBeenCalled();
    expect(refreshPicker.disabled).toBe(true);
    expect(refreshSettings.disabled).toBe(true);
    expect(picker.querySelector('[aria-label="Codex · gpt-6-astra"]')).toBeTruthy();
  } finally {
    await act(() => finishDiscovery(hostStatus));
  }
  expect(readHosts).toHaveBeenCalledTimes(1);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(picker.querySelector('[role="status"]')?.textContent).toContain("Models refreshed");
  expect(refreshPicker.disabled).toBe(false);
  expect(refreshSettings.disabled).toBe(false);
  expect(picker.querySelector('[aria-label="Codex · gpt-6.2-sol"]')).toBeTruthy();
  expect(picker.querySelector('[aria-label="Codex · studio-model · Custom"]')).toBeTruthy();
  expect(picker.querySelector('[aria-label="Codex · gpt-6-astra"]')).toBeNull();
  expect(picker.querySelector('[aria-label="Codex · gpt-6-luna"]')).toBeNull();
  expect(picker.querySelector('[aria-label="Favorite Codex · gpt-6.1-sol"]')?.getAttribute("aria-pressed")).toBe("true");
  expect(picker.querySelector('[aria-label="Codex · gpt-6.1-sol"]')?.getAttribute("aria-checked")).toBe("true");
  expect(useUiStore.getState().agent).toEqual({ agent: "codex", model: "gpt-6.1-sol", effort: "high", serviceTier: "priority" });
});

it("refreshes an empty catalog directly and lets the editor retry a failed discovery from the picker", async () => {
  const { container, root, discover, readHosts, hostStatus } = setupModelRefresh(modelHost([]));
  discover.mockResolvedValueOnce({ ...hostStatus, error: "Codex timed out. Try refreshing again." });
  await act(() => root.render(<MemoryRouter initialEntries={["/p/test"]}>
    <Dropdown label="More" button="⋯">{() => <AgentChip variant="menu" />}</Dropdown>
  </MemoryRouter>));
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="More"]')!.click());
  const row = container.querySelector<HTMLButtonElement>('[role="menuitem"][aria-label="Refresh models"]')!;
  await act(() => row.click());
  const picker = container.querySelector('[aria-label="Model selector"]')!;
  expect(discover).toHaveBeenCalledTimes(1);
  expect(useUiStore.getState().agentSetupOpen).toBe(false);
  expect(picker.querySelector('[role="alert"]')?.textContent).toContain("Codex timed out. Try refreshing again.");
  expect(picker.textContent).not.toContain("Models refreshed");

  readHosts.mockResolvedValue({ hosts: [modelHost(["gpt-6.2-sol"])] });
  await act(() => refreshButton(picker).click());
  expect(row.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector('[role="menu"]')).toBeTruthy();
  expect(discover).toHaveBeenCalledTimes(2);
  expect(picker.querySelector('[role="alert"]')).toBeNull();
  expect(picker.querySelector('[role="status"]')?.textContent).toContain("Models refreshed");
  expect(picker.querySelector('[aria-label="Codex · gpt-6.2-sol"]')).toBeTruthy();
});

it("shows the model name and effort dial and returns focus after keyboard navigation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const oldHosts = useHostsStore.getState();
  const oldUi = useUiStore.getState();
  const savedPick = localStorage.getItem("scarlet.agent");
  const model = "aurora-alpha";
  const host = { ...buildDb().hosts[0]!, online: true };
  useHostsStore.setState({ customOpenaiModels: [model], hosts: [{ ...host, agents: [{
    id: "codex", installed: true, models: [model, "gpt-6-astra"], modelLabels: { [model]: "Aurora Alpha" },
    modelOptions: {
      [model]: { efforts: [{ id: "medium" }, { id: "high" }], defaultEffort: "medium", speeds: [{ id: "priority" }] },
      "gpt-6-astra": { efforts: [{ id: "low" }], defaultEffort: "low", speeds: [] },
    },
  }] }, { ...host, id: "second", agents: [{ id: "codex", installed: true, models: ["gpt-6-astra"] }] }] });
  useUiStore.setState({ agent: { agent: "codex", model, serviceTier: "priority" } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const press = (key: string) => act(() => {
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  try {
    await act(() => root.render(<MemoryRouter><AgentChip /></MemoryRouter>));
    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
    expect(trigger.textContent).toBe("Aurora Alpha");
    expect(trigger.querySelectorAll("svg")).toHaveLength(1);
    expect(trigger.title).toBe("Thinking effort: Medium (provider default)");
    expect(trigger.getAttribute("aria-label")).toContain(trigger.title);
    // What is picked is the model, by that name.
    expect(trigger.getAttribute("aria-label")).toMatch(/^Model: Codex · Aurora Alpha\. .* Change model, effort or speed$/);
    const defaultDial = trigger.querySelector("svg")!.innerHTML;

    await act(() => trigger.click());
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Search models");
    await press("ArrowDown");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Codex · Aurora Alpha · Custom");
    const effortButtons = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Effort"] [role="radio"]')];
    const high = effortButtons.find(button => button.textContent === "High")!;
    effortButtons.find(button => button.textContent === "Medium")!.focus();
    await press("ArrowDown");
    expect(document.activeElement).toBe(high);
    await act(() => high.click());
    await press("Escape");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(trigger.textContent).toBe("Aurora Alpha");
    expect(trigger.querySelector("svg")!.innerHTML).not.toBe(defaultDial);
    expect(trigger.title).toBe("Thinking effort: High");
    expect(trigger.getAttribute("aria-label")).toContain(trigger.title);
    expect(useUiStore.getState().agent.serviceTier).toBe("priority");

    await act(() => trigger.click());
    await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Codex · gpt-6-astra"]')!.click());
    await press("Escape");
    expect(trigger.textContent).toBe("gpt-6-astra");
    expect(trigger.title).toBe("Thinking effort: Provider default");
  } finally {
    await act(() => root.unmount());
    container.remove();
    useUiStore.setState(oldUi, true);
    useHostsStore.setState(oldHosts, true);
    if (savedPick === null) localStorage.removeItem("scarlet.agent");
    else localStorage.setItem("scarlet.agent", savedPick);
    vi.unstubAllGlobals();
  }
});

it("lists Standard once when the model names its own standard speed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const oldHosts = useHostsStore.getState();
  const oldUi = useUiStore.getState();
  const savedPick = localStorage.getItem("scarlet.agent");
  const host = { ...buildDb().hosts[0]!, online: true };
  useHostsStore.setState({ hosts: [{ ...host, agents: [{
    id: "claude", installed: true, models: ["claude-opus-5-5"], modelLabels: { "claude-opus-5-5": "Opus 5.5" },
    modelOptions: { "claude-opus-5-5": { efforts: [{ id: "high" }], speeds: [{ id: "standard", label: "Standard" }, { id: "fast", label: "Fast" }] } },
  }] }] });
  useUiStore.setState({ agent: { agent: "claude", model: "claude-opus-5-5" } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(<MemoryRouter><AgentChip /></MemoryRouter>));
    await act(() => container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!.click());
    const speeds = () => [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Speed"] [role="radio"]')];
    expect(speeds().map(b => b.textContent)).toEqual(["Standard", "Fast"]);
    expect(speeds()[0]!.getAttribute("aria-checked")).toBe("true");
    await act(() => speeds()[1]!.click());
    expect(useUiStore.getState().agent.serviceTier).toBe("fast");
    await act(() => speeds()[0]!.click());
    expect(useUiStore.getState().agent.serviceTier).toBe("standard");
  } finally {
    await act(() => root.unmount());
    container.remove();
    useUiStore.setState(oldUi, true);
    useHostsStore.setState(oldHosts, true);
    if (savedPick === null) localStorage.removeItem("scarlet.agent");
    else localStorage.setItem("scarlet.agent", savedPick);
    vi.unstubAllGlobals();
  }
});

it("saves picker changes to the desktop in order even when WebView storage rejects the write", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  const oldHosts = useHostsStore.getState();
  const oldUi = useUiStore.getState();
  const oldWrite = localStorage.getItem("scarlet.agent");
  const write = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("Storage is full"); });
  vi.spyOn(desktop, "hostStatus").mockResolvedValue({
    agents: [], hostId: null, running: [], connected: false, configured: false, serverUrl: null, name: null, error: null, mcpCommand: null,
  });
  vi.spyOn(desktop, "onHostStatus").mockResolvedValue(() => {});
  let finishWrite!: () => void;
  const firstWrite = new Promise<void>(resolve => { finishWrite = resolve; });
  const save = vi.spyOn(desktop, "saveEditorModel").mockReturnValueOnce(firstWrite).mockResolvedValue(undefined);
  const host = { ...buildDb().hosts[0]!, online: true };
  useHostsStore.setState({ hosts: [{ ...host, agents: [{
    id: "codex", installed: true, model: "gpt-6.1-sol", models: ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra"],
  }] }] });
  useUiStore.setState({ agent: { agent: "claude" }, agentSelected: false });
  useUiStore.getState().setDefaultAgent("codex");
  expect(useUiStore.getState().agent).toEqual({ agent: "codex" });
  expect(save).not.toHaveBeenCalled();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const click = (selector: string) => act(() => container.querySelector<HTMLButtonElement>(selector)!.click());
  try {
    await act(() => root.render(<MemoryRouter><AgentChip /></MemoryRouter>));
    await click('[aria-haspopup="dialog"]');
    await click('[aria-label="Codex · gpt-6.1-terra"]');
    await click('[aria-label="Codex · gpt-6-astra"]');
    expect(container.querySelector('[aria-haspopup="dialog"]')?.textContent).toBe("gpt-6-astra");
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agent: "codex", model: "gpt-6.1-terra" }));
    finishWrite();
    await vi.waitFor(() => expect(save).toHaveBeenNthCalledWith(2, expect.objectContaining({ agent: "codex", model: "gpt-6-astra" })));

    const catalog = useHostsStore.getState().hosts;
    await act(() => useHostsStore.setState({ hosts: [{ ...host, agents: [{
      id: "codex", installed: true, model: "gpt-6.1-sol", models: ["gpt-6.1-sol"],
    }] }] }));
    expect(container.querySelector('[aria-haspopup="dialog"]')?.textContent).toBe("gpt-6.1-sol");
    await act(() => useHostsStore.setState({ hosts: catalog }));
    expect(container.querySelector('[aria-haspopup="dialog"]')?.textContent).toBe("gpt-6-astra");
    expect(save).toHaveBeenCalledTimes(2);
  } finally {
    finishWrite();
    await act(() => root.unmount());
    container.remove();
    useUiStore.setState(oldUi, true);
    useHostsStore.setState(oldHosts, true);
    write.mockRestore();
    if (oldWrite === null) localStorage.removeItem("scarlet.agent");
    else localStorage.setItem("scarlet.agent", oldWrite);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("keeps the Esc that closes the picker from the dialog around it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const oldHosts = useHostsStore.getState();
  useHostsStore.setState({ hosts: buildDb().hosts });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const esc = async () => {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(() => { document.activeElement!.dispatchEvent(event); });
    return event;
  };
  try {
    // As in a note, where the picker sits inside a native dialog.
    await act(() => root.render(<MemoryRouter><dialog open><AgentChip /></dialog></MemoryRouter>));
    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
    await act(() => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // A native dialog cancels on an Esc that nothing claimed, and what was typed in it is lost. The picker claims this one.
    const closing = await esc();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(closing.defaultPrevented).toBe(true);
    // With the picker closed, Esc is the dialog's again.
    expect((await esc()).defaultPrevented).toBe(false);
  } finally {
    await act(() => root.unmount());
    container.remove();
    useHostsStore.setState(oldHosts, true);
    vi.unstubAllGlobals();
  }
});

it("closes only the picker on Esc when it opened from a menu's Model row, and gives the row the focus", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const oldHosts = useHostsStore.getState();
  useHostsStore.setState({ hosts: buildDb().hosts });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const esc = () => act(() => {
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  try {
    // As in the simple view's ⋯ menu, where the Model row opens the selector beside the menu.
    await act(() => root.render(<MemoryRouter><Dropdown label="More" button="⋯">{() => <AgentChip variant="menu" />}</Dropdown></MemoryRouter>));
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="More"]')!.click());
    const row = container.querySelector<HTMLButtonElement>('[role="menu"] [aria-haspopup="dialog"]')!;
    await act(() => row.click());
    expect(container.querySelector('[aria-label="Model selector"]')).toBeTruthy();
    await esc();
    expect(container.querySelector('[aria-label="Model selector"]')).toBeNull();
    expect(container.querySelector('[role="menu"]')).toBeTruthy();
    expect(document.activeElement).toBe(row);
    // With the picker closed, the next Esc is the menu's.
    await esc();
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('button[aria-label="More"]'));
  } finally {
    await act(() => root.unmount());
    container.remove();
    useHostsStore.setState(oldHosts, true);
    vi.unstubAllGlobals();
  }
});

it("opens a menu row's model selector beside the menu when there is room, and under the row when narrow", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const oldHosts = useHostsStore.getState();
  useHostsStore.setState({ hosts: buildDb().hosts, status: "ready" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const selectorSize = (size: number) => function (this: HTMLElement) { return this.getAttribute("aria-label") === "Model selector" ? size : 0; };
  try {
    vi.stubGlobal("innerWidth", 1280);
    vi.stubGlobal("innerHeight", 780);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(selectorSize(352));
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(selectorSize(250));
    await act(() => root.render(<MemoryRouter><Dropdown label="More" button="⋯">{() => <AgentChip variant="menu" direction="down" />}</Dropdown></MemoryRouter>));
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="More"]')!.click());
    const row = container.querySelector<HTMLButtonElement>('[role="menu"] [aria-haspopup="dialog"]')!;
    vi.spyOn(container.querySelector('[role="menu"]')!, "getBoundingClientRect").mockReturnValue(new DOMRect(130, 50, 240, 312));
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(new DOMRect(134, 246, 232, 32));
    await act(() => row.click());
    const selector = () => container.querySelector<HTMLElement>('[role="dialog"][aria-label="Model selector"]')!;
    expect([selector().style.left, selector().style.top]).toEqual(["376px", "246px"]);
    // Narrow window: falls back under the row.
    vi.stubGlobal("innerWidth", 560);
    await act(() => { window.dispatchEvent(new Event("resize")); });
    expect([selector().style.left, selector().style.top]).toEqual(["14px", "284px"]);
  } finally {
    await act(() => root.unmount());
    container.remove();
    useHostsStore.setState(oldHosts, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("says the model list couldn't be read, with Refresh to try again, when a signed-in agent offers no models", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const oldHosts = useHostsStore.getState();
  // Codex is signed in and online, but its list of models couldn't be read, so it offers none.
  const host = { ...buildDb().hosts[0]!, online: true, agents: [{ id: "codex" as const, installed: true, loggedIn: true, models: [] }] };
  useHostsStore.setState({ hosts: [host], status: "ready", error: null });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(<MemoryRouter><AgentChip /><ModelSettings /></MemoryRouter>));
    const chip = container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
    expect([chip.textContent?.trim(), chip.title]).toEqual(["Refresh models", "Couldn’t read the model list. Refresh models to try again."]);
    expect(container.textContent).toContain("Couldn’t read the model list. Refresh models to try again, and update Claude Code, Codex or Gemini if it still fails.");
    expect(container.textContent).not.toContain("current-generation");
  } finally {
    await act(() => root.unmount());
    container.remove();
    useHostsStore.setState(oldHosts, true);
    vi.unstubAllGlobals();
  }
});

it("installs Codex and signs in without leaving the project or clearing the draft", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  const stores = [useUiStore.getState(), useProjectStore.getState(), useHostsStore.getState(), usePlayerStore.getState()] as const;
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  useProjectStore.setState({ status: "ready", load: vi.fn(), current: {
    id: PRJ, project, timeline: null, media: project.media, changes: [],
    notes: [], renders: [], tasks: [], taskEvents: {}, versions: [],
  } });
  useHostsStore.setState({ hosts: [], status: "loading" });
  usePlayerStore.setState({ time: 12 });
  useUiStore.setState({ agentSetupOpen: false, agentDraft: "Tighten the pause", agentContext: { time: 12, clipIds: [] } });
  let host: HostStatus = { hostId: "local", agents: [{ id: "codex", installed: false }], connected: true, configured: true,
    running: [], serverUrl: null, name: "Here", error: null, mcpCommand: null };
  const listeners = new Set<(status: HostStatus) => void>();
  vi.spyOn(desktop, "onHostStatus").mockImplementation(async cb => { listeners.add(cb); return () => { listeners.delete(cb); }; });
  vi.spyOn(desktop, "hostStatus").mockImplementation(async () => host);
  vi.spyOn(desktop, "engineStatus").mockResolvedValue({ state: "ready" } as Awaited<ReturnType<typeof desktop.engineStatus>>);
  vi.spyOn(desktop, "onEngineStatus").mockResolvedValue(() => {});
  vi.spyOn(desktop, "onAgentLogin").mockResolvedValue(() => {});
  vi.spyOn(desktop, "agentLoginStatus").mockResolvedValue(null);
  const install = vi.spyOn(desktop, "agentInstall").mockImplementation(async () => {
    host = { ...host, agents: [{ id: "codex", installed: true, loggedIn: false }] };
    listeners.forEach(cb => cb(host));
    return "installed";
  });
  const login = vi.spyOn(desktop, "agentLoginStart").mockResolvedValue({ agent: "codex", state: "waiting", acceptsCode: false });
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const click = (label: string) => act(async () => {
    const button = [...el.querySelectorAll("button")].find(b => b.textContent?.trim() === label);
    expect(button, label).toBeTruthy();
    button!.click();
  });
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={[`/p/${PRJ}`]}><Routes>
      <Route path="/p/:id" element={<ProjectLayout />}><Route index element={<AgentChip />} /></Route>
    </Routes></MemoryRouter>));
    expect(el.textContent).not.toContain("Set up a model");
    await act(() => {
      listeners.forEach(cb => cb({ ...host, agents: [] }));
      useHostsStore.setState({ status: "ready" });
    });
    expect(el.textContent).not.toContain("Set up a model");
    await act(() => {
      listeners.forEach(cb => cb(host));
      useHostsStore.setState({ hosts: db.hosts.map(h => ({ ...h, online: false })) });
    });
    expect(el.textContent).not.toContain("Set up a model");
    await act(() => useHostsStore.setState({ hosts: [] }));
    await click("Set up a model");
    // The dialog is the sign-in card, in the card's words.
    expect(el.querySelector("dialog[open] h2")?.textContent).toBe("Sign in");
    expect(el.querySelector("dialog[open] p")?.textContent).toBe("Choose Claude Code, Codex or Gemini. Install it if needed, then sign in with your subscription.");
    await click("Install Codex");
    expect(install).toHaveBeenCalledWith("codex");
    await click("Sign in with ChatGPT");
    expect(login).toHaveBeenCalledWith("codex");
    await act(async () => {
      host = { ...host, agents: [{ id: "codex", installed: true, loggedIn: true, auth: "subscription" }] };
      listeners.forEach(cb => cb(host));
    });
    expect(el.querySelector("dialog[open]")).toBeNull();
    expect(el.textContent).not.toContain("Set up a model");
    expect(useUiStore.getState()).toMatchObject({ agentDraft: "Tighten the pause", agentContext: { time: 12 }, agentSetupOpen: false });
    expect(usePlayerStore.getState().time).toBe(12);
  } finally {
    await act(async () => root.unmount());
    el.remove();
    useUiStore.setState(stores[0], true);
    useProjectStore.setState(stores[1], true);
    useHostsStore.setState(stores[2], true);
    usePlayerStore.setState(stores[3], true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("shares provider-scoped visibility and favorites between Settings and the picker across reloads", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const oldHosts = useHostsStore.getState();
  const oldUi = useUiStore.getState();
  const oldPrefs = useModelPreferences.getState();
  const host = buildDb().hosts[0]!;
  useHostsStore.setState({ hosts: [{ ...host, online: true, agents: [
    { id: "codex", installed: true, models: ["gpt-6.1-sol", "gpt-6-astra"], model: "gpt-6.1-sol", modelLabels: { "gpt-6.1-sol": "Shared", "gpt-6-astra": "New model" },
      modelOptions: { "gpt-6.1-sol": { efforts: [{ id: "auto" }, { id: "ultra" }], speeds: [{ id: "priority", label: "Expedited" }] }, "gpt-6-astra": { efforts: [], speeds: [] } } },
    { id: "claude", installed: true, models: ["claude-opus-5-5"], model: "claude-opus-5-5", modelLabels: { "claude-opus-5-5": "Shared" } },
  ] }, { ...host, id: "second", online: true, agents: [{ id: "codex", installed: true, models: ["gpt-6.1-sol"],
    modelOptions: { "gpt-6.1-sol": { efforts: [{ id: "low" }], speeds: [{ id: "economy", label: "Economy" }] } } }] }] });
  useUiStore.setState({ agent: { agent: "codex", model: "gpt-6.1-sol" } });
  const container = document.createElement("div");
  const root = createRoot(container);
  const button = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
  const click = (el: HTMLElement) => act(() => el.click());
  const picker = () => container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
  let mount = 0;
  const render = (url: string) => act(() => root.render(
    <MemoryRouter key={++mount} initialEntries={[url]}><Routes>
      <Route path="/" element={<AgentChip />} /><Route path="/settings" element={<SettingsPage />} />
    </Routes></MemoryRouter>,
  ));
  try {
    await render("/");
    await click(picker());
    await click(button("Favorite Codex · New model"));
    await click(button("Favorites"));
    expect(button("Codex · New model")).toBeTruthy();
    expect(button("Codex · Shared")).toBeNull();
    const search = container.querySelector<HTMLInputElement>('[aria-label="Search models"]')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "shared");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button("Codex · New model")).toBeNull();
    expect(button("Codex · Shared")).toBeTruthy();
    expect(button("Claude Code · Shared")).toBeTruthy();
    await click(button("Codex"));
    expect(search.value).toBe("");
    expect(button("Claude Code · Shared")).toBeNull();
    const option = (group: string, label: string) => [...container.querySelectorAll<HTMLButtonElement>(`[aria-label="${group}"] button`)].find(b => b.textContent === label)!;
    expect(option("Effort", "Auto")).toBeUndefined();
    await click(option("Effort", "Ultra"));
    await click(option("Speed", "Expedited"));
    expect(useUiStore.getState().agent).toMatchObject({ effort: "ultra", serviceTier: "priority" });
    await click(option("Speed", "Economy"));
    expect(useUiStore.getState().agent.effort).toBeUndefined();
    await click(option("Effort", "Ultra"));
    expect(useUiStore.getState().agent.serviceTier).toBeUndefined();
    await click(button("Codex · New model"));
    expect(container.querySelector('[aria-label="Speed"]')).toBeNull();
    expect(container.querySelector('[aria-label="Effort"]')).toBeNull();
    expect(useUiStore.getState().agent.serviceTier).toBeUndefined();
    expect(useUiStore.getState().agent.effort).toBeUndefined();
    await click(button("Codex · Shared"));
    expect(picker().textContent).toContain("Shared");
    expect(container.querySelector('[aria-label="Models"] [role="radio"]')?.textContent).toContain("New model");
    await click(container.querySelector<HTMLAnchorElement>('a[href="/settings#models"]')!);
    await click(button("Show Codex · Shared in selector"));
    await click(button("Claude Code"));
    expect(button("Show Claude Code · Shared in selector").getAttribute("aria-checked")).toBe("true");
    await click(button("Codex"));
    expect(button("Favorite Codex · New model").getAttribute("aria-pressed")).toBe("true");

    const snapshot = localStorage.getItem("scarlet.modelPicker.v1")!;
    await act(() => useModelPreferences.setState({ hidden: [], favorites: [] }));
    localStorage.setItem("scarlet.modelPicker.v1", snapshot);
    await act(async () => { await useModelPreferences.persist.rehydrate(); });
    await render("/");
    await click(picker());
    expect(button("Codex · Shared")).toBeNull();
    expect(button("Claude Code · Shared")).toBeNull();
    expect(button("Codex · New model").getAttribute("aria-checked")).toBe("true");
    await click(button("Claude Code"));
    await click(button("Claude Code · Shared"));
    expect(useUiStore.getState().agent).toMatchObject({ agent: "claude", model: "claude-opus-5-5" });

    await render("/settings#models");
    await click(button("Claude Code"));
    await click(button("Hide all Claude Code models"));
    await click(button("Codex"));
    await click(button("Hide all Codex models"));
    await render("/");
    expect(container.querySelector('a[href="/settings#models"]')?.textContent).toContain("Choose visible models");
    await click(container.querySelector("a")!);
    await click(button("Favorite Codex · New model"));
    expect(button("Show Codex · New model in selector").getAttribute("aria-checked")).toBe("true");
    await render("/");
    expect(picker().textContent).toContain("New model");
  } finally {
    await act(() => root.unmount());
    useHostsStore.setState(oldHosts, true);
    useUiStore.setState(oldUi, true);
    useModelPreferences.setState(oldPrefs, true);
    vi.unstubAllGlobals();
  }
});

it("keeps a sign-in row to its name and one control, with why a sign-in failed on a row under both", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  const oldHosts = useHostsStore.getState();
  const oldUi = useUiStore.getState();
  // Codex is signed in. Claude Code is installed on this computer and isn't, so the selector offers its sign-in.
  useHostsStore.setState({ hosts: [{ ...buildDb().hosts[0]!, online: true, agents: [{ id: "codex", installed: true, models: ["gpt-6-astra"] }] }] });
  useUiStore.setState({ agent: { agent: "codex", model: "gpt-6-astra" } });
  vi.spyOn(desktop, "onHostStatus").mockResolvedValue(() => {});
  vi.spyOn(desktop, "hostStatus").mockResolvedValue({ hostId: "local", agents: [{ id: "claude", installed: true, loggedIn: false }], connected: true, configured: true,
    running: [], serverUrl: null, name: "Here", error: null, mcpCommand: null });
  let report: (status: AgentLoginStatus) => void = () => {};
  vi.spyOn(desktop, "onAgentLogin").mockImplementation(async cb => { report = cb; return () => {}; });
  vi.spyOn(desktop, "agentLoginStatus").mockResolvedValue(null);
  vi.spyOn(desktop, "agentLoginStart").mockResolvedValue({ agent: "claude", state: "waiting", acceptsCode: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter><AgentChip /></MemoryRouter>));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!.click());
    const signIn = () => [...container.querySelectorAll("button")].find(b => b.textContent === "Sign in with Claude")!;
    const row = signIn().parentElement!;
    const parts = () => [...row.children].map(part => part.textContent);
    expect(parts()).toEqual(["Claude Code", "Sign in with Claude"]);
    // A test lays nothing out, so the classes stand for it: the name and its control share a line, centred on each other.
    expect(row.className).toContain("grid grid-cols-[1fr_auto] items-center");
    await act(async () => signIn().click());
    expect(parts()).toEqual(["Claude Code", "Finish signing in in your browser…Cancel"]);
    // A sign-in that started and failed reports what the CLI printed last, sign-in address and all. It is the row's
    // third part, across the row's whole width and free to break anywhere, so the name keeps its line and the button
    // stays in the menu.
    const printed = `If the browser didn't open, visit: https://example.test/authorize?state=${"x".repeat(300)}\nLogin failed`;
    await act(async () => report({ agent: "claude", state: "failed", acceptsCode: true, message: printed }));
    expect(parts()).toEqual(["Claude Code", "Sign in with Claude", printed]);
    expect(row.lastElementChild!.className).toBe("col-span-full min-w-0 wrap-anywhere");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    useHostsStore.setState(oldHosts, true);
    useUiStore.setState(oldUi, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
