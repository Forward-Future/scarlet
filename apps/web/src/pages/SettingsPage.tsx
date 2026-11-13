import { LocalModelNotice, TranscriptionGuide, useLocalModelStatus } from "../components/shell/LocalModelNotice";
import { PreferenceSelect } from "../components/ui/PreferenceSelect";
import { StorageSettings } from "../components/shell/StorageSettings";
import { UsageSettings } from "../components/shell/UsageSettings";
import { UpdateSettings } from "../components/shell/UpdateSettings";
import { WindowActions } from "../components/shell/WorkspaceNavigation";
import { useEffect, useState } from "react";
import { FEATURE_NAMES, selectedLocalModel, type LocalTranscriptionModel, type ServerSettings, type TelemetryUnavailable } from "@scarlet/shared";
import { api, errorMessage } from "../lib/client";
import { desktop } from "../lib/desktop";
import { Link, Navigate, Outlet, useBlocker, useLocation, useMatch, useNavigate } from "react-router-dom";
import { ModelSettings } from "../components/shell/ModelSettings";
import { DesktopAgents, DesktopDiagnostics, ExportLogs } from "../components/shell/DesktopSettings";
import { EditingToolsSettings } from "../components/shell/EditingToolsSettings";
import { DialogueSettings } from "../components/shell/DialogueSettings";
import { useUiStore } from "../stores/ui";
import { ErrorState, Field, InlineError, Loading, Modal, PageHeading, SectionTitle, Spinner, Toggle } from "../components/ui/primitives";

/**
 * A group of settings as it goes to the engine. A field the editor emptied is undefined here, which JSON leaves out,
 * and the engine then keeps the value it had: null tells it to clear the field. The settings type has no null, so
 * the cast is for the request only.
 */
const withCleared = <T extends object>(fields: T) => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value ?? null])) as T;

/** The settings as their fields show them: a field that was emptied and one never set are both blank. */
const shown = (settings: ServerSettings) => JSON.stringify(settings, (_key, value) => (value === "" || value === null ? undefined : value));

/** What was typed in a number field, as a number. Left blank, or not a number, the setting keeps the value it had. */
function typedNumber(text: string | undefined, was: number) {
  const value = Number(text);
  return text?.trim() && Number.isFinite(value) ? value : was;
}

const transcriptionModels: { value: LocalTranscriptionModel | "openai"; label: string }[] = [
  { value: "crisperwhisper", label: "CrisperWhisper 2.0 (default)" },
  { value: "whispercpp", label: "Whisper large-v3-turbo (bundled)" },
  { value: "custom", label: "Custom local model" },
  { value: "openai", label: "OpenAI Whisper (cloud)" },
];

