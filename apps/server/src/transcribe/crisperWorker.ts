/**
 * The CrisperWhisper adapter kept running between requests, with its model loaded.
 *
 * Started fresh for every window, each run of the adapter started Python, imported torch and moved 3 GB of weights to
 * the GPU before it read anything, and a dialogue pass's short readings each paid that again. The worker starts on the
 * first request, reads one at a time, and exits after a minute without one, which gives back its memory and its slot in
 * the adapter's memory budget. It stays while an agent is at work (audioWorker.wanted), whose readings come a turn
 * apart. A request that fails ends the worker on its side, and the next request starts another.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { mediaToolLaunchError } from "@scarlet/render";
import { FfmpegError } from "../render/ffmpeg.js";
import { editorFirst, type StillBackground } from "../services/editorFirst.js";
import { audioWorker } from "./audioWorker.js";

export interface CrisperRequest {
  /** How the worker is started: one serves only requests that would start it the same way. */
  binary: string;
  args: string[];
  wav: string;
  /** The adapter writes `out`.json, as with `-of out`. */
  out: string;
  language: string;
  progress: boolean;
  signal?: AbortSignal;
  /** Each line the adapter writes to stderr while it reads this request. */
  onStderrLine?: (line: string) => void;
}

type Worker = { key: string; child: ChildProcess; args: string[]; errors: string; failure?: string; kill?: ReturnType<typeof setTimeout> };
type Job = { id: number; request: CrisperRequest; resolve(): void; reject(error: unknown): void; worker?: Worker;
  cancel?: () => void; background?: StillBackground };

const IDLE_MS = 60_000;
let worker: Worker | undefined;
let current: Job | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;
let next = 0;
const queue: Job[] = [];

function lines(stream: Readable, each: (line: string) => void) {
  let rest = "";
  stream.on("data", (data: Buffer) => {
    rest += data.toString("utf8");
    let nl: number;
    while ((nl = rest.indexOf("\n")) >= 0) {
      each(rest.slice(0, nl).trim());
      rest = rest.slice(nl + 1);
    }
  });
  stream.on("end", () => {
    const final = rest.trim();
    rest = "";
    if (final) each(final);
  });
}

const tail = (errors: string) => errors.trim().split("\n").slice(-6).join("\n");

function start(request: CrisperRequest, key: string): Worker {
  const { binary, args } = request;
  const child = spawn(binary, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const started: Worker = { key, child, args, errors: "" };
  // Background work's readings yield to the editor, as each run of the adapter did.
  if (child.pid !== undefined) {
    const release = editorFirst.adopt(child.pid, () => current?.worker === started && !!current.background?.());
    child.once("exit", release);
    child.once("error", release);
  }
  lines(child.stderr!, line => {
    started.errors = (started.errors + line + "\n").slice(-16000);
    if (current?.worker === started) current.request.onStderrLine?.(line);
  });
  lines(child.stdout!, line => {
    const job = current;
    if (!line || job?.worker !== started) return;
    let reply: { id?: number; ok?: boolean; error?: string };
    try { reply = JSON.parse(line); } catch { return; }
    if (reply.id !== job.id) return;
    if (reply.ok) {
      finish(job, () => job.resolve());
      return;
    }
    // The worker exits after an error reply. Detach it now so nothing queued is sent to it, and wait for close so
    // stderr's traceback has finished arriving before we report the failure.
    if (worker === started) worker = undefined;
    started.failure = reply.error ?? "no reason given";
    child.stdin?.end();
    started.kill = setTimeout(() => child.kill("SIGKILL"), 1_000);
    started.kill.unref?.();
  });
  // Writing to a worker that has just exited fails; its close says why.
  child.stdin!.on("error", () => {});
  const stopped = (why: () => Error) => {
    clearTimeout(started.kill);
    if (worker === started) worker = undefined;
    const job = current;
    if (job?.worker !== started) return;
    const { signal } = job.request;
    finish(job, () => job.reject(signal?.aborted ? signal.reason : why()));
  };
  child.on("error", error => stopped(() =>
    new FfmpegError(mediaToolLaunchError(binary, error, `${binary} failed to start: ${error.message}`), args, started.errors)));
  child.on("close", (code, signal) => stopped(() => started.failure !== undefined
    ? new FfmpegError(`${binary} failed: ${started.failure}\n${tail(started.errors)}`, args, started.errors)
    : new FfmpegError(`${binary} exited with ${signal ? `signal ${signal}` : `code ${code}`}: ${tail(started.errors)}`, args, started.errors)));
  return started;
}

/** An idle worker never keeps the engine from exiting, and it exits itself when the engine goes. One at work is waited for. */
function hold(target: Worker, working: boolean) {
  const { child } = target;
  for (const handle of [child, child.stdin, child.stdout, child.stderr] as Array<{ ref?(): void; unref?(): void } | null>) {
    (working ? handle?.ref : handle?.unref)?.call(handle);
  }
}

function stop() {
  const stopping = worker;
  worker = undefined;
  stopping?.child.kill();
}

function finish(job: Job, settle: () => void) {
  if (current !== job) return;
  current = undefined;
  job.cancel?.();
  settle();
  pump();
}

function pump() {
  if (current) return;
  clearTimeout(idle);
  const job = queue.shift();
  if (!job) {
    if (worker) hold(worker, false);
    const rest = () => {
      idle = setTimeout(() => {
        if (worker && audioWorker.wanted?.()) return rest();
        stop();
      }, IDLE_MS);
      idle.unref?.();
    };
    if (worker) rest();
    return;
  }
  current = job;
  job.cancel?.();
  const { request } = job;
  try {
    const key = [request.binary, ...request.args].join("\0");
    if (worker && worker.key !== key) stop();
    const target = job.worker = worker ??= start(request, key);
    hold(target, true);
    // What the adapter writes from here on is about this request, and is what a failure reports.
    target.errors = "";
    // Killing the worker is the only way to stop a reading under way. The next request starts another.
    const abort = () => {
      if (worker === target) worker = undefined;
      target.child.kill("SIGKILL");
    };
    request.signal?.addEventListener("abort", abort, { once: true });
    job.cancel = () => request.signal?.removeEventListener("abort", abort);
    editorFirst.check();
    target.child.stdin!.write(JSON.stringify({ id: job.id, wav: request.wav, out: request.out, language: request.language, progress: request.progress }) + "\n");
  } catch (error) {
    finish(job, () => job.reject(error));
  }
}

export const crisperWorker = {
  /** Read one WAV in the worker. Aborting stops the reading, and the worker with it. */
  transcribe(request: CrisperRequest): Promise<void> {
    const { signal } = request;
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const job: Job = { id: next++, request, resolve, reject, background: editorFirst.current() };
      const dequeue = () => {
        const index = queue.indexOf(job);
        if (index < 0) return;
        queue.splice(index, 1);
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", dequeue, { once: true });
      job.cancel = () => signal?.removeEventListener("abort", dequeue);
      queue.push(job);
      pump();
    });
  },
  /** Stop the worker now, between requests or in the middle of one. */
  stop() {
    const target = worker;
    stop();
    target?.child.kill("SIGKILL");
  },
};
