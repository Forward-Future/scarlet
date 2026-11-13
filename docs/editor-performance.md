# Editor performance

The [native 4K playback measurements](native-playback-benchmarks.md) cover scrub-to-picture latency, stalls across edit boundaries, and dropped frames during caching.

Measured on an 18-core Apple M5 Max running macOS 26.6.2. Timings are wall time. Engine benchmarks use throwaway libraries. FFmpeg 9.0.2, Whisper, Uhm and speaker identification run locally. Renderer benchmarks use a headless DOM unless a measurement identifies the native window. Physical input-to-display latency and Windows GPU performance are unmeasured.

## Large projects, long runs and warm caches

These comparisons use synthetic projects on macOS and the working checkout based on `4755d5e5` before and after the performance changes. Each row times the named operation. The conversation read includes request handling and JSON parsing inside the engine. React timings use a headless DOM. The playback-fragment timing ends when the engine locates an already-encoded fragment.

| Operation and fixture | Before | After |
| --- | ---: | ---: |
| Renderer entry bundle at the native startup handshake, uncompressed | 245,398 bytes | 32,895 bytes |
| Load conversations for 80 finished requests, 1,200 events | 81 requests, 3.14 ms | 1 request, 0.94 ms |
| Queue an edit in a project with 801 media assets | 2.89 ms | 0.34 ms |
| Prepare an agent prompt after 4,000 events | 11.69 ms | 2.13 ms |
| Read another page of a cached 1.94 MB transcript | 0.74 ms | 0.056 ms |
| Build the review list for 1,500 named cuts | 37–48 ms | 0.6–0.8 ms |
| Classify 1,500 mixed zoom and audio edits | 38–47 ms | 0.43–0.61 ms |
| Group 1,800 frame checks in the activity history | 159 ms | 1.41 ms |
| Group 1,800 colliding timeline markers | 54.4 ms | 0.91 ms |
| Process 60 playback-clock updates with 360 visible cut gaps | 123 ms | 38.3 ms |
| Poll playback-cache status for 300 recordings, 75 already published | 17.05 ms | 7.40 ms |
| Locate a cached playback fragment among 3,000 sources and 600 shots | 7.35 ms | 0.092 ms |

The numbers are warm medians. The ranges cover repeated runs on the same fixtures. Returned edit lists, classifications and review reasons matched across 500 randomized cases. The conversation comparison checked every returned task and event in order. Installing the sparse event index in a synthetic library with 40,000 events took 14 ms once. The next database open took 0.64 ms.

On the shipping branch, the renderer starts the native handshake while loading the startup screen. Compared with GitHub main at `a617a44e`, the uncompressed entry bundle fell from 247,100 to 34,681 bytes. The 1,500-cut list took 55.82 ms before and 0.81 ms after. All 600 additional comparisons of review lists, cut reasons and edit kinds matched, including skipped calls and mixed edits. In the matched headless renderer benchmark, grouping 1,800 markers fell from 57.9 to 0.27 ms. Sixty playback updates with 360 visible cut gaps took 143.1 ms before and 5.08 ms after, using the median of three trial means.

The media drawer and header share cache polling. A regression test with both mounted checks one initial request, one read per invalidation and zero extra renders for an unchanged result. Export tests remove the intermediate mixes after caching the program audio and verify that the next export reuses identical AAC packets.

A native macOS check uncovered a 21.35 ms video offset when joining cached preview sections with AAC audio. The remux now preserves the zero origin and reuses the encoded sections. Both output streams in the 14-second fixture start at zero and last 14 seconds. All 420 decoded picture hashes match the original sections in order.

The paused-seek check used an 18-second, 640×360, 30 fps source with its frame number encoded in a black-and-white pattern. The edit keeps source seconds 0–4, 6–10 and 12–18. After three trusted timeline scrubs in the muted, nonactivating macOS window, a 30 Hz window capture first showed the exact source frames 36, 381 and 189 at 31, 18 and 39 ms after release, respectively. Playback crossed both joins with consecutive frames 34 ms apart. These are three individual warm seeks on generated footage. Native 4K and Windows timings for this revision remain unmeasured.

## Opening a project and editing

