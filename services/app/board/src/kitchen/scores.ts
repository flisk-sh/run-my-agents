// The scoreboard: served orders scored like bowling, ranked per agent, per pair of agents and per skill.
import { MAX_ROUNDS, type Task } from "./pipeline";

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
