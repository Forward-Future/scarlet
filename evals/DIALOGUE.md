# Fixing a dialogue cut

Every thread that changes how Scarlet cuts dialogue follows this, whether it starts from a mistake the editor found
or from an idea. The point is that each fix is checked against every mistake reported before it, not only the one in
front of you, so the cutting gets better overall instead of trading one problem for another.

The ledger lives with the eval data, never in the repository: it holds the editor's words and times.

- `$SCARLET_EVAL_DATA/dialogue/history.md`: what each report was, its cause, what was tried and dropped, what's open.
- `$SCARLET_EVAL_DATA/dialogue/ledger.json`: one entry per reported mistake, each with a check.
- `$SCARLET_EVAL_DATA/dialogue/scoreboard.jsonl`: one row per recorded run of the checks.

`$SCARLET_EVAL_DATA` defaults to `<Scarlet application support>/evals`.

## 1. Read before you change anything

Read `history.md` and run `tsx evals/src/ledger.ts list`. Answer, before writing code:

- Has this happened before? An earlier entry at the same kind of spot may be a regression, not a new problem.
- What touched this code or behavior before, and what was tried and dropped there?
- Is your idea already on the "tried and dropped" list?

## 2. Find the cause, then add the entry

Find where the mistake came from before fixing anything: the run's events, the transcript, the levels, the replay
(see `README.md`). Name its cause, which says where the fix belongs (`docs/skills-and-tools.md`):

- `transcript`: words missing, invented or mistimed.
- `placement`: Scarlet's code put an edge, held, refused or applied a cut wrongly given what the model asked.
- `model`: the model asked for the wrong thing, or kept something it should have cut.
- `eval`: the measurement was wrong, not the edit.
- `flow`: the run did something at the wrong time.

Add an entry to `ledger.json` with the editor's words, the project, run and time, the cause and a check:

- **replay** (free, preferred for `placement`): build a case from the run once
  (`dataset.ts build --project … --from-task … --with-scan --suite regression --id ledger-<name>`) and say what the
  current code must do at the spot, in source seconds of the recording:
  - `plays`: the words the edit plays in a stretch. `accept: ["right", "asked"]` also passes a call whose approval
    plays them.
  - `edge`: where the model's first request near a time places its edge, applied or staged.
  - `notApplied`: nothing in a stretch is taken out without the editor.

  A replay sends the model's own requests from that run through today's planning code, set-aside rounds included.
  It can't show a live re-read of the recording, cuts staged by an earlier save, or a transcript change: use a
  command check for those.
- **command** (free): a unit test with a synthetic fixture that reproduces the mechanism, run by name from the
  repository root (`cd packages/mcp && ../../node_modules/.bin/vitest run src/x.test.ts -t '…'`). Exit 0 passes.
- **trials** (costs model tokens): only model passes can show it. Record what the last trials found in `last`.
- **none**: say why, and what would make it checkable.

**Count the class, not only the spot.** A report is one instance of a kind of mistake. Before fixing, find how many
others of the same kind his edits play now, and which gate let each through: not found (the transcript or a finder
missed it), found but held and routed around, or found and kept (a keep plays on and is never shown to him).
`tsx evals/src/leftovers.ts` sweeps his library with no engine and no model, and lists by family what each project's
current edit plays: `restart`, `deadAir`, `lateCut`, `lateVoice`, `edgeInWord`, `brokenSentence`, `doubledAtJoin` and
`shortNumber` (`--family` narrows it), with how many repeats each pass kept silently. Every figure is a flag read from
the transcript, to listen to, not a count of mistakes.

Every entry reported from 2026-11-21 names its `class`: the family and its count per 10 minutes when reported
(`{ "family": "restart", "before": { "count": 166, "perTenMin": 11.6, "at": "2026-11-20" } }`), or
`{ "family": "none", "noSweep": "…" }` with why no sweep counts it. The ledger refuses to load without it. Fix the gate
that lets most of the family through, not just the one the reported spot went through, and fix a finder the engine
and the evals share (`findRestarts`) in both, or say why not. `ledger.ts check` prints every family's rate in his edits
now beside the last recorded run and each entry's count when it was reported, and `--record` keeps it on the
scoreboard: a family whose rate never falls after fixes to it is being fixed one spot at a time. A kind of mistake that
keeps coming back as `none` is a sweep to write.

Run the new entry on the current code before you fix anything: it should fail. An entry that passes on the code that
made the mistake doesn't check it.

## 3. Fix it

Fix the class of problem at the level the cause names, not the one spot. Follow `docs/AI-AGENTS.md`: the model decides,
Scarlet measures and keeps edits safe, skills hold taste. Prefer removing a tuned rule to adding one.

