import { desktop } from "./desktop";

interface DropTarget {
  highlight(over: boolean): void;
  drop(paths: string[]): void;
}

export const dropTargets = new WeakMap<Element, DropTarget>();

/** A modal and its backdrop shield any drop zone outside the modal. */
export function fileDropZone(hit: EventTarget | null) {
  if (!(hit instanceof Element)) return null;
  const zone = hit.closest("[data-file-drop]");
  const dialog = hit.closest("dialog");
  return dialog && !dialog.contains(zone) ? null : zone;
}

/** Dispatch one native drop to the most specific visible target. */
export function listenForFileDrops(platform: "macos" | "windows") {
  let active = true;
  let previous: DropTarget | undefined;
  const unlisten = desktop.onDropFiles(event => {
    if (!active) return;
    const point = event.type === "leave" ? undefined : event.position;
    // Wry's WKWebView adapter forwards AppKit points; WebView2 forwards screen pixels.
    const scale = platform === "macos" ? 1 : window.devicePixelRatio;
    const hit = point ? document.elementFromPoint(point.x / scale, point.y / scale) : null;
    const element = fileDropZone(hit);
    const target = element ? dropTargets.get(element) : undefined;
    const next = event.type === "drop" ? undefined : target;
    if (previous !== next) {
      previous?.highlight(false);
      next?.highlight(true);
      previous = next;
    }
    if (event.type === "drop" && event.paths.length) target?.drop(event.paths);
  });
  void unlisten.catch(error => console.error("Could not receive dropped files", error));
  return () => {
    active = false;
    previous?.highlight(false);
    void unlisten.then(off => off()).catch(() => undefined);
  };
}
