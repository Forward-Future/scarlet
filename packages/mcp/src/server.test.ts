import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { agentCapabilities, ProposeChangeRequest, ScarletApiError, ScarletClient, Task, type EditingTools } from "@scarlet/shared";
import type { Transcript } from "@scarlet/timeline";
import { emptyTimeline, makeMediaClip } from "@scarlet/timeline";
import { createScarletMcpServer, describeError, SCARLET_TOOL_NAMES } from "./server.js";
import { buildSystemPrompt } from "./prompt.js";
import { makeState, startMockServer, type MockServer } from "./mock-server.js";

const transcript: Transcript = {
  id: "t1",
  mediaId: "m1",
  segments: [
    {
      id: "s1",
      start: 0,
      end: 6,
      text: "Hello everyone welcome back. Um, welcome back to the show.",
      words: [
        { text: "Hello", start: 0.2, end: 0.5 },
        { text: "everyone", start: 0.6, end: 1.0 },
        { text: "welcome", start: 1.1, end: 1.4 },
        { text: "back.", start: 1.5, end: 1.8 },
        { text: "Um,", start: 2.5, end: 2.7 },
        { text: "welcome", start: 3.6, end: 3.9 },
        { text: "back", start: 4.0, end: 4.3 },
        { text: "to", start: 4.4, end: 4.5 },
        { text: "the", start: 4.55, end: 4.7 },
        { text: "show.", start: 4.8, end: 5.3 },
      ],
    },
  ],
};

let mock: MockServer;
let client: Client;
let textOf: (r: CallToolResult) => string;

