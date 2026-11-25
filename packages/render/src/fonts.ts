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

/** Lower-cased basename → full path for every font file under `dir` (3 levels deep). */
function indexDir(dir: string): Map<string, string> {
  const cached = indexCache.get(dir);
  if (cached) return cached;
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
        if (depth < 3) walk(full, depth + 1);
      } else if (FONT_EXTS.has(path.extname(e.name).toLowerCase())) {
        const key = e.name.toLowerCase();
        if (!index.has(key)) index.set(key, full);
      }
    }
  };
  walk(dir, 0);
  indexCache.set(dir, index);
  return index;
}

function lookup(dirs: string[], names: string[]): string | undefined {
  for (const dir of dirs) {
    const index = indexDir(dir);
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

/** Candidate file names for a family, e.g. "Inter" → inter.ttf, inter-regular.ttf, ... */
function candidates(family: string): string[] {
  const base = family.trim().toLowerCase();
  const compact = base.replace(/\s+/g, "");
  const out: string[] = [];
  for (const stem of new Set([base, compact])) {
    for (const suffix of ["", "-regular", "regular", "_regular", "-medium", "-book"]) {
      for (const ext of [".ttf", ".otf", ".ttc"]) out.push(`${stem}${suffix}${ext}`);
    }
  }
  return out;
}

/**
 * Find a font file for `family`. Returns undefined only when no font at all
 * could be found, in which case callers should fall back to `font=` and hope
 * fontconfig is present.
 */
export function resolveFontFile(family: string, opts: FontOptions = {}, wideScript = false): ResolvedFont | undefined {
  if (opts.fontFile) return { file: opts.fontFile, exact: true };
  const dirs = [...(opts.fontDirs ?? []), ...defaultFontDirs()].map((dir) => path.resolve(dir));
  // Timeline font paths may only select files in configured font directories.
  if (FONT_EXTS.has(path.extname(family).toLowerCase())) {
    for (const dir of dirs) {
      const file = fileInDirectory(dir, family);
      if (file) return { file, exact: true };
    }
  }
  const exact = lookup(dirs, candidates(family));
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
