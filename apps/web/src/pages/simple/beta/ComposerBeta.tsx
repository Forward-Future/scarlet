import type { ComponentProps } from "react";
import { Composer as SharedComposer } from "../../../components/agent/Composer";

export { NEW_EDIT_HINT, type PausedAt } from "../../../components/agent/Composer";

/**
 * The new layout's message box: the shared one, with Scarlet's question over the box, picked times and marked
 * stretches written into the words, and the tag kept on the cut's or edit's own time through a pause.
 */
export function Composer(props: ComponentProps<typeof SharedComposer>) {
  return <SharedComposer askPanel timesInWords tagIgnoresPause {...props} />;
}
