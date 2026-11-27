import { describe, expect, it } from "vitest";
import {
  EditStyleGuideRequest,
  ImportStyleGuideSoundRequest,
  parseStyleGuideDefinitionJson,
  serializeStyleGuideDefinition,
  slugifyStyleGuideName,
  styleGuideCommands,
  styleGuideMentions,
  StyleGuideRecord,
  StyleGuideTransition,
  TaskStyleGuideDraft,
} from "./index.js";

const parse = (value: unknown, opts?: Parameters<typeof parseStyleGuideDefinitionJson>[1]) =>
  parseStyleGuideDefinitionJson(JSON.stringify(value), opts);

describe("style guide @mentions in the composer and in skills", () => {
  it("finds whole @tokens with their positions, including a bare @ still being typed", () => {
    const draft = "Use @Brand-Look here @ and mail me@example.com";
    expect(styleGuideCommands(draft)).toEqual([
      { start: 4, end: 15, name: "brand-look" },
      { start: 21, end: 22, name: "" },
    ]);
    expect(styleGuideCommands("@first")).toEqual([{ start: 0, end: 6, name: "first" }]);
    expect(styleGuideCommands("")).toEqual([]);
  });

  it("lists each mentioned slug once, lowercased, after spaces, line breaks or a bracket, and skips emails", () => {
    const text = "Match @Studio-Look. Then (@neon) and @studio-look again!\n@third: done; write to editor@studio-look.com";
    expect(styleGuideMentions(text)).toEqual(["studio-look", "neon", "third"]);
    expect(styleGuideMentions("no mentions here")).toEqual([]);
    expect(styleGuideMentions("@-dash isn't a slug")).toEqual([]);
  });

  it("turns a free-form label into a slug, or nothing when no letters or digits remain", () => {
    expect(slugifyStyleGuideName("@@My Brand!! 2026")).toBe("my-brand-2026");
    expect(slugifyStyleGuideName("  --Warm   Studio--  ")).toBe("warm-studio");
    expect(slugifyStyleGuideName("!!!")).toBe("");
  });
});

describe("style guide request schemas", () => {
  it("needs words or a file to ask Scarlet to edit a style guide", () => {
    expect(EditStyleGuideRequest.safeParse({ prompt: "   " }).success).toBe(false);
    expect(EditStyleGuideRequest.safeParse({ prompt: "", attachments: [] }).success).toBe(false);
    expect(EditStyleGuideRequest.safeParse({ attachments: [{ id: "sga_1", name: "brand.pdf", size: 10 }] }).success).toBe(true);
    expect(EditStyleGuideRequest.parse({ prompt: "  Warmer  " }).prompt).toBe("Warmer");
  });

  it("needs a built-in slug, or a style guide with a sound or an asset, to import a sound", () => {
    expect(ImportStyleGuideSoundRequest.safeParse({ styleGuideId: "sg_1" }).success).toBe(false);
    expect(ImportStyleGuideSoundRequest.safeParse({ soundId: "sfx_1" }).success).toBe(false);
    expect(ImportStyleGuideSoundRequest.safeParse({ styleGuideId: "sg_1", assetId: "sga_1" }).success).toBe(true);
    expect(ImportStyleGuideSoundRequest.safeParse({ styleGuideId: "sg_1", soundId: "sfx_1" }).success).toBe(true);
  });

  it("fills transition defaults and rejects transitions longer than ten seconds", () => {
    expect(StyleGuideTransition.parse({ id: "tr_1", name: " Fade ", type: "dissolve" })).toEqual({
      id: "tr_1", name: "Fade", type: "dissolve", duration: 0.4, direction: "left", usageRule: "", isDefault: false,
    });
    expect(StyleGuideTransition.safeParse({ id: "tr_1", name: "Slow", type: "dissolve", duration: 12 }).success).toBe(false);
    expect(StyleGuideTransition.safeParse({ id: "tr_1", name: "Dip", type: "dip", color: "not-a-colour" }).success).toBe(false);
  });

  it("keeps a task's saved description to one line", () => {
    expect(TaskStyleGuideDraft.safeParse({ description: "Line one\nLine two" }).success).toBe(false);
    expect(TaskStyleGuideDraft.safeParse({ description: "One line" }).success).toBe(true);
    expect(TaskStyleGuideDraft.safeParse({ instructions: "   " }).success).toBe(false);
  });
});

