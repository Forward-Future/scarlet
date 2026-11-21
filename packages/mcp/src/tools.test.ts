/** Tools and failure paths server.test.ts leaves alone: sync, crossfades, comparisons, auditions, notes, annotations and what goes to stderr. */
import "./cutSummaries.testkit.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { EDITING_TOOL_GROUPS, ScarletApiError, ScarletClient, Task } from "@scarlet/shared";
import { applyOps, emptyTimeline, makeMediaClip, OpError, timelineDuration, type MediaClip, type Note, type Timeline, type Transcript } from "@scarlet/timeline";
import { z } from "zod/v3";
import { toolAnnotations } from "./annotations.js";
import { syncRate } from "./audio-sync.js";
import { relativeLinks } from "./graphics-tools.js";
import { createScarletMcpServer, transcriptionNote, validateOps, type ScarletMcpContext } from "./server.js";
import { describeError, formatZodError } from "./tool-result.js";
import { makeState, startMockServer, type MockServer, type RecordedRequest } from "./mock-server.js";

const transcript: Transcript = { id: "t1", mediaId: "m1", segments: [{ id: "s1", start: 0, end: 6, text: "Hello everyone welcome back.", words: [
  { text: "Hello", start: 0.2, end: 0.5 }, { text: "everyone", start: 0.6, end: 1.0 }, { text: "welcome", start: 1.1, end: 1.4 }, { text: "back.", start: 1.5, end: 1.8 }] }] };

let mock: MockServer;
let stderr: ReturnType<typeof vi.spyOn>;
const textOf = (r: CallToolResult) => r.content.filter(c => c.type === "text").map(c => (c as { text: string }).text).join("\n");
/** What the server wrote to stderr, one line each. */
const logged = () => stderr.mock.calls.map(args => args.join(" "));

async function connect(ctx: Partial<ScarletMcpContext> = {}) {
  const server = createScarletMcpServer(new ScarletClient({ baseUrl: mock.url, token: "tok" }), {
    projectId: "prj_test", agent: "claude", author: { type: "agent", id: "claude", name: "claude", model: "opus" }, ...ctx });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(b);
  return c;
}
/** A harness that delivers audio to its model. */
const hearing = () => connect({ agent: "codex", capabilities: { images: true, audio: true, files: true }, author: { type: "agent", name: "codex" } });
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => await c.callTool({ name, arguments: args }) as CallToolResult;
const ok = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await call(c, name, args);
  expect(r.isError, textOf(r)).toBeFalsy();
  return r;
};
const reply = (res: Parameters<NonNullable<MockServer["state"]["extra"]>>[1], body: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  return true;
};
const sent = (path: string, method = "POST") => mock.requests.filter(r => r.method === method && r.path === path);

beforeAll(async () => { mock = await startMockServer(makeState({ transcripts: { m1: transcript } })); });
afterAll(() => mock.close());

let pristine: { media: MockServer["state"]["project"]["media"]; waveform: MockServer["state"]["waveform"]; head: string | undefined };
beforeEach(() => {
  pristine = { media: mock.state.project.media, waveform: mock.state.waveform, head: mock.state.project.head };
  mock.requests.length = 0;
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  stderr.mockRestore();
  mock.state.project.media = pristine.media;
  mock.state.project.head = pristine.head;
  Object.assign(mock.state, { waveform: pristine.waveform, extra: undefined, timeline: null, notes: [], events: [], transcripts: { m1: transcript } });
});

it("sends the exact review range and timeline version when flagging a named edit", async () => {
  mock.state.timeline = { ...emptyTimeline("prj_test"), version: "reviewed-cut" };
  const path = "/projects/prj_test/edit-flags";
  mock.state.extra = (req, res) => req.method === "POST" && req.path === path && reply(res, { flagged: { changeId: "opening", spot: 0 } });
  const c = await connect({ taskId: "task-review" });
  try {
    await ok(c, "timeline_at", { time: 0 });
    const edit = { check: "Check the picture at the comparison", changeId: "opening", spot: 0 };
    const range = { start: 518.4, end: 520 };
    await ok(c, "edit_flag", { ...edit, range });
    await ok(c, "edit_flag", { ...edit, range, version: "other-cut" });
    const missingRange = await call(c, "edit_flag", { ...edit, version: "other-cut" });
    expect(missingRange.isError).toBe(true);
    expect(textOf(missingRange)).toContain("Give range with version.");
    expect(sent(path).map(req => req.body)).toEqual([
      { ...edit, range, version: "reviewed-cut", taskId: "task-review" },
      { ...edit, range, version: "other-cut", taskId: "task-review" },
    ]);
  } finally { await c.close(); }
});

describe("audio_sync", () => {
  function envelope(seed: number, length: number) {
    return Array.from({ length }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    });
  }
  // A 210 s session recording; a camera that rolled for its last 30 s; a microphone started 2.5 s after the camera.
  const session = envelope(41, 210 * syncRate);
  const camera = session.slice(180 * syncRate);
  const mic = camera.slice(2.5 * syncRate).map((n, i) => 0.1 + n * 0.55 + 0.02 * Math.cos(i));
  const levels: Record<string, number[]> = { session, m1: camera, m2: mic };

  beforeEach(() => {
    mock.state.project.media = [
      { id: "m1", kind: "video", name: "camera.mp4", path: "camera.mp4", duration: 30, hasAudio: true },
      { id: "m2", kind: "audio", name: "mic.wav", path: "mic.wav", duration: 27.5, hasAudio: true },
      { id: "session", kind: "audio", name: "session.wav", path: "session.wav", duration: 210, hasAudio: true },
      { id: "silent", kind: "video", name: "screen.mp4", path: "screen.mp4", duration: 30, hasAudio: false },
    ];
    mock.state.waveform = (mediaId, from, to, points) => ({ mediaId, from, to, peaks: levels[mediaId]!.slice(Math.round(from * syncRate), Math.round(from * syncRate) + points) });
  });
  const windows = (id: string) => mock.requests.filter(r => r.path.endsWith(`/media/${id}/waveform`)).map(r => [Number(r.query.get("from")), Number(r.query.get("to")), Number(r.query.get("points"))]);

  it("measures how long after the reference the secondary starts, in either order", async () => {
    const c = await connect();
    try {
      expect(JSON.parse(textOf(await ok(c, "audio_sync", { referenceId: "m1", secondaryId: "m2" })))).toMatchObject({ secondaryStartRelativeToReference: 2.5, resolutionSeconds: .02 });
      expect(JSON.parse(textOf(await ok(c, "audio_sync", { referenceId: "m2", secondaryId: "m1" }))).secondaryStartRelativeToReference).toBe(-2.5);
      // Each recording is read whole, at one level per 20 ms.
      expect(windows("m1")[0]).toEqual([0, 30, 1500]);
      expect(windows("m2")[0]).toEqual([0, 27.5, 1375]);
    } finally { await c.close(); }
  });

  it("reads a long recording in parts and matches across where they meet", async () => {
    const c = await connect();
    try {
      const match = JSON.parse(textOf(await ok(c, "audio_sync", { referenceId: "session", secondaryId: "m1" })));
      expect(match.secondaryStartRelativeToReference).toBe(180);
      expect(match.matchedWindows).toBeGreaterThanOrEqual(2);
      expect(windows("session")).toEqual([[0, 200, 10000], [200, 210, 500]]);
    } finally { await c.close(); }
  });

  it("reports no offset for a recording without sound, and never reads its levels", async () => {
    const c = await connect();
    try {
      expect(JSON.parse(textOf(await ok(c, "audio_sync", { referenceId: "m1", secondaryId: "silent" }))))
        .toEqual({ matchedWindows: 0, reason: "No unambiguous constant offset from shared audio." });
      expect(windows("silent")).toEqual([]);
    } finally { await c.close(); }
  });

  it("says what to do about the same recording twice, an unknown one, and levels that stop short", async () => {
    const c = await connect();
    try {
      const same = await call(c, "audio_sync", { referenceId: "m1", secondaryId: "m1" });
      expect(same.isError).toBe(true);
      expect(textOf(same)).toContain("Choose two different recordings.");
      const unknown = await call(c, "audio_sync", { referenceId: "m1", secondaryId: "m9" });
      expect(unknown.isError).toBe(true);
      expect(textOf(unknown)).toContain("Media m9 is not in this project. Use project_get for media ids.");
      mock.state.waveform = (mediaId, from, to, points) => ({ mediaId, from, to, peaks: levels[mediaId]!.slice(0, mediaId === "m2" ? 1000 : points) });
      const short = await call(c, "audio_sync", { referenceId: "m1", secondaryId: "m2" });
      expect(short.isError).toBe(true);
      expect(textOf(short)).toContain("The waveform of m2 covered 1000 of 1375 samples from 0.0 s.");
    } finally { await c.close(); }
  });
});

