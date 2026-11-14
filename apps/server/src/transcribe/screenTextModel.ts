/**
 * Reading the text on screen: PaddleOCR's PP-OCRv3 mobile text finder and its PP-OCRv5 English line reader (Apache
 * 2.0), through ONNX Runtime in the audio helper (audioWorker.ts), which already keeps models loaded between
 * requests. On a 4K screen recording read at 1920 wide (2026-11-13, M-series CPU, eight threads), finding the lines
 * of a frame took about 0.11 s and reading 90-150 of them 1.1-1.6 s; the PP-OCRv5 server finder found the same lines
 * fifteen times slower. A line whose pixels are the same as in the frame before is not read again.
 */
import { readFile } from "node:fs/promises";
import { loadRuntime, withInference, type Sessions } from "./uhm.js";
import type { PinnedModel } from "./localModel.js";

const REVISION = "https://huggingface.co/monkt/paddleocr-onnx/resolve/7b02d0a30a07ba2b92ad1ff5a8941ae2c633de65";
/** The models that read screen text, pinned by revision, size and checksum. */
export const SCREEN_TEXT_MODELS = {
  finder: { name: "ppocr-v3-mobile-det-ee40e800.onnx", url: `${REVISION}/detection/v3/det.onnx`,
    size: 2429873, sha256: "ee40e80071ba3a320d4efda75f3e22047a7d049e9bf7bcaaf9daea23fc21b935" },
  reader: { name: "ppocr-v5-en-mobile-rec-4e16deb2.onnx", url: `${REVISION}/languages/english/rec.onnx`,
    size: 7830888, sha256: "4e16deb22c4da6468bdca539b2cd3c8687825538b67109177c47d359ab994cd7" },
  letters: { name: "ppocr-v5-en-dict-e025a66d.txt", url: `${REVISION}/languages/english/dict.txt`,
    size: 1416, sha256: "e025a66d31f327ba0c232e03f407ae8d105e1e709e7ccb3f408aa778c24e70d6" },
} satisfies Record<string, PinnedModel>;

/** One line of text found on a frame: its words, how sure the reader was (0..1), and its box in the frame's pixels. */
export interface ScreenLine { text: string; confidence: number; box: [number, number, number, number] }

/** A box around text, in the pixels of the map the finder returned. */
export interface FoundBox { x0: number; y0: number; x1: number; y1: number }

const FIND_ON = 0.3, FIND_MEAN = 0.6, UNCLIP = 1.5;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
const LINE_HEIGHT = 48, LINE_MAX_WIDTH = 1600, BATCH = 16;

/**
 * Boxes around the text in the finder's probability map: each connected run of pixels above 0.3 whose mean is at
 * least 0.6, grown by PaddleOCR's unclip ratio so the box takes in the edges of its letters. Screen text runs level,
 * so the boxes stay upright.
 */
export function findBoxes(map: Float32Array, width: number, height: number): FoundBox[] {
  const seen = new Uint8Array(width * height), boxes: FoundBox[] = [], stack: number[] = [];
  for (let i = 0; i < map.length; i++) {
    if (seen[i] || map[i]! <= FIND_ON) continue;
    seen[i] = 1;
    stack.push(i);
    let x0 = width, y0 = height, x1 = 0, y1 = 0, sum = 0, n = 0;
    while (stack.length) {
      const p = stack.pop()!, x = p % width, y = (p - x) / width;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      sum += map[p]!;
      n++;
      const near = [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1];
      for (const q of near) if (q >= 0 && !seen[q] && map[q]! > FIND_ON) { seen[q] = 1; stack.push(q); }
    }
    if (n < 6 || sum / n < FIND_MEAN) continue;
    const w = x1 - x0 + 1, h = y1 - y0 + 1, grow = (w * h * UNCLIP) / (2 * (w + h));
    boxes.push({ x0: Math.max(0, x0 - grow), y0: Math.max(0, y0 - grow), x1: Math.min(width, x1 + 1 + grow), y1: Math.min(height, y1 + 1 + grow) });
  }
  return boxes;
}

