import { lazy, Suspense } from "react";
import { ChatRail } from "../../components/shell/ChatRail";
import { Icon, Loading } from "../../components/ui/primitives";

/** The Transcript's column beside the player: wide enough for a few lines of words, never more of the window than the chat. */
const transcriptRailWidth = (available: number) => Math.max(300, Math.min(400, available * 0.26));
const TRANSCRIPT_RAIL_MIN = 260;

const TranscriptPane = lazy(async () => ({ default: (await import("../../components/transcript/TranscriptPane")).TranscriptPane }));

type TranscriptPaneProps = Parameters<typeof TranscriptPane>[0];

/** The Transcript is its own column on the right of the player, so the chat stays in view beside it. */
export function TranscriptRail({ compact, paneKey, draft, source, onAsk, onClose }: {
  compact: boolean;
  /** The version the words are read from: a new one opens a new pane. */
  paneKey: string | null | undefined;
  draft: TranscriptPaneProps["draft"];
  source: TranscriptPaneProps["source"];
  onAsk: TranscriptPaneProps["onAsk"];
  onClose: () => void;
}) {
  return <ChatRail compact={compact} id="simple-transcript" className="simple-transcript-rail" label="Transcript" side="right" resizes="transcript"
    storageKey="scarlet.simpleTranscriptWidth" initialWidth={transcriptRailWidth} minWidth={TRANSCRIPT_RAIL_MIN} maxWidth={available => available * 0.4}>
    {/* Headed as the chat is: its name, and the × that closes it. */}
    <header className="simple-header"><h1 title={source?.name}>Transcript{source && <span className="simple-header-sub"> · {source.name}</span>}</h1>
      <button type="button" className="btn-icon" aria-label="Close transcript" title="Close transcript (Esc)"
        onClick={onClose}><Icon name="x" /></button></header>
    <div className="simple-transcript"><Suspense fallback={<Loading label="Opening transcript…" />}>
      {/* An applied cut plays on the version before it, so its transcript is that version's: the working cut's
          would highlight and seek early by everything the pass took out before that point. */}
      <TranscriptPane key={paneKey} draft={draft} source={source}
        onAsk={onAsk} />
    </Suspense></div>
  </ChatRail>;
}
