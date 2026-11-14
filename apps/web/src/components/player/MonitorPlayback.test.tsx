// @vitest-environment happy-dom
import { act, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { snapToFrame } from "@scarlet/timeline";
import { usePlayerStore } from "../../stores/player";
import { MonitorPlayback, PlayerTime } from "./MonitorPlayback";

let root: Root;
let container: HTMLDivElement;
const initial = usePlayerStore.getState();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  usePlayerStore.setState(initial, true);
  vi.unstubAllGlobals();
});

it("never reads past the end of the video, though an edit left the playhead beyond it", async () => {
  usePlayerStore.setState({ time: 5 });
  await act(async () => root.render(<PlayerTime end={16} coarse />));
  expect(container.textContent).toBe("0:05 / 0:16");
  // A cut lands that makes the video shorter than where the playhead was.
  usePlayerStore.setState({ time: 16 });
  await act(async () => root.render(<PlayerTime end={8} coarse />));
  expect(container.textContent).toBe("0:08 / 0:08");
  await act(async () => root.render(<PlayerTime end={8} />));
  expect(container.textContent).toBe("0:08.000 / 0:08.000");
  // A video whose length isn't known yet shows the time as it is.
  await act(async () => root.render(<PlayerTime end={0} coarse />));
  expect(container.textContent).toBe("0:16 / 0:00");
});

const typeInto = (field: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
});
const keyOn = (on: EventTarget, key: string, mods: KeyboardEventInit = {}) => act(() => {
  on.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }));
});
const jumpField = () => container.querySelector<HTMLInputElement>(".monitor-clock input");
const jumpButton = () => container.querySelector<HTMLButtonElement>(".monitor-jump");

async function showJump(opts: { playable?: boolean; active?: boolean; coarse?: boolean; end?: number; time?: number } = {}) {
  const onSeek = vi.fn();
  const playable = opts.playable ?? true;
  const end = opts.end ?? 16;
  if (opts.time !== undefined) usePlayerStore.setState({ time: opts.time });
  await act(() => root.render(
    <MonitorPlayback playing={false} playable={playable} onToggle={() => {}}>
      <PlayerTime end={end} coarse={opts.coarse} jump={{ fps: 30, playable, active: opts.active ?? true, onSeek }} />
    </MonitorPlayback>));
  return onSeek;
}

it("opens a jump field from G or a click on the clock, seeks the snapped time, and cancels without seeking", async () => {
  const onSeek = await showJump({ time: 1.042 });
  expect(jumpButton()?.disabled).toBe(false);
  expect(jumpButton()?.getAttribute("aria-label")).toBe("Jump to a time, 0:01.042 of 0:16.000");
  await keyOn(window, "g");
  expect(jumpField()?.value).toBe("0:01.042");
  await typeInto(jumpField()!, "0:05.600");
  await keyOn(jumpField()!, "Enter");
  expect(onSeek).toHaveBeenCalledExactlyOnceWith(snapToFrame(5.6, 30));
  expect(jumpField()).toBeNull();

  await act(() => jumpButton()!.click());
  expect(jumpField()?.value).toBe("0:01.042");
  await typeInto(jumpField()!, "1:23.042");
  await keyOn(jumpField()!, "g");
  expect(jumpField()).toBeNull();
  expect(onSeek).toHaveBeenCalledTimes(1);

  await keyOn(window, "g");
  await keyOn(window, "g");
  expect(jumpField()).toBeNull();
  await keyOn(window, "g");
  await keyOn(jumpField()!, "Escape");
  expect(jumpField()).toBeNull();
  expect(onSeek).toHaveBeenCalledTimes(1);

  await keyOn(window, "g");
  await act(() => jumpField()!.blur());
  expect(jumpField()).toBeNull();
  expect(onSeek).toHaveBeenCalledTimes(1);
});

