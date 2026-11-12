// The kitchen's orders: tasks that move inbox → spec → build → test → review → done, each handed to one agent at a
// time. Kept in tasks.json next to the board's other prefs.
import { randomUUID } from "node:crypto";
import { JsonStore } from "./store";
import type { Kind, Lane, Zachman } from "./triage";

export const STAGES = ["inbox", "spec", "build", "test", "review", "done"] as const;
export type Stage = (typeof STAGES)[number];
/** Which agent types can cook each stage. The first is the one the order asks for. */
export const STAGE_ROLES: Record<Stage, string[]> = {
	inbox: ["Spec", "Planner"],
	spec: ["Spec", "Planner"],
	build: ["Build", "Code", "Feature", "Refactor", "Bug", "Design"],
	test: ["Test", "Bug", "Code"],
	review: ["Review", "Planner", "Code"],
	done: [],
};
export const PRIORITIES = ["P0", "P1", "P2"] as const;

export type Task = {
	id: string;
	n: number;
	title: string;
	/** Files attached to the order when it was added, saved under kitchen-home/uploads (see uploads.ts). */
	files?: string[];
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
	/** A finished spec waiting at the pass for your OK. */
	atPass?: boolean;
	/** Agents that missed this order; it goes to someone else next. */
	missedBy?: string[];
	/** Closed by autopilot after too many FAILs: counts as a gutter, never as shipped work. */
	failed?: boolean;
	/** First handed to an agent: cycle time runs from here. */
	startedAt?: number;
	/** Entered its current stage. */
	stageAt?: number;
	/** Intake triage: a question is answered in one step; a task goes through the kitchen. */
	kind?: Kind;
	/** Fast lane: build → test → served, no spec, pass or review. */
	lane?: Lane;
	zachman?: Zachman;
	/** What each stage's agent handed on: the spec, the build summary, the test and review verdicts. */
	notes?: Partial<Record<Stage, string>>;
	/** Stages whose note was too long to hand on whole and was shortened; the order card warns about each. */
	cut?: Stage[];
	/** This order's own git worktree (branch kitchen/order-<n>), made by the board for Build, Test, Review and Ship. */
	worktree?: string;
	/** The commit the worktree started from, to tell whether Build changed anything. */
	base?: string;
	/** HEAD when this build round started: a round that changes nothing must show as no change after Ship committed the last (#187). */
	roundBase?: string;
	/** `git status --porcelain` of the order's base repo when Build started, to catch edits that leak there (#163). */
	baseDirty?: string[];
	/** Why this worktree's dependencies could not be installed. */
	depsFailed?: string;
	/** Why its test or review said FAIL, one line per round, so a follow-up can learn from it. */
	failures?: string[];
	/** How many times the orchestrator answered a question from this step's agent (reset each step). */
	answered?: number;
	/** The one open ask from this order's current agent to an earlier stage, matched to its answer by id. */
	waitingOn?: { id: string; stage: Stage; question: string; at: number; session?: string };
	/** Questions this step's agent asked other agents (reset each step). */
	asked?: number;
	/** Who asked whom on this order, newest last. */
	talk?: { at: number; from: string; to: string; text: string }[];
	/** What this step's agent said before the orchestrator last wrote to it; its hand-off is this plus its reply. */
	draft?: string;
	/** How many of its failures it brought from an earlier run (a requeue, or the order it follows up): not this run's. */
	carried?: number;
	/** This order is the follow-up of failed order #retryOf. */
	retryOf?: number;
	/** The failed order was followed up as #followUp. */
	followUp?: number;
	/** Ship step running: an agent is committing, pushing and opening the pull request. */
	shipping?: boolean;
	/** The pull request the Ship step opened. */
	pr?: string;
	/** The reply that answered a question. */
	answer?: string;
	/** How many times you sent it back to the inbox after it was served or failed. */
	requeued?: number;
	/** Parked by hand: autopilot skips it and it takes no WIP slot. Its worktree is kept (#133). */
	parked?: boolean;
	/** Its pull request was merged: the slot it held is free. */
	mergedAt?: number;
	/** Its pull request was closed without merging: the slot it held is free. */
	closedAt?: number;
	/** The merge step's own counters, so a slot is never held forever and each round happens at most once. */
	merge?: { since?: number; conflicts?: number; relint?: number; rerun?: number; gates?: boolean; haiku?: number; sonnet?: number };
	created: number;
	updated: number;
};

const store = new JsonStore<Task>("tasks.json");
export const readTasks = () => store.read();
const write = (all: Task[]) => store.write(all);

export function addTask(t: { title: string; cwd?: string; priority?: string; skills?: string[]; route?: string; kind?: Kind; lane?: Lane; zachman?: Zachman }): Task {
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
		...(t.kind ? { kind: t.kind } : {}),
		...(t.lane ? { lane: t.lane } : {}),
		...(t.zachman ? { zachman: t.zachman } : {}),
		rounds: 0,
		stuck: false,
		created: Date.now(),
		updated: Date.now(),
	};
	write([...all, task]);
	return task;
}

export function updateTask(id: string, patch: Partial<Pick<Task, "stage" | "assignee" | "sentAt" | "approved" | "priority" | "title" | "rounds" | "stuck" | "crew" | "servedAt" | "atPass" | "missedBy" | "failed" | "startedAt" | "stageAt" | "answer" | "kind" | "zachman" | "skills" | "route" | "missedBy" | "requeued" | "lane" | "notes" | "cwd" | "shipping" | "pr" | "worktree" | "failures" | "depsFailed" | "carried" | "retryOf" | "followUp" | "answered" | "base" | "roundBase" | "waitingOn" | "asked" | "talk" | "draft" | "parked" | "mergedAt" | "closedAt" | "cut" | "merge" | "files" | "baseDirty">>): Task | undefined {
	const all = readTasks();
	const t = all.find((x) => x.id === id);
	if (!t) return undefined;
	const now = Date.now();
	if (patch.stage && patch.stage !== t.stage) patch = { ...patch, stageAt: now, answered: 0, asked: 0, draft: undefined };
	Object.assign(t, patch, { updated: now });
	write(all);
	return t;
}

export function removeTask(id: string): boolean {
	const all = readTasks();
	const left = all.filter((x) => x.id !== id);
	write(left);
	return left.length !== all.length;
}

/**
 * The next stage, or the same one when the pass is waiting for your OK. The fast lane skips only the spec: every
 * change is opened as a pull request and reviewed (order #28 went build → test → served with no review).
 */
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

/**
 * Does this order hold one of autopilot's WIP slots? A task that an agent has started and that is neither stuck,
 * failed nor parked does, until its stage is done; a done order holds its slot only while its pull request is still
 * open. An order served before the WIP limit first ran here never holds anything, so old pull requests block nothing.
 */
export function holdsSlot(t: Task, wipSince = 0): boolean {
	if (t.kind !== "task" || !t.startedAt) return false;
	if (t.stuck || t.failed || t.parked) return false;
	if (t.servedAt && t.servedAt < wipSince) return false;
	if (t.stage !== "done") return true;
	return !!t.pr && !t.mergedAt && !t.closedAt;
}

