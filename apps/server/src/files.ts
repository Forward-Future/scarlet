import { createReadStream, statSync } from "node:fs";
import { extname } from "node:path";
import { Readable } from "node:stream";
import { HttpError } from "./errors.js";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".flac": "audio/flac",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".otio": "application/json",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

export function contentTypeFor(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Offer only a probed audio/video stream served with its matching media type. */
export function originalPlaybackType(path: string, kind: string, videoCodec?: string, audioCodec?: string): string | undefined {
  const type = contentTypeFor(path);
  if ((kind !== "video" && kind !== "audio") || !type.startsWith(`${kind}/`)) return undefined;
  if (!["video/mp4", "video/quicktime", "audio/mp4", "video/webm"].includes(type)) return type;
  const codecs: Record<string, string> = { h264: "avc1", hevc: "hvc1", av1: "av01", aac: "mp4a.40.2", ac3: "ac-3", eac3: "ec-3" };
  const streams = [videoCodec, audioCodec].filter((c): c is string => !!c);
  return streams.length ? `${type}; codecs="${streams.map(c => codecs[c] ?? c).join(",")}"` : undefined;
}

/** Original uploads are untrusted even after a successful media probe. */
export function serveOriginal(req: Request, path: string): Response {
  const type = contentTypeFor(path);
  const passive = type.startsWith("audio/") || type.startsWith("video/") ||
    ["image/jpeg", "image/png", "image/gif", "image/webp", "image/x-icon"].includes(type);
  const response = serveFile(req, path, { contentType: passive ? type : "application/octet-stream" });
  response.headers.set("Content-Security-Policy", "sandbox; default-src 'none'");
  response.headers.set("X-Content-Type-Options", "nosniff");
  if (!passive) response.headers.set("Content-Disposition", "attachment");
  return response;
}

export interface ServeOptions {
  contentType?: string;
  cacheControl?: string;
}

/** Serve a file with HTTP Range support (single range), 404 when missing. */
export function serveFile(req: Request, path: string, opts: ServeOptions = {}): Response {
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
  } catch {
    throw new HttpError(404, "not_found", "file not found");
  }
  const headers = new Headers({
    "Content-Type": opts.contentType ?? contentTypeFor(path),
    "Accept-Ranges": "bytes",
    "Cache-Control": opts.cacheControl ?? "private, max-age=0",
  });

  const range = req.headers.get("range");
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === "" && m[2] === "")) {
      headers.set("Content-Range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    if (m[1] === "") {
      const suffix = Math.min(size, Number(m[2]));
      start = size - suffix;
    } else {
      start = Number(m[1]);
      if (m[2] !== "") end = Math.min(end, Number(m[2]));
    }
    if (start > end || start >= size) {
      headers.set("Content-Range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    status = 206;
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  headers.set("Content-Length", String(end - start + 1));
  if (req.method === "HEAD") return new Response(null, { status, headers });
  if (size === 0) return new Response(new Uint8Array(0), { status, headers });
  // Native Save consumes the entire file. Use larger reads for that transfer
  // while keeping range requests and abandoned playback seeks inexpensive.
  const wholeDownload = !range && size >= 1024 * 1024 && req.headers.get("x-scarlet-download") === "1";
  const stream = createReadStream(path, { start, end, highWaterMark: wholeDownload ? 1024 * 1024 : undefined });
  const body = Readable.toWeb(stream, { strategy: new ByteLengthQueuingStrategy({ highWaterMark: stream.readableHighWaterMark }) });
  return new Response(body as ReadableStream, { status, headers });
}
