#!/bin/bash
set -euo pipefail

# Import into a runner-only keychain so the native add-ons can be signed before
# Tauri copies them into Resources and seals the application.
for var in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
  [[ -n "${!var:-}" ]] || { echo "::error::Set $var in the release environment to publish macOS installers."; exit 1; }
done
[[ "$APPLE_SIGNING_IDENTITY" == "Developer ID Application: "* ]] || { echo "::error::A Developer ID Application identity is required."; exit 1; }
work=$(mktemp -d)
keychain="$work/release.keychain-db"
keypass=$(openssl rand -hex 32)
previous=()
while IFS= read -r line; do previous+=("$line"); done < <(security list-keychains -d user | sed -E 's/^[[:space:]]*"//;s/"$//')
cleanup() {
  security list-keychains -d user -s "${previous[@]}" || true
  security delete-keychain "$keychain" || true
  rm -rf "$work"
}
trap cleanup EXIT
security create-keychain -p "$keypass" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keypass" "$keychain"
printf '%s' "$APPLE_CERTIFICATE" | /usr/bin/base64 -D > "$work/certificate.p12"
security import "$work/certificate.p12" -k "$keychain" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple: -s -k "$keypass" "$keychain"
security list-keychains -d user -s "$keychain" "${previous[@]}"
unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD

# Tauri signs its declared sidecars. ONNX add-ons and dynamic libraries are
# resources, so they also need our Developer ID for Apple notarization.
while IFS= read -r -d '' binary; do
  codesign --force --timestamp --options runtime --sign "$APPLE_SIGNING_IDENTITY" "$binary"
done < <(find apps/desktop/src-tauri/binaries/{speaker-runtime,uhm-runtime} -type f \( -name '*.dylib' -o -name '*.node' \) -print0)

pnpm --filter @scarlet/desktop exec tauri bundle --target "$1" --bundles app,dmg
app="$BUNDLE/macos/Scarlet.app"
codesign --verify --deep --strict --verbose=2 "$app"
codesign --verify -R="anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"$APPLE_TEAM_ID\"" "$app"
xcrun stapler validate "$app"
spctl --assess --type execute --verbose=2 "$app"

images=("$BUNDLE"/dmg/*.dmg)
[[ ${#images[@]} -eq 1 && -f "${images[0]}" ]]
dmg="${images[0]}"
codesign --verify --strict -R="anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists" "$dmg"
xcrun notarytool submit "$dmg" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