async function connect(taskId?: string, workDir?: string, task?: Task, editingTools?: EditingTools, alignmentWaitMs?: number) {
  const sc = new ScarletClient({ baseUrl: mock.url, token: "tok" });
  const server = createScarletMcpServer(sc, {
    projectId: "prj_test",
    alignmentWaitMs,
    editingTools,
    taskId,
    taskStartedAt: taskId ? "2026-04-01T12:00:00.000Z" : undefined,
    task,
    agent: "claude",
    author: { type: "agent", id: "claude", name: "claude", model: "opus" },
    workDir,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(b);
  return c;
}

beforeAll(async () => {
  mock = await startMockServer(makeState({ transcripts: { m1: transcript } }));
  textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
  client = await connect("task_1");
});

afterAll(async () => {
  await client.close();
  await mock.close();
});

beforeEach(() => {
  mock.requests.length = 0;
  mock.state.events.length = 0;
  // The mock has no dialogue-scan or saved-page routes, and the server notes each such miss on stderr.
  // Those lines would bury anything else a run writes there, which still shows.
  const write = console.error;
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { if (!String(args[0]).includes("no mock route")) write(...args); });
});

afterEach(() => { vi.mocked(console.error).mockRestore(); });

describe("MCP file tools", () => {
  it("confines uploads and exports, including linked parents and linked destinations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scarlet-artifact-test-"));
    const root = join(dir, "artifacts");
    await mkdir(root);
    const c = await connect(undefined, root);
    try {
      await writeFile(join(dir, "credential"), "private");
      await writeFile(join(root, "image.png"), "graphic");
      const call = (name: string, path: string) => c.callTool({ name, arguments: { path, ...(name === "export_otio" ? { version: "v1" } : {}) } });
      for (const path of ["../credential", join(dir, "credential")]) {
        expect((await call("asset_add", path)).isError).toBe(true);
        expect((await call("export_otio", path)).isError).toBe(true);
      }
      if (process.platform !== "win32") {
        await symlink(dir, join(root, "outside"));
        await symlink(join(dir, "credential"), join(root, "linked"));
        for (const path of ["outside/credential", "linked"]) {
          expect((await call("asset_add", path)).isError).toBe(true);
          expect((await call("export_otio", path)).isError).toBe(true);
        }
      }
      expect(await readFile(join(dir, "credential"), "utf8")).toBe("private");
      expect(mock.requests.some((r) => r.method === "POST" && r.path.endsWith("/media"))).toBe(false);
      expect((await call("asset_add", "image.png")).isError).toBeFalsy();
      expect((await call("export_otio", "exports/cut.otio")).isError).toBeFalsy();
      if (process.platform !== "win32") {
        // Simulate /var -> /private/var: let the configured workdir contain a
        // symlinked ancestor, then reuse the absolute path returned by export.
        const alias = join(dir, "alias");
        await symlink(dir, alias);
        const aliased = await connect(undefined, join(alias, "artifacts"));
        try {
          const exported = await aliased.callTool({ name: "export_otio", arguments: { version: "v1" } }) as CallToolResult;
          const payload = JSON.parse(textOf(exported).split("\n\n").at(-1)!);
          const uploaded = await aliased.callTool({ name: "asset_add", arguments: { path: payload.path } });
          expect(uploaded.isError).toBeFalsy();
        } finally {
          await aliased.close();
        }
      }
      expect(JSON.parse(await readFile(join(root, "exports", "cut.otio"), "utf8")).version).toBe("v1");
    } finally {
      await c.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("tool errors", () => {
  it("tells the agent which fields the engine rejected", () => {
    const err = new ScarletApiError(400, "validation_error", "request validation failed",
      [{ code: "custom", path: ["cuts", 3], message: "A repaired range must be staged inside its originally proposed removal." }]);
    expect(describeError(err)).toBe("Scarlet server error 400 (validation_error): request validation failed\n"
      + "- cuts.3: A repaired range must be staged inside its originally proposed removal.");
    expect(describeError(new ScarletApiError(409, "cut_changed", "The edit changed."))).toBe("Scarlet server error 409 (cut_changed): The edit changed.");
  });
});

describe("tools/list", () => {
  it("keeps core editing available and omits disabled tools from discovery and calls", async () => {
    const session = await connect(undefined, undefined, undefined, { pictures: false });
    try {
      const names = (await session.listTools()).tools.map(t => t.name);
      expect(names).toContain("timeline_propose");
      expect(names).not.toContain("frame_contact_sheet");
      expect(names).not.toContain("frame_contact_sheet_batch");
      expect(names).not.toContain("media_frame");
      const unavailable = await session.callTool({ name: "media_frame", arguments: { mediaId: "m1", t: 0 } });
      expect(unavailable.isError).toBe(true);
    } finally { await session.close(); }
  });
  it("registers every Scarlet tool with a description", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    // Claude's harness does not deliver audio, so nothing offers WAV. Only the check that reads a request offers a rule.
    expect(names).toEqual([...SCARLET_TOOL_NAMES].filter(n => n !== "source_audio" && n !== "learning_suggest").sort());
    for (const t of tools) expect(Object.keys(t.inputSchema.properties ?? {})).not.toContain("includeAudio");
    expect(JSON.stringify(tools)).not.toMatch(/\bWAV\b|can (hear|play)|accepts audio|consume audio/);
    for (const t of tools) expect(t.description?.length ?? 0).toBeGreaterThan(20);
    const propose = tools.find((t) => t.name === "timeline_propose")!;
    for (const op of ["addClip", "removeClip", "updateClip", "moveClip", "splitClip", "rippleDelete", "rippleInsertGap", "addTrack", "removeTrack", "updateTrack", "addMarker", "removeMarker", "updateMarker", "setTimeline"]) {
      expect(propose.description).toContain(`- ${op}:`);
    }
  });
});

describe("project_get", () => {
  it("summarises settings, media and head", async () => {
    const r = (await client.callTool({ name: "project_get", arguments: {} })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    const t = textOf(r);
    // One compact JSON body, no duplicate summary.
    const body = JSON.parse(t);
    expect(body.settings).toMatchObject({ width: 1920, height: 1080 });
    expect(body.media[0]).toMatchObject({ id: "m1", kind: "video", name: "talk.mp4", hasTranscript: true });
    expect(t).not.toContain("\n");
  });
});

describe("timeline_first_cut", () => {
  it("posts a well-formed ProposeChangeRequest with author/taskId and records a change event", async () => {
    const r = (await client.callTool({
      name: "timeline_first_cut",
      arguments: { intent: "requested",
        mediaId: "m1",
        keep: [
          { start: 0.1, end: 1.9, label: "Hello everyone" },
          { start: 3.5, end: 5.4, label: "welcome back to the show" },
        ],
        audioMediaId: "m2",
        crossfade: 0.066,
        description: "First cut: drop the um and the repeated welcome.",
      },
    })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    const post = mock.requests.find((q) => q.method === "POST" && q.path === "/projects/prj_test/changes");
    expect(post).toBeDefined();
    const parsed = ProposeChangeRequest.safeParse(post!.body);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    const body = parsed.success ? parsed.data : null!;
    expect(body.author).toMatchObject({ type: "agent", name: "claude", model: "opus" });
    expect(body.taskId).toBe("task_1");
    expect(body.intent).toBe("requested");
    expect(body.ops).toBeUndefined();
    expect(body.timeline!.tracks[0]!.clips.length).toBe(2);
    expect(body.timeline!.tracks[1]!.clips.length).toBe(2);
    const v1 = body.timeline!.tracks[0]!.clips[1]!;
    expect(v1).toMatchObject({ kind: "media", mediaId: "m1", sourceIn: 3.5, sourceOut: 5.4, volume: 0 });
    expect(v1.timelineIn).toBeCloseTo(1.8, 6);
    expect(body.timeline!.tracks[1]!.clips[0]).toMatchObject({ mediaId: "m2", audioFadeIn: 0.066, audioFadeOut: 0.066 });
    expect(post!.headers.authorization).toBe("Bearer tok");

    const out = textOf(r);
    expect(out).toContain("First edit: 2 clip(s), 3.70 s total");
    expect(out).toContain('"changeId":"chg_1","state":"proposed"');
    // The MCP server posts a `change` event with the changeId for the host.
    const ev = mock.state.events.find((e) => e.type === "change");
    expect(ev).toBeDefined();
    expect(ev!.data).toMatchObject({ changeId: "chg_1" });
  });

  it("lays a second synced recording above the first as an inset, in full and on its own clock", async () => {
    const media = mock.state.project.media;
    // A camera that started 2 s after the screen recording and ran 100 s.
    media.push({ id: "cam", kind: "video", name: "camera.mp4", path: "camera.mp4", duration: 100, width: 1920, height: 1080, hasAudio: true });
    const head = mock.state.timeline;
    try {
      const call = (layer: object, more: object = {}) => client.callTool({ name: "timeline_first_cut", arguments: { intent: "requested", mediaId: "m1",
        keep: [{ start: 0, end: 120 }], layer, description: "Lay out the screen with the camera inset.", ...more } }) as Promise<CallToolResult>;
      const posts = () => mock.requests.filter(q => q.method === "POST" && q.path === "/projects/prj_test/changes");
      const sent = posts().length;
      const r = await call({ mediaId: "cam", offset: 2, sound: true });
      expect(r.isError).toBeFalsy();
      const body = ProposeChangeRequest.parse(posts().at(-1)!.body);
      expect(body.firstCut).toBe(true);
      expect(body.timeline!.tracks.map(t => [t.id, t.kind, t.clips.length])).toEqual([["v1", "video", 1], ["v2", "video", 1], ["a1", "audio", 0]]);
      expect(body.timeline!.tracks[0]!.clips[0]).toMatchObject({ mediaId: "m1", sourceIn: 0, sourceOut: 120, timelineIn: 0, volume: 0 });
      // The camera's own clock, where it has footage, heard, at the preset inset.
      expect(body.timeline!.tracks[1]!.clips[0]).toMatchObject({ mediaId: "cam", sourceIn: 0, sourceOut: 100, timelineIn: 2, volume: 1,
        transform: { scale: 0.25, x: 0.35, y: 0.35 } });
      expect(textOf(r)).toContain("Layer cam: 100.00 s of the 120.00 s inset on V2 in 1 clip(s); it has no footage for the other 20.00 s, where m1 plays alone.");
      // Keep ranges cut both at the same moments, and the first recording stays the sound unless the layer is chosen.
      const framing = { scale: 0.4, x: -0.25, y: 0.1, cropLeft: .12, cropRight: .12, cropTop: .04, cornerRadius: .06 };
      await call({ mediaId: "cam", offset: -1.5, framing }, {
        keep: [{ start: 0, end: 10 }, { start: 20, end: 30 }], description: "Use the opening and closing scenes.",
      });
      const proposal = ProposeChangeRequest.parse(posts().at(-1)!.body);
      const cut = proposal.timeline!;
      expect(cut.tracks[0]!.clips).toMatchObject([{ volume: 1 }, { volume: 1 }]);
      expect(cut.tracks[1]!.clips).toMatchObject([{ sourceIn: 1.5, sourceOut: 11.5, timelineIn: 0, volume: 0, transform: framing },
        { sourceIn: 21.5, sourceOut: 31.5, timelineIn: 10, transform: framing }]);
      // What can't be a layer says why, and nothing is proposed.
      const proposed = posts().length;
      expect(proposed).toBe(sent + 2);
      for (const [layer, more, why] of [
        [{ mediaId: "nope", offset: 0 }, {}, "Layer media nope is not in this project"],
        [{ mediaId: "m2", offset: 0 }, {}, "A separate sound recording goes in audioMediaId"],
        [{ mediaId: "m1", offset: 0 }, {}, "not mediaId itself"],
        [{ mediaId: "cam", offset: 2, sound: true }, { audioMediaId: "m2" }, "Choose one sound"],
      ] as const) {
        const refused = await call(layer, more);
        expect(refused.isError).toBe(true);
        expect(textOf(refused)).toContain(why);
      }
      expect(posts()).toHaveLength(proposed);
    } finally {
      media.pop();
      mock.state.timeline = head;
    }
  });

  it("rejects bad keep ranges readably", async () => {
    const r = (await client.callTool({
      name: "timeline_first_cut",
      arguments: { intent: "requested", mediaId: "m1", keep: [{ start: 5, end: 2 }, { start: 0, end: 999 }], description: "x" },
    })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("keep[0]: end (2) must be greater than start (5)");
    expect(textOf(r)).toContain("exceeds media duration 120");
  });
});

describe("timeline_first_cut indexed keeps", () => {
  let mock: MockServer;
  beforeEach(async () => { mock = await startMockServer(makeState({ transcripts: { m1: transcript } })); });
  afterEach(async () => { await mock.close(); });

  async function connectEditor() {
    const server = createScarletMcpServer(new ScarletClient({ baseUrl: mock.url, token: "tok" }), {
      projectId: "prj_test", agent: "claude", author: { type: "agent", name: "claude" },
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const editor = new Client({ name: "test", version: "0" });
    await editor.connect(b);
    return editor;
  }

  it("measures skipped words and a consecutive-word pause on the selected dialogue track", async () => {
    const words = [
      { text: "Start", start: 0.2, end: 0.5 }, { text: "here.", start: 0.7, end: 1.0 },
      { text: "Um.", start: 1.8, end: 2.1 }, { text: "Next.", start: 3.5, end: 3.8 },
      { text: "Last", start: 5.5, end: 5.8 }, { text: "word.", start: 5.9, end: 6.2 },
    ];
    const mic: Transcript = { id: "t2", mediaId: "m2", segments: [{ id: "s2", start: 0, end: 6.3,
      text: words.map(w => w.text).join(" "), words }] };
    mock.state.transcripts = { m2: mic };
    mock.state.project.media = mock.state.project.media.map(m => m.id === "m2" ? { ...m, transcriptId: mic.id } : m);
    mock.state.waveform = (id, from, to, points) => spokenWaveform(id, from, to, points, words);
    const editor = await connectEditor();
    try {
      const result = await editor.callTool({ name: "timeline_first_cut", arguments: {
        intent: "requested", mediaId: "m1", audioMediaId: "m2", description: "Keep the three points.",
        keep: [{ fromWord: 0, toWord: 1, start: 0.1 }, { fromWord: 3, toWord: 3 }, { fromWord: 4, toWord: 5, end: 6.3 }],
      } }) as CallToolResult;
      expect(result.isError, textOf(result)).toBeFalsy();
      const posts = mock.requests.filter(r => r.method === "POST" && r.path === "/projects/prj_test/changes");
      expect(posts, textOf(result)).toHaveLength(1);
      const tracks = ProposeChangeRequest.parse(posts[0]!.body).timeline!.tracks;
      const clips = tracks[0]!.clips.filter(c => c.kind === "media");
      expect(clips).toHaveLength(3);
      expect(clips[0]!.sourceIn).toBeCloseTo(0.1);
      expect(clips[0]!.sourceOut).toBeGreaterThan(1.0);
      expect(clips[0]!.sourceOut).toBeLessThan(1.8);
      expect(clips[1]!.sourceIn).toBeGreaterThan(2.1);
      expect(clips[1]!.sourceIn).toBeLessThan(3.5);
      expect(clips[1]!.sourceOut).toBeGreaterThan(3.8);
      expect(clips[2]!.sourceIn).toBeLessThan(5.5);
      expect(clips[2]!.sourceIn - clips[1]!.sourceOut).toBeGreaterThan(0.5);
      expect(clips[2]!.sourceOut).toBeCloseTo(6.3);
      expect(tracks[1]!.clips).toMatchObject(clips.map(c => ({ mediaId: "m2", sourceIn: c.sourceIn, sourceOut: c.sourceOut })));
      expect(mock.requests.some(r => r.path.endsWith("/m2/waveform"))).toBe(true);
    } finally { await editor.close(); }
  });

  it("leaves a cut unapplied when an indexed join cannot land in measured silence", async () => {
    const editor = await connectEditor();
    try {
      const voice = [{ text: "unbroken voice", start: 0, end: 6 }];
      mock.state.waveform = (id, from, to, points) => spokenWaveform(id, from, to, points, voice);
      const result = await editor.callTool({ name: "timeline_first_cut", arguments: {
        intent: "requested", mediaId: "m1", description: "Remove the filler between these lines.",
        keep: [{ fromWord: 0, toWord: 3, start: 0.1 }, { fromWord: 5, toWord: 9, end: 5.5 }],
      } }) as CallToolResult;
      expect(textOf(result)).toMatch(/join|quiet|review|silence|edge/i);
      expect(mock.requests.some(r => r.path.endsWith("/m1/waveform"))).toBe(true);
      expect(mock.requests.some(r => r.method === "POST" && r.path === "/projects/prj_test/changes")).toBe(false);
    } finally { await editor.close(); }
  });

  it("identifies both repeated takes at an indexed join and gives recovery steps supported by the keep list", async () => {
    mock.state.waveform = spokenWaveform;
    const editor = await connectEditor();
    try {
      const result = await editor.callTool({ name: "timeline_first_cut", arguments: {
        intent: "requested", mediaId: "m1", description: "Join the opening lines.",
        keep: [{ fromWord: 0, toWord: 3 }, { fromWord: 5, toWord: 9 }],
      } }) as CallToolResult;
      expect(result.isError).toBe(true);
      const message = textOf(result);
      expect(message).toMatch(/welcome back/i);
      expect(message).toContain("1.1–1.8 s");
      expect(message).toContain("3.6–4.3 s");
      expect(message).toMatch(/kept word indices/i);
      expect(message).toMatch(/exact source seconds/i);
      expect(message).not.toContain("keepRepeat");
      expect(mock.requests.some(r => r.method === "POST" && r.path === "/projects/prj_test/changes")).toBe(false);
    } finally { await editor.close(); }
  });

  it("requires explicit boundaries at a reorder or a visual passage and preserves their supplied order", async () => {
    const editor = await connectEditor();
    const call = (keep: object[]) => editor.callTool({ name: "timeline_first_cut", arguments: {
      intent: "requested", mediaId: "m1", description: "Show the closing words before the opening.", keep,
    } }) as Promise<CallToolResult>;
    const changes = () => mock.requests.filter(r => r.method === "POST" && r.path === "/projects/prj_test/changes");
    try {
      const late = { fromWord: 5, toWord: 9, start: 3.5 }, early = { fromWord: 0, toWord: 3, end: 1.9 };
      await call([late, early]);
      await call([late, { start: 15, end: 18 }]);
      expect(changes()).toHaveLength(0);
      const result = await call([{ ...late, end: 5.4 }, { ...early, start: 0.1 }, { start: 15, end: 18 }]);
      expect(result.isError, textOf(result)).toBeFalsy();
      expect(changes(), textOf(result)).toHaveLength(1);
      const clips = ProposeChangeRequest.parse(changes()[0]!.body).timeline!.tracks[0]!.clips;
      expect(clips).toMatchObject([{ sourceIn: 3.5, sourceOut: 5.4 }, { sourceIn: 0.1, sourceOut: 1.9 }, { sourceIn: 15, sourceOut: 18 }]);
    } finally { await editor.close(); }
  });

  it("measures the first and last handles of a kept phrase and preserves an already short pause", async () => {
    const editor = await connectEditor();
    mock.state.waveform = spokenWaveform;
    try {
      const result = await editor.callTool({ name: "timeline_first_cut", arguments: {
        intent: "requested", mediaId: "m1", description: "Keep this phrase.",
        keep: [{ fromWord: 4, toWord: 5 }, { fromWord: 6, toWord: 8 }],
      } }) as CallToolResult;
      expect(result.isError, textOf(result)).toBeFalsy();
      const post = mock.requests.find(r => r.method === "POST" && r.path === "/projects/prj_test/changes");
      const [first, second] = ProposeChangeRequest.parse(post!.body).timeline!.tracks[0]!.clips.filter(c => c.kind === "media");
      expect(first!.sourceIn).toBeGreaterThan(1.8);
      expect(first!.sourceIn).toBeLessThan(2.5);
      expect(first!.sourceOut).toBe(second!.sourceIn);
      expect(second!.sourceOut).toBeGreaterThan(4.7);
      expect(second!.sourceOut).toBeLessThan(4.8);
      expect(mock.requests.some(r => r.path.endsWith("/m1/waveform"))).toBe(true);
    } finally { await editor.close(); }
  });
});

describe("timeline_propose", () => {
  it("reuses the timeline it read for a proposal while fresh head reads still reach the engine", async () => {
    const c = await connect();
    try {
      await c.callTool({ name: "timeline_get", arguments: {} });
      const result = await c.callTool({ name: "timeline_propose", arguments: { intent: "requested",
        description: "Add marker", ops: [{ op: "addMarker", marker: { id: "note", time: 1, text: "test" } }],
      } });
      expect(result.isError).toBeFalsy();
      const reads = () => mock.requests.filter(r => r.method === "GET" && r.path.endsWith("/timeline"));
      expect(reads()).toHaveLength(1);
      await c.callTool({ name: "timeline_get", arguments: {} });
      expect(reads()).toHaveLength(2);
    } finally {
      await c.close();
    }
  });

  it("never requests a version named draft after reading an unpersisted empty head", async () => {
    const old = mock.state.timeline;
    const c = await connect();
    try {
      mock.state.timeline = emptyTimeline(mock.state.project.id);
      const first = await c.callTool({ name: "timeline_get", arguments: {} });
      expect(first.isError).toBeFalsy();
      const result = await c.callTool({ name: "timeline_propose", arguments: { intent: "requested",
        description: "First marker", ops: [{ op: "setTimeline", patch: { name: "New cut" } }],
      } });
      expect(result.isError).toBeFalsy();
      expect(mock.requests.some((r) => r.query.get("version") === "draft")).toBe(false);
      const request = mock.requests.find((r) => r.path.endsWith("/changes") && r.method === "POST");
      expect(request?.body).not.toHaveProperty("fromVersion", "draft");
    } finally {
      mock.state.timeline = old;
      await c.close();
    }
  });

  it("applies valid ops against head, a ripple removal on whole frames", async () => {
    // At 30 fps: 0.987 s is short of frame 30 and 1.513 s is past frame 45, so frames 30 to 45 come out: 1.0 to 1.5 s.
    const r = (await client.callTool({
      name: "timeline_propose",
      arguments: { intent: "requested", ops: [{ op: "rippleDelete", start: 0.987, end: 1.513 }], description: "Tighten the pause after hello." },
    })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("Duration 3.70 → 3.20");
    const post = mock.requests.find((q) => q.method === "POST" && q.path === "/projects/prj_test/changes")!;
    expect((post.body as { ops: unknown[] }).ops).toEqual([{ op: "rippleDelete", start: 1.0, end: 1.5 }]);
    // The agent is told where the removal landed.
    expect(JSON.parse(textOf(r))).toMatchObject({ onWholeFrames: [{ asked: [0.987, 1.513], removed: [1, 1.5] }] });
  });

  it("returns a readable error for invalid ops instead of crashing", async () => {
    const r = (await client.callTool({
      name: "timeline_propose",
      arguments: { intent: "requested", ops: [{ op: "teleportClip", clipId: "c1" }, { op: "splitClip", clipId: "c1" }], description: "x" },
    })) as CallToolResult;
    expect(r.isError).toBe(true);
    const t = textOf(r);
    expect(t).toContain("Invalid ops:");
    expect(t).toContain("ops[0]");
    expect(t).toContain("ops[1] (splitClip).at");
    expect(t).toContain("Op types");
    expect(mock.requests.some((q) => q.method === "POST")).toBe(false);
  });

  it("dry-runs ops locally and reports unknown clip ids", async () => {
    const r = (await client.callTool({
      name: "timeline_propose",
      arguments: { intent: "requested", ops: [{ op: "removeClip", clipId: "does_not_exist" }], description: "x" },
    })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("clip does_not_exist not found");
  });

  it("requires exactly one of ops/timeline", async () => {
    const r = (await client.callTool({ name: "timeline_propose", arguments: { intent: "requested", description: "x" } })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Provide either");
  });

  /** An edit of 6.02 s at 30 fps, which ends between two frames, and what a session sent the engine for its ops. */
  async function offFrameEdit(taskId: string | undefined, ops: unknown[], options: object = {}) {
    const original = { timeline: mock.state.timeline, head: mock.state.project.head };
    const tl = emptyTimeline(mock.state.project.id);
    tl.version = "offframe";
    tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 6.02, 0)];
    mock.state.timeline = tl;
    const c = await connect(taskId);
    try {
      const r = await c.callTool({ name: "timeline_propose", arguments: { intent: "requested", description: "Tighten the pauses", ops, ...options } }) as CallToolResult;
      expect(r.isError, textOf(r)).toBeFalsy();
      const post = mock.requests.findLast(q => q.method === "POST" && q.path === "/projects/prj_test/changes")!;
      return { sent: (post.body as { ops: Array<{ start: number; end: number }> }).ops,
        result: JSON.parse(textOf(r)) as { duration: number; onWholeFrames?: Array<{ asked: number[]; removed: number[] }> } };
    } finally {
      mock.state.timeline = original.timeline;
      mock.state.project.head = original.head;
      await c.close();
    }
  }
  // Ops run in order: half a second comes out at 1 s, then frames 61 to 90, and the edit now ends at 4.5533 s.
  const shortenedEnd = 6.02 - .5 - (3 - 61 / 30);
  const threeRipples = [{ op: "rippleDelete", start: 1, end: 1.5 }, { op: "rippleDelete", start: 2.013, end: 3.02 }, { op: "rippleDelete", start: 4, end: shortenedEnd }];

  it("keeps the end of a later ripple that runs to the end of the edit as the earlier ones left it", async () => {
    const { sent, result } = await offFrameEdit(undefined, threeRipples);
    expect(sent[0]).toMatchObject({ start: 1, end: 1.5 });
    // A removal inside the edit still lands on whole frames.
    expect(sent[1]!.start).toBeCloseTo(61 / 30, 9);
    expect(sent[1]!.end).toBe(3);
    // The last one runs to the end of the edit as it stands by then, and keeps that end.
    expect(sent[2]).toMatchObject({ start: 4, end: shortenedEnd });
    expect(result.onWholeFrames).toEqual([{ asked: [2.013, 3.02], removed: [2.033, 3] }]);
    expect(result.duration).toBeCloseTo(4, 9);
  });

  it("puts that ripple on a whole frame within a task, where the engine would, and says so", async () => {
    // The engine aligns a task's removals by the end of the version the edit starts from. Left to it, the move would go unreported.
    const { sent, result } = await offFrameEdit("task_ripples", threeRipples);
    expect(sent[2]!.start).toBe(4);
    expect(sent[2]!.end).toBeCloseTo(136 / 30, 9);
    expect(result.onWholeFrames).toEqual([{ asked: [2.013, 3.02], removed: [2.033, 3] }, { asked: [4, shortenedEnd], removed: [4, 4.533] }]);
  });

  it("goes by the end the edit started with after a ripple on some tracks only, or any other op", async () => {
    // Half a second out of the empty audio track leaves the picture, and so the edit, as long as it was: a removal
    // to 5.52 s is inside the edit and lands on a frame.
    const limited = await offFrameEdit(undefined, [{ op: "rippleDelete", start: 1, end: 1.5, trackIds: ["a1"] }, { op: "rippleDelete", start: 4, end: 5.52 }]);
    expect(limited.sent[1]).toMatchObject({ start: 4, end: 5.5 });
    expect(limited.result.onWholeFrames).toEqual([{ asked: [4, 5.52], removed: [4, 5.5] }]);
    // After a marker, where the edit ends is no longer followed, by the removal before it or the ones after.
    const mixed = await offFrameEdit(undefined, [{ op: "rippleDelete", start: 1, end: 1.5 }, { op: "addMarker", marker: { id: "spot", time: 1, text: "here" } },
      { op: "rippleDelete", start: 2, end: 2.5 }, { op: "rippleDelete", start: 4, end: 5.52 }]);
    expect(mixed.sent[3]).toMatchObject({ start: 4, end: 5.5 });
    expect(mixed.result.onWholeFrames).toEqual([{ asked: [4, 5.52], removed: [4, 5.5] }]);
  });

  it("measures and submits the same frame-bounded ripples it reports, including the scope", async () => {
    const range = { start: 0.5005, end: 2.4995 };
    const { sent, result } = await offFrameEdit("task_scoped", [{ op: "rippleDelete", ...range }], { range });
    const body = mock.requests.findLast(q => q.method === "POST" && q.path === "/projects/prj_test/changes")!.body;
    expect(body).toMatchObject({ range });
    expect(sent).toEqual([{ op: "rippleDelete", start: 16 / 30, end: 74 / 30 }]);
    expect(result.onWholeFrames).toEqual([{ asked: [range.start, range.end], removed: [16 / 30, 74 / 30] }]);
  });

  /**
   * An earlier version, the working edit, and a pending suggestion on it that takes out the “Um,”. `at.head` names the
   * one the engine has as head, and `bases` lists the version each proposal was made against.
   */
  async function threeVersions() {
    const original = { extra: mock.state.extra, waveform: mock.state.waveform };
    const version = (id: string, ...clips: ReturnType<typeof makeMediaClip>[]) => {
      const tl = emptyTimeline(mock.state.project.id);
      tl.version = id;
      tl.tracks[1]!.clips = clips;
      return tl;
    };
    const versions: Record<string, ReturnType<typeof version>> = {
      old: version("old", makeMediaClip("m1", 0, 6, 0)),
      cur: version("cur", makeMediaClip("m1", 0, 5.5, 0)),
      sug: version("sug", makeMediaClip("m1", 0, 1.9, 0), makeMediaClip("m1", 3.5, 5.5, 1.9)),
    };
    const bases: unknown[] = [], at = { head: "cur" };
    mock.state.waveform = spokenWaveform;
    mock.state.extra = (req, res) => {
      let result;
      if (req.method === "GET" && req.path === "/projects/prj_test/timeline") result = { timeline: versions[req.query.get("version")!] ?? versions[at.head] };
      else if (req.method === "POST" && req.path === "/projects/prj_test/changes") {
        const { fromVersion, description } = req.body as { fromVersion?: string; description: string };
        bases.push(fromVersion);
        result = { change: { id: `chg_base_${bases.length}`, state: "proposed", description, fromVersion, toVersion: "next", ranges: [] }, duration: 5.5, diffDescription: [] };
      } else if (/\/versions\/(old|head)\/diff\/cur$/.test(req.path)) result = { diff: { durationBefore: 6, durationAfter: 5.5, ranges: [] }, description: [] };
      else if (req.path === "/projects/prj_test/changes/pass") result = { change: { id: "pass", projectId: "prj_test", intent: "suggestion", state: "ready",
        fromVersion: "cur", toVersion: "sug", description: "Review 1 optional dialogue cut", cutReasons: [{ start: 1.9, end: 3.5, reason: "A filler." }],
        ops: [{ op: "rippleDelete", start: 1.9, end: 3.5 }] } };
      else if (req.path.endsWith("/cut-review")) result = { review: { original: versions.cur, proposed: versions.sug, firstCut: false,
        cuts: [{ at: 1.9, removed: { start: 1.9, end: 3.5 }, beforeClip: 1 }] } };
      else return false;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
      return true;
    };
    const c = await connect();
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await c.callTool({ name, arguments: args }) as CallToolResult;
      expect(r.isError, textOf(r)).toBeFalsy();
      return r;
    };
    return { bases, at, call, close: async () => { Object.assign(mock.state, original); await c.close(); } };
  }

  it("proposes against the version the agent read, whatever a diff, a join audit or a review's inspection read since", async () => {
    const { bases, call, close } = await threeVersions();
    /** The version an edit with no fromVersion is proposed against. */
    const base = async () => {
      await call("timeline_propose", { description: "Mark the spot", ops: [{ op: "addMarker", marker: { id: "spot", time: 1, text: "here" } }] });
      return bases.at(-1);
    };
    try {
      await call("timeline_get", {});
      expect(await base()).toBe("cur");
      // A diff reads the earlier version to compare with. The agent's edit is still on the one it read.
      expect(textOf(await call("timeline_diff", { from: "old" }))).toContain("old → cur");
      expect(await base()).toBe("cur");
      // A change's join audit reads the change's two versions, and a pending suggestion's is not the working edit.
      expect(JSON.parse(textOf(await call("timeline_join_audit", { changeId: "pass" })))).toMatchObject({ version: "sug", joins: 1 });
      expect(await base()).toBe("cur");
      // Inspecting a staged cut measures its join on the suggestion's version.
      const inspected = await call("dialogue_review_inspect", { changeId: "pass", index: 0 });
      expect(textOf(inspected)).toContain('"joinAudit":[');
      expect(await base()).toBe("cur");
      // Reading another version is the agent's own look, and its next edit is on that one.
      await call("timeline_get", { version: "old" });
      expect(await base()).toBe("old");
    } finally {
      await close();
    }
  });

  it("reads a saved version once for everything measured on it, and the head each time it is named", async () => {
    const { at, call, close } = await threeVersions();
    const reads = (version: string) => mock.requests.filter(r => r.method === "GET" && r.path === "/projects/prj_test/timeline" && r.query.get("version") === version);
    try {
      await call("timeline_get", {});
      // A change's join audit and each inspection of its cut measure the suggestion's version, which never changes.
      await call("timeline_join_audit", { changeId: "pass" });
      for (let i = 0; i < 2; i++) expect(textOf(await call("dialogue_review_inspect", { changeId: "pass", index: 0 }))).toContain('"joinAudit":[');
      expect(reads("sug")).toHaveLength(1);
      // Head is a name for whichever version is current. A diff from it compares with the head of the moment.
      expect(textOf(await call("timeline_diff", { from: "head", to: "cur" }))).toContain("joins +0/−0");
      at.head = "sug";
      expect(textOf(await call("timeline_diff", { from: "head", to: "cur" }))).toContain("joins +0/−1");
    } finally {
      await close();
    }
  });
});

describe("waveform_get", () => {
  it("detects silences from synthetic peaks and renders a sparkline", async () => {
    mock.state.waveform = (mediaId, from, to, points) => ({
      mediaId,
      from,
      to,
      // 10 s window: silence from 4.0 to 5.0 s, and a too-short dip at 8.0-8.1
      peaks: Array.from({ length: points }, (_, i) => {
        const t = from + ((to - from) * i) / points;
        if (t >= 4 && t < 5) return 0.01;
        if (t >= 8 && t < 8.1) return 0.0;
        return 0.7;
      }),
    });
    const r = (await client.callTool({ name: "waveform_get", arguments: { mediaId: "m1", from: 0, to: 10, points: 100 } })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(textOf(r));
    expect(body.sparkline).toMatch(/[▁▂▃▄▅▆▇█]{50,}/);
    expect(body.silences).toEqual([{ start: 4, end: 5, duration: 1 }]);
    // Levels are dBFS like every other audio tool: 0.7 → -3, 0.01 → -40, silence floors at -99.
    expect(body.peaksDb.length).toBe(100);
    expect(body.peaksDb.slice(0, 3)).toEqual([-3, -3, -3]);
    expect(body.peaksDb[45]).toBe(-40);
    expect(Math.min(...body.peaksDb)).toBe(-99);
  });

  it("stops at the end of the recording instead of reporting silence past it", async () => {
    const original = mock.state.waveform;
    // As the engine answers: the range it was asked, with nothing in the buckets past the two minutes the recording lasts.
    mock.state.waveform = (mediaId, from, to, points) => ({ mediaId, from, to,
      peaks: Array.from({ length: points }, (_, i) => from + ((to - from) * (i + .5)) / points < 120 ? 0.7 : 0) });
    try {
      const r = (await client.callTool({ name: "waveform_get", arguments: { mediaId: "m1", from: 100, to: 200, points: 100 } })) as CallToolResult;
      expect(r.isError, textOf(r)).toBeFalsy();
      const body = JSON.parse(textOf(r));
      expect(body).toMatchObject({ from: 100, to: 120, silences: [] });
      expect(Math.min(...body.peaksDb)).toBe(-3);
      // A range that starts past the end has nothing to measure, and says where the recording ends.
      const past = (await client.callTool({ name: "waveform_get", arguments: { mediaId: "m1", from: 130, to: 180 } })) as CallToolResult;
      expect(past.isError).toBe(true);
      expect(textOf(past)).toContain("inside 0–120.00 s");
    } finally { mock.state.waveform = original; }
  });
});

it("combines word context and independently detected speech on a waveform suggestion request", async () => {
  const original = mock.state.waveform;
  mock.state.waveform = (mediaId, from, to, points) => ({
    mediaId, from, to, peaks: Array(points).fill(0.001), rms: Array(points).fill(0.0005),
    speechActivity: [{ start: 1.8, end: 2.5 }],
  });
  try {
    const r = await client.callTool({ name: "waveform_get", arguments: { mediaId: "m1", from: 0, to: 6, suggestCuts: true } }) as CallToolResult;
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(textOf(r).split("\n\n").at(-1)!);
    expect(body.dialogue.candidates).toEqual([expect.objectContaining({ before: "Um,", after: "welcome" })]);
    expect(mock.requests.some(req => req.query.get("speechActivity") === "1")).toBe(true);
  } finally { mock.state.waveform = original; }
});

describe("transcript tools", () => {
  it("transcript_search finds phrases with context", async () => {
    const r = (await client.callTool({ name: "transcript_search", arguments: { mediaId: "m1", query: "WELCOME back" } })) as CallToolResult;
    const t = textOf(r);
    expect(t).toContain('2 exact match(es) for "WELCOME back"');
    expect(t).toContain("#2 [1.10-1.80]");
    expect(t).toContain("#5 [3.60-4.30]");
    const fuzzy = textOf(await client.callTool({ name: "transcript_search", arguments: { mediaId: "m1", query: "welcomes back to a show", match: "fuzzy" } }) as CallToolResult);
    expect(fuzzy).toMatch(/#5 \[3\.60-5\.30\] 0\.\d+/);
  });
  it("reads cached words and empty ranges without starting transcription", async () => {
    const r = (await client.callTool({ name: "transcript_get", arguments: { mediaId: "m1", from: 0, to: 2 } })) as CallToolResult;
    expect(textOf(r)).toContain("#0 0.20-0.50 Hello");
    expect(textOf(r)).not.toContain("show.");
    // Indices are stable across ranges and granularities.
    expect(textOf(await client.callTool({ name: "transcript_get", arguments: { mediaId: "m1", fromWord: 5, toWord: 6 } }) as CallToolResult))
      .toContain("#5 3.60-3.90 welcome\n#6 4.00-4.30 back");
    expect(textOf(await client.callTool({ name: "transcript_get", arguments: { mediaId: "m1", granularity: "segment" } }) as CallToolResult))
      .toContain("[0.20-1.80] #0-#3 Hello everyone welcome back.");
    const none = await client.callTool({ name: "transcript_get", arguments: { mediaId: "m1", from: 10 } }) as CallToolResult;
    expect(textOf(none)).toContain("No speech in that range");
    expect(mock.requests.some(req => req.method === "POST")).toBe(false);
  });

  it("pages a 6,300-word transcript without losing words or the measured gap at a page boundary", async () => {
    const limit = 4_000;
    // The uninterrupted opening must split inside a segment. Subsequent quiet gaps exercise
    // the gap evidence at the page seams for both text granularities.
    const words = Array.from({ length: 6_300 }, (_, i) => {
      const start = i < 900 ? i * .1 : 90 + (i - 900) * .5;
      return { start, end: start + .08, text: `word${i}`, speaker: i < 3000 ? "Host" : "Guest" };
    });
    const state = makeState({ transcripts: { m1: { ...transcript, segments: [
      { id: "long", start: 0, end: words.at(-1)!.end, text: words.map(w => w.text).join(" "), words },
    ] } } });
    state.waveform = (mediaId, from, to, points) => ({ mediaId, from, to, peaks: [], rms: Array(points).fill(0) });
    const fixture = await startMockServer(state);
    const agent = new Client({ name: "transcript-pages", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      const server = createScarletMcpServer(new ScarletClient({ baseUrl: fixture.url, token: "tok" }), {
        projectId: "prj_test", agent: "claude", capabilities: agentCapabilities("claude", { resultChars: limit }),
        author: { type: "agent", name: "claude" },
      });
      await server.connect(a);
      await agent.connect(b);
      for (const [format, granularity] of [["json", "word"], ["text", "word"], ["text", "segment"]]) {
        const fromWord = 13, toWord = 6199;
        let nextFromWord: number | undefined, pages = 0, gaps = 0;
        const seen: number[] = [];
        do {
          const result = await agent.callTool({ name: "transcript_get",
            arguments: { mediaId: "m1", fromWord, toWord, format, granularity, nextFromWord } }) as CallToolResult;
          expect(result.isError).toBeFalsy();
          const text = textOf(result);
          expect(text.length).toBeLessThanOrEqual(limit);
          const first = nextFromWord ?? fromWord;
          if (format === "json") {
            const page = JSON.parse(text);
            expect(page.words[0][0]).toBe(first);
            for (const [index, start, end, spelling, speaker] of page.words) {
              seen.push(index);
              const word = words[index]!;
              if (start !== word.start || end !== word.end || spelling !== word.text || speaker !== word.speaker) {
                throw new Error(`Word #${index} changed when paged`);
              }
            }
            nextFromWord = page.nextFromWord;
          } else {
            if (pages && first > 900) expect(text.split("\n")[1]).toContain("0.42 s gap, quiet");
            gaps += [...text.matchAll(/ s gap, quiet/g)].length;
            const matches = [...text.matchAll(/\bword(\d+)\b/g)].map(m => Number(m[1]));
            expect(matches[0]).toBe(first);
            seen.push(...matches);
            const next = text.match(/Continue with nextFromWord=(\d+)\./);
            nextFromWord = next ? Number(next[1]) : undefined;
          }
          if (nextFromWord !== undefined) expect(nextFromWord).toBe(seen.at(-1)! + 1);
          pages++;
        } while (nextFromWord !== undefined && pages < 200);
        expect(pages).toBeGreaterThan(1);
        expect(seen).toEqual(Array.from({ length: toWord - fromWord + 1 }, (_, i) => fromWord + i));
        if (format === "text") expect(gaps).toBe(toWord - 900);
      }
    } finally {
      await agent.close();
      await fixture.close();
    }
  }, 60_000);

  it("starts or joins transcription and delivers words to concurrent reads without a question", async () => {
    let polls = 0;
    mock.state.extra = (req, res) => {
      if (req.path.endsWith("/media/m2/prepare")) {
        expect(req.body).toEqual({ kind: "transcript" });
        res.end(JSON.stringify({ state: "processing", taskId: "tr-job" }));
      } else if (req.path === "/projects/prj_test/tasks/tr-job") {
        if (++polls > 1) mock.state.transcripts.m2 = { ...transcript, mediaId: "m2" };
        res.end(JSON.stringify({ task: { state: polls === 1 ? "running" : "done" } }));
      } else return false;
      return true;
    };
    try {
      const [words, matches] = await Promise.all([
        client.callTool({ name: "transcript_get", arguments: { mediaId: "m2", from: 0, to: 2 } }),
        client.callTool({ name: "transcript_search", arguments: { mediaId: "m2", query: "WELCOME back" } }),
      ]);
      expect(textOf(words as CallToolResult)).toContain("#0 0.20-0.50 Hello");
      expect(textOf(matches as CallToolResult)).toContain("2 exact match(es)");
      expect(mock.requests.filter(req => req.path.endsWith("/prepare"))).toHaveLength(1);
      expect(mock.state.events.some(e => e.type === "question")).toBe(false);
    } finally {
      delete mock.state.transcripts.m2;
      mock.state.extra = undefined;
    }
  });

  it("reads the requested waveform range once Scarlet has prepared it", async () => {
    let prepared = false;
    mock.state.extra = (req, res) => {
      if (req.path.endsWith("/media/m2/prepare")) {
        expect(req.body).toEqual({ kind: "waveform" });
        prepared = true;
        res.end(JSON.stringify({ state: "ready" }));
      } else if (!prepared && req.path === "/projects/prj_test/media/m2/waveform") {
        res.writeHead(404).end();
      } else return false;
      return true;
    };
    try {
      const result = await client.callTool({ name: "waveform_get", arguments: { mediaId: "m2", from: 5, to: 10, points: 20 } });
      expect(result.isError).toBeFalsy();
      expect(prepared).toBe(true);
      expect(mock.requests.at(-1)?.query.get("from")).toBe("5");
    } finally {
      mock.state.extra = undefined;
    }
  });
});

describe("timeline_at and captions_generate", () => {
  it("maps timeline time to source time", async () => {
    // head after first cut + ripple: clip 2 (source 3.5..5.4) now starts at 1.3
    const r = (await client.callTool({ name: "timeline_at", arguments: { time: 2.0 } })) as CallToolResult;
    const at = JSON.parse(textOf(r));
    expect(at.clips.map((c: { trackId: string }) => c.trackId)).toEqual(["v1", "a1"]);
    expect(at.clips[0]).toMatchObject({ mediaId: "m1", sourceTime: 4.2 });
    // The reverse mapping: where a source second plays, and which source was cut.
    const back = JSON.parse(textOf(await client.callTool({ name: "timeline_at", arguments: { mediaId: "m1", sourceTime: 4.2 } }) as CallToolResult));
    expect(back.placements).toEqual([expect.objectContaining({ trackId: "v1", time: 2 })]);
    const range = JSON.parse(textOf(await client.callTool({ name: "timeline_at", arguments: { mediaId: "m1", sourceRange: { start: 1, end: 4 } } }) as CallToolResult));
    // The earlier ripple removed timeline 1.0–1.5 (source 1.1–1.6); the first edit dropped source 1.9–3.5.
    expect(range.placed.map((p: { start: number; end: number }) => [p.start, p.end])).toEqual([[0.9, 1], [1, 1.3], [1.3, 1.8]]);
    expect(range.missing).toEqual([{ start: 1.1, end: 1.6 }, { start: 1.9, end: 3.5 }]);
    expect((await client.callTool({ name: "timeline_at", arguments: { sourceTime: 1 } })).isError).toBe(true);
  });

  it("builds caption clips mapped through the cut, dropping cut words", async () => {
    const base = mock.state.timeline!.version;
    const r = (await client.callTool({ name: "captions_generate", arguments: { intent: "requested", mediaId: "m1", maxWords: 3, description: "captions" } })) as CallToolResult;
    expect(r.isError, textOf(r)).toBeFalsy();
    const post = mock.requests.find((q) => q.method === "POST" && q.path === "/projects/prj_test/changes")!;
    expect(post.body).toMatchObject({ fromVersion: base });
    const ops = (post.body as { ops: Array<{ op: string; track?: { clips: Array<{ text: string; timelineIn: number; words: unknown[] }> } }> }).ops;
    const add = ops.find((o) => o.op === "addTrack")!;
    const texts = add.track!.clips.map((c) => c.text);
    // "Um," was cut by the first cut; "everyone" partially (ripple removed 1.0-1.5 => "welcome" at source 1.1-1.4 dropped)
    expect(texts.join(" ")).not.toContain("Um");
    expect(texts.join(" ")).toContain("welcome back to");
    expect(add.track!.clips[0]!.timelineIn).toBeCloseTo(0.1, 3);
    expect(add.track!.clips[0]!.words.length).toBeGreaterThan(0);
  });

  it("prepares source speech when captioning a cut without cached transcripts", async () => {
    const timeline = mock.state.timeline;
    delete mock.state.transcripts.m1;
    const prepared: string[] = [];
    mock.state.extra = (req, res) => {
      const id = /^\/projects\/prj_test\/media\/(m[12])\/prepare$/.exec(req.path)?.[1];
      if (!id) return false;
      prepared.push(id);
      mock.state.transcripts[id] = { ...transcript, mediaId: id };
      res.end(JSON.stringify({ state: "ready" }));
      return true;
    };
    // A session keeps the words it has read, and the shared one has read both recordings. This one has read none.
    const fresh = await connect("task_1");
    try {
      const result = await fresh.callTool({ name: "captions_generate", arguments: { intent: "requested", destination: "new" } }) as CallToolResult;
      expect(result.isError, textOf(result)).toBeFalsy();
      expect(prepared.length).toBeGreaterThan(0);
    } finally {
      mock.state.timeline = timeline;
      mock.state.transcripts.m1 = transcript;
      delete mock.state.transcripts.m2;
      mock.state.extra = undefined;
      await fresh.close();
    }
  });

  it("regenerates only the chosen caption track, preserving its style, order and the other language", async () => {
    const before = mock.state.timeline;
    const tl = emptyTimeline(mock.state.project.id);
    tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 6, 0)];
    tl.tracks.push({ id: "en", kind: "caption", name: "English", hidden: true, muted: false, clips: [], captionStyle: { y: .2 } },
      { id: "fr", kind: "caption", name: "French", hidden: false, muted: false, clips: [] });
    mock.state.timeline = tl;
    try {
      const generate = (extra: object) => client.callTool({ name: "captions_generate", arguments: { intent: "suggestion", ...extra } });
      const choice = JSON.parse(textOf(await generate({})));
      expect(choice.captionTracks.map((t: { id: string }) => t.id)).toEqual(["en", "fr"]);
      expect(mock.requests.some(r => r.path.endsWith("/changes"))).toBe(false);
      expect((await generate({ destination: { replaceTrackId: "en" }, style: { fontSize: .07 } })).isError).toBeFalsy();
      expect(mock.requests.find(r => r.path.endsWith("/changes"))?.body).toMatchObject({ ops: [
        { op: "removeTrack", trackId: "en" },
        { op: "addTrack", index: 2, track: { id: "en", name: "English", hidden: true, captionStyle: { y: .2, fontSize: .07 } } },
      ] });
    } finally { mock.state.timeline = before; }
  });
});

describe("media_frame", () => {
  it("returns an image content block", async () => {
    const r = (await client.callTool({ name: "media_frame", arguments: { mediaId: "m1", t: 1.5, width: 320 } })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    const img = r.content.find((c) => c.type === "image") as { data: string; mimeType: string };
    expect(img.mimeType).toBe("image/jpeg");
    expect(Buffer.from(img.data, "base64").toString("hex")).toBe("ffd8ffe000104a46494600");
    const q = mock.requests.find((x) => x.path === "/projects/prj_test/media/m1/frame")!;
    expect(q.query.get("t")).toBe("1.5");
    expect(q.query.get("w")).toBe("320");
    expect(q.headers.authorization).toBe("Bearer tok");
  });
});

describe("task events", () => {
  it("task_log and task_question post events and tell the agent to stop", async () => {
    await client.callTool({ name: "task_log", arguments: { text: "reading transcript" } });
    // A label of three words is refused with what to send instead, not just "Invalid".
    const long = await client.callTool({ name: "task_log", arguments: { text: "On the second section.", activity: "Cutting section two" } }) as CallToolResult;
    expect(long.isError).toBe(true);
    expect(textOf(long)).toContain("Give the activity in one or two words");
    const q = (await client.callTool({ name: "task_question", arguments: { text: "Keep the intro?" } })) as CallToolResult;
    expect(textOf(q)).toContain("Stop now");
    expect(mock.state.events.map((e) => [e.type, e.text])).toEqual([
      ["log", "reading transcript"],
      ["question", "Keep the intro?"],
    ]);
  });
  it("posts plain progress text with explicit per-edit references", async () => {
    const edits = [{ phrase: "leveled the dialogue", changeId: "chg_sound", spot: 1 }];
    await client.callTool({ name: "task_log", arguments: { text: "I leveled the dialogue in the interview.", edits } });
    expect(mock.state.events.at(-1)).toMatchObject({ text: "I leveled the dialogue in the interview.", data: { kind: "editor_progress", edits } });
  });
  it("task_log says why an update didn't reach the editor, and only a session without a task hears it has none", async () => {
    mock.state.extra = (req, res) => {
      if (req.path !== "/projects/prj_test/tasks/task_1/events") return false;
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "internal", message: "database is locked" } }));
      return true;
    };
    // The failed post is noted on stderr too.
    vi.mocked(console.error).mockImplementation(() => {});
    try {
      const lost = await client.callTool({ name: "task_log", arguments: { text: "reading transcript" } }) as CallToolResult;
      expect(textOf(lost)).toContain("Scarlet server error 500 (internal): database is locked");
      expect(textOf(lost)).toContain("didn't reach the editor");
      expect(textOf(lost)).not.toContain("Not running as a Scarlet task");
      // The request goes on without the update, so this is not a tool error.
      expect(lost.isError).toBeFalsy();
      expect(mock.state.events).toHaveLength(0);
    } finally {
      mock.state.extra = undefined;
    }
    const alone = await connect(undefined);
    try {
      const unposted = await alone.callTool({ name: "task_log", arguments: { text: "reading transcript" } }) as CallToolResult;
      expect(textOf(unposted)).toBe("Not running as a Scarlet task; message not posted.");
    } finally { await alone.close(); }
  });
  it("task_question without a task tells the agent to assume and continue", async () => {
    const c = await connect(undefined);
    const q = (await c.callTool({ name: "task_question", arguments: { text: "?" } })) as CallToolResult;
    expect(textOf(q)).toContain("nobody can answer");
    await c.close();
  });
  it.each([503, 200])("returns a tool error without a valid question acknowledgement (HTTP %i)", async status => {
    mock.state.extra = (req, res) => {
      if (req.path !== "/projects/prj_test/tasks/task_1/question") return false;
      res.writeHead(status, { "content-type": "application/json" }).end("{}");
      return true;
    };
    try {
      const q = await client.callTool({ name: "task_question", arguments: { text: "Keep the intro?" } });
      expect(q.isError).toBe(true);
      expect(mock.state.events).toHaveLength(0);
    } finally {
      mock.state.extra = undefined;
    }
  });
});

describe("skills_list and misc", () => {
  it("offers skill saving only in the assigned authoring session and fixes the destination", async () => {
    const task = Task.parse({ id: "tsk_skill", projectId: "prj_test", kind: "skill_from_change", agent: "claude", state: "claimed",
      instruction: "Learn this edit", context: { changeId: "chg_approved", version: "v_kept", skillName: "short-intro" }, hostId: "host_a", createdBy: { type: "human", name: "Editor" } });
    await expect(connect(task.id, undefined, { ...task, projectId: "other" })).rejects.toThrow("different project");
    for (const mismatched of [{ ...task, kind: "edit" as const }, { ...task, state: "cancelled" as const }]) {
      const session = await connect(task.id, undefined, mismatched);
      try {
        expect((await session.listTools()).tools.map((tool) => tool.name)).not.toContain("skill_save_from_change");
      } finally { await session.close(); }
    }
    const session = await connect(task.id, undefined, task);
    const endpoint = `/projects/prj_test/tasks/${task.id}/skill`;
    let state = "approved";
    mock.state.extra = (req, res) => {
      if (req.path.endsWith("/timeline")) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ timeline: { ...emptyTimeline("prj_test"), version: req.query.get("version") } }));
        return true;
      }
      if (req.path.endsWith("/changes/chg_approved")) {
        const change = { id: "chg_approved", projectId: "prj_test", description: "Includes a rejected suggestion", state, fromVersion: "v_base", toVersion: "v_proposed", appliedOnto: "v_rebased", appliedVersion: "v_kept",
          approvedSpots: [1], timelineEdits: [{ label: "rejected suggestion" }] };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ change }));
        return true;
      }
      if (req.path.endsWith("/versions/v_rebased/diff/v_kept")) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ description: ["Changed the approved clip"] }));
        return true;
      }
      if (req.path !== endpoint) return false;
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ skill: { id: "skl_created", name: "short-intro", scope: "team" } }));
      return true;
    };
    try {
      const tools = (await session.listTools()).tools;
      expect(tools.map(t => t.name).sort()).toEqual(["change_get", "skill_save_from_change", "task_log", "task_question", "timeline_get"]);
      for (const [name, args] of [["change_get", { changeId: "other" }], ["timeline_get", { version: "head" }]] as const) {
        expect((await session.callTool({ name, arguments: args })).isError).toBe(true);
      }
      expect(mock.requests).toHaveLength(0);
      const evidence = await session.callTool({ name: "change_get", arguments: { changeId: "chg_approved" } }) as CallToolResult;
      expect(JSON.parse(textOf(evidence))).toMatchObject({ change: { appliedVersion: "v_kept", approvedSpots: [1] } });
      expect(textOf(evidence)).not.toContain("rejected suggestion");
      expect(JSON.parse(textOf(evidence)).diff).toEqual(["Changed the approved clip"]);
      const timeline = await session.callTool({ name: "timeline_get", arguments: { format: "full" } }) as CallToolResult;
      expect(JSON.parse(textOf(timeline)).version).toBe("v_kept");
      state = "rejected";
      expect((await session.callTool({ name: "timeline_get", arguments: {} })).isError).toBe(true);
      expect((await session.callTool({ name: "change_get", arguments: { changeId: "chg_approved" } })).isError).toBe(true);
      state = "approved";
      const tool = tools.find((t) => t.name === "skill_save_from_change");
      expect(Object.keys(tool!.inputSchema.properties ?? {}).sort()).toEqual(["description", "instructions"]);
      const draft = { description: "Keep the opening concise", instructions: "Start with the first complete sentence." };
      const result = await session.callTool({ name: "skill_save_from_change", arguments: draft });
      expect(result.isError).toBeFalsy();
      expect(mock.requests.at(-1)).toMatchObject({ method: "POST", path: endpoint, body: { ...draft, hostId: "host_a", changeId: "chg_approved" } });
    } finally {
      mock.state.extra = undefined;
      await session.close();
    }
  });

  it("gives a request to revise a skill only the tools for that, and saves to the skill the editor chose", async () => {
    const task = Task.parse({ id: "tsk_edit", projectId: "prj_test", kind: "skill_edit", agent: "claude", state: "running",
      instruction: "Never cut laughter.", context: { skillId: "skl_house" }, hostId: "host_a", createdBy: { type: "human", name: "Editor" } });
    const ended = await connect(task.id, undefined, { ...task, state: "done" });
    try {
      expect((await ended.listTools()).tools.map(tool => tool.name).sort()).toEqual(["skills_list", "task_log", "task_question"]);
    } finally { await ended.close(); }
    const editing = await connect("tsk_other", undefined, { ...task, kind: "edit" });
    try {
      expect((await editing.listTools()).tools.map(tool => tool.name)).not.toContain("skill_save_edit");
    } finally { await editing.close(); }
    const session = await connect(task.id, undefined, task);
    const endpoint = `/projects/prj_test/tasks/${task.id}/skill-edit`;
    mock.state.extra = (req, res) => {
      if (req.path !== endpoint) return false;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ skill: { id: "skl_house", name: "house-style", version: 3 } }));
      return true;
    };
    try {
      const tools = (await session.listTools()).tools;
      expect(tools.map(tool => tool.name).sort()).toEqual(["skill_save_edit", "skills_list", "task_log", "task_question"]);
      expect(Object.keys(tools.find(t => t.name === "skill_save_edit")!.inputSchema.properties ?? {}).sort()).toEqual(["description", "instructions"]);
      const draft = { description: "House rules", instructions: "Never cut laughter." };
      const result = await session.callTool({ name: "skill_save_edit", arguments: draft });
      expect(result.isError).toBeFalsy();
      expect(mock.requests.at(-1)).toMatchObject({ method: "POST", path: endpoint, body: { ...draft, hostId: "host_a", skillId: "skl_house" } });
    } finally {
      mock.state.extra = undefined;
      await session.close();
    }
    // A rule approved in Learnings is saved with no one to answer: what the save can't settle goes back beside the rule.
    const rule = await connect("tsk_rule", undefined, { ...task, id: "tsk_rule", context: { skillId: "skl_house", learningId: "lrn_1" } });
    try {
      expect((await rule.listTools()).tools.map(tool => tool.name).sort()).toEqual(["skill_save_edit", "skills_list", "task_log"]);
    } finally { await rule.close(); }
  });

  it("gives the check that reads a request only the skills and the rule to offer, and no other run that tool", async () => {
    const task = Task.parse({ id: "tsk_check", projectId: "prj_test", kind: "learning_check", agent: "claude", state: "running",
      instruction: "Keep the breath before the punchline.", context: { checksTaskId: "tsk_asked" }, hostId: "host_a", createdBy: { type: "human", name: "Editor" } });
    // The run that edits doesn't offer rules as well, and neither does a skill's revision.
    for (const kind of ["edit", "revise", "skill_edit"] as const) {
      const other = await connect("tsk_other", undefined, { ...task, id: "tsk_other", kind });
      try {
        expect((await other.listTools()).tools.map(tool => tool.name)).not.toContain("learning_suggest");
      } finally { await other.close(); }
    }
    const session = await connect(task.id, undefined, task);
    const endpoint = `/projects/prj_test/tasks/${task.id}/learnings`;
    mock.state.extra = (req, res) => {
      if (req.path !== endpoint) return false;
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ learning: { id: "lrn_1", state: "suggested" }, skill: { id: "skl_house", name: "house-style" } }));
      return true;
    };
    try {
      const tools = (await session.listTools()).tools;
      expect(tools.map(t => t.name).sort()).toEqual(["learning_suggest", "skills_list"]);
      const tool = tools.find(t => t.name === "learning_suggest")!;
      expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(["replaces", "rule", "skill"]);
      // It only adds to a list the editor reviews, with what the skill says that the rule would replace.
      expect(tool.description).toContain("nothing in the skill changes unless they approve it");
      expect(tool.description).toContain("quote each passage of that skill the rule contradicts or overrides, word for word");
      const offer = { rule: "Leave the breath before a punchline.", skill: "house-style" };
      const result = await session.callTool({ name: "learning_suggest", arguments: offer }) as CallToolResult;
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(textOf(result))).toEqual({ learningId: "lrn_1", skill: "house-style", state: "suggested" });
      expect(mock.requests.at(-1)).toMatchObject({ method: "POST", path: endpoint, body: offer });
      expect(mock.requests.at(-1)!.body).not.toHaveProperty("replaces");
      const replacing = { ...offer, replaces: ["Cut a breath short."] };
      expect((await session.callTool({ name: "learning_suggest", arguments: replacing }) as CallToolResult).isError).toBeFalsy();
      expect(mock.requests.at(-1)).toMatchObject({ method: "POST", path: endpoint, body: replacing });
      // A rule is one sentence on one line.
      expect((await session.callTool({ name: "learning_suggest", arguments: { rule: "Two\nlines", skill: "house-style" } })).isError).toBe(true);
    } finally {
      mock.state.extra = undefined;
      await session.close();
    }
  });

  it("offers every enabled skill, including skills with legacy agent metadata", async () => {
    mock.state.skills = [
      { id: "s1", name: "first-cut-dialogue", description: "First cut", content: "---\nname: x\n---\n# body", scope: "team", ownerId: null, projectId: null, agents: [], enabled: true, version: 1 },
      { id: "s2", name: "codex-only", description: "only codex", content: "x", scope: "team", ownerId: null, projectId: null, agents: ["codex"], enabled: true, version: 1 },
      { id: "s3", name: "off", description: "disabled", content: "x", scope: "team", ownerId: null, projectId: null, agents: [], enabled: false, version: 1 },
    ];
    const r = (await client.callTool({ name: "skills_list", arguments: {} })) as CallToolResult;
    const t = textOf(r);
    expect(t).toContain("first-cut-dialogue");
    const content = await client.callTool({ name: "skills_list", arguments: { skillId: "s1" } }) as CallToolResult;
    expect(textOf(content)).toContain("# body");
    const named = await client.callTool({ name: "skills_list", arguments: { skillId: "first-cut-dialogue" } }) as CallToolResult;
    expect(textOf(named)).toEqual(textOf(content));
    expect((await client.callTool({ name: "skills_list", arguments: { skillId: "off" } })).isError).toBe(true);
    expect(textOf(await client.callTool({ name: "skills_list", arguments: { skillId: "s2" } }) as CallToolResult)).toBe("x");
    expect(t).toContain("codex-only");
    expect(t).not.toContain("disabled");
  });
  it("render_request/render_status and change_list work", async () => {
    const implicit = await client.callTool({ name: "render_request", arguments: {} });
    expect(implicit.isError).toBe(true);
    expect(mock.requests).toHaveLength(0);
    const r = (await client.callTool({ name: "render_request", arguments: { kind: "preview", range: { start: 0, end: 2 } } })) as CallToolResult;
    expect(JSON.parse(textOf(r))).toMatchObject({ id: "rnd_1", state: "queued" });
    const s = (await client.callTool({ name: "render_status", arguments: { renderId: "rnd_1" } })) as CallToolResult;
    expect(JSON.parse(textOf(s))).toMatchObject({ state: "done", progress: 1 });
    const l = (await client.callTool({ name: "change_list", arguments: {} })) as CallToolResult;
    expect(textOf(l)).toMatch(/chg_1 \[proposed\] none→v\d+ claude:/);
  });
  it("server errors come back as readable tool errors", async () => {
    const r = (await client.callTool({ name: "change_get", arguments: { changeId: "nope" } })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Scarlet server error 404");
  });
});

