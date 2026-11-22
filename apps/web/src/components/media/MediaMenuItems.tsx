import { useMemo, useRef, useState } from "react";
import { cachedShare } from "@scarlet/shared";
import { plural } from "../../lib/format";
import { isRunningTranscriptionTask, mediaProblems, mediaWarningLabel } from "../../lib/transcriptionProgress";
import { useProjectStore } from "../../stores/project";
import { MenuItem } from "../shell/WorkspaceNavigation";
import { Icon } from "../ui/primitives";
import { ProgressLine } from "../ui/ProgressLine";
import { cacheLabel, cachePercent, useSourceCaches } from "./sourceCaches";
import { useMediaProcessing } from "./useMediaProcessing";

/**
 * What's wrong with the project's media, in a few words, or nothing. A file Scarlet couldn't read or a transcription
 * that stopped is explained only in Media, so the header's Media button is marked until it's dealt with.
 * A transcription the pause stopped isn't one: it starts again on resume. A file that failed to import never became
 * the project's, so only Media's list of imports says why: `importFailed` marks the button for it the same way.
 */
export function useMediaWarning(importFailed = false): string | undefined {
  const media = useProjectStore(s => s.current?.media);
  const tasks = useProjectStore(s => s.current?.tasks);
  const paused = useProjectStore(s => !!s.current?.project.mediaPaused);
  return useMemo(() => mediaWarningLabel(mediaProblems(tasks ?? [], media ?? [], paused)) ?? (importFailed ? "Some files need attention" : undefined),
    [tasks, media, paused, importFailed]);
}

/**
 * What the project's videos are doing with their playback caches: caching and how far, or waiting their turn, and
 * whether the project is paused. It is about the videos only: the edit's own playback cache isn't counted. The header's
 * Media button reads it for its line and hover, and the menu uses it to show when there is work to pause.
 * How far is counted across the videos being cached by their length, so the figure only goes up as one video
 * finishes and the next starts.
 */
export function useVideoCaching() {
  const media = useProjectStore(s => s.current?.media) ?? [];
  const paused = useProjectStore(s => !!s.current?.project.mediaPaused);
  const { caches } = useSourceCaches();
  const listed = media.filter(m => m.kind === "video" && caches.has(m.id)).map(m => ({ media: m, seconds: m.duration ?? 0, cache: caches.get(m.id)! }));
  const videos = listed.map(v => v.cache);
  const caching = videos.filter(c => c.state === "caching");
  const waiting = videos.filter(c => c.queued);
  const ready = videos.filter(c => c.state === "ready").length;
  const active = !paused && caching.length > 0;
  // Counted as the project list counts it, so the two say the same: a video that failed or isn't to be cached isn't in
  // it. There is no figure until the engine has one for a video under way, or a video is already cached.
  const progress = active && (ready > 0 || caching.some(c => c.progress != null)) ? cachedShare(listed) : undefined;
  // It reads as a video's own row in Media does, so it says 100% only once every video is cached.
  const percent = progress != null ? cachePercent({ progress }) : undefined;
  return {
    listed, paused, active, progress, canPause: !paused && (active || waiting.length > 0),
    /** In a word or two while videos cache: "Caching 30%", or "Caching" until the engine has a figure. */
    label: !active ? undefined : percent ? `Caching ${percent}` : "Caching",
    headline: paused ? "Media processing is paused"
      : !videos.length ? undefined
      : active && videos.length === 1 ? "Caching for playback"
      : ready === videos.length ? (videos.length === 1 ? "Video cached for playback" : `All ${videos.length} videos cached for playback`)
      : `${ready} of ${plural(videos.length, "video")} cached`,
  };
}

/** The header's Media button opens the library. Its hover card shows jobs and offers Pause or Resume. */
export function MediaButton({ importing, importFailed, onOpen }: { importing: number; importFailed?: boolean; onOpen(): void }) {
  const warning = useMediaWarning(importFailed);
  const { listed, paused, active, progress, label, headline } = useVideoCaching();
  const transcribing = useTranscriptionActive();
  const processing = useMediaProcessing();
  const button = useRef<HTMLButtonElement>(null);
  const [dismissed, setDismissed] = useState(false);
  const [focused, setFocused] = useState(false);
  const adding = importing > 0 ? `Adding ${plural(importing, "file")}` : undefined;
  const transcription = transcribing ? "Transcription in progress" : undefined;
  const description = [warning, adding ?? label ?? headline, transcription].filter(Boolean).join(". ") || undefined;
  const hasCard = !!(warning || adding || headline || transcription || listed.length || processing.available || processing.error);

  return <div className="media-hover" data-dismissed={dismissed || undefined} data-escape-owner={(hasCard && focused && !dismissed) || undefined}
    onPointerEnter={() => setDismissed(false)} onFocus={() => { setFocused(true); setDismissed(false); }}
    onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
    }}
    onKeyDown={event => {
      if (!hasCard || event.key !== "Escape" || dismissed) return;
      event.stopPropagation();
      button.current?.focus();
      setDismissed(true);
    }}>
    <button ref={button} type="button" className={`btn-quiet simple-media${warning ? " needs-you" : ""}`} aria-haspopup="dialog"
      aria-description={description} onClick={() => { setDismissed(true); onOpen(); }}>
      Media{warning && <span className="menu-dot" role="img" aria-label={warning} />}
      {active && <ProgressLine progress={progress} />}
    </button>
    {hasCard && <div className="media-hover-card">
      <div className="card" role="group" aria-label="Media processing">
        {warning && <span className="text-warn">{warning}</span>}
        {adding && <span role="status">{adding}</span>}
        {headline && <strong role="status">{headline}</strong>}
        {active && <span className="text-muted">You can edit during caching.</span>}
        {transcription && <span role="status">{transcription}</span>}
        {listed.slice(0, 5).map(({ media, cache }) => {
          const status = cacheLabel(cache, paused);
          return <div key={media.id} className="media-hover-row">
            <span className="truncate text-muted" title={media.name}>{media.name}</span>
            <span className="text-muted">{status?.text}</span>
            {!paused && cache.state === "caching" && <progress className="activity-progress" aria-label={`Caching ${media.name}`} max={1} value={cache.progress} />}
          </div>;
        })}
        {listed.length > 5 && <span className="text-muted">{listed.length - 5} more in Media</span>}
        {processing.available && <button type="button" className="simple-link aria-disabled:opacity-60" aria-disabled={processing.busy}
          title={processing.description} onClick={() => void processing.toggle()}>
          <Icon name={processing.icon} size={12} />{processing.label}
        </button>}
        {processing.error && <span className="simple-error" role="alert">{processing.error}</span>}
      </div>
    </div>}
  </div>;
}

function useTranscriptionActive(): boolean {
  return useProjectStore(s => !!s.current?.tasks.some(isRunningTranscriptionTask));
}

/** Keep the same action in the workspace's More menu while there is work to pause, or while it is paused. */
export function CachingMenuItem({ close }: { close(): void }) {
  const processing = useMediaProcessing();

  if (!processing.available) return null;
  return <MenuItem disabled={processing.busy} title={processing.description} onClick={async () => {
    if (await processing.toggle()) close();
  }}>
    <Icon name={processing.icon} />{processing.error || processing.label}
  </MenuItem>;
}
