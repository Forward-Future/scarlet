import { create } from "zustand";

export type ShortcutPresetId = "default" | "jkl";

export type ShortcutGroup = "playback" | "chat" | "review" | "project";

export type ShortcutScope = "workspace" | "chat";

export type ShortcutActionId =
  | "playPause"
  | "shuttleBack"
  | "shuttleStop"
  | "shuttleForward"
  | "stepBack"
  | "stepForward"
  | "speedUp"
  | "speedDown"
  | "chatBack"
  | "chatPause"
  | "chatForward"
  | "keep"
  | "revise"
  | "reject"
  | "compare"
  | "prevEdit"
  | "nextEdit"
  | "aimChat"
  | "voiceHold"
  | "markFrame"
  | "clearRange";

export interface ShortcutAction {
  id: ShortcutActionId;
  group: ShortcutGroup;
  what: string;
  /** Short hint shown beside the label in Settings. */
  detail?: string;
  where: string;
  scope: ShortcutScope;
  /** Chat-box shortcuts require a modifier so typing plain letters still works. */
  requiresModifier?: boolean;
}

export interface FixedShortcut {
  id: string;
  keys: string[];
  what: string;
  where: string;
  /** Shown in the ? popup table as well as Settings. */
  inModal?: boolean;
}

export const SHORTCUT_GROUPS: { id: ShortcutGroup; label: string; detail?: string }[] = [
  { id: "playback", label: "Playback", detail: "Preview & shuttle" },
  { id: "chat", label: "While typing in chat", detail: "Moves the playhead without leaving the message box" },
  { id: "review", label: "Reviewing edits", detail: "Edit & call cards" },
  { id: "project", label: "Project & timeline" },
];

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  // Playback
  { id: "playPause", group: "playback", what: "Play / pause", where: "Preview", scope: "workspace" },
  { id: "shuttleBack", group: "playback", what: "Rewind (shuttle)", detail: "Tap for −1×, −2×, −4×", where: "Preview", scope: "workspace" },
  { id: "shuttleStop", group: "playback", what: "Stop / pause shuttle", detail: "Stops playback and resets to 1×", where: "Preview", scope: "workspace" },
  { id: "shuttleForward", group: "playback", what: "Play forward (shuttle)", detail: "Tap for 1×, 2×, 4×", where: "Preview", scope: "workspace" },
  { id: "stepBack", group: "playback", what: "Back 1 second", detail: "1 frame with Shift", where: "Preview", scope: "workspace" },
  { id: "stepForward", group: "playback", what: "Forward 1 second", detail: "1 frame with Shift", where: "Preview", scope: "workspace" },
  { id: "speedUp", group: "playback", what: "Faster playback", detail: "0.5× to 2×", where: "Preview", scope: "workspace" },
  { id: "speedDown", group: "playback", what: "Slower playback", detail: "2× down to 0.5×", where: "Preview", scope: "workspace" },

  // While typing in chat
  { id: "chatBack", group: "chat", what: "Rewind while typing", where: "Chat box", scope: "chat", requiresModifier: true },
  { id: "chatPause", group: "chat", what: "Play / pause while typing", where: "Chat box", scope: "chat", requiresModifier: true },
  { id: "chatForward", group: "chat", what: "Play forward while typing", where: "Chat box", scope: "chat", requiresModifier: true },

  // Reviewing edits
  { id: "keep", group: "review", what: "Keep the edit or call on screen", where: "Edit or call card", scope: "workspace" },
  { id: "revise", group: "review", what: "Revise what is on screen", where: "Edit, call or suggestion", scope: "workspace" },
  { id: "reject", group: "review", what: "Reject the edit or call on screen", where: "Edit or call card", scope: "workspace" },
  { id: "compare", group: "review", what: "Switch between Before and After", where: "Edit comparison", scope: "workspace" },
  { id: "prevEdit", group: "review", what: "Previous edit or call", where: "Edit or call card", scope: "workspace" },
  { id: "nextEdit", group: "review", what: "Next edit or call", where: "Edit or call card", scope: "workspace" },

  // Project & timeline
  { id: "aimChat", group: "project", what: "Type a message at the playhead", where: "In a project", scope: "workspace" },
  { id: "voiceHold", group: "project", what: "Hold to talk", where: "In a project", scope: "workspace" },
  { id: "markFrame", group: "project", what: "Mark the current frame", where: "Preview", scope: "workspace" },
  { id: "clearRange", group: "project", what: "Clear the marked range (also Esc or Delete)", where: "Timeline", scope: "workspace" },
];

