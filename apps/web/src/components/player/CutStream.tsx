import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { planPlaybackSegments, type Project, type Timeline } from "@scarlet/timeline";
import { errorMessage } from "../../lib/client";
import { openCutStream, playbackLoader } from "../../lib/cutStream";
import { interactiveFrameUrl, thumbUrl } from "../review/thumbs";
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
  const poster = useMemo(() => {
    const time = usePlayerStore.getState().time;
    return interactiveFrameUrl(thumbUrl(timeline, joins ? joins.toMedia(time) : time, 960));
  }, [timeline, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const [error, setError] = useState<string>();

  const session = useRef<ReturnType<typeof openCutStream>>(undefined);
  useLayoutEffect(() => {
    setStatus("idle");
    setError(undefined);
    return () => { session.current?.dispose(); session.current = undefined; };
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
