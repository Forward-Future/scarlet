# Scarlet evals

Measure whether a prompt, skill, tool, or model change makes Scarlet's AI first cut better. The suite grades
outcomes with code: what was removed, whether each join lands in silence, how the cut compares with the
editor's own, and what the agent did to get there.

**Never commit project data.** Cases, evidence, and results contain the user's transcripts and timings. They
live outside the repository in `$SCARLET_EVAL_DATA`, which defaults to `<Scarlet application support>/evals`
(`~/Library/Application Support/com.forwardfuture.scarlet/evals` on macOS). The writers refuse any path
inside the checkout. Fixtures under `evals/test` are synthetic.

## Setup

Nothing to install. Run the scripts with the repository's `tsx`, against a running Scarlet engine. The
desktop engine publishes its loopback port and a per-launch token together in a private session file.
For another engine, set its own `SCARLET_ACCESS_TOKEN` and supply its URL with `--engine` or
`SCARLET_ENGINE_URL`. Remote URLs require HTTPS. A loopback tunnel can use HTTP.

```sh
TSX=node_modules/.bin/tsx                       # from the repository root
$TSX evals/src/dataset.ts --help
node_modules/.bin/vitest run --config evals/vitest.config.ts
node_modules/.bin/tsc -p evals/tsconfig.json
```

## What it measures

Times are seconds on the dialogue recording's source clock, so runs from different versions can be compared.

**Removals** (`metrics.ts`, `score.ts`). Seconds and cuts for each category: retake, filler, pause,
coaching, and automatic removals in historical runs. Results are split by tier:

- **Applied:** confident cuts.
- **Review:** staged cuts. This tier also records the AI's second-pass verdict (cut, keep, or ask) and the
  editor's decision (approved, skipped, or pending).

**Edge quality.** These metrics cover each join a tier introduces.

- **Level class.** Each edge is classed as silence, low, or speech. The level is the loudest frame within
  ±20 ms of the edge. Silence is below the recording's room floor plus 8 dB. Speech is at or above the
  typical speech level minus 18 dB. The floor and speech level are the 15th and 85th percentiles of the
  recording's own levels.
- **Level source.** Levels are decoded at full band (16 kHz, 10 ms frames) from the original file with ffmpeg.
  The same joins are also measured on the engine's cached waveform. That view shows what `dialogue_check_join`
  and the scan can actually see.
- **Coarse grid.** Counts edges on whole seconds, half seconds, or the 0.48 s phase.
- **Clipped words.** A word is clipped when its transcript timing crosses the edge by more than 20 ms.
  Transcript timings drift, so the stricter "clipped and not silent" count is the one to trust.
- **Hand-analysis method.** `--kept-side` reads the loudest 50 ms on the kept side. "Per-cut edges" counts both
  edges of every listed cut, the way the original hand analysis did.

**Pacing** (`pacing` in `metrics.ts`). What each version still plays, read from the transcript's words on that
version's timeline: the source, the applied cut, the proposed cut and the reference.

- **Gaps.** A stretch of half a second or more without a word, counted apart inside kept footage (the pass never
  touched it) and across a join (a cut left it). Also the gaps of a second or more, the median gap at a join, and
  dead air: the time in gaps over a quarter-second beat.
- **Doubled words.** Counts consecutive deliveries of the same word or phrase, including repeats across a join.
  The second delivery must begin within three seconds of the first ending. For phrases over five words, the two
  starts must be within 25 seconds of each other. The reference count includes deliberate emphasis ("very, very").
- A typed or silent demonstration is a gap here. The reference's own count is the floor a cut can reach.

**Held by Scarlet.** Staged cuts the agent submitted as `cut`: the measured edit needs review.

