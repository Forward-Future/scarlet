import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { planPlaybackSegments, timelineDuration, type Project, type Timeline } from "@scarlet/timeline";
import { errorMessage } from "../../lib/client";
import { openCutStream, playbackLoader } from "../../lib/cutStream";
import { cutFrameUrl, interactiveFrameUrl } from "../review/thumbs";
import { player } from "../../lib/player";
import { playbackLog } from "../../lib/playbackLog";
import type { JoinClock } from "../../lib/joinClock";
import { usePlayerStore } from "../../stores/player";
import { Icon } from "../ui/primitives";
import { decoderLeadIn, parkVideo } from "./parkVideo";
import { FramedVideo } from "./FramedVideo";

export function CutStream({ project, timeline, version, onStart, draft = false, proposed = false, joins, parkedAt }: { project: Project; timeline: Timeline; version: string; onStart(): void; draft?: boolean; proposed?: boolean; joins?: JoinClock; parkedAt?: number }) {
  const video = useRef<HTMLVideoElement>(null);
  const parkedFrame = useRef<number>(undefined);
  const wasActive = useRef(false);
  // Planned from the frame rate alone. Any other update to the project, such as media processing pausing or a
  // reconnect, brings a new settings object, and reopening the stream for it would stop playback on a still.
  const plan = useMemo(() => {
    try { return { ranges: planPlaybackSegments({ settings: project.settings }, timeline) }; }
    catch (reason) { return { ranges: [], error: errorMessage(reason) }; }
  // Activating a prepared cut can deliver a separately loaded copy of the same immutable timeline.
  // Keep the native buffer and its prepared frame when its version and frame grid still match.
  }, [project.id, project.settings.fps, timeline.version, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const { ranges } = plan;
  const [status, setStatus] = useState<"idle" | "waiting" | "ready">("idle");
  const [preroll, setPreroll] = useState<AbortSignal>();
  const poster = usePoster(project, timeline, version, joins);
  const [error, setError] = useState<string>();

  const session = useRef<ReturnType<typeof openCutStream>>(undefined);
  useLayoutEffect(() => {
    setStatus("idle");
    setError(undefined);
    return () => {
      // The transport lets go of the video first. Closing the stream stops it, and the transport would take a video
      // stopped that way for one the editor paused, instead of playing on in the one put up in its place.
      const el = video.current;
      if (el && player.element() === el) player.detach();
      session.current?.dispose();
      session.current = undefined;
    };
  }, [project.id, ranges, version]);

  useLayoutEffect(() => {
    const el = video.current!;
    const failed = (reason: unknown) => {
      session.current = undefined;
      setStatus("idle");
      setError(errorMessage(reason));
    };
    const prepare = (start: number) => {
      if (plan.error || session.current) return;
      setError(undefined);
      setStatus("waiting");
      try {
        el.playbackRate = usePlayerStore.getState().rate;
        session.current = openCutStream(el, ranges, start, playbackLoader(project.id, version), failed);
      } catch (reason) {
        playbackLog("stream open-failed", { version, sections: ranges.length, error: String(reason) });
        failed(reason);
      }
    };
    if (parkedAt !== undefined) {
      parkedFrame.current = parkedAt;
      const outgoing = wasActive.current;
      wasActive.current = false;
      if (!session.current) prepare(decoderLeadIn(parkedAt));
      return parkVideo(el, parkedAt, project.settings.fps, time => {
        session.current?.seek(time);
        el.currentTime = time;
        session.current?.finishSeek();
      }, outgoing ? player.element : undefined);
    }
    player.attach(el, {
      duration: ranges.at(-1)?.end,
      prepare() {
        if (plan.error || session.current) return;
        onStart();
        prepare(player.mediaTime(usePlayerStore.getState().time));
      },
      bufferThrough(start, end, signal) {
        if (!session.current) return;
        setPreroll(signal);
        // The first fragment may already have fired canplay while the other side of the join is still rendering.
        return session.current.bufferThrough(start, end, signal).finally(() => {
          setPreroll(current => current === signal ? undefined : current);
        });
      },
      seek(time) { session.current?.seek(time); },
      finishSeek() { session.current?.finishSeek(); },
      sourceTime() { return session.current?.sourceTime() ?? el.currentTime; },
    }, parkedFrame.current);
    wasActive.current = true;
    parkedFrame.current = undefined;
    if (draft) { player.seek(0); player.play(); }
    return () => {
      if (player.element() === el) player.detach();
      if (!el.paused) el.pause();
    };
  }, [project.id, ranges, plan.error, version, onStart, draft, parkedAt]);
  useLayoutEffect(() => player.setJoins(video.current, joins), [joins, project.id, ranges, version, onStart, draft, parkedAt]);

  // A section on its way is marked on the video. The monitor's play button shows the wait, in place of its icon.
  const waiting = (status === "waiting" || !!preroll) && !error;
  return <>
    <FramedVideo ref={video} aria-label={draft || proposed ? "Proposed draft" : "The current edit"}
      poster={poster} playsInline preload="auto" data-waiting={waiting || undefined} onClick={() => player.toggle()} onPlaying={() => setStatus("ready")}
      onWaiting={() => setStatus("waiting")} onCanPlay={() => setStatus("ready")} onSeeked={e => { if (e.currentTarget.readyState >= 2) setStatus("ready"); }} onLoadedData={() => setStatus("ready")} />
    {plan.error && <p role="alert" className="absolute inset-0 grid place-items-center bg-black/75 p-6 text-center">{plan.error}</p>}
    {!plan.error && status !== "ready" && !waiting && (error || draft) && <div className="absolute inset-0 grid place-items-center bg-black/75 p-6 text-center">
      <div>{error && <p role="alert" className="mb-2 text-sm">{error}</p>}
        <button className="btn-ghost" onClick={() => player.play()}><Icon name="play" /> {error ? "Retry playback" : "Play"}</button>
      </div>
    </div>}
  </>;
}

/** The picture a paused stream showed last, so the one put up next at the same moment shows it until its own is in. */
let shownPoster: { project: string; time: number; url: string } | undefined;

/**
 * The picture a stream shows before it plays: the video at the playhead as it plays, with every layer, framing and
 * caption, not the footage of the top clip alone. A screen with the camera inset over it read as the camera full
 * frame, so the picture changed while the editor watched it paused, each time a pass saved (2026-11-20). A new
 * version shows the last picture until its own is in, so a save doesn't flash the monitor black.
 */
function usePoster(project: Project, timeline: Timeline, version: string, joins?: JoinClock) {
  const wanted = useMemo(() => {
    const time = usePlayerStore.getState().time;
    const at = joins ? joins.toMedia(time) : time;
    const last = timelineDuration(timeline) - 1 / project.settings.fps;
    // The version the stream plays, which the engine has whatever copy of its timeline this is.
    const frame = last >= 0 ? cutFrameUrl(project, { ...timeline, version }, Math.max(0, Math.min(at, last)), true, true) : undefined;
    return { time, url: interactiveFrameUrl(frame) };
  }, [timeline, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const [shown, setShown] = useState(() => shownPoster?.project === project.id && Math.abs(shownPoster.time - wanted.time) < 1e-3
    ? shownPoster.url : wanted.url);
  useEffect(() => {
    const { url, time } = wanted;
    if (!url) return setShown(undefined);
    const picture = new Image();
    picture.onload = () => {
      shownPoster = { project: project.id, time, url };
      setShown(url);
    };
    picture.onerror = () => setShown(url);
    picture.src = url;
    return () => { picture.onload = picture.onerror = null; };
  }, [wanted, project.id]);
  return shown;
}