describe("timeline_framing", () => {
  const screen = { id: "scr", kind: "video" as const, name: "screen.mp4", path: "screen.mp4", duration: 120, fps: 30, width: 3840, height: 2160 };
  const inset = { scale: 0.3, x: 0.326, y: 0.315, cropLeft: 0.105, cropRight: 0.05, cornerRadius: 0.095 };
  beforeEach(() => {
    // A screen demo cut in two at 10 s, with the camera in the corner over it.
    mock.state.project.media = [...mock.state.project.media, screen];
    const tl = emptyTimeline("prj_test");
    tl.version = "cut";
    tl.tracks[0]!.clips = [makeMediaClip("scr", 0, 10, 0, { id: "s0", volume: 0 }), makeMediaClip("scr", 12, 32, 10, { id: "s1", volume: 0 })];
    tl.tracks.splice(1, 0, { id: "v2", kind: "video", name: "Camera", muted: false, hidden: false,
      clips: [makeMediaClip("m1", 0, 30, 0, { id: "cam", transform: inset as MediaClip["transform"] })] });
    mock.state.timeline = tl;
    mock.state.extra = (req, res) => {
      if (req.method === "POST" && req.path === "/projects/prj_test/timeline-pictures") {
        const times = (req.body as { times: number[] }).times;
        return reply(res, { pictures: times.map(time => ({ time, jpeg: "/9j/4A==" })) });
      }
      if (req.method === "GET" && req.path === "/projects/prj_test/media/scr/screen-text") return reply(res, { from: 0, to: 1, readSeconds: 1, done: true, spans: [
        { start: 0, end: 30, text: "Pass@1 vs. cost per task", box: [0.3, 0.3, 0.5, 0.32] },
        { start: 0, end: 30, text: "Claude Fable 5", box: [0.62, 0.62, 0.68, 0.635] },
        { start: 0, end: 30, text: "GPT-6 Sol max", box: [0.72, 0.62, 0.78, 0.635] },
        { start: 0, end: 30, text: "A sentence whose end runs under the inset", box: [0.4, 0.6, 0.76, 0.615] },
        { start: 0, end: 30, text: "Recycle Bin", box: [0.0, 0.04, 0.03, 0.05] }] });
      return false;
    };
  });
  afterEach(() => { mock.state.extra = undefined; });
  const proposed = () => sent("/projects/prj_test/changes").map(r => r.body as { ops: Array<{ op: string; clipId: string; patch: { transform: Record<string, number>; keyframes: unknown[] } }> });
  const framings = [{ at: 0, show: [25, 20, 70, 70], within: [20, 5, 90, 95] }, { at: 9.5, show: [30, 28, 52, 40] }];

  it("fills the video around each area, moves between them across the cut, and reports each frame with its picture", async () => {
    const c = await connect();
    try {
      await ok(c, "timeline_get");
      const result = await ok(c, "timeline_framing", { mediaId: "scr", framings, reason: "The chart is what the narration is about." });
      const { ops } = proposed()[0]!;
      expect(ops.map(o => [o.op, o.clipId])).toEqual([["updateClip", "s0"], ["updateClip", "s1"]]);
      // Each clip is cropped to the canvas's shape or larger, so the picture covers the video.
      for (const { patch } of ops) {
        const t = patch.transform;
        expect(t.scale).toBeGreaterThanOrEqual(1);
        expect((1 - t.cropLeft! - t.cropRight!) / (1 - t.cropTop! - t.cropBottom!)).toBeGreaterThan(0.99);
      }
      expect(ops[0]!.patch.keyframes).toHaveLength(2);
      expect(ops[1]!.patch.keyframes).toHaveLength(2);
      const report = JSON.parse(result.content.filter(x => x.type === "text").map(x => (x as { text: string }).text).find(t => t.includes('"framings"'))!);
      expect(report).toMatchObject({ mediaId: "scr", clips: 2, video: "1920x1080", textUnderCover: [0] });
      expect(report.framings[0]).toMatchObject({ at: 0, arrives: "cut", holds: 9.5, covers: [[expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number)]] });
      expect(report.framings[0].hidden).toBeUndefined();
      expect(report.framings[0].beyondWithin).toBeUndefined();
      // The chart's title is in the area shown; the label under the inset is named; the desktop's text is neither.
      expect(report.framings[0].text.lines).toBe(3);
      expect(report.framings[0].text.underCover).toEqual(["GPT-6 Sol max", "A sentence whose end runs under the inset"]);
      // The one corner where the camera would sit on none of the frame's text.
      expect(report.framings[0].text.cornersClearOfText).toEqual(["top-right"]);
      expect(report.framings[1]).toMatchObject({ arrives: "move", settles: 10.5, holds: 19.5 });
      expect(report.framings[1].zoom).toBeGreaterThan(2.5);
      expect(report.framings[1].text).toMatchObject({ lines: 1, smallest: expect.any(Number) });
      expect(result.content.filter(x => x.type === "image")).toHaveLength(2);
      const pictures = sent("/projects/prj_test/timeline-pictures")[0]!.body as { version: string; ops: unknown[]; times: number[] };
      expect(pictures.version).toBe("cut");
      expect(pictures.ops).toHaveLength(2);
      expect(pictures.times).toEqual([0.1, 10.6]);
    } finally { await c.close(); }
  });

  it("shows a preview without saving, and names a framing that falls where the recording doesn't play", async () => {
    const c = await connect();
    try {
      await ok(c, "timeline_get");
      const result = await ok(c, "timeline_framing", { mediaId: "scr", framings, preview: true });
      expect(sent("/projects/prj_test/changes")).toHaveLength(0);
      expect(textOf(result)).toContain('"preview":true,"saved":false');
      expect(result.content.filter(x => x.type === "image")).toHaveLength(2);
      // Moved to the corner the text leaves free, the camera covers no line, and its clip is part of the edit.
      const moved = await ok(c, "timeline_framing", { mediaId: "scr", framings: [{ ...framings[0], inset: "top-right" }], preview: true });
      const there = JSON.parse(textOf(moved).split("\n")[0]!);
      expect(there).toMatchObject({ insetClips: 1 });
      expect(there.textUnderCover).toBeUndefined();
      expect(there.framings[0].text.underCover).toBeUndefined();
      expect((sent("/projects/prj_test/timeline-pictures").at(-1)!.body as { ops: Array<{ clipId: string }> }).ops.map(o => o.clipId)).toEqual(["s0", "s1", "cam"]);
      // Asked to keep clear of text, the camera goes to that corner by itself, and comes home once nothing is under it there.
      const cleared = JSON.parse(textOf(await ok(c, "timeline_framing", { mediaId: "scr", preview: true,
        framings: [{ ...framings[0], inset: "clear" }, { at: 9.5, show: [30, 28, 52, 40], inset: "clear" }] })).split("\n")[0]!);
      expect(cleared.framings.map((f: { inset: string }) => f.inset)).toEqual(["top-right", "bottom-right"]);
      expect(cleared.textUnderCover).toBeUndefined();
      expect(cleared.insetClips).toBe(1);
      const refused = await call(c, "timeline_framing", { mediaId: "scr", framings: [{ at: 45, show: [0, 0, 50, 50] }], preview: true });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain("framings[0].at 45 s: scr doesn't play there");
    } finally { await c.close(); }
  });

  it("saves a stretch as one edit in the agent's words, and a second framing of it as that edit revised", async () => {
    let saves = 0;
    const others = mock.state.extra!;
    // An engine that applies what was asked for, as it does for a request the editor made.
    mock.state.extra = (req, res) => {
      if (req.method !== "POST" || req.path !== "/projects/prj_test/changes") return others(req, res);
      const body = req.body as { ops: Parameters<typeof applyOps>[1]; description: string; timelineEdits?: unknown };
      const after = { ...applyOps(mock.state.timeline!, body.ops), version: `framed${++saves}` };
      mock.state.timeline = after;
      return reply(res, { change: { id: `chg_framed${saves}`, projectId: "prj_test", fromVersion: "cut", toVersion: after.version, description: body.description,
        author: { type: "agent", name: "mock" }, noteIds: [], ranges: [], state: "approved", renders: [], timelineEdits: body.timelineEdits }, timeline: after });
    };
    const c = await connect({ taskId: "task-framing" });
    try {
      await ok(c, "timeline_get");
      const edits = () => sent("/projects/prj_test/changes").map(r => (r.body as { timelineEdits?: unknown[] }).timelineEdits);
      await ok(c, "timeline_framing", { intent: "requested", mediaId: "scr", framings, description: "Framed the chart", reason: "The chart is what the narration is about." });
      expect(edits()[0]).toEqual([{ label: "Framed the chart", range: { start: 0, end: 30 }, reason: "The chart is what the narration is about." }]);
      // Having seen it, the agent frames the same stretch wider: the editor's list keeps one row for it.
      await ok(c, "timeline_framing", { intent: "requested", mediaId: "scr", framings: [{ at: 0, show: [20, 10, 80, 80] }], description: "Widened the chart", reason: "The axis labels were cut off." });
      expect(edits()[1]).toEqual([{ label: "Widened the chart", range: { start: 0, end: 30 }, reason: "The axis labels were cut off.", replaces: { changeId: "chg_framed1", spot: 0 } }]);
      // A framing of part of it is an edit of its own, and one of the whole stretch after that revises the whole stretch's row.
      await ok(c, "timeline_framing", { intent: "requested", mediaId: "scr", framings: [{ at: 12, show: [30, 30, 50, 50] }], to: 20, description: "Pushed in on the title", reason: "He reads the title aloud." });
      expect(edits()[2]).toEqual([{ label: "Pushed in on the title", range: { start: 12, end: 20 }, reason: "He reads the title aloud." }]);
      await ok(c, "timeline_framing", { intent: "requested", mediaId: "scr", framings: [{ at: 0, show: [20, 10, 80, 80] }], description: "Held the wide chart", reason: "The push-in hid the legend." });
      expect((edits()[3] as Array<{ replaces?: unknown }>)[0]!.replaces).toEqual({ changeId: "chg_framed2", spot: 0 });
      // The editor undid that edit meanwhile, so the engine won't revise it: the framing is saved as an edit of its own.
      const applying = mock.state.extra!;
      mock.state.extra = (req, res) => req.method === "POST" && req.path === "/projects/prj_test/changes" && (req.body as { timelineEdits?: Array<{ replaces?: unknown }> }).timelineEdits?.[0]?.replaces
        ? reply(res, { error: { code: "invalid_replacement", message: "Choose an individual edit in this thread to revise." } }, 400) : applying(req, res);
      await ok(c, "timeline_framing", { intent: "requested", mediaId: "scr", framings: [{ at: 0, show: [10, 10, 90, 90] }], description: "Showed the whole chart", reason: "He compares both ends." });
      expect(edits().slice(4).map(list => (list as Array<{ replaces?: unknown }>)[0]!.replaces)).toEqual([{ changeId: "chg_framed4", spot: 0 }, undefined]);
    } finally { await c.close(); }
  });

  it("says where an edit leaves a picture on screen for a few frames between two others", async () => {
    const c = await connect();
    try {
      await ok(c, "timeline_get");
      const tight = { scale: 1.18, x: 0, y: -0.06 };
      const camera = (id: string, from: number, to: number, at: number, transform?: object) =>
        ({ op: "addClip", trackId: "v3", clip: { id, kind: "media", mediaId: "m1", sourceIn: from, sourceOut: to, timelineIn: at, volume: 0, ...(transform && { transform }) } });
      // The wide camera ends four frames before the punch-in, so the screen and inset show through for 0.13 s.
      const result = JSON.parse(textOf(await ok(c, "timeline_propose", { ops: [{ op: "addTrack", track: { id: "v3", kind: "video", name: "Full camera", clips: [] } },
        camera("wide", 0, 9.87, 0), camera("punch", 10, 30, 10, tight)], description: "Punched in on the camera", reason: "He makes the main point here." })).split("\n")[0]!);
      expect(result.briefPictures).toEqual([{ from: 9.87, to: 10, seconds: 0.13, shows: ["cam", "s0"], before: ["wide"], after: ["punch"] }]);
      expect(result.briefNext).toContain("run the shot before or after over it");
      expect(result.metCut).toBeUndefined();
    } finally { await c.close(); }
  });

  it("moves a picture laid over the edit onto the cut beside it when it would flash for a tenth of a second or less", async () => {
    const c = await connect();
    try {
      await ok(c, "timeline_get");
      const tight = { scale: 1.18, x: 0, y: -0.06 };
      const camera = (id: string, from: number, to: number, at: number, transform?: object) =>
        ({ op: "addClip", trackId: "v3", clip: { id, kind: "media", mediaId: "m1", sourceIn: from, sourceOut: to, timelineIn: at, volume: 0, ...(transform && { transform }) } });
      // Three frames short: the screen and inset would show through for 0.1 s.
      const result = JSON.parse(textOf(await ok(c, "timeline_propose", { ops: [{ op: "addTrack", track: { id: "v3", kind: "video", name: "Full camera", clips: [] } },
        camera("wide", 0, 9.9, 0), camera("punch", 10, 30, 10, tight)], description: "Punched in on the camera", reason: "He makes the main point here." })).split("\n")[0]!);
      expect(result.briefPictures).toBeUndefined();
      expect(result.metCut).toEqual([{ from: 9.9, to: 10, seconds: 0.1, clips: ["wide"] }]);
      expect(result.metCutNext).toContain("onto the cut beside it");
    } finally { await c.close(); }
  });

  it("says where a crop made with timeline_propose leaves the background showing", async () => {
    const c = await connect();
    try {
      await ok(c, "timeline_get");
      const crop = { x: 0, y: 0, scale: 1, cropLeft: 0.355, cropRight: 0.27, cropTop: 0.096, cropBottom: 0.1 };
      const result = JSON.parse(textOf(await ok(c, "timeline_propose", { ops: [{ op: "updateClip", clipId: "s0", patch: { transform: crop } }, { op: "updateClip", clipId: "s1", patch: { transform: crop } }],
        description: "Framed the phone demo", reason: "The phone is what the narration is about." })).split("\n")[0]!);
      expect(result.backgroundShows).toEqual([{ from: 0, to: 30, clipId: "s0", clips: 2, share: expect.any(Number) }]);
      expect(result.backgroundShows[0].share).toBeGreaterThan(0.4);
      expect(result.backgroundNext).toContain("timeline_framing");
    } finally { await c.close(); }
  });

  it("shows all an inset shows of its recording, close up, when an edit crops it anew", async () => {
    const c = await connect();
    try {
      await ok(c, "timeline_get");
      const tighter = { ...inset, cropTop: 0.02, cropBottom: 0.25, cropLeft: 0.2, cropRight: 0.2 };
      const result = await ok(c, "timeline_propose", { ops: [{ op: "updateClip", clipId: "cam", patch: { transform: tighter } }],
        description: "Tightened the camera inset", reason: "He asked for more of his face." });
      const report = JSON.parse(textOf(result).split("\n")[0]!);
      expect(report.insetLook).toEqual([{ mediaId: "m1", trackId: "v2", clips: 1, crop: [20, 2, 80, 75], at: [15] }]);
      expect(report.insetLookNext).toContain("close up");
      const asked = mock.requests.filter(r => r.path.endsWith("/media/m1/frame"));
      expect(asked.map(r => Object.fromEntries(r.query))).toEqual([expect.objectContaining({ t: "15", w: "640", area: "20,2,80,75" })]);
      expect(result.content.filter(part => part.type === "image")).toHaveLength(1);
      // Moving it to another corner keeps its crop and size: nothing new to look at.
      mock.requests.length = 0;
      const moved = await ok(c, "timeline_propose", { ops: [{ op: "updateClip", clipId: "cam", patch: { transform: { ...inset, x: -0.326 } } }],
        description: "Moved the camera inset left", reason: "The chart's legend is on the right." });
      expect(JSON.parse(textOf(moved).split("\n")[0]!).insetLook).toBeUndefined();
      expect(mock.requests.filter(r => r.path.endsWith("/media/m1/frame"))).toEqual([]);
    } finally { await c.close(); }
  });

  it("waits within one tool call's time across every measurement a save waits for", async () => {
    // The engine takes each wait it is given in full: the recording's cuts, then its edges, then a look at a frame.
    const waited: Array<[string, number]> = [];
    const others = mock.state.extra!;
    vi.useFakeTimers({ toFake: ["Date"] });
    mock.state.extra = (req, res) => {
      const wait = Number(req.query.get("wait") ?? 0);
      const answer = (body: object) => {
        waited.push([req.path.split("/").slice(-2).join("/"), wait]);
        vi.setSystemTime(Date.now() + wait * 1000);
        return reply(res, body);
      };
      if (req.path.endsWith("/picture-cuts")) return answer({ from: 0, to: 120, readSeconds: 1, done: false, cuts: [] });
      if (req.path.endsWith("/show-area")) return answer({ mediaId: "scr", step: 5, done: true, areas: [], unset: [[0, 120]] });
      if (req.path.endsWith("/show-area/ask")) return answer({ mediaId: "scr", step: 5, done: true, areas: [], unset: [[0, 120]], asked: 1, answered: 1 });
      return others(req, res);
    };
    const c = await connect({ taskId: "task-waits" });
    try {
      await ok(c, "timeline_get");
      const refused = await call(c, "timeline_propose", { ops: [{ op: "updateClip", clipId: "s0", patch: { transform: { cropLeft: 0.1, cropTop: 0.1, cropRight: 0.2, cropBottom: 0.1 } } }],
        intent: "requested", description: "Cropped the demo.", reason: "The window is the subject." });
      expect(textOf(refused)).toContain("no area says what viewers may see");
      expect(waited.map(([what]) => what)).toEqual(expect.arrayContaining(["scr/picture-cuts", "scr/show-area"]));
      // Claude Code's calls wait 240 s at most: each wait has what the ones before it left.
      expect(waited.reduce((sum, [, wait]) => sum + wait, 0)).toBeLessThanOrEqual(240);
    } finally {
      vi.useRealTimers();
      await c.close();
    }
  });

  describe("with areas viewers may see on record", () => {
    // One window from 0 to 60 s of the screen recording: 10-80% across, 10-90% down. Nothing is set after that.
    const window = { at: 5, area: [0.1, 0.1, 0.8, 0.9], noLine: [], holds: [[0, 60]] };
    let posted: unknown[];
    beforeEach(() => {
      posted = [];
      const earlier = mock.state.extra!;
      mock.state.extra = (req, res) => {
        if (req.path === "/projects/prj_test/media/scr/show-area") {
          if (req.method === "POST") posted.push(req.body);
          return reply(res, { mediaId: "scr", step: 5, done: true, areas: [window], unset: [[60, 120]] });
        }
        if (req.path.endsWith("/show-area")) return reply(res, { mediaId: "m1", step: 5, done: true, areas: [], unset: [[0, 60]] });
        return earlier(req, res);
      };
    });

    it("saves an area in fractions and lists the areas, where they hold and what is unset", async () => {
      const c = await connect();
      try {
        await ok(c, "timeline_get");
        const result = JSON.parse(textOf(await ok(c, "screen_area", { mediaId: "scr", set: [{ at: 5, area: [10, 10, 80, 90] }], pictures: 0 })));
        expect(posted).toEqual([{ set: [{ at: 5, area: [0.1, 0.1, 0.8, 0.9] }] }]);
        expect(result.areas).toEqual([{ at: 5, area: [10, 10, 80, 90], holds: [[0, 60]], heldSeconds: 60 }]);
        // The edit plays nothing of the recording past 30 s, so the unset stretch is not on picture.
        expect(result.unset).toEqual([{ from: 60, to: 120, onPicture: 0, look: 90 }]);
        expect(textOf(await call(c, "screen_area", { mediaId: "scr", set: [{ at: 5, area: [10, 10, 12, 90] }] }))).toContain("set[0].area is [left, top, right, bottom] in percent, at least 5 percent each way");
        // Every area too small is named in one refusal.
        const several = textOf(await call(c, "screen_area", { mediaId: "scr", set: [{ at: 5, area: [10, 10, 12, 90] }, { at: 9, area: [10, 10, 80, 90] }, { at: 20, area: [10, 10, 80, 11] }] }));
        expect(several).toContain("set[0].area and set[2].area are each [left, top, right, bottom] in percent");
      } finally { await c.close(); }
    });

    it("refuses a save that frames the recording past its area, and one that frames part of a picture with no area", async () => {
      const c = await connect();
      try {
        await ok(c, "timeline_get");
        const past = textOf(await call(c, "timeline_propose", { ops: [{ op: "updateClip", clipId: "s0", patch: { transform: { cropLeft: 0.1, cropTop: 0.1, cropBottom: 0.1 } } }],
          intent: "requested", description: "Cropped the demo.", reason: "The window is the subject." }));
        expect(past).toContain("Not saved.");
        expect(past).toContain("past it right 20%");
        const none = textOf(await call(c, "timeline_propose", { ops: [{ op: "updateClip", clipId: "cam", patch: { transform: { scale: 1.4 } } }],
          intent: "requested", description: "Punched in.", reason: "Emphasis." }));
        expect(none).toContain("no area says what viewers may see");
        expect(none).toContain("m1 source 0-60 s");
        expect(proposed()).toHaveLength(0);
        // Inside the area it saves.
        await ok(c, "timeline_propose", { ops: [{ op: "updateClip", clipId: "s0", patch: { transform: { cropLeft: 0.1, cropTop: 0.1, cropRight: 0.2, cropBottom: 0.1 } } }],
          intent: "requested", description: "Cropped the demo.", reason: "The window is the subject." });
        expect(proposed()).toHaveLength(1);
      } finally { await c.close(); }
    });

    it("keeps a frame with no `within` inside the area on record", async () => {
      const c = await connect();
      try {
        await ok(c, "timeline_get");
        const result = JSON.parse(textOf(await ok(c, "timeline_framing", { mediaId: "scr", framings: [{ at: 0, show: [30, 30, 60, 60] }], preview: true })).split("\n")[0]!);
        const [left, top, right, bottom] = result.framings[0].frame as number[];
        expect(left).toBeGreaterThanOrEqual(10);
        expect(top).toBeGreaterThanOrEqual(10);
        expect(right).toBeLessThanOrEqual(80);
        expect(bottom).toBeLessThanOrEqual(90);
      } finally { await c.close(); }
    });
  });
});

