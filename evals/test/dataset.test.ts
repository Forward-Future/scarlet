import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildCase } from "../src/dataset.ts";
import { Engine } from "../src/engine.ts";
import { cut, media } from "./fixtures.ts";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "scarlet-eval-test-"));
  vi.stubEnv("SCARLET_APP_SUPPORT", scratch);
  vi.stubEnv("SCARLET_EVAL_DATA", join(scratch, "evals"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

const recording = media("med_mic", 20);
// Part one takes out 4–6 s. Part two then takes out 10–12 s of the shorter version: 12–14 s of the recording.
// v0r and v1r play what v0 and v1 do: the versions a part applies when the editor restores its one cut.
const timelines = new Map([["v0", cut("v0", recording.id, [[0, 20]])], ["v1", cut("v1", recording.id, [[0, 4], [6, 20]])],
  ["v2", cut("v2", recording.id, [[0, 4], [6, 12], [14, 20]])], ["v0r", cut("v0r", recording.id, [[0, 20]])], ["v1r", cut("v1r", recording.id, [[0, 4], [6, 20]])],
  ["v2r", cut("v2r", recording.id, [[0, 12], [14, 20]])]]);
const part = (id: string, fromVersion: string, toVersion: string, start: number, createdAt: string) => ({ id, projectId: "prj_test", taskId: "tsk_pass",
  intent: "requested", state: "approved", fromVersion, toVersion, createdAt, ops: [{ op: "rippleDelete", start, end: start + 2 }], cutReasons: [{ start, end: start + 2, reason: "Pause" }] });
const one = part("chg_1", "v0", "v1", 4, "2026-01-01T00:00:01Z"), two = part("chg_2", "v1", "v2", 10, "2026-01-01T00:00:02Z");
// Undone and approved again with its one cut restored, as the engine stores it: the review applied no removal.
const restored = (change: ReturnType<typeof part>, appliedVersion: string, duration: number) => ({ ...change, restoredCuts: [0], appliedOnto: change.fromVersion,
  appliedVersion, appliedReview: { originalVersion: change.fromVersion, joins: [], originalDuration: duration, duration } });
// One part that takes out 4–6 s and 12–14 s of the recording, stored as the engine writes it: descending removals, its calls in timeline order.
const both = { ...part("chg_3", "v0", "v2", 4, "2026-01-01T00:00:01Z"), ops: [{ op: "rippleDelete", start: 12, end: 14 }, { op: "rippleDelete", start: 4, end: 6 }],
  cutReasons: [{ start: 4, end: 6, reason: "Pause" }, { start: 12, end: 14, reason: "Pause" }] };

async function cutLabels(id: string, changes: Array<{ id: string; [field: string]: unknown }>) {
  const task = { id: "tsk_pass", projectId: "prj_test", kind: "edit", state: "done", instruction: "/dialogue-pass", context: {}, changeIds: changes.map(c => c.id) };
  const routes = new Map<string, unknown>([
    ["/api/projects/prj_test", { project: { id: "prj_test", media: [recording], settings: { fps: 30 } } }],
    ["/api/skills", { skills: [] }],
    ["/api/tasks/tsk_pass", { task, events: [] }],
    ["/api/projects/prj_test/usage", { groups: [] }],
    ...changes.map(change => [`/api/changes/${change.id}`, { change }] as const),
    ["/api/media/med_mic/waveform", { rms: [0] }],
    ["/api/media/med_mic/transcript", { segments: [] }],
  ]);
  vi.stubGlobal("fetch", async (address: string) => {
    const url = new URL(address);
    if (url.pathname === "/api/projects/prj_test/timeline") return Response.json({ timeline: timelines.get(url.searchParams.get("version")!) });
    if (!routes.has(url.pathname)) throw new Error(`Unexpected fixture route ${url.pathname}`);
    return Response.json(routes.get(url.pathname));
  });
  const { file } = await buildCase(new Engine("https://capture.example", "fixture-token"), { projectId: "prj_test", fromTask: "tsk_pass", referenceDecisions: true, id });
  return file.reference?.labels?.filter(l => l.label === "cut").map(({ mediaId, start, end }) => ({ mediaId, start, end }));
}

it("labels the applied cuts of every part of a pass on the source clock", async () => {
  expect(await cutLabels("two parts", [one, two])).toEqual([
    { mediaId: recording.id, start: 4, end: 6 },
    { mediaId: recording.id, start: 12, end: 14 },
  ]);
});

it("labels no cut the editor restored when approving a part again", async () => {
  expect(await cutLabels("second restored", [one, restored(two, "v1r", 18)])).toEqual([{ mediaId: recording.id, start: 4, end: 6 }]);
  expect(await cutLabels("first restored", [restored(one, "v0r", 20)])).toEqual([]);
});

it("keeps the labels of the cuts a part's review applied", async () => {
  expect(await cutLabels("nothing restored", [one, { ...two, restoredCuts: [], appliedOnto: "v1", appliedVersion: "v2",
    appliedReview: { originalVersion: "v1", joins: [{ at: 10, removed: { start: 10, end: 12 } }], originalDuration: 18, duration: 16 } }])).toEqual([
    { mediaId: recording.id, start: 4, end: 6 },
    { mediaId: recording.id, start: 12, end: 14 },
  ]);
  expect(await cutLabels("first of two restored", [{ ...both, restoredCuts: [0], appliedOnto: "v0", appliedVersion: "v2r",
    appliedReview: { originalVersion: "v0", joins: [{ at: 12, removed: { start: 12, end: 14 } }], originalDuration: 20, duration: 18 } }])).toEqual([{ mediaId: recording.id, start: 12, end: 14 }]);
});

// An older engine saved the calls restored and no list of the joins that went in.
it("labels no cut an older engine saved as restored", async () => {
  expect(await cutLabels("older second restored", [one, { ...two, restoredCuts: [0], appliedOnto: "v1", appliedVersion: "v1r" }])).toEqual([{ mediaId: recording.id, start: 4, end: 6 }]);
  expect(await cutLabels("older first of two restored", [{ ...both, restoredCuts: [0], appliedVersion: "v2r" }])).toEqual([{ mediaId: recording.id, start: 12, end: 14 }]);
});
