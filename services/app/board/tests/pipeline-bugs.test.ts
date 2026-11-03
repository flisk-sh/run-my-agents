// Kitchen pipeline bugs found in a bug hunt: each test failed on main before its fix (issue number in its name).
// The harness is the scripted SDLC kitchen from sdlc.test.ts, with a per-test override of what an agent answers.
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
});
