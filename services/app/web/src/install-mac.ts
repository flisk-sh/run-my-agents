// The script behind `curl -fsSL https://run-my-agents.flisk.si/install.sh | sh`. The Mac app is not notarized by
// Apple, so macOS blocks a copy downloaded in a browser ("damaged" or "could not verify"). A file curl saves has no
// quarantine flag, so this installs the same release zip with nothing to click through. Plain sh, readable on one
// screen: it only touches the app folder, and only talks to the GitHub release.
import { createHash } from "node:crypto";

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

/**
 * The one script on the home page: the Download button copies the install command and opens the steps under it.
 * The home page's policy lets exactly this script run (by hash, see DL_SCRIPT_HASH); without it the button is a
 * link to #mac-steps, which shows the same steps.
 */
export const DL_SCRIPT = `(function(){var b=document.getElementById("dlb"),s=document.getElementById("mac-steps"),o=document.getElementById("dlok");if(!b||!s||!o)return;b.addEventListener("click",function(e){e.preventDefault();var cmd=b.getAttribute("data-cmd")||"";function done(ok){s.classList.add("open");o.textContent=ok?"Copied. Now:":"Copy the command below, then:";b.querySelector("b").textContent=ok?"Copied \\u2713":"Download for macOS";b.classList.toggle("copied",ok);s.scrollIntoView({behavior:"smooth",block:"nearest"})}function fallback(){var p=document.getElementById("dlcmd"),r=document.createRange(),g=getSelection(),ok=false;r.selectNodeContents(p);g.removeAllRanges();g.addRange(r);try{ok=document.execCommand("copy")}catch(_){}done(ok)}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(cmd).then(function(){done(true)},fallback)}else{fallback()}})})();`;
export const DL_SCRIPT_HASH = `'sha256-${createHash("sha256").update(DL_SCRIPT).digest("base64")}'`;
