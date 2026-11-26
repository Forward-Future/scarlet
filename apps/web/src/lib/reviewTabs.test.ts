import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { inListOrder, LINGER_FADE_MS, LINGER_MS, ReviewLinger, reviewStops, rowAfter, rowBeside, rowNext, rowPlace, rowsOfTab, stopsShown, tabShown, type RowPlace } from "./reviewTabs";

const is = { waits: (e: string) => e === "waits", sent: (e: string) => e === "sent", kept: (e: string) => e === "kept" };
const row = (key: string, place: RowPlace, at: number, num?: number) => ({ key, place, at, num });
const keys = (rows: readonly { key: string }[]) => rows.map(r => r.key);

it("puts every row under exactly one tab: waiting, then with Scarlet, then decided, else optional", () => {
  expect(rowPlace(["waits"], is)).toBe("you");
  expect(rowPlace(["sent"], is)).toBe("working");
  expect(rowPlace(["kept"], is)).toBe("done");
  expect(rowPlace(["plain"], is)).toBe("optional");
  // A row of several edits waits while any of them does, is with Scarlet while any is, and is decided once all are.
  expect(rowPlace(["kept", "sent", "waits"], is)).toBe("you");
  expect(rowPlace(["kept", "sent"], is)).toBe("working");
  expect(rowPlace(["kept", "plain"], is)).toBe("optional");
  expect(rowPlace(["kept", "kept"], is)).toBe("done");
});

it("shows Needs review until Working or Done is pressed, low risk edits included or not", () => {
  expect([undefined, "need", "all", "working", "done"].map(tabShown)).toEqual(["you", "you", "you", "working", "done"]);
});

it("lists a tab's rows top to bottom: Needs review's waiting rows, with the low risk ones in their place among them while included", () => {
  const rows = [row("a", "optional", 1), row("b", "you", 2), row("c", "working", 3), row("d", "done", 4), row("e", "you", 5), row("f", "optional", 6)];
  expect(keys(rowsOfTab(rows, "you", false, undefined))).toEqual(["b", "e"]);
  expect(keys(rowsOfTab(rows, "you", true, undefined))).toEqual(["a", "b", "e", "f"]);
  expect(keys(rowsOfTab(rows, "working", true, undefined))).toEqual(["c"]);
  expect(keys(rowsOfTab(rows, "done", false, undefined))).toEqual(["d"]);
});

it("orders a pass's list by number while every row has one, else by time, and leaves any other list as given", () => {
  const numbered = [row("cut 3", "you", 6, 3), row("edit 2", "you", 15, 2), row("cut 1", "you", 12, 1)];
  expect(keys(inListOrder(numbered, { numbers: true }))).toEqual(["cut 1", "edit 2", "cut 3"]);
  expect(keys(inListOrder(numbered, { numbers: false }))).toEqual(["cut 3", "cut 1", "edit 2"]);
  expect(keys(inListOrder([...numbered, row("plain", "you", 1)], { numbers: true }))).toEqual(["plain", "cut 3", "cut 1", "edit 2"]);
  expect(keys(inListOrder(numbered, undefined))).toEqual(["cut 3", "edit 2", "cut 1"]);
});

it("steps ↑ and ↓ a row at a time, and from a row that has left the list to the one after or before where it was", () => {
  const list = [row("a", "you", 1), row("b", "you", 5), row("c", "you", 9)];
  expect([rowBeside(list, list[1], list[1]!, 1, undefined)?.key, rowBeside(list, list[1], list[1]!, -1, undefined)?.key]).toEqual(["c", "a"]);
  expect([rowBeside(list, list[2], list[2]!, 1, undefined), rowBeside(list, list[0], list[0]!, -1, undefined)]).toEqual([undefined, undefined]);
  // One that isn't a row of the list, at 0:06: ↓ reaches the row after it and ↑ the one before.
  const gone = row("gone", "done", 6);
  expect([rowBeside(list, gone, gone, 1, undefined)?.key, rowBeside(list, gone, gone, -1, undefined)?.key]).toEqual(["c", "b"]);
  // In a list that goes by numbers it is placed by its number, wherever it is in the video.
  const byNumber = [row("cut 1", "you", 12, 1), row("cut 3", "you", 6, 3)];
  const two = row("edit 2", "working", 1, 2);
  expect([rowBeside(byNumber, two, two, 1, { numbers: true })?.key, rowBeside(byNumber, two, two, -1, { numbers: true })?.key]).toEqual(["cut 3", "cut 1"]);
});

