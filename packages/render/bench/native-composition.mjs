// Profile exact composited stills against a disposable native-playback fixture.
// node packages/render/bench/native-composition.mjs <fixture-root> <frame,frame,...> [variants] [rounds]
// Variants can be sw, indexed, vt, vt-indexed, vt-device-indexed. The default software path is the pixel reference.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MediaAsset, ProjectSettings, Timeline } from "@scarlet/timeline";
import { buildFilterGraph } from "../dist/graph.js";
import { resolveFfmpeg, runCapture } from "../dist/exec.js";

const [fixture, list, selection = "sw,indexed,vt,vt-indexed", passes = "1"] = process.argv.slice(2);
const frames = list?.split(",").map(Number), variants = selection.split(","), rounds = Number(passes);
assert(fixture && frames?.every(n => Number.isInteger(n) && n >= 0) && Number.isInteger(rounds) && rounds > 0);
assert(variants.includes("sw") && variants.every(n => ["sw", "indexed", "vt", "vt-indexed", "vt-device-indexed"].includes(n)));
const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
const db = new DatabaseSync(join(fixture, "data", "scarlet.db"), { readOnly: true });
let timeline, media;
try {
  timeline = Timeline.parse(JSON.parse(db.prepare("SELECT json FROM timeline_versions WHERE project_id=? AND version=?").get(manifest.projectId, manifest.version).json));
  media = db.prepare("SELECT json FROM media WHERE project_id=?").all(manifest.projectId).map(r => MediaAsset.parse(JSON.parse(r.json)));
} finally { db.close(); }
const root = join(fixture, "data", "projects", manifest.projectId, "media");
const regular = { id: manifest.projectId, media, settings: ProjectSettings.parse(manifest.settings) };
const { fps, width, height } = regular.settings, scale = 960 / Math.max(width, height);
const hashes = new Map();
for (let pass = 0; pass < rounds; pass++) {
  for (const frame of frames) {
    for (let i = 0; i < variants.length; i++) {
      const mode = variants[(i + pass + frames.indexOf(frame)) % variants.length];
      const start = performance.now();
      const graph = await buildFilterGraph(regular, timeline,
        { start: frame / fps, end: (frame + 1) / fps }, { mediaRoot: root, width: scale * width, height: scale * height,
          singleFrame: true, indexedInputs: mode.includes("indexed"), decoder: mode.startsWith("vt") ? "videotoolbox" : undefined });
      try {
        if (mode === "vt-device-indexed") {
          const deviceInputs = new Set();
          let input = 0, hardware = false;
          for (let j = 0; j < graph.args.length; j++) {
            if (graph.args[j] === "-hwaccel" && graph.args[j + 1] === "videotoolbox") {
              hardware = true;
              graph.args.splice(j + 2, 0, "-hwaccel_output_format", "videotoolbox_vld");
            }
            if (graph.args[j] === "-i") {
              if (hardware) deviceInputs.add(input);
              input++;
              hardware = false;
            }
          }
          const filters = graph.graph.replace(/(\[(\d+):v\]trim=[^,;]+,)/g,
            (prefix, _, n) => deviceInputs.has(Number(n)) ? prefix + "hwdownload,format=nv12," : prefix);
          await writeFile(graph.scriptPath, filters);
        }
        const { stdout } = await runCapture(resolveFfmpeg(), ["-hide_banner", "-loglevel", "error", "-nostdin", ...graph.args,
          "-frames:v", "1", "-pix_fmt", "yuv420p", "-c:v", "rawvideo", "-f", "rawvideo", "pipe:1"], { signal: AbortSignal.timeout(8000) });
        assert.equal(stdout.length, Math.round(scale * width) * Math.round(scale * height) * 3 / 2);
        const hash = createHash("sha256").update(stdout).digest("hex");
        const recorded = hashes.get(frame) ?? [];
        recorded.push({ mode, pass, hash });
        hashes.set(frame, recorded);
        console.log(JSON.stringify({ pass, frame, mode, ms: Math.round(performance.now() - start), hash, inputs: graph.inputs.length,
          indexed: graph.args.filter(a => a === "-nofind_stream_info").length }));
      } finally { await graph.cleanup(); }
    }
  }
}
for (const [frame, values] of hashes) {
  const ordinary = values.find(v => v.mode === "sw").hash;
  for (const value of values) if (value.hash !== ordinary) console.log(JSON.stringify({ frame, ...value, mismatch: true }));
}
