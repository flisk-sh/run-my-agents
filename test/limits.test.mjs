import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const stateDir = mkdtempSync(join(tmpdir(), "run-my-agents-limits-"));
process.env.RUN_MY_AGENTS_DIR = stateDir;
const { lowerModel, setProjectModel } = await import("../hooks/limits.mjs");

after(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

test("lowerModel moves Opus down to Sonnet", () => {
  assert.equal(lowerModel("claude-opus-4-5"), "sonnet");
  assert.equal(lowerModel("Opus"), "sonnet");
});

test("lowerModel moves Sonnet down to Haiku", () => {
  assert.equal(lowerModel("claude-sonnet-4-5"), "haiku");
  assert.equal(lowerModel("Sonnet"), "haiku");
});

test("lowerModel leaves Haiku and unknown model names unchanged", () => {
  assert.equal(lowerModel("claude-haiku-4-5"), null);
  assert.equal(lowerModel("Haiku"), null);
  assert.equal(lowerModel("custom-model"), null);
  assert.equal(lowerModel(""), null);
  assert.equal(lowerModel(null), null);
});

test("setProjectModel changes only the model and preserves other project settings", () => {
  const project = mkdtempSync(join(tmpdir(), "run-my-agents-project-"));
  const settingsDir = join(project, ".claude");
  const settingsPath = join(settingsDir, "settings.local.json");
  const original = {
    permissions: { allow: ["Bash(npm test)"], deny: ["Bash(rm -rf /)"] },
    env: { APP_ENV: "development" },
    model: "opus",
    customSetting: { enabled: true, retries: 3 },
  };

  try {
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    assert.equal(setProjectModel(project, "sonnet"), settingsPath);
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
      ...original,
      model: "sonnet",
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("setProjectModel rejects unsupported aliases without changing settings", () => {
  const project = mkdtempSync(join(tmpdir(), "run-my-agents-project-"));
  const settingsDir = join(project, ".claude");
  const settingsPath = join(settingsDir, "settings.local.json");
  const original = { model: "opus", permissions: { allow: ["Bash(*)"] } };

  try {
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(original));

    assert.equal(setProjectModel(project, "unknown"), null);
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), original);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("setProjectModel does not create settings for a missing project", () => {
  const missingProject = join(stateDir, "does-not-exist");
  assert.equal(setProjectModel(missingProject, "haiku"), null);
});

test("the token-limit hook stops a session only once", () => {
  const runDir = mkdtempSync(join(tmpdir(), "run-my-agents-limit-hook-"));
  const project = mkdtempSync(join(tmpdir(), "run-my-agents-limit-project-"));
  const transcript = join(runDir, "transcript.jsonl");
  const hook = fileURLToPath(new URL("../hooks/limit.mjs", import.meta.url));

  try {
    writeFileSync(join(runDir, "limits.json"), JSON.stringify({
      sessionTokens: 100,
      autoDowngrade: false,
    }));
    writeFileSync(transcript, JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-5",
        usage: { input_tokens: 200, output_tokens: 0 },
      },
    }) + "\n");

    const invoke = () => spawnSync(process.execPath, [hook], {
      encoding: "utf8",
      input: JSON.stringify({
        session_id: "limit-once-session",
        cwd: project,
        transcript_path: transcript,
        tool_name: "Bash",
      }),
      env: { ...process.env, RUN_MY_AGENTS_DIR: runDir },
    });

    const first = invoke();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /"permissionDecision":"deny"/);

    const second = invoke();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, "");

    const warned = JSON.parse(readFileSync(join(runDir, "usage", "warned.json"), "utf8"));
    assert.equal(typeof warned["limit-once-session"], "number");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
