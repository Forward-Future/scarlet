import { OpenAIProvider } from "./transcribe/openai.js";
import { WAVEFORM_CACHE_VERSION } from "@scarlet/render";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Change, MediaAsset, Note, Project, Timeline } from "@scarlet/timeline";
import type { ActivityEntry, AgentHost, Learning, Render, Skill, SkillVersion, Task, TaskEvent, User } from "@scarlet/shared";
import { createApp, type ScarletApp } from "./app.js";
import { accessToken, localUser, publishDesktopSession, resolveToken } from "./auth.js";
import { migrateQuickActions } from "./services/migrateQuickActions.js";
import { purgeTrash } from "./services/trash.js";
import { returnRulesLeftWithQuestions } from "./services/tasks.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("scarlet server", () => {
  let dataDir: string;
  let seedDir: string;
  let scarlet: ScarletApp;
  let testMp4: Buffer;
  let ownerToken = "";
  let owner: User;
  let project: Project;
  let media: MediaAsset & { status: string };
  let firstChange: Change;
  let noteTask: Task;
  let host: AgentHost;

  async function api<T = unknown>(
    method: string,
    path: string,
    opts: { body?: unknown; token?: string; form?: FormData; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; json: T; res: Response }> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    const skillTaskId = /^\/projects\/[^/]+\/tasks\/([^/]+)\/(?:skill(?:-edit)?|learnings)$/.exec(path)?.[1];
    const startedAt = skillTaskId && scarlet.ctx.repos.tasks.get(skillTaskId)?.startedAt;
    if (skillTaskId && startedAt) {
      headers["X-Scarlet-Task"] = skillTaskId;
      headers["X-Scarlet-Task-Started-At"] ??= startedAt;
    }
    const token = opts.token ?? ownerToken;
    if (token) headers.Authorization = `Bearer ${token}`;
    let body: BodyInit | undefined;
    if (opts.form) body = opts.form;
    else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const res = await scarlet.app.request(`/api${path}`, { method, headers, body });
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: res.status, json: json as T, res };
  }

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "scarlet-test-"));
    seedDir = join(dataDir, "seed-skills");
    const mp4 = join(dataDir, "test.mp4");
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=duration=6:size=320x180:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
      "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", mp4,
    ]);
    testMp4 = readFileSync(mp4);
    scarlet = createApp({ dataDir, env: {}, log: () => {}, skillsSeedDir: seedDir });
  });

  afterAll(async () => {
    await scarlet.ctx.close();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* Windows may still hold the WAL; the OS temp dir cleans up */
    }
  });

  it("sends only extracted WAV audio for a short video when cloud transcription is selected", async () => {
    const provider = new OpenAIProvider({ apiKey: "unused-fixture", model: "whisper-1" });
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, opts) => {
      const file = (opts?.body as FormData).get("file") as File;
      expect(file.name).toMatch(/\.wav$/);
      expect(file.type).toBe("audio/wav");
      const data = Buffer.from(await file.arrayBuffer());
      expect(data.toString("ascii", 8, 12)).toBe("WAVE");
      expect(data.equals(testMp4)).toBe(false);
      return Response.json({ segments: [] });
    });
    try {
      await provider.transcribe({ path: join(dataDir, "test.mp4"), tmpDir: dataDir, duration: 6 });
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      request.mockRestore();
    }
  });

  it("keeps editor and demo routes off the engine HTTP server", async () => {
    for (const path of ["/", "/p/prj_demo", "/index.html"]) {
      const response = await scarlet.app.request(path);
      expect(response.status).toBe(404);
    }
  });

  it("rejects requests without a valid token", async () => {
    const r = await api("GET", "/settings", { token: "" });
    expect(r.status).toBe(401);
    expect((r.json as { error: { code: string } }).error.code).toBe("unauthorized");
    expect((await api("GET", "/settings", { token: "sct_not-a-real-token" })).status).toBe(401);
    // Accounts are gone: no sign-up or login routes.
    expect((await api("POST", "/auth/login", { token: "", body: { email: "a@b.c", password: "x" } })).status).toBe(401);
  });

  it("has one local user and a stable access token, no login", async () => {
    owner = localUser(scarlet.ctx);
    expect(localUser(scarlet.ctx).id).toBe(owner.id);
    ownerToken = accessToken(scarlet.ctx);
    expect(accessToken(scarlet.ctx)).toBe(ownerToken);
    const file = join(dataDir, "access-token");
    expect(readFileSync(file, "utf8").trim()).toBe(ownerToken);
    if (process.platform === "win32") {
      const inspectAcl = [
        "$ErrorActionPreference='Stop'",
        "$id=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
        "$acl=[System.IO.File]::GetAccessControl($env:SCARLET_TEST_TOKEN_FILE)",
        "$rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])",
        "$acl.AreAccessRulesProtected -and $rules.Count -eq 1 -and $rules[0].IdentityReference -eq $id -and $rules[0].AccessControlType -eq 'Allow' -and $rules[0].FileSystemRights -eq 'FullControl'",
      ].join(";");
      const ownerOnly = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", inspectAcl], {
        encoding: "utf8", env: { ...process.env, SCARLET_TEST_TOKEN_FILE: file },
      });
      expect(ownerOnly.trim()).toBe("True");
    } else {
      expect(statSync(file).mode & 0o077).toBe(0);
    }
    const me = await api<{ user: User }>("GET", "/auth/me");
    expect(me.json.user.id).toBe(owner.id);
  });

  it("accepts the evaluation session only in the desktop engine that published it", async () => {
    publishDesktopSession(scarlet.ctx, 41001);
    const readSession = () => JSON.parse(readFileSync(join(dataDir, "desktop-session.json"), "utf8"));
    const first = readSession();
    expect(first.token).not.toBe(ownerToken);
    const peer = createApp({ dataDir, skillsSeedDir: seedDir, env: {}, log: () => {} });
    try {
      expect(resolveToken(peer.ctx, first.token)).toBeNull();
      publishDesktopSession(peer.ctx, 41002);
      const second = readSession();
      expect(second.port).toBe(41002);
      expect(resolveToken(scarlet.ctx, second.token)).toBeNull();
      expect(resolveToken(peer.ctx, second.token)?.id).toBe(owner.id);
      expect(resolveToken(scarlet.ctx, first.token)?.id).toBe(owner.id);
    } finally { await peer.ctx.close(); }
  });

  it("rejects credentials from before the single-user migration", async () => {
    const legacy = "sct_" + "a".repeat(64);
    const hash = createHash("sha256").update(legacy).digest("hex");
    const db = scarlet.ctx.db;
    db.prepare("INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)").run(hash, owner.id, owner.createdAt);
    db.prepare("INSERT INTO agent_tokens (id, token_hash, user_id, name, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("old-host", hash, owner.id, "Old host", owner.createdAt);
    expect((await api("GET", "/projects", { token: legacy })).status).toBe(401);
    for (const path of ["/auth/login", "/auth/register", "/auth/invites", "/projects/legacy/members"]) {
      expect((await api("POST", path)).status).toBe(404);
    }
  });

  it("creates a project", async () => {
    const r = await api<{ project: Project }>("POST", "/projects", {
      body: { name: "Test Cut", settings: { width: 320, height: 180, aspect: "custom", fps: 30 } },
    });
    expect(r.status).toBe(201);
    project = r.json.project;
    expect(project.head).toBeNull();
    const detail = await api<{ project: Project; timeline: Timeline | null }>("GET", `/projects/${project.id}`);
    expect(detail.status).toBe(200);
    expect(detail.json.timeline).toBeNull();
    const tl = await api<{ timeline: Timeline }>("GET", `/projects/${project.id}/timeline`);
    expect(tl.json.timeline.tracks.map((t) => t.id)).toEqual(["v1", "a1"]);
  });

  it("writes an upload before the request finishes and removes a truncated file", async () => {
    const files = scarlet.ctx.paths.media(project.id);
    const before = readdirSync(files);
    let input!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { input = controller; } });
    const request = new Request(`http://localhost/api/projects/${project.id}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "multipart/form-data; boundary=test-boundary" },
      body,
      duplex: "half",
    });
    const result = scarlet.app.request(request);
    input.enqueue(Buffer.from('--test-boundary\r\nContent-Disposition: form-data; name="file"; filename="partial.mp4"\r\n\r\n'));
    input.enqueue(Buffer.alloc(1024 * 1024));
    try {
      await vi.waitFor(() => {
        const staged = readdirSync(files).find((name) => name.endsWith(".part"));
        expect(staged && statSync(join(files, staged)).size).toBeGreaterThan(0);
      });
    } finally {
      input.close(); // Missing the closing multipart boundary.
    }
    expect((await result).status).toBe(400);
    expect(readdirSync(files)).toEqual(before);
    expect(scarlet.ctx.repos.projects.listMedia(project.id)).toHaveLength(0);
  });

  it("uploads media and ingests it to ready", async () => {
    const updates: MediaAsset[] = [];
    const onUpdate = (event: import("@scarlet/shared").WsEvent) => {
      if (event.type === "media.updated") updates.push(event.media);
    };
    scarlet.ctx.bus.on("ws", onUpdate);
    const form = new FormData();
    form.append("file", new Blob([testMp4], { type: "video/mp4" }), "test.mp4");
    const r = await api<{ media: MediaAsset & { status: string } }>("POST", `/projects/${project.id}/media`, { form });
    expect(r.status).toBe(201);
    media = r.json.media;
    expect(media.kind).toBe("video");
    expect(media.duration).toBeGreaterThan(5.5);
    expect(media.duration).toBeLessThan(6.5);
    expect(media.hash).toBe(createHash("sha256").update(testMp4).digest("hex"));
    expect(media.hasAudio).toBe(true);
    const deadline = Date.now() + 40_000;
    while (media.status !== "ready" && media.status !== "failed" && Date.now() < deadline) {
      await sleep(300);
      const list = await api<{ media: Array<MediaAsset & { status: string }> }>("GET", `/projects/${project.id}/media`);
      media = list.json.media.find((m) => m.id === media.id)!;
    }
    scarlet.ctx.bus.off("ws", onUpdate);
    const fileUpdates = updates.filter((update) => update.id === media.id);
    expect(fileUpdates.some(update => update.preparation?.stage === "preview")).toBe(false);
    expect(fileUpdates.some(update => update.preparation?.stage === "waveform")).toBe(false);
    expect(fileUpdates.at(-1)?.status).toBe("ready");
    expect(media.preparation).toBeUndefined();
    expect(media.status).toBe("ready");
    expect(existsSync(join(dataDir, "projects", project.id, "proxies", `${media.id}.mp4`))).toBe(false);
    const previewUrl = `/api/media/${media.id}/preview/0?token=${ownerToken}`;
    const prepared = await scarlet.app.request(previewUrl, { method: "HEAD" });
    expect(prepared.status).toBe(200);
    expect(Number(prepared.headers.get("content-length"))).toBeGreaterThan(100);
    const chunk = await scarlet.app.request(previewUrl, { headers: { Range: "bytes=0-99" } });
    expect(chunk.status).toBe(206);
    expect((await chunk.arrayBuffer()).byteLength).toBe(100);
    const wavePath = join(dataDir, "projects", project.id, "waveforms", `${media.id}.v${WAVEFORM_CACHE_VERSION}.waveform`);
    expect(existsSync(wavePath)).toBe(false);
    const wf = await api<{ peaks: number[] }>("GET", `/media/${media.id}/waveform?from=0&to=6&points=60`);
    expect(wf.status).toBe(200);
    expect(existsSync(wavePath)).toBe(true);
    expect(wf.json.peaks).toHaveLength(60);
    expect(Math.max(...wf.json.peaks)).toBeGreaterThan(0.1);
    const file = await scarlet.app.request(`/api/media/${media.id}/file?token=${ownerToken}`, { headers: { Range: "bytes=0-99" } });
    expect(file.status).toBe(206);
    expect(file.headers.get("content-range")).toMatch(/^bytes 0-99\/\d+$/);
    expect((await file.arrayBuffer()).byteLength).toBe(100);
    const frame = await scarlet.app.request(`/api/media/${media.id}/frame?t=1&w=160&token=${ownerToken}`);
    expect(frame.status).toBe(200);
    expect(frame.headers.get("content-type")).toBe("image/jpeg");
    const transcript = await api("GET", `/media/${media.id}/transcript`);
    expect(transcript.status).toBe(404);
    const tr = await api<{ task: Task }>("POST", `/media/${media.id}/transcribe`, { body: {} });
    expect(tr.status).toBe(202);
    expect(tr.json.task.state).toBe("failed"); // no provider configured in tests
  });

  it("proposes without encoding, renders a requested section once, and approves without encoding", async () => {
    const r = await api<{ change: Change; timeline: Timeline }>("POST", `/projects/${project.id}/changes`, {
      body: {
        description: "Lay the whole clip on V1",
        ops: [
          {
            op: "addClip",
            trackId: "v1",
            clip: { id: "clip_a", kind: "media", mediaId: media.id, sourceIn: 0, sourceOut: 6, timelineIn: 0 },
          },
        ],
      },
    });
    expect(r.status).toBe(201);
    firstChange = r.json.change;
    expect(firstChange.state).toBe("ready");
    expect(firstChange.ranges).toEqual([{ start: 0, end: 6 }]);
    expect(firstChange.renders).toHaveLength(1);
    expect(firstChange.renders[0]).toMatchObject({ after: null, range: { start: 0, end: 6 }, beforeRange: { start: 0, end: 0 } });
    expect(firstChange.renders[0]!.before).toBeNull(); // nothing existed before
    expect(r.json.timeline.version).toBe(firstChange.toVersion);
    expect(r.json.timeline.version).toMatch(/^[0-9a-f]{16}$/);

    const stored = await api<{ timeline: Timeline }>("GET", `/projects/${project.id}/timeline?version=${firstChange.toVersion}`);
    expect(stored.status).toBe(200);
    expect(stored.json.timeline.tracks[0]!.clips).toHaveLength(1);
    // Head is still the empty base version until approval.
    const head = await api<{ timeline: Timeline }>("GET", `/projects/${project.id}/timeline`);
    expect(head.json.timeline.version).toBe(firstChange.fromVersion);

    const jobs = async () => (await api<{ renders: Render[] }>("GET", `/projects/${project.id}/renders`)).json.renders;
    expect(await jobs()).toHaveLength(0);
    const sample = { version: firstChange.toVersion, kind: "full", quality: "delivery", range: { start: 1, end: 2 } };
    const request = () => api<{ render: Render }>("POST", `/projects/${project.id}/renders`, { body: sample });
    const [{ json: first }, { json: again }] = await Promise.all([request(), request()]);
    expect(again.render.id).toBe(first.render.id);
    await Promise.all([...scarlet.ctx.pending]);
    const render = (await jobs())[0]!;
    expect(render).toMatchObject({ version: firstChange.toVersion, quality: "delivery", range: sample.range, durationSeconds: 1 });
    expect(render.state).toBe("done");
    expect(render.kind).toBe("segment");
    expect(render.path).toBe(`${render.key}.mp4`);
    expect(existsSync(join(dataDir, "projects", project.id, "renders", render.path!))).toBe(true);
    const file = await scarlet.app.request(`/api/renders/${render.id}/file?token=${ownerToken}`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("video/mp4");
    expect((await file.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    const listed = await api<{ renders: Render[] }>("GET", `/projects/${project.id}/renders?kind=segment`);
    expect(listed.json.renders.some((x) => x.id === render.id)).toBe(true);

    const approved = await api<{ change: Change; project: Project }>("POST", `/changes/${firstChange.id}/approve`);
    expect(approved.status).toBe(200);
    expect(await jobs()).toHaveLength(1);
    expect(approved.json.change.state).toBe("approved");
    expect(approved.json.project.head).toBe(firstChange.toVersion);
    const versions = await api<{ versions: Array<{ version: string; isHead: boolean; duration: number }> }>("GET", `/projects/${project.id}/versions`);
    expect(versions.json.versions.find((v) => v.isHead)?.version).toBe(firstChange.toVersion);
    expect(versions.json.versions.find((v) => v.isHead)?.duration).toBe(6);
  });

  it("proposes a change with a full timeline and rejects it", async () => {
    const head = (await api<{ timeline: Timeline }>("GET", `/projects/${project.id}/timeline`)).json.timeline;
    const trimmed: Timeline = structuredClone(head);
    const clip = trimmed.tracks[0]!.clips[0]!;
    if (clip.kind === "media") clip.sourceOut = 3;
    const r = await api<{ change: Change }>("POST", `/projects/${project.id}/changes`, {
      body: { description: "Trim to 3s", timeline: trimmed, skipRender: true, author: { type: "agent", id: "claude", name: "Claude", model: "opus" } },
    });
    expect(r.status).toBe(201);
    expect(r.json.change.state).toBe("ready");
    expect(r.json.change.renders).toHaveLength(0);
    expect(r.json.change.author.type).toBe("agent");
    expect(r.json.change.fromVersion).toBe(head.version);
    const diff = await api<{ diff: { clips: unknown[] }; description: string[] }>("GET", `/projects/${project.id}/versions/${head.version}/diff/${r.json.change.toVersion}`);
    expect(diff.json.diff.clips).toHaveLength(1);
    expect(diff.json.description.join(" ")).toMatch(/sourceOut/);
    const rejected = await api<{ change: Change }>("POST", `/changes/${r.json.change.id}/reject`, { body: { reason: "too short" } });
    expect(rejected.json.change.state).toBe("rejected");
    const after = (await api<{ project: Project }>("GET", `/projects/${project.id}`)).json.project;
    expect(after.head).toBe(head.version);
    const listed = await api<{ changes: Change[] }>("GET", `/projects/${project.id}/changes?state=rejected`);
    expect(listed.json.changes.map((c) => c.id)).toEqual([r.json.change.id]);
    // Ops against an older version are accepted as-is; merging onto the moved cut happens at approval.
    const older = await api<{ change: Change }>("POST", `/projects/${project.id}/changes`, {
      body: {
        description: "older base",
        fromVersion: firstChange.fromVersion,
        skipRender: true,
        ops: [{ op: "addClip", trackId: "v1", clip: { id: "clip_a", kind: "media", mediaId: media.id, sourceIn: 0, sourceOut: 1, timelineIn: 0 } }],
      },
    });
    expect(older.status).toBe(201);
    expect(older.json.change.fromVersion).toBe(firstChange.fromVersion);
    expect(older.json.change.ops).toHaveLength(1);
    await api("POST", `/changes/${older.json.change.id}/reject`, { body: {} });
    // Revise: creates a note and a task for the change author's agent
    const revised = await api<{ change: Change; note: Note; task: Task }>("POST", `/changes/${r.json.change.id}/revise`, {
      body: { text: "Keep it at 4 seconds instead", position: { version: r.json.change.fromVersion, time: 1.75, end: 2.25, cutIndex: 0, clipIds: [] } },
    });
    expect(revised.status).toBe(200);
    expect(revised.json.change.state).toBe("revising");
    expect(revised.json.note.changeId).toBe(r.json.change.id);
    expect(revised.json.note).toMatchObject({ version: r.json.change.fromVersion, time: 1.75 });
    expect(revised.json.task.context).toMatchObject({ changeId: r.json.change.id, version: r.json.change.fromVersion, time: 1.75, end: 2.25, cutIndex: 0 });
    expect(revised.json.task.kind).toBe("revise");
    expect(revised.json.task.agent).toBe("claude");
    expect(revised.json.task.model).toBe("opus");
    expect(revised.json.task.context.changeId).toBe(r.json.change.id);
    // The same note sent as a new request, as it is while the pass still runs, names its cut the same way. The edit's
    // number in the editor's list is kept with the request.
    const asked = await api<{ task: Task }>("POST", `/projects/${project.id}/tasks`, {
      body: { agent: "gemini", instruction: "Keep it at 4 seconds instead", context: { changeId: r.json.change.id, cutIndex: 0, time: 1.75, end: 2.25, clipIds: [], editNumber: 3 } } });
    expect(asked.status).toBe(201);
    expect(asked.json.task.instruction).toContain(`Keep it at 4 seconds instead\n\nThis feedback is about one staged cut only: cut index 0 of change ${r.json.change.id}, removing 1.75–2.25 s.`);
    expect(asked.json.task.context.editNumber).toBe(3);
    // It was only asked to read its wording: taken out again, it is nobody's to claim.
    expect((await api("POST", `/tasks/${asked.json.task.id}/cancel`, { body: {} })).status).toBe(200);
  });

  it("runs several changes in parallel: merges, sends overlaps back, undoes, and approves spots", async () => {
    const p = (await api<{ project: Project }>("POST", "/projects", { body: { name: "Parallel" } })).json.project;
    const form = new FormData();
    form.append("file", new Blob([testMp4], { type: "video/mp4" }), "take.mp4");
    let m = (await api<{ media: MediaAsset & { status: string } }>("POST", `/projects/${p.id}/media`, { form })).json.media;
    for (let i = 0; i < 100 && m.status !== "ready"; i++) {
      await sleep(200);
      m = (await api<{ media: Array<MediaAsset & { status: string }> }>("GET", `/projects/${p.id}/media`)).json.media[0]!;
    }
    const agent = { type: "agent", id: "claude", name: "Claude", model: "opus" };
    const clip = { id: "take", kind: "media", mediaId: m.id, sourceIn: 0, sourceOut: 6, timelineIn: 0 };
    const first = await api<{ change: Change }>("POST", `/projects/${p.id}/changes`, {
      body: { description: "First cut", skipRender: true, autoApprove: true, ops: [{ op: "addClip", trackId: "v1", clip }] },
    });
    expect(first.json.change.state).toBe("approved");
    const base = first.json.change.appliedVersion!;
    const propose = (description: string, ops: unknown[], fromVersion = base) =>
      api<{ change: Change }>("POST", `/projects/${p.id}/changes`, { body: { description, fromVersion, skipRender: true, author: agent, ops } });
    const headVersion = async () => (await api<{ project: Project }>("GET", `/projects/${p.id}`)).json.project.head!;
    const duration = async () => {
      const tl = (await api<{ timeline: Timeline }>("GET", `/projects/${p.id}/timeline`)).json.timeline;
      return tl.tracks.flatMap((t) => t.clips).reduce((end, c) => Math.max(end, c.kind === "media" ? c.timelineIn + (c.sourceOut - c.sourceIn) : 0), 0);
    };

    // Two agents cut different moments, both starting from the same version.
    const a = (await propose("Cut 1.0–1.5", [{ op: "rippleDelete", start: 1, end: 1.5 }])).json.change;
    const b = (await propose("Cut 4.0–4.5", [{ op: "rippleDelete", start: 4, end: 4.5 }])).json.change;
    expect(a.threadId).toBe(a.id);
    const ra = await api<{ outcome: string }>("POST", `/changes/${a.id}/approve`, { body: {} });
    expect(ra.json.outcome).toBe("applied");
    const rb = await api<{ outcome: string; change: Change; project: Project }>("POST", `/changes/${b.id}/approve`, { body: {} });
    expect(rb.status).toBe(200);
    expect(rb.json.outcome).toBe("rebased");
    expect(await duration()).toBeCloseTo(5, 3);

    // Two agents started on the same base. Selective undo keeps the second
    // agent’s source cut (4.0–4.5), including its clip IDs, after a rebase.
    const reverted = await api<{ change: Change; project: Project }>("POST", `/projects/${p.id}/versions/${a.toVersion}/revert`,
      { body: { expectedHead: rb.json.project.head, branch: "main" } });
    expect(reverted.status).toBe(200);
    const kept = (await api<{ timeline: Timeline }>("GET", `/projects/${p.id}/timeline`)).json.timeline;
    expect(kept.tracks[0]!.clips).toMatchObject([{ sourceIn: 0, sourceOut: 4 }, { sourceIn: 4.5, sourceOut: 6 }]);
    await api("POST", `/projects/${p.id}/versions/${rb.json.project.head}/checkout`);

    // Legacy clients can still withdraw the latest approval for another review.
    const undo = await api<{ change: Change; project: Project }>("POST", `/changes/${b.id}/unapprove`);
    expect(undo.json.change.state).toBe("ready");
    expect(undo.json.project.head).toBe(rb.json.change.appliedOnto);
    expect(await duration()).toBeCloseTo(5.5, 3);
    expect((await api<{ outcome: string }>("POST", `/changes/${b.id}/approve`, { body: {} })).json.outcome).toBe("rebased");

    // Undo is refused once something was approved on top.
    const c = (await propose("Cut 0.2–0.4", [{ op: "rippleDelete", start: 0.2, end: 0.4 }], await headVersion())).json.change;
    expect((await api<{ outcome: string }>("POST", `/changes/${c.id}/approve`, { body: {} })).json.outcome).toBe("applied");
    expect((await api("POST", `/changes/${b.id}/unapprove`)).status).toBe(409);

    // An edit that overlaps something approved since goes back to its agent, in its thread.
    const overlap = (await propose("Cut 1.2–1.8", [{ op: "rippleDelete", start: 1.2, end: 1.8 }])).json.change;
    const sent = await api<{ outcome: string; change: Change; task: Task }>("POST", `/changes/${overlap.id}/approve`, { body: {} });
    expect(sent.json.outcome).toBe("sent_back");
    expect(sent.json.change.state).toBe("revising");
    expect(sent.json.task.kind).toBe("revise");
    expect(sent.json.task.context.threadId).toBe(overlap.threadId);
    await api("POST", `/tasks/${sent.json.task.id}/cancel`);

    // A batch: approve only the first of two spots.
    const before = await duration();
    const batch = (
      await propose(
        "Cut two fillers",
        [
          { op: "rippleDelete", start: 0.6, end: 0.8 },
          { op: "rippleDelete", start: 3.0, end: 3.3 },
        ],
        await headVersion(),
      )
    ).json.change;
    expect(batch.ranges).toHaveLength(2);
    const part = await api<{ outcome: string; change: Change }>("POST", `/changes/${batch.id}/approve`, { body: { spots: [0] } });
    expect(part.json.outcome).toBe("partial");
    expect(part.json.change.approvedSpots).toEqual([0]);
    expect(await duration()).toBeCloseTo(before - 0.2, 3);
  });

  it("keeps follow-ups in a thread in order and respects which agents a host has free", async () => {
    const p = (await api<{ project: Project }>("POST", "/projects", { body: { name: "Threads" } })).json.project;
    const t1 = (await api<{ task: Task }>("POST", `/projects/${p.id}/tasks`, { body: { agent: "gemini", instruction: "Make the first cut" } })).json.task;
    expect(t1.context.threadId).toBe(t1.id);
    const t2 = (
      await api<{ task: Task }>("POST", `/projects/${p.id}/tasks`, { body: { agent: "gemini", instruction: "Now tighten the ending", context: { threadId: t1.id } } })
    ).json.task;
    expect(t2.context.threadId).toBe(t1.id);
    expect(t2.context.message).toBe("Now tighten the ending");
    expect(t2.instruction).toMatch(/continues an earlier request/);
    expect(t2.instruction).toMatch(/Make the first cut/);

    const reg = await api<{ host: AgentHost }>("POST", "/hosts/register", {
      body: { name: "gem-box", platform: "linux", agents: [{ id: "gemini", installed: true, loggedIn: true }] },
    });
    const h = reg.json.host;
    const none = await api<{ task: Task | null }>("POST", `/hosts/${h.id}/claim`, { body: { agents: [] } });
    expect(none.json.task).toBeNull(); // no free runtime
    const c1 = await api<{ task: Task | null }>("POST", `/hosts/${h.id}/claim`, { body: { agents: ["gemini"] } });
    expect(c1.json.task?.id).toBe(t1.id);
    const blocked = await api<{ task: Task | null }>("POST", `/hosts/${h.id}/claim`, { body: { agents: ["gemini"] } });
    expect(blocked.json.task).toBeNull(); // the follow-up waits for its thread
    await api("POST", `/tasks/${t1.id}/complete`, { body: { state: "done", summary: "Cut done" } });
    const c2 = await api<{ task: Task | null }>("POST", `/hosts/${h.id}/claim`, { body: { agents: ["gemini"] } });
    expect(c2.json.task?.id).toBe(t2.id);
    await api("POST", `/tasks/${t2.id}/complete`, { body: { state: "done" } });
    // A request the app words for the agent keeps what the editor sees apart from it: Undo edit, pressed on an edit's card.
    const undo = (await api<{ task: Task }>("POST", `/projects/${p.id}/tasks`, { body: { agent: "gemini",
      instruction: "Undo edit 2, “captions”. Put back exactly what this edit changed and leave every other edit as it is.", context: { threadId: t1.id, message: "Undo" } } })).json.task;
    expect(undo.context.message).toBe("Undo");
    expect(undo.instruction).toMatch(/continues an earlier request/);
    expect(undo.instruction).toMatch(/Put back exactly what this edit changed/);
    // A request sent while that undo still waits is told which edit it puts back, not only its name in the chat. A
    // request in the editor's own words reads as they said it, as before.
    const next = (await api<{ task: Task }>("POST", `/projects/${p.id}/tasks`, { body: { agent: "gemini",
      instruction: "Undo edit 3, “wrap”. Put back exactly what this edit changed and leave every other edit as it is.", context: { threadId: t1.id, message: "Undo" } } })).json.task;
    expect(next.instruction.split("\n").filter(line => line.startsWith("- Asked: "))).toEqual(["- Asked: Make the first cut", "- Asked: Now tighten the ending",
      "- Asked: Undo edit 2, “captions”. Put back exactly what this edit changed and leave every other edit as it is."]);
    expect([undo.context.asked, t2.context.asked]).toEqual(["Undo edit 2, “captions”. Put back exactly what this edit changed and leave every other edit as it is.", undefined]);
    // Reworded while it waits, the second undo is the editor's own words: what the app asked for them no longer stands.
    const reworded = (await api<{ task: Task }>("POST", `/tasks/${next.id}/reword`, { body: { text: "Undo the wrap, and keep its music." } })).json.task;
    expect([reworded.context.message, reworded.context.asked]).toEqual(["Undo the wrap, and keep its music.", undefined]);
    expect(reworded.instruction).toMatch(/Now: Undo the wrap, and keep its music\.$/);
    expect(reworded.instruction).not.toMatch(/Undo edit 3/);
    const c3 = await api<{ task: Task | null }>("POST", `/hosts/${h.id}/claim`, { body: { agents: ["gemini"] } });
    expect(c3.json.task?.id).toBe(undo.id);
    await api("POST", `/tasks/${undo.id}/complete`, { body: { state: "done" } });
  });

  it("creates a note assigned to an agent and queues a task", async () => {
    const r = await api<{ note: Note; task?: Task }>("POST", `/projects/${project.id}/notes`, {
      body: { time: 1.5, end: 2.5, clipIds: ["clip_a"], text: "Tighten the pause here", assignTo: "claude" },
    });
    expect(r.status).toBe(201);
    expect(r.json.note.state).toBe("in_progress");
    expect(r.json.note.assignedTo).toBe("claude");
    expect(r.json.task?.state).toBe("queued");
    expect(r.json.task?.kind).toBe("note");
    expect(r.json.task?.instruction).toBe("Tighten the pause here");
    expect(r.json.task?.context.noteIds).toEqual([r.json.note.id]);
    expect(r.json.task?.context.time).toBe(1.5);
    noteTask = r.json.task!;
    // Timeline must not have been touched by the note.
    const head = (await api<{ timeline: Timeline }>("GET", `/projects/${project.id}/timeline`)).json.timeline;
    expect(head.markers).toHaveLength(0);
    const plain = await api<{ note: Note; task?: Task }>("POST", `/projects/${project.id}/notes`, { body: { time: 4, text: "Unassigned" } });
    expect(plain.json.task).toBeUndefined();
    expect(plain.json.note.state).toBe("open");
    const open = await api<{ notes: Note[] }>("GET", `/projects/${project.id}/notes?state=open`);
    expect(open.json.notes).toHaveLength(1);
  });

  it("transcribes speech for voice actions, and explains when transcription is off", async () => {
    const missing = await api("POST", "/speech", { form: new FormData() });
    expect(missing.status).toBe(400);
    const form = new FormData();
    form.append("audio", new Blob([testMp4], { type: "video/mp4" }), "clip.mp4");
    const r = await api<{ error: { code: string; message: string } }>("POST", "/speech", { form });
    // The test app has no OPENAI_API_KEY and settings say "none".
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("transcription_not_configured");
    expect(r.json.error.message).toMatch(/OPENAI_API_KEY|whisper/);
  });

  it("lets an agent host register, claim the task, stream events and complete it", async () => {
    // The agent host uses the same access token as the UI.
    const agentToken = ownerToken;
    const reg = await api<{ host: AgentHost }>("POST", "/hosts/register", {
      token: agentToken,
      body: { name: "matt-laptop", platform: "win32", agents: [{ id: "claude", installed: true, loggedIn: true, version: "2.1" }, { id: "codex", installed: false }] },
    });
    expect(reg.status).toBe(201);
    host = reg.json.host;
    expect(host.online).toBe(true);
    const hosts = await api<{ hosts: AgentHost[] }>("GET", "/hosts");
    expect(hosts.json.hosts.map((h) => h.id)).toContain(host.id);

    // Two queued claude tasks exist (revise + note); the oldest (revise) comes first.
    const claim1 = await api<{ task: Task | null }>("POST", `/hosts/${host.id}/claim`, { token: agentToken, body: {} });
    expect(claim1.json.task?.kind).toBe("revise");
    expect(claim1.json.task?.state).toBe("claimed");
    // One request at a time in a project: the note waits until the revision finishes.
    expect((await api<{ task: Task | null }>("POST", `/hosts/${host.id}/claim`, { token: agentToken, body: {} })).json.task).toBeNull();
    await api("POST", `/tasks/${claim1.json.task!.id}/complete`, { token: agentToken, body: { state: "done", summary: "Revised" } });
    const claim2 = await api<{ task: Task | null }>("POST", `/hosts/${host.id}/claim`, { token: agentToken, body: {} });
    expect(claim2.json.task?.id).toBe(noteTask.id);
    expect(claim2.json.task?.hostId).toBe(host.id);
    const claim3 = await api<{ task: Task | null }>("POST", `/hosts/${host.id}/claim?wait=1`, { token: agentToken, body: {} });
    expect(claim3.json.task).toBeNull();

    const ev1 = await api("POST", `/tasks/${noteTask.id}/events`, { token: agentToken, body: { type: "log", text: "starting", startedAt: claim2.json.task!.startedAt } });
    expect(ev1.status).toBe(200);
    let task = (await api<{ task: Task; events: TaskEvent[] }>("GET", `/tasks/${noteTask.id}`)).json;
    expect(task.task.state).toBe("running");
    expect(task.events).toHaveLength(1);

    const ask = () => api<{ waiting: boolean }>("POST", `/tasks/${noteTask.id}/question`, {
      token: agentToken, body: { startedAt: claim2.json.task!.startedAt, text: "Cut 1.5s to 2.5s entirely?" },
    });
    expect((await ask()).json.waiting).toBe(true);
    expect((await ask()).json.waiting).toBe(true);
    task = (await api<{ task: Task; events: TaskEvent[] }>("GET", `/tasks/${noteTask.id}`)).json;
    expect(task.task.state).toBe("waiting_for_user");
    expect(task.task.question).toBe("Cut 1.5s to 2.5s entirely?");
    expect(task.events.filter(e => e.type === "question")).toHaveLength(1);

    const answer = await api<{ task: Task }>("POST", `/tasks/${noteTask.id}/answer`, { body: { text: "Yes" } });
    expect(answer.json.task.state).toBe("queued");
    expect(answer.json.task.question).toBeNull();
    expect(answer.json.task.hostId).toBeNull();
    expect((await ask()).json.waiting).toBe(false);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const firstStart = Date.parse(claim2.json.task!.startedAt!);
      vi.setSystemTime(firstStart - 5000);
      const resumed = await api<{ task: Task }>("POST", `/hosts/${host.id}/claim`, { body: {} });
      expect(resumed.json.task.id).toBe(noteTask.id);
      expect(Date.parse(resumed.json.task.startedAt!)).toBe(firstStart + 1);
    } finally {
      vi.useRealTimers();
    }
    expect((await ask()).json.waiting).toBe(false);
    const stale = await api<{ task: Task }>("POST", `/tasks/${noteTask.id}/complete`, {
      body: { ifStartedAt: claim2.json.task!.startedAt, state: "failed", error: "delivery failed" },
    });
    expect(stale.json.task.state).toBe("claimed");

    const done = await api<{ task: Task }>("POST", `/tasks/${noteTask.id}/complete`, {
      token: agentToken,
      body: { state: "done", summary: "Proposed a change", changeIds: [firstChange.id] },
    });
    expect(done.json.task.state).toBe("done");
    expect(done.json.task.changeIds).toEqual([firstChange.id]);
    const again = await api("POST", `/tasks/${noteTask.id}/complete`, { token: agentToken, body: { state: "done" } });
    expect(again.status).toBe(409);
    const byState = await api<{ tasks: Task[] }>("GET", `/projects/${project.id}/tasks?state=done`);
    expect(byState.json.tasks.map((t) => t.id)).toContain(noteTask.id);
  });

  it("manages skills with versions and a disk mirror", async () => {
    const content = "---\nname: first-cut-dialogue\ndescription: Make a first cut from a transcript\n---\n\n# First cut\n\nDo the thing.\n";
    const r = await api<{ skill: Skill }>("POST", "/skills", {
      body: { name: "first-cut-dialogue", content, scope: "team", agents: ["claude", "codex"] },
    });
    expect(r.status).toBe(201);
    const skill = r.json.skill;
    expect(skill.description).toBe("Make a first cut from a transcript");
    expect(skill.version).toBe(1);
    const disk = join(dataDir, "skills", "team", "first-cut-dialogue", "SKILL.md");
    expect(existsSync(disk)).toBe(true);
    expect(readFileSync(disk, "utf8")).toBe(content);

    const dup = await api("POST", "/skills", { body: { name: "first-cut-dialogue", content, scope: "team" } });
    expect(dup.status).toBe(409);

    const updated = await api<{ skill: Skill }>("PUT", `/skills/${skill.id}`, { body: { content: content + "\nMore.\n" } });
    expect(updated.json.skill.version).toBe(2);
    expect(readFileSync(disk, "utf8")).toContain("More.");
    const detail = await api<{ skill: Skill; versions: SkillVersion[] }>("GET", `/skills/${skill.id}`);
    expect(detail.json.versions.map((v) => v.version)).toEqual([1, 2]);

    const personal = await api("POST", "/skills", {
      body: { name: "my-style", content: "# Mine", scope: "personal" },
    });
    expect(personal.status).toBe(400);
    const list = await api<{ skills: Skill[] }>("GET", "/skills");
    expect(list.json.skills.map((s) => s.name)).toEqual(["first-cut-dialogue"]);

    const fromChange = await api<{ task: Task }>("POST", "/skills/from-change", { body: { changeId: firstChange.id, name: "lay-full-clip" } });
    expect(fromChange.status).toBe(201);
    expect(fromChange.json.task.kind).toBe("skill_from_change");

    const del = await api("DELETE", `/skills/${skill.id}`);
    expect(del.status).toBe(200);
    expect(existsSync(disk)).toBe(false);
    expect((await api("GET", `/skills/${skill.id}`)).status).toBe(404);
  });

  it("saves only the skill requested for a claimed task and approved version", async () => {
    const slug = "learn-approved-edit";
    const start = (name: string) => api<{ task: Task }>("POST", "/skills/from-change", { body: { changeId: firstChange.id, name, agent: "claude" } });
    const task = (await start(slug)).json.task;
    const source = scarlet.ctx.repos.changes.get(firstChange.id)!;
    expect(task.context).toMatchObject({ skillName: slug, changeId: source.id, version: source.appliedVersion ?? source.toVersion });
    expect(task.instruction).toContain("skill_save_from_change");
    const prompt = (await api<{ systemPrompt: string; plan?: boolean }>("GET", `/tasks/${task.id}/prompt`)).json;
    expect(prompt.systemPrompt).toContain("writing a skill from an approved change");
    expect(prompt.systemPrompt).toContain(source.appliedVersion ?? source.toVersion);
    expect(prompt.systemPrompt).not.toMatch(/You are editing a video|Revise it by proposing|# Project/);
    expect(prompt.plan).toBeUndefined();
    const endpoint = `/projects/${project.id}/tasks/${task.id}/skill`;
    const draft = { changeId: source.id, hostId: host.id, description: "Start the cut", instructions: "# Edit\nUse the approved opening." };
    expect((await api("POST", endpoint, { body: draft })).status).toBe(403); // queued
    expect((await api("POST", `/projects/${project.id}/tasks`, { body: { kind: "skill_from_change", agent: "claude", instruction: "save", context: task.context } })).status).toBe(400);
    // Requests run one at a time in a project. Clear the earlier skill request so this one's turn comes.
    for (const queued of scarlet.ctx.repos.tasks.select("project_id = ? AND state = 'queued' AND id != ?", [project.id, task.id]))
      await api("POST", `/tasks/${queued.id}/cancel`);
    const claimed = await api<{ task: Task | null }>("POST", `/hosts/${host.id}/claim`, { body: { taskId: task.id } });
    expect(claimed.json.task?.id).toBe(task.id);
    const forbid = await api("POST", `/projects/${project.id}/changes`, {
      headers: { "X-Scarlet-Task": task.id, "X-Scarlet-Task-Started-At": claimed.json.task!.startedAt! },
      body: { description: "A separate edit", fromVersion: task.context.version, ops: [{ op: "addMarker", marker: { id: "m_unwanted", time: 0, text: "Unexpected" } }] },
    });
    expect(forbid.status, JSON.stringify(forbid.json)).toBe(403);
    expect(scarlet.ctx.repos.changes.select("json_extract(json, '$.taskId') = ?", [task.id])).toHaveLength(0);
    expect((await api("POST", endpoint, { body: { ...draft, name: "substitute" } })).status).toBe(400);
    expect((await api("POST", endpoint, { body: { ...draft, changeId: "different-change" } })).status).toBe(403);
    expect((await api("POST", endpoint, { body: { ...draft, hostId: "other-host" } })).status).toBe(403);
    const other = (await api<{ project: Project }>("POST", "/projects", { body: { name: "Other skill project" } })).json.project;
    expect((await api("POST", `/projects/${other.id}/tasks/${task.id}/skill`, { body: draft })).status).toBe(404);
    expect((await api("POST", `/projects/${project.id}/tasks/${noteTask.id}/skill`, { body: draft })).status).toBe(403);
    scarlet.ctx.repos.changes.put({ ...source, state: "ready" });
    expect((await start("unapproved-edit")).status).toBe(409);
    expect((await api("POST", endpoint, { body: draft })).status).toBe(409);
    scarlet.ctx.repos.changes.put({ ...source, appliedVersion: "changed-version" });
    expect((await api("POST", endpoint, { body: draft })).status).toBe(409);
    scarlet.ctx.repos.changes.put(source);
    const result = await api<{ skill: Skill }>("POST", endpoint, { body: draft });
    expect(result.status).toBe(201);
    expect(result.json.skill).toMatchObject({ scope: "team", name: slug, source: `change:${source.id}` });
    expect(readFileSync(join(dataDir, "skills", "team", slug, "SKILL.md"), "utf8")).toBe(result.json.skill.content);
    expect((await api<{ skill: Skill }>("POST", endpoint, { body: draft })).json.skill.id).toBe(result.json.skill.id);
    expect((await api("POST", endpoint, { body: { ...draft, instructions: "overwrite" } })).status).toBe(409);
    expect((await start(slug)).status).toBe(409);
    const completed = await api<{ task: Task }>("POST", `/tasks/${task.id}/complete`, { body: { state: "done" } });
    expect(completed.json.task).toMatchObject({ state: "done", resultSkillId: result.json.skill.id });
    expect((await api("POST", endpoint, { body: draft })).status).toBe(403);
    const unsaved = (await start("unsaved-edit")).json.task;
    expect((await api<{ task: Task }>("POST", `/tasks/${unsaved.id}/complete`, { body: { state: "done", summary: "Saved" } })).json.task.state).toBe("failed");
  });

  it("revises a skill from the editor's prompt, apart from the project's queue and conversation", async () => {
    const header = "---\nname: house-style\ndescription: House rules\ncategory: Story and pacing\n---\n";
    const skill = (await api<{ skill: Skill }>("POST", "/skills", { body: { name: "house-style", description: "House rules", content: `${header}\nKeep the cold open.\n` } })).json.skill;
    const other = (await api<{ skill: Skill }>("POST", "/skills", { body: { name: "other-style", content: "# Other" } })).json.skill;
    // A request of the project's own is running when the editor asks for the change.
    for (const queued of scarlet.ctx.repos.tasks.select("project_id = ? AND state = 'queued'", [project.id])) await api("POST", `/tasks/${queued.id}/cancel`);
    const running = (await api<{ task: Task }>("POST", `/projects/${project.id}/tasks`, { body: { agent: "claude", instruction: "Tighten the intro" } })).json.task;
    expect((await api<{ task: Task | null }>("POST", `/hosts/${host.id}/claim`, { body: { taskId: running.id } })).json.task?.id).toBe(running.id);

    // The request runs from the project worked on last.
    await new Promise(resolve => setTimeout(resolve, 5));
    scarlet.ctx.repos.projects.touch(project.id);
    const asked = await api<{ task: Task }>("POST", `/skills/${skill.id}/edit`, { body: { prompt: "Never cut laughter.", agent: "claude" } });
    expect(asked.status).toBe(201);
    const task = asked.json.task;
    expect(task.projectId).toBe(project.id);
    expect(task).toMatchObject({ kind: "skill_edit", instruction: "Never cut laughter.", context: { skillId: skill.id } });
    expect((await api("POST", `/skills/${skill.id}/edit`, { body: { prompt: "And again." } })).status).toBe(409);
    expect((await api("POST", `/projects/${project.id}/tasks`, { body: { kind: "skill_edit", agent: "claude", instruction: "x", context: task.context } })).status).toBe(400);
    const listed = (await api<{ tasks: Task[] }>("GET", `/projects/${task.projectId}/tasks`)).json.tasks.map(t => t.id);
    expect(listed).not.toContain(task.id);

    const endpoint = `/projects/${task.projectId}/tasks/${task.id}/skill-edit`;
    const draft = { skillId: skill.id, hostId: host.id, description: "House rules for every cut", instructions: "Keep the cold open.\n\nNever cut laughter." };
    expect((await api("POST", endpoint, { body: draft })).status).toBe(403); // queued
    // It doesn't wait for the project's request, and the project's next request doesn't wait for it.
    expect((await api<{ task: Task | null }>("POST", `/hosts/${host.id}/claim`, { body: { taskId: task.id } })).json.task?.id).toBe(task.id);
    await api("POST", `/tasks/${running.id}/complete`, { body: { state: "done" } });
    const next = (await api<{ task: Task }>("POST", `/projects/${project.id}/tasks`, { body: { agent: "claude", instruction: "Lift the music" } })).json.task;
    expect((await api<{ task: Task | null }>("POST", `/hosts/${host.id}/claim`, { body: { taskId: next.id } })).json.task?.id).toBe(next.id);
    await api("POST", `/tasks/${next.id}/cancel`);

    const prompt = (await api<{ systemPrompt: string; instruction: string }>("GET", `/tasks/${task.id}/prompt`)).json;
    expect(prompt.instruction).toBe("Never cut laughter.");
    expect(prompt.systemPrompt).toContain("# The skill: house-style");
    expect(prompt.systemPrompt).toContain("Keep the cold open.");
    expect(prompt.systemPrompt).toContain("skill_save_edit");
    expect(prompt.systemPrompt).not.toContain("# Project\n");

    expect((await api("POST", endpoint, { body: { ...draft, skillId: other.id } })).status).toBe(403);
    expect((await api("POST", endpoint, { body: { ...draft, hostId: "other-host" } })).status).toBe(403);
    expect((await api("POST", endpoint, { body: { ...draft, name: "renamed" } })).status).toBe(400);
    const saved = await api<{ skill: Skill }>("POST", endpoint, { body: draft });
    expect(saved.status).toBe(200);
    // The name and the rest of the header are the editor's. The description and the instructions are the revision.
    expect(saved.json.skill).toMatchObject({ name: "house-style", version: 2, description: draft.description });
    expect(saved.json.skill.content).toBe(`---\nname: house-style\ndescription: House rules for every cut\ncategory: Story and pacing\n---\n\n${draft.instructions}\n`);
    // A response lost on the way is sent again and changes nothing.
    expect((await api<{ skill: Skill }>("POST", endpoint, { body: draft })).json.skill.version).toBe(2);

    await api("POST", `/tasks/${task.id}/complete`, { body: { state: "done", summary: "Added a rule to keep laughter." } });
    const detail = (await api<{ skill: Skill; versions: SkillVersion[]; edits: Task[] }>("GET", `/skills/${skill.id}`)).json;
    expect(detail.versions.map(v => v.author?.type)).toEqual(["human", "agent"]);
    expect(detail.edits).toMatchObject([{ id: task.id, state: "done", resultSkillId: skill.id, summary: "Added a rule to keep laughter." }]);
    expect((await api("POST", endpoint, { body: draft })).status).toBe(403);
    // One that ends without a revision says so in its own words. It is not a failure.
    const declined = (await api<{ task: Task }>("POST", `/skills/${skill.id}/edit`, { body: { prompt: "Keep the cold open." } })).json.task;
    await api("POST", `/hosts/${host.id}/claim`, { body: { taskId: declined.id } });
    expect((await api<{ task: Task }>("POST", `/tasks/${declined.id}/complete`, { body: { state: "done", summary: "It already says that." } })).json.task)
      .toMatchObject({ state: "done", summary: "It already says that." });
    // The skill's page keeps every request, in the order asked.
    expect((await api<{ edits: Task[] }>("GET", `/skills/${skill.id}`)).json.edits.map(t => t.id)).toEqual([task.id, declined.id]);
    expect((await api<{ edits: Task[] }>("GET", `/skills/${other.id}`)).json.edits).toEqual([]);
  });

  it("reads each request for a standing rule as it is sent, beside the request and out of the conversation", async () => {
    await api("POST", "/skills", { body: { name: "checked-style", description: "How the picture is framed", content: "# Framing" } });
    for (const open of scarlet.ctx.repos.tasks.select("project_id = ? AND state IN ('queued','claimed','running','waiting_for_user')", [project.id])) await api("POST", `/tasks/${open.id}/cancel`);
    const checks = () => scarlet.ctx.repos.tasks.select("project_id = ? AND kind = 'learning_check'", [project.id], "rowid ASC");
    const before = checks().length;
    const said = "Any time I’m talking to the camera, go full screen with my A-roll.";
    const asked = (await api<{ task: Task }>("POST", `/projects/${project.id}/tasks`, { body: { agent: "claude", fast: true, instruction: said } })).json.task;
    const [check] = checks().slice(before);
    // The check runs with the request's agent, model and speed, and reads the editor's words.
    expect(check).toMatchObject({ kind: "learning_check", agent: "claude", fast: true, state: "queued", instruction: said, context: { checksTaskId: asked.id } });
    expect(checks()).toHaveLength(before + 1);
    // It isn't a request of the project's: not in its list, and it can't be asked for.
    expect((await api<{ tasks: Task[] }>("GET", `/projects/${project.id}/tasks`)).json.tasks.map(t => t.id)).not.toContain(check!.id);
    expect((await api("POST", `/projects/${project.id}/tasks`, { body: { agent: "claude", kind: "learning_check", instruction: said } })).status).toBe(400);
    // It starts while the request runs, and a later request doesn't wait for it.
    const claim = async (taskId: string) => (await api<{ task: Task | null }>("POST", `/hosts/${host.id}/claim`, { body: { taskId } })).json.task?.state;
    expect(await claim(asked.id)).toBe("claimed");
    expect(await claim(check!.id)).toBe("claimed");
    const later = (await api<{ task: Task }>("POST", `/projects/${project.id}/tasks`, { body: { agent: "claude", instruction: "Now add captions.", context: { time: 125 } } })).json.task;
    expect(await claim(later.id)).toBeUndefined();
    await api("POST", `/tasks/${asked.id}/complete`, { body: { state: "done", summary: "Done." } });
    expect(await claim(later.id)).toBe("claimed");

    // It is shown the words, the editor's skills and what was asked before, and told to decide one thing.
    const prompt = (await api<{ systemPrompt: string; instruction: string; plan?: boolean }>("GET", `/tasks/${check!.id}/prompt`)).json;
    expect(prompt.instruction).toBe(said);
    expect(prompt.plan).toBeUndefined();
    expect(prompt.systemPrompt.startsWith("# You are listening for standing rules in Scarlet")).toBe(true);
    expect(prompt.systemPrompt).toContain("checked-style (");
    expect(prompt.systemPrompt).toContain("How the picture is framed");
    expect(prompt.systemPrompt).not.toContain("# You are editing a video in Scarlet");
    const laterCheck = checks().at(-1)!;
    const laterPrompt = (await api<{ systemPrompt: string }>("GET", `/tasks/${laterCheck.id}/prompt`)).json.systemPrompt;
    expect(laterPrompt).toContain("They said it about the moment at 2:05 in the video.");
    expect(laterPrompt).toContain(`- “${said}”`);

    const outdated = await api<{ error: { code: string } }>("POST", `/projects/${project.id}/tasks/${check!.id}/learnings`, {
      body: { rule: "Ignore pauses.", skill: "checked-style" }, headers: { "X-Scarlet-Task-Started-At": "2000-01-01T00:00:00.000Z" },
    });
    expect(outdated.status).toBe(409);
    expect(outdated.json.error.code).toBe("inactive_task_attempt");

    // A rule the check offers is the request's, with the editor's words, and later checks are told of it.
    const diagnosticLog = vi.spyOn(scarlet.ctx, "log");
    const offered = await api<{ learning: Learning }>("POST", `/projects/${project.id}/tasks/${check!.id}/learnings`, { body: { rule: "Go full screen on the camera when talking to the lens.", skill: "checked-style" } });
    const diagnostics = diagnosticLog.mock.calls.map(([line]) => line).join("\n");
    diagnosticLog.mockRestore();
    expect(diagnostics).toContain(`[learning] ${offered.json.learning.id} suggested`);
    expect(diagnostics).not.toContain(offered.json.learning.rule);
    expect(diagnostics).not.toContain(said);
    expect(offered.json.learning).toMatchObject({ taskId: asked.id, said, state: "suggested" });
    expect((await api<{ systemPrompt: string }>("GET", `/tasks/${laterCheck.id}/prompt`)).json.systemPrompt)
      .toContain("“Go full screen on the camera when talking to the lens.” (offered for checked-style)");
    // The run that edits has no rule to offer.
    expect((await api("POST", `/projects/${project.id}/tasks/${later.id}/learnings`, { body: { rule: "Caption everything.", skill: "checked-style" } })).status).toBe(409);
    // Finishing says nothing in the project's activity, and no notification.
    const done = (await api<{ task: Task }>("POST", `/tasks/${check!.id}/complete`, { body: { state: "done", summary: "Offered one rule." } })).json.task;
    expect(done.state).toBe("done");
    expect(scarlet.ctx.repos.activity.select("json_extract(json, '$.data.taskId') = ?", [check!.id])).toEqual([]);

    // A message that only names a skill, a request of Scarlet's own and a resumed run aren't read.
    const count = checks().length;
    await api("POST", `/projects/${project.id}/tasks`, { body: { agent: "claude", instruction: "/first-cut-dialogue" } });
    expect(checks()).toHaveLength(count);
    await api("POST", `/projects/${project.id}/learnings/${offered.json.learning.id}/decline`);
    for (const open of scarlet.ctx.repos.tasks.select("project_id = ? AND state IN ('queued','claimed','running')", [project.id])) await api("POST", `/tasks/${open.id}/cancel`);
  });

  it("keeps a rule Scarlet picked up until the editor approves it, then has the skill revised with it", async () => {
    const skill = (await api<{ skill: Skill }>("POST", "/skills", { body: { name: "learned-style", description: "House rules", content: "---\nname: learned-style\ndescription: House rules\n---\n\nKeep the cold open.\n" } })).json.skill;
    const other = (await api<{ skill: Skill }>("POST", "/skills", { body: { name: "learned-other", content: "# Other" } })).json.skill;
    for (const queued of scarlet.ctx.repos.tasks.select("project_id = ? AND state = 'queued'", [project.id])) await api("POST", `/tasks/${queued.id}/cancel`);
    const asked = (await api<{ task: Task }>("POST", `/projects/${project.id}/tasks`, { body: { agent: "claude", instruction: "Keep the breath before the punchline." } })).json.task;
    const check = scarlet.ctx.repos.tasks.select("kind = 'learning_check' AND json_extract(json, '$.context.checksTaskId') = ?", [asked.id])[0]!;
    await api("POST", `/hosts/${host.id}/claim`, { body: { taskId: check.id } });

    // The check offers a rule from the request it reads. Nothing in the skill changes.
    const offer = `/projects/${project.id}/tasks/${check.id}/learnings`;
    const first = await api<{ learning: Learning; skill: { id: string; name: string } }>("POST", offer, { body: { rule: "Leave the breath before a punchline.", skill: "learned-style" } });
    expect(first.status).toBe(201);
    expect(first.json.learning).toMatchObject({ projectId: project.id, taskId: asked.id, skillId: skill.id, state: "suggested", said: "Keep the breath before the punchline." });
    expect(first.json.skill).toEqual({ id: skill.id, name: "learned-style" });
    expect((await api<{ learning: Learning }>("POST", offer, { body: { rule: "leave the breath before a punchline.", skill: skill.id } })).json.learning.id).toBe(first.json.learning.id);
    expect((await api("POST", offer, { body: { rule: "Never cut laughter.", skill: "no-such-skill" } })).status).toBe(404);
    expect((await api("POST", offer, { body: { rule: "Two\nlines", skill: "learned-style" } })).status).toBe(400);
    const second = (await api<{ learning: Learning }>("POST", offer, { body: { rule: "Never cut laughter.", skill: "learned-style" } })).json.learning;
    const list = async () => (await api<{ learnings: Learning[] }>("GET", `/projects/${project.id}/learnings`)).json.learnings;
    expect((await list()).map(l => l.id)).toEqual([first.json.learning.id, second.id]);
    expect((await api<{ skill: Skill }>("GET", `/skills/${skill.id}`)).json.skill.version).toBe(1);

    // The editor can reword a rule that waits on them, in one line. Their words it came from stay as they were.
    const revise = (id: string, rule: string) => api<{ learning: Learning }>("PATCH", `/projects/${project.id}/learnings/${id}`, { body: { rule } });
    expect((await revise(second.id, "Never cut a laugh.")).json.learning).toMatchObject({ id: second.id, rule: "Never cut a laugh.", said: "Keep the breath before the punchline.", state: "suggested" });
    expect((await revise(second.id, "Two\nlines")).status).toBe(400);
    expect((await revise(second.id, "   ")).status).toBe(400);
    expect((await list()).find(l => l.id === second.id)?.rule).toBe("Never cut a laugh.");

    // Approving one starts a revision of the skill, in the approver's name. A second for the same skill waits its turn.
    const approve = (id: string, body = {}) => api<{ learning: Learning }>("POST", `/projects/${project.id}/learnings/${id}/approve`, { body });
    const saving = (await approve(first.json.learning.id)).json.learning;
    expect(saving).toMatchObject({ state: "saving", skillId: skill.id });
    const edit = scarlet.ctx.repos.tasks.get(saving.editTaskId!)!;
    expect(edit).toMatchObject({ kind: "skill_edit", agent: "claude", projectId: project.id, context: { skillId: skill.id, learningId: saving.id } });
    expect(edit.model).toBeUndefined();
    expect((await approve(first.json.learning.id)).status).toBe(409);
    const waiting = (await approve(second.id)).json.learning;
    expect(waiting.state).toBe("saving");
    expect(waiting.editTaskId).toBeUndefined();
    expect((await api<{ tasks: Task[] }>("GET", `/projects/${project.id}/tasks`)).json.tasks.map(t => t.id)).not.toContain(edit.id);

    const prompt = (await api<{ systemPrompt: string; instruction: string }>("GET", `/tasks/${edit.id}/prompt`)).json;
    expect(prompt.instruction).toContain("Work this standing rule into the skill: “Leave the breath before a punchline.”");
    expect(prompt.instruction).toContain("shown nothing in it that the rule would replace.");
    expect(prompt.instruction).toContain("They said: “Keep the breath before the punchline.”");
    expect(prompt.systemPrompt).toContain("The editor approved a rule for the skill below.");
    expect(prompt.systemPrompt).not.toContain("Their request is your instruction, in their words.");

    // The revision saves the skill; the rule is settled and the next one starts.
    await api("POST", `/hosts/${host.id}/claim`, { body: { taskId: edit.id } });
    const draft = { skillId: skill.id, hostId: host.id, description: "House rules", instructions: "Keep the cold open.\n\nLeave the breath before a punchline." };
    const saveRule = (instructions: string) => api<{ skill: Skill }>("POST", `/projects/${project.id}/tasks/${edit.id}/skill-edit`, { body: { ...draft, instructions } });
    expect((await saveRule(draft.instructions)).json.skill.version).toBe(2);
    expect((await saveRule(draft.instructions)).json.skill.version).toBe(2);
    expect((await saveRule(draft.instructions + "\nLeave the breath before a punchline.")).status).toBe(409);
    expect(scarlet.ctx.repos.skills.get(skill.id)!.version).toBe(2);
    await api("POST", `/tasks/${edit.id}/complete`, { body: { state: "done", summary: "Added the rule." } });
    expect(scarlet.ctx.repos.learnings.get(saving.id)).toMatchObject({ state: "saved" });
    const [left] = await list();
    expect(left).toMatchObject({ id: second.id, state: "saving" });
    const next = scarlet.ctx.repos.tasks.get(left!.editTaskId!)!;
    expect(next.context).toMatchObject({ skillId: skill.id, learningId: second.id });
    expect((await api<{ instruction: string }>("GET", `/tasks/${next.id}/prompt`)).json.instruction).toContain("Work this standing rule into the skill: “Never cut a laugh.”");
    expect((await revise(second.id, "Never cut laughter.")).status).toBe(409);

    // One that ends without changing the skill goes back to the editor with Scarlet's reason.
    await api("POST", `/hosts/${host.id}/claim`, { body: { taskId: next.id } });
    await api("POST", `/tasks/${next.id}/complete`, { body: { state: "done", summary: "It already says that." } });
    expect((await list())[0]).toMatchObject({ id: second.id, state: "suggested", error: "It already says that." });
    // Reworded, the reason it wasn't saved no longer holds.
    const rewritten = (await revise(second.id, "Never cut laughter.")).json.learning;
    expect(rewritten).toMatchObject({ rule: "Never cut laughter.", state: "suggested" });
    expect(rewritten).not.toHaveProperty("error");

    // They can send it to another skill, or decline it. The save runs on the model chosen as they approve, not the
    // one the request ran on, which they may have left because it stopped working.
    const moved = (await approve(second.id, { skillId: other.id, agent: "claude", model: "opus", effort: "high" })).json.learning;
    expect(moved).toMatchObject({ state: "saving", skillId: other.id, runWith: { agent: "claude", model: "opus", effort: "high" } });
    expect(scarlet.ctx.repos.tasks.get(moved.editTaskId!)).toMatchObject({ kind: "skill_edit", agent: "claude", model: "opus", effort: "high" });
    await api("POST", `/tasks/${moved.editTaskId}/cancel`);
    expect((await list())[0]).toMatchObject({ state: "suggested", error: "Saving was stopped." });
    const declined = await api<{ learning: Learning }>("POST", `/projects/${project.id}/learnings/${second.id}/decline`);
    expect(declined.json.learning.state).toBe("declined");
    expect(await list()).toEqual([]);
    expect((await api("POST", `/projects/${project.id}/learnings/${second.id}/decline`)).status).toBe(409);
    await api("POST", `/tasks/${asked.id}/cancel`);
  });

  it("shows what a rule replaces in its skill before it is approved, and has the save revise the skill around it", async () => {
    const content = "---\nname: replacing-style\ndescription: House rules\n---\n\nKeep the cold open.\n\n## Laughs\n\nCut a laugh to its **first beat**, so the talk moves on.\n";
    const skill = (await api<{ skill: Skill }>("POST", "/skills", { body: { name: "replacing-style", description: "House rules", content } })).json.skill;
    const other = (await api<{ skill: Skill }>("POST", "/skills", { body: { name: "replacing-other", content: "# Other" } })).json.skill;
    for (const queued of scarlet.ctx.repos.tasks.select("project_id = ? AND state = 'queued'", [project.id])) await api("POST", `/tasks/${queued.id}/cancel`);
    const asked = (await api<{ task: Task }>("POST", `/projects/${project.id}/tasks`, { body: { agent: "claude", instruction: "Don’t cut the laugh, ever." } })).json.task;
    const check = scarlet.ctx.repos.tasks.select("kind = 'learning_check' AND json_extract(json, '$.context.checksTaskId') = ?", [asked.id])[0]!;
    await api("POST", `/hosts/${host.id}/claim`, { body: { taskId: check.id } });
    const checkPrompt = (await api<{ systemPrompt: string }>("GET", `/tasks/${check.id}/prompt`)).json.systemPrompt;
    expect(checkPrompt).toContain("read the skill it belongs in, in full, with `skills_list`");

    // A quote must be the skill's own words, so the editor reads what the skill says and not the model's account of it.
    const offer = `/projects/${project.id}/tasks/${check.id}/learnings`;
    const made = await api<{ error: { code: string; message: string } }>("POST", offer, { body: { rule: "Never cut laughter.", skill: skill.id, replaces: ["Cut every laugh short."] } });
    expect(made.status).toBe(400);
    expect(made.json.error).toMatchObject({ code: "not_in_skill", message: expect.stringContaining("isn’t in replacing-style word for word") });
    // Quote marks, emphasis, case and line breaks needn't match. The passage is kept as quoted.
    const quote = "“Cut a laugh to its first beat, so the talk moves on.”";
    const rule = (await api<{ learning: Learning }>("POST", offer, { body: { rule: "Never cut laughter.", skill: skill.id, replaces: [quote, "cut a laugh to its first beat"] } })).json.learning;
    expect(rule.replaces).toEqual([quote]);
    expect(scarlet.ctx.repos.skills.get(skill.id)!.version).toBe(1);
    // Reworded by the editor, it keeps what it replaces: they read those passages beside it.
    const reworded = (await api<{ learning: Learning }>("PATCH", `/projects/${project.id}/learnings/${rule.id}`, { body: { rule: "Never cut a laugh short." } })).json.learning;
    expect(reworded).toMatchObject({ rule: "Never cut a laugh short.", replaces: [quote] });

    // Approved, the save is told what the editor was shown it replaces, and to revise the skill around the rule.
    const approve = (body = {}) => api<{ learning: Learning }>("POST", `/projects/${project.id}/learnings/${rule.id}/approve`, { body });
    const saving = (await approve()).json.learning;
    expect(saving).toMatchObject({ state: "saving", replaces: [quote] });
    const prompt = (await api<{ systemPrompt: string; instruction: string }>("GET", `/tasks/${saving.editTaskId}/prompt`)).json;
    expect(prompt.instruction).toContain(`shown that it replaces what the skill says here:\n- “${quote}”`);
    expect(prompt.systemPrompt).toContain("take out approved passages it contradicts or repeats, so the skill says one thing");
    expect(prompt.systemPrompt).toContain("If the skill says otherwise somewhere they weren’t shown, or anything else needs their decision, save nothing and end by quoting what it says and asking");
    expect(prompt.systemPrompt).toContain("quoting anything the rule replaced");

    // A conflict they weren't shown stops the save, and they read it under the rule.
    const stopped = "The skill also says “Keep the cold open.”, which cuts the laugh in the open.";
    await api("POST", `/hosts/${host.id}/claim`, { body: { taskId: saving.editTaskId } });
    const draft = { skillId: skill.id, hostId: host.id, description: "House rules", instructions: "## Laughs\n\nNever cut a laugh short." };
    const unapproved = await api<{ error: { code: string } }>("POST", `/projects/${project.id}/tasks/${saving.editTaskId}/skill-edit`, { body: draft });
    expect(unapproved.json.error.code).toBe("unapproved_skill_rewrite");
    expect(scarlet.ctx.repos.skills.get(skill.id)?.version).toBe(1);
    await api("POST", `/tasks/${saving.editTaskId}/complete`, { body: { state: "done", summary: stopped } });
    expect(scarlet.ctx.repos.learnings.get(rule.id)).toMatchObject({ state: "suggested", error: stopped, replaces: [quote] });
    // Approving again, the next save is told they read it.
    const again = (await approve()).json.learning;
    expect(again).toMatchObject({ state: "saving", approvedAfter: stopped });
    expect(again.error).toBeUndefined();
    const retold = (await api<{ instruction: string }>("GET", `/tasks/${again.editTaskId}/prompt`)).json.instruction;
    expect(retold).toContain(`The last attempt to save it changed nothing and said: “${stopped}” They read that and approved again.`);

    // Learnings has no message box, so a save that asks the editor something doesn't wait for an answer that can't
    // come: it saves nothing, and the rule goes back to them with the question, to reword or approve again.
    const asking = "Should the rule cover the cold open too, or should the open keep its cut?";
    await api("POST", `/hosts/${host.id}/claim`, { body: { taskId: again.editTaskId } });
    const startedAt = scarlet.ctx.repos.tasks.get(again.editTaskId!)!.startedAt;
    expect((await api<{ waiting: boolean }>("POST", `/tasks/${again.editTaskId}/question`, { body: { startedAt, text: asking } })).json.waiting).toBe(false);
    expect(scarlet.ctx.repos.tasks.get(again.editTaskId!)).toMatchObject({ state: "done", summary: asking });
    expect(scarlet.ctx.repos.learnings.get(rule.id)).toMatchObject({ state: "suggested", error: asking });

    // Sent to another skill instead, it replaces nothing there.
    const moved = (await approve({ skillId: other.id })).json.learning;
    expect(moved).toMatchObject({ state: "saving", skillId: other.id, approvedAfter: asking });
    expect(moved.replaces).toBeUndefined();
    expect((await api<{ instruction: string }>("GET", `/tasks/${moved.editTaskId}/prompt`)).json.instruction).toContain("shown nothing in it that the rule would replace.");

    // A save an older engine left waiting on its question goes back to the editor with it when Scarlet starts.
    const left = scarlet.ctx.repos.tasks.get(moved.editTaskId!)!;
    scarlet.ctx.repos.tasks.put({ ...left, state: "waiting_for_user", question: "Keep the cold open as it is?" });
    returnRulesLeftWithQuestions(scarlet.ctx);
    expect(scarlet.ctx.repos.tasks.get(left.id)).toMatchObject({ state: "done" });
    expect(scarlet.ctx.repos.learnings.get(rule.id)).toMatchObject({ state: "suggested", error: "Keep the cold open as it is?" });
    // Another rule keeps unrelated prose, can rewrite its approved quotation, and can return an extra conflict.
    const extra = (await api<{ learning: Learning }>("POST", offer, { body: { rule: "Keep the room laughing", skill: skill.id, replaces: [quote] } })).json.learning;
    const approveExtra = () => api<{ learning: Learning }>("POST", `/projects/${project.id}/learnings/${extra.id}/approve`, { body: {} });
    const first = (await approveExtra()).json.learning;
    await api("POST", `/hosts/${host.id}/claim`, { body: { taskId: first.editTaskId } });
    await api("POST", `/tasks/${first.editTaskId}/complete`, { body: { state: "done", summary: stopped } });
    const confirmed = (await approveExtra()).json.learning;
    expect(confirmed.replaces).toEqual([quote, "Keep the cold open."]);
    await api("POST", `/hosts/${host.id}/claim`, { body: { taskId: confirmed.editTaskId } });
    for (const instructions of ["## Laughs\n\nKeep the room laughing. Always remove the sponsor.", "## Laughs\n\nAlways remove the sponsor."]) {
      const extra = await api<{ error: { code: string } }>("POST", `/projects/${project.id}/tasks/${confirmed.editTaskId}/skill-edit`, { body: { ...draft, instructions } });
      expect(extra.json.error.code).toBe("unapproved_skill_rewrite");
      expect(scarlet.ctx.repos.skills.get(skill.id)!.version).toBe(1);
    }
    const saved = await api<{ skill: Skill }>("POST", `/projects/${project.id}/tasks/${confirmed.editTaskId}/skill-edit`,
      { body: { ...draft, instructions: "## Laughs\n\nKeep the room laughing." } });
    expect(saved.json.skill.version).toBe(2);
    expect(saved.json.skill.content).toContain("Keep the room laughing.");
    await api("POST", `/tasks/${confirmed.editTaskId}/complete`, { body: { state: "done" } });

    for (const open of [asked.id, check.id]) await api("POST", `/tasks/${open}/cancel`);
  });

  it("carries on a rule's save that a quit cut short before it starts the skill's next rule", async () => {
    const skill = (await api<{ skill: Skill }>("POST", "/skills", { body: { name: "resumed-style", description: "House rules", content: "---\nname: resumed-style\ndescription: House rules\n---\n\nKeep the cold open.\n" } })).json.skill;
    for (const queued of scarlet.ctx.repos.tasks.select("project_id = ? AND state = 'queued'", [project.id])) await api("POST", `/tasks/${queued.id}/cancel`);
    const asked = (await api<{ task: Task }>("POST", `/projects/${project.id}/tasks`, { body: { agent: "claude", instruction: "Keep the breath and the laughter." } })).json.task;
    // The request's own check offers its rules.
    const check = scarlet.ctx.repos.tasks.select("kind = 'learning_check' AND json_extract(json, '$.context.checksTaskId') = ?", [asked.id])[0]!;
    await api("POST", `/hosts/${host.id}/claim`, { body: { taskId: check.id } });
    const offer = async (rule: string) => (await api<{ learning: Learning }>("POST", `/projects/${project.id}/tasks/${check.id}/learnings`, { body: { rule, skill: skill.id } })).json.learning;
    const approve = async (id: string) => (await api<{ learning: Learning }>("POST", `/projects/${project.id}/learnings/${id}/approve`, { body: {} })).json.learning;
    const first = await approve((await offer("Leave the breath before a punchline.")).id);
    const second = await approve((await offer("Never cut laughter.")).id);
    expect(second.editTaskId).toBeUndefined();
    /** The skill's edits in the order asked: how each stands, the rule it saves and the run it carries on. */
    const edits = async () => (await api<{ edits: Task[] }>("GET", `/skills/${skill.id}`)).json.edits.map(t => [t.state, t.context.learningId, t.resumeRootId ?? null]);
    const learning = (id: string) => scarlet.ctx.repos.learnings.get(id)!;

    // Scarlet quits while the first rule is being saved. The save carries on as a new attempt.
    await api("POST", `/hosts/${host.id}/claim`, { body: { taskId: first.editTaskId } });
    expect((await api("POST", `/tasks/${first.editTaskId}/complete`, { body: { state: "cancelled", interrupted: true } })).status).toBe(200);
    // The second rule still waits its turn: started now, its edit would run beside that attempt and one would overwrite the other.
    expect(await edits()).toEqual([["failed", first.id, null], ["queued", first.id, first.editTaskId]]);
    expect(learning(first.id)).toMatchObject({ state: "saving", editTaskId: first.editTaskId });
    expect(learning(first.id).error).toBeUndefined();
    expect(learning(second.id)).toMatchObject({ state: "saving" });
    expect(learning(second.id).editTaskId).toBeUndefined();

    // The attempt that carried on saves the skill. The first rule is saved, and the second one starts.
    const resumed = scarlet.ctx.repos.tasks.get(scarlet.ctx.repos.tasks.get(first.editTaskId!)!.retryTaskId!)!;
    expect((await api<{ task: Task | null }>("POST", `/hosts/${host.id}/claim`, { body: { taskId: resumed.id } })).json.task?.id).toBe(resumed.id);
    const draft = { skillId: skill.id, hostId: host.id, description: "House rules", instructions: "Keep the cold open.\n\nLeave the breath before a punchline." };
    expect((await api<{ skill: Skill }>("POST", `/projects/${project.id}/tasks/${resumed.id}/skill-edit`, { body: draft })).json.skill.version).toBe(2);
    await api("POST", `/tasks/${resumed.id}/complete`, { body: { state: "done", summary: "Added the rule." } });
    expect(learning(first.id)).toMatchObject({ state: "saved" });
    expect(await edits()).toEqual([["failed", first.id, null], ["done", first.id, first.editTaskId], ["queued", second.id, null]]);
    expect(learning(second.id)).toMatchObject({ state: "saving", editTaskId: expect.any(String) });

    // A save cut short after it saved the skill has nothing to carry on: its rule is saved.
    const next = learning(second.id).editTaskId!;
    await api("POST", `/hosts/${host.id}/claim`, { body: { taskId: next } });
    const added = { ...draft, instructions: `${draft.instructions}\n\nNever cut laughter.` };
    expect((await api<{ skill: Skill }>("POST", `/projects/${project.id}/tasks/${next}/skill-edit`, { body: added })).json.skill.version).toBe(3);
    expect((await api("POST", `/tasks/${next}/complete`, { body: { state: "cancelled", interrupted: true } })).status).toBe(200);
    expect(learning(second.id)).toMatchObject({ state: "saved" });
    expect(await edits()).toEqual([["failed", first.id, null], ["done", first.id, first.editTaskId], ["done", second.id, null]]);
    for (const open of [asked.id, check.id]) await api("POST", `/tasks/${open}/cancel`);
  });

  it("stops the skill edits waiting in a project when it goes to the trash, so they don't hold their skills", async () => {
    const skill = async (name: string) => (await api<{ skill: Skill }>("POST", "/skills", { body: { name, content: `# ${name}` } })).json.skill;
    const asked = await skill("trashed-asked"), learned = await skill("trashed-learned"), unsure = await skill("trashed-unsure");
    const home = (await api<{ project: Project }>("POST", "/projects", { body: { name: "Trashed with skill edits" } })).json.project;
    // A skill's edit runs from the project worked on last.
    await new Promise(resolve => setTimeout(resolve, 5));
    scarlet.ctx.repos.projects.touch(home.id);
    const edit = (await api<{ task: Task }>("POST", `/skills/${asked.id}/edit`, { body: { prompt: "Never cut laughter.", agent: "claude" } })).json.task;
    expect(edit).toMatchObject({ kind: "skill_edit", projectId: home.id, state: "queued" });
    // A rule approved in that project is saved from it.
    const request = (await api<{ task: Task }>("POST", `/projects/${home.id}/tasks`, { body: { agent: "claude", instruction: "Keep the breath before the punchline." } })).json.task;
    const check = scarlet.ctx.repos.tasks.select("kind = 'learning_check' AND json_extract(json, '$.context.checksTaskId') = ?", [request.id])[0]!;
    await api("POST", `/hosts/${host.id}/claim`, { body: { taskId: check.id } });
    const rule = (await api<{ learning: Learning }>("POST", `/projects/${home.id}/tasks/${check.id}/learnings`, { body: { rule: "Leave the breath before a punchline.", skill: learned.id } })).json.learning;
    const saving = (await api<{ learning: Learning }>("POST", `/projects/${home.id}/learnings/${rule.id}/approve`, { body: {} })).json.learning;
    expect(scarlet.ctx.repos.tasks.get(saving.editTaskId!)).toMatchObject({ kind: "skill_edit", projectId: home.id, state: "queued" });
    // A third edit has asked the editor a question.
    const question = (await api<{ task: Task }>("POST", `/skills/${unsure.id}/edit`, { body: { prompt: "Shorten it.", agent: "claude" } })).json.task;
    const claimed = (await api<{ task: Task }>("POST", `/hosts/${host.id}/claim`, { body: { taskId: question.id } })).json.task;
    expect((await api<{ waiting: boolean }>("POST", `/tasks/${question.id}/question`, { body: { startedAt: claimed.startedAt, text: "Which part?" } })).json.waiting).toBe(true);

    expect((await api("DELETE", `/projects/${home.id}`)).status).toBe(200);
    // No host takes a request in a trashed project. Left waiting there, each edit would hold its skill until the project came back.
    const state = (id: string) => scarlet.ctx.repos.tasks.get(id)!.state;
    expect([edit.id, saving.editTaskId!, question.id].map(state)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(scarlet.ctx.repos.learnings.get(rule.id)).toMatchObject({ state: "suggested", error: "Saving was stopped." });
    // The project's own request still waits for Restore.
    expect(state(request.id)).toBe("queued");
    // The skill can be revised again, from another project.
    const again = await api<{ task: Task }>("POST", `/skills/${asked.id}/edit`, { body: { prompt: "Never cut laughter.", agent: "claude" } });
    expect(again.status).toBe(201);
    expect(again.json.task.projectId).not.toBe(home.id);
    await api("POST", `/tasks/${again.json.task.id}/cancel`);
  });

  it("moves saved actions into distinct skills once and retires the actions endpoint", async () => {
    const { ctx } = scarlet;
    for (const id of ["act_a", "act_b"]) ctx.repos.actions.put({
      id, name: "Jump cut!", instruction: "Trim the pause.", target: "playhead", scope: "personal", ownerId: null, createdBy: null,
    });
    migrateQuickActions(ctx);
    migrateQuickActions(ctx);
    const migrated = ctx.repos.skills.select().filter(skill => skill.source?.startsWith("quick-action:"));
    expect(migrated.map(skill => skill.name).sort()).toEqual(["jump-cut", "jump-cut-2"]);
    expect(migrated.every(skill => skill.content.includes("selected moment") && skill.content.includes("Trim the pause."))).toBe(true);
    expect(ctx.repos.actions.count()).toBe(0);
    expect((await api("GET", "/actions")).status).toBe(404);
  });

  it("keeps a permanent history: approvals, undos, restores, imports from DaVinci, and a project trash", async () => {
    const p = (await api<{ project: Project }>("POST", "/projects", { body: { name: "History" } })).json.project;
    const form = new FormData();
    form.append("file", new Blob([testMp4], { type: "video/mp4" }), "take.mp4");
    let m = (await api<{ media: MediaAsset & { status: string } }>("POST", `/projects/${p.id}/media`, { form })).json.media;
    for (let i = 0; i < 100 && m.status !== "ready"; i++) {
      await sleep(200);
      m = (await api<{ media: Array<MediaAsset & { status: string }> }>("GET", `/projects/${p.id}/media`)).json.media[0]!;
    }
    const first = (
      await api<{ change: Change }>("POST", `/projects/${p.id}/changes`, {
        body: { description: "First cut", skipRender: true, autoApprove: true, ops: [{ op: "addClip", trackId: "v1", clip: { id: "take", kind: "media", mediaId: m.id, sourceIn: 0, sourceOut: 6, timelineIn: 0 } }] },
      })
    ).json.change;
    const trim = (
      await api<{ change: Change }>("POST", `/projects/${p.id}/changes`, {
        body: { description: "Trim the tail", skipRender: true, author: { type: "agent", id: "claude", name: "Claude" }, ops: [{ op: "updateClip", clipId: "take", patch: { sourceOut: 5 } }] },
      })
    ).json.change;
    await api("POST", `/changes/${trim.id}/approve`, { body: {} });
    await api("POST", `/changes/${trim.id}/unapprove`);
    const types = (await api<{ activity: ActivityEntry[] }>("GET", `/projects/${p.id}/activity`)).json.activity.map((a) => a.type);
    expect(types).toEqual(expect.arrayContaining(["media.added", "change.proposed", "change.approved", "change.undone"]));
    const undone = (await api<{ activity: ActivityEntry[] }>("GET", `/projects/${p.id}/activity?type=change.undone`)).json.activity;
    expect(undone[0]!.summary).toMatch(/undid the approval of “Trim the tail”/);

    // Round trip through DaVinci: export, trim by hand, import as a change by the importer.
    const otio = (await api<Record<string, any>>("GET", `/projects/${p.id}/versions/head/export.otio`)).json; // eslint-disable-line @typescript-eslint/no-explicit-any
    otio.tracks.children[0].children[0].source_range.duration.value -= 30; // 1 s shorter at 30 fps
    const imported = await api<{ change: Change; timeline: Timeline }>("POST", `/projects/${p.id}/import/otio`, { body: { otio } });
    expect(imported.status).toBe(201);
    expect(imported.json.change.author).toMatchObject({ type: "human", id: owner.id });
    expect(imported.json.change.fromVersion).toBe(first.appliedVersion);
    const take = imported.json.timeline.tracks[0]!.clips[0]!;
    expect(take.kind === "media" && take.sourceOut).toBeCloseTo(5, 3);
    const bad = await api<{ error: { code: string } }>("POST", `/projects/${p.id}/import/otio`, { body: { otio: { hello: "world" } } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("otio_import");

    // Restoring a version is recorded.
    await api("POST", `/projects/${p.id}/versions/${first.fromVersion}/checkout`);
    expect((await api<{ activity: ActivityEntry[] }>("GET", `/projects/${p.id}/activity?type=version.restored`)).json.activity).toHaveLength(1);

    // Delete → trash → restore; purge only after 30 days.
    expect((await api("DELETE", `/projects/${p.id}`)).status).toBe(200);
    expect((await api("GET", `/projects/${p.id}`)).status).toBe(404);
    const trash = (await api<{ projects: Array<{ id: string; purgeAt: string }> }>("GET", "/trash")).json.projects;
    expect(trash.map((t) => t.id)).toContain(p.id);
    expect(purgeTrash(scarlet.ctx)).toBe(0);
    expect((await api("POST", `/projects/${p.id}/restore`)).status).toBe(200);
    expect((await api("GET", `/projects/${p.id}`)).status).toBe(200);
    await api("DELETE", `/projects/${p.id}`);
    expect(purgeTrash(scarlet.ctx, Date.now() + 31 * 24 * 60 * 60 * 1000)).toBeGreaterThanOrEqual(1);
    expect((await api<{ projects: Array<{ id: string }> }>("GET", "/trash")).json.projects.map((t) => t.id)).not.toContain(p.id);
    expect((await api("POST", `/projects/${p.id}/restore`)).status).toBe(404);
  });

  it("exports OTIO with external media references", async () => {
    const res = await scarlet.app.request(`/api/projects/${project.id}/versions/head/export.otio?token=${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="Test_Cut-[0-9a-f]{16}\.otio"/);
    const text = await res.text();
    const otio = JSON.parse(text) as { OTIO_SCHEMA: string };
    expect(otio.OTIO_SCHEMA).toBe("Timeline.1");
    expect(text).toContain("ExternalReference.1");
    expect(text).toContain(media.path);
  });

  it("handles settings and validation errors", async () => {
    const s = await api<{ settings: { render: { handleSeconds: number; concurrency: number }; transcription: { provider: string } } }>("GET", "/settings");
    expect(s.json.settings.render.handleSeconds).toBe(1.5);
    expect(s.json.settings.transcription.provider).toBe("none");
    const patched = await api<{ settings: { render: { handleSeconds: number; concurrency: number } } }>("PATCH", "/settings", {
      body: { render: { handleSeconds: 2 } },
    });
    expect(patched.json.settings.render.handleSeconds).toBe(2);
    expect(patched.json.settings.render.concurrency).toBe(2);
    const invalid = await api<{ error: { code: string; details: unknown[] } }>("POST", "/projects", { body: { name: "" } });
    expect(invalid.status).toBe(400);
    expect(invalid.json.error.code).toBe("validation_error");
    expect(invalid.json.error.details.length).toBeGreaterThan(0);
    const badJson = await api<{ error: { code: string } }>("POST", "/projects", { body: undefined, headers: { "Content-Type": "application/json" } });
    expect(badJson.status).toBe(400);
  });
});
