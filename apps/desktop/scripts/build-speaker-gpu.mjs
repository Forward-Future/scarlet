// Build the GPU speaker runtime for Windows: the speaker-analysis addon Scarlet already ships, with sherpa-onnx built
// against ONNX Runtime's DirectML package, which runs on any DirectX 12 GPU. The engine tries binaries/speaker-gpu/
// first and keeps the CPU runtime as the fallback. Other platforms have nothing to build.
//
// The npm build of sherpa-onnx has no GPU support, and sherpa-onnx's own DirectML option downloads ONNX Runtime 1.14,
// which can't load the segmentation model (opset 19). So this links the C API against ONNX Runtime DirectML 1.22, the
// version onnxruntime-node ships, and takes the Node addon and its C++ wrapper from the npm package of the same version.
//
// GitHub builds the released installers, so there this runtime is required. Anywhere else (a developer's PC, or the
// Windows main launcher) a failed build costs only the GPU: this says so and ships without it, so a PC that can't
// reach the downloads or compile them keeps building and updating.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sherpaVersion = "2.0.1";
const sherpaHash = "24ecc0fccf6344c2556e7c229c849e9f61bf9456b915615197d85f35e3f177e7";
const ortVersion = "1.22.0";
const ortHash = "29f9872d786236b79aa83f94482f3a17c14297e4833768d6d0ed4883ee732e60";

if (process.platform !== "win32" || process.arch !== "x64") process.exit(0);
const gpuRequired = !!process.env.GITHUB_ACTIONS;
const bin = fileURLToPath(new URL("../src-tauri/binaries/", import.meta.url));
const output = join(bin, "speaker-gpu");
const files = ["sherpa-onnx.node", "sherpa-onnx-cxx-api.dll", "sherpa-onnx-c-api.dll", "onnxruntime.dll", "onnxruntime_providers_shared.dll", "DirectML.dll"];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const recipe = sha(readFileSync(fileURLToPath(import.meta.url)));
const receipt = join(output, "runtime.sha256");
const stamp = () => `${recipe} ${sha(Buffer.concat(files.map(f => readFileSync(join(output, f)))))}`;

