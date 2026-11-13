// Run with: node --test apps/desktop/scripts/smoke-engine.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inspectPublicPayload } from "./smoke-engine-public.mjs";

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

for (const windows of [false, true]) {
  test(`checks the ${windows ? "Windows" : "macOS"} public payload for notices and external media tools`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "scarlet-package-test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const dir = windows ? join(root, "Scarlet") : join(root, "Scarlet.app", "Contents", "MacOS");
    const resources = windows ? dir : join(dir, "../Resources");
    const licenses = join(resources, "licenses");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(licenses, "runtime"), { recursive: true });
    writeFileSync(join(dir, windows ? "scarlet-engine.exe" : "scarlet-engine"), "engine");
    copyFileSync(new URL("../../../LICENSE", import.meta.url), join(licenses, "scarlet.txt"));
    for (const name of ["node.txt", "javascript.txt", "rust.txt"]) writeFileSync(join(licenses, "runtime", name), "notice");
    if (windows) {
      mkdirSync(join(licenses, "runtime/DirectML"));
      mkdirSync(join(licenses, "runtime/Vulkan-Headers"));
      for (const name of ["DirectML/LICENSE.txt", "DirectML/LICENSE-CODE.txt", "DirectML/ThirdPartyNotices.txt",
        "Vulkan-Headers/MIT.txt", "Vulkan-Headers/NOTICE.txt"]) {
        writeFileSync(join(licenses, "runtime", name), "notice");
      }
    } else {
      copyFileSync(new URL("./Install-Scarlet-FFmpeg-macOS.sh", import.meta.url), join(resources, "Install-Scarlet-FFmpeg-macOS.sh"));
    }
    // A Finder DMG has an Applications symlink. A check must never traverse a link into the host filesystem.
    const outside = mkdtempSync(join(tmpdir(), "scarlet-unrelated-"));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, "ffmpeg"), "outside this package");
    symlinkSync(outside, join(root, "Applications"), process.platform === "win32" ? "junction" : "dir");
    assert.equal(inspectPublicPayload(root, windows), dir);
    const unexpected = join(resources, windows ? "ffprobe.exe" : "ffmpeg");
    writeFileSync(unexpected, "binary");
    assert.throws(() => inspectPublicPayload(root, windows), /Unexpected media tool/);
    rmSync(unexpected);
    if (!windows) {
      const helper = join(resources, "Install-Scarlet-FFmpeg-macOS.sh");
      writeFileSync(helper, "unexpected helper");
      assert.throws(() => inspectPublicPayload(root, false), /helper differs/);
      copyFileSync(new URL("./Install-Scarlet-FFmpeg-macOS.sh", import.meta.url), helper);
    }
    writeFileSync(join(licenses, "scarlet.txt"), "wrong license");
    assert.throws(() => inspectPublicPayload(root, windows), /license differs/);
  });
}
