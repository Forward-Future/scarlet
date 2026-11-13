# Scarlet — Plan

*Started 2026-10-30, principles revised 2026-11-05. Open source, designed with working video editors.*

## Principles

These come from building Scarlet and editing with it. They settle most design questions. The rest of this document is the original v1 plan and dated decisions; where it disagrees with these principles, the principles win.

### 1. Speed is the product

Measure speed from the moment an editor asks for a change to the moment they can judge it in context. Everything in between is overhead: the agent's run, media preparation, rendering, finding the spot. If the editor asks to hold a reaction shot one beat longer, play that moment back as soon as it's ready. A full re-render or a hunt through the timeline breaks their train of thought.

- Render only the affected seconds and assemble the rest from cached segments.
- Prepare transcripts, waveforms and proxies before anyone asks for them.
- Make the agent fast too. Precomputed measurements and compact, paged tool results mean fewer turns, fewer tokens and a shorter wait.
- Treat a slow path as a bug and measure it. [Editor performance](editor-performance.md)

### 2. The editor spends attention only on creative decisions

The editor sets the brief, supplies preferences and has the final say on taste. Everything mechanical belongs to the agent or to Scarlet: finding the words, placing an edge in silence, keeping tracks in sync, padding joins, rendering, versioning and exporting. The editor should never do work a tool could do.

- Bring a decision back only when the editor's preference would change the result.
- Replies say only what needs the editor. Edits are numbered so a reply can point at one.
- Review shows the changed moment with its before and after, so judging an edit takes seconds.
- Every edit is versioned and can be undone on its own, so letting the agent act first is cheap.

### 3. Build for better models

Models keep getting better at understanding footage and carrying out an edit, usually faster than Scarlet ships. Build so each new model makes Scarlet better without changes to Scarlet.

- Give the agent the context and tools to take a brief all the way to a playable cut. As models improve, the same brief should need less supervision.
- Don't cap the model. Avoid fixed pipelines, Scarlet-side heuristics that make editorial calls and prompt rules that permanently work around today's weaknesses.
- Add an instruction only for an observed failure. After each model upgrade, run the evals and remove the rules the model no longer needs.

### 4. Keep the model, the harness and Scarlet separate

The model makes editorial decisions. The harness (Claude Code, Codex) runs the agent loop: tool calling, context and compaction, sessions, permissions. Scarlet gives the model context, applies edits safely and gives the editor control. Each layer improves on its own schedule, and the editor can switch models or harnesses without changing their project.

Scarlet doesn't decide what belongs in the video and doesn't rebuild the agent loop. When Scarlet code starts doing either, it is in the wrong layer. [How Scarlet works with AI agents](AI-AGENTS.md)

### 5. Give the model everything it needs to edit well

A model edits only as well as what it can see and measure. Every task carries the brief, where the editor is looking (playhead, selection, version), their notes, the thread's earlier requests and replies, their preferences, and what the harness can deliver. The footage is available through tools that measure it: word-timed transcripts, levels, pauses, retakes, frames, audio, and checks of how an edit plays once assembled.

- Put what every task needs in the prompt. Make everything else discoverable, so the model can look closer when the footage calls for it.
- Pass the editor's words as they said them. Don't summarize or rewrite a request before the model sees it.
- When the model gets something wrong, first ask what it couldn't see. Fix the measurement or add the missing context before adding an instruction.

### 6. Scarlet measures and enforces; the model decides

Tools return evidence, not verdicts. Scarlet enforces what has to hold: the editor's scope and settings, timeline validity, sync and safe cut points. Whenever it overrides the model, it says so with the evidence. Nothing changes the model's work silently.

### Who makes editing decisions

Scarlet is the editor’s interface to their agent and the agent’s interface to the project. The agent chooses what to inspect, which tools to use and in what order, what to change, and what needs the editor’s judgment. The same footage can support different cuts for different briefs.

When adding a capability, expose the project context and allowed operations through discoverable tools. Describe what each tool reads or changes, how to locate the relevant source or timeline version, and what evidence or errors it returns. Keep pacing, take selection, and other judgments with the agent. Scarlet enforces permissions, edit scope, and timeline validity, then applies, versions, and previews the requested operations.

