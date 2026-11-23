import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { FfmpegError } from "../render/ffmpeg.js";
import { crisperWorker, type CrisperRequest } from "./crisperWorker.js";

/** Answers as the adapter's --serve does: one JSON line a request, its stderr as it reads, and an exit after a failure. */
const FAKE_ADAPTER = `
import { existsSync, writeFileSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";
let served = 0;
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  served++;
  writeSync(2, "crisperwhisper device = mps\\n");
  if (request.progress) writeSync(2, "progress = 50%\\n");
  if (request.wav.endsWith("broken.wav")) {
    writeSync(2, "Traceback: the decoder broke\\n");
    writeSync(1, JSON.stringify({ id: request.id, error: "the decoder broke" }) + "\\n");
    process.exit(1);
  }
  if (request.wav.endsWith("long.wav")) return;
  const finish = () => {
    writeFileSync(request.out + ".json", JSON.stringify({ pid: process.pid, served, language: request.language }));
    writeSync(1, "not a reply\\n" + JSON.stringify({ id: request.id, ok: true }) + "\\n");
  };
  if (!existsSync(request.out + ".wait")) return finish();
  const deadline = Date.now() + 2_000;
  const poll = setInterval(() => {
    if (!existsSync(request.out + ".ack") && Date.now() < deadline) return;
    clearInterval(poll);
    finish();
  }, 5);
});
`;

let dir: string;
let adapter: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "scarlet-crisper-worker-"));
  adapter = join(dir, "adapter.mjs");
  await writeFile(adapter, FAKE_ADAPTER);
});
afterEach(() => { crisperWorker.stop(); vi.useRealTimers(); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

let outputs = 0;
async function read(wav: string, extra: Partial<CrisperRequest> = {}) {
  const out = extra.out ?? join(dir, `out${outputs++}`);
  await crisperWorker.transcribe({ binary: process.execPath, args: [adapter], wav: join(dir, wav), out, language: "en", progress: false, ...extra });
  return JSON.parse(await readFile(out + ".json", "utf8")) as { pid: number; served: number; language: string };
}

const exited = async (pid: number) => {
  for (let i = 0; i < 200; i++) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
};

it("reads every request in one worker, which keeps its model, and gives each its own stderr lines", async () => {
  const lines: string[][] = [[], []];
  const firstOut = join(dir, `out${outputs++}`);
  const secondOut = join(dir, `out${outputs++}`);
  await writeFile(firstOut + ".wait", "");
  await writeFile(secondOut + ".wait", "");
  const first = await read("a.wav", {
    out: firstOut,
    progress: true,
    onStderrLine: line => {
      lines[0]!.push(line);
      if (lines[0]!.length === 2) void writeFile(firstOut + ".ack", "");
    },
  });
  const second = await read("b.wav", {
    out: secondOut,
    language: "fr",
    onStderrLine: line => {
      lines[1]!.push(line);
      if (lines[1]!.length === 1) void writeFile(secondOut + ".ack", "");
    },
  });
  expect(second).toEqual({ pid: first.pid, served: 2, language: "fr" });
  expect(lines).toEqual([["crisperwhisper device = mps", "progress = 50%"], ["crisperwhisper device = mps"]]);
  // Requests made together are read one after another, by the same worker.
  const together = await Promise.all([read("c.wav"), read("d.wav"), read("e.wav")]);
  expect(together.map(r => [r.pid, r.served])).toEqual([[first.pid, 3], [first.pid, 4], [first.pid, 5]]);
});

it("reports a reading that fails with the adapter's reason, and starts the next request in a new worker", async () => {
  const before = await read("a.wav");
  const failed = crisperWorker.transcribe({ binary: process.execPath, args: [adapter], wav: join(dir, "broken.wav"), out: join(dir, "broken"), language: "en", progress: false });
  const queued = read("a.wav");
  await expect(failed).rejects.toThrow(FfmpegError);
  await expect(failed).rejects.toThrow(/failed: the decoder broke\ncrisperwhisper device = mps\nTraceback: the decoder broke$/);
  expect(await exited(before.pid)).toBe(true);
  const after = await queued;
  expect(after.pid).not.toBe(before.pid);
  expect(after.served).toBe(1);
});

it("stops the worker to stop a reading, drops a queued one without starting it, and starts the next request afresh", async () => {
  const before = await read("a.wav");
  const reading = new AbortController(), waiting = new AbortController();
  const long = crisperWorker.transcribe({ binary: process.execPath, args: [adapter], wav: join(dir, "long.wav"), out: join(dir, "long"), language: "en", progress: false, signal: reading.signal });
  const queued = read("b.wav", { signal: waiting.signal });
  waiting.abort(new Error("not wanted"));
  await expect(queued).rejects.toThrow("not wanted");
  reading.abort(new Error("cancelled"));
  await expect(long).rejects.toThrow("cancelled");
  expect(await exited(before.pid)).toBe(true);
  expect((await read("c.wav")).served).toBe(1);
});

it("starts another worker for a request that would start it another way", async () => {
  const first = await read("a.wav");
  const other = await read("a.wav", { args: [adapter, "--threads", "4"] });
  expect(other.pid).not.toBe(first.pid);
  expect(await exited(first.pid)).toBe(true);
});

it("stops an idle worker after a minute, which gives its memory back", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { pid } = await read("a.wav");
  vi.advanceTimersByTime(59_000);
  expect(() => process.kill(pid, 0)).not.toThrow();
  vi.advanceTimersByTime(1_000);
  vi.useRealTimers();
  expect(await exited(pid)).toBe(true);
});

it("says which program could not start", async () => {
  await expect(crisperWorker.transcribe({ binary: join(dir, "missing-python"), args: [], wav: "a.wav", out: join(dir, "x"), language: "en", progress: false }))
    .rejects.toThrow(FfmpegError);
});
