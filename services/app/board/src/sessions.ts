// Reads the Claude Code sessions on this computer from ~/.claude/projects/*/*.jsonl, the transcripts Claude Code
// writes itself. Nothing is sent anywhere and no sign-in is needed.
//
//   ~/.claude/projects/<folder>/<session>.jsonl ──► Session { title, last words, files edited, role }
//   files edited by 2+ sessions in the last 10 min ──► Clash

import { readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type DesktopMeta, type Pr, readDesktopMeta } from "./desktop";
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
	agent: "claude" | "codex" | "grok";
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
	edits: { file: string; at: number; add?: number; del?: number }[];
	/** Tokens in the context window at the last reply (input plus cached), and how often it was compacted. */
	context?: number;
	ctxPeak?: number;
	compacts?: number;
	/** When you last wrote to it, so the board can time how long it has been working since. */
	asked?: number;
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
	/** Each tool call in this reply, with what it actually ran: the command, file, URL or search. */
	calls?: { label: string; what?: string; detail: string; result?: string; bad?: boolean }[];
	options?: Options;
	/** When this reply started; stays the same while it grows, so the page can remember if you collapsed it. */
	t0?: number;
}

const FEED_SIZE = 16;
/**
 * How much of one reply the board shows on screen. It is a display cap only: what a kitchen stage hands to the next
 * one is read whole from the transcript (`fullReply`), so a long spec is never cut before the hand-off (order #133).
 */
export const FEED_TEXT_MAX = 8000;

/**
 * A reply's words added to what the same turn already said, cut in the middle when it outgrows `max`, so the start
 * (a spec's Goal and Steps) and the end (its closing line) both stay on screen. It used to keep only the last 8000
 * characters, which is how order #133's stored note started in the middle of a test file.
 */
export function feedText(prev: string, words: string, max = FEED_TEXT_MAX): { text: string; cut: boolean } {
	const all = prev ? `${prev}\n\n${words}` : words;
	if (all.length <= max) return { text: all, cut: false };
	const head = Math.floor(max * 0.7);
	return { text: `${all.slice(0, head)}\n\n[… ${all.length - max} characters cut …]\n\n${all.slice(-(max - head))}`, cut: true };
}

