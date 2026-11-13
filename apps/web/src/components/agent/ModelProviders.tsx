import type { AgentId } from "@scarlet/shared";
import claudeLogo from "../../assets/providers/claude.svg";
import geminiLogo from "../../assets/providers/gemini.svg";
import openaiLogo from "../../assets/providers/openai.svg";
import { AGENT_LABEL } from "../../stores/hosts";
import { Icon } from "../ui/primitives";

export type ModelScope = AgentId | "favorites";

const logos = { claude: claudeLogo, codex: openaiLogo, gemini: geminiLogo };

export function ModelProviders<T extends ModelScope>({ providers, active, onChange, compact = false }: {
  providers: T[]; active?: T; onChange: (value: T) => void; compact?: boolean;
}) {
  const labels = { ...AGENT_LABEL, favorites: "Favorites" };
  return (
    <div aria-label="Providers" role="group" className={compact
      ? "flex shrink-0 flex-col items-center gap-1 border-r border-line bg-bg/50 p-1.5"
      : "flex flex-wrap gap-1 border-b border-line pb-3"}>
      {providers.map(id => {
        const label = labels[id];
        return <button key={id} type="button" title={label} aria-label={label} aria-pressed={active === id}
          className={`inline-flex items-center justify-center gap-2 rounded-md hover:bg-raised hover:text-fg focus-visible:bg-raised ${active === id ? "bg-raised text-fg" : "text-muted"} ${compact ? "size-8" : "px-3 py-2 text-[13px]"}`}
          onClick={() => onChange(id)}>
          <ProviderIcon id={id} />
          {!compact && label}
        </button>;
      })}
    </div>
  );
}

function ProviderIcon({ id }: { id: ModelScope }) {
  if (id === "favorites") return <Icon name="star" size={16} />;
  if (id === "api") return <span aria-hidden className="font-mono font-semibold">{"{}"}</span>;
  return <img src={logos[id]} alt="" className="size-4 shrink-0" />;
}
