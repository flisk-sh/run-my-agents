// Agent-container bugs found in a bug hunt: each test failed on main before its fix (issue number in its name).
import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/index";
import { freshChat, lessonsFor, readContainers, reconcile, strike } from "../src/kitchen/containers";
import { readHidden } from "../src/prefs";
import { parseSession, type Session } from "../src/sessions";

const now = Date.parse("2026-11-01T12:00:00Z");
const session = (id: string, role: string) => {
	const s = parseSession(id, [JSON.stringify({ type: "user", cwd: "/repo", message: { content: `${role} work` } })], now) as Session;
	return { ...s, role, updatedAt: now, asked: undefined };
};
let dir = "";
let skills = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rma-hunt-"));
	skills = mkdtempSync(join(tmpdir(), "rma-hunt-skills-"));
	process.env.RUN_MY_AGENTS_DIR = dir;
	process.env.RUN_MY_AGENTS_SKILLS_DIR = skills;
});

function setup(sessions: Session[] = [], deps: Parameters<typeof createApp>[2] = {}) {
	const started: { id?: string; model?: string; effort?: string; text: string }[] = [];
	const sent: string[] = [];
	const app = createApp(
		() => sessions,
		async (_, text) => {
			sent.push(text);
		},
		{
			start: async (n) => {
				started.push(n);
			},
			fetch: (async () => new Response("---\nname: x\n---\n")) as unknown as typeof fetch,
			...deps,
		},
	);
	const post = async (path: string, body: object) => {
		const r = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		return { status: r.status, body: await r.json() };
	};
	return { app, post, started, sent };
}
const task = (o: object) => ({ id: "t", n: 1, title: "fix it", cwd: "", priority: "P1", stage: "build", assignee: "", sentAt: 0, approved: true, skills: [], route: "Code", kind: "task", rounds: 0, stuck: false, created: 1, updated: 1, ...o });
const order = (o: object) => writeFileSync(join(dir, "tasks.json"), JSON.stringify([task(o)]));
const tasks = () => JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"));
const lessonsOf = () => readContainers().flatMap((c) => c.lessons.map((l) => l.reason));
const tester = (reply: string) => ({ ...session("tester", "Test"), feed: [{ who: "you", text: "Order", at: 1 } as never, { who: "agent", text: reply, at: 2 } as never] });

describe("agent container bugs", () => {
	it("#234: keeps the reason you gave when you fire an agent by hand, once", async () => {
		const sessions: Session[] = [];
		const { post, started } = setup(sessions);
		await post("/api/containers", { name: "Cooks", role: "Code", stages: ["build"], replicas: 1, cwd: "/repo", maxStrikes: 3 });
		await post("/api/containers/reconcile", {});
		await post("/api/containers/fire", { session: started[0].id, reason: "Kept editing files in the shared checkout instead of its worktree." });
		expect(lessonsOf()).toEqual(["Kept editing files in the shared checkout instead of its worktree."]);
	});
	it("#234: records one lesson, not maxStrikes copies, when you fire an agent with no reason", async () => {
		const sessions: Session[] = [];
		const { post, started } = setup(sessions);
		await post("/api/containers", { name: "Cooks", role: "Code", stages: ["build"], replicas: 1, cwd: "/repo", maxStrikes: 3 });
		await post("/api/containers/reconcile", {});
		await post("/api/containers/fire", { session: started[0].id });
		expect(lessonsOf()).toHaveLength(1);
	});
	it("#234: gives one strike and one real lesson for the FAIL that makes an order stuck", async () => {
		const sessions: Session[] = [tester("FAIL: mean([]) returns NaN, the empty list is not handled.")];
		const { post, started } = setup(sessions);
		await post("/api/containers", { name: "Build · repo", role: "Build", stages: ["build"], replicas: 1, cwd: "/repo", maxStrikes: 5 });
		await post("/api/containers/reconcile", {});
		const podId = readContainers()[0].pods[0].id;
		sessions.push(session(started[0].id as string, "Build"));
		order({ stage: "test", assignee: "tester", sentAt: 1, rounds: 2, crew: { build: { id: podId, role: "Build", name: "Build · repo abcd" } } });
		expect((await post("/api/tasks/serve", { id: "t", pass: false })).body.stuck).toBe(true);
		expect(readContainers()[0].pods[0].strikes).toBe(1);
		expect(lessonsOf().some((l) => /Stuck after \d+ rounds/.test(l))).toBe(false);
	});
	it("#234: never hands an agent a lesson cut off mid-word", async () => {
		const { post, started } = setup([]);
		await post("/api/containers", { name: "Build · repo", role: "Build", stages: ["build"], replicas: 1, cwd: "/repo", maxStrikes: 5 });
		await post("/api/containers/reconcile", {});
		const long = `FAIL: ${"the checkpoint write is not atomic under concurrent load and ".repeat(6)}loses data`;
		strike(started[0].id as string, "#1 fix it", long);
		const [l] = lessonsFor("build");
		expect(l.length).toBeLessThan(long.length);
		expect(long).toContain(`${l.replace(/^#1 fix it: /, "").replace(/…$/, "")} `);
	});
	it("#240: records the lesson of a FAIL found after the idle timer let the builder go", async () => {
		const sessions: Session[] = [];
		const { post, started } = setup(sessions);
		await post("/api/containers", { name: "Build · repo", role: "Build", stages: ["build"], replicas: 1, cwd: "/repo", maxStrikes: 3 });
		await post("/api/containers/reconcile", {});
		const podId = readContainers()[0].pods[0].id;
		sessions.push(session(started[0].id as string, "Build"));
		await post("/api/containers/reconcile", {});
		// Its build is done; Test has the order (assigned to a tester chat, so nothing else moves it).
		order({ stage: "test", cwd: "/repo", assignee: "tester", sentAt: Date.now(), crew: { build: { id: podId, role: "Build", name: "Build · repo abcd" } } });
		sessions.push(tester("FAIL: range(1,3) gave [1,2], the loop end is off by one."));
		// The scale route marks the container as sized by hand; make it an autoscaled one (floor 0) like the live ones.
		const boxes = JSON.parse(readFileSync(join(dir, "containers.json"), "utf8"));
		writeFileSync(join(dir, "containers.json"), JSON.stringify(boxes.map((b: object) => ({ ...b, floorByHand: undefined }))));
		await post("/api/kitchen", { auto: true }); // idle timer starts
		const later = JSON.parse(readFileSync(join(dir, "containers.json"), "utf8"));
		writeFileSync(join(dir, "containers.json"), JSON.stringify(later.map((b: { idleSince?: number }) => (b.idleSince ? { ...b, idleSince: Date.now() - 11 * 60_000 } : b))));
		await post("/api/kitchen", { auto: true }); // idle 11 min: let go
		await post("/api/containers/reconcile", {});
		expect(readContainers()[0].pods.find((p) => p.id === podId)?.status).toBe("evicted");
		await post("/api/tasks/serve", { id: "t", pass: false });
		expect(lessonsOf().join("\n")).toContain("the loop end is off by one");
	});
});

// keep imports used
void reconcile;
void freshChat;
void readHidden;
void lessonsFor;
void strike;
void tasks;
void tester;
