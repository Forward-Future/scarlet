// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BUILT_IN_STYLE_SOUNDS, type StyleGuideRecord, type StyleGuideTransition } from "@scarlet/shared";
import { openOptions, selectOption } from "../../../test/selectOption";
import type { StyleSoundPlayer } from "./stageAudio";
import { TransitionsStage } from "./TransitionsStage";

let root: Root;
let container: HTMLDivElement;
const now = "2026-11-24T12:00:00.000Z";
const push: StyleGuideTransition = { id: "tr_push", name: "Section push", type: "push", duration: 0.4, direction: "left", soundId: "sfx_swoosh", usageRule: "Between chapters", isDefault: true };
const fade: StyleGuideTransition = { id: "tr_fade", name: "Soft fade", type: "dissolve", duration: 0.5, direction: "left", usageRule: "", isDefault: false };
const whip: StyleGuideTransition = { id: "tr_whip", name: "Whip", type: "whip", duration: 0.3, direction: "up", soundId: "builtin:airy-slide", usageRule: "", isDefault: false };
const odd: StyleGuideTransition = { id: "tr_odd", name: "Dip", type: "dip", duration: 1, direction: "left", soundId: "mystery-sound", usageRule: "", isDefault: false };
const base: StyleGuideRecord = {
  id: "sg_main", name: "channel-brand", description: "", instructions: "", isDefault: false, assets: [],
  transitions: [push, fade, whip, odd],
  sounds: [{ id: "sfx_swoosh", name: "Brand swoosh", source: "builtin", builtInId: "soft-whoosh", volumeDb: -10, usageRule: "On pushes" },
    { id: "sfx_ding", name: "Ding", source: "asset", assetId: "ast_ding", volumeDb: -12, usageRule: "" }],
  createdAt: now, updatedAt: now,
};

let player: StyleSoundPlayer;
let onSave: ReturnType<typeof vi.fn<(next: StyleGuideTransition[]) => Promise<void>>>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  player = { playingId: null, progress: 0, play: vi.fn(), stop: vi.fn() };
  onSave = vi.fn(async () => {});
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Props = Parameters<typeof TransitionsStage>[0];
const show = (props: Partial<Props> = {}) =>
  act(async () => root.render(<TransitionsStage guide={base} disabled={false} player={player} onSave={onSave} {...props} />));
