import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { BUILT_IN_STYLE_SOUNDS, type StyleGuideRecord, type StyleGuideTransition } from "@scarlet/shared";
import { newId, type TransitionDirection, type TransitionType } from "@scarlet/timeline";
import { PreferenceSelect } from "../../components/ui/PreferenceSelect";
import { Icon } from "../../components/ui/primitives";
import type { StyleSoundPlayer } from "./stageAudio";

const TYPE_OPTIONS: Array<{ value: TransitionType; label: string; detail: string }> = [
  { value: "dissolve", label: "Dissolve", detail: "Smooth crossfade between clips" },
  { value: "push", label: "Push", detail: "Next clip pushes the current clip off screen" },
  { value: "slide", label: "Slide", detail: "Next clip slides over the current clip" },
  { value: "whip", label: "Whip", detail: "Fast directional pan with motion blur" },
  { value: "dip", label: "Dip", detail: "Fade through a solid colour" },
];

const DIRECTION_OPTIONS: Array<{ value: TransitionDirection; label: string }> = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "up", label: "Up" },
  { value: "down", label: "Down" },
];

const DURATION_OPTIONS = [
  { value: "0.25", label: "0.25 s" },
  { value: "0.3", label: "0.30 s" },
  { value: "0.4", label: "0.40 s" },
  { value: "0.5", label: "0.50 s" },
  { value: "0.6", label: "0.60 s" },
  { value: "0.8", label: "0.80 s" },
  { value: "1", label: "1.00 s" },
];

const TYPE_LABEL: Record<TransitionType, string> = {
  dissolve: "Dissolve",
  dip: "Dip",
  push: "Push",
  slide: "Slide",
  whip: "Whip",
};

function easeInOut(p: number): number {
  return p * p * (3 - 2 * p);
}

function easeQuint(p: number): number {
  return p * p * p * (p * (6 * p - 15) + 10);
}

function transitionStyles(tr: StyleGuideTransition | null, t: number): { a: CSSProperties; b: CSSProperties; dipOverlay?: CSSProperties } {
  if (!tr) return { a: { opacity: 1 }, b: { opacity: 0 } };
  const p = Math.min(1, Math.max(0, t));
  if (tr.type === "dissolve") {
    const e = easeInOut(p);
    return { a: { opacity: 1 }, b: { opacity: e } };
  }
  if (tr.type === "dip") {
    const color = tr.color ?? "#000000";
    if (p < 0.5) {
      const e = easeInOut(p * 2);
      return { a: { opacity: 1 }, b: { opacity: 0 }, dipOverlay: { background: color, opacity: e } };
    }
    const e = easeInOut((p - 0.5) * 2);
    return { a: { opacity: 0 }, b: { opacity: 1 }, dipOverlay: { background: color, opacity: 1 - e } };
  }
  const e = tr.type === "whip" ? easeQuint(p) : easeInOut(p);
  const axis = tr.direction === "left" || tr.direction === "right" ? "X" : "Y";
  const sign = tr.direction === "left" || tr.direction === "up" ? 1 : -1;
  const outPct = -sign * e * 100;
  const inPct = sign * (1 - e) * 100;
  const blurPx = tr.type === "whip" && p > 0.12 && p < 0.88 ? Math.sin(((p - 0.12) / 0.76) * Math.PI) * 10 : 0;
  const filter = blurPx > 0.2 ? `blur(${blurPx.toFixed(1)}px)` : undefined;
  return {
    a: {
      opacity: 1,
      transform: tr.type === "slide" ? undefined : `translate${axis}(${outPct.toFixed(2)}%)`,
      filter: tr.type === "slide" ? undefined : filter,
    },
    b: {
      opacity: 1,
      transform: `translate${axis}(${inPct.toFixed(2)}%)`,
      filter,
    },
  };
}

function soundLabelFor(guide: StyleGuideRecord | null, soundId?: string): string | undefined {
  if (!soundId) return undefined;
  const saved = guide?.sounds.find(s => s.id === soundId);
  if (saved) return saved.name;
  const slug = soundId.startsWith("builtin:") ? soundId.slice("builtin:".length) : soundId;
  return BUILT_IN_STYLE_SOUNDS.find(s => s.id === slug)?.name ?? soundId;
}

const PREVIEW_SAMPLE: StyleGuideTransition = {
  id: "tr_preview",
  name: "Soft push",
  type: "push",
  duration: 0.4,
  direction: "left",
  soundId: "builtin:soft-whoosh",
  usageRule: "Default between sections",
  isDefault: true,
};

