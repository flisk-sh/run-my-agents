import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const hook = join(root, "hooks", "check.mjs");
const temporaryDirectories = [];

function setup() {
  const base = mkdtempSync(join(tmpdir(), "run-my-agents-check-"));
  temporaryDirectories.push(base);
  const dir = join(base, "state");
  const cwd = join(base, "project");
  mkdirSync(cwd);
  return { dir, cwd };
}

/** Run the hook in an isolated process and return its stdout. */
function runHook(stateDir, input, extraEnv = {}) {
  const result = spawnSync(process.execPath, [hook], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify(input),
    env: {
      ...process.env,
      RUN_MY_AGENTS_DIR: stateDir,
      ...extraEnv,
    },
  });

  assert.equal(result.status, 0, result.stderr || "hook process should exit successfully");
  assert.equal(result.stderr, "", "hook should not write errors to stderr");
  return result.stdout;
}

function edit(sessionId, filePath, cwd, tool = "file_path") {
  return {
    session_id: sessionId,
    cwd,
    tool_input: { [tool]: filePath },
  };
}

function claimsFrom(stateDir) {
  return JSON.parse(readFileSync(join(stateDir, "claims.json"), "utf8"));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("claims expire after the configured TTL", () => {
  const { dir, cwd } = setup();
  const file = join(cwd, "expired.ts");
  writeFileSync(file, "");
  const now = Date.now();

  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "claims.json"),
    JSON.stringify({
      claims: { [file]: { session: "old-session", at: now - 120_000, cwd, branch: "" } },
      warned: {},
    }),
  );

  const output = runHook(dir, edit("new-session", file, cwd), {
    RUN_MY_AGENTS_TTL_MINUTES: "1",
  });

  assert.equal(output, "", "an expired claim must not block the edit");
  assert.equal(claimsFrom(dir).claims[file].session, "new-session");
});

test("relative file_path values resolve against the supplied cwd", () => {
  const { dir, cwd } = setup();
  const file = join(cwd, "src", "relative.ts");
  mkdirSync(join(cwd, "src"));
  writeFileSync(file, "");

  assert.equal(runHook(dir, edit("first-session", "src/relative.ts", cwd)), "");
  const output = runHook(dir, edit("second-session", file, cwd));

  assert.match(output, /"permissionDecision":"deny"/);
  assert.match(output, /first-se/);
});

test("NotebookEdit uses notebook_path when file_path is absent", () => {
  const { dir, cwd } = setup();
  const notebook = join(cwd, "analysis.ipynb");
  writeFileSync(notebook, "");

  assert.equal(runHook(dir, edit("notebook-owner", notebook, cwd, "notebook_path")), "");
  const output = runHook(dir, edit("other-session", notebook, cwd, "notebook_path"));

  assert.match(output, /"permissionDecision":"deny"/);
  assert.match(output, /notebook/);
});

test("input without session_id is ignored", () => {
  const { dir, cwd } = setup();
  const output = runHook(dir, { cwd, tool_input: { file_path: "ignored.ts" } });

  assert.equal(output, "");
  assert.equal(existsSync(join(dir, "claims.json")), false);
});

test("warned-once state is scoped to the session, file, and other session tuple", () => {
  const { dir, cwd } = setup();
  const file = join(cwd, "shared.ts");
  writeFileSync(file, "");

  assert.equal(runHook(dir, edit("alpha-one", file, cwd)), "");
  const firstWarning = runHook(dir, edit("bravo-two", file, cwd));
  assert.match(firstWarning, /"permissionDecision":"deny"/);

  assert.equal(
    runHook(dir, edit("bravo-two", file, cwd)),
    "",
    "the same session pair should be allowed on its retry",
  );

  const reverseWarning = runHook(dir, edit("alpha-one", file, cwd));
  assert.match(reverseWarning, /"permissionDecision":"deny"/);
  assert.match(reverseWarning, /bravo-tw/);
});

test("corrupt claims.json is replaced without failing the hook", () => {
  const { dir, cwd } = setup();
  const file = join(cwd, "recover.ts");
  writeFileSync(file, "");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "claims.json"), "{ this is not valid JSON");

  assert.equal(runHook(dir, edit("recovery-session", file, cwd)), "");
  const state = claimsFrom(dir);

  assert.equal(state.claims[file].session, "recovery-session");
  assert.deepEqual(state.warned, {});
});

test("RUN_MY_AGENTS_MODE=off never warns and keeps no claims", () => {
  const { dir, cwd } = setup();
  const file = join(cwd, "a.ts");
  assert.equal(runHook(dir, edit("one", file, cwd), { RUN_MY_AGENTS_MODE: "off" }), "");
  assert.equal(runHook(dir, edit("two", file, cwd), { RUN_MY_AGENTS_MODE: "off" }), "");
  assert.equal(existsSync(join(dir, "claims.json")), false);
});

test("RUN_MY_AGENTS_DEBUG=1 writes decisions to debug.log", () => {
  const { dir, cwd } = setup();
  const file = join(cwd, "a.ts");
  runHook(dir, edit("one", file, cwd), { RUN_MY_AGENTS_DEBUG: "1" });
  runHook(dir, edit("two", file, cwd), { RUN_MY_AGENTS_DEBUG: "1" });
  const log = readFileSync(join(dir, "debug.log"), "utf8");
  assert.match(log, /claimed one/);
  assert.match(log, /warned two/);
});

test("lockfiles, generated files and RUN_MY_AGENTS_IGNORE globs never warn", () => {
  const { dir, cwd } = setup();
  for (const name of ["package-lock.json", "bun.lock", "src/x.autogenerated.ts", "dist/app.js", "snap/a.snap"]) {
    const file = join(cwd, name);
    const env = { RUN_MY_AGENTS_IGNORE: "*.snap" };
    assert.equal(runHook(dir, edit("one", file, cwd), env), "", name);
    assert.equal(runHook(dir, edit("two", file, cwd), env), "", name);
  }
  const file = join(cwd, "src", "real.ts");
  mkdirSync(join(cwd, "src"), { recursive: true });
  runHook(dir, edit("one", file, cwd));
  assert.match(runHook(dir, edit("two", file, cwd)), /permissionDecision/);
});

test("a session's claims go away when it ends", () => {
  const { dir, cwd } = setup();
  const file = join(cwd, "a.ts");
  runHook(dir, edit("one", file, cwd));
  assert.equal(runHook(dir, { session_id: "one", cwd, hook_event_name: "SessionEnd" }), "");
  assert.equal(runHook(dir, edit("two", file, cwd)), "");
  const claims = JSON.parse(readFileSync(join(dir, "claims.json"), "utf8")).claims;
  assert.deepEqual(Object.values(claims).map((c) => c.session), ["two"]);
});
