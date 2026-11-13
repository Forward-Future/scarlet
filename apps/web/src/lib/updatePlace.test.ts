// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { captureProjectPlace, clearUpdatePlace, rememberProject, restoreLastProject, restoreUpdatePlace, saveUpdatePlace } from "./updatePlace";

const at = (path: string) => window.history.replaceState(null, "", path);
const here = () => window.location.pathname + window.location.search + window.location.hash;

beforeEach(() => {
  localStorage.clear();
  at("/");
});
afterEach(() => vi.restoreAllMocks());

it("comes back to the project that was open when an update restarted the app, once", () => {
  at("/p/prj_1?thread=tsk_9#review");
  saveUpdatePlace();
  // The app restarts at the library.
  at("/");
  restoreUpdatePlace();
  expect(here()).toBe("/p/prj_1?thread=tsk_9#review");
  // The bookmark is used up: the next launch opens where it would anyway.
  at("/");
  restoreUpdatePlace();
  expect(here()).toBe("/");
});

it("bookmarks only a project's own page, and tells the page so it can add where the editor is", () => {
  const heard: string[] = [];
  const listen = (e: Event) => { heard.push((e as CustomEvent<URL>).detail.pathname); };
  window.addEventListener("scarlet:bookmark-project", listen);
  try {
    expect(captureProjectPlace({ pathname: "/p/prj_1/", search: "", hash: "" })).toBe("/p/prj_1/");
    for (const pathname of ["/", "/settings", "/p/prj_1/history", "/p/"]) expect(captureProjectPlace({ pathname, search: "", hash: "" })).toBeNull();
    expect(heard).toEqual(["/p/prj_1/"]);
  } finally {
    window.removeEventListener("scarlet:bookmark-project", listen);
  }
  at("/settings");
  saveUpdatePlace();
  at("/");
  restoreUpdatePlace();
  expect(here()).toBe("/");
});

it("leaves the editor where they are when the app opened somewhere other than the library, or the bookmark was cleared", () => {
  at("/p/prj_1");
  saveUpdatePlace();
  at("/p/prj_2");
  restoreUpdatePlace();
  expect(here()).toBe("/p/prj_2");
  at("/p/prj_1");
  saveUpdatePlace();
  clearUpdatePlace();
  at("/");
  restoreUpdatePlace();
  expect(here()).toBe("/");
});

it("never follows a bookmark that leads off the app or to something that isn't a project", () => {
  for (const saved of ["https://example.com/p/prj_1", "//example.com/p/prj_1", "/settings", "/p/prj_1/../../settings"]) {
    localStorage.setItem("scarlet.updatePlace", saved);
    restoreUpdatePlace();
    expect(here()).toBe("/");
  }
});

it("reopens the project that was on screen when Scarlet last closed, and the library after the editor went back to it", () => {
  rememberProject("prj_1");
  restoreLastProject();
  expect(here()).toBe("/p/prj_1");
  // It opened: the page remembers it again, and the next launch reopens it.
  rememberProject("prj_1");
  at("/");
  restoreLastProject();
  expect(here()).toBe("/p/prj_1");
  rememberProject(null);
  at("/");
  restoreLastProject();
  expect(here()).toBe("/");
});

it("doesn't try a project again that never finished opening, so the editor can always reach the library", () => {
  rememberProject("prj_broken");
  restoreLastProject();
  expect(here()).toBe("/p/prj_broken");
  // The app closed or crashed before the project said it was open.
  at("/");
  restoreLastProject();
  expect(here()).toBe("/");
  // And it is forgotten: the launch after that opens the library too.
  restoreLastProject();
  expect(here()).toBe("/");
});

it("ignores a remembered project that isn't an id, and one remembered while another page is already open", () => {
  localStorage.setItem("scarlet.lastProject", "../settings");
  restoreLastProject();
  expect(here()).toBe("/");
  rememberProject("prj_1");
  at("/settings");
  restoreLastProject();
  expect(here()).toBe("/settings");
});

it("carries on without storage", () => {
  rememberProject("prj_1");
  const denied = () => { throw new DOMException("denied", "SecurityError"); };
  const spies = [vi.spyOn(localStorage, "getItem").mockImplementation(denied), vi.spyOn(localStorage, "setItem").mockImplementation(denied),
    vi.spyOn(localStorage, "removeItem").mockImplementation(denied)];
  at("/p/prj_1");
  expect(() => { saveUpdatePlace(); clearUpdatePlace(); rememberProject("prj_1"); rememberProject(null); }).not.toThrow();
  at("/");
  expect(() => { restoreUpdatePlace(); restoreLastProject(); }).not.toThrow();
  for (const spy of spies) expect(spy).toHaveBeenCalled();
  // With nothing readable, it opens the library.
  expect(here()).toBe("/");
});