export function TransitionsStage({
  guide,
  disabled,
  player,
  onSave,
}: {
  guide: StyleGuideRecord | null;
  disabled: boolean;
  player: StyleSoundPlayer;
  onSave(next: StyleGuideTransition[]): Promise<void>;
}) {
  const transitions = guide?.transitions ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(() => transitions.find(t => t.isDefault)?.id ?? transitions[0]?.id ?? null);
  const [phase, setPhase] = useState(0.42);
  const [playing, setPlaying] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<StyleGuideTransition | null>(null);
  const [saving, setSaving] = useState(false);

  const rafRef = useRef<number | null>(null);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (transitions.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !transitions.some(t => t.id === selectedId)) {
      setSelectedId(transitions.find(t => t.isDefault)?.id ?? transitions[0]!.id);
    }
  }, [transitions, selectedId]);

  const stopAnim = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    setPlaying(false);
  }, []);

  useEffect(() => stopAnim, [stopAnim]);

  const activeTransition = useMemo(() => {
    if (editingId && draft && editingId === draft.id) return draft;
    return transitions.find(t => t.id === selectedId) ?? transitions[0] ?? PREVIEW_SAMPLE;
  }, [editingId, draft, transitions, selectedId]);

  const runPreview = useCallback((tr: StyleGuideTransition) => {
    stopAnim();
    if (tr.soundId) player.play(tr.soundId);
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setPhase(1);
      setPlaying(false);
      return;
    }
    const durMs = Math.max(150, tr.duration * 1000);
    const started = performance.now();
    setPlaying(true);
    setPhase(0);
    const step = (now: number) => {
      const p = Math.min(1, (now - started) / durMs);
      setPhase(p);
      if (p < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = null;
        resetTimerRef.current = window.setTimeout(() => {
          setPlaying(false);
          setPhase(0.42);
        }, 700);
      }
    };
    rafRef.current = requestAnimationFrame(step);
  }, [player, stopAnim]);

  const soundOptions = useMemo(() => {
    const saved = (guide?.sounds ?? []).map(s => ({
      value: s.id,
      label: s.name,
      detail: `${s.volumeDb} dB${s.usageRule ? ` · ${s.usageRule}` : ""}`,
      group: "Saved in this style",
    }));
    const savedBuiltIns = new Set((guide?.sounds ?? []).filter(s => s.source === "builtin").map(s => s.builtInId));
    const builtIns = BUILT_IN_STYLE_SOUNDS
      .filter(s => !savedBuiltIns.has(s.id))
      .map(s => ({
        value: `builtin:${s.id}`,
        label: s.name,
        detail: `${s.duration.toFixed(2)} s · ${s.defaultVolumeDb} dB`,
        group: "Built-in starters",
      }));
    return [{ value: "", label: "No paired sound" }, ...saved, ...builtIns];
  }, [guide?.sounds]);

  const openAdd = (preset?: Partial<StyleGuideTransition>) => {
    const item: StyleGuideTransition = {
      id: newId("tr"),
      name: preset?.name ?? "Section push",
      type: preset?.type ?? "push",
      duration: preset?.duration ?? 0.4,
      direction: preset?.direction ?? "left",
      ...(preset?.color ? { color: preset.color } : {}),
      ...(preset?.soundId ? { soundId: preset.soundId } : {}),
      usageRule: preset?.usageRule ?? (transitions.length === 0 ? "Default between sections" : ""),
      isDefault: preset?.isDefault ?? transitions.length === 0,
    };
    setDraft(item);
    setEditingId(item.id);
    setSelectedId(item.id);
    runPreview(item);
  };

  const openEdit = (tr: StyleGuideTransition) => {
    setDraft({ ...tr });
    setEditingId(tr.id);
    setSelectedId(tr.id);
  };

  const commitDraft = async () => {
    if (!draft || !draft.name.trim() || saving) return;
    setSaving(true);
    try {
      const clean: StyleGuideTransition = { ...draft, name: draft.name.trim(), usageRule: draft.usageRule.trim() };
      const exists = transitions.some(t => t.id === clean.id);
      const base = exists ? transitions.map(t => (t.id === clean.id ? clean : t)) : [...transitions, clean];
      const next = clean.isDefault ? base.map(t => ({ ...t, isDefault: t.id === clean.id })) : base;
      await onSave(next);
      setEditingId(null);
      setDraft(null);
      setSelectedId(clean.id);
    } finally {
      setSaving(false);
    }
  };

  const setAsDefault = async (id: string) => {
    setSaving(true);
    try {
      await onSave(transitions.map(t => ({ ...t, isDefault: t.id === id })));
    } finally {
      setSaving(false);
    }
  };

  const removeItem = async (id: string) => {
    setSaving(true);
    try {
      const remaining = transitions.filter(t => t.id !== id);
      if (editingId === id) { setEditingId(null); setDraft(null); }
      await onSave(remaining);
    } finally {
      setSaving(false);
    }
  };

  const styles = transitionStyles(activeTransition, phase);
  const activeSoundName = soundLabelFor(guide, activeTransition.soundId);
  const needsDirection = (type: TransitionType) => type === "push" || type === "slide" || type === "whip";

  return (
    <div className="sg-tab-body">
      <div className="sg-transition-stage-wrap">
        <button
          type="button"
          className="sg-ab-stage"
          onClick={() => runPreview(activeTransition)}
          aria-label={`Replay ${activeTransition.name} transition`}
          title="Click to replay A → B transition"
        >
          <div className="sg-ab-clip is-a" style={styles.a}>
            <div className="sg-ab-scene-a">
              <div className="sg-ab-silhouette" />
              <div className="sg-ab-desk" />
            </div>
            <span className="sg-ab-tag">Clip A · Studio Cam</span>
          </div>
          <div className="sg-ab-clip is-b" style={styles.b}>
            <div className="sg-ab-scene-b">
              <div className="sg-ab-window-bar" />
              <div className="sg-ab-window-grid">
                <div className="sg-ab-panel is-wide" />
                <div className="sg-ab-panel" />
                <div className="sg-ab-panel" />
              </div>
            </div>
            <span className="sg-ab-tag">Clip B · Screen Demo</span>
          </div>
          {styles.dipOverlay && <div className="sg-ab-dip" style={styles.dipOverlay} />}
          <span className="sg-ab-replay">
            <Icon name="play" size={11} />
            {playing ? "Playing…" : "Replay"}
          </span>
          <div className="sg-ab-progress" aria-hidden="true">
            <div className="sg-ab-progress-fill" style={{ width: `${Math.round(phase * 100)}%` }} />
          </div>
        </button>

        <div className="sg-stage-meta">
          <span className="text-fg font-medium">{activeTransition.name}</span>
          <span className="text-dim">·</span>
          <span>
            {TYPE_LABEL[activeTransition.type]}
            {needsDirection(activeTransition.type) ? ` ${activeTransition.direction}` : ""}
          </span>
          <span className="text-dim">·</span>
          <span className="tnum">{activeTransition.duration.toFixed(2)} s</span>
          {activeSoundName && (
            <>
              <span className="text-dim">·</span>
              <span className="sg-inline-pill"><Icon name="audio" size={11} /> {activeSoundName}</span>
            </>
          )}
          {transitions.length === 0 && <span className="sg-sample-note">Sample preview</span>}
        </div>
      </div>

      <div className="sg-section-head">
        <span className="sg-section-title">Saved transitions</span>
        <button
          type="button"
          className="btn-ghost text-[12px] py-1 px-2.5"
          disabled={disabled || saving || !guide}
          onClick={() => openAdd()}
        >
          <Icon name="plus" size={11} /> Add transition
        </button>
      </div>

      {draft && editingId === draft.id && (
        <div className="sg-inline-editor" role="region" aria-label="Edit transition">
          <div className="sg-editor-grid">
            <label className="sg-field">
              <span>Name</span>
              <input
                className="field text-[12.5px] py-1"
                value={draft.name}
                onChange={e => setDraft({ ...draft, name: e.target.value })}
                placeholder="Section push"
              />
            </label>
            <div className="sg-field">
              <span>Type</span>
              <PreferenceSelect
                compact
                label="Transition type"
                options={TYPE_OPTIONS}
                value={draft.type}
                onChange={type => {
                  const next = { ...draft, type, ...(type === "dip" && !draft.color ? { color: "#000000" } : {}) };
                  setDraft(next);
                  runPreview(next);
                }}
              />
            </div>
            <div className="sg-field">
              <span>Duration</span>
              <PreferenceSelect
                compact
                label="Transition duration"
                options={DURATION_OPTIONS}
                value={String(draft.duration)}
                valueLabel={`${draft.duration.toFixed(2)} s`}
                onChange={val => {
                  const next = { ...draft, duration: Number(val) };
                  setDraft(next);
                  runPreview(next);
                }}
              />
            </div>
            {needsDirection(draft.type) && (
              <div className="sg-field">
                <span>Direction</span>
                <PreferenceSelect
                  compact
                  label="Transition direction"
                  options={DIRECTION_OPTIONS}
                  value={draft.direction}
                  onChange={direction => {
                    const next = { ...draft, direction };
                    setDraft(next);
                    runPreview(next);
                  }}
                />
              </div>
            )}
            <div className="sg-field">
              <span>Paired sound</span>
              <PreferenceSelect
                compact
                label="Paired sound effect"
                options={soundOptions}
                value={draft.soundId ?? ""}
                onChange={soundId => {
                  const next = { ...draft, soundId: soundId || undefined };
                  setDraft(next);
                  runPreview(next);
                }}
              />
            </div>
            <label className="sg-field is-wide">
              <span>Usage rule</span>
              <input
                className="field text-[12.5px] py-1"
                value={draft.usageRule}
                onChange={e => setDraft({ ...draft, usageRule: e.target.value })}
                placeholder="Default between sections"
              />
            </label>
          </div>
          <div className="sg-editor-actions">
            <button type="button" className="btn-quiet text-[12px]" onClick={() => { setEditingId(null); setDraft(null); }}>
              Cancel
            </button>
            <button type="button" className="btn-primary text-[12px] py-1 px-3" disabled={!draft.name.trim() || saving} onClick={() => void commitDraft()}>
              Save transition
            </button>
          </div>
        </div>
      )}

      {transitions.length === 0 && !draft ? (
        <div className="sg-empty-card">
          <p className="text-muted text-[13px]">No transitions saved yet.</p>
          <p className="text-dim text-[12px] mt-1">
            Add a starter below or ask Scarlet in chat (for example, “use a 0.4s push left with soft whoosh between chapters”).
          </p>
          <div className="flex flex-wrap gap-2 mt-3">
            <button type="button" className="btn-ghost text-[12px] py-1 px-2.5" disabled={disabled || !guide}
              onClick={() => openAdd({ name: "Section push", type: "push", duration: 0.4, direction: "left", soundId: "builtin:soft-whoosh", usageRule: "Default between sections", isDefault: true })}>
              + Push left · Soft whoosh
            </button>
            <button type="button" className="btn-ghost text-[12px] py-1 px-2.5" disabled={disabled || !guide}
              onClick={() => openAdd({ name: "Cross dissolve", type: "dissolve", duration: 0.5, usageRule: "Soft cut between B-roll shots" })}>
              + Cross dissolve · 0.5s
            </button>
            <button type="button" className="btn-ghost text-[12px] py-1 px-2.5" disabled={disabled || !guide}
              onClick={() => openAdd({ name: "Whip pan", type: "whip", duration: 0.3, direction: "left", soundId: "builtin:airy-slide", usageRule: "Fast jump to screen demo" })}>
              + Whip pan · Airy slide
            </button>
          </div>
        </div>
      ) : (
        <ul className="sg-item-list" aria-label="Style guide transitions">
          {transitions.map(tr => {
            const active = tr.id === selectedId;
            const paired = soundLabelFor(guide, tr.soundId);
            return (
              <li key={tr.id} className={`sg-item-row ${active ? "is-active" : ""}`}>
                <button
                  type="button"
                  className="sg-item-main"
                  onClick={() => { setSelectedId(tr.id); runPreview(tr); }}
                >
                  <span className="sg-item-play" aria-hidden="true">
                    <Icon name="play" size={11} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="sg-item-title-line">
                      <span className="sg-item-name">{tr.name}</span>
                      {tr.isDefault && <span className="style-guide-default-badge">Default</span>}
                      <span className="sg-meta-chip">
                        {TYPE_LABEL[tr.type]}
                        {needsDirection(tr.type) ? ` ${tr.direction}` : ""} · {tr.duration.toFixed(2)}s
                      </span>
                      {paired && (
                        <span className="sg-meta-chip">
                          <Icon name="audio" size={10} /> {paired}
                        </span>
                      )}
                    </div>
                    {tr.usageRule && <div className="sg-item-rule">{tr.usageRule}</div>}
                  </div>
                </button>
                <div className="sg-item-actions">
                  {!tr.isDefault && (
                    <button type="button" className="btn-quiet text-[11.5px]" disabled={disabled || saving} onClick={() => void setAsDefault(tr.id)}>
                      Make default
                    </button>
                  )}
                  <button type="button" className="btn-icon" aria-label={`Edit ${tr.name}`} title="Edit" disabled={disabled || saving} onClick={() => openEdit(tr)}>
                    <Icon name="pencil" size={12} />
                  </button>
                  <button type="button" className="btn-icon hover:text-bad" aria-label={`Remove ${tr.name}`} title="Remove" disabled={disabled || saving} onClick={() => void removeItem(tr.id)}>
                    <Icon name="trash" size={12} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