describe("media_frame", () => {
  it("asks for one area of the picture with labelled percent lines", async () => {
    const c = await connect();
    try {
      const result = await ok(c, "media_frame", { mediaId: "m1", t: 12, width: 1280, area: [30, 10, 80, 90], grid: true });
      const asked = mock.requests.find(r => r.path.endsWith("/media/m1/frame"))!;
      expect(Object.fromEntries(asked.query)).toMatchObject({ t: "12", w: "1280", area: "30,10,80,90", grid: "1" });
      expect(textOf(result)).toContain("30–80% across and 10–90% down, lines in percent of the whole picture");
      expect(textOf(await call(c, "media_frame", { mediaId: "m1", t: 12, area: [30, 10, 30.5, 90] }))).toContain("at least 1 percent each way");
    } finally { await c.close(); }
  });
});

describe("timeline_transition", () => {
  let first: MediaClip, second: MediaClip;
  beforeEach(() => {
    // Two pieces of the talk on the picture track, cut together at 2 s.
    first = makeMediaClip("m1", 1, 3, 0);
    second = makeMediaClip("m1", 10, 14, 2);
    const tl = emptyTimeline("prj_test");
    tl.version = "cut";
    tl.tracks[0]!.clips = [first, second];
    mock.state.timeline = tl;
  });
  const proposed = () => sent("/projects/prj_test/changes").map(r => r.body as { ops: Array<{ op: string; clipId: string; patch: Record<string, unknown> }>; description: string });
  it("takes a type and duration, says where the nearest join is when none is at the time given, and takes a transition off", async () => {
    const c = await connect();
    try {
      await ok(c, "timeline_get");
      expect(textOf(await call(c, "timeline_transition", { joins: [{ at: 1 }], type: "dissolve" }))).toContain("No join on v1 at 0:01.00. The nearest is at 0:02.00 (2.000 s).");
      await ok(c, "timeline_transition", { joins: [{ clipId: second.id }], type: "dip", duration: 0.6,
        reason: "A dip marks the passage of time between scenes." });
      expect(proposed()[0]!.ops[0]!.patch).toEqual({ transitionIn: { type: "dip", duration: 0.6, direction: "left" } });
      await ok(c, "timeline_transition", { joins: [{ clipId: second.id }], none: true,
        reason: "The two angles show continuous action." });
      expect(proposed()[1]!.ops[0]!.patch).toEqual({ transitionIn: null });
    } finally { await c.close(); }
  });
});

describe("timeline_crossfade_audio", () => {
  let left: MediaClip, right: MediaClip, tl: Timeline;
  beforeEach(() => {
    // Two takes of the microphone, cut together at 2 s.
    left = makeMediaClip("m2", 0, 2, 0);
    right = makeMediaClip("m2", 3, 5, 2);
    tl = emptyTimeline("prj_test");
    tl.version = "cut";
    tl.tracks[1]!.clips = [left, right];
    mock.state.timeline = tl;
  });
  const proposed = () => sent("/projects/prj_test/changes").map(r => r.body as { ops: Array<{ op: string; clipId: string; patch: Record<string, number> }>; description: string; fromVersion?: string });

  it("overlaps the two clips around the join by two frames of real source, as one proposal on the version read", async () => {
    const c = await connect();
    try {
      await ok(c, "timeline_get");
      const reason = "The abrupt room-tone change makes the join audible.";
      const result = JSON.parse(textOf(await ok(c, "timeline_crossfade_audio", { joins: [{ leftClipId: left.id, rightClipId: right.id }], reason })));
      const [body] = proposed();
      expect(body).toMatchObject({ description: "Smooth the selected dialogue joins", reason, fromVersion: "cut" });
      const patch = (id: string) => body!.ops.find(op => op.op === "updateClip" && op.clipId === id)!.patch;
      // At 30 fps the overlap is 2/30 s, half of it from each side's handle.
      expect(patch(left.id)).toMatchObject({ timelineIn: 0, sourceIn: 0, sourceOut: expect.closeTo(2 + 1 / 30, 9), audioFadeOut: expect.closeTo(2 / 30, 9) });
      expect(patch(right.id)).toMatchObject({ timelineIn: expect.closeTo(2 - 1 / 30, 9), sourceIn: expect.closeTo(3 - 1 / 30, 9), sourceOut: 5, audioFadeIn: expect.closeTo(2 / 30, 9) });
      // The picture's timing holds: the edit is as long as it was.
      expect(result).toMatchObject({ state: "proposed", fromVersion: "cut" });
      expect(timelineDuration(mock.state.timeline!)).toBeCloseTo(4, 9);
    } finally { await c.close(); }
  });

  it("takes the overlap asked for", async () => {
    const c = await connect();
    try {
      await ok(c, "timeline_crossfade_audio", { joins: [{ leftClipId: left.id, rightClipId: right.id }], duration: .2, description: "Soften the join",
        reason: "The editor asked for a longer transition into the answer." });
      const [body] = proposed();
      expect(body!.description).toBe("Soften the join");
      expect(body!.ops.find(op => op.clipId === right.id)!.patch).toMatchObject({ timelineIn: expect.closeTo(1.9, 9), sourceIn: expect.closeTo(2.9, 9), audioFadeIn: .2 });
    } finally { await c.close(); }
  });

  it("proposes nothing for clips that don't meet or a source with no handle left", async () => {
    const c = await connect();
    try {
      const apart = await call(c, "timeline_crossfade_audio", { joins: [{ leftClipId: right.id, rightClipId: left.id }] });
      expect(apart.isError).toBe(true);
      expect(textOf(apart)).toContain(`Choose touching audible clips on the same track: ${right.id}, ${left.id}`);
    } finally { await c.close(); }
    // The outgoing take runs to the last sample of the recording.
    const last = makeMediaClip("m2", 118, 120, 0);
    tl.tracks[1]!.clips = [last, right];
    const fresh = await connect();
    try {
      const short = await call(fresh, "timeline_crossfade_audio", { joins: [{ leftClipId: last.id, rightClipId: right.id }] });
      expect(short.isError).toBe(true);
      expect(textOf(short)).toContain(`Insufficient audio handles on ${last.id} for a ${2 / 30} s crossfade`);
      expect(proposed()).toEqual([]);
    } finally { await fresh.close(); }
  });
});

