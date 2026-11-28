import colors from "color-name";
import { parseColor } from "./color.js";
import { CaptionStyle, type CaptionClip, type Timeline, type Track } from "./timelineSchema.js";
import type { Project } from "./projectSchema.js";

function assColor(value: string, fallback: string): string {
  const parsed = parseColor(value);
  if (!parsed) return fallback;
  const named = colors[parsed.color as keyof typeof colors];
  const rgb = named ? named.map(byte => byte.toString(16).padStart(2, "0")).join("") : parsed.color.slice(2);
  if (!/^[0-9a-f]{6}$/i.test(rgb)) return fallback;
  const alpha = Math.round((1 - parsed.alpha) * 255).toString(16).padStart(2, "0");
  return `&H${alpha}${rgb.slice(4)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`.toUpperCase();
}

function clock(cs: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${Math.floor(cs / 360000)}:${pad(Math.floor(cs / 6000) % 60)}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`;
}

/** An editable ASS companion to the plain SubRip in a handoff folder. */
export function styledCaptionFile(project: Project, timeline: Timeline, track: Track, cues: CaptionClip[]): string | undefined {
  if (!timeline.captionStyle && !track.captionStyle && !cues.some(c => c.style)) return;
  const { width, height } = project.settings;
  const styles = new Map<string, string>();
  const events: string[] = [];
  for (const cue of cues) {
    const start = Math.round(cue.timelineIn * 100), end = Math.round(cue.timelineOut * 100);
    if (end <= start) continue;
    const style = CaptionStyle.parse({ ...timeline.captionStyle, ...track.captionStyle, ...cue.style });
    const size = Math.max(1, Math.round(style.fontSize * height));
    const margin = Math.round(width * (1 - style.maxWidth) / 2);
    const alignment = style.align === "left" ? 4 : style.align === "right" ? 6 : 5;
    const x = alignment === 4 ? margin : alignment === 6 ? width - margin : Math.round(width / 2);
    const outline = style.outlineWidth < 1 ? style.outlineWidth * size : style.outlineWidth;
    const family = style.fontFamily.replace(/[,\r\n]/g, " ").trim() || "Arial";
    const foreground = assColor(style.color, "&H00FFFFFF");
    const border = assColor(style.backgroundColor ?? style.outlineColor ?? "black", "&H00000000");
    const bold = ["semibold", "bold", "black"].includes(style.fontWeight ?? "");
    const fields = [family, size, foreground, foreground, border, border, bold ? -1 : 0,
      0, 0, 0, 100, 100, 0, 0, style.backgroundColor ? 3 : 1, style.backgroundColor ? Math.max(1, size / 4) : outline,
      0, alignment, margin, margin, 0, 1].join(",");
    const name = styles.get(fields) ?? `Caption${styles.size + 1}`;
    styles.set(fields, name);
    // Keep user text outside ASS override syntax, including a literal backslash followed by N.
    const text = (style.uppercase ? cue.text.toUpperCase() : cue.text)
      .replace(/\\/g, "\\\u2060").replace(/[{}]/g, c => "\\" + c).replace(/\r\n?|\n/g, "\\N");
    events.push(`Dialogue: 0,${clock(start)},${clock(end)},${name},,0,0,0,,{\\pos(${x},${Math.round(height * style.y)})}${text}`);
  }
  if (!events.length) return;
  return [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${width}`, `PlayResY: ${height}`, "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]", "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...Array.from(styles, ([fields, name]) => `Style: ${name},${fields}`), "",
    "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text", ...events, "",
  ].join("\n");
}
