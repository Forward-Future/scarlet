// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isDialogueGuide } from "@scarlet/shared";
import { api } from "../../lib/client";
import { buildDb, PRJ } from "../../lib/mock/fixtures";
import { buildThreads } from "../../lib/threads";
import { useHostsStore } from "../../stores/hosts";
import { usePlayerStore } from "../../stores/player";
import { useProjectStore, type ProjectData } from "../../stores/project";
import { useSkillsStore } from "../../stores/skills";
import { playheadPoints, useUiStore, type AgentContext } from "../../stores/ui";
import { NO_AGENT_REASON } from "./AgentChip";
import * as mic from "./MicButton";
import { Composer } from "./Composer";
import { ARRIVAL_MS } from "./ComposerAim";
import { NotePopover } from "./NotePopover";
import { ProjectLayout } from "../shell/ProjectLayout";

const stores = [useProjectStore.getState(), useUiStore.getState(), usePlayerStore.getState(), useHostsStore.getState(), useSkillsStore.getState()] as const;
const db = buildDb();
const project = db.projects.find(p => p.id === PRJ)!;
const current: ProjectData = { id: PRJ, project, timeline: db.timelines[project.head!]!,
  media: project.media, notes: db.notes, changes: db.changes, tasks: db.tasks, taskEvents: db.taskEvents, renders: db.renders,
  versions: db.versions[PRJ]! };
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useProjectStore.setState({ current, createTask: vi.fn().mockResolvedValue(db.tasks[0]), createNote: vi.fn().mockResolvedValue({ note: db.notes[0] }), revise: vi.fn(), answerTask: vi.fn() });
  usePlayerStore.setState({ time: 3.5, playing: true });
  useHostsStore.setState({ hosts: db.hosts });
  useUiStore.setState({ agentDraft: "", agentContext: null });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useProjectStore.setState(stores[0], true);
  useUiStore.setState(stores[1], true);
  usePlayerStore.setState(stores[2], true);
  useHostsStore.setState(stores[3], true);
  useSkillsStore.setState(stores[4], true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const show = (props: Partial<ComponentProps<typeof Composer>> = {}) => act(async () => root.render(
  <MemoryRouter><Composer {...props} /></MemoryRouter>,
));
const type = (value: string) => act(async () => {
  const input = container.querySelector<HTMLTextAreaElement>(".composer-input textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const selectPoint = (point: AgentContext) => act(async () => {
  playheadPoints.add(point);
  useUiStore.getState().setAgentContext(point);
});
const submit = () => act(async () => container.querySelector<HTMLButtonElement>(".composer-input button.btn-primary")!.click());

it.each(["typing", "voice"])("dismisses the first-project glow for good on first use by %s", async (input) => {
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  const hint = () => container.querySelector(".composer-box.first-edit-hint");
  useUiStore.getState().offerFirstEditHint("first-project");
  await show();
  expect(hint()).toBeNull();
  await act(() => useProjectStore.setState({ current: { ...current, id: "first-project", project: { ...project, id: "first-project" } } }));
  expect(hint()).not.toBeNull();
  if (input === "typing") await type("Trim the intro");
  else await act(() => micProps.onStart?.());
  expect(hint()).toBeNull();
  await type("");
  await act(() => useUiStore.getState().offerFirstEditHint("first-project"));
  expect(hint()).toBeNull();
  expect(localStorage.getItem("scarlet.firstEditHint")).toBe("dismissed");
});

// "There's no notice above the message box. The editor chose this design." (AGENTS.md)
it("puts nothing above the message box on the first import, even with the dialogue pass ready", async () => {
  const guide = db.skills.find(isDialogueGuide)!;
  useSkillsStore.setState({ status: "ready", skills: [guide] });
  useUiStore.getState().offerFirstEditHint(PRJ);
  await show();
  expect(container.querySelector(".composer-box.first-edit-hint")).not.toBeNull();
  expect(container.querySelector('button[aria-label="Make a first cut"]')).toBeNull();
  expect(container.querySelector(".composer-first-cut")).toBeNull();
  expect(container.querySelector("textarea")!.value).toBe("");
});

it("switches models above the draft and sends the edit with the selected model", async () => {
  await show();
  await type("Tighten the opening");
  const box = container.querySelector(".composer-box")!;
  const picker = container.querySelector<HTMLButtonElement>('.composer-model [aria-haspopup="dialog"]')!;
  expect(picker.closest(".composer-box")).toBeNull();
  expect(picker.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await act(() => picker.click());
  await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Claude Code"]')!.click());
  await act(() => container.querySelector<HTMLButtonElement>('[role="radio"][aria-label="Claude Code · Haiku 5.5"]')!.click());
  expect(picker.textContent).toContain("Haiku 5.5");
  await submit();
  expect(useProjectStore.getState().createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    instruction: "Tighten the opening", agent: "claude", model: "haiku",
  }));
});

it.each([
  { kind: "missing", catalog: {} },
  { kind: "empty", catalog: { models: [] } },
  { kind: "default-only", catalog: { models: [], modelLabels: { "": "Default" }, modelOptions: { "": { efforts: [{ id: "high" }], speeds: [] } } } },
])("sends through signed-in Claude when its model list is $kind", async ({ catalog }) => {
  useHostsStore.setState({ hosts: [{ ...db.hosts[0]!, online: true, agents: [
    { id: "claude", installed: true, loggedIn: true, auth: "subscription", ...catalog },
  ] }] });
  useUiStore.setState({ agent: { agent: "claude", model: "previous-model", effort: "max", serviceTier: "fast" } });
  await show();
  await type("Tighten the opening");
  await submit();
  expect(useProjectStore.getState().createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    instruction: "Tighten the opening", agent: "claude", model: undefined, effort: undefined, serviceTier: undefined,
  }));
});

it("names Scarlet, not a browser, where the window can’t record", async () => {
  // This test window has no recorder, as a webview without one.
  await show();
  const micButton = container.querySelector<HTMLButtonElement>('button[aria-label="Talk to Scarlet"]')!;
  expect([micButton.disabled, micButton.title]).toEqual([true, "Scarlet can’t record audio on this computer"]);
});

it("allows Shift+Enter for a new line and sends the multiline request with Enter", async () => {
  await show();
  await type("Lower the music.");
  const field = container.querySelector("textarea")!;
  const newline = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
  await act(async () => { field.dispatchEvent(newline); });
  expect(newline.defaultPrevented).toBe(false);
  expect(useProjectStore.getState().createTask).not.toHaveBeenCalled();

  const message = "Lower the music.\nKeep the dialogue level.";
  await type(message);
  await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  expect(useProjectStore.getState().createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({ instruction: message, context: { version: project.head } }));
  expect(field.value).toBe("");
});

it("opens the skill library with / and sends the chosen skill for the whole video by default", async () => {
  const base = db.skills[0]!;
  const skills = [
    { ...base, id: "global", name: "dialogue", scope: "team" as const },
    { ...base, id: "off", name: "disabled-skill", enabled: false },
    { ...base, id: "audio", name: "audio" },
  ];
  vi.spyOn(api, "skills").mockResolvedValue({ skills });
  await show();
  const field = container.querySelector("textarea")!;
  await act(() => field.focus());
  const key = (key: string) => act(() => { field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
  await type("/");
  expect(Array.from(container.querySelectorAll('.composer-skill-list [role="option"]'), o => o.firstChild?.textContent)).toEqual(["/audio", "/dialogue"]);
  await key("Escape");
  expect(container.querySelector('[role="listbox"]')).toBeNull();
  expect(document.activeElement).toBe(field);
  await type("/unmatched");
  expect(container.textContent).toContain("No matching skills");
  await type("/");
  await key("ArrowDown");
  await key("Enter");
  expect(field.value).toBe("/dialogue ");
  expect(container.querySelector('[role="listbox"]')).toBeNull();
  expect(useProjectStore.getState().createNote).not.toHaveBeenCalled();
  await act(() => usePlayerStore.getState().setTime(11));
  await type("/dialogue Keep natural pauses.");
  await key("Enter");
  expect(useProjectStore.getState().createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    instruction: "/dialogue Keep natural pauses.", context: { version: project.head, skillIds: ["global"] },
  }));
  expect(useProjectStore.getState().createNote).not.toHaveBeenCalled();
  await selectPoint({ time: 11, clipIds: [] });
  await type("/dialogue Keep natural pauses.");
  await submit();
  expect(useProjectStore.getState().createNote).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    text: "/dialogue Keep natural pauses.", time: 11, skillIds: ["global"],
  }));
});

it.each(["missing", "disabled"])("sends and rewords explicit dialogue shortcuts with the shipped guide %s", async state => {
  const guide = db.skills.find(isDialogueGuide)!;
  useSkillsStore.setState({ status: "ready", skills: state === "missing" ? [] : [{ ...guide, enabled: false }] });
  await show();
  const request = "Start here /tighten-pauses-here please.";
  await type(request);
  await submit();
  expect(useProjectStore.getState().createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    instruction: request, context: { version: project.head, skillIds: undefined },
  }));
  const rewording = { id: "queued", text: "Now do the /dialogue-pass pass.", onChange: vi.fn(), onSave: vi.fn(), onCancel: vi.fn() };
  await show({ rewording });
  await submit();
  expect(rewording.onSave).toHaveBeenCalledWith(rewording.text, undefined);
});

