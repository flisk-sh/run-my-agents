import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTask, readTasks, updateTask } from "../src/kitchen/pipeline";
import { dropLostWorktrees } from "../src/kitchen/routes";

describe("dropLostWorktrees", () => {
	beforeEach(() => {
		process.env.RUN_MY_AGENTS_DIR = mkdtempSync(join(tmpdir(), "rma-wt-gone-"));
	});

	it("clears the worktree and marks the order lost", () => {
		const t = addTask({ title: "test", cwd: "/test", priority: "P2" });
		updateTask(t.id, { worktree: "/nonexistent/.kitchen/order-137", stage: "build" });

		dropLostWorktrees();

		const tasks = readTasks();
		const updated = tasks.find((x) => x.id === t.id);
		expect(updated?.worktree).toBeUndefined();
		expect(updated?.stuck).toBe(true);
		expect(updated?.assignee).toBe("");
		expect(updated?.failures?.at(-1)).toContain("worktree gone");
	});

	it("logs it only once", () => {
		const t = addTask({ title: "test", cwd: "/test", priority: "P2" });
		updateTask(t.id, { worktree: "/nonexistent/.kitchen/order-137", stage: "build" });

		const first = dropLostWorktrees();
		expect(first).toHaveLength(1);
		expect(first[0]).toContain("order-137");

		// Re-set the worktree to the same missing path
		updateTask(t.id, { worktree: "/nonexistent/.kitchen/order-137" });
		const second = dropLostWorktrees();
		expect(second).toHaveLength(0);
	});

	it("leaves a worktree that exists alone", () => {
		const realDir = mkdtempSync(join(tmpdir(), "rma-wt-exists-"));
		try {
			const t = addTask({ title: "test", cwd: "/test", priority: "P2" });
			updateTask(t.id, { worktree: realDir, stage: "build" });

			dropLostWorktrees();

			const tasks = readTasks();
			const updated = tasks.find((x) => x.id === t.id);
			expect(updated?.worktree).toBe(realDir);
		} finally {
			rmSync(realDir, { recursive: true, force: true });
		}
	});
});
