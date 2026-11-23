// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { ModelOptions } from "@scarlet/shared";
import { effortLevel, normalizeSpeedTier, optionLabel, orderEfforts, supportedOptions } from "./modelOptions";
import { formatRelativeAge, formatResetCountdown, minRemainingPercent, providerShortName } from "./subscriptionQuota";

const profile = (efforts: string[], speeds: string[]) =>
  ({ efforts: efforts.map(id => ({ id })), speeds: speeds.map(id => ({ id })) }) as unknown as ModelOptions;

describe("model options", () => {
  it("orders efforts by the known scale and leaves an unknown scale as given", () => {
    expect(orderEfforts([{ id: "high" }, { id: "low" }, { id: "medium" }]).map(o => o.id)).toEqual(["low", "medium", "high"]);
    expect(orderEfforts([{ id: "high" }, { id: "turbo" }]).map(o => o.id)).toEqual(["high", "turbo"]);
  });

  it("places an effort on the model's own scale", () => {
    const efforts = [{ id: "low" }, { id: "medium" }, { id: "high" }];
    expect(effortLevel(efforts, "medium")).toBe(0.5);
    expect(effortLevel(efforts, "high")).toBe(1);
    expect(effortLevel(efforts, "max")).toBeUndefined();
    expect(effortLevel(efforts)).toBeUndefined();
  });

  it("keeps only the settings one host offers together", () => {
    const profiles = [profile(["high"], []), profile([], ["fast"])];
    expect(supportedOptions(profiles, "high", "fast")).toEqual({ effort: "high", serviceTier: undefined });
    expect(supportedOptions(profiles, "high", "fast", true)).toEqual({ effort: undefined, serviceTier: "fast" });
    expect(supportedOptions([profile(["high"], ["fast"])], "high", "fast")).toEqual({ effort: "high", serviceTier: "fast" });
  });

  it("reads Codex's old Fast as the priority tier", () => {
    expect(normalizeSpeedTier("codex", [profile([], ["priority"])], "fast")).toBe("priority");
    expect(normalizeSpeedTier("claude", [profile([], ["priority"])], "fast")).toBe("fast");
  });

  it("labels an option by its label or its capitalised id", () => {
    expect(optionLabel({ id: "xhigh" })).toBe("Xhigh");
    expect(optionLabel({ id: "xhigh", label: "Extra high" })).toBe("Extra high");
  });
});

describe("subscription quota", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");

  it("counts down to a reset", () => {
    expect(formatResetCountdown("2026-01-01T00:30:00Z", now)).toBe("30m");
    expect(formatResetCountdown("2026-01-01T02:15:00Z", now)).toBe("2h 15m");
    expect(formatResetCountdown("2026-01-03T03:00:00Z", now)).toBe("2d 3h");
    expect(formatResetCountdown("2025-12-31T23:00:00Z", now)).toBe("soon");
    expect(formatResetCountdown(undefined, now)).toBeUndefined();
  });

  it("says how long ago the quota was read", () => {
    expect(formatRelativeAge("2025-12-31T23:59:30Z", now)).toBe("just now");
    expect(formatRelativeAge("2025-12-31T23:50:00Z", now)).toBe("10m ago");
    expect(formatRelativeAge("2025-12-31T21:00:00Z", now)).toBe("3h ago");
  });

  it("takes the lowest bucket, or full for unlimited credits", () => {
    expect(minRemainingPercent({ buckets: [{ remainingPercent: 40 }, { remainingPercent: 12 }] } as never)).toBe(12);
    expect(minRemainingPercent({ buckets: [], unlimited: true } as never)).toBe(100);
    expect(minRemainingPercent(undefined)).toBeUndefined();
  });

  it("names a provider without its tool suffix", () => {
    expect(providerShortName("claude")).toBe("Claude");
    expect(providerShortName("codex")).toBe("Codex");
  });
});
