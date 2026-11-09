import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/index";
import { holdsSlot, type Task } from "../src/kitchen/pipeline";

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rma-wip-"));
	process.env.RUN_MY_AGENTS_DIR = dir;
	process.env.RUN_MY_AGENTS_SKILLS_DIR = mkdtempSync(join(tmpdir(), "rma-wip-skills-"));
});

function setup(prState?: (cwd: string, url: string) => string) {
	const app = createApp(() => [], async () => {}, {
		start: async () => {},
		fetch: (async () => new Response("---\nname: x\n---\n")) as unknown as typeof fetch,
		...(prState ? { prState } : {}),
	});
	const post = async (path: string, body: object) => {
		const r = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		return { status: r.status, body: (await r.json()) as Record<string, never> };
	};
	const get = async (path: string) => (await (await app.request(path)).json()) as Record<string, never>;
	return { post, get };
}
/** One task order: stage build, never started, in /work/app. */
const task = (i: number, o: object = {}) => ({ id: `t${i}`, n: i + 1, title: "fix it", cwd: "/work/app", priority: "P1", stage: "build", assignee: "", sentAt: 0, approved: true, skills: [], route: "Code", kind: "task", rounds: 0, stuck: false, created: i + 1, updated: 1, ...o });
/** The same order, already picked up by an agent: it holds a slot. */
const started = (i: number, o: object = {}) => task(i, { assignee: `x${i}`, sentAt: 1, startedAt: 1, ...o });
const put = (ts: object[]) => writeFileSync(join(dir, "tasks.json"), JSON.stringify(ts));
const read = () => JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")) as Task[];
const one = (n: number) => read().find((t) => t.n === n) as Task;
/** kitchen.json with a known wipSince, so a test can set servedAt after the feature shipped. */
const settings = (o: object = {}) => writeFileSync(join(dir, "kitchen.json"), JSON.stringify([{ auto: true, idleMinutes: 10, wipOn: true, wipLimit: 3, wipSince: 1, ...o }]));
/** Ten build agents in /work/app, so the only cap on a pass is the WIP limit (a stage container tops out at 3). */
const crew = async (post: ReturnType<typeof setup>["post"]) => {
	await post("/api/containers", { name: "Builders", role: "Code", stages: ["build", "test"], replicas: 10, cwd: "/work/app" });
	await post("/api/containers/reconcile", {});
};
const sent = (did: string[]) => did.filter((d) => d.endsWith(" sent"));
const PR = "https://github.com/o/r/pull/7";

