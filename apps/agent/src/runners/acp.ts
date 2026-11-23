/** Shared Agent Client Protocol (ACP) option-lookup and auth-error predicates. */

export interface AcpConfigOption {
  id?: string;
  configId?: string;
  category?: string;
  currentValue?: string;
  options?: unknown[];
}

function findAcpConfigOption<T extends Pick<AcpConfigOption, "id" | "configId" | "category">>(
  configs: readonly T[],
  category: string,
  ids: readonly string[],
): T | undefined {
  return configs.find((c) => c.category === category || ids.includes(c.id ?? c.configId ?? ""));
}

export function findAcpModelOption<T extends Pick<AcpConfigOption, "id" | "configId" | "category">>(configs: readonly T[]): T | undefined {
  return findAcpConfigOption(configs, "model", ["model"]);
}

export function findAcpEffortOption<T extends Pick<AcpConfigOption, "id" | "configId" | "category">>(configs: readonly T[]): T | undefined {
  return findAcpConfigOption(configs, "thought_level", ["thought_level", "reasoning_effort", "thinking_level"]);
}

/**
 * Default thinking effort Scarlet uses for Gemini runs when the user hasn't picked one.
 * agy defaults `thought_level` to "high", spending ~20–40 s thinking per tool-loop turn;
 * "medium" matches Codex's default when offered by the session.
 */
export const DEFAULT_GEMINI_EFFORT = "medium";

export function acpConfigHasValue(opt: Pick<AcpConfigOption, "options"> | undefined, value: string): boolean {
  if (!Array.isArray(opt?.options)) return false;
  for (const item of opt.options) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (rec.value === value) return true;
    if (Array.isArray(rec.options) && acpConfigHasValue({ options: rec.options }, value)) return true;
  }
  return false;
}

export function isAcpAuthError(code: number | undefined, message: string): boolean {
  return code === -32000 || /auth/i.test(message);
}
