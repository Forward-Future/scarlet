/**
 * Motion graphics drawn by a web page. A graphic is an HTML/CSS page; headless Chrome draws it frame by frame on a
 * transparent background and ffmpeg writes the frames to a ProRes 4444 movie with alpha, which the render graph lays
 * over the picture like any other video with alpha.
 *
 * Time contract for the page: CSS animations, transitions and Web Animations are paused, and before each frame every
 * `document.getAnimations()` animation's `currentTime` is set to the frame's time in milliseconds. SVG animations are
 * paused and set the same way. A page that keeps its own clock (canvas, Lottie, script) defines
 * `window.scarletSeek(seconds)`, which is called before each frame and may return a promise.
 *
 * Chrome is driven over the DevTools protocol on a pipe (`--remote-debugging-pipe`): no port, no extra dependency.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { availableParallelism } from "node:os";
import {
  ChromeNotFound,
  chromeCandidates,
  evaluate,
  findChrome,
  hasChrome,
  inBrowser,
  openPage,
  withBrowser,
  within,
  type Browser,
  type CdpPage,
  type GraphicPageOptions,
} from "./chromeCdp.js";
import { AbortError, FFMPEG_BASE_ARGS, even, fnum, logElapsed, logRender, resolveFfmpeg, runCapture } from "./exec.js";
import { pdfPageCount, pdfPages, renderPdfDocument } from "./pdf.js";

export { ChromeNotFound, chromeCandidates, findChrome, hasChrome, pdfPageCount, pdfPages, renderPdfDocument, type GraphicPageOptions };

/**
 * The codec a graphic is written in: ProRes 4444 keeps the alpha, and every ffmpeg Scarlet runs reads it. The page's
 * RGB becomes video with the BT.709 matrix the footage uses, and says so, so it is laid over the picture unshifted.
 */
export const GRAPHIC_CODEC_ARGS = [
  "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuva444p10le,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709",
  "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-alpha_bits", "16", "-vendor", "apl0",
  "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
];

/** Runs in the page once it has loaded: waits for its fonts and pictures, pauses its clock, and finds fonts it asked for and didn't get. */
const PREPARE = String.raw`(async () => {
  await document.fonts.ready;
  await Promise.all([...document.images].map(img => img.decode().catch(() => undefined)));
  for (const svg of document.querySelectorAll("svg")) if (typeof svg.pauseAnimations === "function") svg.pauseAnimations();
  for (const a of document.getAnimations()) a.pause();
  window.__scarletFrame = async (ms) => {
    if (typeof window.scarletSeek === "function") await window.scarletSeek(ms / 1000);
    for (const a of document.getAnimations()) { a.pause(); a.currentTime = ms; }
    for (const svg of document.querySelectorAll("svg")) if (typeof svg.setCurrentTime === "function") svg.setCurrentTime(ms / 1000);
    document.body && document.body.getBoundingClientRect();
  };
  const generic = new Set(["serif","sans-serif","monospace","cursive","fantasy","system-ui","ui-serif","ui-sans-serif","ui-monospace","ui-rounded","emoji","math","fangsong","-apple-system","blinkmacsystemfont","inherit","initial","unset"]);
  const asked = new Map();
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.trim();
    if (!text || !node.parentElement) continue;
    const first = getComputedStyle(node.parentElement).fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "");
    if (first && !generic.has(first.toLowerCase()) && !asked.has(first)) asked.set(first, text.slice(0, 40));
  }
  const canvas = document.createElement("canvas").getContext("2d");
  const width = (font) => { canvas.font = font; return canvas.measureText("Hamburgefonstiv 0123 WMQ").width; };
  const missing = [];
  for (const [family, sample] of asked) {
    const faces = [...document.fonts].filter(f => f.family.replace(/^["']|["']$/g, "") === family);
    if (faces.length) {
      await Promise.all(faces.map(f => f.load().catch(() => undefined)));
      if (faces.some(f => f.status === "loaded")) continue;
    } else if (["monospace", "serif"].some(g => width('72px "' + family + '", ' + g) !== width("72px " + g))) continue;
    missing.push({ family, sample });
  }
  // With a font missing, which common families this machine does have, so one can be chosen without guessing.
  const common = ["Helvetica Neue","Helvetica","Arial","Avenir Next","Avenir","Futura","Gill Sans","Optima","Verdana","Tahoma","Trebuchet MS","Segoe UI","Calibri","Roboto","Open Sans","Lato","Montserrat","Inter","SF Pro Display","SF Pro Text","Georgia","Times New Roman","Palatino","Baskerville","Didot","Garamond","Menlo","Courier New","DejaVu Sans","Liberation Sans","Noto Sans","Ubuntu"];
  const installed = missing.length ? common.filter(family => ["monospace", "serif"].some(g => width('72px "' + family + '", ' + g) !== width("72px " + g))) : [];
  return { missing, installed };
})()`;

