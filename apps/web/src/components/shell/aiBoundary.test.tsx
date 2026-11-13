// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DialoguePreferences, ServerSettings } from "@scarlet/shared";
import { api } from "../../lib/client";
import { DialogueSettings } from "./DialogueSettings";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const settings = (dialogue: object = {}) => ServerSettings.parse({ transcription: {}, noteCleanup: {}, render: {}, dialogue });
/** Open a PreferenceSelect by its label and pick an option. */
async function choose(label: string, option: string) {
  const select = container.querySelector<HTMLButtonElement>(`[role="combobox"][aria-label="${label}"]`)!;
  await act(async () => select.click());
  const item = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(o => o.textContent === option)!;
  await act(async () => item.click());
}
const shown = (label: string) => container.querySelector(`[role="combobox"][aria-label="${label}"]`)?.textContent;

it("sets what Scarlet cuts on its own per kind and the pause tightness", async () => {
  vi.spyOn(api, "settings").mockResolvedValue({ settings: settings({ aiCuts: { retake: "suggest" } }) });
  const update = vi.spyOn(api, "updateSettings").mockImplementation(async body => ({ settings: settings(body.dialogue) }));
  await act(async () => root.render(<DialogueSettings />));
  expect(container.querySelector("h4")?.textContent).toBe("What Scarlet cuts on its own");
  expect(["Pauses", "Filler words", "Retakes", "Production talk", "Pause tightness"].map(shown)).toEqual(["Cut", "Cut", "Suggest", "Cut", "Natural"]);

  await choose("Filler words", "Off");
  expect(update).toHaveBeenLastCalledWith({ dialogue: {
    aiCuts: { pause: "cut", filler: "off", retake: "suggest", coaching: "cut" }, pauseTightness: "natural", crossfadeFrames: 2 } });
  expect(shown("Filler words")).toBe("Off");

  await choose("Pause tightness", "Tight");
  expect(update).toHaveBeenLastCalledWith({ dialogue: expect.objectContaining({ pauseTightness: "tight" }) });
  expect(shown("Pause tightness")).toBe("Tight");
});

it("sets the crossfade on cuts, from off to a few frames", async () => {
  vi.spyOn(api, "settings").mockResolvedValue({ settings: settings() });
  const update = vi.spyOn(api, "updateSettings").mockImplementation(async body => ({ settings: settings(body.dialogue) }));
  await act(async () => root.render(<DialogueSettings />));
  expect(shown("Crossfade on cuts")).toBe("2 frames");
  await choose("Crossfade on cuts", "Off");
  expect(update).toHaveBeenLastCalledWith({ dialogue: expect.objectContaining({ crossfadeFrames: 0 }) });
  expect(shown("Crossfade on cuts")).toBe("Off");
  await choose("Crossfade on cuts", "1 frame");
  expect(update).toHaveBeenLastCalledWith({ dialogue: expect.objectContaining({ crossfadeFrames: 1, pauseTightness: "natural" }) });
  expect(shown("Crossfade on cuts")).toBe("1 frame");
});

it("restores the previous choice when saving fails, and shows defaults for an engine without the setting", async () => {
  const { dialogue: _missing, ...older } = settings();
  vi.spyOn(api, "settings").mockResolvedValue({ settings: older as ServerSettings });
  vi.spyOn(api, "updateSettings").mockRejectedValue(new Error("Engine is offline."));
  await act(async () => root.render(<DialogueSettings />));
  expect(shown("Pauses")).toBe("Cut");
  await choose("Pauses", "Suggest");
  expect(shown("Pauses")).toBe("Cut");
  expect(container.textContent).toContain("Engine is offline.");
  expect(DialoguePreferences.parse({}).pauseTightness).toBe("natural");
});
