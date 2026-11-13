// End-to-end check of a built desktop bundle's engine, run in CI on every
// platform: start the bundled engine the way the app does, ingest a clip,
// render a change with captions, and list the MCP tools an agent would get.
// The engine runs with a bare PATH, so it must find the ffmpeg/ffprobe that
// ship beside it.
//
// Usage: node scripts/smoke-engine.mjs <dir with scarlet-engine and ffmpeg>
//   macOS:   .../bundle/macos/Scarlet.app/Contents/MacOS
//   Windows: .../target/<triple>/release
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { registerStorage } from "./register-storage.mjs";
import { smokeEnvironment, startSmokeEngine } from "./smoke-engine-startup.mjs";
import { createRequire } from "node:module";

const dir = resolve(process.argv[2] ?? "");
const exe = process.platform === "win32" ? ".exe" : "";
const engine = join(dir, `scarlet-engine${exe}`);
const ffmpeg = join(dir, `ffmpeg${exe}`);
const whisper = join(dir, `whisper-cli${exe}`);
// fail() exits at once, which skips the `finally` below, so it runs this first.
let cleanup = () => {};
for (const f of [engine, ffmpeg, join(dir, `ffprobe${exe}`), whisper]) {
  if (!existsSync(f)) fail(`missing ${f}`);
}

