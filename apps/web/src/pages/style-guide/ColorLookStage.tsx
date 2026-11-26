import { useEffect, useMemo, useRef, useState } from "react";
import { StyleGuideColorAdjustments, type StyleGuideColorLook, type StyleGuideRecord } from "@scarlet/shared";
import { Icon, InlineError } from "../../components/ui/primitives";
import { api, errorMessage } from "../../lib/client";
import { desktop, isDesktop } from "../../lib/desktop";
import { useFileDropTarget } from "../../lib/uiHooks";

const LUT_FILE = /\.(?:cube|3dl)$/i;

const DEFAULT_ADJ: StyleGuideColorAdjustments = StyleGuideColorAdjustments.parse({});

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function hasChanges(a: StyleGuideColorAdjustments): boolean {
  return (
    Math.abs(a.exposure) > 1e-4 ||
    Math.abs(a.contrast - 1) > 1e-4 ||
    Math.abs(a.saturation - 1) > 1e-4 ||
    Math.abs(a.warmth) > 1e-4 ||
    Math.abs(a.tint) > 1e-4 ||
    Math.abs(a.shadows) > 1e-4 ||
    Math.abs(a.highlights) > 1e-4 ||
    Math.abs(a.blacks) > 1e-4 ||
    Math.abs(a.whites) > 1e-4 ||
    Math.abs(a.gamma - 1) > 1e-4
  );
}

/**
 * Draw a clean, natural studio reference frame (warm skin tones, neutral matte studio walls,
 * window highlight, deep shadow falloff, and a subtle gray/color balance strip) so every camera
 * look adjustment is immediately legible in the Before/After split preview.
 */
function drawReferenceScene(ctx: CanvasRenderingContext2D, w: number, h: number) {
  // Neutral dark-mid studio wall gradient
  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, "#23252a");
  bg.addColorStop(0.55, "#34373e");
  bg.addColorStop(1, "#181a1e");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Soft studio practical window highlight on upper right
  const win = ctx.createRadialGradient(w * 0.78, h * 0.24, w * 0.02, w * 0.78, h * 0.24, w * 0.34);
  win.addColorStop(0, "rgba(246, 241, 232, 0.92)");
  win.addColorStop(0.28, "rgba(214, 206, 194, 0.35)");
  win.addColorStop(1, "rgba(40, 42, 48, 0)");
  ctx.fillStyle = win;
  ctx.fillRect(0, 0, w, h);

  // Subtle practical lamp glow on left background
  const lamp = ctx.createRadialGradient(w * 0.16, h * 0.42, 4, w * 0.16, h * 0.42, w * 0.22);
  lamp.addColorStop(0, "rgba(232, 186, 134, 0.52)");
  lamp.addColorStop(0.5, "rgba(182, 130, 88, 0.16)");
  lamp.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = lamp;
  ctx.fillRect(0, 0, w, h);

  // Studio bookshelf / architectural lines in background
  ctx.fillStyle = "rgba(15, 16, 19, 0.42)";
  ctx.fillRect(w * 0.06, h * 0.12, w * 0.22, h * 0.68);
  ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(w * 0.08, h * (0.24 + i * 0.14), w * 0.18, 2);
  }

  // Desk plane in lower foreground (neutral slate wood)
  const desk = ctx.createLinearGradient(0, h * 0.76, 0, h);
  desk.addColorStop(0, "#2f2c29");
  desk.addColorStop(1, "#161514");
  ctx.fillStyle = desk;
  ctx.fillRect(0, h * 0.78, w, h * 0.22);

  // Presenter shoulders (matte charcoal knit)
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(w * 0.48, h * 0.88, w * 0.23, h * 0.27, 0, Math.PI, Math.PI * 2);
  const coat = ctx.createLinearGradient(w * 0.3, h * 0.62, w * 0.72, h * 0.92);
  coat.addColorStop(0, "#282b31");
  coat.addColorStop(0.5, "#1d1f24");
  coat.addColorStop(1, "#111216");
  ctx.fillStyle = coat;
  ctx.fill();
  ctx.restore();

  // Presenter neck + face with natural key-light to shadow rolloff (realistic skin tones!)
  ctx.save();
  ctx.fillStyle = "#b98a6f";
  ctx.fillRect(w * 0.452, h * 0.54, w * 0.056, h * 0.11);
  ctx.beginPath();
  ctx.ellipse(w * 0.48, h * 0.42, w * 0.082, h * 0.165, 0, 0, Math.PI * 2);
  const skin = ctx.createRadialGradient(w * 0.515, h * 0.37, w * 0.015, w * 0.47, h * 0.43, w * 0.115);
  skin.addColorStop(0, "#e6bfa3");
  skin.addColorStop(0.55, "#c9987a");
  skin.addColorStop(1, "#7c5743");
  ctx.fillStyle = skin;
  ctx.fill();
  // Hair crown
  ctx.beginPath();
  ctx.ellipse(w * 0.48, h * 0.31, w * 0.085, h * 0.095, 0, Math.PI, Math.PI * 2);
  ctx.fillStyle = "#1d1917";
  ctx.fill();
  ctx.restore();

  // Subtle calibration chips on lower right desk (skin, foliage, sky, neutral gray, shadow, white)
  const chips = ["#1b1b1d", "#55575b", "#9a9ca0", "#dedede", "#c8987b", "#5c7a67", "#537494", "#b56a52"];
  const cw = w * 0.03;
  const ch = h * 0.042;
  const startX = w * 0.67;
  const startY = h * 0.87;
  ctx.fillStyle = "rgba(10,10,12,0.72)";
  ctx.fillRect(startX - 6, startY - 6, chips.length * (cw + 4) + 8, ch + 12);
  chips.forEach((hex, idx) => {
    ctx.fillStyle = hex;
    ctx.fillRect(startX + idx * (cw + 4), startY, cw, ch);
  });
}

