import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Skill } from "@scarlet/shared";
import { createProject, emptyTimeline, type Change } from "@scarlet/timeline";
import { buildSystemPrompt, PLAN_STEPS, SCARLET_INTRO, stripFrontmatter } from "./prompt.js";

const skill = (over: Partial<Skill> = {}): Skill => ({ id: "skl_house", name: "house-style", description: "Our house rules for interviews.",
  content: "---\nname: house-style\ndescription: Our house rules for interviews.\n---\n# House style\n\nNever cut laughter.", scope: "team", ownerId: null,
  projectId: null, agents: [], enabled: true, version: 2, ...over });

it("keeps dialogue take-selection advice in the selected skill", () => {
  const advice = "A retake can begin just beyond the passage";
  const project = "Captioning project.";
  const caption = buildSystemPrompt({ project, skills: [skill({ content: "Set captions in sentence case." })] });
  expect(caption).toContain("only saved edits kept");
  expect(caption).not.toMatch(/retake can|better version may come later|a passage of a few minutes/i);
  const dialogue = readFileSync(new URL("../../../skills/dialogue-pass/SKILL.md", import.meta.url), "utf8");
  expect(buildSystemPrompt({ project, skills: [skill({ name: "dialogue-pass", content: dialogue })] })).toContain(advice);
});

describe("the prompt for revising a skill", () => {
  it("is about the skill alone: its description and instructions as they stand, then what an editing agent is told", () => {
    const prompt = buildSystemPrompt({ project: "A project the task only borrows.", editSkill: skill(), skills: [skill({ id: "other", name: "other-skill", content: "Other brief." })],
      task: { kind: "skill_edit", instruction: "Keep the laughs, cut the coughs.", agent: "claude", context: { skillId: "skl_house" } } });
    expect(prompt.startsWith("# You are revising a skill in Scarlet")).toBe(true);
    expect(prompt).toContain("# The skill: house-style\n\n## Description\n\nAgents read this line to decide when the skill applies.\n\nOur house rules for interviews.\n\n## Instructions\n\n# House style\n\nNever cut laughter.");
    // The header is Scarlet's to keep, so the model never sees it.
    expect(prompt).not.toContain("name: house-style\n");
    // Scarlet's own guide closes the prompt, for reference.
    expect(prompt.endsWith(SCARLET_INTRO)).toBe(true);
    // No project and no other skill is in it.
    expect(prompt).not.toContain("A project the task only borrows.");
    expect(prompt).not.toContain("Other brief.");
    expect(prompt).not.toContain("# Your task");
  });

  it("has an approved rule worked into the whole skill, rewriting what it contradicts, and an editor's own change kept to what they asked", () => {
    const learned = buildSystemPrompt({ project: "", editSkill: skill(), skills: [],
      task: { kind: "skill_edit", instruction: "Work this standing rule into the skill: “Cut a laugh short.”", agent: "claude", context: { skillId: "skl_house", learningId: "lrn_1" } } });
    expect(learned).toContain("Read the whole skill and revise it so the rule is part of it rather than added on");
    expect(learned).toContain("take out approved passages it contradicts or repeats, so the skill says one thing.");
    // A conflict the editor wasn't shown, or any other question, goes back to them beside the rule before anything
    // changes. Learnings has no message box, so the save has no question to ask.
    expect(learned).toContain("If the skill says otherwise somewhere they weren’t shown, or anything else needs their decision, save nothing and end by quoting what it says and asking");
    expect(learned).not.toContain("- `task_question`");
    expect(learned).toContain("telling the editor what you changed, quoting anything the rule replaced.");
    const asked = buildSystemPrompt({ project: "", editSkill: skill(), skills: [],
      task: { kind: "skill_edit", instruction: "Keep the laughs.", agent: "claude", context: { skillId: "skl_house" } } });
    expect(asked).toContain("Change what it asks for and leave the rest of the skill as they have it.");
    expect(asked).toContain("telling the editor what you changed. If the request");
    expect(asked).toContain("- `task_question` hands a decision to the editor");
    for (const absent of ["revise it so the rule is part of it", "quoting anything the rule replaced"]) expect(asked).not.toContain(absent);
  });

  it("says when the skill has no description or instructions yet, and carries the editor's earlier answers", () => {
    const prompt = buildSystemPrompt({ project: "", editSkill: skill({ description: "  ", content: "---\nname: house-style\n---\n" }), skills: [],
      qa: [{ question: " Which interviews? ", answer: " The long ones. " }] });
    expect(prompt).toContain("## Description\n\nAgents read this line to decide when the skill applies.\n\n(none)\n\n## Instructions\n\n(empty)");
    expect(prompt).toContain('1. You asked: "Which interviews?"\n   The editor answered: "The long ones."');
    expect(prompt.indexOf("# Earlier questions and answers")).toBeLessThan(prompt.indexOf(SCARLET_INTRO));
  });
});

