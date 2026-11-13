import { useMemo, useState } from "react";
import { cachedShare } from "@scarlet/shared";
import { plural } from "../../lib/format";
import { mediaProblems, mediaWarningLabel } from "../../lib/transcriptionProgress";
import { useProjectStore } from "../../stores/project";
import { MenuItem } from "../shell/WorkspaceNavigation";
import { Icon } from "../ui/primitives";
import { cachePercent, useSourceCaches } from "./sourceCaches";

/**
 * What's wrong with the project's media, in a few words, or nothing. A file Scarlet couldn't read or a transcription
 * that stopped is explained only in Media, so the menu that leads there is marked until it's dealt with.
 * A transcription the pause stopped isn't one: it starts again on resume. A file that failed to import never became
 * the project's, so only Media's list of imports says why: `importFailed` marks the menu for it the same way.
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
 * whether the project is paused. It is about the videos only: the edit's own playback cache isn't counted. The menu's Media row and
 * the ring around the menu's button both read it, so they say the same thing.
 * How far is counted across the videos being cached by their length, so the figure only goes up as one video
 * finishes and the next starts.
 */
export function useVideoCaching() {
  const media = useProjectStore(s => s.current?.media) ?? [];
  const paused = useProjectStore(s => !!s.current?.project.mediaPaused);
  const { caches } = useSourceCaches();
  const listed = media.filter(m => m.kind === "video" && caches.has(m.id)).map(m => ({ seconds: m.duration ?? 0, cache: caches.get(m.id)! }));
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
    paused, active, progress, canPause: !paused && (active || waiting.length > 0),
    /** In a word or two while videos cache: "Caching 30%", or "Caching" until the engine has a figure. */
    label: !active ? undefined : percent ? `Caching ${percent}` : "Caching",
    headline: paused ? "Caching is paused"
      : !videos.length ? undefined
      : active && videos.length === 1 ? "Caching for playback"
      : ready === videos.length ? (videos.length === 1 ? "Video cached for playback" : `All ${videos.length} videos cached for playback`)
      : `${ready} of ${plural(videos.length, "video")} cached`,
  };
}

const CACHING_RING_RADIUS = 11.5;
/** The ring's length, which its dash is measured against. */
export const CACHING_RING = 2 * Math.PI * CACHING_RING_RADIUS;

/**
 * The ring around the menu's button while videos cache, drawn like the one beside "Updating": an arc as long as the
 * caches have got. Until the engine has a figure it is a quarter that turns.
 */
export function CachingRing({ progress }: { progress?: number }) {
  const shown = progress == null ? 0.25 : Math.max(0.02, Math.min(1, progress));
  return <svg className={`simple-more-ring${progress == null ? " is-unknown" : ""}`} viewBox="0 0 26 26" aria-hidden="true">
    <circle cx="13" cy="13" r={CACHING_RING_RADIUS} />
    <circle cx="13" cy="13" r={CACHING_RING_RADIUS} strokeDasharray={CACHING_RING} strokeDashoffset={CACHING_RING * (1 - shown)} />
  </svg>;
}

/**
 * Media's rows in the simple view's menu. The Media row says what the videos are doing in a word or two (adding,
 * caching and how far, paused) and carries the mark when a file needs the editor; hover names the problem. Each
 * video's cache is in Media itself. While videos cache or wait to, a second row pauses the project's media
 * processing, which keeps finished parts. For as long as it is paused that row resumes it, whatever the videos are
 * doing: it is the only way to resume, and nothing else in the header or the chat says the project is paused.
 * Media's own rows say which of a file's jobs the pause holds.
 */
export function MediaMenuItems({ importing, importFailed, onOpen, close }: { importing: number; importFailed?: boolean; onOpen(): void; close(): void }) {
  const warning = useMediaWarning(importFailed);
  const { paused, canPause, label, headline } = useVideoCaching();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const status = importing > 0 ? `adding ${importing}` : paused ? "Paused" : label;

  async function toggle() {
    setBusy(true);
    setError("");
    try {
      await useProjectStore.getState().updateProject({ mediaPaused: !paused });
      close();
    } catch { setError(paused ? "Couldn’t resume. Try again." : "Couldn’t pause. Try again."); }
    finally { setBusy(false); }
  }

  return <>
    <MenuItem onClick={() => { close(); onOpen(); }} title={[warning, headline].filter(Boolean).join(". ") || undefined}>
      <Icon name="film" />Media
      {status && <span className="menu-value">{status}</span>}
      {warning && <span className="menu-dot" role="img" aria-label={warning} />}
    </MenuItem>
    {(canPause || paused) && <MenuItem disabled={busy} onClick={() => void toggle()}>
      <Icon name={paused ? "play" : "pause"} />{error || (paused ? "Resume caching" : "Pause caching")}
    </MenuItem>}
  </>;
}
