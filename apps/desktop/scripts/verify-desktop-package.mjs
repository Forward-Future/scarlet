// node apps/desktop/scripts/verify-desktop-package.mjs <target-triple> <marketing-version> [output-directory]
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

function verifyDmg(dmg, productName, expected, arch) {
  requireFile(dmg);
  const mount = mkdtempSync(join(tmpdir(), "scarlet-dmg-"));
  let mounted = false;
  try {
    output("hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, dmg]);
    mounted = true;
    const contents = join(mount, `${productName}.app`, "Contents");
    const version = output("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(contents, "Info.plist")]);
    checkVersion(dmg, version, expected);
    const slices = output("lipo", ["-archs", join(contents, "MacOS", "scarlet-desktop")]).split(/\s+/);
    if (!slices.includes(arch)) throw new Error(`${dmg} contains ${slices.join(" ")}, expected ${arch}`);
  } finally {
    if (mounted) output("hdiutil", ["detach", mount]);
    rmdirSync(mount);
  }
}

// Query the MSI Property table read-only; the MSI isn't installed or executed.
const msiProductVersion = `
  $ErrorActionPreference = 'Stop'
  $installer = New-Object -ComObject WindowsInstaller.Installer
  $db = $installer.OpenDatabase($env:SCARLET_VERIFY_FILE, 0)
  $view = $db.OpenView('SELECT \`Value\` FROM \`Property\` WHERE \`Property\` = ''ProductVersion''')
  $view.Execute()
  $view.Fetch().StringData(1)
`;

function windowsVersion(file, msi = false) {
  requireFile(file);
  const command = msi ? msiProductVersion : "[Diagnostics.FileVersionInfo]::GetVersionInfo($env:SCARLET_VERIFY_FILE).ProductVersion";
  return output("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
    { ...process.env, SCARLET_VERIFY_FILE: file });
}

export function verifyDesktopPackage(target, expected, destination, root = tauriDir) {
  const { productName } = JSON.parse(readFileSync(join(root, "tauri.conf.json"), "utf8"));
  const release = join(root, "target", target, "release");
  const bundle = join(release, "bundle");
  const packages = new Map();
  if (Object.hasOwn(macTargets, target)) {
    const arch = macTargets[target];
    const dmg = join(bundle, "dmg", `${productName}_${expected}_${arch.dmg}.dmg`);
    verifyDmg(dmg, productName, expected, arch.slice);
    packages.set(dmg, `${productName}-${expected}-macOS-${arch.label}.dmg`);
  } else if (target === "x86_64-pc-windows-msvc") {
    const app = join(release, "scarlet-desktop.exe");
    const setup = join(bundle, "nsis", `${productName}_${expected}_x64-setup.exe`);
    const msi = join(bundle, "msi", `${productName}_${expected}_x64_en-US.msi`);
    for (const file of [app, setup]) checkVersion(file, windowsVersion(file), expected, true);
    checkVersion(msi, windowsVersion(msi, true), expected);
    packages.set(setup, `${productName}-${expected}-Windows-x64-Setup.exe`);
    packages.set(msi, `${productName}-${expected}-Windows-x64.msi`);
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
  verifyDesktopPackage(target, expected, destination);
  console.log(`Verified packaged ${expected} for ${target}`);
}
