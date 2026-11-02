// The kitchen's orders: tasks that move inbox → spec → build → test → review → done, each handed to one agent at a
// time. Kept in tasks.json next to the board's other prefs. The skills an order needs are installed ahead of time.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDir } from "./prefs";

export const STAGES = ["inbox", "spec", "build", "test", "review", "done"] as const;
export type Stage = (typeof STAGES)[number];
/** Which agent types can cook each stage. The first is the one the order asks for. */
export const STAGE_ROLES: Record<Stage, string[]> = {
	inbox: ["Planner"],
	spec: ["Planner"],
	build: ["Code", "Feature", "Refactor", "Bug", "Design"],
	test: ["Bug", "Code"],
	review: ["Planner", "Code"],
	done: [],
};
export const PRIORITIES = ["P0", "P1", "P2"] as const;

export type Task = {
	id: string;
	n: number;
	title: string;
	cwd: string;
	priority: (typeof PRIORITIES)[number];
	stage: Stage;
	/** Session cooking it now; empty while it waits on the belt. */
	assignee: string;
	sentAt: number;
	/** Discovery → Delivery needs your OK at the pass. */
	approved: boolean;
	skills: string[];
	/** Routing: the agent type that builds it, picked from its words when it is ordered. */
	route: string;
	/** Evaluator loop: how many times test or review sent it back to build. */
	rounds: number;
	/** Sent back too often: waits for you instead of looping. */
	stuck: boolean;
	/** Who cooked each stage, kept after the session closes so served orders can be scored. */
	crew?: Partial<Record<Stage, { id: string; role: string; name: string }>>;
	servedAt?: number;
	created: number;
	updated: number;
};

const file = () => join(dataDir(), "tasks.json");
export function readTasks(): Task[] {
	try {
		const a = JSON.parse(readFileSync(file(), "utf8"));
		return Array.isArray(a) ? a : [];
	} catch {
		return [];
	}
}
function write(all: Task[]) {
	mkdirSync(dataDir(), { recursive: true });
	writeFileSync(file(), JSON.stringify(all, null, 2));
	return all;
}

export function addTask(t: { title: string; cwd?: string; priority?: string; skills?: string[]; route?: string }): Task {
	const all = readTasks();
	const task: Task = {
		id: randomUUID(),
		n: all.reduce((m, x) => Math.max(m, x.n), 0) + 1,
		title: t.title,
		cwd: t.cwd ?? "",
		priority: (PRIORITIES as readonly string[]).includes(t.priority ?? "") ? (t.priority as Task["priority"]) : "P1",
		stage: "inbox",
		assignee: "",
		sentAt: 0,
		approved: false,
		skills: t.skills ?? [],
		route: t.route ?? "Code",
		rounds: 0,
		stuck: false,
		created: Date.now(),
		updated: Date.now(),
	};
	write([...all, task]);
	return task;
}

export function updateTask(id: string, patch: Partial<Pick<Task, "stage" | "assignee" | "sentAt" | "approved" | "priority" | "title" | "rounds" | "stuck" | "crew" | "servedAt">>): Task | undefined {
	const all = readTasks();
	const t = all.find((x) => x.id === id);
	if (!t) return undefined;
	Object.assign(t, patch, { updated: Date.now() });
	write(all);
	return t;
}

export function removeTask(id: string): boolean {
	const all = readTasks();
	const left = all.filter((x) => x.id !== id);
	write(left);
	return left.length !== all.length;
}

/** The next stage, or the same one when the pass is waiting for your OK. */
export function nextStage(t: Task): Stage {
	if (t.stage === "spec" && !t.approved) return "spec";
	return STAGES[Math.min(STAGES.indexOf(t.stage) + 1, STAGES.length - 1)];
}

export const MAX_ROUNDS = 3;
/**
 * Evaluator-optimizer: a failed test or review sends the order back to build. After MAX_ROUNDS it stops and
 * waits for you, so a bad spec cannot burn tokens forever.
 */
export function sendBack(t: Task): Pick<Task, "stage" | "rounds" | "stuck"> {
	const rounds = t.rounds + 1;
	return rounds >= MAX_ROUNDS ? { stage: t.stage, rounds, stuck: true } : { stage: "build", rounds, stuck: false };
}

/** Belt order: P0 first, then the oldest. */
export function beltOrder(tasks: Task[]): Task[] {
	return [...tasks].sort((a, b) => a.priority.localeCompare(b.priority) || a.created - b.created);
}

// ---------- skills pantry ----------
const skillsDir = () => process.env.RUN_MY_AGENTS_SKILLS_DIR || join(homedir(), ".claude", "skills");
export const skillInstalled = (name: string) => existsSync(join(skillsDir(), name, "SKILL.md"));

export type SkillRef = { name: string; source: string; path: string };
const installing = new Set<string>();
export const skillState = (name: string) => (skillInstalled(name) ? "ok" : installing.has(name) ? "get" : "miss");

