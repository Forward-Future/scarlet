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

/** Greedy word wrap; drawtext does not wrap on its own. */
export function wrapText(text: string, maxChars: number): string {
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let cur = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (cur && cur.length + 1 + word.length > maxChars) {
        lines.push(cur);
        cur = word;
      } else {
        cur = cur ? `${cur} ${word}` : word;
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
      const font = resolveFontFile(style.fontFamily, fontOpts);
      if (font) {
        o.push(`fontfile=${escapeFilterPath(font.file)}`);
        if (!font.exact) warn(`font "${style.fontFamily}" not found; using ${path.basename(font.file)}`);
      } else {
        const family = /^[\p{L}\p{N} _.-]+$/u.test(style.fontFamily) ? style.fontFamily : "sans-serif";
        o.push(`font='${family}'`);
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
