// Kitchen pipeline bugs found in a bug hunt: each test failed on main before its fix (issue number in its name).
// The harness is the scripted SDLC kitchen from sdlc.test.ts, with a per-test override of what an agent answers.
import { beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/index";
import { readContainers } from "../src/kitchen/containers";
import { parseSession, type Session } from "../src/sessions";

// Each case runs the real autopilot for up to 40 ticks: the preload's 30 s default did not reach this file in a full run (#313).
setDefaultTimeout(30_000);

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rma-hunt-"));
	process.env.RUN_MY_AGENTS_DIR = dir;
	process.env.RUN_MY_AGENTS_SKILLS_DIR = mkdtempSync(join(tmpdir(), "rma-hunt-skills-"));
});

function repo(remote = true) {
	const r = realpathSync(mkdtempSync(join(tmpdir(), "rma-hunt-repo-")));
	const g = (...a: string[]) => execFileSync("git", ["-C", r, ...a], { stdio: "ignore" });
	g("init", "-q", "-b", "main");
	if (remote) g("remote", "add", "origin", "https://github.com/acme/demo.git");
	writeFileSync(join(r, "math.ts"), "export const range = (a: number, b: number) => { const o = []; for (let i = a; i < b; i++) o.push(i); return o; };\n");
	g("add", ".");
	g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
	return r;
}

const TITLE = "fix the off-by-one in range() in math.ts so the end is included";
type Reply = (text: string, cwd: string) => string | undefined;
/**
 * The scripted kitchen. `over` answers first (undefined falls through to the good agent). `drop` makes a start fail:
 * the chat never appears on the board, the way a claude that cannot log in leaves no session.
 */
function kitchen(over: Reply = () => undefined, opts: { drop?: (text: string) => boolean; hang?: (text: string) => boolean; mode?: { build: "fix" | "nothing" } } = {}) {
	const mode = opts.mode ?? { build: "fix" };
	const good: Reply = (text, cwd) => {
		if (/^You are a \w+ agent/.test(text)) return "ready";
		if (/\(spec\)/.test(text)) return "Goal: range includes its end.\nWhy: callers expect 1..3 to give 3 numbers.\nChecks: range(1,3) is [1,2,3].\nFiles: math.ts";
		if (/\(build\)|no changes in this order's worktree/.test(text)) {
			if (mode.build === "nothing") return "The change is already there; nothing to do.";
			writeFileSync(join(cwd, "math.ts"), readFileSync(join(cwd, "math.ts"), "utf8").replace("i < b", "i <= b"));
			return "Changed math.ts: the loop now includes b. Check: range(1,3) is [1,2,3].";
		}
		if (/\(test\)/.test(text)) return "Ran range(1,3): [1,2,3].\n\nPASS — the end is included.";
		if (/\(review\)/.test(text)) return "Diff is one character in math.ts and matches the spec.\n\nPASS — correct and minimal.";
		if (/^Ship order/.test(text)) {
			try {
				execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "fix: range includes its end", "-s"], { stdio: "ignore" });
			} catch {
				return "Nothing new to commit; the branch is pushed and https://github.com/acme/demo/pull/42 is up to date.";
			}
			return "Committed and pushed. Opened https://github.com/acme/demo/pull/42";
		}
		return "Done.";
	};
	const reply: Reply = (text, cwd) => over(text, cwd) ?? good(text, cwd);
	const sessions: Session[] = [];
	const said: string[] = [];
	const talk = (s: Session, text: string) => {
		said.push(text);
		const answer = reply(text, s.cwd as string) as string;
		s.feed = [...s.feed, { who: "you", text, at: Date.now() } as never, { who: "agent", text: answer, at: Date.now() } as never];
		s.updatedAt = Date.now();
	};
	const app = createApp(
		() => sessions,
		async (s, text) => talk(sessions.find((x) => x.id === s.id) as Session, text),
		{
			start: async (n) => {
				if (opts.drop?.(n.text)) return;
				const s = { ...(parseSession(n.id as string, [JSON.stringify({ type: "user", cwd: n.cwd, message: { content: "start" } })], Date.now()) as Session), cwd: n.cwd, role: "Build", feed: [] };
				sessions.push(s);
				// A turn that never ends (a foreground dev server, a hung command): the chat shows the order, no reply.
				if (opts.hang?.(n.text)) {
					s.feed = [{ who: "you", text: n.text, at: Date.now() } as never];
					return new Promise<void>(() => {});
				}
				talk(s, n.text);
			},
			fetch: (async () => new Response("---\nname: x\n---\n")) as unknown as typeof fetch,
		},
	);
	const post = async (path: string, body: object) => (await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
	const tasks = () => JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"));
	const setTasks = (all: object[]) => writeFileSync(join(dir, "tasks.json"), JSON.stringify(all));
	const later = () => {
		for (const s of sessions) s.updatedAt = Date.now() - 10_000;
		setTasks(tasks().map((t: { sentAt: number }) => (t.sentAt ? { ...t, sentAt: Date.now() - 60_000 } : t)));
	};
	const tick = async () => {
		const r = await post("/api/kitchen", { auto: true });
		await post("/api/containers/reconcile", {});
		await Bun.sleep(5);
		later();
		return r.did as string[];
	};
	/** Ticks until order #1 is served (or `max` ticks), recording each stage it passed through. */
	const run = async (max = 40, until = () => tasks()[0].stage === "done") => {
		const stages: string[] = [];
		const log: string[] = [];
		for (let i = 0; i < max && !until(); i++) {
			log.push(...(await tick()));
			const st = tasks()[0].shipping ? "ship" : tasks()[0].stage;
			if (stages.at(-1) !== st) stages.push(st);
		}
		return { stages, log, t: tasks()[0] };
	};
	return { post, tasks, setTasks, tick, run, sessions, said, mode };
}

