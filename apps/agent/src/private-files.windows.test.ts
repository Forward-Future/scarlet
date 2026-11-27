import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

// The Windows access-list script runs in PowerShell: the boundary is the child process.
const execFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile }));

import { privateDirectory, privateFile, windowsAclShell, writePrivateFile } from "./private-files.js";

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-private-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const mode = async (path: string) => (await stat(path)).mode & 0o777;

describe("windowsAclShell", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("runs the system's Windows PowerShell with only its own modules", () => {
    vi.stubEnv("SystemRoot", "D:\\Win");
    vi.stubEnv("PSModulePath", "C:\\Users\\me\\Documents\\PowerShell\\Modules");
    vi.stubEnv("psmodulepath", "C:\\elsewhere");
    vi.stubEnv("SCARLET_KEPT", "yes");
    const shell = windowsAclShell();
    const dir = join("D:\\Win", "System32", "WindowsPowerShell", "v1.0");
    expect(shell.executable).toBe(join(dir, "powershell.exe"));
    expect(shell.env.PSModulePath).toBe(join(dir, "Modules"));
    expect(Object.keys(shell.env).filter(key => key.toLowerCase() === "psmodulepath")).toEqual(["PSModulePath"]);
    expect(shell.env.SCARLET_KEPT).toBe("yes");
  });

  it("falls back to C:\\Windows when SystemRoot isn't set", () => {
    vi.stubEnv("SystemRoot", undefined);
    expect(windowsAclShell().executable).toBe(join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  });
});

describe.skipIf(process.platform === "win32")("privateFile", () => {
  it("closes an existing file and its folder to everyone but the owner", async () => {
    const dir = join(await tempDir(), "home");
    await mkdir(dir, { mode: 0o755 });
    await chmod(dir, 0o755);
    const file = join(dir, "agent.json");
    await writeFile(file, "x", { mode: 0o644 });
    await chmod(file, 0o644);
    await privateFile(file);
    expect(await mode(dir)).toBe(0o700);
    expect(await mode(file)).toBe(0o600);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("refuses a folder or a link where the file should be, and a missing file", async () => {
    const root = await tempDir();
    await mkdir(join(root, "folder"));
    await expect(privateFile(join(root, "folder"))).rejects.toThrow("Expected a private file");
    const target = join(root, "target");
    await writeFile(target, "x", { mode: 0o644 });
    await chmod(target, 0o644);
    await symlink(target, join(root, "link"));
    await expect(privateFile(join(root, "link"))).rejects.toThrow("Expected a private file");
    expect(await mode(target)).toBe(0o644);
    await expect(privateFile(join(root, "missing"))).rejects.toThrow(/ENOENT/);
  });
});

describe("on Windows", () => {
  const platform = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    execFile.mockReset();
    execFile.mockImplementation((_file: string, _args: string[], _options: object, done: (error: Error | null, result?: unknown) => void) =>
      done(null, { stdout: "", stderr: "" }));
  });
  afterEach(() => Object.defineProperty(process, "platform", { value: platform, configurable: true }));

  const call = (index = 0) => {
    const [file, args, options] = execFile.mock.calls[index]! as [string, string[], { windowsHide: boolean; env: Record<string, string> }];
    return { file, args, options, script: args.at(-1)! };
  };

  it("replaces a new folder's access list with one for the current user alone", async () => {
    const dir = join(await tempDir(), "home");
    await privateDirectory(dir);
    expect((await stat(dir)).isDirectory()).toBe(true);
    expect(execFile).toHaveBeenCalledTimes(1);
    const { file, args, options, script } = call();
    expect(file).toBe(windowsAclShell().executable);
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(options.windowsHide).toBe(true);
    expect(options.env.SCARLET_PRIVATE_DIRECTORY).toBe(dir);
    expect(options.env.SCARLET_PRIVATE_FILE).toBe("");
    expect(script).toContain("$ErrorActionPreference='Stop'");
    expect(script).toContain("[System.Security.AccessControl.DirectorySecurity]::new()");
    expect(script).toContain("$acl.SetAccessRuleProtection($true,$false)");
    expect(script).toContain("'ContainerInherit,ObjectInherit','None','Allow'");
    expect(script).toContain("[System.IO.Directory]::SetAccessControl($env:SCARLET_PRIVATE_DIRECTORY,$acl)");
    expect(script).not.toContain("FileSecurity");
  });

  it("gives a file its own access list beside its folder's, in the same process", async () => {
    const dir = await tempDir();
    const target = join(dir, "agent.json");
    await writeFile(target, "x");
    await privateFile(target);
    expect(execFile).toHaveBeenCalledTimes(1);
    const { options, script } = call();
    expect(options.env).toMatchObject({ SCARLET_PRIVATE_DIRECTORY: dir, SCARLET_PRIVATE_FILE: target });
    expect(script).toContain("[System.Security.AccessControl.FileSecurity]::new()");
    expect(script).toContain("[System.IO.File]::SetAccessControl($env:SCARLET_PRIVATE_FILE,$acl)");
    expect(script.indexOf("DirectorySecurity")).toBeLessThan(script.indexOf("FileSecurity"));
  });

  it("writes the file after closing its folder", async () => {
    const dir = join(await tempDir(), "home");
    await writePrivateFile(join(dir, "agent.json"), "secret");
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(call().options.env.SCARLET_PRIVATE_DIRECTORY).toBe(dir);
  });

  it("fails when the access list can't be set", async () => {
    execFile.mockImplementation((_file: string, _args: string[], _options: object, done: (error: Error | null) => void) => done(new Error("Access denied")));
    await expect(privateDirectory(join(await tempDir(), "home"))).rejects.toThrow("Access denied");
  });
});
