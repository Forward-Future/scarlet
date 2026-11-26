// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ScarletApiError } from "@scarlet/shared";
import { QueueInChat, queueRuns, runTag, useRewordingHold, type QueuedRequest } from "./QueueInChat";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const items: QueuedRequest[] = [
  { id: "q1", text: "Tighten the intro" },
  { id: "q2", text: "Add captions", target: "Revising the cut at 2:05" },
  { id: "q3", text: "Check the levels", fixed: true },
];
type Props = Parameters<typeof QueueInChat>[0];
const show = (props: Partial<Props> = {}) =>
  act(async () => root.render(<QueueInChat items={items} onRemove={() => {}} {...props} />));
const labelled = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
const markers = () => [...container.querySelectorAll(".queue-next")].map(m => m.textContent);

it("shows nothing with an empty queue and nothing to resume", async () => {
  await show({ items: [] });
  expect(container.innerHTML).toBe("");
});

it("lists each queued request with Up next for the first and Queued for the rest", async () => {
  await show({ hint: "Runs in order" });
  const group = container.querySelector('[role="group"]')!;
  expect(group.getAttribute("aria-label")).toBe("Queued requests");
  expect(group.getAttribute("title")).toBe("Runs in order");
  expect([...container.querySelectorAll(".queue-text")].map(t => t.textContent)).toEqual(["Tighten the intro", "Add captions", "Check the levels"]);
  expect(container.querySelector(".queue-target")?.textContent).toBe("Revising the cut at 2:05");
  expect(markers()).toEqual(["Up next", "Queued", "Queued"]);
  // Without onStart or onReword there is only the × on each.
  expect(container.querySelectorAll(".queue-start, .queue-reword")).toHaveLength(0);
  expect(container.querySelectorAll(".queue-remove")).toHaveLength(3);
  expect(container.querySelector(".queue-footer")).toBeNull();
});

it("says in amber what the first request waits for, and starts it early with the play mark", async () => {
  const onStart = vi.fn();
  await show({ waits: "Waits for your calls", onStart });
  expect(markers()).toEqual(["Waits for your calls", "Queued", "Queued"]);
  expect(container.querySelector(".queue-next.is-waiting")?.textContent).toBe("Waits for your calls");
  // Only the first has the play mark.
  expect(container.querySelectorAll(".queue-start")).toHaveLength(1);
  const start = labelled("Start now: Tighten the intro")!;
  expect(start.title).toBe("Start now, before your calls");
  await act(async () => start.click());
  expect(onStart).toHaveBeenCalledWith("q1");
});

it("hands a request's words to the box from its pencil or its words, but never a request Scarlet made", async () => {
  const onReword = vi.fn();
  const onRemove = vi.fn();
  await show({ onReword, onRemove });
  expect(labelled("Reword: Check the levels")).toBeNull();
  const fixedText = [...container.querySelectorAll<HTMLElement>(".queue-text")][2]!;
  expect(fixedText.classList.contains("is-rewordable")).toBe(false);
  await act(async () => fixedText.click());
  expect(onReword).not.toHaveBeenCalled();

  await act(async () => labelled("Reword: Add captions")!.click());
  expect(onReword).toHaveBeenLastCalledWith("q2");
  const words = container.querySelector<HTMLElement>(".queue-text.is-rewordable")!;
  await act(async () => words.click());
  expect(onReword).toHaveBeenLastCalledWith("q1");

  await act(async () => labelled("Remove from the queue: Check the levels")!.click());
  expect(onRemove).toHaveBeenCalledWith("q3");
});

it("marks the request being reworded, scrolls it into view, and hides its play mark", async () => {
  const onReword = vi.fn();
  const scroll = vi.fn();
  HTMLElement.prototype.scrollIntoView = scroll;
  try {
    await show({ onReword, onStart: () => {}, rewording: "q1" });
    const row = container.querySelector(".queue-row.is-rewording")!;
    expect(row.textContent).toContain("Tighten the intro");
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    expect(labelled("Start now: Tighten the intro")).toBeNull();
    const pencil = labelled("Reword: Tighten the intro")!;
    expect(pencil.getAttribute("aria-pressed")).toBe("true");
    expect(pencil.title).toBe("Leave as it was (Esc)");
    // Its words aren't a button while they're in the box.
    const words = row.querySelector<HTMLElement>(".queue-text")!;
    expect(words.classList.contains("is-rewordable")).toBe(false);
    await act(async () => words.click());
    expect(onReword).not.toHaveBeenCalled();
    expect(labelled("Reword: Add captions")!.title).toBe("Reword");
  } finally {
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  }
});

