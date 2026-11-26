/**
 * Local desktop Google OAuth 2.0 (PKCE) and private token storage for YouTube Data API v3.
 *
 * Security invariants:
 * - Tokens and optional user-supplied client secrets are encrypted at rest with AES-256-GCM
 *   using a per-library symmetric key, and both files are written atomically with owner-only
 *   permissions (`0o600` on POSIX, owner-only DACL via `restrictWindowsAccess` on Windows).
 * - OAuth tokens, refresh tokens, client secrets, authorization codes, and PKCE verifiers
 *   NEVER appear in logs, telemetry, error messages, or HTTP responses to the frontend.
 * - The temporary loopback callback server binds strictly to `127.0.0.1` on an ephemeral port,
 *   verifies the CSRF `state` parameter in constant time, and closes automatically on
 *   completion, cancellation, timeout, or engine shutdown.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { YouTubeChannel, YouTubeConfigRequest, YouTubeConnectionStatus } from "@scarlet/shared";
import type { Ctx } from "../context.js";
import { badRequest, HttpError } from "../errors.js";
import { restrictWindowsAccess } from "../privateStorage.js";

export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
] as const;

const DEFAULT_AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const DEFAULT_API_BASE = "https://www.googleapis.com";
const DEFAULT_OAUTH_TIMEOUT_MS = 5 * 60_000;
const REFRESH_LEEWAY_MS = 2 * 60_000;

interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
  connectedAt: string;
  channel?: YouTubeChannel;
  needsReconnect?: boolean;
}

interface StoredYouTubeAuth {
  customClientId?: string;
  customClientSecret?: string;
  tokens?: StoredTokens;
}

interface EncryptedEnvelope {
  v: 2;
  iv: string;
  tag: string;
  data: string;
}

interface PendingOAuthSession {
  server: Server;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  authUrl: string;
  clientId: string;
  clientSecret?: string;
  timer: ReturnType<typeof setTimeout>;
  closed: boolean;
}

interface ContextState {
  pending?: PendingOAuthSession;
  lastError?: string;
  refreshing?: Promise<string>;
  shutdownBound?: boolean;
}

const contextStates = new WeakMap<Ctx, ContextState>();

function stateFor(ctx: Ctx): ContextState {
  let state = contextStates.get(ctx);
  if (!state) {
    state = {};
    contextStates.set(ctx, state);
  }
  if (!state.shutdownBound) {
    state.shutdownBound = true;
    ctx.shutdown.addEventListener("abort", () => {
      closePendingSession(state!);
    }, { once: true });
  }
  return state;
}

// ---------------------------------------------------------------------------
// Private owner-only encrypted file storage
// ---------------------------------------------------------------------------

function protectPrivateFile(file: string, fd: number) {
  const stat = fstatSync(fd);
  if (!stat.isFile()) throw new Error("Private credential store must be a regular file.");
  if (process.platform !== "win32") {
    if (stat.mode & 0o077) fchmodSync(fd, 0o600);
    return;
  }
  restrictWindowsAccess(file, "File");
}

function writePrivateFile(file: string, content: string): void {
  const tmp = `${file}.${randomUUID()}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try {
      protectPrivateFile(tmp, fd);
      writeFileSync(fd, content, "utf8");
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } finally {
    if (existsSync(tmp)) {
      try { unlinkSync(tmp); } catch { /* ignore cleanup error */ }
    }
  }
}

