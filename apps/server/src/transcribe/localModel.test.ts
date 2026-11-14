import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalWhisperModel, bundledWhisperCli, bundledWhisperGpu, bundledWhisperModel, supportsWhisperAvx2 } from "./localModel.js";

const bytes = Buffer.from("test model");
const model = { name: "test.bin", url: "https://example.invalid/test.bin", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
const signal = new AbortController().signal;
let dir: string;
/** What the cache wrote to the engine's log, with the time each download took left out. */
let said: string[];
const log = (line: string) => { said.push(line.replace(/ (in|after) \d+(ms|s)/, " $1 <time>")); };
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "scarlet-model-")); said = []; });
afterEach(async () => { vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }); });

it("downloads on first use, joins concurrent requests and verifies the cache after restart", async () => {
  const fetchModel = vi.fn(() => Promise.resolve(new Response(bytes)));
  vi.stubGlobal("fetch", fetchModel);
  const cache = new LocalWhisperModel(dir, model, log);
  expect(await cache.status()).toEqual({ state: "missing" });
  expect(fetchModel).not.toHaveBeenCalled();
  const [first, second] = await Promise.all([cache.get(signal), cache.get(signal)]);
  expect(second).toBe(first);
  expect(await new LocalWhisperModel(dir, model, log).status()).toEqual({ state: "ready" });
  expect(await readFile(first)).toEqual(bytes);
  expect(await new LocalWhisperModel(dir, model, log).get(signal)).toBe(first);
  expect(fetchModel).toHaveBeenCalledTimes(1);
  // One download, logged as it starts and as it ends. A model already there says nothing.
  expect(said).toEqual(["[model] test.bin: downloading 1 MB", "[model] test.bin: downloaded in <time>"]);
});

it("bundles Whisper large-v3-turbo at a pinned revision in place of base", () => {
  expect(bundledWhisperModel).toEqual({
    displayName: "Whisper large-v3-turbo",
    name: "ggml-large-v3-turbo-q5_0.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin",
    size: 574041195,
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    replaces: ["ggml-base.bin"],
  });
});

it("removes the file a new model replaces once the new one is in place, and keeps it while the download fails", async () => {
  const earlier = join(dir, "earlier.bin");
  await writeFile(earlier, "old weights");
  const replacing = { ...model, replaces: ["earlier.bin"] };
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(new Response(Buffer.from("bad weights")))
    .mockResolvedValueOnce(new Response(bytes)));
  const cache = new LocalWhisperModel(dir, replacing, log);
  await expect(cache.get(signal)).rejects.toThrow("Could not download");
  expect(await readFile(earlier, "utf8")).toBe("old weights");
  expect(await readFile(await cache.get(signal))).toEqual(bytes);
  expect((await readdir(dir)).sort()).toEqual(["test.bin"]);
});

it("finds the bundled whisper-cli beside the engine only when its program is really there", async () => {
  const file = join(dir, process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
  expect(bundledWhisperCli({ SCARLET_BIN_DIR: dir })).toBeUndefined();
  await writeFile(file, "");
  expect(bundledWhisperCli({ SCARLET_BIN_DIR: dir })).toBeUndefined();
  await writeFile(file, "program");
  expect(bundledWhisperCli({ SCARLET_BIN_DIR: dir })).toBe(file);
  // A folder of that name is not a program.
  await rm(file);
  await mkdir(file);
  expect(bundledWhisperCli({ SCARLET_BIN_DIR: dir })).toBeUndefined();
  // Only Windows has a separate GPU build.
  if (process.platform !== "win32") expect(bundledWhisperGpu({ SCARLET_BIN_DIR: dir })).toBeUndefined();
});

it("selects Linux's optimized Whisper only on CPUs that can run it", async () => {
  const flags = ["sse4_2", "avx", "f16c", "fma", "avx2", "bmi2"];
  const core = (n: number, flags: string[]) => `processor\t: ${n}\nflags\t: fpu ${flags.join(" ")}`;
  const info = core(0, flags);
  expect(supportsWhisperAvx2(info + "\n\n" + core(1, flags))).toBe(true);
  for (const flag of flags) {
    expect(supportsWhisperAvx2(info + "\n\n" + core(1, flags.filter(f => f !== flag)))).toBe(false);
  }
  expect(supportsWhisperAvx2("")).toBe(false);
  const name = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
  const env = { SCARLET_BIN_DIR: dir };
  const baseline = join(dir, name);
  const optimized = join(dir, "whisper-cpu", name);
  await writeFile(baseline, "baseline");
  await mkdir(join(dir, "whisper-cpu"));
  await writeFile(optimized, "");
  expect(bundledWhisperCli(env, true)).toBe(baseline);
  await writeFile(optimized, "optimized");
  expect(bundledWhisperCli(env, false)).toBe(baseline);
  expect(bundledWhisperCli(env, true)).toBe(optimized);
});

it.runIf(process.platform === "win32")("uses the GPU whisper-cli only when its program is really there", async () => {
  const file = join(dir, "whisper-gpu", "whisper-cli.exe");
  await mkdir(join(dir, "whisper-gpu"));
  // A build without the GPU program ships an empty file, which replaces one an earlier update installed.
  await writeFile(file, "");
  expect(bundledWhisperGpu({ SCARLET_BIN_DIR: dir })).toBeUndefined();
  await writeFile(file, "program");
  expect(bundledWhisperGpu({ SCARLET_BIN_DIR: dir })).toBe(file);
});

it("rejects corrupt downloads, cleans up partial files and repairs a damaged cache on retry", async () => {
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(new Response(Buffer.alloc(bytes.length)))
    .mockResolvedValueOnce(new Response(bytes)));
  const cache = new LocalWhisperModel(dir, model, log);
  await expect(cache.get(signal)).rejects.toThrow("checksum mismatch");
  expect(await cache.status()).toEqual({ state: "failed" });
  expect(await readdir(dir)).toEqual([]);
  await writeFile(join(dir, model.name), Buffer.alloc(bytes.length));
  expect(await readFile(await cache.get(signal))).toEqual(bytes);
  expect(said).toEqual([
    "[model] test.bin: downloading 1 MB", "[model] test.bin: download failed after <time>: model checksum mismatch",
    "[model] test.bin: the saved copy is damaged, downloading 1 MB", "[model] test.bin: downloaded in <time>",
  ]);
});

