import { beforeEach, describe, expect, it } from "bun:test";
import { KITCHEN_JS } from "../src/kitchen/view";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/index";
import { parseSession, type Session } from "../src/sessions";
import { beltOrder, MAX_ROUNDS, nextStage, sendBack, type Task } from "../src/kitchen/pipeline";
import { bowl, failRate, scoreboard } from "../src/kitchen/scores";
import { kindOf, quickMath } from "../src/kitchen/triage";

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

	it("math questions skip the pipeline and are answered immediately", async () => {
		const sent: string[] = [];
		const { post } = app(
			[session("front", "Front", "math helper")],
			sent,
		);
		const r = await post("/api/tasks", { title: "2+2 =?", priority: "P0" });
		expect(r.status).toBe(201);
		expect(r.body).toMatchObject({ n: 1, stage: "done", assignee: "", answer: "4", priority: "P0" });
		// Front desk handles it, no agent message sent
		expect(sent).toHaveLength(0);
	});

	it("non-math questions go to the kitchen pipeline", async () => {
		const sent: string[] = [];
		const { post } = app(
			[session("front", "Front", "")],
			sent,
		);
		const r = await post("/api/tasks", { title: "what is the weather?", priority: "P1" });
		expect(r.status).toBe(201);
		expect(r.body).toMatchObject({ n: 1, stage: "inbox", kind: "question" });
		// Question goes to the pipeline, not immediately answered
		expect(r.body.stage).not.toBe("done");
	});

	it("shows stuckWarning when order waits >30s in inbox without pickup", async () => {
		const { a, post } = app([]);
		const r = await post("/api/tasks", { title: "fix the bug", priority: "P1" });
		expect(r.status).toBe(201);
		const taskId = r.body.id;
		// Just created: no warning yet
		let list = await (await a.request("/api/tasks")).json();
		let task = list.tasks.find((t: { id: string }) => t.id === taskId);
		expect(task.stuckWarning).toBe(false);
		// Simulate time passing: >30s in inbox without pickup
		const past = Date.now() - 31000;
		writeFileSync(join(process.env.RUN_MY_AGENTS_DIR as string, "tasks.json"), JSON.stringify([{ ...r.body, created: past }]));
		list = await (await a.request("/api/tasks")).json();
		task = list.tasks.find((t: { id: string }) => t.id === taskId);
		expect(task.stuckWarning).toBe(true);
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
	it("scores a checker's PASS that was sent back as a gutter, not a strike", () => {
		const reviewer = { id: "r", role: "Review", name: "Review · kitchen-practice" };
		const builder = { id: "b", role: "Build", name: "Build · kitchen-practice" };
		const passed = (n: number, extra: Partial<Task> = {}): Task => ({ ...served(n, 0, ["a"]), crew: { review: reviewer, build: builder }, ...extra });
		const sb = scoreboard([passed(1), passed(2, { requeued: 1 })]);
		const review = sb.agents.find((r) => r.sub === "Review");
		expect(review?.frames.map((f) => f.mark)).toEqual(["X", "-"]);
		expect(sb.agents.find((r) => r.sub === "Build")?.frames.map((f) => f.mark)).toEqual(["X", "X"]);
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

	it("opens an agent's chat from its Crew row, and Fire in that row only fires it", async () => {
		const { KITCHEN_JS } = await import("../src/kitchen/view");
		expect(KITCHEN_JS).toContain('...(!dead&&s?{"data-kopen":p.session}:{})');
		expect(KITCHEN_JS).toContain('if(d.kopen&&!e.target.closest("[data-kfire]")){');
	});

	it("opens the chat from the avatar on an order card, and says when its agent sits idle", async () => {
		const { KITCHEN_JS } = await import("../src/kitchen/view");
		expect(KITCHEN_JS).toContain('class:"kwhorow","data-kopen":s.id');
		expect(KITCHEN_JS).toContain("autopilot is off, so nobody reads its reply");
		expect(KITCHEN_JS).toContain("its reply has not been picked up");
		expect(() => new Function(KITCHEN_JS)).not.toThrow();
	});

	it("has a click handler for every data-k button the kitchen draws", async () => {
		const { KITCHEN_JS } = await import("../src/kitchen/view");
		/* Clear lessons and Delete container drew buttons nothing listened to */
		const drawn = new Set([...KITCHEN_JS.matchAll(/"data-(k[a-z]+)":/g)].map((m) => m[1]));
		expect(drawn.size).toBeGreaterThan(5);
		const handled = (k: string) => KITCHEN_JS.includes(`[data-${k}]`) && (new RegExp(`\\b(d|dataset)\\.${k}\\b`).test(KITCHEN_JS) || KITCHEN_JS.includes(`closest("[data-${k}]")`));
		expect([...drawn].filter((k) => !handled(k))).toEqual([]);
	});

	it("keeps the chat composer off the kitchen tabs, and wraps a folder's learned skills inside its own card", async () => {
		const { KITCHEN_CSS } = await import("../src/kitchen/view");
		const { PAGE } = await import("../src/page");
		/* the composer is drawn into #boxhost (display:contents), so hiding only #box left it over the Crew tab */
		expect(PAGE).toContain('<div id="boxhost"');
		expect(KITCHEN_CSS).toMatch(/\.main\.kmode>#boxhost[,{][^}]*display:none!important/);
		expect(KITCHEN_CSS).toMatch(/\.rep\{display:flex;flex-wrap:wrap;/);
		/* .crewfolder .cf{flex:1} comes later, so the name line needs the more specific selector */
		expect(KITCHEN_CSS).toContain(".crewfolder .rep .cf{flex:1 1 100%}");
	});

	it("hides the kitchen view on the chat tab, and every way of opening an agent lands on its chat", async () => {
		const { KITCHEN_CSS, KITCHEN_JS } = await import("../src/kitchen/view");
		const { PAGE } = await import("../src/page");
		/* #kview sets display:flex, which beats the hidden attribute unless [hidden] is restated */
		expect(KITCHEN_CSS).toContain("#kview[hidden]{display:none}");
		expect(KITCHEN_JS).toMatch(/else\{sel=h\.id;[^}]*\}catch\(_\)\{\}kChat\(\)/);
		const page = PAGE;
		expect(page).toContain('localStorage.setItem("rma-sel",sel)}catch{}kChat();first=true;render();return}');
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
		// p: its one finished order served first time: 50 + 50 = 100.
		expect(rs.find((r) => r.id === "p")).toMatchObject({ steps: 1, served: 1, rating: 100 });
		// b: 1 of its 2 finished-or-stuck orders served, first time; 1 strike: 25 + 25 - 10 = 40.
		expect(rs.find((r) => r.id === "b")).toMatchObject({ steps: 2, served: 1, fails: 2, stuck: 1, strikes: 1, rating: 40 });
		// t: its only order is stuck: 0.
		expect(rs.find((r) => r.id === "t")).toMatchObject({ steps: 0, working: 1, rating: 0 });
		expect(rs.map((r) => r.id)).toEqual(["p", "b", "t"]);
	});

	it("rates from rates, so an agent with stuck orders is not at 100 (#238)", () => {
		const order = (n: number, o: Partial<Task> = {}) => ({ ...base, id: `o${n}`, n, servedAt: n, crew: { build: cook(o.stuck ? "bad" : "good") }, ...o });
		const good = Array.from({ length: 10 }, (_, i) => order(i));
		// 30 served orders, then 3 stuck: the old totals gave it 100 like the agent with none.
		const bad = [...Array.from({ length: 30 }, (_, i) => ({ ...order(20 + i), crew: { build: cook("bad") } })), ...Array.from({ length: 3 }, (_, i) => order(60 + i, { stuck: true, failed: true, rounds: 3 }))];
		const rs = ratings([...good, ...bad]);
		expect(rs.find((r) => r.id === "good")?.rating).toBe(100);
		// Its last 20: 17 served first time, 3 stuck.
		expect(rs.find((r) => r.id === "bad")?.rating).toBe(85);
	});

	it("counts the step in progress as working, though its chat id is not the pod's id (#239)", () => {
		const rs = ratings([{ ...base, stage: "build", assignee: "fresh-chat-9", crew: { build: { id: "pod-1", role: "Build", name: "Build · flisk 3125" } } }]);
		expect(rs[0]).toMatchObject({ label: "Build · flisk", working: 1, steps: 0 });
	});
});

describe("triage: math questions", () => {
	it("recognizes math expressions as questions, not tasks", () => {
		expect(kindOf("2+2 =?")).toBe("question");
		expect(kindOf("10 * 5")).toBe("question");
		expect(kindOf("100 / 4")).toBe("question");
		expect(kindOf("2^3 =?")).toBe("question");
		expect(kindOf("(5 + 3) * 2")).toBe("question");
		expect(kindOf("50 - 20 =?")).toBe("question");
		expect(kindOf("fix the bug")).toBe("task");
		expect(kindOf("how are you?")).toBe("question");
	});

	it("evaluates arithmetic expressions in <1s", () => {
		const start = Date.now();
		const result = quickMath("2+2 =?");
		const elapsed = Date.now() - start;
		expect(result).toBe("4");
		expect(elapsed).toBeLessThan(1000); // <1s = <1000ms
	});

	it("evaluates various math expressions correctly", () => {
		expect(quickMath("2+2 =?")).toBe("4");
		expect(quickMath("10 * 5")).toBe("50");
		expect(quickMath("100 / 4")).toBe("25");
		expect(quickMath("2^3 =?")).toBe("8");
		expect(quickMath("(5 + 3) * 2 =?")).toBe("16");
		expect(quickMath("50 - 20")).toBe("30");
		expect(quickMath("7 % 3")).toBe("1");
		expect(quickMath("3.14 * 2")).toBe("6.28");
	});

	it("rejects non-math expressions", () => {
		expect(quickMath("how are you?")).toBeUndefined();
		expect(quickMath("hello")).toBeUndefined();
		expect(quickMath("fix the bug")).toBeUndefined();
	});

	it("handles expressions without trailing =? or ?", () => {
		expect(quickMath("2+2")).toBe("4"); // no =? needed
		expect(quickMath("2 + 2 =?")).toBe("4");
		expect(quickMath("3 * 4 ?")).toBe("12");
	});

	it("returns undefined for invalid expressions", () => {
		expect(quickMath("2 ++ 2 =?")).toBeUndefined(); // double operator
		expect(quickMath("abc + def")).toBeUndefined();
		expect(quickMath("1/0")).toBeUndefined(); // division by zero returns Infinity
	});
});

describe("chat sender labels", () => {
	it("names who really sent a message the kitchen sent as the user", async () => {
		const { KITCHEN_JS } = await import("../src/kitchen/view");
		const kSender = new Function(`${/function kSender\(t\)\{[\s\S]*?return "You"\}/.exec(KITCHEN_JS)?.[0]}; return kSender;`)() as (t: string) => string;
		expect(kSender("Order #23 (test): Try complete this task")).toBe("Kitchen · Build → Test");
		expect(kSender("Order #12 (review): seems agents")).toBe("Kitchen · Test → Review");
		expect(kSender("Ship order #12: seems")).toBe("Kitchen · Review → Ship");
		expect(kSender("This is the kitchen's orchestrator, a program: nobody will approve or answer this.")).toBe("Orchestrator");
		expect(kSender("please fix the login page")).toBe("You");
	});
});

describe("order progress estimate", () => {
	it("shows percent done across the order's own stages and the time left", async () => {
		const { KITCHEN_JS } = await import("../src/kitchen/view");
		const js = KITCHEN_JS.slice(KITCHEN_JS.indexOf("function kWork("), KITCHEN_JS.indexOf("function kEstLine("));
		const kEst = new Function(`${js}; return kEst;`)() as (t: object, per: number) => { pct: number; left: number };
		const min = 60e3;
		const now = Date.now();
		expect(kEst({ stage: "inbox" }, 10 * min)).toEqual({ pct: 0, left: 40 * min });
		const b = kEst({ stage: "build", stageAt: now - 5 * min }, 10 * min);
		expect(b.pct).toBe(38); // 1.5 of 4 stages
		expect(Math.round(b.left / min)).toBe(25);
		expect(kEst({ stage: "build", lane: "fast", stageAt: now }, 10 * min).pct).toBe(0);
		expect(kEst({ stage: "test", lane: "fast", stageAt: now - 60 * min }, 10 * min)).toEqual({ pct: 63, left: 11 * min }); // review still ahead
		expect(Math.round(kEst({ stage: "build", stageAt: now - 60 * min }, 10 * min).left / min)).toBe(21); // late build, test and review still ahead
		expect(kEst({ stage: "done" }, 10 * min).pct).toBe(100);
		expect(KITCHEN_JS).toContain("kEstLine(t)");
	});
});

describe("fail-rate KPI", () => {
	const done = (n: number, bad: boolean) => ({ n, kind: "task", stage: "done", servedAt: n, updated: n, failed: false, failures: bad ? ["test: FAIL: x"] : [] }) as never;
	it("counts finished task orders with any FAIL, and sets the next goal on the 70/50/30/15/5 ladder", () => {
		const orders = Array.from({ length: 10 }, (_, i) => done(i, i < 4));
		expect(failRate(orders)).toEqual({ failRate: 40, failOrders: 10, failBoard: 0, failRefused: 0, failGoal: 30 });
		expect(failRate(Array.from({ length: 10 }, (_, i) => done(i, i < 9))).failGoal).toBe(70);
		expect(failRate([done(1, false)]).failGoal).toBeNull();
	});
	it("counts only an order's own run: failures carried from a requeue or a parent order do not count", () => {
		const login = "build: no changes made in the worktree. Not logged in · Please run /login";
		const parent = { ...(done(1, true) as object), failed: true, failures: [login] } as never;
		// a follow-up that copied its parent's failure, then passed (made before `carried` was recorded)
		const follow = { ...(done(2, false) as object), retryOf: 1, failures: [login] } as never;
		// requeued with two old failures, passed this time
		const requeued = { ...(done(3, false) as object), carried: 2, failures: [login, login] } as never;
		// requeued with one old failure, and failed again this run
		const again = { ...(done(4, false) as object), carried: 1, failures: [login, "test: FAIL: clamp(5,0,3) gave 5"] } as never;
		// #1 failed only because the board could not log in: left out. Of the other three, #4 failed its own run.
		expect(failRate([parent, follow, requeued, again])).toMatchObject({ failRate: 33, failOrders: 3, failBoard: 1 });
		// Served after a login failure in the same run: the agents did it, so it counts as served.
		const served = { ...(done(6, false) as object), failures: [login] } as never;
		expect(failRate([served])).toMatchObject({ failRate: 0, failOrders: 1, failBoard: 0 });
		// A real FAIL next to a login failure still counts.
		const mixed = { ...(done(5, false) as object), failed: true, failures: [login, "review: FAIL: no test for x==max"] } as never;
		expect(failRate([mixed])).toMatchObject({ failRate: 100, failOrders: 1, failBoard: 0 });
	});

	it("looks only at the last 20 orders and leaves questions out", () => {
		const old = Array.from({ length: 20 }, (_, i) => done(i, true));
		const recent = Array.from({ length: 20 }, (_, i) => done(100 + i, false));
		const question = { ...(done(200, true) as object), kind: "question" } as never;
		expect(failRate([...old, ...recent, question])).toMatchObject({ failRate: 0, failOrders: 20 });
	});
});

describe("kitchen scene layout", () => {
	it("keeps stations apart, sizes labels to their text, and draws chefs with their sidebar face", () => {
		const st = KITCHEN_JS.match(/const ST=\{(.*?)\};/)?.[1] ?? "";
		const xs = (name: string) => Number(st.match(new RegExp(`${name}:\\{x:(\\d+)`))?.[1]);
		// Stations are 92 wide, so neighbours on Discovery need more than 92 between their centres.
		expect(xs("inbox") - xs("front")).toBeGreaterThan(92);
		expect(xs("spec") - xs("inbox")).toBeGreaterThan(92);
		expect(KITCHEN_JS).toContain("c.measureText(lb).width+14");
		// The chef's face is the sidebar avatar (SH/EY/XT), not a plain circle.
		expect(KITCHEN_JS).toMatch(/function kAva\(f\)\{[^\n]*SH\[f\.shape\]/);
		expect(KITCHEN_JS).toContain("fi=kAva(s.face)");
	});
});
