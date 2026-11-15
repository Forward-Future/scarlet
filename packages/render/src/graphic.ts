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
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { availableParallelism, homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";
import { AbortError, fnum, resolveFfmpeg, runCapture } from "./exec.js";

/** The codec a graphic is written in: ProRes 4444 keeps the alpha, and every ffmpeg Scarlet runs reads it. */
export const GRAPHIC_CODEC_ARGS = ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-alpha_bits", "16", "-vendor", "apl0"];

/** Where Chrome, Chromium, Edge or chrome-headless-shell is usually installed, in the order tried. */
export function chromeCandidates(platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === "darwin") {
    const apps = [
      "Google Chrome.app/Contents/MacOS/Google Chrome",
      "Chromium.app/Contents/MacOS/Chromium",
      "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    ];
    return [...apps.map(app => join("/Applications", app)), ...apps.map(app => join(homedir(), "Applications", app))];
  }
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter((d): d is string => !!d);
    const apps = ["Google\\Chrome\\Application\\chrome.exe", "Microsoft\\Edge\\Application\\msedge.exe", "Chromium\\Application\\chrome.exe"];
    return roots.flatMap(root => apps.map(app => `${root}\\${app}`));
  }
  const dirs = (env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":").filter(Boolean);
  const names = ["chrome-headless-shell", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable"];
  return [...names.flatMap(name => dirs.map(dir => join(dir, name))), "/snap/bin/chromium"];
}

export class ChromeNotFound extends Error {
  constructor(readonly tried: string[]) {
    super(`No Chrome, Chromium or Edge was found to draw graphics. Tried SCARLET_CHROME and ${tried.join(", ")}. Install Google Chrome, or set SCARLET_CHROME to a Chrome or chrome-headless-shell executable.`);
    this.name = "ChromeNotFound";
  }
}

/** The browser that draws graphics: an explicit path, then `SCARLET_CHROME` (the one Scarlet ships), then a standard install. */
export function findChrome(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const usable = (file: string) => { try { return statSync(file).isFile(); } catch { return false; } };
  for (const file of [explicit, env.SCARLET_CHROME]) {
    if (!file) continue;
    if (usable(file)) return file;
    throw new ChromeNotFound([file]);
  }
  const tried = chromeCandidates(process.platform, env);
  const found = tried.find(usable);
  if (!found) throw new ChromeNotFound(tried);
  return found;
}

/** Whether a browser to draw graphics with is installed here. */
export function hasChrome(): boolean {
  try { findChrome(); return true; } catch { return false; }
}

interface CdpMessage { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message: string }; sessionId?: string }

/** One headless Chrome, its temporary profile, and the DevTools protocol over its pipe. */
class Browser {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<(m: CdpMessage) => void>();
  private buffer = Buffer.alloc(0);
  private exited: Error | undefined;
  private constructor(private readonly child: ChildProcess, private readonly profile: string, private readonly stderr: string[]) {
    const out = child.stdio[4] as Readable;
    out.on("data", (chunk: Buffer) => this.read(chunk));
    child.on("exit", (code, sig) => this.fail(new Error(`Chrome exited (${sig ?? code}) while drawing the graphic${this.stderr.length ? `: ${this.stderr.join("").slice(-600)}` : ""}`)));
    child.on("error", error => this.fail(error));
  }

