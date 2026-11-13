import { useEffect, useMemo, useState } from "react";
import type { RetakeGroup } from "@scarlet/shared";
import type { MediaAsset, TimeRange, Timeline } from "@scarlet/timeline";
import { api, errorMessage } from "../../lib/client";
import { clock } from "../../lib/format";
import { cutSource, otherTakes, type OtherTake } from "./retakeLookup";

/**
 * Other attempts at the line a staged cut removes, from the engine's retake grouping of that recording.
 * Times are timeline times; a take the edit no longer plays says so. `onPlay` lets a review that can seek
 * jump to a take.
 */
export function OtherTakes({ projectId, timeline, media, range, onPlay }: {
  projectId: string; timeline: Timeline; media: MediaAsset[]; range: TimeRange; onPlay?(take: OtherTake & { at: number }): void;
}) {
  const source = useMemo(() => cutSource(timeline, media, range), [timeline, media, range.start, range.end]);
  const key = source ? JSON.stringify([projectId, source.mediaId, source.start, source.end]) : "";
  const [result, setResult] = useState<{ key: string; groups?: RetakeGroup[]; error?: string }>();
  useEffect(() => {
    if (!source) return;
    let live = true;
    api.retakes(projectId, source.mediaId, source.start, source.end).then(
      ({ groups }) => { if (live) setResult({ key, groups }); },
      err => { if (live) setResult({ key, error: errorMessage(err) }); });
    return () => { live = false; };
  }, [key]);
  const loaded = result?.key === key ? result : undefined;
  const takes = useMemo(() => source && loaded?.groups ? otherTakes(loaded.groups, source, timeline) : [], [loaded, source, timeline]);
  // Takes are context. Missing or failed grouping leaves the review as it was.
  if (!takes.length) return null;
  return <div className="other-takes" role="group" aria-label="Other takes">
    <div className="other-takes-head">Other takes · {takes.length}</div>
    <ul>
      {takes.map(take => <li key={take.start}>
        {take.at !== undefined && onPlay
          ? <button type="button" className="other-take-time" title="Play this take" onClick={() => onPlay({ ...take, at: take.at! })}>{clock(take.at)}</button>
          : <span className="other-take-time">{take.at !== undefined ? clock(take.at) : "Cut"}</span>}
        <span className="other-take-text">{take.text}</span>
      </li>)}
    </ul>
  </div>;
}
