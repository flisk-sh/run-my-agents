#!/bin/sh
# Prints a practice repo for kitchen orders: KITCHEN_PRACTICE if set, else one made in $TMPDIR (no git remote).
set -e
if [ -n "$KITCHEN_PRACTICE" ] && [ -d "$KITCHEN_PRACTICE/.git" ]; then echo "$KITCHEN_PRACTICE"; exit 0; fi
P="${TMPDIR:-/tmp}/kitchen-practice"
if [ ! -d "$P/.git" ]; then
  mkdir -p "$P/src" "$P/tests"
  cat > "$P/package.json" <<'J'
{ "name": "kitchen-practice", "private": true, "type": "module", "scripts": { "test": "bun test" } }
J
  cat > "$P/src/math.ts" <<'T'
/** Numbers from start up to and including end. */
export function range(start: number, end: number): number[] {
	const out: number[] = [];
	for (let i = start; i < end; i++) out.push(i);
	return out;
}

export function sum(xs: number[]): number {
	return xs.reduce((a, b) => a + b, 0);
}
T
  cat > "$P/tests/math.test.ts" <<'T'
import { expect, it } from "bun:test";
import { range, sum } from "../src/math";

it("sums", () => expect(sum([1, 2, 3])).toBe(6));
// Fails on purpose: a test that already fails must not fail an unrelated order.
it("ranges include the end", () => expect(range(1, 3)).toEqual([1, 2, 3]));
T
  printf '# kitchen-practice\n\nA tiny repo for kitchen orders.\n' > "$P/README.md"
  git -C "$P" init -q -b main && git -C "$P" add . && git -C "$P" -c user.email=k@k -c user.name=kitchen commit -qm "practice repo"
fi
echo "$P"
