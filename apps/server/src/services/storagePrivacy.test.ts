import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Ctx } from "../context.js";
import { openDb } from "../db.js";
import { Paths } from "../paths.js";
import { createApp } from "../app.js";
import { sweepLeftovers } from "./leftovers.js";
import { seedSkills } from "./skills.js";

let sandbox: string;
beforeEach(() => { sandbox = mkdtempSync(join(tmpdir(), "scarlet-storage-privacy-")); });
afterEach(() => { rmSync(sandbox, { recursive: true, force: true }); });

function windowsFixture(path: string, command: string) {
  return execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true, env: { ...process.env, SCARLET_TEST_LIBRARY: path } }).trim();
}

function windowsAccessFailure(paths: Paths) {
  try { paths.ensureRoot(); } catch (error) {
    // execFileSync's message includes the whole PowerShell source, including error messages for branches it never took.
    return (error as { stderr?: Buffer }).stderr?.toString().trimStart();
  }
}

it.skipIf(process.platform === "win32")("protects new and existing library contents through their root", () => {
  const paths = new Paths(join(sandbox, "library"));
  paths.ensureRoot();
  expect(statSync(paths.root).mode & 0o777).toBe(0o700);
  openDb(paths.db).close();
  chmodSync(paths.root, 0o755);
  paths.ensureRoot();
  expect(statSync(paths.root).mode & 0o777).toBe(0o700);
});

it("preserves unrelated files and permissions when --data points to a populated shared folder", () => {
  const paths = new Paths(join(sandbox, "other-data"));
  mkdirSync(paths.root);
  openDb(paths.db).close();
  writeFileSync(join(paths.root, "unrelated.txt"), "fixture");
  if (process.platform !== "win32") chmodSync(paths.root, 0o755);
  expect(() => paths.ensureRoot()).toThrow(/Choose an empty directory or an existing Scarlet library/);
  if (process.platform !== "win32") expect(statSync(paths.root).mode & 0o777).toBe(0o755);
  expect(existsSync(paths.tmp)).toBe(false);
});

