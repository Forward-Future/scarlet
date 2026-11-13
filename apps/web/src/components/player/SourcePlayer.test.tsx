// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { player } from "../../lib/player";
import * as sourcePlayback from "../../lib/sourcePlayback";
import { usePlayerStore } from "../../stores/player";
import { SourcePlayer } from "./SourcePlayer";

type Options = Parameters<typeof sourcePlayback.openSourcePlayback>[1];
let root: Root;
let container: HTMLDivElement;
let opened: Options[];
const dispose = vi.fn();
const initial = usePlayerStore.getState();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  usePlayerStore.setState({ time: 42, rate: 1.25, playing: false });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  opened = [];
  dispose.mockClear();
  vi.spyOn(sourcePlayback, "openSourcePlayback").mockImplementation((_video, options) => {
    opened.push(options);
    return { prepare() {}, seek() {}, dispose } as unknown as ReturnType<typeof sourcePlayback.openSourcePlayback>;
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  usePlayerStore.setState(initial, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const show = (id = "med_a", autoPlay = false) => act(async () => root.render(<SourcePlayer id={id} name="Interview.mov" duration={600} autoPlay={autoPlay} hidden={false} />));
const says = (state: "ready" | "loading" | "failed") => act(async () => opened.at(-1)!.onState(state));
/** Whether the player marks its video as waiting for a section. The monitor's play button shows that, in place of its icon. */
const waiting = () => container.querySelector("video")!.hasAttribute("data-waiting");

it("says a section is being prepared, and offers to try again when one can't be", async () => {
  const play = vi.spyOn(player, "play").mockImplementation(() => {});
  await show();
  // It opens the clip where the editor was, at their speed.
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatchObject({ duration: 600, start: 42, rate: 1.25 });
  expect(container.querySelector("video")?.getAttribute("aria-label")).toBe("Interview.mov");
  expect([waiting(), container.querySelector("button")]).toEqual([false, null]);
  await says("loading");
  // It draws nothing of its own over the picture: the play button would cover it.
  expect([waiting(), container.querySelector('[role="status"], button')]).toEqual([true, null]);
  await says("failed");
  expect(waiting()).toBe(false);
  const retry = container.querySelector("button")!;
  expect(retry.textContent).toBe("Retry this section");
  // Trying again is pressing play: the playback asks for the section once more.
  await act(async () => retry.click());
  expect(play).toHaveBeenCalledTimes(1);
  await says("ready");
  expect([waiting(), container.querySelector("button")]).toEqual([false, null]);
});

it("plays a clip that was opened to play, and closes one playback before opening the next clip's", async () => {
  const play = vi.spyOn(player, "play").mockImplementation(() => {});
  const attach = vi.spyOn(player, "attach");
  await show("med_a", true);
  expect(play).toHaveBeenCalledTimes(1);
  expect(attach).toHaveBeenCalledTimes(1);
  await show("med_b", true);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(opened).toHaveLength(2);
  expect(play).toHaveBeenCalledTimes(2);
  // The same clip drawn again keeps its playback.
  await show("med_b", true);
  expect(opened).toHaveLength(2);
  await act(async () => root.render(null));
  expect(dispose).toHaveBeenCalledTimes(2);
});
