import { useEffect, useState } from "react";
import { create } from "zustand";
import { desktop, isDesktop, type FfmpegStatus } from "../../lib/desktop";
import { errorMessage, IS_MOCK } from "../../lib/client";
import { InlineError, Spinner } from "../ui/primitives";

/** What Scarlet last learned about FFmpeg, shared so the banner, Settings and the sample project agree. */
const useFfmpegStatus = create<{ status: FfmpegStatus | null }>(() => ({ status: null }));
const setStatus = (status: FfmpegStatus) => useFfmpegStatus.setState({ status });

/** FFmpeg is missing on this desktop, as far as Scarlet has checked. False before the check and off the desktop. */
export function useFfmpegMissing(): boolean {
  const status = useFfmpegStatus(s => s.status);
  return isDesktop() && !IS_MOCK && !!status && !status.installed;
}

function useFfmpegSetup() {
  const active = isDesktop() && !IS_MOCK;
  const status = useFfmpegStatus(s => s.status);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!active) return;
    let alive = true;
    void desktop.ffmpegStatus()
      .then(s => { if (alive) setStatus(s); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [active]);

  const install = async () => {
    if (installing) return;
    setInstalling(true);
    setError("");
    try {
      const next = await desktop.ffmpegInstall();
      setStatus(next);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setInstalling(false);
    }
  };

  return { active, status, installing, error, install };
}

/**
 * Shown on the Projects screen only when FFmpeg is missing on desktop.
 * Disappears automatically once FFmpeg is installed.
 */
export function FfmpegSetupBanner() {
  const { active, status, installing, error, install } = useFfmpegSetup();
  if (!active || !status || status.installed) return null;

  return (
    <section className="card p-4 mb-5 flex flex-wrap items-center justify-between gap-4" role="region" aria-label="Video tools setup">
      <div className="min-w-0 space-y-1">
        <h2 className="text-[14px] font-medium text-fg">Install FFmpeg to import and export video</h2>
        <p className="text-[12.5px] text-muted">
          {status.canInstall
            ? "Scarlet downloads a verified copy of FFmpeg automatically — no terminal needed."
            : "Install FFmpeg from your system’s package manager (for example, sudo apt install ffmpeg), then reopen Scarlet."}
        </p>
        {error && <InlineError>{error}</InlineError>}
      </div>
      {status.canInstall && (
        <button type="button" className="btn-primary shrink-0" disabled={installing} onClick={() => void install()}>
          {installing ? <><Spinner className="size-3" /> Installing FFmpeg…</> : "Install FFmpeg"}
        </button>
      )}
    </section>
  );
}

/**
 * Shown in Settings > General on desktop so editors can check or install FFmpeg at any time.
 */
export function FfmpegSetupCard() {
  const { active, status, installing, error, install } = useFfmpegSetup();
  if (!active || !status) return null;

  return (
    <section className="card p-5 space-y-3" aria-labelledby="ffmpeg-setup-heading">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h2 id="ffmpeg-setup-heading" className="text-[15px] font-medium text-fg">Video tools (FFmpeg)</h2>
          <p className="text-[12.5px] text-muted">
            {status.installed
              ? "Ready for importing, playback, and exports."
              : status.canInstall
                ? "Needed to import, play, and export video. Installs automatically without a terminal."
                : "Needed to import, play, and export video. Install the ffmpeg package from your system’s package manager."}
          </p>
        </div>
        {status.installed ? (
          <span className="text-[12.5px] text-muted shrink-0">✓ Installed</span>
        ) : status.canInstall ? (
          <button type="button" className="btn-primary shrink-0" disabled={installing} onClick={() => void install()}>
            {installing ? <><Spinner className="size-3" /> Installing FFmpeg…</> : "Install FFmpeg"}
          </button>
        ) : null}
      </div>
      {error && <InlineError>{error}</InlineError>}
    </section>
  );
}
