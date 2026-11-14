// Build the self-contained whisper-cli sidecars from the pinned upstream source.
//
// macOS: one build, which runs on the GPU through Metal.
// Linux x64: one CPU build for Ubuntu amd64.
// Windows: the CPU build every PC can run, and a Vulkan build in binaries/whisper-gpu/ that the engine tries first.
// Vulkan runs on any recent NVIDIA, AMD or Intel GPU and needs only the driver's loader at run time. Building it
// needs the Vulkan SDK (VULKAN_SDK with Include, Lib/vulkan-1.lib and Bin/glslc.exe); GitHub's workflow installs it.
//
// GitHub builds the released installers, so there the Vulkan build is required. Anywhere else (a developer's PC, or
// the Windows main launcher, which also sets CI) a missing SDK or a failed Vulkan build costs only the GPU: this
// says so and ships the CPU build, so a PC without the SDK keeps building and updating.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const revision = "d1be6fde11ac6e0407606b4e42fe72d34add8037"; // whisper.cpp v1.9.5
const sourceHash = "645445da884df6dbd52b30f82d7be7c01d1767c938714e477e786b88d529e9f4";
const triples = { "win32-x64": "x86_64-pc-windows-msvc", "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin", "linux-x64": "x86_64-unknown-linux-gnu" };
const target = triples[`${process.platform}-${process.arch}`];
if (!target || (process.env.TAURI_ENV_TARGET_TRIPLE && process.env.TAURI_ENV_TARGET_TRIPLE !== target)) {
  throw new Error("Build whisper-cli on the target architecture (Windows x64, macOS arm64/x64 or Linux x64).");
}
const windows = process.platform === "win32";
const platformFlags = {
  win32: ["-A", "x64", "-DCMAKE_POLICY_DEFAULT_CMP0091=NEW", "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded"],
  darwin: ["-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0", "-DGGML_METAL_EMBED_LIBRARY=ON"],
  // GGML_NATIVE=OFF still enables AVX2 and related extensions by default on a native x64 build.
  linux: ["-DGGML_AVX=OFF", "-DGGML_AVX2=OFF", "-DGGML_BMI2=OFF", "-DGGML_F16C=OFF", "-DGGML_FMA=OFF", "-DGGML_SSE42=OFF"],
}[process.platform];
const bin = fileURLToPath(new URL("../src-tauri/binaries/", import.meta.url));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const recipe = sha(readFileSync(fileURLToPath(import.meta.url)));

const gpuRequired = !!process.env.GITHUB_ACTIONS;
const verified = ({ output }) => {
  const receipt = output + ".sha256";
  return existsSync(receipt) && existsSync(output) && readFileSync(receipt, "utf8") === `${recipe} ${sha(readFileSync(output))}`;
};

const variants = [{ name: "CPU", output: join(bin, `whisper-cli-${target}${windows ? ".exe" : ""}`), flags: [] }];
const gpu = windows && { name: "Vulkan", output: join(bin, "whisper-gpu", "whisper-cli.exe"), flags: ["-DGGML_VULKAN=ON"], optional: !gpuRequired };
if (gpu) {
  if (process.env.VULKAN_SDK) variants.push(gpu);
  else if (gpuRequired) throw new Error("Install the Vulkan SDK to build the GPU whisper-cli (VULKAN_SDK is unset).");
  else if (verified(gpu)) console.warn("[whisper] VULKAN_SDK is unset. Keeping the GPU whisper-cli this recipe built earlier.");
  else console.warn("[whisper] VULKAN_SDK is unset, so this build has no GPU whisper-cli and transcribes on the CPU.");
}

const pending = variants.filter(variant => {
  if (!verified(variant)) return true;
  console.log(`[whisper] verified ${variant.output}`);
  return false;
});

if (windows) {
  // The installer ships this folder as a resource, so it is never empty, with or without the GPU build.
  mkdirSync(join(bin, "whisper-gpu"), { recursive: true });
  writeFileSync(join(bin, "whisper-gpu", "README.txt"), "Scarlet tries the Vulkan whisper-cli in this folder before the CPU build beside the engine.\n");
}

if (pending.length) {
  // Short names: the Vulkan shader generator builds as a nested project, deep enough to pass Windows’ 260-character path limit.
  const work = mkdtempSync(join(tmpdir(), "swb-"));
  try {
    const response = await fetch(`https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/${revision}`);
    if (!response.ok) throw new Error(`whisper.cpp source download failed: HTTP ${response.status}`);
    const source = Buffer.from(await response.arrayBuffer());
    if (sha(source) !== sourceHash) throw new Error("whisper.cpp source checksum mismatch");
    const archive = join(work, "source.tgz");
    writeFileSync(archive, source);
    execFileSync(windows ? join(process.env.SystemRoot, "System32", "tar.exe") : "tar", ["-xzf", archive, "-C", work]);
    const cmake = process.env.CMAKE_COMMAND || "cmake";
    for (const { name, output, flags } of pending) {
      console.log(`[whisper] building the ${name} whisper-cli`);
      const build = join(work, name === "CPU" ? "c" : "g");
      execFileSync(cmake, ["-S", join(work, `whisper.cpp-${revision}`), "-B", build, "-DCMAKE_BUILD_TYPE=Release",
        "-DBUILD_SHARED_LIBS=OFF", "-DGGML_NATIVE=OFF", "-DGGML_OPENMP=OFF", "-DWHISPER_BUILD_TESTS=OFF",
        "-DWHISPER_BUILD_EXAMPLES=ON", "-DWHISPER_BUILD_SERVER=OFF", "-DWHISPER_CURL=OFF", ...flags, ...platformFlags], { stdio: "inherit" });
      execFileSync(cmake, ["--build", build, "--config", "Release", "--target", "whisper-cli", "--parallel", "4"], { stdio: "inherit" });
      mkdirSync(dirname(output), { recursive: true });
      copyFileSync(windows ? join(build, "bin/Release/whisper-cli.exe") : join(build, "bin/whisper-cli"), output);
      if (!windows) chmodSync(output, 0o755);
      // A Vulkan build starts only where a driver installed the Vulkan loader, which a CI runner may lack.
      if (!flags.length || existsSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "vulkan-1.dll"))) {
        execFileSync(output, ["--help"], { stdio: "ignore" });
      }
      writeFileSync(output + ".sha256", `${recipe} ${sha(readFileSync(output))}`);
    }
  } catch (error) {
    // A failed download or build stops everything unless only the optional GPU program is still missing.
    if (pending.some(variant => !variant.optional && !verified(variant))) throw error;
    console.warn(`[whisper] the GPU whisper-cli did not build, so this build transcribes on the CPU: ${error.message}`);
  } finally {
    // A compiler or a virus scanner can still hold a file. A folder left in the temp directory is no reason to stop.
    try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); }
    catch { console.warn(`[whisper] left ${work} behind`); }
  }
}

if (gpu && !verified(gpu)) {
  // This build has no GPU program. An empty file takes its place: the engine skips an empty program, and the
  // installer writes it over the GPU program of an earlier update, which an update would otherwise leave installed.
  if (statSync(gpu.output, { throwIfNoEntry: false })?.size) console.warn("[whisper] removed a GPU whisper-cli that is not a verified build of this recipe.");
  rmSync(gpu.output + ".sha256", { force: true });
  writeFileSync(gpu.output, "");
}
