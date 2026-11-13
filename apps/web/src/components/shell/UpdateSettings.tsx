import { useState } from "react";
import { desktop } from "../../lib/desktop";

export function UpdateSettings() {
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState("");
  async function check() {
    setChecking(true);
    setMessage("Checking for updates…");
    try {
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
  </div>;
}
