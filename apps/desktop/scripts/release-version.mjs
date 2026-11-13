import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const packageFiles = [
  "package.json",
  "apps/agent/package.json",
  "apps/desktop/package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/mcp/package.json",
  "packages/render/package.json",
  "packages/shared/package.json",
  "packages/timeline/package.json",
];
const jsonFiles = [...packageFiles, "apps/desktop/src-tauri/tauri.conf.json"];
const fields = [
  ...jsonFiles.map(file => ({ file, pattern: /^(  "version":[ \t]*")([^"\r\n]+)"/gm, json: true })),
  { file: "apps/desktop/src-tauri/Cargo.toml", pattern: /^(\[package\]\r?\nname = "scarlet-desktop"\r?\nversion = ")([^"\r\n]+)"/gm },
  { file: "apps/desktop/src-tauri/Cargo.lock", pattern: /^(\[\[package\]\]\r?\nname = "scarlet-desktop"\r?\nversion = ")([^"\r\n]+)"/gm },
  { file: "apps/agent/src/modelCatalog.ts", pattern: /(clientInfo: \{ name: "scarlet", version: ")([^"\r\n]+)"/g },
  { file: "apps/server/src/telemetry/config.ts", pattern: /^(export const SCARLET_VERSION = ")([^"\r\n]+)"/gm },
  { file: "packages/mcp/src/server.ts", pattern: /(new McpServer\(\s*\{ name: "scarlet", version: ")([^"\r\n]+)"/g },
];

function readField({ file, pattern, json }) {
  const path = join(root, file);
  const contents = readFileSync(path, "utf8");
  const matches = [...contents.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`${file}: expected one Scarlet version field, found ${matches.length}`);
  const [{ index, 1: prefix, 2: version }] = matches;
  if (json && JSON.parse(contents).version !== version) throw new Error(`${file}: could not identify the top-level version`);
  return { file, path, contents, version, start: index + prefix.length };
}

function versionParts(version) {
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Invalid desktop version "${version}". Use major.minor.patch.`);
  }
  return version.split(".").map(BigInt);
}

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function versionAt(ref) {
  const anchor = git("log", "--first-parent", "-1", "-G", '^  "version":', "--format=%H", ref, "--", "package.json");
  if (!anchor) throw new Error(`No root package.json version commit found at ${ref}.`);
  const baseline = versionParts(JSON.parse(git("show", anchor + ":package.json")).version);
  const [major, minor, patch] = baseline;
  const distance = BigInt(git("rev-list", "--first-parent", "--count", anchor + ".." + ref));
  return { anchor, baseline, parts: [major, minor, patch + distance] };
}

function commitVersion() {
  if (git("rev-parse", "--is-shallow-repository") === "true") {
    throw new Error("Release numbering requires the full first-parent history. Fetch an unshallow checkout.");
  }
  const current = versionAt("HEAD");
  let earlier = current;
  // Walk the baselines newest first. A fix may follow a bad baseline that never shipped.
  // The previously released range can extend past both; retrying must never reuse its numbers.
  while (true) {
    const [, parent] = git("rev-list", "--parents", "-n", "1", earlier.anchor).split(" ");
    if (!parent || !git("ls-tree", parent, "--", "apps/desktop/scripts/release-version.mjs")) break;
    earlier = versionAt(parent);
    const differing = current.baseline.findIndex((value, index) => value !== earlier.parts[index]);
    if (differing === -1 || current.baseline[differing] < earlier.parts[differing]) {
      throw new Error(`Version baseline ${current.baseline.join(".")} at ${current.anchor} must be newer than ${earlier.parts.join(".")} assigned in earlier history.`);
    }
  }
  return current.parts.join(".");
}

function run(args) {
  const [command, ...rest] = args;
  if (command === "for-commit" && rest.length === 0) {
    console.log(commitVersion());
    return;
  }
  const target = command === "set" ? rest.shift() : undefined;
  const tag = rest[0] === "--tag" && rest.length === 2 ? rest[1] : undefined;
  if (!["check", "set"].includes(command) || (command === "set" && !target) || (rest.length && tag === undefined)) {
    throw new Error("Usage: release-version.mjs for-commit | check [--tag <release-tag>] | set <major.minor.patch> [--tag <release-tag>]");
  }

  // Read every field before writing any of them. A missing or moved field must never produce a partial bump.
  const records = fields.map(readField);
  const expected = target ?? records[0].version;
  versionParts(expected);
  if (tag !== undefined && tag !== "v" + expected) {
    throw new Error(`Tag "${tag}" must match the stable desktop version v${expected}.`);
  }

  const changed = records.filter(record => record.version !== expected);
  if (command === "check" && changed.length) {
    throw new Error(changed.map(({ file, version }) => `${file}: expected ${expected}, found ${version}`).join("\n"));
  }
  if (command === "set") {
    for (const { path, contents, start, version } of changed) {
      const temp = path + ".release-version-" + randomUUID();
      try {
        writeFileSync(temp, contents.slice(0, start) + expected + contents.slice(start + version.length), {
          mode: statSync(path).mode, flag: "wx",
        });
        renameSync(temp, path);
      } finally {
        rmSync(temp, { force: true });
      }
    }
  }
  console.log(expected);
}

try {
  run(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
