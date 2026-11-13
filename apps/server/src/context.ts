import { RecordingSpeakers } from "./services/recordingSpeakers.js";
import { audioWorker } from "./transcribe/audioWorker.js";
import { AnalysisCache } from "./services/analysisCache.js";
import type { ServerSettings } from "@scarlet/shared";
import type { JoinFades, Transcript } from "@scarlet/timeline";
import { openDb, type Db } from "./db.js";
import { Bus } from "./events.js";
import { humanDuration } from "./logText.js";
import { Paths } from "./paths.js";
import { createRepos, type Repos } from "./repo/index.js";
import type { RenderAdapter, WaveformCache } from "./render/adapter.js";
import { scarletRenderAdapter as defaultAdapter } from "./render/scarletRender.js";
import type { RenderQueue } from "./services/renderQueue.js";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { createTelemetry, type Telemetry } from "./telemetry/analytics.js";
import { telemetryConfig } from "./telemetry/config.js";
import { bundledWhisperCli, bundledWhisperGpu, LocalWhisperModel } from "./transcribe/localModel.js";
import { hasCrisperWhisper } from "./transcribe/localRuntime.js";

/** Permission errors mean the owner may still be working in another desktop instance. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** When this engine's process began: what it notes beside its process id, and what `ps` has to say of it as well. */
const ENGINE_STARTED = performance.timeOrigin;
/** A process that began within this of an engine's note is taken for that engine: `ps` counts whole seconds, and no id is handed on so soon. */
const START_LEEWAY_MS = 60_000;
/** How long "its engine still runs" is believed before asking again: the id can go to another program at any time. */
const START_ASK_EVERY_MS = 30_000;

/** What was last learned of the process that has an id, for the engine start noted beside that id. */
interface StartCheck { noted: number; reused: boolean; asked: number }
const startChecks = new Map<number, StartCheck>();

/**
 * Notes when this engine began beside its process id, for other engines to hold that id against (`engineIsAlive`).
 * True when the note already there is an earlier engine's: it was killed, and this engine was then given its process
 * id. What it left claimed under that id would pass for this engine's own work and never be taken up. Its imports and
 * source caches are released here; its renders are the caller's to recover.
 */
export function noteEngineStart(ctx: Pick<Ctx, "db" | "log">): boolean {
  const inherited = ctx.db.transaction(() => {
    const noted = ctx.db.prepare("SELECT started_at FROM engines WHERE pid = ?").get(process.pid) as { started_at: number } | undefined;
    // Another engine in this process noted the same start, as in tests: what is claimed under the id is its work.
    if (noted?.started_at === ENGINE_STARTED) return false;
    ctx.db.prepare("INSERT OR REPLACE INTO engines (pid, started_at) VALUES (?, ?)").run(process.pid, ENGINE_STARTED);
    if (!noted) return false;
    ctx.db.prepare("UPDATE media SET ingest_pid = NULL WHERE ingest_pid = ?").run(process.pid);
    ctx.db.prepare("UPDATE source_cache_requests SET worker_pid = NULL WHERE worker_pid = ?").run(process.pid);
    return true;
  }, "immediate")();
  if (inherited) ctx.log(`[engine] the last engine with this process id (${process.pid}) was killed: what it left claimed is taken up`);
  return inherited;
}

/**
 * Whether the engine that claimed an import, a source cache or a render under a process id still runs. A process with
 * that id is not enough: once an engine is killed its id goes to another program, which would hold the claim for as
 * long as it runs. The process must also have begun when the engine noted that it did.
 *
 * Two engines on one import or render write the same files, so only a process known to have begun after the note is
 * another program. Anything less leaves the claim where it is: an engine that noted nothing (an earlier build), a
 * start that can't be read or made out, a clock that moved. `ps` reads the start, off the engine's thread, and the
 * answer is kept, so this says the engine runs until that is known. Only macOS is asked: its `ps` counts a process's
 * age from what the clock read as it began, as the note does. Linux counts it from boot, so a clock set forward since
 * would read as a later start, and Windows has no `ps`.
 */
