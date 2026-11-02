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
	// When the board last wrote to the chat is unknown here; tests that need it set asked themselves.
	return { ...s, role, updatedAt: now, asked: undefined };
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

	it("gives the agent that replaces a fired one the lessons in its order and skills the fired one did not have", async () => {
		const sessions: Session[] = [];
		const { post, started, sent } = setup(sessions);
		await post("/api/containers", { name: "Build · repo", role: "Build", stages: ["build"], replicas: 1, cwd: "/repo", maxStrikes: 2 });
		await post("/api/containers/reconcile", {});
		const first = started[0].id as string;
		const tester = (reason: string) => ({ ...session("tester", "Test"), feed: [{ who: "you", text: "Order", at: 1 } as never, { who: "agent", text: reason, at: 2 } as never] });
		sessions.push(session(first, "Build"));
		await post("/api/containers/reconcile", {});
		const before = readContainers()[0].skills;
		// Two orders fail in test: the Build agent is fired.
		sessions.push(tester("FAIL: mean([]) returns NaN, the empty list is not handled."));
		order({ stage: "test", assignee: "tester", sentAt: 1, crew: { build: { id: first, role: "Build", name: "x" } } });
		await post("/api/tasks/serve", { id: "t", pass: false });
		sessions.splice(sessions.findIndex((x) => x.id === "tester"), 1, tester("FAIL: range(1,3) gives [1,2], the loop end is off by one."));
		order({ stage: "test", assignee: "tester", sentAt: 1, rounds: 1, crew: { build: { id: first, role: "Build", name: "x" } } });
		expect((await post("/api/tasks/serve", { id: "t", pass: false })).body.fired).toBe(true);
		// More skills: the container gained skills its stage set and the fired agent did not have, and installs them.
		const box = readContainers()[0];
		const gained = box.pods.find((p) => p.session === first)?.gained ?? [];
		expect(gained.length).toBeGreaterThan(0);
		expect(gained).toContain("verification-loop");
		for (const n of gained) expect(before).not.toContain(n);
		expect(box.skills).toEqual(expect.arrayContaining(gained));
		await Bun.sleep(10);
		for (const n of gained) expect(existsSync(join(skills, n, "SKILL.md"))).toBe(true);
		// A new agent spins up in its place.
		await post("/api/containers/reconcile", {});
		expect(started).toHaveLength(2);
		const second = started[1].id as string;
		sessions.push({ ...session(second, "Build"), updatedAt: Date.now() - 60_000 });
		await post("/api/containers/reconcile", {});
		// More knowledge: its next order spells out what got the last agent fired, and lists the new skills.
		order({ n: 2, title: "add median()", stage: "build", cwd: "/repo", kind: "task" });
		expect((await post("/api/tasks/dispatch", { id: "t" })).body.assignee).toBe(second);
		const text = sent.at(-1) as string;
		expect(text).toContain("Lessons from agents this container fired");
		expect(text).toContain("mean([]) returns NaN");
		expect(text).toContain("the loop end is off by one");
		for (const n of gained) expect(text).toContain(`/${n}`);
	});

	it("sends a failed ship back to ship, not to review without a PR", async () => {
		const { post } = setup([]);
		order({ stage: "test", shipping: true, assignee: "ship", sentAt: 1, cwd: "/repo" });
		const r = await post("/api/tasks/serve", { id: "t" });
		expect(r.body.stage).toBe("ship");
		expect(r.body.pr).toBeUndefined();
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
	it("asks a test agent that stopped with no PASS or FAIL to finish, then counts it as FAIL with what it last said", async () => {
		const tester = { ...session("quiet-tester", "Bug"), updatedAt: Date.now() - 20_000 };
		// Order #29: the agent ran the tests in the background and ended its turn before they finished.
		tester.feed = [...tester.feed, { who: "agent", text: "Let me run the tests.\n\nNo response requested.", at: Date.now() - 20_000 } as never];
		const { post } = setup([tester]);
		order({ stage: "test", assignee: tester.id, sentAt: Date.now() - 60_000 });
		expect((await post("/api/kitchen", { auto: true })).body.did).toContain("#1 test gave no verdict: asked again");
		expect(JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))[0]).toMatchObject({ stage: "test", answered: 1 });
		order({ stage: "test", assignee: tester.id, sentAt: Date.now() - 60_000, answered: 2 });
		expect((await post("/api/kitchen", { auto: true })).body.did).toContain("#1 test FAIL");
		const t = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))[0];
		expect(t).toMatchObject({ stage: "build", rounds: 1 });
		expect(t.failures.at(-1)).toBe("test: FAIL: stopped without a PASS or FAIL line. Last said: No response requested.");
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
		expect(z.how).toContain("spec → build → test → pull request → review");
	});

	it("answers arithmetic at once, with no agent", async () => {
		const { quickMath } = await import("../src/kitchen/triage");
		expect(["2+2 =?", "2 + 2 = ?", "(3+4)*2", "10/4", "2^10", "7 x 6?"].map(quickMath)).toEqual(["4", "4", "14", "2.5", "1024", "42"]);
		for (const no of ["how are you", "2", "rm -rf /", "1+alert(1)", "Math.max(1,2)"]) expect(quickMath(no)).toBeUndefined();
		// Dates and phone numbers read as subtraction or division, so they must not be answered as sums.
		for (const no of ["2026-11-02", "11/02/2026", "555-1234", "1-800-555-0199"]) expect(quickMath(no)).toBeUndefined();
		expect(["10-4", "10/4", "100 - 2"].map(quickMath)).toEqual(["6", "2.5", "98"]);
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
	it("sends small tasks build → test → review (no spec) and keeps big ones in the full kitchen", async () => {
		const { laneOf } = await import("../src/kitchen/triage");
		for (const f of ["fix the typo in the README", "bump hono to 4.6", "rename the Crew tab", "fix login redirect"]) expect(laneOf(f)).toBe("fast");
		for (const b of ["refactor the store into modules", "add search filters to the sessions list with saved views", "migrate the database schema"]) expect(laneOf(b)).toBe("full");
		const { nextStage } = await import("../src/kitchen/pipeline");
		const base = { id: "a", n: 1, title: "x", cwd: "", priority: "P1" as const, assignee: "", sentAt: 0, approved: true, skills: [], route: "Code", rounds: 0, stuck: false, created: 1, updated: 1 };
		// Order #28 went build → test → served and its PR was never reviewed: the fast lane skips only the spec.
		expect(nextStage({ ...base, stage: "test", lane: "fast" })).toBe("review");
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
		// "tests" alone is no reason for Terraform skills; "terraform" is.
		expect(matchSkills("add a mean(xs) function to src/math.ts that returns 0 for an empty list, with tests").map((s) => s.name).join()).not.toContain("terraform");
		expect(matchSkills("fix flaky jest tests").map((s) => s.name).join()).not.toContain("terraform");
		expect(matchSkills("write terraform tests for the vpc module").map((s) => s.name)).toContain("terraform-test");
		const names = matchSkills("review the auth code for security").map((s) => s.name);
		expect(names.length).toBe(new Set(names).size);
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
	it("hands on a spec's head, not just its closing line, and never the record block", async () => {
		const { handOffOf } = await import("../src/kitchen/protocol");
		const spec = `## Spec\nGoal: add mean().\nChecks: mean([]) is 0.\n${"detail ".repeat(2000)}\nSpec complete.\n\`\`\`kitchen\n{"evidence": "x"}\n\`\`\``;
		const out = handOffOf(spec);
		expect(out).toContain("Goal: add mean().");
		expect(out).toContain("Spec complete.");
		expect(out).not.toContain("```kitchen");
		expect(out.length).toBeLessThan(6200);
	});

	it("reads the verdict from the record; a monologue that says both is no verdict (#15)", async () => {
		const { verdictIn } = await import("../src/kitchen/routes");
		// The last word no longer wins: "FAIL … corrected verdict: PASS" is asked for a verdict instead of passing.
		expect(verdictIn("FAIL — eval is a regression.\n\nCorrected verdict:\n\nPASS — the 2+2 issue is fixed.")).toBeUndefined();
		expect(verdictIn("PASS looks fine. Wait, FAIL: the date check returns 2013.")).toBeUndefined();
		expect(verdictIn("I need a concrete deliverable.")).toBeUndefined();
		expect(verdictIn("Ran bun test.\n\n**PASS** — 12 pass.")).toBe(true);
		// The record decides, whatever the prose says.
		expect(verdictIn('PASS at first sight.\n```kitchen\n{"verdict": "FAIL", "evidence": "bun test: 2 fail"}\n```')).toBe(false);
		expect(verdictIn('Mentions FAIL and PASS.\n```kitchen\n{"verdict": "PASS"}\n```')).toBe(true);
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

describe("lanes, scores and crew clean-up", () => {
	it("keeps the FAIL line as the lesson, drops junk, and names the stage once", async () => {
		const { failLine } = await import("../src/kitchen/routes");
		expect(failLine("Checked it.\n\n**FAIL** — range(1,3) returned [1,2], expected [1,2,3].")).toBe("FAIL — range(1,3) returned [1,2], expected [1,2,3].");
		expect(failLine("Ready.")).toBe("");
		const { isLesson } = await import("../src/kitchen/containers");
		expect(["Ready.", "Let me check the build lessons to understand", "REJECT: will not reopen"].map(isLesson)).toEqual([false, false, false]);
		expect(["FAIL — returned 2013 for a date", "Stuck after 3 rounds.", "Missed: no progress for 30 min."].map(isLesson)).toEqual([true, true, true]);
		const { post } = setup([]);
		order({ stage: "build", cwd: "/repo", title: "add search filters to the sessions list with saved views" });
		await post("/api/kitchen", { auto: true });
		expect(readFileSync(join(skills, "rma-lessons-build", "SKILL.md"), "utf8")).toContain("Lessons the Build agents learned");
	});

	it("scores crew rows, not chats, and leaves out questions and pre-triage orders", async () => {
		const { crewKey, ratings } = await import("../src/kitchen/scores");
		expect(crewKey({ id: "a", role: "Build", name: "Build · flisk 3125" })).toEqual({ key: "Build · flisk", label: "Build · flisk", role: "Build" });
		expect(crewKey({ id: "b", role: "Code", name: 'You are a Code agent in the "Kitchen cooks" agent container on' }).key).toBe("Kitchen cooks");
		expect(crewKey({ id: "c", role: "Code", name: "kicken" }).key).toBe("c");
		const t = (n: number, who: string, extra = {}) => ({ id: `t${n}`, n, title: "x", cwd: "", priority: "P1" as const, stage: "done" as const, assignee: "", sentAt: 0, approved: true, skills: [], route: "Code", rounds: 0, stuck: false, created: 1, updated: 1, kind: "task" as const, crew: { build: { id: who, role: "Build", name: `Build · flisk ${who}` } }, ...extra });
		const rs = ratings([t(1, "aaaa"), t(2, "bbbb"), t(3, "cccc", { kind: undefined })], { "Build · flisk": 1 });
		expect(rs).toHaveLength(1);
		expect(rs[0]).toMatchObject({ label: "Build · flisk", role: "Build", steps: 2, served: 2, strikes: 1 });
	});

	it("retires an old all-stage container once its agents hold no order", async () => {
		const { post } = setup([]);
		const { createContainer } = await import("../src/kitchen/containers");
		createContainer({ name: "Kitchen cooks", role: "Code", stages: ["spec", "build", "test", "review"], replicas: 2, cwd: "/repo" });
		expect((await post("/api/kitchen", { auto: true })).body.did).toContain("Kitchen cooks: replaced by stage agents");
		expect(readContainers().find((x) => x.name === "Kitchen cooks")).toMatchObject({ replicas: 0, downReason: "Replaced by stage agents" });
	});
});

describe("ship and the skill sidecar", () => {
	it("opens a PR when tests pass, then the Review agent reviews that PR, and a fix after a FAIL goes to the same PR", async () => {
		const sessions: Session[] = [];
		const { post, started, sent } = setup(sessions);
		// No worktree (built before the board made them): it goes to review without shipping, never from the shared checkout.
		order({ kind: "task", stage: "test", assignee: "tst", sentAt: 1, cwd: "/repo", notes: { build: "x" } });
		expect((await post("/api/tasks/serve", { id: "t", pass: true })).body).toMatchObject({ stage: "review", assignee: "" });
		order({ kind: "task", worktree: tmpdir(), stage: "test", assignee: "tst", sentAt: 1, cwd: "/repo", notes: { build: "Changed src/a.ts" }, crew: { build: { id: "b", role: "Build", name: "Build · repo b000" } } });
		const r = (await post("/api/tasks/serve", { id: "t", pass: true })).body;
		expect(r).toMatchObject({ stage: "test", shipping: true });
		const ship = started.at(-1);
		expect(ship).toMatchObject({ id: r.assignee, mode: "acceptEdits", model: "haiku", cwd: tmpdir() });
		expect(ship?.text).toContain("git commit -s");
		expect(ship?.text).toContain("gh pr create");
		expect(ship?.text).toContain("kitchen/order-1");
		// The ship agent replies with the PR: the order goes to Review with the link, not straight to served.
		const pr = "https://github.com/flisk-sh/run-my-agents/pull/999";
		sessions.push({ ...session(r.assignee, "Build"), feed: [{ who: "you", text: "Ship", at: 1 } as never, { who: "agent", text: `Opened ${pr}.`, at: 2 } as never] });
		const reviewing = (await post("/api/tasks/serve", { id: "t" })).body;
		expect(reviewing).toMatchObject({ stage: "review", shipping: false, pr, assignee: "" });
		// The Review agent is told to review the pull request itself and post its review there.
		sessions.push({ ...session("rev", "Review"), updatedAt: Date.now() - 60_000 });
		await post("/api/tasks/dispatch", { id: "t", session: "rev" });
		expect(sent.at(-1)).toContain(`gh pr diff ${pr}`);
		expect(sent.at(-1)).toContain(`gh pr review ${pr} --comment`);
		// Review FAILs: Build fixes it, tests pass, and the fix is pushed to the same PR before Review looks again.
		writeFileSync(join(dir, "tasks.json"), JSON.stringify([{ ...JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))[0], stage: "test", assignee: "tst", sentAt: 1, rounds: 1 }]));
		const again = (await post("/api/tasks/serve", { id: "t", pass: true })).body;
		expect(again).toMatchObject({ shipping: true, pr });
		expect(started.at(-1)?.text).toContain(`pull request ${pr} updates by itself`);
		expect(started.at(-1)?.text).not.toContain("gh pr create");
		// Review passes: served, with the link kept.
		writeFileSync(join(dir, "tasks.json"), JSON.stringify([{ ...JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))[0], stage: "review", shipping: false, assignee: "rev", sentAt: 1 }]));
		expect((await post("/api/tasks/serve", { id: "t", pass: true })).body).toMatchObject({ stage: "done", pr });
	});

	it("ships the change in the worktree even when the Build agent's summary is empty", async () => {
		// Order #30: 114 changed lines sat in its worktree, never shipped, because its build hand-off was empty.
		const { post, started } = setup([]);
		order({ kind: "task", worktree: tmpdir(), stage: "test", assignee: "tst", sentAt: 1, cwd: "/repo", notes: {} });
		expect((await post("/api/tasks/serve", { id: "t", pass: true })).body).toMatchObject({ stage: "test", shipping: true });
		expect(started.at(-1)?.text).toContain("gh pr create");
		expect(started.at(-1)?.text).not.toContain("From the Build agent");
	});

	it("starts kitchen agents in auto mode, and the board makes each order's worktree and starts its agent there", async () => {
		const { execFileSync } = await import("node:child_process");
		const repo = mkdtempSync(join(tmpdir(), "rma-wt-"));
		const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
		g("init", "-q", "-b", "main");
		writeFileSync(join(repo, "a.txt"), "x");
		g("add", ".");
		g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
		const sessions: Session[] = [];
		const { post, started } = setup(sessions);
		await post("/api/containers", { name: "B", role: "Code", stages: ["build"], replicas: 1, cwd: repo });
		await post("/api/containers/reconcile", {});
		expect(started[0]).toMatchObject({ mode: "acceptEdits" });
		sessions.push({ ...session(started[0].id as string, "Build"), cwd: repo, updatedAt: Date.now() - 60_000 });
		await post("/api/containers/reconcile", {});
		order({ n: 7, stage: "build", cwd: repo, kind: "task" });
		const r = (await post("/api/tasks/dispatch", { id: "t" })).body;
		const { realpathSync } = await import("node:fs");
		const wt = join(realpathSync(repo), ".kitchen", "order-7");
		expect(r).toMatchObject({ worktree: wt, fresh: true });
		expect(existsSync(join(wt, "a.txt"))).toBe(true);
		expect(execFileSync("git", ["-C", wt, "branch", "--show-current"], { encoding: "utf8" }).trim()).toBe("kitchen/order-7");
		expect(started.at(-1)).toMatchObject({ cwd: wt, mode: "acceptEdits" });
		expect(started.at(-1)?.text).toContain(`You are in this order's own git worktree: ${wt}`);
		// A second stage reuses the same worktree instead of making another.
		const { orderWorktree } = await import("../src/kitchen/routes");
		expect(orderWorktree(repo, 7)).toBe(wt);
		expect(orderWorktree("", 7)).toBeUndefined();
	});

	it("moves an order when its builder says the code lives in another folder, and builds again there", async () => {
		const { elsewhere } = await import("../src/kitchen/routes");
		expect(elsewhere("This order requires access to `/Users/x/flisk-candidate-test-draft/` and belongs in a separate build container")).toBe("/Users/x/flisk-candidate-test-draft");
		expect(elsewhere("Changed src/a.ts")).toBeUndefined();
		const other = mkdtempSync(join(tmpdir(), "rma-other-"));
		const { post } = setup([{ ...session("bb", "Build"), feed: [{ who: "you", text: "Order", at: 1 } as never, { who: "agent", text: `Blocked: the code lives in \`${other}\`.`, at: 2 } as never] }]);
		order({ stage: "build", assignee: "bb", sentAt: 1, cwd: "/repo", kind: "task" });
		const r = (await post("/api/tasks/serve", { id: "t" })).body;
		expect(r).toMatchObject({ stage: "build", cwd: other, assignee: "", moved: other });
	});

	it("writes a missing lessons skill before a container's agents start", async () => {
		const { post } = setup([]);
		const { createContainer } = await import("../src/kitchen/containers");
		const { rmSync } = await import("node:fs");
		createContainer({ name: "Review · repo", role: "Review", lessonsKey: "review", stages: ["review"], replicas: 1, cwd: "/repo" });
		rmSync(join(skills, "rma-lessons-review"), { recursive: true, force: true });
		await post("/api/containers/reconcile", {});
		expect(readFileSync(join(skills, "rma-lessons-review", "SKILL.md"), "utf8")).toContain("Lessons the Review agents learned");
	});

	it("injects an order's skills into its container, then drops a skill whose orders keep failing", async () => {
		const sessions: Session[] = [];
		const { post, started } = setup(sessions);
		await post("/api/containers", { name: "Build · repo", role: "Build", stages: ["build"], replicas: 1, cwd: "/repo" });
		await post("/api/containers/reconcile", {});
		sessions.push({ ...session(started[0].id as string, "Build"), updatedAt: Date.now() - 60_000 });
		await post("/api/containers/reconcile", {});
		order({ stage: "build", cwd: "/repo", skills: ["playwright-expert"] });
		await post("/api/tasks/dispatch", { id: "t" });
		await Bun.sleep(20);
		await post("/api/tasks/dispatch", { id: "t" });
		expect(readContainers()[0].skills).toContain("playwright-expert");
		// Two failed orders that carried it: the sidecar drops it, and keeps the stage's own set.
		const crew = { build: { id: "x", role: "Build", name: "Build · repo abcd" } };
		const failed = (id: string) => ({ id, n: 2, title: "x", cwd: "/repo", priority: "P1", stage: "done", failed: true, kind: "task", assignee: "", sentAt: 0, approved: true, skills: ["playwright-expert"], route: "Code", rounds: 3, stuck: false, created: 1, updated: 1, crew });
		writeFileSync(join(dir, "tasks.json"), JSON.stringify([failed("a"), failed("b")]));
		const did = (await post("/api/kitchen", { auto: true })).body.did;
		expect(did).toContain("Build · repo: sidecar dropped /playwright-expert");
		const box = readContainers()[0];
		expect(box.skills).not.toContain("playwright-expert");
		expect(box.skills).toContain("focused-fix");
	});

	it("gives the front desk the skills that fit the question", async () => {
		const asked: { skills?: string }[] = [];
		writeFileSync(join(skills, "x.txt"), "");
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(skills, "playwright-expert"), { recursive: true });
		writeFileSync(join(skills, "playwright-expert", "SKILL.md"), "Use page.getByRole.");
		const app = createApp(() => [], async () => {}, { ask: async (_q, _c, o) => (asked.push({ skills: o?.skills }), "Use getByRole."), fetch: (async () => new Response("x")) as unknown as typeof fetch });
		await app.request("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "how do I select a button in playwright?", cwd: "/repo" }) });
		await Bun.sleep(5);
		expect(asked[0].skills).toContain("## /playwright-expert");
		expect(asked[0].skills).toContain("Use page.getByRole.");
	});
});

describe("follow-up on failure", () => {
	it("records each FAIL, then opens one follow-up task that carries the reasons and the old spec", async () => {
		const tester = { ...session("tst", "Test"), feed: [{ who: "you", text: "Order", at: 1 } as never, { who: "agent", text: "Ran it.\n**FAIL** — range(1,3) returned [1,2], expected [1,2,3].", at: 2 } as never] };
		const { post, sent } = setup([tester, { ...session("bld", "Build"), updatedAt: Date.now() - 60_000 }]);
		order({ kind: "task", stage: "test", assignee: "tst", sentAt: 1, rounds: 2, cwd: "/repo", notes: { spec: "Goal: include the end." } });
		const r = (await post("/api/tasks/serve", { id: "t", pass: false })).body;
		expect(r).toMatchObject({ stuck: true, failures: ["test: FAIL — range(1,3) returned [1,2], expected [1,2,3]."] });
		const did = (await post("/api/kitchen", { auto: true })).body.did;
		expect(did).toContain("#1 closed as failed");
		expect(did).toContain("#1 followed up as #2");
		const [old, next] = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"));
		expect(old).toMatchObject({ failed: true, followUp: 2 });
		expect(next).toMatchObject({ n: 2, title: "fix it", lane: "full", retryOf: 1, failures: old.failures, notes: { spec: "Goal: include the end." } });
		// Its agents are told what went wrong last time.
		writeFileSync(join(dir, "tasks.json"), JSON.stringify([old, { ...next, stage: "build", approved: true }]));
		await post("/api/tasks/dispatch", { id: next.id, session: "bld" });
		expect(sent.at(-1)).toContain("This is the second attempt at #1, which failed.");
		expect(sent.at(-1)).toContain("- test: FAIL — range(1,3) returned [1,2]");
	});

	it("does not follow up a follow-up, so a hopeless order cannot loop", async () => {
		const { post } = setup([]);
		order({ kind: "task", stage: "test", stuck: true, rounds: 3, retryOf: 9 });
		const did = (await post("/api/kitchen", { auto: true })).body.did;
		expect(did).toContain("#1 closed as failed");
		expect(did.some((d: string) => d.includes("followed up"))).toBe(false);
		expect(JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))).toHaveLength(1);
	});
});

