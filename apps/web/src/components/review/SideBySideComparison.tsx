import { useEffect, useState } from "react";
import { withHandles, type Change, type TimeRange } from "@scarlet/timeline";
import { api } from "../../lib/client";
import { comparisonSides } from "./ChangeClip";

/** Older proposals can have only an After render, or no saved preview windows.
 * Recover the paired windows from the actual version diff, never from raw media. */
export function useApprovalComparison(change: Change | undefined, slot: number) {
  const pair = change?.renders[slot];
  const lookup = change && !pair?.beforeRange && !(pair?.before && pair.after) ? change.id : undefined;
  const [recovered, setRecovered] = useState<{ id: string; renders: Change["renders"]; ranges: TimeRange[] }>();
  useEffect(() => {
    if (!lookup) return;
    let live = true;
    api.change(lookup).then(({ diff }) => {
      if (!live) return;
      const renders = diff.spots.map(spot => ({
        before: null, after: null,
        beforeRange: withHandles(spot.before, 1.5, diff.durationBefore),
        range: withHandles(spot.after, 1.5, diff.durationAfter),
      }));
      setRecovered({ id: lookup, renders, ranges: diff.ranges });
    }).catch(() => { /* The full proposed edit remains available. */ });
    return () => { live = false; };
  }, [lookup]);
  if (!change) return;
  if (!lookup) return comparisonSides(pair, false).canShowBefore ? change : undefined;
  if (recovered?.id !== lookup || !comparisonSides(recovered.renders[slot], false).canShowBefore) return;
  return { ...change, renders: recovered.renders, ranges: recovered.ranges };
}
