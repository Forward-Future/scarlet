// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { UsageResponse, UsageTotals } from "@scarlet/shared";
import { api } from "../../lib/client";
import { useHostsStore } from "../../stores/hosts";
import { UsageSettings } from "./UsageSettings";

const zone = process.env.TZ;
afterEach(() => {
  vi.useRealTimers();
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
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

// The engine groups by the day on the editor's own clock, and "Today" is that day: in Los Angeles at 7:12 pm on
// November 23 it is already November 24 in UTC, and the evening's work is still today's.
it("puts the day's work under Today on the editor's own clock, not the UTC day", async () => {
  process.env.TZ = "America/Los_Angeles";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-24T03:12:00.000Z"));
  vi.spyOn(api, "usage").mockImplementation(async (by = "project"): Promise<UsageResponse> => by === "day"
    ? { by, total: totals(4), groups: [{ key: "2026-11-23", ...totals(4) }] }
    : { by, total: totals(4), groups: [{ key: "prj_1", ...totals(4) }] });
  vi.spyOn(api, "projects").mockResolvedValue({ projects: [{ id: "prj_1", name: "Interview" }] } as unknown as Awaited<ReturnType<typeof api.projects>>);
  vi.spyOn(api, "trash").mockResolvedValue({ projects: [] });
  const view = await renderUsage();
  try {
    const bars = [...view.container.querySelectorAll<HTMLButtonElement>(".usage-bar-col")].map(b => b.getAttribute("aria-label"));
    expect(bars).toHaveLength(14);
    expect(bars.at(-1)).toBe("Today: 1.2K tokens, 4 runs");
    expect(bars.at(-2)).toBe("Nov 22: No activity");
  } finally {
    await view.unmount();
  }
});

it("counts runs once under the token total and switches across breakdown tabs", async () => {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
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

// A plan that reports no limits never stops being stale, and the host says it is there every 30 seconds, and again
// after each check: asking again each time kept the checks running and Refresh flipping to "Refreshing…".
it("checks a plan's limits once when Usage opens, not again each time the host says it is there", async () => {
  const fresh = () => ({ fetchedAt: new Date().toISOString(), plan: "Max", buckets: [{ id: "session", label: "5-hour window", remainingPercent: 80 }] });
  const host = {
    id: "h1", userId: "u1", name: "Mac", platform: "darwin", online: true,
    agents: [
      { id: "claude", installed: true, loggedIn: true, auth: "subscription", plan: "Max", quota: fresh() },
      // Signed in on a plan, with no limits to report.
      { id: "codex", installed: true, loggedIn: true, auth: "subscription", plan: "Plus" },
    ],
  } as unknown as ReturnType<typeof useHostsStore.getState>["hosts"][number];
  const refreshQuota = vi.fn().mockResolvedValue(undefined);
  useHostsStore.setState({ status: "ready", hosts: [host], refreshQuota });
  vi.spyOn(api, "usage").mockImplementation(async (by = "project"): Promise<UsageResponse> => ({
    by, total: totals(0, { inputTokens: 0, outputTokens: 0, totalTokens: 0, firstAt: null, lastAt: null }), groups: [],
  }));
  vi.spyOn(api, "projects").mockResolvedValue({ projects: [] } as unknown as Awaited<ReturnType<typeof api.projects>>);
  vi.spyOn(api, "trash").mockResolvedValue({ projects: [] });

  const view = await renderUsage();
  try {
    expect(refreshQuota).toHaveBeenCalledTimes(1);
    expect(refreshQuota).toHaveBeenLastCalledWith({ force: false });
    // The host's heartbeat, and its word after the check, each bring the same list again.
    await act(async () => useHostsStore.getState().apply({ ...host, agents: host.agents.map(a => a.quota ? { ...a, quota: fresh() } : a) }));
    await act(async () => useHostsStore.getState().apply({ ...host }));
    expect(refreshQuota).toHaveBeenCalledTimes(1);
    // Refresh still checks when pressed.
    const refresh = [...view.container.querySelectorAll('[aria-label="Subscription limits"] button')].find(b => b.textContent?.trim() === "Refresh") as HTMLButtonElement;
    await act(async () => refresh.click());
    expect(refreshQuota).toHaveBeenCalledTimes(2);
    expect(refreshQuota).toHaveBeenLastCalledWith({ force: true });
  } finally {
    await view.unmount();
  }
});
