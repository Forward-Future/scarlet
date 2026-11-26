import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Project, Timeline, Transcript } from "@scarlet/timeline";
import type { WsEvent, YouTubeChaptersResponse, YouTubeConnectionStatus, YouTubeUploadJob } from "@scarlet/shared";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import {
  buildFinalCutChapters,
  collectFinalTimelineWords,
  formatYouTubeTimestamp,
  normalizeYouTubeChapters,
} from "./youtubeKit.js";
import { getValidYouTubeAccessToken } from "./youtubeAuth.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

interface MockYouTubeState {
  tokenRequests: Array<Record<string, string>>;
  revokeTokens: string[];
  channelFetches: number;
  uploadMetadata?: Record<string, unknown>;
  uploadedChunks: Array<{ range: string | undefined; bytes: number }>;
  uploadedVideoBytes: Buffer[];
  uploadedThumbnail?: { videoId: string; contentType: string | undefined; bytes: Buffer };
  nextTokenAccess: string;
  nextRefreshAccess: string;
  failRefreshInvalidGrant: boolean;
  failUploadStatus?: { status: number; body: Record<string, unknown> };
  failThumbnailStatus?: number;
  delayChunkMs: number;
  lastChunkRanges: string[];
}

async function startMockGoogleServer(): Promise<{ baseUrl: string; state: MockYouTubeState; close: () => Promise<void> }> {
  const state: MockYouTubeState = {
    tokenRequests: [],
    revokeTokens: [],
    channelFetches: 0,
    uploadedChunks: [],
    uploadedVideoBytes: [],
    nextTokenAccess: "ya29.test-initial-access-token",
    nextRefreshAccess: "ya29.test-refreshed-access-token",
    failRefreshInvalidGrant: false,
    delayChunkMs: 0,
    lastChunkRanges: [],
  };

  let receivedSoFar = 0;
  let expectedTotal = 0;

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    // 1. OAuth token exchange & refresh
    if (req.method === "POST" && url.pathname === "/token") {
      const form = new URLSearchParams((await readBody(req)).toString("utf8"));
      const params = Object.fromEntries(form.entries());
      state.tokenRequests.push(params);
      if (params.grant_type === "authorization_code") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          access_token: state.nextTokenAccess,
          refresh_token: "1//test-refresh-token-secret",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
          token_type: "Bearer",
        }));
        return;
      }
      if (params.grant_type === "refresh_token") {
        if (state.failRefreshInvalidGrant) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          access_token: state.nextRefreshAccess,
          expires_in: 3600,
          token_type: "Bearer",
        }));
        return;
      }
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unsupported_grant_type" }));
      return;
    }

    // 2. OAuth revoke
    if (req.method === "POST" && url.pathname === "/revoke") {
      const form = new URLSearchParams((await readBody(req)).toString("utf8"));
      const t = form.get("token");
      if (t) state.revokeTokens.push(t);
      res.writeHead(200);
      res.end();
      return;
    }

    // 3. YouTube channel lookup
    if (req.method === "GET" && url.pathname === "/youtube/v3/channels") {
      state.channelFetches++;
      if (req.headers.authorization !== `Bearer ${state.nextTokenAccess}` && req.headers.authorization !== `Bearer ${state.nextRefreshAccess}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: 401, message: "Invalid Credentials" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        items: [{
          id: "UC_TEST_CHANNEL_123",
          snippet: {
            title: "Scarlet Studio Test",
            customUrl: "@scarletstudio",
            thumbnails: { default: { url: "https://example.invalid/avatar.jpg" } },
          },
        }],
      }));
      return;
    }

    // 4. Resumable upload initiation
    if (req.method === "POST" && url.pathname === "/upload/youtube/v3/videos" && url.searchParams.get("uploadType") === "resumable") {
      const body = await readBody(req);
      if (state.failUploadStatus) {
        res.writeHead(state.failUploadStatus.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(state.failUploadStatus.body));
        return;
      }
      state.uploadMetadata = JSON.parse(body.toString("utf8"));
      expectedTotal = Number(req.headers["x-upload-content-length"] ?? "0");
      receivedSoFar = 0;
      state.uploadedChunks = [];
      state.uploadedVideoBytes = [];
      state.lastChunkRanges = [];
      const addr = server.address() as AddressInfo;
      res.writeHead(200, {
        Location: `http://127.0.0.1:${addr.port}/upload/session/sess_1`,
      });
      res.end();
      return;
    }

    // 5. Resumable upload chunks
    if (req.method === "PUT" && url.pathname === "/upload/session/sess_1") {
      const range = req.headers["content-range"];
      const chunk = await readBody(req);
      if (state.delayChunkMs > 0) await sleep(state.delayChunkMs);
      state.uploadedChunks.push({ range: typeof range === "string" ? range : undefined, bytes: chunk.length });
      if (typeof range === "string") state.lastChunkRanges.push(range);
      state.uploadedVideoBytes.push(chunk);
      receivedSoFar += chunk.length;
      if (receivedSoFar < expectedTotal) {
        res.writeHead(308, { Range: `bytes=0-${receivedSoFar - 1}` });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "ytVid_ABC123" }));
      return;
    }

    // 6. Thumbnail upload
    if (req.method === "POST" && url.pathname === "/upload/youtube/v3/thumbnails/set") {
      const bytes = await readBody(req);
      if (state.failThumbnailStatus) {
        res.writeHead(state.failThumbnailStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: {
            code: state.failThumbnailStatus,
            message: "The authenticated user doesn't have permissions to upload and set custom video thumbnails.",
            errors: [{ reason: "forbidden" }],
          },
        }));
        return;
      }
      state.uploadedThumbnail = {
        videoId: url.searchParams.get("videoId") ?? "",
        contentType: req.headers["content-type"],
        bytes,
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ items: [{ default: { url: "https://i.ytimg.com/vi/ytVid_ABC123/default.jpg" } }] }));
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    state,
    close: () => new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