const byLabel = <T extends HTMLElement = HTMLButtonElement>(label: string) => container.querySelector<T>(`[aria-label="${label}"]`)!;
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === text);
const meta = () => container.querySelector(".sg-stage-meta")!.textContent;
const stage = () => container.querySelector<HTMLButtonElement>(".sg-ab-stage")!;
const clipA = () => container.querySelector<HTMLElement>(".sg-ab-clip.is-a")!.style;
const clipB = () => container.querySelector<HTMLElement>(".sg-ab-clip.is-b")!.style;
const progress = () => container.querySelector<HTMLElement>(".sg-ab-progress-fill")!.style.width;
const rows = () => [...container.querySelectorAll<HTMLElement>('[aria-label="Style guide transitions"] > li')];
const row = (name: string) => rows().find(li => li.querySelector(".sg-item-name")?.textContent === name)!;
const editor = () => container.querySelector<HTMLElement>('[role="region"][aria-label="Edit transition"]');
const combo = (label: string) => byLabel(label);
const advance = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });
async function typeInto(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const nameField = () => editor()!.querySelector<HTMLInputElement>('input[placeholder="Section push"]')!;
const ruleField = () => editor()!.querySelector<HTMLInputElement>('input[placeholder="Default between sections"]')!;

it("previews a sample push with its sound before any transition is saved, and offers starters", async () => {
  await show({ guide: { ...base, transitions: [] } });
  expect(meta()).toBe("Soft push·Push left·0.40 s· Soft whooshSample preview");
  expect(byLabel("Replay Soft push transition")).toBe(stage());
  expect(container.textContent).toContain("No transitions saved yet.");
  expect(container.querySelector('[aria-label="Style guide transitions"]')).toBeNull();
  expect(["+ Push left · Soft whoosh", "+ Cross dissolve · 0.5s", "+ Whip pan · Airy slide"].map(t => button(t)?.disabled)).toEqual([false, false, false]);
});

it("keeps Add and the starters off with no style to save into", async () => {
  await show({ guide: null });
  expect(button("Add transition")!.disabled).toBe(true);
  expect(button("+ Cross dissolve · 0.5s")!.disabled).toBe(true);
  expect(meta()).toContain("Sample preview");
});

it("lists saved transitions with their default, type, length, sound and rule, the default chosen", async () => {
  await show();
  expect(rows().map(li => li.querySelector(".sg-item-name")?.textContent)).toEqual(["Section push", "Soft fade", "Whip", "Dip"]);
  expect(row("Section push").classList.contains("is-active")).toBe(true);
  expect(row("Section push").querySelector(".style-guide-default-badge")?.textContent).toBe("Default");
  expect([...row("Section push").querySelectorAll(".sg-meta-chip")].map(c => c.textContent?.trim())).toEqual(["Push left · 0.40s", "Brand swoosh"]);
  expect(row("Section push").querySelector(".sg-item-rule")?.textContent).toBe("Between chapters");
  // A dissolve has no direction, and no sound means no sound chip.
  expect([...row("Soft fade").querySelectorAll(".sg-meta-chip")].map(c => c.textContent?.trim())).toEqual(["Dissolve · 0.50s"]);
  expect(row("Soft fade").querySelector(".sg-item-rule")).toBeNull();
  // A starter is named by its name; a sound nobody knows by its id.
  expect([...row("Whip").querySelectorAll(".sg-meta-chip")].map(c => c.textContent?.trim())).toEqual(["Whip up · 0.30s", "Airy slide"]);
  expect([...row("Dip").querySelectorAll(".sg-meta-chip")].map(c => c.textContent?.trim())).toEqual(["Dip · 1.00s", "mystery-sound"]);
  // Only the others offer Make default.
  expect(row("Section push").textContent).not.toContain("Make default");
  expect(row("Soft fade").textContent).toContain("Make default");
  expect(meta()).toBe("Section push·Push left·0.40 s· Brand swoosh");
});

it("opens on the first transition when none is the default", async () => {
  await show({ guide: { ...base, transitions: [fade, whip] } });
  expect(row("Soft fade").classList.contains("is-active")).toBe(true);
  expect(meta()).toBe("Soft fade·Dissolve·0.50 s");
});

it("plays a transition's A → B with its sound when it's pressed, then settles back", async () => {
  await show();
  expect(progress()).toBe("42%");
  expect(stage().textContent).toContain("Replay");
  await act(async () => row("Whip").querySelector<HTMLButtonElement>(".sg-item-main")!.click());
  expect(player.play).toHaveBeenCalledWith("builtin:airy-slide");
  expect(row("Whip").classList.contains("is-active")).toBe(true);
  expect(meta()).toBe("Whip·Whip up·0.30 s· Airy slide");
  expect(stage().textContent).toContain("Playing…");
  expect(progress()).toBe("0%");
  await advance(150);
  expect(parseInt(progress())).toBeGreaterThan(30);
  expect(parseInt(progress())).toBeLessThan(70);
  // Moving up with motion blur halfway through.
  expect(clipA().transform).toMatch(/^translateY\(-\d+\.\d\d%\)$/);
  expect(clipB().filter).toMatch(/^blur\(\d+\.\dpx\)$/);
  await advance(200);
  expect(progress()).toBe("100%");
  expect(clipA().transform).toBe("translateY(-100.00%)");
  expect(clipB().transform).toBe("translateY(0.00%)");
  expect(clipB().filter).toBe("");
  expect(stage().textContent).toContain("Playing…");
  await advance(700);
  expect(stage().textContent).toContain("Replay");
  expect(progress()).toBe("42%");
});

it("replays the shown transition from the stage, without a sound when it has none", async () => {
  await show({ guide: { ...base, transitions: [fade] } });
  await act(async () => stage().click());
  expect(player.play).not.toHaveBeenCalled();
  expect(stage().textContent).toContain("Playing…");
  // A replay mid-way starts over.
  await advance(100);
  await act(async () => stage().click());
  expect(progress()).toBe("0%");
  await advance(600);
  expect(progress()).toBe("100%");
});

it("jumps straight to the end of a replay with motion reduced", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }));
  await show();
  await act(async () => stage().click());
  expect(player.play).toHaveBeenCalledWith("sfx_swoosh");
  expect(progress()).toBe("100%");
  expect(stage().textContent).toContain("Replay");
  // A push has fully moved off.
  expect(clipA().transform).toBe("translateX(-100.00%)");
});

