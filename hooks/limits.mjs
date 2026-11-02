// Token limits, shared by the plugin's hook and the board. A limit is per session, in tokens that count toward
// cost: new input, cache writes and output (cache reads are left out, they cost about a tenth).
//
// Models only ever move down the ladder, never up:  opus ──► sonnet ──► haiku ──► (stays)

import { mkdirSync, readFileSync, renameSync, statSync, openSync, readSync, closeSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export const DIR = process.env.RUN_MY_AGENTS_DIR || join(homedir(), ".run-my-agents");
const LIMITS = join(DIR, "limits.json");
export const LADDER = ["opus", "sonnet", "haiku"];
export const DEFAULT_LIMITS = { sessionTokens: 0, autoDowngrade: false };

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

/** The limits, with anything missing or invalid replaced by the default. 0 tokens means no limit. */
export function readLimits() {
  const raw = readJson(LIMITS, {});
  const n = Number(raw.sessionTokens);
  return {
    sessionTokens: Number.isFinite(n) && n > 0 ? Math.round(n) : 0,
    autoDowngrade: raw.autoDowngrade === true,
  };
}

export function writeLimits(input) {
  const n = Number(input?.sessionTokens);
  const limits = {
    sessionTokens: Number.isFinite(n) && n > 0 ? Math.round(n) : 0,
    autoDowngrade: input?.autoDowngrade === true,
  };
  writeJson(LIMITS, limits);
  return limits;
}

/** The next cheaper model's alias for /model, or null when the model is already the cheapest or unknown. */
export function lowerModel(model) {
  const m = String(model || "").toLowerCase();
  const i = LADDER.findIndex((tier) => m.includes(tier));
  return i >= 0 && i < LADDER.length - 1 ? LADDER[i + 1] : null;
}

/**
 * Tokens used by a Claude Code transcript and its last model. Reads only the bytes added since the last call,
 * keeping a running total in DIR/usage/<session>.json, because the hook runs before every tool call.
 */
export function transcriptUsage(session, path) {
  const cacheFile = join(DIR, "usage", `${session.replace(/[^\w-]/g, "")}.json`);
  const cache = readJson(cacheFile, { offset: 0, used: 0, model: "" });
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return cache;
  }
  if (size < cache.offset) Object.assign(cache, { offset: 0, used: 0, model: "" });
  if (size === cache.offset) return cache;
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(size - cache.offset);
  readSync(fd, buf, 0, buf.length, cache.offset);
  closeSync(fd);
  const text = buf.toString("utf8");
  // Count only complete lines; a half-written last line is read next time.
  const end = text.lastIndexOf("\n") + 1;
  for (const line of text.slice(0, end).split("\n")) {
    if (!line.includes('"usage"')) continue;
    try {
      const e = JSON.parse(line);
      const u = e.message?.usage;
      if (e.type !== "assistant" || !u) continue;
      cache.used += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
      if (e.message.model && !e.message.model.startsWith("<")) cache.model = e.message.model;
    } catch {}
  }
  cache.offset += Buffer.byteLength(text.slice(0, end));
  writeJson(cacheFile, cache);
  return cache;
}

/**
 * Sets the model for new sessions in a project, in its .claude/settings.local.json, keeping other settings.
 * Answers null without writing anything unless the folder exists and the alias is on the ladder: the board takes
 * the folder from a session's own transcript, which is not ours to trust with a file write.
 */
export function setProjectModel(cwd, alias) {
  if (!LADDER.includes(alias)) return null;
  const dir = String(cwd || "");
  if (!isAbsolute(dir)) return null;
  try {
    if (!statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  const path = join(dir, ".claude", "settings.local.json");
  const settings = readJson(path, {});
  writeJson(path, { ...settings, model: alias });
  return path;
}
