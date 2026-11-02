import { beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/index";
import { parseSession, type Session } from "../src/sessions";
import { beltOrder, MAX_ROUNDS, nextStage, sendBack, type Task } from "../src/kitchen/pipeline";
import { bowl, scoreboard } from "../src/kitchen/scores";

const now = Date.parse("2026-11-01T12:00:00Z");
const line = (o: object) => JSON.stringify(o);
const session = (id: string, role: string, title: string) => {
	const s = parseSession(id, [line({ type: "user", cwd: "/repo", message: { content: title } })], now) as Session;
	return { ...s, role, updatedAt: now };
};

let skills = "";
beforeEach(() => {
	process.env.RUN_MY_AGENTS_DIR = mkdtempSync(join(tmpdir(), "rma-tasks-"));
	skills = mkdtempSync(join(tmpdir(), "rma-skills-"));
	process.env.RUN_MY_AGENTS_SKILLS_DIR = skills;
});

describe("orders", () => {
	const app = (sessions: Session[], sent: string[] = [], fetched: string[] = []) => {
		const a = createApp(
			() => sessions,
			async (_, text) => {
				sent.push(text);
			},
			{
				fetch: (async (url: string) => {
					fetched.push(String(url));
					return new Response("---\nname: x\n---\n");
				}) as unknown as typeof fetch,
			},
		);
		const post = async (path: string, body: object) => {
			const r = await a.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
			return { status: r.status, body: await r.json() };
		};
		return { a, post };
	};

	it("puts an order on the belt with skills, and installs them", async () => {
		const fetched: string[] = [];
		const { a, post } = app([], [], fetched);
		const r = await post("/api/tasks", { title: "write playwright tests for the login page", priority: "P0" });
		expect(r.status).toBe(201);
		expect(r.body).toMatchObject({ n: 1, stage: "inbox", priority: "P0" });
		expect(r.body.skills.length).toBeGreaterThan(0);
		await Bun.sleep(5);
		expect(fetched[0]).toStartWith("https://raw.githubusercontent.com/");
		const list = await (await a.request("/api/tasks")).json();
		expect(list.tasks[0].skills.every((k: { state: string }) => k.state === "ok")).toBe(true);
		expect((await post("/api/tasks", { title: "  " })).status).toBe(400);
		expect((await post("/api/tasks", { title: "x", priority: "P9" })).status).toBe(400);
	});

	it("dispatches to the agent you name and moves through the pass", async () => {
		const sent: string[] = [];
		const planner = session("p", "Planner", "plan things");
		const coder = session("c", "Code", "code things");
		const { post } = app([planner, coder], sent);
		const t = (await post("/api/tasks", { title: "add search filters to the sessions list with saved views" })).body;
		await Bun.sleep(5);
		const d = await post("/api/tasks/dispatch", { id: t.id, session: "p" });
		expect(d.status).toBe(202);
		expect(d.body).toMatchObject({ stage: "spec", assignee: "p" });
		expect(sent[0]).toContain("Order #1 (spec): add search filters to the sessions list with saved views");
		// The spec waits at the pass until approved.
		expect((await post("/api/tasks/serve", { id: t.id })).body.stage).toBe("spec");
		await post("/api/tasks/move", { id: t.id, approved: true, stage: "build" });
		const b = await post("/api/tasks/dispatch", { id: t.id, session: "c" });
		expect(b.body).toMatchObject({ stage: "build", assignee: "c" });
		expect(b.body.crew).toMatchObject({ spec: { id: "p", role: "Planner" }, build: { id: "c", role: "Code" } });
	});

	it("only sends an order to a chat you name yourself, and says why one waits", async () => {
		const { a, post } = app([session("c", "Code", "x")]);
		writeFileSync(join(process.env.RUN_MY_AGENTS_DIR as string, "tasks.json"), JSON.stringify([{ id: "t", n: 1, title: "x", cwd: "", priority: "P1", stage: "spec", assignee: "", sentAt: 0, approved: false, skills: [], route: "Code", rounds: 0, stuck: false, created: 1, updated: 1 }]));
		// Pressing Dispatch never picks one of your chats: name the agent (drop the ticket on it) to use one.
		expect((await post("/api/tasks/dispatch", { id: "t" })).body.error).toContain("No agent container cooks spec");
		expect((await post("/api/tasks/dispatch", { id: "t", session: "c" })).body).toMatchObject({ assignee: "c", model: "opus", effort: "medium" });
		// It is already with that agent, so a second press does not send it again.
		expect((await post("/api/tasks/dispatch", { id: "t", session: "other" })).body.error).toContain("already with Code");
		writeFileSync(join(process.env.RUN_MY_AGENTS_DIR as string, "tasks.json"), JSON.stringify([{ id: "t", n: 1, title: "x", cwd: "", priority: "P1", stage: "inbox", assignee: "", sentAt: 0, approved: false, skills: [], route: "Code", rounds: 0, stuck: false, created: 1, updated: 1 }, { id: "u", n: 2, title: "y", cwd: "", priority: "P1", stage: "build", assignee: "c", sentAt: 1, approved: true, skills: [], route: "Code", rounds: 0, stuck: false, created: 1, updated: 1 }]));
		const list = await (await a.request("/api/tasks")).json();
		expect(list.tasks.find((t: { id: string }) => t.id === "t").why).toContain("No agent container cooks spec");
		expect((await app([]).a.request("/api/tasks")).status).toBe(200);
		writeFileSync(join(process.env.RUN_MY_AGENTS_DIR as string, "tasks.json"), JSON.stringify([{ id: "t", n: 1, title: "x", cwd: "", priority: "P1", stage: "build", assignee: "", sentAt: 0, approved: true, skills: ["not-in-catalog"], route: "Code", rounds: 0, stuck: false, created: 1, updated: 1 }]));
		expect((await post("/api/tasks/dispatch", { id: "t" })).status).toBe(409);
	});

	it("sends a failed test back to build, and stops after three rounds", async () => {
		const { post } = app([]);
		mkdirSync(skills, { recursive: true });
		writeFileSync(join(process.env.RUN_MY_AGENTS_DIR as string, "tasks.json"), JSON.stringify([{ id: "t", n: 1, title: "x", cwd: "", priority: "P1", stage: "test", assignee: "s", sentAt: 1, approved: true, skills: [], route: "Code", rounds: 0, stuck: false, created: 1, updated: 1 }]));
		expect((await post("/api/tasks/serve", { id: "t", pass: false })).body).toMatchObject({ stage: "build", rounds: 1, assignee: "" });
		const saved = JSON.parse(readFileSync(join(process.env.RUN_MY_AGENTS_DIR as string, "tasks.json"), "utf8"));
		expect(saved[0].rounds).toBe(1);
		expect((await post("/api/tasks/serve", { id: "t" })).body.stage).toBe("test");
		expect((await post("/api/tasks/serve", { id: "t" })).body.stage).toBe("review");
		expect((await post("/api/tasks/serve", { id: "t" })).body.stage).toBe("done");
	});
});

describe("order rules", () => {
	const base: Task = { id: "a", n: 1, title: "x", cwd: "", priority: "P1", stage: "test", assignee: "", sentAt: 0, approved: true, skills: [], route: "Code", rounds: 0, stuck: false, created: 1, updated: 1 };
	it("puts P0 first, then the oldest", () => {
		const order = beltOrder([{ ...base, id: "old", created: 1 }, { ...base, id: "new", created: 2 }, { ...base, id: "hot", priority: "P0", created: 3 }]);
		expect(order.map((t) => t.id)).toEqual(["hot", "old", "new"]);
	});
	it("holds an unapproved spec at the pass", () => {
		expect(nextStage({ ...base, stage: "spec", approved: false })).toBe("spec");
		expect(nextStage({ ...base, stage: "spec", approved: true })).toBe("build");
	});
	it("marks an order stuck after MAX_ROUNDS fails", () => {
		expect(sendBack({ ...base, rounds: MAX_ROUNDS - 1 })).toEqual({ stage: "test", rounds: MAX_ROUNDS, stuck: true });
	});
});

describe("scoreboard", () => {
	const cook = (id: string) => ({ id, role: id === "a" ? "Planner" : "Code", name: id.toUpperCase() });
	const served = (n: number, rounds: number, crew: string[], extra: Partial<Task> = {}): Task => ({
		id: `t${n}`, n, title: `order ${n}`, cwd: "", priority: "P1", stage: "done", assignee: "", sentAt: 0, approved: true,
		skills: ["tdd"], route: "Code", rounds, stuck: false, created: n, updated: n, servedAt: n, kind: "task",
		crew: { spec: cook(crew[0]), build: cook(crew[1] ?? crew[0]) }, ...extra,
	});
	it("scores a perfect game as 300", () => {
		const game = Array.from({ length: 10 }, (_, i) => served(i + 1, 0, ["a"]));
		expect(bowl(game).at(-1)?.total).toBe(300);
	});
	it("adds bonus pins for strikes and spares, nothing for a gutter", () => {
		const f = bowl([served(1, 0, ["a"]), served(2, 1, ["a"]), served(3, 2, ["a"]), served(4, 3, ["a"], { stuck: true })]);
		expect(f.map((x) => x.mark)).toEqual(["X", "/", "4", "-"]);
		// X: 10 + 10 + 4 = 24; /: 10 + 4 = 14; 4; gutter 0
		expect(f.map((x) => x.total)).toEqual([24, 38, 42, 42]);
	});
	it("ranks agents, pairs and skills from served orders only", () => {
		const open = { ...served(9, 0, ["a", "b"]), stage: "build" as const };
		const sb = scoreboard([served(1, 0, ["a", "b"]), served(2, 1, ["b"]), open]);
		expect(sb.served).toBe(2);
		expect(sb.agents.map((r) => r.label)).toEqual(["B", "A"]);
		expect(sb.pairs).toHaveLength(1);
		expect(sb.pairs[0]).toMatchObject({ label: "A + B", served: 1, score: 10 });
		expect(sb.skills[0]).toMatchObject({ key: "tdd", served: 2 });
	});
});

describe("kitchen page", () => {
	it("has a drawing function for every tab, and its script parses", async () => {
		const { KITCHEN_JS } = await import("../src/kitchen/view");
		const tabs = [...(KITCHEN_JS.match(/const KT=\[(.*?)\];/)?.[1] ?? "").matchAll(/\["(\w+)","\w+"\]/g)].map((m) => m[1]).filter((t) => t !== "chat");
		expect(tabs).toEqual(["queue", "kitchen", "lanes", "scores", "crew"]);
		for (const t of tabs) expect(KITCHEN_JS).toContain(`function k${t[0].toUpperCase()}${t.slice(1)}(`);
		expect(() => new Function(KITCHEN_JS)).not.toThrow();
	});
});

describe("live ratings", () => {
	const { ratings } = require("../src/kitchen/scores") as typeof import("../src/kitchen/scores");
	const cook = (id: string, role = "Code") => ({ id, role, name: id });
	const base: Task = { id: "x", n: 1, title: "x", cwd: "", priority: "P1", stage: "done", assignee: "", sentAt: 0, approved: true, skills: [], route: "Code", rounds: 0, stuck: false, created: 1, updated: 1, kind: "task" };
	it("rates agents from every order, served or not", () => {
		const rs = ratings(
			[
				{ ...base, crew: { spec: cook("p", "Planner"), build: cook("b") } },
				{ ...base, id: "y", stage: "test", rounds: 2, stuck: true, assignee: "t", crew: { build: cook("b"), test: cook("t", "Bug") } },
			],
			{ b: 1 },
		);
		expect(rs.find((r) => r.id === "p")).toMatchObject({ steps: 1, served: 1, rating: 63 });
		// b: 2 steps, 1 served, 2 fails, 1 stuck, 1 strike: 50 + 10 + 6 - 16 - 15 - 10 = 25
		expect(rs.find((r) => r.id === "b")).toMatchObject({ steps: 2, served: 1, fails: 2, stuck: 1, strikes: 1, rating: 25 });
		expect(rs.find((r) => r.id === "t")).toMatchObject({ steps: 0, working: 1, rating: 50 });
		expect(rs.map((r) => r.id)).toEqual(["p", "t", "b"]);
	});
});
