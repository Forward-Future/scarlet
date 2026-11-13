// Opt-in macOS benchmark. Uses the existing Codex ChatGPT sign-in for one live task.
// Build the workspace first. No login, paid API key, or interactive app is needed.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ScarletClient } from "@scarlet/shared";

if (process.platform !== "darwin" || process.argv[2] !== "--live-codex") {
  console.error("Run on macOS with node apps/server/scripts/bench-first-cut.mjs --live-codex [local-model-directory].");
  process.exit(2);
}

const root = fileURLToPath(new URL("../../../", import.meta.url));
const models = process.argv[3] ?? join(homedir(), "Library/Application Support/com.forwardfuture.scarlet/data/models");
const scratch = await mkdtemp(join(tmpdir(), "scarlet-live-first-cut-"));
const library = join(scratch, "library");
const bin = process.env.SCARLET_BIN_DIR ?? "/Applications/Scarlet.app/Contents/MacOS";
const env = { ...process.env, SCARLET_TELEMETRY_ENABLED: "false", SCARLET_BIN_DIR: bin, SCARLET_HOME: join(scratch, "host") };
for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GOOGLE_API_KEY",
  "GEMINI_API_KEY", "SCARLET_SERVER", "SCARLET_TOKEN", "SCARLET_MCP_CLI", "SCARLET_DATA", "SCARLET_SKILLS_SEED"]) delete env[name];
const children = [];
let interrupted = false;
function start(entry, args, options = {}) {
  if (interrupted) throw new Error("Benchmark interrupted.");
  const child = spawn(process.execPath, [join(root, entry), ...args], { cwd: scratch, env, stdio: ["pipe", "pipe", "ignore"], ...options });
  children.push(child);
  return child;
}
async function until(read, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error("Benchmark interrupted.");
    const value = await read();
    if (value) return value;
    if (children.some(c => c.exitCode !== null || c.signalCode)) throw new Error("The isolated engine or agent host exited.");
    await delay(250);
  }
  throw new Error("Timed out waiting for the isolated first-cut workflow.");
}
const interrupt = () => { interrupted = true; };
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  const auth = spawnSync("codex", ["login", "status"], { env, encoding: "utf8" });
  if (auth.status !== 0 || !/logged in.*ChatGPT/i.test(auth.stdout + auth.stderr)) {
    throw new Error("This benchmark requires a Codex ChatGPT sign-in.");
  }
  await mkdir(join(library, "models"), { recursive: true, mode: 0o700 });
  for (const file of ["ggml-large-v3-turbo-q5_0.bin", "uhm-1b7dc1ef.onnx", "speaker-segmentation-220ad67c.onnx", "speaker-eres2net-1a331345.onnx"]) {
    await copyFile(join(models, file), join(library, "models", file), constants.COPYFILE_FICLONE);
  }
  const phrases = [
    "Today I will show you how to plant basil. Start with a small pot and fill it with soil.",
    "Um, start with a small pot. Let me start that again.",
    "Place the seeds near the surface. Cover them lightly and water the soil.",
  ];
  const tracks = phrases.map((text, i) => {
    const file = join(scratch, i + ".aiff");
    execFileSync("say", ["-v", "Samantha", "-r", "155", "-o", file, text]);
    return file;
  });
  const seconds = tracks.map(file => Number(execFileSync(join(bin, "ffprobe"), [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
  ], { encoding: "utf8" }).trim()));
  const retakeStart = seconds[0] + 1.5;
  const closingStart = retakeStart + seconds[1] + 2.2;
  const media = join(scratch, "basil.mp4");
  execFileSync(join(bin, "ffmpeg"), ["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x383838:s=640x360:r=24",
    ...tracks.flatMap(file => ["-i", file]), "-filter_complex",
    "[1:a]apad=pad_dur=1.5[a];[2:a]apad=pad_dur=2.2[b];[a][b][3:a]concat=n=3:v=0:a=1[x]",
    "-map", "0:v", "-map", "[x]", "-c:v", "libx264", "-preset", "ultrafast", "-g", "12", "-threads", "2", "-c:a", "aac", "-shortest", media]);

  let ready;
  const engine = start("apps/server/dist/cli.js", ["serve", "--solo", "--port", "0", "--data", library]);
  createInterface({ input: engine.stdout }).on("line", line => {
    if (line.startsWith("SCARLET_READY ")) ready = JSON.parse(line.slice("SCARLET_READY ".length));
  });
  await until(() => ready, 10000);
  const api = new ScarletClient({ baseUrl: ready.url, token: ready.token });
  const host = start("apps/agent/dist/cli.js", ["start"], { env: { ...env, SCARLET_SERVER: ready.url, SCARLET_TOKEN: ready.token } });
  host.stdout.resume();
  const { project } = await api.createProject({ name: "Synthetic basil lesson", settings: { width: 640, height: 360, fps: 24 } });
  await api.uploadMedia(project.id, new Blob([await readFile(media)], { type: "video/mp4" }), basename(media));
  await until(async () => {
    const { hosts } = await api.hosts();
    const codex = hosts.flatMap(h => h.agents).find(a => a.id === "codex");
    if (codex && (!codex.installed || codex.auth !== "subscription")) throw new Error("Codex must be installed and signed in with ChatGPT.");
    const { project: current } = await api.workspace(project.id);
    return codex && current.media.some(m => !m.status || m.status === "ready");
  }, 30000);
  const { skills } = await api.skills({ projectId: project.id, agent: "codex" });
  const skill = skills.find(s => s.name === "dialogue-pass");
  if (!skill) throw new Error("Missing built-in dialogue-pass skill.");
  const { task } = await api.createTask(project.id, {
    agent: "codex", kind: "edit", context: { message: "Make first cut", skillIds: [skill.id] },
    instruction: "Make a first cut from this project’s footage and send it to me for review. This is a quick basil planting lesson. Keep the useful instructions and cut obvious retakes and long pauses.",
  });
  const { task: finished, events } = await until(async () => {
    const row = await api.task(task.id);
    return ["done", "failed", "waiting_for_user", "cancelled"].includes(row.task.state) && row;
  }, 15 * 60000);
  const ms = at => at ? Date.parse(at) - Date.parse(task.createdAt) : undefined;
  const { changes } = await api.changes(project.id);
  const cuts = [];
  for (const c of changes) {
    const { timeline } = await api.timeline(project.id, c.toVersion);
    const clips = timeline.tracks.filter(t => t.kind === "video").flatMap(t => t.clips.filter(x => x.kind === "media"));
    cuts.push({ atMs: ms(c.createdAt), state: c.state, description: c.description, sourceRanges: clips.map(x => [x.sourceIn, x.sourceOut]) });
  }
  const milestones = events.filter(e => e.data?.scanPage || e.type === "change" || e.type === "error")
    .map(e => ({ atMs: ms(e.at), event: e.type, text: e.text, scan: e.data?.scanPage }));
  console.log(JSON.stringify({ state: finished.state, finishedMs: ms(finished.finishedAt), toolCalls: events.filter(e => e.type === "tool").length,
    milestones, cuts, retakeSourceRange: [retakeStart, retakeStart + seconds[1]], closingSourceStart: closingStart,
    error: finished.error, question: finished.question }, null, 2).replaceAll(ready.token, "[redacted]"));
  if (finished.state !== "done" || !cuts.length) process.exitCode = 1;
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode) continue;
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([exited, delay(5000, undefined, { ref: false })]);
    if (child.exitCode === null && !child.signalCode) { child.kill("SIGKILL"); await exited; }
  }
  await rm(scratch, { recursive: true, force: true });
}
