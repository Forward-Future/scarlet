// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { buildDb, PRJ } from "../../lib/mock/fixtures";
import { useProjectStore } from "../../stores/project";
import { useUiStore } from "../../stores/ui";
import { NotePopover } from "./NotePopover";

it("names Scarlet on the switch that sends the note", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const oldProject = useProjectStore.getState();
  const oldUi = useUiStore.getState();
  const db = buildDb();
  const project = db.projects.find(p => p.id === PRJ)!;
  useProjectStore.setState({ status: "ready", current: {
    id: PRJ, project, timeline: db.timelines[project.head!]!, media: project.media, changes: db.changes, notes: db.notes,
    renders: [], tasks: db.tasks, taskEvents: db.taskEvents,
  } });
  useUiStore.setState({ notePopover: { open: true, time: 12 } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<NotePopover />));
    const toggle = container.querySelector('[role="switch"]')!;
    expect(toggle.getAttribute("aria-label")).toBe("Send to Scarlet");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    useProjectStore.setState(oldProject, true);
    useUiStore.setState(oldUi, true);
    vi.unstubAllGlobals();
  }
});
