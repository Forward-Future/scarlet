import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import { BUNDLED_SKILLS } from "../bundledSkills.js";
import { Db, migrate } from "../db.js";
import { migrateQuickActions } from "./migrateQuickActions.js";
import { assistantSkills, createSkill, deleteSkill, retireMergedSkills, reviseSkillContent, seedSkillList, updateSkill } from "./skills.js";
import { createTask } from "./tasks.js";

const text = (body: string, description = "Make a first dialogue pass.") =>
  `---\nname: first-cut-dialogue\ndescription: ${description}\n---\n\n# First Dialogue Cut\n\n${body}\n`;
const shipped = text("Cut false starts.");
const next = text("Cut false starts and long pauses.", "Make a first dialogue edit.");
const editor = { id: "usr_1", name: "Editor" } as Parameters<typeof updateSkill>[1];

it("keeps a skill's name and other header fields when its description and instructions are revised", () => {
  const draft = { description: "Cut: fast", instructions: "\nNew body.\n" };
  expect(reviseSkillContent({ name: "a-skill", content: "---\nname: old-name\ndescription: >\n  A long line\n  that runs on.\ncategory: Sound\n---\n\nOld body.\n" }, draft))
    .toBe('---\nname: a-skill\ndescription: "Cut: fast"\ncategory: Sound\n---\n\nNew body.\n');
  expect(reviseSkillContent({ name: "a-skill", content: "No header." }, draft)).toBe('---\nname: a-skill\ndescription: "Cut: fast"\n---\n\nNew body.\n');
  // A description the revision didn't change keeps its line as written.
  expect(reviseSkillContent({ name: "a-skill", content: "---\nname: a-skill\ncategory: Sound\ndescription: Keep it short.\n---\nOld." }, { description: "Keep it short.", instructions: "New." }))
    .toBe("---\nname: a-skill\ncategory: Sound\ndescription: Keep it short.\n---\n\nNew.\n");
});

