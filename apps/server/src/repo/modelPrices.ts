import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MODEL_PRICES_SNAPSHOT } from "./modelPrices.generated.js";

/** USD per million tokens: input, output, cache read, cache write. */
export type Rates = readonly [input: number, output: number, cacheRead?: number, cacheWrite?: number];

/** One model's published short-context prices. */
export interface ModelPrice {
  rates: Rates;
  /** Rates at a speed other than standard, by the price list's tier name ("priority", "ultrafast", "flex"). */
  tiers?: Record<string, Rates>;
  /** A speed priced as a multiple of the standard rates ("fast": 2). */
  multipliers?: Record<string, number>;
}

export interface PriceList {
  fetchedAt: string;
  models: Record<string, ModelPrice>;
}

/** LiteLLM's community-kept list of published API prices, read for models Scarlet's own table doesn't have. */
export const PRICE_LIST_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const PROVIDERS = new Set(["openai", "anthropic", "gemini"]);
const TIER_FIELD = /^input_cost_per_token_([a-z]+)$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const perMillion = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v * 1e12) / 1e6 : undefined;

function ratesOf(entry: Record<string, unknown>, suffix = ""): Rates | undefined {
  const input = perMillion(entry[`input_cost_per_token${suffix}`]);
  const output = perMillion(entry[`output_cost_per_token${suffix}`]);
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = perMillion(entry[`cache_read_input_token_cost${suffix}`]);
  const cacheWrite = perMillion(entry[`cache_creation_input_token_cost${suffix}`]);
  return cacheWrite !== undefined ? [input, output, cacheRead ?? input, cacheWrite] : cacheRead !== undefined ? [input, output, cacheRead] : [input, output];
}

/** The chat models of the providers Scarlet runs, from LiteLLM's price file, at short-context rates. */
export function pickPrices(raw: unknown): Record<string, ModelPrice> {
  const models: Record<string, ModelPrice> = {};
  if (!raw || typeof raw !== "object") return models;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const provider = entry.litellm_provider;
    if (typeof provider !== "string" || !PROVIDERS.has(provider) || entry.mode !== "chat") continue;
    const id = provider === "gemini" ? key.replace(/^gemini\//, "") : key;
    if (/[/:]/.test(id)) continue;
    const rates = ratesOf(entry);
    if (!rates) continue;
    const price: ModelPrice = { rates };
    for (const field of Object.keys(entry).sort()) {
      const tier = TIER_FIELD.exec(field)?.[1];
      if (!tier || tier === "batches") continue;
      const tierRates = ratesOf(entry, `_${tier}`);
      if (tierRates) (price.tiers ??= {})[tier] = tierRates;
    }
    const specific = entry.provider_specific_entry;
    if (specific && typeof specific === "object") {
      for (const [name, factor] of Object.entries(specific as Record<string, unknown>)) {
        // "us" and the like are regional uplifts, not speeds.
        if (name === "fast" && typeof factor === "number" && factor > 0) (price.multipliers ??= {})[name] = factor;
      }
    }
    models[id] = price;
  }
  return Object.fromEntries(Object.entries(models).sort(([a], [b]) => a.localeCompare(b)));
}

/** A speed's name in the price list. Codex calls Fast "priority" or "fast"; the list prices it as "priority" for OpenAI. */
function tierRates(price: ModelPrice, tier: string, standard: Rates): Rates | undefined {
  const direct = price.tiers?.[tier] ?? (tier === "fast" ? price.tiers?.priority : undefined);
  if (direct) return direct;
  const factor = price.multipliers?.[tier] ?? (tier === "priority" ? price.multipliers?.fast : undefined);
  if (factor === undefined) return undefined;
  const [input, output, cacheRead, cacheWrite] = standard;
  return [input * factor, output * factor, cacheRead === undefined ? undefined : cacheRead * factor,
    cacheWrite === undefined ? undefined : cacheWrite * factor];
}

export interface PriceLookup {
  /** Rates for `model` at `tier` from the price lists, given the standard rates Scarlet's own table has, if any. */
  rates(model: string, tier: string | undefined, standard: Rates | undefined): Rates | undefined;
  /** A model or speed had no price: look again, at most once a day. */
  missed(): void;
}

interface Options {
  /** Where the fetched list is kept between runs. */
  file?: string;
  /** Leave out to never fetch, as tests and tools do. */
  fetch?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
}

/** The price list shipped with this build, and a newer one fetched when a model turns up that neither has. */
export class ModelPrices implements PriceLookup {
  private fetched: PriceList | undefined;
  private lastTry = 0;
  private loading: Promise<void> | undefined;
  private refreshing: Promise<boolean> | undefined;
  private readonly now: () => number;
  /** Told when a fetched list replaced the one in use, so totals shown already can be priced again. */
  onUpdate?: () => void;

  constructor(private readonly opts: Options = {}, private readonly snapshot: PriceList = MODEL_PRICES_SNAPSHOT) {
    this.now = opts.now ?? Date.now;
    if (opts.file) this.loading = this.load(opts.file);
  }

  private async load(file: string) {
    try {
      const list = JSON.parse(await readFile(file, "utf8")) as PriceList;
      if (list && typeof list.fetchedAt === "string" && list.models && typeof list.models === "object") {
        // A list kept from before this build would hide the newer prices it shipped with.
        if (Date.parse(list.fetchedAt) > Date.parse(this.snapshot.fetchedAt)) this.fetched = list;
        this.lastTry = Date.parse(list.fetchedAt) || 0;
      }
    } catch {
      // No list fetched yet.
    }
  }

  /** Waits for the list kept from an earlier run. */
  ready(): Promise<void> {
    return this.loading ?? Promise.resolve();
  }

  rates(model: string, tier: string | undefined, standard: Rates | undefined): Rates | undefined {
    const price = this.fetched?.models[model] ?? this.snapshot.models[model];
    if (!tier) return standard ?? price?.rates;
    return price ? tierRates(price, tier, standard ?? price.rates) : undefined;
  }

  missed(): void {
    if (!this.opts.fetch || this.refreshing || this.now() - this.lastTry < DAY_MS) return;
    void this.refresh();
  }

  /** Fetch the list now. Resolves true when a list was saved. */
  refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    const { fetch: get, file, log } = this.opts;
    if (!get) return Promise.resolve(false);
    this.lastTry = this.now();
    this.refreshing = (async () => {
      try {
        await this.loading;
        const res = await get(PRICE_LIST_URL, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const models = pickPrices(await res.json());
        if (!Object.keys(models).length) throw new Error("no models in the list");
        const list: PriceList = { fetchedAt: new Date(this.now()).toISOString(), models };
        this.fetched = list;
        if (file) {
          await mkdir(dirname(file), { recursive: true });
          await writeFile(`${file}.tmp`, JSON.stringify(list));
          await rename(`${file}.tmp`, file);
        }
        log?.(`[engine] model prices updated (${Object.keys(models).length} models)`);
        this.onUpdate?.();
        return true;
      } catch (err) {
        log?.(`[engine] model prices not updated: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }
}
