import { ScarletApiError } from "@scarlet/shared";
import type { HandoffFile } from "@scarlet/shared";
import { CaptionExportError, captionExportHttpStatus, captionExportRange, captionTracks, exactRate, handoffFileNames, handoffLosses, handoffReadMe, timelineToSrt, toCaptions, toFcpxml, toOtio, usedMedia, type HandoffSource } from "@scarlet/timeline";
import type { Project, Timeline } from "@scarlet/timeline";

export function otioDataUrl(project: Project, tl: Timeline | undefined): string {
  const otio = tl ? toOtio(project, tl, { mediaRoot: "C:/scarlet/media" }) : {};
  return `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(otio, null, 2))}`;
}

export function captionDataUrl(tl: Timeline, format: "srt" | "vtt", opts?: { trackId?: string; start?: number; end?: number }): string {
  try {
    const text = toCaptions(tl, format, { trackId: opts?.trackId, range: captionExportRange(opts?.start, opts?.end) });
    const type = format === "vtt" ? "text/vtt" : "text/plain";
    return `data:${type};charset=utf-8,${encodeURIComponent(text)}`;
  } catch (err) {
    if (err instanceof CaptionExportError) throw new ScarletApiError(captionExportHttpStatus(err.code), err.code, err.message);
    throw err;
  }
}

/** The demo's folder for another app: real timeline files, with the sample video standing in for every clip. */
export function handoffFiles(project: Project, tl: Timeline, folder: string): HandoffFile[] {
  const base = folder.split(/[\\/]/).filter(Boolean).pop() || project.name;
  const assets = usedMedia(project, tl);
  const names = handoffFileNames(assets.map(a => a.name));
  const sources = new Map<string, HandoffSource>(assets.map((a, i) => [a.id, {
    url: `file://${encodeURI(`${folder}/Media/${names[i]}`)}`, fileName: names[i]!, hasVideo: a.kind !== "audio", hasAudio: a.hasAudio !== false,
    rate: a.fps ? exactRate(a.fps).rate : undefined, width: a.width, height: a.height, duration: a.duration ?? 0,
  }]));
  const captions = captionTracks(tl).map(({ track }) => ({ path: `${base} captions.srt`, text: timelineToSrt(tl, { trackId: track.id }) })).slice(0, 1);
  const files: HandoffFile[] = [
    { path: `${base}.fcpxml`, text: toFcpxml(project, tl, sources) },
    { path: `${base}.otio`, text: JSON.stringify(toOtio(project, tl, { sources }), null, 2) },
    ...captions,
    { path: "Read me.txt", text: handoffReadMe({ projectName: project.name, timelineFiles: { fcpxml: `${base}.fcpxml`, otio: `${base}.otio` },
      captionFiles: captions.map(c => c.path), losses: handoffLosses(project, tl, sources), warnings: [] }) },
    ...names.map(name => ({ path: `Media/${name}`, source: "/sample.mp4", size: 0 })),
  ];
  return files;
}
