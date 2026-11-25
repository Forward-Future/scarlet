// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { player } from "../../lib/player";
import { usePictureMarksStore } from "../../stores/pictureMarks";
import { usePlayerStore } from "../../stores/player";
import { PictureMarkTools, PictureMarks, marksTakeEscape, toggleMarking } from "./PictureMarks";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  usePlayerStore.setState({ time: 7, playing: false });
  usePictureMarksStore.setState({ marking: null, tool: "draw", byProject: {} });
  vi.spyOn(player, "pause").mockImplementation(() => {});
  vi.spyOn(player, "seek").mockImplementation(() => {});
  // The picture is 400 by 200 at the page's top left.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, x: 0, y: 0, toJSON() {} } as DOMRect);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const start = () => toggleMarking("prj", { time: usePlayerStore.getState().time, version: "v1" });
const show = () => act(async () => root.render(<>
  <PictureMarks projectId="prj" version="v1" fps={25} />
  <PictureMarkTools projectId="prj" enabled onStart={start} />
</>));
const press = (type: string, x: number, y: number) => act(async () => {
  const frame = container.querySelector(".picture-marks-frame")!;
  frame.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0 }));
});
const marks = () => usePictureMarksStore.getState().byProject.prj?.marks ?? [];

it("draws a line, a box and a point on the frame, in fractions of the picture, and numbers them once there are several", async () => {
  await show();
  expect(container.querySelector(".picture-marks")).toBeNull();
  // The tools are always over the picture, with no time beside them.
  expect(container.querySelector(".picture-mark-tools")?.textContent).toBe("");
  expect(container.querySelector('[aria-label="Draw"]')?.getAttribute("aria-pressed")).toBe("false");
  await act(async () => toggleMarking("prj", { time: 7, version: "v1", picture: "frame://7" }));
  expect(player.pause).toHaveBeenCalled();
  expect(container.querySelector('[aria-label="Draw"]')?.getAttribute("aria-pressed")).toBe("true");
  await press("pointerdown", 200, 60);
  await press("pointermove", 240, 100);
  await press("pointermove", 200, 140);
  await press("pointermove", 160, 100);
  await press("pointerup", 200, 62);
  expect(marks()).toHaveLength(1);
  expect(marks()[0]).toMatchObject({ kind: "draw", box: { x: 0.4, y: 0.3, w: 0.2, h: 0.4 } });
  expect(container.querySelector(".picture-mark-number")).toBeNull();

  await act(async () => (container.querySelector('[aria-label="Box"]') as HTMLButtonElement).click());
  await press("pointerdown", 20, 20);
  await press("pointermove", 100, 80);
  await press("pointerup", 100, 80);
  expect(marks()[1]).toEqual({ kind: "box", box: { x: 0.05, y: 0.1, w: 0.2, h: 0.3 } });

  // A press that hardly moves puts a point there, whatever the tool.
  await press("pointerdown", 360, 40);
  await press("pointerup", 361, 40);
  expect(marks()[2]).toEqual({ kind: "point", box: { x: 0.9, y: 0.2, w: 0, h: 0 } });
  expect(Array.from(container.querySelectorAll(".picture-mark-number, .picture-mark-point"), n => n.textContent)).toEqual(["1", "2", "3"]);
});

it("starts marking from M pressed while the video plays, once the player hears it stopped, on the frame marked", async () => {
  usePlayerStore.setState({ playing: true });
  await show();
  // The player says it stopped a moment after the press: the marking is on already.
  await act(async () => start());
  expect(player.pause).toHaveBeenCalled();
  expect(usePictureMarksStore.getState().marking).toBe("prj");
  // The video ran on past the frame meanwhile: it goes back to the frame marked.
  expect(player.seek).toHaveBeenCalledWith(7, true);
  await act(async () => usePlayerStore.setState({ playing: false }));
  expect(usePictureMarksStore.getState().marking).toBe("prj");
  expect(usePictureMarksStore.getState().byProject.prj?.time).toBe(7);
  // Playing on from there still ends it.
  await act(async () => usePlayerStore.setState({ playing: true }));
  expect(usePictureMarksStore.getState().marking).toBeNull();
});

it("leaves marking on Esc or when the video plays on, and keeps the marks for the message", async () => {
  await show();
  await act(async () => toggleMarking("prj", { time: 7, version: "v1" }));
  await act(async () => (container.querySelector('[aria-label="Point"]') as HTMLButtonElement).click());
  await press("pointerdown", 100, 100);
  await press("pointerup", 100, 100);
  // ⌘Z takes the last mark off, D B P pick the tool.
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true })); });
  expect(usePictureMarksStore.getState().tool).toBe("box");
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(usePictureMarksStore.getState().marking).toBeNull();
  // Resting on the marked frame, the marks show, and the picture doesn't take the pointer.
  expect(container.querySelector(".picture-marks:not([data-marking]) .picture-mark-point")).not.toBeNull();
  await act(async () => usePlayerStore.setState({ playing: true }));
  expect(container.querySelector(".picture-marks")).toBeNull();
  expect(marks()).toHaveLength(1);
  // Marking again starts on the frame that holds the marks.
  await act(async () => usePlayerStore.setState({ playing: false, time: 12 }));
  await act(async () => toggleMarking("prj", { time: 12, version: "v1" }));
  expect(player.seek).toHaveBeenCalledWith(7, true);
  await act(async () => usePlayerStore.setState({ time: 7 }));
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true })); });
  expect(marks()).toHaveLength(0);
});