describe("change_review_cut", () => {
  const window = (label: string, id: string, jpeg: string) => ({ label, clock: "timeline", id, range: { start: 2, end: 5 }, focus: 3.5, timestamps: [2, 3.5, 5], columns: 3, jpeg });
  const reviews = () => sent("/projects/prj_test/review-cut").map(r => r.body);

  it("waits for the comparison to render, then returns each side's frames and what is new at the cut", async () => {
    let asked = 0;
    mock.state.extra = (req, res) => req.path !== "/projects/prj_test/review-cut" ? false
      : reply(res, asked++ ? { state: "ready", index: 1, total: 3, newEvents: [{ kind: "black", start: 3.5, end: 3.6 }], windows: [window("Before", "v1", "QkVGT1JF"), window("After", "v2", "QUZURVI=")] }
        : { state: "preparing", renderIds: ["rnd_compare"] });
    const c = await connect();
    try {
      const r = await ok(c, "change_review_cut", { changeId: "chg_1", index: 1 });
      // A harness that delivers no audio never asks the engine for it.
      expect(reviews()).toEqual(Array(2).fill({ changeId: "chg_1", index: 1, edge: "start", handles: 1.5, includeAudio: false }));
      expect(sent("/projects/prj_test/renders/rnd_compare", "GET")).toHaveLength(1);
      expect(r.content.map(part => part.type)).toEqual(["text", "text", "image", "text", "image"]);
      expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ index: 1, total: 3, newEvents: [{ kind: "black", start: 3.5, end: 3.6 }],
        comparison: "Potential new events on the proposed timeline. Check the images before acting." });
      // Each window's facts are text beside its picture, without the picture's bytes in them.
      expect(JSON.parse((r.content[1] as { text: string }).text)).toEqual({ label: "Before", clock: "timeline", id: "v1", range: { start: 2, end: 5 }, focus: 3.5, timestamps: [2, 3.5, 5], columns: 3 });
      expect(r.content[4]).toEqual({ type: "image", mimeType: "image/jpeg", data: "QUZURVI=" });
    } finally { await c.close(); }
  });

  it.each([false, true])("keeps measurements available without delivering pictures (audio %s)", async audio => {
    mock.state.extra = (req, res) => req.path !== "/projects/prj_test/review-cut" ? false
      : reply(res, { state: "ready", index: 0, total: 1, newEvents: [{ kind: "black" }], windows: [{ ...window("After", "v2", "QUZURVI="), wav: "UklGRg==" }] });
    const c = await connect({ capabilities: { images: false, audio, files: false, plan: false } });
    try {
      const tools = (await c.listTools()).tools;
      expect(tools.find(tool => tool.name === "dialogue_review_inspect")?.inputSchema.properties).not.toHaveProperty("wholePicture");
      const list = tools.map(tool => tool.name);
      for (const name of ["media_frame", "frame_contact_sheet", "frame_contact_sheet_batch", "sound_picture"]) expect(list).not.toContain(name);
      const result = await ok(c, "change_review_cut", { changeId: "chg_1", includeAudio: audio });
      expect(result.content.map(part => part.type)).toEqual(audio ? ["text", "text", "audio"] : ["text", "text"]);
      expect(textOf(result)).toContain('"kind":"black"');
      expect(textOf(result)).not.toContain("Check the images");
    } finally { await c.close(); }
  });

  it("passes a hearing model's request for audio on and returns each side's audition", async () => {
    mock.state.extra = (req, res) => req.path !== "/projects/prj_test/review-cut" ? false
      : reply(res, { state: "ready", index: 0, total: 1, windows: [{ ...window("After", "v2", "QUZURVI="), wav: "UklGRg==" }] });
    const c = await hearing();
    try {
      const r = await ok(c, "change_review_cut", { changeId: "chg_1", includeAudio: true, edge: "end", handles: .5 });
      expect(reviews()).toEqual([{ changeId: "chg_1", index: 0, edge: "end", handles: .5, includeAudio: true }]);
      expect(r.content.at(-1)).toEqual({ type: "audio", mimeType: "audio/wav", data: "UklGRg==" });
      // With nothing flagged on either side, the comparison says only one side plays.
      expect(JSON.parse((r.content[0] as { text: string }).text).comparison).toBe("Only one side has playable footage.");
    } finally { await c.close(); }
  });

  it("reports why a comparison could not be rendered", async () => {
    mock.state.extra = (req, res) => req.path === "/projects/prj_test/review-cut" ? reply(res, { state: "preparing", renderIds: ["rnd_bad"] })
      : req.path === "/projects/prj_test/renders/rnd_bad" ? reply(res, { render: { id: "rnd_bad", state: "failed", error: "The source file is offline." } }) : false;
    const c = await connect();
    try {
      const r = await call(c, "change_review_cut", { changeId: "chg_1" });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("The source file is offline.");
    } finally { await c.close(); }
  });

  it("gives the renderer's own words for a comparison that failed, not the sentence the editor reads", async () => {
    const detail = "ffmpeg exited with code 1:\n/data/media/med_a.mov: Invalid data found when processing input";
    mock.state.extra = (req, res) => req.path === "/projects/prj_test/review-cut" ? reply(res, { state: "preparing", renderIds: ["rnd_bad"] })
      : req.path === "/projects/prj_test/renders/rnd_bad" ? reply(res, { render: { id: "rnd_bad", state: "failed",
        error: "Scarlet can’t read “Interview” in this project’s files: export the logs from Settings → Advanced to report it.", errorDetail: detail } }) : false;
    const c = await connect();
    try {
      const r = await call(c, "change_review_cut", { changeId: "chg_1" });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain(detail);
      expect(textOf(r)).not.toContain("Settings → Advanced");
    } finally { await c.close(); }
  });
});

describe("source_audio", () => {
  it("returns the asked window of the original recording as audio, for a model that can hear", async () => {
    mock.state.extra = (req, res) => req.path !== "/projects/prj_test/source-audio" ? false
      : (req.body as { to: number }).to > 100 ? reply(res, { error: { code: "bad_request", message: "Choose a window inside the recording." } }, 400)
      : reply(res, { wav: "UklGRg==" });
    const c = await hearing();
    try {
      const r = await ok(c, "source_audio", { mediaId: "m2", from: 12, to: 16, voice: "me" });
      expect(r.content).toEqual([{ type: "audio", mimeType: "audio/wav", data: "UklGRg==" }]);
      expect(sent("/projects/prj_test/source-audio")[0]!.body).toEqual({ mediaId: "m2", from: 12, to: 16, voice: "me" });
      const outside = await call(c, "source_audio", { mediaId: "m2", from: 118, to: 124 });
      expect(outside.isError).toBe(true);
      expect(textOf(outside)).toBe("Scarlet server error 400 (bad_request): Choose a window inside the recording.");
    } finally { await c.close(); }
  });
});

describe("sound_picture", () => {
  it("shows a passage as waveform and spectrogram with its words, and a model that can hear gets the audio with it", async () => {
    const layout = { width: 1280, height: 768, pixelsPerSecond: 320, rows: [{ shows: "recorded", top: 0, bottom: 384, left: 0, right: 1280, seconds: 4 }] };
    mock.state.extra = (req, res) => req.path === "/projects/prj_test/sound-picture" ? reply(res, { jpeg: "/9j/", layout })
      : req.path === "/projects/prj_test/source-audio" ? reply(res, { wav: "UklGRg==" }) : false;
    mock.state.transcripts = { m1: transcript };
    const seeing = await connect();
    try {
      const r = await ok(seeing, "sound_picture", { mediaId: "m1", from: 0.4, to: 1.45, remove: [{ start: 0.55, end: 1.05 }] });
      expect(r.content).toEqual([{ type: "text", text: JSON.stringify({ mediaId: "m1", from: 0.4, to: 1.45, ...layout }) }, { type: "image", mimeType: "image/jpeg", data: "/9j/" }]);
      // The words in the passage go with the request, so the picture can name them.
      expect(sent("/projects/prj_test/sound-picture")[0]!.body).toEqual({ mediaId: "m1", from: 0.4, to: 1.45, remove: [{ start: 0.55, end: 1.05 }],
        words: [{ text: "Hello", start: 0.2, end: 0.5 }, { text: "everyone", start: 0.6, end: 1.0 }, { text: "welcome", start: 1.1, end: 1.4 }] });
      expect(sent("/projects/prj_test/source-audio")).toHaveLength(0);
    } finally { await seeing.close(); }
    const listening = await hearing();
    try {
      const r = await ok(listening, "sound_picture", { mediaId: "m1", from: 0.4, to: 1.45 });
      expect(r.content.map(c => c.type)).toEqual(["text", "image", "audio"]);
      expect(sent("/projects/prj_test/source-audio").at(-1)!.body).toEqual({ mediaId: "m1", from: 0.4, to: 1.45 });
    } finally { await listening.close(); }
  });

  it("draws the same passage on several recordings in one call, each after its own line", async () => {
    const layout = { width: 1280, height: 384, pixelsPerSecond: 320, rows: [{ shows: "recorded", top: 0, bottom: 384, left: 0, right: 1280, seconds: 4 }] };
    mock.state.extra = (req, res) => req.path !== "/projects/prj_test/sound-picture" ? false
      : (req.body as { mediaId: string }).mediaId === "gone" ? reply(res, { error: { code: "not_found", message: "media not found" } }, 404)
      : reply(res, { jpeg: `/9j/${(req.body as { mediaId: string }).mediaId}`, layout });
    mock.state.transcripts = { m1: transcript };
    const seeing = await connect();
    try {
      const r = await ok(seeing, "sound_picture", { mediaIds: ["m1", "m2", "gone"], from: 1, to: 5 });
      expect(r.content.map(c => c.type)).toEqual(["text", "image", "text", "image", "text"]);
      expect(r.content[1]).toMatchObject({ data: "/9j/m1" });
      expect(r.content[2]).toEqual({ type: "text", text: JSON.stringify({ mediaId: "m2", from: 1, to: 5, ...layout }) });
      expect(r.content[3]).toMatchObject({ data: "/9j/m2" });
      expect(JSON.parse((r.content[4] as { text: string }).text)).toEqual({ mediaId: "gone", error: expect.stringContaining("media not found") });
      expect(sent("/projects/prj_test/sound-picture").map(req => (req.body as { mediaId: string }).mediaId).sort()).toEqual(["gone", "m1", "m2"]);
      // Up to four pictures come in one call.
      expect((await call(seeing, "sound_picture", { mediaIds: ["m1", "m2", "m3", "m4", "m5"], from: 1, to: 5 })).isError).toBe(true);
    } finally { await seeing.close(); }
  });
});

describe("review notes", () => {
  const author = { type: "human" as const, name: "Dana" };
  const notes: Note[] = [
    { id: "n1", projectId: "prj_test", version: "v3", time: 12.5, end: 14, clipIds: ["clip_a", "clip_b"], text: "Trim the pause here.", author, assignedTo: "claude",
      changeId: "chg_7", state: "open", replies: [{ text: "Tightened to half a second.", author: { type: "agent", name: "claude" } }] },
    { id: "n2", projectId: "prj_test", version: "v3", time: 40, clipIds: [], text: "Good take.", author, state: "resolved" },
  ];
  beforeEach(() => { mock.state.notes = structuredClone(notes); });

  it("lists each note with where it is pinned, what it is about and its replies", async () => {
    const c = await connect();
    try {
      expect(textOf(await ok(c, "notes_list"))).toBe("2 note(s):\n"
        + "n1 [open] @12.50–14.00 s on v3 clips clip_a,clip_b about chg_7 for claude by Dana: Trim the pause here. | reply from claude: Tightened to half a second.\n"
        + "n2 [resolved] @40.00 s on v3 by Dana: Good take.");
      // A state narrows the list at the engine.
      expect(textOf(await ok(c, "notes_list", { state: "resolved" }))).toBe("1 note(s):\nn2 [resolved] @40.00 s on v3 by Dana: Good take.");
      expect(sent("/projects/prj_test/notes", "GET").map(r => r.query.get("state"))).toEqual([null, "resolved"]);
    } finally { await c.close(); }
  });

  it("replies as the agent running the session and reports the note's state", async () => {
    const c = await connect();
    try {
      expect(textOf(await ok(c, "note_reply", { noteId: "n1", text: "Cut it to 0.4 s." }))).toBe("Replied to note n1; it is open.");
      expect(sent("/projects/prj_test/notes/n1/reply")[0]!.body).toEqual({ text: "Cut it to 0.4 s.", author: { type: "agent", id: "claude", name: "claude", model: "opus" } });
      const missing = await call(c, "note_reply", { noteId: "n9", text: "Done." });
      expect(missing.isError).toBe(true);
      expect(textOf(missing)).toBe("Scarlet server error 404 (not_found): note");
    } finally { await c.close(); }
  });

  it("resolves a note and leaves the others as they were", async () => {
    const c = await connect();
    try {
      expect(textOf(await ok(c, "note_resolve", { noteId: "n1" }))).toBe("Note n1 is resolved.");
      expect(sent("/projects/prj_test/notes/n1", "PATCH")[0]!.body).toEqual({ state: "resolved" });
      expect(textOf(await ok(c, "notes_list", { state: "open" }))).toBe("0 note(s):\n");
      expect((await call(c, "note_resolve", { noteId: "n9" })).isError).toBe(true);
    } finally { await c.close(); }
  });
});

