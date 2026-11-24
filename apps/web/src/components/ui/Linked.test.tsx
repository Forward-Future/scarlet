// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const openUrl = vi.hoisted(() => vi.fn(async (_url: string) => undefined));
vi.mock("../../lib/desktop", () => ({ desktop: { openUrl } }));

import { Linked, linkParts, linkedText } from "./Linked";

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.replaceChildren(); openUrl.mockClear(); });

it("finds the addresses in Scarlet's words, written out or as Markdown, and leaves the sentence its punctuation", () => {
  const url = "https://www.youtube.com/watch?v=zqzk43bSdDI&t=508s";
  expect(linkParts(`Kontorovich is at ${url}. Ellenberg: [Watch from 1:26](https://www.youtube.com/watch?v=zqzk43bSdDI&t=86s)!`)).toEqual([
    "Kontorovich is at ", { url, label: "youtube.com/watch?v=zqzk43bSdDI&t=508s" }, ". Ellenberg: ",
    { url: "https://www.youtube.com/watch?v=zqzk43bSdDI&t=86s", label: "Watch from 1:26" }, "!",
  ]);
  // A bracket inside the address is its own; one that only closes the sentence's aside is not.
  expect(linkParts("(see https://en.wikipedia.org/wiki/Riemann_(surface))")[1]).toMatchObject({ url: "https://en.wikipedia.org/wiki/Riemann_(surface)" });
  expect(linkParts("(see https://example.com/paper)")[1]).toMatchObject({ url: "https://example.com/paper" });
  expect(linkedText(`Play ${url}.`)).toBe("Play youtube.com/watch?v=zqzk43bSdDI&t=508s.");
  expect(linkParts("Nothing to open here.")).toEqual(["Nothing to open here."]);
});

it("opens an address in the browser without the press reaching the words it is in", () => {
  const folded = vi.fn();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  act(() => root!.render(<p onClick={folded}><Linked text="Found it: https://example.com/clip. And http://example.com/old stays text." /></p>));
  const links = container.querySelectorAll("a.said-link");
  expect([...links].map(a => [a.textContent, a.getAttribute("title")])).toEqual([["example.com/clip", "https://example.com/clip"]]);
  expect(container.textContent).toBe("Found it: example.com/clip. And example.com/old stays text.");
  act(() => (links[0] as HTMLElement).click());
  expect(openUrl).toHaveBeenCalledWith("https://example.com/clip");
  expect(folded).not.toHaveBeenCalled();
});
