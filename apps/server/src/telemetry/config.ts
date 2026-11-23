import type { TelemetryChannel } from "@scarlet/shared";

/** Public, write-only token for the Scarlet project in PostHog US Cloud. */
export const DEFAULT_POSTHOG_KEY = "phc_xWw7KkqDL4iYF6fd4E4bm7WDNADN2AsAd5nzDUjh8d7N";
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/** Kept in step with package.json by a test: the packaged engine is one file and can't read it at run time. */
export const SCARLET_VERSION = "0.1.4";

export interface TelemetryConfig {
  enabled: boolean;
  posthogKey: string | undefined;
  posthogHost: string;
  /** Sent with every event, so the team's own builds can be told apart from the public packages. */
  channel: TelemetryChannel;
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

/**
 * `defaultKey` is used when SCARLET_POSTHOG_KEY isn't set. Only the packaged `serve` command passes it.
 *
 * `release` needs both that built-in key and SCARLET_RELEASE_CHANNEL, which only the desktop app built for a public
 * update feed hands its engine. A source run, `desktop:dev`, a local-main or review package, and any engine given its
 * own key are `dev`. SCARLET_TELEMETRY_CHANNEL=dev marks a public package as the team's own.
 */
export function telemetryConfig(env: NodeJS.ProcessEnv, defaultKey?: string): TelemetryConfig {
  const suppliedKey = env.SCARLET_POSTHOG_KEY?.trim() || undefined;
  const builtInKey = suppliedKey ? undefined : defaultKey?.trim() || undefined;
  const release = !!builtInKey && !!env.SCARLET_RELEASE_CHANNEL?.trim() &&
    env.SCARLET_TELEMETRY_CHANNEL?.trim().toLowerCase() !== "dev";
  return {
    enabled: !OFF.has((env.SCARLET_TELEMETRY_ENABLED ?? "").trim().toLowerCase()),
    posthogKey: suppliedKey ?? builtInKey,
    posthogHost: (env.SCARLET_POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST).replace(/\/+$/, ""),
    channel: release ? "release" : "dev",
    flushBatchSize: positiveInt(env.SCARLET_TELEMETRY_FLUSH_BATCH_SIZE, 20),
    maxBufferedEvents: positiveInt(env.SCARLET_TELEMETRY_MAX_BUFFERED_EVENTS, 1000),
  };
}