describe("buildSystemPrompt", () => {
  it("includes intro, task, context, notes, change, Q&A and skills", () => {
    const tl = emptyTimeline("prj_test");
    tl.tracks[0]!.clips.push(makeMediaClip("m1", 0, 10, 0, { id: "c1", label: "intro" }));
    const prompt = buildSystemPrompt({
      project: { project: mock.state.project, timeline: tl },
      task: { kind: "note", instruction: "Too long a pause at 1:17", agent: "claude", context: { time: 77, clipIds: ["c1"], noteIds: ["n1"] } },
      notes: [
        { id: "n1", projectId: "prj_test", version: "v1", time: 77, clipIds: ["c1"], text: "Too long a pause here", author: { type: "human", name: "Matt" }, state: "open" },
      ],
      change: {
        change: { id: "chg_9", projectId: "prj_test", fromVersion: "v1", toVersion: "v2", description: "Cut pause", author: { type: "agent", name: "claude" }, noteIds: [], ranges: [{ start: 70, end: 80 }], state: "revising", renders: [] },
        description: ["Changed sourceOut on intro at 0.00"],
      },
      qa: [{ question: "Keep the intro?", answer: "Yes" }],
      skills: [{ id: "s1", name: "first-cut-dialogue", description: "First cut", content: "---\nname: first-cut-dialogue\n---\n# First cut\n\nDo it.", scope: "team", ownerId: null, projectId: null, agents: [], enabled: true, version: 1 }],
      workDir: "C:/work/task_1",
      timeLimitMinutes: 45,
      capabilities: { images: true, audio: false, files: true, plan: false },
    });
    expect(prompt).toContain("Time limit: this run stops after 45 minutes.");
    expect(prompt).toContain("Save as you go.");
    expect(buildSystemPrompt({ project: { project: mock.state.project, timeline: tl }, task: { kind: "edit", instruction: "Trim", agent: "codex", context: {} }, skills: [] }))
      .not.toContain("Time limit");
    expect(prompt).toContain("# You are editing a video in Scarlet");
    expect(prompt).toContain("Too long a pause at 1:17");
    expect(prompt).toContain("1:17.00");
    expect(prompt).toContain("Clip ids under the playhead: c1");
    expect(prompt).toContain("Note n1 [open] by Matt");
    expect(prompt).toContain("Change chg_9 [revising]");
    expect(prompt).toContain("Changed sourceOut on intro");
    expect(prompt).toContain('The editor answered: "Yes"');
    expect(prompt).toContain("# Your skills");
    expect(prompt).toContain("## first-cut-dialogue");
    expect(prompt).toContain("Do it.");
    expect(prompt).not.toContain("name: first-cut-dialogue\n---");
    expect(prompt).toContain("C:/work/task_1");
  });
});

it("scans consecutive source pages for first-cut evidence without proposing an edit", async () => {
  const extra = mock.state.extra;
  mock.state.extra = (req, res) => {
    if (!req.path.endsWith("/dialogue-detections")) return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ segments: transcript.segments, acoustic: [{ start: 2.48, end: 2.68, confidence: 0.93 }] }));
    return true;
  };
  const original = mock.state.waveform;
  mock.state.waveform = (mediaId, from, to, points) => ({
    mediaId, from, to, peaks: Array(points).fill(0.001), rms: Array(points).fill(0.001),
    speechActivity: [{ start: 1.1, end: 1.8 }, { start: 1.95, end: 2.35 }],
  });
  try {
    const scan = async (from: number, until = 69) => {
      const r = await client.callTool({ name: "dialogue_scan", arguments: { mediaId: "m1", from, until } });
      expect(r.isError).toBeFalsy();
      return JSON.parse(textOf(r).trim());
    };
    const first = await scan(0);
    expect(first.passages[0].text).toContain("welcome back. Um, welcome back");
    expect(first.repeatedTakes).toMatchObject([{ phrase: "welcome back", first: { start: 1.1 }, next: { start: 3.6, continuation: "to the show." } }]);
    expect(first.fillers).toMatchObject([{ text: "Um,", start: 2.5, end: 2.7 }]);
    expect(first.fillerCandidates).toMatchObject([{ start: 2.48, end: 2.68, whisper: { text: "Um," }, uhm: { confidence: 0.93 } }]);
    expect(first.detectors).toEqual(["prompted-whisper", "uhm"]);
    expect(first.unmatchedVoice).toEqual([{ start: 1.95, end: 2.35 }]);
    expect(await scan(119.5, 120.003)).toMatchObject({ from: 119.5, to: 120, nextFrom: null });
    expect(mock.state.events.filter(e => e.data?.scanPage).map(e => e.data?.scanPage)).toEqual([
      { mediaId: "m1", from: 0, end: 69 }, { mediaId: "m1", from: 0, to: 60, end: 69 },
      { mediaId: "m1", from: 119.5, end: 120 }, { mediaId: "m1", from: 119.5, to: 120, end: 120 },
    ]);
    expect(first.to).toBe(60);
    expect(first.nextFrom).toBe(58);
    expect(await scan(first.nextFrom)).toMatchObject({ from: 58, to: 69, nextFrom: null, passages: [] });
    expect(mock.requests.some(req => req.path.endsWith("/changes"))).toBe(false);
  } finally { mock.state.waveform = original; mock.state.extra = extra; }
});

it("delivers a quiet phrase whole when it crosses both the scan-page overlap and a level chunk", async () => {
  const original = { media: mock.state.project.media, transcripts: mock.state.transcripts, waveform: mock.state.waveform, extra: mock.state.extra };
  const editor = await connect();
  const words = [{ start: 294, end: 295, text: "First." }, { start: 297.5, end: 298.5, text: "turn" },
    { start: 298.5, end: 299.5, text: "it" }, { start: 299.5, end: 300.5, text: "over" }, { start: 302, end: 303, text: "Again." }];
  const segments = [{ id: "s", start: 294, end: 303, text: words.map(w => w.text).join(" "), words }];
  mock.state.project.media = original.media.map(m => m.id === "m1" ? { ...m, duration: 360 } : m);
  mock.state.transcripts = { m1: { id: "t1", mediaId: "m1", segments } };
  mock.state.waveform = (mediaId, from, to, points) => {
    const rms = Array.from({ length: points }, (_, i) => {
      const t = from + (i + .5) * (to - from) / points;
      return words.some(w => w.start <= t && t < w.end) ? (t > 296 && t < 301 ? .004 : .1) : .001;
    });
    return { mediaId, from, to, rms, peaks: rms };
  };
  mock.state.extra = (req, res) => {
    if (!req.path.endsWith("/dialogue-detections")) return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ segments, acoustic: [], speechActivity: words.map(({ start, end }) => ({ start, end })) }));
    return true;
  };
  const page = async (from: number) => {
    const r = await editor.callTool({ name: "dialogue_scan", arguments: { mediaId: "m1", from, until: 304 } }) as CallToolResult;
    expect(r.isError, textOf(r)).toBeFalsy();
    return JSON.parse(textOf(r));
  };
  try {
    const first = await page(240);
    expect(first).not.toHaveProperty("quietPhrases");
    const next = await page(first.nextFrom);
    expect(next.from).toBe(298);
    expect(next.quietPhrases).toEqual([{ fromWord: 1, toWord: 3, start: 297.5, end: 300.5, text: "turn it over",
      levelDbfs: -48, beforeDbfs: -20, afterDbfs: -20 }]);
  } finally {
    mock.state.project.media = original.media;
    mock.state.transcripts = original.transcripts;
    mock.state.waveform = original.waveform;
    mock.state.extra = original.extra;
    await editor.close();
  }
});

it("shows a repeated phrase measured from cached sound when the saved transcript omits it and transcription is off", async () => {
  const extra = mock.state.extra;
  const oldTimeline = mock.state.timeline;
  const tl = emptyTimeline(mock.state.project.id);
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 6, 0)];
  mock.state.timeline = tl;
  let cacheAvailable = false;
  let selectedStream: number | undefined;
  const requests: unknown[] = [];
  mock.state.extra = (req, res) => {
    if (req.path === "/projects/prj_test/media" && selectedStream !== undefined) {
      const media = mock.state.project.media.map(asset => ({ ...asset, audioStream: selectedStream }));
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ media }));
      return true;
    }
    if (req.path.endsWith("/dialogue-detections")) {
      res.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "transcription_unavailable" }));
      return true;
    }
    if (!req.path.endsWith("/dialogue-acoustic-words")) return false;
    requests.push(req.body);
    const words = ["two", "more", "cups", "two", "more", "cups", "arrived"]
      .map((text, i) => ({ text, start: 1 + i * 0.4, end: 1.2 + i * 0.4 }));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(cacheAvailable ? [words] : []));
    return true;
  };
  const reader = await connect();
  try {
    const check = async (args: object) => JSON.parse(textOf(await reader.callTool({ name: "dialogue_check_join", arguments: { version: "head", ...args } })));
    const first = { start: .95, end: 2.15 }, second = { start: 2.15, end: 3.38 };
    const before = await check(first);
    expect(before.acousticRetakeContinuity).toBeUndefined();
    const scan = async () => JSON.parse(textOf(await reader.callTool({ name: "dialogue_scan", arguments: { mediaId: "m1", until: 6 } })));
    expect((await scan()).acousticRepeatedTakes).toBeUndefined();
    cacheAvailable = true;
    const page = await scan();
    expect(page.acousticRepeatedTakes).toMatchObject([{ phrase: "two more cups", first: { start: 1 }, next: { start: 2.2, continuation: "arrived" } }]);
    expect(page.repeatedTakes.some((cue: { phrase: string }) => cue.phrase === "two more cups")).toBe(false);
    const { acousticRetakeContinuity, ...sameCheck } = await check(first);
    expect(sameCheck).toEqual(before);
    expect(acousticRetakeContinuity).toMatchObject([{ removedOccurrence: "first", retainedOccurrence: "second", followingWord: { text: "arrived" }, followingWordConnection: "uninterrupted original delivery" }]);
    const { joins } = await check({ cuts: [second, { start: .95, end: 3.38 }] });
    expect(joins[0].acousticRetakeContinuity).toMatchObject([{ removedOccurrence: "second", retainedOccurrence: "first", followingWordConnection: "across the proposed join" }]);
    expect(joins[1].acousticRetakeContinuity).toBeUndefined();
    expect(requests).toEqual(Array(2).fill({ mediaId: "m1", from: 0, to: 6 }));
    Object.assign(tl.tracks[0]!.clips[0]!, { audioStream: 0 });
    expect((await check(first)).acousticRetakeContinuity).toBeUndefined();
    selectedStream = 0;
    await scan();
    expect(requests.at(-1)).toEqual({ mediaId: "m1", audioStream: 0, from: 0, to: 6 });
    expect((await check(first)).acousticRetakeContinuity).toMatchObject([{ audioStream: 0, retainedOccurrence: "second" }]);
  } finally { await reader.close(); mock.state.extra = extra; mock.state.timeline = oldTimeline; }
});

it("stops requesting dialogue analysis after repeated failures while the transcript is still being made", async () => {
  const extra = mock.state.extra;
  let transcriptReady = false;
  mock.state.extra = (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.path.endsWith("/dialogue-detections")) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { code: "internal", message: "fetch failed (UND_ERR_HEADERS_TIMEOUT)" } }));
    } else if (req.path.endsWith("/media/m1/prepare")) {
      res.end(JSON.stringify(transcriptReady ? { state: "ready" } : { state: "processing", taskId: "tsk_transcribe" }));
    } else if (req.path.endsWith("/tasks/tsk_transcribe")) {
      res.end(JSON.stringify({ task: { id: "tsk_transcribe", projectId: "prj_test", kind: "transcribe", agent: "api", instruction: "Transcribe",
        state: transcriptReady ? "done" : "running", createdBy: { type: "scarlet", name: "Scarlet" }, progress: { stage: "aligning", fraction: 0.33, remainingSeconds: 2220 } }, events: [] }));
    } else return false;
    return true;
  };
  const editor = await connect("task_dialogue_cap");
  const detections = () => mock.requests.filter(r => r.path.endsWith("/dialogue-detections")).length;
  const scan = async () => textOf(await editor.callTool({ name: "dialogue_scan", arguments: { mediaId: "m1", from: 0, until: 6 } }));
  try {
    // Each failure still returns the page with what Scarlet could measure.
    for (let i = 0; i < 2; i++) expect(JSON.parse(await scan()).detectorIssue).toContain("UND_ERR_HEADERS_TIMEOUT");
    expect(detections()).toBe(2);
    const blocked = await scan();
    expect(blocked).toContain("failed 2 times in a row");
    expect(blocked).toContain("aligning words, 33% done, about 37 min left");
    expect(blocked).toContain("end your run");
    expect(detections()).toBe(2);
    // The run is now waiting on the transcript, so Scarlet can tell if it ends without it.
    await expect.poll(() => mock.state.events.filter(e => e.data?.kind === "media_wait").map(e => e.data)).toEqual([{ kind: "media_wait", wait: "transcript", mediaId: "m1" }]);
    // Once the transcript is saved, the next page asks again.
    transcriptReady = true;
    await expect.poll(() => mock.state.events.some(e => e.data?.kind === "media_wait" && e.data.done && !e.data.failed), { timeout: 5000 }).toBe(true);
    expect(JSON.parse(await scan()).detectorIssue).toContain("UND_ERR_HEADERS_TIMEOUT");
    expect(detections()).toBe(3);
  } finally { mock.state.extra = extra; await editor.close(); }
});

it("reminds the agent to save its decided passages after five minutes of reading", async () => {
  const extra = mock.state.extra;
  mock.state.extra = (req, res) => {
    if (!req.path.endsWith("/dialogue-detections")) return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ segments: transcript.segments, acoustic: [] }));
    return true;
  };
  const media = mock.state.project.media[0]!;
  const duration = media.duration;
  media.duration = 900;
  try {
    const reminders: Array<string | undefined> = [];
    let from: number | null = 0;
    while (from !== null && from < 400) {
      const page = JSON.parse(textOf(await client.callTool({ name: "dialogue_scan", arguments: { mediaId: "m1", from } })));
      reminders.push(page.saveReminder);
      from = page.nextFrom;
    }
    // Pages end at 60, 118, 176, 234 and 292 s without a reminder; 350 s is past five minutes.
    expect(reminders.slice(0, 5)).toEqual(Array(5).fill(undefined));
    expect(reminders[5]).toMatch(/^You have read 6 minutes since your last save\./);
    expect(reminders[6]).toMatch(/^You have read 7 minutes/);
  } finally { media.duration = duration; mock.state.extra = extra; }
});

describe("first-cut dialogue save checkpoints", () => {
  let editor: Client;
  let restore: () => void;
  let cached: { start: number; end: number }[];
  let rejectSave: boolean;

  beforeEach(async () => {
    const original = { timeline: mock.state.timeline, extra: mock.state.extra, waveform: mock.state.waveform };
    const media = mock.state.project.media[0]!;
    const duration = media.duration, head = mock.state.project.head;
    restore = () => {
      Object.assign(mock.state, original);
      media.duration = duration;
      mock.state.project.head = head;
    };
    media.duration = 300;
    const tl = emptyTimeline(mock.state.project.id);
    tl.version = "first-section";
    tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 300, 0), makeMediaClip("m2", 0, 120, 300)];
    mock.state.timeline = tl;
    mock.state.project.head = tl.version;
    mock.state.waveform = (mediaId, from, to, points) => ({ mediaId, from, to, peaks: Array(points).fill(0.001), rms: Array(points).fill(0.001) });
    cached = [];
    rejectSave = false;
    mock.state.extra = (req, res) => {
      let result;
      if (req.path.endsWith("/dialogue-scan")) result = cached;
      else if (req.path.endsWith("/dialogue-detections")) result = { segments: [], acoustic: [] };
      else if (req.path.endsWith("/dialogue-cuts")) {
        if (rejectSave) {
          res.statusCode = 409;
          result = { error: { code: "cut_changed", message: "The edit changed before saving." } };
        } else {
          const fromVersion = mock.state.timeline!.version;
          const toVersion = fromVersion + "-saved";
          mock.state.project.head = toVersion;
          mock.state.timeline = { ...mock.state.timeline!, version: toVersion, parent: fromVersion };
          result = { head: toVersion, changes: [{ id: toVersion, description: "Removed the pause.", intent: "requested", state: "approved", fromVersion, toVersion }] };
        }
      } else return false;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
      return true;
    };
    const task = Task.parse({ id: "save-in-parts", projectId: tl.projectId, kind: "edit", agent: "claude", state: "running",
      instruction: "/first-cut-dialogue", context: { dialogueOperation: "first-cut" }, createdBy: { type: "human", name: "Editor" } });
    editor = await connect(task.id, undefined, task);
  });
  afterEach(async () => { restore(); await editor.close(); });

  const scan = (from: number, noCutsReadyThrough?: number) =>
    editor.callTool({ name: "dialogue_scan", arguments: { mediaId: "m1", from, noCutsReadyThrough } });
  const save = (start: number) => editor.callTool({ name: "dialogue_apply_cuts", arguments: {
    version: mock.state.project.head, description: "Remove the pause.",
    cuts: [{ start, end: start + 1, kind: "pause", decision: "cut", reason: "Dead air." }],
  } });

  it("allows rereads but requires a successful save from this section before exposing more footage", async () => {
    expect(JSON.parse(textOf(await scan(0)))).toMatchObject({ nextFrom: 58 });
    expect(JSON.parse(textOf(await scan(58)))).toMatchObject({ nextFrom: 116, saveCheckpoint: { through: 118 } });
    expect(JSON.parse(textOf(await scan(58)))).toMatchObject({ from: 58, to: 118 });
    for (const from of [116, 240]) {
      const blocked = await scan(from);
      expect(blocked.isError).toBe(true);
      expect(textOf(blocked)).toContain("dialogue_apply_cuts");
      expect(textOf(blocked)).toContain("noCutsReadyThrough");
    }
    rejectSave = true;
    const failed = await save(24);
    expect(failed.isError, textOf(failed)).toBe(true);
    expect((await scan(116)).isError).toBe(true);
    rejectSave = false;
    // Saving an edit to another recording can't release this recording's checkpoint.
    const elsewhere = await save(325);
    expect(JSON.parse(textOf(elsewhere))).toMatchObject({ changes: [{ state: "approved" }] });
    expect((await scan(116)).isError).toBe(true);
    // A decision later in the same source is also outside the section the editor is waiting for.
    const later = await save(185);
    expect(JSON.parse(textOf(later))).toMatchObject({ changes: [{ state: "approved" }] });
    expect((await scan(116)).isError).toBe(true);
    const saved = await save(24);
    expect(JSON.parse(textOf(saved))).toMatchObject({ changes: [{ state: "approved" }] });
    expect(JSON.parse(textOf(await scan(116)))).toMatchObject({ from: 116, to: 176 });
  });

  it("bounds replay of cached analysis and permits another section when no cut is ready", async () => {
    cached = [0, 58, 116, 174, 232].map(start => ({ start, end: start + 60 }));
    const first = JSON.parse(textOf(await scan(0)));
    expect(first).toMatchObject({ nextFrom: 116, restoredPages: [{ from: 58 }], saveCheckpoint: { through: 118 } });
    expect((await scan(116)).isError).toBe(true);
    expect((await scan(116, 60)).isError).toBe(true);
    const next = JSON.parse(textOf(await scan(116, first.saveCheckpoint.through)));
    expect(next).toMatchObject({ from: 116, nextFrom: 232, restoredPages: [{ from: 174 }], saveCheckpoint: { through: 234 } });
    expect((await scan(232, 118)).isError).toBe(true);
    expect(mock.requests.some(r => r.path.endsWith("/dialogue-cuts"))).toBe(false);
  });

  it("shares the two-page checkpoint across parallel scans of one recording", async () => {
    const reads = await Promise.all([0, 58, 116].map(from => scan(from)));
    const blocked = reads.filter(result => result.isError);
    expect(blocked).toHaveLength(1);
    expect(textOf(blocked[0]!)).toContain("noCutsReadyThrough");
    const pages = reads.filter(result => !result.isError).map(result => JSON.parse(textOf(result)));
    expect(pages.filter(page => page.saveCheckpoint)).toHaveLength(1);
    expect(mock.requests.filter(req => req.path.endsWith("/dialogue-detections"))).toHaveLength(2);
  });

  it("limits actionable decisions from a first cut that only read the transcript, before writing anything", async () => {
    const transcriptOnly = await editor.callTool({ name: "transcript_get", arguments: { mediaId: "m1" } });
    expect(transcriptOnly.isError, textOf(transcriptOnly)).toBeFalsy();
    const cuts = Array.from({ length: 13 }, (_, i) => ({
      start: 10 + 2 * i, end: 11 + 2 * i, kind: "pause", decision: i % 2 ? "review" : "cut", reason: "Tighten this beat.",
    }));
    const apply = (session: Client, decisions: typeof cuts) => session.callTool({ name: "dialogue_apply_cuts",
      arguments: { version: mock.state.project.head, description: "Tighten the pauses.", cuts: decisions } });
    const oversized = await apply(editor, cuts);
    expect(oversized.isError).toBe(true);
    expect(textOf(oversized)).toContain("12");
    expect(textOf(oversized)).toContain("continueFrom");
    expect(textOf(oversized)).toMatch(/word/i);
    expect(mock.requests.some(req => req.path.endsWith("/dialogue-cuts"))).toBe(false);
    // The editor can protect footage alongside a full batch of actionable cut and review decisions.
    const kept = cuts.map((c, i) => i === 12 ? { ...c, decision: "keep" } : c);
    expect(JSON.parse(textOf(await apply(editor, kept)))).toMatchObject({ changes: [{ state: "approved" }] });
    const generic = await connect("ordinary-edit");
    try {
      expect(JSON.parse(textOf(await apply(generic, cuts)))).toMatchObject({ changes: [{ state: "approved" }] });
    } finally { await generic.close(); }
  });
});

