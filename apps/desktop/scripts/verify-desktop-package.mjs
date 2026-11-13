// node apps/desktop/scripts/verify-desktop-package.mjs <target-triple> <marketing-version> [output-directory]
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { earlyAccessId, earlyAccessName } from "./early-access-product.mjs";

const script = fileURLToPath(import.meta.url);
const tauriDir = resolve(dirname(script), "../src-tauri");
const macTargets = {
  "aarch64-apple-darwin": { slice: "arm64", dmg: "aarch64", label: "Apple-Silicon" },
  "x86_64-apple-darwin": { slice: "x86_64", dmg: "x64", label: "Intel" },
};

function output(program, args, env = process.env) {
  return execFileSync(program, args, { encoding: "utf8", env, windowsHide: true }).trim();
}

function requireFile(file) {
  const info = statSync(file);
  if (!info.isFile() || !info.size) throw new Error(`Missing or empty file: ${file}`);
}

function checkVersion(label, actual, expected, windows = false) {
  // Windows can expose the fixed four-part PE version for a release with revision zero.
  if (actual !== expected && !(windows && actual === `${expected}.0`)) {
    throw new Error(`${label} reports ${JSON.stringify(actual)}, expected ${expected}`);
  }
}

function requireExternalMediaTools(names, description) {
  const media = names.find(name => /^ff(mpeg|probe)(\.exe)?$/i.test(name.split(/[\\/|]/).pop()));
  if (media) throw new Error(`${description} unexpectedly bundles ${media}`);
}

const runtimeNotices = ["node.txt", "javascript.txt", "rust.txt", "rust-standard-library.html", "whisper-audio-dependencies.txt",
  "sherpa-dependencies.txt", "speaker-onnxruntime-1.28.2-third-party.txt"];

function verifyWindowsPayload(names, description) {
  requireExternalMediaTools(names, description);
  // MSI returns short|long file names; NSIS returns paths.
  const files = new Set(names.map(name => name.split(/[\\/|]/).pop().toLowerCase()));
  for (const required of [...runtimeNotices, "scarlet.txt", "uhm.txt", "uhm-model-license.txt", "ThirdPartyNotices.txt", "LICENSE-CODE.txt", "LICENSE-LLVM.txt", "nsis-3.13.txt"]) {
    if (!files.has(required.toLowerCase())) throw new Error(`${description} is missing ${required}`);
  }
}

