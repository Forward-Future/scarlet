/** Skill slash-command parsing and dialogue shortcut resolution. */
import type { Skill, Task } from "./api.js";

/**
 * What a request is, known when it is sent: a dialogue pass, or a request about one staged cut of a pass. It sets what
 * the chat shows while Scarlet works. A pass shows the stages Scarlet measures and a request about one cut its own two;
 * any other request has no kind, and shows the plan its agent lays out.
 */
export type RunKind = "pass" | "cut";

/** Whole whitespace-delimited tokens, also used to locate commands in the composer. */
export function skillCommands(draft: string) {
  return Array.from(draft.matchAll(/(?:^|\s)(\/([a-z0-9][a-z0-9-]*)?)(?=\s|$)/gi), match => {
    const end = match.index + match[0].length;
    return { start: end - match[1]!.length, end, name: (match[2] ?? "").toLowerCase() };
  });
}

function firstCutName(name: string | undefined) {
  return name === "dialogue-pass" || name === "first-cut-dialogue";
}

/**
 * The guides a skill builds on, in the order it names them. It names one by calling it in its text, `/frame-screen`,
 * at the place it applies, with what it changes written beside the call; or in its header, `extends: dialogue-pass`,
 * several with commas between them. An editor's own style ("cut my joins tighter, frame my demos my way") then runs
 * with the guides it adds to, and their later improvements reach it, instead of a copy of each guide drifting apart
 * from it. A name is only a guide when the library has one by it, which the caller checks.
 */
export function skillExtends(skill: Pick<Skill, "content"> & Partial<Pick<Skill, "name">>): string[] {
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(skill.content);
  const value = front && /^extends:[ \t]*(.*)$/m.exec(front[1]!)?.[1]?.trim().replace(/^\[|\]$/g, "");
  const header = (value ?? "").split(",").map(name => name.trim().replace(/^["']|["']$/g, "").replace(/^\//, "")).filter(Boolean);
  // A call in the text: a whole word after a space or an opening bracket, so a path or a name in code isn't one.
  const body = skill.content.slice(front?.[0].length ?? 0);
  const called = Array.from(body.matchAll(/(?:^|[\s(])\/([a-z0-9][a-z0-9-]*)(?=[\s.,;:!?)]|$)/gim), match => match[1]!.toLowerCase());
  const own = skill.name ?? (front && /^name:[ \t]*(.*)$/m.exec(front[1]!)?.[1]?.trim());
  return [...new Set([...header, ...called])].filter(name => name !== own);
}

/** Whether a skill adds to the dialogue pass, so its command asks for one. */
export function extendsDialoguePass(skill: Skill) {
  return skill.enabled && !isDialogueGuide(skill) && skillExtends(skill).some(firstCutName);
}

export function isDialogueGuide(skill: Skill) {
  return firstCutName(skill.name) && (skill.bundledName === skill.name ||
    (!skill.bundledName && (skill.source === "bundled" || skill.source === "seed")));
}

type DialogueOperation = NonNullable<Task["context"]["dialogueOperation"]>;

/** A custom entry owns its command name even when disabled. The shipped guide is optional advice for the product shortcut. */
export function dialogueShortcut(name: string, library: readonly Skill[]): DialogueOperation | undefined {
  const entry = library.find(skill => skill.name === name);
  if (entry && extendsDialoguePass(entry)) return "first-cut";
  if (!firstCutName(name) && name !== "tighten-pauses-here") {
    if (entry?.enabled && firstCutName(entry.bundledName)) return "first-cut";
    return;
  }
  if (entry && !isDialogueGuide(entry)) return;
  return name === "tighten-pauses-here" ? "local-pauses" : "first-cut";
}

/** Resolve the last explicit product shortcut against the library at the time the editor sent it. */
export function dialogueCommand(text: string, library: readonly Skill[] = []): DialogueOperation | undefined {
  let chosen: DialogueOperation | undefined;
  for (const { name } of skillCommands(text)) chosen = dialogueShortcut(name, library) ?? chosen;
  return chosen;
}

/** Older tasks can lack a recorded operation. Their message and subsequent editor answers identify the shortcut. */
export function taskDialogueOperation(task: Pick<Task, "context" | "instruction">, answers: readonly string[] = [], library: readonly Skill[] = []): DialogueOperation {
  if (task.context.dialogueOperation !== undefined) return task.context.dialogueOperation;
  let chosen = dialogueCommand(task.context.message ?? task.instruction, library) ?? "none";
  for (const answer of answers) chosen = dialogueCommand(answer, library) ?? chosen;
  return chosen;
}

export function taskRunKind(task: Pick<Task, "context" | "instruction">): RunKind | undefined {
  if (task.context.cutIndex !== undefined) return "cut";
  if (task.context.editIndex === undefined && taskDialogueOperation(task) !== "none") return "pass";
}