## 4. Run the checks

```sh
PATH=/Applications/Scarlet.app/Contents/MacOS:$PATH node_modules/.bin/tsx evals/src/ledger.ts check
```

About a minute, no model tokens. It runs every entry and compares with the latest recorded run this checkout builds
on: which entries broke, which now pass, and how far each replayed pass moved overall (cuts applied, held, edges on
speech). A change ships only when:

- its own entry passes,
- no entry marked `fixed` fails (the command exits 1 if one does), and
- any whole-pass movement is explained. A fix for one spot that moves dozens of edges in other passes needs a look at
  those edges before it ships.

**Model passes cost the editor tokens.** The standard scorecard run in step 5 is the one he has asked for on every
change to what the model reads. Anything beyond it needs his yes: propose the smallest run that can answer (a clone of
the reported project cut down to the minute around the spot, 4 passes an arm against 4 on main) and say the expected
cost when you ask.

## 5. Score it against the published video

The ledger says whether old mistakes stay fixed. The scorecard says how good the cut is: each scored pass is read
against the video the editor's own editor published from the same recording, and comes down to **Watchability** (the
craft mistakes an editor's ears confirmed, scored by rate per 10 minutes of cut), **Editorial match** (alignment with the editor's decisions and
pacing), and **Overall** (the geometric mean of Watchability and Editorial match, so severe craft defects cannot hide
behind high editorial averages).

| Factor | Group | 100% means |
|---|---|---|
| No missed retakes | Watchability | no line plays twice: no run of 6+ words left in that the editor cut for another take Scarlet plays too (50% at 3/10 min) |
| No stutter cuts | Watchability | no piece under 1 s between two cuts (50% at 2/10 min) |
| Cut decisions | Editorial match | every removal the editor made, Scarlet made, and no others; a removal counts once, long or short |
| Take choice | Editorial match | where a line was said twice, Scarlet kept the take the editor kept, and only that one |
| Lines kept | Editorial match | every sentence the editor kept is still in |
| Words the editor kept | Editorial match | no run of 2+ words cut that the editor kept (50% at 3/10 min) |
| Same cuts | Editorial match | every cut of the editor's that can be told apart, Scarlet made between the same two words |
| Pauses left alone | Editorial match | every pause the editor left as it was said, Scarlet left too |
| Pauses trimmed | Editorial match | every pause the editor shortened, Scarlet shortened too |
| Dead air | Editorial match | as much dead air left as the editor left |
| Cut count | Editorial match | as many cuts as the editor made |
| Space at a cut | Editorial match | at cuts both made, the pause is within 0.1 s of the editor's |
| No restarts left in | Editorial match | no more restarts or doubled words play than in the editor's cut |
| Known mistakes | Editorial match | every spot that went wrong before comes out right, or is asked about |

**Watchability scores only what the editor's ears confirmed.** In a listening check of 40 flagged spots (2026-11-20,
`calibration/2026-11-20/results.md` in the eval data), 2 of 12 joins flagged as landing inside a word and 2 of 12 runs cut
that the editor kept were real mistakes, while retakes left in were. So Watchability is retakes left in and stutter
cuts; joins inside a sounding word, a word doubled at a join (“with ‖ without”) and half a sentence left at a join are
counted under the card as *checked by ear next*, and runs cut that the editor kept are Editorial match. A count joins
Watchability once a listening sheet (`calibrate.ts`) shows most of its flags are real.

Under the card is the count it is easiest to feel: **craft mistakes per 10 finished min** (retakes left in and stutter
cuts under 1 s), then the counts checked by ear next, then the editor's choices. Taste is
counted apart: **content left in** (passages of 6+ words the editor cut that are said only once, such as a sponsor read
or a tangent) and **short tightenings left in** (2–5 word phrases the editor trimmed, `"kind of"`, `"And so"`). A long
Where Scarlet and the editor played the same words from different sayings of them (“it is a very good model. It is a
very good model”), or Scarlet took out a repeat the editor left in, the viewer hears the line either way: that run counts
as **same words, another take**, in none of the counts above. A retake left in that Scarlet staged or flagged for the
editor reached them: it counts as **left for your call**, not as a miss. (Of 72 long left-in runs holding a restart over
the 40 long-form passes, 50 overlapped a cut Scarlet staged or flagged, 2026-11-20.)
Words the published video plays where its matcher found no recording are left unscored: the reference would otherwise
say the editor cut them. All automated counts are flags rather than confirmed defects until someone listens:
`calibrate.ts` (see `README.md`) builds the listening sheet that says how many of each are real.

Every scored pass records two separate playable cuts under rubric `dialogue-playable-v5`:
- `recommended` (default): what plays after accepting Scarlet's recommended staged cuts.
- `automatic`: what plays from applied cuts alone, without accepting any staged proposals.

