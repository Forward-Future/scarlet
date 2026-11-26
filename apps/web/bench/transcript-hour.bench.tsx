// @vitest-environment happy-dom
// Run from apps/web with pnpm exec vitest bench --run bench/transcript-hour.bench.tsx.
// The Transcript column on the working cut of a one-hour interview: 9,000 words, cut into 600 clips. The column is
// built again for every new working cut (its pane is keyed by the version), with pages already read.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter } from "react-router-dom";
import { bench, describe, vi } from "vitest";
import { timelineFromKeepRanges, type MediaAsset, type Transcript } from "@scarlet/timeline";
import { buildDb, PRJ } from "../src/lib/mock/fixtures";
import { api } from "../src/lib/client";
import { TranscriptPane } from "../src/components/transcript/TranscriptPane";
import { forgetTranscriptPages } from "../src/components/transcript/useTranscriptWindow";
import { usePlayerStore } from "../src/stores/player";
import { useProjectStore } from "../src/stores/project";

const db = buildDb();
const project = db.projects.find(p => p.id === PRJ)!;
const HOUR = 3600, PASSAGES = 600, WORDS = 15;
const source: MediaAsset = { id: "interview", kind: "video", name: "Interview", path: "interview.mp4", duration: HOUR, transcriptId: "hour" };
// Passages of six seconds, fifteen words each, a sentence ending every fifth word; two voices taking turns.
const segments = Array.from({ length: PASSAGES }, (_, s) => ({
  id: "s" + s, start: s * 6, end: s * 6 + 6, text: "spoken passage",
  words: Array.from({ length: WORDS }, (_, w) => ({
    text: w % 5 === 4 ? "word." : w === 0 ? "Word" : "word",
    start: s * 6 + w * 0.38, end: s * 6 + w * 0.38 + 0.3, speaker: Math.floor(s / 10) % 2 ? "Guest" : "Host",
  })),
}));
const page = (from: number, to: number): Transcript => ({ id: "hour", mediaId: source.id,
  segments: segments.filter(s => s.end > from && s.start < to) } as Transcript);
// A dialogue pass took the last half second of every passage out.
const timeline = timelineFromKeepRanges(PRJ, source.id, Array.from({ length: PASSAGES }, (_, i) => ({ start: i * 6, end: i * 6 + 5.5 })));
const current = { id: PRJ, project, timeline, media: [source],
  changes: db.changes, notes: db.notes, tasks: db.tasks, renders: db.renders, taskEvents: db.taskEvents };
const options = { time: 1000, iterations: 5 };
const words = PASSAGES * WORDS;

async function prepare() {
  vi.spyOn(api, "settings").mockResolvedValue({ settings: db.settings });
  vi.spyOn(api, "transcript").mockImplementation(async (_id, range) => page(range?.from ?? 0, range?.to ?? HOUR));
  useProjectStore.setState({ current, status: "ready" });
  usePlayerStore.setState({ time: 0, playing: false, duration: timeline ? HOUR : 0 });
  // Read every page once, as the first opening does.
  forgetTranscriptPages();
  const container = document.createElement("div");
  const root = createRoot(container);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => root.render(<MemoryRouter><TranscriptPane draft={timeline} onAsk={() => {}} /></MemoryRouter>));
  await act(async () => {});
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
  const shown = container.querySelectorAll("[data-w]").length;
  root.unmount();
  if (shown !== words) throw new Error(`Expected ${words} words, saw ${shown}`);
}
function teardown() { vi.restoreAllMocks(); vi.unstubAllGlobals(); }

describe("Transcript of a one-hour interview on its working cut, 9,000 words", () => {
  bench("build the column again for a new working cut", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    flushSync(() => root.render(<MemoryRouter><TranscriptPane draft={timeline} onAsk={() => {}} /></MemoryRouter>));
    const shown = container.querySelectorAll("[data-w]").length;
    root.unmount();
    if (shown !== words) throw new Error(`Expected ${words} words, saw ${shown}`);
  }, { ...options, setup: prepare, teardown });

  let root: Root, nodes: HTMLElement[];
  const container = document.createElement("div");
  async function mount() {
    await prepare();
    document.body.append(container);
    root = createRoot(container);
    flushSync(() => root.render(<MemoryRouter><TranscriptPane draft={timeline} onAsk={() => {}} /></MemoryRouter>));
    nodes = [...container.querySelectorAll<HTMLElement>("[data-w]")];
    if (nodes.length !== words) throw new Error("Expected the whole transcript");
  }
  const open = { ...options, setup: mount, teardown() { root.unmount(); container.remove(); teardown(); } };
  bench("drag a 24-word selection near the end", () => {
    const at = words - 200;
    flushSync(() => nodes[at]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    for (let i = 1; i < 24; i++) flushSync(() => {
      nodes[at + i]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: nodes[at + i - 1]! }));
    });
    nodes[at + 23]!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    if (!nodes[at + 23]!.classList.contains("bg-hi-dim")) throw new Error("Selection did not move");
  }, open);
  bench("60 playback clock updates across the hour", () => {
    for (let i = 0; i < 60; i++) flushSync(() => usePlayerStore.getState().setTime(i * 55));
    if (!container.querySelector("[data-current]")) throw new Error("No word lit");
  }, open);
});
