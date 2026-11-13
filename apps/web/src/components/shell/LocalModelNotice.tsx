import { useEffect, useState } from "react";
import { create } from "zustand";
import type { LocalModelStatus, LocalTranscriptionModel, ServerSettings } from "@scarlet/shared";
import { api, errorMessage } from "../../lib/client";
import { desktop } from "../../lib/desktop";
import { InlineError } from "../ui/primitives";

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

export function LocalModelNotice({ model, status }: { model: LocalTranscriptionModel; status?: LocalModelStatus | null }) {
  const fallback = status?.fallback && status.active === "whispercpp";
  let text: string;
  switch (status?.state) {
    case "ready": text = status.active === "crisperwhisper" ? "CrisperWhisper is ready." : model === "custom" ? "Custom model available" : "Model available"; break;
    case "downloading": text = `Downloading model · ${Math.floor(status.received * 100 / status.total)}%`; break;
    case "failed": text = "Download failed. Retry transcription to download again."; break;
    case "invalid": text = model === "custom" ? "Check your model file and adapter in Advanced." : "Model file is damaged. Scarlet will download it again on first use."; break;
    case "missing": text = model === "custom" ? "Choose a model file in Advanced." : "First transcription downloads up to 998 MB."; break;
    default: text = status === null ? "Model status unavailable" : "Checking model…";
  }
  if (fallback) {
    const notice = "Using bundled Whisper until CrisperWhisper is set up.";
    text = status.state === "ready" ? notice : notice + " " + text;
  } else if (status?.reason) {
    text = status.reason;
  }
  return <div className="mt-2 text-xs text-muted">
    <span role="status" className="inline-flex items-baseline gap-1.5">
      <span aria-hidden className={'size-1.5 shrink-0 rounded-full ' + (status?.state === "ready" ? "bg-ok" : "bg-dim")} />
      <span>{text}</span>
    </span>
    <div className="mt-1 text-dim">{model === "custom" ? "Scarlet passes audio to the selected local runtime." : "Audio stays on this computer."}</div>
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
  return <div className="my-2 text-xs text-muted">
    {crisper && <p className="mb-2">CrisperWhisper is licensed for non-commercial research. Commercial use requires a separate license.</p>}
    <details>
      <summary className="cursor-pointer underline">{crisper ? "Set up CrisperWhisper" : "Custom model setup"}</summary>
      <div className="mt-2 space-y-2">
        {crisper ? <>
          <p>Download the <button type="button" className="underline" onClick={() => open(crisperWeights)}>CrisperWhisper 2.0 large model files</button> to one folder. Setup requires 64-bit Python 3.12 on Windows or on Apple silicon with macOS 14 or later. Choose the model folder below. Scarlet verifies the files and downloads the runtime libraries.</p>
          <CrisperSetupButton />
        </> : <p>Choose a whisper.cpp model file, or supply a local adapter that writes word-timed JSON. You can leave the model file empty when the adapter manages its own weights. Save your selection in Advanced.</p>}
        <button type="button" className="underline" onClick={() => open(setupGuide)}>Open transcription model guide</button>
        <InlineError>{error}</InlineError>
      </div>
    </details>
  </div>;
}
