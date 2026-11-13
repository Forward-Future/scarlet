import { describe, expect, it } from "vitest";
import type { Change } from "@scarlet/timeline";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { activityWindows } from "./dialogue-review.js";
import { OPEN_BATCHES, PictureBatches, type PictureRequest } from "./picture-batches.js";
import { Lanes, ReviewInspections, type InspectionRequest } from "./review-prep.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const pass = { id: "pass", fromVersion: "v1", toVersion: "v2" } as Change;

describe("activityWindows", () => {
  it("covers a long removal with slightly overlapping windows under twelve seconds", () => {
    const windows = activityWindows(98.8, 131.2);
    expect(windows).toHaveLength(3);
    expect(windows[0]!.from).toBe(98.8);
    expect(windows.at(-1)!.to).toBe(131.2);
    for (const [i, w] of windows.entries()) {
      expect(w.to - w.from).toBeLessThan(12);
      if (i) expect(w.from).toBeLessThan(windows[i - 1]!.to);
    }
    expect(activityWindows(0, 12)).toHaveLength(2);
    expect(activityWindows(0, 5)).toEqual([{ from: 0, to: 5 }]);
  });
});

describe("PictureBatches", () => {
  const sheet = (request: PictureRequest) => ({ request, windows: [], result: { content: [{ type: "text", text: String(request.from) }] } as CallToolResult });

  it("returns every window in one call once they are ready, in the order they finished", async () => {
    const order: number[] = [];
    const batches = new PictureBatches(async request => {
      await new Promise(resolve => setTimeout(resolve, request.from === 0 ? 30 : 5));
      order.push(request.from);
      return sheet(request);
    });
    const id = batches.start([0, 1, 2, 3].map(from => ({ from, to: from + 1, count: 6, mode: "activity" }) as PictureRequest));
    const page = await batches.collect(id, 0);
    expect(page.items.map(i => i.index)).toEqual(order.map(from => from));
    expect(page.items).toHaveLength(4);
    expect(page.nextCursor).toBeNull();
    // A retry replays the same response.
    expect((await batches.collect(id, 0)).items).toEqual(page.items);
    batches.close();
  });

  it("returns what is ready at the wait and leaves the rest for its cursor", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const batches = new PictureBatches(async request => {
      if (request.from === 0) await gate;
      return sheet(request);
    }, { waitMs: 40 });
    const id = batches.start([0, 1, 2].map(from => ({ from, to: from + 1, count: 6, mode: "activity" }) as PictureRequest));
    const first = await batches.collect(id, 0);
    expect(first.items.map(i => i.index).sort()).toEqual([1, 2]);
    expect(first.nextCursor).toBe(2);
    release();
    const rest = await batches.collect(id, 2);
    expect(rest.items.map(i => i.index)).toEqual([0]);
    expect(rest.nextCursor).toBeNull();
    batches.close();
  });

  it("starts a new batch when earlier ones were never collected, stopping the one left alone longest", async () => {
    const stopped: number[] = [];
    const batches = new PictureBatches((request, signal) => new Promise((resolve, reject) => {
      if (request.from === 0) signal.addEventListener("abort", () => { stopped.push(request.to); reject(new Error("stopped")); });
      else resolve(sheet(request));
    }), { waitMs: 20 });
    const window = (from: number, to: number) => ({ from, to, count: 6, mode: "activity" }) as PictureRequest;
    // Each batch has a window that never finishes, so none is ever fully collected.
    const ids = Array.from({ length: OPEN_BATCHES }, (_, i) => i + 1).map(n => batches.start([window(0, n), window(5, n + 5)]));
    for (const id of ids.slice(1)) await batches.collect(id, 0);
    const fourth = batches.start([window(9, 10)]);
    expect((await batches.collect(fourth, 0)).items).toHaveLength(1);
    expect(stopped).toEqual([1]);
    await expect(batches.collect(ids[0]!, 0)).rejects.toThrow("Submit its windows again");
    expect((await batches.collect(ids[1]!, 1)).nextCursor).toBe(1);
    batches.close();
  });
});

describe("Lanes", () => {
  it("bounds concurrent work and gives a freed slot to the most urgent waiter, including one promoted while waiting", async () => {
    const lanes = new Lanes(1);
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let promoted = 0;
    const first = lanes.run(() => 1, async () => { started.push("first"); await gate; });
    const later = lanes.run(() => 0, async () => { started.push("later"); });
    const next = lanes.run(() => 1, async () => { started.push("next"); });
    const waitedOn = lanes.run(() => promoted, async () => { started.push("promoted"); });
    await tick();
    expect(started).toEqual(["first"]);
    promoted = 2;
    release();
    await Promise.all([first, later, next, waitedOn]);
    expect(started).toEqual(["first", "promoted", "next", "later"]);
  });
});

describe("ReviewInspections", () => {
  function setup(lookahead = 3) {
    const computed: string[] = [];
    const reviews = new ReviewInspections(async (_change, request: InspectionRequest, priority) => {
      computed.push(`${request.index}${request.wholePicture ? "w" : ""}${priority() === 2 ? "!" : ""}`);
      return { content: [{ type: "text", text: String(request.index) }], receipt: { complete: true, picture: [] }, wholeSheets: 0 };
    }, { lookahead, workers: 2 });
    return { reviews, computed };
  }
  const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

  it("prepares the next cuts ahead of the agent and hands each one over once", async () => {
    const { reviews, computed } = setup();
    reviews.ahead(pass, 0, 10);
    await settle();
    expect(computed).toEqual(["0", "1", "2"]);
    const request = { index: 1, audio: false, wholePicture: false };
    expect((await reviews.take(pass, request)).content).toEqual([{ type: "text", text: "1" }]);
    // Reaching index 2 moves the window along without preparing anything twice.
    reviews.ahead(pass, 2, 10);
    await settle();
    expect(computed).toEqual(["0", "1", "2", "3", "4"]);
    // Asking again inspects afresh.
    await reviews.take(pass, request);
    expect(computed.at(-1)).toBe("1!");
    reviews.close();
  });

  it("promotes a speculative inspection when the agent asks for it", async () => {
    let seen: (() => number) | undefined;
    let finish!: () => void;
    const reviews = new ReviewInspections(async (_change, _request, priority) => {
      seen = priority;
      await new Promise<void>(resolve => { finish = resolve; });
      return { content: [], receipt: { complete: true, picture: [] }, wholeSheets: 0 };
    });
    const request = { index: 2, audio: false, wholePicture: true };
    void reviews.prepare(pass, request, "later");
    expect(seen!()).toBe(0);
    const taken = reviews.take(pass, request);
    expect(seen!()).toBe(2);
    finish();
    await taken;
    reviews.close();
  });

  it("keeps preparation for a revised pass separate", async () => {
    const { reviews, computed } = setup(1);
    reviews.ahead(pass, 0, 3);
    reviews.ahead({ ...pass, toVersion: "v3" }, 0, 3);
    await settle();
    expect(computed).toEqual(["0", "0"]);
    await reviews.take({ ...pass, toVersion: "v3" }, { index: 0, audio: false, wholePicture: false });
    expect(computed).toEqual(["0", "0"]);
    reviews.close();
  });
});