  static async launch(chrome: string, signal?: AbortSignal): Promise<Browser> {
    signal?.throwIfAborted();
    const profile = await mkdtemp(join(tmpdir(), "scarlet-chrome-"));
    const args = [
      "--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profile}`,
      "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync", "--disable-default-apps",
      "--disable-background-networking", "--disable-component-update", "--disable-domain-reliability", "--metrics-recording-only",
      "--mute-audio", "--hide-scrollbars", "--force-color-profile=srgb", "--font-render-hinting=none",
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
      "--allow-file-access-from-files", "--disable-features=Translate,MediaRouter,OptimizationHints,DialMediaRouteProvider",
      "--password-store=basic", "--use-mock-keychain", "about:blank",
    ];
    const child = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], windowsHide: true });
    const stderr: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => { stderr.push(chunk.toString("utf8")); if (stderr.length > 40) stderr.shift(); });
    const browser = new Browser(child, profile, stderr);
    await browser.send("Browser.getVersion").catch(async error => { await browser.close(); throw error; });
    return browser;
  }

  private read(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (let end = this.buffer.indexOf(0); end >= 0; end = this.buffer.indexOf(0)) {
      const message = JSON.parse(this.buffer.subarray(0, end).toString("utf8")) as CdpMessage;
      this.buffer = this.buffer.subarray(end + 1);
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error.message));
        else waiter?.resolve(message.result ?? {});
      } else for (const listen of this.listeners) listen(message);
    }
  }

  private fail(error: Error) {
    if (this.exited) return;
    this.exited = error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.exited) return Promise.reject(this.exited);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      (this.child.stdio[3] as Writable).write(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }) + "\0");
    });
  }

  on(listen: (m: CdpMessage) => void) {
    this.listeners.add(listen);
    return () => this.listeners.delete(listen);
  }

  async close() {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const gone = new Promise(resolve => this.child.once("exit", resolve));
      this.child.kill("SIGKILL");
      await Promise.race([gone, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    this.fail(new Error("Chrome closed"));
    await rm(this.profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
  }
}

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

interface Page { sessionId: string; problems: string[] }

async function openPage(browser: Browser, url: string, size: { width: number; height: number; scale: number }, signal?: AbortSignal): Promise<Page> {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" }) as { targetId: string };
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true }) as { sessionId: string };
  const problems: string[] = [];
  const note = (line: string) => { if (problems.length < 10 && !problems.includes(line)) problems.push(line.slice(0, 300)); };
  let loaded: () => void = () => undefined;
  const load = new Promise<void>(resolve => { loaded = resolve; });
  browser.on(m => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Page.loadEventFired") loaded();
    else if (m.method === "Runtime.exceptionThrown") {
      const details = m.params?.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
      note(`Script error: ${details?.exception?.description?.split("\n")[0] ?? details?.text ?? "unknown"}`);
    } else if (m.method === "Log.entryAdded") {
      const entry = m.params?.entry as { level?: string; text?: string; url?: string } | undefined;
      if (entry?.level === "error") note(`${entry.text ?? "Error"}${entry.url ? ` (${entry.url})` : ""}`);
    } else if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") {
      const args = (m.params.args as Array<{ value?: unknown; description?: string }> | undefined) ?? [];
      note(`console.error: ${args.map(a => a.value ?? a.description ?? "").join(" ")}`);
    }
  });
  await Promise.all([
    browser.send("Page.enable", {}, sessionId), browser.send("Runtime.enable", {}, sessionId), browser.send("Log.enable", {}, sessionId),
    browser.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: size.scale, mobile: false }, sessionId),
    browser.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }, sessionId),
  ]);
  signal?.throwIfAborted();
  const navigated = await browser.send("Page.navigate", { url }, sessionId) as { errorText?: string };
  if (navigated.errorText) throw new Error(`Chrome couldn't open the graphic's page: ${navigated.errorText}`);
  await Promise.race([load, new Promise((_, reject) => setTimeout(() => reject(new Error("The graphic's page didn't finish loading within 30 s.")), 30_000))]);
  return { sessionId, problems };
}

async function evaluate<T>(browser: Browser, page: Page, expression: string): Promise<T> {
  const result = await browser.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, page.sessionId) as {
    result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (result.exceptionDetails) {
    throw new Error(`The graphic's page failed: ${result.exceptionDetails.exception?.description?.split("\n")[0] ?? result.exceptionDetails.text}`);
  }
  return result.result?.value as T;
}

async function prepare(browser: Browser, page: Page) {
  return evaluate<{ missing: MissingFont[]; installed: string[] }>(browser, page, PREPARE);
}

async function frameAt(browser: Browser, page: Page, ms: number): Promise<Buffer> {
  await evaluate(browser, page, `window.__scarletFrame(${fnum(ms, 3)})`);
  const { data } = await browser.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, captureBeyondViewport: false, fromSurface: true }, page.sessionId) as { data: string };
  return Buffer.from(data, "base64");
}

