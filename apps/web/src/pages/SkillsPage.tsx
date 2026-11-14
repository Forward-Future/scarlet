import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { errorMessage } from "../lib/client";
import { splitFrontmatter } from "../lib/frontmatter";
import type { Skill } from "@scarlet/shared";
import { relTime } from "../lib/format";
import { useSkillsStore } from "../stores/skills";
import { Chip, EmptyState, ErrorState, Icon, Loading, SectionTitle, Toggle, InlineError } from "../components/ui/primitives";

const categories = ["Getting started", "Story and pacing", "Sound", "Picture and graphics", "Delivery"];

export function SkillsPage() {
  const skills = useSkillsStore((s) => s.skills);
  const status = useSkillsStore((s) => s.status);
  const error = useSkillsStore((s) => s.error);
  const load = useSkillsStore((s) => s.load);
  const update = useSkillsStore((s) => s.update);
  const [updateError, setUpdateError] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    if (status === "idle") void load();
  }, [status, load]);

  const query = q.toLowerCase();
  const filtered = skills.filter(s => s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name));

  const groups = new Map<string, Skill[]>(categories.map(category => [category, []]));
  for (const skill of filtered) {
    const category = splitFrontmatter(skill.content).frontmatter.category?.trim() || "Other skills";
    const group = groups.get(category);
    if (group) group.push(skill);
    else groups.set(category, [skill]);
  }

  if (status === "loading" && !skills.length) return <Loading label="Loading skills…" />;
  if (status === "error" && !skills.length) return <ErrorState body={error ?? undefined} onRetry={() => void load()} />;

  return (
    <section aria-label="Skills">
      <SectionTitle right={
        <Link className="btn-primary" to="/settings/skills/new">
          <Icon name="plus" size={12} /> New skill
        </Link>
      }>
        Editing skills
      </SectionTitle>
      <p className="mb-3 text-muted">Type / in an edit message to choose one.</p>
      <div className="skill-search relative">
        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-dim">
          <Icon name="search" size={12} />
        </span>
        <input className="field pl-7 w-48 py-1" placeholder="Search skills…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search skills" />
      </div>

      <InlineError>{updateError}</InlineError>
      {filtered.length === 0 && <EmptyState icon="stack" title="No skills match" />}

      {Array.from(groups, ([category, group]) => group.length > 0 && (
        <section key={category} aria-label={category} className="mb-5">
          <h3 className="font-medium mb-2">{category}</h3>
          <ul className="skill-list card divide-y divide-line/60">
            {group.map((s) => (
              <li key={s.id} className="skill-row">
                <Toggle
                  checked={s.enabled}
                  label={`${s.enabled ? "Disable" : "Enable"} ${s.name}`}
                  onChange={(v) => {
                    setUpdateError("");
                    void update(s.id, { enabled: v }).catch(e => setUpdateError(`${s.name}: ${errorMessage(e)}`));
                  }}
                />
                <Link to={`/settings/skills/${s.id}`} className="flex-1 min-w-0">
                  <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5">
                    <span className={`font-mono text-[12.5px] ${s.enabled ? "text-fg" : "text-muted"}`}>{s.name}</span>
                    <span className="text-dim text-[11px]">v{s.version}</span>
                    {s.source?.startsWith("change:") && <Chip tone="neutral">from an applied edit</Chip>}
                  </div>
                  <div className="text-muted text-[12px] truncate">{s.description || "No description"}</div>
                </Link>
                <span className="skill-date">{relTime(s.updatedAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
