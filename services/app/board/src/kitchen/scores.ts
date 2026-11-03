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

/**
 * Who a crew entry is for scoring: its crew row ("Build · flisk"), not the chat. Every order gets a fresh chat, so
 * scoring chats listed dozens of retired ones. Old entries named by their first prompt map to their container too.
 */
export function crewKey(c: { id: string; role: string; name: string }): { key: string; label: string; role: string } {
	const quoted = /in the "([^"]+)" agent container/.exec(c.name)?.[1];
	const pod = /^(.+ · .+|Kitchen cooks|Auto cooks.*)\s[0-9a-f]{4}$/.exec(c.name)?.[1];
	const base = quoted ?? pod;
	// One of your own chats: rated as itself.
	if (!base) return { key: c.id, label: c.name || c.role, role: c.role };
	const type = /^(Spec|Build|Test|Review)\b/.exec(base)?.[1];
	return { key: base, label: base, role: type ?? c.role };
}

/** Rank tables for crew rows, pairs of rows that cooked the same order, and skills. Only served tasks count. */
export function scoreboard(tasks: Task[]) {
	// Questions and orders from before intake triage (no kind) never went through the kitchen.
	const served = tasks.filter((t) => t.stage === "done" && t.kind === "task");
	const agents = new Map<string, { label: string; sub: string; orders: Task[] }>();
	const pairs = new Map<string, { label: string; orders: Task[] }>();
	const skills = new Map<string, Task[]>();
	for (const t of served) {
		const crew = [...new Map(Object.values(t.crew ?? {}).filter(Boolean).map((c) => crewKey(c!)).map((c) => [c.key, c])).values()];
		for (const c of crew) {
			const a = agents.get(c.key) ?? { label: c.label, sub: c.role, orders: [] };
			a.orders.push(t);
			agents.set(c.key, a);
		}
		for (let i = 0; i < crew.length; i++)
			for (let j = i + 1; j < crew.length; j++) {
				const [x, y] = [crew[i], crew[j]].sort((p, q) => p.key.localeCompare(q.key));
				const k = `${x.key}+${y.key}`;
				const p = pairs.get(k) ?? { label: `${x.label} + ${y.label}`, orders: [] };
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

// ---------- live ratings: every agent that touched an order, served or not ----------
export type Rating = { id: string; label: string; role: string; steps: number; served: number; fails: number; stuck: number; strikes: number; working: number; rating: number };

/**
 * A 0-100 rating per crew row (Build · flisk, or one of your chats) from all tasks so far, so agents are rated before anything is served. It starts at 50:
 * +10 per order served, +3 per step done, -8 per FAIL on an order it built, -15 per stuck order it built, -10 per
 * container strike. The table shows every number it is made of.
 */
export function ratings(tasks: Task[], strikes: Record<string, number> = {}): Rating[] {
	const by = new Map<string, Rating>();
	const get = (c: { id: string; role: string; name: string }) => {
		const ck = crewKey(c);
		let r = by.get(ck.key);
		if (!r) by.set(ck.key, (r = { id: ck.key === ck.label ? c.id : ck.key, label: ck.label, role: ck.role, steps: 0, served: 0, fails: 0, stuck: 0, strikes: strikes[ck.key] ?? strikes[c.id] ?? 0, working: 0, rating: 0 }));
		return r;
	};
	for (const t of tasks.filter((x) => x.kind === "task")) {
		for (const [stage, c] of Object.entries(t.crew ?? {})) {
			if (!c) continue;
			const r = get(c);
			// The step the order is on now: crew[stage] is written when it is sent. Its id is the pod's stable id while
			// assignee is the step's fresh chat, so comparing the two never matched and "Working" was always 0 (#239).
			const current = stage === t.stage && !!t.assignee && t.stage !== "done";
			if (current) r.working += 1;
			else r.steps += 1;
		}
		const crew = new Set(Object.values(t.crew ?? {}).filter(Boolean).map((c) => get(c!)));
		if (t.stage === "done" && !t.failed) for (const r of crew) r.served += 1;
		const builder = t.crew?.build;
		if (builder) {
			get(builder).fails += t.rounds;
			if (t.stuck) get(builder).stuck += 1;
		}
	}
	for (const r of by.values()) r.rating = Math.max(0, Math.min(100, 50 + 10 * r.served + 3 * r.steps - 8 * r.fails - 15 * r.stuck - 10 * r.strikes));
	return [...by.values()].sort((a, b) => b.rating - a.rating || b.steps - a.steps || a.label.localeCompare(b.label));
}

// ---------- flow: lead time and cycle time ----------
/**
 * Lead time runs from ordering to served, cycle time from the first agent picking it up to served. Medians and the
 * 85th percentile are over served orders (failed ones are counted apart); WIP is everything still open.
 */
export function flow(tasks: Task[], now = Date.now()) {
	const done = tasks.filter((t) => t.stage === "done" && !t.failed && t.servedAt);
	const pct = (xs: number[], p: number) => {
		if (!xs.length) return 0;
		const s = [...xs].sort((a, b) => a - b);
		return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
	};
	const lead = done.map((t) => (t.servedAt as number) - t.created);
	const cycle = done.filter((t) => t.startedAt).map((t) => (t.servedAt as number) - (t.startedAt as number));
	return {
		served: done.length,
		failed: tasks.filter((t) => t.failed).length,
		wip: tasks.filter((t) => t.stage !== "done").length,
		leadMedian: pct(lead, 50),
		leadP85: pct(lead, 85),
		/** Served orders that have a pick-up time (older orders were served before it was recorded). */
		cycleCount: cycle.length,
		cycleMedian: pct(cycle, 50),
		cycleP85: pct(cycle, 85),
		/** Orders served in the last 24 hours. */
		throughput24h: done.filter((t) => now - (t.servedAt as number) < 86_400_000).length,
		...failRate(tasks),
	};
}

/** Failures that were the board's, not the agent's: an agent that could not log in never got to work. */
export const BOARD_FAULT = /Not logged in|authentication_failed/;

/** The fail-rate goals, in order: once the rate is at or under one, the next is the goal. */
export const FAIL_GOALS = [70, 50, 30, 15, 5];

/**
 * KPI: the share of the last `last` finished task orders (questions left out) that had a FAIL in any step of their own
 * run or closed as failed, and the next goal on the ladder it has not reached yet.
 */
export function failRate(tasks: Task[], last = 20) {
	const ended = tasks
		.filter((t) => t.kind === "task" && t.stage === "done")
		.sort((a, b) => (a.servedAt ?? a.updated) - (b.servedAt ?? b.updated));
	// A requeued order or a follow-up carries the failures of the run before it; only this run's count. A follow-up
	// made before `carried` was recorded brought all of its parent's.
	const byN = new Map(tasks.map((t) => [t.n, t]));
	const carried = (t: Task) => t.carried ?? (t.retryOf ? (byN.get(t.retryOf)?.failures ?? []).length : 0);
	// Only the agents' own failures: a board fault in this run (an agent that could not log in) is not one.
	const own = (t: Task) => (t.failures ?? []).slice(carried(t)).filter((f) => !BOARD_FAULT.test(f));
	// An order closed as failed with nothing but board faults says nothing about the agents: left out, counted apart.
	const boardOnly = (t: Task) => !!t.failed && own(t).length === 0 && (t.failures ?? []).slice(carried(t)).length > 0;
	const counted = ended.filter((t) => !boardOnly(t)).slice(-last);
	const board = ended.slice(-last).filter(boardOnly).length;
	const bad = counted.filter((t) => own(t).length > 0 || t.failed).length;
	const rate = counted.length ? Math.round((bad / counted.length) * 100) : 0;
	return { failRate: rate, failOrders: counted.length, failBoard: board, failGoal: counted.length ? (FAIL_GOALS.find((g) => rate > g) ?? null) : FAIL_GOALS[0] };
}
