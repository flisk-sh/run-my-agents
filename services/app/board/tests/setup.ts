// Scripted-kitchen tests run up to 40 ticks of the real autopilot with git worktrees: 2-4 s each, more on a busy CI
// runner. At bun's default 5 s they timed out, and a timed-out test kept writing into the next test's folder (#313).
import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(30_000);
