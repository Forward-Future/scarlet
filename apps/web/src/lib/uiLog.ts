/**
 * What the editor did and what the window went through, in the app log: every press and shortcut (`[action]`), every
 * page change (`[nav]`), focus, size and connection (`[window]`), and anything that went wrong outside a request
 * (`[error]`), including each alert the window puts up. Read with the `[api]`, `[realtime]`, `[playback]` and engine
 * lines around it, a bug report becomes "pressed this, then that happened".
 * Caught on the document, so nothing needs wiring into a component and new controls are covered as they're added.
 */
import { appLog, logPath, withoutAddresses } from "./appLog";

const clip = (text: string, max = 70) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const CONTROL = "button, a[href], [role=button], [role=menuitem], [role=menuitemradio], [role=tab], [role=option], [role=switch], [role=checkbox], [role=radio], summary, input, select, textarea, label, video";
const PLACE = "[role=dialog], [role=menu], [role=region], [role=group][aria-label], [role=toolbar], section[aria-label], aside[aria-label], nav[aria-label]";

const tagOf = (el: Element) => {
  const name = typeof el.className === "string" ? el.className.split(/\s+/).find(c => c && !/[:[\]/]/.test(c)) : undefined;
  return el.tagName.toLowerCase() + (name ? `.${name}` : "");
};

/** Where a control's own words are the editor's (a queued request): everything inside is named by its kind instead. */
const PRIVATE = "[data-log-private]";

/** A control by the name the editor reads on it. A field is named by its label, never by what was typed in it. */
function nameOf(el: Element) {
  if (el.closest(PRIVATE)) return "";
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return clip(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || el.id || "field");
  }
  return clip(el.getAttribute("aria-label") || el.getAttribute("title") || (el as HTMLElement).innerText || el.textContent || "");
}

function describe(target: Element) {
  const control = target.closest(CONTROL);
  const el = control ?? target;
  const place = el.parentElement?.closest(PLACE);
  const where = place ? clip(place.getAttribute("aria-label") || tagOf(place), 40) : undefined;
  if (!control) return { on: tagOf(el), in: where };
  const kind = control.getAttribute("role") ?? (control instanceof HTMLInputElement ? `input:${control.type}` : control.tagName.toLowerCase());
  return {
    on: nameOf(control) || tagOf(control), kind: kind === "button" ? undefined : kind, in: where,
    pressed: control.getAttribute("aria-pressed") ?? undefined, expanded: control.getAttribute("aria-expanded") ?? undefined,
    checked: control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "radio") ? control.checked : undefined,
    disabled: (control as HTMLButtonElement).disabled || control.getAttribute("aria-disabled") === "true" || undefined,
  };
}

function onClick(e: MouseEvent) {
  if (!(e.target instanceof Element)) return;
  const what = describe(e.target);
  // A press on something that isn't a control (the timeline, the picture) says where across it the press landed.
  const box = what.kind === undefined && !e.target.closest(CONTROL) ? e.target.getBoundingClientRect() : undefined;
  const across = box && box.width > 0 ? (e.clientX - box.left) / box.width : undefined;
  appLog("action", e.type === "dblclick" ? "double-click" : e.type === "contextmenu" ? "right-click" : "click",
    { ...what, across, mods: mods(e) || undefined });
}

const mods = (e: MouseEvent | KeyboardEvent) => [e.metaKey && "cmd", e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift"].filter(Boolean).join("+");

function onKey(e: KeyboardEvent) {
  if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;
  const target = e.target instanceof Element ? e.target : undefined;
  const typing = !!target && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target as HTMLElement).isContentEditable);
  const combo = e.metaKey || e.ctrlKey;
  // What is typed into a field is the editor's own words and stays out of the log; only the keys that act are named.
  if (typing && !combo && !["Enter", "Escape", "Tab"].includes(e.key)) return;
  const key = e.key === " " ? "Space" : e.key;
  const name = [mods(e), key].filter(Boolean).join("+");
  appLog("action", "key", { key: name, in: typing && target ? nameOf(target) : undefined, repeat: e.repeat || undefined }, { key: `key:${name}` });
}

function onSubmit(e: Event) {
  if (e.target instanceof HTMLFormElement) appLog("action", "submit", { form: clip(e.target.getAttribute("aria-label") || tagOf(e.target)) });
}

function onChange(e: Event) {
  const el = e.target;
  // A choice from a fixed set is an action; free text is not logged.
  if (el instanceof HTMLSelectElement) appLog("action", "choose", { on: nameOf(el), value: clip(el.selectedOptions[0]?.textContent ?? "") });
  else if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio" || el.type === "range")) {
    appLog("action", "set", { on: nameOf(el), value: el.type === "range" ? el.value : el.checked }, { key: `set:${nameOf(el)}` });
  } else if (el instanceof HTMLInputElement && el.type === "file") appLog("action", "pick-files", { on: nameOf(el), files: el.files?.length ?? 0 });
}

