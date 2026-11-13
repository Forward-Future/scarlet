// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MediaAsset } from "@scarlet/timeline";
import { startAppLog, stopAppLog } from "./appLog";
import { api } from "./client";
import { canPlayOriginal, canPreviewMedia, isPreparingMedia, uploadMedia } from "./upload";

/** A request the test answers by hand. */
class FakeRequest {
  static last: FakeRequest;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body?: FormData;
  status = 0;
  responseText = "";
  upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  constructor() { FakeRequest.last = this; }
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  send(body: FormData) { this.body = body; }
  abort() { this.onabort?.(); }
  answer(status: number, body: unknown) {
    this.status = status;
    this.responseText = typeof body === "string" ? body : JSON.stringify(body);
    this.onload?.();
  }
}

const media = (extra: Partial<MediaAsset> = {}) => ({ id: "med_1", name: "A001.mov", kind: "video", duration: 12, ...extra }) as MediaAsset;
const file = new File(["frames"], "A001 private take.mov", { type: "video/quicktime" });
let lines: string[], levels: string[];
/** The log batches ordinary lines for a quarter of a second. */
const written = () => { vi.advanceTimersByTime(300); return lines; };

beforeEach(() => {
  vi.useFakeTimers();
  lines = [];
  levels = [];
  vi.stubGlobal("XMLHttpRequest", FakeRequest);
  startAppLog((batch, level) => { for (const line of batch) { lines.push(line.replace(/^(\[\w+\]) \S+ \S+ /, "$1 ").replace(/ms=\d+/, "ms=N")); levels.push(level); } });
});
afterEach(() => {
  stopAppLog();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("sends the file to the project with the session's token and reports how far it has got", async () => {
  vi.spyOn(api, "token", "get").mockReturnValue("sct_secret");
  const progress: number[] = [];
  const { promise } = uploadMedia("prj_1", file, fraction => progress.push(fraction));
  const request = FakeRequest.last;
  expect(request).toMatchObject({ method: "POST", headers: { Authorization: "Bearer sct_secret" } });
  expect(new URL(request.url).pathname).toBe("/api/projects/prj_1/media");
  const sent = request.body!.get("file") as File;
  expect(sent.name).toBe("A001 private take.mov");
  request.upload.onprogress!({ lengthComputable: true, loaded: 3, total: 6 });
  // A server that doesn't say how long the body is gives nothing to show.
  request.upload.onprogress!({ lengthComputable: false, loaded: 5, total: 0 });
  request.upload.onprogress!({ lengthComputable: true, loaded: 6, total: 6 });
  request.answer(201, { media: media() });
  await expect(promise).resolves.toEqual(media());
  expect(progress).toEqual([0.5, 1]);
  // One line for the change it asked for: the path, and neither the token nor the file's name.
  expect(written()).toEqual(["[api] did method=POST path=/api/projects/prj_1/media status=201 ms=N"]);
});

it("sends no sign-in header when there is no token", () => {
  vi.spyOn(api, "token", "get").mockReturnValue(undefined);
  void uploadMedia("prj_1", file, () => {}).promise.catch(() => {});
  expect(FakeRequest.last.headers).toEqual({});
});

it("fails with the engine's reason when it refuses the file, and logs it as a warning", async () => {
  const { promise } = uploadMedia("prj_1", file, () => {});
  FakeRequest.last.answer(415, { error: { code: "unsupported", message: "This file is not video, audio or a picture." } });
  await expect(promise).rejects.toThrow("This file is not video, audio or a picture.");
  expect(lines).toEqual(['[api] failed method=POST path=/api/projects/prj_1/media status=415 reason="This file is not video, audio or a picture." ms=N']);
  expect(levels).toEqual(["warn"]);
});

it("fails with the status when the answer has no reason, no footage, or isn't readable", async () => {
  const outcomes: string[] = [];
  for (const [status, body] of [[500, {}], [200, {}], [502, "<html>Bad gateway</html>"]] as const) {
    const { promise } = uploadMedia("prj_1", file, () => {});
    FakeRequest.last.answer(status, body);
    outcomes.push(await promise.then(() => "saved", (error: Error) => error.message));
  }
  expect(outcomes).toEqual(["Upload failed (500)", "Upload failed (200)", "Upload failed (502)"]);
  expect(lines).toEqual([
    "[api] failed method=POST path=/api/projects/prj_1/media status=500 ms=N",
    "[api] failed method=POST path=/api/projects/prj_1/media status=200 ms=N",
    '[api] failed method=POST path=/api/projects/prj_1/media status=502 reason="unreadable answer" ms=N',
  ]);
});

it("fails as a network error when the engine can't be reached", async () => {
  const { promise } = uploadMedia("prj_1", file, () => {});
  FakeRequest.last.onerror!();
  await expect(promise).rejects.toThrow("Network error during upload");
  expect(lines).toEqual(["[api] unreachable method=POST path=/api/projects/prj_1/media ms=N"]);
  expect(levels).toEqual(["warn"]);
});

it("stops when the editor cancels, as an abort and not a failure", async () => {
  const { promise, abort } = uploadMedia("prj_1", file, () => {});
  abort();
  await expect(promise).rejects.toMatchObject({ name: "AbortError", message: "Upload cancelled" });
  expect(written()).toEqual(["[api] stopped method=POST path=/api/projects/prj_1/media ms=N"]);
  expect(levels).toEqual(["info"]);
});

it("knows footage that is still being prepared from footage that is ready", () => {
  expect(isPreparingMedia(media({ status: "ingesting" }))).toBe(true);
  expect(isPreparingMedia(media({ status: "ready" }))).toBe(false);
  // Footage saved before imports had a status: no length yet means still being read, except for a picture.
  expect(isPreparingMedia(media({ status: undefined, duration: 0 }))).toBe(true);
  expect(isPreparingMedia(media({ status: undefined, duration: 12 }))).toBe(false);
  expect(isPreparingMedia(media({ status: undefined, kind: "image", duration: 0 }))).toBe(false);
  expect(isPreparingMedia(media({ status: "failed", duration: 0 }))).toBe(false);
});

it("plays an original only when it is video or sound in a format this window can play", () => {
  const asked: string[] = [];
  vi.spyOn(HTMLVideoElement.prototype, "canPlayType").mockImplementation(type => { asked.push(type); return type === "video/mp4" ? "probably" : ""; });
  expect(canPlayOriginal(media({ originalPlaybackType: "video/mp4" }))).toBe(true);
  expect(canPlayOriginal(media({ originalPlaybackType: "video/x-prores" }))).toBe(false);
  // A type that isn't the footage's own kind, a picture, or no type at all is never asked about.
  expect(canPlayOriginal(media({ originalPlaybackType: "audio/mp4" }))).toBe(false);
  expect(canPlayOriginal(media({ kind: "image", originalPlaybackType: "image/png" }))).toBe(false);
  expect(canPlayOriginal(media({ originalPlaybackType: undefined }))).toBe(false);
  // The window is asked once for each format.
  expect(canPlayOriginal(media({ id: "med_2", originalPlaybackType: "video/mp4" }))).toBe(true);
  expect(asked).toEqual(["video/mp4", "video/x-prores"]);
});

it("can preview footage that is prepared on demand, already has a preview, or plays as it is", () => {
  vi.spyOn(HTMLVideoElement.prototype, "canPlayType").mockReturnValue("");
  expect(canPreviewMedia(media({ previewMode: "on-demand" }))).toBe(true);
  expect(canPreviewMedia(media({ status: "ready" }))).toBe(true);
  expect(canPreviewMedia(media({ status: "ingesting", originalPlaybackType: "video/x-unplayable" }))).toBe(false);
});