const work = mkdtempSync(join(tmpdir(), "scarlet-smoke-"));
const unregister = process.env.CI ? () => {} : registerStorage("scratch", work);
const step = (s) => console.log(`[smoke] ${s}`);
let server;
cleanup = () => {
  if (server) server.kill();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  unregister();
};
try {
  if (process.platform === "win32") checkWindowsModelCatalog();
  const speakerAddon = [join(dir, "speaker-runtime"), join(dir, "../Resources/speaker-runtime")]
    .map(root => join(root, "sherpa-onnx.node")).find(existsSync);
  if (!speakerAddon) fail("speaker runtime unavailable");
  // Speaker analysis runs in a worker process with its own version of the ONNX DLL.
  execFileSync(process.execPath, ["-e", "if (!require(process.argv[1]).createOfflineSpeakerDiarization) process.exit(1)", speakerAddon]);
  const runtime = [join(dir, "uhm-runtime"), join(dir, "../Resources/uhm-runtime")]
    .map(root => join(root, "dist/runtime.cjs")).find(file => existsSync(file));
  if (!runtime || !createRequire(import.meta.url)(runtime).InferenceSession) fail("Uhm inference runtime is missing");
  step("bundled Uhm CPU runtime loads");
  step(`ffmpeg: ${execFileSync(ffmpeg, ["-hide_banner", "-version"], { encoding: "utf8" }).split("\n")[0]}`);
  const clip = join(work, "clip.mp4");
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", clip]);

  const env = smokeEnvironment(work);
  execFileSync(whisper, ["--help"], { env, stdio: "ignore" });
  const data = join(work, "data");
  const { child, ready } = await startSmokeEngine(engine, work, env);
  server = child;
  step(`engine ready on ${ready.url}`);

  const api = async (method, path, body) => {
    const isForm = body instanceof FormData;
    const r = await fetch(`${ready.url}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${ready.token}`, ...(body && !isForm ? { "content-type": "application/json" } : {}) },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) fail(`${method} ${path} -> ${r.status} ${JSON.stringify(json)}`);
    return json;
  };
  const until = async (what, check, ms = 120_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await check();
      if (v) return v;
      if (Date.now() > end) fail(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  const config = await api("GET", "/settings");
  if (config.settings.transcription.provider !== "whispercpp" || !config.transcriptionAvailable) fail("bundled transcription unavailable");
  // Bundled Whisper transcribes at import, which first downloads its model. Transcription can't be turned off any
  // more ("none" reads as the bundled engine, so the import began the download and this check failed every build
  // since). OpenAI is chosen instead: the engine runs with no key here, so nothing is transcribed or sent, and the
  // check after import still catches any download an import starts.
  await api("PATCH", "/settings", { transcription: { provider: "openai" } });
  if ((await api("GET", "/settings")).settings.transcription.provider !== "openai") fail("couldn't choose a transcription provider that needs no model");
  const { project } = await api("POST", "/projects", { name: "Smoke", settings: { width: 320, height: 180, aspect: "custom", fps: 30 } });
  const { skills } = await api("GET", `/skills?projectId=${project.id}`);
  const workflows = ["add-captions", "clean-dialogue", "edit-interview", "dialogue-pass", "frame-screen", "smooth-audio-cuts", "visual-pass"];
  for (const name of workflows) {
    const skill = skills.find(s => s.name === name && s.scope === "team");
    // The stock skills carry no upstream marker in their frontmatter any more, so the check is that each one is there
    // with its text, on for every agent.
    if (!skill?.enabled || skill.agents.length || !skill.content.trim()) {
      fail(`bundled editing skill unavailable to agents: ${name}`);
    }
  }
  if (skills.length !== workflows.length) {
    fail(`unexpected skills in the fresh library: ${skills.map(skill => skill.name).join(", ")}`);
  }
  step("all bundled editing skills available to project agents");
  const opening = await fetch(`${ready.url}/api/projects/${project.id}/media/import-frame`, {
    method: "POST", headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" },
    body: JSON.stringify({ path: clip }),
  });
  const jpeg = Buffer.from(await opening.arrayBuffer());
  if (!opening.ok || jpeg.length < 4 || jpeg.readUInt16BE(0) !== 0xffd8) fail("opening footage frame unavailable");
  step("decoded the opening frame before import");
  const form = new FormData();
  form.append("file", new Blob([readFileSync(clip)], { type: "video/mp4" }), "clip.mp4");
  const { media } = await api("POST", `/projects/${project.id}/media`, form);
  await api("POST", `/media/${media.id}/playback-cache`);
  await until("source playback cache", async () => (await api("GET", `/media/${media.id}/playback-cache`)).state === "ready");
  step("source playback cache ready");
  const ingested = await until("ingest", async () => {
    const m = (await api("GET", `/projects/${project.id}/media`)).media.find((x) => x.id === media.id);
    if (m.status === "failed") fail(`ingest failed: ${m.error}`);
    return m.status === "ready" && m;
  });
  step(`ingested ${ingested.duration.toFixed(1)} s clip (proxy made with the bundled ffmpeg)`);
  const waveform = await api("GET", `/media/${media.id}/waveform?from=0&to=1&points=50&speechActivity=1`);
  if (!Array.isArray(waveform.speechActivity)) fail("bundled voice activity detection unavailable");
  if (existsSync(join(data, "models"))) fail("import with no local transcription started a model download");

  const { change } = await api("POST", `/projects/${project.id}/changes`, {
    description: "Smoke test: lay the clip and caption it",
    ops: [
      { op: "addClip", trackId: "v1", clip: { id: "clip_a", kind: "media", mediaId: media.id, sourceIn: 0, sourceOut: 4, timelineIn: 0 } },
      { op: "addTrack", track: { id: "c1", kind: "caption", name: "Captions", clips: [] } },
      { op: "addClip", trackId: "c1", clip: { id: "cap_a", kind: "caption", timelineIn: 0.5, timelineOut: 3, text: "Scarlet smoke test" } },
    ],
  });
  const spot = change.renders[0];
  if (change.state !== "ready" || !spot) fail("change did not provide a review range");
  const { render: requested } = await api("POST", `/projects/${project.id}/renders`, {
    kind: "segment", quality: "preview", version: change.toVersion, range: spot.range,
  });
  const render = await until("change render", async () => {
    const { render } = await api("GET", `/renders/${requested.id}`);
    if (render.state === "failed" || render.state === "cancelled") fail(`render ${render.state}: ${render.error}`);
    return render.state === "done" && render;
  });
  const { fileInfo } = await api("GET", `/renders/${render.id}?inspectFile=true`);
  if (!fileInfo?.hasAudio || fileInfo.videoCodec !== "h264" || fileInfo.fps !== 30 || !(fileInfo.bitrate > 0)) fail("delivery file inspection failed");
  const file = await fetch(`${ready.url}/api/renders/${render.id}/file?token=${encodeURIComponent(ready.token)}`);
  const bytes = (await file.arrayBuffer()).byteLength;
  if (file.status !== 200 || bytes < 1000) fail(`render file: ${file.status}, ${bytes} bytes`);
  step(`rendered the change with captions (${(bytes / 1024).toFixed(0)} KB H.264)`);
  if (render.warnings?.length) step(`render warnings: ${render.warnings.join("; ")}`);
  await api("POST", `/changes/${change.id}/approve`, {});
  step("approved");

  const tools = await mcpTools(engine, env, ready, project.id, media.id, change.id);
  if (!tools.some(t => t.name === "timeline_crossfade_audio")) fail("missing centered audio crossfade tool");
  for (const name of ["frame_contact_sheet", "change_review_cut"]) {
    if (!tools.some(t => t.name === name)) fail(`missing ${name}`);
  }
  if (tools.length < 20) fail(`MCP server listed only ${tools.length} tools`);
  step(`MCP server lists ${tools.length} tools`);

  server.stdin.end();
  const code = await new Promise((res) => {
    const t = setTimeout(() => res("timeout"), 15_000);
    server.on("exit", (c) => (clearTimeout(t), res(c)));
  });
  if (code === "timeout") fail("engine did not exit after stdin closed");
  server = null;
  step("engine exited when its stdin closed");
  step("OK");
} finally {
  cleanup();
}

/** What an agent CLI does: start `scarlet-engine mcp` over stdio, initialize, list tools. */
async function mcpTools(engine, env, ready, projectId, mediaId, changeId) {
  // Audio tools only exist for harnesses that deliver audio to the model; declare one so the bundled audition path is exercised.
  const mcp = spawn(engine, ["mcp", "--server", ready.url, "--project", projectId],
    { env: { ...env, SCARLET_TOKEN: ready.token, SCARLET_AGENT_CAPS: JSON.stringify({ audio: true }) }, stdio: ["pipe", "pipe", "inherit"] });
  const send = (msg) => mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  try {
    return await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error("MCP server did not answer within 30 s")), 30_000);
      let tools;
      createInterface({ input: mcp.stdout }).on("line", (line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.id === 1) {
          send({ method: "notifications/initialized" });
          send({ id: 2, method: "tools/list", params: {} });
        } else if (msg.id === 2) {
          tools = msg.result?.tools ?? [];
          send({ id: 3, method: "tools/call", params: { name: "frame_contact_sheet", arguments: { mediaId, from: 0, to: 1, mode: "scene" } } });
        } else if (msg.id === 3) {
          if (!msg.result?.content?.some(block => block.type === "image" && block.data.length > 100)) {
            clearTimeout(timer);
            return rej(new Error("Bundled MCP contact sheet returned no image"));
          }
          send({ id: 4, method: "tools/call", params: { name: "change_review_cut", arguments: { changeId, includeAudio: true } } });
        } else if (msg.id === 4) {
          clearTimeout(timer);
          if (!msg.result?.content?.some(block => block.type === "audio" && block.data.length > 100)) {
            return rej(new Error("Bundled MCP cut review returned no audition: " + (msg.result?.content?.find(b => b.type === "text")?.text ?? "missing result")));
          }
          res(tools);
        }
      });
      send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "scarlet-smoke", version: "0" } } });
    });
  } finally {
    mcp.kill();
  }
}

