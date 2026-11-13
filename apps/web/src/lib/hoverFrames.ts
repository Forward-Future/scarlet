import { useEffect, useState } from "react";
import type { ProjectSummary } from "@scarlet/shared";
import { api } from "./client";

/** How many frames a card shows, how long each stays, and how wide they are fetched. */
const FRAMES = 6;
const EVERY = 550;
const WIDTH = 480;
/** The pointer rests this long, in ms, before the frames are asked for: passing over a list of cards asks for none. */
const REST = 250;

const reduceMotion = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : undefined;

/** Times spread through a video, a little in from each end, where its first and last seconds are often black. */
export function hoverTimes(duration: number, count = FRAMES) {
  if (!(duration > 0)) return [];
  return Array.from({ length: count }, (_, i) => duration * (0.08 + 0.84 * i / Math.max(1, count - 1)));
}

const sources = new Map<string, Promise<string[]>>();

/** The frame URLs for a project's card: from the video its poster comes from, else its first video. */
function framesFor(projectId: string, posterMedia?: string) {
  const key = `${projectId}/${posterMedia ?? ""}`;
  let urls = sources.get(key);
  if (!urls) {
    urls = api.media(projectId).then(({ media }) => {
      const video = media.find(m => m.kind === "video" && m.id === posterMedia) ?? media.find(m => m.kind === "video");
      return video?.duration ? hoverTimes(video.duration).map(time => api.frameUrl(video.id, time, WIDTH)) : [];
    }).catch(() => {
      sources.delete(key);
      return [];
    });
    sources.set(key, urls);
  }
  return urls;
}

/**
 * While the pointer rests on a project's card, its picture flips through a few silent frames of the project's own
 * footage, in order, and goes back to its poster when the pointer leaves. A frame shows only once it has loaded. With
 * motion reduced, the poster stays.
 */
export function useHoverFrames(projectId: string, poster: ProjectSummary["poster"], hasVideo: boolean) {
  const posterMedia = poster?.mediaId;
  const [hovering, setHovering] = useState(false);
  const [frame, setFrame] = useState<string>();
  useEffect(() => {
    if (!hovering || !hasVideo || reduceMotion?.matches) return;
    let live = true, timer = 0, shown = -1;
    const loaded: boolean[] = [];
    const rest = window.setTimeout(() => void framesFor(projectId, posterMedia).then(urls => {
      if (!live || !urls.length) return;
      urls.forEach((url, i) => {
        const image = new Image();
        image.onload = () => { loaded[i] = true; };
        image.src = url;
      });
      timer = window.setInterval(() => {
        // The next frame that has loaded, after the one showing.
        for (let step = 1; step <= urls.length; step++) {
          const next = (shown + step) % urls.length;
          if (loaded[next]) {
            if (next !== shown) setFrame(urls[next]);
            shown = next;
            return;
          }
        }
      }, EVERY);
    }), REST);
    return () => {
      live = false;
      window.clearTimeout(rest);
      window.clearInterval(timer);
      setFrame(undefined);
    };
  }, [hovering, hasVideo, projectId, posterMedia]);
  return { frame, onPointerEnter: () => setHovering(true), onPointerLeave: () => setHovering(false) };
}
