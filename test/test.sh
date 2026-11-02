#!/usr/bin/env bash
# Two fake sessions edit the same file; the second is warned once, then allowed.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
export RUN_MY_AGENTS_DIR=$(mktemp -d)
hook() { printf '{"session_id":"%s","cwd":"/tmp","tool_input":{"file_path":"/tmp/api.ts"}}' "$1" | node "$here/hooks/check.mjs"; }
fail() { echo "FAIL: $1"; exit 1; }

[ -z "$(hook aaaa1111)" ] || fail "first session should be allowed"
[ -z "$(hook aaaa1111)" ] || fail "same session again should be allowed"
out=$(hook bbbb2222); echo "$out" | grep -q '"deny"' || fail "second session should be warned"
echo "$out" | grep -q 'aaaa1111' || fail "warning should name the other session"
[ -z "$(hook bbbb2222)" ] || fail "second try should go through"
out=$(hook aaaa1111); echo "$out" | grep -q '"deny"' || fail "first session should now be warned about the second"
printf 'not json' | node "$here/hooks/check.mjs" || fail "bad input must not error"

# Invalid TTL must fall back to 10 minutes, not NaN (which would drop every claim) (#3).
export RUN_MY_AGENTS_DIR=$(mktemp -d)
export RUN_MY_AGENTS_TTL_MINUTES=abc
[ -z "$(hook cccc3333)" ] || fail "ttl=abc first session should be allowed"
out=$(hook dddd4444); echo "$out" | grep -q '"deny"' || fail "ttl=abc should still warn the second session"

export RUN_MY_AGENTS_DIR=$(mktemp -d)
export RUN_MY_AGENTS_TTL_MINUTES=-5
[ -z "$(hook eeee5555)" ] || fail "ttl=-5 first session should be allowed"
out=$(hook ffff6666); echo "$out" | grep -q '"deny"' || fail "ttl=-5 should still warn the second session"
unset RUN_MY_AGENTS_TTL_MINUTES

# Twenty hooks at the same moment, each on its own file: none may lose its claim to another's write (#4).
export RUN_MY_AGENTS_DIR=$(mktemp -d)
for i in $(seq 1 20); do
  ( printf '{"session_id":"par%05d","cwd":"/tmp","tool_input":{"file_path":"/tmp/par%s.ts"}}' "$i" "$i" | node "$here/hooks/check.mjs" ) &
done
wait
n=$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.env.RUN_MY_AGENTS_DIR+"/claims.json","utf8")).claims;console.log(Object.keys(c).length)')
[ "$n" = 20 ] || fail "20 parallel hooks should leave 20 claims, found $n"
[ ! -e "$RUN_MY_AGENTS_DIR/claims.lock" ] || fail "the lock should be released"

echo "PASS: 12 checks"
