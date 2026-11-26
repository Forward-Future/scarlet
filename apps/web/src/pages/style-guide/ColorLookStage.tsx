import { useEffect, useMemo, useRef, useState } from "react";
import { StyleGuideColorAdjustments, type StyleGuideRecord } from "@scarlet/shared";
import { Icon } from "../../components/ui/primitives";

const DEFAULT_ADJ: StyleGuideColorAdjustments = StyleGuideColorAdjustments.parse({});

const PROMPT_STARTERS = [
  "Warm studio filmic look with natural skin tones and soft highlight rolloff",
  "Crisp neutral daylight with gentle shadow lift",
  "Clean documentary grade, balanced contrast and subtle warmth",
];

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Draw a natural studio reference frame (skin tones, neutral matte studio wall,
 * window highlight, deep shadow falloff, and calibration swatches) so the saved
 * camera color look is immediately legible in the Before/After comparison.
 */
function drawReferenceScene(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, "#23252a");
  bg.addColorStop(0.55, "#34373e");
  bg.addColorStop(1, "#181a1e");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const win = ctx.createRadialGradient(w * 0.78, h * 0.24, w * 0.02, w * 0.78, h * 0.24, w * 0.34);
  win.addColorStop(0, "rgba(246, 241, 232, 0.92)");
  win.addColorStop(0.28, "rgba(214, 206, 194, 0.35)");
  win.addColorStop(1, "rgba(40, 42, 48, 0)");
  ctx.fillStyle = win;
  ctx.fillRect(0, 0, w, h);

  const lamp = ctx.createRadialGradient(w * 0.16, h * 0.42, 4, w * 0.16, h * 0.42, w * 0.22);
  lamp.addColorStop(0, "rgba(232, 186, 134, 0.52)");
  lamp.addColorStop(0.5, "rgba(182, 130, 88, 0.16)");
  lamp.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = lamp;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = "rgba(15, 16, 19, 0.42)";
  ctx.fillRect(w * 0.06, h * 0.12, w * 0.22, h * 0.68);
  ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(w * 0.08, h * (0.24 + i * 0.14), w * 0.18, 2);
  }

  const desk = ctx.createLinearGradient(0, h * 0.76, 0, h);
  desk.addColorStop(0, "#2f2c29");
  desk.addColorStop(1, "#161514");
  ctx.fillStyle = desk;
  ctx.fillRect(0, h * 0.78, w, h * 0.22);

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
  ctx.beginPath();
  ctx.ellipse(w * 0.48, h * 0.31, w * 0.085, h * 0.095, 0, Math.PI, Math.PI * 2);
  ctx.fillStyle = "#1d1917";
  ctx.fill();
  ctx.restore();

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

