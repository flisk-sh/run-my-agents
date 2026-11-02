#!/usr/bin/env node
// Run My Agents: warn a Claude Code session before it edits a file
// that another session on this computer edited in the last few minutes.
//
//   session A edits api.ts ──► claims.json { "/repo/api.ts": { session: A, ... } }
//   session B edits api.ts ──► sees A's claim ──► edit stopped once, with a note
//   session B edits again  ──► allowed (a warning, not a lock)

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

const DIR = process.env.RUN_MY_AGENTS_DIR || join(homedir(), ".run-my-agents");
const FILE = join(DIR, "claims.json");

/** Positive finite minutes, else the documented default of 10 (#3). */
function ttlMsFromEnv(raw = process.env.RUN_MY_AGENTS_TTL_MINUTES) {
  const minutes = raw === undefined || raw === "" ? 10 : Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) return 10 * 60_000;
  return minutes * 60_000;
}

const TTL_MS = ttlMsFromEnv();
const LOCK = join(DIR, "claims.lock");

/**
 * Two hooks that read claims.json at the same moment would each write back a copy without the other's claim.
 * A lock directory (mkdir is atomic) makes the read, change and rename one step. A lock older than 5 seconds is a
 * crashed hook's and is taken over. After about 2 seconds without the lock we go on without it: this hook never
 * stops an edit because of its own bookkeeping.
 */
function lock() {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const until = Date.now() + 2000;
  for (;;) {
    try {
      mkdirSync(LOCK);
      let held = true;
      return () => {
        if (held) rmSync(LOCK, { recursive: true, force: true });
        held = false;
      };
    } catch {
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > 5000) rmSync(LOCK, { recursive: true, force: true });
      } catch {}
      if (Date.now() > until) return () => {};
      Atomics.wait(pause, 0, 0, 10 + Math.floor(Math.random() * 20));
    }
  }
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function branchOf(dir) {
  try {
    return execFileSync("git", ["-C", dir, "branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function ago(ms) {
  const min = Math.round(ms / 60_000);
  return min < 1 ? "just now" : `${min} min ago`;
}

function main() {
  const input = readJson(0, {});
  const session = input.session_id;
  const tool = input.tool_input || {};
  const raw = tool.file_path || tool.notebook_path;
  if (!session || !raw) return;

  const cwd = input.cwd || process.cwd();
  const file = isAbsolute(raw) ? raw : resolve(cwd, raw);
  const now = Date.now();

  mkdirSync(DIR, { recursive: true });
  const unlock = lock();
  process.on("exit", unlock);
  const state = readJson(FILE, { claims: {}, warned: {} });
  const claims = {};
  for (const [path, claim] of Object.entries(state.claims || {})) {
    if (now - claim.at < TTL_MS) claims[path] = claim;
  }
  const warned = {};
  for (const [key, at] of Object.entries(state.warned || {})) {
    if (now - at < TTL_MS) warned[key] = at;
  }

  const other = claims[file];
  const warnKey = other ? `${session}|${file}|${other.session}` : "";
  let block = false;
  if (other && other.session !== session && !warned[warnKey]) {
    warned[warnKey] = now;
    block = true;
  }
  if (!block) claims[file] = { session, at: now, cwd, branch: branchOf(cwd) };

  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ claims, warned }, null, 2));
  renameSync(tmp, FILE);
  unlock();

  if (!block) return;
  const where = other.branch ? ` on branch ${other.branch}` : "";
  const reason =
    `Run My Agents: another Claude session (${other.session.slice(0, 8)}${where}, in ${other.cwd}) ` +
    `edited ${basename(file)} ${ago(now - other.at)}. ` +
    "Your edit could overwrite its work. Read the file again first, or work on a different file. " +
    "If you are sure, make the edit again and it will go through.";
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
}

try {
  main();
} catch {
  // Never stop an edit because this hook broke.
}
