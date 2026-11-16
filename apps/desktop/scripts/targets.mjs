// Shared by the scripts that fetch or build the desktop app's bundled tools.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** The Rust target each supported Node platform and architecture builds for. */
export const HOST_TRIPLES = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
};

/** This machine's Rust target, or undefined when Scarlet doesn't build for it. */
export function hostTripleOrNone() {
  return HOST_TRIPLES[`${process.platform}-${process.arch}`];
}

export function hostTriple() {
  const triple = hostTripleOrNone();
  if (!triple) throw new Error(`no default target for ${process.platform}-${process.arch}; pass --target`);
  return triple;
}

/** The value after `name` in `args`, as in `--target <triple>`. */
export function option(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** bsdtar reads zips on Windows 10+ and macOS; Git Bash's GNU tar does not, hence the explicit path. */
export function unzip(zip, dest) {
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
