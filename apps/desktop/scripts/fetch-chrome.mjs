// Fetch the checksum-pinned Chrome for Testing headless shell that renders motion graphics.
// Every desktop package ships it as the chrome-headless-shell resource folder, so graphics render the same everywhere.
// The engine finds it through SCARLET_CHROME, which the desktop shell sets.
//
// Usage: node scripts/fetch-chrome.mjs [--target <rust triple>] [--force | --verify-only]
//        (default target: TAURI_ENV_TARGET_TRIPLE, else this machine)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { hostTriple, option, unzip } from "./targets.mjs";

// Stable 157.0.8103.78 from Chrome for Testing's last-known-good-versions-with-downloads.json.
// The sums are of the archives as downloaded from that listing on 2026-11-14.
export const CHROME_VERSION = "157.0.8103.78";
const CFT = `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}`;
export const BUILDS = {
  "aarch64-apple-darwin": { platform: "mac-arm64", sha256: "17bf66d53c1b1104dcb641c5b331cd4ac5d200c778f5feed0934a0b92deaf8d6" },
  "x86_64-apple-darwin": { platform: "mac-x64", sha256: "f1a6a9561eaf1f409849538de663695d36d72fbf1ebca4d42e47c7b5f2a157f3" },
  "x86_64-pc-windows-msvc": { platform: "win64", sha256: "2138c1583d25d6f3abec5269943b2f430207d87a539895aa9e90cc4697ec0e1f" },
  "x86_64-unknown-linux-gnu": { platform: "linux64", sha256: "f90329720fb61e5a76da9b6b509b6ad12a484c9c5df0359403e935177c6d153a" },
};
export const chromeExecutable = target => target.includes("windows") ? "chrome-headless-shell.exe" : "chrome-headless-shell";

const here = dirname(fileURLToPath(import.meta.url));
const binDir = resolve(here, "../src-tauri/binaries");
// tauri.conf.json bundles this folder as the chrome-headless-shell resource on every platform.
const dest = join(binDir, "chrome-headless-shell");
const receiptFile = join(binDir, ".pinned-chrome.json");

/** The folder holds the pinned archive for this target. Signing the executables afterwards doesn't count as a change. */
export function installedChrome(target, folder = dest, receipt = receiptFile) {
  try {
    const pinned = JSON.parse(readFileSync(receipt, "utf8"));
    if (pinned.target !== target || pinned.version !== CHROME_VERSION || pinned.archive !== BUILDS[target].sha256) return false;
    const exe = statSync(join(folder, chromeExecutable(target)));
    // build.rs leaves only a README in a folder that was never fetched.
    return exe.isFile() && exe.size > 1024 * 1024 && statSync(join(folder, "LICENSE.headless_shell")).size > 0;
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const target = option(args, "--target") ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? hostTriple();
  const build = BUILDS[target];
  if (!build) throw new Error(`[chrome] unsupported target ${target}`);
  if (args.includes("--verify-only")) {
    if (!installedChrome(target)) throw new Error(`Run pnpm desktop:chrome for ${target} before packaging`);
    return;
  }
  if (!args.includes("--force") && installedChrome(target)) {
    console.log(`[chrome] verified headless shell ${CHROME_VERSION} for ${target}`);
    return;
  }

  // Unpack beside the destination so the finished folder replaces the old one with a rename.
  const work = join(binDir, `.chrome-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    const url = `${CFT}/${build.platform}/chrome-headless-shell-${build.platform}.zip`;
    const zip = join(work, "chrome.zip");
    console.log(`[chrome] downloading ${url}`);
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);
    const hash = createHash("sha256");
    await pipeline(res.body, async function* (source) {
      for await (const chunk of source) {
        hash.update(chunk);
        yield chunk;
      }
    }, createWriteStream(zip));
    const sum = hash.digest("hex");
    if (sum !== build.sha256) throw new Error(`checksum mismatch for ${url}\n  expected ${build.sha256}\n  got      ${sum}`);
    const unpacked = join(work, "x");
    unzip(zip, unpacked);
    const folder = join(unpacked, `chrome-headless-shell-${build.platform}`);
    const exe = join(folder, chromeExecutable(target));
    if (!existsSync(exe) || !statSync(exe).size) throw new Error(`${chromeExecutable(target)} not found in ${url}`);
    if (!target.includes("windows") && !(statSync(exe).mode & 0o111)) throw new Error(`${exe} lost its executable bit while unpacking`);
    if (process.platform === "darwin") {
      // A download can carry a quarantine flag; the release workflow signs the folder before bundling.
      try { execFileSync("xattr", ["-cr", folder]); } catch { /* not quarantined */ }
    }
    rmSync(receiptFile, { force: true });
    rmSync(dest, { recursive: true, force: true });
    renameSync(folder, dest);
    const pending = `${receiptFile}.${process.pid}.tmp`;
    writeFileSync(pending, JSON.stringify({ target, version: CHROME_VERSION, archive: build.sha256 }));
    renameSync(pending, receiptFile);
    console.log(`[chrome] ${join(dest, chromeExecutable(target))} (${(folderSize(dest) / 1024 / 1024).toFixed(0)} MB)`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function folderSize(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? folderSize(p) : statSync(p).size;
  }
  return total;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
