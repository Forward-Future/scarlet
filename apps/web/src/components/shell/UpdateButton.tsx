import { clearUpdatePlace, saveUpdatePlace } from "../../lib/updatePlace";
import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { desktop } from "../../lib/desktop";
import { buildPercent, refreshUpdateStatus, useUpdateStatus } from "../../lib/updateStatus";

const RING = 2 * Math.PI * 5;
const build = (revision: string) => <span className="font-mono">{revision.slice(0, 7)}</span>;

/** What hovering the control says: which build it is about, which one is running now, and what happens next. */
function UpdateHint({ id, title, children }: { id: string; title: ReactNode; children: ReactNode }) {
  return <span id={id} role="tooltip" className="update-hint"><span>
    <span className="text-fg">{title}</span>
    <span>You’re on {__SCARLET_VERSION__}{__SCARLET_REVISION__ && <>, build {build(__SCARLET_REVISION__)}</>}.</span>
    {children}
  </span></span>;
}

// The restart belongs to the app, not to one copy of the control: it can only be started once.
// `about` is the build a refusal was about, so the reason goes when the updater offers another.
let restart = { restarting: false, error: "", about: null as string | null };
const watchers = new Set<() => void>();
const watch = (watcher: () => void) => { watchers.add(watcher); return () => { watchers.delete(watcher); }; };
function setRestart(next: Partial<typeof restart>) {
  restart = { ...restart, ...next };
  watchers.forEach(watcher => watcher());
}

/**
 * The update, as one small control. It appears when the updater starts building a new version and shows how far along
 * the build is. Once the build is verified it becomes the button that restarts into it. A newer build takes over the control
 * while it is under way. It sits at the top right of the window.
 */
export function UpdateButton() {
  const { ready, building } = useUpdateStatus();
  const { restarting, error: refused, about } = useSyncExternalStore(watch, () => restart);
  const error = about === ready ? refused : "";
  const [now, setNow] = useState(Date.now);
  const showProgress = !!building && building.revision !== ready && !restarting;
  const hint = useId();

  useEffect(() => {
    if (!showProgress) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [showProgress]);

  async function install() {
    if (!ready || restart.restarting) return;
    if (!window.dispatchEvent(new Event("beforeunload", { cancelable: true }))) {
      setRestart({ error: "Save your changes before restarting.", about: ready });
      return;
    }
    setRestart({ restarting: true, error: "" });
    try {
      saveUpdatePlace();
      await desktop.restartForUpdate(ready);
    } catch (err) {
      clearUpdatePlace();
      setRestart({ restarting: false, error: err instanceof Error ? err.message : String(err), about: ready });
      refreshUpdateStatus();
    }
  }

  if (restarting || (ready && !showProgress)) return <aside className="update-control update-corner" aria-label="Scarlet update">
    <button type="button" className="update-button" disabled={restarting} onClick={install}
      aria-describedby={ready && !error ? hint : undefined}>
      <span className="update-button-dot" aria-hidden="true" />
      {restarting ? "Restarting…" : "Restart to update"}
    </button>
    {error ? <span role="alert" className="update-button-error">{error}</span>
      : ready && <UpdateHint id={hint} title={<>Build {build(ready)} is ready</>}>
        <span>Restarting installs it and brings you back here.</span>
      </UpdateHint>}
  </aside>;
  if (!building) return null;
  const percent = buildPercent(building, now);
  return <aside className="update-control update-corner" aria-label="Scarlet update">
    <span role="status" className="update-button" aria-label={`Updating Scarlet, ${percent}% built`} aria-describedby={hint}>
      <svg className="update-button-ring" viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="7" cy="7" r="5" />
        <circle cx="7" cy="7" r="5" strokeDasharray={RING} strokeDashoffset={RING * (1 - percent / 100)} />
      </svg>
      Updating
      <span className="update-button-figure">{percent}%</span>
    </span>
    <UpdateHint id={hint} title={<>Updating to build {build(building.revision)}</>}>
      <span>Scarlet is building it in the background. Keep working: this becomes Restart to update when it’s ready.</span>
    </UpdateHint>
  </aside>;
}