// Exercise the packaged engine with a Windows npm install and no provider account.
function checkWindowsModelCatalog() {
  const pkg = join(work, "node_modules", "@openai", "codex");
  mkdirSync(pkg, { recursive: true });
  const shim = join(work, "codex.cmd");
  writeFileSync(shim, '@echo off\r\nnode "%~dp0node_modules\\@openai\\codex\\cli.cjs" %*\r\n');
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ bin: { codex: "cli.cjs" } }));
  writeFileSync(join(pkg, "cli.cjs"), `
    require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
      const { id, method } = JSON.parse(line);
      if (method === "initialize") console.log(JSON.stringify({ id, result: {} }));
      if (method === "model/list") console.log(JSON.stringify({ id, result: { data: [{ model: "smoke", displayName: "Smoke" }] } }));
    });
  `);
  const result = execFileSync(engine, ["model-catalog", "codex", shim], {
    encoding: "utf8", env: { ...process.env, PATH: dirname(process.execPath) }, windowsHide: true,
  });
  if (!JSON.parse(result)?.models.includes("smoke")) throw new Error("Windows npm model discovery failed");
  step("Windows npm model discovery works");
}

function fail(msg) {
  console.error(`[smoke] FAILED: ${msg}`);
  try {
    cleanup();
  } catch {
    // The check has already failed. A folder that can't be removed doesn't change the result.
  }
  process.exit(1);
}
