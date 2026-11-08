#!/bin/sh
# The board as you run it while it is being changed: it restarts on every code change (bun --watch), follows main so a
# merged pull request is live within a minute, and comes back if it crashes. Agents survive the restarts (running.json).
# Run from a shell of your own: `bun run live`. LIVE_PULL_SECONDS sets how often it looks at main (default 60).
cd "$(dirname "$0")/.." || exit 1

follow() {
	while sleep "${LIVE_PULL_SECONDS:-60}"; do
		# Someone else's branch or unsaved edits in this checkout are left alone, the same rule as the Mac app's update.
		[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || continue
		[ -z "$(git status --porcelain --untracked-files=no)" ] || continue
		git fetch --quiet origin main || continue
		before=$(git rev-parse HEAD)
		[ "$before" = "$(git rev-parse origin/main)" ] && continue
		git merge --ff-only --quiet origin/main || continue
		echo "live: now on $(git log --oneline -1)"
		git diff --quiet "$before" HEAD -- ../../../bun.lock || bun install
	done
}

follow &
trap 'kill $! 2>/dev/null' EXIT
trap 'exit 0' INT TERM

while :; do
	bun run --watch src/index.ts
	echo "live: the board exited ($?), starting it again"
	sleep 2
done
