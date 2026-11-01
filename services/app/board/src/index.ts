// The agents board: every Claude Code and Codex session on this computer as an agent with a face, its channel,
// its tokens against the limit, and skills for its job. Local only; started by `flisk up` or the Mac app.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { lowerModel, readLimits, setProjectModel, writeLimits } from "../../../../hooks/limits.mjs";
import { AGENTS } from "../../web/src/avatars";
import { PAGE } from "./page";
import { addPending, applyRoles, ROLES, setRole } from "./prefs";
import { findClashes, guessRole, readAllSessions, type Session } from "./sessions";
import SKILLS from "./skills.json";

/** The avatar for a session: always its role's own face and color (Code is blue, Design purple, ...). */
export function faceOf(s: Session) {
	const a = AGENTS.find((x) => x.role === s.role) ?? (AGENTS.find((x) => x.role === "Code") as (typeof AGENTS)[number]);
	return { shape: a.shape, eyes: a.eyes, color: a.color };
}

/** Which roadmap skill categories fit each agent's job. */
const ROLE_CATS: Record<string, string[]> = {
	Code: ["code", "debug", "test"],
	Design: ["frontend"],
	Planner: ["plan", "review"],
	Chores: ["git", "ops"],
	SEO: ["docs", "frontend"],
	Social: ["docs"],
	Video: ["frontend", "docs"],
	Calls: ["docs", "plan"],
	Calendar: ["plan"],
};

/** Up to `n` skills for a role, Flisk's own first. */
export function skillsFor(role: string, n = 8) {
	const cats = ROLE_CATS[role] ?? ROLE_CATS.Code;
	return SKILLS.filter((s) => cats.includes(s.cat))
		.sort((a, b) => Number(b.source.startsWith("flisk-sh/")) - Number(a.source.startsWith("flisk-sh/")))
		.slice(0, n);
}

/**
 * Writes come only from this page: a JSON body (which a cross-site form cannot send without a preflight this
 * server never answers) and, when the browser sends one, a localhost Origin.
 */
function sameOrigin(c: { req: { header: (n: string) => string | undefined } }): boolean {
	if (!(c.req.header("content-type") ?? "").startsWith("application/json")) return false;
	const origin = c.req.header("origin");
	return !origin || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

/** Sessions with a message on its way, so a second send waits for the first reply. */
const sending = new Set<string>();
const PROMPT_LIMIT = 20_000;

/**
 * Sends one message into an existing session, headless, the way FliskOS drives agents: Claude Code with
 * `claude -p --resume`, Codex with `codex exec resume`. The prompt goes on stdin, never into argv. The reply lands
 * in the session's own transcript, which the board already reads.
 */
export function sendToSession(s: Session, text: string, run = spawn): Promise<void> {
	const [cmd, args] =
		s.agent === "codex"
			? ["codex", ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "resume", s.id]]
			: ["claude", ["-p", "--resume", s.id, "--permission-mode", "acceptEdits"]];
	return new Promise((resolve, reject) => {
		const child = run(cmd, args as string[], { cwd: s.cwd || undefined, stdio: ["pipe", "ignore", "ignore"] });
		child.on("error", reject);
		child.on("close", () => resolve());
		child.stdin?.end(text);
	});
}

/** The board answers only to its own local names, so a DNS-rebound site cannot read transcripts or send prompts. */
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;


/** Which of the two coding agents the board can start are installed. */
export const installed = () => ({ claude: !!Bun.which("claude"), codex: !!Bun.which("codex") });

export interface NewSession {
	agent: "claude" | "codex";
	cwd: string;
	text: string;
	model?: string;
	/** Claude lets the caller choose the session id, so the board knows it at once. */
	id?: string;
}
const MODELS = ["opus", "sonnet", "haiku"];

