// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Render } from "@scarlet/shared";
import { buildDb, PRJ } from "./mock/fixtures";
import { renderCompletion } from "./renderCompletion";
import { useProjectStore, type ProjectData } from "../stores/project";

const initial = useProjectStore.getState();
let render: Render;
let listeners: () => number;

beforeEach(() => {
  vi.useFakeTimers();
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  render = { ...db.renders[0]!, id: "rnd_1", projectId: PRJ, state: "running" };
  const current: ProjectData = { id: PRJ, project, timeline: null, media: [], changes: [], notes: [], tasks: [], renders: [render], taskEvents: {} };
  useProjectStore.setState({ current });
  // How many are still watching the project: a finished wait must not keep watching.
  let watching = 0;
  const subscribe = useProjectStore.subscribe;
  vi.spyOn(useProjectStore, "subscribe").mockImplementation(listener => {
    watching++;
    const off = subscribe(listener);
    return () => { watching--; off(); };
  });
  listeners = () => watching;
});
afterEach(() => {
  useProjectStore.setState(initial, true);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const said = (state: Render["state"], extra: Partial<Render> = {}) => initial.applyEvent({ type: "render.updated", projectId: PRJ, render: { ...render, state, ...extra } });

it("hands over the render the moment the socket says it finished, failed or was cancelled", async () => {
  for (const state of ["done", "failed", "cancelled"] as const) {
    said("running");
    const waiting = renderCompletion(PRJ, "rnd_1", 750, new AbortController().signal);
    said("running", { progress: 0.5 });
    said(state, { id: "rnd_other" });
    said(state);
    await expect(waiting).resolves.toMatchObject({ id: "rnd_1", state });
    expect(listeners()).toBe(0);
  }
  // Already finished when asked: there is nothing to wait for.
  await expect(renderCompletion(PRJ, "rnd_1", 750, new AbortController().signal)).resolves.toMatchObject({ state: "cancelled" });
});

it("gives up after the wait it was given, so the caller can ask the engine itself", async () => {
  const waiting = renderCompletion(PRJ, "rnd_1", 750, new AbortController().signal);
  let answer: Render | undefined | "pending" = "pending";
  void waiting.then(found => { answer = found; });
  await vi.advanceTimersByTimeAsync(749);
  expect(answer).toBe("pending");
  await vi.advanceTimersByTimeAsync(1);
  expect(answer).toBeUndefined();
  expect(listeners()).toBe(0);
});

it("stops waiting at once when the export is cancelled, before or during the wait", async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(renderCompletion(PRJ, "rnd_1", 750, cancelled.signal)).resolves.toBeUndefined();
  expect(useProjectStore.subscribe).not.toHaveBeenCalled();
  const during = new AbortController();
  const waiting = renderCompletion(PRJ, "rnd_1", 750, during.signal);
  during.abort();
  await expect(waiting).resolves.toBeUndefined();
  expect(listeners()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("doesn't take another project's render for this one", async () => {
  const waiting = renderCompletion("prj_elsewhere", "rnd_1", 750, new AbortController().signal);
  said("done");
  let answer: Render | undefined | "pending" = "pending";
  void waiting.then(found => { answer = found; });
  await vi.advanceTimersByTimeAsync(100);
  expect(answer).toBe("pending");
  await vi.advanceTimersByTimeAsync(650);
  expect(answer).toBeUndefined();
});