function readPrivateFile(file: string): string | null {
  if (!existsSync(file)) return null;
  if (!lstatSync(file).isFile()) throw new Error("Invalid private credential file.");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    protectPrivateFile(file, fd);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function ensureKey(ctx: Ctx): Buffer {
  const existing = readPrivateFile(ctx.paths.youtubeKey)?.trim();
  if (existing && /^[a-f0-9]{64}$/i.test(existing)) {
    return Buffer.from(existing, "hex");
  }
  const key = randomBytes(32);
  writePrivateFile(ctx.paths.youtubeKey, key.toString("hex") + "\n");
  return key;
}

function encryptPayload(ctx: Ctx, payload: StoredYouTubeAuth): string {
  const key = ensureKey(ctx);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope: EncryptedEnvelope = {
    v: 2,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
  return JSON.stringify(envelope) + "\n";
}

function readStore(ctx: Ctx): StoredYouTubeAuth {
  const raw = readPrivateFile(ctx.paths.youtubeAuth);
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const obj = parsed as Record<string, unknown>;
  if (obj.v === 2 && typeof obj.iv === "string" && typeof obj.tag === "string" && typeof obj.data === "string") {
    const keyText = readPrivateFile(ctx.paths.youtubeKey)?.trim();
    if (!keyText || !/^[a-f0-9]{64}$/i.test(keyText)) return {};
    try {
      const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyText, "hex"), Buffer.from(obj.iv, "base64"));
      decipher.setAuthTag(Buffer.from(obj.tag, "base64"));
      const decrypted = Buffer.concat([decipher.update(Buffer.from(obj.data, "base64")), decipher.final()]).toString("utf8");
      const data = JSON.parse(decrypted);
      return data && typeof data === "object" ? (data as StoredYouTubeAuth) : {};
    } catch {
      return {};
    }
  }
  // Support legacy/fixture v1 plain object shape inside private storage.
  if (obj.version === 1 && typeof obj.accessToken === "string") {
    return {
      tokens: {
        accessToken: obj.accessToken,
        refreshToken: typeof obj.refreshToken === "string" ? obj.refreshToken : undefined,
        expiresAt: typeof obj.expiresAt === "number" ? obj.expiresAt : Date.now() + 3600_000,
        scope: typeof obj.scope === "string" ? obj.scope : undefined,
        connectedAt: typeof obj.connectedAt === "string" ? obj.connectedAt : new Date().toISOString(),
        channel: obj.channel && typeof obj.channel === "object" ? (obj.channel as YouTubeChannel) : undefined,
      },
    };
  }
  return obj as StoredYouTubeAuth;
}

function writeStore(ctx: Ctx, store: StoredYouTubeAuth): void {
  const empty = !store.customClientId && !store.customClientSecret && !store.tokens;
  if (empty) {
    if (existsSync(ctx.paths.youtubeAuth)) {
      try { unlinkSync(ctx.paths.youtubeAuth); } catch { /* ignore */ }
    }
    return;
  }
  writePrivateFile(ctx.paths.youtubeAuth, encryptPayload(ctx, store));
}

// ---------------------------------------------------------------------------
// OAuth helpers & client resolution
// ---------------------------------------------------------------------------

export function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

function maskClientId(id: string): string {
  const clean = id.trim();
  if (clean.length <= 14) return `${clean.slice(0, 4)}…`;
  return `${clean.slice(0, 8)}…${clean.slice(-14)}`;
}

function resolveClientConfig(ctx: Ctx, store = readStore(ctx)): {
  clientId?: string;
  clientSecret?: string;
  source: "env" | "custom" | "none";
} {
  if (ctx.env.youtubeClientId) {
    return {
      clientId: ctx.env.youtubeClientId,
      clientSecret: ctx.env.youtubeClientSecret,
      source: "env",
    };
  }
  if (store.customClientId) {
    return {
      clientId: store.customClientId,
      clientSecret: store.customClientSecret,
      source: "custom",
    };
  }
  return { source: "none" };
}

function fetchImpl(ctx: Ctx): typeof fetch {
  return ctx.options.youtube?.fetch ?? globalThis.fetch;
}

function publishStatus(ctx: Ctx): YouTubeConnectionStatus {
  const status = getYouTubeStatus(ctx);
  ctx.bus.publish({ type: "youtube.connection.updated", status });
  return status;
}

function closePendingSession(state: ContextState, opts: { forceSockets?: boolean } = { forceSockets: true }): Server | undefined {
  const pending = state.pending;
  if (!pending) return undefined;
  state.pending = undefined;
  clearTimeout(pending.timer);
  if (!pending.closed) {
    pending.closed = true;
    try { pending.server.close(); } catch { /* ignore */ }
    if (opts.forceSockets !== false) {
      try { pending.server.closeAllConnections?.(); } catch { /* ignore */ }
    }
  }
  return pending.server;
}

