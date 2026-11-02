#!/usr/bin/env bash
# Two fake sessions edit the same file; the second is warned once, then allowed.
set -euo pipefail

node --test "$(dirname "$0")/check.test.mjs"
here=$(cd "$(dirname "$0")/.." && pwd)
export RUN_MY_AGENTS_DIR=$(mktemp -d)
# Run the hook with a session ID and return its JSON output.
hook() { printf '{"session_id":"%s","cwd":"/tmp","tool_input":{"file_path":"/tmp/api.ts"}}' "$1" | node "$here/hooks/check.mjs"; }
fail() { echo "FAIL: $1"; exit 1; }

[ -z "$(hook aaaa1111)" ] || fail "first session should be allowed"
[ -z "$(hook aaaa1111)" ] || fail "same session again should be allowed"
out=$(hook bbbb2222); echo "$out" | grep -q '"deny"' || fail "second session should be warned"
echo "$out" | grep -q 'aaaa1111' || fail "warning should name the other session"
[ -z "$(hook bbbb2222)" ] || fail "second try should go through"
out=$(hook aaaa1111); echo "$out" | grep -q '"deny"' || fail "first session should now be warned about the second"
# A deliberate retry still goes through, and A now holds the file.
[ -z "$(hook aaaa1111)" ] || fail "first session's retry should go through"
# B was warned about A once already, but A has edited the file since: B must be warned again, not overwrite silently.
out=$(hook bbbb2222); echo "$out" | grep -q '"deny"' || fail "second session should be warned again after the first edited since"
echo "$out" | grep -q 'aaaa1111' || fail "the second warning should name the other session"
echo "$out" | grep -q 'again' || fail "the second warning should say the other session edited it again"
echo "$out" | grep -q 'claim drops' || fail "the warning should say when the other session's claim drops"
[ -z "$(hook bbbb2222)" ] || fail "and B's deliberate retry still goes through"
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

# One file reached through a symlinked folder is the same file (#5).
export RUN_MY_AGENTS_DIR=$(mktemp -d)
real=$(mktemp -d); ln -s "$real" "$real-link"; : > "$real/sym.ts"
symhook() { printf '{"session_id":"%s","cwd":"/tmp","tool_input":{"file_path":"%s"}}' "$1" "$2" | node "$here/hooks/check.mjs"; }
[ -z "$(symhook sym1111 "$real/sym.ts")" ] || fail "first session on the real path should be allowed"
out=$(symhook sym2222 "$real-link/sym.ts"); echo "$out" | grep -q '"deny"' || fail "the symlinked path is the same file and should warn"
# A file that does not exist yet is keyed by its folder's real path.
[ -z "$(symhook sym1111 "$real/new.ts")" ] || fail "a new file should be allowed for its first session"
out=$(symhook sym2222 "$real-link/new.ts"); echo "$out" | grep -q '"deny"' || fail "a new file through a symlink should warn"

# Token limit: a session over its limit is stopped once, never moved up, and no project settings are written
# unless "move new sessions to a cheaper model" (autoDowngrade) is on. A second session on the repo is untouched.
export RUN_MY_AGENTS_DIR=$(mktemp -d)
repo=$(mktemp -d)
printf '{"sessionTokens":100,"autoDowngrade":false}' > "$RUN_MY_AGENTS_DIR/limits.json"
turn() { printf '{"type":"assistant","message":{"model":"%s","usage":{"input_tokens":%s,"output_tokens":0}}}\n' "$1" "$2"; }
big="$RUN_MY_AGENTS_DIR/big.jsonl"; small="$RUN_MY_AGENTS_DIR/small.jsonl"
turn claude-opus-4-5 200 > "$big"; turn claude-opus-4-5 10 > "$small"
limit() { printf '{"session_id":"%s","cwd":"%s","transcript_path":"%s","tool_name":"Bash"}' "$1" "$repo" "$2" | node "$here/hooks/limit.mjs"; }
out=$(limit over1111 "$big")
[ "$out" = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Run My Agents: this session used 200 tokens, over its limit of 100. Tell the user to run /model sonnet to continue on a cheaper model, then stop and wait."}}' ] || fail "over the limit: exact stop message, got $out"
[ -z "$(limit over1111 "$big")" ] || fail "the same session is stopped only once"
turn claude-sonnet-4-5 50 >> "$big"
[ -z "$(limit over1111 "$big")" ] || fail "moving to a cheaper model must not stop the session a second time"
[ -z "$(limit under222 "$small")" ] || fail "a second session under the limit on the same repo is not stopped"
[ ! -e "$repo/.claude/settings.local.json" ] || fail "no project settings are written while autoDowngrade is off"
# With autoDowngrade on, only new sessions move down a step (never up), and only the session over the limit is stopped.
printf '{"sessionTokens":100,"autoDowngrade":true}' > "$RUN_MY_AGENTS_DIR/limits.json"
turn claude-opus-4-5 200 > "$RUN_MY_AGENTS_DIR/big2.jsonl"
limit over3333 "$RUN_MY_AGENTS_DIR/big2.jsonl" | grep -q 'New sessions in this project now start on sonnet' || fail "autoDowngrade on: says new sessions move to sonnet"
grep -q '"model": "sonnet"' "$repo/.claude/settings.local.json" || fail "autoDowngrade on: project settings move one step down to sonnet"
[ -z "$(limit under222 "$small")" ] || fail "autoDowngrade on: the second session is still not stopped"

echo "PASS: 30 checks"