it("starts marking from a tool over the picture, and ends it when the lit tool is pressed again", async () => {
  await show();
  const tool = (name: string) => container.querySelector(`[aria-label="${name}"]`) as HTMLButtonElement;
  expect(tool("Undo").disabled).toBe(true);
  await act(async () => tool("Box").click());
  expect(player.pause).toHaveBeenCalled();
  expect(usePictureMarksStore.getState()).toMatchObject({ marking: "prj", tool: "box" });
  await press("pointerdown", 20, 20);
  await press("pointermove", 100, 80);
  await press("pointerup", 100, 80);
  expect(tool("Undo").disabled).toBe(false);
  await act(async () => tool("Box").click());
  expect(usePictureMarksStore.getState().marking).toBeNull();
  expect(marks()).toHaveLength(1);
  await act(async () => tool("Clear marks").click());
  expect(marks()).toHaveLength(0);
});

it("explains each top-left icon on hover (including disabled buttons) and hides when leaving", async () => {
  await show();
  const hoverItem = (label: string, type: "pointerover" | "pointerout") => act(async () => {
    const item = container.querySelector(`[aria-label="${label}"]`)!.parentElement!;
    item.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "mouse" }));
  });
  const tip = () => container.querySelector('[role="tooltip"]');

  expect(tip()).toBeNull();
  for (const [label, snippet] of [
    ["Draw", "Draw freehand"],
    ["Box", "Drag a box"],
    ["Point", "Drop a pin"],
    ["Undo", "Take back the last mark"],
    ["Clear marks", "Remove all marks"],
  ] as const) {
    await hoverItem(label, "pointerover");
    expect(tip()?.textContent).toContain(label);
    expect(tip()?.textContent).toContain(snippet);
    expect(container.querySelector(`[aria-label="${label}"]`)?.getAttribute("aria-describedby")).toBe(tip()?.id);
    // Keep the pill itself text-free.
    expect(container.querySelector(".picture-mark-tools")?.textContent).toBe("");
    await hoverItem(label, "pointerout");
    expect(tip()).toBeNull();
  }
});

