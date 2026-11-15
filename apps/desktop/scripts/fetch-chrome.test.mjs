import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUILDS, CHROME_VERSION, chromeExecutable, installedChrome } from "./fetch-chrome.mjs";

test("pins one headless shell build for every desktop target", () => {
  assert.deepEqual(Object.keys(BUILDS).sort(), ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"]);
  for (const { sha256 } of Object.values(BUILDS)) assert.match(sha256, /^[0-9a-f]{64}$/);
  assert.equal(chromeExecutable("x86_64-pc-windows-msvc"), "chrome-headless-shell.exe");
  assert.equal(chromeExecutable("aarch64-apple-darwin"), "chrome-headless-shell");
});

test("a fetched folder counts only for its own target and pinned archive, and survives re-signing", t => {
  const root = mkdtempSync(join(tmpdir(), "scarlet-chrome-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, "chrome-headless-shell");
  const receipt = join(root, ".pinned-chrome.json");
  const target = "aarch64-apple-darwin";
  mkdirSync(folder);
  // build.rs leaves a note where nothing was fetched.
  writeFileSync(join(folder, "README.txt"), "fetch me");
  assert.equal(installedChrome(target, folder, receipt), false);
  writeFileSync(join(folder, "LICENSE.headless_shell"), "credits");
  writeFileSync(join(folder, "chrome-headless-shell"), "");
  truncateSync(join(folder, "chrome-headless-shell"), 2 * 1024 * 1024);
  const pin = (fields = {}) => writeFileSync(receipt, JSON.stringify({ target, version: CHROME_VERSION, archive: BUILDS[target].sha256, ...fields }));
  assert.equal(installedChrome(target, folder, receipt), false);
  pin();
  assert.equal(installedChrome(target, folder, receipt), true);
  // Signing the executable changes its bytes, not what was fetched.
  writeFileSync(join(folder, "chrome-headless-shell"), Buffer.alloc(3 * 1024 * 1024, 1));
  assert.equal(installedChrome(target, folder, receipt), true);
  assert.equal(installedChrome("x86_64-apple-darwin", folder, receipt), false);
  pin({ archive: "0".repeat(64) });
  assert.equal(installedChrome(target, folder, receipt), false);
  pin({ version: "1.0.0.0" });
  assert.equal(installedChrome(target, folder, receipt), false);
  pin();
  rmSync(join(folder, "LICENSE.headless_shell"));
  assert.equal(installedChrome(target, folder, receipt), false);
});
