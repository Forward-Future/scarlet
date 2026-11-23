import { useEffect, type ComponentProps } from "react";
import { Composer } from "../../components/agent/Composer";
import { clock as clockLabel } from "../../lib/format";
import { usePlayerStore } from "../../stores/player";
import { pointOf, useUiStore } from "../../stores/ui";

/** Track a new edit's point in the message box without rebuilding the rest of the conversation on each pick. */
export function WorkspaceComposer({ newEdit, playerVersion, mediaId, ...props }: ComponentProps<typeof Composer> & {
  newEdit: boolean; playerVersion?: string; mediaId?: string;
}) {
  const point = useUiStore(s => newEdit ? pointOf(s.agentContext) : undefined);
  const written = useUiStore(s => !!point && !!s.agentDraft.trim());
  const speaking = useUiStore(s => !!point && s.speaking);
  // Leave a picked moment behind when playback or a seek takes the editor away. Once a message is being
  // written or recorded, its explicit target stays with it. N can attach while the player's pause is settling.
  // Before publishes the clock for a keyboard seek as its clip commits. Check after those layout effects.
  useEffect(() => {
    if (!point || written || speaking) return;
    const release = () => {
      const box = useUiStore.getState();
      if (box.agentContext === point && !box.agentDraft.trim() && !box.speaking) box.setAgentContext(null);
    };
    const moved = (time: number) => Math.abs(time - point.time) >= .1;
    if (point.version !== playerVersion || point.mediaId !== mediaId || moved(usePlayerStore.getState().time)) {
      release();
      return;
    }
    return usePlayerStore.subscribe((now, was) => {
      if ((now.playing && !was.playing) || moved(now.time)) release();
    });
  }, [point, written, speaking, playerVersion, mediaId]);
  const pointTag = point && !point.fromMessage ? `At ${clockLabel(point.time)}` : undefined;
  return <Composer {...props} targetTag={props.targetTag ?? pointTag} targetIsPoint={!props.targetTag && !!pointTag} />;
}
