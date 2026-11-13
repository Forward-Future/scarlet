import { useEffect } from "react";
import { PLATFORM_KEY, SHORTCUTS } from "../../lib/hotkeys";
import { useUiStore } from "../../stores/ui";
import { Kbd, Modal } from "../ui/primitives";

export function ShortcutsModal() {
  const open = useUiStore((s) => s.shortcutsOpen);
  const setOpen = useUiStore((s) => s.setShortcutsOpen);
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
  const platformKey = navigator.userAgent.includes("Macintosh") ? "⌘" : "Ctrl";
  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts" width={520}>
      <table className="w-full text-[12.5px]">
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr key={`${s.keys.join(" ")} ${s.what}`} className="border-b border-line/60 last:border-0">
              <td className="py-1.5 pr-3 whitespace-nowrap">
                <span className="inline-flex gap-1">
                  {s.keys.map((k) => (
                    <Kbd key={k}>{k === PLATFORM_KEY ? platformKey : k}</Kbd>
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
