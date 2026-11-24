# Telemetry

Scarlet reports anonymous product usage so we can see which parts of the editor are used and where requests fail. The engine (`apps/server`) collects it. The interface reports explicit applied-edit decisions to the local engine. Only the engine sends events to PostHog.

Packaged releases send these events to the Scarlet project in PostHog US Cloud. Source builds report only when you supply a PostHog project token, and their events say `channel: dev`.

## Turning it off

In **Settings → About**, turn off **Send usage reports**. Scarlet saves this preference with the library and applies it immediately. Turning it off discards queued events and cancels sends in progress. Turning it back on starts collecting new events.

To disable reporting before the first launch, set `SCARLET_TELEMETRY_ENABLED=false` in the engine environment. `0`, `no` and `off` work too. This overrides the saved preference and prevents creation of the telemetry ID on a fresh installation.

## What is sent

| Event | When | Properties |
| --- | --- | --- |
| `server.boot.heartbeat` | The engine starts | `projectCount` |
| `feature.used` | A listed request succeeds | `feature` |
| `task.requested` | A request is queued | `kind`, `agent`, `fast` |
| `task.finished` | A request is done, failed or cancelled | `kind`, `agent`, `state`, `changeCount`, `interrupted`, `durationMs`, `failureReason` (failed only) |
| `edit.reviewed` | An editor explicitly keeps an applied edit or successfully submits a revision or Undo edit request about it | `decision` (keep, revise, undo), `editId` |
| `render.finished` | An export is done, failed or cancelled | `kind`, `state`, `quality`, `failureReason` (failed only) |
| `export.finished` | An export succeeds: a rendered video, a handoff folder, a timeline or captions | `route` (render, handoff, otio, srt, vtt), `firstExport` |
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

`feature` is one of a fixed list of names such as `project.create` or `change.approve`. The list is in `packages/shared/src/telemetry.ts`. It covers things an editor or an agent chose to do. Polling, host housekeeping and agent tooling are not counted.

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

## Identity

On first use the engine writes a random id to `telemetry-id` in the Scarlet data folder, next to `scarlet.db`. It is not derived from the machine, the account or the library. Events carry the SHA-256 of that id as `installId`, never the id itself. Delete the file to start over as a new install. The empty `telemetry-exported` file beside it only records that this install has exported.

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
