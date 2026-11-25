// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AimHostContext, AimRow } from "./AimRow";

let container: HTMLElement, host: HTMLElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.body.appendChild(document.createElement("div"));
  host = document.body.appendChild(document.createElement("span"));
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); host.remove(); });

it("draws the open row's number and words on the message box's line, and nothing for a row that isn't open or with no line to draw on", async () => {
  const rows = (open: string, line: HTMLElement | null) => <AimHostContext.Provider value={line}><ol>
    {["captions", "wrap"].map((name, i) => <li key={name}><button type="button">{name}</button>
      <AimRow on={name === open}><b>{i + 1}</b><span className="composer-aim-words">{name}</span></AimRow></li>)}
  </ol></AimHostContext.Provider>;
  await act(async () => root.render(rows("wrap", host)));
  expect(host.textContent).toBe("2wrap");
  // It is not inside the row's button, so a press on the box's line doesn't press the row.
  expect(container.textContent).toBe("captionswrap");
  await act(async () => root.render(rows("captions", host)));
  expect(host.textContent).toBe("1captions");
  await act(async () => root.render(rows("", host)));
  expect(host.textContent).toBe("");
  await act(async () => root.render(rows("wrap", null)));
  expect([host.textContent, container.textContent]).toEqual(["", "captionswrap"]);
});