it("says Editing paused with no stand markers while paused, without a Resume to press", async () => {
  await show({ paused: true });
  expect(markers()).toEqual([]);
  expect(container.querySelector(".queue-paused")?.textContent).toBe("Editing paused");
  expect(container.querySelector(".queue-editing-action")).toBeNull();
});

it("offers Resume with an empty queue, and ignores presses while one is still resuming", async () => {
  let finish!: () => void;
  const onContinue = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  await show({ items: [], onContinue });
  expect(container.querySelector('[role="group"]')!.getAttribute("aria-label")).toBe("Project editing");
  const resume = container.querySelector<HTMLButtonElement>(".queue-editing-action")!;
  expect(resume.textContent).toBe("Resume");
  expect(resume.getAttribute("aria-disabled")).toBeNull();
  await act(async () => resume.click());
  expect(resume.getAttribute("aria-disabled")).toBe("true");
  await act(async () => resume.click());
  expect(onContinue).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  expect(resume.getAttribute("aria-disabled")).toBeNull();
  await act(async () => resume.click());
  expect(onContinue).toHaveBeenCalledTimes(2);
});

function Holder({ id, hold, onLost }: { id?: string; hold: (id: string, on: boolean) => Promise<void>; onLost: () => void }) {
  useRewordingHold(id, hold, onLost);
  return null;
}
const holdWith = (props: Parameters<typeof Holder>[0]) => act(async () => root.render(<Holder {...props} />));

it("holds a request while its words change, renews the hold, and lets it go after", async () => {
  vi.useFakeTimers();
  const hold = vi.fn(async () => {});
  const onLost = vi.fn();
  await holdWith({ hold, onLost });
  expect(hold).not.toHaveBeenCalled();
  await holdWith({ id: "q1", hold, onLost });
  expect(hold.mock.calls).toEqual([["q1", true]]);
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(hold.mock.calls).toEqual([["q1", true], ["q1", true]]);
  await holdWith({ hold, onLost });
  expect(hold.mock.calls.at(-1)).toEqual(["q1", false]);
  // Nothing renews it once let go.
  const calls = hold.mock.calls.length;
  await act(async () => vi.advanceTimersByTime(60_000));
  expect(hold).toHaveBeenCalledTimes(calls);
  expect(onLost).not.toHaveBeenCalled();
});

it("gives up the words when Scarlet began the request first", async () => {
  const hold = vi.fn(async () => { throw new ScarletApiError(409, "already_started", "Already started"); });
  const onLost = vi.fn();
  await holdWith({ id: "q1", hold, onLost });
  expect(onLost).toHaveBeenCalledTimes(1);
  // A request never held isn't let go.
  await holdWith({ hold, onLost });
  expect(hold.mock.calls).toEqual([["q1", true]]);
});

it("asks again shortly when a hold fails for another reason", async () => {
  vi.useFakeTimers();
  const hold = vi.fn<(id: string, on: boolean) => Promise<void>>()
    .mockRejectedValueOnce(new Error("engine restarting"))
    .mockResolvedValue(undefined);
  const onLost = vi.fn();
  await holdWith({ id: "q1", hold, onLost });
  expect(hold).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTime(3_000));
  expect(hold).toHaveBeenCalledTimes(2);
  expect(onLost).not.toHaveBeenCalled();
});

it("lets go at once of a hold that lands after the words closed", async () => {
  let land!: () => void;
  const hold = vi.fn((_id: string, on: boolean) => on ? new Promise<void>(resolve => { land = resolve; }) : Promise.reject(new Error("gone")));
  const onLost = vi.fn();
  await holdWith({ id: "q1", hold, onLost });
  await holdWith({ hold, onLost });
  // Not held yet, so nothing to release on close.
  expect(hold.mock.calls).toEqual([["q1", true]]);
  await act(async () => land());
  expect(hold.mock.calls).toEqual([["q1", true], ["q1", false]]);
});

