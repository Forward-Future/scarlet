import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fileInDirectory, fileInDirectoryAsync } from "./assetPath.js";

// The temporary folder in its full spelling: on Windows it can be given with a short name (RUNNER~1), which one
// lookup expands and the other leaves.
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "scarlet-asset-")));
const media = join(root, "media");
mkdirSync(join(media, "folder"), { recursive: true });
writeFileSync(join(media, "clip.mp4"), "x");
writeFileSync(join(root, "outside.mp4"), "x");
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("fileInDirectory", () => {
  // The engine's request handlers use the one that doesn't block. Both must answer the same.
  it.each(["clip.mp4", "../outside.mp4", "missing.mp4", "folder", "", join(root, "outside.mp4")])("answers the same with and without blocking for %j", async name => {
    expect(await fileInDirectoryAsync(media, name)).toBe(fileInDirectory(media, name));
  });

  it("returns a file inside the directory and nothing for a path that leaves it", async () => {
    expect(await fileInDirectoryAsync(media, "clip.mp4")).toMatch(/clip\.mp4$/);
    expect(await fileInDirectoryAsync(media, "../outside.mp4")).toBeUndefined();
    expect(await fileInDirectoryAsync(media, "folder")).toBeUndefined();
    expect(await fileInDirectoryAsync(media, "missing.mp4")).toBeUndefined();
  });
});
