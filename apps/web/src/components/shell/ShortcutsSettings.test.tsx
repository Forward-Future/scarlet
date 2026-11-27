// @vitest-environment happy-dom
import { selectOption } from "../../../test/selectOption";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsPage } from "../../pages/SettingsPage";
import { PlaybackSpeed } from "../../pages/watch/PlaybackSpeed";
import { ReviewActions } from "../review/ReviewActions";
import { resetShortcutsStore, useShortcutsStore } from "../../stores/shortcuts";
import { useUiStore } from "../../stores/ui";
import { ShortcutsModal } from "./ShortcutsModal";

let el: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  resetShortcutsStore();
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});

afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  localStorage.clear();
  resetShortcutsStore();
  useUiStore.setState(useUiStore.getInitialState());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const mount = (path = "/settings#shortcuts") => act(async () => root.render(
  <RouterProvider router={createMemoryRouter([
    { path: "/settings", element: <><SettingsPage /><ShortcutsModal /></> },
    { path: "/", element: <p>Project library</p> },
  ], { initialEntries: [path] })} />,
));

const pressKey = (key: string, init: KeyboardEventInit = {}) => act(async () => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
});

const click = (node: HTMLElement) => act(async () => node.click());

it("switches between Scarlet default and Video editor (J/K/L) presets in Settings → Shortcuts", async () => {
  await mount();
  expect(el.querySelector('nav[aria-label="Settings sections"] a[aria-current="true"]')?.textContent).toBe("Shortcuts");
  const presetTrigger = el.querySelector<HTMLButtonElement>("#shortcut-preset")!;
  expect(presetTrigger.textContent).toBe("Scarlet default");

  await selectOption(presetTrigger, /Video editor \(J\/K\/L\)/);
  expect(presetTrigger.textContent).toBe("Video editor (J/K/L)");
  expect(useShortcutsStore.getState().bindings.shuttleBack).toBe("J");
  expect(useShortcutsStore.getState().bindings.shuttleStop).toBe("K");
  expect(useShortcutsStore.getState().bindings.shuttleForward).toBe("L");
  expect(useShortcutsStore.getState().bindings.keep).toBe("A");
  expect(useShortcutsStore.getState().bindings.speedUp).toBe("]");
  expect(useShortcutsStore.getState().bindings.speedDown).toBe("[");
});