it("shows an error for an empty, unparsable, or past-the-end time, and seeks once a valid clock is entered", async () => {
  const onSeek = await showJump();
  await keyOn(window, "g");
  await typeInto(jumpField()!, "0:20");
  await keyOn(jumpField()!, "Enter");
  expect(jumpField()).not.toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Enter a time between 0:00 and 0:16.000.");
  expect(onSeek).not.toHaveBeenCalled();
  for (const value of ["", "1:60", "nope", "-1"]) {
    await typeInto(jumpField()!, value);
    await keyOn(jumpField()!, "Enter");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Enter a time between 0:00 and 0:16.000.");
    expect(onSeek).not.toHaveBeenCalled();
  }
  await typeInto(jumpField()!, "5.6");
  await keyOn(jumpField()!, "Enter");
  expect(onSeek).toHaveBeenCalledExactlyOnceWith(snapToFrame(5.6, 30));
  expect(jumpField()).toBeNull();
});

it("does not open the jump field from G in a text box, when nothing is playable, or when this player is not the one on screen", async () => {
  const onSeek = await showJump();
  const box = document.body.appendChild(document.createElement("textarea"));
  box.focus();
  await keyOn(box, "g");
  expect(jumpField()).toBeNull();
  expect(onSeek).not.toHaveBeenCalled();
  box.remove();

  const editable = document.body.appendChild(document.createElement("div"));
  editable.contentEditable = "true";
  editable.focus();
  await keyOn(editable, "g");
  expect(jumpField()).toBeNull();
  expect(onSeek).not.toHaveBeenCalled();
  editable.remove();

  await showJump({ playable: false });
  expect(jumpButton()?.disabled).toBe(true);
  await keyOn(window, "g");
  expect(jumpField()).toBeNull();

  await showJump({ active: false });
  expect(jumpButton()).toBeNull();
  expect(container.querySelector(".monitor-clock")?.textContent).toMatch(/0:00/);
  await keyOn(window, "g");
  expect(jumpField()).toBeNull();
});

it("forgets a jump hidden by a change of view, so Escape is left to the page and the field does not return", async () => {
  await showJump();
  await keyOn(window, "g");
  expect(jumpField()).not.toBeNull();
  await showJump({ active: false });
  expect(jumpField()).toBeNull();
  await act(() => {
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
  await showJump({ active: true });
  expect(jumpField()).toBeNull();
  expect(jumpButton()).not.toBeNull();
  expect(document.activeElement).not.toBe(jumpButton());
});

it("ignores G with a modifier, in the page and in the field", async () => {
  const onSeek = await showJump();
  for (const mods of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }] as const) {
    await keyOn(window, "g", mods);
    expect(jumpField()).toBeNull();
  }
  expect(onSeek).not.toHaveBeenCalled();
  await keyOn(window, "g");
  expect(jumpField()).not.toBeNull();
  for (const mods of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }] as const) {
    await keyOn(jumpField()!, "g", mods);
    expect(jumpField()).not.toBeNull();
  }
  expect(onSeek).not.toHaveBeenCalled();
});

it("pre-fills the exact time when the clock is in whole seconds, and names the bound the way that clock reads", async () => {
  const onSeek = await showJump({ coarse: true, time: 1.042 });
  expect(jumpButton()?.textContent).toBe("0:01 / 0:16");
  expect(jumpButton()?.getAttribute("aria-label")).toBe("Jump to a time, 0:01 of 0:16");
  await keyOn(window, "g");
  expect(jumpField()?.value).toBe("0:01.042");
  await typeInto(jumpField()!, "0:20");
  await keyOn(jumpField()!, "Enter");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Enter a time between 0:00 and 0:16.");
  expect(onSeek).not.toHaveBeenCalled();
});

it("does not re-render a coarse jump clock while the playhead stays in the same second", async () => {
  let renders = 0;
  await act(() => root.render(
    <Profiler id="jump-clock" onRender={() => { renders++; }}>
      <PlayerTime end={16} coarse jump={{ fps: 30, playable: true, active: true, onSeek: vi.fn() }} />
    </Profiler>));
  usePlayerStore.setState({ time: 1.04 });
  await act(() => {});
  const afterSecond = renders;
  expect(container.textContent).toBe("0:01 / 0:16");
  for (const t of [1.2, 1.5, 1.9]) {
    usePlayerStore.setState({ time: t });
    await act(() => {});
  }
  expect(renders).toBe(afterSecond);
  expect(container.textContent).toBe("0:01 / 0:16");
  usePlayerStore.setState({ time: 2 });
  await act(() => {});
  expect(container.textContent).toBe("0:02 / 0:16");
  expect(renders).toBe(afterSecond + 1);
});