/** Starts a new headless session in a folder; the prompt goes on stdin. Its transcript is read like any other. */
export function startNewSession(n: NewSession, run = spawn): Promise<void> {
	const [cmd, args] =
		n.agent === "codex"
			? ["codex", ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write"]]
			: ["claude", ["-p", "--session-id", n.id as string, "--permission-mode", "acceptEdits", ...(n.model ? ["--model", n.model] : [])]];
	return new Promise((resolveStart, reject) => {
		const child = run(cmd, args as string[], { cwd: n.cwd, stdio: ["pipe", "ignore", "ignore"] });
		child.on("error", reject);
		child.on("close", () => resolveStart());
		child.stdin?.end(n.text);
	});
}

export function createApp(
	read = () => applyRoles(readAllSessions()),
	send = sendToSession,
	deps: { start?: typeof startNewSession; which?: typeof installed } = {},
) {
	const start = deps.start ?? startNewSession;
	const which = deps.which ?? installed;
	const app = new Hono();
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
			sessions: sessions.map((s) => ({
				...s,
				face: faceOf(s),
				lower: s.agent === "claude" ? lowerModel(s.model) : null,
				skills: skillsFor(s.role),
				sending: sending.has(s.id),
			})),
			clashes: findClashes(sessions),
			limits,
		});
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
		const lower = s ? lowerModel(s.model) : null;
		if (!s || !s.cwd || !lower) return c.json({ error: "No cheaper model for this session." }, 400);
		return c.json({ model: lower, file: setProjectModel(s.cwd, lower) });
	});
	app.post("/api/send", async (c) => {
		if (!sameOrigin(c)) return c.json({ error: "Send JSON from the board." }, 403);
		const { id, text } = (await c.req.json().catch(() => ({}))) as { id?: string; text?: string };
		const message = String(text ?? "").trim();
		if (!message) return c.json({ error: "Type a message first." }, 400);
		if (message.length > PROMPT_LIMIT) return c.json({ error: "That message is too long." }, 400);
		const s = read().find((x) => x.id === id);
		if (!s) return c.json({ error: "That session is gone." }, 404);
		if (sending.has(s.id)) return c.json({ error: `${s.role} is still answering your last message.` }, 409);
		sending.add(s.id);
		send(s, message)
			.catch((e) => console.error(`send to ${s.id} failed:`, e))
			.finally(() => sending.delete(s.id));
		return c.json({ sent: true }, 202);
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
		return c.json({ role: guessRole(text, []), agent: /\b(codex|gpt|openai)\b/i.test(text) && which().codex ? "codex" : null });
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
	app.post("/api/new", async (c) => {
		if (!sameOrigin(c)) return c.json({ error: "Send JSON from the board." }, 403);
		const b = (await c.req.json().catch(() => ({}))) as { agent?: string; cwd?: string; text?: string; role?: string; model?: string };
		const text = String(b.text ?? "").trim();
		if (!text) return c.json({ error: "Describe the task first." }, 400);
		if (text.length > PROMPT_LIMIT) return c.json({ error: "That message is too long." }, 400);
		if (b.agent !== "claude" && b.agent !== "codex") return c.json({ error: "Pick Claude Code or Codex." }, 400);
		if (!which()[b.agent]) return c.json({ error: `${b.agent === "codex" ? "Codex" : "Claude Code"} is not installed on this computer.` }, 400);
		if (b.role && !ROLES.includes(b.role)) return c.json({ error: "Unknown agent type." }, 400);
		const cwd = resolve(String(b.cwd ?? ""));
		try {
			if (!b.cwd || !statSync(cwd).isDirectory()) throw new Error("not a folder");
		} catch {
			return c.json({ error: "That folder does not exist." }, 400);
		}
		const model = b.agent === "claude" && b.model && MODELS.includes(b.model) ? b.model : undefined;
		const id = b.agent === "claude" ? randomUUID() : undefined;
		if (b.role) {
			if (id) setRole(id, b.role);
			else addPending({ agent: b.agent, cwd, prefix: (text.split("\n")[0] ?? "").slice(0, 40), role: b.role });
		}
		start({ agent: b.agent, cwd, text, model, id }).catch((e) => console.error("start failed:", e));
		return c.json({ started: true, id }, 202);
	});
	app.get("/", (c) => c.html(PAGE));
	return app;
}

if (import.meta.main) {
	const port = Number(process.env.PORT || 4100);
	Bun.serve({ port, hostname: "127.0.0.1", fetch: createApp().fetch });
	console.log(`Run My Agents board on http://localhost:${port}`);
}