Each operating point is scored strictly on its own playable timeline, playback duration, and join edges, and comparisons
require matching rubric, operating point, recordings, and frozen grading inputs (`gradingSha256`).

```sh
# One run, or one pass: its card, and for a single pass what each figure is made of.
node_modules/.bin/tsx evals/src/scorecard.ts <run folder | evaluation.json> [--point automatic|recommended]
# Main against a change: each factor side by side with its ±, which changes are more than luck, and on how many recordings.
node_modules/.bin/tsx evals/src/scorecard.ts <main's run> <the change's run> --point recommended --labels main,change --ledger
# A side made of one run per recording: join them with commas.
node_modules/.bin/tsx evals/src/scorecard.ts <run a>,<run b> <run c>,<run d> --labels main,change
# Bring saved runs up to the current rules (no engine, no model tokens). It refuses a trial its case no longer reproduces.
node_modules/.bin/tsx evals/src/regrade.ts <saved run> <new output dir> [--data <eval data root>]
# Re-score an existing run offline against its original local SQLite library (no model tokens):
node_modules/.bin/tsx evals/src/rescore.ts <original run> <original scarlet.db> <new output dir>
```

A scorecard costs nothing: it reads eligible completed trials from `trials.json` and `evaluation.json`, and every run
writes its own `scorecard.md`. Only the passes cost tokens. Under the card, timing prints both **time to finish**
(wall clock from request to completion) and **active** minutes (using cumulative `workedMs` when recorded, or earliest
event to completion minus editor wait), along with tokens and estimated API cost.

**Every change to what the model reads ships with its scorecard beside main's** (the editor's rule, 2026-11-18): a
skill, the prompt, a tool's description or what a tool returns. The standard run is two passes on each recording that
has a published video, with the change, against the latest recorded run of main on the same recordings
(`history.md` names it and the library to run in). Run main again only when it has moved since. Report the card, what
moved outside the spread and what the run cost. A larger run needs the editor's yes first. A change that alters only
placement or the transcript is judged by the ledger and replays, and by a scorecard when a replay can't show it.

Reading it:

- **Passes disagree, and the ± says by how much.** Two passes of the same code land a few points apart, so every figure
  carries a ±, from how much this run's passes of the same recording disagree: the same code run again lands within it
  about 95 times in 100. On the five long-form recordings at two passes a side, the overall's ± for a difference is about
  2 points, and a factor's is 3–8. A difference marked "could be luck" is no result, and the recordings it went up or
  down on say whether one video carried it. A change ships on the scorecard when the overall rises by more than its ±
  and no factor falls by more than its own. A recording with one pass gives no ±: run at least two.
- **The rules don't change under a comparison.** Both sides must be scored under the same rubric. When the rules
  change, bump `RUBRIC` in `score.ts`, extend `regrade.ts` to rebuild what changed, and regrade the saved runs the
  comparison needs, rather than running passes again.
- **Recordings count once each.** A side's figure is the mean over recordings of the mean over that recording's passes.
  With fewer than three recordings the card describes those videos more than the cutting: add a case for every
  recording the editor supplies with its published video (`dataset.ts build … --published-media`, see `README.md`).
- **Everything is on the scale of the editor's cut, never the raw recording's.** Most of what comes out of a recording
  is long retakes and production talk that any pass removes, so a figure counted over all of it reads high whatever
  happened to the hard calls: two passes that left three times the editor's dead air scored 98% for it against the
  recording, and 94% for words cut while missing a quarter of the editor's removals (2026-11-18). A removal counts
  once, and an amount is scored as the smaller over the larger, so too tight scores as low as too loose.
- **A disagreement of one word isn't counted as a mistake.** The published video's words are matched to the recording's
  through two transcripts, which differ by a word at the edge of a piece often enough to drown the real ones. So a
  single wrong word, like a cut that takes the first word of the kept take, is the ledger's to catch, not the card's.
- **The editor's cut is one editor's taste.** Where the editor's own words say otherwise (pauses under a second are how
  he talks), his words win and the factor is read with that in mind, not tuned toward.
- **Past mistakes** is the ledger's pass rate on this checkout (`--ledger`), beside the card, not in the overall.
- Calls for the editor, minutes and tokens are printed under the card and not scored: fewer calls is not better when
  the call was the editor's to make.

## 6. Record

- After the change merges, run `ledger.ts check --record --label "<PR>"` on main, so the next thread compares against it.
- Mark the entry `fixed` with the PR, and update `history.md`: the cause, what worked, what didn't and what's left open,
  with the class count before and after.
- `ledger.ts board` shows the runs over time: the count of passing entries should only go up.
