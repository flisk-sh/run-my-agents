// Cases for the kitchen step eval. Each one reproduces a real step (orders #88 and #89, flisk issue #3210) in a small
// stand-in repo, so a run needs no network and no user data. Controls are steps where searching or failing is the
// right thing to do: they catch a brief that cuts too much.
import type { Stage } from "../../services/app/board/src/kitchen/pipeline";

export type Limits = {
	/** Most tool calls the step may make. */
	toolCalls: number;
	/** Skill tool calls allowed (0 unless the step needs one). */
	skills?: number;
	/** Reads of the order's issue (WebFetch, gh issue view, gh api …/issues) allowed. */
	issueReads?: number;
	/** Whole-suite runs allowed (a test command with no file). */
	fullSuite?: number;
	/** Refused commands allowed. */
	refusals?: number;
	/** Test and Review: tracked files they may change in the worktree (they check, they do not edit). */
	worktreeEdits?: number;
};

export type Case = {
	id: string;
	/** Where it came from. */
	source: string;
	stage: Extract<Stage, "build" | "test" | "review">;
	title: string;
	/** What earlier stages handed on, as the board stores it in task.notes. */
	notes: Partial<Record<"spec" | "build", string>>;
	/** The repo at the commit the order starts from. */
	files: Record<string, string>;
	/** Test and Review: the change Build left in the worktree (uncommitted, like the board leaves it). */
	change?: Record<string, string>;
	/** Run in the worktree after the step; exit 0 means the work is right. Build cases only. */
	verify?: string;
	/** Test and Review: the verdict a careful checker gives. */
	verdict?: "PASS" | "FAIL";
	limits: Limits;
	/** A control: the right step searches or fails, so only correctness and a loose budget are graded. */
	control?: boolean;
};

const ISSUE = "https://github.com/acme/app/issues/3210";
const TITLE = `work on this ${ISSUE}`;

const progress = (unhealthy: "failed" | "starting", crash: "failed" | "starting" = "failed") => `export type Item = {
	name: string;
	runtimeStatus: "ok" | "pending" | "error";
	healthStatus?: "healthy" | "unhealthy" | "unknown";
	updateStatus?: "ok" | "pending" | "error";
};
export type Phase = "starting" | "ready" | "failed";

/** What the \`up\` progress line shows for one service. */
export function classifyUpProgress(i: Item): Phase {
	if (i.updateStatus === "error") return "failed";
	if (i.runtimeStatus === "error") return "${crash}";
	if (i.runtimeStatus === "ok" && i.healthStatus === "unhealthy") return "${unhealthy}";
	if (i.runtimeStatus === "ok" && (i.healthStatus === "healthy" || i.healthStatus === undefined)) return "ready";
	return "starting";
}
`;

const progressTest = (unhealthy: "failed" | "starting") => `import { expect, it } from "bun:test";
import { classifyUpProgress } from "../src/up-progress";

const item = (runtimeStatus: "ok" | "pending" | "error", healthStatus?: "healthy" | "unhealthy" | "unknown", updateStatus?: "ok" | "pending" | "error") => ({ name: "api", runtimeStatus, healthStatus, updateStatus });

it("a healthy running service is ready", () => expect(classifyUpProgress(item("ok", "healthy"))).toBe("ready"));
it("a pending service is starting", () => expect(classifyUpProgress(item("pending"))).toBe("starting"));
it("a failed build is failed", () => expect(classifyUpProgress(item("ok", undefined, "error"))).toBe("failed"));
it("a crashed container is failed", () => expect(classifyUpProgress(item("error"))).toBe("failed"));
it("a running service whose health check fails is ${unhealthy}", () => expect(classifyUpProgress(item("ok", "unhealthy"))).toBe("${unhealthy}"));
`;