describe("kitchen pipeline bugs", () => {
	it("#256: a builder saying 'the change is in `<its worktree>`' builds once, keeps its worktree and ships a PR", async () => {
		const k = kitchen((text, cwd) => {
			if (!/\(build\)/.test(text)) return undefined;
			writeFileSync(join(cwd, "math.ts"), readFileSync(join(cwd, "math.ts"), "utf8").replace("i < b", "i <= b"));
			return `Changed math.ts: the loop includes b. The change is in \`${cwd}\`.`;
		});
		const r = repo();
		await k.post("/api/tasks", { title: TITLE, cwd: r });
		const { t } = await k.run();
		expect(k.said.filter((m) => m.startsWith("Order #1 (build)"))).toHaveLength(1);
		expect(t.cwd).toBe(r);
		expect(t.worktree).toBe(join(r, ".kitchen", "order-1"));
		expect(t.pr).toBe("https://github.com/acme/demo/pull/42");
	});

	it("#256: a spec naming its own worktree as 'Folder:' does not move the order into it", async () => {
		const k = kitchen((text, cwd) => (/\(spec\)/.test(text) ? `Goal: range includes its end.\nChecks: range(1,3) is [1,2,3].\nFolder: ${cwd}` : undefined));
		const r = repo();
		await k.post("/api/tasks", { title: TITLE, cwd: r });
		const { t } = await k.run();
		expect(t.cwd).toBe(r);
		expect(t.pr).toBe("https://github.com/acme/demo/pull/42");
	});

	it("#257: a Spec that ends 'FAIL: the decision that is missing' (as DECIDE tells it to) does not cross to Build", async () => {
		const k = kitchen((text) => {
			if (text.includes("nobody will approve or answer this")) return "FAIL: the decision that is missing: should range() include b, or should callers pass b+1?";
			if (/\(spec\)/.test(text)) return "Two readings are possible. Should range() include b, or should callers pass b+1?";
			return undefined;
		});
		await k.post("/api/tasks", { title: TITLE, cwd: repo() });
		const { stages, t } = await k.run(20);
		expect(stages).not.toContain("build");
		expect(t.notes?.spec ?? "").not.toStartWith("FAIL");
		expect((t.failures ?? []).join("\n")).toContain("the decision that is missing");
	});

	it("#257: reads only a verdict-style FAIL line as a block", async () => {
		const { endsInFail } = await import("../src/kitchen/routes");
		expect(endsInFail("Two readings.\n\n**FAIL: the decision that is missing: include b?**")).toBe("the decision that is missing: include b?");
		expect(endsInFail("Ran the suite.\nFAIL — no test runner in this repo")).toBe("no test runner in this repo");
		expect(endsInFail("Ran jest.\nFAIL src/math.test.ts")).toBeUndefined();
		expect(endsInFail("FAIL: early\nThen I fixed it. Changed math.ts.")).toBeUndefined();
		// #327: #72's spec, word for word.
		expect(endsInFail("Listed the worktree.\n\nVerdict: FAIL: Listed the worktree: only src/math.ts (range, sum) and tests/math.test.ts exist.")).toBe("Listed the worktree: only src/math.ts (range, sum) and tests/math.test.ts exist.");
		expect(endsInFail("**Verdict:** FAIL — src/geometry.ts does not exist")).toBe("src/geometry.ts does not exist");
		expect(endsInFail("Result: FAIL: no area() in this repo")).toBe("no area() in this repo");
		expect(endsInFail("Verdict: PASS")).toBeUndefined();
	});

	it("#255: an order taken back from an agent whose turn never ends goes to another agent", async () => {
		let hang = true;
		const k = kitchen(() => undefined, { hang: (text) => hang && text.startsWith("Order #1 (build)") });
		await k.post("/api/tasks", { title: TITLE, cwd: repo() });
		await k.run(30, () => k.tasks()[0].stage === "build" && !!k.tasks()[0].assignee);
		// 31 minutes with no progress: the miss timer strikes the agent and puts the order back on the belt.
		k.setTasks(k.tasks().map((t: object) => ({ ...t, sentAt: Date.now() - 31 * 60_000 })));
		for (const s of k.sessions) s.updatedAt = Date.now() - 31 * 60_000;
		await k.post("/api/containers/reconcile", {});
		expect(k.tasks()[0].assignee).toBe("");
		hang = false;
		const { t } = await k.run(30);
		expect(t.stage).toBe("done");
	});

	it("#254: a file someone else edits in the shared checkout during a build is not blamed on the builder", async () => {
		const r = repo();
		// The builder edits its worktree, as it should. Meanwhile you (or another session) edit a file in your checkout.
		const k = kitchen((text, cwd) => {
			if (!/\(build\)/.test(text)) return undefined;
			writeFileSync(join(cwd, "math.ts"), readFileSync(join(cwd, "math.ts"), "utf8").replace("i < b", "i <= b"));
			writeFileSync(join(r, "my-notes.md"), "my own uncommitted work\n");
			return "Changed math.ts: the loop now includes b.";
		});
		await k.post("/api/tasks", { title: TITLE, cwd: r });
		const { log, t } = await k.run();
		// The board told the builder to delete/restore a file it never touched, then failed a correct build.
		expect(k.said.filter((m) => m.includes("my-notes.md"))).toEqual([]);
		expect(log).not.toContain("#1 build edited the shared checkout: asked to move it");
		expect(t.failed).toBeFalsy();
		expect(existsSync(join(r, "my-notes.md"))).toBe(true);
	});

	it("#254: still catches a builder that edited the shared checkout itself", async () => {
		const r = repo();
		const k = kitchen((text, cwd) => {
			if (!/\(build\)|edits outside the worktree|changed files in the shared checkout/.test(text)) return undefined;
			// It changes its worktree, and also writes a test into the shared checkout by its absolute path (#163).
			writeFileSync(join(cwd, "math.ts"), readFileSync(join(cwd, "math.ts"), "utf8").replace("i < b", "i <= b"));
			writeFileSync(join(r, "math.test.ts"), "// range includes its end\n");
			// The build chat is the newest one in the worktree (Spec ran there too).
			[...k.sessions].reverse().find((x) => x.cwd === cwd)?.edits.push({ file: join(cwd, "math.ts"), at: Date.now() }, { file: join(r, "math.test.ts"), at: Date.now() });
			return "Changed math.ts: the loop now includes b.";
		});
		await k.post("/api/tasks", { title: TITLE, cwd: r });
		const { log, t } = await k.run();
		expect(log).toContain("#1 build edited the shared checkout: asked to move it");
		expect(t.failures.join("\n")).toContain("build: edited the shared checkout");
	});

	it("#235: a Test agent that goes quiet without a verdict does not strike the Build agent", async () => {
		const k = kitchen((text) => (/\(test\)|You stopped without a verdict/.test(text) ? "Let me run the tests.\n\nNo response requested." : undefined));
		await k.post("/api/tasks", { title: TITLE, cwd: repo() });
		await k.run(40, () => (k.tasks()[0].rounds ?? 0) >= 1 || !!k.tasks()[0].stuck || k.tasks()[0].stage === "done");
		expect(k.tasks()[0].rounds ?? 0).toBe(0);
		const build = readContainers().find((c) => c.stages.join() === "build");
		expect(build?.pods.reduce((a, p) => a + p.strikes, 0)).toBe(0);
		expect(build?.lessons.map((l) => l.reason) ?? []).toEqual([]);
		// The Test agent that gave no verdict is the one struck and taught.
		const test = readContainers().find((c) => c.stages.join() === "test");
		expect(test?.pods.reduce((a, p) => a + p.strikes, 0)).toBeGreaterThan(0);
		expect(test?.lessons.some((l) => l.reason.includes("stopped without a PASS or FAIL line"))).toBe(true);
	});

	it("#236: when Review fails what Test passed, the Test container learns it, with no strike", async () => {
		let reviews = 0;
		const k = kitchen((text) => {
			if (/\(review\)/.test(text) && reviews++ === 0) return "Read the diff.\n\nFAIL: range(0,0) returns [0], expected [].";
			return undefined;
		});
		await k.post("/api/tasks", { title: TITLE, cwd: repo() });
		await k.run();
		const test = readContainers().find((c) => c.stages.join() === "test");
		expect(test?.lessons.map((l) => l.reason)).toEqual(["FAIL: Test passed it; Review found: range(0,0) returns [0], expected []."]);
		expect(test?.pods.reduce((a, p) => a + p.strikes, 0)).toBe(0);
		// Build still gets its strike and lesson.
		expect(readContainers().find((c) => c.stages.join() === "build")?.lessons.length).toBe(1);
	});

	it("#258: a Ship step reclaimed after 30 min does not read the next Test agent's PASS as the ship's reply", async () => {
		let drop = true;
		const k = kitchen(() => undefined, { drop: (text) => drop && text.startsWith("Ship order") });
		await k.post("/api/tasks", { title: TITLE, cwd: repo() });
		// Run to the ship step; its agent never shows up on the board.
		await k.run(30, () => !!k.tasks()[0].shipping);
		expect(k.tasks()[0]).toMatchObject({ stage: "test", shipping: true });
		// 31 minutes later the miss timer reclaims it.
		k.setTasks(k.tasks().map((t: object) => ({ ...t, sentAt: Date.now() - 31 * 60_000 })));
		await k.post("/api/containers/reconcile", {});
		drop = false;
		const { t } = await k.run();
		expect((t.failures ?? []).filter((f: string) => f.includes("PASS"))).toEqual([]);
		expect(t).toMatchObject({ stage: "done", pr: "https://github.com/acme/demo/pull/42" });
	});

	it("#184: 'Back to build' on a stuck order lets it be dispatched again", async () => {
		const k = kitchen();
		await k.post("/api/kitchen", { auto: false });
		await k.post("/api/tasks", { title: TITLE, cwd: repo() });
		const id = k.tasks()[0].id;
		k.setTasks(k.tasks().map((t: object) => ({ ...t, stage: "test", approved: true, stuck: true, rounds: 3 })));
		const moved = await k.post("/api/tasks/move", { id, stage: "build" });
		expect(moved.stuck).toBe(false);
		k.sessions.push({ ...(parseSession("b1", [JSON.stringify({ type: "user", cwd: "/x", message: { content: "hi" } })], Date.now()) as Session), role: "Build" });
		const r = await k.post("/api/tasks/dispatch", { id, session: "b1" });
		expect(r.error ?? "").not.toContain("failed 3 times");
	});

	it("#184: moving an order that is shipping back to Build makes Build's reply a build, not a ship", async () => {
		let builds = 0;
		// The second build (after the move) makes a further change, as a real fix round would.
		const k = kitchen((text, cwd) => {
			if (!/^Order #1 \(build\)/.test(text) || builds++ === 0) return undefined;
			writeFileSync(join(cwd, "math.ts"), `${readFileSync(join(cwd, "math.ts"), "utf8")}// range includes its end\n`);
			return "Added a note on range().";
		});
		await k.post("/api/tasks", { title: TITLE, cwd: repo() });
		await k.run(40, () => !!k.tasks()[0].shipping);
		const moved = await k.post("/api/tasks/move", { id: k.tasks()[0].id, stage: "build" });
		expect(moved).toMatchObject({ stage: "build", shipping: false, stuck: false });
		const { stages, t } = await k.run();
		expect(stages[0]).toBe("build");
		expect(stages).toContain("test");
		expect(t.stage).toBe("done");
	});

	it("#259: moving an order to another repo by hand does not keep the old repo's worktree", async () => {
		const a = repo();
		const b = repo();
		const k = kitchen();
		await k.post("/api/kitchen", { auto: false });
		await k.post("/api/tasks", { title: TITLE, cwd: a });
		const id = k.tasks()[0].id;
		const { orderWorktree, headOf } = await import("../src/kitchen/routes");
		const wtA = orderWorktree(a, 1) as string;
		k.setTasks(k.tasks().map((t: object) => ({ ...t, stage: "build", approved: true, worktree: wtA, base: headOf(wtA) })));
		await k.post("/api/tasks/move", { id, cwd: b });
		k.sessions.push({ ...(parseSession("b1", [JSON.stringify({ type: "user", cwd: b, message: { content: "hi" } })], Date.now()) as Session), cwd: b, role: "Build" });
		await k.post("/api/tasks/dispatch", { id, session: "b1" });
		const sent = k.said.at(-1) ?? "";
		expect(sent).not.toContain(wtA);
		expect(k.tasks()[0].worktree ?? "").not.toBe(wtA);
	});

	it("#260: a follow-up's first failed ship is not counted as its second because of the parent's ship failure", async () => {
		const k = kitchen();
		const r = repo();
		await k.post("/api/tasks", { title: TITLE, cwd: r });
		const id = k.tasks()[0].id;
		// A follow-up (#1 follows up #9) carrying its parent's one ship failure; its own ship now opens no PR.
		k.sessions.push({ ...(parseSession("ship1", [JSON.stringify({ type: "user", cwd: r, message: { content: "Ship" } })], Date.now()) as Session), feed: [{ who: "you", text: "Ship order #1", at: 1 } as never, { who: "agent", text: "git push failed: could not read Username.", at: 2 } as never] });
		k.setTasks(k.tasks().map((t: object) => ({ ...t, stage: "test", approved: true, shipping: true, assignee: "ship1", sentAt: 1, retryOf: 9, failures: ["ship: no pull request. git push failed"], carried: 1 })));
		const res = await k.post("/api/tasks/serve", { id });
		expect(res).toMatchObject({ stage: "test", shipping: false });
		expect(res.stuck).toBe(false);
	});

	it("#261: a Done click for a step that already moved on does not serve the next agent's unfinished step", async () => {
		const k = kitchen();
		await k.post("/api/kitchen", { auto: false });
		await k.post("/api/tasks", { title: TITLE, cwd: repo() });
		const id = k.tasks()[0].id;
		// Autopilot moved it on and the Build agent started a second ago; your page still shows the spec card's "Done →".
		k.sessions.push({ ...(parseSession("b1", [JSON.stringify({ type: "user", cwd: "/x", message: { content: "Order #1 (build)" } })], Date.now()) as Session), role: "Build" });
		k.setTasks(k.tasks().map((t: object) => ({ ...t, stage: "build", approved: true, assignee: "b1", sentAt: Date.now() })));
		const r = await (await k.post("/api/tasks/serve", { id, stage: "spec", assignee: "spec-agent" }));
		expect(r.stage).toBe("build");
		expect(k.tasks()[0]).toMatchObject({ stage: "build", assignee: "b1" });
	});

	it("#261: the page's Done and Fail buttons send the step they showed", async () => {
		const { KITCHEN_JS } = await import("../src/kitchen/view");
		expect(KITCHEN_JS).toContain('post("api/tasks/serve",{id:t.id,pass,stage:t.stage,assignee:t.assignee||""})');
	});

	it("#308: Spec and Test are told a test that failed before the change is not its defect", async () => {
		const { STAGE_BRIEF } = await import("../src/kitchen/routes");
		expect(STAGE_BRIEF.spec).toContain("never 'the whole suite passes' when a test already fails before the change");
		expect(STAGE_BRIEF.test).toContain("A test that already fails on the branch the change started from");
		expect(STAGE_BRIEF.test).toContain("is not this change's defect: name it and PASS");
	});

	it("#308: serves a correct change in a repo whose suite already fails, when Test follows its brief", async () => {
		const k = kitchen((text) => {
			if (!/\(test\)/.test(text)) return undefined;
			// What the brief now asks: the old failure is named, the change itself is judged.
			return /already fails on the branch the change started from/.test(text)
				? "Ran bun test: 1 fail, 'ranges include the end', which fails on main too (git stash). The new code is correct.\n\nPASS — the only failure is pre-existing."
				: "Ran bun test: 1 fail.\n\nFAIL: 'ranges include the end' fails.";
		});
		await k.post("/api/tasks", { title: TITLE, cwd: repo() });
		const { t } = await k.run();
		expect(t).toMatchObject({ stage: "done" });
		expect(t.failed).toBeFalsy();
	});

	it("#176: the build round after a Test FAIL is told what failed", async () => {
		let tests = 0;
		const k = kitchen((text) => (/\(test\)/.test(text) && tests++ === 0 ? "Ran range(1,3): got [1,2].\n\nFAIL: range(1,3) gave [1,2], expected [1,2,3]" : undefined));
		await k.post("/api/tasks", { title: TITLE, cwd: repo() });
		const { t } = await k.run();
		const builds = k.said.filter((m) => m.startsWith("Order #1 (build)"));
		expect(builds.length).toBe(2);
		// Said as what to fix in this step, not only as a lesson from other orders (the Flisk path passes no lessons).
		expect(builds[1]).toContain("This step was sent back. Fix what the last check found:\n- test: FAIL: range(1,3) gave [1,2], expected [1,2,3]");
		expect(builds[0]).not.toContain("range(1,3) gave [1,2]");
		expect(t.stage).toBe("done");
	});

	it("#178: a requeued served order whose new build changes nothing is not served again on the old diff and PR", async () => {
		const k = kitchen();
		await k.post("/api/tasks", { title: TITLE, cwd: repo() });
		expect((await k.run()).t).toMatchObject({ stage: "done", pr: "https://github.com/acme/demo/pull/42" });
		// "Not what you asked for?" → Requeue. This time the builder makes no change.
		await k.post("/api/tasks/requeue", { id: k.tasks()[0].id });
		k.mode.build = "nothing";
		const { log, t } = await k.run();
		// The no-change guard compares with the first run's base, so the old (shipped) diff counts as this run's change.
		expect(log).toContain("#1 build made no changes: failed");
		expect(t.failed).toBe(true);
		// The spec step of the new run was handed the old run's verdicts, though it is told they do not apply.
		expect(k.said.filter((m) => m.startsWith("Order #1 (spec)")).at(-1)).not.toContain("From the Test agent");
	});

	it("#319: Spec is told not to invent what an order says to fix", async () => {
		const { STAGE_BRIEF } = await import("../src/kitchen/routes");
		expect(STAGE_BRIEF.spec).toContain("If the order asks to fix or change a file, function or behaviour that does not exist in this repo, do not create it");
	});

	it("#319: an order to fix a file that does not exist ends blocked, with no follow-up, when Spec follows its brief", async () => {
		const k = kitchen((text) =>
			/\(spec\)/.test(text) && text.includes("do not create it") ? "This repo has no src/geometry.ts and no area().\n\nFAIL: src/geometry.ts and area() do not exist in this repo" : undefined,
		);
		await k.post("/api/tasks", { title: "fix the crash in src/geometry.ts area() when the radius is negative", cwd: repo() });
		const { stages, t } = await k.run();
		expect(stages).not.toContain("build");
		expect(t).toMatchObject({ stage: "done", failed: true });
		expect(t.failures.join("\n")).toContain("spec: blocked: src/geometry.ts and area() do not exist");
		expect(t.followUp).toBeUndefined();
		expect(k.tasks()).toHaveLength(1);
	});

	it("#186: a Test reply whose last line is PASS is not turned into a FAIL because it quotes the word FAIL", async () => {
		const k = kitchen((text) => {
			if (text.includes("You stopped without a verdict")) return 'Re-ran: range(1,3) is [1,2,3], so the spec\'s "FAIL if b is missing" case does not happen.\n\nPASS';
			if (/\(test\)/.test(text)) return 'Ran range(1,3): [1,2,3]. The spec\'s check "FAIL if b is missing" holds.\n\nPASS';
			return undefined;
		});
		await k.post("/api/tasks", { title: TITLE, cwd: repo() });
		const { t } = await k.run();
		expect(t.failures ?? []).toEqual([]);
		expect(t.failed).toBeFalsy();
		expect(t.rounds).toBe(0);
	});

	it("#186: reads a verdict from the lines that start with it, not a word in a sentence", async () => {
		const { verdictIn } = await import("../src/kitchen/protocol");
		expect(verdictIn('The spec\'s check "FAIL if b is missing" holds: range(1,3) is [1,2,3].\n\nPASS')).toBe(true);
		expect(verdictIn("Ran it.\n\nVerdict: PASS")).toBe(true);
		// Still no verdict when two lines disagree, or one line says both.
		expect(verdictIn("FAIL: range(1,3) gave [1,2]\nPASS")).toBeUndefined();
		expect(verdictIn("PASS looks fine. Wait, FAIL: the date check returns 2013.")).toBeUndefined();
	});

	it("#187: a build round that changes nothing after Ship committed the last one is caught", async () => {
		let builds = 0;
		let reviews = 0;
		const k = kitchen((text) => {
			if (/^Order #1 \(build\)|no changes in this order's worktree/.test(text) && builds++ > 0) return "Looked again; the code already does this.";
			if (/\(review\)/.test(text) && reviews++ === 0) return "Read the PR.\n\nFAIL: range(0,0) returns [0], expected [].";
			return undefined;
		});
		await k.post("/api/tasks", { title: TITLE, cwd: repo() });
		const { log } = await k.run();
		// Round 1 shipped a commit; round 2 changed nothing, which must not pass as a change.
		expect(log).toContain("#1 build made no changes: failed");
	});

	it("#183: a question the front desk was answering when the board restarted is asked again, not left for 30 min", async () => {
		let asked = 0;
		const app = createApp(() => [], async () => {}, { ask: async (_q, _c, o) => (o?.system ? '{"ok": true}' : (asked++, "Paris.")), fetch: (async () => new Response("x")) as unknown as typeof fetch });
		const post = async (path: string, b: object) => (await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json();
		// What tasks.json holds after a restart mid-answer: assigned to the front desk, sent 2 minutes ago, no call running.
		writeFileSync(join(dir, "tasks.json"), JSON.stringify([{ id: "q", n: 1, title: "what is the capital of France?", cwd: "", kind: "question", priority: "P1", stage: "inbox", assignee: "front-desk", sentAt: Date.now() - 120_000, approved: false, skills: [], route: "Code", rounds: 0, stuck: false, created: 1, updated: 1 }]));
		await post("/api/kitchen", { auto: true });
		await post("/api/containers/reconcile", {});
		await Bun.sleep(10);
		const t = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))[0];
		expect(asked).toBe(1);
		expect(t).toMatchObject({ stage: "done", answer: "Paris." });
	});
});
