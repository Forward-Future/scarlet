#!/usr/bin/env node
/**
 * scarlet-engine — one executable for everything that is not the UI:
 *
 *   scarlet-engine serve [--port 4000] [--data ./data] [--solo]
 *   scarlet-engine mcp --server URL --token-file PATH --project ID [...]
 *
 * `serve` is the default when no subcommand is given (so `scarlet-server` keeps
 * working). Scarlet is single-user: there is no login, just an access token
 * for the local user (kept in `<data>/access-token`). The desktop app uses
 * `--solo` to bind the API to loopback and receive the startup handshake:
 *
 *   SCARLET_READY {"port":N,"url":"http://127.0.0.1:N","token":"sct_...","userId":"usr_..."}
 */
import { existsSync, fstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    // `--data=/a/b=c`: the value is everything after the first "=".
    const eq = a.indexOf("=");
    if (eq > 2) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}

const HELP = `scarlet-engine <command> [options]

  serve   [--port 4000] [--data ./data] [--solo]
          Run the headless Scarlet engine (default command).
          --solo   loopback only, print SCARLET_READY {...} when up (the desktop app).
  mcp     --server URL --token-file PATH --project ID [--task ID] [--agent X] [--model M] [--workdir DIR]
          Run the Scarlet MCP server over stdio (what AI CLIs connect to).

Environment: SCARLET_PORT, SCARLET_DATA, SCARLET_SKILLS_SEED,
             SCARLET_HOST (bind address, default 127.0.0.1),
             OPENAI_API_KEY (transcription + note cleanup), ANTHROPIC_API_KEY (note cleanup),
             FFMPEG_PATH / FFPROBE_PATH,
             SCARLET_TELEMETRY_ENABLED (false turns off anonymous usage reports; see docs/telemetry.md)`;

async function runMcp(argv: string[]) {
  // Inside the single-file bundle the MCP module would otherwise also run its
  // own auto-main; this flag tells it the engine is in charge.
  process.env.SCARLET_ENGINE_EMBEDDED = "1";
  const { main: runMcpCli } = await import("@scarlet/mcp/cli");
  await runMcpCli(argv);
}

async function runServe(argv: string[]) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.web !== undefined) {
    console.error("The engine serves the API only. Open the Scarlet desktop app to edit a project.");
    process.exitCode = 2;
    return;
  }
  // Analysis workers and agent tool connections use the same executable.
  // Initialize the HTTP engine only in the process that will serve requests.
  const [{ serve }, { createApp }, { accessToken, localUser, publishDesktopSession }, { attachWebSocket }, { DEFAULT_POSTHOG_KEY }] = await Promise.all([
    import("@hono/node-server"), import("./app.js"), import("./auth.js"), import("./ws.js"),
    import("./telemetry/config.js"),
  ]);
  const solo = args.solo === true;
  const port = Number(args.port ?? process.env.SCARLET_PORT ?? (solo ? 0 : 4000));
  const dataDir = resolve(String(args.data ?? process.env.SCARLET_DATA ?? "./data"));
  // When running from source the repo's skills/ dir is preferred; the compiled
  // engine falls back to the set bundled at build time.
  let defaultSeed: string | undefined;
  try {
    defaultSeed = resolve(dirname(fileURLToPath(import.meta.url)), "../../../skills");
  } catch {
    defaultSeed = undefined;
  }
  const skillsSeedDir =
    process.env.SCARLET_SKILLS_SEED ?? (defaultSeed && existsSync(resolve(defaultSeed, "dialogue-pass", "SKILL.md")) ? defaultSeed : undefined);

  // Nothing else catches these, and either one stops the engine. Say so in the log's own form as it goes.
  const fatal = (what: string) => (err: unknown) => {
    console.error(`[error] engine stopped on ${what}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  };
  process.on("uncaughtException", fatal("an uncaught error"));
  process.on("unhandledRejection", fatal("an unhandled rejection"));

  const { app, ctx } = createApp({
    dataDir,
    skillsSeedDir,
    desktopPid: solo ? process.ppid : undefined,
    prepareSourceProxies: true,
    backgroundCheckpoints: true,
    telemetry: { posthogKey: isSea() ? DEFAULT_POSTHOG_KEY : undefined },
  });

  const hostname = solo ? "127.0.0.1" : (process.env.SCARLET_HOST ?? "127.0.0.1");
  const server = serve({ fetch: app.fetch, port, hostname }, (info: AddressInfo) => {
    const user = localUser(ctx);
    const token = accessToken(ctx);
    if (solo) {
      publishDesktopSession(ctx, info.port);
      const ready = { port: info.port, url: `http://127.0.0.1:${info.port}`, token, userId: user.id, dataDir };
      console.log(`SCARLET_READY ${JSON.stringify(ready)}`);
      return;
    }
    const settings = ctx.settings();
    console.log(`Scarlet engine listening on ${hostname}:${info.port}`);
    console.log(`  data:          ${dataDir}`);
    console.log(`  transcription: ${settings.transcription.provider}`);
    console.log(`  note cleanup:  ${settings.noteCleanup.enabled ? "on" : "off"}`);
    console.log(`  access token:  ${ctx.paths.accessToken} (agent host / MCP: --token-file)`);
  }) as Server;

  // Multi-GB uploads can outlast Node's default five-minute request deadline.
  server.requestTimeout = 6 * 60 * 60 * 1000;
  attachWebSocket(server, ctx);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    if (!solo) console.log("shutting down...");
    server.close();
    await ctx.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // The desktop app closes our stdin when it exits; treat that as a stop signal
  // so a crashed parent never leaves an orphan engine running.
  if (solo && stdinIsPipe()) {
    process.stdin.resume();
    process.stdin.on("end", shutdown);
    process.stdin.on("close", shutdown);
  }
}

