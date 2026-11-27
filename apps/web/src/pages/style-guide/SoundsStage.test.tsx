// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BUILT_IN_STYLE_SOUNDS, type StyleGuideAsset, type StyleGuideRecord, type StyleGuideSound } from "@scarlet/shared";
import { api } from "../../lib/client";
import { desktop } from "../../lib/desktop";
import { dropTargets } from "../../lib/dropTargets";
import type { StyleSoundPlayer } from "./stageAudio";
import { SoundsStage } from "./SoundsStage";

let root: Root;
let container: HTMLDivElement;
const now = "2026-11-24T12:00:00.000Z";
const asset = (id: string, name: string): StyleGuideAsset => ({ id, name, size: 1024, mime: "audio/wav", createdAt: now });
const pop: StyleGuideSound = { id: "sfx_pop", name: "Subtle pop", source: "builtin", builtInId: "subtle-pop", volumeDb: -12, duration: 0.2, usageRule: "Lower thirds" };
const hit: StyleGuideSound = { id: "sfx_hit", name: "Big hit", source: "asset", assetId: "ast_hit", volumeDb: -14, usageRule: "" };
const orphan: StyleGuideSound = { id: "sfx_orphan", name: "Lost file", source: "asset", assetId: "ast_gone", volumeDb: -10, usageRule: "" };
const base: StyleGuideRecord = {
  id: "sg_main", name: "channel-brand", description: "", instructions: "", isDefault: false,
  assets: [asset("ast_hit", "big_hit.wav")], transitions: [], sounds: [pop, hit, orphan], createdAt: now, updatedAt: now,
};

