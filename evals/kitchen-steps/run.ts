#!/usr/bin/env bun
// Kitchen step eval: sends a real model the brief the board sends for one step (imported from source, never copied),
// in a throwaway repo, and grades what it does: right work, and how many steps it took to get there.
//
//   bun evals/kitchen-steps/run.ts --out evals/runs/now
//   bun evals/kitchen-steps/run.ts --out evals/runs/old --ref 2e61498      # the briefs at an earlier commit
//   bun evals/kitchen-steps/run.ts --out evals/runs/now --baseline evals/runs/old --case build-follows-spec
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { KITCHEN_TOOLS, kitchenFlags } from "../../services/app/board/src/kitchen/containers";
import type { Task } from "../../services/app/board/src/kitchen/pipeline";
import { lessonsSkill, policyFor, skillset } from "../../services/app/board/src/kitchen/skills";
import { zachman } from "../../services/app/board/src/kitchen/triage";
import { type Case, CASES } from "./cases";
import { grade, metrics, type Sample } from "./grade";

const { values: a } = parseArgs({
	options: {
		out: { type: "string" },
		case: { type: "string", multiple: true },
		samples: { type: "string", default: "3" },
		model: { type: "string" },
		effort: { type: "string" },
		ref: { type: "string" },
		baseline: { type: "string" },
		concurrency: { type: "string", default: "2" },
		timeout: { type: "string", default: "15" },
	},
});
if (!a.out) {
	console.error("--out <dir> is required");
	process.exit(2);
}
const root = resolve(import.meta.dir, "../..");
const out = resolve(a.out);
mkdirSync(join(out, "transcripts"), { recursive: true });
const cases = a.case?.length ? CASES.filter((c) => a.case?.includes(c.id)) : CASES;
if (!cases.length) throw new Error(`No case named ${a.case?.join(", ")}. Cases: ${CASES.map((c) => c.id).join(", ")}`);
const sh = (cmd: string, cwd: string) => spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });

type Brief = (order: Task, use: string[], wt: string | undefined, learned?: string[]) => string;
type Mod = { orderText?: Brief; STAGE_BRIEF: Record<string, string>; ADDRESS: string; MAX_STEP_SKILLS?: number };

/** The board's brief builder: from this checkout, or from `--ref` (a git worktree of that commit, sharing node_modules). */
async function loadBriefs(): Promise<{ mod: Mod; label: string }> {
	if (!a.ref) return { mod: (await import("../../services/app/board/src/kitchen/routes")) as Mod, label: "this checkout" };
	const dir = mkdtempSync(join(tmpdir(), "rma-eval-ref-"));
	rmSync(dir, { recursive: true });
	const add = sh(`git worktree add --detach ${JSON.stringify(dir)} ${JSON.stringify(a.ref)}`, root);
	if (add.status !== 0) throw new Error(add.stderr);
	process.on("exit", () => sh(`git worktree remove --force ${JSON.stringify(dir)}`, root));
	for (const p of ["services/app/board/node_modules", "services/app/web/node_modules"])
		if (existsSync(join(root, p)) && !existsSync(join(dir, p))) symlinkSync(join(root, p), join(dir, p));
	const rev = sh("git rev-parse --short HEAD", dir).stdout.trim();
	return { mod: (await import(join(dir, "services/app/board/src/kitchen/routes.ts"))) as Mod, label: `ref ${a.ref} (${rev})` };
}

/**
 * Briefs from before orderText was exported (PR #361) are put together the way the board did then: its own STAGE_BRIEF
 * and ADDRESS, the card, the notes, and "Use these skills" over the stage's set. Approximate: say so in the summary.
 */