export function engineIsAlive(ctx: Pick<Ctx, "db" | "track" | "log">, pid: number): boolean {
  if (pid === process.pid) return true;
  if (!processIsAlive(pid)) {
    startChecks.delete(pid);
    return false;
  }
  if (process.platform !== "darwin") return true;
  const note = ctx.db.prepare("SELECT started_at FROM engines WHERE pid = ?").get(pid) as { started_at: number } | undefined;
  if (!note) return true;
  let check = startChecks.get(pid);
  // A later engine given the same id notes its own start. What was learned for the earlier note says nothing of it.
  if (check?.noted !== note.started_at) startChecks.set(pid, check = { noted: note.started_at, reused: false, asked: -Infinity });
  if (check.reused) return false;
  const time = performance.now();
  if (time - check.asked >= START_ASK_EVERY_MS) {
    check.asked = time;
    void ctx.track(askStart(ctx, pid, check));
  }
  return true;
}

/** Asks `ps` when the process that has an id began, and marks the id as another program's when that was after its engine's note. */
async function askStart(ctx: Pick<Ctx, "log">, pid: number, check: StartCheck): Promise<void> {
  const asked = Date.now();
  // This engine is asked about too: what `ps` says of it shows how far to believe what it says of the other.
  const said = await new Promise<string>(resolve => execFile("/bin/ps", ["-o", "pid=,etime=", "-p", `${pid},${process.pid}`], { timeout: 10_000 },
    (error, stdout) => resolve(error ? "" : stdout)));
  // `ps` gives each process's age in whole seconds, as [[days-]hours:]minutes:seconds. Counted back from before it was
  // asked, with a second for the rounding, a process began no earlier than this.
  const earliest = new Map<number, number>();
  for (const line of said.split("\n")) {
    const age = /^\s*(\d+)\s+(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s*$/.exec(line);
    if (!age) continue;
    const [id, days, hours, minutes, seconds] = age.slice(1).map(part => Number(part ?? 0)) as [number, number, number, number, number];
    earliest.set(id, asked - 1000 * (((days * 24 + hours) * 60 + minutes) * 60 + seconds + 1));
  }
  const own = earliest.get(process.pid), other = earliest.get(pid);
  // Counted this way no process began after it really did. If this engine seems to have, the clock moved while `ps`
  // was asked, and the other count is off by as much.
  if (own === undefined || other === undefined || own > ENGINE_STARTED) return;
  if (other <= check.noted + START_LEEWAY_MS) return;
  check.reused = true;
  ctx.log(`[engine] process ${pid} began at least ${humanDuration(other - check.noted)} after the engine that noted that id, so it is another program: what that engine left claimed is free`);
}

export interface ServerOptions {
  dataDir: string;
  /** The in-process agent host that launched this solo engine. */
  desktopPid?: number;
  /** Directory of `<name>/SKILL.md` folders to seed on first run. */
  skillsSeedDir?: string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  render?: RenderAdapter;
  /** Make complete GPU proxies for footage in the background (the desktop engine). */
  prepareSourceProxies?: boolean;
  telemetry?: {
    /** Default project token for the packaged engine. SCARLET_POSTHOG_KEY takes precedence. */
    posthogKey?: string;
    fetch?: typeof fetch;
    now?: () => number;
    random?: () => number;
  };
}

export interface Ctx {
  db: Db;
  repos: Repos;
  paths: Paths;
  bus: Bus;
  render: RenderAdapter;
  renders: RenderQueue;
  settings(): ServerSettings;
  env: { openaiKey?: string; anthropicKey?: string };
  options: ServerOptions;
  log(message: string): void;
  /** Anonymous usage reports. See docs/telemetry.md. */
  telemetry: Telemetry;
  /** Background promises to await on shutdown/in tests. */
  pending: Set<Promise<unknown>>;
  shutdown: AbortSignal;
  /** Stops when the project goes to Trash or the engine quits. For work the editor or a running edit asked for. */
  projectSignal(projectId: string): AbortSignal;
  /**
   * Stops with those and when the project's media work is paused. For the work Scarlet does unasked, such as caching
   * and reading new files. A read a running edit asks for is not that work, and uses `projectSignal`. A transcription
   * does too: the pause holds it only while no request is under way (`holdTranscriptions`).
   */
  mediaSignal(projectId: string): AbortSignal;
  stopMedia(projectId: string, deleted?: boolean): void;
  waveforms: Map<string, Promise<WaveformCache | null>>;
  /** Of the waveforms being built, those someone asked to have prepared now, by media id: a pause doesn't stop these. */
  waveformsAsked: Set<string>;
  waveformReads: AnalysisCache<WaveformCache>;
  transcriptions: Map<string, { controller: AbortController; done: Promise<Transcript | null> }>;
  whisperCli?: string;
  /** The bundled GPU build, tried before `whisperCli` when the bundled runtime is in use. */
  whisperGpu?: string;
  whisperModel: LocalWhisperModel;
  speakers: RecordingSpeakers;
  spotChecks: AnalysisCache<Array<number | null> | null>;
  /** A review selection's saved draft, and the crossfade Scarlet put on its joins. */
  reviewDrafts: Map<string, { version: string; joinFades?: JoinFades }>;
  track<T>(p: Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createContext(options: ServerOptions): Omit<Ctx, "renders"> {
  const paths = new Paths(options.dataDir);
  paths.ensureRoot();
  const db = openDb(paths.db);
  const env = options.env ?? process.env;
  const whisperCli = bundledWhisperCli(env);
  // The audio helper is one per engine process. Its notes on where each model runs go to this engine's log.
  audioWorker.log = options.log ?? (m => console.log(m));
  const repos = createRepos(db, () => whisperCli || hasCrisperWhisper(paths.root) ? "whispercpp" : "none");
  const pending = new Set<Promise<unknown>>();
  const shutdown = new AbortController();
  const log = options.log ?? ((m: string) => console.log(m));
  const projectControllers = new Map<string, AbortController>();
  const mediaControllers = new Map<string, AbortController>();
  function workerSignal(controllers: Map<string, AbortController>, id: string) {
    let controller = controllers.get(id);
    if (!controller) controllers.set(id, controller = new AbortController());
    return AbortSignal.any([shutdown.signal, controller.signal]);
  }
  const ctx: Omit<Ctx, "renders"> = {
    db,
    repos,
    paths,
    bus: new Bus(db),
    render: options.render ?? defaultAdapter,
    settings: () => repos.settings.get(),
    env: { openaiKey: env.OPENAI_API_KEY || undefined, anthropicKey: env.ANTHROPIC_API_KEY || undefined },
    options,
    log,
    telemetry: createTelemetry({
      config: telemetryConfig(env, options.telemetry?.posthogKey),
      idFile: paths.telemetryId,
      preference: () => repos.settings.telemetryPreference(),
      log,
      fetch: options.telemetry?.fetch,
      now: options.telemetry?.now,
      random: options.telemetry?.random,
    }),
    pending,
    shutdown: shutdown.signal,
    projectSignal(id) {
      if (!repos.projects.header(id)) return AbortSignal.abort(new Error("Project is in Trash."));
      return workerSignal(projectControllers, id);
    },
    mediaSignal(id) {
      const project = repos.projects.header(id);
      if (!project || project.mediaPaused) return AbortSignal.abort(new Error("Project media processing stopped."));
      return workerSignal(mediaControllers, id);
    },
    stopMedia(id, deleted) {
      if (deleted) {
        projectControllers.get(id)?.abort();
        projectControllers.delete(id);
      }
      mediaControllers.get(id)?.abort();
      mediaControllers.delete(id);
    },
    transcriptions: new Map(),
    waveforms: new Map(),
    waveformsAsked: new Set(),
    waveformReads: new AnalysisCache(w => (w.peaks.length + (w.rms?.length ?? 0)) * (w.peaks instanceof Float32Array ? 4 : 8)),
    whisperCli,
    whisperGpu: whisperCli ? bundledWhisperGpu(env) : undefined,
    speakers: new RecordingSpeakers(paths.root),
    spotChecks: new AnalysisCache(owners => (owners?.length ?? 0) * 8, 1024 * 1024, 1),
    reviewDrafts: new Map(),
    whisperModel: new LocalWhisperModel(join(paths.root, "models")),
    track<T>(p: Promise<T>) {
      pending.add(p);
      p.finally(() => pending.delete(p)).catch(() => {});
      return p;
    },
    async close() {
      shutdown.abort();
      while (pending.size) await Promise.allSettled([...pending]);
      // The note of when this engine began is for the engine that finds its claims after it was killed. A clean quit
      // takes the note away. Left behind, it would stay beside an id that may next go to an earlier build's engine,
      // which notes nothing and would then be taken for another program.
      try {
        db.prepare("DELETE FROM engines WHERE pid = ? AND started_at = ?").run(process.pid, ENGINE_STARTED);
      } catch {
        // It stays, as after a kill.
      }
      // Shutdown work can still record an event. Read the final privacy preference before closing the library.
      try {
        await ctx.telemetry.close();
      } finally {
        db.close();
      }
    },
  };
  // Reads ctx.log when it happens, so a log set after startup still gets it.
  db.onEffectError = error => ctx.log(`[error] after-commit listener failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  return ctx;
}
