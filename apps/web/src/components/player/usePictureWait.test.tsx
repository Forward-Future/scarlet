// @vitest-environment happy-dom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MonitorPlayback } from "./MonitorPlayback";
import { usePictureWait } from "./usePictureWait";

let root: Root;
let container: HTMLDivElement;

/** A monitor with its play button, which shows what the monitor is waiting for. `marked`: the player says it is preparing a section. */
function Monitor({ hidden = false, second = false, marked = false }: { hidden?: boolean; second?: boolean; marked?: boolean }) {
  const monitor = useRef<HTMLDivElement>(null);
  const loading = usePictureWait(monitor);
  return <div ref={monitor}>
    <div hidden={hidden}><video id="main" data-waiting={marked || undefined} /></div>
    {second && <video id="other" />}
    <MonitorPlayback playing={false} playable loading={loading} onToggle={() => {}} />
  </div>;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const show = (props: { hidden?: boolean; second?: boolean; marked?: boolean } = {}) => act(async () => root.render(<Monitor {...props} />));
const video = (id = "main") => container.querySelector<HTMLVideoElement>(`#${id}`)!;
/** A media event on a video, with the video still short of a frame to show unless `ready`. */
const fire = (name: string, id = "main", ready = false) => act(async () => {
  Object.defineProperty(video(id), "readyState", { configurable: true, value: ready ? 4 : 1 });
  video(id).dispatchEvent(new Event(name));
});
const after = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });
const said = () => container.querySelector('.monitor-playback > [role="status"]')?.textContent;
/** What the play button holds: its icon, or the spinner that takes the icon's place. */
const button = () => { const play = container.querySelector(".monitor-playback > button")!; return [play.getAttribute("aria-label"), play.querySelector("svg") ? "icon" : play.querySelector(".animate-spin") ? "spinner" : "empty"]; };

it("turns the play button once a seek has taken longer than a blink, and stops when the frame is in", async () => {
  await show();
  expect(button()).toEqual(["Play", "icon"]);
  await fire("seeking");
  await after(179);
  expect([said(), ...button()]).toEqual([undefined, "Play", "icon"]);
  await after(1);
  // The spinner is in the play button, in place of its icon: nothing is drawn over the picture, where the button would cover it.
  expect([said(), ...button()]).toEqual(["Loading this moment…", "Play", "spinner"]);
  expect([...container.querySelectorAll('[role="status"]')].every(status => status.closest(".monitor-playback"))).toBe(true);
  await fire("seeked");
  expect([said(), ...button()]).toEqual([undefined, "Play", "icon"]);
  // A seek that lands inside the wait is never mentioned.
  await fire("waiting");
  await after(100);
  await fire("canplay");
  await after(500);
  expect(said()).toBeUndefined();
  // One whose frame is already there when the wait runs out isn't either.
  await fire("seeking");
  Object.defineProperty(video(), "readyState", { configurable: true, value: 4 });
  await after(180);
  expect(said()).toBeUndefined();
});

it("follows the video that is on screen: not one that is hidden, and not another video's events", async () => {
  await show({ second: true });
  await fire("waiting");
  await after(180);
  expect(said()).toBe("Loading this moment…");
  // Another video finishing a seek of its own doesn't clear this one's wait.
  await fire("seeked", "other", true);
  expect(said()).toBe("Loading this moment…");
  // The waiting video goes out of sight: there is nothing on screen to wait for.
  await show({ second: true, hidden: true });
  await act(async () => {});
  expect(said()).toBeUndefined();
  // A hidden video's seeks are never shown.
  await fire("seeking");
  await after(180);
  expect(said()).toBeUndefined();
});

it("turns the play button while a player says it is preparing a section, once that has lasted longer than a blink", async () => {
  await show();
  await show({ marked: true });
  await act(async () => {});
  await after(179);
  expect(button()).toEqual(["Play", "icon"]);
  await after(1);
  expect([said(), ...button()]).toEqual(["Loading this moment…", "Play", "spinner"]);
  // Media events don't end it: the player says when its section is in.
  await fire("playing");
  expect(button()).toEqual(["Play", "spinner"]);
  await show();
  await act(async () => {});
  expect([said(), ...button()]).toEqual([undefined, "Play", "icon"]);
  // A section that comes in within the blink is never shown, and neither is one a hidden player prepares.
  await show({ marked: true });
  await act(async () => {});
  await after(100);
  await show();
  await act(async () => {});
  await after(500);
  expect(button()).toEqual(["Play", "icon"]);
  await show({ marked: true, hidden: true });
  await act(async () => {});
  await after(500);
  expect(button()).toEqual(["Play", "icon"]);
  // A player already preparing when the monitor goes up counts from then.
  await act(async () => root.render(null));
  await show({ marked: true });
  await after(180);
  expect(button()).toEqual(["Play", "spinner"]);
});
