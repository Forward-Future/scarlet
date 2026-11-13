// Inspect the staged installer payloads without installing or launching Scarlet.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const mit = readFileSync(new URL("../../../LICENSE", import.meta.url));

export function inspectPublicPayload(root, windows) {
  const engines = [];
  const directories = [root];
  while (directories.length) {
    const directory = directories.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (/^ff(?:mpeg|probe)(?:[.-]|$)/i.test(entry.name)) throw new Error(`Unexpected media tool in the public installer: ${path}`);
      // A DMG contains an Applications shortcut outside the disk image. Never follow directory links or junctions.
      if (entry.isDirectory() && !entry.isSymbolicLink()) directories.push(path);
      if (entry.isFile() && entry.name === (windows ? "scarlet-engine.exe" : "scarlet-engine")) engines.push(directory);
    }
  }
  if (engines.length !== 1) throw new Error(`Expected one packaged engine in ${root}, found ${engines.length}`);
  const dir = engines[0];
  if (!windows && dir !== join(root, "Scarlet.app", "Contents", "MacOS")) throw new Error("Missing engine in Scarlet.app/Contents/MacOS");
  const resources = windows ? dir : join(root, "Scarlet.app", "Contents", "Resources");
  if (!windows) {
    const helper = "Install-Scarlet-FFmpeg-macOS.sh";
    if (!readFileSync(join(resources, helper)).equals(readFileSync(join(dirname(script), helper)))) {
      throw new Error("Packaged FFmpeg installation helper differs from the source");
    }
  }
  const licenses = join(resources, "licenses");
  if (!readFileSync(join(licenses, "Scarlet-MIT.txt")).equals(mit)) throw new Error("Packaged Scarlet license differs from the source license");
  const platformNotices = windows ? ["DirectML/LICENSE.txt", "DirectML/LICENSE-CODE.txt", "DirectML/ThirdPartyNotices.txt",
    "Vulkan-Headers/MIT.txt", "Vulkan-Headers/NOTICE.txt"] : [];
  for (const file of ["node.txt", "javascript.txt", "rust.txt", ...platformNotices]) {
    if (!statSync(join(licenses, "runtime", file)).size) throw new Error(`Empty runtime notice: ${file}`);
  }
  return dir;
}

function run(program, args) {
  execFileSync(program, args, { stdio: "inherit", windowsHide: true });
}

function checkInstallers(installers, tools) {
  const windows = process.platform === "win32";
  const files = readdirSync(installers);
  const work = mkdtempSync(join(tmpdir(), "scarlet-public-package-"));
  let mounted;
  try {
    for (const suffix of windows ? ["-Setup.exe", ".msi"] : [".dmg"]) {
      const matches = files.filter(f => f.endsWith(suffix));
      if (matches.length !== 1) throw new Error(`Expected one ${suffix} in ${installers}, found ${matches.length}`);
      const installer = join(installers, matches[0]);
      const payload = join(work, basename(installer) + "-payload");
      mkdirSync(payload);
      if (!windows) {
        run("hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", payload, installer]);
        mounted = payload;
      } else if (suffix === ".msi") {
        // Administrative extraction unpacks the MSI without registering or launching the app.
        run("msiexec.exe", ["/a", installer, "/qn", "/norestart", `TARGETDIR=${payload}`]);
      } else {
        run("7z", ["x", "-y", "-bso0", `-o${payload}`, installer]);
      }
      const engineDir = inspectPublicPayload(payload, windows);
      console.log(`Verified notices and absence of media tools in ${matches[0]}`);
      // Use the MSI's real installation layout to exercise the Windows engine once.
      if (!windows || suffix === ".msi") run(process.execPath, [join(dirname(script), "smoke-engine.mjs"), engineDir, tools]);
    }
  } finally {
    if (mounted) run("hdiutil", ["detach", mounted]);
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  const [installers, tools] = process.argv.slice(2);
  if (!installers || !tools) throw new Error("Usage: smoke-engine-public.mjs <staged installers> <external media tools>");
  checkInstallers(resolve(installers), resolve(tools));
}