/** Apply Scarlet's color look parameters directly to RGBA pixels for an accurate live preview. */
function applyAdjustmentsToImageData(src: ImageData, adj: StyleGuideColorAdjustments): ImageData {
  const out = new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
  const d = out.data;
  const expGain = Math.pow(2, adj.exposure);
  const invGamma = 1 / clamp(adj.gamma, 0.1, 10);
  const rShift = adj.warmth * 0.22 + adj.tint * 0.11;
  const gShift = -adj.tint * 0.22;
  const bShift = -adj.warmth * 0.22 + adj.tint * 0.11;

  const toneCurve = (x: number) => {
    let v = x;
    if (adj.blacks !== 0) v = adj.blacks > 0 ? v + adj.blacks * 0.08 * (1 - v) * (1 - v) : Math.max(0, (v + adj.blacks * 0.08) / (1 + adj.blacks * 0.08));
    if (adj.whites !== 0) v = adj.whites < 0 ? v * (1 + adj.whites * 0.08 * v * v) : Math.min(1, v / (1 - adj.whites * 0.08));
    if (adj.shadows !== 0) {
      const w = 4 * v * (1 - v) * (1 - v); // peaks in shadows (~0.25)
      v += adj.shadows * 0.24 * w;
    }
    if (adj.highlights !== 0) {
      const w = 4 * v * v * (1 - v); // peaks in highlights (~0.75)
      v += adj.highlights * 0.24 * w;
    }
    return clamp(v, 0, 1);
  };

  for (let i = 0; i < d.length; i += 4) {
    let r = (d[i]! / 255) * expGain;
    let g = (d[i + 1]! / 255) * expGain;
    let b = (d[i + 2]! / 255) * expGain;

    r = toneCurve(clamp(r, 0, 1));
    g = toneCurve(clamp(g, 0, 1));
    b = toneCurve(clamp(b, 0, 1));

    // Contrast & gamma
    r = clamp((r - 0.5) * adj.contrast + 0.5, 0, 1);
    g = clamp((g - 0.5) * adj.contrast + 0.5, 0, 1);
    b = clamp((b - 0.5) * adj.contrast + 0.5, 0, 1);
    if (adj.gamma !== 1) {
      r = Math.pow(r, invGamma);
      g = Math.pow(g, invGamma);
      b = Math.pow(b, invGamma);
    }

    // Saturation
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = clamp(luma + (r - luma) * adj.saturation, 0, 1);
    g = clamp(luma + (g - luma) * adj.saturation, 0, 1);
    b = clamp(luma + (b - luma) * adj.saturation, 0, 1);

    // White balance (warmth + tint, lightness-preserving midtone weighting)
    if (rShift !== 0 || gShift !== 0 || bShift !== 0) {
      const weight = 0.75 + 0.25 * (1 - Math.abs(luma * 2 - 1));
      const nr = clamp(r + rShift * weight * (0.25 + 0.75 * r), 0, 1);
      const ng = clamp(g + gShift * weight * (0.25 + 0.75 * g), 0, 1);
      const nb = clamp(b + bShift * weight * (0.25 + 0.75 * b), 0, 1);
      const newLuma = 0.2126 * nr + 0.7152 * ng + 0.0722 * nb;
      const delta = luma - newLuma;
      r = clamp(nr + delta * 0.7, 0, 1);
      g = clamp(ng + delta * 0.7, 0, 1);
      b = clamp(nb + delta * 0.7, 0, 1);
    }

    d[i] = Math.round(r * 255);
    d[i + 1] = Math.round(g * 255);
    d[i + 2] = Math.round(b * 255);
  }
  return out;
}