let shownPath = "";
function onNav(how: string) {
  const path = logPath(location.href) + (location.hash ? "#…" : "");
  if (path === shownPath) return;
  appLog("nav", how, { to: path, from: shownPath || undefined });
  shownPath = path;
}

function onResourceError(e: Event) {
  const el = e.target;
  // Scripts, styles and pictures that failed to load. Media elements report through the playback log.
  if (!(el instanceof Element) || el instanceof HTMLMediaElement) return;
  const src = (el as HTMLImageElement).currentSrc || el.getAttribute("src") || el.getAttribute("href");
  if (src) appLog("error", "resource", { el: tagOf(el), src: logPath(src) }, { key: `resource:${logPath(src)}`, level: "warn" });
}

const ALERT = "[role=alert]";
const said = new WeakMap<Element, string>();
/**
 * What an alert reads, without anything the editor typed: no field's contents, and nothing marked as their own words.
 * And without addresses: a failed sign-in shows what the agent's own program printed, the sign-in page included.
 */
function alertText(el: Element) {
  if (el.closest(PRIVATE)) return "";
  const copy = el.cloneNode(true) as Element;
  for (const own of copy.querySelectorAll(`${PRIVATE}, input, textarea, select, [contenteditable]`)) own.remove();
  return clip(withoutAddresses(copy.textContent ?? ""), 200);
}

/**
 * A refusal the window makes by itself (a message it won't send, an edit it can't open) asks nothing of the engine,
 * so it is on screen as an alert and nowhere else. Each alert that appears, or changes what it says, is one line.
 */
function onAlerts(records: MutationRecord[]) {
  const alerts = new Set<Element>();
  for (const record of records) {
    const within = (record.target instanceof Element ? record.target : record.target.parentElement)?.closest(ALERT);
    if (within) alerts.add(within);
    for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (node.matches(ALERT)) alerts.add(node);
      for (const el of node.querySelectorAll(ALERT)) alerts.add(el);
    }
  }
  for (const el of alerts) {
    if (!el.isConnected) continue;
    const message = alertText(el);
    if (said.get(el) === message) continue;
    said.set(el, message);
    const place = el.parentElement?.closest(PLACE);
    if (message) appLog("error", "alert", { message, in: place ? clip(place.getAttribute("aria-label") || tagOf(place), 40) : undefined }, { level: "warn" });
  }
}

const text = (value: unknown) => {
  if (value instanceof Error) return value.stack?.split("\n").slice(0, 4).join(" | ") ?? `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
};

let undo: (() => void)[] = [];

export function startUiLog() {
  stopUiLog();
  const on = <T extends EventTarget>(target: T, name: string, fn: (e: never) => void, capture = true) => {
    target.addEventListener(name, fn as EventListener, capture);
    undo.push(() => target.removeEventListener(name, fn as EventListener, capture));
  };
  on(document, "click", onClick);
  on(document, "dblclick", onClick);
  on(document, "contextmenu", onClick);
  on(document, "keydown", onKey);
  on(document, "submit", onSubmit);
  on(document, "change", onChange);
  on(window, "error", onResourceError);
  on(window, "focus", () => appLog("window", "focus"), false);
  on(window, "blur", () => appLog("window", "blur"), false);
  on(window, "online", () => appLog("window", "online"), false);
  on(window, "offline", () => appLog("window", "offline", undefined, { level: "warn" }), false);
  on(window, "resize", () => appLog("window", "resize", { width: innerWidth, height: innerHeight }, { key: "resize" }), false);
  on(window, "popstate", () => onNav("back-forward"), false);
  on(window, "hashchange", () => onNav("hash"), false);
  on(window, "pagehide", () => appLog("window", "closing"), false);

  const alerts = new MutationObserver(onAlerts);
  alerts.observe(document, { subtree: true, childList: true, characterData: true });
  undo.push(() => alerts.disconnect());

  // The router moves through history.pushState and replaceState, which fire no event.
  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method];
    history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
      original.apply(this, args);
      onNav(method === "pushState" ? "to" : "replace");
    };
    undo.push(() => { history[method] = original; });
  }

  // React and libraries report through the console, which the webview keeps nowhere.
  for (const level of ["error", "warn"] as const) {
    const original = console[level];
    console[level] = (...args: unknown[]) => {
      original.apply(console, args);
      const message = clip(args.map(text).join(" "), 600);
      appLog("error", `console.${level}`, { message }, { key: `console:${message.slice(0, 120)}`, level: level === "error" ? "error" : "warn" });
    };
    undo.push(() => { console[level] = original; });
  }

  shownPath = "";
  appLog("app", "start", { version: typeof __SCARLET_VERSION__ === "undefined" ? undefined : __SCARLET_VERSION__,
    revision: typeof __SCARLET_REVISION__ === "undefined" ? undefined : __SCARLET_REVISION__.slice(0, 12),
    width: innerWidth, height: innerHeight, scale: devicePixelRatio, agent: navigator.userAgent });
  onNav("open");
}

export function stopUiLog() {
  for (const fn of undo.splice(0).reverse()) fn();
}
