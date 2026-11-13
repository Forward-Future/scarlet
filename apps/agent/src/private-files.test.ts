import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { privateDirectory, writePrivateFile } from "./private-files.js";

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-private-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const mode = async (path: string) => (await stat(path)).mode & 0o777;

// Windows replaces the folder's access list instead; its modes say nothing.
describe.skipIf(process.platform === "win32")("private files", () => {
  it("makes a folder, with any missing parents, that only its owner can open", async () => {
    const root = await tempDir();
    const dir = join(root, "a", "b");
    await privateDirectory(dir);
    expect(await mode(dir)).toBe(0o700);
    // Again is fine, and a file inside is left alone.
    await writeFile(join(dir, "kept"), "x");
    await privateDirectory(dir);
    expect(await readdir(dir)).toEqual(["kept"]);
  });

  it("closes a folder that was open to others", async () => {
    const dir = join(await tempDir(), "shared");
    await mkdir(dir, { mode: 0o755 });
    await chmod(dir, 0o777);
    await privateDirectory(dir);
    expect(await mode(dir)).toBe(0o700);
  });

  it("refuses a file or a link where the folder should be, and leaves the link's target as it was", async () => {
    const root = await tempDir();
    await writeFile(join(root, "file"), "x");
    await expect(privateDirectory(join(root, "file"))).rejects.toThrow(/EEXIST/);
    const target = join(root, "elsewhere");
    await mkdir(target, { mode: 0o755 });
    await chmod(target, 0o755);
    await symlink(target, join(root, "link"));
    await expect(privateDirectory(join(root, "link"))).rejects.toThrow("Expected a private directory");
    expect(await mode(target)).toBe(0o755);
  });

  it("writes a file only its owner can read, in a private folder, leaving no temporary file", async () => {
    const dir = join(await tempDir(), "home");
    await writePrivateFile(join(dir, "agent.json"), '{"token":"t"}\n');
    expect(await readFile(join(dir, "agent.json"), "utf8")).toBe('{"token":"t"}\n');
    expect(await mode(join(dir, "agent.json"))).toBe(0o600);
    expect(await mode(dir)).toBe(0o700);
    expect(await readdir(dir)).toEqual(["agent.json"]);
  });

  it("replaces an older file that others could read, without ever widening the new one", async () => {
    const dir = await tempDir();
    const file = join(dir, "agent.json");
    await writeFile(file, "old", { mode: 0o644 });
    await chmod(file, 0o644);
    await writePrivateFile(file, "new");
    expect(await readFile(file, "utf8")).toBe("new");
    expect(await mode(file)).toBe(0o600);
  });

  it("cleans up its temporary file when the write can't land", async () => {
    const dir = await tempDir();
    // A folder already has the name: the rename fails.
    await mkdir(join(dir, "agent.json"));
    await expect(writePrivateFile(join(dir, "agent.json"), "new")).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["agent.json"]);
  });
});