describe("the WIP limit", () => {
	it("starts every waiting order when the switch is off", async () => {
		const { post } = setup();
		await crew(post);
		await post("/api/kitchen", { wipOn: false });
		put([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => task(i)));
		const did = (await post("/api/kitchen", { auto: true })).body.did as unknown as string[];
		expect(sent(did)).toHaveLength(10);
		expect(read().filter((t) => t.assignee)).toHaveLength(10);
	});

	it("starts exactly 3 of 10 waiting orders in one pass, and nothing on the next", async () => {
		const { post } = setup();
		await crew(post);
		settings();
		put([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => task(i)));
		const did = (await post("/api/kitchen", { auto: true })).body.did as unknown as string[];
		expect(sent(did)).toEqual(["#1 sent", "#2 sent", "#3 sent"]);
		expect(read().filter((t) => t.assignee)).toHaveLength(3);
		expect(sent((await post("/api/kitchen", { auto: true })).body.did as unknown as string[])).toEqual([]);
	});

	it("lets a FAIL go back to build at the limit, so the gate cannot deadlock", async () => {
		const { post } = setup();
		await crew(post);
		settings();
		put([started(0), started(1), started(2), started(3, { stage: "test", assignee: "a3" })]);
		await post("/api/tasks/serve", { id: "t3", pass: false });
		expect(one(4)).toMatchObject({ stage: "build", assignee: "", rounds: 1 });
		const did = (await post("/api/kitchen", { auto: true })).body.did as unknown as string[];
		expect(did).toContain("#4 sent");
		expect(one(4).assignee).not.toBe("");
	});

	it("frees a slot when an order is stuck", async () => {
		const { post } = setup();
		await crew(post);
		settings();
		put([started(0), started(1), started(2, { stuck: true, rounds: 3 }), task(3)]);
		const did = (await post("/api/kitchen", { auto: true })).body.did as unknown as string[];
		expect(did).toContain("#3 closed as failed");
		expect(did).toContain("#4 sent");
		expect(holdsSlot(one(3), 1)).toBe(false);
	});

	it("skips a parked order and never counts it against the limit", async () => {
		const { post } = setup();
		await crew(post);
		settings();
		put([started(0), started(1), task(2, { parked: true }), task(3)]);
		const did = (await post("/api/kitchen", { auto: true })).body.did as unknown as string[];
		expect(did).toContain("#4 sent");
		expect(did).not.toContain("#3 sent");
		expect(one(3)).toMatchObject({ assignee: "", parked: true });
		expect(holdsSlot(started(9, { parked: true }) as unknown as Task, 1)).toBe(false);
	});

	it("parks and un-parks an order, keeping it and its worktree", async () => {
		const { post } = setup();
		put([started(0, { worktree: "/work/app/.kitchen/order-1" })]);
		const p = await post("/api/tasks/park", { id: "t0" });
		expect(p.body).toMatchObject({ parked: true, assignee: "", worktree: "/work/app/.kitchen/order-1" });
		expect(holdsSlot(one(1), 1)).toBe(false);
		const u = await post("/api/tasks/park", { id: "t0", parked: false });
		expect(u.body).toMatchObject({ parked: false, worktree: "/work/app/.kitchen/order-1" });
		expect((await post("/api/tasks/park", { id: "nope" })).status).toBe(404);
	});

	it("decides who holds a slot", () => {
		const done = { stage: "done", servedAt: 1000, pr: PR };
		const s = (o: object) => started(0, o) as unknown as Task;
		expect(holdsSlot(s(done), 1)).toBe(true);
		expect(holdsSlot(s({ ...done, mergedAt: 2000 }), 1)).toBe(false);
		expect(holdsSlot(s({ ...done, closedAt: 2000 }), 1)).toBe(false);
		expect(holdsSlot(s({ stage: "done", servedAt: 1000 }), 1)).toBe(false);
		expect(holdsSlot(s({ kind: "question" }), 1)).toBe(false);
		expect(holdsSlot(task(0) as unknown as Task, 1)).toBe(false);
		expect(holdsSlot(s({ ...done, servedAt: 500 }), 900)).toBe(false);
		expect(holdsSlot(s({ failed: true }), 1)).toBe(false);
	});

	it("keeps a waiting order off the belt while a done order's pull request is open", async () => {
		const { post, get } = setup(() => "OPEN");
		await crew(post);
		settings();
		put([started(0), started(1), started(2, { stage: "done", servedAt: 1000, pr: PR }), task(3)]);
		const did = (await post("/api/kitchen", { auto: true })).body.did as unknown as string[];
		expect(did).not.toContain("#4 sent");
		const list = await get("/api/tasks");
		expect(list.wip).toMatchObject({ on: true, limit: 3, held: 3 });
		expect((list.tasks as unknown as { n: number; why: string }[]).find((t) => t.n === 4)?.why).toBe("Waiting: 3 of 3 orders in progress.");
	});

	it("frees the slot when gh says the pull request was merged", async () => {
		const looks: string[] = [];
		const { post } = setup((_cwd, url) => (looks.push(url), "MERGED"));
		await crew(post);
		settings();
		put([started(0), started(1), started(2, { stage: "done", servedAt: 1000, pr: PR }), task(3)]);
		const did = (await post("/api/kitchen", { auto: true })).body.did as unknown as string[];
		expect(looks).toEqual([PR]);
		expect(did).toContain("#3 pull request merged");
		expect(did).toContain("#4 sent");
		expect(one(3).mergedAt).toBeGreaterThan(0);
	});

	it("frees the slot when gh says the pull request was closed", async () => {
		const { post } = setup(() => "CLOSED");
		await crew(post);
		settings();
		put([started(0), started(1), started(2, { stage: "done", servedAt: 1000, pr: PR }), task(3)]);
		const did = (await post("/api/kitchen", { auto: true })).body.did as unknown as string[];
		expect(did).toContain("#3 pull request closed");
		expect(did).toContain("#4 sent");
		expect(one(3).closedAt).toBeGreaterThan(0);
	});

	it("asks gh at most once a minute", async () => {
		const looks: string[] = [];
		const { post } = setup((_cwd, url) => (looks.push(url), "OPEN"));
		await crew(post);
		settings();
		put([started(0, { stage: "done", servedAt: 1000, pr: PR })]);
		await post("/api/kitchen", { auto: true });
		await post("/api/kitchen", { auto: true });
		expect(looks).toHaveLength(1);
	});

	it("keeps the slot held when gh fails", async () => {
		const { post } = setup(() => {
			throw new Error("gh: not logged in");
		});
		await crew(post);
		settings();
		put([started(0), started(1), started(2, { stage: "done", servedAt: 1000, pr: PR }), task(3)]);
		const did = (await post("/api/kitchen", { auto: true })).body.did as unknown as string[];
		expect(did).toContain("#3 pull request state unknown: gh failed");
		expect(did).not.toContain("#4 sent");
		expect(one(3).mergedAt).toBeUndefined();
		expect(one(3).closedAt).toBeUndefined();
	});

	it("never counts a question, and sends an order by hand even at the limit", async () => {
		const { post } = setup();
		await crew(post);
		settings();
		put([started(0), started(1), started(2, { kind: "question", stage: "inbox", assignee: "q2" }), task(3), task(4)]);
		const did = (await post("/api/kitchen", { auto: true })).body.did as unknown as string[];
		expect(did).toContain("#4 sent");
		expect(did).not.toContain("#5 sent");
		expect((await post("/api/tasks/dispatch", { id: "t4" })).status).toBe(202);
		expect(one(5).assignee).not.toBe("");
	});

	it("saves the settings with the others, survives a restart, and refuses 0 and 21", async () => {
		const { post } = setup();
		expect((await post("/api/kitchen", { wipLimit: 7 })).body).toMatchObject({ wipOn: true, wipLimit: 7 });
		expect((await post("/api/kitchen", { wipOn: false })).body).toMatchObject({ wipOn: false, wipLimit: 7 });
		expect(JSON.parse(readFileSync(join(dir, "kitchen.json"), "utf8"))[0]).toMatchObject({ auto: true, idleMinutes: 10, wipOn: false, wipLimit: 7 });
		expect(await setup().get("/api/kitchen")).toMatchObject({ wipOn: false, wipLimit: 7 });
		for (const bad of [0, 21, 2.5, -1]) {
			const r = await post("/api/kitchen", { wipLimit: bad });
			expect(r.status).toBe(400);
			expect(r.body.error).toBe("Pick a whole WIP limit of 1 to 20.");
		}
		expect((await post("/api/kitchen", { wipLimit: 1 })).status).toBe(200);
		expect((await post("/api/kitchen", { wipLimit: 20 })).status).toBe(200);
	});

	it("warns about a pull request open over 24 hours and splits the flow count", async () => {
		const { post, get } = setup(() => "OPEN");
		settings();
		put([started(0, { stage: "done", servedAt: Date.now() - 25 * 60 * 60 * 1000, pr: PR }), task(1)]);
		const list = await get("/api/tasks");
		expect((list.tasks as unknown as { n: number; prStale: boolean }[]).find((t) => t.n === 1)?.prStale).toBe(true);
		expect(list.wip).toMatchObject({ held: 1 });
		expect((await get("/api/scores")).flow).toMatchObject({ inProgress: 1, waiting: 1, wip: 1 });
		await post("/api/kitchen", { auto: true });
		expect(one(1).mergedAt).toBeUndefined();
	});
});