describe("the skills Scarlet comes with", () => {
  let dataDir: string;
  let app: ScarletApp;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "scarlet-skills-"));
    app = createApp({ dataDir, skillsSeedDir: join(dataDir, "none"), env: {}, log: () => {} });
  });
  afterEach(async () => {
    await app.ctx.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const seed = (content: string) => seedSkillList(app.ctx, [{ folder: "first-cut-dialogue", content }]);
  const saved = () => app.ctx.repos.skills.select("name = ?", ["first-cut-dialogue"])[0]!;
  const publicGuide = () => app.ctx.repos.skills.select("name = ?", ["dialogue-pass"])[0];
  const upgrade = async () => {
    await app.ctx.close();
    app = createApp({ dataDir, env: {}, log: () => {} });
  };

  it("adds each one once, as an ordinary skill", async () => {
    const fresh = createApp({ dataDir: join(dataDir, "fresh"), env: {}, log: () => {} });
    try {
      const skills = fresh.ctx.repos.skills.select();
      expect(skills.map(s => s.name).sort()).toEqual(BUNDLED_SKILLS.map(s => s.folder).sort());
      expect(seedSkillList(fresh.ctx, BUNDLED_SKILLS)).toBe(0);
      expect(fresh.ctx.repos.skills.select().every(s => s.version === 1)).toBe(true);
    } finally {
      await fresh.ctx.close();
    }
  });

  it("gives a copy the editor hasn't edited the text a later release ships", () => {
    expect(seed(shipped)).toBe(1);
    // Turning a skill off or rewording its description isn't an edit of what it says.
    updateSkill(app.ctx, editor, saved(), { enabled: false });
    expect(seed(next)).toBe(1);
    expect(saved()).toMatchObject({ content: next, description: "Make a first dialogue edit.", version: 2, enabled: false });
    expect(app.ctx.repos.skillVersions.list(saved().id).at(-1)).toMatchObject({ author: { type: "scarlet" } });
  });

  it("leaves a skill alone once the editor has edited it", () => {
    seed(shipped);
    const mine = text("Cut false starts. Keep breaths under a third of a second.");
    updateSkill(app.ctx, editor, saved(), { content: mine });
    expect(saved().source).toBeUndefined();
    expect(seed(next)).toBe(0);
    expect(saved()).toMatchObject({ content: mine, version: 2 });
  });

  it("leaves the editor's independently authored guide active when it has the old command name", async () => {
    const mine = text("My own rules.");
    const own = createSkill(app.ctx, editor, { name: "first-cut-dialogue", content: mine, scope: "team" });
    expect(seed(next)).toBe(0);
    await upgrade();
    expect(saved()).toEqual(own);
    expect(assistantSkills(app.ctx.repos.skills.select(), [], true).find(s => s.id === own.id)).toEqual(own);
    expect(assistantSkills(app.ctx.repos.skills.select(), [publicGuide()!.id], true)).toEqual([publicGuide()]);
  });

  it("upgrades the untouched legacy dialogue guide in place, including its pins, history and disabled state", async () => {
    seed(shipped);
    const old = updateSkill(app.ctx, editor, saved(), { enabled: false, description: "Use on interviews." });
    const run = createTask(app.ctx, { projectId: "prj_1", kind: "edit", agent: "codex", instruction: "Edit this",
      context: { skillIds: [old.id] }, createdBy: { type: "human", name: "Editor" } });
    await upgrade();
    const updated = publicGuide()!;
    expect(updated).toMatchObject({ id: old.id, name: "dialogue-pass", bundledName: "dialogue-pass", enabled: false,
      source: "bundled", description: old.description, version: old.version + 1 });
    expect(saved()).toBeUndefined();
    expect(updated.content).toEqual(BUNDLED_SKILLS.find(s => s.folder === "dialogue-pass")!.content);
    expect(app.ctx.repos.skillVersions.list(old.id).map(v => v.content)).toEqual([old.content, updated.content]);
    expect(app.ctx.repos.tasks.get(run.id)?.context.skillIds).toEqual([old.id]);
    const mirror = (name: string) => readFile(join(app.ctx.paths.skills, "team", name, "SKILL.md"), "utf8");
    await expect(mirror(old.name)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await mirror(updated.name)).toEqual(updated.content);
    await upgrade();
    expect(publicGuide()).toEqual(updated);
  });

  it("keeps the editor's original dialogue workflow and seeds a separate default across restarts", async () => {
    seed(shipped);
    const mine = updateSkill(app.ctx, editor, saved(), { content: text("A cue unique to my editorial pass.") });
    const history = app.ctx.repos.skillVersions.list(mine.id);
    await upgrade();
    const generic = publicGuide()!;
    expect(generic).toMatchObject({ name: "dialogue-pass", bundledName: "dialogue-pass", source: "bundled", version: 1 });
    expect(generic.id).not.toBe(mine.id);
    await upgrade();
    expect(publicGuide()).toEqual(generic);
    expect(saved()).toEqual(mine);
    expect(app.ctx.repos.skillVersions.list(mine.id)).toEqual(history);
    expect(await readFile(join(app.ctx.paths.skills, "team", mine.name, "SKILL.md"), "utf8")).toBe(mine.content);
    const library = app.ctx.repos.skills.select();
    expect(assistantSkills(library, [generic.id], true)).toEqual([generic]);
    expect(assistantSkills(library, [mine.id], true)).toEqual([mine]);
    expect(assistantSkills(library, [], true).find(s => s.id === mine.id)?.content).toContain("Read this workflow");
    const renamed = updateSkill(app.ctx, editor, mine, { name: "my-dialogue-cut" });
    expect(assistantSkills([renamed], [], true)[0]?.content).toContain("Read this workflow");
    expect(assistantSkills([renamed], [], false)).toEqual([renamed]);
  });

  it("preserves a custom old directory seed and an independently named custom destination", async () => {
    const local = createSkill(app.ctx, null, { name: "first-cut-dialogue", scope: "team", content: text("From my seed folder.") }, { source: "seed" });
    await upgrade();
    expect(saved()).toEqual(local);
    deleteSkill(app.ctx, publicGuide()!);
    const own = createSkill(app.ctx, editor, { name: "dialogue-pass", scope: "team", content: "My separately written guide." });
    await upgrade();
    expect(saved()).toEqual(local);
    expect(publicGuide()).toEqual(own);
  });

  it("keeps an independently seeded destination across an upgrade from the old stock workflow", async () => {
    seed(shipped);
    const old = saved();
    const local = { folder: "dialogue-pass", content: "---\nname: dialogue-pass\ndescription: Mine.\n---\nMy seed folder’s guide.\n" };
    expect(seedSkillList(app.ctx, [local], "seed")).toBe(1);
    const own = publicGuide()!;
    await upgrade();
    expect(publicGuide()).toEqual(own);
    expect(saved()).toEqual(old);
  });

  it("honors deletion of the original stock guide across an upgrade", async () => {
    seed(shipped);
    deleteSkill(app.ctx, saved(), editor);
    await upgrade();
    expect(saved()).toBeUndefined();
    expect(publicGuide()).toBeUndefined();
  });

  it("keeps a customized original after an editor deletes the separate public guide", async () => {
    seed(shipped);
    const own = updateSkill(app.ctx, editor, saved(), { content: text("Private style.") });
    await upgrade();
    deleteSkill(app.ctx, publicGuide()!, editor);
    await upgrade();
    expect(saved()).toEqual(own);
    expect(publicGuide()).toBeUndefined();
  });

  it("makes a stock skill edited under an earlier build the editor's own, and keeps unedited ones current", async () => {
    await app.ctx.close();
    const path = join(dataDir, "scarlet.db");
    await rm(path);
    const db = new Db(path);
    migrate(db, 19); // Before edited stock skills became the editor's own.
    const row = (id: string, name: string, extra: object) => db.prepare("INSERT INTO skills (id, name, scope, json, created_at, updated_at) VALUES (?, ?, 'team', ?, '', '')")
      .run(id, name, JSON.stringify({ id, name, description: "", content: shipped.replace("first-cut-dialogue", name), scope: "team", source: "bundled", ...extra }));
    const unedited = shipped.replace("first-cut-dialogue", "untouched");
    row("skl_a", "untouched", { stockBase: unedited });
    row("skl_b", "merged", { stockBase: "An earlier stock text.", stockUpdate: { available: true, hash: "abc" } });
    row("skl_c", "no-base", {});
    db.close();
    app = createApp({ dataDir, skillsSeedDir: join(dataDir, "none"), env: {}, log: () => {} });
    const raw = (id: string) => JSON.parse((app.ctx.db.prepare("SELECT json FROM skills WHERE id = ?").get(id) as { json: string }).json);
    expect(raw("skl_a")).toMatchObject({ source: "bundled" });
    expect(raw("skl_b").source).toBeUndefined();
    expect(raw("skl_c").source).toBeUndefined();
    for (const id of ["skl_a", "skl_b", "skl_c"]) expect(Object.keys(raw(id))).not.toEqual(expect.arrayContaining(["stockBase", "stockUpdate"]));
  });
});

