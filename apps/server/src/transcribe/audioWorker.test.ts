import { EventEmitter, getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioRequest } from "./audioWorker.js";

/** A stand-in for the helper process: it records what it is sent, and the test answers and exits for it. */
class Helper extends EventEmitter {
  readonly sent: Array<AudioRequest & { id: number }> = [];
  readonly killed: Array<string | undefined> = [];
  /** Whether the engine waits for it before exiting. */
  held = true;
  sendError?: Error;
  readonly stderr = Object.assign(new EventEmitter(), { ref: () => { this.held = true; }, unref: () => { this.held = false; } });
  readonly channel = { ref: () => { this.held = true; }, unref: () => { this.held = false; } };
  constructor(readonly args: string[]) { super(); }
  ref() { this.held = true; }
  unref() { this.held = false; }
  send(message: AudioRequest & { id: number }, callback: (error: Error | null) => void) {
    this.sent.push(message);
    const error = this.sendError ?? null;
    this.sendError = undefined;
    queueMicrotask(() => callback(error));
    return true;
  }
  kill(signal?: string) { this.killed.push(signal); return true; }
  reply(reply: unknown) { this.emit("message", reply); }
}

const spawned = vi.hoisted(() => ({ helpers: [] as Helper[], fail: undefined as Error | undefined }));
vi.mock("node:child_process", () => ({
  spawn: (_program: string, args: string[]) => {
    if (spawned.fail) throw spawned.fail;
    const helper = new Helper(args);
    spawned.helpers.push(helper);
    return helper;
  },
}));

const fillers = (wav: string): AudioRequest => ({ kind: "fillers", wav, model: "fillers.onnx", origin: 0 });
const wavs = (helper: Helper) => helper.sent.map(message => message.wav);
/** The helper is one per process, so each test gets its own copy of the module. */
const load = async () => (await import("./audioWorker.js")).audioWorker;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  spawned.helpers.length = 0;
  spawned.fail = undefined;
});
afterEach(() => { vi.useRealTimers(); });

