// @vitest-environment happy-dom
import { selectOption } from "../../test/selectOption";
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
// Advanced is the tab with a Save: its dropdowns wait for it, as its typed fields do.
const previewHeight = () => el.querySelector<HTMLButtonElement>("#rd-height")!;

it("leaves Settings on Esc when nothing is unsaved", async () => {
  await open("/settings#advanced");
  expect(saveButton().disabled).toBe(true);
  await esc();
  expect(el.textContent).toBe("Project library");
});

it("keeps Settings open on Esc while a change is unsaved and moves focus to Save", async () => {
  await open("/settings#advanced");
  await selectOption(previewHeight(), "720p");
  expect(document.activeElement).toBe(previewHeight());
  await esc();
  expect(heading()).toBe("Settings");
  expect(document.activeElement).toBe(saveButton());
  await esc();
  expect(heading()).toBe("Settings");
  expect(document.activeElement).toBe(saveButton());
});

it("leaves on Esc again once the change is saved", async () => {
  let finish!: () => void;
  const save = vi.spyOn(api, "updateSettings").mockImplementation(patch => new Promise(resolve => {
    finish = () => resolve({ settings: { ...settings, ...patch } as typeof settings });
  }));
  await open("/settings#advanced");
  await selectOption(previewHeight(), "720p");
  await esc();
  await act(async () => saveButton().click());
  expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ render: expect.objectContaining({ previewHeight: 720 }) }));
  // The change isn't saved until the engine answers.
  await esc();
  expect(heading()).toBe("Settings");
  await act(async () => finish());
  expect(saveButton().disabled).toBe(true);
  await esc();
  expect(el.textContent).toBe("Project library");
});

