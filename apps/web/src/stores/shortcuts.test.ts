// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  bindingTokens,
  eventToBinding,
  formatBinding,
  matchesBinding,
  matchesShortcut,
  matchesShortcutRelease,
  resetShortcutsStore,
  SHORTCUT_PRESETS,
  useShortcutsStore,
  validateBinding,
} from "./shortcuts";

beforeEach(() => {
  localStorage.clear();
  resetShortcutsStore();
});

afterEach(() => {
  localStorage.clear();
  resetShortcutsStore();
});

it("defaults to Scarlet default preset and switches cleanly to Video editor (J/K/L)", () => {
  const s = useShortcutsStore.getState();
  expect(s.preset).toBe("default");
  expect(s.bindings.keep).toBe("K");
  expect(s.bindings.speedUp).toBe("L");
  expect(s.bindings.speedDown).toBe("Shift+L");
  expect(s.bindings.shuttleBack).toBeNull();
  expect(s.bindings.chatBack).toBe("Mod+J");
  expect(s.bindings.chatPause).toBe("Mod+K");
  expect(s.bindings.chatForward).toBe("Mod+L");

  s.setPreset("jkl");
  const jkl = useShortcutsStore.getState();
  expect(jkl.preset).toBe("jkl");
  expect(jkl.bindings.shuttleBack).toBe("J");
  expect(jkl.bindings.shuttleStop).toBe("K");
  expect(jkl.bindings.shuttleForward).toBe("L");
  expect(jkl.bindings.keep).toBe("A");
  expect(jkl.bindings.speedUp).toBe("]");
  expect(jkl.bindings.speedDown).toBe("[");
  expect(JSON.parse(localStorage.getItem("scarlet.shortcuts.v1")!)).toEqual({ preset: "jkl", overrides: {} });
});

it("detects conflicts within the same scope, blocks reserved keys, and requires modifiers in chat", () => {
  const { bindings } = useShortcutsStore.getState();

  // Conflict in workspace scope: K is used by Keep.
  const conflict = validateBinding(bindings, "shuttleStop", "K", true);
  expect(conflict.ok).toBe(false);
  expect(conflict.conflictId).toBe("keep");

  // Reserved system keys stay locked.
  for (const reserved of ["Escape", "/", "Enter", "Tab", "?", "Mod+,", "Mod+Z"]) {
    const res = validateBinding(bindings, "keep", reserved, true);
    expect(res.ok).toBe(false);
    expect(res.conflictId).toBeUndefined();
  }

  // Chat shortcuts require a modifier so typing stays untouched.
  const plainChat = validateBinding(bindings, "chatBack", "J", true);
  expect(plainChat.ok).toBe(false);
  expect(plainChat.error).toMatch(/⌘ or ⌥/);

  // Binding Cmd+ArrowLeft in chat is allowed with an OS heads-up warning.
  const arrowChat = validateBinding(bindings, "chatBack", "Mod+ArrowLeft", true);
  expect(arrowChat.ok).toBe(true);
  expect(arrowChat.warning).toMatch(/start or end of a line/);
});

it("supports swapping, replacing, single-row reset, and resetting all overrides", () => {
  const store = useShortcutsStore.getState();
  store.swapBindings("revise", "reject", "X");
  expect(useShortcutsStore.getState().bindings.revise).toBe("X");
  expect(useShortcutsStore.getState().bindings.reject).toBe("R");
  expect(Object.keys(useShortcutsStore.getState().overrides).sort()).toEqual(["reject", "revise"]);

  store.resetOne("revise");
  expect(useShortcutsStore.getState().bindings.revise).toBe(SHORTCUT_PRESETS.default.bindings.revise);
  expect(useShortcutsStore.getState().bindings.reject).toBe("X");

  // Rebinding a single key and resetting it leaves other bindings untouched.
  store.setBinding("revise", "Q");
  expect(useShortcutsStore.getState().bindings.revise).toBe("Q");
  store.resetOne("revise");
  expect(useShortcutsStore.getState().bindings.revise).toBe("R");

  store.replaceBinding("shuttleStop", "keep", "K");
  expect(useShortcutsStore.getState().bindings.shuttleStop).toBe("K");
  expect(useShortcutsStore.getState().bindings.keep).toBeNull();

  store.resetAll();
  expect(useShortcutsStore.getState().overrides).toEqual({});
  expect(useShortcutsStore.getState().bindings).toEqual(SHORTCUT_PRESETS.default.bindings);
});

