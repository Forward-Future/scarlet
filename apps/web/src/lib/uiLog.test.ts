// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueueTray } from "../components/chat/QueueTray";
import { startAppLog, stopAppLog } from "./appLog";
import { loggedFetch } from "./client";
import { startUiLog, stopUiLog } from "./uiLog";

let lines: string[], levels: string[];
const written = () => { vi.advanceTimersByTime(300); return lines; };
const fresh = () => { written(); lines.length = 0; levels.length = 0; };
beforeEach(() => {
  vi.useFakeTimers();
  lines = [];
  levels = [];
  window.history.replaceState({}, "", "/");
  startAppLog((batch, level) => { lines.push(...batch); levels.push(level); });
  startUiLog();
});
afterEach(() => {
  stopUiLog();
  stopAppLog();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("opens the log with the session and the page", () => {
  expect(written()).toEqual([expect.stringMatching(/^\[app\] .* start .*width=\d+/), expect.stringMatching(/^\[nav\] .* open to=\/$/)]);
});

it("logs a press by the control's name and where it sits", () => {
  document.body.innerHTML = '<section role="region" aria-label="Call"><button aria-pressed="false"><span>Before</span></button></section>';
  fresh();
  document.querySelector("span")!.click();
  expect(written()).toEqual([expect.stringMatching(/^\[action\] .* click on=Before in=Call pressed=false$/)]);
});

it("logs the keys that act and never what is typed", () => {
  document.body.innerHTML = '<textarea aria-label="Talk to Scarlet"></textarea><div id="stage"></div>';
  fresh();
  const box = document.querySelector("textarea")!;
  for (const key of ["s", "e", "c", "r", "e", "t"]) box.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
  document.querySelector("#stage")!.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
  expect(written()).toEqual([
    expect.stringMatching(/^\[action\] .* key key=cmd\+Enter in="Talk to Scarlet"$/),
    expect.stringMatching(/^\[action\] .* key key=k$/),
  ]);
});

it("names a control by its kind, not its words, where the words are the editor's own", () => {
  document.body.innerHTML = '<div role="group" aria-label="Queued requests" data-log-private><button class="queue-remove" aria-label="Remove from the queue: cut my secret">×</button>'
    + '<button class="queue-head" aria-expanded="false"><span>cut my secret</span></button></div>';
  fresh();
  for (const button of document.querySelectorAll("button")) button.click();
  expect(written()).toEqual([
    expect.stringMatching(/^\[action\] .* click on=button\.queue-remove in="Queued requests"$/),
    expect.stringMatching(/^\[action\] .* click on=button\.queue-head in="Queued requests" expanded=false$/),
  ]);
});

it("keeps a queued request's words out of the log when its row is pressed or removed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const items = [{ id: "a", text: "trim the bit about my salary" }, { id: "b", text: "and the part where I name my boss", target: "Cut at 2:05" }];
  await act(async () => root.render(createElement(QueueTray, { items, onRemove() {} })));
  fresh();
  // Closed, the tray's one line reads the next request; open, each row's × is labelled with its request.
  await act(async () => host.querySelector<HTMLElement>(".queue-head .queue-text")!.click());
  await act(async () => host.querySelector<HTMLElement>(".queue-remove")!.click());
  await act(async () => host.querySelector<HTMLElement>(".queue-row .queue-text")!.click());
  const log = written().join("\n");
  expect(log.match(/\[action\]/g)).toHaveLength(3);
  expect(log).toContain('in="Queued requests"');
  expect(log).not.toMatch(/salary|boss/);
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

/** Mutations are delivered after the code that made them. */
const drawn = async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); };

it("logs each alert the window puts up, once, as a warning", async () => {
  document.body.innerHTML = '<section role="region" aria-label="Message"><div id="slot"></div></section>';
  await drawn();
  fresh();
  const slot = document.querySelector("#slot")!;
  slot.innerHTML = '<p role="alert" class="simple-error">Wait for the current edit to finish.</p>';
  await drawn();
  // The same alert drawn again says nothing new. New words in it, or a new alert, do.
  slot.querySelector("p")!.className = "simple-error is-shown";
  slot.querySelector("p")!.firstChild!.textContent = "Wait for the current edit to finish.";
  await drawn();
  slot.querySelector("p")!.firstChild!.textContent = "Pick a point on the timeline first.";
  await drawn();
  slot.innerHTML = '<div><span role="alert">Couldn’t load older history: no project</span></div>';
  await drawn();
  expect(lines.map(line => line.replace(/^\[error\] \S+ \S+ /, ""))).toEqual([
    'alert message="Wait for the current edit to finish." in=Message',
    'alert message="Pick a point on the timeline first." in=Message',
    'alert message="Couldn’t load older history: no project" in=Message',
  ]);
  expect(levels).toEqual(["warn", "warn", "warn"]);
});

it("leaves what the editor typed out of an alert's line", async () => {
  fresh();
  const alert = document.body.appendChild(document.createElement("div"));
  alert.setAttribute("role", "alert");
  alert.innerHTML = 'Couldn’t send <span data-log-private>cut the part about my salary</span><textarea>my draft</textarea><input value="typed"> <button>Retry</button>';
  // An alert inside the editor's own words says nothing at all.
  const queue = document.body.appendChild(document.createElement("div"));
  queue.setAttribute("data-log-private", "");
  queue.innerHTML = '<p role="alert">cut the part about my boss</p>';
  await drawn();
  expect(lines).toEqual([expect.stringMatching(/^\[error\] .* alert message="Couldn’t send Retry"$/)]);
});

it("leaves an address out of an alert's line: a failed sign-in shows the page it was sent to", async () => {
  fresh();
  const alert = document.body.appendChild(document.createElement("div"));
  alert.setAttribute("role", "alert");
  alert.textContent = "Opening browser to sign in… https://auth.example.com/authorize?code=true&client_id=abc&state=s3cret\nLogin failed. See file:///Users/me/notes.txt";
  await drawn();
  expect(lines).toEqual([expect.stringMatching(/^\[error\] .* alert message="Opening browser to sign in… … Login failed\. See …"$/)]);
});

it("logs a choice from a fixed set, a switch and a file pick, and never free text", () => {
  document.body.innerHTML = '<select aria-label="Export size"><option>1080p</option><option>4K</option></select>'
    + '<input type="checkbox" aria-label="Captions"><input type="range" aria-label="Volume" value="40"><input type="file" aria-label="Add footage">'
    + '<input type="text" aria-label="Project name" value="Top secret launch">';
  fresh();
  const change = (selector: string, set: (el: HTMLInputElement & HTMLSelectElement) => void) => {
    const el = document.querySelector<HTMLInputElement & HTMLSelectElement>(selector)!;
    set(el);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  change("select", el => { el.selectedIndex = 1; });
  change("[type=checkbox]", el => { el.checked = true; });
  change("[type=range]", el => { el.value = "60"; });
  change("[type=range]", el => { el.value = "70"; });
  change("[type=file]", () => {});
  change("[type=text]", () => {});
  expect(written().map(line => line.replace(/^\[action\] \S+ \S+ /, ""))).toEqual([
    'choose on="Export size" value=4K',
    "set on=Captions value=true",
    // A drag of a slider is one line with a count.
    "set on=Volume value=70 x2",
    'pick-files on="Add footage" files=0',
  ]);
});

it("logs a form sent, by its name", () => {
  document.body.innerHTML = '<form aria-label="New project"><input name="title" value="Top secret launch"></form><form class="rename"></form>';
  fresh();
  for (const form of document.querySelectorAll("form")) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  expect(written()).toEqual([
    expect.stringMatching(/^\[action\] .* submit form="New project"$/),
    expect.stringMatching(/^\[action\] .* submit form=form\.rename$/),
  ]);
});

it("logs a press on something that isn't a control by what it is and where across it the press landed", () => {
  document.body.innerHTML = '<div class="timeline-strip h-2"></div>';
  const strip = document.querySelector<HTMLElement>(".timeline-strip")!;
  strip.getBoundingClientRect = () => ({ left: 100, width: 400, top: 0, height: 10, right: 500, bottom: 10, x: 100, y: 0, toJSON() {} });
  fresh();
  strip.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 200, shiftKey: true }));
  strip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 500 }));
  strip.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100 }));
  expect(written().map(line => line.replace(/^\[action\] \S+ \S+ /, ""))).toEqual([
    "click on=div.timeline-strip across=0.25 mods=shift",
    "double-click on=div.timeline-strip across=1",
    "right-click on=div.timeline-strip across=0",
  ]);
});