it("only blurs a changed text field on the first Esc and moves focus to Save on the next", async () => {
  await open("/settings#advanced");
  const language = el.querySelector<HTMLInputElement>("#tr-lang")!;
  await act(async () => {
    language.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(language, "fr");
    language.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(saveButton().disabled).toBe(false);
  await esc();
  expect(document.activeElement).toBe(document.body);
  await esc();
  expect(heading()).toBe("Settings");
  expect(document.activeElement).toBe(saveButton());
});

it("leaves Esc to an open list, which closes without leaving Settings", async () => {
  await open();
  await act(async () => transcribeWith().click());
  expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  // Transcription can't be turned off: the list offers only the ways to run it.
  expect([...document.querySelectorAll('[role="option"]')].map(o => o.textContent))
    .toEqual(["CrisperWhisper 2.0 (default)", "Whisper large-v3-turbo (bundled)", "Custom local model", "OpenAI Whisper (cloud)"]);
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
  expect([...el.querySelectorAll("form label")].map(label => label.textContent)).toEqual(["Transcribe speech with"]);
  // The one choice left is saved as it is made, and nothing else goes with it.
  await selectOption(transcribeWith(), "CrisperWhisper 2.0 (default)");
  expect(save).toHaveBeenCalledExactlyOnceWith({ transcription: expect.objectContaining({ provider: "whispercpp", localModel: "crisperwhisper" }) });
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

it("tells the engine to clear Language and the note cleanup Model when their fields are emptied", async () => {
  expect(settings).toMatchObject({ transcription: { language: "en" }, noteCleanup: { enabled: true, model: "claude-haiku-4-5" } });
  const save = vi.spyOn(api, "updateSettings").mockImplementation(async () => ({
    settings: { ...settings, transcription: { provider: "openai", openaiModel: "whisper-1" }, noteCleanup: { enabled: true, provider: "anthropic" } },
  }));
  await open("/settings#advanced");
  const language = el.querySelector<HTMLInputElement>("#tr-lang")!;
  const model = el.querySelector<HTMLInputElement>("#nc-model")!;
  expect([language.value, model.value]).toEqual(["en", "claude-haiku-4-5"]);
  await typeInto(language, "");
  await typeInto(model, "");
  await act(async () => saveButton().click());
  // What goes over the wire: JSON drops an undefined field, and the engine then keeps the value it had.
  const sent = JSON.parse(JSON.stringify(save.mock.calls[0]![0]));
  expect(sent).toMatchObject({ transcription: { provider: "openai", language: null }, noteCleanup: { enabled: true, model: null } });
  expect([language.value, model.value]).toEqual(["", ""]);
  expect(saveButton().disabled).toBe(true);
});

it("holds what is typed in a number field until Save, instead of refilling one that was emptied", async () => {
  const save = vi.spyOn(api, "updateSettings").mockImplementation(async patch => ({ settings: { ...settings, ...patch } }));
  await open("/settings#advanced");
  const concurrency = el.querySelector<HTMLInputElement>("#rd-conc")!;
  const handle = el.querySelector<HTMLInputElement>("#rd-handle")!;
  expect([concurrency.value, handle.value]).toEqual(["2", "1.5"]);
  // Emptied, the field stays empty for the next digit: it used to put 1 back at once, so typing 4 made 14.
  await typeInto(concurrency, "");
  expect(concurrency.value).toBe("");
  expect(saveButton().disabled).toBe(false);
  await typeInto(concurrency, "4");
  expect(concurrency.value).toBe("4");
  // A field left empty keeps the value it had.
  await typeInto(handle, "");
  expect(handle.value).toBe("");
  await act(async () => saveButton().click());
  expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ render: expect.objectContaining({ concurrency: 4, handleSeconds: 1.5 }) }));
  expect([concurrency.value, handle.value]).toEqual(["4", "1.5"]);
});

const press = (text: string) => act(async () => {
  [...document.querySelectorAll<HTMLElement>("a, button")].find(c => c.textContent?.trim() === text)!.click();
});
const asking = () => document.querySelector("dialog[open]")?.textContent ?? "";

it("asks before a tab or the back link drops an unsaved change", async () => {
  const save = vi.spyOn(api, "updateSettings").mockImplementation(async patch => ({ settings: { ...settings, ...patch } as typeof settings }));
  await open("/settings#advanced");
  expect(previewHeight().textContent).toContain("540p");
  await selectOption(previewHeight(), "720p");
  await press("About");
  expect(asking()).toContain("These settings have unsaved changes.");
  expect(el.querySelector('[aria-current="true"]')?.textContent).toBe("Advanced");
  // Stay keeps the change where it was.
  await press("Stay");
  expect(asking()).toBe("");
  expect(previewHeight().textContent).toContain("720p");
  // Discard leaves without saving, and the old value is what comes back.
  await press("About");
  await press("Discard changes");
  expect(el.querySelector('[aria-current="true"]')?.textContent).toBe("About");
  expect(save).not.toHaveBeenCalled();
  await press("Advanced");
  expect(previewHeight().textContent).toContain("540p");
  // Save and leave saves first.
  await selectOption(previewHeight(), "720p");
  await press("← Projects");
  expect(asking()).toContain("These settings have unsaved changes.");
  await press("Save and leave");
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ render: expect.objectContaining({ previewHeight: 720 }) }));
  expect(el.textContent).toBe("Project library");
});

it("holds Restart to update while a change is unsaved, as the skill editor does", async () => {
  vi.spyOn(api, "updateSettings").mockImplementation(async patch => ({ settings: { ...settings, ...patch } as typeof settings }));
  // Restart to update asks the page first, and restarts only if nothing cancels.
  const restartAllowed = () => window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
  await open("/settings#advanced");
  expect(restartAllowed()).toBe(true);
  await typeInto(el.querySelector<HTMLInputElement>("#rd-conc")!, "4");
  expect(restartAllowed()).toBe(false);
  await act(async () => saveButton().click());
  expect(saveButton().disabled).toBe(true);
  expect(restartAllowed()).toBe(true);
});

