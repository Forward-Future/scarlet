// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Skill } from "@scarlet/shared";
import { buildDb } from "../lib/mock/fixtures";
import { useSkillsStore } from "../stores/skills";
import { SkillsPage } from "./SkillsPage";

const fixture = buildDb().skills[0]!;
const initial = useSkillsStore.getState();
let root: Root;
let container: HTMLDivElement;

const skill = (name: string, over: Partial<Skill> = {}, category?: string): Skill => ({ ...fixture, id: `skl_${name}`, name, description: `What ${name} does`,
  enabled: true, source: undefined, content: `---\nname: ${name}\n${category ? `category: ${category}\n` : ""}---\nSteps.`, ...over });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useSkillsStore.setState(initial, true);
  vi.unstubAllGlobals();
});

const show = () => act(async () => root.render(<MemoryRouter><SkillsPage /></MemoryRouter>));
const sections = () => [...container.querySelectorAll("section section")].map(s => [s.getAttribute("aria-label"), [...s.querySelectorAll(".skill-row a .font-mono")].map(n => n.textContent)]);

it("loads the skills once, says so while it does, and offers Retry when they can't be read", async () => {
  const load = vi.fn();
  useSkillsStore.setState({ skills: [], status: "idle", error: null, load });
  await show();
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => useSkillsStore.setState({ status: "loading" }));
  expect(container.textContent).toContain("Loading skills…");
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => useSkillsStore.setState({ status: "error", error: "The engine isn’t answering." }));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("The engine isn’t answering.");
  await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Retry")!.click());
  expect(load).toHaveBeenCalledTimes(2);
  // Skills already on screen stay there through a reload that fails.
  await act(async () => useSkillsStore.setState({ skills: [skill("tighten-pauses")] }));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("tighten-pauses");
});

it("groups skills by the category they name, in the app's order, by name within each, with the rest last", async () => {
  useSkillsStore.setState({ status: "ready", error: null, load: vi.fn(), skills: [
    skill("zoom-in", {}, "Picture and graphics"), skill("clean-audio", { enabled: false, description: "" }, "Sound"), skill("balance-voices", {}, "Sound"),
    skill("house-style", { source: "change:chg_1" }), skill("first-cut", {}, "Getting started"), skill("my-own", {}, "Mine")] });
  await show();
  // Empty categories aren't drawn. One the app doesn't know comes after its own, and a skill with none is under Other.
  expect(sections()).toEqual([["Getting started", ["first-cut"]], ["Sound", ["balance-voices", "clean-audio"]], ["Picture and graphics", ["zoom-in"]],
    ["Other skills", ["house-style"]], ["Mine", ["my-own"]]]);
  const row = (name: string) => container.querySelector(`a[href="/settings/skills/skl_${name}"]`)!.closest("li")!;
  expect(row("clean-audio").textContent).toContain("No description");
  expect(row("clean-audio").querySelector('[role="switch"]')?.getAttribute("aria-label")).toBe("Enable clean-audio");
  expect(row("house-style").textContent).toContain("from an applied edit");
  expect(row("zoom-in").textContent).not.toContain("from an applied edit");
});

it("says which skill couldn't be turned on or off and why, until the next switch is tried", async () => {
  const update = vi.fn().mockRejectedValueOnce(new Error("The skill file is read-only.")).mockResolvedValue(skill("zoom-in"));
  useSkillsStore.setState({ status: "ready", error: null, load: vi.fn(), update, skills: [skill("zoom-in"), skill("clean-audio", { enabled: false })] });
  await show();
  const toggle = (label: string) => act(async () => container.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)!.click());
  await toggle("Disable zoom-in");
  expect(update).toHaveBeenCalledWith("skl_zoom-in", { enabled: false });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("zoom-in: The skill file is read-only.");
  await toggle("Enable clean-audio");
  expect(update).toHaveBeenLastCalledWith("skl_clean-audio", { enabled: true });
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("says no skills match a search that finds none, by name or by what the skill does", async () => {
  useSkillsStore.setState({ status: "ready", error: null, load: vi.fn(), skills: [skill("zoom-in", { description: "Punch in on the speaker" }), skill("clean-audio")] });
  await show();
  const search = (text: string) => act(async () => {
    const field = container.querySelector<HTMLInputElement>('[aria-label="Search skills"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await search("SPEAKER");
  expect(sections().flatMap(([, names]) => names)).toEqual(["zoom-in"]);
  await search("colour");
  expect(sections()).toEqual([]);
  expect(container.textContent).toContain("No skills match");
});