describe("the audio helper's queue", () => {
  it("starts one helper on the first request and gives it one request at a time, in order", async () => {
    const worker = await load();
    expect(spawned.helpers).toEqual([]);
    const progress: number[] = [];
    const first = worker.request<string>(fillers("a.wav"), { onProgress: done => progress.push(done) });
    const second = worker.request<string>(fillers("b.wav"));
    const [helper] = spawned.helpers;
    expect(spawned.helpers).toHaveLength(1);
    expect(helper!.args.at(-1)).toBe("audio-worker");
    expect(helper!.sent).toEqual([{ id: 0, kind: "fillers", wav: "a.wav", model: "fillers.onnx", origin: 0 }]);
    expect(helper!.held).toBe(true);
    helper!.reply({ id: 0, progress: 0.5 });
    // An answer to a request it isn't on is not this one's.
    helper!.reply({ id: 1, result: "early" });
    helper!.reply({ id: 0, result: "a" });
    expect(await first).toBe("a");
    expect(progress).toEqual([0.5]);
    expect(wavs(helper!)).toEqual(["a.wav", "b.wav"]);
    helper!.reply({ id: 1, error: "No complete PCM audio in the analysis window." });
    await expect(second).rejects.toThrow("No complete PCM audio in the analysis window.");
    expect(spawned.helpers).toHaveLength(1);
    // With nothing left to do it no longer keeps the engine from exiting.
    expect(helper!.held).toBe(false);
  });

  it("writes the helper's notes to the engine's log", async () => {
    const worker = await load();
    const log = worker.log = vi.fn();
    const request = worker.request(fillers("a.wav"));
    spawned.helpers[0]!.reply({ note: "fillers.onnx runs on the GPU (webgpu)" });
    spawned.helpers[0]!.reply({ id: 0, result: [] });
    await request;
    expect(log.mock.calls).toEqual([["[audio] fillers.onnx runs on the GPU (webgpu)"]]);
  });

  it("takes a request that is stopped while it waits out of the queue, without disturbing the helper", async () => {
    const worker = await load();
    const stop = new AbortController();
    const first = worker.request(fillers("a.wav"));
    const second = worker.request(fillers("b.wav"), { signal: stop.signal });
    const third = worker.request<string>(fillers("c.wav"));
    stop.abort(new Error("stopped"));
    await expect(second).rejects.toThrow("stopped");
    const [helper] = spawned.helpers;
    expect(helper!.killed).toEqual([]);
    helper!.reply({ id: 0, result: "a" });
    await first;
    expect(wavs(helper!)).toEqual(["a.wav", "c.wav"]);
    helper!.reply({ id: 2, result: "c" });
    expect(await third).toBe("c");
    // One stopped before it was asked never reaches the helper either.
    await expect(worker.request(fillers("d.wav"), { signal: stop.signal })).rejects.toThrow("stopped");
    expect(wavs(helper!)).toEqual(["a.wav", "c.wav"]);
  });

  it("kills the helper to stop the request it is on, and starts another for the next", async () => {
    const worker = await load();
    const stop = new AbortController();
    const first = worker.request(fillers("a.wav"), { signal: stop.signal });
    const second = worker.request<string>(fillers("b.wav"));
    stop.abort(new Error("stopped"));
    const [helper] = spawned.helpers;
    expect(helper!.killed).toEqual(["SIGKILL"]);
    helper!.emit("exit", null, "SIGKILL");
    await expect(first).rejects.toThrow("stopped");
    expect(spawned.helpers).toHaveLength(2);
    expect(wavs(spawned.helpers[1]!)).toEqual(["b.wav"]);
    spawned.helpers[1]!.reply({ id: 1, result: "b" });
    expect(await second).toBe("b");
  });

  it("fails the request a helper was on when it stops, with what it wrote, and starts another for the next", async () => {
    const worker = await load();
    const first = worker.request(fillers("a.wav"));
    const second = worker.request(fillers("b.wav"));
    spawned.helpers[0]!.stderr.emit("data", Buffer.from("Error: Cannot find module 'onnxruntime-node'\n"));
    spawned.helpers[0]!.emit("exit", 1, null);
    await expect(first).rejects.toThrow("Error: Cannot find module 'onnxruntime-node'");
    // The next request has a helper of its own, and one that says nothing gets a plain reason.
    expect(spawned.helpers).toHaveLength(2);
    spawned.helpers[1]!.emit("exit", null, "SIGSEGV");
    await expect(second).rejects.toThrow("The audio helper stopped before it answered.");
    const third = worker.request(fillers("c.wav"));
    expect(spawned.helpers).toHaveLength(3);
    spawned.helpers[2]!.emit("error", new Error("spawn EAGAIN"));
    await expect(third).rejects.toThrow("spawn EAGAIN");
  });

  it("fails a request it can't start or can't send, and goes on to the next", async () => {
    const worker = await load();
    spawned.fail = new Error("spawn ENOENT");
    await expect(worker.request(fillers("a.wav"))).rejects.toThrow("spawn ENOENT");
    spawned.fail = undefined;
    const second = worker.request<string>(fillers("b.wav"));
    const [helper] = spawned.helpers;
    helper!.reply({ id: 1, result: "b" });
    expect(await second).toBe("b");
    helper!.sendError = new Error("channel closed");
    const third = worker.request(fillers("c.wav"));
    const fourth = worker.request<string>(fillers("d.wav"));
    await expect(third).rejects.toThrow("channel closed");
    expect(wavs(helper!)).toEqual(["b.wav", "c.wav", "d.wav"]);
    helper!.reply({ id: 3, result: "d" });
    expect(await fourth).toBe("d");
  });

  it("stops an idle helper after half a minute, and not while requests keep coming", async () => {
    const worker = await load();
    const ask = async (wav: string, id: number, helper: Helper) => {
      const request = worker.request(fillers(wav));
      helper.reply({ id, result: wav });
      await request;
    };
    const first = worker.request(fillers("a.wav"));
    const [helper] = spawned.helpers;
    // One at work is never stopped for being idle.
    vi.advanceTimersByTime(60_000);
    helper!.reply({ id: 0, result: "a" });
    await first;
    vi.advanceTimersByTime(29_000);
    await ask("b.wav", 1, helper!);
    vi.advanceTimersByTime(29_000);
    expect(helper!.killed).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(helper!.killed).toEqual([undefined]);
  });

  it("does not fail a request made just after the idle helper was stopped when that helper exits", async () => {
    const worker = await load();
    const first = worker.request(fillers("a.wav"));
    const [old] = spawned.helpers;
    old!.reply({ id: 0, result: "a" });
    await first;
    vi.advanceTimersByTime(30_000);
    expect(old!.killed).toEqual([undefined]);
    // The old helper has been told to stop and has not gone yet.
    const second = worker.request<string>(fillers("b.wav"));
    expect(spawned.helpers).toHaveLength(2);
    old!.emit("exit", null, "SIGTERM");
    spawned.helpers[1]!.reply({ id: 1, result: "b" });
    expect(await second).toBe("b");
  });

  it("leaves nothing listening to a request's signal once the request has ended", async () => {
    const worker = await load();
    const stop = new AbortController();
    const listening = () => getEventListeners(stop.signal, "abort").length;
    const first = worker.request(fillers("a.wav"), { signal: stop.signal });
    const second = worker.request(fillers("b.wav"), { signal: stop.signal });
    const third = worker.request(fillers("c.wav"), { signal: stop.signal });
    // One listener for each request: to stop the helper for the one it is on, to leave the queue for the others.
    expect(listening()).toBe(3);
    const [helper] = spawned.helpers;
    helper!.reply({ id: 0, result: "a" });
    await first;
    expect(listening()).toBe(2);
    helper!.reply({ id: 1, error: "failed" });
    await expect(second).rejects.toThrow("failed");
    expect(listening()).toBe(1);
    helper!.emit("exit", 1, null);
    await expect(third).rejects.toThrow("The audio helper stopped before it answered.");
    expect(listening()).toBe(0);
  });
});