it("logs a picture or script that failed to load, without its query, and leaves media to the playback log", () => {
  document.body.innerHTML = '<img src="http://127.0.0.1:5000/api/media/med_1/poster?token=sct_secret"><video src="http://127.0.0.1:5000/api/media/med_1/file"></video>';
  fresh();
  // Load errors don't bubble: the log catches them on their way down from the window.
  for (const el of document.querySelectorAll("img, video")) el.dispatchEvent(new Event("error"));
  expect(lines).toEqual([expect.stringMatching(/^\[error\] .* resource el=img src=\/api\/media\/med_1\/poster\?token$/)]);
  expect(levels).toEqual(["warn"]);
});

it("logs the window gaining and losing focus, its size, the connection and its closing", () => {
  fresh();
  for (const name of ["blur", "focus", "resize", "resize", "offline", "online", "pagehide"]) window.dispatchEvent(new Event(name));
  expect(written().map(line => line.replace(/^\[window\] \S+ \S+ /, ""))).toEqual([
    "blur", "focus", expect.stringMatching(/^resize width=\d+ height=\d+ x2$/), "offline", "online", "closing",
  ]);
  expect(levels).toContain("warn");
});

it("logs going back as a page change, and nothing when the page is the same", () => {
  window.history.pushState({}, "", "/p/prj_1");
  fresh();
  // The browser moves through its history without the router: only the event says so.
  const browserGoes = (to: string, event: string) => {
    History.prototype.replaceState.call(window.history, {}, "", to);
    window.dispatchEvent(new Event(event));
  };
  window.history.replaceState({}, "", "/p/prj_1");
  browserGoes("/p/prj_1", "popstate");
  browserGoes("/", "popstate");
  browserGoes("/#review", "hashchange");
  window.history.replaceState({}, "", "/p/prj_2?thread=tsk_1");
  expect(written().map(line => line.replace(/^\[nav\] \S+ \S+ /, ""))).toEqual([
    "back-forward to=/ from=/p/prj_1",
    "hash to=/#… from=/",
    "replace to=/p/prj_2?thread from=/#…",
  ]);
});

