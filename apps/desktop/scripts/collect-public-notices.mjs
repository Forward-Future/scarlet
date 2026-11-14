// Build from the installed, frozen JS and Cargo dependencies used on this release runner.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../../..");
const tauri = join(root, "apps/desktop/src-tauri");
const sources = join(import.meta.dirname, "runtime-notice-sources");
const bundled = join(tauri, "licenses");
const read = file => readFileSync(file, "utf8").trim();
const json = file => JSON.parse(read(file));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const noticeFile = /^(?:licen[cs]e|copying|copyright|notice|unlicense|third[-_ ]?party(?:[-_ ]?(?:notices?|licen[cs]es?))?)(?:[.-].*)?$/i;
const noticeDir = /^(?:licen[cs]es?|notices?|copyrights?)$/i;
const prose = /(?:\.(?:txt|md|rst|spdx|html?)|\/[^/.]+)$/i;

/** Preserve the original files, including extra licenses that native dependencies carry for vendored code. */
function notices(dir, recursive = false) {
  const files = [];
  function visit(at, inside = false) {
    for (const item of readdirSync(at, { withFileTypes: true })) {
      const file = join(at, item.name);
      if (item.isDirectory() && ![".git", "node_modules", "target", "tests", "examples", "benches"].includes(item.name)) {
        if (recursive || inside || noticeDir.test(item.name)) visit(file, inside || noticeDir.test(item.name));
      } else if (item.isFile() && (noticeFile.test(item.name) || (inside && prose.test("/" + item.name))) &&
          !/\.(?:rs|js|c|h|toml|json|png|svg|gz|pdf|py)$/i.test(item.name)) files.push(file);
    }
  }
  visit(dir);
  return files.sort(compare);
}

/** Multiple crates ship the same verbatim permission text. Print it once and list every recipient package. */
export function renderNotices(records) {
  const texts = new Map();
  const index = [];
  for (const { name, source, license, files } of records.sort((a, b) => compare(a.name, b.name))) {
    const references = new Set();
    for (const file of [...new Set(files)].sort(compare)) {
      const value = read(file).replaceAll("\r\n", "\n");
      if (!value) continue;
      if (!texts.has(value)) texts.set(value, texts.size + 1);
      references.add(texts.get(value));
    }
    if (!references.size) throw new Error(`Missing distributed license text for ${name}`);
    index.push(`${name} (${license})\n${source}\nNotice ${[...references].join(", ")}`);
  }
  return [...index, ...Array.from(texts, ([value, id]) => `--- Notice ${id} ---\n\n${value}`)].join("\n\n") + "\n";
}

function packageDir(file) {
  let dir = dirname(file);
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate) && json(candidate).name) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`No package for ${file}`);
    dir = parent;
  }
}

async function javascriptRecords() {
  const server = join(root, "apps/server"), web = join(root, "apps/web");
  const requireServer = createRequire(join(server, "package.json")), requireWeb = createRequire(join(web, "package.json"));
  const { build } = requireServer("esbuild");
  const dirs = new Set();
  const addInput = file => {
    if (file.startsWith("\0") || !file.replaceAll("\\", "/").includes("node_modules/")) return;
    dirs.add(packageDir(resolve(root, file.split("?")[0])));
  };
  // Match the SEA's entrypoint and externals. Only modules which contribute emitted bytes count.
  const engine = await build({ absWorkingDir: root, entryPoints: [join(server, "dist/cli.js")],
    platform: "node", target: "node22", format: "cjs", bundle: true, write: false, metafile: true,
    minify: true, keepNames: true, logLevel: "silent", define: { "import.meta.url": "__scarlet_import_meta_url" },
    external: ["node:sqlite", "bufferutil", "utf-8-validate"] });
  for (const output of Object.values(engine.metafile.outputs)) {
    for (const [file, data] of Object.entries(output.inputs)) if (data.bytesInOutput) addInput(file);
  }
  // Rollup exposes the actual release renderer module graph, including lazy chunks and Tauri's JS API.
  const vite = await import(pathToFileURL(requireWeb.resolve("vite")).href);
  const outputs = await vite.build({ root: web, configFile: join(web, "vite.config.ts"),
    logLevel: "error", build: { write: false } });
  for (const { output } of [outputs].flat()) for (const chunk of output) {
    if (chunk.type === "chunk") for (const id of chunk.moduleIds) addInput(id);
  }
  // The CSS and the native ONNX packages are distributed separately from these JS chunks.
  const addPackage = (req, name) => dirs.add(packageDir(req.resolve(name)));
  // These bundlers emit runtime helper code into the engine and renderer.
  addPackage(requireServer, "esbuild");
  addPackage(requireWeb, "vite");
  addPackage(createRequire(requireWeb.resolve("vite")), "rollup");
  const tailwind = createRequire(requireWeb.resolve("@tailwindcss/vite"));
  addPackage(tailwind, "tailwindcss");
  const speaker = createRequire(requireServer.resolve("sherpa-onnx-node"));
  const platform = process.platform === "win32" ? "win" : process.platform;
  for (const [req, name] of [[requireServer, "sherpa-onnx-node"], [speaker, `sherpa-onnx-${platform}-${process.arch}`],
    [requireServer, "onnxruntime-node"], [createRequire(requireServer.resolve("onnxruntime-node")), "onnxruntime-common"]]) addPackage(req, name);
  return [...dirs].map(dir => {
    const { name, version, license } = json(join(dir, "package.json"));
    const files = notices(dir);
    if (name.startsWith("sherpa-onnx-")) files.push(join(bundled, "sherpa-onnx.txt"));
    if (name.startsWith("onnxruntime-")) files.push(join(bundled, "onnxruntime.txt"), join(bundled, "onnxruntime-third-party.txt"));
    return { name: `${name}@${version}`, license, source: `https://www.npmjs.com/package/${name}/v/${version}`, files };
  });
}

