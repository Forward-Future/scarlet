import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createProject, emptyTimeline } from "@scarlet/timeline";
import { buildCaptionDrawtexts, wrapText } from "./graphCaptions.js";
import { resolveFontFile } from "./fonts.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("wraps a caption written without spaces between characters, never inside one, and counts wide characters double", () => {
  const cjk = "这是一个很长的字幕用来测试换行功能是否正常工作以及画面边缘";
  const lines = wrapText(cjk, 20).split("\n");
  // Twenty half-em units is ten Chinese characters a line.
  expect(lines.map(l => [...l].length)).toEqual([10, 10, 9]);
  expect(lines.join("")).toBe(cjk);
  // An emoji is one character: it is never split, and its width is a full em.
  const party = wrapText("Great job 🎉🎉🎉", 11).split("\n");
  expect(party).toEqual(["Great job", "🎉🎉🎉"]);
  expect(party.every(l => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(l))).toBe(true);
  // Latin text wraps by words as before.
  expect(wrapText("one two three four", 9)).toBe("one two\nthree\nfour");
});

it("picks a font with Chinese, Japanese, Korean or Thai glyphs for such a caption when its family isn't installed", () => {
  // Font files come back by their real path: on a Mac the temporary folder is /var, a link to /private/var.
  const fonts = realpathSync(mkdtempSync(join(tmpdir(), "scarlet-fonts-")));
  dirs.push(fonts);
  writeFileSync(join(fonts, "arial.ttf"), "");
  writeFileSync(join(fonts, "msyh.ttc"), "");
  const opts = { fontDirs: [fonts] };
  expect(resolveFontFile("No Such Family", opts, true)).toEqual({ file: join(fonts, "msyh.ttc"), exact: false });
  expect(resolveFontFile("No Such Family", opts, false)).toEqual({ file: join(fonts, "arial.ttf"), exact: false });
});

it("resolves nested style guide custom font files and matches requested caption font weights without stale cache", async () => {
  const lib = realpathSync(mkdtempSync(join(tmpdir(), "scarlet-sg-fonts-")));
  dirs.push(lib);
  const opts = { fontDirs: [lib] };

  // Initially empty: no match for our custom family.
  expect(resolveFontFile("BrandSans", opts, false, "bold").exact).toBe(false);

  // Add regular and bold fonts inside a style guide asset folder (3 levels deep: <sgId>/assets/<assetId>/<font>.ttf).
  const assetRegular = join(lib, "sg_1", "assets", "sga_reg");
  const assetBold = join(lib, "sg_1", "assets", "sga_bold");
  mkdirSync(assetRegular, { recursive: true });
  mkdirSync(assetBold, { recursive: true });
  const regularPath = join(assetRegular, "BrandSans-Regular.ttf");
  const boldPath = join(assetBold, "BrandSans-Bold.ttf");
  writeFileSync(regularPath, "");
  writeFileSync(boldPath, "");

  // Freshly added files resolve immediately (no stale cache) and honor fontWeight.
  expect(resolveFontFile("BrandSans", opts, false, "bold")).toEqual({ file: boldPath, exact: true });
  expect(resolveFontFile("BrandSans", opts, false, "normal")).toEqual({ file: regularPath, exact: true });
  expect(resolveFontFile("BrandSans Bold", opts, false)).toEqual({ file: boldPath, exact: true });
  expect(resolveFontFile("BrandSans-Bold.ttf", opts, false)).toEqual({ file: boldPath, exact: true });

  // Caption drawtext generation wires the resolved custom font file into FFmpeg drawtext without needing system drawtext.
  const project = createProject("Captions", { width: 1920, height: 1080, fps: 30, aspect: "16:9" });
  const tl = emptyTimeline(project.id);
  tl.tracks.push({
    id: "cap1",
    kind: "caption",
    name: "Captions",
    muted: false,
    hidden: false,
    captionStyle: { fontFamily: "BrandSans", fontWeight: "bold", color: "#FFFFFF", backgroundColor: "#000000CC", y: 0.85 },
    clips: [{ id: "c1", kind: "caption", timelineIn: 0, timelineOut: 2, text: "Hello world", words: [], enabled: true }],
  });
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "scarlet-cap-tmp-")));
  dirs.push(tmp);
  const warnings: string[] = [];
  const drawtexts = await buildCaptionDrawtexts({
    timeline: tl,
    range: { start: 0, end: 2 },
    settings: project.settings,
    width: 1920,
    height: 1080,
    fps: 30,
    sampleRate: 48000,
    tmp,
    fontOpts: { fontDirs: [lib] },
    warn: m => warnings.push(m),
  });
  expect(drawtexts).toHaveLength(1);
  expect(drawtexts[0]).toContain("BrandSans-Bold.ttf");
  expect(warnings).toEqual([]);
});
