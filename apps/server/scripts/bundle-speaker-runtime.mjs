import { createRequire } from "node:module";
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

export function bundleSpeakerRuntime(destination) {
  const require = createRequire(import.meta.url);
  const runtime = createRequire(require.resolve("sherpa-onnx-node"));
  const platform = process.platform === "win32" ? "win" : process.platform;
  const source = dirname(runtime.resolve(`sherpa-onnx-${platform}-${process.arch}`));
  mkdirSync(destination, { recursive: true });
  for (const file of readdirSync(source)) {
    if (/\.(node|dll|dylib|so(?:\..*)?)$/i.test(file)) cpSync(join(source, file), join(destination, file), { dereference: true });
  }
}
