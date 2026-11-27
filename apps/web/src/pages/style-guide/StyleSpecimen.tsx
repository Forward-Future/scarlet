import type { BuiltinStyleGuide } from "../../lib/builtinStyleGuides";

function CleanSpecimen() {
  return (
    <div className="style-specimen-canvas sg-spec-clean">
      <div className="sg-clean-top">
        <span className="sg-clean-pill">
          <span className="sg-clean-pill-num">01</span>
          <span>Opening</span>
        </span>
        <span className="sg-clean-pill sg-clean-stat">
          <span className="sg-clean-dot" />
          <span>3× faster cut</span>
        </span>
      </div>

      <div className="sg-clean-lower">
        <span className="sg-clean-name">Alex Rivera</span>
        <span className="sg-clean-rule" />
        <span className="sg-clean-role">Creative Director</span>
      </div>

      <div className="sg-clean-caption-wrap">
        <div className="sg-clean-caption">
          <span>Make every </span>
          <strong>frame</strong>
          <span> feel effortless</span>
        </div>
      </div>
    </div>
  );
}

function EditorialSpecimen() {
  return (
    <div className="style-specimen-canvas sg-spec-editorial">
      <div className="sg-ed-frame">
        <div className="sg-ed-masthead">
          <span>PART I — PROLOGUE</span>
          <span className="sg-ed-issue">
            <span className="sg-ed-mark" />
            ISSUE 04
          </span>
        </div>

        <div className="sg-ed-spread">
          <div className="sg-ed-headline">
            <span>The Quiet </span>
            <em>Craft</em>
          </div>
          <div className="sg-ed-pull">
            <span className="sg-ed-pull-kicker">NOTE</span>
            <span className="sg-ed-pull-val">“3× faster cut”</span>
          </div>
        </div>

        <div className="sg-ed-foot">
          <div className="sg-ed-plaque">
            <span className="sg-ed-plaque-kicker">INTERVIEW</span>
            <span className="sg-ed-plaque-name">Alex Rivera</span>
            <span className="sg-ed-plaque-role">CREATIVE DIRECTOR</span>
          </div>
          <div className="sg-ed-caption">
            <span>Make every </span>
            <span className="sg-ed-caption-hi">frame</span>
            <span> count</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function TechSpecimen() {
  return (
    <div className="style-specimen-canvas sg-spec-tech">
      <div className="sg-tech-hud">
        <span className="sg-tech-hud-left">
          <span className="sg-tech-led" />
          <span>[01] SYSTEM.SPEC</span>
        </span>
        <span className="sg-tech-hud-right">60FPS · 00:04:12</span>
      </div>

      <div className="sg-tech-mid">
        <div className="sg-tech-pointer">
          <span className="sg-tech-reticle" />
          <span className="sg-tech-leader" />
        </div>
        <div className="sg-tech-callout">
          <span className="sg-tech-corner is-tl" />
          <span className="sg-tech-corner is-tr" />
          <span className="sg-tech-corner is-bl" />
          <span className="sg-tech-corner is-br" />
          <div className="sg-tech-callout-head">
            <span>▸ RENDER_DELTA</span>
            <span className="sg-tech-delta">+82%</span>
          </div>
          <div className="sg-tech-metric">3.2×</div>
          <div className="sg-tech-bars">
            <span className="is-on" />
            <span className="is-on" />
            <span className="is-on" />
            <span className="is-on" />
            <span className="is-on" />
            <span className="is-on" />
            <span />
            <span />
          </div>
        </div>
      </div>

      <div className="sg-tech-bottom">
        <div className="sg-tech-badge">
          <span className="sg-tech-badge-dot" />
          <span className="sg-tech-badge-name">ALEX_RIVERA</span>
          <span className="sg-tech-badge-sep">//</span>
          <span className="sg-tech-badge-role">ENG_LEAD</span>
        </div>
        <div className="sg-tech-caption">
          <span className="sg-tech-prompt">&gt;</span>
          <span> Make every </span>
          <span className="sg-tech-caption-hi">[frame]</span>
          <span> count</span>
        </div>
      </div>
    </div>
  );
}

function BoldSpecimen() {
  return (
    <div className="style-specimen-canvas sg-spec-bold">
      <div className="sg-bold-top">
        <div className="sg-bold-title-block">
          <span className="sg-bold-ep">EP. 01</span>
          <span className="sg-bold-headline">LEVEL UP</span>
        </div>
        <div className="sg-bold-sticker">
          <span className="sg-bold-sticker-val">3× FASTER</span>
          <span className="sg-bold-sticker-sub">CUT SPEED</span>
        </div>
      </div>

      <div className="sg-bold-bottom">
        <div className="sg-bold-tape">
          <span className="sg-bold-tape-name">ALEX RIVERA</span>
          <span className="sg-bold-tape-role">CREATOR</span>
        </div>
        <div className="sg-bold-caption">
          <span>MAKE EVERY </span>
          <span className="sg-bold-caption-hi">FRAME</span>
          <span> COUNT</span>
        </div>
      </div>
    </div>
  );
}

/** Miniature 16:9 visual specimen rendered with each built-in style's own layout and typography. */
export function StyleSpecimen({ preset }: { preset: BuiltinStyleGuide }) {
  return (
    <div className="style-specimen" data-style-variant={preset.variant} aria-hidden="true">
      {preset.variant === "clean" && <CleanSpecimen />}
      {preset.variant === "editorial" && <EditorialSpecimen />}
      {preset.variant === "tech" && <TechSpecimen />}
      {preset.variant === "bold" && <BoldSpecimen />}
    </div>
  );
}
