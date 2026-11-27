// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StyleGuideRecord, StyleGuideSound } from "@scarlet/shared";
import { api } from "../../lib/client";
import { resolveStyleSoundSource, useStyleSoundPlayer, type StyleSoundPlayer } from "./stageAudio";

const now = "2026-11-24T12:00:00.000Z";
const sound = (s: Partial<StyleGuideSound> & Pick<StyleGuideSound, "id" | "source">): StyleGuideSound =>
  ({ name: s.id, volumeDb: -10, usageRule: "", ...s });
const guide: StyleGuideRecord = {
  id: "sg_main", name: "channel-brand", description: "", instructions: "", isDefault: false, assets: [], transitions: [],
  sounds: [
    sound({ id: "sfx_pop", source: "builtin", builtInId: "subtle-pop", volumeDb: -6 }),
    sound({ id: "sfx_chime", source: "builtin", builtInId: "clean-chime", volumeDb: -8, duration: 2 }),
    sound({ id: "sfx_hit", source: "asset", assetId: "ast_hit", volumeDb: -12, duration: 0.8 }),
    sound({ id: "sfx_lost", source: "builtin", builtInId: "no-such-sound" }),
    sound({ id: "sfx_noasset", source: "asset" }),
  ],
  createdAt: now, updatedAt: now,
};

describe("resolveStyleSoundSource", () => {
  beforeEach(() => {
    vi.spyOn(api, "builtInStyleSoundUrl").mockImplementation(id => `/sounds/${id}`);
    vi.spyOn(api, "styleGuideAssetUrl").mockImplementation((g, a) => `/guides/${g}/assets/${a}`);
  });
  afterEach(() => vi.restoreAllMocks());

  it("finds a starter by its builtin: key at its own mix level", () => {
    expect(resolveStyleSoundSource(null, "builtin:soft-whoosh")).toEqual({ url: "/sounds/soft-whoosh", volumeDb: -14, duration: 0.45 });
    expect(resolveStyleSoundSource(null, "builtin:no-such-sound")).toBeUndefined();
  });

  it("plays a saved starter at the level saved in the style, with the starter's length when none was saved", () => {
    const pop = resolveStyleSoundSource(guide, "sfx_pop")!;
    expect(pop.url).toBe("/sounds/subtle-pop");
    expect(pop.volumeDb).toBe(-6);
    expect(pop.duration).toBeGreaterThan(0);
    expect(resolveStyleSoundSource(guide, "sfx_chime")).toEqual({ url: "/sounds/clean-chime", volumeDb: -8, duration: 2 });
  });

  it("plays an uploaded sound from the style's assets", () => {
    expect(resolveStyleSoundSource(guide, "sfx_hit")).toEqual({ url: "/guides/sg_main/assets/ast_hit", volumeDb: -12, duration: 0.8 });
  });

  it("finds a starter by its bare id, and nothing for a key it doesn't know", () => {
    expect(resolveStyleSoundSource(guide, "crisp-tick")?.url).toBe("/sounds/crisp-tick");
    expect(resolveStyleSoundSource(null, "crisp-tick")?.url).toBe("/sounds/crisp-tick");
    expect(resolveStyleSoundSource(guide, "sfx_lost")).toBeUndefined();
    expect(resolveStyleSoundSource(guide, "sfx_noasset")).toBeUndefined();
    expect(resolveStyleSoundSource(guide, "sfx_missing")).toBeUndefined();
    expect(resolveStyleSoundSource(null, "sfx_hit")).toBeUndefined();
  });
});

