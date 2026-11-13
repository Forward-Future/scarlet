import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { MediaAsset } from "@scarlet/timeline";
import { api, errorMessage } from "../../lib/client";
import { transcriptionPaused, transcriptionProgressLabel, transcriptionTasks } from "../../lib/transcriptionProgress";
import { isPreparingMedia } from "../../lib/upload";
import { absTime } from "../../lib/format";
import { useProjectStore } from "../../stores/project";
import { Chip, ConfirmDialog, Icon, Spinner } from "../ui/primitives";
import { MediaStatusLine } from "./MediaStatusLine";

const unknownNotice = "Audio may be sent to OpenAI, depending on your transcription settings.";

export function useImportTranscription() {
  // `local`: the notice only says transcription runs on this computer, which Media and Add from a link leave out.
  // No notice until the settings answer: the OpenAI one would flash each time Media opens, also where audio stays here.
  const [policy, setPolicy] = useState<{ available?: boolean | null; notice: string; local?: boolean }>({ notice: "" });
  useEffect(() => {
    let live = true;
    void api.settings().then(({ settings, transcriptionAvailable }) => {
      if (!live) return;
      const provider = settings.transcription.provider;
      const notice = provider === "none" || transcriptionAvailable === false ? "Transcription is unavailable. Audio will be imported without a transcript."
        : provider === "whispercpp" ? "Scarlet transcribes imported audio on this computer."
        : "Audio from imported files is sent to OpenAI for transcription.";
      setPolicy({ notice, local: provider === "whispercpp" && transcriptionAvailable !== false,
        available: transcriptionAvailable ?? (provider === "none" ? false : null) });
    }).catch(() => { if (live) setPolicy({ available: null, notice: unknownNotice }); });
    return () => { live = false; };
  }, []);
  return policy;
}

/** Older servers can still accept transcription requests when the capability is unknown. */
export function useTranscriptionAvailability() {
  return useImportTranscription().available;
}

function useTranscriptionRun(asset: MediaAsset) {
  const current = useProjectStore((s) => s.current);
  const tasks = current ? transcriptionTasks(current.tasks, current.media, asset) : [];
  const running = tasks.findLast((t) => ["queued", "claimed", "running"].includes(t.state));
  const latest = tasks.reduce<(typeof tasks)[number] | undefined>((a, b) => !a || (b.createdAt ?? "") > (a.createdAt ?? "") ? b : a, undefined);
  const mediaPaused = !!current?.project.mediaPaused;
  return { running, latest, mediaPaused, paused: transcriptionPaused(latest, mediaPaused) };
}

function RetranscribeIcon({ asset, onClick, blockedReason }: { asset: MediaAsset; onClick?: () => void; blockedReason?: string }) {
  const tipId = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const show = hovered || focused;
  const when = absTime(asset.lastTranscription?.completedAt);
  return <span className="media-retranscribe" onPointerEnter={e => { if (e.pointerType !== "touch") setHovered(true); }} onPointerLeave={() => setHovered(false)}>
    <button type="button" className="edit-card-icon" aria-label="Re-transcribe" aria-describedby={show ? tipId : undefined}
      aria-disabled={blockedReason ? true : undefined} onClick={blockedReason ? undefined : onClick}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onKeyDown={e => {
        if (e.key === "Escape" && show) {
          e.stopPropagation();
          setHovered(false);
          setFocused(false);
        }
      }}><Icon name="refresh" size={13} /></button>
    {show && <span className="media-transcription-tip" role="tooltip" id={tipId}>
      <strong>Re-transcribe</strong>
      <span>{when ? <>Last transcribed <time dateTime={asset.lastTranscription?.completedAt}>{when}</time></> : "Transcription date not recorded"}</span>
      <span>{asset.lastTranscription?.model || "Model not recorded"}</span>
      {blockedReason && <span>{blockedReason}</span>}
    </span>}
  </span>;
}

