import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, type ChildProcess } from "node:child_process";
import { constants, setPriority } from "node:os";
import { spawnObserver } from "@scarlet/render";

/**
 * While the editor plays or scrubs, the processes of work nobody is waiting on (an import's transcripts, speaker
 * analysis, proxies, preview caches) run at the system's background priority, so the editor's playback sections and
 * pictures get the machine. They return to normal priority a moment after the editor stops.
 *
 * On 2026-11-16 a project of two 58-minute recordings was imported while the editor watched another. Its Whisper,
 * alignment, speaker analysis and proxies took about eight cores for half an hour, and 3-second playback sections
 * that had taken 0.1-0.5 s took 20-50 s each, so playback stalled every few seconds.
 *
 * Work marks itself with `backgroundWork.run(stillBackground, job)`. Every process it spawns, through the engine's
 * `run` or the render package, is adopted for as long as it runs. `stillBackground` is asked again every few
 * seconds: work turns urgent when a dialogue pass starts reading its recording, or something a pass waits on queues
 * behind it, and then it runs at normal priority whatever the editor does.
 *
 * On a Mac the background priority is Darwin's (`taskpolicy -b`): efficiency cores, throttled disk and GPU, and it
 * can be lifted again (`taskpolicy -B`). On Windows it is below normal. Elsewhere a raised nice value can't be
 * lowered again without root, so nothing changes.
 */

/** Whether the work is still nobody's to wait for. */
export type StillBackground = () => boolean;

/** How long after the editor's last request their playback still counts as under way. */
const ACTIVE_MS = 10_000;
/** How often adopted processes are checked while any run. */
const CHECK_MS = 2_000;

type Adopted = { stillBackground: StillBackground; lowered: boolean };

export type PriorityApplier = (pid: number, background: boolean) => Promise<void>;

const taskpolicy = (pid: number, background: boolean) => new Promise<void>((resolve, reject) =>
  execFile("/usr/sbin/taskpolicy", [background ? "-b" : "-B", "-p", String(pid)], { timeout: 5_000 }, error => error ? reject(error) : resolve()));

const platformApplier: PriorityApplier | undefined = process.platform === "darwin" ? taskpolicy
  : process.platform === "win32" ? async (pid, background) =>
    setPriority(pid, background ? constants.priority.PRIORITY_BELOW_NORMAL : constants.priority.PRIORITY_NORMAL)
    : undefined;

export class EditorFirst {
  private readonly context = new AsyncLocalStorage<StillBackground>();
  private readonly adopted = new Map<number, Adopted>();
  private lastActive = -Infinity;
  /** Playback the editor is waiting for, such as a section being rendered. */
  private holds = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private failed = false;
  log: ((message: string) => void) | undefined;

  constructor(private readonly apply = platformApplier, private readonly now = () => performance.now()) {}

  /** Run `job` as background work: the processes it starts yield to the editor while `stillBackground()` holds. */
  run<T>(stillBackground: StillBackground, job: () => T): T {
    return this.context.run(stillBackground, job);
  }

  /** The background work the caller is part of, if any. */
  current(): StillBackground | undefined {
    return this.context.getStore();
  }

  /** The editor asked for something they're looking at: a picture, a playback section. */
  touch() {
    const was = this.editorActive();
    this.lastActive = this.now();
    if (!was) this.check();
  }

  /** The editor is waiting for this until the returned release is called, however long it takes. */
  hold(): () => void {
    // Touched before the hold counts, so a hold that starts the editor's activity lowers background work at once.
    this.touch();
    this.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      this.lastActive = this.now();
    };
  }

  editorActive(): boolean {
    return this.holds > 0 || this.now() - this.lastActive < ACTIVE_MS;
  }

  /** Adopt a process started inside background work, until it exits. */
  adoptChild(child: ChildProcess) {
    const stillBackground = this.current();
    if (!stillBackground || child.pid === undefined) return;
    const release = this.adopt(child.pid, stillBackground);
    child.once("exit", release);
    child.once("error", release);
  }

  /** Adopt a running process. The returned release forgets it; callers release once the process has exited, so no priority is put back. */
  adopt(pid: number, stillBackground: StillBackground): () => void {
    if (!this.apply) return () => {};
    const entry: Adopted = { stillBackground, lowered: false };
    this.adopted.set(pid, entry);
    this.settle(pid, entry);
    if (!this.timer) {
      this.timer = setInterval(() => this.check(), CHECK_MS);
      this.timer.unref?.();
    }
    return () => {
      if (this.adopted.get(pid) !== entry) return;
      this.adopted.delete(pid);
      if (!this.adopted.size) { clearInterval(this.timer); this.timer = undefined; }
    };
  }

  /** Change the priority of an adopted process the editor's activity or its work's urgency has moved. */
  check() {
    for (const [pid, entry] of this.adopted) this.settle(pid, entry);
  }

  /** Processes adopted now, and whether each runs at background priority. */
  snapshot(): Array<{ pid: number; lowered: boolean }> {
    return [...this.adopted].map(([pid, { lowered }]) => ({ pid, lowered }));
  }

  private settle(pid: number, entry: Adopted) {
    let background: boolean;
    try { background = this.editorActive() && entry.stillBackground(); }
    catch { background = false; }
    if (background === entry.lowered) return;
    entry.lowered = background;
    this.apply!(pid, background).catch((error: NodeJS.ErrnoException & { code?: unknown }) => {
      // A process that has just exited can't change priority, and that isn't worth a line.
      if (this.adopted.get(pid) !== entry || this.failed) return;
      this.failed = true;
      this.log?.(`[media] couldn't change a background process's priority, so it keeps its own: ${error.message}`);
    });
  }
}

/** The engine's: process priority is the machine's, so one serves every engine in the process. */
export const editorFirst = new EditorFirst();

spawnObserver.spawned = child => editorFirst.adoptChild(child);
