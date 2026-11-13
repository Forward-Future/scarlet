import { describe, expect, it } from "vitest";
import { parseColor } from "./color.js";
import { RenderColor } from "./schema.js";

describe("parseColor", () => {
  it("reads a named color in any case, with space around it", () => {
    expect(parseColor("red")).toEqual({ color: "red", alpha: 1, explicitAlpha: false });
    expect(parseColor("  DarkSlateGray ")).toEqual({ color: "darkslategray", alpha: 1, explicitAlpha: false });
    expect(parseColor("random")?.color).toBe("random");
    expect(parseColor("rebeccapurple")).toBeUndefined();
  });

  it("reads six- and eight-digit hex with or without a prefix, the last two digits as alpha", () => {
    expect(parseColor("#1a2b3c")).toEqual({ color: "0x1A2B3C", alpha: 1, explicitAlpha: false });
    expect(parseColor("0x1A2B3C")?.color).toBe("0x1A2B3C");
    expect(parseColor("1a2b3c")?.color).toBe("0x1A2B3C");
    expect(parseColor("#00000080")).toEqual({ color: "0x000000", alpha: 128 / 255, explicitAlpha: false });
    expect(parseColor("#000000AA")?.alpha).toBeCloseTo(2 / 3, 10);
  });

  it("doubles each digit of three- and four-digit hex, which needs its prefix", () => {
    expect(parseColor("#f0a")).toEqual({ color: "0xFF00AA", alpha: 1, explicitAlpha: false });
    expect(parseColor("0xF0A")?.color).toBe("0xFF00AA");
    expect(parseColor("#f0a8")).toEqual({ color: "0xFF00AA", alpha: 0x88 / 255, explicitAlpha: false });
    // Without a prefix three letters could be a word, and "bad" is not a color.
    expect(parseColor("f0a")).toBeUndefined();
    expect(parseColor("bad")).toBeUndefined();
  });

  it("refuses hex of any other length or with other characters", () => {
    for (const bad of ["", "#", "#1", "#12", "#12345", "#1234567", "#123456789", "#12345g", "0x", "##fff", "#ff ff ff"]) {
      expect(parseColor(bad), bad).toBeUndefined();
    }
  });

  it("takes an @alpha from 0 to 1, as a decimal or as hex out of 255, over any alpha in the color itself", () => {
    expect(parseColor("red@0.4")).toEqual({ color: "red", alpha: 0.4, explicitAlpha: true });
    expect(parseColor("red@.5")?.alpha).toBe(0.5);
    expect(parseColor("red@1.")?.alpha).toBe(1);
    expect(parseColor("red@1e-1")?.alpha).toBe(0.1);
    expect(parseColor("red@+0")?.alpha).toBe(0);
    expect(parseColor(" red@ 0.25 ")).toEqual({ color: "red", alpha: 0.25, explicitAlpha: true });
    expect(parseColor("red@0x80")?.alpha).toBe(128 / 255);
    expect(parseColor("red@0xFF")?.alpha).toBe(1);
    expect(parseColor("#00000080@0.25")).toEqual({ color: "0x000000", alpha: 0.25, explicitAlpha: true });
  });

  it("refuses an alpha outside 0 to 1, one that isn't a number, and a second @", () => {
    for (const bad of ["red@1.01", "red@-0.1", "red@2", "red@0x100", "red@1e3", "red@", "red@half", "red@0x", "red@0.5@1", "red@0.5,negate", "red@NaN", "red@Infinity", "red @0.5"]) {
      expect(parseColor(bad), bad).toBeUndefined();
    }
  });

  it("is what a clip's or a timeline's color is checked with, so filter syntax never reaches FFmpeg", () => {
    for (const ok of ["black", "#FFF", "#000000AA", "white@0.5"]) expect(RenderColor.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["red,negate", "red:x=1", "red;null", "[in]red", "red'"]) expect(RenderColor.safeParse(bad).success, bad).toBe(false);
  });
});
