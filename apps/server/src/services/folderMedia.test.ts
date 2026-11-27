import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProject } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import { ffmpeg } from "../render/ffmpeg.js";
import type { RenderAdapter } from "../render/adapter.js";
import { scarletRenderAdapter } from "../render/scarletRender.js";
import { expandMediaPaths } from "./folderMedia.js";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-folder-media-test-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it("recursively detects video files in natural order while skipping hidden files, OS junk, sidecars, and TypeScript .ts files", async () => {
  const raw = join(directory, "raw");
  mkdirSync(join(raw, "cam-2"), { recursive: true });
  mkdirSync(join(raw, "cam-10"), { recursive: true });
  mkdirSync(join(raw, ".hidden"), { recursive: true });
  mkdirSync(join(raw, "__MACOSX"), { recursive: true });

  // Top-level videos + non-videos + hidden/AppleDouble junk
  writeFileSync(join(raw, "clip-10.MP4"), "v");
  writeFileSync(join(raw, "clip-2.mov"), "v");
  writeFileSync(join(raw, "notes.txt"), "not a video");
  writeFileSync(join(raw, "thumb.jpg"), "not a video");
  writeFileSync(join(raw, "C0001M01.XML"), "<xml/>");
  writeFileSync(join(raw, "GX010001.LRV"), "gopro proxy");
  writeFileSync(join(raw, "voice.wav"), "audio only");
  writeFileSync(join(raw, ".DS_Store"), "finder");
  writeFileSync(join(raw, "._clip-2.mov"), "appledouble");
  writeFileSync(join(raw, "script.ts"), "export const answer: number = 42;\n");

  // Real MPEG-TS video stream (188-byte packets starting with 0x47 sync byte)
  const tsBytes = Buffer.alloc(188 * 4, 0);
  tsBytes[0] = 0x47;
  tsBytes[188] = 0x47;
  tsBytes[376] = 0x47;
  tsBytes[564] = 0x47;
  writeFileSync(join(raw, "broadcast.ts"), tsBytes);

  // Nested videos + hidden/junk dirs
  writeFileSync(join(raw, "cam-2", "take.mkv"), "v");
  writeFileSync(join(raw, "cam-10", "take.webm"), "v");
  writeFileSync(join(raw, ".hidden", "secret.mp4"), "v");
  writeFileSync(join(raw, "__MACOSX", "._clip-10.MP4"), "v");

  const result = await expandMediaPaths([raw]);
  expect(result.folders).toBe(1);
  expect(result.emptyFolders).toEqual([]);
  expect(result.files).toEqual([
    join(raw, "broadcast.ts"),
    join(raw, "clip-2.mov"),
    join(raw, "clip-10.MP4"),
    join(raw, "cam-2", "take.mkv"),
    join(raw, "cam-10", "take.webm"),
  ]);
});

it("passes directly dropped non-video files and URLs through unchanged, deduplicates overlaps, and reports empty folders", async () => {
  const raw = join(directory, "raw");
  const docs = join(directory, "docs");
  mkdirSync(raw);
  mkdirSync(docs);
  const clip = join(raw, "clip.mp4");
  const audio = join(directory, "voice.wav");
  const link = "https://example.com/interview.mp4";
  writeFileSync(clip, "v");
  writeFileSync(audio, "a");
  writeFileSync(join(docs, "script.md"), "# Script");

  const result = await expandMediaPaths([audio, clip, raw, docs, link]);
  expect(result).toEqual({
    files: [audio, clip, link],
    folders: 2,
    emptyFolders: [{ path: docs, name: "docs" }],
  });
});

it("follows valid symlinks without duplicating targets or looping on symlink cycles", async () => {
  const raw = join(directory, "raw");
  const external = join(directory, "external");
  mkdirSync(raw);
  mkdirSync(external);
  const clipA = join(raw, "a.mp4");
  const clipB = join(external, "b.mov");
  writeFileSync(clipA, "a");
  writeFileSync(clipB, "b");
  symlinkSync(raw, join(raw, "loop"));
  symlinkSync(clipA, join(raw, "dup-a.mp4"));
  symlinkSync(clipB, join(raw, "linked-b.mov"));
  symlinkSync(join(directory, "missing.mp4"), join(raw, "broken.mp4"));

  const result = await expandMediaPaths([raw]);
  expect(result.emptyFolders).toEqual([]);
  expect(result.files).toEqual([clipA, join(raw, "linked-b.mov")]);
});