The fixture contains 32 projects. Its active project has 32 previous edits with associated tasks and notes, one hour of source dialogue with 9,600 timed words, and a 50-minute timeline with 600 five-second clips. The two-camera variant adds 600 synchronized inset clips. The batch removes 48 separate pauses. Each trial starts a fresh engine process and a separate copy of the fixture.

Before is commit `897354c`. After is the optimized working tree. The following medians alternate independently packaged Node 24.22.2 engines with filesystem caches warm, seven pairs for one camera and five for two. The raw samples include system and concurrent workload variation. The small import fixture is a separate 20-second 640×360 H.264/AAC file.

| Operation in ms | One camera before | One camera after | Two cameras before | Two cameras after |
| --- | ---: | ---: | ---: | ---: |
| Process to engine ready | 47.94 | 47.58 | 47.91 | 50.66 |
| First authenticated request | 10.49 | 10.11 | 10.77 | 10.52 |
| 32-project library | 2.31 | 2.27 | 2.34 | 2.27 |
| First workspace snapshot | 5.5 | 5.3 | 9.54 | 10.12 |
| Repeated workspace snapshot | 3.67 | 1.62 | 7.18 | 3.42 |
| Edit, note and task history | 2.82 | 2.54 | 2.52 | 2.51 |
| 30-second transcript page | 4.94 | 4.54 | 4.46 | 4.71 |
| Next transcript page | 4.2 | 3.79 | 3.92 | 3.83 |
| Queue first-cut task | 1.61 | 1.5 | 1.86 | 1.78 |
| Claim first-cut task | 1.24 | 1.17 | 1.37 | 1.29 |
| Agent tool server startup and handshake | 60.35 | 58.14 | 63.12 | 61.69 |
| Submit 48 dialogue removals | 33.08 | 17.64 | 75.06 | 35.7 |
| Open their diff immediately | 1,636.32 | 12.8 | 4,985.96 | 18.04 |
| Read proposal for a dialogue assessment | 15.54 | 1.8 | 30.97 | 1.02 |
| Open individual cut review | 7.19 | 2.91 | 11.03 | 4.95 |
| Preview with one removal restored | 15.93 | 8.89 | 35.91 | 18.94 |
| Approve with one removal restored | 17.85 | 10.36 | 40.23 | 23.16 |
| Apply one ripple cut | 26.71 | 14.41 | 68.94 | 31.18 |
| Undo that cut | 26.38 | 9.17 | 52.59 | 18.68 |
| List versions | 1.03 | 0.9 | 1.22 | 1.48 |
| Agent reads the project | 5.29 | 5.62 | — | — |
| Agent reads the current cut summary | 8.03 | 4.64 | — | — |
| Search 9,600 words via the agent tool | 13.34 | 14.28 | — | — |
| Propose caption track from the transcript | 168.72 | 121.96 | — | — |
| First import JPEG, 360p sample | 22.91 | 23.54 | — | — |
| Import the sample into playable storage | 17.4 | 17.23 | — | — |
| First sample waveform request | 26.64 | 26.94 | — | — |
| Repeated sample waveform request | 1.3 | 1.43 | — | — |
| Assemble two source ranges | 10.45 | 4.03 | — | — |
| First edited monitor JPEG, sample | 44.24 | 43.04 | — | — |
| Repeat the same monitor JPEG | 0.73 | 0.76 | — | — |

[Per-run measurements](benchmarks/editor-macos-arm64.json)

A second experiment isolates React work on the same component tree. Three alternating runs used the production React environment. The median of the run medians for mounting and releasing the library moved from 10.62 to 10.10 ms, and the sample interview workspace from 2.50 to 2.09 ms. Applying an unchanged 32-project library refresh dropped from 1.23 to 0.03 ms. The isolated component comparison holds the rest of the UI constant. The editor reuses static icon shapes and skips publishing identical library snapshots.

## Timeline interaction and media

