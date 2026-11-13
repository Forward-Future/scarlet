// Keep the native ONNX addon on disk where Node can load it from the desktop bundle.
// Only the current build target is shipped. Model weights are verified on first use.
import { createRequire } from "node:module";
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { build } from "esbuild";

export async function bundleUhmRuntime(destination) {
  const req = createRequire(import.meta.url);
  const entry = req.resolve("onnxruntime-node");
  const native = join("bin", "napi-v6", process.platform, process.arch);
  mkdirSync(join(destination, "dist"), { recursive: true });
  await build({ entryPoints: [entry], outfile: join(destination, "dist", "runtime.cjs"),
    platform: "node", format: "cjs", target: "node22", bundle: true, minify: true,
    external: ["../bin/napi-v6/*"], legalComments: "eof" });
  cpSync(join(dirname(entry), "..", native), join(destination, native), { recursive: true });
}
