// End to end: one order through the whole kitchen on a real git repo, driven by the real autopilot loop.
// intake → spec → pass → build (real edit in the order's worktree) → test → review → ship (real commit) → served.
// The agents are scripted: each reads the message the board sent and answers the way a good agent would.
import { beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/index";
import { readContainers } from "../src/kitchen/containers";
import { parseSession, type Session } from "../src/sessions";

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rma-sdlc-"));
	process.env.RUN_MY_AGENTS_DIR = dir;
	process.env.RUN_MY_AGENTS_SKILLS_DIR = mkdtempSync(join(tmpdir(), "rma-sdlc-skills-"));
});

function repo(remote = true) {
	const r = realpathSync(mkdtempSync(join(tmpdir(), "rma-sdlc-repo-")));
	const g = (...a: string[]) => execFileSync("git", ["-C", r, ...a], { stdio: "ignore" });
	g("init", "-q", "-b", "main");
	if (remote) g("remote", "add", "origin", "https://github.com/acme/demo.git");
	writeFileSync(join(r, "math.ts"), "export const range = (a: number, b: number) => { const o = []; for (let i = a; i < b; i++) o.push(i); return o; };\n");
	g("add", ".");
	g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
	return r;
}

type Agent = (text: string, cwd: string) => string;
/** The scripted agents. `build` decides whether the builder really changes the file. */
/**
 * `ship` decides how many ship attempts fail (no PR in the reply) before one opens a PR. `tools`: every agent reply
 * comes with its tool calls, as a real turn's last feed item does.
 */
function kitchen(build: "fix" | "nothing", ship = 0, o: { tools?: boolean } = {}) {
	let shipFails = ship;
	const reply: Agent = (text, cwd) => {
		if (/^You are a \w+ agent/.test(text)) return "ready";
		if (/\(spec\)/.test(text)) return "Goal: range includes its end.\nWhy: callers expect 1..3 to give 3 numbers.\nChecks: range(1,3) is [1,2,3].\nFiles: math.ts";
		if (/\(build\)|no changes in this order's worktree/.test(text)) {
			if (build === "nothing") return "This build step cannot be completed without more information.";
			writeFileSync(join(cwd, "math.ts"), readFileSync(join(cwd, "math.ts"), "utf8").replace("i < b", "i <= b"));
			return "Changed math.ts: the loop now includes b. Check: range(1,3) is [1,2,3].";
		}
		if (/\(test\)/.test(text)) return "Ran range(1,3): [1,2,3].\n\nPASS — the end is included.";
		if (/\(review\)/.test(text)) return "Diff is one character in math.ts and matches the spec.\n\nPASS — correct and minimal.";
		if (/^Ship order/.test(text)) {
			if (shipFails-- > 0) return "git push failed: could not read Username for 'https://github.com'.";
			execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "fix: range includes its end", "-s"], { stdio: "ignore" });
			return "Committed and pushed. Opened https://github.com/acme/demo/pull/42";
		}
		return "Done.";
	};
	const sessions: Session[] = [];
	const talk = (s: Session, text: string) => {
		const answer = reply(text, s.cwd as string);
		s.feed = [...s.feed, { who: "you", text, at: Date.now() } as never, { who: "agent", text: answer, at: Date.now(), ...(o.tools ? { tools: [{ name: "Bash", input: "bun test" }] } : {}) } as never];
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
	/** Lets time pass: every agent has been quiet for a while, every order was sent a minute ago. */
	const later = () => {
		for (const s of sessions) s.updatedAt = Date.now() - 10_000;
		writeFileSync(join(dir, "tasks.json"), JSON.stringify(tasks().map((t: { sentAt: number }) => (t.sentAt ? { ...t, sentAt: Date.now() - 60_000 } : t))));
	};
	/** One autopilot pass plus the container loop, the way the server's 3 s tick runs them. */
	const tick = async () => {
		const r = await post("/api/kitchen", { auto: true });
		const c = await post("/api/containers/reconcile", {});
		await Bun.sleep(5);
		later();
		return r.did as string[];
	};
	return { post, tasks, tick, sessions };
}