describe("tool annotations", () => {
  // Every tool that saves an edit, a recommendation, a file or a message to the editor. A harness may retry or
  // run the others in parallel without asking, so a new tool is placed here or among the reads on purpose.
  const writes = ["timeline_propose", "timeline_first_cut", "timeline_crossfade_audio", "timeline_transition", "timeline_framing", "timeline_picture_sync", "captions_generate", "dialogue_apply_cuts", "dialogue_check_repeats", "dialogue_review_save",
    "dialogue_revise_cut", "edit_flag", "note_reply", "note_resolve", "render_request", "screen_area", "task_log", "task_question", "learning_suggest", "skill_save_from_change", "skill_save_edit", "asset_add", "export_otio",
    "graphic_render", "style_guide_save"];
  const every = EDITING_TOOL_GROUPS.flatMap(g => [...g.tools] as string[]);

  it("gives every tool an input schema a harness can convert: no array that lists an item per position", async () => {
    const c = await connect({ agent: "codex", capabilities: { images: true, audio: true, files: true }, author: { type: "agent", name: "codex" } });
    try {
      const { tools } = await c.listTools();
      expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(["timeline_framing", "media_frame"]));
      const positional: string[] = [];
      const walk = (node: unknown, path: string) => {
        if (!node || typeof node !== "object") return;
        for (const [key, value] of Object.entries(node)) {
          if ((key === "items" && Array.isArray(value)) || key === "prefixItems") positional.push(path);
          walk(value, `${path}.${key}`);
        }
      };
      for (const t of tools) walk(t.inputSchema, t.name);
      expect(positional).toEqual([]);
    } finally { await c.close(); }
  });

  it.each(["claude", "codex", "gemini"])("lists every parameter %s's model is shown with its own type: no $ref, no untyped branch", async agent => {
    // A run's session, which has the tools only a request has.
    const task = Task.parse({ id: "typed-task", state: "running", projectId: "prj_test", kind: "edit", agent, instruction: "/first-cut-dialogue",
      context: {}, createdBy: { type: "human", name: "Editor" } });
    const c = await connect({ agent, taskId: task.id, task, author: { type: "agent", id: agent, name: agent } });
    try {
      const { tools } = await c.listTools();
      expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(["dialogue_check_join", "dialogue_apply_cuts", "timeline_propose", "captions_generate"]));
      const untyped: string[] = [];
      const walk = (node: unknown, path: string) => {
        if (!node || typeof node !== "object") return;
        if ("$ref" in node) untyped.push(`${path} is a $ref`);
        for (const [key, value] of Object.entries(node)) {
          if (key === "anyOf" && Array.isArray(value)) value.forEach((branch, i) => { if (!branch?.type) untyped.push(`${path}.anyOf[${i}] has no type`); });
          walk(value, `${path}.${key}`);
        }
      };
      for (const t of tools) walk(t.inputSchema, t.name);
      expect(untyped).toEqual([]);
    } finally { await c.close(); }
  });

  it("marks exactly the tools that change something as writes, and nothing as destructive", () => {
    expect(every.filter(name => !toolAnnotations(name).readOnlyHint).sort()).toEqual([...writes].sort());
    for (const name of every.filter(n => n !== "web_capture")) {
      const a = toolAnnotations(name);
      // A read may be repeated; a write may not, and every edit stays reversible.
      expect(a).toMatchObject({ idempotentHint: a.readOnlyHint, destructiveHint: false, openWorldHint: false });
    }
    // A page from the web changes nothing in the project, and reads the open web, which may say something else next time.
    expect(toolAnnotations("web_capture")).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    // A name Scarlet doesn't know is never taken for a read.
    expect(toolAnnotations("timeline_delete_everything").readOnlyHint).toBe(false);
  });

  it("registers each tool with its annotation", async () => {
    const task = Task.parse({ id: "skill-task", state: "running", projectId: "prj_test", kind: "skill_edit", agent: "codex", instruction: "Shorter pauses",
      context: { skillId: "skl_1" }, hostId: "host_a", createdBy: { type: "human", name: "Editor" } });
    const check = Task.parse({ ...task, id: "check-task", kind: "learning_check", context: { checksTaskId: "asked-task" } });
    const edit = Task.parse({ ...task, id: "edit-task", kind: "edit", instruction: "Add B-roll", context: {} });
    const sessions = [await hearing(), await connect({ agent: "codex", taskId: task.id, task }), await connect({ agent: "codex", taskId: check.id, task: check }),
      await connect({ agent: "codex", taskId: edit.id, task: edit })];
    try {
      const tools = (await Promise.all(sessions.map(c => c.listTools()))).flatMap(l => l.tools);
      // The hearing session lists every editing tool; the skill request adds the tool that saves its revision, the
      // check that reads a request the one that offers a rule, and the edit request the one that captures a page.
      expect([...new Set(tools.map(t => t.name))].sort()).toEqual(every.filter(name => name !== "skill_save_from_change").sort());
      for (const t of tools) expect(t.annotations, t.name).toEqual(toolAnnotations(t.name));
    } finally { await Promise.all(sessions.map(c => c.close())); }
  });
});