**Against a reference** (the editor's final or approved cut). This section is scored at three operating points:

- `applied`: the confident cuts alone.
- `recommended`: applied plus the review items the AI marked `cut`.
- `proposed`: applied plus every review item.

The metrics are:

- Word keep/cut labels, giving precision, recall, and F1 of removed words.
- The same for removed time.
- Edge F1 at 20 and 100 ms, plus the median and p90 placement error of edges matched within 1 s.
- Required lines missing: sentences the reference keeps (≥80% of their words) that the candidate cuts
  (≥50% of their words).

Labels derived from the editor's approve and skip decisions give a separate agreement score.

**Trace.** This section covers the agent's process:

- Active time, which excludes time spent waiting for the editor's answer.
- Time to the first change.
- Time to the first call for the editor: when the first staged cut reached Needs your call. This is how soon
  the editor can start deciding. Also the time to the agent's first saved recommendation.
- Tool calls by tool, and errors by tool.
- Listening calls (`source_audio`, or `includeAudio` on a check, inspect, or review), visual inspections,
  and level reads.
- `task.usage` token counts when the engine records them.
- The submitted plan by kind and decision.
- The share of edged cuts whose edges were checked with `dialogue_check_join`.

## Build a case

A case is a project, a source version to cut from, the request (instruction and skills, as the app sends
them), the words and levels for each dialogue recording, and an optional reference.

```sh
# From a finished run: source version, request and the run itself (for replay and offline re-scoring).
$TSX evals/src/dataset.ts build --project prj_… --from-task tsk_… --with-scan --id my-case

# Reference = the editor's finished cut.
$TSX evals/src/dataset.ts build --project prj_… --source <version> --reference-version <final version>

# Reference = the video that was published, cut from this raw footage by its editor.
$TSX evals/src/dataset.ts build --project prj_… --source <raw assembly version> --published-media med_…

# Reference = the editor's approve/skip decisions on that run's review (and its applied cuts).
$TSX evals/src/dataset.ts build --project prj_… --from-task tsk_… --reference-decisions

$TSX evals/src/dataset.ts list
```

**A published video as the reference** (`published.ts`). Import the finished video into any project of the library
and let it transcribe, then name it with `--published-media` (or pass its words as `--published-words file.json`).
Its words are matched to the raw recordings' words by text and time together (`packages/mcp/src/reference-match.ts`),
so of a line said twice only the take that plays counts as kept. The case stores what was kept of each recording
and the published video's own words, which give its pacing: the gaps and doubled words its editor left.

- The build prints how many of the published video's words were found in the recordings and warns under 80%.
  Speech no recording has (an intro recorded later, a sponsor read) is set apart and never scored.
- For each join whose two adjacent words can be identified in one recording, the score checks whether Scarlet
  joins those exact takes. It reports the median signed, median absolute, and p90 absolute difference in the
  time between words on the two playback clocks. The coverage count lists joins shared by both cuts and pairs
  Scarlet left unedited. Added narration, ambiguous repeated pairs, and unmatched boundary words cannot establish
  a comparison. The JSON includes the individual matched joins and their published times.
- Word timing estimates the material kept. Each kept piece extends half the published pause past its outer
  words, so removed-time scores inherit that approximation. Exact source-edge scores have no ground truth in a
  transcript-only case. The JSON records `edges: null` for all three operating points. In older saved results,
  any edge metrics accompanied by `reference.published` were computed against estimated padding and should
  be excluded from comparisons.
- Recovering a known 22-minute cut of 169 pieces from its words alone labelled 6275 of 6284 words correctly. Where
  the two transcripts hear a word differently at the edge of a piece, that word is lost from the piece.

**The published picture** (`picture.ts`, `pictureMeasure.ts`, `layout.ts`). With `--published-video <file>` the build
also measures where each recording sits in the published frame, every `--picture-every` seconds (default 2). The
word match says which recording second each published moment plays; the raw assembly says which second of the
other recordings goes with it. Each recording's frame is then found in the published frame by correlation at
every size and place, which gives its scale, its position and the part of it that shows.

- A moment is `camera` (the presenter fills the frame), `inset` (the presenter over another picture), `screen`
  (no presenter) or `other` (neither recording: a graphic, other footage, or a miss).
- A version's own layout is read from its clips' transforms at the same recording seconds, with no render.
- Scored: the share of moments with the same layout, how far apart and how large the two insets are, how much of
  the camera both insets show, and whether the screen is framed the same (the parts shown overlap by 70% or more).
- Frames are compared at 320 by 180 in blocks of 8 pixels, so a position is good to about 3% of the frame. A dark,
  nearly featureless screen can go unfound and count as `other`.

`--suite regression` marks a case that guards behavior that already works. Keep regression cases apart
from capability cases, which measure how good cuts are, and read their results separately. `--with-scan`
stores every saved set of dialogue-scan windows for replay. The engine only serves windows for its current
detector settings, so these are read from the library database, read-only.

Review decisions come from `GET /api/projects/:id/review-decisions[?taskId=]`
(`apps/server/src/routes/evalExport.ts`). Engines that predate the route are handled by computing the same
records locally from changes and timelines. Choices the editor has staged in the review UI but not yet
applied live in the app's local storage. They count as pending.

### Match a finished soundtrack to its source

Use `match_audio.py` to locate the original samples behind each passage in an export. It needs Python 3.9+ with NumPy 1.20+, `ffmpeg` and `ffprobe` on PATH. Both inputs stay local. The first audio stream is used by default. Select a microphone or mix with `--raw-track` and `--final-track` (zero-based).

```sh
python3 evals/tools/match_audio.py /path/to/raw.mp4 /path/to/final.mp4 \
  --output "$SCARLET_EVAL_DATA/reference.json"
```

The script retrieves candidate passages by their sound spectrum, checks the waveform at its native speed and refines each join in a second frequency band. The final may reorder and reuse passages, add music, change gain or replace the picture. Matching requires enough of the original audio to survive. The tool assumes a constant frame rate for locating edges and a single source recording. Speed changes, voiceovers, missing sources and indistinguishable duplicate takes can leave regions unmapped.

`segments` lists source and final start/end times in seconds, in final playback order. `joins` records the source edges and the range of plausible boundary times on the final clock. Quiet boundaries can be uncertain by several frames. `keptSource` merges repeated source time. When any final passage lacks a reliable source match, the tool records it in `unmappedFinal`, sets `removedSource` to `null` and exits with status 2. Use the map to inspect these passages before selecting the pair for full-video removal scoring.

Run `python3 -B -m unittest discover -s evals/test -p test_match_audio.py` for synthetic checks of reordered and reused material, gain, noise and unmatched audio.

### Score a waveform-matched final

For a cut of one audible source at its native speed, `score_audio_reference.py` reads an audio correlation map,
the raw source's word timings and an actual Scarlet timeline. It runs offline with Python 3's standard library.

```sh
python3 evals/score_audio_reference.py --reference "$SCARLET_EVAL_DATA/reference.json" \
  --case-dir "$SCARLET_EVAL_DATA/cases/my-case" --timeline "$SCARLET_EVAL_DATA/candidate.json" \
  > "$SCARLET_EVAL_DATA/candidate-score.json"
```

An evidence JSON with `mediaId` and a `words` array can be supplied with `--evidence` in place of the case.
With a stored case, `--evaluation evaluation.json --tier applied` (or `proposed`) resolves its saved timeline.
The reference must account for the full published soundtrack. The score brackets each reference edge using its
earliest and latest plausible time, any independent high-band bounds, and one frame of margin.

The JSON reports precision, recall and F1 for removed words and seconds within the confidently labeled source.
It includes the words cut or kept in error, the kept sentences lost, and how many pairs of shared source words
play in reverse order. Spacing is the end-to-start gap at actual joins with the same two identifiable source
words on both playback clocks. Its report includes coverage, pairs left unedited, signed and absolute gap errors
in milliseconds, and each matched instance. `python3 -m unittest discover -s evals/test -p 'test_audio_reference.py'`
checks these metrics against synthetic timelines with known answers.

In `spacing`, `longerByOver200Ms` and `shorterByOver200Ms` count matched joins where the candidate pause
exceeds or falls short of the human pause by more than 200 ms. The signed error is rounded to 0.01 ms before
thresholding. Exactly +200 and −200 ms count toward neither total. The corresponding `Pct` fields use
`sharedJoins` as their denominator and are `null` when there are no matches. Report `sharedJoins` alongside
`eligibleJoins` so a run that cut differently retains its coverage. To compare two runs on identical joins,
intersect their `matched` rows on `afterWord`, `beforeWord` and `finalAt` using the same source word list and reference.
The two flanks must lie in adjacent pieces in both edits. An intervening wordless piece spans two cuts and is
excluded. If a trim crosses a retained word, the scorer clamps its transcript boundary to the portion that plays.
The resulting gap measures time between retained word intervals and inherits the uncertainty of their alignment.
This scorer accepts a completely mapped single-source final. It rejects maps containing external passages,
uncertain retained-source regions or annotated reference-join exclusions that require a specialized scorer.

### Score both pictures at a cut

`score_frame_pairs.py` compares verified picture cuts with the candidate edit at tolerances of 0, 5 and 10
source frames. Supply one reference file and one candidate file for the same original recording and frame clock.
Each file identifies the source and lists zero-based presentation-order indices of the **last outgoing** and
**first incoming** source picture at each cut. For example, a cut from frame 100 to 200 is represented by
`{"sourceId":"camera-a","pairs":[[100,200]]}`.

```sh
python3 -B evals/score_frame_pairs.py --reference "$SCARLET_EVAL_DATA/verified-frame-pairs.json" \
  --candidate "$SCARLET_EVAL_DATA/candidate-frame-pairs.json"
```

Measure the displayed source pictures from the exports or an independently verified source-frame mapping.
The audio correlation map locates audio boundaries; it cannot supply these picture indices. Within each tolerance
the scorer finds the largest one-to-one set of matches where **both** source pictures of the same cut fall inside
the tolerance, inclusive. A continuous split such as `[100,101]` is ignored in the candidate. Report the
matched count and percentage of **verified reference cuts** with `candidateCuts` and the number of human cuts
for which pictures were verified. An empty reference yields a null percentage. This measures recall on the
verified subset. `python3 -B -m unittest discover -s evals/test -p test_frame_pairs.py` runs the synthetic controls.

## Replay published word choices at the join

A waveform map from `evals/tools/match_audio.py` can also supply the exact removed words for a conditional test of Scarlet's edge placement. Use a case built from one raw dialogue clip at normal speed. Each mapped forward join between two kept words is submitted separately as a word-index removal. A join is excluded when the measured uncertainty at its edges, plus one final-video frame on either side, changes any word's keep/cut label. Counts show pause-only, backward and other excluded joins, along with the applied, review and returned-for-revision totals.

```sh
node --import tsx evals/src/wordEdges.ts --case my-case --reference-map /private/path/audio-map.json --out /private/path/baseline.json
node --import tsx evals/src/wordEdges.ts --case my-case --reference-map /private/path/audio-map.json --baseline /private/path/baseline.json
```

The first run reads and caches the recording's waveform, peaks and voice activity from the engine. Subsequent runs replay offline on the same measurements. `--engine URL` selects the engine and `--waveforms PATH` selects a private cache. The output records how many joins removed a different set of word midpoints and the mean absolute error in the gap between the kept words, in milliseconds, before and after the timeline's frame rounding. A baseline comparison scores common joins on identical case inputs. Each result also includes every eligible join for that version. Use the full task benchmark to measure the agent's choice of words.

## Run

```sh
# Show exactly what would be sent. Nothing is launched without --yes.
$TSX evals/src/run.ts --cases my-case --configs codex:<model>:medium,claude:<model>:high --trials 3 --dry-run

# Launch (billed agent tasks).
$TSX evals/src/run.ts --cases my-case --configs … --trials 3 --yes
```

Each trial follows these steps:

1. Creates the branch `eval <case> <config> t<n> <time>` from the case's source version.
2. Sends the composer's first-cut request on that branch.
3. Waits for the task. A question or a timeout cancels it.
4. Switches the project back to the editor's branch.
5. Scores the run.

Trials run one at a time because a project has one head. The project shows the eval branch while a trial
runs. Results land in `results/runs/<time>/<case>/<config>/trial-<n>/` (`evaluation.json`, `summary.md`,
`task.json`). The mean ± spread for each case and config is in `results/runs/<time>/summary.md`. Rebuild the
summary with `--summarize <dir>`.

Score an existing task (read-only) or a case's stored run (offline):

```sh
$TSX evals/src/run.ts --evaluate-task tsk_… [--reference-version <v>] [--kept-side]
$TSX evals/src/run.ts --evaluate-case my-case
```

## Replay

The replay runs a stored `dialogue_apply_cuts` plan offline through the planning step the tool itself calls,
`planDialogueCuts` in `packages/mcp/src/dialogue-plan.ts`. That step covers:

- Word-reference resolution.
- Quote checks.
- Edge checks, snapping and padding.
- Review staging and the gate report.

```sh
$TSX evals/src/replay.ts --case my-case                       # vs. what the run produced
$TSX evals/src/replay.ts --case my-case --baseline <earlier replay.json>   # vs. before your code edit
$TSX evals/src/replay.ts --case my-case --plan edited-plan.json           # a different plan
$TSX evals/src/replay.ts --case my-case --drop-quotes   # compare the same plan offline without its optional quotes
```

Scan windows become join evidence through the tool's `dialogueScanPage`. Offline there is no live
measurement, so an edge that no scan window covers stays unmeasured.

The output reports the following:

- The plan's outcome: ready, or needsRevision with the disputed quotes.
- The gate's changes.
- Tier transitions from the original to the replay.
- Edge quality of the replayed outcome.
- Per-range differences from a baseline.

The scan-window set that best reproduces the original run is chosen automatically.

## Principles

- Grade outcomes with code. LLM judges are for trend dashboards only, never for pass or fail.
- Run several trials per configuration. Agent runs vary, so compare means with their spread, not single runs.
- Keep a regression suite separate from capability cases.
- Measure with evidence independent of the system under test. Compare 10 ms levels decoded from the
  original recording with the waveform Scarlet used for its decisions.
- Never commit user data. Everything project-derived stays in `$SCARLET_EVAL_DATA`.
