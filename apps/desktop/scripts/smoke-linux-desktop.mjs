// Exercise the installed Debian app in a private X server, D-Bus session and profile.
// Usage on Ubuntu 24.04: node apps/desktop/scripts/smoke-linux-desktop.mjs
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

assert.equal(process.platform, "linux", "Run the installed Linux package on Ubuntu");
const app = "/usr/bin/scarlet-desktop";
const profile = mkdtempSync(join(tmpdir(), "scarlet-linux-desktop-"));
const env = {
  HOME: profile, PATH: "/usr/bin:/bin", LANG: "C.UTF-8",
  XDG_DATA_HOME: join(profile, "data"), XDG_CACHE_HOME: join(profile, "cache"),
  XDG_CONFIG_HOME: join(profile, "config"), XDG_RUNTIME_DIR: join(profile, "run"),
  TAURI_WEBVIEW_AUTOMATION: "true", SCARLET_TELEMETRY_ENABLED: "false",
  GDK_BACKEND: "x11", LIBGL_ALWAYS_SOFTWARE: "1",
  // This session has no connection to a user's audio server or ALSA device.
  PULSE_SERVER: "unix:" + join(profile, "no-audio-server"), ALSA_CONFIG_PATH: join(profile, "alsa.conf"),
};
mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });
writeFileSync(env.ALSA_CONFIG_PATH, "pcm.!default { type null }\n");
const base = "http://127.0.0.1:";
let driver;
let session;
let endpoint;

async function until(label, check, timeout = 60_000) {
  const end = Date.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await sleep(250);
  } while (Date.now() < end);
  throw new Error("Timed out waiting for " + label);
}

