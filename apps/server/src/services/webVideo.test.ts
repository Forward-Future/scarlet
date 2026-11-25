import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFfmpeg, resolveFfprobe } from "@scarlet/render";
import { createProject, type Project } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import { DOWNLOADERS } from "./videoDownloader.js";
import { aboutWebVideo, captionLines, captionTrack, webVideoCaptions } from "./webVideo.js";

let directory: string;
let workspace: ScarletApp;
let project: Project;

/**
 * A stand-in for yt-dlp that answers as it does: the page's reading for `-J`, a caption file for `--skip-download`, and
 * for a part a test picture of the length asked, drawn by ffmpeg. Every call's arguments go to calls.jsonl.
 */
const STAND_IN = `#!/usr/bin/env node
const { appendFileSync, writeFileSync, readFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(process.env.CALLS, JSON.stringify(args) + "\\n");
const after = name => args[args.indexOf(name) + 1];
const url = args.at(-1);
if (args.includes("-J")) {
  if (url.includes("gone")) { console.error("ERROR: [youtube] gone: Video unavailable. This video is private"); process.exit(1); }
  if (url.includes("list")) { console.log(JSON.stringify({ _type: "playlist", entries: [] })); process.exit(0); }
  if (url.includes("inside")) { console.log(JSON.stringify({ title: "Inside", webpage_url: url, formats: [{ url: "http://192.168.1.20/video.mp4" }] })); process.exit(0); }
  console.log(JSON.stringify({ title: "Agents at work", channel: "The Ledger", duration: url.includes("long") ? 7200 : 90, upload_date: "20261102", license: "Creative Commons Attribution license (reuse allowed)",
    webpage_url: url.includes("slow") ? url : "https://example.com/watch?v=agents", width: 1920, height: 1080, language: "en", is_live: url.includes("live"),
    chapters: [{ start_time: 0, end_time: 30, title: "Intro" }, { start_time: 30, end_time: 90, title: "The demo" }], description: "A demo of agents.",
    subtitles: url.includes("silent") ? {} : { en: [{ ext: "json3", url: "https://example.com/captions" }] }, formats: [{ url: "https://example.com/video.mp4" }] }));
} else if (args.includes("--skip-download")) {
  const info = JSON.parse(readFileSync(after("--load-info-json"), "utf8"));
  if (info.webpage_url.includes("slow")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  writeFileSync(after("-o") + ".en.json3", JSON.stringify({ events: [{ tStartMs: 1200, segs: [{ utf8: "Here is the agent" }] }, { tStartMs: 1300, segs: [{ utf8: "\\n" }] },
    ...Array.from({ length: 2000 }, (_, i) => ({ tStartMs: 5000 + i * 1000, segs: [{ utf8: "running a task, line " + i }] }))] }));
} else if (args.includes("--download-sections")) {
  const [, from, to] = /^\\*([\\d.]+)-([\\d.]+)$/.exec(after("--download-sections"));
  execFileSync(process.env.FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=10", "-t", String(to - from), "-pix_fmt", "yuv420p",
    after("-o").replace("%(ext)s", "mp4")]);
}
`;

const auth = () => ({ Authorization: `Bearer ${accessToken(workspace.ctx)}` });
const api = (method: string, path: string, body?: unknown) =>
  workspace.app.request("/api" + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...auth(), ...(body !== undefined && { "Content-Type": "application/json" }) } });
