import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { estimateApiTokenCost, priceLabel, speedTier } from "./apiTokenCost.js";
import { ModelPrices, PRICE_LIST_URL, pickPrices, type PriceList } from "./modelPrices.js";

const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 };
const at = "2026-11-18T00:00:00.000Z";
const empty: PriceList = { fetchedAt: "1970-01-01T00:00:00.000Z", models: {} };

const raw = {
  sample_spec: { mode: "chat" },
  "gpt-9-sol": {
    litellm_provider: "openai", mode: "chat",
    input_cost_per_token: 2e-6, output_cost_per_token: 1e-5, cache_read_input_token_cost: 1e-7, cache_creation_input_token_cost: 2.5e-6,
    input_cost_per_token_priority: 4e-6, output_cost_per_token_priority: 2e-5, cache_read_input_token_cost_priority: 2e-7,
    cache_creation_input_token_cost_priority: 5e-6,
    input_cost_per_token_batches: 1e-6, output_cost_per_token_batches: 5e-6,
  },
  "claude-opus-9": {
    litellm_provider: "anthropic", mode: "chat", input_cost_per_token: 4e-6, output_cost_per_token: 2e-5,
    cache_read_input_token_cost: 2e-7, cache_creation_input_token_cost: 5e-6, provider_specific_entry: { us: 1.1, fast: 2 },
  },
  "gemini/gemini-9-pro": { litellm_provider: "gemini", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 4e-6 },
  "text-embedding-9": { litellm_provider: "openai", mode: "embedding", input_cost_per_token: 1e-7, output_cost_per_token: 0 },
  "bedrock/claude-opus-9": { litellm_provider: "bedrock", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
};

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "scarlet-prices-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it("keeps the chat models of the providers Scarlet runs, per million tokens, with their speeds", () => {
  expect(pickPrices(raw)).toEqual({
    "claude-opus-9": { rates: [4, 20, 0.2, 5], multipliers: { fast: 2 } },
    "gemini-9-pro": { rates: [1, 4] },
    "gpt-9-sol": { rates: [2, 10, 0.1, 2.5], tiers: { priority: [4, 20, 0.2, 5] } },
  });
});

it("prices a model only the list has, and each speed at its own rate", () => {
  const prices = new ModelPrices({}, { fetchedAt: at, models: pickPrices(raw) });
  expect(estimateApiTokenCost("gpt-9-sol", usage, at, { prices })).toBeCloseTo(12.1, 9);
  expect(estimateApiTokenCost("gpt-9-sol", usage, at, { prices, tier: "priority" })).toBeCloseTo(24.2, 9);
  // Codex's Fast is the list's priority tier.
  expect(estimateApiTokenCost("gpt-9-sol", usage, at, { prices, tier: "fast" })).toBeCloseTo(24.2, 9);
  expect(estimateApiTokenCost("gpt-9-sol", usage, at, { prices, tier: "ultrafast" })).toBeUndefined();
  expect(estimateApiTokenCost("claude-opus-9", usage, at, { prices, tier: "fast" })).toBeCloseTo(48.4, 9);
  expect(estimateApiTokenCost("gemini-9-pro", { ...usage, cacheReadTokens: 0 }, at, { prices })).toBeCloseTo(5, 9);
  expect(estimateApiTokenCost("gemini-9-pro", usage, at, { prices })).toBeUndefined();
});

it("prefers Scarlet's own rates at standard speed and takes a speed from the list", () => {
  const prices = new ModelPrices({}, { fetchedAt: at, models: { "gpt-6.2-sol": { rates: [99, 99, 99, 99], tiers: { priority: [4, 20, 0.2, 5] } } } });
  expect(estimateApiTokenCost("gpt-6.2-sol", usage, at, { prices })).toBeCloseTo(12.1, 9);
  expect(estimateApiTokenCost("gpt-6.2-sol", usage, at, { prices, tier: "priority" })).toBeCloseTo(24.2, 9);
  expect(estimateApiTokenCost("gpt-6.2-sol", usage, at, { prices: new ModelPrices({}, empty), tier: "priority" })).toBeUndefined();
});

it("names what it couldn't price, with the speed", () => {
  expect(speedTier("standard")).toBeUndefined();
  expect(speedTier(undefined, true)).toBe("fast");
  expect(priceLabel("gpt-9-sol", speedTier("priority"))).toBe("gpt-9-sol at Fast speed");
  expect(priceLabel("gpt-9-sol")).toBe("gpt-9-sol");
});

it("fetches the list when a model has no price, keeps it, and waits a day before asking again", async () => {
  const file = join(dir, "model-prices.json");
  let now = Date.parse(at);
  const get = vi.fn(async () => new Response(JSON.stringify(raw)));
  const prices = new ModelPrices({ file, fetch: get as unknown as typeof fetch, now: () => now }, empty);
  const updated = vi.fn();
  prices.onUpdate = updated;
  await prices.ready();
  expect(prices.rates("gpt-9-sol", undefined, undefined)).toBeUndefined();

  prices.missed();
  await vi.waitFor(() => expect(updated).toHaveBeenCalledTimes(1));
  expect(get).toHaveBeenCalledWith(PRICE_LIST_URL, expect.anything());
  expect(prices.rates("gpt-9-sol", undefined, undefined)).toEqual([2, 10, 0.1, 2.5]);

  now += 60 * 60 * 1000;
  prices.missed();
  expect(get).toHaveBeenCalledTimes(1);

  // A restarted engine starts from the kept list, and keeps to the day.
  const again = new ModelPrices({ file, fetch: get as unknown as typeof fetch, now: () => now }, empty);
  await again.ready();
  expect(again.rates("claude-opus-9", "fast", undefined)).toEqual([8, 40, 0.4, 10]);
  again.missed();
  expect(get).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(file, "utf8")).fetchedAt).toBe(at);

  now += 24 * 60 * 60 * 1000;
  again.missed();
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
});

it("uses a kept list only when it is newer than the one this build shipped with", async () => {
  const file = join(dir, "model-prices.json");
  const shipped: PriceList = { fetchedAt: at, models: { "gemini-9-pro": { rates: [1.5, 6] } } };
  const kept = (fetchedAt: string) => writeFile(file, JSON.stringify({ fetchedAt, models: { "gemini-9-pro": { rates: [1, 4] } } }));

  await kept("2026-11-01T00:00:00.000Z");
  const older = new ModelPrices({ file }, shipped);
  await older.ready();
  expect(older.rates("gemini-9-pro", undefined, undefined)).toEqual([1.5, 6]);

  await kept("2026-11-20T00:00:00.000Z");
  const newer = new ModelPrices({ file }, shipped);
  await newer.ready();
  expect(newer.rates("gemini-9-pro", undefined, undefined)).toEqual([1, 4]);
});

it("never fetches without being given a way to, and keeps the list it has when a fetch fails", async () => {
  const quiet = new ModelPrices({ file: join(dir, "none.json") }, empty);
  quiet.missed();
  expect(await quiet.refresh()).toBe(false);

  const log = vi.fn();
  const failing = new ModelPrices({ fetch: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch, log },
    { fetchedAt: at, models: pickPrices(raw) });
  expect(await failing.refresh()).toBe(false);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("HTTP 503"));
  expect(failing.rates("gpt-9-sol", undefined, undefined)).toEqual([2, 10, 0.1, 2.5]);
});
