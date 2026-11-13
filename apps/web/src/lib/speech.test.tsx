// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "./client";
import type { RecorderResult } from "./recorder";
import { useSpeech } from "./speech";

const recording: RecorderResult = { blob: new Blob(["voice"], { type: "audio/webm" }), seconds: 2, mimeType: "audio/webm" };
const heard = vi.fn<(text: string, recording: RecorderResult) => void | Promise<void>>();
const failed = vi.fn<(message: string) => void>();
let speech: ReturnType<typeof useSpeech>;
let root: Root;

function Listener() {
  speech = useSpeech(heard, failed);
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  heard.mockReset();
  failed.mockReset();
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Listener />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("turns a recording into text, trimmed, and is busy until the text has been handed over", async () => {
  let answer!: (response: { text: string }) => void;
  const send = vi.spyOn(api, "speechToText").mockImplementation(() => new Promise(resolve => { answer = resolve; }));
  let handed!: () => void;
  heard.mockImplementation(() => new Promise<void>(resolve => { handed = resolve; }));
  let done!: Promise<void>;
  await act(async () => { done = speech.handle(recording); });
  expect(speech.busy).toBe(true);
  expect(send).toHaveBeenCalledExactlyOnceWith(recording.blob);
  await act(async () => { answer({ text: "  cut the first minute \n" }); });
  expect(heard).toHaveBeenCalledExactlyOnceWith("cut the first minute", recording);
  // Still busy while the message is being sent.
  expect(speech.busy).toBe(true);
  await act(async () => { handed(); await done; });
  expect(speech.busy).toBe(false);
  expect(failed).not.toHaveBeenCalled();
});

it("says it didn't catch that when nothing was said, and sends nothing", async () => {
  vi.spyOn(api, "speechToText").mockResolvedValue({ text: "   " });
  await act(() => speech.handle(recording));
  expect(heard).not.toHaveBeenCalled();
  expect(failed).toHaveBeenCalledExactlyOnceWith("Didn't catch that. Try again, or type it.");
  expect(speech.busy).toBe(false);
});

it("reports why when the engine can't transcribe, or when the text can't be sent", async () => {
  const send = vi.spyOn(api, "speechToText").mockRejectedValue(new Error("Speech model is still downloading"));
  await act(() => speech.handle(recording));
  expect(failed).toHaveBeenLastCalledWith("Speech model is still downloading");
  send.mockResolvedValue({ text: "zoom in here" });
  heard.mockRejectedValue(new Error("Scarlet is offline"));
  await act(() => speech.handle(recording));
  expect(failed).toHaveBeenLastCalledWith("Scarlet is offline");
  expect(failed).toHaveBeenCalledTimes(2);
  expect(speech.busy).toBe(false);
});