const calls = () => existsSync(join(directory, "calls.jsonl"))
  ? readFileSync(join(directory, "calls.jsonl"), "utf8").trim().split("\n").map((line: string) => JSON.parse(line) as string[]) : [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-web-video-test-"));
  const standIn = join(directory, "yt-dlp-stand-in");
  writeFileSync(standIn, STAND_IN);
  chmodSync(standIn, 0o755);
  workspace = createApp({ dataDir: join(directory, "data"), skillsSeedDir: join(directory, "empty-seed"),
    env: process.env.SCARLET_TEST_WEB_VIDEO ? {} : { YT_DLP_PATH: standIn, CALLS: join(directory, "calls.jsonl"), FFMPEG: resolveFfmpeg() }, log: () => {} });
  project = workspace.ctx.repos.projects.insert(createProject("B-roll", { width: 320, height: 180, fps: 10, aspect: "custom" }));
});
afterEach(async () => {
  if (!workspace.ctx.shutdown.aborted) await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("captions", () => {
  it("reads YouTube's JSON and WebVTT into lines with the second each starts on", () => {
    expect(captionLines("captions.en.json3", JSON.stringify({ events: [{ tStartMs: 1200, segs: [{ utf8: "All right, so here we are,\nin front of the " }, { utf8: "elephants" }] },
      { tStartMs: 3000, segs: [{ utf8: "\n" }] }, { tStartMs: 5318, segs: [{ utf8: "they have really long trunks" }] }, {}] })))
      .toEqual([{ start: 1.2, text: "All right, so here we are, in front of the elephants" }, { start: 5.3, text: "they have really long trunks" }]);
    expect(captionLines("captions.en.vtt", "WEBVTT\nKind: captions\n\n1\n00:00:01.200 --> 00:00:03.000 align:start\nHere is <c>the</c> agent &amp; its task\n\n00:00:03.000 --> 00:00:05.000\nHere is the agent & its task\n\n01:02:03,500 --> 01:02:05.000\nan hour in\n"))
      .toEqual([{ start: 1.2, text: "Here is the agent & its task" }, { start: 3723.5, text: "an hour in" }]);
  });

  it("takes the uploader's captions in the video's language before the site's automatic ones", () => {
    expect(captionTrack({ language: "de", subtitles: { en: [], "de-DE": [], live_chat: [] }, automatic_captions: { de: [] } })).toEqual({ language: "de-DE", automatic: false });
    expect(captionTrack({ language: "de", subtitles: {}, automatic_captions: { fr: [], "de-orig": [], de: [] } })).toEqual({ language: "de-orig", automatic: true });
    expect(captionTrack({ subtitles: { ja: [] }, automatic_captions: { fr: [], en: [] } })).toEqual({ language: "en", automatic: true });
    expect(captionTrack({ subtitles: { ja: [] }, automatic_captions: { fr: [] } })).toEqual({ language: "ja", automatic: false });
    expect(captionTrack({ subtitles: { live_chat: [] }, automatic_captions: { fr: [] } })).toBeUndefined();
  });
});

describe("the downloader", () => {
  it("is pinned by size and checksum for every machine Scarlet runs on", () => {
    expect(Object.keys(DOWNLOADERS).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]);
    for (const pinned of Object.values(DOWNLOADERS)) {
      expect(pinned.url).toMatch(/^https:\/\/github\.com\/yt-dlp\/yt-dlp\/releases\/download\/\d{4}\.\d{2}\.\d{2}\/yt-dlp/);
      expect([pinned.sha256.length, pinned.size > 1e7]).toEqual([64, true]);
    }
  });
});

describe("videos from the web", () => {
  it("reads only public addresses, never a file or the machine's own network", async () => {
    for (const url of ["file:///etc/passwd", "http://localhost:4317/video", "http://127.0.0.1:9", "http://192.168.1.20/clip.mp4", "ytsearch5:agents", "not a url", "http://nas.local/a.mp4"]) {
      const res = await api("POST", `/projects/${project.id}/web-videos`, { url, from: 0, to: 5 });
      expect([res.status, (await res.json() as { error: { code: string } }).error.code], url).toEqual([400, "bad_url"]);
    }
    expect(calls()).toEqual([]);
  });

  it.skipIf(process.platform === "win32" || !!process.env.SCARLET_TEST_WEB_VIDEO)("says what a video is and what is said in it, and downloads nothing", async () => {
    const res = await api("POST", `/projects/${project.id}/web-videos`, { url: "https://example.com/watch?v=agents" });
    expect(res.status).toBe(200);
    const { video, captions } = await res.json() as { video: Record<string, unknown>; captions: { language: string; automatic: boolean; text: string; next?: number } };
    expect(video).toEqual({ url: "https://example.com/watch?v=agents", title: "Agents at work", channel: "The Ledger", duration: 90, uploaded: "2026-11-02",
      license: "Creative Commons Attribution license (reuse allowed)", width: 1920, height: 1080,
      chapters: [{ start: 0, end: 30, title: "Intro" }, { start: 30, end: 90, title: "The demo" }], description: "A demo of agents." });
    expect([captions.language, captions.automatic, captions.text.split("\n").slice(0, 2), captions.text.length <= 20_000])
      .toEqual(["en", false, ["1.2 Here is the agent", "5 running a task, line 0"], true]);
    // The rest is read from where this call stopped, with no second reading of the page or the captions.
    const more = await (await api("POST", `/projects/${project.id}/web-videos`, { url: "https://example.com/watch?v=agents", captionsFrom: captions.next })).json() as { captions: { text: string; next?: number } };
    expect(more.captions.text.startsWith(`${captions.next} running a task, line ${captions.next! - 5}`)).toBe(true);
    expect(calls().map(args => args.includes("-J") ? "read" : args.includes("--skip-download") ? "captions" : "part")).toEqual(["read", "captions"]);
    expect(calls()[0]).toEqual(expect.arrayContaining(["--ignore-config", "--no-playlist", "--", "https://example.com/watch?v=agents"]));

    const silent = await (await api("POST", `/projects/${project.id}/web-videos`, { url: "https://example.com/watch?v=silent" })).json() as { video: { title: string }; captions?: unknown };
    expect([silent.video.title, silent.captions]).toEqual(["Agents at work", undefined]);
  });

  it.skipIf(process.platform === "win32" || !!process.env.SCARLET_TEST_WEB_VIDEO)("saves one part, cut on the seconds asked, and hands it over once", async () => {
    const waiting = () => readdirSync(tmpdir()).filter(name => name.startsWith("scarlet-web-video-part-")).length;
    const before = waiting();
    const res = await api("POST", `/projects/${project.id}/web-videos`, { url: "https://example.com/watch?v=agents", from: 30.5, to: 33 });
    expect(res.status).toBe(201);
    expect(waiting()).toBe(before + 1);
    const { video, part } = await res.json() as { video: { title: string }; part: { id: string; from: number; to: number; duration: number; width: number; height: number; size: number; poster?: string } };
    expect([video.title, part.from, part.to, part.duration, part.width, part.height]).toEqual(["Agents at work", 30.5, 33, 2.5, 320, 180]);
    expect(Buffer.from(part.poster!, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    const cut = calls().find(args => args.includes("--download-sections"))!;
    expect(cut).toEqual(expect.arrayContaining(["--download-sections", "*30.5-33", "--force-keyframes-at-cuts", "--merge-output-format", "mp4", "-S", "res:1080,vcodec:h264,acodec:aac"]));

    expect((await api("GET", `/projects/${workspace.ctx.repos.projects.insert(createProject("Other")).id}/web-videos/${part.id}`)).status).toBe(404);
    const file = await api("GET", `/projects/${project.id}/web-videos/${part.id}`);
    expect([file.status, file.headers.get("Content-Type"), (await file.arrayBuffer()).byteLength]).toEqual([200, "application/octet-stream", part.size]);
    expect((await api("GET", `/projects/${project.id}/web-videos/${part.id}`)).status).toBe(404);
    expect(waiting()).toBe(before);
  });

  it.skipIf(process.platform === "win32" || !!process.env.SCARLET_TEST_WEB_VIDEO)("refuses what it can't use and says why in the site's words", async () => {
    const said = async (body: Record<string, unknown>) => {
      const res = await api("POST", `/projects/${project.id}/web-videos`, body);
      const { error } = await res.json() as { error: { code: string; message: string } };
      return [res.status, error.code, error.message];
    };
    expect(await said({ url: "https://example.com/watch?v=gone" })).toEqual([502, "video_failed", "Couldn't read that video: Video unavailable. This video is private"]);
    expect(await said({ url: "https://example.com/list" })).toEqual([400, "bad_url", "That address is a list of videos. Give the address of one video."]);
    expect(await said({ url: "https://example.com/live" })).toEqual([400, "bad_url", "That video is live. Only a finished video can be used."]);
    expect((await said({ url: "https://example.com/inside" })).slice(0, 2)).toEqual([400, "bad_url"]);
    expect(await said({ url: "https://example.com/watch?v=agents", from: 100, to: 120 })).toEqual([400, "bad_range", "That part is past the video's end: it is 90 seconds long."]);
    expect(await said({ url: "https://example.com/watch?v=agents", from: 10 })).toEqual([400, "bad_range", "Give both `from` and `to`, in seconds of the video."]);
    expect(await said({ url: "https://example.com/watch?v=long", from: 0, to: 700 })).toEqual([400, "bad_range", "One call saves up to 10 minutes. Ask for a shorter part, or for the parts one at a time."]);
  });

  it.skipIf(process.platform === "win32" || !!process.env.SCARLET_TEST_WEB_VIDEO)("reads the captions for one caller when another who asked at the same time gives up", async () => {
    const url = "https://example.com/watch?v=slow";
    await aboutWebVideo(workspace.ctx, url, new AbortController().signal);
    const quitter = new AbortController();
    const first = webVideoCaptions(workspace.ctx, url, 0, quitter.signal);
    first.catch(() => {});
    // The first caller's read of the captions is under way, and the second joins it.
    await vi.waitFor(() => expect(calls().some(args => args.includes("--skip-download"))).toBe(true), { timeout: 5000 });
    const second = webVideoCaptions(workspace.ctx, url, 0, new AbortController().signal);
    await new Promise(resolve => setTimeout(resolve, 50));
    quitter.abort();
    await expect(first).rejects.toThrow();
    expect((await second)?.text.split("\n")[0]).toBe("1.2 Here is the agent");
  });

  it.skipIf(process.platform === "win32" || !!process.env.SCARLET_TEST_WEB_VIDEO)("reads several videos at once when ffmpeg goes by another name", async () => {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    symlinkSync(resolveFfmpeg(), join(bin, "ffmpeg-test"));
    symlinkSync(resolveFfprobe(), join(bin, "ffprobe-test"));
    const before = { SCARLET_FFMPEG: process.env.SCARLET_FFMPEG, SCARLET_FFPROBE: process.env.SCARLET_FFPROBE };
    process.env.SCARLET_FFMPEG = join(bin, "ffmpeg-test");
    process.env.SCARLET_FFPROBE = join(bin, "ffprobe-test");
    try {
      const read = await Promise.allSettled(Array.from({ length: 6 }, (_, i) =>
        aboutWebVideo(workspace.ctx, `https://example.com/watch?v=agents${i}`, new AbortController().signal)));
      expect(read.map(r => r.status === "rejected" ? String(r.reason) : r.status)).toEqual(Array(6).fill("fulfilled"));
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it.skipIf(!process.env.SCARLET_TEST_WEB_VIDEO)("takes ten seconds of a real video with the real downloader", async () => {
    const url = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
    const about = await (await api("POST", `/projects/${project.id}/web-videos`, { url })).json() as { video: { title: string; duration: number } };
    expect([about.video.title.startsWith("Big Buck Bunny"), about.video.duration]).toEqual([true, 635]);
    const res = await api("POST", `/projects/${project.id}/web-videos`, { url, from: 60, to: 70, height: 720 });
    const { part } = await res.json() as { part: { id: string; duration: number; height: number; size: number } };
    expect([res.status, part.duration, part.height]).toEqual([201, 10, 720]);
    expect((await (await api("GET", `/projects/${project.id}/web-videos/${part.id}`)).arrayBuffer()).byteLength).toBe(part.size);
  }, 300_000);
});
