import { expect, it, vi } from "vitest";
import { JoinChecks } from "./join-checks.js";
import { json, noteUnmeasured, unmeasured, type ToolResult } from "./tool-result.js";

const body = (r: ToolResult) => JSON.parse((r.content[0] as { text: string }).text);

it("returns finished cuts in their original slots and delivers late measurement warnings on collection", async () => {
  const checks = new JoinChecks();
  let release!: () => void, runs = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const earlyRead = vi.fn(), lateRead = vi.fn();
  const ready = { status: "review", start: 3, end: 4, reason: "Repeated pickup", repeatAtJoin: { text: "hola" }, audio: [{ levels: [-20] }] };
  let finished!: () => void;
  const measured = new Promise<void>(resolve => { finished = resolve; });
  const run: Parameters<JoinChecks["collect"]>[3] = async publish => {
    runs++;
    publish(1, ready, earlyRead);
    await gate;
    noteUnmeasured("microphone", new Error("no samples"));
    publish(0, { status: "adjusted", audio: [{ words: ["hola"] }] }, lateRead);
    finished();
  };
  const poll = () => checks.collect("batch", "cut", 2, run, 5);
  expect(body(await poll())).toMatchObject({ status: "measuring", pendingCuts: [0],
    joins: [{ status: "pending" }, ready] });
  expect(earlyRead).toHaveBeenCalledTimes(1);
  release();
  await measured;
  expect(lateRead).not.toHaveBeenCalled();
  const missed = new Map<string, string>();
  const [a, b] = await unmeasured.run(missed, () => Promise.all([poll(), poll()]));
  expect(body(a)).toEqual(body(b));
  expect(body(a).joins[0].audio[0].words).toEqual(["hola"]);
  expect(lateRead).toHaveBeenCalledTimes(1);
  expect(earlyRead).toHaveBeenCalledTimes(1);
  expect(missed.get("microphone")).toContain("no samples");
  expect(runs).toBe(1);
  await poll();
  expect(runs).toBe(2);
});

it("delivers a failed background measurement and permits a fresh attempt", async () => {
  const checks = new JoinChecks();
  let fail!: (err: Error) => void;
  const work = new Promise<ToolResult>((_, reject) => { fail = reject; });
  const poll = () => checks.collect("single", "version", 1, () => work, 5);
  expect(body(await poll()).pendingCuts).toEqual([0]);
  fail(new Error("missing recording"));
  await expect(poll()).rejects.toThrow("missing recording");
  expect(body(await checks.collect("single", "version", 1, async () => json({ status: "adjusted" }), 5))).toEqual({ status: "adjusted" });
});

it("counts a finished single check only when its caller collects the evidence", async () => {
  const checks = new JoinChecks(), inspected = vi.fn();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reading = { status: "review", audio: [{ levels: [-12] }] };
  let finished!: () => void;
  const measured = new Promise<void>(resolve => { finished = resolve; });
  const poll = () => checks.collect("single", "v1", 1, async publish => {
    await gate;
    publish(0, reading, inspected);
    finished();
    return json(reading);
  }, 5);
  expect(body(await poll()).pendingCuts).toEqual([0]);
  release();
  await measured;
  expect(inspected).not.toHaveBeenCalled();
  expect(body(await poll())).toEqual(reading);
  expect(inspected).toHaveBeenCalledTimes(1);
});

it("does not count an inspection when its edge readings were left out of the response", async () => {
  const checks = new JoinChecks(), inspected = vi.fn();
  const result = await checks.collect("batch", "v1", 1, async publish => {
    publish(0, { status: "review", audio: ["a".repeat(45_000)] }, inspected);
  }, 5);
  expect(body(result)).toEqual({ version: "v1", joins: [{ status: "review" }], evidenceLeftOut: [0] });
  expect(inspected).not.toHaveBeenCalled();
});