describe("the orchestrator answers agents", () => {
	it("spots an agent that stopped to ask, and not one that finished", async () => {
		const { asksBack } = await import("../src/kitchen/routes");
		const build = { stage: "build" as const };
		expect(asksBack("I'll ship order #12.\n\nWould you like me to proceed with creating the branch and shipping order #12?", build)).toBe(true);
		expect(asksBack("Changed src/a.ts. Should I also update the docs", build)).toBe(true);
		expect(asksBack("Done. Changed src/a.ts; run bun test to check.", build)).toBe(false);
		expect(asksBack("Is this right?\n\n**PASS** — all checks hold.", { stage: "test" })).toBe(false);
		expect(asksBack("Opened https://github.com/a/b/pull/7. Anything else?", { stage: "review", shipping: true })).toBe(false);
	});

	it("answers a waiting agent for the user, twice at most, then moves the step on", async () => {
		const agent = { ...session("ask1", "Build"), updatedAt: Date.now() - 20_000, feed: [{ who: "you", text: "Order #1", at: 1 } as never, { who: "agent", text: "Would you like me to proceed?", at: 2 } as never] };
		const { post, sent } = setup([agent]);
		const due = () => {
			const t = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))[0];
			writeFileSync(join(dir, "tasks.json"), JSON.stringify([{ ...t, sentAt: Date.now() - 60_000 }]));
		};
		order({ kind: "task", stage: "build", assignee: "ask1", sentAt: Date.now() - 60_000, cwd: "/repo" });
		expect((await post("/api/kitchen", { auto: true })).body.did).toContain("#1 answered build agent's question");
		expect(sent.at(-1)).toContain("nobody will approve or answer this");
		expect(sent.at(-1)).not.toContain("Yes, go ahead");
		due();
		expect((await post("/api/kitchen", { auto: true })).body.did).toContain("#1 answered build agent's question");
		due();
		const did = (await post("/api/kitchen", { auto: true })).body.did;
		expect(did).toContain("#1 build done");
		expect(sent.filter((m) => m.includes("nobody will approve or answer this"))).toHaveLength(2);
		expect(JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))[0]).toMatchObject({ stage: "test", answered: 0 });
	});
});

