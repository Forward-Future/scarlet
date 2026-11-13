# Developing Scarlet

Start with the [source build](../README.md#run-from-source). The Tauri app opens the editor, starts a local engine on loopback and runs the signed-in agent CLI. The engine stores project versions in SQLite. Each version describes a cut list of tracks, clips, captions and markers. When the agent changes that list, Scarlet compares versions and renders the affected ranges. [Editing principles](PLAN.md#principles)

## Repository layout

| Path | Responsibility |
| --- | --- |
| `apps/desktop` | Tauri window, engine startup, Rust agent host and installers |
| `apps/web` | Embedded React workspace for chat, playback, timeline review and export |
| `apps/server` | Project storage, ingest, transcription, render jobs and task history |
| `apps/agent` | Standalone TypeScript agent host for headless use |
| `packages/timeline` | Cut-list schema, editing operations, version diffs and OpenTimelineIO conversion |
| `packages/render` | FFmpeg media inspection, proxies, waveforms and cached renders |
| `packages/shared` | HTTP and WebSocket contracts and the typed `ScarletClient` |
| `packages/mcp` | Model Context Protocol tools and the prompt shared by the agent hosts |
| `skills` | Editable workflow guides seeded into the project library |

## Run and test

Run commands from the repository root. `pnpm desktop:dev` opens your local project library with live reload. `pnpm desktop:demo` opens an isolated sample interview in the native app. The renderer in `apps/web` runs inside that window.

| Command | What it checks |
| --- | --- |
| `pnpm build` | Compiles the workspace packages, engine and embedded renderer |
| `pnpm typecheck` | Checks TypeScript across the workspace |
| `pnpm test` | Runs workspace tests with Vitest |
| `pnpm desktop:test` | Runs the desktop app’s Rust tests |

The render tests need `ffmpeg` and `ffprobe` on `PATH`. For a change to editing behavior, use the editing evaluations and keep real footage, transcripts and results outside the repository. For performance work, the editor benchmarks measure project opening, scrubbing, previews and export. [Editing evaluations](../evals/README.md) · [Editor benchmarks](editor-performance.md)

For headless integration work, `pnpm --filter @scarlet/server start` runs the API and render workers. `docker compose up -d` starts the containerized engine. To connect an external agent, configure `pnpm mcp` as a stdio MCP server with `SCARLET_SERVER` set to the engine URL, `SCARLET_PROJECT` to the project ID and `SCARLET_TOKEN` to the destination engine’s token. Use HTTPS for remote engines, or an HTTP loopback address through a tunnel. The standalone agent and MCP CLIs also accept `--token-file PATH` for an owner-readable file. The desktop app handles this connection for you. Both hosts include a Gemini CLI runner, which also requires a working sandbox backend.

## Transcription

Scarlet prefers a local verbatim CrisperWhisper installation. Bundled Whisper large-v3-turbo handles local speech until that installation is ready. You can also choose another local model in **Settings → General**. [Transcription model setup and adapter interface](transcription-models.md)

Scarlet’s bundled whisper.cpp runtime supports GGML models. In a source checkout, `node apps/desktop/scripts/build-whisper.mjs` builds the pinned runtime with CMake. Set `CMAKE_COMMAND` if CMake is installed outside `PATH`. Packaged apps include the runtime.

| First use | Models downloaded and cached |
| --- | --- |
| Bundled Whisper transcription, including a voice note | Multilingual Whisper large-v3-turbo (5-bit), 574 MB |
| Analysis of a recording | English word timing, 378 MB for English speech, plus two speaker models totaling 46 MB |
| Filler-word detection in a dialogue pass | Filler-word model, 94 MB |

An English dialogue pass using bundled Whisper can download about 1.1 GB across those steps. Subsequent runs reuse the models. For cloud transcription, select **OpenAI Whisper (cloud)** and set `OPENAI_API_KEY` in the engine environment. Recording analysis still uses its local timing, speaker and filler-word models.

## Package a desktop build

Build on the target operating system and architecture. The desktop workflow uses Node.js 24. After `pnpm install --frozen-lockfile` and `pnpm build`, build the engine sidecar at the path Tauri expects, then build the installer. On Apple Silicon, run the following from the repository root.

```sh
pnpm --filter @scarlet/server build:sea -- --out ../desktop/src-tauri/binaries/scarlet-engine-aarch64-apple-darwin
pnpm desktop:build
```

On an Intel Mac, use the filename `scarlet-engine-x86_64-apple-darwin`. On Windows x64, use `scarlet-engine-x86_64-pc-windows-msvc.exe`. Local installers are written under `apps/desktop/src-tauri/target/release/bundle/` with the default Cargo target directory.

The installer includes the engine and `whisper-cli`. Install FFmpeg and FFprobe separately before importing media. On macOS, use the [checksum-verified setup helper](https://github.com/Forward-Future/scarlet-releases/releases/tag/v0.1.2-early-access.1). On Windows, run `winget install --id Gyan.FFmpeg.Essentials --exact`. Restart Scarlet after installation. Source development and the local main updaters can use their own pinned copies. On Windows, install the Vulkan SDK to include GPU transcription. `VULKAN_SDK` points to the SDK and `node apps/desktop/scripts/build-speaker-gpu.mjs` builds the optional DirectML speaker runtime. Local builds can fall back to the CPU runtimes.

Each push to public `main` starts a build for a stable [Scarlet release](https://github.com/Forward-Future/scarlet/releases/latest) for that push’s head commit. The Desktop workflow stamps the same version into the Apple Silicon DMG, Intel DMG, Windows x64 setup executable and Windows x64 MSI. It publishes all four files together once Linux, macOS and Windows CI pass for that commit, the packages pass their smoke and version checks, and the signatures have been verified. Pull requests and manual runs build and verify the installers with read-only access. If a release fails, rerun its failed jobs from the original workflow run to finish that version.

The root package version sets the start of each release series. The patch number increases with the commit’s first-parent distance from the baseline. Reruns reuse the version, concurrent pushes get distinct versions, and a push containing several commits can skip numbers. Run `pnpm release:version for-commit` in a full clone to see a commit’s installer version. To start a new series, run `pnpm release:version set X.Y.Z` and commit all version changes together.

During Early Access, keep the repository Actions variable `SCARLET_STABLE_RELEASES` set to `false` or unset. Pushes to `main` run CI and build installers for testing. To start publishing stable versions, configure signing in the `release` environment, restricted to `main`, then set the variable to `true` before the intended release commit. For Apple Developer ID signing and notarization, set the `APPLE_CERTIFICATE` (base64-encoded Developer ID Application P12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific) and `APPLE_TEAM_ID` secrets there. For Windows, provision an Azure Artifact Signing public-trust certificate profile, grant its app registration the Certificate Profile Signer role, and set `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` as environment secrets. Set `WINDOWS_SIGNING_ENDPOINT`, `WINDOWS_SIGNING_ACCOUNT` and `WINDOWS_SIGNING_PROFILE` as environment variables. Pull requests can run packaging checks without signing credentials. Only publication receives repository write access. [Desktop workflow](../.github/workflows/desktop.yml)

### Follow `main` on macOS

To have `/Applications/Scarlet.app` follow `main`, run `/usr/bin/python3 apps/desktop/scripts/update-macos.py enable` from a checkout with Git access and the build tools on `PATH`. While you’re logged in, the helper checks GitHub every five minutes, builds in its own checkout, verifies the signature and runs the engine smoke test.

The window shows **Updating** during a build and **Restart to update** when it’s verified. Restarting installs the update and reopens your current project. If a newer commit arrives while an update is ready, Scarlet shows progress on the newer build. If that build fails, Scarlet offers the previous verified update again. Quitting normally lets the helper install a verified update, including while a newer one builds, and leaves Scarlet closed.

Rerun the enable command after changing the helper script so the installed copy picks up the changes. The updater logs are in `~/Library/Logs/com.forwardfuture.scarlet.main-updater/`. To stop following `main`, run `/usr/bin/python3 apps/desktop/scripts/update-macos.py disable`. Windows has its own [launcher and setup instructions](../apps/desktop/scripts/windows-main-launcher/README.md).

## Diagnose a problem

**Settings → Advanced → Share logs → Export logs…** saves a ZIP with desktop logs and `system.json` for the app version, OS, engine, assistant status and desktop settings. It excludes media files, projects, transcript files, the database and sign-in tokens. For a bug report, note the time of the problem and review the bundle before sharing it.

| Platform | Desktop log |
| --- | --- |
| macOS | `~/Library/Logs/com.forwardfuture.scarlet/scarlet-desktop.log` |
| Windows | `%LOCALAPPDATA%\com.forwardfuture.scarlet\logs\scarlet-desktop.log` |

Times are in UTC. Scarlet rotates the log at 5 MB and keeps the five previous files. To follow one edit, search for its `tsk_…` task ID. The `task_events` table in `scarlet.db` records its tool calls, progress and errors in order.

| Log tag | Where to look |
| --- | --- |
| `[engine] [task]` | Queue, claim, completion, cancellation, recovery and retry. The host’s failure line and the preceding CLI output give the exit code and error. |
| `[engine] [transcribe]`, `[engine] [audio]` | Transcript progress, audio work and queue delays. **Finish when ready** resumes a paused edit once its transcripts are saved. |
| `[engine] [edit]`, `[project]`, `[render]`, `[media]`, `[activity]` | Applied changes and versions, render warnings, footage and project history. |
| `[ui] [action]`, `[ui] [nav]` | The control or shortcut used and the page it opened. |
| `[ui] [api]`, `[engine] [http]` | The window’s request, the engine’s response, failures and slow calls. |
| `[ui] [realtime]`, `[engine] [ws]` | Events that changed the interface and connections that dropped or recovered. |
| `[ui] [playback]` | Player state, transport commands, streams, dropped frames and stalls. A new `el=` identifies a replacement video element. |
| `[ui] [error]` | UI, microphone, asset and export errors. Search for `WARN` or `ERROR` across the log for failures from other components. |

By default, the desktop host stops an agent after ten minutes without CLI output. In `desktop.json`, `stallMinutes` controls that interval and `timeoutMinutes` sets an optional total run limit. Zero disables the corresponding limit. A stopped run keeps its saved work, and **Resume** continues from there.

**Settings → Usage** shows rebuildable render segments and projects in Trash. Scarlet checks for busy jobs before cleanup. The macOS estimate uses private allocation where available. Development builds also list registered compiler and QA folders under **Developer caches**. To include an existing test directory for inspection, run `node apps/desktop/scripts/register-storage.mjs scratch <directory>`.

## Media resource limits

URL imports allow 64 GiB per file, keep 1 GiB free on the library volume and stop after six hours. The engine reads `SCARLET_URL_IMPORT_MAX_BYTES` and `SCARLET_URL_IMPORT_RESERVE_BYTES` as positive byte counts to override the size and disk limits. Larger local files can be added with the file picker.

Scarlet supports edited timelines up to 24 hours and 50,000 playback sections or source-clock anchors per plan. Whole-recording waveforms support up to 4,320,000 measured points, or 24 hours of decoded audio at the default 50 points per second.