const repo: Record<string, string> = {
	"package.json": `{ "name": "app", "private": true, "type": "module", "scripts": { "test": "bun test" } }\n`,
	"README.md": "# app\n\n`up` starts the stack and prints one progress line per service.\n",
	"src/up-progress.ts": progress("failed"),
	"tests/up-progress.test.ts": progressTest("failed"),
	// The whole-suite trap from #88: an unrelated test that fails before any change and needs a live stack.
	"tests/stack.e2e.test.ts": `import { expect, it } from "bun:test";\n\nit("the live stack answers", async () => {\n\tconst r = await fetch("http://127.0.0.1:59999/health").catch(() => undefined);\n\texpect(r?.ok).toBe(true);\n});\n`,
	"src/up-readiness.ts": `/** Whether \`up\` exits 0: decided here, separately from the progress line. Out of scope for #3210. */\nexport const withinGrace = (sinceMs: number, graceMs = 30_000) => sinceMs < graceMs;\n`,
};

const SPEC = `## Goal
A running service whose health check is still failing shows as \`starting\` in the \`up\` progress line, not \`failed\`.

## Why
During a slow start the line says \`failed\` for services that come up seconds later (issue #3210).

## Current behaviour
src/up-progress.ts:13 returns "failed" for runtimeStatus "ok" with healthStatus "unhealthy":
\`\`\`ts
if (i.runtimeStatus === "ok" && i.healthStatus === "unhealthy") return "failed";
\`\`\`

## Baseline
\`bun test tests/up-progress.test.ts\`: 5 pass. \`tests/stack.e2e.test.ts\` already fails (it needs a live stack) and is out of scope: never run the whole suite.

## Acceptance checks
1. AC-1: \`bun test tests/up-progress.test.ts\` prints 5 pass, 0 fail.
2. AC-2: classifyUpProgress({ name: "api", runtimeStatus: "ok", healthStatus: "unhealthy" }) returns "starting".
3. AC-3: a crashed container (runtimeStatus "error") still returns "failed", and a failed build (updateStatus "error") still returns "failed".

## Files to change
- src/up-progress.ts: classifyUpProgress, line 13 only.
- tests/up-progress.test.ts: the last test (line 10), which asserts the old behaviour.
Must not change: src/up-readiness.ts, tests/stack.e2e.test.ts.

## Steps
1. In src/up-progress.ts line 13, change \`return "failed";\` to \`return "starting";\`.
2. In tests/up-progress.test.ts line 10, change both \`failed\` to \`starting\` (the test name and the expected value).
3. Run \`bun test tests/up-progress.test.ts\`: 5 pass, 0 fail.

## Out of scope
src/up-readiness.ts, the e2e suite, any new file.

## Assumptions
"unknown" health keeps returning "starting" (unchanged).`;

const BUILD_NOTE = "Changed src/up-progress.ts line 13 (unhealthy-but-running returns \"starting\") and the last test in tests/up-progress.test.ts. bun test tests/up-progress.test.ts: 5 pass.";

const VERIFY = `bun test tests/up-progress.test.ts && bun -e 'import {classifyUpProgress as c} from "./src/up-progress.ts"; const r=[c({name:"a",runtimeStatus:"ok",healthStatus:"unhealthy"}),c({name:"a",runtimeStatus:"error"}),c({name:"a",runtimeStatus:"ok",updateStatus:"error"})]; if (r.join()!=="starting,failed,failed") { console.error(r); process.exit(1) }' && git diff --quiet HEAD -- src/up-readiness.ts tests/stack.e2e.test.ts`;

