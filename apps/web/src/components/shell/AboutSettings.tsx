import { useEffect, useState } from "react";
import { FEATURE_NAMES, type TelemetryUnavailable } from "@scarlet/shared";
import appIcon from "../../../../desktop/src-tauri/icons/128x128@2x.png";
import { api, errorMessage, IS_MOCK } from "../../lib/client";
import { desktop, isDesktop } from "../../lib/desktop";
import { fileBaseName } from "../../lib/format";
import { exportLogsAndReport, openProblemReport } from "../../lib/reportProblem";
import { Icon, InlineError, Loading, Toggle } from "../ui/primitives";
import { Changelog } from "./Changelog";
import { UpdateSettings } from "./UpdateSettings";

export function AboutSettings() {
  return (
    <section className="about-settings" aria-label="About Scarlet">
      <div className="card about-build">
        <div className="about-identity">
          <img src={appIcon} width={72} height={72} alt="" />
          <div>
            <h2>Scarlet</h2>
            <dl>
              <div><dt>Version</dt><dd>{__SCARLET_VERSION__}</dd></div>
              {__SCARLET_REVISION__ && (
                <div><dt>Commit</dt><dd><code title={__SCARLET_REVISION__}>{__SCARLET_REVISION__.slice(0, 7)}</code></dd></div>
              )}
            </dl>
          </div>
        </div>
        <UpdateSettings />
      </div>
      <div className="about-content">
        <Changelog />
        <div className="about-sidebar">
          <ReportProblemCard />
          <section className="card about-telemetry" aria-labelledby="telemetry-heading">
            <h2 id="telemetry-heading">Usage telemetry</h2>
            <TelemetrySwitch />
            <p>Scarlet releases send usage reports to PostHog in the US by default. We use them to see how often installations edit, whether editors return or export, and how they review Scarlet’s changes.</p>
            <details className="about-disclosure">
              <summary>What Scarlet sends<Icon name="chevron" size={12} /></summary>
              <div className="about-telemetry-details">
                <ul className="list-disc space-y-1 pl-5">
                  <li>At startup, Scarlet sends the number of projects in your library, excluding the trash.</li>
                  <li>When a tracked feature succeeds, Scarlet sends its name. This includes actions Scarlet takes on your behalf.</li>
                  <li>When a task is queued, Scarlet sends its type, which of Claude Code, Codex or Gemini runs it, and its fast-mode setting. When it finishes, Scarlet sends the type, which of them ran it, outcome (done, failed or cancelled), interruption flag, duration when available, and number of recorded changes. This includes background transcriptions and resumed tasks.</li>
                  <li>When an export finishes, Scarlet sends the render type, outcome and quality setting when available.</li>
                  <li>When you explicitly keep an applied edit, send a revision about it or reject it, Scarlet sends the choice and an installation-specific code for that edit. The code links later choices about the same edit. A revision or a rejection counts when the request is accepted. Opening the card, dismissing it or leaving an edit untouched sends no review decision.</li>
                </ul>
                <p>Every event carries its time, a random event ID to prevent double counting, Scarlet version, operating system, processor architecture and an anonymous ID that links events from the same installation. PostHog sees the connection’s IP address. Scarlet disables location lookups and person profiles.</p>
                <p>Reports exclude account details, footage, audio, transcripts, prompts, notes, edit titles, revision text, project names, file paths, model names, error messages and the IDs Scarlet uses in your library.</p>
                <p>You can also turn reporting off by setting <code>SCARLET_TELEMETRY_ENABLED=false</code> before starting Scarlet.</p>
                <details>
                  <summary className="cursor-pointer">All tracked feature names</summary>
                  <ul className="mt-2 list-disc pl-5">{FEATURE_NAMES.map(name => <li key={name}><code>{name}</code></li>)}</ul>
                </details>
              </div>
            </details>
          </section>
          <ModelCredit />
        </div>
      </div>
    </section>
  );
}

function ReportProblemCard() {
  const canExportLogs = isDesktop() && !IS_MOCK;
  const [busy, setBusy] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function reportWithLogs() {
    setBusy(true);
    setError("");
    try {
      const result = await exportLogsAndReport();
      if (result) setSavedPath(result.path);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function reportDirect() {
    setBusy(true);
    setError("");
    try {
      await openProblemReport();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card about-telemetry" aria-labelledby="report-problem-heading">
      <h2 id="report-problem-heading">Report a problem</h2>
      <p>
        {canExportLogs
          ? "Save a log zip (no videos, projects or sign-ins) and open a GitHub issue you can drop it into."
          : "Open a GitHub issue with your Scarlet version filled in."}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canExportLogs ? (
          <>
            <button className="btn-primary" disabled={busy} onClick={() => void reportWithLogs()}>
              {busy ? "Preparing…" : "Report a problem…"}
            </button>
            <button className="btn-quiet" disabled={busy} onClick={() => void reportDirect()}>
              Open without logs
            </button>
          </>
        ) : (
          <button className="btn-primary" disabled={busy} onClick={() => void reportDirect()}>
            Report a problem
          </button>
        )}
      </div>
      {savedPath && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[12px]" role="status">
          <span className="truncate" title={savedPath}>Saved {fileBaseName(savedPath)}. Drag it into the GitHub issue.</span>
          <button className="btn-quiet" onClick={() => void desktop.revealPath(savedPath).catch(e => setError(errorMessage(e)))}>
            Show in folder
          </button>
        </div>
      )}
      <InlineError><span data-log-private>{error}</span></InlineError>
    </section>
  );
}

function TelemetrySwitch() {
  const [state, setState] = useState<{ enabled: boolean; unavailable?: TelemetryUnavailable }>();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const load = () => {
    setError("");
    return api.settings().then(({ settings, telemetryUnavailable }) => {
      setState({ enabled: settings.telemetryEnabled, unavailable: telemetryUnavailable });
    }).catch(e => setError(errorMessage(e)));
  };
  useEffect(() => { void load(); }, []);
  async function change(enabled: boolean) {
    setSaving(true);
    setError("");
    try {
      const { settings } = await api.updateSettings({ telemetryEnabled: enabled });
      setState({ enabled: settings.telemetryEnabled });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }
  return <>
    {state ? <div className="about-telemetry-toggle">
      <span>Send usage reports</span>
      <Toggle label="Send usage reports" checked={!state.unavailable && state.enabled} disabled={saving || !!state.unavailable} onChange={change} />
    </div> : !error && <Loading label="Loading telemetry setting…" />}
    {state?.unavailable === "environment" && <p>Usage reporting is turned off by the engine environment.</p>}
    {state?.unavailable === "unconfigured" && <p>This build has no telemetry project configured.</p>}
    <InlineError>{error}</InlineError>
    {error && !state && <button className="btn-quiet" onClick={() => void load()}>Retry</button>}
  </>;
}

function ModelCredit() {
  const [error, setError] = useState("");
  const url = "https://desertant.com";
  return <div className="about-credit">
    Filler-word detection uses <a className="underline" href={url} onClick={e => {
      e.preventDefault();
      setError("");
      void desktop.openUrl(url).catch(e => setError(errorMessage(e)));
    }}>Uhm by Desert Ant Labs</a>.
    <InlineError>{error}</InlineError>
  </div>;
}
