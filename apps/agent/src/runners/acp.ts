/** Shared Agent Client Protocol (ACP) option-lookup and auth-error predicates. */

export interface AcpConfigOption {
  id?: string;
  configId?: string;
  category?: string;
  currentValue?: string;
  options?: unknown[];
}

export function findAcpConfigOption<T extends Pick<AcpConfigOption, "id" | "configId" | "category">>(
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

export function isAcpAuthError(code: number | undefined, message: string): boolean {
  return code === -32000 || /auth/i.test(message);
}
