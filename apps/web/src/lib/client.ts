import { ScarletClient, ScarletApiError } from "@scarlet/shared";
import type { ScarletApi } from "./api";
import { MockClient } from "./mock/MockClient";
import { isDesktop, markDesktop } from "./desktop";
import { appLog, logPath } from "./appLog";

export const IS_DESKTOP = isDesktop();
export const IS_MOCK = import.meta.env.DEV && import.meta.env.MODE === "desktop-demo" && IS_DESKTOP;
export let serverUrl = window.location.origin;

let mockInstance: MockClient | null = null;
export function mockClient(): MockClient | null {
  return mockInstance;
}

/** A read this slow held something on screen back. */
const SLOW_CALL_MS = 1000;

/**
 * What the editor reads when the window can't reach the engine, as while it restarts or Scarlet quits. The webview's
 * own words for that ("Load failed", "Failed to fetch") name no cause, and an engine shutting down answers with none.
 */
export const ENGINE_UNREACHABLE = "Scarlet can’t reach its engine right now.";

/** A request that never got an answer, in the words each webview (and Node) uses for it. */
const unanswered = (err: unknown) => err instanceof TypeError &&
  /^(Load failed|Failed to fetch|NetworkError when attempting to fetch resource\.?|The network connection was lost\.|Could not connect to the server\.|fetch failed)$/.test(err.message);

/**
 * Every request the window makes of the engine goes through here. The log gets each change it asks for (anything
 * but a read), each failure with the engine's reason, each call that never got through, and each slow read, so
 * "nothing happened" and "it took forever" can be told apart afterwards. Paths only: no bodies, no query values.
 */
export const loggedFetch: typeof fetch = async (input, init) => {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const path = logPath(input instanceof Request ? input.url : String(input));
  const started = performance.now();
  const took = () => Math.round(performance.now() - started);
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    const stopped = init?.signal?.aborted || (error instanceof DOMException && error.name === "AbortError");
    if (stopped) appLog("api", "stopped", { method, path, ms: took() }, { key: `stopped:${method} ${path}` });
    else appLog("api", "unreachable", { method, path, ms: took(), error: String(error) }, { key: `unreachable:${method} ${path}`, level: "warn" });
    // Still a TypeError, as a failed fetch is, in words the editor can read wherever it shows.
    throw stopped || !unanswered(error) ? error : new TypeError(ENGINE_UNREACHABLE, { cause: error });
  }
  const ms = took();
  if (!response.ok) {
    // The engine's own words for what went wrong, read from a copy so the caller still gets the body.
    void response.clone().text().then(body => body.slice(0, 300), () => "").then(reason =>
      appLog("api", "failed", { method, path, status: response.status, ms, reason: reason || undefined }, { key: `failed:${method} ${path} ${response.status}`, level: "warn" }));
  } else if (method !== "GET" && method !== "HEAD") appLog("api", "did", { method, path, status: response.status, ms }, { key: `did:${method} ${path}` });
  else if (ms >= SLOW_CALL_MS) appLog("api", "slow", { method, path, status: response.status, ms }, { key: `slow:${path}` });
  return response;
};

export let api: ScarletApi = IS_MOCK
  ? (mockInstance = new MockClient(() => "mock-token", true))
  : new ScarletClient({ baseUrl: serverUrl, previewFrames: true, fetch: loggedFetch });

export function connectDesktopEngine(url: string, token: string) {
  serverUrl = url;
  api = new ScarletClient({ baseUrl: url, token, previewFrames: true, fetch: loggedFetch });
  markDesktop(url);
}

/** Normalise any thrown value into a user-facing message. */
export function errorMessage(err: unknown): string {
  // A 503 with nothing in it is the engine turning requests away as it shuts down. Its own refusals carry a reason.
  if (err instanceof ScarletApiError) return err.status === 503 && err.code === "http_error" ? ENGINE_UNREACHABLE : err.message || `${err.code} (${err.status})`;
  if (unanswered(err)) return ENGINE_UNREACHABLE;
  if (err instanceof Error) return err.message;
  return String(err);
}
