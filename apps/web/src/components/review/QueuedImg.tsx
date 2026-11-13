import { useEffect, useRef, useState, type ImgHTMLAttributes } from "react";

// The window reaches the engine over at most six connections, and an image holds one until its picture arrives.
// While a pass keeps the engine's picture lane busy a filmstrip still can take a minute, so a strip of twenty
// would hold all six and an opened edit's timeline, waveform and playback would wait behind it. Stills take
// turns on two of them; the rest stay free for everything else.
export const STILL_CONNECTIONS = 2;

let loading = 0;
const waiting: Array<() => void> = [];

function next() {
  while (loading < STILL_CONNECTIONS && waiting.length) {
    loading++;
    waiting.shift()!();
  }
}

/** Waits for a turn, then gives the still back. Releases its turn once it loads, fails or unmounts. */
export function useStillTurn(src: string | undefined) {
  const [shown, setShown] = useState<string>();
  const release = useRef<() => void>(() => {});
  useEffect(() => {
    setShown(undefined);
    if (!src) return;
    let state: "waiting" | "loading" | "done" = "waiting";
    const start = () => { state = "loading"; setShown(src); };
    const done = () => {
      if (state === "waiting") waiting.splice(waiting.indexOf(start), 1);
      else if (state === "loading") { loading--; next(); }
      state = "done";
    };
    release.current = done;
    waiting.push(start);
    next();
    return done;
  }, [src]);
  return [shown, () => release.current()] as const;
}

/** An image whose request waits for one of the stills' connections. It keeps its place in the layout meanwhile. */
export function QueuedImg({ src, onLoad, onError, ...props }: ImgHTMLAttributes<HTMLImageElement> & { src?: string }) {
  const [shown, release] = useStillTurn(src);
  return <img {...props} src={shown}
    onLoad={e => { release(); onLoad?.(e); }}
    onError={e => { release(); onError?.(e); }} />;
}
