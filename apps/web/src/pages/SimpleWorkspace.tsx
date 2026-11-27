import { useUiStore } from "../stores/ui";
import { Workspace } from "./simple/Workspace";

/**
 * The simple workspace: uses the default three-column layout, or switches live to the classic two-column layout
 * when "Classic workspace layout" is turned on in Settings. Each layout is a fresh mount of the one workspace.
 */
export function SimpleWorkspace() {
  const newLayout = useUiStore(s => s.newLayout);
  return <Workspace key={newLayout ? "default" : "classic"} beta={newLayout} />;
}
