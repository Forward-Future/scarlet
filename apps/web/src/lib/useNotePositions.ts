import { useEffect, useMemo, useState } from "react";
import { makeTimeMap, timelineDuration, type Note, type Timeline } from "@scarlet/timeline";
import { api } from "./client";

/** Notes keep their original version and time. Only place them where the footage survives. */
export function useNotePositions(timeline: Timeline | null | undefined, notes: Note[] | undefined, fps: number) {
  const historical = useMemo(() => Array.from(new Set(notes?.filter(n => n.version !== timeline?.version).map(n => n.version))).sort(), [notes, timeline?.version]);
  const key = JSON.stringify([timeline?.projectId, historical]);
  const [loaded, setLoaded] = useState<{ key: string; versions: Map<string, Timeline>; failed: boolean }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!timeline || !historical.length) return;
    let active = true;
    const versions = new Map<string, Timeline>();
    const remaining = historical.values();
    // Keep large project histories from flooding the engine with version reads.
    async function read() {
      for (const version of remaining) {
        if (!active) return;
        try {
          const result = await api.timeline(timeline!.projectId, version);
          versions.set(version, result.timeline);
        } catch { /* Let the user retry unavailable versions. */ }
      }
    }
    void Promise.all(Array.from({ length: Math.min(3, historical.length) }, read)).then(() => {
      if (active) setLoaded({ key, versions, failed: versions.size !== historical.length });
    });
    return () => { active = false; };
  }, [key, attempt]);
  const available = loaded?.key === key ? loaded : undefined;
  const times = useMemo(() => {
    const result = new Map<string, number | null>();
    if (!timeline || !notes?.length) return result;
    const duration = timelineDuration(timeline);
    const maps = new Map<string, ReturnType<typeof makeTimeMap>>();
    for (const note of notes) {
      if (note.version === timeline.version) { result.set(note.id, note.time); continue; }
      const source = available?.versions.get(note.version);
      if (!source) continue;
      const map = maps.get(note.version) ?? makeTimeMap(source, timeline, fps);
      maps.set(note.version, map);
      const time = map(note.time);
      result.set(note.id, time !== null && time <= duration ? time : null);
    }
    return result;
  }, [timeline, notes, fps, available]);
  return { times, failed: available?.failed, retry: () => setAttempt(n => n + 1) };
}
