# Telemetry

Scarlet reports anonymous product usage so we can see which parts of the editor are used and where requests fail. The engine (`apps/server`) collects it. The interface reports explicit applied-edit decisions to the local engine. Only the engine sends events to PostHog.

Packaged releases send these events to the Scarlet project in PostHog US Cloud. Source builds report only when you supply a PostHog project token, and their events say `channel: dev`.

## Turning it off

In **Settings → About**, turn off **Send usage reports**. Scarlet saves this preference with the library and applies it immediately. Turning it off discards queued events, cancels sends in progress and deletes the installation ID (`telemetry-id`), so a problem report sent meanwhile isn't tied to earlier usage. Turning it back on starts collecting new events under a new ID.

To disable reporting before the first launch, set `SCARLET_TELEMETRY_ENABLED=false` in the engine environment. `0`, `no` and `off` work too. This overrides the saved preference, prevents creation of the telemetry ID on a fresh installation and deletes one left by an earlier launch. The desktop app passes its own environment to the engine, and on macOS an app opened from the Dock or Finder doesn't see variables set in a shell profile: use `launchctl setenv SCARLET_TELEMETRY_ENABLED false` and restart Scarlet. Each library keeps its own preference, so a separate library or review app starts with reporting on.

## The agent tools' own telemetry

Claude Code, Codex and Gemini each report usage to their makers by default. Scarlet always turns that off for every copy it starts, whatever the setting above: Claude Code gets `DISABLE_TELEMETRY=1` and `DISABLE_ERROR_REPORTING=1`, Codex `analytics.enabled=false`, and Gemini `--disable-telemetry`, including when signing in. Runs through Ollama, LM Studio or OpenRouter also turn off Claude Code's other background traffic. The headless Chrome Scarlet renders graphics with runs with crash reporting, pings, metrics and background networking off, in a fresh profile each time. The bundled speech model runs offline with Hugging Face telemetry off.

Some requests aren't usage reports and don't depend on the setting: checking GitHub for a Scarlet update, checking for new versions of the agent tools, the model price list, and downloading transcription models or FFmpeg when asked.

## What is sent