describe("a stock skill the editor deleted", () => {
  let dataDir: string;
  let app: ScarletApp;
  // Each launch seeds the bundled set, as the app does when it opens.
  const launch = () => { app = createApp({ dataDir, env: {}, log: () => {} }); };
  const named = (name: string) => app.ctx.repos.skills.select("name = ?", [name])[0];
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "scarlet-skills-"));
    launch();
  });
  afterEach(async () => {
    await app.ctx.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("stays deleted at the next launch, and leaves its name free for a skill of the editor's own", async () => {
    const stock = named("visual-pass")!;
    expect(stock).toMatchObject({ source: "bundled", enabled: true });
    const deleted = await app.app.request(`/api/skills/${stock.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${accessToken(app.ctx)}` } });
    expect(deleted.status).toBe(200);
    // A skill Scarlet took away itself wasn't the editor's decision, so the next launch still seeds it.
    deleteSkill(app.ctx, named("smooth-audio-cuts")!);
    await app.ctx.close();
    launch();
    expect(named("visual-pass")).toBeUndefined();
    expect(named("smooth-audio-cuts")).toMatchObject({ source: "bundled", enabled: true });
    // One the editor had edited is theirs, with nothing left to say Scarlet came with it. Deleted, it stays deleted too.
    const edited = updateSkill(app.ctx, editor, named("add-captions")!, { content: named("add-captions")!.content + "\nKeep captions to two lines.\n" });
    expect(edited.source).toBeUndefined();
    deleteSkill(app.ctx, edited, editor);
    await app.ctx.close();
    launch();
    expect(named("add-captions")).toBeUndefined();

    // Made again by hand under the same name, it is the editor's own skill, and seeding leaves it as they wrote it.
    const own = createSkill(app.ctx, null, { name: "visual-pass", content: "---\nname: visual-pass\ndescription: Mine.\n---\n\nMy own pass.\n", scope: "team" });
    await app.ctx.close();
    launch();
    expect(named("visual-pass")).toMatchObject({ id: own.id, content: own.content, version: 1 });
    expect(named("visual-pass")!.source).toBeUndefined();
  });
});

