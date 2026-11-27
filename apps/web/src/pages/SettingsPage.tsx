import { AboutSettings } from "../components/shell/AboutSettings";
import { CheckInSettings } from "../components/shell/CheckInSettings";
import { TalkingToYouSettings } from "../components/shell/TalkingToYouSettings";
import { WorkspaceLayoutSettings } from "../components/shell/WorkspaceLayoutSettings";
import { LocalModelNotice, TranscriptionGuide, useLocalModelStatus, useNeedsCrisperSetup } from "../components/shell/LocalModelNotice";
import { PreferenceSelect } from "../components/ui/PreferenceSelect";
import { StorageSettings } from "../components/shell/StorageSettings";
import { UsageSettings } from "../components/shell/UsageSettings";
import { WindowActions } from "../components/shell/WorkspaceNavigation";
import { useEffect, useRef, useState } from "react";
import { selectedLocalModel, type LocalTranscriptionModel, type ServerSettings } from "@scarlet/shared";
import { api, errorMessage } from "../lib/client";
import { desktop } from "../lib/desktop";
import { useBeforeUnloadGuard, useEscapeToLeave } from "../lib/uiHooks";
import { Link, Navigate, Outlet, useBlocker, useLocation, useMatch, useNavigate } from "react-router-dom";
import { ListeningSettings } from "../components/shell/ListeningSettings";
import { ModelSettings } from "../components/shell/ModelSettings";
import { ProviderSettings } from "../components/shell/ProviderSettings";
import { ShortcutsSettings } from "../components/shell/ShortcutsSettings";
import { TaskModelsSettings } from "../components/shell/TaskModelsSettings";
import { DesktopAgents, DesktopDiagnostics, ExportLogs } from "../components/shell/DesktopSettings";
import { FfmpegSetupCard } from "../components/shell/FfmpegSetup";
import { YouTubeSettings } from "../components/shell/YouTubeSettings";
import { EditingToolsSettings } from "../components/shell/EditingToolsSettings";
import { useUiStore } from "../stores/ui";
import { ErrorState, Field, Icon, InlineError, Loading, Modal, PageHeading, SectionTitle, Spinner, Toggle } from "../components/ui/primitives";

/**
 * Clear an emptied optional field on the wire: JSON omits undefined, which tells the engine to keep the previous value,
 * whereas null tells it to clear the field. The settings type has no null, so the cast is for the request only.
 */
const clearable = (value: string | undefined) => value || (null as unknown as undefined);

const transcriptionModels: { value: LocalTranscriptionModel | "openai"; label: string }[] = [
  { value: "whispercpp", label: "Whisper large-v3-turbo (default)" },
  { value: "crisperwhisper", label: "CrisperWhisper 2.0" },
  { value: "custom", label: "Custom local model" },
  { value: "openai", label: "OpenAI Whisper (cloud)" },
];

const transcriptionLanguages: { value: string; label: string }[] = [
  { value: "", label: "Auto-detect" },
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" },
  { value: "nl", label: "Dutch" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "zh", label: "Chinese" },
  { value: "hi", label: "Hindi" },
  { value: "ar", label: "Arabic" },
  { value: "ru", label: "Russian" },
  { value: "pl", label: "Polish" },
  { value: "tr", label: "Turkish" },
  { value: "sv", label: "Swedish" },
];

const previewHeights = [360, 480, 540, 720, 1080].map(value => ({
  value,
  label: value === 540 ? "540p (default)" : `${value}p`,
}));