describe("stray agents", () => {
	it("tells a kitchen agent with no order that asks to stop, once, and leaves your own chats alone", async () => {
		const ask = (id: string, title: string) => ({ ...session(id, "Build"), title, updatedAt: Date.now() - 20_000, feed: [{ who: "you", text: "Ship order #12", at: 1 } as never, { who: "agent", text: "Would you like me to proceed with shipping order #12?", at: 2 } as never] });
		const { post, sent } = setup([ask("ship1", "Ship · #12"), ask("mine", "my own chat")]);
		const did = (await post("/api/kitchen", { auto: true })).body.did;
		expect(did).toContain("answered stray agent Ship · #12: no order");
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("no order is waiting on you");
		expect(sent[0]).toContain("Do not run any command or edit any file");
		await post("/api/kitchen", { auto: true });
		expect(sent).toHaveLength(1);
	});
});

describe("tidy and address", () => {
	it("closes idle kitchen agents with no order, keeps your chats, held agents and live container agents", async () => {
		const old = (id: string, title: string) => ({ ...session(id, "Build"), title, updatedAt: Date.now() - 5 * 60_000 });
		const { post } = setup([old("s12", "Ship · #12"), old("b31", "Build · flisk 3125"), old("mine", "my own chat"), old("held", "Build · flisk e5d4")]);
		order({ kind: "task", stage: "build", assignee: "held", sentAt: Date.now() - 60_000, cwd: "/repo" });
		const did = (await post("/api/kitchen", { auto: true })).body.did;
		expect(did).toContain("closed idle agent Ship · #12");
		expect(did).toContain("closed idle agent Build · flisk 3125");
		expect(did.join()).not.toContain("my own chat");
		expect(did.join()).not.toContain("e5d4");
	});

	it("tells every agent its reply goes to the orchestrator", async () => {
		const { post, sent } = setup([{ ...session("b", "Build"), updatedAt: Date.now() - 60_000 }]);
		order({ stage: "build", cwd: "/repo" });
		await post("/api/tasks/dispatch", { id: "t", session: "b" });
		expect(sent.at(-1)).toContain("Your reply goes to the kitchen's orchestrator, a program, not a person");
	});
});

