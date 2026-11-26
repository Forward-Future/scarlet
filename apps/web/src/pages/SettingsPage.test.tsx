// @vitest-environment happy-dom
import { openOptions, selectOption } from "../../test/selectOption";
import type { ServerSettings } from "@scarlet/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, createRoutesFromElements, Route, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../lib/client";
import { desktop } from "../lib/desktop";
import { buildDb } from "../lib/mock/fixtures";
import { useHostsStore } from "../stores/hosts";
import { useUiStore } from "../stores/ui";
import { SettingsPage } from "./SettingsPage";

const defaults = buildDb().settings;
const freshLocalSettings: ServerSettings = { ...defaults, transcription: { provider: "whispercpp", openaiModel: "whisper-1" } };
const crisperLocalSettings: ServerSettings = { ...defaults, transcription: { provider: "whispercpp", localModel: "crisperwhisper", openaiModel: "whisper-1" } };
const settings = { ...defaults, transcription: { ...defaults.transcription, provider: "openai" as const } };

let el: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(api, "settings").mockResolvedValue({ settings, transcriptionAvailable: true });
  vi.spyOn(api, "localModelStatus").mockResolvedValue({ state: "ready" });
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  useUiStore.setState(useUiStore.getInitialState());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const open = (path = "/settings") => act(async () => root.render(<RouterProvider router={createMemoryRouter(createRoutesFromElements(<>
  <Route path="/settings" element={<SettingsPage />} /><Route path="/" element={<p>Project library</p>} />
</>), { initialEntries: [path] })} />));
// A key press goes to whatever has focus and bubbles from there.
const esc = () => act(async () => {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
});
const heading = () => el.querySelector("h1")?.textContent;
const saveButton = () => el.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const transcribeWith = () => el.querySelector<HTMLButtonElement>("#tr-provider")!;
const languageSelect = () => el.querySelector<HTMLButtonElement>("#tr-lang")!;
const previewHeight = () => el.querySelector<HTMLButtonElement>("#rd-height")!;
const hardwareAccel = () => el.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Hardware acceleration"]')!;
const customLocalSettings: ServerSettings = {
  ...defaults,
  transcription: { ...defaults.transcription, provider: "whispercpp", localModel: "custom", whisperModelPath: "/models/old.bin", whisperCppPath: "/adapters/old" },
};

it("saves the telemetry switch from About and links the filler-word model credit", async () => {
  const save = vi.spyOn(api, "updateSettings").mockImplementation(async patch => ({ settings: { ...settings, ...patch } }));
  const browse = vi.spyOn(desktop, "openUrl").mockResolvedValue();
  await open("/settings#about");
  const toggle = el.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Send usage reports"]')!;
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  await act(async () => toggle.click());
  expect(save).toHaveBeenCalledExactlyOnceWith({ telemetryEnabled: false });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  const credit = el.querySelector<HTMLAnchorElement>('a[href="https://desertant.com"]')!;
  expect(credit.textContent).toBe("Uhm by Desert Ant Labs");
  await act(async () => credit.click());
  expect(browse).toHaveBeenCalledExactlyOnceWith("https://desertant.com");
});

it("shows reporting locked off by the environment even with a saved opt-in", async () => {
  vi.mocked(api.settings).mockResolvedValue({ settings, telemetryUnavailable: "environment" });
  await open("/settings#about");
  const toggle = el.querySelector<HTMLButtonElement>('[aria-label="Send usage reports"]')!;
  expect(toggle.disabled).toBe(true);
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(el.textContent).toContain("turned off by the engine environment");
});

