import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { StyleGuideRecord } from "@scarlet/shared";
import { BUILTIN_STYLE_GUIDES, builtinStyleGuideByName, type BuiltinStyleGuide } from "../lib/builtinStyleGuides";
import { api, errorMessage } from "../lib/client";
import { desktop, isDesktop } from "../lib/desktop";
import { useFileDropTarget } from "../lib/uiHooks";
import { useStyleGuidesStore } from "../stores/styleGuides";
import { EmptyState, ErrorState, Icon, InlineError, Loading, SectionTitle, Spinner } from "../components/ui/primitives";

const JSON_FILE = /\.json$/i;

function guideMetaSummary(guide: StyleGuideRecord): string {
  const parts: string[] = [];
  if (guide.transitions.length) parts.push(`${guide.transitions.length} ${guide.transitions.length === 1 ? "transition" : "transitions"}`);
  if (guide.sounds.length) parts.push(`${guide.sounds.length} ${guide.sounds.length === 1 ? "sound" : "sounds"}`);
  if (guide.colorLook) parts.push("Color look");
  return parts.join(" · ");
}

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
  const [importing, setImporting] = useState(false);
  const [importErr, setImportErr] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (status === "idle") void load();
  }, [status, load]);

  const handleFiles = async (items: Array<File | { path: string }>) => {
    if (!items.length || importing) return;
    setImportErr(null);

    // If a single JSON file is dropped/picked, try instant structured import first.
    if (items.length === 1) {
      const only = items[0]!;
      const name = only instanceof File ? only.name : only.path.split(/[\\/]/).pop() || "";
      if (JSON_FILE.test(name)) {
        setImporting(true);
        try {
          const res = await api.importStyleGuideFile(only, { name });
          if (res.imported) {
            useStyleGuidesStore.getState().apply(res.styleGuide);
            navigate(`/settings/style-guides/${res.styleGuide.id}`);
            return;
          }
        } catch (e) {
          setImportErr(errorMessage(e));
          return;
        } finally {
          setImporting(false);
        }
      }
    }

    // Any other settings document (.md, .yaml, .txt, .pdf, .cube, custom .json, logos, fonts)
    // opens a new style guide with the file staged in chat for Scarlet to read and apply.
    navigate("/settings/style-guides/new", { state: { initialFiles: items } });
  };

  const { over: dropping, dropProps } = useFileDropTarget(
    paths => void handleFiles(paths.map(path => ({ path }))),
    files => void handleFiles(Array.from(files)),
    { ignoreChildLeave: true },
  );

  const pickFile = async () => {
    if (isDesktop()) {
      const picked = await desktop.pickFile("Import a style guide file (.json, .md, .yaml, .pdf, or .cube)").catch(() => null);
      if (picked) void handleFiles([{ path: picked }]);
      return;
    }
    fileInputRef.current?.click();
  };

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
    <section aria-label="Style guides" className={`style-guides-drop-shell ${dropping ? "is-dropping" : ""}`}>
      <div {...dropProps} className="relative">
        <SectionTitle right={
          <div className="flex items-center gap-2">
            <button type="button" className="btn-ghost" disabled={importing} onClick={() => void pickFile()}>
              <Icon name="upload" size={12} /> {importing ? "Importing…" : "Import file"}
            </button>
            <Link className="btn-primary" to="/settings/style-guides/new">
              <Icon name="plus" size={12} /> New style guide
            </Link>
          </div>
        }>
          Style guides
        </SectionTitle>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="sr-only"
          aria-label="Import style guide file"
          onChange={e => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) void handleFiles(files);
            e.target.value = "";
          }}
        />
        {styleGuides.length > 0 && (
          <p className="mb-4 text-muted">
            Your default style applies automatically. Type <span className="font-mono text-fg">@name</span> in chat or in a skill to use another, or drop a style file (<span className="font-mono text-fg">.json</span>, <span className="font-mono text-fg">.md</span>, <span className="font-mono text-fg">.yaml</span>, <span className="font-mono text-fg">.pdf</span>, or <span className="font-mono text-fg">.cube</span>) anywhere here.
          </p>
        )}

        <InlineError>{importErr}</InlineError>

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
              body="Describe the look for captions, lower thirds, callout boxes, and graphics — plus transitions, sound effects, and camera color — or drop a style file here. Your default style applies automatically; type @name in chat or in a skill to use another."
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
              const meta = guideMetaSummary(guide);
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
                    {meta && <div className="style-guide-card-meta">{meta}</div>}
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

        {dropping && (
          <div className="sg-drop-overlay" aria-hidden="true">
            Drop a style file (.json, .md, .yaml, .pdf, or .cube) to import or create a style guide
          </div>
        )}
      </div>
    </section>
  );
}
