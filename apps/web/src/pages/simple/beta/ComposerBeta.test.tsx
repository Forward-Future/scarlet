// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildDb, PRJ } from "../../../lib/mock/fixtures";
import { buildThreads } from "../../../lib/threads";
import { useHostsStore } from "../../../stores/hosts";
import { usePlayerStore } from "../../../stores/player";
import { useProjectStore, type ProjectData } from "../../../stores/project";
import { insertInDraft, markedRangeOf, useUiStore, withMarkedRange, type MarkedRange } from "../../../stores/ui";
import { Composer } from "./ComposerBeta";

const stores = [useProjectStore.getState(), useUiStore.getState(), usePlayerStore.getState(), useHostsStore.getState()] as const;
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
  useProjectStore.setState({ current });
  usePlayerStore.setState({ time: 3.5, playing: false });
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const show = (props: Partial<ComponentProps<typeof Composer>> = {}) => act(async () => root.render(
  <MemoryRouter><Composer {...props} /></MemoryRouter>,
));
const marked: MarkedRange = { start: 42, end: 51, version: project.head!, clipIds: [] };
/** What the workspace does with a stretch marked on the ruler: it aims the box, then writes its times, in one go. */
const markRange = () => act(async () => {
  const box = useUiStore.getState();
  box.setAgentContext(withMarkedRange(box.agentContext, marked));
  insertInDraft("0:42 – 0:51");
});

it.each(["Answer", "Reply"])("keeps a stretch marked on the ruler while the box says %s", async tag => {
  const threads = buildThreads(current);
  const thread = tag === "Answer" ? threads.find(t => t.question)! : threads.find(t => !t.question)!;
  await show({ thread, targetTag: tag });
  await markRange();
  const box = useUiStore.getState();
  expect(box.agentDraft).toContain("0:42 – 0:51");
  expect(markedRangeOf(box.agentContext)).toEqual(marked);
});

it("still makes a reply about the whole request once words are typed with nothing aimed", async () => {
  const thread = buildThreads(current).find(t => !t.question)!;
  await show({ thread, targetTag: "Reply" });
  await act(async () => {
    const input = container.querySelector<HTMLTextAreaElement>(".composer-input textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Shorter");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(useUiStore.getState().agentContext).toBe("whole");
});

it("prevents Esc from bubbling unhandled when clearing a transcript range in an empty box and restores it on ⌘Z", async () => {
  useUiStore.getState().setAgentContext({ time: 12, end: 18, version: project.head!, clipIds: [] });
  await show();
  const input = container.querySelector<HTMLTextAreaElement>(".composer-input textarea")!;
  let prevented = false;
  const onWindowKey = (e: KeyboardEvent) => { if (e.key === "Escape") prevented = e.defaultPrevented; };
  window.addEventListener("keydown", onWindowKey);
  try {
    await act(async () => {
      input.focus();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(prevented).toBe(true);
    expect(useUiStore.getState().agentContext).toBeNull();
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
    });
    expect(useUiStore.getState().agentContext).toMatchObject({ time: 12, end: 18 });
  } finally {
    window.removeEventListener("keydown", onWindowKey);
  }
});
