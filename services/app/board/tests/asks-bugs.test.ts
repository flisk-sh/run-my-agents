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
});
