import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { useInRouterContext, useLocation, useNavigate } from "react-router-dom";
import {
  fullRenderContext,
  type YouTubePublishingKit,
  type YouTubeThumbnailCandidate,
  type YouTubeUploadJob,
  type YouTubeVisibility,
} from "@scarlet/shared";
import { api, errorMessage } from "../../lib/client";
import { desktop, isDesktop } from "../../lib/desktop";
import { fmtBytes, pct } from "../../lib/format";
import { usePlayerStore } from "../../stores/player";
import type { ProjectData } from "../../stores/project";
import { useUiStore } from "../../stores/ui";
import { useYouTubeStore } from "../../stores/youtube";
import { ReportLink } from "../shell/ReportLink";
import { PreferenceSelect } from "../ui/PreferenceSelect";
import { ActivityProgress, Icon, InlineError, Spinner } from "../ui/primitives";

export function isYouTubeUploadActive(phase?: YouTubeUploadJob["phase"]): boolean {
  return phase === "queued" || phase === "rendering" || phase === "uploading" || phase === "thumbnail";
}

const VISIBILITY_OPTIONS: Array<{ value: YouTubeVisibility; label: string }> = [
  { value: "private", label: "Private (draft)" },
  { value: "unlisted", label: "Unlisted" },
  { value: "public", label: "Public" },
];

async function openExternal(url: string) {
  if (isDesktop()) await desktop.openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

function RouterSettingsButton({ className, children, onBeforeNavigate }: { className?: string; children: ReactNode; onBeforeNavigate?: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        useUiStore.setState({ settingsReturnTo: `${location.pathname}${location.search}` });
        onBeforeNavigate?.();
        navigate("/settings#youtube");
      }}
    >
      {children}
    </button>
  );
}

function SettingsLinkButton({ className, children, onBeforeNavigate }: { className?: string; children: ReactNode; onBeforeNavigate?: () => void }) {
  const inRouter = useInRouterContext();
  if (!inRouter) {
    return <a href="/settings#youtube" className={className} onClick={onBeforeNavigate}>{children}</a>;
  }
  return <RouterSettingsButton className={className} onBeforeNavigate={onBeforeNavigate}>{children}</RouterSettingsButton>;
}

