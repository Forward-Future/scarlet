import { ServerSettings } from "@scarlet/shared";
import type { Db } from "../db.js";
import { conflict } from "../errors.js";

/** Settings are a single JSON row; zod defaults fill anything missing. */
export const DEFAULT_SETTINGS_INPUT = { transcription: {}, noteCleanup: {}, render: {} };

type LocalProvider = "whispercpp" | "none";
export type DefaultProvider = LocalProvider | (() => LocalProvider);

/** A patch changes what it names and keeps the rest. null clears a field: JSON can't carry undefined, so that's how an emptied one arrives. */
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) {
      delete out[k];
      continue;
    }
    const cur = out[k];
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
      out[k] = deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export class SettingsRepo {
  private cache: ServerSettings | null = null;
  private raw?: string;
  private revision = 0;
  private cachedDefault?: LocalProvider;
  private transcriptionController = new AbortController();

  get transcriptionSignal(): AbortSignal {
    return this.transcriptionController.signal;
  }
  transcriptionPolicy() {
    const settings = this.get().transcription;
    return { settings, revision: this.revision, signal: this.transcriptionSignal };
  }
  constructor(private readonly db: Db, private readonly defaultProvider: DefaultProvider = "none") {}

  get(): ServerSettings {
    const row = this.db.prepare("SELECT json, transcription_revision FROM settings WHERE id = 1").get() as
      { json: string; transcription_revision: number } | undefined;
    const revision = row?.transcription_revision ?? 0;
    const defaultProvider = typeof this.defaultProvider === "function" ? this.defaultProvider() : this.defaultProvider;
    if (this.cache && this.raw === row?.json && this.revision === revision && this.cachedDefault === defaultProvider) return this.cache;
    const defaults = { ...DEFAULT_SETTINGS_INPUT, transcription: { provider: defaultProvider } };
    const settings = ServerSettings.parse(deepMerge(defaults, row ? JSON.parse(row.json) : {}));
    // Transcription can't be turned off any more: an "Off" saved before goes back to the engine Scarlet ships with.
    // "none" stays only for a build that has no engine to run, where it says transcription is unavailable.
    if (settings.transcription.provider === "none") settings.transcription.provider = defaultProvider;
    const revoke = this.cache && (this.revision !== revision || settings.transcription.provider !== this.cache.transcription.provider);
    this.cache = settings;
    this.cachedDefault = defaultProvider;
    this.raw = row?.json;
    this.revision = revision;
    if (revoke) {
      const previous = this.transcriptionController;
      this.transcriptionController = new AbortController();
      previous.abort(conflict("transcription_settings_changed", "Transcription stopped because the provider changed in Settings or a different local model was selected."));
    }
    return this.cache;
  }

  update(patch: Record<string, unknown>): ServerSettings {
    this.db.transaction(() => {
      const previous = this.get();
      const merged = ServerSettings.parse(deepMerge(previous as unknown as Record<string, unknown>, patch));
      // A first save also passes through the policy revision trigger.
      if (this.raw === undefined) this.db.prepare("INSERT INTO settings (id, json) VALUES (1, ?)").run(JSON.stringify(previous));
      this.db.prepare("UPDATE settings SET json = ? WHERE id = 1").run(JSON.stringify(merged));
    }, "immediate")();
    return this.get();
  }
}
