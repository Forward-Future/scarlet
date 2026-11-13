// Compare ordinary stream discovery with header-only seeks on picture inputs in real A/V edits.
// node packages/render/bench/mixed-index.mjs <fixture-root> <frame[,frame...]> [repetitions]
// The optional split mode is an experiment. It opens a second handle for shared A/V inputs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MediaAsset, ProjectSettings, Timeline } from "@scarlet/timeline";
import { buildFilterGraph } from "../dist/graph.js";
import { INDEXED_MP4_INPUT, resolveFfmpeg, runCapture } from "../dist/exec.js";
import { probeMedia } from "../dist/probe.js";

export async function measureGraph(project, timeline, range, mediaRoot, height, mode, debug) {
  const { settings } = project;
  const graph = await buildFilterGraph(project, timeline, range, {
    width: Math.round(height * settings.width / settings.height / 2) * 2, height, mediaRoot, indexedInputs: false,
  });
  try {
    let at = 0, selected = 0, added = 0, ordinary = 0;
    const inputs = [], duplicates = [], traces = [], base = graph.args;
    let script = graph.graph;
    for (const [i, file] of graph.inputs.entries()) {
      const stop = base.indexOf("-i", at);
      assert(stop >= at && base[stop + 1] === file);
      const args = base.slice(at, stop + 2);
      const hasPicture = script.includes("[" + i + ":v]");
      const hasSound = script.includes("[" + i + ":a]");
      const probe = hasPicture && mode !== "normal" ? await probeMedia(file) : undefined;
      const eligible = probe?.videoCodec === "h264" && probe.videoStreamCount === 1 && !probe.hasAlpha &&
        probe.formatName?.split(",").includes("mov") && probe.rotation === 0 && probe.pixFmt === "yuv420p" &&
        probe.previewClock?.startPts === 0 && probe.videoStart === 0;
      if (mode !== "normal" && eligible && !hasSound) {
        inputs.push(...INDEXED_MP4_INPUT, ...args); selected++;
      } else {
        if (mode !== "normal") inputs.push("-find_stream_info");
        inputs.push(...args); ordinary++;
        if (mode === "split" && eligible && hasSound) {
          const index = graph.inputs.length + added++;
          duplicates.push(...INDEXED_MP4_INPUT, ...args);
          script = script.replaceAll("[" + i + ":v]", "[" + index + ":v]");
          selected++;
        }
      }
      traces.push({ picture: hasPicture, sound: hasSound });
      at = stop + 2;
    }
    if (added) await writeFile(graph.scriptPath, script);
    const start = performance.now();
    const { stdout, stderr } = await runCapture(resolveFfmpeg(), ["-hide_banner", "-nostdin", "-v", debug ? "debug" : "error",
      ...inputs, ...duplicates, ...base.slice(at), "-c:v", "rawvideo", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le",
      "-f", "framemd5", "-"], { signal: AbortSignal.timeout(25000) });
    const ms = Math.round(performance.now() - start), lines = stdout.toString().split("\n").filter(l => /^\d+,/.test(l));
    const streams = [0, 1].map(i => {
      const packets = lines.filter(l => l.startsWith(i + ","));
      assert(packets.length);
      return { packets: packets.length, hash: createHash("sha256").update(packets.join("\n")).digest("hex") };
    });
    const scans = debug ? (stderr.match(/Before avformat_find_stream_info\(\)/g) ?? []).length : undefined;
    return { ms, selected, ordinary, added, scans, streams, traces };
  } finally { await graph.cleanup(); }
}

async function run() {
  const [root, list, n = "1", modes = "normal,separate"] = process.argv.slice(2);
  const m = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")), dir = join(root, "data");
  const db = new DatabaseSync(join(dir, "scarlet.db"), { readOnly: true });
  let project, timeline;
  try {
    timeline = Timeline.parse(JSON.parse(db.prepare("select json from timeline_versions where project_id=? and version=?").get(m.projectId, m.version).json));
    project = { id: m.projectId, settings: ProjectSettings.parse(m.settings),
      media: db.prepare("select json from media where project_id=?").all(m.projectId).map(r => MediaAsset.parse(JSON.parse(r.json))) };
  } finally { db.close(); }
  const variants = modes.split(",");
  assert(variants.includes("normal") && variants.every(m => ["normal", "separate", "split"].includes(m)));
  const frames = list.split(",").map(Number), results = [];
  for (let pass = 0; pass < Number(n); pass++) for (const [f, frame] of frames.entries()) {
    const time = frame / m.settings.fps, range = m.playbackRanges.find(r => r.start <= time && r.end > time);
    assert(range);
    for (let i = 0; i < variants.length; i++) {
      const mode = variants[(i + pass + f) % variants.length];
      const outcome = await measureGraph(project, timeline, range, join(dir, "projects", m.projectId, "media"), m.render.previewHeight, mode, pass === 0);
      console.log(JSON.stringify({ pass, frame, mode, ...outcome }));
      results.push({ frame, ...outcome });
    }
  }
  for (const frame of frames) {
    const r = results.filter(row => row.frame === frame);
    for (const row of r) assert.deepEqual(row.streams, r[0].streams, "Decoded A/V packets or timestamps differ");
  }
}
if (process.argv[1]?.endsWith("mixed-index.mjs")) await run();
