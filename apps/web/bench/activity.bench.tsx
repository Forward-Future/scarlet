// @vitest-environment happy-dom
// pnpm --filter @scarlet/web exec vitest bench --run bench/activity.bench.tsx
import { bench, describe, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { TaskEvent } from "@scarlet/shared";
import { api } from "../src/lib/client";
import { runItems, runLines } from "../src/lib/taskRun";
import { RunBundle } from "../src/components/review/RunBundle";
import { buildDb, PRJ } from "../src/lib/mock/fixtures";
import { SimpleWorkspace } from "../src/pages/SimpleWorkspace";
import { useProjectStore } from "../src/stores/project";
import { useUiStore } from "../src/stores/ui";

vi.hoisted(() => vi.stubGlobal("fetch", async () => new Response("{}", { status: 503 })));
const db = buildDb();
const project = db.projects.find(p => p.id === PRJ)!;
const changes = Array.from({ length: 300 }, (_, i) => ({
  ...db.changes[0]!, id: "change" + i, threadId: "edit" + i, taskId: undefined, noteIds: [],
  ranges: [{ start: 30, end: 31 }], renders: [], description: "Change to passage " + i,
  state: i < 60 ? "ready" as const : "approved" as const,
}));
const task = { ...db.tasks[0]!, id: "busy", state: "running" as const, changeIds: [], context: { threadId: "active" } };
const history: TaskEvent[] = Array.from({ length: 1500 }, (_, i) => ({
  id: "old" + i, taskId: task.id, at: new Date(i * 1000).toISOString(),
  ...(i % 5 === 0
    ? { type: "log" as const, text: "Reviewed passage " + i, data: { kind: "editor_progress" } }
    : { type: "tool" as const, text: "timeline_get" }),
}));

describe("open editor with 60 pending decisions and 240 completed edits", () => {
  let root: Root, seq: number;
  const container = document.createElement("div");
  const options = {
    async setup() {
      vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings });
      vi.spyOn(api, "renders").mockResolvedValue({ renders: [] });
      vi.spyOn(api, "sourceCaches").mockResolvedValue({ caches: [] });
      vi.spyOn(api, "threadEdits").mockResolvedValue({ version: project.head!, edits: [] });
      useUiStore.setState({ wsStatus: "open" });
      useProjectStore.setState({ current: {
        id: PRJ, project, timeline: db.timelines[project.head!]!, media: project.media, changes, notes: [], renders: [],
        tasks: [task], taskEvents: { [task.id]: history }, versions: db.versions[PRJ],
      }, status: "ready", loadTaskEvents: async () => {} });
      root = createRoot(container);
      flushSync(() => root.render(<MemoryRouter initialEntries={["/p/" + PRJ]}><SimpleWorkspace /></MemoryRouter>));
      await new Promise(resolve => setTimeout(resolve, 0));
      if (container.querySelectorAll(".simple-turn").length < 300 || !container.querySelector(".simple-pin")?.textContent?.includes("Looking at the timeline")) {
        throw new Error("Expected the loaded conversation and active run");
      }
    },
    teardown() { root.unmount(); vi.restoreAllMocks(); },
    time: 600, iterations: 5,
  };
  function publish(event: Pick<TaskEvent, "type" | "text" | "data">) {
    seq++;
    flushSync(() => useProjectStore.getState().applyEvent({
      type: "task.event", projectId: PRJ, taskId: task.id,
      event: { ...event, id: "new" + seq, taskId: task.id, at: new Date((2000 + seq) * 1000).toISOString() },
    }));
  }
  bench("restore a 1,500-event run and display its next ten updates", () => {
    seq = 0;
    flushSync(() => useProjectStore.setState(s => ({ current: { ...s.current!, taskEvents: { [task.id]: history } } })));
    for (let i = 1; i <= 10; i++) publish({ type: "log", text: "Checking passage " + i, data: { kind: "editor_progress" } });
    if (!container.querySelector(".simple-pin")?.textContent?.includes("Checking passage 10")) throw new Error("Active edit did not update");
  }, options);
});

describe("long run details", () => {
  const start = Date.parse("2026-01-01T00:00:00Z");
  const at = (i: number) => new Date(start + i * 1000).toISOString();
  const done = { ...task, startedAt: at(0), createdAt: at(0), finishedAt: at(1800), state: "done" as const };
  const tool = (text: string, i: number): TaskEvent => ({ type: "tool", text, at: at(i + 1), data: { input: { t: i } } });
  const alternating = Array.from({ length: 800 }, (_, i) => tool(i % 2 ? "media_frame" : "waveform_get", i));
  const same = Array.from({ length: 1800 }, (_, i) => tool("media_frame", i));
  const steps = runItems(done, alternating, []);
  const options = { time: 600, iterations: 5 };
  bench("compute elapsed work for 800 steps", () => {
    if (runLines(done, alternating, steps, start + 1800000).length !== 800) throw new Error("Missing steps");
  }, options);
  bench("group 1,800 consecutive frame checks", () => {
    if (runItems(done, same, []).length !== 1) throw new Error("Expected one group");
  }, options);
  bench("render the completed run summary to HTML with 1,800 frame checks", () => {
    if (!renderToString(<RunBundle task={done} events={same} changes={[]} />).includes('data-state="done"')) {
      throw new Error("Missing completed summary");
    }
  }, options);
});
