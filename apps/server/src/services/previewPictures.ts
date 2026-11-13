import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { probeMedia, proxyCheckpoint } from "@scarlet/render";
import {
  sha256,
  SOURCE_PREVIEW_SECONDS,
  type MediaAsset,
} from "@scarlet/timeline";

async function sourceStamp(file: string) {
  const info = await stat(file).catch(() => undefined);
  return info ? JSON.stringify([info.size, info.mtimeMs, info.ctimeMs]) : "";
}

/** Early imports stay local to this exact file. Only a verified source may publish under its hash. */
export async function previewIdentity(mediaRoot: string, asset: MediaAsset) {
  const file = join(mediaRoot, asset.path), stamp = await sourceStamp(file);
  const recorded = asset.fingerprintStamp;
  const verified = recorded && stamp === JSON.stringify([recorded.size, recorded.mtimeMs, recorded.ctimeMs]);
  const local = sha256(JSON.stringify([asset.id, asset.path, stamp]));
  const shared = verified && asset.hash ? sha256(asset.hash) : undefined;
  // Old range encodes can contain a duplicate even when their duration and reported rate match.
  // Long recordings without a verified steady clock may contain VFR checkpoints with millisecond-rounded frame offsets.
  const clock = asset.kind === "video" && (asset.duration ?? 0) > 30 && !asset.previewClock ? "proxy-clock-v3:" : "proxy-clock-v2:";
  return { file, local: sha256(clock + local), shared: shared && sha256(clock + shared),
    legacyKeys: shared ? [shared, local] : [local], present: !!stamp, async check() {
    if (await sourceStamp(file) !== stamp) throw new Error("Source changed while preparing its preview.");
  } };
}

/** Smallest usable proxy first. The original unsuffixed files were capped at 720p. */
export function fullProxyVariants(root: string, keys: string[], sourceHeight?: number) {
  const max = Math.max(2, 2 * Math.floor(Math.min(720, sourceHeight ?? 720) / 2));
  const heights = new Set([360, 480, 540, 720].map(height => Math.min(height, max)));
  return [...heights].flatMap(height => {
    const suffix = height === max ? "" : `-${height}`;
    return keys.map(key => ({ height, suffix, file: join(root, `cached-${key}${suffix}.mp4`) }));
  });
}

export const sourceCheckpointDir = (root: string, local: string, suffix: string) => join(root, "parts-v1-" + local + suffix);

/** FFmpeg seeks relative to the container. A fractional-rate chunk's first
 * picture can be one frame later than the start of its audio. */
async function clockedPicture(mediaRoot: string, asset: MediaAsset, file: string, chunkStart: number | undefined, minimumHeight: number, signal?: AbortSignal, legacyFull = false) {
  if (!asset.fps) return;
  try {
    const [source, proxy] = await Promise.all([probeMedia(join(mediaRoot, asset.path), { signal }), probeMedia(file, { signal })]);
    if (source.hasAlpha || source.videoStreamCount !== 1 || !source.previewClock ||
        source.videoStart === undefined || Math.abs(source.fps - asset.fps) > 1e-6) return;
    if (chunkStart !== undefined && (source.previewClock.startPts !== 0 || source.videoStart !== 0)) return;
    const expectedStart = chunkStart === undefined ? source.videoStart : 0;
    if (!proxy.previewClock || proxy.videoStart === undefined || Math.abs(source.fps - proxy.fps) > 1e-6 ||
        Math.abs(proxy.videoStart - expectedStart) > 1 / source.fps + 1e-6) return;
    if (legacyFull) {
      // Padding can replace the last picture and leave the count unchanged. A one-to-one
      // encode keeps the source origin or rounds it to the nearest encoder frame tick.
      const roundedStart = Math.round(expectedStart * source.fps) / source.fps;
      const originError = Math.min(Math.abs(proxy.videoStart - expectedStart), Math.abs(proxy.videoStart - roundedStart));
      // The MP4 movie edit list can quantize that origin to milliseconds.
      if (!source.videoFrameCount || source.videoFrameCount !== proxy.videoFrameCount || originError > 0.001001) return;
    }
    if (proxy.height < minimumHeight || source.width !== asset.width || source.height !== asset.height ||
        Math.abs(source.width * proxy.height / source.height - proxy.width) > 2) return;
    return { file, start: (chunkStart ?? source.videoStart) - proxy.videoStart };
  } catch { signal?.throwIfAborted(); return; }
}

