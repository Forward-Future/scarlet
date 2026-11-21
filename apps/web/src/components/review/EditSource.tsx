import { useState } from "react";
import { clipRange, type MediaAsset, type Timeline, type TimeRange } from "@scarlet/timeline";
import type { ThreadEdit } from "@scarlet/shared";
import { api } from "../../lib/client";
import { desktop } from "../../lib/desktop";
import { Icon } from "../ui/primitives";

/**
 * Where the picture an edit laid over the video came from on the web: of the files with a source laid over the
 * picture in the edit's stretch, the one that covers most of it. None for an edit that laid nothing over it.
 */
export function editSource(edit: Pick<ThreadEdit, "kind" | "range"> | undefined, timeline: Timeline | undefined, media: readonly MediaAsset[]) {
  if (!edit || !["broll", "overlay", "graphic"].includes(edit.kind ?? "") || !timeline) return;
  // The bottom video track carries the picture; clips on any track above it are laid over it.
  const base = timeline.tracks.find(t => t.kind === "video")?.id;
  let best: { file: MediaAsset; overlap: number } | undefined;
  for (const track of timeline.tracks) {
    if (track.kind !== "video" || track.id === base) continue;
    for (const clip of track.clips) {
      const file = clip.kind === "media" ? media.find(m => m.id === clip.mediaId) : undefined;
      if (!file?.source) continue;
      let at: TimeRange;
      try { at = clipRange(clip); } catch { continue; }
      const overlap = Math.min(at.end, edit.range.end) - Math.max(at.start, edit.range.start);
      if (overlap > 0 && (!best || overlap > best.overlap)) best = { file, overlap };
    }
  }
  return best?.file;
}

/** The icon on the card that opens where the edit's picture came from, as the transcript icon opens a cut's words. */
export function SourceLink({ open, toggle }: { open: boolean; toggle(): void }) {
  const name = open ? "Hide source" : "Show source";
  return <button type="button" className="edit-card-icon edit-card-source" data-log-control="toggle-source" aria-label={name} title={name}
    aria-expanded={open} onClick={toggle}><Icon name="link" size={14} /></button>;
}

const capturedOn = (at: string | undefined) => {
  const date = at ? new Date(at) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : undefined;
};

/**
 * The card's second row for B-roll from the web: the page as Scarlet captured it, with the part in the video lit, its
 * address, which opens the page, and when it was captured.
 */
export function SourceRow({ file }: { file: MediaAsset }) {
  const source = file.source!;
  const [pictured, setPictured] = useState(!!source.capture);
  const [error, setError] = useState<string>();
  const on = capturedOn(source.capturedAt);
  const region = source.region;
  const opens = /^https:\/\//i.test(source.url);
  const open = () => void desktop.openUrl(source.url).then(() => setError(undefined), () => setError("Couldn’t open the page."));
  return <div className="thread-passage edit-source">
    {pictured && <span className="edit-source-capture">
      <img src={api.fileUrl(`/media/${encodeURIComponent(file.id)}/source-capture`)} alt="" onError={() => setPictured(false)} />
      {region && <i aria-hidden="true" style={{ left: `${region.left * 100}%`, top: `${region.top * 100}%`,
        width: `${(region.right - region.left) * 100}%`, height: `${(region.bottom - region.top) * 100}%` }} />}
    </span>}
    <span className="edit-source-text">
      {opens ? <button type="button" className="simple-link edit-source-url" title="Open the page" onClick={open}>{source.url}</button>
        : <span className="edit-source-url">{source.url}</span>}
      {(on || pictured) && <span className="edit-source-said">
        {[on && `Captured ${on}.`, pictured && region && "The lit part is what’s in the video."].filter(Boolean).join(" ")}</span>}
      {error && <span className="simple-error" role="alert">{error}</span>}
    </span>
  </div>;
}
