#!/bin/sh
# Lists orders that are in the kitchen now (restart the board only when this prints nothing).
curl -s 127.0.0.1:4100/api/tasks | python3 -c 'import json,sys;[print("#%d %s %s"%(x["n"],x["stage"],x["title"][:60])) for x in json.load(sys.stdin)["tasks"] if x["stage"]!="done" and (x.get("assignee") or x["stage"]!="inbox")]'