describe("YouTube Publishing Kit & Direct Connect", () => {
  let fixtureDir: string;
  let multiSceneMp4: string;
  let mockGoogle: Awaited<ReturnType<typeof startMockGoogleServer>>;
  const appsToClose: ScarletApp[] = [];

  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "scarlet-yt-test-"));
    multiSceneMp4 = join(fixtureDir, "multi-scene.mp4");

    // 12s video with 3 visually distinct high-contrast scenes + audio
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=duration=4:size=640x360:rate=30",
      "-f", "lavfi", "-i", "smptehdbars=duration=4:size=640x360:rate=30",
      "-f", "lavfi", "-i", "mandelbrot=size=640x360:rate=30:maxiter=40,trim=duration=4,setpts=PTS-STARTPTS",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
      "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
      "-map", "[v]", "-map", "3:a",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
      multiSceneMp4,
    ]);

    mockGoogle = await startMockGoogleServer();
  });

  afterEach(async () => {
    while (appsToClose.length) {
      await appsToClose.pop()!.ctx.close();
    }
    mockGoogle.state.tokenRequests = [];
    mockGoogle.state.revokeTokens = [];
    mockGoogle.state.channelFetches = 0;
    mockGoogle.state.failRefreshInvalidGrant = false;
    mockGoogle.state.failUploadStatus = undefined;
    mockGoogle.state.failThumbnailStatus = undefined;
    mockGoogle.state.delayChunkMs = 0;
    mockGoogle.state.uploadedThumbnail = undefined;
    mockGoogle.state.uploadMetadata = undefined;
  });

  afterAll(async () => {
    await mockGoogle?.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  function makeApp(opts: { env?: NodeJS.ProcessEnv; oauthTimeoutMs?: number; uploadChunkBytes?: number; logs?: string[] } = {}) {
    const dataDir = mkdtempSync(join(fixtureDir, "lib-"));
    const scarlet = createApp({
      dataDir,
      env: opts.env ?? { SCARLET_YOUTUBE_CLIENT_ID: "env-client-id-123456789.apps.googleusercontent.com" },
      log: line => opts.logs?.push(line),
      youtube: {
        authBaseUrl: `${mockGoogle.baseUrl}/auth`,
        tokenUrl: `${mockGoogle.baseUrl}/token`,
        revokeUrl: `${mockGoogle.baseUrl}/revoke`,
        apiBaseUrl: mockGoogle.baseUrl,
        uploadBaseUrl: mockGoogle.baseUrl,
        oauthTimeoutMs: opts.oauthTimeoutMs ?? 30_000,
        uploadChunkBytes: opts.uploadChunkBytes ?? 256 * 1024,
      },
    });
    appsToClose.push(scarlet);
    const token = accessToken(scarlet.ctx);
    const api = async <T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> => {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      let payload: BodyInit | undefined;
      if (body instanceof FormData) {
        payload = body;
      } else if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        payload = JSON.stringify(body);
      }
      const res = await scarlet.app.request(`/api${path}`, { method, headers, body: payload });
      const text = await res.text();
      return { status: res.status, json: (text ? JSON.parse(text) : undefined) as T };
    };
    return { scarlet, dataDir, api };
  }

  async function completeMockOAuth(api: ReturnType<typeof makeApp>["api"]) {
    const start = await api<{ authUrl: string; status: YouTubeConnectionStatus }>("POST", "/settings/youtube/connect", {});
    expect(start.status).toBe(200);
    const authUrl = new URL(start.json.authUrl);
    const redirectUri = authUrl.searchParams.get("redirect_uri")!;
    const stateParam = authUrl.searchParams.get("state")!;
    const callbackRes = await fetch(`${redirectUri}?code=mock-auth-code-99&state=${encodeURIComponent(stateParam)}`);
    expect(callbackRes.status).toBe(200);
    return { authUrl, redirectUri, stateParam };
  }

  async function seedEditedProject(scarlet: ScarletApp, api: ReturnType<typeof makeApp>["api"], videoPath = multiSceneMp4) {
    const pRes = await api<{ project: Project }>("POST", "/projects", {
      name: "Scarlet Demo Cut",
      settings: { width: 640, height: 360, fps: 30, aspect: "16:9", sampleRate: 48000, audioChannels: 2 },
    });
    const project = pRes.json.project;
    const imp = await api<{ media: { id: string } }>("POST", `/projects/${project.id}/media/import`, { path: videoPath });
    const mediaId = imp.json.media.id;
    for (let i = 0; i < 60; i++) {
      const m = scarlet.ctx.repos.projects.getMedia(mediaId);
      if (m && m.duration && m.duration > 0) break;
      await sleep(50);
    }
    const tlRes = await api<{ timeline: Timeline }>("GET", `/projects/${project.id}/timeline`);
    const base = tlRes.json.timeline;
    const vTrack = base.tracks.find(t => t.kind === "video")!;
    const aTrack = base.tracks.find(t => t.kind === "audio")!;

    const chg = await api("POST", `/projects/${project.id}/changes`, {
      fromVersion: base.version,
      description: "Trimmed intro and tightened middle section",
      ops: [
        { op: "addClip", trackId: vTrack.id, clip: { id: "v1", kind: "media", mediaId, timelineIn: 0, sourceIn: 0, sourceOut: 3.5, speed: 1, opacity: 1, volume: 0, audioFadeIn: 0, audioFadeOut: 0, videoFadeIn: 0, videoFadeOut: 0, effects: [], enabled: true } },
        { op: "addClip", trackId: vTrack.id, clip: { id: "v2", kind: "media", mediaId, timelineIn: 3.5, sourceIn: 5, sourceOut: 11.5, speed: 1, opacity: 1, volume: 0, audioFadeIn: 0, audioFadeOut: 0, videoFadeIn: 0, videoFadeOut: 0, effects: [], enabled: true } },
        { op: "addClip", trackId: aTrack.id, clip: { id: "a1", kind: "media", mediaId, timelineIn: 0, sourceIn: 0, sourceOut: 3.5, speed: 1, opacity: 1, volume: 1, audioFadeIn: 0, audioFadeOut: 0, videoFadeIn: 0, videoFadeOut: 0, effects: [], enabled: true } },
        { op: "addClip", trackId: aTrack.id, clip: { id: "a2", kind: "media", mediaId, timelineIn: 3.5, sourceIn: 5, sourceOut: 11.5, speed: 1, opacity: 1, volume: 1, audioFadeIn: 0, audioFadeOut: 0, videoFadeIn: 0, videoFadeOut: 0, effects: [], enabled: true } },
      ],
      autoApprove: true,
    });
    expect(chg.status).toBe(201);
    return { projectId: project.id, mediaId };
  }

  // -------------------------------------------------------------------------
  // Part 1: PKCE OAuth loopback flow, encrypted private storage, refresh & disconnect
  // -------------------------------------------------------------------------

  it("completes PKCE loopback OAuth, encrypts tokens with 0600 permissions, never leaks secrets, and auto-closes loopback", async () => {
    const logs: string[] = [];
    const { scarlet, api } = makeApp({ logs });
    const events: WsEvent[] = [];
    scarlet.ctx.bus.on("ws", ev => events.push(ev));

    // Initial state
    const init = await api<{ status: YouTubeConnectionStatus }>("GET", "/settings/youtube");
    expect(init.status).toBe(200);
    expect(init.json.status.state).toBe("disconnected");
    expect(init.json.status.configured).toBe(true);
    expect(init.json.status.configSource).toBe("env");

    // Start OAuth
    const start = await api<{ authUrl: string; status: YouTubeConnectionStatus }>("POST", "/settings/youtube/connect", {});
    expect(start.status).toBe(200);
    expect(start.json.status.state).toBe("connecting");
    const authUrl = new URL(start.json.authUrl);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
    );
    const redirectUri = authUrl.searchParams.get("redirect_uri")!;
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/youtube\/callback$/);
    const stateParam = authUrl.searchParams.get("state")!;
    const challenge = authUrl.searchParams.get("code_challenge")!;

    // Wrong CSRF state is rejected and does NOT close or connect
    const badState = await fetch(`${redirectUri}?code=evil&state=wrong-state`);
    expect(badState.status).toBe(400);
    expect((await api<{ status: YouTubeConnectionStatus }>("GET", "/settings/youtube")).json.status.state).toBe("connecting");

    // Valid callback exchanges code + PKCE verifier
    const okRes = await fetch(`${redirectUri}?code=real-auth-code&state=${encodeURIComponent(stateParam)}`);
    expect(okRes.status).toBe(200);
    expect(await okRes.text()).toContain("YouTube connected");

    // Verify PKCE S256 challenge matched the code_verifier sent to token endpoint!
    expect(mockGoogle.state.tokenRequests).toHaveLength(1);
    const tokenReq = mockGoogle.state.tokenRequests[0]!;
    expect(tokenReq.code).toBe("real-auth-code");
    const computedChallenge = createHash("sha256").update(tokenReq.code_verifier!).digest("base64url");
    expect(computedChallenge).toBe(challenge);

    // Status reflects connected channel & NEVER leaks tokens
    const statusRes = await api<{ status: YouTubeConnectionStatus }>("GET", "/settings/youtube");
    expect(statusRes.json.status.state).toBe("connected");
    expect(statusRes.json.status.channel?.title).toBe("Scarlet Studio Test");
    expect(statusRes.json.status.channel?.handle).toBe("@scarletstudio");
    const serialized = JSON.stringify(statusRes.json);
    expect(serialized).not.toContain("ya29.test-initial-access-token");
    expect(serialized).not.toContain("1//test-refresh-token-secret");
    expect(logs.join("\n")).not.toContain("ya29.test-initial-access-token");
    expect(logs.join("\n")).not.toContain("1//test-refresh-token-secret");
    expect(logs.join("\n")).not.toContain("real-auth-code");

    // Encrypted at rest with owner-only permissions
    const rawFile = readFileSync(scarlet.ctx.paths.youtubeAuth, "utf8");
    expect(rawFile).not.toContain("ya29.test-initial-access-token");
    expect(rawFile).not.toContain("1//test-refresh-token-secret");
    expect(JSON.parse(rawFile).v).toBe(2);
    if (process.platform !== "win32") {
      expect(statSync(scarlet.ctx.paths.youtubeAuth).mode & 0o077).toBe(0);
      expect(statSync(scarlet.ctx.paths.youtubeKey).mode & 0o077).toBe(0);
    }

    // Loopback server closed automatically
    await expect(fetch(redirectUri)).rejects.toThrow();

    // WebSocket emitted connection updates
    expect(events.some(e => e.type === "youtube.connection.updated" && e.status.state === "connected")).toBe(true);
  });

  it("supports custom OAuth Client ID fallback in Settings, cancellation, timeout, token refresh, and disconnect", async () => {
    const { scarlet, api } = makeApp({ env: {}, oauthTimeoutMs: 180 });

    // Without env or custom client ID, connect fails cleanly
    const unconfigured = await api<{ status: YouTubeConnectionStatus }>("GET", "/settings/youtube");
    expect(unconfigured.json.status.configured).toBe(false);
    expect(unconfigured.json.status.configSource).toBe("none");
    expect((await api("POST", "/settings/youtube/connect", {})).status).toBe(400);

    // Save custom client ID & optional secret (never echoed back!)
    const cfgRes = await api<{ status: YouTubeConnectionStatus }>("PUT", "/settings/youtube/config", {
      clientId: "custom-client-987654.apps.googleusercontent.com",
      clientSecret: "super-secret-value-xyz",
    });
    expect(cfgRes.status).toBe(200);
    expect(cfgRes.json.status.configured).toBe(true);
    expect(cfgRes.json.status.configSource).toBe("custom");
    expect(cfgRes.json.status.hasCustomClientSecret).toBe(true);
    expect(JSON.stringify(cfgRes.json)).not.toContain("super-secret-value-xyz");

    // Start + cancel closes loopback listener
    const started = await api<{ authUrl: string }>("POST", "/settings/youtube/connect", {});
    const cancelUri = new URL(started.json.authUrl).searchParams.get("redirect_uri")!;
    const cancelled = await api<{ status: YouTubeConnectionStatus }>("POST", "/settings/youtube/cancel", {});
    expect(cancelled.json.status.state).toBe("disconnected");
    await expect(fetch(cancelUri)).rejects.toThrow();

    // Timeout closes loopback listener and reports clear message
    const timedStart = await api<{ authUrl: string }>("POST", "/settings/youtube/connect", {});
    const timedUri = new URL(timedStart.json.authUrl).searchParams.get("redirect_uri")!;
    await sleep(280);
    const afterTimeout = await api<{ status: YouTubeConnectionStatus }>("GET", "/settings/youtube");
    expect(afterTimeout.json.status.state).toBe("error");
    expect(afterTimeout.json.status.error).toMatch(/timed out/i);
    await expect(fetch(timedUri)).rejects.toThrow();

    // Connect cleanly, then force refresh -> gets new access token
    await completeMockOAuth(api);
    const refreshed = await getValidYouTubeAccessToken(scarlet.ctx, { forceRefresh: true });
    expect(refreshed).toBe("ya29.test-refreshed-access-token");

    // Revoked refresh token -> sets needsReconnect with clear plain-English error
    mockGoogle.state.failRefreshInvalidGrant = true;
    await expect(getValidYouTubeAccessToken(scarlet.ctx, { forceRefresh: true })).rejects.toThrow(/expired or was revoked/i);
    const expiredStatus = await api<{ status: YouTubeConnectionStatus }>("GET", "/settings/youtube");
    expect(expiredStatus.json.status.needsReconnect).toBe(true);

    // Disconnect revokes token & clears auth while preserving custom client ID
    const disc = await api<{ status: YouTubeConnectionStatus }>("POST", "/settings/youtube/disconnect", {});
    expect(disc.json.status.state).toBe("disconnected");
    expect(disc.json.status.configured).toBe(true);
    expect(mockGoogle.state.revokeTokens).toContain("1//test-refresh-token-secret");
  });

  // -------------------------------------------------------------------------
  // Part 2: Final-cut chapter calculation & Publishing Kit
  // -------------------------------------------------------------------------

  it("computes chapter timestamps on the final edited timeline clock, accounting for cuts and clip speed", () => {
    const timeline: Timeline = {
      version: "ver_final",
      parent: null,
      projectId: "prj_1",
      name: "Main",
      background: "#000000",
      markers: [],
      tracks: [
        {
          id: "a1",
          kind: "audio",
          name: "Dialogue",
          muted: false,
          hidden: false,
          clips: [
            // Clip 1: source 2s..14s -> timeline 0s..12s (trimmed 2s off start)
            { id: "c1", kind: "media", mediaId: "med_1", timelineIn: 0, sourceIn: 2, sourceOut: 14, speed: 1, opacity: 1, volume: 1, audioFadeIn: 0, audioFadeOut: 0, videoFadeIn: 0, videoFadeOut: 0, effects: [], enabled: true },
            // Source 14s..34s was CUT OUT (20 seconds removed!)
            // Clip 2: source 34s..54s -> timeline 12s..32s
            { id: "c2", kind: "media", mediaId: "med_1", timelineIn: 12, sourceIn: 34, sourceOut: 54, speed: 1, opacity: 1, volume: 1, audioFadeIn: 0, audioFadeOut: 0, videoFadeIn: 0, videoFadeOut: 0, effects: [], enabled: true },
            // Clip 3: source 60s..84s at 2x speed -> timeline 32s..44s (12s on edited clock!)
            { id: "c3", kind: "media", mediaId: "med_1", timelineIn: 32, sourceIn: 60, sourceOut: 84, speed: 2, opacity: 1, volume: 1, audioFadeIn: 0, audioFadeOut: 0, videoFadeIn: 0, videoFadeOut: 0, effects: [], enabled: true },
          ],
        },
      ],
    };

    const transcript: Transcript = {
      id: "trn_1",
      projectId: "prj_1",
      mediaId: "med_1",
      language: "en",
      provider: "whispercpp",
      createdAt: "2026-11-26T00:00:00.000Z",
      segments: [
        {
          id: "s0", start: 0, end: 1.8, text: "False start cut out.",
          words: [{ text: "False", start: 0.2, end: 0.6 }, { text: "start.", start: 0.8, end: 1.5 }],
        },
        {
          id: "s1", start: 2.5, end: 10, text: "Welcome to Scarlet video editing.",
          words: [
            { text: "Welcome", start: 2.5, end: 3.1 },
            { text: "to", start: 3.1, end: 3.3 },
            { text: "Scarlet", start: 3.3, end: 3.9 },
            { text: "video", start: 3.9, end: 4.4 },
            { text: "editing.", start: 4.4, end: 5.0 },
          ],
        },
        {
          id: "s2", start: 18, end: 28, text: "Deleted middle tangent that must never appear.",
          words: [
            { text: "Deleted", start: 18, end: 19 },
            { text: "tangent.", start: 19, end: 20 },
          ],
        },
        {
          id: "s3", start: 35, end: 45, text: "Automatic dialogue cleanup demo.",
          words: [
            { text: "Automatic", start: 35, end: 36 },
            { text: "dialogue", start: 36, end: 37 },
            { text: "cleanup", start: 37, end: 38 },
            { text: "demo.", start: 38, end: 39 },
          ],
        },
        {
          id: "s4", start: 64, end: 72, text: "Exporting straight to YouTube Studio.",
          words: [
            { text: "Exporting", start: 64, end: 65 },
            { text: "straight", start: 65, end: 66 },
            { text: "to", start: 66, end: 66.5 },
            { text: "YouTube", start: 66.5, end: 67.5 },
            { text: "Studio.", start: 67.5, end: 68.5 },
          ],
        },
      ],
    };

    const words = collectFinalTimelineWords(timeline, new Map([["med_1", transcript]]));
    const texts = words.map(w => w.text);
    expect(texts).not.toContain("False");
    expect(texts).not.toContain("Deleted");
    // "Welcome" was at source 2.5s -> timeline 0.5s
    expect(words.find(w => w.text === "Welcome")?.start).toBeCloseTo(0.5, 2);
    // "Automatic" was at source 35s (clip2 sourceIn=34, timelineIn=12) -> timeline 13s!
    expect(words.find(w => w.text === "Automatic")?.start).toBeCloseTo(13, 2);
    // "Exporting" was at source 64s (clip3 sourceIn=60, speed=2, timelineIn=32) -> timeline 34s!
    expect(words.find(w => w.text === "Exporting")?.start).toBeCloseTo(34, 2);

    const chapters = buildFinalCutChapters(timeline, words, 44);
    expect(chapters[0]?.timestamp).toBe("0:00");
    expect(chapters.length).toBeGreaterThanOrEqual(3);
    // Every chapter must sit on the edited clock (<= 44s), NOT raw source 64s!
    for (const ch of chapters) expect(ch.time).toBeLessThan(44);
    expect(chapters.some(c => c.time === 13 && /Automatic dialogue/i.test(c.title))).toBe(true);
    expect(chapters.some(c => c.time === 34 && /Exporting straight/i.test(c.title))).toBe(true);

    // Timestamp formatting over 1 hour
    expect(formatYouTubeTimestamp(0)).toBe("0:00");
    expect(formatYouTubeTimestamp(135)).toBe("2:15");
    expect(formatYouTubeTimestamp(3852)).toBe("1:04:12");
    expect(normalizeYouTubeChapters([{ time: 18, title: "Main Topic" }], 90).map(c => `${c.timestamp} ${c.title}`))
      .toEqual(["0:00 Intro", "0:18 Main Topic"]);
  });

  it("returns final-cut chapters from GET /projects/:id/youtube/chapters without packaging suggestions", async () => {
    const { scarlet, api } = makeApp();
    const { projectId } = await seedEditedProject(scarlet, api, multiSceneMp4);

    const res = await api<YouTubeChaptersResponse>("GET", `/projects/${projectId}/youtube/chapters`);
    expect(res.status).toBe(200);
    expect(res.json.chapters[0]?.timestamp).toBe("0:00");
    expect(res.json.chaptersText).toContain("0:00");
    expect(res.json.duration).toBeCloseTo(10, 1);
    expect(res.json).not.toHaveProperty("titleOptions");
    expect(res.json).not.toHaveProperty("tags");
    expect(res.json).not.toHaveProperty("thumbnails");
  });

  // -------------------------------------------------------------------------
  // Part 3: Direct Upload (resumable chunks, render reuse, errors, cancel)
  // -------------------------------------------------------------------------

  it("renders, uploads via resumable chunks, and reuses the exact delivery render on repeat publish", async () => {
    // Use a 256 KiB chunk size so our real rendered video spans multiple chunks cleanly.
    const { scarlet, api } = makeApp({ uploadChunkBytes: 256 * 1024 });
    await completeMockOAuth(api);
    const { projectId } = await seedEditedProject(scarlet, api);

    const chapters = (await api<YouTubeChaptersResponse>("GET", `/projects/${projectId}/youtube/chapters`)).json;

    // 1. First publish renders & uploads
    const pub1 = await api<{ upload: YouTubeUploadJob }>("POST", `/projects/${projectId}/youtube/publish`, {
      title: "My Finished Cut",
      description: chapters.chaptersText,
      visibility: "private",
    });
    expect(pub1.status).toBe(201);
    const uploadId = pub1.json.upload.id;

    let finalJob = pub1.json.upload;
    for (let i = 0; i < 120; i++) {
      finalJob = (await api<{ upload: YouTubeUploadJob }>("GET", `/youtube/uploads/${uploadId}`)).json.upload;
      if (finalJob.phase === "done" || finalJob.phase === "failed") break;
      await sleep(100);
    }

    expect(finalJob.phase).toBe("done");
    expect(finalJob.videoId).toBe("ytVid_ABC123");
    expect(finalJob.studioUrl).toBe("https://studio.youtube.com/video/ytVid_ABC123/edit");
    expect(finalJob.visibility).toBe("private");
    expect(mockGoogle.state.uploadMetadata).toMatchObject({
      snippet: { title: "My Finished Cut", description: chapters.chaptersText },
      status: { privacyStatus: "private" },
    });
    expect((mockGoogle.state.uploadMetadata as { snippet?: Record<string, unknown> })?.snippet?.tags).toBeUndefined();
    expect(mockGoogle.state.uploadedChunks.length).toBeGreaterThanOrEqual(1);
    const totalUploaded = Buffer.concat(mockGoogle.state.uploadedVideoBytes).length;
    expect(totalUploaded).toBe(finalJob.bytesTotal);
    expect(totalUploaded).toBeGreaterThan(10_000);
    expect(mockGoogle.state.uploadedThumbnail).toBeUndefined();

    // 2. Second publish on the exact same timeline head reuses the already-rendered delivery export!
    const pub2 = await api<{ upload: YouTubeUploadJob }>("POST", `/projects/${projectId}/youtube/publish`, {
      title: "My Finished Cut (Unlisted)",
      description: "Reusing exact render",
      visibility: "unlisted",
    });
    expect(pub2.status).toBe(201);
    expect(pub2.json.upload.reusedRender).toBe(true);
    let final2 = pub2.json.upload;
    for (let i = 0; i < 60; i++) {
      final2 = (await api<{ upload: YouTubeUploadJob }>("GET", `/youtube/uploads/${final2.id}`)).json.upload;
      if (final2.phase === "done" || final2.phase === "failed") break;
      await sleep(50);
    }
    expect(final2.phase).toBe("done");
    expect(final2.reusedRender).toBe(true);
  });

  it("handles quota exceeded, revoked auth, and upload cancellation gracefully", async () => {
    const { scarlet, api } = makeApp({ uploadChunkBytes: 256 * 1024 });
    await completeMockOAuth(api);
    const { projectId } = await seedEditedProject(scarlet, api);

    // 1. Quota exceeded -> clear plain-English error
    mockGoogle.state.failUploadStatus = {
      status: 403,
      body: { error: { code: 403, message: "The request cannot be completed because you have exceeded your quota.", errors: [{ reason: "quotaExceeded" }] } },
    };
    const pubQuota = await api<{ upload: YouTubeUploadJob }>("POST", `/projects/${projectId}/youtube/publish`, {
      title: "Quota Test",
      description: "",
      visibility: "private",
    });
    let jobQuota = pubQuota.json.upload;
    for (let i = 0; i < 120; i++) {
      jobQuota = (await api<{ upload: YouTubeUploadJob }>("GET", `/youtube/uploads/${jobQuota.id}`)).json.upload;
      if (jobQuota.phase === "failed" || jobQuota.phase === "done") break;
      await sleep(100);
    }
    expect(jobQuota.phase).toBe("failed");
    expect(jobQuota.errorCode).toBe("youtube_quota_exceeded");
    expect(jobQuota.error).toMatch(/daily upload limit/i);

    // 2. Cancellation mid-upload
    mockGoogle.state.failUploadStatus = undefined;
    mockGoogle.state.delayChunkMs = 500;
    const pubCancel = await api<{ upload: YouTubeUploadJob }>("POST", `/projects/${projectId}/youtube/publish`, {
      title: "Cancel Test",
      description: "",
      visibility: "private",
    });
    await sleep(60);
    const cancelled = await api<{ upload: YouTubeUploadJob }>("POST", `/youtube/uploads/${pubCancel.json.upload.id}/cancel`, {});
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.upload.phase).toBe("cancelled");
    mockGoogle.state.delayChunkMs = 0;

    // 3. Revoked auth (401 + refresh fails with invalid_grant) -> reconnect required
    mockGoogle.state.failUploadStatus = { status: 401, body: { error: { code: 401, message: "Invalid Credentials" } } };
    mockGoogle.state.failRefreshInvalidGrant = true;
    const pubRevoked = await api<{ upload: YouTubeUploadJob }>("POST", `/projects/${projectId}/youtube/publish`, {
      title: "Revoked Auth Test",
      description: "",
      visibility: "private",
    });
    let jobRevoked = pubRevoked.json.upload;
    for (let i = 0; i < 60; i++) {
      jobRevoked = (await api<{ upload: YouTubeUploadJob }>("GET", `/youtube/uploads/${jobRevoked.id}`)).json.upload;
      if (jobRevoked.phase === "failed" || jobRevoked.phase === "done") break;
      await sleep(50);
    }
    expect(jobRevoked.phase).toBe("failed");
    expect(jobRevoked.errorCode).toBe("youtube_reconnect_required");
    expect(jobRevoked.error).toMatch(/Reconnect your account/i);
    const statusAfter = await api<{ status: YouTubeConnectionStatus }>("GET", "/settings/youtube");
    expect(statusAfter.json.status.needsReconnect).toBe(true);
  });
});
