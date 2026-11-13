// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PreferenceSelect } from "./PreferenceSelect";

let el: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const open = async () => {
  await act(async () => root.render(<PreferenceSelect label="Speed" options={[{ value: 1, label: "1×" }, { value: 2, label: "2×" }]} value={1} onChange={() => undefined} />));
  await act(async () => el.querySelector<HTMLButtonElement>('[role="combobox"]')!.click());
  return document.querySelector('[role="listbox"]')!;
};

it("opens its list on the page", async () => {
  expect((await open()).parentElement).toBe(document.body);
});

it("opens its list inside the element that is full screen, where it can be seen", async () => {
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => el });
  try { expect((await open()).parentElement).toBe(el); }
  finally { delete (document as { fullscreenElement?: Element }).fullscreenElement; }
});

it("doesn't open its list for a key the page has already acted on", async () => {
  await act(async () => root.render(<PreferenceSelect label="Speed" options={[{ value: 1, label: "1×" }, { value: 2, label: "2×" }]} value={1} onChange={() => undefined} />));
  const trigger = el.querySelector<HTMLButtonElement>('[role="combobox"]')!;
  trigger.focus();
  // The page steps to the next edit on ↓ before the key reaches the picker that still has the focus.
  const page = (e: KeyboardEvent) => { if (e.key === "ArrowDown") e.preventDefault(); };
  window.addEventListener("keydown", page, true);
  try {
    await act(async () => { trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  } finally { window.removeEventListener("keydown", page, true); }
  // A key nothing else took still opens it.
  await act(async () => { trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
});