describe("dispatch to agents in a worktree", () => {
	it("still sends a new order to a free agent whose last chat was in another order's worktree", async () => {
		const sessions: Session[] = [];
		const { post, started } = setup(sessions);
		await post("/api/containers", { name: "Build · repo", role: "Build", stages: ["build"], replicas: 1, cwd: "/repo" });
		await post("/api/containers/reconcile", {});
		sessions.push({ ...session(started[0].id as string, "Build"), cwd: "/repo/.git/kitchen/order-23", updatedAt: Date.now() - 60_000 });
		await post("/api/containers/reconcile", {});
		order({ n: 24, stage: "build", cwd: "/repo", kind: "task" });
		expect((await post("/api/kitchen", { auto: true })).body.did).toContain("#24 sent");
		const { sameRepo } = await import("../src/kitchen/routes");
		expect(sameRepo("/repo/.git/kitchen/order-3", "/repo")).toBe(true);
		expect(sameRepo("/repo2", "/repo")).toBe(false);
		// An order filed from a subfolder goes to the repo's agents, wherever their last worktree left them.
		expect(sameRepo("/repo/.kitchen/order-25/services/app/board", "/repo/services/app/board/src/kitchen")).toBe(true);
		expect(sameRepo("/repo", "/repo/services/app")).toBe(true);
		expect(sameRepo("/repo2/.kitchen/order-1", "/repo/sub")).toBe(false);
		expect(sameRepo("/repo/sub", "/repo")).toBe(false);
	});

	it("sends an order filed from a subfolder to a ready pod of that repo", async () => {
		const sessions: Session[] = [];
		const { post, started } = setup(sessions);
		await post("/api/containers", { name: "Build · repo", role: "Build", stages: ["build"], replicas: 1, cwd: "/repo" });
		await post("/api/containers/reconcile", {});
		sessions.push({ ...session(started[0].id as string, "Build"), cwd: "/repo/.kitchen/order-25/services/app/board", updatedAt: Date.now() - 60_000 });
		await post("/api/containers/reconcile", {});
		order({ n: 12, stage: "build", cwd: "/repo/services/app/board/src/kitchen", kind: "task" });
		expect((await post("/api/kitchen", { auto: true })).body.did).toContain("#12 sent");
	});
});

