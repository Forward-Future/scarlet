import { describe, expect, it } from "vitest";
import {
  BUILT_IN_STYLE_SOUNDS,
  dbToLinearGain,
  findBuiltInStyleSound,
  ImportStyleGuideSoundRequest,
  parseStyleGuideDefinitionJson,
  serializeStyleGuideDefinition,
  StyleGuideRecord,
  synthesizeBuiltInSfxWav,
  TaskStyleGuideDraft,
} from "./index.js";

describe("built-in style guide sound effects", () => {
  it("synthesizes deterministic valid 48 kHz 16-bit PCM WAV buffers for every starter sound", () => {
    expect(BUILT_IN_STYLE_SOUNDS.length).toBeGreaterThanOrEqual(4);
    for (const sound of BUILT_IN_STYLE_SOUNDS) {
      expect(findBuiltInStyleSound(sound.id)).toBe(sound);
      expect(findBuiltInStyleSound(`builtin:${sound.id}`)).toBe(sound);
      const wav1 = synthesizeBuiltInSfxWav(sound.id)!;
      const wav2 = synthesizeBuiltInSfxWav(`builtin:${sound.id}`)!;
      expect(wav1).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(wav1).equals(Buffer.from(wav2))).toBe(true);
      // RIFF / WAVE header checks
      expect(Buffer.from(wav1.subarray(0, 4)).toString("ascii")).toBe("RIFF");
      expect(Buffer.from(wav1.subarray(8, 12)).toString("ascii")).toBe("WAVE");
      const view = new DataView(wav1.buffer, wav1.byteOffset, wav1.byteLength);
      expect(view.getUint16(20, true)).toBe(1); // PCM
      expect(view.getUint32(24, true)).toBe(48_000); // 48 kHz
      expect(view.getUint16(34, true)).toBe(16); // 16-bit
      const expectedSamples = Math.round(sound.duration * 48_000);
      expect(view.getUint32(40, true)).toBe(expectedSamples * 2);
      // Ensure non-silent audio
      let peak = 0;
      for (let i = 44; i + 1 < wav1.byteLength; i += 2) {
        peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
      }
      expect(peak).toBeGreaterThan(20_000);
    }
    expect(synthesizeBuiltInSfxWav("does-not-exist")).toBeUndefined();
  });

  it("converts dB levels to clamped linear gain multipliers", () => {
    expect(dbToLinearGain(0)).toBe(1);
    expect(dbToLinearGain(-6)).toBeCloseTo(0.5012, 3);
    expect(dbToLinearGain(-14)).toBeCloseTo(0.1995, 3);
    expect(dbToLinearGain(-100)).toBe(dbToLinearGain(-48));
  });
});

describe("extended StyleGuideRecord schemas", () => {
  it("defaults transitions and sounds for legacy records and validates transitions, sounds, and color looks", () => {
    const legacy = StyleGuideRecord.parse({
      id: "sg_old",
      name: "legacy-look",
      description: "Legacy visual guide",
      instructions: "Use Inter.",
      isDefault: false,
      assets: [],
    });
    expect(legacy.transitions).toEqual([]);
    expect(legacy.sounds).toEqual([]);
    expect(legacy.colorLook).toBeUndefined();

    const full = StyleGuideRecord.parse({
      id: "sg_full",
      name: "studio-kit",
      transitions: [
        { id: "tr_1", name: "Section push", type: "push", duration: 0.4, direction: "left", soundId: "sfx_1", usageRule: "Default between sections", isDefault: true },
      ],
      sounds: [
        { id: "sfx_1", name: "Soft whoosh", source: "builtin", builtInId: "soft-whoosh", volumeDb: -14, duration: 0.45, usageRule: "Paired with push transitions" },
      ],
      colorLook: {
        name: "Warm studio",
        notes: "Gentle warmth and soft highlight rolloff",
        lutAssetId: "sga_cube",
        lutName: "StudioWarm.cube",
        adjustments: { exposure: 0.15, warmth: 0.25, highlights: -0.2 },
      },
    });
    expect(full.transitions[0]!.type).toBe("push");
    expect(full.colorLook!.adjustments).toMatchObject({ exposure: 0.15, contrast: 1, saturation: 1, warmth: 0.25, highlights: -0.2 });

    expect(TaskStyleGuideDraft.safeParse({ colorLook: null }).success).toBe(true);
    expect(ImportStyleGuideSoundRequest.safeParse({ builtInId: "soft-whoosh" }).success).toBe(true);
    expect(ImportStyleGuideSoundRequest.safeParse({}).success).toBe(false);
  });

  it("parses and round-trips portable style definition JSON files, rejecting unrelated JSON", () => {
    const raw = JSON.stringify({
      version: 1,
      name: "Studio Editorial",
      description: "Obsidian cards & warm studio cameras",
      instructions: "## Palette\n- Surface: #141416",
      sounds: [
        { name: "Whoosh", builtInId: "soft-whoosh", volumeDb: -15 },
      ],
      transitions: [
        { name: "Section push", type: "push", duration: 0.4, direction: "left", sound: "Whoosh", usageRule: "Between sections", isDefault: true },
        { name: "Whip", type: "whip", duration: 0.3, sound: "airy-slide", isDefault: true },
      ],
      colorLook: {
        name: "Warm Studio",
        notes: "Gentle warmth and lifted shadows",
        adjustments: { exposure: 0.15, warmth: 0.24, highlights: -0.2 },
      },
    });
    const parsed = parseStyleGuideDefinitionJson(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe("studio-editorial");
    expect(parsed!.sounds).toHaveLength(1);
    expect(parsed!.sounds![0]!).toMatchObject({ source: "builtin", builtInId: "soft-whoosh", volumeDb: -15 });
    expect(parsed!.transitions).toHaveLength(2);
    expect(parsed!.transitions![0]!.soundId).toBe(parsed!.sounds![0]!.id);
    expect(parsed!.transitions![0]!.isDefault).toBe(true);
    // Only the first transition keeps isDefault
    expect(parsed!.transitions![1]!.isDefault).toBe(false);
    expect(parsed!.transitions![1]!.soundId).toBe("builtin:airy-slide");
    expect(parsed!.colorLook!.adjustments).toMatchObject({ exposure: 0.15, warmth: 0.24, highlights: -0.2, contrast: 1 });

    // Round-trip via serializeStyleGuideDefinition
    const full = StyleGuideRecord.parse({
      id: "sg_rt",
      name: parsed!.name!,
      description: parsed!.description,
      instructions: parsed!.instructions,
      transitions: parsed!.transitions,
      sounds: parsed!.sounds,
      colorLook: parsed!.colorLook ?? undefined,
    });
    const exported = JSON.stringify(serializeStyleGuideDefinition(full));
    const reparsed = parseStyleGuideDefinitionJson(exported);
    expect(reparsed).toMatchObject({
      name: "studio-editorial",
      description: "Obsidian cards & warm studio cameras",
      colorLook: { name: "Warm Studio" },
    });

    // Unrelated JSON (e.g. Figma tokens) returns null so Scarlet reads it via chat instead
    expect(parseStyleGuideDefinitionJson(JSON.stringify({ tokens: { brand: "#ff0000" } }))).toBeNull();
    expect(parseStyleGuideDefinitionJson("not json")).toBeNull();
  });
});
