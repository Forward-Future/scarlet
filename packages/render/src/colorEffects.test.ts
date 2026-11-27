import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProject, makeMediaClip, type Timeline } from "@scarlet/timeline";
import { effectFilters, lutFileStamps, resolveFfmpeg, resolveLutFile, runCapture } from "./index.js";

let dir: string;
let mediaRoot: string;
let styleGuidesRoot: string;

beforeAll(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "scarlet-color-effects-")));
  mediaRoot = path.join(dir, "media");
  styleGuidesRoot = path.join(dir, "style-guides");
  await fs.mkdir(mediaRoot, { recursive: true });
  await fs.mkdir(path.join(styleGuidesRoot, "sg_brand", "assets", "sga_lut"), { recursive: true });
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function sampleGray(colorHex: string, filters: string[]): Promise<[number, number, number]> {
  const chain = filters.length ? `,${filters.join(",")}` : "";
  const { stdout } = await runCapture(resolveFfmpeg(), [
    "-v", "error", "-f", "lavfi", "-i", `color=${colorHex}:s=8x8:d=0.1${chain}`,
    "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
  ]);
  return [stdout[0]!, stdout[1]!, stdout[2]!];
}

describe("video color grading effects", () => {
  it("keeps legacy color effect output identical when only eq parameters are supplied", () => {
    const filters = effectFilters(
      [{ type: "color", enabled: true, params: { brightness: 0.05, contrast: 1.1, saturation: 1.2, gamma: 0.95 } }],
      "video",
      { mediaRoot, warn: () => {} },
    );
    expect(filters).toEqual(["eq=brightness=0.05:contrast=1.1:saturation=1.2:gamma=0.95"]);
  });

  it("applies exposure, warmth/tint white balance, and shadows/highlights curves through FFmpeg", async () => {
    const baseMid = await sampleGray("0x808080", []);
    const baseDark = await sampleGray("0x404040", []);
    const baseBright = await sampleGray("0xc0c0c0", []);

    // Exposure +0.5 EV brightens neutral mid-gray
    const brighter = await sampleGray(
      "0x808080",
      effectFilters([{ type: "exposure", enabled: true, params: { exposure: 0.5 } }], "video", { mediaRoot, warn: () => {} }),
    );
    expect(brighter[0]).toBeGreaterThan(baseMid[0] + 25);

    // Warmth > 0 shifts red above blue; warmth < 0 shifts blue above red
    const warmer = await sampleGray(
      "0x808080",
      effectFilters([{ type: "whiteBalance", enabled: true, params: { warmth: 0.6 } }], "video", { mediaRoot, warn: () => {} }),
    );
    expect(warmer[0]).toBeGreaterThan(warmer[2] + 10);

    const cooler = await sampleGray(
      "0x808080",
      effectFilters([{ type: "whiteBalance", enabled: true, params: { warmth: -0.6 } }], "video", { mediaRoot, warn: () => {} }),
    );
    expect(cooler[2]).toBeGreaterThan(cooler[0] + 10);

    // Tint > 0 reduces green relative to red/blue (magenta shift)
    const magenta = await sampleGray(
      "0x808080",
      effectFilters([{ type: "whiteBalance", enabled: true, params: { tint: 0.7 } }], "video", { mediaRoot, warn: () => {} }),
    );
    expect(magenta[0]).toBeGreaterThan(magenta[1] + 8);
    expect(magenta[2]).toBeGreaterThan(magenta[1] + 8);

    // Shadows lift raises dark gray while leaving mid-gray near neutral; highlights recovery pulls bright gray down
    const toneFilters = effectFilters(
      [{ type: "shadowsHighlights", enabled: true, params: { shadows: 0.8, highlights: -0.8 } }],
      "video",
      { mediaRoot, warn: () => {} },
    );
    const liftedDark = await sampleGray("0x404040", toneFilters);
    const pulledBright = await sampleGray("0xc0c0c0", toneFilters);
    expect(liftedDark[0]).toBeGreaterThan(baseDark[0] + 12);
    expect(pulledBright[0]).toBeLessThan(baseBright[0] - 12);

    // Extended unified `color` effect composes exposure + shadows/highlights + eq + whiteBalance reliably
    const combined = effectFilters(
      [{
        type: "color",
        enabled: true,
        params: { exposure: 0.2, contrast: 1.08, saturation: 1.1, warmth: 0.4, tint: -0.1, shadows: 0.3, highlights: -0.2 },
      }],
      "video",
      { mediaRoot, warn: () => {} },
    );
    expect(combined).toHaveLength(4);
    const graded = await sampleGray("0x808080", combined);
    expect(graded[0]).toBeGreaterThan(graded[2] + 5);
  });

  it("supports kelvin white balance and three-way colorBalance", async () => {
    const warmK = await sampleGray(
      "0x808080",
      effectFilters([{ type: "whiteBalance", enabled: true, params: { kelvin: 4500 } }], "video", { mediaRoot, warn: () => {} }),
    );
    expect(warmK[0]).toBeGreaterThan(warmK[2] + 10);

    const cbMid = await sampleGray(
      "0x505050",
      effectFilters([{ type: "colorBalance", enabled: true, params: { midtones: [0.3, -0.1, -0.2] } }], "video", { mediaRoot, warn: () => {} }),
    );
    expect(cbMid[0]).toBeGreaterThan(cbMid[2] + 10);

    const cbHigh = await sampleGray(
      "0xa0a0a0",
      effectFilters([{ type: "colorBalance", enabled: true, params: { highlights: [0.25, 0, -0.25] } }], "video", { mediaRoot, warn: () => {} }),
    );
    expect(cbHigh[0]).toBeGreaterThan(cbHigh[2] + 10);
  });
});

