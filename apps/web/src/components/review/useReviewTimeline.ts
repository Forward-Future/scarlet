import { useEffect, useState } from "react";
import type { Timeline } from "@scarlet/timeline";
import { api, errorMessage } from "../../lib/client";

export function useReviewTimeline(projectId: string, version?: string, known?: Timeline | null) {
  const [saved, setSaved] = useState<Timeline>();
  // Why a version couldn't be read, with the version it is about: the next one asked for hasn't failed, and a caller
  // that waits until a version is in or has failed must go on waiting for it.
  const [failed, setFailed] = useState<{ projectId: string; version: string; error: string }>();
  const [attempt, setAttempt] = useState(0);
  const timeline = version ? [known, saved].find(t => t?.version === version) : undefined;
  useEffect(() => {
    if (!version || timeline) return;
    let live = true;
    setFailed(undefined);
    api.timeline(projectId, version).then(
      ({ timeline }) => { if (live) setSaved(timeline); },
      e => { if (live) setFailed({ projectId, version, error: errorMessage(e) }); },
    );
    return () => { live = false; };
  }, [projectId, version, timeline, attempt]);
  const error = failed && failed.projectId === projectId && failed.version === version ? failed.error : undefined;
  return { timeline, error: version && !timeline ? error : undefined, retry: () => setAttempt(n => n + 1) };
}