describe("the helper's side", () => {
  type Sent = { id?: number; result?: unknown; error?: string; progress?: number; note?: string };
  const ours = (message: unknown): message is Sent => !!message && typeof message === "object" && ("note" in message || "id" in message);

  /** Starts the helper's loop in this process, and returns how to send it a request and what it answered. */
  async function serve() {
    const { serveAudioWorker } = await import("./audioWorker.js");
    const handlers: Record<string, (message?: unknown) => void> = {};
    const listen = vi.spyOn(process, "on").mockImplementation(((event: string, handler: (message?: unknown) => void) => { handlers[event] = handler; return process; }) as never);
    serveAudioWorker();
    listen.mockRestore();
    // The test runner talks to its own parent over the same channel: only the helper's answers are kept back.
    const sent: Sent[] = [];
    const send = process.send, connected = Object.getOwnPropertyDescriptor(process, "connected");
    process.send = ((message: unknown, ...rest: unknown[]) => ours(message) ? (sent.push(message), true) : (send as (...args: unknown[]) => boolean).call(process, message, ...rest)) as never;
    Object.defineProperty(process, "connected", { value: true, configurable: true });
    const restore = () => {
      process.send = send;
      if (connected) Object.defineProperty(process, "connected", connected);
      else delete (process as { connected?: boolean }).connected;
    };
    return { handlers, sent, restore };
  }

  it("answers requests one at a time in the order they came, with progress, notes and each failure's reason", async () => {
    const uhm = await import("./uhm.js"), align = await import("./wordAlign.js");
    const order: string[] = [];
    let release!: () => void;
    const fillers = vi.spyOn(uhm, "runFillerWorker").mockImplementation(async (wav, _model, origin, sessions) => {
      order.push(`fillers ${wav} began`);
      if (wav === "a.wav") await new Promise<void>(resolve => { release = resolve; });
      if (wav === "bad.wav") throw new Error("No complete PCM audio in the analysis window.");
      if (wav === "odd.wav") throw "out of memory";
      sessions!.tell("fillers.onnx runs on the GPU (webgpu)");
      order.push(`fillers ${wav} done`);
      return [{ start: origin, end: origin + 1, confidence: 1 }];
    });
    const aligner = vi.spyOn(align, "runAlignWorker").mockImplementation(async (wav, _model, _request, onProgress) => {
      order.push(`align ${wav}`);
      onProgress?.(0.5);
      return [[null]];
    });
    const { handlers, sent, restore } = await serve();
    try {
      handlers.message!({ id: 4, kind: "fillers", wav: "a.wav", model: "fillers.onnx", origin: 10 });
      handlers.message!({ id: 5, kind: "fillers", wav: "bad.wav", model: "fillers.onnx", origin: 0 });
      handlers.message!({ id: 6, kind: "fillers", wav: "odd.wav", model: "fillers.onnx", origin: 0 });
      handlers.message!({ id: 7, kind: "align", wav: "b.wav", model: "aligner.onnx", request: "b.json" });
      // Native inference blocks the helper, so the second request waits for the first to end.
      await vi.waitFor(() => expect(order).toEqual(["fillers a.wav began"]));
      release();
      await vi.waitFor(() => expect(sent.at(-1)).toEqual({ id: 7, result: [[null]] }));
      expect(order).toEqual(["fillers a.wav began", "fillers a.wav done", "fillers bad.wav began", "fillers odd.wav began", "align b.wav"]);
      expect(sent).toEqual([
        { note: "fillers.onnx runs on the GPU (webgpu)" },
        { id: 4, result: [{ start: 10, end: 11, confidence: 1 }] },
        { id: 5, error: "No complete PCM audio in the analysis window." },
        { id: 6, error: "out of memory" },
        { id: 7, progress: 0.5 },
        { id: 7, result: [[null]] },
      ]);
      // Both models share the helper's open sessions.
      expect(aligner.mock.calls[0]![4]).toBe(fillers.mock.calls[0]![3]);
      expect(aligner.mock.calls[0]!.slice(0, 3)).toEqual(["b.wav", "aligner.onnx", "b.json"]);
      // The helper goes when the engine does.
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
      handlers.disconnect!();
      expect(exit).toHaveBeenCalledWith(0);
    } finally { restore(); vi.restoreAllMocks(); }
  });
});
