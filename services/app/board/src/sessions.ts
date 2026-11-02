// Reads the Claude Code sessions on this computer from ~/.claude/projects/*/*.jsonl, the transcripts Claude Code
// writes itself. Nothing is sent anywhere and no sign-in is needed.
//
//   ~/.claude/projects/<folder>/<session>.jsonl ──► Session { title, last words, files edited, role }
//   files edited by 2+ sessions in the last 10 min ──► Clash

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type Pr, readDesktopMeta } from "./desktop";
import { isPinned, readPins } from "./prefs";

export interface Tokens {
	/** New input, cache writes and output: what counts toward a limit. */
	used: number;
	/** Input served from the prompt cache, shown apart because it costs far less. */
	cached: number;
}

export interface Session {
	id: string;
	/** Which coding agent wrote the session. */
	agent: "claude" | "codex";
	/** The model of the last reply, like claude-opus-5-5 or gpt-6. */
	model: string;
	tokens: Tokens;
	cwd: string;
	branch: string;
	title: string;
	/** The last thing the agent said. */
	said: string;
	/** The last tool it used, like "Edit api.ts". */
	doing: string;
	/** Files it edited, newest last, with the time of the edit. */
	edits: { file: string; at: number }[];
	/** Folders its shell commands changed into (`cd /path`), so a resumed copy can be let into them. */
	dirs?: string[];
	updatedAt: number;
	role: string;
	/** Pinned in the Claude desktop app. */
	pinned: boolean;
	/** True when you chose this session's type, instead of the board guessing it. */
	roleSet?: boolean;
	/** True when you typed this session's name in the board, instead of using its own title. */
	titleSet?: boolean;
	/** The agent finished its turn with choices for you and is waiting. */
	awaiting?: boolean;
	/** Pull requests the Claude app attached to this session. */
	prs?: Pr[];
	/** Branches the session wrote to, from the Claude app. */
	branches?: string[];
	/** Closed on the board. */
	hidden?: boolean;
	/** The transcript file. Only the server uses it; it is never sent to the page. */
	file?: string;
	/** The model and effort chosen in the board for this agent. */
	tune?: { model?: string; effort?: string; mode?: string };
	/** The agent's task plan (TodoWrite, the app's plan list, Codex update_plan), newest version. */
	plan?: { text: string; status: "pending" | "in_progress" | "completed" }[];
	/** The permission mode the session last ran in: default, acceptEdits, auto, plan or bypassPermissions. */
	mode?: string;
	/** Subagents it started, newest last; `done` once their result came back. */
	agents?: { what: string; kind: string; at: number; done: boolean }[];
	/** Commands it left running in the background, newest last. */
	bg?: { what: string; at: number }[];
	/** Hook runs at the end of its turns, and how many reported an error. */
	hooks?: { runs: number; errors: number; last?: string };
	/** The effort level the Claude desktop app has for this session. */
	effort?: string;
	/** Whether the Claude desktop app lists this session; undefined when that app's files aren't there. */
	viaApp?: boolean;
	/** The last few turns, oldest first, for the agent's channel. */
	feed: FeedItem[];
}

/** The choices an agent offers at the end of its turn (its next-step box, or a question), until you answer. */
export interface Options {
	/** The summary the agent shows above the question. */
	recap?: string;
	ask: string;
	labels: string[];
}

export interface FeedItem {
	at: number;
	who: "you" | "agent";
	text: string;
	tools: string[];
	options?: Options;
	/** When this reply started; stays the same while it grows, so the page can remember if you collapsed it. */
	t0?: number;
}

const FEED_SIZE = 16;