it("records a new shortcut, resolves conflicts with Swap or Replace, and resets one or all", async () => {
  await mount();
  const row = (id: string) => el.querySelector<HTMLElement>(`[data-shortcut-id="${id}"]`)!;
  const keyBtn = (id: string) => row(id).querySelector<HTMLButtonElement>(".shortcuts-key-btn")!;

  // Start recording on Revise, then press Esc — cancels recording without leaving Settings.
  await click(keyBtn("revise"));
  expect(keyBtn("revise").textContent).toContain("Press keys");
  await pressKey("Escape");
  expect(el.querySelector("h1")?.textContent).toBe("Settings");
  expect(keyBtn("revise").textContent).toBe("R");

  // Rebind Revise to X -> conflicts with Reject edit (X).
  await click(keyBtn("revise"));
  await pressKey("x");
  expect(row("revise").querySelector('[role="alert"]')?.textContent).toContain("Reject the edit or call on screen");

  // Swap keys gives Revise X and Reject R.
  const swap = [...row("revise").querySelectorAll("button")].find(b => b.textContent === "Swap keys")!;
  await click(swap);
  expect(useShortcutsStore.getState().bindings.revise).toBe("X");
  expect(useShortcutsStore.getState().bindings.reject).toBe("R");
  expect(el.querySelector("#shortcut-preset")?.textContent).toContain("(Custom)");

  // Reset just Revise restores R and cleanly puts swapped Reject back on X.
  await click(row("revise").querySelector<HTMLButtonElement>(".shortcuts-row-reset")!);
  expect(useShortcutsStore.getState().bindings.revise).toBe("R");
  expect(useShortcutsStore.getState().bindings.reject).toBe("X");

  // Rebind Reject to Q, then Reset all restores the preset cleanly.
  await click(keyBtn("reject"));
  await pressKey("q");
  expect(useShortcutsStore.getState().bindings.reject).toBe("Q");
  const resetAll = [...el.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Reset all")!;
  expect(resetAll.disabled).toBe(false);
  await click(resetAll);
  expect(useShortcutsStore.getState().bindings.reject).toBe("X");
  expect(resetAll.disabled).toBe(true);
});

it("blocks reserved system keys and plain letters for chat-box shortcuts", async () => {
  await mount();
  const row = (id: string) => el.querySelector<HTMLElement>(`[data-shortcut-id="${id}"]`)!;
  const keyBtn = (id: string) => row(id).querySelector<HTMLButtonElement>(".shortcuts-key-btn")!;

  await click(keyBtn("keep"));
  await pressKey("/");
  expect(row("keep").querySelector('[role="alert"]')?.textContent).toContain("fixed system key");
  expect(useShortcutsStore.getState().bindings.keep).toBe("K");
  await pressKey("Escape");

  await click(keyBtn("chatBack"));
  await pressKey("j");
  expect(row("chatBack").querySelector('[role="alert"]')?.textContent).toMatch(/plain letters still type/);
  expect(useShortcutsStore.getState().bindings.chatBack).toBe("Mod+J");
});

it("reflects active bindings in the ? popup and links to Settings → Shortcuts", async () => {
  useShortcutsStore.getState().setPreset("jkl");
  useUiStore.setState({ shortcutsOpen: true });
  await mount("/settings");
  const dialog = el.querySelector("dialog")!;
  expect(dialog.open).toBe(true);
  expect(dialog.textContent).toContain("Rewind (shuttle)");
  expect(dialog.textContent).toContain("Rewind while typing");

  const editLink = [...dialog.querySelectorAll("button")].find(b => b.textContent?.includes("Customize in Settings"))!;
  await click(editLink);
  expect(el.querySelector("dialog")).toBeNull();
  expect(el.querySelector('nav[aria-label="Settings sections"] a[aria-current="true"]')?.textContent).toBe("Shortcuts");
});

it("updates Keep and PlaybackSpeed buttons and handlers live when switching to J/K/L preset", async () => {
  const onKeep = vi.fn();
  const onRevise = vi.fn();
  await act(async () => root.render(
    <div>
      <ReviewActions approve={onKeep} approveLabel="Keep" approveKey="K" revise={onRevise} />
      <PlaybackSpeed playable />
    </div>,
  ));

  // Scarlet default: Keep is K.
  expect(el.querySelector('[data-log-control="keep-edit"]')?.getAttribute("data-key")).toBe("K");
  await pressKey("k");
  expect(onKeep).toHaveBeenCalledTimes(1);

  // Switch to J/K/L preset: Keep moves to A, K no longer triggers Keep, and speed stepper updates to [ / ].
  await act(async () => useShortcutsStore.getState().setPreset("jkl"));
  expect(el.querySelector('[data-log-control="keep-edit"]')?.getAttribute("data-key")).toBe("A");
  expect(el.querySelector('[data-log-control="keep-edit"]')?.getAttribute("title")).toBe("Keep (A)");
  await pressKey("k");
  expect(onKeep).toHaveBeenCalledTimes(1);
  await pressKey("a");
  expect(onKeep).toHaveBeenCalledTimes(2);

  await click(el.querySelector<HTMLButtonElement>(".playback-speed-trigger")!);
  expect(el.querySelector('[aria-label="Decrease playback speed"]')?.getAttribute("title")).toBe("Decrease playback speed ([)");
  expect(el.querySelector(".playback-speed-shortcut-label")?.textContent).toBe("] shortcut");
});
