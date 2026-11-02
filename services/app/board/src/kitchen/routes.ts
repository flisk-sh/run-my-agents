// The kitchen's HTTP API, mounted on the board's app: orders, the scoreboard, skill sets and agent containers.
// Everything the board owns (reading sessions, sending a message, starting an agent) comes in through KitchenCtx,
// so this module never reaches into the board's internals and can be tested on its own.
import type { Context, Hono } from "hono";
import type { Session } from "../sessions";
import { createContainer, type Container, patchContainer, podOf, readContainers, reconcile, removeContainer, served, strike } from "./containers";
import { addTask, beltOrder, nextStage, PRIORITIES, readTasks, removeTask, sendBack, STAGE_ROLES, STAGES, type Stage, type Task, updateTask } from "./pipeline";
import { flow, ratings, scoreboard } from "./scores";
import { JsonStore } from "./store";
import { kindOf, laneOf, needsWeb, quickMath, zachman, zachmanLines } from "./triage";
import { haikuFit, lessonsSkill, matchSkills, POLICY, policyFor, SKILLS, skillset, skillsFor, skillState, STAGE_SKILLS, stock } from "./skills";

export type KitchenCtx = {
	read: () => Session[];
	/** Sends one message to a session; a Response with status >= 400 means it was refused. */
	send: (s: Session, text: string, body: string) => Response;
	busy: (s: Session) => boolean;
	start: (n: { agent: "claude"; cwd: string; text: string; model?: string; effort?: string; id: string; role: string }) => void;
	tune: (id: string, t: { model?: string; effort?: string }) => void;
	close: (id: string) => void;
	/** The front desk: one short model call that answers a question, with no tools and no session. */
	ask?: (question: string, cwd: string, opts?: { web?: boolean }) => Promise<string>;
	/** Names a session on the board (container agents get their container's name). */
	name?: (id: string, label: string) => void;
	guessRole: (title: string) => string;
	sameOrigin: (c: Context) => boolean;
	fetch?: typeof fetch;
	promptLimit: number;
	/** How often the container control loop runs; 0 turns it off (tests call /api/containers/reconcile). */
	every?: number;
};

const body = async <T>(c: Context) => (await c.req.json().catch(() => ({}))) as T;
const lastSaid = (s: Session | undefined) => {
	const m = s?.feed?.filter((x) => x.who === "agent").at(-1) as { text?: string } | undefined;
	return String(m?.text ?? "").slice(-400);
};

/**
 * The ingredients of a task: catalog skills that fit its own words first, then the top skills of the agent type
 * it is routed to, then the planner's first skill. Four at most; all are installed before an agent gets it.
 */
const orderSkills = (title: string, route: string) =>
	[...new Set([...matchSkills(title, 3).map((s) => s.name), ...skillsFor(route, 2).map((s) => s.name), STAGE_SKILLS.spec[0]])].slice(0, 4);

const SETTINGS = new JsonStore<{ auto: boolean }>("kitchen.json");
const settings = () => SETTINGS.read()[0] ?? { auto: true };
/** The most agents the autoscaler runs per folder. */
export const MAX_AGENTS = 3;
/** The assignee of a question the front desk is answering. */
export const FRONT_DESK = "front-desk";
const saveSettings = (v: { auto: boolean }) => SETTINGS.write([v]);

