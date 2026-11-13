import { describe, expect, it, vi } from "vitest";
import { AudioLane, audioLane, whisperLane, type AudioWork } from "./audioWork.js";

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

  it("shares one lane per engine data directory", () => {
    expect(audioLane({ paths: { root: "/tmp/one" } })).toBe(audioLane({ paths: { root: "/tmp/one" } }));
    expect(audioLane({ paths: { root: "/tmp/one" } })).not.toBe(audioLane({ paths: { root: "/tmp/two" } }));
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
