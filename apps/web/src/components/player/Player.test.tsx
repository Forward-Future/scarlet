// @vitest-environment happy-dom
import { act, Profiler, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MediaAsset } from "@scarlet/timeline";
import { fullRenderContext } from "@scarlet/shared";
import { api } from "../../lib/client";
import * as cutStream from "../../lib/cutStream";
import { buildDb, PRJ } from "../../lib/mock/fixtures";
import { player } from "../../lib/player";
import * as sourcePlayback from "../../lib/sourcePlayback";
import { usePlayerStore } from "../../stores/player";
import { useProjectStore, type ProjectData } from "../../stores/project";
import { Player } from "./Player";

const db = buildDb();
const project = db.projects.find(p => p.id === PRJ)!;
const clip = project.media.find(m => m.kind === "video")!;
const stores = [useProjectStore.getState(), usePlayerStore.getState()] as const;
let root: Root;
let container: HTMLDivElement;
const onMedia = vi.fn(), onRejectOriginal = vi.fn();

const open = (over: Partial<ProjectData> = {}) => useProjectStore.setState({ status: "ready", refreshFullRenders: vi.fn(),
  current: { id: PRJ, project, timeline: db.timelines[project.head!]!, media: project.media, changes: [], notes: [], renders: [], tasks: [], taskEvents: {}, ...over } });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  usePlayerStore.setState({ time: 0, rate: 1, playing: false });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  onMedia.mockClear();
  onRejectOriginal.mockClear();
  open();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useProjectStore.setState(stores[0], true);
  usePlayerStore.setState(stores[1], true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const show = (props: Partial<ComponentProps<typeof Player>> = {}) => act(async () => root.render(
  <Player autoPlaySource={false} cut={false} hidden={false} active onRejectOriginal={onRejectOriginal} onMedia={onMedia} {...props} />));
const video = () => container.querySelector("video");
const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === text);
/** A clip the engine made a whole preview file for, as older projects have. */
const prepared = (over: Partial<MediaAsset> = {}): MediaAsset => ({ ...clip, status: "ready", previewMode: undefined, originalPlaybackType: undefined, ...over });

it("keeps the cut player out of agent progress updates", async () => {
  const commit = vi.fn();
  await act(async () => root.render(<Profiler id="player" onRender={commit}>
    <Player autoPlaySource={false} cut hidden={false} active onRejectOriginal={onRejectOriginal} onMedia={onMedia} />
  </Profiler>));
  commit.mockClear();
  await act(async () => useProjectStore.setState(s => ({ current: { ...s.current!, taskEvents: { report: [] } } })));
  expect(commit).not.toHaveBeenCalled();
});

it("asks for footage in an empty project, and points at Media when nothing there can play yet", async () => {
  open({ media: [] });
  await show();
  expect(container.textContent).toContain("Add footage to start editing");
  await act(async () => button("Add footage")!.click());
  expect(onMedia).toHaveBeenCalledTimes(1);
  await act(async () => open());
  await show();
  expect(container.textContent).toContain("No playable footage yet");
  expect(button("View media")).toBeDefined();
  expect(video()).toBeNull();
});

it("says a clip's preview is being prepared, and why it couldn't be when that failed", async () => {
  await show({ source: prepared({ status: "ingesting", preparation: undefined }) });
  expect(container.textContent).toContain("Preparing a compatible preview…");
  expect(video()).toBeNull();
  await show({ source: prepared({ status: "failed", error: "This file has no video stream." }) });
  expect(container.textContent).toBe("This file has no video stream.");
  await show({ source: prepared({ status: "failed", error: undefined }) });
  expect(container.textContent).toBe("The preview couldn’t be prepared.");
});

it("plays a clip's prepared preview from where the editor was, and offers to try again when it can't be played", async () => {
  usePlayerStore.setState({ time: 30, rate: 2 });
  await show({ source: prepared({ duration: undefined }) });
  expect(video()?.getAttribute("src")).toBe(api.mediaFileUrl(clip.id, true));
  expect(video()?.getAttribute("aria-label")).toBe(clip.name);
  Object.defineProperty(video()!, "duration", { configurable: true, value: 20 });
  await act(async () => { video()!.dispatchEvent(new Event("loadedmetadata")); });
  // The file is shorter than where the editor was: it opens at its end, at their speed.
  expect([video()!.currentTime, video()!.playbackRate]).toEqual([20, 2]);
  await act(async () => { video()!.dispatchEvent(new Event("error")); });
  expect(video()).toBeNull();
  expect(container.textContent).toContain("Couldn’t play this video.");
  expect(onRejectOriginal).not.toHaveBeenCalled();
  await act(async () => button("Retry")!.click());
  expect(video()?.getAttribute("src")).toBe(api.mediaFileUrl(clip.id, true));
});