describe("resolveStyleSoundSource in the sample interview", () => {
  afterEach(() => {
    vi.doUnmock("../../lib/client");
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("synthesizes each starter once as a local file instead of asking the engine", async () => {
    vi.resetModules();
    vi.doMock("../../lib/client", async original => ({ ...await original<typeof import("../../lib/client")>(), IS_MOCK: true }));
    const created: Blob[] = [];
    vi.stubGlobal("URL", Object.assign(class extends URL {}, {
      createObjectURL: (blob: Blob) => { created.push(blob); return `blob:sound-${created.length}`; },
      revokeObjectURL: () => {},
    }));
    const { resolveStyleSoundSource: resolve } = await import("./stageAudio");
    const { api: mockedApi } = await import("../../lib/client");
    const ask = vi.spyOn(mockedApi, "builtInStyleSoundUrl");
    expect(resolve(null, "builtin:soft-whoosh")?.url).toBe("blob:sound-1");
    expect(resolve(guide, "sfx_pop")?.url).toBe("blob:sound-2");
    // The same starter again reuses its file.
    expect(resolve(null, "soft-whoosh")?.url).toBe("blob:sound-1");
    expect(created.map(b => b.type)).toEqual(["audio/wav", "audio/wav"]);
    expect(created[0]!.size).toBeGreaterThan(44);
    expect(ask).not.toHaveBeenCalled();
  });

  it("has no starter to play where files can't be made", async () => {
    vi.resetModules();
    vi.doMock("../../lib/client", async original => ({ ...await original<typeof import("../../lib/client")>(), IS_MOCK: true }));
    vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: undefined }));
    const { resolveStyleSoundSource: resolve } = await import("./stageAudio");
    expect(resolve(null, "builtin:soft-whoosh")).toBeUndefined();
    expect(resolve(guide, "sfx_pop")).toBeUndefined();
    expect(resolve(null, "crisp-tick")).toBeUndefined();
  });
});

/** An <audio> element as the player drives it: it plays when asked, and the test says how far it got. */
class FakeAudio extends EventTarget {
  static made: FakeAudio[] = [];
  static refuse = false;
  volume = 1;
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
  ended = false;
  constructor(public src: string) {
    super();
    FakeAudio.made.push(this);
  }
  play() {
    this.paused = false;
    return FakeAudio.refuse ? Promise.reject(new Error("NotAllowedError")) : Promise.resolve();
  }
  pause() { this.paused = true; }
}