it("logs why a download failed: the server's status, a file of the wrong size, or what the network said", async () => {
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }))
    .mockResolvedValueOnce(new Response(Buffer.concat([bytes, bytes])))
    .mockRejectedValueOnce(new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND example.invalid") })));
  const cache = new LocalWhisperModel(dir, model, log);
  await expect(cache.get(signal)).rejects.toThrow("Could not download the local model test.bin: HTTP 503. Retry transcription to try again.");
  await expect(cache.get(signal)).rejects.toThrow("model exceeds expected size");
  await expect(cache.get(signal)).rejects.toThrow("fetch failed");
  expect(await cache.status()).toEqual({ state: "failed" });
  expect(said.filter(line => line.includes("failed"))).toEqual([
    "[model] test.bin: download failed after <time>: HTTP 503",
    "[model] test.bin: download failed after <time>: model exceeds expected size",
    "[model] test.bin: download failed after <time>: fetch failed (getaddrinfo ENOTFOUND example.invalid)",
  ]);
  expect(await readdir(dir)).toEqual([]);
});

it("removes the partial file of a download that fails on its first bytes, before the file has been created", async () => {
  // Twice the size: the first chunk is already too much, and the download ends while its file is still being opened.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(Buffer.concat([bytes, bytes]))));
  const cache = new LocalWhisperModel(dir, model, log);
  for (let attempt = 0; attempt < 40; attempt++) await expect(cache.get(signal)).rejects.toThrow("model exceeds expected size");
  expect(await readdir(dir)).toEqual([]);
});

it("logs a download stopped when its last request is cancelled, and does not call it failed", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => new Response(new ReadableStream<Uint8Array>({
    start(controller) { init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason)); },
  }))));
  const cache = new LocalWhisperModel(dir, model, log);
  const stop = new AbortController();
  const job = cache.get(stop.signal);
  await vi.waitFor(async () => expect(await cache.status()).toMatchObject({ state: "downloading" }));
  stop.abort(new Error("cancelled"));
  await expect(job).rejects.toThrow("cancelled");
  await vi.waitFor(() => expect(said).toEqual(["[model] test.bin: downloading 1 MB", "[model] test.bin: download stopped after <time>"]));
  expect(await cache.status()).toEqual({ state: "missing" });
  expect(await readdir(dir)).toEqual([]);
});

it("reports live byte progress without starting a second download", async () => {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { writer = controller; controller.enqueue(bytes.subarray(0, 3)); },
  }))));
  const cache = new LocalWhisperModel(dir, model, log);
  const job = cache.get(signal);
  await vi.waitFor(async () => expect(await cache.status()).toEqual({ state: "downloading", received: 3, total: bytes.length }));
  writer.enqueue(bytes.subarray(3));
  writer.close();
  await job;
  expect(await cache.status()).toEqual({ state: "ready" });
});

it("keeps a shared model download alive when one transcription is cancelled", async () => {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { writer = controller; },
  }))));
  const cache = new LocalWhisperModel(dir, model, log);
  const first = new AbortController();
  const cancelled = cache.get(first.signal);
  const remaining = cache.get(signal);
  await vi.waitFor(() => expect(writer).toBeDefined());
  first.abort();
  await expect(cancelled).rejects.toThrow();
  writer.enqueue(bytes);
  writer.close();
  expect(await readFile(await remaining)).toEqual(bytes);
  expect(fetch).toHaveBeenCalledTimes(1);
});
