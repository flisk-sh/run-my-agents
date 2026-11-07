// The agents board: every Claude Code, Codex and Grok Build session on this computer as an agent with a face, its
// channel, its tokens against the limit, and skills for its job. Local only; started by `flisk up` or the Mac app.
import { attachedBlock, isBucket, ownFiles, uploadDir } from "./uploads";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Pr } from "./desktop";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Hono } from "hono";
import { lowerModel, readLimits, setProjectModel, writeLimits } from "../../../../hooks/limits.mjs";
import { AGENTS } from "../../web/src/avatars";
import { PAGE } from "./page";
import { GEIST, GEIST_MONO } from "./fonts.generated";
import { addPending, applyHidden, applyNames, applyRoles, applyTune, dataDir, EFFORTS, forgetSession, MODES, readOrder, ROLES, setHidden, setName, setOrder, setPin, setRole, setTune, TUNE_MODELS } from "./prefs";
import { findClashes, guessRole, readAllSessions, type Session } from "./sessions";
import { KITCHEN_AGENTS } from "./kitchen/agents";
import { KITCHEN_CHAT, KITCHEN_TOOLS, kitchenFlags } from "./kitchen/containers";
import { mountKitchen } from "./kitchen/routes";
import { skillsFor } from "./kitchen/skills";

export { skillsFor };

/** The avatar for a session: always its role's own face and color (Code is blue, Design purple, ...). */
export function faceOf(s: Session) {
	const a = AGENTS.find((x) => x.role === s.role) ?? KITCHEN_AGENTS.find((x) => x.role === s.role) ?? (AGENTS.find((x) => x.role === "Code") as (typeof AGENTS)[number]);
	return { shape: a.shape, eyes: a.eyes, color: a.color, extra: a.extra };
}

/**
 * Writes come only from this page: a JSON body (which a cross-site form cannot send without a preflight this
 * server never answers) and, when the browser sends one, a localhost Origin.
 */
type Req = { req: { header: (n: string) => string | undefined } };
function localOrigin(c: Req): boolean {
	const origin = c.req.header("origin");
	return !origin || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}
function sameOrigin(c: Req): boolean {
	return (c.req.header("content-type") ?? "").startsWith("application/json") && localOrigin(c);
}

const MAX_FILE = 25 * 1024 * 1024;
/** A file name that is safe to put on disk and in a prompt: no folders, no odd characters. */
export function safeName(name: string): string {
	const base = basename(String(name).replace(/\\/g, "/")).replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").trim().slice(0, 120);
	return base || "file";
}

/** The page's font, Geist and Geist Mono by Vercel (SIL Open Font License), served from the app so it works offline. */
const FONTS = new Map<string, Buffer>([
	["geist.woff2", Buffer.from(GEIST, "base64")],
	["geist-mono.woff2", Buffer.from(GEIST_MONO, "base64")],
]);

/** Sessions with a message on its way, so a second send waits for the first reply. */
const sending = new Set<string>();

/**
 * Agent processes the board started, on disk: `sending` is in memory, and the live board restarts on every merge (it
 * runs under --watch) while its `claude -p` children keep running. After a restart every running step looked
 * finished at its first quiet gap, so Test started on half-built worktrees (#172). A chat is busy while its process
 * is alive; an entry older than RUNNING_MAX_MS is dropped, so a reused PID never holds a chat for good.
 */
const RUNNING_MAX_MS = 3 * 3_600_000;
const runningFile = () => join(dataDir(), "running.json");
const readRunning = (): Record<string, { pid: number; at: number }> => {
	try {
		return JSON.parse(readFileSync(runningFile(), "utf8"));
	} catch {
		return {};
	}
};
const writeRunning = (all: Record<string, { pid: number; at: number }>) => {
	try {
		mkdirSync(dataDir(), { recursive: true });
		writeFileSync(runningFile(), JSON.stringify(all));
	} catch {}
};
export function markRunning(id: string, pid: number | undefined) {
	if (!pid) return;
	writeRunning({ ...readRunning(), [id]: { pid, at: Date.now() } });
}
export function markDone(id: string, pid?: number) {
	const all = readRunning();
	if (!all[id] || (pid && all[id].pid !== pid)) return;
	delete all[id];
	writeRunning(all);
}
export function stillRunning(id: string): boolean {
	const r = readRunning()[id];
	if (!r) return false;
	try {
		if (Date.now() - r.at > RUNNING_MAX_MS) throw new Error("too old");
		process.kill(r.pid, 0);
		return true;
	} catch {
		markDone(id, r.pid);
		return false;
	}
}
/** Wraps spawn so the child is recorded as the running process of chat `id` until it exits. */
const tracked = (id: string, run: typeof spawn = spawn): typeof spawn =>
	((cmd: string, args: string[], opts: object) => {
		const child = run(cmd, args, opts);
		markRunning(id, child.pid);
		child.on?.("close", () => markDone(id, child.pid));
		return child;
	}) as typeof spawn;
const PROMPT_LIMIT = 20_000;

/**
 * Sends one message into an existing session, headless, the way FliskOS drives agents: Claude Code with
 * `claude -p --resume`, Codex with `codex exec resume`. The prompt goes on stdin, never into argv. The reply lands
 * in the session's own transcript, which the board already reads.
 */
/**
 * The folders a resumed copy of a session needs besides its own: the repositories it edited files in and the
 * folders its shell commands went into. The Claude app lets a session into extra folders, but `claude -p` starts
 * with only the session's own folder, so without these it is blocked from work it was already doing.
 */
export function workDirs(s: Session): string[] {
	const root = (p: string) => {
		for (let d = p; d !== dirname(d); d = dirname(d)) {
			try {
				if (statSync(join(d, ".git"))) return d;
			} catch {}
		}
		return p;
	};
	const own = s.cwd ? resolve(s.cwd) : "";
	const out = new Set<string>();
	for (const p of [...s.edits.map((e) => dirname(e.file)), ...(s.dirs ?? [])]) {
		const d = resolve(p);
		try {
			if (!statSync(d).isDirectory()) continue;
		} catch {
			continue;
		}
		const r = root(d);
		// never the whole home folder or the disk, only a project inside it
		if (r === homedir() || r === dirname(r)) continue;
		if (r !== own && !(own && (r + sep).startsWith(own + sep))) out.add(r);
	}
	return [...out].slice(-8);
}

