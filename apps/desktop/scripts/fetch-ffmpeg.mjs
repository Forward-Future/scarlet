// Downloads the static ffmpeg/ffprobe builds bundled with the desktop app and
// puts them where Tauri expects sidecars: src-tauri/binaries/<name>-<triple>[.exe].
// The installer places them beside the engine, which looks there first.
//
// Builds are pinned and checked against SHA-256 so every release ships the
// same, native binaries: x86_64 for Windows, arm64 for Apple Silicon (no
// Rosetta needed), x86_64 for Intel Macs.
//
// Usage: node scripts/fetch-ffmpeg.mjs [--target <rust triple>] [--force]
//        (default target: this machine)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const RIEDL = "https://ffmpeg.martin-riedl.de/download/macos";
const BUILDS = {
  "x86_64-pc-windows-msvc": {
    // One zip with both tools under ffmpeg-<v>-essentials_build/bin/.
    archives: [{ url: "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip", sha256: "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba" }],
  },
  "aarch64-apple-darwin": {
    archives: [
      { url: `${RIEDL}/arm64/1789931890_9.0.2/ffmpeg.zip`, sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924" },
      { url: `${RIEDL}/arm64/1789931890_9.0.2/ffprobe.zip`, sha256: "fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6" },
    ],
  },
  "x86_64-apple-darwin": {
    archives: [
      { url: `${RIEDL}/amd64/1789931006_9.0.2/ffmpeg.zip`, sha256: "7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4" },
      { url: `${RIEDL}/amd64/1789931006_9.0.2/ffprobe.zip`, sha256: "2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd" },
    ],
  },
};

const here = dirname(fileURLToPath(import.meta.url));
const binDir = resolve(here, "../src-tauri/binaries");
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const target = flag("--target") ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? hostTriple();
const force = args.includes("--force");
const build = BUILDS[target];
if (!build) {
  console.error(`[ffmpeg] no pinned build for ${target}. Supported: ${Object.keys(BUILDS).join(", ")}`);
  process.exit(1);
}
const ext = target.includes("windows") ? ".exe" : "";
const outputs = ["ffmpeg", "ffprobe"].map((tool) => ({ tool, file: `${tool}${ext}`, dest: join(binDir, `${tool}-${target}${ext}`) }));

// The receipt binds both installed binaries to the verified pinned archives.
// Existence alone is insufficient: cargo dev builds create zero-byte stand-ins.
const receiptFile = join(binDir, `.pinned-media-${target}.json`);
const archives = build.archives.map((a) => a.sha256);
async function checksum(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function installed() {
  try {
    const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
    if (JSON.stringify(receipt.archives) !== JSON.stringify(archives)) return false;
    for (const o of outputs) {
      const stat = statSync(o.dest);
      if (!stat.isFile() || !stat.size || await checksum(o.dest) !== receipt.binaries[o.tool]) return false;
    }
    return true;
  } catch {
    return false;
  }
}
if (args.includes("--verify-only")) {
  const engine = join(binDir, `scarlet-engine-${target}${ext}`);
  if (!await installed()) throw new Error(`Run pnpm desktop:ffmpeg for ${target} before packaging`);
  if (!existsSync(engine) || !statSync(engine).isFile() || !statSync(engine).size) throw new Error("Build the engine sidecar before packaging");
  process.exit(0);
}
if (!force && await installed()) {
  console.log(`[ffmpeg] verified both media tools for ${target}`);
  process.exit(0);
}

mkdirSync(binDir, { recursive: true });
const work = join(tmpdir(), `scarlet-ffmpeg-${target}-${process.pid}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
try {
  for (const [i, a] of build.archives.entries()) {
    const zip = join(work, `archive-${i}.zip`);
    console.log(`[ffmpeg] downloading ${a.url}`);
    const res = await fetch(a.url, { redirect: "follow" });
    if (!res.ok) throw new Error(`download failed (${res.status}): ${a.url}`);
    const hash = createHash("sha256");
    await pipeline(res.body, async function* (source) {
      for await (const chunk of source) {
        hash.update(chunk);
        yield chunk;
      }
    }, createWriteStream(zip));
    const sum = hash.digest("hex");
    if (sum !== a.sha256) throw new Error(`checksum mismatch for ${a.url}\n  expected ${a.sha256}\n  got      ${sum}`);
    unzip(zip, join(work, `x${i}`));
  }
  const binaries = {};
  for (const o of outputs) {
    const found = findFile(work, o.file);
    if (!found || !statSync(found).size) throw new Error(`${o.file} not found in the downloaded archives`);
    binaries[o.tool] = await checksum(found);
    copyFileSync(found, o.dest);
    if (!ext) chmodSync(o.dest, 0o755);
    if (process.platform === "darwin") {
      // Downloaded files carry a quarantine flag; the bundle is signed later.
      try {
        execFileSync("xattr", ["-c", o.dest]);
      } catch {
        /* not quarantined */
      }
    }
    console.log(`[ffmpeg] ${o.dest} (${(statSync(o.dest).size / 1024 / 1024).toFixed(1)} MB)`);
  }
  const pending = receiptFile + `.${process.pid}.tmp`;
  writeFileSync(pending, JSON.stringify({ archives, binaries }));
  renameSync(pending, receiptFile);
} finally {
  rmSync(work, { recursive: true, force: true });
}

function hostTriple() {
  const key = `${process.platform}-${process.arch}`;
  const triple = { "win32-x64": "x86_64-pc-windows-msvc", "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin" }[key];
  if (!triple) throw new Error(`no default target for ${key}; pass --target`);
  return triple;
}

/** bsdtar reads zips on Windows 10+ and macOS; Git Bash's GNU tar does not, hence the explicit path. */
function unzip(zip, dest) {
  mkdirSync(dest, { recursive: true });
  if (process.platform === "win32") {
    const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    execFileSync(tar, ["-xf", zip, "-C", dest], { stdio: "inherit" });
  } else if (existsSync("/usr/bin/unzip")) {
    execFileSync("/usr/bin/unzip", ["-q", "-o", zip, "-d", dest], { stdio: "inherit" });
  } else {
    execFileSync("tar", ["-xf", zip, "-C", dest], { stdio: "inherit" });
  }
}

function findFile(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (e.name === name) {
      return p;
    }
  }
  return null;
}
