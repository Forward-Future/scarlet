// @vitest-environment happy-dom
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { arrowSeekTime, handleCutArrow, ignorePageShortcut, isComposing, isEditableTarget, mediaPlaying, useComparisonShortcut, useHotkeys } from "./hotkeys";
import { usePlayerStore } from "../stores/player";

afterEach(() => {
  usePlayerStore.getState().setPlaying(false);
  document.body.innerHTML = "";
});

function keyOn(target: Element, key: string) {
  const e = new KeyboardEvent("keydown", { key, bubbles: true });
  Object.defineProperty(e, "target", { value: target });
  return e;
}
const spaceOn = (target: Element) => keyOn(target, " ");

/** A picker's trigger as PreferenceSelect renders it. A choice leaves focus on it. */
function picker(expanded: boolean) {
  const trigger = document.body.appendChild(document.createElement("button"));
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-expanded", String(expanded));
  return trigger;
}

it("lets a focused button take Space while nothing plays", () => {
  const fit = document.body.appendChild(document.createElement("button"));
  expect(ignorePageShortcut(spaceOn(fit))).toBe(true);
});

it("keeps Space as pause while playing, even on a focused button", () => {
  const fit = document.body.appendChild(document.createElement("button"));
  usePlayerStore.getState().setPlaying(true);
  expect(ignorePageShortcut(spaceOn(fit))).toBe(false);
});

it("runs page shortcuts while a closed picker still has focus", () => {
  const closed = picker(false);
  expect(isEditableTarget(closed)).toBe(false);
  for (const key of ["k", "ArrowRight", "Escape"]) expect(ignorePageShortcut(keyOn(closed, key))).toBe(false);
});

it("lets a closed picker take Space while nothing plays", () => {
  expect(ignorePageShortcut(spaceOn(picker(false)))).toBe(true);
});

it("leaves the keys to a picker while its list is open", () => {
  const open = picker(true);
  expect(isEditableTarget(open)).toBe(true);
  expect(ignorePageShortcut(keyOn(open, "k"))).toBe(true);
});

it("keeps a text field editable whatever its role", () => {
  const note = document.createElement("div");
  note.setAttribute("contenteditable", "true");
  for (const field of [document.createElement("input"), document.createElement("textarea"), note]) {
    document.body.append(field);
    expect(isEditableTarget(field)).toBe(true);
    field.setAttribute("role", "combobox");
    field.setAttribute("aria-expanded", "false");
    expect(isEditableTarget(field)).toBe(true);
    expect(ignorePageShortcut(keyOn(field, "k"))).toBe(true);
  }
});

