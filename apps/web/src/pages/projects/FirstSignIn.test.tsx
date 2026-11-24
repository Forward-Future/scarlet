// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentAvailability, AgentHost } from "@scarlet/shared";
import { api } from "../../lib/client";
import { desktop, type HostStatus } from "../../lib/desktop";
import { buildDb } from "../../lib/mock/fixtures";
import { useHostsStore } from "../../stores/hosts";
import { useProjectStore } from "../../stores/project";
import { useUiStore } from "../../stores/ui";
import { ProjectsPage } from "../ProjectsPage";

const agent = (id: string, extra: Partial<AgentAvailability> = {}) => ({ id, installed: true, loggedIn: false, ...extra }) as AgentAvailability;
const localHost = (agents: AgentAvailability[]) => ({ hostId: "h", agents, running: [], connected: true, serverUrl: null, name: null, error: null, mcpCommand: null, configured: true }) as unknown as HostStatus;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const previousProjects = useProjectStore.getState();
const previousHosts = useHostsStore.getState();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  localStorage.clear();
  useUiStore.setState({ signInLater: false });
  vi.spyOn(api, "projects").mockResolvedValue({ projects: [] });
  vi.spyOn(api, "trash").mockResolvedValue({ projects: [] });
  vi.spyOn(api, "settings").mockResolvedValue({ settings: buildDb().settings } as never);
  vi.spyOn(desktop, "onHostStatus").mockResolvedValue(() => {});
  vi.spyOn(desktop, "onAgentLogin").mockResolvedValue(() => {});
  vi.spyOn(desktop, "agentLoginStatus").mockResolvedValue(null);
  useProjectStore.setState({ list: [], listStatus: "ready" });
  useHostsStore.setState({ hosts: [], status: "ready", load: async () => {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  useProjectStore.setState(previousProjects, true);
  useHostsStore.setState(previousHosts, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const show = () => act(async () => root.render(<MemoryRouter><ProjectsPage /></MemoryRouter>));
const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === text);

it("opens on signing in while no model is ready, and lets the editor look around first", async () => {
  vi.spyOn(desktop, "hostStatus").mockResolvedValue(localHost([agent("gemini", { installed: false }), agent("claude"), agent("codex", { installed: false })]));
  await show();
  const screen = container.querySelector(".first-sign-in")!;
  expect(screen.querySelector("h2")?.textContent).toBe("Sign in to start editing");
  expect(container.querySelector("h1")?.textContent).toBe("Scarlet");
  // One button a plan, Claude first, whether or not this computer has the tool yet.
  expect([...screen.querySelectorAll(".first-sign-in-choice > button")].map(b => b.textContent)).toEqual(["Sign in with Claude", "Sign in with ChatGPT", "Sign in with Google"]);
  expect(container.querySelector(".library-first-edit h2")?.textContent).toBe("Sign in to start editing");

  await act(async () => button("Look around first")!.click());
  expect(container.querySelector(".first-sign-in")).toBeNull();
  expect(container.querySelector(".library-first-edit h2")?.textContent).toBe("Make your first edit");
  expect(localStorage.getItem("scarlet.signInLater")).toBe("1");

  // Quick start's first step brings the sign-in back.
  await act(async () => button("Quick start")!.click());
  const guide = container.querySelector("dialog[open]")!;
  expect([...guide.querySelectorAll("li h3")].map(h => h.textContent)).toEqual(["Sign in to a model", "Add your footage", "Ask for an edit", "Play it back"]);
  await act(async () => button("Sign in")!.click());
  expect(container.querySelector("dialog[open]")).toBeNull();
  expect(container.querySelector(".first-sign-in")).not.toBeNull();
  expect(localStorage.getItem("scarlet.signInLater")).toBeNull();
});

it("installs what a plan needs and signs in with one press, and says when Node.js is missing", async () => {
  vi.spyOn(desktop, "hostStatus").mockResolvedValue(localHost([agent("claude", { installed: false }), agent("codex", { installed: false })]));
  const install = vi.spyOn(desktop, "agentInstall").mockResolvedValueOnce("installed").mockResolvedValueOnce("needsNode");
  const login = vi.spyOn(desktop, "agentLoginStart").mockResolvedValue({ agent: "claude", state: "waiting" } as never);
  await show();
  await act(async () => button("Sign in with Claude")!.click());
  expect(install).toHaveBeenCalledWith("claude");
  expect(login).toHaveBeenCalledWith("claude");
  expect(container.textContent).toContain("Finish signing in in your browser…");

  await act(async () => button("Sign in with ChatGPT")!.click());
  expect(install).toHaveBeenLastCalledWith("codex");
  expect(login).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Codex needs Node.js.");
});

it("opens on the library once a model is ready, and says who is signed in", async () => {
  vi.spyOn(desktop, "hostStatus").mockResolvedValue(localHost([agent("claude", { loggedIn: true, auth: "subscription" })]));
  useHostsStore.setState({ hosts: [{ id: "h", agents: [agent("claude", { loggedIn: true, auth: "subscription" })] } as unknown as AgentHost] });
  await show();
  expect(container.querySelector(".first-sign-in")).toBeNull();
  expect(container.querySelector(".library-first-edit h2")?.textContent).toBe("Make your first edit");
  expect(container.querySelector(".first-signed-in")?.textContent).toBe("✓ Signed in with Claude · Add another");
  await act(async () => button("Quick start")!.click());
  expect([...container.querySelectorAll("dialog[open] li h3")].map(h => h.textContent)).toEqual(["Add your footage", "Ask for an edit", "Play it back"]);
});

it("adds another plan from the line that says who is signed in, and offers none once all three are", async () => {
  const claude = agent("claude", { loggedIn: true, auth: "subscription" });
  vi.spyOn(desktop, "hostStatus").mockResolvedValue(localHost([claude, agent("codex"), agent("gemini", { installed: false })]));
  useHostsStore.setState({ hosts: [{ id: "h", agents: [claude, agent("codex")] } as unknown as AgentHost] });
  await show();
  await act(async () => button("Add another")!.click());
  const screen = container.querySelector(".first-sign-in")!;
  expect(screen.querySelector("h2")?.textContent).toBe("Add another plan");
  expect(screen.querySelector(".first-sign-in-done")?.textContent).toBe("✓ Signed in with Claude");
  expect([...screen.querySelectorAll(".first-sign-in-choice > button")].map(b => b.textContent)).toEqual(["Sign in with ChatGPT", "Sign in with Google"]);
  await act(async () => button("Done")!.click());
  expect(container.querySelector(".first-sign-in")).toBeNull();
  expect(localStorage.getItem("scarlet.signInLater")).toBeNull();

  const all = ["claude", "codex", "gemini"].map(id => agent(id, { loggedIn: true, auth: "subscription" }));
  await act(async () => useHostsStore.setState({ hosts: [{ id: "h", agents: all } as unknown as AgentHost] }));
  expect(container.querySelector(".first-signed-in")?.textContent).toBe("✓ Signed in with Claude, ChatGPT and Google");
});

it("keeps Add another plan open while it reads the models again", async () => {
  const claude = agent("claude", { loggedIn: true, auth: "subscription" });
  const hosts = [{ id: "h", online: true, agents: [claude, agent("codex")] } as unknown as AgentHost];
  vi.spyOn(desktop, "hostStatus").mockResolvedValue(localHost([claude, agent("codex")]));
  let read!: (value: { hosts: AgentHost[] }) => void;
  const hostsRead = vi.spyOn(api, "hosts").mockReturnValueOnce(new Promise(resolve => { read = resolve; }));
  useHostsStore.setState({ hosts, load: previousHosts.load });
  await show();
  await act(async () => button("Add another")!.click());
  expect(hostsRead).toHaveBeenCalledTimes(1);
  expect(container.querySelector(".first-sign-in h2")?.textContent).toBe("Add another plan");
  await act(async () => read({ hosts }));
  expect(container.querySelector(".first-sign-in h2")?.textContent).toBe("Add another plan");
  expect(hostsRead).toHaveBeenCalledTimes(1);
});