let player: StyleSoundPlayer;
let onSave: ReturnType<typeof vi.fn<(next: StyleGuideSound[]) => Promise<void>>>;
let onGuideUpdated: ReturnType<typeof vi.fn<(next: StyleGuideRecord) => void>>;
const inDesktop = (on: boolean) => {
  if (on) (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  else delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  player = { playingId: null, progress: 0, play: vi.fn(), stop: vi.fn() };
  onSave = vi.fn(async () => {});
  onGuideUpdated = vi.fn();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  inDesktop(false);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Props = Parameters<typeof SoundsStage>[0];
const show = (props: Partial<Props> = {}) =>
  act(async () => root.render(<SoundsStage guide={base} disabled={false} player={player} onSave={onSave} onGuideUpdated={onGuideUpdated} {...props} />));
const byLabel = <T extends HTMLElement = HTMLButtonElement>(label: string) => container.querySelector<T>(`[aria-label="${label}"]`)!;
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === text);
const savedRows = () => [...container.querySelectorAll('[aria-label="Saved sound effects"] > li')];
const starter = (name: string) => [...container.querySelectorAll<HTMLElement>('[aria-label="Built-in starter sound effects"] > li')]
  .find(li => li.querySelector(".sg-item-name")?.textContent === name)!;
const alert = () => container.querySelector('[role="alert"]')?.textContent;
const zone = () => container.querySelector<HTMLElement>("[data-file-drop]")!;
async function setValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input.type === "range" ? "change" : "input", { bubbles: true }));
    if (input.type === "range") input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function choose(files: File[]) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  await act(async () => {
    Object.defineProperty(input, "files", { value: files, configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const uploaded = (name: string, id: string, duration?: number) => {
  const a = asset(id, name);
  return { asset: a, styleGuide: { ...base, assets: [...base.assets, a] }, ...(duration !== undefined && { duration }) };
};

it("asks for a first sound when the style has none, and offers every starter to add", async () => {
  await show({ guide: { ...base, sounds: [] } });
  expect(container.textContent).toContain("No sound effects saved in this style yet.");
  expect(container.querySelector('[aria-label="Saved sound effects"]')).toBeNull();
  const starters = [...container.querySelectorAll('[aria-label="Built-in starter sound effects"] > li')];
  expect(starters).toHaveLength(BUILT_IN_STYLE_SOUNDS.length);
  expect(starters.every(li => li.querySelector("button:not(.sg-play-circle)")?.textContent === "Add")).toBe(true);
  expect(starter("Soft whoosh").textContent).toContain("0.45s");
  expect(starter("Soft whoosh").textContent).toContain("Paired with push or slide transitions");
});

it("keeps Upload and Add off with no style to save into", async () => {
  await show({ guide: null });
  expect(button("Upload audio")!.disabled).toBe(true);
  expect(starter("Soft whoosh").querySelector("button:not(.sg-play-circle)")!.hasAttribute("disabled")).toBe(true);
  // Previews still play.
  await act(async () => byLabel("Preview Soft whoosh").click());
  expect(player.play).toHaveBeenCalledWith("builtin:soft-whoosh", -14);
});

it("lists each saved sound with where it came from, its length and its level", async () => {
  await show();
  expect(savedRows().map(li => li.querySelector(".sg-item-name")?.textContent)).toEqual(["Subtle pop", "Big hit", "Lost file"]);
  expect(savedRows().map(li => li.querySelector(".sg-meta-chip")?.textContent)).toEqual(["Built-in", "big_hit.wav", "Custom audio"]);
  expect(savedRows()[0]!.textContent).toContain("0.20 s");
  expect(savedRows()[1]!.textContent).not.toMatch(/\d s/);
  expect(byLabel<HTMLInputElement>("Subtle pop level in dB").value).toBe("-12");
  expect(savedRows()[0]!.textContent).toContain("-12 dB");
  expect(byLabel<HTMLInputElement>("Subtle pop usage rule").value).toBe("Lower thirds");
  // A starter already in the style says Added instead of offering Add.
  expect(starter("Subtle pop").querySelector(".sg-added-badge")?.textContent).toBe("Added");
  expect(starter("Soft whoosh").querySelector(".sg-added-badge")).toBeNull();
});

it("previews a sound at its level, lights its waveform as it plays, and stops it on a second press", async () => {
  await show();
  await act(async () => byLabel("Play Big hit").click());
  expect(player.play).toHaveBeenCalledWith("sfx_hit", -14);
  player = { ...player, playingId: "sfx_hit", progress: 0.5 };
  await show();
  const row = savedRows()[1]!;
  expect(row.classList.contains("is-active")).toBe(true);
  const bars = row.querySelectorAll(".sg-waveform-bar");
  expect(row.querySelectorAll(".sg-waveform-bar.is-lit")).toHaveLength(Math.ceil(bars.length / 2));
  await act(async () => byLabel("Stop Big hit").click());
  expect(player.stop).toHaveBeenCalledTimes(1);
  // At the very start at least one bar is lit.
  player = { ...player, playingId: "builtin:crisp-tick", progress: 0 };
  await show();
  expect(starter("Crisp tick").querySelectorAll(".sg-waveform-bar.is-lit")).toHaveLength(1);
  await act(async () => byLabel("Stop Crisp tick").click());
  expect(player.stop).toHaveBeenCalledTimes(2);
});

it("adds a starter to the style once, with its own name, level, length and rule", async () => {
  await show();
  await act(async () => starter("Soft whoosh").querySelector<HTMLButtonElement>("button:not(.sg-play-circle)")!.click());
  const next = onSave.mock.calls[0]![0];
  expect(next.slice(0, 3)).toEqual([pop, hit, orphan]);
  expect(next[3]).toEqual({
    id: expect.stringMatching(/^sfx/), name: "Soft whoosh", source: "builtin", builtInId: "soft-whoosh", volumeDb: -14, duration: 0.45,
    usageRule: "Paired with push or slide transitions",
  });
});

it("shows why adding a starter failed", async () => {
  onSave.mockRejectedValueOnce(new Error("Style guide is read-only"));
  await show();
  await act(async () => starter("Soft whoosh").querySelector<HTMLButtonElement>("button:not(.sg-play-circle)")!.click());
  expect(alert()).toBe("Style guide is read-only");
});

it("saves a level when the slider is let go, but not when it ends where it was", async () => {
  await show();
  const level = byLabel<HTMLInputElement>("Big hit level in dB");
  await act(async () => { level.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); });
  expect(onSave).not.toHaveBeenCalled();
  await setValue(level, "-20");
  expect(savedRows()[1]!.textContent).toContain("-20 dB");
  await act(async () => { level.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); });
  expect(onSave).toHaveBeenLastCalledWith([pop, { ...hit, volumeDb: -20 }, orphan]);
  await act(async () => { level.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "ArrowLeft" })); });
  await act(async () => { level.dispatchEvent(new TouchEvent("touchend", { bubbles: true })); });
  expect(onSave).toHaveBeenCalledTimes(3);
  // Back where it was saved: nothing to save.
  await setValue(level, "-14");
  await act(async () => { level.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "ArrowRight" })); });
  await act(async () => { level.dispatchEvent(new TouchEvent("touchend", { bubbles: true })); });
  expect(onSave).toHaveBeenCalledTimes(3);
});

it("previews a sound at the level being set", async () => {
  await show();
  await setValue(byLabel<HTMLInputElement>("Subtle pop level in dB"), "-3");
  await act(async () => byLabel("Play Subtle pop").click());
  expect(player.play).toHaveBeenCalledWith("sfx_pop", -3);
});