describe("timeline_join_audit", () => {
  it("audits forty joins a call and says where the next page starts", async () => {
    // Forty-six one-second pieces of the camera, each from a second later in the source: 45 joins.
    const tl = emptyTimeline("prj_test");
    tl.version = "pieces";
    tl.tracks[1]!.clips = Array.from({ length: 46 }, (_, i) => makeMediaClip("m1", i * 2, i * 2 + 1, i));
    mock.state.timeline = tl;
    mock.state.waveform = (mediaId, from, to, points) => ({ mediaId, from, to, peaks: Array(points).fill(.001), rms: Array(points).fill(.001), speechActivity: [] });
    const c = await connect();
    try {
      const first = JSON.parse(textOf(await ok(c, "timeline_join_audit")));
      expect(first).toMatchObject({ version: "pieces", joins: 45, clean: 40, next: "Call again with from=40.002" });
      expect(first.audits.map((a: { join: number }) => a.join)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
      const rest = JSON.parse(textOf(await ok(c, "timeline_join_audit", { from: 40.002 })));
      // The next page starts after the last join audited, and its joins keep their numbers among all the edit's.
      expect(rest.audits.map((a: { join: number; at: number }) => [a.join, a.at])).toEqual([[41, 41], [42, 42], [43, 43], [44, 44], [45, 45]]);
      expect(rest).toMatchObject({ joins: 5, clean: 5 });
      expect(rest).not.toHaveProperty("next");
      // The playback transcript read from there gives each of those joins the same number, and counts the five it shows.
      const read = textOf(await ok(c, "timeline_transcript", { from: 40.002 }));
      expect(read).toContain("0 words, 5 joins.\n‖ join 41 at 41.00 ");
      expect(read.split("\n").at(-1)).toContain("‖ join 45 at 45.00 ");
      // Narrowed to times with no join, it says so instead of returning an empty audit.
      expect(textOf(await ok(c, "timeline_join_audit", { at: [10.5] }))).toBe("No joins on version pieces at those times.");
      const both = await call(c, "timeline_join_audit", { changeId: "chg_1", version: "pieces" });
      expect(textOf(both)).toContain("Give changeId or version, not both.");
    } finally { await c.close(); }
  });
});

describe("what goes to stderr when a read fails and the tool answers without it", () => {
  const cut = (tl: Timeline) => {
    tl.tracks[1]!.clips = [makeMediaClip("m1", 0, 1.9, 0), makeMediaClip("m1", 3.5, 6, 1.9)];
    return tl;
  };
  const failing = (match: (req: RecordedRequest) => boolean, message: string) => {
    mock.state.extra = (req, res) => match(req) ? reply(res, { error: { code: "engine_error", message } }, 500) : false;
  };

  it("notes once why a join audit has no levels, however many joins miss them", async () => {
    const tl = emptyTimeline("prj_test");
    tl.version = "pieces";
    tl.tracks[1]!.clips = Array.from({ length: 4 }, (_, i) => makeMediaClip("m1", i * 2, i * 2 + 1, i));
    mock.state.timeline = tl;
    failing(req => req.path.endsWith("/media/m1/waveform"), "The waveform cache is locked.");
    const c = await connect();
    try {
      const audit = JSON.parse(textOf(await ok(c, "timeline_join_audit")));
      // The result is unchanged: each join says it has no reading.
      expect(audit.audits.map((a: { verdict: string }) => a.verdict)).toEqual(Array(3).fill("check: no level reading for this join (waveform unavailable)"));
      expect(logged()).toEqual(["[scarlet-mcp] failed to read the levels of m1 for a join audit: Scarlet server error 500 (engine_error): The waveform cache is locked."]);
    } finally { await c.close(); }
  });

  it("notes a transcript that could not be read, and not one that is only missing or still being aligned", async () => {
    mock.state.timeline = cut(emptyTimeline("prj_test"));
    mock.state.waveform = (mediaId, from, to, points) => ({ mediaId, from, to, peaks: Array(points).fill(.001), rms: Array(points).fill(.001), speechActivity: [] });
    const c = await connect();
    try {
      // m1's words are still being placed on the audio: the audit speaks from the levels and nothing is wrong.
      mock.state.transcripts = { m1: { ...transcript, aligning: { through: 1 } } };
      expect(JSON.parse(textOf(await ok(c, "timeline_join_audit"))).audits).toHaveLength(1);
      expect(logged()).toEqual([]);
    } finally { await c.close(); }
    const untranscribed = await connect();
    try {
      // A recording nobody has transcribed has no words to read, which is not a failure either.
      mock.state.transcripts = {};
      expect(JSON.parse(textOf(await ok(untranscribed, "timeline_join_audit"))).audits).toHaveLength(1);
      expect(logged()).toEqual([]);
    } finally { await untranscribed.close(); }
    const broken = await connect();
    try {
      failing(req => req.path.endsWith("/media/m1/transcript"), "The transcript file is unreadable.");
      expect(JSON.parse(textOf(await ok(broken, "timeline_join_audit"))).audits).toHaveLength(1);
      expect(logged()).toEqual(["[scarlet-mcp] failed to read the words of m1 for a join audit: Scarlet server error 500 (engine_error): The transcript file is unreadable."]);
    } finally { await broken.close(); }
  });

  it("lists the words the scan read in what a saved part still plays that the transcript has no word for", async () => {
    const tl = emptyTimeline("prj_test");
    tl.version = "tidied";
    tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 12, 0)];
    mock.state.timeline = tl;
    // Said “And it just feel, uh. It just feels like this. [wait] Next.”; the transcript has “And it just feels like this. Next.”.
    const stored = [["And", .5, .75], ["it", 1.1, 1.5], ["just", 5.3, 5.6], ["feels", 5.6, 5.9], ["like", 5.9, 6.1], ["this.", 6.1, 6.4], ["Next.", 9.4, 9.8]]
      .map(([text, start, end]) => ({ text: text as string, start: start as number, end: end as number }));
    const read = [["And", .5, .7], ["it", .7, .8], ["just", .95, 1.3], ["feel,", 1.4, 1.75], ["uh.", 1.75, 2.3], ["It", 5.2, 5.3], ["just", 5.3, 5.6], ["feels", 5.6, 5.9],
      ["like", 5.9, 6.1], ["this.", 6.1, 6.4], ["Next.", 9.4, 9.8]].map(([text, start, end]) => ({ text: text as string, start: start as number, end: end as number }));
    mock.state.transcripts = { m1: { ...transcript, segments: [{ ...transcript.segments[0]!, words: stored, text: stored.map(w => w.text).join(" "), end: 9.8 }] } };
    const applied = { ...tl, version: "applied", tracks: tl.tracks.map((t, i) => i ? t : { ...t, clips: [makeMediaClip("m1", 0, 7, 0), makeMediaClip("m1", 9, 12, 7)] }) };
    mock.state.extra = (req, res) => req.path.endsWith("/dialogue-cuts") ? reply(res, { changes: [{ id: "chg_1", intent: "requested", state: "approved", fromVersion: "tidied", toVersion: "applied", description: "Tightened" }], head: "applied" })
      : req.path === "/projects/prj_test/timeline" && req.query.get("version") === "applied" ? reply(res, { timeline: applied })
      : req.path.endsWith("/dialogue-verbatim") ? reply(res, { words: read }) : false;
    const c = await connect();
    try {
      const result = await ok(c, "dialogue_apply_cuts", { version: "tidied", description: "Tightened", range: { start: 0, end: 12 },
        cuts: [{ start: 7, end: 9, kind: "pause", decision: "cut", reason: "A long wait.", summary: "Shortened the wait before “Next”" }] });
      const saved = JSON.parse((result.content[0] as { text: string }).text);
      // The false start has no index in the transcript: it is named with where it plays, so a cut of it can be given in seconds.
      expect(saved.heardNotInTranscript).toEqual([{ at: 0.95, seconds: 4.35, text: "just feel, uh. It", context: "And it just feel, uh. It just feels like this.",
        mediaId: "m1", sourceSeconds: [0.95, 5.3] }]);
    } finally { await c.close(); }
  });

  it("notes that a saved part's kept silences could not be placed, and saves the part all the same", async () => {
    const tl = emptyTimeline("prj_test");
    tl.version = "typing";
    tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 10, 0)];
    mock.state.timeline = tl;
    // Four seconds without a word after “back.”.
    const words = [...transcript.segments[0]!.words, { text: "Next.", start: 5.8, end: 6.2 }, { text: "Then", start: 8, end: 8.3 }];
    mock.state.transcripts = { m1: { ...transcript, segments: [{ ...transcript.segments[0]!, words, end: 8.3 }] } };
    mock.state.extra = (req, res) => req.path.endsWith("/dialogue-cuts") ? reply(res, { changes: [], head: "applied" })
      : req.path === "/projects/prj_test/timeline" && req.query.get("version") === "applied" ? reply(res, { error: { code: "engine_error", message: "The database is busy." } }, 500) : false;
    const c = await connect();
    try {
      const result = await ok(c, "dialogue_apply_cuts", { version: "typing", description: "Tightened", range: { start: 0, end: 10 },
        cuts: [{ start: 6.6, end: 7.6, kind: "pause", decision: "cut", reason: "A long wait." }] });
      const saved = JSON.parse((result.content[0] as { text: string }).text);
      expect(saved).toMatchObject({ continueFrom: "applied" });
      expect(saved).not.toHaveProperty("keptSilences");
      expect(logged()).toEqual(["[scarlet-mcp] failed to place the kept silences on applied: Scarlet server error 500 (engine_error): The database is busy."]);
      // The result says what it was answered without, so its silence about kept silences isn't read as none.
      expect(result.content.at(-1)).toEqual({ type: "text",
        text: "Not measured: failed to place the kept silences on applied (Scarlet server error 500 (engine_error): The database is busy.)." });
    } finally { await c.close(); }
  });

  it("says in the result of each call, and only that call, which edges it saved without measuring", async () => {
    const tl = emptyTimeline("prj_test");
    tl.version = "unmeasured";
    tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 6, 0)];
    mock.state.timeline = tl;
    // The levels fail a moment after they are asked for, and the project is read slowly: a read made meanwhile by
    // another call must not carry this call's line.
    mock.state.extra = (req, res) => {
      if (req.path.endsWith("/media/m1/waveform")) {
        setTimeout(() => reply(res, { error: { code: "engine_error", message: "The waveform cache is locked." } }, 500), 50);
        return true;
      }
      return false;
    };
    const c = await connect();
    try {
      const [proposed, read] = await Promise.all([
        ok(c, "timeline_propose", { intent: "requested", fromVersion: "unmeasured", ops: [{ op: "rippleDelete", start: 2, end: 2.5 }],
          description: "Tighten the pause.", reason: "The half-second gap interrupts the delivery." }),
        (async () => { await new Promise(r => setTimeout(r, 20)); return await ok(c, "notes_list", {}); })(),
      ]);
      expect(proposed.content.at(-1)).toEqual({ type: "text",
        text: "Not measured: failed to measure the edges of ripple 0 (Scarlet server error 500 (engine_error): The waveform cache is locked.); "
          + "failed to measure the edit's new clip edges (Scarlet server error 500 (engine_error): The waveform cache is locked.)." });
      expect(textOf(read)).not.toContain("Not measured");
      // The stderr line stays.
      expect(logged()).toContain("[scarlet-mcp] failed to measure the edit's new clip edges: Scarlet server error 500 (engine_error): The waveform cache is locked.");
      // A call that measured everything ends with its own answer.
      mock.state.extra = undefined;
      const clean = await ok(c, "timeline_propose", { intent: "requested", fromVersion: "unmeasured", ops: [{ op: "rippleDelete", start: 2, end: 2.5 }],
        description: "Tighten the pause.", reason: "The half-second gap interrupts the delivery." });
      expect(textOf(clean)).not.toContain("Not measured");
    } finally { await c.close(); }
  });

  it("notes once that the background scan and the picture measurement are unavailable, across the pages of a pass", async () => {
    mock.state.project.media = [{ id: "m1", kind: "video", name: "talk.mp4", path: "talk.mp4", duration: 120, fps: 30, width: 1920, height: 1080, hasAudio: true, transcriptId: "t1" }];
    const tl = emptyTimeline("prj_test");
    tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 120, 0)];
    mock.state.timeline = tl;
    mock.state.waveform = (mediaId, from, to, points) => ({ mediaId, from, to, peaks: Array(points).fill(.001), rms: Array(points).fill(.001) });
    // An engine from before background scans and picture measurements: it has neither route. Each page has one word, so the rest is silence.
    mock.state.extra = (req, res) => !req.path.endsWith("/dialogue-detections") ? false : reply(res, { acoustic: [], speechActivity: [],
      segments: [{ id: "s", text: "Hello", start: (req.body as { from: number }).from + 1, end: (req.body as { from: number }).from + 1.4,
        words: [{ text: "Hello", start: (req.body as { from: number }).from + 1, end: (req.body as { from: number }).from + 1.4 }] }] });
    const c = await connect({ taskId: "task_scan", taskStartedAt: "2026-04-01T12:00:00.000Z" });
    try {
      const first = JSON.parse(textOf(await ok(c, "dialogue_scan", { mediaId: "m1", from: 0 })));
      expect(first.silences.length).toBeGreaterThan(0);
      // Without the measurement a silence simply has no picture reading.
      for (const s of first.silences) expect(s).not.toHaveProperty("picture");
      await ok(c, "dialogue_scan", { mediaId: "m1", from: first.nextFrom });
      const missing = (route: string) => `Scarlet server error 404 (not_found): no mock route for POST /projects/prj_test/${route}`;
      expect(logged().filter(line => !line.includes("task event"))).toEqual([
        `[scarlet-mcp] failed to start the background dialogue scan of m1: ${missing("dialogue-scan")}`,
        `[scarlet-mcp] failed to read the saved dialogue pages of m1: ${missing("dialogue-checkpoints")}`,
        `[scarlet-mcp] failed to measure the pictures through silences: ${missing("picture-activity")}`,
      ]);
      // Nothing the editor typed, no request body and no token is in a line.
      expect(logged().join("\n")).not.toMatch(/tok\b|Bearer|"from"/);
    } finally { await c.close(); }
  });

  it("notes an edit that could not be read for the pictures, and not a project that has no edit yet", async () => {
    mock.state.waveform = (mediaId, from, to, points) => ({ mediaId, from, to, peaks: Array(points).fill(.001), rms: Array(points).fill(.001) });
    const scan = async (c: Client) => JSON.parse(textOf(await ok(c, "dialogue_scan", { mediaId: "m1", from: 0, until: 30 })));
    const about = (what: string) => logged().filter(line => line.includes(what));
    // Nothing is assembled yet, so no picture plays through any silence.
    const before = await connect();
    try {
      expect((await scan(before)).silences.length).toBeGreaterThan(0);
      expect(about("the edit")).toEqual([]);
    } finally { await before.close(); }
    failing(req => req.path === "/projects/prj_test/timeline", "The database is busy.");
    const busy = await connect();
    try {
      await scan(busy);
      expect(about("the edit")).toEqual(["[scarlet-mcp] failed to read the edit for the pictures through silences: Scarlet server error 500 (engine_error): The database is busy."]);
    } finally { await busy.close(); }
  });

  it("notes words a cut's inspection could not read, and not a recording that has no transcript", async () => {
    const before = emptyTimeline("prj_test");
    before.version = "pf";
    before.tracks[1]!.clips = [makeMediaClip("m1", 0, 6, 0)];
    const after = cut(emptyTimeline("prj_test"));
    after.version = "pt";
    mock.state.timeline = after;
    mock.state.waveform = (mediaId, from, to, points) => ({ mediaId, from, to, peaks: Array(points).fill(.001), rms: Array(points).fill(.001), speechActivity: [] });
    let transcriptStatus = 404;
    mock.state.extra = (req, res) => req.path === "/projects/prj_test/changes/pass" ? reply(res, { change: { id: "pass", projectId: "prj_test", intent: "suggestion",
        state: "ready", fromVersion: "pf", toVersion: "pt", description: "Review 1 optional dialogue cut", cutReasons: [], ops: [] } })
      : req.path.endsWith("/cut-review") ? reply(res, { review: { original: before, proposed: after, firstCut: false, cuts: [{ at: 1.9, removed: { start: 1.9, end: 3.5 }, beforeClip: 1 }] } })
      : req.path.endsWith("/media/m1/transcript") ? reply(res, { error: { code: transcriptStatus === 404 ? "not_found" : "engine_error", message: "The transcript could not be read." } }, transcriptStatus)
      : false;
    const words = "failed to read the words of m1 for a cut inspection";
    const inspect = async () => {
      const c = await connect();
      try {
        // Either way the inspection comes back, with no words for the passage.
        expect(textOf(await ok(c, "dialogue_review_inspect", { changeId: "pass", index: 0 }))).toContain('{"words":null}');
      } finally { await c.close(); }
      return logged().filter(line => line.includes(words));
    };
    const withoutImages = await connect({ capabilities: { images: false, audio: false, files: false, plan: false } });
    try {
      before.tracks[0]!.clips = [makeMediaClip("m1", 0, 6, 0)];
      const result = await ok(withoutImages, "dialogue_review_inspect", { changeId: "pass", index: 0 });
      expect(textOf(result)).toContain("the picture of this cut is unchecked");
      expect(textOf(result)).toContain('"complete":false');
      expect(result.content.every(part => part.type === "text")).toBe(true);
      expect(mock.requests.some(req => req.path.endsWith("/contact-sheet"))).toBe(false);
      before.tracks[0]!.clips = [];
    } finally { await withoutImages.close(); }
    expect(await inspect()).toEqual([]);
    transcriptStatus = 500;
    expect(await inspect()).toEqual([`[scarlet-mcp] ${words}: Scarlet server error 500 (engine_error): The transcript could not be read.`]);
  });

  it("notes a review that could not be prepared ahead, which the agent's own inspection then prepares", async () => {
    const tl = emptyTimeline("prj_test");
    tl.version = "pf";
    tl.tracks[1]!.clips = [makeMediaClip("m1", 0, 6, 0)];
    mock.state.timeline = tl;
    mock.state.extra = (req, res) => req.path.endsWith("/dialogue-cuts")
      ? reply(res, { changes: [{ id: "staged", state: "ready", intent: "suggestion", fromVersion: "pf", toVersion: "pt", description: "Review 1 optional dialogue cut" }] })
      : req.path === "/projects/prj_test/changes/staged" ? reply(res, { error: { code: "engine_error", message: "The database is busy." } }, 500) : false;
    const c = await connect();
    try {
      const saved = JSON.parse(textOf(await ok(c, "dialogue_apply_cuts", { version: "pf", description: "Review the takes",
        cuts: [{ start: 2, end: 2.4, kind: "retake", decision: "review", reason: "Two takes." }] })));
      // The part is saved and the agent is pointed at its review all the same.
      expect(saved).toMatchObject({ continueFrom: "pf", changes: [{ id: "staged" }] });
      const line = "[scarlet-mcp] failed to prepare the review of staged ahead: Scarlet server error 500 (engine_error): The database is busy.";
      await vi.waitFor(() => expect(logged()).toContain(line), { timeout: 5000 });
    } finally { await c.close(); }
  });
});

