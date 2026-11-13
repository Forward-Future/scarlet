/**
 * A passage of a recording as an editor looks at it: its waveform over its spectrogram, with the transcript's words
 * at their times. A model reads a transcript and a list of levels; neither shows a word cut short, the hiss of an
 * "s" left behind a cut, or speech the transcript missed, and all three are plain in a picture. With ranges to
 * remove, a second row shows the passage as it would play with them out, at the same scale, so a join can be looked
 * at before it is made.
 */
import type { TimeRange } from "@scarlet/timeline";
import { escapeFilterPath } from "./effects.js";
import { LOCAL_MEDIA_INPUT, ffSeconds, resolveFfmpeg, runCapture } from "./exec.js";
import { resolveFontFile } from "./fonts.js";

export interface SoundPictureWord { text: string; start: number; end: number }
export interface SoundPictureOptions {
  /** The passage, in the recording's seconds. */
  range: TimeRange;
  /** Ranges inside it to take out, for the second row. */
  remove?: TimeRange[];
  words?: SoundPictureWord[];
  stream?: number;
  signal?: AbortSignal;
}

/** The longest passage one picture holds: past this a word is too narrow to read. */
export const SOUND_PICTURE_SECONDS = 15;
const W = 1280, TITLE = 22, WAVE = 120, WORDS = 22, SPECTRUM = 200, AXIS = 20;
const ROW = TITLE + WAVE + WORDS + SPECTRUM + AXIS;

export interface SoundPictureLayout {
  width: number;
  height: number;
  /** Each row top to bottom: what it shows and where its sound sits, so a reader can turn a position into a time. */
  rows: Array<{ shows: "recorded" | "cut"; top: number; bottom: number; left: number; right: number; seconds: number }>;
  pixelsPerSecond: number;
}

