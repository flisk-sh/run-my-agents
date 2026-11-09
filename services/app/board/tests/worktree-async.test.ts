import { describe, expect, it, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";

const createTestRepo = () => {
	const dir = mkdtempSync(join(tmpdir(), "rma-worktree-async-"));
	const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
	git("init", "-q", "-b", "main");
	writeFileSync(join(dir, "a.txt"), "test\n");
	git("add", ".");
	git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
	git("remote", "add", "origin", "https://github.com/acme/demo.git");
	return dir;
};

const createSlowGitStub = () => {
	const stubDir = mkdtempSync(join(tmpdir(), "rma-git-stub-"));
	const gitPath = Bun.which("git");
	if (!gitPath) throw new Error("git not found");

	const stubScript = `#!/bin/sh
echo "$*" >> "${stubDir}/log.txt"
case " $* " in
  *" fetch "*|*" worktree add "*) sleep 2 ;;
esac
exec "${gitPath}" "$@"
`;
	const stubFile = join(stubDir, "git");
	writeFileSync(stubFile, stubScript);
	chmodSync(stubFile, 0o755);
	return stubDir;
};

describe("#126: async orderWorktree", () => {
	let originalPath = process.env.PATH;

	afterEach(() => {
		process.env.PATH = originalPath;
	});

	it("the board answers while a 2 s git makes the worktree", async () => {
		const repo = createTestRepo();
		const stubDir = createSlowGitStub();
		process.env.PATH = `${stubDir}:${process.env.PATH}`;

		const { orderWorktree } = await import("../src/kitchen/routes");
		const { createApp } = await import("../src/index");

		const start = Date.now();
		const p = orderWorktree(repo, 20); // Don't await yet

		// Make a request to /api/tasks while orderWorktree is running
		const app = createApp(undefined, undefined, {});
		const response = await app.request("/api/tasks");
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(200);
		const wt = await p;
		expect(wt).toBe(join(realpathSync(repo), ".kitchen", "order-20"));

		process.env.PATH = originalPath;
	});

	it("two concurrent calls for one order run git worktree add once", async () => {
		const repo = createTestRepo();
		const stubDir = createSlowGitStub();
		process.env.PATH = `${stubDir}:${process.env.PATH}`;

		const { orderWorktree } = await import("../src/kitchen/routes");

		const [a, b] = await Promise.all([
			orderWorktree(repo, 21),
			orderWorktree(repo, 21)
		]);

		expect(a).toBe(b);

		// Check the stub log
		const log = Bun.file(join(stubDir, "log.txt"));
		const logContent = await log.text();
		const addCount = (logContent.match(/worktree add/g) || []).length;
		expect(addCount).toBe(1);

		process.env.PATH = originalPath;
	});

	it("a failing git still records its message in worktreeErrors", async () => {
		const repo = createTestRepo();
		const stubDir = createSlowGitStub();

		// Create a failing git stub
		const gitPath = Bun.which("git");
		if (!gitPath) throw new Error("git not found");

		const failStubScript = `#!/bin/sh
echo "$*" >> "${stubDir}/log2.txt"
case " $* " in
  *" worktree add "*) echo "fatal: stub refuses" >&2; exit 1 ;;
esac
exec "${gitPath}" "$@"
`;
		const failStubFile = join(stubDir, "git-fail");
		writeFileSync(failStubFile, failStubScript);
		chmodSync(failStubFile, 0o755);

		// Use the fail stub for this test
		const origPath = process.env.PATH;
		process.env.PATH = `${stubDir}:${origPath}`;

		// Monkey-patch git stub to fail on worktree add
		const testStubDir = mkdtempSync(join(tmpdir(), "rma-git-fail-"));
		const failingStubScript = `#!/bin/sh
echo "$*" >> "${testStubDir}/log.txt"
case " $* " in
  *" worktree add "*) echo "fatal: stub refuses" >&2; exit 1 ;;
  *) exec "${gitPath}" "$@" ;;
esac
`;
		const failingStub = join(testStubDir, "git");
		writeFileSync(failingStub, failingStubScript);
		chmodSync(failingStub, 0o755);

		process.env.PATH = `${testStubDir}:${origPath}`;

		const { orderWorktree, worktreeError } = await import("../src/kitchen/routes");

		const wt = await orderWorktree(repo, 22);
		expect(wt).toBeUndefined();
		expect(worktreeError(repo)).toContain("fatal: stub refuses");

		process.env.PATH = origPath;
	});
});