it("saves a usage rule trimmed when the field is left or Enter is pressed, and only when it changed", async () => {
  await show();
  const rule = byLabel<HTMLInputElement>("Big hit usage rule");
  await act(async () => { rule.focus(); rule.blur(); });
  expect(onSave).not.toHaveBeenCalled();
  await setValue(rule, "  Plays on chapter titles  ");
  await act(async () => rule.focus());
  await act(async () => { rule.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" })); });
  expect(document.activeElement).toBe(rule);
  await act(async () => { rule.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })); });
  expect(document.activeElement).not.toBe(rule);
  expect(onSave).toHaveBeenLastCalledWith([pop, { ...hit, usageRule: "Plays on chapter titles" }, orphan]);
});

it("shows why saving a change failed", async () => {
  onSave.mockRejectedValueOnce(new Error("Disk full"));
  await show();
  const rule = byLabel<HTMLInputElement>("Big hit usage rule");
  await setValue(rule, "New rule");
  await act(async () => { rule.focus(); rule.blur(); });
  expect(alert()).toBe("Disk full");
});

it("saves no change while the stage is turned off", async () => {
  await show({ disabled: true });
  expect(button("Upload audio")!.disabled).toBe(true);
  expect(byLabel("Remove Big hit").disabled).toBe(true);
  expect(byLabel<HTMLInputElement>("Big hit usage rule").disabled).toBe(true);
  // A drop from the desktop app still reaches it, and is turned away.
  const upload = vi.spyOn(api, "uploadStyleGuideAsset");
  await act(async () => dropTargets.get(zone())!.drop(["/Users/me/hit.wav"]));
  expect(upload).not.toHaveBeenCalled();
});

it("removes a starter by saving the style without it, stopping it if it's playing", async () => {
  player = { ...player, playingId: "sfx_pop" };
  await show();
  await act(async () => byLabel("Remove Subtle pop").click());
  expect(player.stop).toHaveBeenCalledTimes(1);
  expect(onSave).toHaveBeenCalledWith([hit, orphan]);
});

it("removes an uploaded sound by deleting its file, and says why when it can't", async () => {
  const del = vi.spyOn(api, "deleteStyleGuideAsset").mockResolvedValueOnce({ styleGuide: { ...base, assets: [], sounds: [pop, orphan] } });
  await show();
  await act(async () => byLabel("Remove Big hit").click());
  expect(del).toHaveBeenCalledWith("sg_main", "ast_hit");
  expect(player.stop).not.toHaveBeenCalled();
  expect(onGuideUpdated).toHaveBeenCalledWith({ ...base, assets: [], sounds: [pop, orphan] });
  expect(onSave).not.toHaveBeenCalled();
  del.mockRejectedValueOnce(new Error("File is in use"));
  await act(async () => byLabel("Remove Big hit").click());
  expect(alert()).toBe("File is in use");
});

it("uploads chosen audio files one after another and saves them as sounds", async () => {
  const upload = vi.spyOn(api, "uploadStyleGuideAsset")
    .mockResolvedValueOnce(uploaded("door_slam.wav", "ast_door", 1.25))
    .mockResolvedValueOnce(uploaded("voice-take.m4a", "ast_voice"));
  await show();
  const door = new File(["wav"], "door_slam.wav", { type: "audio/wav" });
  // A file that says it's audio counts even without a sound file's extension.
  const voice = new File(["m4a"], "voice-take", { type: "audio/mp4" });
  await choose([door, voice]);
  expect(upload.mock.calls).toEqual([["sg_main", door, "door_slam.wav"], ["sg_main", voice, "voice-take"]]);
  expect(onGuideUpdated).toHaveBeenCalledTimes(2);
  const next = onSave.mock.calls[0]![0];
  expect(next.slice(0, 3)).toEqual([pop, hit, orphan]);
  expect(next.slice(3)).toEqual([
    { id: expect.stringMatching(/^sfx/), name: "door slam", source: "asset", assetId: "ast_door", volumeDb: -14, duration: 1.25, usageRule: "" },
    { id: expect.stringMatching(/^sfx/), name: "voice take", source: "asset", assetId: "ast_voice", volumeDb: -14, usageRule: "" },
  ]);
  expect(alert()).toBeUndefined();
});

it("asks for a sound file when what was chosen isn't audio", async () => {
  const upload = vi.spyOn(api, "uploadStyleGuideAsset");
  await show();
  await choose([new File(["png"], "logo.png", { type: "image/png" })]);
  expect(alert()).toBe("Drop or choose a .wav, .mp3, .m4a, .aac, .ogg, or .flac sound file.");
  expect(upload).not.toHaveBeenCalled();
  // Choosing nothing changes nothing.
  await choose([]);
  expect(upload).not.toHaveBeenCalled();
});

