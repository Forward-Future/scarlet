import { useEffect, useState, type RefObject } from "react";

/**
 * Whether the picture on screen in the monitor is still loading. The play button shows it in place of its icon: the one
 * place that says so, whichever player is waiting. A seek or a stall counts once it has taken longer than a blink, on a
 * video that is on screen. So does a player's own word that it is preparing a section, which it gives by marking its
 * video `data-waiting`.
 */
export function usePictureWait(monitor: RefObject<HTMLDivElement | null>) {
  const [pending, setPending] = useState(false);
  const [preparing, setPreparing] = useState(false);
  useEffect(() => {
    const root = monitor.current;
    if (!root) return;
    let target: HTMLVideoElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => { clearTimeout(timer); timer = undefined; target = null; setPending(false); };
    const start = (e: Event) => {
      if (!(e.target instanceof HTMLVideoElement) || e.target.closest("[hidden]")) return;
      if (target === e.target) return;
      clear();
      target = e.target;
      timer = setTimeout(() => {
        if (target?.isConnected && !target.closest("[hidden]") && (target.seeking || target.readyState < 3)) setPending(true);
        else clear();
      }, 180);
    };
    const finish = (e: Event) => { if (e.target === target) clear(); };
    const ends = ["loadeddata", "seeked", "playing", "canplay", "error", "ended", "abort", "emptied"];
    for (const name of ["seeking", "waiting"]) root.addEventListener(name, start, true);
    for (const name of ends) root.addEventListener(name, finish, true);
    let marked: ReturnType<typeof setTimeout> | undefined;
    const readMarks = () => {
      if ([...root.querySelectorAll("video[data-waiting]")].some(video => !video.closest("[hidden]"))) marked ??= setTimeout(() => setPreparing(true), 180);
      else { clearTimeout(marked); marked = undefined; setPreparing(false); }
    };
    readMarks();
    const observer = new MutationObserver(() => {
      if (target && (!root.contains(target) || target.closest("[hidden]"))) clear();
      readMarks();
    });
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "data-waiting"] });
    return () => {
      clearTimeout(timer); clearTimeout(marked); observer.disconnect();
      for (const name of ["seeking", "waiting"]) root.removeEventListener(name, start, true);
      for (const name of ends) root.removeEventListener(name, finish, true);
    };
  }, [monitor]);
  return pending || preparing;
}