export const CASES: Case[] = [
	{
		id: "build-follows-spec",
		source: "order #88/#89 build: re-read the issue, opened skills, ran the whole suite although the spec had done that work",
		stage: "build",
		title: TITLE,
		notes: { spec: SPEC },
		files: repo,
		verify: VERIFY,
		limits: { toolCalls: 12, skills: 0, issueReads: 0, fullSuite: 0, refusals: 0 },
	},
	{
		id: "build-moved-function",
		source: "control: the spec names a file that has moved, so finding it is the job",
		stage: "build",
		title: TITLE,
		notes: { spec: SPEC },
		files: { ...Object.fromEntries(Object.entries(repo).filter(([f]) => f !== "src/up-progress.ts")), "src/progress/up.ts": progress("failed"), "src/up-progress.ts": `export * from "./progress/up";\n` },
		verify: VERIFY.replace("./src/up-progress.ts", "./src/progress/up.ts"),
		limits: { toolCalls: 20, issueReads: 0, fullSuite: 0, refusals: 0 },
		control: true,
	},
	{
		id: "test-checks-not-explores",
		source: "order #88 test: 25 tool calls in 7 min on Sonnet, a scratch script and a test edited and reverted in the worktree",
		stage: "test",
		title: TITLE,
		notes: { spec: SPEC, build: BUILD_NOTE },
		files: repo,
		change: { "src/up-progress.ts": progress("starting"), "tests/up-progress.test.ts": progressTest("starting") },
		verdict: "PASS",
		limits: { toolCalls: 10, skills: 0, issueReads: 0, fullSuite: 0, refusals: 0, worktreeEdits: 0 },
	},
	{
		id: "test-catches-crash-regression",
		source: "control from order #88: the change also showed crashed containers as starting, and Test rightly failed it",
		stage: "test",
		title: TITLE,
		notes: { spec: SPEC, build: BUILD_NOTE },
		files: repo,
		change: { "src/up-progress.ts": progress("starting", "starting"), "tests/up-progress.test.ts": progressTest("starting").replace(`it("a crashed container is failed", () => expect(classifyUpProgress(item("error"))).toBe("failed"));\n`, "") },
		verdict: "FAIL",
		limits: { toolCalls: 16, issueReads: 0, fullSuite: 0, refusals: 0, worktreeEdits: 0 },
		control: true,
	},
	{
		id: "build-many-places",
		source: "order #133 build: 84 calls, one grep+Read+Edit per location",
		stage: "build",
		title: `add a log line to progress tracking ${ISSUE}`,
		notes: {
			spec: `## Goal\nAdd logging to three functions in two files for debugging.\n\n## Why\nOrder #133 spent 84 tool calls searching one-by-one instead of batching.\n\n## Current behaviour\nNo logging exists.\n\n## Files to change\n- src/progress/labels.ts: getLabel function (line 5), printLabel function (line 12).\n- src/progress/status.ts: updateStatus function (line 8).\n\n## Steps\n1. Read src/progress/labels.ts completely. Find getLabel and printLabel. In getLabel (line 7), replace OLD_GET with "console.log('getLabel', name);". In printLabel (line 14), replace OLD_PRINT with "console.log('printLabel', s);". Make both edits in one turn.\n2. Read src/progress/status.ts completely. Find updateStatus (line 8). Replace OLD_STATUS with "console.log('updateStatus', id, status);".`
		},
		files: {
			...repo,
			"src/progress/labels.ts": `export function getLabel(name) {
	// OLD_GET
	return name;
}
export function printLabel(s) {
	// OLD_PRINT
	return \`[\${s}]\`;
}`,
			"src/progress/status.ts": `export function updateStatus(id, status) {
	// OLD_STATUS
	return { id, status };
}`,
		},
		change: {
			"src/progress/labels.ts": `export function getLabel(name) {
	console.log('getLabel', name);
	return name;
}
export function printLabel(s) {
	console.log('printLabel', s);
	return \`[\${s}]\`;
}`,
			"src/progress/status.ts": `export function updateStatus(id, status) {
	console.log('updateStatus', id, status);
	return { id, status };
}`,
		},
		verify: `(grep -q "console.log('getLabel'" src/progress/labels.ts && grep -q "console.log('printLabel'" src/progress/labels.ts && grep -q "console.log('updateStatus'" src/progress/status.ts) || exit 1`,
		limits: { toolCalls: 30, skills: 0, issueReads: 0, fullSuite: 0, refusals: 0 },
	},
];