async function make() {
  // The addon comes from the npm package. Its C API must be built from the same sherpa-onnx release.
  const server = createRequire(fileURLToPath(new URL("../../server/package.json", import.meta.url)));
  const sherpaNode = createRequire(server.resolve("sherpa-onnx-node"));
  const npmRuntime = dirname(sherpaNode.resolve("sherpa-onnx-win-x64"));
  const npmVersion = JSON.parse(readFileSync(join(npmRuntime, "package.json"), "utf8")).version;
  if (npmVersion !== sherpaVersion) throw new Error(`Update build-speaker-gpu.mjs to sherpa-onnx ${npmVersion} (it builds ${sherpaVersion}).`);
  const ortNode = dirname(server.resolve("onnxruntime-node/package.json"));
  const ortNodeVersion = JSON.parse(readFileSync(join(ortNode, "package.json"), "utf8")).version;
  if (ortNodeVersion !== ortVersion) throw new Error(`Update build-speaker-gpu.mjs to ONNX Runtime ${ortNodeVersion} (it links ${ortVersion}).`);

  if (existsSync(receipt) && files.every(f => existsSync(join(output, f))) && readFileSync(receipt, "utf8") === stamp()) {
    console.log(`[speaker-gpu] verified ${output}`);
    return;
  }

  async function download(url, hash, file) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} for ${url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha(bytes) !== hash) throw new Error(`Checksum mismatch for ${url}`);
    writeFileSync(file, bytes);
  }

  // Short names keep the nested dependency builds under Windows' 260-character path limit.
  const work = mkdtempSync(join(tmpdir(), "ssg-"));
  try {
    const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    await download(`https://codeload.github.com/k2-fsa/sherpa-onnx/tar.gz/refs/tags/v${sherpaVersion}`, sherpaHash, join(work, "sherpa.tgz"));
    // Only what the C API build reads: the examples and app folders hold symbolic links that Windows’ tar can’t create.
    execFileSync(tar, ["-xzf", join(work, "sherpa.tgz"), "-C", work,
      ...["CMakeLists.txt", "LICENSE", "cmake", "sherpa-onnx"].map(p => `sherpa-onnx-${sherpaVersion}/${p}`)]);
    // A NuGet package is a zip archive, which Windows' tar reads.
    const ort = join(work, "ort");
    mkdirSync(ort);
    await download(`https://www.nuget.org/api/v2/package/Microsoft.ML.OnnxRuntime.DirectML/${ortVersion}`, ortHash, join(work, "ort.zip"));
    execFileSync(tar, ["-xf", join(work, "ort.zip"), "-C", ort]);
    const ortNative = join(ort, "runtimes", "win-x64", "native");

    const cmake = process.env.CMAKE_COMMAND || "cmake";
    const build = join(work, "b");
    // ENABLE_GPU is what makes sherpa-onnx link a preinstalled ONNX Runtime by its import library on Windows. The CUDA
    // paths it adds only run for the "cuda" provider, which Scarlet never asks for.
    execFileSync(cmake, ["-S", join(work, `sherpa-onnx-${sherpaVersion}`), "-B", build, "-A", "x64", "-DCMAKE_BUILD_TYPE=Release",
      "-DBUILD_SHARED_LIBS=ON", "-DSHERPA_ONNX_ENABLE_DIRECTML=ON", "-DSHERPA_ONNX_ENABLE_GPU=ON", "-DSHERPA_ONNX_ENABLE_C_API=ON",
      "-DSHERPA_ONNX_ENABLE_BINARY=OFF", "-DSHERPA_ONNX_ENABLE_PYTHON=OFF", "-DSHERPA_ONNX_ENABLE_TESTS=OFF",
      "-DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF", "-DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF"], {
      stdio: "inherit",
      env: { ...process.env, SHERPA_ONNXRUNTIME_INCLUDE_DIR: join(ort, "build", "native", "include"), SHERPA_ONNXRUNTIME_LIB_DIR: ortNative },
    });
    execFileSync(cmake, ["--build", build, "--config", "Release", "--target", "sherpa-onnx-c-api", "--parallel", "8"], { stdio: "inherit" });

    rmSync(output, { recursive: true, force: true });
    mkdirSync(output, { recursive: true });
    copyFileSync(join(npmRuntime, "sherpa-onnx.node"), join(output, "sherpa-onnx.node"));
    copyFileSync(join(npmRuntime, "sherpa-onnx-cxx-api.dll"), join(output, "sherpa-onnx-cxx-api.dll"));
    copyFileSync(join(build, "bin", "Release", "sherpa-onnx-c-api.dll"), join(output, "sherpa-onnx-c-api.dll"));
    copyFileSync(join(ortNative, "onnxruntime.dll"), join(output, "onnxruntime.dll"));
    copyFileSync(join(ortNative, "onnxruntime_providers_shared.dll"), join(output, "onnxruntime_providers_shared.dll"));
    // The DirectML that ONNX Runtime 1.22 was built against, as onnxruntime-node ships it.
    copyFileSync(join(ortNode, "bin", "napi-v6", "win32", "x64", "DirectML.dll"), join(output, "DirectML.dll"));
    writeFileSync(receipt, stamp());
    console.log(`[speaker-gpu] built ${output}`);
  } finally {
    // A compiler or a virus scanner can still hold a file. A folder left in the temp directory is no reason to stop,
    // or to count a finished runtime as failed.
    try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); }
    catch { console.warn(`[speaker-gpu] left ${work} behind`); }
  }
}

try {
  await make();
} catch (error) {
  if (gpuRequired) throw error;
  // This build has no GPU runtime: nothing half-built, or built for other versions of the addon, may ship. An empty
  // addon takes its place. The engine skips an empty one and analyses speakers on the CPU runtime it always carries,
  // and the installer writes it over the addon of an earlier update, which an update would otherwise leave installed.
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "sherpa-onnx.node"), "");
  console.warn(`[speaker-gpu] not built, so this build analyses speakers on the CPU: ${error.message}`);
}