it.each(["first cut", "ordinary edit", "closed review", "superseded review", "partly assessed review", "fully assessed review"])("surfaces staged-only cuts while the agent reads on during a %s", async mode => {
  const original = { extra: mock.state.extra, timeline: mock.state.timeline };
  const task = Task.parse({ id: "staged_review", projectId: mock.state.project.id, kind: "edit", state: "running", agent: "claude",
    instruction: mode === "ordinary edit" ? "Edit this" : "/first-cut-dialogue", context: { dialogueOperation: mode === "ordinary edit" ? "none" : "first-cut" },
    createdBy: { type: "human", name: "Editor" } });
  const editor = await connect(task.id, undefined, task);
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "staged";
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 6, 0)];
  mock.state.timeline = tl;
  const removed = [{ start: 1, end: 1.4 }, { start: 3, end: 3.3 }, { start: 4, end: 4.5 }];
  const carried = mode === "fully assessed review" ? removed.length : mode === "partly assessed review" ? 1 : 0;
  const assessed = new Set(removed.slice(0, carried).map((_, i) => i));
  let state = "ready", replacedBy: string | undefined;
  mock.state.extra = (req, res) => {
    let result;
    if (req.path.endsWith("/dialogue-detections")) result = { segments: transcript.segments, acoustic: [] };
    else if (req.path.endsWith("/dialogue-cuts")) result = { changes: [{ id: "pass1", projectId: "prj_test", intent: "suggestion", state: "ready",
      description: "Review 3 optional dialogue cuts", fromVersion: "staged", toVersion: "staged-review" }] };
    else if (req.path === "/projects/prj_test/changes/pass1") result = { change: { id: "pass1", projectId: "prj_test", intent: "suggestion",
      state, replacedBy, fromVersion: "staged", toVersion: "staged-review",
      cutAssessments: [...assessed].map(index => ({ index, ...removed[index], verdict: "ask", reason: "Close call." })) } };
    else if (req.path.endsWith("/pass1/cut-review")) result = { review: { cuts: removed.map(range => ({ removed: range })) } };
    else if (req.path.endsWith("/pass1/cut-assessments")) {
      for (const { index } of (req.body as { assessments: { index: number }[] }).assessments) assessed.add(index);
      result = { total: 3, assessed: assessed.size, needsDecision: 3 - assessed.size };
    } else return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
    return true;
  };
  const scan = async () => JSON.parse(textOf(await editor.callTool({ name: "dialogue_scan", arguments: { mediaId: "m1", from: 0, until: 6 } })));
  const next = () => editor.callTool({ name: "dialogue_scan", arguments: { mediaId: "m1", from: 58 } });
  const save = (index: number, start: number, end: number) => editor.callTool({ name: "dialogue_review_save", arguments: {
    changeId: "pass1", fromVersion: "staged", toVersion: "staged-review", assessments: [{ index, start, end, verdict: "ask", reason: "Close call." }] } });
  try {
    // Nothing is staged yet, so there is nothing to remind.
    expect((await scan()).reviewReminder).toBeUndefined();
    const applied = await editor.callTool({ name: "dialogue_apply_cuts", arguments: { version: tl.version, description: "Part 1",
      cuts: [{ start: 1, end: 1.4, kind: "pause", decision: "review", reason: "Long pause." },
        { start: 3, end: 3.3, kind: "filler", decision: "review", reason: "An um." },
        { start: 4, end: 4.5, kind: "coaching", decision: "review", reason: "Off-mic note." }] } });
    expect(applied.isError).toBeFalsy();
    expect(JSON.parse(textOf(applied)).next).toContain("The editor sees a staged cut as a call only once it has your recommendation");
    const reminder = (await scan()).reviewReminder;
    if (mode === "fully assessed review") {
      expect(reminder).toBeUndefined();
      expect(JSON.parse(textOf(await next()))).toMatchObject({ from: 58 });
      return;
    }
    if (mode === "partly assessed review") expect(reminder).toMatch(/^2 cuts you staged on pass1 have no recommendation yet/);
    else expect(reminder).toMatch(/^3 cuts you staged on pass1 have no recommendation yet\. The editor sees a staged cut as a call only once it has one/);
    if (mode !== "ordinary edit") {
      const blocked = await next();
      expect(blocked.isError).toBe(true);
      expect(textOf(blocked)).toContain("dialogue_review_save");
    }
    if (mode === "closed review" || mode === "superseded review") {
      if (mode === "closed review") state = "rejected";
      else replacedBy = "pass2";
      expect(JSON.parse(textOf(await next()))).toMatchObject({ from: 58 });
      return;
    }
    if (mode === "ordinary edit") expect(JSON.parse(textOf(await next()))).toMatchObject({ from: 58 });
    expect((await save(0, 1, 1.4)).isError).toBeFalsy();
    if (mode === "partly assessed review") {
      // Rewriting a carried assessment still leaves both of this section's cuts without a recommendation.
      expect((await next()).isError).toBe(true);
      expect((await save(1, 3, 3.3)).isError).toBeFalsy();
      expect(JSON.parse(textOf(await next()))).toMatchObject({ from: 58 });
      return;
    }
    expect(JSON.parse(textOf(await next()))).toMatchObject({ from: 58 });
    expect((await scan()).reviewReminder).toMatch(/^2 cuts you staged on pass1 have no recommendation yet \(of 3\)\./);
    await save(1, 3, 3.3);
    await save(2, 4, 4.5);
    expect((await scan()).reviewReminder).toBeUndefined();
  } finally {
    await editor.close();
    mock.state.extra = original.extra;
    mock.state.timeline = original.timeline;
  }
});

it("starts the background scan at the original range and returns findings as more checkpoints become available", async () => {
  const original = mock.state.extra;
  const resumed = await connect("resumed");
  const reads: number[] = [];
  const saved = [{ start: 0, end: 60 }, { start: 116, end: 120 }];
  mock.state.extra = (req, res) => {
    if (req.path.endsWith("/dialogue-acoustic-words")) {
      const { from, to } = req.body as { from: number; to: number };
      const words = ["keep", "it", "keep", "it"].map((text, i) => ({ text, start: 114.9 + i * .4, end: 115.2 + i * .4 }));
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify([words.filter(w => w.start >= from && w.end <= to)]));
      return true;
    }
    if (!req.path.endsWith("/dialogue-scan") && !req.path.endsWith("/dialogue-detections")) return false;
    res.setHeader("Content-Type", "application/json");
    if (req.path.endsWith("/dialogue-scan")) {
      res.end(JSON.stringify(saved));
    } else {
      reads.push((req.body as { from: number }).from);
      res.end(JSON.stringify({ segments: transcript.segments, acoustic: [], speechActivity: [] }));
    }
    return true;
  };
  try {
    const scan = async (from: number) => JSON.parse(textOf(await resumed.callTool({ name: "dialogue_scan", arguments: { mediaId: "m1", from } })));
    const first = await scan(0);
    expect(first.nextFrom).toBe(58);
    expect(first.passages[0].text).toContain("welcome back");
    expect(mock.state.events.filter(e => e.taskId === "resumed").map(e => e.data?.scanPage)).toEqual([
      { mediaId: "m1", from: 0, end: 120 }, { mediaId: "m1", from: 0, to: 60, end: 120 },
      { mediaId: "m1", from: 116, to: 120, end: 120 },
    ]);
    saved.push({ start: 58, end: 118 });
    expect(await scan(first.nextFrom)).toMatchObject({ from: 58, to: 118, nextFrom: null, restoredPages: [{ from: 116, to: 120, acousticRepeatedTakes: [{ phrase: "keep it", first: { start: 114.9 } }] }] });
    expect(mock.requests.filter(r => r.path.endsWith("/dialogue-scan")).map(r => r.body)).toEqual(
      Array(2).fill({ mediaId: "m1", from: 0, to: 120, taskId: "resumed", startedAt: "2026-04-01T12:00:00.000Z" }));
    expect(reads).toEqual([0, 58, 116]);
  } finally {
    await resumed.close();
    mock.state.extra = original;
  }
});

it("returns every window of a batch in one result, replays it, and keeps failures local to one window", async () => {
  const original = mock.state.extra;
  const editor = await connect("batch-test");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requests: number[] = [];
  let answered = 0;
  mock.state.extra = async (req, res) => {
    if (!req.path.endsWith("/contact-sheet")) return false;
    const { from, to } = req.body as { from: number; to: number };
    requests.push(from);
    if (from === 0) await gate;
    res.setHeader("Content-Type", "application/json");
    if (from === 2) { res.statusCode = 400; res.end(JSON.stringify({ error: { code: "outside_media", message: "Outside the source." } })); }
    else res.end(JSON.stringify({ state: "ready", windows: [{ id: "m1", clock: "source", range: { start: from, end: to },
      timestamps: [from], columns: 1, jpeg: "eA==" }] }));
    // The held window is let go a moment after the other two have answered, however slow the machine is.
    if (from !== 0 && ++answered === 2) setTimeout(release, 30);
    return true;
  };
  try {
    const call = async (args: Record<string, unknown>) => {
      const r = await editor.callTool({ name: "frame_contact_sheet_batch", arguments: args }) as CallToolResult;
      expect(r.isError).toBeFalsy();
      return { header: JSON.parse((r.content[0] as { text: string }).text), content: r.content };
    };
    // The slow window finishes while the call waits, so one result carries all three.
    const first = await call({ windows: [0, 1, 2].map(from => ({ mediaId: "m1", from, to: from + 1 })) });
    expect(first.header).toMatchObject({ total: 3, nextCursor: null });
    const labels = first.content.filter(item => item.type === "text" && item.text.startsWith("{\"index\"")).map(item => JSON.parse((item as { text: string }).text));
    // The two quick windows land in either order. The held one is last.
    expect(labels.slice(0, 2).map(l => l.index).sort()).toEqual([1, 2]);
    expect(labels[2].index).toBe(0);
    expect(labels.find(l => l.index === 2).error).toContain("Outside the source");
    expect(first.content.filter(item => item.type === "image")).toHaveLength(2);
    expect((await call({ batchId: first.header.batchId, cursor: 0 })).content).toEqual(first.content);
    expect(requests.sort()).toEqual([0, 1, 2]);
  } finally { release(); await editor.close(); mock.state.extra = original; }
});

it("reports distinct prepared picture passages and confirmed review saves during a scan", async () => {
  const original = mock.state.extra;
  const editor = await connect("milestones");
  mock.state.extra = (req, res) => {
    let result;
    if (req.path.endsWith("/dialogue-scan")) result = [];
    else if (req.path.endsWith("/dialogue-detections")) result = { segments: [], acoustic: [], speechActivity: [] };
    else if (req.path.endsWith("/contact-sheet")) {
      const { from, to } = req.body as { from: number; to: number };
      result = { state: "ready", windows: [{ id: "m1", clock: "source", range: { start: from, end: to }, timestamps: [from], jpeg: "eA==" }] };
    } else if (req.path === "/projects/prj_test/changes/cut") result = { change: { projectId: "prj_test" } };
    else if (req.path.endsWith("/cut-assessments")) result = { total: 4, assessed: 2, needsDecision: 3 };
    else return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
    return true;
  };
  try {
    await editor.callTool({ name: "dialogue_scan", arguments: { mediaId: "m1", from: 0, until: 6 } });
    for (const from of [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const sheet = await editor.callTool({ name: "frame_contact_sheet", arguments: { mediaId: "m1", from, to: from + 1 } });
      expect(sheet.isError).toBeFalsy();
    }
    expect(mock.state.events.filter(e => e.data?.reviewCounter === "pictures").map(e => e.data?.count)).toEqual([1, 10]);
    const save = await editor.callTool({ name: "dialogue_review_save", arguments: { changeId: "cut", fromVersion: "v1", toVersion: "v2",
      assessments: [{ index: 0, start: 0, end: 1, verdict: "cut", reason: "The editor identified the pickup." },
        { index: 1, start: 1, end: 3, verdict: "ask", reason: "The two takes overlap." }] } });
    expect(save.isError).toBeFalsy();
    expect(mock.requests.find(r => r.path.endsWith("/cut-assessments"))?.body).toMatchObject({
      assessments: [{ verdict: "cut", inspected: false }, { verdict: "ask", inspected: false }],
    });
    expect(mock.state.events.at(-2)?.text).toBe("Saved recommendations for 2 of 4 suggested cuts.");
    // The editor's progress counts the checked cuts against the whole review.
    expect(mock.state.events.at(-1)?.data).toEqual({ kind: "cut_progress", changeId: "cut", checked: 2, total: 4 });
  } finally {
    await editor.close();
    mock.state.extra = original;
  }
});

it("checks a join under a picture that has no sound, without asking the engine for its levels", async () => {
  const original = { extra: mock.state.extra, timeline: mock.state.timeline, waveform: mock.state.waveform, media: mock.state.project.media };
  const isolated = await connect();
  // A screen recording with no audio stream over the recording that carries the dialogue. Its clip keeps the default volume.
  mock.state.project.media = [...original.media, { id: "screen", kind: "video", name: "screen.mp4", path: "screen.mp4", duration: 120, fps: 30, hasAudio: false }];
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "silent-picture";
  tl.tracks[0]!.clips = [makeMediaClip("screen", 0, 6, 0)];
  tl.tracks[1]!.clips = [makeMediaClip("m1", 0, 6, 0)];
  mock.state.timeline = tl;
  const speech = transcript.segments.flatMap(s => s.words).map(w => ({ start: w.start, end: w.end }));
  mock.state.waveform = (mediaId, from, to, points) => {
    const levels = Array.from({ length: points }, (_, i) => {
      const t = from + (i + .5) * (to - from) / points;
      return speech.some(w => w.start <= t && t < w.end) ? .2 : .001;
    });
    return { mediaId, from, to, peaks: levels, rms: levels, speechActivity: speech };
  };
  // The engine refuses to read or prepare levels for a source with no sound.
  mock.state.extra = (req, res) => {
    if (!req.path.includes("/media/screen/")) return false;
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "no_audio", message: "screen.mp4 has no audio track." } }));
    return true;
  };
  try {
    // Both edges sit in the pause between “back.” and “Um,”.
    const check = await isolated.callTool({ name: "dialogue_check_join", arguments: { version: tl.version, start: 2, end: 2.4 } }) as CallToolResult;
    expect(check.isError).toBeFalsy();
    expect(JSON.parse(textOf(check)).status).toBe("unchanged");
    expect(mock.requests.some(r => r.path.includes("/media/screen/"))).toBe(false);
    expect(mock.requests.some(r => r.path.endsWith("/media/m1/waveform"))).toBe(true);
  } finally {
    await isolated.close();
    Object.assign(mock.state, { extra: original.extra, timeline: original.timeline, waveform: original.waveform });
    mock.state.project.media = original.media;
  }
});

it("inspects a split word and submits only the exact timing and disposition the agent chooses", async () => {
  const original = { extra: mock.state.extra, timeline: mock.state.timeline, waveform: mock.state.waveform };
  const isolated = await connect();
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "join-check";
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 6, 0)];
  mock.state.timeline = tl;
  const speech = transcript.segments.flatMap(s => s.words).map(w => ({ start: w.start, end: w.end }));
  mock.state.waveform = (mediaId, from, to, points) => {
    // The recording is loud where words are spoken and silent between them.
    const levels = Array.from({ length: points }, (_, i) => {
      const t = from + (i + .5) * (to - from) / points;
      return speech.some(w => w.start <= t && t < w.end) ? .2 : .001;
    });
    return { mediaId, from, to, peaks: levels, rms: levels, speechActivity: speech };
  };
  mock.state.extra = (req, res) => {
    if (req.path.endsWith("/dialogue-detections") || req.path.endsWith("/dialogue-cuts")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(req.path.endsWith("/dialogue-cuts") ? { changes: [] } : { segments: transcript.segments, acoustic: [] }));
      return true;
    }
    return false;
  };
  try {
    const range = { start: .35, end: 2.28 };
    const scan = await isolated.callTool({ name: "dialogue_scan", arguments: { mediaId: "m1", from: 0, until: 6 } });
    expect(scan.isError).toBeFalsy();
    const preview = await isolated.callTool({ name: "dialogue_check_join", arguments: { version: tl.version, ...range } });
    const fixed = JSON.parse(textOf(preview));
    expect(fixed.status).toBe("adjusted");
    expect(fixed.nearbyWords.start[0].words).toContainEqual([.2, .5, "Hello"]);
    expect(fixed.start).toBeGreaterThan(.5);
    expect(mock.requests.some(r => r.path.endsWith("/dialogue-cuts"))).toBe(false);
    const submit = (decision: string, start: number) => isolated.callTool({ name: "dialogue_apply_cuts", arguments: {
      version: tl.version, description: "Remove the abandoned take", cuts: [{ start, end: range.end, kind: "retake", decision, reason: "Repeated start" }],
    } });
    const submitted = () => mock.requests.filter(r => r.path.endsWith("/dialogue-cuts")).at(-1)?.body;
    // An edge inside a word narrows onto the recording's silence and waits for audition.
    expect((await submit("cut", range.start)).isError).toBeFalsy();
    expect(submitted()).toMatchObject({ cuts: [{ start: fixed.start, end: range.end, review: true, originalRange: range }] });
    // An edge already on silence applies exactly as decided.
    expect((await submit("cut", fixed.start)).isError).toBeFalsy();
    expect(submitted()).toMatchObject({ cuts: [{ start: fixed.start, end: range.end, review: false }] });
    // An edge 40 ms inside “back.” moves into the silence after it, 0.15 s past the word, and applies as decided.
    const snap = JSON.parse(textOf(await isolated.callTool({ name: "dialogue_check_join", arguments: { version: tl.version, start: 1.76, end: 2.28 } })));
    expect(snap).toMatchObject({ status: "snapped", end: 2.28 });
    expect(snap.start).toBeCloseTo(58 / 30);
    expect(snap.audio.map((a: { edge: string }) => a.edge)).toEqual(["start", "end"]);
    expect(snap.audio[0]).toMatchObject({ sound: "sound", transcriptSplitsWord: "back" });
    expect(snap.audio[0].levels).toContain("|");
    await isolated.callTool({ name: "dialogue_apply_cuts", arguments: { version: tl.version, description: "Remove the pause",
      cuts: [{ start: 1.76, end: 2.28, kind: "retake", decision: "cut", reason: "Repeated start" }] } });
    const snapped = mock.requests.filter(r => r.path.endsWith("/dialogue-cuts")).at(-1)?.body as { cuts: { start: number; end: number; originalRange?: unknown; reason: string }[] };
    expect(snapped.cuts[0]!.start).toBeCloseTo(58 / 30);
    expect(snapped.cuts[0]).toMatchObject({ end: 2.28, reason: expect.not.stringContaining("Adjusted") });
    expect(snapped.cuts[0]!.originalRange).toBeUndefined();
  } finally {
    Object.assign(mock.state, original);
    await isolated.close();
  }
});

it("submits the chosen cut, review and fade and preserves engine receipts", async () => {
  const original = { extra: mock.state.extra, timeline: mock.state.timeline };
  const editor = await connect();
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "dialogue";
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 6, 0)];
  mock.state.timeline = tl;
  mock.state.extra = (req, res) => {
    if (!req.path.endsWith("/dialogue-cuts")) return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ changes: [], heldForReview: [{ start: 1, end: 1.4 }],
      alreadyRemoved: [{ changeId: "earlier_pass", index: 1, version: "current", at: 2 }] }));
    return true;
  };
  try {
    const result = await editor.callTool({ name: "dialogue_apply_cuts", arguments: { version: tl.version, description: "Tighten", crossfadeFrames: 4,
      cuts: [{ start: 1, end: 1.4, kind: "pause", decision: "cut", reason: "Long pause." },
        { start: 3, end: 3.3, kind: "filler", decision: "keep", reason: "Keep her hesitation." },
        { start: 4, end: 4.5, kind: "coaching", decision: "review", reason: "Off-mic note." }] } }) as CallToolResult;
    expect(result.isError, textOf(result)).toBeFalsy();
    const sent = mock.requests.filter(r => r.path.endsWith("/dialogue-cuts")).at(-1)?.body;
    expect(sent).toMatchObject({ crossfadeFrames: 4, cuts: [{ kind: "pause" }, { kind: "coaching", review: true }] });
    const receipt = JSON.parse(textOf(result));
    expect(receipt.heldForReview).toEqual([{ start: 1, end: 1.4 }]);
    expect(receipt.alreadyRemoved).toEqual([{ changeId: "earlier_pass", index: 1, version: "current", at: 2 }]);
  } finally {
    Object.assign(mock.state, original);
    await editor.close();
  }
});

it("moves the staged cut being revised past its old edges and steers the other editing tools to it", async () => {
  const task = Task.parse({ id: "revise-cut", state: "running", projectId: mock.state.project.id, kind: "revise", agent: "claude",
    instruction: "Remove the “I” before the cut.", context: { changeId: "pass", cutIndex: 1, time: 2, end: 3, noteIds: ["n1"] },
    createdBy: { type: "human", name: "Editor" } });
  const scoped = await connect(task.id, undefined, task);
  const original = { extra: mock.state.extra, timeline: mock.state.timeline, waveform: mock.state.waveform };
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "pass-from";
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 6, 0)];
  mock.state.timeline = tl;
  mock.state.waveform = (mediaId, from, to, points) => ({ mediaId, from, to, peaks: Array(points).fill(.001), rms: Array(points).fill(.001) });
  let saved: unknown;
  mock.state.extra = (req, res) => {
    let result;
    if (req.path === "/projects/prj_test/changes/pass") result = { change: { id: "pass", projectId: "prj_test", intent: "suggestion", state: "revising",
      fromVersion: "pass-from", toVersion: "pass-to" } };
    else if (req.path === "/projects/prj_test/changes/pass/staged-cuts/1") {
      saved = req.body;
      result = { change: { id: "pass2", state: "ready", description: "Review 3 optional dialogue cuts", fromVersion: "pass-from", toVersion: "pass2-to" } };
    } else if (req.path.endsWith("/dialogue-detections")) result = { segments: [], acoustic: [] };
    else return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
    return true;
  };
  try {
    // The old selection doesn't fence the revision in, and the pass-wide tools point at the one that moves the cut.
    const apply = await scoped.callTool({ name: "dialogue_apply_cuts", arguments: { version: tl.version, description: "Move the cut",
      cuts: [{ start: 1.6, end: 3, kind: "retake", decision: "cut", reason: "Repeat" }] } });
    expect(apply.isError).toBe(true);
    expect(textOf(apply as CallToolResult)).toContain("dialogue_revise_cut");
    const propose = await scoped.callTool({ name: "timeline_propose", arguments: { description: "Move the cut", fromVersion: tl.version, intent: "requested",
      ops: [{ op: "rippleDelete", start: 1.6, end: 3 }] } });
    expect(textOf(propose as CallToolResult)).toContain("dialogue_revise_cut");
    const writes = [
      ["timeline_crossfade_audio", { joins: [{ leftClipId: "left", rightClipId: "right" }], intent: "requested" }],
      ["captions_generate", { intent: "requested" }],
      ["timeline_first_cut", { intent: "requested", mediaId: "m1", keep: [{ start: 0, end: 2 }], description: "Assemble." }],
      ["dialogue_review_save", { changeId: "pass", fromVersion: "pass-from", toVersion: "pass-to",
        assessments: [{ index: 0, start: 0, end: 1, verdict: "keep", reason: "Keep." }] }],
    ] as const;
    for (const [name, args] of writes) {
      const rejected = await scoped.callTool({ name, arguments: args });
      expect(textOf(rejected as CallToolResult)).toContain("dialogue_revise_cut");
    }
    const mixed = await scoped.callTool({ name: "dialogue_revise_cut", arguments: { changeId: "pass", cuts: [
      { index: 1, start: 1.6, end: 3, reason: "Move this cut." }, { index: 0, start: 0.3, end: 1, reason: "Another cut." },
    ] } });
    expect(mixed.isError).toBe(true);
    expect(saved).toBeUndefined();
    const moved = await scoped.callTool({ name: "dialogue_revise_cut", arguments: { changeId: "pass", index: 1, start: 1.6, end: 3, crossfadeFrames: 3,
      reason: "Starts in the pause after “weights” so the first “I” is gone." } });
    expect(moved.isError).toBeFalsy();
    expect(saved).toMatchObject({ start: 1.6, end: 3, crossfadeFrames: 3, taskId: "revise-cut", noteIds: ["n1"], reason: "Starts in the pause after “weights” so the first “I” is gone." });
    expect(JSON.parse(textOf(moved as CallToolResult))).toMatchObject({ changeId: "pass2", start: 1.6, end: 3 });
    expect(JSON.parse(textOf(moved as CallToolResult))).not.toHaveProperty("movedOn");
    expect(mock.state.events.at(-1)).toMatchObject({ type: "change", data: { changeId: "pass2" } });
    // A revision had replaced the pass named since the request was sent: Scarlet made the move on the pass that waits, and says so.
    const plain = mock.state.extra;
    mock.state.extra = (req, res) => {
      if (req.path !== "/projects/prj_test/changes/pass/staged-cuts/1") return plain!(req, res);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ replaced: "pass1b", change: { id: "pass3", state: "ready", description: "Review 3 optional dialogue cuts", fromVersion: "pass-from", toVersion: "pass3-to" } }));
      return true;
    };
    const redirected = JSON.parse(textOf(await scoped.callTool({ name: "dialogue_revise_cut", arguments: { changeId: "pass", index: 1, start: 1.6, end: 3,
      reason: "Starts in the pause." } }) as CallToolResult));
    expect(redirected).toMatchObject({ changeId: "pass3", movedOn: "pass1b" });
    expect(redirected.note).toContain("replaced pass with pass1b");
  } finally {
    Object.assign(mock.state, original);
    await scoped.close();
  }
});

it("trims the pause before a staged cut in one call and measures the played join on the saved preview", async () => {
  const before = { extra: mock.state.extra, timeline: mock.state.timeline, waveform: mock.state.waveform };
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "before-pause";
  tl.tracks[1]!.clips = [makeMediaClip("m1", 0, 6, 0)];
  mock.state.timeline = tl;
  // The detector stays on after the word. Its zero quiet time must not decide where the cut lands.
  mock.state.waveform = (...args) => ({ ...spokenWaveform(...args), speechActivity: [{ start: 0, end: 6 }] });
  const pass = { id: "pass", projectId: tl.projectId, intent: "suggestion", state: "ready", fromVersion: tl.version, toVersion: "preview" };
  const saved = { ...pass, id: "tightened", toVersion: "tightened-preview" };
  const removal = { start: 2.2, end: 3.6 };
  const writes: unknown[] = [];
  const preview = emptyTimeline(tl.projectId);
  preview.version = saved.toVersion;
  // At 30 fps the word ends at 1.800. A preceding 0.5 s removal places its join at 1.300 in the preview.
  preview.tracks[1]!.clips = [makeMediaClip("m1", .5, 1.8, 0), makeMediaClip("m1", 3.6, 6, 1.3)];
  mock.state.extra = (req, res) => {
    let result;
    if (req.path.endsWith("/changes/pass")) result = { change: pass };
    else if (req.path.endsWith("/pass/cut-review")) result = { review: { cuts: [{ removed: removal, at: 1.7 }] } };
    else if (req.path.endsWith("/pass/staged-cuts/0")) { writes.push(req.body); result = { change: saved }; }
    else if (req.path.endsWith("/tightened/cut-review")) result = { review: { cuts: [{ removed: { start: 1.8, end: 3.6 }, at: 1.3 }] } };
    else if (req.path.endsWith("/timeline") && req.query.get("version") === saved.toVersion) result = { timeline: preview };
    else return false;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
    return true;
  };
  const editor = await connect("trim-pause");
  try {
    const request = { changeId: pass.id, index: 0, pauseAfterWord: 0, reason: "Bring the cut to the end of the word." };
    const result = await editor.callTool({ name: "dialogue_revise_cut", arguments: request }) as CallToolResult;
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(writes).toMatchObject([{ start: 1.8, end: 3.6, requireCurrentCut: true }]);
    expect(JSON.parse(textOf(result))).toMatchObject({ changeId: saved.id, outgoingPause: { word: "back.", beforeSeconds: .4, remainingSeconds: 0 } });
    expect(mock.requests.some(r => r.query.get("version") === saved.toVersion)).toBe(true);
    const invalid = await editor.callTool({ name: "dialogue_revise_cut", arguments: { ...request, start: 2 } }) as CallToolResult;
    expect(invalid.isError).toBe(true);
    expect(writes).toHaveLength(1);
  } finally { Object.assign(mock.state, before); await editor.close(); }
});