/**
 * Installs a catalog skill's SKILL.md from its GitHub repo into ~/.claude/skills/<name>. Only names from the
 * board's own catalog reach here, and the name is checked again before it becomes a folder.
 */
export async function installSkill(s: SkillRef, get: typeof fetch = fetch): Promise<boolean> {
	if (!/^[\w.-]+$/.test(s.name) || !/^[\w.-]+\/[\w.-]+$/.test(s.source)) return false;
	if (skillInstalled(s.name) || installing.has(s.name)) return true;
	installing.add(s.name);
	try {
		const r = await get(`https://raw.githubusercontent.com/${s.source}/HEAD/${s.path}`);
		if (!r.ok) return false;
		const dir = join(skillsDir(), s.name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), await r.text());
		return true;
	} catch {
		return false;
	} finally {
		installing.delete(s.name);
	}
}

// ---------- the scoreboard: served orders scored like bowling ----------
/**
 * One served order is one frame. Served with no FAIL is a strike (X): 10 plus the next two frames' pins. One FAIL
 * is a spare (/): 10 plus the next frame's pins. Two FAILs leave 4 pins; served while stuck is a gutter (0).
 * The last 10 frames make a game; the 10th gets bonus balls, so 300 is perfect.
 */
export type Frame = { n: number; title: string; mark: string; pins: number; total: number };
export type Line = { key: string; label: string; sub: string; frames: Frame[]; score: number; served: number; strikes: number; spares: number };
const pinsOf = (t: Task) => (t.stuck || t.rounds >= MAX_ROUNDS ? 0 : t.rounds === 0 ? 10 : t.rounds === 1 ? 10 : 4);
const markOf = (t: Task) => (t.stuck || t.rounds >= MAX_ROUNDS ? "-" : t.rounds === 0 ? "X" : t.rounds === 1 ? "/" : "4");

export function bowl(orders: Task[]): Frame[] {
	const game = [...orders].sort((a, b) => (a.servedAt ?? a.updated) - (b.servedAt ?? b.updated)).slice(-10);
	let total = 0;
	return game.map((t, i) => {
		// The 10th frame rolls its own bonus balls, as in bowling: a strike there repeats its pins twice, a spare once.
		const tenth = game.length === 10 ? game[9] : undefined;
		const next = [...game.slice(i + 1).map(pinsOf), ...(tenth && markOf(tenth) !== "-" && markOf(tenth) !== "4" ? [pinsOf(tenth), pinsOf(tenth)] : [])];
		const mark = markOf(t);
		const bonus = mark === "X" ? (next[0] ?? 0) + (next[1] ?? 0) : mark === "/" ? (next[0] ?? 0) : 0;
		total += pinsOf(t) + bonus;
		return { n: t.n, title: t.title, mark, pins: pinsOf(t), total };
	});
}

function line(key: string, label: string, sub: string, orders: Task[]): Line {
	const frames = bowl(orders);
	return { key, label, sub, frames, score: frames.at(-1)?.total ?? 0, served: orders.length, strikes: orders.filter((t) => markOf(t) === "X").length, spares: orders.filter((t) => markOf(t) === "/").length };
}
const rank = (a: Line, b: Line) => b.score - a.score || b.strikes - a.strikes || b.served - a.served || a.label.localeCompare(b.label);

/** Rank tables for agents, pairs of agents who cooked the same order, and skills. Only served orders count. */
export function scoreboard(tasks: Task[]) {
	const served = tasks.filter((t) => t.stage === "done");
	const agents = new Map<string, { label: string; sub: string; orders: Task[] }>();
	const pairs = new Map<string, { label: string; orders: Task[] }>();
	const skills = new Map<string, Task[]>();
	for (const t of served) {
		const crew = [...new Map(Object.values(t.crew ?? {}).filter(Boolean).map((c) => [c!.id, c!])).values()];
		for (const c of crew) {
			const a = agents.get(c.id) ?? { label: c.name || c.role, sub: c.role, orders: [] };
			a.orders.push(t);
			agents.set(c.id, a);
		}
		for (let i = 0; i < crew.length; i++)
			for (let j = i + 1; j < crew.length; j++) {
				const [x, y] = [crew[i], crew[j]].sort((p, q) => p.id.localeCompare(q.id));
				const k = `${x.id}+${y.id}`;
				const p = pairs.get(k) ?? { label: `${x.name || x.role} + ${y.name || y.role}`, orders: [] };
				p.orders.push(t);
				pairs.set(k, p);
			}
		for (const k of t.skills) skills.set(k, [...(skills.get(k) ?? []), t]);
	}
	return {
		served: served.length,
		agents: [...agents].map(([k, a]) => line(k, a.label, a.sub, a.orders)).sort(rank),
		pairs: [...pairs].map(([k, p]) => line(k, p.label, `${p.orders.length} orders together`, p.orders)).sort(rank),
		skills: [...skills].map(([k, o]) => line(k, `/${k}`, `${o.length} orders`, o)).sort(rank),
	};
}
