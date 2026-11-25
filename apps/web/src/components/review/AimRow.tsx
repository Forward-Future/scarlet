import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** The line over the message box, while the box talks to the cut or edit that's open. */
export const AimHostContext = createContext<HTMLElement | null>(null);

/**
 * The row that's open draws its number and its words on the message box's line too (the editor chose this on
 * 2026-11-24, in place of "Edit 5:10"): the box names the edit as its list does, with the same number as its dot.
 */
export function AimRow({ on, children }: { on: boolean; children: ReactNode }) {
  const host = useContext(AimHostContext);
  return on && host ? createPortal(<span className="composer-aim-rowcopy">{children}</span>, host) : null;
}
