// The grader: plain logic over a `claude -p --output-format stream-json` transcript, so it is unit-tested in CI.
import type { Case } from "./cases";

export type Call = { name: string; input: Record<string, unknown> };
export type Metrics = {
	toolCalls: number;
	byTool: Record<string, number>;
	skills: number;
	issueReads: number;
	fullSuite: number;
	/** Files read more than once. */
	rereads: number;
	turns: number;
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	durationMs: number;
	/** The step's final reply. */
	reply: string;
};

/** Tool calls and the result line of a stream-json transcript. Lines that are not JSON are skipped. */
export function parseTranscript(text: string): { calls: Call[]; result?: Record<string, unknown> } {
	const calls: Call[] = [];
	let result: Record<string, unknown> | undefined;
	for (const line of text.split("\n")) {
		let ev: Record<string, unknown>;
		try {
			ev = JSON.parse(line);
		} catch {
			continue;
		}
		if (ev.type === "result") result = ev;
		const content = (ev.type === "assistant" ? (ev.message as { content?: unknown[] } | undefined)?.content : undefined) ?? [];
		for (const c of content as { type?: string; name?: string; input?: Record<string, unknown> }[])
			if (c.type === "tool_use" && c.name) calls.push({ name: c.name, input: c.input ?? {} });
	}
	return { calls, result };
}

/** Where a test runner's own arguments start: `bun test …`, `bun run test …`, `npm test …`, `npx vitest run …`. */
const RUNNER = /^(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test|(?:npx\s+)?(?:vitest(?:\s+run)?|jest))(?:\s+|$)/;

/**
 * A command that runs a whole test suite: a test runner with no file, directory or test name after it.
 * `bun test x.test.ts`, `bun run test tests/a.test.ts` and `bun test -t name` are targeted; `bun test`, `npm test`
 * and `cd cli && bun run test` are not.
 */
export function runsWholeSuite(command: string): boolean {
	return command.split(/&&|\|\||;|\|/).some((part) => {
		const m = RUNNER.exec(part.trim());
		if (!m) return false;
		const args = part.trim().slice(m[0].length).split(/\s+/).filter(Boolean);
		const named = args.some((w, j) => (w === "-t" || w === "--test-name-pattern") && args[j + 1]);
		const paths = args.filter((w, j) => !w.startsWith("-") && !/^\d+$/.test(w) && !/^\d*[<>]/.test(w) && !["-t", "--test-name-pattern"].includes(args[j - 1] ?? ""));
		return !named && paths.length === 0;
	});
}

const ISSUE = /\/issues\/\d+|\bgh\s+issue\s+(?:view|list)|\bgh\s+api\s+\S*issues/;

export function metrics(transcript: string, durationMs = 0): Metrics {
	const { calls, result } = parseTranscript(transcript);
	const byTool: Record<string, number> = {};
	const reads = new Map<string, number>();
	let issueReads = 0;
	let fullSuite = 0;
	for (const c of calls) {
		byTool[c.name] = (byTool[c.name] ?? 0) + 1;
		const cmd = c.name === "Bash" ? String(c.input.command ?? "") : "";
		const url = String(c.input.url ?? "");
		if ((c.name === "WebFetch" && ISSUE.test(url)) || (cmd && ISSUE.test(cmd))) issueReads++;
		if (cmd && runsWholeSuite(cmd)) fullSuite++;
		if (c.name === "Read") {
			const f = String(c.input.file_path ?? "");
			reads.set(f, (reads.get(f) ?? 0) + 1);
		}
	}
	const usage = (result?.usage ?? {}) as Record<string, number>;
	return {
		toolCalls: calls.length,
		byTool,
		skills: byTool.Skill ?? 0,
		issueReads,
		fullSuite,
		rereads: [...reads.values()].filter((n) => n > 1).length,
		turns: Number(result?.num_turns ?? 0),
		costUsd: Number(result?.total_cost_usd ?? 0),
		inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
		outputTokens: usage.output_tokens ?? 0,
		durationMs: Number(result?.duration_ms ?? durationMs),
		reply: String(result?.result ?? ""),
	};
}

/** The verdict in a Test or Review reply: its `kitchen` record, else a last line starting with PASS or FAIL. */
export function verdictOf(reply: string): "PASS" | "FAIL" | undefined {
	const blocks = [...reply.matchAll(/```kitchen[^\S\n]*\n([\s\S]*?)\n?```/g)];
	for (const b of blocks.reverse()) {
		try {
			const v = String(JSON.parse(b[1]).verdict ?? "").toUpperCase();
			if (v === "PASS" || v === "FAIL") return v;
		} catch {}
	}
	const last = reply.trim().split("\n").at(-1) ?? "";
	return /^\W*(PASS|FAIL)\b/i.exec(last)?.[1]?.toUpperCase() as "PASS" | "FAIL" | undefined;
}

export type Sample = { metrics: Metrics; verified?: boolean; worktreeEdits?: number; error?: string };

/** Why a sample fails its case; empty when it passes. Correctness first, then the step budget. */
export function grade(c: Case, s: Sample): string[] {
	if (s.error) return [`error: ${s.error}`];
	const why: string[] = [];
	const m = s.metrics;
	if (c.verify && !s.verified) why.push("the work is wrong (verify failed)");
	if (c.verdict) {
		const v = verdictOf(m.reply);
		if (v !== c.verdict) why.push(`verdict ${v ?? "missing"}, expected ${c.verdict}`);
	}
	const over = (what: string, got: number, max: number | undefined) => {
		if (max !== undefined && got > max) why.push(`${what} ${got} > ${max}`);
	};
	over("tool calls", m.toolCalls, c.limits.toolCalls);
	over("skill calls", m.skills, c.limits.skills);
	over("issue reads", m.issueReads, c.limits.issueReads);
	over("whole-suite runs", m.fullSuite, c.limits.fullSuite);
	over("worktree edits", s.worktreeEdits ?? 0, c.limits.worktreeEdits);
	return why;
}
