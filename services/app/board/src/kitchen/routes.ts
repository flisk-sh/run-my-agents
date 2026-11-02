import { randomUUID } from "node:crypto";
// The kitchen's HTTP API, mounted on the board's app: orders, the scoreboard, skill sets and agent containers.
// Everything the board owns (reading sessions, sending a message, starting an agent) comes in through KitchenCtx,
// so this module never reaches into the board's internals and can be tested on its own.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join as joinPath, resolve as resolvePath } from "node:path";
import type { Context, Hono } from "hono";
import type { Session } from "../sessions";
import { KITCHEN_AGENTS, STAGE_TYPE, WORK_STAGES } from "./agents";
import { clearLessons, injectSkills, KITCHEN_CHAT, KITCHEN_MODE, freshChat, lessonsFor, lessonsKeyOf, podName, podOrder, createContainer, type Container, patchContainer, podOf, readContainers, reconcile, removeContainer, served, strike as strikePod } from "./containers";
import { addTask, beltOrder, nextStage, PRIORITIES, readTasks, removeTask, sendBack, STAGE_ROLES, STAGES, type Stage, type Task, updateTask } from "./pipeline";
import { crewKey, flow, ratings, scoreboard } from "./scores";
import { askInput, canAsk, handOffOf, recordIn, verdictIn, type AskStage } from "./protocol";
import { JsonStore } from "./store";
import { kindOf, laneOf, needsWeb, quickMath, zachman, zachmanLines } from "./triage";
import { haikuFit, lessonsSkill, matchSkills, POLICY, readSkill, policyFor, SKILLS, skillset, skillsFor, skillState, STAGE_SKILLS, stock } from "./skills";

export type KitchenCtx = {
	read: () => Session[];
	/** Sends one message to a session; a Response with status >= 400 means it was refused. */
	send: (s: Session, text: string, body: string) => Response;
	busy: (s: Session) => boolean;
	start: (n: { agent: "claude"; cwd: string; text: string; model?: string; effort?: string; id: string; role: string; mode?: string }) => void;
	tune: (id: string, t: { model?: string; effort?: string; mode?: string }) => void;
	close: (id: string) => void;
	/** A Flisk kitchen agent: runs one turn of a session and returns the reply (tests inject one). */
	agent?: AgentCall;
	/** Ship served tasks as pull requests (default on). */
	ship?: boolean;
	/** The front desk: one short model call that answers a question, with no tools and no session. */
	ask?: (question: string, cwd: string, opts?: { web?: boolean; skills?: string }) => Promise<string>;
	/** Names a session on the board (container agents get their container's name). */
	name?: (id: string, label: string) => void;
	/** Sets a session's agent type on the board (container agents get their stage's type). */
	type?: (id: string, role: string) => void;
	guessRole: (title: string) => string;
	sameOrigin: (c: Context) => boolean;
	fetch?: typeof fetch;
	promptLimit: number;
	/** How often the container control loop runs; 0 turns it off (tests call /api/containers/reconcile). */
	every?: number;
};

const body = async <T>(c: Context) => (await c.req.json().catch(() => ({}))) as T;
/** Everything the agent said since the board last wrote to it; handOffOf turns it into the stage record. */
const handOff = (s: Session | undefined) => {
	// Everything the agent said since the order was sent, not just its closing line: a spec often ends with
	// "Spec complete" after the spec itself.
	const feed = (s?.feed ?? []) as { who: string; text?: string }[];
	let i = feed.length;
	while (i > 0 && feed[i - 1].who !== "you") i--;
	return feed
		.slice(i)
		.filter((x) => x.who === "agent")
		.map((x) => String(x.text ?? "").trim())
		.filter(Boolean)
		.join("\n\n");
};

