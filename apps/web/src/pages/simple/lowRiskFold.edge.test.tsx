// @vitest-environment happy-dom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FOLD_MS, useArrivingRows, useLeavingRows, useLowRiskFold, useLowRiskLine } from "./lowRiskFold";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const realAnimate = Element.prototype.animate;
let frames: FrameRequestCallback[];

/** Each element sits where its `data-top` and `data-height` say (28 px tall at the top by default). */
function placeByData() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const el = this as HTMLElement;
    const top = Number(el.dataset?.top ?? 0), height = Number(el.dataset?.height ?? 28);
    return { x: 0, y: top, left: 0, top, right: 320, bottom: top + height, width: 320, height, toJSON: () => ({}) } as DOMRect;
  });
}

/** Animations that finish when the test says, or fail as a cancelled one does. */
function stubAnimate() {
  const made: { el: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions; cancel: ReturnType<typeof vi.fn>; finish: () => void; fail: () => void }[] = [];
  const animate = vi.fn(function (this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    let finish!: () => void, fail!: () => void;
    const finished = new Promise<void>((resolve, reject) => { finish = resolve; fail = () => reject(new DOMException("cancelled", "AbortError")); });
    const cancel = vi.fn();
    made.push({ el: this, keyframes, options, cancel, finish, fail });
    return { finished, cancel } as unknown as Animation;
  });
  Element.prototype.animate = animate as unknown as Element["animate"];
  return { animate, made, finishAll: () => { for (const a of made) a.finish(); } };
}

function reduceMotion() {
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({ matches: query.includes("reduce"), media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false }) as MediaQueryList);
}

