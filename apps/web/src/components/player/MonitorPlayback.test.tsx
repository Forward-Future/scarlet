// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePlayerStore } from "../../stores/player";
import { PlayerTime } from "./MonitorPlayback";

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
