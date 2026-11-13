import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { lookup } from "node:dns/promises";
import { get as plainGet } from "node:http";
import { get } from "node:https";
import { downloadImport } from "./importUrl.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("node:https", () => ({ get: vi.fn() }));
vi.mock("node:http", async importOriginal => ({ ...await importOriginal<object>(), get: vi.fn() }));
afterEach(() => vi.resetAllMocks());

function publicResponse(statusCode: number, headers: Record<string, string>) {
  const res = Object.assign(new EventEmitter(), { statusCode, headers, destroy: vi.fn() });
  vi.mocked(get).mockImplementationOnce(((_url: URL, opts: { lookup: Function }, cb: (r: unknown) => void) => {
    opts.lookup("media.example", {}, (err: unknown, ip: string, family: number) => {
      expect([err, ip, family]).toEqual([null, "93.184.216.34", 4]);
    });
    cb(res);
    return Object.assign(new EventEmitter(), { setTimeout: vi.fn() });
  }) as unknown as typeof get);
  return res;
}

it("pins the validated address on a public HTTPS download", async () => {
  vi.mocked(lookup).mockResolvedValue([{ family: 4, address: "93.184.216.34" }]);
  const res = publicResponse(200, { "content-type": "video/mp4" });
  expect(await downloadImport(new URL("https://media.example/file"))).toBe(res as unknown as IncomingMessage);
  expect(lookup).toHaveBeenCalledTimes(1);
});

it("checks redirects and mixed DNS answers before opening another connection", async () => {
  vi.mocked(lookup).mockResolvedValueOnce([{ family: 4, address: "93.184.216.34" }])
    .mockResolvedValueOnce([{ family: 4, address: "93.184.216.34" }, { family: 6, address: "::1" }]);
  const redirect = publicResponse(302, { location: "https://internal.example/video" });
  await expect(downloadImport(new URL("https://media.example/file"))).rejects.toThrow(/public address/);
  expect(redirect.destroy).toHaveBeenCalledOnce();
  expect(get).toHaveBeenCalledTimes(1);
});

const publicHost = () => vi.mocked(lookup).mockResolvedValue([{ family: 4, address: "93.184.216.34" }]);
/** What a refused download says, as the import route would send it on. */
const refusal = (url: string) => downloadImport(new URL(url)).then(() => null, e => [e.status, e.code, e.message]);

it("refuses an address that isn't plain HTTP or HTTPS, or that carries a login", async () => {
  expect(await refusal("ftp://media.example/file.mp4")).toEqual([400, "invalid_url", "use a public HTTP(S) URL"]);
  expect(await refusal("file:///etc/passwd")).toEqual([400, "invalid_url", "use a public HTTP(S) URL"]);
  expect(await refusal("https://editor:hunter2@media.example/file.mp4")).toEqual([400, "invalid_url", "use a public HTTP(S) URL"]);
  expect(await refusal("https://editor@media.example/file.mp4")).toEqual([400, "invalid_url", "use a public HTTP(S) URL"]);
  // Refused before anything is looked up or connected to.
  expect(lookup).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
});

it("refuses an address on this machine or a private network, by name or by number", async () => {
  const privateAddress = [400, "invalid_url", "the media URL must resolve to a public address"];
  for (const url of ["http://127.0.0.1/file.mp4", "http://10.0.0.5:8080/file.mp4", "http://192.168.1.20/file.mp4", "http://169.254.169.254/latest", "http://[::1]/file.mp4",
    "http://[fd00::1]/file.mp4", "http://[::ffff:127.0.0.1]/file.mp4", "http://[64:ff9b::7f00:1]/file.mp4"]) {
    expect([url, await refusal(url)]).toEqual([url, privateAddress]);
  }
  // A number is its own address: nothing is looked up.
  expect(lookup).not.toHaveBeenCalled();
  vi.mocked(lookup).mockResolvedValueOnce([{ family: 4, address: "192.168.1.20" }]).mockResolvedValueOnce([]);
  expect(await refusal("https://nas.example/file.mp4")).toEqual(privateAddress);
  expect(await refusal("https://nowhere.example/file.mp4")).toEqual(privateAddress);
  expect(get).not.toHaveBeenCalled();
  expect(plainGet).not.toHaveBeenCalled();
});