/**
 * The permission mode a board message runs in: the one you picked for this session, else the mode the session itself
 * last ran in (so a Full access session stays Full access), else Auto-accept edits. A headless copy has no one to
 * approve a prompt, so a stricter mode than the session's only leaves it stuck on its first shell command. Plan mode
 * is not carried over: it would make the copy only plan.
 */
export function boardMode(s: Pick<Session, "tune" | "mode">): string {
	if (s.tune?.mode) return s.tune.mode;
	// A session in plan mode stays in plan mode: a board message never widens what the session itself chose.
	// "default" asks before each edit, which `claude -p` cannot do, so it runs in acceptEdits, the nearest that works.
	if (s.mode && s.mode !== "default") return s.mode;
	return "acceptEdits";
}

/** The model a resumed turn runs on: the one you picked on the board, else the session's own last model. */
export const boardModel = (s: Pick<Session, "tune" | "model" | "agent">): string | undefined => s.tune?.model || (s.agent === "claude" && /^claude-/.test(s.model ?? "") ? s.model : undefined);

/**
 * Grok Build has no stdin prompt mode (`-p`/`--resume` want the text as an argument), so the same "never put the
 * user's text in argv" rule is kept by writing it to a private temp file instead and passing `--prompt-file`. The
 * file is removed once the process ends, whichever way it ends.
 */
function runGrok(args: string[], text: string, cwd: string | undefined, run: typeof spawn): Promise<void> {
	const tmp = join(tmpdir(), `rma-grok-${randomUUID()}.txt`);
	writeFileSync(tmp, text, { mode: 0o600 });
	const cleanup = () => {
		try {
			rmSync(tmp, { force: true });
		} catch {}
	};
	return new Promise((resolve, reject) => {
		const child = run("grok", [...args, "--prompt-file", tmp], { cwd, stdio: ["ignore", "ignore", "ignore"], env: agentEnv() });
		child.on("error", (e) => {
			cleanup();
			reject(e);
		});
		child.on("close", () => {
			cleanup();
			resolve();
		});
	});
}

/**
 * The environment an agent CLI starts with: the board's own, minus what a Claude Code session that started the board
 * left in it. Inherited CLAUDECODE / CLAUDE_CODE_* variables make the child use its parent's host login, which stops
 * working when that session ends, so every agent failed with "Not logged in · Please run /login" (orders #39-#44).
 */
export function agentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([k]) => !/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PREVIEW_)/.test(k)));
}

export function sendToSession(s: Session, text: string, run = spawn, dirs: string[] = []): Promise<void> {
	dirs = [...dirs, ...workDirs(s)];
	// Grok has no `--add-dir`: a resumed copy only reaches its own folder.
	if (s.agent === "grok") return runGrok(["--cwd", s.cwd, "--resume", s.id, "--output-format", "json", "--permission-mode", boardMode(s)], text, s.cwd || undefined, run);
	const [cmd, args] =
		s.agent === "codex"
			? ["codex", ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "resume", s.id]]
			: ["claude", ["-p", "--resume", s.id, "--permission-mode", boardMode(s), ...(boardModel(s) ? ["--model", boardModel(s) as string] : []), ...(s.tune?.effort ? ["--effort", s.tune.effort] : []), ...dirs.flatMap((d) => ["--add-dir", d]), ...(KITCHEN_CHAT.test(s.title ?? "") ? [...kitchenFlags(), "--allowedTools", ...KITCHEN_TOOLS] : [])]];
	return new Promise((resolve, reject) => {
		const child = run(cmd, args as string[], { cwd: s.cwd || undefined, stdio: ["pipe", "ignore", "ignore"], env: agentEnv() });
		child.on("error", reject);
		child.on("close", () => resolve());
		child.stdin?.end(text);
	});
}

/** The board answers only to its own local names, so a DNS-rebound site cannot read transcripts or send prompts. */
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;


/** Linux terminal launchers in the order to try them; the session folder is the process cwd, or passed as a flag. */
function linuxTerminals(cwd: string): [string, string[]][] {
	return [
		...(process.env.TERMINAL ? [[process.env.TERMINAL, []] as [string, string[]]] : []),
		["x-terminal-emulator", []],
		["gnome-terminal", ["--working-directory", cwd]],
		["konsole", ["--workdir", cwd]],
		["xterm", ["-e", process.env.SHELL ?? "sh"]],
	];
}

/** Starts the first Linux terminal that is installed. A launcher that cannot start is skipped; resolves false when none can. */
async function openLinuxTerminal(cwd: string, run = spawn): Promise<boolean> {
	for (const [cmd, args] of linuxTerminals(cwd)) {
		const started = await new Promise<boolean | undefined>((resolveStart) => {
			const child = run(cmd, args, { cwd, stdio: "ignore" });
			child.on("error", () => resolveStart(undefined));
			child.on("spawn", () => resolveStart(true));
		});
		if (started !== undefined) return started;
	}
	return false;
}

/** Opens a session's folder in Finder, Terminal or VS Code. Resolves false when the app could not be opened. */
export function openIn(target: string, cwd: string, run = spawn): Promise<boolean> {
	const mac = process.platform === "darwin";
	if (target === "terminal" && process.platform === "linux") return openLinuxTerminal(cwd, run);
	const argv =
		target === "finder"
			? mac ? ["open", cwd] : ["xdg-open", cwd]
			: target === "terminal" && mac
				? ["open", "-a", "Terminal", cwd]
				: target === "vscode"
					? mac ? ["open", "-a", "Visual Studio Code", cwd] : ["code", cwd]
					: undefined;
	if (!argv) return Promise.resolve(false);
	return new Promise((resolveOpen) => {
		const child = run(argv[0], argv.slice(1), { stdio: "ignore" });
		child.on("error", () => resolveOpen(false));
		child.on("close", (code) => resolveOpen(code === 0));
	});
}

const prCache = new Map<string, { at: number; prs: Pr[]; asking?: boolean }>();

