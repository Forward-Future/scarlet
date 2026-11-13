import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod/v3";
import { OpError, TimelinePlanningError } from "@scarlet/timeline";
import { authMiddleware, type AppEnv } from "./auth.js";
import { createContext, noteEngineStart, type Ctx, type ServerOptions } from "./context.js";
import { HttpError } from "./errors.js";
import { clip, humanDuration } from "./logText.js";
import { logStateChanges } from "./eventLog.js";
import { authRoutes } from "./routes/auth.js";
import { changeRoutes } from "./routes/changes.js";
import { hostRoutes } from "./routes/hosts.js";
import { inspectionRoutes } from "./routes/inspection.js";
import { mediaRoutes } from "./routes/media.js";
import { noteRoutes } from "./routes/notes.js";
import { projectRoutes } from "./routes/projects.js";
import { renderRoutes } from "./routes/renders.js";
import { storageRoutes } from "./routes/storage.js";
import { settingsRoutes } from "./routes/settings.js";
import { skillRoutes } from "./routes/skills.js";
import { historyRoutes } from "./routes/history.js";
import { evalExportRoutes } from "./routes/evalExport.js";
import { scheduleTrashPurge } from "./services/trash.js";
import { migrateDialogueOperations } from "./services/tasks.js";
import { taskRoutes } from "./routes/tasks.js";
import { continueReadyRuns, recoverTasks, wireContinueWhenReady } from "./services/taskRecovery.js";
import { sweepLeftovers } from "./services/leftovers.js";
import { recoverSourcePreviews } from "./services/sourcePreviews.js";
import { holdTranscriptions, recoverIngestInBackground } from "./services/ingest.js";
import { timelineRoutes } from "./routes/timeline.js";
import { perceptionRoutes } from "./routes/perception.js";
import { foldStrandedPasses, recordLeftOutFootage, retireLeftoverPasses, wireChangeRenderCompletion } from "./services/changes.js";
import { RenderQueue } from "./services/renderQueue.js";
import { migrateQuickActions } from "./services/migrateQuickActions.js";
import { retireMergedSkills, migrateGlobalSkills, seedSkillList, seedSkills } from "./services/skills.js";
import { BUNDLED_SKILLS } from "./bundledSkills.js";
import { featureForRequest } from "@scarlet/shared";

export interface ScarletApp {
  app: Hono<AppEnv>;
  ctx: Ctx;
}

const DEV_ORIGIN = /^(https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?|tauri:\/\/localhost|https?:\/\/tauri\.localhost)$/;
const SLOW_REQUEST_MS = 30_000;
/** A request this slow held the window back, even when it then succeeded. */
const NOTABLE_REQUEST_MS = 1000;
/** Writes too frequent to log one by one while they succeed quickly: a host's check-ins, and render requests, whose renders are logged as they finish. */
const ROUTINE_WRITES = /\/hosts\/[^/]+\/(heartbeat|claim)$|\/renders$|\/renders\/[^/]+\/owners\/[^/]+$/;

/**
 * Where a request failed validation: the first field and the kind of problem, with a count of the rest.
 * Never the issue's own message, which can quote the value that was sent.
 */
function invalidAt(error: { code?: string; details?: unknown }): string {
  if (error.code !== "validation_error" || !Array.isArray(error.details) || !error.details.length) return "";
  const [first] = error.details as Array<{ path?: unknown; code?: unknown }>;
  const path = Array.isArray(first?.path) && first.path.length ? first.path.join(".") : "the body";
  const more = error.details.length - 1;
  return ` at ${clip(path, 80)} (${typeof first?.code === "string" ? first.code : "invalid"})${more ? `, and ${more} more` : ""}`;
}