export interface Clash {
	file: string;
	sessions: string[];
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const lines = (v: unknown) => (typeof v === "string" && v ? v.split("\n").length : 0);
/** Lines an edit added and removed, from the tool call itself, like a diff stat. */
export function editSize(name: string, input?: Record<string, unknown>): { add: number; del: number } {
	if (name === "Write") return { add: lines(input?.content), del: 0 };
	const parts = name === "MultiEdit" && Array.isArray(input?.edits) ? (input.edits as Record<string, unknown>[]) : [input ?? {}];
	return parts.reduce<{ add: number; del: number }>((t, p) => ({ add: t.add + lines(p.new_string ?? p.new_source), del: t.del + lines(p.old_string) }), { add: 0, del: 0 });
}

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
/**
 * Grok Build's own tool names, mapped to the Claude Code tool with the same job. Its arguments already match
 * Claude's shape (file_path, old_string/new_string, command, todos), so once a call is relabelled it reads
 * exactly like a Claude one everywhere below: toolLabel, callDetail, editSize, EDIT_TOOLS, applyPlan, readOptions.
 */
const GROK_TOOL_ALIAS: Record<string, string> = {
	read_file: "Read", write: "Write", search_replace: "Edit", run_terminal_command: "Bash",
	grep: "Grep", list_dir: "Glob", todo_write: "TodoWrite", ask_user_question: "AskUserQuestion",
};
/** The two Grok tools whose file argument has its own name instead of Claude's `file_path`. */
const GROK_FILE_KEY: Record<string, string> = { read_file: "target_file", list_dir: "target_directory" };
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

/** What a tool call actually did, in one line a person can read and copy: the shell command, the file, the URL. */
export function callDetail(name: string, input?: Record<string, unknown>): { what?: string; detail: string } {
	const str = (v: unknown) => (typeof v === "string" ? v : "");
	const cut = (v: string, n: number) => (v.length > n ? `${v.slice(0, n)}…` : v);
	if (name === "Bash" || name === "shell" || name === "exec_command") {
		const cmd = Array.isArray(input?.command) ? (input.command as unknown[]).map(String).join(" ") : str(input?.command ?? input?.cmd);
		return { what: str(input?.description) || undefined, detail: cut(cmd, 800) };
	}
	const file = str(input?.file_path ?? input?.notebook_path ?? input?.path);
	if (file && !input?.pattern) return { detail: file };
	if (input?.pattern) return { detail: cut(`${str(input.pattern)}${file ? `  in ${file}` : ""}`, 300) };
	if (input?.url) return { what: str(input.prompt).slice(0, 120) || undefined, detail: str(input.url) };
	if (input?.query) return { detail: cut(str(input.query), 300) };
	if (input?.description) return { detail: cut(str(input.description), 200) };
	// A browser batch keeps everything in `actions`: show one short line per step instead of an empty {}.
	if (Array.isArray(input?.actions)) {
		const steps = (input.actions as { name?: unknown; input?: Record<string, unknown> }[]).map((a) => {
			const label = String(a?.name ?? "step").replace(/_/g, " ");
			const args = Object.entries(a?.input ?? {}).filter(([k]) => k !== "action_summary" && k !== "tabId").map(([k, v]) => `${k}=${cut(typeof v === "string" ? v : JSON.stringify(v), 60)}`);
			return args.length ? `${label} ${args.join(" ")}` : label;
		});
		return { detail: cut(steps.join(" → "), 800) };
	}
	const small = Object.fromEntries(Object.entries(input ?? {}).map(([k, v]) => [k, typeof v === "string" ? cut(v, 80) : v]));
	const text = JSON.stringify(small);
	return { detail: cut(text === "{}" ? "" : text, 300) };
}

export function rowLabel(name: string, input?: Record<string, unknown>): string {
	const f = String(input?.file_path ?? input?.notebook_path ?? input?.path ?? "");
	if (name === "Bash") return `Ran ${String(input?.command ?? "").replace(/\s+/g, " ").slice(0, 60)}`;
	if (name === "Grep" || name === "Glob") return `Searched ${f ? basename(f) : "files"} for ${String(input?.pattern ?? "").slice(0, 40)}`;
	if (name === "Read") return `Read ${basename(f)}`;
	if (EDIT_TOOLS.has(name)) return `Edited ${basename(f)}`;
	return toolLabel(name, input);
}
export function rowResult(text: string, bad?: boolean): string {
	const t = text.replace(/\s+/g, " ").trim();
	if (bad) return `failed: ${t.slice(0, 120)}`;
	const p = /(\d+)\s+pass/.exec(t), fl = /(\d+)\s+fail/.exec(t), m = /Found (\d+) (?:match|file)/.exec(t);
	if (p) return `${p[1]} pass, ${fl ? fl[1] : 0} fail`;
	if (m) return `${m[1]} matches`;
	return t.slice(0, 80);
}

export function diffStat(cwd: string): { add: number; del: number } | undefined {
	try {
		// A folder that is gone (a deleted order worktree) is not asked of git: stderr went to the board's live log on
		// every poll, "fatal: cannot change to '…/order-137'" over and over (#141).
		if (!statSync(cwd).isDirectory()) return undefined;
		const output = execFileSync("git", ["-C", cwd, "diff", "--numstat", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
		let add = 0, del = 0;
		for (const line of output.trim().split("\n")) {
			const m = /^(\d+)\s+(\d+)/.exec(line);
			if (m) { add += parseInt(m[1], 10); del += parseInt(m[2], 10); }
		}
		return { add, del };
	} catch {
		return undefined;
	}
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
	const seen = new Set<string>();
	const byId = new Map<string, NonNullable<FeedItem["calls"]>[number]>();
	for (const line of lines) {
		let e: {
			type?: string;
			cwd?: string;
			gitBranch?: string;
			timestamp?: string;
			isMeta?: boolean;
			isCompactSummary?: boolean;
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
		if (e.isCompactSummary || e.subtype === "compact_boundary") s.compacts = (s.compacts ?? 0) + 1;
		if (e.subtype === "stop_hook_summary") {
			const h = (s.hooks ??= { runs: 0, errors: 0 });
			h.runs++;
			if (Array.isArray(e.hookErrors) && e.hookErrors.length) h.errors++;
			const cmd = e.hookInfos?.find((x) => x?.command && x.command !== "callback")?.command;
			if (cmd) h.last = basename((/^\s*(?:'([^']+)'|"([^"]+)"|(\S+))/.exec(cmd) ?? []).slice(1).find(Boolean) ?? cmd);
		}
		// a subagent is done once its result comes back
		if (e.type === "user" && Array.isArray(e.message?.content) && running.size)
			for (const x of e.message.content as { type?: string; tool_use_id?: string; content?: string; is_error?: boolean }[]) {
				const a = x?.type === "tool_result" && x.tool_use_id ? running.get(x.tool_use_id) : undefined;
				if (a) {
					a.done = true;
					running.delete(x.tool_use_id as string);
				}
				const call = x?.type === "tool_result" && x.tool_use_id ? byId.get(x.tool_use_id) : undefined;
				if (call) {
					call.result = rowResult(String(x.content ?? ""), x.is_error === true);
					call.bad = x.is_error === true;
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
				s.asked = at;
				if (optItem) delete optItem.options;
				optItem = undefined;
			}
		}
		const u = e.type === "assistant" ? e.message?.usage : undefined;
		const msgId = String(e.message?.id ?? Math.random());
		const isNewMessage = !seen.has(msgId);
		if (isNewMessage) seen.add(msgId);
		if (u && isNewMessage) {
			s.context = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
			s.ctxPeak = Math.max(s.ctxPeak ?? 0, s.context);
			s.tokens.used += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
			s.tokens.cached += u.cache_read_input_tokens ?? 0;
		}
		if (e.type === "assistant" && e.message?.model && !e.message.model.startsWith("<")) s.model = e.message.model;
		// Claude Code's own "<synthetic>" message ("No response requested.") after a turn that never finished is not the
		// agent speaking: read as its reply, it used up the step's two answers and failed orders (#252).
		if (e.type === "assistant" && e.message?.model === "<synthetic>") continue;
		if (e.type === "assistant" && Array.isArray(e.message?.content)) {
			const words = textOf(e.message.content).trim();
			if (words) s.said = words.replace(/\s+/g, " ").slice(0, 160);
			const last = s.feed[s.feed.length - 1];
			const item =
				last?.who === "agent" ? last : { at, t0: at, who: "agent" as const, text: "", tools: [] as string[] };
			if (item !== last) s.feed.push(item);
			// A turn can hold several text blocks between its tool calls; show all of them, newest last.
			if (words) item.text = feedText(item.text, words).text;
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
				s.doing = rowLabel(c.name, c.input);
				if (file && EDIT_TOOLS.has(c.name)) s.edits.push({ file, at, ...editSize(c.name, c.input) });
				if (c.name === "Bash") {
					for (const m of String(c.input?.command ?? "").matchAll(/\bcd\s+("[^"]+"|'[^']+'|[~/][^\s;&|)]*)/g)) {
						const d = m[1].replace(/^["']|["']$/g, "").replace(/^~(?=\/|$)/, homedir());
						if (d.startsWith("/") && !(s.dirs ??= []).includes(d)) s.dirs.push(d);
					}
				}
				if (item.tools.length < 6) item.tools.push(s.doing);
				const call = { label: rowLabel(c.name, c.input), ...callDetail(c.name, c.input) } as NonNullable<FeedItem["calls"]>[number];
				if (EDIT_TOOLS.has(c.name)) {
					const es = editSize(c.name, c.input);
					if (es.add !== undefined && es.del !== undefined) {
						call.result = `+${es.add} −${es.del}`;
					}
				}
				if ((item.calls ??= []).length < 40) item.calls.push(call);
				if (c.id) byId.set(String(c.id), call);
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

/**
 * Everything the agent said in its last turn, straight from the transcript lines and with no cap: every text block
 * of every reply since you last wrote to it. The feed on screen is capped (FEED_TEXT_MAX); a hand-off to the next
 * kitchen stage reads this instead, so a 32,000-character spec arrives whole.
 */
export function fullReply(lines: string[]): string {
	let said: string[] = [];
	for (const line of lines) {
		let e: { type?: string; isMeta?: boolean; message?: { content?: unknown; model?: string } };
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (e.type === "user" && !e.isMeta) {
			// A real message from you starts a new turn; a tool result or a `<…>` notice is not one.
			const t = textOf(e.message?.content).trim();
			if (t && !t.startsWith("<")) said = [];
			continue;
		}
		// As in parseSession: Claude Code's own "<synthetic>" message is not the agent speaking.
		if (e.type !== "assistant" || !Array.isArray(e.message?.content) || e.message?.model === "<synthetic>") continue;
		const words = textOf(e.message.content).trim();
		if (words) said.push(words);
	}
	return said.join("\n\n");
}

/** `fullReply` of a transcript file, or "" when it cannot be read or holds nothing the agent said. */
export function readFullReply(path: string | undefined): string {
	if (!path) return "";
	try {
		return fullReply(readFileSync(path, "utf8").split("\n"));
	} catch {
		return "";
	}
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
			if (last?.who === "agent" && (last.calls ??= []).length < 40) {
				let args: Record<string, unknown> = {};
				try {
					args = typeof p.arguments === "string" ? JSON.parse(p.arguments) : ((p.arguments ?? p.input ?? {}) as Record<string, unknown>);
				} catch {}
				last.calls.push({ label: s.doing, ...callDetail(String(p.name ?? "tool"), args) });
			}
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

/** A git worktree's current branch, read straight off disk (no `git` subprocess): fast enough to call on every poll. */
function gitBranchOf(cwd: string): string {
	try {
		let gitDir = join(cwd, ".git");
		if (statSync(gitDir).isFile()) {
			const link = /^gitdir: (.+)$/m.exec(readFileSync(gitDir, "utf8"));
			if (link) gitDir = link[1].trim();
		}
		const head = /^ref: refs\/heads\/(.+)$/m.exec(readFileSync(join(gitDir, "HEAD"), "utf8"));
		return head ? head[1].trim() : "";
	} catch {
		return "";
	}
}

/** A real user turn in Grok Build's chat_history.jsonl: every turn is wrapped in this tag; skills/MCP notices are not. */
const USER_QUERY = /<user_query>\n?([\s\S]*?)\n?<\/user_query>/;

/**
 * One Grok Build session (~/.grok/sessions/<url-encoded cwd>/<id>/chat_history.jsonl) to a Session. `usage` is that
 * session's ~/.grok/sessions/.../usage.json `session` object: Grok keeps running totals there, not per-message.
 */
export function parseGrokSession(
	id: string,
	cwd: string,
	lines: string[],
	usage: { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number; cacheCreationTokens?: number } | undefined,
	updatedAt: number,
): Session | undefined {
	if (!SESSION_ID.test(id) || id.startsWith("-")) return undefined;
	const s: Session = { id, agent: "grok", model: "", tokens: { used: 0, cached: 0 }, cwd, branch: gitBranchOf(cwd), title: "", said: "", doing: "", edits: [], updatedAt, role: "Code", pinned: false, feed: [] };
	if (usage) {
		s.tokens = { used: (usage.inputTokens ?? 0) + (usage.cacheCreationTokens ?? 0) + (usage.outputTokens ?? 0), cached: usage.cachedReadTokens ?? 0 };
	}
	let optItem: FeedItem | undefined;
	let optToolId = "";
	for (const line of lines) {
		let d: { type?: string; content?: unknown; model_id?: string; tool_calls?: { id?: string; name?: string; arguments?: string }[]; tool_call_id?: string };
		try {
			d = JSON.parse(line);
		} catch {
			continue;
		}
		const at = updatedAt;
		if (d.type === "user") {
			const raw = textOf(d.content).trim();
			const m = USER_QUERY.exec(raw);
			const t = m?.[1]?.trim();
			if (t) {
				if (!s.title) s.title = t.split("\n")[0].slice(0, 90);
				s.feed.push({ at, who: "you", text: t.slice(0, 2000), tools: [] });
				s.asked = at;
				if (optItem) delete optItem.options;
				optItem = undefined;
				optToolId = "";
			}
			continue;
		}
		if (d.type === "tool_result") {
			if (optToolId && d.tool_call_id === optToolId) {
				if (optItem) delete optItem.options;
				optItem = undefined;
				optToolId = "";
			}
			continue;
		}
		if (d.type !== "assistant") continue;
		if (typeof d.model_id === "string") s.model = d.model_id;
		const words = typeof d.content === "string" ? d.content.trim() : "";
		if (words) s.said = words.replace(/\s+/g, " ").slice(0, 160);
		const last = s.feed[s.feed.length - 1];
		const item = last?.who === "agent" ? last : { at, t0: at, who: "agent" as const, text: "", tools: [] as string[] };
		if (item !== last) s.feed.push(item);
		if (words) item.text = feedText(item.text, words).text;
		item.at = at;
		for (const tc of d.tool_calls ?? []) {
			if (!tc.name) continue;
			const name = GROK_TOOL_ALIAS[tc.name] ?? tc.name;
			let input: Record<string, unknown> = {};
			try {
				input = JSON.parse(tc.arguments ?? "{}");
			} catch {}
			const fileKey = GROK_FILE_KEY[tc.name];
			if (fileKey && input[fileKey] !== undefined && input.file_path === undefined) input = { ...input, file_path: input[fileKey] };
			const opts = readOptions(name, input);
			if (opts) {
				if (optItem && optItem !== item) delete optItem.options;
				item.options = opts;
				optItem = item;
				optToolId = String(tc.id ?? "");
			} else if (optItem) {
				delete optItem.options;
				optItem = undefined;
				optToolId = "";
			}
			const file = String(input.file_path ?? "");
			s.doing = file ? `${toolLabel(name, input)} ${basename(file)}` : toolLabel(name, input);
			if (file && EDIT_TOOLS.has(name)) s.edits.push({ file, at, ...editSize(name, input) });
			if (item.tools.length < 6) item.tools.push(s.doing);
			if ((item.calls ??= []).length < 40) item.calls.push({ label: s.doing, ...callDetail(name, input) });
			if (name === "TodoWrite") s.plan = applyPlan(s.plan, name, input);
			if (tc.name === "run_terminal_command" && input.background === true) (s.bg ??= []).push({ what: String(input.description ?? input.command ?? "command").slice(0, 80), at });
		}
	}
	if (!s.title && !s.said) return undefined;
	s.awaiting = !!optItem;
	s.feed = s.feed.filter((f) => f.text || f.tools.length).slice(-FEED_SIZE);
	s.role = guessRole(s.title, s.edits.map((x) => x.file));
	return s;
}

/**
 * Grok Build sessions changed within maxAgeMs: one folder per working directory (URL-encoded), one per session id
 * inside it. `grok sessions`, `grok export` and `grok usage` all read this same layout, so it is a stable interface.
 */
/** The error of the session's last turn, when that turn failed, from Grok's updates.jsonl. */
export function grokTurnError(dir: string): { at: number; text: string } | undefined {
	let lines: string[];
	try {
		lines = readFileSync(join(dir, "updates.jsonl"), "utf8").split("\n");
	} catch {
		return undefined;
	}
	for (let i = lines.length - 1; i >= 0; i--) {
		type Update = { update?: { sessionUpdate?: string; stop_reason?: string; agent_result?: unknown }; _meta?: { agentTimestampMs?: number } };
		let e: Update;
		try {
			// Each line is an ACP notification, { method, params: { sessionId, update, _meta } }.
			const j = JSON.parse(lines[i]) as Update & { params?: Update };
			e = j.params ?? j;
		} catch {
			continue;
		}
		if (e.update?.sessionUpdate !== "turn_completed") continue;
		if (e.update.stop_reason !== "error") return undefined;
		return { at: Number(e._meta?.agentTimestampMs) || 0, text: String(e.update.agent_result ?? "the turn failed").slice(0, 500) };
	}
	return undefined;
}

export function readGrokSessions(
	root = process.env.GROK_SESSIONS_DIR || join(homedir(), ".grok", "sessions"),
	maxAgeMs = 60 * 60_000,
	now = Date.now(),
): Session[] {
	const out: Session[] = [];
	let cwdDirs: string[] = [];
	try {
		cwdDirs = readdirSync(root);
	} catch {
		return out;
	}
	for (const enc of cwdDirs) {
		const cwdPath = join(root, enc);
		let ids: string[] = [];
		try {
			ids = readdirSync(cwdPath).filter((f) => SESSION_ID.test(f) && statSync(join(cwdPath, f)).isDirectory());
		} catch {
			continue;
		}
		for (const id of ids) {
			const dir = join(cwdPath, id);
			const chatPath = join(dir, "chat_history.jsonl");
			let mtime: number;
			try {
				mtime = statSync(chatPath).mtimeMs;
			} catch {
				continue;
			}
			if (now - mtime > maxAgeMs) continue;
			let info: { cwd?: string } | undefined;
			try {
				info = (JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")).info ?? {}) as { cwd?: string };
			} catch {}
			let usage: { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number; cacheCreationTokens?: number } | undefined;
			try {
				usage = JSON.parse(readFileSync(join(dir, "usage.json"), "utf8")).session;
			} catch {}
			const s = parseGrokSession(id, info?.cwd || decodeURIComponent(enc), readFileSync(chatPath, "utf8").split("\n"), usage, mtime);
			if (s) {
				s.file = chatPath;
				const failed = grokTurnError(dir);
				// A turn that failed (no credit, a bad model) writes no reply: say why instead of looking busy forever.
				if (failed && s.feed.at(-1)?.who === "you") {
					s.feed.push({ at: Math.max(failed.at, s.feed.at(-1)?.at ?? 0), who: "agent", text: `⚠ Grok Build: ${failed.text}`, tools: [] });
					s.doing = "Error";
					s.updatedAt = Math.max(s.updatedAt, failed.at);
				}
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
 * Sessions the Claude app lists that have no transcript yet, like a sub-session another session just started: the
 * app writes the transcript only once the first turn runs, which can be a minute or more later.
 */
export function waitingSessions(meta: Map<string, DesktopMeta>, have: ReadonlySet<string>, now = Date.now(), maxAgeMs = 60 * 60_000): Session[] {
	const out: Session[] = [];
	for (const [id, m] of meta) {
		if (have.has(id) || m.archived || !SESSION_ID.test(id) || now - m.at > maxAgeMs) continue;
		const s: Session = { id, agent: "claude", model: "", tokens: { used: 0, cached: 0 }, cwd: m.cwd, branch: "", title: m.title, said: "", doing: "Starting", edits: [], updatedAt: m.at, role: "Code", pinned: isPinned(id, m.pinned), feed: [], viaApp: true };
		if (m.effort) s.effort = m.effort;
		if (m.prs.length) s.prs = m.prs;
		if (m.branches.length) s.branches = m.branches;
		s.role = guessRole(s.title, []);
		out.push(s);
	}
	return out;
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
	claude.push(...waitingSessions(meta, new Set(claude.map((s) => s.id)), now));
	const codex = readCodexSessions(undefined, undefined, now);
	for (const s of codex) s.pinned = isPinned(s.id, false);
	// Grok sessions are usually run by hand and come back days later, so keep them on the board for a week.
	const grok = readGrokSessions(undefined, 7 * 86_400_000, now);
	for (const s of grok) s.pinned = isPinned(s.id, false);
	return [...claude, ...codex, ...grok].sort((a, b) => b.updatedAt - a.updatedAt);
}