/** One word for a PR's CI: fail if any check failed, pending if any is still running, pass when all passed. */
export function checksOf(rollup: { conclusion?: string; state?: string; status?: string }[] | undefined): Pr["checks"] {
	if (!Array.isArray(rollup) || !rollup.length) return "";
	const word = (c: { conclusion?: string; state?: string; status?: string }) => String(c.conclusion || c.state || c.status || "").toUpperCase();
	const all = rollup.map(word);
	if (all.some((w) => /FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED|STARTUP_FAILURE/.test(w))) return "fail";
	if (all.some((w) => /PENDING|QUEUED|IN_PROGRESS|EXPECTED|WAITING|^$/.test(w))) return "pending";
	return "pass";
}

/** The Claude app's PRs for a session merged with GitHub's, GitHub's fields winning; newest first. */
export function mergePrs(...lists: Pr[][]): Pr[] {
	const byUrl = new Map<string, Pr>();
	for (const p of lists.flat()) {
		const old = byUrl.get(p.url);
		byUrl.set(p.url, old ? { ...old, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== "")) } : p);
	}
	return [...byUrl.values()].sort((a, b) => b.number - a.number);
}

/** What GitHub last said for a session's branch, without waiting; a stale answer is refreshed in the background. */
function cachedPrs(s: Session, get: typeof ghPrs): Pr[] {
	const hit = s.branch && s.cwd ? prCache.get(`${s.cwd}\u0000${s.branch}`) : undefined;
	if (s.branch && s.cwd && (!hit || Date.now() - hit.at > 60_000)) {
		// hold the old answer while asking, so 3-second polls do not start a gh call each
		prCache.set(`${s.cwd}\u0000${s.branch}`, { at: Date.now(), prs: hit?.prs ?? [], asking: true });
		get(s).catch(() => {});
	}
	return hit?.prs ?? [];
}

/** The pull requests GitHub has for a session's branch, asked of `gh` in the session's folder (cached for a minute). */
export async function ghPrs(s: Session, run = spawn): Promise<Pr[]> {
	const branch = s.branch;
	if (!branch || !/^\w[\w./-]{0,199}$/.test(branch) || branch === "main" || branch === "master" || !s.cwd) return [];
	const key = `${s.cwd}\u0000${branch}`;
	const hit = prCache.get(key);
	if (hit && !hit.asking && Date.now() - hit.at < 60_000) return hit.prs;
	const prs = await new Promise<Pr[]>((done) => {
		let out = "";
		let child: ReturnType<typeof spawn>;
		try {
			child = run("gh", ["pr", "list", "--head", branch, "--state", "all", "--limit", "6", "--json", "number,title,state,url,isDraft,statusCheckRollup,reviewDecision,mergeStateStatus"], { cwd: s.cwd, stdio: ["ignore", "pipe", "ignore"] });
		} catch {
			return done([]);
		}
		const timer = setTimeout(() => {
			child.kill();
			done([]);
		}, 6000);
		child.stdout?.on("data", (d) => {
			out += d;
		});
		child.on("error", () => {
			clearTimeout(timer);
			done([]);
		});
		child.on("close", () => {
			clearTimeout(timer);
			try {
				const rows = JSON.parse(out) as { number: number; title: string; state: string; url: string; isDraft?: boolean; statusCheckRollup?: { conclusion?: string; state?: string; status?: string }[]; reviewDecision?: string; mergeStateStatus?: string }[];
				done(
					rows.flatMap((r) =>
						Number.isInteger(r.number) && /^https:\/\//.test(String(r.url))
							? [{ number: r.number, title: String(r.title ?? ""), state: String(r.state ?? "").toUpperCase(), url: r.url, repo: /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(r.url)?.[1] ?? "", branch, draft: r.isDraft === true, checks: checksOf(r.statusCheckRollup), review: String(r.reviewDecision ?? ""), merge: String(r.mergeStateStatus ?? "") }]
							: [],
					),
				);
			} catch {
				done([]);
			}
		});
	});
	prCache.set(key, { at: Date.now(), prs });
	return prs;
}

/** A coding agent's own name, for messages. */
export const AGENT_LABEL: Record<Session["agent"], string> = { claude: "Claude Code", codex: "Codex", grok: "Grok Build" };

/** Which of the three coding agents the board can start are installed. */
export const installed = () => ({ claude: !!Bun.which("claude"), codex: !!Bun.which("codex"), grok: !!Bun.which("grok") });

/**
 * Grok Build quits with "Not signed in" before it creates a session, and the board starts it in the background, so
 * without this check a new Grok session never shows up and nothing says why. Signed in means an API key or auth.json.
 */
export function grokSignedIn(env: Record<string, string | undefined> = process.env): boolean {
	if (env.XAI_API_KEY) return true;
	try {
		return statSync(join(env.GROK_HOME || join(homedir(), ".grok"), "auth.json")).isFile();
	} catch {
		return false;
	}
}
const GROK_SIGN_IN = "Grok Build is not signed in. Run `grok login` in a terminal (or set XAI_API_KEY), then try again.";

export interface NewSession {
	agent: "claude" | "codex" | "grok";
	cwd: string;
	text: string;
	model?: string;
	effort?: string;
	/** Claude and Grok let the caller choose the session id, so the board knows it at once. */
	id?: string;
	/** Claude permission mode (kitchen agents: acceptEdits). */
	mode?: string;
	/** Tools allowed without asking (kitchen agents: KITCHEN_TOOLS). */
	allow?: string[];
	/** Folders outside cwd the agent may read, like the one its attached files are in (Claude only). */
	dirs?: string[];
}
const MODELS = ["opus", "sonnet", "haiku"];

/** Starts a new headless session in a folder; the prompt goes on stdin (a temp file for Grok). Its transcript is read like any other. */
/**
 * The kitchen's front desk: one short Claude call on Haiku at low effort that answers a question. It runs with no
 * session saved, no tools, no project settings and gives up after 90 seconds (about 6 s for a simple question).
 */
const FRONT_DESK_PROMPT = "You are the front desk of a team of coding agents. Answer the user's question in one or two short sentences. A question about the project (its code, \"this repo\") is answered from its files: read them with Read, Grep and Glob, never from the web. When you have web search, use it for anything that needs live information and name the source. If it needs code changes, say it should be sent as a task.";

