/** Public, write-only token for the Scarlet project in PostHog US Cloud. */
export const DEFAULT_POSTHOG_KEY = "phc_xWw7KkqDL4iYF6fd4E4bm7WDNADN2AsAd5nzDUjh8d7N";
export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/** Kept in step with package.json by a test: the packaged engine is one file and can't read it at run time. */
export const SCARLET_VERSION = "0.1.3";

export interface TelemetryConfig {
  enabled: boolean;
  posthogKey: string | undefined;
  posthogHost: string;
  /** Events per request. */
  flushBatchSize: number;
  /** Events kept while the ingest host can't be reached; the oldest are dropped past this. */
  maxBufferedEvents: number;
}

const OFF = new Set(["0", "false", "no", "off"]);

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value?.trim());
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** `defaultKey` is used when SCARLET_POSTHOG_KEY isn't set. */
export function telemetryConfig(env: NodeJS.ProcessEnv, defaultKey?: string): TelemetryConfig {
  return {
    enabled: !OFF.has((env.SCARLET_TELEMETRY_ENABLED ?? "").trim().toLowerCase()),
    posthogKey: env.SCARLET_POSTHOG_KEY?.trim() || defaultKey?.trim() || undefined,
    posthogHost: (env.SCARLET_POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST).replace(/\/+$/, ""),
    flushBatchSize: positiveInt(env.SCARLET_TELEMETRY_FLUSH_BATCH_SIZE, 20),
    maxBufferedEvents: positiveInt(env.SCARLET_TELEMETRY_MAX_BUFFERED_EVENTS, 1000),
  };
}
