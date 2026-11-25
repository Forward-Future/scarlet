import { useEffect, useState } from "react";
import { isComposing } from "../../lib/hotkeys";
import {
  ACTION_BY_ID,
  bindingTokens,
  eventToBinding,
  FIXED_SHORTCUTS,
  formatBinding,
  isMacPlatform,
  SHORTCUT_ACTIONS,
  SHORTCUT_GROUPS,
  SHORTCUT_PRESETS,
  useShortcutsStore,
  validateBinding,
  type ShortcutActionId,
  type ShortcutGroup,
  type ShortcutPresetId,
} from "../../stores/shortcuts";
import { PreferenceSelect } from "../ui/PreferenceSelect";
import { Kbd } from "../ui/primitives";

type CategoryFilter = "all" | ShortcutGroup | "fixed";

interface RowNotice {
  actionId: ShortcutActionId;
  kind: "conflict" | "error" | "warning";
  binding?: string;
  conflictId?: ShortcutActionId;
  message: string;
}

const PRESET_OPTIONS: { value: ShortcutPresetId; label: string; detail: string }[] = [
  { value: "default", label: SHORTCUT_PRESETS.default.label, detail: SHORTCUT_PRESETS.default.detail },
  { value: "jkl", label: SHORTCUT_PRESETS.jkl.label, detail: SHORTCUT_PRESETS.jkl.detail },
];

const CATEGORIES: { id: CategoryFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "playback", label: "Playback" },
  { id: "chat", label: "While typing" },
  { id: "review", label: "Review" },
  { id: "project", label: "Timeline" },
  { id: "fixed", label: "Fixed" },
];

function KeyboardIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="1.5" y="3.5" width="13" height="9" rx="1.8" />
      <path d="M4 6.5h1.2M7.4 6.5h1.2M10.8 6.5H12M4.8 9.5h6.4" />
    </svg>
  );
}

