// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startAppLog, stopAppLog } from "../lib/appLog";
import { api } from "../lib/client";
import { enqueueImports } from "../components/media/UploadDropzone";
import { ImportPreview } from "./WatchPage";

let root: Root;
let container: HTMLDivElement;
let log: { line: string; level: string }[];
let endImport: () => void;
let project = 0;
const fetched = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  fetched.mockReset();
  vi.stubGlobal("fetch", fetched);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:first-frame");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  // The engine is still copying the file in: the import stays under way for as long as the test needs it.
  vi.spyOn(api, "importMedia").mockImplementation(() => new Promise((_resolve, reject) => { endImport = () => reject(new DOMException("Stopped", "AbortError")); }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  log = [];
  startAppLog((lines, level) => log.push(...lines.map(line => ({ line, level }))));
});

afterEach(async () => {
  await act(async () => root.unmount());
  await act(async () => endImport?.());
  stopAppLog();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A file chosen by path is being imported into a project of its own, and the monitor shows the import. */
const importing = async (path: string) => {
  const projectId = `prj_import_${++project}`;
  await act(async () => { void enqueueImports(projectId, [path]); });
  await act(async () => root.render(<ImportPreview projectId={projectId} onMedia={() => {}} />));
  return projectId;
};
/** The request lines in the log, without their clock or how long the request took. */
const requests = () => { stopAppLog(); return log.filter(l => l.line.startsWith("[api] ")).map(l => [l.level, l.line.replace(/^\[api\] \S+ \+\d+ms /, "").replace(/ ms=\d+/, "")]); };

it("shows the first frame of a file as it comes in, asked for through the logged request, by path alone", async () => {
  fetched.mockResolvedValue(new Response("frame", { status: 200 }));
  const projectId = await importing("/Users/editor/Footage/Board meeting.mov");
  expect(container.textContent).toContain("Board meeting.mov");
  expect(fetched).toHaveBeenCalledTimes(1);
  const [url, init] = fetched.mock.calls[0]!;
  expect(String(url)).toBe(api.url(`/projects/${projectId}/media/import-frame`));
  expect([init?.method, init?.body]).toEqual(["POST", JSON.stringify({ path: "/Users/editor/Footage/Board meeting.mov" })]);
  expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:first-frame");
  // The log has the request and how it ended. Where the editor's file is and what it is called stay out of it.
  expect(requests()).toEqual([["info", `did method=POST path=${new URL(String(url)).pathname} status=200`]]);
  expect(log.map(l => l.line).join("\n")).not.toMatch(/Board|Footage|editor/);
});

it("logs the engine's reason when it can't read a frame, and shows the import without a picture", async () => {
  fetched.mockResolvedValue(new Response(JSON.stringify({ error: { code: "unreadable", message: "No frame could be decoded." } }), { status: 422 }));
  const projectId = await importing("/Volumes/Card/clip.mxf");
  await act(async () => {});
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toContain("clip.mxf");
  expect(requests()).toEqual([["warn", `failed method=POST path=/api/projects/${projectId}/media/import-frame status=422 reason=${JSON.stringify(JSON.stringify({ error: { code: "unreadable", message: "No frame could be decoded." } }))}`]]);
});

it("logs an engine that can't be reached, and one request called off by leaving as stopped, not as a failure", async () => {
  fetched.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  const projectId = await importing("/Volumes/Card/a.mp4");
  await act(async () => {});
  expect(container.querySelector("img")).toBeNull();
  // The next file's frame is still on its way when the monitor goes.
  fetched.mockImplementation((_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))));
  await act(async () => endImport());
  const second = await importing("/Volumes/Card/b.mp4");
  await act(async () => root.render(null));
  await act(async () => {});
  expect(requests()).toEqual([
    ["warn", `unreachable method=POST path=/api/projects/${projectId}/media/import-frame error="TypeError: Failed to fetch"`],
    ["info", `stopped method=POST path=/api/projects/${second}/media/import-frame`],
  ]);
});

it("asks for no frame of a link, which is no file on this computer, and shows it downloading", async () => {
  await importing("https://example.com/Interview.mov");
  await act(async () => {});
  expect(container.textContent).toContain("Interview.mov");
  expect(container.textContent).toContain("Downloading…");
  // The engine would answer 404 for a path it can't find, and the log would keep a failed request for each such link.
  expect(fetched).not.toHaveBeenCalled();
  expect(requests()).toEqual([]);
});

it("asks for no frame of a file that has no picture to show", async () => {
  await importing("/Users/editor/Notes/interview.wav");
  expect(container.textContent).toContain("interview.wav");
  expect(fetched).not.toHaveBeenCalled();
});
