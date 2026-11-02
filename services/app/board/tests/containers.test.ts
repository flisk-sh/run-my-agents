import { beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/index";
import { podName, readContainers, reconcile } from "../src/kitchen/containers";
import { haikuFit, policyFor, skillset } from "../src/kitchen/skills";
import { parseSession, type Session } from "../src/sessions";

const now = Date.parse("2026-11-01T12:00:00Z");
const session = (id: string, role: string) => {
	const s = parseSession(id, [JSON.stringify({ type: "user", cwd: "/repo", message: { content: `${role} work` } })], now) as Session;
	return { ...s, role, updatedAt: now };
};
let dir = "";
let skills = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rma-box-"));
	skills = mkdtempSync(join(tmpdir(), "rma-box-skills-"));
	process.env.RUN_MY_AGENTS_DIR = dir;
	process.env.RUN_MY_AGENTS_SKILLS_DIR = skills;
});

function setup(sessions: Session[] = []) {
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
		},
	);
	const post = async (path: string, body: object) => {
		const r = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		return { status: r.status, body: await r.json() };
	};
	return { app, post, started, sent };
}
const order = (o: object) => writeFileSync(join(dir, "tasks.json"), JSON.stringify([{ id: "t", n: 1, title: "fix it", cwd: "", priority: "P1", stage: "build", assignee: "", sentAt: 0, approved: true, skills: [], route: "Code", rounds: 0, stuck: false, created: 1, updated: 1, ...o }]));

describe("model policy and skill sets", () => {
	it("runs workers on haiku/low and the orchestrator on opus/medium", () => {
		expect(policyFor("build")).toEqual({ model: "haiku", effort: "low" });
		expect(policyFor("review")).toEqual({ model: "haiku", effort: "low" });
		expect(policyFor("spec")).toEqual({ model: "opus", effort: "medium" });
		expect(policyFor("build", { model: "sonnet", effort: "" })).toEqual({ model: "sonnet", effort: "low" });
	});
	it("gives each stage its own skills and marks the haiku-friendly ones", () => {
		expect(skillset("test")).toContain("verification-loop");
		expect(skillset("review", ["not-a-skill", "rma-lessons-x"])).toContain("rma-lessons-x");
		expect(skillset("review", ["not-a-skill"])).not.toContain("not-a-skill");
		expect(haikuFit("focused-fix")).toBe(true);
		expect(haikuFit("architecture-designer")).toBe(false);
	});
	it("dispatches a build step on haiku/low with the stage's skills", async () => {
		const { post, sent } = setup([session("c", "Code")]);
		order({});
		const r = await post("/api/tasks/dispatch", { id: "t", session: "c" });
		expect(r.body).toMatchObject({ assignee: "c", model: "haiku", effort: "low" });
		expect(sent[0]).toContain("/focused-fix");
	});
});

