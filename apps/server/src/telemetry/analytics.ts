import type { EditReviewRequest } from "@scarlet/shared";
import { createHmac, randomUUID } from "node:crypto";
import { SCARLET_VERSION, type TelemetryConfig } from "./config.js";
import { anonymousId, installId } from "./identity.js";

/** Fixed categories, flags, counts, durations and keyed analytics IDs. Never user content or raw library IDs. */
export type TelemetryProperties = Readonly<Record<string, string | number | boolean>>;

export interface Telemetry {
  /** False when nothing is collected or sent: turned off, no project key, or the id file can't be kept. */
  readonly active: boolean;
  recordEditReview(projectId: string, review: EditReviewRequest): void;
  /** Queues an event. Never throws and never waits on the network. */
  record(event: string, properties?: TelemetryProperties): void;
  /** Sends what is queued now, whatever the retry delay. */
  flush(): Promise<void>;
  /** Starts the background flush. */
  start(): void;
  /** Stops the background flush and gives the queue one short chance to go out. */
  close(): Promise<void>;
}

export interface TelemetryOptions {
  config: TelemetryConfig;
  /** Where the anonymous id is kept. */
  idFile: string;
  log?: (message: string) => void;
  fetch?: typeof fetch;
  now?: () => number;
  /** In [0, 1). */
  random?: () => number;
}

/** A retry delay shorter than this still waits for the next background check. */
export const FLUSH_INTERVAL_MS = 10_000;
/** A hung send would hold up every later flush. */
const SEND_TIMEOUT_MS = 10_000;
/** Quitting waits this long for the last flush. What it can't send in time is dropped. */
export const SHUTDOWN_FLUSH_TIMEOUT_MS = 1_000;
/**
 * A failed batch is retried until it has been failing this long. It holds newer events back meanwhile, and
 * maxBufferedEvents bounds those.
 */
export const MAX_BATCH_RETRY_MS = 30 * 60_000;
export const RETRY_BASE_DELAY_MS = 2_000;
export const RETRY_MAX_DELAY_MS = 300_000;
/** These reject the batch itself, so unlike 408 or 429 a retry can't help. */
const REJECTED_BATCH_STATUSES = new Set([400, 401, 413]);

/**
 * Doubles from the base delay up to the cap, then picks from the upper half so installs don't retry in step.
 * `random` is in [0, 1).
 */
export function retryDelayMs(failures: number, random: number): number {
  const ceiling = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (failures - 1));
  return Math.round(ceiling / 2 + (ceiling / 2) * random);
}

interface BufferedEvent {
  uuid: string;
  event: string;
  properties?: TelemetryProperties;
  capturedAt: string;
}

interface Delivery {
  /** The batch that last failed. It is sent again, unchanged, before anything newer. */
  failedBatch: BufferedEvent[];
  batchAttempts: number;
  firstFailedAt: number;
  /** Failures in a row, across batches. */
  failures: number;
  retryAt: number;
}

const IDLE: Telemetry = {
  active: false,
  recordEditReview() {},
  record() {},
  flush: async () => {},
  start() {},
  close: async () => {},
};

/**
 * Anonymous product-usage events, queued in memory and posted in batches to a PostHog-compatible host. With
 * telemetry turned off or no project key it does nothing at all: no id file, no timer, no request.
 */
export function createTelemetry(options: TelemetryOptions): Telemetry {
  const { config } = options;
  const key = config.posthogKey;
  if (!config.enabled || !key) return IDLE;
  const anonymous = anonymousId(options.idFile);
  if (!anonymous) return IDLE;
  const install = installId(anonymous);

  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const log = options.log ?? (() => {});
  const closing = new AbortController();
  const buffer: BufferedEvent[] = [];
  let delivery: Delivery = { failedBatch: [], batchAttempts: 0, firstFailedAt: 0, failures: 0, retryAt: 0 };
  let flushing: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  async function send(batch: readonly BufferedEvent[]): Promise<{ sent: boolean; status?: number }> {
    try {
      const response = await (options.fetch ?? fetch)(`${config.posthogHost}/batch/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: key,
          batch: batch.map(event => ({
            // The host deduplicates on this, so a batch that arrived but looked failed isn't counted twice.
            uuid: event.uuid,
            event: event.event,
            distinct_id: install,
            properties: {
              ...event.properties,
              installId: install,
              $process_person_profile: false,
              $geoip_disable: true,
              platform: process.platform,
              arch: process.arch,
              scarletVersion: SCARLET_VERSION,
            },
            timestamp: event.capturedAt,
          })),
        }),
        signal: AbortSignal.any([AbortSignal.timeout(SEND_TIMEOUT_MS), closing.signal]),
      });
      void response.body?.cancel().catch(() => {});
      return { sent: response.ok, status: response.status };
    } catch {
      return { sent: false };
    }
  }

  async function drain(): Promise<void> {
    for (;;) {
      const batch = delivery.failedBatch.length ? delivery.failedBatch : buffer.splice(0, config.flushBatchSize);
      if (!batch.length) return;
      const result = await send(batch);
      if (result.sent) {
        delivery = { failedBatch: [], batchAttempts: 0, firstFailedAt: 0, failures: 0, retryAt: 0 };
        continue;
      }
      const at = now();
      const failures = delivery.failures + 1;
      const batchAttempts = delivery.batchAttempts + 1;
      const firstFailedAt = delivery.batchAttempts === 0 ? at : delivery.firstFailedAt;
      const retryAt = at + retryDelayMs(failures, random());
      const rejected = result.status !== undefined && REJECTED_BATCH_STATUSES.has(result.status);
      if (!rejected && at - firstFailedAt < MAX_BATCH_RETRY_MS) {
        delivery = { failedBatch: batch, batchAttempts, firstFailedAt, failures, retryAt };
        return;
      }
      // Keep backing off after a drop, so a bad project key can't empty the queue in a tight loop.
      delivery = { failedBatch: [], batchAttempts: 0, firstFailedAt: 0, failures, retryAt };
      log(rejected
        ? `[telemetry] the ingest host rejected a batch (${result.status}); dropped ${batch.length} event(s)`
        : `[telemetry] dropped ${batch.length} event(s) after ${batchAttempts} failed sends`);
      return;
    }
  }

  /** One flush at a time: the background flush and the one at shutdown must not send the same batch twice. */
  function flush(): Promise<void> {
    return (flushing ??= drain().finally(() => {
      flushing = undefined;
    }));
  }

  return {
    active: true,
    recordEditReview(projectId, { changeId, spot, decision }) {
      const editId = createHmac("sha256", anonymous).update(JSON.stringify(["edit", projectId, changeId, spot])).digest("hex");
      this.record("edit.reviewed", { decision, editId });
    },
    record(event, properties) {
      if (closed) return;
      buffer.push({ uuid: randomUUID(), event, ...(properties ? { properties } : {}), capturedAt: new Date(now()).toISOString() });
      // While the host can't be reached, the oldest events go first.
      if (buffer.length > config.maxBufferedEvents) buffer.splice(0, buffer.length - config.maxBufferedEvents);
    },
    flush,
    start() {
      if (closed || timer) return;
      timer = setInterval(() => {
        if (now() >= delivery.retryAt) void flush();
      }, FLUSH_INTERVAL_MS);
      timer.unref();
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      let wait: NodeJS.Timeout | undefined;
      await Promise.race([flush(), new Promise<void>(resolve => {
        wait = setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS);
      })]);
      clearTimeout(wait);
      closing.abort();
    },
  };
}
