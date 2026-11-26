import { useRef, useState } from "react";
import { BUILT_IN_STYLE_SOUNDS, findBuiltInStyleSound, type BuiltInStyleSound, type StyleGuideRecord, type StyleGuideSound } from "@scarlet/shared";
import { newId } from "@scarlet/timeline";
import { Icon, InlineError } from "../../components/ui/primitives";
import { api, errorMessage } from "../../lib/client";
import { desktop, isDesktop } from "../../lib/desktop";
import { useFileDropTarget } from "../../lib/uiHooks";
import type { StyleSoundPlayer } from "./stageAudio";

const AUDIO_FILE = /\.(?:wav|mp3|m4a|aac|ogg|flac)$/i;
const DEFAULT_CUSTOM_WAVEFORM = [0.16, 0.34, 0.58, 0.82, 0.96, 0.88, 0.72, 0.64, 0.78, 0.91, 0.8, 0.62, 0.48, 0.55, 0.68, 0.52, 0.38, 0.29, 0.22, 0.17, 0.13, 0.09, 0.06, 0.04];

function WaveformBars({ bars, playing, progress }: { bars: readonly number[]; playing: boolean; progress: number }) {
  const lit = playing ? Math.max(1, Math.ceil(progress * bars.length)) : 0;
  return (
    <span className={`sg-waveform ${playing ? "is-playing" : ""}`} aria-hidden="true">
      {bars.map((v, i) => (
        <span
          key={i}
          className={`sg-waveform-bar ${i < lit ? "is-lit" : ""}`}
          style={{ height: `${Math.max(18, Math.round(v * 100))}%` }}
        />
      ))}
    </span>
  );
}

