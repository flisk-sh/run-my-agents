// The kitchen's HTTP API, mounted on the board's app: orders, the scoreboard, skill sets and agent containers.
// Everything the board owns (reading sessions, sending a message, starting an agent) comes in through KitchenCtx,
// so this module never reaches into the board's internals and can be tested on its own.
import type { Context, Hono } from "hono";
import type { Session } from "../sessions";
import { createContainer, type Container, patchContainer, podOf, readContainers, reconcile, removeContainer, served, strike } from "./containers";
import { addTask, beltOrder, nextStage, PRIORITIES, readTasks, removeTask, sendBack, STAGE_ROLES, STAGES, type Stage, type Task, updateTask } from "./pipeline";
import { scoreboard } from "./scores";
import { haikuFit, lessonsSkill, POLICY, policyFor, SKILLS, skillset, skillsFor, skillState, STAGE_SKILLS, stock } from "./skills";

export type KitchenCtx = {
	read: () => Session[];
	/** Sends one message to a session; a Response with status >= 400 means it was refused. */
	send: (s: Session, text: string, body: string) => Response;
	busy: (s: Session) => boolean;
	start: (n: { agent: "claude"; cwd: string; text: string; model?: string; effort?: string; id: string; role: string }) => void;
	tune: (id: string, t: { model?: string; effort?: string }) => void;
	close: (id: string) => void;
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

export function mountKitchen(app: Hono, k: KitchenCtx) {
	const guard = (c: Context) => (k.sameOrigin(c) ? undefined : c.json({ error: "Send JSON from the board." }, 403));
	const tick = () => {
		missed();
		return reconcile({ sessions: k.read().map((s) => ({ id: s.id, hidden: s.hidden })), start: k.start, close: k.close });
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
			updateTask(t.id, { assignee: "", sentAt: 0 });
		}
	}

	// ---------- orders ----------
	app.get("/api/scores", (c) => c.json(scoreboard(readTasks())));
	app.get("/api/tasks", (c) =>
		c.json({
			stages: STAGES,
			roles: STAGE_ROLES,
			tasks: beltOrder(readTasks()).map((t) => ({ ...t, skills: t.skills.map((name) => ({ name, state: skillState(name), haiku: haikuFit(name) })) })),
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
		// Ingredients: the planner's skill set plus the top skills of the type that builds it.
		const skills = [...new Set([...STAGE_SKILLS.spec.slice(0, 1), ...skillsFor(route, 2).map((s) => s.name)])];
		const t = addTask({ title, cwd: b.cwd, priority: b.priority, skills, route });
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
			...(typeof b.approved === "boolean" ? { approved: b.approved } : {}),
			...(b.priority ? { priority: b.priority as Task["priority"] } : {}),
		});
		return t ? c.json(t) : c.json({ error: "That order is gone." }, 404);
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

	/**
	 * Hands an order to an agent: the session you pick, else a free pod of a container that cooks this stage, else
	 * the first idle session whose type fits. The step runs on the model policy (container's own model if it set one).
	 */
	app.post("/api/tasks/dispatch", async (c) => {
		const no = guard(c);
		if (no) return no;
		const b = await body<{ id?: string; session?: string }>(c);
		let t = readTasks().find((x) => x.id === b.id);
		if (!t) return c.json({ error: "That order is gone." }, 404);
		if (t.stage === "done") return c.json({ error: "That order is already served." }, 400);
		if (t.stage === "inbox") t = updateTask(t.id, { stage: "spec" }) ?? t;
		if (t.stuck) return c.json({ error: `#${t.n} failed ${t.rounds} times. Look at it, then serve or send it back yourself.` }, 409);
		if (t.skills.some((n) => skillState(n) !== "ok")) {
			stock(t.skills, k.fetch);
			return c.json({ error: "Its skills are still installing." }, 409);
		}
		const order = t;
		const busy = new Set(readTasks().filter((x) => x.assignee && x.id !== order.id).map((x) => x.assignee));
		const all = k.read();
		const free = (x: Session) => !x.hidden && !busy.has(x.id) && !k.busy(x) && (!order.cwd || x.cwd === order.cwd);
		const boxes = readContainers().filter((x) => x.stages.includes(order.stage));
		const podSession = boxes.flatMap((x) => x.pods.filter((p) => p.status === "ready").map((p) => all.find((s) => s.id === p.session))).find((s): s is Session => !!s && free(s));
		const fits = order.stage === "build" ? [order.route, ...STAGE_ROLES.build.filter((r) => r !== order.route)] : STAGE_ROLES[order.stage];
		const s = b.session ? all.find((x) => x.id === b.session) : (podSession ?? fits.map((r) => all.find((x) => x.role === r && free(x))).find(Boolean));
		if (!s) return c.json({ error: `No idle ${fits[0]} agent. Start one, add an agent container, or drop the order on an agent.` }, 409);
		const box = podOf(s.id)?.container;
		const policy = policyFor(order.stage, box ? { model: box.model, effort: box.effort } : undefined);
		if (s.agent === "claude") k.tune(s.id, policy);
		const use = skillset(order.stage, [...order.skills, ...(box ? [...box.skills, lessonsSkill(box.slug)] : [])]);
		const verdict = order.stage === "test" || order.stage === "review";
		const text = `Order #${order.n} (${order.stage}): ${order.title}\n\nUse these skills: ${use.map((n) => `/${n}`).join(", ")}.\n\n${verdict ? "End with one line: PASS or FAIL and why." : `When this ${order.stage} step is finished, say so in one line.`}`;
		const res = k.send(s, `#${order.n} ${order.stage}: ${order.title}`, text);
		if (res.status >= 400) return res;
		const crew = { ...(order.crew ?? {}), [order.stage]: { id: s.id, role: s.role, name: s.title || s.role } };
		return c.json({ ...updateTask(order.id, { assignee: s.id, sentAt: Date.now(), crew }), model: policy.model, effort: policy.effort }, 202);
	});

	/** The agent is done. A FAIL in test or review strikes the pod that built it and sends the order back. */
	app.post("/api/tasks/serve", async (c) => {
		const no = guard(c);
		if (no) return no;
		const { id, pass } = await body<{ id?: string; pass?: boolean }>(c);
		const t = readTasks().find((x) => x.id === id);
		if (!t) return c.json({ error: "That order is gone." }, 404);
		if (pass === false && (t.stage === "test" || t.stage === "review")) {
			const builder = t.crew?.build?.id;
			const why = lastSaid(k.read().find((x) => x.id === t.assignee)) || `${t.stage} said FAIL`;
			const hit = builder ? strike(builder, `#${t.n} ${t.title}`, why) : undefined;
			if (hit?.fired && builder) k.close(builder);
			const back = sendBack(t);
			if (back.stuck && builder) strike(builder, `#${t.n} ${t.title}`, `Stuck after ${back.rounds} rounds.`);
			return c.json({ ...updateTask(t.id, { ...back, assignee: "", sentAt: 0 }), fired: !!hit?.fired });
		}
		const to = nextStage(t);
		if (to === "done") for (const who of new Set(Object.values(t.crew ?? {}).map((x) => x?.id))) if (who) served(who);
		return c.json(updateTask(t.id, { stage: to, assignee: "", sentAt: 0, stuck: false, ...(to === "done" ? { servedAt: Date.now() } : {}) }));
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
		const box = createContainer({ ...b, name, role: b.role || STAGE_ROLES[stages[0]][0], stages, cwd: b.cwd, skills, model: b.model ?? policyFor(stages[0]).model, effort: b.effort ?? policyFor(stages[0]).effort });
		stock([...skills, ...stages.flatMap((s) => STAGE_SKILLS[s])], k.fetch);
		return c.json(view(box), 201);
	});
	app.post("/api/containers/scale", async (c) => {
		const no = guard(c);
		if (no) return no;
		const { id, replicas } = await body<{ id?: string; replicas?: number }>(c);
		if (!Number.isFinite(replicas)) return c.json({ error: "Say how many agents." }, 400);
		const box = patchContainer(String(id), { replicas: Number(replicas) });
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
	return { tick, missed };
}
