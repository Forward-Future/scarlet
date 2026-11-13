import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { verifyDesktopPackage } from "./verify-desktop-package.mjs";

// Stub native metadata readers on POSIX. The Desktop workflow checks the actual
// disk images, PE resources and MSI databases on the native runners.
function fixture(t, target) {
  const root = mkdtempSync(join(tmpdir(), "scarlet-package-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = join(root, "tools");
  const release = join(root, "target", target, "release");
  function file(path, content = "0.1.4") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  mkdirSync(tools);
  const previousPath = process.env.PATH;
  process.env.PATH = tools + delimiter + previousPath;
  t.after(() => { process.env.PATH = previousPath; });
  function tool(name, shell) {
    writeFileSync(join(tools, name), "#!/bin/sh\nset -eu\n" + shell, { mode: 0o700 });
  }
  file(join(root, "tauri.conf.json"), JSON.stringify({ productName: "Scarlet" }));
  return { root, release, dest: join(root, "assets"), file, tool };
}

for (const [target, dmgArch, arch, name] of [
  ["aarch64-apple-darwin", "aarch64", "arm64", "Apple-Silicon"],
  ["x86_64-apple-darwin", "x64", "x86_64", "Intel"],
]) {
  test(`verifies the version and CPU inside the distributed ${name} disk image`, { skip: process.platform === "win32" }, t => {
    const { root, release, dest, file, tool } = fixture(t, target);
    const dmg = join(release, "bundle/dmg", `Scarlet_0.1.4_${dmgArch}.dmg`);
    file(dmg);
    tool("hdiutil", 'if [ "$1" = attach ]; then mkdir -p "$6/Scarlet.app/Contents/MacOS"; cp "$7" "$6/Scarlet.app/Contents/Info.plist"; else rm -r "$2/Scarlet.app"; fi');
    tool("plutil", 'cat "$6"');
    tool("lipo", `echo ${arch}`);
    verifyDesktopPackage(target, "0.1.4", dest, root);
    const distributed = join(dest, `Scarlet-0.1.4-macOS-${name}.dmg`);
    assert.equal(readFileSync(distributed, "utf8"), "0.1.4");

    file(dmg, "0.1.3");
    assert.throws(() => verifyDesktopPackage(target, "0.1.4", dest, root), /reports "0.1.3"/);
    file(dmg, "0.1.4");
    tool("lipo", "echo wrong-architecture");
    assert.throws(() => verifyDesktopPackage(target, "0.1.4", dest, root), /wrong-architecture/);
  });
}

test("checks Windows app and both installer resources before staging either installer", { skip: process.platform === "win32" }, t => {
  const target = "x86_64-pc-windows-msvc";
  const { root, release, dest, file, tool } = fixture(t, target);
  const app = join(release, "scarlet-desktop.exe");
  const setup = join(release, "bundle/nsis/Scarlet_0.1.4_x64-setup.exe");
  const msi = join(release, "bundle/msi/Scarlet_0.1.4_x64_en-US.msi");
  tool("powershell.exe", `case "$SCARLET_VERIFY_FILE" in
    *.msi) case "$4" in *OpenDatabase*ProductVersion*) ;; *) exit 2;; esac;;
    *.exe) case "$4" in *GetVersionInfo*ProductVersion*) ;; *) exit 2;; esac;;
    *) exit 2;;
  esac
  cat "$SCARLET_VERIFY_FILE"`);
  file(app, "0.1.4.0");
  file(setup);
  file(msi);
  verifyDesktopPackage(target, "0.1.4", dest, root);
  assert.deepEqual(readdirSync(dest).sort(), ["Scarlet-0.1.4-Windows-x64-Setup.exe", "Scarlet-0.1.4-Windows-x64.msi"]);
  for (const [path, wrong] of [[msi, "0.1.3"], [setup, "0.1.4.1"], [app, "0.1.40"]]) {
    file(path, wrong);
    assert.throws(() => verifyDesktopPackage(target, "0.1.4", dest, root), /expected 0.1.4/);
    file(path);
  }
  rmSync(msi);
  assert.throws(() => verifyDesktopPackage(target, "0.1.4", dest, root), /ENOENT/);
});
