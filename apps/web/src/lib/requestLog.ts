/**
 * What became of each message the editor wrote, in the app log under `[request]`: the draft starting and emptying,
 * every press of send and what it did (sent, ignored and why, refused, failed), and the request the engine made of
 * it. A message that "went nowhere" can then be told apart from one that was never sent, one Enter ignored, and one
 * that went to another request than the editor thought. Never the words: only their length, the ids and the kind.
 * The desktop app also copies these lines into the log every copy of Scarlet shares, so a message typed in a test
 * or review copy can be found from the regular one.
 */
import { appLog, errorName, withoutAddresses, type LogFields, type LogLevel } from "./appLog";

/** The part of the box's store the draft lines read. */
interface DraftState { agentDraft: string; draftOwner: string | null; savedDrafts: Record<string, { agentDraft: string }> }
interface DraftStore { getState(): DraftState; subscribe(listener: (state: DraftState, previous: DraftState) => void): () => void }

export const REQUEST_TAG = "request";

export function requestLog(event: string, fields?: LogFields, level: LogLevel = "info") {
  appLog(REQUEST_TAG, event, fields, { level });
}

/** A failure as its kind and the first words of what it said, without addresses or anything typed. */
export function failure(error: unknown) {
  const said = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const flat = withoutAddresses(said).replace(/\s+/g, " ").trim();
  return { name: errorName(error), error: flat ? (flat.length > 120 ? `${flat.slice(0, 119)}…` : flat) : undefined };
}

/** The project and request a box's draft belongs to, from its owner key (`[projectId, threadId]`). */
export function ownerFields(owner: string | null | undefined) {
  if (!owner) return {};
  try {
    const [project, thread] = JSON.parse(owner) as [unknown, unknown];
    return { project: typeof project === "string" ? project : undefined, thread: typeof thread === "string" ? thread : undefined };
  } catch { return {}; }
}

/** What a box's tag aimed the message at, by kind: never its words. */
export function aimKind(aim: { changeId?: string; mediaId?: string; markedRange?: unknown; end?: number; fromMessage?: boolean } | null | undefined) {
  if (!aim) return "whole";
  if (aim.changeId) return "edit";
  if (aim.markedRange || aim.end !== undefined) return "range";
  if (aim.mediaId) return "source";
  return aim.fromMessage ? "typed-time" : "point";
}

let undo: (() => void) | undefined;

/**
 * The draft as the editor writes it: one line when a box gets its first words, and one when it empties, with how
 * long it was and whether a send was under way. A draft still in the box as the window closes says so, since it is
 * kept for the next start rather than sent.
 */
export function startRequestLog(store: DraftStore) {
  stopRequestLog();
  const unsubscribe = store.subscribe((state, previous) => {
    const owner = state.draftOwner, before = previous.draftOwner;
    if (owner !== before) {
      if (previous.agentDraft) requestLog("draft-put-aside", { chars: previous.agentDraft.length, ...ownerFields(before) });
      if (state.agentDraft) requestLog("draft-restored", { chars: state.agentDraft.length, ...ownerFields(owner) });
      return;
    }
    if (state.agentDraft === previous.agentDraft) return;
    if (!previous.agentDraft && state.agentDraft) requestLog("draft-started", { chars: state.agentDraft.length, ...ownerFields(owner) });
    else if (previous.agentDraft && !state.agentDraft) requestLog("draft-emptied", { chars: previous.agentDraft.length, ...ownerFields(owner) });
  });
  const onHide = () => {
    const { agentDraft, draftOwner, savedDrafts } = store.getState();
    const kept = Object.values(savedDrafts).filter(d => d.agentDraft).length;
    if (agentDraft || kept) requestLog("draft-unsent-at-close", { chars: agentDraft.length || undefined, ...ownerFields(draftOwner), otherDrafts: kept || undefined });
  };
  window.addEventListener("pagehide", onHide, true);
  undo = () => { unsubscribe(); window.removeEventListener("pagehide", onHide, true); };
}

export function stopRequestLog() {
  undo?.();
  undo = undefined;
}
