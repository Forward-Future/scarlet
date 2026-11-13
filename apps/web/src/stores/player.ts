import { create } from "zustand";

interface PlayerState {
  time: number;
  /** Active captured timeline drag, cleared on release, cancellation or unmount. */
  scrubGesture?: AbortSignal;
  duration: number;
  playing: boolean;
  /** The attached player has enough media to keep playing after its latest start, seek or wait. */
  playbackReady: boolean;
  rate: number;
  setTime(t: number): void;
  setDuration(d: number): void;
  setPlaying(p: boolean): void;
  setRate(r: number): void;
}

export const usePlayerStore = create<PlayerState>((set) => ({
  time: 0,
  duration: 0,
  playing: false,
  playbackReady: false,
  rate: 1,
  setTime: (time) => set(state => state.time === time ? state : { time }),
  setDuration: (duration) => set({ duration }),
  setPlaying: (playing) => set({ playing, playbackReady: false }),
  setRate: (rate) => set({ rate }),
}));
