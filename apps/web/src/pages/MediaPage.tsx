import { useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import type { SourceCacheStatus } from "@scarlet/shared";
import type { MediaAsset } from "@scarlet/timeline";
import { api, errorMessage, IS_DESKTOP } from "../lib/client";
import { desktop } from "../lib/desktop";
import { ACCEPTED_MEDIA, canPreviewMedia, isPreparingMedia, MEDIA_FORMAT_HINT } from "../lib/upload";
import { clock } from "../lib/format";
import { isLink } from "../lib/pendingImports";
import { useProjectStore } from "../stores/project";
import { ImportTranscriptionNotice, TranscriptLine, useImportTranscription } from "../components/media/TranscriptionAction";
import { UploadList, type useUploader } from "../components/media/UploadDropzone";
import { ImportProgress, preparationStep } from "../components/media/ImportProgress";
import { MediaStatusLine } from "../components/media/MediaStatusLine";
import { cacheLabel, cachePercent, useSourceCaches } from "../components/media/sourceCaches";
import { ConfirmDialog, EmptyState, Icon, InlineError } from "../components/ui/primitives";
import { ImportUrlModal } from "./ProjectsPage";

function Thumb({ m }: { m: MediaAsset }) {
  const [failed, setFailed] = useState(false);
  if (m.kind === "audio" || failed) {
    return (
      <div className={`media-thumb media-glyph ${m.kind}`}><Icon name={m.kind === "audio" ? "audio" : m.kind === "video" ? "film" : "image"} size={22} /></div>
    );
  }
  return <img src={api.frameUrl(m.id, thumbTime(m), 320)} alt="" className="media-thumb object-cover bg-black" loading="lazy" onError={() => setFailed(true)} />;
}

/** The second a thumbnail shows: one second in, or the middle of a shorter clip. A still has only its first frame. */
function thumbTime(m: MediaAsset) {
  return m.duration ? Math.min(1, m.duration / 2) : 0;
}

/**
 * A file still being read, as the first of its row's jobs: the step it is on, then a bar and a percent, as its cache
 * and transcript are. The pause holds the read, and the job then says so in gray with no bar, as they do.
 */
function Reading({ m, paused }: { m: MediaAsset; paused: boolean }) {
  const { text, percent, held } = preparationStep(m, paused);
  if (held) return <MediaStatusLine name={m.name} status={{ text, tone: "idle" }} />;
  return <MediaStatusLine name={m.name} status={{ text: percent ? text : `${text}…`, tone: "busy" }}
    bar={{ label: `Preparation progress for ${m.name}`, fraction: m.preparation?.fraction, percent }} />;
}

/** A video's cache: under way or still to make, with a way to start or retry it, and Cached once it's done. */
function SourceCache({ cache, name, paused, onCache }: { cache?: SourceCacheStatus; name: string; paused: boolean; onCache(): void }) {
  const label = cacheLabel(cache, paused);
  if (!cache || !label) return null;
  if (cache.state === "ready") return <MediaStatusLine name={name} status={{ text: label.text, tone: "done" }} />;
  const startable = !paused && (cache.state === "failed" || (cache.state === "uncached" && !cache.queued));
  const percent = cachePercent(cache);
  return <MediaStatusLine name={name} status={cache.state === "caching" ? { text: percent ? "Caching" : "Caching…", tone: "busy" } : label}
    bar={cache.state === "caching" ? { label: `Caching ${name}`, fraction: cache.progress, percent } : undefined}>
    {startable && <button type="button" className="simple-link" onClick={onCache}>{cache.state === "failed" ? "Retry" : "Cache now"}</button>}
  </MediaStatusLine>;
}

const KIND_LABEL: Record<MediaAsset["kind"], string> = { video: "Video", audio: "Audio", image: "Image", graphic: "Graphic" };

export function MediaPage({ uploads, onPlay }: {
  uploads: ReturnType<typeof useUploader>;
  onPlay(id: string): void;
}) {
  const current = useProjectStore((s) => s.current);
  // Media leaves out the note that transcription runs on this computer; the OpenAI and off notices stay.
  const importTranscription = useImportTranscription();
  const { available: transcriptionAvailable, notice: importNotice, local } = importTranscription;
  const notice = local ? "" : importNotice;
  const importErrors: string[] = useLocation().state?.importErrors ?? [];
  const [pickerError, setPickerError] = useState("");
  // The unreadable file the editor is asked about before it is taken out.
  const [removal, setRemoval] = useState<MediaAsset | null>(null);
  const projectId = current?.id ?? "";
  const { items, start, startPaths, localImport, dismiss } = uploads;
  const [importOpen, setImportOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // A file being copied in holds the picker until it is in. A link can download for minutes, and more files can wait behind it.
  const adding = picking || (!!localImport && !isLink(localImport.path));
  const caches = useSourceCaches();
  const [cacheError, setCacheError] = useState("");
  if (!current) return null;
  const paused = !!current.project.mediaPaused;
  const addFiles = async () => {
    if (!IS_DESKTOP) {
      fileInput.current?.click();
      return;
    }
    setPickerError("");
    setPicking(true);
    try {
      const paths = await desktop.pickFiles();
      // The files are queued once handed over, so the picker is free again: waiting for them to be in would hold it for
      // as long as a link downloading ahead of them.
      if (paths.length) void startPaths(paths);
    } catch (e) {
      setPickerError(errorMessage(e));
    } finally {
      setPicking(false);
    }
  };
  const { media } = current;

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center justify-end gap-2">
        <button className="btn-ghost" onClick={() => setImportOpen(true)}>
          <Icon name="link" size={12} /> Add from a link
        </button>
        {media.length > 0 && <button className="btn-ghost" aria-describedby="media-file-types" disabled={adding} onClick={addFiles}>
          <Icon name="upload" size={12} /> Add files
        </button>}
        <input ref={fileInput} type="file" multiple accept={ACCEPTED_MEDIA} hidden onChange={(e) => {
          if (e.target.files?.length) start(e.target.files);
          e.target.value = "";
        }} />
      </div>
      <p id="media-file-types" className="mb-3 text-muted text-[12px]">{MEDIA_FORMAT_HINT}</p>
      {notice && <ImportTranscriptionNotice policy={importTranscription} />}
      {localImport && (
        <div className="card mb-3 px-3 py-2.5">
          <ImportProgress localImport={localImport} />
        </div>
      )}
      {importErrors.length > 0 && <InlineError><ul>{importErrors.map((message, i) => <li key={i}>{message}</li>)}</ul></InlineError>}
      <InlineError>{pickerError || cacheError}</InlineError>
      <UploadList items={items} onDismiss={dismiss} />
      {media.length === 0 ? (
        !localImport && <EmptyState title="Add your first file" body="Drop files here." action={
          <button type="button" className="btn-primary" aria-describedby="media-file-types" disabled={adding} onClick={addFiles}>
            <Icon name="upload" /> Choose files
          </button>
        } />
      ) : (
        <ul className="card divide-y divide-line/60">
          {media.map((m) => (
            <li key={m.id} className="media-row">
              {canPreviewMedia(m) ? (
                <button type="button" className="media-thumb-button" aria-label={`Preview source ${m.name}`} title="Preview source" onClick={() => onPlay(m.id)}>
                  <Thumb m={m} /><span className="media-thumb-play"><Icon name="play" size={14} /></span>
                </button>
              ) : <Thumb m={m} />}
              <div className="media-file">
                <div className="font-medium truncate" title={m.name}>{m.name}</div>
                <div className="media-meta">
                  {m.status === "failed" ? (
                    <span className="text-bad">{m.preparation?.stage === "waveform" ? "Couldn’t read the waveform" : "Couldn’t read this file"}{m.error ? `: ${m.error}` : ""}</span>
                  ) : (
                    // A length reads as the player and History write it: 0:20, 1:02:07.
                    m.duration ? clock(m.duration) : m.width && m.height ? `${m.width}×${m.height}` : KIND_LABEL[m.kind]
                  )}
                </div>
              </div>
              <div className="media-jobs">
                {isPreparingMedia(m) && <Reading m={m} paused={paused} />}
                <SourceCache cache={caches.caches.get(m.id)} name={m.name} paused={paused}
                  onCache={() => { setCacheError(""); caches.start(m.id).catch(e => setCacheError(errorMessage(e))); }} />
                {/* A file with no audio track has nothing to transcribe. */}
                {(m.kind === "video" || m.kind === "audio") && m.hasAudio !== false && <TranscriptLine asset={m} available={transcriptionAvailable} cloud={local === false} />}
              </div>
              {/* A file Scarlet couldn't read ends in a small ×, named on hover, that asks before taking it out of the project. */}
              {m.status === "failed" && <button type="button" className="edit-card-icon media-remove" aria-label={`Remove ${m.name}`} title="Remove"
                onClick={() => setRemoval(m)}><Icon name="x" size={12} /></button>}
            </li>
          ))}
        </ul>
      )}
      <ImportUrlModal projectId={projectId} open={importOpen} notice={notice} onClose={() => setImportOpen(false)} />
      {/* The project's copy is deleted with it, so it asks first, as every press that deletes does. The dialog says why the engine wouldn't. */}
      {removal && <ConfirmDialog open danger onClose={() => setRemoval(null)} title={`Remove “${removal.name}”?`} confirmLabel="Remove"
        body="Scarlet deletes the project's copy of this file. This cannot be undone."
        onConfirm={() => useProjectStore.getState().removeMedia(removal.id)} />}
    </>
  );
}
