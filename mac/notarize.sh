#!/usr/bin/env bash
# Sends the signed app to Apple to be notarized, staples the ticket to it, and rebuilds the release zip so it opens
# on any Mac with no prompt. Run after `build.sh --release` with a Developer ID identity.
#   APPLE_API_KEY_PATH   path to the App Store Connect API key (.p8)
#   APPLE_API_KEY_ID     its key id
#   APPLE_API_ISSUER_ID  the issuer id (a UUID)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
app="$here/build/Run My Agents.app"
zip="$here/build/Run-My-Agents-macOS.zip"
: "${APPLE_API_KEY_PATH:?}" "${APPLE_API_KEY_ID:?}" "${APPLE_API_ISSUER_ID:?}"
ditto -c -k --keepParent "$app" "$here/build/notarize.zip"
xcrun notarytool submit "$here/build/notarize.zip" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY_ID" \
  --issuer "$APPLE_API_ISSUER_ID" --wait --timeout 30m | tee "$here/build/notarize.log"
grep -q "status: Accepted" "$here/build/notarize.log" || { echo "Notarization was not accepted." >&2; exit 1; }
xcrun stapler staple "$app"
xcrun stapler validate "$app"
spctl --assess --type execute --verbose=2 "$app"
rm -f "$zip" "$here/build/notarize.zip"
(cd "$here/build" && ditto -c -k --keepParent "Run My Agents.app" "Run-My-Agents-macOS.zip")
echo "Notarized and stapled: $zip"
