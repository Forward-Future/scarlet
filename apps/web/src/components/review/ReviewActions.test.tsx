// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePlayerStore } from "../../stores/player";
import { ReviewActions } from "./ReviewActions";

let root: Root;
let container: HTMLDivElement;
const revise = vi.fn(), approve = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  usePlayerStore.setState({ playing: false });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  revise.mockClear();
  approve.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const show = (props: Partial<ComponentProps<typeof ReviewActions>> = {}) => act(async () => root.render(<ReviewActions revise={revise} approve={approve} {...props} />));
const press = (key: string, init: KeyboardEventInit = {}) => act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); });
const buttons = () => [...container.querySelectorAll("button")];
const named = (text: string) => buttons().find(b => b.textContent === text)!;

it("names each decision and its key on hover, and takes the key from anywhere on the page", async () => {
  await show();
  expect(buttons().map(b => [b.textContent, b.getAttribute("aria-keyshortcuts"), b.title])).toEqual([["Revise", "R", "Revise (R)"], ["Apply", "A", "Apply (A)"]]);
  await press("r");
  await press("A");
  expect([revise.mock.calls.length, approve.mock.calls.length]).toEqual([1, 1]);
  // An applied edit is kept, with K. A is no longer a decision there.
  await show({ approveLabel: "Keep", approveKey: "K" });
  expect(named("Keep").title).toBe("Keep (K)");
  await press("a");
  expect(approve).toHaveBeenCalledTimes(1);
  await press("k");
  expect(approve).toHaveBeenCalledTimes(2);
});

it("decides once for a held key, and not at all while typing or while the decisions are off", async () => {
  await show();
  await press("a", { repeat: true });
  await press("r", { repeat: true });
  expect([revise.mock.calls.length, approve.mock.calls.length]).toEqual([0, 0]);
  // A letter typed into a field is the editor's words.
  const field = document.createElement("textarea");
  container.append(field);
  await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })); });
  await press("a", { metaKey: true });
  expect(approve).not.toHaveBeenCalled();
  field.remove();
  // While it applies, neither decision can be made, by key or by button.
  await show({ disabled: true });
  expect(buttons().map(b => b.disabled)).toEqual([true, true]);
  await press("a");
  await press("r");
  expect([revise.mock.calls.length, approve.mock.calls.length]).toEqual([0, 0]);
  // With only the approval held back, Revise still works.
  await show({ approvalDisabled: true });
  expect(buttons().map(b => b.disabled)).toEqual([false, true]);
  await press("a");
  await press("r");
  expect([revise.mock.calls.length, approve.mock.calls.length]).toEqual([1, 0]);
});

it("says an approval made in advance in place of the button, with a way to take it back", async () => {
  const cancel = vi.fn();
  await show({ scheduled: { label: "Applies when Scarlet finishes", cancel } });
  expect(named("Apply")).toBeUndefined();
  const said = container.querySelector<HTMLButtonElement>(".review-scheduled")!;
  expect([said.getAttribute("aria-label"), said.querySelector(".review-scheduled-state")?.textContent]).toEqual(["Applies when Scarlet finishes. Cancel", "Applies when Scarlet finishes"]);
  // It's already approved, so A does nothing more.
  await press("a");
  expect(approve).not.toHaveBeenCalled();
  await act(async () => said.click());
  expect(cancel).toHaveBeenCalledTimes(1);
  // A revision with nothing to approve is Revise alone.
  await act(async () => root.render(<ReviewActions revise={revise} />));
  expect(buttons().map(b => b.textContent)).toEqual(["Revise"]);
});

it("lets go of the focus when the decision is clicked, and keeps it when pressed by keyboard", async () => {
  await show({ approveLabel: "Keep", approveKey: "K" });
  const keep = named("Keep");
  // Enter or Space on the focused button reaches it as a click with no count. Tab goes on from there.
  keep.focus();
  await act(async () => { keep.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 })); });
  expect(approve).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(keep);
  // A click with the mouse leaves the button focused in WebView2, and the button stays for the next edit. While the
  // video is paused Space isn't the page's on a focused button, so it would keep the next edit too.
  await act(async () => { keep.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })); });
  expect(approve).toHaveBeenCalledTimes(2);
  expect(document.activeElement).not.toBe(keep);
  expect(named("Keep")).toBe(keep);
});
