# Telemetry

Scarlet reports anonymous product usage so we can see which parts of the editor are used and where requests fail. The engine (`apps/server`) collects it. The interface reports explicit applied-edit decisions to the local engine. Only the engine sends events to PostHog.

Packaged releases send these events to the Scarlet project in PostHog US Cloud. Source builds report only when you supply a PostHog project token.

## Turning it off

In **Settings → About**, turn off **Send usage reports**. Scarlet saves this preference with the library and applies it immediately. Turning it off discards queued events and cancels sends in progress. Turning it back on starts collecting new events.

To disable reporting before the first launch, set `SCARLET_TELEMETRY_ENABLED=false` in the engine environment. `0`, `no` and `off` work too. This overrides the saved preference and prevents creation of the telemetry ID on a fresh installation.

## What is sent

| Event | When | Properties |
| --- | --- | --- |
| `server.boot.heartbeat` | The engine starts | `projectCount` |
| `feature.used` | A listed request succeeds | `feature` |
| `task.requested` | A request is queued | `kind`, `agent`, `fast` |
| `task.finished` | A request is done, failed or cancelled | `kind`, `agent`, `state`, `changeCount`, `interrupted`, `durationMs` |
| `edit.reviewed` | An editor explicitly keeps an applied edit or successfully submits a revision or Undo edit request about it | `decision` (keep, revise, undo), `editId` |
| `render.finished` | An export is done, failed or cancelled | `kind`, `state`, `quality` |

Every event also carries its capture time, a random UUID for delivery deduplication, `installId`, `platform`, `arch` and `scarletVersion`. The installation ID is also the PostHog distinct ID.

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

On first use the engine writes a random id to `telemetry-id` in the Scarlet data folder, next to `scarlet.db`. It is not derived from the machine, the account or the library. Events carry the SHA-256 of that id as `installId`, never the id itself. Delete the file to start over as a new install.

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

The key built into a release is `DEFAULT_POSTHOG_KEY` in `apps/server/src/telemetry/config.ts`. Only the packaged `serve` command uses this default. The packaged smoke test and playback benchmarks turn reporting off.
