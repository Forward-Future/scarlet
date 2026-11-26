// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useUiStore } from "../../stores/ui";
import { DictationSettings } from "./DictationSettings";

const oldUi = useUiStore.getState();
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  useUiStore.setState(oldUi, true);
  vi.unstubAllGlobals();
});

it("reviews dictation by default, and turning it off is kept on this computer", async () => {
  expect(useUiStore.getState().reviewDictation).toBe(true);
  await act(async () => root.render(<DictationSettings />));
  expect(container.querySelector('section[aria-label="Dictation"]')?.textContent).toContain("Review dictation before sending");
  const toggle = container.querySelector<HTMLButtonElement>('button[role="switch"]')!;
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(localStorage.getItem("scarlet.reviewDictation")).toBeNull();

  await act(async () => toggle.click());
  expect(useUiStore.getState().reviewDictation).toBe(false);
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(localStorage.getItem("scarlet.reviewDictation")).toBe("off");
  vi.resetModules();
  const { useUiStore: relaunched } = await import("../../stores/ui");
  expect(relaunched.getState().reviewDictation).toBe(false);

  await act(async () => toggle.click());
  expect(useUiStore.getState().reviewDictation).toBe(true);
  expect(localStorage.getItem("scarlet.reviewDictation")).toBeNull();
});
