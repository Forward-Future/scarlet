import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/client";
import { useStyleGuidesStore } from "../stores/styleGuides";
import { EmptyState, ErrorState, Icon, Loading, SectionTitle } from "../components/ui/primitives";

export function StyleGuidesPage() {
  const styleGuides = useStyleGuidesStore(s => s.styleGuides);
  const status = useStyleGuidesStore(s => s.status);
  const error = useStyleGuidesStore(s => s.error);
  const load = useStyleGuidesStore(s => s.load);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (status === "idle") void load();
  }, [status, load]);

  const query = q.trim().toLowerCase();
  const filtered = query
    ? styleGuides.filter(g => g.name.toLowerCase().includes(query) || g.description.toLowerCase().includes(query))
    : styleGuides;

  if (status === "loading" && !styleGuides.length) return <Loading label="Loading style guides…" />;
  if (status === "error" && !styleGuides.length) return <ErrorState title="Couldn’t load style guides" body={error ?? undefined} onRetry={() => void load()} />;

  return (
    <section aria-label="Style guides">
      <SectionTitle right={
        <Link className="btn-primary" to="/settings/style-guides/new">
          <Icon name="plus" size={12} /> New style guide
        </Link>
      }>
        Style guides
      </SectionTitle>
      <p className="mb-4 text-muted">
        Describe the look for captions, lower thirds, callout boxes, and graphics once. Your default style applies automatically; type <span className="font-mono text-fg">@name</span> in chat or in a skill to use another.
      </p>

      {styleGuides.length > 6 && (
        <div className="skill-search relative">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-dim">
            <Icon name="search" size={12} />
          </span>
          <input
            className="field pl-7 w-52 py-1"
            placeholder="Search style guides…"
            value={q}
            onChange={e => setQ(e.target.value)}
            aria-label="Search style guides"
          />
        </div>
      )}

      {styleGuides.length === 0 ? (
        <EmptyState
          icon="image"
          title="No style guides yet"
          body="Create a style guide in chat to set fonts, colors, and layouts for captions, lower thirds, callout boxes, and graphics across projects."
          action={
            <Link className="btn-primary" to="/settings/style-guides/new">
              <Icon name="plus" size={12} /> New style guide
            </Link>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState icon="image" title="No style guides match" />
      ) : (
        <div className="style-guides-grid">
          {filtered.map(guide => (
            <Link key={guide.id} to={`/settings/style-guides/${guide.id}`} className="style-guide-card">
              <div className="style-guide-thumb">
                {guide.preview ? (
                  <img
                    src={api.styleGuidePreviewUrl(guide.id, guide.preview.updatedAt)}
                    alt={`Preview of @${guide.name}`}
                    loading="lazy"
                  />
                ) : (
                  <span className="style-guide-thumb-empty">No preview yet</span>
                )}
              </div>
              <div className="style-guide-card-body">
                <div className="style-guide-card-head">
                  <span className="style-guide-slug">@{guide.name}</span>
                  {guide.isDefault && <span className="style-guide-default-badge">Default</span>}
                </div>
                <p className="style-guide-desc">
                  {guide.description || "Describe a look in chat to render a preview."}
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