it("saves how Scarlet talks to the editor when they leave the field, in their own words", async () => {
  const save = vi.spyOn(api, "updateSettings").mockImplementation(async patch => ({ settings: { ...settings, ...patch } }));
  await open("/settings");
  const field = el.querySelector<HTMLTextAreaElement>(".talking-to-you-field")!;
  expect(el.querySelector("#talking-to-you-heading")?.textContent).toBe("Talking to you");
  expect(field.value).toBe("");
  const type = (text: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await type("  Say times as 1:05, not 65 seconds.\n");
  expect(save).not.toHaveBeenCalled();
  await act(async () => { field.focus(); field.blur(); });
  expect(save).toHaveBeenCalledExactlyOnceWith({ talkingToYou: "Say times as 1:05, not 65 seconds." });
  expect(field.value).toBe("Say times as 1:05, not 65 seconds.");
  // Leaving the field again with nothing changed saves nothing.
  await act(async () => { field.focus(); field.blur(); });
  expect(save).toHaveBeenCalledOnce();
});

it("keeps what the editor wrote about how Scarlet talks when the save fails, to be saved again", async () => {
  const save = vi.spyOn(api, "updateSettings").mockRejectedValueOnce(new Error("The engine is offline."))
    .mockImplementation(async patch => ({ settings: { ...settings, ...patch } }));
  await open("/settings");
  const field = el.querySelector<HTMLTextAreaElement>(".talking-to-you-field")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Keep notes short.");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { field.focus(); field.blur(); });
  expect(el.querySelector(".talking-to-you")?.textContent).toContain("The engine is offline.");
  expect(field.value).toBe("Keep notes short.");
  await act(async () => { field.focus(); field.blur(); });
  expect(save).toHaveBeenCalledTimes(2);
  expect(field.value).toBe("Keep notes short.");
  expect(el.querySelector(".talking-to-you")?.textContent).not.toContain("The engine is offline.");
});

it("shows only language, preview quality and hardware acceleration on Advanced and saves each right away", async () => {
  const save = vi.spyOn(api, "updateSettings").mockImplementation(async patch => ({ settings: { ...settings, ...patch } as typeof settings }));
  await open("/settings#advanced");
  // No Save button, and internal knobs (note cleanup, handle seconds, concurrency, OpenAI model, encoder list) stay out of view.
  expect(el.querySelector('button[type="submit"]')).toBeNull();
  expect(el.textContent).not.toMatch(/Note cleanup|Handle seconds|Concurrency|OpenAI model|videotoolbox|nvenc/);
  expect(languageSelect().textContent).toBe("English");
  expect(previewHeight().textContent).toBe("540p (default)");
  expect(hardwareAccel().getAttribute("aria-checked")).toBe("true");

  // Choosing Auto-detect sends null so the engine clears the saved language.
  await selectOption(languageSelect(), "Auto-detect");
  const sent = JSON.parse(JSON.stringify(save.mock.calls[0]![0]));
  expect(sent).toMatchObject({ transcription: { provider: "openai", language: null } });

  await selectOption(previewHeight(), "720p");
  expect(save).toHaveBeenLastCalledWith({ render: expect.objectContaining({ previewHeight: 720 }) });

  await act(async () => hardwareAccel().click());
  expect(save).toHaveBeenLastCalledWith({ render: expect.objectContaining({ hwaccel: "none" }) });
  expect(hardwareAccel().getAttribute("aria-checked")).toBe("false");

  await act(async () => hardwareAccel().click());
  expect(save).toHaveBeenLastCalledWith({ render: expect.objectContaining({ hwaccel: "auto" }) });
  expect(hardwareAccel().getAttribute("aria-checked")).toBe("true");
});

it("keeps an uncommon saved transcription language selectable in the dropdown", async () => {
  vi.mocked(api.settings).mockResolvedValue({
    settings: { ...settings, transcription: { ...settings.transcription, language: "uk" } },
    transcriptionAvailable: true,
  });
  await open("/settings#advanced");
  expect(languageSelect().textContent).toBe("uk");
});

it("leaves Settings on Esc when nothing is unsaved", async () => {
  await open("/settings#advanced");
  await esc();
  expect(el.textContent).toBe("Project library");
});

it("keeps Settings open on Esc while custom local model paths are unsaved and moves focus to Save", async () => {
  vi.mocked(api.settings).mockResolvedValue({ settings: customLocalSettings, transcriptionAvailable: true });
  let finish!: () => void;
  const save = vi.spyOn(api, "updateSettings").mockImplementation(patch => new Promise(resolve => {
    finish = () => resolve({ settings: { ...customLocalSettings, ...patch } as typeof customLocalSettings });
  }));
  await open("/settings#advanced");
  const model = el.querySelector<HTMLInputElement>("#tr-modelpath")!;
  await act(async () => {
    model.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(model, "/models/new.bin");
    model.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(saveButton().disabled).toBe(false);
  // First Esc blurs the text field, second moves focus to Save.
  await esc();
  expect(document.activeElement).toBe(document.body);
  await esc();
  expect(heading()).toBe("Settings");
  expect(document.activeElement).toBe(saveButton());
  await esc();
  expect(heading()).toBe("Settings");
  expect(document.activeElement).toBe(saveButton());
  await act(async () => saveButton().click());
  expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ transcription: expect.objectContaining({ whisperModelPath: "/models/new.bin" }) }));
  // The change isn't saved until the engine answers.
  await esc();
  expect(heading()).toBe("Settings");
  await act(async () => finish());
  expect(saveButton().disabled).toBe(true);
  await esc();
  expect(el.textContent).toBe("Project library");
});