describe("dialogue_apply_cuts's receipt of what a saved part still plays", () => {
  it("reads it while the engine saves and its lists at once, and says the same as reading one after another", async () => {
    const tl = emptyTimeline("prj_test");
    tl.version = "tidied";
    tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 12, 0)];
    // A mic nobody transcribed: its words are asked for on every read.
    tl.tracks[1]!.clips = [makeMediaClip("m2", 10, 12, 10)];
    mock.state.timeline = tl;
    const applied = { ...tl, version: "applied", tracks: [{ ...tl.tracks[0]!, clips: [makeMediaClip("m1", 0, 7, 0), makeMediaClip("m1", 9, 12, 7)] },
      { ...tl.tracks[1]!, clips: [makeMediaClip("m2", 10, 12, 8)] }] };
    const stored = [["And", .5, .75], ["it", 1.1, 1.5], ["just", 5.3, 5.6], ["feels", 5.6, 5.9], ["like", 5.9, 6.1], ["this.", 6.1, 6.4],
      ["so", 9.4, 9.6], ["so", 9.7, 9.9], ["quiet", 10.3, 10.6], ["words", 10.6, 10.9], ["done.", 11.4, 11.8]]
      .map(([text, start, end]) => ({ text: text as string, start: start as number, end: end as number }));
    mock.state.transcripts = { m1: { ...transcript, segments: [{ ...transcript.segments[0]!, words: stored, text: stored.map(w => w.text).join(" "), end: 11.8 }] } };
    // Speech at -20 dBFS, “quiet words” at -48, room tone between, and a false start the transcript left out at 1.75–2.3.
    const sound = [...stored, { start: 1.75, end: 2.3 }];
    mock.state.waveform = (mediaId, from, to, points) => {
      const rms = Array.from({ length: points }, (_, i) => {
        const t = from + (i + .5) * (to - from) / points;
        if (mediaId !== "m1" || !sound.some(w => w.start <= t && t < w.end)) return .001;
        return t >= 10.3 && t < 10.9 ? .004 : .1;
      });
      return { mediaId, from, to, peaks: rms, rms, speechActivity: mediaId === "m1" ? stored.map(w => ({ start: w.start, end: w.end })) : [] };
    };
    const read = [["And", .5, .7], ["it", .7, .8], ["just", .95, 1.3], ["feel,", 1.4, 1.75], ["uh.", 1.75, 2.3], ["It", 5.2, 5.3], ["just", 5.3, 5.6],
      ["feels", 5.6, 5.9], ["like", 5.9, 6.1], ["this.", 6.1, 6.4]].map(([text, start, end]) => ({ text: text as string, start: start as number, end: end as number }));
    // When each request reached the engine and when it was answered. The save, the media list and the scan's words are slow.
    const seen: Array<{ path: string; version: string | null; kind?: unknown; start: number; end: number }> = [];
    let saved = false;
    mock.state.extra = (req, res) => {
      const span = { path: req.path, version: req.query.get("version"), kind: (req.body as { data?: { kind?: unknown } } | undefined)?.data?.kind,
        start: performance.now(), end: performance.now() };
      seen.push(span);
      const later = (ms: number, body: unknown) => {
        setTimeout(() => { span.end = performance.now(); reply(res, body); }, ms);
        return true;
      };
      if (req.path.endsWith("/dialogue-cuts")) {
        saved = true;
        return later(100, { changes: [{ id: "chg_1", intent: "requested", state: "approved", fromVersion: "tidied", toVersion: "applied", description: "Tightened" }], head: "applied" });
      }
      if (req.path === "/projects/prj_test/timeline" && req.query.get("version") === "applied") return reply(res, { timeline: applied });
      if (req.path.endsWith("/dialogue-verbatim")) return later(60, { words: read, covered: [{ start: 0, end: 12 }] });
      if (req.path === "/projects/prj_test/media" && saved) return later(200, { media: mock.state.project.media });
      if (req.path.endsWith("/repeat-audit")) return reply(res, { version: "applied", heard: 9, remaining: 0, repeats: [], staged: 0 });
      return false;
    };
    const task = Task.parse({ id: "tsk_receipt", projectId: "prj_test", kind: "edit", state: "running", agent: "claude", instruction: "Tighten the dialogue",
      context: {}, createdBy: { type: "human", name: "Editor" }, repeatAudit: { version: "tidied" } });
    const c = await connect({ taskId: task.id, task });
    try {
      const result = await ok(c, "dialogue_apply_cuts", { version: "tidied", description: "Tightened", range: { start: 0, end: 12 },
        cuts: [{ start: 7, end: 9, kind: "pause", decision: "cut", reason: "A long wait.", summary: "Shortened the wait before “so”" }] });
      // Byte for byte the receipt these reads gave one after another, every list in it, and nothing it went without.
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify({
        changes: [{ id: "chg_1", intent: "requested", state: "approved", fromVersion: "tidied", toVersion: "applied", description: "Tightened" }], continueFrom: "applied",
        audioRecheck: { version: "applied", heard: 9, remaining: 0, repeats: [], staged: 0, sync: { pairs: [{ reference: "m1", secondary: "m2", offset: 0, togetherSeconds: 2,
          outOfLine: [], heard: [], unheard: 0 }], summary: "talk.mp4 and mic.wav: placed in line throughout; not compared by sound, as one has none." } },
        gate: { unchangedCuts: 1, decisions: [] },
        keptSilences: [{ at: 1.5, seconds: 3.8, after: "it", before: "just" }],
        keptPauses: [{ at: 0.75, mediaId: "m1", seconds: 0.35, after: "And", before: "it", afterWord: 0 }, { at: 6.4, mediaId: "m1", seconds: 1, after: "this.", before: "so" },
          { at: 7.9, mediaId: "m1", seconds: 0.4, after: "so", before: "quiet", afterWord: 7 }, { at: 8.9, mediaId: "m1", seconds: 0.5, after: "words", before: "done.", afterWord: 9 }],
        repeatedWords: [{ at: 7.4, mediaId: "m1", text: "so so", fromWord: 6, toWord: 6, pause: 0.1 }],
        unexplainedSound: [{ at: 1.75, mediaId: "m1", seconds: 0.55, after: "it", before: "just", sourceSeconds: [1.75, 2.3] }],
        heardNotInTranscript: [{ at: 0.95, seconds: 4.35, text: "just feel, uh. It", context: "And it just feel, uh. It just feels like this.", mediaId: "m1", sourceSeconds: [0.95, 5.3] }],
        keptQuietPhrases: [{ at: 8.3, mediaId: "m1", fromWord: 8, toWord: 9, start: 10.3, end: 10.9, text: "quiet words", levelDbfs: -48, beforeDbfs: -20, afterDbfs: -20 }],
      }) }]);
      expect(mock.state.events.map(e => e.data?.kind ?? e.type)).toEqual(["editor_progress", "pass_progress", "change"]);
      const at = (path: string) => seen.filter(s => s.path.endsWith(path));
      const save = at("/dialogue-cuts")[0]!, progress = at("/events").find(s => s.kind === "editor_progress")!;
      // The mic's words are asked for once for both lists, after the editor is told the save is under way and while it runs.
      expect(at("/media/m2/transcript").filter(s => s.start < save.end).map(s => s.start > progress.start)).toEqual([true]);
      // The quiet phrases' media list, the scan's words and the repeat check overlap.
      const media = at("/projects/prj_test/media").at(-1)!, scanWords = at("/dialogue-verbatim")[0]!, audit = at("/repeat-audit")[0]!;
      expect(scanWords.start).toBeLessThan(media.end);
      expect(audit.start).toBeLessThan(media.end);
      // The repeat check starts once the scan's words are read: in a language it reads from the scan, it can save pages they'd read.
      expect(audit.start).toBeGreaterThanOrEqual(scanWords.end);
      // The lists share one read of the version the pass continues on; the sync check reads it as it always has.
      expect(seen.filter(s => s.path === "/projects/prj_test/timeline" && s.version === "applied")).toHaveLength(2);
    } finally { await c.close(); }
  });

  it("names what the lists went without in the order they are read, whichever fails first", async () => {
    const tl = emptyTimeline("prj_test");
    tl.version = "typing";
    tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 10, 0)];
    mock.state.timeline = tl;
    const words = [...transcript.segments[0]!.words, { text: "Next.", start: 5.8, end: 6.2 }, { text: "Then", start: 8, end: 8.3 }];
    mock.state.transcripts = { m1: { ...transcript, segments: [{ ...transcript.segments[0]!, words, end: 8.3 }] } };
    let saved = false;
    const busy = { error: { code: "engine_error", message: "The database is busy." } };
    // The quiet phrases' media list fails last, the kept silences' read of the new version first.
    mock.state.extra = (req, res) => {
      if (req.path.endsWith("/dialogue-cuts")) { saved = true; return reply(res, { changes: [], head: "applied" }); }
      if (req.path === "/projects/prj_test/timeline" && req.query.get("version") === "applied") return reply(res, busy, 500);
      if (req.path === "/projects/prj_test/media" && saved) { setTimeout(() => reply(res, busy, 500), 50); return true; }
      return false;
    };
    const c = await connect();
    try {
      const result = await ok(c, "dialogue_apply_cuts", { version: "typing", description: "Tightened", range: { start: 0, end: 10 },
        cuts: [{ start: 6.6, end: 7.6, kind: "pause", decision: "cut", reason: "A long wait.", summary: "Shortened the wait before “Then”" }] });
      expect(result.content.at(-1)).toEqual({ type: "text", text: "Not measured: " +
        "failed to place the quiet phrases the part still plays (Scarlet server error 500 (engine_error): The database is busy.); " +
        "failed to place the kept silences on applied (Scarlet server error 500 (engine_error): The database is busy.)." });
    } finally { await c.close(); }
  });
});

describe("transcriptionNote", () => {
  it("says where a transcription stands, from what the engine counted", () => {
    expect(transcriptionNote(undefined)).toBe("still being made");
    expect(transcriptionNote({ stage: "queued", fraction: 0 })).toBe("waiting its turn behind other audio work");
    expect(transcriptionNote({ stage: "transcribing", fraction: .339, remainingSeconds: 37 * 60 })).toBe("transcribing, 33% done, about 37 min left");
    expect(transcriptionNote({ stage: "aligning", fraction: .5, remainingSeconds: 228 * 60 })).toBe("aligning words, 50% done, about 3 h 48 min left");
    // Under a minute still reads as a minute, and a finished stage has nothing left.
    expect(transcriptionNote({ stage: "aligning", fraction: .99, remainingSeconds: 4 })).toBe("aligning words, 99% done, about 1 min left");
    expect(transcriptionNote({ stage: "aligning", fraction: 1, remainingSeconds: 0 })).toBe("aligning words, 100% done");
    expect(transcriptionNote({ stage: "transcribing", fraction: .4 })).toBe("transcribing, 40% done");
  });

  it("reports the words alone while they are transcribed, since a pass can read once it has them", () => {
    const progress = { fraction: .2, remainingSeconds: 3600, words: { fraction: .8, remainingSeconds: 120 } };
    expect(transcriptionNote({ stage: "transcribing", ...progress })).toBe("transcribing, 80% done, about 2 min left");
    // Once the words are in and being aligned, the figure is the whole job's again.
    expect(transcriptionNote({ stage: "aligning", ...progress })).toBe("aligning words, 20% done, about 60 min left");
  });
});