For example, a dialogue scan can report two occurrences of a line with their timestamps and surrounding words. The agent can listen to both, keep an intentional repetition, remove a false start, or ask the editor about competing deliveries. The decision to cut or open a review item belongs to the agent or the editor. Detecting the repetition supplies evidence for that decision.

Reading a skill is a read-only operation. Pinning a guide brings it into the agent’s context while the rest of the enabled library stays discoverable. Editing shortcuts should make their scope and defaults explicit. For example, an agent can place camera clips as submitted or request an inset, and can regenerate a named caption track while preserving captions in another language.

## Original v1 plan and dated decisions

The sections below record the plan as written on 2026-10-30 and the decisions made since, in date order. Some of it has been superseded:

- The Review / Watch / Changelog screens became the simple view, with the chat beside the player and the review panel under it (see `AGENTS.md`).
- Scarlet does not rewrite voice notes with its own model. The agent receives the editor's words and the raw voice transcript (principle 5).
- Team features are paused (see Status).
- The MCP tool names are now `project_get`, `timeline_propose`, `dialogue_apply_cuts` and so on (`packages/mcp/src/server.ts`).

## Platform requirement (2026-10-31)

Scarlet runs exclusively as a macOS or Windows desktop application. The same requirement applies to development previews, sample projects, screenshots, and acceptance testing. The embedded renderer requires the native Tauri bridge. The engine exposes an API only. Use `pnpm desktop:demo` to review the sample interview in Scarlet.

## Status (2026-10-30)

Phases 0–3 are implemented in a first pass and verified end to end on one machine:

- `packages/timeline` (schema, ops, diff, OTIO), `packages/shared` (API contract + client), `packages/render` (ffmpeg filter-graph renderer with segment cache), `packages/mcp` (24 agent tools + system prompt), `apps/server` (Hono + SQLite), `apps/agent` (local host: Claude Code / Codex / Gemini runners), `apps/web` (React UI). 95 tests pass.
- Live smoke test: upload → first cut → agent change → 6.5 s before/after clip rendered in 4 s → approve → full preview render from cached segments in 3 s → OTIO export. A real Claude Code session ran through both `scarlet-agent run` and the queued-task path (task → host claim → run → change ready) in 8 s.
- Not yet exercised for real: Codex and Gemini runners (CLIs not installed here), OpenAI/whisper.cpp transcription (no key), Docker image build, the embedded renderer against a live engine at that point (fixtures had been checked).

**Single-user for now (decided 2026-10-30):** accounts, login, invites, roles, project members, the reviewer sign-off and the desktop app's team mode are removed to keep Scarlet simple while it is used by one person. The server has one local user and an access token (kept in `<data>/access-token`): the desktop app receives it from the engine, and headless clients use it for authentication. Existing databases keep working (the old tables and columns stay, unused). Collaboration will come back later; the A3 and Auth items below describe the earlier multi-user design.

