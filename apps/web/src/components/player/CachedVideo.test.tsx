// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { player } from "../../lib/player";
import { usePlayerStore } from "../../stores/player";
import { CachedVideo } from "./CachedVideo";

let root: Root;
let container: HTMLDivElement;
const initial = usePlayerStore.getState();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  usePlayerStore.setState({ time: 0, playing: false, rate: 1 });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  usePlayerStore.setState(initial, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const show = (props: Partial<ComponentProps<typeof CachedVideo>> = {}) =>
  act(async () => root.render(<CachedVideo url="/renders/r1/file" label="The current edit" hidden={false} active autoPlay={false} {...props} />));
const video = () => container.querySelector("video")!;
/** The file's length is known: the element reports it and says so. */
const opens = (duration: number) => act(async () => {
  Object.defineProperty(video(), "duration", { configurable: true, value: duration });
  video().dispatchEvent(new Event("loadedmetadata"));
});
const retry = () => [...container.querySelectorAll("button")].find(b => b.textContent === "Retry cached video");

it("offers to load the saved file again when it can't be read, and does", async () => {
  await show();
  expect(retry()).toBeUndefined();
  await act(async () => { video().dispatchEvent(new Event("error")); });
  expect(retry()).toBeDefined();
  const load = vi.spyOn(video(), "load").mockImplementation(() => {});
  await act(async () => retry()!.click());
  expect(load).toHaveBeenCalledTimes(1);
  expect(retry()).toBeUndefined();
  // A second failure offers it again.
  await act(async () => { video().dispatchEvent(new Event("error")); });
  expect(retry()).toBeDefined();
});

it("opens where the editor was, at their speed, and carries on playing only if the video was", async () => {
  const play = vi.spyOn(player, "play").mockImplementation(() => {});
  usePlayerStore.setState({ time: 12.5, rate: 1.5, playing: false });
  await show();
  await opens(60);
  expect([video().currentTime, video().playbackRate]).toEqual([12.5, 1.5]);
  expect(play).not.toHaveBeenCalled();
  // A place past the end of this file opens at its end.
  usePlayerStore.setState({ time: 90 });
  await opens(60);
  expect(video().currentTime).toBe(60);
  // Taking over from a player that was playing, it plays on.
  await act(async () => root.render(null));
  usePlayerStore.setState({ time: 3, playing: true });
  await show();
  await opens(60);
  expect(play).toHaveBeenCalledTimes(1);
  // Once, not each time the file reports its length again.
  await opens(60);
  expect(play).toHaveBeenCalledTimes(1);
});

it("stays paused when the editor paused before the file opened, or while it is out of sight", async () => {
  const play = vi.spyOn(player, "play").mockImplementation(() => {});
  await show({ autoPlay: true });
  await act(async () => { video().dispatchEvent(new Event("pause")); });
  await opens(60);
  expect(play).not.toHaveBeenCalled();
  // Hidden behind another player, or in a workspace that isn't in front, it doesn't start by itself.
  for (const props of [{ hidden: true }, { active: false }]) {
    await act(async () => root.render(null));
    await show({ autoPlay: true, ...props });
    await opens(60);
  }
  expect(play).not.toHaveBeenCalled();
  await act(async () => root.render(null));
  await show({ autoPlay: true });
  await opens(60);
  expect(play).toHaveBeenCalledTimes(1);
});

/**
 * The video this player takes over from, attached to the transport. As in the window, a play or a pause shows on the
 * video at once and its event arrives afterwards: `heard` delivers the events still on their way.
 */
function videoBefore() {
  const el = document.createElement("video");
  document.body.append(el);
  let paused = true;
  const coming: string[] = [];
  vi.spyOn(el, "paused", "get").mockImplementation(() => paused);
  vi.spyOn(el, "play").mockImplementation(async () => { if (paused) { paused = false; coming.push("play"); } });
  vi.spyOn(el, "pause").mockImplementation(() => { if (!paused) { paused = true; coming.push("pause"); } });
  player.attach(el);
  return { el, heard: () => { for (const event of coming.splice(0)) el.dispatchEvent(new Event(event)); } };
}

it("stays paused when the editor paused just as it took over, before the video it replaces had said so", async () => {
  const play = vi.spyOn(player, "play").mockImplementation(() => {});
  const before = videoBefore();
  void before.el.play();
  before.heard();
  expect(usePlayerStore.getState().playing).toBe(true);
  // Esc on a card, the last call decided, Back to the video: the page pauses and brings this player up in one go.
  // The video is paused by then, though the store hasn't heard and still says playing.
  player.pause();
  expect([before.el.paused, usePlayerStore.getState().playing]).toEqual([true, true]);
  await show();
  await opens(60);
  expect(play).not.toHaveBeenCalled();
  before.el.remove();
});

it("plays on when it takes over from a video that is playing, also one paused and started again a moment before", async () => {
  const play = vi.spyOn(player, "play").mockImplementation(() => {});
  // A new working cut, or its saved file, arriving while the video plays: nothing paused it.
  let before = videoBefore();
  void before.el.play();
  before.heard();
  await show();
  await opens(60);
  expect(play).toHaveBeenCalledTimes(1);
  before.el.remove();
  // Paused and started again, as when the next call's listen starts: it is playing, whatever it has said so far.
  await act(async () => root.render(null));
  before = videoBefore();
  void before.el.play();
  before.heard();
  player.pause();
  void before.el.play();
  await show();
  await opens(60);
  expect(play).toHaveBeenCalledTimes(2);
  before.el.remove();
});

it("is the player's video while it is on the page, and toggles on a click", async () => {
  const attach = vi.spyOn(player, "attach"), detach = vi.spyOn(player, "detach"), toggle = vi.spyOn(player, "toggle").mockImplementation(() => {});
  await show();
  expect(attach.mock.calls[0]?.[0]).toBe(video());
  expect(video().getAttribute("aria-label")).toBe("The current edit");
  await act(async () => video().click());
  expect(toggle).toHaveBeenCalledTimes(1);
  await act(async () => container.querySelector<HTMLElement>(".video-surface")!.click());
  expect(toggle).toHaveBeenCalledTimes(2);
  detach.mockClear();
  await act(async () => root.render(null));
  expect(detach).toHaveBeenCalled();
});