describe("validateOps", () => {
  it("returns the parsed ops, with the schema's defaults filled in", () => {
    const checked = validateOps([{ op: "rippleDelete", start: 1, end: 2 }, { op: "addMarker", marker: { id: "mk1", time: 3, text: "b-roll" } }]);
    expect(checked).toMatchObject({ ok: true, ops: [{ op: "rippleDelete", start: 1, end: 2 }, { op: "addMarker", marker: { id: "mk1", time: 3, text: "b-roll" } }] });
    expect(validateOps([])).toEqual({ ok: true, ops: [] });
  });

  it("names the op and the field that is wrong, and shows the op types", () => {
    const checked = validateOps([{ op: "rippleDelete", start: 1, end: 2 }, { op: "splitClip", clipId: "c1" }, { op: "moveClip", clipId: "c1", timelineIn: "soon" }, { clipId: "c1" }]);
    if (checked.ok) throw new Error("expected invalid ops");
    const lines = checked.error.split("\n");
    expect(lines[0]).toBe("Invalid ops:");
    expect(lines).toContainEqual(expect.stringMatching(/^- ops\[1\] \(splitClip\)\.at: /));
    expect(lines).toContainEqual(expect.stringMatching(/^- ops\[2\] \(moveClip\)\.timelineIn: /));
    // An op with no type has nothing to name.
    expect(lines).toContainEqual(expect.stringMatching(/^- ops\[3\]/));
    expect(lines.some(line => line.startsWith("- ops[0]"))).toBe(false);
    expect(checked.error).toContain("- rippleDelete: {\"op\":\"rippleDelete\"");
  });

  it("rejects anything that is not a list, and reports at most twenty problems", () => {
    for (const notAList of [{ op: "removeClip", clipId: "c1" }, "rippleDelete", null, undefined]) {
      expect(validateOps(notAList)).toEqual({ ok: false, error: "ops must be an array of op objects" });
    }
    const many = validateOps(Array.from({ length: 30 }, () => ({ op: "splitClip", clipId: "c1" })));
    if (many.ok) throw new Error("expected invalid ops");
    expect(many.error.split("\n\n")[0]!.split("\n").filter(line => line.startsWith("- ops["))).toHaveLength(20);
  });
});

describe("describeError and formatZodError", () => {
  it("lists each issue by its path, the root by name, and stops at twenty", () => {
    const schema = z.object({ cuts: z.array(z.object({ start: z.number() })), description: z.string() });
    const failed = schema.safeParse({ cuts: [{ start: 1 }, { start: "two" }] });
    if (failed.success) throw new Error("expected a validation error");
    expect(formatZodError(failed.error).split("\n")).toEqual([expect.stringMatching(/^- cuts\.1\.start: /), expect.stringMatching(/^- description: /)]);
    expect(describeError(failed.error)).toBe(`Validation failed:\n${formatZodError(failed.error)}`);
    const root = z.string().safeParse(4);
    if (root.success) throw new Error("expected a validation error");
    expect(formatZodError(root.error)).toMatch(/^- \(root\): /);
    const long = z.array(z.number()).safeParse(Array(25).fill("x"));
    if (long.success) throw new Error("expected a validation error");
    expect(formatZodError(long.error).split("\n")).toHaveLength(20);
  });

  it("says which op was invalid and why a request never arrived", () => {
    const op = { op: "removeClip" as const, clipId: "gone" };
    expect(describeError(new OpError("clip gone not found", op))).toBe('Invalid op {"op":"removeClip","clipId":"gone"}: clip gone not found');
    // Node reports every network failure as "fetch failed"; the cause says which.
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4000"), { code: "ECONNREFUSED" });
    expect(describeError(new TypeError("fetch failed", { cause: refused }))).toBe("TypeError: fetch failed (ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:4000)");
    expect(describeError(new Error("outer", { cause: new Error("inner") }))).toBe("Error: outer (inner)");
    expect(describeError(new Error("alone", { cause: "a string" }))).toBe("Error: alone");
    expect(describeError("plain text")).toBe("plain text");
    // Details that are not a list of issues add nothing to an engine error.
    expect(describeError(new ScarletApiError(400, "validation_error", "request validation failed", { reason: "unknown" })))
      .toBe("Scarlet server error 400 (validation_error): request validation failed");
  });
});

describe("screen_text", () => {
  it("lists the text on screen in source seconds with its place in the frame, says how much is read, and pages", async () => {
    const c = await connect();
    const spans = Array.from({ length: 203 }, (_, i) => ({ start: i, end: i + 1, text: `Line ${i}`, box: [0.1, 0.05, 0.456, 0.08], confidence: 0.9 }));
    mock.state.extra = (req, res) => req.path.endsWith("/media/m1/screen-text")
      ? reply(res, { mediaId: "m1", from: 0, to: 120, spans, readSeconds: 60, done: false }) : false;
    const first = textOf(await ok(c, "screen_text", { mediaId: "m1", query: "Line" }));
    expect(first.split("\n").slice(0, 2)).toEqual([
      "m1 0.0-120.0 s, lines with “Line”: 203 lines; 60 of 120 s read so far, still reading: call again for the rest.",
      "0.0-1.0 [10-46% x, 5-8% y] Line 0"]);
    expect(first.split("\n").at(-1)).toBe("offset 200 for the next 3.");
    expect(sent("/projects/prj_test/media/m1/screen-text", "GET").at(-1)?.query.get("q")).toBe("Line");
    expect(textOf(await ok(c, "screen_text", { mediaId: "m1", offset: 200 })).split("\n").slice(1)).toEqual([
      "200.0-201.0 [10-46% x, 5-8% y] Line 200", "201.0-202.0 [10-46% x, 5-8% y] Line 201", "202.0-203.0 [10-46% x, 5-8% y] Line 202"]);
    // A recording without a picture is named, before the engine is asked.
    expect(textOf(await call(c, "screen_text", { mediaId: "m2" }))).toContain("only a video has a picture to read");
    expect(toolAnnotations("screen_text").readOnlyHint).toBe(true);
  });

  it("points a model that can see pictures to the frame a line is on, and doesn't mention pictures to one that can't", async () => {
    const description = async (c: Client) => (await c.listTools()).tools.find(t => t.name === "screen_text")!.description;
    expect(await description(await connect())).toContain("media_frame at a line's start second shows that frame");
    const blind = await connect({ capabilities: { images: false, audio: false, files: false } });
    expect(await description(blind)).not.toContain("media_frame");
  });
});

describe("faces", () => {
  const span = (track: number, start: number) => ({ track, start, end: start + 1, box: [0.4, 0.3, 0.58, 0.72], eyes: [0.49, 0.44], yaw: 0, confidence: 0.94 });
  it("lists where the faces are as compact JSON in source seconds and fractions, says how much is read, and pages", async () => {
    const c = await connect();
    const spans = [...Array.from({ length: 203 }, (_, i) => span(1, i)), span(2, 10), span(2, 50)].sort((a, b) => a.start - b.start || a.track - b.track);
    const tracks = [{ track: 1, start: 0, end: 203, seconds: 203, box: [0.4, 0.3, 0.58, 0.72], confidence: 0.94 },
      { track: 2, start: 10, end: 51, seconds: 2, box: [0.78, 0.81, 0.8, 0.86], confidence: 0.62 }];
    mock.state.extra = (req, res) => req.path.endsWith("/media/m1/faces")
      ? reply(res, { mediaId: "m1", from: 0, to: 240, width: 3840, height: 2160, tracks, spans, readSeconds: 180, done: false }) : false;
    const first = JSON.parse(textOf(await ok(c, "faces", { mediaId: "m1", from: 0, to: 240 })));
    expect(first).toMatchObject({ mediaId: "m1", from: 0, to: 240, frame: [3840, 2160], tracks, spanCount: 205,
      reading: "180 of 240 s read so far, still reading: call again for the rest", next: "offset 200 for the next 5" });
    expect(first.spans).toHaveLength(200);
    expect(first.spans[0]).toEqual(span(1, 0));
    expect(sent("/projects/prj_test/media/m1/faces", "GET").at(-1)?.query.get("to")).toBe("240");
    const rest = JSON.parse(textOf(await ok(c, "faces", { mediaId: "m1", offset: 200 })));
    expect(rest.spans).toHaveLength(5);
    expect(rest.next).toBeUndefined();
    // One track's spans, with every track still listed.
    const second = JSON.parse(textOf(await ok(c, "faces", { mediaId: "m1", track: 2 })));
    expect(second).toMatchObject({ spanCount: 2, spans: [span(2, 10), span(2, 50)], tracks });
    expect(toolAnnotations("faces").readOnlyHint).toBe(true);
  });

  it("says what to do when there is nothing to look in or no such track", async () => {
    const c = await connect();
    mock.state.extra = (req, res) => req.path.endsWith("/media/m1/faces")
      ? reply(res, { mediaId: "m1", from: 0, to: 60, tracks: [{ track: 1, start: 0, end: 60, seconds: 60, box: [0.4, 0.3, 0.6, 0.7], confidence: 0.9 }],
        spans: [span(1, 0)], readSeconds: 60, done: true }) : false;
    expect(textOf(await call(c, "faces", { mediaId: "m1", track: 3 }))).toContain("No track 3 in 0.0-60.0 s; this range has tracks 1.");
    expect(textOf(await call(c, "faces", { mediaId: "m2" }))).toContain("only a video has faces to find");
    expect(textOf(await call(c, "faces", { mediaId: "nope" }))).toContain("Use project_get for media ids");
  });
});

describe("lip_sync and timeline_picture_sync", () => {
  it("passes the stretches asked for to the engine and returns its measurements as they are", async () => {
    const c = await connect();
    const measured = { mediaId: "m1", frameSeconds: 0.033, done: true, together: { soundLeads: 0.68, match: 0.26, matchInSync: 0.06, frames: 1800, stretches: 2 },
      stretches: [{ from: 10, to: 40, face: { mouth: [0.45, 0.4, 0.55, 0.5], yaw: 0, seconds: 30 }, reading: { soundLeads: 0.7, match: 0.3, matchInSync: 0.05, frames: 900 } }] };
    mock.state.extra = (req, res) => req.path.endsWith("/media/m1/lip-sync") ? reply(res, measured) : false;
    expect(JSON.parse(textOf(await ok(c, "lip_sync", { mediaId: "m1", from: 10, to: 70, count: 2 })))).toEqual(measured);
    const asked = sent("/projects/prj_test/media/m1/lip-sync", "GET").at(-1)!.query;
    expect([asked.get("from"), asked.get("to"), asked.get("count"), asked.get("seconds")]).toEqual(["10", "70", "2", null]);
    expect(textOf(await call(c, "lip_sync", { mediaId: "m2" }))).toContain("only a video has a picture");
    expect(toolAnnotations("lip_sync").readOnlyHint).toBe(true);
    await c.close();
  });

  it("moves the picture later in the recording as one proposal, leaving its sound where it was", async () => {
    const tl = emptyTimeline("prj_test");
    tl.version = "cut";
    const talk = makeMediaClip("m1", 10, 20, 0);
    tl.tracks[0]!.clips = [talk];
    mock.state.timeline = tl;
    const c = await connect();
    try {
      await ok(c, "timeline_get");
      const result = await ok(c, "timeline_picture_sync", { mediaId: "m1", soundLeads: 0.65, reason: "The camera's sound runs 0.65 s ahead of its picture in every stretch measured." });
      expect(textOf(result)).toContain("Moved the picture of 1 clip.");
      const body = sent("/projects/prj_test/changes").at(-1)!.body as { ops: Array<{ op: string; clipId?: string; clip?: MediaClip; patch?: Record<string, unknown> }>; fromVersion: string; description: string };
      expect(body).toMatchObject({ fromVersion: "cut", description: "Put the picture in time with its sound" });
      expect(body.ops.find(o => o.op === "addClip")!.clip).toMatchObject({ mediaId: "m1", sourceIn: 10, sourceOut: 20, timelineIn: 0, volume: 1 });
      expect(body.ops.find(o => o.op === "updateClip" && o.clipId === talk.id)!.patch).toMatchObject({ volume: 0, sourceIn: 10.65, sourceOut: 20.65, timelineIn: 0 });
      expect(textOf(await call(c, "timeline_picture_sync", { mediaId: "m2", soundLeads: 0.2 }))).toContain("only a video");
    } finally { await c.close(); }
  });
});

describe("a graphic page's files", () => {
  it("reads each relative link once, decoded as a browser decodes it, and a stray % as part of the name", () => {
    const html = `<img src="a%b.png"><img src="logo%20dark.svg"><img src='logo%20dark.svg'><link href="https://fonts.example/x.css">
      <img src="/abs/pic.png"><style>@font-face { src: url("fonts/Brand.woff2") } .x { background: url(bg.jpg?v=2) }</style>`;
    expect(relativeLinks(html)).toEqual(["a%b.png", "logo dark.svg", "fonts/Brand.woff2", "bg.jpg"]);
  });
});