describe("agent containers", () => {
	const make = (post: ReturnType<typeof setup>["post"], extra: object = {}) => post("/api/containers", { name: "Builders", role: "Code", stages: ["build"], replicas: 2, cwd: "/repo", maxStrikes: 2, ...extra });

	it("starts agents until the replica count is met, and marks them ready", async () => {
		const sessions: Session[] = [];
		const { post, started } = setup(sessions);
		const box = (await make(post)).body;
		expect(box).toMatchObject({ slug: "builders", model: "", effort: "" });
		await post("/api/containers/reconcile", {});
		expect(started).toHaveLength(2);
		expect(started[0].text).toContain("/rma-lessons-build");
		for (const s of started) sessions.push(session(s.id as string, "Code"));
		await post("/api/containers/reconcile", {});
		expect(readContainers()[0].pods.map((p) => p.status)).toEqual(["ready", "ready"]);
		await post("/api/containers/reconcile", {});
		expect(started).toHaveLength(2);
	});

	it("scales down by firing the newest agent", async () => {
		const sessions: Session[] = [];
		const { post, started } = setup(sessions);
		const box = (await make(post)).body;
		await post("/api/containers/reconcile", {});
		const r = await post("/api/containers/scale", { id: box.id, replicas: 1 });
		expect(r.body.pods.filter((p: { status: string }) => p.status !== "evicted")).toHaveLength(1);
		expect(r.body.pods.find((p: { status: string }) => p.status === "evicted").reason).toBe("Scaled down");
		expect(started).toHaveLength(2);
	});

	it("fires an agent whose builds keep failing, writes the lesson, and replaces it", async () => {
		const sessions: Session[] = [];
		const { post, started } = setup(sessions);
		await make(post, { replicas: 1 });
		await post("/api/containers/reconcile", {});
		const pod = started[0].id as string;
		sessions.push(session(pod, "Code"), session("tester", "Bug"));
		await post("/api/containers/reconcile", {});
		order({ stage: "test", assignee: "tester", sentAt: 1, crew: { build: { id: pod, role: "Code", name: "x" } } });
		expect((await post("/api/tasks/serve", { id: "t", pass: false })).body.fired).toBe(false);
		order({ stage: "test", assignee: "tester", sentAt: 1, rounds: 1, crew: { build: { id: pod, role: "Code", name: "x" } } });
		expect((await post("/api/tasks/serve", { id: "t", pass: false })).body.fired).toBe(true);
		const lessons = readFileSync(join(skills, "rma-lessons-build", "SKILL.md"), "utf8");
		expect(lessons).toContain("#1 fix it");
		await post("/api/containers/reconcile", {});
		expect(started).toHaveLength(2);
		expect(readContainers()[0].pods.find((p) => p.session === pod)?.status).toBe("evicted");
	});

	it("counts an order a pod sat on past its miss time as a strike, and puts it back on the belt", async () => {
		const sessions: Session[] = [];
		const { post, started } = setup(sessions);
		await make(post, { replicas: 1, missMinutes: 5 });
		await post("/api/containers/reconcile", {});
		const pod = started[0].id as string;
		sessions.push({ ...session(pod, "Code"), updatedAt: Date.now() - 60 * 60_000 });
		order({ assignee: pod, sentAt: Date.now() - 60 * 60_000 });
		await post("/api/containers/reconcile", {});
		expect(readContainers()[0].pods[0].strikes).toBe(1);
		expect(JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))[0].assignee).toBe("");
		expect(existsSync(join(skills, "rma-lessons-build", "SKILL.md"))).toBe(true);
	});

	it("names every pod after its container, so it is not another 'You are a Code agent' row", async () => {
		const { post } = setup();
		await post("/api/containers", { name: "Cooks", role: "Code", stages: ["build"], replicas: 1, cwd: "/repo" });
		const named: [string, string][] = [];
		const starts: { id: string }[] = [];
		reconcile({ sessions: [], start: (n) => starts.push(n), close: () => {}, name: (id, label) => named.push([id, label]) });
		expect(named).toEqual([[starts[0].id, podName({ name: "Cooks" }, starts[0].id)]]);
		expect(named[0][1]).toMatch(/^Cooks [0-9a-f]{4}$/);
		// It is named again when it reports ready, so pods started before this still get a name.
		reconcile({ sessions: [{ id: starts[0].id }], start: () => {}, close: () => {}, name: (id, label) => named.push([id, label]) });
		expect(named).toHaveLength(2);
	});

	it("rejects a container with no stage or folder", async () => {
		const { post } = setup();
		expect((await post("/api/containers", { name: "x", stages: [], cwd: "/repo" })).status).toBe(400);
		expect((await post("/api/containers", { name: "x", stages: ["build"] })).status).toBe(400);
	});
});