export function SoundsStage({
  guide,
  disabled,
  player,
  onSave,
  onGuideUpdated,
}: {
  guide: StyleGuideRecord | null;
  disabled: boolean;
  player: StyleSoundPlayer;
  onSave(next: StyleGuideSound[]): Promise<void>;
  onGuideUpdated(next: StyleGuideRecord): void;
}) {
  const sounds = guide?.sounds ?? [];
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [draftRules, setDraftRules] = useState<Record<string, string>>({});
  const [draftDb, setDraftDb] = useState<Record<string, number>>({});

  const uploadAudioFiles = async (items: Array<File | { path: string }>) => {
    if (!guide || disabled || busy) return;
    const valid = items.filter(item => {
      const name = item instanceof File ? item.name : item.path;
      return AUDIO_FILE.test(name) || (item instanceof File && item.type.startsWith("audio/"));
    });
    if (!valid.length) {
      setErr("Drop or choose a .wav, .mp3, .m4a, .aac, .ogg, or .flac sound file.");
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      let current = guide;
      const added: StyleGuideSound[] = [];
      for (const item of valid) {
        const name = item instanceof File ? item.name : item.path.split(/[\\/]/).pop() || "sound.wav";
        const res = await api.uploadStyleGuideAsset(current.id, item, name);
        current = res.styleGuide;
        onGuideUpdated(current);
        added.push({
          id: newId("sfx"),
          name: res.asset.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "),
          source: "asset",
          assetId: res.asset.id,
          volumeDb: -14,
          ...(res.duration !== undefined && { duration: res.duration }),
          usageRule: "",
        });
      }
      await onSave([...current.sounds, ...added]);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const { over: dropping, dropProps } = useFileDropTarget(
    paths => void uploadAudioFiles(paths.map(path => ({ path }))),
    files => void uploadAudioFiles(Array.from(files)),
    { ignoreChildLeave: true },
  );

  const pickAudio = async () => {
    if (isDesktop()) {
      const picked = await desktop.pickFile("Attach a sound effect (.wav, .mp3, .m4a)").catch(() => null);
      if (picked) void uploadAudioFiles([{ path: picked }]);
      return;
    }
    fileInputRef.current?.click();
  };

  const addBuiltIn = async (sound: BuiltInStyleSound) => {
    if (!guide || disabled || busy) return;
    if (sounds.some(s => s.source === "builtin" && s.builtInId === sound.id)) return;
    setBusy(true);
    setErr(null);
    try {
      const entry: StyleGuideSound = {
        id: newId("sfx"),
        name: sound.name,
        source: "builtin",
        builtInId: sound.id,
        volumeDb: sound.defaultVolumeDb,
        duration: sound.duration,
        usageRule: sound.defaultUsageRule,
      };
      await onSave([...sounds, entry]);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const commitSound = async (id: string, patch: Partial<StyleGuideSound>) => {
    if (!guide || disabled) return;
    const next = sounds.map(s => (s.id === id ? { ...s, ...patch } : s));
    setErr(null);
    try {
      await onSave(next);
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  const removeSound = async (sound: StyleGuideSound) => {
    if (!guide || disabled || busy) return;
    if (player.playingId === sound.id) player.stop();
    setBusy(true);
    setErr(null);
    try {
      if (sound.source === "asset" && sound.assetId) {
        const res = await api.deleteStyleGuideAsset(guide.id, sound.assetId);
        onGuideUpdated(res.styleGuide);
      } else {
        await onSave(sounds.filter(s => s.id !== sound.id));
      }
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const togglePlay = (key: string, volumeDb?: number) => {
    if (player.playingId === key) player.stop();
    else player.play(key, volumeDb);
  };

  const savedBuiltInIds = new Set(sounds.filter(s => s.source === "builtin").map(s => s.builtInId));

  return (
    <div {...dropProps} className={`sg-tab-body ${dropping ? "is-dropping" : ""}`}>
      <div className="sg-section-head">
        <div>
          <span className="sg-section-title">Style sounds</span>
          <span className="text-dim text-[12px] ml-2">Click any sound to preview at its mix level</span>
        </div>
        <button
          type="button"
          className="btn-ghost text-[12px] py-1 px-2.5"
          disabled={disabled || busy || !guide}
          onClick={() => void pickAudio()}
        >
          <Icon name="upload" size={11} /> Upload audio
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".wav,.mp3,.m4a,.aac,.ogg,.flac,audio/*"
          multiple
          className="sr-only"
          onChange={e => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) void uploadAudioFiles(files);
            e.target.value = "";
          }}
        />
      </div>

      <InlineError>{err}</InlineError>

      {sounds.length === 0 ? (
        <div className="sg-empty-card">
          <p className="text-muted text-[13px]">No sound effects saved in this style yet.</p>
          <p className="text-dim text-[12px] mt-1">
            Add from Scarlet’s built-in starters below, drop a .wav / .mp3 / .m4a file here, or ask Scarlet in chat.
          </p>
        </div>
      ) : (
        <ul className="sg-item-list" aria-label="Saved sound effects">
          {sounds.map(sound => {
            const builtIn = sound.source === "builtin" && sound.builtInId ? findBuiltInStyleSound(sound.builtInId) : undefined;
            const asset = sound.source === "asset" && sound.assetId ? guide?.assets.find(a => a.id === sound.assetId) : undefined;
            const isPlaying = player.playingId === sound.id;
            const dbVal = draftDb[sound.id] ?? sound.volumeDb;
            const ruleVal = draftRules[sound.id] ?? sound.usageRule;
            const bars = builtIn?.waveform ?? DEFAULT_CUSTOM_WAVEFORM;

            return (
              <li key={sound.id} className={`sg-sound-row ${isPlaying ? "is-active" : ""}`}>
                <div className="sg-sound-top">
                  <button
                    type="button"
                    className={`sg-play-circle ${isPlaying ? "is-playing" : ""}`}
                    aria-label={isPlaying ? `Stop ${sound.name}` : `Play ${sound.name}`}
                    onClick={() => togglePlay(sound.id, dbVal)}
                  >
                    <Icon name={isPlaying ? "stop" : "play"} size={11} />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="sg-item-title-line">
                      <span className="sg-item-name">{sound.name}</span>
                      <span className="sg-meta-chip">
                        {sound.source === "builtin" ? "Built-in" : (asset?.name ?? "Custom audio")}
                      </span>
                      {sound.duration !== undefined && (
                        <span className="text-dim text-[11.5px] tnum">{sound.duration.toFixed(2)} s</span>
                      )}
                    </div>
                  </div>
                  <WaveformBars bars={bars} playing={isPlaying} progress={player.progress} />
                  <label className="sg-db-control" title="Default mix level">
                    <input
                      type="range"
                      min={-30}
                      max={0}
                      step={1}
                      value={dbVal}
                      disabled={disabled || busy}
                      aria-label={`${sound.name} level in dB`}
                      onChange={e => setDraftDb(prev => ({ ...prev, [sound.id]: Number(e.target.value) }))}
                      onMouseUp={() => {
                        if (draftDb[sound.id] !== undefined && draftDb[sound.id] !== sound.volumeDb) {
                          void commitSound(sound.id, { volumeDb: draftDb[sound.id] });
                        }
                      }}
                      onTouchEnd={() => {
                        if (draftDb[sound.id] !== undefined && draftDb[sound.id] !== sound.volumeDb) {
                          void commitSound(sound.id, { volumeDb: draftDb[sound.id] });
                        }
                      }}
                      onKeyUp={() => {
                        if (draftDb[sound.id] !== undefined && draftDb[sound.id] !== sound.volumeDb) {
                          void commitSound(sound.id, { volumeDb: draftDb[sound.id] });
                        }
                      }}
                    />
                    <span className="sg-db-value tnum">{dbVal} dB</span>
                  </label>
                  <button
                    type="button"
                    className="btn-icon hover:text-bad"
                    aria-label={`Remove ${sound.name}`}
                    title="Remove"
                    disabled={disabled || busy}
                    onClick={() => void removeSound(sound)}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </div>
                <div className="sg-sound-rule-row">
                  <input
                    className="sg-rule-input"
                    value={ruleVal}
                    disabled={disabled || busy}
                    aria-label={`${sound.name} usage rule`}
                    placeholder="Add usage rule (e.g. Plays when lower thirds enter)…"
                    onChange={e => setDraftRules(prev => ({ ...prev, [sound.id]: e.target.value }))}
                    onBlur={() => {
                      const trimmed = ruleVal.trim();
                      if (trimmed !== sound.usageRule) void commitSound(sound.id, { usageRule: trimmed });
                    }}
                    onKeyDown={e => {
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="sg-divider" />

      <div className="sg-section-head">
        <div>
          <span className="sg-section-title">Starter library</span>
          <span className="text-dim text-[12px] ml-2">Royalty-free built-in sounds ready to preview or add</span>
        </div>
      </div>

      <ul className="sg-starter-grid" aria-label="Built-in starter sound effects">
        {BUILT_IN_STYLE_SOUNDS.map(starter => {
          const playKey = `builtin:${starter.id}`;
          const isPlaying = player.playingId === playKey;
          const added = savedBuiltInIds.has(starter.id);
          return (
            <li key={starter.id} className={`sg-starter-card ${isPlaying ? "is-active" : ""}`}>
              <button
                type="button"
                className={`sg-play-circle ${isPlaying ? "is-playing" : ""}`}
                aria-label={isPlaying ? `Stop ${starter.name}` : `Preview ${starter.name}`}
                onClick={() => togglePlay(playKey, starter.defaultVolumeDb)}
              >
                <Icon name={isPlaying ? "stop" : "play"} size={11} />
              </button>
              <div className="min-w-0 flex-1">
                <div className="sg-item-title-line">
                  <span className="sg-item-name">{starter.name}</span>
                  <span className="text-dim text-[11px] tnum">{starter.duration.toFixed(2)}s</span>
                </div>
                <div className="sg-item-rule truncate">{starter.defaultUsageRule}</div>
              </div>
              <WaveformBars bars={starter.waveform} playing={isPlaying} progress={player.progress} />
              {added ? (
                <span className="sg-added-badge">Added</span>
              ) : (
                <button
                  type="button"
                  className="btn-ghost text-[11.5px] py-0.5 px-2"
                  disabled={disabled || busy || !guide}
                  onClick={() => void addBuiltIn(starter)}
                >
                  Add
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {dropping && <div className="sg-drop-overlay" aria-hidden="true">Drop audio files (.wav, .mp3, .m4a) to add to this style</div>}
    </div>
  );
}