const render = async (ui: React.ReactNode) => { await act(async () => { root.render(ui); }); };
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  placeByData();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Element.prototype.animate = realAnimate;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useLowRiskFold", () => {
  /** Needs review's own scrolling list: two edits of its own, the second open on the card, and the low risk rows. */
  function Pass({ initial = false, low = 2, scrolls = true, lowTop = 0, words = true, openTop = 100 }: { initial?: boolean; low?: number; scrolls?: boolean; lowTop?: number; words?: boolean; openTop?: number }) {
    const host = useRef<HTMLDivElement>(null);
    const [on, setOn] = useState(initial);
    const fold = useLowRiskFold(host, on, setOn);
    return (
      <div ref={host} data-shown={String(fold.shown)} data-closing={String(fold.closing)}>
        <button type="button" className="toggle" onClick={fold.toggle}>Low risk</button>
        <button type="button" className="include" onClick={() => setOn(true)}>Include</button>
        <ol className="simple-edits" data-top="0" data-height="200" style={{ overflowY: scrolls ? "auto" : "visible" }}>
          <li><button type="button" data-top="-60">Off the top</button></li>
          <li><button type="button" data-top="40">First in view</button></li>
          <li><button type="button" className="open" aria-current="true" data-top={openTop}>Open edit</button></li>
          {fold.shown && Array.from({ length: low }, (_, i) => (
            <li key={i} data-low-risk="" data-top={lowTop + i * 1000} data-height="30">{words && <button type="button">Low risk {i + 1}</button>}</li>
          ))}
        </ol>
      </div>
    );
  }
  const host = () => container.firstElementChild as HTMLElement;
  const list = () => container.querySelector<HTMLElement>(".simple-edits")!;
  const click = (selector: string) => act(async () => { container.querySelector<HTMLButtonElement>(selector)!.click(); });

  it("keeps the open edit where it was while the low risk rows open round it, then gives the rows their own height back", async () => {
    const { made, finishAll } = stubAnimate();
    await render(<Pass />);
    await click(".toggle");
    expect(host().dataset.shown).toBe("true");
    const rows = [...container.querySelectorAll<HTMLElement>("li[data-low-risk]")];
    expect(rows.map(r => r.style.overflowY)).toEqual(["clip", "clip"]);
    // Each row's room grows from nothing to its height, then its words rise in and a wash fades over them.
    expect(made.filter(a => a.el === rows[0])[0]!.keyframes).toEqual([{ height: "0px" }, { height: "30px" }]);
    expect(made).toHaveLength(6);

    // The rows open above the open edit and push it down 30 px: the list scrolls to keep it still.
    container.querySelector<HTMLElement>(".open")!.dataset.top = "130";
    frames.shift()!(0);
    expect(list().scrollTop).toBe(30);
    expect(frames).toHaveLength(1);
    // Scrolled back into its place, a drift of half a pixel or less isn't followed.
    container.querySelector<HTMLElement>(".open")!.dataset.top = "100.4";
    frames.shift()!(0);
    expect(list().scrollTop).toBe(30);

    finishAll();
    await flush();
    expect(rows.map(r => r.style.overflowY)).toEqual(["", ""]);
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });

  it("staggers only the rows in view, and opens a row with no words by its room alone", async () => {
    const { made } = stubAnimate();
    await render(<Pass low={3} words={false} />);
    await click(".toggle");
    const rooms = made.map(a => a.options);
    expect(made).toHaveLength(3);
    // Rows at 0, 1000 and 2000 px: the window is 768 px tall in happy-dom, so only the first is in view.
    expect(window.innerHeight).toBeLessThan(1000);
    expect(rooms.map(o => o.delay)).toEqual([0, 0, 0]);
    expect(rooms.every(o => o.fill === "backwards" && o.duration === 340)).toBe(true);
  });

  it("caps the stagger of a long run of rows in view", async () => {
    const { made } = stubAnimate();
    function Many() {
      const ref = useRef<HTMLDivElement>(null);
      const [on, setOn] = useState(false);
      const fold = useLowRiskFold(ref, on, setOn);
      return (
        <div ref={ref}>
          <button type="button" className="toggle" onClick={fold.toggle}>Low risk</button>
          <ol>{fold.shown && Array.from({ length: 12 }, (_, i) => <li key={i} data-low-risk="" data-top={i * 30}><span>Row</span></li>)}</ol>
        </div>
      );
    }
    await render(<Many />);
    await click(".toggle");
    const roomDelays = made.filter(a => a.el.tagName === "LI").map(a => a.options.delay);
    expect(roomDelays).toEqual([0, 24, 48, 72, 96, 120, 144, 168, 192, 200, 200, 200]);
    // The words follow their room by 70 ms, and the wash after the words have settled.
    const words = made.filter(a => a.el.tagName === "SPAN");
    expect(words[2]!.options.delay).toBe(24 + 70);
    expect(words[3]!.options.delay).toBe(24 + 70 + 280);
  });

  it("closes the rows before they leave, then stops drawing them", async () => {
    const { made, finishAll } = stubAnimate();
    await render(<Pass initial />);
    expect(made).toHaveLength(0);
    await click(".toggle");
    expect(host().dataset.closing).toBe("true");
    expect(host().dataset.shown).toBe("true");
    const rooms = made.filter(a => a.el.tagName === "LI");
    expect(rooms.map(a => a.keyframes)).toEqual([[{ height: "30px" }, { height: "0px" }], [{ height: "30px" }, { height: "0px" }]]);
    expect(rooms.every(a => a.options.fill === "both" && a.options.delay === 60)).toBe(true);
    expect(made.filter(a => a.el.tagName === "BUTTON").map(a => a.options.fill)).toEqual(["forwards", "forwards"]);

    finishAll();
    await flush();
    expect(host().dataset.closing).toBe("false");
    expect(host().dataset.shown).toBe("false");
    expect(container.querySelectorAll("li[data-low-risk]")).toHaveLength(0);
  });

  it("stops closing when the rows are included again from elsewhere, cancelling the close at once", async () => {
    const { made } = stubAnimate();
    await render(<Pass initial />);
    await click(".toggle");
    expect(host().dataset.closing).toBe("true");
    const rows = [...container.querySelectorAll<HTMLElement>("li[data-low-risk]")];
    await click(".include");
    expect(host().dataset.closing).toBe("false");
    expect(host().dataset.shown).toBe("true");
    expect(made.slice(0, 4).every(a => a.cancel.mock.calls.length === 1)).toBe(true);
    // They open again where they were, from their own rows.
    expect(made).toHaveLength(10);
    expect(container.querySelectorAll("li[data-low-risk]")).toHaveLength(2);
    expect(rows.every(r => r.isConnected)).toBe(true);
    // The stopped close finishing late changes nothing.
    for (const a of made.slice(0, 4)) a.finish();
    await flush();
    expect(host().dataset.shown).toBe("true");
    expect(rows.map(r => r.style.overflowY)).toEqual(["clip", "clip"]);
  });

  it("leaves the rows closing when an animation is cancelled before it finishes", async () => {
    const { made } = stubAnimate();
    await render(<Pass initial />);
    await click(".toggle");
    for (const a of made) a.fail();
    await flush();
    expect(host().dataset.closing).toBe("true");
  });

  it("opens and closes at once with motion reduced, and when there are no low risk rows to move", async () => {
    reduceMotion();
    const { animate } = stubAnimate();
    await render(<Pass />);
    await click(".toggle");
    expect(host().dataset.shown).toBe("true");
    await click(".toggle");
    expect(host().dataset.shown).toBe("false");
    expect(host().dataset.closing).toBe("false");
    expect(animate).not.toHaveBeenCalled();
  });

  it("finishes a close straight away when the list draws no low risk rows", async () => {
    const { animate } = stubAnimate();
    await render(<Pass initial low={0} />);
    await click(".toggle");
    expect(animate).not.toHaveBeenCalled();
    expect(host().dataset.closing).toBe("false");
    expect(host().dataset.shown).toBe("false");
  });

  it("holds the first row in view when the open edit has scrolled away, and none in a list that doesn't scroll", async () => {
    stubAnimate();
    await render(<Pass openTop={500} />);
    await click(".toggle");
    container.querySelector<HTMLElement>("li:nth-child(2) > button")!.dataset.top = "70";
    frames.shift()!(0);
    expect(list().scrollTop).toBe(30);

    await act(async () => root.unmount());
    root = createRoot(container);
    stubAnimate();
    await render(<Pass scrolls={false} />);
    await click(".toggle");
    container.querySelector<HTMLElement>(".open")!.dataset.top = "400";
    frames.at(-1)!(0);
    expect(list().scrollTop).toBe(0);
  });

  it("stops following the held row once it has left the page", async () => {
    stubAnimate();
    await render(<Pass />);
    await click(".toggle");
    const open = container.querySelector<HTMLElement>(".open")!;
    open.dataset.top = "180";
    open.remove();
    frames.shift()!(0);
    expect(list().scrollTop).toBe(0);
  });

  it("stops an opening at once when the list goes away mid-way", async () => {
    const { made } = stubAnimate();
    await render(<Pass />);
    await click(".toggle");
    const rows = [...container.querySelectorAll<HTMLElement>("li[data-low-risk]")];
    await act(async () => root.unmount());
    expect(made.every(a => a.cancel.mock.calls.length === 1)).toBe(true);
    expect(rows.map(r => r.style.overflowY)).toEqual(["", ""]);
    root = createRoot(container);
  });
});