function legacyBrief(mod: Mod): Brief {
	return (o, use, wt) => {
		const verdict = o.stage === "test" || o.stage === "review";
		const z = o.zachman ? `\n\nZachman card:\n- What: ${o.zachman.what}\n- How: ${o.zachman.how}\n- Where: ${o.zachman.where}\n- Who: ${o.zachman.who}\n- When: ${o.zachman.when}\n- Why: ${o.zachman.why}` : "";
		const notes = (["spec", "build"] as const).filter((s) => s !== o.stage && o.notes?.[s]).map((s) => `\n\nFrom the ${s[0].toUpperCase()}${s.slice(1)} agent:\n${o.notes?.[s]}`).join("");
		const where = wt ? `\n\nYou are in this order's own git worktree: ${wt} (branch kitchen/order-${o.n}). Work only there.` : "";
		const diff = verdict && wt && o.base ? `\n\nThe change to check is \`git -C ${wt} diff ${o.base}\` (plus untracked files in \`git -C ${wt} status\`). Judge it, not the summary above.` : "";
		return `Order #${o.n} (${o.stage}): ${o.title}${z}${notes}${where}${diff}\n\nYour job: ${mod.STAGE_BRIEF[o.stage].replaceAll("{n}", String(o.n))}\n\nUse these skills: ${use.map((n) => `/${n}`).join(", ")}.\n\n${verdict ? "Run commands in the foreground and wait for their results; never end your turn while one still runs. End with your verdict record." : `When this ${o.stage} step is finished, say so in one line.`}\n\n${mod.ADDRESS}`;
	};
}

/** Every file in the worktree (tracked or new) with a hash of its content, to see what a checker changed. */
function snapshot(dir: string): Map<string, string> {
	const files = sh("git ls-files -co --exclude-standard", dir).stdout.split("\n").filter(Boolean);
	return new Map(files.map((f) => [f, existsSync(join(dir, f)) ? createHash("sha1").update(readFileSync(join(dir, f))).digest("hex") : "gone"]));
}
const changed = (x: Map<string, string>, y: Map<string, string>) => new Set([...x.keys(), ...y.keys()].filter((f) => x.get(f) !== y.get(f))).size;

function repoFor(c: Case): { dir: string; base: string } {
	const dir = mkdtempSync(join(tmpdir(), `rma-eval-${c.id}-`));
	const write = (files: Record<string, string>) => {
		for (const [f, body] of Object.entries(files)) {
			mkdirSync(dirname(join(dir, f)), { recursive: true });
			writeFileSync(join(dir, f), body);
		}
	};
	write(c.files);
	sh("git init -q -b main && git add -A && git -c user.email=eval@example.com -c user.name=eval commit -qm base", dir);
	const base = sh("git rev-parse HEAD", dir).stdout.trim();
	if (c.change) write(c.change);
	return { dir, base };
}