async function webdriver(method, path, data) {
  const response = await fetch(endpoint + path, {
    method, headers: { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(70_000),
  });
  const { value } = await response.json();
  if (!response.ok) throw new Error("WebDriver " + path + ": " + (value?.message || response.status));
  return value;
}

async function execute(script, args = []) {
  return webdriver("POST", "/session/" + session + "/execute/sync", { script, args });
}

try {
  const speech = join(profile, "speech.wav");
  const clip = join(profile, "smoke.mp4");
  execFileSync("espeak-ng", ["-v", "en-us", "-s", "145", "-w", speech, "The quick brown fox jumps over the lazy dog."], { env });
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=24", "-i", speech,
    "-af", "apad", "-t", "5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", clip], { env });

  const socket = createServer();
  await new Promise((resolve, reject) => socket.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  endpoint = base + port;
  driver = spawn("xvfb-run", ["-a", "-s", "-screen 0 1600x1000x24", "dbus-run-session", "--",
    "WebKitWebDriver", "--port=" + port], { env, cwd: profile, stdio: "inherit", detached: true });
  await until("private WebKitGTK driver", async () => {
    assert.equal(driver.exitCode, null, "Headless display or driver exited");
    return fetch(endpoint + "/status").then(r => r.ok).catch(() => false);
  });
  const { sessionId } = await webdriver("POST", "/session", {
    capabilities: { alwaysMatch: { "webkitgtk:browserOptions": { binary: app, args: [] } } },
  });
  session = sessionId;
  assert.ok(session);
  await until("Scarlet project library", () => execute("return document.body?.innerText.includes('New project')"));
  const { url, token, engineKind } = await webdriver("POST", "/session/" + session + "/execute/async", {
    script: "const done = arguments[0]; window.__TAURI_INTERNALS__.invoke('engine_status').then(done, () => done({}));", args: [],
  });
  assert.equal(engineKind, "sidecar");
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(token);
  console.log("[linux] Installed desktop and engine ready");

  const fetchApi = (path, method = "GET", body) => fetch(url + "/api" + path, {
    method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90_000),
  });
  async function api(path, method, body) {
    const response = await fetchApi(path, method, body);
    if (!response.ok) throw new Error(path + ": " + response.status + " " + await response.text());
    return response.json();
  }

  const settings = await api("/settings");
  assert.ok(settings.transcriptionAvailable);
  assert.equal(settings.settings.transcription.provider, "whispercpp");
  const { project } = await api("/projects", "POST", { name: "Linux smoke", settings: { width: 320, height: 180, fps: 24, aspect: "custom" } });
  const projectUrl = "/projects/" + project.id;
  const { media } = await api(projectUrl + "/media/import", "POST", { path: clip });
  await until("import and Whisper transcript", async () => {
    const saved = (await api(projectUrl + "/media")).media.find(item => item.id === media.id);
    if (saved?.status === "failed") throw new Error("Import failed: " + saved.error);
    if (saved?.transcriptId && saved.status === "ready") return true;
    const failed = (await api(projectUrl + "/tasks")).tasks.find(task => task.kind === "transcribe" && task.state === "failed");
    if (failed) throw new Error("Transcription failed: " + (failed.error || failed.id));
  }, 600_000);
  const transcript = await api("/media/" + media.id + "/transcript");
  assert.equal(transcript.provider, "whispercpp");
  const words = transcript.segments.map(segment => segment.text).join(" ").toLowerCase();
  assert.ok(["quick", "brown", "fox", "lazy", "dog"].filter(word => words.includes(word)).length >= 2,
    "Unexpected transcript for the synthetic speech: " + words);
  console.log("[linux] Imported H.264/AAC and transcribed the fixture with packaged Whisper");

  const { change } = await api(projectUrl + "/changes", "POST", {
    description: "Place the clip on the timeline",
    ops: [{ op: "addClip", trackId: "v1", clip: { kind: "media", id: "linux-smoke",
      mediaId: media.id, timelineIn: 0, sourceIn: 0, sourceOut: 5 } }],
  });
  await api("/changes/" + change.id + "/approve", "POST", {});
  await until("the project in the native library", () => execute(`
    const link = document.querySelector('a[aria-label="Open Linux smoke"]');
    if (!link) return false;
    link.click();
    return true;
  `));
  // A WebDriver element click carries the user gesture WebKit expects for media playback.
  const play = await until("the editor's Play control", () => execute(
    'return document.querySelector(\'.watch-monitor .monitor-playback button[aria-label="Play"]:enabled\')'));
  await execute("for (const video of document.querySelectorAll('video')) video.muted = true;");
  await webdriver("POST", "/session/" + session + "/element/" + play["element-6066-11e4-a52e-4f735466cecf"] + "/click", {});
  await until("decoded H.264 picture advancing in the editor", () => execute(`
    const video = document.querySelector('.watch-monitor video[aria-label="The current edit"]');
    return !!video && video.readyState >= 2 && video.videoWidth > 0 && video.currentTime > 0.25;
  `));
  console.log("[linux] WebKitGTK decoded and played the working timeline");

  const { render } = await api(projectUrl + "/renders", "POST", { kind: "export", quality: "delivery", version: change.toVersion });
  await until("delivery export", async () => {
    const { render: job } = await api("/renders/" + render.id);
    if (job.state === "failed" || job.state === "cancelled") throw new Error("Export failed: " + job.error);
    return job.state === "done";
  });
  const file = await fetchApi("/renders/" + render.id + "/file");
  assert.equal(file.status, 200);
  const exported = join(profile, "export.mp4");
  writeFileSync(exported, Buffer.from(await file.arrayBuffer()));
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name:format=duration", "-of", "json", exported], { env }));
  assert.ok(probe.streams.some(stream => stream.codec_name === "h264"));
  assert.ok(probe.streams.some(stream => stream.codec_name === "aac"));
  assert.ok(Math.abs(Number(probe.format.duration) - 5) < 0.15);
  execFileSync("ffmpeg", ["-v", "error", "-xerror", "-i", exported, "-f", "null", "-"], { env });
  console.log("[linux] Delivered MP4 has five seconds of decodable H.264 picture and AAC audio");
} finally {
  if (session) await webdriver("DELETE", "/session/" + session).catch(() => {});
  // The driver, its private display and D-Bus belong to this process group.
  if (driver?.pid) {
    try { process.kill(-driver.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
