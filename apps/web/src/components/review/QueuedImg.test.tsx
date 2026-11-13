// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { QueuedImg, STILL_CONNECTIONS } from "./QueuedImg";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const container = document.createElement("div");
  const root = createRoot(container);
  return {
    container,
    show: (node: ReactNode) => act(() => root.render(node)),
    unmount: () => act(() => root.unmount()),
    requested: () => [...container.querySelectorAll("img")].map(img => img.getAttribute("src")).filter(Boolean),
    finish: (src: string, type: "load" | "error") => act(() => { container.querySelector(`img[src="${src}"]`)!.dispatchEvent(new Event(type)); }),
  };
}
const strip = (urls: string[]) => <div>{urls.map(url => <QueuedImg key={url} src={url} alt="" />)}</div>;

it("loads a strip's stills two at a time, so the window's other requests aren't stuck behind them", () => {
  const urls = Array.from({ length: 6 }, (_, i) => `/frame?i=${i}`);
  const view = mount();
  view.show(strip(urls));
  expect(STILL_CONNECTIONS).toBe(2);
  expect(view.container.querySelectorAll("img")).toHaveLength(6);
  expect(view.requested()).toEqual(urls.slice(0, 2));

  view.finish(urls[0]!, "load");
  expect(view.requested()).toEqual(urls.slice(0, 3));
  view.finish(urls[1]!, "error");
  expect(view.requested()).toEqual(urls.slice(0, 4));

  // The next edit's strip replaces this one: what was loading or waiting gives up its turn.
  const next = Array.from({ length: 3 }, (_, i) => `/frame?next=${i}`);
  view.show(strip(next));
  expect(view.requested()).toEqual(next.slice(0, 2));

  view.unmount();
  const later = mount();
  later.show(strip(urls.slice(4)));
  expect(later.requested()).toEqual(urls.slice(4));
  later.unmount();
});
