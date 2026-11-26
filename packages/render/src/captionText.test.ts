import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { wrapText } from "./graphCaptions.js";
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