it("draws each kind of transition at the resting frame", async () => {
  // A push left moves A off to the left as B comes in from the right.
  await show();
  expect(clipA().transform).toBe("translateX(-38.10%)");
  expect(clipB().transform).toBe("translateX(61.90%)");
  expect(clipA().filter).toBe("");
  // A dissolve fades B in over A.
  await show({ guide: { ...base, transitions: [fade] } });
  expect(clipA().opacity).toBe("1");
  expect(Number(clipB().opacity)).toBeCloseTo(0.381, 3);
  expect(clipA().transform).toBe("");
  // A slide down leaves A where it is and brings B down over it.
  await show({ guide: { ...base, transitions: [{ ...fade, id: "tr_slide", type: "slide", direction: "down" }] } });
  expect(clipA().transform).toBe("");
  expect(clipB().transform).toBe("translateY(-61.90%)");
  // A push right goes the other way.
  await show({ guide: { ...base, transitions: [{ ...push, direction: "right" }] } });
  expect(clipA().transform).toBe("translateX(38.10%)");
  // A whip blurs as it moves.
  await show({ guide: { ...base, transitions: [{ ...whip, direction: "left" }] } });
  expect(clipA().transform).toBe("translateX(-35.25%)");
  expect(clipA().filter).toBe("blur(9.5px)");
  expect(clipB().filter).toBe("blur(9.5px)");
});

it("dips through its colour, fading out A and then bringing in B", async () => {
  await show({ guide: { ...base, transitions: [{ ...odd, color: "#ffffff" }] } });
  // First half: the colour rises over A.
  const dip = () => container.querySelector<HTMLElement>(".sg-ab-dip");
  expect(Number(dip()!.style.opacity)).toBeCloseTo(0.931, 3);
  expect(clipA().opacity).toBe("1");
  expect(clipB().opacity).toBe("0");
  // Second half: B shows through the colour as it falls.
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }));
  await act(async () => stage().click());
  expect(Number(dip()!.style.opacity)).toBe(0);
  expect(clipA().opacity).toBe("0");
  expect(clipB().opacity).toBe("1");
  // A dissolve has no colour over it.
  await show({ guide: { ...base, transitions: [fade] } });
  expect(dip()).toBeNull();
});

it("makes another transition the default", async () => {
  await show();
  await act(async () => row("Soft fade").querySelector<HTMLButtonElement>(".sg-item-actions button")!.click());
  expect(onSave).toHaveBeenCalledWith([{ ...push, isDefault: false }, { ...fade, isDefault: true }, whip, odd]);
});

