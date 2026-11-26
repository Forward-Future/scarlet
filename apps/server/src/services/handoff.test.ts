import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runCapture } from "@scarlet/render";
import { createProject, emptyTimeline, makeMediaClip, makeTrack } from "@scarlet/timeline";
import { expect, it } from "vitest";
import type { Ctx } from "../context.js";
import { buildHandoff } from "./handoff.js";

it("gives each source, generated solid and subtitle file a distinct name in the handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "scarlet-handoff-"));
  try {
    await runCapture("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=64x64", "-frames:v", "1", join(root, "upload.png")]);
    const ctx = { paths: { media: () => root, tmp: root }, log: () => {} } as unknown as Ctx;
    const project = createProject("Handoff", { width: 64, height: 64 });
    project.media = [{ id: "upload", kind: "image", name: "Solid ff0000.png", path: "upload.png", width: 64, height: 64 }];
    const timeline = emptyTimeline(project.id);
    const captions = (id: string, text: string) => ({ ...makeTrack("caption", "English", `${id}-track`), clips: [
      { id, kind: "caption" as const, enabled: true, timelineIn: 0, timelineOut: 1, text },
    ] });
    timeline.tracks = [
      { ...makeTrack("video", "Video", "video"), clips: [makeMediaClip("upload", 0, 2, 0),
        { id: "solid", kind: "color", color: "#ff0000", timelineIn: 2, timelineOut: 4, enabled: true, opacity: 1 }] },
      captions("first", "First caption"), captions("second", "Second\n  \ncaption"),
    ];

    const folder = join(root, "Transfer");
    const { files } = await buildHandoff(ctx, project, timeline, folder);
    const paths = files.map(file => file.path.toLowerCase());
    expect(new Set(paths).size).toBe(paths.length);
    const xml = files.find(file => file.path === "Transfer.fcpxml");
    for (const name of ["Solid ff0000.png", "Solid ff0000 2.png"]) {
      expect(paths).toContain(`media/${name.toLowerCase()}`);
      expect(xml).toMatchObject({ text: expect.stringContaining(pathToFileURL(join(folder, "Media", name)).href) });
    }
    const subtitleFiles = files.filter(file => file.path.endsWith(".srt"));
    expect(subtitleFiles).toMatchObject([{ text: expect.stringContaining("First caption") }, { text: expect.stringContaining("Second\ncaption") }]);
    const readme = files.find(file => file.path === "Read me.txt");
    for (const file of subtitleFiles) expect(readme).toMatchObject({ text: expect.stringContaining(file.path) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