it("reinspects an overlapping cut on the current version and reports the placement actually saved", async () => {
  const task = Task.parse({ id: "follow-up", state: "running", projectId: "prj_test", kind: "edit", agent: "claude",
    instruction: "Keep the second take.", context: { changeId: "pass", cutIndex: 0 }, createdBy: { type: "human", name: "Editor" } });
  const editor = await connect(task.id, undefined, task);
  const before = { extra: mock.state.extra, timeline: mock.state.timeline };
  const tl = emptyTimeline("prj_test");
  tl.version = "current";
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 6, 0)];
  mock.state.timeline = tl;
  const change = { id: "pass", projectId: "prj_test", intent: "suggestion", state: "ready", fromVersion: "old", toVersion: "preview" };
  const saves: unknown[] = [];
  mock.state.extra = (req, res) => {
    let result;
    if (req.path === "/projects/prj_test/changes/pass") result = { change };
    else if (req.path === "/projects/prj_test/changes/pass/staged-cuts/0") {
      const body = req.body as { version?: string; keep?: true };
      saves.push(body);
      if (!body.version && !body.keep) {
        res.statusCode = 409;
        result = { error: { code: "cut_review_stale", message: "Another edit changed this take.",
          details: { currentVersion: "current", range: { start: 2, end: 3 } } } };
      } else result = { change: { ...change, id: "new", cutEdits: body.keep ? undefined :
        [{ index: 0, version: "current", range: { start: 2.1, end: 3 }, previewVersion: "new-preview" }] } };
    } else if (req.path === "/projects/prj_test/changes/new/cut-review") result = { review: { cuts: [{ removed: { start: 4, end: 5 } }] } };
    else return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
    return true;
  };
  const request = { changeId: "pass", index: 0, start: 2, end: 3, reason: "Keep the second take." };
  const move = (extra: object = {}) => editor.callTool({ name: "dialogue_revise_cut", arguments: { ...request, ...extra } }) as Promise<CallToolResult>;
  try {
    const blocked = await move();
    expect(blocked.isError).toBe(true);
    expect(JSON.parse(textOf(blocked))).toMatchObject({ currentVersion: "current", range: { start: 2, end: 3 } });
    await editor.callTool({ name: "timeline_transcript", arguments: { version: "current", from: 0, to: 1 } });
    expect((await move({ version: "current" })).isError).toBe(true);
    expect(saves).toHaveLength(1);
    const inspected = await editor.callTool({ name: "dialogue_review_inspect", arguments: { changeId: "pass", index: 0 } }) as CallToolResult;
    expect(textOf(inspected)).toContain('"currentVersion":"current"');
    expect(textOf(inspected)).toContain("welcome");
    const saved = await move({ version: "current" });
    expect(saved.isError).toBeFalsy();
    expect(saves.at(-1)).toMatchObject({ version: "current", start: 2, end: 3 });
    expect(JSON.parse(textOf(saved))).toMatchObject({ changeId: "new", version: "current", start: 2.1, end: 3, previewVersion: "new-preview" });
    // A scoped keep can settle an unlocatable cut without inventing its current position.
    const kept = JSON.parse(textOf(await move({ keep: true })));
    expect(kept.choice).toBe("keep");
    expect(kept).not.toHaveProperty("start");
    expect(saves.at(-1)).toMatchObject({ keep: true });
    expect((await move({ index: 1, keep: true })).isError).toBe(true);
  } finally {
    Object.assign(mock.state, before);
    await editor.close();
  }
});

it("resumes a carried conflict by the original cut and keeps it by its new number", async () => {
  const task = Task.parse({ id: "resumed", state: "running", projectId: "prj_test", kind: "revise", agent: "codex",
    instruction: "Keep this take.", context: { changeId: "original-pass", cutIndex: 0 }, createdBy: { type: "human", name: "Editor" },
    cutConflict: { changeId: "current-pass", index: 2, version: "current", range: { start: 2, end: 3 }, answered: true } });
  const editor = await connect(task.id, undefined, task);
  const before = { extra: mock.state.extra, timeline: mock.state.timeline };
  const tl = emptyTimeline("prj_test");
  tl.version = "current";
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 6, 0)];
  mock.state.timeline = tl;
  const active = { id: "current-pass", projectId: "prj_test", intent: "suggestion", state: "ready", fromVersion: "base", toVersion: "preview" };
  const writes: unknown[] = [];
  mock.state.extra = (req, res) => {
    let result;
    if (req.path === "/projects/prj_test/changes/current-pass") result = { change: active };
    else if (req.path === "/projects/prj_test/changes/current-pass/staged-cuts/2") {
      writes.push(req.body);
      result = { change: { ...active, id: "kept" } };
    } else return false;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
    return true;
  };
  const keep = (index: number) => editor.callTool({ name: "dialogue_revise_cut", arguments: { changeId: active.id, index,
    version: tl.version, start: 2, end: 3, keep: true, reason: "Keep this take." } }) as Promise<CallToolResult>;
  try {
    const read = await editor.callTool({ name: "dialogue_review_inspect", arguments: { changeId: "original-pass", index: 0 } }) as CallToolResult;
    expect(textOf(read)).toContain('"currentVersion":"current"');
    expect(textOf(read)).toContain("welcome");
    expect((await keep(1)).isError).toBe(true);
    expect((await keep(2)).isError).toBeFalsy();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ version: "current", keep: true });
  } finally {
    Object.assign(mock.state, before);
    await editor.close();
  }
});

it.each(["pending conflict", "saved override"])("requires a current read on a rollback to the original version with a %s", async evidence => {
  const range = { start: 2, end: 3 };
  const task = Task.parse({ id: "rollback", state: "running", projectId: "prj_test", kind: "revise", agent: "codex",
    instruction: "Remove the repeated word.", context: { changeId: "pass", cutIndex: 0 }, createdBy: { type: "human", name: "Editor" },
    ...(evidence === "pending conflict" && { cutConflict: { version: "intervening", range } }) });
  const editor = await connect(task.id, undefined, task);
  const before = { extra: mock.state.extra, timeline: mock.state.timeline };
  const tl = emptyTimeline("prj_test");
  tl.version = "original";
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 6, 0)];
  mock.state.timeline = tl;
  const change = { id: "pass", projectId: "prj_test", intent: "suggestion", state: "ready", fromVersion: tl.version, toVersion: "preview",
    ...(evidence === "saved override" && { cutEdits: [{ index: 0, version: "intervening", range }] }) };
  let writes = 0;
  mock.state.extra = (req, res) => {
    let result;
    if (req.path === "/projects/prj_test/changes/pass") result = { change };
    else if (req.path === "/projects/prj_test/changes/pass/staged-cuts/0") {
      writes++;
      result = { change: { ...change, id: "saved", cutEdits: [{ index: 0, version: tl.version, range }] } };
    } else return false;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
    return true;
  };
  const move = () => editor.callTool({ name: "dialogue_revise_cut", arguments: { changeId: change.id, index: 0,
    version: tl.version, ...range, reason: "Keep the current take." } }) as Promise<CallToolResult>;
  try {
    expect((await move()).isError).toBe(true);
    expect(writes).toBe(0);
    await editor.callTool({ name: "timeline_transcript", arguments: { version: tl.version, from: 1, to: 4 } });
    expect((await move()).isError).toBeFalsy();
    expect(writes).toBe(1);
  } finally {
    Object.assign(mock.state, before);
    await editor.close();
  }
});

it("keeps a batch on the originally named pass when a later part carries and renumbers its cuts", async () => {
  const before = { extra: mock.state.extra, timeline: mock.state.timeline };
  const tl = emptyTimeline("prj_test");
  tl.version = "original";
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 8, 0)];
  mock.state.timeline = tl;
  const pass = { id: "original-pass", projectId: "prj_test", intent: "suggestion", state: "rejected", fromVersion: tl.version, toVersion: "preview" };
  const paths: string[] = [];
  mock.state.extra = (req, res) => {
    let result;
    if (req.path === "/projects/prj_test/changes/original-pass") result = { change: pass };
    else if (req.path.includes("/staged-cuts/")) {
      paths.push(req.path.split("/changes/")[1]!);
      const index = Number(req.path.split("/").at(-1)) + 1;
      result = { index, carried: true, change: { ...pass, id: "successor-" + index, state: "ready", fromVersion: "new-base" } };
    } else if (req.path.endsWith("/cut-review")) result = { review: { cuts: [
      { removed: { start: 0, end: 1 } }, { removed: { start: 2.2, end: 3 } }, { removed: { start: 4.2, end: 5 } }] } };
    else return false;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
    return true;
  };
  try {
    const moved = await client.callTool({ name: "dialogue_revise_cut", arguments: { changeId: pass.id, cuts: [
      { index: 0, start: 2, end: 3, reason: "Remove the first repeat." }, { index: 1, start: 4, end: 5, reason: "Remove the second repeat." }] } }) as CallToolResult;
    expect(moved.isError).toBeFalsy();
    expect(paths).toEqual(["original-pass/staged-cuts/0", "original-pass/staged-cuts/1"]);
    expect(JSON.parse(textOf(moved))).toMatchObject({ changeId: "successor-2", moved: [
      { index: 1, requestedIndex: 0, start: 2.2, end: 3 }, { index: 2, requestedIndex: 1, start: 4.2, end: 5 }] });
  } finally { Object.assign(mock.state, before); }
});

it("moves several staged cuts of a pass in one call, each on the pass the move before it left", async () => {
  const task = Task.parse({ id: "second-pass", state: "running", projectId: mock.state.project.id, kind: "edit", agent: "claude",
    instruction: "/first-cut-dialogue", createdBy: { type: "human", name: "Editor" } });
  const scoped = await connect(task.id, undefined, task);
  const original = { extra: mock.state.extra, timeline: mock.state.timeline, waveform: mock.state.waveform };
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "pass-from";
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 20, 0)];
  mock.state.timeline = tl;
  mock.state.waveform = (mediaId, from, to, points) => ({ mediaId, from, to, peaks: Array(points).fill(.001), rms: Array(points).fill(.001) });
  // Each move makes a new pass: pass → pass.0 → pass.0.3. The middle move is refused by the engine.
  const moves: string[] = [];
  mock.state.extra = (req, res) => {
    const move = /^\/projects\/prj_test\/changes\/([^/]+)\/staged-cuts\/(\d+)$/.exec(req.path);
    const pass = /^\/projects\/prj_test\/changes\/([^/]+)$/.exec(req.path);
    const review = /^\/projects\/prj_test\/changes\/([^/]+)\/cut-review$/.exec(req.path);
    let result;
    if (move) {
      moves.push(`${move[1]}#${move[2]}`);
      if (move[2] === "2") {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: { code: "invalid_cuts", message: "Keep the cut clear of its neighbors: the next starts at 9.00 s." } }));
        return true;
      }
      result = { change: { id: `${move[1]}.${move[2]}`, state: "ready", description: "Review 4 optional dialogue cuts", fromVersion: "pass-from", toVersion: "to" } };
    } else if (review) result = { review: { cuts: [{ removed: { start: 1.5, end: 2.5 } }, {}, {}, { removed: { start: 12.1, end: 13 } }] } };
    else if (pass) result = { change: { id: pass[1], projectId: "prj_test", intent: "suggestion", state: "ready", fromVersion: "pass-from", toVersion: "pass-to" } };
    else return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
    return true;
  };
  try {
    const moved = await scoped.callTool({ name: "dialogue_revise_cut", arguments: { changeId: "pass", cuts: [
      { index: 0, start: 1.5, end: 2.5, reason: "Starts in the pause." }, { index: 2, start: 7, end: 9.5, reason: "Ends after the breath." },
      { index: 3, start: 12.1, end: 13, reason: "Starts after “so”." }] } });
    expect(moved.isError).toBeFalsy();
    expect(moves).toEqual(["pass#0", "pass.0#2", "pass.0#3"]);
    expect(JSON.parse(textOf(moved as CallToolResult))).toMatchObject({ changeId: "pass.0.3", moved: [
      { index: 0, start: 1.5, end: 2.5 }, { index: 2, error: expect.stringContaining("clear of its neighbors") }, { index: 3, start: 12.1, end: 13 }] });
    // One announcement for the pass as it stands after every move.
    expect(mock.state.events.filter(e => e.type === "change").at(-1)).toMatchObject({ data: { changeId: "pass.0.3" } });
    const both = await scoped.callTool({ name: "dialogue_revise_cut", arguments: { changeId: "pass", index: 0, start: 1, end: 2, reason: "x",
      cuts: [{ index: 1, start: 4, end: 5, reason: "y" }] } });
    expect(both.isError).toBe(true);
  } finally {
    Object.assign(mock.state, original);
    await scoped.close();
  }
});

it("measures the recording beside a staged cut's new edges with no scan read, and saves an edge inside a word on the silence after it", async () => {
  const task = Task.parse({ id: "revise-edges", state: "running", projectId: mock.state.project.id, kind: "revise", agent: "claude",
    instruction: "Start the cut after “back.”", context: { changeId: "pass", cutIndex: 0 }, createdBy: { type: "human", name: "Editor" } });
  const scoped = await connect(task.id, undefined, task);
  const original = { extra: mock.state.extra, timeline: mock.state.timeline, waveform: mock.state.waveform };
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "pass-from";
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 6, 0)];
  mock.state.timeline = tl;
  mock.state.waveform = spokenWaveform;
  const saved: Array<{ start: number; end: number }> = [];
  mock.state.extra = (req, res) => {
    let result;
    if (req.path === "/projects/prj_test/changes/pass") result = { change: { id: "pass", projectId: "prj_test", intent: "suggestion", state: "revising",
      fromVersion: "pass-from", toVersion: "pass-to" } };
    else if (req.path === "/projects/prj_test/changes/pass/staged-cuts/0") {
      saved.push(req.body as { start: number; end: number });
      result = { change: { id: "pass2", state: "ready", description: "Review 1 optional dialogue cut", fromVersion: "pass-from", toVersion: "pass2-to" } };
    } else return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
    return true;
  };
  const move = async (start: number, end: number) => {
    const r = await scoped.callTool({ name: "dialogue_revise_cut", arguments: { changeId: "pass", index: 0, start, end, reason: "Starts after “back.”" } }) as CallToolResult;
    expect(r.isError, textOf(r)).toBeFalsy();
    return JSON.parse(textOf(r));
  };
  try {
    // Both edges in the pause between “back.” and “Um,”: the recording is quiet there, so nothing is reported and nothing is left to do.
    const quiet = await move(1.9, 2.4);
    expect(saved.at(-1)).toMatchObject({ start: 1.9, end: 2.4 });
    expect(quiet.audio).toBeUndefined();
    expect(quiet.next).toBeUndefined();
    // A start 40 ms inside “back.” goes onto the silence after the word, where dialogue_check_join puts it.
    const snapped = await move(1.76, 2.28);
    expect(saved.at(-1)!.start).toBeCloseTo(58 / 30);
    expect(saved.at(-1)!.end).toBe(2.28);
    expect(snapped.audio).toContain("Snapped to the recording's silence");
    expect(snapped.next).toBeUndefined();
    // A start in the middle of “Hello” has no silence a few frames away: the edges stand as asked, and the result says what the recording has there.
    const inside = await move(.35, 2.28);
    expect(saved.at(-1)).toMatchObject({ start: .35, end: 2.28 });
    expect(inside.audio).toContain("to preserve “Hello”");
    expect(inside.next).toContain("dialogue_check_join");
  } finally {
    Object.assign(mock.state, original);
    await scoped.close();
  }
});

const dialogueSkill = { source: "bundled", id: "skl_dialogue", name: "first-cut-dialogue", description: "First cut", content: "# First cut", scope: "team" as const,
  ownerId: null, projectId: null, agents: [], enabled: true, version: 1 };

it("checks each surviving side independently before preview and save, then accepts the repaired join", async () => {
  const original = { extra: mock.state.extra, waveform: mock.state.waveform, timeline: mock.state.timeline, transcripts: mock.state.transcripts };
  const editor = await connect();
  const tl = emptyTimeline(mock.state.project.id);
  tl.tracks[1]!.clips = [makeMediaClip("m1", 0, 6, 0)];
  mock.state.timeline = tl;
  mock.state.transcripts = {};
  mock.state.waveform = (mediaId, from, to, points) => ({ mediaId, from, to, peaks: Array(points).fill(.001), rms: Array(points).fill(.001), speechActivity: [] });
  const audio = [{ text: "now", start: 1.6, end: 1.78 }, { text: "now", start: 3.6, end: 3.78 }];
  let saved = 0;
  mock.state.extra = (req, res) => {
    let result;
    if (req.path.endsWith("/dialogue-detections")) {
      const { from, to, keptSide } = req.body as { from: number; to: number; keptSide?: unknown };
      expect(keptSide).toBeDefined();
      expect(to - from).toBeLessThanOrEqual(8);
      result = { acoustic: [], segments: [{ words: audio.filter(w => from <= w.start && w.end <= to) }] };
    } else if (req.path.endsWith("/dialogue-cuts")) {
      saved++;
      result = { changes: [] };
    } else return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
    return true;
  };
  const call = async (name: string, args: Record<string, unknown>) =>
    JSON.parse(textOf(await editor.callTool({ name, arguments: { version: tl.version, ...args } })));
  const plan = (start: number) => call("dialogue_apply_cuts", { only: "retake", description: "Keep the complete delivery.",
    cuts: [{ start, end: 3.5, kind: "retake", decision: "cut", reason: "Remove the restart." }] });
  try {
    const repeat = { words: "now", before: { start: 1.6, end: 1.78 }, after: { start: 3.6, end: 3.78 } };
    expect(await call("dialogue_check_join", { start: 1.9, end: 3.5 })).toMatchObject({ repeatAtJoin: repeat });
    expect(await plan(1.9)).toMatchObject({ needsRevision: true, disputedEdges: [{ repeat }] });
    expect(saved).toBe(0);
    await plan(1.5);
    expect(saved).toBe(1);
  } finally { Object.assign(mock.state, original); await editor.close(); }
});

it("reports a repeated onset that only plays in the fade, then clears it when the outgoing edge moves", async () => {
  const original = { timeline: mock.state.timeline, transcripts: mock.state.transcripts, waveform: mock.state.waveform, extra: mock.state.extra };
  const editor = await connect();
  const tl = emptyTimeline(mock.state.project.id);
  tl.tracks[1]!.clips.push(makeMediaClip("m1", 0, 8, 0));
  mock.state.timeline = tl;
  const words = [{ text: "step", start: 1.4, end: 1.8 }, { text: "over", start: 2.005, end: 2.25 },
    { text: "over", start: 5.1, end: 5.35 }, { text: "here", start: 5.4, end: 5.7 }];
  mock.state.transcripts = { m1: { ...transcript, segments: [{ id: "s", start: 0, end: 8, text: "Step over, over here.", words }] } };
  mock.state.waveform = (mediaId, from, to, points) => ({ mediaId, from, to, peaks: Array(points).fill(.2), rms: Array(points).fill(.2),
    speechActivity: [{ start: from, end: to }] });
  // The first vowel falls entirely after the picture cut, within the one-frame outgoing audio handle.
  const acoustic = [words[0]!, { text: "o", start: 2.011, end: 2.04 }, ...words.slice(2)];
  mock.state.extra = (req, res) => {
    if (!req.path.endsWith("/dialogue-detections")) return false;
    const { from, to } = req.body as { from: number; to: number };
    const heard = acoustic.filter(w => w.end > from && w.start < to)
      .map(w => ({ ...w, start: Math.max(from, w.start), end: Math.min(to, w.end) }));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ segments: [{ id: "kept", words: heard }], acoustic: [] }));
    return true;
  };
  const check = async (start: number, crossfadeFrames?: number) => {
    const result = await editor.callTool({ name: "dialogue_check_join", arguments: { version: tl.version, start, end: 5, crossfadeFrames } });
    expect(result.isError).toBeFalsy();
    return JSON.parse(textOf(result));
  };
  try {
    expect((await check(2)).partialWordRepeat).toBeUndefined();
    expect(await check(2, 2)).toMatchObject({ partialWordRepeat: { side: "start", word: "over", heard: "o",
      fragment: { start: 2.011, end: expect.closeTo(2 + 1 / 30, 5) }, complete: { start: 5.1, end: 5.35 } } });
    const revised = await check(2 - 4 / 30, 2);
    expect(revised.partialWordRepeat).toBeUndefined();
    expect(revised.unreadJoinAudio).toBeUndefined();
  } finally { Object.assign(mock.state, original); await editor.close(); }
});

it("returns an opening trim that leaves two six-word deliveries, then saves the uninterrupted take", async () => {
  const original = { extra: mock.state.extra, waveform: mock.state.waveform, timeline: mock.state.timeline, transcripts: mock.state.transcripts };
  const editor = await connect();
  const tl = emptyTimeline(mock.state.project.id);
  tl.tracks[1]!.clips = [makeMediaClip("m1", 0, 18, 0)];
  mock.state.timeline = tl;
  mock.state.transcripts = {};
  mock.state.waveform = (mediaId, from, to, points) => ({ mediaId, from, to, peaks: Array(points).fill(.001), rms: Array(points).fill(.001), speechActivity: [] });
  const phrase = "we can hear the bell ring";
  const line = (text: string, start: number) => text.split(" ").map((word, i) => ({ text: word, start: start + .3 * i, end: start + .3 * i + .2 }));
  // The first attempt stops, the next finishes the sentence. Its last repeated word is over four seconds past the trim.
  const audio = [...line(phrase, 3.2), ...line(phrase + " from here", 6.2)];
  let saves = 0;
  mock.state.extra = (req, res) => {
    let result;
    if (req.path.endsWith("/dialogue-detections")) {
      const { from, to, keptSide } = req.body as { from: number; to: number; keptSide?: unknown };
      expect(keptSide).toBeDefined();
      result = { acoustic: [], segments: [{ words: audio.filter(w => w.start >= from && w.end <= to) }] };
    } else if (req.path.endsWith("/dialogue-cuts")) {
      saves++;
      result = { changes: [] };
    } else return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
    return true;
  };
  const apply = async (end: number) => {
    const result = await editor.callTool({ name: "dialogue_apply_cuts", arguments: { version: tl.version,
      description: "Open on the complete line.", cuts: [{ start: 0, end, kind: "coaching", decision: "cut", reason: "Remove the direction." }] } });
    expect(result.isError, textOf(result)).toBeFalsy();
    return JSON.parse(textOf(result));
  };
  try {
    expect(await apply(3)).toMatchObject({ needsRevision: true, disputedEdges: [{ pickup: { words: phrase, side: "end",
      first: { start: 3.2, end: 4.9 }, second: { start: 6.2, end: 7.9 } } }] });
    expect(saves).toBe(0);
    await apply(6);
    expect(saves).toBe(1);
  } finally { Object.assign(mock.state, original); await editor.close(); }
});

it("exposes cross-page attempts and lets the agent choose whether to check the next words", async () => {
  const original = { extra: mock.state.extra, waveform: mock.state.waveform, timeline: mock.state.timeline };
  const task = Task.parse({ id: "repeated-intro", state: "running", projectId: mock.state.project.id, kind: "edit", agent: "claude",
    instruction: "/first-cut-dialogue", createdBy: { type: "human", name: "Editor" } });
  const editor = await connect(task.id, undefined, task);
  const tl = emptyTimeline(mock.state.project.id);
  tl.tracks[1]!.clips = [makeMediaClip("m2", 52, 68, 3, { speed: 2 })];
  mock.state.timeline = tl;
  const attempt = (start: number, line: string) => line.split(" ").map((text, i) => ({
    text, start: start + i * .25, end: start + i * .25 + .2,
  }));
  const runs = [attempt(54, "Let me do that one more time."), attempt(56, "The new model from DeepSeek,"),
    attempt(58, "the new model from DeepSeek,"), attempt(60, "the new model from DeepSeek flew under the radar.")];
  const segments = runs.map((words, i) => ({ id: String(i), text: words.map(w => w.text).join(" "), words,
    start: words[0]!.start, end: words.at(-1)!.end }));
  mock.state.waveform = (mediaId, from, to, points) => ({ mediaId, from, to, peaks: Array(points).fill(.001), rms: Array(points).fill(.001) });
  mock.state.extra = (req, res) => {
    if (!req.path.endsWith("/dialogue-detections") && !req.path.endsWith("/dialogue-cuts")) return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.path.endsWith("/dialogue-cuts") ? { changes: [] } : {
      segments, acoustic: [], speechActivity: segments.map(s => ({ start: s.start, end: s.end })),
    }));
    return true;
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await editor.callTool({ name, arguments: args });
    expect(result.isError).toBeFalsy();
    return textOf(result);
  };
  try {
    const scan = (from: number) => call("dialogue_scan", { mediaId: "m2", from, until: 68 }).then(JSON.parse);
    const first = await scan(0);
    expect(first.passages[0].correctionCue).toBe("Let me do that one more time");
    const next = await scan(first.nextFrom);
    expect(next.repeatedTakes).toContainEqual(expect.objectContaining({ first: expect.objectContaining({ start: 58 }),
      next: expect.objectContaining({ start: 60, continuation: "flew under the radar." }) }));
    const apply = (cuts: object[], extra: object = {}) => call("dialogue_apply_cuts", { version: tl.version,
      description: "Use the complete intro", only: "retake", cuts, ...extra });
    expect(await apply([])).toContain("preserved");
    expect(mock.requests.some(r => r.path.endsWith("/dialogue-cuts"))).toBe(false);
    const resumeWith = "the new model from DeepSeek flew under the radar";
    const cut = { start: 5, end: 7.125, resumeWith, decision: "cut", kind: "retake", reason: "Use the complete opening." };
    const wrong = JSON.parse(await call("dialogue_check_join", { version: tl.version, start: cut.start, end: cut.end, resumeWith }));
    expect(wrong).toMatchObject({ status: "unchanged", resumeAtOriginalEnd: "different" });
    expect(wrong.nearbyWords.end[0].words).toContainEqual([7, expect.closeTo(7.1), "the"]);
    expect(JSON.parse(await apply([cut]))).toMatchObject({ needsRevision: true, disputedEdges: [{ start: 5, end: 7.125 }] });
    expect(mock.requests.some(r => r.path.endsWith("/dialogue-cuts"))).toBe(false);
    const cleanEnd = 7; // Source 60, before the only delivery that reaches "flew under the radar".
    expect(JSON.parse(await call("dialogue_check_join", { version: tl.version, start: cut.start, end: cleanEnd, resumeWith })))
      .toMatchObject({ status: "unchanged", resumeAtOriginalEnd: "matches" });
    await apply([{ ...cut, end: cleanEnd, resumeWith: undefined }]);
    expect(mock.requests.find(r => r.path.endsWith("/dialogue-cuts"))?.body).toMatchObject({
      cuts: [{ start: 5, end: 7, review: false }],
    });
    expect(await apply([{ ...cut, end: 7.6, decision: "keep", reason: "Intentional refrain" }])).toContain("preserved");
    // The resume quote is right, but keeping the first attempt's opening as well would play the phrase twice.
    const doubled = { ...cut, start: 5.75, end: cleanEnd, resumeWith };
    const repeat = { words: "The new model from DeepSeek", before: { start: 5, end: 5.6 }, after: { start: 7, end: 7.6 } };
    const checked = JSON.parse(await call("dialogue_check_join", { version: tl.version, cuts: [{ start: doubled.start, end: doubled.end, resumeWith }] }));
    expect(checked.joins[0]).toMatchObject({ status: "unchanged", resumeAtOriginalEnd: "matches", repeatAtJoin: repeat });
    const saves = () => mock.requests.filter(r => r.path.endsWith("/dialogue-cuts")).length;
    const before = saves();
    expect(JSON.parse(await apply([doubled]))).toMatchObject({ needsRevision: true, disputedEdges: [{ repeat }] });
    expect(saves()).toBe(before);
    await apply([{ ...doubled, keepRepeat: repeat.words }]);
    expect(saves()).toBe(before + 1);
    // Finishing a production cut before both takes leaves a restart wholly in the kept recording.
    const production = { start: 3.6, end: 5, kind: "coaching", decision: "cut", reason: "Remove the direction." };
    const pickup = { words: repeat.words, side: "end", first: { start: 5, end: 5.6 }, second: { start: 6, end: 6.6 } };
    expect(JSON.parse(await call("dialogue_check_join", { version: tl.version, start: production.start, end: production.end })))
      .toMatchObject({ pickupRepeats: [pickup] });
    expect(JSON.parse(await apply([production], { only: undefined }))).toMatchObject({ needsRevision: true, disputedEdges: [{ pickup }] });
    expect(saves()).toBe(before + 1);
    await apply([{ ...production, keepRepeat: [repeat.words] }], { only: undefined });
    expect(saves()).toBe(before + 2);
  } finally { Object.assign(mock.state, original); await editor.close(); }
});

