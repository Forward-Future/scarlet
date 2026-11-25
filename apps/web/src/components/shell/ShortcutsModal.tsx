import { useEffect } from "react";
import { useInRouterContext, useNavigate } from "react-router-dom";
import { usePlayerStore, type SpeedUpRate } from "../../stores/player";
import {
  bindingTokens,
  isMacPlatform,
  useShortcutsStore,
  type BindingMap,
  type ShortcutActionId,
} from "../../stores/shortcuts";
import { useUiStore } from "../../stores/ui";
import { Kbd, Modal } from "../ui/primitives";

interface ModalRow {
  key: string;
  tokens: string[];
  what: string;
  where: string;
}

function buildRows(bindings: BindingMap, mac: boolean, speedUpRate: SpeedUpRate): ModalRow[] {
  const platformKey = mac ? "⌘" : "Ctrl";
  const single = (id: ShortcutActionId, what: string, where: string): ModalRow[] => {
    const tokens = bindingTokens(bindings[id], mac);
    return tokens.length ? [{ key: id, tokens, what, where }] : [];
  };
  const pair = (a: ShortcutActionId, b: ShortcutActionId, what: string, where: string): ModalRow[] => {
    const tA = bindingTokens(bindings[a], mac);
    const tB = bindingTokens(bindings[b], mac);
    if (!tA.length && !tB.length) return [];
    return [{ key: `${a}-${b}`, tokens: [...tA, ...tB], what, where }];
  };
  const speedRow = (): ModalRow[] => {
    const up = bindings.speedUp;
    const down = bindings.speedDown;
    if (up === "L" && down === "Shift+L") {
      return [{ key: "speed", tokens: ["L"], what: `Speed up playback to ${speedUpRate}× (again for 1×, Shift slower)`, where: "Preview" }];
    }
    const rows: ModalRow[] = [];
    if (down) rows.push({ key: "speedDown", tokens: bindingTokens(down, mac), what: "Slower playback", where: "Preview" });
    if (up) rows.push({ key: "speedUp", tokens: bindingTokens(up, mac), what: `Speed up playback to ${speedUpRate}× (again for 1×)`, where: "Preview" });
    return rows;
  };

  return [
    { key: "settings", tokens: [platformKey, ","], what: "Open Settings", where: "Everywhere" },
    { key: "select-all", tokens: [platformKey, "A"], what: "Select all projects", where: "Projects" },
    { key: "find-skill", tokens: [platformKey, "F"], what: "Find in skill", where: "Skill Editor" },
    { key: "clear-sel", tokens: ["Esc"], what: "Clear the selection", where: "Projects" },
    { key: "skills", tokens: ["/"], what: "Choose an editing skill", where: "Start of an edit message" },
    ...single("voiceHold", "Hold to talk", "In a project"),
    { key: "apply", tokens: ["A"], what: "Apply the suggestion on screen", where: "Suggestion" },
    ...single("revise", "Revise what is on screen", "Edit, call or suggestion"),
    ...single("keep", "Keep the edit or call on screen", "Edit or call card"),
    ...single("reject", "Reject the edit or call on screen", "Edit or call card"),
    ...single("compare", "Switch between Before and After", "Edit comparison"),
    ...single("playPause", "Play / pause", "Preview"),
    ...single("shuttleBack", "Rewind (shuttle)", "Preview"),
    ...single("shuttleStop", "Stop / pause shuttle", "Preview"),
    ...single("shuttleForward", "Play forward (shuttle)", "Preview"),
    ...pair("prevEdit", "nextEdit", "Previous / next edit or call", "Edit or call card"),
    ...pair("stepBack", "stepForward", "Back / forward 1 second (1 frame with Shift)", "Preview"),
    ...speedRow(),
    ...single("chatBack", "Rewind while typing", "Chat box"),
    ...single("chatPause", "Play / pause while typing", "Chat box"),
    ...single("chatForward", "Play forward while typing", "Chat box"),
    { key: "zoom", tokens: ["−", "+"], what: "Zoom the timeline out / in (0 to fit)", where: "Timeline" },
    ...single("clearRange", "Clear the marked range (also Esc or Delete)", "Timeline"),
    ...single("aimChat", "Type a message at the playhead", "In a project"),
    ...single("markFrame", "Mark the current frame", "Preview"),
    { key: "close-card", tokens: ["Esc"], what: "Close what is on screen", where: "Edit, call or suggestion" },
    { key: "close-pop", tokens: ["Esc"], what: "Close a popover or leave Settings", where: "Everywhere" },
    { key: "help", tokens: ["?"], what: "This list", where: "Everywhere" },
  ];
}

function CustomizeInSettingsButton({ onDone }: { onDone(): void }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="btn-quiet text-[12px]"
      onClick={() => {
        onDone();
        navigate("/settings#shortcuts");
      }}
    >
      Customize in Settings →
    </button>
  );
}

export function ShortcutsModal() {
  const open = useUiStore((s) => s.shortcutsOpen);
  const setOpen = useUiStore((s) => s.setShortcutsOpen);
  const bindings = useShortcutsStore((s) => s.bindings);
  const speedUpRate = usePlayerStore((s) => s.speedUpRate);
  const inRouter = useInRouterContext();

  // Page shortcuts stop while a dialog is open, this one included, so the list listens for the key that closes it.
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      // The press that opened the list keeps repeating while the key is held. Only a new press closes it.
      if (!e.repeat) setOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, setOpen]);

  // The list names the keys of the computer it is on.
  const mac = isMacPlatform();
  const rows = buildRows(bindings, mac, speedUpRate);

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title="Keyboard shortcuts"
      width={540}
      footer={inRouter ? <CustomizeInSettingsButton onDone={() => setOpen(false)} /> : undefined}
    >
      <table className="w-full text-[12.5px]">
        <tbody>
          {rows.map((s) => (
            <tr key={s.key} className="border-b border-line/60 last:border-0">
              <td className="py-1.5 pr-3 whitespace-nowrap">
                <span className="inline-flex gap-1">
                  {s.tokens.map((k, i) => (
                    <Kbd key={`${k}-${i}`}>{k}</Kbd>
                  ))}
                </span>
              </td>
              <td className="py-1.5 text-fg">{s.what}</td>
              <td className="py-1.5 text-dim text-right whitespace-nowrap">{s.where}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
