import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { StyleGuideRecord } from "@scarlet/shared";
import { api, errorMessage } from "../lib/client";
import { desktop, isDesktop } from "../lib/desktop";
import { useFileDropTarget } from "../lib/uiHooks";
import { useStyleGuidesStore } from "../stores/styleGuides";
import { EmptyState, ErrorState, Icon, InlineError, Loading, SectionTitle } from "../components/ui/primitives";

const JSON_FILE = /\.json$/i;

function guideMetaSummary(guide: StyleGuideRecord): string {
  const parts: string[] = [];
  if (guide.transitions.length) parts.push(`${guide.transitions.length} ${guide.transitions.length === 1 ? "transition" : "transitions"}`);
  if (guide.sounds.length) parts.push(`${guide.sounds.length} ${guide.sounds.length === 1 ? "sound" : "sounds"}`);
  if (guide.colorLook) parts.push("Color look");
  return parts.join(" · ");
}

export function StyleGuidesPage() {
  const navigate = useNavigate();
  const styleGuides = useStyleGuidesStore(s => s.styleGuides);
  const status = useStyleGuidesStore(s => s.status);
  const error = useStyleGuidesStore(s => s.error);
  const load = useStyleGuidesStore(s => s.load);
  const [q, setQ] = useState("");
  const [importing, setImporting] = useState(false);
  const [importErr, setImportErr] = useState<string | null>(null);
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
        <p className="mb-4 text-muted">
          Your default style applies automatically. Type <span className="font-mono text-fg">@name</span> in chat or in a skill to use another, or drop a style file (<span className="font-mono text-fg">.json</span>, <span className="font-mono text-fg">.md</span>, <span className="font-mono text-fg">.yaml</span>, <span className="font-mono text-fg">.pdf</span>, or <span className="font-mono text-fg">.cube</span>) anywhere here.
        </p>

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
          <EmptyState
            icon="image"
            title="No style guides yet"
            body="Create a style guide in chat — or drop a style definition file here — so Scarlet matches your look across projects."
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
            {filtered.map(guide => {
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

        {dropping && (
          <div className="sg-drop-overlay" aria-hidden="true">
            Drop a style file (.json, .md, .yaml, .pdf, or .cube) to import or create a style guide
          </div>
        )}
      </div>
    </section>
  );
}
