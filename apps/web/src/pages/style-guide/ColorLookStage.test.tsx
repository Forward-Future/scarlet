// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StyleGuideColorAdjustments, type StyleGuideColorLook, type StyleGuideRecord } from "@scarlet/shared";
import { ColorLookStage } from "./ColorLookStage";

let root: Root;
let container: HTMLDivElement;
const now = "2026-11-24T12:00:00.000Z";
const base: StyleGuideRecord = {
  id: "sg_main", name: "channel-brand", description: "", instructions: "", isDefault: false, assets: [], transitions: [], sounds: [],
  createdAt: now, updatedAt: now,
};
const look = (adjustments: Partial<StyleGuideColorAdjustments> = {}, rest: Partial<StyleGuideColorLook> = {}): StyleGuideRecord =>
  ({ ...base, colorLook: { name: "Warm studio", notes: "", adjustments: StyleGuideColorAdjustments.parse(adjustments), ...rest } });

/** The reference frame's pixels as the canvas hands them back: mid gray, near black, near white, and a skin tone. */
const SOURCE = [128, 128, 128, 255, 20, 20, 20, 255, 240, 240, 240, 255, 200, 150, 120, 255];
/** What each canvas was drawn with. The page has no real canvas, so a 2D context stands in for the GPU's. */
let drawn: { fills: number; read: number; graded: number[][] };
let contextFails: boolean;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  drawn = { fills: 0, read: 0, graded: [] };
  contextFails = false;
  const gradient = { addColorStop: () => {} };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => {
    if (contextFails) throw new Error("No 2D canvas here");
    return {
      fillStyle: "",
      createLinearGradient: () => gradient,
      createRadialGradient: () => gradient,
      fillRect: () => { drawn.fills++; },
      save: () => {}, restore: () => {}, beginPath: () => {}, ellipse: () => {}, fill: () => {},
      getImageData: () => { drawn.read++; return new ImageData(new Uint8ClampedArray(SOURCE), 2, 2); },
      putImageData: (image: ImageData) => { drawn.graded.push([...image.data]); },
    };
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const show = (guide: StyleGuideRecord | null, onSuggestPrompt: (prompt: string) => void = () => {}) =>
  act(async () => root.render(<ColorLookStage guide={guide} onSuggestPrompt={onSuggestPrompt} />));
/** The graded frame's pixels as [r, g, b] for each of SOURCE's four. */
const graded = () => {
  const data = drawn.graded.at(-1)!;
  return [0, 1, 2, 3].map(i => data.slice(i * 4, i * 4 + 3));
};
const [GRAY, DARK, BRIGHT, SKIN] = [0, 1, 2, 3];
const readouts = () => [...container.querySelectorAll('[aria-label="Saved color look parameters"] .sg-color-stat')].map(s => `${s.querySelector("dt")!.textContent} ${s.querySelector("dd")!.textContent}`);
const slider = () => container.querySelector<HTMLElement>('[role="slider"]')!;
const stage = () => container.querySelector<HTMLElement>(".sg-color-stage")!;
const afterClip = () => container.querySelector<HTMLElement>(".sg-color-after-clip")!.style.clipPath;
const key = (k: string) => act(async () => { slider().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
const pointer = (type: string, target: EventTarget, clientX: number) =>
  act(async () => { target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX })); });

it("offers prompts to describe a look before one is saved", async () => {
  const onSuggestPrompt = vi.fn();
  await show(base, onSuggestPrompt);
  expect(container.textContent).toContain("Camera color look");
  expect(container.querySelector("canvas")).toBeNull();
  const chips = [...container.querySelectorAll<HTMLButtonElement>(".sg-prompt-chip")];
  expect(chips.map(c => c.textContent)).toEqual([
    "Warm studio filmic look with natural skin tones and soft highlight rolloff",
    "Crisp neutral daylight with gentle shadow lift",
    "Clean documentary grade, balanced contrast and subtle warmth",
  ]);
  await act(async () => chips[1]!.click());
  expect(onSuggestPrompt).toHaveBeenCalledWith("Crisp neutral daylight with gentle shadow lift");
  await show(null, onSuggestPrompt);
  expect(container.querySelectorAll(".sg-prompt-chip")).toHaveLength(3);
});