it("hands files that aren't audio to the style, and uploads the audio among them", async () => {
  const onDropStyleFiles = vi.fn();
  const upload = vi.spyOn(api, "uploadStyleGuideAsset").mockResolvedValue(uploaded("hit.mp3", "ast_mp3"));
  await show({ onDropStyleFiles });
  const logo = new File(["png"], "logo.png", { type: "image/png" });
  await choose([logo]);
  expect(onDropStyleFiles).toHaveBeenCalledWith([logo]);
  expect(upload).not.toHaveBeenCalled();
  expect(alert()).toBeUndefined();
  const mp3 = new File(["mp3"], "hit.mp3");
  await choose([logo, mp3]);
  expect(onDropStyleFiles).toHaveBeenLastCalledWith([logo]);
  expect(upload).toHaveBeenCalledWith("sg_main", mp3, "hit.mp3");
});

it("shows why an upload failed, and keeps the stage still while one is out", async () => {
  let fail!: (e: unknown) => void;
  const upload = vi.spyOn(api, "uploadStyleGuideAsset").mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  await show();
  await choose([new File(["wav"], "a.wav")]);
  expect(button("Upload audio")!.disabled).toBe(true);
  expect(byLabel("Remove Big hit").disabled).toBe(true);
  // A second drop while busy is ignored.
  await act(async () => dropTargets.get(zone())!.drop(["/Users/me/b.wav"]));
  expect(upload).toHaveBeenCalledTimes(1);
  await act(async () => fail(new Error("Upload too large")));
  expect(alert()).toBe("Upload too large");
  expect(button("Upload audio")!.disabled).toBe(false);
});

it("uploads sound files dropped from the desktop by their paths", async () => {
  const upload = vi.spyOn(api, "uploadStyleGuideAsset").mockResolvedValue(uploaded("whoosh.ogg", "ast_ogg"));
  await show();
  await act(async () => dropTargets.get(zone())!.drop(["C:\\Sounds\\whoosh.ogg", "/Users/me/notes.txt"]));
  expect(upload).toHaveBeenCalledTimes(1);
  expect(upload).toHaveBeenCalledWith("sg_main", { path: "C:\\Sounds\\whoosh.ogg" }, "whoosh.ogg");
  // A folder isn't a sound file.
  await act(async () => dropTargets.get(zone())!.drop(["/Users/me/odd.flac/"]));
  expect(upload).toHaveBeenCalledTimes(1);
  expect(alert()).toBe("Drop or choose a .wav, .mp3, .m4a, .aac, .ogg, or .flac sound file.");
});

it("highlights the stage while files are dragged over it in the browser, and uploads what's dropped", async () => {
  const upload = vi.spyOn(api, "uploadStyleGuideAsset").mockResolvedValue(uploaded("drop.wav", "ast_drop"));
  await show();
  const file = new File(["wav"], "drop.wav", { type: "audio/wav" });
  const drag = (type: string) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [file] } });
    zone().dispatchEvent(event);
  };
  await act(async () => drag("dragover"));
  expect(zone().classList.contains("is-dropping")).toBe(true);
  expect(container.querySelector(".sg-drop-overlay")?.textContent).toBe("Drop audio files (.wav, .mp3, .m4a) to add to this style");
  await act(async () => drag("drop"));
  expect(zone().classList.contains("is-dropping")).toBe(false);
  expect(upload).toHaveBeenCalledWith("sg_main", file, "drop.wav");
});

it("picks a sound with the desktop app's file dialog", async () => {
  inDesktop(true);
  const pick = vi.spyOn(desktop, "pickFile").mockResolvedValueOnce("/Users/me/Sounds/riser.aac").mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("dialog closed"));
  const upload = vi.spyOn(api, "uploadStyleGuideAsset").mockResolvedValue(uploaded("riser.aac", "ast_riser"));
  const browse = vi.spyOn(HTMLInputElement.prototype, "click");
  await show();
  await act(async () => button("Upload audio")!.click());
  expect(pick).toHaveBeenCalledWith("Attach a sound effect (.wav, .mp3, .m4a)");
  expect(upload).toHaveBeenCalledWith("sg_main", { path: "/Users/me/Sounds/riser.aac" }, "riser.aac");
  // Cancelled, or the dialog failed: nothing is uploaded.
  await act(async () => button("Upload audio")!.click());
  await act(async () => button("Upload audio")!.click());
  expect(upload).toHaveBeenCalledTimes(1);
  expect(browse).not.toHaveBeenCalled();
});

it("opens the browser's file chooser outside the desktop app", async () => {
  const pick = vi.spyOn(desktop, "pickFile");
  const browse = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
  await show();
  await act(async () => button("Upload audio")!.click());
  expect(browse).toHaveBeenCalledTimes(1);
  expect(pick).not.toHaveBeenCalled();
});
