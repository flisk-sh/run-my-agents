// The grader is plain logic: these run in CI, the eval itself (paid model calls) does not.
import { describe, expect, it } from "bun:test";
import { CASES } from "./cases";
import { grade, metrics, runsWholeSuite, verdictOf } from "./grade";

const tool = (name: string, input: Record<string, unknown>) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
const result = (text: string) => JSON.stringify({ type: "result", result: text, num_turns: 4, total_cost_usd: 0.012, duration_ms: 9000, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } });

describe("runsWholeSuite", () => {
	it("flags a runner with nothing after it", () => {
		for (const c of ["bun test", "npm test", "cd cli && bun run test", "bun test --timeout 20000", "pnpm run test 2>&1 | tail -20", "npx vitest run"]) expect(runsWholeSuite(c)).toBe(true);
	});
	it("lets a targeted run through", () => {
		for (const c of ["bun test tests/up-progress.test.ts", "cd cli && bun run test src/utils/__tests__/up-progress.test.ts", "bun test -t crashed", "npx vitest run src/a.test.ts", "git status", "bun install"]) expect(runsWholeSuite(c)).toBe(false);
	});
});

describe("metrics", () => {
	const t = [
		tool("Skill", { skill: "focused-fix" }),
		tool("Bash", { command: "gh issue view 3210 --repo acme/app" }),
		tool("WebFetch", { url: "https://github.com/acme/app/issues/3210", prompt: "x" }),
		tool("Read", { file_path: "/w/src/up-progress.ts" }),
		tool("Read", { file_path: "/w/src/up-progress.ts" }),
		tool("Bash", { command: "bun test" }),
		"not json",
		result("Done.\n\n```kitchen\n{\"verdict\": \"PASS\", \"evidence\": \"5 pass\"}\n```"),
	].join("\n");
	it("counts calls, skills, issue reads, whole-suite runs, re-reads and refused commands", () => {
		const m = metrics(t);
		expect(m).toMatchObject({ toolCalls: 6, skills: 1, issueReads: 2, fullSuite: 1, rereads: 1, refusals: 0, turns: 4, costUsd: 0.012, inputTokens: 100, outputTokens: 5 });
		expect(m.byTool).toEqual({ Skill: 1, Bash: 2, WebFetch: 1, Read: 2 });
	});
	it("counts refused commands: cd && git and heredocs with braces or quotes", () => {
		const refused = [
			tool("Bash", { command: "cd services/app/board && git diff" }),
			tool("Bash", { command: "cat > f.ts <<'EOF'\nconst a = {\"b\": 1};\nEOF" }),
			result("Done"),
		].join("\n");
		expect(metrics(refused).refusals).toBe(2);
	});
	it("reads the verdict from the record, else a last PASS or FAIL line", () => {
		expect(verdictOf(metrics(t).reply)).toBe("PASS");
		expect(verdictOf("Ran it.\n\nFAIL: crashed shows starting")).toBe("FAIL");
		expect(verdictOf("Looks fine")).toBeUndefined();
	});
});

describe("grade", () => {
	const build = CASES.find((c) => c.id === "build-follows-spec");
	const check = CASES.find((c) => c.id === "test-catches-crash-regression");
	const lean = { ...metrics(result("Changed 2 files.")), toolCalls: 5 };
	it("passes right work within the budget", () => {
		expect(build && grade(build, { metrics: lean, verified: true })).toEqual([]);
	});
	it("names every way a sample fails", () => {
		expect(build && grade(build, { metrics: { ...lean, toolCalls: 30, skills: 2, fullSuite: 1, issueReads: 1, refusals: 2 }, verified: false })).toEqual([
			"the work is wrong (verify failed)",
			"tool calls 30 > 12",
			"skill calls 2 > 0",
			"issue reads 1 > 0",
			"whole-suite runs 1 > 0",
			"refused commands 2 > 0",
		]);
	});
	it("fails a checker that passes a defect or edits the worktree", () => {
		expect(check && grade(check, { metrics: { ...lean, reply: "PASS" }, worktreeEdits: 1 })).toEqual(["verdict PASS, expected FAIL", "worktree edits 1 > 0"]);
	});
	it("every case has a source, a stage and a budget, and controls exist for both stages", () => {
		for (const c of CASES) expect(c.source && c.stage && c.limits.toolCalls).toBeTruthy();
		expect(new Set(CASES.filter((c) => c.control).map((c) => c.stage))).toEqual(new Set(["build", "test"]));
	});
});