function ReplaceTranscript({ asset, retry, cloud, start }: { asset: MediaAsset; retry: boolean; cloud: boolean; start: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  return <>
    {retry ? <button type="button" className="simple-link" onClick={() => setConfirming(true)}>Retry</button>
      : <RetranscribeIcon asset={asset} onClick={() => setConfirming(true)} />}
    {confirming && <ConfirmDialog open onClose={() => setConfirming(false)} title={`Re-transcribe “${asset.name}”?`} confirmLabel="Re-transcribe"
      body={`Scarlet will use your transcription settings and replace this file’s saved words and timings when the new transcript is ready.${cloud ? " Its audio will be sent to OpenAI." : ""}`}
      onConfirm={start} />}
  </>;
}

/**
 * A Media row's transcript while it's being made or still to make, shown the way the row shows its cache: its state
 * in a few words with the one thing to do beside them, and a bar under them while it runs. A finished one says
 * Transcribed in gray, so the line that showed its progress doesn't just go.
 */
export function TranscriptLine({ asset, available, cloud = false }: { asset: MediaAsset; available?: boolean | null; cloud?: boolean }) {
  const transcribe = useProjectStore((s) => s.transcribe);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const pending = useRef(false);
  const { running, latest, paused, mediaPaused } = useTranscriptionRun(asset);
  const { name, transcriptId } = asset;
  // The words are saved and linked partway through, while word alignment goes on: the job shows until it's done.
  if (running || starting) {
    const waiting = running?.progress?.stage === "queued";
    const progress = transcriptionProgressLabel(running?.progress);
    const text = waiting ? "Waiting to transcribe" : progress ? "Transcribing" : "Transcribing…";
    return <MediaStatusLine name={name} status={{ text, tone: "busy" }}
      bar={waiting ? undefined : { label: `Transcribing ${name}`, fraction: running?.progress?.fraction, percent: progress }} />;
  }
  const savedStatus = transcriptId ? { text: "Transcribed", tone: "done" as const } : { text: "No transcript", tone: "idle" as const };
  if (isPreparingMedia(asset) || (transcriptId && asset.status === "failed")) return transcriptId ? <MediaStatusLine name={name} status={savedStatus} /> : null;
  if (available === false) {
    return <MediaStatusLine name={name} status={savedStatus}>
      <Link to="/settings" className="simple-link">Set up transcription</Link>
    </MediaStatusLine>;
  }
  // The pause stopped this run and resume starts it again. It reads like Caching paused, with nothing to retry.
  if (paused) return <MediaStatusLine name={name} status={{ text: "Transcription paused", tone: "idle" }} />;
  async function start() {
    if (pending.current) return;
    pending.current = true;
    setError("");
    setStarting(true);
    try {
      await transcribe(asset.id);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      pending.current = false;
      setStarting(false);
    }
  }
  const failure = error || (latest?.state === "failed" ? latest.error || "Transcription failed." : "");
  const blocked = available === undefined || mediaPaused;
  const status = failure ? { text: failure, tone: "bad" as const } : savedStatus;
  return <MediaStatusLine name={name} status={mediaPaused && transcriptId && !failure ? { ...status, text: "Transcribed · caching paused" } : status}>
    {transcriptId && !blocked ? <ReplaceTranscript asset={asset} retry={!!failure} cloud={cloud} start={start} />
      : transcriptId && !failure ? <RetranscribeIcon asset={asset} blockedReason={mediaPaused ? "Resume caching to re-transcribe this file." : "Checking transcription settings…"} />
      : <button type="button" className="simple-link" disabled={blocked}
          title={mediaPaused ? "Resume caching to transcribe this file." : undefined} onClick={() => void start()}>{failure ? "Retry" : "Transcribe"}</button>}
  </MediaStatusLine>;
}

/** The transcript pane's way to start a transcription. A Media row uses `TranscriptLine`. */
export function TranscriptionAction({ asset, available, disabled }: { asset: MediaAsset; available?: boolean | null; disabled?: boolean }) {
  const transcribe = useProjectStore((s) => s.transcribe);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const { running, latest } = useTranscriptionRun(asset);
  if (starting || running) {
    const progress = transcriptionProgressLabel(running?.progress);
    return <Chip tone="info"><Spinner className="size-2.5" /> Transcribing{progress && ` · ${progress}`}</Chip>;
  }
  if (isPreparingMedia(asset)) return null;
  if (available === false) return <Link to="/settings" className="btn-ghost">Set up transcription</Link>;
  async function start() {
    if (starting) return;
    setError("");
    setStarting(true);
    try {
      await transcribe(asset.id);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setStarting(false);
    }
  }
  const failure = error || (latest?.state === "failed" ? latest.error || "Transcription failed." : "");
  return <div className="flex max-w-full flex-wrap items-center gap-2">
    {failure && <span role="alert" className="text-bad text-[12px] break-words">{failure}</span>}
    <button className="btn-ghost" disabled={disabled || available === undefined} onClick={() => void start()}>{failure ? "Retry transcription" : "Transcribe"}</button>
  </div>;
}
