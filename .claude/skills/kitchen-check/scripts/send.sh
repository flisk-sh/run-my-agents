#!/bin/sh
# send.sh <practice-repo>: sends the standard batch and prints the order numbers.
P="$1"; [ -d "$P" ] || { echo "usage: send.sh <practice-repo>" >&2; exit 1; }
for t in \
  "add product(xs) to src/math.ts: multiply all numbers, 1 for an empty list, with tests" \
  "add the README section 'Running tests' with the exact command" \
  "fix the crash in src/geometry.ts area() when the radius is negative" \
  "what does sum([]) return in this repo?" \
  "weateher in London today?"; do
  curl -s -X POST 127.0.0.1:4100/api/tasks -H 'content-type: application/json' \
    -d "$(python3 -c 'import json,sys;print(json.dumps({"title":sys.argv[1],"priority":"P1","cwd":sys.argv[2]}))' "$t" "$P")" |
    python3 -c 'import json,sys;x=json.load(sys.stdin);print(x.get("error") or x["n"])'
done
