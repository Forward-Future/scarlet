// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelOptions } from "@scarlet/shared";
import { EffortDial, EffortSlider, GaugeIcon, SpeedSegmented, TuneDrawer } from "./ModelControls";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const efforts = [
  { id: "low", label: "Low", title: "Quick" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
];
const render = (node: React.ReactNode) => act(async () => root.render(node));
const radios = (group = "Effort") => [...container.querySelectorAll<HTMLButtonElement>(`[aria-label="${group}"] [role="radio"]`)];
const checked = (group = "Effort") => radios(group).filter(r => r.getAttribute("aria-checked") === "true").map(r => r.textContent);
const track = () => container.querySelector<HTMLDivElement>('[aria-label="Effort"] > div')!;
/** The slider's round thumb, last of the track's marks. */
const thumbLeft = () => [...track().querySelectorAll<HTMLElement>("span[aria-hidden]")].at(-1)!.style.left;
const shimmer = () => container.querySelector<HTMLElement>(".effort-capsule-shimmer")!.style.opacity;
/** A track 226px wide at x=0: its stops sit 13px in from each end, 200px apart. */
function sized(width = 226) {
  vi.spyOn(track(), "getBoundingClientRect").mockReturnValue({ left: 0, right: width, width, top: 0, bottom: 26, height: 26, x: 0, y: 0, toJSON: () => ({}) });
  track().setPointerCapture = vi.fn();
}
const at = (ratio: number) => 13 + ratio * 200;
const pointer = (type: string, target: EventTarget, init: PointerEventInit = {}) =>
  act(async () => { target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, ...init })); });

it("draws the effort dial's arc and needle only for a level it knows", async () => {
  await render(<><EffortDial /><EffortDial level={0} size={20} /><EffortDial level={1} /></>);
  const [none, lowest, highest] = [...container.querySelectorAll("svg")];
  expect(none!.querySelectorAll("path")).toHaveLength(1);
  expect(lowest!.getAttribute("width")).toBe("20");
  // At the lowest level the needle shows but there's no lit arc.
  expect(lowest!.querySelectorAll("path")).toHaveLength(2);
  expect(lowest!.querySelector("path[transform]")!.getAttribute("transform")).toBe("rotate(-125.0 8 9)");
  expect(highest!.querySelectorAll("path")).toHaveLength(3);
  expect(highest!.querySelector("path[transform]")!.getAttribute("transform")).toBe("rotate(125.0 8 9)");
});

it("sizes the gauge icon as asked, 12px by default", async () => {
  await render(<><GaugeIcon /><GaugeIcon size={16} /></>);
  expect([...container.querySelectorAll("svg")].map(s => s.getAttribute("width"))).toEqual(["12", "16"]);
});

it("shows a lone effort as one pill to choose", async () => {
  const onChange = vi.fn();
  await render(<EffortSlider options={[{ id: "high", label: "High", title: "Thinks hard" }]} onChange={onChange} />);
  const only = radios()[0]!;
  expect(radios()).toHaveLength(1);
  expect(only.textContent).toBe("High");
  expect(only.title).toBe("Thinks hard");
  expect(only.getAttribute("aria-checked")).toBe("false");
  await act(async () => only.click());
  expect(onChange).toHaveBeenCalledWith("high");
  await render(<EffortSlider options={[{ id: "high", label: "High" }]} value="high" onChange={onChange} />);
  expect(radios()[0]!.getAttribute("aria-checked")).toBe("true");
});

it("picks an effort from its label and places the thumb on it", async () => {
  const onChange = vi.fn();
  await render(<EffortSlider options={efforts} value="medium" onChange={onChange} />);
  expect(radios().map(r => r.textContent)).toEqual(["Low", "Medium", "High", "Max"]);
  expect(radios()[0]!.title).toBe("Quick");
  expect(checked()).toEqual(["Medium"]);
  expect(thumbLeft()).toBe(`calc(13px + (100% - 26px) * ${1 / 3})`);
  expect(shimmer()).toBe("0");
  await act(async () => radios()[3]!.click());
  expect(onChange).toHaveBeenCalledWith("max");
});

it("shimmers more the higher the effort", async () => {
  await render(<EffortSlider options={efforts} value="high" onChange={() => {}} />);
  expect(shimmer()).toBe("0.35");
  await render(<EffortSlider options={efforts} value="max" onChange={() => {}} />);
  expect(shimmer()).toBe("0.85");
  expect(thumbLeft()).toBe("calc(13px + (100% - 26px) * 1)");
});

it("shows the model's default effort without choosing it when none is picked", async () => {
  await render(<EffortSlider options={efforts} visualId="high" onChange={() => {}} />);
  expect(checked()).toEqual([]);
  expect(thumbLeft()).toBe(`calc(13px + (100% - 26px) * ${2 / 3})`);
  // Not chosen, so it doesn't shimmer.
  expect(shimmer()).toBe("0");
  await render(<EffortSlider options={efforts} onChange={() => {}} />);
  expect(thumbLeft()).toBe("calc(13px + (100% - 26px) * 0)");
});