describe("full SDLC, end to end", () => {
	it("takes one order from intake to a served pull request, every step through its own stage agent", async () => {
		const r = repo();
		const k = kitchen("fix");
		const order = await k.post("/api/tasks", { title: "fix the off-by-one in range() in math.ts so the end is included", cwd: r });
		expect(order).toMatchObject({ kind: "task", lane: "full", stage: "inbox" });

		const log: string[] = [];
		const stages: string[] = [];
		for (let i = 0; i < 30 && k.tasks()[0].stage !== "done"; i++) {
			log.push(...(await k.tick()));
			const st = k.tasks()[0].shipping ? "ship" : k.tasks()[0].stage;
			if (stages.at(-1) !== st) stages.push(st);
		}
		const t = k.tasks()[0];

		// Every stage, in order, and served: the PR is opened once tests pass, then the Review agent reviews that PR.
		expect(stages).toEqual(["spec", "build", "test", "ship", "review", "done"]);
		// The spec crossed the pass: autopilot approved it (approved, no longer waiting at the pass).
		expect(k.tasks()[0]).toMatchObject({ approved: true, atPass: false });
		expect(t).toMatchObject({ stage: "done", pr: "https://github.com/acme/demo/pull/42" });
		expect(t.failed).toBeFalsy();
		// One container per stage, each with its own type.
		expect(readContainers().map((c) => `${c.role}:${c.stages.join()}`).sort()).toEqual(["Build:build", "Review:review", "Spec:spec", "Test:test"]);
		// Each stage's work was handed on.
		expect(Object.keys(t.notes)).toEqual(["spec", "build", "test", "review"]);
		expect(t.notes.spec).toContain("Checks: range(1,3) is [1,2,3]");
		// The change lives on the order's branch, committed with sign-off, never in the main checkout.
		const wt = join(r, ".kitchen", "order-1");
		expect(t.worktree).toBe(wt);
		expect(execFileSync("git", ["-C", wt, "log", "-1", "--format=%s%n%b"], { encoding: "utf8" })).toContain("fix: range includes its end");
		expect(execFileSync("git", ["-C", wt, "log", "-1", "--format=%b"], { encoding: "utf8" })).toContain("Signed-off-by");
		expect(readFileSync(join(r, "math.ts"), "utf8")).toContain("i < b");
		expect(readFileSync(join(wt, "math.ts"), "utf8")).toContain("i <= b");
		// Spec works in the order's worktree too, so nothing it writes lands in the shared checkout, and it puts the
		// spec in its reply, where the next agents read it.
		const specChat = k.sessions.find((s) => s.feed.some((m) => String((m as { text?: string }).text).startsWith("Order #1 (spec)")));
		expect(specChat?.cwd).toBe(wt);
		expect(String((specChat?.feed.find((m) => String((m as { text?: string }).text).startsWith("Order #1 (spec)")) as { text?: string }).text)).toContain("do not write it to a file");
		expect(execFileSync("git", ["-C", r, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
		// Times are recorded.
		expect(t.startedAt).toBeGreaterThan(0);
		expect(t.servedAt).toBeGreaterThanOrEqual(t.startedAt);
		// Test and Review were given the spec and the build summary.
		const said = k.sessions.flatMap((s) => s.feed.filter((m) => m.who === "you").map((m) => String((m as { text?: string }).text)));
		expect(said.find((m) => m.startsWith("Order #1 (review)"))).toContain("From the Build agent:\nChanged math.ts");
		expect(said.find((m) => m.startsWith("Order #1 (review)"))).toContain("gh pr diff https://github.com/acme/demo/pull/42");
	});

	const run = async (k: ReturnType<typeof kitchen>) => {
		const stages: string[] = [];
		const log: string[] = [];
		for (let i = 0; i < 40 && k.tasks()[0].stage !== "done"; i++) {
			log.push(...(await k.tick()));
			const st = k.tasks()[0].shipping ? "ship" : k.tasks()[0].stage;
			if (stages.at(-1) !== st) stages.push(st);
		}
		return { stages, log, t: k.tasks()[0] };
	};

	it("serves a local-only repo (no remote) without a pull request: Review reads the branch", async () => {
		const k = kitchen("fix");
		await k.post("/api/tasks", { title: "fix the off-by-one in range() in math.ts so the end is included", cwd: repo(false) });
		const { stages, t } = await run(k);
		expect(stages).toEqual(["spec", "build", "test", "review", "done"]);
		expect(t.failed).toBeFalsy();
		expect(t.pr).toBeUndefined();
	});

	it("ships again after a ship that opened no pull request, instead of parking the order", async () => {
		const k = kitchen("fix", 1);
		await k.post("/api/tasks", { title: "fix the off-by-one in range() in math.ts so the end is included", cwd: repo() });
		const { stages, t } = await run(k);
		expect(stages).toEqual(["spec", "build", "test", "ship", "test", "ship", "review", "done"]);
		expect(t).toMatchObject({ stage: "done", pr: "https://github.com/acme/demo/pull/42" });
		expect(t.failed).toBeFalsy();
		expect(t.failures).toEqual(["ship: no pull request. git push failed: could not read Username for 'https://github.com'."]);
	});

	it("fails an order whose ship opens no pull request twice, saying why", async () => {
		const k = kitchen("fix", 9);
		await k.post("/api/tasks", { title: "fix the off-by-one in range() in math.ts so the end is included", cwd: repo() });
		const { stages, t } = await run(k);
		expect(stages).toEqual(["spec", "build", "test", "ship", "test", "ship", "done"]);
		expect(t).toMatchObject({ stage: "done", failed: true, followUp: 2 });
		expect(t.failures.filter((f: string) => f.startsWith("ship: no pull request"))).toHaveLength(2);
	});

	it("moves an order a failed ship parked at 'ship' back to Test", async () => {
		const k = kitchen("fix");
		const r = repo(false);
		await k.post("/api/tasks", { title: "fix the off-by-one in range() in math.ts so the end is included", cwd: r });
		writeFileSync(join(dir, "tasks.json"), JSON.stringify(k.tasks().map((t: object) => ({ ...t, stage: "ship", approved: true, assignee: "", shipping: false }))));
		const { log, t } = await run(k);
		expect(log).toContain("#1 was parked at ship: back to test");
		expect(t.stage).toBe("done");
	});

	it("moves on as soon as a step's agent is quiet, even though its last message carries tool calls (#228)", async () => {
		// A parsed turn is one feed item with all its tool calls; the board read every finished step as mid-turn for 30 s.
		const k = kitchen("fix", 0, { tools: true });
		await k.post("/api/tasks", { title: "fix the off-by-one in range() in math.ts so the end is included", cwd: repo(false) });
		const { stages, t } = await run(k);
		expect(stages).toEqual(["spec", "build", "test", "review", "done"]);
		expect(t.failed).toBeFalsy();
	});

	it("never hands an empty build to Test: asks again, then fails the order and opens a follow-up", async () => {
		const r = repo();
		const k = kitchen("nothing");
		await k.post("/api/tasks", { title: "fix the off-by-one in range() in math.ts so the end is included", cwd: r });
		const log: string[] = [];
		for (let i = 0; i < 30 && k.tasks()[0].stage !== "done"; i++) log.push(...(await k.tick()));
		const [t, follow] = k.tasks();
		expect(log.filter((l) => l === "#1 build left no changes: asked again")).toHaveLength(2);
		expect(log).toContain("#1 build made no changes: failed");
		expect(log.some((l) => l.startsWith("#1 test"))).toBe(false);
		expect(t).toMatchObject({ stage: "done", failed: true, followUp: 2 });
		expect(t.failures[0]).toContain("build: no changes made in the worktree");
		expect(follow).toMatchObject({ n: 2, retryOf: 1, kind: "task" });
		expect(existsSync(join(r, ".kitchen", "order-1"))).toBe(true);
	});
});

describe("ship guard", () => {
	it("serves an order whose worktree has nothing to commit without starting a Ship agent", async () => {
		const r = repo();
		const { orderWorktree, headOf } = await import("../src/kitchen/routes");
		const wt = orderWorktree(r, 5) as string;
		const started: string[] = [];
		const app = createApp(() => [], async () => {}, { start: async (n) => void started.push(n.text) });
		writeFileSync(join(dir, "tasks.json"), JSON.stringify([{ id: "t", n: 5, title: "x", cwd: r, worktree: wt, base: headOf(wt), kind: "task", priority: "P1", stage: "review", assignee: "rev", sentAt: 1, approved: true, skills: [], route: "Code", rounds: 0, stuck: false, created: 1, updated: 1, notes: { build: "Nothing to do." } }]));
		const res = await (await app.request("/api/tasks/serve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "t", pass: true }) })).json();
		expect(res).toMatchObject({ stage: "done" });
		expect(started.filter((t) => t.startsWith("Ship order"))).toEqual([]);
	});
});

describe("worktree location", () => {
	it("keeps order worktrees out of .git (agents cannot edit there), hidden from git status, and moves an old one", async () => {
		const r = repo();
		const { orderWorktree } = await import("../src/kitchen/routes");
		const wt = orderWorktree(r, 3) as string;
		expect(wt).toBe(join(r, ".kitchen", "order-3"));
		expect(wt.includes("/.git/")).toBe(false);
		expect(execFileSync("git", ["-C", r, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
		// A worktree made under .git/kitchen before this fix moves to .kitchen with its branch and its edits.
		execFileSync("git", ["-C", r, "worktree", "add", join(r, ".git", "kitchen", "order-4"), "-b", "kitchen/order-4"], { stdio: "ignore" });
		writeFileSync(join(r, ".git", "kitchen", "order-4", "note.txt"), "work in progress");
		const moved = orderWorktree(r, 4) as string;
		expect(moved).toBe(join(r, ".kitchen", "order-4"));
		expect(readFileSync(join(moved, "note.txt"), "utf8")).toBe("work in progress");
		expect(execFileSync("git", ["-C", moved, "branch", "--show-current"], { encoding: "utf8" }).trim()).toBe("kitchen/order-4");
		expect(existsSync(join(r, ".git", "kitchen", "order-4"))).toBe(false);
	});
});

describe("full SDLC through the Flisk kitchen agent", () => {
	it("serves an order with every step as one agent turn: no chats, no waiting, questions answered, PR kept", async () => {
		const r = repo();
		const turns: string[] = [];
		const inputs: Record<string, string> = {};
		const agent = async (session: string, t: { input: string; cwd?: string }) => {
			turns.push(`${session}: ${t.input.split("\n")[0].slice(0, 60)}`);
			inputs[session] ??= t.input;
			const cwd = t.cwd as string;
			if (session.includes("-spec-ask-")) return t.input.includes("Goal: range includes its end.") ? "Yes: include b itself." : "Not in the record";
			if (session.endsWith("-spec")) return "Goal: range includes its end.\nChecks: range(1,3) is [1,2,3].";
			if (session.endsWith("-build") && t.input.startsWith("Order #")) return 'Reading the spec.\n```kitchen\n{"ask": {"to": "spec", "question": "should range include b itself?"}}\n```';
			if (session.endsWith("-build")) {
				writeFileSync(join(cwd, "math.ts"), readFileSync(join(cwd, "math.ts"), "utf8").replace("i < b", "i <= b"));
				return "Changed math.ts: the loop includes b.";
			}
			if (session.endsWith("-test")) return "Ran it.\n\nPASS — range(1,3) is [1,2,3].";
			if (session.endsWith("-review")) return "One-character diff, matches the spec.\n\nPASS — correct.";
			if (session.endsWith("-ship")) {
				execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qsam", "fix: range includes its end"], { stdio: "ignore" });
				return "Opened https://github.com/acme/demo/pull/77";
			}
			return "?";
		};
		const app = createApp(() => [], async () => {}, { agent, fetch: (async () => new Response("x")) as unknown as typeof fetch });
		const post = async (path: string, b: object) => (await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json();
		const tasks = () => JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"));
		await post("/api/tasks", { title: "fix the off-by-one in range() in math.ts so the end is included", cwd: r });
		for (let i = 0; i < 20 && tasks()[0].stage !== "done"; i++) {
			await post("/api/kitchen", { auto: true });
			await Bun.sleep(30);
		}
		const t = tasks()[0];
		expect(t).toMatchObject({ stage: "done", pr: "https://github.com/acme/demo/pull/77" });
		expect(t.failed).toBeFalsy();
		// Each step was one session on the agent; the builder's ask was a fresh turn on the Spec record, not the Spec session.
		expect(turns.map((x) => x.split(":")[0])).toEqual(["order-1-spec", "order-1-build", "order-1-spec-ask-1", "order-1-build", "order-1-test", "order-1-ship", "order-1-review"]);
		expect(t.talk.map((x: { from: string; to: string }) => `${x.from}→${x.to}`)).toEqual(["Build→Spec", "Spec→Build"]);
		// Every message the agent got says, as data, who sent it, what it is, and what reply it wants.
		const { envelopeIn } = await import("../src/kitchen/protocol");
		expect(envelopeIn(inputs["order-1-build"])).toMatchObject({ from: "Orchestrator", to: "Build", type: "order", order: 1, expects: "record", context: { worktree: expect.stringContaining("order-1"), round: 0, records: ["spec"] } });
		expect(envelopeIn(inputs["order-1-spec-ask-1"])).toMatchObject({ from: "Build", to: "Spec", type: "question", expects: "answer", context: { records: ["spec"] } });
		expect(envelopeIn(inputs["order-1-ship"])).toMatchObject({ to: "Ship", type: "order", stage: "ship", expects: "pr", context: { records: ["build"] } });
		expect(envelopeIn(inputs["order-1-test"])?.expects).toBe("verdict");
		expect(t.crew.build).toMatchObject({ id: "flisk:order-1-build", name: "Build · Flisk agent" });
		expect(readFileSync(join(r, ".kitchen", "order-1", "math.ts"), "utf8")).toContain("i <= b");
		expect(readFileSync(join(r, "math.ts"), "utf8")).toContain("i < b");
		expect(readContainers()).toEqual([]);
	});

	it("fails a test step whose agent turn crashed, instead of waiting", async () => {
		const r = repo();
		const agent = async (session: string, t: { cwd?: string }) => {
			if (session.endsWith("-test")) throw new Error("claude exited with 1");
			if (session.endsWith("-build")) writeFileSync(join(t.cwd as string, "math.ts"), "x\n");
			return "ok";
		};
		const app = createApp(() => [], async () => {}, { agent });
		const post = async (path: string, b: object) => (await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json();
		writeFileSync(join(dir, "tasks.json"), JSON.stringify([{ id: "t", n: 1, title: "x", cwd: r, kind: "task", priority: "P1", stage: "build", assignee: "", sentAt: 0, approved: true, skills: [], route: "Code", rounds: 0, stuck: false, created: 1, updated: 1 }]));
		for (let i = 0; i < 4; i++) {
			await post("/api/kitchen", { auto: true });
			await Bun.sleep(30);
		}
		const t = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))[0];
		expect(t.failures.some((f: string) => f.includes("the Flisk kitchen agent could not run this turn"))).toBe(true);
		expect(t.rounds).toBeGreaterThan(0);
	});
});
