import { describe, it, expect } from "bun:test";
import { rowLabel, rowResult, diffStat } from "../src/sessions";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

describe("rowLabel", () => {
	it("Bash command becomes 'Ran ...'", () => {
		const label = rowLabel("Bash", { command: "bun test wip.test.ts" });
		expect(label).toMatch(/^Ran bun test/);
	});

	it("Grep becomes 'Searched ...'", () => {
		const label = rowLabel("Grep", { pattern: "dispatch", path: "routes.ts" });
		expect(label).toBe("Searched routes.ts for dispatch");
	});

	it("Read becomes 'Read ...'", () => {
		const label = rowLabel("Read", { file_path: "/a/routes.ts" });
		expect(label).toBe("Read routes.ts");
	});

	it("Edit becomes 'Edited ...'", () => {
		const label = rowLabel("Edit", { file_path: "/a/routes.ts" });
		expect(label).toBe("Edited routes.ts");
	});
});

describe("rowResult", () => {
	it("test output becomes pass/fail count", () => {
		const result = rowResult("11 pass 4 fail");
		expect(result).toBe("11 pass, 4 fail");
	});

	it("error with bad flag becomes 'failed: ...'", () => {
		const result = rowResult("EACCES: permission denied", true);
		expect(result).toMatch(/^failed:/);
	});

	it("found matches count", () => {
		const result = rowResult("Found 3 matches");
		expect(result).toMatch(/3 matches/);
	});
});

describe("diffStat", () => {
	it("returns add and del from git diff", () => {
		const tmpDir = join(tmpdir(), `test-diff-${Date.now()}`);
		try {
			mkdirSync(tmpDir, { recursive: true });
			execSync("git init", { cwd: tmpDir });
			execSync("git config user.email 'test@example.com'", { cwd: tmpDir });
			execSync("git config user.name 'Test'", { cwd: tmpDir });

			writeFileSync(join(tmpDir, "file.txt"), "initial");
			execSync("git add file.txt", { cwd: tmpDir });
			execSync("git commit -m 'initial'", { cwd: tmpDir });

			writeFileSync(join(tmpDir, "file.txt"), "initial\nmore lines\nand more");
			const stat = diffStat(tmpDir);
			expect(stat).toBeTruthy();
			expect(stat?.add).toBeGreaterThan(0);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("returns undefined on git error", () => {
		const stat = diffStat("/nonexistent");
		expect(stat).toBeUndefined();
	});
});