function verifyDmg(dmg, productName, identifier, expected, arch) {
  requireFile(dmg);
  const mount = mkdtempSync(join(tmpdir(), "scarlet-dmg-"));
  let mounted = false;
  try {
    output("hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, dmg]);
    mounted = true;
    const contents = join(mount, `${productName}.app`, "Contents");
    requireExternalMediaTools(readdirSync(join(contents, "MacOS")), dmg);
    const licenses = join(contents, "Resources", "licenses");
    requireFile(join(licenses, "scarlet.txt"));
    requireFile(join(licenses, "uhm.txt"));
    requireFile(join(licenses, "uhm-model-license.txt"));
    for (const name of runtimeNotices) requireFile(join(licenses, "runtime", name));
    const stamp = key => output("plutil", ["-extract", key, "raw", "-o", "-", join(contents, "Info.plist")]);
    checkVersion(dmg, stamp("CFBundleShortVersionString"), expected);
    checkVersion(dmg, stamp("CFBundleVersion"), expected);
    if (stamp("CFBundleIdentifier") !== identifier) throw new Error(`${dmg} has the wrong bundle identifier, expected ${identifier}`);
    const slices = output("lipo", ["-archs", join(contents, "MacOS", "scarlet-desktop")]).split(/\s+/);
    if (!slices.includes(arch)) throw new Error(`${dmg} contains ${slices.join(" ")}, expected ${arch}`);
  } finally {
    if (mounted) output("hdiutil", ["detach", mount]);
    rmdirSync(mount);
  }
}

// Query the MSI Property table read-only; the MSI isn't installed or executed.
const msiProperties = `
  $ErrorActionPreference = 'Stop'
  $installer = New-Object -ComObject WindowsInstaller.Installer
  $db = $installer.OpenDatabase($env:SCARLET_VERIFY_FILE, 0)
  $view = $db.OpenView('SELECT \`Property\`, \`Value\` FROM \`Property\`')
  $view.Execute()
  $properties = @{}
  while ($row = $view.Fetch()) { $properties[$row.StringData(1)] = $row.StringData(2) }
  $view.Close()
  $files = $db.OpenView('SELECT \`FileName\` FROM \`File\`')
  $files.Execute()
  $names = while ($row = $files.Fetch()) { $row.StringData(1) }
  @{ product = $properties.ProductName; version = $properties.ProductVersion; upgradeCode = $properties.UpgradeCode; names = @($names) } | ConvertTo-Json -Compress
`;

function verifyWindowsProduct(file, expected, productName, msi = false) {
  requireFile(file);
  const command = msi ? msiProperties : `
    $info = [Diagnostics.FileVersionInfo]::GetVersionInfo($env:SCARLET_VERIFY_FILE)
    @{ product = $info.ProductName; version = $info.ProductVersion } | ConvertTo-Json -Compress`;
  const result = output("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
    { ...process.env, SCARLET_VERIFY_FILE: file });
  const { version, product, names, upgradeCode } = JSON.parse(result);
  checkVersion(file, version, expected, !msi);
  if (product !== productName) throw new Error(`${file} reports product ${product}, expected ${productName}`);
  if (msi) {
    // Tauri generates the x64 MSI upgrade code from the product name (UUID v5).
    if (productName === earlyAccessName && upgradeCode?.replace(/[{}]/g, "").toLowerCase() !== "7c84d69f-5f09-50de-84d2-2def58073b57") {
      throw new Error(`${file} has the wrong Early Access MSI upgrade code`);
    }
    verifyWindowsPayload(names, file);
  }
}

export function verifyDesktopPackage(target, expected, destination, root = tauriDir, earlyAccess = false) {
  const config = JSON.parse(readFileSync(join(root, "tauri.conf.json"), "utf8"));
  const productName = earlyAccess ? earlyAccessName : "Scarlet";
  const identifier = earlyAccess ? earlyAccessId : "com.forwardfuture.scarlet";
  if (config.productName !== productName || config.identifier !== identifier) {
    throw new Error(`Expected package identity ${productName} (${identifier})`);
  }
  const assetName = productName.replaceAll(" ", "-");
  const release = join(root, "target", target, "release");
  const bundle = join(release, "bundle");
  const packages = new Map();
  if (Object.hasOwn(macTargets, target)) {
    const arch = macTargets[target];
    const dmg = join(bundle, "dmg", `${productName}_${expected}_${arch.dmg}.dmg`);
    verifyDmg(dmg, productName, identifier, expected, arch.slice);
    packages.set(dmg, `${assetName}-${expected}-macOS-${arch.label}.dmg`);
  } else if (target === "x86_64-pc-windows-msvc") {
    const app = join(release, "scarlet-desktop.exe");
    const setup = join(bundle, "nsis", `${productName}_${expected}_x64-setup.exe`);
    const msi = join(bundle, "msi", `${productName}_${expected}_x64_en-US.msi`);
    for (const file of [app, setup]) verifyWindowsProduct(file, expected, productName);
    verifyWindowsProduct(msi, expected, productName, true);
    const listing = output("7z", ["l", "-slt", "-ba", setup]);
    const names = [...listing.matchAll(/^Path = (.+)$/gm)].map(match => match[1].trim());
    if (!names.some(name => name.toLowerCase().endsWith("scarlet-desktop.exe"))) throw new Error(`Could not inspect installer payload: ${setup}`);
    verifyWindowsPayload(names, setup);
    packages.set(setup, `${assetName}-${expected}-Windows-x64-Setup.exe`);
    packages.set(msi, `${assetName}-${expected}-Windows-x64.msi`);
  } else {
    throw new Error(`Unsupported desktop target: ${target}`);
  }
  if (destination) {
    mkdirSync(destination, { recursive: true });
    for (const [source, name] of packages) copyFileSync(source, join(destination, name));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  const [target, expected, destination] = process.argv.slice(2);
  if (!target || !expected) throw new Error("Usage: verify-desktop-package.mjs <target-triple> <marketing-version> [output-directory]");
  verifyDesktopPackage(target, expected, destination, tauriDir, process.env.EARLY_ACCESS === "true");
  console.log(`Verified packaged ${expected} for ${target}`);
}
