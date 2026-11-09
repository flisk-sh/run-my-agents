// Scripted-kitchen tests run up to 40 ticks of the real autopilot with git worktrees: 2-4 s each, more on a busy CI
// runner. At bun's default 5 s they timed out, and a timed-out test kept writing into the next test's folder (#313).
import { setDefaultTimeout } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(30_000);
// Isolate all tests from the real Kitchen data: set a fresh temp folder before any test runs
process.env.RUN_MY_AGENTS_DIR = mkdtempSync(join(tmpdir(), "rma-global-"));
process.env.RUN_MY_AGENTS_SKILLS_DIR = mkdtempSync(join(tmpdir(), "rma-global-skills-"));
