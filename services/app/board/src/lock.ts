// One autopilot per data folder. Any board start used to turn the autopilot on, so a Build agent that checked its own
// change with `PORT=4200 bun start` in an order worktree started a second autopilot on the real orders: duplicate
// agents and duplicate merges. The first board takes a pid lock in the data folder; a later one runs read-only.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./prefs";

/** Data folders this process holds the lock of. A second board in the same process is a second board too. */
const held = new Set<string>();

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
};

/** True when this board now holds the data folder's autopilot lock; false when another running board holds it. */
export function claimAutopilot(dir: string = dataDir()): boolean {
	const file = join(dir, "board.lock");
	try {
		const pid = Number(readFileSync(file, "utf8").trim());
		// A dead pid is a stale lock (crash, kill -9): take it over. Our own pid counts only if another board here holds it.
		if (Number.isInteger(pid) && pid > 0 && alive(pid) && (pid !== process.pid || held.has(dir))) return false;
	} catch {}
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(file, String(process.pid));
	} catch {
		return false;
	}
	held.add(dir);
	return true;
}

/** Gives the lock back (tests, and at exit). Only removes a file that still names this process. */
export function releaseAutopilot(dir: string = dataDir()): void {
	if (!held.delete(dir)) return;
	try {
		const file = join(dir, "board.lock");
		if (Number(readFileSync(file, "utf8").trim()) === process.pid) rmSync(file, { force: true });
	} catch {}
}

process.on("exit", () => {
	for (const dir of [...held]) releaseAutopilot(dir);
});
