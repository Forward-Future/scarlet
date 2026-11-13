// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useCutAudio } from "./useCutAudio";

afterEach(() => vi.unstubAllGlobals());

it("keeps one silent clock during review, retries it on user gesture, and closes it when standby is disabled", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  class Audio {
    state = "suspended";
    destination = {};
    gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
    oscillator = { connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn() };
    createGain = () => this.gain;
    createOscillator = () => this.oscillator;
    resume = vi.fn(async () => {});
    close = vi.fn(async () => {});
  }
  const output: Audio[] = [];
  vi.stubGlobal("AudioContext", vi.fn(function () { const audio = new Audio(); output.push(audio); return audio; }));
  function Monitor({ enabled }: { enabled: boolean }) { useCutAudio(enabled); return null; }
  const root = createRoot(document.createElement("div"));
  const show = (enabled: boolean) => act(async () => root.render(<StrictMode><Monitor enabled={enabled} /></StrictMode>));
  try {
    await show(true);
    const last = output.at(-1)!;
    expect(output.filter(audio => !audio.close.mock.calls.length)).toEqual([last]);
    expect(last.gain.gain.value).toBe(0);
    expect(last.oscillator.connect).toHaveBeenCalledWith(last.gain);
    expect(last.gain.connect).toHaveBeenCalledWith(last.destination);
    expect(last.oscillator.start).toHaveBeenCalledOnce();
    last.resume.mockClear();
    window.dispatchEvent(new KeyboardEvent("keydown"));
    expect(last.resume).toHaveBeenCalledOnce();
    await show(false);
    expect(last.oscillator.stop).toHaveBeenCalledOnce();
    expect(last.close).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event("pointerdown"));
    expect(last.resume).toHaveBeenCalledOnce();
  } finally { await act(() => root.unmount()); }
});
