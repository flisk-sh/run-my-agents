// Agent containers work like a Kubernetes ReplicaSet. A container is a template (agent type, stages it cooks, model,
// skills, folder) plus a replica count; each replica is a pod, one real agent session. The reconcile loop keeps the
// count: it starts agents when there are too few and fires them when there are too many. A pod that fails or misses
// orders collects strikes; at the limit it is fired (evicted), its mistakes go into the container's lessons skill,
// and the loop starts a fresh agent that reads those lessons.
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDir } from "../prefs";
import type { Stage } from "./pipeline";
import { clip, lessonsSkill, matchSkills, SKILLS, STAGE_SKILLS, skillInstalled, skillsDir, writeLessons } from "./skills";
import { JsonStore } from "./store";

/**
 * Kitchen agents run in acceptEdits mode with KITCHEN_TOOLS allowed. Checked with a real non-interactive agent:
 * "auto" mode asked for permission to edit (nobody can approve one), while acceptEdits plus these tools edited the
 * file and ran git.
 */
export const KITCHEN_MODE = "acceptEdits";
/** The git commands a Build, Test, Review or container agent needs. `git push` is not among them: only Ship pushes. */
const GIT_LOCAL = [
	"add", "apply", "blame", "branch", "cat-file", "checkout", "cherry-pick", "clean", "commit", "config", "describe", "diff", "diff-tree",
	"fetch", "for-each-ref", "grep", "init", "log", "ls-files", "ls-tree", "merge", "merge-base", "mv", "pull", "rebase", "remote", "reset",
	"restore", "rev-list", "rev-parse", "rm", "shortlog", "show", "show-ref", "stash", "status", "switch", "symbolic-ref", "tag", "worktree",
].map((c) => `Bash(git ${c}:*)`);
/** Read-only gh commands. Opening a pull request (`gh pr create`) is Ship's job. */
const GH_READ = ["pr view", "pr list", "pr diff", "pr checks", "pr status", "issue view", "issue list", "repo view", "run view", "run list"].map((c) => `Bash(gh ${c}:*)`);
const RUNNERS = [
	"Bash(bun:*)", "Bash(npm:*)", "Bash(npx:*)", "Bash(node:*)", "Bash(pnpm:*)", "Bash(yarn:*)",
	"Bash(make:*)", "Bash(python3:*)", "Bash(pytest:*)", "Bash(go:*)", "Bash(cargo:*)", "Bash(ls:*)", "Bash(cat:*)",
	"Bash(grep:*)", "Bash(rg:*)", "Bash(find:*)", "Bash(mkdir:*)", "WebFetch", "WebSearch",
	// Every part of a piped or chained command must be allowed: `find … | grep … | head` was refused 110 times (#249).
	"Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(sort:*)", "Bash(uniq:*)", "Bash(cut:*)", "Bash(tr:*)", "Bash(sed:*)",
	"Bash(awk:*)", "Bash(echo:*)", "Bash(printf:*)", "Bash(pwd)", "Bash(which:*)", "Bash(test:*)", "Bash(xargs:*)",
	"Bash(diff:*)", "Bash(jq:*)", "Bash(tee:*)", "Bash(true)", "Bash(cd:*)",
];
/**
 * What a kitchen agent may run without asking: local git, read-only gh, the usual build and test runners, reads, web.
 * No `git push`, no `gh pr create`: they are in the Ship list only, so an order's content cannot make Build publish.
 */
export const KITCHEN_TOOLS = [...GIT_LOCAL, ...GH_READ, ...RUNNERS];
/** What the Ship agent may run: all of git and gh (it commits, pushes and opens the pull request), plus the runners. */
export const SHIP_TOOLS = ["Bash(git:*)", "Bash(gh:*)", ...RUNNERS];
/** The tools a kitchen agent is allowed: Ship's list for Ship, the narrower one for every other stage. */
export function kitchenTools(ship = false): string[] {
	return ship ? SHIP_TOOLS : KITCHEN_TOOLS;
}
/**
 * Refused for every kitchen stage, Ship included, whatever else is allowed (a deny rule wins over an allow rule). Orders
 * run on outside repos whose content is untrusted. The board merges pull requests itself, so no agent needs `gh pr
 * merge`; nothing needs to delete a repo or rewrite a remote's history. The same rules are in .claude/settings.json,
 * which applies to orders on this repo itself.
 */
export const KITCHEN_DENY = [
	"Bash(gh pr merge:*)", "Bash(gh repo delete:*)", "Bash(gh api -X DELETE:*)", "Bash(gh api --method DELETE:*)",
	"Bash(git push --force:*)", "Bash(git push -f:*)", "Bash(git push * --force*)", "Bash(git push * -f)",
	"Read(.env*)", "Read(**/.env*)",
];

