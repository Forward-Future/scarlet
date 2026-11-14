import { describe, expect, it } from "vitest";
import { CHANGELOG, changesSince, parseChangelog, plainChange } from "./changelog";

describe("changelog", () => {
  it("reads days and their changes, skipping the introduction", () => {
    const days = parseChangelog("# Changelog\n\nIntro line.\n- not a change\n\n## November 14, 2026\n\n- One.\n- Two.\n\n## November 13, 2026\n* Three.\n\n## Empty day\n");
    expect(days).toEqual([
      { date: "November 14, 2026", changes: ["One.", "Two."] },
      { date: "November 13, 2026", changes: ["Three."] },
    ]);
  });

  it("lists only what a newer build adds", () => {
    const current = parseChangelog("## Nov 13\n- Old.\n");
    const next = parseChangelog("## Nov 14\n- New one.\n- New two.\n## Nov 13\n- Old.\n");
    expect(changesSince(next, current)).toEqual(["New one.", "New two."]);
    expect(changesSince(current, current)).toEqual([]);
  });

  it("drops markdown marks for plain text", () => {
    expect(plainChange("Use `Settings` and **bold** words.")).toBe("Use Settings and bold words.");
  });

  it("ships the repository's changelog with at least one dated change", () => {
    expect(CHANGELOG.length).toBeGreaterThan(0);
    expect(CHANGELOG[0]?.changes.length).toBeGreaterThan(0);
  });
});