/** Text drawtext can take without quoting: the filter graph's own punctuation comes out, an apostrophe becomes typographic. */
const plain = (text: string) => text.replace(/'/g, "’").replace(/[^\p{L}\p{N} .?!’-]/gu, "").trim();

/** The kept stretches of a passage once `remove` is out, in the recording's seconds. */
export function keptPieces(range: TimeRange, remove: readonly TimeRange[]): TimeRange[] {
  const out: TimeRange[] = [];
  let from = range.start;
  for (const r of [...remove].sort((a, b) => a.start - b.start)) {
    if (r.end <= from || r.start >= range.end) continue;
    if (r.start - from > 1e-3) out.push({ start: from, end: Math.min(r.start, range.end) });
    from = Math.max(from, r.end);
  }
  if (range.end - from > 1e-3) out.push({ start: from, end: range.end });
  return out;
}

/** The ffmpeg filter graph that draws the picture, and where each row's sound sits in it. */
export function soundPictureGraph(opts: SoundPictureOptions): { graph: string; layout: SoundPictureLayout } {
  const { range } = opts, seconds = range.end - range.start;
  const pieces = opts.remove?.length ? keptPieces(range, opts.remove) : [];
  const cut = pieces.length > 0 && pieces.reduce((sum, p) => sum + p.end - p.start, 0) < seconds - 1e-3;
  const pps = W / seconds, x = (t: number) => Math.round((t - range.start) * pps);
  const font = resolveFontFile("Arial");
  const face = font ? `fontfile=${escapeFilterPath(font.file)}` : "font=sans";
  const text = (s: string, px: number, y: number, size = 14, color = "0xe8e8e8") =>
    `drawtext=${face}:expansion=none:text='${plain(s)}':fontsize=${size}:fontcolor=${color}:x=${Math.max(2, px)}:y=${y}`;
  const box = (px: number, y: number, w: number, h: number, color: string) => `drawbox=x=${px}:y=${y}:w=${Math.max(1, w)}:h=${h}:color=${color}:t=fill`;
  const stream = `0:a:${opts.stream ?? 0}`;
  const height = ROW * (cut ? 2 : 1);
  const chains: string[] = [], draw: string[] = [];
  const layout: SoundPictureLayout = { width: W, height, pixelsPerSecond: Math.round(pps * 100) / 100, rows: [] };
  const taps = 2 + (cut ? pieces.length : 0);
  chains.push(`[${stream}]aresample=16000,aformat=sample_fmts=fltp:channel_layouts=mono,asplit=${taps}${Array.from({ length: taps }, (_, i) => `[a${i}]`).join("")}`);
  const pictures = (wave: string, spectrum: string, width: number, row: number) => {
    chains.push(`[${wave}]showwavespic=s=${width}x${WAVE}:colors=0xe8e8e8:scale=sqrt[w${row}]`, `[${spectrum}]showspectrumpic=s=${width}x${SPECTRUM}:legend=0:scale=log:color=intensity[s${row}]`);
  };
  /** The words strip and their starts, on a row whose sound maps a recording second to a pixel with `at`. */
  const words = (top: number, at: (t: number) => number | undefined) => {
    let free = 0;
    for (const w of opts.words ?? []) {
      const px = at(w.start);
      if (px === undefined || !plain(w.text)) continue;
      draw.push(box(px, top + TITLE + WAVE, 1, 6, "0x888888"));
      // A word that would run into the one before it is left out; its tick still marks where it starts.
      if (px < free) continue;
      draw.push(text(w.text, px + 2, top + TITLE + WAVE + 5, 13));
      free = px + 4 + plain(w.text).length * 7;
    }
  };

  // As recorded: the whole passage, with what would come out shaded.
  pictures("a0", "a1", W, 0);
  draw.push(text(`As recorded  ${range.start.toFixed(2)} to ${range.end.toFixed(2)} s${cut ? "   shaded red comes out" : ""}`, 6, 4, 14, "0xaaaaaa"));
  const step = seconds > 8 ? 1 : seconds > 3 ? 0.5 : 0.25;
  for (let t = Math.ceil(range.start / step) * step; t < range.end - 1e-6; t += step) {
    draw.push(box(x(t), TITLE, 1, WAVE + WORDS + SPECTRUM, "white@0.12"), text(t.toFixed(step < 1 ? 2 : 0), x(t) + 3, TITLE + WAVE + WORDS + SPECTRUM + 3, 12, "0x999999"));
  }
  if (cut) for (const r of opts.remove!) {
    const from = Math.max(r.start, range.start), to = Math.min(r.end, range.end);
    if (to > from) draw.push(box(x(from), TITLE, x(to) - x(from), WAVE + WORDS + SPECTRUM, "red@0.3"));
  }
  words(0, t => t >= range.start && t < range.end ? x(t) : undefined);
  layout.rows.push({ shows: "recorded", top: 0, bottom: ROW, left: 0, right: W, seconds: Math.round(seconds * 1000) / 1000 });

  if (cut) {
    // With the cut: the kept stretches end to end, at the same scale, each join marked.
    const played = pieces.reduce((sum, p) => sum + p.end - p.start, 0), width = Math.max(16, Math.round(played * pps));
    pieces.forEach((p, i) => chains.push(`[a${2 + i}]atrim=${(p.start - range.start).toFixed(4)}:${(p.end - range.start).toFixed(4)},asetpts=PTS-STARTPTS[p${i}]`));
    chains.push(`${pieces.map((_, i) => `[p${i}]`).join("")}concat=n=${pieces.length}:v=0:a=1,asplit=2[b0][b1]`);
    pictures("b0", "b1", width, 1);
    let offset = 0;
    const starts = pieces.map(p => { const at = offset; offset += p.end - p.start; return at; });
    const at = (t: number) => {
      const i = pieces.findIndex(p => t >= p.start && t < p.end);
      return i < 0 ? undefined : Math.round((starts[i]! + t - pieces[i]!.start) * pps);
    };
    draw.push(text(`With the cut  plays ${played.toFixed(2)} s   red line is the join`, 6, ROW + 4, 14, "0xaaaaaa"));
    pieces.forEach((p, i) => {
      const px = Math.round(starts[i]! * pps);
      if (i) draw.push(box(px - 1, ROW + TITLE, 2, WAVE + WORDS + SPECTRUM, "red"));
      draw.push(text(p.start.toFixed(2), px + 3, ROW + TITLE + WAVE + WORDS + SPECTRUM + 3, 12, "0x999999"));
    });
    words(ROW, at);
    layout.rows.push({ shows: "cut", top: ROW, bottom: 2 * ROW, left: 0, right: width, seconds: Math.round(played * 1000) / 1000 });
  }
  chains.push(`color=c=0x101010:s=${W}x${height}:d=1:r=1[bg]`);
  let canvas = "bg";
  layout.rows.forEach((row, i) => {
    chains.push(`[${canvas}][w${i}]overlay=0:${row.top + TITLE}[c${i}w]`, `[c${i}w][s${i}]overlay=0:${row.top + TITLE + WAVE + WORDS}[c${i}s]`);
    canvas = `c${i}s`;
  });
  chains.push(`[${canvas}]${draw.join(",")}[out]`);
  return { graph: chains.join(";"), layout };
}

/** The picture as a JPEG, with where each row's sound sits in it. */
export async function soundPicture(file: string, opts: SoundPictureOptions): Promise<{ jpeg: Buffer; layout: SoundPictureLayout }> {
  const { graph, layout } = soundPictureGraph(opts);
  const { stdout } = await runCapture(resolveFfmpeg(), ["-hide_banner", "-nostdin", "-nostats", "-ss", ffSeconds(opts.range.start),
    "-t", String(opts.range.end - opts.range.start), ...LOCAL_MEDIA_INPUT, "-i", file, "-filter_complex", graph, "-map", "[out]",
    "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "3", "-f", "image2pipe", "-"], { signal: opts.signal, maxStdout: 4 * 1024 * 1024 });
  return { jpeg: stdout, layout };
}
