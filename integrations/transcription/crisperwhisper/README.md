# CrisperWhisper 2.0 large

Scarlet runs a locally installed CrisperWhisper checkpoint through PyTorch. On Apple silicon, the adapter tries the Metal GPU through PyTorch MPS and uses the CPU when acceleration is unavailable. Setup downloads Python libraries and uses the checkpoint you supply. During transcription the adapter runs offline.

## Install

Use 64-bit CPython 3.12 with the standard venv module. Obtain a complete copy of the linked revision under terms that cover your use, including its configuration, tokenizer, model file, README and licence. Nyra licenses its inference code under MIT. Its separate licence covers the weights and their outputs, and commercial use requires a commercial licence. [Official model snapshot](https://huggingface.co/nyralabs/CrisperWhisper2.0_large/tree/f4334f6e8193f2691212d49b20fa12d370e13896) · [Model and output licence](https://huggingface.co/nyralabs/CrisperWhisper2.0_large/blob/f4334f6e8193f2691212d49b20fa12d370e13896/LICENSE.md)

In the desktop app, open **App Settings → General**, select CrisperWhisper and choose **Install from folder…** in its setup section. Pick the folder containing your local checkpoint.

For command-line setup on Apple silicon with macOS 14 or later or on Ubuntu 24.04 x86-64, run this command from this directory. On Ubuntu, install `python3.12-venv` first.

```sh
python3.12 install.py --model "/path/to/local/model-snapshot"
```

On Windows, run the following command from this directory.

```powershell
py -3.12 install.py --model "D:\Models\CrisperWhisper2.0_large"
```

The pinned PyTorch wheel requires macOS 14 or later on Apple silicon. On Intel Macs and macOS 13, use Scarlet’s bundled Whisper or a custom local model.

Add `--data-dir "/path/to/Scarlet/data"` for a custom library. By default the installer uses `~/Library/Application Support/com.forwardfuture.scarlet/data` on macOS and `%APPDATA%\com.forwardfuture.scarlet\data` on Windows. On Linux it uses `$XDG_DATA_HOME/com.forwardfuture.scarlet/data`, defaulting to `~/.local/share/com.forwardfuture.scarlet/data`. It verifies the local model files against the pinned SHA-256 manifest, installs the versions in `requirements.txt` in a dedicated environment, and selects the Windows CPU wheel automatically.

Desktop releases include the adapter used for new transcriptions. Updating Scarlet reuses your installed checkpoint and Python environment. Run the setup command again to repair an installation or update its standalone adapter. A different checkpoint at the destination is left in place with an error identifying the file. The editor can select CrisperWhisper in Scarlet’s local transcription settings once setup completes.

## Engine interface

The dedicated runtime lives in `models/crisperwhisper` under the library. Scarlet launches `venv/bin/python` (Windows `venv\Scripts\python.exe`) with `-I -B crisper_cli.py --serve -m model/model.safetensors -t THREADS` and keeps it running between requests, so the model loads once rather than for every window. Each request is one JSON line on stdin, `{"id", "wav", "out", "language", "progress"}`; the adapter writes `out.json` in whisper.cpp's JSON format and answers with one JSON line on stdout, `{"id", "ok": true}` or `{"id", "error"}`. Everything else it prints goes to stderr. A request that fails ends the worker, and Scarlet stops an idle one after a minute. Without `--serve`, the adapter takes the same arguments as Scarlet's whisper.cpp provider and reads one file per run, which Scarlet falls back to for a standalone adapter installed before `--serve` existed.

On macOS, desktop, development and benchmark workers share a memory budget across libraries. Each decoder claims a slot before importing PyTorch. New workers wait when all slots are in use, macOS reports memory pressure, or there is too little headroom for the model. Macs with too little installed memory for this model can use bundled Whisper. Each worker holds its slot until it exits, and gives back what a decode left in the GPU's cache after every request.

The adapter does not read long quiet. A stretch of 2 s or more under -60 dBFS, the level under which Scarlet drops any line as unheard, is shortened to half a second beside the sound on either side before the model hears it, and the words' times are put back on the recording's clock. On a gated microphone track, whose silence is digital zeros, the model otherwise read each silent half-minute as the last sentence said again, to its token limit. Audio that is quiet throughout is not read at all.

The adapter maps Scarlet’s example-style dialogue prompt to CrisperWhisper’s native verbatim mode. It writes spoken hesitations and false starts as words, omits acoustic event labels, and preserves the model’s attention timestamps. A spoken word present in the full text but absent from the timing stream receives an interpolated interval marked `timing_source: interpolated` in the adapter JSON. If a clip ends abruptly, a decoded suffix with zero audio remaining is omitted. Automatic language selection uses the checkpoint’s language detector on the opening audio. Scarlet can refine the resulting word times in its alignment stage.
