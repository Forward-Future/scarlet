// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { api } from "../lib/client";
import { buildDb } from "../lib/mock/fixtures";
import { useHostsStore } from "../stores/hosts";
import { useSkillsStore } from "../stores/skills";
import { useUiStore } from "../stores/ui";
import { SkillEditorPage } from "./SkillEditorPage";

it("shows the name as it was saved once a renamed skill is saved", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const db = buildDb();
  let skill = db.skills.find(s => s.version > 1)!;
  const versions = db.skillVersions[skill.id]!;
  vi.spyOn(api, "skill").mockImplementation(async () => ({ skill, versions }));
  // The engine keeps a skill's name as a slug, which is what the page sends.
  const update = vi.spyOn(api, "updateSkill").mockImplementation(async (_id, body) => {
    skill = { ...skill, name: body.name ?? skill.name };
    return { skill };
  });
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const router = createMemoryRouter([{ path: "/settings/skills/:skillId", element: <SkillEditorPage /> }], { initialEntries: [`/settings/skills/${skill.id}`] });
  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    const name = el.querySelector<HTMLInputElement>("#sk-name")!;
    const save = [...el.querySelectorAll("button")].find(b => b.textContent?.trim() === "Save")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "My Skill");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    expect(update).toHaveBeenCalledWith(skill.id, expect.objectContaining({ name: "my-skill" }));
    // With nothing left to save, the field and the saved skill say the same name.
    expect(save.disabled).toBe(true);
    expect(name.value).toBe("my-skill");
  } finally {
    await act(async () => root.unmount());
    el.remove();
    router.dispose();
    useSkillsStore.setState(useSkillsStore.getInitialState());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("says unsaved only while the page differs from what was loaded, and keeps no draft of a change that was put back", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const db = buildDb();
  const skill = db.skills[0]!;
  vi.spyOn(api, "skill").mockImplementation(async () => ({ skill, versions: db.skillVersions[skill.id] ?? [] }));
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const router = createMemoryRouter([{ path: "/settings/skills/:skillId", element: <SkillEditorPage /> }, { path: "/settings/skills", element: <p>Skill library</p> }],
    { initialEntries: [`/settings/skills/${skill.id}`] });
  const button = (text: string) => [...el.querySelectorAll("button")].find(b => b.textContent?.trim() === text)!;
  const type = (field: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const unsaved = () => [...el.querySelectorAll(".chip")].some(chip => chip.textContent === "Unsaved");
  const draft = () => localStorage.getItem(`scarlet.skillDraft.v1/${skill.id}`);
  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    const name = el.querySelector<HTMLInputElement>("#sk-name")!;
    const body = el.querySelector<HTMLTextAreaElement>('[aria-label="Skill markdown"]')!;
    const enabled = el.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Enabled"]')!;
    expect([unsaved(), button("Save").disabled, draft()]).toEqual([false, true, null]);
    // A letter typed in the name is unsaved, and kept in case Scarlet quits.
    await type(name, `${skill.name}x`);
    expect([unsaved(), button("Save").disabled]).toEqual([true, false]);
    expect(draft()).toContain(`${skill.name}x`);
    // Deleted again, the page is as it was loaded: no chip, nothing to save and no draft to restore.
    await type(name, skill.name);
    expect([unsaved(), button("Save").disabled, draft()]).toEqual([false, true, null]);
    // The instructions and the switch the same.
    await type(body, `${body.value}\nNever cut laughter.`);
    await act(async () => enabled.click());
    expect(unsaved()).toBe(true);
    await type(body, body.value.replace("\nNever cut laughter.", ""));
    expect(unsaved()).toBe(true);
    await act(async () => enabled.click());
    expect([unsaved(), button("Save").disabled, draft()]).toEqual([false, true, null]);
    // Leaving doesn't ask about a change that isn't there.
    await act(async () => button("← Skill library").click());
    expect(el.querySelector("dialog")).toBeNull();
    expect(el.textContent).toBe("Skill library");
  } finally {
    await act(async () => root.unmount());
    el.remove();
    router.dispose();
    localStorage.clear();
    useSkillsStore.setState(useSkillsStore.getInitialState());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("sends the editor's words to Scarlet and shows the revision it saved", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  const db = buildDb();
  let skill = db.skills[0]!;
  let versions = db.skillVersions[skill.id] ?? [];
  const host = db.hosts.find(h => h.online)!;
  useHostsStore.setState({ hosts: [host] });
  const agent = host.agents.find(a => a.installed && a.loggedIn !== false)!.id;
  let task = { ...db.tasks[0]!, id: "task_skill", kind: "skill_edit" as const, state: "queued" as const, instruction: "Never cut laughter.", context: { skillId: skill.id }, summary: null, question: null };
  // An earlier request is already in the conversation.
  const earlier = { ...task, id: "task_earlier", state: "done" as const, instruction: "Keep the cold open.", summary: "Added a rule for the cold open." };
  vi.spyOn(api, "skill").mockImplementation(async () => ({ skill, versions, edits: task.state === "queued" ? [earlier] : [earlier, task] }));
  const editSkill = vi.spyOn(api, "editSkill").mockImplementation(async () => ({ task }));
  vi.spyOn(api, "task").mockImplementation(async () => ({ task, events: [] }));
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const router = createMemoryRouter([{ path: "/settings/skills/:skillId", element: <SkillEditorPage /> }], { initialEntries: [`/settings/skills/${skill.id}`] });
  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    const box = el.querySelector<HTMLTextAreaElement>(".skill-chat textarea")!;
    const body = el.querySelector<HTMLTextAreaElement>('[aria-label="Skill markdown"]')!;
    expect(box.placeholder).toBe("Tell Scarlet what to change…");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Never cut laughter.");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(editSkill).toHaveBeenCalledWith(skill.id, expect.objectContaining({ prompt: "Never cut laughter.", agent }));
    // While Scarlet works the request is over the box, and the skill can't be changed under it.
    // The conversation is the left column, with the name and description over the instructions.
    expect(el.querySelector(".skill-chat")!.compareDocumentPosition(el.querySelector(".skill-details")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The name is edited in the toolbar, and one line over its field says what the description is for.
    expect(el.querySelector(".skill-editor-toolbar #sk-name")).not.toBeNull();
    expect(el.querySelector('.skill-details label[for="sk-desc"]')!.textContent).toBe("When to use it");
    expect(el.querySelector<HTMLTextAreaElement>(".skill-details #sk-desc")!.value).toBe(skill.description);
    expect(el.querySelector(".skill-details")!.textContent).not.toContain("Agents use it");
    expect([...el.querySelectorAll(".skill-chat .unit-msg p")].map(p => p.textContent)).toEqual(["Keep the cold open.", "Never cut laughter."]);
    expect(el.querySelector('.skill-chat [role="status"]')!.textContent).toBe("Revising the skill…");
    expect(box.value).toBe("");
    expect(box.disabled).toBe(true);
    expect(body.readOnly).toBe(true);
    // Scarlet saves its revision as the next version and says what it changed.
    const content = `${skill.content.trimEnd()}\n\nNever cut laughter.\n`;
    skill = { ...skill, content, version: skill.version + 1 };
    versions = [...versions, { version: skill.version, content }];
    task = { ...task, state: "done" as never, summary: "Added a rule to keep laughter." as never, resultSkillId: skill.id } as typeof task;
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect([...el.querySelectorAll(".skill-chat .req-say")].map(p => p.textContent)).toEqual(["Added a rule for the cold open.", "Added a rule to keep laughter."]);
    expect(el.querySelector('.skill-chat [role="status"]')).toBeNull();
    expect(body.value).toContain("Never cut laughter.");
    expect(body.readOnly).toBe(false);
    expect(box.disabled).toBe(false);
    expect(el.textContent).toContain(`v${skill.version}`);
  } finally {
    await act(async () => root.unmount());
    el.remove();
    router.dispose();
    useSkillsStore.setState(useSkillsStore.getInitialState());
    useHostsStore.setState(useHostsStore.getInitialState());
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("gives a skill that can't be read the way back to the library, and reads it again on Retry", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const db = buildDb();
  const skill = db.skills[0]!;
  const read = vi.spyOn(api, "skill").mockRejectedValueOnce(new Error("Engine unreachable"))
    .mockImplementation(async () => ({ skill, versions: db.skillVersions[skill.id] ?? [] }));
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const router = createMemoryRouter([{ path: "/settings/skills/:skillId", element: <SkillEditorPage /> }, { path: "/settings/skills", element: <p>Skill library</p> }],
    { initialEntries: [`/settings/skills/${skill.id}`] });
  const button = (text: string) => [...el.querySelectorAll("button")].find(b => b.textContent?.trim() === text)!;
  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    expect(el.querySelector('[role="alert"]')?.textContent).toContain("Engine unreachable");
    expect(button("← Skill library")).toBeTruthy();
    // Retry reads the skill again in place and the failure leaves the page.
    await act(async () => button("Retry").click());
    expect(read).toHaveBeenCalledTimes(2);
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(el.querySelector<HTMLInputElement>("#sk-name")!.value).toBe(skill.name);
    await act(async () => button("← Skill library").click());
    expect(el.textContent).toBe("Skill library");
  } finally {
    await act(async () => root.unmount());
    el.remove();
    router.dispose();
    useSkillsStore.setState(useSkillsStore.getInitialState());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

/** The page at an address, with the library behind it. */
async function open(path: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const page = <SkillEditorPage />;
  const router = createMemoryRouter([{ path: "/settings/skills/new", element: page }, { path: "/settings/skills/:skillId", element: page }, { path: "/settings/skills", element: <p>Skill library</p> }],
    { initialEntries: [path] });
  await act(async () => root.render(<RouterProvider router={router} />));
  /** Scarlet quits with the page as it is: what it kept on this computer is still there for the next visit. */
  const quit = async () => {
    await act(async () => root.unmount());
    el.remove();
    router.dispose();
    document.body.replaceChildren();
  };
  const close = async () => {
    await quit();
    localStorage.clear();
    useSkillsStore.setState(useSkillsStore.getInitialState());
    useHostsStore.setState(useHostsStore.getInitialState());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  };
  return { el, router, quit, close };
}

const write = async (field: HTMLInputElement | HTMLTextAreaElement, text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
});
const named = (el: Element, text: string) => [...el.querySelectorAll("button")].find(b => b.textContent?.trim() === text);
const markdown = (el: Element) => el.querySelector<HTMLTextAreaElement>('[aria-label="Skill markdown"]')!;

it("lists each version once with the newest marked current, and offers Restore only for an older one", async () => {
  const db = buildDb();
  const skill = db.skills.find(s => s.version === 2)!;
  const versions = db.skillVersions[skill.id]!;
  vi.spyOn(api, "skill").mockImplementation(async () => ({ skill, versions }));
  const view = await open(`/settings/skills/${skill.id}`);
  const { el } = view;
  const picker = () => el.querySelector<HTMLButtonElement>('[aria-label="Version history"]')!;
  const choices = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  const restore = () => [...el.querySelectorAll("button")].find(b => b.textContent?.trim().startsWith("Restore"));
  const body = el.querySelector<HTMLTextAreaElement>('[aria-label="Skill markdown"]')!;
  try {
    // Closed, the picker says the page shows the current version. Open, the newest version is that one, listed once.
    expect(picker().textContent).toBe("Current version");
    await act(async () => picker().click());
    expect(choices()).toHaveLength(2);
    expect(choices()[0]!.textContent).toMatch(/^v2 · Claude Code · .+ · current$/);
    expect(choices()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(choices()[1]!.textContent).toMatch(/^v1 · Demo Editor · /);
    expect(choices()[1]!.textContent).not.toContain("current");
    // The older one reads as it was, with the way to put it back.
    await act(async () => choices()[1]!.click());
    expect(body.readOnly).toBe(true);
    expect(body.value).toContain("(v1)");
    expect(restore()?.textContent?.trim()).toBe("Restore v1");
    // Back on the newest there is nothing to restore: it is the skill as it stands.
    await act(async () => picker().click());
    await act(async () => choices()[0]!.click());
    expect(picker().textContent).toBe("Current version");
    expect(body.readOnly).toBe(false);
    expect(restore()).toBeUndefined();
  } finally {
    await view.close();
  }
});

it("has no version history on a skill with one version", async () => {
  const db = buildDb();
  const skill = db.skills.find(s => s.version === 1)!;
  vi.spyOn(api, "skill").mockImplementation(async () => ({ skill, versions: db.skillVersions[skill.id]! }));
  const view = await open(`/settings/skills/${skill.id}`);
  try {
    expect(view.el.querySelector<HTMLInputElement>("#sk-name")!.value).toBe(skill.name);
    expect(view.el.querySelector('[aria-label="Version history"]')).toBeNull();
  } finally {
    await view.close();
  }
});

/** A skill at v2 with unsaved edits, left by quitting. Returns how Scarlet saves it again as the next version, as an approved Learning does. */
async function leaveUnsaved() {
  const db = buildDb();
  let skill = db.skills.find(s => s.version === 2)!;
  let versions = db.skillVersions[skill.id]!;
  vi.spyOn(api, "skill").mockImplementation(async () => ({ skill, versions }));
  const first = await open(`/settings/skills/${skill.id}`);
  const saved = markdown(first.el).value;
  await write(markdown(first.el), `${saved}\nMy unsaved line.\n`);
  await first.quit();
  const learn = () => {
    const content = `${skill.content.trimEnd()}\n\nKeep a laugh in.\n`;
    skill = { ...skill, content, version: skill.version + 1 };
    versions = [...versions, { version: skill.version, content }];
  };
  return { path: `/settings/skills/${skill.id}`, saved, learn, id: skill.id };
}

it("puts unsaved edits back on the page when the skill is still the version they were made on", async () => {
  const left = await leaveUnsaved();
  const view = await open(left.path);
  try {
    expect(markdown(view.el).value).toContain("My unsaved line.");
    expect(view.el.querySelector(".skill-editor-toolbar .chip")?.textContent?.toLowerCase()).toBe("unsaved");
    expect(view.el.querySelector(".skill-kept")).toBeNull();
    expect(named(view.el, "Save")!.disabled).toBe(false);
  } finally {
    await view.close();
  }
});

it("shows the skill as saved when it has moved past unsaved edits, and brings them back only when asked", async () => {
  const left = await leaveUnsaved();
  left.learn();
  const update = vi.spyOn(api, "updateSkill").mockImplementation(async (_id, body) => ({ skill: { ...buildDb().skills.find(s => s.id === left.id)!, ...body, version: 4 } as never }));
  const view = await open(left.path);
  const { el } = view;
  try {
    // The page shows v3 as saved, with the rule the editor approved, and nothing to save.
    expect(markdown(el).value).toContain("Keep a laugh in.");
    expect(markdown(el).value).not.toContain("My unsaved line.");
    expect(el.querySelector(".skill-editor-toolbar .chip")).toBeNull();
    expect(named(el, "Save")!.disabled).toBe(true);
    // One line over the instructions says the edits are from before that version, with its two actions.
    const line = el.querySelector(".skill-kept")!;
    expect(line.textContent).toBe("You have unsaved changes from before v3.Bring them backDiscard");
    expect([...line.querySelectorAll("button")].map(b => b.className)).toEqual(["simple-link", "simple-link"]);
    // Asked for, they are on the page again as unsaved changes, and saving them is the editor's own doing.
    await act(async () => named(el, "Bring them back")!.click());
    expect(markdown(el).value).toContain("My unsaved line.");
    expect(markdown(el).value).not.toContain("Keep a laugh in.");
    expect(el.querySelector(".skill-kept")).toBeNull();
    expect(el.querySelector(".skill-editor-toolbar .chip")).not.toBeNull();
    await act(async () => named(el, "Save")!.click());
    expect(update).toHaveBeenCalledWith(left.id, expect.objectContaining({ content: expect.stringContaining("My unsaved line.") }));
  } finally {
    await view.close();
  }
});

it("sets aside what is unsaved on the page when earlier edits are brought back, and offers it in the same line", async () => {
  const left = await leaveUnsaved();
  left.learn();
  let view = await open(left.path);
  const name = () => view.el.querySelector<HTMLInputElement>("#sk-name")!;
  const line = () => view.el.querySelector(".skill-kept")?.textContent;
  try {
    // On v3, with the earlier edits still waiting, a line is typed and the skill renamed.
    const was = name().value;
    await write(markdown(view.el), `${markdown(view.el).value}\nA newer line.\n`);
    await write(name(), "renamed-skill");
    await act(async () => named(view.el, "Bring them back")!.click());
    // The earlier edits are on the page. What was there waits in their place, and the line says so.
    expect(markdown(view.el).value).toContain("My unsaved line.");
    expect(markdown(view.el).value).not.toContain("A newer line.");
    expect(name().value).toBe(was);
    expect(line()).toBe("You have unsaved changes set aside.Bring them backDiscard");
    // Both are there on the next visit, and the same link brings back what was set aside.
    await view.quit();
    view = await open(left.path);
    expect(markdown(view.el).value).toContain("My unsaved line.");
    expect(line()).toBe("You have unsaved changes set aside.Bring them backDiscard");
    await act(async () => named(view.el, "Bring them back")!.click());
    expect(markdown(view.el).value).toContain("A newer line.");
    expect(markdown(view.el).value).toContain("Keep a laugh in.");
    expect(markdown(view.el).value).not.toContain("My unsaved line.");
    expect(name().value).toBe("renamed-skill");
    // Only Discard lets a set go.
    expect(line()).toBe("You have unsaved changes set aside.Bring them backDiscard");
    await act(async () => named(view.el, "Discard")!.click());
    expect(line()).toBeUndefined();
    expect(markdown(view.el).value).toContain("A newer line.");
  } finally {
    await view.close();
  }
});

it("keeps each set of unsaved edits the skill moves past, and offers the latest first", async () => {
  const left = await leaveUnsaved();
  left.learn();
  let view = await open(left.path);
  const line = () => view.el.querySelector(".skill-kept")?.textContent;
  try {
    // A line typed on v3 is left by quitting while the edits from before v3 still wait. Then the skill is saved again, as v4.
    await write(markdown(view.el), `${markdown(view.el).value}\nA newer line.\n`);
    await view.quit();
    left.learn();
    view = await open(left.path);
    expect(markdown(view.el).value).not.toContain("A newer line.");
    expect(view.el.querySelector(".skill-editor-toolbar .chip")).toBeNull();
    expect(line()).toBe("You have unsaved changes from before v4.Bring them backDiscard");
    // The latest set comes back first, and the line then offers the one before it.
    await act(async () => named(view.el, "Bring them back")!.click());
    expect(markdown(view.el).value).toContain("A newer line.");
    expect(line()).toBe("You have unsaved changes from before v4.Bring them backDiscard");
    await view.quit();
    view = await open(left.path);
    await act(async () => named(view.el, "Discard")!.click());
    expect(line()).toBeUndefined();
    expect(markdown(view.el).value).toContain("A newer line.");
    expect(markdown(view.el).value).not.toContain("My unsaved line.");
  } finally {
    await view.close();
  }
});

it("keeps edits from before the saved version until they are discarded, whatever is typed meanwhile", async () => {
  const left = await leaveUnsaved();
  left.learn();
  let view = await open(left.path);
  try {
    // Leaving them alone keeps them: the line is there on the next visit too.
    await view.quit();
    view = await open(left.path);
    expect(view.el.querySelector(".skill-kept")).not.toBeNull();
    // New edits typed on the saved skill don't take their place.
    await write(markdown(view.el), `${markdown(view.el).value}\nA newer line.\n`);
    await view.quit();
    view = await open(left.path);
    expect(markdown(view.el).value).toContain("A newer line.");
    expect(markdown(view.el).value).toContain("Keep a laugh in.");
    expect(view.el.querySelector(".skill-kept")?.textContent).toContain("from before v3");
    // Discard lets them go and leaves the page as it is.
    await act(async () => named(view.el, "Discard")!.click());
    expect(view.el.querySelector(".skill-kept")).toBeNull();
    expect(markdown(view.el).value).toContain("A newer line.");
    await view.quit();
    view = await open(left.path);
    expect(view.el.querySelector(".skill-kept")).toBeNull();
    expect(markdown(view.el).value).toContain("A newer line.");
  } finally {
    await view.close();
  }
});

it("takes an answer to Scarlet's question whichever version is showing, and a new request only on the current one", async () => {
  const db = buildDb();
  const skill = db.skills.find(s => s.version === 2)!;
  const asked = { ...db.tasks[0]!, id: "task_q", kind: "skill_edit" as const, state: "waiting_for_user", instruction: "Tighten the pauses.", context: { skillId: skill.id }, summary: null,
    question: "A quarter of a second, or a third?" };
  let edits: (typeof asked)[] = [];
  vi.spyOn(api, "skill").mockImplementation(async () => ({ skill, versions: db.skillVersions[skill.id]!, edits: edits as never }));
  vi.spyOn(api, "task").mockImplementation(async () => ({ task: asked as never, events: [] }));
  const answer = vi.spyOn(api, "answerTask").mockImplementation(async () => ({ task: { ...asked, state: "running", question: null } as never }));
  const box = () => view.el.querySelector<HTMLTextAreaElement>(".skill-chat textarea")!;
  const showOlder = async () => {
    await act(async () => view.el.querySelector<HTMLElement>('[aria-label="Version history"]')!.click());
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')][1]!.click());
    expect(markdown(view.el).value).toContain("(v1)");
  };
  let view = await open(`/settings/skills/${skill.id}`);
  try {
    // Scarlet revises the skill as saved, so the box takes no new request while an older version shows.
    await showOlder();
    expect(box().disabled).toBe(true);
    await view.quit();
    // A question waits. Answer goes to the box with the older version still up, and the answer to the request that asked.
    edits = [asked];
    view = await open(`/settings/skills/${skill.id}`);
    await showOlder();
    expect(box().disabled).toBe(false);
    await act(async () => named(view.el, "Answer")!.click());
    expect(document.activeElement).toBe(box());
    await write(box(), "A quarter.");
    await act(async () => box().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(answer).toHaveBeenCalledWith("task_q", "A quarter.");
    expect(markdown(view.el).value).toContain("(v1)");
    // With the answer sent, Scarlet has the request again and the box waits.
    expect(box().disabled).toBe(true);
  } finally {
    await view.close();
  }
});

it("draws each request as a project's chat does: its words in a band with where it stands, and Scarlet's lines under it", async () => {
  const db = buildDb();
  const skill = db.skills[0]!;
  const ask = (id: string, instruction: string, over: object) => ({ ...db.tasks[0]!, id, kind: "skill_edit" as const, instruction, context: { skillId: skill.id }, summary: null, question: null, error: undefined, ...over });
  let last = ask("task_4", "Tighten the pauses.", { state: "running" });
  const edits = () => [
    ask("task_1", "Keep the cold open.", { state: "done", summary: "Added a rule for the cold open." }),
    ask("task_2", "Cut every breath.", { state: "cancelled" }),
    ask("task_3", "Be stricter about filler.", { state: "failed", error: "stalled: no output for 10 minutes" }),
    last,
  ];
  vi.spyOn(api, "skill").mockImplementation(async () => ({ skill, versions: db.skillVersions[skill.id] ?? [], edits: edits() as never }));
  vi.spyOn(api, "task").mockImplementation(async () => ({ task: last as never, events: [] }));
  const cancel = vi.spyOn(api, "cancelTask").mockImplementation(async () => ({ task: (last = { ...last, state: "cancelled" }) as never }));
  let view = await open(`/settings/skills/${skill.id}`);
  const units = () => [...view.el.querySelectorAll(".skill-chat .simple-chat > .unit")];
  try {
    // The editor's words head each request, with where it stands at their right: a word once it stopped early, nothing once done.
    expect(units().map(u => [...u.querySelector(".unit-msg")!.children].map(c => c.className))).toEqual([
      ["simple-who", "", "unit-state"], ["simple-who", "", "unit-state"], ["simple-who", "", "unit-state"], ["simple-who", "", "unit-state", "simple-link unit-stop"]]);
    expect(units().map(u => u.querySelector(".unit-msg p")!.textContent)).toEqual(["Keep the cold open.", "Cut every breath.", "Be stricter about filler.", "Tighten the pauses."]);
    expect(units().map(u => u.querySelector(".unit-state")!.textContent)).toEqual(["", "Stopped", "Couldn’t finish", ""]);
    // Under the heading: Scarlet's reply, nothing for a request that was stopped, why one couldn't finish, what Scarlet is doing.
    expect(units().map(u => u.querySelector(".req")?.textContent)).toEqual(["Added a rule for the cold open.", undefined, "stalled: no output for 10 minutes", "Revising the skill…"]);
    expect(units()[2]!.querySelector(".req-say")!.className).toBe("req-say is-note is-bad");
    // Stop is in the heading of the request Scarlet has, and no row under it has another.
    expect([...view.el.querySelectorAll(".skill-chat button")].filter(b => b.textContent === "Stop")).toHaveLength(1);
    await act(async () => units()[3]!.querySelector<HTMLElement>(".unit-msg > .unit-stop")!.click());
    expect(cancel).toHaveBeenCalledWith("task_4");
    expect(units()[3]!.querySelector(".unit-state")!.textContent).toBe("Stopped");
    expect(units()[3]!.querySelector(".unit-stop")).toBeNull();
    // A question is the heading's amber dot with Stop after it, the question under it and Answer, which goes to the message box.
    await view.quit();
    last = ask("task_4", "Tighten the pauses.", { state: "waiting_for_user", question: "A quarter of a second, or a third?" });
    view = await open(`/settings/skills/${skill.id}`);
    const asking = units()[3]!;
    expect(asking.querySelector(".unit-state > .unit-dot")).not.toBeNull();
    expect(asking.querySelector(".unit-msg > .unit-stop")!.textContent).toBe("Stop");
    expect(asking.querySelector(".req-say")!.textContent).toBe("A quarter of a second, or a third?Answer");
    expect(view.el.textContent).not.toContain("Needs your answer");
    const box = view.el.querySelector<HTMLTextAreaElement>(".skill-chat textarea")!;
    expect(box.placeholder).toBe("Answer Scarlet…");
    await act(async () => asking.querySelector<HTMLElement>(".req-say > .simple-link.is-warn")!.click());
    expect(document.activeElement).toBe(box);
  } finally {
    await view.close();
  }
});

it("keeps the toolbar quiet: Delete is plain beside Save, the chip says Unsaved, and the window's status ends the row", async () => {
  vi.useFakeTimers();
  useUiStore.setState({ wsStatus: "connecting" });
  const db = buildDb();
  const skill = db.skills.find(s => s.version === 2)!;
  vi.spyOn(api, "skill").mockImplementation(async () => ({ skill, versions: db.skillVersions[skill.id]! }));
  const view = await open(`/settings/skills/${skill.id}`);
  const toolbar = view.el.querySelector(".skill-editor-toolbar")!;
  try {
    // Nothing in the row is red until Delete is pointed at; its dialog still confirms in red.
    const remove = named(toolbar, "Delete")!;
    expect(remove.className).toBe("btn-quiet hover:text-bad");
    expect(toolbar.querySelector(".btn-danger")).toBeNull();
    await act(async () => remove.click());
    expect(named(document.body, "Cancel")).toBeTruthy();
    expect([...document.querySelectorAll("dialog button")].find(b => b.textContent?.trim() === "Delete")!.className).toBe("btn-danger");
    await act(async () => named(document.body, "Cancel")!.click());
    await write(markdown(view.el), `${markdown(view.el).value}\nOne more line.\n`);
    expect(toolbar.querySelector(".chip")!.textContent).toBe("Unsaved");
    // Once the connection has been down a while the window says so, after Save, where the other pages have it.
    await act(async () => { await vi.advanceTimersByTimeAsync(2600); });
    const status = toolbar.querySelector('[role="status"]')!;
    expect(status.textContent).toBe("Reconnecting to Scarlet…");
    expect(named(toolbar, "Save")!.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toolbar.lastElementChild!.contains(status)).toBe(true);
  } finally {
    await view.close();
    useUiStore.setState(useUiStore.getInitialState());
    vi.useRealTimers();
  }
});

it("leaves only the name's line once a skill whose save failed is saved with no name", async () => {
  const db = buildDb();
  const skill = db.skills.find(s => s.version === 2)!;
  vi.spyOn(api, "skill").mockImplementation(async () => ({ skill, versions: db.skillVersions[skill.id]! }));
  vi.spyOn(api, "updateSkill").mockRejectedValue(new Error("A skill named taken-name already exists"));
  const view = await open(`/settings/skills/${skill.id}`);
  const { el } = view;
  const name = el.querySelector<HTMLInputElement>("#sk-name")!;
  const said = () => [...el.querySelectorAll('[role="alert"]')].map(a => a.textContent);
  try {
    // Why a save failed is under the skill's details.
    await write(name, "taken-name");
    await act(async () => named(el, "Save")!.click());
    expect(el.querySelector('.skill-details [role="alert"]')!.textContent).toBe("A skill named taken-name already exists");
    // Saved again with the name emptied, the page says the one thing wrong now, beside the name.
    await write(name, "");
    await act(async () => named(el, "Save")!.click());
    expect(said()).toEqual(["Name the skill"]);
  } finally {
    await view.close();
  }
});

it("says what the name needs beside the name field when a skill is created without one", async () => {
  const create = vi.spyOn(api, "createSkill");
  const view = await open("/settings/skills/new");
  const { el } = view;
  const name = el.querySelector<HTMLInputElement>("#sk-name")!;
  const said = () => [...el.querySelectorAll('[role="alert"]')].map(a => a.textContent);
  try {
    await act(async () => named(el, "Create skill")!.click());
    // One line, right after the name in the toolbar, and the cursor is in the field it is about.
    expect(said()).toEqual(["Name the skill"]);
    expect(name.nextElementSibling!.getAttribute("role")).toBe("alert");
    expect(el.querySelector('.skill-details [role="alert"]')).toBeNull();
    expect(document.activeElement).toBe(name);
    expect(create).not.toHaveBeenCalled();
    // It goes as soon as a name is typed. Any name is taken; one with nothing to make a name from says so.
    await write(name, "!!!");
    expect(said()).toEqual([]);
    await act(async () => named(el, "Create skill")!.click());
    expect(said()).toEqual(["Use letters a–z or digits in the name"]);
    await write(name, "My Skill");
    expect(said()).toEqual([]);
  } finally {
    await view.close();
  }
});

// A key press goes to whatever has focus and bubbles from there.
const esc = () => act(async () => {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
});

it("goes back to the library on Esc when nothing is unsaved, and to Save while something is", async () => {
  const db = buildDb();
  const skill = db.skills.find(s => s.version === 2)!;
  vi.spyOn(api, "skill").mockImplementation(async () => ({ skill, versions: db.skillVersions[skill.id]! }));
  let view = await open(`/settings/skills/${skill.id}`);
  try {
    // The back link names the key on hover, as the one out of Settings does.
    expect(named(view.el, "← Skill library")!.title).toBe("Skill library (Esc)");
    expect(view.el.querySelector(".skill-editor-toolbar[data-unsaved]")).toBeNull();
    // An open version list takes the first Esc for itself.
    await act(async () => view.el.querySelector<HTMLElement>('[aria-label="Version history"]')!.click());
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    await esc();
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(view.el.querySelector("#sk-name")).not.toBeNull();
    await esc();
    expect(view.el.textContent).toBe("Skill library");
    await view.quit();
    // With a change unsaved, the first Esc leaves the text field and the next goes to Save: leaving would ask about the change.
    view = await open(`/settings/skills/${skill.id}`);
    markdown(view.el).focus();
    await write(markdown(view.el), `${markdown(view.el).value}\nOne more line.\n`);
    await esc();
    expect(document.activeElement).toBe(document.body);
    await esc();
    expect(view.el.querySelector("#sk-name")).not.toBeNull();
    expect(document.activeElement).toBe(named(view.el, "Save"));
    // Save shows that the keyboard is on it, as Settings' does: the stylesheet outlines the button Esc landed on in a toolbar marked unsaved.
    expect(named(view.el, "Save")!.matches(".skill-editor-toolbar[data-unsaved] > .btn-primary[data-esc-focus]")).toBe(true);
    // The mark goes with the focus, so a click on Save shows no outline.
    await act(async () => named(view.el, "Save")!.blur());
    expect(named(view.el, "Save")!.matches("[data-esc-focus]")).toBe(false);
    await act(async () => named(view.el, "Save")!.focus());
    expect(named(view.el, "Save")!.matches("[data-esc-focus]")).toBe(false);
    await esc();
    expect(named(view.el, "Save")!.matches("[data-esc-focus]")).toBe(true);
    await esc();
    expect(view.el.querySelector("#sk-name")).not.toBeNull();
  } finally {
    await view.close();
  }
});

it("stays on the skill on Esc while a request is typed and not sent, and moves to Send", async () => {
  const db = buildDb();
  const skill = db.skills.find(s => s.version === 2)!;
  vi.spyOn(api, "skill").mockImplementation(async () => ({ skill, versions: db.skillVersions[skill.id]! }));
  const view = await open(`/settings/skills/${skill.id}`);
  const box = view.el.querySelector<HTMLTextAreaElement>(".skill-chat textarea")!;
  try {
    box.focus();
    await write(box, "Never cut laughter.");
    // The first Esc leaves the box. Going back would drop what was typed without asking, so the next goes to Send.
    await esc();
    expect(document.activeElement).toBe(document.body);
    await esc();
    expect(view.el.querySelector("#sk-name")).not.toBeNull();
    expect(document.activeElement).toBe(view.el.querySelector('.skill-chat [aria-label="Send"]'));
    // Send shows that the keyboard is on it: the stylesheet outlines the skill chat's Send as it does Save.
    expect(document.activeElement!.matches(".skill-chat .composer-send[data-esc-focus]")).toBe(true);
    await esc();
    expect(view.el.querySelector("#sk-name")).not.toBeNull();
    expect(box.value).toBe("Never cut laughter.");
    // With the box emptied there is nothing to lose, and Esc goes back.
    await write(box, "");
    await esc();
    expect(view.el.textContent).toBe("Skill library");
  } finally {
    await view.close();
  }
});

it("keeps what was typed while a save was on its way as unsaved", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const db = buildDb();
  const skill = db.skills[0]!;
  vi.spyOn(api, "skill").mockImplementation(async () => ({ skill, versions: db.skillVersions[skill.id] ?? [] }));
  let finish!: () => void;
  const update = vi.spyOn(api, "updateSkill").mockImplementation(() => new Promise(resolve => { finish = () => resolve({ skill }); }));
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const router = createMemoryRouter([{ path: "/settings/skills/:skillId", element: <SkillEditorPage /> }], { initialEntries: [`/settings/skills/${skill.id}`] });
  const button = (text: string) => [...el.querySelectorAll("button")].find(b => b.textContent?.trim() === text)!;
  const type = (field: HTMLTextAreaElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const unsaved = () => [...el.querySelectorAll(".chip")].some(chip => chip.textContent === "Unsaved");
  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    const body = el.querySelector<HTMLTextAreaElement>('[aria-label="Skill markdown"]')!;
    await type(body, `${body.value}\nNever cut laughter.`);
    await act(async () => button("Save").click());
    expect(update).toHaveBeenCalledTimes(1);
    // The save is still out when another line is typed. It isn't in what was sent.
    await type(body, `${body.value}\nKeep the pauses.`);
    await act(async () => finish());
    expect(unsaved()).toBe(true);
    expect(button("Save").disabled).toBe(false);
    expect(localStorage.getItem(`scarlet.skillDraft.v1/${skill.id}`)).toContain("Keep the pauses.");
  } finally {
    await act(async () => root.unmount());
    el.remove();
    router.dispose();
    localStorage.clear();
    useSkillsStore.setState(useSkillsStore.getInitialState());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