it("leaves Esc to an open list, which closes without leaving Settings", async () => {
  await open();
  await act(async () => transcribeWith().click());
  expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  // Transcription can't be turned off: the list offers only the ways to run it.
  expect([...document.querySelectorAll('[role="option"]')].map(o => o.textContent))
    .toEqual(["Whisper large-v3-turbo (default)", "CrisperWhisper 2.0", "Custom local model", "OpenAI Whisper (cloud)"]);
  await esc();
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  expect(heading()).toBe("Settings");
  await esc();
  expect(el.textContent).toBe("Project library");
});

it("says who is signed in once on General, in the card, and has no default to pick that the selector would override", async () => {
  const save = vi.spyOn(api, "updateSettings").mockImplementation(async patch => ({ settings: { ...settings, ...patch } as typeof settings }));
  await open();
  // No menu over the card lists the same sign-ins again.
  expect(el.querySelector('[aria-haspopup="menu"]')).toBeNull();
  expect(el.querySelectorAll("#hosts")).toHaveLength(1);
  expect(el.querySelector(".settings-page")!.firstElementChild!.nextElementSibling!.id).toBe("hosts");
  // The model is picked in the selector, which a default here never changed once one was picked.
  expect(el.querySelector("form h2")?.textContent).toBe("Speech transcription");
  expect([...el.querySelectorAll<HTMLLabelElement>("form label")].map(label => [label.htmlFor, label.textContent])).toEqual([["tr-provider", "Preferred model"]]);
  // The one choice left is saved as it is made, and nothing else goes with it.
  await selectOption(transcribeWith(), "Whisper large-v3-turbo (default)");
  expect(save).toHaveBeenCalledExactlyOnceWith({ transcription: expect.objectContaining({ provider: "whispercpp", localModel: "whispercpp" }) });
});

it("picks how much Scarlet checks with the editor on General, saved as it is chosen", async () => {
  const save = vi.spyOn(api, "updateSettings").mockImplementation(async patch => ({ settings: { ...settings, ...patch } as typeof settings }));
  await open();
  const card = el.querySelector(".check-in-preferences")!;
  expect(card.querySelector("h2")?.textContent).toBe("Checking with you");
  expect(card.querySelector("label")?.textContent).toBe("Ask me to check");
  const pick = card.querySelector<HTMLElement>("#check-in")!;
  // Balanced until the editor says otherwise, and the line under it says what that step brings them.
  expect(pick.textContent).toBe("Balanced");
  expect(card.querySelector(".transcription-status")?.textContent).toBe("About one in four of the cuts that take words out: the ones Scarlet thinks most likely to be wrong. They go into the video either way and wait in Needs review until you keep them. The same share of the lines said twice that Scarlet would leave in comes to you as a call: Keep takes one out.");
  expect((await openOptions(pick)).map(option => option.textContent)).toEqual(["Less", "Balanced", "More"]);
  await act(async () => pick.click());
  await selectOption(pick, "More");
  expect(save).toHaveBeenCalledExactlyOnceWith({ checkIn: "more" });
  expect(pick.textContent).toBe("More");
  expect(card.querySelector(".transcription-status")?.textContent).toContain("About half of the cuts that take words out");
});

const typeInto = (field: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
});

it("shows the settings once Retry gets through after a failed load", async () => {
  vi.spyOn(api, "settings").mockRejectedValueOnce(new Error("Engine unreachable"));
  await open("/settings#advanced");
  expect(el.textContent).toContain("Couldn’t load server settings");
  expect(el.textContent).toContain("Engine unreachable");
  await act(async () => [...el.querySelectorAll("button")].find(b => b.textContent?.trim() === "Retry")!.click());
  expect(el.textContent).not.toContain("Couldn’t load server settings");
  expect(el.querySelector("#tr-lang")).not.toBeNull();
});

