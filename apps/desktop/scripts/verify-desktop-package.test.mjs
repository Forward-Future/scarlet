import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { applyEarlyAccessProduct } from "./early-access-product.mjs";
import { verifyDesktopPackage } from "./verify-desktop-package.mjs";

// Stub native metadata readers on POSIX. The Desktop workflow checks the actual
// disk images, PE resources and MSI databases on the native runners.
function fixture(t, target, earlyAccess = false) {
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
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url)));
  if (earlyAccess) applyEarlyAccessProduct(config);
  file(join(root, "tauri.conf.json"), JSON.stringify(config));
  return { root, release, dest: join(root, "assets"), file, tool };
}

for (const [target, dmgArch, arch, name, earlyAccess] of [
  ["aarch64-apple-darwin", "aarch64", "arm64", "Apple-Silicon", true],
  ["x86_64-apple-darwin", "x64", "x86_64", "Intel"],
]) {
  test(`verifies the version and CPU inside the distributed ${name} disk image`, { skip: process.platform === "win32" }, t => {
    const { root, release, dest, file, tool } = fixture(t, target, earlyAccess);
    const product = earlyAccess ? "Scarlet Early Access" : "Scarlet";
    const id = earlyAccess ? "com.forwardfuture.scarlet.earlyaccess" : "com.forwardfuture.scarlet";
    const verify = () => verifyDesktopPackage(target, "0.1.4", dest, root, earlyAccess);
    const dmg = join(release, "bundle/dmg", `${product}_0.1.4_${dmgArch}.dmg`);
    file(dmg);
    tool("hdiutil", `if [ "$1" = attach ]; then
      app="$6/${product}.app/Contents"
      mkdir -p "$app/MacOS" "$app/Resources/licenses/runtime"
      cp "$7" "$app/Info.plist"
      for notice in scarlet.txt uhm.txt uhm-model-license.txt; do cp "$7" "$app/Resources/licenses/$notice"; done
      cp "$7" "$app/Resources/licenses/runtime/rust-standard-library.html"
      for name in node javascript rust whisper-audio-dependencies sherpa-dependencies speaker-onnxruntime-1.28.2-third-party; do
        cp "$7" "$app/Resources/licenses/runtime/$name.txt"
      done
    else rm -r "$2/${product}.app"; fi`);
    tool("plutil", `if [ "$2" = CFBundleIdentifier ]; then echo "${id}"; else cat "$6"; fi`);
    tool("lipo", `echo ${arch}`);
    verify();
    const distributed = join(dest, `${product.replaceAll(" ", "-")}-0.1.4-macOS-${name}.dmg`);
    assert.equal(readFileSync(distributed, "utf8"), "0.1.4");

    file(dmg, "0.1.3");
    assert.throws(verify, /reports "0.1.3"/);
    file(dmg, "0.1.4");
    tool("lipo", "echo wrong-architecture");
    assert.throws(verify, /wrong-architecture/);
    tool("plutil", 'if [ "$2" = CFBundleIdentifier ]; then echo com.example.wrong; else cat "$6"; fi');
    assert.throws(verify, /wrong bundle identifier/);
  });
}

test("checks Windows app and both installer resources before staging either installer", { skip: process.platform === "win32" }, t => {
  const target = "x86_64-pc-windows-msvc";
  const { root, release, dest, file, tool } = fixture(t, target, true);
  const verify = () => verifyDesktopPackage(target, "0.1.4", dest, root, true);
  const app = join(release, "scarlet-desktop.exe");
  const setup = join(release, "bundle/nsis/Scarlet Early Access_0.1.4_x64-setup.exe");
  const msi = join(release, "bundle/msi/Scarlet Early Access_0.1.4_x64_en-US.msi");
  tool("powershell.exe", `case "$SCARLET_VERIFY_FILE" in
    *.msi) case "$4" in *OpenDatabase*ProductVersion*) ;; *) exit 2;; esac; printf '{"product":"Scarlet Early Access","upgradeCode":"{7C84D69F-5F09-50DE-84D2-2DEF58073B57}","version":"%s","names":["scarlet.txt","node.txt","JAVASC~1.TXT|javascript.txt","rust.txt","rust-standard-library.html","whisper-audio-dependencies.txt","sherpa-dependencies.txt","speaker-onnxruntime-1.28.2-third-party.txt","uhm.txt","uhm-model-license.txt","ThirdPartyNotices.txt","LICENSE-CODE.txt","LICENSE-LLVM.txt","nsis-3.13.txt"]}' "$(cat "$SCARLET_VERIFY_FILE")"; exit 0;;
    *.exe) case "$4" in *GetVersionInfo*ProductVersion*) ;; *) exit 2;; esac;;
    *) exit 2;;
  esac
  printf '{"product":"Scarlet Early Access","version":"%s"}' "$(cat "$SCARLET_VERIFY_FILE")"`);
  tool("7z", 'for file in scarlet-desktop.exe scarlet.txt node.txt javascript.txt rust.txt rust-standard-library.html whisper-audio-dependencies.txt sherpa-dependencies.txt speaker-onnxruntime-1.28.2-third-party.txt uhm.txt uhm-model-license.txt ThirdPartyNotices.txt LICENSE-CODE.txt LICENSE-LLVM.txt nsis-3.13.txt; do echo "Path = $file"; done');
  file(app, "0.1.4.0");
  file(setup);
  file(msi);
  verify();
  assert.deepEqual(readdirSync(dest).sort(), ["Scarlet-Early-Access-0.1.4-Windows-x64-Setup.exe", "Scarlet-Early-Access-0.1.4-Windows-x64.msi"]);
  for (const [path, wrong] of [[msi, "0.1.3"], [setup, "0.1.4.1"], [app, "0.1.40"]]) {
    file(path, wrong);
    assert.throws(verify, /expected 0.1.4/);
    file(path);
  }
  tool("7z", 'echo "Path = scarlet-desktop.exe"');
  assert.throws(verify, /missing node.txt/);
  tool("7z", 'printf "Path = scarlet-desktop.exe\\nPath = ffmpeg.exe\\n"');
  assert.throws(verify, /unexpectedly bundles ffmpeg.exe/);
  tool("powershell.exe", `case "$SCARLET_VERIFY_FILE" in
    *.msi) echo '{"product":"Scarlet Early Access","version":"0.1.4","upgradeCode":"wrong"}';;
    *) echo '{"product":"Scarlet Early Access","version":"0.1.4"}';;
  esac`);
  assert.throws(verify, /wrong Early Access MSI upgrade code/);
  tool("powershell.exe", `echo '{"product":"Scarlet","version":"0.1.4"}'`);
  assert.throws(verify, /reports product Scarlet, expected Scarlet Early Access/);
});

test("the Early Access overlay preserves the published product, per-user installer lineage and resources", () => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url)));
  const original = structuredClone(config);
  applyEarlyAccessProduct(config);
  assert.deepEqual(config, {
    ...original,
    productName: "Scarlet Early Access",
    identifier: "com.forwardfuture.scarlet.earlyaccess",
    app: { ...original.app, windows: original.app.windows.map(w => w.label === "main" ? { ...w, title: "Scarlet Early Access" } : w) },
  });
  config.bundle.windows.nsis.installMode = "perMachine";
  assert.throws(() => applyEarlyAccessProduct(config), /per-user install mode/);
});
