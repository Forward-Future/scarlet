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
import { FramedVideo } from "./FramedVideo";

export function CutStream({ project, timeline, version, onStart, draft = false, proposed = false, joins }: { project: Project; timeline: Timeline; version: string; onStart(): void; draft?: boolean; proposed?: boolean; joins?: JoinClock }) {
  const video = useRef<HTMLVideoElement>(null);
  // Planned from the frame rate alone. Any other update to the project, such as media processing pausing or a
  // reconnect, brings a new settings object, and reopening the stream for it would stop playback on a still.
  const plan = useMemo(() => {
    try { return { ranges: planPlaybackSegments({ settings: project.settings }, timeline) }; }
    catch (reason) { return { ranges: [], error: errorMessage(reason) }; }
  }, [project.settings.fps, timeline]); // eslint-disable-line react-hooks/exhaustive-deps
  const { ranges } = plan;
  const [status, setStatus] = useState<"idle" | "waiting" | "ready">("idle");
  const poster = useMemo(() => {
    const time = usePlayerStore.getState().time;
    return interactiveFrameUrl(thumbUrl(timeline, joins ? joins.toMedia(time) : time, 960));
  }, [timeline, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const [error, setError] = useState<string>();

  useLayoutEffect(() => {
    const el = video.current!;
    let session: ReturnType<typeof openCutStream> | undefined;
    const failed = (reason: unknown) => {
      session = undefined;
      setStatus("idle");
      setError(errorMessage(reason));
    };
    setStatus("idle");
    setError(undefined);
    player.attach(el, {
      duration: ranges.at(-1)?.end,
      prepare() {
        if (plan.error || session) return;
        onStart();
        setError(undefined);
        setStatus("waiting");
        try {
          const saved = usePlayerStore.getState();
          el.playbackRate = saved.rate;
          session = openCutStream(el, ranges, player.mediaTime(saved.time), playbackLoader(project.id, version), failed);
        } catch (reason) {
          // A stream logs its own failures. One that couldn't open has no stream to say so.
          playbackLog("stream open-failed", { version, sections: ranges.length, error: String(reason) });
          failed(reason);
        }
      },
      seek(time) { session?.seek(time); },
      finishSeek() { session?.finishSeek(); },
      sourceTime() { return session?.sourceTime() ?? el.currentTime; },
    });
    if (draft) { player.seek(0); player.play(); }
    return () => {
      player.detach();
      session?.dispose();
    };
  }, [project.id, ranges, plan.error, version, onStart, draft]);
  useLayoutEffect(() => player.setJoins(video.current, joins), [joins, project.id, ranges, version, onStart, draft]);

  // A section on its way is marked on the video. The monitor's play button shows the wait, in place of its icon.
  const waiting = status === "waiting" && !error;
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
