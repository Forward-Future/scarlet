import { expect, it } from "vitest";
import { AnalysisCache } from "./analysisCache.js";

/** Work that sees its stop, then takes until `close` to let go. */
function work() {
  let close!: () => void, stopped = false;
  const closed = new Promise<void>(resolve => { close = resolve; });
  const decode = async (signal: AbortSignal) => {
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    stopped = true;
    await closed;
    throw signal.reason;
  };
  return { decode, close, stopped: () => stopped };
}
const settled = (promise: Promise<unknown>) => {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  return () => done;
};

it("answers the last caller of stopped work only once the work has stopped, and any other caller at once", async () => {
  const cache = new AnalysisCache<string>(() => 0);
  const job = work();
  const first = new AbortController(), second = new AbortController();
  const a = cache.get("key", job.decode, { signal: first.signal });
  const b = cache.get("key", job.decode, { signal: second.signal });
  const aDone = settled(a), bDone = settled(b);
  // Another caller still waits for the work, so this one is answered at once and the work goes on.
  first.abort(new Error("first"));
  await expect(a).rejects.toThrow("first");
  expect(job.stopped()).toBe(false);
  // The last caller stops the work, and hears of it when the work has let go.
  second.abort(new Error("second"));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect([job.stopped(), bDone()]).toEqual([true, false]);
  job.close();
  await expect(b).rejects.toThrow("second");
  expect(aDone()).toBe(true);
});
