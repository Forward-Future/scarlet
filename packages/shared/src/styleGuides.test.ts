import { describe, expect, it } from "vitest";
import {
  BUILT_IN_STYLE_SOUNDS,
  dbToLinearGain,
  findBuiltInStyleSound,
  ImportStyleGuideSoundRequest,
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
});
