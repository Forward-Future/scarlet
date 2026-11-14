import { describe, expect, it } from "vitest";
import { disabledEditingTools, EDITING_TOOL_GROUPS, EditingTools, OptionalToolGroup, SCARLET_TOOL_NAMES } from "./editingTools.js";

describe("the editing tools inventory", () => {
  it("lists every tool once, and leaves the two skill-saving tools to the tasks that may use them", () => {
    const all = EDITING_TOOL_GROUPS.flatMap(g => [...g.tools]);
    expect(new Set(all).size).toBe(all.length);
    expect(SCARLET_TOOL_NAMES).toEqual(all.filter(name => name !== "skill_save_from_change" && name !== "skill_save_edit"));
    expect(SCARLET_TOOL_NAMES).toContain("timeline_propose");
  });

  it("gives every optional group exactly one preference, and the essentials none", () => {
    const preferences = EDITING_TOOL_GROUPS.flatMap(g => (g.preference ? [g.preference] : []));
    expect([...preferences].sort()).toEqual([...OptionalToolGroup.options].sort());
    expect(EDITING_TOOL_GROUPS.filter(g => !g.preference).map(g => g.title)).toEqual(["Timeline editing", "Speech and waveform", "Screen text", "Review and delivery", "Requests and skills"]);
  });

  it("turns off only the tools of a group the editor switched off", () => {
    expect(disabledEditingTools({})).toEqual(new Set());
    expect(disabledEditingTools({ pictures: true, auditions: true, captions: true, exchange: true })).toEqual(new Set());
    expect(disabledEditingTools({ pictures: false, captions: true })).toEqual(new Set(["media_frame", "frame_contact_sheet", "frame_contact_sheet_batch"]));
    expect(disabledEditingTools({ pictures: false, auditions: false, captions: false, exchange: false })).toEqual(new Set([
      "media_frame", "frame_contact_sheet", "frame_contact_sheet_batch", "change_review_cut", "source_audio", "captions_generate", "asset_add", "export_otio"]));
  });

  it("accepts only the optional groups as preferences", () => {
    expect(EditingTools.parse({ pictures: false })).toEqual({ pictures: false });
    expect(EditingTools.safeParse({ timeline: false }).success).toBe(false);
    expect(EditingTools.safeParse({ pictures: "off" }).success).toBe(false);
  });
});
