import { useUiStore } from "../stores/ui";
import { LegacySimpleWorkspace } from "./simple/LegacySimpleWorkspace";
import { SimpleWorkspaceBeta } from "./simple/beta/SimpleWorkspaceBeta";

/**
 * The simple workspace: uses the default two-column design, or switches live to the new three-column layout
 * when "New workspace layout (Beta)" is turned on in Settings.
 */
export function SimpleWorkspace() {
  const newLayout = useUiStore(s => s.newLayout);
  return newLayout ? <SimpleWorkspaceBeta /> : <LegacySimpleWorkspace />;
}