it("lists a silence the pauses miss with what its picture does, and reports it when a saved part leaves it in", async () => {
  const original = { extra: mock.state.extra, waveform: mock.state.waveform, timeline: mock.state.timeline, media: mock.state.project.media,
    transcripts: mock.state.transcripts };
  const task = Task.parse({ id: "typed-note", state: "running", projectId: mock.state.project.id, kind: "edit", agent: "claude",
    instruction: "/first-cut-dialogue", createdBy: { type: "human", name: "Editor" } });
  const editor = await connect(task.id, undefined, task);
  // The screen recording began three seconds before the camera, whose microphone carries the dialogue.
  mock.state.project.media = [...original.media, { id: "m3", kind: "video", name: "screen.mp4", path: "screen.mp4", duration: 120, fps: 30, width: 3840, height: 2160 }];
  const tl = emptyTimeline(mock.state.project.id);
  tl.tracks[0]!.clips = [makeMediaClip("m3", 3, 33, 0, { volume: 0 })];
  tl.tracks.push({ ...tl.tracks[0]!, id: "camera", name: "Camera", clips: [makeMediaClip("m1", 0, 30, 0)] });
  mock.state.timeline = tl;
  const line = (start: number, text: string) => text.split(" ").map((word, i) => ({ text: word, start: start + i * .25, end: start + i * .25 + .2 }));
  // Eight seconds without a word while a note is typed. The keys register as voice.
  const words = [...line(.5, "This just works."), ...line(2.6, "You can add a text note."), ...line(12.25, "You have signatures.")];
  const typing = [{ start: 5.7, end: 6.2 }, { start: 6.8, end: 8.5 }, { start: 8.8, end: 10.2 }];
  const segments = [{ id: "s", text: words.map(w => w.text).join(" "), words, start: .5, end: words.at(-1)!.end }];
  mock.state.transcripts = { m1: { id: "t1", mediaId: "m1", segments } };
  mock.state.waveform = (mediaId, from, to, points) => ({ mediaId, from, to, peaks: Array(points).fill(.001), rms: Array(points).fill(.001) });
  mock.state.extra = (req, res) => {
    const reply = req.path.endsWith("/dialogue-cuts") ? { changes: [] }
      : req.path.endsWith("/dialogue-detections") ? { segments, acoustic: [], speechActivity: [{ start: .5, end: 4 }, ...typing, { start: 12.25, end: 13.05 }] }
      : req.path.endsWith("/picture-activity") ? { windows: (req.body as { windows: Array<{ mediaId: string; from: number; to: number }> }).windows.map(w =>
          ({ ...w, changedFrames: 59, frames: 246, largestArea: .27, typicalArea: .0004, largestAt: w.from + .2, lastChangeAt: w.to - .1 })) }
      : undefined;
    if (!reply) return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(reply));
    return true;
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await editor.callTool({ name, arguments: args });
    expect(result.isError, textOf(result as CallToolResult)).toBeFalsy();
    return JSON.parse(textOf(result as CallToolResult));
  };
  try {
    const page = await call("dialogue_scan", { mediaId: "m1", from: 0, until: 30 });
    const end = words.findLast(w => w.text === "note.")!.end;
    const inside = page.pauses.map((p: { remove: { start: number; end: number } }) => p.remove).filter((r: { start: number; end: number }) => r.start >= end && r.end <= 12.25);
    expect(Math.max(0, ...inside.map((r: { start: number; end: number }) => r.end - r.start))).toBeLessThan(2);
    expect(page.silences.filter((s: { open?: string }) => !s.open)).toEqual([{ start: end, end: 12.25, seconds: expect.closeTo(12.25 - end, 3),
      after: "note.", before: "You", voiceSeconds: 3.6, maxPeakDb: -60, picture: [
        { mediaId: "m3", changedFrames: 59, frames: 246, typicalAreaPct: .04, largestAreaPct: 27, largestAt: expect.closeTo(end + .2, 3), lastChangeAt: 12.15 },
        { mediaId: "m1", changedFrames: 59, frames: 246, typicalAreaPct: .04, largestAreaPct: 27, largestAt: expect.closeTo(end + .2, 3), lastChangeAt: 12.15 }] }]);
    // One request covers the page, and it asks for the screen on its own clock.
    const asked = mock.requests.filter(r => r.path.endsWith("/picture-activity"));
    expect(asked).toHaveLength(1);
    expect((asked[0]!.body as { windows: unknown[] }).windows).toContainEqual({ mediaId: "m3", from: expect.closeTo(end + 3, 3), to: 15.25 });

    const apply = (cuts: object[]) => call("dialogue_apply_cuts", { version: tl.version, description: "Tightened the tour", range: { start: 0, end: 30 }, cuts });
    const pause = { kind: "pause", picture: "safe", reason: "Static page." };
    // The undecided passage stays in the edit and is reported for the next decision.
    const left = await apply([{ ...pause, start: 1.4, end: 2.5, decision: "cut" }]);
    expect(left.keptSilences).toContainEqual(expect.objectContaining({ after: "note.", before: "You" }));
    // Cut to the result, staged for the editor or kept on purpose, it is decided and not reported.
    for (const decision of ["cut", "review"]) {
      expect((await apply([{ ...pause, start: end + .3, end: 11.95, decision }])).keptSilences).toBeUndefined();
    }
    expect((await apply([{ ...pause, start: 1.4, end: 2.5, decision: "cut" }, { ...pause, start: end + .3, end: 11.95, decision: "keep" }])).keptSilences).toBeUndefined();
  } finally {
    mock.state.project.media = original.media;
    Object.assign(mock.state, { extra: original.extra, waveform: original.waveform, timeline: original.timeline, transcripts: original.transcripts });
    await editor.close();
  }
});

describe("checking a short piece of dialogue kept between cuts", () => {
  const word = { text: "we", start: 2.98, end: 3.18 };
  const aside = { kind: "coaching", decision: "cut", start: 1, end: 3, reason: "Remove the direction." };
  const pause = { kind: "pause", decision: "cut", start: 3.4, end: 4.7, reason: "Tighten the lead-in." };

  it.each([
    { title: "returns conflicting word times before saving either cut", conflict: true },
    { title: "checks the word after a cut made in an earlier batch", earlierCut: true, conflict: true, heardLater: true },
    { title: "accepts a softly spoken word in the retained footage", spoken: true },
    { title: "accepts a quiet word when the rest of the recording is just as soft", quietMic: true },
    { title: "keeps a faint word confirmed by the cached speech reading", heardHere: true },
    { title: "leaves a short wordless reaction alone", wordless: true },
    { title: "respects an explicit keep on a quiet word", keep: true },
    { title: "respects a protected moment in the picture", protect: true },
    { title: "leaves the plan alone when levels are unavailable", noLevels: true },
    { title: "lets a second audible track carry the start of the kept word", secondMic: "audible" },
    { title: "ignores a muted second track when checking the dialogue", secondMic: "muted", conflict: true },
    { title: "uses stream-zero measurements only for stream-zero dialogue", otherStream: true },
  ])("$title", async ({ earlierCut, conflict, spoken, quietMic, heardLater, heardHere, wordless, keep, protect, noLevels, secondMic, otherStream }) => {
    const original = { timeline: mock.state.timeline, transcripts: mock.state.transcripts, waveform: mock.state.waveform, extra: mock.state.extra };
    const editor = await connect();
    const tl = emptyTimeline(mock.state.project.id);
    tl.tracks[0]!.clips = earlierCut
      ? [makeMediaClip("m1", 0, 1, 0), makeMediaClip("m1", 3, 8, 1)]
      : [makeMediaClip("m1", 0, 8, 0)];
    if (secondMic) {
      tl.tracks[1]!.clips = [makeMediaClip("m2", 0, .15, 3)];
      tl.tracks[1]!.muted = secondMic === "muted";
    }
    if (otherStream) Object.assign(tl.tracks[0]!.clips[0]!, { audioStream: 1 });
    mock.state.timeline = tl;
    const words = [{ text: "Ready.", start: .2, end: .74 }, { text: "Reset.", start: 1.4, end: 1.8 },
      ...(wordless ? [] : [word]), { text: "begin.", start: 5, end: 5.28 }];
    const segment = { id: "s", start: .2, end: 5.28, text: words.map(w => w.text).join(" "), words };
    mock.state.transcripts = { m1: { id: "t1", mediaId: "m1", segments: [segment] } };
    const speech = [words[0]!, words[1]!, { start: 4.76, end: 5.28 }];
    mock.state.waveform = (mediaId, from, to, points) => {
      const levels = Array.from({ length: points }, (_, i) => {
        const t = from + (i + .5) * (to - from) / points;
        if ((spoken || quietMic || heardHere) && t >= word.start && t < word.end) return spoken ? .02 : .002;
        if (speech.some(s => s.start <= t && t < s.end)) return quietMic ? .002 : .15;
        return .0004;
      });
      return { mediaId, from, to, peaks: levels, ...!noLevels && { rms: levels, speechActivity: speech } };
    };
    const later = { text: word.text, start: 4.78, end: 4.94 };
    mock.state.extra = (req, res) => {
      const read = req.path.endsWith("/dialogue-detections") && (req.body as { keptSide?: { cachedOnly?: boolean } }).keptSide?.cachedOnly;
      const heard = heardHere ? [word] : [later];
      const reply = read && (heardHere || heardLater) ? { segments: [{ ...segment, id: "kept", words: heard }], speechActivity: [], acoustic: [] }
        : req.path.endsWith("/dialogue-cuts") ? { changes: [] } : undefined;
      if (!reply) return false;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(reply));
      return true;
    };
    try {
      const cuts = earlierCut ? [{ ...pause, start: 1.4, end: 2.7 }] : [aside, pause];
      if (keep || protect) cuts.push({ ...pause, start: 3, end: 3.4, decision: keep ? "keep" : "cut",
        ...(protect && { picture: "protect" }), reason: "Hold the reaction." });
      const apply = async (cuts: object[]) => {
        const result = await editor.callTool({ name: "dialogue_apply_cuts", arguments: { version: tl.version, description: "Trim the lead-in.", cuts } }) as CallToolResult;
        expect(result.isError, textOf(result)).toBeFalsy();
        return JSON.parse(textOf(result));
      };
      const response = await apply(cuts);
      const saves = () => mock.requests.filter(r => r.path.endsWith("/dialogue-cuts"));
      if (conflict) {
        expect(response).toMatchObject({ needsRevision: true, disputedEdges: [{
          start: earlierCut ? 1 : 3, end: earlierCut ? 1.4 : 3.4,
          quietKeptWord: { word: word.text, mediaId: "m1", source: { start: word.start, end: word.end },
            retainedSource: { start: 3, end: 3.4 }, peakRmsDbfs: -68,
            ...(heardLater && { heardNearby: { start: later.start, end: later.end } }) },
        }] });
        const evidence = response.disputedEdges[0].quietKeptWord;
        expect(evidence.nearbySound.start).toBeCloseTo(4.76, 2);
        expect(evidence.nearbySound.end).toBeGreaterThan(later.start);
        if (!heardLater) expect(evidence.heardNearby).toBeUndefined();
        expect(saves()).toHaveLength(0);
        if (!earlierCut) {
          expect((await apply([{ ...aside, end: pause.end }])).needsRevision).toBeUndefined();
          expect(saves()).toHaveLength(1);
        }
      } else {
        expect(response.needsRevision).toBeUndefined();
        expect(saves()).toHaveLength(1);
      }
    } finally {
      Object.assign(mock.state, original);
      await editor.close();
    }
  });
});

it("reports the pauses and doubled words a saved part still plays, and trims a pause named by the word it follows", async () => {
  const original = { extra: mock.state.extra, waveform: mock.state.waveform, timeline: mock.state.timeline, transcripts: mock.state.transcripts };
  const editor = await connect();
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "typing";
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 10, 0)];
  mock.state.timeline = tl;
  // “have” is said twice, and 0.9 s pass before “signatures.”: under the second the editor's setting trims by itself.
  const words = [{ text: "a", start: .5, end: .9 }, { text: "note.", start: 1, end: 1.4 }, { text: "You", start: 2, end: 2.4 },
    { text: "have", start: 2.5, end: 2.9 }, { text: "have", start: 3, end: 3.4 }, { text: "signatures.", start: 4.3, end: 5.2 }, { text: "too", start: 5.3, end: 5.7 }];
  mock.state.transcripts = { m1: { id: "t1", mediaId: "m1", segments: [{ id: "s", text: words.map(w => w.text).join(" "), words, start: .5, end: 5.7 }] } };
  mock.state.waveform = (mediaId, from, to, points) => {
    const levels = Array.from({ length: points }, (_, i) => words.some(w => w.start <= from + (i + .5) * (to - from) / points && from + (i + .5) * (to - from) / points < w.end) ? .2 : .001);
    return { mediaId, from, to, peaks: levels, rms: levels, speechActivity: words.map(w => ({ start: w.start, end: w.end })) };
  };
  mock.state.extra = (req, res) => {
    if (!req.path.endsWith("/dialogue-cuts")) return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ changes: [] }));
    return true;
  };
  const apply = async (...cuts: object[]) => {
    const r = await editor.callTool({ name: "dialogue_apply_cuts", arguments: { version: tl.version, description: "Tightened the tour", range: { start: 0, end: 10 }, cuts } }) as CallToolResult;
    expect(r.isError, textOf(r)).toBeFalsy();
    return JSON.parse(textOf(r));
  };
  const tail = { kind: "pause", reason: "Room tone after the last word.", start: 6.2, end: 9.4, decision: "cut" };
  try {
    const first = await apply(tail);
    expect(first.keptPauses).toEqual([{ at: 3.4, mediaId: "m1", seconds: .9, after: "have", before: "signatures.", afterWord: 4 }]);
    expect(first.repeatedWords).toEqual([{ at: 2.5, mediaId: "m1", text: "have have", fromWord: 3, toWord: 3 }]);
    // Saved again without touching them, they are not listed a second time: a save lists what is new.
    const again = await apply(tail);
    expect(again).not.toHaveProperty("keptPauses");
    expect(again).not.toHaveProperty("repeatedWords");
    // Named by the word it follows, the pause comes down to the beat, and with the first “have” out nothing is left to report.
    const second = await apply({ kind: "retake", reason: "Doubled “have”.", mediaId: "m1", fromWord: 3, toWord: 3, decision: "cut" },
      { kind: "pause", reason: "Wait before “signatures”.", mediaId: "m1", afterWord: 4, decision: "cut" }, tail);
    expect(second).not.toHaveProperty("keptPauses");
    expect(second).not.toHaveProperty("repeatedWords");
    const sent = (mock.requests.filter(r => r.path.endsWith("/dialogue-cuts")).at(-1)!.body as { cuts: Array<{ start: number; end: number; kind: string }> }).cuts;
    expect(sent.find(c => c.kind === "pause" && c.start < 5)).toMatchObject({ start: expect.closeTo(3.55, 2), end: expect.closeTo(4.2, 2), review: false });
    expect(second.gate.decisions).toContainEqual(expect.objectContaining({ words: "pause after “have”", outcome: "cut" }));
  } finally {
    Object.assign(mock.state, original);
    await editor.close();
  }
});

it("returns the quiet words between two pause cuts at their saved timeline position", async () => {
  const original = { extra: mock.state.extra, waveform: mock.state.waveform, timeline: mock.state.timeline, transcripts: mock.state.transcripts };
  const editor = await connect();
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "before-pauses";
  tl.tracks[0]!.clips = [makeMediaClip("m1", 10, 20, 0)];
  mock.state.timeline = tl;
  const words = [
    { text: "Watch.", start: 10.4, end: 11 }, { text: "one", start: 12, end: 12.3 },
    { text: "second", start: 12.3, end: 12.7 }, { text: "Ready.", start: 14.6, end: 15.2 },
  ];
  const segments = [{ id: "s", text: "Watch. one second Ready.", words, start: 10.4, end: 15.2 }];
  mock.state.transcripts = { m1: { id: "t1", mediaId: "m1", segments } };
  mock.state.waveform = (mediaId, from, to, points) => {
    const rms = Array.from({ length: points }, (_, i) => {
      const t = from + (i + .5) * (to - from) / points;
      if (!words.some(w => w.start <= t && t < w.end)) return .001;
      return t >= 12 && t < 12.7 ? .004 : .1;
    });
    return { mediaId, from, to, peaks: rms, rms };
  };
  const after = emptyTimeline(mock.state.project.id);
  after.version = "trimmed-pauses";
  after.tracks[0]!.clips = [makeMediaClip("m1", 10, 11.2, 0), makeMediaClip("m1", 11.8, 12.9, 1.2), makeMediaClip("m1", 14.4, 20, 2.3)];
  mock.state.extra = (req, res) => {
    const data = req.path.endsWith("/dialogue-cuts") ? { changes: [], head: after.version }
      : req.path.endsWith("/timeline") && req.query.get("version") === after.version ? { timeline: after } : undefined;
    if (!data) return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
    return true;
  };
  const pause = { kind: "pause", reason: "Trim the wait.", decision: "cut" };
  const apply = async (keep = false, only?: string, session = editor) => {
    const cuts = [{ ...pause, start: 1.2, end: 1.8 },
      ...(keep ? [{ ...pause, kind: "coaching", decision: "keep", start: 2, end: 2.7 }] : []),
      { ...pause, start: 2.9, end: 4.4 }];
    const r = await session.callTool({ name: "dialogue_apply_cuts", arguments: { version: tl.version, description: "Trimmed pauses.", cuts, only } }) as CallToolResult;
    expect(r.isError, textOf(r)).toBeFalsy();
    return JSON.parse(textOf(r));
  };
  try {
    expect((await apply(true)).keptQuietPhrases).toBeUndefined();
    expect((await apply(false, "pause")).keptQuietPhrases).toBeUndefined();
    const { keptQuietPhrases, continueFrom } = await apply();
    expect(keptQuietPhrases).toEqual([{ at: 1.4, mediaId: "m1", start: 12, end: 12.7,
      text: "one second", fromWord: 1, toWord: 2, levelDbfs: -48, beforeDbfs: -20, afterDbfs: -20 }]);
    const { mediaId, fromWord, toWord } = keptQuietPhrases[0];
    const checked = await editor.callTool({ name: "dialogue_check_join", arguments: { version: continueFrom, mediaId, fromWord, toWord } }) as CallToolResult;
    expect(checked.isError, textOf(checked)).toBeFalsy();
    const join = JSON.parse(textOf(checked));
    expect(join.words).toBe("one second");
    // The two quiet words now play at 1.4–2.1 s, between the end of “Watch” at 1.0 s and the start of “Ready” at 2.5 s.
    expect(join.start).toBeGreaterThanOrEqual(1.0);
    expect(join.start).toBeLessThanOrEqual(1.4);
    expect(join.end).toBeGreaterThanOrEqual(2.1);
    expect(join.end).toBeLessThanOrEqual(2.5);
    expect((await apply()).keptQuietPhrases).toBeUndefined();
    // The saved head can still show the shot after another edit silenced its dialogue.
    after.tracks[0]!.muted = true;
    const freshSession = await connect();
    try { expect((await apply(false, undefined, freshSession)).keptQuietPhrases).toBeUndefined(); }
    finally { await freshSession.close(); }
  } finally {
    Object.assign(mock.state, original);
    await editor.close();
  }
});

it("says what the recording holds between two words, in the transcript and in what a saved part still plays", async () => {
  const original = { extra: mock.state.extra, waveform: mock.state.waveform, timeline: mock.state.timeline, transcripts: mock.state.transcripts };
  const editor = await connect();
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "restart";
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 10, 0)];
  mock.state.timeline = tl;
  // “You can see… you can see all”: the transcript missed the first “see” and the second “you can”.
  const words = [{ text: "You", start: 2, end: 2.4 }, { text: "can", start: 2.5, end: 2.9 }, { text: "see", start: 4.6, end: 5 }, { text: "all", start: 5.05, end: 5.3 }];
  const missed = [{ start: 3.1, end: 3.5 }, { start: 4.2, end: 4.5 }];
  mock.state.transcripts = { m1: { id: "t1", mediaId: "m1", segments: [{ id: "s", text: words.map(w => w.text).join(" "), words, start: 2, end: 5.3 }] } };
  mock.state.waveform = (mediaId, from, to, points) => {
    const levels = Array.from({ length: points }, (_, i) => [...words, ...missed].some(w => w.start <= from + (i + .5) * (to - from) / points && from + (i + .5) * (to - from) / points < w.end) ? .2 : .001);
    return { mediaId, from, to, peaks: levels, rms: levels, speechActivity: words.map(w => ({ start: w.start, end: w.end })) };
  };
  mock.state.extra = (req, res) => {
    if (!req.path.endsWith("/dialogue-cuts")) return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ changes: [] }));
    return true;
  };
  const apply = async (...cuts: object[]) => {
    const r = await editor.callTool({ name: "dialogue_apply_cuts", arguments: { version: tl.version, description: "Tightened", range: { start: 0, end: 10 }, cuts } }) as CallToolResult;
    expect(r.isError, textOf(r)).toBeFalsy();
    return JSON.parse(textOf(r));
  };
  try {
    const read = textOf(await editor.callTool({ name: "transcript_get", arguments: { mediaId: "m1" } }) as CallToolResult);
    expect(read.split("\n").slice(1)).toEqual(["#0 2.00-2.40 You", "#1 2.50-2.90 can",
      "  · 1.70 s gap, 0.70 s of it sound at speaking level that no word explains (3.10–3.50, 4.20–4.50)", "#2 4.60-5.00 see", "#3 5.05-5.30 all"]);
    // Trimmed as a pause by the word it follows, the sound in it comes out too, and the gate says so.
    const trimmed = await apply({ kind: "pause", reason: "Wait before “see”.", mediaId: "m1", afterWord: 1, decision: "cut" });
    expect(trimmed.gate.decisions).toEqual([expect.objectContaining({ outcome: "cut",
      evidence: "This pause holds 0.70 s of sound at speaking level that no word explains (3.10–3.50, 4.20–4.50 s in m1). It comes out with the pause." })]);
    expect(trimmed).not.toHaveProperty("unexplainedSound");
    // Cut in seconds up to the quiet before the second “you can”, that take's start still plays before “see”.
    const partly = await apply({ kind: "pause", reason: "Wait before “see”.", start: 3, end: 4.1, decision: "cut" });
    expect(partly.unexplainedSound).toEqual([{ at: 4.2, mediaId: "m1", seconds: .3, after: "can", before: "see", sourceSeconds: [4.2, 4.5] }]);
  } finally {
    Object.assign(mock.state, original);
    await editor.close();
  }
});

it("counts a silence as decided when its keep names words or its range is protected for the picture", async () => {
  const original = { extra: mock.state.extra, waveform: mock.state.waveform, timeline: mock.state.timeline, transcripts: mock.state.transcripts };
  const editor = await connect();
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "typing";
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 10, 0)];
  mock.state.timeline = tl;
  // 3.6 s without a word between “note.” and “You”, and a shorter pause before “signatures.”.
  const words = [{ text: "a", start: .5, end: .9 }, { text: "note.", start: 1, end: 1.4 }, { text: "You", start: 5, end: 5.4 },
    { text: "have", start: 5.5, end: 5.9 }, { text: "signatures.", start: 7, end: 7.6 }];
  mock.state.transcripts = { m1: { id: "t1", mediaId: "m1", segments: [{ id: "s", text: words.map(w => w.text).join(" "), words, start: .5, end: 7.6 }] } };
  mock.state.waveform = (mediaId, from, to, points) => {
    const levels = Array.from({ length: points }, (_, i) => words.some(w => w.start <= from + (i + .5) * (to - from) / points && from + (i + .5) * (to - from) / points < w.end) ? .2 : .001);
    return { mediaId, from, to, peaks: levels, rms: levels, speechActivity: words.map(w => ({ start: w.start, end: w.end })) };
  };
  mock.state.extra = (req, res) => {
    if (!req.path.endsWith("/dialogue-cuts")) return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ changes: [] }));
    return true;
  };
  const apply = async (...cuts: object[]) => {
    const r = await editor.callTool({ name: "dialogue_apply_cuts", arguments: { version: tl.version, description: "Tightened the tour", range: { start: 0, end: 10 }, cuts } }) as CallToolResult;
    expect(r.isError, textOf(r)).toBeFalsy();
    return JSON.parse(textOf(r));
  };
  const pause = { kind: "pause", reason: "He is typing the note." };
  const cut = { ...pause, start: 6.1, end: 6.8, decision: "cut" };
  try {
    // The tool reports the quiet gap and submits only the requested removal.
    const alone = await apply(cut);
    expect(alone.keptSilences).toContainEqual(expect.objectContaining({ after: "note.", before: "You" }));
    // Kept on purpose by naming the words either side of it: it stays whole, and nothing is reported.
    const named = await apply({ ...pause, decision: "keep", mediaId: "m1", fromWord: 1, toWord: 2 }, cut);
    expect(named.keptSilences).toBeUndefined();
    // Marked for removal but protected for what the picture does: Scarlet keeps it, and it is decided.
    const guarded = await apply({ ...pause, start: 1.6, end: 4.8, decision: "cut", picture: "protect" }, cut);
    expect(guarded.keptSilences).toBeUndefined();
    const mine = expect.objectContaining({ start: 6.1, end: 6.8, review: false });
    expect(mock.requests.filter(r => r.path.endsWith("/dialogue-cuts")).map(r => (r.body as { cuts: unknown[] }).cuts)).toEqual([
      [mine], [mine], [mine]]);
  } finally {
    Object.assign(mock.state, original);
    await editor.close();
  }
});

it("keeps ordinary timeline tools available after opening a workflow or running the first-pass command", async () => {
  const previous = { timeline: mock.state.timeline, skills: mock.state.skills };
  const task = Task.parse({ id: "open-tools", state: "running", projectId: mock.state.project.id, kind: "edit", agent: "claude",
    instruction: "/first-cut-dialogue", createdBy: { type: "human", name: "Editor" } });
  const editor = await connect(task.id, undefined, task);
  mock.state.skills = [{ id: "guide", name: "first-cut-dialogue", description: "Guide", content: "Inspect the footage.",
    enabled: true, scope: "team", ownerId: null, projectId: null, agents: [], version: 1 }];
  const tl = emptyTimeline(task.projectId);
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 6, 0)];
  mock.state.timeline = tl;
  try {
    expect((await editor.callTool({ name: "skills_list", arguments: { skillId: "guide" } })).isError).toBeFalsy();
    expect((await editor.callTool({ name: "timeline_propose", arguments: { intent: "suggestion", description: "Shorten this take",
      ops: [{ op: "rippleDelete", start: 1, end: 2 }] } })).isError).toBeFalsy();
    expect((await editor.callTool({ name: "timeline_first_cut", arguments: { intent: "alternative", mediaId: "m1",
      keep: [{ start: .5, end: 1 }, { start: 2, end: 5 }], description: "Alternate assembly" } })).isError).toBeFalsy();
  } finally { Object.assign(mock.state, previous); await editor.close(); }
});

it("accepts only bounded pause decisions for the local dialogue shortcut", async () => {
  // The stored shortcut applies even when the request contains an inline command.
  const task = Task.parse({ id: "local-pauses", state: "running", projectId: mock.state.project.id, kind: "edit", agent: "claude",
    instruction: "About this beat /tighten-pauses-here", context: { dialogueOperation: "local-pauses", time: 1, skillIds: [dialogueSkill.id] }, createdBy: { type: "human", name: "Editor" } });
  const scoped = await connect(task.id, undefined, task);
  const original = { extra: mock.state.extra, timeline: mock.state.timeline, skills: mock.state.skills };
  const timeline = emptyTimeline(mock.state.project.id);
  timeline.tracks[0]!.clips = [makeMediaClip("m1", 0, 6, 0)];
  mock.state.timeline = timeline;
  mock.state.skills = [dialogueSkill];
  mock.state.extra = (req, res) => {
    if (!req.path.endsWith("/dialogue-cuts")) return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ changes: [], head: timeline.version }));
    return true;
  };
  try {
    const args = { version: timeline.version, description: "Tighten the quiet beat", cuts: [] };
    const call = (extra: Record<string, unknown>) => scoped.callTool({ name: "dialogue_apply_cuts", arguments: { ...args, ...extra } });
    const missing = await call({}) as CallToolResult;
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("Supply the local timeline range for the pause edit.");
    const range = { start: .5, end: 2 };
    const retake = await call({ range, cuts: [{ ...range, kind: "retake", decision: "cut", reason: "Repeat" }] }) as CallToolResult;
    expect(textOf(retake)).toContain("Remove the retake decisions.");
    expect(textOf(await call({ range, cuts: [{ ...range, kind: "pause", decision: "keep", reason: "Intentional beat" }] }) as CallToolResult)).toContain("preserved");
    const ripple = (ops: object[]) => scoped.callTool({ name: "timeline_propose", arguments: {
      range, ops, intent: "suggestion", description: "Tighten the selected exchange",
    } });
    expect((await ripple([{ op: "rippleDelete", start: .6, end: 1.2 }, { op: "rippleDelete", start: 1.7, end: 1.9 }])).isError).toBe(true);
    expect(textOf(await ripple([{ op: "rippleDelete", start: .8, end: 1.2 }]))).toContain("classified pauses");
    expect(textOf(await scoped.callTool({ name: "dialogue_check_repeats", arguments: { version: timeline.version } }))).toContain("only tightens local pauses");
    const saved = await call({ range, cuts: [{ start: .8, end: 1.2, kind: "pause", decision: "review", reason: "Tighten this beat." }] });
    expect(saved.isError, textOf(saved)).toBeFalsy();
    expect(mock.requests.findLast(req => req.path.endsWith("/dialogue-cuts"))?.body).toMatchObject({ range });
    expect(textOf(await call({ range: { start: 0, end: 5 }, cuts: [] }))).toContain("Stay inside the selected timeline range");
  } finally {
    Object.assign(mock.state, original);
    await scoped.close();
  }
});

