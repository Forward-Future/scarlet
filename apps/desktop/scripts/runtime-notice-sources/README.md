# Sources for runtime notices

The release collector uses files from the installed package when available. These files supply texts missing from the published archives and notices for the separately linked speech libraries.

| File | Upstream source |
| --- | --- |
| alloc-stdlib.txt | [Dropbox allocator at its published crate revision](https://github.com/dropbox/rust-alloc-no-stdlib/blob/0a81fd6928ea3b33c8cd484aa4575d50ffb98012/LICENSE) |
| webview2-rs.txt | [WebView2 Rust bindings at their published crate revision](https://github.com/wravery/webview2-rs/blob/edc2caf886175ccaebe86078c9cfe1ae2a187328/LICENSE) |
| objc2.md and objc2-MIT.txt | [Upstream licensing for the published bindings](https://github.com/madsmtm/objc2/blob/7b1abfd750a2cacaea71d6a56ecfb83cb7de560b/LICENSE.md) and [the authors’ full MIT text](https://github.com/madsmtm/objc2/blob/ee9a7ada2131f5944b8750428e265c15632f2a19/LICENSE-MIT.txt) |
| MPL-2.0.txt | [MPL text](https://github.com/spdx/license-list-data/blob/v3.27.0/text/MPL-2.0.txt) for [Servo selectors](https://github.com/servo/stylo/blob/572ecba2d1600e7c3d490586692a209faf703baa/selectors/lib.rs). The generated index links to each crate's exact source archive. |
| onnxruntime-1.28.2-third-party.txt | [ONNX Runtime 1.28.2 notices](https://github.com/microsoft/onnxruntime/blob/v1.28.2/ThirdPartyNotices.txt) for sherpa's CPU runtime. The Uhm and Windows GPU runtimes use the separate 1.22.0 notices in the app's licenses directory. |
| sherpa-dependencies.txt | [sherpa-onnx v2.0.1 native dependencies](https://github.com/k2-fsa/sherpa-onnx/tree/v2.0.1/cmake). The file names the pinned releases and includes each project's license text. |
| whisper-audio-dependencies.txt | [Audio decoders built into the pinned whisper.cpp CLI](https://github.com/ggml-org/whisper.cpp/blob/d1be6fde11ac6e0407606b4e42fe72d34add8037/examples/common-whisper.cpp). The file reproduces the licensing blocks from miniaudio and stb_vorbis. |
