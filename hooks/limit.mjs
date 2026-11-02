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
  // Said to the agent first: what to do with its own work, and how to tell its team, before what to tell the user.
  const ask = lower ? `run /model ${lower} to continue on a cheaper model` : "raise the limit (this is already the cheapest model)";
  const next =
    "Start no new tool calls. End this turn with a short hand-off: what is done, what is left, and the next step, so the work can be picked up. " +
    'If you are working on a kitchen order, end with ```kitchen\n{"blocked": "token limit"}\n``` so the order stops instead of waiting. ' +
    `Then tell the user to ${ask}, and stop.\n` +
    `run-my-agents-limit: ${JSON.stringify({ type: "token-limit", used: usage.used, limit: limits.sessionTokens, model: usage.model || null, next: lower || null, newSessionsMoved: Boolean(moved) })}`;
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
