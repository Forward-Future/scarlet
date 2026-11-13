import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** One sweep of the loading wave, in seconds. workspace.css's `waveform-travel` runs for the same time. */
export const WAVE_PERIOD = 4.8;
/** A lane that finishes this soon before the other waits for it, so the two land as one. */
export const TOGETHER_MS = 250;
/** Loading shows only after this long, so a quick load just appears. workspace.css waits as long. */
export const GRACE_MS = 150;

/**
 * The delay that puts a loading wave starting now at the same point as every other one, so the picture's
 * glow and the sound's ripple move as one wave, whichever lane started loading first.
 */
export function wavePhase() {
  return `${(-((performance.now() / 1000) % WAVE_PERIOD)).toFixed(3)}s`;
}

export type Lane = "picture" | "sound";

/**
 * The picture and the sound load on their own. A lane that finishes while the other is still loading
 * waits up to TOGETHER_MS for it, then shows on its own, and the other keeps loading undisturbed.
 */
export function useLaneHold() {
  const [busy, setBusy] = useState<Record<Lane, boolean>>({ picture: false, sound: false });
  const [held, setHeld] = useState<Lane>();
  const last = useRef(busy);
  const report = useCallback((lane: Lane, loading: boolean) =>
    setBusy(now => now[lane] === loading ? now : { ...now, [lane]: loading }), []);
  useLayoutEffect(() => {
    const before = last.current;
    last.current = busy;
    const done = (["picture", "sound"] as const).find(lane => before[lane] && !busy[lane]);
    const other = done === "picture" ? "sound" : "picture";
    if (!busy.picture && !busy.sound) setHeld(undefined);
    else if (done && busy[other]) setHeld(done);
    else if (held && busy[held]) setHeld(undefined);
  }, [busy, held]);
  useEffect(() => {
    if (!held) return;
    const timer = window.setTimeout(() => setHeld(undefined), TOGETHER_MS);
    return () => clearTimeout(timer);
  }, [held]);
  return { report, held };
}

/**
 * Whether a lane's content is arriving after a wait the editor saw, so it should settle in
 * rather than appear. A load inside the grace period just appears.
 */
export function useArrival(waiting: boolean) {
  const wait = useRef<{ since: number; ended?: number }>(undefined);
  const [arriving, setArriving] = useState(false);
  useLayoutEffect(() => {
    const now = performance.now();
    if (waiting) {
      // A lane that finishes and is then held for the other lane is still the same wait.
      if (!wait.current || wait.current.ended !== undefined && now - wait.current.ended > 50) wait.current = { since: now };
      wait.current.ended = undefined;
      setArriving(false);
    } else if (wait.current && wait.current.ended === undefined) {
      wait.current.ended = now;
      setArriving(now - wait.current.since >= GRACE_MS);
    }
  }, [waiting]);
  return arriving;
}
