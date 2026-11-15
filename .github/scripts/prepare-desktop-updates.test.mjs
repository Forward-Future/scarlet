import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareDesktopUpdates, updatePlatforms } from "./prepare-desktop-updates.mjs";

test("verifies all four signed payloads and their versions before producing the public manifest", t => {
  const directory = mkdtempSync(join(tmpdir(), "scarlet-test-update-feed-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const key = join(directory, "test.key");
  const pub = key + ".pub";
  const run = args => execFileSync("minisign", args, { stdio: "ignore" });
  run(["-G", "-W", "-p", pub, "-s", key]);
  const version = "0.2.0";
  const repo = "Forward-Future/scarlet";
  const sign = (file, name, signedVersion) => {
    const detached = file + ".minisig";
    run(["-S", "-s", key, "-m", file, "-x", detached, "-t", `file:${name}\tversion:${signedVersion}`]);
    writeFileSync(file + ".sig", readFileSync(detached).toString("base64"));
  };
  const prepare = () => prepareDesktopUpdates(directory, version, repo, readFileSync(pub).toString("base64"));
  for (const suffix of Object.values(updatePlatforms)) {
    const name = `Scarlet-${version}-${suffix}`;
    writeFileSync(join(directory, name), name);
    sign(join(directory, name), name, version);
  }
  const msi = `Scarlet-${version}-Windows-x64.msi`;
  const path = join(directory, msi);
  sign(path, msi, "0.1.1");
  assert.throws(prepare, /does not name/);
  sign(path, msi, version);
  writeFileSync(path, "changed after signing");
  assert.throws(prepare);
  assert.equal(existsSync(join(directory, "latest.json")), false);
  writeFileSync(path, msi);
  const manifest = prepare();
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "latest.json"))), manifest);
  assert.equal(manifest.version, version);
  assert.match(manifest.notes, /# Changelog/);
  for (const [target, suffix] of Object.entries(updatePlatforms)) {
    assert.equal(manifest.platforms[target].url, `https://github.com/${repo}/releases/download/v${version}/Scarlet-${version}-${suffix}`);
    assert.ok(manifest.platforms[target].signature);
  }
  assert.ok(manifest.platforms["windows-x86_64-msi"].url.endsWith(".msi"));
  assert.ok(manifest.platforms["windows-x86_64-nsis"].url.endsWith("-Setup.exe"));
});
