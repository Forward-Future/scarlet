/** Short Markdown summaries of evaluations and runs. */
import type { Evaluation } from "./evaluate.ts";
import type { EdgeSummary, RemovalSummary } from "./metrics.ts";
import type { Tier } from "./score.ts";

const pct = (n: number, d: number) => d ? `${n} (${Math.round(100 * n / d)}%)` : `${n}`;
const s = (v: number) => `${v.toFixed(1)} s`;
const f = (v: number | null | undefined, digits = 3) => v === null || v === undefined ? "–" : v.toFixed(digits);
const clock = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, "0")}`;

function categories(r: RemovalSummary) {
  return Object.entries(r.byCategory).sort((a, b) => b[1].seconds - a[1].seconds)
    .map(([k, v]) => `${k} ${v.cuts}/${s(v.seconds)}`).join(" · ") || "–";
}
function grids(e: EdgeSummary) {
  return Object.entries(e.onGrid).map(([k, v]) => `${k}: ${v}`).join(" · ");
}

export function evaluationMarkdown(ev: Evaluation): string {
  const { score } = ev;
  const a = score.applied, r = score.review;
  const col = (fn: (t: Tier) => string) => `${fn(a)} | ${r ? fn(r) : "–"}`;
  const lines: string[] = [];
  lines.push(`# First-cut evaluation · ${ev.taskId}`, "");
  lines.push(`${[ev.config.agent, ev.config.model, ev.config.effort].filter(Boolean).join(" · ")}${ev.caseId ? ` · case ${ev.caseId}` : ""} · ${ev.generatedAt}`, "");
  lines.push(`Versions: source ${score.versions.source} → applied ${score.versions.applied} → proposed ${score.versions.proposed}. ` +
    `Edge level: loudest level frame ${ev.edgeOptions.window === "around" ? `within ±${ev.edgeOptions.windowSeconds * 1000} ms` : `over ${ev.edgeOptions.windowSeconds * 1000} ms on the kept side`}` +
    ` (${ev.evidence.map(e => `${e.mediaId}: ${e.levels ?? "no levels"}, ${e.words} words`).join("; ")}).`, "");
  lines.push("| | Applied | Review |", "|---|---|---|");
  lines.push(`| Cuts | ${a.removal.cuts} | ${r ? `${r.removal.cuts} (${r.items} review items)` : "–"} |`);
  lines.push(`| Removed | ${col(t => s(t.removal.seconds))} |`);
  lines.push(`| By category (cuts/seconds) | ${col(t => categories(t.removal))} |`);
  lines.push(`| Joins (edges) | ${col(t => String(t.edges.total))} |`);
  lines.push(`| Edges in silence | ${col(t => pct(t.edges.silence, t.edges.total - t.edges.unknown))} |`);
  lines.push(`| Edges low | ${col(t => pct(t.edges.low, t.edges.total - t.edges.unknown))} |`);
  lines.push(`| **Edges on speech** | ${col(t => pct(t.edges.speech, t.edges.total - t.edges.unknown))} |`);
  if (a.engineView) lines.push(`| On speech in the engine waveform | ${col(t => t.engineView ? pct(t.engineView.speech, t.engineView.total - t.engineView.unknown) : "–")} |`);
  lines.push(`| Words clipped (>20 ms by transcript timing / and not silent) | ${col(t => `${t.edges.clippedWords} / ${t.edges.clippedOnSound}`)} |`);
  lines.push(`| On grid | ${col(t => grids(t.edges))} |`);
  lines.push(`| Per-cut edges on speech (hand method) | ${col(t => `${t.perCutEdges.speech}/${t.perCutEdges.total}`)} |`, "");

  if (r) {
    lines.push(`**Review.** AI: cut ${r.ai.cut}, keep ${r.ai.keep}, ask ${r.ai.ask} (Needs your call), unassessed ${r.ai.unassessed}; inspected ${r.ai.inspected}. ` +
      `Editor: approved ${r.editor.approved}, skipped ${r.editor.skipped}, pending ${r.editor.pending}${r.editor.unknown ? `, unknown ${r.editor.unknown}` : ""}. ` +
      `Decisions from: ${ev.reviewDecisionsFrom}.` +
      (Object.keys(r.aiVsEditor).length ? ` AI→editor: ${Object.entries(r.aiVsEditor).map(([k, v]) => `${k} ${v}`).join(", ")}.` : ""), "");
  }
  if (r) lines.push(`Of the ${r.removal.cuts} staged cuts, the agent submitted ${r.heldByScarlet} as cuts and Scarlet held them.`, "");
  {
    const p = score.pacing, cols = [p.source, p.applied, p.proposed, p.reference];
    const row = (label: string, fn: (x: NonNullable<(typeof cols)[number]>) => string) => `| ${label} | ${cols.map(c => c ? fn(c) : "–").join(" | ")} |`;
    lines.push("## Pacing", "", "A gap is half a second or more without a word. Dead air is the time in gaps over a quarter-second beat.", "",
      "| | Source | Applied | Proposed | Reference |", "|---|---|---|---|---|");
    lines.push(row("Gaps inside kept footage", x => String(x.gaps.inside)));
    lines.push(row("Gaps at joins (of joins)", x => `${x.gaps.atJoins} of ${x.joins}`));
    lines.push(row("Gaps of 1 s or more", x => String(x.gaps.long)));
    lines.push(row("Dead air", x => s(x.gaps.excessSeconds)));
    lines.push(row("Median gap at a join", x => x.medianJoinGapSeconds === null ? "–" : `${x.medianJoinGapSeconds.toFixed(2)} s`));
    lines.push(row("Doubled words / phrases", x => `${x.repeats.singleWords} / ${x.repeats.phrases}`));
    lines.push(row("Doubled across a join", x => String(x.repeats.atJoins)), "");
    if (p.appliedRepeats.length) {
      lines.push(`**Doubled in the applied cut (${p.appliedRepeats.length}).** ` +
        p.appliedRepeats.map(x => `${clock(x.at)} “${x.text.replace(/\|/g, "/")}”${x.join ? " (join)" : ""}`).join(" · "), "");
    }
    if (p.appliedGaps.length) {
      lines.push(`**Longest gaps in the applied cut.** ` +
        p.appliedGaps.slice(0, 15).map(g => `${clock(g.at)} ${g.seconds.toFixed(1)} s${g.join ? " (join)" : ""}`).join(" · "), "");
    }
  }
  if (score.picture) {
    const p = score.picture, cols = [p.reference, p.applied.summary, p.proposed.summary];
    const share = (v: number) => `${Math.round(v * 100)}%`;
    const row = (label: string, fn: (x: (typeof cols)[number]) => string) => `| ${label} | ${cols.map(fn).join(" | ")} |`;
    lines.push("## Picture", "", `Measured at ${p.reference.samples} moments of the published video, and read from each version's clips at the same recording seconds.`, "",
      "| | Published | Applied | Proposed |", "|---|---|---|---|");
    lines.push(row("Presenter fills the frame", x => share(x.layouts.camera)));
    lines.push(row("Presenter inset over the screen", x => share(x.layouts.inset)));
    lines.push(row("Screen alone", x => share(x.layouts.screen)));
    lines.push(row("Neither recording (graphics, other footage)", x => share(x.layouts.other)));
    lines.push(row("Inset: middle across, down", x => x.inset ? `${share(x.inset.x)}, ${share(x.inset.y)}` : "–"));
    lines.push(row("Inset: width × height of the frame", x => x.inset ? `${share(x.inset.width)} × ${share(x.inset.height)}` : "–"));
    lines.push(row("Inset: part of the camera shown", x => x.inset ? `${share(x.inset.shown.w)} wide, ${share(x.inset.shown.h)} high` : "–"));
    lines.push(row("Full-frame camera scale", x => x.cameraScale === null ? "–" : `${x.cameraScale.toFixed(2)}×`));
    lines.push(row("Screen scale, median (10th–90th)", x => x.mainScale ? `${x.mainScale.median.toFixed(2)}× (${x.mainScale.p10.toFixed(2)}–${x.mainScale.p90.toFixed(2)})` : "–"));
    lines.push(row("Screen width shown, median", x => x.mainShownWidth === null ? "–" : share(x.mainShownWidth)));
    lines.push(row("Layout changes per minute", x => x.layoutChangesPerMinute.toFixed(1)));
    lines.push(row("Framing changes per minute", x => x.framingChangesPerMinute.toFixed(1)), "");
    for (const [name, c] of [["Applied", p.applied], ["Proposed", p.proposed]] as const) {
      lines.push(`**${name} against the published picture.** Same layout at ${c.layoutAgreement === null ? "–" : share(c.layoutAgreement)} of ${c.compared} shared moments` +
        ` (${Object.entries(c.confusion).filter(([k]) => { const [a, b] = k.split("→"); return a !== b; }).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(", ") || "no differences"}).` +
        (c.inset ? ` Insets sit ${share(c.inset.distance)} of the frame apart, ${c.inset.widthRatio.toFixed(2)}× the published width, and share ${share(c.inset.shownOverlap)} of the camera shown.` : "") +
        (c.main ? ` The screen is framed the same at ${share(c.main.sameFraming)} of ${c.main.moments} moments (median overlap of what is shown ${share(c.main.shownOverlap)}, scale ${c.main.scaleRatio.toFixed(2)}× the published one).` : ""), "");
    }
  }
  if (score.plan) {
    lines.push(`**Plan.** ${score.plan.cuts} ranges submitted (${Object.entries(score.plan.byKindDecision).map(([k, v]) => `${k} ${v}`).join(", ")}). ` +
      `Edged cuts checked with dialogue_check_join: ${score.plan.checkJoinCoverage === null ? "–" : `${Math.round(score.plan.checkJoinCoverage * 100)}%`} of ${score.plan.edged}.`, "");
  }
  if (score.trace) {
    const t = score.trace;
    lines.push(`**Trace.** ${t.state}, ${t.activeSeconds === null ? "–" : `${(t.activeSeconds / 60).toFixed(1)} min`} active` +
      `${t.waitingSeconds ? ` (+${(t.waitingSeconds / 60).toFixed(1)} min waiting for the editor)` : ""}, first change after ${t.firstChangeSeconds === null ? "–" : `${(t.firstChangeSeconds / 60).toFixed(1)} min`}, ` +
      `first call for the editor after ${t.firstCallSeconds === null ? "–" : `${(t.firstCallSeconds / 60).toFixed(1)} min`}, ` +
      `first recommendation after ${t.firstRecommendationSeconds === null ? "–" : `${(t.firstRecommendationSeconds / 60).toFixed(1)} min`}. ` +
      `${t.toolCalls} tool calls (${Object.entries(t.byTool).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(", ")}), ${t.errors} errors` +
      `${t.errors ? ` (${Object.entries(t.errorsByTool).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}. ` +
      `Listened ${t.inspection.listened}×, visual inspections ${t.inspection.visual}, level reads ${t.inspection.levels}. ` +
      `Tokens: ${t.usage ? Object.entries(t.usage).map(([k, v]) => `${k} ${v}`).join(", ") : "not recorded"}.`, "");
  }
  if (score.reference) {
    lines.push(`## Against ${score.reference.label}`, "");
    const pub = score.reference.published;
    if (pub) {
      lines.push(`${pub.matchedWords} of the published video's ${pub.finishedWords} words were found in the recordings` +
        `${pub.addedPassages ? `; ${pub.addedPassages} passage${pub.addedPassages === 1 ? "" : "s"} (${s(pub.addedSeconds)}) are in no recording` : ""}` +
        `${pub.reordered ? `; ${pub.reordered} piece${pub.reordered === 1 ? " plays" : "s play"} out of recording order` : ""}` +
        `${pub.rate === 1 ? "" : `; it plays at ${pub.rate}× the recordings' speed`}. ` +
        "Its words say what was kept. Where its cut edges sat in the silence between words is not known, so edges are not scored.", "");
    }
    lines.push("| Operating point | Word P / R / F1 | Time P / R / F1 | Edge F1 @20 ms / 100 ms | Median edge error | Required lines missing | Decisions agreement |", "|---|---|---|---|---|---|---|");
    for (const [name, p] of Object.entries(score.reference.operatingPoints)) {
      const c = p.cut;
      lines.push(`| ${name} | ${c ? `${f(c.words.precision)} / ${f(c.words.recall)} / ${f(c.words.f1)}` : "–"} | ` +
        `${c ? `${f(c.time.precision)} / ${f(c.time.recall)} / ${f(c.time.f1)}` : "–"} | ` +
        `${c && !pub ? `${f(c.edges.f1["20ms"]?.f1)} / ${f(c.edges.f1["100ms"]?.f1)}` : "–"} | ${c && !pub ? `${c.edges.medianAbsErrorMs ?? "–"} ms` : "–"} | ` +
        `${c ? `${c.requiredLines.missing}/${c.requiredLines.required}` : "–"} | ${p.decisions ? `${f(p.decisions.agreement)} (${p.decisions.scored})` : "–"} |`);
    }
    lines.push("");
  }
  const speech = [...a.edgeList.map(e => ({ ...e, tier: "applied" })), ...(r?.edgeList ?? []).map(e => ({ ...e, tier: "review" }))]
    .filter(e => e.class === "speech");
  if (speech.length) {
    lines.push(`## Edges on speech (${speech.length})`, "", "| Tier | Source | Side | Over floor | Clipped | Words | Reason |", "|---|---|---|---|---|---|---|");
    for (const e of speech.slice(0, 40)) {
      lines.push(`| ${e.tier} | ${clock(e.at)} | ${e.side} | ${e.overFloorDb ?? "–"} dB | ${e.clippedWord ?? ""} | ${(e.context ?? "").replace(/\|/g, "/")} | ${(e.reason ?? "").slice(0, 90).replace(/\|/g, "/")} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export interface TrialRow { caseId: string; config: string; trial: number; taskId?: string; state: string; headline?: Record<string, number | null>; error?: string }

/** Mean and spread of each headline metric per case × configuration. */
export function runMarkdown(title: string, rows: TrialRow[]): string {
  const groups = new Map<string, TrialRow[]>();
  for (const row of rows) groups.set(`${row.caseId}\u0000${row.config}`, [...(groups.get(`${row.caseId}\u0000${row.config}`) ?? []), row]);
  const keys = ["appliedSeconds", "reviewSeconds", "appliedSpeechEdges", "reviewSpeechEdges", "clippedWordsOnSound", "needsYourCall", "heldByScarlet", "gapsLeft", "looseJoins",
    "deadAirSeconds", "repeatsLeft", "repeatsAtJoins", "checkJoinCoverage",
    "wordF1", "timeF1", "edgeF1At20ms", "requiredLinesMissing", "toolErrors", "activeMinutes", "tokens"];
  const lines = [`# ${title}`, "", `| Case | Config | Trials (done) | ${keys.join(" | ")} |`, `|---|---|---|${keys.map(() => "---").join("|")}|`];
  for (const [key, group] of groups) {
    const [caseId, config] = key.split("\u0000");
    const done = group.filter(g => g.headline);
    const cells = keys.map(k => {
      const values = done.map(g => g.headline![k]).filter((v): v is number => typeof v === "number");
      if (!values.length) return "–";
      const mean = values.reduce((x, y) => x + y, 0) / values.length;
      const sd = Math.sqrt(values.reduce((x, y) => x + (y - mean) ** 2, 0) / Math.max(1, values.length - 1));
      const digits = Math.abs(mean) < 10 && !Number.isInteger(mean) ? 2 : 1;
      return values.length > 1 ? `${mean.toFixed(digits)} ± ${sd.toFixed(digits)}` : mean.toFixed(digits);
    });
    lines.push(`| ${caseId} | ${config} | ${group.length} (${done.length}) | ${cells.join(" | ")} |`);
  }
  const failed = rows.filter(r => r.error);
  if (failed.length) lines.push("", "Failures:", ...failed.map(r => `- ${r.caseId} · ${r.config} · trial ${r.trial}: ${r.error}`));
  return lines.join("\n") + "\n";
}