export const ACTION_BY_ID: Record<ShortcutActionId, ShortcutAction> = Object.fromEntries(
  SHORTCUT_ACTIONS.map(a => [a.id, a]),
) as Record<ShortcutActionId, ShortcutAction>;

export const FIXED_SHORTCUTS: FixedShortcut[] = [
  { id: "openSettings", keys: ["Mod", ","], what: "Open Settings", where: "Everywhere", inModal: true },
  { id: "selectAll", keys: ["Mod", "A"], what: "Select all projects", where: "Projects", inModal: true },
  { id: "findInSkill", keys: ["Mod", "F"], what: "Find in skill", where: "Skill Editor", inModal: true },
  { id: "clearSelection", keys: ["Esc"], what: "Clear the selection", where: "Projects", inModal: true },
  { id: "skillsMenu", keys: ["/"], what: "Choose an editing skill", where: "Start of an edit message", inModal: true },
  { id: "applySuggestion", keys: ["A"], what: "Apply the suggestion on screen", where: "Suggestion", inModal: true },
  { id: "timelineZoom", keys: ["−", "+"], what: "Zoom the timeline out / in (0 to fit)", where: "Timeline", inModal: true },
  { id: "closeCard", keys: ["Esc"], what: "Close what is on screen", where: "Edit, call or suggestion", inModal: true },
  { id: "closeOverlay", keys: ["Esc"], what: "Close a popover or leave Settings", where: "Everywhere", inModal: true },
  { id: "openHelp", keys: ["?"], what: "This list", where: "Everywhere", inModal: true },
];

/** Canonical bindings that stay locked so dialogs, skills, and standard editing never break. */
export const RESERVED_BINDINGS = new Set([
  "Escape",
  "/",
  "Enter",
  "Tab",
  "?",
  "Mod+,",
  "Mod+A",
  "Mod+C",
  "Mod+V",
  "Mod+X",
  "Mod+Z",
  "Mod+F",
]);

export type BindingMap = Record<ShortcutActionId, string | null>;

export const SHORTCUT_PRESETS: Record<ShortcutPresetId, {
  label: string;
  detail: string;
  summary: string;
  bindings: BindingMap;
}> = {
  default: {
    label: "Scarlet default",
    detail: "Keep on K · Playback speed on L / Shift L",
    summary: "Scarlet’s built-in keys: Space plays, ← and → step by 1 second, K keeps an edit, and L steps playback speed. While typing in chat, use ⌘J / ⌘K / ⌘L (Ctrl on Windows and Linux) to move the playhead without leaving the message box.",
    bindings: {
      playPause: "Space",
      shuttleBack: null,
      shuttleStop: null,
      shuttleForward: null,
      stepBack: "ArrowLeft",
      stepForward: "ArrowRight",
      speedUp: "L",
      speedDown: "Shift+L",
      chatBack: "Mod+J",
      chatPause: "Mod+K",
      chatForward: "Mod+L",
      keep: "K",
      revise: "R",
      reject: "X",
      compare: "\\",
      prevEdit: "ArrowUp",
      nextEdit: "ArrowDown",
      aimChat: "N",
      voiceHold: "V",
      markFrame: "M",
      clearRange: "Alt+X",
    },
  },
  jkl: {
    label: "Video editor (J/K/L)",
    detail: "J/K/L shuttle · Keep moves to A · Speed to [ / ]",
    summary: "J rewinds (−1×, −2×, −4×), K stops and resets speed, and L plays faster (1×, 2×, 4×). Keep moves to A so review keys sit together on the left hand (A, R, X), and playback speed moves to [ and ].",
    bindings: {
      playPause: "Space",
      shuttleBack: "J",
      shuttleStop: "K",
      shuttleForward: "L",
      stepBack: "ArrowLeft",
      stepForward: "ArrowRight",
      speedUp: "]",
      speedDown: "[",
      chatBack: "Mod+J",
      chatPause: "Mod+K",
      chatForward: "Mod+L",
      keep: "A",
      revise: "R",
      reject: "X",
      compare: "\\",
      prevEdit: "ArrowUp",
      nextEdit: "ArrowDown",
      aimChat: "N",
      voiceHold: "V",
      markFrame: "M",
      clearRange: "Alt+X",
    },
  },
};