it("submits only the agent's selected cuts and reviews, including when it used context outside the scanner", async () => {
  const original = { extra: mock.state.extra, timeline: mock.state.timeline };
  const tl = emptyTimeline(mock.state.project.id);
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 12, 0)];
  mock.state.timeline = tl;
  const context = { version: tl.version, changeId: "prior", cutIndex: 0, time: 1, end: 10, noteIds: ["note1"] };
  const task = Task.parse({ id: "chosen-edits", projectId: tl.projectId, kind: "edit", agent: "claude", state: "running",
    instruction: "/first-cut-dialogue", context, createdBy: { type: "human", name: "Editor" } });
  const editor = await connect(task.id, undefined, task);
  mock.state.extra = (req, res) => {
    if (!req.path.endsWith("/dialogue-cuts")) return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ changes: [] }));
    return true;
  };
  try {
    const project = await editor.callTool({ name: "project_get", arguments: {} });
    expect(JSON.parse(textOf(project).split("\n\n").at(-1)!)).toMatchObject({ editContext: context });
    const plan = [
      { start: 1, end: 2, kind: "retake", decision: "cut", reason: "The pickup stops mid-sentence." },
      { start: 3, end: 4, kind: "coaching", decision: "cut", picture: "uncertain", reason: "The editor selected the director’s cue for removal." },
      { start: 4, end: 5, kind: "filler", decision: "keep", reason: "Quoted hesitation." },
      { start: 6, end: 7, kind: "pause", decision: "review", reason: "Time to read the result." },
      { start: 8, end: 9, kind: "pause", decision: "cut", picture: "protect", reason: "Protected screen action." },
    ];
    const apply = (cuts: object[]) => editor.callTool({ name: "dialogue_apply_cuts", arguments: {
      version: tl.version, description: "Tighten the demo", cuts,
    } });
    expect((await apply([{ ...plan[0], start: 0 }])).isError).toBe(true);
    expect(mock.requests.some(r => r.path.endsWith("/dialogue-cuts"))).toBe(false);
    expect((await apply(plan)).isError).toBeFalsy();
    expect(mock.requests.find(r => r.path.endsWith("/dialogue-cuts"))?.body).toMatchObject({ cuts: [
      { start: 1, end: 2, review: false }, { start: 3, end: 4, review: false }, { start: 6, end: 7, review: true },
    ] });
  } finally { Object.assign(mock.state, original); await editor.close(); }
});

it("lets a request sent from an applied edit cut outside where that edit plays, and keeps a selected range's bounds", async () => {
  const original = { extra: mock.state.extra, timeline: mock.state.timeline };
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "applied";
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 12, 0)];
  mock.state.timeline = tl;
  const rippled: unknown[] = [];
  mock.state.extra = (req, res) => {
    let result;
    if (req.path.endsWith("/dialogue-cuts")) result = { changes: [] };
    else if (req.method === "POST" && req.path === "/projects/prj_test/changes") {
      rippled.push((req.body as { ops: unknown }).ops);
      result = { change: { id: "chg_sentence", state: "approved", description: "Remove the sentence", fromVersion: tl.version, toVersion: "next", ranges: [] }, duration: 7, diffDescription: [] };
    } else return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
    return true;
  };
  const session = (id: string, context: object) => connect(id, undefined, Task.parse({ id, projectId: tl.projectId, kind: "edit", agent: "claude", state: "running",
    instruction: "Take out the sentence before this too.", context: { version: tl.version, ...context }, createdBy: { type: "human", name: "Editor" } }));
  // The message box was aimed at an applied cut, so the request says where that cut plays: its join at 10 s and a moment either side.
  const aimed = await session("aimed-at-edit", { changeId: "prior", editIndex: 0, editNumber: 1, time: 8.5, end: 11.5 });
  // The same times as a range the editor selected on the timeline.
  const selecting = await session("selected-range", { time: 8.5, end: 11.5 });
  const sentence = { start: 3, end: 8 };
  const cuts = (editor: Client, extra: object = {}) => editor.callTool({ name: "dialogue_apply_cuts", arguments: { version: tl.version, description: "Remove the sentence before the cut",
    cuts: [{ ...sentence, kind: "retake", decision: "cut", reason: "The sentence before the cut." }], ...extra } }) as Promise<CallToolResult>;
  const ripple = (editor: Client) => editor.callTool({ name: "timeline_propose", arguments: { intent: "requested", description: "Remove the sentence before the cut",
    ops: [{ op: "rippleDelete", ...sentence }] } }) as Promise<CallToolResult>;
  const refused = (results: CallToolResult[]) => results.filter(r => r.isError).map(textOf);
  try {
    // The sentence ends before that range starts. The range is the edit the request is about, not a fence around it.
    expect(refused([await cuts(aimed), await cuts(aimed, { range: sentence }), await ripple(aimed)])).toEqual([]);
    expect(mock.requests.filter(r => r.path.endsWith("/dialogue-cuts")).map(r => r.body)).toMatchObject([{ cuts: [sentence] }, { cuts: [sentence] }]);
    expect(rippled).toEqual([[{ op: "rippleDelete", ...sentence }]]);
    // A range the editor selected still bounds what the request may remove.
    expect(refused([await cuts(selecting), await cuts(selecting, { range: sentence }), await ripple(selecting)])).toEqual([
      "Error: cuts 0 fall outside the range 8.5–11.5 s.", "Error: Stay inside the selected timeline range.",
      "Error: Ripple operations must stay inside the selected timeline range as it shortens."]);
  } finally {
    Object.assign(mock.state, original);
    await aimed.close();
    await selecting.close();
  }
});

it("checks an optional production quote and leaves unselected pauses out of the plan", async () => {
  const original = { extra: mock.state.extra, timeline: mock.state.timeline, waveform: mock.state.waveform };
  const tl = emptyTimeline(mock.state.project.id);
  tl.tracks[1]!.clips = [makeMediaClip("m1", 0, 6, 0)];
  mock.state.timeline = tl;
  const words = ["Mark", "that", "for", "editing."].map((text, i) => ({ start: 1 + i/4, end: 1.2 + i/4, text }));
  const segments = [{ id: "s", text: "Mark that for editing.", start: 1, end: 1.95, words }];
  const speechActivity = [{ start: 1, end: 1.95 }];
  mock.state.waveform = (mediaId, from, to, points) => ({ mediaId, from, to, peaks: Array(points).fill(.001), rms: Array(points).fill(.001) });
  mock.state.extra = (req, res) => {
    if (!req.path.endsWith("/dialogue-detections") && !req.path.endsWith("/dialogue-cuts")) return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.path.endsWith("/dialogue-cuts") ? { changes: [] } : { segments, acoustic: [], speechActivity }));
    return true;
  };
  const task = Task.parse({ id: "mixed-mic", state: "running", projectId: tl.projectId, kind: "edit", agent: "claude",
    instruction: "/first-cut-dialogue", createdBy: { type: "human", name: "Editor" } });
  const editor = await connect(task.id, undefined, task);
  try {
    expect((await editor.callTool({ name: "dialogue_scan", arguments: { mediaId: "m1", until: 6 } })).isError).toBeFalsy();
    const cut = { start: .96, end: 2, kind: "coaching", decision: "cut", productionQuote: segments[0]!.text, reason: "Spoken edit note." };
    const apply = (extra: Record<string, unknown>) => editor.callTool({ name: "dialogue_apply_cuts",
      arguments: { version: tl.version, description: "Remove the spoken note", cuts: [cut], ...extra } });
    const submitted = () => mock.requests.filter(r => r.path.endsWith("/dialogue-cuts")).at(-1)?.body;
    expect((await apply({ only: "coaching" })).isError).toBeFalsy();
    expect(submitted()).toMatchObject({ cuts: [{ start: .96, end: 2, review: false }] });
    expect((await apply({ range: { start: .5, end: 3 } })).isError).toBeFalsy();
    expect(submitted()).toMatchObject({ cuts: [{ start: .96, end: 2, review: false }] });
    const before = mock.requests.filter(r => r.path.endsWith("/dialogue-cuts")).length;
    const wrongQuote = await apply({ cuts: [{ ...cut, productionQuote: "Show the next shot." }] });
    expect(JSON.parse(textOf(wrongQuote))).toMatchObject({ needsRevision: true, disputedEdges: [{ start: .96, end: 2 }] });
    expect(mock.requests.filter(r => r.path.endsWith("/dialogue-cuts"))).toHaveLength(before);
  } finally { Object.assign(mock.state, original); await editor.close(); }
});

/** Loud (-14 dBFS) wherever the test transcript (or `speech`) has a word, room tone (-60 dBFS) between words. */
function spokenWaveform(mediaId: string, from: number, to: number, points: number, speech = transcript.segments.flatMap(s => s.words)) {
  const levels = Array.from({ length: points }, (_, i) => {
    const t = from + (i + .5) * (to - from) / points;
    return speech.some(w => w.start <= t && t < w.end) ? .2 : .001;
  });
  return { mediaId, from, to, peaks: levels, rms: levels, speechActivity: speech.map(w => ({ start: w.start, end: w.end })) };
}

it("says how far the checked joins reach during a task, so the cut's figure moves before the first part is saved", async () => {
  const original = { timeline: mock.state.timeline, waveform: mock.state.waveform };
  const editor = await connect("task-joins");
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "joins";
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 6, 0)];
  mock.state.timeline = tl;
  mock.state.waveform = spokenWaveform;
  const reached = () => mock.state.events.filter(e => e.data?.kind === "join_progress").map(e => e.data);
  try {
    const from = reached().length;
    await editor.callTool({ name: "dialogue_check_join", arguments: { version: tl.version, start: 1.06, end: 2 } });
    expect(reached().slice(from)).toEqual([{ kind: "join_progress", mediaId: "m1", through: 2 }]);
    // A list reports its furthest join once. A join that reaches no further than the last says nothing.
    await editor.callTool({ name: "dialogue_check_join", arguments: { version: tl.version, cuts: [{ start: 1.06, end: 2 }, { start: 4, end: 5 }, { start: 2.2, end: 3.5 }] } });
    await editor.callTool({ name: "dialogue_check_join", arguments: { version: tl.version, start: 1.06, end: 3.5 } });
    expect(reached().slice(from).map(d => d!.through)).toEqual([2, 5]);
    // Outside a task nobody is watching a figure.
    const alone = await connect();
    await alone.callTool({ name: "dialogue_check_join", arguments: { version: tl.version, start: 5.2, end: 5.9 } });
    expect(reached().slice(from)).toHaveLength(2);
  } finally {
    Object.assign(mock.state, original);
  }
});

it("says how far a saved part's cuts reach, so a pass that read to the end first doesn't finish the cut at its first save", async () => {
  const original = { extra: mock.state.extra, timeline: mock.state.timeline, waveform: mock.state.waveform };
  const editor = await connect("task-parts");
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "parts";
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 120, 0)];
  mock.state.timeline = tl;
  mock.state.waveform = spokenWaveform;
  mock.state.extra = (req, res) => {
    if (!req.path.endsWith("/dialogue-detections") && !req.path.endsWith("/dialogue-cuts")) return false;
    res.setHeader("Content-Type", "application/json");
    // The test transcript's words are all on the first page.
    res.end(JSON.stringify(req.path.endsWith("/dialogue-cuts") ? { changes: [] }
      : { segments: (req.body as { from: number }).from ? [] : transcript.segments, acoustic: [] }));
    return true;
  };
  const saved = () => mock.state.events.filter(e => e.data?.kind === "pass_progress").map(e => e.data);
  const save = async (start: number, end: number) => {
    const r = await editor.callTool({ name: "dialogue_apply_cuts", arguments: { version: tl.version, description: "Tighten the pauses",
      cuts: [{ start, end, kind: "pause", decision: "cut", reason: "Dead air." }] } }) as CallToolResult;
    expect(r.isError, textOf(r)).toBeFalsy();
  };
  try {
    // The whole two minutes are read before anything is saved.
    let from: number | null = 0;
    while (from !== null && from < 120) {
      from = JSON.parse(textOf(await editor.callTool({ name: "dialogue_scan", arguments: { mediaId: "m1", from } }) as CallToolResult)).nextFrom;
    }
    expect(from).toBeNull();
    // So is a minute of the other microphone, which the edit doesn't play: no cut reaches it, so it is no part of the cut.
    expect((await editor.callTool({ name: "dialogue_scan", arguments: { mediaId: "m2", from: 0, until: 60 } })).isError).toBeFalsy();
    await save(2, 2.4);
    expect(saved()).toEqual([{ kind: "pass_progress", mediaId: "m1", through: 2.4 }]);
    // The part whose cuts come within a page of where the read stopped has decided the rest of it too.
    await save(100, 100.4);
    expect(saved().at(-1)).toEqual({ kind: "pass_progress", mediaId: "m1", through: 120 });
  } finally {
    Object.assign(mock.state, original);
    await editor.close();
  }
});

it("cuts by word reference: edges go in the measured gaps, and every gate decision comes back with its evidence", async () => {
  const original = { extra: mock.state.extra, timeline: mock.state.timeline, waveform: mock.state.waveform };
  const editor = await connect();
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "words";
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 6, 0)];
  mock.state.timeline = tl;
  mock.state.waveform = spokenWaveform;
  mock.state.extra = (req, res) => {
    if (!req.path.endsWith("/dialogue-cuts")) return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ changes: [] }));
    return true;
  };
  try {
    const page = textOf(await editor.callTool({ name: "timeline_transcript", arguments: { version: tl.version, from: 2.4, to: 3, detail: "words" } }) as CallToolResult);
    expect(page).toContain("0 joins.\nmediaId m1\n2.50-2.70 #4 Um,");
    // Remove “welcome back. Um,” (#2–#4) without any dialogue scan: Scarlet measures the gaps itself.
    const ref = { mediaId: "m1", fromWord: 2, toWord: 4 };
    const check = JSON.parse(textOf(await editor.callTool({ name: "dialogue_check_join", arguments: { version: tl.version, ...ref } }) as CallToolResult));
    // “everyone” ends at 1.0 and “welcome” starts at 1.1: a 0.1 s gap splits 60/40. The retake leaves 0.10 s before the second “welcome”.
    expect(check).toMatchObject({ status: "unchanged", words: "welcome back. Um,", originalRange: { start: 1.06, end: 3.5 } });
    expect(check.alternativeWordRanges).toContainEqual(expect.objectContaining({ mediaId: "m1", fromWord: 4, toWord: 6, problems: [], dips: [] }));
    const both = await editor.callTool({ name: "dialogue_check_join", arguments: { version: tl.version, start: 1, end: 2, ...ref } }) as CallToolResult;
    expect(textOf(both)).toContain("not both");
    const missing = await editor.callTool({ name: "dialogue_check_join", arguments: { version: tl.version, mediaId: "m1", fromWord: 8, toWord: 40 } }) as CallToolResult;
    expect(textOf(missing)).toContain("outside m1's transcript (#0–#9)");
    const pause = { mediaId: "m1", afterWord: 4, leave: .35 };
    const pauseCheck = JSON.parse(textOf(await editor.callTool({ name: "dialogue_check_join", arguments: { version: tl.version, ...pause } }) as CallToolResult));
    expect(pauseCheck).toMatchObject({ words: "pause after “Um,”", originalRange: { start: 2.91, end: 3.46 } });
    const descriptions = (await editor.listTools()).tools.filter(t => t.name === "dialogue_apply_cuts" || t.name === "transcript_get");
    for (const tool of descriptions) expect(tool.description).not.toContain("${");
    // A list checks every removal in one call, in order. A range that can't be checked reports its own error.
    const listed = JSON.parse(textOf(await editor.callTool({ name: "dialogue_check_join", arguments: { version: tl.version,
      cuts: [ref, { mediaId: "m1", fromWord: 8, toWord: 40 }, { start: 4, end: 5 }, pause] } }) as CallToolResult));
    expect(listed.version).toBe(tl.version);
    expect(listed.joins).toHaveLength(4);
    expect({ version: listed.version, ...listed.joins[0] }).toEqual(check);
    expect({ version: listed.version, ...listed.joins[3] }).toEqual(pauseCheck);
    expect(listed.joins[1].error).toContain("outside m1's transcript (#0–#9)");
    expect(listed.joins[2]).toMatchObject({ originalRange: { start: 4, end: 5 } });
    const mixed = await editor.callTool({ name: "dialogue_check_join", arguments: { version: tl.version, ...ref, cuts: [ref] } }) as CallToolResult;
    expect(textOf(mixed)).toContain("either one range or a cuts list");

    const applied = await editor.callTool({ name: "dialogue_apply_cuts", arguments: { version: tl.version, description: "Remove the first attempt",
      cuts: [{ ...ref, kind: "retake", decision: "cut", reason: "The second take is cleaner." }] } }) as CallToolResult;
    expect(applied.isError).toBeFalsy();
    expect(mock.requests.find(r => r.path.endsWith("/dialogue-cuts"))?.body).toMatchObject({
      description: "Remove the first attempt", cuts: [{ start: 1.06, end: 3.5, review: false }] });
    // Both edges sit in measured silence, so the cut applies as decided; the report names the resolved words and range.
    expect(JSON.parse(textOf(applied)).gate.decisions).toEqual([{ cut: 0, kind: "retake", words: "welcome back. Um,", asked: "cut", outcome: "cut",
      range: [1.06, 3.5] }]);
    // Without measured silence beside the words, the edge falls back to word timings and Scarlet stages the cut, saying why.
    mock.state.waveform = (mediaId, from, to, points) => ({ mediaId, from, to, peaks: Array(points).fill(.2), rms: Array(points).fill(.2),
      speechActivity: [{ start: from, end: to }] });
    const deaf = await connect();
    try {
      const staged = JSON.parse(textOf(await deaf.callTool({ name: "dialogue_apply_cuts", arguments: { version: tl.version, description: "Remove it",
        cuts: [{ ...ref, kind: "retake", decision: "cut", reason: "The second take is cleaner." }] } }) as CallToolResult));
      expect(staged.gate.decisions[0]).toMatchObject({ cut: 0, outcome: "review", evidence: expect.stringContaining("No measured silence between “everyone” and “welcome”") });
    } finally { await deaf.close(); }
  } finally {
    Object.assign(mock.state, original);
    await editor.close();
  }
});

it("places a word reference beside the kept words when a pause is longer than the five seconds measured at its middle", async () => {
  const original = { timeline: mock.state.timeline, waveform: mock.state.waveform, transcripts: mock.state.transcripts };
  // A fresh session: words a session has already read stay cached for it.
  const editor = await connect();
  // Eight seconds of silence either side of “two three”, and no dialogue scan.
  const words = [{ text: "one", start: 1, end: 1.4 }, { text: "two", start: 9.4, end: 9.8 }, { text: "three", start: 10.2, end: 10.6 }, { text: "four", start: 18.6, end: 19 }];
  mock.state.transcripts = { m1: { id: "t-pause", mediaId: "m1", segments: [{ id: "s", start: 1, end: 19, text: "one two three four", words }] } };
  mock.state.waveform = (mediaId, from, to, points) => spokenWaveform(mediaId, from, to, points, words);
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "pause";
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 25, 0)];
  mock.state.timeline = tl;
  try {
    const check = JSON.parse(textOf(await editor.callTool({ name: "dialogue_check_join", arguments: { version: tl.version, mediaId: "m1", fromWord: 1, toWord: 2 } }) as CallToolResult));
    // 0.15 s after “one” and 0.10 s before “four”. The readings at the middles of the two pauses start at 3 s and end at 17 s.
    expect(check).toMatchObject({ status: "unchanged", words: "two three", sourceRange: { start: 1.55, end: 18.5 }, originalRange: { start: 1.55, end: 18.5 } });
    // Each pause was read at its middle, then at the kept word its middle reading stops short of.
    expect(mock.requests.filter(r => r.path.endsWith("/media/m1/waveform")).map(r => `${r.query.get("from")}–${r.query.get("to")}`).sort())
      .toEqual(["0–4", "12–17", "16–21", "3–8"]);
  } finally {
    Object.assign(mock.state, original);
    await editor.close();
  }
});

it("submits the chosen ranges and preserves silent picture between them across track layouts", async () => {
  const original = { extra: mock.state.extra, timeline: mock.state.timeline, waveform: mock.state.waveform };
  const media = mock.state.project.media;
  const editor = await connect();
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "frames";
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 6, 0)];
  mock.state.timeline = tl;
  mock.state.waveform = spokenWaveform;
  mock.state.extra = (req, res) => {
    if (!req.path.endsWith("/dialogue-cuts")) return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ changes: [] }));
    return true;
  };
  // Two pause cuts in the silence after “Um,”, five frames apart.
  const save = async () => {
    mock.requests.length = 0;
    const r = await editor.callTool({ name: "dialogue_apply_cuts", arguments: { version: tl.version, description: "Tighten the pause", cuts: [
      { start: 2.8, end: 3, kind: "pause", decision: "cut", reason: "Dead air." }, { start: 3.1667, end: 3.5, kind: "pause", decision: "cut", reason: "Dead air." }] } }) as CallToolResult;
    expect(r.isError, textOf(r)).toBeFalsy();
    const sent = mock.requests.find(q => q.path.endsWith("/dialogue-cuts"))!.body as { cuts: Array<{ start: number; end: number }> };
    return { sent: sent.cuts.map(c => [c.start, c.end]), gate: JSON.parse(textOf(r)).gate, prepared: mock.requests.filter(q => q.path.endsWith("/prepare")).map(q => q.path) };
  };
  try {
    // The wordless gap stays between both cuts.
    const alone = await save();
    expect(alone).toEqual({ sent: [[2.8, 3], [3.1667, 3.5]], prepared: [], gate: { unchangedCuts: 2, decisions: [] } });
    // A still laid over it has no sound and the engine keeps no transcript for it. The save is the recording's own,
    // and the engine is not asked to make one.
    mock.state.project.media = [...media, { id: "slide", kind: "image", name: "slide.png", path: "slide.png" }];
    tl.tracks[1]!.clips = [makeMediaClip("slide", 0, 6, 0)];
    expect(await save()).toEqual(alone);
    // A second microphone nobody has transcribed plays under them. Words may be said on it, so the frames stay, and
    // the save does not start its transcription and wait to find out.
    tl.tracks[1]!.clips = [makeMediaClip("m2", 0, 6, 0)];
    expect(await save()).toEqual(alone);
  } finally {
    mock.state.project.media = media;
    Object.assign(mock.state, original);
    await editor.close();
  }
});

it("measures the sound beside an edge once, also within a second of where a recording starts or ends", async () => {
  const original = { timeline: mock.state.timeline, waveform: mock.state.waveform };
  const editor = await connect();
  // The recording's first six seconds, then its last six.
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "ends";
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 6, 0), makeMediaClip("m1", 114, 120, 6)];
  mock.state.timeline = tl;
  mock.state.waveform = spokenWaveform;
  const levels = () => mock.requests.filter(r => r.path.endsWith("/media/m1/waveform")).map(r => [r.query.get("from"), r.query.get("to")]);
  try {
    // An edge 0.4 s into the recording, and one 0.4 s before its end (11.6 s on the timeline plays source 119.6 s).
    for (const [start, end, window] of [[.4, 2, ["0", "3"]], [10, 11.6, ["117", "120"]]] as const) {
      const check = async () => {
        const r = await editor.callTool({ name: "dialogue_check_join", arguments: { version: tl.version, start, end } }) as CallToolResult;
        expect(r.isError, textOf(r)).toBeFalsy();
        return JSON.parse(textOf(r));
      };
      mock.requests.length = 0;
      const first = await check();
      expect(levels()).toContainEqual(window);
      mock.requests.length = 0;
      // Checked again, the window measured the first time answers.
      expect(await check()).toEqual(first);
      expect(levels()).toEqual([]);
    }
  } finally {
    Object.assign(mock.state, original);
    await editor.close();
  }
});

it("returns a long list of checked joins whole enough to arrive: quiet joins give up their evidence first, and each join that lost some is named", async () => {
  const original = { timeline: mock.state.timeline, waveform: mock.state.waveform, transcripts: mock.state.transcripts };
  const editor = await connect();
  // Two minutes at three words a second: each word lasts 0.2 s, with 0.13 s of room tone before the next.
  const words = Array.from({ length: 360 }, (_, i) => ({ text: `word${i}`, start: Math.round((i / 3 + .05) * 1000) / 1000, end: Math.round((i / 3 + .25) * 1000) / 1000 }));
  mock.state.transcripts = { m1: { id: "t-long", mediaId: "m1", segments: [{ id: "s", start: 0, end: 120, text: words.map(w => w.text).join(" "), words }] } };
  mock.state.waveform = (mediaId, from, to, points) => spokenWaveform(mediaId, from, to, points, words);
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "long-list";
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 120, 0)];
  mock.state.timeline = tl;
  // Yield each kept-side read so a large batch exercises the concurrency limit.
  let activeReads = 0;
  let maxReads = 0;
  const detections = vi.spyOn(ScarletClient.prototype, "dialogueDetections").mockImplementation(async (_projectId, { from, to, keptSide }) => {
    if (keptSide) {
      activeReads++;
      maxReads = Math.max(maxReads, activeReads);
      await new Promise<void>(resolve => setImmediate(resolve));
      activeReads--;
    }
    const heard = words.filter(w => w.start >= from && w.end <= to);
    return { segments: [{ id: keptSide ? "kept" : "s", start: from, end: to, text: heard.map(w => w.text).join(" "), words: heard }], acoustic: [] };
  });
  // Each removal takes one word out, from the room tone before it to the room tone after. Every tenth starts inside
  // the word before instead, so Scarlet has to move that edge.
  const cut = (k: number) => ({ start: k % 10 === 5 ? k + .15 : k + .317, end: k + .65 });
  const check = async (cuts: object[]) => {
    const r = await editor.callTool({ name: "dialogue_check_join", arguments: { version: tl.version, cuts } }) as CallToolResult;
    expect(r.isError, textOf(r)).toBeFalsy();
    return textOf(r);
  };
  try {
    // The passage is scanned, so every join comes with the words around it.
    let from: number | null = 0;
    while (from !== null) from = JSON.parse(textOf(await editor.callTool({ name: "dialogue_scan", arguments: { mediaId: "m1", from } }) as CallToolResult)).nextFrom;
    // A list that fits comes back whole, as it always did.
    const short = JSON.parse(await check(Array.from({ length: 10 }, (_, k) => cut(k))));
    expect(Object.keys(short)).toEqual(["version", "joins"]);
    expect(short.joins.map((j: { status: string }) => j.status)).toEqual(Array.from({ length: 10 }, (_, k) => k === 5 ? "adjusted" : "unchanged"));
    for (const join of short.joins) {
      expect(join.audio).toHaveLength(2);
      expect(join.nearbyWords.start[0].words.length).toBeGreaterThan(10);
    }
    // A hundred don't: Claude Code withholds a result that long, and the pass would get nothing at all.
    const long = await check(Array.from({ length: 100 }, (_, k) => cut(k)));
    expect(long.length).toBeLessThanOrEqual(40_000);
    const listed = JSON.parse(long) as { joins: Array<{ status: string; start: number; end: number; audio?: unknown[]; nearbyWords?: unknown; unreadJoinAudio?: string[] }>; evidenceLeftOut: number[] };
    // Every join still says what the recording has at its edges and the range that results.
    expect(listed.joins.map(j => j.status)).toEqual(Array.from({ length: 100 }, (_, k) => k % 10 === 5 ? "adjusted" : "unchanged"));
    expect(listed.joins.every(j => j.unreadJoinAudio === undefined)).toBe(true);
    expect(maxReads).toBeGreaterThan(0);
    expect(maxReads).toBeLessThanOrEqual(8);
    expect(listed.joins[5]).toMatchObject(short.joins[5]);
    const { audio: _audio, nearbyWords: _words, ...settled } = short.joins[4];
    expect(listed.joins[4]).toEqual(settled);
    // The joins with both edges on quiet gave up their evidence first. One whose edge moved keeps the levels beside
    // it, and gives up the words around it from the end of the list back.
    const moved = listed.joins.filter(j => j.status !== "unchanged");
    expect(moved.every(j => j.audio?.length === 2)).toBe(true);
    expect(moved.at(-1)!.nearbyWords).toBeUndefined();
    expect(listed.joins.filter(j => j.status === "unchanged").some(j => j.audio || j.nearbyWords)).toBe(false);
    // The result names every join that came back without some of it, and checking one alone returns the rest.
    expect(listed.evidenceLeftOut).toEqual(listed.joins.flatMap((j, i) => j.audio && j.nearbyWords ? [] : [i]));
    expect(listed.evidenceLeftOut).not.toContain(5);
    const alone = JSON.parse(await check([cut(95)]));
    expect(alone.joins[0]).toMatchObject(listed.joins[95]!);
    expect(alone.joins[0].nearbyWords.start[0].words.length).toBeGreaterThan(10);
  } finally {
    detections.mockRestore();
    Object.assign(mock.state, original);
    await editor.close();
  }
});

