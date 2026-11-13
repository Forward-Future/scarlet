import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTelemetry,
  FLUSH_INTERVAL_MS,
  MAX_BATCH_RETRY_MS,
  RETRY_MAX_DELAY_MS,
  retryDelayMs,
  SHUTDOWN_FLUSH_TIMEOUT_MS,
  type Telemetry,
} from "./analytics.js";
import { SCARLET_VERSION, telemetryConfig } from "./config.js";
import { installId } from "./identity.js";

const START = Date.parse("2026-01-01T00:00:00.000Z");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A status to answer with, a network error, or a request that never answers. */
type Reply = number | "throw" | "hang";

interface SentEvent {
  uuid: string;
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

interface Sent {
  url: string;
  body: { api_key: string; batch: SentEvent[] };
  signal: AbortSignal;
}

let dir: string;
let idFile: string;
let sent: Sent[];
let logs: string[];
let clock: { at: number };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scarlet-telemetry-"));
  idFile = join(dir, "telemetry-id");
  sent = [];
  logs = [];
  clock = { at: START };
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function telemetry(options: {
  env?: NodeJS.ProcessEnv;
  /** `call` counts from 1. Every request succeeds when this is left out. */
  reply?: (call: number) => Reply;
  now?: () => number;
  idFile?: string;
  preference?: () => { enabled: boolean; revision: number };
} = {}): Telemetry {
  const fakeFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const signal = init!.signal!;
    sent.push({ url: String(input), body: JSON.parse(String(init!.body)) as Sent["body"], signal });
    const reply = options.reply?.(sent.length) ?? 200;
    if (reply === "throw") throw new Error("offline");
    if (reply === "hang") {
      return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    }
    return new Response(null, { status: reply });
  };
  return createTelemetry({
    config: telemetryConfig({ SCARLET_POSTHOG_KEY: "phc_test", ...options.env }),
    idFile: options.idFile ?? idFile,
    preference: options.preference,
    log: message => logs.push(message),
    fetch: fakeFetch as typeof fetch,
    now: options.now ?? (() => clock.at),
    random: () => 0,
  });
}

const names = (request: Sent) => request.body.batch.map(event => event.event);

describe("when telemetry is off", () => {
  it("does nothing without a project key", async () => {
    const t = telemetry({ env: { SCARLET_POSTHOG_KEY: "" } });
    expect(t.active).toBe(false);
    t.record("feature.used", { feature: "project.create" });
    t.start();
    await t.flush();
    await t.close();
    expect(sent).toEqual([]);
    expect(existsSync(idFile)).toBe(false);
  });

  it.each(["false", "0", "no", "off", "FALSE", " Off "])("does nothing when SCARLET_TELEMETRY_ENABLED is %j", async value => {
    const t = telemetry({ env: { SCARLET_TELEMETRY_ENABLED: value } });
    expect(t.active).toBe(false);
    t.record("feature.used", { feature: "project.create" });
    t.start();
    await t.flush();
    await t.close();
    expect(sent).toEqual([]);
    expect(existsSync(idFile)).toBe(false);
  });

  it.each(["true", "1", "", "yes"])("stays on when SCARLET_TELEMETRY_ENABLED is %j", async value => {
    const t = telemetry({ env: { SCARLET_TELEMETRY_ENABLED: value } });
    expect(t.active).toBe(true);
    t.record("a");
    await t.flush();
    expect(sent).toHaveLength(1);
  });

  it("aborts the current delivery and drops remaining events when the preference changes", async () => {
    let preference = { enabled: true, revision: 0 };
    const t = telemetry({
      env: { SCARLET_TELEMETRY_FLUSH_BATCH_SIZE: "1" },
      reply: call => call === 1 ? "hang" : 200,
      preference: () => preference,
    });
    t.record("sending");
    t.record("queued");
    const sending = t.flush();
    expect(sent.map(names)).toEqual([["sending"]]);
    preference = { enabled: false, revision: 1 };
    t.refreshPreference();
    expect(sent[0]!.signal.aborted).toBe(true);
    t.record("while-off");
    preference = { enabled: true, revision: 2 };
    t.record("after");
    await sending;
    await t.close();
    expect(sent.map(names)).toEqual([["sending"], ["after"]]);
  });

  it("discards the queue if the library preference cannot be read", async () => {
    let available = true;
    const t = telemetry({ preference() {
      if (!available) throw new Error("Library is unavailable");
      return { enabled: true, revision: 0 };
    } });
    t.record("queued");
    available = false;
    t.record("unavailable");
    await t.flush();
    available = true;
    t.record("after");
    await t.close();
    expect(sent.map(names)).toEqual([["after"]]);
  });

  it("stays off when the id can't be kept", async () => {
    const t = telemetry({ idFile: join(dir, "missing", "telemetry-id") });
    expect(t.active).toBe(false);
    t.record("a");
    await t.flush();
    expect(sent).toEqual([]);
  });
});

