// What the Claude desktop app knows about a Claude Code session that its transcript does not: the name you see in
// its sidebar, whether you pinned it, and whether you archived it. Read-only, from the app's own files:
//
//   <app dir>/claude_desktop_config.json                     preferences.epitaxyPrefs["starred-local-code-sessions"]
//   <app dir>/claude-code-sessions/<a>/<b>/local_<id>.json   { sessionId, cliSessionId, title, isArchived }
//
// The transcript in ~/.claude/projects is named after cliSessionId, so that is the key.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/** A pull request the Claude app attached to a session. */
export interface Pr {
	number: number;
	title: string;
	state: string;
	url: string;
	repo: string;
	branch: string;
	draft: boolean;
	/** CI on GitHub: every check passed, one failed, or some still running. Empty when unknown. */
	checks?: "pass" | "fail" | "pending" | "";
	/** GitHub's review state, like APPROVED or CHANGES_REQUESTED. */
	review?: string;
	/** GitHub's merge state, like CLEAN, BLOCKED, BEHIND or DIRTY (conflicts). */
	merge?: string;
}

export interface DesktopMeta {
	title: string;
	pinned: boolean;
	archived: boolean;
	effort: string;
	/** When the session last did anything, from the app. */
	at: number;
	prs: Pr[];
	/** Branches the session wrote to. */
	branches: string[];
	/** The folder the session works in. */
	cwd: string;
}

function defaultRoot(): string {
	if (process.env.CLAUDE_DESKTOP_DIR) return process.env.CLAUDE_DESKTOP_DIR;
	const home = homedir();
	if (platform() === "darwin") return join(home, "Library", "Application Support", "Claude");
	if (platform() === "win32") return join(process.env.APPDATA ?? home, "Claude");
	return join(home, ".config", "Claude");
}

/** One small record per session file, kept until the file changes, because there are hundreds and the board polls. */
const cache = new Map<string, { mtime: number; rec: { cli: string; local: string; title: string; archived: boolean; effort: string; at: number; prs: Pr[]; branches: string[]; cwd: string } | null }>();

function readPrs(raw: unknown): Pr[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((p: { prNumber?: unknown; url?: unknown; state?: unknown; repo?: unknown; branch?: unknown }) => {
		const number = Number(p?.prNumber);
		const url = String(p?.url ?? "");
		if (!Number.isInteger(number) || number < 1 || !/^https:\/\/[^\s"<>]+$/.test(url)) return [];
		return [{ number, title: "", state: String(p?.state ?? "").toUpperCase(), url, repo: String(p?.repo ?? ""), branch: String(p?.branch ?? ""), draft: false }];
	});
}

/** The app lists branches as "<folder>\u0000<branch>". */
function readBranches(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return [...new Set(raw.map((x) => String(x).split("\u0000")[1] ?? "").filter(Boolean))];
}

function list(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/** Name, pinned and archived for each session the desktop app knows, keyed by the CLI session id. */
export function readDesktopMeta(root = defaultRoot()): Map<string, DesktopMeta> {
	const out = new Map<string, DesktopMeta>();
	let starred = new Set<string>();
	try {
		const cfg = JSON.parse(readFileSync(join(root, "claude_desktop_config.json"), "utf8"));
		const ids = cfg?.preferences?.epitaxyPrefs?.["starred-local-code-sessions"];
		if (Array.isArray(ids)) starred = new Set(ids.map(String));
	} catch {}

	const base = join(root, "claude-code-sessions");
	for (const a of list(base))
		for (const b of list(join(base, a)))
			for (const f of list(join(base, a, b))) {
				if (!/^local_.*\.json$/.test(f)) continue;
				const path = join(base, a, b, f);
				let mtime = 0;
				try {
					mtime = statSync(path).mtimeMs;
				} catch {
					continue;
				}
				let hit = cache.get(path);
				if (!hit || hit.mtime !== mtime) {
					let rec = null;
					try {
						const j = JSON.parse(readFileSync(path, "utf8"));
						if (typeof j.cliSessionId === "string")
							rec = { cli: j.cliSessionId, local: String(j.sessionId ?? ""), title: String(j.title ?? ""), archived: j.isArchived === true, effort: typeof j.effort === "string" ? j.effort : "", at: Number(j.lastActivityAt) || 0, prs: readPrs(j.prs), branches: readBranches(j.writtenBranches), cwd: typeof j.cwd === "string" ? j.cwd : "" };
					} catch {}
					hit = { mtime, rec };
					cache.set(path, hit);
				}
				if (hit.rec) out.set(hit.rec.cli, { title: hit.rec.title, pinned: starred.has(hit.rec.local), archived: hit.rec.archived, effort: hit.rec.effort, at: hit.rec.at, prs: hit.rec.prs, branches: hit.rec.branches, cwd: hit.rec.cwd });
			}
	return out;
}
