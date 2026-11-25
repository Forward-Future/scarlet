import { useRef, useState } from "react";
import { isRunningTranscriptionTask } from "../../lib/transcriptionProgress";
import { isPreparingMedia } from "../../lib/upload";
import { useProjectStore } from "../../stores/project";
import { useSourceCaches } from "./sourceCaches";

export function useMediaProcessing() {
  const projectId = useProjectStore(s => s.current?.id);
  const paused = useProjectStore(s => !!s.current?.project.mediaPaused);
  const media = useProjectStore(s => s.current?.media);
  const transcribing = useProjectStore(s => !!s.current?.tasks.some(isRunningTranscriptionTask));
  const { caches } = useSourceCaches();
  const preparing = !!media?.some(isPreparingMedia);
  const caching = !!media?.some(m => {
    if (m.kind !== "video") return false;
    const cache = caches.get(m.id);
    return cache?.state === "caching" || !!cache?.queued;
  });
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const label = paused ? "Resume" : "Pause";
  const working = !paused && (preparing || caching || transcribing);
  const available = paused || working || busy;

  async function toggle(): Promise<boolean> {
    if (!projectId || pending.current) return false;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await useProjectStore.getState().updateProject({ mediaPaused: !paused }, projectId);
      return true;
    } catch {
      setError(`Couldn’t ${label.toLowerCase()} media processing. Try again.`);
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  // `label` is the word inside Media, where the panel says what it is about; `description` says it whole, for a menu.
  return { label, description: `${label} media processing`, icon: paused ? "play" as const : "pause" as const, available, busy, error, toggle };
}
