import type { AgentId, ModelOptions } from "@scarlet/shared";

// A provider on two hosts can offer different settings for the same model.
export function supportedOptions(profiles: ModelOptions[], effort?: string, serviceTier?: string, preferSpeed = false) {
  const withEffort = profiles.filter(p => p.efforts.some(o => o.id === effort));
  const withSpeed = profiles.filter(p => p.speeds.some(o => o.id === serviceTier));
  if (withEffort.some(p => withSpeed.includes(p))) return { effort, serviceTier };
  if (withEffort.length && !(preferSpeed && withSpeed.length)) return { effort, serviceTier: undefined };
  return { effort: undefined, serviceTier: withSpeed.length ? serviceTier : undefined };
}

export function pickerOptions(profiles: ModelOptions[], key: "efforts" | "speeds") {
  return [...new Map(profiles.flatMap(p => p[key]).map(o => [o.id, o])).values()];
}

export function normalizeSpeedTier(agent: AgentId, profiles: ModelOptions[], tier?: string): string | undefined {
  // Older profiles saved Codex Fast as a boolean. Modern catalogs call the tier "priority".
  if (tier === "fast" && agent === "codex") {
    const speeds = pickerOptions(profiles, "speeds");
    if (!speeds.some(o => o.id === "fast") && speeds.some(o => o.id === "priority")) return "priority";
  }
  return tier;
}

export function defaultSpeedTitle(profiles: ModelOptions[]) {
  const value = profiles[0]?.defaultSpeed;
  return value && profiles.every(p => p.defaultSpeed === value) ? `Provider default (${value})` : "Use provider default";
}

export const STANDARD_SPEEDS = new Set(["standard", "default", "auto"]);

export function optionLabel(option: { id: string; label?: string }) {
  return option.label ?? option.id.charAt(0).toUpperCase() + option.id.slice(1);
}

const effortRanks = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "extra", "max", "ultra"];

export function orderEfforts<T extends { id: string }>(efforts: T[]) {
  const rank = (id: string) => effortRanks.indexOf(id.toLowerCase());
  return efforts.every(o => rank(o.id) >= 0) ? [...efforts].sort((a, b) => rank(a.id) - rank(b.id)) : efforts;
}

/** How far up the model's own effort scale an effort sits, from 0 (lowest offered) to 1 (highest). */
export function effortLevel(efforts: { id: string }[], effort?: string) {
  if (!effort) return undefined;
  const ordered = orderEfforts(efforts);
  const index = ordered.findIndex(o => o.id === effort);
  if (index < 0) return undefined;
  return ordered.length > 1 ? index / (ordered.length - 1) : 1;
}
