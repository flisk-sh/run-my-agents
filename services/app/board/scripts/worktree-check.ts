// Runs the board's own orderWorktree() on a throwaway repo and prints the result. CI compiles this the way the Mac
// release compiles the board and runs it with a bare PATH, because on the Mac app's built-in board every order got
// no worktree (#92-#94) while the board run from source made them fine.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orderWorktree, worktreeError } from "../src/kitchen/routes";

const repo = mkdtempSync(join(tmpdir(), "rma-wt-check-"));
const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
git("init", "-q", "-b", "main");
writeFileSync(join(repo, "README.md"), "# check\n");
git("add", ".");
git("-c", "user.email=ci@example.com", "-c", "user.name=ci", "commit", "-qm", "init");
const wt = orderWorktree(repo, 1);
console.log(JSON.stringify({ repo, worktree: wt ?? null, error: worktreeError(repo) ?? null, path: process.env.PATH }));
process.exit(wt ? 0 : 1);
