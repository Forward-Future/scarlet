// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDb, PRJ } from "../../../lib/mock/fixtures";
import { api } from "../../../lib/client";
import * as markedFrame from "../../../lib/markedFrame";
import { buildThreads } from "../../../lib/threads";
import { useAttachmentsStore, type PendingAttachment } from "../../../stores/attachments";
import { useHostsStore } from "../../../stores/hosts";
import { usePictureMarksStore } from "../../../stores/pictureMarks";
import { usePlayerStore } from "../../../stores/player";
import { useProjectStore, type ProjectData } from "../../../stores/project";
import { insertInDraft, markedRangeOf, useUiStore, withMarkedRange, type MarkedRange } from "../../../stores/ui";
import * as mic from "../../../components/agent/MicButton";
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
  useAttachmentsStore.setState({ byProject: {} });
  usePictureMarksStore.setState({ marking: null, byProject: {} });
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

it("refuses twenty attached files plus a marked frame in the beta composer before uploading the frame", async () => {
  const frameSpy = vi.spyOn(markedFrame, "markedFramePicture").mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  const upload = vi.spyOn(api, "uploadAttachment");
  const createTask = vi.fn();
  useProjectStore.setState({ createTask });
  const twenty: PendingAttachment[] = Array.from({ length: 20 }, (_, i) => ({
    key: `k${i}`, name: `shot-${i}.png`, state: "ready",
    attachment: { id: `att_${i}`, name: `shot-${i}.png`, size: 10 },
  }));
  useAttachmentsStore.setState({ byProject: { [PRJ]: twenty } });
  usePictureMarksStore.setState({
    marking: null,
    byProject: { [PRJ]: { time: 7, version: project.head!, picture: "frame://7", marks: [{ kind: "box", box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }] } },
  });
  useUiStore.setState({ agentDraft: "Match these shots" });
  await show();
  const input = container.querySelector<HTMLTextAreaElement>(".composer-input textarea")!;
  await act(async () => {
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  expect(frameSpy).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
  expect(createTask).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("A message can carry 20 files, the marked frame included. Remove one.");
});

describe.each([true, false])("dictation with review %s", review => {
  it(review ? "leaves what was said in the box, after the draft and focused, and sends nothing" : "sends what was said as soon as the recording stops", async () => {
    useUiStore.setState({ reviewDictation: review });
    let micProps!: ComponentProps<typeof mic.MicButton>;
    vi.spyOn(mic, "MicButton").mockImplementation(props => { micProps = props; return <></>; });
    const createTask = vi.fn().mockResolvedValue(db.tasks[0]);
    useProjectStore.setState({ createTask });
    vi.spyOn(api, "speechToText").mockResolvedValue({ text: "Add a title at the start" });
    await show();
    expect(micProps.review).toBe(review);
    const input = () => container.querySelector<HTMLTextAreaElement>(".composer-input textarea")!;
    if (review) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), "Make it punchy.");
        input().dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    await act(async () => { micProps.onStart?.(); });
    await act(async () => { micProps.onResult({ blob: new Blob(["voice"]), seconds: 1, mimeType: "audio/mp4" }); });
    if (review) {
      expect(input().value).toBe("Make it punchy. Add a title at the start");
      expect(document.activeElement).toBe(input());
      expect(input().selectionStart).toBe(input().value.length);
      expect(createTask).not.toHaveBeenCalled();
    } else {
      expect(createTask).toHaveBeenCalledWith(PRJ, expect.objectContaining({ instruction: "Add a title at the start", voiceTranscript: "Add a title at the start" }));
      expect(input().value).toBe("");
    }
  });
});