it.each(["click", "keyboard"])("creates a skill from the picker by %s and returns to the same draft", async method => {
  useProjectStore.setState({ load: vi.fn(), status: "ready" });
  useSkillsStore.setState({ status: "ready", skills: [db.skills[0]!] });
  const create = vi.spyOn(api, "createSkill").mockImplementation(async body => ({ skill: { ...db.skills[0]!, ...body, id: "skill_style" } }));
  const router = createMemoryRouter([{ path: "/p/:id", element: <ProjectLayout />, children: [
    { index: true, element: <Composer /> },
  ] }], { initialEntries: [`/p/${PRJ}?t=3.5`] });
  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    const field = container.querySelector<HTMLTextAreaElement>(".composer-input textarea")!;
    await act(() => field.focus());
    const draft = method === "click" ? "Keep the laughter /interview-pacing" : "Keep the laughter /";
    await type(draft);
    const target = useUiStore.getState().agentContext;
    const key = (key: string) => act(() => { field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
    const action = container.querySelector<HTMLButtonElement>(".composer-skill-footer button")!;
    if (method === "keyboard") {
      await key("ArrowUp");
      expect(field.getAttribute("aria-activedescendant")).toBe(action.id);
      await key("Enter");
    } else {
      expect(container.textContent).toContain("No matching skills.");
      await act(() => action.click());
    }
    await act(async () => { await import("../../pages/SkillEditorPage"); });
    const editor = container.querySelector<HTMLDialogElement>('dialog[aria-label="Create a skill"]')!;
    const name = editor.querySelector<HTMLInputElement>("#sk-name")!;
    const instructions = editor.querySelector<HTMLTextAreaElement>('[aria-label="Skill markdown"]')!;
    expect(editor.textContent).toContain("how you like to edit your videos");
    expect(instructions.value).toBe("");
    expect(instructions.placeholder).toContain("leave a beat");
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Interview pacing");
      name.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(instructions, "Keep the quiet after a difficult question.");
      instructions.dispatchEvent(new Event("input", { bubbles: true }));
    });
    if (method === "click") {
      await act(() => editor.querySelector<HTMLButtonElement>("[data-close]")!.click());
      expect(container.textContent).toContain("Save your skill changes?");
      await act(() => [...editor.querySelectorAll("button")].find(b => b.textContent === "Stay")!.click());
    }
    await act(async () => [...editor.querySelectorAll("button")].find(b => b.textContent?.trim() === "Create skill")!.click());
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]![0].content).toContain("Keep the quiet after a difficult question.");
    expect(create.mock.calls[0]![0].content).not.toContain(instructions.placeholder);
    expect(container.querySelector('dialog[aria-label="Create a skill"]')).toBeNull();
    expect(router.state.location.search).toBe("?t=3.5");
    expect(container.querySelector(".composer-input textarea")).toBe(field);
    expect(field.value).toBe(draft);
    expect(useUiStore.getState().agentContext).toEqual(target);
    await act(() => field.focus());
    await type("Keep the laughter /interview");
    expect(container.querySelector(".composer-skill-list")?.textContent).toContain("/interview-pacing");
    expect(useProjectStore.getState().createNote).not.toHaveBeenCalled();
  } finally {
    localStorage.removeItem("scarlet.skillDraft.v1/new");
    router.dispose();
  }
});

it.each(["/dialogue-pass", "/tighten-pauses-here"])("submits %s with the canonical dialogue skill", async command => {
  const skill = db.skills.find(isDialogueGuide)!;
  useSkillsStore.setState({ skills: [skill], status: "ready" });
  await show();
  const field = container.querySelector("textarea")!;
  await act(() => field.focus());
  await type(command);
  await act(() => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  expect(useProjectStore.getState().createTask).toHaveBeenCalledOnce();
  expect(useProjectStore.getState().createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    instruction: command, context: expect.objectContaining({ skillIds: [skill.id] }),
  }));
});

it("inserts a clicked skill for a new project request and keeps slashes in regular text literal", async () => {
  const skill = db.skills[0]!;
  useSkillsStore.setState({ skills: [skill], status: "ready" });
  await show();
  const field = container.querySelector("textarea")!;
  await act(() => field.focus());
  await type("Compare A/B");
  expect(container.querySelector('[role="listbox"]')).toBeNull();
  await type("/" + skill.name.slice(0, 3));
  await act(() => container.querySelector<HTMLButtonElement>('[role="option"]')!.click());
  expect(field.value).toBe("/" + skill.name + " ");
  await submit();
  expect(useProjectStore.getState().createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    instruction: "/" + skill.name, context: expect.objectContaining({ skillIds: [skill.id] }),
  }));
});

it("completes the inline command at the cursor and attaches each named skill once", async () => {
  const clean = { ...db.skills[0]!, id: "clean", name: "clean-dialogue" };
  const visual = { ...clean, id: "visual", name: "visual-pass" };
  useSkillsStore.setState({ skills: [clean, visual], status: "ready" });
  await show();
  const field = container.querySelector("textarea")!;
  await act(() => field.focus());
  const prefix = "Sync A/B roll and ";
  const suffix = " before the cut.\nThen /visual-pass and /clean-dialogue";
  await type(prefix + "/cl" + suffix);
  await act(() => {
    field.setSelectionRange(prefix.length + 3, prefix.length + 3);
    field.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true }));
  });
  expect(container.querySelector('[role="option"]')?.textContent).toContain("/clean-dialogue");
  await act(() => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
  const instruction = prefix + "/clean-dialogue" + suffix;
  expect(field.value).toBe(instruction);
  expect(field.selectionStart).toBe(instruction.indexOf("before"));
  expect(container.querySelector('[role="listbox"]')).toBeNull();
  await submit();
  expect(useProjectStore.getState().createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    instruction, context: expect.objectContaining({ skillIds: ["clean", "visual"] }),
  }));
});

it("only ever sends: stopping a running edit is on its card, not in the message box", async () => {
  const thread = buildThreads(current).find(t => t.active?.state === "running")!;
  const cancelTask = vi.fn();
  useProjectStore.setState({ cancelTask });
  await show({ thread });
  const action = () => container.querySelector<HTMLButtonElement>(".composer-send");
  // With nothing typed the box has no button, though an edit is running in this request.
  expect(action()).toBeNull();
  await act(() => useUiStore.getState().setAgent({ agent: "claude", model: "haiku" }));
  await type("Keep the first take");
  expect(action()!.getAttribute("aria-label")).toBe("Send reply");
  await submit();
  expect(useProjectStore.getState().createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    instruction: "Keep the first take", agent: "claude", model: "haiku", context: expect.objectContaining({ threadId: thread.id }),
  }));
  await type("Another idea");
  await type("");
  expect(action()).toBeNull();
  expect(cancelTask).not.toHaveBeenCalled();
});

it("offers the displayed cut time and includes it in the request only after the editor presses Edit here", async () => {
  useHostsStore.setState({ hosts: [] });
  await show();
  const tag = () => container.querySelector('.composer-context-row .composer-scope');
  const action = () => container.querySelector<HTMLButtonElement>('button[aria-label="Edit here at 7:23"]');
  expect(tag()).toBeNull();
  expect(action()).toBeNull();
  const picked = { time: 443.25, version: project.head!, clipIds: [] };
  await show({ editHere: { time: "7:23", onSelect: () => useUiStore.getState().setAgentContext(picked) } });
  await type("Cut here");
  expect(action()?.textContent).toBe("Edit here");
  expect(tag()).toBeNull();
  await act(async () => action()!.click());
  expect(document.activeElement).toBe(container.querySelector("textarea"));
  expect(action()).toBeNull();
  expect(tag()?.textContent).toBe("7:23.250");
  expect(useUiStore.getState().agentDraft).toBe("Cut here");
  expect(container.querySelector<HTMLButtonElement>(".composer-input button.btn-primary")?.disabled).toBe(true);
  await act(async () => { usePlayerStore.setState({ time: 9 }); useHostsStore.setState({ hosts: db.hosts }); });
  expect(tag()?.textContent).toBe("7:23.250");
  await submit();
  expect(useProjectStore.getState().createNote).toHaveBeenCalledWith(PRJ, expect.objectContaining({ text: "Cut here", time: 443.25, version: project.head }));
  expect(tag()).toBeNull();
});

it("sends the version of an explicitly attached point even when the project head has advanced", async () => {
  // The edit moved on to v_new and its timeline couldn't be read yet: the one before is on screen and in the player.
  useProjectStore.setState({ current: { ...current, project: { ...project, head: "v_new" } } });
  await show();
  await selectPoint({ time: 443.25, version: current.timeline!.version, clipIds: [] });
  await type("Cut here");
  await submit();
  expect(useProjectStore.getState().createNote).toHaveBeenCalledWith(PRJ, expect.objectContaining({ text: "Cut here", time: 443.25, version: current.timeline!.version }));
  expect(current.timeline!.version).not.toBe("v_new");
});

