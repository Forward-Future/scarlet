import { describe, expect, it } from "vitest";
import type { Skill } from "./skills.js";
import type { Task } from "./tasks.js";
import {
  BUILT_IN_COMMANDS, builtInCommand, commandGuides, dialogueCommand, dialogueShortcut, skillCommands, skillExtends, skillOperation, skillRuns,
  taskDialogueOperation, taskRunKind,
} from "./skillCommands.js";

const skill = (name: string, content: string, overrides: Partial<Skill> = {}): Skill => ({
  id: `skl_${name}`, name, description: name, content, scope: "team", ownerId: null, projectId: null, agents: [], enabled: true, version: 1, ...overrides,
});
const header = (lines: string, body = "") => `---\n${lines}\n---\n${body}`;
const task = (instruction: string, context: Partial<Task["context"]> = {}): Pick<Task, "context" | "instruction"> => ({ instruction, context });

describe("skillCommands", () => {
  it("finds whole slash words with their places in the draft", () => {
    expect(skillCommands("/Dialogue-Pass then /tighten-pauses-here")).toEqual([
      { start: 0, end: 14, name: "dialogue-pass" },
      { start: 20, end: 40, name: "tighten-pauses-here" },
    ]);
  });

  it("counts a lone slash as an empty command and skips paths and slashes inside words", () => {
    expect(skillCommands("Type / to list")).toEqual([{ start: 5, end: 6, name: "" }]);
    expect(skillCommands("see a/b and /usr/bin and http://x")).toEqual([]);
    expect(skillCommands("")).toEqual([]);
  });
});

describe("built-in commands", () => {
  it("names the command for each operation", () => {
    expect(builtInCommand("first-cut").name).toBe("dialogue-pass");
    expect(builtInCommand("local-pauses").name).toBe("tighten-pauses-here");
    expect(BUILT_IN_COMMANDS.map(c => c.operation)).toEqual(["first-cut", "local-pauses"]);
  });
});

describe("skillRuns", () => {
  it("reads the built-in commands a skill's header says it runs, in either list form", () => {
    expect(skillRuns(skill("a", header("name: a\nruns: /Dialogue-Pass, 'tighten-pauses-here'")))).toEqual(["dialogue-pass", "tighten-pauses-here"]);
    expect(skillRuns(skill("a", header('runs: ["dialogue-pass"]')))).toEqual(["dialogue-pass"]);
    expect(skillRuns(skill("a", "---\r\nruns: dialogue-pass\r\n---\r\nbody"))).toEqual(["dialogue-pass"]);
  });

  it("ignores names that aren't Scarlet's commands, and a skill with no header", () => {
    expect(skillRuns(skill("a", header("runs: my-own, , dialogue-pass")))).toEqual(["dialogue-pass"]);
    expect(skillRuns(skill("a", "runs: dialogue-pass"))).toEqual([]);
    expect(skillRuns(skill("a", header("name: a")))).toEqual([]);
  });
});

describe("commandGuides", () => {
  it("lists only the switched-on skills that guide the command", () => {
    const on = skill("tight", header("runs: dialogue-pass"));
    const off = skill("loose", header("runs: dialogue-pass"), { enabled: false });
    const other = skill("pauses", header("runs: tighten-pauses-here"));
    expect(commandGuides("dialogue-pass", [on, off, other])).toEqual([on]);
    expect(commandGuides("dialogue-pass", [])).toEqual([]);
  });
});

describe("skillExtends", () => {
  it("collects the header's extends and the guides called in the text, once each, in order", () => {
    const content = header("name: mine\nextends: base, /other", "Run /dialogue-pass first, then (/base) again.\nAlso /trail");
    expect(skillExtends({ content })).toEqual(["base", "other", "dialogue-pass", "trail"]);
  });

  it("leaves out the skill's own name, from its record or from its header", () => {
    expect(skillExtends({ content: "See /mine and /base.", name: "mine" })).toEqual(["base"]);
    expect(skillExtends({ content: header("name: mine", "Call /mine, then /base!") })).toEqual(["base"]);
  });

  it("doesn't read paths, words in code or slashes in the header as calls", () => {
    expect(skillExtends({ content: header("description: /not-a-call", "Open src/base or `x/y` and /path/to/file") })).toEqual([]);
  });
});

