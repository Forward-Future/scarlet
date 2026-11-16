// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../../lib/client";
import { sampleTemplates } from "../../lib/mock/fixtures";
import { useSkillsStore } from "../../stores/skills";
import { useTemplatesStore } from "../../stores/templates";
import { SkillInstructions } from "./SkillInstructions";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(api, "listTemplates").mockResolvedValue({ templates: sampleTemplates() });
  vi.spyOn(api, "skills").mockResolvedValue({ skills: [] });
  useTemplatesStore.setState(useTemplatesStore.getInitialState());
  useSkillsStore.setState({ skills: [], status: "idle", error: null });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("moves the hover note to the other place a keyword is named when the pointer goes there", async () => {
  const text = "Open with $lower-third, and close with $lower-third.";
  await act(async () => root.render(<SkillInstructions value={text} onChange={() => {}} className="field" />));
  await act(async () => {});
  const words = [...container.querySelectorAll<HTMLElement>(".skill-instructions-text [data-keyword]")];
  expect(words.map(w => w.textContent)).toEqual(["$lower-third", "$lower-third"]);
  // The first is on the first line, the second further along on the next.
  words.forEach((word, i) => vi.spyOn(word, "getClientRects").mockReturnValue([new DOMRect(40 + i * 100, 10 + i * 20, 80, 16)] as unknown as DOMRectList));
  const field = container.querySelector<HTMLTextAreaElement>("textarea")!;
  const move = (x: number, y: number) => act(async () => { field.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y })); });
  const note = () => container.querySelector<HTMLElement>(".skill-keyword-note");
  await move(50, 15);
  expect([note()?.style.left, note()?.style.top]).toEqual(["34px", "4px"]);
  expect(words.map(w => w.classList.contains("is-hover"))).toEqual([true, false]);
  await move(150, 35);
  expect([note()?.style.left, note()?.style.top]).toEqual(["134px", "24px"]);
  expect(words.map(w => w.classList.contains("is-hover"))).toEqual([false, true]);
  await move(5, 100);
  expect(note()).toBeNull();
});
