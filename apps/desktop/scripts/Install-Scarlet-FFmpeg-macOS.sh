#!/bin/bash
# Install the two upstream media tools Scarlet uses.
set -euo pipefail

case "$(uname -m)" in
    arm64)
        build=arm64/1789931890_9.0.2
        ffmpeg_sha=c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924
        ffprobe_sha=fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6
        ;;
    x86_64)
        build=amd64/1789931006_9.0.2
        ffmpeg_sha=7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4
        ffprobe_sha=2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd
        ;;
    *)
        printf '%s\n' 'This helper supports Apple Silicon and Intel Macs.' >&2
        exit 1
        ;;
esac

dest="$HOME/.local/bin"
if [[ -x "$dest/ffmpeg" && -x "$dest/ffprobe" ]]; then
    printf 'Using the existing FFmpeg and FFprobe in %s.\n' "$dest"
    exit 0
fi
for name in ffmpeg ffprobe; do
    if [[ -e "$dest/$name" || -L "$dest/$name" ]]; then
        printf 'Move the existing %s to another location before running this helper again.\n' "$dest/$name" >&2
        exit 1
    fi
done

work="$(mktemp -d "${TMPDIR:-/tmp}/scarlet-media.XXXXXX")"
trap 'rm -rf "$work"' EXIT
cd "$work"

fetch_tool() {
    local name="$1"
    local digest="$2"
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --retry 2 \
        "https://ffmpeg.martin-riedl.de/download/macos/$build/$name.zip" -o "$name.zip"
    printf '%s  %s\n' "$digest" "$name.zip" | shasum -a 256 -c -
    unzip -p "$name.zip" "$name" > "$name"
    chmod 755 "$name"
    "./$name" -version >/dev/null
}

fetch_tool ffmpeg "$ffmpeg_sha"
fetch_tool ffprobe "$ffprobe_sha"
mkdir -p "$dest"
install -m 755 ffmpeg ffprobe "$dest/"
printf 'Installed FFmpeg and FFprobe in %s. Restart the editor to use them.\n' "$dest"
