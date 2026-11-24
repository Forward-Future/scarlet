import { useRef, useState } from "react";
import type { SourceCacheStatus } from "@scarlet/shared";
import type { AudioStreamInfo, AudioTrackSelection, MediaAsset } from "@scarlet/timeline";
import { api, errorMessage, IS_DESKTOP } from "../lib/client";
import { desktop } from "../lib/desktop";
import { ACCEPTED_MEDIA, canPreviewMedia, isPreparingMedia, MEDIA_FORMAT_HINT, MEDIA_FORMATS } from "../lib/upload";
import { clock } from "../lib/format";
import { isLink } from "../lib/pendingImports";
import { useProjectStore } from "../stores/project";
import { ImportTranscriptionNotice, TranscriptLine, useImportTranscription } from "../components/media/TranscriptionAction";
import { UploadList, type useUploader } from "../components/media/UploadDropzone";
import { ImportProgress, preparationStep } from "../components/media/ImportProgress";
import { MediaStatusLine } from "../components/media/MediaStatusLine";
import { cacheLabel, cachePercent, useSourceCaches } from "../components/media/sourceCaches";
import { useMediaProcessing } from "../components/media/useMediaProcessing";
import { PreferenceSelect } from "../components/ui/PreferenceSelect";
import { ConfirmDialog, EmptyState, Icon, InlineError } from "../components/ui/primitives";

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
  const caching = !paused && cache.state === "caching";
  return <MediaStatusLine name={name} status={caching ? { text: percent ? "Caching" : "Caching…", tone: "busy" } : label}
    bar={caching ? { label: `Caching ${name}`, fraction: cache.progress, percent } : undefined}>
    {startable && <button type="button" className="simple-link" onClick={onCache}>{cache.state === "failed" ? "Retry" : "Cache now"}</button>}
  </MediaStatusLine>;
}

function audioStreamDetail(stream: AudioStreamInfo): string | undefined {
  const parts: string[] = [];
  if (stream.title) parts.push(stream.title);
  else if (stream.language) parts.push(stream.language);
  if (stream.channels === 1) parts.push("mono");
  else if (stream.channels === 2) parts.push("stereo");
  else if (stream.channels) parts.push(`${stream.channels}ch`);
  return parts.length ? parts.join(" · ") : undefined;
}