describe("agent to agent", () => {
	const agent = (id: string, role: string, reply: string) => ({ ...session(id, role), updatedAt: Date.now() - 20_000, feed: [{ who: "you", text: "Order", at: 1 } as never, { who: "agent", text: reply, at: 2 } as never] });

	const ask = (to: string, question: string) => `I read the spec.\n\`\`\`kitchen\n${JSON.stringify({ ask: { to, question } })}\n\`\`\``;
	const tasks = () => JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"));

	it("answers a structured ask with a fresh turn on the asked stage's record, matched back by its id", async () => {
		const builder = agent("bld", "Build", ask("spec", "does 'show the orchestrator' mean a chef on the Kitchen tab?"));
		const spec = agent("spc", "Spec", "Goal: …");
		const sent: { to: string; text: string }[] = [];
		const asked: string[] = [];
		let reply = (_: string) => {};
		const answered = new Promise<void>((r) => (reply = () => r()));
		const app = createApp(() => [builder, spec], async (s, text) => void sent.push({ to: s.id, text }), {
			ask: async (q) => {
				asked.push(q);
				reply("");
				return "Yes: a chef on the bridge, labelled Orchestrator.";
			},
		});
		const post = async (path: string, body: object) => (await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
		order({ kind: "task", stage: "build", assignee: "bld", sentAt: Date.now() - 60_000, cwd: "/repo", notes: { spec: "Goal: show the orchestrator.\nChecks: a chef labelled Orchestrator." }, crew: { spec: { id: "spc", role: "Spec", name: "Spec · repo spc0" }, build: { id: "bld", role: "Build", name: "Build · repo bld0" } } });
		expect((await post("/api/kitchen", { auto: true })).did).toContain("#1 Build asked Spec");
		await answered;
		// The answer came from one fresh call whose only input is the Spec record, not from the Spec chat.
		expect(asked[0]).toContain("Goal: show the orchestrator.");
		expect(asked[0]).toContain("Question from the Build agent: does 'show the orchestrator' mean a chef on the Kitchen tab?");
		expect(sent.filter((m) => m.to === "spc")).toEqual([]);
		const t = tasks()[0];
		expect(t).toMatchObject({ assignee: "bld", asked: 1, waitingOn: { stage: "spec", question: expect.any(String) } });
		expect(typeof t.waitingOn.id).toBe("string");
		await Bun.sleep(5);
		// A Spec chat that moves on its own (a tool call, a person typing) is not the answer: only the ask id is.
		spec.updatedAt = Date.now() - 10_000;
		expect((await post("/api/kitchen", { auto: true })).did).toContain("#1 Spec answered");
		expect(sent.at(-1)).toMatchObject({ to: "bld" });
		expect(sent.at(-1)?.text).toContain("Yes: a chef on the bridge, labelled Orchestrator.");
		expect(tasks()[0].waitingOn).toBeUndefined();
		expect(tasks()[0].talk.map((x: { from: string; to: string }) => `${x.from}→${x.to}`)).toEqual(["Build→Spec", "Spec→Build"]);
	});

	it("does not ask a stage that has not run: the asker gets the policy, not a guess", async () => {
		const builder = agent("bld", "Build", ask("test", "will the tests pass?"));
		const { post, sent } = setup([builder]);
		order({ kind: "task", stage: "build", assignee: "bld", sentAt: Date.now() - 60_000, cwd: "/repo" });
		expect((await post("/api/kitchen", { auto: true })).body.did).toContain("#1 Build asked Test: no record to answer from, told to decide");
		expect(sent.at(-1)).toContain("The Test stage of order #1 has not run or left no record");
		expect(sent.at(-1)).toContain("FAIL: the decision that is missing");
		const { ADDRESS, verdictIn } = await import("../src/kitchen/routes");
		expect(ADDRESS).toContain("```kitchen");
		// Prose that looks like a message is not one any more.
		const { recordIn } = await import("../src/kitchen/protocol");
		expect(recordIn("To Spec: what is X?")).toBeUndefined();
		expect(recordIn('```kitchen\n{"ask": {"to": "Spec", "question": "what is X?"}}\n```')).toEqual({ ask: { to: "spec", question: "what is X?" } });
		expect(recordIn("```kitchen\nnot json\n```")).toBeUndefined();
		expect(verdictIn("x")).toBeUndefined();
	});

	it("fails the step when an ask times out instead of answering for the asked agent", async () => {
		const builder = agent("bld", "Build", "working");
		const sent: string[] = [];
		const app = createApp(() => [builder], async (_, text) => void sent.push(text), { ask: () => new Promise<string>(() => {}) });
		const post = async (path: string, body: object) => (await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
		order({ kind: "task", stage: "build", assignee: "bld", sentAt: Date.now() - 60_000, cwd: "/repo", notes: { spec: "Goal" }, waitingOn: { id: "a1", stage: "spec", question: "q?", at: Date.now() - 11 * 60_000 } });
		// The board restarted while the ask ran: it is asked again under the same id, not answered by the orchestrator.
		await post("/api/kitchen", { auto: true });
		expect(tasks()[0].waitingOn.id).toBe("a1");
		expect((await post("/api/kitchen", { auto: true })).did).toContain("#1 Spec did not answer: failed");
		expect(tasks()[0]).toMatchObject({ stuck: true, assignee: "" });
		expect(tasks()[0].failures.at(-1)).toContain('asked Spec "q?" and got no answer');
		expect(sent).toEqual([]);
	});

	it("keeps what a step's agent said before the orchestrator answered it, so the next stage gets the whole hand-off", async () => {
		const spec = agent("spc", "Spec", "## Spec\nGoal: add mean().\nChecks: mean([]) is 0.\n\nShall I proceed with this spec?");
		const { post } = setup([spec]);
		order({ kind: "task", stage: "spec", assignee: "spc", sentAt: Date.now() - 60_000, cwd: "/repo" });
		expect((await post("/api/kitchen", { auto: true })).body.did).toContain("#1 answered spec agent's question");
		// It answers "Yes, go ahead" with one line; the spec it wrote before must still reach Build.
		spec.feed = [...spec.feed, { who: "you", text: "Decide yourself.", at: 3 } as never, { who: "agent", text: "Spec is final.", at: 4 } as never];
		spec.updatedAt = Date.now() - 10_000;
		let t = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))[0];
		writeFileSync(join(dir, "tasks.json"), JSON.stringify([{ ...t, sentAt: Date.now() - 30_000 }]));
		await post("/api/kitchen", { auto: true });
		t = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))[0];
		expect(t.notes.spec).toContain("Goal: add mean().");
		expect(t.notes.spec).toContain("Spec is final.");
		expect(t.draft).toBeUndefined();
	});

	it("does not read a chat whose last message from the board is older than the order, as after a board restart", async () => {
		// Order #27: the Spec chat was still on its start-up turn ("ready") when the order was sent.
		const spec = { ...agent("spc", "Spec", "ready"), asked: Date.now() - 120_000 };
		const { post } = setup([spec]);
		order({ kind: "task", stage: "spec", assignee: "spc", sentAt: Date.now() - 60_000, cwd: "/repo" });
		expect((await post("/api/kitchen", { auto: true })).body.did).not.toContain("#1 spec done");
		expect(JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))[0]).toMatchObject({ stage: "spec", assignee: "spc" });
		// The order lands and the agent replies: now its spec is read.
		spec.asked = Date.now() - 50_000;
		spec.feed = [...spec.feed, { who: "you", text: "Order #1 (spec)", at: 3 } as never, { who: "agent", text: "## Spec\nGoal: add mean().", at: 4 } as never];
		await post("/api/kitchen", { auto: true });
		expect(JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))[0].notes.spec).toBe("## Spec\nGoal: add mean().");
	});
});