describe("useLeavingRows", () => {
  function Leaving({ rows }: { rows: { id: string; leaving: boolean; sep?: boolean }[] }) {
    const host = useRef<HTMLUListElement>(null);
    useLeavingRows(host);
    return (
      <ul ref={host}>
        {rows.map(r => r.sep
          ? <li key={r.id} id={r.id} role="separator" className={`review-tier-sep${r.leaving ? " is-leaving" : ""}`} data-height="12" style={{ marginTop: "8px", marginBottom: "4px", paddingTop: "2px" }} />
          : <li key={r.id} id={r.id} className={r.leaving ? "is-leaving" : undefined} data-height="40">{r.id}</li>)}
      </ul>
    );
  }
  const row = (id: string) => container.querySelector<HTMLElement>(`#${id}`)!;

  it("folds a leaving row's room away once, and gives it its height back if it stays after all", async () => {
    const { made } = stubAnimate();
    await render(<Leaving rows={[{ id: "a", leaving: true }, { id: "b", leaving: false }]} />);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ el: row("a"), keyframes: [{ height: "40px" }, { height: "0px" }], options: { duration: 260, fill: "forwards" } });
    expect(row("a").dataset.closing).toBe("");
    expect(row("a").style.overflowY).toBe("clip");

    // Another render while it still leaves doesn't start it again.
    await render(<Leaving rows={[{ id: "a", leaving: true }, { id: "b", leaving: false }]} />);
    expect(made).toHaveLength(1);
    expect(made[0]!.cancel).not.toHaveBeenCalled();

    await render(<Leaving rows={[{ id: "a", leaving: false }, { id: "b", leaving: false }]} />);
    expect(made[0]!.cancel).toHaveBeenCalledOnce();
    expect(row("a").dataset.closing).toBeUndefined();
    expect(row("a").style.overflowY).toBe("");
  });

  it("folds the Safe edits divider with its margins, and forgets a row that has gone", async () => {
    const { made } = stubAnimate();
    await render(<Leaving rows={[{ id: "sep", leaving: true, sep: true }, { id: "a", leaving: true }]} />);
    expect(made[0]!.keyframes).toEqual([
      { height: "12px", marginTop: "8px", marginBottom: "4px", paddingTop: "2px" },
      { height: "0px", marginTop: "0px", marginBottom: "0px", paddingTop: "0px" },
    ]);
    made[1]!.fail();
    await render(<Leaving rows={[{ id: "sep", leaving: true, sep: true }]} />);
    expect(made[1]!.cancel).toHaveBeenCalledOnce();
    expect(made[0]!.cancel).not.toHaveBeenCalled();
  });

  it("lets a row leave at once with motion reduced", async () => {
    reduceMotion();
    const { animate } = stubAnimate();
    await render(<Leaving rows={[{ id: "a", leaving: true }]} />);
    expect(animate).not.toHaveBeenCalled();
    expect(row("a").dataset.closing).toBeUndefined();
  });
});