const press = (text: string) => act(async () => {
  [...document.querySelectorAll<HTMLElement>("a, button")].find(c => c.textContent?.trim() === text)!.click();
});
const asking = () => document.querySelector("dialog[open]")?.textContent ?? "";

it("asks before a tab or the back link drops unsaved custom local model paths", async () => {
  vi.mocked(api.settings).mockResolvedValue({ settings: customLocalSettings, transcriptionAvailable: true });
  const save = vi.spyOn(api, "updateSettings").mockImplementation(async patch => ({ settings: { ...customLocalSettings, ...patch } as typeof customLocalSettings }));
  await open("/settings#advanced");
  const model = () => el.querySelector<HTMLInputElement>("#tr-modelpath")!;
  expect(model().value).toBe("/models/old.bin");
  await typeInto(model(), "/models/new.bin");
  await press("About");
  expect(asking()).toContain("These settings have unsaved changes.");
  expect(el.querySelector('[aria-current="true"]')?.textContent).toBe("Advanced");
  // Stay keeps the change where it was.
  await press("Stay");
  expect(asking()).toBe("");
  expect(model().value).toBe("/models/new.bin");
  // Discard leaves without saving, and the old value is what comes back.
  await press("About");
  await press("Discard changes");
  expect(el.querySelector('[aria-current="true"]')?.textContent).toBe("About");
  expect(save).not.toHaveBeenCalled();
  await press("Advanced");
  expect(model().value).toBe("/models/old.bin");
  // Save and leave saves first.
  await typeInto(model(), "/models/new.bin");
  await press("← Projects");
  expect(asking()).toContain("These settings have unsaved changes.");
  await press("Save and leave");
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ transcription: expect.objectContaining({ whisperModelPath: "/models/new.bin" }) }));
  expect(el.textContent).toBe("Project library");
});

it("holds Restart to update while custom model paths are unsaved, as the skill editor does", async () => {
  vi.mocked(api.settings).mockResolvedValue({ settings: customLocalSettings, transcriptionAvailable: true });
  vi.spyOn(api, "updateSettings").mockImplementation(async patch => ({ settings: { ...customLocalSettings, ...patch } as typeof customLocalSettings }));
  // Restart to update asks the page first, and restarts only if nothing cancels.
  const restartAllowed = () => window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
  await open("/settings#advanced");
  expect(restartAllowed()).toBe(true);
  await typeInto(el.querySelector<HTMLInputElement>("#tr-modelpath")!, "/models/new.bin");
  expect(restartAllowed()).toBe(false);
  await act(async () => saveButton().click());
  expect(saveButton().disabled).toBe(true);
  expect(restartAllowed()).toBe(true);
});

it("waits for an immediate Advanced save before switching tabs and puts the choice back if it fails", async () => {
  let fail!: () => void;
  vi.spyOn(api, "updateSettings").mockImplementation(() => new Promise((_resolve, reject) => {
    fail = () => reject(new Error("Engine unreachable"));
  }));
  await open("/settings#advanced");
  await selectOption(previewHeight(), "720p");
  await press("About");
  expect(el.querySelector('[aria-current="true"]')?.textContent).toBe("Advanced");
  expect(el.textContent).toContain("Saving…");
  await act(async () => fail());
  expect(el.querySelector('[aria-current="true"]')?.textContent).toBe("Advanced");
  expect(el.querySelector('form [role="alert"]')?.textContent).toBe("Engine unreachable");
  expect(previewHeight().textContent).toBe("540p (default)");
  await press("About");
  expect(el.querySelector('[aria-current="true"]')?.textContent).toBe("About");
});

