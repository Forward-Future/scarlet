import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const script = "apps/desktop/scripts/release-version.mjs";
const fields = [
  "package.json", "apps/agent/package.json", "apps/desktop/package.json", "apps/server/package.json",
  "apps/web/package.json", "packages/mcp/package.json", "packages/render/package.json",
  "packages/shared/package.json", "packages/timeline/package.json", "apps/desktop/src-tauri/tauri.conf.json",
  "apps/desktop/src-tauri/Cargo.toml", "apps/desktop/src-tauri/Cargo.lock",
  "apps/server/src/telemetry/config.ts", "apps/agent/src/modelCatalog.ts", "packages/mcp/src/server.ts",
];

function command(directory, ...args) {
  return spawnSync(process.execPath, [join(directory, script), ...args], { encoding: "utf8" });
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "scarlet-release-version-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const file of [script, ...fields]) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    copyFileSync(join(root, file), join(directory, file));
  }
  return directory;
}

test("all shipped versions agree with the root manifest and its stable release tag", () => {
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  for (const args of [[], ["--tag", "v" + version]]) {
    const result = command(root, "check", ...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), version);
  }
});

test("a bump updates just Scarlet's version in each file, preserves CRLF and can be repeated", t => {
  const directory = fixture(t);
  const original = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version;
  const target = original === "1.2.3" ? "1.2.4" : "1.2.3";
  const lock = join(directory, "apps/desktop/src-tauri/Cargo.lock");
  // A dependency that happens to have the same version must be left alone.
  writeFileSync(lock, readFileSync(lock, "utf8") + '\n[[package]]\nname = "unrelated"\nversion = "' + original + '"\n');
  const before = new Map();
  for (const file of fields) {
    const path = join(directory, file);
    const crlf = readFileSync(path, "utf8").replace(/\r?\n/g, "\r\n");
    writeFileSync(path, crlf);
    before.set(file, crlf);
  }

  for (const mode of ["set", "set", "check"]) {
    const result = command(directory, mode, ...(mode === "set" ? [target] : []), "--tag", "v" + target);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), target);
  }
  for (const file of fields) {
    const after = readFileSync(join(directory, file), "utf8");
    const start = before.get(file);
    const firstDifference = [...start].findIndex((char, i) => char !== after[i]);
    assert.notEqual(firstDifference, -1, file);
    const versionStart = start.lastIndexOf(original, firstDifference);
    assert.notEqual(versionStart, -1, file);
    assert.equal(after, start.slice(0, versionStart) + target + start.slice(versionStart + original.length), file);
  }
});

test("check reports drift and an explicit set repairs it", t => {
  const directory = fixture(t);
  const version = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version;
  const path = join(directory, "apps/desktop/src-tauri/tauri.conf.json");
  writeFileSync(path, readFileSync(path, "utf8").replace('"version": "' + version + '"', '"version": "90.91.92"'));
  const result = command(directory, "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tauri\.conf\.json.*found 90\.91\.92/);
  assert.equal(command(directory, "set", version).status, 0);
  assert.equal(command(directory, "check").status, 0);
});

test("invalid or mismatched tags, malformed versions and moved fields fail before any file changes", t => {
  const directory = fixture(t);
  const rootFile = join(directory, "package.json");
  const before = readFileSync(rootFile, "utf8");
  for (const args of [
    ["set", "01.2.3"], ["set", "1.2.3-beta.1"], ["set", "v1.2.3"], ["set", "1.2"],
    ["set", "1.2.3", "--tag", "v1.2.4"], ["set", "1.2.3", "--tag", "v1.2.3-early-access."],
    ["set", "1.2.3", "--tag", "v1.2.3-early-access.1"], ["set", "1.2.3", "--tag"],
  ]) {
    assert.equal(command(directory, ...args).status, 1, args.join(" "));
    assert.equal(readFileSync(rootFile, "utf8"), before);
  }
  writeFileSync(join(directory, "packages/mcp/src/server.ts"), "No server version here.\n");
  const result = command(directory, "set", "1.2.3");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /packages\/mcp\/src\/server.ts: expected one Scarlet version field/);
  assert.equal(readFileSync(rootFile, "utf8"), before);
});

function git(directory, ...args) {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=release-test@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=", ...args], {
    cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function versionRepository(t) {
  const directory = fixture(t);
  git(directory, "init", "-b", "main");
  writeFileSync(join(directory, "package.json"), '{\n  "name": "release-test",\n  "version": "0.1.4"\n}\n');
  git(directory, "add", "package.json", script);
  git(directory, "commit", "-m", "Start stable releases at 0.1.4");
  return directory;
}

function expectCommitVersion(directory, expected) {
  const result = command(directory, "for-commit");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), expected);
}

