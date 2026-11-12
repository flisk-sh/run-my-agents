import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/index";
import { claimAutopilot, releaseAutopilot } from "../src/lock";

const dirs: string[] = [];
const fresh = () => {
	const d = mkdtempSync(join(tmpdir(), "rma-lock-"));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) releaseAutopilot(d);
});

describe("one autopilot per data folder (#409)", () => {
	it("only the first board on a data folder ticks the kitchen", () => {
		const prev = process.env.RUN_MY_AGENTS_DIR;
		const dir = fresh();
		process.env.RUN_MY_AGENTS_DIR = dir;
		const real = globalThis.setInterval;
		const every = 7_777;
		let ticking = 0;
		globalThis.setInterval = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
			if (ms === every) ticking++;
			return real(fn, ms === every ? 3_600_000 : ms, ...rest);
		}) as typeof setInterval;
		try {
			createApp(() => [], async () => {}, { kitchenEvery: every });
			createApp(() => [], async () => {}, { kitchenEvery: every });
			expect(ticking).toBe(1);
			expect(readFileSync(join(dir, "board.lock"), "utf8")).toBe(String(process.pid));
			// Once the first lets go, the next board may take over.
			releaseAutopilot(dir);
			createApp(() => [], async () => {}, { kitchenEvery: every });
			expect(ticking).toBe(2);
		} finally {
			globalThis.setInterval = real;
			if (prev === undefined) delete process.env.RUN_MY_AGENTS_DIR;
			else process.env.RUN_MY_AGENTS_DIR = prev;
		}
	});
	it("a board with no kitchen tick never takes the lock, and a different data folder is independent", () => {
		const a = fresh();
		const b = fresh();
		expect(claimAutopilot(a)).toBe(true);
		expect(claimAutopilot(b)).toBe(true);
		expect(claimAutopilot(a)).toBe(false);
	});
	it("takes over a lock whose process is gone, and refuses one held by a live process", () => {
		const dir = fresh();
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "board.lock"), "2147483000");
		expect(claimAutopilot(dir)).toBe(true);
		releaseAutopilot(dir);
		writeFileSync(join(dir, "board.lock"), String(process.ppid));
		expect(claimAutopilot(dir)).toBe(false);
	});
});