it("sends raw-media time in source coordinates and lets the next edit start without a timestamp", async () => {
  const source = project.media[0]!;
  await selectPoint({ time: 3.5, mediaId: source.id, clipIds: [] });
  await show();
  await type("Use this angle");
  await act(async () => usePlayerStore.setState({ time: 10 }));
  await submit();
  expect(useProjectStore.getState().createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    instruction: "Use this angle", context: expect.objectContaining({ mediaId: source.id, time: 3.5 }),
  }));
  await selectPoint({ time: 10, mediaId: source.id, clipIds: [] });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[aria-label="Remove timestamp"]')!.click();
  });
  await type("Make it shorter");
  expect(container.querySelector('[aria-label="Remove timestamp"]')).toBeNull();
  await submit();
  expect(useProjectStore.getState().createTask).toHaveBeenLastCalledWith(PRJ, expect.objectContaining({
    instruction: "Make it shorter", context: { version: project.head },
  }));
});

it("uses the same input for a selected transcript, revision, or agent question", async () => {
  useUiStore.setState({ agentContext: { mediaId: project.media[0]!.id, time: 2, end: 5, clipIds: [], label: "opening line" } });
  await show();
  const selection = container.querySelector('.composer-context-row .composer-scope');
  expect(selection?.textContent).toBe("0:02–0:05");
  expect(selection?.querySelector("button")?.getAttribute("title")).toContain(project.media[0]!.name + " · opening line");
  await type("Keep these words");
  await submit();
  expect(useProjectStore.getState().createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    context: expect.objectContaining({ time: 2, end: 5, mediaId: project.media[0]!.id }),
  }));
  const threads = buildThreads(current);
  const ready = threads.find(t => t.needs === "decision")!;
  await show({ thread: ready });
  await type("Keep the pause");
  await submit();
  expect(useProjectStore.getState().revise).toHaveBeenCalledWith(ready.latest!.id, expect.objectContaining({ text: "Keep the pause" }));
  const asking = threads.find(t => t.question)!;
  await act(async () => useHostsStore.setState({ hosts: [] }));
  await show({ thread: asking });
  await type("Yes, keep it");
  await submit();
  expect(useProjectStore.getState().answerTask).toHaveBeenCalledWith(asking.question!.id, "Yes, keep it", undefined);

  await show({ thread: asking, selectedEdit: { changeId: ready.latest!.id, editNumber: 2, editIndex: 0,
    label: "Sponsor transition", time: 8.75, end: 11.75, clipIds: [] } });
  await type("Keep the words on both sides");
  await submit();
  expect(useProjectStore.getState().answerTask).toHaveBeenLastCalledWith(asking.question!.id,
    "Edit 2 · Sponsor transition — Keep the words on both sides", undefined);
});

it("prompts for a fix and sends feedback on the failed attempt", async () => {
  const ready = buildThreads(current).find(t => t.needs === "decision")!;
  const failed = { ...ready.latest!, state: "failed" as const };
  await show({ thread: { ...ready, latest: failed } });
  expect(container.querySelector<HTMLTextAreaElement>(".composer-input textarea")?.placeholder).toBe("Write a follow-up…");
  await type("Use the original audio");
  await submit();
  expect(useProjectStore.getState().revise).toHaveBeenCalledWith(failed.id, expect.objectContaining({ text: "Use the original audio" }));
});

it("names the selected model once in an assigned note", async () => {
  useUiStore.getState().openNotePopover(3);
  await act(async () => root.render(<MemoryRouter><NotePopover /></MemoryRouter>));
  const dialog = container.querySelector("dialog")!;
  const toggle = dialog.querySelector<HTMLButtonElement>('[role="switch"]')!;
  if (toggle.getAttribute("aria-checked") === "false") await act(async () => toggle.click());
  expect(dialog.querySelector('[aria-label^="Model:"]')).toBeTruthy();
  expect(toggle.closest("label")?.textContent?.trim()).toBe("Send to");
  await act(async () => toggle.click());
  expect(toggle.closest("label")?.textContent?.trim()).toBe("Just a note");
  expect(dialog.querySelector('[aria-label^="Model:"]')).toBeNull();
});

it("submits a timestamped note once when Enter repeats while saving", async () => {
  let finish!: () => void;
  const createNote = vi.fn(() => new Promise<{ note: typeof db.notes[number] }>(resolve => { finish = () => resolve({ note: db.notes[0]! }); }));
  useProjectStore.setState({ createNote });
  useUiStore.getState().openNotePopover(3);
  await act(async () => root.render(<MemoryRouter><NotePopover /></MemoryRouter>));
  const field = container.querySelector("textarea")!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Shorten this pause");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(() => {
    for (const repeat of [false, true]) field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", repeat, bubbles: true }));
  });
  expect(createNote).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  expect(container.querySelector("dialog")).toBeNull();
});