const STORAGE_KEY = "scarlet.shortcuts.v1";

interface SavedShortcuts {
  preset: ShortcutPresetId;
  overrides: Partial<BindingMap>;
}

function loadSaved(): SavedShortcuts {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { preset: "default", overrides: {} };
    const parsed = JSON.parse(raw) as Partial<SavedShortcuts>;
    const preset: ShortcutPresetId = parsed.preset === "jkl" ? "jkl" : "default";
    const overrides: Partial<BindingMap> = {};
    if (parsed.overrides && typeof parsed.overrides === "object") {
      for (const action of SHORTCUT_ACTIONS) {
        const val = parsed.overrides[action.id];
        if (val === null || (typeof val === "string" && val.length > 0)) {
          overrides[action.id] = val;
        }
      }
    }
    return { preset, overrides };
  } catch {
    return { preset: "default", overrides: {} };
  }
}

function saveShortcuts(preset: ShortcutPresetId, overrides: Partial<BindingMap>) {
  try {
    if (preset === "default" && Object.keys(overrides).length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ preset, overrides }));
    }
  } catch { /* Keep the choice for this session. */ }
}

function resolveBindings(preset: ShortcutPresetId, overrides: Partial<BindingMap>): BindingMap {
  const base = SHORTCUT_PRESETS[preset].bindings;
  const out = { ...base };
  for (const key of Object.keys(overrides) as ShortcutActionId[]) {
    if (key in base) out[key] = overrides[key] ?? null;
  }
  return out;
}

/** True on macOS browsers and webviews. */
export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Macintosh");
}

/** Split a canonical binding into its modifier names and main key, keeping "+" intact as a key. */
function parseBinding(binding: string): { mods: string[]; main: string } {
  if (binding.endsWith("+")) return { mods: binding.slice(0, -1).split("+").filter(Boolean), main: "+" };
  const mods = binding.split("+");
  return { mods, main: mods.pop()! };
}

/** Split a canonical binding ("Mod+Shift+L") into OS-friendly keycap labels (["⌘", "⇧", "L"] or ["Ctrl", "Shift", "L"]). */
export function bindingTokens(binding: string | null | undefined, mac = isMacPlatform()): string[] {
  if (!binding) return [];
  const { mods, main } = parseBinding(binding);
  return [...mods, main].map(part => {
    if (part === "Mod") return mac ? "⌘" : "Ctrl";
    if (part === "Alt") return mac ? "⌥" : "Alt";
    if (part === "Shift") return mac ? "⇧" : "Shift";
    if (part === "ArrowLeft") return "←";
    if (part === "ArrowRight") return "→";
    if (part === "ArrowUp") return "↑";
    if (part === "ArrowDown") return "↓";
    if (part === "Escape") return "Esc";
    return part;
  });
}

/** Human-readable label for tooltips and badges (e.g. "K", "Shift L", "⌘ J", "Ctrl+J"). */
export function formatBinding(binding: string | null | undefined, mac = isMacPlatform()): string {
  if (!binding) return "";
  const tokens = bindingTokens(binding, mac);
  return tokens.join(mac ? " " : "+");
}

/** Compact single-key / short label for review pills (`data-key` and tooltip). */
export function shortKeyLabel(binding: string | null | undefined, mac = isMacPlatform()): string {
  if (!binding) return "";
  if (binding === "Shift+L" && !mac) return "Shift L";
  return bindingTokens(binding, mac).join(mac ? "" : "+");
}

