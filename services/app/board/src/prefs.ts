// What you decided about agents, kept on this computer in ~/.run-my-agents/roles.json: the type (role) you gave a
// session, which beats the board's guess. Also the type chosen for a Codex session that was just started and has
// no id yet, matched to its session once it shows up.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AGENTS } from "../../web/src/avatars";
import { KITCHEN_ROLES } from "./kitchen/agents";
import type { Session } from "./sessions";

export const ROLES: string[] = [...AGENTS.map((a) => a.role), ...KITCHEN_ROLES];

/** Read on every call, so a different RUN_MY_AGENTS_DIR (tests, a second profile) just works. */
const dir = () => process.env.RUN_MY_AGENTS_DIR || join(homedir(), ".run-my-agents");
export const dataDir = dir;
const file = () => join(dir(), "roles.json");
const pinFile = () => join(dir(), "pins.json");

export function readRoles(): Record<string, string> {
	try {
		const raw = JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown>;
		return Object.fromEntries(Object.entries(raw).filter(([, v]) => ROLES.includes(String(v)))) as Record<string, string>;
	} catch {
		return {};
	}
}

/** Gives a session a type, or with null goes back to the board's guess. */
export function setRole(id: string, role: string | null): void {
	const roles = readRoles();
	if (role && ROLES.includes(role)) roles[id] = role;
	else delete roles[id];
	mkdirSync(dirname(file()), { recursive: true });
	const tmp = `${file()}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(roles, null, 2));
	renameSync(tmp, file());
}

const nameFile = () => join(dir(), "names.json");

/** The names you've typed for sessions in the board, keyed by session id. */
export function readNames(): Record<string, string> {
	try {
		const raw = JSON.parse(readFileSync(nameFile(), "utf8")) as Record<string, unknown>;
		return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "string" && v.trim())) as Record<string, string>;
	} catch {
		return {};
	}
}

/** Gives a session a name you typed, or with null goes back to its own title (the Claude app's, or the first line of the prompt). */
export function setName(id: string, name: string | null): void {
	const names = readNames();
	const clean = (name ?? "").trim().slice(0, 120);
	if (clean) names[id] = clean;
	else delete names[id];
	mkdirSync(dirname(nameFile()), { recursive: true });
	const tmp = `${nameFile()}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(names, null, 2));
	renameSync(tmp, nameFile());
}

/** Applies the names you've chosen in the board, over whatever title the session itself has. */
export function applyNames(sessions: Session[]): Session[] {
	const names = readNames();
	for (const s of sessions)
		if (names[s.id]) {
			s.title = names[s.id];
			s.titleSet = true;
		}
	return sessions;
}

interface Pending {
	agent: string;
	cwd: string;
	/** The first line of the prompt, which is how the new session's title starts. */
	prefix: string;
	role: string;
	at: number;
}
const pending: Pending[] = [];

export function addPending(p: Omit<Pending, "at">): void {
	pending.push({ ...p, at: Date.now() });
}

/** Applies your types to the sessions, and hands a just-started session the type chosen for it. */
export function applyRoles(sessions: Session[]): Session[] {
	const now = Date.now();
	for (let i = pending.length - 1; i >= 0; i--) {
		const p = pending[i];
		if (now - p.at > 10 * 60_000) {
			pending.splice(i, 1);
			continue;
		}
		const fits = sessions.filter((s) => s.agent === p.agent && s.title.startsWith(p.prefix) && s.updatedAt >= p.at - 5000);
		const found = fits.find((s) => s.cwd === p.cwd) ?? (fits.length === 1 ? fits[0] : undefined);
		if (found) {
			setRole(found.id, p.role);
			pending.splice(i, 1);
		}
	}
	const roles = readRoles();
	for (const s of sessions)
		if (roles[s.id]) {
			s.role = roles[s.id];
			s.roleSet = true;
		}
	return sessions;
}

/**
 * Pins made in the board, kept apart from the Claude app's own pins (the board never writes to that app's files).
 * `pinned` adds a pin; `unpinned` hides one the Claude app has, on this board only.
 */
export function readPins(): { pinned: string[]; unpinned: string[] } {
	try {
		const raw = JSON.parse(readFileSync(pinFile(), "utf8")) as { pinned?: unknown; unpinned?: unknown };
		const ids = (v: unknown) => (Array.isArray(v) ? v.map(String).filter((x) => /^[\w-]{1,128}$/.test(x)) : []);
		return { pinned: ids(raw.pinned), unpinned: ids(raw.unpinned) };
	} catch {
		return { pinned: [], unpinned: [] };
	}
}