it("saves a General dropdown as it is chosen, with no Save to press", async () => {
  const save = vi.spyOn(api, "updateSettings").mockImplementation(async patch => ({ settings: { ...settings, ...patch } as typeof settings }));
  await open();
  expect(el.querySelector('button[type="submit"]')).toBeNull();
  await selectOption(transcribeWith(), "CrisperWhisper 2.0");
  expect(save).toHaveBeenCalledExactlyOnceWith({ transcription: expect.objectContaining({ provider: "whispercpp", localModel: "crisperwhisper" }) });
  expect(transcribeWith().textContent).toContain("CrisperWhisper");
  // Put back, it is saved again, and nothing is left to ask about on the way to another tab.
  await selectOption(transcribeWith(), "OpenAI Whisper (cloud)");
  expect(save).toHaveBeenLastCalledWith({ transcription: expect.objectContaining({ provider: "openai" }) });
  await press("About");
  expect(asking()).toBe("");
  expect(el.querySelector('[aria-current="true"]')?.textContent).toBe("About");
});

it.each(["Advanced", "← Projects"])("waits for General to save before going to %s", async destination => {
  let finish!: () => void;
  const save = vi.spyOn(api, "updateSettings").mockImplementation(patch => new Promise(resolve => {
    finish = () => {
      const saved = { ...settings, ...patch };
      vi.mocked(api.settings).mockResolvedValue({ settings: saved, transcriptionAvailable: true });
      resolve({ settings: saved });
    };
  }));
  await open();
  await selectOption(transcribeWith(), "Whisper large-v3-turbo (default)");
  expect(save).toHaveBeenCalledOnce();
  await press(destination);
  expect(el.querySelector('[aria-current="true"]')?.textContent).toBe("General");
  expect(el.textContent).toContain("Saving…");
  await act(async () => finish());
  expect(el.querySelector('[aria-current="true"]')?.textContent ?? el.textContent)
    .toBe(destination === "Advanced" ? destination : "Project library");
});

it("shows a General save error if the editor tried to change tabs during the save", async () => {
  let fail!: () => void;
  vi.spyOn(api, "updateSettings").mockImplementation(() => new Promise((_resolve, reject) => {
    fail = () => reject(new Error("Engine unreachable"));
  }));
  await open();
  await selectOption(transcribeWith(), "Whisper large-v3-turbo (default)");
  await press("Advanced");
  await act(async () => fail());
  expect(el.querySelector('[aria-current="true"]')?.textContent).toBe("General");
  expect(el.querySelector('form [role="alert"]')?.textContent).toBe("Engine unreachable");
  expect(transcribeWith().textContent).toContain("OpenAI Whisper");
  await press("Advanced");
  expect(el.querySelector('[aria-current="true"]')?.textContent).toBe("Advanced");
});

it("defaults fresh local settings to bundled Whisper without CrisperWhisper setup", async () => {
  vi.mocked(api.settings).mockResolvedValue({ settings: freshLocalSettings, transcriptionAvailable: true });
  vi.mocked(api.localModelStatus).mockResolvedValue({ state: "ready", selected: "whispercpp", active: "whispercpp", fallback: false });
  await open();
  expect(transcribeWith().textContent).toBe("Whisper large-v3-turbo (default)");
  expect(el.querySelector("form details")).toBeNull();
  expect(el.querySelector("form")?.textContent).not.toContain("Set up CrisperWhisper");
});

it("shows the bundled fallback for first-install CrisperWhisper and opens its pinned model files through the desktop", async () => {
  vi.mocked(api.settings).mockResolvedValue({ settings: crisperLocalSettings, transcriptionAvailable: true });
  vi.mocked(api.localModelStatus).mockResolvedValue({ state: "ready", selected: "crisperwhisper", active: "whispercpp", fallback: true });
  const browse = vi.spyOn(desktop, "openUrl").mockResolvedValue();
  await open();
  expect(transcribeWith().textContent).toBe("CrisperWhisper 2.0");
  expect(el.querySelector('form [role="status"]')?.textContent).toContain("Using bundled Whisper");
  const guide = el.querySelector<HTMLDetailsElement>("form details")!;
  const summary = guide.querySelector("summary")!;
  expect(guide.open).toBe(false);
  expect(summary.textContent).toContain("Set up CrisperWhisper");
  const license = "Commercial use requires a separate license.";
  expect(el.querySelector("form")?.textContent).toContain(license);
  expect([...guide.children].filter(child => child !== summary).some(child => child.textContent?.includes(license))).toBe(false);
  await act(async () => summary.click());
  expect(guide.open).toBe(true);
  expect(guide.textContent).toContain("Python 3.12");
  expect(guide.textContent).toContain("downloads the runtime libraries");
  await press("CrisperWhisper 2.0 large model files");
  expect(browse).toHaveBeenCalledWith("https://huggingface.co/nyralabs/CrisperWhisper2.0_large/tree/f4334f6e8193f2691212d49b20fa12d370e13896");
});

