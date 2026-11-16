import { EDITING_TOOL_GROUPS } from "@scarlet/shared";
import { SectionTitle } from "../ui/primitives";

/** What Scarlet can do on every request. Nothing here is a setting: the model
 * gets every tool its harness can use. */
export function EditingToolsSettings() {
  return (
    <section aria-label="Editing tools" className="tool-settings">
      <SectionTitle>Editing tools</SectionTitle>
      <p className="mb-3 text-muted">Scarlet can use all of these on every request.</p>
      <ul className="skill-list card divide-y divide-line/60">
        {EDITING_TOOL_GROUPS.map(group => (
          <li key={group.title} className="tool-setting-row">
            <div className="font-medium">{group.title}</div>
            <p className="text-muted text-[12px]">{group.description}</p>
          </li>
        ))}
      </ul>
      <details className="tool-inventory">
        <summary>View all tool names</summary>
        <dl>
          {EDITING_TOOL_GROUPS.map(group => <div key={group.title}>
            <dt>{group.title}</dt>
            <dd>{group.tools.map(tool => <code key={tool}>{tool}</code>)}</dd>
          </div>)}
        </dl>
      </details>
    </section>
  );
}