export interface MissingFont {
  /** The family the page asked for first, which the browser couldn't load or find installed. */
  family: string;
  /** Some of the text it was asked for. */
  sample: string;
}

/**
 * Whether nothing on the page can change with time: no clock of its own, no animation, transition or SVG animation,
 * and nothing that plays by itself. Runs after PREPARE, so every animation the page declares already exists.
 */
const STILL = String.raw`(() => {
  if (typeof window.scarletSeek === "function" || document.getAnimations().length) return false;
  if (document.querySelector("script, video, audio, canvas, iframe, object, embed, marquee, animate, animateTransform, animateMotion, set")) return false;
  const moving = /\.(gif|apng|webp|avif)\b|image\/(gif|apng|webp|avif)/i;
  if (moving.test(document.documentElement.outerHTML)) return false;
  for (const sheet of document.styleSheets) {
    try { for (const rule of sheet.cssRules) if (moving.test(rule.cssText)) return false; } catch { return false; }
  }
  return true;
})()`;

async function prepare(browser: Browser, page: CdpPage) {
  return evaluate<{ missing: MissingFont[]; installed: string[] }>(browser, page, PREPARE);
}

async function frameAt(browser: Browser, page: CdpPage, ms: number): Promise<Buffer> {
  await evaluate(browser, page, `window.__scarletFrame(${fnum(ms, 3)})`);
  const { data } = await browser.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, captureBeyondViewport: false, fromSurface: true }, page.sessionId) as { data: string };
  return Buffer.from(data, "base64");
}

export interface GraphicRenderOptions extends GraphicPageOptions {
  /** Seconds. */
  duration: number;
  fps: number;
  /** The `.mov` to write. */
  output: string;
  ffmpegPath?: string;
  /** Pages drawing at once; default from the CPU count, at most 4. */
  pages?: number;
  onProgress?: (fraction: number) => void;
}

export interface GraphicRenderResult {
  output: string;
  frames: number;
  missingFonts: MissingFont[];
  /** With a font missing, the common families that are installed here. */
  installedFonts: string[];
  /** Script errors and files the page couldn't load, as Chrome reported them. */
  problems: string[];
  /** Frames Chrome drew. A page that doesn't change is drawn at its first and last frame, and the first is held. */
  drawn: number;
  /** Milliseconds spent. */
  elapsedMs: number;
}

/**
 * Feeds PNG frames in strict index order to an ffmpeg `image2pipe` stdin stream,
 * keeping at most `window` frames buffered ahead of the writer with drain backpressure.
 */
class OrderedFramePipe {
  private readonly ffmpeg: ChildProcess;
  private readonly ready = new Map<number, Buffer>();
  private readonly waiting: Array<() => void> = [];
  private written = 0;
  private writing = Promise.resolve();
  private readonly finished: Promise<void>;
  private readonly kill: () => void;

