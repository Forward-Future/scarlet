import { create } from "zustand";
import { clipsAt, type Timeline } from "@scarlet/timeline";
import { AgentId, type EditRef } from "@scarlet/shared";
import { desktop, isDesktop, type AgentPick } from "../lib/desktop";
import { appLog, errorName } from "../lib/appLog";

/** Playhead context the agent panel attaches to the next instruction. */
export interface AgentContext {
  /** Source-media time when a media ID is present, or cut time otherwise. */
  mediaId?: string;
  /** A point attached by a timestamp in the draft. It follows the words until they change or are removed. */
  fromMessage?: boolean;
  version?: string;
  time: number;
  end?: number;
  clipIds: string[];
  label?: string;
  changeId?: string;
  cutIndex?: number;
  editIndex?: number;
  /** Original edit represented by this review row. Local to the renderer, including saved drafts. */
  reviewRef?: EditRef;
  /** The other edits of the moment the message is about, when the editor was on a moment of the list and not one edit. */
  momentEdits?: { changeId: string; spot: number; label?: string }[];
  /**
   * A stretch the editor marked on the timeline's ruler for this message, on the version the timeline showed. It rides
   * along with whatever the message is aimed at: a cut or an edit keeps its own time, and Scarlet is told both.
   */
  markedRange?: MarkedRange;
}

export interface MarkedRange { start: number; end: number; version?: string; mediaId?: string; clipIds?: string[] }

/** The stretch marked on the ruler that the message in the box carries. */
export function markedRangeOf(context: AgentContext | "whole" | null | undefined) {
  return context && context !== "whole" ? context.markedRange : undefined;
}

/** A message about a marked stretch and nothing else: a new edit there. */
function rangeTarget(marked: MarkedRange): AgentContext {
  return { time: marked.start, end: marked.end, version: marked.version, mediaId: marked.mediaId, clipIds: marked.clipIds ?? [], markedRange: marked };
}

/** The same aim with the marked stretch put on it, or taken off. Nothing is left of an aim that was only the stretch. */
export function withMarkedRange(context: AgentContext | "whole" | null | undefined, marked: MarkedRange | undefined): AgentContext | null {
  const target = context && context !== "whole" ? context : undefined;
  // Words chosen in the transcript or a moment picked on the timeline give way to the stretch: it says where, as they did.
  if (!target?.changeId) return marked ? rangeTarget(marked) : null;
  const { markedRange: _was, ...rest } = target;
  return marked ? { ...rest, markedRange: marked } : rest;
}

export function editTargetAt(time: number, version?: string, timeline?: Timeline | null, mediaId?: string): AgentContext {
  return { time, version, mediaId, clipIds: !mediaId && timeline ? clipsAt(timeline, time).map(c => c.clip.id) : [] };
}

/**
 * Moments the editor attached with Edit here or N. Clearing the message releases its point.
 * Cut revisions and selected transcript ranges keep their own targets.
 */
export const playheadPoints = new WeakSet<AgentContext>();

/**
 * Words put into a message where the cursor is: a time picked on the timeline. `replaces`, when it is still in the
 * message, is what the new words take the place of (a marked stretch whose end moved); empty words take it out.
 */
export function spliceDraft(draft: string, at: number, text: string, replaces?: string): { text: string; caret: number } {
  const old = replaces ? draft.indexOf(replaces) : -1;
  if (old >= 0) {
    if (text) return { text: draft.slice(0, old) + text + draft.slice(old + replaces!.length), caret: old + text.length };
    // Taken out, with one of the spaces it stood between.
    const before = draft.slice(0, old), after = draft.slice(old + replaces!.length);
    const joined = before.endsWith(" ") && (after.startsWith(" ") || !after) ? before.slice(0, -1) + after : before + after;
    return { text: joined, caret: Math.min(old, joined.length) };
  }
  if (!text) return { text: draft, caret: Math.min(at, draft.length) };
  const pos = Math.max(0, Math.min(at, draft.length));
  const before = draft.slice(0, pos), after = draft.slice(pos);
  const lead = before && !/\s$/.test(before) ? " " : "", tail = /^\s/.test(after) ? "" : " ";
  return { text: before + lead + text + tail + after, caret: before.length + lead.length + text.length + 1 };
}
/** The message box on the page, which knows where its cursor is. With none, the words go at the message's end. */
export const draftInserter: { insert?: (text: string, replaces?: string) => void } = {};
export function insertInDraft(text: string, replaces?: string) {
  if (draftInserter.insert) return draftInserter.insert(text, replaces);
  const box = useUiStore.getState();
  box.setAgentDraft(spliceDraft(box.agentDraft, box.agentDraft.length, text, replaces).text);
}

