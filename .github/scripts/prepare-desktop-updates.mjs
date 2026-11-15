import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const config = JSON.parse(readFileSync(new URL("../../apps/desktop/src-tauri/tauri.stable.conf.json", import.meta.url)));
const pinnedKey = config.plugins.updater.pubkey;
const changelog = new URL("../../CHANGELOG.md", import.meta.url);

export const updatePlatforms = {
  "darwin-aarch64": "macOS-Apple-Silicon.app.tar.gz",
  "darwin-x86_64": "macOS-Intel.app.tar.gz",
  "windows-x86_64-nsis": "Windows-x64-Setup.exe",
  "windows-x86_64-msi": "Windows-x64.msi",
};

// Check the same Minisign signature the app verifies, including which file and version the signer approved.
export function prepareDesktopUpdates(directory, version, repository, pubkey = pinnedKey) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || repository !== "Forward-Future/scarlet") {
    throw new Error("Expected a stable Scarlet version and its public repository");
  }
  const work = mkdtempSync(join(tmpdir(), "scarlet-update-signatures-"));
  const platforms = {};
  const sidecars = [];
  try {
    const publicFile = join(work, "key.pub");
    const decodedSignature = join(work, "package.minisig");
    writeFileSync(publicFile, Buffer.from(pubkey, "base64"));
    for (const [target, suffix] of Object.entries(updatePlatforms)) {
      const name = `Scarlet-${version}-${suffix}`;
      const file = join(directory, name);
      const sidecar = file + ".sig";
      const signature = readFileSync(sidecar, "utf8").trim();
      writeFileSync(decodedSignature, Buffer.from(signature, "base64"));
      const comment = execFileSync("minisign", ["-V", "-Q", "-p", publicFile, "-x", decodedSignature, "-m", file],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\t");
      if (!comment.includes(`file:${name}`) || !comment.includes(`version:${version}`)) {
        throw new Error(`Update signature does not name ${name} at version ${version}`);
      }
      platforms[target] = { signature, url: `https://github.com/${repository}/releases/download/v${version}/${name}` };
      sidecars.push(sidecar);
    }
    const manifest = { version, notes: readFileSync(changelog, "utf8"), platforms };
    writeFileSync(join(directory, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
    // The client gets its signatures in the manifest. Only its seven public assets go to the publisher.
    for (const sidecar of sidecars) rmSync(sidecar);
    return manifest;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, directory] = process.argv.slice(2);
  prepareDesktopUpdates(directory, version, process.env.GITHUB_REPOSITORY);
}
