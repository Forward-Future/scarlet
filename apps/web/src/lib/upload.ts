import { isPlayableMedia, type MediaAsset } from "@scarlet/timeline";
import { api, IS_MOCK, mockClient } from "./client";
import { appLog, logPath } from "./appLog";

const importChecks = new Map<string, (fraction: number) => void>();

export function reportImportCheck(importId: string, fraction: number) {
  importChecks.get(importId)?.(fraction);
}

export async function importLocalFile(projectId: string, path: string, onCheck: (fraction: number) => void, importId: string = crypto.randomUUID(), deferFormat = false) {
  importChecks.set(importId, onCheck);
  try {
    // A link downloads; a path is copied and reports its progress.
    const source = /^https?:\/\//i.test(path) ? { url: path, importId } : { path, importId };
    return (await api.importMedia(projectId, { ...source, ...(deferFormat && { deferFormat }) })).media;
  } finally {
    importChecks.delete(importId);
  }
}

/**
 * Upload with progress. ScarletClient.uploadMedia uses fetch (no progress
 * events), so the real path uses XMLHttpRequest against the same route with
 * the same multipart shape. Mock mode goes through MockClient.uploadMedia and
 * fakes the progress ticks.
 */
export function uploadMedia(
  projectId: string,
  file: File,
  onProgress: (fraction: number) => void,
  deferFormat = false,
): { promise: Promise<MediaAsset>; abort: () => void } {
  if (IS_MOCK) {
    let cancelled = false;
    const promise = (async () => {
      for (let i = 1; i <= 10 && !cancelled; i++) {
        await new Promise((r) => setTimeout(r, 120));
        onProgress(i / 10);
      }
      if (cancelled) throw new DOMException("Upload cancelled", "AbortError");
      const res = await (mockClient() ?? api).uploadMedia(projectId, file, file.name);
      return res.media;
    })();
    return { promise, abort: () => (cancelled = true) };
  }

  const xhr = new XMLHttpRequest();
  const promise = new Promise<MediaAsset>((resolve, reject) => {
    const fd = new FormData();
    fd.append("file", file, file.name);
    const url = api.url(`/projects/${projectId}/media${deferFormat ? "?deferFormat=true" : ""}`);
    // This request goes round the client, so it writes the client's `[api]` lines itself.
    const path = logPath(url), started = performance.now();
    const log = (event: string, fields?: Record<string, unknown>, level?: "warn") =>
      appLog("api", event, { method: "POST", path, ...fields, ms: Math.round(performance.now() - started) }, { level });
    xhr.open("POST", url);
    const token = api.token;
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => { log("unreachable", undefined, "warn"); reject(new Error("Network error during upload")); };
    xhr.onabort = () => { log("stopped"); reject(new DOMException("Upload cancelled", "AbortError")); };
    xhr.onload = () => {
      try {
        const json = JSON.parse(xhr.responseText) as { media?: MediaAsset; error?: { message?: string } };
        if (xhr.status >= 200 && xhr.status < 300 && json.media) { log("did", { status: xhr.status }); resolve(json.media); }
        else {
          log("failed", { status: xhr.status, reason: json.error?.message?.slice(0, 300) }, "warn");
          reject(new Error(json.error?.message ?? `Upload failed (${xhr.status})`));
        }
      } catch {
        log("failed", { status: xhr.status, reason: "unreadable answer" }, "warn");
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };
    xhr.send(fd);
  });
  return { promise, abort: () => xhr.abort() };
}

export const ACCEPTED_MEDIA = "video/*,audio/*,image/*,.mov,.mp4,.mkv,.wav,.mp3,.aac,.png,.jpg,.jpeg,.webp";
export const MEDIA_FORMAT_HINT = "Common formats include MP4 and MOV video, WAV and MP3 audio, and PNG and JPEG images.";

export function isPreparingMedia(m: MediaAsset): boolean {
  return m.status === "ingesting" || (m.status === undefined && m.kind !== "image" && !m.duration);
}

const nativeSupport = new Map<string, boolean>();

export function canPlayOriginal(media: MediaAsset): boolean {
  const type = media.originalPlaybackType;
  if ((media.kind !== "video" && media.kind !== "audio") || !type?.startsWith(`${media.kind}/`)) return false;
  let supported = nativeSupport.get(type);
  if (supported === undefined) {
    supported = !!document.createElement("video").canPlayType(type);
    nativeSupport.set(type, supported);
  }
  return supported;
}

export function canPreviewMedia(media: MediaAsset): boolean {
  return media.previewMode === "on-demand" || isPlayableMedia(media) || canPlayOriginal(media);
}
