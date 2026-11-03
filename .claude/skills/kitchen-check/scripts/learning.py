#!/usr/bin/env python3
"""learning.py: per container, its lessons (count, distinct, junk), learned skills with scores, and skills gained by fires."""
import collections, json, re, urllib.request
boxes = json.load(urllib.request.urlopen("http://127.0.0.1:4100/api/containers"))
boxes = boxes if isinstance(boxes, list) else boxes.get("containers", [])
JUNK = re.compile(r"^(Stuck after \d+ rounds\.?|.*\(no reason given\).*)$", re.I)
for c in boxes:
    ls = [l["reason"] for l in c.get("lessons", [])]
    junk = [l for l in ls if JUNK.match(l.strip())]
    cut = [l for l in ls if len(l) >= 299 and not l.endswith("…")]
    learned = [s for s in c.get("skills", []) if isinstance(s, dict) and s.get("learned")]
    gained = sorted({g for p in c.get("pods", []) for g in (p.get("gained") or [])})
    live = sum(1 for p in c.get("pods", []) if p.get("status") != "evicted")
    print(f"{c['name']:<30} agents {live}/{c.get('replicas')}  lessons {len(ls)} (distinct {len(set(ls))}, junk {len(junk)}, cut {len(cut)})")
    for s in learned:
        print(f"    learned /{s['name']}: score {s.get('score')} over {s.get('uses')} orders")
    if gained:
        print(f"    gained by fires: {', '.join('/' + g for g in gained)}")
    for l in collections.Counter(ls).most_common(2):
        print(f"    lesson x{l[1]}: {' '.join(l[0].split())[:120]}")
