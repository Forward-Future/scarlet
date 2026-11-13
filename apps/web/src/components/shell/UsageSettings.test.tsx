// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { UsageResponse, UsageTotals } from "@scarlet/shared";
import { api } from "../../lib/client";
import { UsageSettings } from "./UsageSettings";

it("counts the runs once under the token total", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const totals = (runs: number): UsageTotals => ({ runs, inputTokens: 900, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, totalTokens: 1200, firstAt: "2026-11-01T10:00:00.000Z", lastAt: "2026-11-06T10:00:00.000Z" });
  vi.spyOn(api, "usage").mockImplementation(async (by = "project"): Promise<UsageResponse> =>
    ({ by, total: totals(42), groups: by === "agent" ? [{ key: "claude", ...totals(3) }] : [] }));
  vi.spyOn(api, "projects").mockResolvedValue({ projects: [] } as unknown as Awaited<ReturnType<typeof api.projects>>);
  vi.spyOn(api, "trash").mockResolvedValue({ projects: [] });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<UsageSettings />));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    // It used to read "900 input · 300 output · 42 runs. 42 agent runs since …".
    expect(container.querySelector('[aria-label="Token usage"] h3')!.textContent).toBe("Tokens");
    const summary = container.querySelector('[aria-label="Token usage"] p')!.textContent!;
    expect(summary.startsWith("900 input · 300 output. 42 runs since ")).toBe(true);
    expect(summary.match(/\b42\b/g)).toHaveLength(1);
    // A row has no sentence after it, so its runs stay in its breakdown.
    expect(container.querySelector('[aria-label="By provider"]')!.textContent).toContain("900 input · 300 output · 3 runs");
  } finally {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