/** Reuse an older complete encode only when its picture clock and frame count still match. */
export async function legacyFullPicture(mediaRoot: string, asset: MediaAsset, keys: string[], minimumHeight: number, signal?: AbortSignal, fileKey?: string, knownFiles?: ReadonlySet<string>) {
  const root = join(dirname(mediaRoot), "proxies");
  for (const { file, height } of fullProxyVariants(root, keys, asset.height)) {
    if (height < minimumHeight || (fileKey !== undefined && basename(file) !== fileKey)) continue;
    if (knownFiles && !knownFiles.has(basename(file))) continue;
    if (!(await stat(file).catch(() => undefined))?.size) continue;
    const picture = await clockedPicture(mediaRoot, asset, file, undefined, minimumHeight, signal, true);
    if (picture) return picture;
  }
}

/** Source preview chunks are independently decodable. Use picture only, and only at adequate resolution. */
export function previewPictures(mediaRoot: string, frame?: { signal?: AbortSignal }) {
  const root = join(dirname(mediaRoot), "proxies");
  return async (
    asset: MediaAsset,
    from: number,
    to: number,
    minimumHeight: number,
  ) => {
    if (
      asset.hasAlpha !== false ||
      !asset.fps ||
      !asset.height
    )
      return;
    const { local, shared, present, legacyKeys } = await previewIdentity(mediaRoot, asset);
    if (!present || (asset.fingerprintStamp && !shared)) return;
    // A source cached before hashing or uploaded without a saved fingerprint can
    // still use the writer's asset-local path bound to this exact file stamp.
    const keys = shared ? [shared, local] : [local];
    for (const { file, height } of fullProxyVariants(root, keys, asset.height)) {
      if (height >= minimumHeight && (await stat(file).catch(() => null))?.size) {
        // Older imports only recorded stream PTS. Their container can start
        // before the video even when its first absolute PTS was zero.
        if (!frame && asset.previewClock?.videoStart === 0) return { file, start: 0 };
        return clockedPicture(mediaRoot, asset, file, undefined, minimumHeight, frame?.signal);
      }
    }
    const legacy = await legacyFullPicture(mediaRoot, asset, legacyKeys, minimumHeight, frame?.signal);
    if (legacy) return legacy;
    const stream = asset.previewClock,
      rate = stream?.frameRate?.split("/").map(Number);
    if (
      !rate ||
      !rate[0] ||
      !rate[1] ||
      Math.abs(rate[0] / rate[1] - asset.fps) > 1e-6 ||
      stream?.startPts !== 0
    )
      return;
    if (asset.duration && asset.duration > 30) {
      for (const { height, suffix } of fullProxyVariants(root, [local], asset.height)) {
        if (height < minimumHeight) continue;
        const part = await proxyCheckpoint(sourceCheckpointDir(root, local, suffix), height, asset.fps, from, to);
        if (part) {
          const picture = await clockedPicture(mediaRoot, asset, part.file, part.start, minimumHeight, frame?.signal);
          if (picture) return picture;
        }
      }
    }
    const index = Math.floor(from / SOURCE_PREVIEW_SECONDS), start = index * SOURCE_PREVIEW_SECONDS;
    if (to > start + SOURCE_PREVIEW_SECONDS + 0.000001 || Math.min(480, asset.height) < minimumHeight) return;
    // An eight-second boundary rarely lands on a 30000/1001 picture frame.
    for (const height of new Set([Math.min(360, asset.height), Math.min(480, asset.height)])) {
      if (2 * Math.floor(height / 2) < minimumHeight) continue;
      for (const key of keys) {
        const file = join(root, "source-" + key, `v1-${height}-${index}.mp4`);
        if ((await stat(file).catch(() => null))?.size)
          return clockedPicture(mediaRoot, asset, file, Math.ceil(start * asset.fps - 1e-7) / asset.fps, minimumHeight, frame?.signal);
      }
    }
  };
}