describe("what is sent", () => {
  it("posts a batch that names nothing but a hashed random id", async () => {
    const t = telemetry();
    t.record("feature.used", { feature: "project.create", installId: "spoofed" });
    t.record("server.boot.heartbeat");
    clock.at += 5_000;
    await t.flush();

    const raw = readFileSync(idFile, "utf8").trim();
    const install = installId(raw);
    const base = {
      installId: install,
      $process_person_profile: false,
      $geoip_disable: true,
      platform: process.platform,
      arch: process.arch,
      scarletVersion: SCARLET_VERSION,
    };
    expect(sent).toHaveLength(1);
    const request = sent[0]!;
    expect(request.url).toBe("https://us.i.posthog.com/batch/");
    expect(request.body.api_key).toBe("phc_test");
    // The timestamp is when the event happened, not when it was sent.
    expect(request.body.batch).toEqual([
      {
        uuid: expect.stringMatching(UUID),
        event: "feature.used",
        distinct_id: install,
        properties: { feature: "project.create", ...base },
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        uuid: expect.stringMatching(UUID),
        event: "server.boot.heartbeat",
        distinct_id: install,
        properties: base,
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(request.body.batch[0]!.uuid).not.toBe(request.body.batch[1]!.uuid);
    expect(JSON.stringify(request.body)).not.toContain(raw);
  });

  it("posts to the host that is set", async () => {
    const t = telemetry({ env: { SCARLET_POSTHOG_HOST: "https://eu.i.posthog.com///" } });
    t.record("a");
    await t.flush();
    expect(sent[0]!.url).toBe("https://eu.i.posthog.com/batch/");
  });

  it("sends at most flushBatchSize events per request", async () => {
    const t = telemetry({ env: { SCARLET_TELEMETRY_FLUSH_BATCH_SIZE: "2" } });
    for (const name of ["e1", "e2", "e3", "e4", "e5"]) t.record(name);
    await t.flush();
    expect(sent.map(names)).toEqual([["e1", "e2"], ["e3", "e4"], ["e5"]]);
  });

  it("drops the oldest events past maxBufferedEvents", async () => {
    const t = telemetry({ env: { SCARLET_TELEMETRY_MAX_BUFFERED_EVENTS: "3" } });
    for (const name of ["e1", "e2", "e3", "e4", "e5"]) t.record(name);
    await t.flush();
    expect(sent.map(names)).toEqual([["e3", "e4", "e5"]]);
  });

  it("sends once when two flushes overlap", async () => {
    const t = telemetry();
    t.record("a");
    const first = t.flush();
    const second = t.flush();
    expect(second).toBe(first);
    await first;
    expect(sent).toHaveLength(1);
  });
});

describe("when a send fails", () => {
  it("sends the failed batch again, unchanged, before anything newer", async () => {
    const t = telemetry({ env: { SCARLET_TELEMETRY_FLUSH_BATCH_SIZE: "2" }, reply: call => (call === 1 ? 503 : 200) });
    for (const name of ["a", "b", "c"]) t.record(name);
    await t.flush();
    expect(sent.map(names)).toEqual([["a", "b"]]);

    t.record("d");
    await t.flush();
    expect(sent.map(names)).toEqual([["a", "b"], ["a", "b"], ["c", "d"]]);
    expect(sent[1]!.body).toEqual(sent[0]!.body);
  });

  it("survives a fetch that throws", async () => {
    const t = telemetry({ reply: call => (call === 1 ? "throw" : 200) });
    t.record("a");
    await expect(t.flush()).resolves.toBeUndefined();
    await t.flush();
    expect(sent.map(names)).toEqual([["a"], ["a"]]);
    expect(sent[1]!.body.batch[0]!.uuid).toBe(sent[0]!.body.batch[0]!.uuid);
  });

  it.each([408, 429, 500, 503])("keeps a batch after a %i", async status => {
    const t = telemetry({ reply: call => (call === 1 ? status : 200) });
    t.record("a");
    await t.flush();
    t.record("b");
    await t.flush();
    expect(sent.map(names)).toEqual([["a"], ["a"], ["b"]]);
    expect(logs).toEqual([]);
  });

  it.each([400, 401, 413])("drops a batch the host rejects with a %i", async status => {
    const t = telemetry({ reply: call => (call === 1 ? status : 200) });
    t.record("a");
    await t.flush();
    expect(logs).toEqual([`[telemetry] the ingest host rejected a batch (${status}); dropped 1 event(s)`]);

    t.record("b");
    await t.flush();
    expect(sent.map(names)).toEqual([["a"], ["b"]]);
  });

  it("drops a batch that has been failing for half an hour", async () => {
    const t = telemetry({ reply: call => (call <= 3 ? 503 : 200) });
    t.record("x");
    await t.flush();
    clock.at += MAX_BATCH_RETRY_MS - 1;
    await t.flush();
    expect(logs).toEqual([]);

    clock.at += 1;
    await t.flush();
    expect(logs).toEqual(["[telemetry] dropped 1 event(s) after 3 failed sends"]);
    await t.flush();
    expect(sent).toHaveLength(3);

    t.record("y");
    await t.flush();
    expect(sent.map(names)).toEqual([["x"], ["x"], ["x"], ["y"]]);
  });

  it("doubles the retry delay up to the cap and picks from the upper half", () => {
    expect(retryDelayMs(1, 0)).toBe(1_000);
    expect(retryDelayMs(2, 0)).toBe(2_000);
    expect(retryDelayMs(3, 0)).toBe(4_000);
    expect(retryDelayMs(20, 0)).toBe(RETRY_MAX_DELAY_MS / 2);
    expect(retryDelayMs(20, 0.999999)).toBeLessThanOrEqual(RETRY_MAX_DELAY_MS);
    expect(retryDelayMs(1, 0.999999)).toBeLessThanOrEqual(2_000);
  });

  it("retries in the background no sooner than the delay allows", async () => {
    vi.useFakeTimers({ now: START });
    const t = telemetry({ reply: () => 503, now: () => Date.now() });
    t.start();
    const tick = () => vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    await tick();
    expect(sent).toHaveLength(0);

    t.record("a");
    // With random at 0 the delays are 1, 2, 4, 8, 16 and 32 seconds, and the check runs every 10.
    const sends: number[] = [];
    for (let i = 0; i < 11; i++) {
      await tick();
      sends.push(sent.length);
    }
    expect(sends).toEqual([1, 2, 3, 4, 5, 5, 6, 6, 6, 6, 7]);
  });

  it("flushes when asked without waiting out the delay", async () => {
    const t = telemetry({ reply: call => (call === 1 ? 503 : 200) });
    t.record("a");
    await t.flush();
    await t.flush();
    expect(sent).toHaveLength(2);
  });
});

describe("close", () => {
  it("sends what is queued and then stays shut", async () => {
    const t = telemetry();
    t.record("a");
    await t.close();
    expect(sent.map(names)).toEqual([["a"]]);

    t.record("b");
    t.start();
    await t.close();
    await t.flush();
    expect(sent).toHaveLength(1);
  });

  it("gives up on a send that hangs", async () => {
    vi.useFakeTimers({ now: START });
    const t = telemetry({ reply: () => "hang" });
    t.record("a");
    let done = false;
    const closed = t.close().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(SHUTDOWN_FLUSH_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    expect(sent[0]!.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await closed;
    expect(sent[0]!.signal.aborted).toBe(true);
  });
});