describe("useStyleSoundPlayer", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: StyleSoundPlayer;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;

  function Probe({ of }: { of: StyleGuideRecord | null }) {
    current = useStyleSoundPlayer(of);
    return null;
  }
  const mount = (of: StyleGuideRecord | null = guide) => act(async () => root.render(<Probe of={of} />));
  /** Runs the frames waiting now. */
  const frame = () => act(async () => {
    const waiting = [...frames.values()];
    frames.clear();
    waiting.forEach(cb => cb(performance.now()));
  });

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    FakeAudio.made = [];
    FakeAudio.refuse = false;
    vi.stubGlobal("Audio", FakeAudio);
    frames = new Map();
    nextFrame = 1;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.set(nextFrame, cb); return nextFrame++; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
    vi.spyOn(api, "builtInStyleSoundUrl").mockImplementation(id => `/sounds/${id}`);
    vi.spyOn(api, "styleGuideAssetUrl").mockImplementation((g, a) => `/guides/${g}/assets/${a}`);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("plays a sound at its mix level and follows its progress until it ends", async () => {
    await mount();
    expect(current.playingId).toBeNull();
    await act(async () => current.play("sfx_hit"));
    const audio = FakeAudio.made[0]!;
    expect(audio.src).toBe("/guides/sg_main/assets/ast_hit");
    expect(audio.volume).toBeCloseTo(0.2512, 4);
    expect(current.playingId).toBe("sfx_hit");
    expect(current.progress).toBe(0);
    // Until the file says how long it is, the saved length stands in.
    audio.currentTime = 0.4;
    await frame();
    expect(current.progress).toBeCloseTo(0.5);
    audio.duration = 1.6;
    audio.currentTime = 0.8;
    await frame();
    expect(current.progress).toBeCloseTo(0.5);
    audio.currentTime = 4;
    await frame();
    expect(current.progress).toBe(1);
    await act(async () => { audio.ended = true; audio.dispatchEvent(new Event("ended")); });
    expect(current.playingId).toBeNull();
    expect(current.progress).toBe(0);
    expect(audio.src).toBe("");
    expect(audio.paused).toBe(true);
  });

  it("stops following progress once the sound pauses on its own", async () => {
    await mount();
    await act(async () => current.play("builtin:crisp-tick"));
    const audio = FakeAudio.made[0]!;
    audio.paused = true;
    await frame();
    expect(frames.size).toBe(0);
    expect(current.playingId).toBe("builtin:crisp-tick");
  });

  it("plays at the level asked for, kept within full volume", async () => {
    await mount();
    await act(async () => current.play("builtin:soft-whoosh", 6));
    expect(FakeAudio.made[0]!.volume).toBe(1);
    await act(async () => current.play("builtin:soft-whoosh", -100));
    expect(FakeAudio.made[1]!.volume).toBeCloseTo(0.004, 3);
  });

  it("stops the sound playing when another starts, and ignores the first one's late events", async () => {
    await mount();
    await act(async () => current.play("sfx_hit"));
    const first = FakeAudio.made[0]!;
    await act(async () => current.play("sfx_pop"));
    const second = FakeAudio.made[1]!;
    expect(first.paused).toBe(true);
    expect(first.src).toBe("");
    expect(current.playingId).toBe("sfx_pop");
    await act(async () => { first.dispatchEvent(new Event("ended")); first.dispatchEvent(new Event("error")); });
    expect(current.playingId).toBe("sfx_pop");
    expect(second.paused).toBe(false);
  });

  it("stops when the sound can't load or isn't allowed to play", async () => {
    await mount();
    await act(async () => current.play("sfx_hit"));
    await act(async () => { FakeAudio.made[0]!.dispatchEvent(new Event("error")); });
    expect(current.playingId).toBeNull();
    FakeAudio.refuse = true;
    await act(async () => current.play("sfx_pop"));
    expect(current.playingId).toBeNull();
  });

  it("ignores a refusal that comes back after another sound started", async () => {
    await mount();
    let refuse!: () => void;
    const play = vi.spyOn(FakeAudio.prototype, "play").mockImplementationOnce(() => new Promise((_, reject) => { refuse = () => reject(new Error("NotAllowedError")); }));
    await act(async () => current.play("sfx_hit"));
    play.mockRestore();
    await act(async () => current.play("sfx_pop"));
    await act(async () => refuse());
    expect(current.playingId).toBe("sfx_pop");
  });

  it("plays nothing for a sound it can't find, or without audio", async () => {
    await mount();
    await act(async () => current.play("sfx_missing"));
    expect(FakeAudio.made).toHaveLength(0);
    expect(current.playingId).toBeNull();
    vi.stubGlobal("Audio", undefined);
    await act(async () => current.play("sfx_hit"));
    expect(current.playingId).toBeNull();
  });

  it("stops on request and when it goes away", async () => {
    await mount();
    await act(async () => current.play("sfx_hit"));
    await act(async () => current.stop());
    expect(current.playingId).toBeNull();
    expect(frames.size).toBe(0);
    // Stopping with nothing playing is harmless.
    await act(async () => current.stop());
    await act(async () => current.play("sfx_pop"));
    const audio = FakeAudio.made[1]!;
    await act(async () => root.unmount());
    expect(audio.paused).toBe(true);
    expect(frames.size).toBe(0);
    root = createRoot(container);
  });

  it("drops a frame scheduled for a sound that was replaced", async () => {
    await mount();
    await act(async () => current.play("sfx_hit"));
    const stale = [...frames.values()][0]!;
    await act(async () => current.play("sfx_pop"));
    FakeAudio.made[0]!.currentTime = 0.4;
    await act(async () => stale(performance.now()));
    expect(current.progress).toBe(0);
  });
});
