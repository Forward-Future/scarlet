// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ActivityEntry } from "@scarlet/shared";
import { api } from "../../lib/client";
import { buildDb, PRJ } from "../../lib/mock/fixtures";
import { useProjectStore } from "../../stores/project";
import { HistoryLog } from "./HistoryLog";

let root: Root;
let container: HTMLDivElement;
const initialStore = useProjectStore.getState();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  useProjectStore.setState({ status: "ready", current: {
    id: PRJ, project, timeline: db.timelines[project.head!]!, media: project.media, changes: db.changes, notes: db.notes,
    renders: [], tasks: db.tasks, taskEvents: db.taskEvents,
  } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useProjectStore.setState(initialStore, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const click = (element: Element) => act(async () => (element as HTMLElement).click());
const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === text);
const entries = () => container.querySelectorAll("section li").length;

/** A full page of the log: 200 entries, so the engine may hold older ones. */
const page = (from: number): ActivityEntry[] => Array.from({ length: 200 }, (_, i) => ({
  id: `act_${from + i}`, projectId: PRJ, actor: { type: "scarlet" as const, name: "Scarlet" }, type: "change.approved",
  summary: `Entry ${from + i}`, data: {}, createdAt: new Date(Date.now() - (from + i) * 1000).toISOString(),
}));

it("retries a history that didn't load, and keeps the loaded entries when an older page fails", async () => {
  const read = vi.spyOn(api, "activity").mockRejectedValueOnce(new Error("The engine is restarting"));
  await act(async () => root.render(<HistoryLog />));
  expect(container.textContent).toContain("Couldn’t load the history: The engine is restarting");
  // Retry asks again, and the log arrives.
  read.mockResolvedValueOnce({ activity: page(0) });
  await click(button("Retry")!);
  expect(read).toHaveBeenCalledTimes(2);
  expect(entries()).toBe(200);
  expect(container.textContent).not.toContain("Couldn’t load");

  // An older page fails: the log stays, and the reason sits beside Show older, which asks again.
  read.mockRejectedValueOnce(new Error("Lost the connection"));
  await click(button("Show older")!);
  expect(entries()).toBe(200);
  expect(button("Show older")!.parentElement!.textContent).toContain("Couldn’t load older history: Lost the connection");
  read.mockResolvedValueOnce({ activity: page(200).slice(0, 50) });
  await click(button("Show older")!);
  expect(read).toHaveBeenLastCalledWith(PRJ, expect.objectContaining({ beforeId: "act_199" }));
  expect(entries()).toBe(250);
  expect(container.textContent).not.toContain("Couldn’t load");
  // That page was the last one.
  expect(button("Show older")).toBeUndefined();
});

it("keeps every entry's words one colour, with a small mark before the ones approved, put back or gone wrong", async () => {
  const entry = (id: string, type: string, summary: string): ActivityEntry => ({ id, projectId: PRJ, actor: { type: "scarlet", name: "Scarlet" }, type, summary, data: {},
    createdAt: new Date().toISOString() });
  vi.spyOn(api, "activity").mockResolvedValue({ activity: [
    entry("a", "request.failed", "Claude Code couldn’t finish “Add captions”"), entry("b", "change.undone", "Undo · Zoom in"),
    entry("c", "change.approved", "Matt approved “Zoom in”"), entry("d", "request.created", "Matt asked Claude Code: “Zoom in”"),
    entry("e", "change.rejected", "Matt rejected “Open on the hook”"),
  ] });
  await act(async () => root.render(<HistoryLog />));
  const lines = [...container.querySelectorAll("section li")].map(li => li.querySelector(".min-w-0 > div")!);
  // No line is green, amber, red or dimmed.
  expect(lines.map(line => line.className.split(" ").filter(name => name.startsWith("text-") && !name.startsWith("text-["))))
    .toEqual(Array.from({ length: 5 }, () => ["text-fg"]));
  expect(lines.map(line => line.querySelector(".history-mark")?.className.replace("history-mark ", "") ?? null)).toEqual(["bg-bad", "bg-warn", "bg-ok", null, null]);
  // The mark is not part of what the line says.
  expect(lines[0]!.textContent).toBe("Claude Code couldn’t finish “Add captions”");
  expect(lines[0]!.querySelector(".history-mark")!.getAttribute("aria-hidden")).toBe("true");
});
