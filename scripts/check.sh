#!/usr/bin/env bash
# One command for every layer: web, board, kitchen agent, the hooks suite and the evals grader. CI, the Kitchen's merge
# gate and the README all run this, so a type error in the board cannot reach main (the live board follows main).
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
step() { printf '\n== %s\n' "$1"; }

step "web: typecheck, lint, test"
(cd "$root/services/app/web" && bun install >/dev/null && bun run typecheck && bun run lint && bun test)

step "board: typecheck, test"
(cd "$root/services/app/board" && bun install >/dev/null && bun run typecheck && bun test)

step "kitchen agent: typecheck, test (its lint fails on main today, and CI never ran it)"
(cd "$root/services/app/kitchen" && bun install && bun run typecheck && bun test)

step "evals grader"
(cd "$root/services/app/board" && bun test ../../../evals/kitchen-steps)

step "hooks"
bash "$root/test/test.sh"

printf '\nAll layers passed.\n'