it("leaves Esc to a small popover that is open, so one press doesn't also close what's behind it", () => {
  const popover = document.createElement("div");
  popover.setAttribute("data-escape-owner", "");
  document.body.append(popover);
  try {
    expect(ignorePageShortcut(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(true);
    // Other keys still reach the page: the timeline's own zoom keys work while its controls are open.
    expect(ignorePageShortcut(new KeyboardEvent("keydown", { key: "0" }))).toBe(false);
  } finally { popover.remove(); }
  expect(ignorePageShortcut(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(false);
});

it("skips five seconds with an arrow and one with Shift, without drifting off the millisecond", () => {
  expect(arrowSeekTime(10, "ArrowRight", false)).toBe(15);
  expect(arrowSeekTime(10, "ArrowLeft", false)).toBe(5);
  expect(arrowSeekTime(10, "ArrowLeft", true)).toBe(9);
  expect(arrowSeekTime(10, "ArrowRight", true)).toBe(11);
  // Repeated skips from an awkward time stay exact.
  let time = 0.1;
  for (let i = 0; i < 3; i++) time = arrowSeekTime(time, "ArrowRight", true);
  expect(time).toBe(3.1);
  // The caller clamps: a skip back from the start is before it.
  expect(arrowSeekTime(2, "ArrowLeft", false)).toBe(-3);
});

it("steps between cuts once for each plain ↑ or ↓ press, and leaves every other key alone", () => {
  const step = vi.fn();
  const press = (init: KeyboardEventInit) => {
    const e = new KeyboardEvent("keydown", { cancelable: true, ...init });
    return { handled: handleCutArrow(e, step), prevented: e.defaultPrevented };
  };
  expect(press({ key: "ArrowDown" })).toEqual({ handled: true, prevented: true });
  expect(press({ key: "ArrowUp" })).toEqual({ handled: true, prevented: true });
  expect(step.mock.calls).toEqual([[1], [-1]]);
  // A held key scrolls nothing and steps no further.
  expect(press({ key: "ArrowDown", repeat: true })).toEqual({ handled: true, prevented: true });
  // An input method choosing a candidate with the arrows is not a step.
  expect(press({ key: "ArrowDown", isComposing: true })).toEqual({ handled: true, prevented: true });
  expect(step).toHaveBeenCalledTimes(2);
  // ← and → are the player's, and Shift with an arrow is a selection.
  for (const init of [{ key: "ArrowLeft" }, { key: "ArrowRight" }, { key: "ArrowDown", shiftKey: true }, { key: "j" }]) {
    expect(press(init)).toEqual({ handled: false, prevented: false });
  }
  expect(step).toHaveBeenCalledTimes(2);
});

it("knows an input method is composing, including Safari's Enter that commits it", () => {
  expect(isComposing({ isComposing: true })).toBe(true);
  expect(isComposing({ nativeEvent: new KeyboardEvent("keydown", { isComposing: true }) })).toBe(true);
  expect(isComposing({ isComposing: false, keyCode: 229 })).toBe(true);
  expect(isComposing({ isComposing: false, keyCode: 13 })).toBe(false);
  expect(isComposing({})).toBe(false);
});

it("counts a playing video anywhere on the page as playing", () => {
  expect(mediaPlaying()).toBe(false);
  const video = document.body.appendChild(document.createElement("video"));
  expect(mediaPlaying()).toBe(false);
  Object.defineProperty(video, "paused", { value: false });
  expect(mediaPlaying()).toBe(true);
});

it("leaves page shortcuts to an open dialog or menu, to a key already handled, and to a modifier combination", () => {
  const key = (init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key: "k", cancelable: true, ...init });
  expect(ignorePageShortcut(key())).toBe(false);
  for (const init of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) expect(ignorePageShortcut(key(init))).toBe(true);
  const handled = key();
  handled.preventDefault();
  expect(ignorePageShortcut(handled)).toBe(true);
  const menu = document.body.appendChild(document.createElement("div"));
  menu.setAttribute("role", "menu");
  expect(ignorePageShortcut(key())).toBe(true);
  menu.remove();

  // Inside its own open drawer, a clip keeps its keys unless a menu is open in that drawer.
  const drawer = document.body.appendChild(document.createElement("dialog"));
  drawer.setAttribute("open", "");
  const clip = drawer.appendChild(document.createElement("div"));
  const inside = keyOn(clip, "k");
  expect(ignorePageShortcut(inside)).toBe(true);
  expect(ignorePageShortcut(inside, clip)).toBe(false);
  drawer.appendChild(document.createElement("div")).setAttribute("data-shortcut-overlay", "");
  expect(ignorePageShortcut(inside, clip)).toBe(true);
  // A key from outside the drawer is the drawer's, not the page's.
  expect(ignorePageShortcut(key(), clip)).toBe(true);
});

it("runs a page's shortcut with its latest handler, skips typing, and stops when the page goes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const seen: string[] = [];
  function Page({ name, compare }: { name: string; compare: boolean }) {
    const owner = useRef<HTMLDivElement>(null);
    useHotkeys(e => seen.push(`${name} down ${e.key}`), e => seen.push(`${name} up ${e.key}`));
    useComparisonShortcut(compare, () => seen.push(`${name} compare`), owner);
    return createElement("div", { ref: owner }, createElement("input"));
  }
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const press = (key: string, init: KeyboardEventInit = {}, on: EventTarget = window) => on.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  try {
    await act(async () => root.render(createElement(Page, { name: "first", compare: true })));
    press("k");
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "k" }));
    await act(async () => root.render(createElement(Page, { name: "second", compare: true })));
    press("k");
    // Typing in a field is not a shortcut.
    press("k", {}, host.querySelector("input")!);
    // Before/After switches once per press, not while held or with Shift.
    press("\\");
    press("\\", { repeat: true });
    press("\\", { shiftKey: true });
    await act(async () => root.render(createElement(Page, { name: "third", compare: false })));
    press("\\");
    expect(seen).toEqual(["first down k", "first up k", "second down k", "second down \\", "second compare", "second down \\", "second down \\", "third down \\"]);
    await act(async () => root.unmount());
    press("k");
    expect(seen).toHaveLength(8);
  } finally {
    vi.unstubAllGlobals();
  }
});