it("names the bundled Whisper fallback while its download is still in progress", async () => {
  vi.mocked(api.settings).mockResolvedValue({ settings: crisperLocalSettings, transcriptionAvailable: true });
  vi.mocked(api.localModelStatus).mockResolvedValue({
    state: "downloading", selected: "crisperwhisper", active: "whispercpp", fallback: true, received: 35, total: 100,
  });
  await open();
  expect(transcribeWith().textContent).toContain("CrisperWhisper");
  const status = el.querySelector('form [role="status"]')?.textContent;
  expect(status).toMatch(/bundled Whisper/i);
  expect(status).toMatch(/download/i);
  expect(status).toContain("35%");
  expect(status).not.toMatch(/using bundled Whisper/i);
});

it("shows where audio goes when switching between cloud, bundled and custom transcription", async () => {
  vi.spyOn(api, "updateSettings").mockImplementation(async patch => ({ settings: { ...settings, ...patch } }));
  await open();
  const form = el.querySelector("form")!;
  const cloud = "Audio is sent to OpenAI for transcription.";
  const local = "Audio stays on this computer.";
  expect(form.textContent).toContain(cloud);
  expect(form.textContent).not.toContain(local);
  await selectOption(transcribeWith(), "Whisper large-v3-turbo (default)");
  expect(form.textContent).toContain(local);
  expect(form.textContent).not.toContain(cloud);
  await selectOption(transcribeWith(), "Custom local model");
  expect(form.textContent).toContain("Scarlet passes audio to the selected local runtime.");
  expect(form.textContent).not.toContain(local);
});

const setupButton = (label: string) => [...el.querySelectorAll<HTMLButtonElement>("form details button")]
  .find(button => button.textContent?.trim() === label)!;

it("cancels the native folder picker without starting or saving an installation", async () => {
  vi.mocked(api.settings).mockResolvedValue({ settings: crisperLocalSettings, transcriptionAvailable: true });
  const pick = vi.spyOn(desktop, "pickFolder").mockResolvedValue(null);
  const install = vi.spyOn(desktop, "installCrisperModel");
  const save = vi.spyOn(api, "updateSettings");
  await open();
  await act(async () => el.querySelector<HTMLElement>("form summary")!.click());
  await press("Install from folder…");
  expect(pick).toHaveBeenCalledExactlyOnceWith("Choose the CrisperWhisper model folder");
  expect(install).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(setupButton("Install from folder…").disabled).toBe(false);
});

it("can retry an installation error and keeps showing a pending install when General reopens", async () => {
  vi.mocked(api.settings).mockResolvedValue({ settings: crisperLocalSettings, transcriptionAvailable: true });
  vi.mocked(api.localModelStatus).mockResolvedValue({ state: "ready", selected: "crisperwhisper", active: "whispercpp", fallback: true });
  const pick = vi.spyOn(desktop, "pickFolder").mockResolvedValueOnce("/models/partial").mockResolvedValueOnce("/models/complete checkpoint");
  const issue = "The model folder is missing tokenizer.json.";
  let finish!: () => void;
  const install = vi.spyOn(desktop, "installCrisperModel").mockRejectedValueOnce(issue).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await open();
  const expand = () => act(async () => el.querySelector<HTMLElement>("form summary")!.click());
  await expand();
  await press("Install from folder…");
  expect(el.querySelector("form details [role=alert]")?.textContent).toBe(issue);
  await press("Retry from folder…");
  expect(install.mock.calls).toEqual([["/models/partial"], ["/models/complete checkpoint"]]);
  expect(el.querySelector("form details [role=alert]")).toBeNull();
  await press("About");
  await press("General");
  await expand();
  const pending = setupButton("Installing CrisperWhisper…");
  expect(pending.disabled).toBe(true);
  await act(async () => pending.click());
  expect(pick).toHaveBeenCalledTimes(2);
  vi.mocked(api.localModelStatus).mockResolvedValue({ state: "ready", selected: "crisperwhisper", active: "crisperwhisper", fallback: false });
  await act(async () => finish());
  expect(el.querySelector('form [role="status"]')?.textContent).toBe("CrisperWhisper is ready.");
  expect(el.querySelector("form details")).toBeNull();
});

