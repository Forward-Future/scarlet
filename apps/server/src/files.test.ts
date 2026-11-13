import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { HttpError } from "./errors.js";
import { contentTypeFor, originalPlaybackType, serveFile, serveOriginal } from "./files.js";

let directory: string;
let file: string;
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-files-test-"));
  file = join(directory, "clip.mp4");
  writeFileSync(file, "0123456789");
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const get = (range?: string, init: RequestInit = {}) =>
  new Request("http://engine.test/file", { ...init, headers: { ...(range && { Range: range }), ...init.headers } });
/** Status, the headers a player reads, and the bytes. */
async function served(res: Response) {
  return [res.status, res.headers.get("Content-Range"), res.headers.get("Content-Length"), await res.text()];
}

it("serves a whole file, and says it takes ranges", async () => {
  const res = serveFile(get(), file);
  expect(Object.fromEntries(res.headers)).toEqual({ "accept-ranges": "bytes", "cache-control": "private, max-age=0", "content-length": "10", "content-type": "video/mp4" });
  expect(await served(res)).toEqual([200, null, "10", "0123456789"]);
  const chosen = serveFile(get(), file, { contentType: "application/x-test", cacheControl: "no-store" });
  expect([chosen.headers.get("Content-Type"), chosen.headers.get("Cache-Control")]).toEqual(["application/x-test", "no-store"]);
});

it("serves the part a player asks for: from a byte, between two, or the last few", async () => {
  expect(await served(serveFile(get("bytes=4-"), file))).toEqual([206, "bytes 4-9/10", "6", "456789"]);
  expect(await served(serveFile(get("bytes=2-5"), file))).toEqual([206, "bytes 2-5/10", "4", "2345"]);
  expect(await served(serveFile(get(" bytes=0-0 "), file))).toEqual([206, "bytes 0-0/10", "1", "0"]);
  // An end past the file stops at its last byte.
  expect(await served(serveFile(get("bytes=7-999"), file))).toEqual([206, "bytes 7-9/10", "3", "789"]);
  expect(await served(serveFile(get("bytes=-3"), file))).toEqual([206, "bytes 7-9/10", "3", "789"]);
  // More than the file has is all of it.
  expect(await served(serveFile(get("bytes=-50"), file))).toEqual([206, "bytes 0-9/10", "10", "0123456789"]);
});

it("answers 416 with the file's size for a range it can't serve", async () => {
  for (const range of ["bytes=10-", "bytes=12-20", "bytes=5-2", "bytes=-", "bytes=-0", "bytes=a-b", "bytes=0-1,4-5", "items=0-1"]) {
    expect([range, ...await served(serveFile(get(range), file))]).toEqual([range, 416, "bytes */10", null, ""]);
  }
});

it("answers a HEAD with the headers and no body", async () => {
  expect(await served(serveFile(get(undefined, { method: "HEAD" }), file))).toEqual([200, null, "10", ""]);
  expect(await served(serveFile(get("bytes=2-5", { method: "HEAD" }), file))).toEqual([206, "bytes 2-5/10", "4", ""]);
});

it("serves an empty file as empty, and refuses any range of it", async () => {
  const empty = join(directory, "empty.txt");
  writeFileSync(empty, "");
  expect(await served(serveFile(get(), empty))).toEqual([200, null, "0", ""]);
  expect(await served(serveFile(get("bytes=0-"), empty))).toEqual([416, "bytes */0", null, ""]);
  expect(await served(serveFile(get("bytes=-5"), empty))).toEqual([416, "bytes */0", null, ""]);
});

it("streams a large file whole, for a save as for playback", async () => {
  const large = join(directory, "large.bin");
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
  writeFileSync(large, bytes);
  for (const headers of [{}, { "x-scarlet-download": "1" }]) {
    const res = serveFile(get(undefined, { headers }), large);
    expect(res.headers.get("Content-Length")).toBe(String(bytes.length));
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
  }
});

it("answers 404 for a file that isn't there, and for a folder", () => {
  for (const path of [join(directory, "missing.mp4"), directory]) {
    let thrown: unknown;
    try { serveFile(get(), path); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(HttpError);
    expect(thrown).toMatchObject({ status: 404, code: "not_found", message: "file not found" });
  }
});

it("serves an original as what it is only when a browser can't run it", () => {
  const page = join(directory, "notes.html"), vector = join(directory, "logo.svg"), still = join(directory, "still.PNG");
  for (const path of [page, vector, still]) writeFileSync(path, "<script>alert(1)</script>");
  // Footage and still pictures keep their type. Anything a browser could run is a download.
  const describe = (path: string) => {
    const res = serveOriginal(get(), path);
    return [res.headers.get("Content-Type"), res.headers.get("Content-Disposition"), res.headers.get("Content-Security-Policy"), res.headers.get("X-Content-Type-Options")];
  };
  const locked = ["sandbox; default-src 'none'", "nosniff"];
  expect(describe(file)).toEqual(["video/mp4", null, ...locked]);
  expect(describe(still)).toEqual(["image/png", null, ...locked]);
  expect(describe(page)).toEqual(["application/octet-stream", "attachment", ...locked]);
  expect(describe(vector)).toEqual(["application/octet-stream", "attachment", ...locked]);
});

it("names a file's type from its extension, whatever its case", () => {
  expect(["a.MP4", "b.m4v", "c.mov", "d.wav", "e.otio", "f.md", "g", "h.xyz", "dir.mp4/readme"].map(contentTypeFor)).toEqual([
    "video/mp4", "video/mp4", "video/quicktime", "audio/wav", "application/json", "text/markdown; charset=utf-8",
    "application/octet-stream", "application/octet-stream", "application/octet-stream",
  ]);
});

it("offers an original for playback only as a type that matches what was probed in it", () => {
  // The containers browsers are particular about carry their codecs, in the browser's names for them.
  expect(originalPlaybackType("a.mp4", "video", "h264", "aac")).toBe('video/mp4; codecs="avc1,mp4a.40.2"');
  expect(originalPlaybackType("a.mov", "video", "hevc", "pcm_s16le")).toBe('video/quicktime; codecs="hvc1,pcm_s16le"');
  expect(originalPlaybackType("a.webm", "video", "vp9")).toBe('video/webm; codecs="vp9"');
  expect(originalPlaybackType("a.m4a", "audio", undefined, "aac")).toBe('audio/mp4; codecs="mp4a.40.2"');
  // No stream was probed, so nothing can be promised.
  expect(originalPlaybackType("a.mp4", "video")).toBeUndefined();
  // Other containers are offered by type alone.
  expect(originalPlaybackType("a.mkv", "video", "h264", "aac")).toBe("video/x-matroska");
  expect(originalPlaybackType("a.wav", "audio", undefined, "pcm_s16le")).toBe("audio/wav");
  // A file whose extension says one thing and whose streams another isn't offered.
  expect(originalPlaybackType("a.mp3", "video", "h264")).toBeUndefined();
  expect(originalPlaybackType("a.mp4", "audio", undefined, "aac")).toBeUndefined();
  expect(originalPlaybackType("a.png", "image")).toBeUndefined();
});