export function mountKitchen(app: Hono, k: KitchenCtx) {
	const guard = (c: Context) => (k.sameOrigin(c) ? undefined : c.json({ error: "Send JSON from the board." }, 403));
	const tick = () => {
		missed();
		auto();
		return reconcile({ sessions: k.read().map((s) => ({ id: s.id, hidden: s.hidden })), start: k.start, close: k.close, name: k.name });
	};
	if (k.every) setInterval(tick, k.every).unref?.();

	/** An order a pod sat on past its container's miss time is a strike, and goes back on the belt. */
	function missed(now = Date.now()) {
		const all = k.read();
		for (const t of readTasks()) {
			if (!t.assignee || !t.sentAt) continue;
			const home = podOf(t.assignee);
			if (!home) continue;
			const s = all.find((x) => x.id === t.assignee);
			const quiet = now - Math.max(t.sentAt, s?.updatedAt ?? 0);
			if (quiet < home.container.missMinutes * 60_000) continue;
			const r = strike(t.assignee, `#${t.n} ${t.stage}`, `Missed: no progress on "${t.title}" for ${home.container.missMinutes} min.`);
			if (r?.fired) k.close(t.assignee);
			updateTask(t.id, { assignee: "", sentAt: 0, missedBy: [...(t.missedBy ?? []), t.assignee] });
		}
	}


	/**
	 * Who should cook an order's next step: a free pod of a container that cooks the stage, else an idle agent of a
	 * type that fits, else any idle agent (the model policy still applies). Says why when nobody is free.
	 */
	function pick(order: Task, podsOnly = false): { session?: Session; why: string } {
		const busy = new Set(readTasks().filter((x) => x.assignee && x.id !== order.id).map((x) => x.assignee));
		const all = k.read();
		const free = (x: Session) => !x.hidden && !busy.has(x.id) && !order.missedBy?.includes(x.id) && !k.busy(x) && (!order.cwd || x.cwd === order.cwd);
		const key = order.stage === "inbox" ? (order.lane === "fast" ? "build" : "spec") : order.stage;
		const boxes = readContainers().filter((x) => order.kind === "question" || x.stages.includes(key));
		const pod = boxes.flatMap((x) => x.pods.filter((p) => p.status === "ready").map((p) => all.find((s) => s.id === p.session))).find((s): s is Session => !!s && free(s));
		const stage = order.stage === "inbox" ? (order.lane === "fast" ? "build" : "spec") : order.stage;
		const fits = stage === "build" ? [order.route, ...STAGE_ROLES.build.filter((r) => r !== order.route)] : STAGE_ROLES[stage];
		if (podsOnly) {
			if (pod) return { session: pod, why: "" };
			return { why: boxes.length ? "Its container agents are busy. It goes to the first one that finishes." : `No agent container cooks ${order.stage === "inbox" ? "spec" : order.stage}. Add one on the Crew tab, or drop the order on an agent to use that chat.` };
		}
		const session = pod ?? fits.map((r) => all.find((x) => x.role === r && free(x))).find(Boolean) ?? all.find(free);
		if (session) return { session, why: "" };
		const open = all.filter((x) => !x.hidden);
		const why = !open.length
			? "No agents on the board. Start a session or add an agent container."
			: order.cwd && !open.some((x) => x.cwd === order.cwd)
				? `No agent works in ${order.cwd}. Start one there.`
				: "Every agent is busy. It goes to the first one that finishes.";
		return { why };
	}

	/**
	 * The front desk answers a question without the kitchen: arithmetic at once, anything else with one short
	 * Haiku call. If the call fails, the question goes on the belt for a container agent as before.
	 */
	function frontDesk(t: Task) {
		if (t.kind !== "question") return;
		const now = Date.now();
		const math = quickMath(t.title);
		if (math !== undefined) {
			updateTask(t.id, { stage: "done", answer: math, startedAt: now, servedAt: now, assignee: "", sentAt: 0 });
			return;
		}
		if (!k.ask) return;
		updateTask(t.id, { assignee: FRONT_DESK, sentAt: now, startedAt: now });
		k.ask(t.title, t.cwd, { web: needsWeb(t.title) })
			.then((answer) => updateTask(t.id, { stage: "done", answer: answer.trim() || "(no answer)", servedAt: Date.now(), assignee: "", sentAt: 0 }))
			.catch(() => updateTask(t.id, { assignee: "", sentAt: 0 }));
	}

	// ---------- orders ----------
	app.get("/api/scores", (c) => {
		const strikes: Record<string, number> = {};
		for (const box of readContainers()) for (const p of box.pods) strikes[p.session] = (strikes[p.session] ?? 0) + p.strikes;
		return c.json({ ...scoreboard(readTasks()), ratings: ratings(readTasks(), strikes), flow: flow(readTasks()) });
	});
	app.get("/api/tasks", (c) =>
		c.json({
			stages: STAGES,
			roles: STAGE_ROLES,
			tasks: beltOrder(readTasks()).map((t) => ({
				...t,
				skills: t.skills.map((name) => ({ name, state: skillState(name), haiku: haikuFit(name) })),
				why: t.assignee || t.stage === "done" ? "" : t.stuck ? "Stuck: look at it, then serve it or send it back." : t.atPass ? (settings().auto ? "Spec done: crossing the pass." : "Waiting at the pass for your approval.") : t.skills.some((n) => skillState(n) !== "ok") ? "Installing its skills." : pick(t, settings().auto).why,
			})),
		}),
	);
	app.post("/api/tasks", async (c) => {
		const no = guard(c);
		if (no) return no;
		const b = await body<{ title?: string; cwd?: string; priority?: string }>(c);
		const title = String(b.title ?? "").trim();
		if (!title) return c.json({ error: "Describe the order first." }, 400);
		if (title.length > k.promptLimit) return c.json({ error: "That order is too long." }, 400);
		if (b.priority && !(PRIORITIES as readonly string[]).includes(b.priority)) return c.json({ error: "Pick P0, P1 or P2." }, 400);
		const route = k.guessRole(title);
		// Zachman triage: a question needs no skills and skips the kitchen; a task gets its ingredients and a card.
		const kind = kindOf(title);
		const skills = kind === "question" ? [] : orderSkills(title, route);
		const lane = kind === "task" ? laneOf(title) : undefined;
		const card = zachman({ title, cwd: b.cwd ?? "", priority: b.priority ?? "P1", route, skills, kind, lane });
		const t = addTask({ title, cwd: b.cwd, priority: b.priority, skills, route, kind, lane, zachman: card });
		frontDesk(t);
		stock(skills, k.fetch);
		return c.json(t, 201);
	});
	app.post("/api/tasks/move", async (c) => {
		const no = guard(c);
		if (no) return no;
		const b = await body<{ id?: string; stage?: string; approved?: boolean; priority?: string }>(c);
		if (b.stage && !(STAGES as readonly string[]).includes(b.stage)) return c.json({ error: "Unknown stage." }, 400);
		if (b.priority && !(PRIORITIES as readonly string[]).includes(b.priority)) return c.json({ error: "Pick P0, P1 or P2." }, 400);
		const t = updateTask(String(b.id), {
			...(b.stage ? { stage: b.stage as Stage, assignee: "", sentAt: 0 } : {}),
			...(typeof b.approved === "boolean" ? { approved: b.approved, ...(b.approved ? { atPass: false } : {}) } : {}),
			...(b.priority ? { priority: b.priority as Task["priority"] } : {}),
		});
		return t ? c.json(t) : c.json({ error: "That order is gone." }, 404);
	});
	/**
	 * Requeue: a served or failed order goes back to the inbox as new, sorted again by triage, with its fails,
	 * answer and agents cleared. Lead time keeps counting from when you first ordered it.
	 */
	app.post("/api/tasks/requeue", async (c) => {
		const no = guard(c);
		if (no) return no;
		const { id } = await body<{ id?: string }>(c);
		const t = readTasks().find((x) => x.id === id);
		if (!t) return c.json({ error: "That order is gone." }, 404);
		if (t.stage !== "done" && !t.stuck) return c.json({ error: `#${t.n} is still in the kitchen.` }, 400);
		const route = k.guessRole(t.title);
		const kind = kindOf(t.title);
		const skills = kind === "question" ? [] : orderSkills(t.title, route);
		stock(skills, k.fetch);
		updateTask(t.id, {
			stage: "inbox", assignee: "", sentAt: 0, approved: false, atPass: false, stuck: false, failed: false, rounds: 0,
			missedBy: [], answer: undefined, servedAt: undefined, startedAt: undefined, crew: {}, route, kind, skills,
			lane: kind === "task" ? laneOf(t.title) : undefined,
			zachman: zachman({ title: t.title, cwd: t.cwd, priority: t.priority, route, skills, kind, lane: kind === "task" ? laneOf(t.title) : undefined }),
			requeued: (t.requeued ?? 0) + 1,
		});
		const back = readTasks().find((x) => x.id === t.id);
		if (back) frontDesk(back);
		return c.json(readTasks().find((x) => x.id === t.id));
	});
	app.post("/api/tasks/drop", async (c) => {
		const no = guard(c);
		if (no) return no;
		const { id } = await body<{ id?: string }>(c);
		return removeTask(String(id)) ? c.json({ dropped: true }) : c.json({ error: "That order is gone." }, 404);
	});
	app.post("/api/tasks/skills", async (c) => {
		const no = guard(c);
		if (no) return no;
		const { id } = await body<{ id?: string }>(c);
		const t = readTasks().find((x) => x.id === id);
		if (!t) return c.json({ error: "That order is gone." }, 404);
		stock(t.skills, k.fetch);
		return c.json({ installing: t.skills.filter((n) => skillState(n) !== "ok") }, 202);
	});

	type Out = { status: number; body: Record<string, unknown> };
	/**
	 * Hands an order to an agent: the session you pick, else a free pod of a container that cooks this stage, else
	 * an idle agent (see pick). The step runs on the model policy (the container's own model if it set one).
	 */
	function dispatch(id: string, session?: string, podsOnly = false): Out {
		let t = readTasks().find((x) => x.id === id);
		if (!t) return { status: 404, body: { error: "That order is gone." } };
		if (t.stage === "done") return { status: 400, body: { error: "That order is already served." } };
		if (t.atPass) return { status: 409, body: { error: `#${t.n} waits at the pass for your approval.` } };
		if (t.stage === "inbox" && t.kind !== "question") t = updateTask(t.id, t.lane === "fast" ? { stage: "build", approved: true } : { stage: "spec" }) ?? t;
		if (t.stuck) return { status: 409, body: { error: `#${t.n} failed ${t.rounds} times. Look at it, then serve or send it back yourself.` } };
		// Never hand the same step to two agents: the first one still has it.
		if (t.assignee && t.assignee !== session) return { status: 409, body: { error: `#${t.n} is already with ${k.read().find((x) => x.id === t.assignee)?.role ?? "an agent"}.` } };
		if (t.skills.some((n) => skillState(n) !== "ok")) {
			stock(t.skills, k.fetch);
			return { status: 409, body: { error: "Its skills are still installing." } };
		}
		const order = t;
		const chosen = session ? { session: k.read().find((x) => x.id === session), why: "That agent is gone." } : pick(order, podsOnly);
		const s = chosen.session;
		if (!s) return { status: 409, body: { error: chosen.why } };
		const box = podOf(s.id)?.container;
		// A question is a worker's job (Haiku, low); only planning a task is the orchestrator's.
		const policy = policyFor(order.kind === "question" ? "build" : order.stage, box ? { model: box.model, effort: box.effort } : undefined);
		if (s.agent === "claude") k.tune(s.id, policy);
		const use = skillset(order.stage, [...order.skills, ...(box ? [...box.skills, lessonsSkill(box.slug)] : [])]);
		const verdict = order.stage === "test" || order.stage === "review";
		const card = order.zachman ? `\n\n${zachmanLines(order.zachman)}` : "";
		const text =
			order.kind === "question"
				? `Question #${order.n} from the board: ${order.title}\n\nAnswer it in one short reply. Do not change any files.`
				: `Order #${order.n} (${order.stage}): ${order.title}${card}\n\nUse these skills: ${use.map((n) => `/${n}`).join(", ")}.\n\n${verdict ? "End with one line: PASS or FAIL and why." : `When this ${order.stage} step is finished, say so in one line.`}`;
		const res = k.send(s, `#${order.n} ${order.stage}: ${order.title}`, text);
		if (res.status >= 400) return { status: res.status, body: { error: `${s.role} could not take it right now.` } };
		const crew = { ...(order.crew ?? {}), [order.stage]: { id: s.id, role: s.role, name: s.title || s.role } };
		return { status: 202, body: { ...updateTask(order.id, { assignee: s.id, sentAt: Date.now(), crew, startedAt: order.startedAt ?? Date.now() }), model: policy.model, effort: policy.effort } };
	}

	/**
	 * The agent is done. A finished spec waits at the pass. A FAIL in test or review strikes the pod that built it
	 * and sends the order back to build.
	 */
	function serve(id: string, pass?: boolean): Out {
		const t = readTasks().find((x) => x.id === id);
		if (!t) return { status: 404, body: { error: "That order is gone." } };
		if (pass === false && (t.stage === "test" || t.stage === "review")) {
			const builder = t.crew?.build?.id;
			const why = lastSaid(k.read().find((x) => x.id === t.assignee)) || `${t.stage} said FAIL`;
			const hit = builder ? strike(builder, `#${t.n} ${t.title}`, why) : undefined;
			if (hit?.fired && builder) k.close(builder);
			const back = sendBack(t);
			if (back.stuck && builder) strike(builder, `#${t.n} ${t.title}`, `Stuck after ${back.rounds} rounds.`);
			return { status: 200, body: { ...updateTask(t.id, { ...back, assignee: "", sentAt: 0 }), fired: !!hit?.fired } };
		}
		if (t.kind === "question") {
			const answer = lastSaid(k.read().find((x) => x.id === t.assignee)) || "(no answer)";
			for (const who of new Set(Object.values(t.crew ?? {}).map((x) => x?.id))) if (who) served(who);
			return { status: 200, body: { ...updateTask(t.id, { stage: "done", answer, assignee: "", sentAt: 0, servedAt: Date.now() }) } };
		}
		if (t.stage === "spec" && !t.approved) return { status: 200, body: { ...updateTask(t.id, { atPass: true, assignee: "", sentAt: 0 }) } };
		const to = nextStage(t);
		if (to === "done") for (const who of new Set(Object.values(t.crew ?? {}).map((x) => x?.id))) if (who) served(who);
		return { status: 200, body: { ...updateTask(t.id, { stage: to, assignee: "", sentAt: 0, stuck: false, ...(to === "done" ? { servedAt: Date.now() } : {}) }) } };
	}

	/** An agent finished its step when it went quiet after the order was sent. */
	const finished = (t: Task, s: Session | undefined, now: number) => !!s && t.sentAt > 0 && !k.busy(s) && s.updatedAt > t.sentAt + 1_000 && now - s.updatedAt > 3_000;
	const verdictOf = (s: Session | undefined) => {
		const said = lastSaid(s);
		return /\bFAIL\b/.test(said) ? false : /\bPASS\b/.test(said) ? true : undefined;
	};

	/**
	 * Autopilot, run by the server loop so orders move with no board page open and no buttons: specs cross the pass,
	 * stuck orders close as failed, the autoscaler sizes the containers, finished steps move on (test and review by
	 * their PASS or FAIL), then every waiting order goes to the next free container agent. On by default.
	 * Your own chats only get orders you dispatch by hand.
	 */
	function auto(now = Date.now()) {
		if (!settings().auto) return [];
		const did: string[] = [];
		// Autopilot: a finished spec crosses the pass by itself, and an order stuck after MAX_ROUNDS is closed as
		// failed (a gutter on the scoreboard) so it never blocks the belt.
		for (const t of readTasks()) {
			if (t.atPass) {
				updateTask(t.id, { atPass: false, approved: true, stage: "build", assignee: "", sentAt: 0 });
				did.push(`#${t.n} approved`);
			} else if (t.stuck && t.stage !== "done") {
				updateTask(t.id, { stage: "done", failed: true, assignee: "", sentAt: 0, servedAt: now });
				did.push(`#${t.n} closed as failed`);
			}
		}
		did.push(...autoscale());
		const all = k.read();
		for (const t of readTasks()) {
			if (!t.assignee) continue;
			const s = all.find((x) => x.id === t.assignee);
			if (!finished(t, s, now)) continue;
			// A test or review reply with no PASS or FAIL line counts as FAIL, so the order never waits forever.
			const v = t.stage === "test" || t.stage === "review" ? (verdictOf(s) ?? false) : true;
			serve(t.id, v);
			did.push(`#${t.n} ${t.stage} ${v ? "done" : "FAIL"}`);
		}
		for (const t of beltOrder(readTasks())) {
			if (t.assignee || t.stage === "done" || t.stuck || t.atPass) continue;
			// Auto-dispatch only uses container agents, so orders never land in a chat you are typing in.
			const r = dispatch(t.id, undefined, true);
			if (r.status === 202) did.push(`#${t.n} sent`);
		}
		return did;
	}

	/**
	 * The autoscaler, like a Kubernetes HorizontalPodAutoscaler for agents. Per folder with waiting orders: no
	 * container that cooks them means one is created; every agent busy means one more, up to MAX_AGENTS; no orders
	 * left means back down to one. Containers you made by hand are scaled too, but never deleted.
	 */
	function autoscale() {
		const did: string[] = [];
		const tasks = readTasks();
		const open = tasks.filter((t) => t.stage !== "done" && !t.stuck);
		const folders = new Set([...open.map((t) => t.cwd), ...readContainers().map((x) => x.cwd)]);
		for (const cwd of folders) {
			if (!cwd) continue;
			const here = open.filter((t) => t.cwd === cwd);
			const waiting = here.filter((t) => !t.assignee && !t.atPass).length;
			const working = here.filter((t) => t.assignee).length;
			let box = readContainers().find((x) => x.cwd === cwd && x.stages.length >= 4) ?? readContainers().find((x) => x.cwd === cwd);
			if (!box) {
				if (!waiting) continue;
				box = createContainer({ floor: 1, name: `Auto cooks · ${cwd.split("/").filter(Boolean).pop() ?? "folder"}`, role: "Code", stages: ["spec", "build", "test", "review"], replicas: 1, cwd, model: "", effort: "" });
				stock(["spec", "build", "test", "review"].flatMap((st) => STAGE_SKILLS[st as Stage]), k.fetch);
				did.push(`created ${box.name}`);
				continue;
			}
			const floor = box.floor ?? box.replicas;
			const want = Math.max(floor, 1, Math.min(MAX_AGENTS, working + waiting));
			if (want !== box.replicas && (want > box.replicas || !here.length)) {
				patchContainer(box.id, { replicas: want });
				did.push(`${box.name}: ${box.replicas} → ${want} agents`);
			}
		}
		return did;
	}

	app.post("/api/tasks/dispatch", async (c) => {
		const no = guard(c);
		if (no) return no;
		const b = await body<{ id?: string; session?: string }>(c);
		const r = dispatch(String(b.id), b.session, true);
		return c.json(r.body, r.status as 200);
	});
	app.post("/api/tasks/serve", async (c) => {
		const no = guard(c);
		if (no) return no;
		const { id, pass } = await body<{ id?: string; pass?: boolean }>(c);
		const r = serve(String(id), pass);
		return c.json(r.body, r.status as 200);
	});
	app.get("/api/kitchen", (c) => c.json(settings()));
	app.post("/api/kitchen", async (c) => {
		const no = guard(c);
		if (no) return no;
		const { auto: on } = await body<{ auto?: boolean }>(c);
		if (typeof on !== "boolean") return c.json({ error: "Say on or off." }, 400);
		saveSettings({ auto: on });
		return c.json({ auto: on, did: on ? auto() : [] });
	});

	// ---------- skill sets ----------
	app.get("/api/skillsets", (c) =>
		c.json({
			policy: POLICY,
			stages: Object.fromEntries(STAGES.map((st) => [st, { policy: policyFor(st), skills: STAGE_SKILLS[st].map((n) => ({ name: n, haiku: haikuFit(n), state: skillState(n), what: SKILLS.find((s) => s.name === n)?.what ?? "" })) }])),
		}),
	);

	// ---------- agent containers ----------
	const view = (x: Container) => ({ ...x, lessonsSkill: lessonsSkill(x.slug), ready: x.pods.filter((p) => p.status === "ready").length, skills: x.skills.map((n) => ({ name: n, haiku: haikuFit(n), state: skillState(n) })) });
	app.get("/api/containers", (c) => c.json({ containers: readContainers().map(view), roles: Object.keys(STAGE_ROLES) }));
	app.post("/api/containers", async (c) => {
		const no = guard(c);
		if (no) return no;
		const b = await body<{ name?: string; role?: string; stages?: string[]; replicas?: number; cwd?: string; model?: string; effort?: string; skills?: string[]; maxStrikes?: number; missMinutes?: number }>(c);
		const name = String(b.name ?? "").trim().slice(0, 60);
		if (!name) return c.json({ error: "Name the container." }, 400);
		const stages = (b.stages ?? []).filter((s): s is Stage => (STAGES as readonly string[]).includes(s) && s !== "inbox" && s !== "done");
		if (!stages.length) return c.json({ error: "Pick at least one stage: spec, build, test or review." }, 400);
		if (!b.cwd) return c.json({ error: "Pick the folder its agents work in." }, 400);
		if (b.model && !["haiku", "sonnet", "opus"].includes(b.model)) return c.json({ error: "Pick haiku, sonnet or opus." }, 400);
		const skills = (b.skills ?? []).filter((n) => SKILLS.some((s) => s.name === n));
		const box = createContainer({ ...b, name, role: b.role || STAGE_ROLES[stages[0]][0], stages, cwd: b.cwd, skills, model: b.model ?? "", effort: b.effort ?? "" });
		stock([...skills, ...stages.flatMap((s) => STAGE_SKILLS[s])], k.fetch);
		return c.json(view(box), 201);
	});
	app.post("/api/containers/scale", async (c) => {
		const no = guard(c);
		if (no) return no;
		const { id, replicas } = await body<{ id?: string; replicas?: number }>(c);
		if (!Number.isFinite(replicas)) return c.json({ error: "Say how many agents." }, 400);
		const box = patchContainer(String(id), { replicas: Number(replicas), floor: Math.max(0, Math.min(10, Math.round(Number(replicas)))) });
		if (!box) return c.json({ error: "That container is gone." }, 404);
		tick();
		return c.json(view(readContainers().find((x) => x.id === box.id) ?? box));
	});
	app.post("/api/containers/delete", async (c) => {
		const no = guard(c);
		if (no) return no;
		const { id } = await body<{ id?: string }>(c);
		const box = readContainers().find((x) => x.id === id);
		if (!box) return c.json({ error: "That container is gone." }, 404);
		for (const p of box.pods) if (p.status !== "evicted") k.close(p.session);
		removeContainer(box.id);
		return c.json({ deleted: true });
	});
	/** Fires one agent by hand; the loop replaces it. */
	app.post("/api/containers/fire", async (c) => {
		const no = guard(c);
		if (no) return no;
		const { session, reason } = await body<{ session?: string; reason?: string }>(c);
		const home = podOf(String(session));
		if (!home) return c.json({ error: "That agent is not in a container." }, 404);
		let r = strike(home.pod.session, "fired by hand", String(reason || "Fired by hand."));
		while (r && !r.fired) r = strike(home.pod.session, "fired by hand", String(reason || "Fired by hand."));
		k.close(home.pod.session);
		return c.json({ fired: true, did: tick() });
	});
	app.post("/api/containers/reconcile", (c) => {
		const no = guard(c);
		if (no) return no;
		return c.json({ did: tick() });
	});
	return { tick, missed, auto };
}
