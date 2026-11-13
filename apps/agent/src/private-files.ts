// Private from the first byte, including when replacing an older, more permissive file.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

/** OS-only ACL scripts run in Windows PowerShell, regardless of the launching shell's module paths. */
export function windowsAclShell() {
  const dir = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0");
  const env = { ...process.env };
  // Node passes only the first case-insensitive match when a Windows environment has duplicate keys.
  for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
  env.PSModulePath = join(dir, "Modules");
  return { executable: join(dir, "powershell.exe"), env };
}

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) throw new Error("Expected a private directory");
  if (process.platform !== "win32") return chmod(path, 0o700);
  // Replace the DACL instead of retaining explicit grants or inheriting from a shared parent.
  const script = [
    "$ErrorActionPreference='Stop'",
    "$id=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$acl=[System.Security.AccessControl.DirectorySecurity]::new()",
    "$acl.SetOwner($id)",
    "$acl.SetAccessRuleProtection($true,$false)",
    "$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($id,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))",
    "[System.IO.Directory]::SetAccessControl($env:SCARLET_PRIVATE_DIRECTORY,$acl)",
  ].join(";");
  const shell = windowsAclShell();
  await promisify(execFile)(shell.executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, env: { ...shell.env, SCARLET_PRIVATE_DIRECTORY: path },
  });
}

export async function writePrivateFile(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  await privateDirectory(dir);
  const temp = join(dir, `.private-${randomUUID()}`);
  try {
    await writeFile(temp, content, { flag: "wx", mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
