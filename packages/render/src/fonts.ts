/**
 * Font file lookup for drawtext. ffmpeg builds on Windows commonly ship
 * without a working fontconfig, so `font=Family` fails; passing an explicit
 * `fontfile=` always works. We index the OS font directories once and match
 * the requested family by filename, falling back to a sans-serif that exists.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileInDirectory } from "./assetPath.js";
import { escapeFilterPath } from "./effects.js";

export interface FontOptions {
  /** Use this font file for every caption, skipping family lookup. */
  fontFile?: string;
  /** Extra directories to search before the OS defaults. */
  fontDirs?: string[];
}

export interface ResolvedFont {
  file: string;
  /** False when a fallback was used instead of the requested family. */
  exact: boolean;
}

const FONT_EXTS = new Set([".ttf", ".otf", ".ttc"]);

const FALLBACKS = [
  "arial.ttf",
  "segoeui.ttf",
  "calibri.ttf",
  "dejavusans.ttf",
  "liberationsans-regular.ttf",
  "notosans-regular.ttf",
  "freesans.ttf",
  "helvetica.ttc",
  "arial unicode.ttf",
];

/** Fonts with Chinese, Japanese, Korean and Thai glyphs, for a caption in those scripts when its family isn't here. */
const WIDE_FALLBACKS = [
  "arial unicode.ttf",
  "pingfang.ttc",
  "hiragino sans gb.ttc",
  "applesdgothicneo.ttc",
  "msyh.ttc",
  "msyh.ttf",
  "yugothm.ttc",
  "meiryo.ttc",
  "malgun.ttf",
  "notosanscjk-regular.ttc",
  "notosanscjksc-regular.otf",
  "wqy-microhei.ttc",
  "droidsansfallbackfull.ttf",
  "tahoma.ttf",
];

function defaultFontDirs(): string[] {
  const home = os.homedir();
  const dirs: string[] = [];
  if (process.platform === "win32") {
    dirs.push(path.join(process.env.WINDIR ?? "C:\\Windows", "Fonts"));
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts"));
  } else if (process.platform === "darwin") {
    dirs.push("/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts", path.join(home, "Library/Fonts"));
  } else {
    dirs.push("/usr/share/fonts", "/usr/local/share/fonts", path.join(home, ".fonts"), path.join(home, ".local/share/fonts"));
  }
  return dirs.filter((d) => {
    try {
      return fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
}

const indexCache = new Map<string, Map<string, string>>();

/** Lower-cased basename → full path for every font file under `dir` (4 levels deep, covering style guide asset dirs). */
function indexDir(dir: string, cache = true): Map<string, string> {
  if (cache) {
    const cached = indexCache.get(dir);
    if (cached) return cached;
  }
  const index = new Map<string, string>();
  const walk = (d: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 4) walk(full, depth + 1);
      } else if (FONT_EXTS.has(path.extname(e.name).toLowerCase())) {
        const key = e.name.toLowerCase();
        if (!index.has(key)) index.set(key, full);
      }
    }
  };
  walk(dir, 0);
  if (cache) indexCache.set(dir, index);
  return index;
}

function lookup(dirs: Array<{ dir: string; cache: boolean }>, names: string[]): string | undefined {
  for (const { dir, cache } of dirs) {
    const index = indexDir(dir, cache);
    for (const n of names) {
      const hit = index.get(n);
      if (hit) {
        const file = fileInDirectory(dir, hit);
        if (file) return file;
      }
    }
  }
  return undefined;
}

export type CaptionFontWeight = "normal" | "medium" | "semibold" | "bold" | "black";

const WEIGHT_SUFFIXES: Record<CaptionFontWeight, readonly string[]> = {
  normal: ["", "-regular", "regular", "_regular", "-medium", "-book"],
  medium: ["-medium", "medium", "_medium", "-med", "", "-regular", "regular"],
  semibold: ["-semibold", "semibold", "_semibold", "-demibold", "demibold", "-bold", "bold", ""],
  bold: ["-bold", "bold", "_bold", "bd", "b", "-semibold", "-heavy", "-medium", ""],
  black: ["-black", "black", "_black", "-heavy", "heavy", "-extrabold", "extrabold", "-bold", "bold", ""],
};

