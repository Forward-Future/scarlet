// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Skill } from "@scarlet/shared";
import { api } from "../lib/client";
import { buildDb } from "../lib/mock/fixtures";
import { commandSkillIds, enabledSkills, skillCommands, useSkillsStore } from "./skills";

const base = buildDb().skills[0]!;
const skill = (name: string, extra: Partial<Skill> = {}): Skill => ({ ...base, id: `skl_${name}`, name, enabled: true, ...extra });
const names = () => useSkillsStore.getState().skills.map(s => s.name);

beforeEach(() => useSkillsStore.setState({ skills: [], status: "idle", error: null }));
afterEach(() => vi.restoreAllMocks());

it("finds the skill commands in a message as whole words, and leaves paths, links and fractions alone", () => {
  expect(skillCommands("/dialogue-pass then /Tighten-Pauses-Here")).toEqual([
    { start: 0, end: 14, name: "dialogue-pass" },
    { start: 20, end: 40, name: "tighten-pauses-here" },
  ]);
  // A lone slash is a command being typed: it has a place and no name yet.
  expect(skillCommands("make it shorter /")).toEqual([{ start: 16, end: 17, name: "" }]);
  expect(skillCommands("line one\n/captions")).toEqual([{ start: 9, end: 18, name: "captions" }]);
  for (const text of ["see /Users/me/clip.mov", "https://example.com/a/b", "keep the A/B take", "50/50", "/captions, please", "/-bad"]) {
    expect(skillCommands(text)).toEqual([]);
  }
});

it("lists the skills that are on, by name, with the passage version of the dialogue pass beside it", () => {
  const library = [skill("zoom-in"), skill("captions", { enabled: false }), skill("dialogue-pass")];
  const listed = enabledSkills(library);
  expect(listed.map(s => s.name)).toEqual(["dialogue-pass", "tighten-pauses-here", "zoom-in"]);
  expect(enabledSkills([skill("dialogue-pass", { source: undefined, bundledName: undefined })]).map(s => s.name)).toEqual(["dialogue-pass"]);
  // The passage version runs the dialogue pass's own skill.
  expect(listed[1]).toMatchObject({ id: "skl_dialogue-pass", description: expect.stringContaining("selected passage") });
  // A library with its own skill of that name, on or off, keeps it as it is. With the dialogue pass off there is nothing to add.
  expect(enabledSkills([...library, skill("tighten-pauses-here", { enabled: false })]).map(s => s.name)).toEqual(["dialogue-pass", "zoom-in"]);
  expect(enabledSkills([skill("dialogue-pass", { enabled: false }), skill("zoom-in")]).map(s => s.name)).toEqual(["zoom-in"]);
});

it("turns the commands in a message into skill ids, loading the library first when it isn't here yet", async () => {
  const read = vi.spyOn(api, "skills").mockResolvedValue({ skills: [skill("dialogue-pass"), skill("captions"), skill("off", { enabled: false })] });
  // No command: nothing to look up.
  await expect(commandSkillIds("just trim the start")).resolves.toBeUndefined();
  await expect(commandSkillIds("type / to pick")).resolves.toBeUndefined();
  expect(read).not.toHaveBeenCalled();
  await expect(commandSkillIds("/captions and /tighten-pauses-here then /captions again, /dialogue-pass")).resolves.toEqual(["skl_captions", "skl_dialogue-pass"]);
  expect(read).toHaveBeenCalledTimes(1);
  // Loaded: not read again. A name that isn't an enabled skill is refused by name.
  await expect(commandSkillIds("/off")).rejects.toThrow("No enabled skill named /off.");
  await expect(commandSkillIds("/nothing-like-it")).rejects.toThrow("No enabled skill named /nothing-like-it.");
  expect(read).toHaveBeenCalledTimes(1);
});

it.each(["dialogue-pass", "first-cut-dialogue", "tighten-pauses-here"])("leaves /%s with a same-named custom guide even when disabled", async name => {
  const custom = skill(name, { source: undefined, bundledName: undefined });
  useSkillsStore.setState({ status: "ready", skills: [custom] });
  await expect(commandSkillIds(`Use /${name} here`)).resolves.toEqual([custom.id]);
  useSkillsStore.setState({ skills: [{ ...custom, enabled: false }] });
  await expect(commandSkillIds(`Use /${name} here`)).rejects.toThrow(`No enabled skill named /${name}.`);
});

it("keeps a customized first-cut-dialogue entry separate from the stock guide and its local pause shortcut", async () => {
  const stock = skill("dialogue-pass", { bundledName: "dialogue-pass" });
  const custom = skill("first-cut-dialogue", { source: undefined, bundledName: undefined });
  const library = [custom, stock];
  useSkillsStore.setState({ status: "ready", skills: library });
  expect(enabledSkills(library).map(entry => entry.name)).toEqual(["dialogue-pass", "first-cut-dialogue", "tighten-pauses-here"]);
  await expect(commandSkillIds("/first-cut-dialogue")).resolves.toEqual([custom.id]);
  await expect(commandSkillIds("/tighten-pauses-here")).resolves.toEqual([stock.id]);
  await expect(commandSkillIds("/dialogue-pass")).resolves.toEqual([stock.id]);
  expect(enabledSkills([stock]).map(entry => entry.name)).toEqual(["dialogue-pass", "tighten-pauses-here"]);
});