it("hides CrisperWhisper setup while checking and when CrisperWhisper is already installed", async () => {
  vi.mocked(api.settings).mockResolvedValue({ settings: crisperLocalSettings, transcriptionAvailable: true });
  let resolveStatus!: (status: Awaited<ReturnType<typeof api.localModelStatus>>) => void;
  vi.mocked(api.localModelStatus).mockImplementation(() => new Promise(resolve => { resolveStatus = resolve; }));
  await open();
  expect(el.querySelector('form [role="status"]')?.textContent).toBe("Checking model…");
  expect(el.querySelector("form details")).toBeNull();
  await act(async () => resolveStatus({ state: "ready", selected: "crisperwhisper", active: "crisperwhisper", fallback: false }));
  expect(el.querySelector('form [role="status"]')?.textContent).toBe("CrisperWhisper is ready.");
  expect(el.querySelector("form details")).toBeNull();
  expect(el.querySelector("form")?.textContent).not.toContain("Set up CrisperWhisper");
});

it("can turn on the local default from a previously disabled transcription provider", async () => {
  const disabled: ServerSettings = { ...defaults, transcription: { ...defaults.transcription, provider: "none" } };
  vi.mocked(api.settings).mockResolvedValue({ settings: disabled, transcriptionAvailable: false });
  const save = vi.spyOn(api, "updateSettings").mockImplementation(async patch => ({ settings: { ...disabled, ...patch } }));
  await open();
  expect(transcribeWith().textContent).toBe("Transcription unavailable");
  await selectOption(transcribeWith(), "Whisper large-v3-turbo (default)");
  expect(save).toHaveBeenCalledExactlyOnceWith({ transcription: expect.objectContaining({ provider: "whispercpp", localModel: "whispercpp" }) });
});

it("uses the engine's recognized preset for older paths and explains when there is no local runtime", async () => {
  const previous = { ...defaults, transcription: { ...defaults.transcription, whisperModelPath: "/data/preset/model.safetensors" } };
  vi.mocked(api.settings).mockResolvedValue({ settings: previous, transcriptionAvailable: true });
  const reason = "CrisperWhisper is not installed and the bundled Whisper runtime is unavailable.";
  vi.mocked(api.localModelStatus).mockResolvedValue({ state: "missing", selected: "crisperwhisper", fallback: false, reason });
  await open();
  expect(transcribeWith().textContent).toBe("CrisperWhisper 2.0");
  expect(el.querySelector('form [role="status"]')?.textContent).toBe(reason);
});

it("discovers existing custom paths, browses for replacements and saves them across local and cloud choices", async () => {
  const paths = { whisperModelPath: "/models/old.bin", whisperCppPath: "/adapters/old" };
  let current: ServerSettings = { ...defaults, transcription: { ...defaults.transcription, ...paths } };
  vi.mocked(api.settings).mockImplementation(async () => ({ settings: current, transcriptionAvailable: true }));
  const save = vi.spyOn(api, "updateSettings").mockImplementation(async patch => {
    current = { ...current, ...patch };
    return { settings: current };
  });
  const pick = vi.spyOn(desktop, "pickFile").mockResolvedValueOnce(null).mockResolvedValueOnce("/models/my model.bin").mockResolvedValueOnce("/adapters/my adapter");
  await open();
  expect(transcribeWith().textContent).toBe("Custom local model");
  await press("Configure model file and adapter");
  const model = el.querySelector<HTMLInputElement>("#tr-modelpath")!;
  const adapter = el.querySelector<HTMLInputElement>("#tr-bin")!;
  expect([model.value, adapter.value]).toEqual([paths.whisperModelPath, paths.whisperCppPath]);
  const selectFile = (label: string) => act(async () => el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
  await selectFile("Choose model file");
  expect(saveButton().disabled).toBe(true);
  await selectFile("Choose model file");
  await selectFile("Choose adapter executable");
  expect(pick.mock.calls).toEqual([["Choose model file"], ["Choose model file"], ["Choose adapter executable"]]);
  expect(save).not.toHaveBeenCalled();
  await act(async () => saveButton().click());
  const replacement = { whisperModelPath: "/models/my model.bin", whisperCppPath: "/adapters/my adapter" };
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ transcription: expect.objectContaining({ ...replacement, localModel: "custom" }) }));
  await press("General");
  await selectOption(transcribeWith(), "Whisper large-v3-turbo (default)");
  expect(save).toHaveBeenLastCalledWith({ transcription: expect.objectContaining({ ...replacement, provider: "whispercpp", localModel: "whispercpp" }) });
  await selectOption(transcribeWith(), "OpenAI Whisper (cloud)");
  expect(save).toHaveBeenLastCalledWith({ transcription: expect.objectContaining({ ...replacement, provider: "openai" }) });
  await selectOption(transcribeWith(), "Custom local model");
  await press("Configure model file and adapter");
  expect(el.querySelector<HTMLInputElement>("#tr-modelpath")?.value).toBe(replacement.whisperModelPath);
  expect(el.querySelector<HTMLInputElement>("#tr-bin")?.value).toBe(replacement.whisperCppPath);
});

