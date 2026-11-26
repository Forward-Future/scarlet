import { describe, expect, it } from "vitest";
import { frameDecoder, framePriority, machineBusy, pictureDecoder, PictureLane, pictureLane } from "./pictureWork.js";

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
    const scrub = add("scrub", true);
    await tick();
    // The editor's first frame has a slot kept for it; its second waits ahead of the agent's.
    expect(started).toEqual(["agent 1", "agent 2", "monitor"]);
    expect(lane.queued).toBe(3);
    a.release(); await a.done; await tick();
    expect(started).toEqual(["agent 1", "agent 2", "monitor", "scrub"]);
    // The kept slot is the editor's alone: the agent's third waits for one of its own two.
    monitor.release(); await monitor.done; await tick();
    expect(started).toEqual(["agent 1", "agent 2", "monitor", "scrub"]);
    scrub.release(); await scrub.done; await tick();
    expect(started).toEqual(["agent 1", "agent 2", "monitor", "scrub", "agent 3"]);
    for (const job of [b, c, d]) { job.release(); await job.done; await tick(); }
    expect(started).toEqual(["agent 1", "agent 2", "monitor", "scrub", "agent 3", "agent 4"]);
    expect(lane.queued).toBe(0);
  });

  it("puts the timeline's stills ahead of the agent's, behind the editor's, without the editor's kept slot", async () => {
    const lane = new PictureLane(1);
    const started: string[] = [];
    const add = (name: string, priority: boolean | "timeline" = false) => {
      const g = gate();
      const done = lane.run(async () => { started.push(name); await g.opened; }, { priority });
      return { release: g.open, done };
    };
    const jobs = [add("agent 1"), add("agent 2"), add("still 1", "timeline"), add("still 2", "timeline"), add("scrub", true)];
    await tick();
    // The scrub takes the kept slot at once; the timeline's stills don't, but wait ahead of the agent's second.
    expect(started).toEqual(["agent 1", "scrub"]);
    const [agent1, agent2, still1, still2, scrub] = jobs;
    for (const job of [agent1!, scrub!, still1!, still2!, agent2!]) { job.release(); await job.done; await tick(); }
    expect(started).toEqual(["agent 1", "scrub", "still 1", "still 2", "agent 2"]);
    expect(framePriority("timeline")).toBe("timeline");
    expect(framePriority("interactive")).toBe(true);
    expect(framePriority(undefined)).toBe(false);
  });

  it("reads what nobody asked for behind everything that was", async () => {
    const lane = new PictureLane(1);
    const started: string[] = [];
    const add = (name: string, priority: boolean | "timeline" | "background" = false) => {
      const g = gate();
      const done = lane.run(async () => { started.push(name); await g.opened; }, { priority });
      return { release: g.open, done };
    };
    const jobs = [add("rest 1", "background"), add("rest 2", "background"), add("agent 1"), add("still", "timeline"), add("agent 2")];
    await tick();
    // The window being read keeps its turn: the next one waits for the agent's frames and the timeline's still.
    expect(started).toEqual(["rest 1"]);
    const [rest1, rest2, agent1, still, agent2] = jobs;
    for (const job of [rest1!, still!, agent1!, agent2!, rest2!]) { job.release(); await job.done; await tick(); }
    expect(started).toEqual(["rest 1", "still", "agent 1", "agent 2", "rest 2"]);
  });

  it("calls a machine busy once it has twice as much work as cores", () => {
    expect(machineBusy(0, 18)).toBe(false);
    expect(machineBusy(30, 18)).toBe(false);
    expect(machineBusy(100, 18)).toBe(true);
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

  it("sends the agent's frames to a Mac's media engine only while the editor looks at pictures", async () => {
    let now = 0;
    const lane = new PictureLane(2, 1, () => now);
    expect(lane.editorLooking()).toBe(false);
    expect(await frameDecoder("videotoolbox", false, lane)).toBeUndefined();
    const g = gate();
    const scrub = lane.run(() => g.opened, { priority: true });
    await tick();
    expect(lane.editorLooking()).toBe(true);
    // The agent's goes to VideoToolbox; the editor's own and the timeline's stay on the CPU, quickest for one frame.
    expect(await frameDecoder("videotoolbox", false, lane)).toBe("videotoolbox");
    expect(await frameDecoder("videotoolbox", true, lane)).toBeUndefined();
    expect(await frameDecoder("videotoolbox", "timeline", lane)).toBeUndefined();
    // Hardware decoding off, or an HDR file the CPU tone-maps, stays on the CPU.
    expect(await frameDecoder("none", false, lane)).toBeUndefined();
    expect(await frameDecoder("videotoolbox", false, lane, "pq")).toBeUndefined();
    // An NVIDIA GPU decodes every frame, as before.
    expect(await frameDecoder("nvenc", true, lane)).toBe("cuda");
    now = 10_000;
    g.open(); await scrub;
    now = 14_000;
    expect(lane.editorLooking()).toBe(true);
    now = 15_001;
    expect(lane.editorLooking()).toBe(false);
    expect(await frameDecoder("videotoolbox", false, lane)).toBeUndefined();
    // A failed or cancelled frame of the editor's still counts as looking.
    await expect(lane.run(async () => { throw new Error("decode failed"); }, { priority: true })).rejects.toThrow("decode failed");
    expect(lane.editorLooking()).toBe(true);
  });

  it("lets one of the agent's GPU decodes past the slots only while the editor looks, never into the editor's kept slot", async () => {
    let now = 0;
    const lane = new PictureLane(2, 1, () => now);
    const started: string[] = [];
    const add = (name: string, options: { priority?: boolean; gpu?: boolean } = {}) => {
      const g = gate();
      const done = lane.run(async () => { started.push(name); await g.opened; }, options);
      return { release: g.open, done };
    };
    const [agent1, agent2, agent3, cpu] = [add("agent 1", { gpu: true }), add("agent 2", { gpu: true }), add("agent 3", { gpu: true }), add("cpu")];
    await tick();
    // Nobody looking: the slots alone.
    expect(started).toEqual(["agent 1", "agent 2"]);
    const scrub = add("scrub", { priority: true });
    await tick();
    // The editor's frame takes its kept slot, and the waiting GPU decode goes past the slots; the CPU one waits.
    expect(started).toEqual(["agent 1", "agent 2", "scrub", "agent 3"]);
    const [agent4, agent5] = [add("agent 4", { gpu: true }), add("agent 5", { gpu: true })];
    await tick();
    // Only one past the slots.
    expect(started).toEqual(["agent 1", "agent 2", "scrub", "agent 3"]);
    // A second frame of the editor's still goes first when a slot frees.
    const scrub2 = add("scrub 2", { priority: true });
    agent1!.release(); await agent1!.done; await tick();
    expect(started.at(-1)).toBe("scrub 2");
    now = 1_000;
    scrub.release(); await scrub.done;
    scrub2.release(); await scrub2.done; await tick();
    expect(started.at(-1)).toBe("cpu");
    now = 7_000;
    // Looked away: the rest wait for slots of their own.
    agent3!.release(); await agent3!.done; await tick();
    expect(started).not.toContain("agent 4");
    agent2!.release(); await agent2!.done; await tick();
    cpu!.release(); await cpu!.done; await tick();
    expect(started.slice(-2)).toEqual(["agent 4", "agent 5"]);
    for (const job of [agent4!, agent5!]) { job.release(); await job.done; }
    expect(lane.queued).toBe(0);
  });
});
