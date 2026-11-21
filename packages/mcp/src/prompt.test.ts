import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Skill } from "@scarlet/shared";
import { createProject, emptyTimeline, makeMediaClip, type Change } from "@scarlet/timeline";
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

it("reads an editor's style after the guide it builds on, and has it win where they differ", () => {
  const guide = skill({ id: "skl_dp", name: "dialogue-pass", content: "---\nname: dialogue-pass\ndescription: Cut dialogue.\n---\nAbout a quarter second at a join." });
  const style = skill({ id: "skl_me", name: "my-style", content: "---\nname: my-style\ndescription: Mine.\nextends: dialogue-pass\n---\nA tenth of a second at a join." });
  const prompt = buildSystemPrompt({ project: "A project.", skills: [guide, style] });
  expect(prompt.indexOf("## dialogue-pass")).toBeLessThan(prompt.indexOf("## my-style"));
  expect(prompt).toContain("This builds on dialogue-pass, above. Where the two differ, follow this one.");
  // A style can build on several guides: each is read first, and the ones that aren't in the prompt go unmentioned.
  const framing = skill({ id: "skl_fs", name: "frame-screen", content: "---\nname: frame-screen\ndescription: Frame the screen.\n---\nFill the video." });
  const both = skill({ id: "skl_all", name: "my-edit", content: "---\nname: my-edit\ndescription: Mine.\nextends: dialogue-pass, frame-screen, punch-in\n---\nMy camera sits bottom right." });
  expect(buildSystemPrompt({ project: "A project.", skills: [guide, framing, both] }))
    .toContain("This builds on dialogue-pass and frame-screen, above. Where it and one of them differ, follow this one.");
  // A guide can be called in the text where it applies, with no header: it reads the same, and says how it is called.
  const inline = skill({ id: "skl_in", name: "my-demo", content: "---\nname: my-demo\ndescription: Mine.\n---\n## Show the demo\n\n/frame-screen, with these changes: my camera sits bottom right." });
  const called = buildSystemPrompt({ project: "A project.", skills: [framing, inline] });
  expect(called.indexOf("## frame-screen")).toBeLessThan(called.indexOf("## my-demo"));
  expect(called).toContain("This builds on frame-screen, above, and calls each as /name where it applies, with what it changes beside the call. Where the two differ, follow this one.");
  // Alone, it says nothing about a guide that isn't there.
  expect(buildSystemPrompt({ project: "A project.", skills: [style] })).not.toContain("builds on");
});

it("nests a skill's own headings under its name, so its title doesn't read as one of the prompt's sections", () => {
  const titled = skill({ content: "---\nname: house-style\n---\n# House style\n\nNever cut laughter.\n\n## Pace\n\nKeep it brisk.\n\n```md\n# Not a heading\n## Nor this\n```\n\n~~~\n# Nor this one\n~~~\n\n    # Indented code stays\n#hashtag stays" });
  const prompt = buildSystemPrompt({ project: "A project.", skills: [titled] });
  expect(prompt).toContain("## house-style\n\nOur house rules for interviews.\n\n### House style\n\nNever cut laughter.\n\n#### Pace\n\nKeep it brisk.\n\n```md\n# Not a heading\n## Nor this\n```\n\n~~~\n# Nor this one\n~~~\n\n    # Indented code stays\n#hashtag stays");
  // Outside the skill's code, the prompt's own sections are the only top-level headings.
  expect(prompt.match(/^# .*/gm)).toEqual(["# You are editing a video in Scarlet", "# Project", "# Your skills", "# Not a heading", "# Nor this one"]);
  // A skill that starts a level down nests the same way, and the deepest heading Markdown has is as deep as it goes.
  const sections = skill({ content: "## Show the demo\n\nFrame it.\n\n###### Deep" });
  expect(buildSystemPrompt({ project: "A project.", skills: [sections] })).toContain("### Show the demo\n\nFrame it.\n\n###### Deep");
  // A skill revised in Settings is shown as written: the model saves what it reads.
  expect(buildSystemPrompt({ project: "", editSkill: titled, skills: [] })).toContain("## Instructions\n\n# House style\n\nNever cut laughter.\n\n## Pace");
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
      about: "They said it about one cut Scarlet made at 2:05.", usedSkills: ["frame-screen"],
      earlier: [{ said: "Tighten the intro." }, { said: "cut tail frames", about: "a cut first-cut-dialogue made", elsewhere: true }],
      rules: [{ rule: "Never cut laughter.", skill: "house-style", state: "saved" }, { rule: "Keep the cold open.", skill: "bare", state: "offered" }] } });
    expect(prompt.startsWith("# You are listening for standing rules in Scarlet")).toBe(true);
    expect(prompt).toContain("# The request\n\nThey said it about one cut Scarlet made at 2:05.\n\nThey chose this skill for it: frame-screen.\n\n" +
      "What they asked before, oldest first:\n- “Tighten the intro.”\n- “cut tail frames” (about a cut first-cut-dialogue made) (in another video)");
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
    // A correction the editor keeps making to one skill's cuts is a rule for that skill, though each was about one cut.
    expect(prompt).toContain("When their earlier requests keep asking for the same kind of fix to what a skill made, that fix is how they want the skill to work.");
    // A rule is the principle, never the case it came from.
    expect(prompt).toContain("write the principle behind what they said, not its instances: no words, names, times or moments from this video or the requests");
  });

  it("says when the request is the project's first, and leaves out the rules when Scarlet has none", () => {
    const prompt = buildSystemPrompt({ project: "", skills: [], learningCheck: check });
    expect(prompt).toContain("# The request\n\nIt is the first thing they asked.\n\n# The editor’s skills");
    expect(prompt).not.toContain("# Rules Scarlet already has");
  });
});