it("stops logging, and gives the console and the history back, when it is stopped", () => {
  const { pushState } = window.history, { error } = console;
  stopUiLog();
  expect(window.history.pushState).not.toBe(pushState);
  expect(console.error).not.toBe(error);
  fresh();
  document.body.innerHTML = "<button>Before</button>";
  document.querySelector("button")!.click();
  window.history.pushState({}, "", "/p/prj_1");
  expect(written()).toEqual([]);
});

it("logs a page change with the names of its query fields only", () => {
  fresh();
  window.history.pushState({}, "", "/p/prj_1?thread=tsk_private&token=sct_secret");
  const [line] = written();
  expect(line).toMatch(/^\[nav\] .* to to=\/p\/prj_1\?thread&token from=\/$/);
  expect(line).not.toContain("sct_secret");
});

it("sends what the console was told to the log as an error", () => {
  const quiet = vi.fn();
  stopUiLog();
  console.error = quiet;
  startUiLog();
  fresh();
  console.error("Minified React error #310", new Error("boom"));
  expect(quiet).toHaveBeenCalledOnce();
  expect(lines).toEqual([expect.stringMatching(/^\[error\] .* console\.error message="Minified React error #310 Error: boom/)]);
  expect(levels).toEqual(["error"]);
});

it("logs each change the window asks of the engine, each failure with its reason, and each slow read", async () => {
  vi.useRealTimers();
  const answers: Record<string, () => Promise<Response>> = {
    "/api/changes/chg_1/approve": async () => new Response("{}", { status: 200 }),
    "/api/projects/prj_gone": async () => new Response(JSON.stringify({ error: { code: "not_found", message: "no project" } }), { status: 404 }),
    "/api/projects/prj_1": async () => new Response("{}", { status: 200 }),
    "/api/projects/prj_slow": async () => { await new Promise(done => setTimeout(done, 1050)); return new Response("{}", { status: 200 }); },
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => answers[new URL(String(input)).pathname]!());
  vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => { throw new TypeError("Load failed"); });
  await loggedFetch("http://127.0.0.1:5000/api/down").catch(() => {});
  await loggedFetch("http://127.0.0.1:5000/api/changes/chg_1/approve?token=sct_secret", { method: "POST", body: "{}" });
  await loggedFetch("http://127.0.0.1:5000/api/projects/prj_gone");
  await loggedFetch("http://127.0.0.1:5000/api/projects/prj_1");
  await loggedFetch("http://127.0.0.1:5000/api/projects/prj_slow");
  await new Promise(done => setTimeout(done, 300));
  const api = lines.filter(line => line.startsWith("[api]")).map(line => line.replace(/^\[api\] \S+ \S+ /, "").replace(/ms=\d+/, "ms=N"));
  expect(api).toEqual([
    'unreachable method=GET path=/api/down ms=N error="TypeError: Load failed"',
    "did method=POST path=/api/changes/chg_1/approve?token status=200 ms=N",
    expect.stringMatching(/^failed method=GET path=\/api\/projects\/prj_gone status=404 ms=N reason=.*not_found/),
    "slow method=GET path=/api/projects/prj_slow status=200 ms=N",
  ]);
});
