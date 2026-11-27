import { useCallback, useEffect, useRef, useState } from "react";
import { dbToLinearGain, findBuiltInStyleSound, synthesizeBuiltInSfxWav, type StyleGuideRecord } from "@scarlet/shared";
import { api, IS_MOCK } from "../../lib/client";

export interface StyleSoundPlayer {
  playingId: string | null;
  progress: number;
  play(soundKey: string, overrideVolumeDb?: number): void;
  stop(): void;
}

const mockBlobUrls = new Map<string, string>();

function resolveBuiltInUrl(slug: string): string | undefined {
  const meta = findBuiltInStyleSound(slug);
  if (!meta) return undefined;
  if (!IS_MOCK) return api.builtInStyleSoundUrl(meta.id);
  let url = mockBlobUrls.get(meta.id);
  if (!url && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    const wav = synthesizeBuiltInSfxWav(meta.id);
    if (wav) {
      url = URL.createObjectURL(new Blob([new Uint8Array(wav)], { type: "audio/wav" }));
      mockBlobUrls.set(meta.id, url);
    }
  }
  return url;
}

export function resolveStyleSoundSource(
  guide: StyleGuideRecord | null,
  soundKey: string,
): { url: string; volumeDb: number; duration?: number } | undefined {
  if (soundKey.startsWith("builtin:")) {
    const slug = soundKey.slice("builtin:".length);
    const meta = findBuiltInStyleSound(slug);
    const url = meta ? resolveBuiltInUrl(meta.id) : undefined;
    return meta && url ? { url, volumeDb: meta.defaultVolumeDb, duration: meta.duration } : undefined;
  }
  const saved = guide?.sounds.find(s => s.id === soundKey);
  if (saved) {
    if (saved.source === "builtin" && saved.builtInId) {
      const url = resolveBuiltInUrl(saved.builtInId);
      return url ? { url, volumeDb: saved.volumeDb, duration: saved.duration ?? findBuiltInStyleSound(saved.builtInId)?.duration } : undefined;
    }
    if (saved.source === "asset" && saved.assetId && guide) {
      return { url: api.styleGuideAssetUrl(guide.id, saved.assetId), volumeDb: saved.volumeDb, duration: saved.duration };
    }
  }
  const directBuiltIn = findBuiltInStyleSound(soundKey);
  if (directBuiltIn) {
    const url = resolveBuiltInUrl(directBuiltIn.id);
    return url ? { url, volumeDb: directBuiltIn.defaultVolumeDb, duration: directBuiltIn.duration } : undefined;
  }
  return undefined;
}

export function useStyleSoundPlayer(guide: StyleGuideRecord | null): StyleSoundPlayer {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    setPlayingId(null);
    setProgress(0);
  }, []);

  useEffect(() => stop, [stop]);

  const play = useCallback((soundKey: string, overrideVolumeDb?: number) => {
    stop();
    const resolved = resolveStyleSoundSource(guide, soundKey);
    if (!resolved || typeof Audio === "undefined") return;
    const audio = new Audio(resolved.url);
    const db = overrideVolumeDb ?? resolved.volumeDb;
    audio.volume = Math.min(1, Math.max(0, dbToLinearGain(db)));
    audioRef.current = audio;
    setPlayingId(soundKey);
    setProgress(0);

    const tick = () => {
      if (audioRef.current !== audio) return;
      const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (resolved.duration ?? 0.5);
      setProgress(Math.min(1, Math.max(0, audio.currentTime / dur)));
      if (!audio.paused && !audio.ended) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    audio.addEventListener("ended", () => {
      if (audioRef.current === audio) stop();
    }, { once: true });
    audio.addEventListener("error", () => {
      if (audioRef.current === audio) stop();
    }, { once: true });

    const p = audio.play();
    if (p && typeof p.catch === "function") {
      p.catch(() => { if (audioRef.current === audio) stop(); });
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [guide, stop]);

  return { playingId, progress, play, stop };
}
