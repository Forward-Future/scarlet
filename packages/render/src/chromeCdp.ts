/**
 * Headless Chrome discovery and DevTools Protocol client over `--remote-debugging-pipe`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse, posix } from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { AbortError, logElapsed, logReason, logRender } from "./exec.js";

/** The browser's program name for the log, without its folder: "Google Chrome", "msedge". */
function chromeName(chrome: string): string {
  return parse(chrome.replace(/\\/g, "/")).name || "Chrome";
}

/** How long Chrome has to start, and a page to load. */
const CHROME_START_MS = 30_000;
const PAGE_LOAD_MS = 30_000;

/** `work`, unless `ms` pass first (an error saying `message`) or `signal` aborts. Leaves no timer or listener behind. */
export async function within<T>(work: Promise<T>, ms: number, message: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      if (!signal) return;
      onAbort = () => reject(new AbortError());
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

/** Where Chrome, Chromium, Edge or chrome-headless-shell is usually installed, in the order tried. */
export function chromeCandidates(platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === "darwin") {
    const apps = [
      "Google Chrome.app/Contents/MacOS/Google Chrome",
      "Chromium.app/Contents/MacOS/Chromium",
      "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    ];
    return [...apps.map(app => posix.join("/Applications", app)), ...apps.map(app => posix.join(env.HOME || homedir(), "Applications", app))];
  }
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter((d): d is string => !!d);
    const apps = ["Google\\Chrome\\Application\\chrome.exe", "Microsoft\\Edge\\Application\\msedge.exe", "Chromium\\Application\\chrome.exe"];
    return roots.flatMap(root => apps.map(app => `${root}\\${app}`));
  }
  const dirs = (env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":").filter(Boolean);
  const names = ["chrome-headless-shell", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable"];
  return [...names.flatMap(name => dirs.map(dir => posix.join(dir, name))), "/snap/bin/chromium"];
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

export interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
  sessionId?: string;
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

export interface CdpPage {
  sessionId: string;
  problems: string[];
}

/** One headless Chrome, its temporary profile, and the DevTools protocol over its pipe. */
export class Browser {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<(m: CdpMessage) => void>();
  /** The pieces of a message still arriving. A 4K frame comes as hundreds of them, and they are joined once, at its end. */
  private parts: Buffer[] = [];
  private exited: Error | undefined;
  private rejectGone: (error: Error) => void = () => undefined;
  /** Rejects once Chrome has exited or been closed, with why. */
  readonly gone = new Promise<never>((_, reject) => { this.rejectGone = reject; });

  private constructor(private readonly child: ChildProcess, private readonly profile: string, private readonly stderr: string[]) {
    this.gone.catch(() => undefined);
    const out = child.stdio[4] as Readable;
    out.on("data", (chunk: Buffer) => this.read(chunk));
    out.on("error", error => this.fail(error));
    (child.stdio[3] as Writable).on("error", error => this.fail(error));
    child.on("exit", (code, sig) => {
      if (!this.closing) logRender(`[graphics] Chrome exited by itself (${sig ?? code}) while it was drawing`, "chrome-exit");
      this.fail(new Error(`Chrome exited (${sig ?? code}) while drawing the graphic${this.stderr.length ? `: ${this.stderr.join("").slice(-600)}` : ""}`));
    });
    child.on("error", error => this.fail(error));
  }

  /** Set once Scarlet starts closing it, so its exit is expected. */
  private closing = false;

  /** Start Chrome. One that doesn't answer in time, or a stop meanwhile, leaves no process or profile behind. */
  static async launch(chrome: string, signal?: AbortSignal, timeoutMs = CHROME_START_MS): Promise<Browser> {
    signal?.throwIfAborted();
    const started = Date.now();
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
    let browser: Browser | undefined;
    try {
      const child = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], windowsHide: true });
      const stderr: string[] = [];
      child.stderr?.on("data", (chunk: Buffer) => { stderr.push(chunk.toString("utf8")); if (stderr.length > 40) stderr.shift(); });
      browser = new Browser(child, profile, stderr);
      await within(browser.send("Browser.getVersion"), timeoutMs, `Chrome didn't start within ${Math.round(timeoutMs / 1000)} s.`, signal);
      const took = Date.now() - started;
      if (took >= 5_000) logRender(`[graphics] ${chromeName(chrome)} was slow to start: ${logElapsed(took)}`);
      return browser;
    } catch (error) {
      if (!signal?.aborted) logRender(() => `[graphics] ${chromeName(chrome)} didn't start after ${logElapsed(Date.now() - started)}: ${logReason(error)}`, "chrome-start");
      if (browser) await browser.close();
      else await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
      throw error;
    }
  }

  private read(chunk: Buffer) {
    let from = 0;
    for (let end = chunk.indexOf(0); end >= 0; end = chunk.indexOf(0, from)) {
      this.parts.push(chunk.subarray(from, end));
      const message = JSON.parse((this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts)).toString("utf8")) as CdpMessage;
      this.parts = [];
      from = end + 1;
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error.message));
        else waiter?.resolve(message.result ?? {});
      } else for (const listen of this.listeners) listen(message);
    }
    if (from < chunk.length) this.parts.push(chunk.subarray(from));
  }

  private fail(error: Error) {
    if (this.exited) return;
    this.exited = error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.rejectGone(error);
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
    this.closing = true;
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const gone = new Promise(resolve => this.child.once("exit", resolve));
      this.child.kill("SIGKILL");
      await Promise.race([gone, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    this.fail(new Error("Chrome closed"));
    await rm(this.profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
  }
}

export async function openPage(browser: Browser, url: string, size: { width: number; height: number; scale: number }, signal?: AbortSignal): Promise<CdpPage> {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" }) as { targetId: string };
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true }) as { sessionId: string };
  const problems: string[] = [];
  const note = (line: string) => { if (problems.length < 10 && !problems.includes(line)) problems.push(line.slice(0, 300)); };
  // The load of the navigation started below, by its loader: the first page, about:blank, may still report its own.
  const loads = new Set<string>();
  let loaderId: string | undefined;
  let loaded: () => void = () => undefined;
  const load = new Promise<void>(resolve => { loaded = resolve; });
  browser.on(m => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Page.lifecycleEvent" && m.params?.name === "load" && typeof m.params.loaderId === "string") {
      loads.add(m.params.loaderId);
      if (m.params.loaderId === loaderId) loaded();
    }
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
    browser.send("Page.enable", {}, sessionId), browser.send("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId),
    browser.send("Runtime.enable", {}, sessionId), browser.send("Log.enable", {}, sessionId),
    browser.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: size.scale, mobile: false }, sessionId),
    browser.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }, sessionId),
  ]);
  signal?.throwIfAborted();
  const navigated = await within(browser.send("Page.navigate", { url }, sessionId), PAGE_LOAD_MS,
    "The graphic's page didn't finish loading within 30 s.", signal) as { errorText?: string; loaderId?: string };
  if (navigated.errorText) throw new Error(`Chrome couldn't open the graphic's page: ${navigated.errorText}`);
  loaderId = navigated.loaderId;
  if (!loaderId || loads.has(loaderId)) loaded();
  // Chrome exiting or a stop ends the wait at once, with its own reason.
  await within(Promise.race([load, browser.gone]), PAGE_LOAD_MS, "The graphic's page didn't finish loading within 30 s.", signal);
  return { sessionId, problems };
}

export async function evaluate<T>(browser: Browser, page: CdpPage, expression: string): Promise<T> {
  const result = await browser.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, page.sessionId) as {
    result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (result.exceptionDetails) {
    throw new Error(`The graphic's page failed: ${result.exceptionDetails.exception?.description?.split("\n")[0] ?? result.exceptionDetails.text}`);
  }
  return result.result?.value as T;
}

/** Run `work` in a fresh headless Chrome that the signal closes. It's checked once more after `work` returns, an
 * abort turns any failure into an AbortError, and the browser always closes. */
export async function inBrowser<T>(opts: { chromePath?: string; signal?: AbortSignal }, work: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await Browser.launch(findChrome(opts.chromePath), opts.signal);
  const abort = () => void browser.close();
  opts.signal?.addEventListener("abort", abort, { once: true });
  try {
    const result = await work(browser);
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

export async function withBrowser<T>(opts: GraphicPageOptions, run: (browser: Browser, url: string) => Promise<T>): Promise<T> {
  if (!existsSync(opts.htmlFile)) throw new Error(`No graphic page at ${opts.htmlFile}`);
  return inBrowser(opts, browser => {
    opts.signal?.throwIfAborted();
    return run(browser, pathToFileURL(opts.htmlFile).href);
  });
}
