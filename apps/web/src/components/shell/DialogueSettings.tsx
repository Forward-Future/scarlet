import { useEffect, useState } from "react";
import { DIALOGUE_CUT_KINDS, DialoguePreferences, type AiCutLevel, type DialogueCutKind, type PauseTightness } from "@scarlet/shared";
import { api, errorMessage } from "../../lib/client";
import { PreferenceSelect } from "../ui/PreferenceSelect";
import { ErrorState, InlineError, Loading } from "../ui/primitives";

const KINDS: Record<DialogueCutKind, { title: string; hint: string }> = {
  pause: { title: "Pauses", hint: "Long silences between lines" },
  filler: { title: "Filler words", hint: "Um, uh and similar sounds" },
  retake: { title: "Retakes", hint: "Earlier attempts at a repeated line" },
  coaching: { title: "Production talk", hint: "Directions and asides between takes" },
};
const LEVELS: Array<{ value: AiCutLevel; label: string }> = [
  { value: "cut", label: "Cut" },
  { value: "suggest", label: "Suggest" },
  { value: "off", label: "Off" },
];
const TIGHTNESS: Array<{ value: PauseTightness; label: string }> = [
  { value: "loose", label: "Loose" },
  { value: "natural", label: "Natural" },
  { value: "tight", label: "Tight" },
];
const crossfadeChoice = (frames: number) => ({ value: frames, label: frames ? `${frames} ${frames === 1 ? "frame" : "frames"}` : "Off" });
const CROSSFADES = [0, 1, 2, 4].map(crossfadeChoice);

/** The editor's limits for dialogue passes. Scarlet enforces them; the AI sees them before it plans. */
export function DialogueSettings() {
  const [preferences, setPreferences] = useState<DialoguePreferences | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    void api.settings().then(({ settings }) => {
      // An older engine has no dialogue settings yet. Show the defaults it behaves by.
      if (active) setPreferences(DialoguePreferences.parse(settings.dialogue ?? {}));
    }).catch(e => { if (active) setError(errorMessage(e)); });
    return () => { active = false; };
  }, [attempt]);

  async function save(patch: { aiCuts?: Partial<DialoguePreferences["aiCuts"]>; pauseTightness?: PauseTightness; crossfadeFrames?: number }) {
    if (!preferences) return;
    const previous = preferences;
    const next = { aiCuts: { ...preferences.aiCuts, ...patch.aiCuts }, pauseTightness: patch.pauseTightness ?? preferences.pauseTightness,
      crossfadeFrames: patch.crossfadeFrames ?? preferences.crossfadeFrames };
    setPreferences(next);
    setBusy(true);
    setError("");
    try {
      const { settings } = await api.updateSettings({ dialogue: next });
      setPreferences(DialoguePreferences.parse(settings.dialogue ?? {}));
    } catch (e) {
      setPreferences(previous);
      setError(errorMessage(e));
    } finally { setBusy(false); }
  }

  if (!preferences) return error
    ? <ErrorState title="Couldn’t load dialogue settings" body={error} onRetry={() => setAttempt(v => v + 1)} />
    : <Loading label="Loading dialogue settings…" />;
  return (
    <div className="tool-settings">
      <div className="tools-subheading">
        <div>
          <h4>What Scarlet cuts on its own</h4>
          <p>For dialogue edits. Suggest asks you about every cut of that kind. Off leaves it in.</p>
        </div>
      </div>
      <div className="divide-y divide-line/60">
        {DIALOGUE_CUT_KINDS.map(kind => (
          <div key={kind} className="tool-setting-row">
            <div>
              <div className="font-medium">{KINDS[kind].title}</div>
              <p className="text-muted text-[12px]">{KINDS[kind].hint}</p>
            </div>
            <PreferenceSelect id={`ai-cut-${kind}`} compact label={KINDS[kind].title} disabled={busy} value={preferences.aiCuts[kind]}
              options={LEVELS} onChange={level => void save({ aiCuts: { [kind]: level } })} />
          </div>
        ))}
      </div>
      <div className="tools-subheading mt-4">
        <div>
          <h4>Pause tightness</h4>
          <p>Sets the room beside cut words. In dialogue passes, Scarlet also trims long, quiet pauses automatically according to the Pauses setting above. A duration you choose for a pause overrides the automatic target.</p>
        </div>
        <PreferenceSelect id="pause-tightness" compact label="Pause tightness" disabled={busy} value={preferences.pauseTightness}
          options={TIGHTNESS} onChange={pauseTightness => void save({ pauseTightness })} />
      </div>
      <div className="tools-subheading mt-4">
        <div>
          <h4>Crossfade on cuts</h4>
          <p>Blends the sound across each cut so it doesn’t click or jump. The picture still cuts straight.</p>
        </div>
        {/* A length set elsewhere stays listed, so the field shows it. */}
        <PreferenceSelect id="crossfade-frames" compact label="Crossfade on cuts" disabled={busy} value={preferences.crossfadeFrames}
          options={CROSSFADES.some(o => o.value === preferences.crossfadeFrames) ? CROSSFADES
            : [...CROSSFADES, crossfadeChoice(preferences.crossfadeFrames)].sort((a, b) => a.value - b.value)}
          onChange={crossfadeFrames => void save({ crossfadeFrames })} />
      </div>
      <InlineError>{error}</InlineError>
    </div>
  );
}
