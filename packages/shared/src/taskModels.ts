/**
 * Task models: kinds of work the editor gives to a model of their choosing (Settings → Models). The model running a
 * request hands each piece of such work to that model (`hand_off`), and its edits join the request.
 */
import { z } from "zod/v3";

/** A kind of work the editor named, what counts as it, and the model that does it. */
export const TaskModelType = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  name: z.string().trim().min(1).max(40),
  /** One plain sentence on what counts as this work. The model running a request reads it. */
  description: z.string().trim().max(300).default(""),
  /** "same": the chat's model does it, as with no task models. Otherwise one model as "agent:model" (`taskModelKey`). */
  model: z.string().regex(/^(same|[a-z]+:[^\s]*)$/).default("same"),
});
export type TaskModelType = z.infer<typeof TaskModelType>;

/** The two kinds of work every editor starts with. They can be renamed, given a model or deleted like their own. */
export const DEFAULT_TASK_MODELS: TaskModelType[] = [
  { id: "cutting", name: "Cutting", description: "Taking out words, pauses, retakes and mistakes, and tightening the edit.", model: "same" },
  { id: "motion-graphics", name: "Motion graphics", description: "Titles, lower thirds, callouts, animated text and end cards over the picture.", model: "same" },
];

export const TASK_MODELS_MAX = 20;

/** A model as a task type saves it: "agent:model", with nothing after the colon for the CLI's own default. */
export function taskModelKey(choice: { agent: string; model?: string }): string {
  return `${choice.agent}:${choice.model ?? ""}`;
}

/** The model a task type names, or none for "same". */
export function taskModelChoice(type: Pick<TaskModelType, "model">): { agent: string; model?: string } | undefined {
  if (type.model === "same") return undefined;
  const at = type.model.indexOf(":");
  if (at <= 0) return undefined;
  const model = type.model.slice(at + 1);
  return { agent: type.model.slice(0, at), ...(model && { model }) };
}

/** A new type's id from its name, unlike the ids already taken. */
export function taskModelId(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "task";
  let id = base, n = 2;
  while (taken.includes(id)) id = `${base}-${n++}`;
  return id;
}

/** What a request heard back from the model it handed a piece of work to (`POST /projects/:id/hand-off`). */
export type HandOffResult =
  | { state: "done"; handoffId: string; summary: string; changeIds: string[]; by: { agent: string; model?: string } }
  | { state: "working"; handoffId: string; by: { agent: string; model?: string } }
  | { state: "failed"; handoffId: string; error: string; by: { agent: string; model?: string } }
  | { state: "unavailable"; reason: string };