/** Apply saved color look parameters directly to RGBA pixels for the Before/After preview. */
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
      const w = 4 * v * (1 - v) * (1 - v);
      v += adj.shadows * 0.24 * w;
    }
    if (adj.highlights !== 0) {
      const w = 4 * v * v * (1 - v);
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

    r = clamp((r - 0.5) * adj.contrast + 0.5, 0, 1);
    g = clamp((g - 0.5) * adj.contrast + 0.5, 0, 1);
    b = clamp((b - 0.5) * adj.contrast + 0.5, 0, 1);
    if (adj.gamma !== 1) {
      r = Math.pow(r, invGamma);
      g = Math.pow(g, invGamma);
      b = Math.pow(b, invGamma);
    }

    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = clamp(luma + (r - luma) * adj.saturation, 0, 1);
    g = clamp(luma + (g - luma) * adj.saturation, 0, 1);
    b = clamp(luma + (b - luma) * adj.saturation, 0, 1);

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

interface ReadoutSpec {
  key: keyof StyleGuideColorAdjustments;
  label: string;
  format(v: number): string;
}

const READOUTS: readonly ReadoutSpec[] = [
  { key: "exposure", label: "Exposure", format: v => `${v >= 0 ? "+" : ""}${v.toFixed(2)} EV` },
  { key: "contrast", label: "Contrast", format: v => `${Math.round((v - 1) * 100) >= 0 ? "+" : ""}${Math.round((v - 1) * 100)}` },
  { key: "saturation", label: "Saturation", format: v => `${Math.round((v - 1) * 100) >= 0 ? "+" : ""}${Math.round((v - 1) * 100)}` },
  { key: "warmth", label: "Warmth", format: v => `${v >= 0 ? "+" : ""}${Math.round(v * 100)}` },
  { key: "tint", label: "Tint", format: v => `${v >= 0 ? "+" : ""}${Math.round(v * 100)}` },
  { key: "shadows", label: "Shadows", format: v => `${v >= 0 ? "+" : ""}${Math.round(v * 100)}` },
  { key: "highlights", label: "Highlights", format: v => `${v >= 0 ? "+" : ""}${Math.round(v * 100)}` },
  { key: "blacks", label: "Blacks", format: v => `${v >= 0 ? "+" : ""}${Math.round(v * 100)}` },
  { key: "whites", label: "Whites", format: v => `${v >= 0 ? "+" : ""}${Math.round(v * 100)}` },
  { key: "gamma", label: "Gamma", format: v => v.toFixed(2) },
];

export function ColorLookStage({
  guide,
  onSuggestPrompt,
}: {
  guide: StyleGuideRecord | null;
  onSuggestPrompt(prompt: string): void;
}) {
  const saved = guide?.colorLook;
  const adj = saved?.adjustments ?? DEFAULT_ADJ;
  const [split, setSplit] = useState(50);
  const [dragging, setDragging] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const beforeCanvasRef = useRef<HTMLCanvasElement>(null);
  const afterCanvasRef = useRef<HTMLCanvasElement>(null);
  const baseImageRef = useRef<ImageData | null>(null);

  useEffect(() => {
    if (!saved) return;
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
  }, [saved, adj]);

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

  const savedMetrics = useMemo(() => {
    if (!saved) return [];
    return READOUTS.filter(spec => Math.abs(adj[spec.key] - DEFAULT_ADJ[spec.key]) > 1e-4).map(spec => ({
      key: spec.key,
      label: spec.label,
      value: spec.format(adj[spec.key]),
    }));
  }, [saved, adj]);

  if (!saved) {
    return (
      <div className="style-guide-preview-stage">
        <div className="style-guide-preview-frame is-empty">
          <span className="style-guide-preview-placeholder-title">Camera color look</span>
          <span className="style-guide-preview-placeholder-body">
            Describe the color and lighting look in chat, or drop a style file or .cube / .3dl look file anywhere — Scarlet will save it here and apply it across projects.
          </span>
          <div className="sg-prompt-chips">
            {PROMPT_STARTERS.map(starter => (
              <button
                key={starter}
                type="button"
                className="sg-prompt-chip"
                onClick={() => onSuggestPrompt(starter)}
              >
                {starter}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="sg-tab-body">
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

      <div className="sg-color-summary">
        <div className="sg-color-summary-head">
          <h3 className="sg-color-title">{saved.name || "Saved camera look"}</h3>
          {saved.lutName && (
            <span className="sg-lut-pill">
              <Icon name="file" size={11} />
              <span className="truncate max-w-[240px]">{saved.lutName}</span>
            </span>
          )}
        </div>
        {saved.notes && <p className="sg-color-notes">{saved.notes}</p>}

        {savedMetrics.length > 0 && (
          <dl className="sg-color-readouts" aria-label="Saved color look parameters">
            {savedMetrics.map(item => (
              <div key={item.key} className="sg-color-stat">
                <dt>{item.label}</dt>
                <dd className="tnum">{item.value}</dd>
              </div>
            ))}
          </dl>
        )}

        <p className="sg-color-prompt-hint">
          Describe color or lighting adjustments in chat — or drop a style settings file or .cube / .3dl file anywhere — and Scarlet will update this look.
        </p>
      </div>
    </div>
  );
}