/** The letters of a line from the reader's scores: the best class at each step, repeats and blanks (class 0) dropped. */
export function readLetters(scores: Float32Array, offset: number, steps: number, classes: number, letters: readonly string[]) {
  let text = "", last = 0, sure = 0, kept = 0;
  for (let t = 0; t < steps; t++) {
    let best = 0, top = -Infinity;
    for (let c = 0; c < classes; c++) {
      const v = scores[offset + t * classes + c]!;
      if (v > top) { top = v; best = c; }
    }
    if (best !== 0 && best !== last) { text += letters[best] ?? ""; sure += top; kept++; }
    last = best;
  }
  return { text: text.trim(), confidence: kept ? sure / kept : 0 };
}

/** The reader's classes: blank, the dictionary's letters in order, then a space. */
export function letterClasses(dictionary: string): string[] {
  const lines = dictionary.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return ["", ...lines, " "];
}

/** A line's pixels, reduced to 24 by 6 levels of grey: a line that reads the same pixels as before reads the same words. */
function fingerprint(rgb: Buffer, width: number, box: readonly number[]) {
  const [x0, y0, x1, y1] = box as [number, number, number, number];
  let key = `${x0},${y0},${x1},${y1}:`;
  for (let gy = 0; gy < 6; gy++) for (let gx = 0; gx < 24; gx++) {
    const x = Math.min(x1 - 1, Math.floor(x0 + (gx + 0.5) * (x1 - x0) / 24)), y = Math.min(y1 - 1, Math.floor(y0 + (gy + 0.5) * (y1 - y0) / 6));
    const p = (y * width + x) * 3;
    key += ((rgb[p]! * 3 + rgb[p + 1]! * 6 + rgb[p + 2]!) / 160 | 0).toString(16);
  }
  return key;
}

/** How much of `a` and `b` overlap, as a share of both together. */
export function overlap(a: readonly number[], b: readonly number[]) {
  const w = Math.min(a[2]!, b[2]!) - Math.max(a[0]!, b[0]!), h = Math.min(a[3]!, b[3]!) - Math.max(a[1]!, b[1]!);
  if (w <= 0 || h <= 0) return 0;
  const both = w * h, area = (r: readonly number[]) => (r[2]! - r[0]!) * (r[3]! - r[1]!);
  return both / (area(a) + area(b) - both);
}

/** Mean difference in grey between two frames over a box, from every other pixel. */
function boxDifference(a: Buffer, b: Buffer, width: number, box: readonly number[]) {
  const [x0, y0, x1, y1] = box as [number, number, number, number];
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
    const p = (y * width + x) * 3;
    sum += Math.abs((a[p]! * 3 + a[p + 1]! * 6 + a[p + 2]!) - (b[p]! * 3 + b[p + 1]! * 6 + b[p + 2]!)) / 10;
    n++;
  }
  return n ? sum / n : Infinity;
}

/**
 * The frame read last, at each size, with its lines. A line in about the same box whose pixels have hardly changed
 * since is the same line, and its reading stands: compressed video never repeats a line's pixels exactly, so this is
 * what spares a still screen around a moving chart. A frame of another recording at the same size just doesn't match.
 */
const lastFrames = new Map<string, { rgb: Buffer; lines: ScreenLine[] }>();
/** Mean grey difference under which a line's pixels count as unchanged: well under what one changed letter makes. */
const SAME_PIXELS = 2.5;

/** Lines already read, by fingerprint. Kept for the helper's life, newest last. */
const lineMemory = new Map<string, { text: string; confidence: number }>();
const LINE_MEMORY = 20_000;

