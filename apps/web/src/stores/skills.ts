import { create } from "zustand";
import { dialogueShortcut, isDialogueGuide, skillCommands, type Skill, type UpsertSkillRequest } from "@scarlet/shared";
import { api, errorMessage } from "../lib/client";

interface SkillsState {
  skills: Skill[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  load(): Promise<void>;
  apply(skill: Skill): void;
  create(body: UpsertSkillRequest): Promise<Skill>;
  update(id: string, body: Partial<UpsertSkillRequest>): Promise<Skill>;
  remove(id: string): Promise<void>;
}

export function enabledSkills(library: Skill[]) {
  const commands = library.filter(skill => skill.enabled);
  const dialogue = library.find(skill => skill.name === "dialogue-pass") ?? library.find(isDialogueGuide);
  if (dialogue?.enabled && isDialogueGuide(dialogue) && !library.some(skill => skill.name === "tighten-pauses-here")) {
    commands.push({ ...dialogue, name: "tighten-pauses-here", description: "Tighten only pauses in the selected passage or around the playhead." });
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

export { skillCommands };

/** A pasted command may be sent before the picker finishes loading. */
export async function commandSkillIds(draft: string): Promise<string[] | undefined> {
  const names = new Set(skillCommands(draft).map(command => command.name).filter(Boolean));
  if (!names.size) return;
  const library = useSkillsStore.getState();
  if (library.status !== "ready") await library.load();
  const { skills, error } = useSkillsStore.getState();
  if (error) throw new Error(error);
  const available = enabledSkills(skills);
  const ids = new Set<string>();
  for (const name of names) {
    const skill = available.find(s => s.name === name);
    if (skill) ids.add(skill.id);
    else if (!dialogueShortcut(name, skills)) throw new Error(`No enabled skill named /${name}.`);
  }
  return ids.size ? [...ids] : undefined;
}

let loading: Promise<void> | undefined;

export const useSkillsStore = create<SkillsState>((set, get) => ({
  skills: [],
  status: "idle",
  error: null,
  load() {
    if (loading) return loading;
    set({ status: "loading", error: null });
    loading = api.skills()
      .then(({ skills }) => set({ skills, status: "ready", error: null }))
      .catch(err => set({ status: "error", error: errorMessage(err) }))
      .finally(() => { loading = undefined; });
    return loading;
  },
  apply(skill) {
    const rest = get().skills.filter((s) => s.id !== skill.id);
    set({ skills: [...rest, skill].sort((a, b) => a.name.localeCompare(b.name)) });
  },
  async create(body) {
    const { skill } = await api.createSkill(body);
    get().apply(skill);
    return skill;
  },
  async update(id, body) {
    const prev = get().skills.find((s) => s.id === id);
    if (prev) get().apply({ ...prev, ...body, agents: body.agents ?? prev.agents, enabled: body.enabled ?? prev.enabled });
    try {
      const { skill } = await api.updateSkill(id, body);
      get().apply(skill);
      return skill;
    } catch (err) {
      if (prev) get().apply(prev);
      throw err;
    }
  },
  async remove(id) {
    await api.deleteSkill(id);
    set({ skills: get().skills.filter((s) => s.id !== id) });
  },
}));