it.runIf(process.platform === "win32")("applies owner-only library access to existing and new files", () => {
  const paths = new Paths(join(sandbox, "library"));
  mkdirSync(paths.root);
  mkdirSync(paths.tmp);
  mkdirSync(paths.skills);
  openDb(paths.db).close();
  writeFileSync(join(paths.root, "existing.txt"), "fixture");
  // Elevated Windows runners can give files to Administrators by default. Model an editor-owned library with
  // the original inherited grants intact, so ensureRoot still has to secure existing files and future children.
  windowsFixture(paths.root, [
    "$ErrorActionPreference='Stop'",
    "$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    "foreach ($entry in (Get-ChildItem -LiteralPath $env:SCARLET_TEST_LIBRARY -Force -Recurse)) {",
    "  $acl=$entry.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Owner)",
    "  $acl.SetOwner($user)",
    "  $entry.SetAccessControl($acl)",
    "}",
  ].join("\n"));
  paths.ensureRoot();
  writeFileSync(join(paths.tmp, "new.txt"), "fixture");
  const check = [
    "$ErrorActionPreference='Stop'",
    "$id=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$root=$env:SCARLET_TEST_LIBRARY",
    "if (!(Get-Acl -LiteralPath $root).AreAccessRulesProtected) { throw 'Library grants are inherited' }",
    "foreach ($p in @($root, (Join-Path $root 'existing.txt'), (Join-Path $root 'tmp/new.txt'))) {",
    "  $rules=(Get-Acl -LiteralPath $p).GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])",
    "  if ($rules.Count -ne 1 -or $rules[0].IdentityReference -ne $id) { throw 'Unexpected principal' }",
    "}",
  ].join("\n");
  windowsFixture(paths.root, check);
  // The runner can also give the newly created file to Administrators. Its inherited grants have been checked.
  rmSync(join(paths.tmp, "new.txt"));

  // A protected child keeps its explicit grant when its parent permissions change.
  windowsFixture(paths.root, [
    "$ErrorActionPreference='Stop'",
    "$file=Join-Path $env:SCARLET_TEST_LIBRARY 'existing.txt'",
    "$acl=[System.IO.File]::GetAccessControl($file)",
    "$acl.SetAccessRuleProtection($true,$true)",
    "$everyone=[System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')",
    "$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($everyone,'Read','Allow'))",
    "[System.IO.File]::SetAccessControl($file,$acl)",
  ].join(";"));
  expect(windowsAccessFailure(paths)).toMatch(/^The Scarlet library still grants access to another account/);
});

it.runIf(process.platform === "win32")("refuses an existing database owned by another principal", ({ skip }) => {
  const paths = new Paths(join(sandbox, "library"));
  // An ordinary user cannot assign an arbitrary owner. Windows CI runs elevated and exercises this case.
  const admin = windowsFixture(paths.root, [
    "$principal=[System.Security.Principal.WindowsPrincipal]::new([System.Security.Principal.WindowsIdentity]::GetCurrent())",
    "$principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)",
  ].join("\n"));
  if (admin !== "True") return skip();
  mkdirSync(paths.root);
  openDb(paths.db).close();
  windowsFixture(paths.root, [
    "$ErrorActionPreference='Stop'",
    "$file=Join-Path $env:SCARLET_TEST_LIBRARY 'scarlet.db'",
    "$acl=[System.IO.File]::GetAccessControl($file,[System.Security.AccessControl.AccessControlSections]::Owner)",
    "$acl.SetOwner([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))",
    "[System.IO.File]::SetAccessControl($file,$acl)",
  ].join("\n"));
  expect(windowsAccessFailure(paths)).toMatch(/^A Scarlet library item belongs to another account/);
});

it.skipIf(process.platform === "win32")("sweeps ordinary temporary files and skips linked storage directories", () => {
  const paths = new Paths(join(sandbox, "library"));
  paths.ensureRoot();
  paths.ensureProject("prj_sample");
  const outside = join(sandbox, "outside");
  mkdirSync(outside);
  const kept = join(outside, "old.part.mp4");
  writeFileSync(kept, "fixture");
  const uuid = "01234567-89ab-4cde-8012-3456789abcde";
  const working = ["recording_0123456789ab.wav", "chunk_0123456789ab.wav", "speech_0123456789ab.webm",
    "wcpp_0123456789ab.wav", "wcpp_0123456789ab.json", `${uuid}.wav`, `recording-${uuid}.wav`];
  const unrelated = ["my-recording.wav", "recording_backup.wav", "first-draft.json"];
  for (const name of [...working, ...unrelated]) writeFileSync(join(paths.tmp, name), "fixture");
  rmSync(paths.proxies("prj_sample"), { recursive: true });
  symlinkSync(outside, paths.proxies("prj_sample"), "dir");
  const ctx = { paths, db: { prepare: () => ({ get: () => undefined }) }, log: () => {} } as unknown as Ctx;
  const later = Date.now() + 2 * 86_400_000;
  expect(sweepLeftovers(ctx, later)).toBe(working.length);
  for (const name of working) expect(existsSync(join(paths.tmp, name))).toBe(false);
  for (const name of unrelated) expect(existsSync(join(paths.tmp, name))).toBe(true);
  expect(existsSync(kept)).toBe(true);
  rmSync(paths.tmp, { recursive: true });
  symlinkSync(outside, paths.tmp, "dir");
  writeFileSync(join(outside, working[0]!), "fixture");
  expect(sweepLeftovers(ctx, later)).toBe(0);
  expect(existsSync(kept)).toBe(true);
  expect(existsSync(join(outside, working[0]!))).toBe(true);
  expect(() => paths.ensureRoot()).toThrow();
});

it("seeds regular skill files and skips symbolic and hard links", async () => {
  const seed = join(sandbox, "seed");
  const outside = join(sandbox, "other.txt");
  mkdirSync(join(seed, "ordinary"), { recursive: true });
  mkdirSync(join(seed, "linked"));
  mkdirSync(join(seed, "hardlinked"));
  writeFileSync(join(seed, "ordinary", "SKILL.md"), "Fixture instructions");
  writeFileSync(outside, "Separate fixture");
  if (process.platform !== "win32") symlinkSync(outside, join(seed, "linked", "SKILL.md"));
  linkSync(outside, join(seed, "hardlinked", "SKILL.md"));
  const app = createApp({ dataDir: join(sandbox, "library"), skillsSeedDir: join(sandbox, "empty"), env: {}, log: () => {} });
  try {
    expect(seedSkills(app.ctx, seed)).toBe(1);
    expect(app.ctx.repos.skills.select().map(skill => skill.content)).toEqual(["Fixture instructions"]);
  } finally { await app.ctx.close(); }
});
