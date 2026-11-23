import type { KeyboardEvent } from "react";

/**
 * Places the model selector next to the control that opened it. A menu's row (`besideMenu`) opens the selector beside
 * the menu, level with the row; otherwise it opens above or below the control, `direction` first when there's room.
 */
export function placeModelSelector(menu: HTMLElement, anchor: HTMLElement, direction: "up" | "down", besideMenu: boolean) {
  const rect = anchor.getBoundingClientRect();
  // A menu's row opens the selector beside the menu, level with the row, so it covers none of the menu's rows:
  // on the side that has room for it. A window too narrow for either side opens it under the row.
  const rows = besideMenu ? anchor.closest('[role="menu"]')?.getBoundingClientRect() : undefined;
  const width = menu.offsetWidth;
  const beside = !rows ? undefined : window.innerWidth - rows.right - 14 >= width ? rows.right + 6 : rows.left - 14 >= width ? rows.left - width - 6 : undefined;
  if (beside !== undefined) {
    menu.style.maxHeight = `${window.innerHeight - 16}px`;
    menu.style.left = `${beside}px`;
    menu.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight - menu.offsetHeight - 8))}px`;
    menu.style.right = "auto";
    return;
  }
  const above = rect.top - 12;
  const below = window.innerHeight - rect.bottom - 12;
  const up = direction === "up" ? above >= Math.min(300, below) : below < Math.min(300, above);
  menu.style.maxHeight = `${Math.max(80, up ? above : below)}px`;
  menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${up ? Math.max(8, rect.top - menu.offsetHeight - 6) : rect.bottom + 6}px`;
  menu.style.right = "auto";
}

/**
 * Arrow keys inside the model selector: ← → step through the providers, effort and speed rows; ↑ ↓ step through the
 * group the focus is in, or the model list from the selector itself or its search field.
 */
export function moveSelectorFocus(event: KeyboardEvent<HTMLElement>, panel: HTMLElement | null, searchField: HTMLElement | null) {
  const target = event.target as HTMLElement;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    const horizGroup = target.closest('[aria-label="Providers"], [aria-label="Effort"], [aria-label="Speed"]');
    if (!horizGroup) return;
    const selector = horizGroup.getAttribute("role") === "radiogroup" ? 'button[role="radio"]' : "button";
    const buttons = Array.from(horizGroup.querySelectorAll<HTMLButtonElement>(selector));
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(target as HTMLButtonElement);
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = index < 0 ? 0 : (index + delta + buttons.length) % buttons.length;
    buttons[next]?.focus();
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const group = target === panel || target === searchField
    ? panel?.querySelector('[aria-label="Models"]')
    : target.closest('[role="radiogroup"], [aria-label="Providers"], [role="menu"]');
  const selector = group?.getAttribute("role") === "radiogroup"
    ? 'button[role="radio"]'
    : group?.getAttribute("role") === "menu"
      ? 'button:not(:disabled), a'
      : "button";
  const buttons = Array.from(group?.querySelectorAll<HTMLElement>(selector) ?? []);
  if (!buttons.length) return;
  event.preventDefault();
  const index = buttons.indexOf(target);
  const next = index < 0 ? (event.key === "ArrowDown" ? 0 : buttons.length - 1) : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next]?.focus();
}
