# Transcription models

Choose a model in **App Settings → General → Transcribe speech with**. The selection applies to new transcriptions, including imports, dialogue analysis and voice notes. Opening an existing project keeps its saved transcript.

In **Media**, hover over the circular arrow beside **Transcribed**, or focus it with Tab, to see when that recording’s last successful transcription finished and which model produced it. Click the arrow to re-transcribe the original recording with your current settings.

**CrisperWhisper 2.0 large** is the default local choice. Its verbatim mode keeps fillers, false starts and repeated takes. Scarlet looks for an installed copy in its data directory. Until you install it, Scarlet uses the bundled Whisper runtime and shows which model is active in Settings. You can also select bundled Whisper explicitly.

The CrisperWhisper installer supports Apple silicon on macOS 14 or later and 64-bit Windows. Install 64-bit Python 3.12 and obtain a copy of the checkpoint you have permission to use. In the CrisperWhisper setup section in General, choose **Install from folder…** and select the folder containing the checkpoint. Scarlet verifies the model files and installs the Python runtime dependencies. Command-line setup is also available. CrisperWhisper’s published terms allow noncommercial research. Commercial use of its weights or generated transcripts requires a separate license from nyra health. [Setup instructions](../integrations/transcription/crisperwhisper/README.md) · [Model license](https://huggingface.co/nyralabs/CrisperWhisper2.0_large/blob/main/LICENSE.md)

## Use your own local model

Select **Custom local model** in General, then open its configuration. For a whisper.cpp GGML model, select the model file and use Scarlet’s bundled executable. For another runtime, select a local adapter executable. Supply a model file if the adapter expects one. An adapter that locates its own weights can use the executable field alone. On Windows, choose a native executable such as an .exe. Choose an executable you trust with the audio you transcribe. Scarlet launches it directly on your computer.

For example, to use an unquantized Whisper large-v3 GGML checkpoint, point the model field at your local `ggml-large-v3.bin`. A NeMo or Transformers checkpoint needs an executable that loads it and returns timed words in the format below. The CrisperWhisper adapter in this repository is a working example. [Adapter source](../integrations/transcription/crisperwhisper/crisper_cli.py)

### Adapter interface

Scarlet decodes each input to mono, 16 kHz PCM WAV. It starts the executable with individual arguments. Paths may contain spaces. A typical invocation is shown below.

```text
my-adapter -m MODEL_FILE -f INPUT.wav -ojf -of OUTPUT_PREFIX -np -l auto -t 8 -mc 0 -pp
```

- Read the WAV from `-f`. When the editor selects a checkpoint or configuration file, Scarlet passes it in `-m`. An explicitly selected custom adapter with an empty model field receives no `-m` argument. A runtime that owns several files can use the selected model file to locate its siblings.
- Honor the language in `-l` or detect it when the value is `auto`. The thread count in `-t` depends on the machine.
- Full transcriptions include `-mc 0`. A dialogue re-read can instead include `--prompt TEXT`. Produce the words actually spoken in the supplied clip.
- Write UTF-8 JSON to `OUTPUT_PREFIX.json` and exit successfully only after the file is complete. With `-pp`, you can report `progress = 40%` on stderr. Exit with a nonzero status on failure and stop inference if Scarlet cancels the process.
- Set the optional `result.model` string to the display name of the model that produced the words. This lets Media identify the model even when the adapter manages its own weights.
- Return segment and word offsets in **milliseconds from the beginning of this WAV**, including for short dialogue windows. Give each complete word a leading space in `tokens[].text`. A token with no leading space continues the previous word. Punctuation can stay on its word, and `p` is optional when the runtime has a confidence estimate.
- Keep each repeated word and spoken filler as its own timed token. Use plain `uh` and `um` for speech. An input with no speech can return an empty `transcription` array.

For synthetic audio in which someone says “I, I agree,” the adapter can return the following JSON.

```json
{
  "result": { "language": "en" },
  "transcription": [
    {
      "text": "I, I agree.",
      "offsets": { "from": 120, "to": 1040 },
      "tokens": [
        { "text": " I,", "offsets": { "from": 120, "to": 230 } },
        { "text": " I", "offsets": { "from": 380, "to": 470 } },
        { "text": " agree.", "offsets": { "from": 510, "to": 1040 } }
      ]
    }
  ]
}
```

Scarlet uses those times for editing and can refine English word boundaries with its local acoustic aligner. New local transcripts record which model option produced them.