/**
 * True when stdin is a pipe/socket from a parent process. Windows reports pipes
 * with no type flag at all, so test for what it is not: a TTY, a null/character
 * device, or a regular file.
 */
function stdinIsPipe(): boolean {
  try {
    const st = fstatSync(0);
    if (process.stdin.isTTY) return false;
    return !st.isCharacterDevice() && !st.isFile() && !st.isDirectory();
  } catch {
    return false;
  }
}

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "serve";
const rest = command === argv[0] ? argv.slice(1) : argv;

if (command === "review-spots") {
  if (rest.length !== 3) process.exit(2);
  import("./services/spotWorker.mjs").catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
} else if (command === "audio-worker") {
  // The aligner and the filler model, kept loaded for the engine that started this process.
  import("./transcribe/audioWorker.js").then(({ serveAudioWorker }) => serveAudioWorker()).catch(err => {
    console.error(`[audio] ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
} else if (command === "diarize-audio") {
  // A trailing "cpu" skips the GPU runtime, for the retry after it failed.
  if (rest.length !== 3 && !(rest.length === 4 && rest[3] === "cpu")) process.exit(2);
  import("./transcribe/speakerWorker.js").then(async ({ runSpeakerWorker }) => {
    const turns = await runSpeakerWorker(rest[0]!, rest[1]!, rest[2]!, progress => process.send?.(progress), rest[3] === "cpu");
    process.stdout.write(JSON.stringify(turns));
  }).catch(err => {
    console.error(`[speakers] ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  });
} else if (command === "model-catalog") {
  const [agent, file] = rest;
  if ((agent !== "claude" && agent !== "codex" && agent !== "gemini") || !file) process.exit(2);
  import("@scarlet/agent/dist/modelCatalog.js")
    .then(({ discoverModels }) => discoverModels(agent, file, process.env))
    .then((catalog) => console.log(JSON.stringify(catalog ?? null)))
    .catch(err => {
      console.error(`[models] ${agent}: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    });
} else if (command === "mcp") {
  runMcp(rest).catch((err) => {
    console.error(`[scarlet-engine mcp] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
} else if (command === "serve") {
  runServe(rest).catch(err => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
} else if (command === "--help" || command === "help") {
  console.log(HELP);
} else {
  console.error(`unknown command: ${command}\n\n${HELP}`);
  process.exit(2);
}