  constructor(
    private readonly total: number,
    private readonly window: number,
    private readonly opts: Pick<GraphicRenderOptions, "fps" | "output" | "ffmpegPath" | "signal" | "onProgress">,
  ) {
    this.ffmpeg = spawn(resolveFfmpeg(opts.ffmpegPath), [
      ...FFMPEG_BASE_ARGS, "-y",
      "-f", "image2pipe", "-c:v", "png", "-framerate", fnum(opts.fps), "-i", "pipe:0",
      ...GRAPHIC_CODEC_ARGS, "-r", fnum(opts.fps), "-an", opts.output,
    ], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let ffmpegError = "";
    this.ffmpeg.stderr!.on("data", (c: Buffer) => { ffmpegError = (ffmpegError + c.toString("utf8")).slice(-4000); });
    this.ffmpeg.stdin!.on("error", () => undefined);
    this.finished = new Promise<void>((resolve, reject) => {
      this.ffmpeg.on("error", reject);
      this.ffmpeg.on("close", code => code === 0 ? resolve() : reject(new Error(`ffmpeg couldn't write the graphic (exit ${code}): ${ffmpegError.trim().split("\n").slice(-3).join(" ")}`)));
    });
    this.kill = () => this.ffmpeg.kill("SIGKILL");
    opts.signal?.addEventListener("abort", this.kill, { once: true });
  }

  private waitDrain(): Promise<void> {
    return new Promise<void>(resolve => {
      const stdin = this.ffmpeg.stdin!;
      if (stdin.destroyed || stdin.writableEnded || this.opts.signal?.aborted) return resolve();
      const done = () => {
        stdin.off("drain", done);
        stdin.off("close", done);
        stdin.off("error", done);
        this.opts.signal?.removeEventListener("abort", done);
        resolve();
      };
      stdin.once("drain", done);
      stdin.once("close", done);
      stdin.once("error", done);
      this.opts.signal?.addEventListener("abort", done, { once: true });
    });
  }

  private flush = async () => {
    while (this.ready.has(this.written)) {
      if (this.ffmpeg.stdin!.destroyed || this.opts.signal?.aborted) { this.ready.clear(); break; }
      const png = this.ready.get(this.written)!;
      this.ready.delete(this.written);
      this.written++;
      if (!this.ffmpeg.stdin!.write(png)) await this.waitDrain();
      this.opts.onProgress?.(this.written / this.total);
    }
    for (const resume of this.waiting.splice(0)) resume();
  };

  async waitForSlot(frameIndex: number): Promise<void> {
    while (frameIndex >= this.written + this.window) {
      await new Promise<void>(resolve => this.waiting.push(resolve));
    }
  }

  enqueue(frameIndex: number, png: Buffer): void {
    this.ready.set(frameIndex, png);
    this.writing = this.writing.then(this.flush);
  }

  async writeSequential(png: Buffer): Promise<void> {
    for (let i = 0; i < this.total; i++) {
      this.opts.signal?.throwIfAborted();
      this.ready.set(i, png);
      await this.flush();
    }
  }

  async run(produce: () => Promise<void>): Promise<void> {
    try {
      await Promise.race([
        produce().then(() => this.writing),
        this.finished.then(() => { throw new Error("ffmpeg stopped before the graphic was drawn."); }),
      ]);
      this.opts.signal?.throwIfAborted();
      this.ffmpeg.stdin!.end();
      await this.finished;
    } catch (error) {
      this.kill();
      await this.finished.catch(() => undefined);
      await rm(this.opts.output, { force: true });
      throw error;
    } finally {
      this.opts.signal?.removeEventListener("abort", this.kill);
    }
  }
}

/**
 * Draw the page at every frame of `duration` and write a ProRes 4444 movie with alpha. Frames are drawn by a few pages
 * at once and written in order.
 */
export async function renderGraphic(opts: GraphicRenderOptions): Promise<GraphicRenderResult> {
  const started = performance.now();
  const total = Math.max(1, Math.round(opts.duration * opts.fps));
  const workers = Math.max(1, Math.min(opts.pages ?? Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2))), total));
  return withBrowser(opts, async (browser, url) => {
    const size = { width: opts.width, height: opts.height, scale: 1 };
    const pages = [await openPage(browser, url, size, opts.signal)];
    const { missing: missingFonts, installed: installedFonts } = await prepare(browser, pages[0]!);
    // A page with nothing that moves is one picture held for its length: a photo or a title card. Drawing each of its
    // frames in Chrome took five minutes for 6.5 s at 3840x2160 on a busy machine, and the call timed out (2026-11-16).
    // Its first and last frames are drawn and compared, so a page that does change is drawn in full whatever it is made of.
    let held: Buffer | undefined;
    let drawn = 0;
    if (total > 2 && await evaluate<boolean>(browser, pages[0]!, STILL).catch(() => false)) {
      const first = await frameAt(browser, pages[0]!, 0);
      const last = await frameAt(browser, pages[0]!, ((total - 1) / opts.fps) * 1000);
      drawn = 2;
      if (first.equals(last)) held = first;
    }
    if (!held && workers > 1) {
      const more = await Promise.all(Array.from({ length: workers - 1 }, () => openPage(browser, url, size, opts.signal)));
      await Promise.all(more.map(page => prepare(browser, page)));
      pages.push(...more);
    }

    const pipe = new OrderedFramePipe(total, workers * 3, opts);
    const draw = async (page: CdpPage, first: number) => {
      for (let i = first; i < total; i += workers) {
        await pipe.waitForSlot(i);
        opts.signal?.throwIfAborted();
        pipe.enqueue(i, await frameAt(browser, page, (i / opts.fps) * 1000));
        drawn++;
      }
    };
    await pipe.run(() => held ? pipe.writeSequential(held) : Promise.all(pages.map((page, w) => draw(page, w))).then(() => undefined));
    const problems = [...new Set(pages.flatMap(p => p.problems))].slice(0, 10);
    logRender(() => `[graphics] drew ${opts.width}x${opts.height} at ${fnum(opts.fps, 3)} fps: ${total} frames in ${logElapsed(performance.now() - started)}, ` +
      `${held ? "one still picture held" : `${drawn} drawn on ${pages.length} page${pages.length === 1 ? "" : "s"}`}` +
      `${missingFonts.length ? `, ${missingFonts.length} fonts missing` : ""}${problems.length ? `, ${problems.length} page problems` : ""}`);
    return {
      output: opts.output, frames: total, missingFonts, installedFonts,
      problems,
      drawn, elapsedMs: Math.round(performance.now() - started),
    };
  });
}

