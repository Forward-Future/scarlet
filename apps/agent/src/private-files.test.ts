import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";
import { privateDirectory, windowsAclShell, writePrivateFile } from "./private-files.js";

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-private-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const windows = process.platform === "win32";
const run = promisify(execFile);

/**
 * Who can open a path: its permission bits on POSIX. On Windows, where modes say nothing, each rule on its access list by
 * account, rights and kind, then "protected" when the list takes nothing from the folder above it.
 */
async function access(path: string): Promise<string[]> {
  if (!windows) return [((await stat(path)).mode & 0o777).toString(8).padStart(4, "0")];
  const script = [
    "$ErrorActionPreference='Stop'",
    "$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$acl=(Get-Item -LiteralPath $env:SCARLET_CHECKED_PATH -Force).GetAccessControl()",
    "$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {" +
      " $who = if ($_.IdentityReference -eq $me) { 'current-user' } else { $_.IdentityReference.Value };" +
      " $who + ':' + $_.FileSystemRights + ':' + $_.AccessControlType }",
    "if ($acl.AreAccessRulesProtected) { 'protected' }",
  ].join(";");
  const shell = windowsAclShell();
  const { stdout } = await run(shell.executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, env: { ...shell.env, SCARLET_CHECKED_PATH: path },
  });
  return stdout.split(/\r?\n/).filter(Boolean);
}

// A private folder is its owner's alone and doesn't take what its parent grants; a file in it takes the folder's rule.
const PRIVATE_FOLDER = windows ? ["current-user:FullControl:Allow", "protected"] : ["0700"];
const PRIVATE_FILE = windows ? ["current-user:FullControl:Allow"] : ["0600"];

/** Lets everyone in: open bits on POSIX, and on Windows an explicit rule for Everyone that a folder passes down. */
async function openToOthers(path: string, kind: "folder" | "file"): Promise<void> {
  if (!windows) return chmod(path, kind === "folder" ? 0o777 : 0o644);
  await run("icacls", [path, "/grant", `*S-1-1-0:${kind === "folder" ? "(OI)(CI)RX" : "R"}`], { windowsHide: true });
}

describe("private files", () => {
  it("makes a folder, with any missing parents, that only its owner can open", async () => {
    const root = await tempDir();
    const dir = join(root, "a", "b");
    await privateDirectory(dir);
    expect(await access(dir)).toEqual(PRIVATE_FOLDER);
    // Again is fine, and a file inside is left alone.
    await writeFile(join(dir, "kept"), "x");
    await privateDirectory(dir);
    expect(await readdir(dir)).toEqual(["kept"]);
  });

  it("closes a folder that was open to others", async () => {
    const dir = join(await tempDir(), "shared");
    await mkdir(dir, { mode: 0o755 });
    await openToOthers(dir, "folder");
    expect(await access(dir)).not.toEqual(PRIVATE_FOLDER);
    await privateDirectory(dir);
    expect(await access(dir)).toEqual(PRIVATE_FOLDER);
  });

  it("refuses a file or a link where the folder should be, and leaves the link's target as it was", async () => {
    const root = await tempDir();
    await writeFile(join(root, "file"), "x");
    await expect(privateDirectory(join(root, "file"))).rejects.toThrow(/EEXIST/);
    const target = join(root, "elsewhere");
    await mkdir(target, { mode: 0o755 });
    await openToOthers(target, "folder");
    const before = await access(target);
    // A junction is the folder link Windows lets anyone make.
    await symlink(target, join(root, "link"), windows ? "junction" : "dir");
    await expect(privateDirectory(join(root, "link"))).rejects.toThrow("Expected a private directory");
    expect(await access(target)).toEqual(before);
  });

  it("writes a file only its owner can read, in a private folder, leaving no temporary file", async () => {
    const dir = join(await tempDir(), "home");
    await writePrivateFile(join(dir, "agent.json"), '{"token":"t"}\n');
    expect(await readFile(join(dir, "agent.json"), "utf8")).toBe('{"token":"t"}\n');
    expect(await access(join(dir, "agent.json"))).toEqual(PRIVATE_FILE);
    expect(await access(dir)).toEqual(PRIVATE_FOLDER);
    expect(await readdir(dir)).toEqual(["agent.json"]);
  });

  it("replaces an older file that others could read, without ever widening the new one", async () => {
    const dir = await tempDir();
    const file = join(dir, "agent.json");
    await writeFile(file, "old", { mode: 0o644 });
    await openToOthers(file, "file");
    expect(await access(file)).not.toEqual(PRIVATE_FILE);
    await writePrivateFile(file, "new");
    expect(await readFile(file, "utf8")).toBe("new");
    expect(await access(file)).toEqual(PRIVATE_FILE);
  });

  it("cleans up its temporary file when the write can't land", async () => {
    const dir = await tempDir();
    // A folder already has the name: the rename fails.
    await mkdir(join(dir, "agent.json"));
    await expect(writePrivateFile(join(dir, "agent.json"), "new")).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["agent.json"]);
  });
});
