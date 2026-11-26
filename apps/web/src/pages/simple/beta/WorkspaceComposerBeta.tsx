import type { ComponentProps } from "react";
import { usePointTarget, type NewEditPlace } from "../WorkspaceComposer";
import { Composer } from "./ComposerBeta";

/** The new layout's message box (`WorkspaceComposer`): a time typed in the message isn't tagged again over the box. */
export function WorkspaceComposer({ newEdit, playerVersion, mediaId, ...props }: ComponentProps<typeof Composer> & NewEditPlace) {
  const target = usePointTarget({ newEdit, playerVersion, mediaId }, props.targetTag, false);
  return <Composer {...props} {...target} />;
}
