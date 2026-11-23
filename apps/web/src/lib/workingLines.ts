import { useEffect } from "react";
import { create } from "zustand";

/**
 * What each request Scarlet is working on says it is doing this moment, as its line in the chat reads (`.req-now`).
 * The chat's line is the one source: the timeline's status repeats it, so the two never disagree.
 */
export const useWorkingLines = create<Record<string, string>>(() => ({}));

/** Say what this request is doing while its line is in the chat, and nothing once it leaves. */
export function usePublishWorkingLine(taskId: string, words: string) {
  useEffect(() => {
    useWorkingLines.setState({ [taskId]: words });
  }, [taskId, words]);
  useEffect(() => () => useWorkingLines.setState(lines => {
    const { [taskId]: _gone, ...rest } = lines;
    return rest;
  }, true), [taskId]);
}