describe("auto-dispatch on the server", () => {
	it("is on by default, sends waiting orders to container agents only, moves finished steps, and approves the spec itself", async () => {
		const chat = { ...session("my-chat", "Planner"), updatedAt: Date.now() - 60_000 };
		const sessions: Session[] = [chat];
		const { app, post, sent, started } = setup(sessions);
		expect(await (await app.request("/api/kitchen")).json()).toEqual({ auto: true, idleMinutes: 10 });
		order({ stage: "inbox", approved: false });
		// Your own idle chat never gets an order from auto-dispatch.
		expect((await post("/api/kitchen", { auto: true })).body.did).toEqual([]);
		expect((await (await app.request("/api/tasks")).json()).tasks[0].why).toContain("No agent container cooks spec");
		await post("/api/containers", { name: "Cooks", role: "Code", stages: ["spec", "build"], replicas: 1, cwd: "/repo" });
		await post("/api/containers/reconcile", {});
		const cook = { ...session(started[0].id as string, "Code"), updatedAt: Date.now() - 60_000 };
		sessions.push(cook);
		await post("/api/containers/reconcile", {});
		expect((await post("/api/kitchen", { auto: true })).body.did).toEqual(["#1 sent"]);
		expect(sent[0]).toContain("Order #1 (spec)");
		expect(JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))[0].assignee).toBe(cook.id);
		// The cook replied and went quiet: the spec is done and waits at the pass, not sent again.
		const t = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))[0];
		writeFileSync(join(dir, "tasks.json"), JSON.stringify([{ ...t, sentAt: Date.now() - 60_000 }]));
		cook.updatedAt = Date.now() - 20_000;
		expect((await post("/api/kitchen", { auto: true })).body.did).toEqual(["#1 spec done"]);
		// Autopilot: the next pass approves it at the pass and sends it on to build, no button needed.
		expect((await post("/api/kitchen", { auto: true })).body.did).toEqual(["#1 approved", "#1 sent"]);
		expect(JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))[0]).toMatchObject({ stage: "build", approved: true, assignee: cook.id });
		expect((await post("/api/kitchen", { auto: false })).body).toEqual({ auto: false, did: [] });
		expect(await (await app.request("/api/kitchen")).json()).toEqual({ auto: false, idleMinutes: 10 });
	});
});

describe("autopilot", () => {
	it("makes one container per stage for a folder, scales it with the stage's orders, and back down when idle", async () => {
		const { post, started } = setup([]);
		order({ stage: "inbox", approved: false, cwd: "/work/app", title: "add search filters to the sessions list with saved views" });
		expect((await post("/api/kitchen", { auto: true })).body.did).toContain("created Spec · app");
		expect(readContainers()[0]).toMatchObject({ name: "Spec · app", role: "Spec", lessonsKey: "spec", stages: ["spec"], replicas: 1, model: "" });
		expect(readContainers()[0].skills).toContain("spec-driven-workflow");
		await post("/api/containers/reconcile", {});
		expect(started.length).toBe(1);
		// Four orders waiting in build: a Build container appears, then grows to the 3-agent cap.
		const t = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))[0];
		writeFileSync(join(dir, "tasks.json"), JSON.stringify([0, 1, 2, 3].map((i) => ({ ...t, id: `t${i}`, n: i + 1, stage: "build", approved: true }))));
		expect((await post("/api/kitchen", { auto: true })).body.did).toContain("created Build · app");
		expect(readContainers().find((x) => x.name === "Build · app")).toMatchObject({ role: "Build", lessonsKey: "build", stages: ["build"] });
		expect((await post("/api/kitchen", { auto: true })).body.did).toContain("Build · app: 1 → 3 agents");
		// All served: the idle timer starts, and after 10 quiet minutes the stage's agents are let go.
		writeFileSync(join(dir, "tasks.json"), JSON.stringify([0, 1, 2, 3].map((i) => ({ ...t, id: `t${i}`, n: i + 1, stage: "done" }))));
		expect((await post("/api/kitchen", { auto: true })).body.did.some((d: string) => d.includes("Build · app: idle"))).toBe(false);
		const boxes = JSON.parse(readFileSync(join(dir, "containers.json"), "utf8"));
		writeFileSync(join(dir, "containers.json"), JSON.stringify(boxes.map((b: { idleSince?: number }) => (b.idleSince ? { ...b, idleSince: Date.now() - 11 * 60_000 } : b))));
		expect((await post("/api/kitchen", { auto: true })).body.did).toContain("Build · app: idle 11 min, 3 → 0 agents");
		await post("/api/containers/reconcile", {});
		const build = readContainers().find((x) => x.name === "Build · app");
		expect(build?.pods.filter((p) => p.status !== "evicted")).toEqual([]);
		expect(build?.pods.every((p) => p.reason === "Idle 11 min" || p.status !== "evicted")).toBe(true);
	});

	it("clears a container's lessons", async () => {
		const { post } = setup([]);
		const box = (await post("/api/containers", { name: "Cooks", role: "Code", stages: ["build"], replicas: 0, cwd: "/repo" })).body;
		const { strike } = await import("../src/kitchen/containers");
		const { patchContainer } = await import("../src/kitchen/containers");
		patchContainer(box.id, {});
		expect(strike("nobody", "#1", "x")).toBeUndefined();
		expect((await post("/api/containers/lessons/clear", { id: box.id })).body).toEqual({ cleared: true, name: "Cooks" });
		expect(readFileSync(join(skills, "rma-lessons-cooks", "SKILL.md"), "utf8")).toContain("No lessons yet");
	});

	it("closes a stuck order as failed so it never blocks the belt", async () => {
		const { post } = setup([]);
		order({ stage: "test", stuck: true, rounds: 3 });
		expect((await post("/api/kitchen", { auto: true })).body.did).toContain("#1 closed as failed");
		expect(JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))[0]).toMatchObject({ stage: "done", failed: true });
	});
});