it("moves Keep on to the next row that waits, wrapping to the earlier ones, and closes once nothing is left", () => {
  const list = [row("a", "you", 1), row("b", "you", 5), row("c", "you", 9)];
  expect(rowAfter(list, list[0], list[0]!, undefined)?.key).toBe("b");
  expect(rowAfter(list, list[2], list[2]!, undefined)?.key).toBe("a");
  expect(rowAfter([list[0]!], list[0], list[0]!, undefined)).toBeUndefined();
  // Without wrapping, rowNext steps down the list and stops at its end.
  expect(rowNext(list, list[0], list[0]!, undefined)?.key).toBe("b");
  expect(rowNext(list, list[2], list[2]!, undefined)).toBeUndefined();
  // The row just kept is no longer among the ones that wait: Keep goes to the one after where it was, or wraps.
  const kept = row("kept", "done", 6);
  expect(rowAfter(list, kept, kept, undefined)?.key).toBe("c");
  expect(rowNext(list, kept, kept, undefined)?.key).toBe("c");
  const last = row("last", "done", 20);
  expect(rowAfter(list, last, last, undefined)?.key).toBe("a");
  expect(rowNext(list, last, last, undefined)).toBeUndefined();
  expect(rowAfter([], kept, kept, undefined)).toBeUndefined();
});

it("builds a request's stops from its rows, its calls and what was rejected, and steps past the rejected", () => {
  const edit = (at: number) => ({ at, range: { start: at } });
  const first = [edit(1)], moment = [edit(4), edit(2)];
  const stops = reviewStops({ rows: [first, moment], place: r => r === first ? "you" : "optional", num: e => e.at === 1 ? 7 : undefined,
    calls: [{ call: "cut 1", at: 3, num: 1, place: "you" }], gone: [{ at: 0 }] });
  // A moment stands at its first edit's time and has no number of its own.
  expect(stops.map(s => [s.place, s.at, s.num])).toEqual([["you", 1, 7], ["optional", 2, undefined], ["you", 3, 1], ["done", 0, undefined]]);
  expect(stopsShown(stops, undefined, { numbers: false }).map(s => s.call ?? s.row)).toEqual([first, "cut 1"]);
  expect(stopsShown(stops, "all", { numbers: false }).map(s => s.call ?? s.row)).toEqual([first, moment, "cut 1"]);
  // Done holds only the rejected edit, which is no stop.
  expect(stopsShown(stops, "done", { numbers: false })).toEqual([]);
});

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it("holds a row that has just left Needs review for a moment, fades it, then lets it go", () => {
  const linger = new ReviewLinger();
  const changed = vi.fn();
  linger.subscribe(changed);
  linger.track([{ key: "a", place: "you" }, { key: "b", place: "optional" }, { key: "c", place: "working" }], false);
  expect([linger.of("a"), linger.of("c")]).toEqual([undefined, undefined]);
  // Kept: it is Done's at once, and stays where it was. One that was optional with its line closed was never on screen.
  linger.track([{ key: "a", place: "done" }, { key: "b", place: "done" }, { key: "c", place: "working" }], false);
  expect([linger.of("a"), linger.of("b")]).toEqual([expect.objectContaining({ from: "you", leaving: false }), undefined]);
  vi.advanceTimersByTime(LINGER_MS);
  expect([linger.of("a")?.leaving, changed.mock.calls.length]).toEqual([true, 1]);
  vi.advanceTimersByTime(LINGER_FADE_MS);
  expect([linger.of("a"), changed.mock.calls.length]).toEqual([undefined, 2]);
  linger.dispose();
});