describe("the prompt for reading a request for a standing rule", () => {
  const check = { said: "Any time I’m on camera, go full screen.", usedSkills: [], earlier: [], rules: [],
    skills: [{ id: "skl_house", name: "house-style", description: " Our house rules for interviews. " }, { id: "skl_bare", name: "bare", description: "" }] };

  it("is about the request alone: what it was about, what came before, the editor's skills and the rules Scarlet has", () => {
    const prompt = buildSystemPrompt({ project: "A project the task only borrows.", skills: [skill()], learningCheck: { ...check,
      about: "They said it about one cut Scarlet made at 2:05.", usedSkills: ["frame-screen"], earlier: ["/first-cut-dialogue", "Tighten the intro."],
      rules: [{ rule: "Never cut laughter.", skill: "house-style", state: "saved" }, { rule: "Keep the cold open.", skill: "bare", state: "offered" }] } });
    expect(prompt.startsWith("# You are listening for standing rules in Scarlet")).toBe(true);
    expect(prompt).toContain("# The request\n\nThey said it about one cut Scarlet made at 2:05.\n\nThey chose this skill for it: frame-screen.\n\n" +
      "What they asked earlier in this project, oldest first:\n- “/first-cut-dialogue”\n- “Tighten the intro.”");
    expect(prompt).toContain("# The editor’s skills\n\n- house-style (skl_house): Our house rules for interviews.\n- bare (skl_bare): no description");
    expect(prompt).toContain("# Rules Scarlet already has\n\n- “Never cut laughter.” (saved in house-style)\n- “Keep the cold open.” (offered for bare)");
    // The editor's words are the run's instruction, so the prompt doesn't repeat them. It carries no project, no skill's
    // instructions and nothing about editing.
    for (const absent of [check.said, "A project the task only borrows.", "Never cut laughter.\n", "# House style", SCARLET_INTRO, PLAN_STEPS]) expect(prompt).not.toContain(absent);
    // It reads the skill a rule goes into before offering it, so the editor sees what the rule would change, and a
    // rule the skill already has isn't offered.
    expect(prompt).toContain("read the skill it belongs in, in full, with `skills_list`, then offer the rule with `learning_suggest`");
    expect(prompt).toContain("beside what the skill says that it would change");
    expect(prompt).toContain("or the skill or a rule listed below already says it, call nothing.");
  });

  it("says when the request is the project's first, and leaves out the rules when Scarlet has none", () => {
    const prompt = buildSystemPrompt({ project: "", skills: [], learningCheck: check });
    expect(prompt).toContain("# The request\n\nIt is the first thing they asked in this project.\n\n# The editor’s skills");
    expect(prompt).not.toContain("# Rules Scarlet already has");
  });
});