describe("kitchen permissions", () => {
	it("starts and resumes kitchen chats with the tool allow-list, and leaves your own chats alone", async () => {
		const { sendToSession, startNewSession } = await import("../src/index");
		const { KITCHEN_TOOLS } = await import("../src/kitchen/containers");
		const calls: string[][] = [];
		const run = ((_cmd: string, args: string[]) => {
			calls.push(args);
			return { on: (e: string, f: () => void) => e === "close" && setTimeout(f, 0), stdin: { end() {} } };
		}) as never;
		await startNewSession({ agent: "claude", cwd: "/repo", text: "x", id: "a", mode: "acceptEdits", allow: KITCHEN_TOOLS }, run);
		expect(calls[0]).toContain("--allowedTools");
		expect(calls[0]).toContain("Bash(git:*)");
		expect(calls[0][calls[0].indexOf("--permission-mode") + 1]).toBe("acceptEdits");
		await sendToSession({ ...session("k", "Build"), title: "Build · repo 1a2b", tune: { mode: "acceptEdits" } }, "hi", run);
		expect(calls[1]).toContain("Bash(gh:*)");
		await sendToSession({ ...session("m", "Code"), title: "my own chat" }, "hi", run);
		expect(calls[2]).not.toContain("--allowedTools");
	});
});