it("ignores a failed hold that comes back after the words moved on", async () => {
  let fail!: (e: unknown) => void;
  const hold = vi.fn((id: string, on: boolean) => id === "q1" && on ? new Promise<void>((_, reject) => { fail = reject; }) : Promise.resolve());
  const onLost = vi.fn();
  await holdWith({ id: "q1", hold, onLost });
  await holdWith({ id: "q2", hold, onLost });
  await act(async () => fail(new ScarletApiError(409, "already_started", "Already started")));
  expect(onLost).not.toHaveBeenCalled();
});

it("uses the latest hold and onLost passed in without asking again", async () => {
  const first = vi.fn(async () => {});
  const second = vi.fn(async () => {});
  function Changing() {
    const [n, setN] = useState(0);
    useRewordingHold("q1", n ? second : first, () => {});
    return <button type="button" onClick={() => setN(1)}>swap</button>;
  }
  await act(async () => root.render(<Changing />));
  await act(async () => container.querySelector("button")!.click());
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).not.toHaveBeenCalled();
  await act(async () => root.render(<></>));
  expect(second).toHaveBeenCalledWith("q1", false);
});

const add = (id: string, time: string): QueuedRequest => ({ id, text: "Add it", target: `Edit at ${time}` });
const adds = ["8:53", "9:26", "11:12", "13:56", "14:06"].map((time, i) => add(`a${i}`, time));

it("gathers the same request asked in a row about different spots into one run", () => {
  const queue = [{ id: "m", text: "Add music" }, ...adds, { id: "z", text: "Tighten the end" }];
  expect(queueRuns(queue).map(r => r.run.map(i => i.id))).toEqual([["m"], adds.map(a => a.id), ["z"]]);
  expect(queueRuns(queue)[1]!.index).toBe(1);
});

it("keeps apart requests without a spot, with other words, the first when asked, and the one being reworded", () => {
  expect(queueRuns([{ id: "x", text: "Add it" }, { id: "y", text: "Add it" }]).length).toBe(2);
  expect(queueRuns([add("a", "0:01"), { ...add("b", "0:02"), text: "Cut it" }]).length).toBe(2);
  expect(queueRuns(adds, { keepFirst: true }).map(r => r.run.length)).toEqual([1, 4]);
  expect(queueRuns(adds, { apart: "a2" }).map(r => r.run.length)).toEqual([2, 1, 2]);
});

it("tags a run by its first spots' times and counts the rest", () => {
  expect(runTag(["Edit at 8:53", "Edit at 9:26"])).toBe("Edit at 8:53, 9:26");
  expect(runTag(adds.map(a => a.target!))).toBe("Edit at 8:53, 9:26 +3");
  expect(runTag(["Edit at 8:53", "Cut at 9:26", "Edit at 9:30"])).toBe("Edit at 8:53 +2");
});

it("shows a run as one bubble that opens to each request, and its × takes them all out", async () => {
  const onRemove = vi.fn();
  await show({ items: [{ id: "m", text: "Add music" }, ...adds], onRemove });
  expect(container.querySelectorAll(".queue-bubble").length).toBe(2);
  const open = container.querySelector<HTMLButtonElement>(".queue-batch-open")!;
  expect(open.textContent).toBe("Edit at 8:53, 9:26 +3");
  await act(async () => open.click());
  expect(container.querySelectorAll(".queue-bubble").length).toBe(6);
  await act(async () => container.querySelector<HTMLButtonElement>(".queue-batch-close")!.click());
  expect(container.querySelectorAll(".queue-bubble").length).toBe(2);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label^="Remove all 5"]')!.click());
  expect(onRemove.mock.calls.map(c => c[0])).toEqual(adds.map(a => a.id));
});

it("says a run is up next when it comes first", async () => {
  await show({ items: adds });
  expect(container.querySelectorAll(".queue-bubble").length).toBe(1);
  expect(markers()).toEqual(["Up next"]);
});