export function setPin(id: string, on: boolean): void {
	const p = readPins();
	const without = (list: string[]) => list.filter((x) => x !== id);
	const next = on ? { pinned: [...without(p.pinned), id], unpinned: without(p.unpinned) } : { pinned: without(p.pinned), unpinned: [...without(p.unpinned), id] };
	mkdirSync(dirname(pinFile()), { recursive: true });
	const tmp = `${pinFile()}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(next, null, 2));
	renameSync(tmp, pinFile());
}

/** Pinned in the Claude app or in the board, unless unpinned here. */
export function isPinned(id: string, inApp: boolean): boolean {
	const p = readPins();
	return (inApp || p.pinned.includes(id)) && !p.unpinned.includes(id);
}

/** The model and effort chosen in the board for an agent. Used for every message the board sends to it. */
export const TUNE_MODELS = ["haiku", "sonnet", "opus"];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** Permission modes a message from the board can run in (`claude -p --permission-mode`). */
export const MODES = ["default", "acceptEdits", "auto", "bypassPermissions"];
export interface Tune {
	model?: string;
	effort?: string;
	mode?: string;
}
const tuneFile = () => join(dir(), "tune.json");

export function readTune(): Record<string, Tune> {
	try {
		const raw = JSON.parse(readFileSync(tuneFile(), "utf8")) as Record<string, Tune>;
		const out: Record<string, Tune> = {};
		for (const [id, t] of Object.entries(raw)) {
			const clean: Tune = {};
			if (t?.model && TUNE_MODELS.includes(t.model)) clean.model = t.model;
			if (t?.effort && EFFORTS.includes(t.effort)) clean.effort = t.effort;
			if (t?.mode && MODES.includes(t.mode)) clean.mode = t.mode;
			if (clean.model || clean.effort || clean.mode) out[id] = clean;
		}
		return out;
	} catch {
		return {};
	}
}

/** Sets or, with an empty string, clears one or both settings. Anything not allowed is ignored. */
export function setTune(id: string, patch: Tune): Tune {
	const all = readTune();
	const next: Tune = { ...all[id] };
	if (patch.model !== undefined) {
		if (patch.model && TUNE_MODELS.includes(patch.model)) next.model = patch.model;
		else delete next.model;
	}
	if (patch.effort !== undefined) {
		if (patch.effort && EFFORTS.includes(patch.effort)) next.effort = patch.effort;
		else delete next.effort;
	}
	if (patch.mode !== undefined) {
		if (patch.mode && MODES.includes(patch.mode)) next.mode = patch.mode;
		else delete next.mode;
	}
	if (next.model || next.effort || next.mode) all[id] = next;
	else delete all[id];
	mkdirSync(dirname(tuneFile()), { recursive: true });
	const tmp = `${tuneFile()}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(all, null, 2));
	renameSync(tmp, tuneFile());
	return next;
}

export function applyTune(sessions: Session[]): Session[] {
	const tune = readTune();
	for (const s of sessions) if (tune[s.id]) s.tune = tune[s.id];
	return sessions;
}

const hiddenFile = () => join(dir(), "hidden.json");

/** Sessions closed on the board: still there, listed under Closed until you reopen them. */
export function readHidden(): string[] {
	try {
		const raw = JSON.parse(readFileSync(hiddenFile(), "utf8"));
		return Array.isArray(raw) ? raw.map(String).filter((x) => /^[\w-]{1,128}$/.test(x)) : [];
	} catch {
		return [];
	}
}

export function setHidden(id: string, on: boolean): void {
	const rest = readHidden().filter((x) => x !== id);
	mkdirSync(dirname(hiddenFile()), { recursive: true });
	const tmp = `${hiddenFile()}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(on ? [...rest, id] : rest));
	renameSync(tmp, hiddenFile());
}

export function applyHidden(sessions: Session[]): Session[] {
	const hidden = new Set(readHidden());
	for (const s of sessions) if (hidden.has(s.id)) s.hidden = true;
	return sessions;
}

/** Drops everything the board keeps about a session: its type, name, model, pins, closed state and attached files. */
export function forgetSession(id: string): void {
	setRole(id, null);
	setName(id, null);
	setTune(id, { model: "", effort: "" });
	const p = readPins();
	mkdirSync(dirname(pinFile()), { recursive: true });
	writeFileSync(pinFile(), JSON.stringify({ pinned: p.pinned.filter((x) => x !== id), unpinned: p.unpinned.filter((x) => x !== id) }, null, 2));
	setHidden(id, false);
	rmSync(join(dir(), "uploads", id), { recursive: true, force: true });
}

const orderFile = () => join(dir(), "order.json");

/** The order you dragged your agents into, as a list of session ids. */
export function readOrder(): string[] {
	try {
		const raw = JSON.parse(readFileSync(orderFile(), "utf8"));
		return Array.isArray(raw) ? raw.map(String).filter((x) => /^[\w-]{1,128}$/.test(x)).slice(0, 500) : [];
	} catch {
		return [];
	}
}

export function setOrder(ids: string[]): void {
	const clean = [...new Set(ids.map(String).filter((x) => /^[\w-]{1,128}$/.test(x)))].slice(0, 500);
	mkdirSync(dirname(orderFile()), { recursive: true });
	const tmp = `${orderFile()}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(clean));
	renameSync(tmp, orderFile());
}
