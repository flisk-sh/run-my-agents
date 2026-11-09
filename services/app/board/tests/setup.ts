// Set before any other import touches prefs.ts (dataDir), so a test that forgets to set its own
// RUN_MY_AGENTS_DIR can never read or write the live ~/.run-my-agents orders.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RUN_MY_AGENTS_DIR = mkdtempSync(join(tmpdir(), "rma-setup-"));

// Scripted-kitchen tests run up to 40 ticks of the real autopilot with git worktrees: 2-4 s each, more on a busy CI
// runner. At bun's default 5 s they timed out, and a timed-out test kept writing into the next test's folder (#313).
import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(30_000);