function ServerSettingsForm({ section }: { section: "general" | "advanced" }) {
  const [saveError, setSaveError] = useState("");
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savingImmediate, setSavingImmediate] = useState(false);
  // Custom local model paths wait for Save so the editor can pick both files before transcription restarts.
  const [customDraft, setCustomDraft] = useState<{ whisperModelPath?: string; whisperCppPath?: string }>({});
  const localStatus = useLocalModelStatus(busy ? undefined : settings?.transcription);
  const showCrisperSetup = useNeedsCrisperSetup(localStatus);

  const load = () => {
    // A retry starts clean, so the failure leaves the page once the settings arrive.
    setError(null);
    return api
      .settings()
      .then((r) => setSettings(r.settings))
      .catch((e) => setError(errorMessage(e)));
  };
  useEffect(() => void load(), []);

  const tr = settings?.transcription;
  const localModel = tr ? (tr.localModel ?? localStatus?.selected ?? selectedLocalModel(tr)) : "whispercpp";
  const showCustomModel = section === "advanced" && tr?.provider === "whispercpp" && localModel === "custom";
  const customValue = (field: "whisperModelPath" | "whisperCppPath") => customDraft[field] ?? tr?.[field] ?? "";
  const dirty = showCustomModel && (
    customValue("whisperModelPath") !== (tr?.whisperModelPath ?? "") ||
    customValue("whisperCppPath") !== (tr?.whisperCppPath ?? "")
  );
  // Immediate choices wait for their save before changing tabs. Unsaved custom model paths ask first.
  const blockedByImmediate = useRef(false);
  const leaving = useBlocker(({ currentLocation: from, nextLocation: to }) => {
    if (from.pathname === to.pathname && from.hash === to.hash) return false;
    if (dirty) {
      blockedByImmediate.current = false;
      return true;
    }
    if (savingImmediate) {
      blockedByImmediate.current = true;
      return true;
    }
    return false;
  });
  useEffect(() => {
    if (!blockedByImmediate.current || savingImmediate || leaving.state !== "blocked") return;
    blockedByImmediate.current = false;
    if (saveError) leaving.reset();
    else leaving.proceed();
  }, [savingImmediate, leaving, saveError]);
  // Restart to update asks the page before it restarts, so an unsaved change or pending save holds it.
  useBeforeUnloadGuard(dirty || savingImmediate);

  if (error) return <ErrorState title="Couldn’t load server settings" body={error} onRetry={() => void load()} />;
  if (!settings || !tr) return <Loading label="Loading settings…" />;

  const modelChoice = tr.provider === "whispercpp" ? localModel : tr.provider;
  const rd = settings.render;
  const languageValue = !tr.language || tr.language === "auto" ? "" : tr.language;
  const languageOptions = languageValue && !transcriptionLanguages.some(o => o.value === languageValue)
    ? [...transcriptionLanguages, { value: languageValue, label: languageValue }]
    : transcriptionLanguages;

  const saveCustomPaths = async () => {
    setSaveError("");
    setBusy(true);
    try {
      const r = await api.updateSettings({
        transcription: {
          ...tr,
          localModel: "custom",
          whisperModelPath: clearable(customValue("whisperModelPath").trim() || undefined),
          whisperCppPath: clearable(customValue("whisperCppPath").trim() || undefined),
        },
      });
      setSettings(r.settings);
      setCustomDraft({});
      return true;
    } catch (e2) {
      setSaveError(errorMessage(e2));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const choose = async (optimistic: Partial<ServerSettings>, wire: Partial<ServerSettings> = optimistic) => {
    const previous = settings;
    setSettings({ ...settings, ...optimistic });
    setSaveError("");
    setBusy(true);
    setSavingImmediate(true);
    try {
      const r = await api.updateSettings(wire);
      setSettings(r.settings);
    } catch (e2) {
      setSettings(previous);
      setSaveError(errorMessage(e2));
    } finally {
      setBusy(false);
      setSavingImmediate(false);
    }
  };

  return (
    <>
    <form
      className={section === "general" ? "card transcription-preferences" : "card p-5"}
      data-unsaved={dirty || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !busy) void saveCustomPaths();
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
            {localModel === "crisperwhisper" && showCrisperSetup && <TranscriptionGuide crisper />}
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
      <fieldset disabled={busy} className="min-w-0">
        <div className="divide-y divide-line/60">
          <div className="flex flex-col gap-3 pb-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div className="min-w-0">
              <label className="block text-[13px] font-medium text-fg" htmlFor="tr-lang">Transcription language</label>
              <p className="mt-0.5 text-[12px] text-muted">Auto-detect works for most videos. Pick a language if transcription guesses wrong.</p>
            </div>
            <div className="sm:w-48 shrink-0">
              <PreferenceSelect
                id="tr-lang"
                value={languageValue}
                disabled={busy}
                options={languageOptions}
                onChange={value => void choose(
                  { transcription: { ...tr, language: value || undefined } },
                  { transcription: { ...tr, language: clearable(value || undefined) } },
                )}
              />
            </div>
          </div>

          <div className="flex flex-col gap-3 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div className="min-w-0">
              <label className="block text-[13px] font-medium text-fg" htmlFor="rd-height">Preview quality</label>
              <p className="mt-0.5 text-[12px] text-muted">Resolution while editing. Exports always use full quality.</p>
            </div>
            <div className="sm:w-48 shrink-0">
              <PreferenceSelect
                id="rd-height"
                value={rd.previewHeight}
                disabled={busy}
                options={previewHeights}
                onChange={value => void choose({ render: { ...rd, previewHeight: value } })}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 pt-3.5">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-fg">Hardware acceleration</div>
              <p className="mt-0.5 text-[12px] text-muted">Use graphics hardware for faster previews and exports. Turn off if video looks glitchy.</p>
            </div>
            <Toggle
              checked={rd.hwaccel !== "none"}
              disabled={busy}
              onChange={enabled => void choose({ render: { ...rd, hwaccel: enabled ? "auto" : "none" } })}
              label="Hardware acceleration"
            />
          </div>
        </div>

        {showCustomModel && (
          <div className="mt-4 border-t border-line/60 pt-4">
            <SectionTitle>Custom local model</SectionTitle>
            {([
              ["whisperModelPath", "Model file", "tr-modelpath", "Absolute path to the model file"],
              ["whisperCppPath", "Adapter executable", "tr-bin", "Bundled whisper-cli"],
            ] as const).map(([field, label, id, placeholder]) => (
              <Field key={field} label={label} htmlFor={id} hint={field === "whisperCppPath" ? "Optional for whisper.cpp models." : "Optional when the adapter loads its own model."}>
                <div className="flex gap-2">
                  <input
                    id={id}
                    className="field min-w-0 flex-1 font-mono"
                    value={customValue(field)}
                    placeholder={placeholder}
                    onChange={e => setCustomDraft(current => ({ ...current, [field]: e.target.value }))}
                  />
                  <button type="button" className="btn-quiet" aria-label={`Choose ${label.toLowerCase()}`} onClick={async () => {
                    try {
                      const file = await desktop.pickFile(`Choose ${label.toLowerCase()}`);
                      if (file) setCustomDraft(current => ({ ...current, [field]: file }));
                    } catch (e) { setSaveError(errorMessage(e)); }
                  }}>Browse…</button>
                </div>
              </Field>
            ))}
            <TranscriptionGuide />
            <div className="mt-2 flex justify-end gap-2">
              <button type="submit" className="btn-primary" disabled={!dirty || busy}>
                {busy && <Spinner className="size-3" />} Save
              </button>
            </div>
          </div>
        )}
      </fieldset>
      )}
      {savingImmediate && <p role="status" className="mt-2 text-xs text-muted">Saving…</p>}
      <InlineError>{saveError}</InlineError>
    </form>
    <Modal open={dirty && leaving.state === "blocked"} onClose={() => { if (!busy) leaving.reset?.(); }} title="Save your settings?" footer={<>
      <button className="btn-ghost" disabled={busy} onClick={() => leaving.reset?.()}>Stay</button>
      <button className="btn-ghost" disabled={busy} onClick={() => leaving.proceed?.()}>Discard changes</button>
      <button className="btn-primary" disabled={busy} onClick={() => void saveCustomPaths().then(saved => { if (saved) leaving.proceed?.(); })}>
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
  { id: "style-guides", label: "Style guides", to: "/settings/style-guides" },
  { id: "shortcuts", label: "Shortcuts", to: "/settings#shortcuts" },
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
  const styleGuides = useMatch("/settings/style-guides");
  // Esc leaves Settings like the back link, unless a menu, dialog or text field is using it.
  // Leaving would drop a form's unsaved changes, so until they're saved Esc moves focus to its Save instead.
  useEscapeToLeave(() => {
    const unsaved = document.querySelector("form[data-unsaved]");
    if (unsaved) unsaved.querySelector<HTMLElement>('button[type="submit"]')?.focus();
    else navigate(returnTo ?? "/", { replace: !!returnTo });
  });
  if (movedTabs[hash]) return <Navigate replace to={movedTabs[hash]} />;
  const tab = skills ? "tools" : styleGuides ? "style-guides" : tabs.find(t => t.to === `/settings${hash}`)?.id ?? "general";
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
              <Link key={t.id} to={t.to} aria-current={tab === t.id} className={`rounded-md px-2.5 py-1.5 text-[13px] whitespace-nowrap ${tab === t.id ? "bg-raised text-fg" : "text-muted hover:text-fg"}`}>
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
            <FfmpegSetupCard />
            <YouTubeSettings />
            <ServerSettingsForm section="general" />
            <CheckInSettings />
            <TalkingToYouSettings />
            <WorkspaceLayoutSettings />
          </>
        )}
        {tab === "models" && (
          <>
            <ModelSettings />
            <ListeningSettings />
            <TaskModelsSettings />
            <ProviderSettings />
          </>
        )}
        {tab === "tools" && (
          <>
            <Outlet />
            <EditingToolsSettings />
          </>
        )}
        {tab === "style-guides" && <Outlet />}
        {tab === "shortcuts" && <ShortcutsSettings />}
        {tab === "usage" && (
          <div className="usage-page">
            <UsageSettings />
            <StorageSettings />
          </div>
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
