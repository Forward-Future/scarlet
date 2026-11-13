# Native 4K playback benchmarks

The workload exercises the normal Scarlet monitor and timeline slider. The app opens a private copy of a saved project. Seeks are distributed across the full edit in a fixed shuffled order. The rerun uses the same coordinates, edit boundaries, timeouts, media and initial cache state. All benchmark writes and cache generation take place in the disposable copy. Each project and load condition was measured as a matched session on one Mac. Operating-system load and how much caching finishes before each seek can vary.

## What the measurements mean

- **Scrub latency** starts when the timeline slider receives pointer-up. For a video seek, the first matching presentation timestamp has to reach the native video compositor. On this Mac, WebKit's compositor timestamps and the input clock had different origins, so latency uses the callback's arrival and cut gaps use differences between compositor timestamps. [Video frame callback specification](https://wicg.github.io/video-rvfc/)
- **Still-image latency** uses the selected edit's exact frame index, decoded image and opacity across two animation callbacks. This is a paint estimate. A separate 30 fps ScreenCaptureKit stream samples only the benchmark window. For visually distinguishable transitions, matching the sampled pixels against the requested composite independently measures when the picture appeared in that window. A stationary or nearly identical picture may not produce an identifiable transition.
- **Cut stalls** measure the extra time over one nominal frame between consecutive compositor submissions straddling a saved edit boundary. Missing callbacks and windows that never reach the cut are counted separately. Startup delays, pauses elsewhere in the window and end-of-window timeouts are also retained.
- **Dropped frames** come from changes in the native video's total and dropped counters over each playback window. Waiting for a missing fragment can freeze a picture without incrementing the dropped counter. [Media Playback Quality specification](https://w3c.github.io/media-playback-quality/)
- **P95** uses the nearest rank across the scheduled seeks. A timed-out seek contributes a lower bound at its deadline. The results distinguish a measured quantile from one bounded by timeouts. The interval starts at the native slider event and ends on the application window. Physical panel scan-out and input-device latency are unmeasured.

## Projects and load

The two macOS fixtures are separate 3840×2160 timelines at 30000/1001 fps on the M5 Max. Both use real, 58-minute 4K AVC camera recordings with keyframes about 8.34 seconds apart. The complex 28-minute edit was the saved head of a local episode-review QA library. It already contained 268 video clips across six video tracks, 203 audio clips and five captions on a 4K canvas. Its saved playback cache setting is 360p. The 58-minute edit contains four video clips and uses a 720p cache. Its fixture came from an authorized, isolated copy of a saved project in the regular library’s Trash. The monitor uses the project's normal preview resolution and can request a more detailed composited still for a paused seek.

The Mac uses a frozen checkout in Scarlet’s native Tauri window with the development renderer, WKWebView and bundled FFmpeg 9.0.2. The window is muted and ordered below the wallpaper. It cannot become key or main. The measurement uses trusted events addressed to its WKWebView without moving the mouse or keyboard focus. An initial fully hidden calibration decoded video but produced no display callbacks and was excluded. During the loaded runs, the engine builds source proxies and a full-cut preview in the disposable library. Cache state, encoder activity and progress are sampled independently of the video.

## Complex 4K edit with caching active

| Native measurement | Before | After |
| --- | ---: | ---: |
| P95 input to matching WindowServer pixels on the same 49 visually distinguishable targets | 7.55 s | 4.25 s |
| P95 target-frame observation on 48 matched seeks with 12 s deadlines | 10.11 s | 4.23 s |
| Median target-frame observation over all 64 seeks | 4.77 s | 2.31 s |
| Seeks that missed the deadline | 4 of 64 | 0 of 64 |
| Longest completed stationary playback wait after the first frame | 4.85 s | 2.76 s |
| Total completed stationary wait time across playback windows | 20.20 s | 12.07 s |
| Play to first observed video frame, P95 | 5.42 s | 5.64 s |
| Dropped frames in the 24 cut windows | 27 / 1,572 (1.72%) | 25 / 1,736 (1.44%) |

The first 16 matched seeks had 5.5 s deadlines and the remaining 48 had 12 s deadlines. Four early baseline seeks timed out. The pooled baseline P95 is therefore at least 8.74 s, versus 4.23 s after. The three slowest baseline positions from the fully observed 48-seek group improved from 10.81, 10.20 and 10.11 s to 2.23, 2.71 and 3.10 s. The separate pixel comparison above includes only targets distinguishable in both sets of captured windows, with about 33 ms of sampling uncertainty. On 38 matched targets where the composed still won on both builds and was independently identified in both window captures, native pixel P95 fell from 8.75 to 4.25 s.

Cache readiness affected the comparison. Of 49 targets still cold in both runs, 45 completed before the original deadline, with a median of 5.19 s. All 49 completed after the changes, with a median of 2.54 s. Five targets already prepared in both runs took 76 versus 110 ms at the median. Ten targets had finished caching before the baseline sought them, but remained cold when the faster rerun reached them.

Twenty of 24 baseline windows and 19 of 24 candidate windows crossed their saved boundary. Sixteen versus eleven crossings had consecutive compositor callbacks on both sides. Those frame gaps were 32–34 ms with either build. Checking the stationary media clock and actual window pixels also found freezes adjacent to cuts. Three completed baseline waits and one still-open wait began within 150 ms of a saved cut. The longest closed near-cut wait lasted 3.95 s. No corresponding near-cut stationary wait was observed in the candidate. Across all windows there were seven versus six completed stationary waits and one open wait on each build. The open waits lasted at least 1.17 versus 0.22 s.

Seventeen versus sixteen of the 24 cut windows finished before their deadlines. Two sustained windows recorded zero drops on both builds (798 and 866 total frames). Both sustained windows finished on the baseline, and one finished on the candidate. Pressing Play immediately after the requested still appears can initiate playback sooner in wall time on the faster build and give fragment preparation less of a head start. These trials establish a scrub improvement and shorter observed freezes. They leave cold playback startup as an open performance issue.

With cache workers idle on this same edit, we repeated ten matched seeks after the final tooltip correction. All ten improved. P95 for the selected still’s paint estimate fell from 2.50 to 0.72 s, and the median fell from 1.64 to 0.44 s. Window capture independently identified five of the ten final pictures before the next gesture. The ten baseline seeks predated window capture.

## Two-camera 4K edit with idle cache workers

All 32 matched seeks improved. P95 target-frame observation fell from 1.25 s to 0.60 s. For the 29 targets with distinguishable matching window pixels in both builds, native P95 fell from 1.27 s to 0.64 s and median latency fell from 0.83 s to 0.42 s. All three actual edit boundaries were exercised four times. All twelve windows crossed their boundary and finished on both builds, with no stationary post-start wait. Cut-window dropped counts were 1 / 1,940 before and 5 / 1,800 after. Sustained windows recorded zero drops. Play-to-first-frame P95 was 1.17 versus 1.53 s.

[Anonymized native trial samples and matched pixel comparisons](benchmarks/native-playback-macos-arm64.json) and [cache overlap by seek ordinal](benchmarks/native-cache-coverage-macos-arm64.json) retain the sample counts and censored results.

## Changes tested

On pointer release or exit Scarlet aborts an unfinished tooltip frame request, freeing its decoder for the selected monitor picture. A tooltip also hides its previous picture when the pointer moves to a different frame. If the edit's segmented player has no buffered footage at that position, the monitor asks for the exact still immediately. A seek into buffered video or a completed local preview retains its opportunity to deliver the native video frame first.

Older recordings can lack the stream clock metadata acquired by newer imports. The renderer verifies a compatible AVC stream against the on-disk file before using its MP4 sample index for a picture-only seek. Probe results are keyed to the file's identity and timestamps. Ambiguous streams, unsupported clocks and incompatible formats use normal discovery. The full composition, overlays, captions and selected frame remain part of the comparison.

A separate decoder experiment on the same three-layer picture reduced cold frame time from 3,954 to 3,192 ms under active caching and produced the same decoded YUV hash. Lowering the software decoder thread count and forcing VideoToolbox failed to beat automatic decoding consistently. A child-process priority experiment also produced mixed results across two cold targets. The matched native rerun used normal process priority. [Decoder experiments and parity checks](benchmarks/native-render-experiments-macos-arm64.json)

### Cold playback startup

Five particularly slow joins from the complex edit were selected for a follow-up. Both variants included the scrub improvements above. The experimental variant also used the MP4 picture index when a playback fragment read its audio from a separate input. All five joins were cold at pointer release in both variants, with source caching active throughout.

| Median across the five joins | Scrub changes | With experimental fragment change |
| --- | ---: | ---: |
| Release to first paused picture | 1.98 s | 3.28 s |
| Play to first playing frame | 5.65 s | 3.37 s |
| Release to first playing frame, including the paused picture | 7.64 s | 6.85 s |
| Windows that reached the scheduled playback endpoint | 0 of 5 | 4 of 5 |

Playback started sooner at all five joins, while the paused picture took longer at all five. Ten corresponding finished playback fragments had identical decoded audio samples and sample timestamps. This set covered all five primer fragments and the fragment following four boundaries. For the remaining post-boundary range, all 113 pictures, their timestamps and 180,981 stereo samples matched before encoding. [Playback experiment and audio checks](benchmarks/native-mixed-fragments-macos-arm64.json)

The deciding test used 40 paused seeks on fresh copies under load. The schedule was fixed before either run and included four previously slow positions. The experimental fragment change moved P95 from 5.06 to 4.89 s and increased the median from 2.31 to 3.12 s. It slowed 29 of 40 seeks. On the 37 positions where the same target still could be identified in both native window captures, pixel P95 worsened from 5.29 to 5.85 s and the median rose from 2.38 to 3.16 s. Of the 40 targets, 39 were still cold when reached in both runs. All five targets that reopened a camera multiple times were slower with the experiment. We kept the original fragment renderer. The main before-and-after tables and the Windows candidate use that renderer with the scrub improvements.

## Windows

Build the benchmark runner with the [packaging script](../apps/desktop/scripts/native-playback/package-windows.py). Point `--baseline-web` at the baseline checkout’s `apps/web` directory, `--baseline-engine-root` at its built workspace, and `--output` at a new ZIP file. The script uses the current checkout as the candidate. Extract the ZIP on Windows and run these commands in PowerShell from that folder.

```powershell
.\Run-ScarletBenchmark.cmd --preflight
.\Run-ScarletBenchmark.cmd
```

The runner builds the two isolated native test shells using local Windows build tools, uses a never-selected desktop and disposable WebView2 profile, and verifies the mute flag on the running WebView2 process. It selects a UHD timeline with a referenced recording independently verified as UHD. Each phase schedules 64 seeks, up to 24 real joins and two sustained playback windows when the material is long enough. A loaded scrub P95 requires at least 40 matching seeks with verified cache activity in both variants.

The runner’s results folder contains the timings, cache state and executable fingerprints. [Windows prerequisites and options](../apps/desktop/scripts/native-playback/WINDOWS.md)

The Mac harness and the commands to reproduce the isolated workload are in the [macOS runner instructions](../apps/desktop/scripts/native-playback/MACOS.md).

## Validation

The isolated publication checkout built, typechecked and passed all 567 JavaScript tests and 41 Rust tests. Its packaged engine ingested footage, rendered a captioned change, approved it and served its editing tools in the headless smoke test. A separate working-directory run with concurrent review and composer changes reported 23 UI failures. All 23 reproduced after removing the two scrub UI changes.
