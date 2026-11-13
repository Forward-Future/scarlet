import { useEffect, useState } from "react";
import type { CutReview } from "@scarlet/timeline";
import { api, errorMessage } from "../../lib/client";

export function useCutReview(changeId?: string) {
  const [result, setResult] = useState<{ id: string; review?: CutReview | null; error?: string }>();
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let live = true;
    if (!changeId) return;
    setResult(undefined);
    api.cutReview(changeId).then(({ review }) => { if (live) setResult({ id: changeId, review }); },
      err => { if (live) setResult({ id: changeId, error: errorMessage(err) }); });
    return () => { live = false; };
  }, [changeId, attempt]);
  return { ...(result?.id === changeId ? result : undefined), retry: () => retry(i => i + 1) };
}
