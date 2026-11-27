/** Skill slash-command parsing and dialogue shortcut resolution. */
import type { Skill } from "./skills.js";
import type { Task } from "./tasks.js";

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

type DialogueOperation = NonNullable<Task["context"]["dialogueOperation"]>;

/**
 * Scarlet's own commands. Each starts one of the engine's operations whether or not any skill guides it, so deleting,
 * renaming or rewriting a skill never takes the operation away, and a skill another editor writes from scratch works
 * the same as the one Scarlet ships. A skill attaches to a command in its own words: going by the command's name, or
 * naming it under `runs:` in its header, it is that command's guide, and calling it in its text (`/name`, or
 * `extends:`) its own command starts the same operation. Code knows a skill only by what its file says, never by its name: this list is the engine's, and the one
 * place a command's name is written.
 */
export const BUILT_IN_COMMANDS: ReadonlyArray<{ name: string; operation: Exclude<DialogueOperation, "none">; description: string }> = [
  { name: "dialogue-pass", operation: "first-cut", description: "Make a first dialogue cut of the edit, or of the selected passage." },
  { name: "tighten-pauses-here", operation: "local-pauses", description: "Tighten only pauses in the selected passage or around the playhead." },
];

const builtIn = (name: string) => BUILT_IN_COMMANDS.find(command => command.name === name);

/** The built-in command that starts an operation. */
export function builtInCommand(operation: Exclude<DialogueOperation, "none">) {
  return BUILT_IN_COMMANDS.find(command => command.operation === operation)!;
}

/** A list in a skill's header (`key: a, b`, or `[a, b]`), as command names. */
function headerList(content: string, key: string): string[] {
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  const value = front && new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(front[1]!)?.[1]?.trim().replace(/^\[|\]$/g, "");
  return (value ?? "").split(",").map(name => name.trim().replace(/^["']|["']$/g, "").replace(/^\//, "").toLowerCase()).filter(Boolean);
}

/** The built-in commands a skill guides, from `runs:` in its header. */
export function skillRuns(skill: Pick<Skill, "content">): string[] {
  return headerList(skill.content, "runs").filter(name => builtIn(name));
}

/** The enabled skills that guide a built-in command. */
export function commandGuides(command: string, library: readonly Skill[]): Skill[] {
  return library.filter(skill => skill.enabled && skillRuns(skill).includes(command));
}

/**
 * The guides a skill builds on, in the order it names them. It names one by calling it in its text, `/name`, at the
 * place it applies, with what it changes written beside the call; or in its header, `extends: name`, several with
 * commas between them. An editor's own style ("cut my joins tighter, frame my demos my way") then runs with the guides
 * it adds to, and their later improvements reach it, instead of a copy of each guide drifting apart from it. A name is
 * a guide when the library has a skill by it, or a built-in command, which the caller checks.
 */
export function skillExtends(skill: Pick<Skill, "content"> & Partial<Pick<Skill, "name">>): string[] {
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(skill.content);
  const header = headerList(skill.content, "extends");
  // A call in the text: a whole word after a space or an opening bracket, so a path or a name in code isn't one.
  const body = skill.content.slice(front?.[0].length ?? 0);
  const called = Array.from(body.matchAll(/(?:^|[\s(])\/([a-z0-9][a-z0-9-]*)(?=[\s.,;:!?)]|$)/gim), match => match[1]!.toLowerCase());
  const own = skill.name ?? (front && /^name:[ \t]*(.*)$/m.exec(front[1]!)?.[1]?.trim());
  return [...new Set([...header, ...called])].filter(name => name !== own);
}

/**
 * The operation a skill's own command starts: the command it guides, else the one a guide or command it builds on
 * starts, followed through the library.
 */
export function skillOperation(skill: Skill, library: readonly Skill[], seen = new Set<string>()): DialogueOperation | undefined {
  seen.add(skill.id);
  const own = skillRuns(skill)[0];
  if (own) return builtIn(own)!.operation;
  for (const base of skillExtends(skill)) {
    const guide = library.find(s => s.name === base && s.enabled && !seen.has(s.id));
    const operation = (guide && skillOperation(guide, library, seen)) || builtIn(base)?.operation;
    if (operation) return operation;
  }
}

/**
 * The operation a command starts. Scarlet's own command names are reserved: typed, one always starts its operation,
 * with whatever skill guides it (one by the same name, or one whose header `runs:` it) or none. Any other name is a
 * skill's, switched on, and starts what that skill's header and calls say.
 */
export function dialogueShortcut(name: string, library: readonly Skill[]): DialogueOperation | undefined {
  const command = builtIn(name);
  if (command) return command.operation;
  const entry = library.find(skill => skill.name === name);
  return entry?.enabled ? skillOperation(entry, library) : undefined;
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
