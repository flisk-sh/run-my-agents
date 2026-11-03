// "Nobody replies to the kitchen agents": what the board does when an agent ends its turn waiting on someone, using
// lines real kitchen agents wrote (order numbers in the test names). Each test failed on main before its fix (#issue).
import { beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/index";
import { asksBack } from "../src/kitchen/routes";
import { parseSession, type Session } from "../src/sessions";

// Each case runs the real autopilot for up to 40 ticks: the preload's 30 s default did not reach this file in a full run (#313).
setDefaultTimeout(30_000);

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rma-asks-"));
	process.env.RUN_MY_AGENTS_DIR = dir;
	process.env.RUN_MY_AGENTS_SKILLS_DIR = mkdtempSync(join(tmpdir(), "rma-asks-skills-"));
});

function repo() {
	const r = realpathSync(mkdtempSync(join(tmpdir(), "rma-asks-repo-")));
	const g = (...a: string[]) => execFileSync("git", ["-C", r, ...a], { stdio: "ignore" });
	g("init", "-q", "-b", "main");
	g("remote", "add", "origin", "https://github.com/acme/demo.git");
	writeFileSync(join(r, "math.ts"), "export const range = (a: number, b: number) => { const o = []; for (let i = a; i < b; i++) o.push(i); return o; };\n");
	g("add", ".");
	g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
	return r;
}

