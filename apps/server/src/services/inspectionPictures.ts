import {
  activityFilter, buildFilterGraph, contactSheet, fileInDirectory, packSheet, renderTimelineFrame,
  resolveFfmpeg, runCapture, sampleTimes, sheetScale, snapRange, type GraphOptions,
} from "@scarlet/render";
import type { InspectionWindow } from "@scarlet/shared";
import { timelineDuration, type Project, type Timeline, type TimeRange } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { clip, throttledLog } from "../logText.js";
import { AnalysisCache } from "./analysisCache.js";
import { pictureDecoder, pictureLane } from "./pictureWork.js";
import { previewPictures } from "./previewPictures.js";

type Mode = "uniform" | "scene" | "activity";
type Sheet = Pick<InspectionWindow, "timestamps" | "columns" | "jpeg" | "changedFrames">;
type Inputs = Pick<GraphOptions, "pictureSource" | "decoder">;
interface Block { first: number; changes: number[]; pixels?: Buffer; samples?: number[] }
const frameBytes = 320 * 180 * 3 / 2;

/** All indices are absolute project frames. The preceding frame seeds the
 * difference filter so a click on the first frame of a shared block survives. */
async function readBlock(project: Project, timeline: Timeline, mediaRoot: string, first: number, end: number,
  activity: boolean, height: number, inputs: Inputs, signal: AbortSignal, samples: number[] = []): Promise<Block> {
  const fps = project.settings.fps;
  const origin = Math.max(0, first - 1);
  const measure = activity ? `${activityFilter},metadata=print:key=lavfi.bbox.w`
    : "scale=160:-2,select='gt(scene,0.22)',metadata=print:key=lavfi.scene_score";
  const select = samples.map(i => `eq(n,${i - origin})`).join("+");
  const pixels = activity || samples.length > 0;
  const pictureFilter = pixels
    ? `split[measure][tiles];[measure]${measure},nullsink;[tiles]${select ? `select='${select}',` : ""}${sheetScale},pad=320:180:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p`
    : measure;
  const graph = await buildFilterGraph(project, timeline, { start: origin / fps, end: end / fps }, {
    ...inputs, mediaRoot, pictureOnly: true, pictureFilter, height, width: project.settings.width * height / project.settings.height,
  });
  try {
    const output = pixels ? ["-fps_mode", "passthrough", "-threads", "1", "-f", "rawvideo", "pipe:1"] : ["-f", "null", "-"];
    const bytes = frameBytes * (activity ? end - origin : samples.length);
    const { stdout, stderr } = await runCapture(resolveFfmpeg(), ["-hide_banner", "-nostdin", "-nostats", ...graph.args, ...output],
      { signal, maxStdout: bytes + frameBytes });
    if (pixels && stdout.length !== bytes) throw new Error("Incomplete inspection pictures.");
    const metadata = /\[Parsed_metadata_[^\]]+\]\s+frame:\s*\d+\s+pts:\s*-?\d+\s+pts_time:\s*([-+.\deE]+)/g;
    const changes = Array.from(stderr.matchAll(metadata), m => origin + Math.round(Number(m[1]) * fps))
      .filter(frame => frame >= first && frame < end);
    return { first: origin, changes, pixels: pixels ? stdout : undefined, samples };
  } finally { await graph.cleanup(); }
}

