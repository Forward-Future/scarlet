# Scarlet native playback benchmark for Windows

Extract the ZIP into a local folder on the Dell. Close Scarlet, open PowerShell in that folder, and run:

```powershell
.\Run-ScarletBenchmark.cmd
```

Use Windows x64 with WebView2, installed Scarlet and its bundled FFmpeg, Node.js 24 x64, Python 3.11+, stable x64 MSVC Rust, and the Microsoft C++ build tools with the Windows SDK. Cargo may download its locked dependencies on the first build. Allow disk space for the build, one complete local copy of the chosen project’s media, and generated previews. A Scarlet checkout, SSH and admin privileges are unnecessary.

The archive contains matched renderer assets, engine bundles, and the Rust desktop shell. The baseline precedes this playback optimization pass. The runner verifies the manifest, builds both Windows variants, and confirms each loaded renderer and engine before sampling. It selects a UHD-or-larger timeline whose chosen version uses ready UHD video in a visible, enabled clip. It prints the exact timeline dimensions and pins that version for both runs. Each trial works on a separate disposable copy, on an unselected native desktop, with a new WebView2 profile and verified process-level mute.

Each phase schedules 64 stratified seeks with a 12-second deadline, up to 24 stratified real timeline joins, and sustained playback at two positions when the recording is long enough. Four interleaved batches distribute seeks, joins and sustained playback across the cache job. The runner compares the current fixture, active proxy generation, and the completed proxy. The cache target for the latter two phases is the largest UHD recording used by the selected cut.

If caching finishes early, the raw report retains the crossing batch. A sample qualifies as under load only if the cache job was confirmed running after that sample ended. The paired summary uses the same qualified targets in both builds. It withholds scrub p95 below 40 matched attempts and join p95 below 12 observed crossings. Use the output’s attempt counts, censored timeouts, and compositor pixel checks when interpreting results.

Results are written to a new `scarlet-results-*` folder in the current directory. It contains raw measurements, summaries and executable provenance. Share that results folder to review the Dell measurements.

- Run `.\Run-ScarletBenchmark.cmd --preflight` to check tools, storage and project eligibility.
- Run `.\Run-ScarletBenchmark.cmd --quick --stages during` for an eight-seek, two-join diagnostic.
- Pass `--library "D:\Scarlet\data" --project-id prj_...` to select a project. `--version dense` picks its densest qualifying historical cut.
- Pass `--allow-hd-timeline` to explicitly allow a lower-resolution timeline that uses UHD footage. UHD timelines still take priority.
- Pass `--sidecars "C:\path\to\Scarlet"` for a nonstandard FFmpeg installation, or use `--help` for the other options.