it("removes a transition, closing its editor if it was open", async () => {
  await show();
  await act(async () => byLabel("Edit Whip").click());
  expect(editor()).not.toBeNull();
  await act(async () => byLabel("Remove Whip").click());
  expect(onSave).toHaveBeenCalledWith([push, fade, odd]);
  expect(editor()).toBeNull();
  // Removing another leaves an open editor open.
  await act(async () => byLabel("Edit Soft fade").click());
  await act(async () => byLabel("Remove Dip").click());
  expect(onSave).toHaveBeenLastCalledWith([push, fade, whip]);
  expect(editor()).not.toBeNull();
});

it("keeps the actions still while a save is out", async () => {
  let finish!: () => void;
  onSave.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await show();
  await act(async () => byLabel("Remove Dip").click());
  expect(byLabel("Edit Whip").disabled).toBe(true);
  expect(button("Add transition")!.disabled).toBe(true);
  await act(async () => finish());
  expect(byLabel("Edit Whip").disabled).toBe(false);
});

it("edits a transition's name, type, length, direction, sound and rule, previewing each change", async () => {
  await show();
  await act(async () => byLabel("Edit Section push").click());
  expect(nameField().value).toBe("Section push");
  expect(combo("Transition type").textContent).toBe("Push");
  expect(combo("Transition duration").textContent).toBe("0.40 s");
  expect(combo("Transition direction").textContent).toBe("Left");
  expect(combo("Paired sound effect").textContent).toBe("Brand swoosh");
  expect(ruleField().value).toBe("Between chapters");

  await typeInto(nameField(), "  Chapter push  ");
  await selectOption(combo("Transition duration"), "0.60 s");
  expect(player.play).toHaveBeenLastCalledWith("sfx_swoosh");
  expect(meta()).toContain("0.60 s");
  await selectOption(combo("Transition direction"), "Down");
  expect(meta()).toContain("Push down");
  await selectOption(combo("Transition type"), /^Slide/);
  expect(meta()).toContain("Slide down");
  // Sounds saved in the style come first, then the starters it hasn't saved.
  const options = await openOptions(combo("Paired sound effect"));
  expect(options.map(o => o.textContent)).toEqual([
    "No paired sound",
    "Brand swoosh-10 dB · On pushes",
    "Ding-12 dB",
    ...BUILT_IN_STYLE_SOUNDS.filter(s => s.id !== "soft-whoosh").map(s => `${s.name}${s.duration.toFixed(2)} s · ${s.defaultVolumeDb} dB`),
  ]);
  expect(document.querySelectorAll(".preference-group")).toHaveLength(2);
  await act(async () => options.find(o => o.textContent?.startsWith("Ding"))!.click());
  expect(player.play).toHaveBeenLastCalledWith("sfx_ding");
  await typeInto(ruleField(), " Between big chapters ");
  await act(async () => button("Save transition")!.click());
  expect(onSave).toHaveBeenCalledWith([
    { ...push, name: "Chapter push", type: "slide", duration: 0.6, direction: "down", soundId: "sfx_ding", usageRule: "Between big chapters", isDefault: true },
    { ...fade, isDefault: false }, { ...whip, isDefault: false }, { ...odd, isDefault: false },
  ]);
  expect(editor()).toBeNull();
});

it("drops the direction for a dip, gives it black, and can pair no sound", async () => {
  await show();
  await act(async () => byLabel("Edit Whip").click());
  await selectOption(combo("Transition type"), /^Dip/);
  expect(combo("Transition direction")).toBeNull();
  await selectOption(combo("Paired sound effect"), "No paired sound");
  const callsBefore = vi.mocked(player.play).mock.calls.length;
  await act(async () => stage().click());
  expect(vi.mocked(player.play).mock.calls.length).toBe(callsBefore);
  await act(async () => button("Save transition")!.click());
  expect(onSave.mock.calls[0]![0][2]).toEqual({ ...whip, type: "dip", color: "#000000", soundId: undefined });
  // Not the default, so the others keep theirs.
  expect(onSave.mock.calls[0]![0][0]).toEqual(push);
});

