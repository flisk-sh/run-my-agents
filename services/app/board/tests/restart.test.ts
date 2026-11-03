// #172: after a board restart the in-memory busy set is empty while agents' `claude -p` processes keep running.
import { beforeEach, describe, expect, it } from "bun:test";
import { type ChildProcess, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, markDone, markRunning, stillRunning } from "../src/index";
import { parseSession, type Session } from "../src/sessions";

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rma-restart-"));
	process.env.RUN_MY_AGENTS_DIR = dir;
	process.env.RUN_MY_AGENTS_SKILLS_DIR = mkdtempSync(join(tmpdir(), "rma-restart-skills-"));
});

function repo() {
	const r = realpathSync(mkdtempSync(join(tmpdir(), "rma-restart-repo-")));
	const g = (...a: string[]) => execFileSync("git", ["-C", r, ...a], { stdio: "ignore" });
	g("init", "-q", "-b", "main");
	writeFileSync(join(r, "math.ts"), "export const range = (a: number, b: number) => { const o = []; for (let i = a; i < b; i++) o.push(i); return o; };\n");
	g("add", ".");
	g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
	return r;
}

describe("a board restart while an agent is mid-turn (#172)", () => {
	it("knows a process it started is still running after its in-memory record is gone", async () => {
		markRunning("chat-a", process.pid);
		expect(stillRunning("chat-a")).toBe(true);
		markDone("chat-a");
		expect(stillRunning("chat-a")).toBe(false);
		// A process that exited is not running, and its entry is dropped.
		const gone = Bun.spawnSync(["true"]).pid;
		markRunning("chat-b", gone);
		expect(stillRunning("chat-b")).toBe(false);
		expect(JSON.parse(readFileSync(join(dir, "running.json"), "utf8"))["chat-b"]).toBeUndefined();
	});

	it("does not move an order on while its build agent's process still runs", async () => {
		const r = repo();
		const sessions: Session[] = [];
		let build: ChildProcess | undefined;
		const talk = (s: Session, text: string, answer: string) => {
			s.feed = [...s.feed, { who: "you", text, at: Date.now() } as never, { who: "agent", text: answer, at: Date.now() } as never];
			s.updatedAt = Date.now();
		};
		const app = createApp(
			() => sessions,
			async () => {},
			{
				// The start returns at once, as after a restart (in-memory busy is gone), while the build's process runs on.
				start: async (n, run) => {
					const s = { ...(parseSession(n.id as string, [JSON.stringify({ type: "user", cwd: n.cwd, message: { content: "start" } })], Date.now()) as Session), cwd: n.cwd, role: "Build", feed: [] };
					sessions.push(s);
					if (/^Order #1 \(build\)/.test(n.text)) {
						talk(s, n.text, "Changed math.ts. Let me run the tests now…");
						writeFileSync(join(n.cwd, "math.ts"), readFileSync(join(n.cwd, "math.ts"), "utf8").replace("i < b", "i <= b"));
						build = run?.("sleep", ["30"], {});
						return;
					}
					talk(s, n.text, /\(spec\)/.test(n.text) ? "Goal: include the end.\nChecks: range(1,3) is [1,2,3]." : /^You are a/.test(n.text) ? "ready" : "Ran it.\n\nPASS — fine.");
				},
				fetch: (async () => new Response("---\nname: x\n---\n")) as unknown as typeof fetch,
			},
		);
		const post = async (path: string, body: object) => (await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
		const tasks = () => JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"));
		const tick = async () => {
			await post("/api/kitchen", { auto: true });
			await post("/api/containers/reconcile", {});
			await Bun.sleep(5);
			for (const s of sessions) s.updatedAt = Date.now() - 10_000;
			writeFileSync(join(dir, "tasks.json"), JSON.stringify(tasks().map((t: { sentAt: number }) => (t.sentAt ? { ...t, sentAt: Date.now() - 60_000 } : t))));
		};
		await post("/api/tasks", { title: "fix the off-by-one in range() in math.ts so the end is included", cwd: r });
		for (let i = 0; i < 20 && !build; i++) await tick();
		expect(build?.pid).toBeGreaterThan(0);
		for (let i = 0; i < 5; i++) await tick();
		// Still building: the agent has said only "Let me run the tests now…", and its process is alive.
		expect(tasks()[0].stage).toBe("build");
		build?.kill();
		await new Promise((res) => build?.on("close", res));
		for (let i = 0; i < 3 && tasks()[0].stage === "build"; i++) await tick();
		expect(tasks()[0].stage).not.toBe("build");
	});
});
