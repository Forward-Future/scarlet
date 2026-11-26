import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useInRouterContext, useLocation, useNavigate } from "react-router-dom";
import {
  fullRenderContext,
  type YouTubeChapter,
  type YouTubeUploadJob,
  type YouTubeVisibility,
} from "@scarlet/shared";
import { api, errorMessage } from "../../lib/client";
import { desktop, isDesktop } from "../../lib/desktop";
import { fmtBytes, pct } from "../../lib/format";
import type { ProjectData } from "../../stores/project";
import { useUiStore } from "../../stores/ui";
import { useYouTubeStore } from "../../stores/youtube";
import { ReportLink } from "../shell/ReportLink";
import { PreferenceSelect } from "../ui/PreferenceSelect";
import { ActivityProgress, Icon, InlineError, Spinner } from "../ui/primitives";

export function isYouTubeUploadActive(phase?: YouTubeUploadJob["phase"]): boolean {
  return phase === "queued" || phase === "rendering" || phase === "uploading";
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

  const [chapters, setChapters] = useState<YouTubeChapter[]>([]);
  const [chaptersText, setChaptersText] = useState("");
  const [loadingChapters, setLoadingChapters] = useState(false);
  const [chaptersError, setChaptersError] = useState("");
  const [title, setTitle] = useState(() => project.name.trim().slice(0, 100));
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<YouTubeVisibility>("private");
  const [connectBusy, setConnectBusy] = useState(false);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [copiedChapters, setCopiedChapters] = useState(false);

  const loadedVersionRef = useRef<string | null>(null);
  const userEditedDescriptionRef = useRef(false);

  const fetchChapters = useCallback(async () => {
    if (!hasCut || !project.head || !duration) return;
    if (loadedVersionRef.current === project.head) return;
    setLoadingChapters(true);
    setChaptersError("");
    try {
      const res = await api.youtubeChapters(current.id, project.head);
      loadedVersionRef.current = project.head;
      setChapters(res.chapters);
      setChaptersText(res.chaptersText);
      if (!userEditedDescriptionRef.current) {
        setDescription(res.chaptersText);
      }
    } catch (err) {
      setChaptersError(errorMessage(err));
    } finally {
      setLoadingChapters(false);
    }
  }, [current.id, duration, hasCut, project.head]);

  // Hydrate YouTube connection, active uploads, and final-cut chapters when switching into the tab.
  useEffect(() => {
    if (!active) return;
    void loadStatus();
    void loadProjectUploads(current.id);
    void fetchChapters();
  }, [active, current.id, loadStatus, loadProjectUploads, fetchChapters]);

  // Poll gently while OAuth sign-in is waiting or an upload is active (backs up WS events).
  const uploading = isYouTubeUploadActive(upload?.phase);
  useEffect(() => {
    if (!active) return;
    if (status?.state !== "connecting" && !uploading) return;
    const timer = window.setInterval(() => {
      if (status?.state === "connecting") void loadStatus();
      if (uploading && upload?.id) {
        void api.youtubeUpload(upload.id).then(r => applyUpload(r.upload)).catch(() => {});
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [active, status?.state, uploading, upload?.id, loadStatus, applyUpload]);

  const connected = status?.state === "connected" && !status.needsReconnect;
  const doneCurrent = upload?.phase === "done" && upload.context === context;
  const failed = upload?.phase === "failed";

  const onDescriptionChange = (value: string) => {
    userEditedDescriptionRef.current = true;
    setDescription(value);
  };

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

  const copyChapters = async () => {
    if (!chaptersText) return;
    try {
      await navigator.clipboard.writeText(chaptersText);
      setCopiedChapters(true);
      window.setTimeout(() => setCopiedChapters(false), 1800);
    } catch {
      // Clipboard may be unavailable in restricted contexts.
    }
  };

  const publish = async () => {
    if (!hasCut || !project.head || !duration || !connected || uploading || submitBusy) return;
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setSubmitError("Enter a video title.");
      return;
    }
    setSubmitBusy(true);
    setSubmitError("");
    try {
      const { upload: job } = await api.youtubePublish(current.id, {
        version: project.head,
        title: cleanTitle,
        description,
        visibility,
        quality: "delivery",
      });
      applyUpload(job);
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
    chapters,
    chaptersText,
    loadingChapters,
    chaptersError,
    title,
    setTitle,
    description,
    setDescription: onDescriptionChange,
    visibility,
    setVisibility,
    connectBusy,
    submitBusy,
    submitError,
    copiedChapters,
    upload,
    uploading,
    doneCurrent,
    failed,
    canPublish: hasCut && duration > 0 && connected && !uploading && !submitBusy && title.trim().length > 0,
    connectYouTube,
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
  const {
    status, connected, chapters, loadingChapters, chaptersError, title, setTitle, description, setDescription,
    visibility, setVisibility, connectBusy, submitError, copiedChapters, upload, uploading, doneCurrent, failed,
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
    return "";
  };

  return (
    <div className="space-y-3" data-testid="youtube-publish-view">
      {/* Account status bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-bg/60 px-3 py-2 text-[12px]">
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
                    : "Connect YouTube in Settings to enable direct upload."}
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
        <div className="rounded-xl border border-line bg-bg/70 p-4 space-y-2" role="status" data-testid="youtube-upload-done">
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
        </div>
      ) : (
        <fieldset disabled={uploading} className="min-w-0 space-y-3">
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
          </div>

          {/* Description with final-cut chapters */}
          <div>
            <div className="flex items-center justify-between gap-2 mb-1">
              <div className="flex items-center gap-2">
                <label className="label mb-0" htmlFor="yt-description">Description</label>
                {loadingChapters ? (
                  <span className="inline-flex items-center gap-1 text-[11px] text-dim">
                    <Spinner className="size-3" /> Loading chapters…
                  </span>
                ) : chapters.length > 0 ? (
                  <span className="text-[11px] text-dim">
                    {chapters.length} {chapters.length === 1 ? "chapter" : "chapters"} from final cut
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                {chapters.length > 0 && (
                  <button
                    type="button"
                    className="btn-quiet text-[11px] py-0.5 px-1.5"
                    onClick={() => void ctrl.copyChapters()}
                  >
                    {copiedChapters ? "Copied" : "Copy chapters"}
                  </button>
                )}
                <span className="text-[11px] text-dim tnum">{description.length} / 5,000</span>
              </div>
            </div>
            <textarea
              id="yt-description"
              rows={6}
              className="field border border-line min-h-[124px] py-2 text-[12.5px] resize-y font-sans leading-relaxed"
              maxLength={5000}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Video description and 0:00 chapters…"
            />
            {chaptersError && <InlineError>{chaptersError}</InlineError>}
          </div>

          {/* Visibility */}
          <div>
            <label className="label" htmlFor="yt-visibility">Visibility</label>
            <PreferenceSelect
              id="yt-visibility"
              value={visibility}
              onChange={setVisibility}
              disabled={uploading}
              options={VISIBILITY_OPTIONS}
            />
            <p className="mt-1.5 text-[11.5px] text-muted">
              {visibility === "private"
                ? "Uploads as a Private draft in YouTube Studio so you can finish details before going live."
                : visibility === "unlisted"
                  ? "Anyone with the link can watch. Hidden from search and your channel."
                  : "Visible to everyone on YouTube right away."}
            </p>
          </div>
        </fieldset>
      )}

      {/* Live render + upload progress */}
      {uploading && upload && (
        <div className="rounded-lg border border-line bg-bg/60 p-3" data-testid="youtube-upload-progress">
          <ActivityProgress
            label={`YouTube upload progress for ${upload.title}`}
            value={upload.phase === "queued" ? undefined : upload.progress}
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
