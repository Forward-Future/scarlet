// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangelogDay } from "../../lib/changelog";
import { Changelog } from "./Changelog";

let el: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});

afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  vi.unstubAllGlobals();
});

const render = (days?: ChangelogDay[]) => act(async () => root.render(<Changelog days={days} />));
const items = (within: ParentNode = el) => [...within.querySelectorAll("li")].map(li => li.textContent);

describe("Changelog", () => {
  it("renders nothing when there are no dated changes", async () => {
    await render([]);
    expect(el.innerHTML).toBe("");
  });

  it("caps a long latest day up front and toggles the remaining changes in place", async () => {
    const latest: ChangelogDay = {
      date: "November 19, 2026",
      changes: Array.from({ length: 8 }, (_, i) => `Change ${i + 1}.`),
    };
    await render([latest]);

    expect(el.querySelector(".about-changelog-date")?.textContent).toBe("November 19, 2026");
    expect(items()).toEqual(["Change 1.", "Change 2.", "Change 3.", "Change 4.", "Change 5."]);

    const toggle = el.querySelector<HTMLButtonElement>(".about-changelog-more")!;
    expect(toggle.textContent).toBe("Show 3 more");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await act(async () => toggle.click());
    expect(items()).toEqual(latest.changes);
    expect(toggle.textContent).toBe("Show fewer");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    await act(async () => toggle.click());
    expect(items()).toHaveLength(5);
    expect(toggle.textContent).toBe("Show 3 more");
  });

  it("does not fold a single extra item behind a toggle", async () => {
    const latest: ChangelogDay = {
      date: "November 19, 2026",
      changes: Array.from({ length: 6 }, (_, i) => `Change ${i + 1}.`),
    };
    await render([latest]);

    expect(items()).toEqual(latest.changes);
    expect(el.querySelector(".about-changelog-more")).toBeNull();
  });

  it("folds earlier days into collapsible per-day sections with counts", async () => {
    await render([
      { date: "November 20, 2026", changes: ["Today’s `change`."] },
      { date: "November 19, 2026", changes: ["First yesterday.", "Second yesterday."] },
      { date: "November 18, 2026", changes: ["Older change."] },
    ]);

    expect(items(el.querySelector(".about-changelog > .about-change-list")!)).toEqual(["Today’s change."]);
    expect(el.querySelector(".about-changelog-more")).toBeNull();

    const disclosure = el.querySelector<HTMLDetailsElement>(".about-disclosure")!;
    expect(disclosure.open).toBe(false);
    expect(disclosure.querySelector(":scope > summary")?.textContent).toBe("Earlier changes");

    const earlierDays = [...disclosure.querySelectorAll<HTMLDetailsElement>(".about-release-day")];
    expect(earlierDays).toHaveLength(2);
    expect(earlierDays.every(day => !day.open)).toBe(true);
    expect(earlierDays.map(day => [
      day.querySelector(".about-release-date")?.textContent,
      day.querySelector(".about-release-meta span")?.textContent,
    ])).toEqual([
      ["November 19, 2026", "2"],
      ["November 18, 2026", "1"],
    ]);
    expect(items(earlierDays[0]!)).toEqual(["First yesterday.", "Second yesterday."]);
  });
});