const ENV_KEEP = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TERM|TMPDIR|XDG_[A-Z_]+)$/;
/** The model provider's own auth, which the agent CLI needs to run at all. */
const ENV_PROVIDER = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL)$/;
/** What only the Ship agent gets: the means to push and open a pull request. */
const ENV_SHIP = /^(GH_TOKEN|GITHUB_TOKEN|SSH_AUTH_SOCK)$/;
/**
 * The environment a kitchen agent starts with, built from an allowlist instead of the board's own: a token in the shell
 * that started the board (GH_TOKEN, CLOUDFLARE_API_TOKEN, any cloud key) must not reach an agent that reads untrusted
 * repos. Only Ship gets GH_TOKEN, since only Ship pushes. `gh` and `git` still find their saved login through HOME.
 */
export function kitchenEnv(ship = false, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([k]) => ENV_KEEP.test(k) || ENV_PROVIDER.test(k) || (ship && ENV_SHIP.test(k))));
}

/**
 * What every kitchen agent starts with besides its tools: its repo's own settings only, not the user's. The user's
 * hooks, plugins and CLAUDE.md made kitchen agents read files outside their repo and blocked their reads (#249). The
 * skills the kitchen installs live with the user's, so a folder of the board's carries them in (`--add-dir`).
 */
export function kitchenFlags(): string[] {
	const home = join(dataDir(), "kitchen-home");
	const link = join(home, ".claude", "skills");
	try {
		mkdirSync(join(home, ".claude"), { recursive: true });
		const has = existsSync(link) || (() => { try { return lstatSync(link).isSymbolicLink(); } catch { return false; } })();
		if (has && readlinkSync(link) !== skillsDir()) rmSync(link, { force: true });
		if (!existsSync(link)) symlinkSync(skillsDir(), link);
	} catch {}
	// Claude discovers <dir>/.claude/CLAUDE.md in every parent folder, so the user's own file loads as a Project file
	// for any repo under the home folder: order #133's first action read an unrelated README from it. claudeMdExcludes
	// is matched against absolute paths, so this skips that one file and leaves the repo's CLAUDE.md and AGENTS.md.
	const excludes = JSON.stringify({ claudeMdExcludes: [join(homedir(), ".claude", "CLAUDE.md")] });
	return ["--setting-sources", "project,local", "--settings", excludes, "--add-dir", home];
}
/**
 * A temp folder inside a directory kitchen agents may already use (`--add-dir` above). /tmp is outside it, so every
 * temp file an agent wrote there was refused and cost it a retry (order #116: Test and Review, 11 refusals). Opening
 * /tmp itself would also open other sessions' scratch files.
 */
export function kitchenTmp(): string {
	const dir = join(dataDir(), "kitchen-home", "tmp");
	try {
		mkdirSync(dir, { recursive: true });
	} catch {}
	return dir;
}
/** Chats the kitchen started: container agents ("Build · flisk 3125") and Ship agents ("Ship · #12"). */
export const KITCHEN_CHAT = /^(?:(?:Spec|Build|Test|Review) · .+ [0-9a-f]{4}|Ship · #\d+|Auto cooks · .+ [0-9a-f]{4}|Kitchen cooks [0-9a-f]{4})$/;

export type Pod = {
	id: string; // Stable id, never changes even when session is recycled. Used for strikes and serving.
	session: string;
	status: "starting" | "ready" | "evicted";
	strikes: number;
	served: number;
	started: number;
	/** Why it was fired, shown on its tombstone. */
	reason?: string;
	evictedAt?: number;
	/** The order it is working on: a different order gets a fresh chat. */
	lastOrder?: string;
	/** Skills its container gained when it was fired, so the agent after it starts better equipped. */
	gained?: string[];
	/** Its strikes went to the agent that took its place, so they are not handed on twice. */
	carried?: boolean;
};

/**
 * Skills a container gains when it fires an agent, on top of catalog skills that fit why it failed: a Build agent
 * fired for failing tests gets a checking and a debugging skill it did not have. Its own stage set is never repeated.
 */
export const FIRE_SKILLS: Partial<Record<Stage, string[]>> = {
	spec: ["tdd"],
	build: ["verification-loop", "systematic-debugging"],
	test: ["systematic-debugging", "tdd"],
	review: ["verification-loop", "systematic-debugging"],
};

/** The last lessons every container sharing this lessons key learned, oldest first, for an agent's order. */
export function lessonsFor(key: string, n = 5): string[] {
	return readContainers()
		.filter((c) => lessonsKeyOf(c) === key)
		.flatMap((c) => c.lessons)
		.filter((l) => l.kept || isLesson(l.reason))
		.sort((a, b) => a.at - b.at)
		.slice(-n)
		.map((l) => `${l.order}: ${clip(l.reason)}`);
}

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
	/** `kept`: a reason you typed when you fired an agent, kept even if it names no FAIL. */
	lessons: { at: number; order: string; reason: string; kept?: boolean }[];
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
		...(c.floorByHand ? { floorByHand: true } : {}),
		created: Date.now(),
	};
	store.write([...all, box]);
	// The lessons skill exists from the start, so a new agent can read it before its first strike.
	writeShared([...all, box], lessonsKeyOf(box), box.lessonsKey ? box.role : box.name);
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
		writeShared(all, lessonsKeyOf(c), c.lessonsKey ? c.role : c.name);
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

