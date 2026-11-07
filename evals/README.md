# Evals

An eval runs a real model on the kitchen's real briefs and scores what it does. Use one where a unit test cannot help:
model output changes from run to run, and a small wording change can move it. The layout follows T3 Code's evals
(pingdotgg/t3code `evals/`).

Write or run an eval when a change affects what a kitchen agent sees: `STAGE_BRIEF`, `ADDRESS`, `orderText`, the skills
a step is offered, or what one stage hands the next.

| Eval | Measures |
| --- | --- |
| [kitchen-steps](kitchen-steps/) | Whether Build and Test do the right work in few steps: tool calls, skills opened, whole-suite runs, issue re-reads, edits a checker makes. |

## Rules for cases

- A case reproduces a real bad step, or guards a real good one. Name its source (the order number).
- Add the case before the fix. It must fail on the old briefs (`--ref <commit>`) and pass on the new ones.
- Add controls: steps where searching, or a FAIL verdict, is the right thing to do. They catch a brief that cuts too much.
- Model output varies: run each case several times. A case passes when more than half its samples pass. Compare with
  a baseline on the same model, not with an absolute score.
- The eval imports the briefs from source and never copies them, so it always tests the current text.
- No user data in cases: use `acme/app` and stand-in code.

Evals call paid models, so CI does not run them. CI runs the grader's unit tests (`grade.test.ts`).
