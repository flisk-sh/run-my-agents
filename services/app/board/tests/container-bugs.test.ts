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
	it("#245: closes the chat of a builder fired by a Test FAIL", async () => {
		const sessions: Session[] = [tester("FAIL: mean([]) returns NaN.")];
		const { post, started } = setup(sessions);
		await post("/api/containers", { name: "Builders", role: "Code", stages: ["build"], replicas: 1, cwd: "/repo", maxStrikes: 1 });
		await post("/api/containers/reconcile", {});
		const pod = readContainers()[0].pods[0];
		sessions.push(session(started[0].id as string, "Code"));
		await post("/api/containers/reconcile", {});
		// Crew stores the pod's stable id (dispatch: `const podId = pod?.id ?? who`).
		order({ stage: "test", assignee: "tester", sentAt: 1, crew: { build: { id: pod.id, role: "Code", name: "Builders abcd" } } });
		expect((await post("/api/tasks/serve", { id: "t", pass: false })).body.fired).toBe(true);
		expect(readHidden()).toContain(pod.session);
	});
	it("#241: keeps the skills a container gained when it fired an agent, even when it already has 6 learned skills", async () => {
		const sessions: Session[] = [];
		const { post, started } = setup(sessions);
		const learned = ["find-bugs", "flisk-ports", "flisk-starlark-perf", "flisk-agents", "flisk-release", "flisk-import-procfile"];
		await post("/api/containers", { name: "Build · repo", role: "Build", stages: ["build"], replicas: 1, cwd: "/repo", maxStrikes: 1, skills: learned });
		await post("/api/containers/reconcile", {});
		const hit = strike(started[0].id as string, "#1 fix it", "FAIL: range(1,3) gave [1,2], the loop end is off by one.");
		expect(hit?.fired).toBe(true);
		expect(hit?.gained).toContain("verification-loop");
		expect(readContainers()[0].skills).toEqual(expect.arrayContaining(hit?.gained ?? []));
		// One autopilot pass later (the sidecar runs in it):
		await post("/api/kitchen", { auto: true });
		expect(readContainers()[0].skills).toEqual(expect.arrayContaining(hit?.gained ?? []));
	});

	it("#237: matches a skill on two of the title's words or its whole name, not on one shared word", async () => {
		const { matchSkills } = await import("../src/kitchen/skills");
		const names = (t: string) => matchSkills(t, 3).map((x) => x.name);
		// Live titles that used to pull in unrelated skills.
		expect(names("Find bugs in queueus and if flisk here works with agetns")).toEqual(["find-bugs"]);
		expect(names("fix ci failed https://github.com/flisk-sh/flisk/pull/3150")).toEqual([]);
		expect(names("FAIL: range(1,3) gave [1,2], the loop end is off by one.")).toEqual([]);
		expect(names("add product(xs) to src/math.ts: multiply all numbers, 1 for an empty list, with tests")).toEqual([]);
		// Skills that fit still match.
		expect(names("do new release https://github.com/flisk-sh/flisk")).toContain("flisk-release");
		expect(names("write playwright e2e tests for the login page")).toContain("playwright");
		expect(names("do a security review of the auth code")).toContain("security-review");
	});

	it("#237: keeps a learned skill only while its orders go better than the container's others", async () => {
		const { post } = setup([]);
		await post("/api/containers", { name: "Build · repo", role: "Build", stages: ["build"], replicas: 1, cwd: "/repo", skills: ["terraform-test"] });
		const crew = { build: { id: "x", role: "Build", name: "Build · repo abcd" } };
		const done = (n: number, skills: string[], failed = false) => task({ id: `t${n}`, n, cwd: "/repo", stage: "done", failed, skills, crew });
		// terraform-test rode along on 3 served orders, and the container's other orders were served too: no better.
		writeFileSync(join(dir, "tasks.json"), JSON.stringify([done(1, ["terraform-test"]), done(2, ["terraform-test"]), done(3, ["terraform-test"]), done(4, []), done(5, [])]));
		expect((await post("/api/kitchen", { auto: true })).body.did).toContain("Build · repo: sidecar dropped /terraform-test");
		expect(readContainers()[0].skills).toContain("focused-fix");
	});

	it("#237: keeps a learned skill whose orders went better than the rest", async () => {
		const { post } = setup([]);
		await post("/api/containers", { name: "Build · repo", role: "Build", stages: ["build"], replicas: 1, cwd: "/repo", skills: ["find-bugs"] });
		const crew = { build: { id: "x", role: "Build", name: "Build · repo abcd" } };
		const done = (n: number, skills: string[], failed = false) => task({ id: `t${n}`, n, cwd: "/repo", stage: "done", failed, skills, crew });
		writeFileSync(join(dir, "tasks.json"), JSON.stringify([done(1, ["find-bugs"]), done(2, ["find-bugs"]), done(3, ["find-bugs"]), done(4, [], true), done(5, [])]));
		await post("/api/kitchen", { auto: true });
		expect(readContainers()[0].skills).toContain("find-bugs");
	});
	it("#242: scales down by letting an idle agent go, not the one cooking an order", async () => {
		const sessions: Session[] = [];
		const { post, started } = setup(sessions);
		const box = (await post("/api/containers", { name: "Builders", role: "Code", stages: ["build"], replicas: 2, cwd: "/repo" })).body;
		await post("/api/containers/reconcile", {});
		for (const s of started) sessions.push(session(s.id as string, "Code"));
		await post("/api/containers/reconcile", {});
		const [older] = readContainers()[0].pods;
		// The older pod takes an order in a fresh chat (what dispatch does for every step after a pod's first).
		freshChat(older.session, "busy-chat", "t");
		sessions.push(session("busy-chat", "Code"));
		order({ stage: "build", cwd: "/repo", assignee: "busy-chat", sentAt: Date.now() });
		await post("/api/containers/reconcile", {});
		await post("/api/containers/scale", { id: box.id, replicas: 1 });
		const busy = readContainers()[0].pods.find((p) => p.id === older.id);
		expect(busy?.status).not.toBe("evicted");
	});
	it("#243: keeps the size you set by hand while orders wait", async () => {
		const { post } = setup([]);
		const t = task({ stage: "build", cwd: "/work/app", title: "add search filters to the sessions list with saved views" });
		writeFileSync(join(dir, "tasks.json"), JSON.stringify([0, 1, 2, 3].map((i) => ({ ...t, id: `t${i}`, n: i + 1 }))));
		await post("/api/kitchen", { auto: true });
		await post("/api/kitchen", { auto: true });
		const box = readContainers().find((x) => x.name === "Build · app");
		expect(box?.replicas).toBe(3);
		const r = await post("/api/containers/scale", { id: box?.id, replicas: 1 });
		expect(r.body.replicas).toBe(1);
	});
	it("#244: keeps a ready agent that has been quiet for an hour instead of evicting and rebooting it", async () => {
		const sessions: Session[] = [];
		const { post, started } = setup(sessions);
		await post("/api/containers", { name: "Builders", role: "Code", stages: ["build"], replicas: 1, cwd: "/repo" });
		await post("/api/containers/reconcile", {});
		sessions.push(session(started[0].id as string, "Code"));
		await post("/api/containers/reconcile", {});
		expect(readContainers()[0].pods[0].status).toBe("ready");
		// 70 quiet minutes later its transcript is older than the listing window, so it is no longer in k.read().
		const boxes = JSON.parse(readFileSync(join(dir, "containers.json"), "utf8"));
		writeFileSync(join(dir, "containers.json"), JSON.stringify(boxes.map((b: { pods: { started: number }[] }) => ({ ...b, pods: b.pods.map((p) => ({ ...p, started: Date.now() - 70 * 60_000 })) }))));
		sessions.length = 0;
		await post("/api/containers/reconcile", {});
		expect(readContainers()[0].pods.map((p) => [p.status, p.reason])).toEqual([["ready", undefined]]);
		expect(started).toHaveLength(1);
	});
	it("#246: does not make a second Build container for an order filed from a subfolder of the same repo", async () => {
		const { post } = setup([]);
		writeFileSync(join(dir, "tasks.json"), JSON.stringify([task({ id: "a", n: 1, cwd: "/work/repo" }), task({ id: "b", n: 2, cwd: "/work/repo/services/app/board/src/kitchen" })]));
		await post("/api/kitchen", { auto: true });
		expect(readContainers().filter((x) => x.stages.length === 1 && x.stages[0] === "build").map((x) => x.name)).toEqual(["Build · repo"]);
	});

	it("#174: puts an order back on the belt at once when its agent was fired, not after 30 minutes", async () => {
		const sessions: Session[] = [];
		const { post, started } = setup(sessions);
		await post("/api/containers", { name: "Build · repo", role: "Build", stages: ["build"], replicas: 1, cwd: "/repo" });
		await post("/api/containers/reconcile", {});
		const chat = started[0].id as string;
		sessions.push(session(chat, "Build"));
		await post("/api/containers/reconcile", {});
		order({ stage: "build", cwd: "/repo", assignee: chat, sentAt: Date.now() });
		await post("/api/containers/fire", { session: chat, reason: "Kept editing the wrong repo." });
		await post("/api/containers/reconcile", {});
		expect(tasks()[0].assignee).not.toBe(chat);
		expect(tasks()[0].missedBy).toContain(chat);
	});

	it("#321: drops a learned skill that none of the container's last 10 orders carried", async () => {
		const { post } = setup([]);
		await post("/api/containers", { name: "Build · repo", role: "Build", stages: ["build"], replicas: 1, cwd: "/repo", skills: ["terraform-test", "find-bugs"] });
		const crew = { build: { id: "x", role: "Build", name: "Build · repo abcd" } };
		const done = (n: number, skills: string[]) => task({ id: `t${n}`, n, cwd: "/repo", stage: "done", skills, crew, servedAt: n });
		// terraform-test: 2 old orders, then 10 without it. find-bugs: in one of the last 10.
		const all = [done(1, ["terraform-test"]), done(2, ["terraform-test"]), ...Array.from({ length: 10 }, (_, i) => done(3 + i, i === 5 ? ["find-bugs"] : []))];
		writeFileSync(join(dir, "tasks.json"), JSON.stringify(all));
		expect((await post("/api/kitchen", { auto: true })).body.did).toContain("Build · repo: sidecar dropped /terraform-test");
		expect(readContainers()[0].skills).toContain("find-bugs");
	});

	it("#324: checks a kitchen agent's answer to a question, and fails it instead of serving a non-answer", async () => {
		const reply = "Constraint: no data source configured.\n\n**Outcome:** Unable to fulfill without external data access.\n\n**FAIL:** Real-time weather data source.";
		const agent = { ...session("q1", "Build"), feed: [{ who: "you", text: "Question", at: 1 } as never, { who: "agent", text: reply, at: 2 } as never] };
		const checked: string[] = [];
		const { post } = setup([agent], { ask: async (q, _c, o) => (o?.system ? (checked.push(q), '{"ok": false, "missing": "real-time weather data"}') : "x") });
		order({ kind: "question", title: "weateher in London today?", stage: "inbox", assignee: "q1", sentAt: 1 });
		await post("/api/tasks/serve", { id: "t" });
		await Bun.sleep(20);
		const t = tasks()[0];
		// The whole reply was checked, not its last 400 characters.
		expect(checked[0]).toContain("Constraint: no data source configured.");
		expect(t).toMatchObject({ stage: "done", failed: true });
		expect(t.answer).toBeUndefined();
		expect(t.failures.at(-1)).toContain("answer: not an answer (real-time weather data)");
	});

	it("#324: serves a kitchen agent's answer that passes the check, whole", async () => {
		const reply = `${"Looked at src/math.ts. ".repeat(30)}sum([]) returns 0: reduce starts from 0.`;
		const agent = { ...session("q1", "Build"), feed: [{ who: "you", text: "Question", at: 1 } as never, { who: "agent", text: reply, at: 2 } as never] };
		const { post } = setup([agent], { ask: async (_q, _c, o) => (o?.system ? '{"ok": true}' : "x") });
		order({ kind: "question", title: "what does sum([]) return?", stage: "inbox", assignee: "q1", sentAt: 1 });
		await post("/api/tasks/serve", { id: "t" });
		await Bun.sleep(20);
		expect(tasks()[0]).toMatchObject({ stage: "done", answer: reply });
	});

	it("#326: tells the answer check not to reject an answer only because it cannot verify it", async () => {
		const checks: string[] = [];
		const { post } = setup([], { ask: async (q, _c, o) => (o?.system ? (checks.push(q), '{"ok": true}') : "London today: 12°C, showers from 1pm (Met Office).") });
		await post("/api/tasks", { title: "weateher in London today?", cwd: "/repo" });
		await Bun.sleep(20);
		expect(checks[0]).toContain("The reply was written with web search");
		expect(checks[0]).toContain("do not reject a specific answer only because you cannot verify it");
		expect(tasks()[0]).toMatchObject({ stage: "done", answer: "London today: 12°C, showers from 1pm (Met Office)." });
	});

	it("#325: installs only the skills the pick keeps, never one it was not offered", async () => {
		const fetched: string[] = [];
		const offered: string[] = [];
		const { post } = setup([], {
			fetch: (async (u: string) => (fetched.push(String(u)), new Response("---\nname: x\n---\n"))) as unknown as typeof fetch,
			ask: async (q, _c, o) => {
				if (o?.system && q.includes("Which of these skills")) {
					offered.push(...[...q.matchAll(/^- ([\w.-]+):/gm)].map((m) => m[1]));
					// Like the model on #74: none of the candidates fit; it also names one it was not offered.
					return '{"skills": ["weather-forecast-pro"]}';
				}
				if (o?.system) return '{"ok": false, "missing": "real-time weather data access - the reply cannot be verified"}';
				return "Hmm.";
			},
		});
		await post("/api/tasks", { title: "weateher in London today?", cwd: "/repo" });
		await Bun.sleep(40);
		expect(offered.length).toBeGreaterThan(0);
		// /django-access-review and /claude-api may be candidates for "access" and "data"; neither is installed.
		expect(tasks()[0].skills ?? []).toEqual([]);
		expect(fetched).toEqual([]);
	});

	it("#179: gives up on a skill whose download keeps failing, and sends the order without it", async () => {
		const { resetSkillFails } = await import("../src/kitchen/skills");
		resetSkillFails();
		const fetched: string[] = [];
		const sessions: Session[] = [];
		const { post, started } = setup(sessions, { fetch: (async (u: string) => (fetched.push(String(u)), new Response("nope", { status: 404 }))) as unknown as typeof fetch });
		await post("/api/containers", { name: "Build · repo", role: "Build", stages: ["build"], replicas: 1, cwd: "/repo" });
		await post("/api/containers/reconcile", {});
		sessions.push({ ...session(started[0].id as string, "Build"), updatedAt: Date.now() - 60_000 });
		order({ stage: "build", cwd: "/repo", skills: ["playwright-expert"] });
		const realNow = Date.now;
		let now = realNow();
		Date.now = () => now;
		try {
			// Ticks over 4 minutes: each failure waits longer before the next try, then the skill is given up.
			for (let i = 0; i < 48; i++) {
				now += 5_000;
				await post("/api/kitchen", { auto: true });
				await Bun.sleep(1);
			}
		} finally {
			Date.now = realNow;
		}
		expect(fetched.filter((u) => u.includes("playwright")).length).toBeLessThanOrEqual(3);
		expect(tasks()[0].assignee).not.toBe("");
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