const TRAILING_WEIGHT = /\s+(black|heavy|extrabold|semibold|demibold|bold|medium|regular|normal)$/i;

function inferredWeight(family: string, weight?: CaptionFontWeight): { stem: string; weight?: CaptionFontWeight } {
  const trimmed = family.trim();
  if (weight) return { stem: trimmed, weight };
  const match = TRAILING_WEIGHT.exec(trimmed);
  if (!match) return { stem: trimmed };
  const word = match[1]!.toLowerCase();
  const mapped: CaptionFontWeight = word === "black" || word === "heavy" || word === "extrabold"
    ? "black"
    : word === "semibold" || word === "demibold"
      ? "semibold"
      : word === "bold"
        ? "bold"
        : word === "medium"
          ? "medium"
          : "normal";
  return { stem: trimmed.slice(0, match.index).trim(), weight: mapped };
}

/** Candidate file names for a family and optional weight, e.g. ("Inter", "bold") → inter-bold.ttf, interbold.ttf, ... */
function candidates(family: string, weight?: CaptionFontWeight): string[] {
  const raw = family.trim().toLowerCase();
  const { stem, weight: effective } = inferredWeight(family, weight);
  const base = stem.toLowerCase();
  const compact = base.replace(/\s+/g, "");
  const hyphen = base.replace(/\s+/g, "-");
  const suffixes = effective ? WEIGHT_SUFFIXES[effective] : WEIGHT_SUFFIXES.normal;
  const out: string[] = [];
  const add = (name: string) => { if (!out.includes(name)) out.push(name); };
  // If the caller already named a hyphenated/compound file stem (e.g. "Montserrat-Bold"), try it directly first.
  if (raw !== base) {
    for (const s of new Set([raw, raw.replace(/\s+/g, "-"), raw.replace(/\s+/g, "")])) {
      for (const ext of [".ttf", ".otf", ".ttc"]) add(`${s}${ext}`);
    }
  }
  for (const s of new Set([base, compact, hyphen])) {
    for (const suffix of suffixes) {
      for (const ext of [".ttf", ".otf", ".ttc"]) add(`${s}${suffix}${ext}`);
    }
  }
  return out;
}

/**
 * Find a font file for `family`. Returns undefined only when no font at all
 * could be found, in which case callers should fall back to `font=` and hope
 * fontconfig is present.
 */
export function resolveFontFile(
  family: string,
  opts: FontOptions = {},
  wideScript = false,
  weight?: CaptionFontWeight,
): ResolvedFont | undefined {
  if (opts.fontFile) return { file: opts.fontFile, exact: true };
  // Custom directories (style guide assets, project attachments) can gain new fonts at runtime, so scan them fresh.
  const customDirs = (opts.fontDirs ?? []).map(dir => ({ dir: path.resolve(dir), cache: false }));
  const osDirs = defaultFontDirs().map(dir => ({ dir: path.resolve(dir), cache: true }));
  const dirs = [...customDirs, ...osDirs];
  // Timeline font paths may only select files in configured font directories.
  if (FONT_EXTS.has(path.extname(family).toLowerCase())) {
    for (const { dir } of dirs) {
      const file = fileInDirectory(dir, family);
      if (file) return { file, exact: true };
    }
    // Allow matching a bare filename (e.g. "Montserrat-Bold.ttf") inside configured font dirs.
    const byName = lookup(dirs, [path.basename(family).toLowerCase()]);
    if (byName) return { file: byName, exact: true };
  }
  const exact = lookup(dirs, candidates(family, weight));
  if (exact) return { file: exact, exact: true };
  // A Latin fallback has no CJK or Thai glyphs, and drawtext can't borrow them from another font: they'd be boxes.
  const fallback = (wideScript && lookup(dirs, WIDE_FALLBACKS)) || lookup(dirs, FALLBACKS);
  return fallback ? { file: fallback, exact: false } : undefined;
}

/** Font argument for FFmpeg's `drawtext` filter (`fontfile=...` or fallback `font=sans`). */
export function drawtextFontArg(family = "Arial", opts?: FontOptions): string {
  const font = resolveFontFile(family, opts);
  return font ? `fontfile=${escapeFilterPath(font.file)}` : "font=sans";
}