it("starts on a clip's original file when the browser can play it, and hands over to the preview when it turns out it can't", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");
  // Still being prepared, so the original is all there is to play.
  const original = prepared({ status: "ingesting", preparation: undefined, originalPlaybackType: "video/quicktime-test" });
  await show({ source: original });
  expect(video()?.getAttribute("src")).toBe(api.mediaFileUrl(clip.id));
  Object.defineProperty(video()!, "currentTime", { configurable: true, value: 8 });
  await act(async () => { video()!.dispatchEvent(new Event("error")); });
  // Where it had got to is kept, and the page is told so it can fall back to the prepared preview.
  expect(onRejectOriginal).toHaveBeenCalledWith(clip.id);
  expect(usePlayerStore.getState().time).toBe(8);
  expect(container.textContent).not.toContain("Couldn’t play this video.");
  await show({ source: original, rejectedOriginal: clip.id });
  expect(container.textContent).toContain("Preparing a compatible preview…");
});

it("plays a long clip section by section, and the edit as a stream until its file is saved", async () => {
  const opened = vi.spyOn(sourcePlayback, "openSourcePlayback").mockReturnValue({ prepare() {}, seek() {}, dispose() {} } as unknown as ReturnType<typeof sourcePlayback.openSourcePlayback>);
  await show({ source: prepared({ previewMode: "on-demand", duration: 600 }) });
  expect(opened).toHaveBeenCalledTimes(1);
  expect(opened.mock.calls[0]![1]).toMatchObject({ duration: 600 });
  // The edit has no saved file yet: it streams, opened only once the editor plays.
  const stream = vi.spyOn(cutStream, "openCutStream").mockImplementation(el => ({ seek() {}, finishSeek() {}, async bufferThrough() {}, sourceTime: () => el.currentTime, dispose() {} }));
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => new Promise(() => {}));
  await show({ cut: true });
  expect(video()?.getAttribute("aria-label")).toBe("The current edit");
  expect(video()?.hasAttribute("src")).toBe(false);
  expect(useProjectStore.getState().refreshFullRenders).toHaveBeenCalled();
  expect(stream).not.toHaveBeenCalled();
  await act(async () => player.play());
  expect(stream).toHaveBeenCalledTimes(1);
});

it("plays the timeline on screen as itself while the edit's new timeline hasn't been read, not the new version at its places", async () => {
  // The edit moved on to v_new, its file is even saved, and its timeline couldn't be read yet: the one before stays on screen.
  const shown = db.timelines[project.head!]!;
  const keys = { context: fullRenderContext({ ...project, head: "v_new" }), preview: "preview-key", delivery: "delivery-key" };
  const full = db.renders.find(r => r.kind === "full")!;
  const saved = { ...full, id: "new-file", projectId: PRJ, version: "v_new", range: null, key: "preview-key", state: "done" as const };
  open({ project: { ...project, head: "v_new" }, timeline: shown, renders: [saved], fullRenderKeys: keys });
  const loader = vi.spyOn(cutStream, "playbackLoader");
  const stream = vi.spyOn(cutStream, "openCutStream").mockImplementation(el => ({ seek() {}, finishSeek() {}, async bufferThrough() {}, sourceTime: () => el.currentTime, dispose() {} }));
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => new Promise(() => {}));
  await show({ cut: true });
  expect(video()?.hasAttribute("src")).toBe(false);
  await act(async () => player.play());
  expect(stream).toHaveBeenCalledTimes(1);
  expect(loader).toHaveBeenCalledWith(PRJ, shown.version);
  // Once the new timeline is read, the stream that was playing plays the new version.
  await act(async () => open({ project: { ...project, head: "v_new" }, timeline: { ...shown, version: "v_new" }, renders: [saved], fullRenderKeys: keys }));
  await act(async () => player.play());
  expect(loader).toHaveBeenLastCalledWith(PRJ, "v_new");
  // A player opened then plays the new version's saved file.
  await act(async () => root.unmount());
  root = createRoot(container);
  await show({ cut: true });
  expect(video()?.getAttribute("src")).toBe(api.renderFileUrl("new-file"));
});