it("normalizes keyboard events including macOS Option+X and matches bindings accurately", () => {
  expect(eventToBinding({ key: " ", code: "Space", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })).toBe("Space");
  expect(eventToBinding({ key: "j", code: "KeyJ", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBe("Mod+J");
  expect(eventToBinding({ key: "≈", code: "KeyX", metaKey: false, ctrlKey: false, altKey: true, shiftKey: false })).toBe("Alt+X");
  expect(eventToBinding({ key: "L", code: "KeyL", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true })).toBe("Shift+L");
  expect(eventToBinding({ key: "Meta", code: "MetaLeft", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBeNull();

  expect(matchesBinding({ key: "≈", code: "KeyX", metaKey: false, ctrlKey: false, altKey: true, shiftKey: false }, "Alt+X")).toBe(true);
  expect(matchesBinding({ key: "ArrowLeft", code: "ArrowLeft", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true }, "ArrowLeft", { allowShift: true })).toBe(true);
  expect(matchesBinding({ key: "ArrowLeft", code: "ArrowLeft", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true }, "ArrowLeft")).toBe(false);
  expect(matchesShortcut({ key: "j", code: "KeyJ", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, "chatBack")).toBe(true);

  expect(bindingTokens("Mod+Shift+L", true)).toEqual(["⌘", "⇧", "L"]);
  expect(bindingTokens("Mod+Shift+L", false)).toEqual(["Ctrl", "Shift", "L"]);
  expect(formatBinding("Alt+X", true)).toBe("⌥ X");
  expect(formatBinding("Alt+X", false)).toBe("Alt+X");
});

it("handles shortcuts bound to + with and without modifiers", () => {
  expect(eventToBinding({ key: "+", code: "Equal", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true })).toBe("+");
  expect(eventToBinding({ key: "+", code: "Equal", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true })).toBe("Mod++");
  expect(eventToBinding({ key: "+", code: "Equal", metaKey: false, ctrlKey: false, altKey: true, shiftKey: true })).toBe("Alt++");

  expect(bindingTokens("+", true)).toEqual(["+"]);
  expect(bindingTokens("Mod++", true)).toEqual(["⌘", "+"]);
  expect(bindingTokens("Alt++", true)).toEqual(["⌥", "+"]);
  expect(bindingTokens("Mod++", false)).toEqual(["Ctrl", "+"]);
  expect(bindingTokens("Alt++", false)).toEqual(["Alt", "+"]);

  expect(matchesBinding({ key: "+", code: "Equal", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true }, "+")).toBe(true);
  expect(matchesBinding({ key: "=", code: "Equal", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }, "+")).toBe(false);
  expect(matchesBinding({ key: "+", code: "Equal", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }, "Mod++")).toBe(true);
  expect(matchesBinding({ key: "=", code: "Equal", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, "Mod++")).toBe(false);
  expect(matchesBinding({ key: "+", code: "Equal", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true }, "Mod++")).toBe(false);
  expect(matchesBinding({ key: "+", code: "Equal", metaKey: false, ctrlKey: false, altKey: true, shiftKey: true }, "Alt++")).toBe(true);
  expect(matchesBinding({ key: "=", code: "Equal", metaKey: false, ctrlKey: false, altKey: true, shiftKey: false }, "Alt++")).toBe(false);

  useShortcutsStore.getState().setBinding("voiceHold", "+");
  expect(matchesShortcutRelease({ key: "+", code: "Equal", altKey: false }, "voiceHold")).toBe(true);
  expect(matchesShortcutRelease({ key: "=", code: "Equal", altKey: false }, "voiceHold")).toBe(false);

  useShortcutsStore.getState().setBinding("voiceHold", "Mod++");
  expect(matchesShortcutRelease({ key: "+", code: "Equal", altKey: false }, "voiceHold")).toBe(true);
  expect(matchesShortcutRelease({ key: "=", code: "Equal", altKey: false }, "voiceHold")).toBe(false);
});