it("uses the former shipped guide for local pauses only in a library that predates the new one", async () => {
  const former = skill("first-cut-dialogue", { bundledName: "first-cut-dialogue" });
  const current = skill("dialogue-pass", { bundledName: "dialogue-pass" });
  useSkillsStore.setState({ status: "ready", skills: [former] });
  await expect(commandSkillIds("/tighten-pauses-here")).resolves.toEqual([former.id]);
  useSkillsStore.setState({ skills: [former, current] });
  await expect(commandSkillIds("/tighten-pauses-here")).resolves.toEqual([current.id]);
  useSkillsStore.setState({ skills: [former, { ...current, enabled: false }] });
  await expect(commandSkillIds("/tighten-pauses-here")).resolves.toBeUndefined();
  useSkillsStore.setState({ skills: [former, { ...current, source: undefined, bundledName: undefined }] });
  await expect(commandSkillIds("/tighten-pauses-here")).resolves.toBeUndefined();
});

it("refuses a command with the reason when the library can't be loaded", async () => {
  vi.spyOn(api, "skills").mockRejectedValue(new Error("engine away"));
  await expect(commandSkillIds("/captions")).rejects.toThrow("engine away");
  expect(useSkillsStore.getState()).toMatchObject({ status: "error", error: "engine away" });
});

it("loads the library once for callers that ask together, and again after a failure", async () => {
  let answer!: (response: { skills: Skill[] }) => void;
  const read = vi.spyOn(api, "skills").mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
  const first = useSkillsStore.getState().load();
  expect(useSkillsStore.getState().load()).toBe(first);
  expect(useSkillsStore.getState().status).toBe("loading");
  answer({ skills: [skill("captions")] });
  await first;
  expect(useSkillsStore.getState()).toMatchObject({ status: "ready", error: null });
  expect(names()).toEqual(["captions"]);
  read.mockRejectedValueOnce(new Error("engine away"));
  await useSkillsStore.getState().load();
  // The skills it had stay listed beside the error.
  expect(useSkillsStore.getState()).toMatchObject({ status: "error", error: "engine away" });
  expect(names()).toEqual(["captions"]);
  expect(read).toHaveBeenCalledTimes(2);
});

it("keeps the library in name order as skills are made, changed by the engine and removed", async () => {
  useSkillsStore.setState({ skills: [skill("captions"), skill("zoom-in")] });
  vi.spyOn(api, "createSkill").mockResolvedValue({ skill: skill("music-bed") });
  await expect(useSkillsStore.getState().create({ name: "music-bed" } as never)).resolves.toMatchObject({ id: "skl_music-bed" });
  expect(names()).toEqual(["captions", "music-bed", "zoom-in"]);
  // The engine says one was renamed: it is replaced, not listed twice.
  useSkillsStore.getState().apply(skill("zoom-in", { name: "auto-zoom" }));
  expect(names()).toEqual(["auto-zoom", "captions", "music-bed"]);
  vi.spyOn(api, "deleteSkill").mockResolvedValue(undefined as never);
  await useSkillsStore.getState().remove("skl_captions");
  expect(names()).toEqual(["auto-zoom", "music-bed"]);
});

it("shows a change to a skill at once and puts it back if the engine refuses", async () => {
  const captions = skill("captions", { agents: ["claude"] as Skill["agents"] });
  useSkillsStore.setState({ skills: [captions] });
  let refuse!: (error: Error) => void;
  const send = vi.spyOn(api, "updateSkill").mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject; }));
  const updating = useSkillsStore.getState().update(captions.id, { enabled: false });
  // Off at once, with the agents it had.
  expect(useSkillsStore.getState().skills).toEqual([{ ...captions, enabled: false }]);
  refuse(new Error("engine away"));
  await expect(updating).rejects.toThrow("engine away");
  expect(useSkillsStore.getState().skills).toEqual([captions]);
  const saved = { ...captions, enabled: false, description: "As the engine saved it" };
  send.mockResolvedValue({ skill: saved });
  await expect(useSkillsStore.getState().update(captions.id, { enabled: false })).resolves.toBe(saved);
  expect(useSkillsStore.getState().skills).toEqual([saved]);
  // A skill that isn't listed yet is added when the engine answers.
  send.mockResolvedValue({ skill: skill("new-one") });
  await useSkillsStore.getState().update("skl_new-one", { description: "x" });
  expect(names()).toEqual(["captions", "new-one"]);
});