export function useYouTubePublish(current: ProjectData, active: boolean, hasCut: boolean, duration: number) {
  const { project } = current;
  const context = fullRenderContext(project);
  const status = useYouTubeStore(s => s.status);
  const loadStatus = useYouTubeStore(s => s.loadStatus);
  const applyStatus = useYouTubeStore(s => s.applyStatus);
  const upload = useYouTubeStore(s => s.uploads[current.id]);
  const loadProjectUploads = useYouTubeStore(s => s.loadProjectUploads);
  const applyUpload = useYouTubeStore(s => s.applyUpload);
  const clearUpload = useYouTubeStore(s => s.clearUpload);

  const [kit, setKit] = useState<YouTubePublishingKit | null>(null);
  const [loadingKit, setLoadingKit] = useState(false);
  const [kitError, setKitError] = useState("");
  const [title, setTitle] = useState(() => project.name.slice(0, 100));
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<YouTubeVisibility>("private");
  const [tagsText, setTagsText] = useState("");
  const [thumbnails, setThumbnails] = useState<YouTubeThumbnailCandidate[]>([]);
  const [selectedThumbId, setSelectedThumbId] = useState<string | undefined>(undefined);
  const [thumbBusy, setThumbBusy] = useState<"playhead" | "custom" | null>(null);
  const [thumbError, setThumbError] = useState("");
  const [connectBusy, setConnectBusy] = useState(false);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [copiedChapters, setCopiedChapters] = useState(false);

  const loadedVersionRef = useRef<string | null>(null);

  const fetchKit = useCallback(async (force = false) => {
    if (!hasCut || !project.head || !duration) return;
    if (!force && loadedVersionRef.current === project.head && kit) return;
    setLoadingKit(true);
    setKitError("");
    try {
      const { kit: next } = await api.youtubePublishingKit(current.id, { version: project.head });
      loadedVersionRef.current = project.head;
      setKit(next);
      setTitle(next.title);
      setDescription(next.description);
      setTagsText(next.tags.join(", "));
      setThumbnails(next.thumbnails);
      setSelectedThumbId(next.thumbnails[0]?.id);
    } catch (err) {
      setKitError(errorMessage(err));
    } finally {
      setLoadingKit(false);
    }
  }, [current.id, duration, hasCut, kit, project.head]);

  // Hydrate YouTube connection, active uploads, and draft Publishing Kit when switching into the tab.
  useEffect(() => {
    if (!active) return;
    void loadStatus();
    void loadProjectUploads(current.id);
    void fetchKit(false);
  }, [active, current.id, loadStatus, loadProjectUploads, fetchKit]);

  // Poll gently while OAuth sign-in is waiting or an upload is active (backups WS events).
  useEffect(() => {
    if (!active || status?.state !== "connecting") return;
    const timer = window.setInterval(() => { void loadStatus(); }, 1500);
    return () => window.clearInterval(timer);
  }, [active, status?.state, loadStatus]);

  useEffect(() => {
    if (!active || !upload || !isYouTubeUploadActive(upload.phase)) return;
    const timer = window.setInterval(() => {
      void api.youtubeUpload(upload.id).then(({ upload: next }) => applyUpload(next)).catch(() => undefined);
    }, 800);
    return () => window.clearInterval(timer);
  }, [active, upload, applyUpload]);

  const connected = status?.state === "connected" && !status.needsReconnect;
  const uploading = !!upload && isYouTubeUploadActive(upload.phase);
  const doneCurrent = upload?.phase === "done" && upload.context === context;
  const failed = upload?.phase === "failed";

  const connectYouTube = async () => {
    setConnectBusy(true);
    setSubmitError("");
    try {
      const res = await api.youtubeConnect();
      applyStatus(res.status);
      if (res.authUrl) await openExternal(res.authUrl);
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setConnectBusy(false);
    }
  };

  const capturePlayhead = async () => {
    if (!project.head || thumbBusy) return;
    setThumbBusy("playhead");
    setThumbError("");
    try {
      const time = usePlayerStore.getState().time;
      const { thumbnail } = await api.youtubeCaptureThumbnail(current.id, { version: project.head, time });
      setThumbnails(prev => [thumbnail, ...prev.filter(t => t.id !== thumbnail.id)]);
      setSelectedThumbId(thumbnail.id);
    } catch (err) {
      setThumbError(errorMessage(err));
    } finally {
      setThumbBusy(null);
    }
  };

  const uploadCustomFile = async (file: Blob | { path: string }, name?: string) => {
    setThumbBusy("custom");
    setThumbError("");
    try {
      const { thumbnail } = await api.youtubeUploadThumbnail(current.id, file, name);
      setThumbnails(prev => [thumbnail, ...prev.filter(t => t.id !== thumbnail.id)]);
      setSelectedThumbId(thumbnail.id);
    } catch (err) {
      setThumbError(errorMessage(err));
    } finally {
      setThumbBusy(null);
    }
  };

  const pickCustomDesktop = async () => {
    if (thumbBusy) return;
    try {
      const path = await desktop.pickFile("Choose YouTube thumbnail");
      if (path) await uploadCustomFile({ path });
    } catch (err) {
      setThumbError(errorMessage(err));
    }
  };

  const onFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void uploadCustomFile(file, file.name);
  };

  const copyChapters = async () => {
    if (!kit?.chapters.length) return;
    const text = kit.chapters.map(c => `${c.timestamp} ${c.title}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopiedChapters(true);
      window.setTimeout(() => setCopiedChapters(false), 1800);
    } catch {
      /* clipboard may be unavailable in non-secure test env */
    }
  };

  const publish = async () => {
    if (!hasCut || !duration || !connected || uploading || submitBusy) return;
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setSubmitError("Enter a video title before uploading.");
      return;
    }
    const tags = tagsText
      .split(",")
      .map(t => t.trim())
      .filter(Boolean)
      .slice(0, 50);

    setSubmitBusy(true);
    setSubmitError("");
    try {
      const { upload: created } = await api.youtubePublish(current.id, {
        version: project.head ?? undefined,
        title: cleanTitle,
        description,
        tags,
        visibility,
        ...(selectedThumbId ? { thumbnailId: selectedThumbId } : {}),
        quality: "delivery",
      });
      applyUpload(created);
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setSubmitBusy(false);
    }
  };

  const cancelUpload = async () => {
    if (!upload || !uploading) return;
    try {
      const { upload: next } = await api.youtubeCancelUpload(upload.id);
      applyUpload(next);
    } catch (err) {
      setSubmitError(errorMessage(err));
    }
  };

  const openStudio = async () => {
    if (!upload?.studioUrl) return;
    setSubmitError("");
    try {
      await openExternal(upload.studioUrl);
    } catch (err) {
      setSubmitError(errorMessage(err));
    }
  };

  const resetFinished = () => {
    clearUpload(current.id);
    setSubmitError("");
  };

  return {
    status,
    connected,
    kit,
    loadingKit,
    kitError,
    title,
    setTitle,
    description,
    setDescription,
    visibility,
    setVisibility,
    tagsText,
    setTagsText,
    thumbnails,
    selectedThumbId,
    setSelectedThumbId,
    thumbBusy,
    thumbError,
    connectBusy,
    submitBusy,
    submitError,
    copiedChapters,
    upload,
    uploading,
    doneCurrent,
    failed,
    canPublish: hasCut && duration > 0 && connected && !uploading && !submitBusy && title.trim().length > 0,
    fetchKit,
    connectYouTube,
    capturePlayhead,
    pickCustomDesktop,
    onFileInputChange,
    copyChapters,
    publish,
    cancelUpload,
    openStudio,
    resetFinished,
  };
}

export type YouTubePublishController = ReturnType<typeof useYouTubePublish>;

export function YouTubePublishView({
  ctrl,
  hasCut,
  onClose,
}: {
  ctrl: YouTubePublishController;
  hasCut: boolean;
  onClose(): void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const {
    status, connected, kit, loadingKit, kitError, title, setTitle, description, setDescription,
    visibility, setVisibility, tagsText, setTagsText, thumbnails, selectedThumbId, setSelectedThumbId,
    thumbBusy, thumbError, connectBusy, submitError, copiedChapters, upload, uploading, doneCurrent, failed,
  } = ctrl;

  const progressLabel = () => {
    if (!upload) return "";
    if (upload.phase === "queued") return "Preparing upload…";
    if (upload.phase === "rendering") {
      const percent = Math.round(upload.progress * 100);
      return percent > 0 && percent < 97 ? `Rendering video… · ${pct(upload.progress)}` : "Rendering video…";
    }
    if (upload.phase === "uploading") {
      const bytes = upload.bytesTotal
        ? ` · ${fmtBytes(upload.bytesUploaded ?? 0)} / ${fmtBytes(upload.bytesTotal)}`
        : "";
      return `Uploading to YouTube… · ${pct(upload.progress)}${bytes}`;
    }
    if (upload.phase === "thumbnail") return "Applying thumbnail…";
    return "";
  };

  return (
    <div className="space-y-2.5" data-testid="youtube-publish-view">
      {/* Account status bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-bg/60 px-3 py-1.5 text-[12px]">
        {connected && status?.channel ? (
          <>
            <div className="flex items-center gap-2 min-w-0">
              <span className="size-2 rounded-full bg-ok shrink-0" aria-hidden />
              <span className="text-fg font-medium truncate">{status.channel.title}</span>
              {status.channel.handle && <span className="text-dim truncate">{status.channel.handle}</span>}
            </div>
            <SettingsLinkButton className="btn-quiet text-[11.5px] py-0.5 px-2" onBeforeNavigate={onClose}>
              Switch account
            </SettingsLinkButton>
          </>
        ) : status?.state === "connecting" ? (
          <div className="flex items-center gap-2 text-muted">
            <Spinner className="size-3.5" />
            <span>Waiting for Google sign-in in your browser…</span>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 min-w-0 text-muted">
              <span className={`size-2 rounded-full shrink-0 ${status?.needsReconnect ? "bg-warn" : "bg-dim"}`} aria-hidden />
              <span className="truncate">
                {status?.needsReconnect
                  ? "Your YouTube sign-in expired. Reconnect to upload."
                  : status?.configured
                    ? "Connect your YouTube channel to upload straight from Scarlet."
                    : "Connect YouTube in Settings to enable direct upload (you can still draft and copy your kit below)."}
              </span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {status?.configured ? (
                <button type="button" className="btn-ghost text-[12px] py-1 px-2.5" disabled={connectBusy} onClick={() => void ctrl.connectYouTube()}>
                  {status.needsReconnect ? "Reconnect" : "Connect YouTube"}
                </button>
              ) : (
                <SettingsLinkButton className="btn-ghost text-[12px] py-1 px-2.5" onBeforeNavigate={onClose}>
                  Set up in Settings
                </SettingsLinkButton>
              )}
            </div>
          </>
        )}
      </div>

      {!hasCut ? (
        <InlineError>There’s no video to publish yet.</InlineError>
      ) : doneCurrent && upload ? (
        /* Completed upload confirmation card */
        <div className="rounded-xl border border-line bg-bg/70 p-4 space-y-3" role="status" data-testid="youtube-upload-done">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 text-ok shrink-0"><Icon name="check" size={16} /></span>
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-medium text-fg">Uploaded to YouTube</div>
              <p className="mt-0.5 text-[12px] text-muted truncate">{upload.title}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11.5px] text-dim">
                <span className="chip bg-raised text-fg capitalize">{upload.visibility}</span>
                {upload.reusedRender && <span>Reused your existing export</span>}
              </div>
            </div>
          </div>
          {upload.thumbnailWarning && (
            <p className="rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-[12px] text-warn">
              {upload.thumbnailWarning}
            </p>
          )}
        </div>
      ) : (
        <fieldset disabled={uploading} className="min-w-0 space-y-2.5">
          {/* Kit header actions */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
            <div className="flex items-center gap-2 text-muted">
              {loadingKit ? (
                <>
                  <Spinner className="size-3.5" />
                  <span>Drafting title, chapters, and thumbnails…</span>
                </>
              ) : kit ? (
                <span>
                  Publishing Kit · {kit.chapters.length} {kit.chapters.length === 1 ? "chapter" : "chapters"}
                  {kit.draftedWith === "ai" ? " · Drafted by Scarlet" : ""}
                </span>
              ) : (
                <span>Publishing Kit</span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {kit && kit.chapters.length > 0 && (
                <button type="button" className="btn-quiet text-[11.5px] py-1 px-2" onClick={() => void ctrl.copyChapters()}>
                  {copiedChapters ? "Copied chapters" : "Copy chapters"}
                </button>
              )}
              <button
                type="button"
                className="btn-quiet text-[11.5px] py-1 px-2"
                disabled={loadingKit || uploading}
                onClick={() => void ctrl.fetchKit(true)}
              >
                <Icon name="refresh" size={12} /> Redraft
              </button>
            </div>
          </div>

          {kitError && <InlineError>{kitError}</InlineError>}

          {/* Title */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="label mb-0" htmlFor="yt-title">Title</label>
              <span className="text-[11px] text-dim tnum">{title.length} / 100</span>
            </div>
            <input
              id="yt-title"
              className="field border border-line"
              maxLength={100}
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Video title"
            />
            {kit && kit.titleOptions.length > 1 && (
              <div className="mt-1.5 flex items-center gap-1.5 overflow-x-auto pb-0.5">
                {kit.titleOptions.map(option => (
                  <button
                    key={option}
                    type="button"
                    className={`shrink-0 max-w-[240px] rounded-md border px-2 py-0.5 text-[11px] transition-colors truncate ${
                      option === title
                        ? "border-fg/40 bg-raised text-fg"
                        : "border-line bg-bg/50 text-muted hover:text-fg hover:border-fg/30"
                    }`}
                    onClick={() => setTitle(option)}
                    title={option}
                  >
                    {option}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Description with final-cut chapters */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="label mb-0" htmlFor="yt-description">Description & chapters</label>
              <span className="text-[11px] text-dim tnum">{description.length} / 5,000</span>
            </div>
            <textarea
              id="yt-description"
              rows={5}
              className="field border border-line min-h-[112px] py-1.5 text-[12.5px] resize-y font-sans leading-[1.45]"
              maxLength={5000}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Video description and 0:00 chapters…"
            />
          </div>

          {/* Visibility + Tags */}
          <div className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="yt-visibility">Visibility</label>
              <PreferenceSelect
                id="yt-visibility"
                value={visibility}
                onChange={setVisibility}
                disabled={uploading}
                options={VISIBILITY_OPTIONS}
              />
              <p className="mt-1 text-[11.5px] text-muted">
                {visibility === "private"
                  ? "Uploads as a Private draft in YouTube Studio so you can review before going live."
                  : visibility === "unlisted"
                    ? "Anyone with the link can watch. Hidden from search and your channel."
                    : "Visible to everyone on YouTube right away."}
              </p>
            </div>
            <div>
              <label className="label" htmlFor="yt-tags">Tags</label>
              <input
                id="yt-tags"
                className="field border border-line"
                value={tagsText}
                onChange={e => setTagsText(e.target.value)}
                placeholder="tutorial, editing, scarlet"
              />
              <p className="mt-1 text-[11.5px] text-muted">Comma-separated keywords (optional).</p>
            </div>
          </div>

          {/* Thumbnail selector */}
          <div className="border-t border-line pt-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
              <span className="label mb-0">Thumbnail</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="btn-quiet text-[11.5px] py-1 px-2"
                  disabled={!!thumbBusy || uploading}
                  onClick={() => void ctrl.capturePlayhead()}
                >
                  {thumbBusy === "playhead" ? <Spinner className="size-3" /> : <Icon name="image" size={12} />}
                  Use current frame
                </button>
                <button
                  type="button"
                  className="btn-quiet text-[11.5px] py-1 px-2"
                  disabled={!!thumbBusy || uploading}
                  onClick={() => {
                    if (isDesktop()) void ctrl.pickCustomDesktop();
                    else fileInputRef.current?.click();
                  }}
                >
                  {thumbBusy === "custom" ? <Spinner className="size-3" /> : <Icon name="upload" size={12} />}
                  Choose image…
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={ctrl.onFileInputChange}
                />
              </div>
            </div>

            {thumbnails.length > 0 ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Thumbnail choices">
                {thumbnails.map(thumb => {
                  const selected = thumb.id === selectedThumbId;
                  return (
                    <button
                      key={thumb.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setSelectedThumbId(thumb.id)}
                      className={`group relative aspect-video overflow-hidden rounded-lg border bg-bg text-left transition-all ${
                        selected
                          ? "border-hi ring-2 ring-hi/80"
                          : "border-line opacity-80 hover:opacity-100 hover:border-fg/40"
                      }`}
                    >
                      <img
                        src={thumb.previewUrl}
                        alt={`Thumbnail ${thumb.label}`}
                        className="h-full w-full object-cover"
                      />
                      <span className="absolute bottom-1 left-1 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-medium text-fg tnum">
                        {thumb.label}
                      </span>
                      {selected && (
                        <span className="absolute top-1 right-1 size-4 rounded-full bg-hi text-bg grid place-items-center">
                          <Icon name="check" size={10} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : loadingKit ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[0, 1, 2, 3].map(i => (
                  <div key={i} className="aspect-video rounded-lg border border-line bg-bg/60 animate-pulse" />
                ))}
              </div>
            ) : (
              <p className="text-[12px] text-dim">No frames extracted yet. Capture the current frame or choose an image.</p>
            )}
            <InlineError>{thumbError}</InlineError>
          </div>
        </fieldset>
      )}

      {/* Live render + upload progress */}
      {uploading && upload && (
        <div className="rounded-lg border border-line bg-bg/60 p-3" data-testid="youtube-upload-progress">
          <ActivityProgress
            label={`YouTube upload progress for ${upload.title}`}
            value={upload.phase === "queued" || upload.phase === "thumbnail" ? undefined : upload.progress}
          >
            {progressLabel()}
          </ActivityProgress>
          {upload.reusedRender && upload.phase === "uploading" && (
            <p className="mt-1 text-[11px] text-dim">Reused your existing export for this cut.</p>
          )}
          <p className="mt-1.5 text-[11.5px] text-muted">Your upload continues in the background while you edit.</p>
        </div>
      )}

      {/* Upload or submission errors */}
      {(submitError || (failed && upload?.error)) && (
        <div className="space-y-1.5">
          <InlineError>{submitError || upload?.error}</InlineError>
          <div className="flex flex-wrap items-center gap-2">
            {upload?.errorCode === "youtube_reconnect_required" && (
              <SettingsLinkButton className="btn-ghost text-[12px]" onBeforeNavigate={onClose}>
                Reconnect in Settings
              </SettingsLinkButton>
            )}
            {failed && (
              <ReportLink
                className="btn-quiet -ml-2"
                label="Report this problem"
                about={`YouTube upload failed${upload?.errorCode ? ` (${upload.errorCode})` : ""}`}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function YouTubePublishFooter({
  ctrl,
  onClose,
}: {
  ctrl: YouTubePublishController;
  onClose(): void;
}) {
  const { uploading, doneCurrent, failed, canPublish, submitBusy, upload } = ctrl;

  if (uploading) {
    return (
      <>
        <button type="button" className="btn-quiet" onClick={() => void ctrl.cancelUpload()}>
          Cancel upload
        </button>
        <button type="button" className="btn-primary" onClick={onClose}>
          Continue editing
        </button>
      </>
    );
  }

  if (doneCurrent && upload?.studioUrl) {
    return (
      <>
        <button type="button" className="btn-quiet mr-auto" onClick={ctrl.resetFinished}>
          Upload again
        </button>
        <button type="button" className="btn-ghost" onClick={onClose}>
          Close
        </button>
        <button type="button" className="btn-primary" onClick={() => void ctrl.openStudio()}>
          <Icon name="link" size={14} /> Open in YouTube Studio
        </button>
      </>
    );
  }

  return (
    <>
      <button type="button" className="btn-ghost" onClick={onClose}>
        Cancel
      </button>
      <button
        type="button"
        className="btn-primary"
        disabled={!canPublish}
        onClick={() => void ctrl.publish()}
      >
        {submitBusy && <Spinner className="size-3" />}
        {failed ? "Retry upload" : "Export & Upload to YouTube"}
      </button>
    </>
  );
}