it("refuses a ripple through a sounding word in the general edit tool and points to dialogue_apply_cuts", async () => {
  const original = { timeline: mock.state.timeline, waveform: mock.state.waveform };
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "side-door";
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 6, 0)];
  mock.state.timeline = tl;
  mock.state.waveform = spokenWaveform;
  const c = await connect();
  try {
    const propose = (start: number, end: number) => c.callTool({ name: "timeline_propose", arguments: { intent: "requested", fromVersion: tl.version,
      description: "Cut the filler", ops: [{ op: "rippleDelete", start, end }] } }) as Promise<CallToolResult>;
    // From inside “back.” (1.5–1.8 s) to the quiet before the second “welcome”.
    const through = await propose(1.7, 3.4);
    expect(through.isError).toBe(true);
    expect(textOf(through)).toContain("falls inside “back”");
    expect(textOf(through)).toContain("dialogue_apply_cuts");
    // The same removal from the quiet after the word goes ahead.
    expect((await propose(2.0, 3.4)).isError).toBeFalsy();
  } finally {
    Object.assign(mock.state, original);
    await c.close();
  }
});

it("refuses a whole new timeline that starts or ends a clip inside a sounding word", async () => {
  const original = { timeline: mock.state.timeline, waveform: mock.state.waveform };
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "whole-door";
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 6, 0)];
  mock.state.timeline = tl;
  mock.state.waveform = spokenWaveform;
  const c = await connect();
  try {
    // The same removal as a ripple would make, written as the timeline it leaves: two clips either side of it.
    const without = (start: number, end: number) => ({ ...tl, version: undefined, tracks: tl.tracks.map((t, i) => i ? t : { ...t,
      clips: [{ ...makeMediaClip("m1", 0, start, 0), id: "head" }, { ...makeMediaClip("m1", end, 6, start), id: "tail" }] }) });
    const propose = (start: number, end: number) => c.callTool({ name: "timeline_propose", arguments: { intent: "requested", fromVersion: tl.version,
      description: "Cut the filler", timeline: without(start, end) } }) as Promise<CallToolResult>;
    // From inside “back.” (1.5–1.8 s) to the quiet before the second “welcome”.
    const through = await propose(1.7, 3.4);
    expect(through.isError).toBe(true);
    expect(textOf(through)).toContain("clip head ends at source 1.70 s");
    expect(textOf(through)).toContain("inside “back”");
    expect(textOf(through)).toContain("dialogue_apply_cuts");
    // The same removal from the quiet after the word goes ahead.
    expect((await propose(2.0, 3.4)).isError).toBeFalsy();
  } finally {
    Object.assign(mock.state, original);
    await c.close();
  }
});

it("measures every clip edge an edit makes, whichever op makes it, and refuses one that cuts through sound", async () => {
  const original = { timeline: mock.state.timeline, waveform: mock.state.waveform };
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "any-door";
  tl.tracks[0]!.clips = [{ ...makeMediaClip("m1", 0, 6, 0), id: "whole" }];
  mock.state.timeline = tl;
  // An “uh” at 3.3–3.48 s that the transcript has no word for, 120 ms before the second “welcome”.
  mock.state.waveform = (id, from, to, points) => spokenWaveform(id, from, to, points, [...transcript.segments.flatMap(s => s.words), { text: "", start: 3.3, end: 3.48 }]);
  const c = await connect();
  try {
    const propose = (ops: object[]) => c.callTool({ name: "timeline_propose", arguments: { intent: "requested", fromVersion: tl.version, description: "Trim", ops } }) as Promise<CallToolResult>;
    // A trim that ends the clip inside “back.” (1.5–1.8 s): no ripple, and the same clipped word.
    const trimmed = await propose([{ op: "updateClip", clipId: "whole", patch: { sourceOut: 1.7 } }]);
    expect(trimmed.isError).toBe(true);
    expect(textOf(trimmed)).toContain("clip whole ends at source 1.70 s inside “back”, which is sounding there");
    expect(textOf(trimmed)).toContain("Nothing was saved");
    // A clip added so that it starts 40 ms before the “uh” ends. No word is there to split: the levels say it.
    const added = await propose([{ op: "updateClip", clipId: "whole", patch: { sourceOut: 2 } },
      { op: "addClip", trackId: "v1", clip: { id: "late", kind: "media", mediaId: "m1", sourceIn: 3.44, sourceOut: 5.5, timelineIn: 2 } }]);
    expect(added.isError).toBe(true);
    expect(textOf(added)).toContain("clip late starts at source 3.44 s inside a sound the transcript has no word for: 40 ms of it would play at -14 dBFS, and the recording is quiet at 3.49 s (-60 dBFS)");
    expect(textOf(added)).not.toContain("clip whole");
    // The same two clips with that edge on the quiet it was pointed to go ahead.
    expect((await propose([{ op: "updateClip", clipId: "whole", patch: { sourceOut: 2 } },
      { op: "addClip", trackId: "v1", clip: { id: "late", kind: "media", mediaId: "m1", sourceIn: 3.49, sourceOut: 5.5, timelineIn: 2 } }])).isError).toBeFalsy();
    // An edge the version already had is no new cut, wherever its clip moves.
    expect((await propose([{ op: "moveClip", clipId: "whole", timelineIn: 1 }])).isError).toBeFalsy();
  } finally {
    Object.assign(mock.state, original);
    await c.close();
  }
});

it("moves a first cut's edge off a piece of sound and reports it, and refuses a keep range that ends inside a word", async () => {
  const original = { waveform: mock.state.waveform };
  mock.state.waveform = (id, from, to, points) => spokenWaveform(id, from, to, points, [...transcript.segments.flatMap(s => s.words), { text: "", start: 3.3, end: 3.48 }]);
  const c = await connect();
  try {
    const cut = (keep: object[]) => c.callTool({ name: "timeline_first_cut", arguments: { intent: "requested", mediaId: "m1", keep, description: "First cut" } }) as Promise<CallToolResult>;
    const posts = () => mock.requests.filter(q => q.method === "POST" && q.path === "/projects/prj_test/changes");
    const before = posts().length;
    const saved = await cut([{ start: .1, end: 2 }, { start: 3.44, end: 5.5 }]);
    expect(saved.isError).toBeFalsy();
    expect(textOf(saved)).toContain('"movedEdges":[{"keep":1,"edge":"start","from":3.44,"to":3.49,"evidence":"40 ms of a sound the transcript has no word for played at -14 dBFS; quiet there is -60 dBFS"}]');
    expect(textOf(saved)).toContain("First edit: 2 clip(s), 3.91 s total");
    const body = ProposeChangeRequest.parse(posts().at(-1)!.body);
    expect(body.timeline!.tracks[0]!.clips[1]).toMatchObject({ sourceIn: 3.49, sourceOut: 5.5, timelineIn: expect.closeTo(1.9, 6) });
    // Which side of a word the edge was meant for is the model's call: nothing is saved, and the range is named.
    const through = await cut([{ start: .1, end: 1.7 }, { start: 3.55, end: 5.5 }]);
    expect(through.isError).toBe(true);
    expect(textOf(through)).toContain("keep[0] ends at source 1.70 s inside “back”, which is sounding there");
    expect(posts()).toHaveLength(before + 1);
  } finally {
    Object.assign(mock.state, original);
    await c.close();
  }
});

/** The test transcript while its words are still being placed: Whisper's estimates run 0.3 s early past the first two words, which alignment has placed. */
const estimated = { ...transcript, aligning: { through: 1 }, segments: transcript.segments.map(s => ({ ...s,
  words: s.words.map(w => w.end <= 1 ? w : { ...w, start: w.start - 0.3, end: w.end - 0.3 }) })) };

it("reads a transcript whose words are still being placed on the audio, and holds a cut until its words are", async () => {
  const original = { extra: mock.state.extra, timeline: mock.state.timeline, waveform: mock.state.waveform, transcripts: mock.state.transcripts };
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "aligning";
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 6, 0)];
  mock.state.timeline = tl;
  mock.state.waveform = spokenWaveform;
  mock.state.extra = (req, res) => {
    if (!req.path.endsWith("/dialogue-cuts")) return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ changes: [] }));
    return true;
  };
  mock.state.transcripts = { m1: estimated };
  const editor = await connect(undefined, undefined, undefined, undefined, 0);
  try {
    // The words and their indices can be read at once. The result says how far their times are final.
    const read = textOf(await editor.callTool({ name: "transcript_get", arguments: { mediaId: "m1", fromWord: 4, toWord: 4 } }) as CallToolResult);
    expect(read).toContain("#4 2.20-2.40 Um,");
    expect(read).toContain("Times after 1.0 s are estimates until Scarlet has placed those words on the audio; indices are final.");
    // An edge beside “Um,” needs the final times of it and the word after, so neither a check nor a save uses the estimates.
    const ref = { mediaId: "m1", fromWord: 2, toWord: 4 };
    const cut = { ...ref, kind: "retake", decision: "cut", reason: "The second take is cleaner." };
    const held = textOf(await editor.callTool({ name: "dialogue_check_join", arguments: { version: tl.version, ...ref } }) as CallToolResult);
    expect(held).toContain("Scarlet is still placing the words of m1 on the audio: their times are final up to 1 s, and this needs them up to 6 s.");
    const unsaved = await editor.callTool({ name: "dialogue_apply_cuts", arguments: { version: tl.version, description: "Remove the first attempt", cuts: [cut] } }) as CallToolResult;
    expect(textOf(unsaved)).toContain("still placing the words of m1");
    expect(mock.requests.some(r => r.path.endsWith("/dialogue-cuts"))).toBe(false);
    // Alignment finishes. The same cut now resolves from the final times, as it does on a transcript that never waited.
    mock.state.transcripts = { m1: transcript };
    await new Promise(resolve => setTimeout(resolve, 1600));
    const applied = await editor.callTool({ name: "dialogue_apply_cuts", arguments: { version: tl.version, description: "Remove the first attempt", cuts: [cut] } }) as CallToolResult;
    expect(JSON.parse(textOf(applied)).gate.decisions).toEqual([{ cut: 0, kind: "retake", words: "welcome back. Um,", asked: "cut", outcome: "cut", range: [1.06, 3.5] }]);
    expect(textOf(await editor.callTool({ name: "transcript_get", arguments: { mediaId: "m1", fromWord: 4, toWord: 4 } }) as CallToolResult)).toContain("#4 2.50-2.70 Um,");
  } finally {
    Object.assign(mock.state, original);
    await editor.close();
  }
});

it("says in a recording's profile that its words are still being placed on the audio, not that it has no transcript", async () => {
  const original = { waveform: mock.state.waveform, transcripts: mock.state.transcripts };
  mock.state.waveform = spokenWaveform;
  mock.state.transcripts = { m1: estimated };
  const editor = await connect();
  const profile = async (args: Record<string, unknown>) => JSON.parse(textOf(await editor.callTool({ name: "media_profile", arguments: args }) as CallToolResult));
  try {
    // Pauses and retakes are measured from word times, and past the first second these are still estimates.
    const whole = await profile({ mediaId: "m1", to: 6 });
    expect(whole.transcript).toBe("words are still being placed on the audio: times final up to 1 s; call again, or give `to` below 1");
    expect(whole).not.toHaveProperty("pauses");
    // The part whose words are placed is profiled now.
    expect(await profile({ mediaId: "m1", to: .7 })).toMatchObject({ range: [0, .7], words: 2, retakes: [] });
    // A range that starts past that part has nothing final to measure yet.
    expect((await profile({ mediaId: "m1", from: 2, to: 6 })).transcript).toBe("words are still being placed on the audio: times final up to 1 s; call again");
    // A recording nobody has transcribed still says that.
    expect((await profile({ mediaId: "m2", to: 6 })).transcript).toBe("none yet; transcript_get prepares it");
  } finally {
    Object.assign(mock.state, original);
    await editor.close();
  }
});

it("holds captions until the words they are timed from are placed on the audio", async () => {
  const original = { extra: mock.state.extra, timeline: mock.state.timeline, transcripts: mock.state.transcripts };
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "aligning-captions";
  tl.tracks[0]!.clips = [makeMediaClip("m1", 0, 6, 0)];
  mock.state.timeline = tl;
  mock.state.transcripts = { m1: estimated };
  const saved: Array<{ op: string; track?: { clips: Array<{ words: Array<{ text: string; start: number; end: number }> }> } }> = [];
  mock.state.extra = (req, res) => {
    if (req.method !== "POST" || req.path !== "/projects/prj_test/changes") return false;
    saved.push(...(req.body as { ops: typeof saved }).ops);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ change: { id: "chg_captions", state: "approved", description: "Captions", fromVersion: tl.version, toVersion: "captioned", ranges: [] }, duration: 6, diffDescription: [] }));
    return true;
  };
  const editor = await connect(undefined, undefined, undefined, undefined, 0);
  const generate = () => editor.callTool({ name: "captions_generate", arguments: { intent: "requested", description: "Captions" } }) as Promise<CallToolResult>;
  try {
    // A cue keeps the times it is saved with, and nothing places them again. Past the first second these are estimates.
    const held = await generate();
    expect(textOf(held)).toContain("Scarlet is still placing the words of m1 on the audio: their times are final up to 1 s, and this needs them up to 7 s.");
    expect(held.isError).toBeFalsy();
    expect(saved).toEqual([]);
    // Alignment finishes, and the same call times each cue from where the recording has its words.
    mock.state.transcripts = { m1: transcript };
    await new Promise(resolve => setTimeout(resolve, 1600));
    expect(textOf(await generate())).toContain("caption clip(s) from 10 words");
    const words = saved.find(op => op.op === "addTrack")!.track!.clips.flatMap(c => c.words);
    expect(words.find(w => w.text === "Um,")).toMatchObject({ start: 2.5, end: 2.7 });
  } finally {
    Object.assign(mock.state, original);
    await editor.close();
  }
});

it("lets any model read and audit the edited timeline: playback transcript, joins, diff and media profile", async () => {
  const original = { extra: mock.state.extra, timeline: mock.state.timeline, waveform: mock.state.waveform };
  const editor = await connect();
  // The “Um,” and the pause around it are gone: source 1.9 → 3.5.
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "trimmed";
  tl.tracks[1]!.clips = [makeMediaClip("m1", 0, 1.9, 0), makeMediaClip("m1", 3.5, 6, 1.9)];
  mock.state.timeline = tl;
  mock.state.waveform = spokenWaveform;
  mock.state.extra = (req, res) => {
    let result;
    if (req.path.endsWith("/versions/before/diff/trimmed")) result = { diff: { durationBefore: 6, durationAfter: 4.4, ranges: [{ start: 1.9, end: 1.9 }] }, description: ["Removed 1.60 s at 0:01.90"] };
    else if (req.path === "/projects/prj_test/media/m1/loudness") result = { mediaId: "m1", integratedLufs: -23.4, loudnessRangeLu: 6.1, truePeakDbtp: -1.2 };
    else return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
    return true;
  };
  try {
    const read = textOf(await editor.callTool({ name: "timeline_transcript", arguments: {} }) as CallToolResult);
    expect(read).toContain("Version trimmed, 0.00–4.40 of 4.40 s timeline: 9 words, 1 joins.");
    expect(read).toContain("0.20 #0 Hello everyone welcome back.\n‖ join 1 at 1.90 (0:01.27) m1 1.90→3.50 “back.” | “welcome”\n2.00 #5 welcome back to the show.");

    const audit = JSON.parse(textOf(await editor.callTool({ name: "timeline_join_audit", arguments: {} }) as CallToolResult));
    expect(audit).toMatchObject({ version: "trimmed", joins: 1, clean: 1 });
    expect(audit.audits[0]).toMatchObject({ join: 1, at: 1.9, verdict: "clean", airAfter: .1, airBefore: .1, jumpDb: 0,
      out: { mediaId: "m1", source: 1.9, voice: false, lastWord: "back." }, in: { mediaId: "m1", source: 3.5, voice: false, firstWord: "welcome" } });
    expect(audit.audits[0].levels).toMatch(/^(-?\d+ ){10}-60 -60 -60 -60 -60 \| -60 -60 -60 -60 -60 -14/);

    const diff = textOf(await editor.callTool({ name: "timeline_diff", arguments: { from: "before", to: "trimmed" } }) as CallToolResult);
    expect(diff).toBe("before → trimmed: 6.00 → 4.40 s (-1.60 s), joins +0/−0.\n- Removed 1.60 s at 0:01.90\nAffected (timeline s, trimmed): 1.90–1.90");

    const profile = JSON.parse(textOf(await editor.callTool({ name: "media_profile", arguments: { mediaId: "m1", to: 6 } }) as CallToolResult));
    expect(profile).toMatchObject({ mediaId: "m1", range: [0, 6], roomToneDbfs: -60, speechDbfs: -14, words: 10,
      loudness: { integratedLufs: -23.4, loudnessRangeLu: 6.1, truePeakDbtp: -1.2 }, retakes: [] });
    // Gaps of 0.15 s or more: 0.7 s before “Um,” and 0.9 s after it.
    expect(profile.pauses[0]).toMatchObject({ speaker: "all", pauses: 2, p90: .9, over3s: 0 });
  } finally {
    Object.assign(mock.state, original);
    await editor.close();
  }
});

it("offers audio only to a model whose harness delivers it", async () => {
  const sc = new ScarletClient({ baseUrl: mock.url, token: "tok" });
  const server = createScarletMcpServer(sc, { projectId: "prj_test", agent: "codex", capabilities: { images: true, audio: true, files: true, plan: false },
    author: { type: "agent", name: "codex" } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(b);
  try {
    const { tools } = await c.listTools();
    expect(tools.map(t => t.name)).toContain("source_audio");
    for (const name of ["dialogue_check_join", "dialogue_review_inspect", "change_review_cut"]) {
      expect(Object.keys(tools.find(t => t.name === name)!.inputSchema.properties ?? {})).toContain("includeAudio");
    }
  } finally { await c.close(); }
});

it("marks a recommendation inspected only after the join on the suggestion's version has been measured", async () => {
  const original = { extra: mock.state.extra, timeline: mock.state.timeline, waveform: mock.state.waveform };
  const editor = await connect("review-pass");
  const before = emptyTimeline(mock.state.project.id);
  before.version = "pf";
  before.tracks[1]!.clips = [makeMediaClip("m1", 0, 6, 0)];
  const after = emptyTimeline(mock.state.project.id);
  after.version = "pt";
  after.tracks[1]!.clips = [makeMediaClip("m1", 0, 1.9, 0), makeMediaClip("m1", 3.5, 6, 1.9)];
  mock.state.timeline = after;
  mock.state.waveform = spokenWaveform;
  let saved: unknown;
  mock.state.extra = (req, res) => {
    let result;
    if (req.path === "/projects/prj_test/changes/pass") result = { change: { id: "pass", projectId: "prj_test", intent: "suggestion", state: "ready",
      fromVersion: "pf", toVersion: "pt", description: "Review 1 optional dialogue cut", cutReasons: [{ start: 1.9, end: 3.5, reason: "A filler." }],
      ops: [{ op: "rippleDelete", start: 1.9, end: 3.5 }] } };
    else if (req.path.endsWith("/cut-review")) result = { review: { original: before, proposed: after, firstCut: false,
      cuts: [{ at: 1.9, removed: { start: 1.9, end: 3.5 }, beforeClip: 1 }] } };
    else if (req.path.endsWith("/cut-assessments")) { saved = req.body; result = { total: 1, assessed: 1, needsDecision: 0 }; }
    else return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
    return true;
  };
  try {
    const verdict = { changeId: "pass", fromVersion: "pf", toVersion: "pt", assessments: [{ index: 0, start: 1.9, end: 3.5, verdict: "cut", reason: "A clean filler." }] };
    // A recommendation is advice; the inspected flag says whether this session read every view of the cut.
    expect((await editor.callTool({ name: "dialogue_review_save", arguments: verdict })).isError).toBeFalsy();
    expect(saved).toMatchObject({ assessments: [{ index: 0, verdict: "cut", inspected: false }] });
    const inspected = await editor.callTool({ name: "dialogue_review_inspect", arguments: { changeId: "pass", index: 0 } }) as CallToolResult;
    expect(inspected.isError).toBeFalsy();
    const joinAudit = inspected.content.flatMap(c => c.type === "text" && c.text.includes("joinAudit") ? [JSON.parse(c.text).joinAudit] : [])[0];
    expect(joinAudit[0]).toMatchObject({ at: 1.9, verdict: "clean" });
    expect(textOf(inspected)).toContain('"levelsDb":[');
    // The editor's count moves as soon as a cut is looked at, before any recommendation for it is saved.
    expect(mock.state.events.findLast(e => e.data?.kind === "cut_progress")?.data).toMatchObject({ changeId: "pass", looked: 1 });
    expect((await editor.callTool({ name: "dialogue_review_save", arguments: verdict })).isError).toBeFalsy();
    expect(saved).toMatchObject({ assessments: [{ index: 0, verdict: "cut", inspected: true }] });
  } finally {
    Object.assign(mock.state, original);
    await editor.close();
  }
});

it("tells the editor how many cuts a newly staged review has, counting recommendations carried from an earlier part", async () => {
  const original = { extra: mock.state.extra, timeline: mock.state.timeline, waveform: mock.state.waveform };
  const editor = await connect("review-progress");
  const tl = emptyTimeline(mock.state.project.id);
  tl.version = "pf";
  tl.tracks[1]!.clips = [makeMediaClip("m1", 0, 6, 0)];
  mock.state.timeline = tl;
  mock.state.waveform = spokenWaveform;
  const change = { id: "part2", projectId: "prj_test", intent: "suggestion", state: "ready", fromVersion: "pf", toVersion: "pt",
    description: "Review 3 optional dialogue cuts", ops: [], cutReasons: [],
    cutAssessments: [{ index: 0, start: 1, end: 1.4, verdict: "cut", reason: "Carried from the first part.", inspected: true }] };
  mock.state.extra = (req, res) => {
    let result;
    if (req.path.endsWith("/dialogue-cuts")) result = { changes: [change] };
    else if (req.path === "/projects/prj_test/changes/part2") result = { change };
    else if (req.path.endsWith("/cut-review")) result = { review: { original: tl, proposed: tl, firstCut: false, cuts: [
      { at: 1, removed: { start: 1, end: 1.4 }, beforeClip: 1 }, { at: 2, removed: { start: 2, end: 2.4 }, beforeClip: 1 },
      { at: 3, removed: { start: 3, end: 3.4 }, beforeClip: 1 }] } };
    else return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
    return true;
  };
  try {
    const result = await editor.callTool({ name: "dialogue_apply_cuts", arguments: { version: "pf", description: "Review the takes",
      cuts: [{ start: 2, end: 2.4, kind: "retake", decision: "review", reason: "Two takes." }] } });
    expect(result.isError).toBeFalsy();
    const progress = () => mock.state.events.find(e => e.data?.kind === "cut_progress");
    for (let i = 0; i < 50 && !progress(); i++) await new Promise(r => setTimeout(r, 10));
    expect(progress()?.data).toEqual({ kind: "cut_progress", changeId: "part2", checked: 1, total: 3 });
    expect(progress()?.text).toBe("");
  } finally {
    Object.assign(mock.state, original);
    await editor.close();
  }
});

it("needs no join audit for a head or tail trim, and audits a crossfaded join through its overlap", async () => {
  const original = { extra: mock.state.extra, timeline: mock.state.timeline, waveform: mock.state.waveform };
  const editor = await connect("trim-review");
  const before = emptyTimeline(mock.state.project.id);
  before.version = "tf";
  before.tracks[1]!.clips = [makeMediaClip("m1", 0, 6, 0)];
  // Head trim 0–0.15, the “Um,” cut 1.9–3.5 smoothed by a centered 0.066 s crossfade at 1.75, tail trim 5.5–6.
  const after = emptyTimeline(mock.state.project.id);
  after.version = "tt";
  after.tracks[1]!.clips = [makeMediaClip("m1", .15, 1.933, 0), makeMediaClip("m1", 3.467, 5.5, 1.717)];
  mock.state.timeline = after;
  let recorded: unknown;
  mock.state.waveform = spokenWaveform;
  mock.state.extra = (req, res) => {
    let result;
    if (req.path === "/projects/prj_test/changes/trims") result = { change: { id: "trims", projectId: "prj_test", intent: "suggestion", state: "ready",
      fromVersion: "tf", toVersion: "tt", description: "Review 3 optional dialogue cuts", cutReasons: [], ops: [] } };
    else if (req.path.endsWith("/cut-review")) result = { review: { original: before, proposed: after, firstCut: false, cuts: [
      { at: 0, removed: { start: 0, end: .15 }, beforeClip: 0 }, { at: 1.75, removed: { start: 1.9, end: 3.5 }, beforeClip: 1 },
      { at: 3.75, removed: { start: 5.5, end: 6 }, beforeClip: 2 }] } };
    else if (req.path.endsWith("/cut-assessments")) { recorded = req.body; result = { total: 3, assessed: 3, needsDecision: 0 }; }
    else return false;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
    return true;
  };
  try {
    const audit = async (index: number) => {
      const r = await editor.callTool({ name: "dialogue_review_inspect", arguments: { changeId: "trims", index } }) as CallToolResult;
      expect(r.isError).toBeFalsy();
      return r.content.flatMap(c => c.type === "text" && c.text.includes("joinAudit") ? [JSON.parse(c.text).joinAudit] : [])[0];
    };
    expect(await audit(0)).toBe("head trim: nothing plays before this cut");
    // The faded handles end at 1.933 (0.13 s after “back.”) and start at 3.467 (0.13 s before “welcome”).
    expect((await audit(1))[0]).toMatchObject({ at: 1.75, overlap: .066, verdict: "clean", out: { source: 1.933 }, in: { source: 3.467 } });
    expect(await audit(2)).toBe("tail trim: nothing plays after this cut");
    const verdicts = [0, 1, 2].map(index => ({ index, start: 0, end: 1, verdict: "cut", reason: "Dead air." }));
    const saved = await editor.callTool({ name: "dialogue_review_save", arguments: { changeId: "trims", fromVersion: "tf", toVersion: "tt", assessments: verdicts } });
    expect(textOf(saved as CallToolResult)).toContain('"assessed":3');
    // A trim with no join counts as fully inspected once its other views arrived.
    expect(recorded).toMatchObject({ assessments: [0, 1, 2].map(index => ({ index, inspected: true })) });
  } finally {
    Object.assign(mock.state, original);
    await editor.close();
  }
});

it("never hands a reader that may not prepare a transcript to one that must", async () => {
  // A fresh session: words a session has already read stay cached for it.
  const fresh = await connect();
  let prepared = false;
  mock.state.extra = async (req, res) => {
    if (req.path.endsWith("/media/m2/prepare")) {
      prepared = true;
      mock.state.transcripts.m2 = { ...transcript, mediaId: "m2" };
      res.end(JSON.stringify({ state: "ready" }));
      return true;
    }
    if (req.path.endsWith("/media/m2/transcript") && !prepared) {
      // Slow enough that the second call starts while the first read is still pending.
      await new Promise(resolve => setTimeout(resolve, 150));
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "not_found", message: "no transcript" } }));
      return true;
    }
    return false;
  };
  try {
    // media_profile reads words without preparing them; transcript_get prepares a missing transcript.
    const profile = fresh.callTool({ name: "media_profile", arguments: { mediaId: "m2", to: 6 } });
    await new Promise(resolve => setTimeout(resolve, 40));
    const words = await fresh.callTool({ name: "transcript_get", arguments: { mediaId: "m2", from: 0, to: 2 } }) as CallToolResult;
    expect(textOf(words)).toContain("#0 0.20-0.50 Hello");
    expect(JSON.parse(textOf(await profile as CallToolResult))).toMatchObject({ transcript: "none yet; transcript_get prepares it" });
  } finally {
    delete mock.state.transcripts.m2;
    mock.state.extra = undefined;
    await fresh.close();
  }
});

it("keeps a resumed or answered task in the pass the editor typed last", async () => {
  const original = { timeline: mock.state.timeline, skills: mock.state.skills };
  const timeline = emptyTimeline(mock.state.project.id);
  timeline.tracks[0]!.clips = [makeMediaClip("m1", 0, 6, 0)];
  mock.state.timeline = timeline;
  mock.state.skills = [dialogueSkill];
  // The answer route adds the shared skill id and keeps the original message; the answers are task events.
  const run = async (id: string, instruction: string, answer: string) => {
    mock.state.events.push({ type: "question", text: "Which passage?", taskId: id }, { type: "answer", text: answer, taskId: id });
    const session = await connect(id, undefined, Task.parse({ id, state: "running", projectId: mock.state.project.id, kind: "edit", agent: "claude",
      instruction, context: { skillIds: [dialogueSkill.id] }, createdBy: { type: "human", name: "Editor" } }));
    try {
      const r = await session.callTool({ name: "dialogue_apply_cuts", arguments: { version: timeline.version, description: "x", cuts: [] } }) as CallToolResult;
      return textOf(r);
    } finally { await session.close(); }
  };
  try {
    expect(await run("resumed-local", "/tighten-pauses-here", "The exchange at 0:01.")).toContain("Supply the local timeline range for the pause edit.");
    expect(await run("answered-local", "/first-cut-dialogue", "/tighten-pauses-here just the intro")).toContain("Supply the local timeline range for the pause edit.");
    expect(await run("answered-full", "/tighten-pauses-here", "/first-cut-dialogue the whole thing")).toContain("preserved");
  } finally {
    Object.assign(mock.state, original);
  }
});
