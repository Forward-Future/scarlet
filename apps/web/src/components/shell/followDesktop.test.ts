import { expect, it, vi } from "vitest";
import { followDesktop } from "./followDesktop";

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

it("shows what the app holds once listening, then each report after", async () => {
  let report: (value: string) => void = () => {};
  const off = vi.fn();
  const shown: string[] = [];
  const stop = followDesktop<string>(async on => { report = on; return off; }, async () => "held", value => shown.push(value));
  await flush();
  report("next");
  expect(shown).toEqual(["held", "next"]);
  stop();
  await flush();
  report("after");
  expect(shown).toEqual(["held", "next"]);
  expect(off).toHaveBeenCalledTimes(1);
});

it("keeps a report that came before the read, and a read that answers nothing changes nothing", async () => {
  const shown: string[] = [];
  followDesktop<string>(async on => { on("first"); return () => {}; }, async () => "stale", value => shown.push(value));
  followDesktop<string>(async () => () => {}, async () => null, value => shown.push(value));
  await flush();
  expect(shown).toEqual(["first"]);
});

it("doesn't read once stopped before it was listening", async () => {
  const read = vi.fn(async () => "held");
  const off = vi.fn();
  const stop = followDesktop<string>(async () => off, read, () => {});
  stop();
  await flush();
  expect(read).not.toHaveBeenCalled();
  expect(off).toHaveBeenCalledTimes(1);
});
