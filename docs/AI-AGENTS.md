# How Scarlet works with AI agents

Read this before changing anything an editing agent sees or uses: the prompt, skills, MCP tools, perception (transcripts, waveforms, frames), agent hosts or editor preferences. It records the boundaries Scarlet keeps and the reasons behind them. See the [product principles](PLAN.md#principles) and [skill and tool ownership guide](skills-and-tools.md).

## What the rules are for

Every rule below serves one of these goals:

- **Speed.** Scarlet is measured by the time from an editor's request to a moment they can judge. The agent's run is part of that time, so its tools must be fast and its context complete enough that it doesn't spend turns searching.
- **The editor decides only what needs taste.** Mechanical work (finding words, placing edges, sync, padding, rendering) is done by the agent and Scarlet. Only creative choices reach the editor.
- **Models keep getting better.** A better model or harness should make Scarlet better with no change to Scarlet. Nothing here should cap what a stronger model can do.
- **The model can only edit what it can see.** Give it the editor's full intent and measurements of the footage, then let it choose.

## Three layers

| Layer | Owns | Examples |
|---|---|---|
| **Model** | Editorial judgment | Which words go, which take survives, how long a pause should be, what a reason says to the editor |
| **Harness** (Claude Code, Codex CLI; a Gemini CLI runner remains for existing setups) | The agent loop | Tool calling, context and compaction, sessions and resume, permissions, sandboxing |
| **Scarlet** | Context, safe editing, the editor's interface | Measuring the footage, resolving exact cut points, versioning every edit, enforcing safety rules and the editor's preferences, review and playback |

Scarlet is an interface for editors and a way for AI to read the timeline and media. It is not an agent framework and not an editor with taste of its own. When code in Scarlet starts deciding what belongs in the video, or starts running the agent's loop, it is in the wrong layer.

The layers improve independently. Models and harnesses change every few months, so keep Scarlet's side to stable contracts: a prompt, tools, evidence and enforcement. Don't tie behavior to one model's quirks.

## Rules

### What the agent is told
1. **One source of truth.** The engine builds every task's system prompt and instruction (`GET /api/tasks/:id/prompt`, `taskPrompt` in `apps/server/src/services/tasks.ts`, using `buildSystemPrompt` from `packages/mcp/src/prompt.ts`). Hosts fetch it and never build prompts. A second copy, such as the Rust port that used to live in the desktop host, drifts.
2. **Give the model everything the task needs.** The prompt carries the editor's request as they said it, where they were looking (version, playhead, selection, the edit or cut being revised), their notes, the thread's earlier requests, replies and answers, and their preferences. Don't summarize or rewrite the editor's words before the model sees them.
   - When the interface knows something about the request, such as a selected edit or "review every cut", put it in the task context. The model shouldn't have to guess what the editor was looking at.
   - A request about one edit or one staged cut comes with what Scarlet told the editor about it: the edit's name, its number in their list, what it did and what to check on it; the cut's reason and its assessment. Those words are on the row and the card in front of the editor, so they are answering them. The engine looks them up from the change (`selectedEdit` in `prompt.ts`, `cutRevisionReference` in `changes.ts`); the interface sends only which edit or cut.
   - Put what every task needs in the prompt. Make the rest discoverable through tools, so the model can look closer without the prompt growing with the project.
   - When a model's mistake traces back to something it couldn't see, add that context or measurement. Don't add an instruction to compensate.
3. **Say each thing once, in the right place.**
   - Tool mechanics go in tool descriptions and schemas: units, paging, field meanings, what a result contains.
   - Editorial taste goes in skills: who is being addressed, how to group retakes, when a pause earns its time.
   - Scarlet's contract goes in `SCARLET_INTRO`: versions and changes, the time model, safety, and how to talk to the editor.
   - The editable dialogue skill describes which cuts to make or bring back for review, their pacing and the audio blend at their joins. Editor choices about a specific cut travel with the request or its review.
   - What the editor asked for this time, and where, goes in the task context (the `## Context` lines `buildSystemPrompt` writes). A context line says which cut, edit or passage; it doesn't explain the tool that acts on it.

   If you find the same rule in two of these, delete one. The [short test](skills-and-tools.md#the-short-test) decides where a sentence goes.
4. **Write for the next model.** Add instructions only for observed failures, and prefer a better tool or measurement to another sentence. Don't script the order of steps or build a fixed pipeline the model must follow; describe what's available and let it choose. An instruction the engine writes itself (a repeat check, a redo, a resumed run) says the goal and what counts as done, not which tools to call in which order. After each model upgrade, run the evals, check which rules the model no longer needs, and remove them.
   - One pacing rule is enforced, for speed: on a dialogue first cut, `dialogue_scan` stops handing out new pages after two until the model saves the cuts it has decided or says none are ready (`noCutsReadyThrough`), and one save holds at most `FIRST_CUT_BATCH_SIZE` decisions (`packages/mcp/src/dialogue-scan-batch.ts`). Left alone, a pass read a whole recording before its first save, and the editor waited for all of it before judging anything. The rule sets when to save, not what to cut, and each refusal says what to do next. A pass is also finished only once `dialogue_check_repeats` has nothing outstanding on the current version; a pass that stops before that is sent back with that goal (`queueRepeatCheck` in `apps/server/src/services/tasks.ts`).

### Tools and perception
5. **Scarlet measures; the model decides.** Tools return evidence: words, levels in dBFS, voice activity, frames, retake groups, room tone, loudness. The model makes the editorial call.
6. **Enforce safety and the editor's review decisions, and report each adjustment.** Scarlet may move an edge onto measured silence, stage an uncertain cut for review or keep a revised cut open for the editor who sent it back (`heldRevised` from `dialogue_review_save`). The model gets the reason and evidence for each adjustment. A dialogue plan can request an audio-only crossfade in project frames. Scarlet saves the overlap on the change, uses it for preview and approval and reports any join whose source handles cannot accommodate it (`joinCrossfades`). Never silently change, invent or drop the model's work. `timeline_propose` refuses a ripple whose edge falls inside a word that is sounding there and points to `dialogue_apply_cuts`: on one pass three removals of dialogue skipped every edge check that way. The same holds for every audible clip edge an edit makes, whichever op makes it (`newClipEdges` in `packages/mcp/src/server.ts`), and for a sound the transcript has no word for: an edge that would leave a piece of a sound playing, with the sound running on into what was removed, is read from the levels alone (`clipEdgeSound` in `dialogue-join.ts`) and refused with the quiet second beside it. A pass that built its video from added clips began one 40 ms before an “uh” ended, and the revision the editor asked for trimmed that join one frame into the next word and reported the word whole (2026-11-12). `timeline_first_cut` moves such an edge onto that quiet itself and reports it (`movedEdges`), and refuses a keep range that ends inside a sounding word. On that pass's 350 edges the check names 11. Never silently change, invent or drop the model's work: `dialogue_apply_cuts` also says when confident cuts wait for the editor instead of applying (`stagedForEditor`, with why), how far putting cuts on whole frames moved them (`onFrames`), and which of an earlier part's staged cuts left the review because a later edit broke up their footage (`droppedFromReview`); `timeline_propose` lists each removal it put on whole frames (`onWholeFrames`), inside a selected passage too.
7. **No hidden modes.** A tool can depend on its arguments, the footage, harness capabilities, editor settings and the task’s recorded operation and scope. Pinning or reading a guide selects advice. A built-in dialogue shortcut additionally records the editing operation the editor requested.
8. **Capabilities, not self-assessment.** `packages/shared/src/capabilities.ts` records what each harness actually delivers to its model (images, audio, file writes, and the prefix a harness gives Scarlet’s tool names). Tools and prompt text adapt to it. Never ask the model "only if you can hear WAV". Claim a capability only after confirming the harness forwards that content type from MCP results in headless mode.
9. **Every model gets a way to check its own work in text and numbers.** `timeline_transcript` reads the edit in playback order, and `timeline_join_audit` measures each join as heard. `dialogue_check_repeats` also reads each played join letter by letter from the speech model's frames (`hearJoin` in `apps/server/src/services/dialogueRepeatAudit.ts`): a kept word heard short at the edge, or letters the transcript has no word for, is a join the editor would send back. Audio and images are extras for models that can use them. Receipts that gate a decision must record a measurement that happened, not that a file was attached.
10. **Refer to content, not guessed times.** The model can name words by transcript index (`fromWord`/`toWord`) and let Scarlet resolve the exact edge from measured silence (`packages/mcp/src/dialogue-join.ts`). A pause is named by the word it follows (`afterWord`), and the model can set its remaining duration (`leave`): pause ranges typed in seconds left a median 0.54 s where the published cut of the same footage left 0.25 s. Where two words run together with no pause, a word reference's edge goes at the lowest level between them when that is down at room tone (`DIP_DBFS`) and the removal's other edge has a pause, and the gate says what was measured: without it every cut of a doubled word was held for the editor (20 of 25 held cuts on one pass). An edge given in seconds that lands on speech goes the same way to a room-tone dip at the nearest word boundary, within a fragment's reach. Where a restart lets the same words play from either saying, `dialogue_check_join` can show comparable word ranges and the evidence for their joins. The model selects the occurrence, and the planner preserves that selection. Mapping between source and timeline time is a tool's job (`timeline_at`), never arithmetic in a prompt.
11. **Fix perception at the source.** Better measurement beats compensating instructions:
    - Local transcription uses Whisper large-v3-turbo, 5-bit (`bundledWhisperModel` in `apps/server/src/transcribe/localModel.ts`): base misspelled names and smoothed stutters and restarts into the sentence meant, hiding what a dialogue pass cuts.
    - Word times come from Whisper refined by wav2vec2 CTC forced alignment (`apps/server/src/transcribe/wordAlign.ts`, `ctcAlign.ts`). This cut the median word-start error from about 90 ms to about 40 ms on a real recording.
    - Waveforms decode at 16 kHz so sibilants and breaths register (`packages/render/src/waveform.ts`). Bump `WAVEFORM_CACHE_VERSION` when the decode changes.
    - The aligner's output for a recording is inferred once and kept beside its waveform (`apps/server/src/transcribe/emissions.ts`). The transcript's alignment and every scan page's read the same frames, so a page whose audio the transcript has covered aligns in milliseconds. Bump `alignmentVersion` when the model or the search changes.
    - A gap in the transcript is not a pause until the recording says so. `transcript_get` follows each gap of 0.4 s or more with what sounds in it (`packages/mcp/src/gap-sound.ts`): quiet, or sound at speaking level that no word explains. A pass that read only words trimmed "You can <1.7 s> see" as a pause; it held a first "see" and a second "you can" the transcript had missed. `dialogue_apply_cuts` says when a pause cut takes such sound out with it, and lists the sound a saved part still plays between two kept words (`unexplainedSound`). No harness delivers audio to the model today (`capabilities.ts`), so what an editor would hear has to reach it as a measurement or a picture: `sound_picture` draws a passage's waveform over its spectrogram with the words at their times, and the passage again with a removal out (`packages/render/src/soundPicture.ts`). A model that can hear gets the passage's audio with it.
    - Whisper can skip a remark after a long wait and resume at the next sentence. Once a local transcript's words are placed, each stretch of a second or more without words that holds sound at speaking level is read again on its own, all of them laid end to end in one run, and the words heard are placed and saved with the rest (`apps/server/src/transcribe/transcriptHoles.ts`). On a 45-minute recording that read 10 s of audio in under a second and found five such stretches, one a second “which includes computer control” the transcript had smoothed into the first.
    - A pause is measured by level and voice activity, so typing, a breath or a cough splits one long wait into slivers. `dialogue_scan` also lists every stretch without words (`silences`), with the voice-like sound in it and how much of each picture changes through it and when. `dialogue_apply_cuts` reports the ones a saved part still plays and didn't decide (`keptSilences`), the shorter pauses it still plays with its cuts out (`keptPauses`) and the words it plays twice in a row (`repeatedWords`, `packages/mcp/src/dialogue-leftovers.ts`): a pass reads the recording, not the edit it leaves, so until then nothing showed it a wait it trimmed too little, a restart it missed or a word one of its own joins doubled.
    - A screen recording says much of what it means in its picture: a menu, a setting, a line of code, a slide. `screen_text` reads the words on screen with PaddleOCR's text finder and English reader through ONNX Runtime in the audio helper (`apps/server/src/transcribe/screenTextModel.ts`, models pinned with checksums), a frame a second, reading a frame again only when the picture changes and a line again only when its pixels do. Each line comes back as a span of source seconds with its box in the frame (`apps/server/src/services/screenText.ts`). A video is read a minute at a time and kept beside its waveform; once the model asks about a video, the rest of it is read in the background, which a pause of the project's media work holds. On a 4K screen recording read at 1920 wide (M-series CPU, 2026-11-13), a chart that never stopped moving read at about 19 s per minute of video; decoding on the CPU there was five times as fast as VideoToolbox, so only CUDA decodes it on the GPU. Bump `SCREEN_TEXT_VERSION` when the reading changes.
    - Levels and words are read from a recording's mix, where a producer on a call, a system chime and the presenter all sound alike. On a recording with a mix and two isolated inputs, each `dialogue_scan` page also lists the sound on the input the dialogue is not on (`otherVoiceTurns`): when, the words heard only there and whether the dialogue input sounded too. Which input the dialogue is on is measured from the transcript and a few pages spread through the recording (`recordingInputs` in `apps/server/src/services/otherInput.ts`), and nothing is said when the two inputs share the words, as two people on two microphones do. A pass kept a producer's “got you”, a remark spoken over a line the presenter then said again, and a chime before a sentence (2026-11-13); the reading names all three, for one short decode per page. Voice inputs an editor confirmed (`voiceRoles`) are read as before, with the other input transcribed by itself.
    - A transcript is saved when Whisper ends and aligned afterwards, turn by turn, because on a long recording alignment takes several times as long and a pass can read meanwhile. `aligning.through` on the transcript says how far its word times are final. Reading and searching words doesn't wait. Anything that turns a word time into a cut edge or a measurement does: it asks `transcriptWords` in `packages/mcp/src/server.ts` for final times up to the second it needs.
12. **Tools are fast.** The editor waits through every tool call. Precompute and cache measurements at ingest, so a tool reads instead of computing. Let one call answer a whole question (every join in a change, a page of transcript) rather than one item per call. A tool that can't finish yet starts the work and says when to ask again.
13. **Tool hygiene.**
    - Annotate every tool (`packages/mcp/src/annotations.ts`; add new read-only tools to `READ_TOOLS`).
    - Return compact JSON or text, never both. Support ranges and paging for anything that grows with the recording.
    - Use seconds for time and dBFS for levels everywhere, with timecode only where the editor reads it.
    - Errors say what failed and what to do next.
    - Merge tools that overlap instead of adding near-duplicates. Keep tool names stable, and update `packages/shared/src/editingTools.ts`, skills and the UI labels (`apps/web/src/lib/taskRun.ts`, `taskActivity.ts`) together.

### The editor's attention
14. **Only creative decisions reach the editor.** If the editor would have to do something by hand, such as nudge an edge, re-sync a track or find a passage, that's a missing tool or measurement, not a review item.
    - The agent asks (`task_question`) or stages a suggestion only when the editor's preference would change the result.
    - Replies say only what needs the editor and refer to edits by number. The closing reply is at most two short sentences, with or without an edit: the chat shows it on two lines and folds the rest until a click, and the prompt says so. A short `check` reason flags an edit only when a doubt is left that the editor must settle by listening or looking: the flag counts in what needs them ("N need you") until they keep the edit, so a fact about what the edit did is not one.
    - An update while the agent works is one sentence of at most 100 characters on what it is doing now. The chat shows the latest one on the line that says what Scarlet is doing, on two lines, until the agent's next call takes its place (`runNow` in `apps/web/src/lib/runNow.ts`).
    - Each edit carries a one-sentence `summary` of what it did, side effects included. The edit's card shows that sentence and nothing else, so the editor reads one thing before deciding.
    - Each edit can be reviewed, revised or undone on its own, so the agent can act first and the editor corrects the exceptions.
    - Before its first tool call the agent says in one sentence what the whole request will come to. The chat keeps that sentence above the run's stages or steps for as long as it works (`runAim` in `apps/web/src/lib/taskRun.ts`). It is the agent's own words, read from the run's events: a run that went straight to its tools has none, and Scarlet writes none for it.

### Harness
15. **Let the harness run the agent.** Scarlet launches each CLI headlessly with only Scarlet's MCP server and a minimal toolset:
    - Claude resumes its own session after the editor answers a question (`--resume`), and after a run is cut short: by Scarlet quitting, by a lost worker, or by the host's stall or time limit. Every attempt at one run shares the first attempt's task folder so the session is found again. If the host no longer has it, the run starts fresh with the engine's recap.
    - Codex runs stay `--ephemeral`, because its session store is shared with the user's Codex app. An answer or an interruption starts a fresh run with the earlier questions and answers, or the recap, in the prompt.
    - Don't rebuild compaction, memory or planning inside Scarlet.
    - The agent's plan is the harness's own to-do list (Claude Code's `TaskCreate`/`TaskUpdate`, Codex's `update_plan`), read from the CLI's stream and recorded as `plan` task events: each step in the agent's words, pending, in progress or done. It is evidence, never an instruction: Scarlet sets none of its steps. The chat doesn't show it: since 2026-11-10 a working request shows one line of what Scarlet is doing this moment, which the editor chose over stages and plans. So no harness is launched with its to-do tool (`plan` is off for every agent in `capabilities.ts`), and no run pays the median of about 15 seconds the plan cost a request on 2026-11-08. `SCARLET_AGENT_CAPS='{"plan":true}'` where the engine runs turns it on: the engine then launches a run with the tool, and with one paragraph of the prompt (`PLAN_STEPS`) asking for the steps, except a dialogue pass, a request about one staged cut and a skill edit (`taskPrompt` in `apps/server/src/services/tasks.ts`). Given the tool and no word about it, the agent made no plan in six real requests; asked, it listed three to five steps within twelve seconds in each of eleven. Codex's headless stream says only which steps are finished, not which is under way.
16. **Keep the user's environment clean and runs observable.**
    - Delete task control files that hold the access token once a task ends, and prune old task folders.
    - Remove a finished run's Claude session directory, and with it the to-do list Claude Code keeps for each of its sessions (`~/.claude/tasks/<session id>`). A run that was cut short keeps it for the attempt that resumes it; the task folder's prune removes it if nothing does.
    - Stop agent CLIs an earlier launch left running (a crash signals nobody), except those of another Scarlet that is still open, and at exit hard-stop the process group of each CLI stopped in the last few seconds (Windows has nothing left to finish: its stop ends the whole tree). The launch sweep recognises a process by its id, program and start time, because a freed id sooner or later belongs to another program.
    - Report each run's tokens, including runs that pause for a question (`POST /tasks/:id/usage`). Scarlet tracks tokens, not cost, because runs use the editor's subscription.
    - Never put API keys in a run that should bill the user's subscription.
17. **Skills load progressively.** The workflows Scarlet comes with appear as one line in the prompt and are read through `skills_list` when needed. An editor's own house rules and explicitly selected skills are included in full.
    - The skills in `skills/` are added to a new library once and are the editor's from then on. There is no separate Scarlet version of a skill.
    - A changed `SKILL.md` reaches installed copies the editor hasn't edited. An edited copy is theirs and is never changed or merged.
    - The editor can change a skill by saying what they want (the chat beside its instructions in Settings). That is a `skill_edit` task: its prompt is the skill as it stands, the editor's words and `SCARLET_INTRO` for reference, with no project in it, and its only tools are `task_log`, `task_question`, `skills_list` and `skill_save_edit`. The tool saves to the one skill the editor asked about. The model supplies the description and instructions; Scarlet keeps the name, the rest of the header and the earlier version. Agent runs belong to a project, so the task borrows the one worked on last, and stays out of its conversation and its queue.
    - A skill can also learn from what the editor asks. Every request is read for a standing rule as it is sent, by a `learning_check` task: a short run with the request's agent and model that starts beside the request, outside the project's queue and its conversation, so a rule reaches the editor in seconds and whether or not the request finishes. Its prompt is the editor's words, what they were aimed at, what they asked earlier in the project, their skills by name and description, and the rules Scarlet already has; it sees no footage. Its only tools are `skills_list` and `learning_suggest`: one sentence, the skill it belongs in, and what that skill already says that the rule contradicts or overrides, quoted word for word. It reads that skill in full before offering, so a rule the skill already has isn't offered and the editor sees what a rule would change before deciding. Scarlet checks each quote is in the skill and sends back one that isn't. The run that edits has no such tool, so the same rule never arrives twice in two wordings. A message that only names a skill, a request Scarlet made itself and a resumed run aren't read. Scarlet keeps a rule with the editor's words (a learning) and changes nothing. The editor reviews learnings in the simple view's menu; approving one starts a `skill_edit` task whose instruction is the rule, what they said and what they were shown it replaces. The save applies the approved rule within the chosen skill and preserves content outside the approved replacements. If it finds the skill saying otherwise somewhere the editor wasn't shown, it saves nothing and quotes the passage, which comes back to them under the rule as why it wasn't saved; approving again tells the next save they have read it. It runs on the model chosen when they approve, not the request's, which they may have left. A skill's edits run one at a time, so a second approval for the same skill starts when the first has saved. Never save a rule the editor hasn't approved.

### Evidence
18. **Measure every change that could affect the cut.** Use `evals/` (see `evals/README.md`):
    - Score finished tasks: edges on speech, clipped words, removed time by kind, agreement with the editor's decisions.
    - Replay stored plans through new code.
    - Run several trials per model and harness. Rerun them when a new model ships, both to compare it and to find instructions it no longer needs.

    Grade outcomes with code; use LLM judges only for trend dashboards.
19. **Never commit user media, transcripts or derived numbers.** Eval data lives outside the repo (`$SCARLET_EVAL_DATA`). Repo fixtures are synthetic.

## Checklists

**Adding or changing an MCP tool**
- Does it measure or apply? Policy belongs in a skill or an editor setting instead.
- Is it fast enough to call in a loop? Cache what it computes, and answer a range in one call.
- Add its annotation, compact output, units and an actionable error.
- Gate it on capabilities if it returns audio or images or needs file access.
- Update the tool inventory, UI labels, skills that mention it and tests.
- Confirm no other tool, skill or prompt line already explains the same thing.

**Changing the prompt or a skill**
- Is there an observed failure behind it? Could missing context or a better measurement fix it instead (rules 2 and 11)?
- Put the text in the right layer (rule 3, and the [short test](skills-and-tools.md#the-short-test)) and delete the duplicate.
- In a skill, name a tool; don't explain it. Don't put scope, permissions or anything Scarlet enforces in a skill.
- For `SKILL.md`, keep frontmatter `name` and a `description` that says when to use the skill.
- Run the evals on a real case before and after.

**Adding something the editor reviews**
- Does it need taste? If a measurement could settle it, let the agent or Scarlet settle it and report the evidence.
- Can the editor judge it from the changed moment alone, with its before and after?

**Adding a perception signal**
- Compute it in the engine or the MCP package, and cache it with a version in the cache key.
- Expose it as evidence, not as a decision.
- Check licenses: Scarlet is MIT and used commercially, so non-commercial model weights are out.
- Download models from a pinned URL with a sha256 check (see `localModel.ts`).

**Supporting a new harness**
- Add a runner in both hosts (`apps/agent/src/runners`, `apps/desktop/src-tauri/src/host`) that fetches the engine's prompt.
- Restrict built-in tools to Scarlet's MCP server.
- Add its capabilities only after testing them headless.
- Make sure its sessions don't leak into the user's own history.

## Where things live

| Concern | Location |
|---|---|
| Prompt contract | `packages/mcp/src/prompt.ts` (`SCARLET_INTRO`, `buildSystemPrompt`) |
| Prompt route used by both hosts | `apps/server/src/services/tasks.ts` (`taskPrompt`), `routes/tasks.ts` |
| Instructions the engine writes itself | The repeat check that finishes a dialogue pass (`taskPrompt`), a redo after a conflict and a request about one staged cut (`cutRevisionReference`) in `apps/server/src/services/changes.ts`, a resumed run's recap (`recoveryInstruction` in `taskRecovery.ts`) |
| Hosts and runners | `apps/agent/src` (TypeScript), `apps/desktop/src-tauri/src/host` (Rust, used by the desktop app) |
| Capabilities | `packages/shared/src/capabilities.ts` |
| The agent's own plan | `PlanStep`, `TaskPlan`, `taskPlan` in `packages/shared/src/api.ts`; asked for by `PLAN_STEPS` in `packages/mcp/src/prompt.ts` on the runs `taskPrompt` launches with the tool; read in each runner (`todo_list`, `TaskCreate`/`TaskUpdate`); recorded by `appendTaskEvent`; not shown in the chat |
| Tool registry | `packages/mcp/src/server.ts`; annotations in `annotations.ts` |
| Edited-timeline perception | `packages/mcp/src/timeline-perception.ts`, `perception-tools.ts` |
| Media profile (room tone, loudness, pauses, retakes) | `packages/mcp/src/media-profile.ts`, `apps/server/src/routes/perception.ts` |
| Text on screen | `apps/server/src/services/screenText.ts`, `transcribe/screenTextModel.ts`, `screenFrames` in `packages/render/src/inspection.ts`, `/screen-text` in `apps/server/src/routes/perception.ts`, `screen_text` in `packages/mcp/src/perception-tools.ts` |
| Silences and what the picture does through them | `packages/mcp/src/silences.ts`, `pictureActivity` in `packages/render/src/inspection.ts`, `/picture-activity` in `apps/server/src/routes/inspection.ts` |
| Cut edges, padding, word references, edges in sound | `packages/mcp/src/dialogue-join.ts` |
| Speech the transcript left out | `apps/server/src/transcribe/transcriptHoles.ts` |
| Sound on the input the dialogue isn't on | `apps/server/src/services/otherInput.ts`, `otherVoiceTurns.ts`, `transcriptSources.ts` |
| Review gates | `packages/mcp/src/dialogue-decisions.ts` |
| Dialogue editing choices and audio joins | `skills/dialogue-pass/SKILL.md`, `apps/server/src/services/changes.ts`, `packages/timeline/src/joinCrossfade.ts` |
| Word alignment | `apps/server/src/transcribe/wordAlign.ts`, `ctcAlign.ts`, `emissions.ts` |
| Local audio models: turns, helper process, shared decode | `apps/server/src/services/audioWork.ts`, `transcribe/audioWorker.ts`, `services/recordingAudio.ts` |
| Skills: delivery, seeding, merge | `skills/*/SKILL.md`, `apps/server/src/services/skills.ts` |
| Changing a skill with a prompt | `apps/server/src/routes/skills.ts` (`/skills/:skillId/edit`), `buildSkillEditPrompt` in `packages/mcp/src/prompt.ts`, `apps/web/src/pages/SkillEditorPage.tsx` |
| Learnings: each request read for a rule, rules approved into a skill | `startLearningCheck` and `learningCheckContext` in `apps/server/src/services/learnings.ts`, `buildLearningCheckPrompt` in `packages/mcp/src/prompt.ts`, `learning_suggest` in `packages/mcp/src/server.ts`, `/projects/:id/learnings` in `routes/skills.ts`, `apps/web/src/components/review/LearningsPanel.tsx` |
| Evals | `evals/` |

## Not built yet

- Laughter/music/breath classification, a learned shot-boundary detector, and semantic search over footage.
- Driving harnesses through their two-way protocols (Claude Agent SDK, `codex app-server`, ACP) instead of one-shot commands. This would allow interrupting and steering a run.
- An Antigravity CLI runner. Gemini CLI stopped serving consumer accounts in June 2026.
- MCP progress notifications for long preparation instead of "call again" results.
- Re-aligning transcripts made before forced alignment existed.
