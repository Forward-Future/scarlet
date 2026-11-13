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
coaching, and the fillers and pauses Scarlet adds by itself. Results are split by tier:

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

**Held by Scarlet.** Staged cuts the agent submitted as `cut`: an edge check or the editor's Suggest setting put
them in front of the editor.

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
- Words say what was kept, not where each edge sat in the silence between two words, so edge agreement is not
  scored against a published video. A kept piece reaches half the published pause past its outer words.
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

After planning, replay applies the engine's per-kind editor settings (`applyDialoguePreferences`). Nothing is
mirrored, so code edits show up directly.

```sh
$TSX evals/src/replay.ts --case my-case                       # vs. what the run produced
$TSX evals/src/replay.ts --case my-case --baseline <earlier replay.json>   # vs. before your code edit
$TSX evals/src/replay.ts --case my-case --plan edited-plan.json           # a different plan
$TSX evals/src/replay.ts --case my-case --tightness tight --ai-cuts filler=suggest   # editor settings
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