/** Read every frame in `frames` (packed RGB, `width` by `height`, one after another): the lines of text on each. */
export async function runScreenTextWorker(frames: string, width: number, height: number, finder: string, reader: string, dictionary: string,
  sessions?: Sessions): Promise<ScreenLine[][]> {
  const ort = loadRuntime();
  const letters = letterClasses(await readFile(dictionary, "utf8"));
  const all = await readFile(frames);
  const size = width * height * 3, count = Math.floor(all.length / size);
  // The finder reads sides that are multiples of 32.
  const fw = Math.max(32, Math.ceil(width / 32) * 32), fh = Math.max(32, Math.ceil(height / 32) * 32);
  const out: ScreenLine[][] = [];
  for (let f = 0; f < count; f++) {
    const rgb = all.subarray(f * size, (f + 1) * size);
    const input = new Float32Array(3 * fw * fh);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 3, q = y * fw + x;
      for (let c = 0; c < 3; c++) input[c * fw * fh + q] = (rgb[p + c]! / 255 - MEAN[c]!) / STD[c]!;
    }
    const map = await withInference(ort, finder, async session => {
      const result = await session.run({ [session.inputNames[0]!]: new ort.Tensor("float32", input, [1, 3, fh, fw]) });
      return result[session.outputNames[0]!]!.data as Float32Array;
    }, { sessions });
    const boxes = findBoxes(map, fw, fh).map(b => [Math.floor(b.x0), Math.floor(b.y0), Math.min(width, Math.ceil(b.x1)), Math.min(height, Math.ceil(b.y1))] as [number, number, number, number])
      .filter(([x0, y0, x1, y1]) => x1 - x0 > 2 && y1 - y0 > 2);
    const lines: ScreenLine[] = [];
    const unread: Array<{ box: [number, number, number, number]; key: string; width: number }> = [];
    const before = lastFrames.get(`${width}x${height}`);
    for (const box of boxes) {
      const same = before?.lines.find(l => overlap(l.box, box) >= 0.7);
      if (same && boxDifference(before!.rgb, rgb, width, box) < SAME_PIXELS) {
        lines.push({ text: same.text, confidence: same.confidence, box });
        continue;
      }
      const key = fingerprint(rgb, width, box);
      const known = lineMemory.get(key);
      if (known) {
        lineMemory.delete(key);
        lineMemory.set(key, known);
        lines.push({ ...known, box });
      } else unread.push({ box, key, width: Math.max(8, Math.min(LINE_MAX_WIDTH, Math.round((box[2] - box[0]) * LINE_HEIGHT / (box[3] - box[1])))) });
    }
    unread.sort((a, b) => a.width - b.width);
    for (let s = 0; s < unread.length; s += BATCH) {
      const batch = unread.slice(s, s + BATCH), wide = batch.at(-1)!.width;
      const pixels = new Float32Array(batch.length * 3 * LINE_HEIGHT * wide);
      batch.forEach(({ box: [x0, y0, x1, y1], width: lw }, k) => {
        const sx = (x1 - x0) / lw, sy = (y1 - y0) / LINE_HEIGHT;
        for (let y = 0; y < LINE_HEIGHT; y++) {
          const fy = Math.max(0, y0 + (y + 0.5) * sy - 0.5), ya = Math.min(height - 1, Math.floor(fy)), yb = Math.min(height - 1, ya + 1), ay = fy - Math.floor(fy);
          for (let x = 0; x < lw; x++) {
            const fx = Math.max(0, x0 + (x + 0.5) * sx - 0.5), xa = Math.min(width - 1, Math.floor(fx)), xb = Math.min(width - 1, xa + 1), ax = fx - Math.floor(fx);
            for (let c = 0; c < 3; c++) {
              const v = (1 - ay) * ((1 - ax) * rgb[(ya * width + xa) * 3 + c]! + ax * rgb[(ya * width + xb) * 3 + c]!)
                + ay * ((1 - ax) * rgb[(yb * width + xa) * 3 + c]! + ax * rgb[(yb * width + xb) * 3 + c]!);
              pixels[((k * 3 + c) * LINE_HEIGHT + y) * wide + x] = v / 127.5 - 1;
            }
          }
        }
      });
      const { scores, steps, classes } = await withInference(ort, reader, async session => {
        const result = await session.run({ [session.inputNames[0]!]: new ort.Tensor("float32", pixels, [batch.length, 3, LINE_HEIGHT, wide]) });
        const tensor = result[session.outputNames[0]!]!;
        return { scores: tensor.data as Float32Array, steps: tensor.dims[1]!, classes: tensor.dims[2]! };
      }, { sessions });
      batch.forEach(({ box, key }, k) => {
        const read = readLetters(scores, k * steps * classes, steps, classes, letters);
        lineMemory.set(key, read);
        if (lineMemory.size > LINE_MEMORY) lineMemory.delete(lineMemory.keys().next().value!);
        lines.push({ ...read, box });
      });
    }
    out.push(lines);
    lastFrames.set(`${width}x${height}`, { rgb: Buffer.from(rgb), lines });
  }
  return out;
}