/** Draw one moment of the page as a transparent PNG, scaled to `outputWidth`. */
export async function renderGraphicStill(opts: GraphicPageOptions & { time: number; outputWidth?: number }): Promise<{ png: Buffer; missingFonts: MissingFont[]; installedFonts: string[]; problems: string[] }> {
  return withBrowser(opts, async (browser, url) => {
    const scale = opts.outputWidth ? opts.outputWidth / opts.width : 1;
    const page = await openPage(browser, url, { width: opts.width, height: opts.height, scale }, opts.signal);
    const { missing: missingFonts, installed: installedFonts } = await prepare(browser, page);
    const png = await frameAt(browser, page, opts.time * 1000);
    return { png, missingFonts, installedFonts, problems: page.problems };
  });
}

export interface PageCaptureOptions {
  /** A page on the web (http or https). */
  url: string;
  /** The browser window, in CSS pixels. */
  width: number;
  height: number;
  /** The whole page down to its end, up to `maxHeight`, instead of the window alone. */
  fullPage?: boolean;
  maxHeight?: number;
  chromePath?: string;
  signal?: AbortSignal;
}

export interface PageCapture {
  png: Buffer;
  /** The page's title and address once it loaded, after any redirect. */
  title: string;
  url: string;
  /** The page's words as a reader sees them, cut to the first 20,000 characters. */
  text: string;
  /** The picture's size, in pixels. */
  width: number;
  height: number;
  /** The page's headings and the part of the picture each sits in, as fractions of it. */
  headings: Array<{ text: string; box: { left: number; top: number; right: number; bottom: number } }>;
}

/** What a loaded page says of itself: its title, words, height and headings, measured in its own pixels. */
const PAGE_FACTS = String.raw`(() => {
  const height = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  const headings = [...document.querySelectorAll("h1, h2, h3")].slice(0, 40).map(h => {
    const r = h.getBoundingClientRect();
    return { text: (h.innerText || "").trim().slice(0, 300), left: r.left + scrollX, top: r.top + scrollY, right: r.right + scrollX, bottom: r.bottom + scrollY };
  }).filter(h => h.text && h.right > h.left && h.bottom > h.top);
  return { title: document.title, url: location.href, text: (document.body ? document.body.innerText : "").slice(0, 20000), height, headings };
})()`;

/**
 * Open a page on the web in headless Chrome and take its picture: the window, or the whole page down to its end. The
 * page gets a moment after it loads for what it draws late (fonts, embeds), and keeps its own background.
 */