it("lets the editor grab and move boxes, freehand marks, and points, clamping to the frame and canceling on Esc", async () => {
  await show();
  await act(async () => toggleMarking("prj", { time: 7, version: "v1" }));

  // Draw a box (index 0): x=0.1..0.3, y=0.2..0.5 (40..120, 40..100 on 400x200)
  await act(async () => (container.querySelector('[aria-label="Box"]') as HTMLButtonElement).click());
  await press("pointerdown", 40, 40);
  await press("pointermove", 120, 100);
  await press("pointerup", 120, 100);

  // Draw a freehand loop (index 1)
  await act(async () => (container.querySelector('[aria-label="Draw"]') as HTMLButtonElement).click());
  for (const [type, x, y] of [
    ["pointerdown", 240, 60],
    ["pointermove", 280, 60],
    ["pointermove", 300, 100],
    ["pointermove", 280, 140],
    ["pointermove", 240, 140],
    ["pointermove", 220, 100],
    ["pointerup", 242, 62],
  ] as const) await press(type, x, y);

  // Drop a point (index 2)
  await act(async () => (container.querySelector('[aria-label="Point"]') as HTMLButtonElement).click());
  await press("pointerdown", 360, 160);
  await press("pointerup", 360, 160);
  expect(marks()).toHaveLength(3);
  expect(container.querySelector('polyline.picture-mark-hit[data-mark-index="1"]')?.hasAttribute("data-closed")).toBe(true);

  const dragEl = async (selector: string, x1: number, y1: number, x2: number, y2: number, opts?: { esc?: boolean }) => {
    const el = container.querySelector(selector)!;
    await act(async () => {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x1, clientY: y1, pointerId: 2, button: 0 }));
    });
    await act(async () => {
      el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x2, clientY: y2, pointerId: 2, button: 0 }));
    });
    if (opts?.esc) {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      await act(async () => {
        el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x2, clientY: y2, pointerId: 2, button: 0 }));
      });
      return;
    }
    await act(async () => {
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x2, clientY: y2, pointerId: 2, button: 0 }));
    });
  };

  // Grab and move the box (+80px = +0.2 in x, +40px = +0.2 in y)
  await dragEl('rect.picture-mark-hit[data-mark-index="0"]', 80, 70, 160, 110);
  expect(marks()[0]).toEqual({ kind: "box", box: { x: 0.3, y: 0.4, w: 0.2, h: 0.3 } });

  // ⌘Z puts the moved box back where it was, and every mark stays: a second one then takes the last mark drawn.
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true })); });
  expect(marks()).toHaveLength(3);
  expect(marks()[0]).toEqual({ kind: "box", box: { x: 0.1, y: 0.2, w: 0.2, h: 0.3 } });
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true })); });
  expect(marks()).toHaveLength(2);
  await press("pointerdown", 360, 160);
  await press("pointerup", 360, 160);
  await dragEl('rect.picture-mark-hit[data-mark-index="0"]', 80, 70, 160, 110);

  // Clicking a mark without dragging neither moves it nor creates a stray point.
  await dragEl('rect.picture-mark-hit[data-mark-index="0"]', 160, 110, 160, 110);
  expect(marks()).toHaveLength(3);
  expect(marks()[0]).toEqual({ kind: "box", box: { x: 0.3, y: 0.4, w: 0.2, h: 0.3 } });

  // Esc while dragging cancels the move and keeps marking active.
  await dragEl('rect.picture-mark-hit[data-mark-index="0"]', 160, 110, 260, 150, { esc: true });
  expect(marks()[0]).toEqual({ kind: "box", box: { x: 0.3, y: 0.4, w: 0.2, h: 0.3 } });
  expect(usePictureMarksStore.getState().marking).toBe("prj");

  // Grab the freehand mark by its number badge and drag it past the left edge — it clamps without squishing.
  await dragEl('.picture-mark-number[data-mark-index="1"]', 220, 60, -100, 60);
  expect(marks()[1]!.box).toEqual({ x: 0, y: 0.3, w: 0.2, h: 0.4 });
  expect(marks()[1]!.points!.every(([px, py]) => px >= 0 && px <= 1 && py >= 0 && py <= 1)).toBe(true);

  // Leave marking mode: marks can still be grabbed and moved while paused on the marked frame.
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(usePictureMarksStore.getState().marking).toBeNull();
  await dragEl('.picture-mark-point[data-mark-index="2"]', 360, 160, 200, 100);
  expect(marks()[2]).toEqual({ kind: "point", box: { x: 0.5, y: 0.5, w: 0, h: 0 } });
});

it("ends marking when seeking away while paused and drops any mid-draw stroke on Esc", async () => {
  await show();
  await act(async () => toggleMarking("prj", { time: 7, version: "v1" }));
  expect(usePictureMarksStore.getState().marking).toBe("prj");
  // Start a box stroke, then press Esc before lifting the pointer.
  await act(async () => (container.querySelector('[aria-label="Box"]') as HTMLButtonElement).click());
  await press("pointerdown", 40, 40);
  await press("pointermove", 160, 100);
  expect(container.querySelector(".picture-marks")?.hasAttribute("data-drawing")).toBe(true);
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(usePictureMarksStore.getState().marking).toBeNull();
  expect(container.querySelector(".picture-marks")).toBeNull();
  expect(marks()).toHaveLength(0);

  // Re-enter marking on frame 7, then seek to frame 10 while still paused: marking ends so strokes don't attach to frame 7.
  await act(async () => toggleMarking("prj", { time: 7, version: "v1" }));
  expect(usePictureMarksStore.getState().marking).toBe("prj");
  await act(async () => usePlayerStore.setState({ time: 10 }));
  expect(usePictureMarksStore.getState().marking).toBeNull();
  expect(container.querySelector(".picture-marks")).toBeNull();
});

it("says Esc is the marking's while a frame is marked or a mark is dragged, so nothing behind the picture closes with it", async () => {
  await show();
  const esc = (target: EventTarget = window) => {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    Object.defineProperty(event, "target", { value: target });
    return event;
  };
  expect(marksTakeEscape(esc())).toBe(false);
  await act(async () => toggleMarking("prj", { time: 7, version: "v1" }));
  expect(marksTakeEscape(esc())).toBe(true);
  // Words being written keep their own Esc: the marking doesn't end on it, so it isn't the marking's.
  const box = document.createElement("textarea");
  container.append(box);
  expect(marksTakeEscape(esc(box))).toBe(false);
  // Once marking is over, a mark held mid-drag still takes Esc, which puts it back.
  await press("pointerdown", 200, 100);
  await press("pointerup", 200, 100);
  await act(async () => usePictureMarksStore.getState().stop());
  expect(marksTakeEscape(esc())).toBe(false);
  const point = container.querySelector('.picture-mark-point[data-mark-index="0"]')!;
  await act(async () => { point.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 200, clientY: 100, pointerId: 2, button: 0 })); });
  expect(marksTakeEscape(esc())).toBe(true);
});

