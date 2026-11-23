import { useEffect, useState } from "react";
import { create } from "zustand";
import type { LocalModelStatus, LocalTranscriptionModel, ServerSettings } from "@scarlet/shared";
import { api, errorMessage } from "../../lib/client";
import { desktop } from "../../lib/desktop";
import { Icon, InlineError } from "../ui/primitives";

interface CrisperSetup {
  phase: "idle" | "choosing" | "installing" | "failed";
  error: string;
  revision: number;
}

// Installation continues in the desktop process when the editor leaves Settings.
const useCrisperSetup = create<CrisperSetup>(() => ({ phase: "idle", error: "", revision: 0 }));

async function installFromFolder() {
  const previous = useCrisperSetup.getState();
  if (previous.phase === "choosing" || previous.phase === "installing") return;
  useCrisperSetup.setState({ phase: "choosing", error: "" });
  try {
    const directory = await desktop.pickFolder("Choose the CrisperWhisper model folder");
    if (!directory) {
      useCrisperSetup.setState(previous);
      return;
    }
    useCrisperSetup.setState({ phase: "installing" });
    await desktop.installCrisperModel(directory);
    useCrisperSetup.setState({ phase: "idle", revision: previous.revision + 1 });
  } catch (e) {
    useCrisperSetup.setState({ phase: "failed", error: errorMessage(e) });
  }
}

/** Only show a status read for the model choice the engine has saved. */
export function useLocalModelStatus(source?: ServerSettings["transcription"]): LocalModelStatus | null | undefined {
  const revision = useCrisperSetup(state => state.revision);
  const [result, setResult] = useState<{ source: ServerSettings["transcription"]; revision: number; status: LocalModelStatus | null }>();
  useEffect(() => {
    if (!source || source.provider !== "whispercpp") return;
    const selected = source;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const next = await api.localModelStatus().catch(() => null);
      if (!active) return;
      setResult({ source: selected, revision, status: next });
      timer = setTimeout(poll, next?.state === "downloading" || next?.state === "checking" ? 800 : 3500);
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [source, revision]);
  if (!result || result.source !== source) return;
  // Installation can change what's active, while the saved selection (including legacy preset paths) stays the same.
  if (result.revision !== revision) return { state: "checking", selected: result.status?.selected };
  return result.status;
}

export function useNeedsCrisperSetup(status?: LocalModelStatus | null) {
  const phase = useCrisperSetup(state => state.phase);
  if (status?.state === "ready" && status.active === "crisperwhisper") return false;
  if (phase !== "idle") return true;
  return !!status && status.state !== "checking";
}

export function LocalModelNotice({ model, status }: { model: LocalTranscriptionModel; status?: LocalModelStatus | null }) {
  const fallback = status?.fallback && status.active === "whispercpp";
  let text: string;
  switch (status?.state) {
    case "ready": text = status.active === "crisperwhisper" ? "CrisperWhisper is ready." : model === "custom" ? "Custom model available" : "Model available"; break;
    case "downloading": text = `Downloading model · ${Math.min(99, Math.floor(status.received * 100 / status.total))}%`; break;
    case "failed": text = "Download failed. Retry transcription to download again."; break;
    case "invalid": text = model === "custom" ? "Check your model file and adapter in Advanced." : "Model file is damaged. Scarlet will download it again on first use."; break;
    case "missing": text = model === "custom" ? "Choose a model file in Advanced." : "First transcription downloads up to 998 MB."; break;
    default: text = status === null ? "Model status unavailable" : "Checking model…";
  }
  const ready = status?.state === "ready";
  const tone = ready ? "bg-ok" : status?.state === "failed" || status?.state === "invalid" ? "bg-warn" : "bg-dim";
  return <div className="transcription-status">
    <div role="status" className="flex min-w-0 items-baseline gap-2">
      <span aria-hidden className={`size-1.5 shrink-0 self-start mt-[6px] rounded-full ${tone}`} />
      <div>
        {fallback ? <>
          <p className="font-medium">{ready ? "Using bundled Whisper" : "Bundled Whisper fallback"}</p>
          <p className="mt-0.5 text-muted">{ready ? "CrisperWhisper takes over after setup." : text}</p>
        </> : <p>{status?.reason ?? text}</p>}
      </div>
    </div>
    <span className="transcription-privacy">
      <Icon name="monitor" size={14} />
      {model === "custom" ? "Scarlet passes audio to the selected local runtime." : "Audio stays on this computer."}
    </span>
  </div>;
}

const setupGuide = "https://github.com/Forward-Future/scarlet/blob/main/docs/transcription-models.md";
const crisperWeights = "https://huggingface.co/nyralabs/CrisperWhisper2.0_large/tree/f4334f6e8193f2691212d49b20fa12d370e13896";

function CrisperSetupButton() {
  const { phase, error } = useCrisperSetup();
  const labels = { idle: "Install from folder…", choosing: "Choosing folder…", installing: "Installing CrisperWhisper…", failed: "Retry from folder…" };
  const busy = phase === "choosing" || phase === "installing";
  return <div>
    <button type="button" className="btn-ghost" disabled={busy} aria-live="polite" onClick={() => void installFromFolder()}>
      {labels[phase]}
    </button>
    <InlineError>{error}</InlineError>
  </div>;
}

export function TranscriptionGuide({ crisper = false }: { crisper?: boolean }) {
  const [error, setError] = useState("");
  const open = (url: string) => {
    setError("");
    void desktop.openUrl(url).catch(e => setError(errorMessage(e)));
  };
  return <details className={crisper ? "transcription-setup" : "my-2 text-xs text-muted"}>
    {crisper ? (
      <summary className="transcription-setup-row" aria-labelledby="crisper-setup-title" aria-describedby="crisper-license">
        <span>
          <span id="crisper-setup-title">Set up CrisperWhisper</span>
          <span id="crisper-license" className="mt-1 block text-xs font-normal text-dim">For non-commercial research. Commercial use requires a separate license.</span>
        </span>
        <Icon name="chevron" size={14} />
      </summary>
    ) : <summary className="cursor-pointer underline">Custom model setup</summary>}
    <div className={crisper ? "transcription-instructions" : "mt-2 space-y-2"}>
      {crisper ? <>
        <p>Setup requires 64-bit Python 3.12 on Windows, Ubuntu 24.04 x86-64 or Apple silicon with macOS 14 or later. On Ubuntu, install <code>python3.12-venv</code>.</p>
        <ol className="list-decimal space-y-2 pl-5">
          <li>Download the <button type="button" className="underline" onClick={() => open(crisperWeights)}>CrisperWhisper 2.0 large model files</button> into one folder.</li>
          <li>Choose that folder below. Scarlet verifies the files and downloads the runtime libraries.</li>
        </ol>
        <CrisperSetupButton />
      </> : <p>Choose a whisper.cpp model file, or supply a local adapter that writes word-timed JSON. You can leave the model file empty when the adapter manages its own weights. Save your selection in Advanced.</p>}
      <button type="button" className="underline" onClick={() => open(setupGuide)}>Open transcription model guide</button>
      <InlineError>{error}</InlineError>
    </div>
  </details>;
}
