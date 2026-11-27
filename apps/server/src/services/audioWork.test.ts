import { describe, expect, it, vi } from "vitest";
import { AudioLane, askFor, audioLane, pageWhisperLane, whisperLane, type AudioWork } from "./audioWork.js";

function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { open, opened };
}

/** Holds the lane until released, recording the order jobs start in. */
function harness(lane: AudioLane) {
  const order: string[] = [];
  const add = (name: string, work: AudioWork, signal?: AbortSignal, more?: boolean) => {
    const g = gate();
    const done = lane.run(work, signal, async () => { order.push(name); await g.opened; return name; }, { more });
    return { release: g.open, done };
  };
  return { order, add };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe("audio lane", () => {
  it("records a blocked wait before the worker finishes and records cancellation while queued", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const lines: string[] = [];
      const { add } = harness(new AudioLane(line => lines.push(line)));
      const running = add("first", { mediaId: "med_aaaaaaaaaaaa", kind: "transcript" });
      const cancel = new AbortController();
      const waiting = add("second", { mediaId: "med_bbbbbbbbbbbb", kind: "alignment" }, cancel.signal);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(lines).toEqual(["[audio] waiting lane=audio work=alignment media=med_bbbbbbbbbbbb wait_ms=30000 ahead=1 blocker_work=transcript blocker=med_aaaaaaaaaaaa"]);
      const rejected = expect(waiting.done).rejects.toMatchObject({ name: "AbortError" });
      cancel.abort();
      await rejected;
      expect(lines.at(-1)).toBe("[audio] cancelled_while_waiting lane=audio work=alignment media=med_bbbbbbbbbbbb wait_ms=30000");
      running.release();
      await running.done;
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs one job at a time, first come first served when nothing is focused", async () => {
    const lane = new AudioLane();
    const { order, add } = harness(lane);
    const a = add("A transcript", { mediaId: "a", kind: "transcript" });
    const b = add("B transcript", { mediaId: "b", kind: "transcript" });
    const c = add("B page", { mediaId: "b", kind: "page" });
    await tick();
    expect(order).toEqual(["A transcript"]);
    a.release(); await a.done; await tick();
    expect(order).toEqual(["A transcript", "B transcript"]);
    b.release(); await b.done; await tick();
    c.release(); await c.done;
    expect(order).toEqual(["A transcript", "B transcript", "B page"]);
  });

  it("puts the read recording's transcript first, then its speakers and pages, then other work", async () => {
    const lane = new AudioLane();
    const { order, add } = harness(lane);
    const running = add("other speakers", { mediaId: "b", kind: "speakers" });
    await tick();
    const otherTranscript = add("other transcript", { mediaId: "b", kind: "transcript" });
    const page = add("page", { mediaId: "a", kind: "page" });
    const speakers = add("speakers", { mediaId: "a", kind: "speakers" });
    // The transcript was queued in the background before the pass started reading its recording.
    const transcript = add("transcript", { mediaId: "a", kind: "transcript" });
    const unfocus = lane.focus("a");
    expect(lane.queued().map(w => `${w.mediaId} ${w.kind}`)).toEqual(["a transcript", "a page", "a speakers", "b transcript"]);
    for (const job of [running, transcript, page, speakers, otherTranscript]) { job.release(); await job.done; await tick(); }
    expect(order).toEqual(["other speakers", "transcript", "page", "speakers", "other transcript"]);
    unfocus();
    expect(lane.rank({ mediaId: "a", kind: "transcript" })).toBe(2);
  });

  it("lets a read recording's pages run between the turns of its alignment", async () => {
    const lane = new AudioLane();
    const { order, add } = harness(lane);
    lane.focus("a");
    const whisper = add("whisper", { mediaId: "a", kind: "transcript" }, undefined, true);
    await tick();
    const first = add("page 1", { mediaId: "a", kind: "page" });
    whisper.release(); await whisper.done; await tick();
    // Alignment continues Whisper's work, so its first turn takes the lane Whisper kept, ahead of the page.
    expect(order).toEqual(["whisper"]);
    const turn1 = add("turn 1", { mediaId: "a", kind: "alignment" });
    await tick();
    expect(order).toEqual(["whisper", "turn 1"]);
    // From then on a turn says nothing follows and queues like any other work for the recording.
    turn1.release(); await turn1.done;
    const turn2 = add("turn 2", { mediaId: "a", kind: "alignment" });
    await tick();
    expect(order.at(-1)).toBe("page 1");
    const second = add("page 2", { mediaId: "a", kind: "page" });
    first.release(); await first.done; await tick();
    expect(order.at(-1)).toBe("turn 2");
    turn2.release(); await turn2.done; await tick();
    second.release(); await second.done;
    expect(order).toEqual(["whisper", "turn 1", "page 1", "turn 2", "page 2"]);
    // A recording nobody reads aligns behind everything a pass needs.
    expect(lane.rank({ mediaId: "a", kind: "alignment" })).toBe(1);
    expect(lane.rank({ mediaId: "b", kind: "alignment" })).toBe(2);
  });

  it("keeps a recording focused until every pass reading it has finished", () => {
    const lane = new AudioLane();
    const first = lane.focus("a"), second = lane.focus("a");
    first();
    first();
    expect(lane.rank({ mediaId: "a", kind: "page" })).toBe(1);
    second();
    expect(lane.rank({ mediaId: "a", kind: "page" })).toBe(2);
  });

  it("drops a cancelled job from the queue and frees the lane after a failure", async () => {
    const lane = new AudioLane();
    const { order, add } = harness(lane);
    const running = add("first", { mediaId: "a", kind: "page" });
    const abort = new AbortController();
    const cancelled = add("cancelled", { mediaId: "a", kind: "page" }, abort.signal);
    const failing = lane.run({ mediaId: "a", kind: "page" }, undefined, async () => { order.push("failing"); throw new Error("whisper failed"); });
    abort.abort(new Error("stopped"));
    await expect(cancelled.done).rejects.toThrow("stopped");
    expect(lane.queued()).toHaveLength(1);
    running.release(); await running.done;
    await expect(failing).rejects.toThrow("whisper failed");
    const after = add("after", { mediaId: "a", kind: "page" });
    await tick();
    after.release();
    await expect(after.done).resolves.toBe("after");
    expect(order).toEqual(["first", "failing", "after"]);
    await expect(lane.run({ mediaId: "a", kind: "page" }, AbortSignal.abort(new Error("gone")), async () => 1)).rejects.toThrow("gone");
  });

  it("finishes one recording's transcript before the next one starts", async () => {
    const lane = new AudioLane();
    const { order, add } = harness(lane);
    const a = { mediaId: "a", kind: "transcript" } as const, b = { mediaId: "b", kind: "transcript" } as const;
    const whisperA = add("A whisper", a, undefined, true);
    const whisperB = add("B whisper", b, undefined, true);
    await tick();
    // A's Whisper ends. Its first alignment turn queues a moment later and still goes before B's Whisper.
    whisperA.release(); await whisperA.done; await tick();
    expect(order).toEqual(["A whisper"]);
    const alignA1 = add("A align 1", a, undefined, true);
    await tick();
    expect(order).toEqual(["A whisper", "A align 1"]);
    // While a turn runs, other work queues. The next turn, queued after it, keeps A's place.
    const page = add("B page", { mediaId: "b", kind: "page" });
    alignA1.release(); await alignA1.done;
    const alignA2 = add("A align 2", a);
    await tick();
    alignA2.release(); await alignA2.done; await tick();
    expect(order).toEqual(["A whisper", "A align 1", "A align 2", "B whisper"]);
    whisperB.release(); await whisperB.done;
    // B's Whisper said alignment follows. With none coming yet, the lane waits rather than start the page.
    await tick();
    expect(order.at(-1)).toBe("B whisper");
    const alignB = add("B align", b);
    await tick();
    alignB.release(); await alignB.done; await tick();
    page.release(); await page.done;
    expect(order).toEqual(["A whisper", "A align 1", "A align 2", "B whisper", "B align", "B page"]);
  });

  it("doesn't keep the lane for a later step when higher-ranked work is waiting, or when the step never comes", async () => {
    vi.useFakeTimers();
    try {
      const lane = new AudioLane();
      const { order, add } = harness(lane);
      const background = add("background whisper", { mediaId: "a", kind: "transcript" }, undefined, true);
      await vi.advanceTimersByTimeAsync(0);
      background.release(); await background.done;
      // A pass starts reading another recording: its page outranks the background transcript's next step.
      const unfocus = lane.focus("b");
      const page = add("read page", { mediaId: "b", kind: "page" });
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual(["background whisper", "read page"]);
      page.release(); await page.done;
      unfocus();

      const again = add("whisper again", { mediaId: "c", kind: "transcript" }, undefined, true);
      await vi.advanceTimersByTimeAsync(0);
      again.release(); await again.done;
      const other = add("other", { mediaId: "d", kind: "page" });
      await vi.advanceTimersByTimeAsync(9_000);
      expect(order.at(-1)).toBe("whisper again");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(order.at(-1)).toBe("other");
      other.release(); await other.done;
    } finally { vi.useRealTimers(); }
  });

  it("hands the lane on at once when the step it was kept for won't come", async () => {
    vi.useFakeTimers();
    try {
      const lane = new AudioLane();
      const { order, add } = harness(lane);
      const whisper = add("whisper", { mediaId: "a", kind: "transcript" }, undefined, true);
      await vi.advanceTimersByTimeAsync(0);
      whisper.release(); await whisper.done;
      const speakers = add("speakers", { mediaId: "a", kind: "speakers" });
      // Releasing other work's hold changes nothing.
      lane.release({ mediaId: "b", kind: "transcript" });
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual(["whisper"]);
      // Its alignment won't follow: the speakers start now, not when the hold runs out.
      lane.release({ mediaId: "a", kind: "transcript" });
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual(["whisper", "speakers"]);
      speakers.release(); await speakers.done;
    } finally { vi.useRealTimers(); }
  });

  it("releases a finished attempt's own reservation without releasing a newer attempt on the same recording", async () => {
    const lane = new AudioLane();
    const first: AudioWork = { mediaId: "a", kind: "transcript" };
    const next: AudioWork = { ...first };
    await lane.run(first, undefined, async () => {}, { more: true });
    await lane.run(next, undefined, async () => {}, { more: true });
    const waiting = vi.fn(async () => {});
    const done = lane.run({ mediaId: "b", kind: "speakers" }, undefined, waiting);
    lane.finish(first);
    await tick();
    expect(waiting).not.toHaveBeenCalled();
    lane.finish(next);
    await done;
    expect(waiting).toHaveBeenCalledOnce();
  });

  it("puts work a request waits on ahead of background work, also on a recording no pass has focused", async () => {
    vi.useFakeTimers();
    try {
      const lane = new AudioLane();
      const { order, add } = harness(lane);
      // Another recording's transcript is under way and keeps the lane for its next turn.
      const turn1 = add("background turn 1", { mediaId: "b", kind: "alignment" }, undefined, true);
      await vi.advanceTimersByTimeAsync(0);
      const background = add("background page", { mediaId: "c", kind: "page" });
      const asked = add("asked page", { mediaId: "a", kind: "page", asked: true });
      expect(lane.rank({ mediaId: "a", kind: "page", asked: true })).toBe(1);
      turn1.release(); await turn1.done;
      await vi.advanceTimersByTimeAsync(0);
      // The asked page doesn't wait for the background transcript to finish, nor for work queued before it.
      expect(order).toEqual(["background turn 1", "asked page"]);
      // The transcript's next turn, queued meanwhile, still finishes it before other background work starts.
      const turn2 = add("background turn 2", { mediaId: "b", kind: "alignment" });
      asked.release(); await asked.done;
      await vi.advanceTimersByTimeAsync(0);
      for (const job of [turn2, background]) { job.release(); await job.done; await vi.advanceTimersByTimeAsync(0); }
      expect(order).toEqual(["background turn 1", "asked page", "background turn 2", "background page"]);

      // Among a read recording's work, the page a request joins goes ahead of the scan's pages queued before it.
      const unfocus = lane.focus("a");
      const running = add("running", { mediaId: "a", kind: "alignment" });
      await vi.advanceTimersByTimeAsync(0);
      const scanned = add("scan page", { mediaId: "a", kind: "page" });
      const joined: AudioWork = { mediaId: "a", kind: "page" };
      const read = add("read page", joined);
      lane.ask(joined);
      expect(lane.queued().map(w => w.kind + (w.asked ? " asked" : ""))).toEqual(["page asked", "page"]);
      for (const job of [running, read, scanned]) { job.release(); await job.done; await vi.advanceTimersByTimeAsync(0); }
      expect(order.slice(-3)).toEqual(["running", "read page", "scan page"]);
      unfocus();
    } finally { vi.useRealTimers(); }
  });

  it("stops keeping the lane for a step when a request joins work that goes ahead of it", async () => {
    vi.useFakeTimers();
    try {
      const ctx = { paths: { root: "/tmp/asked-hold" } };
      const lane = audioLane(ctx);
      const { order, add } = harness(lane);
      const whisper = add("background whisper", { mediaId: "b", kind: "transcript" }, undefined, true);
      await vi.advanceTimersByTimeAsync(0);
      whisper.release(); await whisper.done;
      const work: AudioWork = { mediaId: "a", kind: "page" };
      const page = add("page", work);
      await vi.advanceTimersByTimeAsync(0);
      // Equal in rank, the page waits for the step the background transcript kept the lane for.
      expect(order).toEqual(["background whisper"]);
      askFor(ctx, work);
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual(["background whisper", "page"]);
      page.release(); await page.done;
    } finally { vi.useRealTimers(); }
  });

  it("shares one lane per engine data directory", () => {
    expect(audioLane({ paths: { root: "/tmp/one" } })).toBe(audioLane({ paths: { root: "/tmp/one" } }));
    expect(audioLane({ paths: { root: "/tmp/one" } })).not.toBe(audioLane({ paths: { root: "/tmp/two" } }));
  });

  it("reads a pass's pages in a second Whisper lane beside the transcript's, where memory allows", async () => {
    const ctx = { paths: { root: "/tmp/page-whisper" } };
    const gb = 1024 ** 3;
    // Without a GPU lane, or on a small Mac, pages take their turn with the transcript.
    expect(pageWhisperLane(ctx, false, 64 * gb)).toBe(audioLane(ctx));
    expect(pageWhisperLane(ctx, true, 8 * gb)).toBe(whisperLane(ctx, true));
    const pages = pageWhisperLane(ctx, true, 36 * gb);
    expect(pages).not.toBe(whisperLane(ctx, true));
    expect(pageWhisperLane(ctx, true, 36 * gb)).toBe(pages);
    const order: string[] = [];
    const hold = (lane: AudioLane, name: string, work: AudioWork) => {
      const g = gate();
      return { release: g.open, done: lane.run(work, undefined, async () => { order.push(name); await g.opened; }) };
    };
    const unfocus = audioLane(ctx).focus("a");
    expect(pages.focusedOn("a")).toBe(true);
    const transcript = hold(whisperLane(ctx, true), "transcript a", { mediaId: "a", kind: "transcript" });
    const page = hold(pages, "page a", { mediaId: "a", kind: "page" });
    await tick();
    // The page's Whisper doesn't wait for the transcript's.
    expect(order).toEqual(["transcript a", "page a"]);
    const work: AudioWork = { mediaId: "a", kind: "page" };
    const next = hold(pages, "next page a", work);
    askFor(ctx, work);
    expect(work.asked).toBe(true);
    for (const job of [transcript, page, next]) { job.release(); await job.done; await tick(); }
    expect(order).toEqual(["transcript a", "page a", "next page a"]);
    unfocus();
  });

  it("gives GPU Whisper a lane of its own that runs beside the CPU models and ranks by the same recordings", async () => {
    const ctx = { paths: { root: "/tmp/gpu-whisper" } };
    const cpu = audioLane(ctx), gpu = whisperLane(ctx, true);
    // Without a GPU, Whisper takes its turn in the engine's one lane.
    expect(whisperLane(ctx, false)).toBe(cpu);
    expect(gpu).not.toBe(cpu);
    expect(whisperLane(ctx, true)).toBe(gpu);
    const order: string[] = [];
    const hold = (lane: AudioLane, name: string, work: AudioWork) => {
      const g = gate();
      return { release: g.open, done: lane.run(work, undefined, async () => { order.push(name); await g.opened; }) };
    };
    const aligning = hold(cpu, "alignment", { mediaId: "a", kind: "alignment" });
    const whisper = hold(gpu, "whisper b", { mediaId: "b", kind: "transcript" });
    await tick();
    // Both run at once: Whisper doesn't wait for the alignment.
    expect(order).toEqual(["alignment", "whisper b"]);
    // A pass starts reading recording a: its page's Whisper goes ahead of another recording's transcript.
    const other = hold(gpu, "whisper c", { mediaId: "c", kind: "transcript" });
    const page = hold(gpu, "page a", { mediaId: "a", kind: "page" });
    const unfocus = cpu.focus("a");
    expect(gpu.focusedOn("a")).toBe(true);
    whisper.release(); await whisper.done; await tick();
    expect(order).toEqual(["alignment", "whisper b", "page a"]);
    for (const job of [page, other, aligning]) { job.release(); await job.done; await tick(); }
    expect(order).toEqual(["alignment", "whisper b", "page a", "whisper c"]);
    unfocus();
    expect(gpu.focusedOn("a")).toBe(false);
  });
});