/** The moment a new edit's message is about, when its target is one time on the timeline: not a cut, an edit or a stretch of words. */
export function pointOf(context: AgentContext | "whole" | null | undefined) {
  return context && context !== "whole" && !context.changeId && context.end === undefined && !context.label ? context : undefined;
}

const AGENT_KEY = "scarlet.agent";
const RUN_TOKENS_KEY = "scarlet.runTokens";
const NEW_LAYOUT_KEY = "scarlet.newLayout";
const REVIEW_DICTATION_KEY = "scarlet.reviewDictation";
const FIRST_EDIT_HINT_KEY = "scarlet.firstEditHint";
const SIGN_IN_LATER_KEY = "scarlet.signInLater";

function loadFirstEditHint() {
  try { return localStorage.getItem(FIRST_EDIT_HINT_KEY); } catch { return null; }
}

function saveFirstEditHint(firstEditHint: string) {
  try { localStorage.setItem(FIRST_EDIT_HINT_KEY, firstEditHint); } catch { /* Keep it for this session. */ }
  return { firstEditHint };
}

function readSavedAgent(): AgentPick | undefined {
  try {
    const raw = localStorage.getItem(AGENT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AgentPick> & { fast?: boolean };
      const agent = AgentId.safeParse(parsed?.agent);
      if (agent.success) return {
        agent: agent.data,
        model: typeof parsed.model === "string" ? parsed.model : undefined,
        effort: typeof parsed.effort === "string" ? parsed.effort : undefined,
        serviceTier: typeof parsed.serviceTier === "string" ? parsed.serviceTier : parsed.fast === true ? "fast" : undefined,
      };
    }
  } catch { /* The native preference can still be loaded. */ }
}

let editorModelWrite = Promise.resolve();
function saveAgent(agent: AgentPick) {
  try { localStorage.setItem(AGENT_KEY, JSON.stringify(agent)); } catch { /* The native write can still succeed. */ }
  if (isDesktop()) {
    // An earlier click must finish saving before the next one can replace it.
    editorModelWrite = editorModelWrite.then(() => desktop.saveEditorModel(agent)).catch(() => undefined);
  }
}

export function restoreAgentSelection(native: AgentPick | null | undefined) {
  if (native) useUiStore.setState({ agent: native, agentSelected: true });
  else {
    const previous = readSavedAgent();
    if (previous) useUiStore.getState().setAgent(previous);
  }
}

interface ComposerDraft {
  agentDraft: string;
  agentContext: AgentContext | "whole" | null;
}

/** A target the page re-aimed, and the target it took the place of. A message sent with the earlier one is still about it. */
const reaimed = new WeakMap<AgentContext, AgentContext>();
function sameTarget(now: ComposerDraft["agentContext"], sent: ComposerDraft["agentContext"]) {
  for (let target = now; ;) {
    if (target === sent) return true;
    const earlier = target && target !== "whole" ? reaimed.get(target) : undefined;
    if (!earlier) return false;
    target = earlier;
  }
}

export interface ExportNotice {
  path: string;
  format: "mp4" | "otio" | "srt" | "vtt" | "folder";
}

interface UiState {
  exportNotice: ExportNotice | null;
  showExportNotice(notice: ExportNotice): void;
  dismissExportNotice(): void;

  exportStarNotice: "unseen" | "visible" | "seen";
  offerExportStar(): void;
  dismissExportStar(): void;

  /** Unset until the first project is created, then its ID until the editor uses the box. */
  firstEditHint: string | null;
  /** The editor chose to look around before signing in, so the first screen is the library, not sign-in. */
  signInLater: boolean;
  setSignInLater(later: boolean): void;
  offerFirstEditHint(projectId: string): void;
  dismissFirstEditHint(): void;

  shortcutsOpen: boolean;
  setShortcutsOpen(v: boolean): void;
  settingsReturnTo: string | null;
  agentSetupOpen: boolean | "models";
  setAgentSetupOpen(v: boolean | "models"): void;

  agent: AgentPick;
  agentSelected: boolean;
  setAgent(p: AgentPick): void;
  setDefaultAgent(agent: AgentId): void;

  /** Show each agent run's token count in edit threads. Off unless turned on in Settings → Usage. */
  showRunTokens: boolean;
  setShowRunTokens(v: boolean): void;