/** The sdlc.test.ts harness, with per-stage scripts: each script gets the message and how many times its stage was messaged. */
type Script = (text: string, cwd: string, nth: number) => string;
function kitchen(over: Partial<Record<"spec" | "build" | "test" | "review" | "ship", Script>> = {}) {
	const seen: Record<string, number> = {};
	const stageOf = (text: string) =>
		/^Ship order/.test(text) ? "ship" : (/\((spec|build|test|review)\)/.exec(text)?.[1] ?? (/"stage":"(\w+)"/.exec(text)?.[1] as string | undefined));
	const fix = (cwd: string) => writeFileSync(join(cwd, "math.ts"), readFileSync(join(cwd, "math.ts"), "utf8").replace("i < b", "i <= b"));
	const base: Record<string, Script> = {
		spec: () => "Goal: range includes its end.\nChecks: range(1,3) is [1,2,3].\nFiles: math.ts",
		build: (_t, cwd) => {
			fix(cwd);
			return "Changed math.ts: the loop now includes b.";
		},
		test: () => "Ran range(1,3): [1,2,3].\n\nPASS — the end is included.",
		review: () => "One-character diff.\n\nPASS — correct and minimal.",
		ship: (_t, cwd) => {
			execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qsam", "fix: range includes its end"], { stdio: "ignore" });
			return "Committed and pushed. Opened https://github.com/acme/demo/pull/42";
		},
	};
	/** The stage a chat was started for: a nudge or a policy message goes to the same script as its order. */
	const chatStage = new Map<string, string>();
	const reply = (text: string, cwd: string, id: string) => {
		if (/^You are a \w+ agent/.test(text)) return "ready";
		const own = /^(?:Order #\d+ \(|Ship order)/.test(text) ? stageOf(text) : undefined;
		if (own) chatStage.set(id, own);
		const st = chatStage.get(id) ?? stageOf(text) ?? "build";
		seen[st] = (seen[st] ?? 0) + 1;
		return (over[st as keyof typeof over] ?? base[st] ?? (() => "Done."))(text, cwd, seen[st]);
	};
	const sessions: Session[] = [];
	const said: { to: string; text: string }[] = [];
	const talk = (s: Session, text: string) => {
		said.push({ to: s.id, text });
		const answer = reply(text, s.cwd as string, s.id);
		s.feed = [...s.feed, { who: "you", text, at: Date.now() } as never, { who: "agent", text: answer, at: Date.now() } as never];
		s.updatedAt = Date.now();
	};
	const app = createApp(
		() => sessions,
		async (s, text) => talk(sessions.find((x) => x.id === s.id) as Session, text),
		{
			start: async (n) => {
				const s = { ...(parseSession(n.id as string, [JSON.stringify({ type: "user", cwd: n.cwd, message: { content: "start" } })], Date.now()) as Session), cwd: n.cwd, role: "Build", feed: [] };
				sessions.push(s);
				talk(s, n.text);
			},
			fetch: (async () => new Response("---\nname: x\n---\n")) as unknown as typeof fetch,
		},
	);
	const post = async (path: string, body: object) => (await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
	const tasks = () => JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"));
	const later = () => {
		for (const s of sessions) s.updatedAt = Date.now() - 10_000;
		writeFileSync(join(dir, "tasks.json"), JSON.stringify(tasks().map((t: { sentAt: number }) => (t.sentAt ? { ...t, sentAt: Date.now() - 60_000 } : t))));
	};
	const tick = async () => {
		const r = await post("/api/kitchen", { auto: true });
		await post("/api/containers/reconcile", {});
		await Bun.sleep(5);
		later();
		return r.did as string[];
	};
	const run = async (max = 40) => {
		const stages: string[] = [];
		const log: string[] = [];
		for (let i = 0; i < max && tasks()[0].stage !== "done"; i++) {
			log.push(...(await tick()));
			const st = tasks()[0].shipping ? "ship" : tasks()[0].stage;
			if (stages.at(-1) !== st) stages.push(st);
		}
		return { stages, log, t: tasks()[0] };
	};
	return { post, tasks, tick, run, sessions, said };
}

const TITLE = "fix the off-by-one in range() in math.ts so the end is included";

describe("asks and records the board must answer", () => {
	it("#250: stops the order with the Ship agent's blocked reason instead of re-running Test (#43, #44)", async () => {
		const k = kitchen({ ship: () => 'I committed the change.\n\n```kitchen\n{"blocked": "Cannot push: gh is not logged in on this computer."}\n```' });
		await k.post("/api/tasks", { title: TITLE, cwd: repo() });
		const { stages, t } = await k.run();
		// Today: the blocked record is ignored (`!t.shipping`), the ship counts as "no pull request", Test runs again and
		// Ship is asked again: ["spec","build","test","ship","test","ship","done"].
		expect(stages).toEqual(["spec", "build", "test", "ship", "done"]);
		expect(t.failures.some((f: string) => f.includes("blocked: Cannot push"))).toBe(true);
	});
	it("#250: answers a Ship agent's ask record instead of reading it as a ship with no PR (#42)", async () => {
		const k = kitchen({
			ship: (text, cwd, nth) => {
				if (nth === 1) return 'Before pushing:\n\n```kitchen\n{"ask": {"to": "build", "question": "Should the test file be part of this commit?"}}\n```';
				execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qsam", "fix: range"], { stdio: "ignore" });
				return "Opened https://github.com/acme/demo/pull/42";
			},
		});
		await k.post("/api/tasks", { title: TITLE, cwd: repo() });
		const { t, stages } = await k.run();
		expect(t.failures ?? []).toEqual([]);
		expect(stages).toEqual(["spec", "build", "test", "ship", "review", "done"]);
	});
	it("#252: does not read Claude Code's synthetic 'No response requested.' as the agent's reply (36 kitchen turns)", () => {
		const lines = [
			{ type: "user", cwd: "/w", timestamp: "2026-11-02T19:56:54.000Z", message: { content: "Order #19 (build): fix it" } },
			{ type: "assistant", timestamp: "2026-11-02T19:57:22.000Z", message: { model: "claude-opus-5", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git worktree add x" } }] } },
			{ type: "user", timestamp: "2026-11-02T19:57:22.100Z", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "This command requires approval", is_error: true }] } },
			{ type: "user", isMeta: true, timestamp: "2026-11-02T19:57:40.000Z", message: { content: [{ type: "text", text: "Continue from where you left off." }] } },
			{ type: "assistant", timestamp: "2026-11-02T19:57:40.100Z", message: { model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] } },
		].map((e) => JSON.stringify(e));
		const s = parseSession("2a270e7f-3407-4ddd-9f22-beaa4c94caf8", lines, Date.now()) as Session;
		const said = s.feed.filter((f) => f.who === "agent").map((f) => f.text).join("\n");
		expect(said).not.toContain("No response requested.");
	});
	it("#251: catches a question that is followed by a handoff record (recordIn() short-circuits asksBack)", () => {
		const text = 'Spec draft: range(1,3) should be [1,2,3].\n\nShall I proceed with this scope, or should Build also change range2()?\n\n```kitchen\n{"handoff": "Goal: range includes its end."}\n```';
		expect(asksBack(text, { stage: "spec" })).toBe(true);
	});
	it("#251: catches an ask record addressed to someone who is not a stage (the user, the orchestrator)", () => {
		// recordIn drops the ask (to is not spec/build/test/review), returns undefined, and asksBack's last line is the fence.
		const text = 'Two folders could hold this code.\n\n```kitchen\n{"ask": {"to": "user", "question": "Is the code in flisk or in flisk-candidate-test-draft?"}}\n```';
		expect(asksBack(text, { stage: "build" })).toBe(true);
	});
	const build = { stage: "build" } as const;
	// Each line is the last line of a real kitchen turn that waited on a person; asksBack() returns false for all.
	for (const [order, line] of [
		["#18 build", "Build complete: clamp function implemented with 16 comprehensive tests; commit pending approval."],
		["#15 build", "Ready for next step (test phase) once commit is approved."],
		["#12 build", "FAIL: Cannot modify routes.ts in non-interactive session — write permissions require approval, but approval is unavailable without interactive session."],
		["#20 build", "Waiting for the exploration agent to identify task-opening code in flisk."],
		["#19 build", "Resubmit with a concrete bug/fix target and I'll build it."],
		["#20 build", "**Submit actionable clarification** with those details so I can build a fix with proper test coverage."],
		["#21 build", "**To proceed**: Spec agent must clarify the above three points and name the target (Cloudflare Workers, RMA agent pool, etc.), then resubmit to build."],
	] as const)
		it(`#251: catches ${order}: ${line.slice(0, 50)}`, () => {
			expect(asksBack(`I looked at the code.\n\n${line}`, build)).toBe(true);
		});
	it("#253: gives the Ship agent its own answer budget: Test's answers do not use it up", async () => {
		const k = kitchen({
			// Test asks twice (two DECIDE answers), then gives its verdict.
			test: (_t, _c, nth) => (nth === 1 ? "Should I run the full suite?" : nth === 2 ? "Should I also run lint?" : "Ran it.\n\nPASS — range(1,3) is [1,2,3]."),
			// Ship stops once to ask, the way #12's Ship agent did, then ships when told to decide.
			ship: (text, cwd, nth) => {
				if (nth === 1) return "I need to create the kitchen/order-1 branch.\n\nWould you like me to proceed with creating the branch and shipping order #1?";
				execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qsam", "fix: range"], { stdio: "ignore" });
				return "Opened https://github.com/acme/demo/pull/42";
			},
		});
		await k.post("/api/tasks", { title: TITLE, cwd: repo() });
		const { t, log } = await k.run();
		// Today `answered` is per stage and Ship runs while the stage is still "test", so it inherits answered=2: the
		// question gets no reply and the step counts as "ship: no pull request".
		expect(log.filter((l) => l === "#1 answered test agent's question")).toHaveLength(3);
		expect(t.failures ?? []).toEqual([]);
	});
	it("#253: is addressed to Ship and expects a pull request, not to Test with a verdict", async () => {
		const { envelopeIn } = await import("../src/kitchen/protocol");
		const k = kitchen({
			ship: (text, cwd, nth) => {
				if (nth === 1) return "Would you like me to proceed with creating the branch and shipping order #1?";
				execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qsam", "fix: range"], { stdio: "ignore" });
				return "Opened https://github.com/acme/demo/pull/42";
			},
		});
		await k.post("/api/tasks", { title: TITLE, cwd: repo() });
		await k.run();
		const policy = k.said.find((m) => m.text.startsWith("This is the kitchen's orchestrator") && k.said.some((o) => o.to === m.to && o.text.startsWith("Ship order")));
		// Today post() builds it from t.stage, which stays "test" while shipping: {"to":"Test","stage":"test","expects":"verdict"}.
		expect(envelopeIn(policy?.text ?? "")).toMatchObject({ to: "Ship", stage: "ship", expects: "pr" });
	});
});
