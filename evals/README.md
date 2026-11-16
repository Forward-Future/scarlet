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

## Compare two revisions on a frozen episode

`compare.py` runs each checkout's real cut planner on the same source word occurrences and writes a Markdown scorecard and a content-addressed JSON report. Use it for cut placement and pacing. It works offline after setup. A prepared episode can be copied between machines. Install the locked dependencies in each checkout with `pnpm install --frozen-lockfile`.

```sh
python3 -B evals/compare.py "$EPISODE" --baseline "$BASE_CHECKOUT" --candidate "$CANDIDATE_CHECKOUT" \
  --baseline-leave 0.25 --candidate-leave 0.15
python3 -B evals/compare.py "$EPISODE" --check-baseline
```

The first command requests 250 ms and 150 ms between retained words. Both values go through the planner's `leave` argument and audio checks. For a code comparison at one pacing setting, pass the same value twice. Without either flag the runner measures the engine's default word-cut placement and counts pause-only joins separately. Both checkouts must implement the measured planner API. The runner builds their shared and timeline packages before scoring. Newer graders or engine changes get their own reports.

**Prepare once.** Keep one directory per episode version outside the checkout, with:

- `cases/<id>/` containing the saved case, raw timeline, timed words, plans and their source versions.
- `media/presenter.mp4`, `media/published.mp4` and any other original camera recordings; `reference-audio.json` from `match_audio.py` (above).
- `waveforms.json` containing the full cached 20 ms waveform pages and voice activity used by `wordEdges.ts`. Use the same raw recording, source clock and audio stream throughout.
- `pictures.json` containing verified outgoing and incoming source-picture indices and the raw presenter's SHA-256 as `sourceId`, plus `source-pts.json` containing its presentation times in seconds (source time zero at PTS zero). To prepare them, run `uv run --with opencv-python-headless python -B evals/tools/verify_pictures.py "$EPISODE"` with FFmpeg available. For a presenter inset, supply its normalized `--inset X Y W H`. The verifier fits the camera crop on a separate frame. The image and motion across three consecutive frames must then identify a unique cut on both sides. Check representative matches and record layouts outside its coverage.
- `provenance.json` can record the published source, episode split, capture methods and editorial settings.

Run `python3 -B evals/compare.py "$EPISODE" --freeze CASE_ID` to hash the private inputs. Run a comparison with `--accept-baseline` to pin the report, then use `--check-baseline` to reproduce it on the same revisions. The latter reads the pinned settings. Run it on the second machine after copying the episode and checking out the recorded revisions. If the grader or inputs change, keep the old episode and pin a new version. Private caches in `preparation/` and results in `results/` are outside the input lock.

**Read a comparison.** Pacing counts use only the same word occurrences placed in both variants. They include a pause left intact when the requested trim is unnecessary. Long and short errors are strictly beyond ±200 ms. Consult the per-side eligible counts, calls for review, word errors and omitted joins alongside the paired rate. Frame recall uses all independently verified picture cuts, including those without a corresponding placement. A zero denominator has no percentage. The input words came from the published choice; this measures placement conditional on those choices. Use a full model trial below to measure editorial selection. For partial soundtrack matches, `unmappedFinal` stays visible and whole-source cut/keep scores require separate evidence.

`extraKeptWordTrimMs` flags cuts overlapping a kept word by more than 20 ms beyond the overlap in the published edit. These are listening cues because timed word boundaries are approximate.

`python3 -B evals/listen.py "$EPISODE" /private/path/to/comparison.json` prepares blind A/B clips of the largest improvement, regression and a near-neutral change among comparable joins. Each pair has the same source context. Its randomized assignment remains stable on replay. Ask for a preference before opening `listening/answer-key.json`.

## Run

```sh
# Show exactly what would be sent. Nothing is launched without --yes.
$TSX evals/src/run.ts --cases my-case --configs codex:<model>:medium,claude:<model>:high --trials 3 --dry-run

# Launch (billed agent tasks).
$TSX evals/src/run.ts --cases my-case --configs … --trials 3 --yes
```

Each trial follows these steps:

1. Creates a branch from the case's source version. Its name includes the trial number and a unique run ID, even when long case or model names need shortening.
2. Sends the composer's first-cut request on that branch.
3. Waits for the task. A question or a timeout cancels it.
4. Switches the project back to the editor's branch.
5. Scores the run.

