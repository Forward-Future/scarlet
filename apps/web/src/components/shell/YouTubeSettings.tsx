import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { api, errorMessage } from "../../lib/client";
import { desktop, isDesktop } from "../../lib/desktop";
import { initials } from "../../lib/format";
import { useYouTubeStore } from "../../stores/youtube";
import { InlineError, Spinner } from "../ui/primitives";

function YouTubeMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="2" y="5" width="20" height="14" rx="4" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10 9.25 15.25 12 10 14.75V9.25Z" fill="currentColor" />
    </svg>
  );
}

async function openExternal(url: string) {
  if (isDesktop()) {
    await desktop.openUrl(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/**
 * Settings → General → YouTube:
 * Local Google OAuth 2.0 (PKCE) connection card stored in private local storage on this machine.
 */
export function YouTubeSettings() {
  const { hash } = useLocation();
  const cardRef = useRef<HTMLElement>(null);
  const status = useYouTubeStore(s => s.status);
  const loadStatus = useYouTubeStore(s => s.loadStatus);
  const applyStatus = useYouTubeStore(s => s.applyStatus);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [configOpen, setConfigOpen] = useState(false);
  const [clientIdDraft, setClientIdDraft] = useState("");
  const [clientSecretDraft, setClientSecretDraft] = useState("");
  const [configSavedNote, setConfigSavedNote] = useState("");

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (hash === "#youtube") {
      cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [hash]);

  // Poll gently while waiting for the browser OAuth callback in case live socket is delayed.
  useEffect(() => {
    if (status?.state !== "connecting") return;
    const timer = window.setInterval(() => { void loadStatus(); }, 1500);
    return () => window.clearInterval(timer);
  }, [status?.state, loadStatus]);

  const connected = status?.state === "connected" && !status.needsReconnect;
  const connecting = status?.state === "connecting";
  const needsReconnect = !!status?.needsReconnect;
  const configured = !!status?.configured;

  const connect = async () => {
    setBusy(true);
    setActionError("");
    setConfigSavedNote("");
    try {
      const res = await api.youtubeConnect();
      applyStatus(res.status);
      if (res.authUrl) {
        await openExternal(res.authUrl);
      }
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const cancelConnect = async () => {
    setBusy(true);
    setActionError("");
    try {
      const res = await api.youtubeCancelConnect();
      applyStatus(res.status);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setActionError("");
    try {
      const res = await api.youtubeDisconnect();
      applyStatus(res.status);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const saveOAuthConfig = async () => {
    const id = clientIdDraft.trim();
    const secret = clientSecretDraft.trim();
    if (!id) {
      setActionError("Enter your Google OAuth Client ID.");
      return;
    }
    setBusy(true);
    setActionError("");
    setConfigSavedNote("");
    try {
      const res = await api.youtubeUpdateConfig({
        clientId: id,
        ...(secret ? { clientSecret: secret } : {}),
      });
      applyStatus(res.status);
      setClientIdDraft("");
      setClientSecretDraft("");
      setConfigOpen(false);
      setConfigSavedNote("OAuth client saved privately on this computer.");
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const clearOAuthConfig = async () => {
    setBusy(true);
    setActionError("");
    setConfigSavedNote("");
    try {
      const res = await api.youtubeUpdateConfig({ clientId: null, clientSecret: null });
      applyStatus(res.status);
      setClientIdDraft("");
      setClientSecretDraft("");
      setConfigOpen(false);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const dotClass = connected ? "bg-ok" : needsReconnect ? "bg-warn" : connecting ? "bg-fg pulse" : "bg-dim";
  const channel = status?.channel;
  const shownError = actionError || (status?.state === "error" && status.error ? status.error : "");

  return (
    <section
      ref={cardRef}
      id="youtube-settings"
      data-testid="youtube-settings"
      className="card transcription-preferences youtube-settings"
      aria-labelledby="youtube-heading"
    >
      <div className="transcription-header">
        <div className="transcription-heading">
          <span className="transcription-glyph"><YouTubeMark size={20} /></span>
          <div>
            <h2 id="youtube-heading">YouTube</h2>
            <p>Connect your channel to draft chapters and upload finished videos straight to YouTube Studio.</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {connecting ? (
            <>
              {status?.authUrl && (
                <button
                  type="button"
                  className="btn-quiet text-[12px]"
                  onClick={() => void openExternal(status.authUrl!).catch(err => setActionError(errorMessage(err)))}
                >
                  Open browser again
                </button>
              )}
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => void cancelConnect()}>
                Cancel
              </button>
            </>
          ) : connected ? (
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => void disconnect()}>
              Disconnect
            </button>
          ) : needsReconnect ? (
            <>
              <button type="button" className="btn-quiet text-[12px]" disabled={busy} onClick={() => void disconnect()}>
                Disconnect
              </button>
              <button type="button" className="btn-primary" disabled={busy || !configured} onClick={() => void connect()}>
                Reconnect
              </button>
            </>
          ) : configured ? (
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void connect()}>
              Connect YouTube
            </button>
          ) : (
            <button
              type="button"
              className="btn-ghost"
              disabled={busy}
              aria-expanded={configOpen}
              onClick={() => { setConfigOpen(o => !o); setActionError(""); }}
            >
              {configOpen ? "Close setup" : "Set up OAuth"}
            </button>
          )}
        </div>
      </div>

      {/* Status bar */}
      <div className="transcription-status flex flex-wrap items-center justify-between gap-2 text-muted">
        <div className="flex items-center gap-2.5 min-w-0">
          {connecting ? (
            <>
              <Spinner className="size-3.5 shrink-0" />
              <span>Waiting for Google sign-in in your browser…</span>
            </>
          ) : connected && channel ? (
            <>
              {channel.thumbnailUrl ? (
                <img
                  src={channel.thumbnailUrl}
                  alt=""
                  className="size-6 rounded-full object-cover border border-line shrink-0"
                />
              ) : (
                <span className="size-6 rounded-full bg-raised border border-line text-[10px] font-medium text-fg grid place-items-center shrink-0">
                  {initials(channel.title)}
                </span>
              )}
              <span className={`size-2 rounded-full shrink-0 ${dotClass}`} aria-hidden />
              <span className="text-fg font-medium truncate">{channel.title}</span>
              {channel.handle && <span className="text-dim truncate">{channel.handle}</span>}
              <span className="text-dim">· Tokens stay on this computer</span>
            </>
          ) : needsReconnect ? (
            <>
              <span className={`size-2 rounded-full shrink-0 ${dotClass}`} aria-hidden />
              <span className="text-warn">Sign-in expired{channel ? ` for ${channel.title}` : ""}. Reconnect to upload.</span>
            </>
          ) : configured ? (
            <>
              <span className={`size-2 rounded-full shrink-0 ${dotClass}`} aria-hidden />
              <span>
                Not connected · Ready to sign in
                {status?.configSource === "custom" && status.clientIdHint ? ` (${status.clientIdHint})` : ""}
              </span>
            </>
          ) : (
            <>
              <span className={`size-2 rounded-full shrink-0 ${dotClass}`} aria-hidden />
              <span>No Google OAuth Client ID is set yet. Add a Desktop App Client ID to enable direct uploads.</span>
            </>
          )}
        </div>

        {!connecting && (
          <div className="flex items-center gap-2 shrink-0">
            {status?.configSource === "env" ? (
              <span className="text-[11.5px] text-dim">Built-in Google OAuth</span>
            ) : (
              <button
                type="button"
                className="btn-quiet text-[12px] py-1 px-2"
                aria-expanded={configOpen}
                onClick={() => { setConfigOpen(o => !o); setActionError(""); }}
              >
                {status?.hasCustomClientId || connected ? "OAuth client" : "Add Client ID"}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Optional custom Google OAuth Client ID fallback (when no built-in env client ID is configured) */}
      {configOpen && status?.configSource !== "env" && (
        <div
          className="mt-3 rounded-lg border border-line bg-bg/60 p-3.5 space-y-3"
          role="group"
          aria-label="Google OAuth client settings"
          onKeyDown={e => {
            if (e.key === "Enter" && !busy && clientIdDraft.trim()) {
              e.preventDefault();
              void saveOAuthConfig();
            }
          }}
        >
          <p className="text-[12px] text-muted leading-relaxed">
            Create a <strong className="text-fg font-medium">Desktop app</strong> OAuth Client in Google Cloud Console with the YouTube Data API v3 enabled. Scarlet signs in locally using loopback PKCE and stores tokens encrypted on this computer.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <div className="label">Google OAuth Client ID</div>
              <input
                aria-label="Google OAuth Client ID"
                className="field border border-line font-mono text-[12px]"
                value={clientIdDraft}
                onChange={e => setClientIdDraft(e.target.value)}
                placeholder={status?.clientIdHint || "123456789-abc.apps.googleusercontent.com"}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div>
              <div className="label">Client Secret (optional)</div>
              <input
                aria-label="Google OAuth Client Secret"
                type="password"
                className="field border border-line font-mono text-[12px]"
                value={clientSecretDraft}
                onChange={e => setClientSecretDraft(e.target.value)}
                placeholder={status?.hasCustomClientSecret ? "Saved (leave blank to keep)" : "Optional for Desktop clients"}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {status?.hasCustomClientId && (
              <button type="button" className="btn-quiet text-[12px] mr-auto" disabled={busy} onClick={() => void clearOAuthConfig()}>
                Remove saved client
              </button>
            )}
            <button type="button" className="btn-ghost text-[12px]" disabled={busy} onClick={() => setConfigOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary text-[12px]"
              disabled={busy || !clientIdDraft.trim()}
              onClick={() => void saveOAuthConfig()}
            >
              {busy && <Spinner className="size-3" />} Save Client ID
            </button>
          </div>
        </div>
      )}

      {configSavedNote && <p className="mt-2 text-[12px] text-ok" role="status">{configSavedNote}</p>}
      <InlineError>{shownError}</InlineError>
    </section>
  );
}
