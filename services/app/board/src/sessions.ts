// Reads the Claude Code sessions on this computer from ~/.claude/projects/*/*.jsonl, the transcripts Claude Code
// writes itself. Nothing is sent anywhere and no sign-in is needed.
//
//   ~/.claude/projects/<folder>/<session>.jsonl ──► Session { title, last words, files edited, role }
//   files edited by 2+ sessions in the last 10 min ──► Clash

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readDesktopMeta } from "./desktop";

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
	updatedAt: number;
	role: string;
	/** Pinned in the Claude desktop app. */
	pinned: boolean;
	/** True when you chose this session's type, instead of the board guessing it. */
	roleSet?: boolean;
	/** Whether the Claude desktop app lists this session; undefined when that app's files aren't there. */
	viaApp?: boolean;
	/** The last few turns, oldest first, for the agent's channel. */
	feed: FeedItem[];
}

export interface FeedItem {
	at: number;
	who: "you" | "agent";
	text: string;
	tools: string[];
}

const FEED_SIZE = 12;

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
		["Planner", /plan|roadmap|prd|spec|todo|review/],
		["Chores", /bump|dependenc|lint|format|cleanup|rename|upgrade|ci\b/],
	];
	for (const [role, re] of rules) if (re.test(text)) return role;
	return "Code";
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c?.type === "text")
		.map((c) => String(c.text ?? ""))
		.join(" ");
}

/** One transcript to a Session, or undefined when it has no conversation in it. */
/** Session ids are UUID-like. Anything else is dropped: ids go into the page's HTML and into `claude --resume <id>`. */
export const SESSION_ID = /^[\w-]{1,128}$/;

export function parseSession(id: string, lines: string[], updatedAt: number): Session | undefined {
	if (!SESSION_ID.test(id) || id.startsWith("-")) return undefined;
	const s: Session = { id, agent: "claude", model: "", tokens: { used: 0, cached: 0 }, cwd: "", branch: "", title: "", said: "", doing: "", edits: [], updatedAt, role: "Code", pinned: false, feed: [] };
	for (const line of lines) {
		let e: {
			type?: string;
			cwd?: string;
			gitBranch?: string;
			timestamp?: string;
			isMeta?: boolean;
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
		if (e.type === "user" && !e.isMeta && !s.title) {
			const t = textOf(e.message?.content).trim();
			if (t && !t.startsWith("<")) s.title = t.split("\n")[0].slice(0, 90);
		}
		if (e.type === "user" && !e.isMeta) {
			const t = textOf(e.message?.content).trim();
			if (t && !t.startsWith("<")) s.feed.push({ at, who: "you", text: t.slice(0, 400), tools: [] });
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
				last?.who === "agent" ? last : { at, who: "agent" as const, text: "", tools: [] as string[] };
			if (item !== last) s.feed.push(item);
			if (words) item.text = words.slice(0, 600);
			item.at = at;
			for (const c of e.message.content as { type?: string; name?: string; input?: Record<string, unknown> }[]) {
				if (c?.type !== "tool_use" || !c.name) continue;
				const file = String(c.input?.file_path ?? c.input?.notebook_path ?? "");
				s.doing = file ? `${c.name} ${basename(file)}` : c.name.replace(/^mcp__[^_]+__/, "");
				if (file && EDIT_TOOLS.has(c.name)) s.edits.push({ file, at });
				if (item.tools.length < 6) item.tools.push(s.doing);
			}
		}
	}
	if (!s.title && !s.said) return undefined;
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
				s.feed.push({ at, who: "you", text: text.slice(0, 400), tools: [] });
			} else {
				s.said = text.replace(/\s+/g, " ").slice(0, 160);
				s.feed.push({ at, who: "agent", text: text.slice(0, 600), tools: [] });
			}
		}
		if (e.type === "response_item" && (p.type === "custom_tool_call" || p.type === "function_call")) {
			s.doing = String(p.name ?? "tool");
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
			if (s) out.push(s);
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
			const s = parseSession(f.replace(/\.jsonl$/, ""), readFileSync(path, "utf8").split("\n"), mtime);
			if (s) out.push(s);
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
	const keep = new Set([...meta].filter(([, m]) => m.pinned).map(([id]) => id));
	const claude = readSessions(undefined, undefined, now, keep).filter((s) => {
		const m = meta.get(s.id);
		return !m?.archived || m.pinned;
	});
	for (const s of claude) {
		const m = meta.get(s.id);
		if (meta.size) s.viaApp = !!m;
		if (!m) continue;
		if (m.title) s.title = m.title;
		s.pinned = m.pinned;
		s.role = guessRole(s.title, s.edits.map((e) => e.file));
	}
	return [...claude, ...readCodexSessions(undefined, undefined, now)].sort((a, b) => b.updatedAt - a.updatedAt);
}
