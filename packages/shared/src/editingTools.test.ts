import { describe, expect, it } from "vitest";
import { EDITING_TOOL_GROUPS, SCARLET_TOOL_NAMES } from "./editingTools.js";

describe("the editing tools inventory", () => {
  it("lists every tool once, and leaves the two skill-saving tools to the tasks that may use them", () => {
    const all = EDITING_TOOL_GROUPS.flatMap(g => [...g.tools]);
    expect(new Set(all).size).toBe(all.length);
    expect(SCARLET_TOOL_NAMES).toEqual(all.filter(name => name !== "skill_save_from_change" && name !== "skill_save_edit"));
    expect(SCARLET_TOOL_NAMES).toContain("timeline_propose");
  });

});
