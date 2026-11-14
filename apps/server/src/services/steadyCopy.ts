import { open, utimes } from "node:fs/promises";

/** How much may be written before it is flushed to disk. */
const FLUSH_EVERY = 64 * 1024 * 1024;
const CHUNK = 8 * 1024 * 1024;

/**
 * Copy a large file without filling the system's write cache.
 *
 * A plain copy of an 8 GB recording hands all of it to the cache in a few seconds, and the disk then spends the next
 * half minute writing it out. Anything else that flushes to that disk waits for all of it. The engine's database does
 * so on its one thread: during an import its writes took 21.4 s, 19.6 s and 27.7 s, and the engine answered nothing
 * meanwhile (2026-11-07). Here the copy flushes what it has written every 64 MB, so another flush waits for that
 * much at most.
 *
 * The copy keeps the source's times, as the platform copy does.
 */
export async function steadyCopy(source: string, destination: string, signal?: AbortSignal,
  options: { flushEvery?: number; chunk?: number } = {}): Promise<void> {
  const flushEvery = options.flushEvery ?? FLUSH_EVERY;
  const input = await open(source, "r");
  try {
    const output = await open(destination, "w");
    try {
      const buffer = Buffer.allocUnsafe(options.chunk ?? CHUNK);
      let unflushed = 0;
      for (;;) {
        signal?.throwIfAborted();
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        let written = 0;
        while (written < bytesRead) {
          const { bytesWritten } = await output.write(buffer, written, bytesRead - written);
          if (!bytesWritten) throw new Error("Copy stopped before the file was written.");
          written += bytesWritten;
        }
        unflushed += bytesRead;
        if (unflushed >= flushEvery) {
          await output.datasync();
          unflushed = 0;
        }
      }
      await output.datasync();
    } finally {
      await output.close();
    }
    // Seconds as a number carry the time to a quarter of a microsecond. A Date would round it to the millisecond.
    const { atimeNs, mtimeNs } = await input.stat({ bigint: true });
    await utimes(destination, Number(atimeNs) / 1e9, Number(mtimeNs) / 1e9);
  } finally {
    await input.close();
  }
}