it("puts a General dropdown back and says why when its choice can't be saved", async () => {
  vi.spyOn(api, "updateSettings").mockRejectedValue(new Error("Engine unreachable"));
  await open();
  await selectOption(transcribeWith(), "Whisper large-v3-turbo (default)");
  expect(transcribeWith().textContent).toContain("OpenAI Whisper");
  expect(el.querySelector('form [role="alert"]')?.textContent).toBe("Engine unreachable");
  // Esc still leaves: nothing here is waiting to be saved.
  await esc();
  expect(el.textContent).toBe("Project library");
});

it("counts a custom path put back as no change: Save goes dim and leaving doesn't ask", async () => {
  vi.mocked(api.settings).mockResolvedValue({ settings: customLocalSettings, transcriptionAvailable: true });
  await open("/settings#advanced");
  const model = el.querySelector<HTMLInputElement>("#tr-modelpath")!;
  await typeInto(model, "/models/other.bin");
  expect(saveButton().disabled).toBe(false);
  await typeInto(model, "/models/old.bin");
  expect(saveButton().disabled).toBe(true);
  await press("About");
  expect(asking()).toBe("");
  expect(el.querySelector('[aria-current="true"]')?.textContent).toBe("About");
});

it("leaves by a tab without asking when nothing is unsaved", async () => {
  await open();
  await press("About");
  expect(asking()).toBe("");
  expect(el.querySelector('[aria-current="true"]')?.textContent).toBe("About");
});

it("says on Models what is true signed in or not: no models until Claude Code or Codex is online", async () => {
  const hosts = useHostsStore.getState();
  const said = () => el.querySelector(".settings-page section.card p")?.textContent;
  try {
    // Signed in, on a computer that isn't connected just now. The sign-in card says signed in and the message box
    // says the model is offline, so Models doesn't say to sign in.
    const signedIn = buildDb().hosts[0]!;
    expect(signedIn.agents[0]).toMatchObject({ id: "claude", installed: true, loggedIn: true });
    useHostsStore.setState({ status: "ready", error: null, hosts: [{ ...signedIn, online: false }] });
    await open("/settings#models");
    expect(said()).toBe("Models appear when Claude Code, Codex or Gemini is online. Manage sign-in");
    // The same under the reason, when the list of computers couldn't be read.
    await act(async () => useHostsStore.setState({ status: "error", error: "Engine unreachable", hosts: [] }));
    expect(el.querySelector('[role="alert"]')?.textContent).toBe("Engine unreachable");
    expect(said()).toBe("Models appear when Claude Code, Codex or Gemini is online. Manage sign-in");
    // And with nobody signed in, where the link beside it is the way on.
    await act(async () => useHostsStore.setState({ status: "ready", error: null, hosts: [] }));
    expect(said()).toBe("Models appear when Claude Code, Codex or Gemini is online. Manage sign-in");
    expect(el.querySelector('.settings-page section.card p a')?.getAttribute("href")).toBe("/settings#hosts");
  } finally {
    await act(async () => useHostsStore.setState(hosts, true));
  }
});