| Operation | Before | After |
| --- | ---: | ---: |
| Hover to first still request, simulated 16 ms display interval | 106 ms | 16 ms |
| Decoder seeks during a 240-move drag at 250 Hz, including release | 242 | 62 |
| 128 random original-footage lookups on 1,800 clips | 0.321 ms | 0.011 ms |
| Initial original-comparison waveform layout on those clips | 5.07 ms | 0.35 ms |
| Eight cached filmstrip frames spanning 6 seconds | 34.9 ms | 35.0 ms |
| Eight cached filmstrip frames spanning 55 seconds | 137.5 ms | 47.3 ms |
| Eight cached filmstrip frames spanning 120 seconds | 101.0 ms | 55.7 ms |
| Six authenticated source-thumbnail cache misses, prepared proxy available | 1,514 ms | 178 ms |
| Six edited thumbnails on the same cut, original versus prepared proxy | 2,491 ms | 228 ms |

Drag release commits the exact endpoint. Sixty playback-clock updates took 3–10 ms total across repeated headless runs, with no consistent difference. The hover and drag measurements end when the renderer dispatches the request. The JPEG measurements include FFmpeg decoding. A short filmstrip stays on a single sequential decode. Sparse strips seek in bounded groups. Frame tests covered fractional rates and the last frame. The UI rechecks completed source proxies and observes completed cut previews and exports immediately over the project socket. The HTTP fallback remains available across reconnects and when an export continues in another project.

Production media settings were tested on a 32.07-second, 3840×2160 H.264/AAC recording at 30000/1001 fps. Three passes used independent cache directories. The comparison is explicit VideoToolbox decoding versus the selected Automatic policy on this Mac. Both use hardware encoding. The edit contains three ranges totaling about 12 seconds.

| Media operation | VideoToolbox | Automatic |
| --- | ---: | ---: |
| Eight-second 480p source preview | 2.63 s | 1.01 s |
| Checkpointed 540p full source proxy | 6.53 s | 2.60 s |
| First four-second playback fragment from originals | 1.21 s | 0.75 s |
| First fragment with a prepared proxy | 338 ms | 363 ms |
| Cached fragment repack from the original-source run | 26 ms | 29 ms |
| Cold full-cut preview | 3.91 s | 1.57 s |
| Full-cut preview with every segment cached | 33 ms | 27 ms |

Repeated file probing dropped from 54 ms to under 0.2 ms in a separate baseline comparison. Source metadata is keyed by tool, file identity, size and timestamps. A full waveform on the 32-second source took 86 ms and 128 range reads took 0.67 ms. Delivery used its existing encoder settings. The 12-second 1080p export took about 1.4–1.8 s cold and 34–60 ms with all segments available across the trials.

## First-cut dialogue

The inference fixture used 120 seconds from a 58-minute, 8.82 GB 4K interview. All model files were already installed. A local import on APFS became playable in 160 ms. Finishing the background SHA-256 took another 3.44 s. The ordinary 223-word transcript was available in 0.91 s with speaker labels 2.42 s later, compared with 0.94 s and 4.08 s previously.

| Local first-cut operation | Before | After |
| --- | ---: | ---: |
| First fully labeled page, cold analysis, paired runs | 6.23–6.47 s | 2.92–3.87 s |
| All three overlapping pages, cold analysis, paired runs | 9.00–9.25 s | 3.50–4.09 s |
| Worst interval on a 10 ms engine timer during the cold scan | 715–811 ms | 13–20 ms |
| Scene and activity inspection of a four-second source window | 1.31 / 1.37 s | 0.73 / 0.74 s |

Three additional optimized runs measured 3.08 s to the first labeled page, 3.68 s for all cold pages, 3.30 s with warm models and cleared pages, and 0.41 ms to reopen all three saved pages. All-page evidence hashes matched in the paired trials. During a packaged inference run, pausing reaped the detector process in 8 ms, saved zero incomplete pages, and a retry returned the expected acoustic hits.

The complete first-cut test used a 15.908-second generated basil lesson, an existing ChatGPT sign-in, the ordinary Scarlet agent host, and the same default Codex CLI and prompt. Only generated speech and a solid-color picture were supplied. Each build got one live provider trial.

| Seconds after queuing the brief | Baseline | First iteration | Final |
| --- | ---: | ---: | ---: |
| Dialogue scan started | 24.6 | 11.9 | 8.0 |
| Dialogue scan finished | 27.8 | 12.8 | 8.7 |
| Full source assembled | 27.8 | 16.5 | 12.3 |
| First cut ready for human review | 58.5 | 34.0 | 30.0 |
| Recommendation save requested | 74.5 | 43.4 | 39.5 |
| Agent task finished | 82.3 | 48.5 | 44.7 |
| Tool calls / failed calls | 17 / 1 | 17 / 1 | 15 / 0 |