/**
 * A lesson names a mistake: a FAIL line, a miss or a stuck order. Refusals, and the half-sentences an earlier version
 * saved ("Ready.", "Let me check the build lessons"), are not lessons.
 */
export const isLesson = (reason: string) =>
	!REFUSAL.test(reason) && !NO_LESSON.test(reason.trim()) && /\b(FAIL|Missed|Stuck|fired by hand|Fired by hand)\b/.test(reason) && reason.trim().length >= 12;
/** Lines that say a step failed but not what was wrong: 16 of the 22 shared Build lessons were these (#234). */
const NO_LESSON = /^(?:Stuck after \d+ rounds\.?|(?:\*\*)?FAIL(?:\*\*)? in \w+ \(no reason given\)\.?)$/i;

/** Served orders after which a lesson that was never repeated stops applying (#335). */
export const LESSON_LIFE = 20;
/**
 * Retires old lessons: one that no order repeated (its newest copy counts) while `served` more orders
 * went through the board is dropped, so a lesson about code that has since changed does not stay in every brief for
 * ever. `served` lists when each order was served. A lesson you typed yourself (kept) stays until you clear it.
 */
export function retireLessons(served: number[], life = LESSON_LIFE): number {
	const same = (a: string, b: string) => a.toLowerCase().replace(/\s+/g, " ").trim() === b.toLowerCase().replace(/\s+/g, " ").trim();
	const stale = (all: Container[], c: Container) => {
		const mates = all.filter((x) => lessonsKeyOf(x) === lessonsKeyOf(c)).flatMap((x) => x.lessons);
		// A repeat renews a lesson: its age is the age of the newest lesson that says the same thing.
		return c.lessons.filter((l) => {
			const latest = Math.max(l.at, ...mates.filter((m) => same(m.reason, l.reason)).map((m) => m.at));
			return !l.kept && served.filter((t) => t > latest).length >= life;
		});
	};
	// Nothing to retire is the usual tick: do not rewrite the file for it.
	if (!store.read().some((c, _, all) => stale(all, c).length)) return 0;
	let dropped = 0;
	store.update((all) => {
		const keys = new Map<string, Container>();
		const gone = new Map(all.map((c) => [c, new Set(stale(all, c))] as const));
		for (const [c, g] of gone) {
			if (!g.size) continue;
			dropped += g.size;
			keys.set(lessonsKeyOf(c), c);
			c.lessons = c.lessons.filter((l) => !g.has(l));
		}
		for (const [key, c] of keys) writeShared(all, key, c.lessonsKey ? c.role : c.name);
	});
	return dropped;
}
/** The lessons skill a container reads and writes: shared by key, else its own. */
export const lessonsKeyOf = (c: Pick<Container, "slug" | "lessonsKey">) => c.lessonsKey ?? c.slug;
/** Rewrites one lessons skill from every container that shares its key. */
function writeShared(all: Container[], key: string, name: string) {
	// Old refusal lessons are dropped as they are rewritten, so they stop teaching agents to refuse.
	for (const x of all) x.lessons = x.lessons.filter((l) => l.kept || isLesson(l.reason));
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

/** The container and pod by the pod's stable id. Works after freshChat recycled the session. */
export const podById = (podId: string) => {
	for (const c of readContainers()) {
		const p = c.pods.find((x) => x.id === podId && x.status !== "evicted");
		if (p) return { container: c, pod: p };
	}
	return undefined;
};

/**
 * Gives a pod a strike for a failed or missed order. At maxStrikes it is fired: the reason becomes a lesson in the
 * container's skill, and the next reconcile replaces it. Returns the pod's new state.
 * Can pass either sessionId or podId: podId works even after freshChat recycles the session.
 */
/**
 * One strike on a pod, and its reason as the container's lesson (once per order and reason). `fire` fires it at once
 * (firing by hand), and `keep` keeps the reason as a lesson even if it names no FAIL: the reason you typed.
 */
export function strike(idOrSession: string, order: string, reason: string, o: { fire?: boolean; keep?: boolean; lessonOnly?: boolean } = {}): { container: string; pod: Pod; fired: boolean; gained: string[] } | undefined {
	return store.update((all) => {
		for (const c of all) {
			// Try to find by pod's stable id first, then by session (for backward compat).
			const p = c.pods.find((x) => (x.id === idOrSession || x.session === idOrSession) && x.status !== "evicted");
			if (!p) continue;
			if (!o.lessonOnly) p.strikes = o.fire ? Math.max(p.strikes + 1, c.maxStrikes) : p.strikes + 1;
			// A lesson is a mistake to avoid. Refusals ("too vague", "resubmit", "will not reopen") taught agents to
			// refuse more, so they count as a strike but are not kept as lessons.
			if ((o.keep || isLesson(reason)) && !c.lessons.some((l) => l.order === order && l.reason === reason)) c.lessons.push({ at: Date.now(), order, reason, ...(o.keep ? { kept: true } : {}) });
			const fired = p.strikes >= c.maxStrikes;
			let gained: string[] = [];
			if (fired) {
				Object.assign(p, { status: "evicted", reason: `${p.strikes} strikes. Last: ${reason}`.slice(0, 300), evictedAt: Date.now() });
				// The agent that replaces it starts with more skills than it had: its stage's fallbacks plus catalog skills
				// that fit what went wrong.
				const own = new Set(c.stages.flatMap((st) => STAGE_SKILLS[st]));
				const why = [...c.lessons.slice(-c.maxStrikes).map((l) => l.reason), reason].join("\n");
				gained = [...new Set([...c.stages.flatMap((st) => FIRE_SKILLS[st] ?? []), ...matchSkills(why, 2).map((s) => s.name)])]
					.filter((n) => !own.has(n) && !c.skills.includes(n) && SKILLS.some((s) => s.name === n))
					.slice(0, 3);
				c.skills = [...c.skills, ...gained];
				p.gained = gained;
			}
			writeShared(all, lessonsKeyOf(c), c.lessonsKey ? c.role : c.name);
			return { container: c.id, pod: { ...p }, fired, gained };
		}
		// The builder was already let go (the idle timer frees Build agents while their order is still in Test): its
		// container still learns the lesson, and the strike stays on its record (#240).
		for (const c of all) {
			const p = c.pods.find((x) => x.id === idOrSession && x.status === "evicted");
			if (!p) continue;
			if (!o.lessonOnly) p.strikes += 1;
			if ((o.keep || isLesson(reason)) && !c.lessons.some((l) => l.order === order && l.reason === reason)) c.lessons.push({ at: Date.now(), order, reason, ...(o.keep ? { kept: true } : {}) });
			writeShared(all, lessonsKeyOf(c), c.lessonsKey ? c.role : c.name);
			return { container: c.id, pod: { ...p }, fired: false, gained: [] };
		}
		return undefined;
	});
}

/**
 * Gives a pod a fresh chat for a new order: the pod (its strikes, its count of served orders) stays, its session
 * changes. Long chats mixed orders up ("Order #19 is stuck" in a reply to #21).
 */
export function freshChat(oldSession: string, newSession: string, order: string) {
	return store.update((all) => {
		for (const c of all) {
			const p = c.pods.find((x) => x.session === oldSession && x.status !== "evicted");
			if (!p) continue;
			Object.assign(p, { session: newSession, status: "starting", started: Date.now(), lastOrder: order });
			return true;
		}
		return false;
	});
}

/** The sidecar's injection: adds an order's skills to a container's set (the sidecar trims it later). */
export function injectSkills(id: string, skills: string[]) {
	store.update((all) => {
		const c = all.find((x) => x.id === id);
		if (c) c.skills = [...new Set([...c.skills, ...skills])];
	});
}

/** Records which order a pod is on. */
export function podOrder(session: string, order: string) {
	store.update((all) => {
		for (const c of all) for (const p of c.pods) if (p.session === session && p.status !== "evicted") p.lastOrder = order;
	});
}

export function served(idOrSession: string) {
	store.update((all) => {
		for (const c of all) for (const p of c.pods) if ((p.id === idOrSession || p.session === idOrSession) && p.status !== "evicted") p.served += 1;
	});
}

export type ReconcileCtx = {
	/** Sessions the board can see now: id, and whether it is closed. */
	sessions: { id: string; hidden?: boolean }[];
	/** Starts an agent; resolves when its first turn ends. */
	start: (n: { agent: "claude"; cwd: string; text: string; model?: string; effort?: string; id: string; role: string; mode?: string }) => void;
	/** Moves a fired agent to Closed on the board. */
	close: (id: string) => void;
	/** Names a pod on the board, so a container's agents are told apart from your own chats. */
	name?: (id: string, label: string) => void;
	/** Sets a pod's agent type on the board to its container's type. */
	type?: (id: string, role: string) => void;
	/** Chats that hold an order now: scaling down lets the others go first. */
	holding?: Set<string>;
	now?: number;
};

/** What a pod is called on the board and on the scoreboard: its container and a short id. */
export const podName = (c: Pick<Container, "name">, id: string) => `${c.name} ${id.slice(0, 4)}`;

/** The first prompt a new pod gets: who it is, and the lessons it must read. */
export function bootPrompt(c: Container) {
	return `You are a ${c.role} agent in the "${c.name}" agent container on the Run My Agents board. Orders for ${c.stages.join(", ")} will arrive as messages. Each order arrives in a chat of its own with everything it needs, the /${lessonsSkill(lessonsKeyOf(c))} lessons included, so do nothing now: reply with the one word "ready". Orders come from the kitchen's orchestrator, not from a person, and your replies go back to it: never ask the user anything.`;
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
				// "Never started" is for a pod still starting. A ready agent quiet for an hour drops off the board's list
				// (it shows chats changed in the last 60 minutes) and was evicted and booted again every hour (#244).
				if ((s?.hidden || (!s && p.status === "starting" && now - p.started > 10 * 60_000)) && p.status !== "evicted") {
					Object.assign(p, { status: "evicted", reason: s ? "Closed on the board" : "Never started", evictedAt: now });
					did.push(`${c.name}: ${p.session.slice(0, 8)} gone`);
				}
			}
			const pods = live(c);
			// Too many: let agents that hold no order go first, then the newest, the way a ReplicaSet scales down. Newest
			// alone fired the agent that had just taken an order (a fresh chat resets `started`) and kept the idle one (#242).
			const holds = (p: Pod) => Number(ctx.holding?.has(p.session) ?? false);
			for (const p of pods.sort((a, b) => holds(a) - holds(b) || b.started - a.started).slice(0, Math.max(0, pods.length - c.replicas))) {
				Object.assign(p, { status: "evicted", reason: c.downReason ?? "Scaled down", evictedAt: now });
				ctx.close(p.session);
				did.push(`${c.name}: scaled down ${p.session.slice(0, 8)}`);
			}
			// Too few: start fresh agents with the container's template.
			// Every container's lessons skill exists before its agents start, so none of them is told to read a missing one.
			if (!skillInstalled(lessonsSkill(lessonsKeyOf(c)))) writeShared(all, lessonsKeyOf(c), c.lessonsKey ? c.role : c.name);
			for (let i = live(c).length; i < c.replicas; i++) {
				const session = randomUUID();
				const podId = randomUUID(); // Stable id for strikes and serving, doesn't change when session is recycled.
				// An agent let go while it still had strikes (idle, scaled down, closed) hands them to the next one, so a
				// stage that keeps failing still reaches maxStrikes, gets fired and gains skills, instead of resetting to 0.
				const prev = c.pods
					.filter((p) => p.status === "evicted" && p.strikes > 0 && !p.carried && p.strikes < c.maxStrikes)
					.sort((a, b) => (a.evictedAt ?? 0) - (b.evictedAt ?? 0))
					.at(-1);
				if (prev) prev.carried = true;
				c.pods.push({ id: podId, session, status: "starting", strikes: prev?.strikes ?? 0, served: 0, started: now });
				ctx.name?.(session, podName(c, session));
				ctx.start({ agent: "claude", cwd: c.cwd, text: bootPrompt(c), model: c.model || "haiku", effort: c.effort || "low", id: session, role: c.role, mode: KITCHEN_MODE });
				did.push(`${c.name}: started ${session.slice(0, 8)}`);
			}
			// Keep the last 20 tombstones.
			const dead = c.pods.filter((p) => p.status === "evicted");
			if (dead.length > 20) c.pods = c.pods.filter((p) => p.status !== "evicted" || dead.slice(-20).includes(p));
		}
	});
	return did;
}