  /** Try the new three-column workspace layout (Beta). Off by default unless turned on in Settings → General. */
  newLayout: boolean;
  setNewLayout(v: boolean): void;

  /**
   * What was said into the mic waits in the message box to be read and sent, instead of going at once. On unless
   * turned off in Settings → General.
   */
  reviewDictation: boolean;
  setReviewDictation(v: boolean): void;

  /** Context pinned to the next agent instruction (from transcript span, note popover, etc). */
  draftOwner: string | null;
  savedDrafts: Record<string, ComposerDraft>;
  openDraft(projectId: string | null, threadId?: string): void;
  clearSentDraft(owner: string | null, sent: ComposerDraft): void;
  /** Puts a message that couldn't be sent back into the box it was sent from, unless that box has words in it again. */
  keepUnsent(owner: string | null, unsent: ComposerDraft): void;
  /**
   * Puts words said into the mic at the end of the message being written in the box they were said into, aimed where
   * the box was when the mic opened, to be read and sent. Says whether that box is the one on the page.
   */
  dictate(owner: string | null, text: string, aim: ComposerDraft["agentContext"]): boolean;
  agentContext: ComposerDraft["agentContext"];
  /** `was` is the target this one takes the place of when the page re-aims it at the same thing, as when a staged cut moves. */
  setAgentContext(c: AgentContext | "whole" | null, was?: AgentContext): void;
  /** Prefill for the agent text box. */
  agentDraft: string;
  setAgentDraft(s: string): void;

  projectSettingsOpen: boolean;
  setProjectSettingsOpen(v: boolean): void;

  notePopover: { open: boolean; time: number; end?: number } | null;
  openNotePopover(time: number, end?: number): void;
  closeNotePopover(): void;

  /** True while the user holds V (push-to-talk). The agent panel's mic follows it. */
  voiceHold: boolean;
  setVoiceHold(v: boolean): void;
  /** A spoken message is in the message box: being recorded, written down or sent. Like typed words, it keeps the box aimed where it was. */
  speaking: boolean;
  setSpeaking(v: boolean): void;
  /** The message box's edit-point icon is open or hovered: the timeline lights what the message is about. */
  aimLit: boolean;
  setAimLit(v: boolean): void;

  /** Bumped to focus the composer's text box (e.g. after "Ask about this span"). */
  composerFocus: number;
  focusComposer(): void;

  wsStatus: "connecting" | "open" | "closed";
  setWsStatus(s: UiState["wsStatus"]): void;
}

const DRAFTS_KEY = "scarlet.drafts.v1";

/** A draft as kept on this computer. Which targets came from the playhead is only known in memory, so it is saved beside them. */
interface SavedDraft extends ComposerDraft {
  playheadPoint?: true;
}

function savedDraft(draft: ComposerDraft): SavedDraft {
  const { agentContext } = draft;
  return agentContext && agentContext !== "whole" && playheadPoints.has(agentContext) ? { ...draft, playheadPoint: true } : draft;
}

/** Messages being written when Scarlet last closed, by project and thread. */
function loadDrafts(): Record<string, ComposerDraft> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved as Record<string, Partial<SavedDraft>>).flatMap(([owner, draft]) => {
      if (!draft || typeof draft.agentDraft !== "string") return [];
      const agentContext = draft.agentContext ?? null;
      // A point the box took from the playhead is still that after a restart: it goes once the box is emptied.
      if (draft.playheadPoint && agentContext && agentContext !== "whole") playheadPoints.add(agentContext);
      return [[owner, { agentDraft: draft.agentDraft, agentContext }]];
    }));
  } catch (error) {
    // Unreadable drafts are dropped: the messages being written when Scarlet last closed are gone, and the log says so.
    appLog("error", "drafts-unreadable", { name: errorName(error) }, { level: "warn" });
    return {};
  }
}

