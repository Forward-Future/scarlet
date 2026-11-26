import { useUiStore } from "../stores/ui";
import { Workspace } from "./simple/Workspace";

/**
 * The simple workspace: uses the default two-column design, or switches live to the new three-column layout
 * when "New workspace layout (Beta)" is turned on in Settings. Each layout is a fresh mount of the one workspace.
 */
export function SimpleWorkspace() {
  const newLayout = useUiStore(s => s.newLayout);
  return <Workspace key={newLayout ? "beta" : "default"} beta={newLayout} />;
}
