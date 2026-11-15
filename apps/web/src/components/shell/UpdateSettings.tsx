import { useState } from "react";
import { desktop } from "../../lib/desktop";
import { checkPublishedUpdate, type PublishedUpdate } from "../../lib/publishedUpdate";
import { refreshUpdateStatus, updateSource } from "../../lib/updateStatus";

export function UpdateSettings() {
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState("");
  const [update, setUpdate] = useState<PublishedUpdate | null>(null);
  async function check() {
    setChecking(true);
    setMessage("Checking for updates…");
    try {
      const source = updateSource();
      if (source === "release") {
        const newest = await desktop.checkForRelease();
        setMessage(newest ? `Version ${newest} is available. Scarlet is getting it ready.` : "Scarlet is up to date.");
        refreshUpdateStatus();
        return;
      }
      if (!source && __SCARLET_RELEASE_CHANNEL__) {
        const found = await checkPublishedUpdate(__SCARLET_RELEASE_CHANNEL__);
        setUpdate(found);
        setMessage(found ? `Scarlet ${found.version} is available.` : "Scarlet is up to date.");
        return;
      }
      const latest = await desktop.latestUpdateRevision();
      if (latest === __SCARLET_REVISION__) setMessage("Scarlet is up to date.");
      else if (__SCARLET_REVISION__) setMessage(`An update is available. Latest build: ${latest.slice(0, 7)}.`);
      else setMessage(`Latest build: ${latest.slice(0, 7)}. This build’s revision is unknown.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  }
  return <div className="mt-4 flex flex-wrap items-center gap-3">
    <button type="button" className="btn-quiet" disabled={checking} onClick={check}>Check for updates</button>
    <span role="status" className="text-sm text-muted">{message}</span>
    {update && <button type="button" className="btn-quiet" onClick={() => {
      void desktop.openUrl(update.url).catch(() => setMessage("Couldn’t open the download page. Try again."));
    }}>Download update</button>}
  </div>;
}