it("picks each effort the thumb is dragged across once, and ignores the click that ends the drag", async () => {
  vi.useFakeTimers();
  const onChange = vi.fn();
  await render(<EffortSlider options={efforts} value="low" onChange={onChange} />);
  sized();
  await pointer("pointerdown", track(), { clientX: at(0.05) });
  // Pressing where it already is changes nothing.
  expect(onChange).not.toHaveBeenCalled();
  expect(track().setPointerCapture).toHaveBeenCalledWith(1);
  expect(thumbLeft()).toBe("calc(13px + (100% - 26px) * 0.05)");
  await pointer("pointermove", window, { clientX: at(0.4) });
  await pointer("pointermove", window, { clientX: at(0.45) });
  await pointer("pointermove", window, { clientX: at(1.5) });
  expect(onChange.mock.calls).toEqual([["medium"], ["max"]]);
  expect(thumbLeft()).toBe("calc(13px + (100% - 26px) * 1)");
  await pointer("pointerup", window);
  // The click that follows the drag isn't a second pick.
  await act(async () => radios()[2]!.click());
  expect(onChange).toHaveBeenCalledTimes(2);
  await act(async () => vi.runAllTimers());
  await act(async () => radios()[2]!.click());
  expect(onChange).toHaveBeenLastCalledWith("high");
  // The drag has ended: moving the pointer picks nothing.
  await pointer("pointermove", window, { clientX: at(0) });
  expect(onChange).toHaveBeenCalledTimes(3);
});

it("ends a drag when the pointer is cancelled", async () => {
  const onChange = vi.fn();
  await render(<EffortSlider options={efforts} value="low" onChange={onChange} />);
  sized();
  await pointer("pointerdown", track(), { clientX: at(0.7) });
  expect(onChange).toHaveBeenCalledWith("high");
  await pointer("pointercancel", window);
  await pointer("pointermove", window, { clientX: at(1) });
  expect(onChange).toHaveBeenCalledTimes(1);
});

it("ignores a right press, and a track with no room to measure", async () => {
  const onChange = vi.fn();
  await render(<EffortSlider options={efforts} value="low" onChange={onChange} />);
  sized();
  await pointer("pointerdown", track(), { clientX: at(1), button: 2 });
  expect(onChange).not.toHaveBeenCalled();
  sized(20);
  await pointer("pointerdown", track(), { clientX: at(1) });
  await pointer("pointermove", window, { clientX: at(1) });
  expect(onChange).not.toHaveBeenCalled();
  await pointer("pointerup", window);
});

it("switches speed from its segments", async () => {
  const onChange = vi.fn();
  const speeds = [{ id: "", label: "Default" }, { id: "fast", label: "Fast", title: "Priority" }];
  await render(<SpeedSegmented options={speeds} value="" onChange={onChange} />);
  expect(radios("Speed").map(r => r.textContent)).toEqual(["Default", "Fast"]);
  expect(checked("Speed")).toEqual(["Default"]);
  expect(radios("Speed")[1]!.title).toBe("Priority");
  await act(async () => radios("Speed")[1]!.click());
  expect(onChange).toHaveBeenCalledWith("fast");
});

const drawerEfforts: ModelOptions["efforts"] = [{ id: "low" }, { id: "high", description: "Thinks hard" }];

it("tunes effort and speed in the drawer, and folds it with Done", async () => {
  const onEffortChange = vi.fn();
  const onSpeedChange = vi.fn();
  const onDone = vi.fn();
  await render(TuneDrawer({
    efforts: drawerEfforts, dialEffort: drawerEfforts[1], effortSummary: "High", effortValue: "high",
    speedOptions: [{ id: "", label: "Default" }, { id: "fast", label: "Fast" }], activeSpeedId: "fast",
    onEffortChange, onSpeedChange, onDone,
  }));
  const head = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  expect(head.getAttribute("aria-expanded")).toBe("true");
  expect(head.textContent).toBe("Effort· HighDone");
  // Effort labels come from the ids when they have none.
  expect(radios().map(r => r.textContent)).toEqual(["Low", "High"]);
  expect(radios()[1]!.title).toBe("Thinks hard");
  expect(checked()).toEqual(["High"]);
  expect(container.textContent).toContain("Speed");
  expect(checked("Speed")).toEqual(["Fast"]);
  await act(async () => radios()[0]!.click());
  expect(onEffortChange).toHaveBeenCalledWith("low");
  await act(async () => radios("Speed")[0]!.click());
  expect(onSpeedChange).toHaveBeenCalledWith("");
  await act(async () => head.click());
  expect(onDone).toHaveBeenCalledTimes(1);
});

it("heads the drawer Speed for a model with speeds but no efforts", async () => {
  await render(TuneDrawer({
    efforts: [], effortSummary: "", speedOptions: [{ id: "", label: "Default" }, { id: "fast", label: "Fast" }], activeSpeedId: "",
    onEffortChange: () => {}, onSpeedChange: () => {}, onDone: () => {},
  }));
  expect(container.querySelector("button[aria-expanded]")!.textContent).toBe("SpeedDone");
  expect(container.querySelector('[aria-label="Effort"]')).toBeNull();
  expect(checked("Speed")).toEqual(["Default"]);
});

it("leaves speed out of the drawer for a model with none", async () => {
  await render(TuneDrawer({
    efforts: drawerEfforts, effortSummary: "Default", speedOptions: [], activeSpeedId: "",
    onEffortChange: () => {}, onSpeedChange: () => {}, onDone: () => {},
  }));
  expect(container.querySelector('[aria-label="Speed"]')).toBeNull();
  // No effort chosen or known: the dial shows no needle.
  expect(container.querySelector("button[aria-expanded] svg path[transform]")).toBeNull();
});
