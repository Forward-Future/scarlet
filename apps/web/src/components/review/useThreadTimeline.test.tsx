// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ThreadEdit } from "@scarlet/shared";
import { markedRangeOf, useUiStore, type MarkedRange } from "../../stores/ui";
import { useThreadTimeline } from "./useThreadTimeline";

let root: Root;
let container: HTMLDivElement;
let view: ReturnType<typeof useThreadTimeline>;

function Probe() {
  view = useThreadTimeline("prj", null, undefined, undefined, false);
  return null;
}

const edit: ThreadEdit = { changeId: "chg_1", spot: 0, label: "Zoom", range: { start: 11, end: 14 }, previous: [] };
const marked: MarkedRange = { start: 42, end: 51, version: "v_1", clipIds: [] };

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useUiStore.setState({ agentContext: null, agentDraft: "" });
  await act(async () => root.render(<Probe />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useUiStore.setState({ agentContext: null, agentDraft: "" });
  vi.unstubAllGlobals();
});

it("keeps a stretch marked on the ruler when an edit is opened from the timeline with an empty box", async () => {
  useUiStore.setState({ agentContext: { time: marked.start, end: marked.end, clipIds: [], markedRange: marked } });
  await act(async () => view.choose(edit));
  expect(markedRangeOf(useUiStore.getState().agentContext)).toEqual(marked);
});

it("keeps the stretch on a message being written when the timeline aims it at an edit", async () => {
  useUiStore.setState({ agentDraft: "tighten this", agentContext: { time: marked.start, end: marked.end, clipIds: [], markedRange: marked } });
  await act(async () => view.choose(edit));
  const context = useUiStore.getState().agentContext;
  expect(context).toMatchObject({ changeId: "chg_1", editIndex: 0, time: 11, end: 14, markedRange: marked });
});

it("still clears a plain aim when an edit is opened from the timeline with an empty box", async () => {
  useUiStore.setState({ agentContext: { time: 7, clipIds: [] } });
  await act(async () => view.choose(edit));
  expect(useUiStore.getState().agentContext).toBeNull();
});
