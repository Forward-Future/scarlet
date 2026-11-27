import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { AudioLane } from "./audioWork.js";
import { EditorFirst, editorFirst } from "./editorFirst.js";

function harness() {
  let time = 0;
  const calls: Array<[number, boolean]> = [];
  const first = new EditorFirst(async (pid, background) => { calls.push([pid, background]); }, () => time);
  return { first, calls, advance: (ms: number) => { time += ms; first.check(); } };
}

it("lowers background work only while the editor plays, and puts it back a moment after they stop", () => {
  const { first, calls, advance } = harness();
  const release = first.adopt(101, () => true);
  expect(calls).toEqual([]);

  first.touch();
  expect(calls).toEqual([[101, true]]);
  advance(9_000);
  expect(calls).toHaveLength(1);
  advance(2_000);
  expect(calls).toEqual([[101, true], [101, false]]);

  release();
  first.touch();
  expect(calls).toHaveLength(2);
});

it("keeps background work lowered for as long as the editor waits for a playback section", () => {
  const { first, calls, advance } = harness();
  first.adopt(7, () => true);
  const done = first.hold();
  advance(60_000);
  expect(calls).toEqual([[7, true]]);
  done();
  advance(11_000);
  expect(calls).toEqual([[7, true], [7, false]]);
});

it("lowers background work as soon as the editor starts waiting for a playback section, not at the next check", () => {
  const { first, calls } = harness();
  first.adopt(8, () => true);
  first.hold();
  expect(calls).toEqual([[8, true]]);
});

it("runs work at normal priority once someone waits for it, whatever the editor does", () => {
  const { first, calls, advance } = harness();
  let nobodyWaits = true;
  first.adopt(5, () => nobodyWaits);
  first.adopt(6, () => false);
  first.touch();
  expect(calls).toEqual([[5, true]]);
  nobodyWaits = false;
  advance(2_000);
  expect(calls).toEqual([[5, true], [5, false]]);
});

it("adopts the processes background work starts, and only those", async () => {
  const { first } = harness();
  const started = (background: boolean) => {
    // As the engine's `run` does: the process is adopted where it starts, inside the work that started it.
    const start = () => {
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"]);
      first.adoptChild(child);
      return child;
    };
    return background ? first.run(() => true, start) : start();
  };
  const plain = started(false);
  const quiet = started(true);
  expect(first.snapshot().map(entry => entry.pid)).toEqual([quiet.pid]);
  await new Promise(resolve => { quiet.once("exit", resolve); quiet.kill(); });
  plain.kill();
  expect(first.snapshot()).toEqual([]);
});

it("ranks a lane's turn as background only for a recording no pass is reading, and only while nothing a pass needs waits", async () => {
  const lane = new AudioLane();
  let mark: (() => boolean) | undefined;
  let finish!: () => void;
  const running = lane.run({ mediaId: "imported", kind: "transcript" }, undefined, () => {
    mark = editorFirst.current();
    return new Promise<void>(resolve => { finish = resolve; });
  });
  await Promise.resolve();
  expect(mark?.()).toBe(true);
  const release = lane.focus("read");
  const page = lane.run({ mediaId: "read", kind: "page" }, undefined, async () => editorFirst.current());
  expect(mark?.()).toBe(false);
  finish();
  await running;
  expect(await page).toBeUndefined();
  release();
});

it("tries again to put a process back to normal priority when the first try fails", async () => {
  let time = 0;
  const calls: Array<[number, boolean]> = [];
  let failNext = false;
  const first = new EditorFirst(async (pid, background) => {
    calls.push([pid, background]);
    if (failNext) { failNext = false; throw new Error("timed out"); }
  }, () => time);
  first.adopt(9, () => true);
  first.touch();
  await Promise.resolve();
  expect(first.snapshot()).toEqual([{ pid: 9, lowered: true }]);

  failNext = true;
  time += 11_000;
  first.check();
  expect(calls).toEqual([[9, true], [9, false]]);
  await new Promise(resolve => setImmediate(resolve));
  expect(first.snapshot()).toEqual([{ pid: 9, lowered: true }]);

  first.check();
  expect(calls).toEqual([[9, true], [9, false], [9, false]]);
  await new Promise(resolve => setImmediate(resolve));
  expect(first.snapshot()).toEqual([{ pid: 9, lowered: false }]);
});
