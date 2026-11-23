# Assistant installer scripts

Scarlet installs Claude Code, Codex and Gemini (Antigravity) with these copies of their official installer scripts.
It never runs a script it just downloaded. At install time it checks each copy against the SHA-256 pinned in
`src/host/install.rs` and refuses to run one that doesn't match. Each script downloads its program over HTTPS and
checks the program's own checksum before installing it.

| File | Official source |
| --- | --- |
| `claude.sh` / `claude.ps1` | `https://claude.ai/install.sh` / `.ps1` |
| `codex.sh` / `codex.ps1` | `https://chatgpt.com/codex/install.sh` / `.ps1` |
| `gemini.sh` / `gemini.ps1` | `https://antigravity.google/cli/install.sh` / `.ps1` |

## Updating a script

1. Download the new copy over the old one, for example `curl -fsSL https://claude.ai/install.sh -o claude.sh`.
2. Read the diff (`git diff -- .`). Check that it only downloads from the vendor's own hosts and still verifies a
   checksum before installing.
3. Put the new `shasum -a 256 <file>` value in `src/host/install.rs`.
4. Run `cargo test host::install` to confirm the pins match.

`.gitattributes` keeps these files byte-for-byte as downloaded (no line-ending changes), so the pins hold on every OS.
