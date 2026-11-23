import type { Dispatch, SetStateAction } from "react";
import { Link } from "react-router-dom";
import { ConnectionStatus } from "../../components/shell/StatusIndicators";
import { Dropdown, MenuItem } from "../../components/shell/WorkspaceNavigation";
import { AgentChip } from "../../components/agent/AgentChip";
import { CachingMenuItem, MediaButton } from "../../components/media/MediaMenuItems";
import { ExportButton } from "../../components/review/ExportMenuItem";
import { Icon } from "../../components/ui/primitives";
import { player } from "../../lib/player";
import { plural } from "../../lib/format";
import { useUiStore } from "../../stores/ui";
import type { Panel } from "./types";

/** The chat's header: the way back to every project, the project's name, and its tools. */
export function SimpleHeader({ projectName, importing, importFailed, threadInput, menuSays, toLearn, transcript, setTranscript, setPanel, openLearnings, exportReady }: {
  projectName: string;
  importing: number;
  importFailed: boolean;
  threadInput: "answer" | "reply" | undefined;
  /** What the menu is marked for, said on its button. */
  menuSays: string;
  toLearn: number;
  transcript: boolean;
  setTranscript: Dispatch<SetStateAction<boolean>>;
  setPanel: (panel: Panel) => void;
  openLearnings: () => void;
  /** The video has edits and nothing waits on the editor or on Scarlet: Export is the next step. */
  exportReady: boolean;
}) {
  return <header className="simple-header">
    <Link to="/" className="simple-back" onClick={() => player.pause()} title="All projects" aria-label="All projects">
      <span className="rotate-180 inline-flex"><Icon name="arrow" size={13} /></span></Link>
    <h1 title={projectName}>{projectName}</h1>
    <ConnectionStatus />
    {/* The menu's button is marked when something inside needs the editor, and the row that does carries the
        same mark. Media, Export and Model mark their own header buttons. */}
    <div className="simple-tools">
      <MediaButton importing={importing} importFailed={importFailed} onOpen={() => setPanel("media")} />
      <ExportButton ready={exportReady} onOpen={() => setPanel("export")} />
      <AgentChip variant="header" direction="down" threadInput={threadInput} />
      <Dropdown label="More" align="right" width={240} description={menuSays || undefined}
        button={<span className={`btn-icon simple-more${menuSays ? " needs-you" : ""}`} title={menuSays || "More"}>
          <Icon name="more" /></span>}>
        {close => <>
          <MenuItem onClick={() => { close(); openLearnings(); }} title={toLearn ? `${plural(toLearn, "rule")} to review` : undefined}>
            <Icon name="bulb" />Learnings{toLearn > 0 && <span className="menu-dot" role="img" aria-label={`${plural(toLearn, "rule")} to review`} />}</MenuItem>
          <CachingMenuItem close={close} />
          <MenuItem onClick={() => { close(); setTranscript(v => !v); }}><Icon name="diff" />{transcript ? "Hide transcript" : "Transcript"}</MenuItem>
          <div role="separator" className="my-1 border-t border-line" />
          <MenuItem onClick={() => { close(); useUiStore.getState().setProjectSettingsOpen(true); }}><Icon name="monitor" />Project settings</MenuItem>
          <MenuItem to="/settings" onClick={close}><Icon name="settings" />App settings</MenuItem>
        </>}
      </Dropdown>
    </div>
  </header>;
}
