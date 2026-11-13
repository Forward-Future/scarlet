// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useUiStore } from "../../stores/ui";
import { ConnectionStatus } from "./StatusIndicators";

let root: Root;
let container: HTMLDivElement;
const initialUi = useUiStore.getState();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useUiStore.setState(initialUi, true);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("stays quiet through a short drop in the connection, then says in words what is wrong until it is back", async () => {
  vi.useFakeTimers();
  const ws = (wsStatus: "connecting" | "open" | "closed") => act(async () => useUiStore.setState({ wsStatus }));
  const after = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });
  const said = () => container.querySelector('[role="status"]')?.textContent;
  useUiStore.setState({ wsStatus: "connecting" });
  await act(async () => root.render(<ConnectionStatus />));
  // Connecting as the app starts is not news. It only is once it has taken 2.5 seconds.
  expect(said()).toBeUndefined();
  await after(2499);
  expect(said()).toBeUndefined();
  await after(1);
  expect(said()).toBe("Reconnecting to Scarlet…");
  // Giving up on the connection changes the words at once: the wait ran from when it dropped, and doesn't start again.
  await ws("closed");
  expect(said()).toBe("Offline: live updates paused");
  await ws("connecting");
  expect(said()).toBe("Reconnecting to Scarlet…");
  // Back, it says nothing, at once.
  await ws("open");
  expect(said()).toBeUndefined();
  // A drop that mends inside the wait is never shown, and the next drop gets a full wait of its own.
  await ws("closed");
  await after(2000);
  await ws("open");
  await after(1000);
  expect(said()).toBeUndefined();
  await ws("closed");
  await after(2499);
  expect(said()).toBeUndefined();
  await after(1);
  expect(said()).toBe("Offline: live updates paused");
  expect(container.querySelector('[role="status"]')?.getAttribute("title")).toContain("Your work is saved either way.");
});
