import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isPlayableMedia, timelineToSource, type MediaAsset, type Timeline } from "@scarlet/timeline";
import { api } from "../../lib/client";
import { clock } from "../../lib/format";
import { openSourcePlayback } from "../../lib/sourcePlayback";
import { Spinner } from "../ui/primitives";
import { FramedVideo } from "../player/FramedVideo";
import { interactiveFrameUrl, mediaAtId, originalClipAt } from "./thumbs";

/** Play the source frame that corresponds to the comparison playhead. */
export function OriginalFootage({ onVideo, onToggle, onPlaybackChange, timeline, target, end, media, autoPlay, muted, onPosition, onAdvance, failedTimeline, onRetryTimeline }: {
  onVideo(el: HTMLVideoElement | null): void; onToggle(): void; onPlaybackChange(playing: boolean): void;
  timeline?: Timeline; target: { time: number }; end: number; media: MediaAsset[]; autoPlay: boolean; muted?: boolean;
  onPosition(time: number): void; onAdvance(time: number): void; failedTimeline: boolean; onRetryTimeline(): void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    video.current = el;
    onVideo(el);
  }, [onVideo]);
  const moment = useMemo(() => {
    if (!timeline) return;
    const at = target.time;
    const clip = originalClipAt(timeline, at, media);
    if (clip?.kind !== "media") return;
    const asset = mediaAtId(media, clip.mediaId);
    if (asset) return { clip, asset, time: timelineToSource(clip, at), end: Math.min(end, clip.timelineIn + (clip.sourceOut - clip.sourceIn) / (clip.speed || 1)) };
  }, [timeline, target, end, media]);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const session = useRef<ReturnType<typeof openSourcePlayback> | null>(null);
  const wantPlay = useRef(autoPlay);
  const asset = moment?.asset;
  const original = asset && api.mediaFileUrl(asset.id, isPlayableMedia(asset) && asset.previewMode !== "on-demand" && !asset.originalPlaybackType);
  const duration = asset?.duration || (moment && moment.clip.sourceOut);
  const finish = useRef(() => {});
  finish.current = () => { if (moment && wantPlay.current) onAdvance(moment.end); };
  useLayoutEffect(() => {
    setFailed(false);
    const el = video.current;
    if (!el || !asset || !moment || !original || !duration) return;
    const local = openSourcePlayback(el, {
      original,
      chunkUrl: index => api.sourcePreviewUrl(asset.id, index),
      start: moment.time, rate: moment.clip.speed || 1, duration,
      onEnd: () => finish.current(),
      onState: state => { if (state === "failed") setFailed(true); },
    });
    session.current = local;
    return () => { session.current = null; local.dispose(); };
  }, [asset?.id, original, duration, attempt]);
  useLayoutEffect(() => {
    const el = video.current;
    if (!moment || !el || !session.current) return;
    el.defaultPlaybackRate = el.playbackRate = moment.clip.speed || 1;
    session.current.seek(moment.time, true);
    if (wantPlay.current && el.paused) { session.current.prepare(); void el.play().catch(() => {}); }
  }, [original, duration, attempt, target, moment?.clip.id, moment?.clip.speed, moment?.time]);
  if (!timeline) return <div role="status" className="absolute inset-0 grid place-content-center gap-2 text-sm text-muted">
    {failedTimeline ? <>Couldn’t load the original footage.<button className="btn-ghost" onClick={onRetryTimeline}>Retry</button></> : <Spinner />}
  </div>;
  return <>
    {!moment ? <div role="status" className="absolute inset-0 grid place-items-center text-sm text-muted">This moment has no original footage.</div>
      : moment.asset.kind === "image" || moment.asset.kind === "graphic"
        ? <img className="absolute inset-0 w-full h-full object-contain" alt="Original footage" src={interactiveFrameUrl(api.frameUrl(moment.asset.id, moment.time, 960))} />
        : <FramedVideo ref={attachVideo} playsInline muted={muted} onClick={onToggle} preload="auto" aria-label="Original footage"
            onPlay={() => { onPlaybackChange(true); wantPlay.current = true; session.current?.prepare(); }} onPause={e => {
              if (!e.currentTarget.paused) return;
              onPlaybackChange(false);
              if (session.current && !video.current?.ended) { wantPlay.current = false; session.current.pause(); }
            }}
            onTimeUpdate={() => {
              if (!session.current) return;
              const speed = moment.clip.speed || 1;
              const position = moment.clip.timelineIn + (session.current.sourceTime() - moment.clip.sourceIn) / speed;
              if (position >= moment.end && wantPlay.current) onAdvance(moment.end);
              else onPosition(position);
            }} />}
    {failed && <div role="alert" className="absolute inset-0 grid place-content-center gap-2 bg-black/75 text-sm">
      Couldn’t play the original footage.<button className="btn-ghost" onClick={() => setAttempt(n => n + 1)}>Retry</button>
    </div>}
    {moment && !failed && <span className="absolute top-3 left-3 max-w-[45%] truncate rounded-full bg-black/70 px-2 py-1 text-xs text-white">
      Original · {moment.asset.name} · {clock(moment.time)}</span>}
  </>;
}
