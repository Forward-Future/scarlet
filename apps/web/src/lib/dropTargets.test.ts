// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { desktop } from "./desktop";
import { dropTargets, listenForFileDrops } from "./dropTargets";

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

it("gives files dropped on a dialog only to a drop zone inside it, not to the zone the dialog sits in", () => {
  type Drop = Parameters<Parameters<typeof desktop.onDropFiles>[0]>[0];
  let fire!: (event: Drop) => void;
  vi.spyOn(desktop, "onDropFiles").mockImplementation(handler => { fire = handler; return Promise.resolve(() => {}); });
  document.body.innerHTML = `<div data-file-drop id="card"><p id="row">Interview</p>
    <dialog open id="rename"><input /><div data-file-drop id="inner"></div></dialog></div>`;
  const card = { highlight: vi.fn(), drop: vi.fn() }, inner = { highlight: vi.fn(), drop: vi.fn() };
  dropTargets.set(document.querySelector("#card")!, card);
  dropTargets.set(document.querySelector("#inner")!, inner);
  const under = vi.spyOn(document, "elementFromPoint");
  const stop = listenForFileDrops("macos");
  const drop = (selector: string) => {
    under.mockReturnValue(document.querySelector(selector));
    fire({ type: "drop", paths: ["/footage/a.mov"], position: { x: 10, y: 10 } } as Drop);
  };
  // On the project's row: its zone takes the files.
  drop("#row");
  expect(card.drop).toHaveBeenCalledTimes(1);
  // On the Rename dialog that row opened, or the dimmed page around it: nothing imports into the project.
  drop("#rename input");
  drop("#rename");
  expect(card.drop).toHaveBeenCalledTimes(1);
  // A zone inside the dialog still works.
  drop("#inner");
  expect(inner.drop).toHaveBeenCalledWith(["/footage/a.mov"]);
  stop();
});
