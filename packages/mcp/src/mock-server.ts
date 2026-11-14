/**
 * Tiny in-process Scarlet API mock used by the MCP tests (and reusable by the
 * agent host tests). Implements only the routes the tools touch and records
 * every request so tests can assert on bodies.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Change, Note, Project, Timeline, Transcript } from "@scarlet/timeline";
import { applyOps, createProject, timelineDuration, type TimelineOp } from "@scarlet/timeline";
import { countReviewDecisions, type ProjectDetail, type Skill, type TaskEvent, type WaveformResponse } from "@scarlet/shared";

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: IncomingMessage["headers"];
}

export interface MockState {
  project: Project;
  timeline: Timeline | null;
  transcripts: Record<string, Transcript>;
  waveform: (mediaId: string, from: number, to: number, points: number) => WaveformResponse;
  /** Which input each word and gap came from, as the engine reads a recording's inputs. Unavailable by default. */
  otherInput: (mediaId: string, words: Array<[number, number]>, gaps: Array<[number, number]>) => { available: boolean; words: boolean[]; gaps: Array<Array<{ start: number; end: number }>> };
  notes: Note[];
  skills: Skill[];
  changes: Change[];
  events: TaskEvent[];
  frame: Buffer;
  /** Extra route handler for test-specific endpoints. Return true when handled. */
  extra?: (req: RecordedRequest, res: ServerResponse) => boolean | Promise<boolean>;
}