Trials run one at a time because a project has one head. The project shows the eval branch while a trial
runs. Results land in `results/runs/<time>/<case>/<config>/trial-<n>/` (`evaluation.json`, `summary.md`,
`task.json`). The mean ± spread for each case and config is in `results/runs/<time>/summary.md`. Rebuild the
summary with `--summarize <dir>`.

For audio-matched cases, read `recoveredWordRemovingCuts` against `editorWordRemovingCuts`, alongside `missingVerifiedWords`. A recovered cut joins the same two source-word occurrences across a splice. `matchedPauseErrorMs` averages absolute pause differences only on the `matchedAudioJoins` shared by both edits. Unmapped passages contribute no joins. A crossfade with quiet handles uses each word’s actual playback time. The scorer counts a crossfade touching speech as ambiguous and records unsupported mixes as unavailable.

For a change to the prompt, model or transcription, run three fresh trials per configuration. Each
trial requests a digest of the ordered word occurrences and timings actually read by the editing tools.
`transcripts.json` compares those receipts with the frozen words and engine snapshots before and after
the task. A missing receipt, an older MCP without this feature, or a changing transcript excludes that
trial from the mean and leaves its evidence available. To test a new transcription, freeze a case for
each transcript on the same media and published reference.

With `SCARLET_EVAL_DATA` pointing to a frozen episode, each live trial saves its applied timeline and
`published-words.json`. The latter lists which definitely published source-word occurrences the trial
removed and the fraction it kept. The report needs positive evidence for each word. Unmapped footage
therefore contributes no labels. Score an archived run the same way with
`python3 -B evals/score_audio_reference.py --case-dir "$CASE_DIR" --reference "$EPISODE/reference-audio.json" --evaluation "$EVALUATION" --verified-keeps`.

The same report includes `cutWordDistance`. It adds editor-kept words the candidate removed and
editor-skipped words the candidate kept, then divides by the number of labeled source occurrences.
On a partly matched soundtrack, a skipped word needs a verified local forward splice. It could still
appear in an unmapped passage. The report records that scope and excludes unknown words from the
denominator. Compare the two error counts as well as their sum. A word counts as retained when at
least half of its source duration plays. First-consonant and fade checks are separate measurements.

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
$TSX evals/src/replay.ts --case my-case --parts          # every part of a pass that saved as it went
$TSX evals/src/replay.ts --case my-case --parts --baseline <earlier …-parts.json>
```

A pass that saves as it goes submits a plan for each part, each on the version the part before it left. `--parts`
replays the last plan on each version and totals them, so the replay covers the pass and not its first few
removals. Edges are also measured as the engine saves them, each removal rounded inward to whole frames, and each
result lists the applied edges that land on speech (`appliedOnSpeech`), in source seconds. A case that stores only
some of the run's versions replays the parts it has and names the rest.

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

### Picture cut to first word

For frozen single-presenter episodes with verified picture observations, score a saved timeline locally:

```sh
SCARLET_EVAL_DATA="$EPISODE" node --import tsx evals/src/entrances.ts --case "$CASE" --version "$VERSION" > entrances.json
SCARLET_EVAL_DATA="$EPISODE" node --import tsx evals/src/entrances.ts --case "$CASE" --timeline candidate.json --baseline entrances.json
```

The baseline may also be an exported timeline. The paired report gives mean absolute timing error for each edit on the same matched entrances, the change in milliseconds, and the joins each edit alone matched. A negative change means a closer match to the editor. The report includes the first 40 seconds separately.

Use `--timeline candidate.json` for an exported timeline. New model trials, `--evaluate-case` and `--evaluate-task --case` also write `picture-entrances.json` when the episode contains picture evidence. The grader checks the frozen inputs. Older picture observations resolve the frame timestamp with FFprobe against the hash-checked finished movie. New observations store the presentation timestamp directly. Prepare a reference with the existing audio and picture tools. Candidate media and the editor reference stay outside Git.

Each row measures from the incoming presenter picture to the aligned start of the incoming take’s first spoken word. Positive values mean the picture leads the voice. Negative values mean the voice starts first. Both neighboring source-word occurrences must match uniquely. Scarlet uses the actual audio placement and first displayed project frame. The reference uses the verified published frame timestamp and its independently mapped soundtrack. Uncertain word boundaries, a partial word, an onset under an audio fade, or an unmatched picture have their own outcomes. A different camera or a picture cut under a covering layer may lack comparable evidence.

For repeated trials compare mean absolute error and signed bias **on the same matched joins**, alongside coverage and candidate-wide counts of trimmed words and onsets inside fades. Missing observations stay unscored. The JSON includes individual join IDs, candidate and editor times, the first 40 published seconds, and episode and candidate digests. The editor’s timings are evaluation labels. Keep the desired delivery and exceptions in a selectable custom skill.

To test one custom guide on the same frozen footage, pass `--skills skill-name` to replace the case’s selection for that run. To add a guide to the original selection, pass `--add-skills skill-name`. The source timeline and the editing request stay fixed across arms. Each trial records the selected IDs, current names and versions. Keep model, effort, source case and trial count fixed across arms.

### Choosing between two recorded takes

Use this experiment to measure whether a model picks the delivery an editor used. A passage has three choices. Keep the earlier rendition and join it to the later continuation, start on the later rendition, or keep the whole passage. Scarlet supplies repeated phrases and the original audio. The selected skill describes the desired edit. The model chooses. The editor’s export is used only for scoring.

Use a fresh private directory for each run. A source evidence JSON contains timed words and the duration of the recording. Repeat `--episode` for other recordings and `--guide` for other Markdown guides.

```sh
python3 evals/prepare_take_pairs.py \
  --episode example holdout "$SOURCE" "$EVIDENCE" --out "$STUDY/source"
