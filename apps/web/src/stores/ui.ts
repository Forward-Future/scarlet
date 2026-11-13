import { create } from "zustand";
import { clipsAt, type Timeline } from "@scarlet/timeline";
import type { AgentEffort, AgentId, EditRef } from "@scarlet/shared";

export interface Notification {
  id: number;
  title: string;
  body?: string;
  projectId?: string;
  link?: string;
  at: string;
  read: boolean;
}

export interface AgentPick {
  agent: AgentId;
  model?: string;
  /** Unset = the CLI's own default. */
  effort?: AgentEffort;
  serviceTier?: string;
}

/** Playhead context the agent panel attaches to the next instruction. */
export interface AgentContext {
  /** Source-media time when a media ID is present, or cut time otherwise. */
  mediaId?: string;
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
  /** Number shown on the thread timeline. The agent uses changeId and editIndex for identity. */
  editNumber?: number;
}

export function editTargetAt(time: number, version?: string, timeline?: Timeline | null, mediaId?: string): AgentContext {
  return { time, version, mediaId, clipIds: !mediaId && timeline ? clipsAt(timeline, time).map(c => c.clip.id) : [] };
}

/**
 * Moments the editor attached with Edit here or N. Clearing the message releases its point.
 * Cut revisions and selected transcript ranges keep their own targets.
 */
export const playheadPoints = new WeakSet<AgentContext>();

/** The moment a new edit's message is about, when its target is one time on the timeline: not a cut, an edit or a stretch of words. */
export function pointOf(context: AgentContext | "whole" | null | undefined) {
  return context && context !== "whole" && !context.changeId && context.end === undefined && !context.label ? context : undefined;
}

const AGENT_KEY = "scarlet.agent";
const RUN_TOKENS_KEY = "scarlet.runTokens";
const FIRST_EDIT_HINT_KEY = "scarlet.firstEditHint";

function loadFirstEditHint() {
  try { return localStorage.getItem(FIRST_EDIT_HINT_KEY); } catch { return null; }
}

function saveFirstEditHint(firstEditHint: string) {
  try { localStorage.setItem(FIRST_EDIT_HINT_KEY, firstEditHint); } catch { /* Keep it for this session. */ }
  return { firstEditHint };
}

export function loadAgent(defaultAgent: AgentId = "claude"): AgentPick {
  try {
    const raw = localStorage.getItem(AGENT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AgentPick> & { fast?: boolean };
      if (parsed.agent) return { agent: parsed.agent, model: parsed.model, effort: parsed.effort, serviceTier: parsed.serviceTier ?? (parsed.fast ? "fast" : undefined) };
    }
  } catch {
    /* ignore */
  }
  return { agent: defaultAgent };
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

interface UiState {
  notifications: Notification[];
  notify(n: Omit<Notification, "id" | "at" | "read">): void;

  exportStarNotice: "unseen" | "visible" | "seen";
  offerExportStar(): void;
  dismissExportStar(): void;

  /** Unset until the first project is created, then its ID until the editor uses the box. */
  firstEditHint: string | null;
  offerFirstEditHint(projectId: string): void;
  dismissFirstEditHint(): void;

  shortcutsOpen: boolean;
  setShortcutsOpen(v: boolean): void;
  settingsReturnTo: string | null;
  agentSetupOpen: boolean | "models";
  setAgentSetupOpen(v: boolean | "models"): void;

  agent: AgentPick;
  setAgent(p: AgentPick): void;

  /** Show each agent run's token count in edit threads. Off unless turned on in Settings → Usage. */
  showRunTokens: boolean;
  setShowRunTokens(v: boolean): void;

  /** Context pinned to the next agent instruction (from transcript span, note popover, etc). */
  draftOwner: string | null;
  savedDrafts: Record<string, ComposerDraft>;
  openDraft(projectId: string | null, threadId?: string): void;
  clearSentDraft(owner: string | null, sent: ComposerDraft): void;
  /** Puts a message that couldn't be sent back into the box it was sent from, unless that box has words in it again. */
  keepUnsent(owner: string | null, unsent: ComposerDraft): void;
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

  /** Bumped to focus the composer's text box (e.g. after "Ask about this span"). */
  composerFocus: number;
  focusComposer(): void;

  wsStatus: "connecting" | "open" | "closed";
  setWsStatus(s: UiState["wsStatus"]): void;
}

let seq = 1;

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
  } catch {
    return {};
  }
}

export const useUiStore = create<UiState>((set, get) => ({
  notifications: [],
  notify: (n) =>
    set({ notifications: [{ ...n, id: seq++, at: new Date().toISOString(), read: false }, ...get().notifications].slice(0, 50) }),

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

  agent: loadAgent(),
  setAgent: (agent) => {
    localStorage.setItem(AGENT_KEY, JSON.stringify(agent));
    set({ agent });
  },

  showRunTokens: localStorage.getItem(RUN_TOKENS_KEY) === "shown",
  setShowRunTokens: (v) => {
    if (v) localStorage.setItem(RUN_TOKENS_KEY, "shown");
    else localStorage.removeItem(RUN_TOKENS_KEY);
    set({ showRunTokens: v });
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
  } catch { /* Drafts stay in memory if storage is unavailable. */ }
});