it("names the saved look with its LUT and notes, and lists only the settings it changes", async () => {
  await show(look({ exposure: 0.5, contrast: 1.2, saturation: 0.8, warmth: -0.3, tint: 0.1, gamma: 1.1 }, { lutName: "Kodak 2383.cube", notes: "Keep skin natural." }));
  expect(container.querySelector("h3")!.textContent).toBe("Warm studio");
  expect(container.querySelector(".sg-lut-pill")!.textContent).toBe("Kodak 2383.cube");
  expect(container.querySelector(".sg-color-notes")!.textContent).toBe("Keep skin natural.");
  expect(readouts()).toEqual(["Exposure +0.50 EV", "Contrast +20", "Saturation -20", "Warmth -30", "Tint +10", "Gamma 1.10"]);
  await show(look({ exposure: -0.25, shadows: 0.2, highlights: -0.4, blacks: -0.1, whites: 0.15 }, { name: "" }));
  expect(container.querySelector("h3")!.textContent).toBe("Saved camera look");
  expect(container.querySelector(".sg-lut-pill")).toBeNull();
  expect(container.querySelector(".sg-color-notes")).toBeNull();
  expect(readouts()).toEqual(["Exposure -0.25 EV", "Shadows +20", "Highlights -40", "Blacks -10", "Whites +15"]);
});

it("lists no settings for a look that leaves the picture as it is, and shows the frame unchanged", async () => {
  await show(look());
  expect(container.querySelector('[aria-label="Saved color look parameters"]')).toBeNull();
  expect(drawn.graded.at(-1)).toEqual(SOURCE);
});

it("draws the reference frame once and grades it again when the look changes", async () => {
  await show(look({ exposure: 1 }));
  const fills = drawn.fills;
  expect(fills).toBeGreaterThan(10);
  expect(drawn.read).toBe(1);
  // Exposure +1 doubles the light, up to white.
  expect(graded()[DARK]).toEqual([40, 40, 40]);
  expect(graded()[GRAY]).toEqual([255, 255, 255]);
  await show(look({ saturation: 0 }));
  expect(drawn.fills).toBe(fills);
  expect(drawn.read).toBe(1);
  // No saturation leaves each colour's brightness in gray.
  expect(graded()[SKIN]).toEqual([158, 158, 158]);
  // Alpha is untouched.
  expect(drawn.graded.at(-1)![15]).toBe(255);
});

it("grades contrast and gamma around the middle", async () => {
  await show(look({ contrast: 2 }));
  expect(graded()[GRAY]).toEqual([129, 129, 129]);
  expect(graded()[DARK]).toEqual([0, 0, 0]);
  expect(graded()[BRIGHT]).toEqual([255, 255, 255]);
  await show(look({ gamma: 2 }));
  expect(graded()[GRAY]).toEqual([181, 181, 181]);
  expect(graded()[DARK]).toEqual([71, 71, 71]);
});

it("warms toward red and tints away from green, keeping the gray's brightness", async () => {
  await show(look({ warmth: 0.5 }));
  const [r, g, b] = graded()[GRAY]!;
  expect(r).toBeGreaterThan(128);
  expect(b).toBeLessThan(128);
  expect(Math.abs(0.2126 * r! + 0.7152 * g! + 0.0722 * b! - 128)).toBeLessThan(12);
  await show(look({ tint: 0.5 }));
  const [tr, tg, tb] = graded()[GRAY]!;
  expect(tg).toBeLessThan(tr!);
  expect(tg).toBeLessThan(tb!);
  await show(look({ warmth: -0.5 }));
  expect(graded()[GRAY]![2]).toBeGreaterThan(graded()[GRAY]![0]!);
});