export function askHaiku(question: string, cwd: string, run = spawn, web = false, skills = "", system = FRONT_DESK_PROMPT): Promise<string> {
	return new Promise((resolveAsk, reject) => {
		// A clean, light start: no project folder, settings, MCP servers or skills, and its own short system prompt,
		// so it answers in seconds as the front desk instead of as whatever agent the folder describes.
		// Read-only tools on the question's own folder: "what does sum([]) return in this repo?" was answered by searching
		// GitHub for a public repo of that name (#95), because the desk could read nothing on this computer.
		const local = cwd && existsSync(cwd) ? ["Read", "Grep", "Glob"] : [];
		const tools = [...(web ? ["WebSearch", "WebFetch"] : []), ...local].join(",");
		const child = run("claude", ["-p", "--model", "haiku", "--effort", "low", "--no-session-persistence", ...(tools ? ["--tools", tools, "--allowedTools", tools] : ["--tools", ""]), ...(local.length ? ["--add-dir", cwd] : []), "--disable-slash-commands", "--strict-mcp-config", "--setting-sources", "", "--system-prompt", system, ...(skills ? ["--append-system-prompt", skills] : [])], { cwd: tmpdir(), stdio: ["pipe", "pipe", "ignore"], env: agentEnv() });
		let out = "";
		const timer = setTimeout(() => child.kill("SIGTERM"), web ? 120_000 : 90_000);
		child.stdout?.on("data", (d) => {
			out += String(d);
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0 && out.trim()) resolveAsk(out.trim().slice(0, 4000));
			else reject(new Error(`front desk exited with ${code}`));
		});
		child.stdin?.end(cwd ? `${question}\n\n(Asked about the project in ${cwd}.)` : question);
	});
}

