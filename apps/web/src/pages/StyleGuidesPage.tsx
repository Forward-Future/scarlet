import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { BUILTIN_STYLE_GUIDES, builtinStyleGuideByName, type BuiltinStyleGuide } from "../lib/builtinStyleGuides";
import { api, errorMessage } from "../lib/client";
import { useStyleGuidesStore } from "../stores/styleGuides";
import { EmptyState, ErrorState, Icon, InlineError, Loading, SectionTitle, Spinner } from "../components/ui/primitives";

function StyleSpecimen({ preset }: { preset: BuiltinStyleGuide }) {
  const s = preset.specimen;
  const titleFont = s.titleFont === "serif"
    ? "Georgia, 'Times New Roman', serif"
    : s.titleFont === "mono"
      ? "var(--font-mono)"
      : "var(--font-sans)";
  return (
    <div className="style-specimen" style={{ background: s.canvas }} aria-hidden="true">
      <div className="style-specimen-top">
        <div className="style-specimen-title" style={{ color: s.text, fontFamily: titleFont }}>
          <span className="style-specimen-kicker" style={{ color: s.accent }}>01</span>
          <span>Chapter Title</span>
        </div>
        <div className="style-specimen-callout" style={{ background: s.surface, borderColor: s.border }}>
          <span className="style-specimen-callout-kicker" style={{ color: s.accent }}>KEY POINT</span>
          <span className="style-specimen-callout-val" style={{ color: s.text }}>3× faster cut</span>
        </div>
      </div>
      <div className="style-specimen-bottom">
        <div className="style-specimen-lower" style={{ background: s.surface, borderColor: s.border, borderLeftColor: s.accent }}>
          <span className="style-specimen-lower-name" style={{ color: s.text, fontFamily: titleFont }}>Alex Rivera</span>
          <span className="style-specimen-lower-role" style={{ color: s.muted }}>Creative Director</span>
        </div>
        <div
          className="style-specimen-caption"
          style={{
            background: s.captionBg,
            color: s.captionText,
            textTransform: s.captionUppercase ? "uppercase" : undefined,
            textShadow: s.captionBg === "transparent" ? "0 1px 2px #000, 0 0 4px #000" : undefined,
          }}
        >
          <span>Make every </span>
          <span style={{ color: s.captionHighlight ?? s.captionText, fontWeight: 700 }}>frame</span>
          <span> count</span>
        </div>
      </div>
    </div>
  );
}

export function StyleGuidesPage() {
  const navigate = useNavigate();
  const styleGuides = useStyleGuidesStore(s => s.styleGuides);
  const status = useStyleGuidesStore(s => s.status);
  const error = useStyleGuidesStore(s => s.error);
  const load = useStyleGuidesStore(s => s.load);
  const create = useStyleGuidesStore(s => s.create);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "idle") void load();
  }, [status, load]);

  const query = q.trim().toLowerCase();
  const filtered = query
    ? styleGuides.filter(g => g.name.toLowerCase().includes(query) || g.description.toLowerCase().includes(query))
    : styleGuides;

  const existingByName = new Map(styleGuides.map(g => [g.name.toLowerCase(), g]));

  const useBuiltin = async (preset: BuiltinStyleGuide) => {
    const existing = existingByName.get(preset.name);
    if (existing) {
      navigate(`/settings/style-guides/${existing.id}`);
      return;
    }
    if (adding) return;
    setAdding(preset.name);
    setAddError(null);
    try {
      const created = await create({
        name: preset.name,
        description: preset.description,
        instructions: preset.instructions,
        captionStyle: preset.captionStyle,
      });
      navigate(`/settings/style-guides/${created.id}`);
    } catch (e) {
      setAddError(errorMessage(e));
    } finally {
      setAdding(null);
    }
  };

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

      {styleGuides.length > 0 && (
        <p className="mb-4 text-muted">
          Your default style applies automatically. Type <span className="font-mono text-fg">@name</span> in chat or in a skill to use another.
        </p>
      )}

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
        <div className="style-guides-empty">
          <EmptyState
            icon="image"
            title="No style guides yet"
            body="Describe the look for captions, lower thirds, callout boxes, and graphics once. Your default style applies automatically; type @name in chat or in a skill to use another."
            action={
              <Link className="btn-primary" to="/settings/style-guides/new">
                <Icon name="plus" size={12} /> New style guide
              </Link>
            }
          />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState icon="image" title="No style guides match" />
      ) : (
        <div className="style-guides-grid">
          {filtered.map(guide => {
            const fallbackPreset = !guide.preview ? builtinStyleGuideByName(guide.name) : undefined;
            return (
              <Link key={guide.id} to={`/settings/style-guides/${guide.id}`} className="style-guide-card">
                <div className="style-guide-thumb">
                  {guide.preview ? (
                    <img
                      src={api.styleGuidePreviewUrl(guide.id, guide.preview.updatedAt)}
                      alt={`Preview of @${guide.name}`}
                      loading="lazy"
                    />
                  ) : fallbackPreset ? (
                    <StyleSpecimen preset={fallbackPreset} />
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
            );
          })}
        </div>
      )}

      <div className="mt-6">
        <div className="flex items-baseline justify-between gap-2 mb-3">
          <h3 className="font-medium">Built-in styles</h3>
          <span className="text-[12px] text-dim">Start from a preset and customize it in chat</span>
        </div>
        <InlineError>{addError}</InlineError>
        <div className="style-guides-grid style-guides-builtins">
          {BUILTIN_STYLE_GUIDES.map(preset => {
            const added = existingByName.has(preset.name);
            const busy = adding === preset.name;
            return (
              <button
                key={preset.name}
                type="button"
                className="style-guide-card style-guide-starter text-left"
                disabled={!!adding}
                onClick={() => void useBuiltin(preset)}
              >
                <div className="style-guide-thumb">
                  <StyleSpecimen preset={preset} />
                </div>
                <div className="style-guide-card-body">
                  <div className="style-guide-card-head">
                    <span className="style-guide-slug">@{preset.name}</span>
                    <span className="style-guide-focus-badge">
                      {busy ? <Spinner className="size-3" /> : added ? "Added" : preset.focus}
                    </span>
                  </div>
                  <p className="style-guide-desc">{preset.description}</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