export const useUiStore = create<UiState>((set, get) => ({
  exportNotice: null,
  showExportNotice: (exportNotice) => set({ exportNotice }),
  dismissExportNotice: () => set({ exportNotice: null }),

  exportStarNotice: "unseen",
  offerExportStar: () => {
    if (get().exportStarNotice !== "unseen") return;
    const key = "scarlet.exportStarShown";
    try {
      if (localStorage.getItem(key)) {
        set({ exportStarNotice: "seen" });
        return;
      }
      localStorage.setItem(key, "1");
    } catch { /* Keep the one-time invitation scoped to this session if storage is unavailable. */ }
    set({ exportStarNotice: "visible" });
  },
  dismissExportStar: () => set({ exportStarNotice: "seen" }),

  signInLater: (() => { try { return localStorage.getItem(SIGN_IN_LATER_KEY) === "1"; } catch { return false; } })(),
  setSignInLater: later => {
    try { if (later) localStorage.setItem(SIGN_IN_LATER_KEY, "1"); else localStorage.removeItem(SIGN_IN_LATER_KEY); } catch { /* Keep it for this session. */ }
    set({ signInLater: later });
  },
  firstEditHint: loadFirstEditHint(),
  offerFirstEditHint: projectId => {
    if (get().firstEditHint === null) set(saveFirstEditHint(projectId));
  },
  dismissFirstEditHint: () => {
    if (get().firstEditHint !== "dismissed") set(saveFirstEditHint("dismissed"));
  },

  shortcutsOpen: false,
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  settingsReturnTo: null,
  agentSetupOpen: false,
  setAgentSetupOpen: (agentSetupOpen) => set({ agentSetupOpen }),

  agent: { agent: "claude" },
  agentSelected: false,
  setAgent: (agent) => {
    set({ agent, agentSelected: true });
    // Which model the next request goes to: a model's name, never anything typed in the box.
    appLog("action", "model", { agent: agent.agent, model: agent.model?.slice(0, 80), effort: agent.effort, tier: agent.serviceTier }, { key: "model" });
    saveAgent(agent);
  },
  setDefaultAgent: (agent) => {
    if (!get().agentSelected && get().agent.agent !== agent) set({ agent: { agent } });
  },

  showRunTokens: (() => { try { return localStorage.getItem(RUN_TOKENS_KEY) !== "hidden"; } catch { return true; } })(),
  setShowRunTokens: (v) => {
    try {
      if (v) localStorage.removeItem(RUN_TOKENS_KEY);
      else localStorage.setItem(RUN_TOKENS_KEY, "hidden");
    } catch { /* Keep the choice for this session. */ }
    set({ showRunTokens: v });
  },

  newLayout: (() => { try { return localStorage.getItem(NEW_LAYOUT_KEY) === "1"; } catch { return false; } })(),
  setNewLayout: (v) => {
    try {
      if (v) localStorage.setItem(NEW_LAYOUT_KEY, "1");
      else localStorage.removeItem(NEW_LAYOUT_KEY);
    } catch { /* Keep the choice for this session. */ }
    set({ newLayout: v });
  },

  reviewDictation: (() => { try { return localStorage.getItem(REVIEW_DICTATION_KEY) !== "off"; } catch { return true; } })(),
  setReviewDictation: (v) => {
    try {
      if (v) localStorage.removeItem(REVIEW_DICTATION_KEY);
      else localStorage.setItem(REVIEW_DICTATION_KEY, "off");
    } catch { /* Keep the choice for this session. */ }
    set({ reviewDictation: v });
  },

  draftOwner: null,
  savedDrafts: loadDrafts(),
  openDraft: (projectId, threadId) => {
    const state = get();
    const owner = projectId ? JSON.stringify([projectId, threadId ?? null]) : null;
    if (state.draftOwner === owner) return;
    const savedDrafts = { ...state.savedDrafts };
    if (state.draftOwner && (state.agentDraft || state.agentContext)) {
      savedDrafts[state.draftOwner] = { agentDraft: state.agentDraft, agentContext: state.agentContext };
    }
    const restored = owner ? savedDrafts[owner] : undefined;
    if (owner) delete savedDrafts[owner];
    set({ draftOwner: owner, savedDrafts, agentDraft: restored?.agentDraft ?? "", agentContext: restored?.agentContext ?? null });
  },
  clearSentDraft: (owner, sent) => {
    const state = get();
    const current = state.draftOwner === owner;
    const draft = current ? state : owner && state.savedDrafts[owner];
    if (!draft) return;
    // Text typed since the message went out is the next message. It stays, aimed where it is. The box still showed the
    // message while it was on its way, so what was typed after it is only the part past it: left in, the message would
    // go out a second time with the next one.
    if (draft.agentDraft !== sent.agentDraft) {
      if (!sent.agentDraft || !draft.agentDraft.startsWith(sent.agentDraft)) return;
      const rest = draft.agentDraft.slice(sent.agentDraft.length).trimStart();
      if (rest) {
        if (current) set({ agentDraft: rest });
        else if (owner) set({ savedDrafts: { ...state.savedDrafts, [owner]: { ...draft, agentDraft: rest } } });
        return;
      }
    }
    // The message's target goes with it. A target the box was aimed at since stays for the next one.
    const agentContext = sameTarget(draft.agentContext, sent.agentContext) ? null : draft.agentContext;
    if (current) set({ agentDraft: "", agentContext });
    else if (owner) {
      const savedDrafts = { ...state.savedDrafts };
      if (agentContext) savedDrafts[owner] = { agentDraft: "", agentContext };
      else delete savedDrafts[owner];
      set({ savedDrafts });
    }
  },
  keepUnsent: (owner, unsent) => {
    const state = get();
    const current = state.draftOwner === owner;
    const existing = current ? state : owner ? state.savedDrafts[owner] : undefined;
    if (existing?.agentDraft) return;
    // Restore the recording's target, including a newer version of the same cut Scarlet re-aimed while transcribing.
    const recovered = existing && sameTarget(existing.agentContext, unsent.agentContext)
      ? { ...unsent, agentContext: existing.agentContext } : unsent;
    if (current) set(recovered);
    else if (owner) set({ savedDrafts: { ...state.savedDrafts, [owner]: recovered } });
  },
  dictate: (owner, text, aim) => {
    const state = get();
    const current = state.draftOwner === owner;
    const existing = current ? state : owner ? state.savedDrafts[owner] : undefined;
    const words = existing?.agentDraft ?? "";
    // Words typed while the mic was open stay first, and what was said follows them.
    const agentDraft = words.trim() ? `${words.replace(/\s+$/, "")} ${text}` : text;
    // The box stays aimed where it is when words were typed meanwhile or it is the recording's target re-aimed (a newer
    // version of the same cut); otherwise it goes back to where the recording was aimed.
    const kept = existing?.agentContext ?? null;
    const agentContext = aim === null || words.trim() || sameTarget(kept, aim) ? kept ?? aim : aim;
    if (current) set({ agentDraft, agentContext });
    else if (owner) set({ savedDrafts: { ...state.savedDrafts, [owner]: { agentDraft, agentContext } } });
    return current;
  },
  agentContext: null,
  setAgentContext: (agentContext, was) => {
    if (was && agentContext && agentContext !== "whole") reaimed.set(agentContext, was);
    set({ agentContext });
  },
  agentDraft: "",
  setAgentDraft: (agentDraft) => set({ agentDraft }),

  projectSettingsOpen: false,
  setProjectSettingsOpen: (projectSettingsOpen) => set({ projectSettingsOpen }),

  notePopover: null,
  openNotePopover: (time, end) => set({ notePopover: { open: true, time, end } }),
  closeNotePopover: () => set({ notePopover: null }),

  voiceHold: false,
  setVoiceHold: (voiceHold) => set({ voiceHold }),
  speaking: false,
  setSpeaking: (speaking) => { if (get().speaking !== speaking) set({ speaking }); },
  aimLit: false,
  setAimLit: (aimLit) => { if (get().aimLit !== aimLit) set({ aimLit }); },

  composerFocus: 0,
  focusComposer: () => set({ composerFocus: get().composerFocus + 1 }),

  wsStatus: "closed",
  setWsStatus: (wsStatus) => set({ wsStatus }),
}));

// A message being written survives a quit: every unsent draft is kept on this computer until it is sent or cleared.
useUiStore.subscribe((state, previous) => {
  if (state.agentDraft === previous.agentDraft && state.agentContext === previous.agentContext &&
      state.savedDrafts === previous.savedDrafts && state.draftOwner === previous.draftOwner) return;
  const drafts: Record<string, SavedDraft> = Object.fromEntries(Object.entries(state.savedDrafts).map(([owner, draft]) => [owner, savedDraft(draft)]));
  if (state.draftOwner && (state.agentDraft || state.agentContext)) {
    drafts[state.draftOwner] = savedDraft({ agentDraft: state.agentDraft, agentContext: state.agentContext });
  }
  try {
    if (Object.keys(drafts).length) localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
    else localStorage.removeItem(DRAFTS_KEY);
  } catch (error) {
    // Drafts stay in memory if storage is unavailable, and would then be lost with a quit: the log says so, once.
    if (!draftsUnsaved) appLog("error", "drafts-not-saved", { name: errorName(error), drafts: Object.keys(drafts).length }, { level: "warn" });
    draftsUnsaved = true;
    return;
  }
  draftsUnsaved = false;
});
let draftsUnsaved = false;