it("saves a General dropdown as it is chosen, like the dialogue ones under it, with no Save to press", async () => {
  const save = vi.spyOn(api, "updateSettings").mockImplementation(async patch => ({ settings: { ...settings, ...patch } as typeof settings }));
  await open();
  expect(el.querySelector('button[type="submit"]')).toBeNull();
  await selectOption(transcribeWith(), "CrisperWhisper 2.0 (default)");
  expect(save).toHaveBeenCalledExactlyOnceWith({ transcription: expect.objectContaining({ provider: "whispercpp", localModel: "crisperwhisper" }) });
  expect(transcribeWith().textContent).toContain("CrisperWhisper");
  // Put back, it is saved again, and nothing is left to ask about on the way to another tab.
  await selectOption(transcribeWith(), "OpenAI Whisper (cloud)");
  expect(save).toHaveBeenLastCalledWith({ transcription: expect.objectContaining({ provider: "openai" }) });
  await press("About");
  expect(asking()).toBe("");
  expect(el.querySelector('[aria-current="true"]')?.textContent).toBe("About");
});

it("shows the bundled fallback for first-install CrisperWhisper and opens its pinned model files through the desktop", async () => {
  vi.mocked(api.settings).mockResolvedValue({ settings: freshLocalSettings, transcriptionAvailable: true });
  vi.mocked(api.localModelStatus).mockResolvedValue({ state: "ready", selected: "crisperwhisper", active: "whispercpp", fallback: true });
  const browse = vi.spyOn(desktop, "openUrl").mockResolvedValue();
  await open();
  expect(transcribeWith().textContent).toBe("CrisperWhisper 2.0 (default)");
  expect(el.querySelector('form [role="status"]')?.textContent).toContain("Using bundled Whisper");
  expect(el.textContent).toContain("Commercial use requires a separate license.");
  const guide = el.querySelector<HTMLDetailsElement>("form details")!;
  await act(async () => guide.querySelector("summary")!.click());
  expect(guide.open).toBe(true);
  expect(guide.textContent).toContain("Python 3.12");
  expect(guide.textContent).toContain("downloads the runtime libraries");
  await press("CrisperWhisper 2.0 large model files");
  expect(browse).toHaveBeenCalledWith("https://huggingface.co/nyralabs/CrisperWhisper2.0_large/tree/f4334f6e8193f2691212d49b20fa12d370e13896");
});

it("cancels the native folder picker without starting or saving an installation", async () => {
  vi.mocked(api.settings).mockResolvedValue({ settings: freshLocalSettings, transcriptionAvailable: true });
  const pick = vi.spyOn(desktop, "pickFolder").mockResolvedValue(null);
  const install = vi.spyOn(desktop, "installCrisperModel");
  const save = vi.spyOn(api, "updateSettings");
  await open();
  await act(async () => el.querySelector<HTMLElement>("form summary")!.click());
  await press("Install from folder…");
  expect(pick).toHaveBeenCalledExactlyOnceWith("Choose the CrisperWhisper model folder");
  expect(install).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(el.querySelector<HTMLButtonElement>("form details .btn-ghost")?.disabled).toBe(false);
});

it("can retry an installation error and keeps showing a pending install when General reopens", async () => {
  vi.mocked(api.settings).mockResolvedValue({ settings: freshLocalSettings, transcriptionAvailable: true });
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
  const pending = el.querySelector<HTMLButtonElement>("form details .btn-ghost")!;
  expect(pending.disabled).toBe(true);
  expect(pending.textContent).toBe("Installing CrisperWhisper…");
  await act(async () => pending.click());
  expect(pick).toHaveBeenCalledTimes(2);
  vi.mocked(api.localModelStatus).mockResolvedValue({ state: "ready", selected: "crisperwhisper", active: "crisperwhisper", fallback: false });
  await act(async () => finish());
  expect(el.querySelector('form [role="status"]')?.textContent).toBe("CrisperWhisper is ready.");
  expect(pending.disabled).toBe(false);
});

