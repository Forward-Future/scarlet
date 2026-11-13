// Run with: node --test apps/desktop/scripts/smoke-engine.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./smoke-engine.mjs", import.meta.url));
const exe = process.platform === "win32" ? ".exe" : "";

/** Every file under `root`, relative to it. */
function filesUnder(root) {
  return existsSync(root) ? readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => join(e.parentPath, e.name)) : [];
}

/** Run the smoke script with its own temp folder and home, so what it leaves behind can be counted. */
function smoke(t, bundle) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "scarlet-smoke-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const [temp, home] = [join(root, "tmp"), join(root, "home")];
  for (const dir of [temp, home, join(root, "bundle")]) mkdirSync(dir);
  for (const name of bundle) writeFileSync(join(root, "bundle", name + exe), "");
  const { CI: _, XDG_CACHE_HOME: __, ...env } = process.env;
  const run = spawnSync(process.execPath, [script, join(root, "bundle")], {
    encoding: "utf8",
    env: { ...env, TMPDIR: temp, TEMP: temp, TMP: temp, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, "local") },
  });
  return { run, temp, home };
}

test("a failed check exits 1 with one FAILED line, and leaves no temp folder or storage registration", { skip: process.platform === "win32" }, (t) => {
  // Everything the script looks for first is there. The speaker runtime, the first check inside its work folder, is not.
  const { run, temp, home } = smoke(t, ["scarlet-engine", "ffmpeg", "ffprobe", "whisper-cli"]);
  assert.equal(run.status, 1);
  assert.equal(run.stderr, "[smoke] FAILED: speaker runtime unavailable\n");
  assert.equal(run.stdout, "");
  assert.deepEqual(readdirSync(temp), []);
  assert.deepEqual(filesUnder(home), []);
});

test("a bundle with a file missing fails before anything is created", (t) => {
  const { run, temp, home } = smoke(t, ["scarlet-engine", "ffmpeg"]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^\[smoke\] FAILED: missing .*ffprobe(\.exe)?\n$/);
  assert.deepEqual(readdirSync(temp), []);
  assert.deepEqual(filesUnder(home), []);
});