describe("parsing a portable style definition file", () => {
  it("returns null for JSON that isn't a style definition object", () => {
    expect(parseStyleGuideDefinitionJson("null")).toBeNull();
    expect(parseStyleGuideDefinitionJson("42")).toBeNull();
    expect(parseStyleGuideDefinitionJson("\"text\"")).toBeNull();
    expect(parse([{ description: "in an array" }])).toBeNull();
    expect(parse({ name: "only-a-name", version: 1 })).toBeNull();
    // A definition-looking file whose sections don't validate is left for Scarlet to read in chat.
    expect(parse({ transitions: [{ name: "Spin", type: "spin" }] })).toBeNull();
    expect(parse({ sounds: [{ name: "Loud", builtInId: "soft-whoosh", volumeDb: 20 }] })).toBeNull();
  });

  it("names the guide from the file's name, the fallback, or not at all, and keeps top-level settings", () => {
    expect(parse({ description: "  Warm cream  " }, { fallbackName: "My Brand.style" })).toEqual({
      name: "my-brand-style",
      description: "Warm cream",
    });
    expect(parse({ description: "x" })).toEqual({ description: "x" });
    expect(parse({ name: "Studio Kit", instructions: "## Rules", captionStyle: null, isDefault: true }, { fallbackName: "ignored" })).toEqual({
      name: "studio-kit",
      instructions: "## Rules",
      captionStyle: null,
      isDefault: true,
    });
    expect(parse({ captionStyle: { fontFamily: "Inter", uppercase: true } })).toEqual({
      captionStyle: { fontFamily: "Inter", uppercase: true },
    });
  });

  it("keeps a custom sound only when its audio file is already in the guide", () => {
    const parsed = parse({
      sounds: [
        { name: "Kept swoosh", source: "asset", assetId: "sga_audio", volumeDb: -10, duration: 1.2, usageRule: "On reveals" },
        { name: "Missing file", source: "asset", assetId: "sga_gone" },
        { name: "No file at all", source: "asset" },
        { assetId: "sga_audio" },
      ],
    }, { existingAssetIds: new Set(["sga_audio"]) });
    expect(parsed!.sounds).toEqual([
      { id: "sfx_kept_swoosh", name: "Kept swoosh", source: "asset", assetId: "sga_audio", volumeDb: -10, duration: 1.2, usageRule: "On reveals" },
      { id: "sfx_sga_audio", name: "Custom sound", source: "asset", assetId: "sga_audio", volumeDb: -14, usageRule: "" },
    ]);
    // Without the guide's assets, every custom sound is dropped.
    expect(parse({ sounds: [{ name: "Kept swoosh", source: "asset", assetId: "sga_audio" }] })!.sounds).toEqual([]);
  });

  it("matches built-in sounds by slug, by the `builtin` shorthand or by their name, and drops unknown ones", () => {
    const parsed = parse({
      sounds: [
        { builtin: "builtin:subtle-pop" },
        { name: "clean chime" },
        { name: "Riser", builtInId: "subtle-riser", volumeDb: -20, duration: 0.5, usageRule: "Before chapters" },
        { name: "Mystery", builtInId: "does-not-exist" },
        { name: "Not a built-in" },
      ],
    });
    expect(parsed!.sounds).toEqual([
      { id: "sfx_subtle_pop", name: "Subtle pop", source: "builtin", builtInId: "subtle-pop", volumeDb: -12, duration: 0.18, usageRule: "When a stat callout or badge appears" },
      { id: "sfx_clean_chime", name: "clean chime", source: "builtin", builtInId: "clean-chime", volumeDb: -16, duration: 0.55, usageRule: "Chapter title or key takeaway" },
      { id: "sfx_subtle_riser", name: "Riser", source: "builtin", builtInId: "subtle-riser", volumeDb: -20, duration: 0.5, usageRule: "Before chapters" },
    ]);
  });

  it("keeps the file's own sound ids and gives repeated ones a fresh id", () => {
    const parsed = parse({
      sounds: [
        { id: "sfx_mine", builtInId: "soft-whoosh" },
        { id: "sfx_mine", builtInId: "soft-whoosh" },
        { builtInId: "soft-whoosh" },
        { id: "sfx_custom", source: "asset", assetId: "sga_a" },
        { id: "sfx_custom", source: "asset", assetId: "sga_a" },
      ],
    }, { existingAssetIds: new Set(["sga_a"]) });
    expect(parsed!.sounds!.map(s => s.id)).toEqual(["sfx_mine", "sfx_soft_whoosh", "sfx_soft_whoosh_2", "sfx_custom", "sfx_sga_a"]);
  });

  it("links each transition's sound by id, by sound name, by built-in slug or by a builtin: reference", () => {
    const parsed = parse({
      sounds: [
        { id: "sfx_w", name: "Big Whoosh", builtInId: "soft-whoosh" },
        { name: "Pop", builtInId: "subtle-pop" },
      ],
      transitions: [
        { name: "By id", type: "push", soundId: "sfx_w" },
        { name: "By name", type: "slide", sound: "big whoosh" },
        { name: "By saved built-in", type: "whip", sound: "subtle-pop" },
        { name: "By other built-in", type: "dissolve", sound: "crisp-tick" },
        { name: "By unknown builtin ref", type: "dissolve", soundId: "builtin:future-sound" },
        { name: "By nothing known", type: "dissolve", sound: "kazoo" },
      ],
    });
    expect(parsed!.transitions!.map(t => [t.name, t.soundId])).toEqual([
      ["By id", "sfx_w"],
      ["By name", "sfx_w"],
      ["By saved built-in", "sfx_subtle_pop"],
      ["By other built-in", "builtin:crisp-tick"],
      ["By unknown builtin ref", "builtin:future-sound"],
      ["By nothing known", undefined],
    ]);
  });

  it("fills transition defaults, keeps a dip colour, gives repeated or unnamed ids fresh ones, and keeps one default", () => {
    const parsed = parse({
      transitions: [
        { id: "tr_mine", name: "Dip to black", type: "dip", color: "#000000", isDefault: true, usageRule: "Between acts" },
        { id: "tr_mine", name: "Dip to black", type: "dip", isDefault: true },
        { name: "!!!", type: "push", duration: 1.5, direction: "up" },
      ],
    });
    expect(parsed!.transitions).toEqual([
      { id: "tr_mine", name: "Dip to black", type: "dip", duration: 0.4, direction: "left", color: "#000000", usageRule: "Between acts", isDefault: true },
      { id: "tr_dip_to_black", name: "Dip to black", type: "dip", duration: 0.4, direction: "left", usageRule: "", isDefault: false },
      { id: "tr_3", name: "!!!", type: "push", duration: 1.5, direction: "up", usageRule: "", isDefault: false },
    ]);
  });

  it("clears the color look with null, fills unset sliders, and keeps a LUT only when its file is in the guide", () => {
    expect(parse({ colorLook: null })).toEqual({ colorLook: null });
    expect(parse({ colorLook: {} })!.colorLook).toEqual({
      name: "",
      notes: "",
      adjustments: { exposure: 0, contrast: 1, saturation: 1, warmth: 0, tint: 0, shadows: 0, highlights: 0, blacks: 0, whites: 0, gamma: 1 },
    });
    const look = { name: "Warm", lutAssetId: "sga_lut", lutName: "Warm.cube", adjustments: { warmth: 0.3 } };
    expect(parse({ colorLook: look }, { existingAssetIds: new Set(["sga_lut"]) })!.colorLook).toMatchObject({
      name: "Warm", lutAssetId: "sga_lut", lutName: "Warm.cube", adjustments: { warmth: 0.3, contrast: 1 },
    });
    const withoutFile = parse({ colorLook: look })!.colorLook!;
    expect(withoutFile.lutAssetId).toBeUndefined();
    expect(withoutFile.lutName).toBeUndefined();
    expect(parse({ colorLook: { adjustments: { exposure: 9 } } })).toBeNull();
  });
});

