# Kitchen steps

Sends a model the exact brief the board sends one kitchen step (`orderText` from
`services/app/board/src/kitchen/routes.ts`), with the same `claude -p` flags, tools and settings the board uses, in a
throwaway git repo. Then it grades the step: is the work right, and how many steps did it take?

Cases come from orders #88 and #89 (flisk issue #3210, shown here as `acme/app`):

| case | from | graded on |
| --- | --- | --- |
| `build-follows-spec` | #88/#89 Build re-read the issue, opened skills and ran the whole suite although the spec had done that | the fix is right; ≤ 12 tool calls, no skills, no issue reads, no whole-suite run |
| `build-moved-function` | control: the spec names a file that has moved | the fix is right; ≤ 20 tool calls (searching is the job) |
| `test-checks-not-explores` | #88 Test: 25 tool calls in 7 min, a scratch script, a test edited and reverted in the worktree | verdict PASS; ≤ 10 tool calls, no edits in the worktree |
| `test-catches-crash-regression` | control: the change also hides crashed containers | verdict FAIL; ≤ 16 tool calls, no edits |

## Run

Needs `claude` signed in (your own login; runs cost your plan's usage) and `bun`. From the repo root:

```sh
cd services/app/board && bun install && cd ../../..
bun evals/kitchen-steps/run.ts --out evals/runs/old --ref 2e61498      # the briefs before PR #360
bun evals/kitchen-steps/run.ts --out evals/runs/now --baseline evals/runs/old
```

- Flags: `--out <dir>` (required), `--case <id>` (repeatable), `--samples <n>` (default 3), `--model` and `--effort`
  (default: the board's policy for the stage, so Haiku/low for Build and Sonnet/medium for Test), `--ref <commit>`
  (briefs from that commit), `--baseline <dir>` (an earlier run to compare against), `--concurrency` (default 2),
  `--timeout` in minutes (default 15).
- A `--ref` older than PR #361 has no `orderText` export, so its brief is put together the way the board did then
  (its own `STAGE_BRIEF` and `ADDRESS`, the card, "Use these skills"). The summary says when that happened.
- Output: `summary.md` (pass rate and medians of tool calls, skills, whole-suite runs, issue reads, cost and time per
  case, with deltas against the baseline), `summary.json`, `results.jsonl`, and in `transcripts/` the brief each
  sample got and its stream-json transcript.
- Cost: a full run is 12 samples, about $0.30 to $1.50 depending on the models. Start with one case and one sample.

## Add a case

Add an entry to `cases.ts`: the stage, the order title, the notes earlier stages handed on, the repo files, the change
under check (Test and Review), a `verify` command (Build) or the right verdict (Test and Review), and the budget.
`grade.test.ts` checks every case has a source and a budget.