describe("useArrivingRows", () => {
  function Arriving({ rows }: { rows: { id: string; arriving: boolean; height?: number; bare?: boolean }[] }) {
    const host = useRef<HTMLUListElement>(null);
    useArrivingRows(host);
    return (
      <ul ref={host}>
        {rows.map(r => (
          <li key={r.id} id={r.id} className={r.arriving ? "is-arriving" : undefined} data-height={r.height ?? 36}>
            {!r.bare && <button type="button">{r.id}</button>}
          </li>
        ))}
      </ul>
    );
  }
  const row = (id: string) => container.querySelector<HTMLElement>(`#${id}`)!;

  it("opens an arriving row into place with its words rising and a brief wash, then lets it be its own height", async () => {
    const { made } = stubAnimate();
    await render(<Arriving rows={[{ id: "a", arriving: true }, { id: "flat", arriving: true, height: 0 }, { id: "b", arriving: false }]} />);
    expect(made.map(a => a.el)).toEqual([row("a"), row("a").firstElementChild, row("a").firstElementChild]);
    expect(made[0]!.keyframes).toEqual([{ height: "0px" }, { height: "36px" }]);
    expect(made[2]!.options).toMatchObject({ duration: 650, delay: 120 });
    expect(row("a").dataset.arrived).toBe("");
    expect(row("flat").dataset.arrived).toBeUndefined();
    expect(row("a").style.overflowY).toBe("clip");
    made[0]!.finish();
    await flush();
    expect(row("a").style.overflowY).toBe("");
  });

  it("cancels the arrival of a row that settles or goes before it finishes", async () => {
    const { made } = stubAnimate();
    await render(<Arriving rows={[{ id: "a", arriving: true }, { id: "bare", arriving: true, bare: true }]} />);
    expect(made).toHaveLength(4);
    made[0]!.fail();
    await render(<Arriving rows={[{ id: "a", arriving: true }, { id: "bare", arriving: true, bare: true }]} />);
    expect(made).toHaveLength(4);
    await render(<Arriving rows={[{ id: "a", arriving: false }]} />);
    expect(made.every(a => a.cancel.mock.calls.length === 1)).toBe(true);
    expect(row("a").dataset.arrived).toBeUndefined();
    expect(row("a").style.overflowY).toBe("");
  });

  it("puts an arriving row straight in place with motion reduced", async () => {
    reduceMotion();
    const { animate } = stubAnimate();
    await render(<Arriving rows={[{ id: "a", arriving: true }]} />);
    expect(animate).not.toHaveBeenCalled();
  });
});