it("holds a note open while it saves, so a failure is said and a typed note keeps its text", async () => {
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  let fail!: (e: Error) => void;
  const pending = () => new Promise<never>((_, reject) => { fail = reject; });
  const createNote = vi.fn(pending), createVoiceNote = vi.fn(pending);
  useProjectStore.setState({ createNote, createVoiceNote });
  useUiStore.getState().openNotePopover(3);
  await act(async () => root.render(<MemoryRouter><NotePopover /></MemoryRouter>));
  const dialog = () => container.querySelector("dialog");
  const field = container.querySelector("textarea")!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Shorten this pause");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const dismissBoth = async () => {
    await act(async () => dialog()!.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
    expect(dialog()).not.toBeNull();
    await act(async () => { dialog()!.dispatchEvent(new Event("cancel", { cancelable: true })); });
    expect(dialog()).not.toBeNull();
  };
  // A typed note: × and Esc wait for the save, and a failure leaves the text to send again.
  await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(createNote).toHaveBeenCalledTimes(1);
  await dismissBoth();
  expect(localStorage.getItem(`scarlet.noteDraft.v1/${PRJ}`)).toBe("Shorten this pause");
  await act(async () => fail(new Error("Engine restarting")));
  expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe("Engine restarting");
  expect(container.querySelector("textarea")!.value).toBe("Shorten this pause");
  // A voice note is transcribed inside the request, which takes seconds: its failure is said too.
  await act(async () => { micProps.onResult({ blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/mp4" }); });
  expect(createVoiceNote).toHaveBeenCalledTimes(1);
  await dismissBoth();
  await act(async () => fail(new Error("No speech was heard.")));
  expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe("No speech was heard.");
  // Settled, × closes and forgets the draft.
  await act(async () => dialog()!.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
  expect(dialog()).toBeNull();
  expect(localStorage.getItem(`scarlet.noteDraft.v1/${PRJ}`)).toBeNull();
});

it("clears only the sent draft if the editor switches projects before the request finishes", () => {
  const ui = useUiStore.getState();
  ui.openDraft("one", "review");
  ui.setAgentDraft("Shorten the pause");
  const sent = useUiStore.getState();
  ui.openDraft("two");
  ui.setAgentDraft("Another project");
  ui.clearSentDraft(sent.draftOwner, sent);
  expect(useUiStore.getState().agentDraft).toBe("Another project");
  ui.openDraft("one", "review");
  expect(useUiStore.getState().agentDraft).toBe("");
  ui.openDraft("two");
  expect(useUiStore.getState().agentDraft).toBe("Another project");
});

it("keeps unsent drafts on this computer, so a quit doesn't lose a message being written", async () => {
  const ui = useUiStore.getState();
  ui.openDraft("kept", "review");
  ui.setAgentDraft("Tighten the intro");
  ui.setAgentContext({ time: 12, clipIds: [], label: "the cut at 0:12" });
  ui.openDraft("kept");
  ui.setAgentDraft("Add captions");
  const saved = JSON.parse(localStorage.getItem("scarlet.drafts.v1")!);
  expect(saved[JSON.stringify(["kept", "review"])]).toEqual({ agentDraft: "Tighten the intro", agentContext: { time: 12, clipIds: [], label: "the cut at 0:12" } });
  expect(saved[JSON.stringify(["kept", null])]).toEqual({ agentDraft: "Add captions", agentContext: null });
  // The next launch starts from what was saved.
  vi.resetModules();
  const { useUiStore: relaunched } = await import("../../stores/ui");
  relaunched.getState().openDraft("kept", "review");
  expect(relaunched.getState()).toMatchObject({ agentDraft: "Tighten the intro", agentContext: { label: "the cut at 0:12" } });
  // Sending or clearing a draft forgets it.
  ui.setAgentDraft("");
  ui.openDraft("kept", "review");
  ui.setAgentDraft("");
  ui.setAgentContext(null);
  ui.openDraft(null);
  expect(localStorage.getItem("scarlet.drafts.v1")).toBeNull();
});

it("still drops a point the box took from the playhead once a draft restored after a restart is emptied", async () => {
  const ui = useUiStore.getState();
  ui.openDraft("kept");
  const point = { time: 1108, clipIds: [] };
  playheadPoints.add(point);
  ui.setAgentContext(point);
  ui.setAgentDraft("Cut the cough");
  ui.openDraft("kept", "review");
  ui.setAgentDraft("Tighten the intro");
  ui.setAgentContext({ time: 12, clipIds: [], label: "the cut at 0:12" });
  ui.openDraft(null);
  // The next launch remembers which targets can be released when the draft is emptied.
  vi.resetModules();
  const relaunched = await import("../../stores/ui");
  relaunched.useUiStore.getState().openDraft("kept");
  const restored = relaunched.useUiStore.getState().agentContext;
  expect(restored).toMatchObject({ time: 1108 });
  expect(relaunched.playheadPoints.has(restored as AgentContext)).toBe(true);
  relaunched.useUiStore.getState().openDraft("kept", "review");
  const aimed = relaunched.useUiStore.getState().agentContext;
  expect(aimed).toMatchObject({ label: "the cut at 0:12" });
  expect(relaunched.playheadPoints.has(aimed as AgentContext)).toBe(false);
  localStorage.removeItem("scarlet.drafts.v1");
});

it("sends a spoken edit to the explicitly attached moment and spoken revisions to the open thread", async () => {
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  const createVoiceNote = vi.fn().mockResolvedValue({ note: db.notes[0], task: db.tasks[0] });
  useProjectStore.setState({ createVoiceNote });
  vi.spyOn(api, "speechToText").mockResolvedValue({ text: "Keep the last word" });
  await show();
  const recording = { blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/mp4" };
  await selectPoint({ time: 3.5, clipIds: [] });
  const finishRecording = micProps.onResult;
  await act(async () => { micProps.onStart?.(); });
  await act(async () => usePlayerStore.getState().setTime(8));
  await act(async () => { finishRecording(recording); });
  expect(createVoiceNote).toHaveBeenCalledWith(PRJ, recording.blob, expect.objectContaining({ time: 3.5 }));
  expect(useUiStore.getState().agentContext).toBeNull();

  const ready = buildThreads(current).find(t => t.needs === "decision")!;
  await show({ thread: ready });
  const picker = container.querySelector<HTMLButtonElement>('.composer-context-row .composer-model [aria-haspopup="dialog"]')!;
  await act(() => picker.click());
  await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Claude Code"]')!.click());
  await act(() => container.querySelector<HTMLButtonElement>('[role="radio"][aria-label="Claude Code · Haiku 5.5"]')!.click());
  expect(picker.textContent).toContain("Haiku 5.5");
  await act(async () => { micProps.onStart?.(); micProps.onResult(recording); });
  expect(useProjectStore.getState().revise).toHaveBeenCalledWith(ready.latest!.id,
    expect.objectContaining({ assignTo: "claude:haiku", text: "Keep the last word", voiceTranscript: "Keep the last word" }));
  expect(createVoiceNote).toHaveBeenCalledTimes(1);
});

it("sends a late voice transcript to the project that owned the recording", async () => {
  const source = project.media[0]!;
  const other = db.projects.find(p => p.id !== project.id)!;
  let finish!: (result: { text: string }) => void;
  const transcribe = vi.spyOn(api, "speechToText").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const task = { ...db.tasks[0]!, id: "voice-request", projectId: project.id };
  const send = vi.spyOn(api, "createTask").mockResolvedValue({ task });
  useProjectStore.setState({ createTask: stores[0].createTask });
  vi.spyOn(mic, "MicButton").mockImplementation(({ onStart, onResult }) =>
    <button onClick={() => { onStart?.(); onResult({ blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/webm" }); }}>Record</button>);

  await selectPoint({ time: 3.5, mediaId: source.id, clipIds: [] });
  await show();
  const recordButton = [...container.querySelectorAll("button")].find(button => button.textContent === "Record")!;
  await act(async () => recordButton.click());
  expect(transcribe).toHaveBeenCalledOnce();
  await act(async () => root.render(null));
  useProjectStore.setState({ current: { ...current, id: other.id, project: other, tasks: [] } });
  await act(async () => finish({ text: "Trim this take" }));

  expect(send).toHaveBeenCalledWith(project.id, expect.objectContaining({
    instruction: "Trim this take", context: { version: project.head, mediaId: source.id, time: 3.5, end: undefined },
  }));
  expect(useProjectStore.getState().current?.tasks).toEqual([]);
});

it("pins a reply to the selected individual edit while typing and sends it in the same thread", async () => {
  const change = current.changes.find(c => c.state === "approved")!;
  const thread = buildThreads({ changes: [change], tasks: [], notes: [] })[0]!;
  const target = { changeId: change.id, editIndex: 1, version: project.head!, time: 1, end: 3, clipIds: [], label: "Opening caption" };
  await show({ thread, selectedEdit: target });
  const header = container.querySelector(".composer-context-row")!;
  expect(header.querySelector(".composer-target-name")?.textContent).toBe("Edit 2");
  expect(header.contains(container.querySelector(".composer-model"))).toBe(true);
  expect(container.querySelector(".composer-box")?.contains(header)).toBe(false);
  await type("Hold this caption for another second");
  await show({ thread, selectedEdit: { ...target, editIndex: 2, label: "Camera crop" } });
  expect(container.querySelector(".composer-scope")?.getAttribute("title")).toContain("Opening caption");
  await submit();
  expect(useProjectStore.getState().createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    kind: "edit", instruction: "Hold this caption for another second",
    context: expect.objectContaining({ threadId: thread.id, changeId: change.id, editIndex: 1, version: project.head, time: 1, end: 3 }),
  }));
  expect(useProjectStore.getState().revise).not.toHaveBeenCalled();
});

it("sends words chosen in a call's passage as a revision of that one cut, where the editor was looking", async () => {
  const ready = buildThreads(current).find(t => t.needs === "decision")!;
  // As the page aims the box at words chosen in the open call's passage: the call, and the words' own times.
  useUiStore.getState().setAgentContext({ changeId: ready.latest!.id, cutIndex: 0, version: project.head!, time: 2.3, end: 2.5, clipIds: [], label: "“I”" });
  await show({ thread: ready });
  await type("Keep this word");
  await submit();
  expect(useProjectStore.getState().revise).toHaveBeenCalledWith(ready.latest!.id, expect.objectContaining({ text: "Keep this word",
    position: expect.objectContaining({ cutIndex: 0, version: project.head, time: 2.3, end: 2.5 }) }));
  expect(useProjectStore.getState().createTask).not.toHaveBeenCalled();
});

it("clears a sent message's text and its own target, and keeps a target the box was aimed at since", () => {
  const ui = useUiStore.getState();
  const captions = { changeId: "chg_1", editIndex: 1, time: 0.2, clipIds: [], label: "captions" };
  const wrap = { changeId: "chg_1", editIndex: 2, time: 11.5, clipIds: [], label: "wrap" };
  ui.openDraft("one", "request");
  ui.setAgentContext(captions);
  ui.setAgentDraft("Make them smaller");
  const sent = useUiStore.getState();
  // The box is aimed at another edit of the same request while the message is on its way.
  ui.setAgentContext(wrap);
  ui.clearSentDraft(sent.draftOwner, sent);
  expect(useUiStore.getState()).toMatchObject({ agentDraft: "", agentContext: wrap });
  // A target the page moved along with what it names is still the message's own, and goes with it.
  const cut = { changeId: "chg_part1", cutIndex: 2, time: 11, end: 12, clipIds: [], label: "Cut at 0:11" };
  ui.setAgentContext(cut);
  ui.setAgentDraft("Keep the aside");
  const second = useUiStore.getState();
  const moved = { ...cut, changeId: "chg_part2", time: 9.5, end: 10.5, label: "Cut at 0:09" };
  ui.setAgentContext(moved, cut);
  ui.setAgentContext({ ...cut, changeId: "chg_part3", time: 8, end: 9, label: "Cut at 0:08" }, moved);
  ui.clearSentDraft(second.draftOwner, second);
  expect(useUiStore.getState()).toMatchObject({ agentDraft: "", agentContext: null });
  // The same when the box has moved to another request meanwhile: what is left of the first one's draft is only a newer target.
  ui.setAgentContext(captions);
  ui.setAgentDraft("Louder");
  const third = useUiStore.getState();
  ui.setAgentContext(wrap);
  ui.openDraft("one", "another request");
  ui.clearSentDraft(third.draftOwner, third);
  expect(useUiStore.getState().savedDrafts[third.draftOwner!]).toEqual({ agentDraft: "", agentContext: wrap });
});

it("counts a targeted revision only after submission succeeds, including a target pinned to an older version", async () => {
  const report = vi.spyOn(api, "recordEditReview").mockResolvedValue(undefined);
  const thread = buildThreads(current).find(t => t.changes.some(c => c.state === "approved"))!;
  const change = thread.changes.find(c => c.state === "approved")!;
  const target = { changeId: change.id, editIndex: 2, time: 1, clipIds: [], reviewRef: { changeId: "original", spot: 1 } };
  useUiStore.setState({ agentContext: target });
  const create = vi.fn().mockRejectedValueOnce(new Error("Could not send")).mockResolvedValue(db.tasks[0]);
  useProjectStore.setState({ createTask: create });
  await show({ thread: { ...thread, question: undefined } });
  await type("Try a different cut");
  expect(report).not.toHaveBeenCalled();
  await submit();
  expect(report).not.toHaveBeenCalled();
  await submit();
  expect(report.mock.calls).toEqual([[PRJ, { changeId: "original", spot: 1, decision: "revise" }]]);
  expect(create.mock.calls.at(-1)![1].context).not.toHaveProperty("reviewRef");
});

it("tells the page once a message has gone out, and not when sending fails", async () => {
  const onSent = vi.fn();
  await show({ onSent });
  await type("Tighten the opening");
  await submit();
  expect(onSent).toHaveBeenCalledTimes(1);
  // A revision of the proposal that's waiting, then an answer to Scarlet's question.
  const threads = buildThreads(current);
  await show({ thread: threads.find(t => t.needs === "decision")!, onSent });
  await type("Keep the pause");
  await submit();
  expect(onSent).toHaveBeenCalledTimes(2);
  await show({ thread: threads.find(t => t.question)!, onSent });
  await type("Yes, keep it");
  await submit();
  expect(onSent).toHaveBeenCalledTimes(3);
  // A message that couldn't be sent stays in the box, and the page isn't told.
  await act(async () => useProjectStore.setState({ answerTask: vi.fn().mockRejectedValue(new Error("Engine unreachable")) }));
  await type("Still there?");
  await submit();
  expect(onSent).toHaveBeenCalledTimes(3);
  expect(container.querySelector<HTMLTextAreaElement>(".composer-input textarea")!.value).toBe("Still there?");
  expect(container.textContent).toContain("Engine unreachable");
});

it("tells the page a spoken message went out, unless a typed one is still waiting in the box", async () => {
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  vi.spyOn(api, "speechToText").mockResolvedValue({ text: "Keep the last word" });
  const onSent = vi.fn();
  const recording = { blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/mp4" };
  await show({ thread: buildThreads(current).find(t => t.needs === "decision")!, onSent });
  await act(async () => { micProps.onStart?.(); micProps.onResult(recording); });
  expect(useProjectStore.getState().revise).toHaveBeenCalledTimes(1);
  expect(onSent).toHaveBeenCalledTimes(1);
  // The typed message is still the editor's to send, so the box stays as it is.
  await type("And lower the music");
  await act(async () => { micProps.onStart?.(); micProps.onResult(recording); });
  expect(useProjectStore.getState().revise).toHaveBeenCalledTimes(2);
  expect(onSent).toHaveBeenCalledTimes(1);
  expect(container.querySelector<HTMLTextAreaElement>(".composer-input textarea")!.value).toBe("And lower the music");
});

it("doesn't tell the page a message went out while text typed since is still in the box", async () => {
  const box = () => container.querySelector<HTMLTextAreaElement>(".composer-input textarea")!.value;
  const onSent = vi.fn();
  let land!: () => void;
  const revise = vi.fn().mockImplementation(() => new Promise<void>(resolve => { land = resolve; }));
  await act(async () => useProjectStore.setState({ revise }));
  await show({ thread: buildThreads(current).find(t => t.needs === "decision")!, onSent });
  await type("Keep the pause");
  await submit();
  expect(revise).toHaveBeenCalledTimes(1);
  // The editor types on before the message has landed. What they typed since is still theirs to send, aimed where it
  // was. The message itself has gone, so it leaves the box: sent again with the rest, it would go out twice.
  await type("Keep the pause and the breath too");
  await act(async () => land());
  expect(onSent).not.toHaveBeenCalled();
  expect(box()).toBe("and the breath too");
  expect(revise).toHaveBeenCalledTimes(1);
  // Text that no longer starts with what was sent is the editor's own rewrite of it, and stays whole.
  await type("Keep the pause");
  await submit();
  await type("Keep the long pause");
  await act(async () => land());
  expect(box()).toBe("Keep the long pause");
  expect(revise).toHaveBeenCalledTimes(2);
  // Sent in its turn with nothing typed after it, the box empties and the page is told.
  await submit();
  await act(async () => land());
  expect(revise).toHaveBeenCalledTimes(3);
  expect(box()).toBe("");
  expect(onSent).toHaveBeenCalledTimes(1);

  // The same goes for text typed while a spoken message is still being written down.
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  let heard!: (result: { text: string }) => void;
  vi.spyOn(api, "speechToText").mockImplementation(() => new Promise(resolve => { heard = resolve; }));
  const recording = { blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/mp4" };
  await show({ thread: buildThreads(current).find(t => t.needs === "decision")!, onSent });
  await act(async () => { micProps.onStart?.(); micProps.onResult(recording); });
  await type("And lower the music");
  await act(async () => heard({ text: "Keep the last word" }));
  await act(async () => land());
  expect(revise).toHaveBeenCalledTimes(4);
  expect(revise.mock.calls[3]![1]).toMatchObject({ text: "Keep the last word" });
  expect(onSent).toHaveBeenCalledTimes(1);
  expect(box()).toBe("And lower the music");

  // Aiming the box at another edit while a message is on its way keeps the page untold as well: that target is for the next message.
  await type("");
  const wrap = { changeId: "chg_ready", editIndex: 2, time: 11.5, clipIds: [], label: "wrap" };
  await act(async () => { micProps.onStart?.(); micProps.onResult(recording); });
  await act(async () => useUiStore.getState().setAgentContext(wrap));
  await act(async () => heard({ text: "Hold the last word" }));
  await act(async () => land());
  expect(revise).toHaveBeenCalledTimes(5);
  expect(onSent).toHaveBeenCalledTimes(1);
  expect(useUiStore.getState().agentContext).toBe(wrap);
  await type("Make it longer");
  await submit();
  await act(async () => useUiStore.getState().setAgentContext({ ...wrap, editIndex: 1, label: "captions" }));
  await act(async () => land());
  expect(onSent).toHaveBeenCalledTimes(1);
  expect(box()).toBe("");
  expect(useUiStore.getState().agentContext).toMatchObject({ label: "captions" });

  // A spoken message that couldn't be sent stays for the editor, and the page isn't told.
  await act(async () => useUiStore.getState().setAgentContext(null));
  await act(async () => useProjectStore.setState({ revise: vi.fn().mockRejectedValue(new Error("Engine unreachable")) }));
  await act(async () => { micProps.onStart?.(); micProps.onResult(recording); });
  await act(async () => heard({ text: "One more thing" }));
  expect(onSent).toHaveBeenCalledTimes(1);
  expect(box()).toBe("One more thing");
});

it("leaves an earlier request's draft clean when its spoken message lands after the box moved on", async () => {
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  let heard!: (result: { text: string }) => void;
  vi.spyOn(api, "speechToText").mockImplementation(() => new Promise(resolve => { heard = resolve; }));
  const onSent = vi.fn();
  const thread = buildThreads(current).find(t => t.needs === "decision")!;
  const first = JSON.stringify([PRJ, thread.id]);
  await act(async () => useUiStore.getState().openDraft(PRJ, thread.id));
  await show({ thread, onSent });
  await act(async () => { micProps.onStart?.(); micProps.onResult({ blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/mp4" }); });
  // While it is written down the editor moves the box to the project and types there.
  await act(async () => useUiStore.getState().openDraft(PRJ));
  await act(async () => useUiStore.getState().setAgentDraft("Something else"));
  await act(async () => heard({ text: "Keep the last word" }));
  expect(useProjectStore.getState().revise).toHaveBeenCalledTimes(1);
  expect(useUiStore.getState().savedDrafts[first]).toBeUndefined();
  expect(useUiStore.getState().agentDraft).toBe("Something else");
  expect(onSent).toHaveBeenCalledTimes(1);
});

it("tells the page a spoken message is in the box while it is recorded and written down, so the box isn't aimed elsewhere", async () => {
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  let heard!: (result: { text: string }) => void;
  vi.spyOn(api, "speechToText").mockImplementation(() => new Promise(resolve => { heard = resolve; }));
  const thread = buildThreads(current).find(t => t.needs === "decision")!;
  await act(async () => useUiStore.getState().openDraft(PRJ, thread.id));
  await show({ thread });
  const speaking = () => useUiStore.getState().speaking;
  expect(speaking()).toBe(false);
  await act(async () => { micProps.onStart?.(); micProps.onRecording?.(true); });
  expect(speaking()).toBe(true);
  // The recording stops and is written down: still a message on its way.
  await act(async () => { micProps.onRecording?.(false); micProps.onResult({ blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/mp4" }); });
  expect(speaking()).toBe(true);
  await act(async () => heard({ text: "Keep the last word" }));
  expect(useProjectStore.getState().revise).toHaveBeenCalledTimes(1);
  expect(speaking()).toBe(false);
  // A recording that never made a message lets the box go too, and so does the box going away mid-recording.
  await act(async () => micProps.onRecording?.(true));
  await act(async () => micProps.onRecording?.(false));
  expect(speaking()).toBe(false);
  await act(async () => micProps.onRecording?.(true));
  await act(async () => root.render(null));
  expect(speaking()).toBe(false);
});

it("recovers a failed spoken edit in the project where it was recorded", async () => {
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  let finish!: (result: { text: string }) => void;
  vi.spyOn(api, "speechToText").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  useProjectStore.setState({ createTask: vi.fn().mockRejectedValue(new Error("Engine unreachable")) });
  useUiStore.getState().openDraft(PRJ);
  await selectPoint({ time: 3.5, mediaId: project.media[0]!.id, clipIds: [] });
  await show();
  await act(async () => { micProps.onStart?.(); micProps.onResult({ blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/mp4" }); });
  // Another target reached the empty box before the project closed.
  await act(async () => useUiStore.getState().setAgentContext({ time: 8, mediaId: project.media[0]!.id, clipIds: [] }));
  await act(async () => root.render(null));
  useUiStore.getState().openDraft("another-project");
  await act(async () => finish({ text: "Trim this take." }));
  expect(useUiStore.getState().agentDraft).toBe("");
  useUiStore.getState().openDraft(PRJ);
  expect(useUiStore.getState()).toMatchObject({ agentDraft: "Trim this take.", agentContext: { time: 3.5, mediaId: project.media[0]!.id } });
});

it("puts a spoken message that couldn't be sent back with the request it was said to, not in the box aimed elsewhere since", async () => {
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  let heard!: (result: { text: string }) => void;
  vi.spyOn(api, "speechToText").mockImplementation(() => new Promise(resolve => { heard = resolve; }));
  useProjectStore.setState({ revise: vi.fn().mockRejectedValue(new Error("Engine unreachable")) });
  const thread = buildThreads(current).find(t => t.needs === "decision")!;
  const first = JSON.stringify([PRJ, thread.id]);
  await act(async () => useUiStore.getState().openDraft(PRJ, thread.id));
  await show({ thread });
  await act(async () => { micProps.onStart?.(); micProps.onResult({ blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/mp4" }); });
  // While it is written down the editor turns the box to Scarlet's question in another request.
  await act(async () => useUiStore.getState().openDraft(PRJ, "asking"));
  await act(async () => heard({ text: "Keep the last word" }));
  expect(useUiStore.getState().agentDraft).toBe("");
  expect(useUiStore.getState().savedDrafts[first]).toMatchObject({ agentDraft: "Keep the last word" });
  // Back on that request, the words are in the box as they were said.
  await act(async () => useUiStore.getState().openDraft(PRJ, thread.id));
  expect(useUiStore.getState().agentDraft).toBe("Keep the last word");
});

/** The edit-point icon at the start of the box, its card opened by a click, and that card's rows. */
const aimIcon = () => container.querySelector<HTMLButtonElement>(".composer-box .composer-row > .composer-aim .composer-aim-icon");
const openAim = () => act(async () => { if (aimIcon()!.getAttribute("aria-expanded") !== "true") aimIcon()!.click(); });
const aimRows = () => [...container.querySelectorAll(".composer-aim-row")].map(row => [row.querySelector(".composer-aim-name")?.textContent, row.querySelector(".composer-aim-detail")?.textContent]);
const aimClear = (name: string) => [...container.querySelectorAll(".composer-aim-row")].find(row => row.querySelector(".composer-aim-name")?.textContent === name)!
  .querySelector<HTMLButtonElement>(".composer-aim-clear")!;

it("folds what the message revises into an edit-point icon, whose card's × hands the choice back to the page", async () => {
  // With nothing aimed the box is as it always was.
  await show();
  expect(aimIcon()).toBeNull();
  expect(container.querySelector(".composer-tag")).toBeNull();
  // The icon sits in the box's row, before the text, and says on itself what the message is about.
  const onClearTarget = vi.fn();
  await show({ targetTag: "Cut at 2:05", onClearTarget });
  expect(container.querySelector(".composer-row")?.firstElementChild?.classList.contains("composer-aim")).toBe(true);
  expect(aimIcon()!.getAttribute("aria-label")).toBe("About Cut at 2:05");
  expect(container.querySelector(".composer-aim-card")).toBeNull();
  // Its card lists it, with a × that takes it off.
  await openAim();
  expect(aimRows()).toEqual([["Cut at 2:05", "the cut that’s open"]]);
  expect(aimClear("Cut at 2:05").getAttribute("aria-label")).toBe("Start a new edit instead of revising cut at 2:05");
  // The page decides what taking it off means; the box keeps what was typed and its own target as they are.
  await type("Keep the laugh");
  await act(async () => aimClear("Cut at 2:05").click());
  expect(onClearTarget).toHaveBeenCalledTimes(1);
  expect(useUiStore.getState().agentDraft).toBe("Keep the laugh");
  // "Answer" and "Reply" say in words who the message goes to, and stay a tag.
  await show({ targetTag: "Reply", thread: buildThreads(current)[0] });
  expect([aimIcon(), container.querySelector(".composer-tag-name")?.textContent]).toEqual([null, "Reply"]);
});

it("holds a stretch marked on the timeline in the same icon, whose own × takes off the stretch alone", async () => {
  const cut: AgentContext = { changeId: "chg_1", cutIndex: 0, version: "v1", time: 125, end: 127, clipIds: [], label: "Cut at 2:05" };
  await act(async () => useUiStore.getState().setAgentContext({ ...cut, markedRange: { start: 42, end: 51.5, version: "v2" } }));
  await show({ targetTag: "Cut at 2:05" });
  // One icon for both, the same size as for one: its card lists the cut, then the stretch.
  expect(container.querySelectorAll(".composer-aim-icon")).toHaveLength(1);
  expect(aimIcon()!.getAttribute("aria-label")).toBe("About Cut at 2:05 and 0:42 – 0:51");
  await openAim();
  expect(aimRows()).toEqual([["Cut at 2:05", "the cut that’s open"], ["0:42 – 0:51", "9.5 s you marked"]]);
  expect(aimClear("0:42 – 0:51").getAttribute("aria-label")).toBe("Take the marked range 0:42 – 0:51 off the message");
  await act(async () => aimClear("0:42 – 0:51").click());
  // The message is still about the cut, at the cut's own time.
  expect(useUiStore.getState().agentContext).toEqual(cut);
  await openAim();
  expect(aimRows()).toEqual([["Cut at 2:05", "the cut that’s open"]]);
  // A stretch marked with nothing open is the whole aim: taking it off leaves a new edit about the whole video.
  await act(async () => useUiStore.getState().setAgentContext({ time: 42, end: 51.5, clipIds: [], markedRange: { start: 42, end: 51.5 } }));
  await show();
  await openAim();
  expect(aimRows()).toEqual([["0:42 – 0:51", "9.5 s you marked"]]);
  await act(async () => aimClear("0:42 – 0:51").click());
  expect(useUiStore.getState().agentContext).toBeNull();
  expect(aimIcon()).toBeNull();
});

it("shows the icon's card by itself for a moment when something is attached, then folds it with a pulse", async () => {
  vi.useFakeTimers();
  try {
    const cut: AgentContext = { changeId: "chg_1", cutIndex: 0, version: "v1", time: 125, end: 127, clipIds: [], label: "Cut at 2:05" };
    await act(async () => useUiStore.getState().setAgentContext(cut));
    await show({ targetTag: "Cut at 2:05" });
    // What the box was aimed at when it opened doesn't arrive.
    expect(container.querySelector(".composer-aim-card")).toBeNull();
    await act(async () => useUiStore.getState().setAgentContext({ ...cut, markedRange: { start: 42, end: 51.5 } }));
    const lit = () => [...container.querySelectorAll(".composer-aim-row.is-new .composer-aim-name")].map(n => n.textContent);
    expect(lit()).toEqual(["0:42 – 0:51"]);
    expect(aimIcon()!.getAttribute("aria-expanded")).toBe("true");
    await act(async () => { vi.advanceTimersByTime(ARRIVAL_MS); });
    expect(container.querySelector(".composer-aim-card")).toBeNull();
    expect(aimIcon()!.classList.contains("is-pulsing")).toBe(true);
    // Swapping one cut for another, as ↑ and ↓ do, stays folded.
    await show({ targetTag: "Cut at 3:10" });
    expect(container.querySelector(".composer-aim-card")).toBeNull();
    // Open, it lights what it holds on the timeline; closed, it doesn't.
    expect(useUiStore.getState().aimLit).toBe(false);
    await openAim();
    expect(useUiStore.getState().aimLit).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps the icon's × from taking the box elsewhere while a spoken message is in it, which would drop the recording", async () => {
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  let heard!: (result: { text: string }) => void;
  vi.spyOn(api, "speechToText").mockImplementation(() => new Promise(resolve => { heard = resolve; }));
  const onClearTarget = vi.fn();
  const thread = buildThreads(current).find(t => t.needs === "decision")!;
  await act(async () => useUiStore.getState().openDraft(PRJ, thread.id));
  await show({ thread, targetTag: "Cut at 2:05", onClearTarget });
  await openAim();
  const clear = () => aimClear("Cut at 2:05");
  expect(clear().disabled).toBe(false);
  // While it records, and while what was said is written down and sent, the × waits.
  await act(async () => { micProps.onStart?.(); micProps.onRecording?.(true); });
  expect(clear().disabled).toBe(true);
  await act(async () => clear().click());
  expect(onClearTarget).not.toHaveBeenCalled();
  await act(async () => { micProps.onRecording?.(false); micProps.onResult({ blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/mp4" }); });
  expect(clear().disabled).toBe(true);
  // Once it is out, the × takes the tag off again.
  await act(async () => heard({ text: "Keep the last word" }));
  expect(clear().disabled).toBe(false);
  await act(async () => clear().click());
  expect(onClearTarget).toHaveBeenCalledTimes(1);
});

it("changes a queued request's words in the box, across its whole width, saving them on send and leaving them on Esc", async () => {
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  vi.spyOn(api, "speechToText").mockResolvedValue({ text: "Keep the breath too" });
  // A message being written waits while the box holds the queued request's words.
  useUiStore.setState({ agentDraft: "Tighten every pause" });
  const rewording = { id: "task_queued", text: "Keep the aside.", onChange: vi.fn(), onSave: vi.fn().mockResolvedValue(undefined), onCancel: vi.fn() };
  await show({ rewording, targetTag: "At 0:03" });
  const input = container.querySelector<HTMLTextAreaElement>(".composer-input textarea")!;
  expect(input.value).toBe("Keep the aside.");
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe("Keep the aside.".length);
  // Nothing sits before them: the tray's row says which request they are, and the box's own tag waits with its message.
  expect(container.querySelector(".composer-tag")).toBeNull();
  expect(container.querySelector(".composer-row")?.firstElementChild?.classList.contains("composer-message")).toBe(true);
  expect(container.querySelector(".composer-destination")?.textContent).toBe("Changing the words of a queued request");
  // Typing changes them, not the message being written.
  await type("Keep the aside, trim the breath.");
  expect(rewording.onChange).toHaveBeenLastCalledWith("Keep the aside, trim the breath.");
  expect(useUiStore.getState().agentDraft).toBe("Tighten every pause");
  // Sending saves them. Nothing new is sent to Scarlet.
  const save = container.querySelector<HTMLButtonElement>(".composer-send")!;
  expect(save.title).toBe("Save the new words");
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  expect(rewording.onSave).toHaveBeenCalledWith("Keep the aside.", undefined);
  expect(useProjectStore.getState().createTask).not.toHaveBeenCalled();
  // What was said takes their place.
  await act(async () => { micProps.onStart?.(); micProps.onResult({ blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/mp4" }); });
  expect(rewording.onSave).toHaveBeenLastCalledWith("Keep the breath too");
  expect(useUiStore.getState().agentContext).toBeNull();
  // Esc leaves them as they were.
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(rewording.onCancel).toHaveBeenCalledTimes(1);
  // A save that fails says why under the box.
  rewording.onSave.mockRejectedValueOnce(new Error("Scarlet has already started on this request."));
  await submit();
  expect(container.querySelector(".composer-dock")?.textContent).toContain("Scarlet has already started on this request.");
});

it("saves a queued request's new words with the skills their /commands name, as a send does", async () => {
  const skill = db.skills.find(isDialogueGuide)!;
  useSkillsStore.setState({ skills: [skill], status: "ready" });
  let text = "/dialogue-pass Keep the aside.";
  const rewording = { id: "task_queued", get text() { return text; }, onChange: vi.fn((t: string) => { text = t; }),
    onSave: vi.fn().mockResolvedValue(undefined), onCancel: vi.fn() };
  await show({ rewording });
  await submit();
  expect(rewording.onSave).toHaveBeenLastCalledWith("/dialogue-pass Keep the aside.", [skill.id]);
  // Words that no longer name a skill save with none, so the old words' skill doesn't run.
  text = "Keep the aside.";
  await submit();
  expect(rewording.onSave).toHaveBeenLastCalledWith("Keep the aside.", undefined);
  // A skill that isn't there is said under the box, and nothing is saved.
  text = "/no-such-skill Keep it.";
  await submit();
  expect(rewording.onSave).toHaveBeenCalledTimes(2);
  expect(container.querySelector(".composer-dock")?.textContent).toContain("No enabled skill named /no-such-skill.");
});

it("words a point in the icon's card as the moment the message is about, and its × as the whole video", async () => {
  const onClearTarget = vi.fn();
  await show({ targetTag: "At 18:28", targetIsPoint: true, onClearTarget });
  await openAim();
  expect(aimRows()).toEqual([["At 18:28", "the moment you picked"]]);
  expect(aimClear("At 18:28").getAttribute("aria-label")).toBe("Take “At 18:28” off: the message is about the whole video");
  await act(async () => aimClear("At 18:28").click());
  expect(onClearTarget).toHaveBeenCalledTimes(1);
});

it("keeps the attached moment while the editor writes, and offers a whole-video request once the draft is erased", async () => {
  await show();
  await selectPoint({ time: 10, clipIds: [] });
  await type("Zoom in here");
  await act(async () => usePlayerStore.setState({ time: 42, playing: true }));
  await type("Zoom in here, slowly");
  expect(useUiStore.getState().agentContext).toMatchObject({ time: 10 });
  await type("");
  expect(useUiStore.getState().agentContext).toBeNull();
  await type("Zoom in on every chart");
  await submit();
  expect(useProjectStore.getState().createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    instruction: "Zoom in on every chart", context: { version: project.head },
  }));
});

it("keeps an explicit range or whole-video choice when text is erased", async () => {
  await show();
  // A target the editor aimed the box at stays through an emptied box, and so does a timestamp they took off.
  const chosen = { time: 2, end: 5, clipIds: [], label: "opening line" };
  await act(async () => useUiStore.getState().setAgentContext(chosen));
  await type("Keep these words");
  await type("");
  expect(useUiStore.getState().agentContext).toBe(chosen);
  await act(async () => useUiStore.getState().setAgentContext("whole"));
  await type("Make it shorter");
  await type("");
  expect(useUiStore.getState().agentContext).toBe("whole");
});

it("dictates for the whole video while a time is offered, including after an abandoned hold", async () => {
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  const createVoiceNote = vi.fn();
  useProjectStore.setState({ createVoiceNote });
  vi.spyOn(api, "speechToText").mockResolvedValue({ text: "Fix the levels throughout" });
  const onSelect = vi.fn();
  await show({ editHere: { time: "0:03", onSelect } });
  await act(async () => { micProps.onStart?.(); });
  expect(useUiStore.getState().agentContext).toBeNull();
  await act(async () => usePlayerStore.getState().setTime(300));
  await act(async () => { micProps.onStart?.(); });
  await act(async () => usePlayerStore.getState().setTime(310));
  await act(async () => { micProps.onResult({ blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/mp4" }); });
  expect(useProjectStore.getState().createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    instruction: "Fix the levels throughout", voiceTranscript: "Fix the levels throughout", context: { version: project.head },
  }));
  expect(onSelect).not.toHaveBeenCalled();
  expect(createVoiceNote).not.toHaveBeenCalled();
});

it("says why Enter did nothing when no agent or model can take the message", async () => {
  useHostsStore.setState({ hosts: [] });
  await show();
  const field = container.querySelector("textarea")!;
  const enter = () => act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  const said = () => container.querySelector('[role="alert"]')?.textContent;
  await type("Tighten the opening");
  expect(said()).toBeUndefined();
  await enter();
  expect(said()).toBe(NO_AGENT_REASON);
  expect(useProjectStore.getState().createNote).not.toHaveBeenCalled();
  expect(field.value).toBe("Tighten the opening");
  // Typing on clears the line, as it does any other, and Enter says it again.
  await type("Tighten the opening a little");
  expect(said()).toBeUndefined();
  await enter();
  expect(said()).toBe(NO_AGENT_REASON);
  // Once an agent can take the message the line goes by itself, and Enter sends.
  await act(async () => useHostsStore.setState({ hosts: db.hosts }));
  expect(said()).toBeUndefined();
  await enter();
  expect(useProjectStore.getState().createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({ instruction: "Tighten the opening a little" }));
  expect(said()).toBeUndefined();
});

it("gives the mic a reason only when no agent can take the message, not while one is sending", async () => {
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  let land!: () => void;
  const createTask = vi.fn(() => new Promise<typeof db.tasks[number]>(resolve => { land = () => resolve(db.tasks[0]!); }));
  useProjectStore.setState({ createTask });
  useHostsStore.setState({ hosts: [] });
  await show();
  expect(micProps).toMatchObject({ disabled: true, disabledReason: NO_AGENT_REASON });
  await act(async () => useHostsStore.setState({ hosts: db.hosts }));
  expect(micProps.disabled).toBe(false);
  // While the message is on its way the mic waits for it. That isn't a missing agent, so it says nothing of one.
  await type("Tighten the opening");
  await submit();
  expect(createTask).toHaveBeenCalledTimes(1);
  expect(micProps.disabled).toBe(true);
  expect(micProps.disabledReason).toBeUndefined();
  await act(async () => land());
  expect(micProps.disabled).toBe(false);
});

it("draws nothing until a project is open, and the box once one is", async () => {
  useProjectStore.setState({ current: null });
  await show();
  expect(container.querySelector(".composer-dock")).toBeNull();
  // The project arrives under a box that is already on the page, and leaves again.
  await act(async () => useProjectStore.setState({ current }));
  expect(container.querySelector(".composer-input textarea")).not.toBeNull();
  await type("Tighten the opening");
  await act(async () => useProjectStore.setState({ current: null }));
  expect(container.querySelector(".composer-dock")).toBeNull();
});

it("keeps a point the playhead still rests on as it was picked, on the version the player shows", async () => {
  await show();
  await act(async () => usePlayerStore.setState({ time: 8, playing: false }));
  // A point picked while a suggestion plays is on the suggestion's version, where 0:08 is other footage than on the working cut.
  const picked = { time: 8, version: "v_suggested", clipIds: ["clip_in_suggestion"] };
  await selectPoint(picked);
  await type("Z");
  expect(useUiStore.getState().agentContext).toBe(picked);
  await type("Zoom in here");
  await submit();
  expect(useProjectStore.getState().createNote).toHaveBeenCalledWith(PRJ, expect.objectContaining({ text: "Zoom in here", time: 8, version: "v_suggested", clipIds: ["clip_in_suggestion"] }));
});

it("clears the chosen point after a voice note is sent even if playback moved while recording", async () => {
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  const createVoiceNote = vi.fn().mockResolvedValue({ note: db.notes[0] });
  useProjectStore.setState({ createVoiceNote });
  const onSent = vi.fn();
  await show({ onSent });
  await selectPoint({ time: 10, clipIds: [] });
  await act(async () => { micProps.onStart?.(); });
  await act(async () => usePlayerStore.setState({ time: 42, playing: true }));
  await act(async () => { micProps.onResult({ blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/mp4" }); });
  expect(createVoiceNote).toHaveBeenCalledWith(PRJ, expect.anything(), expect.objectContaining({ time: 10 }));
  // The message is out: the box is empty and aimed at nothing, and the page hears of it.
  expect(useUiStore.getState().agentContext).toBeNull();
  expect(onSent).toHaveBeenCalledTimes(1);
});

it("leaves a queued request's words in the box when Esc only puts away an input method's candidates", async () => {
  const rewording = { id: "task_queued", text: "Keep the aside.", onChange: vi.fn(), onSave: vi.fn().mockResolvedValue(undefined), onCancel: vi.fn() };
  await show({ rewording });
  const input = container.querySelector<HTMLTextAreaElement>(".composer-input textarea")!;
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true })); });
  expect(rewording.onCancel).not.toHaveBeenCalled();
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(rewording.onCancel).toHaveBeenCalledTimes(1);
});

it("doesn't type the repeats of the key that brought the cursor to the box, and types the next key pressed", async () => {
  await show();
  const input = container.querySelector<HTMLTextAreaElement>(".composer-input textarea")!;
  const key = async (init: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    await act(async () => { input.dispatchEvent(event); });
    return event.defaultPrevented;
  };
  // N or R, pressed on the page, hands the box the cursor while the key may still be down.
  await act(async () => useUiStore.getState().focusComposer());
  expect(document.activeElement).toBe(input);
  expect([await key({ key: "n", repeat: true }), await key({ key: "n", repeat: true })]).toEqual([true, true]);
  // The next key pressed is typed, and so are its repeats: holding a letter in the box is the editor's own.
  expect([await key({ key: "a" }), await key({ key: "a", repeat: true })]).toEqual([false, false]);
});

it("takes a sent message out of text typed after it, also once the box has moved to another request", () => {
  const ui = useUiStore.getState();
  const captions = { changeId: "chg_1", editIndex: 1, time: 0.2, clipIds: [], label: "captions" };
  ui.openDraft("one", "request");
  ui.setAgentContext(captions);
  ui.setAgentDraft("Make them smaller");
  const sent = useUiStore.getState();
  // Typed on after Enter, before the message landed: the rest is the next message, still about the same edit.
  ui.setAgentDraft("Make them smaller and yellow");
  ui.clearSentDraft(sent.draftOwner, sent);
  expect(useUiStore.getState()).toMatchObject({ agentDraft: "and yellow", agentContext: captions });
  // The same for a request the box has left meanwhile: its saved draft keeps only what came after.
  ui.setAgentDraft("Lower the music");
  const second = useUiStore.getState();
  ui.setAgentDraft("Lower the music under the interview");
  ui.openDraft("one", "another request");
  ui.clearSentDraft(second.draftOwner, second);
  expect(useUiStore.getState().savedDrafts[second.draftOwner!]).toEqual({ agentDraft: "under the interview", agentContext: captions });
});

it("drops dictation for a closed rewording when the same request is reopened", async () => {
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  let finish!: (result: { text: string }) => void;
  vi.spyOn(api, "speechToText").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const first = { id: "first", text: "Keep the intro.", onChange: vi.fn(), onSave: vi.fn(), onCancel: vi.fn() };
  const next = { ...first, onSave: vi.fn() };
  await show({ rewording: first });
  await act(async () => { micProps.onStart?.(); micProps.onResult({ blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/mp4" }); });
  await show();
  await show({ rewording: next });
  await act(async () => finish({ text: "Shorten the intro." }));
  expect(first.onSave).not.toHaveBeenCalled();
  expect(next.onSave).not.toHaveBeenCalled();
  expect(useProjectStore.getState().createTask).not.toHaveBeenCalled();
});

it("sends a message being spoken as itself when a queued request's words take the box meanwhile, and drops words said for ones put back", async () => {
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  let heard!: (result: { text: string }) => void;
  vi.spyOn(api, "speechToText").mockImplementation(() => new Promise(resolve => { heard = resolve; }));
  const thread = buildThreads(current).find(t => t.needs === "decision")!;
  await act(async () => useUiStore.getState().openDraft(PRJ, thread.id));
  const rewording = { id: "task_queued", text: "Keep the aside.", onChange: vi.fn(), onSave: vi.fn().mockResolvedValue(undefined), onCancel: vi.fn() };
  // Spoken as a message of its own. A queued request's words are in the box by the time it is written down.
  await show({ thread });
  await act(async () => { micProps.onStart?.(); micProps.onResult({ blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/mp4" }); });
  await show({ thread, rewording });
  await act(async () => heard({ text: "Keep the last word" }));
  expect(rewording.onSave).not.toHaveBeenCalled();
  expect(useProjectStore.getState().revise).toHaveBeenCalledTimes(1);
  // Spoken for the queued request, whose words the editor put back before it was written down: nothing is sent.
  await act(async () => { micProps.onStart?.(); micProps.onResult({ blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/mp4" }); });
  await show({ thread });
  await act(async () => heard({ text: "Trim the breath" }));
  expect(rewording.onSave).not.toHaveBeenCalled();
  expect(useProjectStore.getState().revise).toHaveBeenCalledTimes(1);
});

it("saves a queued request's words once while Enter is held, and doesn't send the message that comes back to the box", async () => {
  useUiStore.setState({ agentDraft: "Tighten every pause", agentContext: "whole" });
  const rewording = { id: "task_queued", text: "Keep the aside.", onChange: vi.fn(), onSave: vi.fn().mockResolvedValue(undefined), onCancel: vi.fn() };
  await show({ rewording });
  const input = container.querySelector<HTMLTextAreaElement>(".composer-input textarea")!;
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  expect(rewording.onSave).toHaveBeenCalledTimes(1);
  // The words are saved and the message being written is back, with Enter still down.
  await show();
  await act(async () => container.querySelector<HTMLTextAreaElement>(".composer-input textarea")!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true })));
  expect(useProjectStore.getState().createTask).not.toHaveBeenCalled();
  expect(useUiStore.getState().agentDraft).toBe("Tighten every pause");
});

it("takes the caret after the message when the page hands it the keyboard, and leaves a caret already in it alone", async () => {
  await show();
  await type("Keep the laugh");
  const field = container.querySelector<HTMLTextAreaElement>(".composer-input textarea")!;
  // A box that was just built around its message has the caret before the first letter.
  field.setSelectionRange(0, 0);
  await act(async () => useUiStore.getState().focusComposer());
  expect(document.activeElement).toBe(field);
  expect([field.selectionStart, field.selectionEnd]).toEqual([14, 14]);
  // The editor is typing in the middle of it when the page asks again: the caret stays put.
  field.setSelectionRange(4, 4);
  await act(async () => useUiStore.getState().focusComposer());
  expect([field.selectionStart, field.selectionEnd]).toEqual([4, 4]);
});

it("says what went wrong with the microphone on the line over the box, until the editor types or tries the mic again", async () => {
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  await show();
  const line = () => container.querySelector('.composer-dock > [role="alert"]')?.textContent;
  const denied = "Microphone access was denied. Allow the microphone for this site and try again.";
  expect(line()).toBeUndefined();
  await act(async () => micProps.onError?.(denied));
  expect(line()).toBe(denied);
  await type("Tighten the opening");
  expect(line()).toBeUndefined();
  // Allowed since, the mic is tried again: the old refusal isn't still said over a recording that is under way.
  await act(async () => micProps.onError?.(denied));
  expect(line()).toBe(denied);
  await act(async () => micProps.onStart?.());
  expect(line()).toBeUndefined();
  // Refused again, it says so again once the mic lets go.
  await act(async () => { micProps.onError?.(denied); });
  expect(line()).toBe(denied);
});