interface SliderSpec {
  key: keyof StyleGuideColorAdjustments;
  label: string;
  min: number;
  max: number;
  step: number;
  format(v: number): string;
}

const SLIDERS: readonly SliderSpec[] = [
  { key: "exposure", label: "Exposure", min: -2, max: 2, step: 0.05, format: v => `${v >= 0 ? "+" : ""}${v.toFixed(2)} EV` },
  { key: "contrast", label: "Contrast", min: 0.5, max: 1.8, step: 0.02, format: v => `${Math.round((v - 1) * 100) >= 0 ? "+" : ""}${Math.round((v - 1) * 100)}` },
  { key: "saturation", label: "Saturation", min: 0, max: 2, step: 0.02, format: v => `${Math.round((v - 1) * 100) >= 0 ? "+" : ""}${Math.round((v - 1) * 100)}` },
  { key: "warmth", label: "Warmth", min: -1, max: 1, step: 0.02, format: v => `${v >= 0 ? "+" : ""}${Math.round(v * 100)}` },
  { key: "tint", label: "Tint", min: -1, max: 1, step: 0.02, format: v => `${v >= 0 ? "+" : ""}${Math.round(v * 100)}` },
  { key: "shadows", label: "Shadows", min: -1, max: 1, step: 0.02, format: v => `${v >= 0 ? "+" : ""}${Math.round(v * 100)}` },
  { key: "highlights", label: "Highlights", min: -1, max: 1, step: 0.02, format: v => `${v >= 0 ? "+" : ""}${Math.round(v * 100)}` },
  { key: "blacks", label: "Blacks", min: -1, max: 1, step: 0.02, format: v => `${v >= 0 ? "+" : ""}${Math.round(v * 100)}` },
];

