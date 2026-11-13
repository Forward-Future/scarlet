# macOS native playback benchmark

Run this from a built Scarlet checkout with installed JavaScript dependencies and the macOS command-line tools. Use an empty directory under `/tmp` for the native shell and a fresh disposable library clone for each trial. The fixture preparer reads the selected version and copies its local media.

```sh
h=apps/desktop/scripts/native-playback
bench_root=$(mktemp -d /tmp/scarlet-native.XXXXXX)
scratch="$bench_root/shell"
trial="$bench_root/trial"
node apps/server/scripts/prepare-playback-fixture.mjs --library "$source_library" --project "$project_id" --version "$version" --cache none --out "$trial"
python3 "$h/macos.py" prepare "$scratch"
python3 "$h/macos.py" start "$scratch" "$trial/data" "$project_id" &
native_driver=$!
```

Wait for `$scratch/ready.json`. The driver uses `pnpm desktop:dev` in a disposable checkout, checks for another native preview before launching, and starts with activation prohibited and its window hidden. It then places that same non-key, mouse-transparent window below the wallpaper to obtain a drawable WebKit surface. It mutes only the private WebView. Native input goes directly to that view. `--ordered-out` reproduces the case where WebKit suppresses its presentation callbacks entirely.

For a pressure trial, start the private engine sampler and wait until its JSONL confirms an active source encoder. Use `--mode idle` for the matched control. Window pixel capture uses ScreenCaptureKit for the single benchmark window after checking existing capture permission. On a machine without permission, the capture command exits without prompting.

```sh
node apps/server/scripts/bench-playback-cache-load.mjs --fixture "$trial" --ready "$scratch/ready.json" --mode pressure --seconds 1800 &
cache_sampler=$!
python3 "$h/macos.py" capture "$scratch" "$trial/window-samples.txt" &
pixel_sampler=$!
python3 "$h/macos-trial.py" "$scratch" "$trial/manifest.json" --output "$trial/suite"
kill -TERM "$pixel_sampler"
wait "$pixel_sampler"
touch "$trial/stop-cache-monitor"
wait "$cache_sampler"
python3 "$h/verify-pixels.py" "$trial" "$scratch/ready.json"
node "$h/summarize.mjs" "$trial/suite/combined.json"
python3 "$h/macos.py" stop "$scratch"
wait "$native_driver"
```

The trial records 64 seeded seeks, up to 24 genuine edit boundaries and two 12-second playback windows. Each raw group and the combined report are written to `suite`. To resume an interrupted command in the same running private window, add `--resume`. For a matched second run, clone from the same fixture, point `prepare --repo` and `start --engine` at the implementation being tested, then pass `--match /path/to/baseline/suite` to the trial runner. This reuses the exact measurement script, input order and deadlines.

The rVFC measurement requires the requested frame PTS. When WebKit's media timestamp clock differs from its DOM clock, the report uses callback arrival for latency and preserves native display-time differences for consecutive cut frames. Double-rAF estimates describe browser paints. The independent 30 Hz window capture compares a 20 × 12 interior RGB grid to the exact composed JPEG after the timed run. It reports a match only when the mean channel error is at most 13/255 and the prior picture was at least five levels worse. Similar or unchanged pictures can remain ambiguous. Read the number of matches, timeouts and missed inputs alongside the percentiles. Keep the sample grids and fixture library private.

Pixel verification also writes `post-start-stalls.json`. It pairs waits after the first presented frame with the next playback event, tests whether media time advanced, and checks the captured window pixels during the hold. An open wait is reported as a lower bound. Distance to the nearest genuine saved cut uses the fixture's full cut list. After both runs, `python3 "$h/compare-macos.py" "$before_trial" "$after_trial"` compares only positions with native presentation evidence in both arms and writes `native-pair-summary.json`.
