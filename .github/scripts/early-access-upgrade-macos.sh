#!/usr/bin/env bash
set -euo pipefail

previous=$1
candidate=$2
version=$3
driver="$(cd "$(dirname "$0")/../../apps/desktop/scripts" && pwd)/early-access-upgrade-library.mjs"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/scarlet-ea-upgrade.XXXXXXXX")
mountpoint="$scratch/image"
installed="$scratch/Applications/Scarlet Early Access.app"
mounted=false
cleanup() {
  if "$mounted"; then hdiutil detach "$mountpoint" || return 1; fi
  rm -rf "$scratch"
}
trap cleanup EXIT
mkdir -p "$mountpoint" "$scratch/Applications" "$scratch/profile"

install_copy() {
  local image=$1 expected=$2
  hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$mountpoint" "$image"
  mounted=true
  local app="$mountpoint/Scarlet Early Access.app"
  local plist="$app/Contents/Info.plist"
  [[ $(plutil -extract CFBundleIdentifier raw -o - "$plist") == com.forwardfuture.scarlet.earlyaccess ]]
  [[ $(plutil -extract CFBundleShortVersionString raw -o - "$plist") == "$expected" ]]
  [[ $(plutil -extract CFBundleVersion raw -o - "$plist") == "$expected" ]]
  rm -rf "$installed"
  ditto "$app" "$installed"
  hdiutil detach "$mountpoint"
  mounted=false
}

install_copy "$previous" 0.1.3
HOME="$scratch/profile" node "$driver" seed "$installed/Contents/MacOS/scarlet-engine" "$scratch/expected.json"
install_copy "$candidate" "$version"
HOME="$scratch/profile" node "$driver" verify "$installed/Contents/MacOS/scarlet-engine" "$scratch/expected.json"
