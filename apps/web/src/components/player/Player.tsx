import { interactiveFrameUrl } from "../review/thumbs";
import { fullRenderContext } from "@scarlet/shared";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { isPlayableMedia, type MediaAsset } from "@scarlet/timeline";
import { canPlayOriginal } from "../../lib/upload";
import { api, IS_MOCK } from "../../lib/client";
import { CutStream } from "./CutStream";
import { FramedVideo } from "./FramedVideo";
import { SourcePlayer } from "./SourcePlayer";
import { player } from "../../lib/player";
import { usePlayerStore } from "../../stores/player";
import { selectHeadRender, useProjectStore } from "../../stores/project";
import { Icon, Spinner } from "../ui/primitives";

export const Player = memo(function Player({ source, autoPlaySource, cut, hidden, active, rejectedOriginal, onRejectOriginal, onMedia }: {
  source?: MediaAsset;
  autoPlaySource: boolean;
  cut: boolean;
  hidden: boolean;
  active: boolean;
  rejectedOriginal?: string;
  onRejectOriginal(id: string): void;
  onMedia(): void;
}) {
  const current = useProjectStore(useShallow(s => {
    if (!cut || !s.current) return null;
    const { id, project, timeline, renders, fullRenderKeys, historyRevision } = s.current;
    return { id, project, timeline, renders, fullRenderKeys, historyRevision };
  }));
  const hasMedia = useProjectStore(s => !!s.current?.media.length);
  const head = current?.project.head;
  const context = head && current && fullRenderContext(current.project);
  useEffect(() => {
    const store = useProjectStore.getState();
    if (active && !hidden && context && store.current?.fullRenderKeys?.context !== context) void store.refreshFullRenders();
  }, [context, active, hidden, current?.historyRevision]);
  // The edit can move on before its new timeline has been read, and stay so while that read is tried again. Meanwhile
  // the timeline on screen is the one before, and it plays as itself: the new version's file, or its footage at the old
  // version's places, would play something the timeline doesn't show.
  const shown = head && current?.timeline ? current.timeline.version : head;
  const render = head && shown === head ? selectHeadRender(current) : undefined;
  // Keep using the same bytes for playback and range seeks throughout this viewing session.
  const [startedOnOriginal] = useState(() => !!source && !isPlayableMedia(source) && canPlayOriginal(source));
  const original = startedOnOriginal && source?.id !== rejectedOriginal;
  const resume = useRef(false);
  const [streaming, setStreaming] = useState(false);
  const [playingCutFile, setPlayingCutFile] = useState<string>();
  const startStreaming = useCallback(() => setStreaming(true), []);
  const src = source
    ? original ? api.mediaFileUrl(source.id) : isPlayableMedia(source) ? api.mediaFileUrl(source.id, true) : undefined
    : playingCutFile ?? (!streaming && render?.state === "done" ? api.renderFileUrl(render.id) : IS_MOCK && shown ? api.renderFileUrl(shown) : undefined);
  const [failedSrc, setFailedSrc] = useState<string>();
  const attach = useCallback((el: HTMLVideoElement | null) => {
    if (el) player.attach(el);
    else player.detach();
  }, []);
  if (source?.kind === "video" && source.duration && (source.previewMode === "on-demand" ||
    (!startedOnOriginal && isPlayableMedia(source) && canPlayOriginal(source) && source.id !== rejectedOriginal))) {
    return <SourcePlayer id={source.id} name={source.name} duration={source.duration}
      autoPlay={autoPlaySource && active && !hidden} hidden={hidden} />;
  }
  // The monitor's own dark shows round the picture, so the ambient light behind it can glow through.
  if (!src && head && current?.timeline) return <div hidden={hidden} className="absolute inset-0">
    <CutStream project={current.project} timeline={current.timeline} version={current.timeline.version} onStart={startStreaming} />
  </div>;
  return (
    <div hidden={hidden} className="absolute inset-0">
      {src && failedSrc !== src ? (
        <FramedVideo key={src} ref={attach} src={src}
          poster={source?.kind === "video" ? interactiveFrameUrl(api.frameUrl(source.id, 0, 960)) : undefined}
          playsInline preload={hidden ? "none" : original ? "auto" : "metadata"}
          autoPlay={!!source && autoPlaySource && source.id !== rejectedOriginal && active && !hidden}
          aria-label={source ? source.name : "The current edit"}
          onPlay={source ? undefined : () => setPlayingCutFile(src)}
          onPause={source ? undefined : () => setPlayingCutFile(undefined)}
          onEnded={source ? undefined : () => setPlayingCutFile(undefined)}
          onError={e => {
            if (original && source?.kind === "video") {
              const v = e.currentTarget;
              const saved = usePlayerStore.getState();
              if (v.currentTime > 0) saved.setTime(v.currentTime);
              resume.current = !v.paused || saved.playing || (!v.readyState && autoPlaySource);
              onRejectOriginal(source.id);
            } else setFailedSrc(src);
          }} onClick={() => player.toggle()}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            const saved = usePlayerStore.getState();
            v.currentTime = Math.min(saved.time, Number.isFinite(v.duration) ? v.duration : saved.time);
            v.playbackRate = saved.rate;
            if (resume.current && active && !hidden) void v.play().catch(() => undefined);
            resume.current = false;
          }} />
      ) : (
        <div className="absolute inset-0 grid place-items-center p-6 text-center">
          {src && failedSrc === src ? <div>
            <p>Couldn’t play this video.</p>
            <button className="btn-ghost mt-2" onClick={() => setFailedSrc(undefined)}>Retry</button>
          </div> : source && !isPlayableMedia(source) ? <div>
            {source.status === "failed" ? <p>{source.error || "The preview couldn’t be prepared."}</p>
              : <span className="inline-flex gap-2 items-center"><Spinner /> Preparing a compatible preview…</span>}
          </div> : <div>
            <p className="font-medium">{hasMedia ? "No playable footage yet" : "Add footage to start editing"}</p>
            <button className="btn-ghost mt-3" onClick={onMedia}><Icon name="film" /> {hasMedia ? "View media" : "Add footage"}</button>
          </div>}
        </div>
      )}
    </div>
  );
});
