import { AboutSettings } from "../components/shell/AboutSettings";
import { CheckInSettings } from "../components/shell/CheckInSettings";
import { LocalModelNotice, TranscriptionGuide, useLocalModelStatus } from "../components/shell/LocalModelNotice";
import { PreferenceSelect } from "../components/ui/PreferenceSelect";
import { StorageSettings } from "../components/shell/StorageSettings";
import { UsageSettings } from "../components/shell/UsageSettings";
import { WindowActions } from "../components/shell/WorkspaceNavigation";
import { useEffect, useState } from "react";
import { selectedLocalModel, type LocalTranscriptionModel, type ServerSettings } from "@scarlet/shared";
import { api, errorMessage } from "../lib/client";
import { desktop } from "../lib/desktop";
import { useBeforeUnloadGuard, useEscapeToLeave } from "../lib/uiHooks";
import { Link, Navigate, Outlet, useBlocker, useLocation, useMatch, useNavigate } from "react-router-dom";
import { ModelSettings } from "../components/shell/ModelSettings";
import { DesktopAgents, DesktopDiagnostics, ExportLogs } from "../components/shell/DesktopSettings";
import { EditingToolsSettings } from "../components/shell/EditingToolsSettings";
import { useUiStore } from "../stores/ui";
import { ErrorState, Field, Icon, InlineError, Loading, Modal, PageHeading, SectionTitle, Spinner, Toggle } from "../components/ui/primitives";

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
  // General saves each choice immediately. Advanced keeps typed values until Save.
  const retyped = (field: keyof typeof typed) => typed[field] !== undefined && typed[field] !== String(saved?.render[field]);
  const dirty = section === "advanced" && !!settings && !!saved
    && (shown(settings) !== shown(saved) || retyped("handleSeconds") || retyped("concurrency"));
  const savingChoice = section === "general" && busy;
  // Advanced asks before leaving with changes. General waits for its pending choice to save so the next tab reads it.
  const leaving = useBlocker(({ currentLocation: from, nextLocation: to }) =>
    (dirty || savingChoice) && (from.pathname !== to.pathname || from.hash !== to.hash));
  useEffect(() => {
    if (section !== "general" || busy || leaving.state !== "blocked") return;
    if (saveError) leaving.reset();
    else leaving.proceed();
  }, [section, leaving, busy, saveError]);
  // Restart to update asks the page before it restarts, so an unsaved change holds it until it's saved or discarded.
  useBeforeUnloadGuard(dirty || savingChoice);

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
      className={section === "general" ? "card transcription-preferences" : "card p-5"}
      data-unsaved={dirty || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !busy) void save();
      }}
    >
      {section === "general" ? (
        <fieldset disabled={busy} className="min-w-0" aria-labelledby="transcription-heading">
          <div className="transcription-header">
            <div className="transcription-heading">
              <span className="transcription-glyph"><Icon name="audio" size={22} /></span>
              <div>
                <h2 id="transcription-heading">Speech transcription</h2>
                <p>For dialogue edits, captions and voice notes.</p>
              </div>
            </div>
            <div className="min-w-0">
              <label className="label" htmlFor="tr-provider">Preferred model</label>
              <PreferenceSelect id="tr-provider" value={modelChoice} valueLabel={tr.provider === "none" ? "Transcription unavailable" : undefined} disabled={busy} options={transcriptionModels}
                onChange={value => void choose({ transcription: value === "openai" || value === "none"
                  ? { ...tr, provider: value } : { ...tr, provider: "whispercpp", localModel: value } })} />
            </div>
          </div>
          {tr.provider === "whispercpp" ? <>
            <LocalModelNotice model={localModel} status={localStatus} />
            {localModel === "crisperwhisper" && <TranscriptionGuide crisper />}
            {localModel === "custom" && (
              <Link className="transcription-setup-row" to="/settings#advanced">
                Configure model file and adapter <Icon name="chevron" size={14} />
              </Link>
            )}
          </> : (
            <p className="transcription-status text-muted">
              {tr.provider === "openai" ? <><Icon name="link" /> Audio is sent to OpenAI for transcription.</> : "Choose a model to turn transcription on."}
            </p>
          )}
        </fieldset>
      ) : (
      <fieldset disabled={busy} className="min-w-0 grid sm:grid-cols-2 gap-x-8 gap-y-4">
        <div>
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
                  options={[{ value: "anthropic", label: "Anthropic" }, { value: "openai", label: "OpenAI" }, { value: "gemini", label: "Gemini" }, { value: "none", label: "None" }] as const}
                  onChange={value => set("noteCleanup", { ...nc, provider: value })} />
              </Field>
              <Field label="Model" htmlFor="nc-model">
                <input id="nc-model" className="field font-mono" value={nc.model ?? ""} onChange={(e) => set("noteCleanup", { ...nc, model: e.target.value || undefined })} placeholder={nc.provider === "gemini" ? "gemini-2.5-flash" : nc.provider === "openai" ? "gpt-4o-mini" : "claude-haiku-4-5"} />
              </Field>
            </div>
          )}
        </div>
        <div>
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
            <Field label="Hardware acceleration" htmlFor="rd-hw" hint="Auto uses hardware encoding when available. None encodes in software.">
              <PreferenceSelect id="rd-hw" value={rd.hwaccel}
                options={(["auto", "none", "nvenc", "qsv", "videotoolbox"] as const).map(value => ({ value, label: value }))}
                onChange={value => set("render", { ...rd, hwaccel: value })} />
            </Field>
          </div>
        </div>
      </fieldset>
      )}
      {section === "advanced" && <div className="flex justify-end gap-2 mt-2">
        <button type="submit" className="btn-primary" disabled={!dirty || busy}>
          {busy && <Spinner className="size-3" />} Save
        </button>
      </div>}
      {savingChoice && <p role="status" className="mt-2 text-xs text-muted">Saving…</p>}
      <InlineError>{saveError}</InlineError>
    </form>
    <Modal open={section === "advanced" && leaving.state === "blocked"} onClose={() => { if (!busy) leaving.reset?.(); }} title="Save your settings?" footer={<>
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
  // Esc leaves Settings like the back link, unless a menu, dialog or text field is using it.
  // Leaving would drop a form's unsaved changes, so until they're saved Esc moves focus to its Save instead.
  useEscapeToLeave(() => {
    const unsaved = document.querySelector("form[data-unsaved]");
    if (unsaved) unsaved.querySelector<HTMLElement>('button[type="submit"]')?.focus();
    else navigate(returnTo ?? "/", { replace: !!returnTo });
  });
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
            <CheckInSettings />
          </>
        )}
        {tab === "models" && <ModelSettings />}
        {tab === "tools" && (
          <>
            <Outlet />
            <EditingToolsSettings />
          </>
        )}
        {tab === "usage" && (
          <>
            <StorageSettings />
            <UsageSettings />
          </>
        )}
        {tab === "about" && <AboutSettings />}
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