export function targetCrates(metadata) {
  const packages = new Map(metadata.packages.map(p => [p.id, p]));
  const nodes = new Map(metadata.resolve.nodes.map(n => [n.id, n]));
  const visited = new Set(), todo = [metadata.resolve.root];
  while (todo.length) {
    const id = todo.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    for (const { pkg, dep_kinds } of nodes.get(id).deps) {
      if (dep_kinds.some(edge => edge.kind === null) && !packages.get(pkg).targets.some(t => t.kind.includes("proc-macro"))) todo.push(pkg);
    }
  }
  return [...visited].map(id => packages.get(id)).filter(pkg => pkg.source);
}

function rustRecords(target) {
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--locked", "--format-version", "1", "--filter-platform", target],
    { cwd: tauri, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  return targetCrates(metadata).map(pkg => {
    const dir = dirname(pkg.manifest_path);
    const files = notices(dir, true);
    if (pkg.license_file) files.push(resolve(dir, pkg.license_file));
    // Some published crate tarballs omit the workspace-root license of their release.
    if (pkg.repository === "https://github.com/madsmtm/objc2") files.push(join(sources, "objc2.md"), join(sources, "objc2-MIT.txt"));
    if (pkg.name === "selectors") files.push(join(sources, "MPL-2.0.txt"));
    if (pkg.name === "alloc-stdlib") files.push(join(sources, "alloc-stdlib.txt"));
    if (pkg.name === "dlopen2") files.push(join(sources, "dlopen2.txt"));
    if (pkg.name === "libappindicator-sys") {
      const workspace = metadata.packages.find(p => p.name === "libappindicator" && p.version === pkg.version);
      if (workspace) files.push(...notices(dirname(workspace.manifest_path)));
    }
    if (pkg.repository === "https://github.com/wravery/webview2-rs") files.push(join(sources, "webview2-rs.txt"));
    return { name: `${pkg.name}@${pkg.version}`, license: pkg.license || basename(pkg.license_file),
      source: `https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}/download`, files };
  });
}

async function nodeNotice() {
  const bin = dirname(process.execPath);
  // Both the official Windows ZIP and POSIX tarball contain the complete LICENSE for their exact executable.
  for (const candidate of [join(bin, "LICENSE"), join(bin, "../LICENSE")]) {
    if (existsSync(candidate) && read(candidate).startsWith("Node.js is licensed for use as follows:")) return read(candidate);
  }
  // Version managers can install just the binary.
  const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`);
  if (!response.ok) throw new Error(`Node ${process.version} license download returned ${response.status}`);
  const license = await response.text();
  if (!license.startsWith("Node.js is licensed for use as follows:")) throw new Error("Unexpected Node LICENSE contents");
  return license.trim();
}

async function main() {
  const [flag, explicitTarget] = process.argv.slice(2);
  const target = flag === "--target" ? explicitTarget : process.env.TAURI_ENV_TARGET_TRIPLE
    ?? execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (\S+)/m)?.[1];
  if ((flag && flag !== "--target") || !["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"].includes(target)) {
    throw new Error("Pass --target followed by a supported desktop target triple");
  }
  const dest = join(bundled, "runtime");
  const js = await javascriptRecords(), crates = rustRecords(target);
  const node = await nodeNotice();
  const sysroot = execFileSync("rustc", ["--print", "sysroot"], { encoding: "utf8" }).trim();
  const standardLibraryNotice = join(sysroot, "share/doc/rust/COPYRIGHT-library.html");
  if (!existsSync(standardLibraryNotice)) throw new Error("Install the rust-docs component for the release toolchain to include its standard-library notices.");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "node.txt"), `Node.js ${process.version}\nhttps://github.com/nodejs/node/blob/${process.version}/LICENSE\n\n${node}\n`);
  writeFileSync(join(dest, "javascript.txt"), renderNotices(js));
  writeFileSync(join(dest, "rust.txt"), renderNotices(crates));
  cpSync(standardLibraryNotice, join(dest, "rust-standard-library.html"));
  cpSync(join(sources, "whisper-audio-dependencies.txt"), join(dest, "whisper-audio-dependencies.txt"));
  cpSync(join(sources, "sherpa-dependencies.txt"), join(dest, "sherpa-dependencies.txt"));
  cpSync(join(sources, "onnxruntime-1.28.2-third-party.txt"), join(dest, "speaker-onnxruntime-1.28.2-third-party.txt"));
  if (target.endsWith("windows-msvc")) cpSync(join(import.meta.dirname, "windows-runtime-notices"), dest, { recursive: true });
  console.log(`Wrote notices for Node ${process.version}, ${js.length} JavaScript/native packages and ${crates.length} ${target} crates.`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
