// @vitest-environment happy-dom
// pnpm --filter @scarlet/web exec vitest bench --run bench/transcript.bench.tsx
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter } from "react-router-dom";
import { bench, describe, vi } from "vitest";
import { buildDb, PRJ } from "../src/lib/mock/fixtures";
import { api } from "../src/lib/client";
import { TranscriptPane } from "../src/components/transcript/TranscriptPane";
import { useProjectStore } from "../src/stores/project";

const db = buildDb();
const project = db.projects.find(p => p.id === PRJ)!;
const source = { ...project.media[0]!, duration: 2400, transcriptId: "transcript" };
const transcript = (from: number) => ({
  id: "transcript", mediaId: source.id, segments: Array.from({ length: 10 }, (_, s) => ({
    id: String(from + s * 6), start: from + s * 6, end: from + (s + 1) * 6, text: "spoken passage",
    words: Array.from({ length: 18 }, (_, w) => ({text: w === 17 ? "word." : "word",
      start: from + s * 6 + w / 3, end: from + s * 6 + (w + 1) / 3})),
  })),
});
const current = { id: PRJ, project, timeline: db.timelines[project.head!]!, media: [source],
  changes: db.changes, notes: db.notes, tasks: db.tasks, renders: db.renders, taskEvents: db.taskEvents };

describe("select and read five transcript pages, 900 visible words", () => {
  let root: Root, words: HTMLElement[];
  const container = document.createElement("div");
  async function setup() {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings });
    vi.spyOn(api, "transcript").mockImplementation(async (_id, q) => transcript(q?.from ?? 0));
    useProjectStore.setState({ current, status: "ready" });
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<MemoryRouter><TranscriptPane source={source} onAsk={() => {}} /></MemoryRouter>));
    for (let i = 0; i < 4; i++) {
      const next = [...container.querySelectorAll("button")].find(b => b.textContent === "Load later words");
      if (!next) throw new Error("Missing transcript paging action");
      await act(async () => next.click());
    }
    words = [...container.querySelectorAll<HTMLElement>("[data-w]")];
    if (words.length !== 900) throw new Error("Expected all transcript pages");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
  }
  const options = {
    setup, time: 600, iterations: 5,
    teardown() { root.unmount(); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); },
  };
  bench("drag a 24-word selection", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => words[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    for (let i = 1; i < 24; i++) await act(async () => {
      words[i - 1]!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: words[i]!}));
      words[i]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: words[i - 1]!}));
    });
    words[23]!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
    if (!words[23]!.classList.contains("bg-hi-dim")) throw new Error("Selection did not move");
  }, options);
  bench("extend a 24-word selection with Shift+Right", () => {
    flushSync(() => words[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    words[0]!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    for (let i = 0; i < 23; i++) flushSync(() => words[i]!.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true, key: "ArrowRight", shiftKey: true,
    })));
    if (!words[23]!.classList.contains("bg-hi-dim")) throw new Error("Keyboard selection did not move");
  }, options);
  bench("ten background project updates while transcript is open", () => {
    for (let i = 0; i < 10; i++) flushSync(() => useProjectStore.setState(state => ({
      current: { ...state.current!, renders: [...state.current!.renders] },
    })));
  }, options);
});
