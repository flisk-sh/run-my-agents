import { beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/index";
import { parseSession, type Session } from "../src/sessions";
import { beltOrder, MAX_ROUNDS, nextStage, sendBack, type Task } from "../src/tasks";

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
		const r = await post("/api/tasks", { title: "fix the login bug", priority: "P0" });
		expect(r.status).toBe(201);
		expect(r.body).toMatchObject({ n: 1, stage: "inbox", priority: "P0", route: "Bug" });
		expect(r.body.skills.length).toBeGreaterThan(0);
		await Bun.sleep(5);
		expect(fetched[0]).toStartWith("https://raw.githubusercontent.com/");
		const list = await (await a.request("/api/tasks")).json();
		expect(list.tasks[0].skills.every((k: { state: string }) => k.state === "ok")).toBe(true);
		expect((await post("/api/tasks", { title: "  " })).status).toBe(400);
		expect((await post("/api/tasks", { title: "x", priority: "P9" })).status).toBe(400);
	});

	it("dispatches to an idle agent of the right type and moves through the pass", async () => {
		const sent: string[] = [];
		const planner = session("p", "Planner", "plan things");
		const coder = session("c", "Code", "code things");
		const { post } = app([planner, coder], sent);
		const t = (await post("/api/tasks", { title: "add search filters" })).body;
		await Bun.sleep(5);
		const d = await post("/api/tasks/dispatch", { id: t.id });
		expect(d.status).toBe(202);
		expect(d.body).toMatchObject({ stage: "spec", assignee: "p" });
		expect(sent[0]).toContain("Order #1 (spec): add search filters");
		// The spec waits at the pass until approved.
		expect((await post("/api/tasks/serve", { id: t.id })).body.stage).toBe("spec");
		await post("/api/tasks/move", { id: t.id, approved: true, stage: "build" });
		const b = await post("/api/tasks/dispatch", { id: t.id });
		expect(b.body).toMatchObject({ stage: "build", assignee: "c" });
	});

	it("says when no agent fits, and waits for skills still installing", async () => {
		const { post } = app([session("c", "Code", "x")]);
		writeFileSync(join(process.env.RUN_MY_AGENTS_DIR as string, "tasks.json"), JSON.stringify([{ id: "t", n: 1, title: "x", cwd: "", priority: "P1", stage: "spec", assignee: "", sentAt: 0, approved: false, skills: [], route: "Code", rounds: 0, stuck: false, created: 1, updated: 1 }]));
		expect((await post("/api/tasks/dispatch", { id: "t" })).body.error).toContain("No idle Planner");
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