describe("flow times", () => {
	it("counts a test reply with no PASS or FAIL as FAIL, so the order never waits forever", async () => {
		const tester = { ...session("quiet-tester", "Bug"), updatedAt: Date.now() - 20_000 };
		tester.feed = [...tester.feed, { who: "agent", text: "I need a concrete deliverable.", at: Date.now() - 20_000 } as never];
		const { post } = setup([tester]);
		order({ stage: "test", assignee: tester.id, sentAt: Date.now() - 60_000 });
		expect((await post("/api/kitchen", { auto: true })).body.did).toContain("#1 test FAIL");
		expect(JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))[0]).toMatchObject({ stage: "build", rounds: 1 });
	});

	it("stamps when an order is first picked up and when it enters each stage", async () => {
		const { post } = setup([{ ...session("timer", "Code"), updatedAt: Date.now() - 60_000 }]);
		order({ stage: "build" });
		const before = Date.now();
		const r = (await post("/api/tasks/dispatch", { id: "t", session: "timer" })).body;
		expect(r.startedAt).toBeGreaterThanOrEqual(before);
		const moved = (await post("/api/tasks/move", { id: "t", stage: "test" })).body;
		expect(moved.stageAt).toBeGreaterThanOrEqual(before);
		expect(moved.startedAt).toBe(r.startedAt);
	});

	it("reports median and p85 lead and cycle time over served orders", async () => {
		const { flow } = await import("../src/kitchen/scores");
		const now = 10_000_000;
		const t = (n: number, lead: number, cycle: number, extra = {}) => ({ id: `t${n}`, n, title: "x", cwd: "", priority: "P1" as const, stage: "done" as const, assignee: "", sentAt: 0, approved: true, skills: [], route: "Code", rounds: 0, stuck: false, created: now - lead, startedAt: now - cycle, servedAt: now, updated: now, ...extra });
		const f = flow([t(1, 60_000, 30_000), t(2, 120_000, 60_000), t(3, 600_000, 300_000), t(4, 1, 1, { failed: true }), { ...t(5, 1, 1), stage: "build" as const }], now);
		expect(f).toMatchObject({ served: 3, failed: 1, wip: 1, leadMedian: 120_000, leadP85: 600_000, cycleMedian: 60_000, throughput24h: 3 });
	});
});

