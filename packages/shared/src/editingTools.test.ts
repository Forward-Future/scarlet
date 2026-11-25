import { describe, expect, it } from "vitest";
import { EDITING_TOOL_GROUPS, SCARLET_TOOL_NAMES } from "./editingTools.js";

describe("the editing tools inventory", () => {
  it("lists every tool once, and leaves the authoring-only tools to the tasks that may use them", () => {
    const all = EDITING_TOOL_GROUPS.flatMap(g => [...g.tools]);
    const authoringOnly = new Set([
      "skill_save_from_change",
      "skill_save_edit",
      "style_guide_update",
      "style_guide_preview_render",
      "style_guide_preview_get",
    ]);
    expect(new Set(all).size).toBe(all.length);
    expect(SCARLET_TOOL_NAMES).toEqual(all.filter(name => !authoringOnly.has(name)));
    expect(SCARLET_TOOL_NAMES).toContain("timeline_propose");
  });

});
