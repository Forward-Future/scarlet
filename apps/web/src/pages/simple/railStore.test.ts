import { expect, it, vi } from "vitest";
import { RailStore } from "./railStore";

it("gives each request one place in each list, and tells its readers when a place arrives or goes", () => {
  const store = new RailStore();
  const heard = vi.fn();
  store.subscribe(heard);
  // The ref of a place is the same function each time, so React sets it once and a redraw of the column moves nothing.
  expect(store.ref("you", "a")).toBe(store.ref("you", "a"));
  expect(store.ref("you", "a")).not.toBe(store.ref("working", "a"));
  const place = {} as HTMLElement;
  store.ref("you", "a")(place);
  expect([store.host("you", "a"), store.host("working", "a"), heard.mock.calls.length]).toEqual([place, null, 1]);
  // Set again with the same element, nothing has changed.
  store.ref("you", "a")(place);
  expect(heard).toHaveBeenCalledTimes(1);
  store.ref("you", "a")(null);
  expect([store.host("you", "a"), heard.mock.calls.length]).toEqual([null, 2]);
});

it("adds up what every request has in a list, and says so only when a count changes", () => {
  const store = new RailStore();
  const heard = vi.fn();
  store.subscribe(heard);
  store.report("a", { you: 2, optional: 5, working: 1, done: 0 });
  store.report("b", { you: 1, optional: 0, working: 0, done: 4 });
  expect([store.total("you"), store.total("optional"), store.total("working"), store.total("done"), heard.mock.calls.length]).toEqual([3, 5, 1, 4, 2]);
  // The same counts with a new way to open its first row: the row to open is the latest, and nobody is told.
  const openFirst = vi.fn();
  store.report("a", { you: 2, optional: 5, working: 1, done: 0, openFirst });
  expect(heard).toHaveBeenCalledTimes(2);
  store.info("a")!.openFirst!();
  expect(openFirst).toHaveBeenCalledTimes(1);
  // A request that has left takes its rows out of every count.
  store.report("a");
  expect([store.total("you"), store.total("optional"), heard.mock.calls.length]).toEqual([1, 0, 3]);
  store.report("a");
  expect(heard).toHaveBeenCalledTimes(3);
});

it("assigns sequential rail-wide For you numbers after reserved pass numbers without colliding", () => {
  const store = new RailStore();
  store.setNumbering(["t2", "t1"], 3);
  store.report("t1", { you: 1, optional: 2, working: 0, done: 0, numberedKeys: ["c1/0"] });
  store.report("t2", { you: 2, optional: 1, working: 0, done: 0, numberedKeys: ["c2/0", "c2/1"] });
  // Latest thread t2 gets 4 and 5 after reserved 1..3; older thread t1 gets 6. Low-risk keys have no number.
  expect(store.numberOf("t2", "c2/0")).toBe(4);
  expect(store.numberOf("t2", "c2/1")).toBe(5);
  expect(store.numberOf("t1", "c1/0")).toBe(6);
  expect(store.numberOf("t1", "low-risk-key")).toBeUndefined();
});
