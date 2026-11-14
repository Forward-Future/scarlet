/**
 * One helper process that keeps the aligner, the filler model and the screen-text reader loaded between requests.
 *
 * A dialogue pass asks for both once per scan page, 120 times for two hour-long recordings. Started fresh each
 * time, a process spent about a second starting Node, loading ONNX Runtime and reading the weights before it
 * inferred anything: filler detection took 1.3 s a page with 0.4 s of it inference on the GPU. The helper starts on
 * the first request, takes one request at a time, and exits after half a minute without one, which frees the models'
 * memory. Inference stays out of the engine's own process, which serves playback.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";

export type AudioRequest =
  /** `request`: a file holding an AlignRequest (wordAlign.ts). `wav` may be empty when the recording's store has every window. */
  | { kind: "align"; wav: string; model: string; request: string }
  /** `origin`: source seconds of the start of `wav`. */
  | { kind: "fillers"; wav: string; model: string; origin: number }
  /** `frames`: packed RGB frames of `width` by `height`, one after another (screenTextModel.ts). */
  | { kind: "screenText"; frames: string; width: number; height: number; finder: string; reader: string; letters: string };

type Reply = { id: number; result?: unknown; error?: string; progress?: number } | { note: string };
/** `worker`: the helper the job was sent to. `cancel`: stops listening to its signal, in the queue and then at work. */
type Job = { id: number; message: AudioRequest; signal?: AbortSignal; onProgress?: (done: number) => void;
  resolve(value: unknown): void; reject(error: unknown): void; cancel?: () => void; worker?: ChildProcess };

const IDLE_MS = 30_000;
let child: ChildProcess | undefined;
let errors = "";
let current: Job | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;
let next = 0;
const queue: Job[] = [];

function start() {
  const args = isSea() ? [] : [fileURLToPath(new URL("../../dist/cli.js", import.meta.url))];
  const started = spawn(process.execPath, [...args, "audio-worker"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  errors = "";
  started.stderr!.on("data", (data: Buffer) => { errors = (errors + data.toString("utf8")).slice(-4000); });
  started.on("message", (reply: Reply) => {
    if ("note" in reply) return audioWorker.log?.(`[audio] ${reply.note}`);
    const job = current;
    if (!job || reply.id !== job.id) return;
    if (reply.progress !== undefined) return job.onProgress?.(reply.progress);
    finish(job, () => reply.error !== undefined ? job.reject(new Error(reply.error)) : job.resolve(reply.result));
  });
  const stopped = (error?: Error) => {
    if (child === started) child = undefined;
    const job = current;
    // A helper stopped for being idle can exit after the next request has started another: that job is not its own.
    if (job && job.worker === started) finish(job, () => job.reject(job.signal?.aborted ? job.signal.reason : error ?? new Error(errors.trim() || "The audio helper stopped before it answered.")));
  };
  started.on("error", stopped);
  started.on("exit", () => stopped());
  return started;
}

/** An idle helper never keeps the engine from exiting, and it exits itself when the engine goes. One at work is waited for. */
function hold(worker: ChildProcess, working: boolean) {
  const handles = [worker, worker.channel, worker.stderr] as Array<{ ref?(): void; unref?(): void } | null | undefined>;
  for (const handle of handles) (working ? handle?.ref : handle?.unref)?.call(handle);
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
    if (child) hold(child, false);
    idle = setTimeout(() => { child?.kill(); child = undefined; }, IDLE_MS);
    idle.unref?.();
    return;
  }
  current = job;
  job.cancel?.();
  try {
    const worker = job.worker = child ??= start();
    hold(worker, true);
    // Killing the helper is the only way to stop native inference. The next request starts another.
    const abort = () => { if (child === worker) child = undefined; worker.kill("SIGKILL"); };
    job.signal?.addEventListener("abort", abort, { once: true });
    job.cancel = () => job.signal?.removeEventListener("abort", abort);
    worker.send({ id: job.id, ...job.message }, error => {
      if (error) finish(job, () => job.reject(error));
    });
  } catch (error) {
    finish(job, () => job.reject(error));
  }
}

export const audioWorker = {
  /** Where the helper's notes go: which processor each model runs on, and why a GPU was given up. */
  log: undefined as ((message: string) => void) | undefined,
  /** Run one request in the helper. Aborting stops it, and the helper with it. */
  request<T>(message: AudioRequest, options: { signal?: AbortSignal; onProgress?: (done: number) => void } = {}): Promise<T> {
    const { signal, onProgress } = options;
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const job: Job = { id: next++, message, signal, onProgress, resolve: resolve as (value: unknown) => void, reject };
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
};

/** The helper's side: answer requests in order until the engine goes away. */
export function serveAudioWorker() {
  const ready = Promise.all([import("./uhm.js"), import("./wordAlign.js"), import("./screenTextModel.js")]);
  let sessions: import("./uhm.js").Sessions | undefined;
  let chain: Promise<void> = Promise.resolve();
  const send = (reply: Reply) => { if (process.connected) process.send!(reply); };
  process.on("message", (message: AudioRequest & { id: number }) => {
    chain = chain.then(async () => {
      try {
        const [uhm, align, screen] = await ready;
        sessions ??= new uhm.Sessions(note => send({ note }));
        const result = message.kind === "align"
          ? await align.runAlignWorker(message.wav, message.model, message.request, progress => send({ id: message.id, progress }), sessions)
          : message.kind === "screenText"
            ? await screen.runScreenTextWorker(message.frames, message.width, message.height, message.finder, message.reader, message.letters, sessions)
            : await uhm.runFillerWorker(message.wav, message.model, message.origin, sessions);
        send({ id: message.id, result });
      } catch (error) {
        send({ id: message.id, error: error instanceof Error ? error.message : String(error) });
      }
    });
  });
  process.on("disconnect", () => process.exit(0));
}