function ServerSettingsForm({ section }: { section: "general" | "advanced" }) {
  const [saveError, setSaveError] = useState("");
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  // What the engine last gave. A field that differs from it is unsaved, and one put back to it isn't.
  const [saved, setSaved] = useState<ServerSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const localStatus = useLocalModelStatus(busy ? undefined : saved?.transcription);
  // Number fields hold what is typed until Save. Read as a number on every keystroke, an emptied field refilled at
  // once: clearing Concurrency put 1 back, so typing 4 after it made 14.
  const [typed, setTyped] = useState<{ handleSeconds?: string; concurrency?: string }>({});

  const show = (from: ServerSettings) => {
    setSettings(from);
    setSaved(from);
  };
  const load = () => {
    // A retry starts clean, so the failure leaves the page once the settings arrive.
    setError(null);
    return api
      .settings()
      .then((r) => show(r.settings))
      .catch((e) => setError(errorMessage(e)));
  };
  useEffect(() => void load(), []);
  // General's dropdown saves as it is chosen, like the dialogue ones under it. Advanced has fields to type in and
  // the Save for them, and is unsaved while what those fields show differs from what was loaded.
  const retyped = (field: keyof typeof typed) => typed[field] !== undefined && typed[field] !== String(saved?.render[field]);
  const dirty = section === "advanced" && !!settings && !!saved
    && (shown(settings) !== shown(saved) || retyped("handleSeconds") || retyped("concurrency"));
  // Another tab or the back link would drop a change that hasn't been saved, so leaving asks first, as a skill does.
  const leaving = useBlocker(({ currentLocation: from, nextLocation: to }) => dirty && (from.pathname !== to.pathname || from.hash !== to.hash));
  // Restart to update asks the page before it restarts, so an unsaved change holds it until it's saved or discarded.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (error) return <ErrorState title="Couldn’t load server settings" body={error} onRetry={() => void load()} />;
  if (!settings) return <Loading label="Loading settings…" />;

  const set = <K extends keyof ServerSettings>(k: K, v: ServerSettings[K]) => setSettings({ ...settings, [k]: v });
  const holdTyped = (field: keyof typeof typed, text: string) => setTyped({ ...typed, [field]: text });
  const tr = settings.transcription;
  const localModel = tr.localModel ?? localStatus?.selected ?? selectedLocalModel(saved?.transcription ?? tr);
  const modelChoice = tr.provider === "whispercpp" ? localModel : tr.provider;
  const nc = settings.noteCleanup;
  const rd = settings.render;
  const advancedPatch = () => ({
    transcription: withCleared(tr),
    render: { ...rd, handleSeconds: typedNumber(typed.handleSeconds, rd.handleSeconds), concurrency: Math.max(1, typedNumber(typed.concurrency, rd.concurrency)) },
    noteCleanup: withCleared(nc),
  });

  const save = async () => {
    setSaveError("");
    setBusy(true);
    try {
      const r = await api.updateSettings(advancedPatch());
      show(r.settings);
      setTyped({});
      return true;
    } catch (e2) {
      setSaveError(errorMessage(e2));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const choose = async (choice: Pick<ServerSettings, "transcription">) => {
    const previous = settings;
    setSettings({ ...settings, ...choice });
    setSaveError("");
    setBusy(true);
    try {
      const r = await api.updateSettings(choice);
      show(r.settings);
    } catch (e2) {
      setSettings(previous);
      setSaveError(errorMessage(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
    <form
      className="card p-5"
      data-unsaved={dirty || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className={section === "general" ? "max-w-md" : "grid sm:grid-cols-2 gap-x-8 gap-y-4"}>
        <div>
          {section === "general" && (
          <>
          <SectionTitle>Preferences</SectionTitle>
          <Field label="Transcribe speech with" htmlFor="tr-provider" hint={tr.provider === "whispercpp"
            ? undefined
            : "Used for dialogue edits, captions and voice notes."}>
            <PreferenceSelect id="tr-provider" value={modelChoice} valueLabel={tr.provider === "none" ? "Transcription unavailable" : undefined} disabled={busy} options={transcriptionModels}
              onChange={value => void choose({ transcription: value === "openai" || value === "none"
                ? { ...tr, provider: value } : { ...tr, provider: "whispercpp", localModel: value } })} />
            {tr.provider === "whispercpp" && <>
              <LocalModelNotice model={localModel} status={localStatus} />
              {localModel === "custom" && <Link className="text-xs underline" to="/settings#advanced">Configure model file and adapter</Link>}
              {localModel === "crisperwhisper" && <TranscriptionGuide crisper />}
            </>}
          </Field>
          </>
          )}
          {section === "advanced" && (
          <>
          <SectionTitle>Transcription</SectionTitle>
          {tr.provider === "openai" && (
            <Field label="OpenAI model" htmlFor="tr-model">
              <input id="tr-model" className="field font-mono" value={tr.openaiModel} onChange={(e) => set("transcription", { ...tr, openaiModel: e.target.value })} />
            </Field>
          )}
          {tr.provider === "whispercpp" && localModel === "custom" && <>
            {([
              ["whisperModelPath", "Model file", "tr-modelpath", "Absolute path to the model file"],
              ["whisperCppPath", "Adapter executable", "tr-bin", "Bundled whisper-cli"],
            ] as const).map(([field, label, id, placeholder]) => (
              <Field key={field} label={label} htmlFor={id} hint={field === "whisperCppPath" ? "Optional for whisper.cpp models." : "Optional when the adapter loads its own model."}>
                <div className="flex gap-2">
                  <input id={id} className="field min-w-0 flex-1 font-mono" value={tr[field] ?? ""} placeholder={placeholder}
                    onChange={e => set("transcription", { ...tr, localModel: "custom", [field]: e.target.value || undefined })} />
                  <button type="button" className="btn-quiet" aria-label={`Choose ${label.toLowerCase()}`} onClick={async () => {
                    try {
                      const file = await desktop.pickFile(`Choose ${label.toLowerCase()}`);
                      if (file) setSettings(current => current && ({ ...current, transcription: { ...current.transcription, localModel: "custom", [field]: file } }));
                    } catch (e) { setSaveError(errorMessage(e)); }
                  }}>Browse…</button>
                </div>
              </Field>
            ))}
            <TranscriptionGuide />
          </>}
          <Field label="Language" htmlFor="tr-lang" hint="ISO code; empty = auto-detect">
            <input id="tr-lang" className="field w-24" value={tr.language ?? ""} onChange={(e) => set("transcription", { ...tr, language: e.target.value || undefined })} placeholder="en" />
          </Field>

          <SectionTitle>Note cleanup</SectionTitle>
          <div className="flex items-center justify-between mb-3">
            <span className="text-[12.5px]">Turn rambling voice notes into precise instructions</span>
            <Toggle checked={nc.enabled} onChange={(v) => set("noteCleanup", { ...nc, enabled: v })} label="Enable note cleanup" />
          </div>
          {nc.enabled && (
            <div className="grid grid-cols-2 gap-3 mb-2">
              <Field label="Provider" htmlFor="nc-provider">
                <PreferenceSelect id="nc-provider" value={nc.provider}
                  options={[{ value: "anthropic", label: "Anthropic" }, { value: "openai", label: "OpenAI" }, { value: "none", label: "None" }] as const}
                  onChange={value => set("noteCleanup", { ...nc, provider: value })} />
              </Field>
              <Field label="Model" htmlFor="nc-model">
                <input id="nc-model" className="field font-mono" value={nc.model ?? ""} onChange={(e) => set("noteCleanup", { ...nc, model: e.target.value || undefined })} placeholder="claude-haiku-4-5" />
              </Field>
            </div>
          )}
          </>
          )}
        </div>
        <div>
          {section === "advanced" && (
          <>
          <SectionTitle>Render</SectionTitle>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Handle seconds" htmlFor="rd-handle" hint="Context on each side of an edit’s preview">
              <input id="rd-handle" type="number" step="0.5" min="0" className="field" value={typed.handleSeconds ?? rd.handleSeconds} onChange={(e) => holdTyped("handleSeconds", e.target.value)} />
            </Field>
            <Field label="Preview height" htmlFor="rd-height">
              <PreferenceSelect id="rd-height" value={rd.previewHeight}
                options={[360, 480, 540, 720, 1080].map(value => ({ value, label: value + "p" }))}
                onChange={value => set("render", { ...rd, previewHeight: value })} />
            </Field>
            <Field label="Concurrency" htmlFor="rd-conc">
              <input id="rd-conc" type="number" min="1" max="16" className="field" value={typed.concurrency ?? rd.concurrency} onChange={(e) => holdTyped("concurrency", e.target.value)} />
            </Field>
            <Field label="Hardware acceleration" htmlFor="rd-hw">
              <PreferenceSelect id="rd-hw" value={rd.hwaccel}
                options={(["auto", "none", "nvenc", "qsv", "videotoolbox"] as const).map(value => ({ value, label: value }))}
                onChange={value => set("render", { ...rd, hwaccel: value })} />
            </Field>
          </div>
          </>
          )}
        </div>
      </div>
      {section === "advanced" && <div className="flex justify-end gap-2 mt-2">
        <button type="submit" className="btn-primary" disabled={!dirty || busy}>
          {busy && <Spinner className="size-3" />} Save
        </button>
      </div>}
      <InlineError>{saveError}</InlineError>
    </form>
    <Modal open={leaving.state === "blocked"} onClose={() => { if (!busy) leaving.reset?.(); }} title="Save your settings?" footer={<>
      <button className="btn-ghost" disabled={busy} onClick={() => leaving.reset?.()}>Stay</button>
      <button className="btn-ghost" disabled={busy} onClick={() => leaving.proceed?.()}>Discard changes</button>
      <button className="btn-primary" disabled={busy} onClick={() => void save().then(saved => { if (saved) leaving.proceed?.(); })}>
        {busy && <Spinner className="size-3" />} Save and leave</button>
    </>}>
      <p>These settings have unsaved changes.</p>
      <InlineError>{saveError}</InlineError>
    </Modal>
    </>
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
    {state ? <div className="flex items-center gap-2 text-fg">
      <Toggle label="Send usage reports" checked={!state.unavailable && state.enabled} disabled={saving || !!state.unavailable} onChange={change} />
      <span>Send usage reports</span>
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
  return <div className="mt-6 text-sm text-muted">
    Filler-word detection uses <a className="underline" href={url} onClick={e => {
      e.preventDefault();
      setError("");
      void desktop.openUrl(url).catch(e => setError(errorMessage(e)));
    }}>Uhm by Desert Ant Labs</a>.
    <InlineError>{error}</InlineError>
  </div>;
}

const tabs = [
  { id: "general", label: "General", to: "/settings" },
  { id: "models", label: "Models", to: "/settings#models" },
  { id: "tools", label: "Tools & skills", to: "/settings/skills" },
  { id: "usage", label: "Usage", to: "/settings#usage" },
  { id: "advanced", label: "Advanced", to: "/settings#advanced" },
  { id: "about", label: "About", to: "/settings#about" },
];
// Old links to tabs that were folded into another one.
const movedTabs: Record<string, string> = { "#tools": "/settings/skills", "#storage": "/settings#usage", "#actions": "/settings/skills" };

export function SettingsPage() {
  const returnTo = useUiStore(s => s.settingsReturnTo);
  const setShortcutsOpen = useUiStore(s => s.setShortcutsOpen);
  const { hash } = useLocation();
  const navigate = useNavigate();
  const skills = useMatch("/settings/skills");
  useEffect(() => {
    // Esc leaves Settings like the back link, unless a menu, dialog or text field is using it.
    // Leaving would drop a form's unsaved changes, so until they're saved Esc moves focus to its Save instead.
    const leave = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (useUiStore.getState().shortcutsOpen || document.querySelector('dialog[open], [role="menu"]')) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")) {
        target.blur();
        return;
      }
      e.preventDefault();
      const unsaved = document.querySelector("form[data-unsaved]");
      if (unsaved) unsaved.querySelector<HTMLElement>('button[type="submit"]')?.focus();
      else navigate(returnTo ?? "/", { replace: !!returnTo });
    };
    window.addEventListener("keydown", leave);
    return () => window.removeEventListener("keydown", leave);
  }, [navigate, returnTo]);
  if (movedTabs[hash]) return <Navigate replace to={movedTabs[hash]} />;
  const tab = skills ? "tools" : tabs.find(t => t.to === `/settings${hash}`)?.id ?? "general";
  const backLabel = returnTo ? "Back to project" : "Projects";
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="page-wrap settings-page space-y-5">
        <PageHeading title="Settings">
          <Link className="btn-quiet" to={returnTo ?? "/"} replace={!!returnTo} aria-label={backLabel} aria-keyshortcuts="Escape" title={`${backLabel} (Esc)`}>
            ← {backLabel}
          </Link>
          <nav className="control-tabs" aria-label="Settings sections">
            {tabs.map((t) => (
              <Link key={t.id} to={t.to} aria-current={tab === t.id} className={`rounded-md px-3 py-1.5 text-[13px] ${tab === t.id ? "bg-raised text-fg" : "text-muted hover:text-fg"}`}>
                {t.label}
              </Link>
            ))}
          </nav>
          <button className="btn-quiet" title="Shortcut: ?" onClick={() => setShortcutsOpen(true)}>Keyboard shortcuts</button>
          <WindowActions inSettings />
        </PageHeading>
        {tab === "general" && (
          <>
            <DesktopAgents />
            <ServerSettingsForm section="general" />
            <section className="card p-5" aria-label="Dialogue edits"><DialogueSettings /></section>
          </>
        )}
        {tab === "models" && <ModelSettings />}
        {tab === "tools" && (
          <>
            <section className="card p-5" aria-label="Editing tools"><EditingToolsSettings /></section>
            <Outlet />
          </>
        )}
        {tab === "usage" && (
          <>
            <StorageSettings />
            <UsageSettings />
          </>
        )}
        {tab === "about" && (
          <section className="card p-5" aria-label="About Scarlet">
            <dl className="grid w-fit grid-cols-[auto_auto] gap-x-6 gap-y-2">
              <dt className="text-muted">Version</dt><dd>{__SCARLET_VERSION__}</dd>
              {__SCARLET_REVISION__ && <><dt className="text-muted">Commit</dt><dd className="font-mono">{__SCARLET_REVISION__.slice(0, 7)}</dd></>}
            </dl>
            <UpdateSettings />
            <section className="mt-6 max-w-prose space-y-2 text-sm leading-relaxed text-muted" aria-labelledby="telemetry-heading">
              <h2 id="telemetry-heading" className="font-semibold text-fg">Usage telemetry</h2>
              <TelemetrySwitch />
              <p>Scarlet releases send usage reports to PostHog in the US by default. We use them to see how often installations edit, whether editors return or export, and how they review Scarlet’s changes.</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>At startup, Scarlet sends the number of projects in your library, excluding the trash.</li>
                <li>When a tracked feature succeeds, Scarlet sends its name. This includes actions an agent takes on your behalf.</li>
                <li>When a task is queued, Scarlet sends its type, selected agent and fast-mode setting. When it finishes, Scarlet sends the type, agent, outcome (done, failed or cancelled), interruption flag, duration when available, and number of recorded changes. This includes background transcriptions and resumed tasks.</li>
                <li>When an export finishes, Scarlet sends the render type, outcome and quality setting when available.</li>
                <li>When you explicitly keep an applied edit, send a revision about it, or request Undo edit, Scarlet sends the choice and an installation-specific code for that edit. The code links later choices about the same edit. Revise and Undo count when the request is accepted. Opening the card, dismissing it or leaving an edit untouched sends no review decision.</li>
              </ul>
              <p>Every event carries its time, a random event ID to prevent double counting, Scarlet version, operating system, processor architecture and an anonymous ID that links events from the same installation. PostHog sees the connection’s IP address. Scarlet disables location lookups and person profiles.</p>
              <p>Reports exclude account details, footage, audio, transcripts, prompts, notes, edit titles, revision text, project names, file paths, model names, error messages and the IDs Scarlet uses in your library.</p>
              <p>You can also turn reporting off by setting <code>SCARLET_TELEMETRY_ENABLED=false</code> before starting Scarlet.</p>
              <details>
                <summary className="cursor-pointer">All tracked feature names</summary>
                <ul className="mt-2 list-disc pl-5">{FEATURE_NAMES.map(name => <li key={name}><code>{name}</code></li>)}</ul>
              </details>
            </section>
            <ModelCredit />
          </section>
        )}
        {tab === "advanced" && (
          <>
            <ExportLogs />
            <ServerSettingsForm section="advanced" />
            <DesktopDiagnostics />
          </>
        )}
      </div>
    </div>
  );
}