describe("useLowRiskLine", () => {
  function Line({ count, shown = true }: { count: number; shown?: boolean }) {
    const host = useRef<HTMLDivElement>(null);
    const line = useLowRiskLine(host, count, shown);
    return (
      <div ref={host}>
        {line && <p className="simple-low-risk" data-height="24" style={{ marginBottom: "6px" }} data-leaving={String(line.leaving)}>{line.count} low risk</p>}
      </div>
    );
  }
  const line = () => container.querySelector<HTMLElement>(".simple-low-risk");

  it("says the count while there are low risk edits, and closes the line with its last count once they are gone", async () => {
    const { made } = stubAnimate();
    await render(<Line count={3} />);
    expect(line()?.textContent).toBe("3 low risk");
    expect(line()?.dataset.leaving).toBe("false");
    await render(<Line count={0} />);
    expect(line()?.textContent).toBe("3 low risk");
    expect(line()?.dataset.leaving).toBe("true");
    expect(made).toHaveLength(1);
    expect(made[0]!.keyframes).toEqual([{ height: "24px", marginBottom: "6px", opacity: 1 }, { height: "0px", marginBottom: "0px", opacity: 0 }]);
    expect(made[0]!.options).toMatchObject({ duration: FOLD_MS, fill: "forwards" });
    expect(line()?.style.overflowY).toBe("clip");
    made[0]!.finish();
    await flush();
    expect(line()).toBeNull();
  });

  it("hides the line at once when Needs review is switched away, and cancels a close on the way", async () => {
    const { made } = stubAnimate();
    await render(<Line count={2} />);
    await render(<Line count={0} />);
    expect(line()).not.toBeNull();
    await render(<Line count={0} shown={false} />);
    expect(line()).toBeNull();
    expect(made[0]!.cancel).toHaveBeenCalledOnce();
    // Coming back with none left shows nothing; a new low risk edit shows the line again.
    await render(<Line count={0} />);
    expect(line()).toBeNull();
    await render(<Line count={1} />);
    expect(line()?.textContent).toBe("1 low risk");
  });

  it("drops the line at once with motion reduced, and when the close is cancelled it stays until the next change", async () => {
    reduceMotion();
    const { animate } = stubAnimate();
    await render(<Line count={1} />);
    await render(<Line count={0} />);
    expect(line()).toBeNull();
    expect(animate).not.toHaveBeenCalled();
  });

  it("keeps the closing line when its animation is cancelled before it ends", async () => {
    const { made } = stubAnimate();
    await render(<Line count={1} />);
    await render(<Line count={0} />);
    made[0]!.fail();
    await flush();
    expect(line()?.dataset.leaving).toBe("true");
  });
});
