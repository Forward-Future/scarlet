/** Tools and failure paths server.test.ts leaves alone: sync, crossfades, comparisons, auditions, notes, annotations and what goes to stderr. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { EDITING_TOOL_GROUPS, ScarletApiError, ScarletClient, Task } from "@scarlet/shared";
import { emptyTimeline, makeMediaClip, OpError, timelineDuration, type MediaClip, type Note, type Timeline, type Transcript } from "@scarlet/timeline";
import { z } from "zod/v3";
import { toolAnnotations } from "./annotations.js";
import { syncRate } from "./audio-sync.js";
import { createScarletMcpServer, describeError, formatZodError, transcriptionNote, validateOps, type ScarletMcpContext } from "./server.js";
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
      const result = JSON.parse(textOf(await ok(c, "timeline_crossfade_audio", { joins: [{ leftClipId: left.id, rightClipId: right.id }] })));
      const [body] = proposed();
      expect(body).toMatchObject({ description: "Smooth the selected dialogue joins", fromVersion: "cut" });
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
      await ok(c, "timeline_crossfade_audio", { joins: [{ leftClipId: left.id, rightClipId: right.id }], duration: .2, description: "Soften the join" });
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
  const writes = ["timeline_propose", "timeline_first_cut", "timeline_crossfade_audio", "captions_generate", "dialogue_apply_cuts", "dialogue_check_repeats", "dialogue_review_save",
    "dialogue_revise_cut", "note_reply", "note_resolve", "render_request", "task_log", "task_question", "learning_suggest", "skill_save_from_change", "skill_save_edit", "asset_add", "export_otio"];
  const every = EDITING_TOOL_GROUPS.flatMap(g => [...g.tools] as string[]);

  it("marks exactly the tools that change something as writes, and nothing as destructive", () => {
    expect(every.filter(name => !toolAnnotations(name).readOnlyHint).sort()).toEqual([...writes].sort());
    for (const name of every) {
      const a = toolAnnotations(name);
      // A read may be repeated; a write may not, and every edit stays reversible.
      expect(a).toMatchObject({ idempotentHint: a.readOnlyHint, destructiveHint: false, openWorldHint: false });
    }
    // A name Scarlet doesn't know is never taken for a read.
    expect(toolAnnotations("timeline_delete_everything").readOnlyHint).toBe(false);
  });

  it("registers each tool with its annotation", async () => {
    const task = Task.parse({ id: "skill-task", state: "running", projectId: "prj_test", kind: "skill_edit", agent: "codex", instruction: "Shorter pauses",
      context: { skillId: "skl_1" }, hostId: "host_a", createdBy: { type: "human", name: "Editor" } });
    const check = Task.parse({ ...task, id: "check-task", kind: "learning_check", context: { checksTaskId: "asked-task" } });
    const sessions = [await hearing(), await connect({ agent: "codex", taskId: task.id, task }), await connect({ agent: "codex", taskId: check.id, task: check })];
    try {
      const tools = (await Promise.all(sessions.map(c => c.listTools()))).flatMap(l => l.tools);
      // The hearing session lists every editing tool; the skill request adds the tool that saves its revision, and the
      // check that reads a request the one that offers a rule.
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
      const saved = JSON.parse(textOf(await ok(c, "dialogue_apply_cuts", { version: "typing", description: "Tightened", range: { start: 0, end: 10 },
        cuts: [{ start: 6.6, end: 7.6, kind: "pause", decision: "cut", reason: "A long wait." }] })));
      expect(saved).toMatchObject({ continueFrom: "applied" });
      expect(saved).not.toHaveProperty("keptSilences");
      expect(logged()).toEqual(["[scarlet-mcp] failed to place the kept silences on applied: Scarlet server error 500 (engine_error): The database is busy."]);
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
