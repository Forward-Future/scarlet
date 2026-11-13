import { describe, expect, it } from "vitest";
import { pictureDecoder, PictureLane, pictureLane } from "./pictureWork.js";

function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { open, opened };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe("picture lane", () => {
  it("runs a few decodes at a time, the editor's ahead of the agent's", async () => {
    const lane = new PictureLane(2);
    const started: string[] = [];
    const add = (name: string, priority = false) => {
      const g = gate();
      const done = lane.run(async () => { started.push(name); await g.opened; }, { priority });
      return { release: g.open, done };
    };
    const [a, b, c, d] = [add("agent 1"), add("agent 2"), add("agent 3"), add("agent 4")];
    const monitor = add("monitor", true);
    await tick();
    expect(started).toEqual(["agent 1", "agent 2"]);
    expect(lane.queued).toBe(3);
    a.release(); await a.done; await tick();
    expect(started).toEqual(["agent 1", "agent 2", "monitor"]);
    for (const job of [b, monitor, c, d]) { job.release(); await job.done; await tick(); }
    expect(started).toEqual(["agent 1", "agent 2", "monitor", "agent 3", "agent 4"]);
  });

  it("drops a cancelled request and frees its slot after a failure", async () => {
    const lane = new PictureLane(1);
    const g = gate();
    const running = lane.run(() => g.opened);
    const abort = new AbortController();
    const cancelled = lane.run(async () => "never", { signal: abort.signal });
    abort.abort(new Error("left the page"));
    await expect(cancelled).rejects.toThrow("left the page");
    expect(lane.queued).toBe(0);
    g.open(); await running;
    await expect(lane.run(async () => { throw new Error("decode failed"); })).rejects.toThrow("decode failed");
    await expect(lane.run(async () => "after")).resolves.toBe("after");
  });

  it("shares one lane per engine, with at least two slots", () => {
    expect(pictureLane({ paths: { root: "/tmp/one" } })).toBe(pictureLane({ paths: { root: "/tmp/one" } }));
    expect(pictureLane({ paths: { root: "/tmp/one" } }).slots).toBeGreaterThanOrEqual(2);
  });

  it("decodes on the GPU unless hardware decoding is off", async () => {
    expect(await pictureDecoder("none")).toBeUndefined();
    expect(await pictureDecoder("nvenc")).toBe("cuda");
    expect(await pictureDecoder("videotoolbox")).toBe("videotoolbox");
    if (process.platform === "darwin") expect(await pictureDecoder("auto")).toBe("videotoolbox");
  });
});
