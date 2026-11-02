// Agent containers work like a Kubernetes ReplicaSet. A container is a template (agent type, stages it cooks, model,
// skills, folder) plus a replica count; each replica is a pod, one real agent session. The reconcile loop keeps the
// count: it starts agents when there are too few and fires them when there are too many. A pod that fails or misses
// orders collects strikes; at the limit it is fired (evicted), its mistakes go into the container's lessons skill,
// and the loop starts a fresh agent that reads those lessons.
import { randomUUID } from "node:crypto";
import type { Stage } from "./pipeline";
import { lessonsSkill, writeLessons } from "./skills";
import { JsonStore } from "./store";

export type Pod = {
	session: string;
	status: "starting" | "ready" | "evicted";
	strikes: number;
	served: number;
	started: number;
	/** Why it was fired, shown on its tombstone. */
	reason?: string;
	evictedAt?: number;
};

export type Container = {
	id: string;
	name: string;
	slug: string;
	role: string;
	stages: Stage[];
	replicas: number;
	/** The size you chose: the autoscaler adds agents above it but never goes below it. */
	floor?: number;
	agent: "claude";
	model: string;
	effort: string;
	cwd: string;
	skills: string[];
	/** Strikes before a pod is fired. */
	maxStrikes: number;
	/** An order with no progress for this long is a miss. */
	missMinutes: number;
	pods: Pod[];
	lessons: { at: number; order: string; reason: string }[];
	/** Containers with the same key share one lessons skill: every Build container learns from every build. */
	lessonsKey?: string;
	/** You set its size with − / +: the idle timer keeps that many agents instead of letting them all go. */
	floorByHand?: boolean;
	/** When its stage last ran out of orders; cleared when an order arrives. */
	idleSince?: number;
	/** Why its last agents were let go, shown on the evicted pods. */
	downReason?: string;
	created: number;
};

const store = new JsonStore<Container>("containers.json");
export const readContainers = () => store.read();

const slugOf = (name: string) =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40) || "agents";

export function createContainer(c: Partial<Container> & { name: string; role: string; stages: Stage[]; cwd: string }): Container {
	const all = readContainers();
	let slug = slugOf(c.name);
	while (all.some((x) => x.slug === slug)) slug += "-2";
	const box: Container = {
		id: randomUUID(),
		name: c.name,
		slug,
		role: c.role,
		stages: c.stages,
		replicas: Math.max(0, Math.min(10, c.replicas ?? 1)),
		floor: Math.max(0, Math.min(10, c.floor ?? c.replicas ?? 1)),
		agent: "claude",
		model: c.model ?? "",
		effort: c.effort ?? "",
		cwd: c.cwd,
		skills: c.skills ?? [],
		maxStrikes: Math.max(1, Math.min(10, c.maxStrikes ?? 3)),
		missMinutes: Math.max(5, Math.min(24 * 60, c.missMinutes ?? 30)),
		pods: [],
		lessons: [],
		...(c.lessonsKey ? { lessonsKey: c.lessonsKey } : {}),
		created: Date.now(),
	};
	store.write([...all, box]);
	// The lessons skill exists from the start, so a new agent can read it before its first strike.
	writeShared([...all, box], lessonsKeyOf(box), box.lessonsKey ? `${box.role} agents` : box.name);
	return box;
}

export function patchContainer(id: string, patch: Partial<Pick<Container, "replicas" | "floor" | "floorByHand" | "idleSince" | "downReason" | "role" | "lessonsKey" | "model" | "effort" | "skills" | "maxStrikes" | "missMinutes" | "name">>) {
	return store.update((all) => {
		const c = all.find((x) => x.id === id);
		if (!c) return undefined;
		if (patch.replicas !== undefined) patch.replicas = Math.max(0, Math.min(10, Math.round(patch.replicas)));
		Object.assign(c, patch);
		return c;
	});
}

export function clearLessons(id: string) {
	return store.update((all) => {
		const c = all.find((x) => x.id === id);
		if (!c) return undefined;
		c.lessons = [];
		writeShared(all, lessonsKeyOf(c), c.lessonsKey ? `${c.role} agents` : c.name);
		return c;
	});
}

export const removeContainer = (id: string) => store.update((all) => {
	const i = all.findIndex((x) => x.id === id);
	if (i >= 0) all.splice(i, 1);
	return i >= 0;
});

/** Replies that refuse the order instead of naming a mistake: never kept as lessons. */
const REFUSAL = /\b(clarif|resubmit|too vague|vague|will not reopen|not reopen|concrete (?:test|target|spec)|awaiting approval|approve the|need(?:s)? more detail)/i;

/** The lessons skill a container reads and writes: shared by key, else its own. */
export const lessonsKeyOf = (c: Pick<Container, "slug" | "lessonsKey">) => c.lessonsKey ?? c.slug;
/** Rewrites one lessons skill from every container that shares its key. */
function writeShared(all: Container[], key: string, name: string) {
	// Old refusal lessons are dropped as they are rewritten, so they stop teaching agents to refuse.
	for (const x of all) x.lessons = x.lessons.filter((l) => !REFUSAL.test(l.reason));
	const lessons = all.filter((x) => lessonsKeyOf(x) === key).flatMap((x) => x.lessons).sort((a, b) => a.at - b.at);
	writeLessons(key, name, lessons);
}

const live = (c: Container) => c.pods.filter((p) => p.status !== "evicted");