export async function capturePage(opts: PageCaptureOptions): Promise<PageCapture> {
  return inBrowser(opts, async browser => {
    const page = await openPage(browser, opts.url, { width: opts.width, height: opts.height, scale: 1 }, opts.signal)
      .catch((error: Error) => { throw error instanceof AbortError ? error : new Error(error.message.replace(/the graphic's page/gi, "the page")); });
    await browser.send("Emulation.setDefaultBackgroundColorOverride", {}, page.sessionId);
    await within(new Promise(resolve => setTimeout(resolve, 1500)), 5000, "", opts.signal);
    const facts = await evaluate<{ title: string; url: string; text: string; height: number;
      headings: Array<{ text: string; left: number; top: number; right: number; bottom: number }> }>(browser, page, PAGE_FACTS);
    const height = opts.fullPage ? Math.max(opts.height, Math.min(Math.ceil(facts.height), opts.maxHeight ?? 12_000)) : opts.height;
    const { data } = await browser.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: !!opts.fullPage,
      clip: { x: 0, y: 0, width: opts.width, height, scale: 1 } }, page.sessionId) as { data: string };
    const headings = facts.headings.filter(h => h.top < height).map(h => ({ text: h.text, box: {
      left: Math.max(0, h.left / opts.width), top: Math.max(0, h.top / height), right: Math.min(1, h.right / opts.width), bottom: Math.min(1, h.bottom / height) } }));
    return { png: Buffer.from(data, "base64"), title: facts.title, url: facts.url, text: facts.text, width: opts.width, height, headings };
  });
}

/** Where the drawn part of each frame is, as fractions of the frame: the box around its pixels that aren't transparent. */
export interface GraphicCoverage { time: number; box: { left: number; top: number; right: number; bottom: number } | null }

/** The box each sampled moment of a graphic with alpha covers, measured from its alpha at a quarter of its size. */
export async function graphicCoverage(file: string, times: number[], size: { width: number; height: number }, opts: { ffmpegPath?: string; signal?: AbortSignal } = {}): Promise<GraphicCoverage[]> {
  const w = Math.max(2, Math.round(size.width / 4)), h = Math.max(2, Math.round(size.height / 4));
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return Promise.all(times.map(async time => {
    const { stdout } = await runCapture(resolveFfmpeg(opts.ffmpegPath), [
      ...FFMPEG_BASE_ARGS, "-ss", fnum(time), "-i", file, "-frames:v", "1",
      "-vf", `alphaextract,scale=${w}:${h}:flags=area,format=gray`, "-f", "rawvideo", "pipe:1",
    ], { signal: opts.signal });
    let left = w, right = -1, top = h, bottom = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if ((stdout[y * w + x] ?? 0) <= 2) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
    return { time, box: right < 0 ? null : { left: round(left / w), top: round(top / h), right: round((right + 1) / w), bottom: round((bottom + 1) / h) } };
  }));
}

/**
 * One moment of a graphic laid over a picture (a JPEG of the edit at that moment), or over mid grey when there is
 * none, as a JPEG `width` wide: how the editor will see it.
 */
export async function graphicOver(movie: string, time: number, background: Buffer | null, size: { width: number; height: number },
  opts: { ffmpegPath?: string; signal?: AbortSignal } = {}): Promise<Buffer> {
  const w = even(size.width), h = even(size.height);
  const base = background ? ["-f", "image2pipe", "-c:v", "mjpeg", "-i", "pipe:0"] : ["-f", "lavfi", "-i", `color=c=0x5a5a5a:s=${w}x${h}:d=1`];
  const { stdout } = await runCapture(resolveFfmpeg(opts.ffmpegPath), [
    ...FFMPEG_BASE_ARGS, ...base, "-ss", fnum(time), "-i", movie,
    // The graphic is BT.709 video, as written: read it back as such, so the check shows its colours as they play.
    "-filter_complex", `[0:v]scale=${w}:${h},format=rgba[b];[1:v]scale=${w}:${h}:in_color_matrix=bt709:in_range=tv,format=rgba[g];[b][g]overlay=format=auto,format=yuvj420p`,
    "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "3", "-f", "image2pipe", "pipe:1",
  ], { stdin: background ?? undefined, signal: opts.signal, maxStdout: 8 * 1024 * 1024 });
  if (!stdout.length) throw new Error(`No frame of the graphic at ${time}s`);
  return stdout;
}
