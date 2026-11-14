import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

async function localInstallers(version, directory) {
  const suffixes = ["macOS-Apple-Silicon.dmg", "macOS-Intel.dmg", "Windows-x64-Setup.exe", "Windows-x64.msi"];
  const names = suffixes.map(suffix => `Scarlet-${version}-${suffix}`);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length !== names.length || entries.some(entry => !entry.isFile() || !names.includes(entry.name))) {
    throw new Error(`Expected exactly these four regular installer files in ${directory}: ${names.join(", ")}`);
  }
  const files = new Map();
  for (const name of names) {
    const path = join(directory, name);
    const blob = await openAsBlob(path, { type: "application/octet-stream" });
    if (!blob.size) throw new Error(`Empty installer: ${name}`);
    const hash = createHash("sha256");
    for await (const chunk of blob.stream()) hash.update(chunk);
    files.set(name, { blob, digest: `sha256:${hash.digest("hex")}` });
  }
  return files;
}

function github(repository, token, fetchImpl) {
  return async function request(path, { method = "GET", body, optional = false } = {}) {
    const upload = body instanceof Blob;
    const host = upload ? "uploads.github.com" : "api.github.com";
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    if (body !== undefined) headers["Content-Type"] = upload ? "application/octet-stream" : "application/json";
    const response = await fetchImpl(`https://${host}/repos/${repository}${path}`, {
      method, headers, body: upload ? body : JSON.stringify(body), redirect: "error",
    });
    if (optional && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${path} returned ${response.status}: ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  };
}

async function taggedCommit(request, tag) {
  const ref = await request(`/git/ref/tags/${tag}`, { optional: true });
  if (!ref) return null;
  let object = ref.object;
  while (object.type === "tag") object = (await request(`/git/tags/${object.sha}`)).object;
  if (object.type !== "commit") throw new Error(`Tag ${tag} points to a ${object.type}, not a commit`);
  return object.sha;
}

async function releaseForTag(request, tag) {
  // Listing authenticated releases also finds unpublished drafts, including those without a public tag URL.
  let match;
  for (let page = 1; ; page++) {
    const releases = await request(`/releases?per_page=100&page=${page}`);
    for (const release of releases.filter(item => item.tag_name === tag)) {
      if (match) throw new Error(`Multiple releases claim ${tag}`);
      match = release;
    }
    if (releases.length < 100) return match;
  }
}

async function inspectRelease(request, release, files) {
  const assets = await request(`/releases/${release.id}/assets?per_page=100`);
  const found = new Set();
  const interrupted = [];
  for (const asset of assets) {
    const file = files.get(asset.name);
    if (!file || found.has(asset.name)) throw new Error(`Unexpected or duplicate release asset: ${asset.name}`);
    found.add(asset.name);
    // GitHub can leave an empty "starter" asset after an interrupted upload. Only remove that placeholder in a draft.
    if (release.draft && asset.state === "starter" && asset.size === 0) interrupted.push(asset);
    else if (asset.state !== "uploaded" || asset.size !== file.blob.size || asset.digest !== file.digest) {
      throw new Error(`Release asset does not match this build: ${asset.name}`);
    }
  }
  const missing = [...files.keys()].filter(name => !found.has(name));
  return { missing, interrupted };
}

export async function publishDesktopRelease({ version, directory, repository, sha, token, fetchImpl = fetch }) {
  if (!stableVersion.test(version) || !directory || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      !/^[a-f0-9]{40}$/.test(sha) || !token) {
    throw new Error("Expected a stable major.minor.patch, installer directory, GITHUB_REPOSITORY, full GITHUB_SHA and GH_TOKEN");
  }
  const files = await localInstallers(version, directory);
  const request = github(repository, token, fetchImpl);
  const tag = `v${version}`;
  const original = await taggedCommit(request, tag);
  if (original && original !== sha) throw new Error(`Tag ${tag} points to ${original}, expected ${sha}`);
  let release = await releaseForTag(request, tag);
  if (release && (release.prerelease || (release.draft ? release.target_commitish !== sha : original !== sha))) {
    throw new Error(`Existing release ${tag} does not belong to this stable build of ${sha}`);
  }
  // Pin the tag explicitly. GitHub otherwise ignores target_commitish if somebody has already created the tag.
  if (!original) await request("/git/refs", { method: "POST", body: { ref: `refs/tags/${tag}`, sha } });
  if (!release) {
    release = await request("/releases", { method: "POST", body: {
      tag_name: tag, target_commitish: sha, name: `Scarlet ${version}`,
      body: [
        "Download the DMG for your Mac’s chip (Apple Silicon or Intel), or choose the Setup EXE or MSI for Windows x64.",
        "Scarlet uses FFmpeg and FFprobe to import and export footage. If you already installed them for Early Access, you can use the same tools.",
        "**macOS.** Drag Scarlet into Applications. To install the media tools, run `bash /Applications/Scarlet.app/Contents/Resources/Install-Scarlet-FFmpeg-macOS.sh` in Terminal, then open Scarlet. " +
          `[View the helper source](https://github.com/${repository}/blob/${sha}/apps/desktop/scripts/Install-Scarlet-FFmpeg-macOS.sh)`,
        "**Windows.** Run `winget install --id Gyan.FFmpeg.Essentials --exact` in PowerShell, then run Scarlet Setup and open Scarlet from your regular Windows account.",
        "Early Access and stable Scarlet use separate project libraries. Continue opening existing Early Access projects in Scarlet Early Access.",
      ].join("\n\n"),
      draft: true, prerelease: false,
    } });
  }
  const { missing, interrupted } = await inspectRelease(request, release, files);
  if (release.draft) {
    for (const asset of interrupted) {
      await request(`/releases/assets/${asset.id}`, { method: "DELETE" });
      missing.push(asset.name);
    }
    for (const name of missing) {
      await request(`/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, { method: "POST", body: files.get(name).blob });
    }
    const checked = await inspectRelease(request, release, files);
    if (checked.missing.length || checked.interrupted.length) throw new Error(`Incomplete uploads for ${tag}`);
    if (await taggedCommit(request, tag) !== sha) throw new Error(`Tag ${tag} changed during upload`);
    // GitHub selects Latest by semantic version, including when an older platform build finishes later.
    release = await request(`/releases/${release.id}`, { method: "PATCH", body: { draft: false, make_latest: "legacy" } });
  } else if (missing.length) {
    throw new Error(`Published release ${tag} is missing ${missing.join(", ")}`);
  }
  if (release.draft || release.prerelease || release.tag_name !== tag) throw new Error(`Failed to publish stable release ${tag}`);
  return release.html_url;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [version, directory] = process.argv.slice(2);
  try {
    if (process.argv.length !== 4) throw new Error("Usage: publish-desktop-release.mjs <version> <installer-directory>");
    console.log(await publishDesktopRelease({ version, directory, repository: process.env.GITHUB_REPOSITORY,
      sha: process.env.GITHUB_SHA, token: process.env.GH_TOKEN }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
