// @vitest-environment happy-dom
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MicButton } from "../components/agent/MicButton";
import { ProjectLayout } from "../components/shell/ProjectLayout";
import { useUiStore } from "../stores/ui";
import { startAppLog, stopAppLog } from "./appLog";
import { MAX_RECORD_SECONDS, useRecorder } from "./recorder";

let root: Root | undefined;
let grant: (stream: MediaStream) => void;
const result = vi.fn();
const stopTrack = vi.fn();
const startRecording = vi.fn();
const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;

const recorders: TestRecorder[] = [];
class TestRecorder {
  static isTypeSupported() { return true; }
  state = "inactive";
  mimeType = "audio/webm";
  onstop?: () => void;
  onerror?: () => void;
  ondataavailable?: (event: { data: Blob }) => void;
  constructor() { recorders.push(this); }
  start() { this.state = "recording"; startRecording(); }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["voice"]) });
    this.onstop?.();
  }
}

function key(type: "keydown" | "keyup") {
  return act(async () => { window.dispatchEvent(new KeyboardEvent(type, { key: "v" })); });
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("MediaRecorder", TestRecorder);
  vi.clearAllMocks();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: () => new Promise<MediaStream>((resolve) => { grant = resolve; }) },
  });
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(
    <StrictMode><MemoryRouter><ProjectLayout /><MicButton followHold onResult={result} /></MemoryRouter></StrictMode>,
  ));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["key release", "unmount", "window blur"])("discards late microphone permission after %s", async (action) => {
  await key("keydown");
  expect(useUiStore.getState().voiceHold).toBe(true);
  if (action === "key release") await key("keyup");
  if (action === "window blur") await act(async () => { window.dispatchEvent(new Event("blur")); });
  if (action === "unmount") {
    await act(async () => root!.unmount());
    root = undefined;
  }
  expect(useUiStore.getState().voiceHold).toBe(false);
  await act(async () => { grant(stream); });
  expect(stopTrack).toHaveBeenCalledOnce();
  expect(startRecording).not.toHaveBeenCalled();
  expect(result).not.toHaveBeenCalled();
});

it("delivers one recording on release when permission arrives while held", async () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(1000);
  await key("keydown");
  await act(async () => { grant(stream); });
  expect(startRecording).toHaveBeenCalledOnce();
  now.mockReturnValue(2000);
  await key("keyup");
  expect(stopTrack).toHaveBeenCalledOnce();
  expect(result).toHaveBeenCalledOnce();
  expect(result.mock.calls[0]![0]).toMatchObject({ seconds: 1, mimeType: "audio/webm" });
});

it("starts a hold again after the microphone was refused once", async () => {
  const getUserMedia = vi.fn<() => Promise<MediaStream>>()
    .mockRejectedValueOnce(new DOMException("Permission denied", "NotAllowedError"))
    .mockImplementation(() => new Promise<MediaStream>((resolve) => { grant = resolve; }));
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  const now = vi.spyOn(performance, "now").mockReturnValue(1000);
  await key("keydown");
  await key("keyup");
  expect(getUserMedia).toHaveBeenCalledOnce();
  // The editor allows the microphone and holds V again. A click on the mic would ask again, and so does the hold.
  await key("keydown");
  expect(getUserMedia).toHaveBeenCalledTimes(2);
  await act(async () => { grant(stream); });
  expect(startRecording).toHaveBeenCalledOnce();
  now.mockReturnValue(2000);
  await key("keyup");
  expect(result).toHaveBeenCalledOnce();
});

/** The recorder by itself, with what it shows. */
let recorder: ReturnType<typeof useRecorder>;
const heard = vi.fn();
function Recorder() {
  recorder = useRecorder(heard);
  return null;
}
async function recording() {
  const host = createRoot(document.createElement("div"));
  await act(async () => host.render(<Recorder />));
  await act(async () => { void recorder.start(); });
  await act(async () => { grant(stream); });
  expect(recorder.state).toBe("recording");
  return { host, device: recorders.at(-1)! };
}

it("says the recording failed and sends nothing when the recorder breaks part-way", async () => {
  const lines: string[] = [], levels: string[] = [];
  startAppLog((batch, level) => { lines.push(...batch); levels.push(level); });
  const now = vi.spyOn(performance, "now").mockReturnValue(1000);
  const { host, device } = await recording();
  now.mockReturnValue(3000);
  // A recorder that fails reports the error, then hands over what it had and stops.
  await act(async () => { device.onerror!(); device.stop(); });
  expect(recorder).toMatchObject({ state: "error", error: "Recording failed.", recording: false });
  expect(heard).not.toHaveBeenCalled();
  expect(stopTrack).toHaveBeenCalled();
  expect(lines).toEqual([expect.stringMatching(/^\[error\] .* microphone when=recording$/)]);
  expect(levels).toEqual(["warn"]);
  stopAppLog();
  // The microphone can be tried again.
  await act(async () => { void recorder.start(); });
  await act(async () => { grant(stream); });
  expect(recorder.state).toBe("recording");
  now.mockReturnValue(5000);
  await act(async () => recorder.stop());
  expect(heard).toHaveBeenCalledOnce();
  await act(async () => host.unmount());
});

