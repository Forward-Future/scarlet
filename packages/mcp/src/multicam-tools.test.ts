import "./cutSummaries.testkit.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ScarletClient } from "@scarlet/shared";
import { applyOps, clipEnd, type MediaClip, type Timeline, type Transcript } from "@scarlet/timeline";
import { syncRate } from "./audio-sync.js";
import { createScarletMcpServer, type ScarletMcpContext } from "./server.js";
import { makeState, startMockServer, type MockServer } from "./mock-server.js";

function envelope(seed: number, length: number) {
  return Array.from({ length }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  });
}

const textOf = (r: CallToolResult) => r.content.filter(c => c.type === "text").map(c => (c as { text: string }).text).join("\n");
const jsonPart = (r: CallToolResult, key: string) => {
  const part = r.content.find(c => c.type === "text" && (c as { text: string }).text.includes(`"${key}"`)) as { text: string } | undefined;
  if (!part) throw new Error(`No JSON part containing "${key}" in: ${textOf(r)}`);
  return JSON.parse(part.text);
};
const reply = (res: Parameters<NonNullable<MockServer["state"]["extra"]>>[1], body: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  return true;
};

describe("multi-cam MCP tools (timeline_sync_multicam, multicam_analyze, timeline_switch_cameras)", () => {
  let mock: MockServer;

  async function connect(ctx: Partial<ScarletMcpContext> = {}) {
    const server = createScarletMcpServer(new ScarletClient({ baseUrl: mock.url, token: "tok" }), {
      projectId: "prj_test", agent: "claude", author: { type: "agent", id: "claude", name: "claude", model: "opus" }, ...ctx,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const c = new Client({ name: "test", version: "0" });
    await c.connect(b);
    return c;
  }

  const call = async (c: Client, name: string, args: Record<string, unknown> = {}) =>
    await c.callTool({ name, arguments: args }) as CallToolResult;
  const ok = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
    const r = await call(c, name, args);
    expect(r.isError, textOf(r)).toBeFalsy();
    return r;
  };

  // Build synthetic 120 s signals:
  // - hostSig: active speech signal on Host mic (0..120 s)
  // - guestSig: independent signal on Guest mic (0..120 s)
  // - wideRoom: hears BOTH hostSig + guestSig (acts as hub for transitive sync!)
  // - camHost: started 2.0 s AFTER wideRoom, constant offset, hears room
  // - camGuest: started 1.5 s AFTER wideRoom with +30 ms/min steady clock drift (rate = 1.0005)
  const N = 120 * syncRate;
  const hostRaw = envelope(11, N);
  const guestRaw = envelope(29, N);
  const wideRoom = Array.from({ length: N }, (_, i) => {
    const sec = i / syncRate;
    const hostOn = Math.floor(sec / 10) % 2 === 0;
    return hostOn ? hostRaw[i]! * 0.7 : guestRaw[i]! * 0.7;
  });
  // micHost hears ONLY host segments (quiet during guest segments); shares audio with wideRoom.
  const micHost = Array.from({ length: N }, (_, i) => {
    const sec = i / syncRate;
    return Math.floor(sec / 10) % 2 === 0 ? hostRaw[i]! : 0.001;
  });
  // micGuest started 1.0 s after wideRoom and hears ONLY guest segments (no shared audio with micHost, ONLY with wideRoom!).
  const micGuestLen = 119 * syncRate;
  const micGuest = Array.from({ length: micGuestLen }, (_, i) => {
    const refIdx = i + 1 * syncRate;
    const sec = refIdx / syncRate;
    return Math.floor(sec / 10) % 2 === 1 ? guestRaw[refIdx]! : 0.001;
  });
  // camHost started 2.0 s after wideRoom.
  const camHostLen = 118 * syncRate;
  const camHost = Array.from({ length: camHostLen }, (_, i) => wideRoom[i + 2 * syncRate]! * 0.5);
  // camGuest started 1.5 s after wideRoom with steady clock drift (rate = 1.0005).
  const driftRate = 1.0005;
  const camGuestLen = 115 * syncRate;
  const camGuest = Array.from({ length: camGuestLen }, (_, i) => wideRoom[Math.round(i * driftRate) + Math.round(1.5 * syncRate)]! * 0.45);

  const signals: Record<string, number[]> = {
    cam_wide: wideRoom,
    cam_host: camHost,
    cam_guest: camGuest,
    mic_host: micHost,
    mic_guest: micGuest,
  };

  let saveCount = 0;

  beforeAll(async () => {
    mock = await startMockServer(makeState({}));
  });
  afterAll(() => mock.close());

  beforeEach(() => {
    saveCount = 0;
    mock.requests.length = 0;
    mock.state.timeline = null;
    mock.state.project.media = [
      { id: "cam_wide", kind: "video", name: "Wide.mp4", path: "Wide.mp4", duration: 120, width: 1920, height: 1080, fps: 30, hasAudio: true },
      { id: "cam_host", kind: "video", name: "Host.mp4", path: "Host.mp4", duration: 118, width: 1920, height: 1080, fps: 30, hasAudio: true },
      { id: "cam_guest", kind: "video", name: "Guest.mp4", path: "Guest.mp4", duration: 115, width: 1920, height: 1080, fps: 30, hasAudio: true },
      { id: "cam_silent", kind: "video", name: "Overhead.mp4", path: "Overhead.mp4", duration: 100, width: 1920, height: 1080, fps: 30, hasAudio: false },
      { id: "mic_host", kind: "audio", name: "HostMic.wav", path: "HostMic.wav", duration: 120, hasAudio: true },
      { id: "mic_guest", kind: "audio", name: "GuestMic.wav", path: "GuestMic.wav", duration: 119, hasAudio: true },
    ];
    mock.state.waveform = (mediaId, from, to, points) => {
      const src = signals[mediaId] ?? [];
      const start = Math.round(from * syncRate);
      return { mediaId, from, to, peaks: src.slice(start, start + points) };
    };
    const hostWords = Array.from({ length: 40 }, (_, i) => {
      const block = Math.floor(i / 10);
      const t = block * 20 + 1 + (i % 10) * 0.7;
      return { text: `host${i}`, start: t, end: t + 0.4, speaker: "Speaker 1" };
    });
    const guestWords = Array.from({ length: 40 }, (_, i) => {
      const block = Math.floor(i / 10);
      const t = block * 20 + 10 + (i % 10) * 0.7; // mic_guest starts at ref 1.0 s -> source t is 1 s earlier
      return { text: `guest${i}`, start: t, end: t + 0.4, speaker: "Speaker 2" };
    });
    mock.state.transcripts = {
      mic_host: { id: "t_h", mediaId: "mic_host", segments: [{ id: "s_h", start: 0, end: 120, text: "host", words: hostWords }] } as Transcript,
      mic_guest: { id: "t_g", mediaId: "mic_guest", segments: [{ id: "s_g", start: 0, end: 119, text: "guest", words: guestWords }] } as Transcript,
    };

    // Mock server applying proposed changes onto `mock.state.timeline` so multi-step sync -> analyze -> switch works end-to-end.
    mock.state.extra = (req, res) => {
      if (req.method === "POST" && req.path === "/projects/prj_test/changes") {
        const body = req.body as { timeline?: Timeline; ops?: Parameters<typeof applyOps>[1]; description: string; reason?: string; batchTitle?: string; timelineEdits?: unknown };
        const next: Timeline = body.timeline
          ? { ...body.timeline, version: `v_${++saveCount}` }
          : { ...applyOps(mock.state.timeline!, body.ops!), version: `v_${++saveCount}` };
        mock.state.timeline = next;
        mock.state.project.head = next.version;
        return reply(res, {
          change: {
            id: `chg_${saveCount}`, projectId: "prj_test", fromVersion: body.timeline ? null : `v_${saveCount - 1}`,
            toVersion: next.version, description: body.description, reason: body.reason, batchTitle: body.batchTitle,
            timelineEdits: body.timelineEdits, author: { type: "agent", name: "mock" }, noteIds: [], ranges: [], state: "approved", renders: [],
          },
          timeline: next,
        });
      }
      if (req.method === "GET" && req.path.endsWith("/faces")) {
        const id = req.path.split("/").at(-2)!;
        if (id === "cam_wide") {
          return reply(res, {
            mediaId: id, from: 0, to: 120, readSeconds: 120, done: true,
            tracks: [
              { track: 1, start: 0, end: 120, seconds: 120, box: [0.16, 0.24, 0.30, 0.50], eyes: [0.23, 0.35], confidence: 0.93 },
              { track: 2, start: 0, end: 120, seconds: 120, box: [0.70, 0.24, 0.84, 0.50], eyes: [0.77, 0.35], confidence: 0.92 },
            ],
            spans: [{ track: 1, start: 0, end: 120, yaw: 15 }, { track: 2, start: 0, end: 120, yaw: -15 }],
          });
        }
        return reply(res, {
          mediaId: id, from: 0, to: 115, readSeconds: 115, done: true,
          tracks: [{ track: 1, start: 0, end: 115, seconds: 115, box: [0.36, 0.18, 0.64, 0.60], eyes: [0.50, 0.35], confidence: 0.95 }],
          spans: [{ track: 1, start: 0, end: 115, yaw: 0 }],
        });
      }
      if (req.method === "POST" && req.path.endsWith("/mouth-activity")) {
        const id = req.path.split("/").at(-2)!;
        const stretches = (req.body as { stretches: Array<{ from: number; to: number }> }).stretches;
        const sr = 5;
        // Build mouth series matching Host (even 10 s blocks on ref clock) or Guest (odd 10 s blocks).
        const valuesFor = (offset: number, speed: number, isHost: boolean) => stretches.map(s => {
          const count = Math.max(1, Math.round((s.to - s.from) * sr));
          return {
            from: s.from,
            to: s.to,
            values: Array.from({ length: count }, (_, i) => {
              const srcSec = s.from + (i + 0.5) / sr;
              const refSec = offset + srcSec / speed;
              const hostTurn = Math.floor(refSec / 10) % 2 === 0;
              return (isHost ? hostTurn : !hostTurn) ? 9.2 : 1.0;
            }),
          };
        });
        if (id === "cam_wide") {
          return reply(res, {
            mediaId: id, sampleRate: sr, done: true,
            faces: [
              { track: 1, box: [0.16, 0.24, 0.30, 0.50], mouth: [0.18, 0.40, 0.28, 0.52], seconds: 120, confidence: 0.93, stretches: valuesFor(0, 1, true) },
              { track: 2, box: [0.70, 0.24, 0.84, 0.50], mouth: [0.72, 0.40, 0.82, 0.52], seconds: 120, confidence: 0.92, stretches: valuesFor(0, 1, false) },
            ],
          });
        }
        if (id === "cam_host") {
          return reply(res, {
            mediaId: id, sampleRate: sr, done: true,
            faces: [{ track: 1, box: [0.36, 0.18, 0.64, 0.60], mouth: [0.40, 0.44, 0.60, 0.62], seconds: 118, confidence: 0.95, stretches: valuesFor(2, 1, true) }],
          });
        }
        return reply(res, {
          mediaId: id, sampleRate: sr, done: true,
          faces: [{ track: 1, box: [0.36, 0.18, 0.64, 0.60], mouth: [0.40, 0.44, 0.60, 0.62], seconds: 115, confidence: 0.94, stretches: valuesFor(1.5, 1 / driftRate, false) }],
        });
      }
      return false;
    };
  });

  afterEach(() => { mock.state.extra = undefined; });

  it("syncs 3 cameras (with drift) + 2 isolated mics (with transitive hub fallback), analyzes speaker-to-camera mapping, and switches angles across dialogue cuts", async () => {
    const c = await connect({ taskId: "tsk_mc" });
    try {
      // 1. Sync all 3 cameras + 2 isolated mics in one call, using mic_host as reference
      //    (mic_guest shares NO sound with mic_host, so it must sync transitively via cam_wide!).
      const syncRes = await ok(c, "timeline_sync_multicam", {
        intent: "requested",
        referenceId: "mic_host",
        cameras: [
          { mediaId: "cam_wide", name: "Wide" },
          { mediaId: "cam_host", name: "Host" },
          { mediaId: "cam_guest", name: "Guest" },
        ],
        audio: [
          { mediaId: "mic_host", name: "Host mic" },
          { mediaId: "mic_guest", name: "Guest mic" },
        ],
        description: "Sync the 3 cameras and 2 microphones",
        reason: "Line up all angles and clean mics before switching.",
      });

      const report = jsonPart(syncRes, "measurements");
      expect(report.measurements.cam_wide).toMatchObject({ kind: "constant", offset: 0 });
      expect(report.measurements.cam_host).toMatchObject({ kind: "constant", offset: 2 });
      expect(report.measurements.cam_guest.kind).toBe("drift");
      expect(report.measurements.cam_guest.offset).toBeCloseTo(1.5, 1);
      expect(report.measurements.cam_guest.speed).toBeCloseTo(1 / driftRate, 4);
      // mic_guest synced transitively via cam_wide at offset 1.0 s!
      expect(report.measurements.mic_guest).toMatchObject({ kind: "constant", offset: 1, syncedVia: "cam_wide" });
      expect(report.sync.summary).toContain("placed in line throughout");

      // 2. Analyze the synced timeline: match speakers to cameras.
      const analyzeRes = await ok(c, "multicam_analyze", {});
      const analysis = jsonPart(analyzeRes, "cameras");
      expect(analysis.cameras).toHaveLength(3);
      const wideCam = analysis.cameras.find((x: { mediaId: string }) => x.mediaId === "cam_wide");
      const hostCam = analysis.cameras.find((x: { mediaId: string }) => x.mediaId === "cam_host");
      const guestCam = analysis.cameras.find((x: { mediaId: string }) => x.mediaId === "cam_guest");
      expect(wideCam.prominentFaceCount).toBe(2);
      expect(hostCam.prominentFaceCount).toBe(1);
      expect(hostCam.speakerEvidence[0]).toMatchObject({ speaker: "Host mic", strength: "high" });
      expect(guestCam.prominentFaceCount).toBe(1);
      expect(guestCam.speakerEvidence[0]).toMatchObject({ speaker: "Guest mic", strength: "high" });
      expect(analysis.sync.summary).toContain("placed in line throughout");

      // 3. Simulate a dialogue ripple cut across all tracks (removing 14..16 s).
      mock.state.timeline = { ...applyOps(mock.state.timeline!, [{ op: "rippleDelete", start: 14, end: 16 }]), version: "v_cut" };
      await ok(c, "timeline_get");

      // 4. Switch camera angles cleanly over the post-cut timeline.
      const switchRes = await ok(c, "timeline_switch_cameras", {
        intent: "requested",
        switches: [
          { from: 5, to: 10, mediaId: "cam_host", label: "Host", reason: "Host introduces the topic." },
          { from: 10, to: 20, mediaId: "cam_guest", label: "Guest", reason: "Guest replies." },
        ],
        description: "Cut between Wide, Host, and Guest",
        batchTitle: "2 multi-cam angle switches",
        reason: "Follow each speaker on their close-up.",
      });

      const switchReport = jsonPart(switchRes, "switchesApplied");
      expect(switchReport).toMatchObject({ programTrackId: "v1", switchesApplied: 2, detachedAudio: [] });
      const v1 = mock.state.timeline!.tracks.find(t => t.id === "v1")!.clips as MediaClip[];
      // Guest range [10..20] spans the dialogue cut at 14 s -> produces 2 synced clips on v1!
      const guestClips = v1.filter(cl => cl.mediaId === "cam_guest");
      expect(guestClips).toHaveLength(2);
      expect(guestClips[0]!.timelineIn).toBeCloseTo(10, 3);
      expect(clipEnd(guestClips[0]!)).toBeCloseTo(14, 3);
      expect(guestClips[1]!.timelineIn).toBeCloseTo(14, 3);
      expect(clipEnd(guestClips[1]!)).toBeCloseTo(20, 3);
      // Sync verification after switching + dialogue cuts stays 100% clean!
      const recheck = jsonPart(await ok(c, "multicam_analyze", { includeMouthActivity: false }), "sync");
      expect(recheck.sync.pairs.every((p: { outOfLine: unknown[] }) => p.outOfLine.length === 0)).toBe(true);
    } finally {
      await c.close();
    }
  });

  it("reports already-measured offsets when a silent camera needs an explicit offset, and accepts explicit offsets cleanly", async () => {
    const c = await connect({ taskId: "tsk_silent" });
    try {
      const failed = await call(c, "timeline_sync_multicam", {
        intent: "requested",
        referenceId: "cam_wide",
        cameras: [
          { mediaId: "cam_wide" },
          { mediaId: "cam_host" },
          { mediaId: "cam_silent" },
        ],
        description: "Sync cameras",
        reason: "Sync all angles.",
      });
      expect(failed.isError).toBe(true);
      expect(textOf(failed)).toContain("cam_silent");
      expect(textOf(failed)).toContain("cam_host: offset 2 s");

      // Providing the explicit offset for cam_silent succeeds immediately.
      const okRes = await ok(c, "timeline_sync_multicam", {
        intent: "requested",
        referenceId: "cam_wide",
        cameras: [
          { mediaId: "cam_wide" },
          { mediaId: "cam_host" },
          { mediaId: "cam_silent", offset: 5 },
        ],
        description: "Sync cameras including overhead",
        reason: "Use the editor's 5 s offset for the silent overhead camera.",
      });
      const report = jsonPart(okRes, "measurements");
      expect(report.measurements.cam_silent).toEqual({ kind: "explicit", offset: 5, speed: 1 });
    } finally {
      await c.close();
    }
  });
});