describe("skillOperation", () => {
  it("starts the command a skill runs", () => {
    const s = skill("tight", header("runs: tighten-pauses-here, dialogue-pass"));
    expect(skillOperation(s, [s])).toBe("local-pauses");
  });

  it("follows a guide the skill builds on through the library", () => {
    const base = skill("base", header("runs: dialogue-pass"));
    const middle = skill("middle", header("extends: base"));
    const top = skill("top", "Like /middle but tighter.");
    expect(skillOperation(top, [base, middle, top])).toBe("first-cut");
  });

  it("starts a built-in command the skill calls in its text", () => {
    const s = skill("mine", "Do /tighten-pauses-here with longer breaths.");
    expect(skillOperation(s, [s])).toBe("local-pauses");
  });

  it("skips a switched-off guide and falls back to the next one named", () => {
    const off = skill("base", header("runs: dialogue-pass"), { enabled: false });
    const s = skill("mine", "Use /base, else /tighten-pauses-here.");
    expect(skillOperation(s, [off, s])).toBe("local-pauses");
  });

  it("stops on guides that build on each other in a loop", () => {
    const a = skill("a", "Like /b.");
    const b = skill("b", "Like /a.");
    expect(skillOperation(a, [a, b])).toBeUndefined();
  });

  it("starts nothing for a skill that names no command or guide", () => {
    const s = skill("plain", "Just make it nice, /unknown.");
    expect(skillOperation(s, [s])).toBeUndefined();
  });
});

describe("dialogueShortcut", () => {
  it("always starts a built-in command, whatever skill shares its name", () => {
    const shadow = skill("dialogue-pass", "nothing", { enabled: false });
    expect(dialogueShortcut("dialogue-pass", [shadow])).toBe("first-cut");
  });

  it("starts a switched-on skill's operation and nothing for a switched-off or unknown one", () => {
    const on = skill("tight", header("runs: tighten-pauses-here"));
    const off = skill("cold", header("runs: dialogue-pass"), { enabled: false });
    expect(dialogueShortcut("tight", [on, off])).toBe("local-pauses");
    expect(dialogueShortcut("cold", [on, off])).toBeUndefined();
    expect(dialogueShortcut("missing", [on, off])).toBeUndefined();
  });
});

describe("dialogueCommand", () => {
  it("resolves the last command that starts an operation", () => {
    expect(dialogueCommand("/dialogue-pass then /tighten-pauses-here")).toBe("local-pauses");
    expect(dialogueCommand("/tighten-pauses-here then /nothing")).toBe("local-pauses");
    expect(dialogueCommand("no commands")).toBeUndefined();
  });

  it("resolves a skill's command against the library given", () => {
    const s = skill("tight", header("runs: dialogue-pass"));
    expect(dialogueCommand("Please /tight", [s])).toBe("first-cut");
    expect(dialogueCommand("Please /tight")).toBeUndefined();
  });
});

describe("taskDialogueOperation", () => {
  it("keeps a recorded operation over the words", () => {
    expect(taskDialogueOperation(task("/dialogue-pass", { dialogueOperation: "none" }), ["/tighten-pauses-here"])).toBe("none");
  });

  it("reads the editor's own message before the expanded instruction, then each answer after it", () => {
    expect(taskDialogueOperation(task("History /tighten-pauses-here", { message: "/dialogue-pass" }))).toBe("first-cut");
    expect(taskDialogueOperation(task("/dialogue-pass"), ["yes", "/tighten-pauses-here", "ok"])).toBe("local-pauses");
    expect(taskDialogueOperation(task("Add captions"))).toBe("none");
  });

  it("resolves skill commands in answers against the library", () => {
    const s = skill("tight", header("runs: tighten-pauses-here"));
    expect(taskDialogueOperation(task("Add captions"), ["/tight"], [s])).toBe("local-pauses");
  });
});

describe("taskRunKind", () => {
  it("names a request about an edit, even a pass command, as having no kind", () => {
    expect(taskRunKind(task("/dialogue-pass", { editIndex: 0 }))).toBeUndefined();
  });
});
