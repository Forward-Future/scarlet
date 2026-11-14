// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { desktop } from "./desktop";
import { dropTargets, listenForFileDrops } from "./dropTargets";

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

it.each(["macos", "linux", "windows"] as const)("gives a native drop on %s to the visible target in CSS coordinates", (platform) => {
  type Drop = Parameters<Parameters<typeof desktop.onDropFiles>[0]>[0];
  let fire!: (event: Drop) => void;
  vi.spyOn(desktop, "onDropFiles").mockImplementation(handler => { fire = handler; return Promise.resolve(() => {}); });
  document.body.innerHTML = `<div data-file-drop id="card"><p id="row">Interview</p>
    <dialog open id="rename"><input /><div data-file-drop id="inner"></div></dialog></div>`;
  const card = { highlight: vi.fn(), drop: vi.fn() }, inner = { highlight: vi.fn(), drop: vi.fn() };
  dropTargets.set(document.querySelector("#card")!, card);
  dropTargets.set(document.querySelector("#inner")!, inner);
  const under = vi.spyOn(document, "elementFromPoint");
  vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(2);
  const stop = listenForFileDrops(platform);
  const drop = (selector: string) => {
    under.mockReturnValue(document.querySelector(selector));
    fire({ type: "drop", paths: ["/footage/a.mov"], position: { x: 10, y: 10 } } as Drop);
  };
  // On the project's row: its zone takes the files.
  drop("#row");
  const cssPoint = platform === "windows" ? 5 : 10;
  expect(under).toHaveBeenCalledWith(cssPoint, cssPoint);
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