function finishCallbackResponse(res: ServerResponse, statusCode: number, html: string, server?: Server): void {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "close",
  });
  res.end(html, () => {
    try { server?.closeAllConnections?.(); } catch { /* ignore */ }
  });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function callbackHtml(title: string, body: string, ok: boolean): string {
  const dot = ok ? "#7ed4b3" : "#ffa09c";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)} — Scarlet</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #101010; color: #f1f1f1; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  .card { max-width: 420px; padding: 24px 28px; border-radius: 12px; background: #181818; border: 1px solid #333; }
  .row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .dot { width: 9px; height: 9px; border-radius: 999px; background: ${dot}; flex: none; }
  h1 { margin: 0; font-size: 16px; font-weight: 600; }
  p { margin: 0; color: #b2b2b2; font-size: 13px; }
</style>
</head>
<body>
  <div class="card">
    <div class="row"><span class="dot"></span><h1>${escapeHtml(title)}</h1></div>
    <p>${escapeHtml(body)}</p>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getYouTubeStatus(ctx: Ctx): YouTubeConnectionStatus {
  const store = readStore(ctx);
  const state = stateFor(ctx);
  const cfg = resolveClientConfig(ctx, store);
  const base = {
    configured: !!cfg.clientId,
    configSource: cfg.source,
    ...(cfg.clientId && { clientIdHint: maskClientId(cfg.clientId) }),
    hasCustomClientId: !!store.customClientId,
    hasCustomClientSecret: !!store.customClientSecret,
  };

  if (state.pending && !state.pending.closed) {
    return {
      ...base,
      state: "connecting",
      authUrl: state.pending.authUrl,
      ...(store.tokens?.channel && { channel: store.tokens.channel, connectedAt: store.tokens.connectedAt }),
    };
  }

  if (store.tokens?.accessToken) {
    return {
      ...base,
      state: store.tokens.needsReconnect ? "error" : "connected",
      channel: store.tokens.channel,
      connectedAt: store.tokens.connectedAt,
      ...(store.tokens.needsReconnect && {
        needsReconnect: true,
        error: "Your YouTube sign-in expired or was revoked. Reconnect your account.",
      }),
    };
  }

  if (state.lastError) {
    return {
      ...base,
      state: "error",
      error: state.lastError,
    };
  }

  return {
    ...base,
    state: "disconnected",
  };
}

export function updateYouTubeConfig(ctx: Ctx, patch: YouTubeConfigRequest): YouTubeConnectionStatus {
  const store = readStore(ctx);
  if (patch.clientId !== undefined) {
    const trimmed = patch.clientId?.trim() || "";
    if (!trimmed) delete store.customClientId;
    else store.customClientId = trimmed;
  }
  if (patch.clientSecret !== undefined) {
    const trimmed = patch.clientSecret?.trim() || "";
    if (!trimmed) delete store.customClientSecret;
    else store.customClientSecret = trimmed;
  }
  writeStore(ctx, store);
  stateFor(ctx).lastError = undefined;
  ctx.log("[youtube] updated OAuth client configuration");
  return publishStatus(ctx);
}

export async function startYouTubeConnect(ctx: Ctx): Promise<{ authUrl: string; status: YouTubeConnectionStatus }> {
  const store = readStore(ctx);
  const cfg = resolveClientConfig(ctx, store);
  if (!cfg.clientId) {
    throw badRequest("youtube_not_configured", "Add a Google OAuth Client ID in Settings before connecting YouTube.");
  }

  const state = stateFor(ctx);
  closePendingSession(state);
  state.lastError = undefined;

  const { codeVerifier, codeChallenge } = createPkcePair();
  const oauthState = randomBytes(24).toString("hex");
  const server = createServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo | null;
  if (!addr || typeof addr.port !== "number") {
    server.close();
    throw new HttpError(500, "youtube_loopback_failed", "Couldn’t start the local sign-in listener.");
  }

  const redirectUri = `http://127.0.0.1:${addr.port}/oauth/youtube/callback`;
  const authBase = ctx.options.youtube?.authBaseUrl ?? DEFAULT_AUTH_BASE;
  const auth = new URL(authBase);
  auth.searchParams.set("client_id", cfg.clientId);
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", YOUTUBE_SCOPES.join(" "));
  auth.searchParams.set("state", oauthState);
  auth.searchParams.set("code_challenge", codeChallenge);
  auth.searchParams.set("code_challenge_method", "S256");
  auth.searchParams.set("access_type", "offline");
  auth.searchParams.set("prompt", "consent");
  const authUrl = auth.toString();

  const timeoutMs = ctx.options.youtube?.oauthTimeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS;
  const timer = setTimeout(() => {
    if (state.pending?.server === server) {
      closePendingSession(state);
      state.lastError = "Google sign-in timed out. Try connecting again.";
      ctx.log("[youtube] oauth timed out");
      publishStatus(ctx);
    }
  }, timeoutMs);
  timer.unref();

  const session: PendingOAuthSession = {
    server,
    state: oauthState,
    codeVerifier,
    redirectUri,
    authUrl,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    timer,
    closed: false,
  };
  state.pending = session;

  server.on("request", (req, res) => {
    void handleOAuthCallback(ctx, state, session, req, res);
  });

  ctx.log("[youtube] oauth sign-in started");
  const status = publishStatus(ctx);
  return { authUrl, status };
}

async function handleOAuthCallback(
  ctx: Ctx,
  state: ContextState,
  session: PendingOAuthSession,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/oauth/youtube/callback") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const returnedState = url.searchParams.get("state") ?? "";
  const expectedBuf = Buffer.from(session.state);
  const actualBuf = Buffer.from(returnedState);
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(callbackHtml("Sign-in didn’t match", "This browser tab didn’t match the active sign-in request. Return to Scarlet and try again.", false));
    ctx.log("[youtube] oauth callback rejected: state mismatch");
    return;
  }

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    const message = oauthError === "access_denied"
      ? "Google sign-in was cancelled."
      : "Google couldn’t complete sign-in. Try again.";
    state.lastError = message;
    const srv = closePendingSession(state, { forceSockets: false });
    ctx.log(`[youtube] oauth callback returned error: ${oauthError}`);
    publishStatus(ctx);
    finishCallbackResponse(res, 200, callbackHtml("Couldn’t connect YouTube", `${message} You can close this tab and return to Scarlet.`, false), srv);
    return;
  }

  const code = url.searchParams.get("code");
  if (!code) {
    state.lastError = "Google didn’t return a sign-in code. Try again.";
    const srv = closePendingSession(state, { forceSockets: false });
    ctx.log("[youtube] oauth callback missing authorization code");
    publishStatus(ctx);
    finishCallbackResponse(res, 400, callbackHtml("Couldn’t connect YouTube", "Missing authorization code. You can close this tab and return to Scarlet.", false), srv);
    return;
  }

  try {
    const tokenRes = await exchangeCodeForTokens(ctx, session, code);
    const channel = await fetchChannelInfo(ctx, tokenRes.accessToken);
    const current = readStore(ctx);
    current.tokens = {
      accessToken: tokenRes.accessToken,
      refreshToken: tokenRes.refreshToken ?? current.tokens?.refreshToken,
      expiresAt: Date.now() + Math.max(60, tokenRes.expiresIn) * 1000,
      scope: tokenRes.scope,
      connectedAt: new Date().toISOString(),
      channel,
      needsReconnect: false,
    };
    writeStore(ctx, current);
    state.lastError = undefined;
    const srv = closePendingSession(state, { forceSockets: false });
    ctx.log("[youtube] connected YouTube channel");
    publishStatus(ctx);
    finishCallbackResponse(
      res,
      200,
      callbackHtml(
        "YouTube connected",
        `Connected${channel.title ? ` as ${channel.title}` : ""}. You can close this tab and return to Scarlet.`,
        true,
      ),
      srv,
    );
  } catch (err) {
    const message = err instanceof HttpError ? err.message : "Couldn’t finish connecting YouTube. Try again.";
    state.lastError = message;
    const srv = closePendingSession(state, { forceSockets: false });
    ctx.log(`[youtube] oauth token exchange failed: ${err instanceof HttpError ? err.code : "unknown"}`);
    publishStatus(ctx);
    finishCallbackResponse(res, 200, callbackHtml("Couldn’t connect YouTube", `${message} You can close this tab and return to Scarlet.`, false), srv);
  }
}