export interface Clash {
	file: string;
	sessions: string[];
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Guesses what kind of agent a session is from its title and the files it touched. */
export function guessRole(title: string, files: string[]): string {
	const text = `${title} ${files.join(" ")}`.toLowerCase();
	const rules: [string, RegExp][] = [
		["Video", /video|film|ffmpeg|\.mp4|gif|record|youtube|\bshorts?\b|\breels?\b|tiktok/],
		["SEO", /\bseo\b|sitemap|robots\.txt|meta tag|canonical|search console/],
		["Social", /tweet|post on|linkedin|reddit|product ?hunt|launch post|\bhn\b|social/],
		["Design", /design|\.css|style|layout|ui\b|avatar|figma|logo|icon/],
		["Calendar", /calendar|schedule|meeting|week plan/],
		["Calls", /\bcall\b|transcript|interview|notes\//],
		["Bug", /\bfix(es|ed|ing)?\b|\bbugs?\b|broken|crash|\bfail(s|ing|ed)?\b|regression|hotfix/],
		["Refactor", /refactor|\brename|\bextract|\bsplit\b|\bmove\b|tidy|clean ?up|dedupe/],
		["Feature", /\bfeat\b|feat\(|\badd\b|implement|\bsupport\b|\bnew\b/],
		["Planner", /plan|roadmap|prd|spec|todo|review/],
		["Chores", /bump|dependenc|lint|format|cleanup|rename|upgrade|ci\b/],
	];
	for (const [role, re] of rules) if (re.test(text)) return role;
	return "Code";
}

/** Short names for the agent's own tools; the rest keep their name. */
const TOOL_NAMES: Record<string, string> = {
	Grep: "Search", Glob: "Find files", WebFetch: "Fetch page", WebSearch: "Web search", Agent: "Subagent", Task: "Subagent",
	TodoWrite: "Plan", AskUserQuestion: "Question", ToolSearch: "Load tools", NotebookEdit: "Edit notebook", exec_command: "Shell",
};
/** MCP servers by a short, readable name; an empty name means the tool's own label says enough. */
const SERVERS: Record<string, string> = { Claude_Browser: "Browser", "claude-in-chrome": "Chrome", ccd_turn: "", ccd_session: "", ccd_view: "", visualize: "" };
/** Readable labels for MCP tools, keyed by the tool's own name. */
const MCP_NAMES: Record<string, string> = {
	browser_batch: "actions", computer: "", navigate: "open page", javascript_tool: "run script", read_page: "read page", get_page_text: "read page",
	find: "find", form_input: "fill form", preview_start: "start", resize_window: "resize", read_console_messages: "console", read_network_requests: "network",
	tabs_context_mcp: "tabs", tabs_create_mcp: "new tab", file_upload: "upload", wrap_up: "Wrap-up", update_plan: "Plan", mark_chapter: "Chapter",
	start_session: "New session", show_widget: "Widget", read_me: "Widget guide",
};

/**
 * A tool call as a person would say it: `mcp__Claude_Browser__browser_batch` becomes "Browser actions",
 * a browser `computer` call says what it did ("Browser screenshot"), and other MCP tools lose their prefix.
 */
export function toolLabel(name: string, input?: Record<string, unknown>): string {
	const parts = name.split("__");
	if (parts[0] !== "mcp" || parts.length < 3) return TOOL_NAMES[name] ?? name;
	const server = parts[1];
	const tool = parts.slice(2).join("__");
	const human = (t: string) => t.replace(/_/g, " ").replace(/\s+/g, " ").trim();
	const short = server in SERVERS ? SERVERS[server] : human(server.replace(/^(claude|mcp)[-_]?/i, "")).replace(/^\w/, (ch) => ch.toUpperCase());
	let what = MCP_NAMES[tool] ?? human(tool);
	if (tool === "computer") what = human(String(input?.action ?? "action")).replace(/left click/, "click");
	if (!short) return what.replace(/^\w/, (ch) => ch.toUpperCase());
	return what ? `${short} ${what}` : short;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c?.type === "text")
		.map((c) => String(c.text ?? ""))
		.join(" ");
}

/** Reads the choices out of a wrap-up box or an AskUserQuestion call. */
export function readOptions(name: string, input?: Record<string, unknown>): Options | undefined {
	const labels = (list: unknown): string[] =>
		Array.isArray(list) ? list.map((o) => String((o as { label?: unknown })?.label ?? "").trim()).filter(Boolean).slice(0, 4) : [];
	if (name.endsWith("__wrap_up")) {
		const l = labels(input?.actions);
		return l.length ? { recap: String(input?.recap ?? "").slice(0, 600), ask: String(input?.ask ?? "").slice(0, 200), labels: l } : undefined;
	}
	if (name === "AskUserQuestion") {
		const q = (Array.isArray(input?.questions) ? input.questions[0] : undefined) as { question?: unknown; options?: unknown } | undefined;
		const l = labels(q?.options);
		return l.length ? { ask: String(q?.question ?? "").slice(0, 200), labels: l } : undefined;
	}
	return undefined;
}

type Step = NonNullable<Session["plan"]>[number];
const STATUS = (v: unknown): Step["status"] => (v === "completed" || v === "in_progress" ? v : "pending");
/** Applies one plan tool call to the plan so far: a full list replaces it, `advance`/`done`/`start` move it on. */
export function applyPlan(plan: Step[] | undefined, name: string, input: Record<string, unknown> | undefined): Step[] | undefined {
	const list = (input?.todos ?? input?.items ?? input?.plan) as { content?: unknown; step?: unknown; status?: unknown }[] | undefined;
	if (Array.isArray(list)) return list.slice(0, 20).map((x) => ({ text: String(x?.content ?? x?.step ?? "").slice(0, 160), status: STATUS(x?.status) })).filter((x) => x.text);
	if (!plan || !name.endsWith("update_plan")) return plan;
	const next = plan.map((x) => ({ ...x }));
	if (input?.advance) {
		const i = next.findIndex((x) => x.status === "in_progress");
		if (i >= 0) next[i].status = "completed";
		const j = next.findIndex((x, k) => k > i && x.status === "pending");
		if (j >= 0) next[j].status = "in_progress";
	}
	for (const n of Array.isArray(input?.done) ? (input.done as number[]) : []) if (next[n - 1]) next[n - 1].status = "completed";
	if (typeof input?.start === "number" && next[input.start - 1]) {
		for (const x of next) if (x.status === "in_progress") x.status = "completed";
		next[input.start - 1].status = "in_progress";
	}
	return next;
}

/** One transcript to a Session, or undefined when it has no conversation in it. */
/** Session ids are UUID-like. Anything else is dropped: ids go into the page's HTML and into `claude --resume <id>`. */
export const SESSION_ID = /^[\w-]{1,128}$/;

export function parseSession(id: string, lines: string[], updatedAt: number): Session | undefined {
	if (!SESSION_ID.test(id) || id.startsWith("-")) return undefined;
	const s: Session = { id, agent: "claude", model: "", tokens: { used: 0, cached: 0 }, cwd: "", branch: "", title: "", said: "", doing: "", edits: [], updatedAt, role: "Code", pinned: false, feed: [] };
	let optItem: FeedItem | undefined;
	let optToolId = "";
	const running = new Map<string, NonNullable<Session["agents"]>[number]>();
	for (const line of lines) {
		let e: {
			type?: string;
			cwd?: string;
			gitBranch?: string;
			timestamp?: string;
			isMeta?: boolean;
			permissionMode?: string;
			subtype?: string;
			hookCount?: number;
			hookErrors?: unknown[];
			hookInfos?: { command?: string }[];
			message?: { content?: unknown; model?: string; usage?: Record<string, number> };
		};
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (e.cwd) s.cwd = e.cwd;
		if (e.gitBranch) s.branch = e.gitBranch;
		const at = e.timestamp ? Date.parse(e.timestamp) : updatedAt;
		if (e.permissionMode) s.mode = e.permissionMode;
		if (e.subtype === "stop_hook_summary") {
			const h = (s.hooks ??= { runs: 0, errors: 0 });
			h.runs++;
			if (Array.isArray(e.hookErrors) && e.hookErrors.length) h.errors++;
			const cmd = e.hookInfos?.find((x) => x?.command && x.command !== "callback")?.command;
			if (cmd) h.last = basename((/^\s*(?:'([^']+)'|"([^"]+)"|(\S+))/.exec(cmd) ?? []).slice(1).find(Boolean) ?? cmd);
		}
		// a subagent is done once its result comes back
		if (e.type === "user" && Array.isArray(e.message?.content) && running.size)
			for (const x of e.message.content as { type?: string; tool_use_id?: string }[]) {
				const a = x?.type === "tool_result" && x.tool_use_id ? running.get(x.tool_use_id) : undefined;
				if (a) {
					a.done = true;
					running.delete(x.tool_use_id as string);
				}
			}
		// An answer to a question call arrives as its tool result; a typed answer arrives as a user message.
		if (optToolId && e.type === "user" && Array.isArray(e.message?.content) && (e.message.content as { type?: string; tool_use_id?: string }[]).some((x) => x?.type === "tool_result" && x.tool_use_id === optToolId)) {
			if (optItem) delete optItem.options;
			optItem = undefined;
			optToolId = "";
		}
		if (e.type === "user" && !e.isMeta && !s.title) {
			const t = textOf(e.message?.content).trim();
			if (t && !t.startsWith("<")) s.title = t.split("\n")[0].slice(0, 90);
		}
		if (e.type === "user" && !e.isMeta) {
			const t = textOf(e.message?.content).trim();
			if (t && !t.startsWith("<")) {
				s.feed.push({ at, who: "you", text: t.slice(0, 2000), tools: [] });
				if (optItem) delete optItem.options;
				optItem = undefined;
			}
		}
		const u = e.type === "assistant" ? e.message?.usage : undefined;
		if (u) {
			s.tokens.used += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
			s.tokens.cached += u.cache_read_input_tokens ?? 0;
		}
		if (e.type === "assistant" && e.message?.model && !e.message.model.startsWith("<")) s.model = e.message.model;
		if (e.type === "assistant" && Array.isArray(e.message?.content)) {
			const words = textOf(e.message.content).trim();
			if (words) s.said = words.replace(/\s+/g, " ").slice(0, 160);
			const last = s.feed[s.feed.length - 1];
			const item =
				last?.who === "agent" ? last : { at, t0: at, who: "agent" as const, text: "", tools: [] as string[] };
			if (item !== last) s.feed.push(item);
			// A turn can hold several text blocks between its tool calls; show all of them, newest last.
			if (words) item.text = item.text ? `${item.text}\n\n${words}`.slice(-8000) : words.slice(0, 8000);
			item.at = at;
			for (const c of e.message.content as { type?: string; id?: string; name?: string; input?: Record<string, unknown> }[]) {
				if (c?.type !== "tool_use" || !c.name) continue;
				const opts = readOptions(c.name, c.input);
				if (opts) {
					if (optItem && optItem !== item) delete optItem.options;
					item.options = opts;
					optItem = item;
					optToolId = c.name === "AskUserQuestion" ? String(c.id ?? "") : "";
				} else if (optItem) {
					// the agent went on working, so the choices are stale
					delete optItem.options;
					optItem = undefined;
					optToolId = "";
				}
				const file = String(c.input?.file_path ?? c.input?.notebook_path ?? "");
				s.doing = file ? `${toolLabel(c.name, c.input)} ${basename(file)}` : toolLabel(c.name, c.input);
				if (file && EDIT_TOOLS.has(c.name)) s.edits.push({ file, at });
				if (c.name === "Bash") {
					for (const m of String(c.input?.command ?? "").matchAll(/\bcd\s+("[^"]+"|'[^']+'|[~/][^\s;&|)]*)/g)) {
						const d = m[1].replace(/^["']|["']$/g, "").replace(/^~(?=\/|$)/, homedir());
						if (d.startsWith("/") && !(s.dirs ??= []).includes(d)) s.dirs.push(d);
					}
				}
				if (item.tools.length < 6) item.tools.push(s.doing);
				if (c.name === "TodoWrite" || c.name.endsWith("update_plan")) s.plan = applyPlan(s.plan, c.name, c.input);
				if ((c.name === "Agent" || c.name === "Task") && c.id) {
					const a = { what: String(c.input?.description ?? "Subagent").slice(0, 80), kind: String(c.input?.subagent_type ?? "general-purpose"), at, done: false };
					(s.agents ??= []).push(a);
					running.set(String(c.id), a);
				}
				if (c.input?.run_in_background === true) (s.bg ??= []).push({ what: String(c.input?.description ?? c.input?.command ?? c.name).slice(0, 80), at });
			}
		}
	}
	if (!s.title && !s.said) return undefined;
	if (s.agents) s.agents = s.agents.slice(-8);
	if (s.bg) s.bg = s.bg.slice(-6);
	s.awaiting = !!optItem;
	s.feed = s.feed.filter((f) => f.text || f.tools.length).slice(-FEED_SIZE);
	s.role = guessRole(s.title, s.edits.map((x) => x.file));
	return s;
}

/** One Codex rollout (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) to a Session. */
export function parseCodexSession(lines: string[], updatedAt: number): Session | undefined {
	const s: Session = { id: "", agent: "codex", model: "", tokens: { used: 0, cached: 0 }, cwd: "", branch: "", title: "", said: "", doing: "", edits: [], updatedAt, role: "Code", pinned: false, feed: [] };
	for (const line of lines) {
		let e: { timestamp?: string; type?: string; payload?: Record<string, unknown> };
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		const p = e.payload ?? {};
		const at = e.timestamp ? Date.parse(e.timestamp) : updatedAt;
		if (e.type === "session_meta") {
			s.id = String(p.id ?? p.session_id ?? "");
			s.cwd = String(p.cwd ?? "");
			const git = p.git as { branch?: string } | undefined;
			if (git?.branch) s.branch = git.branch;
		}
		if (e.type === "turn_context" && typeof p.model === "string") s.model = p.model;
		if (e.type === "event_msg" && p.type === "token_count") {
			const t = (p.info as { total_token_usage?: Record<string, number> } | null)?.total_token_usage;
			if (t) s.tokens = { used: (t.input_tokens ?? 0) - (t.cached_input_tokens ?? 0) + (t.output_tokens ?? 0), cached: t.cached_input_tokens ?? 0 };
		}
		if (e.type === "response_item" && p.type === "message" && (p.role === "user" || p.role === "assistant")) {
			const text = ((p.content as { text?: string }[]) ?? []).map((c) => c.text ?? "").join(" ").trim();
			if (!text || text.startsWith("<")) continue;
			if (p.role === "user") {
				if (!s.title) s.title = text.split("\n")[0].slice(0, 90);
				s.feed.push({ at, who: "you", text: text.slice(0, 2000), tools: [] });
			} else {
				s.said = text.replace(/\s+/g, " ").slice(0, 160);
				s.feed.push({ at, t0: at, who: "agent", text: text.slice(0, 5000), tools: [] });
			}
		}
		if (e.type === "response_item" && (p.type === "custom_tool_call" || p.type === "function_call")) {
			s.doing = toolLabel(String(p.name ?? "tool"));
			if (p.name === "update_plan") {
				try {
					s.plan = applyPlan(s.plan, "update_plan", typeof p.arguments === "string" ? JSON.parse(p.arguments) : (p.arguments as Record<string, unknown>));
				} catch {}
			}
			const last = s.feed[s.feed.length - 1];
			if (last?.who === "agent" && last.tools.length < 6) last.tools.push(s.doing);
		}
	}
	if (!SESSION_ID.test(s.id) || s.id.startsWith("-") || (!s.title && !s.said)) return undefined;
	s.role = guessRole(s.title, []);
	s.feed = s.feed.slice(-FEED_SIZE);
	return s;
}

/** Codex sessions changed within maxAgeMs. Rollouts sit in day folders, so only the last two days are read. */
export function readCodexSessions(
	root = process.env.CODEX_SESSIONS_DIR || join(homedir(), ".codex", "sessions"),
	maxAgeMs = 60 * 60_000,
	now = Date.now(),
): Session[] {
	const out: Session[] = [];
	for (const d of [0, 1]) {
		const day = new Date(now - d * 86_400_000);
		const dir = join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
		let files: string[] = [];
		try {
			files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const f of files) {
			const path = join(dir, f);
			const mtime = statSync(path).mtimeMs;
			if (now - mtime > maxAgeMs) continue;
			const s = parseCodexSession(readFileSync(path, "utf8").split("\n"), mtime);
			if (s) {
				s.file = path;
				out.push(s);
			}
		}
	}
	return out;
}

/** Files edited by two or more sessions within the window. */
export function findClashes(sessions: Session[], now = Date.now(), windowMs = 10 * 60_000): Clash[] {
	const byFile = new Map<string, Set<string>>();
	for (const s of sessions)
		for (const e of s.edits)
			if (now - e.at < windowMs) byFile.set(e.file, (byFile.get(e.file) ?? new Set()).add(s.id));
	return [...byFile]
		.filter(([, ids]) => ids.size > 1)
		.map(([file, ids]) => ({ file, sessions: [...ids] }));
}

const parsed = new Map<string, { mtime: number; s: Session | undefined }>();

/** Sessions whose transcript changed within maxAgeMs, newest first. */
export function readSessions(
	root = process.env.CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects"),
	maxAgeMs = 60 * 60_000,
	now = Date.now(),
	/** Session ids to include however old, like pinned ones. */
	keep: ReadonlySet<string> = new Set(),
): Session[] {
	const out: Session[] = [];
	let folders: string[] = [];
	try {
		folders = readdirSync(root);
	} catch {
		return out;
	}
	for (const folder of folders) {
		let files: string[] = [];
		try {
			files = readdirSync(join(root, folder)).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const f of files) {
			const path = join(root, folder, f);
			const mtime = statSync(path).mtimeMs;
			if (now - mtime > maxAgeMs && !keep.has(f.replace(/\.jsonl$/, ""))) continue;
			// Reading a transcript is the slow part, and old ones do not change: parse each file once per change.
			let hit = parsed.get(path);
			if (!hit || hit.mtime !== mtime) {
				hit = { mtime, s: parseSession(f.replace(/\.jsonl$/, ""), readFileSync(path, "utf8").split("\n"), mtime) };
				parsed.set(path, hit);
			}
			// A copy, so what callers set on it (title, pin, type) never sticks to the cached one.
			if (hit.s) out.push({ ...hit.s, file: path });
		}
	}
	return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Every agent's sessions on this computer, newest first: Claude Code sessions with the names, pins and archive
 * state from the Claude desktop app (pinned ones show whatever their age), plus Codex sessions.
 */
export function readAllSessions(now = Date.now()): Session[] {
	const meta = readDesktopMeta();
	// Like the Claude app: every unarchived session it lists (the 30 most recent) shows up whatever its age, so
	// unpinning an old one only moves it to Idle. Pins, from the app or the board, are always kept.
	const recent = [...meta].filter(([, m]) => !m.archived).sort((a, b) => b[1].at - a[1].at).slice(0, 30).map(([id]) => id);
	const pinnedIds = [...[...meta].filter(([, m]) => m.pinned).map(([id]) => id), ...readPins().pinned].filter((id) => isPinned(id, true));
	const keep = new Set([...recent, ...pinnedIds]);
	const claude = readSessions(undefined, undefined, now, keep).filter((s) => !meta.get(s.id)?.archived || isPinned(s.id, !!meta.get(s.id)?.pinned));
	for (const s of claude) {
		const m = meta.get(s.id);
		if (meta.size) s.viaApp = !!m;
		s.pinned = isPinned(s.id, !!m?.pinned);
		if (!m) continue;
		if (m.title) s.title = m.title;
		if (m.effort) s.effort = m.effort;
		if (m.prs.length) s.prs = m.prs;
		if (m.branches.length) s.branches = m.branches;
		s.role = guessRole(s.title, s.edits.map((e) => e.file));
	}
	const codex = readCodexSessions(undefined, undefined, now);
	for (const s of codex) s.pinned = isPinned(s.id, false);
	return [...claude, ...codex].sort((a, b) => b.updatedAt - a.updatedAt);
}