describe("Zachman intake triage", () => {
	it("sorts questions from tasks", async () => {
		const { kindOf } = await import("../src/kitchen/triage");
		for (const q of ["2+2 =?", "how are you", "How are you?", "are you stuck?", "what does the pass do?", "hello there"]) expect(kindOf(q)).toBe("question");
		for (const t of ["fix the login redirect", "Add dark mode to the settings page so night users can read it", "can you add a retry to the upload?", "Refactor the store into modules"]) expect(kindOf(t)).toBe("task");
	});

	it("fills a Zachman card for a task, with the reason when the order gives one", async () => {
		const { zachman } = await import("../src/kitchen/triage");
		const z = zachman({ title: "Add dark mode so night users can read it", cwd: "/work/app", priority: "P0", route: "Design", skills: ["spec-driven-workflow"], kind: "task" });
		expect(z).toMatchObject({ what: "Add dark mode", where: "app", when: "Now, before anything else", why: "night users can read it" });
		expect(z.who).toContain("Design agent");
		expect(z.how).toContain("spec → build → test → review");
	});

	it("answers arithmetic at once, with no agent", async () => {
		const { quickMath } = await import("../src/kitchen/triage");
		expect(["2+2 =?", "2 + 2 = ?", "(3+4)*2", "10/4", "2^10", "7 x 6?"].map(quickMath)).toEqual(["4", "4", "14", "2.5", "1024", "42"]);
		for (const no of ["how are you", "2", "rm -rf /", "1+alert(1)", "Math.max(1,2)"]) expect(quickMath(no)).toBeUndefined();
		const { post, sent } = setup([]);
		const q = (await post("/api/tasks", { title: "2+2 =?", cwd: "/repo" })).body;
		expect(q).toMatchObject({ kind: "question", skills: [] });
		const t = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))[0];
		expect(t).toMatchObject({ stage: "done", answer: "4" });
		expect(t.servedAt - t.created).toBeLessThan(1000);
		expect(sent).toEqual([]);
	});

	it("sends other questions to the front desk, and to the belt if it fails", async () => {
		const asked: string[] = [];
		let fail = false;
		const app = createApp(() => [], async () => {}, {
			ask: async (q) => {
				asked.push(q);
				if (fail) throw new Error("down");
				return "Doing well, thanks.";
			},
		});
		const post = async (path: string, b: object) => (await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json();
		await post("/api/tasks", { title: "how are you", cwd: "/repo" });
		await Bun.sleep(5);
		expect(asked).toEqual(["how are you"]);
		expect(JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))[0]).toMatchObject({ stage: "done", answer: "Doing well, thanks." });
		fail = true;
		await post("/api/tasks", { title: "are you stuck?", cwd: "/repo" });
		await Bun.sleep(5);
		expect(JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))[1]).toMatchObject({ stage: "inbox", assignee: "" });
	});

	it("requeues a failed order as new, sorted again by triage", async () => {
		const { post } = setup([]);
		order({ title: "2+2 =?", stage: "done", failed: true, stuck: true, rounds: 3, answer: "nope", crew: { build: { id: "x", role: "Code", name: "x" } } });
		const r = (await post("/api/tasks/requeue", { id: "t" })).body;
		expect(r).toMatchObject({ kind: "question", stage: "done", answer: "4", failed: false, stuck: false, rounds: 0, requeued: 1 });
		order({ title: "fix the login redirect", stage: "build" });
		expect((await post("/api/tasks/requeue", { id: "t" })).status).toBe(400);
	});
});

describe("fast lane", () => {
	it("sends small tasks build → test → served and keeps big ones in the full kitchen", async () => {
		const { laneOf } = await import("../src/kitchen/triage");
		for (const f of ["fix the typo in the README", "bump hono to 4.6", "rename the Crew tab", "fix login redirect"]) expect(laneOf(f)).toBe("fast");
		for (const b of ["refactor the store into modules", "add search filters to the sessions list with saved views", "migrate the database schema"]) expect(laneOf(b)).toBe("full");
		const { nextStage } = await import("../src/kitchen/pipeline");
		const base = { id: "a", n: 1, title: "x", cwd: "", priority: "P1" as const, assignee: "", sentAt: 0, approved: true, skills: [], route: "Code", rounds: 0, stuck: false, created: 1, updated: 1 };
		expect(nextStage({ ...base, stage: "test", lane: "fast" })).toBe("done");
		expect(nextStage({ ...base, stage: "test" })).toBe("review");
	});

	it("dispatches a fast-lane task straight to build on haiku, with no spec", async () => {
		const sessions: Session[] = [];
		const { post, sent, started } = setup(sessions);
		const t = (await post("/api/tasks", { title: "fix the typo in the README", cwd: "/repo" })).body;
		expect(t).toMatchObject({ kind: "task", lane: "fast" });
		expect(t.zachman.how).toContain("fast lane: build → test");
		await post("/api/containers", { name: "Cooks", role: "Code", stages: ["spec", "build", "test", "review"], replicas: 1, cwd: "/repo" });
		await post("/api/containers/reconcile", {});
		sessions.push({ ...session(started[0].id as string, "Code"), updatedAt: Date.now() - 60_000 });
		await post("/api/containers/reconcile", {});
		await Bun.sleep(30);
		const r = (await post("/api/tasks/dispatch", { id: t.id })).body;
		expect(r).toMatchObject({ stage: "build", approved: true, model: "haiku", effort: "low" });
		expect(sent.at(-1)).toContain("Order #1 (build)");
	});
});