| Event | When | Properties |
| --- | --- | --- |
| `server.boot.heartbeat` | The engine starts | `projectCount` |
| `feature.used` | A listed request succeeds | `feature` |
| `task.requested` | A request is queued | `kind`, `agent`, `fast` |
| `task.finished` | A request is done, failed or cancelled | `kind`, `agent`, `state`, `changeCount`, `interrupted`, `durationMs` (omitted if a queued transcription ended before starting), `failureReason` (failed only; clean pauses, project deletes and quits are reported as `cancelled` with `interrupted: true`) |
| `edit.reviewed` | An editor explicitly keeps an applied edit or successfully submits a revision or Undo edit request about it | `decision` (keep, revise, undo), `editId` |
| `render.finished` | An export is done, failed or cancelled | `kind`, `state`, `quality`, `failureReason` (failed only) |
| `export.finished` | An export succeeds: a rendered video, a handoff folder, a timeline, captions or a YouTube upload | `route` (render, handoff, otio, srt, vtt, youtube), `firstExport` |
| `youtube.upload_finished` | A YouTube upload is done, failed or cancelled | `state`, `visibility` (public, unlisted, private), `reusedRender`, `failureCode` (failed only: the engine's own code, such as `youtube_quota_exceeded`) |
| `media.added` | A file is added to a project and Scarlet has read its length | `kind` (video, audio, image, graphic), `durationBucket` (video and audio only), `addedBy` (editor, scarlet) |

Every event also carries its capture time, a random UUID for delivery deduplication, `installId`, `platform`, `arch`, `scarletVersion` and `channel`. The installation ID is also the PostHog distinct ID.

`channel` is `release` only in a public package: the desktop app built for a release feed, whose engine reports with the key built into it. Everything else is `dev`: a source build, `pnpm desktop:dev`, a local-main or review package, and any engine given its own `SCARLET_POSTHOG_KEY`. `SCARLET_TELEMETRY_CHANNEL=dev` marks a public package as the team's own.

`failureReason` is one fixed category the engine reads off the failure on the installation. The failure's own words, paths and names never leave it.

| `failureReason` | Meaning |
| --- | --- |
| `agent_not_installed` | The agent's command-line tool couldn't be found or started |
| `agent_not_signed_in` | The agent's tool isn't signed in, or its sign-in or key was refused |
| `agent_incompatible` | The agent's tool refused the options or settings Scarlet starts it with, as an older or much newer version does |
| `rate_limited` | A usage limit, quota, credit balance or rate limit |
| `model_unavailable` | The chosen model doesn't exist or this account can't use it |
| `provider_error` | The model provider answered with a server error or was overloaded |
| `tools_unavailable` | Scarlet's editing tools didn't start for the agent |
| `timeout` | The host stopped a run at its time limit or after it went silent |
| `interrupted` | Scarlet quit, paused or stopped the run before it finished |
| `crashed` | The agent's tool, a worker or ffmpeg exited without finishing |
| `transcription_model_missing` | No transcription runtime or model was available |
| `media_unreadable` | A recording couldn't be found, read or decoded |
| `out_of_disk` | The disk was full |
| `network` | A connection, DNS or TLS failure |
| `other` | Anything else |

`render.finished` uses the categories that apply to an export: `out_of_disk`, `interrupted`, `media_unreadable`, `crashed` and `other`.

`export.finished` is sent alongside `render.finished` and the `timeline.export_*` names of `feature.used`, which stay as they were. `firstExport` is `true` for the first export this installation reports and `false` after it. The engine then writes an empty `telemetry-exported` file next to `telemetry-id`. An export the library finished before that file existed, by an earlier release or while reports were off, also makes later exports not the first. Exports made by Scarlet's agents count too.

`durationBucket` is `lt_1m`, `1_10m`, `10_30m`, `30_60m` or `gt_60m`. The exact length, the file's name and its path are not sent. `addedBy` is `scarlet` for footage, pictures and graphics an agent added.

`feature` is one of a fixed list of names such as `project.create` or `change.approve`. The list is in `packages/shared/src/telemetry.ts`. It covers things an editor or an agent chose to do. Polling, host housekeeping and agent tooling are not counted. A test in `apps/server/src/telemetry/featureUsage.test.ts` fails when a new request that changes something is neither counted nor listed as left out on purpose.

`task.requested` also counts transcriptions the engine starts on its own (`agent` is `api`) and runs that resume an earlier request.

An explicit Keep is counted once when it marks that version as reviewed. Revise includes typed or spoken requests submitted about an applied edit. Undo means the editor used Undo edit and Scarlet accepted the request. Either request can still fail or be cancelled later. Opening Revise, discarding a draft, leaving an edit alone, approving a proposed cut and automatic retries do not produce review decisions.

The engine generates `editId` using HMAC-SHA-256 with the installation’s private random ID as its key and the original local edit reference as input. The same edit on another installation gets a different code. The dashboard uses the most recent reported choice per reviewed edit in the reporting period. Edits without a decision are outside that denominator.

## What is never sent

- Media, frames, audio or transcripts
- File paths, project names or skill names
- Prompts, instructions, notes, messages, summaries or error text
- Model names
- The raw IDs of projects, tasks, changes, media or hosts, edit titles, revision text or timeline positions
- Anything about the account or the machine beyond the operating system and processor type

The ingest host sees the source IP when it receives a request. Scarlet disables GeoIP enrichment on each event.

## Problem reports

A problem report is separate from usage reports. Scarlet sends one only when the editor asks: one press on a Report beside an error (or Report this problem on the screen a crash leaves) sends it at once, and **Send report** in the Report a problem form, from Help › Report a Problem… or Settings › About, sends one with the editor's words. It is sent whether or not usage reports are on, because the editor asked to send it. The desktop app sends it straight away, itself, so a report still goes when the engine has stopped.

It goes to the same PostHog project and host as usage reports (`SCARLET_POSTHOG_KEY` and `SCARLET_POSTHOG_HOST` apply) as one `bug.reported` event with:

| Property | What it is |
| --- | --- |
| `reference` | A short code the editor is shown, such as `3F2A-91BC` |
| `description` | What the editor wrote, up to 5,000 characters |
| `about` | The error on screen the report was opened from, up to 2,000 characters |
| `page` | The page's path and the names of its query parameters |
| `onScreen` | Up to five errors the window showed in the last 15 minutes, as the log records them |
| `system` | The system report from Export logs: version, OS, engine and agent status, desktop settings |
| `recentProblems` | The newest 12 warning and error lines from the cleaned log |
| `log` | The newest 300 KB of the cleaned log, and `logTruncated` when older lines were left out |

Words the editor adds afterwards with **Add details** go as a `bug.details` event with the report's `reportId` and `reference` and their `description`, and nothing else beyond the fields every report has.

Plus `installId` (only while usage reports are on, so a report can be read beside usage), `platform`, `arch`, `scarletVersion` and `channel`. The log is the one Export logs saves: the same allowlist of operations and fields, with keys and tokens removed. Unlike usage reports, a problem report can carry the editor's own words, the error text on screen and the raw IDs in the log. It never carries media, frames, audio, transcripts, prompts or sign-ins. If it can't be sent, the editor can save the same report as a `.zip` in Downloads.

## Identity

On first use the engine writes a random id to `telemetry-id` in the Scarlet data folder, next to `scarlet.db`. It is not derived from the machine, the account or the library. Events carry the SHA-256 of that id as `installId`, never the id itself. Delete the file to start over as a new install. Turning reports off deletes it too. The empty `telemetry-exported` file beside it only records that this install has exported.

No person profile is created for an install.

## Delivery

Events wait in memory and go out in batches of 20 every 10 seconds to `<host>/batch/`. A batch that fails is sent again, unchanged, with a delay that doubles from 2 seconds to 5 minutes. It is dropped after 30 minutes of failing, or at once when the host rejects it (400, 401 or 413). While the host can't be reached the engine keeps the newest 1,000 events.

When the engine quits it waits up to one second for the last batch. Nothing is written to disk, so events that did not go out are lost.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `SCARLET_TELEMETRY_ENABLED` | on | `false`, `0`, `no` or `off` turns telemetry off |
| `SCARLET_POSTHOG_KEY` | the key built into the release | The project events are sent to |
| `SCARLET_POSTHOG_HOST` | `https://us.i.posthog.com` | Any PostHog-compatible host |
| `SCARLET_TELEMETRY_FLUSH_BATCH_SIZE` | 20 | Events per request |
| `SCARLET_TELEMETRY_MAX_BUFFERED_EVENTS` | 1000 | Events kept while the host can't be reached |
| `SCARLET_TELEMETRY_CHANNEL` | unset | `dev` reports a public package under the `dev` channel |

The key built into a release is `DEFAULT_POSTHOG_KEY` in `apps/server/src/telemetry/config.ts`. Only the packaged `serve` command uses this default. The packaged smoke test and playback benchmarks turn reporting off.

The desktop app passes `SCARLET_RELEASE_CHANNEL` to its engine only when it was built for a release feed (the public packages from `desktop-build.yml` and `linux-desktop.yml`). Together with the built-in key, that makes the channel `release`.