export function createApp(options: ServerOptions): ScarletApp {
  const partial = createContext(options);
  const ctx = partial as Ctx;
  logStateChanges(ctx);
  migrateGlobalSkills(ctx);
  ctx.renders = new RenderQueue(ctx);
  wireChangeRenderCompletion(ctx);
  // Before anything is recovered or claimed: an engine that was killed may have had the process id this one was given.
  ctx.renders.recover(noteEngineStart(ctx));
  recoverTasks(ctx, true);
  // A repair of earlier builds' leftovers. It must never keep Scarlet from starting.
  try {
    retireLeftoverPasses(ctx);
  } catch (err) {
    ctx.log(`[edit] couldn’t put away leftover versions of applied passes: ${(err as Error).message}`);
  }
  try {
    foldStrandedPasses(ctx);
  } catch (err) {
    ctx.log(`[edit] couldn’t gather the waiting parts of dialogue passes: ${(err as Error).message}`);
  }
  try {
    recordLeftOutFootage(ctx);
  } catch (err) {
    ctx.log(`[edit] couldn’t read the footage that built videos left out: ${(err as Error).message}`);
  }
  try {
    sweepLeftovers(ctx);
  } catch (err) {
    ctx.log(`[storage] couldn’t remove leftover working files: ${(err as Error).message}`);
  }
  wireContinueWhenReady(ctx);
  continueReadyRuns(ctx);
  // Another desktop engine can trash or pause a project in the shared library.
  const dataVersion = ctx.db.prepare("PRAGMA data_version");
  let seenVersion = (dataVersion.get() as { data_version: number }).data_version;
  let peerFailure = false;
  const followPeers = () => {
    const { data_version } = dataVersion.get() as { data_version: number };
    if (data_version === seenVersion) return;
    ctx.settings(); // Revoke a provider selected before another engine changed it.
    ctx.telemetry.refreshPreference();
    for (const [id, worker] of ctx.transcriptions) {
      if (ctx.repos.tasks.get(id)?.state !== "running") worker.controller.abort();
    }
    const stopped = ctx.db.prepare("SELECT id, deleted_at FROM projects WHERE deleted_at IS NOT NULL OR media_paused = 1").all() as
      Array<{ id: string; deleted_at: string | null }>;
    for (const row of stopped) {
      ctx.stopMedia(row.id, !!row.deleted_at);
      ctx.renders.stopProject(row.id, !row.deleted_at);
      if (!row.deleted_at) holdTranscriptions(ctx, row.id);
    }
    // Only once it has been acted on, so a change that couldn't be is taken up on the next tick.
    seenVersion = data_version;
    peerFailure = false;
  };
  const peerChanges = setInterval(() => {
    // Nothing catches a throw from a timer: it would stop the engine.
    try {
      followPeers();
    } catch (err) {
      // Once per failure, not once a second while it lasts.
      if (!peerFailure) ctx.log(`[project] reacting to another engine’s change failed and will run again: ${(err as Error).message}`);
      peerFailure = true;
    }
  }, 1000);
  peerChanges.unref();
  let lastRecovery = Date.now();
  // How late the rounds have come, added up over those that came late one after another.
  let behind = 0;
  // Each step runs whether or not the one before it threw, and again in half a minute.
  const step = (tag: string, what: string, run: () => void) => {
    try {
      run();
    } catch (err) {
      ctx.log(`[${tag}] ${what} failed and will run again: ${(err as Error).message}`);
    }
  };
  const taskRecovery = setInterval(() => {
    // A round that comes late means the computer slept or the engine stalled, and no worker could say it was alive
    // meanwhile. A worker's last word can be half a minute old as that begins and it is given up after 90 s without
    // one, so a minute is too long to lose. The lateness of rounds that come late one after another adds up, since a
    // worker asleep through them has said nothing in between. Past 15 s the workers get their window again, which
    // leaves one late round a quarter of a minute for a word that is itself late. Sleep that ends before a round is
    // due is not seen here.
    const late = Date.now() - lastRecovery - 30_000;
    lastRecovery = Date.now();
    behind = late > 1_000 ? behind + late : 0;
    const wokeFromSleep = behind > 15_000;
    if (wokeFromSleep) behind = 0;
    step("task", "recovering interrupted runs", () => recoverTasks(ctx, wokeFromSleep));
    step("task", "continuing waiting runs", () => continueReadyRuns(ctx));
    step("render", "recovering interrupted renders", () => ctx.renders.recover());
    recoverIngestInBackground(ctx);
    step("media", "resuming source previews", () => recoverSourcePreviews(ctx));
  }, 30_000);
  taskRecovery.unref();
  const stopPurge = scheduleTrashPurge(ctx);
  recoverIngestInBackground(ctx);
  recoverSourcePreviews(ctx);
  const close = ctx.close.bind(ctx);
  ctx.close = async () => {
    stopPurge();
    clearInterval(taskRecovery);
    clearInterval(peerChanges);
    await close();
  };
  migrateQuickActions(ctx);
  const seeded = options.skillsSeedDir ? seedSkills(ctx, options.skillsSeedDir) : seedSkillList(ctx, BUNDLED_SKILLS);
  retireMergedSkills(ctx);
  migrateDialogueOperations(ctx);
  if (seeded) ctx.log(`[skills] seeded ${seeded} skill(s) from ${options.skillsSeedDir ?? "the bundled set"}`);
  if (ctx.telemetry.active) {
    const { projectCount } = ctx.db.prepare("SELECT count(*) AS projectCount FROM projects WHERE deleted_at IS NULL").get() as { projectCount: number };
    ctx.telemetry.record("server.boot.heartbeat", { projectCount });
  }
  ctx.telemetry.start();

  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as ContentfulStatusCode);
    }
    if (err instanceof TimelinePlanningError) {
      return c.json({ error: { code: "timeline_limit", message: err.message } }, 422);
    }
    if (err instanceof ZodError) {
      return c.json({ error: { code: "validation_error", message: "request validation failed", details: err.issues } }, 400);
    }
    if (err instanceof OpError) {
      return c.json({ error: { code: "invalid_ops", message: err.message, details: { op: err.op } } }, 400);
    }
    // A caller that went away aborts its own work, or the body it was still sending. That is a cancellation, not a
    // fault: no stack in the log, and the same answer the routes that check for it give.
    const cancelled = err.name === "AbortError" || (err as NodeJS.ErrnoException).code === "ECONNRESET" || err.message === "aborted";
    if (cancelled && (c.req.raw.signal?.aborted || ctx.shutdown.aborted)) return new Response(null, { status: ctx.shutdown.aborted ? 503 : 499 });
    ctx.log(`[error] ${c.req.method} ${c.req.path}: ${err.stack ?? err.message}`);
    return c.json({ error: { code: "internal_error", message: err.message || "internal error" } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: "not_found", message: `no route for ${c.req.method} ${c.req.path}` } }, 404));

  const api = new Hono<AppEnv>();
  // A request that holds its caller this long is usually waiting on media work. Log it, and whether the caller
  // gave up first (Node's fetch stops waiting for headers after 5 minutes). Long polls ask to wait.
  // Below that, every request that changed something, failed or was slow gets a line: what the window or an agent
  // asked for, whether it worked, and the engine's reason when it didn't. Quick reads and routine writes don't.
  const repeats = new Map<string, { at: number; more: number }>();
  api.use("*", async (c, next) => {
    const started = Date.now();
    await next();
    const ms = Date.now() - started;
    const { method, path } = c.req;
    const status = c.res.status;
    const waited = c.req.query("wait") !== undefined;
    const gone = c.req.raw.signal?.aborted ? "; the caller had already disconnected" : "";
    if (ms >= SLOW_REQUEST_MS && !waited) {
      ctx.log(`[http] slow request: ${method} ${path} → ${status} after ${humanDuration(ms)}${gone}`);
      return;
    }
    if (method === "OPTIONS") return;
    const failed = status >= 400, writes = method !== "GET" && method !== "HEAD";
    if (!failed && ms < NOTABLE_REQUEST_MS && (!writes || ROUTINE_WRITES.test(path))) return;
    // The same request answered the same way again and again (a poll for something that isn't there) is one line
    // every ten seconds, with a count of the rest.
    const key = `${method} ${path} ${status}`;
    const last = repeats.get(key);
    if (last && started - last.at < 10_000 && ms < NOTABLE_REQUEST_MS) { last.more++; return; }
    repeats.delete(key);
    repeats.set(key, { at: started, more: 0 });
    if (repeats.size > 500) repeats.delete(repeats.keys().next().value!);
    let reason = "";
    if (failed && c.res.headers.get("content-type")?.includes("json")) {
      const body = await c.res.clone().json().catch(() => undefined) as { error?: { code?: string; message?: string; details?: unknown } } | undefined;
      if (body?.error) reason = `: ${body.error.code ?? "error"}: ${clip(body.error.message ?? "", 200)}${invalidAt(body.error)}`;
    }
    ctx.log(`[http] ${method} ${path} → ${status} in ${humanDuration(ms)}${last?.more ? ` (and ${last.more} more like it)` : ""}${gone}${reason}`);
  });
  api.use(
    "*",
    cors({
      origin: (origin) => (DEV_ORIGIN.test(origin) ? origin : null),
      allowHeaders: ["Authorization", "Content-Type", "Range"],
      exposeHeaders: ["Content-Range", "Accept-Ranges", "Content-Length", "Content-Disposition"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
      credentials: true,
    }),
  );
  const auth = authMiddleware(ctx);
  api.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    return auth(c, next);
  });
  // Counted once the request has succeeded, so a refused or failed one isn't reported as use.
  api.use("*", async (c, next) => {
    await next();
    if (c.res.status < 200 || c.res.status >= 300) return;
    const feature = featureForRequest(c.req.method, c.req.path.replace(/^\/api/, ""));
    if (feature) ctx.telemetry.record("feature.used", { feature });
  });

  api.route("/", authRoutes());
  api.route("/", projectRoutes(ctx));
  api.route("/", timelineRoutes(ctx));
  api.route("/", mediaRoutes(ctx));
  api.route("/", perceptionRoutes(ctx));
  api.route("/", inspectionRoutes(ctx));
  api.route("/", changeRoutes(ctx));
  api.route("/", noteRoutes(ctx));
  api.route("/", renderRoutes(ctx));
  api.route("/", taskRoutes(ctx));
  api.route("/", historyRoutes(ctx));
  api.route("/", hostRoutes(ctx));
  api.route("/", skillRoutes(ctx));
  api.route("/", settingsRoutes(ctx));
  api.route("/", storageRoutes(ctx));
  api.route("/", evalExportRoutes(ctx));
  app.route("/api", api);

  app.get("/health", (c) => c.json({ ok: true }));

  return { app, ctx };
}