/** Shown only on recordings with multiple audio tracks (e.g. OBS or multi-mic podcasts). */
function AudioTrackPicker({ media, onError }: { media: MediaAsset; onError(message: string): void }) {
  const streams = media.audioStreams;
  const [busy, setBusy] = useState(false);
  if (!streams || streams.length < 2) return null;
  const value: AudioTrackSelection = media.audioTrack ?? 0;
  const options: Array<{ value: AudioTrackSelection; label: string; detail?: string }> = [
    { value: "all", label: "All tracks (mixed)", detail: `${streams.length} tracks` },
    ...streams.map((s) => ({
      value: s.index,
      label: s.title ? `Track ${s.index + 1} — ${s.title}` : `Track ${s.index + 1}`,
      detail: audioStreamDetail(s),
    })),
  ];
  const change = async (next: AudioTrackSelection) => {
    setBusy(true);
    onError("");
    try {
      await useProjectStore.getState().setMediaAudioTrack(media.id, next);
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-1 flex items-center gap-1.5 text-2xs text-ink-3">
      <span>Audio</span>
      <PreferenceSelect
        compact
        label={`Audio track for ${media.name}`}
        value={value}
        disabled={busy}
        options={options}
        onChange={(next) => void change(next)}
      />
    </div>
  );
}

/**
 * What the editor says a file is and how to use it, for Scarlet, under the file's length: "Tell Scarlet what this is"
 * until there is a note, then the note after "For Scarlet:", which a click opens to change. Optional: a file with none
 * is used as before.
 */
function NoteLine({ media, onOpen }: { media: MediaAsset; onOpen(): void }) {
  return media.editorNote ? (
    <button type="button" className="media-note is-set" title="Change what Scarlet is told about this file" onClick={onOpen}>
      <b>For Scarlet:</b> {media.editorNote}
    </button>
  ) : (
    <div className="media-note"><button type="button" className="simple-link" onClick={onOpen}>Tell Scarlet what this is</button></div>
  );
}

/** The note being written, across the row's full width. Enter or Save keeps it, Esc or Cancel leaves it as it was. */
function NoteEditor({ media, onClose }: { media: MediaAsset; onClose(): void }) {
  const note = media.editorNote ?? "";
  const [draft, setDraft] = useState(note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (draft.trim() !== note) await useProjectStore.getState().setMediaNote(media.id, draft);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <div className="media-note-editor">
      <div className="media-note-label" aria-hidden="true">Tell Scarlet what this is and how to use it</div>
      <textarea className="field media-note-field" rows={2} autoFocus maxLength={2000} value={draft} disabled={busy}
        aria-label={`Tell Scarlet what ${media.name} is and how to use it`}
        placeholder="For example: Finished sponsor read. Insert it whole after the intro. Don’t cut it."
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
          else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void save(); }
        }} />
      <div className="media-note-actions">
        <button type="button" className="btn-ghost media-note-save" disabled={busy} onClick={() => void save()}>Save</button>
        <button type="button" className="simple-link" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
      <InlineError>{error}</InlineError>
    </div>
  );
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
  const [pickerError, setPickerError] = useState("");
  // The unreadable file the editor is asked about before it is taken out.
  const [removal, setRemoval] = useState<MediaAsset | null>(null);
  /** The file whose note is being written: one at a time. */
  const [noteOpen, setNoteOpen] = useState<string | null>(null);
  const { items, start, startPaths, localImport, dismiss } = uploads;
  const [picking, setPicking] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // A file being copied in holds the picker until it is in. A link can download for minutes, and more files can wait behind it.
  const adding = picking || (!!localImport && !isLink(localImport.path));
  const caches = useSourceCaches();
  const [cacheError, setCacheError] = useState("");
  const processing = useMediaProcessing();
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
        {processing.available && <button type="button" className="btn-quiet mr-auto aria-disabled:opacity-60" aria-disabled={processing.busy}
          title={processing.description} onClick={() => void processing.toggle()}>
          <Icon name={processing.icon} size={12} />{processing.label}
        </button>}
        {media.length > 0 && <button className="btn-ghost" aria-describedby="media-file-types" disabled={adding} onClick={addFiles}>
          <Icon name="upload" size={12} /> Add files
        </button>}
        <input ref={fileInput} type="file" multiple accept={ACCEPTED_MEDIA} hidden onChange={(e) => {
          if (e.target.files?.length) start(e.target.files);
          e.target.value = "";
        }} />
      </div>
      <p id="media-file-types" className="sr-only">{MEDIA_FORMAT_HINT}</p>
      {notice && <ImportTranscriptionNotice policy={importTranscription} />}
      {localImport && (
        <div className="card mb-3 px-3 py-2.5">
          <ImportProgress localImport={localImport} />
        </div>
      )}
      <InlineError>{processing.error || pickerError || cacheError}</InlineError>
      <UploadList items={items} onDismiss={dismiss} />
      {media.length === 0 ? (
        !localImport && <EmptyState title="Add your first file" body={`Drop files here (${MEDIA_FORMATS}).`} action={
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
                {m.status !== "failed" && <AudioTrackPicker media={m} onError={setCacheError} />}
                {m.status !== "failed" && noteOpen !== m.id && <NoteLine media={m} onOpen={() => setNoteOpen(m.id)} />}
              </div>
              <div className="media-jobs">
                {isPreparingMedia(m) && <Reading m={m} paused={paused} />}
                <SourceCache cache={caches.caches.get(m.id)} name={m.name} paused={paused}
                  onCache={() => { setCacheError(""); caches.start(m.id).catch(e => setCacheError(errorMessage(e))); }} />
                {/* A file with no audio track has nothing to transcribe. */}
                {(m.kind === "video" || m.kind === "audio") && m.hasAudio !== false && <TranscriptLine asset={m} available={transcriptionAvailable} cloud={local === false} />}
              </div>
              {m.status !== "failed" && noteOpen === m.id && <NoteEditor media={m} onClose={() => setNoteOpen(null)} />}
              {/* A file Scarlet couldn't read ends in a small ×, named on hover, that asks before taking it out of the project. */}
              {m.status === "failed" && <button type="button" className="edit-card-icon media-remove" aria-label={`Remove ${m.name}`} title="Remove"
                onClick={() => setRemoval(m)}><Icon name="x" size={12} /></button>}
            </li>
          ))}
        </ul>
      )}
      {/* The project's copy is deleted with it, so it asks first, as every press that deletes does. The dialog says why the engine wouldn't. */}
      {removal && <ConfirmDialog open danger onClose={() => setRemoval(null)} title={`Remove “${removal.name}”?`} confirmLabel="Remove"
        body="Scarlet deletes the project's copy of this file. This cannot be undone."
        onConfirm={() => useProjectStore.getState().removeMedia(removal.id)} />}
    </>
  );
}