it("keeps a dip's own colour when its type is chosen again", async () => {
  await show({ guide: { ...base, transitions: [{ ...odd, color: "#ff0000" }] } });
  await act(async () => byLabel("Edit Dip").click());
  await selectOption(combo("Transition type"), /^Dip/);
  await act(async () => button("Save transition")!.click());
  expect(onSave.mock.calls[0]![0][0]!.color).toBe("#ff0000");
});

it("won't save a transition without a name, and Cancel leaves it as it was", async () => {
  await show();
  await act(async () => byLabel("Edit Soft fade").click());
  await typeInto(nameField(), "   ");
  expect(button("Save transition")!.disabled).toBe(true);
  await act(async () => button("Cancel")!.click());
  expect(editor()).toBeNull();
  expect(onSave).not.toHaveBeenCalled();
  expect(row("Soft fade")).toBeDefined();
});

it("adds a new transition after the saved ones, not as the default", async () => {
  await show();
  await act(async () => button("Add transition")!.click());
  expect(nameField().value).toBe("Section push");
  expect(ruleField().value).toBe("");
  expect(stage().textContent).toContain("Playing…");
  await typeInto(nameField(), "Quick cut");
  await act(async () => button("Save transition")!.click());
  const next = onSave.mock.calls[0]![0];
  expect(next.slice(0, 4)).toEqual([push, fade, whip, odd]);
  expect(next[4]).toEqual({ id: expect.stringMatching(/^tr/), name: "Quick cut", type: "push", duration: 0.4, direction: "left", usageRule: "", isDefault: false });
});

it("starts a first transition from a starter as the default between sections", async () => {
  await show({ guide: { ...base, transitions: [] } });
  await act(async () => button("+ Push left · Soft whoosh")!.click());
  expect(player.play).toHaveBeenCalledWith("builtin:soft-whoosh");
  // The list's empty card gives way to the editor.
  expect(container.textContent).not.toContain("No transitions saved yet.");
  await act(async () => button("Save transition")!.click());
  expect(onSave.mock.calls[0]![0]).toEqual([{
    id: expect.stringMatching(/^tr/), name: "Section push", type: "push", duration: 0.4, direction: "left", soundId: "builtin:soft-whoosh",
    usageRule: "Default between sections", isDefault: true,
  }]);
});

it("starts from the dissolve and whip starters with their own settings", async () => {
  await show({ guide: { ...base, transitions: [] } });
  await act(async () => button("+ Cross dissolve · 0.5s")!.click());
  expect(nameField().value).toBe("Cross dissolve");
  expect(combo("Transition direction")).toBeNull();
  await act(async () => button("Cancel")!.click());
  await act(async () => button("+ Whip pan · Airy slide")!.click());
  expect(nameField().value).toBe("Whip pan");
  expect(ruleField().value).toBe("Fast jump to screen demo");
  await act(async () => button("Save transition")!.click());
  // A first transition is the default unless the starter says otherwise.
  expect(onSave.mock.calls[0]![0][0]).toMatchObject({ name: "Whip pan", type: "whip", duration: 0.3, soundId: "builtin:airy-slide", isDefault: true });
});

it("moves to the default transition when the one shown is removed elsewhere, and to the sample when none are left", async () => {
  await show();
  await act(async () => row("Whip").querySelector<HTMLButtonElement>(".sg-item-main")!.click());
  await show({ guide: { ...base, transitions: [push, fade] } });
  expect(row("Section push").classList.contains("is-active")).toBe(true);
  await show({ guide: { ...base, transitions: [fade] } });
  expect(row("Soft fade").classList.contains("is-active")).toBe(true);
  await show({ guide: { ...base, transitions: [] } });
  expect(meta()).toContain("Sample preview");
});

it("stops a running preview when it goes away", async () => {
  await show();
  await act(async () => stage().click());
  await act(async () => root.unmount());
  // Nothing left to run.
  expect(vi.getTimerCount()).toBe(0);
  root = createRoot(container);
});
