import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { WsEvent, YouTubeConnectionStatus } from "@scarlet/shared";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import { HttpError } from "../errors.js";
import {
  base64Url,
  createPkcePair,
  getValidYouTubeAccessToken,
  getYouTubeStatus,
  markYouTubeNeedsReconnect,
} from "./youtubeAuth.js";

// Google is a fake fetch: every test says how it answers, and nothing leaves the machine. The loopback sign-in
// listener is real and is reached with the real fetch on 127.0.0.1, as the browser would.
const GOOGLE = "https://google.test";
const CLIENT_ID = "env-client-id-123456789.apps.googleusercontent.com";

interface Call { url: URL; method: string; form: URLSearchParams; headers: Headers }
type Reply = (call: Call) => Response | Promise<Response>;

let directory: string;
let calls: Call[];
let reply: Reply;
let logs: string[];
const opened: ScarletApp[] = [];

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const channelReply = (snippet: Record<string, unknown> = { title: "Scarlet Studio", customUrl: "@scarlet", thumbnails: { default: { url: "https://img.test/a.jpg" } } }) =>
  json(200, { items: [{ id: "UC_1", snippet }] });

function google(overrides: { token?: Reply; channels?: Reply; revoke?: Reply } = {}): Reply {
  return call => {
    if (call.url.pathname === "/token") {
      if (overrides.token) return overrides.token(call);
      return call.form.get("grant_type") === "refresh_token"
        ? json(200, { access_token: "ya29.refreshed", expires_in: 3600 })
        : json(200, { access_token: "ya29.first", refresh_token: "1//refresh-one", expires_in: 3600, scope: "s" });
    }
    if (call.url.pathname === "/youtube/v3/channels") return overrides.channels ? overrides.channels(call) : channelReply();
    if (call.url.pathname === "/revoke") return overrides.revoke ? overrides.revoke(call) : new Response(null, { status: 200 });
    return new Response("not found", { status: 404 });
  };
}

const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const call: Call = {
    url: new URL(String(input)),
    method: init.method ?? "GET",
    form: new URLSearchParams(typeof init.body === "string" ? init.body : ""),
    headers: new Headers(init.headers),
  };
  calls.push(call);
  return reply(call);
}) as typeof fetch;