export function ShortcutsSettings() {
  const preset = useShortcutsStore(s => s.preset);
  const overrides = useShortcutsStore(s => s.overrides);
  const bindings = useShortcutsStore(s => s.bindings);
  const setPreset = useShortcutsStore(s => s.setPreset);
  const setBinding = useShortcutsStore(s => s.setBinding);
  const swapBindings = useShortcutsStore(s => s.swapBindings);
  const replaceBinding = useShortcutsStore(s => s.replaceBinding);
  const resetOne = useShortcutsStore(s => s.resetOne);
  const resetAll = useShortcutsStore(s => s.resetAll);

  const [category, setCategory] = useState<CategoryFilter>("all");
  const [query, setQuery] = useState("");
  const [recordingId, setRecordingId] = useState<ShortcutActionId | null>(null);
  const [notice, setNotice] = useState<RowNotice | null>(null);

  const mac = isMacPlatform();
  const customized = Object.keys(overrides).length > 0;
  const presetInfo = SHORTCUT_PRESETS[preset];

  useEffect(() => {
    if (!recordingId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isComposing(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecordingId(null);
        setNotice(null);
        return;
      }
      const combo = eventToBinding(e);
      if (!combo) return;

      const currentBindings = useShortcutsStore.getState().bindings;
      if (currentBindings[recordingId] === combo) {
        setRecordingId(null);
        setNotice(null);
        return;
      }

      const check = validateBinding(currentBindings, recordingId, combo, mac);
      if (!check.ok && check.conflictId) {
        setRecordingId(null);
        setNotice({
          actionId: recordingId,
          kind: "conflict",
          binding: combo,
          conflictId: check.conflictId,
          message: check.error!,
        });
        return;
      }
      if (!check.ok) {
        setNotice({
          actionId: recordingId,
          kind: "error",
          binding: combo,
          message: check.error!,
        });
        return;
      }

      setBinding(recordingId, combo);
      setRecordingId(null);
      setNotice(check.warning ? { actionId: recordingId, kind: "warning", binding: combo, message: check.warning } : null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recordingId, mac, setBinding]);

  const search = query.trim().toLowerCase();
  const visibleGroups = SHORTCUT_GROUPS.filter(g => category === "all" || category === g.id);
  const showFixed = category === "all" || category === "fixed";

  const filteredFixed = showFixed
    ? FIXED_SHORTCUTS.filter(item => {
        if (!search) return true;
        const keyText = item.keys.map(k => (k === "Mod" ? (mac ? "⌘" : "Ctrl") : k)).join(" ").toLowerCase();
        return item.what.toLowerCase().includes(search) || item.where.toLowerCase().includes(search) || keyText.includes(search);
      })
    : [];

  const groupRows = visibleGroups.map(group => ({
    group,
    actions: SHORTCUT_ACTIONS.filter(action => {
      if (action.group !== group.id) return false;
      if (!search) return true;
      const keyStr = formatBinding(bindings[action.id], mac).toLowerCase();
      return (
        action.what.toLowerCase().includes(search)
        || (action.detail?.toLowerCase().includes(search) ?? false)
        || action.where.toLowerCase().includes(search)
        || keyStr.includes(search)
      );
    }),
  })).filter(g => g.actions.length > 0);

  const nothingMatches = groupRows.length === 0 && filteredFixed.length === 0;

  return (
    <div className="space-y-5" data-escape-owner={recordingId ? "" : undefined}>
      <section className="card transcription-preferences shortcuts-preset-card" aria-labelledby="shortcuts-preset-heading">
        <div className="transcription-header">
          <div className="transcription-heading">
            <span className="transcription-glyph"><KeyboardIcon /></span>
            <div>
              <h2 id="shortcuts-preset-heading">Keyboard shortcuts</h2>
              <p>Pick a preset or click any shortcut below to assign your own keys.</p>
            </div>
          </div>
          <div className="min-w-0">
            <label className="label" htmlFor="shortcut-preset">Preset</label>
            <PreferenceSelect
              id="shortcut-preset"
              value={preset}
              valueLabel={customized ? `${presetInfo.label} (Custom)` : undefined}
              options={PRESET_OPTIONS}
              onChange={next => {
                setPreset(next);
                setRecordingId(null);
                setNotice(null);
              }}
            />
          </div>
        </div>
        <p className="transcription-status text-muted">{presetInfo.summary}</p>
      </section>

      <section className="card shortcuts-editor-card" aria-label="Shortcut bindings">
        <div className="shortcuts-toolbar">
          <div className="shortcuts-categories" role="group" aria-label="Shortcut categories">
            {CATEGORIES.map(cat => (
              <button
                key={cat.id}
                type="button"
                className="shortcuts-cat-pill"
                aria-pressed={category === cat.id}
                onClick={() => setCategory(cat.id)}
              >
                {cat.label}
              </button>
            ))}
          </div>
          <div className="shortcuts-toolbar-right">
            <input
              type="search"
              className="field shortcuts-search"
              aria-label="Filter shortcuts"
              placeholder="Filter shortcuts…"
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
            <button
              type="button"
              className="btn-ghost"
              disabled={!customized}
              onClick={() => {
                resetAll();
                setRecordingId(null);
                setNotice(null);
              }}
            >
              Reset all
            </button>
          </div>
        </div>

        <div className="shortcuts-body">
          {groupRows.map(({ group, actions }) => (
            <div key={group.id} className="shortcuts-group">
              <div className="shortcuts-group-head">
                <span className="eyebrow">{group.label}</span>
                {group.detail && <span className="shortcuts-group-detail">{group.detail}</span>}
              </div>
              {actions.map(action => {
                const binding = bindings[action.id];
                const isRecording = recordingId === action.id;
                const isModified = action.id in overrides;
                const movedByPreset = !isModified && preset === "jkl" && SHORTCUT_PRESETS.jkl.bindings[action.id] !== SHORTCUT_PRESETS.default.bindings[action.id];
                const rowNotice = notice?.actionId === action.id ? notice : null;
                const tokens = bindingTokens(binding, mac);

                return (
                  <div key={action.id} className="shortcuts-row" data-shortcut-id={action.id}>
                    <div className="shortcuts-row-main">
                      <div className="shortcuts-row-label">
                        {isModified && <span className="shortcuts-mod-dot" title="Customized" aria-hidden />}
                        <span>{action.what}</span>
                        {action.detail && <span className="shortcuts-row-detail">· {action.detail}</span>}
                        {movedByPreset && <span className="shortcuts-preset-tag">J/K/L</span>}
                      </div>
                      <span className="shortcuts-row-where">{action.where}</span>
                      <div className="shortcuts-row-keys">
                        {isModified && !isRecording && (
                          <button
                            type="button"
                            className="shortcuts-row-reset"
                            aria-label={`Reset ${action.what}`}
                            title="Reset to preset default"
                            onClick={() => {
                              resetOne(action.id);
                              if (notice?.actionId === action.id) setNotice(null);
                            }}
                          >
                            ↺
                          </button>
                        )}
                        {isRecording && binding !== null && (
                          <button
                            type="button"
                            className="btn-quiet shortcuts-inline-btn"
                            onClick={() => {
                              setBinding(action.id, null);
                              setRecordingId(null);
                              setNotice(null);
                            }}
                          >
                            Clear
                          </button>
                        )}
                        <button
                          type="button"
                          className={`shortcuts-key-btn${isRecording ? " is-recording" : ""}`}
                          aria-label={isRecording ? `Press new shortcut for ${action.what}` : `Change shortcut for ${action.what}`}
                          aria-pressed={isRecording}
                          title={isRecording ? "Press keys, or Esc to cancel" : "Click to change shortcut"}
                          onClick={() => {
                            setRecordingId(cur => (cur === action.id ? null : action.id));
                            setNotice(null);
                          }}
                        >
                          {isRecording ? (
                            <span className="shortcuts-recording-label">
                              <span className="shortcuts-rec-dot" aria-hidden />
                              Press keys…
                            </span>
                          ) : tokens.length > 0 ? (
                            <span className="inline-flex gap-1">
                              {tokens.map((t, i) => <Kbd key={`${t}-${i}`}>{t}</Kbd>)}
                            </span>
                          ) : (
                            <span className="shortcuts-unbound">Unassigned</span>
                          )}
                        </button>
                      </div>
                    </div>

                    {rowNotice && (
                      <div className="shortcuts-notice" role={rowNotice.kind === "warning" ? "status" : "alert"}>
                        <span>{rowNotice.message}</span>
                        <div className="shortcuts-notice-actions">
                          {rowNotice.kind === "conflict" && rowNotice.conflictId && rowNotice.binding && (
                            <>
                              {bindings[action.id] !== null && (
                                <button
                                  type="button"
                                  className="btn-primary shortcuts-inline-btn"
                                  onClick={() => {
                                    swapBindings(action.id, rowNotice.conflictId!, rowNotice.binding!);
                                    setNotice(null);
                                  }}
                                >
                                  Swap keys
                                </button>
                              )}
                              <button
                                type="button"
                                className="btn-ghost shortcuts-inline-btn"
                                onClick={() => {
                                  replaceBinding(action.id, rowNotice.conflictId!, rowNotice.binding!);
                                  setNotice(null);
                                }}
                              >
                                Use {formatBinding(rowNotice.binding, mac)} here
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            className="btn-quiet shortcuts-inline-btn"
                            onClick={() => setNotice(null)}
                          >
                            {rowNotice.kind === "conflict" ? "Cancel" : "Dismiss"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}

          {filteredFixed.length > 0 && (
            <div className="shortcuts-group">
              <div className="shortcuts-group-head">
                <span className="eyebrow">Fixed system keys</span>
                <span className="shortcuts-group-detail">Stay locked so dialogs and typing always work</span>
              </div>
              {filteredFixed.map(item => (
                <div key={item.id} className="shortcuts-row is-fixed">
                  <div className="shortcuts-row-main">
                    <div className="shortcuts-row-label">
                      <span>{item.what}</span>
                    </div>
                    <span className="shortcuts-row-where">{item.where}</span>
                    <div className="shortcuts-row-keys">
                      <span className="shortcuts-fixed-tag">Fixed</span>
                      <span className="shortcuts-key-static inline-flex gap-1">
                        {item.keys.map((k, i) => (
                          <Kbd key={`${k}-${i}`}>{k === "Mod" ? (mac ? "⌘" : "Ctrl") : k}</Kbd>
                        ))}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {nothingMatches && (
            <p className="py-6 text-center text-[12.5px] text-muted">
              No shortcuts match “{query}”.
            </p>
          )}
        </div>

        <div className="shortcuts-footer">
          <span>
            {recordingId
              ? `Listening for “${ACTION_BY_ID[recordingId].what}” — press your new key combination, or Esc to cancel.`
              : "Click any key pill to rebind it. Changes save right away."}
          </span>
          <span>
            {SHORTCUT_ACTIONS.filter(a => bindings[a.id] !== null).length} active · {FIXED_SHORTCUTS.length} fixed
          </span>
        </div>
      </section>
    </div>
  );
}