Each proposal removed the repeated take and adjoining silence and kept both intended phrases. The final proposal removed source seconds 5.416–11.891 and left the decision with the editor. Both earlier runs tried to open the workflow by its exact name and had to recover. The final tool accepts the exact name or ID within the enabled workflows. Reading a proposal for a dialogue assessment also skips the unused timeline diff. Provider variance, concurrent working-tree changes, and the packaged baseline versus development engine and MCP in the later runs limit attribution of the end-to-end difference.

## Experiments and stopping point

- Changed the order of dialogue analysis so one acoustic window can run while recording-wide speaker matching completes. On a five-minute, six-page test, pipelining reduced completion from 13.56–14.19 s to 8.55–8.94 s. The first fully labeled page took about one second longer in that workload. The engine bounds queued work and checkpoints only complete evidence.
- Moved native Uhm inference into a cancellable child process. The engine can answer playback and edit requests while inference runs. Compared two, four and eight speaker threads. Four improved identification throughput while eight gained about 0.14 s per minute of audio for twice the thread budget. The CoreML experiment ran slower and changed probabilities. A separate 30-second Uhm inference test measured 27–43 ms to open the model session and 342–387 ms for the first inference. Per-page process isolation kept cancellation straightforward.
- Reused a bounded set of validated timeline snapshots and verified descending ripple deletions from the original ranges and resulting joins. Other layouts retain the general verifier. Tests compared partial selections against exhaustive replay on more than 21,000 eligible generated cases, including multi-camera edits, fractional frame rates and half-frame boundaries.
- Compared hardware and threaded H.264 decoding, with and without a concurrent real dialogue scan. Under contention, first playback from originals fell from 1.90 s to 1.21 s at the median and from 2.45 s to 1.40 s at p90. Scan p90 rose from 772 to 842 ms. Automatic threaded decoding is limited to Apple Silicon Macs with at least 16 available logical cores.
- Tried software preview encoding. With concurrent scanning, proxy-fed playback p90 rose from 823 to 872 ms and median dialogue-page latency rose from 649 to 794 ms. Kept hardware encoding. The delivery control and sub-3 ms library query provided little leverage in these tests. In the final live run, the 14.7 seconds after the reviewable proposal included second-pass inspection, the recommendation and the agent’s summary.
- Compared preview and original source clocks before reusing cached pictures. Confirmed matching decoded frames, timestamps and audio on the decoder experiment. VFR, alpha, ambiguous video streams, stale media and inadequate resolution use the original when the proxy cannot establish the same picture. Frame-accurate source inspection tools continue to request originals. On upgrade, preview segments and render files that may have used an older picture origin are revalidated or rebuilt on demand.

## Verification

The workspace build, TypeScript checks, and all 554 Vitest tests passed. The final packaged engine also passed the desktop smoke test with bundled media tools. It imported footage, rendered a captioned change, approved it, listed the agent tools, and shut down on stdin close. A separate three-run check on that final executable measured 13.19 ms for the single-camera 48-cut diff and 122.14 ms for caption generation.

## Reproduce

Run from the checkout with dependencies installed. The engine and renderer suites do not launch a window. To use the media tools shipped on this Mac, set the bin directory before running the benchmarks.

```sh
pnpm build
export SCARLET_BIN_DIR="/Applications/Scarlet.app/Contents/MacOS"
node apps/server/scripts/bench-editor.mjs 7 600 48 --media --tools
node apps/server/scripts/bench-editor.mjs 5 600 48 --layered
pnpm --filter @scarlet/web exec vitest bench --run bench/timeline.bench.tsx
pnpm --filter @scarlet/web exec vitest bench --run bench/activity.bench.tsx
NODE_ENV=production pnpm --filter @scarlet/web exec vitest bench --run bench/open-workspace.bench.tsx
pnpm exec tsx packages/render/bench/filmstrip.ts
node packages/render/bench/editor-media.mjs
```

The live editorial trial is opt-in. This command uses the signed-in macOS Codex CLI, creates its own synthetic footage, and consumes one hosted editing run.

```sh
node apps/server/scripts/bench-first-cut.mjs --live-codex
```