it("does not report folders after the video cap as empty", async () => {
  const first = join(directory, "first");
  const second = join(directory, "second");
  mkdirSync(first);
  mkdirSync(second);
  writeFileSync(join(first, "a.mp4"), "a");
  writeFileSync(join(first, "b.mp4"), "b");
  writeFileSync(join(second, "c.mp4"), "c");

  const result = await expandMediaPaths([first, second], { maxVideos: 2 });
  expect(result.files).toEqual([join(first, "a.mp4"), join(first, "b.mp4")]);
  expect(result.emptyFolders).toEqual([]);
});

it("logs what a search of dropped folders found by counts alone, never the folders' names", async () => {
  const raw = join(directory, "Client footage");
  mkdirSync(raw);
  writeFileSync(join(raw, "a.mp4"), "a");
  const lines: string[] = [];
  await expandMediaPaths([raw, join(directory, "notes.txt")], { log: line => lines.push(line) });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^\[media\] dropped folders searched in \d+ms: 1 folders, 1 entries, 2 files, 0 without video$/);
});

it("expands a dropped folder over HTTP, imports every video inside, starts caching automatically, and rejects a raw directory on /media/import with path_is_directory", async () => {
  const dataDir = join(directory, "data");
  const raw = join(directory, "raw");
  mkdirSync(join(raw, "nested"), { recursive: true });
  const clip1 = join(raw, "take1.mp4");
  const clip2 = join(raw, "nested", "take2.mov");
  await ffmpeg(["-f", "lavfi", "-i", "color=blue:size=160x90:rate=25:duration=0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", clip1]);
  await ffmpeg(["-f", "lavfi", "-i", "color=green:size=160x90:rate=25:duration=0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", clip2]);
  writeFileSync(join(raw, "notes.txt"), "skip me");

  const makeProxy = vi.fn<RenderAdapter["makeProxy"]>(async (_input, out) => { writeFileSync(out, "cached-proxy"); });
  const workspace: ScarletApp = createApp({
    dataDir,
    skillsSeedDir: join(directory, "empty-seed"),
    env: {},
    log: () => {},
    prepareSourceProxies: true,
    render: { ...scarletRenderAdapter, makeProxy, hardwareProxies: async () => true },
  });
  const api = (method: string, path: string, body?: unknown) => workspace.app.request("/api" + path, {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: { Authorization: `Bearer ${accessToken(workspace.ctx)}`, ...(body !== undefined && { "Content-Type": "application/json" }) },
  });
  try {
    const project = workspace.ctx.repos.projects.insert(createProject("Tier list"));

    // Direct folder import reports path_is_directory instead of "no file at ..."
    const direct = await api("POST", `/projects/${project.id}/media/import`, { path: raw });
    expect(direct.status).toBe(400);
    expect((await direct.json()).error).toEqual({ code: "path_is_directory", message: "raw is a folder" });

    // Expanding the dropped folder returns both real video files and skips notes.txt
    const expandedRes = await api("POST", "/media/expand-paths", { paths: [raw] });
    expect(expandedRes.status).toBe(200);
    const expanded = await expandedRes.json() as { files: string[]; folders: number; emptyFolders: unknown[] };
    expect(expanded).toEqual({ files: [clip1, clip2], folders: 1, emptyFolders: [] });

    // Importing each detected video brings it in as ready and automatically starts caching both
    const importedIds: string[] = [];
    for (const file of expanded.files) {
      const res = await api("POST", `/projects/${project.id}/media/import`, { path: file });
      expect(res.status).toBe(201);
      importedIds.push((await res.json()).media.id);
    }
    while (workspace.ctx.pending.size) await Promise.allSettled([...workspace.ctx.pending]);

    const media = workspace.ctx.repos.projects.listMedia(project.id);
    expect(media.map(m => [m.name, m.kind, m.status])).toEqual([
      ["take1.mp4", "video", "ready"],
      ["take2.mov", "video", "ready"],
    ]);
    // Both imported videos automatically ran full source proxy caching
    const fullProxies = makeProxy.mock.calls.filter(([, , opts]) => !opts.range);
    expect(fullProxies).toHaveLength(2);
    const caches = await (await api("GET", `/projects/${project.id}/playback-caches`)).json() as { caches: Array<{ mediaId: string; state: string }> };
    expect(caches.caches.map(c => [c.mediaId, c.state])).toEqual(importedIds.map(id => [id, "ready"]));
  } finally {
    await workspace.ctx.close();
  }
});
