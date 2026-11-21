// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { buildDb, PRJ } from "../lib/mock/fixtures";
import { usePlayerStore } from "./player";
import { useProjectStore, type ProjectData } from "./project";
import { applyOps } from "@scarlet/timeline";
import { SETTLE_MS, showingWorkingCut, takeUpLatest, useCaughtUpStore, useShownCutStore } from "./shownCut";

const initialProject = useProjectStore.getState();
const initialPlayer = usePlayerStore.getState();
afterEach(() => {
  showingWorkingCut(false);
  useCaughtUpStore.setState({ caughtUp: undefined, waiting: false });
  useProjectStore.setState(initialProject, true);
  usePlayerStore.setState(initialPlayer, true);
  vi.useRealTimers();
});

function open() {
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  const timeline = db.timelines[project.head!]!;
  const current = { id: PRJ, project, timeline, media: project.media, changes: [], notes: [], tasks: [], renders: [], taskEvents: {} } as unknown as ProjectData;
  useProjectStore.setState({ current });
  return { project, timeline };
}

function save(version: string) {
  const cur = useProjectStore.getState().current!;
  useProjectStore.setState({ current: { ...cur, project: { ...cur.project, head: version } } });
  const moved = useProjectStore.getState().current!;
  useProjectStore.setState({ current: { ...moved, timeline: { ...moved.timeline!, version } } });
}

it("follows the working cut while the video is paused", () => {
  open();
  save("v2");
  expect(useShownCutStore.getState()).toMatchObject({ head: "v2", timeline: { version: "v2" } });
});

it("holds the working cut a pass saves while the video plays, and takes up the latest once it stops", () => {
  vi.useFakeTimers();
  const { project, timeline } = open();
  usePlayerStore.getState().setPlaying(true);
  for (const version of ["v2", "v3", "v4"]) save(version);
  expect(useShownCutStore.getState()).toMatchObject({ head: project.head, timeline });
  // A player swapped mid-listen stops for a moment and goes on: the cut on screen stays.
  usePlayerStore.getState().setPlaying(false);
  vi.advanceTimersByTime(SETTLE_MS / 2);
  usePlayerStore.getState().setPlaying(true);
  vi.advanceTimersByTime(SETTLE_MS * 2);
  expect(useShownCutStore.getState().head).toBe(project.head);
  usePlayerStore.getState().setPlaying(false);
  vi.advanceTimersByTime(SETTLE_MS);
  expect(useShownCutStore.getState()).toMatchObject({ head: "v4", timeline: { version: "v4" } });
});

it("takes up the latest working cut while the video plays when asked to, as for the open edit's own revision", () => {
  const { project } = open();
  usePlayerStore.getState().setPlaying(true);
  save("v2");
  expect(useShownCutStore.getState().head).toBe(project.head);
  takeUpLatest();
  expect(useShownCutStore.getState()).toMatchObject({ head: "v2", timeline: { version: "v2" } });
  expect(useCaughtUpStore.getState().waiting).toBe(false);
  // Later saves hold again while it plays.
  save("v3");
  expect(useShownCutStore.getState().head).toBe("v2");
});

it("doesn't hold a working cut whose timeline is still being read", () => {
  open();
  const cur = useProjectStore.getState().current!;
  useProjectStore.setState({ current: { ...cur, project: { ...cur.project, head: "v2" } } });
  usePlayerStore.getState().setPlaying(true);
  save("v3");
  expect(useShownCutStore.getState()).toMatchObject({ head: "v3", timeline: { version: "v3" } });
});

it("shows another project at once", () => {
  open();
  usePlayerStore.getState().setPlaying(true);
  useProjectStore.setState({ current: null });
  expect(useShownCutStore.getState()).toMatchObject({ projectId: undefined, head: null, timeline: null });
});

it("says what it caught up with once it stops, and keeps the playhead on the footage it was on", () => {
  vi.useFakeTimers();
  const { timeline } = open();
  showingWorkingCut(true);
  usePlayerStore.getState().setTime(20);
  usePlayerStore.getState().setPlaying(true);
  // A pass takes out two seconds before the playhead while the video plays.
  const cur = useProjectStore.getState().current!;
  const cut = { ...applyOps(timeline, [{ op: "rippleDelete" as const, start: 5, end: 7 }]), version: "v2" };
  useProjectStore.setState({ current: { ...cur, project: { ...cur.project, head: "v2" }, timeline: cut } });
  expect(useCaughtUpStore.getState()).toMatchObject({ caughtUp: undefined, waiting: true });
  usePlayerStore.getState().setPlaying(false);
  vi.advanceTimersByTime(SETTLE_MS);
  expect(useCaughtUpStore.getState()).toMatchObject({ caughtUp: { from: timeline, to: cut }, waiting: false });
  expect(usePlayerStore.getState().time).toBeCloseTo(18, 3);
});

it("says nothing of a working cut that came in while the video was paused", () => {
  open();
  save("v2");
  expect(useCaughtUpStore.getState().caughtUp).toBeUndefined();
  expect(useCaughtUpStore.getState().waiting).toBeFalsy();
});

it("stops saying edits are ready when the working cut goes back to the one on screen", () => {
  const { project, timeline } = open();
  usePlayerStore.getState().setPlaying(true);
  save("v2");
  expect(useCaughtUpStore.getState().waiting).toBe(true);
  const cur = useProjectStore.getState().current!;
  useProjectStore.setState({ current: { ...cur, project: { ...cur.project, head: project.head }, timeline } });
  expect(useCaughtUpStore.getState().waiting).toBe(false);
});