The editor script prints p50 and p95 for each stage. Set `SCARLET_BENCH_ENGINE` to the absolute path of a current packaged engine to include its real process startup and agent tool server. Add `SCARLET_BENCH_IMPORT=1` to the dialogue run to measure the initial full-file import and background fingerprint. The media script generates a synthetic 4K source by default. It also accepts a local H.264 recording. For local inference and contention, point `MODELS` at an existing Scarlet model cache. The scripts use disposable copies and prohibit model downloads.

```sh
MODELS="/path/to/local/models" node apps/server/scripts/bench-dialogue.mjs "/path/to/interview.mp4" 122 120 3
MODELS="/path/to/local/models" node apps/server/scripts/bench-preview-contention.mjs "/path/to/30-to-60-second-4k-excerpt.mp4"
```

## Second performance pass

The second pass compares against the first optimization commit, `2786882`. The mounted UI comparison uses `4e7ebd4` to hold the review layout constant. Production media tests used the Mac and bundled FFmpeg described above. The engine comparison alternated five pairs of independent Node 24.22.2 development engines per workload, using throwaway libraries and the same requests. These timings include response transfer and client JSON parsing.

| Editing operation | Before | After |
| --- | ---: | ---: |
| Open 24 separate caption corrections on a 600-shot timeline | 512.8 ms | 10.8 ms |
| Open 24 separate audio level corrections on that timeline | 67.4 ms | 12.6 ms |
| Reopen a previously previewed selection, two-camera timeline | 54.6 ms | 17.6 ms |
| Approve that selection | 63.0 ms | 11.2 ms |
| Apply a ripple cut to the same edit | 106.5 ms | 61.7 ms |
| Generate captions for the same edit, via the agent | 420.8 ms | 200.6 ms |
| Import a 2,400-shot Resolve timeline with metadata | 172 ms | 15 ms |
| Import that timeline with clip names and linked camera audio | 660 ms | 50 ms |
| Save a finished 128 MiB file to local disk | 49.4 ms | 22.2 ms |

Scarlet uses the saved before/after diff to identify independent, nonoverlapping edits to clip gain, opacity, caption text or caption style. Batches with ambiguous ownership still use the replay verifier. A seeded comparison produced identical full diffs in 1,500 cases and the same assignments as exhaustive replay in 194 eligible fractional-time caption batches. Another 7,000 partial selections on 1,000 eligible timelines matched direct application of the chosen edits. [Engine and native transfer trials](benchmarks/editor-second-pass-macos-arm64.json)

The two-camera timeline has 1,500 shots on each camera and 120 proposed removals. Restoring a cut now returns the draft alone, reducing the response from 2.80 MB to 0.96 MB. Approve can reuse the exact immutable version the editor previewed. The engine keeps up to 32 selection keys and checks that the corresponding stored version still exists. Initial workspace reads and opening the library showed no consistent improvement in this comparison. Seven more alternating pairs of packaged engines measured 49.5 versus 49.0 ms to engine ready, 59.8 versus 59.5 ms to connect the editing tools, and 119.9 versus 70.7 ms to generate captions for the single-camera fixture.

The Resolve import fixture includes 600 source assets. Scarlet indexes paths, clip IDs and names once, preserving the previous source-overlap and unused-clip tie breaks. The export-save measurement used eleven alternating transfers per build through the engine and a headless Reqwest/Tokio client matching the native save path. The saved files had identical SHA-256 hashes. Whole-file saves use 1 MiB blocks. A paused playback reader consumed 192 KiB of the source on both builds.

### Live interaction

| Mounted renderer workload | Before | After |
| --- | ---: | ---: |
| Drag to select 24 words in a 900-word transcript | 99.8–101.3 ms | 7.6–9.4 ms |
| Select the same words with Shift+Right | 106.4–106.8 ms | 7.1–8.6 ms |
| Ten background updates with the transcript open | 41.7–41.9 ms | 0.044–0.045 ms |
| Ten live task events with 300 edits in the workspace | 10.6–12.2 ms | 0.80–0.86 ms |
| Transcript page requests during a one-second scrub over an hour | 59 | 2 |

