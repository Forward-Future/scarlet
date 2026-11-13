// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { desktop, type EngineStatus, type HostStatus } from "../../lib/desktop";
import { DesktopAgents, DesktopDiagnostics } from "./DesktopSettings";

it("counts restarts and running tasks in words, not with (s)", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  let engine: EngineStatus = { url: null, userId: null, state: "ready", error: null, dataDir: "/data", workDir: "/work", logDir: "/logs",
    engine: null, engineKind: "sidecar", pid: 10, restarts: 1, version: "1.0.0" };
  let host: HostStatus = { hostId: "local", agents: [], running: ["tsk_1"], connected: true, serverUrl: null, name: null, error: null, mcpCommand: null, configured: true };
  vi.spyOn(desktop, "onEngineStatus").mockResolvedValue(() => {});
  vi.spyOn(desktop, "engineStatus").mockImplementation(async () => engine);
  vi.spyOn(desktop, "onHostStatus").mockResolvedValue(() => {});
  vi.spyOn(desktop, "hostStatus").mockImplementation(async () => host);
  const container = document.createElement("div");
  /** Diagnostics as it reads once the shell has reported the engine and the host. */
  const shown = async () => {
    const root = createRoot(container);
    await act(async () => root.render(<DesktopDiagnostics />));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    const text = container.textContent ?? "";
    await act(async () => root.unmount());
    return text;
  };
  try {
    const one = await shown();
    expect(one).toMatch(/pid 10\s*1 restart(?!s|\()/);
    expect(one).toContain("Running 1 task: tsk_1");
    engine = { ...engine, restarts: 3 };
    host = { ...host, running: ["tsk_1", "tsk_2"] };
    const several = await shown();
    expect(several).toContain("3 restarts");
    expect(several).toContain("Running 2 tasks: tsk_1, tsk_2");
    expect(one + several).not.toContain("(s)");
  } finally {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("names Claude Code and Codex in the sign-in card's sentence as its rows do, and signs in to both with one verb", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const host: HostStatus = { hostId: "local", running: [], connected: true, serverUrl: null, name: null, error: null, mcpCommand: null, configured: true, agents: [
    { id: "claude", installed: true, loggedIn: false }, { id: "codex", installed: true, loggedIn: false }, { id: "gemini", installed: true, loggedIn: true }] };
  vi.spyOn(desktop, "onEngineStatus").mockResolvedValue(() => {});
  vi.spyOn(desktop, "engineStatus").mockResolvedValue({ state: "ready" } as EngineStatus);
  vi.spyOn(desktop, "onHostStatus").mockResolvedValue(() => {});
  vi.spyOn(desktop, "hostStatus").mockResolvedValue(host);
  vi.spyOn(desktop, "onAgentLogin").mockResolvedValue(() => {});
  vi.spyOn(desktop, "agentLoginStatus").mockResolvedValue(null);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<DesktopAgents />));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(container.querySelector("h3")?.textContent).toBe("Sign in");
    expect(container.querySelector("p")?.textContent).toBe("Choose Claude Code or Codex. Install it if needed, then sign in with your subscription.");
    expect([...container.querySelectorAll("li")].map(row => [row.querySelector("div > div")?.textContent, row.querySelector("button")?.textContent]))
      .toEqual([["Claude Code", "Sign in with Claude"], ["Codex", "Sign in with ChatGPT"]]);
    expect(container.textContent).not.toMatch(/assistant|\bAI\b|Connect/);
  } finally {
    await act(async () => root.unmount());
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