/** The line that says FAIL and why, without markdown, for a lesson. */
export function failLine(text: string): string {
	const lines = text.split("\n").map((l) => l.replace(/[*_`>#]/g, "").trim()).filter(Boolean);
	const i = lines.map((l) => /\bFAIL\b/.test(l)).lastIndexOf(true);
	if (i < 0) return "";
	const line = lines[i].length < 40 && lines[i + 1] ? `${lines[i]} ${lines[i + 1]}` : lines[i];
	return line.slice(0, 300);
}

/** How many times the orchestrator answers one step's agent before the step moves on without it. */
export const MAX_ANSWERS = 2;
/** Every kitchen message ends with who reads the reply, so agents stop writing to (and waiting on) a user. */
export const ADDRESS =
	"Your reply goes to the kitchen's orchestrator, a program, not a person: nobody will approve or answer in this chat. It reads only the fenced `kitchen` JSON block at the end of your reply. To ask the agent of an earlier stage of this order (one that already ran) one question, end with ```kitchen\n{\"ask\": {\"to\": \"spec\", \"question\": \"...\"}}\n``` and stop; the answer comes back as your next message. Test and Review end with ```kitchen\n{\"verdict\": \"PASS\" or \"FAIL\", \"evidence\": \"what you ran and what you got\"}\n```. Anything the next stage must read goes in your reply (or in \"handoff\"), not in a file outside the worktree.";

export { verdictIn };
/** Questions one step's agent may send to other agents before it has to decide itself. */
export const MAX_ASKS = 2;
/** How long an ask may stay open; past it the asking step fails, the orchestrator never answers in its place. */
export const ASK_TIMEOUT_MS = 10 * 60_000;

/** What the orchestrator says to a kitchen agent that asks while it holds no order. */
export const STRAY_ANSWER =
	"This is the kitchen's orchestrator, a program: no order is waiting on you right now, so there is nothing to ship or change. Do not run any command or edit any file. Stop here; the board will send you an order when there is one.";

/** What the orchestrator says to a builder that finished without changing anything. */
export const NO_CHANGES =
	"Your build step left no changes in this order's worktree, so there is nothing for Test to check. Make the change now, in this worktree. Never invent a change just to have one (a version bump, a changelog line, a notes or verification file): an invented change gets shipped. If the order needs no file change (a release that CI runs, an investigation, a question) or it truly cannot be done here, reply with one line starting with FAIL that says exactly why.";

/**
 * What the orchestrator says to a test or review agent that went quiet with no verdict. Order #29's Test agent ran the
 * tests in the background and ended its turn ("No response requested."), which counted as FAIL with no reason.
 */
export const NO_VERDICT =
	"You stopped without a verdict, so the kitchen cannot move this order on. Finish your checks now: run each command in the foreground and wait for its result. Then end with one line: PASS, or FAIL: what you ran, what you expected and what you got.";

/**
 * What the orchestrator says to an agent that stopped to ask for approval. It is policy, not consent: the orchestrator
 * never says "yes" for the user, so asking is never how an agent gets a decision made.
 */
export const DECIDE =
	"This is the kitchen's orchestrator, a program: nobody will approve or answer this. Do not ask again. If a reasonable choice exists, make it, say in your result what you assumed, and finish this step. If the step cannot be done without a decision from a person, end with one line: FAIL: the decision that is missing.";

/** The answer to an ask, delivered to the asker as its next message. */
export const answerText = (n: number, to: AskStage, question: string, answer: string) =>
	`Answer from the ${STAGE_TYPE[to]} agent on order #${n} (to your question: ${question}), from its record:\n${answer}\n\nContinue your step.`;

/** What the asker hears when the stage it asked has not run yet or left no record: the policy, not a guess. */
export const cannotAsk = (n: number, to: AskStage) =>
	`The ${STAGE_TYPE[to]} stage of order #${n} has not run or left no record, so it cannot answer: its answer would be a guess. ${DECIDE}`;

/**
 * Did the agent end its turn by asking instead of finishing? A question at the end ("Would you like me to proceed?",
 * "Should I…", "Let me know"), with no verdict, no pull request link and no "finished" line.
 */
export function asksBack(text: string, t: Pick<Task, "stage" | "shipping">): boolean {
	const tail = text.trim().slice(-400);
	if (!tail || recordIn(text)) return false;
	if ((t.stage === "test" || t.stage === "review") && !t.shipping && verdictIn(tail) !== undefined) return false;
	if (t.shipping && /https:\/\/github\.com\/\S+\/pull\/\d+/.test(tail)) return false;
	const last = tail.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
	return /\?\s*\**\s*$/.test(last) || /\b(would you like|should i|shall i|do you want|want me to|let me know|awaiting (?:your )?(?:approval|confirmation)|please confirm|confirm (?:that|before)|approve the)\b/i.test(last);
}

const isDir = (p: string) => {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
};

/** A builder saying the code is in another folder: "requires access to `/a/b`", "belongs in `/a/b`". */
export function elsewhere(text: string): string | undefined {
	return /\b(?:requires access to|belongs in|lives in|code is in|is in|move (?:it|this order) to)\b[^`\n]{0,30}`(\/[^`\s]+?)\/?`/i.exec(text)?.[1];
}

/**
 * The folder a spec names, in whatever form the agent wrote it: "Folder: /a/b", "**Folder** `/a/b`", or
 * "build target … `run-my-agents`" naming a known folder.
 */
export function folderHint(text: string, folders: string[] = []): string | undefined {
	const abs = /\bFolder\b[*_\s:]*`?(\/[^\s`*]+)/i.exec(text)?.[1];
	if (abs) return abs.replace(/[.,;)]+$/, "");
	const named = /\b(?:build target|target|folder|repo)\b[^\n`]{0,40}`([\w.-]+)`/i.exec(text)?.[1];
	if (!named) return undefined;
	if (/^run[- ]my[- ]agents$/i.test(named)) return BOARD_ROOT;
	return folders.find((f) => f.split("/").filter(Boolean).pop() === named);
}

const git = (dir: string, args: string[], timeout = 20_000) =>
	execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout }).trim();

/**
 * The order's own git worktree, made by the board (agents skipped the step when asked to): <repo>/.kitchen/
 * order-<n> on branch kitchen/order-<n>, from origin/main (or HEAD when the repo has no remote). Every agent on the
 * order starts its chat there, so no edit lands in the shared checkout, Review sees only this order's diff, and Ship
 * has a clean branch to push. Not a git repo, or git fails: undefined, and the order works in its folder as before.
 */
export function orderWorktree(cwd: string, n: number): string | undefined {
	// Only a real folder: never let git fall back to the board's own working directory.
	if (!cwd || !cwd.startsWith("/") || !isDir(cwd)) return undefined;
	try {
		const top = git(cwd, ["rev-parse", "--show-toplevel"]);
		const common = resolvePath(top, git(top, ["rev-parse", "--git-common-dir"]));
		// Under the repo's own folder, never under .git: Claude Code protects everything in .git, so agents could not
		// edit a single file there ("File …/.git/kitchen/order-12/…/view.ts is protected"). Hidden from git status by
		// .git/info/exclude.
		const path = joinPath(top, ".kitchen", `order-${n}`);
		try {
			const exclude = joinPath(common, "info", "exclude");
			const lines = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
			if (!lines.split("\n").includes(".kitchen/")) {
				mkdirSync(joinPath(common, "info"), { recursive: true });
				appendFileSync(exclude, `${lines && !lines.endsWith("\n") ? "\n" : ""}.kitchen/\n`);
			}
		} catch {}
		if (isDir(path)) return path;
		// A worktree made where agents could not edit it (.git/kitchen, before this fix) moves here, keeping its branch.
		const old = joinPath(common, "kitchen", `order-${n}`);
		if (isDir(old)) {
			mkdirSync(joinPath(top, ".kitchen"), { recursive: true });
			git(top, ["worktree", "move", old, path]);
			return path;
		}
		const branch = `kitchen/order-${n}`;
		try {
			git(top, ["fetch", "-q", "origin"]);
		} catch {}
		const has = (ref: string) => {
			try {
				git(top, ["rev-parse", "--verify", "--quiet", ref]);
				return true;
			} catch {
				return false;
			}
		};
		git(top, ["worktree", "add", path, ...(has(`refs/heads/${branch}`) ? [branch] : ["-b", branch, has("origin/main") ? "origin/main" : "HEAD"])]);
		return path;
	} catch {
		return undefined;
	}
}

export const headOf = (wt: string) => {
	try {
		return git(wt, ["rev-parse", "HEAD"]);
	} catch {
		return undefined;
	}
};
/** Did Build change anything in the order's worktree: uncommitted edits, or commits since it started? */
export function worktreeChanged(wt: string, base?: string): boolean {
	try {
		if (git(wt, ["status", "--porcelain"])) return true;
		return Boolean(base) && git(wt, ["rev-parse", "HEAD"]) !== base;
	} catch {
		return true;
	}
}

/**
 * The changed paths of the order's base repo (`git status --porcelain`, one line each). Orders #24, #29 and #30 ran
 * in their own worktrees, yet their Build agents edited the shared checkout by its absolute path (#163).
 */
export function repoDirty(cwd: string | undefined): string[] | undefined {
	if (!cwd || !cwd.startsWith("/") || !isDir(cwd)) return undefined;
	try {
		return git(cwd, ["status", "--porcelain", "--untracked-files=all"]).split("\n").map((l) => l.trim()).filter(Boolean);
	} catch {
		return undefined;
	}
}
/** What changed in the base repo since the snapshot taken when Build started: edits that belong in the worktree. */
export function leakedInto(cwd: string | undefined, before: string[] | undefined): string[] {
	if (!before) return [];
	const was = new Set(before);
	return (repoDirty(cwd) ?? []).filter((l) => !was.has(l));
}

/** What the orchestrator says to a builder whose edits landed in the shared checkout instead of its worktree. */
export const LEAKED = (repo: string, wt: string, files: string[]) =>
	`Your build step changed files in the shared checkout ${repo}, not in this order's worktree ${wt}:\n${files.map((f) => `- ${f}`).join("\n")}\n\nMove each of those edits into the worktree (same path relative to the repo root), then restore exactly those files in ${repo} (git checkout -- <file> for tracked files, delete untracked ones you created). Touch nothing else there. Work only inside ${wt}. If you cannot, reply with one line starting with FAIL that says why.`;

/** The folder an order worktree (<repo>/.kitchen/order-<n>, or .git/kitchen before it moved) stands for: its repo. */
const homeOf = (p: string) => p.replace(/\/(?:\.kitchen|\.git\/kitchen)\/order-\d+(?:\/.*)?$/, "");
/**
 * An agent works in a repo when its chat is in the repo folder or in one of the repo's order worktrees: agents start
 * each order's chat inside its worktree, so after their first order their folder is a worktree, and a plain equality
 * check called every one of them busy elsewhere. An order filed from a subfolder of the repo
 * (<repo>/services/app/board/src/kitchen) is the same repo too: order #12 waited with three ready Build agents.
 */
export const sameRepo = (agentCwd: string | undefined, repo: string) => {
	if (!agentCwd) return false;
	const [a, r] = [homeOf(agentCwd), homeOf(repo)];
	return a === r || r.startsWith(`${a}/`);
};

/** Where the Run My Agents board's own code lives, for orders about the board itself. */
export const BOARD_ROOT = resolvePath(import.meta.dir, "../../../../..");
/** Orders about the board (its kitchen, agents, orders, tabs) belong in the board's repo, whatever chat was selected. */
const BOARD_WORDS = /\b(board|kitchen|autopilot|front desk|run[- ]my[- ]agents|crew tab|lanes|scores tab|queue tab|orders?|tickets?|idle agents?|agents? (?:without work|not picking|idle))\b/i;
export function whereOf(title: string, cwd: string, folders: string[]): string {
	const named = folders.find((f) => {
		const base = f.split("/").filter(Boolean).pop() ?? "";
		return base.length > 3 && new RegExp(`\\b${base.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}\\b`, "i").test(title);
	});
	if (named) return named;
	if (BOARD_WORDS.test(title) && existsSync(resolvePath(BOARD_ROOT, "services/app/board"))) return BOARD_ROOT;
	return cwd;
}

/**
 * What each stage is for. The rules for Test and Review are the ones practice orders showed were missing: judge the
 * change against the spec, and never FAIL an order for being vague, since nobody is there to answer questions.
 */
export const STAGE_BRIEF = {
	spec: "Write a short spec the next agents will follow: Goal; Why (infer it if the order does not say); 3 to 5 acceptance checks someone can run or read; the files likely to change, named relative to the repo root (src/x.ts), never by an absolute path. Make sensible assumptions instead of asking questions: nobody will answer them. If the code for this order lives in another folder, add a line 'Folder: <absolute path>'. Do not change code. Put the whole spec in your reply and do not write it to a file: the next agents only get your reply (a SPEC_ORDER_25.md in the shared checkout reached nobody).",
	build: "Make the change the spec describes, in this order's worktree. Never ask questions or wait for approval: nobody will answer, and the order stalls. Where something is unclear, take the most likely meaning, do it, and say what you assumed. Leave your changes in the working tree; do not commit or push. Edit files only by paths inside this worktree; never use the absolute path of the repo it came from. End with the files you changed and how to check the change. If the order needs no file change, never invent one (a version bump, a changelog line, a notes file): reply with one line starting with FAIL that says why.",
	test: "The change is in this order's worktree (branch kitchen/order-{n}); check it there. Check the change against the spec's acceptance checks: run the tests that exist, add a small one if there is none, or run or read the code. PASS when the checks hold. FAIL only for a concrete defect: say what you ran, what you expected and what you got. Never FAIL because the order is vague or has no test file, and never ask for clarification or approval.",
	review: "The change is in this order's worktree (branch kitchen/order-{n}). Read only its diff (git diff against the branch it started from) against the order and the spec. PASS unless you find a concrete bug, a security problem, or the change does not do what the order asks. A missing Why, loose wording or a missing extra test is not a reason to FAIL. Never ask for clarification.",
} as const;
/** The review step once the change is a pull request: the Review agent reviews the pull request itself. */
const REVIEW_PR =
	"Review pull request {pr} (branch kitchen/order-{n}, also checked out in this order's worktree). Read its diff with `gh pr diff {pr}` against the order and the spec. Post your review on the pull request: `gh pr review {pr} --comment --body \"<your findings, or: Looks good>\"`. PASS unless you find a concrete bug, a security problem, or the change does not do what the order asks; then FAIL with what is wrong, and Build fixes it on the same pull request. A missing Why, loose wording or a missing extra test is not a reason to FAIL. Never ask for clarification.";

const lastSaid = (s: Session | undefined) => {
	const m = s?.feed?.filter((x) => x.who === "agent").at(-1) as { text?: string } | undefined;
	return String(m?.text ?? "").slice(-400);
};

/**
 * The ingredients of a task: only catalog skills that fit its own words (three at most). Each stage adds its own
 * skill set when it dispatches, so a task needs no generic padding; that padding (flisk-byo, flisk-build-runtimes on
 * every order) was the noise at the top of the skills scoreboard.
 */
const orderSkills = (title: string, _route: string) => matchSkills(title, 3).map((s) => s.name);

type Settings = { auto: boolean; idleMinutes: number; agentUrl?: string };
/** One turn on a Flisk kitchen agent session ("order-26-build"): the agent's reply. */
export type AgentCall = (session: string, turn: { input: string; cwd?: string; model?: string; effort?: string }) => Promise<string>;
/** POST /turn on the Flisk kitchen agent at `url` (services/app/kitchen, a local process using your own claude). */
export const httpAgent =
	(url: string): AgentCall =>
	async (session, turn) => {
		const r = await fetch(`${url.replace(/\/$/, "")}/turn`, { method: "POST", headers: { "content-type": "application/json", "x-session-id": session }, body: JSON.stringify(turn) });
		const j = (await r.json().catch(() => ({}))) as { reply?: string; error?: string };
		if (!r.ok || typeof j.reply !== "string") throw new Error(j.error || `kitchen agent answered ${r.status}`);
		return j.reply;
	};
const SETTINGS = new JsonStore<Partial<Settings>>("kitchen.json");
/** Autopilot on, and idle agents let go after 10 minutes, unless kitchen.json says otherwise. */
const settings = (): Settings => ({ auto: true, idleMinutes: 10, ...(SETTINGS.read()[0] ?? {}) });
/** How many learned skills the sidecar keeps per container. */
const SIDECAR_KEEP = 6;

/** How the orders that carried each of a container's skills ended: served +1, failed or stuck -1. */
export function skillStats(box: Pick<Container, "name" | "skills">, tasks: Task[]) {
	const stats: Record<string, { score: number; uses: number }> = {};
	for (const t of tasks) {
		if (t.kind !== "task" || !Object.values(t.crew ?? {}).some((c) => c && crewKey(c).label === box.name)) continue;
		const outcome = t.failed || t.stuck ? -1 : t.stage === "done" ? 1 : 0;
		for (const n of t.skills) {
			if (!box.skills.includes(n)) continue;
			const x = (stats[n] ??= { score: 0, uses: 0 });
			x.uses += 1;
			x.score += outcome;
		}
	}
	return stats;
}

/** The most agents the autoscaler runs per folder. */
export const MAX_AGENTS = 3;
/** The stage that has to staff an order next: an inbox task goes to spec, or straight to build on the fast lane. */
const staffStage = (t: Task) => (t.stage === "inbox" ? (t.lane === "fast" ? "build" : "spec") : t.stage);
/** The assignee of a question the front desk is answering. */
export const FRONT_DESK = "front-desk";
const saveSettings = (v: Partial<Settings>) => SETTINGS.write([{ ...settings(), ...v }]);

export function mountKitchen(app: Hono, k: KitchenCtx) {
	/** The Flisk kitchen agent, when one is set (KitchenCtx.agent, or agentUrl in kitchen.json). */
	const agent = (): AgentCall | undefined => k.agent ?? (settings().agentUrl ? httpAgent(settings().agentUrl as string) : undefined);
	/** Replies from Flisk agent turns, by assignee ("flisk:order-26-build"): what a chat's last message is for a session. */
	const fliskReplies = new Map<string, string>();
	/** Flisk turns this board is running; one missing after a restart means the order is sent again. */
	const inFlight = new Set<string>();
	const replyOf = (id: string | undefined) => (id && fliskReplies.has(id) ? (fliskReplies.get(id) as string) : handOff(k.read().find((x) => x.id === id)));
	const guard = (c: Context) => (k.sameOrigin(c) ? undefined : c.json({ error: "Send JSON from the board." }, 403));
	/** A strike on a pod; when it fires the pod, the skills its container gained are installed for the next agent. */
	const strike = (session: string, order: string, reason: string) => {
		const r = strikePod(session, order, reason);
		if (r?.gained.length) stock(r.gained, k.fetch);
		return r;
	};
	const tick = () => {
		missed();
		auto();
		return reconcile({ sessions: k.read().map((s) => ({ id: s.id, hidden: s.hidden })), start: k.start, close: k.close, name: k.name, type: k.type });
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
		const busy = new Set(readTasks().flatMap((x) => [x.id !== order.id ? x.assignee : "", x.waitingOn?.session ?? ""]).filter(Boolean));
		const all = k.read();
		const free = (x: Session) => !x.hidden && !busy.has(x.id) && !order.missedBy?.includes(x.id) && !k.busy(x) && (!order.cwd || sameRepo(x.cwd, order.cwd));
		const key = order.stage === "inbox" ? (order.lane === "fast" ? "build" : "spec") : order.stage;
		// Stage containers first (fewest stages), so a build goes to the Build agents before an all-stage container.
		const boxes = readContainers()
			.filter((x) => order.kind === "question" || x.stages.includes(key))
			.sort((a, b) => a.stages.length - b.stages.length);
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
		// The front desk gets the skills that fit the question too: installed, and their text in its prompt.
		const picks = matchSkills(t.title, 2).map((x) => x.name);
		if (picks.length) {
			stock(picks, k.fetch);
			updateTask(t.id, { skills: picks });
		}
		const texts = picks.map((n) => [n, readSkill(n)] as const).filter(([, body]) => body);
		const skills = texts.length ? `Skills you can use:\n\n${texts.map(([n, body]) => `## /${n}\n${body.slice(0, 3000)}`).join("\n\n")}` : "";
		k.ask(t.title, t.cwd, { web: needsWeb(t.title), ...(skills ? { skills } : {}) })
			.then((answer) => updateTask(t.id, { stage: "done", answer: answer.trim() || "(no answer)", servedAt: Date.now(), assignee: "", sentAt: 0 }))
			.catch(() => updateTask(t.id, { assignee: "", sentAt: 0 }));
	}

	// ---------- orders ----------
	app.get("/api/scores", (c) => {
		const strikes: Record<string, number> = {};
		for (const box of readContainers()) strikes[box.name] = (strikes[box.name] ?? 0) + box.pods.reduce((a, p) => a + p.strikes, 0);
		return c.json({ ...scoreboard(readTasks()), ratings: ratings(readTasks(), strikes), flow: flow(readTasks()) });
	});
	app.get("/api/tasks", (c) => {
		const now = Date.now();
		// Read the sessions once per request, not once per order.
		let sessions: Session[] | undefined;
		const getAssigneeLabel = (t: Task): string => {
			if (!t.assignee) return "";
			const crewEntry = t.crew?.[t.stage];
			if (crewEntry?.name) return crewEntry.name;
			sessions ??= k.read();
			const session = sessions.find((s) => s.id === t.assignee);
			return session?.role || "Agent";
		};
		const hasStuckWarning = (t: Task): boolean => {
			return t.stage === "inbox" && !t.assignee && now - t.created > 30000;
		};
		return c.json({
			stages: STAGES,
			roles: STAGE_ROLES,
			tasks: beltOrder(readTasks()).map((t) => ({
				...t,
				assigneeLabel: getAssigneeLabel(t),
				pickedUpAt: t.sentAt || undefined,
				stuckWarning: hasStuckWarning(t),
				skills: t.skills.map((name) => ({ name, state: skillState(name), haiku: haikuFit(name) })),
				why: t.assignee || t.stage === "done" ? "" : t.stuck ? "Stuck: look at it, then serve it or send it back." : t.atPass ? (settings().auto ? "Spec done: crossing the pass." : "Waiting at the pass for your approval.") : t.skills.some((n) => skillState(n) !== "ok") ? "Installing its skills." : pick(t, settings().auto).why,
			})),
		});
	});
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
		const folders = [...new Set([...k.read().map((x) => x.cwd).filter(Boolean), ...readContainers().map((x) => x.cwd)])] as string[];
		const where = kind === "task" ? whereOf(title, b.cwd ?? "", folders) : (b.cwd ?? "");
		if (where !== (b.cwd ?? "")) card.where = where.split("/").filter(Boolean).pop() ?? where;
		const t = addTask({ title, cwd: where, priority: b.priority, skills, route, kind, lane, zachman: card });
		frontDesk(t);
		stock(skills, k.fetch);
		// The order as it is after the front desk: a sum is already answered and served.
		return c.json(readTasks().find((x) => x.id === t.id) ?? t, 201);
	});
	app.post("/api/tasks/move", async (c) => {
		const no = guard(c);
		if (no) return no;
		const b = await body<{ id?: string; stage?: string; approved?: boolean; priority?: string; cwd?: string }>(c);
		if (b.cwd !== undefined && !isDir(String(b.cwd))) return c.json({ error: "That folder does not exist." }, 400);
		if (b.stage && !(STAGES as readonly string[]).includes(b.stage)) return c.json({ error: "Unknown stage." }, 400);
		if (b.priority && !(PRIORITIES as readonly string[]).includes(b.priority)) return c.json({ error: "Pick P0, P1 or P2." }, 400);
		const t = updateTask(String(b.id), {
			...(b.stage ? { stage: b.stage as Stage, assignee: "", sentAt: 0 } : {}),
			...(typeof b.approved === "boolean" ? { approved: b.approved, ...(b.approved ? { atPass: false } : {}) } : {}),
			...(b.priority ? { priority: b.priority as Task["priority"] } : {}),
			...(b.cwd ? { cwd: resolvePath(String(b.cwd)), assignee: "", sentAt: 0 } : {}),
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
		// Requeue routes the folder again, so a board order filed under another folder lands in the board's repo.
		const folders = [...new Set([...k.read().map((x) => x.cwd).filter(Boolean), ...readContainers().map((x) => x.cwd)])] as string[];
		const cwd = kind === "task" ? whereOf(t.title, t.cwd, folders) : t.cwd;
		updateTask(t.id, {
			cwd,
			stage: "inbox", assignee: "", sentAt: 0, approved: false, atPass: false, stuck: false, failed: false, rounds: 0,
			missedBy: [], answer: undefined, servedAt: undefined, startedAt: undefined, crew: {}, route, kind, skills,
			lane: kind === "task" ? laneOf(t.title) : undefined,
			zachman: zachman({ title: t.title, cwd, priority: t.priority, route, skills, kind, lane: kind === "task" ? laneOf(t.title) : undefined }),
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
	/** The message an order's stage agent gets: the order, its card, what earlier stages handed on, its job, its skills. */
	function orderText(order: Task, use: string[], wt: string | undefined, learned: string[] = []): string {
		const verdict = order.stage === "test" || order.stage === "review";
		const card = order.zachman ? `\n\n${zachmanLines(order.zachman)}` : "";
		const handed = (["spec", "build", "test"] as const)
			.filter((st) => st !== order.stage && order.notes?.[st])
			.map((st) => `\n\nFrom the ${STAGE_TYPE[st]} agent:\n${order.notes?.[st]}`)
			.join("");
		const where = wt ? `\n\nYou are in this order's own git worktree: ${wt} (branch kitchen/order-${order.n}). Work only there, never in ${order.cwd}.` : "";
		// The change itself is the record Test and Review check, not Build's summary of it.
		const diff = wt && order.base && (order.stage === "test" || order.stage === "review") ? `\n\nThe change to check is \`git -C ${wt} diff ${order.base}\` (plus untracked files in \`git -C ${wt} status\`). Judge it, not the summary above.` : "";
		const lastTime = order.retryOf
			? `\n\nThis is the second attempt at #${order.retryOf}, which failed. What went wrong last time, so you do not repeat it:\n${(order.failures ?? []).map((f) => `- ${f}`).join("\n") || "- (no reason was given)"}`
			: "";
		// What got earlier agents in this container fired, in the order itself: a new agent must not need to open the
		// lessons skill to know it.
		const known = learned.length ? `\n\nLessons from agents this container fired. Do not repeat these mistakes:\n${learned.map((l) => `- ${l}`).join("\n")}` : "";
		const fresh = order.requeued ? `\n\nThis order was requeued: treat it as new. Earlier verdicts or rejections of #${order.n} do not apply.` : "";
		const text =
			order.kind === "question"
				? `Question #${order.n} from the board: ${order.title}\n\nAnswer it in one short reply. Do not change any files.`
				: `Order #${order.n} (${order.stage}): ${order.title}${card}${handed}${where}${diff}${lastTime}${known}${fresh}\n\nYour job: ${(order.stage === "review" && order.pr ? REVIEW_PR : (STAGE_BRIEF[order.stage as keyof typeof STAGE_BRIEF] ?? "Do this step.")).replaceAll("{n}", String(order.n)).replaceAll("{pr}", order.pr ?? "")}\n\nUse these skills: ${use.map((n) => `/${n}`).join(", ")}.\n\n${verdict ? "Run commands in the foreground and wait for their results; never end your turn while one still runs. End with your verdict record." : `When this ${order.stage} step is finished, say so in one line.`}\n\n${ADDRESS}`;
		return text;
	}

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
		if (agent() && order.kind === "task" && !session) return fliskDispatch(order);
		const chosen = session ? { session: k.read().find((x) => x.id === session), why: "That agent is gone." } : pick(order, podsOnly);
		const s = chosen.session;
		if (!s) return { status: 409, body: { error: chosen.why } };
		const box = podOf(s.id)?.container;
		// A question is a worker's job (Haiku, low); only planning a task is the orchestrator's.
		const policy = policyFor(order.kind === "question" ? "build" : order.stage, box ? { model: box.model, effort: box.effort } : undefined);
		if (s.agent === "claude") k.tune(s.id, { ...policy, mode: KITCHEN_MODE });
		const use = skillset(order.stage, [...order.skills, ...(box ? [...box.skills, lessonsSkill(lessonsKeyOf(box))] : [])]);
		// The order's worktree: made once by the board, then every stage's agent starts its chat inside it, Spec too, so
		// nothing a stage writes lands in the shared checkout.
		const wt = order.kind === "task" && ["spec", "build", "test", "review"].includes(order.stage) ? (order.worktree && !order.worktree.includes("/.git/kitchen/") ? order.worktree : orderWorktree(order.cwd, order.n)) : undefined;
		if (wt && wt !== order.worktree) updateTask(order.id, { worktree: wt, base: headOf(wt) });
		// Kept from the first build round: a retry after a leak must still see the leak.
		if (wt && order.stage === "build" && !order.baseDirty) updateTask(order.id, { baseDirty: repoDirty(order.cwd) });
		const text = orderText(order, use, wt, box ? lessonsFor(lessonsKeyOf(box)) : []);
		// Sidecar: the skills this order matched join its container's set, so the container learns what its folder needs.
		if (box && order.skills.length) injectSkills(box.id, order.skills);
		// A container agent that last worked on another order gets a fresh chat, so orders never bleed into each other.
		// The same order (another round, the next stage in an all-stage container) keeps its chat.
		const pod = box?.pods.find((p) => p.session === s.id && p.status !== "evicted");
		let who = s.id;
		if (box && s.agent === "claude" && ((pod?.lastOrder && pod.lastOrder !== order.id) || (wt && s.cwd !== wt))) {
			who = randomUUID();
			k.start({ agent: "claude", cwd: wt ?? (order.cwd || box.cwd), text, model: policy.model, effort: policy.effort, id: who, role: box.role, mode: KITCHEN_MODE });
			freshChat(s.id, who, order.id);
			k.name?.(who, podName(box, who));
			k.close(s.id);
		} else {
			const res = k.send(s, `#${order.n} ${order.stage}: ${order.title}`, text);
			if (res.status >= 400) return { status: res.status, body: { error: `${s.role} could not take it right now.` } };
			if (box) podOrder(s.id, order.id);
		}
		const crew = { ...(order.crew ?? {}), [order.stage]: { id: who, role: s.role, name: box ? podName(box, who) : s.title || s.role } };
		return { status: 202, body: { ...updateTask(order.id, { assignee: who, sentAt: Date.now(), crew, startedAt: order.startedAt ?? Date.now() }), model: policy.model, effort: policy.effort, fresh: who !== s.id } };
	}

	/**
	 * Flisk path: the order's step is one turn on the Flisk kitchen agent (session "order-<n>-<stage>"), whose reply
	 * comes back as the HTTP response. No pods, no waiting for an agent to go quiet, nobody left unanswered.
	 */
	function fliskDispatch(order: Task): Out {
		const stage = order.stage;
		const sid = `order-${order.n}-${stage}`;
		const who = `flisk:${sid}`;
		const wt = ["spec", "build", "test", "review"].includes(stage) ? (order.worktree && !order.worktree.includes("/.git/kitchen/") ? order.worktree : orderWorktree(order.cwd, order.n)) : undefined;
		if (wt && wt !== order.worktree) updateTask(order.id, { worktree: wt, base: headOf(wt) });
		if (wt && stage === "build" && !order.baseDirty) updateTask(order.id, { baseDirty: repoDirty(order.cwd) });
		const policy = policyFor(stage);
		const text = orderText(order, skillset(stage, order.skills), wt);
		const type = STAGE_TYPE[stage as keyof typeof STAGE_TYPE] ?? stage;
		const crew = { ...(order.crew ?? {}), [stage]: { id: who, role: type, name: `${type} · Flisk agent` } };
		const t = updateTask(order.id, { assignee: who, sentAt: Date.now(), crew, startedAt: order.startedAt ?? Date.now() });
		inFlight.add(who);
		void fliskTurn(order.id, sid, who, text, wt ?? order.cwd, policy).finally(() => inFlight.delete(who));
		return { status: 202, body: { ...t, model: policy.model, effort: policy.effort, via: "flisk" } };
	}

	/**
	 * One ask, answered by a fresh turn whose only input is the asked stage's record: not the asker's chat, and not
	 * the asked agent's resumed session, which a person may be using. Undefined when nothing can answer.
	 */
	async function askStage(t: Task, to: AskStage, question: string): Promise<string | undefined> {
		const asker = STAGE_TYPE[t.stage as keyof typeof STAGE_TYPE] ?? t.stage;
		const input = askInput(t.n, t.title, asker, STAGE_TYPE[to], t.notes?.[to] ?? "", question);
		const call = agent();
		const out = call ? await call(`order-${t.n}-${to}-ask-${(t.asked ?? 0) + 1}`, { input, cwd: t.worktree ?? t.cwd }) : k.ask ? await k.ask(input, t.cwd) : undefined;
		return out?.trim() || undefined;
	}

	/** Runs one Flisk turn for an order's step, answers its asks, checks the build, then moves the order on. */
	async function fliskTurn(id: string, sid: string, who: string, text: string, cwd: string, policy: { model: string; effort: string }) {
		const call = agent();
		const t0 = readTasks().find((x) => x.id === id);
		if (!call || !t0) return;
		const stage = t0.stage;
		const asker = STAGE_TYPE[stage as keyof typeof STAGE_TYPE] ?? stage;
		const turn = (session: string, input: string) => call(session, { input, cwd, model: policy.model, effort: policy.effort });
		let reply: string;
		try {
			reply = await turn(sid, text);
			// Agent to agent: the reply's record asks an earlier stage; a fresh turn answers from that stage's record.
			for (let i = 0; i < MAX_ASKS; i++) {
				const q = recordIn(reply)?.ask;
				if (!q) break;
				const cur = readTasks().find((x) => x.id === id);
				if (!cur) return;
				const to = STAGE_TYPE[q.to];
				const answer = canAsk(stage, q.to, cur.notes) ? await askStage(cur, q.to, q.question) : undefined;
				updateTask(id, { asked: (cur.asked ?? 0) + 1, talk: [...(cur.talk ?? []), { at: Date.now(), from: asker, to, text: q.question.slice(0, 300) }, { at: Date.now(), from: answer ? to : "Orchestrator", to: asker, text: (answer ?? "not asked: that stage has no record").slice(0, 300) }].slice(-10) });
				reply = await turn(sid, answer ? answerText(cur.n, q.to, q.question, answer) : cannotAsk(cur.n, q.to));
			}
			// A build that changed nothing is asked once more, then fails; Test never gets an empty branch.
			const wt = readTasks().find((x) => x.id === id)?.worktree;
			if (stage === "build" && wt && isDir(wt) && !worktreeChanged(wt, readTasks().find((x) => x.id === id)?.base)) {
				reply = await turn(sid, NO_CHANGES);
				if (!worktreeChanged(wt, readTasks().find((x) => x.id === id)?.base)) {
					const cur = readTasks().find((x) => x.id === id);
					const why = `build: no changes made in the worktree. ${failLine(reply) || reply.split("\n").filter(Boolean).at(-1) || ""}`.slice(0, 300);
					fliskReplies.set(who, reply);
					updateTask(id, { stuck: true, assignee: "", sentAt: 0, failures: [...(cur?.failures ?? []), why].slice(-6), notes: { ...(cur?.notes ?? {}), [stage]: handOffOf(reply) } });
					return;
				}
			}
			// Edits that landed in the shared checkout: asked once to move them, then the step fails (#163).
			const t1 = readTasks().find((x) => x.id === id);
			if (stage === "build" && t1?.worktree && leakedInto(t1.cwd, t1.baseDirty).length) {
				reply = await turn(sid, LEAKED(t1.cwd, t1.worktree, leakedInto(t1.cwd, t1.baseDirty)));
				const left = leakedInto(t1.cwd, t1.baseDirty);
				if (left.length) {
					const cur = readTasks().find((x) => x.id === id);
					fliskReplies.set(who, reply);
					updateTask(id, { stuck: true, assignee: "", sentAt: 0, failures: [...(cur?.failures ?? []), `build: edited the shared checkout ${t1.cwd}, not the worktree: ${left.join(", ")}`.slice(0, 300)], notes: { ...(cur?.notes ?? {}), [stage]: handOffOf(reply) } });
					return;
				}
			}
		} catch (e) {
			// The agent could not run the turn: a test or review counts as FAIL, a spec or build goes back on the belt.
			const msg = `FAIL: the Flisk kitchen agent could not run this turn: ${String((e as Error).message ?? e).slice(0, 200)}`;
			const cur = readTasks().find((x) => x.id === id);
			if (!cur || cur.assignee !== who) return;
			if (stage === "test" || stage === "review") {
				fliskReplies.set(who, msg);
				serve(id, false);
			} else updateTask(id, { assignee: "", sentAt: 0, failures: [...(cur.failures ?? []), `${stage}: ${msg}`].slice(-6) });
			return;
		}
		fliskReplies.set(who, reply);
		const cur = readTasks().find((x) => x.id === id);
		if (!cur || cur.assignee !== who) return;
		serve(id, stage === "test" || stage === "review" ? (verdictIn(reply) ?? false) : true);
	}

	/**
	 * The agent is done. A finished spec waits at the pass. A FAIL in test or review strikes the pod that built it
	 * and sends the order back to build.
	 */
	function serve(id: string, pass?: boolean): Out {
		let t = readTasks().find((x) => x.id === id);
		if (!t) return { status: 404, body: { error: "That order is gone." } };
		// The Ship step finished: keep its pull request and serve the order.
		// The pull request is open (or updated): the Review agent reviews it next.
		if (t.shipping) {
			const said = replyOf(t?.assignee);
			const pr = /https:\/\/github\.com\/[^\s)>\]]+\/pull\/\d+/.exec(said)?.[0];
			// Without a PR, the ship failed. Send it back to be re-shipped once, or mark it stuck if it failed twice.
			if (!pr && !t.pr) return { status: 200, body: { ...updateTask(t.id, { stage: "ship", shipping: false, assignee: "", sentAt: 0, stuck: t.stuck }) } };
			// No new PR (the old one is fine), or a new PR was created: proceed to review.
			return { status: 200, body: { ...updateTask(t.id, { stage: "review", shipping: false, ...(pr ? { pr } : {}), assignee: "", sentAt: 0 }) } };
		}
		// Keep what this stage's agent handed on, so the next stages work from it instead of the title alone.
		if (t.assignee && t.kind !== "question" && t.stage !== "inbox" && t.stage !== "done") {
			const said = replyOf(t?.assignee);
			// What it said before the orchestrator wrote to it counts too: a Spec that ended "Shall I proceed?" handed
			// Build only its answer to the orchestrator ("Spec is final.").
			const all = handOffOf([t.draft, said].filter(Boolean).join("\n\n"));
			if (all) t = updateTask(t.id, { notes: { ...(t.notes ?? {}), [t.stage]: all }, draft: undefined }) ?? t;
			// The Spec agent can move an order to the folder its code is in.
			const moved = t.stage === "spec" ? folderHint(said) : t.stage === "build" ? elsewhere(said) : undefined;
			if (moved && moved !== t.cwd && isDir(moved)) {
				t = updateTask(t.id, { cwd: moved, worktree: undefined, baseDirty: undefined }) ?? t;
				// A builder that found the code in another folder: build again there instead of failing the order.
				if (t.stage === "build") return { status: 200, body: { ...updateTask(t.id, { assignee: "", sentAt: 0 }), moved } };
			}
		}
		const order = t;
		if (pass === false && (t.stage === "test" || t.stage === "review")) {
			const builder = t.crew?.build?.id;
			// The lesson is the agent's FAIL line, not the tail of its reply.
			const said = replyOf(t.assignee);
			const why = failLine(said) || `FAIL: stopped without a PASS or FAIL line. Last said: ${said.split("\n").filter(Boolean).at(-1)?.slice(0, 200) || "(nothing)"}`;
			updateTask(t.id, { failures: [...(t.failures ?? []), `${t.stage}: ${why}`].slice(-6) });
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
		// Ship: tests passed, so an agent commits the Build agent's worktree, pushes and opens a pull request (or pushes
		// a fix to the one already open), and the Review agent then reviews that pull request. Only from the order's own
		// worktree (shipping from the shared checkout would commit everyone's edits), and only when it holds a change:
		// an empty worktree has nothing to ship, and its agent would only ask what to do. The change is what ships, not
		// the Build agent's summary: order #30 left 114 changed lines that were never shipped because its summary was empty.
		if (to === "review" && t.kind === "task" && t.worktree && isDir(t.worktree) && worktreeChanged(t.worktree, t.base) && k.ship !== false) {
			const branch = `kitchen/order-${t.n}`;
			const how = t.pr
				? `commit any new change with \`git commit -s\` and a short conventional message, and push the branch: pull request ${t.pr} updates by itself. Reply with its URL.`
				: `commit every change with \`git commit -s\` and a short conventional message, push the branch, and open a pull request with \`gh pr create --base main --fill\`. Reply with the pull request URL. If there is nothing to commit, reply "No changes to ship".`;
			const shipText = `Ship order #${t.n}: ${t.title}\n\nYou are in this order's worktree: ${t.worktree} (branch ${branch}). In that worktree: ${how}\n\n${ADDRESS}${t.notes?.build ? `\n\nFrom the Build agent:\n${t.notes.build}` : ""}`;
			const call = agent();
			if (call) {
				const who = `flisk:order-${t.n}-ship`;
				const shipped = updateTask(t.id, { shipping: true, assignee: who, sentAt: Date.now() });
				inFlight.add(who);
				const order = t;
				void call(`order-${order.n}-ship`, { input: shipText, cwd: order.worktree, model: "haiku", effort: "low" })
					.then((r) => fliskReplies.set(who, r))
					.catch((e) => fliskReplies.set(who, `Ship failed: ${String((e as Error).message ?? e)}`))
					.finally(() => {
						inFlight.delete(who);
						if (readTasks().find((x) => x.id === order.id)?.assignee === who) serve(order.id);
					});
				return { status: 200, body: { ...shipped } };
			}
			const id = randomUUID();
			k.start({
				agent: "claude",
				cwd: t.worktree,
				id,
				role: "Build",
				mode: KITCHEN_MODE,
				model: "haiku",
				effort: "low",
				text: shipText,
			});
			k.name?.(id, `Ship · #${t.n}`);
			return { status: 200, body: { ...updateTask(t.id, { shipping: true, assignee: id, sentAt: Date.now() }) } };
		}
		if (to === "done") for (const who of new Set(Object.values(t.crew ?? {}).map((x) => x?.id))) if (who) served(who);
		return { status: 200, body: { ...updateTask(t.id, { stage: to, assignee: "", sentAt: 0, stuck: false, ...(to === "done" ? { servedAt: Date.now() } : {}) }) } };
	}

	/**
	 * An agent finished its step when it went quiet after the order was sent and the order is in its chat. Busy is only
	 * known in memory, so after a board restart a chat still starting up looked finished: order #27's spec was read
	 * as its start-up reply, "ready". The chat's last message from the board (asked) must be the one sent.
	 */
	const landed = (s: Session, at: number) => s.asked === undefined || s.asked >= at - 2_000;
	const finished = (t: Task, s: Session | undefined, now: number) => !!s && t.sentAt > 0 && !k.busy(s) && landed(s, t.sentAt) && s.updatedAt > t.sentAt + 1_000 && now - s.updatedAt > 3_000;
	/** Keeps what a step's agent said so far, before the orchestrator writes to it again. */
	const keep = (t: Task, s: Session | undefined) => ({ draft: [t.draft, handOff(s)].filter(Boolean).join("\n\n") || undefined });
	const verdictOf = (s: Session | undefined) => verdictIn(handOff(s));
	/** Answers to open asks, by ask id; an ask still running is in asking. */
	const answers = new Map<string, { answer?: string; error?: string }>();
	const asking = new Set<string>();
	function startAsk(t: Task, id: string, to: AskStage, question: string) {
		asking.add(id);
		askStage(t, to, question)
			.then((answer) => answers.set(id, answer ? { answer } : { error: `the ${STAGE_TYPE[to]} stage could not be asked` }))
			.catch((e) => answers.set(id, { error: String((e as Error).message ?? e).slice(0, 200) }))
			.finally(() => asking.delete(id));
	}

	/**
	 * Autopilot, run by the server loop so orders move with no board page open and no buttons: specs cross the pass,
	 * stuck orders close as failed, the autoscaler sizes the containers, finished steps move on (test and review by
	 * their PASS or FAIL), then every waiting order goes to the next free container agent. On by default.
	 * Your own chats only get orders you dispatch by hand.
	 */
	function auto(now = Date.now()) {
		const did: string[] = [];
		did.push(...letIdleGo(now));
		const all = k.read();
		did.push(...tidy(all, now));
		if (!settings().auto) return did;
		// Autopilot: a finished spec crosses the pass by itself, and an order stuck after MAX_ROUNDS is closed as
		// failed (a gutter on the scoreboard) so it never blocks the belt.
		for (const t of readTasks()) {
			if (t.atPass) {
				updateTask(t.id, { atPass: false, approved: true, stage: "build", assignee: "", sentAt: 0 });
				did.push(`#${t.n} approved`);
			} else if (t.stuck && t.stage !== "done") {
				updateTask(t.id, { stage: "done", failed: true, assignee: "", sentAt: 0, servedAt: now });
				did.push(`#${t.n} closed as failed`);
				const next = followUp(t);
				if (next) did.push(`#${t.n} followed up as #${next.n}`);
			}
		}
		// With a Flisk kitchen agent there are no container agents to size.
		did.push(...(agent() ? [] : autoscale()), ...retireMixed(), ...sidecar());
		for (const t of readTasks()) {
			if (t.assignee?.startsWith("flisk:") && !inFlight.has(t.assignee)) {
				updateTask(t.id, { assignee: "", sentAt: 0, shipping: false });
				did.push(`#${t.n} sent again: its Flisk turn was lost`);
			}
		}
		for (const t of readTasks()) {
			if (!t.assignee) continue;
			const s = all.find((x) => x.id === t.assignee);
			// Agent to agent: deliver the answer to this order's open ask, matched by its id, never by a chat going quiet.
			if (t.waitingOn) {
				const w = t.waitingOn;
				const from = STAGE_TYPE[w.stage as AskStage] ?? w.stage;
				const got = answers.get(w.id);
				if (!got && !asking.has(w.id)) {
					// The board restarted while the ask ran: ask again, same id.
					startAsk(t, w.id, w.stage as AskStage, w.question);
					continue;
				}
				if (!got) {
					if (now - w.at <= ASK_TIMEOUT_MS) continue;
					// No answer in time: the step fails with the open ask named; nobody answers in the asked agent's place.
					asking.delete(w.id);
					updateTask(t.id, { waitingOn: undefined, stuck: true, assignee: "", sentAt: 0, failures: [...(t.failures ?? []), `${t.stage}: asked ${from} "${w.question.slice(0, 120)}" and got no answer in ${ASK_TIMEOUT_MS / 60_000} minutes`].slice(-6) });
					did.push(`#${t.n} ${from} did not answer: failed`);
					continue;
				}
				const text = got.answer ? answerText(t.n, w.stage as AskStage, w.question, got.answer) : `${cannotAsk(t.n, w.stage as AskStage)} (${got.error})`;
				// The asker gets the answer, or the ask stays open and is delivered on the next pass.
				if (!s || k.send(s, `#${t.n}: ${from} answered`, text).status >= 400) {
					did.push(`#${t.n} ${from} answer not delivered yet`);
					continue;
				}
				answers.delete(w.id);
				updateTask(t.id, { ...keep(t, s), waitingOn: undefined, sentAt: Date.now(), talk: [...(t.talk ?? []), { at: Date.now(), from: got.answer ? from : "Orchestrator", to: STAGE_TYPE[t.stage as keyof typeof STAGE_TYPE] ?? t.stage, text: (got.answer || got.error || "").slice(0, 300) }].slice(-10) });
				did.push(`#${t.n} ${got.answer ? `${from} answered` : `${from} could not answer`}`);
				continue;
			}
			if (!finished(t, s, now)) continue;
			// Agent to agent: the record's one ask goes to an earlier stage, answered by a fresh turn from that stage's record.
			const q = s && !t.shipping ? recordIn(handOff(s))?.ask : undefined;
			if (q && (t.asked ?? 0) < MAX_ASKS) {
				const asker = STAGE_TYPE[t.stage as keyof typeof STAGE_TYPE] ?? t.stage;
				const talk = [...(t.talk ?? []), { at: Date.now(), from: asker, to: STAGE_TYPE[q.to], text: q.question.slice(0, 300) }].slice(-10);
				if (canAsk(t.stage, q.to, t.notes) && (agent() || k.ask)) {
					const askId = randomUUID();
					updateTask(t.id, { ...keep(t, s), asked: (t.asked ?? 0) + 1, waitingOn: { id: askId, stage: q.to, question: q.question, at: Date.now() }, talk });
					startAsk(t, askId, q.to, q.question);
					did.push(`#${t.n} ${asker} asked ${STAGE_TYPE[q.to]}`);
				} else if (s && k.send(s, `#${t.n}: no ${STAGE_TYPE[q.to]} record`, cannotAsk(t.n, q.to)).status < 400) {
					updateTask(t.id, { ...keep(t, s), asked: (t.asked ?? 0) + 1, sentAt: Date.now(), talk });
					did.push(`#${t.n} ${asker} asked ${STAGE_TYPE[q.to]}: no record to answer from, told to decide`);
				}
				continue;
			}
			// A build that left nothing in its worktree is not ready for Test: ask once more to make the change, then
			// fail it, so Test is never handed an empty branch.
			if (t.stage === "build" && !t.shipping && t.worktree && isDir(t.worktree) && !worktreeChanged(t.worktree, t.base)) {
				if ((t.answered ?? 0) < MAX_ANSWERS && s && k.send(s, `#${t.n}: no changes`, NO_CHANGES).status < 400) {
					updateTask(t.id, { ...keep(t, s), answered: (t.answered ?? 0) + 1, sentAt: Date.now() });
					did.push(`#${t.n} build left no changes: asked again`);
				} else {
					const why = `build: no changes made in the worktree. ${failLine(handOff(s)) || handOff(s).split("\n").filter(Boolean).at(-1) || ""}`.slice(0, 300);
					updateTask(t.id, { stuck: true, assignee: "", sentAt: 0, failures: [...(t.failures ?? []), why].slice(-6) });
					did.push(`#${t.n} build made no changes: failed`);
				}
				continue;
			}
			// A build whose edits landed in the shared checkout is not handed to Test: asked once to move them into the
			// worktree, then failed with the files named (#163).
			const leaked = t.stage === "build" && !t.shipping && t.worktree ? leakedInto(t.cwd, t.baseDirty) : [];
			if (leaked.length && t.worktree) {
				if ((t.answered ?? 0) < MAX_ANSWERS && s && k.send(s, `#${t.n}: edits outside the worktree`, LEAKED(t.cwd, t.worktree, leaked)).status < 400) {
					updateTask(t.id, { ...keep(t, s), answered: (t.answered ?? 0) + 1, sentAt: Date.now() });
					did.push(`#${t.n} build edited the shared checkout: asked to move it`);
				} else {
					updateTask(t.id, { stuck: true, assignee: "", sentAt: 0, failures: [...(t.failures ?? []), `build: edited the shared checkout ${t.cwd}, not the worktree: ${leaked.join(", ")}`.slice(0, 300)] });
					did.push(`#${t.n} build edited the shared checkout: failed`);
				}
				continue;
			}
			// An agent that stopped to ask for approval gets the policy (decide or FAIL), never a "yes", at most twice per step.
			if (s && asksBack(handOff(s), t) && (t.answered ?? 0) < MAX_ANSWERS) {
				const res = k.send(s, `#${t.n}: orchestrator's policy`, DECIDE);
				if (res.status < 400) {
					updateTask(t.id, { ...keep(t, s), answered: (t.answered ?? 0) + 1, sentAt: Date.now() });
					did.push(`#${t.n} answered ${t.stage} agent's question`);
					continue;
				}
			}
			// A test or review agent that went quiet with no PASS or FAIL is asked once to finish; after that it counts as
			// FAIL, so the order never waits forever.
			if (!t.shipping && (t.stage === "test" || t.stage === "review") && verdictOf(s) === undefined && (t.answered ?? 0) < MAX_ANSWERS) {
				if (s && k.send(s, `#${t.n}: no verdict`, NO_VERDICT).status < 400) {
					updateTask(t.id, { ...keep(t, s), answered: (t.answered ?? 0) + 1, sentAt: Date.now() });
					did.push(`#${t.n} ${t.stage} gave no verdict: asked again`);
					continue;
				}
			}
			const v = t.shipping ? true : t.stage === "test" || t.stage === "review" ? (verdictOf(s) ?? false) : true;
			serve(t.id, v);
			did.push(`#${t.n} ${t.stage} ${v ? "done" : "FAIL"}`);
		}
		did.push(...answerStrays(all, now));
		for (const t of beltOrder(readTasks())) {
			if (t.assignee || t.stage === "done" || t.stuck || t.atPass) continue;
			// Auto-dispatch only uses container agents, so orders never land in a chat you are typing in.
			const r = dispatch(t.id, undefined, true);
			if (r.status === 202) did.push(`#${t.n} sent`);
		}
		return did;
	}

	/**
	 * The autoscaler, like a Kubernetes HorizontalPodAutoscaler, with one container per stage per folder, staffed by
	 * the kitchen's four agent types (Spec, Build, Test, Review). Each has its stage's skill set, and all containers
	 * of a stage share one lessons skill (rma-lessons-<stage>).
	 * A stage container is made the first time an order needs that stage, grows while every agent in it is busy (up
	 * to MAX_AGENTS) and shrinks back to its floor when the stage has no orders. Containers you made yourself are
	 * used and scaled the same way, never deleted.
	 */
	function autoscale() {
		const did: string[] = [];
		const open = readTasks().filter((t) => t.stage !== "done" && !t.stuck && !t.atPass && t.assignee !== FRONT_DESK);
		const folders = new Set([...open.map((t) => t.cwd), ...readContainers().map((x) => x.cwd)]);
		for (const cwd of folders) {
			if (!cwd) continue;
			const folder = cwd.split("/").filter(Boolean).pop() ?? "folder";
			for (const stage of WORK_STAGES) {
				const here = open.filter((t) => t.cwd === cwd && staffStage(t) === stage);
				const waiting = here.filter((t) => !t.assignee).length;
				const working = here.filter((t) => t.assignee).length;
				let box = readContainers().find((x) => x.cwd === cwd && x.stages.length === 1 && x.stages[0] === stage);
				// Older stage containers used the general types (Planner, Code, Bug): move them to the stage's type
				// and its shared lessons, and retype their agents.
				if (box && (box.role !== STAGE_TYPE[stage] || box.lessonsKey !== stage)) {
					patchContainer(box.id, { role: STAGE_TYPE[stage], lessonsKey: stage });
					for (const p of box.pods)
						if (p.status !== "evicted") {
							k.type?.(p.session, STAGE_TYPE[stage]);
							k.name?.(p.session, podName({ name: box.name }, p.session));
						}
					did.push(`${box.name}: now ${STAGE_TYPE[stage]} agents`);
				}
				if (!box) {
					if (!waiting) continue;
					box = createContainer({ floor: 1, name: `${STAGE_TYPE[stage]} · ${folder}`, role: STAGE_TYPE[stage], lessonsKey: stage, stages: [stage], replicas: 1, cwd, model: "", effort: "", skills: STAGE_SKILLS[stage] });
					stock(STAGE_SKILLS[stage], k.fetch);
					did.push(`created ${box.name}`);
					continue;
				}
				// Grow while every agent is busy; shrinking is the idle timer's job (see letIdleGo).
				const want = Math.min(MAX_AGENTS, working + waiting);
				if (want > box.replicas) {
					patchContainer(box.id, { replicas: want, downReason: undefined });
					did.push(`${box.name}: ${box.replicas} → ${want} agents`);
				}
			}
		}
		return did;
	}

	/**
	 * Kitchen agents that hold no order (a Ship agent whose order is done, an idle container agent) and stopped on a
	 * question get one answer too: there is nothing for them to do, so they stop instead of waiting for the user.
	 * Never "go ahead": an agent with no order has nothing safe to go ahead with.
	 */
	const strayAnswered = new Set<string>();
	function answerStrays(all: Session[], now: number) {
		const did: string[] = [];
		const held = new Set(readTasks().flatMap((t) => [t.assignee, t.waitingOn?.session ?? ""]).filter(Boolean));
		const pods = new Set(readContainers().flatMap((c) => c.pods.filter((p) => p.status !== "evicted").map((p) => p.session)));
		for (const s of all) {
			if (held.has(s.id) || strayAnswered.has(s.id) || s.hidden || k.busy(s)) continue;
			if (!pods.has(s.id) && !/^Ship · #\d+/.test(s.title ?? "")) continue;
			if (now - s.updatedAt < 3_000 || now - s.updatedAt > 24 * 3_600_000) continue;
			if (!asksBack(handOff(s), { stage: "build" })) continue;
			if (k.send(s, "orchestrator: no order", STRAY_ANSWER).status < 400) {
				strayAnswered.add(s.id);
				did.push(`answered stray agent ${(s.title ?? s.id).slice(0, 30)}: no order`);
			}
		}
		return did;
	}

	/**
	 * Closes kitchen agents nobody needs any more: a Spec/Build/Test/Review/Ship chat that holds no order, is not a
	 * live container agent, and has been quiet for 2 minutes (a Ship agent whose order is served, a chat replaced by a
	 * fresh one). Your own chats are never closed.
	 */
	function tidy(all: Session[], now: number) {
		const did: string[] = [];
		const held = new Set(readTasks().flatMap((t) => [t.assignee, t.waitingOn?.session ?? ""]).filter(Boolean));
		const pods = new Set(readContainers().flatMap((c) => c.pods.filter((p) => p.status !== "evicted").map((p) => p.session)));
		for (const s of all) {
			if (s.hidden || held.has(s.id) || pods.has(s.id) || k.busy(s)) continue;
			if (!KITCHEN_CHAT.test(s.title ?? "")) continue;
			if (now - s.updatedAt < 2 * 60_000) continue;
			k.close(s.id);
			did.push(`closed idle agent ${(s.title ?? "").slice(0, 30)}`);
		}
		return did;
	}

	/**
	 * A failed task gets one follow-up: a new order for the same request, through the full kitchen (spec first), that
	 * carries what went wrong (each FAIL line) and the old spec. A follow-up that fails too is not followed up again,
	 * so a hopeless order cannot loop and spend tokens forever.
	 */
	function followUp(t: Task): Task | undefined {
		if (t.kind !== "task" || t.retryOf || t.followUp) return undefined;
		const route = t.route;
		const next = addTask({ title: t.title, cwd: t.cwd, priority: t.priority, skills: t.skills, route, kind: "task", lane: "full", zachman: t.zachman });
		stock(t.skills, k.fetch);
		updateTask(next.id, { retryOf: t.n, failures: t.failures ?? [], ...(t.notes?.spec ? { notes: { spec: t.notes.spec } } : {}) });
		updateTask(t.id, { followUp: next.n });
		return next;
	}

	/**
	 * The skill sidecar, like a sidecar next to each container: it scores every skill a container picked up from its
	 * orders by how those orders ended (served +1, failed or stuck -1), drops a skill at -2 or below, and keeps the best
	 * SIDECAR_KEEP. The stage's own skill set is never dropped.
	 */
	function sidecar() {
		const did: string[] = [];
		const tasks = readTasks();
		for (const box of readContainers()) {
			const own = new Set(box.stages.flatMap((st) => STAGE_SKILLS[st]));
			const stats = skillStats(box, tasks);
			const learned = box.skills.filter((n) => !own.has(n));
			const keep = learned
				.filter((n) => (stats[n]?.score ?? 0) > -2)
				.sort((a, b) => (stats[b]?.score ?? 0) - (stats[a]?.score ?? 0))
				.slice(0, SIDECAR_KEEP);
			// Every container carries its stages' own skill set, then the learned skills that are earning their place.
			const next = [...own, ...keep];
			if (next.length !== box.skills.length || next.some((n, i) => n !== box.skills[i])) {
				patchContainer(box.id, { skills: next });
				const gone = learned.filter((n) => !keep.includes(n));
				if (gone.length) did.push(`${box.name}: sidecar dropped /${gone.join(", /")}`);
			}
		}
		return did;
	}

	/**
	 * Containers that cover several stages (Kitchen cooks, Auto cooks) came before the stage agents. Once none of
	 * their agents holds an order they go to zero, unless you sized one by hand; the stage rows take their work.
	 */
	function retireMixed() {
		const did: string[] = [];
		const busy = new Set(readTasks().filter((t) => t.assignee).map((t) => t.assignee));
		for (const box of readContainers()) {
			if (box.stages.length < 2 || box.floorByHand || box.replicas === 0) continue;
			if (box.pods.some((p) => p.status !== "evicted" && busy.has(p.session))) continue;
			patchContainer(box.id, { replicas: 0, downReason: "Replaced by stage agents" });
			did.push(`${box.name}: replaced by stage agents`);
		}
		return did;
	}

	/**
	 * The idle timer: a container whose stages have had no orders in its folder for idleMinutes lets its agents go,
	 * down to the size you set by hand (none if you never did). The autoscaler starts one again when an order needs it.
	 */
	function letIdleGo(now = Date.now()) {
		const did: string[] = [];
		const idleMs = settings().idleMinutes * 60_000;
		const open = readTasks().filter((t) => t.stage !== "done" && !t.stuck && !t.atPass);
		for (const box of readContainers()) {
			const pods = new Set(box.pods.filter((p) => p.status !== "evicted").map((p) => p.session));
			const busy = open.some((t) => (t.assignee && pods.has(t.assignee)) || (t.cwd === box.cwd && (box.stages as string[]).includes(staffStage(t))));
			if (busy) {
				if (box.idleSince) patchContainer(box.id, { idleSince: undefined });
				continue;
			}
			const keep = box.floorByHand ? (box.floor ?? 0) : 0;
			if (box.replicas <= keep) continue;
			if (!box.idleSince) {
				patchContainer(box.id, { idleSince: now });
				continue;
			}
			if (now - box.idleSince < idleMs) continue;
			const mins = Math.round((now - box.idleSince) / 60_000);
			patchContainer(box.id, { replicas: keep, downReason: `Idle ${mins} min` });
			did.push(`${box.name}: idle ${mins} min, ${box.replicas} → ${keep} agents`);
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
		const { auto: on, idleMinutes, agentUrl } = await body<{ auto?: boolean; idleMinutes?: number; agentUrl?: string }>(c);
		if (agentUrl !== undefined) {
			// Loopback only: the kitchen agent runs your own claude with edit rights.
			if (agentUrl && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(agentUrl)) return c.json({ error: "The kitchen agent must be on this computer (http://127.0.0.1:<port>)." }, 400);
			saveSettings({ agentUrl: agentUrl || undefined });
			if (on === undefined && idleMinutes === undefined) return c.json({ ...settings(), did: [] });
		}
		if (idleMinutes !== undefined) {
			if (!Number.isFinite(idleMinutes) || idleMinutes < 1 || idleMinutes > 24 * 60) return c.json({ error: "Pick 1 to 1440 idle minutes." }, 400);
			saveSettings({ idleMinutes: Math.round(idleMinutes) });
		}
		if (on === undefined && idleMinutes !== undefined) return c.json({ ...settings(), did: [] });
		if (typeof on !== "boolean") return c.json({ error: "Say on or off." }, 400);
		saveSettings({ auto: on });
		return c.json({ auto: on, did: on ? auto() : [] });
	});

	// ---------- skill sets ----------
	app.get("/api/skillsets", (c) =>
		c.json({
			policy: POLICY,
			types: KITCHEN_AGENTS,
			stages: Object.fromEntries(STAGES.map((st) => [st, { policy: policyFor(st), skills: STAGE_SKILLS[st].map((n) => ({ name: n, haiku: haikuFit(n), state: skillState(n), what: SKILLS.find((s) => s.name === n)?.what ?? "" })) }])),
		}),
	);

	// ---------- agent containers ----------
	const view = (x: Container) => ({ ...x, lessonsSkill: lessonsSkill(lessonsKeyOf(x)), ready: x.pods.filter((p) => p.status === "ready").length, skills: x.skills.map((n) => ({ name: n, haiku: haikuFit(n), state: skillState(n), learned: !x.stages.some((st) => STAGE_SKILLS[st].includes(n)), ...(skillStats(x, readTasks())[n] ?? { score: 0, uses: 0 }) })) });
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
		const box = createContainer({ ...b, name, role: b.role || STAGE_ROLES[stages[0]][0], stages, cwd: b.cwd, skills, floorByHand: true, model: b.model ?? "", effort: b.effort ?? "" });
		stock([...skills, ...stages.flatMap((s) => STAGE_SKILLS[s])], k.fetch);
		return c.json(view(box), 201);
	});
	app.post("/api/containers/scale", async (c) => {
		const no = guard(c);
		if (no) return no;
		const { id, replicas } = await body<{ id?: string; replicas?: number }>(c);
		if (!Number.isFinite(replicas)) return c.json({ error: "Say how many agents." }, 400);
		const box = patchContainer(String(id), { replicas: Number(replicas), floor: Math.max(0, Math.min(10, Math.round(Number(replicas)))), floorByHand: true, idleSince: undefined, downReason: "Scaled down" });
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
	/** Clears a container's lessons, for when they came from orders that were never real work. */
	app.post("/api/containers/lessons/clear", async (c) => {
		const no = guard(c);
		if (no) return no;
		const { id } = await body<{ id?: string }>(c);
		const box = clearLessons(String(id));
		return box ? c.json({ cleared: true, name: box.name }) : c.json({ error: "That container is gone." }, 404);
	});
	app.post("/api/containers/reconcile", (c) => {
		const no = guard(c);
		if (no) return no;
		return c.json({ did: tick() });
	});
	return { tick, missed, auto };
}