python3 evals/take_listening.py prepare --manifest "$STUDY/source/cases.json" \
  --guide "$STUDY/current.md" --guide "$STUDY/candidate.md" --out "$STUDY/batch"
```

Give the runner only `batch/requests.jsonl` and the WAVs it names. Each passage appears with the same words with and without sound. A second presentation swaps the excerpts and rotates the answer letters. Lock the model, decoding settings and guides before opening the reference. Verify that the runner can identify two different spoken lines in their presented order. Each response must record the request ID, original prompt SHA-256, ordered WAV SHA-256 digests, attachment count, number of audio tokens, seed, temperature and answer text. An ambiguous answer counts as a miss on a labeled passage.

On Apple silicon, the optional MLX runner accepts a local Gemma 3n model directory and performs inference offline. In a separate Python 3.12 environment the measured setup used `mlx-vlm==0.7.12`, `mlx==0.32.4`, `transformers==5.23.0` and `soundfile==0.14.0`. The 4-bit checkpoint was `mlx-community/gemma-3n-E4B-it-4bit` revision `505468a22e5703ff090e222aae9beedec49b383f`. Save the exact model revision and runtime package versions with each study. For three-option passages, use the same one-letter decoder for every arm.

```sh
python3 -B evals/run_take_listening_mlx.py --model "$MODEL_DIR" \
  --input "$STUDY/batch/requests.jsonl" --output "$STUDY/responses.jsonl" --choice-letters ABC
```

The runner joins the two original waveforms with 750 ms of silence so the model can hear both within one audio input. Its receipts include both original hashes and the joined waveform hash. Calibrate with two spoken phrases whose words are absent from the prompt. Reverse their order and check both transcriptions. Also ask the model to identify the excerpts by letter in both orders using the experiment’s decoder. Record any failures alongside editorial accuracy. The runner writes `responses.jsonl.runtime.json` before inference and records its hash with every answer. Seal the completed batch before decoding. Keep the receipt and original batch for replay. New request IDs bind each response to its private answer mapping. When replaying an older batch with numeric IDs, pass `--legacy-key-sha256` to `decode` with the key digest from an independently archived choices file or inventory.

Supply a separate private JSON object mapping each recording ID to its source word evidence and independently prepared `reference-audio.json`. For example, `{"example":{"words":"/private/path/words.json","reference":"/private/path/reference-audio.json"}}`.

```sh
python3 evals/label_take_pairs.py --manifest "$STUDY/source/cases.json" \
  --sources "$STUDY/reference-index.json" --out "$STUDY/labels.json"
python3 evals/take_listening.py seal --requests "$STUDY/batch/requests.jsonl" \
  --responses "$STUDY/responses.jsonl" --runtime "$STUDY/responses.jsonl.runtime.json" \
  --runner evals/run_take_listening_mlx.py
python3 evals/take_listening.py decode --batch "$STUDY/batch" \
  --responses "$STUDY/responses.jsonl" --out "$STUDY/choices.json"
python3 evals/take_listening.py score --choices "$STUDY/choices.json" \
  --labels "$STUDY/labels.json" --tier strict --out "$STUDY/score.json"
