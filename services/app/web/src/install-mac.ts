// The script behind `curl -fsSL https://run-my-agents.flisk.si/install.sh | sh`. The Mac app is not notarized by
// Apple, so macOS blocks a copy downloaded in a browser ("damaged" or "could not verify"). A file curl saves has no
// quarantine flag, so this installs the same release zip with nothing to click through. Plain sh, readable on one
// screen: it only touches the app folder, and only talks to the GitHub release.
export const MAC_ZIP =
	"https://github.com/flisk-sh/run-my-agents/releases/latest/download/Run-My-Agents-macOS.zip";

export const INSTALL_SH = `#!/bin/sh
# Installs Run My Agents on a Mac: downloads the latest release, puts it in /Applications and opens it.
# Source: https://github.com/flisk-sh/run-my-agents (services/app/web/src/install-mac.ts)
set -eu

[ "$(uname -s)" = "Darwin" ] || { echo "Run My Agents for Mac needs macOS." >&2; exit 1; }

dir="\${RUN_MY_AGENTS_INSTALL_DIR:-/Applications}"
app="$dir/Run My Agents.app"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading Run My Agents..."
curl -fsSL "${MAC_ZIP}" -o "$tmp/app.zip"

mkdir -p "$dir" 2>/dev/null || true
[ -w "$dir" ] || { echo "Cannot write to $dir. Try: RUN_MY_AGENTS_INSTALL_DIR=\\"$HOME/Applications\\" and run this again." >&2; exit 1; }

# A running copy has to close before it can be replaced.
pkill -f "$app/Contents/MacOS/RunMyAgents" 2>/dev/null || true
rm -rf "$app"
ditto -x -k "$tmp/app.zip" "$dir"
xattr -cr "$app" 2>/dev/null || true

echo "Installed $app"
[ -n "\${RUN_MY_AGENTS_NO_OPEN:-}" ] || open "$app"
`;