it("stops by itself at the longest recording it takes, and hands that over", async () => {
  vi.useFakeTimers();
  try {
    const { host } = await recording();
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(recorder.elapsed).toBeCloseTo(30, 0);
    expect(heard).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime((MAX_RECORD_SECONDS - 30) * 1000); });
    expect(heard).toHaveBeenCalledOnce();
    expect(heard.mock.calls[0]![0].seconds).toBeCloseTo(MAX_RECORD_SECONDS, 0);
    expect(recorder).toMatchObject({ state: "idle", elapsed: 0 });
    // The clock stopped with it.
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(recorder.elapsed).toBe(0);
    await act(async () => host.unmount());
  } finally {
    vi.useRealTimers();
  }
});

it("throws away a tap too short to be speech, and a recording the editor discards", async () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(1000);
  const { host } = await recording();
  now.mockReturnValue(1300);
  await act(async () => recorder.stop());
  expect(recorder.state).toBe("idle");
  expect(heard).not.toHaveBeenCalled();
  await act(async () => { void recorder.start(); });
  await act(async () => { grant(stream); });
  now.mockReturnValue(9000);
  await act(async () => recorder.stop(true));
  expect(recorder.state).toBe("idle");
  expect(heard).not.toHaveBeenCalled();
  await act(async () => host.unmount());
});

it.each([
  ["NotAllowedError", "denied", "Microphone access was denied. Allow the microphone for Scarlet and try again."],
  ["SecurityError", "denied", "Microphone access was denied. Allow the microphone for Scarlet and try again."],
  ["NotFoundError", "error", "No microphone found."],
  ["NotReadableError", "error", "The microphone is in use"],
] as const)("says why the microphone couldn't be used (%s), and logs the kind of refusal", async (name, state, message) => {
  const lines: string[] = [], levels: string[] = [];
  startAppLog((batch, level) => { lines.push(...batch); levels.push(level); });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: () => Promise.reject(new DOMException("The microphone is in use", name)) } });
  const host = createRoot(document.createElement("div"));
  await act(async () => host.render(<Recorder />));
  await act(async () => { await recorder.start(); });
  stopAppLog();
  expect(recorder).toMatchObject({ state, error: message, recording: false });
  expect(lines).toEqual([expect.stringMatching(new RegExp(`^\\[error\\] .* microphone when=starting name=${name}$`))]);
  expect(levels).toEqual(["warn"]);
  expect(startRecording).not.toHaveBeenCalled();
  await act(async () => host.unmount());
});

it("is unsupported where the window can't record, and does nothing when asked to", async () => {
  vi.stubGlobal("MediaRecorder", undefined);
  const asked = vi.fn();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: asked } });
  const host = createRoot(document.createElement("div"));
  await act(async () => host.render(<Recorder />));
  expect(recorder.state).toBe("unsupported");
  await act(async () => { await recorder.start(); });
  expect(asked).not.toHaveBeenCalled();
  expect(recorder.state).toBe("unsupported");
  await act(async () => host.unmount());
});

it("reads the voice's level from the microphone, from silence to clear speech", async () => {
  const { voiceLevel } = await import("./recorder");
  expect(voiceLevel([])).toBe(0);
  expect(voiceLevel(new Float32Array(512))).toBe(0);
  // About -60 dB is silence, -26 dB ordinary speech, and -14 dB loud speech.
  expect(voiceLevel(new Float32Array(512).fill(0.001))).toBe(0);
  expect(voiceLevel(new Float32Array(512).fill(0.05))).toBeCloseTo(0.72, 1);
  expect(voiceLevel(new Float32Array(512).fill(0.2))).toBe(1);
});

it("rings the mic with the voice while it records, and lets it go when it stops", async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const close = vi.fn(async () => {});
  let loud = 0.2;
  class TestAudio {
    resume = async () => {};
    close = close;
    createAnalyser() { return { fftSize: 0, getFloatTimeDomainData: (out: Float32Array) => out.fill(loud) }; }
    createMediaStreamSource() { return { connect() {} }; }
  }
  vi.stubGlobal("AudioContext", TestAudio);
  const button = () => document.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => root!.unmount());
  root = createRoot(host);
  await act(async () => root!.render(<MemoryRouter><MicButton onResult={result} /></MemoryRouter>));
  await act(async () => { button().click(); });
  await act(async () => { grant(stream); });
  expect(button().className).toContain("mic-voice");
  const draw = async () => act(async () => { frames.splice(0).forEach(cb => cb(0)); });
  await draw();
  expect(button().style.getPropertyValue("--voice")).toBe("1.000");
  // Between words it falls back gently, not at once.
  loud = 0;
  await draw();
  expect(button().style.getPropertyValue("--voice")).toBe("0.860");
  await act(async () => { button().click(); });
  expect(button().style.getPropertyValue("--voice")).toBe("");
  expect(button().className).not.toContain("mic-voice");
  expect(close).toHaveBeenCalled();
  host.remove();
});
