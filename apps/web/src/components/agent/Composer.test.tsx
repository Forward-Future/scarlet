// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { builtInCommand, commandGuides } from "@scarlet/shared";

/** The skill that guides the dialogue pass, by what its header says. */
const dialogueGuide = (skills: Parameters<typeof commandGuides>[1]) => commandGuides(builtInCommand("first-cut").name, skills)[0];
import { api } from "../../lib/client";
import { flushAppLog, startAppLog, stopAppLog } from "../../lib/appLog";
import { buildDb, PRJ } from "../../lib/mock/fixtures";
import { dropTargets, fileDropZone } from "../../lib/dropTargets";
import { useAttachmentsStore } from "../../stores/attachments";
import { usePictureMarksStore } from "../../stores/pictureMarks";
import * as markedFrame from "../../lib/markedFrame";
import { buildThreads } from "../../lib/threads";
import { useHostsStore } from "../../stores/hosts";
import { usePlayerStore } from "../../stores/player";
import { useProjectStore, type ProjectData } from "../../stores/project";
import { useSkillsStore } from "../../stores/skills";
import { playheadPoints, useUiStore, type AgentContext } from "../../stores/ui";
import { NO_AGENT_REASON } from "./AgentChip";
import * as mic from "./MicButton";
import { Composer, NEW_EDIT_HINT } from "./Composer";
import { NotePopover } from "./NotePopover";
import { ProjectLayout } from "../shell/ProjectLayout";

const stores = [useProjectStore.getState(), useUiStore.getState(), usePlayerStore.getState(), useHostsStore.getState(), useSkillsStore.getState(),
  useAttachmentsStore.getState()] as const;
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
  useAttachmentsStore.setState(stores[5], true);
  usePictureMarksStore.setState({ marking: null, byProject: {} });
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
  const guide = dialogueGuide(db.skills)!;
  useSkillsStore.setState({ status: "ready", skills: [guide] });
  useUiStore.getState().offerFirstEditHint(PRJ);
  await show();
  expect(container.querySelector(".composer-box.first-edit-hint")).not.toBeNull();
  expect(container.querySelector('button[aria-label="Make a first cut"]')).toBeNull();
  expect(container.querySelector(".composer-first-cut")).toBeNull();
  expect(container.querySelector("textarea")!.value).toBe("");
});