/** Standard ARIA `aria-keyshortcuts` value (e.g. "K", "Shift+L", "Meta+J Control+J"). */
export function ariaKeyShortcut(binding: string | null | undefined): string | undefined {
  if (!binding) return undefined;
  if (binding.includes("Mod+")) {
    return `${binding.replace("Mod+", "Meta+")} ${binding.replace("Mod+", "Control+")}`;
  }
  return binding;
}

/** Normalize the non-modifier key of a KeyboardEvent, handling Option/Alt dead-key characters on macOS via `code`. */
function eventMainKey(e: { key: string; code?: string; altKey: boolean }): string | null {
  if (["Meta", "Control", "Shift", "Alt", "CapsLock", "Dead", "Process", "Unidentified"].includes(e.key)) return null;
  if (e.altKey && e.code) {
    if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
    if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
  }
  if (e.key === " ") return "Space";
  if (e.key.length === 1) return e.key.toUpperCase();
  return e.key;
}

const SHIFT_IMPLICIT_SYMBOLS = new Set(["?", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "+", "{", "}", "|", ":", "\"", "<", ">", "~"]);

export interface KeyEventLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Convert a KeyboardEvent into a canonical binding string, or null for modifier-only keys. */
export function eventToBinding(e: KeyEventLike): string | null {
  const main = eventMainKey(e);
  if (!main) return null;
  const mods: string[] = [];
  if (e.metaKey || e.ctrlKey) mods.push("Mod");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey && !SHIFT_IMPLICIT_SYMBOLS.has(main)) mods.push("Shift");
  return [...mods, main].join("+");
}

export interface MatchOptions {
  /** Allow Shift to be held even when the binding doesn't include Shift (e.g. ← / → + Shift for 1-frame step). */
  allowShift?: boolean;
}

/** True when `e` matches the canonical `binding`. */
export function matchesBinding(
  e: KeyEventLike,
  binding: string | null | undefined,
  options?: MatchOptions,
): boolean {
  if (!binding) return false;
  const { mods, main } = parseBinding(binding);
  const wantMod = mods.includes("Mod");
  const wantAlt = mods.includes("Alt");
  const wantShift = mods.includes("Shift");

  const hasMod = e.metaKey || e.ctrlKey;
  if (hasMod !== wantMod) return false;
  if (e.altKey !== wantAlt) return false;
  if (!options?.allowShift && !SHIFT_IMPLICIT_SYMBOLS.has(main) && e.shiftKey !== wantShift) return false;
  if (options?.allowShift && wantShift && !e.shiftKey) return false;

  const actual = eventMainKey(e);
  return actual === main;
}

/** Check whether a key event matches the active binding for `actionId`. */
export function matchesShortcut(
  e: KeyEventLike,
  actionId: ShortcutActionId,
  options?: MatchOptions,
): boolean {
  return matchesBinding(e, useShortcutsStore.getState().bindings[actionId], options);
}

/** True when a keyup event releases the main key of `actionId` (for push-to-talk hold keys like V). */
export function matchesShortcutRelease(
  e: Pick<KeyboardEvent, "key" | "code" | "altKey">,
  actionId: ShortcutActionId,
): boolean {
  const binding = useShortcutsStore.getState().bindings[actionId];
  if (!binding) return false;
  const { main } = parseBinding(binding);
  return eventMainKey(e) === main;
}

export interface BindingValidation {
  ok: boolean;
  conflictId?: ShortcutActionId;
  error?: string;
  warning?: string;
}

/** Validate assigning `binding` to `actionId` against current bindings. */
export function validateBinding(
  bindings: BindingMap,
  actionId: ShortcutActionId,
  binding: string,
  mac = isMacPlatform(),
): BindingValidation {
  const action = ACTION_BY_ID[actionId];
  if (RESERVED_BINDINGS.has(binding)) {
    return { ok: false, error: `${formatBinding(binding, mac)} is a fixed system key and can’t be reassigned.` };
  }
  if (action.requiresModifier && !binding.includes("Mod+") && !binding.includes("Alt+")) {
    return {
      ok: false,
      error: `Shortcuts used while typing need ${mac ? "⌘ or ⌥" : "Ctrl or Alt"} so plain letters still type.`,
    };
  }
  const conflict = SHORTCUT_ACTIONS.find(other =>
    other.id !== actionId &&
    other.scope === action.scope &&
    bindings[other.id] === binding,
  );
  if (conflict) {
    return {
      ok: false,
      conflictId: conflict.id,
      error: `${formatBinding(binding, mac)} is currently used by “${conflict.what}”.`,
    };
  }
  if (action.scope === "chat" && (binding === "Mod+ArrowLeft" || binding === "Mod+ArrowRight")) {
    return {
      ok: true,
      warning: mac
        ? `Saved ${formatBinding(binding, mac)}. Note: macOS normally uses ⌘ ← / ⌘ → to jump to the start or end of a line.`
        : `Saved ${formatBinding(binding, mac)}. Note: Windows and Linux normally use Ctrl+← / Ctrl+→ to jump by word.`,
    };
  }
  return { ok: true };
}