describe("skills and tools that fit the order", () => {
	it("matches catalog skills to an order's own words", async () => {
		const { matchSkills } = await import("../src/kitchen/skills");
		expect(matchSkills("Write playwright e2e tests for the login page").map((s) => s.name)).toContain("playwright-expert");
		expect(matchSkills("add stripe checkout to the shop").map((s) => s.name)[0]).toContain("stripe");
		expect(matchSkills("whats the weather in Australia")).toEqual([]);
		const { post } = setup([]);
		const t = (await post("/api/tasks", { title: "add stripe checkout to the shop with a saved card flow", cwd: "/repo" })).body;
		expect(t.skills.some((n: string) => n.includes("stripe"))).toBe(true);
		expect(t.skills.length).toBeLessThanOrEqual(4);
	});

	it("gives the front desk web search for questions that need live information", async () => {
		const { needsWeb } = await import("../src/kitchen/triage");
		expect(needsWeb("whats the weather in Australia?")).toBe(true);
		expect(needsWeb("what is the latest bun version?")).toBe(true);
		expect(needsWeb("how are you")).toBe(false);
		const asked: { q: string; web?: boolean }[] = [];
		const app = createApp(() => [], async () => {}, { ask: async (q, _c, o) => (asked.push({ q, web: o?.web }), "Sunny, 24°C.") });
		const post = (b: object) => app.request("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
		await post({ title: "whats the weather in Australia?", cwd: "/repo" });
		await post({ title: "how are you", cwd: "/repo" });
		await Bun.sleep(5);
		expect(asked).toEqual([{ q: "whats the weather in Australia?", web: true }, { q: "how are you", web: false }]);
	});
});

describe("idle timer", () => {
	it("keeps the size you set by hand, and wakes back up when an order arrives", async () => {
		const { post } = setup([]);
		const box = (await post("/api/containers", { name: "Cooks", role: "Code", stages: ["build"], replicas: 1, cwd: "/repo" })).body;
		await post("/api/containers/scale", { id: box.id, replicas: 2 });
		await post("/api/kitchen", { auto: true });
		const all = JSON.parse(readFileSync(join(dir, "containers.json"), "utf8"));
		writeFileSync(join(dir, "containers.json"), JSON.stringify(all.map((b: object) => ({ ...b, idleSince: Date.now() - 60 * 60_000 }))));
		await post("/api/kitchen", { auto: true });
		expect(readContainers()[0]).toMatchObject({ replicas: 2, floorByHand: true });
		// An order in its stage clears the timer.
		order({ stage: "build", cwd: "/repo" });
		await post("/api/kitchen", { auto: true });
		expect(readContainers()[0].idleSince).toBeUndefined();
	});

	it("lets you change the idle minutes", async () => {
		const { post } = setup([]);
		expect((await post("/api/kitchen", { idleMinutes: 3 })).body).toMatchObject({ auto: true, idleMinutes: 3 });
		expect((await post("/api/kitchen", { idleMinutes: 0 })).status).toBe(400);
	});
});

describe("stage hand-off", () => {
	it("passes the spec and build notes on, tells each stage its job, and keeps the lessons skill ready", async () => {
		const sessions: Session[] = [];
		const { post, sent, started } = setup(sessions);
		const spec = (await post("/api/containers", { name: "S", role: "Code", stages: ["spec", "build", "test", "review"], replicas: 1, cwd: "/repo" })).body;
		expect(existsSync(join(skills, spec.lessonsSkill, "SKILL.md"))).toBe(true);
		await post("/api/containers/reconcile", {});
		const cook = { ...session(started[0].id as string, "Code"), updatedAt: Date.now() - 60_000 };
		sessions.push(cook);
		await post("/api/containers/reconcile", {});
		order({ stage: "spec", approved: false, title: "add retries to the upload client so flaky networks recover", zachman: undefined });
		await post("/api/tasks/dispatch", { id: "t" });
		expect(sent.at(-1)).toContain("Your job: Write a short spec");
		// The Spec agent answers; serving keeps its reply as the spec.
		cook.feed = [...cook.feed, { who: "agent", text: "Goal: retry uploads 3 times. Checks: 1) a failed upload is retried.", at: Date.now() } as never];
		await post("/api/tasks/serve", { id: "t" });
		await post("/api/tasks/move", { id: "t", approved: true, stage: "test" });
		await post("/api/tasks/dispatch", { id: "t" });
		const msg = sent.at(-1) as string;
		expect(msg).toContain("From the Spec agent:\nGoal: retry uploads 3 times.");
		expect(msg).toContain("Never FAIL because the order is vague");
	});

	it("matches skills on whole words only", async () => {
		const { matchSkills } = await import("../src/kitchen/skills");
		const names = matchSkills("too many agents without work add some timers to fire them if idle long").map((s) => s.name);
		expect(names.some((n) => n.startsWith("workers"))).toBe(false);
		const { zachman } = await import("../src/kitchen/triage");
		expect(zachman({ title: "fix it", cwd: "", priority: "P1", route: "Code", skills: [], kind: "task" }).why).toBe("Inferred by the Spec agent");
	});
});

describe("failure causes found in the agents' chats", () => {
	it("takes the last verdict: FAIL then a corrected PASS passes (#15)", async () => {
		const { verdictIn } = await import("../src/kitchen/routes");
		expect(verdictIn("FAIL — eval is a regression.\n\nCorrected verdict:\n\nPASS — the 2+2 issue is fixed.")).toBe(true);
		expect(verdictIn("PASS looks fine. Wait, FAIL: the date check returns 2013.")).toBe(false);
		expect(verdictIn("I need a concrete deliverable.")).toBeUndefined();
	});

	it("files orders about the board in the board's repo, and a named folder in that folder (#12, #19, #21)", async () => {
		const { whereOf, BOARD_ROOT } = await import("../src/kitchen/routes");
		expect(whereOf("too many agents without work, fire them if idle long", "/x/flisk", [])).toBe(BOARD_ROOT);
		expect(whereOf("seems agents not picking up orders in the inbox", "/x/flisk", [])).toBe(BOARD_ROOT);
		expect(whereOf("fix the release script in flisk", "/x/other", ["/x/flisk", "/x/other"])).toBe("/x/flisk");
		expect(whereOf("fix the release script", "/x/flisk", ["/x/flisk"])).toBe("/x/flisk");
	});

	it("hands on the whole spec reply, not its closing line, and lets the spec move the folder (#21)", async () => {
		const sessions: Session[] = [];
		const { post, sent, started } = setup(sessions);
		await post("/api/containers", { name: "S", role: "Code", stages: ["spec", "build"], replicas: 1, cwd: "/repo" });
		await post("/api/containers/reconcile", {});
		const cook = { ...session(started[0].id as string, "Code"), updatedAt: Date.now() - 60_000 };
		sessions.push(cook);
		await post("/api/containers/reconcile", {});
		order({ stage: "spec", approved: false, title: "add retries to the upload client so flaky networks recover", cwd: "/repo" });
		await post("/api/tasks/dispatch", { id: "t" });
		cook.feed = [...cook.feed, { who: "you", text: "Order #1 (spec)", at: Date.now() } as never, { who: "agent", text: `Goal: retry uploads 3 times.\nFolder: ${tmpdir()}`, at: Date.now() } as never, { who: "agent", text: "Spec complete.", at: Date.now() } as never];
		const served = (await post("/api/tasks/serve", { id: "t" })).body;
		expect(served.notes.spec).toContain("Goal: retry uploads 3 times.");
		expect(served.notes.spec).toContain("Spec complete.");
		expect(served.cwd).toBe(tmpdir());
		expect(sent.at(-1)).toContain("add a line 'Folder:");
	});

	it("tells builders never to ask or wait, and requeued orders to start fresh (#12, #20)", async () => {
		const { post, sent } = setup([{ ...session("b", "Build"), updatedAt: Date.now() - 60_000 }]);
		order({ stage: "build", requeued: 1, cwd: "/repo" });
		await post("/api/tasks/dispatch", { id: "t", session: "b" });
		const msg = sent.at(-1) as string;
		expect(msg).toContain("Never ask questions or wait for approval");
		expect(msg).toContain("do not commit or push");
		expect(msg).toContain("This order was requeued: treat it as new.");
	});

	it("counts a refusal as a strike but does not keep it as a lesson (#12)", async () => {
		const { post, started } = setup([]);
		await post("/api/containers", { name: "Cooks", role: "Code", stages: ["build"], replicas: 1, cwd: "/repo" });
		await post("/api/containers/reconcile", {});
		const { strike } = await import("../src/kitchen/containers");
		strike(started[0].id as string, "#12", "REJECT: Order #12 closed and will not reopen. Resubmit with a concrete target.");
		strike(started[0].id as string, "#13", "FAIL: range(1,3) returned [1,2], expected [1,2,3].");
		const box = readContainers()[0];
		expect(box.pods[0].strikes).toBe(2);
		expect(box.lessons.map((l) => l.order)).toEqual(["#13"]);
	});
});

describe("requeue routing", () => {
	it("routes a requeued board order to the board's repo, and ignores generic words for skills", async () => {
		const { BOARD_ROOT } = await import("../src/kitchen/routes");
		const { post } = setup([]);
		order({ title: "seems agents not picking up orders in the inbox", stage: "done", failed: true, cwd: "/x/flisk" });
		expect((await post("/api/tasks/requeue", { id: "t" })).body.cwd).toBe(BOARD_ROOT);
		const { matchSkills } = await import("../src/kitchen/skills");
		expect(matchSkills("tasks not really opening, see the Owner guide links").map((s) => s.name)).not.toContain("terraform-style-guide");
	});
});

describe("one chat per order", () => {
	it("gives a container agent a fresh chat for a new order, and keeps it for the same order", async () => {
		const sessions: Session[] = [];
		const { post, sent, started } = setup(sessions);
		await post("/api/containers", { name: "B", role: "Code", stages: ["build"], replicas: 1, cwd: "/repo" });
		await post("/api/containers/reconcile", {});
		const first = started[0].id as string;
		sessions.push({ ...session(first, "Build"), updatedAt: Date.now() - 60_000 });
		await post("/api/containers/reconcile", {});
		order({ id: "a", n: 1, stage: "build", cwd: "/repo" });
		const a = (await post("/api/tasks/dispatch", { id: "a" })).body;
		expect(a).toMatchObject({ assignee: first, fresh: false });
		// Another round of the same order: same chat.
		writeFileSync(join(dir, "tasks.json"), JSON.stringify([{ ...a, assignee: "", sentAt: 0, rounds: 1 }]));
		expect((await post("/api/tasks/dispatch", { id: "a" })).body).toMatchObject({ assignee: first, fresh: false });
		// A different order: a new chat, started with the order itself, and the pod keeps its place.
		writeFileSync(join(dir, "tasks.json"), JSON.stringify([{ id: "b", n: 2, title: "fix the import path in src/app.ts", cwd: "/repo", priority: "P1", stage: "build", assignee: "", sentAt: 0, approved: true, skills: [], route: "Code", rounds: 0, stuck: false, created: 1, updated: 1 }]));
		const b = (await post("/api/tasks/dispatch", { id: "b" })).body;
		expect(b.fresh).toBe(true);
		expect(b.assignee).not.toBe(first);
		expect(started.at(-1)).toMatchObject({ id: b.assignee });
		expect(started.at(-1)?.text).toContain("Order #2 (build)");
		expect(readContainers()[0].pods.find((p) => p.status !== "evicted")).toMatchObject({ session: b.assignee, lastOrder: "b" });
		expect(sent.filter((x) => x.includes("Order #2"))).toEqual([]);
	});

	it("reads a spec's folder in any form, and lets you move an order's folder", async () => {
		const { folderHint, BOARD_ROOT } = await import("../src/kitchen/routes");
		expect(folderHint("Folder: /a/b.")).toBe("/a/b");
		expect(folderHint("**Folder**  \n`/Users/x/flisk`")).toBe("/Users/x/flisk");
		expect(folderHint("Spec step finished, with the build target named as `run-my-agents` rather than flisk.")).toBe(BOARD_ROOT);
		expect(folderHint("target is `pages`", ["/x/pages"])).toBe("/x/pages");
		expect(folderHint("no folder here")).toBeUndefined();
		const { post } = setup([]);
		order({ stage: "build", cwd: "/repo" });
		expect((await post("/api/tasks/move", { id: "t", cwd: tmpdir() })).body.cwd).toBe(tmpdir());
		expect((await post("/api/tasks/move", { id: "t", cwd: "/no/such/folder" })).status).toBe(400);
	});
});