export function ColorLookStage({
  guide,
  disabled,
  onSave,
  onGuideUpdated,
}: {
  guide: StyleGuideRecord | null;
  disabled: boolean;
  onSave(next: StyleGuideColorLook | null): Promise<void>;
  onGuideUpdated(next: StyleGuideRecord): void;
}) {
  const saved = guide?.colorLook;
  const [split, setSplit] = useState(50);
  const [dragging, setDragging] = useState(false);
  const [lookName, setLookName] = useState(saved?.name ?? "");
  const [notes, setNotes] = useState(saved?.notes ?? "");
  const [adj, setAdj] = useState<StyleGuideColorAdjustments>(saved?.adjustments ?? DEFAULT_ADJ);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const beforeCanvasRef = useRef<HTMLCanvasElement>(null);
  const afterCanvasRef = useRef<HTMLCanvasElement>(null);
  const baseImageRef = useRef<ImageData | null>(null);
  const lutInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLookName(saved?.name ?? "");
    setNotes(saved?.notes ?? "");
    setAdj(saved?.adjustments ?? DEFAULT_ADJ);
  }, [saved?.name, saved?.notes, saved?.adjustments, saved?.lutAssetId]);

  // Paint Before & After studio reference frames whenever adjustments change.
  useEffect(() => {
    const before = beforeCanvasRef.current;
    const after = afterCanvasRef.current;
    if (!before || !after) return;
    let bCtx: CanvasRenderingContext2D | null = null;
    let aCtx: CanvasRenderingContext2D | null = null;
    try {
      bCtx = before.getContext("2d");
      aCtx = after.getContext("2d");
    } catch {
      return;
    }
    if (!bCtx || !aCtx) return;
    if (!baseImageRef.current) {
      drawReferenceScene(bCtx, before.width, before.height);
      baseImageRef.current = bCtx.getImageData(0, 0, before.width, before.height);
    }
    const graded = applyAdjustmentsToImageData(baseImageRef.current, adj);
    aCtx.putImageData(graded, 0, 0);
  }, [adj]);

  const updateSplitFromClientX = (clientX: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    setSplit(clamp(Math.round(((clientX - rect.left) / rect.width) * 100), 5, 95));
  };

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => updateSplitFromClientX(e.clientX);
    const up = () => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [dragging]);

  const persistLook = async (next: { name?: string; notes?: string; adjustments?: StyleGuideColorAdjustments; lutAssetId?: string; lutName?: string }) => {
    if (!guide || disabled) return;
    const merged: StyleGuideColorLook = {
      name: (next.name ?? lookName).trim(),
      notes: (next.notes ?? notes).trim(),
      adjustments: next.adjustments ?? adj,
      ...(next.lutAssetId !== undefined
        ? (next.lutAssetId ? { lutAssetId: next.lutAssetId, lutName: next.lutName } : {})
        : (saved?.lutAssetId ? { lutAssetId: saved.lutAssetId, lutName: saved.lutName } : {})),
    };
    setErr(null);
    try {
      await onSave(merged);
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  const uploadLut = async (item: File | { path: string }) => {
    if (!guide || disabled || busy) return;
    const name = item instanceof File ? item.name : item.path.split(/[\\/]/).pop() || "look.cube";
    if (!LUT_FILE.test(name)) {
      setErr("Choose a .cube or .3dl color look file.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await api.uploadStyleGuideAsset(guide.id, item, name);
      onGuideUpdated(res.styleGuide);
      await persistLook({
        name: lookName || res.asset.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "),
        lutAssetId: res.asset.id,
        lutName: res.asset.name,
      });
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const { over: dropping, dropProps } = useFileDropTarget(
    paths => { if (paths[0]) void uploadLut({ path: paths[0] }); },
    files => { if (files[0]) void uploadLut(files[0]); },
    { ignoreChildLeave: true },
  );

  const pickLut = async () => {
    if (isDesktop()) {
      const picked = await desktop.pickFile("Attach a .cube or .3dl look file").catch(() => null);
      if (picked) void uploadLut({ path: picked });
      return;
    }
    lutInputRef.current?.click();
  };

  const removeLut = async () => {
    if (!guide || !saved?.lutAssetId || disabled || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.deleteStyleGuideAsset(guide.id, saved.lutAssetId);
      onGuideUpdated(res.styleGuide);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const resetAdjustments = async () => {
    setAdj(DEFAULT_ADJ);
    if (!saved?.lutAssetId && !lookName.trim() && !notes.trim()) {
      await onSave(null);
    } else {
      await persistLook({ adjustments: DEFAULT_ADJ });
    }
  };

  const activeChips = useMemo(() => {
    const out: string[] = [];
    for (const spec of SLIDERS) {
      const val = adj[spec.key];
      const def = DEFAULT_ADJ[spec.key];
      if (Math.abs(val - def) > 1e-4) out.push(`${spec.label} ${spec.format(val)}`);
    }
    return out;
  }, [adj]);

  const modified = hasChanges(adj);

  return (
    <div {...dropProps} className={`sg-tab-body ${dropping ? "is-dropping" : ""}`}>
      <div className="sg-transition-stage-wrap">
        <div
          ref={stageRef}
          className="sg-color-stage"
          onPointerDown={e => {
            setDragging(true);
            updateSplitFromClientX(e.clientX);
          }}
        >
          <canvas ref={beforeCanvasRef} width={640} height={360} className="sg-color-canvas" aria-hidden="true" />
          <div className="sg-color-after-clip" style={{ clipPath: `inset(0 0 0 ${split}%)` }}>
            <canvas ref={afterCanvasRef} width={640} height={360} className="sg-color-canvas" aria-hidden="true" />
          </div>
          <span className="sg-ab-tag is-left">Before</span>
          <span className="sg-ab-tag is-right">After</span>
          <div
            role="slider"
            tabIndex={0}
            aria-label="Before and after split position"
            aria-valuemin={5}
            aria-valuemax={95}
            aria-valuenow={split}
            className="sg-color-divider"
            style={{ left: `${split}%` }}
            onKeyDown={e => {
              if (e.key === "ArrowLeft") { e.preventDefault(); setSplit(s => clamp(s - 5, 5, 95)); }
              if (e.key === "ArrowRight") { e.preventDefault(); setSplit(s => clamp(s + 5, 5, 95)); }
            }}
          >
            <span className="sg-color-handle" aria-hidden="true">‹ ›</span>
          </div>
        </div>
      </div>

      <InlineError>{err}</InlineError>

      <div className="sg-color-identity">
        <div className="sg-color-meta-row">
          <input
            className="sg-look-name-input"
            value={lookName}
            disabled={disabled || busy || !guide}
            aria-label="Color look name"
            placeholder="Untitled camera look (e.g. Warm Studio Filmic)"
            onChange={e => setLookName(e.target.value)}
            onBlur={() => { if (lookName.trim() !== (saved?.name ?? "")) void persistLook({ name: lookName }); }}
            onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
          />
          <div className="sg-lut-bar">
            {saved?.lutName ? (
              <span className="sg-lut-pill">
                <Icon name="file" size={11} />
                <span className="truncate max-w-[200px]">{saved.lutName}</span>
                <button
                  type="button"
                  className="sg-lut-remove"
                  aria-label={`Remove ${saved.lutName}`}
                  title="Remove LUT"
                  disabled={disabled || busy}
                  onClick={() => void removeLut()}
                >
                  <Icon name="x" size={10} />
                </button>
              </span>
            ) : null}
            <button
              type="button"
              className="btn-ghost text-[12px] py-1 px-2.5 shrink-0"
              disabled={disabled || busy || !guide}
              onClick={() => void pickLut()}
            >
              <Icon name="upload" size={11} /> {saved?.lutName ? "Replace LUT" : "Attach .cube / .3dl"}
            </button>
            <input
              ref={lutInputRef}
              type="file"
              accept=".cube,.3dl"
              className="sr-only"
              onChange={e => {
                const file = e.target.files?.[0];
                if (file) void uploadLut(file);
                e.target.value = "";
              }}
            />
          </div>
        </div>

        <input
          className="sg-rule-input"
          value={notes}
          disabled={disabled || busy || !guide}
          aria-label="Color look notes"
          placeholder="Notes for Scarlet when matching cameras (e.g. Match B-cam to warm A-cam skin tones, soft highlight rolloff)…"
          onChange={e => setNotes(e.target.value)}
          onBlur={() => { if (notes.trim() !== (saved?.notes ?? "")) void persistLook({ notes }); }}
          onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
        />
      </div>

      <div className="sg-section-head">
        <div className="flex items-baseline gap-2.5 min-w-0">
          <span className="sg-section-title shrink-0">Saved adjustments</span>
          {activeChips.length > 0 && (
            <span className="text-dim text-[12px] truncate">{activeChips.slice(0, 4).join(" · ")}</span>
          )}
        </div>
        {modified && (
          <button
            type="button"
            className="btn-quiet text-[12px]"
            disabled={disabled || busy || !guide}
            onClick={() => void resetAdjustments()}
          >
            Reset
          </button>
        )}
      </div>

      <div className="sg-sliders-grid">
        {SLIDERS.map(spec => {
          const value = adj[spec.key];
          const isModified = Math.abs(value - DEFAULT_ADJ[spec.key]) > 1e-4;
          return (
            <label key={spec.key} className="sg-slider-row">
              <div className="sg-slider-head">
                <span className={isModified ? "text-fg" : "text-muted"}>{spec.label}</span>
                <span className={`tnum text-[11.5px] ${isModified ? "text-fg" : "text-dim"}`}>{spec.format(value)}</span>
              </div>
              <input
                type="range"
                min={spec.min}
                max={spec.max}
                step={spec.step}
                value={value}
                disabled={disabled || busy || !guide}
                aria-label={spec.label}
                onChange={e => setAdj(prev => ({ ...prev, [spec.key]: Number(e.target.value) }))}
                onMouseUp={() => void persistLook({ adjustments: adj })}
                onTouchEnd={() => void persistLook({ adjustments: adj })}
                onKeyUp={() => void persistLook({ adjustments: adj })}
              />
            </label>
          );
        })}
      </div>

      {dropping && <div className="sg-drop-overlay" aria-hidden="true">Drop a .cube or .3dl file to save as this style’s camera look</div>}
    </div>
  );
}
