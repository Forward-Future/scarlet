import { useModelPreferences, type ModelChoice } from "../../stores/modelPicker";
import { AGENT_LABEL } from "../../stores/hosts";
import { Icon } from "../ui/primitives";

export function FavoriteButton({ choice, revealOnHover = false }: { choice: ModelChoice; revealOnHover?: boolean }) {
  const favorite = useModelPreferences((s) => s.favorites.includes(choice.key));
  const toggle = useModelPreferences((s) => s.toggleFavorite);
  const label = `Favorite ${AGENT_LABEL[choice.agent]} · ${choice.label}`;
  return (
    <button type="button" aria-pressed={favorite} aria-label={label}
      title={favorite ? "Remove from favorites" : "Add to favorites"}
      className={revealOnHover
        ? `mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded transition-opacity hover:text-fg ${favorite ? "opacity-100 text-fg [&_svg]:fill-current" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 text-dim"}`
        : `inline-flex size-8 shrink-0 items-center justify-center rounded hover:bg-raised hover:text-fg ${favorite ? "text-fg [&_svg]:fill-current" : "text-dim"}`}
      onClick={(e) => { e.stopPropagation(); toggle(choice.key); }}>
      <Icon name="star" size={revealOnHover ? 12 : 14} />
    </button>
  );
}
