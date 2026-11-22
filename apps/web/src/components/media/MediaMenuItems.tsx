import { useMemo, useRef, useState } from "react";
import { cachedShare } from "@scarlet/shared";
import { plural } from "../../lib/format";
import { isRunningTranscriptionTask, mediaProblems, mediaWarningLabel, transcriptionProgressLabel } from "../../lib/transcriptionProgress";
import { useProjectStore } from "../../stores/project";
import { MenuItem } from "../shell/WorkspaceNavigation";
import { Icon } from "../ui/primitives";
import { ProgressLine } from "../ui/ProgressLine";
import { cachePercent, useSourceCaches } from "./sourceCaches";
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
    paused, active, progress, percent, canPause: !paused && (active || waiting.length > 0),
    /** In a word or two while videos cache: "Caching 30%", or "Caching" until the engine has a figure. */
    label: !active ? undefined : percent ? `Caching ${percent}` : "Caching",
    headline: paused ? "Media processing is paused"
      : !videos.length ? undefined
      : active && videos.length === 1 ? "Caching for playback"
      : ready === videos.length ? (videos.length === 1 ? "Video cached for playback" : `All ${videos.length} videos cached for playback`)
      : `${ready} of ${plural(videos.length, "video")} cached`,
  };
}

/** The header's Media button opens the library. Its hover card summarizes active work and offers Pause or Resume. */
export function MediaButton({ importing, importFailed, onOpen }: { importing: number; importFailed?: boolean; onOpen(): void }) {
  const warning = useMediaWarning(importFailed);
  const { paused, active, progress, percent, label, headline } = useVideoCaching();
  const transcribing = useTranscriptionStatus();
  const processing = useMediaProcessing();
  const button = useRef<HTMLButtonElement>(null);
  const [dismissed, setDismissed] = useState(false);
  const [focused, setFocused] = useState(false);
  const adding = importing > 0 ? `Adding ${plural(importing, "file")}` : undefined;
  const transcription = transcribing.active ? "Transcription in progress" : undefined;
  const description = [warning, adding ?? label ?? headline, transcription].filter(Boolean).join(". ") || undefined;
  const showTranscription = !paused && transcribing.active;
  const primary = paused ? "Paused"
    : active ? undefined
    : adding ?? (!showTranscription ? headline : undefined) ?? (!showTranscription && processing.available ? "Preparing media" : undefined);
  const hasCard = !!(warning || active || showTranscription || primary || processing.available || processing.error);
  const toggleButton = processing.available && <button type="button" className="btn-quiet aria-disabled:opacity-60" aria-disabled={processing.busy}
    title={processing.description} onClick={() => void processing.toggle()}>
    <Icon name={processing.icon} size={11} />{processing.label}
  </button>;
  const transcriptionLabel = transcribing.percent ? `Transcribing ${transcribing.percent}` : "Transcribing";
  const transcriptionBlock = showTranscription && (transcribing.queued ? <div className="media-hover-row">
    <span className="text-muted" role="status">Transcribing</span>
    <span className="text-dim">Queued</span>
  </div> : <div className="media-hover-job">
    <div className="media-hover-row">
      <strong role="status">{transcribing.percent ? "Transcribing" : "Transcribing…"}</strong>
      {transcribing.percent && <span className="text-muted tnum">{transcribing.percent}</span>}
    </div>
    <progress className="activity-progress" aria-label={transcriptionLabel} max={1} value={transcribing.progress} />
  </div>);

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
        {active ? <>
          <div className="media-hover-job">
            <div className="media-hover-row">
              <strong role="status">{percent ? "Caching" : "Caching…"}</strong>
              {percent && <span className="text-muted tnum">{percent}</span>}
            </div>
            <progress className="activity-progress" aria-label={label ?? "Caching"} max={1} value={progress} />
          </div>
          {transcriptionBlock}
          {adding && <span className="text-muted" role="status">{adding}</span>}
          <div className="media-hover-foot">
            <span className="text-dim">You can edit during caching.</span>
            {toggleButton}
          </div>
        </> : (showTranscription || primary || toggleButton) && <>
          <div className="media-hover-row">
            {showTranscription && !primary ? <strong role="status">
              {transcribing.queued ? "Waiting to transcribe"
                : transcribing.percent ? <>Transcribing<span className="text-muted font-normal tnum"> {transcribing.percent}</span></>
                : "Transcribing…"}
            </strong> : primary && <strong role="status">{primary}</strong>}
            {toggleButton}
          </div>
          {showTranscription && !primary && !transcribing.queued && <progress className="activity-progress" aria-label={transcriptionLabel} max={1} value={transcribing.progress} />}
          {primary && transcriptionBlock}
          {paused && adding && <span className="text-muted" role="status">{adding}</span>}
        </>}
        {processing.error && <span className="simple-error" role="alert">{processing.error}</span>}
      </div>
    </div>}
  </div>;
}

function useTranscriptionStatus(): { active: boolean; queued: boolean; progress?: number; percent?: string } {
  const tasks = useProjectStore(s => s.current?.tasks);
  const media = useProjectStore(s => s.current?.media);
  return useMemo(() => {
    const running = (tasks ?? []).filter(isRunningTranscriptionTask);
    if (!running.length) return { active: false, queued: false };
    if (running.every(t => t.progress?.stage === "queued")) return { active: true, queued: true };
    if (!running.some(t => t.progress && t.progress.stage !== "queued")) return { active: true, queued: false };
    const durations = new Map((media ?? []).map(m => [m.id, m.duration || 1]));
    let total = 0;
    let done = 0;
    for (const task of running) {
      const weight = (task.context.mediaId && durations.get(task.context.mediaId)) || 1;
      total += weight;
      const fraction = task.progress && task.progress.stage !== "queued" ? task.progress.fraction : 0;
      done += weight * fraction;
    }
    const progress = total > 0 ? Math.min(1, done / total) : undefined;
    const percent = progress != null ? transcriptionProgressLabel({ stage: "transcribing", fraction: progress }) : undefined;
    return { active: true, queued: false, progress, percent };
  }, [tasks, media]);
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