export function inspectionPictures(ctx: Ctx) {
  const blocks = new AnalysisCache<Block>(b => (b.pixels?.length ?? 0) + b.changes.length * 8, 48 * 1024 * 1024);
  // Scene detection reads continuous footage. Remember covered intervals so a new
  // request decodes each missing stretch once, including on overlapping batches.
  const sceneRanges = new Map<string, { identity: string; first: number; end: number }>();
  function sceneWindows(identity: string, first: number, end: number) {
    const existing = [...sceneRanges.values()].filter(w => w.identity === identity && w.first < end && w.end > first)
      .sort((a, b) => a.first - b.first);
    const windows: typeof existing = [];
    let cursor = first;
    for (const w of existing) {
      if (w.end <= cursor) continue;
      if (w.first > cursor) windows.push({ identity, first: cursor, end: w.first });
      windows.push(w);
      cursor = w.end;
      if (cursor >= end) break;
    }
    if (cursor < end) windows.push({ identity, first: cursor, end });
    for (const w of windows) sceneRanges.set(JSON.stringify([identity, w.first, w.end]), w);
    while (sceneRanges.size > 128) sceneRanges.delete(sceneRanges.keys().next().value!);
    return windows;
  }
  const scenes = new AnalysisCache<Block>(b => (b.pixels?.length ?? 0) + b.changes.length * 8, 24 * 1024 * 1024);
  const stills = new AnalysisCache<Buffer>(b => b.length, 12 * 1024 * 1024);
  const sheets = new AnalysisCache<Sheet>(s => s.jpeg.length + s.timestamps.length * 8, 24 * 1024 * 1024);
  // A GPU or a preview copy that fails does so for every block read, so the retry is logged once a minute.
  const retried = throttledLog(line => ctx.log(line));

  return async (project: Project, timeline: Timeline, requested: TimeRange, mode: Mode, count: number, focus?: number, requestSignal?: AbortSignal): Promise<InspectionWindow> => {
    const projectSignal = ctx.projectSignal(project.id);
    const subscriber = requestSignal ? AbortSignal.any([projectSignal, requestSignal]) : projectSignal;
    const fps = project.settings.fps, range = snapRange(requested, fps);
    const first = Math.round(range.start * fps), end = Math.round(range.end * fps);
    const height = Math.min(Math.max(mode === "activity" ? 540 : 180, ctx.settings().render.previewHeight), project.settings.height);
    const mediaRoot = ctx.paths.media(project.id);
    const identity = ctx.renders.inspectionKey(project, timeline.version);
    if (!identity) throw new Error("No stable timeline pictures.");
    const key = JSON.stringify([identity, first, end, mode, count, focus]);
    const analysis = await sheets.get(key, demand => ctx.track((async () => {
      const signal = AbortSignal.any([projectSignal, demand]);
      const cached = ctx.renders.coveringPreview(project, timeline.version, range, mode === "activity" ? height : Math.min(height, 180));
      const file = cached?.path && fileInDirectory(ctx.paths.renders(project.id), cached.path);
      if (file) {
        try {
          const origin = cached.range?.start ?? 0;
          return await pictureLane(ctx).run(() =>
            contactSheet(file, { start: range.start - origin, end: range.end - origin }, { origin, fps, count, mode, focus, signal }), { signal });
        } catch { signal.throwIfAborted(); } // A missing or damaged preview can be sampled from the original cut.
      }

      const activity = mode === "activity";
      if (activity && (end - first) * frameBytes > 64 * 1024 * 1024) throw new Error("Use the rendered preview for this frame rate.");
      const inputs: Inputs = { pictureSource: previewPictures(mediaRoot), decoder: await pictureDecoder(ctx.settings().render.hwaccel) };
      // Each decode takes its turn in the engine's picture lane, on the GPU when there is one.
      const lane = pictureLane(ctx);
      async function read<T>(demand: AbortSignal, fn: (inputs: Inputs, signal: AbortSignal) => Promise<T>) {
        const active = AbortSignal.any([projectSignal, demand]);
        try { return await lane.run(() => fn(inputs, active), { signal: active }); }
        catch (error) {
          active.throwIfAborted();
          retried("pictures", `[inspection] reading ${timeline.version} again from the originals on the CPU: ${clip((error as Error).message, 300)}`);
          return lane.run(() => fn({}, active), { signal: active });
        }
      }
      const changes = new Set<number>();
      const tiles = new Map<number, Buffer>();
      function indicesFor(detected: number[]) {
        const relativeFocus = focus === undefined ? undefined : focus - range.start;
        const times = sampleTimes((end - first) / fps, fps, count, detected, relativeFocus);
        // Match the first displayed frame at or after each requested sample.
        const frames = times.map(t => Math.min(end - 1, first + Math.max(0, Math.ceil(t * fps - 1e-6))));
        return [...new Set(frames)];
      }
      function collect(block: Block) {
        for (const frame of block.changes) if (frame > first && frame < end) changes.add((frame - first) / fps);
        if (!block.pixels) return;
        for (let n = 0; n < block.pixels.length / frameBytes; n++) {
          const index = block.samples?.length ? block.samples[n]! : block.first + n;
          if (index >= first && index < end) tiles.set(index, block.pixels.subarray(n * frameBytes, (n + 1) * frameBytes));
        }
      }
      if (activity) {
        const stride = Math.min(60, Math.max(1, Math.round(fps * 2)));
        const last = Math.max(end, Math.ceil(timelineDuration(timeline) * fps - 1e-7));
        for (let at = Math.floor(first / stride) * stride; at < end; at += stride) {
          const stop = Math.min(last, at + stride);
          collect(await blocks.get(JSON.stringify([identity, at, stop]), demand =>
            ctx.track(read(demand, (options, active) => readBlock(project, timeline, mediaRoot, at, stop, true, height, options, active))), { signal }));
        }
      } else if (mode === "scene") {
        const uniform = indicesFor([]);
        for (const w of sceneWindows(identity, first, end)) {
          const id = JSON.stringify([identity, w.first, w.end]);
          const samples = uniform.filter(i => i >= w.first && i < w.end);
          const sceneHeight = Math.min(height, 180, 320 * project.settings.height / project.settings.width);
          collect(await scenes.get(id, demand => ctx.track(read(demand, (options, active) =>
            readBlock(project, timeline, mediaRoot, w.first, w.end, false, sceneHeight, options, active, samples))), { signal }));
        }
      }
      const indices = indicesFor([...changes].sort((a, b) => a - b));
      const raw = indices.every(i => tiles.has(i));
      const frames: Buffer[] = [];
      for (const i of indices) {
        if (raw) frames.push(tiles.get(i)!);
        else frames.push(await stills.get(JSON.stringify([identity, i]), demand => ctx.track(read(demand, (options, active) =>
          renderTimelineFrame(project, timeline, { start: i / fps, end: (i + 1) / fps }, mediaRoot, active, 320, options))), { signal }));
      }
      const sheet = await packSheet(frames, indices.map(i => i / fps), raw, signal);
      return { ...sheet, changedFrames: activity ? changes.size : undefined };
    })()), { signal: subscriber });
    if (identity !== ctx.renders.inspectionKey(project, timeline.version)) throw new Error("Timeline inputs changed during inspection.");
    return { label: "Composite", clock: "timeline", id: timeline.version, range, focus, ...analysis };
  };
}