it("lifts or crushes the blacks, and brightens or holds back the whites", async () => {
  await show(look({ blacks: 1 }));
  expect(graded()[DARK]![0]).toBeGreaterThan(20);
  await show(look({ blacks: -1 }));
  expect(graded()[DARK]![0]).toBeLessThan(20);
  await show(look({ whites: 1 }));
  expect(graded()[BRIGHT]![0]).toBe(255);
  expect(graded()[GRAY]![0]).toBeGreaterThan(128);
  await show(look({ whites: -1 }));
  expect(graded()[BRIGHT]![0]).toBeLessThan(240);
});

it("opens the shadows and pulls down the highlights where they are", async () => {
  await show(look({ shadows: 1 }));
  const lifted = graded();
  expect(lifted[DARK]![0]).toBeGreaterThan(20);
  expect(lifted[GRAY]![0]).toBeGreaterThan(128);
  await show(look({ highlights: -1 }));
  expect(graded()[BRIGHT]![0]).toBeLessThan(235);
  // The shadows hardly move.
  expect(20 - graded()[DARK]![0]!).toBeLessThanOrEqual(1);
});

it("shows the look's details without a frame where there's no canvas to draw on", async () => {
  contextFails = true;
  await show(look({ exposure: 1 }));
  expect(drawn.graded).toEqual([]);
  expect(readouts()).toEqual(["Exposure +1.00 EV"]);
  contextFails = false;
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
  await show(look({ exposure: 0.5 }));
  expect(drawn.graded).toEqual([]);
});

it("moves the Before/After split with the arrow keys, kept inside the frame", async () => {
  await show(look({ exposure: 1 }));
  expect(slider().getAttribute("aria-valuenow")).toBe("50");
  expect(afterClip()).toBe("inset(0 0 0 50%)");
  await key("ArrowLeft");
  expect(slider().getAttribute("aria-valuenow")).toBe("45");
  expect(slider().style.left).toBe("45%");
  await key("ArrowRight");
  await key("ArrowRight");
  expect(slider().getAttribute("aria-valuenow")).toBe("55");
  for (let i = 0; i < 12; i++) await key("ArrowRight");
  expect(slider().getAttribute("aria-valuenow")).toBe("95");
  for (let i = 0; i < 25; i++) await key("ArrowLeft");
  expect(slider().getAttribute("aria-valuenow")).toBe("5");
  await key("Enter");
  expect(slider().getAttribute("aria-valuenow")).toBe("5");
});

it("drags the split across the frame until the pointer is let go", async () => {
  await show(look({ exposure: 1 }));
  vi.spyOn(stage(), "getBoundingClientRect").mockReturnValue({ left: 100, right: 500, width: 400, top: 0, bottom: 225, height: 225, x: 100, y: 0, toJSON: () => ({}) });
  await pointer("pointerdown", stage(), 200);
  expect(slider().getAttribute("aria-valuenow")).toBe("25");
  await pointer("pointermove", window, 420);
  expect(slider().getAttribute("aria-valuenow")).toBe("80");
  expect(afterClip()).toBe("inset(0 0 0 80%)");
  await pointer("pointermove", window, 0);
  expect(slider().getAttribute("aria-valuenow")).toBe("5");
  await pointer("pointerup", window, 0);
  await pointer("pointermove", window, 300);
  expect(slider().getAttribute("aria-valuenow")).toBe("5");
});

it("leaves the split where it is for a frame with no size", async () => {
  await show(look({ exposure: 1 }));
  vi.spyOn(stage(), "getBoundingClientRect").mockReturnValue({ left: 0, right: 0, width: 0, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
  await pointer("pointerdown", stage(), 200);
  expect(slider().getAttribute("aria-valuenow")).toBe("50");
  await pointer("pointerup", window, 0);
});