export function startNewSession(n: NewSession, run = spawn): Promise<void> {
	if (n.agent === "grok") return runGrok(["--cwd", n.cwd, "--session-id", n.id as string, "--output-format", "json", "--permission-mode", "acceptEdits"], n.text, n.cwd, run);
	const [cmd, args] =
		n.agent === "codex"
			? ["codex", ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write"]]
			: ["claude", ["-p", "--session-id", n.id as string, "--permission-mode", n.mode && MODES.includes(n.mode) ? n.mode : "acceptEdits", ...(n.model ? ["--model", n.model] : []), ...(n.effort ? ["--effort", n.effort] : []), ...(n.allow?.length ? [...kitchenFlags(), "--allowedTools", ...n.allow] : []), ...(n.dirs ?? []).flatMap((d) => ["--add-dir", d])]];
	return new Promise((resolveStart, reject) => {
		const child = run(cmd, args as string[], { cwd: n.cwd, stdio: ["pipe", "ignore", "ignore"], env: agentEnv() });
		child.on("error", reject);
		child.on("close", () => resolveStart());
		child.stdin?.end(n.text);
	});
}

/** Changes whenever the page changes, so an open page knows to reload itself (hot reload under `bun run dev`). */
const BUILD = Bun.hash(PAGE).toString(36);

/** The http(s) links in a transcript's messages, newest first, each once. Tool calls and their output are left out. */
export function chatLinks(file: string): { url: string; host: string; who: "you" | "agent"; at?: string }[] {
	let raw = "";
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const seen = new Map<string, { url: string; host: string; who: "you" | "agent"; at?: string }>();
	for (const line of raw.split("\n")) {
		if (!line.includes("http")) continue;
		let j: { type?: string; timestamp?: string; message?: { role?: string; content?: unknown } };
		try {
			j = JSON.parse(line);
		} catch {
			continue;
		}
		const role = j.message?.role ?? j.type;
		if (role !== "user" && role !== "assistant") continue;
		const content = j.message?.content;
		const texts = typeof content === "string" ? [content] : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")) : [];
		for (const t of texts)
			for (const m of t.matchAll(/https?:\/\/[^\s<>"'`)\]}|]+/g)) {
				const url = m[0].replace(/[.,;:!?*_]+$/, "");
				let host = "";
				try {
					host = new URL(url).host;
				} catch {
					continue;
				}
				seen.delete(url);
				seen.set(url, { url, host, who: role === "user" ? "you" : "agent", at: j.timestamp });
			}
	}
	return [...seen.values()].reverse().slice(0, 60);
}

const linkCounts = new Map<string, { key: string; n: number }>();
/** How many links a transcript's messages hold; re-read only when the file changes. */
export function linkCount(file: string): number {
	let key = "";
	try {
		const st = statSync(file);
		key = `${st.mtimeMs}:${st.size}`;
	} catch {
		return 0;
	}
	const hit = linkCounts.get(file);
	if (hit?.key === key) return hit.n;
	const n = chatLinks(file).length;
	linkCounts.set(file, { key, n });
	return n;
}

const previewCache = new Map<string, { at: number; card: LinkCard }>();
type LinkCard = { url: string; title?: string; description?: string; image?: string; site?: string; error?: string };
/** Reads a page's title, description and image from its meta tags. Cached for 10 minutes; gives up after 6 seconds. */
export async function linkPreview(url: string, get: typeof fetch = fetch): Promise<LinkCard> {
	const hit = previewCache.get(url);
	if (hit && Date.now() - hit.at < 600_000) return hit.card;
	let card: LinkCard;
	try {
		const r = await get(url, { redirect: "follow", signal: AbortSignal.timeout(6000), headers: { "user-agent": "Mozilla/5.0 (run-my-agents link preview)", accept: "text/html" } });
		const html = (await r.text()).slice(0, 400_000);
		const meta = (k: string) => {
			const re = new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*>`, "i");
			const tag = html.match(re)?.[0];
			return tag?.match(/content=["']([^"']*)["']/i)?.[1];
		};
		const un = (x?: string) => x?.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim() || undefined;
		let image = un(meta("og:image") ?? meta("twitter:image"));
		if (image) image = new URL(image, r.url || url).href;
		card = {
			url,
			title: un(meta("og:title") ?? meta("twitter:title") ?? html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]),
			description: un(meta("og:description") ?? meta("twitter:description") ?? meta("description"))?.slice(0, 300),
			image,
			site: un(meta("og:site_name")) ?? new URL(url).host,
		};
	} catch {
		card = { url, site: new URL(url).host, error: "Could not load this page." };
	}
	previewCache.set(url, { at: Date.now(), card });
	return card;
}

export function createApp(
	read = () => applyNames(applyTune(applyRoles(applyHidden(readAllSessions())))),
	send = sendToSession,
	deps: { agent?: import("./kitchen/routes").AgentCall; fetch?: typeof fetch; ask?: (q: string, cwd: string, o?: { web?: boolean; skills?: string; system?: string }) => Promise<string>; kitchenEvery?: number; start?: typeof startNewSession; which?: typeof installed; open?: typeof openIn; prs?: typeof ghPrs; grokAuth?: () => boolean } = {},
) {
	const grokAuth = deps.grokAuth ?? grokSignedIn;
	const start = deps.start ?? startNewSession;
	const which = deps.which ?? installed;
	const open = deps.open ?? openIn;
	const prsFor = deps.prs ?? ghPrs;
	const app = new Hono();
	type Queued = { qid: string; text: string; body: string; dirs: string[] };
	/** Messages waiting for a busy session, oldest first. */
	const queues = new Map<string, Queued[]>();
	/** The reply the board is running for each session, so Send now can stop it. */
	const running = new Map<string, ChildProcess>();
	// A message from here starts a second copy of the session. If the Claude app is working in it right now, the
	// two would run on the same conversation at once, so wait for it to settle.
	const appBusy = (s: Session) => s.viaApp === true && !s.awaiting && Date.now() - s.updatedAt < 20_000;
	// After a board restart the in-memory `sending` set is wiped. A session that was mid-turn still appears not busy.
	// If its last update was recent and its last feed item is from the agent, it's likely still running.
	// Only for chats this board did not start or message since it came up: for its own, `sending` knows. A parsed turn
	// is one feed item with all its tool calls, so every finished step "had tool calls" and looked mid-turn for 30 s,
	// which held each order 30 s after every step (#45-#47 spent ~2 of their 7-8 minutes on it).
	const launched = new Set<string>();
	const likelyMidTurn = (s: Session) => {
		if (launched.has(s.id)) return false;
		if (Date.now() - s.updatedAt > 30_000) return false; // older than 30 seconds is unlikely to be mid-turn
		const last = s.feed[s.feed.length - 1];
		return last?.who === "agent" && (last?.tools?.length ?? 0) > 0; // agent's last message had tool calls
	};
	let kick: (() => void) | undefined;
	const sendNow = (s: Session, item: Queued) => {
		if (appBusy(s)) return new Response(JSON.stringify({ error: `${s.role} is working in the Claude app right now. Wait for it to finish, or message it there.` }), { status: 409, headers: { "content-type": "application/json" } });
		running.get(s.id)?.kill("SIGINT");
		const run = ((cmd: string, args: string[], opts: object) => {
			const child = tracked(s.id)(cmd, args, opts);
			running.set(s.id, child);
			return child;
		}) as typeof spawn;
		const turn = Symbol();
		turns.set(s.id, turn);
		sending.add(s.id);
		launched.add(s.id);
		send(s, item.body, run, item.dirs)
			.catch((e) => console.error(`send to ${s.id} failed:`, e))
			.finally(() => {
				if (turns.get(s.id) !== turn) return;
				sending.delete(s.id);
				running.delete(s.id);
				drain(s.id);
				// The kitchen moves the order on as soon as the agent's quiet window has passed, not on the next tick.
				if (kick) setTimeout(kick, 3_200).unref?.();
			});
		return new Response(JSON.stringify({ sent: true }), { status: 202, headers: { "content-type": "application/json" } });
	};
	const turns = new Map<string, symbol>();
	const drain = (id: string) => {
		const q = queues.get(id);
		const s = q?.length && !sending.has(id) ? read().find((x) => x.id === id) : undefined;
		if (!s || !q || appBusy(s)) return;
		queues.set(id, q.slice(1));
		sendNow(s, q[0]);
	};
	// A queue that waits on the Claude app has nothing to wake it, so look again every few seconds.
	setInterval(() => {
		for (const id of queues.keys()) drain(id);
	}, 3_000).unref?.();
	app.use("*", async (c, next) => {
		if (!LOCAL_HOST.test(c.req.header("host") ?? new URL(c.req.url).host)) return c.text("Open the board at http://localhost.", 403);
		await next();
	});
	app.get("/health", (c) => c.json({ status: "ok", service: "board" }));
	app.get("/ready", (c) => c.json({ ready: true }));
	app.get("/api/sessions", (c) => {
		const sessions = read();
		const limits = readLimits();
		return c.json({
			sessions: sessions.map(({ file, ...s }) => ({
				...s,
				face: faceOf(s),
				lower: s.agent === "claude" ? lowerModel(s.tune?.model || s.model) : null,
				skills: skillsFor(s.role),
				sending: sending.has(s.id),
				prs: mergePrs(s.prs ?? [], cachedPrs(s, prsFor)),
				links: file ? linkCount(file) : 0,
				queue: (queues.get(s.id) ?? []).map(({ qid, text }) => ({ qid, text })),
			})),
			clashes: findClashes(sessions),
			limits,
			order: readOrder(),
			build: BUILD,
		});
	});
	// UMUX-Lite: two 1-7 questions about the board, kept on this computer, so changes can be measured.
	const umuxFile = () => join(dataDir(), "umux.json");
	const readUmux = (): { at: number; q1: number; q2: number }[] => {
		try {
			const a = JSON.parse(readFileSync(umuxFile(), "utf8"));
			return Array.isArray(a) ? a.filter((r) => r && [r.q1, r.q2].every((q) => Number.isInteger(q) && q >= 1 && q <= 7)).slice(-200) : [];
		} catch {
			return [];
		}
	};
	app.get("/api/umux", (c) => c.json({ ratings: readUmux() }));
	app.post("/api/umux", async (c) => {
		if (!sameOrigin(c)) return c.json({ error: "Send JSON from the board." }, 403);
		const { q1, q2 } = (await c.req.json().catch(() => ({}))) as { q1?: number; q2?: number };
		if (![q1, q2].every((q) => Number.isInteger(q) && (q as number) >= 1 && (q as number) <= 7)) return c.json({ error: "Answer both questions from 1 to 7." }, 400);
		const all = [...readUmux(), { at: Date.now(), q1: q1 as number, q2: q2 as number }];
		mkdirSync(dataDir(), { recursive: true });
		writeFileSync(umuxFile(), JSON.stringify(all.slice(-200), null, 2));
		return c.json({ ratings: all });
	});
	app.post("/api/limits", async (c) => {
		if (!sameOrigin(c)) return c.json({ error: "Send JSON from the board." }, 403);
		return c.json(writeLimits(await c.req.json().catch(() => ({}))));
	});
	// Moves a Claude project's new sessions one step down the model ladder. Never up: the target is computed
	// here from the session's own model, not taken from the request.
	app.post("/api/downgrade", async (c) => {
		if (!sameOrigin(c)) return c.json({ error: "Send JSON from the board." }, 403);
		const { id } = (await c.req.json().catch(() => ({}))) as { id?: string };
		const s = read().find((x) => x.id === id && x.agent === "claude");
		const lower = s ? lowerModel(s.tune?.model || s.model) : null;
		if (!s || !s.cwd || !lower) return c.json({ error: "No cheaper model for this session." }, 400);
		const file = setProjectModel(s.cwd, lower);
		if (!file) return c.json({ error: "That session's folder is gone." }, 400);
		// This session too: the board's next message to it runs on the cheaper model.
		setTune(s.id, { model: lower });
		return c.json({ model: lower, file, next: lowerModel(lower) });
	});
	app.post("/api/send", async (c) => {
		if (!sameOrigin(c)) return c.json({ error: "Send JSON from the board." }, 403);
		const { id, text, files, now } = (await c.req.json().catch(() => ({}))) as { id?: string; text?: string; files?: unknown; now?: boolean };
		const message = String(text ?? "").trim();
		if (!message && !(Array.isArray(files) && files.length)) return c.json({ error: "Type a message first." }, 400);
		if (message.length > PROMPT_LIMIT) return c.json({ error: "That message is too long." }, 400);
		const s = read().find((x) => x.id === id);
		if (!s) return c.json({ error: "That session is gone." }, 404);
		if (s.agent === "grok" && !grokAuth()) return c.json({ error: GROK_SIGN_IN }, 400);
		// Only files this board saved for this session can be attached, however the request names them.
		const dir = uploadDir(s.id);
		const attached = ownFiles(files, dir);
		const body = `${message || (attached.length ? "Please look at the attached files." : "")}${attachedBlock(attached)}`;
		const item = { qid: randomUUID(), text: message || "(attached files)", body, dirs: attached.length ? [dir] : [] };
		// Like Claude: a message to a busy session waits in its queue, unless you ask to send it now.
		if (!now && (sending.has(s.id) || appBusy(s))) {
			queues.set(s.id, [...(queues.get(s.id) ?? []), item]);
			return c.json({ queued: true, qid: item.qid }, 202);
		}
		return sendNow(s, item);
	});
	// Sends a queued message at once, stopping the reply the board is running for that session.
	app.post("/api/queue/now", async (c) => {
		if (!sameOrigin(c)) return c.json({ error: "Send JSON from the board." }, 403);
		const { id, qid } = (await c.req.json().catch(() => ({}))) as { id?: string; qid?: string };
		const s = read().find((x) => x.id === id);
		const item = queues.get(String(id))?.find((q) => q.qid === qid);
		if (!s || !item) return c.json({ error: "That message is gone." }, 404);
		const res = sendNow(s, item);
		if (res.status === 202) queues.set(s.id, (queues.get(s.id) ?? []).filter((q) => q.qid !== qid));
		return res;
	});
	app.post("/api/queue/drop", async (c) => {
		if (!sameOrigin(c)) return c.json({ error: "Send JSON from the board." }, 403);
		const { id, qid } = (await c.req.json().catch(() => ({}))) as { id?: string; qid?: string };
		queues.set(String(id), (queues.get(String(id)) ?? []).filter((q) => q.qid !== qid));
		return c.json({ dropped: true });
	});
	// What the New session dialog and the type picker need: installed agents, recent folders, the types and faces.
	app.get("/api/options", (c) => {
		const have = which();
		const sessions = read();
		const latest = sessions[0]?.agent;
		const defaultAgent = latest && have[latest] ? latest : have.claude ? "claude" : have.codex ? "codex" : "claude";
		return c.json({
			agents: have,
			defaultAgent,
			folders: [...new Set(sessions.map((s) => s.cwd).filter(Boolean))].slice(0, 8),
			roles: AGENTS.map((a) => ({ role: a.role, color: a.color, shape: a.shape, eyes: a.eyes })),
		});
	});
	// Detects the agent type (and, if the text names it, the AI) from what you typed.
	app.get("/api/detect", (c) => {
		const text = c.req.query("text") ?? "";
		const have = which();
		const agent = /\b(codex|gpt|openai)\b/i.test(text) && have.codex ? "codex" : /\b(grok|xai|x\.ai)\b/i.test(text) && have.grok ? "grok" : null;
		return c.json({ role: guessRole(text, []), agent });
	});
	// Gives an existing session a type, or with an empty role goes back to the board's guess.
	app.post("/api/role", async (c) => {
		if (!sameOrigin(c)) return c.json({ error: "Send JSON from the board." }, 403);
		const { id, role } = (await c.req.json().catch(() => ({}))) as { id?: string; role?: string };
		if (!id || !/^[\w-]{1,80}$/.test(id)) return c.json({ error: "Unknown session." }, 400);
		if (role && !ROLES.includes(role)) return c.json({ error: "Unknown agent type." }, 400);
		setRole(id, role || null);
		return c.json({ id, role: role || null });
	});
	// Gives an existing session a name you typed, or with an empty name goes back to its own title.
	app.post("/api/name", async (c) => {
		if (!sameOrigin(c)) return c.json({ error: "Send JSON from the board." }, 403);
		const { id, name } = (await c.req.json().catch(() => ({}))) as { id?: string; name?: string };
		if (!id || !/^[\w-]{1,80}$/.test(id)) return c.json({ error: "Unknown session." }, 400);
		const clean = String(name ?? "").trim();
		if (clean.length > 120) return c.json({ error: "Keep the name under 120 characters." }, 400);
		if (!read().some((x) => x.id === id)) return c.json({ error: "That session is gone." }, 404);
		setName(id, clean || null);
		const s = read().find((x) => x.id === id);
		return c.json({ id, titleSet: !!clean, title: s?.title ?? clean });
	});
	// Saves a file you attach, outside your projects, in ~/.run-my-agents/uploads/<session>/. The body is the raw file.
	app.post("/api/upload", async (c) => {
		if (c.req.header("x-run-my-agents") !== "1" || !localOrigin(c)) return c.json({ error: "Upload from the board." }, 403);
		const id = c.req.query("id") ?? "";
		if (!/^[\w-]{1,128}$/.test(id)) return c.json({ error: "Unknown session." }, 400);
		// "new" and "order" are for a session or an order that does not exist yet (see uploads.ts).
		if (!isBucket(id) && !read().some((x) => x.id === id)) return c.json({ error: "That session is gone." }, 404);
		if (Number(c.req.header("content-length") ?? 0) > MAX_FILE) return c.json({ error: "That file is over 25 MB." }, 413);
		const bytes = new Uint8Array(await c.req.arrayBuffer());
		if (!bytes.length) return c.json({ error: "That file is empty." }, 400);
		if (bytes.length > MAX_FILE) return c.json({ error: "That file is over 25 MB." }, 413);
		const dir = uploadDir(id);
		mkdirSync(dir, { recursive: true });
		const name = safeName(c.req.query("name") ?? "");
		const path = join(dir, `${Date.now().toString(36)}-${name}`);
		writeFileSync(path, bytes, { mode: 0o600 });
		return c.json({ path, name, size: bytes.length });
	});
	app.get("/fonts/:file", (c) => {
		const font = FONTS.get(c.req.param("file"));
		if (!font) return c.notFound();
		return c.body(font as unknown as Uint8Array<ArrayBuffer>, 200, { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" });
	});
	// The order you dragged your agents into.
	app.post("/api/order", async (c) => {
		if (!sameOrigin(c)) return c.json({ error: "Send JSON from the board." }, 403);
		const { ids } = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
		if (!Array.isArray(ids)) return c.json({ error: "Send a list of session ids." }, 400);
		setOrder(ids.map(String));
		return c.json({ ok: true });
	});
	// The pull requests for a session's branch: the ones the Claude app attached, plus what GitHub has for the branch.
	app.get("/api/prs", async (c) => {
		const s = read().find((x) => x.id === c.req.query("id"));
		if (!s) return c.json({ error: "That session is gone." }, 404);
		return c.json({ branch: s.branch, prs: mergePrs(s.prs ?? [], await prsFor(s)) });
	});
	// The web links said in a session's chat (yours and the agent's messages, not tool output), newest first.
	app.get("/api/links", (c) => {
		const s = read().find((x) => x.id === c.req.query("id"));
		if (!s) return c.json({ error: "That session is gone." }, 404);
		return c.json({ links: s.file ? chatLinks(s.file) : [] });
	});
	// A small card for a link: the page's title, description and image, read from its meta tags.
	app.get("/api/preview", async (c) => {
		const url = c.req.query("url") ?? "";
		if (!/^https?:\/\//i.test(url)) return c.json({ error: "Only web links have a preview." }, 400);
		return c.json(await linkPreview(url, deps.fetch ?? fetch));
	});
	// Close: hides a session from the list (it stays under Closed). Nothing is deleted.
	app.post("/api/hide", async (c) => {
		if (!sameOrigin(c)) return c.json({ error: "Send JSON from the board." }, 403);
		const { id, hidden } = (await c.req.json().catch(() => ({}))) as { id?: string; hidden?: boolean };
		if (!id || !/^[\w-]{1,128}$/.test(id) || typeof hidden !== "boolean") return c.json({ error: "Unknown session." }, 400);
		setHidden(id, hidden);
		return c.json({ id, hidden });
	});
	// Delete: removes the session's transcript for good. Only for sessions the Claude app does not list (the app would
	// be left with a session it cannot open), never one that is working, and only a file inside the agent's own folder.
	app.post("/api/delete", async (c) => {
		if (!sameOrigin(c)) return c.json({ error: "Send JSON from the board." }, 403);
		const { id } = (await c.req.json().catch(() => ({}))) as { id?: string };
		const s = read().find((x) => x.id === id);
		if (!s) return c.json({ error: "That session is gone." }, 404);
		if (s.viaApp === true) return c.json({ error: "This session is in the Claude app. Delete it there." }, 400);
		if (Date.now() - s.updatedAt < 60_000) return c.json({ error: `${s.role} is working right now. Try again in a minute.` }, 409);
		const base = resolve(
			s.agent === "codex"
				? process.env.CODEX_SESSIONS_DIR || join(homedir(), ".codex", "sessions")
				: s.agent === "grok"
					? process.env.GROK_SESSIONS_DIR || join(homedir(), ".grok", "sessions")
					: process.env.CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects"),
		);
		const file = s.file ? resolve(s.file) : "";
		if (!file.endsWith(".jsonl") || !file.startsWith(base + sep)) return c.json({ error: "Can't find that session's file." }, 400);
		try {
			unlinkSync(file);
		} catch {
			return c.json({ error: "Could not delete that session's file." }, 500);
		}
		if (s.agent === "claude") rmSync(join(dirname(file), s.id), { recursive: true, force: true });
		// A Grok session is its own folder (chat_history.jsonl plus summary.json, usage.json, ...): remove all of it.
		if (s.agent === "grok") rmSync(dirname(file), { recursive: true, force: true });
		forgetSession(s.id);
		return c.json({ deleted: true });
	});
	// Pins in the board. The Claude app's own pins show too; unpinning here hides one on this board only.
	app.post("/api/pin", async (c) => {
		if (!sameOrigin(c)) return c.json({ error: "Send JSON from the board." }, 403);
		const { id, pinned } = (await c.req.json().catch(() => ({}))) as { id?: string; pinned?: boolean };
		if (!id || !/^[\w-]{1,128}$/.test(id) || typeof pinned !== "boolean") return c.json({ error: "Unknown session." }, 400);
		setPin(id, pinned);
		return c.json({ id, pinned });
	});
	app.post("/api/open", async (c) => {
		if (!sameOrigin(c)) return c.json({ error: "Send JSON from the board." }, 403);
		const { id, target } = (await c.req.json().catch(() => ({}))) as { id?: string; target?: string };
		const s = read().find((x) => x.id === id);
		if (!s?.cwd) return c.json({ error: "That session has no folder." }, 404);
		try {
			if (!statSync(s.cwd).isDirectory()) throw new Error("not a folder");
		} catch {
			return c.json({ error: "That folder does not exist any more." }, 404);
		}
		const names: Record<string, string> = { finder: "Finder", terminal: "Terminal", vscode: "VS Code" };
		if (!(await open(String(target), s.cwd))) return c.json({ error: `Could not open ${names[String(target)] ?? "that"}.` }, 400);
		return c.json({ opened: true });
	});
	// The model and effort the board uses for messages it sends to a Claude Code agent. "" clears one.
	app.post("/api/tune", async (c) => {
		if (!sameOrigin(c)) return c.json({ error: "Send JSON from the board." }, 403);
		const { id, model, effort, mode } = (await c.req.json().catch(() => ({}))) as { id?: string; model?: string; effort?: string; mode?: string };
		const s = read().find((x) => x.id === id);
		if (!s) return c.json({ error: "That session is gone." }, 404);
		if (s.agent !== "claude") return c.json({ error: "Model and effort apply to Claude Code agents." }, 400);
		if (model === undefined && effort === undefined && mode === undefined) return c.json({ error: "Pick a model, an effort level or a mode." }, 400);
		if (mode && !MODES.includes(mode)) return c.json({ error: "Pick Supervised, Auto-accept edits, Auto or Full access." }, 400);
		if (model && !TUNE_MODELS.includes(model)) return c.json({ error: "Pick haiku, sonnet or opus." }, 400);
		if (effort && !EFFORTS.includes(effort)) return c.json({ error: "Pick low, medium, high, xhigh or max." }, 400);
		return c.json(setTune(s.id, { model, effort, mode }));
	});
	app.post("/api/new", async (c) => {
		if (!sameOrigin(c)) return c.json({ error: "Send JSON from the board." }, 403);
		const b = (await c.req.json().catch(() => ({}))) as { agent?: string; cwd?: string; text?: string; role?: string; model?: string; effort?: string; files?: unknown };
		const attached = ownFiles(b.files, uploadDir("new"));
		const asked = String(b.text ?? "").trim();
		const text = asked && attached.length ? `${asked}${attachedBlock(attached)}` : asked;
		if (!text) return c.json({ error: "Describe the task first." }, 400);
		if (text.length > PROMPT_LIMIT) return c.json({ error: "That message is too long." }, 400);
		if (b.agent !== "claude" && b.agent !== "codex" && b.agent !== "grok") return c.json({ error: "Pick Claude Code, Codex or Grok Build." }, 400);
		if (!which()[b.agent]) return c.json({ error: `${AGENT_LABEL[b.agent]} is not installed on this computer.` }, 400);
		if (b.agent === "grok" && !grokAuth()) return c.json({ error: GROK_SIGN_IN }, 400);
		if (b.role && !ROLES.includes(b.role)) return c.json({ error: "Unknown agent type." }, 400);
		const cwd = resolve(String(b.cwd ?? ""));
		try {
			if (!b.cwd || !statSync(cwd).isDirectory()) throw new Error("not a folder");
		} catch {
			return c.json({ error: "That folder does not exist." }, 400);
		}
		const model = b.agent === "claude" && b.model && MODELS.includes(b.model) ? b.model : undefined;
		const effort = b.agent === "claude" && b.effort && EFFORTS.includes(b.effort) ? b.effort : undefined;
		// Claude and Grok both take a caller-chosen id for a new session; Codex always picks its own.
		const id = b.agent === "claude" || b.agent === "grok" ? randomUUID() : undefined;
		if (b.role) {
			if (id) setRole(id, b.role);
			else addPending({ agent: b.agent, cwd, prefix: (text.split("\n")[0] ?? "").slice(0, 40), role: b.role });
		}
		// Its first turn can take minutes: until it ends, a follow-up would start a second copy of the same session.
		if (id) sending.add(id);
		start({ agent: b.agent, cwd, text, model, effort, id, ...(attached.length ? { dirs: [uploadDir("new")] } : {}) })
			.catch((e) => console.error("start failed:", e))
			.finally(() => {
				if (id) sending.delete(id);
			});
		return c.json({ started: true, id }, 202);
	});
	// The kitchen: orders, scores, skill sets and agent containers. See src/kitchen/.
	const kitchen = mountKitchen(app, {
		read,
		// A kitchen message to a busy chat waits in its queue, like yours: sending it at once stopped the reply that chat
		// was running (an agent asking your own chat a question cut off your turn).
		send: (s, text, body) => {
			const item = { qid: randomUUID(), text, body, dirs: [] };
			if (!sending.has(s.id) && !appBusy(s)) return sendNow(s, item);
			queues.set(s.id, [...(queues.get(s.id) ?? []), item]);
			return new Response(JSON.stringify({ queued: true, qid: item.qid }), { status: 202, headers: { "content-type": "application/json" } });
		},
		busy: (s) => sending.has(s.id) || appBusy(s) || stillRunning(s.id) || likelyMidTurn(s),
		start: (n) => {
			setRole(n.id, n.role);
			sending.add(n.id);
			launched.add(n.id);
			start({ agent: n.agent, cwd: n.cwd, text: n.text, model: n.model, effort: n.effort, id: n.id, mode: n.mode, allow: KITCHEN_TOOLS }, tracked(n.id as string))
				.catch((e) => console.error("container start failed:", e))
				.finally(() => sending.delete(n.id));
		},
		tune: (id, t) => setTune(id, t),
		close: (id) => setHidden(id, true),
		name: (id, label) => setName(id, label),
		type: (id, role) => setRole(id, role),
		agent: deps.agent,
		ask: deps.ask ?? (deps.kitchenEvery ? (q, cwd, o) => askHaiku(q, cwd, spawn, !!o?.web, o?.skills ?? "", o?.system) : undefined),
		guessRole: (title) => guessRole(title, []),
		sameOrigin,
		fetch: deps.fetch,
		promptLimit: PROMPT_LIMIT,
		every: deps.kitchenEvery ?? 0,
	});
	if (deps.kitchenEvery) kick = () => kitchen.tick();
	// The page is one document with its script inline, so a cached copy keeps running yesterday's
	// script against today's API. The board restarts on every edit; never let a tab hold the old one.
	app.get("/", (c) => c.html(PAGE, 200, { "cache-control": "no-store" }));
	return app;
}

if (import.meta.main) {
	const port = Number(process.env.PORT || 4100);
	Bun.serve({ port, hostname: "127.0.0.1", fetch: createApp(undefined, undefined, { kitchenEvery: 3_000 }).fetch });
	console.log(`Run My Agents board on http://localhost:${port}`);
}