function makeApp(env: NodeJS.ProcessEnv = { SCARLET_YOUTUBE_CLIENT_ID: CLIENT_ID }) {
  const scarlet = createApp({
    dataDir: mkdtempSync(join(directory, "lib-")),
    skillsSeedDir: join(directory, "empty-seed"),
    env,
    log: line => logs.push(line),
    youtube: {
      authBaseUrl: `${GOOGLE}/auth`,
      tokenUrl: `${GOOGLE}/token`,
      revokeUrl: `${GOOGLE}/revoke`,
      apiBaseUrl: `${GOOGLE}/`,
      oauthTimeoutMs: 30_000,
      fetch: fakeFetch,
    },
  });
  opened.push(scarlet);
  const token = accessToken(scarlet.ctx);
  const api = async <T = { status: YouTubeConnectionStatus }>(method: string, path: string, body?: unknown) => {
    const res = await scarlet.app.request(`/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined && { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : undefined) as T };
  };
  const events: YouTubeConnectionStatus[] = [];
  scarlet.ctx.bus.on("ws", (ev: WsEvent) => { if (ev.type === "youtube.connection.updated") events.push(ev.status); });
  return { scarlet, ctx: scarlet.ctx, api, events };
}

/** An older engine's plain token file, which the store still reads. */
function seedLegacyTokens(app: ReturnType<typeof makeApp>, tokens: Record<string, unknown>) {
  writeFileSync(app.ctx.paths.youtubeAuth, JSON.stringify({ version: 1, ...tokens }), { mode: 0o600 });
}

async function startSignIn(app: ReturnType<typeof makeApp>) {
  const start = await app.api<{ authUrl: string; status: YouTubeConnectionStatus }>("POST", "/settings/youtube/connect", {});
  expect(start.status).toBe(200);
  const authUrl = new URL(start.json.authUrl);
  return { authUrl, redirectUri: authUrl.searchParams.get("redirect_uri")!, state: authUrl.searchParams.get("state")!, status: start.json.status };
}

async function callback(redirectUri: string, query: string) {
  const res = await fetch(`${redirectUri}?${query}`);
  return { status: res.status, html: await res.text() };
}

async function connect(app: ReturnType<typeof makeApp>) {
  const { redirectUri, state } = await startSignIn(app);
  const res = await callback(redirectUri, `code=good-code&state=${encodeURIComponent(state)}`);
  expect(res.status).toBe(200);
  return res;
}

async function rejection(promise: Promise<unknown>): Promise<HttpError> {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(HttpError);
  return err as HttpError;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-youtube-auth-test-"));
  calls = [];
  logs = [];
  reply = google();
});

afterEach(async () => {
  while (opened.length) await opened.pop()!.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

it("encodes PKCE pairs as unpadded base64url with an S256 challenge", () => {
  expect(base64Url(Buffer.from([0xfb, 0xff, 0xbf]))).toBe("-_-_");
  expect(base64Url(Buffer.from([0xff]))).toBe("_w");
  const { codeVerifier, codeChallenge } = createPkcePair();
  expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(codeChallenge).toBe(createHash("sha256").update(codeVerifier).digest("base64url"));
  expect(createPkcePair().codeVerifier).not.toBe(codeVerifier);
});

it("masks short and long client ids in the status hint", async () => {
  expect(getYouTubeStatus(makeApp({ SCARLET_YOUTUBE_CLIENT_ID: "short-id" }).ctx).clientIdHint).toBe("shor…");
  expect(getYouTubeStatus(makeApp().ctx).clientIdHint).toBe("env-clie…sercontent.com");
});

it("reads an older plain token file and encrypts it on the next save", async () => {
  const app = makeApp();
  seedLegacyTokens(app, {
    accessToken: "ya29.legacy",
    connectedAt: "2026-01-02T03:04:05.000Z",
    channel: { id: "UC_old", title: "Old Channel" },
    expiresAt: Date.now() + 3_600_000,
  });
  const status = getYouTubeStatus(app.ctx);
  expect(status).toMatchObject({ state: "connected", channel: { title: "Old Channel" }, connectedAt: "2026-01-02T03:04:05.000Z" });
  expect(await getValidYouTubeAccessToken(app.ctx)).toBe("ya29.legacy");
  expect(calls).toHaveLength(0);

  const saved = await app.api("PUT", "/settings/youtube/config", { clientSecret: "secret-xyz" });
  expect(saved.json.status).toMatchObject({ state: "connected", hasCustomClientSecret: true, configSource: "env" });
  const raw = readFileSync(app.ctx.paths.youtubeAuth, "utf8");
  expect(JSON.parse(raw).v).toBe(2);
  expect(raw).not.toContain("ya29.legacy");
  expect(raw).not.toContain("secret-xyz");
  if (process.platform !== "win32") {
    expect(statSync(app.ctx.paths.youtubeAuth).mode & 0o077).toBe(0);
  }
});

it("gives an older token file without an expiry an hour and treats odd channel data as no channel", async () => {
  const app = makeApp();
  seedLegacyTokens(app, { accessToken: "ya29.no-expiry", refreshToken: 7, scope: 3, channel: "not-an-object" });
  expect(await getValidYouTubeAccessToken(app.ctx)).toBe("ya29.no-expiry");
  const status = getYouTubeStatus(app.ctx);
  expect(status.state).toBe("connected");
  expect(status.channel).toBeUndefined();
  expect(Date.parse(status.connectedAt!)).not.toBeNaN();
});

it("treats an unreadable, odd, tampered or keyless credential file as signed out", async () => {
  const app = makeApp();
  const file = app.ctx.paths.youtubeAuth;
  for (const content of ["not json", "42", "null", "   "]) {
    writeFileSync(file, content, { mode: 0o600 });
    expect(getYouTubeStatus(app.ctx).state).toBe("disconnected");
  }
  // A file loosened by hand is made owner-only again when it is read.
  writeFileSync(file, "{}");
  chmodSync(file, 0o644);
  getYouTubeStatus(app.ctx);
  if (process.platform !== "win32") {
    expect(statSync(file).mode & 0o077).toBe(0);
  }

  await connect(app);
  expect(getYouTubeStatus(app.ctx).state).toBe("connected");
  const envelope = JSON.parse(readFileSync(file, "utf8")) as { data: string };
  const tampered = Buffer.from(envelope.data, "base64");
  tampered[0] = tampered[0]! ^ 0xff;
  writeFileSync(file, JSON.stringify({ ...envelope, data: tampered.toString("base64") }), { mode: 0o600 });
  expect(getYouTubeStatus(app.ctx).state).toBe("disconnected");

  await connect(app);
  unlinkSync(app.ctx.paths.youtubeKey);
  expect(getYouTubeStatus(app.ctx).state).toBe("disconnected");
  writeFileSync(app.ctx.paths.youtubeKey, "not-a-key\n", { mode: 0o600 });
  expect(getYouTubeStatus(app.ctx).state).toBe("disconnected");
});

it("reads a custom client saved as a plain object and removes the file once every custom setting is cleared", async () => {
  const app = makeApp({});
  writeFileSync(app.ctx.paths.youtubeAuth, JSON.stringify({ customClientId: "plain-client-0123456789.apps" }), { mode: 0o600 });
  expect(getYouTubeStatus(app.ctx)).toMatchObject({ configured: true, configSource: "custom", hasCustomClientId: true, hasCustomClientSecret: false });

  const cleared = await app.api("PUT", "/settings/youtube/config", { clientId: "", clientSecret: "   " });
  expect(cleared.status).toBe(200);
  expect(cleared.json.status).toMatchObject({ configured: false, configSource: "none", state: "disconnected" });
  expect(cleared.json.status.clientIdHint).toBeUndefined();
  expect(existsSync(app.ctx.paths.youtubeAuth)).toBe(false);
  // Clearing again with nothing stored is harmless.
  expect((await app.api("PUT", "/settings/youtube/config", { clientId: "" })).json.status.configured).toBe(false);
  expect(logs).toContain("[youtube] updated OAuth client configuration");
});

it("ignores requests to other paths on the sign-in listener and keeps waiting", async () => {
  const app = makeApp();
  const { redirectUri } = await startSignIn(app);
  const res = await fetch(new URL("/favicon.ico", redirectUri));
  expect(res.status).toBe(404);
  expect(await res.text()).toBe("Not found");
  expect(getYouTubeStatus(app.ctx).state).toBe("connecting");
});

it("says plainly when the editor cancels Google sign-in or Google reports another error", async () => {
  const app = makeApp();
  let { redirectUri, state } = await startSignIn(app);
  let res = await callback(redirectUri, `error=access_denied&state=${state}`);
  expect(res.status).toBe(200);
  expect(res.html).toContain("Google sign-in was cancelled. You can close this tab and return to Scarlet.");
  expect(getYouTubeStatus(app.ctx)).toMatchObject({ state: "error", error: "Google sign-in was cancelled." });
  await expect(fetch(redirectUri)).rejects.toThrow();
  expect(calls).toHaveLength(0);

  ({ redirectUri, state } = await startSignIn(app));
  expect(getYouTubeStatus(app.ctx).error).toBeUndefined();
  res = await callback(redirectUri, `error=server_error&state=${state}`);
  expect(res.html).toContain("Google couldn’t complete sign-in. Try again.");
  expect(app.events.at(-1)).toMatchObject({ state: "error", error: "Google couldn’t complete sign-in. Try again." });
  expect(logs).toContain("[youtube] oauth callback returned error: server_error");
});

it("asks to try again when Google returns no sign-in code", async () => {
  const app = makeApp();
  const { redirectUri, state } = await startSignIn(app);
  const res = await callback(redirectUri, `state=${state}`);
  expect(res.status).toBe(400);
  expect(res.html).toContain("Missing authorization code.");
  expect(getYouTubeStatus(app.ctx)).toMatchObject({ state: "error", error: "Google didn’t return a sign-in code. Try again." });
});

it("escapes the page text and sends the env client secret when exchanging the code", async () => {
  const app = makeApp({ SCARLET_YOUTUBE_CLIENT_ID: CLIENT_ID, SCARLET_YOUTUBE_CLIENT_SECRET: "env-secret" });
  reply = google({ channels: () => channelReply({ title: "<Tom & \"Jerry\">", customUrl: "tomjerry" }) });
  const res = await connect(app);
  expect(res.html).toContain("Connected as &lt;Tom &amp; &quot;Jerry&quot;&gt;.");
  const exchange = calls.find(c => c.url.pathname === "/token")!;
  expect(exchange.form.get("grant_type")).toBe("authorization_code");
  expect(exchange.form.get("client_secret")).toBe("env-secret");
  expect(exchange.form.get("code")).toBe("good-code");
  const channelCall = calls.find(c => c.url.pathname === "/youtube/v3/channels")!;
  expect(channelCall.url.toString()).toBe(`${GOOGLE}/youtube/v3/channels?part=snippet&mine=true`);
  expect(channelCall.headers.get("authorization")).toBe("Bearer ya29.first");
  const status = getYouTubeStatus(app.ctx);
  expect(status.channel).toEqual({ id: "UC_1", title: "<Tom & \"Jerry\">", handle: "@tomjerry" });
});

it("tells the editor when Google rejects the OAuth client", async () => {
  const app = makeApp();
  reply = google({ token: () => json(401, { error: "invalid_client" }) });
  const { redirectUri, state } = await startSignIn(app);
  const res = await callback(redirectUri, `code=c&state=${state}`);
  const message = "Google rejected the OAuth Client ID or secret. Check your OAuth settings and try again.";
  expect(res.html).toContain(message);
  expect(getYouTubeStatus(app.ctx)).toMatchObject({ state: "error", error: message });
  expect(logs).toContain("[youtube] oauth token exchange failed: youtube_invalid_client");
});

it("asks to connect again when the code exchange fails in any other way", async () => {
  const app = makeApp();
  for (const token of [
    () => new Response("<html>bad gateway</html>", { status: 502 }),
    () => json(200, { token_type: "Bearer" }),
  ]) {
    reply = google({ token });
    const { redirectUri, state } = await startSignIn(app);
    await callback(redirectUri, `code=c&state=${state}`);
    expect(getYouTubeStatus(app.ctx).error).toBe("Couldn’t complete Google sign-in. Try connecting again.");
  }
  expect(logs).toContain("[youtube] oauth token exchange failed: token_exchange_failed");
});

it("keeps unexpected sign-in failures to a plain sentence", async () => {
  const app = makeApp();
  reply = google({ token: () => { throw new TypeError("fetch failed: secret-host"); } });
  const { redirectUri, state } = await startSignIn(app);
  const res = await callback(redirectUri, `code=c&state=${state}`);
  expect(res.html).toContain("Couldn’t finish connecting YouTube. Try again.");
  expect(res.html).not.toContain("secret-host");
  expect(getYouTubeStatus(app.ctx).error).toBe("Couldn’t finish connecting YouTube. Try again.");
  expect(logs).toContain("[youtube] oauth token exchange failed: unknown");
});

it("explains when the channel can't be read or the account has no channel", async () => {
  const app = makeApp();
  reply = google({ channels: () => json(403, { error: { message: "forbidden" } }) });
  let { redirectUri, state } = await startSignIn(app);
  await callback(redirectUri, `code=c&state=${state}`);
  expect(getYouTubeStatus(app.ctx).error).toBe("Signed in to Google, but couldn’t read your YouTube channel.");

  for (const channels of [() => json(200, { items: [] }), () => new Response("garbage", { status: 200 }), () => json(200, { items: [{ id: "UC_2", snippet: {} }] })]) {
    reply = google({ channels });
    ({ redirectUri, state } = await startSignIn(app));
    await callback(redirectUri, `code=c&state=${state}`);
    expect(getYouTubeStatus(app.ctx)).toMatchObject({
      state: "error",
      error: "This Google account doesn’t have a YouTube channel yet. Create one on YouTube, then connect again.",
    });
  }
  expect(existsSync(app.ctx.paths.youtubeAuth)).toBe(false);
});

it("shows the connected channel while reconnecting and keeps the refresh token Google doesn't resend", async () => {
  const app = makeApp();
  await connect(app);
  const first = getYouTubeStatus(app.ctx);

  const again = await startSignIn(app);
  expect(again.status).toMatchObject({ state: "connecting", channel: { id: "UC_1", title: "Scarlet Studio", handle: "@scarlet", thumbnailUrl: "https://img.test/a.jpg" }, connectedAt: first.connectedAt });
  // Google sends no refresh token on a repeat consent, and a lifetime too short to trust.
  reply = google({
    token: call => call.form.get("grant_type") === "refresh_token"
      ? json(200, { access_token: "ya29.after-refresh", expires_in: "soon" })
      : json(200, { access_token: "ya29.second", expires_in: 10 }),
    channels: () => channelReply({ title: "Renamed" }),
  });
  await callback(again.redirectUri, `code=c2&state=${again.state}`);
  expect(getYouTubeStatus(app.ctx).channel).toEqual({ id: "UC_1", title: "Renamed" });

  // Sixty seconds of life is inside the two-minute margin, so the first use refreshes with the kept token.
  expect(await getValidYouTubeAccessToken(app.ctx)).toBe("ya29.after-refresh");
  const refresh = calls.filter(c => c.url.pathname === "/token").at(-1)!;
  expect(refresh.form.get("refresh_token")).toBe("1//refresh-one");
  expect(refresh.form.get("client_id")).toBe(CLIENT_ID);
  expect(refresh.form.has("client_secret")).toBe(false);
  // A non-numeric lifetime counts as an hour, so the next use doesn't refresh again.
  const before = calls.length;
  expect(await getValidYouTubeAccessToken(app.ctx)).toBe("ya29.after-refresh");
  expect(calls).toHaveLength(before);
});

it("closes the waiting listener when a new sign-in starts or the engine shuts down", async () => {
  const app = makeApp();
  const first = await startSignIn(app);
  const second = await startSignIn(app);
  expect(second.redirectUri).not.toBe(first.redirectUri);
  await expect(fetch(first.redirectUri)).rejects.toThrow();
  // The first tab's answer no longer matches the sign-in that is waiting.
  expect(getYouTubeStatus(app.ctx)).toMatchObject({ state: "connecting", authUrl: second.authUrl.toString() });

  opened.splice(opened.indexOf(app.scarlet), 1);
  await app.ctx.close();
  await expect(fetch(second.redirectUri)).rejects.toThrow();
});

it("disconnects even when Google's revoke address can't be reached, revoking the access token when there is no refresh token", async () => {
  const app = makeApp();
  // Nothing to revoke: no request is made.
  expect((await app.api("POST", "/settings/youtube/disconnect", {})).json.status.state).toBe("disconnected");
  expect(calls).toHaveLength(0);

  seedLegacyTokens(app, { accessToken: "ya29.only-access", expiresAt: Date.now() + 3_600_000 });
  reply = google({ revoke: () => { throw new TypeError("fetch failed"); } });
  const res = await app.api("POST", "/settings/youtube/disconnect", {});
  expect(res.status).toBe(200);
  expect(res.json.status.state).toBe("disconnected");
  expect(calls.map(c => [c.url.pathname, c.form.get("token")])).toEqual([["/revoke", "ya29.only-access"]]);
  expect(existsSync(app.ctx.paths.youtubeAuth)).toBe(false);
});

it("asks to connect before uploading when there is no sign-in", async () => {
  const app = makeApp();
  const err = await rejection(getValidYouTubeAccessToken(app.ctx));
  expect(err).toMatchObject({ status: 401, code: "youtube_not_connected", message: "Connect your YouTube account in Settings before uploading." });
});

it("asks to reconnect without calling Google once a sign-in is marked expired", async () => {
  const app = makeApp();
  const before = app.events.length;
  markYouTubeNeedsReconnect(app.ctx);
  expect(app.events).toHaveLength(before);

  await connect(app);
  markYouTubeNeedsReconnect(app.ctx);
  expect(getYouTubeStatus(app.ctx)).toMatchObject({
    state: "error",
    needsReconnect: true,
    error: "Your YouTube sign-in expired or was revoked. Reconnect your account.",
    channel: { title: "Scarlet Studio" },
  });
  expect(app.events.at(-1)?.needsReconnect).toBe(true);
  const count = calls.length;
  const err = await rejection(getValidYouTubeAccessToken(app.ctx));
  expect(err).toMatchObject({ status: 401, code: "youtube_reconnect_required" });
  expect(err.message).toMatch(/Reconnect your account in Settings/);
  expect(calls).toHaveLength(count);

  // A forced refresh that works clears the mark.
  expect(await getValidYouTubeAccessToken(app.ctx, { forceRefresh: true })).toBe("ya29.refreshed");
  expect(getYouTubeStatus(app.ctx)).toMatchObject({ state: "connected" });
  expect(getYouTubeStatus(app.ctx).needsReconnect).toBeUndefined();
});

it("marks an expired sign-in without a refresh token as needing reconnect", async () => {
  const app = makeApp();
  seedLegacyTokens(app, { accessToken: "ya29.stale", expiresAt: Date.now() - 1000 });
  const err = await rejection(getValidYouTubeAccessToken(app.ctx));
  expect(err).toMatchObject({ status: 401, code: "youtube_reconnect_required", message: "Your YouTube sign-in expired. Reconnect your account in Settings." });
  expect(calls).toHaveLength(0);
  expect(getYouTubeStatus(app.ctx).needsReconnect).toBe(true);
  expect(app.events.at(-1)?.state).toBe("error");
});

it("can't refresh once the OAuth client id has gone from Settings", async () => {
  const app = makeApp({});
  seedLegacyTokens(app, { accessToken: "ya29.stale", refreshToken: "1//r", expiresAt: Date.now() - 1000 });
  const err = await rejection(getValidYouTubeAccessToken(app.ctx));
  expect(err).toMatchObject({ status: 401, code: "youtube_not_configured", message: "Google OAuth Client ID is missing. Check Settings and reconnect YouTube." });
  expect(calls).toHaveLength(0);
});

it("sends a custom client's secret when refreshing and stores a rotated refresh token", async () => {
  const app = makeApp({});
  await app.api("PUT", "/settings/youtube/config", { clientId: "custom-client-1234567890", clientSecret: "custom-secret" });
  await connect(app);
  reply = google({ token: () => json(200, { access_token: "ya29.rotated", refresh_token: "1//refresh-two", expires_in: 3600 }) });
  expect(await getValidYouTubeAccessToken(app.ctx, { forceRefresh: true })).toBe("ya29.rotated");
  let refresh = calls.at(-1)!;
  expect(refresh.form.get("client_id")).toBe("custom-client-1234567890");
  expect(refresh.form.get("client_secret")).toBe("custom-secret");
  expect(refresh.form.get("refresh_token")).toBe("1//refresh-one");

  await getValidYouTubeAccessToken(app.ctx, { forceRefresh: true });
  refresh = calls.at(-1)!;
  expect(refresh.form.get("refresh_token")).toBe("1//refresh-two");
  expect(logs).toContain("[youtube] refreshed access token");
  expect(logs.join("\n")).not.toMatch(/refresh-two|custom-secret|ya29\.rotated/);
});

it("shares one refresh between uploads that ask at the same time", async () => {
  const app = makeApp();
  seedLegacyTokens(app, { accessToken: "ya29.stale", refreshToken: "1//r", expiresAt: Date.now() - 1000 });
  let answer!: () => void;
  const gate = new Promise<void>(resolve => { answer = resolve; });
  reply = google({ token: async () => { await gate; return json(200, { access_token: "ya29.shared", expires_in: 3600 }); } });
  const both = Promise.all([getValidYouTubeAccessToken(app.ctx), getValidYouTubeAccessToken(app.ctx)]);
  answer();
  expect(await both).toEqual(["ya29.shared", "ya29.shared"]);
  expect(calls.filter(c => c.url.pathname === "/token")).toHaveLength(1);
  // Once settled, a later forced refresh asks Google again.
  await getValidYouTubeAccessToken(app.ctx, { forceRefresh: true });
  expect(calls.filter(c => c.url.pathname === "/token")).toHaveLength(2);
});

it("reports being offline when Google can't be reached for a refresh", async () => {
  const app = makeApp();
  seedLegacyTokens(app, { accessToken: "ya29.stale", refreshToken: "1//r", expiresAt: Date.now() - 1000 });
  reply = google({ token: () => { throw new TypeError("fetch failed"); } });
  const err = await rejection(getValidYouTubeAccessToken(app.ctx));
  expect(err).toMatchObject({ status: 503, code: "youtube_offline", message: "Couldn’t reach YouTube. Check your internet connection and try again." });
  expect(getYouTubeStatus(app.ctx).needsReconnect).toBeUndefined();
});

it("keeps the sign-in after a temporary Google error but asks to reconnect after a rejected one", async () => {
  const app = makeApp();
  seedLegacyTokens(app, { accessToken: "ya29.stale", refreshToken: "1//r", expiresAt: Date.now() - 1000 });
  reply = google({ token: () => json(503, { error: "backend_error" }) });
  let err = await rejection(getValidYouTubeAccessToken(app.ctx));
  expect(err).toMatchObject({ status: 502, code: "youtube_refresh_failed", message: "Couldn’t refresh your YouTube sign-in. Try again." });
  expect(getYouTubeStatus(app.ctx).state).toBe("connected");

  reply = google({ token: () => new Response("unauthorized", { status: 401 }) });
  err = await rejection(getValidYouTubeAccessToken(app.ctx));
  expect(err).toMatchObject({ status: 401, code: "youtube_reconnect_required" });
  expect(getYouTubeStatus(app.ctx).needsReconnect).toBe(true);
  expect(logs).toContain("[youtube] token refresh rejected: reconnect required (HTTP 401)");
});

it("asks to reconnect when Google answers a refresh with invalid_grant on an unusual status", async () => {
  const app = makeApp();
  seedLegacyTokens(app, { accessToken: "ya29.stale", refreshToken: "1//r", expiresAt: Date.now() - 1000 });
  reply = google({ token: () => json(500, { error: "invalid_grant" }) });
  const err = await rejection(getValidYouTubeAccessToken(app.ctx));
  expect(err.code).toBe("youtube_reconnect_required");
  expect(getYouTubeStatus(app.ctx).needsReconnect).toBe(true);
});
