// @vitest-environment happy-dom
// Time React commits to a DOM. No native window, network, decoder, layout or paint.
import { bench, describe, vi } from "vitest";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { ProjectsPage } from "../src/pages/ProjectsPage";
import { SimpleWorkspace } from "../src/pages/SimpleWorkspace";
import { buildDb, PRJ } from "../src/lib/mock/fixtures";
import { api } from "../src/lib/client";
import { useProjectStore } from "../src/stores/project";

vi.hoisted(() => vi.stubGlobal("fetch", async () => new Response("{}", { status: 503 })));
const loadList = useProjectStore.getState().loadList;
const db = buildDb();
const project = db.projects.find(p => p.id === PRJ)!;
const summary = db.summaries[PRJ]!;
const projects = Array.from({length: 32}, (_, i) => ({...summary, id: "p" + i, name: "Project " + i, poster: null}));
const current = { id: PRJ, project, timeline: db.timelines[project.head!]!, media: project.media,
  changes: db.changes, notes: db.notes, tasks: db.tasks, renders: db.renders, taskEvents: db.taskEvents, versions: db.versions[PRJ] };

function renderScreen(library: boolean) {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    flushSync(() => root.render(library
      ? <MemoryRouter><ProjectsPage /></MemoryRouter>
      : <MemoryRouter initialEntries={["/p/" + PRJ]}><SimpleWorkspace /></MemoryRouter>));
    if (!container.querySelector(library ? ".project-card, .project-caption" : ".monitor-playback")) {
      throw new Error("Missing loaded screen in benchmark");
    }
  } finally { root.unmount(); }
}
describe("mount and release a loaded editor screen", () => {
  useProjectStore.setState({ list: projects, listStatus: "ready", loadList: async () => {}, loadTaskEvents: async () => {}, current, status: "ready" });
  vi.spyOn(api, "trash").mockResolvedValue({projects: []});
  vi.spyOn(api, "settings").mockResolvedValue({settings: db.settings});
  vi.spyOn(api, "renders").mockResolvedValue({renders: []});
  vi.spyOn(api, "sourceCaches").mockResolvedValue({caches: []});
  vi.spyOn(api, "threadEdits").mockResolvedValue({version: project.head!, edits: []});
  vi.spyOn(api, "projects").mockImplementation(async () => ({ projects: structuredClone(projects) }));
  renderScreen(true);
  renderScreen(false);
  bench("library of 32 projects", () => renderScreen(true));
  bench("interview workspace and editing controls", () => renderScreen(false));
});


describe("library polling with 32 project cards on screen", () => {
  let root: Root;
  bench("apply an unchanged project list response", async () => {
    await loadList();
    flushSync(() => {});
  }, {
    setup() {
      root = createRoot(document.createElement("div"));
      flushSync(() => root.render(<MemoryRouter><ProjectsPage /></MemoryRouter>));
    },
    teardown() { root.unmount(); },
  });
});
