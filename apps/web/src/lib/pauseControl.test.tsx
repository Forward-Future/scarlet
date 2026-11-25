// @vitest-environment happy-dom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { usePauseOn, type PauseOffer } from "./pauseControl";

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

/** A thread in the chat: it says which of its bands could draw Pause, and shows which request in the chat does. */
function Thread({ id, offer }: { id: string; offer: Partial<PauseOffer> }) {
  const at = useRef<HTMLElement>(null);
  const on = usePauseOn(id, at, { bands: [], under: [], ...offer });
  return <section ref={at} data-thread={id} data-pause={on ?? ""} />;
}
const draw = (threads: [id: string, offer: Partial<PauseOffer>][]) => act(() => root.render(<>{threads.map(([id, offer]) => <Thread key={id} id={id} offer={offer} />)}</>));
/** Which request draws Pause, as every thread reads it: they all read the same one. */
const holder = () => { const read = new Set([...host.querySelectorAll<HTMLElement>("section")].map(el => el.dataset.pause)); expect(read.size).toBe(1); return [...read][0]; };

it("draws Pause on one band in the chat: the one above the message box, else the lowest with a Stop, else the lowest block Scarlet works under", () => {
  // Two bands have a Stop of their own and a third block has requests at work under its rows: the lowest band with a Stop has it.
  draw([["a", { bands: ["run_a"] }], ["b", { bands: ["run_b1", "run_b2"] }], ["c", { under: ["run_c"] }]]);
  expect(holder()).toBe("run_b2");
  // The block above the message box comes first, whether its band has a Stop or holds Pause for the requests under its rows.
  draw([["a", { bands: ["run_a"], pinned: "run_a" }], ["b", { bands: ["run_b1", "run_b2"] }], ["c", { under: ["run_c"] }]]);
  expect(holder()).toBe("run_a");
  draw([["a", { bands: ["run_a"] }], ["b", { bands: ["run_b1"] }], ["c", { under: ["run_c"], pinned: "run_c" }]]);
  expect(holder()).toBe("run_c");
  // With no band that has a Stop, the band of the lowest block Scarlet works under has it.
  draw([["a", { under: ["run_a"] }], ["b", {}], ["c", { under: ["run_c"] }]]);
  expect(holder()).toBe("run_c");
  // A thread that leaves the chat takes its offer with it, and with nothing at work there is no Pause.
  draw([["a", { under: ["run_a"] }], ["b", {}]]);
  expect(holder()).toBe("run_a");
  draw([["a", {}], ["b", {}]]);
  expect(holder()).toBe("");
});