async function runOne(c: Case, k: number, brief: Brief, maxSkills: number | undefined): Promise<Sample & { case: string; sample: number; why: string[]; pass: boolean }> {
	const { dir, base } = repoFor(c);
	const policy = policyFor(c.stage, { model: a.model, effort: a.effort });
	const task = {
		id: `eval-${c.id}`, n: 89, title: c.title, cwd: dir, priority: "P1", stage: c.stage, assignee: "", sentAt: 0, approved: true,
		skills: [], route: "Bug", rounds: 0, stuck: false, kind: "task", notes: c.notes, base, worktree: dir, created: 0, updated: 0,
		zachman: zachman({ title: c.title, cwd: dir, priority: "P1", route: "Bug", skills: [], kind: "task" }),
	} as Task;
	const use = [...skillset(c.stage).slice(0, maxSkills ?? Number.POSITIVE_INFINITY), lessonsSkill(c.stage)];
	const input = brief(task, use, dir, []);
	writeFileSync(join(out, "transcripts", `${c.id}-${k}.brief.md`), input);
	const before = snapshot(dir);
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PID$|CLAUDE_EFFORT$)/.test(key)));
	const args = ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--permission-mode", "acceptEdits", "--model", policy.model, "--effort", policy.effort, ...kitchenFlags(), "--allowedTools", ...KITCHEN_TOOLS];
	const started = Date.now();
	const transcript = await new Promise<{ text: string; error?: string }>((done) => {
		const child = spawn("claude", args, { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
		let text = "";
		let err = "";
		const kill = setTimeout(() => child.kill("SIGTERM"), Number(a.timeout) * 60_000);
		child.stdout.on("data", (d) => (text += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("error", (e) => done({ text, error: e.message }));
		child.on("close", (code, signal) => {
			clearTimeout(kill);
			done({ text, ...(signal ? { error: `timed out after ${a.timeout} min` } : code ? { error: `claude exited ${code}: ${err.trim().slice(-300)}` } : {}) });
		});
		child.stdin.end(input);
	});
	writeFileSync(join(out, "transcripts", `${c.id}-${k}.jsonl`), transcript.text);
	const m = metrics(transcript.text, Date.now() - started);
	const sample: Sample = {
		metrics: m,
		...(transcript.error ? { error: transcript.error } : {}),
		...(c.verify ? { verified: sh(c.verify, dir).status === 0 } : {}),
		...(c.stage !== "build" ? { worktreeEdits: changed(before, snapshot(dir)) } : {}),
	};
	const why = grade(c, sample);
	rmSync(dir, { recursive: true, force: true });
	return { ...sample, metrics: { ...m, reply: m.reply.slice(-1500) }, case: c.id, sample: k, why, pass: why.length === 0 };
}

const median = (xs: number[]) => {
	const s = [...xs].sort((x, y) => x - y);
	return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

type Row = Awaited<ReturnType<typeof runOne>>;
function summarize(rows: Row[]) {
	return Object.fromEntries(
		cases.map((c) => {
			const r = rows.filter((x) => x.case === c.id);
			const m = (f: (x: Row) => number) => median(r.map(f));
			return [c.id, { passed: r.filter((x) => x.pass).length, samples: r.length, pass: r.filter((x) => x.pass).length * 2 > r.length, toolCalls: m((x) => x.metrics.toolCalls), skills: m((x) => x.metrics.skills), fullSuite: m((x) => x.metrics.fullSuite), issueReads: m((x) => x.metrics.issueReads), costUsd: m((x) => x.metrics.costUsd), seconds: Math.round(m((x) => x.metrics.durationMs) / 1000) }];
		}),
	);
}

const { mod, label } = await loadBriefs();
const brief = mod.orderText ?? legacyBrief(mod);
const jobs = cases.flatMap((c) => Array.from({ length: Number(a.samples) }, (_, k) => () => runOne(c, k + 1, brief, mod.MAX_STEP_SKILLS)));
const rows: Row[] = [];
let next = 0;
await Promise.all(
	Array.from({ length: Number(a.concurrency) }, async () => {
		while (next < jobs.length) {
			const r = await jobs[next++]();
			rows.push(r);
			writeFileSync(join(out, "results.jsonl"), rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
			console.log(`${r.pass ? "pass" : "FAIL"} ${r.case} #${r.sample}: ${r.metrics.toolCalls} tool calls, $${r.metrics.costUsd.toFixed(3)}${r.why.length ? ` (${r.why.join("; ")})` : ""}`);
		}
	}),
);

const now = summarize(rows);
const before = a.baseline ? (JSON.parse(readFileSync(join(resolve(a.baseline), "summary.json"), "utf8")) as { cases: ReturnType<typeof summarize>; briefs: string }) : undefined;
writeFileSync(join(out, "summary.json"), JSON.stringify({ briefs: label, legacy: !mod.orderText, cases: now }, null, "\t"));
const delta = (id: string, k: "toolCalls" | "costUsd" | "seconds") => {
	const b = before?.cases[id]?.[k];
	return b === undefined ? "" : ` (${now[id][k] - b >= 0 ? "+" : ""}${k === "costUsd" ? (now[id][k] - b).toFixed(3) : now[id][k] - b})`;
};
const lines = [
	`# Kitchen step eval`,
	"",
	`Briefs: ${label}${mod.orderText ? "" : " — assembled the old way, approximate (that commit predates orderText)"}. ${a.samples} samples per case; a case passes when more than half its samples do.${before ? ` Compared with ${before.briefs}.` : ""}`,
	"",
	"| case | pass | tool calls | skills | whole suite | issue reads | cost $ | seconds |",
	"| --- | --- | --- | --- | --- | --- | --- | --- |",
	...cases.map((c) => {
		const s = now[c.id];
		return `| ${c.id}${c.control ? " (control)" : ""} | ${s.pass ? "yes" : "**no**"} ${s.passed}/${s.samples} | ${s.toolCalls}${delta(c.id, "toolCalls")} | ${s.skills} | ${s.fullSuite} | ${s.issueReads} | ${s.costUsd.toFixed(3)}${delta(c.id, "costUsd")} | ${s.seconds}${delta(c.id, "seconds")} |`;
	}),
	"",
	`Total cost: $${rows.reduce((x, r) => x + r.metrics.costUsd, 0).toFixed(2)}. Medians per case; transcripts and the exact briefs sent are in transcripts/.`,
	"",
	...rows.filter((r) => !r.pass).map((r) => `- ${r.case} #${r.sample}: ${r.why.join("; ")}`),
];
writeFileSync(join(out, "summary.md"), lines.join("\n") + "\n");
console.log(`\n${lines.join("\n")}`);
