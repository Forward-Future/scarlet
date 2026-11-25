import { create } from "zustand";

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
  /** Active J/K/L shuttle speed (−4, −2, −1, 0 when off, 1, 2, 4). Leaves `rate` untouched. */
  shuttleRate: number;
  setTime(t: number, seek?: boolean): void;
  setDuration(d: number): void;
  setPlaying(p: boolean): void;
  setRate(r: number): void;
  setShuttleRate(r: number): void;
}

export const usePlayerStore = create<PlayerState>((set) => ({
  time: 0,
  seeks: 0,
  duration: 0,
  playing: false,
  playbackReady: false,
  rate: 1,
  shuttleRate: 0,
  setTime: (time, seek) => set(state => !seek && state.time === time ? state : { time, ...(seek && { seeks: state.seeks + 1 }) }),
  setDuration: (duration) => set({ duration }),
  setPlaying: (playing) => set({ playing, playbackReady: false }),
  setRate: (rate) => set({ rate }),
  setShuttleRate: (shuttleRate) => set({ shuttleRate }),
}));
