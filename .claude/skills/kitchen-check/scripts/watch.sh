#!/bin/sh
# watch.sh N1 N2 ...: prints each change of the orders' stages, exits when all are done (40 min cap).
prev=""; end=$(( $(date +%s) + 2400 ))
while [ "$(date +%s)" -lt $end ]; do
  s=$(curl -s --max-time 5 127.0.0.1:4100/api/tasks | python3 -c '
import json,sys
want=[int(a) for a in sys.argv[1:]]
t={x["n"]:x for x in json.load(sys.stdin)["tasks"]}
print(" | ".join("#%d %s%s%s%s r%s f%d"%(n,t[n]["stage"],"(ship)" if t[n].get("shipping") else "","*" if t[n].get("assignee") else ""," STUCK" if t[n].get("stuck") else "",t[n].get("rounds"),len(t[n].get("failures") or [])) for n in want if n in t))' "$@" 2>/dev/null || echo "BOARD DOWN")
  [ "$s" != "$prev" ] && echo "$(date +%H:%M:%S) $s" && prev="$s"
  [ "$s" = "BOARD DOWN" ] && exit 1
  echo "$s" | grep -qE "inbox|spec|build|test|review|ship" || exit 0
  sleep 5
done