it("logs what each press of send did, never the words: sent, ignored and why, or failed", async () => {
  const lines: string[] = [];
  startAppLog(batch => { lines.push(...batch); });
  try {
    await show();
    const enter = () => act(async () => { container.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    await enter();
    await type("Lower the music under the interview.");
    await enter();
    vi.mocked(useProjectStore.getState().createTask).mockRejectedValueOnce(new Error("The engine is busy."));
    await type("Trim the intro.");
    await enter();
    flushAppLog();
    const said = lines.filter(line => line.startsWith("[request]"));
    expect(said[0]).toMatch(/ send-ignored reason=empty how=typed dest=new-edit chars=0 aim=whole project=/);
    expect(said.some(line => / send how=typed dest=new-edit chars=36 /.test(line))).toBe(true);
    expect(said.some(line => / send-failed how=typed chars=15 name=Error error="The engine is busy."/.test(line))).toBe(true);
    expect(said.join("\n")).not.toMatch(/music|intro/);
  } finally {
    stopAppLog();
  }
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
  await act(() => container.querySelector<HTMLButtonElement>('[role="radio"][aria-label="Claude Code · Fable 5.1"]')!.click());
  expect(picker.textContent).toContain("Fable 5.1");
  await submit();
  expect(useProjectStore.getState().createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    instruction: "Tighten the opening", agent: "claude", model: "fable",
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
  const guide = dialogueGuide(db.skills)!;
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
    const modelPicker = editor.querySelector<HTMLButtonElement>('.skill-editor-toolbar button[aria-label="Choose model"]')!;
    await act(() => modelPicker.click());
    expect(editor.querySelector('[aria-label="Model selector"]')).not.toBeNull();
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(() => document.activeElement!.dispatchEvent(esc));
    expect(esc.defaultPrevented).toBe(true);
    expect(editor.open).toBe(true);
    expect(editor.querySelector('[aria-label="Model selector"]')).toBeNull();
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
  const skill = dialogueGuide(db.skills)!;
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
  await act(() => useUiStore.getState().setAgent({ agent: "claude", model: "fable" }));
  await type("Keep the first take");
  expect(action()!.getAttribute("aria-label")).toBe("Send reply");
  await submit();
  expect(useProjectStore.getState().createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    instruction: "Keep the first take", agent: "claude", model: "fable", context: expect.objectContaining({ threadId: thread.id }),
  }));
  await type("Another idea");
  await type("");
  expect(action()).toBeNull();
  expect(cancelTask).not.toHaveBeenCalled();
});

it("tags the box with a picked moment and sends it with the request", async () => {
  useHostsStore.setState({ hosts: [] });
  await show();
  const tag = () => container.querySelector('.composer-context-row .composer-scope');
  expect(tag()).toBeNull();
  expect(container.querySelector(".composer-edit-here")).toBeNull();
  const picked = { time: 443.25, version: project.head!, clipIds: [] };
  await type("Cut here");
  await act(async () => useUiStore.getState().setAgentContext(picked));
  expect(tag()?.textContent).toBe("7:23.250");
  expect(useUiStore.getState().agentDraft).toBe("Cut here");
  expect(container.querySelector<HTMLButtonElement>(".composer-input button.btn-primary")?.disabled).toBe(true);
  await act(async () => { usePlayerStore.setState({ time: 9 }); useHostsStore.setState({ hosts: db.hosts }); });
  expect(tag()?.textContent).toBe("7:23.250");
  await submit();
  expect(useProjectStore.getState().createNote).toHaveBeenCalledWith(PRJ, expect.objectContaining({ text: "Cut here", time: 443.25, version: project.head }));
  expect(tag()).toBeNull();
});

it("takes the tag off on Backspace in an empty box, but not on a held Backspace, and puts it back on ⌘Z", async () => {
  const onClearTarget = vi.fn();
  const onRestoreTarget = vi.fn(() => true);
  await show({ targetTag: "At 0:07", targetIsPoint: true, onClearTarget, onRestoreTarget });
  const press = (key: string, init: KeyboardEventInit = {}) => act(async () => {
    container.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
  await type("Zoom");
  await press("Backspace");
  expect(onClearTarget).not.toHaveBeenCalled();
  // ⌘Z with words in the box is the words' own undo.
  await press("z", { metaKey: true });
  expect(onRestoreTarget).not.toHaveBeenCalled();
  await type("");
  // Holding Backspace to clear the words stops at the empty box.
  await press("Backspace", { repeat: true });
  expect(onClearTarget).not.toHaveBeenCalled();
  await press("Backspace");
  expect(onClearTarget).toHaveBeenCalledTimes(1);
  await press("z", { metaKey: true });
  expect(onRestoreTarget).toHaveBeenCalledTimes(1);
  // A cut or an edit the box revises comes off the same way.
  await show({ targetTag: "Cut at 2:05", targetIsPoint: false, onClearTarget, onRestoreTarget });
  await press("Backspace");
  expect(onClearTarget).toHaveBeenCalledTimes(2);
  await press("z", { ctrlKey: true });
  expect(onRestoreTarget).toHaveBeenCalledTimes(2);
});

it("takes an Answer or a Reply tag off on Backspace in an empty box, as its × does, and puts it back on ⌘Z", async () => {
  const onClearTarget = vi.fn();
  const onRestoreTarget = vi.fn(() => true);
  const asking = buildThreads(current).find(t => t.question)!;
  await show({ thread: asking, targetTag: "Answer", onClearTarget, onRestoreTarget });
  const press = async (key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    await act(async () => { container.querySelector("textarea")!.dispatchEvent(event); });
    return event.defaultPrevented;
  };
  expect(container.querySelector(".composer-tag-name")?.textContent).toBe("Answer");
  // Words in the box are what Backspace deletes, and a held Backspace that just emptied it stops there.
  await type("Yes");
  await press("Backspace");
  await type("");
  await press("Backspace", { repeat: true });
  expect(onClearTarget).not.toHaveBeenCalled();
  expect(await press("Backspace")).toBe(true);
  expect(onClearTarget).toHaveBeenCalledTimes(1);
  await press("z", { metaKey: true });
  expect(onRestoreTarget).toHaveBeenCalledTimes(1);
  // The × does the same.
  await act(async () => container.querySelector<HTMLButtonElement>(".composer-tag-clear")!.click());
  expect(onClearTarget).toHaveBeenCalledTimes(2);
  // A reply to a request comes off the same way.
  await show({ thread: buildThreads(current)[0], targetTag: "Reply", onClearTarget, onRestoreTarget });
  expect(container.querySelector(".composer-tag-name")?.textContent).toBe("Reply");
  expect(await press("Backspace")).toBe(true);
  expect(onClearTarget).toHaveBeenCalledTimes(3);
});

it("says which of several waiting questions an answer is for, after the Answer tag's word", async () => {
  const asking = buildThreads(current).find(t => t.question)!;
  /** The tag's word, the count after it, and what the tag says on hover. */
  const tag = () => [container.querySelector(".composer-tag-name")?.textContent, container.querySelector(".composer-tag-note")?.textContent,
    container.querySelector<HTMLElement>(".composer-tag")?.title];
  // Scarlet asked two questions: the box answers them one at a time, in the order asked, and says which this one is.
  await show({ thread: asking, targetTag: "Answer", targetTagNote: "1 of 2" });
  expect(tag()).toEqual(["Answer", "1 of 2", "Answering question 1 of 2. The next follows once this is sent."]);
  // The count follows the word inside the tag, before its ×.
  expect([...container.querySelector(".composer-tag")!.children].map(el => el.className)).toEqual(["composer-tag-name", "composer-tag-note", "composer-tag-clear"]);
  // One question waiting: the tag is as it was, with no count.
  await show({ thread: asking, targetTag: "Answer" });
  expect(tag()).toEqual(["Answer", undefined, "Answering Scarlet’s question"]);
  // A count is an answer's alone. A reply has none, and neither has a cut or an edit the box is aimed at.
  await show({ thread: buildThreads(current)[0], targetTag: "Reply", targetTagNote: "1 of 2" });
  expect(tag()).toEqual(["Reply", undefined, "Replying to this edit"]);
  await show({ thread: asking, targetTag: "Cut at 2:05", targetTagNote: "1 of 2" });
  expect(container.querySelector(".composer-tag-note")).toBeNull();
  expect(container.textContent).not.toContain("1 of 2");
  await show({ targetTag: "At 0:07", targetIsPoint: true, targetTagNote: "1 of 2" });
  expect(container.querySelector(".composer-tag-note")).toBeNull();
  expect(container.textContent).not.toContain("1 of 2");
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

  await show({ thread: asking, selectedEdit: { changeId: ready.latest!.id, editIndex: 0,
    label: "Sponsor transition", time: 8.75, end: 11.75, clipIds: [] } });
  await type("Keep the words on both sides");
  await submit();
  expect(useProjectStore.getState().answerTask).toHaveBeenLastCalledWith(asking.question!.id,
    "Edit at 0:08 · Sponsor transition — Keep the words on both sides", undefined);
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

it("dictates into the box aimed at the explicitly attached moment or open thread, and sends on Enter", async () => {
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  const createVoiceNote = vi.fn();
  useProjectStore.setState({ createVoiceNote });
  vi.spyOn(api, "speechToText").mockResolvedValue({ text: "Keep the last word" });
  const input = () => container.querySelector<HTMLTextAreaElement>(".composer-input textarea")!;
  await show();
  const recording = { blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/mp4" };
  await selectPoint({ time: 3.5, clipIds: [] });
  const finishRecording = micProps.onResult;
  await act(async () => { micProps.onStart?.(); });
  await act(async () => usePlayerStore.getState().setTime(8));
  await act(async () => { finishRecording(recording); });
  expect(micProps.review).toBe(true);
  expect(input().value).toBe("Keep the last word");
  expect(useUiStore.getState().agentContext).toMatchObject({ time: 3.5 });
  expect(createVoiceNote).not.toHaveBeenCalled();
  expect(useProjectStore.getState().createNote).not.toHaveBeenCalled();
  await submit();
  expect(useProjectStore.getState().createNote).toHaveBeenCalledWith(PRJ, expect.objectContaining({ time: 3.5, text: "Keep the last word" }));
  expect(useUiStore.getState().agentContext).toBeNull();

  const ready = buildThreads(current).find(t => t.needs === "decision")!;
  await show({ thread: ready });
  const picker = container.querySelector<HTMLButtonElement>('.composer-context-row .composer-model [aria-haspopup="dialog"]')!;
  await act(() => picker.click());
  await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Claude Code"]')!.click());
  await act(() => container.querySelector<HTMLButtonElement>('[role="radio"][aria-label="Claude Code · Fable 5.1"]')!.click());
  expect(picker.textContent).toContain("Fable 5.1");
  await act(async () => { micProps.onStart?.(); micProps.onResult(recording); });
  expect(input().value).toBe("Keep the last word");
  expect(useProjectStore.getState().revise).not.toHaveBeenCalled();
  await submit();
  expect(useProjectStore.getState().revise).toHaveBeenCalledWith(ready.latest!.id,
    expect.objectContaining({ assignTo: "claude:fable", text: "Keep the last word" }));
  expect(createVoiceNote).not.toHaveBeenCalled();
});

it("leaves what was said in the box after the draft, aimed where it was, and sends nothing until Enter", async () => {
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  const createVoiceNote = vi.fn();
  useProjectStore.setState({ createVoiceNote });
  const { createTask, createNote, revise, answerTask } = useProjectStore.getState();
  vi.spyOn(api, "speechToText").mockResolvedValue({ text: "Keep the last word" });
  const recording = { blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/mp4" };
  const input = () => container.querySelector<HTMLTextAreaElement>(".composer-input textarea")!;
  await show();
  // The red button says what a press does now.
  expect(micProps.review).toBe(true);
  const point = { time: 3.5, clipIds: [] };
  await selectPoint(point);
  await type("Tighten this,");
  await act(async () => { micProps.onStart?.(); });
  await act(async () => { micProps.onResult(recording); });
  expect(input().value).toBe("Tighten this, Keep the last word");
  expect(document.activeElement).toBe(input());
  expect(input().selectionStart).toBe(input().value.length);
  expect(useUiStore.getState().agentContext).toBe(point);
  for (const sent of [createVoiceNote, createTask, createNote, revise, answerTask]) expect(sent).not.toHaveBeenCalled();
  // Enter sends it as typed words, to the moment it was said about.
  await act(async () => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(createNote).toHaveBeenCalledWith(PRJ, expect.objectContaining({ time: 3.5, text: "Tighten this, Keep the last word" }));
  expect(createVoiceNote).not.toHaveBeenCalled();

  // A reply said into an open edit waits in its box too, and goes to that edit once sent.
  const ready = buildThreads(current).find(t => t.needs === "decision")!;
  await show({ thread: ready });
  expect(input().value).toBe("");
  await act(async () => { micProps.onStart?.(); });
  await act(async () => { micProps.onResult(recording); });
  expect(input().value).toBe("Keep the last word");
  expect(revise).not.toHaveBeenCalled();
  await submit();
  expect(revise).toHaveBeenCalledWith(ready.latest!.id, expect.objectContaining({ text: "Keep the last word" }));
});

it("keeps a late voice transcript in the draft of the project that owned the recording", async () => {
  const source = project.media[0]!;
  const other = db.projects.find(p => p.id !== project.id)!;
  let finish!: (result: { text: string }) => void;
  const transcribe = vi.spyOn(api, "speechToText").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const send = vi.spyOn(api, "createTask");
  useProjectStore.setState({ createTask: stores[0].createTask });
  vi.spyOn(mic, "MicButton").mockImplementation(({ onStart, onResult }) =>
    <button onClick={() => { onStart?.(); onResult({ blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/webm" }); }}>Record</button>);

  useUiStore.getState().openDraft(project.id);
  await selectPoint({ time: 3.5, mediaId: source.id, clipIds: [] });
  await show();
  const recordButton = [...container.querySelectorAll("button")].find(button => button.textContent === "Record")!;
  await act(async () => recordButton.click());
  expect(transcribe).toHaveBeenCalledOnce();
  await act(async () => root.render(null));
  useProjectStore.setState({ current: { ...current, id: other.id, project: other, tasks: [] } });
  useUiStore.getState().openDraft(other.id);
  await act(async () => finish({ text: "Trim this take" }));

  expect(send).not.toHaveBeenCalled();
  expect(useUiStore.getState().agentDraft).toBe("");
  useUiStore.getState().openDraft(project.id);
  expect(useUiStore.getState()).toMatchObject({
    agentDraft: "Trim this take",
    agentContext: { time: 3.5, mediaId: source.id },
  });
});

it("pins a reply to the selected individual edit while typing and sends it in the same thread", async () => {
  const change = current.changes.find(c => c.state === "approved")!;
  const thread = buildThreads({ changes: [change], tasks: [], notes: [] })[0]!;
  const target = { changeId: change.id, editIndex: 1, version: project.head!, time: 1, end: 3, clipIds: [], label: "Opening caption" };
  await show({ thread, selectedEdit: target });
  const header = container.querySelector(".composer-context-row")!;
  expect(header.querySelector(".composer-target-name")?.textContent).toBe("Edit at 0:01");
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

it("says the cut or edit a message was aimed at has gone, and what to do, when its request no longer holds it", async () => {
  const change = current.changes.find(c => c.state === "approved")!;
  const own = buildThreads({ changes: [change], tasks: [], notes: [] })[0]!;
  const target = { changeId: change.id, editIndex: 1, version: project.head!, time: 1, end: 3, clipIds: [], label: "Opening caption" };
  await show({ thread: { ...own, changes: [], flagged: [] }, selectedEdit: target });
  await type("Fade the caption out sooner");
  await submit();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("That cut or edit isn’t there any more. Open it again and resend.");
  expect(useProjectStore.getState().createTask).not.toHaveBeenCalled();
});

it("sends a revision of an edit another request made from the request that flagged it, in that request", async () => {
  const change = current.changes.find(c => c.state === "approved")!;
  // The request that raised the doubt lists the edit with its own, and the message box there talks to it.
  const own = buildThreads({ changes: [change], tasks: [], notes: [] })[0]!;
  const raiser = { ...own, id: "thread_raiser", changes: [], flagged: [change] };
  const target = { changeId: change.id, editIndex: 1, version: project.head!, time: 1, end: 3, clipIds: [], label: "Opening caption" };
  await show({ thread: raiser, selectedEdit: target });
  await type("Fade the caption out sooner");
  await submit();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(useProjectStore.getState().createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    instruction: "Fade the caption out sooner", context: expect.objectContaining({ threadId: "thread_raiser", changeId: change.id, editIndex: 1 }),
  }));
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

it("shows a call by its time alone, never a number, and clicking the time toggles milliseconds", async () => {
  const ready = buildThreads(current).find(t => t.needs === "decision")!;
  useUiStore.getState().setAgentContext({ changeId: ready.latest!.id, cutIndex: 0, version: project.head!, time: 2.3, end: 2.5, clipIds: [], label: "Cut at 2:47" });
  await show({ thread: ready, targetTag: "Cut at 2:47", targetTime: 167.2 });
  expect(aimName()?.textContent).toBe("Cut 2:47");
  expect(container.querySelector(".composer-aim-when")).toBeNull();
  const timeBtn = container.querySelector<HTMLButtonElement>(".composer-aim-time")!;
  await act(async () => timeBtn.click());
  expect(aimName()?.textContent).toBe("Cut 2:47.200");
  expect(aimName()?.querySelector(".time-ms")?.textContent).toBe(".200");
  await act(async () => timeBtn.click());
  expect(aimName()?.textContent).toBe("Cut 2:47");
});

it("shows where the editor paused in an open cut's tag, and sends the message to the cut with that frame", async () => {
  const ready = buildThreads(current).find(t => t.needs === "decision")!;
  useUiStore.getState().setAgentContext({ changeId: ready.latest!.id, cutIndex: 0, version: project.head!, time: 2.3, end: 2.5, clipIds: [], label: "Cut at 0:02" });
  await show({ thread: ready, targetTag: "Cut at 0:02", pausedAt: { time: 37.12, version: "ver_before" } });
  // Shows the paused frame's time alone; the full name on hover still says which cut the message goes to.
  expect(aimName()?.textContent).toBe("Cut 0:37");
  expect(aimName()?.title).toBe("About Cut at 0:02, stopped at 0:37");
  await act(async () => container.querySelector<HTMLButtonElement>(".composer-aim-time")!.click());
  expect(aimName()?.textContent).toBe("Cut 0:37.120");
  expect(container.querySelector("textarea")!.placeholder).toBe("What should change at this frame?");
  expect(container.querySelector("textarea")!.value).toBe("");
  await type("trim more here");
  await submit();
  expect(useProjectStore.getState().revise).toHaveBeenCalledWith(ready.latest!.id, expect.objectContaining({ text: "trim more here",
    position: expect.objectContaining({ cutIndex: 0, time: 2.3, messageTime: { time: 37.12, version: "ver_before" } }) }));
});

it("names the open cut by its own time and sends no stopped frame without a pause", async () => {
  const ready = buildThreads(current).find(t => t.needs === "decision")!;
  useUiStore.getState().setAgentContext({ changeId: ready.latest!.id, cutIndex: 0, version: project.head!, time: 2.3, end: 2.5, clipIds: [], label: "Cut at 0:02" });
  await show({ thread: ready, targetTag: "Cut at 0:02" });
  expect(aimName()?.textContent).toBe("Cut 0:02");
  await act(async () => container.querySelector<HTMLButtonElement>(".composer-aim-time")!.click());
  expect(aimName()?.textContent).toBe("Cut 0:02.300");
  expect(container.querySelector("textarea")!.placeholder).toBe("What should change here?");
  await type("trim more");
  await submit();
  expect(vi.mocked(useProjectStore.getState().revise).mock.calls[0]![1].position).not.toHaveProperty("messageTime");
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

it("appends dictated words after any typed draft without sending or calling onSent until Enter", async () => {
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  vi.spyOn(api, "speechToText").mockResolvedValue({ text: "Keep the last word" });
  const onSent = vi.fn();
  const recording = { blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/mp4" };
  const box = () => container.querySelector<HTMLTextAreaElement>(".composer-input textarea")!.value;
  await show({ thread: buildThreads(current).find(t => t.needs === "decision")!, onSent });
  await act(async () => { micProps.onStart?.(); micProps.onResult(recording); });
  expect(useProjectStore.getState().revise).not.toHaveBeenCalled();
  expect(onSent).not.toHaveBeenCalled();
  expect(box()).toBe("Keep the last word");
  // Words already in the box stay first, and dictated words follow them until the editor sends.
  await type("And lower the music");
  await act(async () => { micProps.onStart?.(); micProps.onResult(recording); });
  expect(useProjectStore.getState().revise).not.toHaveBeenCalled();
  expect(onSent).not.toHaveBeenCalled();
  expect(box()).toBe("And lower the music Keep the last word");
  await submit();
  expect(useProjectStore.getState().revise).toHaveBeenCalledTimes(1);
  expect(onSent).toHaveBeenCalledTimes(1);
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

  // Text typed while a spoken message is still being written down stays first, and what was said follows it.
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  let heard!: (result: { text: string }) => void;
  vi.spyOn(api, "speechToText").mockImplementation(() => new Promise(resolve => { heard = resolve; }));
  const recording = { blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/mp4" };
  await show({ thread: buildThreads(current).find(t => t.needs === "decision")!, onSent });
  await act(async () => { micProps.onStart?.(); micProps.onResult(recording); });
  await type("And lower the music");
  await act(async () => heard({ text: "Keep the last word" }));
  expect(revise).toHaveBeenCalledTimes(3);
  expect(onSent).toHaveBeenCalledTimes(1);
  expect(box()).toBe("And lower the music Keep the last word");

  // Aiming the box at another edit while a message is on its way keeps the page untold as well: that target is for the next message.
  await type("");
  const wrap = { changeId: "chg_ready", editIndex: 2, time: 11.5, clipIds: [], label: "wrap" };
  await act(async () => useUiStore.getState().setAgentContext(wrap));
  await type("Make it longer");
  await submit();
  await act(async () => useUiStore.getState().setAgentContext({ ...wrap, editIndex: 1, label: "captions" }));
  await act(async () => land());
  expect(onSent).toHaveBeenCalledTimes(1);
  expect(box()).toBe("");
  expect(useUiStore.getState().agentContext).toMatchObject({ label: "captions" });
});

it("saves a late dictated transcript to the earlier request's draft when the box moved on", async () => {
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
  expect(useProjectStore.getState().revise).not.toHaveBeenCalled();
  expect(useUiStore.getState().savedDrafts[first]).toMatchObject({ agentDraft: "Keep the last word" });
  expect(useUiStore.getState().agentDraft).toBe("Something else");
  expect(onSent).not.toHaveBeenCalled();
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
  expect(useUiStore.getState().agentDraft).toBe("Keep the last word");
  expect(useProjectStore.getState().revise).not.toHaveBeenCalled();
  expect(speaking()).toBe(false);
  // A recording that never made a message lets the box go too, and so does the box going away mid-recording.
  await act(async () => micProps.onRecording?.(true));
  await act(async () => micProps.onRecording?.(false));
  expect(speaking()).toBe(false);
  await act(async () => micProps.onRecording?.(true));
  await act(async () => root.render(null));
  expect(speaking()).toBe(false);
});

it("keeps a late dictated edit in the project where it was recorded, aimed where it started", async () => {
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  let finish!: (result: { text: string }) => void;
  vi.spyOn(api, "speechToText").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
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

it("puts dictated words with the request they were said to, not in the box aimed elsewhere since", async () => {
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  let heard!: (result: { text: string }) => void;
  vi.spyOn(api, "speechToText").mockImplementation(() => new Promise(resolve => { heard = resolve; }));
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

const aimName = () => container.querySelector<HTMLElement>(".composer-aim-line .composer-aim-name");
const aimField = () => container.querySelector<HTMLTextAreaElement>(".composer-message textarea")!;
const aimClear = (label: string) => container.querySelector<HTMLButtonElement>(`.composer-aim-clear[aria-label="${label}"]`);
const clearCut = "Start a new edit instead of revising cut at 2:05";
const clearRange = "Take the marked range 0:42 – 0:51 off the message";

it("names and clears the cut beside the draft", async () => {
  await show();
  expect(aimName()).toBeNull();
  const onClearTarget = vi.fn();
  await show({ targetTag: "Cut at 2:05", targetTime: 125.342, onClearTarget });
  // Where the message goes is a line of its own on top of the box, so the box keeps its width for the words.
  expect(container.querySelector(".composer-aim-line")?.nextElementSibling?.classList.contains("composer-box")).toBe(true);
  expect(container.querySelector(".composer-row .composer-aim")).toBeNull();
  expect(aimName()?.textContent).toBe("Cut 2:05");
  expect(aimName()?.title).toBe("About Cut at 2:05");
  expect(container.querySelector(".composer-aim-button")).toBeNull();
  expect(container.querySelector(".composer-aim-card")).toBeNull();
  const timeBtn = container.querySelector<HTMLButtonElement>(".composer-aim-time")!;
  await act(async () => timeBtn.click());
  expect(aimName()?.textContent).toBe("Cut 2:05.342");
  expect(aimName()?.querySelector(".time-ms")?.textContent).toBe(".342");
  await type("Keep the laugh");
  await act(async () => aimClear(clearCut)!.click());
  expect(onClearTarget).toHaveBeenCalledTimes(1);
  expect(useUiStore.getState().agentDraft).toBe("Keep the laugh");
  expect(document.activeElement).toBe(aimField());
  await show({ targetTag: "Reply", thread: buildThreads(current)[0] });
  expect([aimName(), container.querySelector(".composer-tag-name")?.textContent]).toEqual([null, "Reply"]);
});

it("shows only the chosen range with no tooltip or popover, and clears it independently of an open cut", async () => {
  const cut: AgentContext = { changeId: "chg_1", cutIndex: 0, version: "v1", time: 125, end: 127, clipIds: [], label: "Cut at 2:05" };
  await act(async () => useUiStore.getState().setAgentContext({ ...cut, markedRange: { start: 42, end: 51.5, version: "v2" } }));
  await show({ targetTag: "Cut at 2:05" });
  expect(aimName()?.textContent).toBe("Range 0:42 – 0:51");
  expect(container.querySelector(".composer-aim-icon")).toBeNull();
  expect(aimName()?.getAttribute("title")).toBeNull();
  expect(container.querySelector(".composer-aim-button")).toBeNull();
  expect(container.querySelector(".composer-aim-card")).toBeNull();
  expect(aimClear(clearCut)).toBeNull();
  expect(aimClear(clearRange)).not.toBeNull();
  const rangeBtn = container.querySelector<HTMLButtonElement>(".composer-aim-time")!;
  await act(async () => rangeBtn.click());
  expect(aimName()?.textContent).toBe("Range 0:42.000 – 0:51.500");
  expect(Array.from(aimName()!.querySelectorAll(".time-ms")).map(el => el.textContent)).toEqual([".000", ".500"]);
  await act(async () => rangeBtn.click());
  expect(aimName()?.textContent).toBe("Range 0:42 – 0:51");
  await act(async () => aimClear(clearRange)!.click());
  expect(useUiStore.getState().agentContext).toEqual(cut);
  expect(aimName()?.textContent).toBe("Cut 2:05");
  expect(aimName()?.title).toBe("About Cut at 2:05");
  expect(document.activeElement).toBe(aimField());
  // Taking the only target off leaves a new edit about the whole video.
  await act(async () => useUiStore.getState().setAgentContext({ time: 42, end: 51.5, clipIds: [], markedRange: { start: 42, end: 51.5 } }));
  await show();
  expect(aimName()?.textContent).toBe("Range 0:42 – 0:51");
  expect(aimName()?.getAttribute("title")).toBeNull();
  await act(async () => aimClear(clearRange)!.click());
  expect(useUiStore.getState().agentContext).toBeNull();
  expect(aimName()).toBeNull();
});

it("automatically shows dimmed milliseconds when a marked range starts and ends within the same second", async () => {
  await act(async () => useUiStore.getState().setAgentContext({ time: 812.444, end: 812.478, clipIds: [], markedRange: { start: 812.444, end: 812.478 } }));
  await show();
  expect(aimName()?.textContent).toBe("Range 13:32.444 – 13:32.478");
  expect(Array.from(aimName()!.querySelectorAll(".time-ms")).map(el => el.textContent)).toEqual([".444", ".478"]);
  expect(aimName()?.getAttribute("title")).toBeNull();
  await act(async () => aimClear("Take the marked range 13:32.444 – 13:32.478 off the message")!.click());
  expect(useUiStore.getState().agentContext).toBeNull();
});

it.each([
  ["Cut 2", undefined, "Cut 2"],
  ["Edit at 0:11", undefined, "Edit 0:11"],
  ["Edit at 0:11", 11.25, "Edit 0:11"],
  ["3 edits at 2:40", 160.342, "3 edits 2:40"],
])("labels %s (time %s) beside the draft as %s", async (targetTag, targetTime, displayName) => {
  await show({ targetTag, targetTime });
  expect(aimName()?.textContent).toBe(displayName);
  expect(aimName()?.title).toBe(`About ${targetTag}`);
  expect(aimClear(`Start a new edit instead of revising ${targetTag.toLowerCase()}`)).not.toBeNull();
  expect(container.querySelector(".composer-aim-button")).toBeNull();
  expect(container.querySelector(".composer-aim-card")).toBeNull();
});

it("clears a chosen range on Backspace in an empty box before taking off the open cut", async () => {
  const cut: AgentContext = { changeId: "chg_1", cutIndex: 0, version: "v1", time: 125, end: 127, clipIds: [], label: "Cut at 2:05" };
  const onClearTarget = vi.fn();
  await act(async () => useUiStore.getState().setAgentContext({ ...cut, markedRange: { start: 42, end: 51.5 } }));
  await show({ targetTag: "Cut at 2:05", onClearTarget });
  await act(async () => { aimField().focus(); aimField().dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true })); });
  expect(useUiStore.getState().agentContext).toEqual(cut);
  expect(onClearTarget).not.toHaveBeenCalled();
  expect(aimName()?.textContent).toBe("Cut 2:05");
  await act(async () => { aimField().dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true })); });
  expect(onClearTarget).toHaveBeenCalledTimes(1);
});

it("puts a marked range taken off the empty box back on ⌘Z, until the box is aimed again or written in", async () => {
  const cut: AgentContext = { changeId: "chg_1", cutIndex: 0, version: "v1", time: 125, end: 127, clipIds: [], label: "Cut at 2:05" };
  const marked = { ...cut, markedRange: { start: 42, end: 51.5 } };
  const onRestoreTarget = vi.fn(() => false);
  const press = async (key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    await act(async () => { aimField().dispatchEvent(event); });
    return event.defaultPrevented;
  };
  await act(async () => useUiStore.getState().setAgentContext(marked));
  await show({ targetTag: "Cut at 2:05", onRestoreTarget });
  // Backspace takes the range off, and ⌘Z puts it back on the cut as it was. Nothing else is asked to undo.
  await press("Backspace");
  expect(aimName()?.textContent).toBe("Cut 2:05");
  expect(await press("z", { metaKey: true })).toBe(true);
  expect(useUiStore.getState().agentContext).toEqual(marked);
  expect(aimName()?.textContent).toBe("Range 0:42 – 0:51");
  expect(onRestoreTarget).not.toHaveBeenCalled();
  // Only once: a second ⌘Z has no range to put back.
  expect(await press("z", { metaKey: true })).toBe(false);
  expect(onRestoreTarget).toHaveBeenCalledTimes(1);
  // Its × is the same, also for a range that was all the message was about.
  await act(async () => useUiStore.getState().setAgentContext({ time: 42, end: 51.5, clipIds: [], markedRange: { start: 42, end: 51.5 } }));
  await show({ onRestoreTarget });
  await act(async () => aimClear(clearRange)!.click());
  expect(aimName()).toBeNull();
  expect(await press("z", { ctrlKey: true })).toBe(true);
  expect(aimName()?.textContent).toBe("Range 0:42 – 0:51");
  // Words written since the range came off are the message: ⌘Z is theirs.
  await act(async () => aimClear(clearRange)!.click());
  await type("Tighten this");
  await type("");
  expect(await press("z", { metaKey: true })).toBe(false);
  expect(aimName()).toBeNull();
  // A box aimed somewhere else since has that aim, not the range, to keep.
  await act(async () => useUiStore.getState().setAgentContext({ time: 42, end: 51.5, clipIds: [], markedRange: { start: 42, end: 51.5 } }));
  await act(async () => aimClear(clearRange)!.click());
  await selectPoint({ time: 9, clipIds: [] });
  await act(async () => useUiStore.getState().setAgentContext(null));
  expect(await press("z", { metaKey: true })).toBe(false);
  expect(aimName()).toBeNull();
});

it("takes a marked range off on the first Esc in an empty box, and leaves a message being written and its range alone", async () => {
  const cut: AgentContext = { changeId: "chg_1", cutIndex: 0, version: "v1", time: 125, end: 127, clipIds: [], label: "Cut at 2:05" };
  const marked = { ...cut, markedRange: { start: 42, end: 51.5 } };
  const onClearTarget = vi.fn();
  const esc = () => act(async () => { aimField().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  await act(async () => useUiStore.getState().setAgentContext(marked));
  await show({ targetTag: "Cut at 2:05", onClearTarget });
  // Marking the range put the caret in the box. Words in it keep the range: Esc only lets go of the box.
  await type("Tighten this");
  await act(async () => aimField().focus());
  await esc();
  expect([useUiStore.getState().agentDraft, useUiStore.getState().agentContext]).toEqual(["Tighten this", marked]);
  expect(document.activeElement).not.toBe(aimField());
  // Empty, the same Esc takes the range off, as Esc anywhere else on the page does. The cut stays the box's.
  await type("");
  await act(async () => aimField().focus());
  await esc();
  expect(useUiStore.getState().agentContext).toEqual(cut);
  expect(aimName()?.textContent).toBe("Cut 2:05");
  expect(document.activeElement).not.toBe(aimField());
  // With no range, Esc takes nothing off.
  await act(async () => aimField().focus());
  await esc();
  expect(useUiStore.getState().agentContext).toEqual(cut);
  expect(onClearTarget).not.toHaveBeenCalled();

  // Delete and Option/Alt+X (including macOS `≈` with code KeyX) also take a range off an empty box, and ⌘Z restores it.
  for (const init of [
    { key: "Delete" },
    { key: "x", altKey: true },
    { key: "≈", code: "KeyX", altKey: true },
  ]) {
    await act(async () => useUiStore.getState().setAgentContext(marked));
    await act(async () => aimField().focus());
    const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    await act(async () => { aimField().dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
    expect(useUiStore.getState().agentContext).toEqual(cut);
    const undo = new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true });
    await act(async () => { aimField().dispatchEvent(undo); });
    expect(useUiStore.getState().agentContext).toEqual(marked);
  }
});

it("shows the Range tag for words chosen in the transcript (Ask about this), and lets ×, Backspace, Esc and ⌘Z manage it", async () => {
  const words: AgentContext = { version: project.head!, time: 42, end: 51.5, clipIds: ["c1"], label: "“three things”" };
  const clearWords = "Take the range 0:42 – 0:51 off the message";
  const press = async (key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    await act(async () => { aimField().dispatchEvent(event); });
    return event.defaultPrevented;
  };
  await act(async () => useUiStore.getState().setAgentContext(words));
  await show();
  expect(aimName()?.textContent).toBe("Range 0:42 – 0:51");
  expect(container.querySelector(".composer-aim-icon")).toBeNull();
  expect(aimName()?.getAttribute("title")).toBeNull();
  expect(aimClear(clearWords)).not.toBeNull();
  // Clicking the time toggles exact milliseconds on and off.
  const rangeBtn = container.querySelector<HTMLButtonElement>(".composer-aim-time")!;
  await act(async () => rangeBtn.click());
  expect(aimName()?.textContent).toBe("Range 0:42.000 – 0:51.500");
  await act(async () => rangeBtn.click());
  expect(aimName()?.textContent).toBe("Range 0:42 – 0:51");
  // × clears the words, focuses the box, and sends a plain whole-video request instead of a note at those words.
  await act(async () => aimClear(clearWords)!.click());
  expect(useUiStore.getState().agentContext).toBeNull();
  expect(aimName()).toBeNull();
  expect(document.activeElement).toBe(aimField());
  // ⌘Z in the empty box puts them back.
  expect(await press("z", { metaKey: true })).toBe(true);
  expect(useUiStore.getState().agentContext).toEqual(words);
  expect(aimName()?.textContent).toBe("Range 0:42 – 0:51");
  // Backspace in an empty box takes them off, and ⌘Z puts them back.
  await press("Backspace");
  expect(useUiStore.getState().agentContext).toBeNull();
  expect(await press("z", { ctrlKey: true })).toBe(true);
  expect(useUiStore.getState().agentContext).toEqual(words);
  // Esc with typed text keeps the words and their range; Esc in an empty box takes the range off.
  await type("Tighten this");
  await act(async () => aimField().focus());
  await press("Escape");
  expect([useUiStore.getState().agentDraft, useUiStore.getState().agentContext]).toEqual(["Tighten this", words]);
  await type("");
  await act(async () => aimField().focus());
  await press("Escape");
  expect(useUiStore.getState().agentContext).toBeNull();
  expect(aimName()).toBeNull();
  // Sending after taking the range off starts a whole-video request, not a note on those words.
  await type("Add a title card");
  await submit();
  expect(useProjectStore.getState().createNote).not.toHaveBeenCalled();
  expect(useProjectStore.getState().createTask).toHaveBeenLastCalledWith(PRJ, expect.objectContaining({
    instruction: "Add a title card", context: { version: project.head },
  }));
  // Same-second chosen words automatically show dimmed milliseconds.
  await act(async () => useUiStore.getState().setAgentContext({ version: project.head!, time: 14.2, end: 14.5, clipIds: [], label: "“is”" }));
  await show();
  expect(aimName()?.textContent).toBe("Range 0:14.200 – 0:14.500");
  expect(Array.from(aimName()!.querySelectorAll(".time-ms")).map(el => el.textContent)).toEqual([".200", ".500"]);
  // Words chosen inside an open cut still carry the cut's own tag.
  await act(async () => useUiStore.getState().setAgentContext({ changeId: "chg_1", cutIndex: 0, version: project.head!, time: 2.3, end: 2.5, clipIds: [], label: "“I”" }));
  await show({ targetTag: "Cut at 0:02" });
  expect(aimName()?.textContent).toBe("Cut 0:02");
});

it("answers Scarlet's question with words chosen in the transcript beside Answer, and clears the range before Answer", async () => {
  const asking = buildThreads(current).find(t => t.question)!;
  const words: AgentContext = { version: project.head!, time: 42, end: 51.5, clipIds: [], label: "“three things”" };
  const onClearTarget = vi.fn();
  await act(async () => useUiStore.getState().setAgentContext(words));
  await show({ thread: asking, targetTag: "Answer", onClearTarget });
  expect(aimName()?.textContent).toBe("Range 0:42 – 0:51");
  expect(container.querySelector(".composer-tag-name")?.textContent).toBe("Answer");
  await type("Yes, this part");
  await submit();
  expect(useProjectStore.getState().answerTask).toHaveBeenLastCalledWith(
    asking.question!.id,
    expect.stringMatching(/^At 0:42.*0:51 — Yes, this part$/),
    undefined,
    expect.objectContaining({ agent: "claude" }),
  );
  // Backspace in an empty box clears the chosen range first, leaving Answer.
  await act(async () => useUiStore.getState().setAgentContext(words));
  await show({ thread: asking, targetTag: "Answer", onClearTarget });
  await act(async () => { aimField().focus(); aimField().dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true })); });
  expect(useUiStore.getState().agentContext).toBeNull();
  expect(aimName()).toBeNull();
  expect(onClearTarget).not.toHaveBeenCalled();
  expect(container.querySelector(".composer-tag-name")?.textContent).toBe("Answer");
});

it("keeps a picked moment, and a whole-video choice, through a time typed in the message", async () => {
  const messageClock = { version: project.head!, duration: 150, timeline: current.timeline, seek: vi.fn() };
  await show({ messageClock });
  const picked = { time: 10, version: project.head!, clipIds: [] };
  await selectPoint(picked);
  await type("Match the look at 1:30");
  expect(useUiStore.getState().agentContext).toBe(picked);
  await type("Match the look");
  expect(useUiStore.getState().agentContext).toBe(picked);
  // Once the editor took the aim off, a time typed doesn't put one back.
  await act(async () => useUiStore.getState().setAgentContext("whole"));
  await type("Match the look at 1:30");
  expect(useUiStore.getState().agentContext).toBe("whole");
  await submit();
  expect(useProjectStore.getState().createTask).toHaveBeenLastCalledWith(PRJ, expect.objectContaining({
    instruction: "Match the look at 1:30", context: { version: project.head },
  }));
});

it("answers Scarlet's question with a stretch marked on the ruler beside it, still tagged Answer", async () => {
  const asking = buildThreads(current).find(t => t.question)!;
  await act(async () => useUiStore.getState().setAgentContext({ time: 42, end: 51.5, clipIds: [], markedRange: { start: 42, end: 51.5 } }));
  await show({ thread: asking, targetTag: "Answer" });
  expect(container.querySelector(".composer-tag-name")?.textContent).toBe("Answer");
  await type("Yes, this part");
  await submit();
  // The picker holds a different model than the asking task (Claude vs Codex), so the answer hands off silently to the picked model.
  expect(useProjectStore.getState().answerTask).toHaveBeenCalledWith(
    asking.question!.id,
    expect.stringMatching(/^At 0:42.*0:51 — Yes, this part$/),
    undefined,
    expect.objectContaining({ agent: "claude" }),
  );
  // When the picker matches the asking task's model, no model switch is sent so the existing session continues.
  const sameModel = { ...asking, question: { ...asking.question!, agent: "claude" as const, model: "opus" } };
  await act(async () => useUiStore.getState().setAgent({ agent: "claude", model: "opus" }));
  await show({ thread: sameModel, targetTag: "Answer" });
  await type("Keep the purple");
  await submit();
  expect(useProjectStore.getState().answerTask).toHaveBeenLastCalledWith(
    asking.question!.id,
    "Keep the purple",
    undefined,
  );
});

it("keeps the target's × from taking the box elsewhere while a spoken message is in it", async () => {
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  let heard!: (result: { text: string }) => void;
  vi.spyOn(api, "speechToText").mockImplementation(() => new Promise(resolve => { heard = resolve; }));
  const onClearTarget = vi.fn();
  const thread = buildThreads(current).find(t => t.needs === "decision")!;
  await act(async () => useUiStore.getState().openDraft(PRJ, thread.id));
  await show({ thread, targetTag: "Cut at 2:05", onClearTarget });
  const clear = () => aimClear(clearCut)!;
  expect(clear().disabled).toBe(false);
  // While it records, and while what was said is written down and sent, the × waits.
  await act(async () => { micProps.onStart?.(); micProps.onRecording?.(true); });
  expect(clear().disabled).toBe(true);
  expect(clear().getAttribute("aria-description")).toBe("Waits until what you’re saying is sent");
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
  // What was said takes their place in the box, and waits there as typed words do: nothing is saved by itself.
  await act(async () => { micProps.onStart?.(); micProps.onResult({ blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/mp4" }); });
  expect(rewording.onChange).toHaveBeenLastCalledWith("Keep the breath too");
  expect(rewording.onSave).toHaveBeenCalledTimes(1);
  expect(useProjectStore.getState().createTask).not.toHaveBeenCalled();
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
  const skill = dialogueGuide(db.skills)!;
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

it("names the moment beside the draft and clears it for a whole-video request", async () => {
  const onClearTarget = vi.fn();
  await act(async () => useUiStore.getState().setAgentContext({ time: 1108.45, clipIds: [] }));
  await show({ targetTag: "At 18:28", targetIsPoint: true, onClearTarget });
  expect(aimName()?.textContent).toBe("At 18:28");
  expect(aimName()?.title).toBe("About 18:28");
  await act(async () => container.querySelector<HTMLButtonElement>(".composer-aim-time")!.click());
  expect(aimName()?.textContent).toBe("At 18:28.450");
  expect(container.querySelector(".composer-aim-button")).toBeNull();
  await act(async () => aimClear("Take “At 18:28” off: the message is about the whole video")!.click());
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

it("dictates for the whole video with no moment picked, including after an abandoned hold", async () => {
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  const createVoiceNote = vi.fn();
  useProjectStore.setState({ createVoiceNote });
  vi.spyOn(api, "speechToText").mockResolvedValue({ text: "Fix the levels throughout" });
  await show();
  await act(async () => { micProps.onStart?.(); });
  expect(useUiStore.getState().agentContext).toBeNull();
  await act(async () => usePlayerStore.getState().setTime(300));
  await act(async () => { micProps.onStart?.(); });
  await act(async () => usePlayerStore.getState().setTime(310));
  await act(async () => { micProps.onResult({ blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/mp4" }); });
  expect(container.querySelector<HTMLTextAreaElement>(".composer-input textarea")!.value).toBe("Fix the levels throughout");
  expect(useUiStore.getState().agentContext).toBeNull();
  expect(useProjectStore.getState().createTask).not.toHaveBeenCalled();
  await submit();
  expect(useProjectStore.getState().createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    instruction: "Fix the levels throughout", context: { version: project.head },
  }));
  expect(createVoiceNote).not.toHaveBeenCalled();
});

it("says it is still connecting, not to sign in, when Enter is pressed while Scarlet is still finding its models", async () => {
  // The list of hosts hasn't arrived: the header's model button says "Connecting…", and nothing is asked of the editor.
  useHostsStore.setState({ hosts: [], status: "loading" });
  await show();
  const field = container.querySelector("textarea")!;
  const said = () => container.querySelector('[role="alert"]')?.textContent;
  await type("Tighten the opening");
  await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  expect(said()).toBe("Still connecting. Try again in a moment.");
  expect(useProjectStore.getState().createTask).not.toHaveBeenCalled();
  expect(field.value).toBe("Tighten the opening");
  // The list arrived with nothing signed in: now the reason is the one that asks for a sign-in.
  await act(async () => useHostsStore.setState({ status: "ready" }));
  expect(said()).toBe(NO_AGENT_REASON);
});

it("says why Enter did nothing when no agent or model can take the message", async () => {
  useHostsStore.setState({ hosts: [], status: "ready" });
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
  useHostsStore.setState({ hosts: [], status: "ready" });
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

it("keeps the chosen point through dictation even if playback moved while recording, then clears it on send", async () => {
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  vi.spyOn(api, "speechToText").mockResolvedValue({ text: "Trim this pause" });
  const onSent = vi.fn();
  await show({ onSent });
  await selectPoint({ time: 10, clipIds: [] });
  await act(async () => { micProps.onStart?.(); });
  await act(async () => usePlayerStore.setState({ time: 42, playing: true }));
  await act(async () => { micProps.onResult({ blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/mp4" }); });
  expect(useUiStore.getState().agentDraft).toBe("Trim this pause");
  expect(useUiStore.getState().agentContext).toMatchObject({ time: 10 });
  expect(onSent).not.toHaveBeenCalled();
  await submit();
  expect(useProjectStore.getState().createNote).toHaveBeenCalledWith(PRJ, expect.objectContaining({ time: 10, text: "Trim this pause" }));
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
  expect(first.onChange).not.toHaveBeenCalled();
  expect(first.onSave).not.toHaveBeenCalled();
  expect(next.onSave).not.toHaveBeenCalled();
  expect(useProjectStore.getState().createTask).not.toHaveBeenCalled();
});

it("puts what was said for a queued request in the box, where the tick saves it and Esc leaves the request as it was", async () => {
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  vi.spyOn(api, "speechToText").mockResolvedValue({ text: "/dialogue-pass Keep the aside, but trim the breath before it." });
  const skill = dialogueGuide(db.skills)!;
  useSkillsStore.setState({ skills: [skill], status: "ready" });
  let text = "Keep the aside.";
  const rewording = { id: "task_queued", get text() { return text; }, onChange: vi.fn((t: string) => { text = t; }),
    onSave: vi.fn().mockResolvedValue(undefined), onCancel: vi.fn() };
  await show({ rewording });
  await act(async () => { micProps.onStart?.(); micProps.onResult({ blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/mp4" }); });
  // What was said is the box's new words, with the cursor there. The request still reads as it did: nothing is saved.
  expect(rewording.onChange).toHaveBeenCalledExactlyOnceWith("/dialogue-pass Keep the aside, but trim the breath before it.");
  expect(rewording.onSave).not.toHaveBeenCalled();
  await show({ rewording });
  const input = container.querySelector<HTMLTextAreaElement>(".composer-input textarea")!;
  expect(input.value).toBe("/dialogue-pass Keep the aside, but trim the breath before it.");
  expect(document.activeElement).toBe(input);
  // Esc leaves the request as it was, as it does for typed words.
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(rewording.onCancel).toHaveBeenCalledTimes(1);
  expect(rewording.onSave).not.toHaveBeenCalled();
  // The tick saves them, with the skills they name, as it does for typed words.
  expect(container.querySelector<HTMLButtonElement>(".composer-send")!.title).toBe("Save the new words");
  await submit();
  expect(rewording.onSave).toHaveBeenCalledExactlyOnceWith("/dialogue-pass Keep the aside, but trim the breath before it.", [skill.id]);
  expect(useProjectStore.getState().createTask).not.toHaveBeenCalled();
});

it("keeps a message being spoken in its draft when a queued request's words take the box meanwhile, and drops words said for ones put back", async () => {
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
  expect(rewording.onChange).not.toHaveBeenCalled();
  expect(rewording.onSave).not.toHaveBeenCalled();
  expect(useUiStore.getState().agentDraft).toBe("Keep the last word");
  expect(useProjectStore.getState().revise).not.toHaveBeenCalled();
  // Spoken for the queued request, whose words the editor put back before it was written down: nothing changes.
  await act(async () => { micProps.onStart?.(); micProps.onResult({ blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/mp4" }); });
  await show({ thread });
  await act(async () => heard({ text: "Trim the breath" }));
  expect(rewording.onChange).not.toHaveBeenCalled();
  expect(rewording.onSave).not.toHaveBeenCalled();
  expect(useUiStore.getState().agentDraft).toBe("Keep the last word");
  expect(useProjectStore.getState().revise).not.toHaveBeenCalled();
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

it("asks for a new edit, with the skills it takes, in an empty box", async () => {
  await show();
  expect(container.querySelector("textarea")!.placeholder).toBe("Describe an edit, / skills");
  expect(NEW_EDIT_HINT).toBe("Describe an edit, / skills");
});

it("opens no list for $: the words are sent as written", async () => {
  await show();
  const field = container.querySelector("textarea")!;
  await act(() => field.focus());
  await type("$");
  expect(container.querySelector('[role="listbox"]')).toBeNull();
  await type("$lower-third for Daniel");
  await submit();
  expect(useProjectStore.getState().createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({ instruction: "$lower-third for Daniel" }));
});

it("attaches files dropped or pasted on the box to the next message, in a line on top of the box", async () => {
  const upload = vi.spyOn(api, "uploadAttachment").mockImplementation(async (_project, file, name) => ({
    attachment: { id: `att_${name ?? (file as { path: string }).path}`, name: name ?? (file as { path: string }).path.split("/").pop()!, size: 10 } }));
  await show();
  const dock = container.querySelector<HTMLElement>(".composer-dock")!;
  // The box is its own drop target: the desktop app's drops over it attach, and don't import media.
  expect(dock.hasAttribute("data-file-drop")).toBe(true);
  expect(fileDropZone(container.querySelector("textarea"))).toBe(dock);
  await act(async () => dropTargets.get(dock)!.drop(["/Users/me/Brand guide.pdf"]));
  expect(upload).toHaveBeenCalledWith(PRJ, { path: "/Users/me/Brand guide.pdf" });
  const field = container.querySelector("textarea")!;
  const paste = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
  paste.clipboardData = { files: [new File(["png"], "logo.png", { type: "image/png" })] };
  await act(async () => { field.dispatchEvent(paste); });
  expect(paste.defaultPrevented).toBe(true);
  const names = () => Array.from(container.querySelectorAll(".composer-files .composer-file-name"), n => n.textContent);
  expect(names()).toEqual(["Brand guide.pdf", "logo.png"]);
  // The line sits on top of the box.
  expect(container.querySelector(".composer-files")?.nextElementSibling?.classList.contains("composer-box")).toBe(true);
  const remove = container.querySelectorAll<HTMLButtonElement>(".composer-file button");
  expect(remove[1]!.title).toBe("Remove");
  await act(async () => remove[1]!.click());
  expect(names()).toEqual(["Brand guide.pdf"]);
  await type("Use these colors for the lower thirds");
  await submit();
  expect(useProjectStore.getState().createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    instruction: "Use these colors for the lower thirds",
    context: expect.objectContaining({ attachments: [{ id: "att_/Users/me/Brand guide.pdf", name: "Brand guide.pdf", size: 10 }] }),
  }));
  expect(container.querySelector(".composer-files")).toBeNull();
});

it("says why a file couldn't be attached", async () => {
  vi.spyOn(api, "uploadAttachment").mockRejectedValue(new Error("The file is too large."));
  await show();
  await act(async () => dropTargets.get(container.querySelector(".composer-dock")!)!.drop(["/Users/me/huge.mov"]));
  expect(container.querySelector(".composer-file.is-failed")?.textContent).toContain("The file is too large.");
});

it("keeps the message in the box when a file it was waiting for couldn't be added, and says why", async () => {
  let fail!: (reason: Error) => void;
  vi.spyOn(api, "uploadAttachment").mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  await show();
  await act(async () => { dropTargets.get(container.querySelector(".composer-dock")!)!.drop(["/Users/me/Brand guide.pdf"]); });
  expect(container.querySelector(".composer-file.is-adding")).not.toBeNull();
  await type("Use these colors for the lower thirds");
  // Enter while the file is still being added: the message waits for it.
  await submit();
  expect(useProjectStore.getState().createTask).not.toHaveBeenCalled();
  await act(async () => { fail(new Error("The file is too large.")); });
  await act(async () => {});
  // It didn't go out without the file: the words and the file's row stay, and the line over the box says why.
  expect(useProjectStore.getState().createTask).not.toHaveBeenCalled();
  expect(container.querySelector("textarea")!.value).toBe("Use these colors for the lower thirds");
  expect(container.querySelector(".composer-file.is-failed")?.textContent).toContain("The file is too large.");
  expect(container.querySelector('.composer-dock > [role="alert"]')?.textContent).toBe("The file is too large.");
  // Sent again, the message goes without the file that couldn't be added, as one that had failed before Enter does.
  await submit();
  expect(useProjectStore.getState().createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({ instruction: "Use these colors for the lower thirds" }));
  expect(container.querySelector(".composer-files")).toBeNull();
});

it("carries the frame the editor drew on with the next message: its picture as a file, and the marks", async () => {
  const picture = new Blob(["png"], { type: "image/png" });
  const draw = vi.spyOn(markedFrame, "markedFramePicture").mockResolvedValue(picture);
  const upload = vi.spyOn(api, "uploadAttachment").mockResolvedValue({ attachment: { id: "att_frame", name: "Marked frame 0.07.png", size: 3, mime: "image/png" } });
  const ring = { kind: "draw" as const, box: { x: 0.55, y: 0.4, w: 0.1, h: 0.2 }, points: [[0.55, 0.5], [0.6, 0.4], [0.65, 0.5], [0.6, 0.6]] as [number, number][] };
  const point = { kind: "point" as const, box: { x: 0.7, y: 0.3, w: 0, h: 0 } };
  usePictureMarksStore.setState({ marking: null, byProject: { [PRJ]: { time: 7, version: project.head!, picture: "frame://7", marks: [ring, point] } } });
  await show();
  // The marked frame is a row of the line on top of the box, with its picture, and a × that takes it off.
  const row = container.querySelector(".composer-files .composer-file.is-marked-frame")!;
  expect(row.querySelector(".composer-file-name")?.textContent).toBe("Marked frame 0:07");
  expect(row.querySelector(".composer-file-state")?.textContent).toBe("2 marks");
  expect(row.querySelector("img")?.getAttribute("src")).toBe("frame://7");
  await type("Blur 1 and swap 2 for the new logo");
  await submit();
  expect(draw).toHaveBeenCalledWith("frame://7", [ring, point]);
  expect(upload).toHaveBeenCalledWith(PRJ, expect.any(File));
  expect(useProjectStore.getState().createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    instruction: "Blur 1 and swap 2 for the new logo",
    context: expect.objectContaining({
      attachments: [{ id: "att_frame", name: "Marked frame 0.07.png", size: 3, mime: "image/png" }],
      pictureMarks: { attachmentId: "att_frame", time: 7, version: project.head, marks: [ring, point] },
    }),
  }));
  // Sent, the marks leave the box.
  expect(usePictureMarksStore.getState().byProject[PRJ]).toBeUndefined();
  expect(container.querySelector(".composer-files")).toBeNull();
});

it("sends the files and the marked frame attached to an answer with it, and takes their rows off the box", async () => {
  vi.spyOn(markedFrame, "markedFramePicture").mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  vi.spyOn(api, "uploadAttachment").mockImplementation(async (_project, file, name) => file instanceof File && file.name.startsWith("Marked frame")
    ? { attachment: { id: "att_frame", name: file.name, size: 3, mime: "image/png" } }
    : { attachment: { id: "att_logo", name: name ?? "logo-white.png", size: 10 } });
  const asking = buildThreads(current).find(t => t.question)!;
  await show({ thread: asking, targetTag: "Answer" });
  await act(async () => useAttachmentsStore.getState().add(PRJ, [new File(["png"], "logo-white.png", { type: "image/png" })]));
  const names = () => Array.from(container.querySelectorAll(".composer-files .composer-file-name"), n => n.textContent);
  expect(names()).toEqual(["logo-white.png"]);
  await type("By a third, and use this logo instead.");
  await submit();
  // The file goes with the answer, to the request that asked, and its row leaves the box.
  // (The box is set to another model than the one that asked here, so the answer names it, as it does without a file.)
  const model = expect.objectContaining({ agent: "claude" });
  expect(useProjectStore.getState().answerTask).toHaveBeenCalledExactlyOnceWith(asking.question!.id, "By a third, and use this logo instead.", undefined, model,
    { attachments: [{ id: "att_logo", name: "logo-white.png", size: 10 }] });
  expect(useProjectStore.getState().createTask).not.toHaveBeenCalled();
  expect(container.querySelector(".composer-files")).toBeNull();
  expect(useAttachmentsStore.getState().byProject[PRJ] ?? []).toEqual([]);
  // A frame marked for the answer goes the same way: its picture as a file, and the marks.
  const box = { kind: "box" as const, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } };
  await act(async () => usePictureMarksStore.setState({ marking: null, byProject: { [PRJ]: { time: 7, version: project.head!, picture: "frame://7", marks: [box] } } }));
  expect(names()).toEqual(["Marked frame 0:07"]);
  await type("This one");
  await submit();
  expect(useProjectStore.getState().answerTask).toHaveBeenLastCalledWith(asking.question!.id, "This one", undefined, model, {
    attachments: [expect.objectContaining({ id: "att_frame" })],
    pictureMarks: { attachmentId: "att_frame", time: 7, version: project.head, marks: [box] },
  });
  expect(usePictureMarksStore.getState().byProject[PRJ]).toBeUndefined();
  expect(container.querySelector(".composer-files")).toBeNull();
});

it("takes the marked frame off the message with its ×", async () => {
  usePictureMarksStore.setState({ marking: null, byProject: { [PRJ]: { time: 7, version: project.head!, picture: "frame://7", marks: [{ kind: "box", box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }] } } });
  await show();
  const remove = container.querySelector<HTMLButtonElement>(".composer-file.is-marked-frame .composer-file-remove")!;
  expect(remove.getAttribute("aria-label")).toBe("Remove Marked frame 0:07");
  await act(async () => remove.click());
  expect(usePictureMarksStore.getState().byProject[PRJ]).toBeUndefined();
  expect(container.querySelector(".composer-files")).toBeNull();
});

it("counts the marked frame among the 20 files a message can carry, so the message can still be sent", async () => {
  vi.spyOn(markedFrame, "markedFramePicture").mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  vi.spyOn(api, "uploadAttachment").mockImplementation(async (_project, file) => "path" in file
    ? { attachment: { id: `att_${file.path}`, name: file.path.split("/").pop()!, size: 10 } }
    : { attachment: { id: "att_frame", name: "Marked frame 0.07.png", size: 3, mime: "image/png" } });
  usePictureMarksStore.setState({ marking: null, byProject: { [PRJ]: { time: 7, version: project.head!, picture: "frame://7", marks: [{ kind: "box", box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }] } } });
  await show();
  // Twenty files dropped on a box that already carries a marked frame: the frame is one of the twenty.
  await act(async () => dropTargets.get(container.querySelector(".composer-dock")!)!.drop(Array.from({ length: 20 }, (_, i) => `/Users/me/shot-${i + 1}.png`)));
  expect(container.querySelectorAll(".composer-files .composer-file:not(.is-marked-frame)")).toHaveLength(19);
  await type("Match these shots to the marked frame");
  await submit();
  const sent = vi.mocked(useProjectStore.getState().createTask).mock.calls[0]![1].context!.attachments!;
  expect(sent).toHaveLength(20);
  expect(sent.at(-1)).toMatchObject({ id: "att_frame" });
});

it("keeps a message with twenty files and a frame marked after them in the box, says why, and uploads nothing more", async () => {
  vi.spyOn(markedFrame, "markedFramePicture").mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  const upload = vi.spyOn(api, "uploadAttachment").mockImplementation(async (_project, file) => "path" in file
    ? { attachment: { id: `att_${file.path}`, name: file.path.split("/").pop()!, size: 10 } }
    : { attachment: { id: "att_frame", name: "Marked frame 0.07.png", size: 3, mime: "image/png" } });
  await show();
  await act(async () => dropTargets.get(container.querySelector(".composer-dock")!)!.drop(Array.from({ length: 20 }, (_, i) => `/Users/me/shot-${i + 1}.png`)));
  // The frame is marked once the twenty files are on the box: there is no place left for it.
  await act(async () => usePictureMarksStore.setState({ marking: null, byProject: { [PRJ]: { time: 7, version: project.head!, picture: "frame://7", marks: [{ kind: "box", box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }] } } }));
  await type("Match these shots to the marked frame");
  await submit();
  expect(useProjectStore.getState().createTask).not.toHaveBeenCalled();
  expect(upload).toHaveBeenCalledTimes(20);
  expect(container.querySelector("textarea")!.value).toBe("Match these shots to the marked frame");
  expect(container.querySelector('.composer-dock > [role="alert"]')?.textContent).toBe("A message can carry 20 files, the marked frame included. Remove one.");
  expect(usePictureMarksStore.getState().byProject[PRJ]?.marks).toHaveLength(1);
});

it("sends a message about a moment that carries files as a request about that moment, since a note takes none", async () => {
  vi.spyOn(api, "uploadAttachment").mockResolvedValue({ attachment: { id: "att_logo", name: "logo.png", size: 3 } });
  await show();
  await selectPoint({ time: 11, clipIds: [] });
  await act(async () => dropTargets.get(container.querySelector(".composer-dock")!)!.drop(["/Users/me/logo.png"]));
  await type("Put this logo in the corner here");
  await submit();
  expect(useProjectStore.getState().createNote).not.toHaveBeenCalled();
  expect(useProjectStore.getState().createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    instruction: "Put this logo in the corner here", context: expect.objectContaining({ time: 11, attachments: [{ id: "att_logo", name: "logo.png", size: 3 }] }),
  }));
});

it("carries attached files and marked frames when sending a dictated request about a moment", async () => {
  let micProps!: ComponentProps<typeof mic.MicButton>;
  vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
  const createVoiceNote = vi.fn();
  useProjectStore.setState({ createVoiceNote });
  const upload = vi.spyOn(api, "uploadAttachment").mockResolvedValue({ attachment: { id: "att_logo", name: "logo.png", size: 3 } });
  vi.spyOn(api, "speechToText")
    .mockResolvedValueOnce({ text: "Put this logo in the corner here" })
    .mockResolvedValueOnce({ text: "Use the slide that is uploading" })
    .mockResolvedValueOnce({ text: "Blur the marked area here" });
  const recording = { blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/webm" };

  // Attached file + timeline moment: dictation lands in box, then sending attaches the file and clears it.
  await show();
  await selectPoint({ time: 11, clipIds: [] });
  await act(async () => dropTargets.get(container.querySelector(".composer-dock")!)!.drop(["/Users/me/logo.png"]));
  await act(async () => { micProps.onStart?.(); await micProps.onResult(recording); });
  expect(createVoiceNote).not.toHaveBeenCalled();
  expect(useProjectStore.getState().createTask).not.toHaveBeenCalled();
  expect(useUiStore.getState().agentDraft).toBe("Put this logo in the corner here");
  expect(container.querySelector(".composer-files")).not.toBeNull();
  await submit();
  expect(useProjectStore.getState().createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    instruction: "Put this logo in the corner here",
    context: expect.objectContaining({ time: 11, attachments: [{ id: "att_logo", name: "logo.png", size: 3 }] }),
  }));
  expect(container.querySelector(".composer-files")).toBeNull();

  // An attachment still uploading when the dictated message is sent waits to settle and rides on the request.
  let finishUpload!: (res: { attachment: { id: string; name: string; size: number } }) => void;
  upload.mockImplementationOnce(() => new Promise(resolve => { finishUpload = resolve; }));
  await selectPoint({ time: 12, clipIds: [] });
  await act(async () => { dropTargets.get(container.querySelector(".composer-dock")!)!.drop(["/Users/me/slide.png"]); });
  await act(async () => { micProps.onStart?.(); await micProps.onResult(recording); });
  expect(useUiStore.getState().agentDraft).toBe("Use the slide that is uploading");
  await act(async () => {
    container.querySelector<HTMLButtonElement>(".composer-input button.btn-primary")!.click();
  });
  expect(createVoiceNote).not.toHaveBeenCalled();
  await act(async () => {
    finishUpload({ attachment: { id: "att_slide", name: "slide.png", size: 5 } });
  });
  expect(useProjectStore.getState().createTask).toHaveBeenLastCalledWith(PRJ, expect.objectContaining({
    instruction: "Use the slide that is uploading",
    context: expect.objectContaining({ time: 12, attachments: [{ id: "att_slide", name: "slide.png", size: 5 }] }),
  }));
  expect(container.querySelector(".composer-files")).toBeNull();

  // Marked frame + timeline moment: dictation lands in box, then sending includes marked frame attachment & pictureMarks and clears marks.
  const picture = new Blob(["png"], { type: "image/png" });
  vi.spyOn(markedFrame, "markedFramePicture").mockResolvedValue(picture);
  upload.mockResolvedValueOnce({ attachment: { id: "att_frame", name: "Marked frame 0.07.png", size: 3, mime: "image/png" } });
  const point = { kind: "point" as const, box: { x: 0.5, y: 0.5, w: 0, h: 0 } };
  await act(async () => {
    usePictureMarksStore.setState({ marking: null, byProject: { [PRJ]: { time: 7, version: project.head!, picture: "frame://7", marks: [point] } } });
  });
  await selectPoint({ time: 7, clipIds: [] });
  await act(async () => { micProps.onStart?.(); await micProps.onResult(recording); });
  expect(useUiStore.getState().agentDraft).toBe("Blur the marked area here");
  await submit();
  expect(createVoiceNote).not.toHaveBeenCalled();
  expect(useProjectStore.getState().createTask).toHaveBeenLastCalledWith(PRJ, expect.objectContaining({
    instruction: "Blur the marked area here",
    context: expect.objectContaining({
      time: 7,
      attachments: [{ id: "att_frame", name: "Marked frame 0.07.png", size: 3, mime: "image/png" }],
      pictureMarks: { attachmentId: "att_frame", time: 7, version: project.head, marks: [point] },
    }),
  }));
  expect(usePictureMarksStore.getState().byProject[PRJ]).toBeUndefined();
  expect(container.querySelector(".composer-files")).toBeNull();
});

it("marks timestamps as the editor types and sends the first one with the original words", async () => {
  const seek = vi.fn();
  const messageClock = { version: project.head!, duration: 150, timeline: current.timeline, seek };
  await show({ messageClock });
  const text = "The audio drops at 1:42. Compare 2:02.";
  await type(text);
  const jumps = Array.from(container.querySelectorAll<HTMLButtonElement>(".composer-timestamp"));
  expect(jumps.map(button => button.textContent)).toEqual(["1:42", "2:02"]);
  expect(seek).not.toHaveBeenCalled();
  await act(() => jumps[1]!.click());
  expect(seek).toHaveBeenCalledExactlyOnceWith(122);
  expect(container.querySelector("textarea")!.value).toBe(text);
  await act(() => usePlayerStore.setState({ time: 15 }));
  await submit();
  expect(useProjectStore.getState().createNote).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    time: 102, text, version: project.head,
  }));
  expect(container.querySelector(".composer-timestamp")).toBeNull();
  expect(useUiStore.getState().agentContext).toBeNull();
});

it("keeps a timestamp on the original source while browsing and releases it when removed", async () => {
  const messageClock = { duration: 20, version: project.head!, seek: vi.fn() };
  await show({ messageClock: { ...messageClock, mediaId: "camera-a" } });
  await type("Audio drops at 0:06.250");
  expect(useUiStore.getState().agentContext).toMatchObject({ time: 6.25, mediaId: "camera-a" });
  await show({ messageClock });
  await type("Audio drops at 0:06.250 on the mic");
  expect(container.querySelector(".composer-timestamp")).toBeNull();
  expect(useUiStore.getState().agentContext).toMatchObject({ time: 6.25, mediaId: "camera-a" });
  await type("Audio drops at 0:10");
  expect(useUiStore.getState().agentContext).toMatchObject({ time: 10, mediaId: undefined });
  await type("Audio drops");
  expect(useUiStore.getState().agentContext).toBeNull();
});

it("leaves an explicit range on the message and out-of-bounds or incomplete clocks as text", async () => {
  const messageClock = { duration: 20, version: project.head!, seek: vi.fn() };
  await show({ messageClock });
  await type("1: 4:5 0:60 1:92:04 12:00:foo 0:20 5:24.1234");
  expect(container.querySelector(".composer-timestamp")).toBeNull();
  expect(useUiStore.getState().agentContext).toBeNull();
  const range = { time: 2, end: 8, version: project.head!, clipIds: [] };
  await act(() => useUiStore.getState().setAgentContext(range));
  await type("Compare this with 0:10");
  await submit();
  expect(useProjectStore.getState().createNote).toHaveBeenCalledWith(PRJ, expect.objectContaining({ time: 2, end: 8 }));
});

it("reads 9:16 as the picture's shape, not a time, unless the words before it point at a time", async () => {
  // A video longer than 9:16, so that time is in it.
  const messageClock = { duration: 900, version: project.head!, seek: vi.fn() };
  await show({ messageClock });
  const stamps = () => Array.from(container.querySelectorAll(".composer-timestamp"), stamp => stamp.textContent);
  for (const words of ["Make a 9:16 short of the best part", "Crop to 9:16 for Shorts", "9:16 version, please", "Reframe in 9:16."]) {
    await type(words);
    expect([words, stamps(), useUiStore.getState().agentContext]).toEqual([words, [], null]);
  }
  // Said as a time, it is one.
  for (const words of ["Tighten the pause at 9:16", "Cut from 9:10 to 9:16", "Mute 9:10 – 9:16", "Drop everything after 9:16", "Look @ 9:16"]) {
    await type(words);
    expect([words, stamps().at(-1), useUiStore.getState().agentContext]).toEqual([words, "9:16", expect.objectContaining({ fromMessage: true })]);
  }
  // Any other clock is a time wherever it stands, as before.
  await type("Compare 9:17 with the open");
  expect(stamps()).toEqual(["9:17"]);
  // The short is a new edit about the whole video, not a note at 9:16.
  await type("Make a 9:16 short of the best part");
  await submit();
  expect(useProjectStore.getState().createNote).not.toHaveBeenCalled();
  expect(useProjectStore.getState().createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({
    instruction: "Make a 9:16 short of the best part", context: { version: project.head },
  }));
});

it("marks both ends of a range typed with a plain hyphen, and no clock a hyphen joins to anything else", async () => {
  const messageClock = { duration: 4000, version: project.head!, seek: vi.fn() };
  await show({ messageClock });
  const stamps = () => Array.from(container.querySelectorAll(".composer-timestamp"), stamp => stamp.textContent);
  for (const [words, times] of [
    ["Cut 1:20-1:45", ["1:20", "1:45"]], ["Tighten 9:10-9:16", ["9:10", "9:16"]],
    ["Mute 0:10.5-0:12", ["0:10.5", "0:12"]], ["Look at 1:20-1:45-2:00", ["1:20", "1:45", "2:00"]],
    ["Trim 59:30-1:00:10", ["59:30", "1:00:10"]],
    ["Call at UTC-05:00", []], ["Back up -0:05", []], ["Use clip-1:20", []], ["Shot 100-1:20", []],
    ["Logged at 00:01:20-05:00", ["00:01:20"]], ["Recorded 2026-11-24 01:20-05:00", ["01:20"]],
    ["Recorded 11/24/2026 01:20-05:00", ["01:20"]], ["Shot list for 2026-11-24\n1:20-1:45", ["1:20", "1:45"]],
    ["Cut 1:20--1:45", ["1:20"]],
  ] as const) {
    await type(words);
    expect([words, stamps()]).toEqual([words, times]);
  }
});

it("updates the note target when a timestamp is edited and recognizes an hour clock in pasted prose", async () => {
  const messageClock = { duration: 8000, version: project.head!, seek: vi.fn() };
  await show({ messageClock });
  await type("Look here (1:05:02.125).");
  expect(useUiStore.getState().agentContext).toMatchObject({ time: 3902.125 });
  await type("Look here (1:05:03), then at 1:05:04.");
  expect(useUiStore.getState().agentContext).toMatchObject({ time: 3903 });
  await type("Look here a little later");
  expect(useUiStore.getState().agentContext).toBeNull();
  expect(container.querySelector(".composer-timestamp")).toBeNull();
});

it("keeps the frame a pause picked when the box starts with its time in whole seconds", async () => {
  const messageClock = { version: project.head!, duration: 150, timeline: current.timeline, seek: vi.fn() };
  await act(async () => {
    useUiStore.getState().setAgentDraft("0:04 ");
    useUiStore.getState().setAgentContext({ time: 4.162, version: project.head!, clipIds: [], fromMessage: true });
  });
  await show({ messageClock });
  expect(container.querySelector("textarea")!.value).toBe("0:04 ");
  expect(useUiStore.getState().agentContext).toMatchObject({ time: 4.162, fromMessage: true });
  // A different time typed in its place aims the message there, as any typed time does.
  await type("0:09 zoom in");
  expect(useUiStore.getState().agentContext).toMatchObject({ time: 9, fromMessage: true });
});

it("has nothing to send while the box holds only a time", async () => {
  const messageClock = { version: project.head!, duration: 150, timeline: current.timeline, seek: vi.fn() };
  await show({ messageClock });
  await type("0:04 ");
  expect(container.querySelector(".composer-send")).toBeNull();
  // Enter sends nothing either.
  await act(async () => { container.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  expect(useProjectStore.getState().createNote).not.toHaveBeenCalled();
  expect(container.querySelector("textarea")!.value).toBe("0:04 ");
  await type("0:04 zoom in");
  expect(container.querySelector(".composer-send")).not.toBeNull();
});

it("lets ⌘Z put back a chosen transcript range that Esc took off an empty box, and keeps that Esc to the box", async () => {
  useUiStore.getState().setAgentContext({ time: 12, end: 18, version: project.head!, clipIds: [] });
  await show();
  expect(aimName()?.textContent).toContain("Range");

  const field = container.querySelector("textarea")!;
  let escapedDefaultPrevented = false;
  const checkEscape = (e: KeyboardEvent) => { if (e.key === "Escape") escapedDefaultPrevented = e.defaultPrevented; };
  window.addEventListener("keydown", checkEscape);
  try {
    await act(async () => {
      field.focus();
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(escapedDefaultPrevented).toBe(true);
    expect(useUiStore.getState().agentContext).toBeNull();
    // ⌘Z in the empty box puts the transcript range back.
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
    });
    expect(useUiStore.getState().agentContext).toMatchObject({ time: 12, end: 18 });
  } finally {
    window.removeEventListener("keydown", checkEscape);
  }
});
