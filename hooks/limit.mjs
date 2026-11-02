#!/usr/bin/env node
// Run My Agents: stops a Claude Code session once when it passes its token limit, and tells it to move to the
// next cheaper model. It cannot change a running session's model; only the user's /model can. With autoDowngrade on, it also sets that model for the project's new sessions. It never
// suggests a more expensive model.

import { readFileSync } from "node:fs";
import { lowerModel, readLimits, setProjectModel, transcriptUsage } from "./limits.mjs";
import { join } from "node:path";
import { DIR } from "./limits.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function main() {
  const input = readJson(0, {});
  const session = input.session_id;
  if (!session || !input.transcript_path) return;
  const limits = readLimits();
  if (!limits.sessionTokens) return;

  const usage = transcriptUsage(session, input.transcript_path);
  if (usage.used < limits.sessionTokens) return;

  // One stop per session: a running session cannot change model from outside, so after the stop it carries on
  // (on whatever model the user picked with /model) and is never stopped again for the same limit.
  const warnedFile = join(DIR, "usage", "warned.json");
  const warned = readJson(warnedFile, {});
  const key = session;
  if (warned[key]) return;
  warned[key] = Date.now();
  mkdirSync(join(DIR, "usage"), { recursive: true });
  writeFileSync(warnedFile, JSON.stringify(warned));

  const lower = lowerModel(usage.model);
  let moved = "";
  if (lower && limits.autoDowngrade && input.cwd) {
    try {
      setProjectModel(input.cwd, lower);
      moved = ` New sessions in this project now start on ${lower}.`;
    } catch {}
  }
  const used = usage.used.toLocaleString("en-US");
  const max = limits.sessionTokens.toLocaleString("en-US");
  const next = lower
    ? `Tell the user to run /model ${lower} to continue on a cheaper model, then stop and wait.`
    : "This is already the cheapest model. Tell the user, then stop and wait.";
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Run My Agents: this session used ${used} tokens, over its limit of ${max}.${moved} ${next}`,
      },
    }),
  );
}

try {
  main();
} catch {
  // Never stop a tool call because this hook broke.
}