describe("skills that the workflows replaced", () => {
  let dataDir: string;
  let app: ScarletApp;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "scarlet-skills-"));
    app = createApp({ dataDir, env: {}, log: () => {} });
  });
  afterEach(async () => {
    await app.ctx.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const named = (name: string) => app.ctx.repos.skills.select("name = ?", [name])[0];
  // The two starter shortcuts Scarlet shipped as quick actions, word for word.
  const shipped = [
    { id: "act_pauses", name: "Tighten pauses here", target: "playhead" as const,
      instruction: "Tighten the pauses around this moment so it flows naturally. Keep breaths that help the rhythm." },
    { id: "act_deadair", name: "Remove dead air and repeated lines", target: "video" as const,
      instruction: "Go through the whole cut using the word-timed transcript and the waveform. Remove dead air (pauses longer than about half a second, except deliberate beats) and repeated lines or false starts, keeping the best take of each line. Never cut inside a word. Make it one change with every spot." },
  ];
  const saveAction = (action: typeof shipped[number]) => app.ctx.repos.actions.put({ ...action, scope: "team", ownerId: null, createdBy: null });
  // The guide as one release shipped it.
  const guide = [
    "---",
    "name: scarlet-basics",
    "description: Use the current Scarlet project, version and review notes as the starting point for an edit.",
    "agents: []",
    "---",
    "",
    "# Scarlet Basics",
    "",
    "Start each editing turn with `project_get`. Use the editor’s referenced version and position to identify the passage. `timeline_at` maps a playhead time to each clip’s source time. `timeline_get` shows the clip properties needed for a patch.",
    "",
    "Choose a workflow by the outcome the editor requested. A change to the words, a change to their sound and a change to the picture can each be made independently. Use the tools enabled for the project. When available, `change_review_cut` compares a changed spot by `changeId` and zero-based `index`. Repeat the call if Scarlet is preparing the preview. Request `includeAudio` only if you can play the returned WAV. Otherwise, give the editor the time to check in Scarlet’s player.",
    "",
    "Submit one versioned change per editorial idea. Include the relevant `noteIds` when responding to feedback. Describe what changed and where. Check the returned state before reporting that an edit was applied or building on it. For alternatives, start each from the same version and leave the choice to the editor.",
    "",
  ].join("\n");
  const uses = (skillIds: string[]) => createTask(app.ctx, { projectId: "prj_1", kind: "edit", agent: "claude", instruction: "Tighten it",
    context: { skillIds }, createdBy: { type: "human", name: "Editor" } });
  const usedBy = (taskId: string) => app.ctx.repos.tasks.get(taskId)!.context.skillIds;

  // Last stock revisions of the two retired workflows.
  const render = [
    "---",
    "name: render-verify",
    "description: Render a requested Scarlet delivery or verify a specific export, file property or quality-check range.",
    "category: Delivery",
    "---",
    "",
    "# Render and verify",
    "",
    "Render what the editor asked for, or check a file against the delivery brief. The brief decides which version, passages and properties matter.",
    "",
    "`render_request` renders a range, or the whole video when the editor asks for a delivery. `render_status` with `inspectFile` measures the finished file, to compare with the project settings from `project_get`. `change_get` lists the renders of a change.",
    "",
    "A render Scarlet's engine made and a local copy saved through **Export video** are separate files.",
    "",
  ].join("\n");
  const screen = [
    "---",
    "name: screen-recording",
    "description: Reframe, pan or zoom an existing moving screen recording in Scarlet so the action stays readable.",
    "category: Picture and graphics",
    "---",
    "",
    "# Frame a screen recording",
    "",
    "Keep the action readable. The screen action and the editor's request decide the framing, the move and its timing.",
    "",
    "`frame_contact_sheet` in activity mode shows what changes on screen: pointer movement, menus, results appearing. `timeline_at` finds the screen clip and any overlays at a moment. `timeline_propose` sets a clip's scale, crop, position and keyframes.",
    "",
  ].join("\n");

  it("removes old stock render and screen workflows on upgrade and maps the screen pins to frame-screen once", async () => {
    const oldRender = createSkill(app.ctx, null, { name: "render-verify", scope: "team", content: render }, { source: "bundled" });
    const oldScreen = createSkill(app.ctx, null, { name: "screen-recording", scope: "team", content: screen.replaceAll("\n", "\r\n") }, { source: "seed" });
    const framing = named("frame-screen")!, captions = named("add-captions")!;
    const run = uses([oldScreen.id, captions.id, oldRender.id, framing.id]);
    app.ctx.repos.tasks.put({ ...run, state: "done" });
    await app.ctx.close();
    app = createApp({ dataDir, env: {}, log: () => {} });
    expect([named("render-verify"), named("screen-recording")]).toEqual([undefined, undefined]);
    expect(named("frame-screen")).toEqual(framing);
    expect(usedBy(run.id)).toEqual([framing.id, captions.id]);
    retireMergedSkills(app.ctx);
    expect(usedBy(run.id)).toEqual([framing.id, captions.id]);
    expect(app.ctx.repos.activity.select("type = 'skill.deleted'")).toEqual([]);
  });

  it.each(["enabled", "deleted", "disabled"])("honors queued workflow selections when Frame Screen is %s", async setting => {
    const framing = named("frame-screen")!;
    if (setting === "deleted") deleteSkill(app.ctx, framing, editor);
    else if (setting === "disabled") updateSkill(app.ctx, editor, framing, { enabled: false });
    const oldScreen = createSkill(app.ctx, null, { name: "screen-recording", scope: "team", content: screen }, { source: "bundled" });
    const oldRender = createSkill(app.ctx, null, { name: "render-verify", scope: "team", content: render }, { source: "bundled" });
    const screenRun = uses([oldScreen.id]), renderRun = uses([oldRender.id]);
    await app.ctx.close();
    app = createApp({ dataDir, env: {}, log: () => {} });
    for (const [task, skill] of [[screenRun, oldScreen], [renderRun, oldRender]] as const) {
      expect(usedBy(task.id)).toEqual([skill.id]);
      const saved = named(skill.name)!;
      expect(assistantSkills([saved], usedBy(task.id), true)).toEqual([skill]);
      expect(assistantSkills([saved], [], true)[0]?.content).toContain("Read this workflow");
      app.ctx.repos.tasks.put({ ...task, state: "done" });
    }
    retireMergedSkills(app.ctx);
    expect([named("render-verify"), named("screen-recording")]).toEqual([undefined, undefined]);
  });

  it("preserves a personal copy and customized seed text when they use retired names", () => {
    const own = createSkill(app.ctx, editor, { name: "render-verify", scope: "team", content: render });
    const custom = createSkill(app.ctx, null, { name: "screen-recording", scope: "team", content: screen + "Use my framing." }, { source: "seed" });
    const run = uses([own.id, custom.id]);
    retireMergedSkills(app.ctx);
    expect(named("render-verify")).toEqual(own);
    expect(named("screen-recording")).toEqual(custom);
    expect(usedBy(run.id)).toEqual([own.id, custom.id]);
  });

  it("preserves an old workflow while the editor is revising it", () => {
    const skill = createSkill(app.ctx, null, { name: "screen-recording", scope: "team", content: screen }, { source: "seed" });
    createTask(app.ctx, { projectId: "prj_1", kind: "skill_edit", agent: "codex", instruction: "Follow the selected window.",
      context: { skillId: skill.id }, createdBy: { type: "human", name: "Editor" } });
    retireMergedSkills(app.ctx);
    expect(named("screen-recording")).toEqual(skill);
  });

  it("retires the shipped shortcuts a dialogue pass covers, and points the runs that used them at it", () => {
    for (const action of shipped) saveAction(action);
    migrateQuickActions(app.ctx);
    const pauses = named("tighten-pauses-here")!, deadAir = named("remove-dead-air-and-repeated-lines")!;
    expect([pauses.source, deadAir.source]).toEqual(["quick-action:act_pauses", "quick-action:act_deadair"]);
    const dialogue = named("dialogue-pass")!, captions = named("add-captions")!;
    const both = uses([pauses.id, captions.id, deadAir.id]), neither = uses([captions.id]), plain = uses([]);
    retireMergedSkills(app.ctx);
    expect([named("tighten-pauses-here"), named("remove-dead-air-and-repeated-lines")]).toEqual([undefined, undefined]);
    // Both shortcuts become the one pass, once, in the place of the first.
    expect(usedBy(both.id)).toEqual([dialogue.id, captions.id]);
    expect(usedBy(neither.id)).toEqual([captions.id]);
    expect(usedBy(plain.id)).toEqual([]);
    // Scarlet took them away, not the editor: nothing in the history says they deleted a skill.
    expect(app.ctx.repos.activity.select("type = 'skill.deleted'")).toEqual([]);
  });

  it("keeps a shortcut the editor reworded, and one of that name they wrote themselves", () => {
    saveAction({ ...shipped[0]!, instruction: "Tighten the pauses here, but leave the long one before the reveal." });
    migrateQuickActions(app.ctx);
    const reworded = named("tighten-pauses-here")!;
    const own = createSkill(app.ctx, null, { name: "remove-dead-air-and-repeated-lines", scope: "team",
      content: "---\nname: remove-dead-air-and-repeated-lines\ndescription: Mine.\n---\n\nMy own pass.\n" });
    const run = uses([reworded.id, own.id]);
    retireMergedSkills(app.ctx);
    expect(named("tighten-pauses-here")).toMatchObject({ id: reworded.id });
    expect(named("remove-dead-air-and-repeated-lines")).toMatchObject({ id: own.id });
    expect(usedBy(run.id)).toEqual([reworded.id, own.id]);
  });

  it("keeps the shipped shortcuts while there is no dialogue pass to take their place", () => {
    deleteSkill(app.ctx, named("dialogue-pass")!);
    saveAction(shipped[0]!);
    migrateQuickActions(app.ctx);
    retireMergedSkills(app.ctx);
    expect(named("tighten-pauses-here")).toMatchObject({ source: "quick-action:act_pauses" });
  });

  it("retires the guide Scarlet shipped, unless the editor made it theirs", () => {
    const stock = createSkill(app.ctx, null, { name: "scarlet-basics", content: guide, scope: "team" }, { source: "bundled" });
    const run = uses([stock.id, named("add-captions")!.id]);
    retireMergedSkills(app.ctx);
    expect(named("scarlet-basics")).toBeUndefined();
    // Nothing replaces the guide, so a run that used it just no longer does.
    expect(usedBy(run.id)).toEqual([named("add-captions")!.id]);

    // The same words under the editor's name, or the stock guide with their changes, stays.
    const theirs = createSkill(app.ctx, null, { name: "scarlet-basics", content: guide, scope: "team" });
    retireMergedSkills(app.ctx);
    expect(named("scarlet-basics")).toMatchObject({ id: theirs.id });
    deleteSkill(app.ctx, theirs);
    const edited = createSkill(app.ctx, null, { name: "scarlet-basics", content: guide + "\nAlways check the levels.\n", scope: "team" }, { source: "seed" });
    retireMergedSkills(app.ctx);
    expect(named("scarlet-basics")).toMatchObject({ id: edited.id });
  });
});
