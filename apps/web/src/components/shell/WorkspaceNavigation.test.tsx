// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { Dropdown, MenuItem, WindowActions } from "./WorkspaceNavigation";

it("omits a notification button", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter><WindowActions /></MemoryRouter>));
    expect(container.querySelector('[aria-label="Settings"]')).toBeTruthy();
    expect(container.querySelector('[aria-label^="Notifications"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("leaves alone a ↓ the page has already taken when its button has the focus, and opens its menu on one it hasn't", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  // The page steps edits with ↑ and ↓ from a listener that runs first and prevents the key's default.
  const page = (e: KeyboardEvent) => { if (e.key === "ArrowDown") e.preventDefault(); };
  try {
    await act(async () => root.render(<MemoryRouter><Dropdown label="More" button={<span>More</span>}>{close => <MenuItem onClick={close}>Export</MenuItem>}</Dropdown></MemoryRouter>));
    const button = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    const down = () => act(async () => { button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); });
    // A menu that was used hands the focus back to its button.
    await act(async () => button.click());
    await act(async () => container.querySelector<HTMLElement>('[role="menuitem"]')!.click());
    expect(document.activeElement).toBe(button);
    window.addEventListener("keydown", page, true);
    await down();
    expect(container.querySelector('[role="menu"]')).toBeNull();
    window.removeEventListener("keydown", page, true);
    await down();
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
  } finally {
    window.removeEventListener("keydown", page, true);
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