describe("style guide LUT resolution and containment", () => {
  it("resolves .cube/.3dl LUTs from style guide roots, fingerprints them, and blocks traversal or non-LUT files", async () => {
    const lutDir = path.join(styleGuidesRoot, "sg_brand", "assets", "sga_lut");
    const cubeFile = path.join(lutDir, "studio-warm.cube");
    const txtFile = path.join(lutDir, "notes.txt");
    const outsideCube = path.join(dir, "outside.cube");
    const identityCube = "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n";
    await fs.writeFile(cubeFile, identityCube);
    await fs.writeFile(txtFile, "not a lut");
    await fs.writeFile(outsideCube, identityCube);

    // Portable relative path under styleGuidesRoot AND absolute path inside styleGuidesRoot both work
    const rel = "sg_brand/assets/sga_lut/studio-warm.cube";
    expect(resolveLutFile(rel, mediaRoot, [styleGuidesRoot])).toBe(await fs.realpath(cubeFile));
    expect(resolveLutFile(cubeFile, mediaRoot, [styleGuidesRoot])).toBe(await fs.realpath(cubeFile));

    // Renders through FFmpeg lut3d cleanly
    const filters = effectFilters(
      [{ type: "lut", enabled: true, params: { file: rel } }],
      "video",
      { mediaRoot, lutRoots: [styleGuidesRoot], warn: () => {} },
    );
    const px = await sampleGray("0xff0000", filters);
    expect(px[0]).toBeGreaterThan(240);
    expect(px[1]).toBeLessThan(10);

    // Blocks traversal, outside absolute paths, non-LUT extensions, and escaping symlinks
    expect(resolveLutFile("../outside.cube", mediaRoot, [styleGuidesRoot])).toBeUndefined();
    expect(resolveLutFile(outsideCube, mediaRoot, [styleGuidesRoot])).toBeUndefined();
    expect(resolveLutFile("sg_brand/assets/sga_lut/notes.txt", mediaRoot, [styleGuidesRoot])).toBeUndefined();
    const escapeLink = path.join(lutDir, "escape.cube");
    await fs.symlink(outsideCube, escapeLink);
    expect(resolveLutFile("sg_brand/assets/sga_lut/escape.cube", mediaRoot, [styleGuidesRoot])).toBeUndefined();
    expect(() =>
      effectFilters([{ type: "lut", enabled: true, params: { file: "../outside.cube" } }], "video", { mediaRoot, lutRoots: [styleGuidesRoot], warn: () => {} }),
    ).toThrow(/project media/);

    // lutFileStamps includes style guide LUT stamps for segment cache invalidation
    const project = createProject("LUT stamp");
    const timeline: Timeline = {
      version: "v1",
      parent: null,
      projectId: project.id,
      name: "Main",
      background: "#000000",
      markers: [],
      tracks: [{
        id: "v1",
        kind: "video",
        name: "V1",
        muted: false,
        hidden: false,
        clips: [makeMediaClip("m1", 0, 2, 0, { effects: [{ type: "lut", enabled: true, params: { file: rel } }] })],
      }],
    };
    const stamps = lutFileStamps(timeline, mediaRoot, [styleGuidesRoot]);
    expect(stamps).toHaveLength(1);
    expect(stamps[0]![1]).not.toBeNull();
  });
});
