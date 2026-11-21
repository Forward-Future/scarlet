import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { MediaAsset } from "@scarlet/timeline";
import { api, errorMessage } from "../../lib/client";
import { transcriptionPaused, transcriptionProgressLabel, transcriptionTasks } from "../../lib/transcriptionProgress";
import { isPreparingMedia } from "../../lib/upload";
import { absTime } from "../../lib/format";
import { useProjectStore } from "../../stores/project";
import { ConfirmDialog, Icon } from "../ui/primitives";
import { MediaStatusLine } from "./MediaStatusLine";

const unknownNotice = "Audio may be sent to OpenAI, depending on your transcription settings.";

/** What fixes transcription that can't run: a setting Scarlet can change at once, or the Settings page that holds the choice. */
type TranscriptionFix = { label: string; to: string } | { label: string; turnOnLocal: true };

export function useImportTranscription() {
  // `local`: the notice only says transcription runs on this computer, which Media leaves out.
  // No notice until the settings answer: the OpenAI one would flash each time Media opens, also where audio stays here.
  const [policy, setPolicy] = useState<{ available?: boolean | null; notice: string; local?: boolean; fix?: TranscriptionFix }>({ notice: "" });
  const [revision, setRevision] = useState(0);
  const [fixing, setFixing] = useState(false);
  const [fixError, setFixError] = useState("");
  useEffect(() => {
    let live = true;
    void api.settings().then(({ settings, transcriptionAvailable, transcriptionIssue }) => {
      if (!live) return;
      const tr = settings.transcription;
      const provider = tr.provider;
      const unavailable = provider === "none" || transcriptionAvailable === false;
      const notice = unavailable ? `${transcriptionIssue ?? "Transcription is unavailable."} Audio will be imported without a transcript.`
        : provider === "whispercpp" ? "Scarlet transcribes imported audio on this computer."
        : "Audio from imported files is sent to OpenAI for transcription.";
      // OpenAI with no key: local transcription is one click away. A local runtime that can't run is set up in Settings.
      const fix: TranscriptionFix | undefined = !unavailable ? undefined
        : provider === "openai" ? { label: "Use local transcription", turnOnLocal: true }
        : { label: "Set up transcription", to: tr.localModel === "custom" ? "/settings#advanced" : "/settings" };
      setPolicy({ notice, fix, local: provider === "whispercpp" && transcriptionAvailable !== false,
        available: transcriptionAvailable ?? (provider === "none" ? false : null) });
    }).catch(() => { if (live) setPolicy({ available: null, notice: unknownNotice }); });
    return () => { live = false; };
  }, [revision]);
  const turnOnLocal = async () => {
    setFixing(true);
    setFixError("");
    try {
      const { settings } = await api.settings();
      await api.updateSettings({ transcription: { ...settings.transcription, provider: "whispercpp" } });
      setRevision(r => r + 1);
    } catch (e) {
      setFixError(errorMessage(e));
    } finally {
      setFixing(false);
    }
  };
  return { ...policy, fixing, fixError, turnOnLocal };
}

/** The import notice, with the one action that lets imports be transcribed when they can't be. */
export function ImportTranscriptionNotice({ policy }: { policy: ReturnType<typeof useImportTranscription> }) {
  const { notice, fix, fixing, fixError, turnOnLocal } = policy;
  if (!notice) return null;
  return <p className="import-transcription-notice mb-3 text-muted text-[12px]">
    {notice}
    {fix && <>{" "}{"to" in fix
      ? <Link to={fix.to} className="simple-link">{fix.label}</Link>
      : <button type="button" className="simple-link" disabled={fixing} onClick={() => void turnOnLocal()}>{fix.label}</button>}</>}
    {fixError && <span role="alert" className="block text-bad">{fixError}</span>}
  </p>;
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

/**
 * How a file's transcript stands in the Transcript column, in a few plain words: the column offers nothing to press
 * for it. Media is where a transcription is started or retried (`TranscriptLine`).
 */
export function TranscriptionStatus({ asset }: { asset: MediaAsset }) {
  const { running, latest, paused } = useTranscriptionRun(asset);
  const progress = transcriptionProgressLabel(running?.progress);
  const text = running ? running.progress?.stage === "queued" ? "Waiting to transcribe" : progress ? `Transcribing ${progress}` : "Transcribing…"
    : isPreparingMedia(asset) ? "Adding"
    : paused ? "Transcription paused"
    : latest?.state === "failed" ? "Transcription stopped"
    : "No transcript";
  return <span>{text}</span>;
}