**Desktop (added 2026-10-30):** Scarlet ships as native Windows and macOS apps, not a browser app. Decision: **Tauri 2** — a Rust shell that owns the window, native integration, and the agent host (the always-on part that spawns Claude Code / Codex / Gemini), rendering the existing React UI in the OS webview (WebView2 / WKWebView; no bundled Chromium). The engine (`apps/server`) compiles to a single executable (`scarlet-engine`, Node SEA on `node:sqlite`, no native addons) and runs as a sidecar (no login, data in the app's data dir; the earlier **team mode**, connecting to a shared server, was removed with collaboration). ffmpeg/ffprobe ship beside the engine. Rendering speed is ffmpeg either way; Rust buys startup, memory, binary size, and native feel. A full Rust port of the engine remains possible later behind the same HTTP contract.

Desktop status (2026-10-30): `apps/desktop` builds and runs on Windows. Engine compiled to `scarlet-engine.exe` (Node SEA, 91 MB); Rust shell 9 MB; ffmpeg and ffprobe 9.0.2 ship as sidecars beside the engine (pinned, SHA-256-checked builds from `apps/desktop/scripts/fetch-ffmpeg.mjs`: gyan.dev for Windows, martin-riedl.de native arm64 and x86_64 builds for macOS). Installers: `Scarlet_0.1.0_x64-setup.exe` (82 MB), MSI (113 MB). `apps/desktop/scripts/smoke-engine.mjs` checks a built bundle end to end with a bare PATH (ingest, captioned render, approve, MCP tool list, clean exit); it passes on Windows. `apps/agent` (TypeScript host) remains for headless/server machines; the desktop app embeds the Rust port.

macOS: `.github/workflows/desktop.yml` builds Apple Silicon (macos-15) and Intel (macos-15-intel) natively, checks binary architectures and the code signature, runs the smoke test against `Scarlet.app/Contents/MacOS`, launches the app and saves a screenshot. Mac-specific handling: ad hoc signing by default (`signingIdentity: "-"`, hardened runtime, JIT entitlements for the Node engine), Apple secrets passed only when set, login-shell PATH lookup so CLIs installed via nvm/asdf/mise are found from the Dock, agent runs in their own process group so Stop kills MCP children, voice clips named by recorded type (WebKit records mp4), a native Save dialog for downloads (WKWebView ignores download links), native file drops routed to the library or project under the pointer, IME-safe Enter, minimum macOS 13 (Tailwind v4 needs Safari 16.4 WebKit).

At this stage, the next steps were to run the UI against the live server with the team, try the first real Codex and Gemini runs, stream uploads for multi-GB footage, highlight caption words, and retry failed renders.

## The problem

Editing with AI already works. Editors brief an agent (Codex, Claude Code), it cuts from a word-timed transcript and waveform, and hands back an MP4. What doesn't work is everything around that loop:

- **Review is the bottleneck.** 10–30 passes per video, 10–30 minutes each. Every pass is a full re-render and a full re-watch. Past ~10 minutes of runtime, reviewing in a media player is bad enough that editors go back to a timeline.
- **Nothing is shared.** A producer shares footage through cloud storage, and an editor downloads it. Feedback is voice or chat. The edit lives wherever one agent happened to write it.
- **Handoffs are manual.** Astra cuts, Opus animates; the bridge is a pasted brief and file paths.
- **Each pass burns plan allowance** on re-doing work that didn't change.

## What Scarlet is

A shared, versioned video project with a review UI and an agent interface. It is **not** a new editor and **not** a new AI. The editor's own agent (Codex CLI, Claude Code, Gemini CLI, on their own subscription) does the editing; Scarlet owns the project, the history, the renders, and the review loop.

**The unit of work is a change, not a render.** An agent proposes a change to the cut list; Scarlet renders just the affected range as a short clip; the editor approves, rejects, or talks back; approved changes commit to history. The full video is always one click away, assembled from cached segments.

### Core principles

1. **Cut list is the source of truth.** Not the MP4, not a Resolve project. Everything (renders, history, exports, diffs) derives from it.
2. **Agents edit, Scarlet renders.** Agents never produce the final video. This is what makes partial re-render, history, and model-switching possible.
3. **Bring your own agent.** Scarlet talks MCP. Any agent with an MCP client and a subscription works. API keys are a fallback and for Scarlet's own cheap background jobs.
4. **Voice first.** Click, speak, done. Typing is the same path without a microphone.
5. **Open source, self-hostable.** The desktop app for a solo creator; one Docker command for a server. (Team features are paused; see Status.)

## Assumptions to confirm

These change the plan if wrong:

| # | Assumption | If wrong |
|---|---|---|
| A1 | ~~Long-form first~~ **Confirmed: both long and short form in v1.** Same cut list, same loop; shorts add aspect-ratio presets (9:16) and caption styling, long-form leans on transcript navigation in Watch. | — |
| A2 | **No reusable cut-list artifact exists today.** The agents leave scripts and MP4s, not a structured EDL. We define the format. | If one exists: adopt it as the import path and shape our schema around it. |
| A3 | ~~A reviewer approves the video before publication~~ ~~**Confirmed: multi-user with an optional reviewer.**~~ **Paused 2026-10-30: single-user for now** (see Status). Earlier design: Accounts and notifications in v1. A project can have an assigned reviewer who gets notified when a cut is ready and can approve, reject, or leave notes; if no reviewer is assigned the editor finishes on their own. | — |

**Confirmed 2026-10-30: the agent conversation happens inside Scarlet.** The editor never opens a terminal. They watch, click, speak; Scarlet runs their agent (their subscription, their CLI, headlessly) and the result arrives as change clips. Using Codex/Claude Code directly against Scarlet's MCP server remains a power-user path, not the primary one.

## Architecture

```
┌──────────────────────────── editor's machine ─────────────────────────────┐
│  Codex CLI / Claude Code / Gemini CLI  ──MCP──▶  scarlet-agent (local host) │
│  (their subscription, their skills)              • exposes Scarlet MCP tools │
│                                                  • media cache / proxies     │
│                                                  • voice capture (optional)  │
└───────────────────────────────────────┬───────────────────────────────────┘
                                        │ HTTPS / WebSocket
┌───────────────────────────────────────▼───────────────────────────────────┐
│  scarlet-server (local or hosted)                                          │
│  • project store: media, transcripts, cut-list versions, notes, renders    │
│  • change queue: proposed → rendered → approved/rejected                   │
│  • render workers: segment renders, full assemblies, proxies, waveforms    │
│  • transcription worker: word-timed transcript (Whisper / provider)        │
│  • review API: change feed, history, notes, voice                      │
│  • exporters: OTIO / FCPXML → DaVinci Resolve                              │
└───────────────────────────────────────────────────────────────────────────┘
```

**Why the split:** subscriptions only work through the vendor's CLI, logged in on the user's machine. So the agent must run locally. The engine manages footage, history, and renders. The desktop window and agent host run on the same machine.

### Components

#### 1. Cut list format (`packages/timeline`)
A JSON document. Deliberately boring and small.

- **Project:** frame rate, resolution, aspect, media index (source files with hashes, duration, proxies, transcript ref).
- **Timeline:** ordered tracks (video, audio, overlay, caption); each track a list of **clips** with `source`, `sourceIn/Out`, `timelineIn/Out`, optional `transform` (scale/position/crop), `effects[]`, `transitions`, `volume/fades`.
- **Markers & notes:** timestamped, linked to clips, with author and voice-transcript text.
- **Generated assets:** animations, captions, music, graphics as files with provenance (which agent, which prompt, which version).

Every version is immutable and content-addressed. A **change** is a diff between two versions plus metadata: author (agent + model, or human), the note that triggered it, plain-language description, and the affected time range(s).

Exporters: OTIO (Resolve imports natively), FCPXML, EDL. Importer: OTIO (for the "rebuild in Resolve → bring it back" path).

#### 2. Scarlet MCP server (`packages/mcp`)
The only way agents touch a project. Tools, roughly:

- `project.get`, `media.list`, `transcript.get(range, granularity=word|syllable)`, `waveform.get(range)`
- `timeline.get(version?)`, `timeline.propose(diff, description, note_id?)` → returns `change_id` and triggers a segment render
- `change.status`, `change.list(state)`, `notes.list(unresolved)`, `note.reply(note_id, text)`
- `assets.put(file, provenance)`, `render.request(range | full)`, `render.get(id)`
- `export.otio(version)`

Agents never write MP4s. They propose diffs. The original editing skills map onto these tools almost one-to-one (first cut = `transcript.get` + `waveform.get` + `timeline.propose`; smooth audio cuts = propose fades; render = `render.request`).

#### 3. Local agent host (`apps/scarlet-agent`)
Small daemon on the editor's machine. **This is how the agent runs; the editor never sees a terminal.**

- Detects installed CLIs (Codex, Claude Code, Gemini) and their login state; the UI shows them as selectable agents.
- **Dispatch:** every instruction from the UI (a voice note, a "revise this change", a full brief like "make the first cut as a 9:16 short") becomes a task. The host launches the chosen CLI headlessly (`codex exec`, `claude -p`, `gemini -p`) with the task, the project context, and the Scarlet MCP server attached, streams its progress back to the UI, and the result lands as change clips.
- Runs the Scarlet MCP server locally; also registers it with the CLIs so power users can drive a project from their own terminal.
- Streams media from the server with a local cache; serves low-res proxies for the agent's own frame inspection.
- Per-project agent memory and the editor's skills (bundled workflows and ones saved via "turn this into a skill") are passed to the CLI on each task.

#### 4. Server (`apps/server`)
- Project store (Postgres for metadata, object storage/filesystem for media).
- Change queue and state machine: `proposed → rendering → ready → approved | rejected | revising`.
- Render workers (ffmpeg-based): **segment renders** of a change's affected range plus ~2 s handles; **full assembly** from cached, content-addressed segments so only changed regions re-encode; proxies and waveforms on ingest.
- Transcription worker: word-timed transcript on ingest (faster-whisper locally, or a provider via API key). Stored once, reused by every agent and every pass.
- Ingest: drag-and-drop upload, folder watch, Google Drive connector.
- Auth (multi-user design, paused 2026-10-30; today: one local user and an access token): simple team accounts, invite links. Roles per project: **owner**, **editor**, **reviewer** (optional, assignable). Notifications when a cut is marked ready for review, a change is ready, or a note is assigned to you. Projects without a reviewer skip the review gate.

#### 5. UI (`apps/web`, shown in the desktop app)
**AI-native, not a timeline editor** (decided 2026-10-30). The UI is built for one job: deciding on the agents' changes quickly and confidently. No multitrack lanes, clip inspector, frame stepping or J/K/L shuttle; hand edits go to DaVinci via OTIO.

- **Review** (default when anything is waiting). Left: the decision queue — *Needs you* (agent questions first, then ready changes oldest first, failed last), *Agents working*, *Decided today*. Right: one item in focus — title, who did it and which note it answers, the change as a **looping before/after clip** (hold B for before), a one-line context bar showing where it sits in the video, "What changed" with the duration delta, and **Approve (A) / Reject (R) / hold V to ask for a different version**. Deciding auto-advances. **Batches** (one change covering many spots, e.g. 9 filler words) step spot by spot with ←/→ and approve as one. **Revisions** stay together as Attempt 1 / Attempt 2 tabs with what you said in between. Questions are answered by voice in the same place.
- **Watch** (default when the queue is empty). The full cut, sized to the project's shape (9:16 shorts play vertical), a context bar with note and change marks, and the transcript as the map with notes inline. Whatever you say lands as a note at the playhead.
- **Changelog.** Approved changes newest first in plain words; restore any version; "Open in DaVinci Resolve" and "Render final video".
- **Media.** Files with a plain summary and transcript status.
- **Composer** (every project screen). Big mic, one line of text, one agent chip ("Claude · opus"), and an activity button for what agents are doing. Holding V talks to whatever is in focus: the change or question on Review, otherwise the composer.
- **Settings** (General / Models / Quick actions / Skills / Advanced) via the menu.

Voice: desktop microphone capture → transcription by the engine → note text. *(Superseded: an earlier draft had Scarlet's own small model rewrite the note into a precise task. The agent now gets the note as spoken, with the playhead, selection and clip references attached.)*

## Build order

Each phase ends with something the team can actually use.

**Phase 0 — Format and render core (weeks 1–2)**
Cut list schema + validation, OTIO export, ffmpeg segment and full renderer, content-addressed segment cache, word-timed transcription on ingest. CLI only. *Proof: hand-write a cut list, render it, open the OTIO in Resolve.*

**Phase 1 — Agents edit through Scarlet (weeks 3–4)**
MCP server with the tools above; local agent host; Codex and Claude Code register automatically. Port the original `first-cut` skill to use `transcript.get` / `waveform.get` / `timeline.propose`. *Proof: An editor makes a first cut through Codex with their usual prompt and Scarlet renders it.*

**Phase 2 — Review loop (weeks 5–7)**
Engine and desktop UI: upload, review player, click-to-note with voice, change feed with partial renders, approve/reject/revise, history. *Proof: An editor cuts a video and a reviewer plays the result in Scarlet.*

**Phase 3 — Team and polish (weeks 8–9)**
Accounts, notifications, Google Drive ingest, assign-to-agent dispatch, Resolve round-trip (OTIO import back). *Proof: the whole team ships one video through Scarlet end to end.*

**Phase 4 — Open source release (week 10)**
Docker Compose for the server, installers for the local host, docs, a demo project, the ported skills. Gemini CLI support. Retain the licences and credits for adapted workflows.

## Deliberately out of scope for v1

- A drag-and-drop timeline editor. Resolve does that; we export to it.
- Scarlet's own models. BYO agent is the point.
- Real-time multi-user editing on the same timeline. Changes serialize through the queue; branching covers the parallel case.
- Publishing directly to YouTube or TikTok.
- Mobile.

## Stack

- **TypeScript** monorepo (pnpm): server (Node + Fastify or Hono), web (React + Vite), MCP server (official TS SDK), local host (Node, packaged with a single-binary tool).
- **ffmpeg** for all rendering; **faster-whisper** (Python, containerized) for transcription with a provider fallback.
- **Postgres** + filesystem/S3-compatible storage. **SQLite** in solo mode.
- **OpenTimelineIO** for interchange.

## Open questions beyond A1–A3

- Captions: Scarlet renders them from the transcript, or the agent generates them as an asset? (Leaning: Scarlet renders from a caption track in the cut list; style is a preset.)
- Generated graphics/animations: standard as rendered video with alpha, or also keep a source form (e.g. an HTML/Remotion component) so a different model can revise it? (Leaning: store both when available.)
- How far to go on effects in the cut list. Transform, crop, fades, speed, and opacity are enough for v1; color and Fusion-style compositing go to Resolve.
- How hosting location and footage size affect the proxy strategy.

## Parallel work, threads and quick actions (2026-10-30)

Modelled on agentic coding tools (threads, parallel agents, isolated work, merge on accept):

- **Merge on approve** (`packages/timeline/src/rebase.ts`). Times are translated between versions through the source footage, so edits made against an older cut land on the right words. Approving fast-forwards when the cut hasn't moved, re-applies the change's edits when it has, and — when they touch the same moments as something approved since — sends the change back to its agent (same thread) to redo on the current cut. Changes keep their `ops`; whole-timeline proposals can't be merged and are always sent back.
- **Accurate change spots.** `changedSpots` reports what looks or sounds different, so a cut is one short spot at the cut point (not "everything after it"), and each spot's "before" clip shows what was removed.
- **Approve some spots of a batch** (`approve { spots }`), **undo** (`unapprove`, while nothing sits on top).
- **Threads.** Tasks and changes carry `threadId`; a follow-up gets the thread's history added to the agent's instruction. MCP proposals default to the version the agent last read.
- **One request at a time per project (2026-11-06).** The editor found agents working on the same video at once confusing, and an edit planned on footage that was still being cut could block applying those cuts. Claim runs a project's requests one at a time in the order they were asked, across threads and runtimes. A dialogue pass whose staged cuts still need the editor holds back requests that aren't about it, but not replies to it or revisions of it. `queueWait` (`packages/shared/src/threads.ts`) explains the same rule in the chat ("Queued · After the dialogue pass", "Starts when you apply the dialogue pass"), and the message box says when a new request will wait. "Start in new thread" is gone. Hosts still run up to 3 tasks per agent at once across projects (`maxParallel`, max 8). The editor rejected answering questions right away while queueing edits: one rule for every request. The editor can waive the calls for one request (2026-11-11): Start now on its row in the queue sets `startsBeforeCalls` (`POST /tasks/:id/start-now`), and it then takes its turn like any request no pass holds back.
- **Quick actions** (`/api/actions`): saved instructions, number keys 1–9, "whole video" or "the moment I'm on". Each run starts its own thread. Three editable defaults are seeded.
- **UI**: Review lists threads (Needs you / Agents working / Done today); the focused thread shows the decision, then the conversation; the composer replies to it; batches have per-spot Keep/Skip (X); approvals report applied / merged / partial / sent back with Undo; Settings → Quick actions.

## History, DaVinci round-trip, archive, trash (2026-10-30)

- **Activity log** (`activity` table, `GET /projects/:id/activity`, `GET /activity`): append-only record of every change proposed/approved/rejected/undone/sent back, version restores, DaVinci imports, requests and answers, notes, uploads, settings and team changes, skills, quick actions, deletions and restores. Shown in Changelog → Full history, live over WebSocket.
- **DaVinci round-trip** (`fromOtio` in `packages/timeline/src/otioImport.ts`, `POST /projects/:id/import/otio`): a timeline edited in Resolve comes back as a change by the person importing it, based on the version that was exported. Clips are matched back to the exported version (Scarlet id → name → footage and range) to keep looks; Resolve's linked audio twins are dropped; captions and markers are re-timed through the footage; unknown footage is named in the error.
- **Thread archive**: Review lists threads finished more than a day ago under "Earlier", with search over requests, replies and attempts.
- **Trash**: deleting moves a project to the trash for 30 days (`GET /trash`, `POST /projects/:id/restore`); purged automatically afterwards.
