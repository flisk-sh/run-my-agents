#!/usr/bin/env bash
# Builds "build/Run My Agents.app" next to this script.
#   ./build.sh            dev build: runs the board from this checkout with Bun
#   ./build.sh --release  universal app (Apple Silicon + Intel) with the board compiled in, no Bun needed,
#                         zipped to build/Run-My-Agents-macOS.zip
set -euo pipefail
release=false; [ "${1:-}" = "--release" ] && release=true
here="$(cd "$(dirname "$0")" && pwd)"
board="${RUN_MY_AGENTS_BOARD:-$(cd "$here/../services/app/board" && pwd)}"
out="$here/build"; app="$out/Run My Agents.app"
# The version shown in Finder and About: RUN_MY_AGENTS_VERSION (the release workflow passes the tag), else the
# latest v* tag, else 0.0.0.
version="${RUN_MY_AGENTS_VERSION:-$(git -C "$here" describe --tags --abbrev=0 --match 'v*' 2>/dev/null || echo v0.0.0)}"
version="${version#v}"
rm -rf "$app"; mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$out/tmp"

# icon
swiftc -O "$here/icon/render-icon.swift" -o "$out/tmp/render-icon"
"$out/tmp/render-icon" "$out/tmp/icon-1024.png"
set_dir="$out/tmp/AppIcon.iconset"; rm -rf "$set_dir"; mkdir -p "$set_dir"
for s in 16 32 128 256 512; do
  sips -z $s $s "$out/tmp/icon-1024.png" --out "$set_dir/icon_${s}x${s}.png" >/dev/null
  d=$((s*2)); sips -z $d $d "$out/tmp/icon-1024.png" --out "$set_dir/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$set_dir" -o "$app/Contents/Resources/AppIcon.icns"
cp "$out/tmp/icon-1024.png" "$here/icon/icon-1024.png"

# binary (bake the board dir)
sed "s|__BAKED_BOARD_DIR__|$board|" "$here/RunMyAgents.swift" > "$out/tmp/main.swift"
if $release; then
  for arch in arm64 x86_64; do
    swiftc -O -target "$arch-apple-macos13.0" "$out/tmp/main.swift" -o "$out/tmp/RunMyAgents-$arch" -framework AppKit -framework WebKit
  done
  lipo -create "$out/tmp/RunMyAgents-arm64" "$out/tmp/RunMyAgents-x86_64" -output "$app/Contents/MacOS/RunMyAgents"
  # The board as one executable per architecture, joined into a universal binary.
  (cd "$board" && bun install --frozen-lockfile >/dev/null 2>&1 || bun install >/dev/null)
  for t in arm64 x64; do
    (cd "$board" && bun build --compile --minify --target="bun-darwin-$t" src/index.ts --outfile "$out/tmp/board-$t" >/dev/null)
  done
  lipo -create "$out/tmp/board-arm64" "$out/tmp/board-x64" -output "$app/Contents/Resources/board" 2>/dev/null \
    || cp "$out/tmp/board-$(uname -m | sed s/x86_64/x64/)" "$app/Contents/Resources/board"
else
  swiftc -O "$out/tmp/main.swift" -o "$app/Contents/MacOS/RunMyAgents" -framework AppKit -framework WebKit
fi

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Run My Agents</string>
  <key>CFBundleDisplayName</key><string>Run My Agents</string>
  <key>CFBundleIdentifier</key><string>sh.flisk.run-my-agents</string>
  <key>CFBundleExecutable</key><string>RunMyAgents</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
# Signing. RUN_MY_AGENTS_SIGN_IDENTITY is a "Developer ID Application: ..." identity (the release workflow sets it
# when its Apple secrets exist); without it the app is ad-hoc signed, which macOS blocks after a browser download.
# Developer ID signing uses the hardened runtime and a timestamp, which notarization requires (see notarize.sh).
identity="${RUN_MY_AGENTS_SIGN_IDENTITY:--}"
if [ "$identity" = "-" ]; then
  codesign --force --deep -s - "$app"
else
  ents="$here/entitlements.plist"
  # Inside out: the board binary sits in Resources, where signing the bundle would not reach it.
  [ -f "$app/Contents/Resources/board" ] && codesign --force --options runtime --timestamp --entitlements "$ents" -s "$identity" "$app/Contents/Resources/board"
  codesign --force --options runtime --timestamp --entitlements "$ents" -s "$identity" "$app"
  codesign --verify --deep --strict --verbose=2 "$app"
fi
if $release; then
  rm -f "$out/Run-My-Agents-macOS.zip"
  (cd "$out" && ditto -c -k --keepParent "Run My Agents.app" "Run-My-Agents-macOS.zip")
  echo "Zipped: $out/Run-My-Agents-macOS.zip"
fi
echo "Built: $app (board: $board)"
