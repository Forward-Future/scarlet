import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ScarletClient } from "@scarlet/shared";
import { emptyTimeline, makeMediaClip, type CutReview } from "@scarlet/timeline";
import { createScarletMcpServer } from "./server.js";
import { makeState, startMockServer, type MockServer } from "./mock-server.js";

let mock: MockServer;
let editor: Client;
const sessions: Client[] = [];

const original = emptyTimeline("prj_test");
original.version = "v1";
original.tracks[0]!.clips.push(makeMediaClip("m1", 0, 600, 0));
// Short, long enough to show whole automatically, and long enough to need wholePicture.
const removed = [{ start: 10, end: 15 }, { start: 100, end: 130 }, { start: 200, end: 300 }, { start: 400, end: 405 }];
const review: CutReview = { original, proposed: original, firstCut: false,
  cuts: removed.map((r, i) => ({ removed: r, at: r.start, beforeClip: i })) };
const sheets: { from: number; to: number; mode: string }[] = [];
// The suggestion's version, with a join at each cut's position, so every inspection can audit its join.
const proposed = emptyTimeline("prj_test");
proposed.version = "v2";
proposed.tracks[0]!.clips.push(makeMediaClip("m1", 0, 10, 0), makeMediaClip("m1", 15, 105, 10), makeMediaClip("m1", 130, 230, 100),
  makeMediaClip("m1", 300, 500, 200), makeMediaClip("m1", 405, 600, 400));

beforeAll(async () => {
  const state = makeState({ timeline: proposed });
  // The project's copy of the recording matches the 600 s media listing below.
  state.project.media[0]!.duration = 600;
  mock = await startMockServer(state);
  mock.state.extra = (req, res) => {
    let result: unknown;
    if (req.path === "/projects/prj_test/changes/pass") result = { change: { id: "pass", projectId: "prj_test", intent: "suggestion", state: "ready",
      fromVersion: "v1", toVersion: "v2", description: "Review cuts", ranges: removed, renders: [], cutReasons: [] } };
    else if (req.path === "/projects/prj_test/changes/pass/cut-review") result = { review };
    else if (req.path === "/projects/prj_test/changes/pass/cut-assessments") result = { total: 4, assessed: 1, needsDecision: 3 };
    else if (req.path === "/projects/prj_test/media") result = { media: [{ id: "m1", kind: "video", name: "talk.mp4", path: "talk.mp4", duration: 600, fps: 30, hasAudio: true }] };
    else if (req.path.endsWith("/media/m1/waveform")) {
      const from = Number(req.query.get("from")), to = Number(req.query.get("to"));
      const points = Number(req.query.get("points")) || 1;
      result = { mediaId: "m1", from, to, peaks: Array(points).fill(0.1), rms: Array(points).fill(0.01), speechActivity: [] };
    } else if (req.path === "/projects/prj_test/contact-sheet") {
      const { from, to, mode } = req.body as { from: number; to: number; mode: string };
      sheets.push({ from, to, mode });
      result = { state: "ready", windows: [{ label: "Source", id: "m1", clock: "source", range: { start: from, end: to }, timestamps: [from],
        columns: 3, jpeg: "eA==", ...(mode === "activity" ? { changedFrames: 0 } : {}) }] };
    } else return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
    return true;
  };
});

afterAll(async () => {
  for (const session of sessions) await session.close();
  await mock.close();
});

/** Each test reviews the pass in its own agent session. */
beforeEach(async () => {
  sheets.length = 0;
  const server = createScarletMcpServer(new ScarletClient({ baseUrl: mock.url, token: "tok" }), {
    projectId: "prj_test", taskId: "review-task", taskStartedAt: "2026-04-01T12:00:00.000Z", agent: "codex",
    author: { type: "agent", id: "codex", name: "codex" },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  editor = new Client({ name: "test", version: "0" });
  await editor.connect(b);
  sessions.push(editor);
});

const texts = (r: CallToolResult) => r.content.flatMap(c => c.type === "text" ? [JSON.parse(c.text) as Record<string, unknown>] : []);
const inspect = (args: Record<string, unknown>) => editor.callTool({ name: "dialogue_review_inspect", arguments: { changeId: "pass", ...args } }) as Promise<CallToolResult>;
const save = (index: number) => editor.callTool({ name: "dialogue_review_save", arguments: { changeId: "pass", fromVersion: "v1", toVersion: "v2",
  assessments: [{ index, ...removed[index]!, verdict: "cut", reason: "A clean pause." }] } }) as Promise<CallToolResult>;
const until = async (done: () => boolean) => { for (let i = 0; i < 100 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 5)); };

it("inspects several cuts per call, and returns a longer removal's whole picture in one result when the agent looks closer", async () => {
  const result = await inspect({ index: 0, count: 3 });
  expect(result.isError).toBeFalsy();
  const items = texts(result);
  expect(items.filter(t => "firstPass" in t).map(t => t.index)).toEqual([0, 1, 2]);
  const closing = items.filter(t => "complete" in t);
  expect(closing.map(t => t.complete)).toEqual([true, true, true]);
  // A short removal is one activity sheet. Longer ones show an overview and list what a closer look covers.
  expect(closing[0]).toEqual({ complete: true, additionalActivityWindows: [] });
  expect(closing[1]).toMatchObject({ additionalActivityWindows: [{ id: "m1", start: 100, end: 130 }],
    closerLook: "dialogue_review_inspect with index 1 and wholePicture true returns them in one result." });
  expect(sheets.filter(s => s.from >= 98 && s.to <= 132).map(s => s.mode)).toEqual(["uniform"]);

  const whole = await inspect({ index: 2, wholePicture: true });
  const activity = texts(whole).filter(t => "changedFrames" in t);
  expect(activity).toHaveLength(9);
  const covered = sheets.filter(s => s.mode === "activity" && s.from >= 198 && s.to <= 302);
  expect(covered.every(s => s.to - s.from < 12)).toBe(true);
  expect(Math.min(...covered.map(s => s.from))).toBeCloseTo(198.8);
  expect(Math.max(...covered.map(s => s.to))).toBeCloseTo(301.2);
  expect(texts(whole).at(-1)).toEqual({ complete: true, additionalActivityWindows: [] });
  // The recommendation records that this session inspected the cut.
  expect((await save(2)).isError).toBeFalsy();
  const saved = mock.requests.findLast(r => r.path.endsWith("/cut-assessments"));
  expect((saved?.body as { assessments: { inspected: boolean }[] }).assessments[0]!.inspected).toBe(true);
});

it("prepares the following cuts while the agent reads, and hands each over once", async () => {
  await inspect({ index: 0 });
  // Nothing asked for cut 3 yet, but its picture is already on its way.
  await until(() => sheets.some(s => s.from >= 398));
  expect(sheets.some(s => s.from >= 398)).toBe(true);
  const before = sheets.length;
  const result = await inspect({ index: 3 });
  expect(texts(result).find(t => "firstPass" in t)).toMatchObject({ index: 3, start: 400, end: 405 });
  expect(sheets.slice(before).filter(s => s.from >= 398)).toEqual([]);
  // Asking again inspects afresh.
  await inspect({ index: 3 });
  expect(sheets.slice(before).filter(s => s.from >= 398)).toHaveLength(1);
});