test("releases are repeatable per first-parent commit, including empty commits and merges", t => {
  const directory = versionRepository(t);
  expectCommitVersion(directory, "0.1.4");
  git(directory, "commit", "--allow-empty", "-m", "First follow-up");
  const replay = git(directory, "rev-parse", "HEAD");
  expectCommitVersion(directory, "0.1.5");

  const path = join(directory, "package.json");
  writeFileSync(path, readFileSync(path, "utf8").replace("release-test", "renamed"));
  git(directory, "commit", "-am", "Change package metadata without a version bump");
  expectCommitVersion(directory, "0.1.6");
  git(directory, "switch", "-c", "feature");
  git(directory, "commit", "--allow-empty", "-m", "First feature commit");
  git(directory, "commit", "--allow-empty", "-m", "Second feature commit");
  git(directory, "switch", "main");
  git(directory, "merge", "--no-ff", "-m", "Merge feature", "feature");
  expectCommitVersion(directory, "0.1.7");

  writeFileSync(path, readFileSync(path, "utf8").replace("0.1.4", "0.2.0"));
  git(directory, "commit", "-am", "Raise the baseline");
  expectCommitVersion(directory, "0.2.0");
  git(directory, "commit", "--allow-empty", "-m", "After the bump");
  expectCommitVersion(directory, "0.2.1");
  git(directory, "switch", "--detach", replay);
  expectCommitVersion(directory, "0.1.5");
  expectCommitVersion(directory, "0.1.5");
});

test("the first automated release starts at its baseline after a previously unnumbered history", t => {
  const directory = fixture(t);
  const path = join(directory, "package.json");
  git(directory, "init", "-b", "main");
  writeFileSync(path, '{\n  "version": "0.1.0"\n}\n');
  git(directory, "add", "package.json");
  git(directory, "commit", "-m", "Initial sources");
  for (let commit = 0; commit < 5; commit++) git(directory, "commit", "--allow-empty", "-m", "Before release numbering");
  writeFileSync(path, '{\n  "version": "0.1.4"\n}\n');
  git(directory, "add", script, "package.json");
  git(directory, "commit", "-m", "Start stable releases");
  expectCommitVersion(directory, "0.1.4");
});

test("new baselines must exceed the last assigned version, even when the old manifest stayed lower", t => {
  const directory = versionRepository(t);
  const path = join(directory, "package.json");
  git(directory, "commit", "--allow-empty", "-m", "Released at 0.1.5");
  git(directory, "commit", "--allow-empty", "-m", "Released at 0.1.6");
  for (const proposed of ["0.1.6", "0.1.5"]) {
    writeFileSync(path, readFileSync(path, "utf8").replace("0.1.4", proposed));
    git(directory, "commit", "-am", "Try a non-increasing baseline");
    const result = command(directory, "for-commit");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be newer than 0\.1\.6/);
    git(directory, "reset", "--hard", "HEAD^");
  }
});

test("a second baseline fix cannot reuse a number assigned before a bad baseline", t => {
  const directory = versionRepository(t);
  const path = join(directory, "package.json");
  git(directory, "commit", "--allow-empty", "-m", "Previously released 0.1.5");
  git(directory, "commit", "--allow-empty", "-m", "Previously released 0.1.6");
  for (const [old, next, works] of [["0.1.4", "0.1.1", false], ["0.1.1", "0.1.3", false], ["0.1.3", "0.1.7", true]]) {
    writeFileSync(path, readFileSync(path, "utf8").replace(old, next));
    git(directory, "commit", "-am", "Set baseline " + next);
    const result = command(directory, "for-commit");
    assert.equal(result.status, works ? 0 : 1, result.stderr);
    if (works) assert.equal(result.stdout.trim(), next);
    else assert.match(result.stderr, /must be newer than 0\.1\.6/);
  }
});

test("a shallow clone cannot silently number from incomplete history", t => {
  const directory = versionRepository(t);
  git(directory, "commit", "--allow-empty", "-m", "Newest");
  const shallow = join(directory, "shallow");
  git(directory, "clone", "--depth=1", pathToFileURL(directory).href, shallow);
  const result = command(shallow, "for-commit");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /full first-parent history/);
});
