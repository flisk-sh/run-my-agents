---
name: kitchen-check
description: End-to-end check of the Run My Agents kitchen on the live board. Sends a varied batch of orders (good tasks, a task on a file that does not exist, a plain question, a live question with a typo), watches them through Spec, Build, Test, Review and Ship, checks every served dish before calling it good, measures where the time goes per step, and audits Scores and self-improvement (fail-rate KPI, ratings, lessons, learned and gained skills). Use after merging kitchen changes, when orders fail or stall, when the user says "send some orders and see if they complete", or to check that agents and skills improve themselves.
---

# Kitchen check

A run takes 5 to 10 minutes. It uses the live board on `http://127.0.0.1:4100` and a throwaway practice repo, never a real one. Report what you saw, with order numbers; file a GitHub issue (flisk-sh/run-my-agents) for every defect before fixing it.

## 0. Before you start

- The board must run the code you want to check. It runs from `~/tdk-pr-work/run-my-agents` without `--watch` when the Mac app started it, so after a merge: pull, then restart it through the app (`osascript -e 'quit app "Run My Agents"'`, kill whatever listens on 4100, `open ~/tdk-pr-work/run-my-agents/mac/build/Run\ My\ Agents.app`). Never restart while an order is in a step (`scripts/open-orders.sh` lists them).
- `curl -s 127.0.0.1:4100/health` must say `{"status":"ok"}`. If `/api/tasks` returns nothing, the board is down: read `$(find /var/folders -name run-my-agents-board.log | head -1)`.
- Autopilot must be on: `curl -s 127.0.0.1:4100/api/kitchen` shows `"auto":true`.

## 1. Practice repo

`scripts/practice-repo.sh` prints the path of a practice repo (it makes one in `$TMPDIR` if `KITCHEN_PRACTICE` is not set): `src/math.ts` with `range` and `sum`, `tests/math.test.ts`, and one test that already fails on purpose (`range` excludes its end). It has no git remote, so orders skip Ship and Review reads the branch.

## 2. Send the batch

```bash
P=$(.claude/skills/kitchen-check/scripts/practice-repo.sh)
.claude/skills/kitchen-check/scripts/send.sh "$P"   # prints the order numbers, one per line
```

The batch, and what each must end as:

| Kind | Order | Must end |
|---|---|---|
| good task | add `product(xs)` with tests | served, rounds 0, no failures |
| good task | add the README section "Running tests" | served (the old failing test is not its defect) |
| bad task | fix the crash in `src/geometry.ts` (no such file) | failed fast with `spec: blocked: …`, **no** follow-up order |
| question | "what does sum([]) return in this repo?" | served with a real answer |
| live question, typo | "weateher in London today?" | served with a real forecast, never "I can't check" |

Add your own: a vague order, an order that names a folder, a P0.

## 3. Watch

`scripts/watch.sh N1 N2 …` prints a line whenever a stage changes and exits when all are done (40 min cap). `*` = an agent holds it, `rN` = send-backs, `fN` = failures.

## 4. Check every dish before calling it served

For each order: `curl -s 127.0.0.1:4100/api/tasks | python3 -c …` (see `scripts/dish.py N`), which prints stage, failed, rounds, failures, the answer (questions) or the branch diff and test run (tasks).

- **A question's answer must answer it.** "I don't have web search", "check weather.com", "Sure, I can help" are not answers: that is a defect even if the order says done.
- **A task's branch must hold the change** (`git -C <repo>/.kitchen/order-N diff main --stat`) and its new tests must pass in the worktree (`bun test` there; the planted `range` failure is expected).
- **A failure must say why**: no `(no reason given)`, no `ship: no pull request. \`\`\``, no `Not logged in` (that one is the board's environment, not the agents).
- **No follow-up for an order Spec blocked**; one follow-up for other failures.

## 5. Where the time went

`scripts/timing.py N1 N2 …` splits each order into per-step work (the agent's turn) and gaps (board time between steps). Healthy: gaps under ~25 s, served within ~10 s of Review's last word, a small task in 2–4 minutes. A gap of 30 s or more after every step, or 40–90 s before each step, is a regression (#228, #229).

## 6. Scores

`curl -s 127.0.0.1:4100/api/scores`:

- `flow.failRate`, `failOrders`, `failBoard`, `failGoal`: the fail rate over the last 20 task orders, board faults left out. It must move after your batch.
- `ratings`: must spread (not all 100), `working` > 0 while orders run, an agent with stuck orders rates below one without.
- `skills`: the top skills must fit the orders (no `/flisk-*` skills for a TypeScript math repo).

## 7. Self-improvement

`scripts/learning.py` prints, per container: lessons (count, distinct, any junk), learned skills with score and uses, skills gained when an agent was fired.

- Lessons say what was wrong, once per order: none of `Stuck after N rounds.`, `(no reason given)`, none cut mid-word.
- Spec, Test and Review containers learn too: after a Review FAIL on what Test passed, the Test container has a lesson.
- A FAIL found after the idle timer let the builder go is still a Build lesson.
- Learned skills fit the folder; one whose orders did no better than the rest is dropped after 3 orders; skills gained by a fired agent survive the next sidecar pass.
- Questions that missed: the skills installed for what was missing show in the order's `skills`.

## 8. Report

A table: order, kind, result, time, and for anything off the evidence (order number, stage, the line it said). Then the KPI before → after, and the learning checks that passed or failed. Every defect becomes an issue first, then one PR per issue, each with a test that fails on main.