it("can turn on the local default from a previously disabled transcription provider", async () => {
  const disabled: ServerSettings = { ...defaults, transcription: { ...defaults.transcription, provider: "none" } };
  vi.mocked(api.settings).mockResolvedValue({ settings: disabled, transcriptionAvailable: false });
  const save = vi.spyOn(api, "updateSettings").mockImplementation(async patch => ({ settings: { ...disabled, ...patch } }));
  await open();
  expect(transcribeWith().textContent).toBe("Transcription unavailable");
  await selectOption(transcribeWith(), "CrisperWhisper 2.0 (default)");
  expect(save).toHaveBeenCalledExactlyOnceWith({ transcription: expect.objectContaining({ provider: "whispercpp", localModel: "crisperwhisper" }) });
});

it("uses the engine's recognized preset for older paths and explains when there is no local runtime", async () => {
  const previous = { ...defaults, transcription: { ...defaults.transcription, whisperModelPath: "/data/preset/model.safetensors" } };
  vi.mocked(api.settings).mockResolvedValue({ settings: previous, transcriptionAvailable: true });
  const reason = "CrisperWhisper is not installed and the bundled Whisper runtime is unavailable.";
  vi.mocked(api.localModelStatus).mockResolvedValue({ state: "missing", selected: "crisperwhisper", fallback: false, reason });
  await open();
  expect(transcribeWith().textContent).toBe("CrisperWhisper 2.0 (default)");
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
  await selectOption(transcribeWith(), "Whisper large-v3-turbo (bundled)");
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
  await selectOption(transcribeWith(), "CrisperWhisper 2.0 (default)");
  expect(transcribeWith().textContent).toContain("OpenAI Whisper");
  expect(el.querySelector('form [role="alert"]')?.textContent).toBe("Engine unreachable");
  // Esc still leaves: nothing here is waiting to be saved.
  await esc();
  expect(el.textContent).toBe("Project library");
});

it("counts a change that was put back as no change: Save goes dim and leaving doesn't ask", async () => {
  await open("/settings#advanced");
  const language = el.querySelector<HTMLInputElement>("#tr-lang")!;
  const concurrency = el.querySelector<HTMLInputElement>("#rd-conc")!;
  await typeInto(language, "fr");
  expect(saveButton().disabled).toBe(false);
  await typeInto(language, "en");
  expect(saveButton().disabled).toBe(true);
  // A dropdown, a switch and a number field the same.
  await selectOption(previewHeight(), "720p");
  await selectOption(previewHeight(), "540p");
  const cleanup = el.querySelector<HTMLButtonElement>('[aria-label="Enable note cleanup"]')!;
  await act(async () => cleanup.click());
  expect(saveButton().disabled).toBe(false);
  await act(async () => cleanup.click());
  await typeInto(concurrency, "4");
  expect(saveButton().disabled).toBe(false);
  await typeInto(concurrency, "2");
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
    expect(said()).toBe("Models appear when Claude Code or Codex is online. Manage sign-in");
    // The same under the reason, when the list of computers couldn't be read.
    await act(async () => useHostsStore.setState({ status: "error", error: "Engine unreachable", hosts: [] }));
    expect(el.querySelector('[role="alert"]')?.textContent).toBe("Engine unreachable");
    expect(said()).toBe("Models appear when Claude Code or Codex is online. Manage sign-in");
    // And with nobody signed in, where the link beside it is the way on.
    await act(async () => useHostsStore.setState({ status: "ready", error: null, hosts: [] }));
    expect(said()).toBe("Models appear when Claude Code or Codex is online. Manage sign-in");
    expect(el.querySelector('.settings-page section.card p a')?.getAttribute("href")).toBe("/settings#hosts");
  } finally {
    await act(async () => useHostsStore.setState(hosts, true));
  }
});