export interface GraphicPageOptions {
  /** The page to draw: an HTML file on disk. Relative links in it resolve beside it. */
  htmlFile: string;
  width: number;
  height: number;
  /** Explicit browser; otherwise `findChrome`. */
  chromePath?: string;
  signal?: AbortSignal;
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
  /** Milliseconds spent. */
  elapsedMs: number;
}

async function withBrowser<T>(opts: GraphicPageOptions, run: (browser: Browser, url: string) => Promise<T>): Promise<T> {
  if (!existsSync(opts.htmlFile)) throw new Error(`No graphic page at ${opts.htmlFile}`);
  const browser = await Browser.launch(findChrome(opts.chromePath), opts.signal);
  const abort = () => void browser.close();
  opts.signal?.addEventListener("abort", abort, { once: true });
  try {
    const result = await run(browser, pathToFileURL(opts.htmlFile).href);
    opts.signal?.throwIfAborted();
    return result;
  } catch (error) {
    if (opts.signal?.aborted) throw new AbortError();
    throw error;
  } finally {
    opts.signal?.removeEventListener("abort", abort);
    await browser.close();
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
    const pages = await Promise.all(Array.from({ length: workers }, () => openPage(browser, url, size, opts.signal)));
    const { missing: missingFonts, installed: installedFonts } = await prepare(browser, pages[0]!);
    await Promise.all(pages.slice(1).map(page => prepare(browser, page)));

    const ffmpeg = spawn(resolveFfmpeg(opts.ffmpegPath), [
      "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
      "-f", "image2pipe", "-c:v", "png", "-framerate", fnum(opts.fps), "-i", "pipe:0",
      ...GRAPHIC_CODEC_ARGS, "-r", fnum(opts.fps), "-an", opts.output,
    ], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let ffmpegError = "";
    ffmpeg.stderr!.on("data", (c: Buffer) => { ffmpegError = (ffmpegError + c.toString("utf8")).slice(-4000); });
    ffmpeg.stdin!.on("error", () => undefined);
    const finished = new Promise<void>((resolve, reject) => {
      ffmpeg.on("error", reject);
      ffmpeg.on("close", code => code === 0 ? resolve() : reject(new Error(`ffmpeg couldn't write the graphic (exit ${code}): ${ffmpegError.trim().split("\n").slice(-3).join(" ")}`)));
    });
    const kill = () => ffmpeg.kill("SIGKILL");
    opts.signal?.addEventListener("abort", kill, { once: true });

    // Frames are written in order. A page draws at most `window` frames ahead of the writer.
    const window = workers * 3;
    const ready = new Map<number, Buffer>();
    let written = 0;
    const waiting: Array<() => void> = [];
    const write = async () => {
      while (ready.has(written)) {
        const png = ready.get(written)!;
        ready.delete(written);
        written++;
        if (!ffmpeg.stdin!.write(png)) await new Promise(resolve => ffmpeg.stdin!.once("drain", resolve));
        opts.onProgress?.(written / total);
      }
      for (const resume of waiting.splice(0)) resume();
    };
    let writing = Promise.resolve();
    const draw = async (page: Page, first: number) => {
      for (let i = first; i < total; i += workers) {
        while (i >= written + window) await new Promise<void>(resolve => waiting.push(resolve));
        opts.signal?.throwIfAborted();
        ready.set(i, await frameAt(browser, page, (i / opts.fps) * 1000));
        writing = writing.then(write);
      }
    };
    try {
      await Promise.race([
        Promise.all(pages.map((page, w) => draw(page, w))),
        finished.then(() => { throw new Error("ffmpeg stopped before the graphic was drawn."); }),
      ]);
      await writing;
      ffmpeg.stdin!.end();
      await finished;
    } catch (error) {
      kill();
      await finished.catch(() => undefined);
      await rm(opts.output, { force: true });
      throw error;
    } finally {
      opts.signal?.removeEventListener("abort", kill);
    }
    return {
      output: opts.output, frames: total, missingFonts, installedFonts,
      problems: [...new Set(pages.flatMap(p => p.problems))].slice(0, 10),
      elapsedMs: Math.round(performance.now() - started),
    };
  });
}