describe("an editing prompt", () => {
  const project = createProject("Interview", { fps: 24 });
  project.media = [{ id: "m1", kind: "video", name: "talk.mp4", path: "talk.mp4", duration: 120, fps: 30 }];
  const base = { project: { project, timeline: emptyTimeline(project.id) }, skills: [] };
  const task = (context: Record<string, unknown>) => ({ kind: "edit" as const, instruction: "  Tighten this.  ", agent: "claude", context });

  it("names where the editor was looking: a source passage in the source's own frames, or a place on the timeline", () => {
    const source = buildSystemPrompt({ ...base, task: task({ mediaId: "m1", time: 77, end: 80.5, version: "v4" }) });
    expect(source).toContain("## Instruction\nTighten this.");
    expect(source).toContain("- Timeline version the editor was looking at: v4");
    expect(source).toContain('- Source media: m1 ("talk.mp4")');
    // 30 fps, the recording's rate: half a second is frame 15.
    expect(source).toContain("- Source position referenced: 77.00 s (1:17.00) to 80.50 s (1:20.15)");
    // On the timeline the project's 24 fps counts the frames: half a second is frame 12.
    expect(buildSystemPrompt({ ...base, task: task({ time: 80.5 }) })).toContain("- Timeline position referenced: 80.50 s (1:20.12)");
    // With nothing recorded there is no context section.
    expect(buildSystemPrompt({ ...base, task: task({}) })).not.toContain("## Context");
  });

  it("points a revision at the staged cut or the edit the editor chose", () => {
    const resumed = { ...task({ changeId: "chg_3", cutIndex: 4 }), cutConflict: { version: "changed", range: { start: 11.25, end: 12 } } };
    expect(buildSystemPrompt({ ...base, task: resumed })).toContain("On version changed, Scarlet located the passage at 11.25–12 timeline seconds.");
    const staged = buildSystemPrompt({ ...base, task: task({ changeId: "chg_3", cutIndex: 4, reviewAllCuts: true }) });
    expect(staged).toContain("- Change being revised: chg_3");
    expect(staged).toContain("- Staged cut being revised: index 4 of chg_3.");
    expect(staged).toContain("- The editor requested individual review of every cut.");
    // Replaced since the editor sent it, the pass named is told apart from the one that waits, with the cut's index there.
    expect(buildSystemPrompt({ ...base, task: task({ changeId: "chg_5", cutIndex: 2 }), replacedPass: "chg_3" })).toContain(
      "- The request names this cut in chg_3, the pass as the editor saw it. A revision or a later part of the pass replaced that pass since with chg_5, where the cut is index 2 and may have moved.");
    const edit = buildSystemPrompt({ ...base, task: task({ changeId: "chg_3", editIndex: 0 }) });
    expect(edit).toContain("- Selected edit index: 0");
    expect(edit).not.toContain("Staged cut being revised");
    // With the change at hand, the edit comes with what Scarlet told the editor about it: its name, its number in their
    // list, what it did and what to check on it. They are answering those words.
    const change = { id: "chg_3", state: "approved", description: "Frame the games", fromVersion: "ver_1", toVersion: "ver_2", ranges: [], ops: [], author: { type: "agent", name: "Scarlet" },
      timelineEdits: [{ label: "Frame the watch", range: { start: 10, end: 20 } },
        { label: " Frame the Fall Guys game ", range: { start: 181, end: 260 }, summary: "Screen zooms to the game window. ", check: "A Windows dialog sits over the game from 4:17" }] } as unknown as Change;
    const told = buildSystemPrompt({ ...base, change: { change }, task: task({ changeId: "chg_3", editIndex: 1, editNumber: 13 }) });
    expect(told).toContain(`- Selected edit index: 1 (edit 13 in the editor's list), "Frame the Fall Guys game"`);
    expect(told).toContain(`- What you told the editor this edit did: "Screen zooms to the game window."`);
    expect(told).toContain(`- What you asked the editor to check on this edit: "A Windows dialog sits over the game from 4:17"`);
    // An edit Scarlet said nothing more about is its name alone, and another change's edits are never borrowed.
    const plain = buildSystemPrompt({ ...base, change: { change }, task: task({ changeId: "chg_3", editIndex: 0 }) });
    expect(plain).toContain(`- Selected edit index: 0, "Frame the watch"`);
    expect(plain).not.toMatch(/What you told the editor|What you asked the editor/);
    expect(buildSystemPrompt({ ...base, change: { change }, task: task({ changeId: "chg_other", editIndex: 1 }) })).toContain("- Selected edit index: 1\n");
    // An index means nothing without the change it belongs to.
    expect(buildSystemPrompt({ ...base, task: task({ editIndex: 2, cutIndex: 1 }) })).not.toMatch(/Selected edit index|Staged cut being revised/);
  });

  it("gives the model the tool names its harness exposes", () => {
    expect(buildSystemPrompt({ ...base, task: task({}) })).toContain("call `mcp__scarlet__project_get`");
    for (const agent of ["codex", "gemini", "another"]) {
      expect(buildSystemPrompt({ ...base, task: { ...task({}), agent } })).not.toContain("mcp__scarlet__");
    }
  });

  it("mentions the artifact directory only to a harness that can write files there", () => {
    const withFiles = buildSystemPrompt({ ...base, workDir: "/work/task_1", capabilities: { images: true, audio: false, files: true } });
    expect(withFiles).toContain("Your task artifact directory is: /work/task_1");
    expect(buildSystemPrompt({ ...base, workDir: "/work/task_1", capabilities: { images: true, audio: false, files: false } })).not.toContain("/work/task_1");
  });

  it("asks for the agent's steps only when the caller says the run has its harness's to-do tool", () => {
    const caps = { images: true, audio: false, files: false };
    const asked = buildSystemPrompt({ ...base, task: task({}), capabilities: { ...caps, plan: true } });
    // Straight after Scarlet's contract, which asks for the opening sentence the steps follow.
    expect(asked).toContain(`${SCARLET_INTRO}\n\n${PLAN_STEPS}`);
    expect(PLAN_STEPS).toContain("before your first Scarlet tool call, lay out the steps you will take with your to-do tool");
    // Without the tool there is nothing to lay them out with. A harness's default says what it can do, not how this run
    // was launched, so a caller that names no capabilities isn't asked either, whatever the agent.
    expect(buildSystemPrompt({ ...base, task: task({}), capabilities: { ...caps, plan: false } })).not.toContain("# Your steps");
    expect(buildSystemPrompt({ ...base, task: task({}) })).not.toContain("# Your steps");
  });

  it("takes a project summary given as text, and leaves out sections that have nothing in them", () => {
    const prompt = buildSystemPrompt({ project: "Two recordings, no edit yet.", skills: [], notes: [], qa: [] });
    expect(prompt).toContain("# Project\n\nTwo recordings, no edit yet.");
    expect(prompt).not.toMatch(/# Your task|# Review notes to address|# Change being revised|# Earlier questions and answers|# Your skills/);
  });
});

describe("stripFrontmatter", () => {
  it("removes a leading YAML block, with either line ending, and nothing else", () => {
    expect(stripFrontmatter("---\nname: a\n---\nBody")).toBe("Body");
    expect(stripFrontmatter("---\r\nname: a\r\n---\r\nBody")).toBe("Body");
    expect(stripFrontmatter("Body\n---\nnot: frontmatter\n---\n")).toBe("Body\n---\nnot: frontmatter\n---\n");
    expect(stripFrontmatter("---\nnever closed")).toBe("---\nnever closed");
  });
});
