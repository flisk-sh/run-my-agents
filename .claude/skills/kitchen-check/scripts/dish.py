#!/usr/bin/env python3
"""dish.py N [N...]: what each order ended as, and the evidence to judge it: answer, failures, branch diff, tests."""
import json, subprocess, sys, urllib.request
tasks = {t["n"]: t for t in json.load(urllib.request.urlopen("http://127.0.0.1:4100/api/tasks"))["tasks"]}
NOT_ANSWERS = ("don't have web", "do not have web", "can't check", "cannot check", "check weather", "i can help", "unable to")
for n in map(int, sys.argv[1:]):
    t = tasks.get(n)
    if not t:
        print(f"#{n}: no such order"); continue
    print(f"#{n} [{t.get('kind')}] {t['stage']} failed={t.get('failed')} stuck={t.get('stuck')} rounds={t.get('rounds')} followUp={t.get('followUp')} skills={t.get('skills')}")
    print(f"   {t['title'][:100]}")
    for f in (t.get("failures") or [])[(t.get("carried") or 0):]:
        print(f"   ! {f[:240]}")
    if t.get("kind") == "question":
        a = t.get("answer") or ""
        bad = any(x in a.lower() for x in NOT_ANSWERS)
        print(f"   answer{' (NOT AN ANSWER)' if bad else ''}: {a[:300]}")
    elif t.get("worktree"):
        wt = t["worktree"]
        # Committed and uncommitted changes since the order's base, new files included (git diff alone misses them).
        changed = subprocess.run(["git", "-C", wt, "diff", "--name-only", t.get("base") or "HEAD"], capture_output=True, text=True).stdout.split()
        new = [l[3:] for l in subprocess.run(["git", "-C", wt, "status", "--porcelain"], capture_output=True, text=True).stdout.splitlines() if l.startswith("??")]
        files = sorted(set(changed + new))
        print(f"   branch: {', '.join(files) if files else '(no change)'}")
        r = subprocess.run(["bun", "test"], cwd=wt, capture_output=True, text=True, timeout=120)
        lines = [l.strip() for l in (r.stdout + r.stderr).splitlines() if l.strip().endswith(("pass", "fail")) and l.strip()[0].isdigit()]
        print(f"   bun test: {' '.join(lines)}")
