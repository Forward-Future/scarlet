import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appSupportDir, REPO_ROOT } from "../src/paths.ts";
import { assemblyOps, checkLibraryDir, findRecording, recordings } from "../src/store.ts";

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function store(folders: Record<string, string[]>) {
  const root = mkdtempSync(join(tmpdir(), "eval-videos-"));
  made.push(root);
  for (const [name, files] of Object.entries(folders)) {
    mkdirSync(join(root, name));
    for (const f of files) writeFileSync(join(root, name, f), "");
  }
  return root;
}

describe("eval video store", () => {
  it("reads each recording's raw files and published video by name, and leaves other files out", () => {
    const root = store({
      "2026-11-19 Neon review": ["raw camera.mp4", "raw screen.mov", "published.mp4", "notes.txt", "thumb.png"],
      "2026-11-06 12 months": ["raw camera.mp4", "raw camera 2.mp4"],
      "empty": ["README.txt"],
    });
    const all = recordings(root);
    expect(all.map(r => r.name)).toEqual(["2026-11-06 12 months", "2026-11-19 Neon review"]);
    expect(all[0]!.files.map(f => [f.name, f.role])).toEqual([["raw camera 2.mp4", "camera"], ["raw camera.mp4", "camera"]]);
    expect(all[1]!.files.map(f => f.role).sort()).toEqual(["camera", "published", "screen"]);
  });

  it("finds a recording by its whole name or a part only it has", () => {
    const root = store({ "2026-11-19 Neon review": ["raw camera.mp4"], "2026-11-19 Ant crash out": ["raw camera.mp4"] });
    expect(findRecording("neon", root).name).toBe("2026-11-19 Neon review");
    expect(() => findRecording("2026-11-19", root)).toThrow(/name one/);
    expect(() => findRecording("astra", root)).toThrow(/No recording "astra"/);
  });

  it("never builds an eval library inside the editor's own Scarlet or the repository", () => {
    expect(() => checkLibraryDir(join(appSupportDir(), "evals", "lib"))).toThrow(/editor's own Scarlet/);
    expect(() => checkLibraryDir(join(REPO_ROOT, "tmp-lib"))).toThrow(/inside the repository/);
    expect(() => checkLibraryDir(join(tmpdir(), "eval-lib"))).not.toThrow();
  });

  it("assembles the camera with its sound, over the screen as an inset when there is one", () => {
    const camera = { id: "med_cam", name: "raw camera.mp4", role: "camera" as const, duration: 100 };
    const screen = { id: "med_scr", name: "raw screen.mp4", role: "screen" as const, duration: 98 };
    const alone = assemblyOps([camera]);
    expect(alone.ops).toHaveLength(1);
    expect(alone.ops[0]).toMatchObject({ op: "addClip", trackId: "v1", clip: { mediaId: "med_cam", sourceOut: 100, volume: 1 } });
    const both = assemblyOps([screen, camera]);
    expect(both.ops.map(o => o.op)).toEqual(["addClip", "addTrack", "addClip"]);
    expect(both.ops[0]).toMatchObject({ trackId: "v1", clip: { mediaId: "med_scr", volume: 0 } });
    expect(both.ops[2]).toMatchObject({ trackId: "v2", clip: { mediaId: "med_cam", volume: 1, transform: { scale: 0.25 } } });
    expect(() => assemblyOps([screen])).toThrow(/needs a camera/);
  });
});
