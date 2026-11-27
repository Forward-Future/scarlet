/**
 * Caption text wrapping, style merging, and FFmpeg `drawtext` filter generation.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { CaptionStyle as CaptionStyleSchema } from "@scarlet/timeline";
import type { CaptionStyle, ProjectSettings, Timeline, TimeRange } from "@scarlet/timeline";
import { escapeFilterPath } from "./effects.js";
import { fnum } from "./exec.js";
import { resolveFontFile, type FontOptions } from "./fonts.js";
import { FRAME_SLACK, clipPlacement, ffColor, holdsFrame } from "./graphTransform.js";

/** Characters about a full em wide (Chinese, Japanese, Korean, full-width forms, emoji); others count half. */
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF01-\uFF60\uFFE0-\uFFE6]|\p{Extended_Pictographic}/u;
/** Scripts the fallback Latin fonts have no glyphs for. */
export const NEEDS_WIDE_FONT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;
const graphemes = (s: string) => Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s), g => g.segment);
/** A run's width in half-em units: a character as the eye sees it, an emoji or a CJK character two. */
const units = (s: string) => graphemes(s).reduce((n, g) => n + (WIDE.test(g) ? 2 : 1), 0);

/**
 * Greedy word wrap; drawtext does not wrap on its own. Widths are counted per character as seen, a wide one double,
 * and a word too long for a line (as Chinese, Japanese and Thai are written, without spaces) breaks between
 * characters, never inside one.
 */
export function wrapText(text: string, maxChars: number): string {
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let cur = "";
    let width = 0;
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const w = units(word);
      if (w > maxChars) {
        if (cur) lines.push(cur);
        cur = ""; width = 0;
        for (const g of graphemes(word)) {
          const gw = units(g);
          if (cur && width + gw > maxChars) { lines.push(cur); cur = ""; width = 0; }
          cur += g; width += gw;
        }
      } else if (cur && width + 1 + w > maxChars) {
        lines.push(cur);
        cur = word; width = w;
      } else {
        cur = cur ? `${cur} ${word}` : word;
        width += (width ? 1 : 0) + w;
      }
    }
    lines.push(cur);
  }
  return lines.join("\n");
}

function mergeCaptionStyle(
  ...layers: Array<Partial<CaptionStyle> | undefined>
): CaptionStyle {
  const merged: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) if (v !== undefined) merged[k] = v;
  }
  return CaptionStyleSchema.parse(merged);
}

export interface CaptionDrawOptions {
  timeline: Timeline;
  range: TimeRange;
  settings: ProjectSettings;
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
  tmp: string;
  fontOpts: FontOptions;
  warn: (message: string) => void;
}

/** Write wrapped caption text files and build the FFmpeg `drawtext` filter list. */
export async function buildCaptionDrawtexts(opts: CaptionDrawOptions): Promise<string[]> {
  const { timeline, range, settings, width: W, height: H, fps, sampleRate: SR, tmp, fontOpts, warn } = opts;
  let captionN = 0;
  const drawtexts: string[] = [];
  for (const track of timeline.tracks) {
    if (track.kind !== "caption" || track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "caption" || clip.enabled === false) continue;
      const p = clipPlacement(clip, range, 0.5 / SR);
      if (!p || !holdsFrame(p, fps)) continue;
      const style = mergeCaptionStyle(timeline.captionStyle, track.captionStyle, clip.style);
      const fontsize = Math.max(1, Math.round(style.fontSize * H));
      const text = style.uppercase ? clip.text.toUpperCase() : clip.text;
      // ~0.5em average glyph width; good enough to keep lines inside maxWidth.
      const maxChars = Math.max(1, Math.floor((style.maxWidth * W) / (fontsize * 0.5)));
      const textFile = path.join(tmp, `caption-${captionN++}.txt`);
      await fs.writeFile(textFile, wrapText(text, maxChars), "utf8");

      const o: string[] = [];
      const font = resolveFontFile(style.fontFamily, fontOpts, NEEDS_WIDE_FONT.test(text), style.fontWeight);
      // drawtext draws in one font and in one colour: an emoji comes out as a box or blank in the export.
      if (/\p{Extended_Pictographic}/u.test(text)) warn("a caption has emoji, which exported captions draw as boxes or leave out");
      if (font) {
        o.push(`fontfile=${escapeFilterPath(font.file)}`);
        if (!font.exact) warn(`font "${style.fontFamily}" not found; using ${path.basename(font.file)}`);
      } else {
        const family = /^[\p{L}\p{N} _.-]+$/u.test(style.fontFamily) ? style.fontFamily : "sans-serif";
        const weightStyle = style.fontWeight && style.fontWeight !== "normal"
          ? `:style=${style.fontWeight === "semibold" ? "SemiBold" : style.fontWeight.charAt(0).toUpperCase() + style.fontWeight.slice(1)}`
          : "";
        o.push(`font='${family}${weightStyle}'`);
        warn(`no font file found for "${style.fontFamily}"; relying on fontconfig`);
      }
      o.push(`textfile=${escapeFilterPath(textFile)}`, "expansion=none");
      o.push(`fontsize=${fontsize}`, `fontcolor=${ffColor(style.color)}`, `line_spacing=${Math.round(fontsize * 0.2)}`);
      if (style.backgroundColor) {
        o.push("box=1", `boxcolor=${ffColor(style.backgroundColor)}`, `boxborderw=${Math.round(fontsize * 0.25)}`);
      }
      if (style.outlineWidth > 0) {
        // < 1 reads as a fraction of the font size, otherwise pixels at project resolution.
        const px = style.outlineWidth < 1 ? style.outlineWidth * fontsize : (style.outlineWidth * H) / settings.height;
        o.push(`borderw=${Math.max(1, Math.round(px))}`, `bordercolor=${ffColor(style.outlineColor ?? "#000000")}`);
      }
      const margin = Math.round(((1 - style.maxWidth) / 2) * W);
      o.push(
        `x=${style.align === "left" ? margin : style.align === "right" ? `w-text_w-${margin}` : "(w-text_w)/2"}`,
        `y=${fnum(style.y * H)}-text_h/2`,
        `enable='between(t,${fnum(p.pos - FRAME_SLACK)},${fnum(p.pos + p.vis - FRAME_SLACK)})'`,
      );
      if (style.highlightColor && clip.words?.length) {
        warn("per-word caption highlighting is not supported by the ffmpeg renderer; captions drawn without highlight");
      }
      drawtexts.push(`drawtext=${o.join(":")}`);
    }
  }
  return drawtexts;
}
