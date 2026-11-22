import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createProject, type Project } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "./app.js";
import { scarletRenderAdapter } from "./render/scarletRender.js";
import { readMissingColors } from "./services/mediaColor.js";

let directory: string;
let workspace: ScarletApp;
let project: Project;
const probed: string[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-media-color-"));
  probed.length = 0;
  workspace = createApp({
    dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: () => {},
    render: {
      ...scarletRenderAdapter,
      async probeMedia(path) {
        probed.push(path);
        const hdr = path.endsWith("hlg.mov");
        return { duration: 1, hasAudio: false, kind: "video", color: hdr ? { hdr: "hlg", primaries: "bt2020", transfer: "arib-std-b67" } : {} };
      },
    },
  });
  project = workspace.ctx.repos.projects.insert(createProject("Colour"));
});
afterEach(async () => {
  await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

it("reads the colour of videos imported before Scarlet read it, once each, and tells the open project", async () => {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  for (const name of ["hlg.mov", "sdr.mp4", "known.mov"]) writeFileSync(join(ctx.paths.media(project.id), name), "video");
  ctx.repos.projects.putMedia(project.id, { id: "hlg", kind: "video", name: "Phone", path: "hlg.mov", duration: 1 }, "ready");
  ctx.repos.projects.putMedia(project.id, { id: "sdr", kind: "video", name: "Camera", path: "sdr.mp4", duration: 1 }, "ready");
  ctx.repos.projects.putMedia(project.id, { id: "known", kind: "video", name: "Read", path: "known.mov", duration: 1, color: {} }, "ready");
  ctx.repos.projects.putMedia(project.id, { id: "voice", kind: "audio", name: "Voice", path: "voice.wav", duration: 1 }, "ready");
  const updated: string[] = [];
  const listen = (event: Parameters<typeof ctx.bus.publish>[0]) => { if (event.type === "media.updated") updated.push(event.media.id); };
  ctx.bus.on("ws", listen);

  await readMissingColors(ctx);
  ctx.bus.off("ws", listen);
  expect(probed.map(path => path.split(/[\\/]/).pop())).toEqual(["hlg.mov", "sdr.mp4"]);
  expect(ctx.repos.projects.getMedia("hlg")?.color).toEqual({ hdr: "hlg", primaries: "bt2020", transfer: "arib-std-b67" });
  expect(ctx.repos.projects.getMedia("sdr")?.color).toEqual({});
  expect(ctx.repos.projects.getMedia("voice")?.color).toBeUndefined();
  expect(updated.sort()).toEqual(["hlg", "sdr"]);

  await readMissingColors(ctx);
  expect(probed).toHaveLength(2);
});