describe("exporting a style guide as a portable definition", () => {
  it("leaves out empty caption styles, missing colours, sounds and LUT ids, and keeps custom sounds' asset ids", () => {
    const guide = StyleGuideRecord.parse({
      id: "sg_x",
      name: "bare-look",
      captionStyle: {},
      transitions: [{ id: "tr_1", name: "Fade", type: "dissolve" }],
      sounds: [{ id: "sfx_a", name: "Custom", source: "asset", assetId: "sga_a" }],
    });
    expect(serializeStyleGuideDefinition(guide)).toEqual({
      version: 1,
      name: "bare-look",
      description: "",
      instructions: "",
      transitions: [{ id: "tr_1", name: "Fade", type: "dissolve", duration: 0.4, direction: "left", usageRule: "", isDefault: false }],
      sounds: [{ id: "sfx_a", name: "Custom", source: "asset", assetId: "sga_a", volumeDb: -14, usageRule: "" }],
    });
  });

  it("writes caption style, dip colours, paired sounds and the color look's LUT name but not its asset id", () => {
    const guide = StyleGuideRecord.parse({
      id: "sg_y",
      name: "full-look",
      captionStyle: { fontFamily: "Inter", uppercase: true },
      transitions: [{ id: "tr_d", name: "Dip", type: "dip", color: "#FFFFFF", soundId: "sfx_b" }],
      sounds: [{ id: "sfx_b", name: "Pop", source: "builtin", builtInId: "subtle-pop", duration: 0.18 }],
      colorLook: { name: "Cool", lutAssetId: "sga_lut", lutName: "Cool.cube", adjustments: { tint: 0.1 } },
    });
    const out = serializeStyleGuideDefinition(guide);
    expect(out.captionStyle).toEqual({ fontFamily: "Inter", uppercase: true });
    expect(out.transitions).toEqual([expect.objectContaining({ color: "#FFFFFF", soundId: "sfx_b" })]);
    expect(out.sounds).toEqual([{ id: "sfx_b", name: "Pop", source: "builtin", builtInId: "subtle-pop", volumeDb: -14, duration: 0.18, usageRule: "" }]);
    expect(out.colorLook).toEqual({ name: "Cool", notes: "", lutName: "Cool.cube", adjustments: expect.objectContaining({ tint: 0.1 }) });

    // Re-imported elsewhere, the paired built-in sound still links up.
    const again = parseStyleGuideDefinitionJson(JSON.stringify(out))!;
    expect(again.transitions![0]!.soundId).toBe("sfx_b");
    expect(again.colorLook!.lutName).toBeUndefined();
  });
});
