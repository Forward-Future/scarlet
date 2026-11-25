import { create } from "zustand";

const SPEED_UP_RATE_KEY = "scarlet.speedUpRate";

export const SPEED_UP_RATES = [1.25, 1.5, 1.75, 2] as const;
export type SpeedUpRate = (typeof SPEED_UP_RATES)[number];
export const DEFAULT_SPEED_UP_RATE: SpeedUpRate = 1.5;

function loadSpeedUpRate(): SpeedUpRate {
  try {
    const saved = Number(localStorage.getItem(SPEED_UP_RATE_KEY));
    if (SPEED_UP_RATES.includes(saved as SpeedUpRate)) return saved as SpeedUpRate;
  } catch { /* Keep the default for this session. */ }
  return DEFAULT_SPEED_UP_RATE;
}

interface PlayerState {
  time: number;
  /** Counts explicit transport seeks so continuous-play checks do not treat a short skip as watching. */
  seeks: number;
  /** Active captured timeline drag, cleared on release, cancellation or unmount. */
  scrubGesture?: AbortSignal;
  duration: number;
  playing: boolean;
  /** The attached player has enough media to keep playing after its latest start, seek or wait. */
  playbackReady: boolean;
  rate: number;
  /** Playback speed applied by pressing L (defaults to 1.5×). */
  speedUpRate: SpeedUpRate;
  setTime(t: number, seek?: boolean): void;
  setDuration(d: number): void;
  setPlaying(p: boolean): void;
  setRate(r: number): void;
  setSpeedUpRate(r: SpeedUpRate): void;
}

export const usePlayerStore = create<PlayerState>((set) => ({
  time: 0,
  seeks: 0,
  duration: 0,
  playing: false,
  playbackReady: false,
  rate: 1,
  speedUpRate: loadSpeedUpRate(),
  setTime: (time, seek) => set(state => !seek && state.time === time ? state : { time, ...(seek && { seeks: state.seeks + 1 }) }),
  setDuration: (duration) => set({ duration }),
  setPlaying: (playing) => set({ playing, playbackReady: false }),
  setRate: (rate) => set({ rate }),
  setSpeedUpRate: (speedUpRate) => {
    try {
      if (speedUpRate === DEFAULT_SPEED_UP_RATE) localStorage.removeItem(SPEED_UP_RATE_KEY);
      else localStorage.setItem(SPEED_UP_RATE_KEY, String(speedUpRate));
    } catch { /* Keep the choice for this session. */ }
    set({ speedUpRate });
  },
}));
