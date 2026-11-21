import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { makeTimeMap, type Timeline } from "@scarlet/timeline";
import { useProjectStore } from "./project";
import { player } from "../lib/player";
import { usePlayerStore } from "./player";

/**
 * The working cut the window shows: its version and its timeline. While the video plays, a newer working cut waits.
 * A pass saves its cuts a batch at a time, a few every second, and each new version would put up a new player, a new
 * timeline with its stills and new marks: the video would stop and start again with every save. It is taken up once
 * playback stops. A player swapped while it plays stops for a moment and goes on, so a stop with no video attached
 * counts only after `SETTLE_MS`.
 *
 * Only what is shown waits. Anything sent to the engine goes by the project's own head.
 */
export interface ShownCut {
  projectId?: string;
  head: string | null;
  timeline: Timeline | null;
}

export const SETTLE_MS = 300;

function latest(): ShownCut {
  const cur = useProjectStore.getState().current;
  return { projectId: cur?.id, head: cur?.project.head ?? null, timeline: cur?.timeline ?? null };
}

export const useShownCutStore = create<ShownCut>(() => latest());

/**
 * The working cut the window caught up with when playback stopped, after holding back newer ones while it played:
 * `from` was on screen, `to` is. `frame` is the picture that was on screen as it stopped, held over the new player
 * until its own picture is in, so the change doesn't flash black. `id` tells one catch-up from the next.
 */
export interface CaughtUp { id: number; from: Timeline; to: Timeline; time: number; frame?: { canvas: HTMLCanvasElement; video: HTMLVideoElement } }
/** `waiting`: newer edits are saved and held back while the video plays. They come in when it stops. */
export const useCaughtUpStore = create<{ caughtUp?: CaughtUp; waiting?: boolean }>(() => ({}));

let settle: ReturnType<typeof setTimeout> | undefined;
/** Whether the player shows the working cut itself, with nothing open, so its playhead goes by the working cut's clock. */
let onWorkingCut = false;
/** Whether a newer working cut is waiting behind the one on screen. */
let heldBack = false;
let catchUps = 0;

/** The picture the video shows now, copied so it can stay up while the next player loads. */
function stillOf(video: HTMLVideoElement | undefined) {
  if (!video || video.readyState < 2 || !video.videoWidth) return;
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  try { canvas.getContext("2d")?.drawImage(video, 0, 0); } catch { return; }
  return { canvas, video };
}

function holds(shown: ShownCut, now: ShownCut) {
  if (!usePlayerStore.getState().playing || shown.projectId !== now.projectId) return false;
  // Only a whole working cut is held: one whose timeline has been read.
  return !!shown.head && shown.timeline?.version === shown.head;
}

function sync(force = false) {
  const shown = useShownCutStore.getState();
  const now = latest();
  if (now.projectId === shown.projectId && now.head === shown.head && now.timeline === shown.timeline) {
    // The working cut went back to the one on screen, as when an edit saved meanwhile was undone: nothing waits.
    heldBack = false;
    if (useCaughtUpStore.getState().waiting) useCaughtUpStore.setState({ waiting: false });
    return;
  }
  // The same working cut read again is taken up at once, as is anything while nothing whole is on screen.
  if (!force && holds(shown, now) && (now.head !== shown.head || now.timeline?.version !== shown.head)) {
    heldBack = true;
    if (!useCaughtUpStore.getState().waiting) useCaughtUpStore.setState({ waiting: true });
    return;
  }
  const caughtUp = heldBack && shown.projectId === now.projectId && shown.timeline && now.timeline && now.timeline.version !== shown.timeline.version
    ? { id: ++catchUps, from: shown.timeline, to: now.timeline, time: usePlayerStore.getState().time } : undefined;
  heldBack = false;
  if (useCaughtUpStore.getState().waiting) useCaughtUpStore.setState({ waiting: false });
  // Another project's catch-up isn't this one's.
  if (shown.projectId !== now.projectId && useCaughtUpStore.getState().caughtUp) useCaughtUpStore.setState({ caughtUp: undefined });
  if (caughtUp) {
    // With nothing open, the playhead stays on the footage it was on, wherever the edits since put it.
    const fps = useProjectStore.getState().current?.project.settings.fps ?? 30;
    const time = usePlayerStore.getState().time;
    const map = onWorkingCut ? makeTimeMap(caughtUp.from, caughtUp.to, fps) : undefined;
    const at = map ? map(time, "right") ?? map(time, "left") : null;
    if (at !== null && Math.abs(at - time) > 1e-6) usePlayerStore.getState().setTime(at);
    useCaughtUpStore.setState({ caughtUp: { ...caughtUp, time: usePlayerStore.getState().time, frame: stillOf(player.element() ?? undefined) } });
  }
  useShownCutStore.setState(now, true);
}

useProjectStore.subscribe(() => sync());
usePlayerStore.subscribe((now, was) => {
  if (now.playing === was.playing) return;
  clearTimeout(settle);
  settle = undefined;
  if (now.playing) return;
  // Paused, by the editor or at a listen's end, the newest working cut comes up at once. A player being swapped has
  // let go of its video and is about to take up the next.
  // After the player has read where its video stopped, which a pause does once it says it has stopped.
  if (player.element()) queueMicrotask(() => sync());
  else settle = setTimeout(() => { settle = undefined; sync(); }, SETTLE_MS);
});

/**
 * Takes up the newest working cut now, also while the video plays: it holds the open edit's own revision, which the
 * editor asked for and its card comes back on. Anything else that landed meanwhile comes up with it.
 */
export function takeUpLatest() {
  sync(true);
}

/** The player shows the working cut, with nothing open on it. */
export function showingWorkingCut(on: boolean) {
  onWorkingCut = on;
}

/** The held picture has been replaced by the new player's own. */
export function dropCaughtUpFrame(id: number) {
  const { caughtUp } = useCaughtUpStore.getState();
  if (caughtUp?.id === id && caughtUp.frame) useCaughtUpStore.setState({ caughtUp: { ...caughtUp, frame: undefined } });
}

/** The working cut on screen: the project's own, except while the video plays. */
export function useShownCut(): ShownCut {
  return useShownCutStore(useShallow(s => s));
}