async function exchangeCodeForTokens(
  ctx: Ctx,
  session: PendingOAuthSession,
  code: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number; scope?: string }> {
  const tokenUrl = ctx.options.youtube?.tokenUrl ?? DEFAULT_TOKEN_URL;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: session.clientId,
    redirect_uri: session.redirectUri,
    code_verifier: session.codeVerifier,
  });
  if (session.clientSecret) body.set("client_secret", session.clientSecret);

  const res = await fetchImpl(ctx)(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.any([AbortSignal.timeout(20_000), ctx.shutdown]),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof json.access_token !== "string") {
    const errCode = typeof json.error === "string" ? json.error : "token_exchange_failed";
    if (errCode === "invalid_client") {
      throw new HttpError(400, "youtube_invalid_client", "Google rejected the OAuth Client ID or secret. Check your OAuth settings and try again.");
    }
    throw new HttpError(502, errCode, "Couldn’t complete Google sign-in. Try connecting again.");
  }
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
    expiresIn: typeof json.expires_in === "number" && Number.isFinite(json.expires_in) ? json.expires_in : 3600,
    scope: typeof json.scope === "string" ? json.scope : undefined,
  };
}

async function fetchChannelInfo(ctx: Ctx, accessToken: string): Promise<YouTubeChannel> {
  const apiBase = (ctx.options.youtube?.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  const res = await fetchImpl(ctx)(`${apiBase}/youtube/v3/channels?part=snippet&mine=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.any([AbortSignal.timeout(15_000), ctx.shutdown]),
  });
  if (!res.ok) {
    throw new HttpError(502, "youtube_channel_lookup_failed", "Signed in to Google, but couldn’t read your YouTube channel.");
  }
  const json = (await res.json().catch(() => ({}))) as {
    items?: Array<{
      id?: string;
      snippet?: {
        title?: string;
        customUrl?: string;
        thumbnails?: { default?: { url?: string }; medium?: { url?: string } };
      };
    }>;
  };
  const item = json.items?.[0];
  if (!item?.id || !item.snippet?.title) {
    throw new HttpError(400, "youtube_no_channel", "This Google account doesn’t have a YouTube channel yet. Create one on YouTube, then connect again.");
  }
  const handle = item.snippet.customUrl?.trim();
  return {
    id: item.id,
    title: item.snippet.title,
    ...(handle && { handle: handle.startsWith("@") ? handle : `@${handle}` }),
    ...(item.snippet.thumbnails?.default?.url && { thumbnailUrl: item.snippet.thumbnails.default.url }),
  };
}

export function cancelYouTubeConnect(ctx: Ctx): YouTubeConnectionStatus {
  const state = stateFor(ctx);
  closePendingSession(state);
  state.lastError = undefined;
  ctx.log("[youtube] oauth sign-in cancelled");
  return publishStatus(ctx);
}

export async function disconnectYouTube(ctx: Ctx): Promise<YouTubeConnectionStatus> {
  const state = stateFor(ctx);
  closePendingSession(state);
  state.lastError = undefined;
  const store = readStore(ctx);
  const revokeToken = store.tokens?.refreshToken ?? store.tokens?.accessToken;
  delete store.tokens;
  writeStore(ctx, store);
  ctx.log("[youtube] disconnected YouTube account");

  if (revokeToken) {
    const revokeUrl = ctx.options.youtube?.revokeUrl ?? DEFAULT_REVOKE_URL;
    await fetchImpl(ctx)(revokeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: revokeToken }).toString(),
      signal: AbortSignal.any([AbortSignal.timeout(4000), ctx.shutdown]),
    }).catch(() => undefined);
  }
  return publishStatus(ctx);
}

/**
 * Returns a valid OAuth access token for YouTube API calls, automatically refreshing it when
 * expired or close to expiry. Never logs or returns refresh tokens.
 */
export async function getValidYouTubeAccessToken(ctx: Ctx, opts: { forceRefresh?: boolean } = {}): Promise<string> {
  const store = readStore(ctx);
  const tokens = store.tokens;
  if (!tokens?.accessToken) {
    throw new HttpError(401, "youtube_not_connected", "Connect your YouTube account in Settings before uploading.");
  }
  if (tokens.needsReconnect && !opts.forceRefresh) {
    throw new HttpError(401, "youtube_reconnect_required", "Your YouTube sign-in expired or was revoked. Reconnect your account in Settings.");
  }
  if (!opts.forceRefresh && tokens.expiresAt > Date.now() + REFRESH_LEEWAY_MS) {
    return tokens.accessToken;
  }

  const state = stateFor(ctx);
  if (state.refreshing) return state.refreshing;

  const run = (async (): Promise<string> => {
    const latest = readStore(ctx);
    const cur = latest.tokens;
    if (!cur?.refreshToken) {
      if (cur) {
        cur.needsReconnect = true;
        writeStore(ctx, latest);
        publishStatus(ctx);
      }
      throw new HttpError(401, "youtube_reconnect_required", "Your YouTube sign-in expired. Reconnect your account in Settings.");
    }
    const cfg = resolveClientConfig(ctx, latest);
    if (!cfg.clientId) {
      throw new HttpError(401, "youtube_not_configured", "Google OAuth Client ID is missing. Check Settings and reconnect YouTube.");
    }
    const tokenUrl = ctx.options.youtube?.tokenUrl ?? DEFAULT_TOKEN_URL;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: cur.refreshToken,
      client_id: cfg.clientId,
    });
    if (cfg.clientSecret) body.set("client_secret", cfg.clientSecret);

    let res: Response;
    try {
      res = await fetchImpl(ctx)(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.any([AbortSignal.timeout(15_000), ctx.shutdown]),
      });
    } catch {
      throw new HttpError(503, "youtube_offline", "Couldn’t reach YouTube. Check your internet connection and try again.");
    }

    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof json.access_token !== "string") {
      const errCode = typeof json.error === "string" ? json.error : "";
      if (res.status === 400 || res.status === 401 || errCode === "invalid_grant") {
        cur.needsReconnect = true;
        writeStore(ctx, latest);
        publishStatus(ctx);
        ctx.log("[youtube] token refresh rejected: reconnect required");
        throw new HttpError(401, "youtube_reconnect_required", "Your YouTube sign-in expired or was revoked. Reconnect your account in Settings.");
      }
      throw new HttpError(502, "youtube_refresh_failed", "Couldn’t refresh your YouTube sign-in. Try again.");
    }

    const expiresIn = typeof json.expires_in === "number" && Number.isFinite(json.expires_in) ? json.expires_in : 3600;
    cur.accessToken = json.access_token;
    if (typeof json.refresh_token === "string" && json.refresh_token) cur.refreshToken = json.refresh_token;
    cur.expiresAt = Date.now() + Math.max(60, expiresIn) * 1000;
    cur.needsReconnect = false;
    writeStore(ctx, latest);
    ctx.log("[youtube] refreshed access token");
    publishStatus(ctx);
    return cur.accessToken;
  })().finally(() => {
    if (state.refreshing === run) state.refreshing = undefined;
  });

  state.refreshing = run;
  return run;
}

/** Mark the stored YouTube auth as requiring reconnect after a revoked/401 API response. */
export function markYouTubeNeedsReconnect(ctx: Ctx): void {
  const store = readStore(ctx);
  if (!store.tokens) return;
  store.tokens.needsReconnect = true;
  writeStore(ctx, store);
  publishStatus(ctx);
}