interface ShortcutsState {
  preset: ShortcutPresetId;
  overrides: Partial<BindingMap>;
  bindings: BindingMap;
  setPreset(preset: ShortcutPresetId): void;
  setBinding(id: ShortcutActionId, binding: string | null): void;
  swapBindings(id: ShortcutActionId, otherId: ShortcutActionId, newBinding: string): void;
  replaceBinding(id: ShortcutActionId, otherId: ShortcutActionId, newBinding: string): void;
  resetOne(id: ShortcutActionId): void;
  resetAll(): void;
}

function buildInitial(): Pick<ShortcutsState, "preset" | "overrides" | "bindings"> {
  const { preset, overrides } = loadSaved();
  return { preset, overrides, bindings: resolveBindings(preset, overrides) };
}

function updateOverrides(preset: ShortcutPresetId, nextOverrides: Partial<BindingMap>) {
  const base = SHORTCUT_PRESETS[preset].bindings;
  const cleaned: Partial<BindingMap> = {};
  for (const id of Object.keys(nextOverrides) as ShortcutActionId[]) {
    if (nextOverrides[id] !== base[id]) cleaned[id] = nextOverrides[id];
  }
  saveShortcuts(preset, cleaned);
  return { preset, overrides: cleaned, bindings: resolveBindings(preset, cleaned) };
}

export const useShortcutsStore = create<ShortcutsState>((set, get) => ({
  ...buildInitial(),
  setPreset: (preset) => {
    saveShortcuts(preset, {});
    set({ preset, overrides: {}, bindings: resolveBindings(preset, {}) });
  },
  setBinding: (id, binding) => {
    const { preset, overrides } = get();
    set(updateOverrides(preset, { ...overrides, [id]: binding }));
  },
  swapBindings: (id, otherId, newBinding) => {
    const { preset, overrides, bindings } = get();
    const prev = bindings[id];
    set(updateOverrides(preset, { ...overrides, [id]: newBinding, [otherId]: prev }));
  },
  replaceBinding: (id, otherId, newBinding) => {
    const { preset, overrides } = get();
    set(updateOverrides(preset, { ...overrides, [id]: newBinding, [otherId]: null }));
  },
  resetOne: (id) => {
    const { preset, overrides, bindings } = get();
    const base = SHORTCUT_PRESETS[preset].bindings;
    const restored = base[id];
    const next = { ...overrides };
    delete next[id];
    if (restored) {
      const action = ACTION_BY_ID[id];
      const conflict = SHORTCUT_ACTIONS.find(other =>
        other.id !== id && other.scope === action.scope && bindings[other.id] === restored,
      );
      if (conflict) {
        // If resetting undoes a swap back to the other action's default, restore it cleanly; otherwise unbind it so no duplicate exists.
        next[conflict.id] = bindings[id] === base[conflict.id] ? base[conflict.id] : null;
      }
    }
    set(updateOverrides(preset, next));
  },
  resetAll: () => {
    const { preset } = get();
    saveShortcuts(preset, {});
    set({ overrides: {}, bindings: resolveBindings(preset, {}) });
  },
}));

/** Reset the store cleanly in tests (also clears persisted localStorage). */
export function resetShortcutsStore() {
  saveShortcuts("default", {});
  useShortcutsStore.setState({ preset: "default", overrides: {}, bindings: resolveBindings("default", {}) });
}