it("refuses an answer that isn't a file: an error, or a web page", async () => {
  publicHost();
  const notMedia = [400, "download_failed", "URL did not return a media file"];
  for (const [status, type] of [[404, "video/mp4"], [500, "application/json"], [403, "video/mp4"], [200, "text/html; charset=utf-8"], [304, "video/mp4"]] as const) {
    const res = publicResponse(status, { "content-type": type });
    expect([status, type, await refusal("https://media.example/file")]).toEqual([status, type, notMedia]);
    expect(res.destroy).toHaveBeenCalledOnce();
  }
  // A redirect that names nowhere to go is an answer like any other.
  publicResponse(302, {});
  expect(await refusal("https://media.example/file")).toEqual(notMedia);
  // A file with no declared type is still a file.
  const untyped = publicResponse(206, {});
  expect(await downloadImport(new URL("https://media.example/file"))).toBe(untyped as unknown as IncomingMessage);
});

it("follows five redirects, relative ones too, and gives up on the sixth", async () => {
  publicHost();
  const hops = ["/a", "b", "https://media.example/c/d", "../e", "?part=2"].map(location => publicResponse(307, { location }));
  const file = publicResponse(200, { "content-type": "video/mp4" });
  expect(await downloadImport(new URL("https://media.example/start"))).toBe(file as unknown as IncomingMessage);
  expect(vi.mocked(get).mock.calls.map(call => String(call[0]))).toEqual([
    "https://media.example/start", "https://media.example/a", "https://media.example/b", "https://media.example/c/d", "https://media.example/e", "https://media.example/e?part=2",
  ]);
  for (const hop of hops) expect(hop.destroy).toHaveBeenCalledOnce();
  // Each hop is looked up again, so a redirect can't move the download to an address that wasn't checked.
  expect(lookup).toHaveBeenCalledTimes(6);

  for (let i = 0; i < 6; i++) publicResponse(301, { location: `/loop${i}` });
  expect(await refusal("https://media.example/loop")).toEqual([400, "download_failed", "too many redirects"]);
});

it("fails with the system's own reason when a name can't be found or a connection can't be made", async () => {
  vi.mocked(lookup).mockRejectedValueOnce(Object.assign(new Error("getaddrinfo ENOTFOUND media.example"), { code: "ENOTFOUND" }));
  await expect(downloadImport(new URL("https://media.example/file"))).rejects.toThrow("getaddrinfo ENOTFOUND media.example");
  publicHost();
  vi.mocked(get).mockImplementationOnce((() => {
    const req = Object.assign(new EventEmitter(), { setTimeout: vi.fn() });
    queueMicrotask(() => req.emit("error", new Error("connect ECONNREFUSED 93.184.216.34:443")));
    return req;
  }) as unknown as typeof get);
  await expect(downloadImport(new URL("https://media.example/file"))).rejects.toThrow("connect ECONNREFUSED 93.184.216.34:443");
});

it("gives up on a server that accepts the connection and then says nothing for half a minute", async () => {
  publicHost();
  let waited: number | undefined;
  vi.mocked(get).mockImplementationOnce((() => {
    const req = Object.assign(new EventEmitter(), {
      setTimeout: (ms: number, onTimeout: () => void) => { waited = ms; queueMicrotask(onTimeout); },
      destroy: (error: Error) => req.emit("error", error),
    });
    return req;
  }) as unknown as typeof get);
  await expect(downloadImport(new URL("https://media.example/file"))).rejects.toThrow("media download timed out");
  expect(waited).toBe(30_000);
});

it("downloads over plain HTTP from a public address given as a number, pinned to that number", async () => {
  const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: { "content-type": "audio/wav" }, destroy: vi.fn() });
  let pinned: unknown[] = [], options: { family?: number; agent?: unknown; signal?: AbortSignal } = {};
  vi.mocked(plainGet).mockImplementationOnce(((_url: URL, opts: typeof options & { lookup: Function }, cb: (r: unknown) => void) => {
    options = opts;
    opts.lookup("ignored.example", {}, (...answer: unknown[]) => { pinned = answer; });
    cb(res);
    return Object.assign(new EventEmitter(), { setTimeout: vi.fn() });
  }) as unknown as typeof plainGet);
  const signal = new AbortController().signal;
  expect(await downloadImport(new URL("http://93.184.216.34/voice.wav"), signal)).toBe(res as unknown as IncomingMessage);
  expect(pinned).toEqual([null, "93.184.216.34", 4]);
  // Its own connection, so a kept-alive socket to another address is never reused, and the import's cancel reaches it.
  expect(options).toMatchObject({ family: 4, agent: false, signal });
  expect(lookup).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
});