export interface MockServer {
  url: string;
  state: MockState;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export function makeState(partial: Partial<MockState> = {}): MockState {
  const project = createProject("Test", { fps: 30 });
  project.id = "prj_test";
  project.media = [
    { id: "m1", kind: "video", name: "talk.mp4", path: "talk.mp4", duration: 120, fps: 30, width: 1920, height: 1080, hasAudio: true, transcriptId: "t1" },
    { id: "m2", kind: "audio", name: "mic.wav", path: "mic.wav", duration: 120, hasAudio: true },
  ];
  return {
    project,
    timeline: null,
    transcripts: {},
    waveform: (mediaId, from, to, points) => ({ mediaId, from, to, peaks: Array.from({ length: points }, () => 0.5) }),
    otherInput: (_mediaId, words, gaps) => ({ available: false, words: words.map(() => false), gaps: gaps.map(() => []) }),
    notes: [],
    skills: [],
    changes: [],
    events: [],
    frame: Buffer.from("ffd8ffe000104a46494600", "hex"),
    ...partial,
  };
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function notFound(res: ServerResponse, message: string) {
  send(res, 404, { error: { code: "not_found", message } });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks);
  if (!raw.length) return undefined;
  const ct = req.headers["content-type"] ?? "";
  if (ct.includes("application/json")) return JSON.parse(raw.toString("utf8"));
  if (ct.includes("multipart/form-data")) return { multipart: true, size: raw.length, raw: raw.toString("latin1") };
  return raw.toString("utf8");
}

export async function startMockServer(state: MockState = makeState()): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  let changeSeq = 0;
  let versionSeq = 0;

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/^\/api/, "");
    const body = await readBody(req);
    const rec: RecordedRequest = { method: req.method ?? "GET", path, query: url.searchParams, body, headers: req.headers };
    requests.push(rec);
    try {
      if (state.extra && (await state.extra(rec, res))) return;
      const scoped = /^\/projects\/([^/]+)(\/(?:media|notes|changes|renders|tasks)\/[^/]+(?:\/(?:reply|frame|waveform|transcript|cut-review|cut-assessments|events|question))?)$/.exec(path);
      if (scoped && scoped[1] !== state.project.id) return notFound(res, "project");
      const m = (re: RegExp) => re.exec(scoped?.[2] ?? path);
      let mm: RegExpExecArray | null;

      if (rec.method === "GET" && (mm = m(/^\/projects\/([^/]+)$/))) {
        if (mm[1] !== state.project.id) return notFound(res, "project");
        const detail: ProjectDetail = {
          project: state.project,
          summary: {
            id: state.project.id,
            name: state.project.name,
            settings: state.project.settings,
            head: state.project.head,
            mediaCount: state.project.media.length,
            pendingChanges: countReviewDecisions({ changes: state.changes, notes: state.notes, tasks: [] }),
            openNotes: state.notes.filter((n) => n.state === "open").length,
          },
          timeline: state.timeline,
        };
        return send(res, 200, detail);
      }
      if (rec.method === "GET" && (mm = m(/^\/projects\/([^/]+)\/media$/))) return send(res, 200, { media: state.project.media });
      if (rec.method === "POST" && (mm = m(/^\/projects\/([^/]+)\/media$/))) {
        const media = { id: `m_up${state.project.media.length + 1}`, kind: "video", name: "upload.mp4", path: "upload.mp4", duration: 3.5 };
        state.project.media.push(media as Project["media"][number]);
        return send(res, 200, { media });
      }
      if (rec.method === "GET" && (mm = m(/^\/projects\/([^/]+)\/timeline$/))) {
        if (!state.timeline) return notFound(res, "no timeline");
        return send(res, 200, { timeline: state.timeline });
      }
      if (rec.method === "GET" && (mm = m(/^\/projects\/([^/]+)\/versions\/([^/]+)\/export\.otio$/))) {
        return send(res, 200, { OTIO_SCHEMA: "Timeline.1", name: "mock", version: mm[2] });
      }
      if (rec.method === "GET" && (mm = m(/^\/media\/([^/]+)\/transcript$/))) {
        const t = state.transcripts[mm[1]!];
        if (!t) return notFound(res, "no transcript");
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        const segments = t.segments.filter(
          (s) => (from === null || s.end >= Number(from)) && (to === null || s.start <= Number(to)),
        );
        return send(res, 200, { ...t, segments });
      }
      if (rec.method === "GET" && (mm = m(/^\/media\/([^/]+)\/waveform$/))) {
        const q = url.searchParams;
        return send(res, 200, state.waveform(mm[1]!, Number(q.get("from")), Number(q.get("to")), Number(q.get("points") ?? 1000)));
      }
      if (rec.method === "POST" && (mm = m(/^\/projects\/[^/]+\/media\/([^/]+)\/other-input$/))) {
        const b = body as { words?: Array<[number, number]>; gaps?: Array<[number, number]> };
        return send(res, 200, state.otherInput(mm[1]!, b.words ?? [], b.gaps ?? []));
      }
      if (rec.method === "GET" && (mm = m(/^\/media\/([^/]+)\/frame$/))) {
        res.writeHead(200, { "content-type": "image/jpeg" });
        return res.end(state.frame);
      }
      if (rec.method === "POST" && (mm = m(/^\/projects\/([^/]+)\/changes$/))) {
        const b = body as { ops?: TimelineOp[]; timeline?: Timeline; description: string; author?: Change["author"]; taskId?: string; noteIds?: string[] };
        const before = state.timeline;
        let after: Timeline;
        if (b.timeline) after = b.timeline;
        else if (b.ops) {
          if (!before) return send(res, 400, { error: { code: "no_timeline", message: "no timeline to apply ops to" } });
          after = applyOps(before, b.ops);
        } else return send(res, 400, { error: { code: "bad_request", message: "ops or timeline required" } });
        const toVersion = `v${++versionSeq}`;
        after = { ...after, version: toVersion, parent: before?.version ?? null };
        const change: Change = {
          id: `chg_${++changeSeq}`,
          projectId: state.project.id,
          fromVersion: before?.version ?? "none",
          toVersion,
          description: b.description,
          author: { type: "agent", name: "mock", ...(b.author ?? {}) } as Change["author"],
          noteIds: b.noteIds ?? [],
          ranges: [{ start: 0, end: timelineDuration(after) }],
          state: "proposed",
          renders: [],
          taskId: b.taskId,
        };
        state.changes.push(change);
        state.timeline = after;
        state.project.head = toVersion;
        return send(res, 200, { change, timeline: after });
      }
      if (rec.method === "GET" && (mm = m(/^\/projects\/([^/]+)\/changes$/))) {
        const st = url.searchParams.get("state");
        return send(res, 200, { changes: state.changes.filter((c) => !st || c.state === st) });
      }
      if (rec.method === "GET" && (mm = m(/^\/changes\/([^/]+)$/))) {
        const c = state.changes.find((x) => x.id === mm![1]);
        if (!c) return notFound(res, "change");
        return send(res, 200, {
          change: c,
          diff: { clips: [], tracks: [], markersChanged: false, timelineFieldsChanged: [], ranges: c.ranges, beforeRanges: [], durationBefore: 0, durationAfter: 0 },
        });
      }
      if (rec.method === "GET" && (mm = m(/^\/projects\/([^/]+)\/notes$/))) {
        const st = url.searchParams.get("state");
        return send(res, 200, { notes: state.notes.filter((n) => !st || n.state === st) });
      }
      if (rec.method === "POST" && (mm = m(/^\/notes\/([^/]+)\/reply$/))) {
        const n = state.notes.find((x) => x.id === mm![1]);
        if (!n) return notFound(res, "note");
        return send(res, 200, { note: n });
      }
      if (rec.method === "PATCH" && (mm = m(/^\/notes\/([^/]+)$/))) {
        const n = state.notes.find((x) => x.id === mm![1]);
        if (!n) return notFound(res, "note");
        Object.assign(n, body as object);
        return send(res, 200, { note: n });
      }
      if (rec.method === "POST" && (mm = m(/^\/projects\/([^/]+)\/renders$/))) {
        const b = body as { kind?: string; version?: string; range?: unknown };
        return send(res, 200, {
          render: { id: "rnd_1", projectId: state.project.id, version: b.version ?? state.project.head ?? "head", kind: b.kind ?? "full", range: b.range ?? null, key: "k", path: null, state: "queued", progress: 0 },
        });
      }
      if (rec.method === "GET" && (mm = m(/^\/renders\/([^/]+)$/))) {
        return send(res, 200, { render: { id: mm[1], projectId: state.project.id, version: "v1", kind: "preview", range: null, key: "k", path: "r.mp4", state: "done", progress: 1 } });
      }
      if (rec.method === "GET" && (mm = m(/^\/tasks\/([^/]+)$/))) {
        return send(res, 200, { task: { id: mm[1] }, events: state.events.filter((e) => e.taskId === mm![1]) });
      }
      if (rec.method === "POST" && (mm = m(/^\/tasks\/([^/]+)\/events$/))) {
        state.events.push({ ...(body as TaskEvent), taskId: mm[1] });
        return send(res, 200, {});
      }
      if (rec.method === "POST" && m(/^\/tasks\/([^/]+)\/usage$/)) return send(res, 200, {});
      if (rec.method === "POST" && (mm = m(/^\/tasks\/([^/]+)\/question$/))) {
        state.events.push({ type: "question", text: (body as { text: string }).text, taskId: mm[1] });
        return send(res, 200, { waiting: true });
      }
      if (rec.method === "GET" && path === "/skills") return send(res, 200, { skills: state.skills });
      return notFound(res, `no mock route for ${rec.method} ${path}`);
    } catch (err) {
      send(res, 500, { error: { code: "mock_error", message: err instanceof Error ? err.message : String(err) } });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