describe("the prompt for looking at one frame", () => {
  it("says what to look at, what the box holds and when it is done, and leaves the box's units to screen_area", () => {
    const prompt = buildSystemPrompt({ project: "A project the check only borrows.", skills: [skill()], areaCheck: { mediaId: "med_screen", at: 42.5 },
      capabilities: { images: true, audio: false, files: false, toolPrefix: "mcp__scarlet__" } });
    expect(prompt.startsWith("# You are looking at one frame of a screen recording for Scarlet, a video editor")).toBe(true);
    expect(prompt).toContain("Look yourself at the frame of recording `med_screen` at 42.5 s, 1920 pixels wide.");
    expect(prompt).toContain("Decide the box that holds only the window being presented");
    expect(prompt).toContain("Save that box with `mcp__scarlet__screen_area` as the one area of `med_screen` at 42.5 s. Then stop: no other frames, no edits");
    // screen_area sends an area check no pictures unless asked, so the prompt doesn't name the parameter.
    for (const absent of ["[left, top, right, bottom]", "in percent", "decimal place", "`set`", "`pictures`", "media_frame", "A project the check only borrows.", "Never cut laughter."]) expect(prompt).not.toContain(absent);
  });
});

describe("an editing prompt", () => {
  const project = createProject("Interview", { fps: 24 });
  project.media = [{ id: "m1", kind: "video", name: "talk.mp4", path: "talk.mp4", duration: 120, fps: 30 }];
  const base = { project: { project, timeline: emptyTimeline(project.id) }, skills: [] };
  const task = (context: Record<string, unknown>) => ({ kind: "edit" as const, instruction: "  Tighten this.  ", agent: "claude", context });

  it("has a dialogue pass order its cuts by how likely each is to be wrong and flag as many as the editor's setting asks", () => {
    const pass = (checkIn?: "less" | "balanced" | "more") => buildSystemPrompt({ ...base, checkIn,
      task: { kind: "edit" as const, instruction: "/dialogue-pass", agent: "claude", context: { dialogueOperation: "first-cut" as const } } });
    const asked = (prompt: string) => prompt.match(/- Before the pass is done, .* The editor asked to check (.*) of them: flag that many from the top of your order/)?.[1];
    // The order is the model's. How far down it the editor is asked to look is theirs, and balanced when they haven't said.
    expect(pass()).toContain("order those cuts from the most likely to be wrong to the least");
    expect([pass(), pass("less"), pass("balanced"), pass("more")].map(asked)).toEqual(["about one in four", "about one in ten", "about one in four", "about half"]);
    // A request about one cut or edit of the pass, a pause tightening and any other edit are not asked.
    for (const context of [{ dialogueOperation: "first-cut", cutIndex: 0, changeId: "chg_1" }, { dialogueOperation: "first-cut", editIndex: 2 }, { dialogueOperation: "local-pauses" }, {}])
      expect(buildSystemPrompt({ ...base, checkIn: "more", task: task(context) })).not.toContain("Before the pass is done");
  });

  it("names where the editor was looking: a source passage in the source's own frames, or a place on the timeline", () => {
    const source = buildSystemPrompt({ ...base, task: task({ mediaId: "m1", time: 77, end: 80.5, version: "v4" }) });
    expect(source).toContain("- Timeline version the editor was looking at: v4");
    expect(source).toContain('- Source media: m1 ("talk.mp4")');
    // 30 fps, the recording's rate: half a second is frame 15.
    expect(source).toContain("- Source position referenced: 77.00 s (1:17.00) to 80.50 s (1:20.15)");
    // On the timeline the project's 24 fps counts the frames: half a second is frame 12.
    expect(buildSystemPrompt({ ...base, task: task({ time: 80.5 }) })).toContain("- Timeline position referenced: 80.50 s (1:20.12)");
    // A stretch marked on the ruler with an edit open is said besides the edit's own place, on the version it was marked on.
    const marked = buildSystemPrompt({ ...base, task: task({ time: 10, end: 12, markedRange: { start: 42, end: 51.5, version: "v5" } }) });
    expect(marked).toContain("- Timeline position referenced: 10.00 s (0:10.00) to 12.00 s (0:12.00)");
    expect(marked).toContain("- Stretch the editor marked on the timeline: 42.00 s (0:42.00) to 51.50 s (0:51.12) on version v5");
    // A message to an open edit written while the video was paused says the frame it stopped on and its version.
    const stopped = buildSystemPrompt({ ...base, task: task({ changeId: "chg1", time: 32, end: 37.3, messageTime: { time: 37.5, version: "v5" } }) });
    expect(stopped).toContain("- Where the editor stopped the video as they wrote this: timeline 37.50 s (0:37.12) on version v5");
    // Marked with nothing open it is the position itself, said once.
    expect(buildSystemPrompt({ ...base, task: task({ time: 42, end: 51.5, markedRange: { start: 42, end: 51.5 } }) })).not.toContain("Stretch the editor marked");
    // With nothing recorded there is no context section.
    expect(buildSystemPrompt({ ...base, task: task({}) })).not.toContain("## Context");
  });

  it("lists a long timeline's clips only near where the request points", () => {
    const timeline = emptyTimeline(project.id);
    timeline.tracks[0]!.clips = Array.from({ length: 60 }, (_, i) => makeMediaClip("m1", i * 2, i * 2 + 2, i * 2, { id: `c${i}` }));
    const near = buildSystemPrompt({ ...base, project: { project, timeline }, task: task({ time: 60, end: 62 }) });
    expect(near).toContain("c30 ");
    expect(near).not.toContain("c0 ");
    expect(near).toContain("Listed: the clips within 15 s of 1:00.00–1:02.00, of 60. `timeline_get` lists every clip");
    const whole = buildSystemPrompt({ ...base, project: { project, timeline }, task: task({}) });
    expect(whole).not.toContain("c30 ");
    expect(whole).toContain("The 60 clips aren't listed here");
    // A short timeline is listed whole.
    timeline.tracks[0]!.clips = timeline.tracks[0]!.clips.slice(0, 10);
    expect(buildSystemPrompt({ ...base, project: { project, timeline }, task: task({ time: 60 }) })).toContain("c0 ");
  });

  it("tells a request about one cut or edit where that one is, and the whole change's ranges and diff only to a request about all of it", () => {
    const cuts = [{ start: 10, end: 11 }, { start: 20, end: 21.5 }, { start: 21.5, end: 22 }, { start: 40, end: 41 }];
    const change = { id: "chg_3", projectId: project.id, fromVersion: "v1", toVersion: "v2", description: "Review 3 optional dialogue cuts", author: { type: "agent", name: "codex" },
      noteIds: [], ranges: [{ start: 9.5, end: 10.5 }, { start: 18.5, end: 19.5 }, { start: 36, end: 37 }], state: "revising", renders: [],
      cutReasons: cuts.map(c => ({ ...c, reason: "A restart." })), cutAssessments: [{ index: 2, start: 40.2, end: 41, verdict: "ask", reason: "Is it meant?" }],
      timelineEdits: [{ label: "Cut the cough", range: { start: 10, end: 10 } }, { label: "Frame the demo", range: { start: 30, end: 45 } }] } as unknown as Change;
    const pass = { change, description: ["Moved 200 clips along the timeline with nothing else changed (now 1.00–600.00)"] };
    // A staged cut is numbered as the review numbers them, touching cuts as one, on the pass's base version.
    const cut = buildSystemPrompt({ ...base, change: pass, task: task({ changeId: "chg_3", cutIndex: 1 }) });
    expect(cut).toContain("From version v1 to v2\nRange of this cut: 20.00–22.00 s on version v1");
    expect(buildSystemPrompt({ ...base, change: pass, task: task({ changeId: "chg_3", cutIndex: 2 }) })).toContain("Range of this cut: 40.20–41.00 s on version v1");
    const edit = buildSystemPrompt({ ...base, change: pass, task: task({ changeId: "chg_3", editIndex: 1 }) });
    expect(edit).toContain("From version v1 to v2\nRange of this edit: 30.00–45.00 s\n");
    for (const one of [cut, edit]) {
      expect(one).not.toContain("Affected ranges");
      expect(one).not.toContain("9.50–10.50 s");
      expect(one).not.toContain("Diff:");
    }
    // An edit the change doesn't have is said by its index alone, with no range to guess.
    expect(buildSystemPrompt({ ...base, change: pass, task: task({ changeId: "chg_3", editIndex: 7 }) })).not.toMatch(/Range of this|Affected ranges/);
    const whole = buildSystemPrompt({ ...base, change: pass, task: task({ changeId: "chg_3" }) });
    expect(whole).toContain("Affected ranges: 9.50–10.50 s, 18.50–19.50 s, 36.00–37.00 s\nDiff:\n- Moved 200 clips");
    expect(whole).not.toContain("Range of this");
  });

  it("asks for a reason for every edit and puts the summary in the chat", () => {
    const prompt = buildSystemPrompt({ ...base, task: task({}) });
    expect(prompt).toContain("Always save why you made each edit, even when the editor asked for the exact change.");
    expect(prompt).toContain("Scarlet shows the short summary of what changed in the chat and the reason on the card above the timeline.");
  });

  it("says where the opening sentence shows, and no longer that the editor sees steps", () => {
    // Since 2026-11-10 the chat shows the sentence under the request and one line of what Scarlet is doing, no steps.
    expect(SCARLET_INTRO).toContain("Scarlet shows that sentence under the editor’s request for as long as you work, so it is about the whole request");
    expect(SCARLET_INTRO).not.toContain("steps");
    expect(PLAN_STEPS).not.toContain("shows the editor");
    expect(PLAN_STEPS).toContain("Scarlet records that list and gives it back to you if the run has to start again");
  });

  it("leaves how a tool works to the tool's description: Scarlet's contract and the context say what, not how", () => {
    // Each of these is in the tool's own description.
    for (const told of ["accepts typed operations or a replacement timeline", "Transcript word times are approximate", "to feedback with `noteIds`",
      "pauses the task; the answer comes back as your next message", "`render_request`"]) expect(SCARLET_INTRO).not.toContain(told);
    // What only the contract says stays.
    expect(SCARLET_INTRO).toContain("A revision can link to its prior change and spot with `replaces`.");
    expect(SCARLET_INTRO).toContain("a decision you need goes to `task_question`");
    // A note's id is listed with the note; the context names only one the prompt doesn't list, and nothing says how to pass it.
    const note = { id: "n1", projectId: project.id, version: "v1", time: 3, clipIds: [], text: "Too long", author: { type: "human" as const, name: "Matt" }, state: "open" as const };
    const change = { id: "chg_3", projectId: project.id, fromVersion: "v1", toVersion: "v2", description: "Cut pause", author: { type: "agent", name: "codex" },
      noteIds: [], ranges: [], state: "revising", renders: [] } as unknown as Change;
    const noted = buildSystemPrompt({ ...base, notes: [note], change: { change }, task: task({ noteIds: ["n1", "n_gone"], changeId: "chg_3" }) });
    expect(noted).toContain("- Note n1 [open] by Matt");
    expect(noted).toContain("- Note ids to address: n_gone\n");
    expect(noted).not.toMatch(/as noteIds|Reference the note ids/);
    expect(buildSystemPrompt({ ...base, notes: [note], task: task({ noteIds: ["n1"] }) })).not.toContain("Note ids to address");
    // The first short's run is told what to choose; `shorts_plan` says how and when it is saved.
    const short = { index: 1, count: 3, sourceName: "Weekly interview", sourceProjectId: "prj_long", sourceVersion: "ver_9", maxSeconds: 60, captions: true, aspect: "9:16" };
    const first = buildSystemPrompt({ ...base, task: task({ short }) });
    expect(first).toContain("- You choose the moments for all 3 shorts from the whole edit. This project takes the first.");
    expect(first).not.toContain("shorts_plan");
  });

  it("points a revision at the staged cut or the edit the editor chose", () => {
    const resumed = { ...task({ changeId: "chg_3", cutIndex: 4 }), cutConflict: { version: "changed", range: { start: 11.25, end: 12 } } };
    expect(buildSystemPrompt({ ...base, task: resumed })).toContain("On version changed, Scarlet located the passage at 11.25–12 timeline seconds.");
    const staged = buildSystemPrompt({ ...base, task: task({ changeId: "chg_3", cutIndex: 4, reviewAllCuts: true }) });
    expect(staged).toContain("- Change being revised: chg_3");
    expect(staged).toContain("- Staged cut being revised: index 4 of chg_3.\n");
    expect(staged).toContain("- The editor requested individual review of every cut.");
    // Which cut, said once: the tool that moves it says how, and the change below doesn't name it again.
    const pass = { id: "chg_3", projectId: project.id, fromVersion: "v1", toVersion: "v2", description: "Review 7 optional dialogue cuts", author: { type: "agent", name: "codex" },
      noteIds: [], ranges: [], state: "ready", renders: [] } as unknown as Change;
    const named = buildSystemPrompt({ ...base, change: { change: pass }, task: task({ changeId: "chg_3", cutIndex: 4 }) });
    expect(named).not.toMatch(/dialogue_revise_cut|one staged cut of this pending pass|Revise it by proposing/);
    // Replaced since the editor sent it, the pass named is told apart from the one that waits, with the cut's index there.
    expect(buildSystemPrompt({ ...base, task: task({ changeId: "chg_5", cutIndex: 2 }), replacedPass: "chg_3" })).toContain(
      "- The request names this cut in chg_3, the pass as the editor saw it. A revision or a later part of the pass replaced that pass since with chg_5, where the cut is index 2 and may have moved.");
    const edit = buildSystemPrompt({ ...base, task: task({ changeId: "chg_3", editIndex: 0 }) });
    expect(edit).toContain("- Selected edit index: 0");
    expect(edit).not.toContain("Staged cut being revised");
    // With the change at hand, the edit comes with what Scarlet told the editor about it: its name, its number in their
    // list, what it did, why and what to check on it. They are answering those words.
    const change = { id: "chg_3", state: "approved", description: "Frame the games", fromVersion: "ver_1", toVersion: "ver_2", ranges: [], ops: [], author: { type: "agent", name: "Scarlet" },
      timelineEdits: [{ label: "Frame the watch", range: { start: 10, end: 20 } },
        { label: " Frame the Fall Guys game ", range: { start: 181, end: 260 }, summary: "Screen zooms to the game window. ",
          reason: " The score was too small to read as you called it out. ", check: "A Windows dialog sits over the game from 4:17" }] } as unknown as Change;
    const told = buildSystemPrompt({ ...base, change: { change }, task: task({ changeId: "chg_3", editIndex: 1, editNumber: 13 }) });
    expect(told).toContain(`- Selected edit index: 1 (edit 13 in the editor's list), "Frame the Fall Guys game"`);
    expect(told).toContain(`- What you told the editor this edit did: "Screen zooms to the game window."`);
    expect(told).toContain(`- Why you made this edit: "The score was too small to read as you called it out."`);
    expect(told).toContain(`- What you asked the editor to check on this edit: "A Windows dialog sits over the game from 4:17"`);
    // An edit Scarlet said nothing more about is its name alone, and another change's edits are never borrowed.
    const plain = buildSystemPrompt({ ...base, change: { change }, task: task({ changeId: "chg_3", editIndex: 0 }) });
    expect(plain).toContain(`- Selected edit index: 0, "Frame the watch"`);
    expect(plain).not.toMatch(/What you told the editor|Why you made this edit|What you asked the editor/);
    expect(buildSystemPrompt({ ...base, change: { change }, task: task({ changeId: "chg_other", editIndex: 1 }) })).toContain("- Selected edit index: 1\n");
    // An index means nothing without the change it belongs to.
    expect(buildSystemPrompt({ ...base, task: task({ editIndex: 2, cutIndex: 1 }) })).not.toMatch(/Selected edit index|Staged cut being revised/);
  });

  it("tells a revision of a moment every edit in it", () => {
    const told = buildSystemPrompt({ ...base, task: task({ changeId: "chg_3", editIndex: 0, time: 29.2, end: 33.5,
      momentEdits: [{ changeId: "chg_3", spot: 1, label: "Rubik's Cube inset" }, { changeId: "chg_4", spot: 0 }] }) });
    expect(told).toContain(`- The editor's words are about the whole moment this edit is in, which plays as one change and also has: edit index 1 of chg_3 ("Rubik's Cube inset"); edit index 0 of chg_4. Which of them the words mean is for you to work out.`);
    expect(buildSystemPrompt({ ...base, task: task({ changeId: "chg_3", editIndex: 0 }) })).not.toContain("whole moment");
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