```

`strict` needs evidence for every word in the repeated phrase, `majority` needs a majority on each occurrence, and `provenance` uses corresponding word positions with no contradictory evidence. On partially mapped soundtracks these tiers can establish a local choice at a verified splice. Append `Global` to any tier (for example, `provenanceGlobal`) to require evidence that also holds across any unexplained audio in the final. Current reference maps contain source and editor file hashes and stream indices. For legacy maps, regenerate with `evals/tools/match_audio.py` and supply the result as `replayedReference` with its archive source record or verified inventory. The report gives each order’s accuracy, the number right in both, and the denominator. Uncertain passages, mixed edits and passages the editor removed entirely stay visible in the label file. Inspect which takes the reference favored alongside a simple always-later baseline. Whole-edit cut recall, retained-word loss and picture-to-first-word timing use the timeline graders above.

### Freezing aligned word times for a dialogue case

To compare placement with the same model-selected word ranges, derive a separate case from the original English source evidence. The command runs Scarlet’s wav2vec2 alignment worker on the recording and audio stream specified in the case. Original Whisper or Crisper decoder JSON preserves its segment groups when available. Without it the frozen timed word sequence supplies the groups.

```sh
python3 evals/freeze_aligned_case.py --case-dir "$EPISODE/cases/$CASE" \
  --source "$RECORDING" --model "$ENGLISH_CTC_WEIGHTS" \
  --segments "$DECODER_JSON" --out "$STUDY/aligned/$CASE"
```

The derived case lives under `cases/$CASE` in the new private output root. `alignment.json` identifies each confidence-qualified word index, the number of remaining estimated words, the original stream and the input, weights and output hashes. Word indices and spellings remain stable. Supply the same inclusive removals to native and aligned cases, then score both timelines against the same independently frozen source occurrences and editor joins. A matched published word on either side alone can hide extra words left in between.

To score live model decisions, add `--reference "$EPISODE/reference-audio.json"` when freezing. Use a map from `tools/match_audio.py` with the source file hash and audio stream. The output root then contains the verified audio map, an episode lock, the candidate evidence for the model, and a byte-for-byte copy of the original source evidence in `cases/$CASE/grading-evidence.json`. Deriving another case from this one preserves that original grading transcript. A freeze without an audio map also preserves the original transcript for subsequent offline scoring.

Set `SCARLET_EVAL_DATA` to the derived root for `evals/src/run.ts` and point it at an engine holding the candidate transcript. The runner checks the case declaration, transcript files and map before starting a trial. Its published-word recall, skipped words retained, exact audio joins and matched pause error use the original transcript. Picture entrance scoring uses those same original words when verified picture observations are supplied. `published-words.json` records both the grading file and the ordered-word digests. Compare arms only when their grading word and reference digests agree. Older original cases use their own source evidence.

### Optional suggestions from an editor’s past cuts

`editor_history.py` trains an offline experimental model from one editor’s other frozen recordings. It
produces possible source-word removals and the words that would meet at each splice. The target input
is its raw case. Historical editing preferences come from the editor’s own training corpus. The editing
model can take, change or ignore any suggestion. The generator runs only when invoked for an experiment.

Create a private JSON array with one `{"caseDir": ".../cases/<id>", "reference": ".../reference-audio.json"}`
per training recording, in a fixed order. Paths are relative to the manifest or absolute. Each
correlation must carry the recording hashes and audio streams from `tools/match_audio.py`. Reserve whole
projects for evaluation and keep alternate exports of the same performance together. The runner
rejects duplicate project IDs and overlapping source or editor digests. Run in an environment with NumPy and scikit-learn (tested with
2.5.4 and 1.9.1). It fits the model in memory and records the library versions and input digests.

```sh
python -B evals/editor_history.py --history "$PRIVATE/history.json" \
  --case-dir "$EPISODE/cases/$CASE_ID" --out "$PRIVATE/suggestions.json"
```

Use `--include-markers` to reproduce the alternate arm that includes decoder annotations in training labels.
To try a suggestion file in Scarlet, attach the JSON to a request editing the matching recording and
ask the model to use the suggestions at its discretion.

Compare the identical editing request with and without the optional suggestions. Score the applied
timelines on exact word-removing joins, lost editor-kept words and `cutWordDistance` on the same frozen
reference. Retain the source-only baseline, model seed, prompt and footage digests with each run.
