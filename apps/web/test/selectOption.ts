import { act } from "react";
import { expect } from "vitest";

export async function openOptions(trigger: HTMLElement) {
  expect(trigger.getAttribute("role")).toBe("combobox");
  await act(() => trigger.click());
  const list = document.getElementById(trigger.getAttribute("aria-controls")!);
  expect(list?.getAttribute("role")).toBe("listbox");
  return [...list!.querySelectorAll<HTMLElement>('[role="option"]')];
}

export async function selectOption(trigger: HTMLElement, text: string | RegExp) {
  const options = await openOptions(trigger);
  const option = options.find(o => typeof text === "string" ? o.textContent === text : text.test(o.textContent ?? ""));
  expect(option, String(text)).toBeDefined();
  await act(() => option!.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
}