it("carries a held row over to the row that took its place, and drops it when it waits again", () => {
  const linger = new ReviewLinger();
  linger.track([{ key: "v1", place: "you" }], false);
  linger.track([{ key: "v1", place: "working" }], false);
  expect(linger.of("v1")?.from).toBe("you");
  // The edit is rejected: a new row stands for the old.
  linger.track([{ key: "gone", place: "done", was: ["v1"] }], false);
  expect([linger.of("v1"), linger.of("gone")?.from]).toEqual([undefined, "you"]);
  // ⌘Z brings it back to wait: it is simply Needs review's again.
  linger.track([{ key: "v1", place: "you", was: [] }], false);
  linger.track([{ key: "v1", place: "you" }], false);
  expect(linger.of("v1")).toBeUndefined();
  // With the optional line open, an optional row kept is held there too.
  linger.track([{ key: "o", place: "optional" }], true);
  linger.track([{ key: "o", place: "done" }], true);
  expect(linger.of("o")?.from).toBe("optional");
  linger.dispose();
});

it("holds a row moving from Done (or a just-kept row lingering in Needs review) to Working, then fades and releases it", () => {
  const linger = new ReviewLinger();
  const changed = vi.fn();
  linger.subscribe(changed);
  // While Done is shown, a row moving from Done to Working stays in Done, shows working, then fades out.
  linger.track([{ key: "a", place: "done" }, { key: "b", place: "done" }], false, true);
  linger.track([{ key: "a", place: "working", busy: true }, { key: "b", place: "done" }], false, true);
  expect(linger.of("a")).toEqual(expect.objectContaining({ from: "done", leaving: false }));
  vi.advanceTimersByTime(LINGER_MS);
  expect([linger.of("a")?.leaving, changed.mock.calls.length]).toEqual([true, 1]);
  vi.advanceTimersByTime(LINGER_FADE_MS);
  expect([linger.of("a"), changed.mock.calls.length]).toEqual([undefined, 2]);
  // If Done is not shown and the row is not lingering in Needs review, moving Done -> Working does not linger.
  linger.track([{ key: "b", place: "working", busy: true }], false, false);
  expect(linger.of("b")).toBeUndefined();
  // A row just kept in Needs review that moves to Working before leaving stays in Needs review with a fresh timer (cancelling any fade).
  linger.track([{ key: "c", place: "you" }], false, false);
  linger.track([{ key: "c", place: "done" }], false, false);
  vi.advanceTimersByTime(LINGER_MS);
  expect(linger.of("c")).toEqual(expect.objectContaining({ from: "you", leaving: true }));
  linger.track([{ key: "c", place: "working", busy: true }], false, false);
  expect(linger.of("c")).toEqual(expect.objectContaining({ from: "you", leaving: false }));
  vi.advanceTimersByTime(LINGER_MS - 1);
  expect(linger.of("c")).toEqual(expect.objectContaining({ from: "you", leaving: false }));
  vi.advanceTimersByTime(1);
  expect(linger.of("c")?.leaving).toBe(true);
  vi.advanceTimersByTime(LINGER_FADE_MS);
  expect(linger.of("c")).toBeUndefined();
  // A row kept in Needs review and then revised from Done replaces the stale Needs review hold with a Done hold.
  linger.track([{ key: "d", place: "you" }], false, false);
  linger.track([{ key: "d", place: "done" }], false, false);
  expect(linger.of("d")?.from).toBe("you");
  linger.track([{ key: "d", place: "working", busy: true }], false, true);
  expect(linger.of("d")).toEqual(expect.objectContaining({ from: "done", leaving: false }));
  // Returning to Done drops a Done hold immediately so it does not fade out.
  linger.track([{ key: "d", place: "done" }], false, true);
  expect(linger.of("d")).toBeUndefined();
  // Moving from queued (busy: false) to actively working (busy: true) while held refreshes the linger window once.
  linger.track([{ key: "e", place: "done" }], false, true);
  linger.track([{ key: "e", place: "working", busy: false }], false, true);
  vi.advanceTimersByTime(1500);
  linger.track([{ key: "e", place: "working", busy: true }], false, true);
  vi.advanceTimersByTime(1500);
  expect(linger.of("e")).toEqual(expect.objectContaining({ from: "done", leaving: false }));
  vi.advanceTimersByTime(LINGER_MS - 1500);
  expect(linger.of("e")?.leaving).toBe(true);
  vi.advanceTimersByTime(LINGER_FADE_MS);
  expect(linger.of("e")).toBeUndefined();
  linger.dispose();
});