/** The container a session runs in, if any. */
export const podOf = (session: string) => {
	for (const c of readContainers()) {
		const p = c.pods.find((x) => x.session === session && x.status !== "evicted");
		if (p) return { container: c, pod: p };
	}
	return undefined;
};

/**
 * Gives a pod a strike for a failed or missed order. At maxStrikes it is fired: the reason becomes a lesson in the
 * container's skill, and the next reconcile replaces it. Returns the pod's new state.
 */
export function strike(session: string, order: string, reason: string): { container: string; pod: Pod; fired: boolean } | undefined {
	return store.update((all) => {
		for (const c of all) {
			const p = c.pods.find((x) => x.session === session && x.status !== "evicted");
			if (!p) continue;
			p.strikes += 1;
			// A lesson is a mistake to avoid. Refusals ("too vague", "resubmit", "will not reopen") taught agents to
			// refuse more, so they count as a strike but are not kept as lessons.
			if (!REFUSAL.test(reason)) c.lessons.push({ at: Date.now(), order, reason });
			const fired = p.strikes >= c.maxStrikes;
			if (fired) Object.assign(p, { status: "evicted", reason: `${p.strikes} strikes. Last: ${reason}`.slice(0, 300), evictedAt: Date.now() });
			writeShared(all, lessonsKeyOf(c), c.lessonsKey ? `${c.role} agents` : c.name);
			return { container: c.id, pod: { ...p }, fired };
		}
		return undefined;
	});
}

export function served(session: string) {
	store.update((all) => {
		for (const c of all) for (const p of c.pods) if (p.session === session && p.status !== "evicted") p.served += 1;
	});
}

export type ReconcileCtx = {
	/** Sessions the board can see now: id, and whether it is closed. */
	sessions: { id: string; hidden?: boolean }[];
	/** Starts an agent; resolves when its first turn ends. */
	start: (n: { agent: "claude"; cwd: string; text: string; model?: string; effort?: string; id: string; role: string }) => void;
	/** Moves a fired agent to Closed on the board. */
	close: (id: string) => void;
	/** Names a pod on the board, so a container's agents are told apart from your own chats. */
	name?: (id: string, label: string) => void;
	/** Sets a pod's agent type on the board to its container's type. */
	type?: (id: string, role: string) => void;
	now?: number;
};

/** What a pod is called on the board and on the scoreboard: its container and a short id. */
export const podName = (c: Pick<Container, "name">, id: string) => `${c.name} ${id.slice(0, 4)}`;

/** The first prompt a new pod gets: who it is, and the lessons it must read. */
export function bootPrompt(c: Container) {
	return `You are a ${c.role} agent in the "${c.name}" agent container on the Run My Agents board. Orders for ${c.stages.join(", ")} will arrive as messages. Before each order, read the /${lessonsSkill(lessonsKeyOf(c))} skill: it lists mistakes that got earlier agents in this container replaced. Reply "ready" and wait for your first order.`;
}

/**
 * One pass of the control loop, for every container: forget pods whose session is gone, mark started pods ready,
 * fire extras when scaled down, and start new pods until the replica count is met. Returns what it did.
 */
export function reconcile(ctx: ReconcileCtx) {
	const did: string[] = [];
	const now = ctx.now ?? Date.now();
	const seen = new Map(ctx.sessions.map((s) => [s.id, s]));
	store.update((all) => {
		for (const c of all) {
			for (const p of live(c)) {
				const s = seen.get(p.session);
				if (s && !s.hidden && p.status === "starting") {
					p.status = "ready";
					ctx.name?.(p.session, podName(c, p.session));
					ctx.type?.(p.session, c.role);
					did.push(`${c.name}: ${p.session.slice(0, 8)} ready`);
				}
				// Gone or closed by hand: a starting pod gets 10 minutes to show up.
				if ((s?.hidden || (!s && now - p.started > 10 * 60_000)) && p.status !== "evicted") {
					Object.assign(p, { status: "evicted", reason: s ? "Closed on the board" : "Never started", evictedAt: now });
					did.push(`${c.name}: ${p.session.slice(0, 8)} gone`);
				}
			}
			const pods = live(c);
			// Too many: fire the newest, the way a ReplicaSet scales down.
			for (const p of pods.sort((a, b) => b.started - a.started).slice(0, Math.max(0, pods.length - c.replicas))) {
				Object.assign(p, { status: "evicted", reason: c.downReason ?? "Scaled down", evictedAt: now });
				ctx.close(p.session);
				did.push(`${c.name}: scaled down ${p.session.slice(0, 8)}`);
			}
			// Too few: start fresh agents with the container's template.
			for (let i = live(c).length; i < c.replicas; i++) {
				const id = randomUUID();
				c.pods.push({ session: id, status: "starting", strikes: 0, served: 0, started: now });
				ctx.name?.(id, podName(c, id));
				ctx.start({ agent: "claude", cwd: c.cwd, text: bootPrompt(c), model: c.model || "haiku", effort: c.effort || "low", id, role: c.role });
				did.push(`${c.name}: started ${id.slice(0, 8)}`);
			}
			// Keep the last 20 tombstones.
			const dead = c.pods.filter((p) => p.status === "evicted");
			if (dead.length > 20) c.pods = c.pods.filter((p) => p.status !== "evicted" || dead.slice(-20).includes(p));
		}
	});
	return did;
}