/** Draw one moment of the page as a transparent PNG, scaled to `outputWidth` (a template's preview). */
export async function renderGraphicStill(opts: GraphicPageOptions & { time: number; outputWidth?: number }): Promise<{ png: Buffer; missingFonts: MissingFont[]; installedFonts: string[]; problems: string[] }> {
  return withBrowser(opts, async (browser, url) => {
    const scale = opts.outputWidth ? opts.outputWidth / opts.width : 1;
    const page = await openPage(browser, url, { width: opts.width, height: opts.height, scale }, opts.signal);
    const { missing: missingFonts, installed: installedFonts } = await prepare(browser, page);
    const png = await frameAt(browser, page, opts.time * 1000);
    return { png, missingFonts, installedFonts, problems: page.problems };
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
      "-hide_banner", "-nostdin", "-loglevel", "error", "-ss", fnum(time), "-i", file, "-frames:v", "1",
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
  const w = Math.max(2, Math.round(size.width / 2) * 2), h = Math.max(2, Math.round(size.height / 2) * 2);
  const base = background ? ["-f", "image2pipe", "-c:v", "mjpeg", "-i", "pipe:0"] : ["-f", "lavfi", "-i", `color=c=0x5a5a5a:s=${w}x${h}:d=1`];
  const { stdout } = await runCapture(resolveFfmpeg(opts.ffmpegPath), [
    "-hide_banner", "-nostdin", "-loglevel", "error", ...base, "-ss", fnum(time), "-i", movie,
    "-filter_complex", `[0:v]scale=${w}:${h},format=rgba[b];[1:v]scale=${w}:${h},format=rgba[g];[b][g]overlay=format=auto,format=yuvj420p`,
    "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "3", "-f", "image2pipe", "pipe:1",
  ], { stdin: background ?? undefined, signal: opts.signal, maxStdout: 8 * 1024 * 1024 });
  if (!stdout.length) throw new Error(`No frame of the graphic at ${time}s`);
  return stdout;
}

/** How many pages a PDF says it has, when its page tree is readable without decompressing it. */
export function pdfPageCount(pdf: Buffer): number | undefined {
  const text = pdf.toString("latin1");
  const counts = [...text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)].map(m => Number(m[1] ?? m[2]));
  return counts.length ? Math.max(...counts) : undefined;
}

/**
 * Pictures of a PDF's pages as Chrome's viewer draws them, JPEG, `width` wide: how a harness that can't open files
 * reads a document the editor attached, such as a style guide. Pages past the end are left out.
 */
export async function pdfPages(file: string, pages: number[], opts: { width?: number; chromePath?: string; signal?: AbortSignal; settleMs?: number } = {}): Promise<Buffer[]> {
  const width = opts.width ?? 1000, height = Math.round(width * 1.3);
  const { writeFile } = await import("node:fs/promises");
  const wrapper = join(await mkdtemp(join(tmpdir(), "scarlet-pdf-")), "page.html");
  try {
    await writeFile(wrapper, "<!doctype html>");
    return await withBrowser({ htmlFile: wrapper, width, height, chromePath: opts.chromePath, signal: opts.signal }, async browser => {
      const shots = await Promise.all(pages.map(async n => {
        const html = join(dirname(wrapper), `page-${n}.html`);
        await writeFile(html, `<!doctype html><html><body style="margin:0;background:#fff"><embed src="${pathToFileURL(file).href}#page=${n}&view=Fit&toolbar=0&navpanes=0" type="application/pdf" style="width:100vw;height:100vh;border:0"></body></html>`);
        const page = await openPage(browser, pathToFileURL(html).href, { width, height, scale: 1 }, opts.signal);
        // The viewer draws in its own process and says nothing when it has: give it a moment.
        await new Promise(resolve => setTimeout(resolve, opts.settleMs ?? 2000));
        const { data } = await browser.send("Page.captureScreenshot", { format: "jpeg", quality: 80, captureBeyondViewport: false }, page.sessionId) as { data: string };
        return Buffer.from(data, "base64");
      }));
      // A page number past the end shows the last page again.
      return shots.filter((shot, i) => i === 0 || !shot.equals(shots[i - 1]!));
    });
  } finally {
    await rm(dirname(wrapper), { recursive: true, force: true });
  }
}