Each UI timing is a range of medians from two alternating comparisons in a headless DOM. The transcript limits selection updates to the affected paragraphs. It coalesces transient positions during a drag and loads the release position immediately. An open conversation still renders events belonging to that conversation. Searching 1,500 edits took about 0.2 ms per keystroke with the existing implementation.

### Transcript, captions and audio sync

The transcript fixture contains two hours of dialogue, 18,000 words, overlapping speech and 3,600 source clips including a synchronized muted camera. Five independent runs used the real engine routes, SQLite repository and an in-memory agent tool connection.

| Operation | Before | After |
| --- | ---: | ---: |
| Read the first minute of transcript | 9.46 ms | 4.96 ms |
| Read another minute | 7.30 ms | 0.46 ms |
| Search a phrase for the first time | 20.0 ms | 13.4 ms |
| Repeat a phrase search | 20.5 ms | 0.46 ms |
| Propose 2,528 captions | 250.1 ms | 107.6 ms |
| Sync separate audio over one hour | 191.7 ms | 141.8 ms |
| Deliver newly committed words to a waiting tool | 1,400 ms | 0.62 ms |

Search now transfers 5,731 bytes of matches and context instead of 1,721,482 bytes of transcript. A bounded cache reuses the stored document across pages, checks for rewrites and projects current voice roles. Caption generation groups audible source clips and matches words through overlaps. The audio-sync result kept the same 2.5-second offset. The handoff experiment timed the interval after a controlled transcription completed. It excludes recognition time.

### Video decoding and cache preparation

| Real media operation | Before | After |
| --- | ---: | ---: |
| Six scrub stills from a 90-second 4K recording while its proxy was in progress | 1,493 ms | 145 ms |
| First four seconds of edited playback from the same published checkpoint | 665 ms | 258 ms |
| Plan the segment cache for 900 shots and 4,000 project assets | 95.9 ms | 17.5 ms |
| Cold original JPEG at the start of a 58-minute 4K AVC recording | 214 ms | 114 ms |
| Cold original JPEG at 6.3 seconds on that recording | 450 ms | 346 ms |
| Cold 1080p delivery of six nearby shots from that recording | 1,998 ms | 919 ms |

The first complete 30-second proxy checkpoint was available after 1.47 s. The checkpoint trial alternated four pairs and compared real authenticated requests. The original-seek and nearby-delivery trial alternated five pairs. Scarlet can use the MP4 sample index for eligible picture-only reads. Audio retains normal stream discovery. The unrestricted experiment produced inconsistent audio output on a rotated fixture with an early audio stream. Nearby-frame decoding shares an input only for eligible, aligned AVC shots with a bounded gap, frame count, time span and output size. Picture and PCM tests compare decoded output. The shared audio/video playback control measured 1,407 versus 1,404 ms. Projects saved before Scarlet recorded relative stream clocks verify eligible source files on disk before sharing a decoder. A 150-frame legacy-fixture render matched the decoded pictures, PCM audio and timestamps. Three additional pairs on the final nearby-shot path measured 1,937 versus 867 ms.

### Reproduce the follow-up workloads

Build first. All the commands below run without opening Scarlet.

```sh
pnpm build
node apps/server/scripts/bench-editor.mjs 5 600 24 --properties
node apps/server/scripts/bench-editor.mjs 5 1500 120 --layered --tools
node packages/timeline/bench/otio.mjs 2400 600
node packages/mcp/bench/transcript.mjs 5 7200
node packages/render/bench/cache-plan.mjs
node apps/server/scripts/bench-file-delivery.mjs
pnpm --filter @scarlet/web exec vitest bench --run bench/transcript.bench.tsx bench/activity.bench.tsx
```

The file-delivery script is a portable Node client control for the engine's stream. It verifies each saved file's checksum.

For the media trials, pass a local camera excerpt to `node apps/server/scripts/bench-preview-checkpoints.mjs <excerpt.mp4>` and a long H.264/AAC recording to `node packages/render/bench/indexed-inputs.mjs <recording.mp4> --nearby`. Set `SCARLET_BIN_DIR` as in the first-pass instructions.

The final build and TypeScript checks passed, along with 567 JavaScript tests, 41 Rust tests, and the packaged-engine import, render and approval smoke test. A subsequent pass measured native macOS input-to-window latency. The Dell runner is available for the corresponding Windows measurements.
