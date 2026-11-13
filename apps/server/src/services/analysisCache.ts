/** Bounded LRU for decoded media analysis. Duplicate requests share a worker
 * and a result. Failed work releases its slot and can be retried. */
export class AnalysisCache<T> {
  private readonly entries = new Map<string, { value: T; bytes: number }>();
  private readonly pending = new Map<string, { result: Promise<T>; abort: AbortController; users: number }>();
  private readonly waiting: Array<{ key: string; priority: boolean; resume(): void }> = [];
  private bytes = 0;
  private active = 0;

  constructor(private readonly sizeOf: (value: T) => number,
    private readonly maxBytes = 16 * 1024 * 1024, private readonly workers = 2) {}

  get(key: string, decode: (signal: AbortSignal) => Promise<T>, options: { signal?: AbortSignal; priority?: boolean } = {}): Promise<T> {
    const { signal, priority = false } = options;
    if (signal?.aborted) return Promise.reject(signal.reason);
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return Promise.resolve(hit.value);
    }
    let job = this.pending.get(key);
    if (!job || job.abort.signal.aborted) {
      const abort = new AbortController();
      const result = this.load(key, decode, abort.signal, priority).finally(() => {
        if (this.pending.get(key)?.abort === abort) this.pending.delete(key);
      });
      job = { result, abort, users: 0 };
      this.pending.set(key, job);
    } else if (priority) {
      const queued = this.waiting.find(item => item.key === key);
      if (queued && !queued.priority) {
        queued.priority = true;
        this.waiting.sort((a, b) => Number(b.priority) - Number(a.priority));
      }
    }
    job.users++;
    if (!signal) return job.result;
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        if (--job.users === 0) job.abort.abort();
        reject(signal.reason);
      };
      signal.addEventListener("abort", cancel, { once: true });
      job.result.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
    });
  }

  private async load(key: string, decode: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, priority: boolean): Promise<T> {
    if (this.active >= this.workers) await new Promise<void>((resolve, reject) => {
      const queued = { key, priority, resume: () => { signal.removeEventListener("abort", cancel); resolve(); } };
      const cancel = () => {
        this.waiting.splice(this.waiting.indexOf(queued), 1);
        reject(signal.reason);
      };
      const index = priority ? this.waiting.findIndex(job => !job.priority) : -1;
      this.waiting.splice(index < 0 ? this.waiting.length : index, 0, queued);
      signal.addEventListener("abort", cancel, { once: true });
    });
    else this.active++;
    try {
      signal.throwIfAborted();
      const value = await decode(signal);
      signal.throwIfAborted();
      const bytes = 64 + this.sizeOf(value) + key.length * 2;
      if (bytes <= this.maxBytes) {
        this.entries.set(key, { value, bytes });
        this.bytes += bytes;
        for (const [oldKey, old] of this.entries) {
          if (this.bytes <= this.maxBytes) break;
          this.bytes -= old.bytes;
          this.entries.delete(oldKey);
        }
      }
      return value;
    } finally {
      const next = this.waiting.shift();
      if (next) next.resume();
      else this.active--;
    }
  }
}
