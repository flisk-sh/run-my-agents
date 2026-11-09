import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEAKED, leakedInto, orderWorktree, repoDirty, STAGE_BRIEF } from "../src/kitchen/routes";

const repo = () => {
	const dir = mkdtempSync(join(tmpdir(), "rma-leak-"));
	const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
	g("init", "-q");
	writeFileSync(join(dir, "a.ts"), "1\n");
	g("add", ".");
	g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
	return dir;
};

// #163: orders #24, #29 and #30 had worktrees, yet Build edited the shared checkout by its absolute path.
describe("build edits that leak into the base repo", () => {
	it("are the base repo's changes made after the snapshot, not the ones before it", async () => {
		const dir = repo();
		writeFileSync(join(dir, "mine.txt"), "user's own edit\n");
		const before = repoDirty(dir);
		expect(before).toEqual(["?? mine.txt"]);
		const wt = await orderWorktree(dir, 7);
		expect(wt).toBeDefined();
		writeFileSync(join(wt as string, "a.ts"), "worktree edit\n");
		expect(leakedInto(dir, before)).toEqual([]);
		writeFileSync(join(dir, "a.ts"), "leaked\n");
		expect(leakedInto(dir, before)).toEqual(["M a.ts"]);
	});

	it("are nothing without a snapshot or a repo", () => {
		expect(leakedInto("/nope", undefined)).toEqual([]);
		expect(repoDirty("relative")).toBeUndefined();
	});

	it("are named to the agent with where to move them", () => {
		const text = LEAKED("/r", "/r/.kitchen/order-1", ["M a.ts"]);
		expect(text).toContain("- M a.ts");
		expect(text).toContain("/r/.kitchen/order-1");
		expect(text).toContain("FAIL");
	});

	it("are headed off by briefs that name files relative to the repo", () => {
		expect(STAGE_BRIEF.spec).toContain("relative to the repo root");
		expect(STAGE_BRIEF.build).toContain("never use the absolute path");
	});
});
