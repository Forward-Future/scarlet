// @vitest-environment happy-dom
import { PreferenceSelect } from "./PreferenceSelect";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ScarletApiError } from "@scarlet/shared";
import { ConfirmDialog, Drawer, Modal } from "./primitives";

let el: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  vi.unstubAllGlobals();
});
const pointer = (target: Element, type: string, x: number) => act(async () => {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: x }));
});

it("opens a confirmation with the keyboard on Cancel, and rings whatever button, link or checkbox the keyboard is on", async () => {
  await act(async () => root.render(<ConfirmDialog open onClose={() => {}} onConfirm={() => {}} title="Move “Interview” to Trash?" confirmLabel="Move to Trash" danger />));
  expect(document.activeElement?.textContent?.trim()).toBe("Cancel");
  // A test has no styles, so the ring is read from the stylesheet: one rule for all of them, drawn only while the
  // keyboard is there, and not on a menu's row, which lights up instead.
  const { readFileSync } = await import("node:fs");
  const ring = readFileSync(`${import.meta.dirname}/../../index.css`, "utf8")
    .match(/:is\(([^)]+)\):not\(\[role="menuitem"\]\) \{\s*outline: 0 solid var\(--color-muted\);\s*outline-offset: 2px;\s*&:focus-visible \{\s*outline-width: 2px;/);
  expect(ring?.[1]?.split(", ")).toEqual(["button", "a", "summary", 'input[type="checkbox"]']);
});

it("closes on a click on the backdrop, not on a drag that began inside and was let go outside", async () => {
  const onClose = vi.fn();
  await act(async () => root.render(<Modal open onClose={onClose} title="Note"><input aria-label="Note text" /></Modal>));
  const dialog = el.querySelector("dialog")!;
  vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({ left: 100, right: 300, top: 100, bottom: 300 } as DOMRect);
  // Selecting text: the press is on the field and the release lands past the dialog's edge, so the click is the dialog's.
  await pointer(el.querySelector("input")!, "pointerdown", 150);
  await pointer(dialog, "click", 400);
  expect(onClose).not.toHaveBeenCalled();
  // A press and release on the backdrop still closes it.
  await pointer(dialog, "pointerdown", 400);
  await pointer(dialog, "click", 400);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("gives a button that can be pressed the pointer hand, and never one that can't", async () => {
  // A test has no styles, so the rule is read from the stylesheet: one rule for every button, in the base layer so a
  // control's own rule can still say otherwise. A disabled button doesn't match it.
  const { readFileSync } = await import("node:fs");
  expect(readFileSync(`${import.meta.dirname}/../../index.css`, "utf8")).toMatch(/@layer base \{\s*button:enabled \{\s*cursor: pointer;\s*\}\s*\}/);
});

it("opens a confirmation without the error its last attempt left", async () => {
  const fail = vi.fn().mockRejectedValue(new Error("Scarlet is working. Try again after the current jobs finish."));
  function Host() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Empty Trash</button>
      <ConfirmDialog open={open} onClose={() => setOpen(false)} onConfirm={fail} title="Empty Trash?" confirmLabel="Delete permanently" /></>;
  }
  await act(async () => root.render(<Host />));
  const button = (text: string) => [...el.querySelectorAll("button")].find(b => b.textContent?.trim() === text)!;
  await act(async () => button("Empty Trash").click());
  await act(async () => button("Delete permanently").click());
  expect(el.textContent).toContain("Scarlet is working.");
  await act(async () => button("Cancel").click());
  await act(async () => button("Empty Trash").click());
  expect(el.querySelector("dialog")).not.toBeNull();
  expect(el.textContent).not.toContain("Scarlet is working.");
});

it("says Scarlet can't reach its engine, not \"Service Unavailable\", when a confirmation's action is turned away as the engine shuts down", async () => {
  const onConfirm = vi.fn().mockRejectedValue(new ScarletApiError(503, "http_error", "Service Unavailable"));
  await act(async () => root.render(<ConfirmDialog open onClose={() => {}} onConfirm={onConfirm} title="Empty Trash?" confirmLabel="Delete permanently" danger />));
  await act(async () => [...el.querySelectorAll("button")].find(b => b.textContent?.trim() === "Delete permanently")!.click());
  expect(el.querySelector('[role="alert"]')?.textContent).toBe("Scarlet can’t reach its engine right now.");
});

it("names the × of a dialog and of a drawer on hover, with the key that closes it", async () => {
  await act(async () => root.render(<><Modal open onClose={() => {}} title="Export">Export</Modal><Drawer open onClose={() => {}} title="History">History</Drawer></>));
  expect([...el.querySelectorAll('dialog [aria-label="Close"]')].map(x => x.getAttribute("title"))).toEqual(["Close (Esc)", "Close (Esc)"]);
});

it("names every × in the app on hover", () => {
  const sources = import.meta.glob<string>(["/src/**/*.tsx", "!**/*.test.*"], { eager: true, query: "?raw", import: "default" });
  // A button that holds nothing but the × icon, and what its opening tag says.
  const cross = /<button\b((?:(?!<[A-Za-z/])[\s\S])*?)>\s*<(?:CloseIcon|Icon name="x")[^>]*\/>\s*<\/button>/g;
  const found = Object.entries(sources).flatMap(([file, source]) => [...source.matchAll(cross)].map(match => ({ file, tag: match[1]! })));
  expect(found.length).toBeGreaterThan(0);
  expect(found.filter(button => !/\btitle=/.test(button.tag)).map(button => button.file)).toEqual([]);
});

it("keeps a confirmation open while its action runs, and says there why it failed", async () => {
  let fail!: (reason: Error) => void;
  const onConfirm = vi.fn(() => new Promise<void>((_, reject) => { fail = reject; }));
  const onClose = vi.fn();
  await act(async () => root.render(<ConfirmDialog open onClose={onClose} onConfirm={onConfirm} title="Empty Trash?" confirmLabel="Delete permanently" danger />));
  const button = (text: string) => [...el.querySelectorAll("button")].find(b => b.textContent?.trim() === text)!;
  const dialog = el.querySelector("dialog")!;
  vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({ left: 100, right: 300, top: 100, bottom: 300 } as DOMRect);
  const esc = () => act(async () => { dialog.dispatchEvent(new Event("cancel", { cancelable: true })); });
  await act(async () => button("Delete permanently").click());
  // While it deletes, neither Esc, the × nor a click on the backdrop closes it.
  expect(button("Cancel").disabled).toBe(true);
  await esc();
  await act(async () => el.querySelector<HTMLButtonElement>("[data-close]")!.click());
  await pointer(dialog, "pointerdown", 400);
  await pointer(dialog, "click", 400);
  expect(onClose).not.toHaveBeenCalled();
  // The failure shows in the dialog that is still open, and it can be closed again.
  await act(async () => fail(new Error("Scarlet is working. Try again after the current jobs finish.")));
  expect(el.querySelector('[role="alert"]')?.textContent).toBe("Scarlet is working. Try again after the current jobs finish.");
  await esc();
  expect(onClose).toHaveBeenCalledOnce();
});

it("comes back when the browser closes it though its owner still shows it, as Chromium does on a second Esc", async () => {
  function Host({ open }: { open: boolean }) {
    return <Modal open={open} onClose={() => {}} title="Empty Trash?"><p>Deleting…</p></Modal>;
  }
  await act(async () => root.render(<Host open />));
  const dialog = el.querySelector("dialog")!;
  // The second Esc in a row: Chromium closes the dialog whatever its cancel handler answered, then fires a toggle.
  await act(async () => { dialog.close(); dialog.dispatchEvent(new Event("toggle")); });
  expect(dialog.open).toBe(true);
  // One its owner puts away stays away.
  await act(async () => root.render(<Host open={false} />));
  expect(el.querySelector("dialog")).toBeNull();
  expect(dialog.open).toBe(false);
});

it("puts away an open list on a press outside the dialog, and the dialog only on the next", async () => {
  const onClose = vi.fn();
  await act(async () => root.render(<Drawer open onClose={onClose} title="Project settings">
    <input aria-label="Name" defaultValue="Interview" />
    <PreferenceSelect label="Frame rate" options={[{ value: 24, label: "24" }, { value: 30, label: "30" }]} value={24} onChange={() => undefined} />
  </Drawer>));
  const dialog = el.querySelector("dialog")!;
  vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({ left: 100, right: 300, top: 100, bottom: 300 } as DOMRect);
  await act(async () => el.querySelector<HTMLButtonElement>('[role="combobox"]')!.click());
  // The list opens inside the dialog's layer.
  expect(dialog.querySelector('[role="listbox"]')).not.toBeNull();
  // One click beside the drawer closed the list and the drawer, and what was typed in the drawer went with it.
  await pointer(dialog, "pointerdown", 400);
  await pointer(dialog, "click", 400);
  expect(dialog.querySelector('[role="listbox"]')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  await pointer(dialog, "pointerdown", 400);
  await pointer(dialog, "click", 400);
  expect(onClose).toHaveBeenCalledTimes(1);
});
