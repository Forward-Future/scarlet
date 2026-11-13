import type { Stats } from "node:fs";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// The engine's sub-commands hand over to workers that take over the process. Each is replaced by one that only records
// the call. The two the serving engine also uses are replaced only in the tests that start them.
const workers = vi.hoisted(() => ({
  spots: vi.fn(),
  runSpeakerWorker: vi.fn(),
  serveAudioWorker: vi.fn(),
  discoverModels: vi.fn(),
  mcp: vi.fn(),
  stdin: undefined as Partial<Stats> | Error | undefined,
}));
vi.mock("./services/spotWorker.mjs", () => { workers.spots(); return {}; });
vi.mock("@scarlet/agent/dist/modelCatalog.js", () => ({ discoverModels: workers.discoverModels }));
vi.mock("@scarlet/mcp/cli", () => ({ main: workers.mcp }));
// What the engine's stdin is decides whether it stops with the app that started it.
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, fstatSync: (fd: number, ...rest: []) => {
    if (fd !== 0 || workers.stdin === undefined) return actual.fstatSync(fd, ...rest);
    if (workers.stdin instanceof Error) throw workers.stdin;
    return { isCharacterDevice: () => false, isFile: () => false, isDirectory: () => false, ...workers.stdin };
  } };
});

const WATCHED = ["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"] as const;
let directory: string;
let out: string[], err: string[], exits: number[];
let before: Record<string, Function[]>, stdinBefore: Record<string, Function[]>;
const argv = process.argv, env = { ...process.env };

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-cli-test-"));
  out = []; err = []; exits = [];
  vi.spyOn(console, "log").mockImplementation((...args) => { out.push(args.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...args) => { err.push(args.join(" ")); });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => { exits.push(code ?? 0); }) as never);
  vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
  before = Object.fromEntries(WATCHED.map(name => [name, process.listeners(name as "SIGINT")]));
  stdinBefore = { end: process.stdin.listeners("end"), close: process.stdin.listeners("close") };
  workers.stdin = undefined;
  for (const fn of [workers.spots, workers.runSpeakerWorker, workers.serveAudioWorker, workers.discoverModels, workers.mcp]) fn.mockReset();
  vi.resetModules();
});
afterEach(() => {
  // Whatever a run registered on this process goes with it, so the next test and the runner aren't stopped by it.
  for (const name of WATCHED) for (const fn of added(name)) process.off(name, fn as never);
  for (const name of ["end", "close"] as const) for (const fn of process.stdin.listeners(name)) {
    if (!stdinBefore[name]!.includes(fn)) process.stdin.off(name, fn as never);
  }
  process.argv = argv;
  process.exitCode = undefined;
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

const added = (name: (typeof WATCHED)[number]) => process.listeners(name as "SIGINT").filter(fn => !before[name]!.includes(fn));

/** Run the engine as `scarlet-engine <args>` would, in this process. */
async function engine(...args: string[]) {
  process.argv = [argv[0]!, "scarlet-engine", ...args];
  await import("./cli.js");
}
/** A started engine's handshake, once it is listening. */
async function ready() {
  // A start that failed says why on stderr: show that instead of waiting out the clock.
  await vi.waitFor(() => expect([...err, ...out].find(line => !line.startsWith("["))).toMatch(/^SCARLET_READY /), { timeout: 20_000 });
  return JSON.parse(out.find(line => line.startsWith("SCARLET_READY "))!.slice("SCARLET_READY ".length)) as
    { port: number; url: string; token: string; userId: string; dataDir: string };
}

it("prints its usage for help, and refuses a command it doesn't have", async () => {
  await engine("help");
  expect(out.join("\n")).toMatch(/^scarlet-engine <command> \[options\]\n\n {2}serve {3}\[--port 4000\] \[--data \.\/data\] \[--solo\]/);
  expect(exits).toEqual([]);
  vi.resetModules();
  out.length = 0;
  await engine("serve", "--help");
  expect(out.join("\n")).toContain("scarlet-engine <command> [options]");
  expect(added("SIGTERM")).toEqual([]);
  vi.resetModules();
  await engine("transcode", "--fast");
  expect(err[0]).toMatch(/^unknown command: transcode\n\nscarlet-engine <command>/);
  expect(exits).toEqual([2]);
});

it("refuses to serve the editor, which lives in the desktop app", async () => {
  await engine("--web");
  await vi.waitFor(() => expect(process.exitCode).toBe(2));
  expect(err).toEqual(["The engine serves the API only. Open the Scarlet desktop app to edit a project."]);
  expect(added("SIGTERM")).toEqual([]);
});

it("serves for the desktop app: hands over its address and token, and stops when the app goes away", async () => {
  workers.stdin = {}; // A pipe from the app that started it.
  const data = join(directory, "library=mine");
  // No command means serve. A value given with "=" is everything after the first one.
  await engine("--solo", "--port=0", `--data=${data}`);
  const info = await ready();
  expect(info).toEqual({ port: expect.any(Number), url: `http://127.0.0.1:${info.port}`, token: expect.stringMatching(/^sct_[a-f0-9]{64}$/),
    userId: expect.stringMatching(/^usr_/), dataDir: resolve(data) });
  expect(out.filter(line => !line.startsWith("[") && !line.startsWith("SCARLET_READY"))).toEqual([]);
  expect(fs.existsSync(join(data, "access-token"))).toBe(true);
  const session = JSON.parse(fs.readFileSync(join(data, "desktop-session.json"), "utf8"));
  expect(session.port).toBe(info.port);
  expect(session.token).not.toBe(info.token);
  expect((await fetch(`${info.url}/api/settings`, { headers: { Authorization: `Bearer ${session.token}` } })).status).toBe(200);
  expect(await (await fetch(`${info.url}/health`)).json()).toEqual({ ok: true });
  expect((await fetch(`${info.url}/api/settings`)).status).toBe(401);
  expect((await fetch(`${info.url}/api/settings`, { headers: { Authorization: `Bearer ${info.token}` } })).status).toBe(200);
  // The realtime channel is on the same port, behind the same token.
  const refused = await new Promise<string>((done, fail) => {
    const socket = connect(info.port, "127.0.0.1");
    let answer = "";
    socket.on("data", chunk => { answer += chunk; }).on("close", () => done(answer.split("\r\n")[0]!)).on("error", fail);
    socket.write("GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  });
  expect(refused).toBe("HTTP/1.1 401 Unauthorized");

  // The app closes the engine's stdin when it exits, however it exits.
  process.stdin.emit("end");
  process.stdin.emit("close");
  await vi.waitFor(() => expect(exits).toEqual([0]));
  await expect(fetch(`${info.url}/health`)).rejects.toThrow();
  expect(out).not.toContain("shutting down...");
});

it.each([
  ["a terminal", { isCharacterDevice: () => true }],
  ["a file", { isFile: () => true }],
  ["unreadable", new Error("EBADF: bad file descriptor, fstat")],
])("doesn't wait on stdin to stop when it is %s", async (_what, stdin) => {
  workers.stdin = stdin as Partial<Stats> | Error;
  await engine("serve", "--solo", "--port", "0", "--data", directory);
  await ready();
  expect(process.stdin.listeners("end")).toEqual(stdinBefore.end);
  await (added("SIGTERM")[0] as () => Promise<void>)();
  expect(exits).toEqual([0]);
});

it("serves on its own from the environment's port and library, says where, and stops once on a signal", async () => {
  process.env.SCARLET_PORT = "0";
  process.env.SCARLET_DATA = directory;
  await engine("serve");
  await vi.waitFor(() => expect(out.some(line => line.startsWith("Scarlet engine listening on 127.0.0.1:"))).toBe(true), { timeout: 20_000 });
  expect(out.filter(line => line.startsWith("  "))).toEqual([
    `  data:          ${resolve(directory)}`,
    expect.stringMatching(/^ {2}transcription: \w+$/),
    "  note cleanup:  off",
    `  access token:  ${join(resolve(directory), "access-token")} (agent host / MCP: --token-file)`,
  ]);
  // The token is on disk for an agent host to read. It is never printed.
  expect(out.join("\n")).not.toMatch(/sct_[a-f0-9]{64}/);
  expect(process.stdin.listeners("end")).toEqual(stdinBefore.end);
  const [interrupt] = added("SIGINT") as Array<() => Promise<void>>, [terminate] = added("SIGTERM") as Array<() => Promise<void>>;
  await Promise.all([interrupt!(), terminate!()]);
  expect(out.filter(line => line === "shutting down...")).toHaveLength(1);
  expect(exits).toEqual([0]);
});

it("says what stopped it, in the log's form, when an error nothing caught ends the engine", async () => {
  await engine("serve", "--solo", "--port", "0", "--data", directory);
  await ready();
  const [uncaught] = added("uncaughtException") as Array<(e: unknown) => void>;
  const [unhandled] = added("unhandledRejection") as Array<(e: unknown) => void>;
  uncaught!(new TypeError("Invalid URL"));
  unhandled!("database is locked");
  expect(err).toEqual([
    expect.stringMatching(/^\[error\] engine stopped on an uncaught error: TypeError: Invalid URL\n\s+at /),
    "[error] engine stopped on an unhandled rejection: database is locked",
  ]);
  expect(exits).toEqual([1, 1]);
  await (added("SIGTERM")[0] as () => Promise<void>)();
});

it("checks a worker's arguments before starting it", async () => {
  await engine("review-spots", "library.db", "chg_1");
  expect(exits).toEqual([2]);
  vi.resetModules(); exits.length = 0;
  vi.doMock("./transcribe/speakerWorker.js", () => ({ runSpeakerWorker: workers.runSpeakerWorker.mockResolvedValue([]) }));
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await engine("diarize-audio", "a.wav", "segmentation.onnx");
  await engine("diarize-audio", "a.wav", "segmentation.onnx", "embedding.onnx", "gpu");
  vi.resetModules();
  await engine("diarize-audio", "a.wav", "segmentation.onnx", "embedding.onnx", "gpu");
  expect(exits).toEqual([2, 2]);
  vi.resetModules(); exits.length = 0;
  await engine("model-catalog", "copilot", "/usr/local/bin/copilot");
  vi.resetModules();
  await engine("model-catalog", "claude");
  expect(exits).toEqual([2, 2]);
  vi.doUnmock("./transcribe/speakerWorker.js");
});

it("runs speaker analysis on the GPU unless told to stay on the CPU, and writes the turns it found", async () => {
  const written: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => { written.push(chunk); return true; }) as never);
  vi.doMock("./transcribe/speakerWorker.js", () => ({ runSpeakerWorker: workers.runSpeakerWorker }));
  workers.runSpeakerWorker.mockResolvedValue([{ start: 0, end: 1.5, speaker: 0 }]);
  await engine("diarize-audio", "a.wav", "segmentation.onnx", "embedding.onnx");
  await vi.waitFor(() => expect(written).toEqual(['[{"start":0,"end":1.5,"speaker":0}]']));
  expect(workers.runSpeakerWorker).toHaveBeenLastCalledWith("a.wav", "segmentation.onnx", "embedding.onnx", expect.any(Function), false);
  vi.resetModules();
  await engine("diarize-audio", "a.wav", "segmentation.onnx", "embedding.onnx", "cpu");
  await vi.waitFor(() => expect(written).toHaveLength(2));
  expect(workers.runSpeakerWorker).toHaveBeenLastCalledWith("a.wav", "segmentation.onnx", "embedding.onnx", expect.any(Function), true);
  expect(exits).toEqual([]);

  vi.resetModules();
  workers.runSpeakerWorker.mockRejectedValue(new Error("model file is truncated"));
  await engine("diarize-audio", "a.wav", "segmentation.onnx", "embedding.onnx");
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  expect(err).toEqual(["[speakers] model file is truncated"]);
  vi.doUnmock("./transcribe/speakerWorker.js");
});

it("prints an agent's models as JSON, null when it has none to list, and why when it can't ask", async () => {
  workers.discoverModels.mockResolvedValueOnce({ models: ["opus"], model: "opus" }).mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("spawn /usr/local/bin/claude EACCES"));
  await engine("model-catalog", "claude", "/usr/local/bin/claude");
  await vi.waitFor(() => expect(out).toEqual(['{"models":["opus"],"model":"opus"}']));
  expect(workers.discoverModels).toHaveBeenCalledWith("claude", "/usr/local/bin/claude", process.env);
  vi.resetModules();
  await engine("model-catalog", "gemini", "/usr/local/bin/gemini");
  await vi.waitFor(() => expect(out.at(-1)).toBe("null"));
  expect(process.exitCode).toBeUndefined();
  vi.resetModules();
  await engine("model-catalog", "claude", "/usr/local/bin/claude");
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  expect(err).toEqual(["[models] claude: spawn /usr/local/bin/claude EACCES"]);
});

it("starts the audio helper and the agent tools, and reports either one failing", async () => {
  vi.doMock("./transcribe/audioWorker.js", () => ({ serveAudioWorker: workers.serveAudioWorker }));
  workers.serveAudioWorker.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("no model"); });
  await engine("audio-worker");
  await vi.waitFor(() => expect(workers.serveAudioWorker).toHaveBeenCalledTimes(1));
  expect(exits).toEqual([]);
  vi.resetModules();
  await engine("audio-worker");
  await vi.waitFor(() => expect(exits).toEqual([1]));
  expect(err).toEqual(["[audio] no model"]);
  vi.doUnmock("./transcribe/audioWorker.js");

  vi.resetModules(); err.length = 0; exits.length = 0;
  workers.mcp.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("--project is required"));
  await engine("mcp", "--server", "http://127.0.0.1:4000", "--project", "prj_1");
  await vi.waitFor(() => expect(workers.mcp).toHaveBeenCalledWith(["--server", "http://127.0.0.1:4000", "--project", "prj_1"]));
  // Tells the tools module the engine is running it, so it doesn't also start itself.
  expect(process.env.SCARLET_ENGINE_EMBEDDED).toBe("1");
  expect(exits).toEqual([]);
  vi.resetModules();
  await engine("mcp");
  await vi.waitFor(() => expect(exits).toEqual([1]));
  expect(err).toEqual(["[scarlet-engine mcp] --project is required"]);
});
