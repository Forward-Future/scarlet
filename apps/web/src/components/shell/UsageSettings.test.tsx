// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentAvailability, AgentHost, UsageResponse, UsageTotals } from "@scarlet/shared";
import { api } from "../../lib/client";
import { desktop } from "../../lib/desktop";
import { useHostsStore } from "../../stores/hosts";
import { UsageSettings } from "./UsageSettings";

afterEach(() => {
  useHostsStore.setState(useHostsStore.getInitialState());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const totals = (runs: number, patch: Partial<UsageTotals> = {}): UsageTotals => ({
  runs,
  inputTokens: 900,
  outputTokens: 300,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 1200,
  firstAt: "2026-11-01T10:00:00.000Z",
  lastAt: "2026-11-06T10:00:00.000Z",
  ...patch,
});

async function renderUsage() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<UsageSettings />));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("counts runs once under the token total and switches across breakdown tabs", async () => {
  const today = new Date().toISOString().slice(0, 10);
  vi.spyOn(api, "usage").mockImplementation(async (by = "project"): Promise<UsageResponse> => {
    if (by === "agent") return { by, total: totals(42), groups: [{ key: "claude", ...totals(3) }] };
    if (by === "model") return { by, total: totals(42), groups: [{ key: "claude-opus-4-6", ...totals(5) }] };
    if (by === "day") return { by, total: totals(42), groups: [{ key: today, ...totals(4) }] };
    return { by, total: totals(42), groups: [{ key: "prj_1", ...totals(42) }] };
  });
  vi.spyOn(api, "projects").mockResolvedValue({ projects: [{ id: "prj_1", name: "Interview" }] } as unknown as Awaited<ReturnType<typeof api.projects>>);
  vi.spyOn(api, "trash").mockResolvedValue({ projects: [] });

  const view = await renderUsage();
  try {
    expect(view.container.querySelector('[aria-label="Token usage"] h3')!.textContent).toBe("Tokens");
    const summary = view.container.querySelector('[aria-label="Token usage"] .usage-meta')!.textContent!;
    expect(summary).toContain("42 runs since ");
    expect(summary.match(/\b42\b/g)).toHaveLength(1);
    expect(view.container.querySelector('[aria-label="Daily token activity"]')).not.toBeNull();
    expect(view.container.querySelector('[aria-label="By project"]')!.textContent).toContain("Interview");

    // Switching to Providers reveals provider rows with their compact breakdown.
    const providerTab = [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent?.includes("Providers"))!;
    await act(async () => providerTab.click());
    const byProvider = view.container.querySelector('[aria-label="By provider"]')!;
    expect(byProvider.textContent).toContain("Claude Code");
    expect(byProvider.textContent).toContain("900 input · 300 output · 3 runs");

    // Switching to Models formats versioned Claude model IDs cleanly.
    const modelTab = [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent?.includes("Models"))!;
    await act(async () => modelTab.click());
    const byModel = view.container.querySelector('[aria-label="By model"]')!;
    expect(byModel.textContent).toContain("Claude Opus 4.6");
  } finally {
    await view.unmount();
  }
});

it("shows live subscription plan limits only for subscription providers", async () => {
  useHostsStore.setState({
    status: "ready",
    hosts: [{
      id: "h1",
      userId: "u1",
      name: "Mac",
      platform: "darwin",
      online: true,
      agents: [
        {
          id: "claude",
          installed: true,
          loggedIn: true,
          auth: "subscription",
          plan: "Max",
          quota: {
            fetchedAt: new Date().toISOString(),
            plan: "Max",
            buckets: [{ id: "session", label: "5-hour window", remainingPercent: 14, resetsAt: new Date(Date.now() + 90 * 60_000).toISOString() }],
          },
        },
        {
          id: "codex",
          installed: true,
          loggedIn: true,
          auth: "api_key",
          quota: {
            fetchedAt: new Date().toISOString(),
            buckets: [{ id: "weekly", label: "Weekly", remainingPercent: 50 }],
          },
        },
      ],
    }],
  });
  vi.spyOn(api, "usage").mockImplementation(async (by = "project"): Promise<UsageResponse> => ({
    by, total: totals(0, { inputTokens: 0, outputTokens: 0, totalTokens: 0, firstAt: null, lastAt: null }), groups: [],
  }));
  vi.spyOn(api, "projects").mockResolvedValue({ projects: [] } as unknown as Awaited<ReturnType<typeof api.projects>>);
  vi.spyOn(api, "trash").mockResolvedValue({ projects: [] });

  const view = await renderUsage();
  try {
    const limits = view.container.querySelector('[aria-label="Subscription limits"]')!;
    expect(limits).not.toBeNull();
    expect(limits.textContent).toContain("Claude");
    expect(limits.textContent).toContain("Max");
    expect(limits.textContent).toContain("14%");
    expect(limits.textContent).toContain("Low");
    expect(limits.textContent).not.toContain("Codex");
  } finally {
    await view.unmount();
  }
});

it("checks plan limits once when Usage opens, not again after each refresh", async () => {
  const host = (agents: AgentAvailability[]): AgentHost => ({ id: "h1", userId: "u1", name: "Mac", platform: "darwin", online: true, agents });
  const probed = (): AgentAvailability[] => [
    { id: "claude", installed: true, loggedIn: true, auth: "subscription", quota: { fetchedAt: new Date().toISOString(), buckets: [{ id: "session", label: "5-hour window", remainingPercent: 60 }] } },
    // Gemini's /usage couldn't be read, so its quota stays missing after every probe.
    { id: "gemini", installed: true, loggedIn: true, auth: "subscription" },
  ];
  useHostsStore.setState({ status: "ready", hosts: [host(probed())] });
  // The desktop host answers the probe, then its heartbeat reaches the window again through the engine's socket.
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  const probe = vi.spyOn(desktop, "hostRefreshQuota").mockImplementation(async () => {
    const agents = probed();
    setTimeout(() => useHostsStore.getState().apply(host(agents)), 0);
    return { hostId: "h1", agents } as unknown as Awaited<ReturnType<typeof desktop.hostRefreshQuota>>;
  });
  vi.spyOn(api, "usage").mockImplementation(async (by = "project"): Promise<UsageResponse> => ({
    by, total: totals(0, { inputTokens: 0, outputTokens: 0, totalTokens: 0, firstAt: null, lastAt: null }), groups: [],
  }));
  vi.spyOn(api, "projects").mockResolvedValue({ projects: [] } as unknown as Awaited<ReturnType<typeof api.projects>>);
  vi.spyOn(api, "trash").mockResolvedValue({ projects: [] });

  const view = await renderUsage();
  try {
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(false);
    const refresh = view.container.querySelector<HTMLButtonElement>(".usage-refresh")!;
    expect(refresh.textContent).toBe("Refresh");
    expect(refresh.disabled).toBe(false);
  } finally {
    await view.unmount();
  }
});
